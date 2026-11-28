import { useState } from 'react';
import { Button, toast } from '@/components/base';
import { recommendFeaturedSet } from '@/services/api';

/**
 * 把一组题推荐给教研员做精选题单（2026-11-28）。
 * idle → sending → done：发送中/已完成都禁用，杜绝重复提交。
 * onClick 内部 stopPropagation —— 本按钮会嵌在可勾选的错题行里，不能触发行选择。
 */
export default function RecommendFeaturedSetButton({
  questionIds,
  disabledReason,
}: {
  questionIds: number[];
  disabledReason?: string;
}) {
  const [state, setState] = useState<'idle' | 'sending' | 'done'>('idle');

  if (disabledReason) {
    return <Button disabled>{disabledReason}</Button>;
  }

  async function submit() {
    if (state !== 'idle') return;
    setState('sending');
    try {
      await recommendFeaturedSet(questionIds);
      setState('done');
      toast('success', '已推荐给教研员');
    } catch (err) {
      setState('idle');
      toast('error', err instanceof Error ? err.message : '推荐失败');
    }
  }

  return (
    <Button
      onClick={(e) => {
        e.stopPropagation();
        void submit();
      }}
      disabled={state !== 'idle'}
    >
      {state === 'done' ? '已推荐' : '推荐这套题'}
    </Button>
  );
}
