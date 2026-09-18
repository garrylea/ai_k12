import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

/**
 * 家长端「当前正在看哪个孩子」的锚点（计划三 §2.1）。
 *
 * 家长端所有「按学生」的页面都靠它取 `studentId`，所以它必须是**被动**的：
 * store 不负责拉 `GET /parent/students`（那是 `StudentSwitcher` 的职责），
 * 也不做「id 是否还有效」的校验——只存一个数，别的都不管。
 *
 * 持久化口径（本仓首次引入 `persist`）：
 * - key = `parent-current-student`；
 * - `partialize` **只写 `studentId`**。名字/年级一律不落盘：它们是会变的展示字段
 *   （改名、升学），存下来就会出现「顶栏写着三年级、接口说是四年级」的漂移，
 *   名字永远当场从接口取。
 */

export interface ParentStudentState {
  studentId: number | null;
  setStudentId: (id: number | null) => void;
}

export const PARENT_STUDENT_STORAGE_KEY = 'parent-current-student';

/**
 * 惰性解析 localStorage，而不是 `createJSONStorage(() => localStorage)`。
 *
 * 原因：`createJSONStorage` 在 **store 创建那一刻**就调用一次 `getStorage()` 并长期
 * 持有返回对象。测试里 `src/test/setup.ts` 是在 `beforeEach` 才把 localStorage 换成
 * 内存实现的，而 store 模块的导入发生在更早的收集阶段——那一刻拿到的是 jsdom 自带的
 * Storage，之后测试写进内存实现的值永远读不到，持久化用例会「假绿」。
 * 每次读写都重新解析，拿到的就是「当前生效的」localStorage，同时顺手兼容没有
 * localStorage 的环境（不抛错）。
 */
const lazyLocalStorage: StateStorage = {
  getItem: (name) => (typeof localStorage === 'undefined' ? null : localStorage.getItem(name)),
  setItem: (name, value) => {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(name, value);
  },
  removeItem: (name) => {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(name);
  },
};

export const useParentStudentStore = create<ParentStudentState>()(
  persist(
    (set) => ({
      studentId: null,
      setStudentId: (id) => set({ studentId: id }),
    }),
    {
      name: PARENT_STUDENT_STORAGE_KEY,
      storage: createJSONStorage(() => lazyLocalStorage),
      partialize: (state) => ({ studentId: state.studentId }),
    },
  ),
);
