import { describe, it, expect } from 'vitest';
import { normalizeRoute, moduleFromRoute, shouldSkipRoute } from './analytics.interceptor';

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
