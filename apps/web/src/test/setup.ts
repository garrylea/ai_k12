import '@testing-library/jest-dom/vitest';
import { beforeEach, vi } from 'vitest';

/**
 * 两处测试环境坑——页面级（尤其带导航的）测试都会撞到，统一在这里处理，
 * 勿再在各测试文件里重复 stub：
 *
 * 1. 本机 Node 自带 `localStorage` 全局会盖掉 jsdom 的 `Storage`（`getItem` 不是函数），
 *    而页面普遍要读 username/userId → 每个用例给一份全新的内存实现。
 * 2. React Router 导航内部会 `new Request(url, { signal })`，本环境里 jsdom 的
 *    `AbortSignal` 与 Node（undici）的 `Request` 跨 realm 不认，抛
 *    `RequestInit: Expected signal ... to be an instance of AbortSignal`
 *    → 用最小 Request 桩绕开，让导航走真路由（而不是把 useNavigate 也 mock 掉）。
 *
 * 用 `beforeEach` 而非一次性注入：用例里的 `vi.unstubAllGlobals()` 会清掉它们，
 * 下个用例开始时必须重新装上。
 */
beforeEach(() => {
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => memory.clear(),
  });

  vi.stubGlobal(
    'Request',
    class {
      constructor(public url: string) {}
    },
  );
});
