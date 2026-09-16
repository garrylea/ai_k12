import { describe, it, expect, vi } from 'vitest';
import { InterpretationJudgeCapability } from './interpretation-judge.capability.js';

const baseRequest = {
  workTitle: '岳阳楼记',
  sentence: '庆历四年春，滕子京谪守巴陵郡。',
  standardTranslation: '庆历四年的春天，滕子京被贬到巴陵郡做太守。',
  studentTranslation: '庆历四年春天，滕子京被派到巴陵当官。',
  terms: [{ term: '谪守', gloss: '因罪贬谪流放，出任外官', answer: '被贬官' }],
};

/** 模型正常返回的 JSON 文本 */
const okJson = JSON.stringify({
  terms: [{ term: '谪守', correct: false, comment: '「谪」含因罪被贬之意' }],
  sentence: { correct: true, comment: null },
});

describe('InterpretationJudgeCapability', () => {
  it('主模型成功 → 解析出 terms 与 sentence', async () => {
    const chat = vi.fn().mockResolvedValue({ content: okJson });
    const cap = new InterpretationJudgeCapability({ modelClient: { chat } as never });
    const res = await cap.generate(baseRequest);
    expect(res.terms).toEqual([{ term: '谪守', correct: false, comment: '「谪」含因罪被贬之意' }]);
    expect(res.sentence).toEqual({ correct: true, comment: null });
  });

  it('JSON 被 markdown 代码围栏包住也能解析（模型常见跑偏）', async () => {
    const chat = vi.fn().mockResolvedValue({ content: '```json\n' + okJson + '\n```' });
    const cap = new InterpretationJudgeCapability({ modelClient: { chat } as never });
    const res = await cap.generate(baseRequest);
    expect(res.terms[0].term).toBe('谪守');
  });

  it('模型漏项 → 解析仍成功，terms 只含回了的项（漏的由 service 标 undetermined）', async () => {
    // 请求 2 个字词，模型只回 1 个：这不是「解析失败」，不该抛错
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({ terms: [{ term: '谪守', correct: true }], sentence: null }),
    });
    const cap = new InterpretationJudgeCapability({ modelClient: { chat } as never });
    const res = await cap.generate({
      ...baseRequest,
      terms: [
        { term: '谪守', gloss: 'g1', answer: 'a1' },
        { term: '越明年', gloss: 'g2', answer: 'a2' },
      ],
    });
    expect(res.terms).toHaveLength(1);
    expect(res.terms[0].term).toBe('谪守');
  });

  it('模型全漏（terms 空 + sentence null）→ 解析仍成功', async () => {
    const chat = vi.fn().mockResolvedValue({ content: '{"terms":[],"sentence":null}' });
    const cap = new InterpretationJudgeCapability({ modelClient: { chat } as never });
    const res = await cap.generate(baseRequest);
    expect(res.terms).toEqual([]);
    expect(res.sentence).toBeNull();
  });

  it('主模型失败 → 回退 fallback 模型', async () => {
    const chat = vi.fn()
      .mockRejectedValueOnce(new Error('local down'))
      .mockResolvedValueOnce({ content: '{"terms":[{"term":"谪守","correct":true}],"sentence":null}' });
    const cap = new InterpretationJudgeCapability({ modelClient: { chat } as never });
    const res = await cap.generate(baseRequest);
    expect(res.terms).toEqual([{ term: '谪守', correct: true }]);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('两个模型都失败 → 抛出（调用方兜底为逐项 undetermined，不阻断已判项）', async () => {
    const chat = vi.fn().mockRejectedValue(new Error('all down'));
    const cap = new InterpretationJudgeCapability({ modelClient: { chat } as never });
    await expect(cap.generate(baseRequest)).rejects.toThrow();
  });

  it('返回非 JSON 文本 → 抛错（不是静默返回空判定）', async () => {
    const chat = vi.fn().mockResolvedValue({ content: '抱歉，我无法判断。' });
    const cap = new InterpretationJudgeCapability({ modelClient: { chat } as never });
    await expect(cap.generate(baseRequest)).rejects.toThrow(/parse failed/);
  });

  it('本地 provider → 下发关 thinking 的 chat_template_kwargs；且**不**传 thinking:false', async () => {
    const chat = vi.fn().mockResolvedValue({ content: okJson });
    const cap = new InterpretationJudgeCapability({ modelClient: { chat } as never });
    await cap.generate(baseRequest);
    // 路由 interpretation_judge 的 primary 是 local（见 model-routes.yaml）
    expect(chat.mock.calls[0][0].extraBody).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    // 云端 fallback 收到未知/无意义的 thinking 字段可能 400 或拉低判题质量
    expect(chat.mock.calls[0][0].thinking).toBeUndefined();
  });

  it('要求 JSON 输出（本地端点靠 response_format，不是靠 prompt 里叮嘱）', async () => {
    const chat = vi.fn().mockResolvedValue({ content: okJson });
    const cap = new InterpretationJudgeCapability({ modelClient: { chat } as never });
    await cap.generate(baseRequest);
    expect(chat.mock.calls[0][0].responseFormat).toBe('json_object');
  });

  it('prompt 渲染：学生译文与字词都进 user message，模板能取到', async () => {
    const chat = vi.fn().mockResolvedValue({ content: okJson });
    const cap = new InterpretationJudgeCapability({ modelClient: { chat } as never });
    await cap.generate(baseRequest);
    const userMsg = chat.mock.calls[0][0].messages.find((m: { role: string }) => m.role === 'user');
    expect(userMsg.content).toContain('岳阳楼记');
    expect(userMsg.content).toContain('庆历四年的春天，滕子京被贬到巴陵郡做太守。');
    expect(userMsg.content).toContain('庆历四年春天，滕子京被派到巴陵当官。');
    expect(userMsg.content).toContain('谪守');
  });

  it('studentTranslation=null 且 terms=[] → 模板走「无需判定」分支，不误报判定', async () => {
    const chat = vi.fn().mockResolvedValue({ content: '{"terms":[],"sentence":null}' });
    const cap = new InterpretationJudgeCapability({ modelClient: { chat } as never });
    await cap.generate({ ...baseRequest, studentTranslation: null, terms: [] });
    const userMsg = chat.mock.calls[0][0].messages.find((m: { role: string }) => m.role === 'user');
    expect(userMsg.content).toContain('本句没有需要判定的字词');
    expect(userMsg.content).toContain('本句的整句翻译无需判定');
  });
});
