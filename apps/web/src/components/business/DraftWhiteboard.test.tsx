import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/react';
import { DraftWhiteboard } from './DraftWhiteboard';
import { clearDraft } from './draft-store';

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

afterEach(() => { vi.restoreAllMocks(); cleanup(); });

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
