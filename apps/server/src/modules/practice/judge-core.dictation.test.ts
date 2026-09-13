import { describe, it, expect, vi } from 'vitest';
import { JudgeCoreService } from './judge-core.service';

const QUESTION = {
  id: 100, subject_id: 2, type: 'poem_dictation', difficulty: 2,
  content: '请默写《静夜思》（并写出作者与朝代）',
  options: null, answer: '作者：李白\n朝代：唐\n正文：床前明月光，疑是地上霜。',
  explanation: null, source: 'DEV-FIXTURE', content_hash: 'x', is_active: 1, created_at: new Date(),
};

function makeService() {
  const questionsRepo = { findById: vi.fn().mockResolvedValue(QUESTION) };
  const mainErrorRepo = {
    clearUnclearedByStudentQuestionId: vi.fn().mockResolvedValue(undefined),
    // writeErrorBookOrReuse 的真实依赖：先 findUnclearedByStudentQuestionId（未命中→null），
    // 再 create（返回错题本行 id）。mock 错名字会让 errorBookId 变 undefined。
    findUnclearedByStudentQuestionId: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(555),
  };
  const service = new JudgeCoreService(
    questionsRepo as never,
    mainErrorRepo as never,
    {} as never, // structuring
    {} as never, // judgment
    { ensureExplanation: vi.fn() } as never,
    {} as never, // selfAssessRepo
  );
  return { service, questionsRepo, mainErrorRepo };
}

const EXPECTED = { author: '李白', dynasty: '唐', body: '床前明月光，疑是地上霜。' };

describe('JudgeCoreService.judgeDictation', () => {
  it('三项全对（忽略标点与空格）→ isCorrect=true，清错题', async () => {
    const { service, mainErrorRepo } = makeService();
    const res = await service.judgeDictation({
      studentId: 7, subjectId: 2, questionId: 100,
      expected: EXPECTED,
      student: { author: '李白', dynasty: '唐', body: '床前明月光疑是地上霜' },
    });
    expect(res.isCorrect).toBe(true);
    expect(res.fields).toEqual({ author: { match: true }, dynasty: { match: true }, body: { match: true } });
    expect(mainErrorRepo.clearUnclearedByStudentQuestionId).toHaveBeenCalledWith(7, 100);
  });

  it('仅正文错一个字 → isCorrect=false，入错题本，diff 标出该字', async () => {
    const { service, mainErrorRepo } = makeService();
    const res = await service.judgeDictation({
      studentId: 7, subjectId: 2, questionId: 100,
      expected: EXPECTED,
      student: { author: '李白', dynasty: '唐', body: '床前明月先，疑是地上霜。' },
    });
    expect(res.isCorrect).toBe(false);
    expect(res.fields.body.match).toBe(false);
    expect(res.fields.author.match).toBe(true);
    expect(res.bodyDiff).toContainEqual({ type: 'wrong', expected: '光', actual: '先' });
    // 默写错题必须以 source='dictation' 落 main_error_books——这是与主线错题
    // （清零门禁只查 source='practice'）隔离的唯一依据，钉住防回归。
    expect(mainErrorRepo.create.mock.calls[0][0]).toEqual(
      expect.objectContaining({ question_id: 100, source: 'dictation' }),
    );
    expect(res.errorBookId).toBe(555);
  });

  it('仅朝代错 → isCorrect=false', async () => {
    const { service } = makeService();
    const res = await service.judgeDictation({
      studentId: 7, subjectId: 2, questionId: 100,
      expected: EXPECTED,
      student: { author: '李白', dynasty: '宋', body: EXPECTED.body },
    });
    expect(res.isCorrect).toBe(false);
    expect(res.fields.dynasty.match).toBe(false);
  });

  it('三项全空 → isCorrect=false（不同于客观题的空答案守卫），且照常写错题本', async () => {
    const { service, mainErrorRepo } = makeService();
    const res = await service.judgeDictation({
      studentId: 7, subjectId: 2, questionId: 100,
      expected: EXPECTED, student: { author: '', dynasty: '', body: '' },
    });
    expect(res.isCorrect).toBe(false);
    // 客观题空答案走「unanswered 守卫」不计对错、不写错题本；默写没有该守卫，
    // 空答即答错并写入错题本（source='dictation'）——此处钉住该差异。
    expect(mainErrorRepo.create.mock.calls[0][0]).toEqual(
      expect.objectContaining({ question_id: 100, source: 'dictation' }),
    );
    expect(res.errorBookId).toBe(555);
  });

  it('题目不存在 → 抛 4004', async () => {
    const { service, questionsRepo } = makeService();
    questionsRepo.findById.mockResolvedValue(null);
    await expect(
      service.judgeDictation({
        studentId: 7, subjectId: 2, questionId: 999, expected: EXPECTED, student: EXPECTED,
      }),
    ).rejects.toMatchObject({ response: { code: 4004 } });
  });
});
