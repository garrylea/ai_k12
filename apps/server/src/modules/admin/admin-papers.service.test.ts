import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { AdminPapersService } from './admin-papers.service.js';
import type { AdminPapersRepository, AdminPaperListRow } from '../../database/repositories/admin-papers.repo.js';

function row(over: Partial<AdminPaperListRow> = {}): AdminPaperListRow {
  return {
    id: 446,
    subject_id: 9,
    subject_name: '道德与法治',
    title: '汇文卷',
    grade: '初三',
    grade_band: 'junior',
    semester: 'first',
    year: 2026,
    district: '',
    exam_type: '期中',
    source_key: 'k',
    created_at: new Date('2026-11-07T01:15:00.029Z'),
    linked_question_count: 14,
    session_count: 1,
    ...over,
  } as AdminPaperListRow;
}

function mkRepo(over: Record<string, any> = {}) {
  return {
    findPapers: vi.fn().mockResolvedValue({ items: [row()], total: 1 }),
    findPaper: vi.fn().mockResolvedValue({ id: 446, title: '汇文卷', subjectName: '道德与法治' }),
    countImpact: vi.fn().mockResolvedValue({
      questionCount: 14, sharedCount: 0, exclusiveCount: 14,
      deletableCount: 14, retainedCount: 0, sessionCount: 1, answerCount: 5,
    }),
    deletePaperCascade: vi.fn().mockResolvedValue({
      paperTitle: '汇文卷', deletedQuestions: 14, retainedQuestions: 0,
      deletedSessions: 1, deletedAnswers: 5,
    }),
    ...over,
  };
}

function mkSvc(repo = mkRepo()) {
  return { svc: new AdminPapersService(repo as unknown as AdminPapersRepository), repo };
}

describe('AdminPapersService.list', () => {
  it('行 → DTO；题数用 linked_question_count，createdAt 转 ISO', async () => {
    const { svc } = mkSvc();
    const out = await svc.list({ page: 1, pageSize: 20 });

    expect(out.items[0]).toEqual({
      id: 446, subjectId: 9, subjectName: '道德与法治', title: '汇文卷',
      grade: '初三', gradeBand: 'junior', semester: 'first', year: 2026,
      district: '', examType: '期中', sourceKey: 'k',
      questionCount: 14, sessionCount: 1,
      createdAt: '2026-11-07T01:15:00.029Z',
    });
    expect(out.total).toBe(1);
    expect(out.page).toBe(1);
  });
});

describe('AdminPapersService.preview', () => {
  it('合并试卷元信息与影响面', async () => {
    const { svc } = mkSvc();
    const out = await svc.preview(446);
    expect(out).toMatchObject({ paperId: 446, title: '汇文卷', subjectName: '道德与法治', deletableCount: 14 });
  });

  it('卷不存在 → 404（全局过滤器落 code 1002）', async () => {
    const { svc } = mkSvc(mkRepo({ findPaper: vi.fn().mockResolvedValue(null) }));
    await expect(svc.preview(999)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('id 非正数 → 400', async () => {
    const { svc } = mkSvc();
    await expect(svc.preview(0)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.remove(-1)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('AdminPapersService.remove', () => {
  it('成功：返回四个计数，不透出 paperTitle', async () => {
    const { svc } = mkSvc();
    const out = await svc.remove(446);
    expect(out).toEqual({
      paperId: 446, deletedQuestions: 14, retainedQuestions: 0,
      deletedSessions: 1, deletedAnswers: 5,
    });
    expect('paperTitle' in out).toBe(false);
  });

  it('卷不存在 → 404', async () => {
    const { svc } = mkSvc(mkRepo({ deletePaperCascade: vi.fn().mockResolvedValue(null) }));
    await expect(svc.remove(999)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('外键冲突 → 409 / 4201', async () => {
    const { svc } = mkSvc(mkRepo({
      deletePaperCascade: vi.fn().mockRejectedValue(Object.assign(new Error('fk'), { code: 'ER_ROW_IS_REFERENCED_2' })),
    }));

    const err = await svc.remove(446).catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({ code: 4201 });
  });

  it('其它数据库异常原样抛（不吞成 409）', async () => {
    const boom = new Error('db down');
    const { svc } = mkSvc(mkRepo({ deletePaperCascade: vi.fn().mockRejectedValue(boom) }));
    await expect(svc.remove(446)).rejects.toBe(boom);
  });
});
