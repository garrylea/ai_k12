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

/** `PATCH /api/student/learning-sessions/:id/end` 的响应（spec §5.2）。 */
export interface EndSessionView {
  id: number;
  endedAt: string;
}

/** `GET /api/student/device-commands` 的响应（spec §5.3）。 */
export interface PollView {
  commands: Array<{ id: number; command: string }>;
  /**
   * 当前进行中会话的锁定状态，供客户端**对账**——本地 `lockExpiresAt` 与服务端不一致时
   * 以服务端为准（例如家长已在别处解除）。无进行中会话 → `null`。
   */
  lock: { sessionId: number; lockExpiresAt: string | null; unlockedAt: string | null } | null;
}

/** `POST /api/parent/students/:studentId/device-commands` 的响应（spec §5.4）。 */
export interface IssuedCommandView {
  id: number;
  command: string;
  status: 'pending';
  /** 该命令指向的进行中会话。家长端据此知道「解除了哪一次」。 */
  learningSessionId: number;
  createdAt: string;
}
