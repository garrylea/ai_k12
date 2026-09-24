import { endStudentLearningSession } from '@/services/api';
import { clearPersistedSession, readPersistedSession } from './learningLock';

/** preload 经 `contextBridge` 暴露的接口（见 `apps/desktop/preload.js`）。 */
export interface K12DesktopBridge {
  /** 驱动主进程进/出 kiosk。渲染层是唯一发起方。**语义是「学生模式」，与锁定窗口无关**。 */
  setStudentMode: (on: boolean) => void;
  isDesktop: true;
}

declare global {
  interface Window {
    k12Desktop?: K12DesktopBridge;
  }
}

/**
 * 是否运行在 Electron 壳里。
 *
 * 这是**能力探测，不是环境判断**：浏览器里没有 `window.k12Desktop`，锁定相关的一切
 * （建会话、轮询、禁登出、剩余时间）都该整段跳过——浏览器没有 kiosk 可逃，锁它没有意义，
 * 而 Web 端「进出时间」也不在本期范围内（spec §8 局限 5）。
 */
export function isDesktopShell(): boolean {
  return typeof window !== 'undefined' && Boolean(window.k12Desktop);
}

/**
 * 把**学生模式**同步给主进程（进/出 kiosk）。没有桥时是**静默 no-op**（浏览器里也是正常路径，不是异常）。
 *
 * ⚠️ **传的是「当前登录者是不是学生」，不是「锁定窗口是否生效」**（2026-09-24 修正）：
 * 家长设的时长只决定**能不能登出**（`LogoutButton` 自判，见 spec §6.3）与要不要显示 pill。
 * 两者合并过一次，后果是「家长没设时长 → 学生登录后完全不被全屏、可随便切应用」。
 */
export function setDesktopStudentMode(on: boolean): void {
  // `?.` 是有意的：preload 只在**窗口创建时**加载，dev 期改了 `preload.js` 后老壳的桥还是旧接口。
  // 这种情况下静默跳过好过抛 TypeError 把整个壳组件打崩（真机发布不存在这种不一致）。
  // ⚠️ 改了 preload 的接口名**必须重启壳**（`npm start`），热更新救不了。
  window.k12Desktop?.setStudentMode?.(on);
}

/**
 * 真正登出时的收尾，由 `LogoutButton` 调用。
 *
 * 三件事，**顺序有意**：
 *   1. 先告诉服务端这次学习会话结束了（`ended_at` 是家长端「退出时间」的数据源，
 *      不发这个请求，家长会看到一次永远「进行中 / 已断开」的记录）；
 *   2. 再清本地快照（否则下次登录会沿用旧会话）；
 *   3. 最后解除壳锁定（不清壳锁定的话，登出后窗口仍然是 kiosk，家长/管理员用不了）。
 *
 * 请求失败**必须吞掉**：登出是主链路，不能因为一次网络抖动就把学生留在登录页外面。
 * 本地快照照清、壳锁定照解——最坏情况是家长端少一条 `ended_at`。
 */
export function releaseOnLogout(): void {
  const session = readPersistedSession();
  if (session) {
    void endStudentLearningSession(session.id).catch(() => {
      /* 吞掉：登出不得被网络问题阻断 */
    });
  }
  clearPersistedSession();
  // 学生已登出 → 退出 kiosk（用「学生模式」而非「是否仍锁定」：登出后必须让家长/管理员能用这台机器）
  setDesktopStudentMode(false);
}
