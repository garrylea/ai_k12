import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { ResearchPapersService } from './research-papers.service.js';
import type { ResearchPapersRepository, AdminPaperListRow } from '../../database/repositories/research-papers.repo.js';

const ACTOR = { sub: 7, role: 'researcher', name: '教研员' } as any;

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
    findPaperDetail: vi.fn().mockResolvedValue({ paper: { id: 446, title: '汇文卷' }, questions: [] }),
    countImpact: vi.fn().mockResolvedValue({
      questionCount: 14, sharedCount: 0, exclusiveCount: 14,
      deletableCount: 14, retainedCount: 0, sessionCount: 1, answerCount: 5,
    }),
    deletePaperCascade: vi.fn().mockResolvedValue({
      paperTitle: '汇文卷', deletedQuestions: 14, retainedQuestions: 0,
      deletedSessions: 1, deletedAnswers: 5,
    }),
    findResearchImageUrlsByPaper: vi.fn().mockResolvedValue([]),
    ...over,
  };
}

function mkImages(over: Record<string, any> = {}) {
  return {
    cleanupUnreferenced: vi.fn().mockResolvedValue({ deleted: 0, skipped: 0 }),
    ...over,
  };
}

function mkSvc(repo = mkRepo(), images = mkImages()) {
  return {
    svc: new ResearchPapersService(
      repo as unknown as ResearchPapersRepository,
      images as any,
    ),
    repo,
    images,
  };
}

describe('ResearchPapersService.list', () => {
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

  // brief Step 2：无筛选时不能硬塞 subjectId 进 WHERE。
  it('list 无筛选时不过滤学科', async () => {
    const repo = mkRepo();
    repo.findPapers.mockResolvedValue({ items: [], total: 0 });
    const svc = mkSvc(repo).svc;
    await svc.list({ page: 1, pageSize: 20 });
    expect(repo.findPapers).toHaveBeenCalledWith({ page: 1, pageSize: 20 });
  });
});

describe('ResearchPapersService.preview', () => {
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
    await expect(svc.remove(-1, ACTOR)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ResearchPapersService.remove', () => {
  it('成功：返回四个计数 + deletedImages，不透出 paperTitle', async () => {
    const { svc } = mkSvc();
    const out = await svc.remove(446, ACTOR);
    expect(out).toEqual({
      paperId: 446, deletedQuestions: 14, retainedQuestions: 0,
      deletedSessions: 1, deletedAnswers: 5, deletedImages: 0,
    });
    expect('paperTitle' in out).toBe(false);
  });

  // 审计写入下沉到仓储的删卷事务；service 只负责把操作者身份传下去。
  it('DELETE 把操作者交给仓储，由其事务内写 paper.delete 审计', async () => {
    const repo = mkRepo();
    repo.deletePaperCascade.mockResolvedValue({
      paperTitle: '卷A', deletedQuestions: 2, retainedQuestions: 0,
      deletedSessions: 1, deletedAnswers: 3,
    });
    const { svc, repo: r } = mkSvc(repo);
    const out = await svc.remove(42, ACTOR);
    expect(r.deletePaperCascade).toHaveBeenCalledWith(42, ACTOR);
    expect(out).toEqual({
      paperId: 42, deletedQuestions: 2, retainedQuestions: 0,
      deletedSessions: 1, deletedAnswers: 3, deletedImages: 0,
    });
  });

  // Task 7：删卷前收集真正被物理删的独占题里的 research 图，commit 成功后清理。
  it('删卷前收图 URL，删卷成功后 cleanupUnreferenced(urls, actor) 并回传 deletedImages', async () => {
    const urls = ['/uploads/research/a.png', '/uploads/research/b.png'];
    const repo = mkRepo({ findResearchImageUrlsByPaper: vi.fn().mockResolvedValue(urls) });
    const images = mkImages({ cleanupUnreferenced: vi.fn().mockResolvedValue({ deleted: 2, skipped: 0 }) });
    const { svc } = mkSvc(repo, images);

    const out = await svc.remove(446, ACTOR);

    expect(repo.findResearchImageUrlsByPaper).toHaveBeenCalledWith(446);
    expect(repo.findResearchImageUrlsByPaper.mock.invocationCallOrder[0])
      .toBeLessThan(repo.deletePaperCascade.mock.invocationCallOrder[0]);
    expect(images.cleanupUnreferenced).toHaveBeenCalledWith(urls, ACTOR);
    expect(out.deletedImages).toBe(2);
  });

  it('无可清理图时以空数组调用 cleanup（无副作用，deletedImages=0）', async () => {
    const { svc, images } = mkSvc();
    const out = await svc.remove(446, ACTOR);
    expect(images.cleanupUnreferenced).toHaveBeenCalledWith([], ACTOR);
    expect(out.deletedImages).toBe(0);
  });

  it('commit 后 cleanup 抛错也吞掉：删卷结果照常返回，deletedImages=0', async () => {
    const images = mkImages({
      cleanupUnreferenced: vi.fn().mockRejectedValue(new Error('db down')),
    });
    const { svc } = mkSvc(mkRepo(), images);

    const out = await svc.remove(446, ACTOR);

    expect(out).toMatchObject({ paperId: 446, deletedQuestions: 14, deletedImages: 0 });
  });

  it('操作者身份（sub/role/name）原样传给仓储审计写入', async () => {
    const { svc, repo } = mkSvc();
    await svc.remove(446, ACTOR);
    expect(repo.deletePaperCascade.mock.calls[0][1]).toBe(ACTOR);
  });

  it('卷不存在 → 404', async () => {
    const { svc } = mkSvc(mkRepo({ deletePaperCascade: vi.fn().mockResolvedValue(null) }));
    await expect(svc.remove(999, ACTOR)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('外键冲突 → 409 / 4201', async () => {
    const { svc } = mkSvc(mkRepo({
      deletePaperCascade: vi.fn().mockRejectedValue(Object.assign(new Error('fk'), { code: 'ER_ROW_IS_REFERENCED_2' })),
    }));

    const err = await svc.remove(446, ACTOR).catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({ code: 4201 });
  });

  it('其它数据库异常原样抛（不吞成 409）', async () => {
    const boom = new Error('db down');
    const { svc } = mkSvc(mkRepo({ deletePaperCascade: vi.fn().mockRejectedValue(boom) }));
    await expect(svc.remove(446, ACTOR)).rejects.toBe(boom);
  });
});

describe('ResearchPapersService.detail', () => {
  function detailQuestion(over: Record<string, unknown> = {}) {
    return {
      id: 9,
      question_no: 1,
      type: 'choice',
      difficulty: 'medium',
      full_score: 5,
      content: '题干',
      options: '[{"label":"A","text":"甲","isCorrect":true}]',
      answer: 'B',
      explanation: '解析',
      approach: '思路',
      source: '汇文',
      source_year: 2026,
      answer_verified: 1,
      is_active: 1,
      ...over,
    };
  }

  it('detail 返回题目五字段原值且不剥离 answer/explanation/approach', async () => {
    const repo = mkRepo({
      findPaperDetail: vi.fn().mockResolvedValue({
        paper: { id: 1, title: '卷A' },
        questions: [detailQuestion()],
      }),
    });
    const { svc } = mkSvc(repo);

    const res = await svc.detail(1);

    expect(repo.findPaperDetail).toHaveBeenCalledWith(1);
    expect(res.questions[0].content).toBe('题干');
    expect(res.questions[0].answer).toBe('B');
    expect(res.questions[0].explanation).toBe('解析');
    expect(res.questions[0].approach).toBe('思路');
  });

  it('字段名映射 camelCase：questionNo/sourceYear/answerVerified/isActive，且不泄漏原始行', async () => {
    const repo = mkRepo({
      findPaperDetail: vi.fn().mockResolvedValue({
        paper: {
          id: 1, subject_id: 9, subject_name: '道德与法治', title: '卷A',
          created_at: new Date('2026-11-07T01:15:00.029Z'),
        },
        questions: [detailQuestion()],
      }),
    });
    const { svc } = mkSvc(repo);

    const res = await svc.detail(1);

    expect(res.paper).toEqual({
      id: 1, subjectId: 9, subjectName: '道德与法治', title: '卷A',
      createdAt: '2026-11-07T01:15:00.029Z',
    });
    expect(res.questions[0]).toEqual({
      id: 9,
      questionNo: 1,
      type: 'choice',
      content: '题干',
      options: [{ label: 'A', text: '甲' }],
      answer: 'B',
      explanation: '解析',
      approach: '思路',
      source: '汇文',
      sourceYear: 2026,
      answerVerified: true,
      isActive: true,
    });
    // questions 表无 textbook_page 列，DTO 不得透出该字段。
    expect('textbookPage' in res.questions[0]).toBe(false);
  });

  it('options 用 parseOptions 解析并剥 isCorrect；坏 JSON → null', async () => {
    const repo = mkRepo({
      findPaperDetail: vi.fn().mockResolvedValue({
        paper: { id: 1, title: '卷A' },
        questions: [detailQuestion({ id: 10, options: '{bad' })],
      }),
    });
    const { svc } = mkSvc(repo);

    const res = await svc.detail(1);

    expect(res.questions[0].options).toBeNull();
  });

  it('试卷不存在时 404', async () => {
    const repo = mkRepo({ findPaperDetail: vi.fn().mockResolvedValue(null) });
    const { svc } = mkSvc(repo);

    await expect(svc.detail(999)).rejects.toMatchObject({ status: 404 });
  });

  it('id 非正数 → 400', async () => {
    const { svc } = mkSvc();
    await expect(svc.detail(0)).rejects.toBeInstanceOf(BadRequestException);
  });
});
