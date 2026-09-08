import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExplanationCacheService } from './explanation-cache.service.js';

function makeQuestion(over = {} as Partial<{ id: number; answer: string; explanation: string }>) {
  return { id: 1, answer: 'B', explanation: '', ...over } as any;
}

function makeDeps() {
  const questionsRepo = {
    findById: vi.fn(),
    updateExplanation: vi.fn().mockResolvedValue(undefined),
  };
  const explanation = { explain: vi.fn() };
  return { questionsRepo, explanation };
}

describe('ExplanationCacheService', () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
  });

  it('已有解析 -> 什么都不做', async () => {
    const svc = new ExplanationCacheService(deps.questionsRepo as any, deps.explanation as any);
    svc.ensureExplanation(makeQuestion({ explanation: '已有' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(deps.explanation.explain).not.toHaveBeenCalled();
    expect(deps.questionsRepo.updateExplanation).not.toHaveBeenCalled();
  });

  it('长答案（≥100 字符）直接直写，不调 LLM', async () => {
    const longAnswer = 'x'.repeat(100);
    const svc = new ExplanationCacheService(deps.questionsRepo as any, deps.explanation as any);
    svc.ensureExplanation(makeQuestion({ answer: longAnswer }));
    await new Promise((r) => setTimeout(r, 10));
    expect(deps.explanation.explain).not.toHaveBeenCalled();
    expect(deps.questionsRepo.updateExplanation).toHaveBeenCalledWith(1, longAnswer);
  });

  it('短答案 -> 调 LLM 生成并入库', async () => {
    deps.explanation.explain.mockResolvedValue({ content: '标准题解', mode: 'solution' });
    deps.questionsRepo.findById.mockResolvedValue(makeQuestion());
    const svc = new ExplanationCacheService(deps.questionsRepo as any, deps.explanation as any);
    svc.ensureExplanation(makeQuestion({ answer: 'B' }));
    const result = await svc.waitExplanation(1, 5000);
    expect(result).toBe('标准题解');
    expect(deps.explanation.explain).toHaveBeenCalledTimes(1);
    expect(deps.questionsRepo.updateExplanation).toHaveBeenCalledWith(1, '标准题解');
  });

  it('生成失败 -> 不入库，返回 null', async () => {
    deps.explanation.explain.mockRejectedValue(new Error('LLM 挂了'));
    deps.questionsRepo.findById.mockResolvedValue(makeQuestion());
    const svc = new ExplanationCacheService(deps.questionsRepo as any, deps.explanation as any);
    svc.ensureExplanation(makeQuestion({ answer: 'B' }));
    const result = await svc.waitExplanation(1, 5000);
    expect(result).toBeNull();
    expect(deps.questionsRepo.updateExplanation).not.toHaveBeenCalled();
  });

  it('同题并发去重：两次 ensure 只生成一次', async () => {
    let resolve!: (v: any) => void;
    deps.explanation.explain.mockImplementation(() => new Promise((r) => { resolve = r; }));
    deps.questionsRepo.findById.mockResolvedValue(makeQuestion());
    const svc = new ExplanationCacheService(deps.questionsRepo as any, deps.explanation as any);
    svc.ensureExplanation(makeQuestion({ answer: 'B' }));
    svc.ensureExplanation(makeQuestion({ answer: 'B' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(deps.explanation.explain).toHaveBeenCalledTimes(1);
    resolve({ content: '题解', mode: 'solution' });
    await svc.waitExplanation(1, 5000);
  });

  it('waitForExplanations：DB 已有直返，in-flight 等待，无在途且无解析返回 null', async () => {
    deps.questionsRepo.findById
      .mockResolvedValueOnce(makeQuestion({ explanation: '已有' }))
      .mockResolvedValueOnce(makeQuestion());
    const svc = new ExplanationCacheService(deps.questionsRepo as any, deps.explanation as any);
    const out = await svc.waitForExplanations([1, 2], 100);
    expect(out[1]).toBe('已有');
    expect(out[2]).toBeNull();
    expect(deps.explanation.explain).not.toHaveBeenCalled(); // 批量不触发新生成
  });

  it('waitForExplanations：in-flight 等待返回生成文本', async () => {
    let resolve!: (v: any) => void;
    deps.explanation.explain.mockImplementation(() => new Promise((r) => { resolve = r; }));
    deps.questionsRepo.findById.mockResolvedValue(makeQuestion());
    const svc = new ExplanationCacheService(deps.questionsRepo as any, deps.explanation as any);
    svc.ensureExplanation(makeQuestion({ answer: 'B' })); // 触发在途生成，explain 挂起
    await new Promise((r) => setTimeout(r, 0)); // 让 generate 到达 explain 挂起点
    const waiting = svc.waitForExplanations([1], 5000); // 命中 in-flight -> 等待而非返回 null
    resolve({ content: '题解', mode: 'solution' });
    const out = await waiting;
    expect(out[1]).toBe('题解');
    expect(deps.explanation.explain).toHaveBeenCalledTimes(1);
  });

  it('waitExplanation：无在途且无解析 -> 重新触发生成', async () => {
    deps.explanation.explain.mockResolvedValue({ content: '补的题解', mode: 'solution' });
    deps.questionsRepo.findById
      .mockResolvedValueOnce(makeQuestion()) // waitExplanation 首查
      .mockResolvedValueOnce(makeQuestion()); // generate 内查
    const svc = new ExplanationCacheService(deps.questionsRepo as any, deps.explanation as any);
    const result = await svc.waitExplanation(1, 5000);
    expect(result).toBe('补的题解');
    expect(deps.explanation.explain).toHaveBeenCalledTimes(1);
  });
});
