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
  return { chat: vi.fn().mockImplementation(() => impl(++n)) } as never;
}

describe('ChineseMeaningJudgeCapability', () => {
  it('模型成功时返回三项判定', async () => {
    const client = makeClient(async () => ({
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
    const client = makeClient(async (call) => {
      if (call === 1) throw new Error('local down');
      return { content: ok };
    });
    const cap = new ChineseMeaningJudgeCapability({ modelClient: client });
    const res = await cap.generate(REQ);
    expect(res.meaning?.correct).toBe(false);
    expect(res.meaning?.comment).toBe('偏了');
  });

  it('解析失败时抛错（不静默返回空）', async () => {
    const client = makeClient(async () => ({ content: '不是 JSON' }));
    const cap = new ChineseMeaningJudgeCapability({ modelClient: client });
    await expect(cap.generate(REQ)).rejects.toThrow(/parse failed/);
  });
});
