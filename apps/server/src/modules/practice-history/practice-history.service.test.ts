import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { PracticeHistoryService } from './practice-history.service.js';

const mkExamSession = (over: any = {}) => ({
  id: 1, student_id: 7, paper_id: 10, subject_id: 4, status: 'submitted',
  duration_minutes: 60, started_at: new Date('2026-11-01T06:00:00Z'),
  deadline_at: new Date('2026-11-01T07:00:00Z'), submitted_at: new Date('2026-11-01T06:40:00Z'),
  created_at: new Date(), updated_at: new Date(), title: '北师大物理实验卷',
  ...over,
});

const mkSpecialSession = (over: any = {}) => ({
  id: 5, session_uid: 'uid-5', student_id: 7, subject_id: 2, module: 'chinese_dictation',
  title: '默写专项·静夜思', question_count: 1, started_at: new Date('2026-10-31T11:30:00Z'),
  completed_at: new Date('2026-10-31T11:35:00Z'),
  ...over,
});

function make() {
  const examSessionsRepo = {
    listSubmittedByStudent: vi.fn().mockResolvedValue([]),
    countSubmittedByStudent: vi.fn().mockResolvedValue(0),
    countAnswersBySession: vi.fn().mockResolvedValue({ total: 0, correct: 0 }),
    findAnswersWithQuestions: vi.fn().mockResolvedValue([]),
    findByIdOwned: vi.fn().mockResolvedValue(null),
  };
  const specialSessionsRepo = {
    listByStudent: vi.fn().mockResolvedValue([]),
    countByStudent: vi.fn().mockResolvedValue(0),
    findByIdOwned: vi.fn().mockResolvedValue(null),
  };
  const specialAnswersRepo = {
    listBySession: vi.fn().mockResolvedValue([]),
    countBySession: vi.fn().mockResolvedValue({ total: 0, correct: 0 }),
  };
  const passagesRepo = { findById: vi.fn().mockResolvedValue(null) };
  const service = new PracticeHistoryService(
    examSessionsRepo as never, specialSessionsRepo as never,
    specialAnswersRepo as never, passagesRepo as never,
  );
  return { service, examSessionsRepo, specialSessionsRepo, specialAnswersRepo, passagesRepo };
}

describe('PracticeHistoryService.list', () => {
  let h: ReturnType<typeof make>;
  beforeEach(() => { h = make(); });

  it('考试 + 专项合并按开始时间倒序', async () => {
    h.examSessionsRepo.listSubmittedByStudent.mockResolvedValue([mkExamSession()]);
    h.specialSessionsRepo.listByStudent.mockResolvedValue([mkSpecialSession()]);
    h.examSessionsRepo.countAnswersBySession.mockResolvedValue({ total: 10, correct: 7 });
    h.specialAnswersRepo.countBySession.mockResolvedValue({ total: 1, correct: 0 });
    h.examSessionsRepo.countSubmittedByStudent.mockResolvedValue(1);
    h.specialSessionsRepo.countByStudent.mockResolvedValue(1);

    const r = await h.service.list({ studentId: 7 });

    expect(r.items).toHaveLength(2);
    expect(r.items[0].title).toBe('北师大物理实验卷'); // 11-01 在前
    expect(r.items[0].source).toBe('exam');
    expect(r.items[0].correctCount).toBe(7);
    expect(r.items[1].title).toBe('默写专项·静夜思'); // 10-31 在后
    expect(r.items[1].source).toBe('special');
    expect(r.total).toBe(2);
    expect(r.page).toBe(1);
    expect(r.pageSize).toBe(20);
  });

  it('带 subjectId 时两端都筛选', async () => {
    await h.service.list({ studentId: 7, subjectId: 4 });
    expect(h.examSessionsRepo.listSubmittedByStudent).toHaveBeenCalledWith(
      expect.objectContaining({ subjectId: 4 }),
    );
    expect(h.specialSessionsRepo.listByStudent).toHaveBeenCalledWith(
      7, expect.objectContaining({ subjectId: 4 }),
    );
    expect(h.examSessionsRepo.countSubmittedByStudent).toHaveBeenCalledWith(7, 4);
    expect(h.specialSessionsRepo.countByStudent).toHaveBeenCalledWith(7, 4);
  });

  it('pageSize 上限 50、下限 1；page 最小 1', async () => {
    const r1 = await h.service.list({ studentId: 7, page: 0, pageSize: 999 });
    expect(r1.page).toBe(1);
    expect(r1.pageSize).toBe(50);
    const r2 = await h.service.list({ studentId: 7, page: 2, pageSize: 0 });
    expect(r2.pageSize).toBe(20); // 0 被 `|| 20` 兜底
  });

  it('第 2 页跨表切片正确（两端各取 offset+pageSize 再 slice）', async () => {
    // 构造 3 条考试（11-03, 11-01, 10-30）+ 3 条专项（11-02, 10-31, 10-29）
    h.examSessionsRepo.listSubmittedByStudent.mockResolvedValue([
      mkExamSession({ id: 1, started_at: new Date('2026-11-03T00:00:00Z') }),
      mkExamSession({ id: 2, started_at: new Date('2026-11-01T00:00:00Z') }),
      mkExamSession({ id: 3, started_at: new Date('2026-10-30T00:00:00Z') }),
    ]);
    h.specialSessionsRepo.listByStudent.mockResolvedValue([
      mkSpecialSession({ id: 5, started_at: new Date('2026-11-02T00:00:00Z') }),
      mkSpecialSession({ id: 6, started_at: new Date('2026-10-31T00:00:00Z') }),
      mkSpecialSession({ id: 7, started_at: new Date('2026-10-29T00:00:00Z') }),
    ]);
    h.examSessionsRepo.countSubmittedByStudent.mockResolvedValue(3);
    h.specialSessionsRepo.countByStudent.mockResolvedValue(3);

    const page2 = await h.service.list({ studentId: 7, page: 2, pageSize: 2 });
    // 全序：11-03(1), 11-02(5), 11-01(2), 10-31(6), 10-30(3), 10-29(7)
    // 第 2 页(pageSize=2) = 第 3-4 条 = 11-01(2), 10-31(6)
    expect(page2.items.map((i) => i.sessionId)).toEqual([2, 6]);
    // fetchLimit = offset+pageSize = 2+2 = 4
    expect(h.examSessionsRepo.listSubmittedByStudent).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 4, offset: 0 }),
    );
  });
});

describe('PracticeHistoryService.getDetail', () => {
  let h: ReturnType<typeof make>;
  beforeEach(() => { h = make(); });

  it('source 非法抛 BadRequestException', async () => {
    await expect(h.service.getDetail({ studentId: 7, source: 'xxx' as never, sessionId: 1 }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('sessionId 非正整数抛 BadRequestException', async () => {
    await expect(h.service.getDetail({ studentId: 7, source: 'exam', sessionId: 0 }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('非本人（repo 返回 null）→ null（controller 转 404）', async () => {
    h.examSessionsRepo.findByIdOwned.mockResolvedValue(null);
    expect(await h.service.getDetail({ studentId: 7, source: 'exam', sessionId: 999 })).toBeNull();
  });

  it('考试详情：逐题作答映射', async () => {
    h.examSessionsRepo.findByIdOwned.mockResolvedValue(mkExamSession());
    h.examSessionsRepo.countAnswersBySession.mockResolvedValue({ total: 2, correct: 1 });
    h.examSessionsRepo.findAnswersWithQuestions.mockResolvedValue([
      {
        question_id: 100, question_order: 1, answer_text: 'B', is_correct: 0, score: '0.00',
        analysis: null, method: 'exact', judged_at: new Date('2026-11-01T06:05:00Z'),
        text: '第1题题面', type: 'choice', options: '[]', explanation: '解析1', answer: 'C',
        material_text: '阅读下面的材料，完成第1-3题。',
      },
    ]);
    const r = await h.service.getDetail({ studentId: 7, source: 'exam', sessionId: 1 });
    expect(r!.session.source).toBe('exam');
    expect(r!.questions[0]).toMatchObject({
      questionId: 100, answerText: 'B', isCorrect: false, questionContent: '第1题题面',
      questionAnswer: 'C', method: 'exact', refType: 'question',
      // 材料随题返回（语文/英语阅读、物化题内材料）—— 2026-11-02
      materialText: '阅读下面的材料，完成第1-3题。',
    });
  });

  it('专项详情：语文 passage 回放篇名 + 句原文', async () => {
    h.specialSessionsRepo.findByIdOwned.mockResolvedValue(mkSpecialSession());
    h.specialAnswersRepo.countBySession.mockResolvedValue({ total: 1, correct: 0 });
    h.specialAnswersRepo.listBySession.mockResolvedValue([
      {
        id: 1, session_id: 5, question_id: null, ref_type: 'passage', ref_id: 42,
        sentence_index: 1, question_order: 1,
        answer_text: '{"author":"李白","dynasty":"唐","body":"床前明月光"}',
        is_correct: 0, score: '0.00', method: 'exact', analysis: null,
        judged_at: new Date('2026-10-31T11:35:00Z'),
        question_content: null, question_answer: null, question_analysis: null,
      },
    ]);
    h.passagesRepo.findById.mockResolvedValue({
      id: 42, work_title: '静夜思',
      sentences: [
        { text: '床前明月光，疑是地上霜。', translation: '' },
        { text: '举头望明月，低头思故乡。', translation: '' },
      ],
    });
    const r = await h.service.getDetail({ studentId: 7, source: 'special', sessionId: 5 });
    expect(r!.questions[0]).toMatchObject({
      refType: 'passage', refId: 42, sentenceIndex: 1,
      passageTitle: '静夜思', passageSentence: '举头望明月，低头思故乡。',
    });
    // 同篇只查一次
    expect(h.passagesRepo.findById).toHaveBeenCalledTimes(1);
  });
});
