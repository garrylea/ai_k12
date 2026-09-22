import { describe, it, expect, vi } from 'vitest';
import { RemediationController } from './remediation.controller.js';

/** 造一个只关心入参校验的 controller：服务方法全部 mock，断言「非法入参在触达服务之前就被 400 拦下」。 */
function makeCtrl() {
  const service = {
    generate: vi.fn(),
    getOverview: vi.fn(),
    listQuestions: vi.fn(),
    submitAnswer: vi.fn(),
    selfAssess: vi.fn(),
  };
  return { ctrl: new RemediationController(service as any), service };
}

const user = { sub: 7 } as any;

describe('RemediationController.generate', () => {
  it('source 不在白名单时 400', async () => {
    const { ctrl, service } = makeCtrl();
    await expect(ctrl.generate({ source: 'wrong' as any, sessionId: 1 }, user)).rejects.toThrow('source 仅允许');
    expect(service.generate).not.toHaveBeenCalled();
  });

  it('sessionId 非正整数时 400', async () => {
    const { ctrl, service } = makeCtrl();
    await expect(ctrl.generate({ source: 'exam', sessionId: 0 }, user)).rejects.toThrow('sessionId 非法');
    await expect(ctrl.generate({ source: 'exam', sessionId: 1.5 }, user)).rejects.toThrow('sessionId 非法');
    expect(service.generate).not.toHaveBeenCalled();
  });

  it('targeted 缺 wrongQuestionIds 或超限或含非法题号时 400', async () => {
    const { ctrl, service } = makeCtrl();
    await expect(ctrl.generate({ source: 'targeted', sessionId: 1 }, user)).rejects.toThrow('wrongQuestionIds');
    await expect(ctrl.generate({ source: 'targeted', sessionId: 1, wrongQuestionIds: [] }, user)).rejects.toThrow('wrongQuestionIds');
    await expect(ctrl.generate({ source: 'targeted', sessionId: 1, wrongQuestionIds: [0] }, user)).rejects.toThrow('非法题号');
    await expect(
      ctrl.generate({ source: 'targeted', sessionId: 1, wrongQuestionIds: Array.from({ length: 51 }, (_, i) => i + 1) }, user),
    ).rejects.toThrow('最多 50 题');
    expect(service.generate).not.toHaveBeenCalled();
  });

  it('exam 合法入参透传给服务（studentId 取 JWT sub）', async () => {
    const { ctrl, service } = makeCtrl();
    service.generate.mockResolvedValue({ setId: 1 });
    const dto = { source: 'exam' as const, sessionId: 3 };
    await expect(ctrl.generate(dto, user)).resolves.toEqual({ setId: 1 });
    expect(service.generate).toHaveBeenCalledWith(7, dto);
  });

  it('targeted 合法入参透传（含 wrongQuestionIds）', async () => {
    const { ctrl, service } = makeCtrl();
    service.generate.mockResolvedValue({ setId: 0 });
    const dto = { source: 'targeted' as const, sessionId: 3, wrongQuestionIds: [1, 2] };
    await ctrl.generate(dto, user);
    expect(service.generate).toHaveBeenCalledWith(7, dto);
  });
});

describe('RemediationController.me / questions', () => {
  it('me 用 JWT sub 调 getOverview', async () => {
    const { ctrl, service } = makeCtrl();
    service.getOverview.mockResolvedValue({ active: false });
    await expect(ctrl.me(user)).resolves.toEqual({ active: false });
    expect(service.getOverview).toHaveBeenCalledWith(7);
  });

  it('questions 用 JWT sub 调 listQuestions', async () => {
    const { ctrl, service } = makeCtrl();
    service.listQuestions.mockResolvedValue({ questions: [] });
    await ctrl.questions(user);
    expect(service.listQuestions).toHaveBeenCalledWith(7);
  });
});

describe('RemediationController.answer', () => {
  it('questionId 非正整数或 studentAnswer 非 string 时 400', async () => {
    const { ctrl, service } = makeCtrl();
    await expect(ctrl.answer({ questionId: 0, studentAnswer: 'x' }, user)).rejects.toThrow('questionId 非法');
    await expect(ctrl.answer({ questionId: 1, studentAnswer: 123 as any }, user)).rejects.toThrow('studentAnswer 非法');
    expect(service.submitAnswer).not.toHaveBeenCalled();
  });

  it('合法入参透传', async () => {
    const { ctrl, service } = makeCtrl();
    service.submitAnswer.mockResolvedValue({ isCorrect: true });
    const dto = { questionId: 5, studentAnswer: '2' };
    await ctrl.answer(dto, user);
    expect(service.submitAnswer).toHaveBeenCalledWith(7, dto);
  });
});

describe('RemediationController.selfAssess', () => {
  it('questionId 非法或 assessment 不在白名单时 400', async () => {
    const { ctrl, service } = makeCtrl();
    await expect(ctrl.selfAssess({ questionId: -1, assessment: 'correct' }, user)).rejects.toThrow('questionId 非法');
    await expect(ctrl.selfAssess({ questionId: 1, assessment: 'maybe' as any }, user)).rejects.toThrow('assessment 仅允许');
    expect(service.selfAssess).not.toHaveBeenCalled();
  });

  it('合法入参透传', async () => {
    const { ctrl, service } = makeCtrl();
    service.selfAssess.mockResolvedValue({ isCorrect: true });
    const dto = { questionId: 5, assessment: 'correct' as const };
    await ctrl.selfAssess(dto, user);
    expect(service.selfAssess).toHaveBeenCalledWith(7, dto);
  });
});
