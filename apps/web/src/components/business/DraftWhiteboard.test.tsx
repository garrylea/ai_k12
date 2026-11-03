import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, fireEvent, waitFor } from '@testing-library/react';
import { DraftWhiteboard } from './DraftWhiteboard';
import { clearDraft, getDraft, getDraftImages } from './draft-store';
import { beginImageDrag } from './draft-image-drag';

/**
 * 草稿白板「选中」工具的起手判定回归测试。
 *
 * 背景：选中工具的起手容差曾与橡皮共用（墨迹半宽之外再放宽 8px，手写笔 2px 线宽即 10px）。
 * 手写笔迹短促密集，贴着笔画 10px 以内起手拖框会被判成「抓住这条笔画」，
 * 整个手势变成拖动那条笔画——框选矩形根本不出现，一条笔迹也框不住。
 */

interface RectRec { x: number; y: number; w: number; h: number; dashed: boolean }

let rects: RectRec[] = [];
let dash: number[] = [];

beforeEach(() => {
  rects = [];
  dash = [];
  clearDraft('q1');

  // jsdom 无 canvas 2d：用记录型 stub 顶替，只关心「最终重绘画了哪些虚线框」
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
    clearRect() {}, setTransform() {}, beginPath() {}, arc() {}, fill() {},
    moveTo() {}, lineTo() {}, quadraticCurveTo() {}, stroke() {},
    save() {}, restore() {}, fillRect() {}, fillText() {},
    setLineDash(segs: number[]) { dash = segs ?? []; },
    strokeRect(x: number, y: number, w: number, h: number) {
      rects.push({ x, y, w, h, dashed: dash.length > 0 });
    },
  }) as unknown as CanvasRenderingContext2D);

  // jsdom 未实现指针捕获 / ResizeObserver
  Object.defineProperty(Element.prototype, 'setPointerCapture', { value: () => {}, configurable: true });
  Object.defineProperty(Element.prototype, 'releasePointerCapture', { value: () => {}, configurable: true });
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class { observe() {} disconnect() {} };
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); cleanup(); });

/** 渲染白板，返回 canvas 与容器（jsdom 的 getBoundingClientRect 全 0 → clientX/Y 即画布坐标） */
function setup() {
  const { container } = render(<DraftWhiteboard questionId="q1" />);
  const canvas = container.querySelector('canvas')!;
  return { container, canvas };
}

/** 用画笔写一条水平线 */
function penLine(canvas: Element, y: number) {
  fireEvent.pointerDown(canvas, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 100, clientY: y });
  fireEvent.pointerMove(canvas, { pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: 200, clientY: y });
  fireEvent.pointerUp(canvas, { pointerId: 1, pointerType: 'mouse', clientX: 200, clientY: y });
}

function pickTool(container: Element, titlePrefix: string) {
  fireEvent.click(container.querySelector(`button[title^="${titlePrefix}"]`)!);
}

/** 选中工具：从 from 拖框到 to，返回「抬起落定」那一帧画出的虚线框 */
function dragSelect(canvas: Element, from: [number, number], to: [number, number]) {
  fireEvent.pointerDown(canvas, { pointerId: 2, pointerType: 'mouse', button: 0, clientX: from[0], clientY: from[1] });
  fireEvent.pointerMove(canvas, { pointerId: 2, pointerType: 'mouse', buttons: 1, clientX: to[0], clientY: to[1] });
  rects = []; // 只看抬起后落定那一帧（框选矩形 / 选中框都在这一帧画）
  fireEvent.pointerUp(canvas, { pointerId: 2, pointerType: 'mouse', clientX: to[0], clientY: to[1] });
  return rects.filter((r) => r.dashed);
}

/** 选中框 = 笔迹包围盒外扩 4px（水平线的包围盒高 0 → 取 1 兜底，故高 9） */
const boxOf = (y: number) => ({ x: 96, y: y - 4, w: 108, h: 9, dashed: true });

describe('草稿白板：选中工具起手判定', () => {
  it('贴着笔画 6px 起手拖框：应正常框选，不该被抢成拖动笔画', () => {
    const { container, canvas } = setup();
    penLine(canvas, 100);   // 笔迹 A
    penLine(canvas, 160);   // 笔迹 B
    pickTool(container, '选中');

    // 起手点 (150,94) 距 A 只有 6px：容差宽时会被判成「抓住 A」，整个手势变成拖走 A
    const boxes = dragSelect(canvas, [150, 94], [260, 220]);

    // 拖框覆盖 A、B → 两条都该被框住，且都还在原位（不是被拖走后的位置）
    expect(boxes).toEqual(expect.arrayContaining([boxOf(100), boxOf(160)]));
  });

  it('按在笔画线上拖动：仍是移动整条笔画（收紧容差不能把「拖动」也弄丢）', () => {
    const { container, canvas } = setup();
    penLine(canvas, 100);
    pickTool(container, '选中');

    // 起手点 (150,100) 正压在笔迹 A 上，拖动 (100,80) → A 跟着走
    const boxes = dragSelect(canvas, [150, 100], [250, 180]);

    expect(boxes).toContainEqual({ ...boxOf(100), x: 196, y: 176 });
  });

  it('橡皮容差保持宽松：离笔画 8px 擦过仍能整条擦掉', () => {
    const { container, canvas } = setup();
    penLine(canvas, 100);
    penLine(canvas, 160);

    pickTool(container, '橡皮');
    fireEvent.pointerDown(canvas, { pointerId: 3, pointerType: 'mouse', button: 0, clientX: 150, clientY: 108 });
    fireEvent.pointerUp(canvas, { pointerId: 3, pointerType: 'mouse', clientX: 150, clientY: 108 });

    // 回到选中工具，从空白处框住整片：只剩 B，A 已被擦掉
    pickTool(container, '选中');
    const boxes = dragSelect(canvas, [50, 50], [300, 300]);

    expect(boxes).toEqual(expect.arrayContaining([boxOf(160)]));
    expect(boxes).not.toEqual(expect.arrayContaining([boxOf(100)]));
  });
});

describe('草稿白板：撤销 / 重做', () => {
  const undoKey = () => fireEvent.keyDown(document, { key: 'z', ctrlKey: true });
  const redoKey = () => fireEvent.keyDown(document, { key: 'z', ctrlKey: true, shiftKey: true });

  it('Ctrl+Z 撤销一笔、Ctrl+Shift+Z 重做', () => {
    const { canvas } = setup();
    penLine(canvas, 100);
    penLine(canvas, 160);
    expect(getDraft('q1')).toHaveLength(2);

    undoKey();
    expect(getDraft('q1')).toHaveLength(1);
    redoKey();
    expect(getDraft('q1')).toHaveLength(2);
  });

  it('Ctrl+Y 也能重做', () => {
    const { canvas } = setup();
    penLine(canvas, 100);
    undoKey();
    fireEvent.keyDown(document, { key: 'y', ctrlKey: true });
    expect(getDraft('q1')).toHaveLength(1);
  });

  it('一次橡皮划过擦掉两条，撤销一次全部回来', () => {
    const { container, canvas } = setup();
    penLine(canvas, 100);
    penLine(canvas, 160);
    pickTool(container, '橡皮');

    fireEvent.pointerDown(canvas, { pointerId: 4, pointerType: 'mouse', button: 0, clientX: 150, clientY: 100 });
    fireEvent.pointerMove(canvas, { pointerId: 4, pointerType: 'mouse', buttons: 1, clientX: 150, clientY: 160 });
    fireEvent.pointerUp(canvas, { pointerId: 4, pointerType: 'mouse', clientX: 150, clientY: 160 });
    expect(getDraft('q1')).toHaveLength(0);

    undoKey();
    expect(getDraft('q1')).toHaveLength(2);
  });

  it('橡皮拖拽途中按 Ctrl+Z 不撤销（抬手记一步后才生效）', () => {
    const { container, canvas } = setup();
    penLine(canvas, 100);
    pickTool(container, '橡皮');

    // 按下即擦掉这一条，但手势还在进行中（没有 pointerup）
    fireEvent.pointerDown(canvas, { pointerId: 7, pointerType: 'mouse', button: 0, clientX: 150, clientY: 100 });
    expect(getDraft('q1')).toHaveLength(0);

    undoKey();
    expect(getDraft('q1')).toHaveLength(0); // 手势进行中：撤销被忽略，不会把这一批笔画整批恢复

    fireEvent.pointerUp(canvas, { pointerId: 7, pointerType: 'mouse', clientX: 150, clientY: 100 });
    undoKey();
    expect(getDraft('q1')).toHaveLength(1); // 抬手记了一步，撤销回到擦除前
  });

  it('选中拖动后撤销，点坐标回到原位', () => {
    const { container, canvas } = setup();
    penLine(canvas, 100);
    pickTool(container, '选中');
    dragSelect(canvas, [50, 50], [300, 200]);

    fireEvent.pointerDown(canvas, { pointerId: 6, pointerType: 'mouse', button: 0, clientX: 150, clientY: 100 });
    fireEvent.pointerMove(canvas, { pointerId: 6, pointerType: 'mouse', buttons: 1, clientX: 250, clientY: 180 });
    fireEvent.pointerUp(canvas, { pointerId: 6, pointerType: 'mouse', clientX: 250, clientY: 180 });
    expect(getDraft('q1')[0].points[0].x).toBeCloseTo(200, 5);
    expect(getDraft('q1')[0].points[0].y).toBeCloseTo(180, 5);

    undoKey();
    expect(getDraft('q1')[0].points[0].x).toBeCloseTo(100, 5);
    expect(getDraft('q1')[0].points[0].y).toBeCloseTo(100, 5);
  });

  it('清空可撤销', () => {
    const { container, canvas } = setup();
    penLine(canvas, 100);
    fireEvent.click(container.querySelector('button[title="清空草稿"]')!);
    expect(getDraft('q1')).toHaveLength(0);
    undoKey();
    expect(getDraft('q1')).toHaveLength(1);
  });

  it('输入框里按 Ctrl+Z 不动草稿', () => {
    const { canvas } = setup();
    penLine(canvas, 100);
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: 'z', ctrlKey: true });
    expect(getDraft('q1')).toHaveLength(1);
    input.remove();
  });

  it('撤销按钮初始禁用，画一笔后可用', () => {
    const { container, canvas } = setup();
    const btn = () => container.querySelector('button[aria-label^="撤销"]') as HTMLButtonElement;
    expect(btn().disabled).toBe(true);
    penLine(canvas, 100);
    expect(btn().disabled).toBe(false);
  });
});

describe('草稿白板：题干图拖入', () => {
  it('落在松手点、宽 60%、可撤销', async () => {
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 400;
      naturalHeight = 300;
      set src(_v: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('Image', FakeImage as unknown as typeof Image);

    const { container, canvas } = setup();
    Object.defineProperty(canvas, 'clientWidth', { value: 400, configurable: true });
    Object.defineProperty(canvas, 'clientHeight', { value: 600, configurable: true });
    canvas.getBoundingClientRect = () => ({
      left: 0, top: 0, right: 400, bottom: 600, width: 400, height: 600, x: 0, y: 0, toJSON: () => ({}),
    }) as DOMRect;

    beginImageDrag({ src: '/assets/q.png', pointerId: 7, clientX: 200, clientY: 300 });
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 200, clientY: 300 });

    await waitFor(() => expect(getDraftImages('q1')).toHaveLength(1));
    const img = getDraftImages('q1')[0];
    expect(img.src).toBe('/assets/q.png');
    expect(img.w).toBe(240);
    expect(img.h).toBe(180);
    expect(img.x).toBe(80);
    expect(img.y).toBe(210);
    expect(container.querySelector('img[alt="草稿贴图"]')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'z', ctrlKey: true });
    expect(getDraftImages('q1')).toHaveLength(0);
  });
});

describe('草稿白板：旋转', () => {
  /** 用直线工具画一条精确水平线 (100,100)-(200,100) */
  function horizontalLine(container: Element, canvas: Element) {
    pickTool(container, '直线');
    fireEvent.pointerDown(canvas, { pointerId: 5, pointerType: 'mouse', button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(canvas, { pointerId: 5, pointerType: 'mouse', buttons: 1, clientX: 200, clientY: 100 });
    fireEvent.pointerUp(canvas, { pointerId: 5, pointerType: 'mouse', clientX: 200, clientY: 100 });
  }

  it('选中后拖旋转手柄 90°：水平线变竖直线，撤销复原', () => {
    const { container, canvas } = setup();
    horizontalLine(container, canvas);
    pickTool(container, '选中');
    dragSelect(canvas, [50, 50], [300, 200]);   // 包围盒 x 100..200 / y 100 → 手柄 (150, 74)

    fireEvent.pointerDown(canvas, { pointerId: 9, pointerType: 'mouse', button: 0, clientX: 150, clientY: 74 });
    fireEvent.pointerMove(canvas, { pointerId: 9, pointerType: 'mouse', buttons: 1, clientX: 250, clientY: 100 });
    fireEvent.pointerUp(canvas, { pointerId: 9, pointerType: 'mouse', clientX: 250, clientY: 100 });

    const pts = getDraft('q1')[0].points;
    expect(pts[0].x).toBeCloseTo(150, 0);
    expect(pts[0].y).toBeCloseTo(50, 0);
    expect(pts[1].x).toBeCloseTo(150, 0);
    expect(pts[1].y).toBeCloseTo(150, 0);

    fireEvent.keyDown(document, { key: 'z', ctrlKey: true });
    const back = getDraft('q1')[0].points;
    expect(back[0].y).toBeCloseTo(100, 5);
    expect(back[1].x).toBeCloseTo(200, 5);
  });

  it('按住 Shift 吸附 15°：拖到 20° 位置吸收到 15°', () => {
    const { container, canvas } = setup();
    horizontalLine(container, canvas);
    pickTool(container, '选中');
    dragSelect(canvas, [50, 50], [300, 200]);

    // 起手角 -90°，拖到相对 +20° 的位置（极角 -70°）
    const r = 60;
    const endX = 150 + r * Math.cos((-70 * Math.PI) / 180);
    const endY = 100 + r * Math.sin((-70 * Math.PI) / 180);
    fireEvent.pointerDown(canvas, { pointerId: 10, pointerType: 'mouse', button: 0, clientX: 150, clientY: 74 });
    fireEvent.pointerMove(canvas, { pointerId: 10, pointerType: 'mouse', buttons: 1, shiftKey: true, clientX: endX, clientY: endY });
    fireEvent.pointerUp(canvas, { pointerId: 10, pointerType: 'mouse', clientX: endX, clientY: endY });

    const a = getDraft('q1')[0].points[0];
    const b = getDraft('q1')[0].points[1];
    const deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    // 起手角 -90°，拖到 -70° → 原始 20°，Shift 吸附 15° → 线的方向从 0° 变成 15°
    expect(deg).toBeCloseTo(15, 0);
  });
});
