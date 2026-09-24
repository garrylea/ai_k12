/**
 * device-control 模块的对外响应类型（spec `2026-09-23-pc-app-study-lockdown-design.md` §5）。
 * 纯 TypeScript interface，无装饰器；必须与 `docs/api/openapi.yaml` 保持一致。
 */

/** `POST /api/student/learning-sessions` 的响应（spec §5.1）。 */
export interface StudentSessionView {
  id: number;
  startedAt: string;
  /** 开始时的快照；`null` = 本次未设锁。 */
  lockMinutes: number | null;
  lockExpiresAt: string | null;
  unlockedAt: string | null;
}
