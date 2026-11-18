import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PaperPositionPanel, type PaperPositionPanelProps } from './PaperPositionPanel';
import type { PointRuleTier, TrainingPaperPositionOption } from '@/services/api';

afterEach(cleanup);

const OPTIONS: TrainingPaperPositionOption[] = [
  { grade: '初三', semester: 'first', paperCount: 7, typicalQuestionCount: 28 },
  { grade: '初三', semester: 'second', paperCount: 12, typicalQuestionCount: 28 },
];

function tier(key: string, label: string, points: number): PointRuleTier {
  return {
    tierKey: key, tierLabel: label, points,
    dailyLimit: null, completedToday: null, remainingToday: null, isActive: true,
  };
}

function props(over: Partial<PaperPositionPanelProps> = {}): PaperPositionPanelProps {
  return {
    options: OPTIONS,
    optionsStatus: 'ok',
    optionsError: null,
    grade: '初三',
    semester: 'first',
    onSelectGrade: vi.fn(),
    onSelectSemester: vi.fn(),
    positionsStatus: 'ok',
    positionsError: null,
    positions: [
      { questionNo: 1, total: 5, wrongCount: 2, untriedCount: 3 },
      { questionNo: 24, total: 6, wrongCount: 1, untriedCount: 4 },
      { questionNo: 25, total: 6, wrongCount: 0, untriedCount: 0 },
    ],
    typicalQuestionCount: 28,
    selectedQuestionNo: 24,
    onSelectQuestionNo: vi.fn(),
    tiers: [tier('1', '1 题', 2), tier('3', '3 题', 8), tier('5', '5 题', 15)],
    tiersError: null,
    eligibleTiers: [tier('1', '1 题', 2), tier('3', '3 题', 8), tier('5', '5 题', 15)],
    tierKey: '3',
    starting: false,
    startError: null,
    emptyHint: false,
    onRetryOptions: vi.fn(),
    onRetryPositions: vi.fn(),
    onRetryTiers: vi.fn(),
    onSelectTier: vi.fn(),
    onStart: vi.fn(),
    ...over,
  };
}

describe('PaperPositionPanel', () => {
  it('渲染年级/学期/共 28 题/可练数，点题号与档位', () => {
    const p = props();
    render(<PaperPositionPanel {...p} />);
    expect(screen.getByLabelText('年级')).toHaveValue('初三');
    expect(screen.getByLabelText('学期')).toHaveValue('first');
    expect(screen.getByText('共 28 题')).toBeTruthy();
    expect(screen.getByRole('button', { name: '第1题，可练5题' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '第1题，可练5题' }));
    expect(p.onSelectQuestionNo).toHaveBeenCalledWith(1);

    fireEvent.click(screen.getByRole('button', { name: /^3 题/ }));
    expect(p.onSelectTier).toHaveBeenCalledWith('3');
    fireEvent.click(screen.getByRole('button', { name: '开始练习' }));
    expect(p.onStart).toHaveBeenCalled();
  });

  it('可练 0 的题号禁用', () => {
    render(<PaperPositionPanel {...props()} />);
    expect(screen.getByRole('button', { name: '第25题，可练0题' })).toBeDisabled();
  });

  it('无可用试卷 / 无可练题 / 无档位三种空态', () => {
    const { rerender } = render(<PaperPositionPanel {...props({ options: [] })} />);
    expect(screen.getByText('暂无可用试卷。')).toBeTruthy();
    rerender(<PaperPositionPanel {...props({ positions: [] })} />);
    expect(screen.getByText('该年级学期暂无可练题目。')).toBeTruthy();
    rerender(<PaperPositionPanel {...props({ eligibleTiers: [], tierKey: null })} />);
    expect(screen.getByText('家长未开启可用题量档位，暂不能开练。')).toBeTruthy();
  });

  it('未选题号：开始禁用并提示', () => {
    render(<PaperPositionPanel {...props({ selectedQuestionNo: null, eligibleTiers: [], tierKey: null })} />);
    expect(screen.getByText('请先选择题号')).toBeTruthy();
    expect(screen.getByRole('button', { name: '开始练习' })).toBeDisabled();
  });

  it('选项加载失败：固定文案 + 重试', () => {
    const p = props({ optionsStatus: 'error', optionsError: '试卷题号加载失败' });
    render(<PaperPositionPanel {...p} />);
    expect(screen.getByText('试卷题号加载失败')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(p.onRetryOptions).toHaveBeenCalled();
  });
});
