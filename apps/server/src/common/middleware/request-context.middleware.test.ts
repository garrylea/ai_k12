import { describe, it, expect } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { RequestContextMiddleware } from './request-context.middleware.js';
import { getRequestContext, runWithRequestContext } from '../../ai-core/infra/request-context.js';

const makeReq = (overrides: Partial<Request> = {}): Request =>
  ({ method: 'POST', url: '/api/practice/12/judge', ...overrides }) as Request;

const makeRes = (): Response => ({}) as unknown as Response;

describe('RequestContextMiddleware（module 归因，spec §2.2）', () => {
  it('建 context 时按 originalUrl 推导 module', () => {
    const middleware = new RequestContextMiddleware();
    const req = makeReq({ originalUrl: '/api/practice/12/judge' });
    middleware.use(req, makeRes(), () => {
      expect(getRequestContext()?.module).toBe('practice');
    });
  });

  it('originalUrl 缺失时退回 url', () => {
    const middleware = new RequestContextMiddleware();
    const req = { method: 'POST', url: '/api/ai/tutor/stream' } as Request; // 不带 originalUrl
    middleware.use(req, makeRes(), () => {
      expect(getRequestContext()?.module).toBe('ai');
    });
  });

  it('无 /api 前缀（后台/静态路径）→ module null', () => {
    const middleware = new RequestContextMiddleware();
    const req = makeReq({ originalUrl: '/health' });
    middleware.use(req, makeRes(), () => {
      expect(getRequestContext()?.module).toBeNull();
    });
  });

  it('与外层 context 不串：嵌套 run 后 module 不泄漏回外层', () => {
    const middleware = new RequestContextMiddleware();
    const req = makeReq({ originalUrl: '/api/practice/12/judge' });
    runWithRequestContext({ requestId: 'outer', studentId: null, role: null, module: 'ai' }, () => {
      middleware.use(req, makeRes(), () => {
        expect(getRequestContext()?.module).toBe('practice');
        expect(getRequestContext()?.requestId).not.toBe('outer');
      });
      expect(getRequestContext()?.module).toBe('ai');
    });
  });
});
