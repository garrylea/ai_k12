import { describe, it, expect } from 'vitest';
import { normalizeChineseAnswer, diffChinese } from './normalize-chinese.util.js';

describe('normalizeChineseAnswer', () => {
  it('去掉中文标点', () => {
    expect(normalizeChineseAnswer('床前明月光，疑是地上霜。')).toBe('床前明月光疑是地上霜');
  });

  it('去掉空白（含换行与全角空格）', () => {
    expect(normalizeChineseAnswer('床前 明月光\n疑是\t地上霜')).toBe('床前明月光疑是地上霜');
    expect(normalizeChineseAnswer('床前\u3000明月光')).toBe('床前明月光');
  });

  it('去掉书名号与引号', () => {
    expect(normalizeChineseAnswer('《岳阳楼记》「记」')).toBe('岳阳楼记记');
  });

  it('NFKC 全半角归一', () => {
    expect(normalizeChineseAnswer('Ａ１')).toBe('a1');
  });

  it('不做简繁转换', () => {
    expect(normalizeChineseAnswer('慶曆四年春')).toBe('慶曆四年春');
  });

  it('空值安全', () => {
    expect(normalizeChineseAnswer('')).toBe('');
    expect(normalizeChineseAnswer(undefined as unknown as string)).toBe('');
  });

  it('波浪号三种写法都忽略（全角 U+FF5E / 半角 U+007E / 波浪线 U+301C）', () => {
    // 归一化先 NFKC 再去标点：全角 ～ 会被 NFKC 变成半角 ~，
    // 故集合里必须同时有 ~ 与 〜，否则这个「忽略波浪号」的意图不会生效。
    expect(normalizeChineseAnswer('床前明月光～')).toBe('床前明月光');
    expect(normalizeChineseAnswer('床前明月光~')).toBe('床前明月光');
    expect(normalizeChineseAnswer('床前明月光〜')).toBe('床前明月光');
  });
});

describe('diffChinese', () => {
  it('完全相同 → 单个 equal', () => {
    expect(diffChinese('床前明月光', '床前明月光')).toEqual([{ type: 'equal', text: '床前明月光' }]);
  });

  it('错字 → equal + wrong', () => {
    expect(diffChinese('床前明月光', '床前明月先')).toEqual([
      { type: 'equal', text: '床前明月' },
      { type: 'wrong', expected: '光', actual: '先' },
    ]);
  });

  it('漏写 → missing', () => {
    expect(diffChinese('床前明月光', '床前明月')).toEqual([
      { type: 'equal', text: '床前明月' },
      { type: 'missing', text: '光' },
    ]);
  });

  it('多写 → extra', () => {
    expect(diffChinese('床前明月光', '床前明月光啊')).toEqual([
      { type: 'equal', text: '床前明月光' },
      { type: 'extra', text: '啊' },
    ]);
  });

  it('连续漏写合并成一段', () => {
    expect(diffChinese('床前明月光', '床前')).toEqual([
      { type: 'equal', text: '床前' },
      { type: 'missing', text: '明月光' },
    ]);
  });

  it('顺序颠倒不算全对', () => {
    const ops = diffChinese('明月', '月明');
    // 顺序颠倒时 LCS 仍会保留一个公共字（LCS('明月','月明') = 1），
    // 所以 diff 里出现 equal 是正常的；关键是它不能是「完全一致」那一种结果。
    expect(ops).not.toEqual([{ type: 'equal', text: '月明' }]);
    expect(ops.some((o) => o.type === 'wrong' || o.type === 'missing' || o.type === 'extra')).toBe(true);
  });
});
