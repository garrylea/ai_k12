import { BadRequestException, Injectable } from '@nestjs/common';
import {
  OpsAnalyticsRepository,
  type DeviceDistRow,
  type FunnelStepFilter,
  type OpsWindow,
} from './ops-analytics.repo.js';

const DAY = 86_400_000;

/** Date → 'YYYY-MM-DD'（本地时区，与窗口解析同一口径）。 */
function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 'YYYY-MM-DD' 严格解析：格式校验 + 往返校验（Node 对 '2026-02-30' 这类
 * 「格式合法但日期无效」的输入会滚动到下月而非 Invalid Date，只查 isNaN 拦不住；
 * 解析结果格式化回去与输入全等才放行）。非法 → 400/1001。
 */
function parseYmd(label: string, s: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new BadRequestException({ code: 1001, message: `${label} 格式应为 YYYY-MM-DD` });
  }
  const d = new Date(`${s}T00:00:00`);
  if (isNaN(d.getTime()) || fmtDate(d) !== s) {
    throw new BadRequestException({ code: 1001, message: `${label} 日期无效` });
  }
  return d;
}

/**
 * 时间窗解析（母 spec §7 通用纪律）：`from,to` 均为 YYYY-MM-DD，缺省近 7 天（from = 今天-6）。
 * **窗口边界全部在本函数（应用层）算好**，SQL 内禁 CURDATE/NOW。
 *
 * 额外产出 `todayAt/tomorrowAt`：DAU 的口径是「今日有会话」，与查询窗口无关，
 * 所以也必须由这里传参进去（brief Step 3 示例里 `DATE(started_at)=CURDATE()` 的写法违反该约束，已弃）。
 */
export function parseWindow(from?: string, to?: string): OpsWindow {
  const now = new Date();
  let toD = now;
  let fromD = new Date(now.getTime() - 6 * DAY);
  if (to) toD = parseYmd('to', to);
  if (from) fromD = parseYmd('from', from);
  if (fromD.getTime() > toD.getTime()) {
    throw new BadRequestException({ code: 1001, message: 'from 不能晚于 to' });
  }
  return {
    fromAt: `${fmtDate(fromD)} 00:00:00`,
    toAt: `${fmtDate(new Date(toD.getTime() + DAY))} 00:00:00`,
    todayAt: `${fmtDate(now)} 00:00:00`,
    tomorrowAt: `${fmtDate(new Date(now.getTime() + DAY))} 00:00:00`,
  };
}

/** 正确率：answered=0 → null（不许写 0，母 spec §7 通用纪律）。 */
const acc = (correct: number, answered: number): number | null =>
  answered === 0 ? null : correct / answered;

/** cohort-compare 的 metric 白名单（命名与 delta spec 一致）。 */
const COMPARE_METRICS = ['totalSeconds', 'answerCount', 'accuracy', 'daysActive'] as const;

/** cohort-compare 的 outcome 白名单：设备三列 + module（browser/input_type 不在列）。 */
const COMPARE_OUTCOMES = ['platform_class', 'screen_class', 'app_shell', 'module'] as const;

/** retention 的 days 参数：1-365 的逗号分隔正整数，缺省 '1,7,30'；去重升序，越界 400/1001。 */
function parseRetentionDays(raw?: string): number[] {
  const s = raw === undefined || raw === '' ? '1,7,30' : raw;
  const out = new Set<number>();
  for (const token of s.split(',')) {
    const v = Number(token.trim());
    if (!Number.isInteger(v) || v < 1 || v > 365) {
      throw new BadRequestException({ code: 1001, message: 'days 应为 1-365 的逗号分隔正整数' });
    }
    out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

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

  /**
   * GET /api/admin/analytics/retention。
   * cohort = 首活跃日（MIN(DATE(started_at))）= cohortStart 当天的学生；
   * D{n} = cohort 学生在 cohortStart+n 当日有会话的人头占比（日边界应用层算好传参）。
   * days 缺省 '1,7,30'（去重升序），越界 400/1001；cohortSize=0 → 各 rate null。
   */
  async retention(q: { cohortStart?: string; days?: string }) {
    if (!q.cohortStart) {
      throw new BadRequestException({ code: 1001, message: 'cohortStart 必填（YYYY-MM-DD）' });
    }
    const startD = parseYmd('cohortStart', q.cohortStart);
    const offsets = parseRetentionDays(q.days);
    const cohortIds = await this.repo.retentionCohort(q.cohortStart);
    const cohortSize = cohortIds.length;
    if (cohortSize === 0) {
      return {
        cohortStart: q.cohortStart,
        cohortSize,
        days: offsets.map((offset) => ({ offset, retained: 0, rate: null })),
      };
    }
    const rows = await Promise.all(
      offsets.map(async (offset) => ({
        offset,
        retained: await this.repo.retentionDay(
          cohortIds,
          `${fmtDate(new Date(startD.getTime() + offset * DAY))} 00:00:00`,
          `${fmtDate(new Date(startD.getTime() + (offset + 1) * DAY))} 00:00:00`,
        ),
      })),
    );
    return {
      cohortStart: q.cohortStart,
      cohortSize,
      days: rows.map((r) => ({
        offset: r.offset,
        retained: r.retained,
        rate: r.retained / cohortSize,
      })),
    };
  }

  /**
   * GET /api/admin/analytics/devices。
   * accuracy 只给 platformClass（brief 裁决）：口径 = 「窗口内用过该平台类的学生的
   * 窗口内全部 answer_submitted」（repo.answersByOutcome 学生近似口径），该组无人答题
   * 或从未被统计到 → null；其余四维 accuracy 恒 null（页面隐藏该列）。
   */
  async devices(q: { from?: string; to?: string }) {
    const w = parseWindow(q.from, q.to);
    const [dist, accRows, multi, sw] = await Promise.all([
      this.repo.deviceDistributions(w),
      this.repo.answersByOutcome(w, 'platform_class'),
      this.repo.multiDevice(w),
      this.repo.switches(w),
    ]);
    const accByKey = new Map(accRows.map((r) => [r.key, acc(r.correct, r.answered)]));
    const plain = (rows: DeviceDistRow[]) =>
      rows.map((r) => ({
        key: r.key,
        students: r.students,
        seconds: r.seconds,
        sessions: r.sessions,
        accuracy: null,
      }));
    return {
      distributions: {
        platformClass: dist.platform_class.map((r) => ({
          key: r.key,
          students: r.students,
          seconds: r.seconds,
          sessions: r.sessions,
          accuracy: accByKey.get(r.key) ?? null,
        })),
        screenClass: plain(dist.screen_class),
        inputType: plain(dist.input_type),
        appShell: plain(dist.app_shell),
        browser: plain(dist.browser),
      },
      multiDevice: multi.map((r) => ({ count: r.count, students: r.students })),
      switches: { count: sw.count, students: sw.students },
    };
  }

  /**
   * GET /api/admin/analytics/cohort-compare。
   * 每组 value 口径（service 定义）：
   * - totalSeconds：组内 SUM(active_seconds) ÷ 组内学生数（0 人 → null）；
   * - daysActive：组内「学生×日期」去重天数 ÷ 组内学生数（0 人 → null）；
   * - answerCount：组内 answer_submitted 计数 ÷ 组内（有答题的）学生数（0 人 → null）；
   * - accuracy：SUM(verdict='correct') ÷ answered，answered=0 → null（不许写 0）。
   * totalSeconds/daysActive 走时长侧（study_sessions，module 取 study_sessions.module）；
   * answerCount/accuracy 走答题侧（behavior_events，module 取 behavior_events.module；
   * 设备列由 repo 按学生近似关联）。
   * groups[].students = 该 metric 自身侧的去重学生数。结果仅描述相关性，响应必带 disclaimer。
   */
  async cohortCompare(q: { metric?: string; outcome?: string; from?: string; to?: string }) {
    const metric = COMPARE_METRICS.find((m) => m === q.metric);
    if (!metric) {
      throw new BadRequestException({ code: 1001, message: 'metric 不在白名单内' });
    }
    const outcome = COMPARE_OUTCOMES.find((o) => o === q.outcome);
    if (!outcome) {
      throw new BadRequestException({ code: 1001, message: 'outcome 不在白名单内' });
    }
    const w = parseWindow(q.from, q.to);
    let groups: { key: string; students: number; value: number | null }[];
    if (metric === 'totalSeconds' || metric === 'daysActive') {
      const rows = await this.repo.sessionsByOutcome(w, outcome);
      groups = rows.map((r) => ({
        key: r.key,
        students: r.students,
        value:
          r.students === 0
            ? null
            : metric === 'totalSeconds'
              ? r.seconds / r.students
              : r.studentDays / r.students,
      }));
    } else {
      const rows = await this.repo.answersByOutcome(w, outcome);
      groups = rows.map((r) => ({
        key: r.key,
        students: r.students,
        value:
          metric === 'answerCount'
            ? r.students === 0
              ? null
              : r.answered / r.students
            : acc(r.correct, r.answered),
      }));
    }
    groups.sort((a, b) => b.students - a.students || a.key.localeCompare(b.key));
    return { metric, outcome, groups, disclaimer: 'correlation-not-causation' };
  }
}
