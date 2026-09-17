import { describe, it, expect, vi } from 'vitest';
import { ChineseMeaningJudgeCapability } from './chinese-meaning-judge.capability.js';

const REQ = {
  workTitle: '酬乐天扬州初逢席上见赠',
  sentence: '沉舟侧畔千帆过，病树前头万木春。',
  standardTranslation: '沉船旁边千帆竞发，枯树前面万木争春。',
  standardMeaning: '比喻新事物必将取代旧事物。',
  standardEmotion: '豁达乐观、积极进取',
  studentMeaning: '新事物会代替旧事物',
  studentEmotion: '乐观',
  terms: [{ term: '沉舟', gloss: '沉没的船', answer: '沉了的船' }],
};

/** 模型客户端桩：第 n 次调用可给不同返回（用来测 primary 失败 → fallback 顶上）。 */
function makeClient(impl: (call: number) => Promise<{ content: string; reasoningContent?: string }>) {
  let n = 0;
  const chat = vi.fn().mockImplementation(() => impl(++n));
  return { client: { chat } as never, chat };
}

describe('ChineseMeaningJudgeCapability', () => {
  it('模型成功时返回三项判定', async () => {
    const { client } = makeClient(async () => ({
      content: JSON.stringify({
        terms: [{ term: '沉舟', correct: true, comment: null }],
        meaning: { correct: true, comment: null },
        emotion: { correct: true, comment: null },
      }),
    }));
    const cap = new ChineseMeaningJudgeCapability({ modelClient: client });
    const res = await cap.generate(REQ);
    expect(res.terms[0]?.correct).toBe(true);
    expect(res.meaning?.correct).toBe(true);
    expect(res.emotion?.correct).toBe(true);
  });

  it('primary 失败时走 fallback（第二次调用返回成功）', async () => {
    const ok = JSON.stringify({
      terms: [], meaning: { correct: false, comment: '偏了' }, emotion: { correct: true, comment: null },
    });
    const { client, chat } = makeClient(async (call) => {
      if (call === 1) throw new Error('local down');
      return { content: ok };
    });
    const cap = new ChineseMeaningJudgeCapability({ modelClient: client });
    const res = await cap.generate(REQ);
    expect(res.meaning?.correct).toBe(false);
    expect(res.meaning?.comment).toBe('偏了');
    // 证明真的走了 fallback：先 primary 失败，再用 fallback 模型调一次
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls[1][0].model.modelId).toBe('deepseek-flash');
    // fallback 是云端模型，不能带本地端点专用的 extraBody（会被 400）
    expect('extraBody' in chat.mock.calls[1][0]).toBe(false);
  });

  it('关 thinking 只对本地端点下发：local 带 extraBody 无 thinking，非 local 两者都不', async () => {
    const ok = JSON.stringify({ terms: [], meaning: { correct: true }, emotion: { correct: true } });
    // 第一次失败是为了逼出 fallback——路由里只有 fallback 是非 local 模型
    const { client, chat } = makeClient(async (call) => {
      if (call === 1) throw new Error('local down');
      return { content: ok };
    });
    const cap = new ChineseMeaningJudgeCapability({ modelClient: client });
    await cap.generate(REQ);

    // primary=local：只认 chat_template_kwargs（`thinking: false` 对 llama.cpp 是空操作）
    const localCall = chat.mock.calls[0][0];
    expect(localCall.model.provider).toBe('local');
    expect(localCall.extraBody).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    expect('thinking' in localCall).toBe(false);

    // 非 local（云端 fallback）：extraBody 会 400；thinking 有意留着（判题质量更好）
    const cloudCall = chat.mock.calls[1][0];
    expect(cloudCall.model.provider).not.toBe('local');
    expect('extraBody' in cloudCall).toBe(false);
    expect('thinking' in cloudCall).toBe(false);
  });

  it('解析失败时抛错（不静默返回空）', async () => {
    const { client } = makeClient(async () => ({ content: '不是 JSON' }));
    const cap = new ChineseMeaningJudgeCapability({ modelClient: client });
    await expect(cap.generate(REQ)).rejects.toThrow(/parse failed/);
  });

  it('三类待判项全空 → 渲染「无需判定」反向分支，不得同时要求判定', async () => {
    const ok = JSON.stringify({ terms: [], meaning: null, emotion: null });
    const { client, chat } = makeClient(async () => ({ content: ok }));
    const cap = new ChineseMeaningJudgeCapability({ modelClient: client });
    await cap.generate({ ...REQ, terms: [], studentMeaning: null, studentEmotion: null });

    const messages = chat.mock.calls[0][0].messages as Array<{ content: string }>;
    const prompt = messages.map((m) => m.content).join('\n');

    // {{^x}} 反向分支必须命中——否则模型一边被告知「本句没有需要判定的字词」，
    // 一边仍被要求输出判定，判题质量静默下降且没有任何失败信号。
    expect(prompt).toContain('（本句没有需要判定的字词）');
    expect(prompt).toContain('（本句的深层含义无需判定）');
    expect(prompt).toContain('（本句的作者情感无需判定）');
    // 对应的正向分支不得出现
    expect(prompt).not.toContain('**需要判定的字词**');
    expect(prompt).not.toContain('**学生的「深层含义」作答**');
    expect(prompt).not.toContain('**学生的「作者情感」作答**');
  });
});
