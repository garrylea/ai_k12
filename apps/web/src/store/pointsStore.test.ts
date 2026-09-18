import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { usePointsStore } from './pointsStore';

/**
 * `pointsStore.revision`——展示层据此重拉积分余额的单调版本号。
 *
 * 铁律：**只增不减**。`dismiss` 清掉 toast 不能把它减回去，否则「队列空了就重拉」
 * 会在发分后立刻归零，`UserBadge` 反而永远收不到变化。
 */

beforeEach(() => {
  usePointsStore.setState({ queue: [], revision: 0 });
});

afterEach(() => {
  usePointsStore.setState({ queue: [], revision: 0 });
});

describe('pointsStore.revision', () => {
  it('初值为 0', () => {
    expect(usePointsStore.getState().revision).toBe(0);
  });

  it('每次 push 单调 +1', () => {
    usePointsStore.getState().push({ points: 10, title: '本节学习完成' });
    expect(usePointsStore.getState().revision).toBe(1);

    usePointsStore.getState().push({ points: 0, title: '已达上限' });
    expect(usePointsStore.getState().revision).toBe(2);
  });

  it('bumpRevision 只递增版本号、不入队（发分无 toast 路径用）', () => {
    usePointsStore.getState().bumpRevision();

    expect(usePointsStore.getState().revision).toBe(1);
    expect(usePointsStore.getState().queue).toHaveLength(0);
  });

  it('dismiss 不改 revision（不能用 queue.length 代替）', () => {
    usePointsStore.getState().push({ points: 10, title: '本节学习完成' });
    const id = usePointsStore.getState().queue[0].id;

    usePointsStore.getState().dismiss(id);

    expect(usePointsStore.getState().queue).toHaveLength(0);
    expect(usePointsStore.getState().revision).toBe(1);
  });
});
