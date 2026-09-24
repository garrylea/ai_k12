const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

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
 * 壳加载的 Web 地址。本期默认本地 vite dev（`http://localhost:5173`——它已在服务端
 * CORS 白名单里，故本期零 CORS 改动）。
 *
 * `K12_WEB_URL` 就是**云端接缝**：下一期把后端部署到公网后改这个环境变量即可，
 * 不需要改代码。云端接入所需的 CORS / HTTPS / 持久化存储**不在本期范围**。
 */
const WEB_URL = process.env.K12_WEB_URL || 'http://localhost:5173';

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

  win.loadURL(WEB_URL);

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
    win = null;
  });
}

// 拦 before-quit：否则 Cmd+Q / Alt+F4 能绕过上面那个 close 拦截。
app.on('before-quit', (event) => {
  if (studentMode) event.preventDefault();
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 渲染层 → 主进程：学生模式开关。`setKiosk` 是真全屏 + 锁定（比 fullscreen 更彻底）。
ipcMain.on('kiosk:set-student-mode', (_event, on) => {
  studentMode = Boolean(on);
  if (!win || win.isDestroyed()) return;
  win.setKiosk(studentMode);
  win.setClosable(!studentMode);
  // setMinimizable 在 macOS 上是 no-op；Windows/Linux 上有效。不是错误，别加平台分支。
  win.setMinimizable(!studentMode);
});
