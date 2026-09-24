const { contextBridge, ipcRenderer } = require('electron');

/**
 * 渲染层与主进程之间**唯一**的通道（spec §6.1）。
 *
 * 只暴露两个东西，且都是单向/只读的：
 *   - `setStudentMode`：渲染层 → 主进程，**学生角色**时进 kiosk（真全屏 + 关不掉）。渲染层是唯一发起方。
 *   - `isDesktop`：能力探测，渲染层据此决定是否启用整套锁定（浏览器里没有这个对象）。
 *
 * ⚠️ **信号语义是「学生模式」，不是「锁定窗口生效」**（2026-09-24 修正）：kiosk 只由**角色**决定
 * （spec §3 裁决 2 + §6.2：`UNLOCKED` 也是 kiosk 全屏）；家长设的时长只决定**能不能登出**，
 * 那件事由渲染层的 `LogoutButton` 自己判（§6.3）。**两件事勿再合并**——合并过一次，
 * 后果是「家长没设时长 → 学生登录后完全不被全屏、可随便切应用」。
 *
 * **不要**在这里加 `require`/`fs`/`ipcRenderer.invoke` 之类的口子：渲染层加载的是
 * 远端页面（云端时是公网），暴露 Node 能力等于把整台机器交出去。
 */
contextBridge.exposeInMainWorld('k12Desktop', {
  setStudentMode: (on) => ipcRenderer.send('kiosk:set-student-mode', Boolean(on)),
  isDesktop: true,
});
