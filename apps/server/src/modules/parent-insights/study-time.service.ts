import { Inject, Injectable, Logger } from '@nestjs/common';
import { ParentAnalyticsRepository } from '../../database/repositories/parent-analytics.repo.js';
import { ControlsRepository } from '../../database/repositories/controls.repo.js';
import { StudySessionsService } from '../analytics/study-sessions.service.js';
import { resolveRange, startOfDaysAgo, toDayString } from './window.util.js';
import type { StudyTimeSummary, TodayUsageSummary } from './dto/parent-insights.dto.js';

@Injectable()
export class StudyTimeService {
  private readonly logger = new Logger(StudyTimeService.name);

  constructor(
    @Inject(ParentAnalyticsRepository) private readonly repo: ParentAnalyticsRepository,
    @Inject(ControlsRepository) private readonly controls: ControlsRepository,
    @Inject(StudySessionsService) private readonly sessions: StudySessionsService,
  ) {}

  /**
   * 学习时长（spec §8.2）。窗口缺省 = 近 7 天；`source: 'sessions'` 是**口径标记**——
   * 家长端同时还有一套「活跃天数」（四路时间戳代理），响应里必须能分辨哪个是哪个。
   *
   * ⚠️ 这个数字与「近 7 天活跃天数」**不是同一回事**（spec §10）：孩子挂机不答题 →
   * 旧口径不活跃，但页面开着就有新时长；反之只看一页不操作也可能两边都不算。
   * 永远不要把两者合并或相互替换。
   */
  async getStudyTime(studentId: number, from?: string, to?: string): Promise<StudyTimeSummary> {
    const window = resolveRange(from, to);
    await this.closeStaleQuietly(studentId);

    const [totalSeconds, activeDays, byDay, byModule, bySubject] = await Promise.all([
      this.repo.getStudyTimeTotal(studentId, window.start, window.endExclusive),
      this.repo.getActiveDays(studentId, window.start, window.endExclusive),
      this.repo.getStudyTimeByDay(studentId, window.start, window.endExclusive),
      this.repo.getStudyTimeByModule(studentId, window.start, window.endExclusive),
      this.repo.getStudyTimeBySubject(studentId, window.start, window.endExclusive),
    ]);

    return {
      totalSeconds,
      activeDays,
      byDay: byDay.map((r) => ({ date: r.day, seconds: r.seconds })),
      byModule,
      bySubject,
      source: 'sessions',
    };
  }

  /**
   * 今日已用时长（spec §8.2）——补齐 `controls.daily_time_limit_minutes` 的另一半。
   *
   * `limitMinutes: null` = 家长未设限 → `exceeded: false`（**不是**「超了」，
   * 也不是「用了 0 分钟」）。`exceeded` 用 `>=`：管控语义是「用满了就该停」。
   */
  async getTodayUsage(studentId: number): Promise<TodayUsageSummary> {
    const today = toDayString(startOfDaysAgo(0));
    const window = resolveRange(today, today);
    await this.closeStaleQuietly(studentId);

    const [activeSeconds, limitMinutes, byModule] = await Promise.all([
      this.repo.getStudyTimeTotal(studentId, window.start, window.endExclusive),
      this.controls.findDailyTimeLimit(studentId),
      this.repo.getStudyTimeByModule(studentId, window.start, window.endExclusive),
    ]);

    return {
      date: today,
      activeSeconds,
      limitMinutes,
      exceeded: limitMinutes !== null && activeSeconds >= limitMinutes * 60,
      byModule,
    };
  }

  /**
   * 惰性收尾必须**吞掉异常**：它只是为了让「今日已用」更准，失败时按已收尾的数据返回即可。
   * 让一次收尾失败把家长的整个页面打成 500，是本末倒置。
   */
  private async closeStaleQuietly(studentId: number): Promise<void> {
    try {
      await this.sessions.closeStale(studentId);
    } catch (err) {
      this.logger.warn(`closeStale(${studentId}) 失败，本次按现状聚合：${String(err)}`);
    }
  }
}
