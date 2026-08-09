import { describe, it, expect, vi } from 'vitest';
import { PracticeService } from './practice.service';
import { HttpException } from '@nestjs/common';

const mk = (overrides: any = {}) => ({
  questionsRepo: {
    findByContentHash: vi.fn().mockResolvedValue(null),
    findOrCreate: vi.fn(),
    deleteById: vi.fn().mockResolvedValue(undefined),
  },
  mainErrorRepo: { create: vi.fn().mockResolvedValue(42) },
  structuring: { structure: vi.fn() },
  judgment: { judge: vi.fn() },
  cardsRepo: {
    findHintsById: vi.fn().mockResolvedValue(null),
    upsertHint: vi.fn().mockResolvedValue(undefined),
  },
  hint: { generate: vi.fn() },
  ...overrides,
});

/** 用 mk() 构造的依赖实例化 PracticeService（6 个构造参数）。 */
const mkSvc = (deps: ReturnType<typeof mk>) =>
  new PracticeService(deps.questionsRepo, deps.mainErrorRepo, deps.structuring, deps.judgment as any, deps.cardsRepo, deps.hint as any);

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
    const r = await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionText: '题', studentAnswer: 'B' });
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
    const r = await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionText: '选择题', studentAnswer: 'A' });
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
    const r = await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionText: '选择题', studentAnswer: 'A' });
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
    const r = await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionText: '计算题', studentAnswer: '2/3' });
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
    const r = await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionText: '计算题', studentAnswer: '2/3' });
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
    const r = await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionText: '题', studentAnswer: '答' });
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
    const r = await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionText: '题', studentAnswer: '答' });
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
    const r = await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionText: '证明题', studentAnswer: '学生证明' });
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
    const r = await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionText: '难题', studentAnswer: '错答' });
    expect(r.isCorrect).toBe(false);
    expect(r.errorBookId).toBe(42);
    expect(deps.mainErrorRepo.create).toHaveBeenCalledWith(expect.objectContaining({
      question_id: null,
      wrong_answer_text: '难题',
    }));
  });

  it('AI 判定失败 -> 抛 503 HttpException，不进错题本', async () => {
    const deps = mk({
      judgment: { judge: vi.fn().mockRejectedValue(new Error('LLM timeout')) },
    });
    const svc = mkSvc(deps);
    await expect(
      svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionText: '题', studentAnswer: '答' }),
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
      mainErrorRepo: { create: vi.fn().mockRejectedValue(new Error('DB down')) },
    });
    const svc = mkSvc(deps);
    await expect(
      svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionText: '题', studentAnswer: '错答' }),
    ).rejects.toThrow('DB down');
    expect(deps.questionsRepo.deleteById).toHaveBeenCalledWith(88);
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
