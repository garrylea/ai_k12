import { describe, it, expect, vi } from 'vitest';
import { PracticeService } from './practice.service';

const mk = (overrides: any = {}) => ({
  questionsRepo: { findByContentHash: vi.fn().mockResolvedValue(null), findOrCreate: vi.fn() },
  mainErrorRepo: { create: vi.fn().mockResolvedValue(42) },
  structuring: { structure: vi.fn() },
  judgment: { judge: vi.fn() },
  ...overrides,
});

describe('PracticeService.judge', () => {
  it('客观题命中 -> exact 比对，答错入错题本（不插题）', async () => {
    const deps = mk({
      questionsRepo: { findByContentHash: vi.fn().mockResolvedValue({ id: 10, type: 'choice', answer: 'A', options: '[{"label":"A","isCorrect":true}]' }) },
    });
    const svc = new PracticeService(deps.questionsRepo, deps.mainErrorRepo, deps.structuring, deps.judgment as any);
    const r = await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionText: '题', studentAnswer: 'B' });
    expect(r.isCorrect).toBe(false);
    expect(r.method).toBe('exact');
    expect(r.errorBookId).toBe(42);
    expect(deps.judgment.judge).not.toHaveBeenCalled();
    expect(deps.structuring.structure).not.toHaveBeenCalled();
  });
  it('未命中 -> AI 判定，答错 -> 结构化 + 插题 + 入错题本', async () => {
    const deps = mk({
      judgment: { judge: vi.fn().mockResolvedValue({ isCorrect: false, analysis: '错因', errorType: 'calculation' }) },
      structuring: { structure: vi.fn().mockResolvedValue({ quality: 'good', content: '题', type: 'short_answer', difficulty: 2, answer: 'a', explanation: 'e', knowledgePoints: [] }) },
      questionsRepo: { findByContentHash: vi.fn().mockResolvedValue(null), findOrCreate: vi.fn().mockResolvedValue({ id: 77, created: true }) },
    });
    const svc = new PracticeService(deps.questionsRepo, deps.mainErrorRepo, deps.structuring, deps.judgment as any);
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
    const svc = new PracticeService(deps.questionsRepo, deps.mainErrorRepo, deps.structuring, deps.judgment as any);
    const r = await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionText: '题', studentAnswer: '答' });
    expect(r.isCorrect).toBe(true);
    expect(r.errorBookId).toBeUndefined();
    expect(deps.structuring.structure).not.toHaveBeenCalled();
  });
});
