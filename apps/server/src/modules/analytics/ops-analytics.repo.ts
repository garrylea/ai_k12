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

/** 设备五维列（study_sessions，schema 1433-1467）。列名只从这里取，绝不来自用户输入。 */
export type DeviceCol = 'platform_class' | 'screen_class' | 'input_type' | 'app_shell' | 'browser';
export const DEVICE_COLS = [
  'platform_class', 'screen_class', 'input_type', 'app_shell', 'browser',
] as const;

/** cohort-compare 的 outcome 列：设备列（study_sessions）或 module（答题/时长两侧各有来源，见各方法 docstring）。 */
export type CompareOutcomeCol = 'module' | DeviceCol;
const COMPARE_OUTCOME_COLS: readonly CompareOutcomeCol[] = ['module', ...DEVICE_COLS];

export interface DeviceDistRow {
  key: string;
  students: number;
  seconds: number;
  sessions: number;
}

/** 时长侧分组行（totalSeconds / daysActive 数据源）。 */
export interface SessionOutcomeRow {
  key: string;
  students: number;
  seconds: number;
  /** 「学生×日期」去重数（daysActive 的分子）。 */
  studentDays: number;
}

/** 答题侧分组行（answerCount / accuracy 数据源）。 */
export interface AnswerOutcomeRow {
  key: string;
  students: number;
  answered: number;
  correct: number;
}

export interface MultiDeviceRow {
  count: number;
  students: number;
}

export interface SwitchesRow {
  count: number;
  students: number;
}

/** llm-tokens 的分组白名单（service 校验后透传；repo 再兜底拒绝）。 */
export type LlmTokenGroupBy = 'scene' | 'model' | 'day' | 'student';

export interface LlmTokenGroupRow {
  key: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  unavailableCalls: number;
}

export interface LlmTokensOverviewRow {
  attributed: number;
  unattributed: number;
  unavailableCalls: number;
}

export interface QualityApiRow {
  total: number;
  failures: number;
}

export interface ErrorCodeDistRow {
  code: number;
  count: number;
}

export interface QualityLlmRow {
  calls: number;
  timeouts: number;
  fallbacks: number;
  attributed: number;
}

export interface ContentQualityRow {
  questionsWithoutStandardAnswer: number;
  kpCovered: number;
  kpTotal: number;
  wordWrong: number;
  wordTotal: number;
}

/** /llm-calls 分页过滤。success 已由 service 解析成 1/0（缺省 undefined = 不过滤）。 */
export interface LlmCallsPageFilter {
  scene?: string;
  model?: string;
  success?: number;
  offset: number;
  limit: number;
}

/** /requests 分页过滤。status/minLatency 已由 service 解析成整数。 */
export interface RequestsPageFilter {
  path?: string;
  status?: number;
  minLatency?: number;
  offset: number;
  limit: number;
}

/** llm-tokens 分组键 → SQL 表达式（白名单内才存在，绝不拼接用户输入）。 */
const LLM_TOKEN_GROUP_EXPRS: Record<LlmTokenGroupBy, string> = {
  scene: 'scene',
  model: 'model_key',
  day: "DATE_FORMAT(created_at, '%Y-%m-%d')",
  student: 'student_id',
};

/**
 * 业务错误码缺省值：http-exception.filter 对未知错误的默认 code 是 **5000**
 * （非 5001）；api_request_logs.biz_code 为 NULL（无业务码）的失败行按 5000 归组。
 */
const DEFAULT_BIZ_CODE = 5000;

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

  /**
   * /devices 数据面：五个设备维度各一条 GROUP BY（列名来自 DEVICE_COLS 常量）。
   * 口径（brief 原文）：**不过滤 status**——与 overview/modules 的
   * `status IN ('ended','abandoned')` 不同，秒数含进行中会话已累计的 active_seconds。
   * 全部 `COUNT(DISTINCT student_id)` 按人头去重（一个学生多会话只算 1 人）。
   */
  async deviceDistributions(w: OpsWindow): Promise<Record<DeviceCol, DeviceDistRow[]>> {
    const all = await Promise.all(
      DEVICE_COLS.map(async (col) => {
        const [rows] = await this.pool.query<RowDataPacket[]>(
          `SELECT ${col} AS k,
                  COUNT(DISTINCT student_id) AS students,
                  COALESCE(SUM(active_seconds), 0) AS seconds,
                  COUNT(*) AS sessions
             FROM study_sessions
            WHERE started_at >= ? AND started_at < ? AND ${col} IS NOT NULL
            GROUP BY ${col}
            ORDER BY students DESC`,
          [w.fromAt, w.toAt],
        );
        return rows.map((r) => ({
          key: String(r.k),
          students: Number(r.students),
          seconds: Number(r.seconds),
          sessions: Number(r.sessions),
        }));
      }),
    );
    return Object.fromEntries(DEVICE_COLS.map((col, i) => [col, all[i]])) as Record<
      DeviceCol,
      DeviceDistRow[]
    >;
  }

  /**
   * 答题侧按 outcome 分组。`/devices` 的 platformClass accuracy 与 cohort-compare 的
   * answerCount/accuracy 共用本方法。
   *
   * - outcome='module'：behavior_events 原生 module 列直接 GROUP BY（答题侧口径）。
   * - outcome=设备列：behavior_events 无设备列，**按学生近似**——「窗口内用过该设备类的
   *   学生，其窗口内全部 answer_submitted」计入该组（docstring 口径即 brief 裁决原文；
   *   实现等价于对每组 `student_id IN (SELECT DISTINCT student_id FROM study_sessions
   *   WHERE 设备列 = ?)`，JOIN 写法一次查完所有组）。学生用过多个设备类时，其答题
   *   会同时计入多组（重叠分组，非互斥）。
   */
  async answersByOutcome(w: OpsWindow, outcome: CompareOutcomeCol): Promise<AnswerOutcomeRow[]> {
    if (!COMPARE_OUTCOME_COLS.includes(outcome)) {
      throw new Error(`非法 outcome 列：${String(outcome)}`);
    }
    if (outcome === 'module') {
      const [rows] = await this.pool.query<RowDataPacket[]>(
        `SELECT module AS k,
                COUNT(DISTINCT student_id) AS students,
                COUNT(*) AS answered,
                COALESCE(SUM(props->>'$.verdict' = 'correct'), 0) AS correct
           FROM behavior_events
          WHERE event = 'answer_submitted' AND module IS NOT NULL
            AND created_at >= ? AND created_at < ?
          GROUP BY module`,
        [w.fromAt, w.toAt],
      );
      return rows.map((r) => ({
        key: String(r.k),
        students: Number(r.students),
        answered: Number(r.answered),
        correct: Number(r.correct),
      }));
    }
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT p.k,
              COUNT(DISTINCT be.student_id) AS students,
              COUNT(*) AS answered,
              COALESCE(SUM(be.props->>'$.verdict' = 'correct'), 0) AS correct
         FROM behavior_events be
         JOIN (SELECT DISTINCT student_id, ${outcome} AS k
                 FROM study_sessions
                WHERE started_at >= ? AND started_at < ? AND ${outcome} IS NOT NULL) p
           ON p.student_id = be.student_id
        WHERE be.event = 'answer_submitted' AND be.created_at >= ? AND be.created_at < ?
        GROUP BY p.k`,
      [w.fromAt, w.toAt, w.fromAt, w.toAt],
    );
    return rows.map((r) => ({
      key: String(r.k),
      students: Number(r.students),
      answered: Number(r.answered),
      correct: Number(r.correct),
    }));
  }

  /**
   * 时长侧按 outcome 分组（cohort-compare 的 totalSeconds / daysActive 数据面）。
   * outcome='module' 取 study_sessions.module（时长侧口径，与答题侧 behavior_events.module 各自独立）。
   * daysActive 分子按「学生×日期」去重：`COUNT(DISTINCT student_id, DATE(started_at))`。
   */
  async sessionsByOutcome(w: OpsWindow, outcome: CompareOutcomeCol): Promise<SessionOutcomeRow[]> {
    if (!COMPARE_OUTCOME_COLS.includes(outcome)) {
      throw new Error(`非法 outcome 列：${String(outcome)}`);
    }
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT ${outcome} AS k,
              COUNT(DISTINCT student_id) AS students,
              COALESCE(SUM(active_seconds), 0) AS seconds,
              COUNT(DISTINCT student_id, DATE(started_at)) AS student_days
         FROM study_sessions
        WHERE started_at >= ? AND started_at < ? AND ${outcome} IS NOT NULL
        GROUP BY ${outcome}`,
      [w.fromAt, w.toAt],
    );
    return rows.map((r) => ({
      key: String(r.k),
      students: Number(r.students),
      seconds: Number(r.seconds),
      studentDays: Number(r.student_days),
    }));
  }

  /**
   * 多设备分档：窗口内用过 >1 种 platform_class 的学生，按档位（cnt）计人头。
   * platform_class 为 NULL 的会话不参与 DISTINCT 计数。
   */
  async multiDevice(w: OpsWindow): Promise<MultiDeviceRow[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT t.cnt, COUNT(*) AS students
         FROM (SELECT student_id, COUNT(DISTINCT platform_class) AS cnt
                 FROM study_sessions
                WHERE started_at >= ? AND started_at < ?
                GROUP BY student_id
               HAVING cnt > 1) t
        GROUP BY t.cnt
        ORDER BY t.cnt ASC`,
      [w.fromAt, w.toAt],
    );
    return rows.map((r) => ({ count: Number(r.cnt), students: Number(r.students) }));
  }

  /**
   * 设备切换：相邻两次会话（s2 = 该学生在 s1 之后最早的一列）platform_class 不同即一次切换。
   * s2 用 `started_at > s1.started_at` 严格大于——秒级同刻并发的极端场景不计（brief 认可）。
   * platform_class 为 NULL 的会话不参与（`NULL <> x` 为 NULL 被过滤）。
   */
  async switches(w: OpsWindow): Promise<SwitchesRow> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS cnt, COUNT(DISTINCT s1.student_id) AS students
         FROM study_sessions s1
         JOIN study_sessions s2
           ON s1.student_id = s2.student_id AND s2.started_at > s1.started_at
          AND s2.id = (SELECT MIN(m.id) FROM study_sessions m
                        WHERE m.student_id = s1.student_id AND m.started_at > s1.started_at)
        WHERE s1.started_at >= ? AND s1.started_at < ?
          AND s1.platform_class <> s2.platform_class`,
      [w.fromAt, w.toAt],
    );
    const r = rows[0] ?? {};
    return { count: Number(r.cnt ?? 0), students: Number(r.students ?? 0) };
  }

  /**
   * retention 的 cohort：首活跃日 = cohortStart（当日）的学生 id 集
   * （brief 口径：`MIN(DATE(started_at)) = cohortStart`）。
   */
  async retentionCohort(cohortStart: string): Promise<number[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT student_id, MIN(DATE(started_at)) AS first_day
         FROM study_sessions
        GROUP BY student_id
       HAVING first_day = ?`,
      [cohortStart],
    );
    return rows.map((r) => Number(r.student_id));
  }

  /**
   * retention 的 D{n}：cohort 学生在 dayAt~dayNextAt（应用层算好的当日边界，左闭右开）
   * 有会话的人头数。`IN (?)` 数组由 pool.query 展开（勿改 execute）。
   */
  async retentionDay(cohortIds: number[], dayAt: string, dayNextAt: string): Promise<number> {
    if (cohortIds.length === 0) return 0;
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT COUNT(DISTINCT student_id) AS retained
         FROM study_sessions
        WHERE student_id IN (?) AND started_at >= ? AND started_at < ?`,
      [cohortIds, dayAt, dayNextAt],
    );
    return Number(rows[0]?.retained ?? 0);
  }

  /**
   * /llm-tokens 分组行（Task 11）。分组键按 groupBy 白名单切换（LLM_TOKEN_GROUP_EXPRS），
   * 聚合按 `model_key`（路由条目 key，**不是** model_id）。
   *
   * NULL 语义仓规：input_tokens/output_tokens 只对 `usage_source <> 'unavailable'`
   * 的行求和——量不到（unavailable）的调用单列 `unavailable_calls`，**绝不混进 0 求和**
   * （delta spec §7 表 7：items[].unavailableCalls = 该 key 下量不到的调用数）。
   * day 键用 DATE_FORMAT 直接回字符串（避免 mysql2 把 DATE() 转成本地时区 Date）。
   * key 为 NULL 的组（scene 未知 / 无归因）映射为 'unknown' / 'unattributed'。
   */
  async llmTokenGroups(w: OpsWindow, groupBy: LlmTokenGroupBy): Promise<LlmTokenGroupRow[]> {
    const expr = LLM_TOKEN_GROUP_EXPRS[groupBy];
    if (!expr) throw new Error(`非法 llm-tokens groupBy：${String(groupBy)}`);
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT ${expr} AS grp,
              COUNT(*) AS calls,
              COALESCE(SUM(CASE WHEN usage_source <> 'unavailable' THEN input_tokens END), 0) AS input_tokens,
              COALESCE(SUM(CASE WHEN usage_source <> 'unavailable' THEN output_tokens END), 0) AS output_tokens,
              SUM(usage_source = 'unavailable') AS unavailable_calls
         FROM llm_call_logs
        WHERE created_at >= ? AND created_at < ?
        GROUP BY ${expr}
        ORDER BY calls DESC`,
      [w.fromAt, w.toAt],
    );
    return rows.map((r) => ({
      key: r.grp === null ? (groupBy === 'student' ? 'unattributed' : 'unknown') : String(r.grp),
      calls: Number(r.calls),
      inputTokens: Number(r.input_tokens ?? 0),
      outputTokens: Number(r.output_tokens ?? 0),
      unavailableCalls: Number(r.unavailable_calls ?? 0),
    }));
  }

  /** /llm-tokens 顶层总览：归因 / 未归因 / 量不到（与分组行同一窗口、独立一条 SQL）。 */
  async llmTokensOverview(w: OpsWindow): Promise<LlmTokensOverviewRow> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT COALESCE(SUM(student_id IS NOT NULL), 0) AS attributed,
              COALESCE(SUM(student_id IS NULL), 0) AS unattributed,
              COALESCE(SUM(usage_source = 'unavailable'), 0) AS unavailable_calls
         FROM llm_call_logs
        WHERE created_at >= ? AND created_at < ?`,
      [w.fromAt, w.toAt],
    );
    const r = rows[0] ?? {};
    return {
      attributed: Number(r.attributed ?? 0),
      unattributed: Number(r.unattributed ?? 0),
      unavailableCalls: Number(r.unavailable_calls ?? 0),
    };
  }

  /**
   * /quality 的 API 失败面：失败口径 = HTTP 5xx 或 biz_code 非 NULL。
   * 写入方语义（analytics.interceptor）：成功 2xx 行 biz_code 恒为 NULL（拦截器读不到最终响应体），
   * 只有异常路径才写数值 biz_code，全表没有 biz_code=0 的行 —— 所以失败判定用
   * `biz_code IS NOT NULL`，不能用 `COALESCE(biz_code, 5000) <> 0`（会把成功行全判失败）。
   * biz_code 非 NULL 的行在 errorCodeDistribution 里按其值归组；纯 5xx（biz_code NULL）归 5000。
   */
  async qualityApi(w: OpsWindow): Promise<QualityApiRow> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(status_code >= 500 OR biz_code IS NOT NULL), 0) AS failures
         FROM api_request_logs
        WHERE created_at >= ? AND created_at < ?`,
      [w.fromAt, w.toAt],
    );
    const r = rows[0] ?? {};
    return { total: Number(r.total ?? 0), failures: Number(r.failures ?? 0) };
  }

  /** /quality 的错误码分布：只统计失败行（5xx 或 biz_code 非 NULL），biz_code NULL 按 5000 归组。 */
  async qualityErrorCodes(w: OpsWindow): Promise<ErrorCodeDistRow[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT COALESCE(biz_code, ${DEFAULT_BIZ_CODE}) AS code, COUNT(*) AS cnt
         FROM api_request_logs
        WHERE created_at >= ? AND created_at < ?
          AND (status_code >= 500 OR biz_code IS NOT NULL)
        GROUP BY code
        ORDER BY cnt DESC`,
      [w.fromAt, w.toAt],
    );
    return rows.map((r) => ({ code: Number(r.code), count: Number(r.cnt) }));
  }

  /**
   * /quality 的 LLM 面。超时口径：llm_call_logs 的实际列是 `error_type`
   * （LLMClientError 子类名），超时值为 'TimeoutError'（网络错误也被 client 归一为它）。
   */
  async qualityLlm(w: OpsWindow): Promise<QualityLlmRow> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(error_type = 'TimeoutError'), 0) AS timeouts,
              COALESCE(SUM(is_fallback), 0) AS fallbacks,
              COALESCE(SUM(student_id IS NOT NULL), 0) AS attributed
         FROM llm_call_logs
        WHERE created_at >= ? AND created_at < ?`,
      [w.fromAt, w.toAt],
    );
    const r = rows[0] ?? {};
    return {
      calls: Number(r.calls ?? 0),
      timeouts: Number(r.timeouts ?? 0),
      fallbacks: Number(r.fallbacks ?? 0),
      attributed: Number(r.attributed ?? 0),
    };
  }

  /**
   * /quality 的内容库三指标（无窗口——内容是存量库，不是埋点流）。
   *
   * 口径按 schema.sql 实际结构定（计划里的 `questions LEFT JOIN answers` 不成立：
   * answers 是**学生作答**表，不是标准答案）：
   * - questionsWithoutStandardAnswer：questions.answer 为空白（列 NOT NULL，空串 = 未导入标准答案）；
   * - kpCoverage：EXISTS(question_knowledge_points) 的题 / 总题；
   * - globalWordErrorRate：english_words 累计错次 SUM(error_count) 与词数 COUNT(*)。
   */
  async contentQuality(): Promise<ContentQualityRow> {
    const [noStdRows, kpRows, wordRows] = await Promise.all([
      this.pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS cnt FROM questions WHERE TRIM(answer) = ''`,
      ),
      this.pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(EXISTS(SELECT 1 FROM question_knowledge_points qkp
                                     WHERE qkp.question_id = q.id)), 0) AS covered
           FROM questions q`,
      ),
      this.pool.query<RowDataPacket[]>(
        `SELECT COALESCE(SUM(error_count), 0) AS wrong, COUNT(*) AS total FROM english_words`,
      ),
    ]);
    const noStd = noStdRows[0][0] ?? {};
    const kp = kpRows[0][0] ?? {};
    const word = wordRows[0][0] ?? {};
    return {
      questionsWithoutStandardAnswer: Number(noStd.cnt ?? 0),
      kpCovered: Number(kp.covered ?? 0),
      kpTotal: Number(kp.total ?? 0),
      wordWrong: Number(word.wrong ?? 0),
      wordTotal: Number(word.total ?? 0),
    };
  }

  /** /llm-calls 分页：COUNT + SELECT 两条 SQL，动态条件只拼占位符（见 eventsPage 同款纪律）。 */
  async llmCallsPage(q: LlmCallsPageFilter): Promise<{ rows: RowDataPacket[]; total: number }> {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (q.scene !== undefined) {
      conds.push('scene = ?');
      params.push(q.scene);
    }
    if (q.model !== undefined) {
      conds.push('model_key = ?');
      params.push(q.model);
    }
    if (q.success !== undefined) {
      conds.push('success = ?');
      params.push(q.success);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const [countRows, rows] = await Promise.all([
      this.pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS total FROM llm_call_logs ${where}`,
        params,
      ),
      this.pool.query<RowDataPacket[]>(
        `SELECT * FROM llm_call_logs ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...params, q.limit, q.offset],
      ),
    ]);
    return { rows: rows[0], total: Number(countRows[0][0]?.total ?? 0) };
  }

  /** /requests 分页：route 用 LIKE（raw_path 才带真实 id，归一化模板才是检索面）。 */
  async requestsPage(q: RequestsPageFilter): Promise<{ rows: RowDataPacket[]; total: number }> {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (q.path !== undefined) {
      conds.push('route LIKE ?');
      params.push(`%${q.path}%`);
    }
    if (q.status !== undefined) {
      conds.push('status_code = ?');
      params.push(q.status);
    }
    if (q.minLatency !== undefined) {
      conds.push('latency_ms >= ?');
      params.push(q.minLatency);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const [countRows, rows] = await Promise.all([
      this.pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS total FROM api_request_logs ${where}`,
        params,
      ),
      this.pool.query<RowDataPacket[]>(
        `SELECT * FROM api_request_logs ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...params, q.limit, q.offset],
      ),
    ]);
    return { rows: rows[0], total: Number(countRows[0][0]?.total ?? 0) };
  }
}
