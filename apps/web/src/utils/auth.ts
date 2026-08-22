/**
 * 前端会话工具：JWT 过期校验 + 本地登录态清理。
 *
 * 后端签发 JWT 时带 7 天有效期（exp），前端据此判断会话是否仍有效，
 * 避免"角色还在 localStorage 但 token 已过期"时仍进入受保护页面。
 * 注意：这只是 UX 层校验，真正的越权防护由后端 AuthMiddleware/RolesGuard 兜底。
 */

const TOKEN_KEY = 'token';
const AUTH_KEYS = ['token', 'userId', 'username', 'userRole'];

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

/** 解码 JWT payload（base64url → JSON），失败返回 null */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const utf8 = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join(''),
    );
    return JSON.parse(utf8);
  } catch {
    return null;
  }
}

/** token 是否已过期；无法解析视为无效，无 exp 视为未过期 */
export function isTokenExpired(token: string): boolean {
  const payload = decodeJwtPayload(token);
  if (!payload) return true;
  const exp = payload.exp;
  if (typeof exp !== 'number' || Number.isNaN(exp)) return false;
  return Date.now() >= exp * 1000;
}

/** 当前会话是否有效：存在 token 且未过期 */
export function isSessionValid(): boolean {
  const token = getToken();
  if (!token) return false;
  return !isTokenExpired(token);
}

/** 清除本地登录态（token/用户信息/角色） */
export function clearAuth(): void {
  for (const key of AUTH_KEYS) {
    localStorage.removeItem(key);
  }
}
