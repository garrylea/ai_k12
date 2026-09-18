import { Card } from '@/components/base';

/**
 * 「兑换」Tab 的下半块 —— 兑换表单（计划三 §2.6(b)，Task 7 填内容）。
 *
 * 接缝约定：
 * - `studentId` 由页面下发（兑换成功后要按它重拉记录）；
 * - `onPointsChanged` 用于把「兑换成功 → 概览卡的余额/段位变了」这件事
 *   通知页面去重拉概览。**页面持有概览状态**，面板只调这个回调，
 *   自己不要缓存 `MyPoints`（否则会出现两份可能互相打架的余额）。
 *
 * 草稿（输入中的积分数 / 选中的奖励）留在本组件内，切孩子时靠页面重挂载丢弃。
 */
export interface RedeemPanelProps {
  studentId: number;
  /** 兑换成功后调用，让页面重拉概览卡。 */
  onPointsChanged?: () => void;
}

export default function RedeemPanel({ studentId }: RedeemPanelProps) {
  return (
    <Card className="p-6" data-student-id={studentId}>
      <h2 className="text-base font-bold text-[var(--text-primary)]">兑换</h2>
      <p className="mt-2 text-sm text-[var(--text-secondary)]">兑换表单待实现。</p>
      <p className="mt-1 text-xs text-[var(--text-tertiary)]">
        将支持「换钱」与「换奖励」两种方式，提交前二次确认。
      </p>
    </Card>
  );
}
