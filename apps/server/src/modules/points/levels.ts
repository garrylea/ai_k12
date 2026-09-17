export const LEVELS = [
  { code: 'pichai',   name: '劈柴', threshold: 0 },
  { code: 'zhutie',   name: '铸铁', threshold: 500 },
  { code: 'qingtong', name: '青铜', threshold: 1200 },
  { code: 'baiyin',   name: '白银', threshold: 2000 },
  { code: 'huangjin', name: '黄金', threshold: 3000 },
  { code: 'bojin',    name: '铂金', threshold: 5000 },
  { code: 'zuanshi',  name: '钻石', threshold: 8000 },
  { code: 'xingyao',  name: '星耀', threshold: 12000 },
  { code: 'wangzhe',  name: '王者', threshold: 20000 },
] as const;

export type LevelCode = (typeof LEVELS)[number]['code'];

export interface LevelInfo { code: LevelCode; name: string; index: number; threshold: number }

function toInfo(i: number): LevelInfo {
  return { code: LEVELS[i].code, name: LEVELS[i].name, index: i, threshold: LEVELS[i].threshold };
}

/**
 * 取 threshold <= totalEarned 的最大档（从后往前找第一个命中）。
 * totalEarned 单调递增 → 段位只升不降，**不需要也不该有降级逻辑**。
 * 负数按 0 处理（脏数据兜底），返回劈柴。
 */
export function levelOf(totalEarned: number): LevelInfo {
  const earned = Math.max(0, totalEarned);
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    if (LEVELS[i].threshold <= earned) return toInfo(i);
  }
  return toInfo(0);
}

/** 下一档；已满级（王者）返回 null。 */
export function nextLevelOf(totalEarned: number): LevelInfo | null {
  const cur = levelOf(totalEarned);
  return cur.index === LEVELS.length - 1 ? null : toInfo(cur.index + 1);
}

/** 距下一档还差多少分；满级返回 null。 */
export function pointsToNextLevel(totalEarned: number): number | null {
  const next = nextLevelOf(totalEarned);
  return next === null ? null : next.threshold - Math.max(0, totalEarned);
}

/**
 * 当前档内进度百分比 0-100（整数，四舍五入）。
 * 分母 = next.threshold - cur.threshold；满级直接 100，避免除零。
 */
export function progressPercent(totalEarned: number): number {
  const cur = levelOf(totalEarned);
  const next = nextLevelOf(totalEarned);
  if (next === null) return 100;
  const span = next.threshold - cur.threshold;
  if (span <= 0) return 100;
  const done = Math.max(0, totalEarned) - cur.threshold;
  return Math.min(100, Math.max(0, Math.round((done / span) * 100)));
}

/** 用 totalEarned 反查是否跨档：award 前 oldEarned → award 后 newEarned。 */
export function detectLevelUp(
  oldEarned: number,
  newEarned: number,
): { from: LevelInfo; to: LevelInfo } | null {
  const from = levelOf(oldEarned);
  const to = levelOf(newEarned);
  return to.index > from.index ? { from, to } : null;
}
