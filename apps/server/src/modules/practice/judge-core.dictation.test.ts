import { describe, it, expect, vi } from 'vitest';
import { JudgeCoreService } from './judge-core.service';

function makeService() {
  const mainErrorRepo = {
    clearUnclearedByStudentQuestionId: vi.fn().mockResolvedValue(undefined),
    findUnclearedByStudentQuestionId: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(555),
  };
  const service = new JudgeCoreService(
    {} as never, // questionsRepo —— judgeDictation 不再依赖它
    mainErrorRepo as never,
    {} as never, // structuring
    {} as never, // judgment
    { ensureExplanation: vi.fn() } as never,
    {} as never, // selfAssessRepo
    {} as never, // pointsService（judgeDictation 纯程序判题，不触达）
  );
  return { service, mainErrorRepo };
}

const EXPECTED = { author: '李白', dynasty: '唐', body: '床前明月光，疑是地上霜。' };

describe('JudgeCoreService.judgeDictation', () => {
  it('三项全对（忽略标点与空格）→ isCorrect=true', async () => {
    const { service } = makeService();
    const res = await service.judgeDictation({
      expected: EXPECTED,
      student: { author: '李白', dynasty: '唐', body: '床前明月光疑是地上霜' },
    });
    expect(res.isCorrect).toBe(true);
    expect(res.fields).toEqual({ author: { match: true }, dynasty: { match: true }, body: { match: true } });
  });

  it('仅正文错一个字 → isCorrect=false，diff 标出该字', async () => {
    const { service } = makeService();
    const res = await service.judgeDictation({
      expected: EXPECTED,
      student: { author: '李白', dynasty: '唐', body: '床前明月先，疑是地上霜。' },
    });
    expect(res.isCorrect).toBe(false);
    expect(res.fields.body.match).toBe(false);
    expect(res.fields.author.match).toBe(true);
    expect(res.bodyDiff).toContainEqual({ type: 'wrong', expected: '光', actual: '先' });
  });

  it('仅朝代错 → isCorrect=false', async () => {
    const { service } = makeService();
    const res = await service.judgeDictation({
      expected: EXPECTED,
      student: { author: '李白', dynasty: '宋', body: EXPECTED.body },
    });
    expect(res.isCorrect).toBe(false);
    expect(res.fields.dynasty.match).toBe(false);
  });

  it('三项全空 → isCorrect=false（不同于客观题的空答案守卫）', async () => {
    const { service } = makeService();
    const res = await service.judgeDictation({
      expected: EXPECTED, student: { author: '', dynasty: '', body: '' },
    });
    expect(res.isCorrect).toBe(false);
  });

  // 独立化的核心断言（2026-09-15）：判题**不写任何学生状态**。
  // 一旦有人把错题本写回判题路径，这条会红——它守的是「古诗文专项不进错题本」这条原则。
  it('无论判对判错，都不碰错题本（不写、不清零）', async () => {
    const { service, mainErrorRepo } = makeService();

    await service.judgeDictation({
      expected: EXPECTED,
      student: { author: '李白', dynasty: '唐', body: '床前明月先，疑是地上霜。' },
    });
    await service.judgeDictation({
      expected: EXPECTED, student: EXPECTED,
    });

    expect(mainErrorRepo.create).not.toHaveBeenCalled();
    expect(mainErrorRepo.clearUnclearedByStudentQuestionId).not.toHaveBeenCalled();
  });
});
