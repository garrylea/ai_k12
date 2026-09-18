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
function toDayString(d: Date): string {
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
