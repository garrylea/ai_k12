import { describe, it, expect, vi } from 'vitest';
import { PracticeService } from './practice.service';
import { JudgeCoreService } from './judge-core.service';
import { HttpException } from '@nestjs/common';

const mk = (overrides: any = {}) => ({
  questionsRepo: {
    findByContentHash: vi.fn().mockResolvedValue(null),
    findOrCreate: vi.fn(),
    deleteById: vi.fn().mockResolvedValue(undefined),
  },
  mainErrorRepo: { create: vi.fn().mockResolvedValue(42), findUnclearedByStudentQuestion: vi.fn().mockResolvedValue(null), clearUnclearedByStudentQuestion: vi.fn().mockResolvedValue(undefined), updateDialogueId: vi.fn().mockResolvedValue(undefined), findUnclearedPracticeByStudentSubject: vi.fn().mockResolvedValue([]) },
  structuring: { structure: vi.fn() },
  judgment: { judge: vi.fn() },
  explanationCache: { ensureExplanation: vi.fn() },
  cardsRepo: {
    findHintsById: vi.fn().mockResolvedValue(null),
    upsertHint: vi.fn().mockResolvedValue(undefined),
  },
  hint: { generate: vi.fn() },
  conversationsService: {
    create: vi.fn().mockResolvedValue({ id: 100 }),
    get: vi.fn().mockResolvedValue({ id: 100 }),
    findOrCreateMainlineByCard: vi.fn().mockResolvedValue({ id: 100 }),
  },
  practiceResultsRepo: {
    upsert: vi.fn().mockResolvedValue(undefined),
    findByStudentCard: vi.fn().mockResolvedValue([]),
    findByStudentLesson: vi.fn().mockResolvedValue([]),
    deleteByStudentCard: vi.fn().mockResolvedValue(undefined),
    deleteByStudentLesson: vi.fn().mockResolvedValue(undefined),
  },
  progressRepo: {
    findByStudentAndSubject: vi.fn().mockResolvedValue(null),
  },
  selfAssessRepo: {
    create: vi.fn().mockResolvedValue(1),
  },
  contentService: {
    getLessonCards: vi.fn().mockResolvedValue({ cards: [] }),
  },
  ...overrides,
});

/** 用 mk() 构造的依赖实例化 PracticeService。
 *  第 11 参 judgeCore 为判题核心抽取新增依赖；explanationCache 注入判题核心内部
 *  （判错解析缓存生成，PracticeService 不经手）——机械注入调整，不改测试语义。
 *  judgeCore 第 6 参 selfAssessRepo 为判题体系重构（2026-09-09）新增（recordSelfAssessment 用）。 */
const mkSvc = (deps: ReturnType<typeof mk>) =>
  new PracticeService(deps.questionsRepo, deps.mainErrorRepo, deps.structuring, deps.judgment as any, deps.cardsRepo, deps.hint as any, deps.conversationsService as any, deps.practiceResultsRepo as any, deps.contentService as any, deps.progressRepo as any, new JudgeCoreService(deps.questionsRepo, deps.mainErrorRepo, deps.structuring, deps.judgment as any, deps.explanationCache as any, deps.selfAssessRepo as any));

describe('PracticeService.judge', () => {
  it('客观题命中 -> exact 比对，答错入错题本（不插题）', async () => {
    const deps = mk({
      questionsRepo: {
        findByContentHash: vi.fn().mockResolvedValue({ id: 10, type: 'choice', answer: 'A', options: '[{"label":"A","isCorrect":true}]' }),
        findOrCreate: vi.fn(),
        deleteById: vi.fn(),
      },
    });
    const svc = mkSvc(deps);
    const r = await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionN: '0-1', questionText: '题', studentAnswer: 'B' });
    expect(r.isCorrect).toBe(false);
    expect(r.method).toBe('exact');
    expect(r.errorBookId).toBe(42);
    expect(deps.judgment.judge).not.toHaveBeenCalled();
    expect(deps.structuring.structure).not.toHaveBeenCalled();
  });

  it('options isCorrect 分支：选对正确选项 -> exact 比对为 true', async () => {
    // answer 字段故意写 'C'（错误选项），验证 options[].isCorrect 分支生效，
    // 不是 fallthrough 到字符串比对（否则会判错）。
    const deps = mk({
      questionsRepo: {
        findByContentHash: vi.fn().mockResolvedValue({
          id: 30, type: 'choice', answer: 'C',
          options: '[{"label":"A","isCorrect":true},{"label":"B","isCorrect":false},{"label":"C","isCorrect":false}]',
        }),
        findOrCreate: vi.fn(),
        deleteById: vi.fn(),
      },
    });
    const svc = mkSvc(deps);
    const r = await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionN: '0-1', questionText: '选择题', studentAnswer: 'A' });
    expect(r.isCorrect).toBe(true);
    expect(r.method).toBe('exact');
    expect(deps.judgment.judge).not.toHaveBeenCalled();
    expect(deps.mainErrorRepo.create).not.toHaveBeenCalled();
  });

  it('choice 题 options 无 isCorrect 标记 -> 退化为与 answer 标签比对（答对）', async () => {
    // 题库 choice 题常只存 answer="A" 而 options 无 isCorrect 标记；
    // 此前 bug：picked 命中但 isCorrect undefined -> !!undefined=false 误判错。
    const deps = mk({
      questionsRepo: {
        findByContentHash: vi.fn().mockResolvedValue({
          id: 31, type: 'choice', answer: 'A',
          options: '[{"label":"A","text":"氮气"},{"label":"B","text":"氧气"}]',
        }),
        findOrCreate: vi.fn(),
        deleteById: vi.fn(),
      },
    });
    const svc = mkSvc(deps);
    const r = await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionN: '0-1', questionText: '选择题', studentAnswer: 'A' });
    expect(r.isCorrect).toBe(true);
    expect(r.method).toBe('exact');
    expect(deps.mainErrorRepo.create).not.toHaveBeenCalled();
  });

  it('fill_blank 命中且归一化相等（2/3 vs $\\frac{2}{3}$）-> exact 判对，省 AI', async () => {
    // 学生输入 2/3，题库答案 $\frac{2}{3}$，归一化（\frac{a}{b}->a/b）后均为 2/3 -> exact 判对，不调 AI。
    const deps = mk({
      questionsRepo: {
        findByContentHash: vi.fn().mockResolvedValue({ id: 62, type: 'fill_blank', answer: '$\\frac{2}{3}$', options: null }),
        findOrCreate: vi.fn(),
        deleteById: vi.fn(),
      },
    });
    const svc = mkSvc(deps);
    const r = await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionN: '0-1', questionText: '计算题', studentAnswer: '2/3' });
    expect(r.isCorrect).toBe(true);
    expect(r.method).toBe('exact');
    expect(deps.judgment.judge).not.toHaveBeenCalled();
    expect(deps.mainErrorRepo.create).not.toHaveBeenCalled();
  });

  it('fill_blank 命中但归一化不等（2/3 vs 1/2）-> 走 AI 复核，不直接判错', async () => {
    // 形式不同且归一化不等时，交 AI 判定，避免 0.666 vs 2/3 等等价但归一化不匹配的情况被误判错。
    const deps = mk({
      questionsRepo: {
        findByContentHash: vi.fn().mockResolvedValue({ id: 63, type: 'fill_blank', answer: '1/2', options: null }),
        findOrCreate: vi.fn(),
        deleteById: vi.fn(),
      },
      judgment: { judge: vi.fn().mockResolvedValue({ isCorrect: false, analysis: '应为 1/2', errorType: 'calculation' }) },
    });
    const svc = mkSvc(deps);
    const r = await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionN: '0-1', questionText: '计算题', studentAnswer: '2/3' });
    expect(r.method).toBe('ai');
    expect(deps.judgment.judge).toHaveBeenCalled();
    expect(r.isCorrect).toBe(false);
    // 判错且 q 非空 -> 触发解析缓存生成（传完整 q）
    expect(deps.explanationCache.ensureExplanation).toHaveBeenCalledWith({ id: 63, type: 'fill_blank', answer: '1/2', options: null });
  });

  it('未命中 -> AI 判定，答错 -> 结构化 + 插题 + 入错题本', async () => {
    const deps = mk({
      judgment: { judge: vi.fn().mockResolvedValue({ isCorrect: false, analysis: '错因', errorType: 'calculation' }) },
      structuring: { structure: vi.fn().mockResolvedValue({ quality: 'good', content: '题', type: 'short_answer', difficulty: 2, answer: 'a', explanation: 'e', knowledgePoints: [] }) },
      questionsRepo: {
        findByContentHash: vi.fn().mockResolvedValue(null),
        findOrCreate: vi.fn().mockResolvedValue({ id: 77, created: true }),
        deleteById: vi.fn(),
      },
    });
    const svc = mkSvc(deps);
    const r = await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionN: '0-1', questionText: '题', studentAnswer: '答' });
    expect(r.isCorrect).toBe(false);
    expect(r.method).toBe('ai');
    expect(r.errorBookId).toBe(42);
    expect(deps.structuring.structure).toHaveBeenCalled();
    expect(deps.questionsRepo.findOrCreate).toHaveBeenCalled();
    // 结构化真正新建（created:true）-> 触发解析缓存生成（合成最小对象）
    expect(deps.explanationCache.ensureExplanation).toHaveBeenCalledWith({ id: 77, answer: 'a', explanation: 'e' });
  });

  it('未命中 -> AI 判错且 findOrCreate 命中既有题（created:false）-> 不触发 ensureExplanation', async () => {
    // 命中既有题时其解析由判错后对 DB 行 q 的 ensureExplanation 处理；此处 q 为 null 且 created:false，
    // 不应走合成对象触发，避免长答案直写覆盖既有解析。
    const deps = mk({
      judgment: { judge: vi.fn().mockResolvedValue({ isCorrect: false, analysis: '错因', errorType: 'calculation' }) },
      structuring: { structure: vi.fn().mockResolvedValue({ quality: 'good', content: '题', type: 'short_answer', difficulty: 2, answer: 'a', explanation: 'e', knowledgePoints: [] }) },
      questionsRepo: {
        findByContentHash: vi.fn().mockResolvedValue(null),
        findOrCreate: vi.fn().mockResolvedValue({ id: 77, created: false }),
        deleteById: vi.fn(),
      },
    });
    const svc = mkSvc(deps);
    await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionN: '0-1', questionText: '题', studentAnswer: '答' });
    expect(deps.explanationCache.ensureExplanation).not.toHaveBeenCalled();
  });

  it('未命中 -> AI 判定答对 -> 不插题不入错题本', async () => {
    const deps = mk({
      judgment: { judge: vi.fn().mockResolvedValue({ isCorrect: true, analysis: '', errorType: null }) },
    });
    const svc = mkSvc(deps);
    const r = await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionN: '0-1', questionText: '题', studentAnswer: '答' });
    expect(r.isCorrect).toBe(true);
    expect(r.errorBookId).toBeUndefined();
    expect(deps.structuring.structure).not.toHaveBeenCalled();
  });

  it('proof 题命中 -> AI 路径，questionType=proof 传给 judgment，不插题', async () => {
    // 判题体系重构（2026-09-09）：proof 默认 self_assess 早退，AI 路径须显式切回（finally 复原防泄漏）
    process.env.JUDGE_SUBJECTIVE_MODE = 'ai';
    try {
      const deps = mk({
        questionsRepo: {
          findByContentHash: vi.fn().mockResolvedValue({ id: 20, type: 'proof', answer: '证明过程', explanation: '提示', options: null }),
          findOrCreate: vi.fn(),
          deleteById: vi.fn(),
        },
        judgment: { judge: vi.fn().mockResolvedValue({ isCorrect: true, analysis: '', errorType: null }) },
      });
      const svc = mkSvc(deps);
      const r = await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionN: '0-1', questionText: '证明题', studentAnswer: '学生证明' });
      expect(r.method).toBe('ai');
      expect(r.isCorrect).toBe(true);
      expect(deps.judgment.judge).toHaveBeenCalledWith(expect.objectContaining({ questionType: 'proof' }));
      expect(deps.questionsRepo.findOrCreate).not.toHaveBeenCalled();
      expect(deps.structuring.structure).not.toHaveBeenCalled();
    } finally {
      delete process.env.JUDGE_SUBJECTIVE_MODE;
    }
  });

  it('proof 题默认（self_assess 模式）-> 不判对错早退，返回参考答案/解析且不落 practice_results', async () => {
    // 判题体系重构（2026-09-09）：judgeForPractice 路由 1c 镜像 judgeQuestion
    delete process.env.JUDGE_SUBJECTIVE_MODE;
    const deps = mk({
      questionsRepo: {
        findByContentHash: vi.fn().mockResolvedValue({ id: 20, type: 'proof', answer: '证明过程', explanation: '提示', options: null }),
        findOrCreate: vi.fn(),
        deleteById: vi.fn(),
      },
    });
    const svc = mkSvc(deps);
    const r = await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionN: '0-1', questionText: '证明题', studentAnswer: '学生证明' });
    expect(r).toMatchObject({ questionId: 20, isCorrect: null, method: 'self_assess', needsSelfAssessment: true, referenceAnswer: '证明过程', explanation: '提示' });
    expect(deps.judgment.judge).not.toHaveBeenCalled();
    expect(deps.mainErrorRepo.create).not.toHaveBeenCalled();
    expect(deps.practiceResultsRepo.upsert).not.toHaveBeenCalled();
  });

  it('structure 失败 -> 仍入错题本（questionId=null, wrong_answer_text=题面）', async () => {
    const deps = mk({
      structuring: { structure: vi.fn().mockRejectedValue(new Error('AI 挂了')) },
      judgment: { judge: vi.fn().mockResolvedValue({ isCorrect: false, analysis: '错因', errorType: 'calculation' }) },
    });
    const svc = mkSvc(deps);
    const r = await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionN: '0-1', questionText: '难题', studentAnswer: '错答' });
    expect(r.isCorrect).toBe(false);
    expect(r.errorBookId).toBe(42);
    expect(deps.mainErrorRepo.create).toHaveBeenCalledWith(expect.objectContaining({
      question_id: null,
      lesson_id: 9,
      wrong_answer_text: '难题',
    }));
  });

  it('AI 判定失败 -> 抛 503 HttpException，不进错题本', async () => {
    const deps = mk({
      judgment: { judge: vi.fn().mockRejectedValue(new Error('LLM timeout')) },
    });
    const svc = mkSvc(deps);
    await expect(
      svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionN: '0-1', questionText: '题', studentAnswer: '答' }),
    ).rejects.toThrow(HttpException);
    expect(deps.mainErrorRepo.create).not.toHaveBeenCalled();
    expect(deps.structuring.structure).not.toHaveBeenCalled();
  });

  it('孤儿题补偿：mainErrorRepo.create 失败且刚创建了题 -> deleteById 被调用', async () => {
    const deps = mk({
      judgment: { judge: vi.fn().mockResolvedValue({ isCorrect: false, analysis: '错因', errorType: 'calculation' }) },
      structuring: { structure: vi.fn().mockResolvedValue({ quality: 'good', content: '题', type: 'short_answer', difficulty: 2, answer: 'a', explanation: 'e', knowledgePoints: [] }) },
      questionsRepo: {
        findByContentHash: vi.fn().mockResolvedValue(null),
        findOrCreate: vi.fn().mockResolvedValue({ id: 88, created: true }),
        deleteById: vi.fn().mockResolvedValue(undefined),
      },
      mainErrorRepo: { create: vi.fn().mockRejectedValue(new Error('DB down')), findUnclearedByStudentQuestion: vi.fn().mockResolvedValue(null) },
    });
    const svc = mkSvc(deps);
    await expect(
      svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionN: '0-1', questionText: '题', studentAnswer: '错答' }),
    ).rejects.toThrow('DB down');
    expect(deps.questionsRepo.deleteById).toHaveBeenCalledWith(88);
  });

  it('judge 答对 -> upsert practice_results(is_correct=true) + clearUnclearedByStudentQuestion，不入错题本', async () => {
    const deps = mk({
      questionsRepo: {
        findByContentHash: vi.fn().mockResolvedValue({ id: 10, type: 'choice', answer: 'A', options: '[{"label":"A","isCorrect":true}]' }),
        findOrCreate: vi.fn(), deleteById: vi.fn(),
      },
    });
    const svc = mkSvc(deps);
    await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionN: '0-1', questionText: '题', studentAnswer: 'A' });
    expect(deps.practiceResultsRepo.upsert).toHaveBeenCalledWith(expect.objectContaining({
      student_id: 1, card_id: 5, lesson_id: 9, question_id: 10, question_n: '0-1',
      is_correct: true, method: 'exact', analysis: null,
    }));
    expect(deps.mainErrorRepo.clearUnclearedByStudentQuestion).toHaveBeenCalledWith(1, 10, 5, '题');
    expect(deps.mainErrorRepo.create).not.toHaveBeenCalled();
  });

  it('judge 答错 -> upsert practice_results(is_correct=false) + find-or-create 错题本', async () => {
    const deps = mk({
      questionsRepo: {
        findByContentHash: vi.fn().mockResolvedValue({ id: 10, type: 'choice', answer: 'A', options: '[{"label":"A","isCorrect":true}]' }),
        findOrCreate: vi.fn(), deleteById: vi.fn(),
      },
    });
    const svc = mkSvc(deps);
    await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionN: '0-1', questionText: '题', studentAnswer: 'B' });
    expect(deps.practiceResultsRepo.upsert).toHaveBeenCalledWith(expect.objectContaining({
      is_correct: false, question_n: '0-1', analysis: null,
    }));
    expect(deps.mainErrorRepo.findUnclearedByStudentQuestion).toHaveBeenCalledWith(1, 10, 5, '题');
    expect(deps.mainErrorRepo.create).toHaveBeenCalled();
  });

  it('judge 答错且已有未清错题 -> find-or-create 复用，不重复 create', async () => {
    const deps = mk({
      questionsRepo: {
        findByContentHash: vi.fn().mockResolvedValue({ id: 10, type: 'choice', answer: 'A', options: '[{"label":"A","isCorrect":true}]' }),
        findOrCreate: vi.fn(), deleteById: vi.fn(),
      },
      mainErrorRepo: {
        create: vi.fn(),
        findUnclearedByStudentQuestion: vi.fn().mockResolvedValue({ id: 77 }),
        clearUnclearedByStudentQuestion: vi.fn(),
        updateDialogueId: vi.fn(), countUnclearedByLesson: vi.fn(),
      },
    });
    const svc = mkSvc(deps);
    const r = await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionN: '0-1', questionText: '题', studentAnswer: 'B' });
    expect(r.errorBookId).toBe(77);
    expect(deps.mainErrorRepo.create).not.toHaveBeenCalled();
  });

  it('choice 空答案题 -> noStandardAnswer 分支：只落一行 method=unanswered（主 upsert 不触发）', async () => {
    // T3 契约：judgeForPractice 路由 0 对空答案 choice 早退 noStandardAnswer，
    // PracticeService 仍落 practice_results 行（method='unanswered'，is_correct=false）
    // 保证课程完成门禁的作答覆盖计数不缺行。
    const deps = mk({
      questionsRepo: {
        findByContentHash: vi.fn().mockResolvedValue({ id: 10, type: 'choice', answer: '', options: '[{"label":"A","isCorrect":false}]' }),
        findOrCreate: vi.fn(), deleteById: vi.fn(),
      },
    });
    const svc = mkSvc(deps);
    const r = await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionN: '0-1', questionText: '题', studentAnswer: 'A' });
    expect(r.noStandardAnswer).toBe(true);
    expect(r.isCorrect).toBeNull();
    expect(r.method).toBe('unanswered');
    // 恰好一次（noStandardAnswer 分支），主 upsert 分支不触发
    expect(deps.practiceResultsRepo.upsert).toHaveBeenCalledTimes(1);
    expect(deps.practiceResultsRepo.upsert).toHaveBeenCalledWith(expect.objectContaining({
      question_id: 10, question_n: '0-1', is_correct: false, method: 'unanswered', analysis: null, error_type: null,
    }));
    expect(deps.mainErrorRepo.create).not.toHaveBeenCalled();
    expect(deps.judgment.judge).not.toHaveBeenCalled();
    expect(deps.explanationCache.ensureExplanation).not.toHaveBeenCalled();
  });

  it('judge AI 失败(503) -> 不 upsert practice_results', async () => {
    const deps = mk({
      judgment: { judge: vi.fn().mockRejectedValue(new Error('LLM timeout')) },
    });
    const svc = mkSvc(deps);
    await expect(
      svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionN: '0-1', questionText: '题', studentAnswer: '答' }),
    ).rejects.toThrow(HttpException);
    expect(deps.practiceResultsRepo.upsert).not.toHaveBeenCalled();
  });

  it('practiceResultsRepo.upsert 失败 -> 不阻断判题返回（best-effort）', async () => {
    const deps = mk({
      questionsRepo: {
        findByContentHash: vi.fn().mockResolvedValue({ id: 10, type: 'choice', answer: 'A', options: '[{"label":"A","isCorrect":true}]' }),
        findOrCreate: vi.fn(), deleteById: vi.fn(),
      },
      practiceResultsRepo: { upsert: vi.fn().mockRejectedValue(new Error('DB down')), findByStudentCard: vi.fn(), deleteByStudentCard: vi.fn(), deleteByStudentLesson: vi.fn() },
    });
    const svc = mkSvc(deps);
    const r = await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionN: '0-1', questionText: '题', studentAnswer: 'A' });
    expect(r.isCorrect).toBe(true);
  });

  it('clearUnclearedByStudentQuestion 失败 -> 不阻断判题返回（best-effort）', async () => {
    const deps = mk({
      questionsRepo: {
        findByContentHash: vi.fn().mockResolvedValue({ id: 10, type: 'choice', answer: 'A', options: '[{"label":"A","isCorrect":true}]' }),
        findOrCreate: vi.fn(), deleteById: vi.fn(),
      },
      mainErrorRepo: {
        create: vi.fn(),
        findUnclearedByStudentQuestion: vi.fn(),
        clearUnclearedByStudentQuestion: vi.fn().mockRejectedValue(new Error('DB down')),
        updateDialogueId: vi.fn(), countUnclearedByLesson: vi.fn(),
      },
    });
    const svc = mkSvc(deps);
    const r = await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionN: '0-1', questionText: '题', studentAnswer: 'A' });
    expect(r.isCorrect).toBe(true);
  });

  it('答错未入库题且已有未清错题（questionId=null，按题面匹配）-> find-or-create 复用，不重复 create', async () => {
    const deps = mk({
      judgment: { judge: vi.fn().mockResolvedValue({ isCorrect: false, analysis: '错因', errorType: 'calculation' }) },
      structuring: { structure: vi.fn().mockResolvedValue({ quality: 'poor', content: '', type: 'short_answer', difficulty: 2, answer: 'a', explanation: 'e', knowledgePoints: [] }) },
      questionsRepo: { findByContentHash: vi.fn().mockResolvedValue(null), findOrCreate: vi.fn(), deleteById: vi.fn() },
      mainErrorRepo: {
        create: vi.fn(),
        findUnclearedByStudentQuestion: vi.fn().mockResolvedValue({ id: 88 }),
        clearUnclearedByStudentQuestion: vi.fn(),
        updateDialogueId: vi.fn(), countUnclearedByLesson: vi.fn(),
      },
    });
    const svc = mkSvc(deps);
    const r = await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionN: '0-1', questionText: '未入库题', studentAnswer: '错答' });
    expect(r.errorBookId).toBe(88);
    expect(deps.mainErrorRepo.create).not.toHaveBeenCalled();
    expect(deps.mainErrorRepo.findUnclearedByStudentQuestion).toHaveBeenCalledWith(1, null, 5, '未入库题');
  });
});

describe('PracticeService.getHint', () => {
  it('命中 cards.hints 缓存 -> 直返，不调 AI、不写回', async () => {
    const deps = mk({
      cardsRepo: {
        findHintsById: vi.fn().mockResolvedValue(JSON.stringify({ '题面A': '缓存提示' })),
        upsertHint: vi.fn(),
      },
    });
    const svc = mkSvc(deps);
    const r = await svc.getHint({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionText: '题面A' });
    expect(r.cached).toBe(true);
    expect(r.hint).toBe('缓存提示');
    expect(deps.hint.generate).not.toHaveBeenCalled();
    expect(deps.cardsRepo.upsertHint).not.toHaveBeenCalled();
  });

  it('缓存未命中 -> 调 AI 生成并写回 cards.hints，cached=false', async () => {
    const deps = mk({
      cardsRepo: {
        findHintsById: vi.fn().mockResolvedValue(null),
        upsertHint: vi.fn().mockResolvedValue(undefined),
      },
      hint: { generate: vi.fn().mockResolvedValue({ content: 'AI 新提示', reasoning: '思考' }) },
    });
    const svc = mkSvc(deps);
    const r = await svc.getHint({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionText: '题面B' });
    expect(r.cached).toBe(false);
    expect(r.hint).toBe('AI 新提示');
    expect(deps.hint.generate).toHaveBeenCalledWith({ questionContent: '题面B', subject: 'math' });
    expect(deps.cardsRepo.upsertHint).toHaveBeenCalledWith(5, '题面B', 'AI 新提示');
  });

  it('缓存 JSON 损坏 -> 忽略缓存走生成路径', async () => {
    const deps = mk({
      cardsRepo: {
        findHintsById: vi.fn().mockResolvedValue('{不是合法json'),
        upsertHint: vi.fn().mockResolvedValue(undefined),
      },
      hint: { generate: vi.fn().mockResolvedValue({ content: '新生成' }) },
    });
    const svc = mkSvc(deps);
    const r = await svc.getHint({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionText: '题面C' });
    expect(r.cached).toBe(false);
    expect(deps.hint.generate).toHaveBeenCalled();
  });

  it('AI 生成失败 -> 抛 503 HttpException，不写缓存', async () => {
    const deps = mk({
      cardsRepo: { findHintsById: vi.fn().mockResolvedValue(null), upsertHint: vi.fn() },
      hint: { generate: vi.fn().mockRejectedValue(new Error('LLM timeout')) },
    });
    const svc = mkSvc(deps);
    await expect(
      svc.getHint({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionText: '题面D' }),
    ).rejects.toThrow(HttpException);
    expect(deps.cardsRepo.upsertHint).not.toHaveBeenCalled();
  });

  it('upsertHint 写回失败 -> 不阻断返回提示（仅记日志）', async () => {
    const deps = mk({
      cardsRepo: { findHintsById: vi.fn().mockResolvedValue(null), upsertHint: vi.fn().mockRejectedValue(new Error('DB down')) },
      hint: { generate: vi.fn().mockResolvedValue({ content: '提示' }) },
    });
    const svc = mkSvc(deps);
    const r = await svc.getHint({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionText: '题面E' });
    expect(r.hint).toBe('提示');
    expect(r.cached).toBe(false);
  });
});

describe('PracticeService.startDiscuss', () => {
  it('首次打开 -> 记错题本(source=discuss) + 创建 mainline 对话 + 回写 dialogue_id', async () => {
    const deps = mk({
      questionsRepo: { findByContentHash: vi.fn().mockResolvedValue({ id: 10 }), findOrCreate: vi.fn(), deleteById: vi.fn() },
      mainErrorRepo: { create: vi.fn().mockResolvedValue(55), findUnclearedByStudentQuestion: vi.fn().mockResolvedValue(null), updateDialogueId: vi.fn() },
      conversationsService: { create: vi.fn().mockResolvedValue({ id: 200 }), get: vi.fn() },
    });
    const svc = mkSvc(deps);
    const r = await svc.startDiscuss({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionText: '题面' });
    expect(r.dialogueId).toBe('200');
    expect(r.errorBookId).toBe(55);
    expect(r.questionId).toBe(10);
    expect(deps.mainErrorRepo.create).toHaveBeenCalledWith(expect.objectContaining({
      source: 'discuss', source_ref_id: 5, question_id: 10, lesson_id: 9, wrong_answer_text: null,
    }));
    expect(deps.conversationsService.create).toHaveBeenCalledWith(1, { track: 'mainline', scene: 'mainline_question', cardId: 5 });
    expect(deps.mainErrorRepo.updateDialogueId).toHaveBeenCalledWith(55, 200);
  });

  it('题库未命中 -> questionId=null，wrong_answer_text 存题面', async () => {
    const deps = mk({
      questionsRepo: { findByContentHash: vi.fn().mockResolvedValue(null), findOrCreate: vi.fn(), deleteById: vi.fn() },
      mainErrorRepo: { create: vi.fn().mockResolvedValue(56), findUnclearedByStudentQuestion: vi.fn().mockResolvedValue(null), updateDialogueId: vi.fn() },
    });
    const svc = mkSvc(deps);
    const r = await svc.startDiscuss({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionText: '未入库题' });
    expect(r.questionId).toBeNull();
    expect(deps.mainErrorRepo.create).toHaveBeenCalledWith(expect.objectContaining({
      question_id: null, lesson_id: 9, wrong_answer_text: '未入库题',
    }));
  });

  it('已有未清除错题记录 -> 幂等不重复插入，复用既有 errorBookId', async () => {
    const deps = mk({
      mainErrorRepo: {
        create: vi.fn().mockResolvedValue(999),
        findUnclearedByStudentQuestion: vi.fn().mockResolvedValue({ id: 77 }),
        updateDialogueId: vi.fn(),
      },
    });
    const svc = mkSvc(deps);
    const r = await svc.startDiscuss({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionText: '题面' });
    expect(r.errorBookId).toBe(77);
    expect(deps.mainErrorRepo.create).not.toHaveBeenCalled();
  });

  it('B方案：错题本已绑 dialogue_id 且对话可用 -> 复用，不新建对话、不回写', async () => {
    const deps = mk({
      mainErrorRepo: {
        findUnclearedByStudentQuestion: vi.fn().mockResolvedValue({ id: 77, dialogue_id: 300 }),
        create: vi.fn(),
        updateDialogueId: vi.fn(),
      },
      conversationsService: { create: vi.fn(), get: vi.fn().mockResolvedValue({ id: 300 }) },
    });
    const svc = mkSvc(deps);
    const r = await svc.startDiscuss({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionText: '题面' });
    expect(r.dialogueId).toBe('300');
    expect(r.errorBookId).toBe(77);
    expect(deps.conversationsService.create).not.toHaveBeenCalled();
    expect(deps.mainErrorRepo.updateDialogueId).not.toHaveBeenCalled();
  });

  it('B方案兜底：绑定的 dialogue_id 已失效 -> 重建对话并回写', async () => {
    const deps = mk({
      mainErrorRepo: {
        findUnclearedByStudentQuestion: vi.fn().mockResolvedValue({ id: 77, dialogue_id: 300 }),
        create: vi.fn(),
        updateDialogueId: vi.fn(),
      },
      conversationsService: { create: vi.fn().mockResolvedValue({ id: 301 }), get: vi.fn().mockRejectedValue(new Error('not found')) },
    });
    const svc = mkSvc(deps);
    const r = await svc.startDiscuss({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionText: '题面' });
    expect(r.dialogueId).toBe('301');
    expect(deps.conversationsService.create).toHaveBeenCalledWith(1, { track: 'mainline', scene: 'mainline_question', cardId: 5 });
    expect(deps.mainErrorRepo.updateDialogueId).toHaveBeenCalledWith(77, 301);
  });

  it('对话创建失败 -> 抛 500', async () => {
    const deps = mk({
      conversationsService: { create: vi.fn().mockResolvedValue(null), get: vi.fn() },
    });
    const svc = mkSvc(deps);
    await expect(
      svc.startDiscuss({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionText: '题面' }),
    ).rejects.toThrow(HttpException);
  });
});

describe('PracticeService.startCardDiscuss', () => {
  it('find-or-create：复用 conversationsService.findOrCreateMainlineByCard 返回的对话 id', async () => {
    const deps = mk({
      conversationsService: { findOrCreateMainlineByCard: vi.fn().mockResolvedValue({ id: 888 }) },
    });
    const svc = mkSvc(deps);
    const r = await svc.startCardDiscuss({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9 });
    expect(r.dialogueId).toBe('888');
    expect(deps.conversationsService.findOrCreateMainlineByCard).toHaveBeenCalledWith(1, 5, 1);
  });
});

describe('PracticeService.getUnclearedErrorDetails', () => {
  it('返回学生某学科所有未清 practice 错题，按 (cardId, questionN) 去重保留最早', async () => {
    const deps = mk({
      mainErrorRepo: {
        create: vi.fn(),
        findUnclearedByStudentQuestion: vi.fn(),
        clearUnclearedByStudentQuestion: vi.fn(),
        updateDialogueId: vi.fn(),
        findUnclearedPracticeByStudentSubject: vi.fn().mockResolvedValue([
          { id: 9, source_ref_id: 441, question_id: null, question_n: '0-1', questionText: '题A', lesson_id: 181 },
          { id: 11, source_ref_id: 441, question_id: 2775, question_n: '0-4', questionText: '解方程', lesson_id: 182 },
          // 重复 (441, 0-4) -> 去重，保留 id=11
          { id: 15, source_ref_id: 441, question_id: null, question_n: '0-4', questionText: '(4) ...', lesson_id: 181 },
        ]),
      },
    });
    const svc = mkSvc(deps);
    const r = await svc.getUnclearedErrorDetails(2, 1);
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toEqual({ errorBookId: 9, cardId: 441, questionN: '0-1', questionText: '题A', questionId: null, lessonId: 181 });
    expect(r.errors[1]).toEqual({ errorBookId: 11, cardId: 441, questionN: '0-4', questionText: '解方程', questionId: 2775, lessonId: 182 });
  });

  it('question_n 为 null 的历史行 -> 合成唯一键 cleanup 加 id', async () => {
    const deps = mk({
      mainErrorRepo: {
        create: vi.fn(),
        findUnclearedByStudentQuestion: vi.fn(),
        clearUnclearedByStudentQuestion: vi.fn(),
        updateDialogueId: vi.fn(),
        findUnclearedPracticeByStudentSubject: vi.fn().mockResolvedValue([
          { id: 8, source_ref_id: 1, question_id: null, question_n: null, questionText: '旧题' },
        ]),
      },
    });
    const svc = mkSvc(deps);
    const r = await svc.getUnclearedErrorDetails(1, 1);
    expect(r.errors[0].questionN).toBe('cleanup-8');
  });

  it('无未清错题 -> errors 为空', async () => {
    const deps = mk({
      mainErrorRepo: {
        create: vi.fn(),
        findUnclearedByStudentQuestion: vi.fn(),
        clearUnclearedByStudentQuestion: vi.fn(),
        updateDialogueId: vi.fn(),
        findUnclearedPracticeByStudentSubject: vi.fn().mockResolvedValue([]),
      },
    });
    const svc = mkSvc(deps);
    const r = await svc.getUnclearedErrorDetails(1, 1);
    expect(r.errors).toEqual([]);
  });

  it('有 progress 时把 textbook_version_id 传给门禁查询（版本隔离）；无 progress 传 null', async () => {
    const deps = mk({
      progressRepo: { findByStudentAndSubject: vi.fn().mockResolvedValue({ textbookVersionId: 10, currentSemesterId: 88, status: 'in_progress', currentLessonId: 5 }) },
      mainErrorRepo: {
        create: vi.fn(),
        findUnclearedByStudentQuestion: vi.fn(),
        clearUnclearedByStudentQuestion: vi.fn(),
        updateDialogueId: vi.fn(),
        findUnclearedPracticeByStudentSubject: vi.fn().mockResolvedValue([]),
      },
    });
    const svc = mkSvc(deps);
    await svc.getUnclearedErrorDetails(1, 1);
    expect(deps.mainErrorRepo.findUnclearedPracticeByStudentSubject).toHaveBeenCalledWith(1, 1, 10);

    const deps2 = mk({
      progressRepo: { findByStudentAndSubject: vi.fn().mockResolvedValue(null) },
      mainErrorRepo: {
        create: vi.fn(),
        findUnclearedByStudentQuestion: vi.fn(),
        clearUnclearedByStudentQuestion: vi.fn(),
        updateDialogueId: vi.fn(),
        findUnclearedPracticeByStudentSubject: vi.fn().mockResolvedValue([]),
      },
    });
    await mkSvc(deps2).getUnclearedErrorDetails(1, 1);
    expect(deps2.mainErrorRepo.findUnclearedPracticeByStudentSubject).toHaveBeenCalledWith(1, 1, null);
  });

  it('传 currentLessonId 时只返回当前课之前的错题（本课/后续课排除，孤儿行保留）；不传不过滤', async () => {
    const rows = [
      { id: 1, source_ref_id: 10, question_id: null, question_n: '1', questionText: '前一课错题', lesson_id: 180 },
      { id: 2, source_ref_id: 11, question_id: null, question_n: '2', questionText: '本课错题', lesson_id: 181 },
      { id: 3, source_ref_id: 12, question_id: null, question_n: '3', questionText: '后续课错题', lesson_id: 182 },
      { id: 4, source_ref_id: null, question_id: null, question_n: null, questionText: '孤儿历史行', lesson_id: null },
    ];
    const deps = mk({
      mainErrorRepo: {
        create: vi.fn(),
        findUnclearedByStudentQuestion: vi.fn(),
        clearUnclearedByStudentQuestion: vi.fn(),
        updateDialogueId: vi.fn(),
        findUnclearedPracticeByStudentSubject: vi.fn().mockResolvedValue(rows),
      },
    });
    const svc = mkSvc(deps);

    // 当前课 = 181：只保留 180（严格之前）与 null（孤儿历史行）
    const r = await svc.getUnclearedErrorDetails(1, 1, 181);
    expect(r.errors.map(e => e.errorBookId)).toEqual([1, 4]);

    // 不传 currentLessonId：原行为，全部返回
    const r2 = await svc.getUnclearedErrorDetails(1, 1);
    expect(r2.errors.map(e => e.errorBookId)).toEqual([1, 2, 3, 4]);
  });
});

describe('PracticeService.getResults', () => {
  it('返回 PracticeResultDto[]，is_correct TINYINT -> boolean', async () => {
    const deps = mk({
      practiceResultsRepo: {
        upsert: vi.fn(),
        findByStudentCard: vi.fn().mockResolvedValue([
          { question_n: '0-1', question_text: '题1', student_answer: 'A', is_correct: 1, method: 'exact', analysis: null, error_type: null },
          { question_n: '0-2', question_text: '题2', student_answer: 'B', is_correct: 0, method: 'ai', analysis: '错因', error_type: 'calculation' },
        ]),
        deleteByStudentCard: vi.fn(), deleteByStudentLesson: vi.fn(),
      },
    });
    const svc = mkSvc(deps);
    const out = await svc.getResults(1, 5);
    expect(out).toEqual([
      { questionN: '0-1', questionText: '题1', studentAnswer: 'A', isCorrect: true, method: 'exact', analysis: null, errorType: null },
      { questionN: '0-2', questionText: '题2', studentAnswer: 'B', isCorrect: false, method: 'ai', analysis: '错因', errorType: 'calculation' },
    ]);
  });
});

describe('PracticeService.resetCard / resetLesson', () => {
  it('resetCard -> deleteByStudentCard', async () => {
    const deps = mk({
      practiceResultsRepo: { upsert: vi.fn(), findByStudentCard: vi.fn(), deleteByStudentCard: vi.fn().mockResolvedValue(undefined), deleteByStudentLesson: vi.fn() },
    });
    const svc = mkSvc(deps);
    await svc.resetCard(1, 5);
    expect(deps.practiceResultsRepo.deleteByStudentCard).toHaveBeenCalledWith(1, 5);
  });

  it('resetLesson -> deleteByStudentLesson', async () => {
    const deps = mk({
      practiceResultsRepo: { upsert: vi.fn(), findByStudentCard: vi.fn(), deleteByStudentCard: vi.fn(), deleteByStudentLesson: vi.fn().mockResolvedValue(undefined) },
    });
    const svc = mkSvc(deps);
    await svc.resetLesson(1, 9);
    expect(deps.practiceResultsRepo.deleteByStudentLesson).toHaveBeenCalledWith(1, 9);
  });
});

describe('PracticeService.isLessonPracticeComplete', () => {
  it('课程无练习卡 -> 直接通过', async () => {
    const deps = mk({
      contentService: {
        getLessonCards: vi.fn().mockResolvedValue({
          cards: [
            { id: 1, sortOrder: 0, cardType: 'concept', content: '知识', metadata: null },
            { id: 2, sortOrder: 1, cardType: 'summary', content: '小结', metadata: null },
          ],
        }),
      },
    });
    const svc = mkSvc(deps);
    await expect(svc.isLessonPracticeComplete(1, 9)).resolves.toBe(true);
    expect(deps.practiceResultsRepo.findByStudentLesson).not.toHaveBeenCalled();
  });

  it('结构化练习卡题目全部作答 -> 通过', async () => {
    const deps = mk({
      contentService: {
        getLessonCards: vi.fn().mockResolvedValue({
          cards: [
            { id: 5, sortOrder: 0, cardType: 'practice', content: '练习', metadata: { groups: [{ questions: [{ n: 1 }, { n: 2 }] }] } },
          ],
        }),
      },
      practiceResultsRepo: {
        findByStudentLesson: vi.fn().mockResolvedValue([
          { card_id: 5, question_n: '0-1' },
          { card_id: 5, question_n: '0-2' },
        ]),
      },
    });
    const svc = mkSvc(deps);
    await expect(svc.isLessonPracticeComplete(1, 9)).resolves.toBe(true);
  });

  it('多 group 复合键（"gi-n"）解析正确且全部作答 -> 通过', async () => {
    const deps = mk({
      contentService: {
        getLessonCards: vi.fn().mockResolvedValue({
          cards: [
            { id: 5, sortOrder: 0, cardType: 'practice', content: '', metadata: { groups: [{ questions: [{ n: 1 }, { n: 2 }] }, { questions: [{ n: 3 }] }] } },
          ],
        }),
      },
      practiceResultsRepo: {
        findByStudentLesson: vi.fn().mockResolvedValue([
          { card_id: 5, question_n: '0-1' },
          { card_id: 5, question_n: '0-2' },
          { card_id: 5, question_n: '1-3' },
        ]),
      },
    });
    const svc = mkSvc(deps);
    await expect(svc.isLessonPracticeComplete(1, 9)).resolves.toBe(true);
  });

  it('存在未作答题目 -> 拦截', async () => {
    const deps = mk({
      contentService: {
        getLessonCards: vi.fn().mockResolvedValue({
          cards: [
            { id: 5, sortOrder: 0, cardType: 'practice', content: '', metadata: { groups: [{ questions: [{ n: 1 }, { n: 2 }] }] } },
          ],
        }),
      },
      practiceResultsRepo: {
        findByStudentLesson: vi.fn().mockResolvedValue([
          { card_id: 5, question_n: '0-1' },
        ]),
      },
    });
    const svc = mkSvc(deps);
    await expect(svc.isLessonPracticeComplete(1, 9)).resolves.toBe(false);
  });

  it('两张练习卡其中一张未作答 -> 拦截', async () => {
    const deps = mk({
      contentService: {
        getLessonCards: vi.fn().mockResolvedValue({
          cards: [
            { id: 5, sortOrder: 0, cardType: 'practice', content: '', metadata: { groups: [{ questions: [{ n: 1 }] }] } },
            { id: 6, sortOrder: 1, cardType: 'practice', content: '', metadata: { groups: [{ questions: [{ n: 1 }] }] } },
          ],
        }),
      },
      practiceResultsRepo: {
        findByStudentLesson: vi.fn().mockResolvedValue([
          { card_id: 5, question_n: '0-1' },
        ]),
      },
    });
    const svc = mkSvc(deps);
    await expect(svc.isLessonPracticeComplete(1, 9)).resolves.toBe(false);
  });

  it('needs_fallback 卡按题号正则提取（0-n），全部作答 -> 通过', async () => {
    const deps = mk({
      contentService: {
        getLessonCards: vi.fn().mockResolvedValue({
          cards: [
            { id: 7, sortOrder: 0, cardType: 'practice', content: '题组\n\n(1) 第一题\n\n(2) 第二题', metadata: { needs_fallback: true } },
          ],
        }),
      },
      practiceResultsRepo: {
        findByStudentLesson: vi.fn().mockResolvedValue([
          { card_id: 7, question_n: '0-1' },
          { card_id: 7, question_n: '0-2' },
        ]),
      },
    });
    const svc = mkSvc(deps);
    await expect(svc.isLessonPracticeComplete(1, 9)).resolves.toBe(true);
  });

  it('解析不到题号的练习卡（无可作答项）-> 跳过不拦截', async () => {
    const deps = mk({
      contentService: {
        getLessonCards: vi.fn().mockResolvedValue({
          cards: [
            { id: 8, sortOrder: 0, cardType: 'practice', content: '纯文本，没有题号', metadata: { needs_fallback: true } },
          ],
        }),
      },
      practiceResultsRepo: { findByStudentLesson: vi.fn().mockResolvedValue([]) },
    });
    const svc = mkSvc(deps);
    await expect(svc.isLessonPracticeComplete(1, 9)).resolves.toBe(true);
  });
});
