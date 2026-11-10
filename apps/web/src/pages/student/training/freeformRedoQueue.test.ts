import { afterEach, describe, expect, it } from 'vitest';
import {
  FREEFORM_REDO_KEY,
  clearRedoQueue,
  extractRedoFigures,
  readRedoQueue,
  saveRedoQueue,
  updateRedoIndex,
  type FreeformRedoQueue,
} from './freeformRedoQueue';

afterEach(() => {
  clearRedoQueue();
});

const QUEUE: FreeformRedoQueue = {
  subjectId: 1,
  items: [
    {
      errorBookId: 440,
      questionId: 7091,
      questionText: '已知 $x+1=2$，求 $x$。',
      type: 'short_answer',
      fullScore: 10,
    },
    {
      errorBookId: 441,
      questionId: 7092,
      questionText: '求 $1+1$。',
      type: 'calculation',
      fullScore: null,
    },
  ],
  index: 0,
};

describe('freeformRedoQueue', () => {
  it('写入 → 读取 → 推进下标 → 清空', () => {
    saveRedoQueue(QUEUE);
    expect(readRedoQueue()).toEqual(QUEUE);

    updateRedoIndex(1);
    expect(readRedoQueue()?.index).toBe(1);

    clearRedoQueue();
    expect(readRedoQueue()).toBeNull();
  });

  it('坏 JSON / 空题单 / 下标越界 / 非法 id → 返回 null 并清键', () => {
    expect(readRedoQueue()).toBeNull();

    sessionStorage.setItem(FREEFORM_REDO_KEY, '{bad');
    expect(readRedoQueue()).toBeNull();
    expect(sessionStorage.getItem(FREEFORM_REDO_KEY)).toBeNull();

    saveRedoQueue({ ...QUEUE, items: [] });
    expect(readRedoQueue()).toBeNull();

    saveRedoQueue({ ...QUEUE, index: 2 });
    expect(readRedoQueue()).toBeNull();

    saveRedoQueue({ ...QUEUE, items: [{ ...QUEUE.items[0], questionId: 0 }] });
    expect(readRedoQueue()).toBeNull();

    saveRedoQueue({ ...QUEUE, items: [{ ...QUEUE.items[0], questionText: '   ' }] });
    expect(readRedoQueue()).toBeNull();

    saveRedoQueue({ ...QUEUE, items: [{ ...QUEUE.items[0], fullScore: 0 }] });
    expect(readRedoQueue()).toBeNull();
  });

  it('updateRedoIndex 越界不写', () => {
    saveRedoQueue(QUEUE);
    updateRedoIndex(5);
    expect(readRedoQueue()?.index).toBe(0);
    updateRedoIndex(-1);
    expect(readRedoQueue()?.index).toBe(0);
  });

  it('extractRedoFigures：只取 /uploads/freeform/、去重、最多 6 张', () => {
    const content = [
      '![配图1](/uploads/freeform/a/1.png)',
      '![配图1](/uploads/freeform/a/1.png)', // 重复
      '![普通图](/assets/fig.png)',
      '![配图2](/uploads/freeform/a/2.png "标题")',
      ...Array.from({ length: 6 }, (_, i) => `![x](/uploads/freeform/a/x${i}.jpg)`),
    ].join('\n');

    const figures = extractRedoFigures(content);
    expect(figures).toHaveLength(6);
    expect(figures[0]).toBe('/uploads/freeform/a/1.png');
    expect(figures[1]).toBe('/uploads/freeform/a/2.png');
    expect(figures).not.toContain('/assets/fig.png');
    expect(new Set(figures).size).toBe(figures.length);
  });

  it('extractRedoFigures：没有配图返回空数组', () => {
    expect(extractRedoFigures('纯文字题')).toEqual([]);
    expect(extractRedoFigures('![x](/uploads/answer/a.png)')).toEqual([]);
  });
});
