import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { drawStrokes, renderDraftSnapshot } from './draft-render';

/**
 * 草稿渲染纯函数：`drawStrokes` 与 `renderDraftSnapshot`。
 *
 * jsdom 没有 canvas 2d 实现，`getContext` 返回 null、`toDataURL` 未实现 ——
 * 这里用记录型 stub 顶替 ctx，只断言「画了哪些调用」与「导出的 data URL / 质量参数」。
 */

interface CtxRecord {
  ops: string[];
  calls: Array<{ op: string; args: unknown[] }>;
  fills: string[];
  lineWidths: number[];
}

function makeCtx(): { ctx: CanvasRenderingContext2D; rec: CtxRecord } {
  const rec: CtxRecord = { ops: [], calls: [], fills: [], lineWidths: [] };
  const push = (op: string) => (...args: unknown[]) => {
    rec.ops.push(op);
    rec.calls.push({ op, args });
  };
  const ctx = {
    beginPath: push('begin'),
    arc: push('arc'),
    moveTo: push('move'),
    quadraticCurveTo: push('quad'),
    lineTo: push('line'),
    stroke: push('stroke'),
    fill: push('fill'),
    fillRect: push('fillRect'),
    drawImage: push('drawImage'),
    scale: push('scale'),
    lineCap: 'butt',
    lineJoin: 'miter',
    set lineWidth(v: number) { rec.lineWidths.push(v); },
    get lineWidth() { return rec.lineWidths[rec.lineWidths.length - 1] ?? 1; },
    set fillStyle(v: string) { rec.fills.push(v); },
    get fillStyle() { return rec.fills[rec.fills.length - 1] ?? '#000'; },
    strokeStyle: '',
  } as unknown as CanvasRenderingContext2D;
  return { ctx, rec };
}

describe('drawStrokes', () => {
  it('drawStrokes 画单点/多点为路径', () => {
    const { ctx, rec } = makeCtx();
    drawStrokes(ctx, [{ points: [{ x: 1, y: 2, pressure: 1 }], size: 10 }]);
    expect(rec.ops).toEqual(['begin', 'arc', 'fill']);
    rec.ops.length = 0;
    drawStrokes(ctx, [{ points: [{ x: 0, y: 0, pressure: 1 }, { x: 1, y: 1, pressure: 1 }], size: 2 }]);
    expect(rec.ops).toContain('stroke');
  });

  it('单点按 size/2 画实心圆点', () => {
    const { ctx, rec } = makeCtx();
    drawStrokes(ctx, [{ points: [{ x: 5, y: 6, pressure: 1 }], size: 10 }]);
    expect(rec.calls.find((c) => c.op === 'arc')?.args).toEqual([5, 6, 5, 0, Math.PI * 2]);
    expect(rec.lineWidths).toContain(10);
  });

  it('多点用「相邻中点」二次贝塞尔串线，末点直线收尾', () => {
    const { ctx, rec } = makeCtx();
    drawStrokes(ctx, [{
      points: [
        { x: 0, y: 0, pressure: 1 },
        { x: 10, y: 0, pressure: 1 },
        { x: 10, y: 10, pressure: 1 },
      ],
      size: 2,
    }]);
    expect(rec.ops).toEqual(['begin', 'move', 'quad', 'line', 'stroke']);
    expect(rec.calls.find((c) => c.op === 'quad')?.args).toEqual([10, 0, 10, 5]);
    expect(rec.calls.find((c) => c.op === 'line')?.args).toEqual([10, 10]);
  });

  it('带圆心的正圆在轮廓之后补圆心标记', () => {
    const { ctx, rec } = makeCtx();
    drawStrokes(ctx, [{
      points: [{ x: 0, y: 0, pressure: 1 }, { x: 10, y: 0, pressure: 1 }],
      size: 2,
      center: { x: 5, y: 5, pressure: 0.5 },
    }]);
    // begin/move/line/stroke + begin/arc/fill（圆心）
    expect(rec.ops).toEqual(['begin', 'move', 'line', 'stroke', 'begin', 'arc', 'fill']);
    expect(rec.calls.filter((c) => c.op === 'arc').map((c) => c.args)).toEqual([[5, 5, 3, 0, Math.PI * 2]]);
  });

  it('空笔画数组什么都不画', () => {
    const { ctx, rec } = makeCtx();
    drawStrokes(ctx, []);
    expect(rec.ops).toEqual([]);
  });
});

describe('renderDraftSnapshot', () => {
  let rec: CtxRecord;
  let ctx: CanvasRenderingContext2D;
  let dataUrls: Array<{ type: string; quality: number | undefined }>;
  let sizes: Array<{ w: number; h: number }>;
  let dataUrlResult = 'data:image/jpeg;base64,AAA';

  beforeEach(() => {
    const made = makeCtx();
    ctx = made.ctx;
    rec = made.rec;
    dataUrls = [];
    sizes = [];
    dataUrlResult = 'data:image/jpeg;base64,AAA';

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(function (
      this: HTMLCanvasElement,
      type?: string,
      quality?: number,
    ) {
      dataUrls.push({ type: type ?? '', quality });
      sizes.push({ w: this.width, h: this.height });
      return dataUrlResult;
    });
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('空内容返回 null', async () => {
    expect(await renderDraftSnapshot({ strokes: [], images: [], width: 100, height: 100 })).toBeNull();
  });

  it('只有贴图也算有内容（不返回 null）', async () => {
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('Image', FakeImage as unknown as typeof Image);

    const out = await renderDraftSnapshot({
      strokes: [], images: [{ id: 'i1', src: '/assets/x.png', x: 10, y: 20, w: 100, h: 60 }],
      width: 400, height: 300,
    });
    expect(out).toBe('data:image/jpeg;base64,AAA');
    expect(rec.calls.find((c) => c.op === 'drawImage')?.args).toEqual([expect.any(Object), 10, 20, 100, 60]);
  });

  it('白底 + JPEG + 默认质量 0.85', async () => {
    const out = await renderDraftSnapshot({
      strokes: [{ points: [{ x: 0, y: 0, pressure: 1 }], size: 10 }],
      images: [], width: 400, height: 300,
    });
    expect(out).toBe('data:image/jpeg;base64,AAA');
    // 先铺白底，再按原尺寸画（400×300 不超 1600 → scale = 1）
    expect(rec.ops.slice(0, 2)).toEqual(['fillRect', 'scale']);
    expect(rec.calls[0].args).toEqual([0, 0, 400, 300]);
    expect(rec.calls[1].args).toEqual([1, 1]);
    expect(rec.fills[0]).toBe('#fff');
    expect(dataUrls).toEqual([{ type: 'image/jpeg', quality: 0.85 }]);
    expect(sizes[0]).toEqual({ w: 400, h: 300 });
  });

  it('长边超过 maxEdge 时等比缩小（默认 1600）', async () => {
    await renderDraftSnapshot({
      strokes: [{ points: [{ x: 0, y: 0, pressure: 1 }], size: 10 }],
      images: [], width: 3200, height: 1600,
    });
    expect(rec.calls[1].args).toEqual([0.5, 0.5]);
    expect(sizes[0]).toEqual({ w: 1600, h: 800 });
  });

  it('可指定 quality 与 maxEdge', async () => {
    await renderDraftSnapshot({
      strokes: [{ points: [{ x: 0, y: 0, pressure: 1 }], size: 10 }],
      images: [], width: 2000, height: 1000, maxEdge: 500, quality: 0.7,
    });
    expect(rec.calls[1].args).toEqual([0.25, 0.25]);
    expect(sizes[0]).toEqual({ w: 500, h: 250 });
    expect(dataUrls).toEqual([{ type: 'image/jpeg', quality: 0.7 }]);
  });

  it('贴图解码失败时跳过该图，仍导出笔迹', async () => {
    class BrokenImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) { queueMicrotask(() => this.onerror?.()); }
    }
    vi.stubGlobal('Image', BrokenImage as unknown as typeof Image);

    const out = await renderDraftSnapshot({
      strokes: [{ points: [{ x: 0, y: 0, pressure: 1 }], size: 10 }],
      images: [{ id: 'i1', src: '/assets/broken.png', x: 0, y: 0, w: 10, h: 10 }],
      width: 100, height: 100,
    });
    expect(out).toBe('data:image/jpeg;base64,AAA');
    expect(rec.ops).not.toContain('drawImage');
  });
});
