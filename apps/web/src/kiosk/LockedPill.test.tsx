import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { LockedPill } from './LockedPill';

afterEach(() => cleanup());

describe('LockedPill', () => {
  it('渲染剩余分钟数', () => {
    render(<LockedPill remainingMs={42 * 60_000} visible />);
    expect(screen.getByTestId('locked-pill')).toHaveTextContent('剩余 42 分钟');
  });

  it('不足一分钟时也给文案，不显示 0 或负数', () => {
    render(<LockedPill remainingMs={5_000} visible />);
    expect(screen.getByTestId('locked-pill')).toHaveTextContent('剩余不足 1 分钟');
    expect(screen.getByTestId('locked-pill')).not.toHaveTextContent('-');
  });

  it('说明这是家长设定的时长，避免学生以为是卡顿', () => {
    render(<LockedPill remainingMs={30 * 60_000} visible />);
    expect(screen.getByTestId('locked-pill')).toHaveTextContent('本次学习时长未满');
  });

  it('收起时视觉隐藏但不占点击（data-visible=false + pointer-events-none）', () => {
    render(<LockedPill remainingMs={30 * 60_000} visible={false} />);
    const pill = screen.getByTestId('locked-pill');
    expect(pill).toHaveAttribute('data-visible', 'false');
    expect(pill.className).toContain('opacity-0');
    expect(pill.className).toContain('pointer-events-none');
  });

  it('显示时位于顶栏下方（top-[72px] = 64px 顶栏 + 8px）', () => {
    render(<LockedPill remainingMs={30 * 60_000} visible />);
    expect(screen.getByTestId('locked-pill').className).toContain('top-[72px]');
  });
});
