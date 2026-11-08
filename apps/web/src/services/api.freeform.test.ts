import { afterEach, describe, expect, it, vi } from 'vitest';
import { recognizeFreeform, streamFreeformJudge, uploadFile } from './api';

/**
 * 自由输入做题（Task 13）的前端 API 契约。
 *
 * 这里只钉「请求怎么发」和「SSE 怎么解」；页面状态机在 Task 16+ 的组件测试里。
 * URL 断言用全串（含 `/api` 前缀）——少 `API_BASE` 是静默 404，只有全串能拦住。
 */
afterEach(() => {
  vi.restoreAllMocks();
});

describe('recognizeFreeform', () => {
  it('走 /api/freeform/recognize', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ code: 0, data: { candidates: [], figures: [] } }),
    } as any);
    await recognizeFreeform({ text: '题', attachments: [] });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/freeform/recognize',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('把 attachments[].fileId 映射成 fileIds 字符串数组', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ code: 0, data: { candidates: [], figures: [] } }),
    } as any);

    await recognizeFreeform({
      text: '题',
      attachments: [
        { type: 'image', fileId: '11' },
        { type: 'image', fileId: '12' },
      ],
    });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ text: '题', fileIds: ['11', '12'] });
  });
});

describe('streamFreeformJudge', () => {
  it('解析 reasoning/content/result', async () => {
    const body = [
      'data: {"type":"start","dialogueId":"1","questionId":null}\n\n',
      'data: {"type":"reasoning","delta":"想"}\n\n',
      'data: {"type":"result","questionId":7,"totalScore":7,"maxScore":10,"verdict":"partial"}\n\n',
      'data: {"type":"done"}\n\n',
    ].join('');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(body));
          c.close();
        },
      }),
    } as any);
    const events = [];
    for await (const e of streamFreeformJudge({} as any)) events.push(e);
    expect(events.map((e) => e.type)).toEqual(['start', 'reasoning', 'result', 'done']);
  });

  it('把末尾没有换行结尾的最后一个事件也交出去', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              'data: {"type":"reasoning","delta":"想"}\n\ndata: {"type":"done"}',
            ),
          );
          c.close();
        },
      }),
    } as any);
    const events = [];
    for await (const e of streamFreeformJudge({} as any)) events.push(e);
    expect(events).toEqual([{ type: 'reasoning', delta: '想' }, { type: 'done' }]);
  });
});

describe('uploadFile', () => {
  it('source=freeform 时拼进查询串', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ code: 0, data: { fileId: 1, url: '/uploads/a.png' } }),
    } as any);

    await uploadFile(new File(['x'], 'a.png', { type: 'image/png' }), undefined, 'freeform');

    expect(fetchMock.mock.calls[0][0]).toBe('/api/files/upload?source=freeform');
  });

  it('不传 source 时不带查询串', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ code: 0, data: { fileId: 1, url: '/uploads/a.png' } }),
    } as any);

    await uploadFile(new File(['x'], 'a.png', { type: 'image/png' }));

    expect(fetchMock.mock.calls[0][0]).toBe('/api/files/upload');
  });
});
