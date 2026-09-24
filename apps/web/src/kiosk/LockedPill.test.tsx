import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { LockedPill } from './LockedPill';

afterEach(() => cleanup());

describe('LockedPill', () => {
  it('渲染剩余分钟数', () => {
    render(<LockedPill remainingMs={42 * 60_000} />);
    expect(screen.getByTestId('locked-pill')).toHaveTextContent('剩余 42 分钟');
  });

  it('不足一分钟时也给文案，不显示 0 或负数', () => {
    render(<LockedPill remainingMs={5_000} />);
    expect(screen.getByTestId('locked-pill')).toHaveTextContent('剩余不足 1 分钟');
    expect(screen.getByTestId('locked-pill')).not.toHaveTextContent('-');
  });

  it('说明这是家长设定的时长，避免学生以为是卡顿', () => {
    render(<LockedPill remainingMs={30 * 60_000} />);
    expect(screen.getByTestId('locked-pill')).toHaveTextContent('本次学习时长未满');
  });
});
