import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

/**
 * 本地时区的 `YYYY-MM-DD`。**不要用 `toISOString()`**：那会按 UTC 切，跨时区差一天。
 *
 * mysql2 对 `DATE()` 列返回**本地零点**的 Date（connection.ts 未设 `dateStrings`/`timezone`），
 * 在 UTC+8 下 `toISOString().slice(0,10)` 会把 2026-09-15 折成 '2026-09-14'。
 */
function toLocalDayString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

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
 * 家长端错题列表的筛选条件。
 *
 * `track` 是**反向排除**语义（不是白名单）：
 * - `aux` → `source = 'auxiliary'`
 * - `main` → `source <> 'auxiliary'`
 *
 * 为什么 main 不用白名单 `IN (...)`：未来「智能组卷」会写入 `homework`/`unit_test`/`midterm`/
 * `final` 等新 source，白名单会让这些错题从「主线」Tab **静默消失**且不报错。反向排除对新
 * source 天然免疫。`source` 是「具体来源」筛选（与 `track` 可叠加）。
 *
 * `from`/`to` 是 `YYYY-MM-DD`，`to` 用 `DATE_ADD(..., INTERVAL 1 DAY)` 做闭区间。
 */
/**
 * 错题的两档轨道（家长端「错题查看」的 Tab）。
 *
 * 2026-09-19 由 `main | aux` 改为 `main | training`：孩子**在辅线答疑里问过**的题会进
 * 训练轨的「错题练习」池（`findErrorBookEntries` 不过滤 source），孩子能在那儿做对清零，
 * 所以它在家长端的归属是**训练**，而不是自成一条「辅线」轨。
 */
export type ParentErrorTrack = 'main' | 'training';

/**
 * 已知的全部错题来源（`main_error_books.source`，DB 层是自由 `VARCHAR(20)`、无 enum，
 * 这里是**唯一**的枚举处）。写入点：判题 `practice` / `discuss` / `exam` / `targeted` /
 * `error_practice`，辅线答疑入库 `auxiliary`（`ai.service.ts`）。
 */
export const ALL_ERROR_SOURCES = [
  'practice',
  'discuss',
  'exam',
  'targeted',
  'error_practice',
  'auxiliary',
] as const;

/**
 * `source` → 轨道档位的**唯一真源**（`buildErrorWhere` 的 IN 列表由它生成）。
 *
 * 为什么改成白名单而不再用反向排除（旧 `main` 曾写作 `source <> 'auxiliary'`）：
 * 反向排除只能表达「非 A 即 B」；现在两档各自是一组来源，硬凑成反向排除会把来源
 * 归错档。代价是**未登记的 source 两档都不进**——由分区测试兜底：它枚举
 * `ALL_ERROR_SOURCES` 断言每个来源恰好属于一档且并集无遗漏，新增来源不入册即红。
 * 「测试红了逼你登记」比「静默归错档」好。
 */
export const TRACK_SOURCES: Record<ParentErrorTrack, readonly string[]> = {
  // 主线：课堂练习 / 卡片讨论 / 考试（PRD §6.1，错题进主线错题本）
  main: ['practice', 'discuss', 'exam'],
  // 训练：训练轨自身产生的错题 + 辅线答疑里孩子问过的题（都进训练轨错题练习池）
  training: ['targeted', 'error_practice', 'auxiliary'],
};

/**
 * 由 `source` 现算轨道，供响应字段用——与 `TRACK_SOURCES` **同源**，不另写一份映射。
 *
 * 未登记的 source 兜底归「主线」（沿旧响应的「其余 → main」语义）。正常运行期走不到
 * 这条分支：`TRACK_SOURCES` 的分区测试要求每个已知来源都已登记。
 */
export function trackOfSource(source: string): ParentErrorTrack {
  return TRACK_SOURCES.training.includes(source) ? 'training' : 'main';
}

export interface ParentErrorFilters {
  subjectId?: number;
  track?: ParentErrorTrack;
  source?: string;
  cleared?: 'uncleared' | 'cleared';
  from?: string;
  to?: string;
}

/**
 * 错题列表行（已 JOIN 题面；`question_id` 为 NULL 时后三列为 null）。
 *
 * **不含知识点**：知识点单独用 `listErrorKnowledgePoints` 批量取（一题多 KP，见方法注释）。
 */
export interface ParentErrorRow {
  id: number;
  questionId: number | null;
  subjectId: number;
  source: string;
  level: number;
  isCleared: boolean;
  wrongAnswerText: string | null;
  createdAt: Date;
  clearedAt: Date | null;
  questionContent: string | null;
  questionType: string | null;
  questionDifficulty: number | null;
}

/** 「题 × 知识点」扁平行，交给 service 按 questionId 聚成 `question.knowledgePoints[]`。 */
export interface ErrorKnowledgePointRow {
  questionId: number;
  knowledgePointId: number;
  knowledgePointName: string;
}

/**
 * 家长端对话回放列表的筛选条件。
 *
 * **没有学科筛选**：实测 `ai_dialogues.subject_id` 有 76% 是 NULL
 * （`ConversationService.createDialogue` 硬编码写 null），按学科筛会大面积漏。
 * 可靠维度是 `track` + `scene` + 时间 + 标题关键词。
 */
export interface ParentChatLogFilters {
  track?: 'mainline' | 'auxiliary';
  scene?: string;
  from?: string;
  to?: string;
  /** 只匹配 `ai_dialogues.title`，**不搜消息正文**。 */
  q?: string;
}

/** 会话列表行（含消息数与闲聊标记数）。`updatedAt` = 最后一条消息时间（见方法注释）。 */
export interface ParentChatLogRow {
  id: number;
  track: string;
  scene: string;
  title: string | null;
  subjectId: number | null;
  createdAt: Date;
  /** **最后一条消息时间**（无消息则退回 `createdAt`），不是 `ai_dialogues.updated_at`。 */
  updatedAt: Date;
  messageCount: number;
  blockCount: number;
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
      date: typeof r.date === 'string' ? r.date : toLocalDayString(new Date(r.date as Date)),
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

  /**
   * 家长端错题列表（只读、分页）。
   *
   * 为什么不在 `main-error-books.repo.ts` 上扩展 `findErrorBookEntries`：那个方法正被训练轨
   * 的错题练习调用，改它会连带改训练轨行为。这里照抄它的筛选写法自建。
   *
   * count 与 list **共用 `buildErrorWhere`**，否则「总数」与「列表」迟早对不上。
   *
   * **分页查询刻意不 JOIN 知识点**：实测 41% 的题绑了多个 KP，一 JOIN 就会让行翻倍，而
   * `LIMIT` 作用在翻倍后的行上——一页的错题数会少于 `pageSize`、同一道错题重复出现、`items`
   * 与 `total` 对不上。知识点由 `listErrorKnowledgePoints(本页 questionIds)` 另查（见该方法的注释）。
   */
  async listParentErrors(
    studentId: number,
    filters: ParentErrorFilters,
    limit: number,
    offset: number,
  ): Promise<{ items: ParentErrorRow[]; total: number }> {
    const { where, params } = this.buildErrorWhere(studentId, filters);

    const [countRows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS count FROM main_error_books meb WHERE ${where}`,
      params,
    );

    // LIMIT ? / OFFSET ? 必须用 pool.query（客户端转义）
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT meb.id, meb.question_id, meb.subject_id, meb.source, meb.level, meb.is_cleared,
              meb.wrong_answer_text, meb.created_at, meb.cleared_at,
              q.content AS question_content, q.type AS question_type,
              q.difficulty AS question_difficulty
       FROM main_error_books meb
       LEFT JOIN questions q ON q.id = meb.question_id
       WHERE ${where}
       ORDER BY meb.created_at DESC, meb.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    return {
      total: Number(countRows[0]?.count ?? 0),
      items: rows.map((r) => ({
        id: Number(r.id),
        questionId: r.question_id === null ? null : Number(r.question_id),
        subjectId: Number(r.subject_id),
        source: String(r.source),
        level: Number(r.level),
        isCleared: Number(r.is_cleared) === 1,
        wrongAnswerText: (r.wrong_answer_text as string | null) ?? null,
        createdAt: new Date(r.created_at as Date),
        clearedAt: r.cleared_at ? new Date(r.cleared_at as Date) : null,
        questionContent: (r.question_content as string | null) ?? null,
        questionType: (r.question_type as string | null) ?? null,
        questionDifficulty: r.question_difficulty === null ? null : Number(r.question_difficulty),
      })),
    };
  }

  /**
   * 本页错题涉及的知识点（一题多 KP 会出多行，由 service 按 questionId 聚成数组）。
   *
   * 空数组**直接返回、不发 SQL**：`IN ()` 在 MySQL 里是语法错误。这个守卫必须留在仓储里，
   * 不能让每个调用方各自记得判空。
   */
  async listErrorKnowledgePoints(questionIds: number[]): Promise<ErrorKnowledgePointRow[]> {
    if (questionIds.length === 0) return [];

    const placeholders = questionIds.map(() => '?').join(',');
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT qkp.question_id, kp.id AS knowledge_point_id, kp.name AS knowledge_point_name
       FROM question_knowledge_points qkp
       JOIN knowledge_points kp ON kp.id = qkp.knowledge_point_id
       WHERE qkp.question_id IN (${placeholders})
       ORDER BY qkp.question_id ASC, kp.id ASC`,
      questionIds,
    );
    return rows.map((r) => ({
      questionId: Number(r.question_id),
      knowledgePointId: Number(r.knowledge_point_id),
      knowledgePointName: String(r.knowledge_point_name ?? ''),
    }));
  }

  /**
   * 家长端会话列表（只读、分页）。`messageCount` / `blockCount` 由 JOIN 聚合带出，
   * 避免「先查会话再逐条查消息数」的 N+1。
   *
   * `blockCount` = 该会话里 `safety_flag = 1` 的消息数（温和阻断落库时就置 1），
   * 前端据此给「闲聊/偏离学习」打红色标记——本批唯一有真数据的预警信号。
   *
   * **`updatedAt` 是「最后一条消息时间」，不是 `ai_dialogues.updated_at`。**
   * 为什么不能直接用那一列：追加消息只 `INSERT INTO ai_messages`，**不 UPDATE 对话行**，
   * 所以 `ai_dialogues.updated_at` 实质冻结在创建时刻（schema 里那个
   * `trg_ai_dialogues_updated_at` 只在 UPDATE 对话行时触发，帮不上忙；而且当前 dev 库里
   * 它压根没装上——见 changelog）。主线卡片讨论是 find-or-create（一个会话横跨整个学期），
   * 用创建时间排序会把**最近在聊**的会话沉到列表底部。
   *
   * 因此统一用 `COALESCE(MAX(m.created_at), d.created_at)`：有消息取最后一条消息时间，
   * 没消息退回创建时间。排序与时间窗（`buildChatLogWhere` 里的相关子查询）都用它，
   * 保证「列表看到的顺序」与「筛选用的时间」是同一个东西。
   */
  async listParentChatLogs(
    studentId: number,
    filters: ParentChatLogFilters,
    limit: number,
    offset: number,
  ): Promise<{ items: ParentChatLogRow[]; total: number }> {
    const { where, params } = this.buildChatLogWhere(studentId, filters);

    const [countRows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS count FROM ai_dialogues d WHERE ${where}`,
      params,
    );

    // LIMIT ? / OFFSET ? 必须用 pool.query（客户端转义）
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT d.id, d.track, d.scene, d.title, d.subject_id, d.created_at,
              COALESCE(MAX(m.created_at), d.created_at) AS last_active_at,
              COUNT(m.id) AS message_count,
              COALESCE(SUM(m.safety_flag = 1), 0) AS block_count
       FROM ai_dialogues d
       LEFT JOIN ai_messages m ON m.dialogue_id = d.id AND m.deleted_at IS NULL
       WHERE ${where}
       GROUP BY d.id, d.track, d.scene, d.title, d.subject_id, d.created_at
       ORDER BY last_active_at DESC, d.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    return {
      total: Number(countRows[0]?.count ?? 0),
      items: rows.map((r) => ({
        id: Number(r.id),
        track: String(r.track),
        scene: String(r.scene),
        title: (r.title as string | null) ?? null,
        subjectId: r.subject_id === null ? null : Number(r.subject_id),
        createdAt: new Date(r.created_at as Date),
        updatedAt: new Date(r.last_active_at as Date),
        messageCount: Number(r.message_count ?? 0),
        blockCount: Number(r.block_count ?? 0),
      })),
    };
  }

  /** 会话列表 count 与 list 的**唯一** WHERE 构造器。 */
  private buildChatLogWhere(
    studentId: number,
    filters: ParentChatLogFilters,
  ): { where: string; params: (number | string)[] } {
    const conditions = ['d.student_id = ?', 'd.deleted_at IS NULL'];
    const params: (number | string)[] = [studentId];

    if (filters.track) {
      conditions.push('d.track = ?');
      params.push(filters.track);
    }
    if (filters.scene) {
      conditions.push('d.scene = ?');
      params.push(filters.scene);
    }
    // 时间窗按「最后一条消息时间」算，与 ORDER BY 同一表达式。
    // 这里必须用**相关子查询**而不是 MAX(m.created_at)：count 查询是**不带 JOIN** 的
    // `SELECT COUNT(*) FROM ai_dialogues d`，写聚合函数会直接报错；而 count 与 list 必须
    // 共用同一份 WHERE（否则 total 与列表会各算各的）。
    const lastActive =
      'COALESCE((SELECT MAX(m2.created_at) FROM ai_messages m2 WHERE m2.dialogue_id = d.id AND m2.deleted_at IS NULL), d.created_at)';
    if (filters.from) {
      conditions.push(`${lastActive} >= ?`);
      params.push(filters.from);
    }
    if (filters.to) {
      conditions.push(`${lastActive} < DATE_ADD(?, INTERVAL 1 DAY)`);
      params.push(filters.to);
    }
    if (filters.q) {
      // LIKE 通配符转义：不转义的话家长搜「50%」会变成「任意字符」而匹配一切。
      // mysql2 的 `?` 占位只防注入，不处理 LIKE 元字符，必须自己转。
      const escaped = filters.q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
      conditions.push('d.title LIKE ?');
      params.push(`%${escaped}%`);
    }
    return { where: conditions.join(' AND '), params };
  }

  /** 错题列表 count 与 list 的**唯一** WHERE 构造器（改这里就是改两处）。 */
  private buildErrorWhere(
    studentId: number,
    filters: ParentErrorFilters,
  ): { where: string; params: (number | string)[] } {
    const conditions = ['meb.student_id = ?'];
    const params: (number | string)[] = [studentId];

    if (filters.subjectId !== undefined) {
      conditions.push('meb.subject_id = ?');
      params.push(filters.subjectId);
    }
    if (filters.track) {
      // IN 列表由 TRACK_SOURCES 生成（不写字面量）：改分档只改那一处。
      const sources = TRACK_SOURCES[filters.track];
      conditions.push(`meb.source IN (${sources.map(() => '?').join(', ')})`);
      params.push(...sources);
    }
    if (filters.source) {
      conditions.push('meb.source = ?');
      params.push(filters.source);
    }
    if (filters.cleared === 'uncleared') {
      conditions.push('meb.is_cleared = 0');
    } else if (filters.cleared === 'cleared') {
      conditions.push('meb.is_cleared = 1');
    }
    if (filters.from) {
      conditions.push('meb.created_at >= ?');
      params.push(filters.from);
    }
    if (filters.to) {
      conditions.push('meb.created_at < DATE_ADD(?, INTERVAL 1 DAY)');
      params.push(filters.to);
    }
    return { where: conditions.join(' AND '), params };
  }
}
