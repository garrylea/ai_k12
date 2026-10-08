import { describe, it, expect, vi, afterEach } from 'vitest';
import { ArgumentsHost, HttpStatus } from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter.js';

// 回归钉子（fix round 2，手写转写 8mb 放宽）：body-parser 超限抛的 PayloadTooLargeError
// 是带 statusCode=413 的普通 Error 而非 HttpException，过滤器必须透传 413，
// 不能吞成 500/5000（文档口径：API 文档 §4.27 / openapi 的 '413' 条目）。

function makeHost() {
  const status = vi.fn().mockReturnThis();
  const json = vi.fn();
  const response = { status, json };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({}) }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HttpExceptionFilter — body-parser 413 透传', () => {
  it('statusCode=413 的普通 Error（PayloadTooLargeError）→ 透传 413，不进 500 分支', () => {
    const { host, status, json } = makeHost();
    const err = Object.assign(new Error('request entity too large'), { statusCode: 413 });
    new HttpExceptionFilter().catch(err, host);
    expect(status).toHaveBeenCalledWith(HttpStatus.PAYLOAD_TOO_LARGE);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 5000, message: 'request entity too large' }),
    );
  });

  it('其它未知 Error 仍为 500/5000（原行为不变）', () => {
    const { host, status, json } = makeHost();
    new HttpExceptionFilter().catch(new Error('boom'), host);
    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 5000, message: 'boom' }));
  });
});
