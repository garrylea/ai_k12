/**
 * RemediationService（错题补偿套题编排，Task 7）单元测试。
 *
 * 本文件钉住的铁律：
 *
 * 1. **发分顺序**（用户裁决，偏离简报原码）：`award` 成功之后才置 `points_awarded=1`，
 *    且两步都在 try 内、失败只 warn。若反过来（先置标记再发分），award 一旦抖动，
 *    标记已置 1 → 学生这道题**永久拿不到分**；DB 失败还会让 `submitAnswer` 在判题之后抛错。
 *    见「发分顺序」与「award 抛错」两条用例。
 * 2. **`selfAssess` 不经 `judgeCore`**（Task 4 复核遗留裁决的可执行证据）：套题内主观题自评
 *    走 `requireItem` + `applyOutcome`，**不调** `judgeCore.judgeQuestion`/`recordSelfAssessment`，
 *    故不会入错题本、不清零原错题、不发 `error_fix`。见 `selfAssess` 描述块。
 * 3. **积分/掌握度写入永不阻断判题主链路**：award / markPointsAwarded 抛错只 warn，
 *    `submitAnswer` 照常返回判题结果。
 * 4. **套题自清零**：全对 → `deleteSet`；题已下线（`findByIds` 查不到，repo 只回 `is_active=1`）
 *    → 标记已答对防死锁。
 * 5. **`generate` 防伪造**：targeted 来源逐个用 `findUnclearedByStudentQuestionId` 校验、
 *    只认 `source === 'targeted'`。
 *
 * harness 说明（**对简报样板的修正**）：简报把 `remediationRepo.findActiveByStudent` mock 成
 * 恒 `null`，但 `requireItem()` 第一步就查它、为 null 直接抛「当前没有进行中的相似题专项练习」
 * → `submitAnswer` 的用例必然失败。此处改为返回**真实套题行**（`id: 100` / `student_id: 7`）。
 * 同时补 `generator.retryPending` 与 `findGroupsBySet`（`getOverview` 会用到）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { RemediationService } from './remediation.service.js';
import type { QuestionRow } from '../../database/repositories/types.js';
import type { RemediationItemRow, RemediationSetRow } from '../../database/repositories/remediation.repo.js';

const STUDENT_ID = 7;
const SET_ID = 100;
const ITEM_ID = 901;
const QUESTION_ID = 11;

// 静音 Nest Logger：applyOutcome 的发分失败分支、listQuestions 的兜底路径都可能记 warn。
// 注意 `Logger.prototype.warn` 被 Nest 装饰过，`vi.restoreAllMocks()` 单独还原会丢 `this`
//（实测 `this.context` undefined）——必须显式 `mockRestore()`（同 generator 测试的做法）。
let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  warnSpy.mockRestore();
  logSpy.mockRestore();
  vi.restoreAllMocks();
});

// RowDataPacket 的 `constructor` 是字面量类型，无法用 Partial<...> 收窄 → 夹具用宽松入参 + 断言出参。
function makeSet(over: Record<string, unknown> = {}): RemediationSetRow {
  return {
    id: SET_ID,
    student_id: STUDENT_ID,
    subject_id: 1,
    status: 'active',
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  } as RemediationSetRow;
}

function makeItem(over: Record<string, unknown> = {}): RemediationItemRow {
  return {
    id: ITEM_ID,
    group_id: 1,
    question_id: QUESTION_ID,
    is_correct: 0,
    points_awarded: 0,
    attempts: 0,
    last_answered_at: null,
    created_at: new Date(),
    ...over,
  } as RemediationItemRow;
}

function makeQuestion(over: Record<string, unknown> = {}): QuestionRow {
  return {
    id: QUESTION_ID,
    subject_id: 1,
    type: 'choice',
    difficulty: 1,
    content: '题干',
    options: null,
    answer: 'B',
    explanation: null,
    source: null,
    content_hash: null,
    is_active: 1,
    created_at: new Date(),
    ...over,
  } as QuestionRow;
}

function harness() {
  const remediationRepo = {
    // 修正简报样板：返回真实套题行（否则 requireItem 必抛，submitAnswer 用例全红）
    findActiveByStudent: vi.fn().mockResolvedValue(makeSet()),
    createSet: vi.fn().mockResolvedValue(SET_ID),
    findGroupsBySet: vi.fn().mockResolvedValue([]),
    findItemsBySet: vi.fn().mockResolvedValue([]),
    findItemBySetQuestion: vi.fn().mockResolvedValue(makeItem()),
    markItemCorrect: vi.fn().mockResolvedValue(undefined),
    markPointsAwarded: vi.fn().mockResolvedValue(undefined),
    recordAttempt: vi.fn().mockResolvedValue(undefined),
    deleteSet: vi.fn().mockResolvedValue(undefined),
  };
  const questionsRepo = {
    findByIds: vi.fn().mockResolvedValue([]),
    findById: vi.fn().mockResolvedValue(makeQuestion()),
  };
  const mainErrorRepo = { findUnclearedByStudentQuestionId: vi.fn().mockResolvedValue(null) };
  const examSessionsRepo = {
    findById: vi.fn().mockResolvedValue(null),
    findAnswersBySession: vi.fn().mockResolvedValue([]),
  };
  const trainingSessionsRepo = { findById: vi.fn().mockResolvedValue(null) };
  const generator = {
    buildGroups: vi.fn().mockResolvedValue({ groupsCreated: 0, itemsCreated: 0, skippedNoKp: 0, aiPendingCount: 0 }),
    retryPending: vi.fn(),
  };
  const judgeCore = { judgeQuestion: vi.fn() };
  const pointsService = {
    award: vi.fn().mockResolvedValue({ pointsAwarded: 3, balance: 100, totalEarned: 200, levelUp: null }),
  };

  const service = new RemediationService(
    remediationRepo as any,
    questionsRepo as any,
    mainErrorRepo as any,
    examSessionsRepo as any,
    trainingSessionsRepo as any,
    generator as any,
    judgeCore as any,
    pointsService as any,
  );

  return {
    service, remediationRepo, questionsRepo, mainErrorRepo,
    examSessionsRepo, trainingSessionsRepo, generator, judgeCore, pointsService,
  };
}

// ---------------------------------------------------------------------------
// generate · exam 来源
// ---------------------------------------------------------------------------

describe('generate · exam 来源', () => {
  it('会话非本人 → NotFound（考试会话不存在），不建套题', async () => {
    const { service, examSessionsRepo, remediationRepo } = harness();
    examSessionsRepo.findById.mockResolvedValue({ student_id: 2, status: 'submitted' });

    await expect(service.generate(STUDENT_ID, { source: 'exam', sessionId: 7 }))
      .rejects.toThrow('考试会话不存在');
    expect(remediationRepo.createSet).not.toHaveBeenCalled();
  });

  it('会话不存在 → NotFound', async () => {
    const { service, examSessionsRepo } = harness();
    examSessionsRepo.findById.mockResolvedValue(null);
    await expect(service.generate(STUDENT_ID, { source: 'exam', sessionId: 7 }))
      .rejects.toThrow('考试会话不存在');
  });

  it('未交卷 → BadRequest（考试尚未交卷）', async () => {
    const { service, examSessionsRepo } = harness();
    examSessionsRepo.findById.mockResolvedValue({ student_id: STUDENT_ID, status: 'in_progress' });
    await expect(service.generate(STUDENT_ID, { source: 'exam', sessionId: 7 }))
      .rejects.toThrow('考试尚未交卷');
  });

  it('按 is_correct===0 取错题（null 在途题不算），已有 active 套题则复用其 setId', async () => {
    const { service, examSessionsRepo, questionsRepo, remediationRepo, generator } = harness();
    examSessionsRepo.findById.mockResolvedValue({ student_id: STUDENT_ID, status: 'submitted' });
    examSessionsRepo.findAnswersBySession.mockResolvedValue([
      { question_id: 11, is_correct: 0 },
      { question_id: 12, is_correct: 1 },
      { question_id: 13, is_correct: null }, // 在途/未判：不算错题
      { question_id: 14, is_correct: 0 },
    ]);
    const wrongs = [makeQuestion({ id: 11 }), makeQuestion({ id: 14 })];
    questionsRepo.findByIds.mockResolvedValue(wrongs);
    generator.buildGroups.mockResolvedValue({ groupsCreated: 2, itemsCreated: 6, skippedNoKp: 0, aiPendingCount: 1 });

    const res = await service.generate(STUDENT_ID, { source: 'exam', sessionId: 7 });

    expect(questionsRepo.findByIds).toHaveBeenCalledWith([11, 14]);
    expect(remediationRepo.createSet).not.toHaveBeenCalled(); // 追加合并：复用既有套题
    expect(generator.buildGroups).toHaveBeenCalledWith(STUDENT_ID, SET_ID, wrongs);
    expect(res).toEqual({ setId: SET_ID, groupsCreated: 2, itemsCreated: 6, skippedNoKp: 0, aiPendingCount: 1 });
  });

  it('无错题 → 全 0 概要，不建套题、不查题、不调生成器', async () => {
    const { service, examSessionsRepo, remediationRepo, generator, questionsRepo } = harness();
    examSessionsRepo.findById.mockResolvedValue({ student_id: STUDENT_ID, status: 'submitted' });
    examSessionsRepo.findAnswersBySession.mockResolvedValue([{ question_id: 11, is_correct: 1 }]);

    const res = await service.generate(STUDENT_ID, { source: 'exam', sessionId: 7 });

    expect(res).toEqual({ setId: 0, groupsCreated: 0, itemsCreated: 0, skippedNoKp: 0, aiPendingCount: 0 });
    expect(remediationRepo.createSet).not.toHaveBeenCalled();
    expect(questionsRepo.findByIds).not.toHaveBeenCalled();
    expect(generator.buildGroups).not.toHaveBeenCalled();
  });

  it('没有 active 套题时新建（createSet），返回新 setId', async () => {
    const { service, examSessionsRepo, questionsRepo, remediationRepo, generator } = harness();
    examSessionsRepo.findById.mockResolvedValue({ student_id: STUDENT_ID, status: 'submitted' });
    examSessionsRepo.findAnswersBySession.mockResolvedValue([{ question_id: 11, is_correct: 0 }]);
    questionsRepo.findByIds.mockResolvedValue([makeQuestion({ id: 11 })]);
    remediationRepo.findActiveByStudent.mockResolvedValue(null);
    remediationRepo.createSet.mockResolvedValue(555);

    const res = await service.generate(STUDENT_ID, { source: 'exam', sessionId: 7 });

    expect(remediationRepo.createSet).toHaveBeenCalledWith(STUDENT_ID, 1);
    expect(generator.buildGroups).toHaveBeenCalledWith(STUDENT_ID, 555, expect.any(Array));
    expect(res.setId).toBe(555);
  });
});

// ---------------------------------------------------------------------------
// generate · targeted 来源（防前端伪造题号刷分）
// ---------------------------------------------------------------------------

describe('generate · targeted 来源', () => {
  it('会话非本人 / 非数学专项 → NotFound（专项练习会话不存在）', async () => {
    const h = harness();
    h.trainingSessionsRepo.findById.mockResolvedValue({ student_id: STUDENT_ID, task_code: 'en_vocabulary' });
    await expect(h.service.generate(STUDENT_ID, { source: 'targeted', sessionId: 8, wrongQuestionIds: [11] }))
      .rejects.toThrow('专项练习会话不存在');

    h.trainingSessionsRepo.findById.mockResolvedValue({ student_id: 2, task_code: 'math_targeted' });
    await expect(h.service.generate(STUDENT_ID, { source: 'targeted', sessionId: 8, wrongQuestionIds: [11] }))
      .rejects.toThrow('专项练习会话不存在');
  });

  it('只认 source==="targeted" 的未清错题：exam 来源与无记录题号都被丢弃', async () => {
    const { service, trainingSessionsRepo, mainErrorRepo, questionsRepo } = harness();
    trainingSessionsRepo.findById.mockResolvedValue({ student_id: STUDENT_ID, task_code: 'math_targeted' });
    mainErrorRepo.findUnclearedByStudentQuestionId.mockImplementation((_sid: number, qid: number) =>
      Promise.resolve(
        qid === 11 ? { source: 'targeted' }
          : qid === 12 ? { source: 'exam' } // 伪造：同一题号但来源不是专项
            : null, // 13：根本没有未清错题记录
      ),
    );
    questionsRepo.findByIds.mockResolvedValue([makeQuestion({ id: 11 })]);

    await service.generate(STUDENT_ID, { source: 'targeted', sessionId: 8, wrongQuestionIds: [11, 12, 13] });

    expect(mainErrorRepo.findUnclearedByStudentQuestionId).toHaveBeenCalledTimes(3);
    expect(questionsRepo.findByIds).toHaveBeenCalledWith([11]);
  });

  it('题号重复只校验一次（Set 去重）', async () => {
    const { service, trainingSessionsRepo, mainErrorRepo, questionsRepo } = harness();
    trainingSessionsRepo.findById.mockResolvedValue({ student_id: STUDENT_ID, task_code: 'math_targeted' });
    mainErrorRepo.findUnclearedByStudentQuestionId.mockResolvedValue({ source: 'targeted' });
    questionsRepo.findByIds.mockResolvedValue([makeQuestion({ id: 11 })]);

    await service.generate(STUDENT_ID, { source: 'targeted', sessionId: 8, wrongQuestionIds: [11, 11] });

    expect(mainErrorRepo.findUnclearedByStudentQuestionId).toHaveBeenCalledTimes(1);
    expect(questionsRepo.findByIds).toHaveBeenCalledWith([11]);
  });

  it('全部题号都被过滤 → 不建套题（全 0 概要）', async () => {
    const { service, trainingSessionsRepo, mainErrorRepo, remediationRepo, generator } = harness();
    trainingSessionsRepo.findById.mockResolvedValue({ student_id: STUDENT_ID, task_code: 'math_targeted' });
    mainErrorRepo.findUnclearedByStudentQuestionId.mockResolvedValue(null);

    const res = await service.generate(STUDENT_ID, { source: 'targeted', sessionId: 8, wrongQuestionIds: [11, 12] });

    expect(res).toEqual({ setId: 0, groupsCreated: 0, itemsCreated: 0, skippedNoKp: 0, aiPendingCount: 0 });
    expect(remediationRepo.createSet).not.toHaveBeenCalled();
    expect(generator.buildGroups).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getOverview
// ---------------------------------------------------------------------------

describe('getOverview', () => {
  it('无 active 套题 → active:false 全 0，不做惰性重试', async () => {
    const { service, remediationRepo, generator } = harness();
    remediationRepo.findActiveByStudent.mockResolvedValue(null);

    await expect(service.getOverview(STUDENT_ID)).resolves.toEqual({
      active: false, setId: null, groupCount: 0, itemCount: 0, correctCount: 0,
    });
    expect(generator.retryPending).not.toHaveBeenCalled();
  });

  it('有 active → 组数/总题数/已答对数，并顺带 retryPending(setId)（AI 补题悬挂惰性重试）', async () => {
    const { service, remediationRepo, generator } = harness();
    remediationRepo.findGroupsBySet.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    remediationRepo.findItemsBySet.mockResolvedValue([
      makeItem({ id: 1, is_correct: 1 }),
      makeItem({ id: 2, is_correct: 0 }),
      makeItem({ id: 3, is_correct: 1 }),
    ]);

    await expect(service.getOverview(STUDENT_ID)).resolves.toEqual({
      active: true, setId: SET_ID, groupCount: 2, itemCount: 3, correctCount: 2,
    });
    expect(generator.retryPending).toHaveBeenCalledWith(SET_ID);
  });
});

// ---------------------------------------------------------------------------
// listQuestions
// ---------------------------------------------------------------------------

describe('listQuestions', () => {
  it('无 active 套题 → 空列表', async () => {
    const { service, remediationRepo, questionsRepo } = harness();
    remediationRepo.findActiveByStudent.mockResolvedValue(null);

    await expect(service.listQuestions(STUDENT_ID)).resolves.toEqual({
      questions: [], itemCount: 0, correctCount: 0,
    });
    expect(questionsRepo.findByIds).not.toHaveBeenCalled();
  });

  it('只下发未答对的题，选项 JSON 解析后透传', async () => {
    const { service, remediationRepo, questionsRepo } = harness();
    const options = [{ label: 'A', text: '1' }, { label: 'B', text: '2' }];
    remediationRepo.findItemsBySet.mockResolvedValue([
      makeItem({ id: 901, question_id: 11, is_correct: 0 }),
      makeItem({ id: 902, question_id: 12, is_correct: 1 }), // 已答对：不下发
    ]);
    questionsRepo.findByIds.mockResolvedValue([
      makeQuestion({ id: 11, content: '1+1=?', type: 'choice', options: JSON.stringify(options) }),
    ]);

    await expect(service.listQuestions(STUDENT_ID)).resolves.toEqual({
      questions: [{ questionId: 11, text: '1+1=?', type: 'choice', options }],
      itemCount: 2,
      correctCount: 1,
    });
    expect(questionsRepo.findByIds).toHaveBeenCalledWith([11]); // 只查未答对的
  });

  it('全部已答对 → deleteSet 兜底清套，返回空', async () => {
    const { service, remediationRepo, questionsRepo } = harness();
    remediationRepo.findItemsBySet.mockResolvedValue([
      makeItem({ id: 901, is_correct: 1 }),
      makeItem({ id: 902, is_correct: 1 }),
    ]);

    await expect(service.listQuestions(STUDENT_ID)).resolves.toEqual({
      questions: [], itemCount: 2, correctCount: 2,
    });
    expect(remediationRepo.deleteSet).toHaveBeenCalledWith(SET_ID);
    expect(questionsRepo.findByIds).not.toHaveBeenCalled();
  });

  it('题已下线（findByIds 查不到，repo 只回 is_active=1）→ 标记已答对防套题死锁', async () => {
    const { service, remediationRepo, questionsRepo } = harness();
    remediationRepo.findItemsBySet.mockResolvedValue([
      makeItem({ id: 901, question_id: 11, is_correct: 0 }),
      makeItem({ id: 902, question_id: 12, is_correct: 0 }), // 12 已下线
    ]);
    questionsRepo.findByIds.mockResolvedValue([makeQuestion({ id: 11 })]);

    const res = await service.listQuestions(STUDENT_ID);

    expect(remediationRepo.markItemCorrect).toHaveBeenCalledWith(902);
    expect(remediationRepo.markItemCorrect).toHaveBeenCalledTimes(1);
    expect(res.questions.map((q) => q.questionId)).toEqual([11]);
    expect(res.itemCount).toBe(2);
    expect(res.correctCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// submitAnswer
// ---------------------------------------------------------------------------

describe('submitAnswer', () => {
  it('答对且全对 → 置 is_correct + 删套题 + setCompleted=true，并按题型档位发分', async () => {
    const { service, remediationRepo, judgeCore, pointsService, mainErrorRepo } = harness();
    remediationRepo.findItemsBySet.mockResolvedValue([makeItem({ id: ITEM_ID, is_correct: 1 })]);
    judgeCore.judgeQuestion.mockResolvedValue({ isCorrect: true, method: 'exact' });

    const res = await service.submitAnswer(STUDENT_ID, { questionId: QUESTION_ID, studentAnswer: 'B' });

    expect(judgeCore.judgeQuestion).toHaveBeenCalledWith({
      studentId: STUDENT_ID,
      subjectId: 1,
      questionId: QUESTION_ID,
      studentAnswer: 'B',
      source: 'remediation', // 套题自清零：判题入口必须带 remediation 来源
    });
    expect(remediationRepo.recordAttempt).toHaveBeenCalledWith(ITEM_ID);
    expect(remediationRepo.markItemCorrect).toHaveBeenCalledWith(ITEM_ID);
    expect(remediationRepo.deleteSet).toHaveBeenCalledWith(SET_ID);
    expect(pointsService.award).toHaveBeenCalledWith(expect.objectContaining({
      studentId: STUDENT_ID,
      taskCode: 'remediation_question',
      tierKey: 'choice',
      dedupeKey: `rem:${ITEM_ID}`, // 不带日期：每题全程只发一次
      refType: 'question',
      refId: QUESTION_ID,
    }));
    expect(mainErrorRepo.findUnclearedByStudentQuestionId).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      isCorrect: true, method: 'exact', setCompleted: true, remainingCount: 0,
    });
    expect(res.points).toEqual(expect.objectContaining({ pointsAwarded: 3 }));
  });

  it('答错 → 不置 is_correct、不入错题本、仍首答发分（不看对错）', async () => {
    const { service, remediationRepo, judgeCore, pointsService, mainErrorRepo } = harness();
    remediationRepo.findItemsBySet.mockResolvedValue([makeItem({ id: ITEM_ID, is_correct: 0 })]);
    judgeCore.judgeQuestion.mockResolvedValue({ isCorrect: false, method: 'ai', errorType: 'logic' });

    const res = await service.submitAnswer(STUDENT_ID, { questionId: QUESTION_ID, studentAnswer: 'A' });

    expect(remediationRepo.markItemCorrect).not.toHaveBeenCalled();
    expect(remediationRepo.deleteSet).not.toHaveBeenCalled();
    expect(pointsService.award).toHaveBeenCalledTimes(1);
    expect(mainErrorRepo.findUnclearedByStudentQuestionId).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      isCorrect: false, method: 'ai', errorType: 'logic', setCompleted: false, remainingCount: 1,
    });
  });

  it('发分顺序：award 成功之后才置 points_awarded（防「抖动即永久丢分」）', async () => {
    const { service, remediationRepo, judgeCore, pointsService } = harness();
    judgeCore.judgeQuestion.mockResolvedValue({ isCorrect: false, method: 'ai' });

    await service.submitAnswer(STUDENT_ID, { questionId: QUESTION_ID, studentAnswer: 'A' });

    expect(pointsService.award).toHaveBeenCalledTimes(1);
    expect(remediationRepo.markPointsAwarded).toHaveBeenCalledWith(ITEM_ID);
    const awardOrder = pointsService.award.mock.invocationCallOrder[0];
    const markOrder = remediationRepo.markPointsAwarded.mock.invocationCallOrder[0];
    expect(awardOrder).toBeLessThan(markOrder);
  });

  it('award 抛错 → 只 warn、不置标记（下次仍会尝试，dedupeKey 幂等兜底）、提交仍返回判题结果', async () => {
    const { service, remediationRepo, judgeCore, pointsService } = harness();
    judgeCore.judgeQuestion.mockResolvedValue({ isCorrect: false, method: 'ai' });
    pointsService.award.mockRejectedValue(new Error('db down'));

    const res = await service.submitAnswer(STUDENT_ID, { questionId: QUESTION_ID, studentAnswer: 'A' });

    expect(remediationRepo.markPointsAwarded).not.toHaveBeenCalled();
    expect(res.points).toBeNull();
    expect(res.isCorrect).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('remediation award failed'));
  });

  it('markPointsAwarded 抛错 → 只 warn、不阻断判题（points 仍随响应返回）', async () => {
    const { service, remediationRepo, judgeCore } = harness();
    judgeCore.judgeQuestion.mockResolvedValue({ isCorrect: false, method: 'ai' });
    remediationRepo.markPointsAwarded.mockRejectedValue(new Error('db down'));

    const res = await service.submitAnswer(STUDENT_ID, { questionId: QUESTION_ID, studentAnswer: 'A' });

    expect(res.points).toEqual(expect.objectContaining({ pointsAwarded: 3 }));
    expect(res.isCorrect).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('remediation award failed'));
  });

  it('已发过分的题（points_awarded=1）不再 award、也不再置标记', async () => {
    const { service, remediationRepo, judgeCore, pointsService } = harness();
    remediationRepo.findItemBySetQuestion.mockResolvedValue(makeItem({ points_awarded: 1 }));
    judgeCore.judgeQuestion.mockResolvedValue({ isCorrect: false, method: 'ai' });

    const res = await service.submitAnswer(STUDENT_ID, { questionId: QUESTION_ID, studentAnswer: 'A' });

    expect(pointsService.award).not.toHaveBeenCalled();
    expect(remediationRepo.markPointsAwarded).not.toHaveBeenCalled();
    expect(res.points).toBeNull();
  });

  it('题已下线（findById 返回 null）→ 不发分也不置标记，判题结果照常返回', async () => {
    const { service, remediationRepo, questionsRepo, judgeCore, pointsService } = harness();
    questionsRepo.findById.mockResolvedValue(null);
    judgeCore.judgeQuestion.mockResolvedValue({ isCorrect: false, method: 'ai' });

    const res = await service.submitAnswer(STUDENT_ID, { questionId: QUESTION_ID, studentAnswer: 'A' });

    expect(pointsService.award).not.toHaveBeenCalled();
    expect(remediationRepo.markPointsAwarded).not.toHaveBeenCalled();
    expect(res.points).toBeNull();
  });

  it.each([
    ['choice', 'choice'],
    ['true_false', 'choice'],
    ['fill_blank', 'fill_blank'],
    ['calculation', 'major'],
    ['proof', 'major'],
    ['short_answer', 'major'],
  ])('题型映射：%s → 档位 %s（spec §7）', async (type, tierKey) => {
    const { service, questionsRepo, judgeCore, pointsService } = harness();
    questionsRepo.findById.mockResolvedValue(makeQuestion({ type }));
    judgeCore.judgeQuestion.mockResolvedValue({ isCorrect: false, method: 'ai' });

    await service.submitAnswer(STUDENT_ID, { questionId: QUESTION_ID, studentAnswer: 'x' });

    expect(pointsService.award).toHaveBeenCalledWith(expect.objectContaining({ tierKey }));
  });

  it('没有进行中的套题 → BadRequest', async () => {
    const { service, remediationRepo } = harness();
    remediationRepo.findActiveByStudent.mockResolvedValue(null);
    await expect(service.submitAnswer(STUDENT_ID, { questionId: QUESTION_ID, studentAnswer: 'A' }))
      .rejects.toThrow('当前没有进行中的相似题专项练习');
  });

  it('题不在当前套题中 → BadRequest', async () => {
    const { service, remediationRepo, judgeCore } = harness();
    remediationRepo.findItemBySetQuestion.mockResolvedValue(null);
    await expect(service.submitAnswer(STUDENT_ID, { questionId: QUESTION_ID, studentAnswer: 'A' }))
      .rejects.toThrow('该题不在当前套题中');
    expect(judgeCore.judgeQuestion).not.toHaveBeenCalled();
  });

  it('该题已答对 → BadRequest（不重复判题、不重复发分）', async () => {
    const { service, remediationRepo, judgeCore, pointsService } = harness();
    remediationRepo.findItemBySetQuestion.mockResolvedValue(makeItem({ is_correct: 1 }));
    await expect(service.submitAnswer(STUDENT_ID, { questionId: QUESTION_ID, studentAnswer: 'A' }))
      .rejects.toThrow('该题已答对，无需重复作答');
    expect(judgeCore.judgeQuestion).not.toHaveBeenCalled();
    expect(pointsService.award).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// selfAssess —— 钉住「不经 judgeCore」（Task 4 复核遗留裁决的可执行证据）
// ---------------------------------------------------------------------------

describe('selfAssess', () => {
  it('自评「会做」→ 置 is_correct + 全对清套，且**不调用 judgeCore.judgeQuestion**（不入错题本/不清零/不发 error_fix）', async () => {
    const { service, remediationRepo, judgeCore, pointsService, mainErrorRepo } = harness();
    remediationRepo.findItemsBySet.mockResolvedValue([makeItem({ id: ITEM_ID, is_correct: 1 })]);

    const res = await service.selfAssess(STUDENT_ID, { questionId: QUESTION_ID, assessment: 'correct' });

    // 裁决钉子：套题内主观题自评直接走 requireItem + applyOutcome，不经过判题核心
    expect(judgeCore.judgeQuestion).not.toHaveBeenCalled();
    expect(remediationRepo.markItemCorrect).toHaveBeenCalledWith(ITEM_ID);
    expect(remediationRepo.deleteSet).toHaveBeenCalledWith(SET_ID);
    expect(pointsService.award).toHaveBeenCalledWith(expect.objectContaining({ taskCode: 'remediation_question' }));
    expect(mainErrorRepo.findUnclearedByStudentQuestionId).not.toHaveBeenCalled();
    expect(res).toMatchObject({ isCorrect: true, method: 'self_assess', setCompleted: true, remainingCount: 0 });
  });

  it('自评「不会」→ 不置 is_correct、仍首答发分、不调 judgeCore', async () => {
    const { service, remediationRepo, judgeCore, pointsService } = harness();
    remediationRepo.findItemsBySet.mockResolvedValue([makeItem({ id: ITEM_ID, is_correct: 0 })]);

    const res = await service.selfAssess(STUDENT_ID, { questionId: QUESTION_ID, assessment: 'incorrect' });

    expect(judgeCore.judgeQuestion).not.toHaveBeenCalled();
    expect(remediationRepo.markItemCorrect).not.toHaveBeenCalled();
    expect(remediationRepo.deleteSet).not.toHaveBeenCalled();
    expect(pointsService.award).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ isCorrect: false, method: 'self_assess', setCompleted: false, remainingCount: 1 });
  });

  it('没有进行中的套题 → BadRequest', async () => {
    const { service, remediationRepo, judgeCore } = harness();
    remediationRepo.findActiveByStudent.mockResolvedValue(null);
    await expect(service.selfAssess(STUDENT_ID, { questionId: QUESTION_ID, assessment: 'correct' }))
      .rejects.toThrow('当前没有进行中的相似题专项练习');
    expect(judgeCore.judgeQuestion).not.toHaveBeenCalled();
  });
});
