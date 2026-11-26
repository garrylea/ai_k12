/**
 * SelfAssessmentSettlementService（首次提交默认错 + 单连接事务）单元测试。
 *
 * 钉住的铁律：
 * 1. 首次提交在一个 PoolConnection 上完成：beginTransaction → 写会话/作答0/default_incorrect/
 *    错题本/掌握度 error+1 → commit；任何一步抛错 rollback 并原样冒泡，release 总执行。
 * 2. 事务内可传 executor 的仓储调用一律传 conn（upsertSession/findForUpdate/
 *    insertDefaultIncorrect/findOrCreateUncleared/upsertOnJudge）。
 * 3. 不写自评留痕（selfAssess.create 永不调用）。
 * 4. 重复提交同答案幂等：不重复 error+1、不重复建错题本，errorBookId 从既有未清错题取（无则 0）。
 * 5. 同一作答行不同答案/已确认状态：409 + rollback。
 */
import { describe, it, expect, vi } from 'vitest';
import { SelfAssessmentSettlementService } from './self-assessment-settlement.service.js';

function mkSettlement() {
  const conn = {
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
  };
  const pool = { getConnection: vi.fn().mockResolvedValue(conn) };
  const mocks = {
    sessions: {
      upsertSession: vi.fn().mockResolvedValue(101),
      findIdByUid: vi.fn().mockResolvedValue(101),
    },
    answers: {
      findForUpdate: vi.fn().mockResolvedValue(null),
      insertDefaultIncorrect: vi.fn().mockResolvedValue(undefined),
      transitionState: vi.fn().mockResolvedValue(undefined),
    },
    errorBooks: {
      findOrCreateUncleared: vi.fn().mockResolvedValue(202),
      findUnclearedByStudentQuestionId: vi.fn().mockResolvedValue({ id: 202 }),
      clearUnclearedByStudentQuestionId: vi.fn().mockResolvedValue(1),
    },
    questions: { findKnowledgePointIdsByQuestion: vi.fn().mockResolvedValue([7, 8]) },
    mastery: {
      upsertOnJudge: vi.fn().mockResolvedValue(undefined),
      revertOneError: vi.fn().mockResolvedValue(1),
    },
    selfAssess: { create: vi.fn().mockResolvedValue(1) },
    // 结算刻意不发 error_fix 积分；注入守卫确保任何分支都不会误调用 award。
    points: { award: vi.fn().mockResolvedValue({ pointsAwarded: 0 }) },
    events: { track: vi.fn() },
  };
  const svc = new SelfAssessmentSettlementService(
    pool as any,
    mocks.sessions as any,
    mocks.answers as any,
    mocks.errorBooks as any,
    mocks.questions as any,
    mocks.mastery as any,
    mocks.selfAssess as any,
    mocks.events as any,
    mocks.points as any,
  );
  const input = {
    studentId: 2,
    subjectId: 1,
    questionId: 5034,
    answerText: '解',
    source: 'targeted' as const,
    sessionUid: 'u-1',
    session: { module: 'math_targeted' as const, title: '数学专项', questionCount: 3 },
    questionOrder: 1,
  };
  return { svc, conn, pool, mocks, input };
}

describe('self-assessment settlement: SelfAssessmentSettlementService.submitDefaultIncorrect', () => {
  it('首次提交：同事务写会话/作答0/default_incorrect/错题本/掌握度error+1，且不写自评留痕', async () => {
    const { svc, conn, pool, mocks, input } = mkSettlement();
    const r = await svc.submitDefaultIncorrect(input);

    expect(pool.getConnection).toHaveBeenCalled();
    expect(conn.beginTransaction).toHaveBeenCalled();
    expect(conn.commit).toHaveBeenCalled();
    expect(conn.rollback).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();

    expect(mocks.sessions.upsertSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionUid: 'u-1', studentId: 2, subjectId: 1, module: 'math_targeted', questionCount: 3,
    }), conn);
    expect(mocks.answers.findForUpdate).toHaveBeenCalledWith(101, 5034, conn);
    expect(mocks.answers.insertDefaultIncorrect).toHaveBeenCalledWith({
      sessionId: 101, questionId: 5034, questionOrder: 1, answerText: '解', method: 'self_assess',
    }, conn);
    expect(mocks.errorBooks.findOrCreateUncleared).toHaveBeenCalledWith({
      studentId: 2, subjectId: 1, questionId: 5034, source: 'targeted', sourceRefId: null,
    }, conn);
    // 每题挂到两个 KP，逐 KP error+1，且全部在同一连接上
    expect(mocks.mastery.upsertOnJudge).toHaveBeenCalledTimes(2);
    expect(mocks.mastery.upsertOnJudge).toHaveBeenCalledWith(2, 7, false, conn);
    expect(mocks.mastery.upsertOnJudge).toHaveBeenCalledWith(2, 8, false, conn);

    expect(mocks.selfAssess.create).not.toHaveBeenCalled();
    expect(r).toEqual({ sessionId: 101, errorBookId: 202 });
  });

  it('重复提交同答案：幂等，不重复 error+1/错题本，并从既有未清错题取 errorBookId', async () => {
    const { svc, conn, mocks, input } = mkSettlement();
    mocks.answers.findForUpdate.mockResolvedValue({
      is_correct: 0, self_assess_state: 'default_incorrect', answer_text: '解',
    });

    const r = await svc.submitDefaultIncorrect(input);

    expect(conn.beginTransaction).toHaveBeenCalled();
    expect(conn.commit).toHaveBeenCalled();
    expect(conn.rollback).not.toHaveBeenCalled();
    expect(mocks.errorBooks.findUnclearedByStudentQuestionId).toHaveBeenCalledWith(2, 5034, conn);
    expect(mocks.answers.insertDefaultIncorrect).not.toHaveBeenCalled();
    expect(mocks.errorBooks.findOrCreateUncleared).not.toHaveBeenCalled();
    expect(mocks.mastery.upsertOnJudge).not.toHaveBeenCalled();
    expect(mocks.selfAssess.create).not.toHaveBeenCalled();
    expect(r).toEqual({ sessionId: 101, errorBookId: 202 });
  });

  it('重复提交同答案但无既有未清错题：errorBookId 返回 0', async () => {
    const { svc, mocks, input } = mkSettlement();
    mocks.answers.findForUpdate.mockResolvedValue({
      is_correct: 0, self_assess_state: 'default_incorrect', answer_text: '解',
    });
    mocks.errorBooks.findUnclearedByStudentQuestionId.mockResolvedValue(null);

    const r = await svc.submitDefaultIncorrect(input);
    expect(r).toEqual({ sessionId: 101, errorBookId: 0 });
  });

  it('同一作答行不同答案：抛 409，rollback 且不写任何东西', async () => {
    const { svc, conn, mocks, input } = mkSettlement();
    mocks.answers.findForUpdate.mockResolvedValue({
      is_correct: 0, self_assess_state: 'default_incorrect', answer_text: '旧',
    });

    await expect(svc.submitDefaultIncorrect({ ...input, answerText: '新' }))
      .rejects.toMatchObject({ status: 409 });
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.commit).not.toHaveBeenCalled();
    expect(mocks.answers.insertDefaultIncorrect).not.toHaveBeenCalled();
    expect(mocks.mastery.upsertOnJudge).not.toHaveBeenCalled();
  });

  it('同一作答行已确认（confirmed_correct）：同样抛 409', async () => {
    const { svc, conn, mocks, input } = mkSettlement();
    mocks.answers.findForUpdate.mockResolvedValue({
      is_correct: 1, self_assess_state: 'confirmed_correct', answer_text: '解',
    });

    await expect(svc.submitDefaultIncorrect(input)).rejects.toMatchObject({ status: 409 });
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.commit).not.toHaveBeenCalled();
  });

  it('错题本写失败 -> rollback 并抛原错误，release 仍执行', async () => {
    const { svc, conn, mocks, input } = mkSettlement();
    mocks.errorBooks.findOrCreateUncleared.mockRejectedValueOnce(new Error('db down'));

    await expect(svc.submitDefaultIncorrect(input)).rejects.toThrow('db down');
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.commit).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();
    expect(mocks.mastery.upsertOnJudge).not.toHaveBeenCalled();
  });
});

describe('self-assessment settlement: confirmSelfAssessment correct', () => {
  const confirmInput = {
    studentId: 2, questionId: 5034, assessment: 'correct' as const,
    source: 'targeted', sessionUid: 'u-1',
  };
  const defaultRow = {
    is_correct: 0, self_assess_state: 'default_incorrect', answer_text: '解',
  };

  it('default_incorrect + correct：留痕correct+清本+revert+state=confirmed_correct+is_correct=1；不发分', async () => {
    const { svc, conn, mocks } = mkSettlement();
    mocks.answers.findForUpdate.mockResolvedValue(defaultRow);

    const r = await svc.confirmSelfAssessment(confirmInput);

    expect(mocks.sessions.findIdByUid).toHaveBeenCalledWith('u-1', 2, conn);
    expect(mocks.answers.findForUpdate).toHaveBeenCalledWith(101, 5034, conn);
    expect(mocks.selfAssess.create).toHaveBeenCalledWith(expect.objectContaining({
      studentId: 2, questionId: 5034, assessment: 'correct', source: 'targeted',
    }), conn);
    expect(mocks.errorBooks.clearUnclearedByStudentQuestionId).toHaveBeenCalledWith(2, 5034, conn);
    // 逐 KP 直接调仓储（绝不走吞异常的 MasteryService.revertErrorToCorrect），且全部走同连接
    expect(mocks.mastery.revertOneError).toHaveBeenCalledTimes(2);
    expect(mocks.mastery.revertOneError).toHaveBeenCalledWith(2, 7, conn);
    expect(mocks.mastery.revertOneError).toHaveBeenCalledWith(2, 8, conn);
    expect(mocks.answers.transitionState).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 101, questionId: 5034, state: 'confirmed_correct', isCorrect: 1, judgedAt: expect.any(Date),
    }), conn);
    expect(mocks.points.award).not.toHaveBeenCalled();
    expect(conn.beginTransaction).toHaveBeenCalled();
    expect(conn.commit).toHaveBeenCalled();
    expect(conn.rollback).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();
    expect(r).toEqual({ errorBookId: undefined });
  });

  it('confirmed_correct + correct：幂等，不重复', async () => {
    const { svc, conn, mocks } = mkSettlement();
    mocks.answers.findForUpdate.mockResolvedValue({
      is_correct: 1, self_assess_state: 'confirmed_correct', answer_text: '解',
    });

    const r = await svc.confirmSelfAssessment(confirmInput);

    expect(r.idempotent).toBe(true);
    expect(mocks.selfAssess.create).not.toHaveBeenCalled();
    expect(mocks.errorBooks.clearUnclearedByStudentQuestionId).not.toHaveBeenCalled();
    expect(mocks.mastery.revertOneError).not.toHaveBeenCalled();
    expect(mocks.answers.transitionState).not.toHaveBeenCalled();
    expect(conn.commit).toHaveBeenCalled();
    expect(conn.rollback).not.toHaveBeenCalled();
  });

  it('confirmed_incorrect + correct：409，不改任何东西', async () => {
    const { svc, conn, mocks } = mkSettlement();
    mocks.answers.findForUpdate.mockResolvedValue({
      is_correct: 0, self_assess_state: 'confirmed_incorrect', answer_text: '解',
    });

    await expect(svc.confirmSelfAssessment(confirmInput)).rejects.toMatchObject({ status: 409 });
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.commit).not.toHaveBeenCalled();
    expect(mocks.selfAssess.create).not.toHaveBeenCalled();
    expect(mocks.mastery.revertOneError).not.toHaveBeenCalled();
  });

  it('revertOneError 0 行：仍提交成功，不回滚', async () => {
    const { svc, conn, mocks } = mkSettlement();
    mocks.answers.findForUpdate.mockResolvedValue(defaultRow);
    mocks.mastery.revertOneError.mockResolvedValue(0);

    await expect(svc.confirmSelfAssessment(confirmInput)).resolves.toBeTruthy();
    expect(conn.commit).toHaveBeenCalled();
    expect(conn.rollback).not.toHaveBeenCalled();
  });

  it('revertOneError 抛错：原样冒泡 + rollback（不吞异常）', async () => {
    const { svc, conn, mocks } = mkSettlement();
    mocks.answers.findForUpdate.mockResolvedValue(defaultRow);
    mocks.mastery.revertOneError.mockRejectedValueOnce(new Error('db down'));

    await expect(svc.confirmSelfAssessment(confirmInput)).rejects.toThrow('db down');
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.commit).not.toHaveBeenCalled();
    expect(mocks.answers.transitionState).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();
  });

  it('cleared>0：提交后才发 error_book_cleared；cleared=0 不发', async () => {
    const { svc, conn, mocks } = mkSettlement();
    mocks.answers.findForUpdate.mockResolvedValue(defaultRow);

    await svc.confirmSelfAssessment(confirmInput);
    expect(mocks.events.track).toHaveBeenCalledWith(expect.objectContaining({
      event: 'error_book_cleared', source: 'server', studentId: 2,
      refType: 'question', refId: 5034,
    }));
    expect(conn.commit.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.events.track.mock.invocationCallOrder[0]);

    const second = mkSettlement();
    second.mocks.answers.findForUpdate.mockResolvedValue(defaultRow);
    second.mocks.errorBooks.clearUnclearedByStudentQuestionId.mockResolvedValue(0);
    await second.svc.confirmSelfAssessment(confirmInput);
    expect(second.mocks.events.track).not.toHaveBeenCalledWith(expect.objectContaining({
      event: 'error_book_cleared',
    }));
  });
});

describe('self-assessment settlement: confirmSelfAssessment incorrect', () => {
  const confirmInput = {
    studentId: 2, questionId: 5034, assessment: 'incorrect' as const,
    source: 'targeted', sessionUid: 'u-1',
  };
  const defaultRow = {
    is_correct: 0, self_assess_state: 'default_incorrect', answer_text: '解',
  };

  it('default_incorrect + incorrect：只追加 incorrect 留痕 + state=confirmed_incorrect，不改 is_correct/错题本/掌握度', async () => {
    const { svc, conn, mocks } = mkSettlement();
    mocks.answers.findForUpdate.mockResolvedValue(defaultRow);

    await svc.confirmSelfAssessment(confirmInput);

    expect(mocks.selfAssess.create).toHaveBeenCalledWith(expect.objectContaining({
      assessment: 'incorrect',
    }), conn);
    expect(mocks.answers.transitionState).toHaveBeenCalledWith(expect.objectContaining({
      state: 'confirmed_incorrect', isCorrect: 0,
    }), conn);
    expect(mocks.errorBooks.findOrCreateUncleared).not.toHaveBeenCalled();
    expect(mocks.mastery.upsertOnJudge).not.toHaveBeenCalled();
    expect(mocks.mastery.revertOneError).not.toHaveBeenCalled();
    expect(conn.commit).toHaveBeenCalled();
    expect(conn.rollback).not.toHaveBeenCalled();
  });

  it('confirmed_incorrect + incorrect：幂等，不重复留痕', async () => {
    const { svc, conn, mocks } = mkSettlement();
    mocks.answers.findForUpdate.mockResolvedValue({
      is_correct: 0, self_assess_state: 'confirmed_incorrect', answer_text: '解',
    });

    const r = await svc.confirmSelfAssessment(confirmInput);

    expect(r.idempotent).toBe(true);
    expect(mocks.selfAssess.create).not.toHaveBeenCalled();
    expect(conn.commit).toHaveBeenCalled();
    expect(conn.rollback).not.toHaveBeenCalled();
  });

  it('confirmed_correct + incorrect：409', async () => {
    const { svc, conn, mocks } = mkSettlement();
    mocks.answers.findForUpdate.mockResolvedValue({
      is_correct: 1, self_assess_state: 'confirmed_correct', answer_text: '解',
    });

    await expect(svc.confirmSelfAssessment(confirmInput)).rejects.toMatchObject({ status: 409 });
    expect(mocks.selfAssess.create).not.toHaveBeenCalled();
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.commit).not.toHaveBeenCalled();
  });
});
