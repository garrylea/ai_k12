import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CleanupPhase } from './CleanupPhase';
import { judgePractice, type JudgeResult, type PreviousErrorDetail } from '@/services/api';
import { usePointsStore } from '@/store/pointsStore';

/**
 * 错题清零阶段的发分可见性（终审修复 Finding 1）。
 *
 * 主线清零是 `error_fix` 的第二个入口（spec §6.5）：后端在 judge 响应里回带
 * `pointsAwarded` / `awardReason`。本组件必须把这两个字段交给共享决策表——
 * 之前只 `return judgePractice(...)` 就丢掉了，学生清掉错题、账本 +3，界面却毫无动静。
 *
 * 这里把 `QuestionRunner` 换成最小桩：本用例的被测对象是 CleanupPhase 的接线，
 * 不是答题核心（后者有自己的测试）。
 *
 * vitest globals:false —— 必须显式 import + 自己写 afterEach(cleanup)。
 */
vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    judgePractice: vi.fn(),
    bumpErrorLevels: vi.fn(),
    getTrainingExplanations: vi.fn(),
    selfAssessPractice: vi.fn(),
    waitTrainingExplanation: vi.fn(),
  };
});

vi.mock('./answer/QuestionRunner', () => ({
  QuestionRunner: ({
    onSubmit,
  }: {
    onSubmit: (q: { n: string; text: string }, answer: string) => Promise<unknown>;
  }) => (
    <button type="button" onClick={() => void onSubmit({ n: '1', text: '题面' }, '我的答案')}>
      提交
    </button>
  ),
}));

const judgePracticeMock = vi.mocked(judgePractice);

const ERROR: PreviousErrorDetail = {
  errorBookId: 1,
  cardId: 10,
  questionN: '1',
  questionText: '题面',
  questionId: 100,
  lessonId: 7,
};

function renderPhase() {
  return render(
    <CleanupPhase errors={[ERROR]} lessonId={7} subjectId={3} onComplete={() => {}} />,
  );
}

afterEach(() => {
  cleanup();
  usePointsStore.setState({ queue: [], revision: 0 });
});

beforeEach(() => {
  judgePracticeMock.mockReset();
  usePointsStore.setState({ queue: [], revision: 0 });
});

describe('CleanupPhase 发分反馈', () => {
  it('清零判题带 pointsAwarded > 0 → 弹「错题订正」轻反馈（不再静默吞掉）', async () => {
    judgePracticeMock.mockResolvedValue({
      questionId: 100,
      isCorrect: true,
      method: 'exact',
      pointsAwarded: 3,
    });

    renderPhase();
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    await waitFor(() => expect(usePointsStore.getState().queue).toHaveLength(1));
    expect(usePointsStore.getState().queue[0]).toMatchObject({ points: 3, title: '错题订正' });
  });

  it('判题回 0 分且无 reason（本无未清错题 / 幂等命中）→ 静默，不弹「已达上限」假文案', async () => {
    const result: JudgeResult = {
      questionId: 100,
      isCorrect: true,
      method: 'exact',
      pointsAwarded: 0,
      awardReason: 'not_cleared',
    };
    judgePracticeMock.mockResolvedValue(result);

    renderPhase();
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    await waitFor(() => expect(judgePracticeMock).toHaveBeenCalledTimes(1));
    expect(usePointsStore.getState().queue).toHaveLength(0);
  });

  it('判题回 0 分 + daily_limit → 弹中性「已达上限」文案（决策表原样生效）', async () => {
    judgePracticeMock.mockResolvedValue({
      questionId: 100,
      isCorrect: true,
      method: 'exact',
      pointsAwarded: 0,
      awardReason: 'daily_limit',
    });

    renderPhase();
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    await waitFor(() => expect(usePointsStore.getState().queue).toHaveLength(1));
    expect(usePointsStore.getState().queue[0]).toMatchObject({ points: 0, title: '错题订正' });
  });
});
