import { Injectable } from '@nestjs/common';
import { GoalsRepository } from '../../database/repositories/goals.repo.js';
import type { GoalMetric, GoalPeriod } from '../../database/repositories/goals.repo.js';
import { SpecialPracticeLogsRepository } from '../../database/repositories/special-practice-logs.repo.js';
import { MainErrorBooksRepository } from '../../database/repositories/main-error-books.repo.js';
import { ParentAnalyticsRepository } from '../../database/repositories/parent-analytics.repo.js';
import { LessonCompletionsRepository } from '../../database/repositories/lesson-completions.repo.js';
import { ProgressRepository } from '../../database/repositories/progress.repo.js';
import { SubjectsRepository } from '../../database/repositories/subjects.repo.js';
import { startOfDaysAgo } from './window.util.js';
import { toRate } from './rate.util.js';
import type { GoalAttainmentItem, GoalAttainmentSummary } from './dto/parent-insights.dto.js';

/** 本系统 MVP 覆盖的学科（PRD 只做数学/语文/英语；`subjects` 表里有 9 个，别全建默认目标）。 */
const MVP_SUBJECT_CODES = ['math', 'chinese', 'english'] as const;

/**
 * **固定兜底**进「在学学科」的学科。
 *
 * 为什么语文/英语要兜底：`weekly_passages`（古诗文）与 `daily_words`（背单词）属**训练轨专项**，
 * 不依赖家长配教材 —— 若学生在 `progress` 里没有这两门（只配了数学），这两个目标就**没位置可设**。
 */
const FALLBACK_SUBJECT_CODES = ['chinese', 'english'] as const;

/**
 * 目标模板：**唯一真源**（指标 × 适用学科 × 默认值 × period）。
 *
 * `subjects: null` = 每个在学学科都建；否则只在这些学科建（学科用 `subjects.code`）。
 * 默认值是懒初始化用的（家长可改），不是建议值。
 */
export const GOAL_TEMPLATES: ReadonlyArray<{
  metric: GoalMetric;
  period: GoalPeriod;
  title: string;
  defaultTarget: number;
  subjects: readonly string[] | null;
}> = [
  { metric: 'daily_study_minutes', period: 'daily', title: '每日学习时长', defaultTarget: 30, subjects: null },
  { metric: 'weekly_lessons', period: 'weekly', title: '每周完课', defaultTarget: 2, subjects: null },
  { metric: 'weekly_clear_errors', period: 'weekly', title: '每周清零错题', defaultTarget: 5, subjects: null },
  { metric: 'weekly_passages', period: 'weekly', title: '每周古诗文篇目', defaultTarget: 8, subjects: ['chinese'] },
  { metric: 'daily_words', period: 'daily', title: '每日背单词', defaultTarget: 20, subjects: ['english'] },
];

/** `metric → 适用学科 code 集合`（`null` = 所有在学学科）。controller 用它做「指标 × 学科」匹配校验。 */
export const SUBJECTS_BY_METRIC: Record<GoalMetric, readonly string[] | null> = Object.fromEntries(
  GOAL_TEMPLATES.map((t) => [t.metric, t.subjects]),
) as Record<GoalMetric, readonly string[] | null>;

const TITLE_BY_METRIC = Object.fromEntries(
  GOAL_TEMPLATES.map((t) => [t.metric, t.title]),
) as Record<GoalMetric, string>;

const PERIOD_BY_METRIC = Object.fromEntries(
  GOAL_TEMPLATES.map((t) => [t.metric, t.period]),
) as Record<GoalMetric, GoalPeriod>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 在学学科（带 code，供模板筛选与排序）。 */
interface LearningSubject {
  id: number;
  code: string;
  name: string;
  sortOrder: number;
}

/**
 * 家长端目标设定（P6.5，2026-09-20 起**按学科**）。
 *
 * 模型：目标是 **(学科, 指标)** 二元组 —— **不存在全局目标**。默认目标按「在学学科 × 适用指标」
 * 展开（数学 3 + 语文 4 + 英语 4 = 11 行）。
 *
 * 五件事，逐条对应口径：
 *   1. **在学学科** = `progress` 行的学科 ∪ 固定兜底 {语文, 英语}，再与 MVP 白名单求交。
 *      没有任何在学学科 → **不建默认目标**（`items: []`），页面提示先去配置教材；**绝不编造**。
 *   2. **达成值按「学科 + 指标」分派**（见 `achievedOf`）。
 *   3. **窗口用 `startOfDaysAgo()`**：daily = 今天、weekly = 近 7 天（含今天），半开区间。
 *      绝不用 `CURDATE()`（DB 会话时区与 Node 可能不一致，会算错一天）。
 *   4. **`rate` 复用 `toRate`**（分母是 target，为 0 → null；**允许 > 100 = 超额**）。
 *   5. **达成值不缓存**：每次实时算（低频只读页，不值得引入失效问题）。
 *
 * ⚠️ **提醒本期不做**（2026-09-20 用户裁决）：`reminder_enabled` 恒 0，本服务不涉及提醒发送。
 */
@Injectable()
export class GoalsService {
  constructor(
    private readonly goalsRepo: GoalsRepository,
    private readonly logsRepo: SpecialPracticeLogsRepository,
    private readonly mainErrorRepo: MainErrorBooksRepository,
    private readonly analyticsRepo: ParentAnalyticsRepository,
    private readonly lessonRepo: LessonCompletionsRepository,
    private readonly progressRepo: ProgressRepository,
    private readonly subjectsRepo: SubjectsRepository,
  ) {}

  /** controller 用它校验 `subjectId` 是不是该生的在学学科（避免给没在学的学科写目标）。 */
  async isLearningSubject(studentId: number, subjectId: number): Promise<boolean> {
    const subjects = await this.resolveLearningSubjects(studentId);
    return subjects.some((s) => s.id === subjectId);
  }

  /**
   * controller 用它校验「这个指标适不适用于这个学科」（如 `daily_words` 只适用英语）。
   *
   * 规则真源是 `SUBJECTS_BY_METRIC`（由 `GOAL_TEMPLATES` 派生）—— **别在 controller 里
   * 复制一份学科白名单**，那必然与模板漂移。
   */
  async isMetricAllowedForSubject(subjectId: number, metric: GoalMetric): Promise<boolean> {
    const allowed = SUBJECTS_BY_METRIC[metric];
    if (allowed === null) return true; // null = 所有在学学科都适用
    const subject = await this.subjectsRepo.findById(subjectId);
    return subject !== null && allowed.includes(subject.code);
  }

  async getAttainment(studentId: number): Promise<GoalAttainmentSummary> {
    const subjects = await this.resolveLearningSubjects(studentId);
    // 没配任何教材（且兜底也拿不到）→ 不建默认目标。编造 11 行「未设定」比空列表更糟：
    // 家长会以为系统已经替他设好了。
    if (subjects.length === 0) return { items: [] };

    await this.goalsRepo.ensureDefaults(studentId, this.buildDefaults(subjects));

    const rows = await this.goalsRepo.findActiveByStudent(studentId);
    const byId = new Map(subjects.map((s) => [s.id, s]));

    const items = await Promise.all(
      rows
        // metric 为 NULL 或 subjectId 为 NULL 的都是迁移前遗留的停用行 → 跳过（前端按 (学科,指标) 渲染）
        .filter(
          (r): r is typeof r & { metric: GoalMetric; subjectId: number } =>
            r.metric !== null && r.subjectId !== null && byId.has(r.subjectId),
        )
        .map(async (r): Promise<GoalAttainmentItem> => {
          const achieved = await this.achievedOf(studentId, r.subjectId, r.metric);
          return {
            metric: r.metric,
            subjectId: r.subjectId,
            subjectName: byId.get(r.subjectId)?.name ?? '',
            period: PERIOD_BY_METRIC[r.metric],
            title: r.title,
            target: r.targetValue,
            achieved,
            rate: toRate(r.targetValue, achieved),
          };
        }),
    );

    // 稳定排序：学科按 sort_order（＝ resolveLearningSubjects 的顺序）→ 指标按模板声明顺序。
    // 必须先落地成 map 再排序，别依赖 rows 的 id 顺序（家长看到的顺序不该随插入顺序漂移）。
    const subjectOrder = new Map(subjects.map((s, i) => [s.id, i]));
    const metricOrder = new Map(GOAL_TEMPLATES.map((t, i) => [t.metric, i]));
    items.sort(
      (a, b) =>
        (subjectOrder.get(a.subjectId) ?? 99) - (subjectOrder.get(b.subjectId) ?? 99) ||
        (metricOrder.get(a.metric) ?? 99) - (metricOrder.get(b.metric) ?? 99),
    );

    return { items };
  }

  async upsertTarget(
    studentId: number,
    subjectId: number,
    metric: GoalMetric,
    target: number,
  ): Promise<GoalAttainmentItem> {
    const period = PERIOD_BY_METRIC[metric];
    await this.goalsRepo.upsertTarget(
      studentId,
      subjectId,
      metric,
      period,
      TITLE_BY_METRIC[metric],
      target,
    );
    const achieved = await this.achievedOf(studentId, subjectId, metric);
    const subject = await this.subjectsRepo.findById(subjectId);
    return {
      metric,
      subjectId,
      subjectName: subject?.name ?? '',
      period,
      title: TITLE_BY_METRIC[metric],
      target,
      achieved,
      rate: toRate(target, achieved),
    };
  }

  /**
   * 在学学科 = `progress` 行（家长配教材即产生）∪ 固定兜底 {语文, 英语}，再与 MVP 白名单求交，
   * 按 `subjects.sort_order` 排序。
   */
  private async resolveLearningSubjects(studentId: number): Promise<LearningSubject[]> {
    const [progressSubjectIds, allSubjects] = await Promise.all([
      this.progressRepo.findSubjectIdsByStudent(studentId),
      this.subjectsRepo.findAll(),
    ]);
    const learningIds = new Set(progressSubjectIds);
    return allSubjects
      .filter(
        (s) =>
          MVP_SUBJECT_CODES.includes(s.code as (typeof MVP_SUBJECT_CODES)[number]) &&
          (learningIds.has(s.id) ||
            FALLBACK_SUBJECT_CODES.includes(s.code as (typeof FALLBACK_SUBJECT_CODES)[number])),
      )
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((s) => ({ id: s.id, code: s.code, name: s.name, sortOrder: s.sortOrder }));
  }

  /** 默认目标 = 对每个在学学科，套用「通用模板 + 该学科专属模板」。 */
  private buildDefaults(subjects: LearningSubject[]): Array<{
    subjectId: number;
    metric: GoalMetric;
    period: GoalPeriod;
    title: string;
    target: number;
  }> {
    const out: Array<{
      subjectId: number;
      metric: GoalMetric;
      period: GoalPeriod;
      title: string;
      target: number;
    }> = [];
    for (const subject of subjects) {
      for (const t of GOAL_TEMPLATES) {
        if (t.subjects !== null && !t.subjects.includes(subject.code)) continue;
        out.push({
          subjectId: subject.id,
          metric: t.metric,
          period: t.period,
          title: t.title,
          target: t.defaultTarget,
        });
      }
    }
    return out;
  }

  /** 窗口：`daily` = 今天 → 明天；`weekly` = 近 7 天（含今天）→ 明天。半开区间 `< endExclusive`。 */
  private windowOf(period: GoalPeriod): { start: Date; endExclusive: Date } {
    const start = startOfDaysAgo(period === 'daily' ? 0 : 6);
    const today = startOfDaysAgo(0);
    return { start, endExclusive: new Date(today.getTime() + DAY_MS) };
  }

  /**
   * 达成值分派（spec §8.2 + P6.5 按学科）：
   * - `daily_study_minutes` ← `study_sessions` **按学科**（秒→分钟向下取整，不虚报达成）；
   * - `weekly_lessons` ← `lesson_completions` **按学科**；
   * - `weekly_clear_errors` ← `main_error_books` **按学科**（该表 subject_id NOT NULL）；
   * - `daily_words` / `weekly_passages` ← `special_practice_logs`，该表 `subject_id` 恒 NULL，
   *   故按 **module** 筛（英语=`en_vocabulary`、语文=三个 `chinese_*`）；这两个指标只会挂在
   *   对应学科上（模板已限），所以不需要 subjectId 参与查询。
   */
  private async achievedOf(studentId: number, subjectId: number, metric: GoalMetric): Promise<number> {
    const { start, endExclusive } = this.windowOf(PERIOD_BY_METRIC[metric]);
    switch (metric) {
      case 'daily_study_minutes': {
        const seconds = await this.analyticsRepo.getStudyTimeBySubjectOne(
          studentId,
          subjectId,
          start,
          endExclusive,
        );
        return Math.floor(seconds / 60); // 向下取整：59 秒不算 1 分钟
      }
      case 'weekly_lessons':
        return this.lessonRepo.countInWindow(studentId, subjectId, start, endExclusive);
      case 'weekly_clear_errors':
        return this.mainErrorRepo.countClearedBetween(studentId, subjectId, start, endExclusive);
      case 'daily_words': {
        const rows = await this.logsRepo.aggregateByModule(studentId, start, endExclusive);
        return rows.find((r) => r.module === 'en_vocabulary')?.units ?? 0;
      }
      case 'weekly_passages':
        return this.logsRepo.countDistinctPassages(studentId, start, endExclusive);
    }
  }
}
