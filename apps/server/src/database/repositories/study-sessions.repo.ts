import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export interface StudySessionRow extends RowDataPacket {
  id: number;
  student_id: number;
  session_uid: string;
  module: string;
  scene: string;
  subject_id: number | null;
  ref_type: string | null;
  ref_id: number | null;
  status: 'active' | 'ended' | 'abandoned';
  client_state: 'visible' | 'hidden';
  active_seconds: number;
  heartbeat_count: number;
  started_at: Date;
  last_heartbeat_at: Date;
  ended_at: Date | null;
  end_reason: string | null;
  platform_class: string | null;
  browser: string | null;
  screen_class: string | null;
  input_type: string | null;
  app_shell: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface StudySessionInsertInput {
  studentId: number;
  sessionUid: string;
  module: string;
  scene: string;
  subjectId: number | null;
  refType: string | null;
  refId: number | null;
  platformClass: string | null;
  browser: string | null;
  screenClass: string | null;
  inputType: string | null;
  appShell: string | null;
}

const INSERT_COLUMNS =
  '(student_id, session_uid, module, scene, subject_id, ref_type, ref_id, platform_class, browser, screen_class, input_type, app_shell)';

/**
 * 学习会话仓储（`study_sessions`，学习时长的唯一真源）。
 *
 * **两条纪律**（spec §3）：
 * 1. `active_seconds` 只在这里累加，且**单次封顶 45s**——不封顶时「关标签 2 小时」
 *    会在下一次心跳被算成 2 小时。`GREATEST(0, ...)` 兜住客户端/DB 时钟回拨。
 * 2. 所有写入都是**业务数据直写**：调用方（service）必须包 try/catch，失败只 warn、绝不 500。
 *    心跳失败前端无感，是刻意的。
 *
 * 心跳 / 结束都带 `status = 'active'` 条件——这是乐观锁：会话一旦 ended，
 * 迟到的请求只会影响 0 行，不会把已结算的秒数再动一遍。
 */
@Injectable()
export class StudySessionsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /**
   * 按 session_uid 查（**不按 student 过滤**）。
   *
   * 故意不按学生过滤：`session_uid` 是前端生成的，服务层需要能分辨
   * 「这个 uid 被别的学生占用了」并拒掉，而不是静默把别人会话的 startedAt 返回。
   * 数据泄漏面为零——service 只在比对 `student_id` 后使用，不会把行内容回给调用方。
   */
  async findByUid(sessionUid: string): Promise<StudySessionRow | null> {
    const [rows] = await this.pool.execute<StudySessionRow[]>(
      `SELECT * FROM study_sessions WHERE session_uid = ? LIMIT 1`,
      [sessionUid],
    );
    return rows[0] ?? null;
  }

  /** `true` = 真新建；撞 `uniq_ss_uid` → `false`（幂等，调用方回读既有会话）。 */
  async insert(input: StudySessionInsertInput): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT IGNORE INTO study_sessions ${INSERT_COLUMNS} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.studentId,
        input.sessionUid,
        input.module,
        input.scene,
        input.subjectId,
        input.refType,
        input.refId,
        input.platformClass,
        input.browser,
        input.screenClass,
        input.inputType,
        input.appShell,
      ],
    );
    return result.affectedRows === 1;
  }

  /**
   * 心跳：按「上次心跳」到现在累加秒数，**只在上一状态为 visible 时计**（hidden 暂停计时）。
   *
   * ⚠️ **本语句的列顺序是 load-bearing 的**：MySQL 对单表 `SET` 列表**从左到右**求值，
   * 后出现的表达式若引用前面已赋值的列，读到的是**新值**——并不是「所有表达式都用更新前的值」。
   * 所以 `IF(client_state = 'visible', ...)` **必须排在 `client_state = ?` 之前**：它要读的是
   * **本次上报前**的状态（上一段是否 visible）。一旦把 `client_state = ?` 挪到前面，语句照样能
   * 编译运行，但 `IF` 会读到本次上报的新状态——hidden 心跳不再补计最后一段 visible、
   * visible 心跳反而把 hidden 期间也计上，**静默算错时长**（有顺序钉子用例守着，别调换）。
   *
   * 另外**不要拆成两条 SQL**（会有竞态窗口）。
   *
   * 返回累计秒数；`null` = 会话不存在 / 非本人 / 非 active（调用方**静默 200**，不报错——
   * 心跳是尽力而为，报错只会污染前端日志）。
   */
  async heartbeat(
    sessionUid: string,
    studentId: number,
    state: 'visible' | 'hidden',
  ): Promise<number | null> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE study_sessions
       SET active_seconds = active_seconds
             + IF(client_state = 'visible',
                  GREATEST(0, LEAST(TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW(3)), 45)),
                  0),
           client_state = ?,
           heartbeat_count = heartbeat_count + 1,
           last_heartbeat_at = NOW(3)
       WHERE session_uid = ? AND student_id = ? AND status = 'active'`,
      [state, sessionUid, studentId],
    );
    if (result.affectedRows === 0) return null;

    const [rows] = await this.pool.execute<(RowDataPacket & { active_seconds: number })[]>(
      `SELECT active_seconds FROM study_sessions WHERE session_uid = ? LIMIT 1`,
      [sessionUid],
    );
    return Number(rows[0]?.active_seconds ?? 0);
  }

  /**
   * 结束会话：先补计最后一段（同心跳的封顶规则，但**不改** `client_state`），再落状态。
   *
   * `ended_at = NOW(3)` 而不是 `last_heartbeat_at`：用户按「离开」时已经过了一段时间，
   * 秒数已按 `last_heartbeat_at → NOW(3)` 补进来，结束时刻就该是现在。
   */
  async end(
    sessionUid: string,
    studentId: number,
    reason: string,
  ): Promise<{ activeSeconds: number; endedAt: Date } | null> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE study_sessions
       SET active_seconds = active_seconds
             + IF(client_state = 'visible',
                  GREATEST(0, LEAST(TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW(3)), 45)),
                  0),
           status = 'ended',
           end_reason = ?,
           ended_at = NOW(3),
           last_heartbeat_at = NOW(3)
       WHERE session_uid = ? AND student_id = ? AND status = 'active'`,
      [reason, sessionUid, studentId],
    );
    if (result.affectedRows === 0) return null;

    const [rows] = await this.pool.execute<
      (RowDataPacket & { active_seconds: number; ended_at: Date })[]
    >(
      `SELECT active_seconds, ended_at FROM study_sessions WHERE session_uid = ? LIMIT 1`,
      [sessionUid],
    );
    const row = rows[0];
    return row ? { activeSeconds: Number(row.active_seconds), endedAt: row.ended_at } : null;
  }

  /**
   * 惰性收尾：`active` 且心跳超 5 分钟的会话视为已结束。
   *
   * 为什么需要：用户直接关标签 / 断网时不会有 `end` 请求，会话会永远 `active`——
   * 「今日已用时长」会一直不更新。收尾时 `ended_at = last_heartbeat_at`
   * （不是 NOW），因为最后 5 分钟的实际状态未知，不能白送时长。
   *
   * `studentId` 可选：家长查单人时传（顺带修正那个人），夜间任务不传（全库兜底）。
   */
  async closeStale(studentId?: number): Promise<number> {
    const where = studentId === undefined ? '' : ' AND student_id = ?';
    const params = studentId === undefined ? [] : [studentId];
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE study_sessions
       SET status = 'ended', end_reason = 'closed', ended_at = last_heartbeat_at
       WHERE status = 'active' AND last_heartbeat_at < NOW(3) - INTERVAL 5 MINUTE${where}`,
      params,
    );
    return result.affectedRows;
  }
}
