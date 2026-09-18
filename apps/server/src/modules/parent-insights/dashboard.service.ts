import { Injectable, NotFoundException } from '@nestjs/common';
import { StudentsRepository } from '../../database/repositories/students.repo.js';
import { SubjectsRepository } from '../../database/repositories/subjects.repo.js';
import { ParentInsightsRepository } from '../../database/repositories/parent-insights.repo.js';
import { ProgressService } from '../progress/progress.service.js';
import type { StarMapData } from '../progress/progress.service.js';
import { startOfDaysAgo } from './window.util.js';
import { toRate } from './rate.util.js';
import type {
  DashboardStudent,
  DashboardSubject,
  ParentDashboard,
} from './dto/parent-insights.dto.js';

/** 近 7 天活跃 = 含今天在内的 7 天窗口。 */
const ACTIVE_WINDOW_DAYS = 7;

/**
 * 家长仪表盘（spec §4.2 ①）：**多孩聚合一个端点**，一次给完。
 *
 * 口径注意：
 * - `accuracy` / `selfAssessed` / `errorBook` / `examCount` 都是**累计值，不限时间窗**
 *   （报告页才是窗口口径）。三种聚合方法都不传 `from`/`to`。
 * - `lastActiveAt` 是全时段 MAX、`activeDays7` 是近 7 天——仓储内部两次查。
 * - 进度**复用 `ProgressService.getStarMap`，不改它的返回结构**；`percent` 由
 *   `completedUnits / totalUnits` 现算，**不要**拿 `StarMapData` 里的 `progress` 字段
 *   （那个是「本章已完成的节占比」，语义不同）。
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly studentsRepo: StudentsRepository,
    private readonly subjectsRepo: SubjectsRepository,
    private readonly progressService: ProgressService,
    private readonly repo: ParentInsightsRepository,
  ) {}

  async getDashboard(parentId: number): Promise<ParentDashboard> {
    const students = await this.studentsRepo.findByParentId(parentId);
    const weekStart = startOfDaysAgo(ACTIVE_WINDOW_DAYS - 1);
    const subjectNames = new Map((await this.subjectsRepo.findAll()).map((s) => [s.id, s.name]));

    const result: DashboardStudent[] = [];
    for (const student of students) {
      const activity = await this.repo.getActivitySummary(student.id, weekStart);
      const subjectIds = await this.repo.listTrackedSubjectIds(student.id);

      let subjects: DashboardSubject[] = [];
      if (subjectIds.length > 0) {
        const accuracy = new Map(
          (await this.repo.getAccuracyBySubject(student.id)).map((r) => [r.subjectId, r]),
        );
        const selfAssess = new Map(
          (await this.repo.getSelfAssessBySubject(student.id)).map((r) => [r.subjectId, r]),
        );
        const errorBook = new Map(
          (await this.repo.getErrorBookSummary(student.id)).map((r) => [r.subjectId, r]),
        );
        const examCounts = new Map(
          (await this.repo.getExamCounts(student.id)).map((r) => [r.subjectId, r.count]),
        );

        subjects = await this.buildSubjects(student.id, subjectIds, subjectNames, {
          accuracy,
          selfAssess,
          errorBook,
          examCounts,
        });
      }

      result.push({
        studentId: student.id,
        name: student.name,
        grade: student.grade,
        schoolLevel: student.schoolLevel,
        lastActiveAt: activity.lastActiveAt,
        activeDays7: activity.activeDays,
        unreadAlerts: 0,
        subjects,
      });
    }

    return { students: result, unreadAlerts: 0 };
  }

  /**
   * 逐学科取进度。**单个学科失败不拖垮整页**：`getStarMap` 在「学科被停用」或「该学科暂无
   * 教材版本」时抛 1002，而 `progress` 行可能还留着（家长之前配过教材）——那是真实的脏数据
   * 场景，跳过该学科即可，否则整个仪表盘 404。非 1002 的异常照常抛出（不吞 bug）。
   */
  private async buildSubjects(
    studentId: number,
    subjectIds: number[],
    subjectNames: Map<number, string>,
    maps: {
      accuracy: Map<number, { answered: number; correct: number }>;
      selfAssess: Map<number, { count: number; correctCount: number }>;
      errorBook: Map<number, { uncleared: number; total: number }>;
      examCounts: Map<number, number>;
    },
  ): Promise<DashboardSubject[]> {
    const subjects: DashboardSubject[] = [];
    for (const subjectId of subjectIds) {
      let starMap: StarMapData;
      try {
        starMap = await this.progressService.getStarMap(studentId, subjectId);
      } catch (err) {
        if (err instanceof NotFoundException) continue;
        throw err;
      }

      const acc = maps.accuracy.get(subjectId) ?? { answered: 0, correct: 0 };
      const self = maps.selfAssess.get(subjectId) ?? { count: 0, correctCount: 0 };
      const errBook = maps.errorBook.get(subjectId) ?? { uncleared: 0, total: 0 };
      const currentChapter = starMap.chapters.find((c) => c.status === 'current');

      subjects.push({
        subjectId,
        subjectName: subjectNames.get(subjectId) ?? starMap.subjectName,
        progress: {
          completedUnits: starMap.completedUnits,
          totalUnits: starMap.totalUnits,
          currentUnitName: currentChapter?.title ?? null,
          currentLessonName:
            currentChapter?.sections.find((s) => s.status === 'current')?.title ?? null,
          percent:
            starMap.totalUnits > 0
              ? Math.round((starMap.completedUnits / starMap.totalUnits) * 100)
              : 0,
        },
        accuracy: {
          answered: acc.answered,
          correct: acc.correct,
          rate: toRate(acc.answered, acc.correct),
        },
        selfAssessed: { count: self.count, correctCount: self.correctCount },
        errorBook: { uncleared: errBook.uncleared, total: errBook.total },
        examCount: maps.examCounts.get(subjectId) ?? 0,
      });
    }
    return subjects;
  }
}
