import { afterEach, describe, expect, it, vi } from 'vitest';
import { JudgeCoreService, subjectiveJudgeMode } from './judge-core.service';
import type { QuestionsRepository } from '../../database/repositories/questions.repo.js';
import type { MainErrorBooksRepository } from '../../database/repositories/main-error-books.repo.js';
import type { QuestionSelfAssessmentsRepository } from '../../database/repositories/question-self-assessments.repo.js';

const mk = (overrides: any = {}) => ({
  questionsRepo: {
    findById: vi.fn().mockResolvedValue(null),
    findByContentHash: vi.fn().mockResolvedValue(null),
    findOrCreate: vi.fn(),
    deleteById: vi.fn(),
  },
  mainErrorRepo: {
    create: vi.fn().mockResolvedValue(42),
    findUnclearedByStudentQuestionId: vi.fn().mockResolvedValue(null),
    clearUnclearedByStudentQuestionId: vi.fn().mockResolvedValue(undefined),
  },
  structuring: { structure: vi.fn() },
  judgment: { judge: vi.fn() },
  explanationCache: { ensureExplanation: vi.fn() },
  // 判题体系重构（2026-09-09）新增第 6 参（recordSelfAssessment 用）
  selfAssessRepo: { create: vi.fn().mockResolvedValue(1) },
  ...overrides,
});

const mkSvc = (deps: ReturnType<typeof mk>) =>
  new JudgeCoreService(deps.questionsRepo, deps.mainErrorRepo, deps.structuring, deps.judgment as any, deps.explanationCache as any, deps.selfAssessRepo as any);

describe('JudgeCoreService.judgeQuestion', () => {
  it('choice 命中 -> exact 比对，答错入错题本（source 透传）', async () => {
    const deps = mk({
      questionsRepo: {
        findById: vi.fn().mockResolvedValue({ id: 10, type: 'choice', answer: 'A', options: '[{"label":"A","isCorrect":true}]' }),
        findByContentHash: vi.fn(),
        findOrCreate: vi.fn(),
        deleteById: vi.fn(),
      },
    });
    const svc = mkSvc(deps);
    const r = await svc.judgeQuestion({ studentId: 1, subjectId: 1, questionId: 10, studentAnswer: 'B', source: 'targeted' });
    expect(r.isCorrect).toBe(false);
    expect(r.method).toBe('exact');
    expect(deps.mainErrorRepo.create).toHaveBeenCalledWith(expect.objectContaining({ source: 'targeted', question_id: 10, source_ref_id: null }));
    expect(deps.judgment.judge).not.toHaveBeenCalled();
    expect(deps.explanationCache.ensureExplanation).toHaveBeenCalledWith({ id: 10, type: 'choice', answer: 'A', options: '[{"label":"A","isCorrect":true}]' });
  });

  it('答对 -> clearUnclearedByStudentQuestionId（不限 source 清零）', async () => {
    const deps = mk({
      questionsRepo: {
        findById: vi.fn().mockResolvedValue({ id: 10, type: 'choice', answer: 'A', options: '[{"label":"A","isCorrect":true}]' }),
        findByContentHash: vi.fn(),
        findOrCreate: vi.fn(),
        deleteById: vi.fn(),
      },
    });
    const svc = mkSvc(deps);
    const r = await svc.judgeQuestion({ studentId: 1, subjectId: 1, questionId: 10, studentAnswer: 'A', source: 'error_practice' });
    expect(r.isCorrect).toBe(true);
    expect(deps.mainErrorRepo.clearUnclearedByStudentQuestionId).toHaveBeenCalledWith(1, 10);
    expect(deps.mainErrorRepo.create).not.toHaveBeenCalled();
    expect(deps.explanationCache.ensureExplanation).not.toHaveBeenCalled();
  });

  it('题目不存在 -> 400（训练题必来自题库）', async () => {
    const deps = mk();
    const svc = mkSvc(deps);
    await expect(svc.judgeQuestion({ studentId: 1, subjectId: 1, questionId: 999, studentAnswer: 'x', source: 'targeted' }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('AI 判定失败 -> 503，不入错题本', async () => {
    // 判题体系重构（2026-09-09）：proof 默认 self_assess 早退，AI 失败路径须显式切回（finally 复原防泄漏）
    process.env.JUDGE_SUBJECTIVE_MODE = 'ai';
    try {
      const deps = mk({
        questionsRepo: {
          findById: vi.fn().mockResolvedValue({ id: 10, type: 'proof', answer: '', options: null }),
          findByContentHash: vi.fn(),
          findOrCreate: vi.fn(),
          deleteById: vi.fn(),
        },
        judgment: { judge: vi.fn().mockRejectedValue(new Error('boom')) },
      });
      const svc = mkSvc(deps);
      await expect(svc.judgeQuestion({ studentId: 1, subjectId: 1, questionId: 10, studentAnswer: 'x', source: 'exam' }))
        .rejects.toMatchObject({ status: 503 });
      expect(deps.mainErrorRepo.create).not.toHaveBeenCalled();
    } finally {
      delete process.env.JUDGE_SUBJECTIVE_MODE;
    }
  });
});

/** 构造带 mock 依赖的 JudgeCoreService（capabilities 不会被 self_assess 路径触达，占位即可）。 */
function makeService(overrides: Partial<Record<'questions' | 'mainError' | 'selfAssess', any>> = {}) {
  const questions = overrides.questions ?? {
    findById: vi.fn(async () => null),
  };
  const mainError = overrides.mainError ?? {
    findUnclearedByStudentQuestionId: vi.fn(async () => null),
    create: vi.fn(async () => 101),
    clearUnclearedByStudentQuestionId: vi.fn(async () => {}),
  };
  const selfAssess = overrides.selfAssess ?? { create: vi.fn(async () => 1) };
  const svc = new JudgeCoreService(
    questions as unknown as QuestionsRepository,
    mainError as unknown as MainErrorBooksRepository,
    {} as any, // QuestionStructuringCapability（self_assess 路径不触达）
    {} as any, // JudgmentCapability（self_assess 路径不触达）
    {} as any, // ExplanationCacheService（self_assess 路径不触达）
    selfAssess as unknown as QuestionSelfAssessmentsRepository,
  );
  return { svc, questions, mainError, selfAssess };
}

const q = (type: string, answer = 'B', explanation: string | null = '解析文本') => ({
  id: 10, type, answer, explanation, options: null, content: '题面', subject_id: 1,
});

afterEach(() => { delete process.env.JUDGE_SUBJECTIVE_MODE; });

describe('subjectiveJudgeMode', () => {
  it('默认 self_assess；JUDGE_SUBJECTIVE_MODE=ai 切回', () => {
    delete process.env.JUDGE_SUBJECTIVE_MODE;
    expect(subjectiveJudgeMode()).toBe('self_assess');
    process.env.JUDGE_SUBJECTIVE_MODE = 'ai';
    expect(subjectiveJudgeMode()).toBe('ai');
  });
});

describe('judgeQuestion 四路由（self_assess 模式）', () => {
  it('short_answer：不判对错，返回 needsSelfAssessment + 参考答案/解析，不写错题本', async () => {
    const { svc, mainError } = makeService({
      questions: { findById: vi.fn(async () => q('short_answer', '过程…结果 x=3')) },
    });
    const out = await svc.judgeQuestion({ studentId: 7, subjectId: 1, questionId: 10, studentAnswer: 'x=3', source: 'targeted' });
    expect(out).toMatchObject({ questionId: 10, isCorrect: null, method: 'self_assess', needsSelfAssessment: true, referenceAnswer: '过程…结果 x=3', explanation: '解析文本' });
    expect(mainError.create).not.toHaveBeenCalled();
    expect(mainError.clearUnclearedByStudentQuestionId).not.toHaveBeenCalled();
  });

  it('proof 同样早退；calculation 走 fill_blank 同款归一化比对', async () => {
    const { svc } = makeService({
      questions: { findById: vi.fn(async () => q('calculation', '3')) },
    });
    const out = await svc.judgeQuestion({ studentId: 7, subjectId: 1, questionId: 10, studentAnswer: '3', source: 'targeted' });
    expect(out).toMatchObject({ isCorrect: true, method: 'exact' });
  });

  it('short_answer + JUDGE_SUBJECTIVE_MODE=ai：走 AI 判定（mock judgment）', async () => {
    const { svc } = makeService({
      questions: { findById: vi.fn(async () => q('short_answer')) },
    });
    // 动态替换 judgment capability（构造时传了 {}，运行时挂上）
    (svc as any).judgment = { judge: vi.fn(async () => ({ isCorrect: true, errorType: null })) };
    process.env.JUDGE_SUBJECTIVE_MODE = 'ai';
    const out = await svc.judgeQuestion({ studentId: 7, subjectId: 1, questionId: 10, studentAnswer: 'ans', source: 'targeted' });
    expect(out).toMatchObject({ isCorrect: true, method: 'ai' });
    expect((svc as any).judgment.judge).toHaveBeenCalledWith(expect.objectContaining({ questionType: 'calculation' }));
  });
});

describe('judgeForPractice 空答案守卫', () => {
  const input = { studentId: 7, subjectId: 1, cardId: 3, lessonId: 5, questionN: '0-1', questionText: '题面', studentAnswer: 'A' };

  it('choice 空答案：返回 noStandardAnswer，不入错题本不触发解析', async () => {
    const { svc, mainError } = makeService({
      questions: {}, // judgeForPractice 的 q 由 PracticeService 传入，不走 findById
    });
    (svc as any).explanationCache = { ensureExplanation: vi.fn() };
    const out = await svc.judgeForPractice(input, q('choice', '') as any);
    expect(out).toMatchObject({ isCorrect: null, method: 'unanswered', noStandardAnswer: true });
    expect(mainError.create).not.toHaveBeenCalled();
  });
});

describe('recordSelfAssessment', () => {
  it('incorrect：留痕 + find-or-create 错题本', async () => {
    const { svc, selfAssess, mainError } = makeService();
    const out = await svc.recordSelfAssessment({ studentId: 7, subjectId: 1, questionId: 10, assessment: 'incorrect', source: 'targeted' });
    expect(selfAssess.create).toHaveBeenCalledWith({ studentId: 7, questionId: 10, assessment: 'incorrect', source: 'targeted' });
    expect(mainError.create).toHaveBeenCalledWith(expect.objectContaining({ student_id: 7, question_id: 10, source: 'targeted' }));
    expect(out.errorBookId).toBe(101);
  });

  it('correct：留痕 + 清零未清错题（best-effort）', async () => {
    const { svc, mainError } = makeService();
    await svc.recordSelfAssessment({ studentId: 7, subjectId: 1, questionId: 10, assessment: 'correct', source: 'exam', sourceRefId: 55 });
    expect(mainError.clearUnclearedByStudentQuestionId).toHaveBeenCalledWith(7, 10);
    expect(mainError.create).not.toHaveBeenCalled();
  });
});
