const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { SERVER_URL } = require('./server-url.js');
const { readServerUrlFromFile } = require('./lib/config-file.js');
const { resolveServerUrl } = require('./lib/resolve-server-url.js');
const { probeServer } = require('./lib/probe-server.js');
const { readStudentMode, writeStudentMode } = require('./lib/shell-state.js');

/**
 * K12 智学 PC App —— Electron 壳（spec `2026-09-23-pc-app-study-lockdown-design.md` §6.1）。
 *
 * 本壳**不做任何业务**：它加载与 Web App **完全相同**的 UI，只负责三件事：
 *   1. 学生登录时进真全屏 kiosk（由渲染层经 preload 驱动，本文件不判断角色）；
 *   2. 锁定期间关不掉窗口（拦 close / before-quit / minimize）；
 *   3. 封堵应用内逃逸（外链、跨源导航）。
 *
 * **能力边界（有意写在这里，别当成缺陷去“修”）**：Electron 拦不住 Alt+Tab / Cmd+Tab /
 * Ctrl+Alt+Del / 强制退出——那是系统级，任何应用都做不到。`blur` 抢回只是尽力而为。
 * 真·无法切屏要靠装机时的 OS 级单应用模式（Windows Assigned Access / macOS Single App Mode），
 * 属运维配置，不是代码（spec §8 局限 1）。
 */

/**
 * **学生模式**由渲染层上报：true = 当前登录者是学生且在壳里 → 进 kiosk。
 *
 * ⚠️ 它**不是**「锁定窗口生效」的意思（2026-09-24 修正）：kiosk 只由**角色**决定，
 * 家长设的时长只决定「能不能登出」（渲染层 `LogoutButton` 自判）。初稿把两者合成一个布尔，
 * 后果是「家长没设时长 → 学生登录后完全不被全屏、可随便切到其它应用」。
 * `false` = 家长/管理员在用，或学生已登出 → 窗口应像普通应用一样可用。
 */
let studentMode = false;
let win = null;

/**
 * 壳加载的 Web 地址（spec §4.1）。**三层优先级**：
 *   `K12_WEB_URL` 环境变量（dev/临时） > `userData/config.json` 的 `serverUrl`
 *   （运维最后手段） > `server-url.js` 的构建时默认值。
 *
 * 这里是 Web 层（vite preview，默认 :5173）的地址，不是 API（Nest，默认 :3001）的
 * —— 学生只认识 Web 层。
 *
 * **必须是 `let` 且延迟到 `app.whenReady()` 之后再赋值**：解析要用 `app.getPath('userData')`。
 */
let WEB_URL = null;

/** 重试定时器（null = 未在重试）。 */
let retryTimer = null;
/** 探测进行中标记：3 秒超时与 5 秒间隔会叠加，必须防并发探测。 */
let probing = false;

/** 重试间隔与探测超时（spec §4.2）。 */
const RETRY_INTERVAL_MS = 5000;
const PROBE_TIMEOUT_MS = 3000;

/**
 * 探测式重连：**只有探测通了才导航**（spec §4.2 的修正）。
 *
 * ⚠️ **不要改成「每 5 秒无脑 `loadURL`」**：主 frame 导航失败时 Chromium 会用
 * **它自己的错误页替换掉我们的本地页**，那样本地页只出现一次、之后永久变成
 * 「无法访问此网站」；而「已在本地页就不再 loadFile」的防闪烁写法会让它再也回不来。
 */
async function tryReconnect() {
  if (!win || win.isDestroyed() || probing) return;
  probing = true;
  try {
    if (await probeServer(WEB_URL, PROBE_TIMEOUT_MS)) {
      // 通了就停表，把控制权交回正常加载；若这次加载仍失败，
      // did-fail-load 会重新起表，不会死循环。
      stopRetry();
      if (win && !win.isDestroyed()) win.loadURL(WEB_URL);
    }
  } finally {
    probing = false;
  }
}

function startRetry() {
  if (retryTimer) return;
  retryTimer = setInterval(() => {
    void tryReconnect();
  }, RETRY_INTERVAL_MS);
}

function stopRetry() {
  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
}

/**
 * 显示本地页。当前地址经 `loadFile` 的 query 传入，本地页从 `location.search` 读
 * —— 不为此新增 IPC 通道（spec §4.2）。
 */
function showOfflinePage() {
  if (!win || win.isDestroyed()) return;
  win.loadFile(path.join(__dirname, 'pages', 'offline.html'), {
    query: { url: WEB_URL },
  });
}

/** 同源判定：只放行壳自己的地址，其余一律拦。 */
function isSameOrigin(url) {
  try {
    return new URL(url).origin === new URL(WEB_URL).origin;
  } catch {
    return false;
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 「偏向多锁」：上次是学生模式就一开机就进 kiosk，不等渲染层（spec §4.3、§6-7）。
  // 在首页真正显示出来之前应用，避免「先普通窗口、再全屏」的可见闪动。
  if (studentMode) {
    win.once('ready-to-show', () => applyStudentMode(true));
  }

  win.loadURL(WEB_URL);

  // 连不上 → 本地页 + 探测式重试（spec §4.2）
  win.webContents.on('did-fail-load', (_event, errorCode, _errorDescription, _url, isMainFrame) => {
    if (!isMainFrame) return; // 子资源（图片/CSS）失败不算「连不上」
    if (errorCode === -3) return; // ERR_ABORTED：导航被取消，页面并未失败
    showOfflinePage();
    startRetry();
  });

  win.webContents.on('did-finish-load', () => {
    if (!win || win.isDestroyed()) return;
    // 主 frame 加载完成且当前不是本地页（file:）→ 说明连上了，停表
    if (!win.webContents.getURL().startsWith('file:')) stopRetry();
  });

  // 拦外链：AI 回复的 markdown 会渲染 target="_blank"（AdminChatPage / AuxChatPanel），
  // 不拦就是「大模型吐个链接 → 学生点进浏览器」。
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!isSameOrigin(url)) event.preventDefault();
  });

  // 学生模式下关不掉 / 最小化不了（kiosk 就该是这样）。家长/管理员登录时 studentMode=false，窗口完全正常。
  win.on('close', (event) => {
    if (studentMode) event.preventDefault();
  });
  win.on('minimize', (event) => {
    if (studentMode) event.preventDefault();
  });

  // 失焦抢回：**尽力而为**。刻意**不加** setAlwaysOnTop——那会盖住 UAC / 系统安全对话框，
  // 风险大于收益。macOS 上后台抢占受 OS 限制，抢不回来是已知限制（spec §8 局限 1）。
  win.on('blur', () => {
    if (studentMode && win && !win.isDestroyed()) win.focus();
  });

  win.on('closed', () => {
    // 窗口没了就把重试表停掉，别留一个每 5 秒空转（被 `!win` 挡掉）的定时器。
    // 注意：这**不是**功能修复 —— 重建窗口后自动重连本来就能工作（interval 回调读的是
    // 模块级 `win`，不是捕获的旧窗口）。新窗口加载失败时 did-fail-load 会自己重新起表。
    stopRetry();
    win = null;
  });
}

// 拦 before-quit：否则 Cmd+Q / Alt+F4 能绕过上面那个 close 拦截。
app.on('before-quit', (event) => {
  if (studentMode) event.preventDefault();
});

app.whenReady().then(() => {
  WEB_URL = resolveServerUrl(
    process.env.K12_WEB_URL,
    readServerUrlFromFile(app.getPath('userData')),
    SERVER_URL,
  );
  // 打一行日志：排障时一眼看出壳到底在连哪个地址（人工冒烟 #14/#16 靠它验证）
  console.log(`[shell] 加载地址: ${WEB_URL}`);

  // 补洞（spec §1.4 / §4.3）：kiosk 由页面里的渲染层经 IPC 驱动，而**离线时页面
  // 根本加载不出来** → 渲染层不执行 → studentMode 恒为 false → 窗口不是 kiosk
  // → 学生「关 Wi-Fi + 杀进程 + 重启」就能逃逸。所以先把上次的状态读回来，
  // 建窗口时就进 kiosk，不等渲染层。
  studentMode = readStudentMode(app.getPath('userData'));

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/**
 * 应用学生模式：落盘 + 驱动窗口的 kiosk 三件套。
 *
 * **启动路径（补洞）与 IPC 路径必须走同一段代码**（spec §4.3）—— 两处各写一套必然漂移，
 * 而漂移的后果是「某个入口忘了落盘」或「某个入口忘了全屏」，正是这次要修的洞。
 */
function applyStudentMode(on) {
  studentMode = Boolean(on);
  // 先落盘：写失败只 warn、绝不抛（写入永不阻断主链路）。落盘是为了下次启动能恢复。
  writeStudentMode(app.getPath('userData'), studentMode);

  if (!win || win.isDestroyed()) return;
  win.setKiosk(studentMode);
  win.setClosable(!studentMode);
  // setMinimizable 在 macOS 上是 no-op；Windows/Linux 上有效。不是错误，别加平台分支。
  win.setMinimizable(!studentMode);
}

// 渲染层 → 主进程：学生模式开关。`setKiosk` 是真全屏 + 锁定（比 fullscreen 更彻底）。
ipcMain.on('kiosk:set-student-mode', (_event, on) => {
  applyStudentMode(on);
});

// 本地页「立即重试」→ 走同一条探测路径（单向通道，spec §4.2）
ipcMain.on('shell:retry-now', () => {
  void tryReconnect();
});
