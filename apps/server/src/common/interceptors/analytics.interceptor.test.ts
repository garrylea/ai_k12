import { describe, it, expect } from 'vitest';
import { lastValueFrom, of, throwError } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { normalizeRoute, moduleFromRoute, shouldSkipRoute, AnalyticsInterceptor } from './analytics.interceptor.js';
import type { ApiRequestLogEntry } from '../../database/repositories/api-request-logs.repo.js';
import type { TelemetryService } from '../../modules/analytics/telemetry.service.js';

describe('normalizeRoute', () => {
  it('用 Express 路由模板（req.baseUrl + req.route.path）', () => {
    expect(normalizeRoute({ baseUrl: '/api/practice', routePath: '/:cardId/judge', path: '/api/practice/12/judge' }))
      .toBe('/api/practice/:cardId/judge');
  });

  it('拿不到模板时把数字/UUID 段替换掉，避免基数爆炸', () => {
    expect(normalizeRoute({ baseUrl: '', routePath: undefined, path: '/api/exams/sessions/42/results' }))
      .toBe('/api/exams/sessions/:id/results');
    expect(normalizeRoute({ baseUrl: '', routePath: undefined, path: '/api/study-sessions/3f2504e0-4f89-11d3-9a0c-0305e82c3301/end' }))
      .toBe('/api/study-sessions/:uuid/end');
  });
});

describe('moduleFromRoute', () => {
  it('按第二段路径推导 module', () => {
    expect(moduleFromRoute('/api/practice/12/judge')).toBe('practice');
    expect(moduleFromRoute('/api/training/vocabulary/judge')).toBe('training');
    expect(moduleFromRoute('/api/admin/models')).toBe('admin');
    expect(moduleFromRoute('/health')).toBeNull();
  });
});

describe('shouldSkipRoute', () => {
  it('跳过自指与静态资源', () => {
    expect(shouldSkipRoute('/api/admin/analytics/llm-tokens')).toBe(true);
    expect(shouldSkipRoute('/assets/textbooks/a.jpg')).toBe(true);
    expect(shouldSkipRoute('/uploads/x.png')).toBe(true);
    expect(shouldSkipRoute('/api/track/events')).toBe(true);
    expect(shouldSkipRoute('/api/practice/12/judge')).toBe(false);
  });
});

describe('AnalyticsInterceptor', () => {
  function makeContext(responseHeaders: Record<string, string> = {}): ExecutionContext {
    const req = {
      originalUrl: '/api/practice/12/judge',
      url: '/api/practice/12/judge',
      method: 'POST',
      baseUrl: '/api/practice',
      route: { path: '/:cardId/judge' },
      // 前端流式调用只发 Content-Type/Authorization，浏览器补 Accept: */*
      headers: { accept: '*/*' },
      user: { role: 'student', sub: '7' },
      requestId: 'req-1',
    };
    const res = {
      statusCode: 200,
      getHeader: (name: string) => responseHeaders[name.toLowerCase()],
    };
    return {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as ExecutionContext;
  }

  function makeInterceptor(entries: ApiRequestLogEntry[]): AnalyticsInterceptor {
    const telemetry = {
      apiRequests: { push: (e: ApiRequestLogEntry) => entries.push(e) },
    } as unknown as TelemetryService;
    return new AnalyticsInterceptor(telemetry);
  }

  it('响应头为 text/event-stream 时记录 isSse=true', async () => {
    const entries: ApiRequestLogEntry[] = [];
    const handler: CallHandler = { handle: () => of('ok') };
    await lastValueFrom(
      makeInterceptor(entries).intercept(makeContext({ 'content-type': 'text/event-stream' }), handler),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].isSse).toBe(true);
  });

  it('普通 application/json 响应记录 isSse=false', async () => {
    const entries: ApiRequestLogEntry[] = [];
    const handler: CallHandler = { handle: () => of({ ok: true }) };
    await lastValueFrom(
      makeInterceptor(entries).intercept(makeContext({ 'content-type': 'application/json; charset=utf-8' }), handler),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].isSse).toBe(false);
  });

  it('处理器抛错时原样重抛，且只记一条', async () => {
    const entries: ApiRequestLogEntry[] = [];
    const err = new Error('boom');
    const handler: CallHandler = { handle: () => throwError(() => err) };
    await expect(
      lastValueFrom(makeInterceptor(entries).intercept(makeContext(), handler)),
    ).rejects.toBe(err);
    expect(entries).toHaveLength(1);
    expect(entries[0].statusCode).toBe(500);
    expect(entries[0].errorCode).toBe('Error');
  });
});
