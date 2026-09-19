import type { GoalMetric, GoalPeriod } from '../../../database/repositories/goals.repo.js';

/**
 * 家长端「看得见」批的响应形状（spec `2026-09-18-parent-insights-design.md` §4.2）。
 *
 * 与 `docs/api/openapi.yaml` 的 schema **必须一致**（CLAUDE.md 的 API 文档同步铁律）。
 * 注意 `rate` 是 `number | null`：`answered = 0` 时必须为 null，**不能是 0**——0 会被读成
 * 「全错了」，那是另一回事。
 */
export interface RateSummary {
  answered: number;
  correct: number;
  rate: number | null;
}

export interface SelfAssessSummary {
  count: number;
  correctCount: number;
}

export interface ErrorBookSummary {
  uncleared: number;
  total: number;
}

export interface SubjectProgressSummary {
  completedUnits: number;
  totalUnits: number;
  currentUnitName: string | null;
  currentLessonName: string | null;
  percent: number;
}

export interface DashboardSubject {
  subjectId: number;
  subjectName: string;
  progress: SubjectProgressSummary;
  accuracy: RateSummary;
  selfAssessed: SelfAssessSummary;
  errorBook: ErrorBookSummary;
  examCount: number;
}

export interface DashboardStudent {
  studentId: number;
  name: string;
  grade: string | null;
  schoolLevel: string | null;
  lastActiveAt: Date | null;
  activeDays7: number;
  /** 本期恒 0：`safety_alerts` 无写入，等预警闭环后填（spec §3 定案 #9）。 */
  unreadAlerts: number;
  subjects: DashboardSubject[];
}

export interface ParentDashboard {
  students: DashboardStudent[];
  unreadAlerts: number;
}

/** 报告页折线的一点（只含有记录的天）。 */
export interface TrendPoint {
  date: string;
  answered: number;
  correct: number;
  rate: number | null;
}

/** 报告页顶部数字卡。窗口口径见 spec §4.2 ②。 */
export interface ReportStats {
  activeDays: number;
  answered: number;
  correct: number;
  rate: number | null;
  selfAssessCount: number;
  errorsAdded: number;
  errorsCleared: number;
  examCount: number;
}

/** 报告页柱状：窗口内按学科的答题量与正确率。 */
export interface ReportSubjectRow {
  subjectId: number;
  subjectName: string;
  answered: number;
  correct: number;
  rate: number | null;
}

/** 薄弱点（错题数代理，不是掌握度）。 */
export interface WeakPointItem {
  knowledgePointId: number;
  name: string;
  unclearedCount: number;
  totalWrongCount: number;
}

/** 报告页考试记录一行。 */
export interface ExamRecord {
  sessionId: number;
  paperTitle: string;
  subjectName: string;
  submittedAt: Date;
  correctCount: number;
  objectiveCount: number;
  rate: number | null;
}

/**
 * 学情报告（spec §4.2 ②）——**实时聚合，不落 `learning_reports`、不调 LLM**。
 *
 * 契约变更：本结构取代了 openapi 里原 `LearningReport` / `ReportContent`
 * （`summary/strengths/weaknesses/suggestions` 的 AI 文本形状），且
 * `GET .../reports/{reportId}` 已降级出 MVP。
 */
export interface LearningReport {
  studentId: number;
  period: 'weekly' | 'monthly';
  windowStart: string;
  windowEnd: string;
  stats: ReportStats;
  trend: TrendPoint[];
  subjects: ReportSubjectRow[];
  /** Top 10，按未清零错题数降序。**累计口径**（不限窗口）。 */
  weakPoints: WeakPointItem[];
  /** 未清零错题里映射不到知识点的条数（实测约占 60%），UI 必须显式提示。 */
  weakPointsUncoveredCount: number;
  /** 全部考试史，最多 20 场（不限窗口）。 */
  exams: ExamRecord[];
}

/** 错题里嵌套的题目信息；`main_error_books.question_id` 为 NULL 时整个 `question` 为 null。 */
export interface ParentErrorQuestion {
  content: string;
  type: string;
  difficulty: number | null;
  /** 未绑知识点时是**空数组**，不是 null（前端不必判两遍）。 */
  knowledgePoints: Array<{ id: number; name: string }>;
}

/**
 * 家长端错题一行（只读）。
 *
 * `track` 由 `source` 现算、**不落库**，分档表在 `parent-insights.repo.ts` 的
 * `TRACK_SOURCES`（唯一真源）：
 *   - `main` = `practice | discuss | exam`（主线：课堂练习 / 讨论 / 考试）
 *   - `training` = `targeted | error_practice | auxiliary`（训练轨错题 + 辅线答疑里问过的题）
 *
 * 与 `openapi` 原 `ErrorItem` 的差别：`source` enum 按**实际 6 个值**修正（原 enum 只有
 * `homework/unit_test/midterm/final/auxiliary/practice/discuss`，缺 `exam`/`targeted`/`error_practice`）。
 */
export interface ParentErrorItem {
  id: number;
  questionId: number | null;
  track: 'main' | 'training';
  source: string;
  level: number;
  isCleared: boolean;
  wrongAnswerText: string | null;
  createdAt: Date;
  clearedAt: Date | null;
  question: ParentErrorQuestion | null;
}

/** 分页壳（`pageSize` 服务端固定 20，前端不传）。 */
export interface ParentErrorPage {
  items: ParentErrorItem[];
  page: number;
  pageSize: number;
  total: number;
}

/** 会话列表一行。`blockCount` = 该会话里 `safety_flag = 1` 的消息数（闲聊/偏离学习标记）。 */
export interface ParentChatLogItem {
  id: number;
  track: string;
  scene: string;
  title: string | null;
  subjectId: number | null;
  createdAt: Date;
  /** 最后一条消息时间（无消息则退回创建时间）。 */
  updatedAt: Date;
  messageCount: number;
  blockCount: number;
}

/**
 * 逐句消息。**不回传 `token_input` / `token_output` / `response_time_ms`**——那三列全仓
 * 永远写 NULL（`conversations.service.ts` 写死 null），回传只会让家长误以为「没有消耗」。
 */
export interface ParentChatLogMessage {
  id: number;
  role: 'system' | 'user' | 'assistant';
  content: string;
  reasoning: string | null;
  type: string | null;
  model: string | null;
  safetyFlag: number;
  createdAt: Date;
  /**
   * 孩子随消息发的图片 URL（`/uploads/...`）。服务端从 `ai_messages.attachments` 的
   * JSON 串里解析、**只留 `type === 'image'`**；无附件时是**空数组**（不是 null）。
   *
   * 为什么要有这个字段：学生端能看（`useAuxChat` 解析 `attachments` → `AuxChatPanel`
   * 渲染 `<img>`），而家长端原先的字段白名单漏了它 → PRD §7.7「全透明回放」缺一块。
   */
  images: string[];
}

/** 详情继承列表行；`updatedAt` 同口径（最后一条消息时间，无消息则退回创建时间）。 */
export interface ParentChatLogDetail extends ParentChatLogItem {
  messages: ParentChatLogMessage[];
}

export interface ParentChatLogPage {
  items: ParentChatLogItem[];
  page: number;
  pageSize: number;
  total: number;
}

/**
 * 学习时长（spec §8.2）。`source: 'sessions'` 是**口径标记**：家长端同时存在
 * 「活跃天数」（四路时间戳代理）与「学习时长」（显式会话）两套口径，UI 必须能区分，
 * 见 spec §10 的第 1 条硬约束。
 */
export interface StudyTimeSummary {
  totalSeconds: number;
  /** 会话口径的「有学习的天数」，与旧 `activeDays7` **刻意不同**。 */
  activeDays: number;
  byDay: Array<{ date: string; seconds: number }>;
  byModule: Array<{ module: string; seconds: number }>;
  /** 只含 `subject_id IS NOT NULL` 的会话；没选学科的会话不进这张表。 */
  bySubject: Array<{ subjectId: number; seconds: number }>;
  source: 'sessions';
}

/** 今日已用时长（spec §8.2）。`limitMinutes: null` = 家长未设限。 */
export interface TodayUsageSummary {
  date: string;
  activeSeconds: number;
  limitMinutes: number | null;
  /** `>=` 判定：用满上限即算超出（管控语义是「该停了」）。 */
  exceeded: boolean;
  byModule: Array<{ module: string; seconds: number }>;
}

/**
 * 一个专项模块的窗口内聚合（spec §8.2 `/specials`）。
 * `rate` 为 `null` 表示「本期没有可判对错的作答」，**不是 0**。
 */
export interface SpecialModuleSummary {
  /** 作答单位数：默写=篇、解释/含义=句、背单词=题（日志一行 = 一个单位）。 */
  units: number;
  correct: number;
  rate: number | null;
  byDay: Array<{ date: string; count: number }>;
}

/** 四个模块的聚合。只有 `vocabulary` 多一个 `newWords`。 */
export interface SpecialsSummary {
  dictation: SpecialModuleSummary;
  interpretation: SpecialModuleSummary;
  meaning: SpecialModuleSummary;
  vocabulary: SpecialModuleSummary & { newWords: number };
}

/** `/mastery` 的一行。`lastSeenAt` 为 null = 从未见过（不要编成 0）。 */
export interface MasteryItem {
  knowledgePointId: number;
  name: string;
  /** 0..1 的比值（后端已算好，前端不要再除）。 */
  masteryScore: number;
  level: number;
  correctCount: number;
  errorCount: number;
  lastSeenAt: Date | null;
}

/**
 * `/mastery` 响应。三个覆盖率计数**必须都回**：题库只有 38% 的题绑了 KP，
 * 不给出「未覆盖」计数会让家长以为薄弱点只有列出的这些（spec §4.8 规则①）。
 */
export interface MasterySummary {
  items: MasteryItem[];
  coveredQuestions: number;
  totalQuestions: number;
  /** = totalQuestions - coveredQuestions，后端算好，前端不要自己减。 */
  uncovered: number;
}

/**
 * 目标达成的一行（spec §8.2 `/goals/attainment`）。
 *
 * 2026-09-20 起**按学科**（P6.5）：目标是 `(学科, 指标)` 二元组，**`metric` 不再全局唯一**
 * —— 同一个 metric 会在多个学科各占一行。前端渲染的 key 必须用 `subjectId:metric`。
 *
 * `rate` = `toRate(target, achieved)`，**分母是 target**（与其它 rate 口径同一条纪律：
 * 分母为 0 → `null`，不是 0）。**允许 > 100** = 超额完成，前端不要截断。
 */
export interface GoalAttainmentItem {
  metric: GoalMetric;
  subjectId: number;
  subjectName: string;
  period: GoalPeriod;
  title: string;
  target: number;
  achieved: number;
  rate: number | null;
}

/** 四个目标维度的达成情况（懒初始化后必然齐 4 条）。 */
export interface GoalAttainmentSummary {
  items: GoalAttainmentItem[];
}
