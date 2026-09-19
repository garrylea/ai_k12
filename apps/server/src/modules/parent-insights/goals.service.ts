import { Injectable } from '@nestjs/common';
import { GoalsRepository } from '../../database/repositories/goals.repo.js';
import type { GoalMetric, GoalPeriod } from '../../database/repositories/goals.repo.js';
import { SpecialPracticeLogsRepository } from '../../database/repositories/special-practice-logs.repo.js';
import { MainErrorBooksRepository } from '../../database/repositories/main-error-books.repo.js';
import { ParentAnalyticsRepository } from '../../database/repositories/parent-analytics.repo.js';
import { startOfDaysAgo } from './window.util.js';
import { toRate } from './rate.util.js';
import type { GoalAttainmentItem, GoalAttainmentSummary } from './dto/parent-insights.dto.js';

/**
 * 默认目标（2026-09-22 用户裁决：60 分钟 / 20 词 / 8 篇 / 10 道）。
 * 懒初始化时**只补缺失的**（`GoalsRepository.ensureDefaults` 用 `INSERT IGNORE`），
 * 家长改过的值不会被覆盖回默认。
 */
export const GOAL_DEFAULTS: ReadonlyArray<{
  metric: GoalMetric; period: GoalPeriod; title: string; target: number;
}> = [
  { metric: 'daily_study_minutes', period: 'daily', title: '每日学习时长', target: 60 },
  { metric: 'daily_words', period: 'daily', title: '每日背单词', target: 20 },
  { metric: 'weekly_passages', period: 'weekly', title: '每周古诗文篇目', target: 8 },
  { metric: 'weekly_clear_errors', period: 'weekly', title: '每周清零错题', target: 10 },
];

/** `period` 由 `metric` 派生（`goals.period` 是列、要落库，但不接受家长自定义）。 */
const PERIOD_BY_METRIC: Record<GoalMetric, GoalPeriod> = {
  daily_study_minutes: 'daily',
  daily_words: 'daily',
  weekly_passages: 'weekly',
  weekly_clear_errors: 'weekly',
};

/** 标题也由 metric 派生：库里没有「自定义标题」入口，统一用常量，避免同一目标两种写法。 */
const TITLE_BY_METRIC = Object.fromEntries(
  GOAL_DEFAULTS.map((d) => [d.metric, d.title]),
) as Record<GoalMetric, string>;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 家长端目标达成（spec §8.2 `/goals/attainment` + Phase 1B 新增的 `PUT /goals/{metric}`）。
 *
 * 四件事，逐条对应口径：
 *   1. **懒初始化**：`getAttainment` 先 `ensureDefaults`（只补缺失）——全新学生第一次打开
 *      `/parent/goals` 就有四条目标，不必家长先手动创建。
 *   2. **达成值按 metric 分派**（spec §8.2）：`daily_study_minutes` ← `study_sessions`（秒→分钟，
 *      **向下取整**，宁少报不虚报达成）；`daily_words` ← `special_practice_logs` 的
 *      `en_vocabulary` 单位数；`weekly_passages` ← 三个语文专项**去重篇目数**（2026-09-22 裁决：
 *      不能数行数——解释/含义是一句一行，会把「8 句」当「8 篇」）；`weekly_clear_errors` ←
 *      `main_error_books` 窗口内清零数。
 *   3. **窗口用 `startOfDaysAgo()`**：daily = 今天 00:00 → 明天 00:00；weekly = 近 7 天（含今天）。
 *      绝不 `CURDATE()`（DB 会话时区与 Node 可能不一致，会算错一天）。
 *   4. **达成值不缓存**：四个查询每次实时算——目标页是低频只读页，不值得引入缓存失效问题。
 */
@Injectable()
export class GoalsService {
  constructor(
    private readonly goalsRepo: GoalsRepository,
    private readonly logsRepo: SpecialPracticeLogsRepository,
    private readonly mainErrorRepo: MainErrorBooksRepository,
    private readonly analyticsRepo: ParentAnalyticsRepository,
  ) {}

  async getAttainment(studentId: number): Promise<GoalAttainmentSummary> {
    await this.goalsRepo.ensureDefaults(studentId, GOAL_DEFAULTS);
    const rows = await this.goalsRepo.findActiveByStudent(studentId);

    const items = await Promise.all(
      rows
        // 脏数据防御：`metric` 为 NULL 的历史行（迁移已回填，手工改库仍可能留下）不入响应——
        // 前端按 metric 渲染，收到 null 会渲染出一个没有名字的目标。
        .filter((r): r is typeof r & { metric: GoalMetric } => r.metric !== null)
        .map(async (r): Promise<GoalAttainmentItem> => {
          const achieved = await this.achievedOf(studentId, r.metric);
          return {
            metric: r.metric,
            period: PERIOD_BY_METRIC[r.metric],
            title: r.title,
            target: r.targetValue,
            achieved,
            rate: toRate(r.targetValue, achieved),
          };
        }),
    );
    // 稳定排序：按 GOAL_DEFAULTS 的顺序（家长看到的顺序不随 id 漂移）
    const order = new Map(GOAL_DEFAULTS.map((d, i) => [d.metric, i]));
    items.sort((a, b) => (order.get(a.metric) ?? 99) - (order.get(b.metric) ?? 99));
    return { items };
  }

  async upsertTarget(
    studentId: number,
    metric: GoalMetric,
    target: number,
  ): Promise<GoalAttainmentItem> {
    const period = PERIOD_BY_METRIC[metric];
    await this.goalsRepo.upsertTarget(studentId, metric, period, TITLE_BY_METRIC[metric], target);
    const achieved = await this.achievedOf(studentId, metric);
    return {
      metric,
      period,
      title: TITLE_BY_METRIC[metric],
      target,
      achieved,
      rate: toRate(target, achieved),
    };
  }

  /** 窗口：`daily` = 今天 → 明天；`weekly` = 近 7 天（含今天）→ 明天。半开区间 `< endExclusive`。 */
  private windowOf(period: GoalPeriod): { start: Date; endExclusive: Date } {
    const start = startOfDaysAgo(period === 'daily' ? 0 : 6);
    const today = startOfDaysAgo(0);
    return { start, endExclusive: new Date(today.getTime() + DAY_MS) };
  }

  private async achievedOf(studentId: number, metric: GoalMetric): Promise<number> {
    const { start, endExclusive } = this.windowOf(PERIOD_BY_METRIC[metric]);
    switch (metric) {
      case 'daily_study_minutes': {
        const seconds = await this.analyticsRepo.getStudyTimeTotal(studentId, start, endExclusive);
        return Math.floor(seconds / 60); // 向下取整：59 秒不算 1 分钟，不虚报达成
      }
      case 'daily_words': {
        const rows = await this.logsRepo.aggregateByModule(studentId, start, endExclusive);
        return rows.find((r) => r.module === 'en_vocabulary')?.units ?? 0;
      }
      case 'weekly_passages':
        return this.logsRepo.countDistinctPassages(studentId, start, endExclusive);
      case 'weekly_clear_errors':
        return this.mainErrorRepo.countClearedBetween(studentId, start, endExclusive);
    }
  }
}
