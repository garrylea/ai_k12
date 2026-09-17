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
    // 清零返回值即 affectedRows，发布分判决的依据（0 = 没清到未清行）
    clearUnclearedByStudentQuestionId: vi.fn().mockResolvedValue(0),
  },
  structuring: { structure: vi.fn() },
  judgment: { judge: vi.fn() },
  explanationCache: { ensureExplanation: vi.fn() },
  // 判题体系重构（2026-09-09）新增第 6 参（recordSelfAssessment 用）
  selfAssessRepo: { create: vi.fn().mockResolvedValue(1) },
  // Task 10 新增第 7 参：错题订正发分（error_fix）
  pointsService: { award: vi.fn().mockResolvedValue({ pointsAwarded: 3 }), todayKey: vi.fn(() => '2026-09-17') },
  ...overrides,
});

const mkSvc = (deps: ReturnType<typeof mk>) =>
  new JudgeCoreService(deps.questionsRepo, deps.mainErrorRepo, deps.structuring, deps.judgment as any, deps.explanationCache as any, deps.selfAssessRepo as any, deps.pointsService as any);

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
    // 答错不发分：pointsAwarded=0，无 awardReason，award 根本不被调用（Task 10 契约）
    expect(r.pointsAwarded).toBe(0);
    expect(r.awardReason).toBeUndefined();
    expect(deps.pointsService.award).not.toHaveBeenCalled();
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
    // 判题体系重构（2026-09-09）：proof 默认 self_assess 早退，AI 失败路径须显式切回（finally 复原防泄漏）。
    // answer 须非空：路由 0 空答案守卫（Task 3 code review）会先于 AI 路径早退。
    process.env.JUDGE_SUBJECTIVE_MODE = 'ai';
    try {
      const deps = mk({
        questionsRepo: {
          findById: vi.fn().mockResolvedValue({ id: 10, type: 'proof', answer: '证明过程', options: null }),
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
function makeService(overrides: Partial<Record<'questions' | 'mainError' | 'selfAssess' | 'points', any>> = {}) {
  const questions = overrides.questions ?? {
    findById: vi.fn(async () => null),
  };
  const mainError = overrides.mainError ?? {
    findUnclearedByStudentQuestionId: vi.fn(async () => null),
    create: vi.fn(async () => 101),
    clearUnclearedByStudentQuestionId: vi.fn(async () => 0),
  };
  const selfAssess = overrides.selfAssess ?? { create: vi.fn(async () => 1) };
  const pointsService = overrides.points ?? { award: vi.fn(async () => ({ pointsAwarded: 3 })), todayKey: vi.fn(() => '2026-09-17') };
  const svc = new JudgeCoreService(
    questions as unknown as QuestionsRepository,
    mainError as unknown as MainErrorBooksRepository,
    {} as any, // QuestionStructuringCapability（self_assess 路径不触达）
    {} as any, // JudgmentCapability（self_assess 路径不触达）
    {} as any, // ExplanationCacheService（self_assess 路径不触达）
    selfAssess as unknown as QuestionSelfAssessmentsRepository,
    pointsService as any, // PointsService（Task 10 错题订正发分）
  );
  return { svc, questions, mainError, selfAssess, pointsService };
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

  it('calculation 归一化不等（0.5 vs 1/2）-> 落路由 2 AI 复核，questionType=calculation', async () => {
    // 归一后 '0.5' vs '1/2' 不等（路由 1b 不命中），交 AI 复核等价性
    //（0.5 与 1/2 数值相等，AI 判对是合理转换，非 exact 误判错）。
    const { svc } = makeService({
      questions: { findById: vi.fn(async () => q('calculation', '1/2')) },
    });
    (svc as any).judgment = { judge: vi.fn(async () => ({ isCorrect: true, errorType: null })) };
    const out = await svc.judgeQuestion({ studentId: 7, subjectId: 1, questionId: 10, studentAnswer: '0.5', source: 'targeted' });
    expect(out).toMatchObject({ isCorrect: true, method: 'ai' });
    expect((svc as any).judgment.judge).toHaveBeenCalledWith(expect.objectContaining({ questionType: 'calculation', standardAnswer: '1/2', studentAnswer: '0.5' }));
  });
});

describe('judgeQuestion 空答案守卫（路由 0）', () => {
  it('空答案题（error_practice 重抽不过滤）-> 不计对错早退，不入错题本不触发解析', async () => {
    const { svc, mainError } = makeService({
      questions: { findById: vi.fn(async () => q('choice', '')) },
    });
    (svc as any).explanationCache = { ensureExplanation: vi.fn() };
    const out = await svc.judgeQuestion({ studentId: 7, subjectId: 1, questionId: 10, studentAnswer: 'A', source: 'error_practice' });
    expect(out).toMatchObject({ questionId: 10, isCorrect: null, method: 'unanswered', noStandardAnswer: true });
    expect(mainError.create).not.toHaveBeenCalled();
    expect((svc as any).explanationCache.ensureExplanation).not.toHaveBeenCalled();
  });

  it('纯空白答案（trim 后空）同样早退——守卫条件与 judgeForPractice 一字不差', async () => {
    const { svc } = makeService({
      questions: { findById: vi.fn(async () => q('calculation', '  ')) },
    });
    (svc as any).judgment = { judge: vi.fn() };
    const out = await svc.judgeQuestion({ studentId: 7, subjectId: 1, questionId: 10, studentAnswer: '1', source: 'targeted' });
    expect(out).toMatchObject({ isCorrect: null, method: 'unanswered', noStandardAnswer: true });
    expect((svc as any).judgment.judge).not.toHaveBeenCalled();
  });
});

describe('judgeQuestion error_fix 发分（错题订正）', () => {
  const correctQ = { id: 10, type: 'choice', answer: 'A', options: '[{"label":"A","isCorrect":true}]' };
  const input = (source: string) => ({ studentId: 1, subjectId: 1, questionId: 10, studentAnswer: 'A', source });
  const mkPoints = () => ({
    award: vi.fn(async () => ({ pointsAwarded: 3 })),
    todayKey: vi.fn(() => '2026-09-17'),
  });

  /** clearedNb = clearUnclearedByStudentQuestionId 的 affectedRows。 */
  const svcWith = (clearedNb: number, points = mkPoints()) => {
    const { svc } = makeService({
      questions: { findById: vi.fn(async () => correctQ) },
      mainError: {
        findUnclearedByStudentQuestionId: vi.fn(async () => null),
        create: vi.fn(async () => 101),
        clearUnclearedByStudentQuestionId: vi.fn(async () => clearedNb),
      },
      points,
    });
    return { svc, points };
  };

  it('cleared = 0（首次就答对）-> 不发分，awardReason=not_cleared', async () => {
    const { svc, points } = svcWith(0);
    const out = await svc.judgeQuestion(input('error_practice'));
    expect(out.isCorrect).toBe(true);
    expect(out.pointsAwarded).toBe(0);
    expect(out.awardReason).toBe('not_cleared');
    expect(points.award).not.toHaveBeenCalled();
  });

  it('cleared > 0 + error_practice -> 发一次，响应带 pointsAwarded 且无 awardReason', async () => {
    const { svc, points } = svcWith(1);
    const out = await svc.judgeQuestion(input('error_practice'));
    expect(out.pointsAwarded).toBe(3);
    expect(out.awardReason).toBeUndefined();
    expect(points.award).toHaveBeenCalledTimes(1);
    expect(points.award).toHaveBeenCalledWith({
      studentId: 1,
      taskCode: 'error_fix',
      dedupeKey: 'err:1:10:2026-09-17',
      refType: 'question',
      refId: 10,
    });
    // 日期后缀只来自 PointsService.todayKey()（单一真源，不在 judge-core 重写格式化）
    expect(points.todayKey).toHaveBeenCalled();
  });

  it('award 返回 reason=daily_limit -> 响应透传 awardReason=daily_limit，pointsAwarded=0', async () => {
    const points = {
      award: vi.fn(async () => ({ pointsAwarded: 0, reason: 'daily_limit' })),
      todayKey: vi.fn(() => '2026-09-17'),
    };
    const { svc } = svcWith(1, points);
    const out = await svc.judgeQuestion(input('error_practice'));
    expect(out.isCorrect).toBe(true);
    expect(out.pointsAwarded).toBe(0);
    expect(out.awardReason).toBe('daily_limit');
  });

  it('award 返回 reason=duplicate（同日重判的幂等命中）-> pointsAwarded 归 0，不报假分', async () => {
    // Finding C1：PointsService.award 幂等命中时回的是**首次**分值（3）而不是 0，
    // 直接透传会让前端弹一个账本/余额都没动过的「+3 分」。只有干净成功才认这个值。
    const points = {
      award: vi.fn(async () => ({ pointsAwarded: 3, reason: 'duplicate' })),
      todayKey: vi.fn(() => '2026-09-17'),
    };
    const { svc } = svcWith(1, points);
    const out = await svc.judgeQuestion(input('error_practice'));
    expect(out.isCorrect).toBe(true);
    expect(out.pointsAwarded).toBe(0);
    expect(out.awardReason).toBeUndefined();
    expect(points.award).toHaveBeenCalledTimes(1);
  });

  it('cleared > 0 + source = exam（交卷补判）-> 不发分（考试分只由 math_paper 给）', async () => {
    const { svc, points } = svcWith(1);
    const out = await svc.judgeQuestion(input('exam'));
    expect(out.isCorrect).toBe(true);
    expect(out.pointsAwarded).toBe(0);
    expect(points.award).not.toHaveBeenCalled();
  });

  it('award 抛错 -> 判题结果照常返回（不冒泡，不阻断），pointsAwarded=0', async () => {
    const points = {
      award: vi.fn(async () => { throw new Error('points down'); }),
      todayKey: vi.fn(() => '2026-09-17'),
    };
    const { svc } = svcWith(1, points);
    const out = await svc.judgeQuestion(input('error_practice'));
    expect(out).toMatchObject({ questionId: 10, isCorrect: true, method: 'exact' });
    expect(out.pointsAwarded).toBe(0);
    expect(out.awardReason).toBeUndefined();
    expect(points.award).toHaveBeenCalledTimes(1);
  });

  it('同日两次订正同题 -> dedupeKey 相同（重复调用不会二次计分）', async () => {
    const { svc, points } = svcWith(1);
    await svc.judgeQuestion(input('error_practice'));
    await svc.judgeQuestion(input('error_practice'));
    expect(points.award).toHaveBeenCalledTimes(2);
    const keys = points.award.mock.calls.map((c: any[]) => c[0].dedupeKey);
    expect(keys[0]).toBe('err:1:10:2026-09-17');
    expect(keys[1]).toBe(keys[0]);
  });
});

describe('judgeForPractice error_fix 发分（card 中心 / 主线清零入口）', () => {
  const input = { studentId: 7, subjectId: 1, cardId: 3, lessonId: 5, questionN: '0-1', questionText: '题面', studentAnswer: 'A' };
  const correctQ = { id: 10, type: 'choice', answer: 'A', options: '[{"label":"A","isCorrect":true}]' };
  const mkPoints = () => ({
    award: vi.fn(async () => ({ pointsAwarded: 3 })),
    todayKey: vi.fn(() => '2026-09-17'),
  });
  /** clearedNb = clearUnclearedByStudentQuestion 的 affectedRows。 */
  const svcWith = (clearedNb: number, points = mkPoints(), q: any = correctQ) => {
    const { svc } = makeService({
      mainError: {
        findUnclearedByStudentQuestion: vi.fn(async () => null),
        findUnclearedByStudentQuestionId: vi.fn(async () => null),
        create: vi.fn(async () => 101),
        clearUnclearedByStudentQuestion: vi.fn(async () => clearedNb),
        clearUnclearedByStudentQuestionId: vi.fn(async () => clearedNb),
      },
      points,
    });
    // q=null 时走路由 2 AI；测试里固定判对以便到达发分分支
    (svc as any).judgment = { judge: vi.fn(async () => ({ isCorrect: true, errorType: null })) };
    return { svc, points, q };
  };

  it('affectedRows > 0 + questionId 非空 -> 发一次，幂等键 err:<sid>:<qid>:<date>，响应带 pointsAwarded', async () => {
    const { svc, points } = svcWith(1);
    const out = await svc.judgeForPractice(input, correctQ as any);
    expect(out.isCorrect).toBe(true);
    expect(out.pointsAwarded).toBe(3);
    expect(out.awardReason).toBeUndefined();
    expect(points.award).toHaveBeenCalledTimes(1);
    expect(points.award).toHaveBeenCalledWith({
      studentId: 7,
      taskCode: 'error_fix',
      dedupeKey: 'err:7:10:2026-09-17',
      refType: 'question',
      refId: 10,
    });
    expect(points.todayKey).toHaveBeenCalled();
  });

  it('affectedRows === 0（本无未清错题）-> 不发分，awardReason=not_cleared', async () => {
    const { svc, points } = svcWith(0);
    const out = await svc.judgeForPractice(input, correctQ as any);
    expect(out.isCorrect).toBe(true);
    expect(out.pointsAwarded).toBe(0);
    expect(out.awardReason).toBe('not_cleared');
    expect(points.award).not.toHaveBeenCalled();
  });

  it('questionId === null（仅存题面的孤儿题）-> 即使 affectedRows > 0 也不发分', async () => {
    // 仅存题面的错题没有稳定幂等身份：题面可被无关编辑改掉，题面派生 key 会发第二次分。
    const { svc, points } = svcWith(1);
    const out = await svc.judgeForPractice(input, null);
    expect(out.questionId).toBeNull();
    expect(out.isCorrect).toBe(true);
    expect(out.pointsAwarded).toBe(0);
    expect(out.awardReason).toBeUndefined();
    expect(points.award).not.toHaveBeenCalled();
  });

  it('award 抛错 -> 判题结果照常返回（points 失败绝不阻断判题），pointsAwarded=0', async () => {
    const points = {
      award: vi.fn(async () => { throw new Error('points down'); }),
      todayKey: vi.fn(() => '2026-09-17'),
    };
    const { svc } = svcWith(1, points);
    const out = await svc.judgeForPractice(input, correctQ as any);
    expect(out).toMatchObject({ questionId: 10, isCorrect: true, method: 'exact' });
    expect(out.pointsAwarded).toBe(0);
    expect(out.awardReason).toBeUndefined();
    expect(points.award).toHaveBeenCalledTimes(1);
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

  it('correct + 真正清掉未清错题（非 exam）-> 走同一 error_fix 判决发分', async () => {
    const { svc, pointsService } = makeService({
      mainError: {
        findUnclearedByStudentQuestionId: vi.fn(async () => null),
        create: vi.fn(async () => 101),
        clearUnclearedByStudentQuestionId: vi.fn(async () => 1),
      },
    });
    await svc.recordSelfAssessment({ studentId: 7, subjectId: 1, questionId: 10, assessment: 'correct', source: 'error_practice' });
    expect(pointsService.award).toHaveBeenCalledWith(expect.objectContaining({
      taskCode: 'error_fix',
      dedupeKey: 'err:7:10:2026-09-17',
      refType: 'question',
      refId: 10,
    }));
  });

  it('correct + source=exam -> 清零但不发分（考试分只由 math_paper 一次性给）', async () => {
    const { svc, pointsService } = makeService({
      mainError: {
        findUnclearedByStudentQuestionId: vi.fn(async () => null),
        create: vi.fn(async () => 101),
        clearUnclearedByStudentQuestionId: vi.fn(async () => 1),
      },
    });
    await svc.recordSelfAssessment({ studentId: 7, subjectId: 1, questionId: 10, assessment: 'correct', source: 'exam', sourceRefId: 55 });
    expect(pointsService.award).not.toHaveBeenCalled();
  });
});
