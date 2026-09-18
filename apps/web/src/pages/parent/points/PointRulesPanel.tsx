import { Card } from '@/components/base';

/**
 * 「积分规则」Tab（计划三 §2.4，Task 5 填内容）。
 *
 * 本文件现在是**占位**，但 props 形状与落点已经定死：Task 5 只需往这里填
 * 「按 taskCode 分组的卡片 + 行内 input + 保存 + 二次确认」，**不需要**搬组件、
 * 也不需要改 `ParentPointsPage` 的接口。
 *
 * 接缝约定：
 * - `studentId` 由页面下发；面板自己按它拉 `getParentPointRules(studentId)`，
 *   `useEffect` 依赖 `studentId` 即自动满足「切孩子重拉」；
 * - 草稿（`draft` state）保存在本组件内。页面在 `studentId` 变化时会**重挂载**
 *   本组件（父级给了 `key`），所以草稿天然被丢弃——不用自己写「清草稿」的 effect，
 *   也**不要**把草稿提升到页面级（那样跨学生提交就成事故了）。
 */
export interface PointRulesPanelProps {
  studentId: number;
}

export default function PointRulesPanel({ studentId }: PointRulesPanelProps) {
  return (
    <Card className="p-6" data-student-id={studentId}>
      <h2 className="text-base font-bold text-[var(--text-primary)]">积分规则</h2>
      <p className="mt-2 text-sm text-[var(--text-secondary)]">分值规则配置待实现。</p>
      <p className="mt-1 text-xs text-[var(--text-tertiary)]">
        将按任务分组，为每档设置分值、每日上限与启用状态。
      </p>
    </Card>
  );
}
