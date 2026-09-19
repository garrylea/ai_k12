import { useEffect, useState } from 'react';
import { Card } from '@/components/base';
import ChartBar from '@/components/business/parent/ChartBar';
import { getParentSpecials, type ParentSpecialModule, type ParentSpecials } from '@/services/api';

/**
 * 四个模块的展示名与取值键。
 *
 * `units` 的含义**各模块不同**（默写=篇、解释/含义=句、背单词=题），所以单位词也各写各的——
 * 统一写「个」会让家长以为「3」是同一回事。
 */
const MODULES: ReadonlyArray<{
  key: keyof ParentSpecials;
  label: string;
  unit: string;
}> = [
  { key: 'dictation', label: '语文默写', unit: '篇' },
  { key: 'interpretation', label: '语文解释', unit: '句' },
  { key: 'meaning', label: '语文含义', unit: '句' },
  { key: 'vocabulary', label: '英语背单词', unit: '题' },
];

/** `rate === null` = 本期没有可判对错的作答 → 「暂无数据」，**不要**显示成 0%。 */
function rateText(rate: number | null): string {
  return rate === null ? '暂无数据' : `${rate}%`;
}

/**
 * 把四个模块的 `byDay` 合并成一条「每天总作答数」序列（喂柱状图）。
 *
 * 四个模块的日期集合可能不同（某天只背了单词），所以按日期聚合而不是按下标对齐。
 */
function mergeByDay(value: ParentSpecials): Array<{ label: string; value: number }> {
  const total = new Map<string, number>();
  for (const { key } of MODULES) {
    const mod: ParentSpecialModule = value[key];
    for (const d of mod.byDay) {
      total.set(d.date, (total.get(d.date) ?? 0) + d.count);
    }
  }
  return [...total.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, count]) => ({ label: date.slice(5), value: count }));
}

/**
 * 仪表盘「专项学情」卡（埋点 Phase 1B）。
 *
 * 数据自己取（只收 `studentId`）：每个孩子一张卡，父组件不替它取数，
 * 免得 `StudentPanel` 变成一个什么都得先拉一遍的聚合点。
 *
 * 三条纪律：
 *   1. **派生值带 `studentId` 归属**——切 Tab 不重挂载，只在 effect 里清空会闪上一个孩子的数字。
 *   2. **取数失败静默降级**为「暂无数据」：专项是增值信息，不该让整个仪表盘报错
 *      （与既有 `StudyTimePanel` 同款）。
 *   3. 与「学习时长」卡**并列不替代**：那张是会话时长，这张是专项作答量，两套口径。
 */
export default function SpecialsPanel({ studentId }: { studentId: number }) {
  const [data, setData] = useState<{ studentId: number; value: ParentSpecials } | null>(null);

  const value = data && data.studentId === studentId ? data.value : null;

  useEffect(() => {
    let cancelled = false;
    getParentSpecials(studentId)
      .then((res) => {
        if (cancelled) return;
        setData({ studentId, value: res });
      })
      .catch(() => {
        // 增值信息：取不到不影响既有概览，静默降级（下面渲染成「暂无数据」）
      });
    return () => {
      cancelled = true;
    };
  }, [studentId]);

  return (
    <Card className="p-5" data-testid={`dashboard-special-${studentId}`}>
      <h3 className="text-base font-bold text-[var(--text-primary)]">
        专项学情
        <span className="ml-2 text-xs font-normal text-[var(--text-tertiary)]">（近 7 天）</span>
      </h3>

      <ul className="mt-3 space-y-2">
        {MODULES.map(({ key, label, unit }) => {
          const mod = value?.[key];
          return (
            <li
              key={key}
              data-testid={`special-row-${key}`}
              className="flex items-center justify-between text-sm"
            >
              <span className="text-[var(--text-primary)]">{label}</span>
              <span className="text-[var(--text-secondary)]">
                {mod ? `${mod.units} ${unit} · ${rateText(mod.rate)}` : '暂无数据'}
                {key === 'vocabulary' && value && value.vocabulary.newWords > 0 && (
                  <span className="ml-2 text-xs text-[var(--text-tertiary)]">
                    {`答对 ${value.vocabulary.newWords} 词`}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>

      {/* 只喂数据、不管空态：`ChartBar` 自带「暂无数据」（空数组时） */}
      <div className="mt-3">
        <ChartBar points={value ? mergeByDay(value) : []} height={160} />
      </div>
    </Card>
  );
}
