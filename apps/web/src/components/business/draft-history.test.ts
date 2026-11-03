import { describe, it, expect, beforeEach } from 'vitest';
import {
  initHistory, pushState, undo, redo, canUndo, canRedo, clearHistory, getHistory,
} from './draft-history';
import type { Stroke } from './draft-store';
import { setDraft, getDraft, clearDraft } from './draft-store';

const stroke = (x: number): Stroke => ({ points: [{ x, y: 0, pressure: 0.5 }], size: 2 });
const st = (n: number) => ({ strokes: [stroke(n)], images: [] });

beforeEach(() => { clearHistory('k'); });

describe('draft-history', () => {
  it('初始态不能撤销/重做', () => {
    initHistory('k', st(0));
    expect(canUndo('k')).toBe(false);
    expect(canRedo('k')).toBe(false);
    expect(undo('k')).toBeNull();
  });

  it('push 后撤销回上一步，重做回来', () => {
    initHistory('k', st(0));
    expect(pushState('k', st(1))).toBe(true);
    expect(pushState('k', st(2))).toBe(true);
    expect(undo('k')!.strokes[0].points[0].x).toBe(1);
    expect(undo('k')!.strokes[0].points[0].x).toBe(0);
    expect(redo('k')!.strokes[0].points[0].x).toBe(1);
  });

  it('内容没变（数组元素引用全同）时不入栈', () => {
    const a = st(0);
    initHistory('k', a);
    expect(pushState('k', { strokes: [...a.strokes], images: [...a.images] })).toBe(false);
    expect(canUndo('k')).toBe(false);
  });

  it('撤销后再 push 会截断重做栈', () => {
    initHistory('k', st(0));
    pushState('k', st(1));
    pushState('k', st(2));
    undo('k');
    expect(canRedo('k')).toBe(true);
    pushState('k', st(3));
    expect(canRedo('k')).toBe(false);
    expect(getHistory('k')!.states).toHaveLength(3);
  });

  it('超过 51 个状态时丢最旧', () => {
    initHistory('k', st(0));
    for (let i = 1; i <= 60; i++) pushState('k', st(i));
    const h = getHistory('k')!;
    expect(h.states).toHaveLength(51);
    expect(h.index).toBe(50);
  });

  it('clearDraft 连历史一起清', () => {
    initHistory('k', st(0));
    pushState('k', st(1));
    setDraft('k', [stroke(1)]);
    clearDraft('k');
    expect(getDraft('k')).toEqual([]);
    expect(canUndo('k')).toBe(false);
  });
});
