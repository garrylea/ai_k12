import { describe, it, expect } from 'vitest';
import {
  runWithRequestContext,
  getRequestContext,
  moduleFromRoute,
} from './request-context';

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

  it('module 字段随 context 透传（LLM 按模块归因，spec §2.2）', () => {
    runWithRequestContext({ requestId: 'r3', studentId: 1, role: 'student', module: 'practice' }, () => {
      expect(getRequestContext()?.module).toBe('practice');
    });
    runWithRequestContext({ requestId: 'r4', studentId: null, role: null, module: null }, () => {
      expect(getRequestContext()?.module).toBeNull();
    });
  });
});

// 2026-10-10 自 common/interceptors/analytics.interceptor.ts 迁入（spec §2.2：
// ai-core 不得反向 import common，公共纯函数放 ai-core 两侧共用防漂移）。
describe('moduleFromRoute', () => {
  const cases: Array<[string, string | null]> = [
    ['/api/practice/x', 'practice'],
    ['/api/ai/tutor', 'ai'],
    ['/api/training/vocabulary/judge', 'training'],
    ['/api/admin/models', 'admin'],
    ['/api/practice/12/judge?cardId=3', 'practice'], // query 不参与
    ['/api', null], // 定死行为：裸 /api 无第二段 → null
    ['/api/', null], // 同上（正则要求第二段至少一个字符）
    ['/api?x=1', null],
    ['/health', null],
    ['', null],
  ];

  it.each(cases)('%j -> %j', (path, expected) => {
    expect(moduleFromRoute(path)).toBe(expected);
  });
});
