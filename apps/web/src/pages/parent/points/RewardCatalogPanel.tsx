import { Card } from '@/components/base';

/**
 * 「奖励清单」Tab（计划三 §2.5，Task 6 填内容）。
 *
 * 接缝同 `PointRulesPanel`：`studentId` 由页面下发、草稿留在本组件内、页面在
 * 切孩子时重挂载本组件。奖励清单的「整表 PUT 必须带回下架行的 `isActive`」
 * 这条硬规则属于 Task 6，占位阶段不做。
 */
export interface RewardCatalogPanelProps {
  studentId: number;
}

export default function RewardCatalogPanel({ studentId }: RewardCatalogPanelProps) {
  return (
    <Card className="p-6" data-student-id={studentId}>
      <h2 className="text-base font-bold text-[var(--text-primary)]">奖励清单</h2>
      <p className="mt-2 text-sm text-[var(--text-secondary)]">奖励清单管理待实现。</p>
      <p className="mt-1 text-xs text-[var(--text-tertiary)]">
        将在此新增奖励、设置所需积分与段位门槛，并支持上下架与排序。
      </p>
    </Card>
  );
}
