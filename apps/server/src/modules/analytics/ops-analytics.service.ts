import { BadRequestException, Injectable } from '@nestjs/common';
import {
  OpsAnalyticsRepository,
  type FunnelStepFilter,
  type OpsWindow,
} from './ops-analytics.repo.js';

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
  // 往返校验：Node 对 '2026-02-30' 这类「格式合法但日期无效」的输入会滚动到下月而非 Invalid Date，
  // 只查 isNaN 拦不住；解析结果格式化回去与输入全等才放行。
  const parse = (label: 'from' | 'to', s: string): Date => {
    const d = new Date(`${s}T00:00:00`);
    if (isNaN(d.getTime()) || fmt(d) !== s) {
      throw new BadRequestException({ code: 1001, message: `${label} 日期无效` });
    }
    return d;
  };
  const now = new Date();
  let toD = now;
  let fromD = new Date(now.getTime() - 6 * DAY);
  if (to) {
    if (!dateRe.test(to)) throw new BadRequestException({ code: 1001, message: 'to 格式应为 YYYY-MM-DD' });
    toD = parse('to', to);
  }
  if (from) {
    if (!dateRe.test(from)) throw new BadRequestException({ code: 1001, message: 'from 格式应为 YYYY-MM-DD' });
    fromD = parse('from', from);
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

/**
 * 漏斗步骤表（delta spec §7.1 抄死）。module 白名单 = 下列 8 个 key
 * （不含 aux_qna/admin/parent——无漏斗语义，越界 400/1001）。
 */
const FUNNEL_STEPS: Record<string, string[]> = {
  mainline: ['study_session_started', 'answer_submitted', 'points_awarded'],
  exam: ['study_session_started', 'answer_submitted', 'exam_submitted'],
  training_targeted: ['study_session_started', 'answer_submitted'],
  training_error_practice: ['study_session_started', 'answer_submitted'],
  chinese_dictation: ['study_session_started', 'special_unit_judged'],
  chinese_interpretation: ['study_session_started', 'special_unit_judged'],
  chinese_meaning: ['study_session_started', 'special_unit_judged'],
  en_vocabulary: ['study_session_started', 'special_unit_judged'],
};

/**
 * 完课发分的 taskCode——progress.service.ts `awardLessonPoints` 写死的常量
 * 'mainline_lesson'。★裁决（T8 评审遗留）：mainline 漏斗第三步 = points_awarded
 * 且 module IS NULL（points 服务端打点不带 module）且 props.taskCode = 完课码。
 */
const MAINLINE_LESSON_TASK_CODE = 'mainline_lesson';

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

  /**
   * 每步过滤条件：普通步骤 = `module = ?`；mainline 第三步走 ★裁决
   * （points_awarded 打点不带 module，靠完课 taskCode 圈定）。
   * 第一步 study_session_started 由 client 上报（tracker），source 可为 client——不过滤 source。
   */
  private stepFilters(module: string): FunnelStepFilter[] {
    return FUNNEL_STEPS[module].map((event) =>
      module === 'mainline' && event === 'points_awarded'
        ? {
            event,
            extraWhere: "module IS NULL AND props->>'$.taskCode' = ?",
            extraParams: [MAINLINE_LESSON_TASK_CODE],
          }
        : { event, extraWhere: 'module = ?', extraParams: [module] },
    );
  }

  /** GET /api/admin/analytics/funnel。 */
  async funnel(q: { module: string; from?: string; to?: string }) {
    const steps = FUNNEL_STEPS[q.module];
    if (!steps) {
      throw new BadRequestException({ code: 1001, message: 'module 不在漏斗白名单内' });
    }
    const w = parseWindow(q.from, q.to);
    const counts = await this.repo.funnel(w, this.stepFilters(q.module));
    const stepRows = steps.map((event) => ({ event, students: counts.get(event) ?? 0 }));
    const conversions = stepRows.map((s, i) => {
      if (i === 0) return null;
      const prev = stepRows[i - 1].students;
      return prev > 0 ? s.students / prev : null;
    });
    return { module: q.module, steps: stepRows, conversions };
  }

  /** GET /api/admin/analytics/events。全部 tier；分页 20，page 从 1 起。 */
  async events(q: { event?: string; module?: string; from?: string; to?: string; page?: string }) {
    const page = q.page === undefined || q.page === '' ? 1 : Number(q.page);
    if (!Number.isInteger(page) || page < 1) {
      throw new BadRequestException({ code: 1001, message: 'page 应为正整数' });
    }
    const pageSize = 20;
    const w = parseWindow(q.from, q.to);
    const { rows, total } = await this.repo.eventsPage({
      event: q.event?.trim() || undefined,
      module: q.module?.trim() || undefined,
      fromAt: w.fromAt,
      toAt: w.toAt,
      offset: (page - 1) * pageSize,
      limit: pageSize,
    });
    return { items: rows, page, pageSize, total };
  }
}
