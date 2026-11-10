const { app, BrowserWindow, ipcMain, powerMonitor, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { SERVER_URL } = require('./server-url.js');
const { readServerUrlFromFile } = require('./lib/config-file.js');
const { resolveServerUrl } = require('./lib/resolve-server-url.js');
const { probeServer } = require('./lib/probe-server.js');
const { readStudentMode, writeStudentMode } = require('./lib/shell-state.js');
const { createKioskGuard } = require('./lib/kiosk-guard.js');
const { createKeyboardHook } = require('./lib/keyboard-hook.js');
const { markRunning, wasAbnormalExit, markCleanExit } = require('./lib/exit-audit.js');
const { installWatchdog } = require('./lib/watchdog.js');

/**
 * **全局禁用代理**（spec §4.7）。
 *
 * ⚠️ 这**不是**可有可无的优化，而是「连不上本地页」能否工作的前提。本机/学校网络常配 PAC 或系统代理，
 * 而 Chromium 会把**局域网地址也交给代理**：于是请求**挂在代理上**，而不是快速失败 ——
 * `did-fail-load` 永不触发 → 那张「连不上」本地页**永不出现**、探测式重连也不会启动。
 * （2026-09-27 在本机 PAC 环境实测：服务停掉后 30 秒内无任何失败信号，日志连
 * `Failed to load URL` 都没有；加本开关后 2 秒出现本地页。）
 *
 * 本壳只跟**自己的**服务器通信：页面、`/api`、`/assets` 全同源，④ 的更新源也计划挂在同一台服务器上
 * —— 所以直连是正确且最简单的选择。若将来真要经代理访问外网，需重新评估。
 *
 * **必须在 `app.whenReady()` 之前调用**（网络栈初始化前）。
 */
app.commandLine.appendSwitch('no-proxy-server');

/**
 * **钉死 userData 目录，与 `productName` 解耦**（spec ③ §4.2）。
 *
 * 打包后 `productName` 是中文（`K12 智学`），而 `app.getPath('userData')` 取 `app.getName()`
 * —— 也就是 `productName`（若设了）否则 `name`。不钉的话 userData 会变成
 * 「…/K12 智学/」（**中文 + 空格**），README 里那三条救火路径（`config.json` 的位置）就全失效了，
 * 而那是客户端连不上时**唯一的自救手段**（② spec §8-3）。
 *
 * 显式固定为 ASCII，且与 dev 下的路径完全一致（`package.json` 的 `name` 本来就是 `k12-desktop`）
 * —— 所以 dev 行为不变，打包后才生效。
 *
 * ⚠️ **必须在任何 `app.getPath('userData')` 读取之前调用**（本文件里那两处都在 `whenReady` 内，
 * 且用的是模块级 `app`，所以放在这里一定早于它们）。删掉这行不会有任何测试变红，
 * 但会让 README 的三条路径全部指向不存在的目录 —— 有 `user-data.guard.test.js` 钉着。
 */
app.setPath('userData', path.join(app.getPath('appData'), 'k12-desktop'));

/**
 * 单实例（spec 2026-11-10 §4.2）：看护进程的 `open -a` 与「用户双击图标」可能撞在一起。
 * 拿不到锁的进程直接退出（此时 studentMode 还是 false，不会被 before-quit 拦）。
 */
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

/**
 * K12 智学 PC App —— Electron 壳（spec `2026-09-23-pc-app-study-lockdown-design.md` §6.1）。
 *
 * 本壳**不做任何业务**：它加载与 Web App **完全相同**的 UI，只负责三件事：
 *   1. 学生登录时进真全屏 kiosk（由渲染层经 preload 驱动，本文件不判断角色）；
 *   2. 锁定期间关不掉窗口（拦 close / before-quit / minimize）；
 *   3. 封堵应用内逃逸（外链、跨源导航）。
 *
 * **能力边界（有意写在这里，别当成缺陷去“修”）**：macOS 的 Cmd+Tab 由 kiosk 真禁用
 * （打断后靠 kiosk-guard 恢复，约 1–2 秒）；Windows 的 Alt+Tab / Win / Alt+F4 / Ctrl+Shift+Esc
 * 由应用内全局键盘钩子（`lib/keyboard-hook.js` + `native/keyhook`）吞掉。
 * `Ctrl+Alt+Del` 与强杀进程**拦不住**——那是系统级，任何应用都做不到。
 * 真·隔离要靠装机配置（macOS 受监督设备 Single App Mode、Windows 企业版 Shell Launcher；
 * 家庭版没有系统级 kiosk）。
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
 * App 是否刚从「非前台」回到前台（2026-11-09）。
 *
 * **为什么需要它**：kiosk 挡 Cmd+Tab 靠的是 macOS 的 `NSApplicationPresentationOptions`，
 * 这组选项是 **app 级**的 —— App 一失活（Siri / 通知 / 切到别的应用）就被系统收回，
 * 而 `isVisible/isFocused/isKiosk/isFullScreen` 四项仍全是 true，守护自己看不出异常。
 * 所以「从后台回来」这件事本身必须触发一次**无条件重进 kiosk**，不能等状态变"不健康"。
 */
let appWasInactive = false;

/** 最近一次渲染进程崩溃的时间戳：60 秒内二次崩溃改走"重建窗口"。 */
let rendererCrashAt = 0;

/** 守护日志的大小上限：超过就清空重写，避免长期运行无限增长。 */
const KIOSK_LOG_MAX_BYTES = 256 * 1024;
let kioskLogDisabled = false;

/**
 * 写一行守护日志到 `userData/kiosk-guard.log`。
 *
 * **为什么落盘**：Siri / 通知 / Mission Control 打断时，打包后的 App 从 Finder 启动时
 * 主进程 stdout 进了黑洞（与 `load-error.log` 同一个理由，见 `did-fail-load` 那段）。
 * 现场只有这个文件能告诉我们「是哪个事件把它打掉的、恢复有没有执行」。
 *
 * 写失败**绝不抛**（沿用「写入永不阻断主链路」的纪律），且失败一次后不再重试，
 * 避免每秒钟刷一条失败日志。
 */
function appendKioskLog(message) {
  if (kioskLogDisabled) return;
  try {
    const file = path.join(app.getPath('userData'), 'kiosk-guard.log');
    try {
      if (fs.statSync(file).size > KIOSK_LOG_MAX_BYTES) fs.truncateSync(file, 0);
    } catch {
      // 文件不存在是正常路径（第一次写）。
    }
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    kioskLogDisabled = true;
  }
}

/**
 * 全屏守护（2026-11-04）：系统打断 kiosk 后自动恢复。
 *
 * ⚠️ **macOS 必须用 `app.focus({ steal: true })`**：`win.focus()` 只聚焦窗口、
 * 不激活 App，抢不回被 Siri / 其它应用拿走的激活状态。这一层不能删。
 * 详见 `lib/kiosk-guard.js` 文件头。
 */
const kioskGuard = createKioskGuard({
  isEnabled: () => studentMode,
  getWindow: () => win,
  platform: process.platform,
  focusApp: () => {
    // Cmd+H / 系统把整个 App 藏起来时，只 focus 窗口是不够的，先 show 再抢激活。
    if (app.isHidden && app.isHidden()) app.show();
    app.focus({ steal: true });
  },
  // 只写日志，不参与判定：真机复现 Siri 时用来区分「真退出全屏」与「只是切了 Space」。
  diagnostics: () => {
    if (!win || win.isDestroyed()) return {};
    try {
      const b = win.getBounds();
      const d = screen.getDisplayMatching(b).bounds;
      return {
        appActive: process.platform === 'darwin' ? app.isActive() : 'n/a',
        win: `${b.width}x${b.height}@${b.x},${b.y}`,
        display: `${d.width}x${d.height}`,
      };
    } catch {
      return {};
    }
  },
  log: appendKioskLog,
});

/**
 * Windows 全局键盘钩子（2026-11-09）。
 *
 * **只在 Windows + 学生模式下生效**：吞掉 Alt+Tab / Win / Alt+F4 / Ctrl+Shift+Esc 等
 * 能逃离或杀掉 App 的组合键。mac/linux 上 `createKeyboardHook` 直接 no-op，不会 require
 * `native/keyhook.node`（那个产物只在 CI 的 windows runner 上编译，不入库）。
 *
 * 失败一律降级：缺 .node / ABI 不兼容 / `SetWindowsHookEx` 失败都只写 kiosk-guard.log，
 * 绝不阻断启动或答题。
 */
const keyboardHook = createKeyboardHook({
  platform: process.platform,
  load: () => require('./native/keyhook.node'),
  log: appendKioskLog,
});

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
      // 生产构建关掉 DevTools（spec §4.4）：这是「改 localStorage」这个逃逸面
      // 价值最高的一道门槛 —— 它也一并封掉 F12 / Cmd+Opt+I / Ctrl+Shift+I。
      // dev 模式保留（isPackaged 为 false），调试不受影响。
      devTools: !app.isPackaged,
    },
  });
  // 本次创建的窗口。`closed` 处理器靠它区分「旧窗口晚到的 closed」与「当前窗口」。
  const thisWindow = win;

  // 「偏向多锁」：上次是学生模式就一开机就进 kiosk，不等渲染层（spec §4.3、§6-7）。
  // 在首页真正显示出来之前应用，避免「先普通窗口、再全屏」的可见闪动。
  if (studentMode) {
    win.once('ready-to-show', () => applyStudentMode(studentMode));
  }

  win.loadURL(WEB_URL);

  // 连不上 → 本地页 + 探测式重试（spec §4.2）
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
    if (!isMainFrame) return; // 子资源（图片/CSS）失败不算「连不上」
    if (errorCode === -3) return; // ERR_ABORTED：导航被取消，页面并未失败
    // ⚠️ 错误码必须落盘：Finder 启动时主进程 stdout 进了黑洞，这是现场唯一能拿到
    // net::ERR_xxx 的地方（2026-10-13 排查本地网络静默拒绝时补）。
    const line = `[${new Date().toISOString()}] did-fail-load code=${errorCode} (${errorDescription}) url=${_url}\n`;
    console.error(`[shell] ${line.trim()}`);
    try {
      fs.appendFileSync(path.join(app.getPath('userData'), 'load-error.log'), line);
    } catch { /* 日志写失败绝不影响主流程 */ }
    showOfflinePage();
    startRetry();
  });

  win.webContents.on('did-finish-load', () => {
    if (!win || win.isDestroyed()) return;
    // 主 frame 加载完成且当前不是本地页（file:）→ 说明连上了，停表
    if (!win.webContents.getURL().startsWith('file:')) stopRetry();
  });

  // 崩溃自恢复（spec 2026-11-10 §3.2）：界面没了 = 学生看到的是死窗口，
  // 而"窗口还在、kiosk 还在"会骗过看门狗。首次崩溃就地 reload；60 秒内再来一次
  // 说明这个页面/进程起不来，直接重建窗口（重建后由 ready-to-show 重新进 kiosk）。
  win.webContents.on('render-process-gone', (event, details) => {
    // 旧渲染进程的迟到事件不能动当前窗口：它可能已经被重建后的新窗口取代，
    // 拿它去 reload/destroy 会把正在用的窗口打掉。
    if (win && event.sender !== win.webContents) return;
    // 正常关闭/kill 也会触发，别把它当崩溃去"复活"窗口。
    if (details && details.reason === 'clean-exit') return;
    const now = Date.now();
    const repeated = now - rendererCrashAt < 60_000;
    rendererCrashAt = now;
    appendKioskLog(
      `[guard] render-process-gone reason=${details && details.reason} repeated=${repeated}`,
    );
    try {
      if (!win || win.isDestroyed()) return;
      if (repeated) {
        const old = win;
        // 不要先把 win 置 null：`closed` 处理器会按窗口身份判断（见下面的 `thisWindow`），
        // 由它负责收尾，否则会漏掉 stopRetry / kioskGuard.stop。
        old.destroy(); // destroy 绕过 close 拦截（拦截是给学生的，不是给恢复逻辑的）
        createWindow();
      } else {
        win.webContents.reload();
      }
    } catch (err) {
      appendKioskLog(`[guard] render-recover-error err=${err && err.message}`);
    }
  });

  // GPU / utility 崩了不该整窗重建，记一笔就够（下一次 tick 会检查窗口状态）。
  win.webContents.on('child-process-gone', (_event, details) => {
    appendKioskLog(
      `[guard] child-process-gone type=${details && details.type} reason=${details && details.reason}`,
    );
  });

  // 拦外链：AI 回复的 markdown 会渲染 target="_blank"（AdminChatPage / AuxChatPanel），
  // 不拦就是「大模型吐个链接 → 学生点进浏览器」。
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!isSameOrigin(url)) event.preventDefault();
  });

  // 学生模式下关不掉 / 最小化不了（kiosk 就该是这样）。家长/管理员登录时 studentMode=false，窗口完全正常。
  win.on('close', (event) => {
    appendKioskLog(`[guard] close-attempt student-mode=${studentMode}`);
    if (studentMode) event.preventDefault();
  });
  win.on('minimize', (event) => {
    if (studentMode) {
      event.preventDefault();
      kioskGuard.schedule('minimize');
    }
  });

  // 系统打断后的恢复：**尽力而为，不是阻断**（spec §8 局限 1）。
  //
  // Siri / 通知 / Mission Control / 切 Space / Esc 退出全屏拦不住，但**不能让它停在
  // 非全屏**。这些事件都只负责「就近调度」，真正的恢复动作与节流在 `lib/kiosk-guard.js`
  // 与每秒一次的看门狗里 —— 不要在这里各写一套 focus/kiosk 逻辑（会漂移）。
  //
  // 刻意**不加** `setAlwaysOnTop`：那会盖住 UAC / 系统安全对话框，风险大于收益。
  win.on('blur', () => {
    appWasInactive = true;
    kioskGuard.schedule('blur');
  });
  win.on('leave-full-screen', () => kioskGuard.schedule('leave-full-screen'));
  win.on('hide', () => kioskGuard.schedule('hide'));
  win.on('show', () => kioskGuard.schedule('show'));
  win.on('restore', () => kioskGuard.schedule('restore'));

  win.on('closed', () => {
    // 恢复逻辑会 destroy 旧窗口再建新的；旧窗口的 closed 晚到一步时，
    // 不能把 `win` 里已经装好的新窗口抹掉。
    if (win !== thisWindow) return;
    // 窗口没了就把重试表停掉，别留一个每 5 秒空转（被 `!win` 挡掉）的定时器。
    // 注意：这**不是**功能修复 —— 重建窗口后自动重连本来就能工作（interval 回调读的是
    // 模块级 `win`，不是捕获的旧窗口）。新窗口加载失败时 did-fail-load 会自己重新起表。
    stopRetry();
    kioskGuard.stop();
    keyboardHook.setEnabled(false); // 窗口没了钩子也不该继续拦系统快捷键
    win = null;
  });
}

/**
 * 第二个实例被单实例锁挡下时，由**已在运行的**这个实例把窗口抢回前台（spec 2026-11-10 §4.2）。
 * 不接管的话，学生双击图标看起来"什么都没发生" —— 而窗口可能正被系统压到后台。
 */
app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  // 与守护层同一套抢前台手段（app.focus 才激活 App，win.focus 不够）。
  app.focus({ steal: true });
  if (studentMode) kioskGuard.scheduleReassert('second-instance');
});

// 拦 before-quit：否则 Cmd+Q / Alt+F4 能绕过上面那个 close 拦截。
app.on('before-quit', (event) => {
  appendKioskLog(`[guard] before-quit student-mode=${studentMode}`);
  if (studentMode) event.preventDefault();
});

// 进程要退出时一定摘钩子：钩子回调指向本模块的代码，不能带着它退出。
// 同时清 `running.flag`：只有走到这里才算「正常退出」，下次启动据此区分强杀/崩溃。
app.on('will-quit', () => {
  // ⚠️ 单实例锁输掉的进程**没有**写过 running.flag，绝不能在这里删 ——
  // 删掉的是**正在运行的那个实例**的标记，之后它被强杀就再也判不出异常退出。
  if (!singleInstance) return;
  keyboardHook.setEnabled(false);
  appendKioskLog('[guard] will-quit');
  markCleanExit(app.getPath('userData'));
});

app.whenReady().then(() => {
  // 单实例锁没拿到 → 本进程已在退出路上，绝不能建窗口或装任何东西。
  if (!singleInstance) return;

  // 必须**先**判定再写标记，否则每次启动都会被自己刚写的标记判成异常结束。
  if (wasAbnormalExit(app.getPath('userData'))) {
    appendKioskLog('[guard] reason=abnormal-exit');
  }
  markRunning(app.getPath('userData'));

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

  // ⚠️ 看护必须在**窗口出来之后**再装：`installWatchdog` 内部的 `launchctl` 是同步的
  // （每次最多 3 秒超时 × 最多三次）—— 放在前面最坏情况要等约 9 秒才见到窗口，
  // 首次启动看起来就是「双击了没反应」。两者没有顺序依赖。
  createWindow();

  // 首启安装看护：学生模式被强杀后 5 秒内拉回 kiosk；家长模式它空转。
  // 只在真 `.app` 里装：`app.getAppPath()` 的 asar 形态是打包后的判据，
  // 万一形态变了（解包目录 / 别处的 Resources），装一个指向错误路径的 plist
  // 只会让看护反复拉起失败 —— 宁可跳过并留痕。
  if (app.isPackaged) {
    const appBundle = app.getAppPath().replace(/\/Contents\/Resources\/app\.asar$/, '');
    if (appBundle.endsWith('.app')) {
      installWatchdog({
        platform: process.platform,
        execPath: appBundle,
        homeDir: app.getPath('home'),
        log: appendKioskLog,
      });
    } else {
      appendKioskLog('[guard] watchdog-skip reason=not-app-bundle');
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (studentMode) {
      // Dock 图标被点击 = App 曾被切到后台。guard 可能因窗口 closed 停过，这里补回。
      kioskGuard.start();
      kioskGuard.schedule('app-activate');
    }
  });

  // 睡眠唤醒 / 解锁后，系统可能重建窗口与全屏状态（macOS 上尤其明显）。
  // 只调度，不直接改窗口 —— 恢复逻辑与节流统一在 kiosk-guard 里。
  powerMonitor.on('resume', () => kioskGuard.schedule('power-resume'));
  powerMonitor.on('unlock-screen', () => kioskGuard.schedule('unlock-screen'));

  // Siri / 通知把 App 顶到后台后，系统把它切回前台会走这里（与窗口的 focus/blur 不同：
  // 那是窗口级，这是 App 级）。**只要之前确实离开过前台，就无条件重进 kiosk** ——
  // 失活的副作用是 presentation options 被系统收回（Cmd+Tab 重新可用），
  // 而窗口四项状态全部照旧为 true，`schedule()` 会判定健康、什么都不做。
  app.on('did-resign-active', () => {
    appWasInactive = true;
  });
  app.on('did-become-active', () => {
    if (appWasInactive) {
      appWasInactive = false;
      // macOS 才需要「无条件重进」：失活会收回 app 级 presentation options（Cmd+Tab 封锁），
      // 而窗口四项状态仍全是 true，健康检查看不出来。Windows/Linux 的 kiosk 只是全屏，
      // 每次切回来都重进等于白白闪一下，交给常规健康检查即可。
      if (process.platform === 'darwin') {
        kioskGuard.scheduleReassert('did-become-active');
      } else {
        kioskGuard.schedule('did-become-active');
      }
    } else {
      kioskGuard.schedule('did-become-active');
    }
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
  appendKioskLog(`[guard] student-mode=${studentMode}`);

  // ⚠️ 必须在窗口判空**之前**：启动恢复学生模式时窗口可能还没建好，
  // 放到后面会让「开机即学生模式」这一路永远不装 Windows 钩子。
  keyboardHook.setEnabled(studentMode);

  if (!win || win.isDestroyed()) {
    kioskGuard.stop();
    return;
  }
  win.setKiosk(studentMode);
  win.setClosable(!studentMode);
  // setMinimizable 在 macOS 上是 no-op；Windows/Linux 上有效。不是错误，别加平台分支。
  win.setMinimizable(!studentMode);

  // 学生模式才守护；家长/管理员登录后必须彻底停下，否则会把普通窗口也拽回全屏。
  if (studentMode) kioskGuard.start();
  else kioskGuard.stop();
}

// 渲染层 → 主进程：学生模式开关。`setKiosk` 是真全屏 + 锁定（比 fullscreen 更彻底）。
ipcMain.on('kiosk:set-student-mode', (_event, on) => {
  applyStudentMode(on);
});

// 本地页「立即重试」→ 走同一条探测路径（单向通道，spec §4.2）
ipcMain.on('shell:retry-now', () => {
  void tryReconnect();
});
