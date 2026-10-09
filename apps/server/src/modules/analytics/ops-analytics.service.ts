import { BadRequestException, Injectable } from '@nestjs/common';
import { OpsAnalyticsRepository, type OpsWindow } from './ops-analytics.repo.js';

/**
 * 时间窗解析（母 spec §7 通用纪律）：`from,to` 均为 YYYY-MM-DD，缺省近 7 天（from = 今天-6）。
 * **窗口边界全部在本函数（应用层）算好**，SQL 内禁 CURDATE/NOW。
 *
 * 额外产出 `todayAt/tomorrowAt`：DAU 的口径是「今日有会话」，与查询窗口无关，
 * 所以也必须由这里传参进去（brief Step 3 示例里 `DATE(started_at)=CURDATE()` 的写法违反该约束，已弃）。
 */
export function parseWindow(from?: string, to?: string): OpsWindow {
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const DAY = 86_400_000;
  const now = new Date();
  let toD = now;
  let fromD = new Date(now.getTime() - 6 * DAY);
  if (to) {
    if (!dateRe.test(to)) throw new BadRequestException({ code: 1001, message: 'to 格式应为 YYYY-MM-DD' });
    toD = new Date(`${to}T00:00:00`);
  }
  if (from) {
    if (!dateRe.test(from)) throw new BadRequestException({ code: 1001, message: 'from 格式应为 YYYY-MM-DD' });
    fromD = new Date(`${from}T00:00:00`);
  }
  if (fromD.getTime() > toD.getTime()) {
    throw new BadRequestException({ code: 1001, message: 'from 不能晚于 to' });
  }
  return {
    fromAt: `${fmt(fromD)} 00:00:00`,
    toAt: `${fmt(new Date(toD.getTime() + DAY))} 00:00:00`,
    todayAt: `${fmt(now)} 00:00:00`,
    tomorrowAt: `${fmt(new Date(now.getTime() + DAY))} 00:00:00`,
  };
}

/** 正确率：answered=0 → null（不许写 0，母 spec §7 通用纪律）。 */
const acc = (correct: number, answered: number): number | null =>
  answered === 0 ? null : correct / answered;

@Injectable()
export class OpsAnalyticsService {
  constructor(private readonly repo: OpsAnalyticsRepository) {}

  /** GET /api/admin/analytics/overview。 */
  async overview(q: { from?: string; to?: string }) {
    const w = parseWindow(q.from, q.to);
    const [sess, answers, top] = await Promise.all([
      this.repo.overviewSessions(w),
      this.repo.answerTotals(w),
      this.repo.moduleTop(w),
    ]);
    return {
      dau: sess.dau,
      wau: sess.students,
      totalSeconds: sess.totalSeconds,
      totalAnswers: answers.answered,
      accuracy: acc(answers.correct, answers.answered),
      moduleTop: top.map((r) => ({ module: r.module, students: r.students, seconds: r.seconds })),
    };
  }

  /** GET /api/admin/analytics/modules。 */
  async modules(q: { from?: string; to?: string }) {
    const w = parseWindow(q.from, q.to);
    const rows = await this.repo.modulesWindow(w);
    return {
      items: rows.map((r) => ({
        module: r.module,
        students: r.students,
        seconds: r.seconds,
        answered: r.answered,
        correct: r.correct,
        accuracy: acc(r.correct, r.answered),
      })),
    };
  }
}
