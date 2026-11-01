/**
 * 作答历史会话 UUID（2026-11-01）。
 *
 * 每次进入专项练习答题页生成一个，本次练习的所有判题都带上它，
 * 后端据此把逐题作答归到同一个 `special_practice_sessions` 行。
 *
 * `crypto.randomUUID()` 需要 secure context（https / localhost）；局域网
 * http 访问（如 iPad 连本机 192.168.x.x）时它不存在，降级为时间戳+随机串
 * （本用途只需唯一，不需要密码学强度）。
 */
export function newSessionUid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
