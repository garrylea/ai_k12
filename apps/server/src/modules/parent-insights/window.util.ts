/**
 * 家长端报告的时间窗（spec §4.2 ②）。
 *
 * 口径：`weekly` = 近 7 天（含今天）、`monthly` = 近 30 天。`windowStart` / `windowEnd` 都是
 * **日期**，SQL 上用 `>= start` 与 `< endExclusive` 表达闭区间——半开区间跨月/跨年无需拼接。
 *
 * 一律按**服务器本地时区**的 00:00 算：刻意不在 SQL 里用 `CURDATE()`，因为 DB 会话时区与
 * 应用可能不一致，会算错一天（`point-ledger.repo.ts` 的既有约定）。
 */
export type ReportPeriod = 'weekly' | 'monthly';

export interface ReportWindow {
  start: Date;
  /** 窗口末日的**次日** 00:00（SQL 用 `<`）。 */
  endExclusive: Date;
  /** `YYYY-MM-DD`，给响应体回显。 */
  startDay: string;
  endDay: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 本地时区某天的 00:00。 */
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** N 天前的 00:00（`0` = 今天）。 */
export function startOfDaysAgo(days: number): Date {
  const today = startOfDay(new Date());
  return new Date(today.getTime() - days * DAY_MS);
}

/** `YYYY-MM-DD`（本地时区；**不用** `toISOString()`——那会按 UTC 切，跨时区差一天）。 */
export function toDayString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function resolveWindow(period: ReportPeriod): ReportWindow {
  const days = period === 'monthly' ? 30 : 7;
  const start = startOfDaysAgo(days - 1);
  const endInclusive = startOfDaysAgo(0);
  const endExclusive = new Date(endInclusive.getTime() + DAY_MS);
  return {
    start,
    endExclusive,
    startDay: toDayString(start),
    endDay: toDayString(endInclusive),
  };
}

/** 把 `YYYY-MM-DD` 解析为**本地时区**当天 00:00；形状不合法或日期不存在（如 2026-02-30）→ null。 */
function parseDayString(raw: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  // 挡掉 2026-02-30 这类「Date 会静默滚到 3 月」的输入
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) {
    return null;
  }
  return d;
}

const DEFAULT_RANGE_DAYS = 7;

/**
 * 显式日期区间 → 报告窗口。用于 `study-time` 的 `from`/`to`（spec §8.2）。
 *
 * 宽容回落：查询类参数非法**不 400**（与 `PeriodSchema` 对 `period` 的处理一致）——
 * 一个拼错的日期不应该让家长看到错误页。缺省 = 近 7 天。
 * `from > to` 时自动交换：宁可给出「反着的窗口」也不要给空窗口。
 */
export function resolveRange(from?: string, to?: string): ReportWindow {
  const parsedTo = to ? parseDayString(to) : null;
  const endInclusive = parsedTo ?? startOfDaysAgo(0);
  let start = (from ? parseDayString(from) : null) ?? new Date(endInclusive.getTime() - (DEFAULT_RANGE_DAYS - 1) * DAY_MS);
  let end = endInclusive;
  if (start.getTime() > end.getTime()) {
    const swap = start;
    start = end;
    end = swap;
  }
  return {
    start,
    endExclusive: new Date(end.getTime() + DAY_MS),
    startDay: toDayString(start),
    endDay: toDayString(end),
  };
}
