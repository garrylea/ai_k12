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
