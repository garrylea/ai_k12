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
  /** 会话内累计「页面不可见」秒数（不参与 `active_seconds` 口径）。 */
  hidden_away_seconds: number;
  /** 会话内累计「前台无操作」秒数（不参与 `active_seconds` 口径）。 */
  hidden_idle_seconds: number;
  /** 当前连续挂机段起点；回到 visible 时置 NULL。 */
  hidden_since: Date | null;
  /** 当前挂机段原因 `away` / `idle`；回到 visible 时置 NULL。 */
  hidden_reason: string | null;
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

/** `closeStale` 返回的被关会话挂机段信息（供 service 补判阈值）。 */
export interface ClosedHiddenSession {
  studentId: number;
  hiddenReason: string;
  hiddenSince: Date;
}

export interface CloseStaleResult {
  closedCount: number;
  /** 可含本次 UPDATE 未命中的行（SELECT→UPDATE 并发窗口），消费方按「SELECT 时点曾挂机」理解。 */
  hidden: ClosedHiddenSession[];
}

const INSERT_COLUMNS =
  '(student_id, session_uid, module, scene, subject_id, ref_type, ref_id, platform_class, browser, screen_class, input_type, app_shell)';

/**
 * 学习会话仓储（`study_sessions`，学习时长的唯一真源）。
 *
 * **两条纪律**（spec §3）：
 * 1. `active_seconds` 只在这里累加，且**单次封顶 45s**——不封顶时「关标签 2 小时」
 *    会在下一次心跳被算成 2 小时。`GREATEST(0, ...)` 兜住客户端/DB 时钟回拨。
 * 2. 只有**嵌在别的业务流里**的埋点写入（如家长端 GET 里的 `closeStale`）才必须包 try/catch、失败只 warn、绝不 500；三个采集端点（start/heartbeat/end）**是例外**——允许 DB 失败直接 500，前端传输层会吞掉，而静默隐藏故障会让生产问题只能从日志排障。
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
   * 心跳：按「上次心跳」到现在累加秒数，**只在上一状态为 visible 时计**（hidden 暂停计时）；
   * 同时按 `hidden_reason` 把挂机秒数分 `away` / `idle` 两口径累计（spec §3.3）。
   *
   * ⚠️ **本语句的列顺序是 load-bearing 的**：MySQL 对单表 `SET` 列表**从左到右**求值，
   * 后出现的表达式若引用前面已赋值的列，读到的是**新值**——并不是「所有表达式都用更新前的值」。
   * 因此**三个累计列 + `hidden_since` 的 `IF`** 必须排在 `client_state = ?` / `hidden_reason = ?` /
   * `hidden_since = ...` 之前：累计列要读的是**本次上报前**的状态（上一段是否 visible、
   * 上一段是 away 还是 idle）与上次心跳时刻。一旦排到后面，语句照样能编译运行，
   * 但读到的是本次刚写的新值 → hidden 心跳不再补计最后一段 visible、visible 心跳反而把 hidden
   * 期间也计上、挂机秒数按错误口径累加，**静默算错**（有顺序钉子用例守着，别调换）。
   *
   * 三条挂机/时长口径：
   * - `hidden_away_seconds` / `hidden_idle_seconds`：与 `active_seconds` **完全同源**——按
   *   **上次心跳** `last_heartbeat_at` 的差值增量，单次封顶 45s（防「关标签 2 小时」一次算成 2 小时）。
   *   ⚠️ **基点必须是 `last_heartbeat_at`，不是 `hidden_since`**（2026-09-20 实施时踩到）：
   *   心跳间隔 30s，若按本段起点算，挂机段内每次心跳都会按「距起点」重算并加满 45s →
   *   累计系统性偏大 ~1.6×（实测 45 → 90 → 135）。`hidden_since` 是**另一个**用途：
   *   给服务层判「这一段连续挂机多久了」（阈值判定），**不参与秒数累加**。
   * - `hidden_since`：`IF(? = 'hidden', COALESCE(hidden_since, NOW(3)), NULL)` —— 进入 hidden 时
   *   建立（**已建立则不动**，`COALESCE` 保住本段起点），回到 visible 时清空。
   * - `hidden_reason`：本次上报的原因（`away` / `idle`）。这是「本段原因」，供 service 判定阈值。
   *   ⚠️ **契约（由 service 保证、本层不做归一）：`state !== 'hidden'` 时 `reason` 恒为 `null`。**
   *   `study_sessions.hidden_reason` 的语义是「当前连续挂机段的原因；回到 visible 时置 NULL」
   *   （spec §3.3），所以 visible 上报必须落 NULL。手搓 `{"state":"visible","reason":"away"}`
   *   （Zod 合法）若不归一就会落成 `client_state='visible'` + `hidden_reason='away'` 的坏组合
   *   ——归一的唯一落点是 `StudySessionsService.heartbeat`（本仓 repo 保持薄 SQL 层）。
   *
   * 另外**不要拆成两条 SQL**（会有竞态窗口）。
   *
   * **`subject_id` 只补不覆盖（2026-09-20，P6.5）**：`subject_id = COALESCE(subject_id, ?)` ——
   * 会话开头可能还没有学科（星图没加载完，前端上下文里拿不到 subjectId），心跳时补上；
   * **已经带了就不动**（同一个会话中途换学科，不该改写前面那段的归属）。
   * 前端不传时调用方传 `null`，等价于「没带」。（**非法值到不了这里**：HTTP 路径上
   * `HeartbeatSchema.subjectId` 是 `z.number().int().positive()`，0/负数/小数在 controller
   * 层就 400/1001；service 里那段宽容只服务非 HTTP 调用方。）
   * 它放在挂机三列之后、`heartbeat_count` 之前：与上面那条 `IF` 无交互，
   * 但**别挪到 `IF` 之前**——那条顺序是时长口径的钉子（`subject_id` 赋值本身不参与 IF 求值，
   * 挪动它虽不改变语义，但会让「哪条表达式读旧值」更难一眼看清）。
   *
   * **参数数组逐位对应**：`[state, reason, state, subjectId, sessionUid, studentId]`
   * （`state` 出现两次：`client_state = ?` 与 `hidden_since` 的 `IF(? = 'hidden', ...)`；
   * 共 6 个占位符 = SET 4 + WHERE 2）。
   *
   * ⚠️ 上面这条映射**由 `study-sessions.repo.test.ts` 的 `zipSet` 按列名配对断言**（不是断言
   * 参数数组字面量）——字面量只证明「代码与自己一致」，而 `hidden_since` 与 `subject_id` 两个
   * 子句对调、或两条累计列的 `IF` 守卫对调，字面量断言全绿但生产静默算错（预警永不触发 /
   * away 与 idle 口径互换）。改 SQL 时别只跑「参数数组」那条用例。
   *
   * 返回累计秒数 + 本段挂机信息（供 service 判阈值）；`null` = 会话不存在 / 非本人 / 非 active
   * （调用方**静默 200**，不报错——心跳是尽力而为，报错只会污染前端日志）。
   */
  async heartbeat(
    sessionUid: string,
    studentId: number,
    state: 'visible' | 'hidden',
    subjectId: number | null,
    reason: 'away' | 'idle' | null,
  ): Promise<{ activeSeconds: number; hiddenSince: Date | null; hiddenReason: string | null } | null> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE study_sessions
       SET hidden_away_seconds = hidden_away_seconds
             + IF(client_state = 'hidden' AND hidden_reason = 'away',
                  GREATEST(0, LEAST(TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW(3)), 45)), 0),
           hidden_idle_seconds = hidden_idle_seconds
             + IF(client_state = 'hidden' AND hidden_reason = 'idle',
                  GREATEST(0, LEAST(TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW(3)), 45)), 0),
           active_seconds = active_seconds
             + IF(client_state = 'visible',
                  GREATEST(0, LEAST(TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW(3)), 45)), 0),
           client_state = ?,
           hidden_reason = ?,
           hidden_since = IF(? = 'hidden', COALESCE(hidden_since, NOW(3)), NULL),
           subject_id = COALESCE(subject_id, ?),
           heartbeat_count = heartbeat_count + 1,
           last_heartbeat_at = NOW(3)
       WHERE session_uid = ? AND student_id = ? AND status = 'active'`,
      [state, reason, state, subjectId, sessionUid, studentId],
    );
    if (result.affectedRows === 0) return null;

    const [rows] = await this.pool.execute<
      (RowDataPacket & {
        active_seconds: number;
        hidden_since: Date | null;
        hidden_reason: string | null;
      })[]
    >(
      `SELECT active_seconds, hidden_since, hidden_reason FROM study_sessions WHERE session_uid = ? LIMIT 1`,
      [sessionUid],
    );
    const row = rows[0];
    return {
      activeSeconds: Number(row?.active_seconds ?? 0),
      hiddenSince: row?.hidden_since ?? null,
      hiddenReason: row?.hidden_reason ?? null,
    };
  }

  /**
   * 结束会话：先补计最后一段（同心跳的封顶规则与差值基点 `last_heartbeat_at`、**同一 SET 顺序规则**，
   * 但**不改** `client_state` 与挂机三列），再落状态。
   *
   * 为什么也要累加挂机秒数：`pagehide` 触发的结束之后不会再有心跳，最后这一段挂机不补就会整段丢失
   * （spec §3.3 的「判定时机两处」同源）。`end` 不写 `client_state` / `hidden_since` / `hidden_reason`，
   * 所以它们的旧值在 `SET` 求值时天然可见；但三条累计列仍必须排在 `last_heartbeat_at = NOW(3)`
   * **之前**（`active_seconds` 的 `IF` 要读旧 `last_heartbeat_at`）。
   *
   * 返回值带上本段挂机信息，供 service 在结束路径上做阈值判定（覆盖「最小化后直接关页面」）。
   *
   * `ended_at = NOW(3)` 而不是 `last_heartbeat_at`：用户按「离开」时已经过了一段时间，
   * 秒数已按 `last_heartbeat_at → NOW(3)` 补进来，结束时刻就该是现在。
   */
  async end(
    sessionUid: string,
    studentId: number,
    reason: string,
  ): Promise<{
    activeSeconds: number;
    endedAt: Date;
    hiddenSince: Date | null;
    hiddenReason: string | null;
  } | null> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE study_sessions
       SET hidden_away_seconds = hidden_away_seconds
             + IF(client_state = 'hidden' AND hidden_reason = 'away',
                  GREATEST(0, LEAST(TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW(3)), 45)), 0),
           hidden_idle_seconds = hidden_idle_seconds
             + IF(client_state = 'hidden' AND hidden_reason = 'idle',
                  GREATEST(0, LEAST(TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW(3)), 45)), 0),
           active_seconds = active_seconds
             + IF(client_state = 'visible',
                  GREATEST(0, LEAST(TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW(3)), 45)), 0),
           status = 'ended',
           end_reason = ?,
           ended_at = NOW(3),
           last_heartbeat_at = NOW(3)
       WHERE session_uid = ? AND student_id = ? AND status = 'active'`,
      [reason, sessionUid, studentId],
    );
    if (result.affectedRows === 0) return null;

    const [rows] = await this.pool.execute<
      (RowDataPacket & {
        active_seconds: number;
        ended_at: Date;
        hidden_since: Date | null;
        hidden_reason: string | null;
      })[]
    >(
      `SELECT active_seconds, ended_at, hidden_since, hidden_reason FROM study_sessions WHERE session_uid = ? LIMIT 1`,
      [sessionUid],
    );
    const row = rows[0];
    return row
      ? {
          activeSeconds: Number(row.active_seconds),
          endedAt: row.ended_at,
          hiddenSince: row.hidden_since ?? null,
          hiddenReason: row.hidden_reason ?? null,
        }
      : null;
  }

  /**
   * 惰性收尾：`active` 且心跳超 5 分钟的会话视为已结束。
   *
   * 为什么需要：用户直接关标签 / 断网时不会有 `end` 请求，会话会永远 `active`——
   * 「今日已用时长」会一直不更新。收尾时 `ended_at = last_heartbeat_at`
   * （不是 NOW），因为最后 5 分钟的实际状态未知，不能白送时长。
   *
   * `studentId` 可选：家长查单人时传（顺带修正那个人）。不传的**全库收尾形态是预留入口**
   * ——当前**无调用方**、夜间定时任务**未实现**（仓库内没有任何调度器），参数留给后续阶段用。
   *
   * 2026-09-20「及时可见」批：先 SELECT 命中行、再 UPDATE，返回**被关会话里 hidden 段的
   * 信息**（student_id / hidden_reason / hidden_since），供 `StudySessionsService.closeStale`
   * 补判走神阈值（spec §3.1：心跳全断的后台冻结 tab 只有这里能得到判定机会）。
   * SELECT 与 UPDATE 之间的并发窗口无害：另一并发收尾抢先关掉时，本侧 UPDATE 命中 0 行、
   * 多判的一次被 `SafetyAlertsService` 的 30 分钟去重窗口兜住。
   */
  async closeStale(studentId?: number): Promise<CloseStaleResult> {
    const where = studentId === undefined ? '' : ' AND student_id = ?';
    const params = studentId === undefined ? [] : [studentId];
    const [rows] = await this.pool.execute<
      (RowDataPacket & {
        student_id: number;
        client_state: string;
        hidden_reason: string | null;
        hidden_since: Date | null;
      })[]
    >(
      `SELECT student_id, client_state, hidden_reason, hidden_since FROM study_sessions
       WHERE status = 'active' AND last_heartbeat_at < NOW(3) - INTERVAL 5 MINUTE${where}`,
      params,
    );
    const hidden: ClosedHiddenSession[] = rows
      .filter((r) => r.client_state === 'hidden' && r.hidden_reason !== null && r.hidden_since !== null)
      .map((r) => ({
        studentId: r.student_id,
        hiddenReason: r.hidden_reason as string,
        hiddenSince: r.hidden_since as Date,
      }));
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE study_sessions
       SET status = 'ended', end_reason = 'closed', ended_at = last_heartbeat_at
       WHERE status = 'active' AND last_heartbeat_at < NOW(3) - INTERVAL 5 MINUTE${where}`,
      params,
    );
    return { closedCount: result.affectedRows, hidden };
  }
}
