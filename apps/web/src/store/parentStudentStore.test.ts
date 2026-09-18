import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useParentStudentStore } from './parentStudentStore';

/**
 * 家长端「当前查看哪个孩子」的锚点（计划三 §2.1）。
 *
 * 铁律：**只持久化 `studentId`**。名字/年级一律不进 localStorage——它们是会变的
 * 展示字段（改名、升级），存下来就会出现「顶栏叫小明三年级、接口说四年级」的漂移。
 * 名字永远当场从 `GET /parent/students` 取。
 */

const STORAGE_KEY = 'parent-current-student';

beforeEach(() => {
  localStorage.clear();
  useParentStudentStore.setState({ studentId: null });
});

afterEach(() => {
  // 单例 store + persist：不清就会把上一个用例的 id 泄漏到下一个
  useParentStudentStore.setState({ studentId: null });
  localStorage.clear();
});

describe('parentStudentStore', () => {
  it('初值为 null（首次进家长端没有锚点）', () => {
    expect(useParentStudentStore.getState().studentId).toBeNull();
  });

  it('setStudentId 后读得到', () => {
    useParentStudentStore.getState().setStudentId(7);

    expect(useParentStudentStore.getState().studentId).toBe(7);
  });

  it('setStudentId(null) 能清空锚点（没有孩子时）', () => {
    useParentStudentStore.getState().setStudentId(7);
    useParentStudentStore.getState().setStudentId(null);

    expect(useParentStudentStore.getState().studentId).toBeNull();
  });

  it('持久化只写 studentId，不带名字/年级等展示字段', () => {
    useParentStudentStore.getState().setStudentId(7);

    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();

    const parsed = JSON.parse(raw as string) as { state: Record<string, unknown> };
    expect(parsed.state).toEqual({ studentId: 7 });
    // 逐字断言：多一个字段就说明有人往 partialize 里塞了展示信息
    expect(Object.keys(parsed.state)).toEqual(['studentId']);
  });

  it('rehydrate 能从 localStorage 读回上次选的孩子（刷新不丢）', async () => {
    // 模拟「刷新」：内存没了，只剩持久化那一条
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ state: { studentId: 42 }, version: 0 }));

    await useParentStudentStore.persist.rehydrate();

    expect(useParentStudentStore.getState().studentId).toBe(42);
  });
});
