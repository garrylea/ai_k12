import { describe, it, expect } from 'vitest';
import { runWithRequestContext, getRequestContext } from './request-context';

describe('request-context（ALS）', () => {
  it('上下文内可读到 studentId/requestId', () => {
    runWithRequestContext({ requestId: 'r1', studentId: 9, role: 'student' }, () => {
      expect(getRequestContext()).toEqual({ requestId: 'r1', studentId: 9, role: 'student' });
    });
  });

  it('上下文外返回 null', () => {
    expect(getRequestContext()).toBeNull();
  });

  it('跨 await 保留（后台 fire-and-forget 也能归因）', async () => {
    await runWithRequestContext({ requestId: 'r2', studentId: 7, role: 'student' }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(getRequestContext()?.studentId).toBe(7);
    });
  });
});
