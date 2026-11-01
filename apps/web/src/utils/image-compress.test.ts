// 只测纯计算：jsdom 没有 canvas 和图片解码，DOM 路径（重编码/白底）靠手工验证。
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import { MAX_IMAGE_EDGE, scaleSize } from './image-compress';

afterEach(() => cleanup());

describe('scaleSize', () => {
  it('宽边超限：等比缩到 1600', () => {
    expect(scaleSize(2000, 1000)).toEqual({ w: 1600, h: 800 });
  });

  it('高边超限：等比缩到 1600', () => {
    expect(scaleSize(1000, 2500)).toEqual({ w: 640, h: 1600 });
  });

  it('未超限：原样返回', () => {
    expect(scaleSize(800, 600)).toEqual({ w: 800, h: 600 });
    expect(scaleSize(1600, 1200)).toEqual({ w: 1600, h: 1200 });
  });

  it('取整后长边不超过上限', () => {
    const { w, h } = scaleSize(1601, 1599);
    expect(Math.max(w, h)).toBeLessThanOrEqual(MAX_IMAGE_EDGE);
  });
});
