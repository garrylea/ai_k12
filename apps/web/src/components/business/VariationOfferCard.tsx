import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Banner, Button } from '@/components/base';
import type { TrainingVariationItem } from '@/services/api';

interface Props {
  /**
   * pending 变式列表，由宿主查询后传入：
   * null = 查询中（不渲染）；空数组 = 无待练（不渲染）；非空 = 展示提示卡。
   * 查询职责放宿主（ErrorPracticeRunPage 要做 8s 补查），本组件纯展示两态。
   */
  variations: TrainingVariationItem[] | null;
}

/**
 * 错题升级变式提示卡（PRD §7.10，2026-10-11）。
 *
 * 与 RemediationOfferCard 的差异：生成在服务端已自动完成（bump 内 fire-and-forget），
 * 没有「生成练习」动作也没有 generating 态——只有「去练」与「知道了」。
 * 宿主必须镜像可见性守卫（variations 为 null/空时不渲染槽位），
 * 否则 AnswerResultList 会多画分隔线（同 RemediationOfferCard 的宿主约定）。
 */
export function VariationOfferCard({ variations }: Props) {
  const [dismissed, setDismissed] = useState(false);
  const navigate = useNavigate();

  if (variations == null || variations.length === 0 || dismissed) return null;

  return (
    <Banner
      // 用 warning（橘底）而非 info（蓝底）：info 的蓝是家长端 brand 色，学生端统一 brand 橘红
      type="warning"
      title={`已为本次仍错的错题生成 ${variations.length} 道变式练习`}
      description="变式题作答一次即记结果；错题本条目也会显示变式入口，随时可练"
      action={
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => setDismissed(true)}>
            知道了
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => navigate('/student/training/variations/run')}
          >
            去练
          </Button>
        </div>
      }
    />
  );
}
