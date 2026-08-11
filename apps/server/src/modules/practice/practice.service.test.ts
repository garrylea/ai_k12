import { describe, it, expect, vi } from 'vitest';
import { PracticeService } from './practice.service';
import { HttpException } from '@nestjs/common';

const mk = (overrides: any = {}) => ({
  questionsRepo: {
    findByContentHash: vi.fn().mockResolvedValue(null),
    findOrCreate: vi.fn(),
    deleteById: vi.fn().mockResolvedValue(undefined),
  },
  mainErrorRepo: { create: vi.fn().mockResolvedValue(42), findUnclearedByStudentQuestion: vi.fn().mockResolvedValue(null), clearUnclearedByStudentQuestion: vi.fn().mockResolvedValue(undefined), updateDialogueId: vi.fn().mockResolvedValue(undefined), countUnclearedByLesson: vi.fn().mockResolvedValue(0) },
  structuring: { structure: vi.fn() },
  judgment: { judge: vi.fn() },
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
  lessonsRepo: { findPreviousLessonId: vi.fn().mockResolvedValue(null), findByUnitId: vi.fn(), findById: vi.fn() },
  practiceResultsRepo: {
    upsert: vi.fn().mockResolvedValue(undefined),
    findByStudentCard: vi.fn().mockResolvedValue([]),
    deleteByStudentCard: vi.fn().mockResolvedValue(undefined),
    deleteByStudentLesson: vi.fn().mockResolvedValue(undefined),
  },
  ...overrides,
});

/** 用 mk() 构造的依赖实例化 PracticeService。 */
const mkSvc = (deps: ReturnType<typeof mk>) =>
  new PracticeService(deps.questionsRepo, deps.mainErrorRepo, deps.structuring, deps.judgment as any, deps.cardsRepo, deps.hint as any, deps.conversationsService as any, deps.lessonsRepo as any, deps.practiceResultsRepo as any);

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
    expect(r.analysis).toBe('错因');
    expect(r.errorBookId).toBe(42);
    expect(deps.structuring.structure).toHaveBeenCalled();
    expect(deps.questionsRepo.findOrCreate).toHaveBeenCalled();
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
      is_correct: false, question_n: '0-1', analysis: expect.any(String),
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
    expect(deps.conversationsService.create).toHaveBeenCalledWith(1, { track: 'mainline', cardId: 5 });
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
    expect(deps.conversationsService.create).toHaveBeenCalledWith(1, { track: 'mainline', cardId: 5 });
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

describe('PracticeService.countUnclearedErrorsFromPreviousLesson', () => {
  it('当前课是教材第一课 -> 无上一课，count 为 0', async () => {
    const deps = mk({ lessonsRepo: { findPreviousLessonId: vi.fn().mockResolvedValue(null) } });
    const svc = mkSvc(deps);
    const r = await svc.countUnclearedErrorsFromPreviousLesson(1, 100);
    expect(r).toEqual({ lessonId: null, count: 0 });
    expect(deps.mainErrorRepo.countUnclearedByLesson).not.toHaveBeenCalled();
  });

  it('上一课存在且无未清零错题 -> count 为 0', async () => {
    const deps = mk({
      lessonsRepo: { findPreviousLessonId: vi.fn().mockResolvedValue(99) },
      mainErrorRepo: { countUnclearedByLesson: vi.fn().mockResolvedValue(0) },
    });
    const svc = mkSvc(deps);
    const r = await svc.countUnclearedErrorsFromPreviousLesson(1, 100);
    expect(r).toEqual({ lessonId: 99, count: 0 });
    expect(deps.mainErrorRepo.countUnclearedByLesson).toHaveBeenCalledWith(1, 99);
  });

  it('上一课存在且有未清零错题 -> 返回数量', async () => {
    const deps = mk({
      lessonsRepo: { findPreviousLessonId: vi.fn().mockResolvedValue(99) },
      mainErrorRepo: { countUnclearedByLesson: vi.fn().mockResolvedValue(3) },
    });
    const svc = mkSvc(deps);
    const r = await svc.countUnclearedErrorsFromPreviousLesson(1, 100);
    expect(r).toEqual({ lessonId: 99, count: 3 });
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
