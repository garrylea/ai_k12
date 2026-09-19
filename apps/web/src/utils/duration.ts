/**
 * 秒 → 中文时长文案。家长端多处共用（仪表盘卡片 / 报告页数字卡 / 每日柱状图 tooltip）。
 *
 * 不足 1 分钟显示「不足 1 分钟」而不是「0 分钟」：后者读起来像「今天没学」，
 * 与「学了 40 秒」是两回事——和 `rate: null → 暂无数据` 是同一条纪律。
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 60) return '不足 1 分钟';

  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) return `${minutes} 分钟`;
  if (minutes === 0) return `${hours} 小时`;
  return `${hours} 小时 ${minutes} 分`;
}
