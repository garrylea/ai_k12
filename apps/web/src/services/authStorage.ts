/**
 * 鉴权信息（token + 用户四键）在 localStorage / sessionStorage 间的统一读写层。
 *
 * 「记住我」语义（登录/注册页的勾选，默认不勾）：
 * - 勾选 → 写 localStorage：持久保留，服务端 JWT 7 天内免登录（现状行为）。
 * - 不勾 → 写 sessionStorage：关浏览器/标签页即整体清空，公共电脑必须重新登录。
 *
 * 读取一律 sessionStorage 优先、localStorage 兜底；写入前先 clearAuthSession()，
 * 保证两个 storage 里不会同时存在两份矛盾的鉴权数据。
 */

export const AUTH_KEYS = ['token', 'userId', 'username', 'userRole'] as const;

export type AuthKey = (typeof AUTH_KEYS)[number];

export interface AuthSession {
  token: string;
  username: string;
  userId: string;
  userRole: string;
}

function safeStorage(kind: 'session' | 'local'): Storage | null {
  try {
    const storage = kind === 'session' ? sessionStorage : localStorage;
    // 与 kiosk/LearningSessionShell 同样的防御：非浏览器环境直接返回 null
    return typeof storage === 'undefined' ? null : storage;
  } catch {
    return null; // 某些隐私模式访问 storage 会抛
  }
}

export function getAuthItem(key: AuthKey): string | null {
  return (
    safeStorage('session')?.getItem(key) ??
    safeStorage('local')?.getItem(key) ??
    null
  );
}

export function getAuthToken(): string | null {
  return getAuthItem('token');
}

/**
 * 「本次登录已被别处踢下线」的进程内标记（单点登录互踢，2026-11-12 补）。
 *
 * 为什么需要它：1013 后的整页跳转 `/login?kicked=1` 依赖页面 unload，而考试页挂了
 * `beforeunload` 守卫。Electron 对「被 beforeunload 取消的 unload」是**静默放弃导航**
 * （不弹确认框），跳转被吞掉；此时 token 已被清，后续请求只会 401/1003（不再触发 1013
 * 跳转），App 会永久停在被踢前的页面。守卫据此标记在「被踢」时让路。
 *
 * 生命周期：只有登录成功（saveAuthSession）才复位——普通登出/清 token 不碰它，
 * 避免 1013 分支「mark 后再 clear」的顺序依赖。
 */
let sessionRevoked = false;

export function markSessionRevoked(): void {
  sessionRevoked = true;
}

export function isSessionRevoked(): boolean {
  return sessionRevoked;
}

export function clearSessionRevoked(): void {
  sessionRevoked = false;
}

export function saveAuthSession(session: AuthSession, remember: boolean): void {
  clearAuthSession();
  clearSessionRevoked();
  const storage = safeStorage(remember ? 'local' : 'session');
  if (!storage) return;
  storage.setItem('token', session.token);
  storage.setItem('userId', session.userId);
  storage.setItem('username', session.username);
  storage.setItem('userRole', session.userRole);
}

export function clearAuthSession(): void {
  for (const key of AUTH_KEYS) {
    safeStorage('local')?.removeItem(key);
    safeStorage('session')?.removeItem(key);
  }
}
