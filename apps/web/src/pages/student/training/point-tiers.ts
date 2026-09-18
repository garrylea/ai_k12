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
