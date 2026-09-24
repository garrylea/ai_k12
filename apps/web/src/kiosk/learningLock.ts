/**
 * 学习锁定的**纯逻辑**（spec `2026-09-23-pc-app-study-lockdown-design.md` §6.2/§6.4）。
 *
 * 本文件刻意不碰 Electron、不发请求：锁定判定是最容易出错的地方（到期边界、跨学生、
 * 家长已解除），必须能在没有 DOM / 没有壳的环境里逐条测。
 */

/** localStorage 键：本次学习会话的本地快照。 */
export const LEARNING_SESSION_STORAGE_KEY = 'k12_learning_session';

/**
 * 客户端轮询间隔（毫秒）。
 *
 * ⚠️ **与服务端 `LEARNING_SESSION_ONLINE_WINDOW_SECONDS = 45` 成对**（45 秒 = 容忍 4 次
 * 丢包/抖动）。**改一处必须同步另一处**——沿用本仓 `IDLE_TIMEOUT_MS` ↔
 * `CLIENT_IDLE_DETECTION_SECONDS` 的镜像纪律。
 */
export const LEARNING_SESSION_POLL_MS = 10_000;

export interface PersistedLearningSession {
  /**
   * 归属学生。**必须存**：本仓 MVP 明确「家长与学生可共用同一设备」（UX `:233-234`），
   * 换学生登录后若沿用上一个人的锁定，会锁住一个本不该被锁的孩子。
   */
  studentId: number;
  id: number;
  lockExpiresAt: string | null;
  unlockedAt: string | null;
}

/**
 * 读本地快照。传了 `studentId` 就做归属校验，不符返回 `null`。
 *
 * **每次调用都重新 `localStorage.getItem`**，不在模块初始化时缓存：测试的
 * `beforeEach` 会 `vi.stubGlobal('localStorage', …)` 换成新的内存实现，
 * 模块级缓存会拿到过期对象（`parentStudentStore.ts` 踩过这个坑，注释里有完整经过）。
 * 内容损坏 / 形状不对一律返回 `null`，不抛错——坏数据不该让整个应用白屏。
 */
export function readPersistedSession(studentId?: number | null): PersistedLearningSession | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(LEARNING_SESSION_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedLearningSession> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.studentId !== 'number' || typeof parsed.id !== 'number') return null;
    if (studentId !== undefined && studentId !== null && parsed.studentId !== studentId) return null;
    return {
      studentId: parsed.studentId,
      id: parsed.id,
      lockExpiresAt: typeof parsed.lockExpiresAt === 'string' ? parsed.lockExpiresAt : null,
      unlockedAt: typeof parsed.unlockedAt === 'string' ? parsed.unlockedAt : null,
    };
  } catch {
    return null;
  }
}

export function writePersistedSession(value: PersistedLearningSession): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(LEARNING_SESSION_STORAGE_KEY, JSON.stringify(value));
}

export function clearPersistedSession(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(LEARNING_SESSION_STORAGE_KEY);
}

/**
 * 是否处于锁定中（= 期间禁止登出）。
 *
 * 四个条件缺一不可：有截止时间、**家长没解除**、截止时间可解析、且**严格晚于** now。
 *
 * 「截止时间恰好等于 now」算**不锁**（开区间）：到点自动解除，边界上不该多锁一毫秒。
 * 不可解析的日期算**不锁**：宁可放行也不能把一个学生永久锁死。
 * `unlockedAt` 优先于截止时间：家长点了「解除」就该立刻生效，不必等原定时刻。
 */
export function isLocked(
  session: { lockExpiresAt: string | null; unlockedAt: string | null } | null,
  now: number = Date.now(),
): boolean {
  if (!session) return false;
  if (session.unlockedAt !== null) return false;
  if (session.lockExpiresAt === null) return false;
  const expiresAt = Date.parse(session.lockExpiresAt);
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt > now;
}

/** 当前登录学生是否被锁。未登录 / 非该生 → false。 */
export function isCurrentStudentLocked(now: number = Date.now()): boolean {
  if (typeof localStorage === 'undefined') return false;
  const rawUserId = localStorage.getItem('userId');
  if (rawUserId === null) return false;
  const studentId = Number(rawUserId);
  if (!Number.isFinite(studentId)) return false;
  return isLocked(readPersistedSession(studentId), now);
}

/** 剩余毫秒（可能为负；调用方负责判断）。 */
export function remainingMs(lockExpiresAt: string, now: number = Date.now()): number {
  return Date.parse(lockExpiresAt) - now;
}

/**
 * 剩余时间的展示文案。**向上取整到分钟**：1 分 30 秒显示「剩余 2 分钟」而不是 1 分钟——
 * 少报会让学生以为马上能走，多报 30 秒无感。
 */
export function formatRemaining(ms: number): string {
  if (ms < 60_000) return '剩余不足 1 分钟';
  return `剩余 ${Math.ceil(ms / 60_000)} 分钟`;
}
