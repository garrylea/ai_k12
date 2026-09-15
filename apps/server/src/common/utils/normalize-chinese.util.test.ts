import { describe, it, expect } from 'vitest';
import {
  normalizeChineseAnswer,
  diffChinese,
  diffChineseInOriginalText,
  evaluateDictation,
} from './normalize-chinese.util.js';

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

describe('diffChineseInOriginalText（展示带标点）', () => {
  it('相等段带上标点，错字段保持单字干净（标点不重复出现）', () => {
    const ops = diffChineseInOriginalText('床前明月光，疑是地上霜。', '床前明月先，疑是地上霜。');
    expect(ops).toEqual([
      { type: 'equal', text: '床前明月' },
      { type: 'wrong', expected: '光', actual: '先' },
      { type: 'equal', text: '，疑是地上霜。' },
    ]);
  });

  it('学生整篇不打标点，展示仍用 expected 侧的规范标点', () => {
    // 需求来源：判对错可以忽略标点，但给学生看的对比必须有标点，否则读不出句子。
    const ops = diffChineseInOriginalText('床前明月光，疑是地上霜。', '床前明月光疑是地上霜');
    expect(ops).toEqual([{ type: 'equal', text: '床前明月光，疑是地上霜。' }]);
  });

  it('整段漏写保留段内与段尾标点', () => {
    const ops = diffChineseInOriginalText(
      '塞下秋来风景异，衡阳雁去无留意。浊酒一杯家万里，燕然未勒归无计。',
      '塞下秋来风景异，衡阳雁去无留意。',
    );
    expect(ops).toEqual([
      { type: 'equal', text: '塞下秋来风景异，衡阳雁去无留意。' },
      { type: 'missing', text: '浊酒一杯家万里，燕然未勒归无计。' },
    ]);
  });

  it('多写字只展示多写的字本身，标点不重复出现在 equal 段与 extra 段', () => {
    const ops = diffChineseInOriginalText('床前明月光。', '床前明月光，啊。');
    expect(ops).toEqual([
      { type: 'equal', text: '床前明月光。' },
      { type: 'extra', text: '啊' },
    ]);
  });

  it('判对错口径不变：带不带标点都不影响 equal 判定', () => {
    const ops = diffChineseInOriginalText('床前明月光，疑是地上霜。', '床前明月光疑是地上霜');
    expect(ops.every((o) => o.type === 'equal')).toBe(true);
  });
});

describe('evaluateDictation', () => {
  const expected = { author: '李白', dynasty: '唐', body: '床前明月光，疑是地上霜。' };

  it('三项全对（忽略标点与空格）→ isCorrect=true，bodyDiff 为空', () => {
    const res = evaluateDictation(expected, { author: '李白', dynasty: '唐', body: '床前明月光疑是地上霜' });
    expect(res.isCorrect).toBe(true);
    expect(res.fields).toEqual({ author: { match: true }, dynasty: { match: true }, body: { match: true } });
    expect(res.bodyDiff).toEqual([]);
  });

  it('仅正文错一个字 → 定位到该字，且展示带标点', () => {
    const res = evaluateDictation(expected, { author: '李白', dynasty: '唐', body: '床前明月先，疑是地上霜。' });
    expect(res.isCorrect).toBe(false);
    expect(res.fields.body.match).toBe(false);
    expect(res.bodyDiff).toContainEqual({ type: 'wrong', expected: '光', actual: '先' });
  });

  it('仅作者错 → body 仍算对，bodyDiff 为空', () => {
    const res = evaluateDictation(expected, { author: '杜甫', dynasty: '唐', body: '床前明月光，疑是地上霜。' });
    expect(res.isCorrect).toBe(false);
    expect(res.fields).toEqual({ author: { match: false }, dynasty: { match: true }, body: { match: true } });
    expect(res.bodyDiff).toEqual([]);
  });
});
