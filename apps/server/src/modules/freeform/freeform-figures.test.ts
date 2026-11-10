import { describe, it, expect } from 'vitest';
import { figureRefs, rewriteFigureRefs } from './freeform-figures.js';

describe('rewriteFigureRefs', () => {
  it('把 MinerU 的 images/ 相对引用改写成公开地址，保留 alt 文本', () => {
    const r = rewriteFigureRefs('如图所示 ![示意图](images/a.jpg) ，求角 A。', '/uploads/freeform/j1');
    expect(r.markdown).toBe('如图所示 ![示意图](/uploads/freeform/j1/a.jpg) ，求角 A。');
    expect(r.urls).toEqual(['/uploads/freeform/j1/a.jpg']);
  });

  it('多张图、同一张图重复引用时 urls 去重（正文仍逐处替换）', () => {
    const md = '![a](images/a.jpg)\n\n![b](images/b.png)\n\n再贴一次 ![a](images/a.jpg)';
    const r = rewriteFigureRefs(md, '/uploads/freeform/j1');
    expect(r.markdown.split('/uploads/freeform/j1/a.jpg')).toHaveLength(3);
    expect(r.markdown).toContain('/uploads/freeform/j1/b.png');
    expect(r.urls).toEqual(['/uploads/freeform/j1/a.jpg', '/uploads/freeform/j1/b.png']);
  });

  it('没有配图时原样返回', () => {
    const md = '纯文字题 ![x](https://cdn.example.com/a.jpg)';
    const r = rewriteFigureRefs(md, '/uploads/freeform/j1');
    expect(r.markdown).toBe(md);
    expect(r.urls).toEqual([]);
  });

  it('mapName 重命名（多页同名图加页前缀）后改写，urls 用新名字', () => {
    const r = rewriteFigureRefs(
      '![a](images/a.jpg)',
      '/uploads/freeform/j1',
      (name) => `fig-2-${name}`,
    );
    expect(r.markdown).toBe('![a](/uploads/freeform/j1/fig-2-a.jpg)');
    expect(r.urls).toEqual(['/uploads/freeform/j1/fig-2-a.jpg']);
  });
});

describe('figureRefs', () => {
  it('按出现顺序列出 images/ 相对引用', () => {
    expect(figureRefs('![a](images/a.jpg) 与 ![b](images/b.png)')).toEqual([
      'images/a.jpg',
      'images/b.png',
    ]);
  });

  it('忽略非 images/ 的图片与外链', () => {
    expect(figureRefs('![a](https://x/a.jpg) ![b](other/b.jpg)')).toEqual([]);
  });
});
