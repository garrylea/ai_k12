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
 * 全量段位表（9 档，按 threshold 升序，`index` 与数组下标一致）。
 *
 * 单一真源：家长端配奖励门槛（`minLevelCode` 九选一）需要完整清单，前端**不得**
 * 自己维护一份段位表。复用 `toInfo`，勿在 controller 里重算 `index` / `threshold`。
 * 返回**新数组**（`LEVELS` 本身不动），调用方想怎么用都可以。
 */
export function allLevels(): LevelInfo[] {
  return LEVELS.map((_, i) => toInfo(i));
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
 * 当前档内进度百分比，0-100 整数（向下取整）。
 * 分母 = next.threshold - cur.threshold；满级直接 100，避免除零。
 *
 * 取整必须用 floor 而不是 round：因为 levelOf 在 earned >= next.threshold 时
 * 就已经晋级，所以进到这里必然有 done < span，floor 的结果上界是 99，
 * 绝不可能在未达阈值时给出满格进度条。round 则会在 done / span >= 99.5% 时
 * 报 100，与同模块的 pointsToNextLevel「还差 N 分」自相矛盾
 * （例：星耀→王者 span 8000，19980 分会显示 100% 但实际还差 20 分）。
 *
 * 契约：本函数返回 100 **仅**经过 next === null（真满级王者）或 span <= 0 兜底分支。
 */
export function progressPercent(totalEarned: number): number {
  const cur = levelOf(totalEarned);
  const next = nextLevelOf(totalEarned);
  if (next === null) return 100;
  const span = next.threshold - cur.threshold;
  if (span <= 0) return 100;
  const done = Math.max(0, totalEarned) - cur.threshold;
  return Math.min(100, Math.max(0, Math.floor((done / span) * 100)));
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
