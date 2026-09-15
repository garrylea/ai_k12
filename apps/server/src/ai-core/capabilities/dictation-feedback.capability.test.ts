import { describe, it, expect, vi } from 'vitest';
import { DictationFeedbackCapability } from './dictation-feedback.capability.js';

const baseRequest = {
  workTitle: '静夜思',
  expected: { author: '李白', dynasty: '唐', body: '床前明月光，疑是地上霜。' },
  student: { author: '李白', dynasty: '唐', body: '床前明月先，疑是地上霜。' },
  fieldMatch: { author: true, dynasty: true, body: false },
  bodyDiffText: '床前明月[光→先]，疑是地上霜。',
};

describe('DictationFeedbackCapability', () => {
  it('主模型成功 → 返回去除首尾空白的文本', async () => {
    const modelClient = { chat: vi.fn().mockResolvedValue({ content: '  你把「光」写成了「先」。  ' }) };
    const cap = new DictationFeedbackCapability({ modelClient: modelClient as never });
    const res = await cap.generate(baseRequest);
    expect(res.content).toBe('你把「光」写成了「先」。');
  });

  it('主模型失败 → 回退 fallback 模型', async () => {
    const chat = vi.fn()
      .mockRejectedValueOnce(new Error('local down'))
      .mockResolvedValueOnce({ content: '回退模型的错因' });
    const cap = new DictationFeedbackCapability({ modelClient: { chat } as never });
    const res = await cap.generate(baseRequest);
    expect(res.content).toBe('回退模型的错因');
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('两个模型都失败 → 抛出（调用方兜底为 feedback=null）', async () => {
    const chat = vi.fn().mockRejectedValue(new Error('all down'));
    const cap = new DictationFeedbackCapability({ modelClient: { chat } as never });
    await expect(cap.generate(baseRequest)).rejects.toThrow();
  });

  it('模型返回空白 → content 为空串', async () => {
    const modelClient = { chat: vi.fn().mockResolvedValue({ content: '   ' }) };
    const cap = new DictationFeedbackCapability({ modelClient: modelClient as never });
    const res = await cap.generate(baseRequest);
    expect(res.content).toBe('');
  });

  it('本地 provider → 下发关 thinking 的 chat_template_kwargs（错因秒回）', async () => {
    const chat = vi.fn().mockResolvedValue({ content: '错因' });
    const cap = new DictationFeedbackCapability({ modelClient: { chat } as never });
    await cap.generate(baseRequest);
    // 路由 dictation_feedback 的 primary 是 local（见 model-routes.yaml）
    expect(chat.mock.calls[0][0].extraBody).toEqual({ chat_template_kwargs: { enable_thinking: false } });
  });
});
