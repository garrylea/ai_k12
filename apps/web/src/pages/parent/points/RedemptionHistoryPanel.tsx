import { Card } from '@/components/base';

/**
 * 「兑换记录」Tab（计划三 §2.7，Task 8 填内容）。
 *
 * 接缝同 `PointRulesPanel`：`studentId` 由页面下发、分页与筛选状态留在本组件内、
 * 页面在切孩子时重挂载本组件（翻到第 3 页再切孩子不会错配到别的孩子）。
 * 空态里跳「兑换」Tab 用 `<Link to="/parent/rewards?tab=redeem">`，无需额外 props。
 */
export interface RedemptionHistoryPanelProps {
  studentId: number;
}

export default function RedemptionHistoryPanel({ studentId }: RedemptionHistoryPanelProps) {
  return (
    <Card className="p-6" data-student-id={studentId}>
      <h2 className="text-base font-bold text-[var(--text-primary)]">兑换记录</h2>
      <p className="mt-2 text-sm text-[var(--text-secondary)]">兑换记录待实现。</p>
      <p className="mt-1 text-xs text-[var(--text-tertiary)]">
        将在此查看历史兑换，并确认奖励是否已兑现。
      </p>
    </Card>
  );
}
