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

export function saveAuthSession(session: AuthSession, remember: boolean): void {
  clearAuthSession();
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
