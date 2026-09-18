/**
 * 正确率的**唯一**计算口径（spec §4.3）：一位小数。
 *
 * `answered = 0` 时返回 `null`，**不是 0** —— 0 会被家长读成「全错了」，那是另一回事，
 * 而「还没做过」应当显示为「暂无数据」。仪表盘与报告页共用这一份，勿各写一套。
 */
export function toRate(answered: number, correct: number): number | null {
  if (answered <= 0) return null;
  return Math.round((correct / answered) * 1000) / 10;
}
