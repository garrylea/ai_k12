import { Card } from '@/components/base';

/**
 * 「兑换」Tab 的上半块 —— 兑换设置（计划三 §2.6(a)，Task 7 填内容）。
 *
 * 接缝同 `PointRulesPanel`：`studentId` 由页面下发、草稿留在本组件内、
 * 页面在切孩子时重挂载本组件。`PUT` 空 patch 会被后端 400，属于 Task 7 的规则。
 */
export interface PointsSettingsPanelProps {
  studentId: number;
}

export default function PointsSettingsPanel({ studentId }: PointsSettingsPanelProps) {
  return (
    <Card className="p-6" data-student-id={studentId}>
      <h2 className="text-base font-bold text-[var(--text-primary)]">兑换设置</h2>
      <p className="mt-2 text-sm text-[var(--text-secondary)]">兑换设置待实现。</p>
      <p className="mt-1 text-xs text-[var(--text-tertiary)]">
        将在此设置「多少积分兑 1 元」与是否允许兑换。
      </p>
    </Card>
  );
}
