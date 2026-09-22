import { useState } from 'react';
import { Banner } from '@/components/base';
import { toast } from '@/components/base/Toast';
import { generateRemediationSet } from '@/services/api';

interface Props {
  source: 'exam' | 'targeted';
  sessionId: number | null;
  wrongCount: number;
  wrongQuestionIds?: number[];
  onGenerated?: () => void;
}

export function RemediationOfferCard({ source, sessionId, wrongCount, wrongQuestionIds, onGenerated }: Props) {
  const [state, setState] = useState<'offer' | 'generating' | 'done'>('offer');

  if (wrongCount === 0 || sessionId == null || state === 'done') return null;

  const handleGenerate = async () => {
    if (state === 'generating') return;
    setState('generating');
    try {
      const payload: Parameters<typeof generateRemediationSet>[0] = {
        source,
        sessionId,
        ...(source === 'targeted' && wrongQuestionIds ? { wrongQuestionIds } : {}),
      };
      const res = await generateRemediationSet(payload);
      if (res.groupsCreated > 0) {
        toast('success', `已生成 ${res.groupsCreated} 组 ${res.itemsCreated} 题相似题练习，可在训练首页开始练习`);
      } else {
        toast('success', '暂无可生成的相似题（错题缺少考点标注）');
      }
      setState('done');
      onGenerated?.();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '生成失败，请重试');
      setState('offer');
    }
  };

  return (
    <Banner
      type="info"
      title={`本场错了 ${wrongCount} 道题，生成相似题专项练习？`}
      description="按考点每组配 3 题，逐题作答，答对清零、全对清套"
      action={
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            disabled={state === 'generating'}
            onClick={() => setState('done')}
            className="rounded-lg border border-blue-300 bg-white px-3 py-1.5 text-[13px] font-medium text-blue-900 hover:bg-blue-50 disabled:opacity-60"
          >
            跳过
          </button>
          <button
            type="button"
            disabled={state === 'generating'}
            onClick={handleGenerate}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {state === 'generating' ? '生成中…' : '生成练习'}
          </button>
        </div>
      }
    />
  );
}
