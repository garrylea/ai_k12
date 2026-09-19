import { describe, it, expect, beforeEach } from 'vitest';
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

  it('未选学科时是 null（不是 0）——0 会被服务端当成非法学科', () => {
    expect(useLearnContextStore.getState().subjectId).toBeNull();
  });
});
