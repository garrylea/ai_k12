import { describe, it, expect, vi } from 'vitest';
import { ExamsService, computeRecommendedDuration } from './exams.service';

const mk = (overrides: any = {}) => ({
  examPapersRepo: {
    findPapers: vi.fn().mockResolvedValue([]),
    findById: vi.fn().mockResolvedValue(null),
    findQuestionsByPaperId: vi.fn().mockResolvedValue([]),
  },
  // Task 2（会话生命周期）依赖。
  examSessionsRepo: {
    create: vi.fn().mockResolvedValue(1),
    findById: vi.fn().mockResolvedValue(null),
    findInProgressByStudentPaper: vi.fn().mockResolvedValue(null),
    markSubmitted: vi.fn().mockResolvedValue(undefined),
    upsertAnswer: vi.fn().mockResolvedValue(undefined),
    findAnswersBySession: vi.fn().mockResolvedValue([]),
    findAnswersWithQuestions: vi.fn().mockResolvedValue([]),
  },
  judgeCore: { judgeQuestion: vi.fn() },
  mainErrorRepo: {
    create: vi.fn().mockResolvedValue(1),
    // I-2 find-or-create：缺省「无既有未清错题」走 create 分支
    findUnclearedByStudentQuestionId: vi.fn().mockResolvedValue(null),
  },
  ...overrides,
});
const mkSvc = (deps: ReturnType<typeof mk>) =>
  new ExamsService(deps.examPapersRepo, deps.examSessionsRepo, deps.judgeCore, deps.mainErrorRepo);

/** 会话测试公共 fixtures。 */
const paperRow = { id: 5, subject_id: 2, title: '2025 年期末卷', year: 2025, district: '海淀', exam_type: '期末', grade_band: 'junior', question_count: 3 };
const paperQuestions = [
  { questionId: 10, questionNo: 1, text: '选择题 1', type: 'choice', options: '["A. 1", "B. 2"]' },
  { questionId: 11, questionNo: 2, text: '填空题', type: 'fill_blank', options: null },
  { questionId: 12, questionNo: 3, text: '证明题', type: 'proof', options: null },
];
const sessionRow = (o: any = {}) => ({
  id: 77,
  student_id: 1,
  paper_id: 5,
  subject_id: 2,
  status: 'in_progress',
  duration_minutes: 30,
  started_at: new Date(Date.now() - 60000),
  deadline_at: new Date(Date.now() + 600000),
  submitted_at: null,
  created_at: new Date(Date.now() - 60000),
  updated_at: new Date(Date.now() - 60000),
  ...o,
});
/** papersRepo mock：试卷存在 + 题单 3 题。 */
const papersRepoWithPaper = () => ({
  findPapers: vi.fn().mockResolvedValue([]),
  findById: vi.fn().mockResolvedValue(paperRow),
  findQuestionsByPaperId: vi.fn().mockResolvedValue(paperQuestions),
});

describe('ExamsService.listPapers', () => {
  it('透传筛选参数给 repo', async () => {
    const deps = mk();
    await mkSvc(deps).listPapers({ subjectId: 1, year: 2025, district: '海淀', examType: '期末', gradeBand: 'junior' });
    expect(deps.examPapersRepo.findPapers).toHaveBeenCalledWith({
      subjectId: 1, year: 2025, district: '海淀', examType: '期末', gradeBand: 'junior',
    });
  });

  it('映射行 -> ExamPaperDto（questionCount 取 repo 计数）', async () => {
    const deps = mk({
      examPapersRepo: {
        findPapers: vi.fn().mockResolvedValue([
          { id: 1, title: '2025 年期末卷', year: 2025, district: '海淀', exam_type: '期末', grade_band: 'junior', question_count: 25 },
          { id: 2, title: '2024 年中考卷', year: 2024, district: null, exam_type: null, grade_band: null, question_count: 0 },
        ]),
      },
    });
    const r = await mkSvc(deps).listPapers({ subjectId: 1 });
    expect(r).toEqual([
      { id: 1, title: '2025 年期末卷', year: 2025, district: '海淀', examType: '期末', gradeBand: 'junior', questionCount: 25 },
      { id: 2, title: '2024 年中考卷', year: 2024, district: null, examType: null, gradeBand: null, questionCount: 0 },
    ]);
  });
});

describe('computeRecommendedDuration（纯函数）', () => {
  it('choice/true_false ×1min + 其余 ×3min', () => {
    // 2 choice + 1 proof = 2*1 + 1*3 = 5 -> ceil(5/15)*15 = 15 -> clamp 到 30
    expect(computeRecommendedDuration([
      { type: 'choice' }, { type: 'choice' }, { type: 'proof' },
    ])).toBe(30);
  });

  it('40 道客观题 -> ceil(40/15)*15 = 45', () => {
    const qs = Array.from({ length: 40 }, () => ({ type: 'choice' }));
    expect(computeRecommendedDuration(qs)).toBe(45);
  });

  it('上界 clamp 180：60 道 proof = 180min 原值；80 道 proof = 240 -> 180', () => {
    expect(computeRecommendedDuration(Array.from({ length: 60 }, () => ({ type: 'proof' })))).toBe(180);
    expect(computeRecommendedDuration(Array.from({ length: 80 }, () => ({ type: 'proof' })))).toBe(180);
  });

  it('空题单 -> clamp 下界 30', () => {
    expect(computeRecommendedDuration([])).toBe(30);
  });

  it('true_false 计 1min，short_answer 计 3min', () => {
    // 10 true_false + 10 short_answer = 10 + 30 = 40 -> ceil(40/15)*15 = 45
    const qs = [
      ...Array.from({ length: 10 }, () => ({ type: 'true_false' })),
      ...Array.from({ length: 10 }, () => ({ type: 'short_answer' })),
    ];
    expect(computeRecommendedDuration(qs)).toBe(45);
  });
});

describe('ExamsService.getPaperDetail', () => {
  const paperRow = { id: 1, title: '2025 年期末卷', year: 2025, district: '海淀', exam_type: '期末', grade_band: 'junior', question_count: 3 };

  it('组装详情：推荐时长 clamp 到 30；题目按 question_no 排序透传', async () => {
    const deps = mk({
      examPapersRepo: {
        findById: vi.fn().mockResolvedValue(paperRow),
        findQuestionsByPaperId: vi.fn().mockResolvedValue([
          { questionId: 10, questionNo: 1, text: '选择题 1', type: 'choice', options: '["A. 1", "B. 2"]' },
          { questionId: 11, questionNo: 2, text: '选择题 2', type: 'choice', options: null },
          { questionId: 12, questionNo: 3, text: '证明题', type: 'proof', options: null },
        ]),
      },
    });
    const r = await mkSvc(deps).getPaperDetail(1);
    // 2 choice ×1 + 1 proof ×3 = 5 -> ceil(5/15)*15 = 15 -> clamp 30
    expect(r.durationMinutes).toBe(30);
    expect(r.id).toBe(1);
    expect(r.title).toBe('2025 年期末卷');
    expect(r.questions).toHaveLength(3);
    expect(r.questions[0]).toEqual({ questionId: 10, questionNo: 1, text: '选择题 1', type: 'choice', options: ['A. 1', 'B. 2'] });
    expect(r.questions[2].options).toBeNull();
  });

  it('40 道客观题 -> 45 分钟', async () => {
    const deps = mk({
      examPapersRepo: {
        findById: vi.fn().mockResolvedValue({ ...paperRow, question_count: 40 }),
        findQuestionsByPaperId: vi.fn().mockResolvedValue(
          Array.from({ length: 40 }, (_, i) => ({ questionId: 100 + i, questionNo: i + 1, text: `题 ${i + 1}`, type: 'choice', options: null })),
        ),
      },
    });
    const r = await mkSvc(deps).getPaperDetail(1);
    expect(r.durationMinutes).toBe(45);
    expect(r.questions).toHaveLength(40);
  });

  it('白名单序列化：questions 只含 questionId/questionNo/text/type/options，不含 answer/explanation', async () => {
    const deps = mk({
      examPapersRepo: {
        findById: vi.fn().mockResolvedValue(paperRow),
        findQuestionsByPaperId: vi.fn().mockResolvedValue([
          { questionId: 10, questionNo: 1, text: '选择题', type: 'choice', options: '["A. 1"]' },
        ]),
      },
    });
    const r = await mkSvc(deps).getPaperDetail(1);
    const q = r.questions[0];
    expect(Object.keys(q).sort()).toEqual(['options', 'questionId', 'questionNo', 'text', 'type']);
    expect(JSON.stringify(r)).not.toContain('answer');
    expect(JSON.stringify(r)).not.toContain('explanation');
  });

  it('坏 JSON options 解析为 null，不抛错', async () => {
    const deps = mk({
      examPapersRepo: {
        findById: vi.fn().mockResolvedValue(paperRow),
        findQuestionsByPaperId: vi.fn().mockResolvedValue([
          { questionId: 10, questionNo: 1, text: '选择题', type: 'choice', options: 'not json' },
        ]),
      },
    });
    const r = await mkSvc(deps).getPaperDetail(1);
    expect(r.questions[0].options).toBeNull();
  });

  it('paper 不存在 -> 404', async () => {
    const deps = mk({
      examPapersRepo: {
        findPapers: vi.fn().mockResolvedValue([]),
        findById: vi.fn().mockResolvedValue(null),
        findQuestionsByPaperId: vi.fn().mockResolvedValue([]),
      },
    });
    await expect(mkSvc(deps).getPaperDetail(999)).rejects.toMatchObject({ status: 404 });
    expect(deps.examPapersRepo.findQuestionsByPaperId).not.toHaveBeenCalled();
  });
});

// ============================================================
// Task 2：考试会话生命周期
// ============================================================

describe('ExamsService.createSession', () => {
  it('无 in_progress 会话 -> 新建：deadline = now + duration，返回题单 + remainingSeconds', async () => {
    const deps = mk({ examPapersRepo: papersRepoWithPaper() });
    const r = await mkSvc(deps).createSession(1, { paperId: 5, durationMinutes: 30 });
    expect(deps.examSessionsRepo.findInProgressByStudentPaper).toHaveBeenCalledWith(1, 5);
    expect(deps.examSessionsRepo.create).toHaveBeenCalledTimes(1);
    const arg = deps.examSessionsRepo.create.mock.calls[0][0];
    expect(arg).toMatchObject({ studentId: 1, paperId: 5, subjectId: 2, durationMinutes: 30 });
    expect(arg.deadlineAt.getTime()).toBeGreaterThan(Date.now() + 29 * 60000);
    expect(r.sessionId).toBe(1);
    expect(r.questions).toHaveLength(3);
    expect(r.questions[0]).toEqual({ questionId: 10, questionNo: 1, text: '选择题 1', type: 'choice', options: ['A. 1', 'B. 2'] });
    expect(r.remainingSeconds).toBeGreaterThanOrEqual(1790);
    expect(r.remainingSeconds).toBeLessThanOrEqual(1800);
  });

  it('已有 in_progress 会话 -> 续考：不新建、不重置时长', async () => {
    const deps = mk({
      examPapersRepo: papersRepoWithPaper(),
      examSessionsRepo: {
        ...mk().examSessionsRepo,
        findInProgressByStudentPaper: vi.fn().mockResolvedValue(sessionRow({ id: 77, deadline_at: new Date(Date.now() + 300000) })),
      },
    });
    const r = await mkSvc(deps).createSession(1, { paperId: 5, durationMinutes: 30 });
    expect(deps.examSessionsRepo.create).not.toHaveBeenCalled();
    expect(r.sessionId).toBe(77);
    expect(r.remainingSeconds).toBeGreaterThanOrEqual(290);
    expect(r.remainingSeconds).toBeLessThanOrEqual(300);
    expect(r.questions).toHaveLength(3);
  });

  it('命中的 in_progress 会话已超时 -> 自动收卷 + status=submitted（前端踢结果页），不新建', async () => {
    const deps = mk({
      examPapersRepo: papersRepoWithPaper(),
      examSessionsRepo: {
        ...mk().examSessionsRepo,
        findInProgressByStudentPaper: vi.fn().mockResolvedValue(sessionRow({ id: 77, deadline_at: new Date(Date.now() - 1000) })),
      },
    });
    const r = await mkSvc(deps).createSession(1, { paperId: 5, durationMinutes: 30 });
    expect(deps.examSessionsRepo.create).not.toHaveBeenCalled();
    expect(deps.examSessionsRepo.markSubmitted).toHaveBeenCalledWith(77);
    expect(r.sessionId).toBe(77);
    expect(r.status).toBe('submitted');
    expect(r.remainingSeconds).toBe(0);
  });

  it('durationMinutes 越界/非整数 -> 400（合法区间 10-300 整数）', async () => {
    const deps = mk({ examPapersRepo: papersRepoWithPaper() });
    await expect(mkSvc(deps).createSession(1, { paperId: 5, durationMinutes: 9 })).rejects.toMatchObject({ status: 400 });
    await expect(mkSvc(deps).createSession(1, { paperId: 5, durationMinutes: 301 })).rejects.toMatchObject({ status: 400 });
    await expect(mkSvc(deps).createSession(1, { paperId: 5, durationMinutes: 10.5 })).rejects.toMatchObject({ status: 400 });
    expect(deps.examSessionsRepo.create).not.toHaveBeenCalled();
  });

  it('试卷不存在 -> 404', async () => {
    const deps = mk();
    await expect(mkSvc(deps).createSession(1, { paperId: 999, durationMinutes: 30 })).rejects.toMatchObject({ status: 404 });
  });
});

describe('ExamsService.submitAnswer', () => {
  it('正常路径：judgeQuestion(source=exam, sourceRefId=sessionId) -> upsertAnswer 落完整判题结果 -> 白名单响应', async () => {
    const deps = mk({
      examPapersRepo: papersRepoWithPaper(),
      examSessionsRepo: { ...mk().examSessionsRepo, findById: vi.fn().mockResolvedValue(sessionRow()) },
      judgeCore: {
        judgeQuestion: vi.fn().mockResolvedValue({ questionId: 10, isCorrect: false, method: 'exact', errorType: null, errorBookId: 9 }),
      },
    });
    const r = await mkSvc(deps).submitAnswer(1, 77, { questionId: 10, answerText: 'A' });
    expect(deps.judgeCore.judgeQuestion).toHaveBeenCalledWith({
      studentId: 1, subjectId: 2, questionId: 10, studentAnswer: 'A', source: 'exam', sourceRefId: 77,
    });
    expect(deps.examSessionsRepo.upsertAnswer).toHaveBeenCalledWith({
      sessionId: 77, questionId: 10, questionOrder: 1, answerText: 'A',
      isCorrect: 0, method: 'exact', errorType: null, judgedAt: expect.any(Date),
    });
    // I-1：判题前先落「在途行」（is_correct NULL）——判题在途窗口内自动收卷走补判而非未作答
    expect(deps.examSessionsRepo.upsertAnswer).toHaveBeenCalledTimes(2);
    const inflight = deps.examSessionsRepo.upsertAnswer.mock.calls[0][0];
    expect(inflight).toMatchObject({ sessionId: 77, questionId: 10, questionOrder: 1, answerText: 'A' });
    expect(inflight.isCorrect).toBeUndefined();
    expect(deps.examSessionsRepo.upsertAnswer.mock.invocationCallOrder[0])
      .toBeLessThan(deps.judgeCore.judgeQuestion.mock.invocationCallOrder[0]);
    // 白名单：只回 saved，不泄露对错
    expect(Object.keys(r).sort()).toEqual(['saved']);
    expect(r.saved).toBe(true);
  });

  it('超 deadline -> 409 + 自动收卷（未答题入 exam_answers + 错题本）', async () => {
    const deps = mk({
      examPapersRepo: papersRepoWithPaper(),
      examSessionsRepo: {
        ...mk().examSessionsRepo,
        findById: vi.fn().mockResolvedValue(sessionRow({ deadline_at: new Date(Date.now() - 1000) })),
      },
    });
    await expect(mkSvc(deps).submitAnswer(1, 77, { questionId: 10, answerText: 'A' })).rejects.toMatchObject({ status: 409 });
    expect(deps.examSessionsRepo.markSubmitted).toHaveBeenCalledWith(77);
    expect(deps.examSessionsRepo.upsertAnswer).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 77, questionId: 10, isCorrect: 0, method: 'unanswered',
    }));
    expect(deps.mainErrorRepo.create).toHaveBeenCalledWith({
      student_id: 1, subject_id: 2, question_id: 10, source: 'exam', source_ref_id: 77,
      question_n: null, lesson_id: null, wrong_answer_text: null,
    });
  });

  it('judgeCore 抛错 -> 先落 answerText（is_correct NULL 在途）再透传错误，交卷时补判', async () => {
    const deps = mk({
      examPapersRepo: papersRepoWithPaper(),
      examSessionsRepo: { ...mk().examSessionsRepo, findById: vi.fn().mockResolvedValue(sessionRow()) },
      judgeCore: { judgeQuestion: vi.fn().mockRejectedValue({ status: 503 }) },
    });
    await expect(mkSvc(deps).submitAnswer(1, 77, { questionId: 10, answerText: 'A' })).rejects.toMatchObject({ status: 503 });
    expect(deps.examSessionsRepo.upsertAnswer).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 77, questionId: 10, questionOrder: 1, answerText: 'A',
    }));
    const call = deps.examSessionsRepo.upsertAnswer.mock.calls[0][0];
    expect(call.isCorrect).toBeUndefined();
    expect(call.method).toBeUndefined();
  });

  it('会话已 submitted -> 409，不再判题', async () => {
    const deps = mk({
      examPapersRepo: papersRepoWithPaper(),
      examSessionsRepo: {
        ...mk().examSessionsRepo,
        findById: vi.fn().mockResolvedValue(sessionRow({ status: 'submitted' })),
      },
    });
    await expect(mkSvc(deps).submitAnswer(1, 77, { questionId: 10, answerText: 'A' })).rejects.toMatchObject({ status: 409 });
    expect(deps.judgeCore.judgeQuestion).not.toHaveBeenCalled();
  });

  it('题目不在该试卷题单 -> 400', async () => {
    const deps = mk({
      examPapersRepo: papersRepoWithPaper(),
      examSessionsRepo: { ...mk().examSessionsRepo, findById: vi.fn().mockResolvedValue(sessionRow()) },
    });
    await expect(mkSvc(deps).submitAnswer(1, 77, { questionId: 999, answerText: 'A' })).rejects.toMatchObject({ status: 400 });
    expect(deps.judgeCore.judgeQuestion).not.toHaveBeenCalled();
  });

  it('非本人会话 -> 403', async () => {
    const deps = mk({
      examSessionsRepo: { ...mk().examSessionsRepo, findById: vi.fn().mockResolvedValue(sessionRow({ student_id: 42 })) },
    });
    await expect(mkSvc(deps).submitAnswer(1, 77, { questionId: 10, answerText: 'A' })).rejects.toMatchObject({ status: 403 });
  });
});

describe('ExamsService.submit', () => {
  it('2 题未答 + 1 题已答对：未答题不走 judgeCore，直接 method=unanswered 判错 + 入错题本', async () => {
    const deps = mk({
      examPapersRepo: papersRepoWithPaper(),
      examSessionsRepo: {
        ...mk().examSessionsRepo,
        findById: vi.fn().mockResolvedValue(sessionRow()),
        findAnswersBySession: vi.fn().mockResolvedValue([
          { id: 1, session_id: 77, question_id: 10, question_order: 1, answer_text: 'A', is_correct: 1, method: 'exact', analysis: null, error_type: null, judged_at: new Date() },
        ]),
      },
    });
    const r = await mkSvc(deps).submit(1, 77);
    expect(deps.judgeCore.judgeQuestion).not.toHaveBeenCalled();
    // 未答题 11/12 -> upsertAnswer(unanswered) + mainErrorRepo.create
    expect(deps.examSessionsRepo.upsertAnswer).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 77, questionId: 11, questionOrder: 2, isCorrect: 0, method: 'unanswered' }));
    expect(deps.examSessionsRepo.upsertAnswer).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 77, questionId: 12, questionOrder: 3, isCorrect: 0, method: 'unanswered' }));
    expect(deps.mainErrorRepo.create).toHaveBeenCalledTimes(2);
    expect(deps.mainErrorRepo.create).toHaveBeenCalledWith({
      student_id: 1, subject_id: 2, question_id: 11, source: 'exam', source_ref_id: 77,
      question_n: null, lesson_id: null, wrong_answer_text: null,
    });
    expect(deps.examSessionsRepo.markSubmitted).toHaveBeenCalledWith(77);
    expect(r).toEqual({ correctCount: 1, totalCount: 3, accuracy: 33.3 });
  });

  it('I-2 find-or-create：已有未清错题（error_practice/前次考试）-> 复用既有行，不重复 create', async () => {
    const deps = mk({
      examPapersRepo: papersRepoWithPaper(),
      examSessionsRepo: {
        ...mk().examSessionsRepo,
        findById: vi.fn().mockResolvedValue(sessionRow()),
        findAnswersBySession: vi.fn().mockResolvedValue([
          { id: 1, session_id: 77, question_id: 10, question_order: 1, answer_text: 'A', is_correct: 1, method: 'exact', analysis: null, error_type: null, judged_at: new Date() },
        ]),
      },
      mainErrorRepo: {
        ...mk().mainErrorRepo,
        findUnclearedByStudentQuestionId: vi.fn().mockResolvedValue({ id: 55 }),
      },
    });
    await mkSvc(deps).submit(1, 77);
    // 未答题 11/12 各查一次既有行，均命中 -> 不 create
    expect(deps.mainErrorRepo.findUnclearedByStudentQuestionId).toHaveBeenCalledTimes(2);
    expect(deps.mainErrorRepo.findUnclearedByStudentQuestionId).toHaveBeenCalledWith(1, 11);
    expect(deps.mainErrorRepo.create).not.toHaveBeenCalled();
  });

  it('在途题（answer_text 非空、is_correct NULL）-> judgeCore 补判并落完整结果', async () => {
    const deps = mk({
      examPapersRepo: papersRepoWithPaper(),
      examSessionsRepo: {
        ...mk().examSessionsRepo,
        findById: vi.fn().mockResolvedValue(sessionRow()),
        findAnswersBySession: vi.fn().mockResolvedValue([
          { id: 1, session_id: 77, question_id: 10, question_order: 1, answer_text: 'A', is_correct: 1, method: 'exact', analysis: null, error_type: null, judged_at: new Date() },
          { id: 2, session_id: 77, question_id: 11, question_order: 2, answer_text: '2/3', is_correct: null, method: null, analysis: null, error_type: null, judged_at: null },
        ]),
      },
      judgeCore: {
        judgeQuestion: vi.fn().mockResolvedValue({ questionId: 11, isCorrect: true, method: 'exact', errorType: null, errorBookId: undefined }),
      },
    });
    const r = await mkSvc(deps).submit(1, 77);
    expect(deps.judgeCore.judgeQuestion).toHaveBeenCalledWith({
      studentId: 1, subjectId: 2, questionId: 11, studentAnswer: '2/3', source: 'exam', sourceRefId: 77,
    });
    expect(deps.examSessionsRepo.upsertAnswer).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 77, questionId: 11, answerText: '2/3', isCorrect: 1, method: 'exact',
    }));
    // q11 补判答对不入错题本；q12 未答入错题本（仅 1 次）
    expect(deps.mainErrorRepo.create).toHaveBeenCalledTimes(1);
    expect(r.totalCount).toBe(3);
  });

  it('在途题补判失败 -> method=failed 按错计 + 入错题本', async () => {
    const deps = mk({
      examPapersRepo: papersRepoWithPaper(),
      examSessionsRepo: {
        ...mk().examSessionsRepo,
        findById: vi.fn().mockResolvedValue(sessionRow()),
        findAnswersBySession: vi.fn().mockResolvedValue([
          { id: 2, session_id: 77, question_id: 11, question_order: 2, answer_text: 'x', is_correct: null, method: null, analysis: null, error_type: null, judged_at: null },
        ]),
      },
      judgeCore: { judgeQuestion: vi.fn().mockRejectedValue(new Error('LLM down')) },
    });
    const r = await mkSvc(deps).submit(1, 77);
    expect(deps.examSessionsRepo.upsertAnswer).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 77, questionId: 11, answerText: 'x', isCorrect: 0, method: 'failed',
    }));
    // q10/q12 未答 + q11 failed -> 各入一次错题本（共 3 次）
    expect(deps.mainErrorRepo.create).toHaveBeenCalledTimes(3);
    expect(r).toEqual({ correctCount: 0, totalCount: 3, accuracy: 0 });
  });

  it('幂等：已 submitted -> 直接重算汇总返回，不重复判题/落库', async () => {
    const deps = mk({
      examPapersRepo: papersRepoWithPaper(),
      examSessionsRepo: {
        ...mk().examSessionsRepo,
        findById: vi.fn().mockResolvedValue(sessionRow({ status: 'submitted' })),
        findAnswersBySession: vi.fn().mockResolvedValue([
          { id: 1, session_id: 77, question_id: 10, question_order: 1, answer_text: 'A', is_correct: 1, method: 'exact', analysis: null, error_type: null, judged_at: new Date() },
          { id: 2, session_id: 77, question_id: 11, question_order: 2, answer_text: 'x', is_correct: 0, method: 'ai', analysis: '错因', error_type: 'logic', judged_at: new Date() },
          { id: 3, session_id: 77, question_id: 12, question_order: 3, answer_text: null, is_correct: 0, method: 'unanswered', analysis: null, error_type: null, judged_at: new Date() },
        ]),
      },
    });
    const r = await mkSvc(deps).submit(1, 77);
    expect(r).toEqual({ correctCount: 1, totalCount: 3, accuracy: 33.3 });
    expect(deps.judgeCore.judgeQuestion).not.toHaveBeenCalled();
    expect(deps.examSessionsRepo.upsertAnswer).not.toHaveBeenCalled();
    expect(deps.examSessionsRepo.markSubmitted).not.toHaveBeenCalled();
  });

  it('会话不存在 -> 404；非本人 -> 403', async () => {
    const deps = mk();
    await expect(mkSvc(deps).submit(1, 99)).rejects.toMatchObject({ status: 404 });
    const deps2 = mk({
      examSessionsRepo: { ...mk().examSessionsRepo, findById: vi.fn().mockResolvedValue(sessionRow({ student_id: 42 })) },
    });
    await expect(mkSvc(deps2).submit(1, 77)).rejects.toMatchObject({ status: 403 });
  });
});

describe('ExamsService.getSession', () => {
  it('进行中：返回 answered map（只有 answerText，无对错）+ remainingSeconds', async () => {
    const deps = mk({
      examPapersRepo: papersRepoWithPaper(),
      examSessionsRepo: {
        ...mk().examSessionsRepo,
        findById: vi.fn().mockResolvedValue(sessionRow()),
        findAnswersBySession: vi.fn().mockResolvedValue([
          { id: 1, session_id: 77, question_id: 10, question_order: 1, answer_text: 'A', is_correct: 1, method: 'exact', analysis: null, error_type: null, judged_at: new Date() },
        ]),
      },
    });
    const r = await mkSvc(deps).getSession(1, 77);
    expect(r.status).toBe('in_progress');
    expect(r.remainingSeconds).toBeGreaterThan(0);
    expect(r.questions).toHaveLength(3);
    expect(r.answered).toEqual({ 10: { answerText: 'A' } });
    // 白名单：不泄露判题结果
    expect(JSON.stringify(r)).not.toContain('isCorrect');
    expect(JSON.stringify(r)).not.toContain('is_correct');
  });

  it('deadline 已过 -> 自动收卷，status=submitted', async () => {
    const deps = mk({
      examPapersRepo: papersRepoWithPaper(),
      examSessionsRepo: {
        ...mk().examSessionsRepo,
        findById: vi.fn().mockResolvedValue(sessionRow({ deadline_at: new Date(Date.now() - 1000) })),
      },
    });
    const r = await mkSvc(deps).getSession(1, 77);
    expect(r.status).toBe('submitted');
    expect(r.remainingSeconds).toBe(0);
    expect(deps.examSessionsRepo.markSubmitted).toHaveBeenCalledWith(77);
    expect(deps.examSessionsRepo.upsertAnswer).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 77, method: 'unanswered' }));
  });

  it('已 submitted：直接返回状态，不再收卷/判题', async () => {
    const deps = mk({
      examPapersRepo: papersRepoWithPaper(),
      examSessionsRepo: {
        ...mk().examSessionsRepo,
        findById: vi.fn().mockResolvedValue(sessionRow({ status: 'submitted' })),
        findAnswersBySession: vi.fn().mockResolvedValue([]),
      },
    });
    const r = await mkSvc(deps).getSession(1, 77);
    expect(r.status).toBe('submitted');
    expect(deps.judgeCore.judgeQuestion).not.toHaveBeenCalled();
    expect(deps.examSessionsRepo.markSubmitted).not.toHaveBeenCalled();
  });
});

describe('ExamsService.getResults', () => {
  it('in_progress -> 409', async () => {
    const deps = mk({
      examSessionsRepo: { ...mk().examSessionsRepo, findById: vi.fn().mockResolvedValue(sessionRow()) },
    });
    await expect(mkSvc(deps).getResults(1, 77)).rejects.toMatchObject({ status: 409 });
  });

  it('submitted：汇总 + items JOIN questions 带 explanation，options 解析', async () => {
    const deps = mk({
      examSessionsRepo: {
        ...mk().examSessionsRepo,
        findById: vi.fn().mockResolvedValue(sessionRow({ status: 'submitted' })),
        findAnswersWithQuestions: vi.fn().mockResolvedValue([
          { question_id: 10, question_order: 1, answer_text: 'A', is_correct: 1, analysis: null, text: '选择题 1', type: 'choice', options: '["A. 1", "B. 2"]', explanation: '选 A 因为...' },
          { question_id: 11, question_order: 2, answer_text: 'x', is_correct: 0, analysis: '移项符号错误', text: '填空题', type: 'fill_blank', options: null, explanation: '解析 2' },
        ]),
      },
    });
    const r = await mkSvc(deps).getResults(1, 77);
    expect(r.correctCount).toBe(1);
    expect(r.totalCount).toBe(2);
    expect(r.accuracy).toBe(50);
    expect(r.items[0]).toEqual({
      questionId: 10, questionNo: 1, text: '选择题 1', type: 'choice', options: ['A. 1', 'B. 2'],
      answerText: 'A', isCorrect: 1, analysis: null, explanation: '选 A 因为...',
    });
    expect(r.items[1].analysis).toBe('移项符号错误');
    expect(r.items[1].explanation).toBe('解析 2');
  });

  it('会话不存在 -> 404；非本人 -> 403', async () => {
    const deps = mk();
    await expect(mkSvc(deps).getResults(1, 99)).rejects.toMatchObject({ status: 404 });
    const deps2 = mk({
      examSessionsRepo: { ...mk().examSessionsRepo, findById: vi.fn().mockResolvedValue(sessionRow({ student_id: 42 })) },
    });
    await expect(mkSvc(deps2).getResults(1, 77)).rejects.toMatchObject({ status: 403 });
  });
});
