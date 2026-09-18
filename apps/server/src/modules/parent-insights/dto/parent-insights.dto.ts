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
