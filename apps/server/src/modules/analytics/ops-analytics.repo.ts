import { Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

/**
 * 时间窗 + 「今日」边界。全部由 service 应用层算好再传参——
 * **SQL 内禁 CURDATE/NOW 做任何边界**（DB 时区与应用层可能差一天，母 spec §7 通用纪律）。
 */
export interface OpsWindow {
  /** 窗口起点（含），'YYYY-MM-DD HH:mm:ss'。 */
  fromAt: string;
  /** 窗口终点（不含），= to + 1 天 00:00:00（左闭右开）。 */
  toAt: string;
  /** 今日 00:00:00。DAU 专用口径（与查询窗口无关），见 overviewSessions。 */
  todayAt: string;
  /** 明日 00:00:00（= todayAt + 1 天），DAU 上界。 */
  tomorrowAt: string;
}

export interface OverviewSessionsRow {
  /** 今日（todayAt 当天）有会话的学生数，不限 status。 */
  dau: number;
  /** 窗口内 DISTINCT student_id（WAU 口径，status IN ended/abandoned）。 */
  students: number;
  /** 窗口内 SUM(active_seconds)。 */
  totalSeconds: number;
}

export interface AnswerTotalsRow {
  answered: number;
  correct: number;
}

export interface ModuleUsageRow {
  module: string;
  students: number;
  seconds: number;
}

export interface ModuleWindowRow {
  module: string;
  students: number;
  seconds: number;
  sessions: number;
  answered: number;
  correct: number;
}

/** 漏斗单步过滤：`event = ?` 之外的条件（占位符形式 + 按序参数），由 service 组装。 */
export interface FunnelStepFilter {
  event: string;
  extraWhere?: string;
  extraParams?: unknown[];
}

/** /events 分页查询（全部 tier，不按 tier 过滤）。 */
export interface EventsPageFilter {
  event?: string;
  module?: string;
  fromAt: string;
  toAt: string;
  offset: number;
  limit: number;
}

/**
 * 运营聚合只读 SQL（Phase 2 母 spec §7，Task 8：overview / modules 两个端点的数据面）。
 *
 * **聚合 SQL 一律 `pool.query` 不用 `execute`**（LIMIT ? 占位在 execute 下被 MySQL 拒执行，
 * 全仓护栏测试盯着，见 project 教训）。
 *
 * **答题口径取舍（2026-10-09 用户裁决）**：answered / correct **只取
 * `behavior_events.answer_submitted`**（Phase 2 上线后才开始有数），
 * `special_practice_logs` **不并入**——behavior_events 无行的模块 answered=0、
 * accuracy 由 service 置 null。正确数取 `props->>'$.verdict' = 'correct'`
 * （judge-core 打点把 verdict/isCorrect/method 放在 props JSON，表上没有 is_correct 列）。
 */
export class OpsAnalyticsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /**
   * overview 的会话面。两条独立查询：DAU 是「今日」口径（与窗口无关），
   * WAU/时长是窗口口径——一条 SQL 做不了（WHERE 先行会把另一口径的行滤掉）。
   */
  async overviewSessions(w: OpsWindow): Promise<OverviewSessionsRow> {
    const [dauRows, winRows] = await Promise.all([
      this.pool.query<RowDataPacket[]>(
        `SELECT COUNT(DISTINCT student_id) AS dau
           FROM study_sessions
          WHERE started_at >= ? AND started_at < ?`,
        [w.todayAt, w.tomorrowAt],
      ),
      this.pool.query<RowDataPacket[]>(
        `SELECT COUNT(DISTINCT student_id) AS students,
                COALESCE(SUM(active_seconds), 0) AS total_seconds
           FROM study_sessions
          WHERE status IN ('ended','abandoned') AND started_at >= ? AND started_at < ?`,
        [w.fromAt, w.toAt],
      ),
    ]);
    const dau = Number(dauRows[0][0]?.dau ?? 0);
    const win = winRows[0][0] ?? {};
    return { dau, students: Number(win.students ?? 0), totalSeconds: Number(win.total_seconds ?? 0) };
  }

  /** 窗口内总答题 / 总答对（口径见类注释；module 为 NULL 的事件也计入总数）。 */
  async answerTotals(w: OpsWindow): Promise<AnswerTotalsRow> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS answered,
              COALESCE(SUM(props->>'$.verdict' = 'correct'), 0) AS correct
         FROM behavior_events
        WHERE event = 'answer_submitted' AND created_at >= ? AND created_at < ?`,
      [w.fromAt, w.toAt],
    );
    const r = rows[0] ?? {};
    return { answered: Number(r.answered ?? 0), correct: Number(r.correct ?? 0) };
  }

  /** overview 的模块 Top：窗口内按 module 汇总人数/时长，按时长倒序取前 5。 */
  async moduleTop(w: OpsWindow, limit = 5): Promise<ModuleUsageRow[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT module,
              COUNT(DISTINCT student_id) AS students,
              COALESCE(SUM(active_seconds), 0) AS seconds
         FROM study_sessions
        WHERE status IN ('ended','abandoned') AND started_at >= ? AND started_at < ?
        GROUP BY module
        ORDER BY seconds DESC
        LIMIT ?`,
      [w.fromAt, w.toAt, limit],
    );
    return rows.map((r) => ({
      module: String(r.module),
      students: Number(r.students),
      seconds: Number(r.seconds),
    }));
  }

  /**
   * /modules 的数据面：窗口内按 module 汇总会话（人数/时长/会话数）+ 答题（behavior_events），
   * 两侧按 module 并集合并后按时长倒序。behavior_events 里 module 为 NULL 的行
   * 无法归入任何模块，**不进本列表**（总量口径在 answerTotals，不受影响）。
   */
  async modulesWindow(w: OpsWindow): Promise<ModuleWindowRow[]> {
    const [sessRows, evRows] = await Promise.all([
      this.pool.query<RowDataPacket[]>(
        `SELECT module,
                COUNT(DISTINCT student_id) AS students,
                COALESCE(SUM(active_seconds), 0) AS seconds,
                COUNT(*) AS sessions
           FROM study_sessions
          WHERE status IN ('ended','abandoned') AND started_at >= ? AND started_at < ?
          GROUP BY module`,
        [w.fromAt, w.toAt],
      ),
      this.pool.query<RowDataPacket[]>(
        `SELECT module,
                COUNT(*) AS answered,
                COALESCE(SUM(props->>'$.verdict' = 'correct'), 0) AS correct
           FROM behavior_events
          WHERE event = 'answer_submitted' AND created_at >= ? AND created_at < ?
          GROUP BY module`,
        [w.fromAt, w.toAt],
      ),
    ]);

    const byModule = new Map<string, ModuleWindowRow>();
    for (const r of sessRows[0]) {
      byModule.set(String(r.module), {
        module: String(r.module),
        students: Number(r.students),
        seconds: Number(r.seconds),
        sessions: Number(r.sessions),
        answered: 0,
        correct: 0,
      });
    }
    for (const r of evRows[0]) {
      if (r.module === null) continue;
      const key = String(r.module);
      const row = byModule.get(key) ?? {
        module: key, students: 0, seconds: 0, sessions: 0, answered: 0, correct: 0,
      };
      row.answered = Number(r.answered);
      row.correct = Number(r.correct);
      byModule.set(key, row);
    }
    return [...byModule.values()].sort(
      (a, b) => b.seconds - a.seconds || a.module.localeCompare(b.module),
    );
  }

  /**
   * /funnel 数据面：窗口内按「每步条件」统计去重人数，GROUP BY event 一次查完。
   * 每步条件 = `event = ?` + 该步额外条件（见 FunnelStepFilter）——
   * mainline 第三步（完课发分）按 ★裁决走 `module IS NULL AND props->>'$.taskCode' = ?`，
   * 所以不能用一条 `module = ?` 一刀切，必须每步独立 OR 分支。
   */
  async funnel(w: OpsWindow, steps: FunnelStepFilter[]): Promise<Map<string, number>> {
    if (steps.length === 0) return new Map();
    const stepConds = steps.map((s) => `(event = ?${s.extraWhere ? ` AND ${s.extraWhere}` : ''})`);
    const params: unknown[] = [w.fromAt, w.toAt];
    for (const s of steps) params.push(s.event, ...(s.extraParams ?? []));
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT event, COUNT(DISTINCT student_id) AS students
         FROM behavior_events
        WHERE student_id IS NOT NULL AND created_at >= ? AND created_at < ?
          AND ${stepConds.join(' OR ')}
        GROUP BY event`,
      params,
    );
    const byEvent = new Map<string, number>();
    for (const r of rows) byEvent.set(String(r.event), Number(r.students));
    return byEvent;
  }

  /**
   * /events 数据面：COUNT + SELECT 两条 SQL；动态条件拼占位符数组
   * （条件存在才拼，绝不字符串插值用户输入——注入面）。不过滤 tier（delta spec 裁决 3）。
   */
  async eventsPage(q: EventsPageFilter): Promise<{ rows: RowDataPacket[]; total: number }> {
    const conds = ['created_at >= ?', 'created_at < ?'];
    const params: unknown[] = [q.fromAt, q.toAt];
    if (q.event !== undefined) {
      conds.push('event = ?');
      params.push(q.event);
    }
    if (q.module !== undefined) {
      conds.push('module = ?');
      params.push(q.module);
    }
    const where = conds.join(' AND ');
    const [countRows, rows] = await Promise.all([
      this.pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS total FROM behavior_events WHERE ${where}`,
        params,
      ),
      this.pool.query<RowDataPacket[]>(
        `SELECT * FROM behavior_events WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...params, q.limit, q.offset],
      ),
    ]);
    return { rows: rows[0], total: Number(countRows[0][0]?.total ?? 0) };
  }
}
