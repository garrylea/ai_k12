/**
 * 训练配置页共享：按 `taskCode` 取积分档位（`GET /points/me/rules`）。
 *
 * 为什么抽成一个模块：数学专项与背单词两个配置页对同一份后端档位数据的要求**逐字一致**——
 * `remainingToday === 0` 只置灰、**不禁用**（不发分也让孩子练，计划 §3 Task 6），
 * 空 `tiers` 不给默认档位（计划 §1.1#2，写了 `tiers[0].tierKey` 会崩）。
 * 这段规则原先在两个页面各抄了一份、没有跨文件测试，改一处漏一处就会让两个页面对
 * 同一后端数据表现不同。按钮长什么样（`TierChip` / 卡片）各页不同，仍留在页面里。
 */
import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { getMyPointRules, type PointRuleTier } from '@/services/api';

/** 档位拉取失败的固定 copy；不回显原始 `err.message`（HTTP 错误串对小学生无意义）。 */
export const TIER_LOAD_ERROR = '档位加载失败，请重试';

/**
 * 档位副行的次数文案；不限次数或次数未计算时 `text` 为 null。
 * `capped`（今日已达上限）只置灰，**不禁用**——不发分也让孩子练（计划 §3 Task 6）。
 */
export function tierStatus(tier: PointRuleTier): { text: string | null; capped: boolean } {
  if (tier.dailyLimit == null || tier.remainingToday == null) return { text: null, capped: false };
  if (tier.remainingToday === 0) return { text: '今日已达上限', capped: true };
  return { text: `剩余 ${tier.remainingToday} 次`, capped: false };
}

/** `tiers == null` = 还没拉到（渲染骨架）；`[]` = 家长把档位全下架（显示停用文案）。 */
export interface PointTiersState {
  tiers: PointRuleTier[] | null;
  tierKey: string | null;
  setTierKey: Dispatch<SetStateAction<string | null>>;
  error: string | null;
  retry: () => void;
}

/**
 * 拉取并持有 `taskCode` 对应的档位。
 *
 * - 默认选中第一档；**空数组不给默认值**，`tierKey` 保持 null（计划 §1.1#2）。
 * - `retry()` 会先清 `error` 再请求，所以重试期间回到骨架态，而不是停在错误页。
 * - 调用方提交前必须自己判 `tierKey != null`（`count: Number(tierKey)` 只在选中后才成立）。
 */
export function usePointTiers(taskCode: string): PointTiersState {
  const [tiers, setTiers] = useState<PointRuleTier[] | null>(null);
  const [tierKey, setTierKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await getMyPointRules();
      // `?? []` 的取舍（裁决确认可接受）：后端恒为该 taskCode 下发一个任务组，
      // 所以「找不到任务组」本不该发生；用 `?? []` 让它退化成空档位（显示
      // 「家长已停用该任务」+ 禁用开练）而不是抛错。代价是万一 taskCode 被改名/漏发，
      // 会显示一句看似合理但成因不同的停用文案——后端恒发组的前提下这个已知偏差可接受。
      const list = data.tasks.find((t) => t.taskCode === taskCode)?.tiers ?? [];
      setTiers(list);
      setTierKey(list.length > 0 ? list[0].tierKey : null);
    } catch {
      setError(TIER_LOAD_ERROR);
      setTiers(null);
      setTierKey(null);
    }
  }, [taskCode]);

  useEffect(() => {
    void load();
  }, [load]);

  return { tiers, tierKey, setTierKey, error, retry: load };
}

/**
 * 数学专项练习的任务代号（`GET /points/me/rules` 返回的 `taskCode`）。
 *
 * **单一真源**：专项配置页与薄弱点图谱页都从这里 import。以前两页各写一份字面量，
 * 哪天后端/别处改了这个代号而只改一处 → 图谱页查不到档位 → 「开始补这个」不渲染，
 * 学生只看到一个莫名其妙的缺失动作（专项配置页那侧则照旧能用）。
 */
export const MATH_TASK_CODE = 'math_targeted';

/**
 * 专项练习的最小题量（spec §10 裁决：1 题偏少，改取「≥3 的最小可用档」）。
 */
export const MIN_PRACTICE_COUNT = 3;

/**
 * 从可用档位里挑一个开练题量（薄弱点图谱「开始补这个」用）。
 *
 * 规则（spec §6.3）：
 * 1. 取 **≥ `MIN_PRACTICE_COUNT` 的最小档**（默认档位 `1/3/5/10` 下即 3）
 * 2. 若可用档**全部 < 3**（家长只留了 1 题档）→ 退化为其中**最大**的一档，**不报错**
 * 3. 一个可用档都没有（空数组 / 全非数字）→ `null`，调用方据此**不渲染开练按钮**，
 *    不硬发请求（否则会被 `targeted/start` 以 400 拒绝）
 *
 * `tierKey` 对 `math_targeted` 是纯数字字符串（家长端不能新增档位），可直接 `Number()`。
 */
export function pickPracticeCount(tiers: Array<{ tierKey: string }>): number | null {
  const counts = tiers
    .map((t) => Number(t.tierKey))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (counts.length === 0) return null;

  const usable = counts.filter((n) => n >= MIN_PRACTICE_COUNT);
  if (usable.length > 0) return Math.min(...usable);
  return Math.max(...counts);
}
