import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { draftImageFromSrc } from './draft-image-utils';

/** jsdom 不会真的解码图片：用一个立即 onload 的假 Image 顶替，只验证尺寸/落点数学 */
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 800;
  naturalHeight = 600;
  set src(_v: string) { queueMicrotask(() => this.onload?.()); }
}

beforeEach(() => { vi.stubGlobal('Image', FakeImage as unknown as typeof Image); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('draftImageFromSrc', () => {
  it('宽取画板 60%，以落点为中心，保留原地址', async () => {
    const img = await draftImageFromSrc('/assets/q.png', 400, 600, { x: 200, y: 300 });
    expect(img.src).toBe('/assets/q.png');
    expect(img.w).toBe(240);   // min(400*0.6, 800)
    expect(img.h).toBe(180);   // 240 / 800 * 600
    expect(img.x).toBe(80);    // 200 - 120
    expect(img.y).toBe(210);   // 300 - 90
    expect(img.id).toBeTruthy();
  });

  it('宽度取「画板 60%」与「原图宽」的较小值', async () => {
    const img = await draftImageFromSrc('/assets/q.png', 2000, 600, { x: 1000, y: 300 });
    expect(img.w).toBe(800);   // 2000*0.6 = 1200 > 原图 800 → 用原图宽
  });

  it('靠近左上角时落点夹回画板内', async () => {
    const img = await draftImageFromSrc('/assets/q.png', 400, 600, { x: 5, y: 5 });
    expect(img.x).toBe(0);
    expect(img.y).toBe(0);
  });

  it('解码失败时 reject', async () => {
    class Broken extends FakeImage {
      set src(_v: string) { queueMicrotask(() => this.onerror?.()); }
    }
    vi.stubGlobal('Image', Broken as unknown as typeof Image);
    await expect(draftImageFromSrc('/assets/bad.png', 400, 600, { x: 10, y: 10 })).rejects.toThrow();
  });
});
