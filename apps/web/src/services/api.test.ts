import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, getMyPoints } from './api';

/**
 * `fetchApi` 把 HTTP 状态码带进 `ApiError.status`（终审修复 Finding 6 的地基）。
 *
 * 为什么必须有这条：会话页靠 `err.status` 区分「客户端 4xx，重试也不会好」与
 * 「网络/5xx，可重试」。若 `fetchApi` 忘了传 `res.status`，分类永远走不到 4xx 分支，
 * 而页面测试里手搓 `ApiError` 是发现不了的——那会是一条假装覆盖了的回归。
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      status,
      json: async () => body,
    }),
  );
}

describe('fetchApi 错误形状', () => {
  it('业务码非 0 时抛 ApiError，且带上 HTTP status（401 → 1003）', async () => {
    stubFetch(401, { code: 1003, message: '未登录', data: null });

    await expect(getMyPoints()).rejects.toBeInstanceOf(ApiError);
    await expect(getMyPoints()).rejects.toMatchObject({ code: 1003, status: 401 });
  });

  it('404（会话不存在）同样带回 status，供调用方判定不可重试', async () => {
    stubFetch(404, { code: 1002, message: '训练会话不存在', data: null });

    await expect(getMyPoints()).rejects.toMatchObject({ code: 1002, status: 404 });
  });

  it('成功响应不抛错，正常返回 data', async () => {
    stubFetch(200, { code: 0, message: 'ok', data: { balance: 120 } });

    await expect(getMyPoints()).resolves.toMatchObject({ balance: 120 });
  });
});
