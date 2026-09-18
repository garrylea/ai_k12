import { Injectable } from '@nestjs/common';
import { SubjectsRepository } from '../../database/repositories/subjects.repo.js';
import { ParentInsightsRepository } from '../../database/repositories/parent-insights.repo.js';
import { resolveWindow } from './window.util.js';
import type { ReportPeriod } from './window.util.js';
import { toRate } from './rate.util.js';
import type {
  LearningReport,
  ReportSubjectRow,
  TrendPoint,
} from './dto/parent-insights.dto.js';

/** 薄弱点取前 N 个；考试记录取最近 N 场。 */
const WEAK_POINT_LIMIT = 10;
const EXAM_LIMIT = 20;

/**
 * 学情报告（spec §4.2 ②）：**纯实时聚合**，不落库、不调 LLM。
 *
 * 两套口径**必须分清**（spec §4.2 ② 逐条写明）：
 * - **窗口口径**（近 7 / 30 天）：`stats` 全部字段、`trend`、`subjects`
 * - **累计口径**（不限窗口）：`weakPoints` + `weakPointsUncoveredCount`（「现在还剩哪些没清」
 *   才是家长关心的）、`exams`（让家长看到全部考试史）
 */
@Injectable()
export class ReportService {
  constructor(
    private readonly repo: ParentInsightsRepository,
    private readonly subjectsRepo: SubjectsRepository,
  ) {}

  async getReport(studentId: number, period: ReportPeriod): Promise<LearningReport> {
    const window = resolveWindow(period);
    const { start, endExclusive } = window;

    // 窗口口径
    const [activity, accuracy, selfAssess, examCounts, errorCounts, trend] = await Promise.all([
      this.repo.getActivitySummary(studentId, start),
      this.repo.getAccuracyBySubject(studentId, start, endExclusive),
      this.repo.getSelfAssessBySubject(studentId, start, endExclusive),
      this.repo.getExamCounts(studentId, start, endExclusive),
      this.repo.getErrorDateCounts(studentId, start, endExclusive),
      this.repo.getAccuracyTrend(studentId, start, endExclusive),
    ]);

    // 累计口径
    const [weakPoints, uncovered, exams, subjects] = await Promise.all([
      this.repo.getWeakPoints(studentId, WEAK_POINT_LIMIT),
      this.repo.countUncoveredUnclearedErrors(studentId),
      this.repo.listSubmittedExams(studentId, EXAM_LIMIT),
      this.subjectsRepo.findAll(),
    ]);
    const subjectNames = new Map(subjects.map((s) => [s.id, s.name]));

    const answered = accuracy.reduce((sum, r) => sum + r.answered, 0);
    const correct = accuracy.reduce((sum, r) => sum + r.correct, 0);
    const selfAssessCount = selfAssess.reduce((sum, r) => sum + r.count, 0);
    const examCount = examCounts.reduce((sum, r) => sum + r.count, 0);

    const subjectRows: ReportSubjectRow[] = accuracy.map((r) => ({
      subjectId: r.subjectId,
      subjectName: subjectNames.get(r.subjectId) ?? '',
      answered: r.answered,
      correct: r.correct,
      rate: toRate(r.answered, r.correct),
    }));

    const trendPoints: TrendPoint[] = trend.map((t) => ({
      date: t.date,
      answered: t.answered,
      correct: t.correct,
      rate: toRate(t.answered, t.correct),
    }));

    return {
      studentId,
      period,
      windowStart: window.startDay,
      windowEnd: window.endDay,
      stats: {
        activeDays: activity.activeDays,
        answered,
        correct,
        rate: toRate(answered, correct),
        selfAssessCount,
        errorsAdded: errorCounts.added,
        errorsCleared: errorCounts.cleared,
        examCount,
      },
      trend: trendPoints,
      subjects: subjectRows,
      weakPoints,
      weakPointsUncoveredCount: uncovered,
      exams: exams.map((e) => ({
        sessionId: e.sessionId,
        paperTitle: e.paperTitle,
        subjectName: subjectNames.get(e.subjectId) ?? '',
        submittedAt: e.submittedAt,
        correctCount: e.correctCount,
        objectiveCount: e.objectiveCount,
        rate: toRate(e.objectiveCount, e.correctCount),
      })),
    };
  }
}
