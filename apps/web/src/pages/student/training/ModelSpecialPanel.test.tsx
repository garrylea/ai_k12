import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ModelSpecialPanel, type ModelSpecialPanelProps } from './ModelSpecialPanel';
import type { PointRuleTier, TrainingModelSpecial } from '@/services/api';

afterEach(cleanup);

const SPECIAL: TrainingModelSpecial = {
  category: 'geometry_synthesis',
  categoryName: '几何综合',
  model: 'median_doubling',
  modelName: '倍长中线',
  questionCount: 2,
};

function tier(key: string, label: string, points: number): PointRuleTier {
  return {
    tierKey: key, tierLabel: label, points,
    dailyLimit: null, completedToday: null, remainingToday: null, isActive: true,
  };
}

function props(over: Partial<ModelSpecialPanelProps> = {}): ModelSpecialPanelProps {
  return {
    special: SPECIAL,
    status: 'ok',
    error: null,
    tiers: [tier('1', '1 题', 2), tier('2', '2 题', 5)],
    eligibleTiers: [tier('1', '1 题', 2), tier('2', '2 题', 5)],
    tierKey: '2',
    starting: false,
    startError: null,
    emptyHint: false,
    tiersError: null,
    onRetry: vi.fn(),
    onRetryTiers: vi.fn(),
    onSelectTier: vi.fn(),
    onStart: vi.fn(),
    ...over,
  };
}

describe('ModelSpecialPanel', () => {
  it('渲染倍长中线、题量与 1/2 档，点击开练', () => {
    const p = props();
    render(<ModelSpecialPanel {...p} />);
    expect(screen.getByText('倍长中线')).toBeTruthy();
    expect(screen.getByText('几何综合 · 微专题')).toBeTruthy();
    expect(screen.getByText('可练 2 题')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^2 题/ }));
    expect(p.onSelectTier).toHaveBeenCalledWith('2');
    fireEvent.click(screen.getByRole('button', { name: '开始练习' }));
    expect(p.onStart).toHaveBeenCalled();
  });

  it('没有 1/2 档：显示家长提示并禁用', () => {
    const p = props({ eligibleTiers: [], tierKey: null });
    render(<ModelSpecialPanel {...p} />);
    expect(screen.getByText('家长未开启 1 或 2 题档位，暂不能开练。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '开始练习' })).toBeDisabled();
  });

  it('可练 0 题：显示暂无可练题目', () => {
    render(<ModelSpecialPanel {...props({ special: { ...SPECIAL, questionCount: 0 }, eligibleTiers: [], tierKey: null })} />);
    expect(screen.getByText('暂无可练题目。')).toBeTruthy();
  });
});
