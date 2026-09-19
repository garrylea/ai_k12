import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useLearnContextStore } from './learnContextStore';

beforeEach(() => {
  useLearnContextStore.setState({ subjectId: null, subjectName: null, gradeName: null, publisher: null });
});

describe('learnContextStore', () => {
  it('setContext 一并存下 subjectId（埋点上报需要数字学科 id，不是名字）', () => {
    useLearnContextStore.getState().setContext({
      subjectId: 7,
      subjectName: '数学',
      gradeName: '七年级上',
      publisher: '人教版',
    });
    const s = useLearnContextStore.getState();
    expect(s.subjectId).toBe(7);
    expect(s.subjectName).toBe('数学');
  });

  it('未选学科时初始值是 null（不是 0）——0 会被服务端当成非法学科', async () => {
    // 必须拿一个**全新的模块实例**来观察初始值：beforeEach 的 setState 会把这个字段
    // 直接写进去（Zustand 合并未声明的键），在同一个实例上断言只会断言到 beforeEach 自己。
    // 初始值若被改成 0（服务端会当成非法学科），这条必须红。
    vi.resetModules();
    const fresh = await import('./learnContextStore');
    expect(fresh.useLearnContextStore.getState().subjectId).toBeNull();
  });
});
