import { describe, expect, it } from 'vitest';
import { mapHistoryMessage, stripFreeformSubmitEnvelope } from './useAuxChat';
import type { MessageItem } from '@/services/api';

const base: MessageItem = {
  id: 1,
  dialogue_id: 7,
  role: 'user',
  content: '',
  reasoning: null,
  type: null,
  attachments: null,
  created_at: '',
};

describe('stripFreeformSubmitEnvelope', () => {
  it('去掉「题目/我的作答」信封，只留作答', () => {
    expect(stripFreeformSubmitEnvelope('题目：\n求 $x$\n\n我的作答：\n$x=1$')).toBe('$x=1$');
  });

  it('没有信封时原样返回', () => {
    expect(stripFreeformSubmitEnvelope('普通消息')).toBe('普通消息');
  });

  it('只提交草稿（正文为空）给占位，不留空白气泡', () => {
    expect(stripFreeformSubmitEnvelope('题目：\n题\n\n我的作答：\n')).toBe('（本次仅提交了草稿）');
  });
});

describe('mapHistoryMessage', () => {
  it('freeform_submit 标成 markdown 并去信封', () => {
    const m = mapHistoryMessage({
      ...base,
      type: 'freeform_submit',
      content: '题目：\n题\n\n我的作答：\n**答案**',
    });
    expect(m.markdown).toBe(true);
    expect(m.content).toBe('**答案**');
  });

  it('普通答疑消息仍是纯文本', () => {
    const m = mapHistoryMessage({ ...base, content: '$x=1$' });
    expect(m.markdown).toBeUndefined();
    expect(m.content).toBe('$x=1$');
  });
});
