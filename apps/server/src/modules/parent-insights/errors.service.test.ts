import { describe, it, expect, vi } from 'vitest';
import { ErrorsService } from './errors.service.js';

const row = (over: Record<string, any> = {}) => ({
  id: 91, questionId: 330, subjectId: 1, source: 'exam', level: 2, isCleared: false,
  wrongAnswerText: 'x=3', createdAt: new Date('2026-09-16T19:21:00Z'), clearedAt: null,
  questionContent: '解方程', questionType: 'calculation', questionDifficulty: 3,
  ...over,
});

const mkRepo = () => ({
  listParentErrors: vi.fn().mockResolvedValue({ items: [row()], total: 139 }),
  listErrorKnowledgePoints: vi.fn().mockResolvedValue([
    { questionId: 330, knowledgePointId: 42, knowledgePointName: '分数加减' },
  ]),
});

const mkSvc = (d = mkRepo()) => new ErrorsService(d as any);

describe('ErrorsService', () => {
  it('track 映射：auxiliary → training，exam → main；知识点按 questionId 聚成数组', async () => {
    const repo = mkRepo();
    repo.listParentErrors.mockResolvedValue({
      items: [row(), row({ id: 92, questionId: 331, source: 'auxiliary' })],
      total: 2,
    });
    // 330 绑两个 KP、331 未绑 —— 一次批量查询同时覆盖两种情况
    repo.listErrorKnowledgePoints.mockResolvedValue([
      { questionId: 330, knowledgePointId: 42, knowledgePointName: '分数加减' },
      { questionId: 330, knowledgePointId: 43, knowledgePointName: '整式' },
    ]);

    const result = await mkSvc(repo).listErrors(11, { page: 1 });

    expect(result.items[0]).toMatchObject({ track: 'main', source: 'exam' });
    // 孩子问过的题在家长端归「训练」——它进的是训练轨的错题练习池
    expect(result.items[1]).toMatchObject({ track: 'training', source: 'auxiliary' });
    expect(result.items[0].question).toEqual({
      content: '解方程', type: 'calculation', difficulty: 3,
      knowledgePoints: [
        { id: 42, name: '分数加减' },
        { id: 43, name: '整式' },
      ],
    });
    // 未绑 KP 的那道题是空数组，不是 null
    expect(result.items[1].question?.knowledgePoints).toEqual([]);
    // 只查一次，入参是本页**去重后**的 questionId
    expect(repo.listErrorKnowledgePoints).toHaveBeenCalledTimes(1);
    expect(repo.listErrorKnowledgePoints).toHaveBeenCalledWith([330, 331]);
  });

  it('pageSize 固定 20，offset 由 page 推', async () => {
    const repo = mkRepo();

    const result = await mkSvc(repo).listErrors(11, { page: 3 });

    expect(repo.listParentErrors).toHaveBeenCalledWith(11, {}, 20, 40);
    expect(result).toMatchObject({ page: 3, pageSize: 20, total: 139 });
  });

  it('cleared=all（或不传）→ 不传给仓储；uncleared/cleared 原样透传', async () => {
    const repo = mkRepo();

    await mkSvc(repo).listErrors(11, { page: 1, cleared: 'all' });
    expect(repo.listParentErrors).toHaveBeenCalledWith(11, {}, 20, 0);

    await mkSvc(repo).listErrors(11, { page: 1, cleared: 'uncleared' });
    expect(repo.listParentErrors).toHaveBeenLastCalledWith(11, { cleared: 'uncleared' }, 20, 0);
  });

  it('question_id 为 NULL → question 整体为 null；且不拿空列表去查知识点', async () => {
    const repo = mkRepo();
    repo.listParentErrors.mockResolvedValue({
      items: [row({ questionId: null, questionContent: null, questionType: null, questionDifficulty: null })],
      total: 1,
    });

    const result = await mkSvc(repo).listErrors(11, { page: 1 });

    expect(result.items[0].question).toBeNull();
    expect(result.items[0].wrongAnswerText).toBe('x=3');
    // 本页没有可查的 questionId → 跳过批量查询（仓储对空数组也会早返回，少一次调用更省）
    expect(repo.listErrorKnowledgePoints).not.toHaveBeenCalled();
  });

  it('本页没有错题 → 不查知识点（避免无谓查询）', async () => {
    const repo = mkRepo();
    repo.listParentErrors.mockResolvedValue({ items: [], total: 0 });

    await mkSvc(repo).listErrors(11, { page: 1 });

    expect(repo.listErrorKnowledgePoints).not.toHaveBeenCalled();
  });

  it('无数据 → items 空数组 + total 0（不是 404）', async () => {
    const repo = mkRepo();
    repo.listParentErrors.mockResolvedValue({ items: [], total: 0 });

    const result = await mkSvc(repo).listErrors(11, { page: 1 });

    expect(result).toEqual({ items: [], page: 1, pageSize: 20, total: 0 });
  });
});
