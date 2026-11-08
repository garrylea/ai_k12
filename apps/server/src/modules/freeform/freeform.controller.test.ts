import { describe, it, expect, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import { FreeformController } from './freeform.controller.js';
import type { FreeformJudgeDto } from './dto/freeform.dto.js';

function make(recognize = vi.fn().mockResolvedValue({ candidates: [], figures: [] })) {
  const recognizeService = { recognize } as any;
  const judgeService = { judgeStream: vi.fn() } as any;
  return { controller: new FreeformController(recognizeService, judgeService), recognize };
}

const baseDto = (over: Partial<FreeformJudgeDto> = {}): FreeformJudgeDto => ({
  subjectId: 1,
  maxScore: 10,
  questionContent: '已知 x+1=2',
  answer: 'x=1',
  ...over,
});

describe('FreeformController.recognize', () => {
  it('recognize 透传 text/fileIds + studentId', async () => {
    const { controller, recognize } = make();

    const res = await controller.recognize(
      { text: '第5题', fileIds: ['1', '2'] },
      { sub: 9 } as any,
    );

    expect(recognize).toHaveBeenCalledWith({ text: '第5题', fileIds: ['1', '2'] }, 9);
    expect(res).toEqual({ candidates: [], figures: [] });
  });

  it('未带 fileIds 时按空数组透传（纯文字短路由 service 处理）', async () => {
    const { controller, recognize } = make();

    await controller.recognize({ text: '解方程' }, { sub: 3 } as any);

    expect(recognize).toHaveBeenCalledWith({ text: '解方程', fileIds: [] }, 3);
  });

  it('fileIds 非数组/超 6 张 → 400/1001', async () => {
    const { controller, recognize } = make();

    await expect(
      controller.recognize({ fileIds: 'x' } as any, { sub: 1 } as any),
    ).rejects.toMatchObject({ response: { code: 1001 } });
    await expect(
      controller.recognize(
        { fileIds: ['1', '2', '3', '4', '5', '6', '7'] },
        { sub: 1 } as any,
      ),
    ).rejects.toMatchObject({ response: { code: 1001 } });

    expect(recognize).not.toHaveBeenCalled();
  });

  it('text 非字符串 → 400/1001（不能落到 service 的 trim 上）', async () => {
    const { controller, recognize } = make();

    await expect(
      controller.recognize({ text: 123 } as any, { sub: 1 } as any),
    ).rejects.toMatchObject({ response: { code: 1001 } });

    expect(recognize).not.toHaveBeenCalled();
  });

  it('fileIds 元素非正整数 → 400/1001', async () => {
    const { controller, recognize } = make();

    await expect(
      controller.recognize({ fileIds: ['abc'] }, { sub: 1 } as any),
    ).rejects.toMatchObject({ response: { code: 1001 } });
    await expect(
      controller.recognize({ fileIds: ['0'] }, { sub: 1 } as any),
    ).rejects.toMatchObject({ response: { code: 1001 } });

    expect(recognize).not.toHaveBeenCalled();
  });
});

describe('FreeformController.judgeStream', () => {
  it('judge/stream 设置 SSE 头并写完 done', async () => {
    const svc = {
      judgeStream: vi.fn().mockImplementation(async function* () {
        yield { type: 'start', dialogueId: '1', questionId: null };
        yield { type: 'done' };
      }),
    } as any;
    const c = new FreeformController({} as any, svc);
    const res = { setHeader: vi.fn(), flushHeaders: vi.fn(), write: vi.fn(), end: vi.fn(), on: vi.fn() } as any;
    await c.judgeStream(baseDto(), { sub: 9 } as any, res);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.write).toHaveBeenCalledWith(expect.stringContaining('"type":"start"'));
    expect(res.write).toHaveBeenCalledWith(expect.stringContaining('"type":"done"'));
    expect(res.end).toHaveBeenCalled();
  });

  it('客户端断开（res close）→ abort 上游 stream', async () => {
    let closed: (() => void) | undefined;
    let seen: AbortSignal | undefined;
    const svc = {
      judgeStream: vi.fn((_dto: unknown, _sid: number, signal: AbortSignal) => {
        seen = signal;
        return (async function* () {
          yield { type: 'start', dialogueId: '1', questionId: null };
          closed?.();
          yield { type: 'done' };
        })();
      }),
    } as any;
    const c = new FreeformController({} as any, svc);
    const res = {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      on: vi.fn((ev: string, fn: () => void) => {
        if (ev === 'close') closed = fn;
      }),
    } as any;

    await c.judgeStream(baseDto(), { sub: 9 } as any, res);

    expect(seen?.aborted).toBe(true);
  });

  it('上游抛 HttpException → 写 error 事件（仍是 200，不设错误状态码）', async () => {
    const svc = {
      judgeStream: vi.fn().mockImplementation(async function* () {
        throw new HttpException({ code: 1001, message: '参数不对' }, 400);
      }),
    } as any;
    const c = new FreeformController({} as any, svc);
    const res = { setHeader: vi.fn(), flushHeaders: vi.fn(), write: vi.fn(), end: vi.fn(), on: vi.fn() } as any;

    await c.judgeStream(baseDto(), { sub: 9 } as any, res);

    expect(res.write).toHaveBeenCalledWith(
      expect.stringContaining('"type":"error"'),
    );
    expect(res.write).toHaveBeenCalledWith(expect.stringContaining('"code":1001'));
    expect(res.status).toBeUndefined();
    expect(res.end).toHaveBeenCalled();
  });

  it('上游非 HttpException → 5000 错误事件 + end', async () => {
    const svc = {
      judgeStream: vi.fn().mockImplementation(async function* () {
        throw new Error('boom');
      }),
    } as any;
    const c = new FreeformController({} as any, svc);
    const res = { setHeader: vi.fn(), flushHeaders: vi.fn(), write: vi.fn(), end: vi.fn(), on: vi.fn() } as any;

    await c.judgeStream(baseDto(), { sub: 9 } as any, res);

    expect(res.write).toHaveBeenCalledWith(expect.stringContaining('"code":5000'));
    expect(res.end).toHaveBeenCalled();
  });
});
