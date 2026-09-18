import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

/** 按学科的答题量与答对数（已排除空答案与学生自评）。 */
export interface AccuracyRow {
  subjectId: number;
  answered: number;
  correct: number;
}

/** 按学科的学生自评统计（主观题，**不进正确率**，单独出数）。 */
export interface SelfAssessRow {
  subjectId: number;
  count: number;
  correctCount: number;
}

/** 按学科的计数行（考试场次等）。 */
export interface SubjectCountRow {
  subjectId: number;
  count: number;
}

/** 按学科的错题本统计（累计）。 */
export interface ErrorBookSummaryRow {
  subjectId: number;
  uncleared: number;
  total: number;
}

/**
 * 薄弱点（**错题数代理**，不是掌握度）。
 *
 * 实测只有约 40% 的错题能映射到知识点（`question_knowledge_points` 由 migration 灌入，
 * 覆盖不完整），所以必须配合 `countUncoveredUnclearedErrors` 一起展示，否则家长会以为
 * 「只有这些问题」。真掌握度需要写 `student_knowledge_mastery`，不属本批。
 */
export interface WeakPointRow {
  knowledgePointId: number;
  name: string;
  unclearedCount: number;
  totalWrongCount: number;
}

/** 按天的答题量与答对数（报告页折线）。只含有记录的天。 */
export interface TrendRow {
  date: string;
  answered: number;
  correct: number;
}

/** 已交卷考试的摘要行（报告页考试记录）。客观题数 = 已判对错的题数。 */
export interface ExamSummaryRow {
  sessionId: number;
  paperTitle: string;
  subjectId: number;
  submittedAt: Date;
  correctCount: number;
  objectiveCount: number;
}

/**
 * 家长端只读聚合仓储（spec `2026-09-18-parent-insights-design.md`）。
 *
 * 三条铁律（勿违背）：
 * 1. **只读**：本文件不出现 INSERT / UPDATE / DELETE。
 * 2. **既有的共享仓储一行不动**（如 `main-error-books.repo.ts` 正被训练轨调用），
 *    需要类似查询就在这里照抄写法自建。
 * 3. 带 `LIMIT ?` 的查询必须用 `pool.query`（客户端转义）：MySQL 对预处理语句的
 *    `LIMIT ?` 报 "Incorrect arguments to mysqld_stmt_execute"（见 point-ledger.repo.ts:148 的既有注释）。
 *    其余用 `execute`。
 *
 * 返回一律是**扁平行**，嵌套 DTO 由各 service 组装（与 `point-ledger.repo.ts` 同约定）。
 */
@Injectable()
export class ParentInsightsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /**
   * 该学生已开始学习的学科 id，升序去重。仪表盘只为这些学科出卡片。
   *
   * 判定用 `status <> 'not_started'`，**不能**用「存在 progress 行」——行存在 ≠ 已开始：
   * 家长在「学习配置」里配教材会走 `ProgressRepository.createConfig`
   * （progress.repo.ts:62-75，写入 status='not_started'、current_lesson_id=NULL），
   * `applyConfig(reset=true)`（progress.repo.ts:83-92）也会把已有行重置回 not_started。
   * 若只看行存在，这两个场景会给「只配过教材、根本没开始学」的学科渲染卡片。
   *
   * 也不用 `started_at IS NOT NULL`：`ProgressRepository.create`（progress.repo.ts:44-59）
   * 是学生首次学习时的自动初始化（status='in_progress'、current_lesson_id 已设），
   * 但它**不写 started_at**（该列为 NULL 默认值），用它会把真正已开始的学科漏掉。
   * status 是唯一在所有写入路径下都可靠的谓词（create/adoptLesson→in_progress，
   * createConfig/applyConfig reset→not_started，markCompleted→completed）。
   */
  async listTrackedSubjectIds(studentId: number): Promise<number[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT DISTINCT subject_id FROM progress
       WHERE student_id = ? AND status <> 'not_started'
       ORDER BY subject_id`,
      [studentId],
    );
    return rows.map((r) => Number(r.subject_id));
  }

  /**
   * 四路活跃来源的**唯一构造器**。`lastActiveAt`（全时段）与 `activeDays`（窗口内）
   * 共用它，增删活跃来源只改这一处，避免两个指标口径分叉。
   *
   * `windowStart` 省略 = 全时段（不加时间下界）；给出 = 每条支路追加 `<ts> >= ?`。
   * 参数按支路顺序追加：每支先 studentId，有窗口再追加 windowStart。
   */
  private buildActivitySources(
    studentId: number,
    windowStart?: Date,
  ): { sql: string; params: (number | Date)[] } {
    const params: (number | Date)[] = [];
    /** 拼一条支路的 WHERE：始终带 studentId；有窗口时追加该支路自己的时间列下界。 */
    const where = (base: string, tsColumn: string): string => {
      params.push(studentId);
      if (windowStart == null) return base;
      params.push(windowStart);
      return `${base} AND ${tsColumn} >= ?`;
    };

    const sql = [
      `SELECT judged_at AS ts FROM practice_results WHERE ${where('student_id = ?', 'judged_at')}`,
      `UNION ALL SELECT created_at AS ts FROM point_ledger WHERE ${where('student_id = ?', 'created_at')}`,
      `UNION ALL SELECT submitted_at AS ts FROM exam_sessions WHERE ${where(
        'student_id = ? AND submitted_at IS NOT NULL',
        'submitted_at',
      )}`,
      `UNION ALL SELECT m.created_at AS ts FROM ai_messages m
         JOIN ai_dialogues d ON d.id = m.dialogue_id
         WHERE ${where('d.student_id = ? AND m.deleted_at IS NULL', 'm.created_at')}`,
    ].join('\n');

    return { sql, params };
  }

  /**
   * 活跃度（「学习时长」的代理指标，spec §2.2）。
   *
   * 「活跃」= 下列四张表任一在该时刻有记录。四条并集路径的理由：`point_ledger` 是唯一在
   * **所有**轨道任务完成时都写一行的表（含语文/英语专项），光靠它 + `practice_results` +
   * `exam_sessions` 会漏掉纯答疑活跃，故补 `ai_messages`。
   *
   * `lastActiveAt` 是**全时段** MAX、`activeDays` 只数 `windowStart` 之后——两者窗口不同，
   * 必须分两次查，合并成一个 SQL 会算错。两次查共用 `buildActivitySources`。
   */
  async getActivitySummary(
    studentId: number,
    windowStart: Date,
  ): Promise<{ lastActiveAt: Date | null; activeDays: number }> {
    const allTime = this.buildActivitySources(studentId);
    const [maxRows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT MAX(ts) AS last_active_at FROM (
${allTime.sql}
) t`,
      allTime.params,
    );

    const windowed = this.buildActivitySources(studentId, windowStart);
    const [dayRows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT COUNT(DISTINCT DATE(ts)) AS active_days FROM (
${windowed.sql}
) t`,
      windowed.params,
    );

    const raw = maxRows[0]?.last_active_at;
    return {
      lastActiveAt: raw ? new Date(raw as string | Date) : null,
      activeDays: Number(dayRows[0]?.active_days ?? 0),
    };
  }

  /**
   * 正确率（spec §4.3，**本批唯一实现，勿分散**）：`practice_results` + `exam_answers` 两源合并。
   *
   * 口径（最容易被「统一」掉的地方，测试钉死）：
   * - `practice_results` 排除 `method IN ('unanswered','self_assess')`——空答案守卫与学生自评
   *   都会落行，朴素 `AVG(is_correct)` 会把「没答」算成错。
   * - `exam_answers` 排除 `is_correct IS NULL`（主观题 self_assess 模式落 NULL = 不判对错）。
   *
   * 窗口可选：`from`/`to` 都不传 = 累计（仪表盘）；都传 = 窗口（报告页）。**一套 SQL 按参数
   * 拼条件**，不写两份，否则口径必然分叉。`to` 是半开区间上界（service 传「末日 + 1 天」）。
   */
  async getAccuracyBySubject(studentId: number, from?: Date, to?: Date): Promise<AccuracyRow[]> {
    const windowed = from !== undefined && to !== undefined;
    const practiceWindow = windowed ? ' AND judged_at >= ? AND judged_at < ?' : '';
    const examWindow = windowed ? ' AND ea.judged_at >= ? AND ea.judged_at < ?' : '';
    const params: (number | Date)[] = windowed
      ? [studentId, from, to, studentId, from, to]
      : [studentId, studentId];

    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT subject_id, SUM(total) AS answered, SUM(correct) AS correct FROM (
         SELECT subject_id, SUM(is_correct = 1) AS correct, COUNT(*) AS total
         FROM practice_results
         WHERE student_id = ? AND method IN ('exact','ai')${practiceWindow}
         GROUP BY subject_id
         UNION ALL
         SELECT es.subject_id, SUM(ea.is_correct = 1) AS correct, COUNT(*) AS total
         FROM exam_sessions es JOIN exam_answers ea ON ea.session_id = es.id
         WHERE es.student_id = ? AND es.status = 'submitted' AND ea.is_correct IS NOT NULL${examWindow}
         GROUP BY es.subject_id
       ) t
       GROUP BY subject_id
       ORDER BY subject_id`,
      params,
    );
    return rows.map((r) => ({
      subjectId: Number(r.subject_id),
      answered: Number(r.answered ?? 0),
      correct: Number(r.correct ?? 0),
    }));
  }

  /** 学生自评（主观题）按学科统计。`assessment = 'correct'` 才计入 correctCount。 */
  async getSelfAssessBySubject(
    studentId: number,
    from?: Date,
    to?: Date,
  ): Promise<SelfAssessRow[]> {
    const windowed = from !== undefined && to !== undefined;
    const window = windowed ? ' AND qsa.created_at >= ? AND qsa.created_at < ?' : '';
    const params: (number | Date)[] = windowed ? [studentId, from, to] : [studentId];

    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT q.subject_id,
              COUNT(*) AS count,
              SUM(qsa.assessment = 'correct') AS correct_count
       FROM question_self_assessments qsa
       JOIN questions q ON q.id = qsa.question_id
       WHERE qsa.student_id = ?${window}
       GROUP BY q.subject_id
       ORDER BY q.subject_id`,
      params,
    );
    return rows.map((r) => ({
      subjectId: Number(r.subject_id),
      count: Number(r.count ?? 0),
      correctCount: Number(r.correct_count ?? 0),
    }));
  }

  /** 已交卷的考试场次按学科计数。窗口按 `submitted_at`。 */
  async getExamCounts(studentId: number, from?: Date, to?: Date): Promise<SubjectCountRow[]> {
    const windowed = from !== undefined && to !== undefined;
    const window = windowed ? ' AND submitted_at >= ? AND submitted_at < ?' : '';
    const params: (number | Date)[] = windowed ? [studentId, from, to] : [studentId];

    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT subject_id, COUNT(*) AS count
       FROM exam_sessions
       WHERE student_id = ? AND status = 'submitted'${window}
       GROUP BY subject_id
       ORDER BY subject_id`,
      params,
    );
    return rows.map((r) => ({ subjectId: Number(r.subject_id), count: Number(r.count ?? 0) }));
  }

  /** 错题本「未清零 / 总数」按学科统计（累计，不按时间窗）。 */
  async getErrorBookSummary(studentId: number): Promise<ErrorBookSummaryRow[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT subject_id,
              SUM(is_cleared = 0) AS uncleared,
              COUNT(*) AS total
       FROM main_error_books
       WHERE student_id = ?
       GROUP BY subject_id
       ORDER BY subject_id`,
      [studentId],
    );
    return rows.map((r) => ({
      subjectId: Number(r.subject_id),
      uncleared: Number(r.uncleared ?? 0),
      total: Number(r.total ?? 0),
    }));
  }

  /** 窗口内「新增错题」与「清零错题」条数（报告页 stats）。 */
  async getErrorDateCounts(
    studentId: number,
    from: Date,
    to: Date,
  ): Promise<{ added: number; cleared: number }> {
    const [addedRows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS added FROM main_error_books
       WHERE student_id = ? AND created_at >= ? AND created_at < ?`,
      [studentId, from, to],
    );
    const [clearedRows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS cleared FROM main_error_books
       WHERE student_id = ? AND is_cleared = 1 AND cleared_at >= ? AND cleared_at < ?`,
      [studentId, from, to],
    );
    return {
      added: Number(addedRows[0]?.added ?? 0),
      cleared: Number(clearedRows[0]?.cleared ?? 0),
    };
  }

  /**
   * 薄弱点 Top N：按「未清零错题数」聚合知识点。
   *
   * 统计**全部未清零错题**（不按时间窗）——「现在还剩哪些没清」才是家长关心的。
   * 只覆盖 `question_id` 非空且已绑 KP 的错题，未覆盖部分由
   * `countUncoveredUnclearedErrors` 兜住。
   */
  async getWeakPoints(studentId: number, limit: number): Promise<WeakPointRow[]> {
    // LIMIT ? 必须用 pool.query（客户端转义），用 execute 会被 MySQL 拒绝
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT kp.id AS knowledge_point_id,
              kp.name,
              SUM(meb.is_cleared = 0) AS uncleared_count,
              COUNT(*) AS total_wrong_count
       FROM main_error_books meb
       JOIN question_knowledge_points qkp ON qkp.question_id = meb.question_id
       JOIN knowledge_points kp ON kp.id = qkp.knowledge_point_id
       WHERE meb.student_id = ?
       GROUP BY kp.id, kp.name
       ORDER BY uncleared_count DESC, total_wrong_count DESC, kp.id ASC
       LIMIT ?`,
      [studentId, limit],
    );
    return rows.map((r) => ({
      knowledgePointId: Number(r.knowledge_point_id),
      name: String(r.name ?? ''),
      unclearedCount: Number(r.uncleared_count ?? 0),
      totalWrongCount: Number(r.total_wrong_count ?? 0),
    }));
  }

  /**
   * 未清零错题里**映射不到任何知识点**的条数（`question_id` 为 NULL，或该题未绑 KP）。
   *
   * 与 `getWeakPoints` 是同一口径的补集，UI 必须显式展示这个数（spec §9.1）。
   */
  async countUncoveredUnclearedErrors(studentId: number): Promise<number> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS uncovered
       FROM main_error_books meb
       WHERE meb.student_id = ? AND meb.is_cleared = 0
         AND NOT EXISTS (
           SELECT 1 FROM question_knowledge_points qkp WHERE qkp.question_id = meb.question_id
         )`,
      [studentId],
    );
    return Number(rows[0]?.uncovered ?? 0);
  }

  /**
   * 按天趋势（口径与 `getAccuracyBySubject` 完全一致，只是 GROUP BY 换成日期）。
   * 只返回有记录的天；窗口内没做过的天不补零——前端按窗口铺 X 轴。
   */
  async getAccuracyTrend(studentId: number, from: Date, to: Date): Promise<TrendRow[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT date, SUM(total) AS answered, SUM(correct) AS correct FROM (
         SELECT DATE(judged_at) AS date, SUM(is_correct = 1) AS correct, COUNT(*) AS total
         FROM practice_results
         WHERE student_id = ? AND method IN ('exact','ai')
           AND judged_at >= ? AND judged_at < ?
         GROUP BY DATE(judged_at)
         UNION ALL
         SELECT DATE(ea.judged_at) AS date, SUM(ea.is_correct = 1) AS correct, COUNT(*) AS total
         FROM exam_sessions es JOIN exam_answers ea ON ea.session_id = es.id
         WHERE es.student_id = ? AND es.status = 'submitted' AND ea.is_correct IS NOT NULL
           AND ea.judged_at >= ? AND ea.judged_at < ?
         GROUP BY DATE(ea.judged_at)
       ) t
       GROUP BY date
       ORDER BY date ASC`,
      [studentId, from, to, studentId, from, to],
    );
    return rows.map((r) => ({
      date:
        typeof r.date === 'string'
          ? r.date
          : new Date(r.date as Date).toISOString().slice(0, 10),
      answered: Number(r.answered ?? 0),
      correct: Number(r.correct ?? 0),
    }));
  }

  /**
   * 已交卷考试列表（不限时间窗，让家长看到全部考试史）。
   * `objectiveCount` = 已判对错的题数（`exam_answers.is_correct IS NOT NULL`），
   * 与 `ExamsService.summarize` 口径一致——主观题不参与正确率。
   */
  async listSubmittedExams(studentId: number, limit: number): Promise<ExamSummaryRow[]> {
    // LIMIT ? 必须用 pool.query（客户端转义）
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT es.id AS session_id, ep.title AS paper_title, es.subject_id, es.submitted_at,
              SUM(ea.is_correct = 1) AS correct_count,
              SUM(ea.is_correct IS NOT NULL) AS objective_count
       FROM exam_sessions es
       JOIN exam_papers ep ON ep.id = es.paper_id
       LEFT JOIN exam_answers ea ON ea.session_id = es.id
       WHERE es.student_id = ? AND es.status = 'submitted'
       GROUP BY es.id, ep.title, es.subject_id, es.submitted_at
       ORDER BY es.submitted_at DESC, es.id DESC
       LIMIT ?`,
      [studentId, limit],
    );
    return rows.map((r) => ({
      sessionId: Number(r.session_id),
      paperTitle: String(r.paper_title ?? ''),
      subjectId: Number(r.subject_id),
      submittedAt: new Date(r.submitted_at as Date),
      correctCount: Number(r.correct_count ?? 0),
      objectiveCount: Number(r.objective_count ?? 0),
    }));
  }
}
