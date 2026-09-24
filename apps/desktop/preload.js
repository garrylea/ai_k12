const { contextBridge, ipcRenderer } = require('electron');

/**
 * 渲染层与主进程之间**唯一**的通道（spec §6.1）。
 *
 * 只暴露两个东西，且都是单向/只读的：
 *   - `setLocked`：渲染层 → 主进程，驱动 kiosk 开关。渲染层是唯一发起方。
 *   - `isDesktop`：能力探测，渲染层据此决定是否启用整套锁定（浏览器里没有这个对象）。
 *
 * **不要**在这里加 `require`/`fs`/`ipcRenderer.invoke` 之类的口子：渲染层加载的是
 * 远端页面（云端时是公网），暴露 Node 能力等于把整台机器交出去。
 */
contextBridge.exposeInMainWorld('k12Desktop', {
  setLocked: (locked) => ipcRenderer.send('kiosk:set-locked', Boolean(locked)),
  isDesktop: true,
});
