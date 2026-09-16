import { describe, it, expect } from 'vitest';
import {
  normalizeEnglishAnswer,
  stripPosPrefix,
  spellingVariantKey,
  isEnglishWordMatch,
  splitGlossAtoms,
  isGlossMatch,
  normalizeChineseGloss,
  commonMeanings,
  extendedMeanings,
  extendedSenseIndexes,
  primaryGloss,
  computeHasExtendedSense,
  levelsForPool,
  diffWordChars,
  type EnglishWordMeaning,
} from './normalize-english.util.js';

// ---------------------------------------------------------------- 归一化

describe('stripPosPrefix', () => {
  it('剥掉带点的词性前缀', () => {
    expect(stripPosPrefix('n. 地址')).toBe('地址');
    expect(stripPosPrefix('adj.仔细的')).toBe('仔细的');
    expect(stripPosPrefix('vt. 处理')).toBe('处理');
  });

  it('剥掉不带点但带空格的词性前缀', () => {
    expect(stripPosPrefix('v 处理')).toBe('处理');
    expect(stripPosPrefix('adv 仔细地')).toBe('仔细地');
  });

  it('不误伤以词性缩写开头的真词（no / art / plenty）', () => {
    // `n` + `o`：`no` 的 n 后面既不是点也不是空白，不该被剥
    expect(stripPosPrefix('no')).toBe('no');
    // `art` 本身是词表里的词，且后面没有分隔符
    expect(stripPosPrefix('art')).toBe('art');
    // `pl` 前缀后面是 `e`，不构成词性标记
    expect(stripPosPrefix('plenty')).toBe('plenty');
  });

  it('只有词性前缀时返回空串', () => {
    expect(stripPosPrefix('adv.')).toBe('');
    expect(stripPosPrefix('n.')).toBe('');
  });
});

describe('normalizeEnglishAnswer', () => {
  it('转小写并去首尾空白', () => {
    expect(normalizeEnglishAnswer('  Chinese  ')).toBe('chinese');
    expect(normalizeEnglishAnswer('ADDRESS')).toBe('address');
  });

  it('去掉末尾标点', () => {
    expect(normalizeEnglishAnswer('chinese.')).toBe('chinese');
    expect(normalizeEnglishAnswer('chinese。')).toBe('chinese');
    expect(normalizeEnglishAnswer('chinese,')).toBe('chinese');
  });

  it('去掉首尾引号', () => {
    expect(normalizeEnglishAnswer('"address"')).toBe('address');
    expect(normalizeEnglishAnswer('“address”')).toBe('address');
  });

  it('内部空白折叠为单个空格', () => {
    expect(normalizeEnglishAnswer('ice   cream')).toBe('ice cream');
    expect(normalizeEnglishAnswer('ice\tcream')).toBe('ice cream');
  });

  it('剥词性前缀', () => {
    expect(normalizeEnglishAnswer('n. address')).toBe('address');
  });

  it('空输入安全', () => {
    expect(normalizeEnglishAnswer('')).toBe('');
    expect(normalizeEnglishAnswer(undefined as unknown as string)).toBe('');
  });
});

// ---------------------------------------------------------------- 中→英 判对错

describe('isEnglishWordMatch', () => {
  it('完全相等', () => {
    expect(isEnglishWordMatch('chinese', 'chinese')).toBe(true);
  });

  it('忽略大小写与首尾空白', () => {
    expect(isEnglishWordMatch('  Chinese ', 'chinese')).toBe(true);
    expect(isEnglishWordMatch('ADDRESS', 'address')).toBe(true);
  });

  it('忽略末尾句号（学生顺手打句号）', () => {
    expect(isEnglishWordMatch('chinese.', 'chinese')).toBe(true);
  });

  it('接受人工整理的拼写变体（英式 / 美式）', () => {
    expect(isEnglishWordMatch('color', 'colour')).toBe(true);
    expect(isEnglishWordMatch('colour', 'color')).toBe(true);
    expect(isEnglishWordMatch('center', 'centre')).toBe(true);
    expect(isEnglishWordMatch('realize', 'realise')).toBe(true);
    expect(isEnglishWordMatch('traveling', 'travelling')).toBe(true);
    expect(isEnglishWordMatch('program', 'programme')).toBe(true);
  });

  it('连字符与空格等价，但只在正确答案本身含连字符或空格时生效', () => {
    expect(isEnglishWordMatch('ice cream', 'ice-cream')).toBe(true);
    expect(isEnglishWordMatch('icecream', 'ice-cream')).toBe(true);
    expect(isEnglishWordMatch('ice-cream', 'ice cream')).toBe(true);
    expect(isEnglishWordMatch('email', 'e-mail')).toBe(true);
  });

  it('单词题不因宽松键而误判（a part ≠ apart，no one ≠ noone）', () => {
    // 正确答案是单词，学生却写成两个词 —— 必须判错
    expect(isEnglishWordMatch('a part', 'apart')).toBe(false);
    expect(isEnglishWordMatch('no one', 'noone')).toBe(false);
    // 正确答案是单词，学生加了空格
    expect(isEnglishWordMatch('i ce', 'ice')).toBe(false);
  });

  it('不剥撇号：its / it’s 与 were / we’re 必须判错', () => {
    // 这两组正是要抓的错，剥了撇号就等于放过
    expect(isEnglishWordMatch("it's", 'its')).toBe(false);
    expect(isEnglishWordMatch('its', "it's")).toBe(false);
    expect(isEnglishWordMatch("we're", 'were')).toBe(false);
    expect(isEnglishWordMatch('were', "we're")).toBe(false);
  });

  it('拼错一个字母判错', () => {
    expect(isEnglishWordMatch('chines', 'chinese')).toBe(false);
    expect(isEnglishWordMatch('adress', 'address')).toBe(false);
  });

  it('完全不同判错', () => {
    expect(isEnglishWordMatch('中文', 'chinese')).toBe(false);
  });

  it('空答案与空正确答案都判错（不因两边都归一化成空串而误判对）', () => {
    expect(isEnglishWordMatch('', 'chinese')).toBe(false);
    expect(isEnglishWordMatch('chinese', '')).toBe(false);
    expect(isEnglishWordMatch('   ', '  ')).toBe(false);
  });
});

describe('spellingVariantKey', () => {
  it('同组词得到同一个规范键', () => {
    expect(spellingVariantKey('color')).toBe(spellingVariantKey('colour'));
    expect(spellingVariantKey('realize')).toBe(spellingVariantKey('realise'));
    expect(spellingVariantKey('travelling')).toBe(spellingVariantKey('traveling'));
  });

  it('不在任何组里的词返回 null（不胡乱归组）', () => {
    expect(spellingVariantKey('chinese')).toBeNull();
    expect(spellingVariantKey('address')).toBeNull();
    // 只差一个字母但不是拼写变体的词，绝不能归到同组
    expect(spellingVariantKey('story')).toBeNull();
  });

  it('刻意排除「看着像变体但其实多一个义项」的危险组', () => {
    // 收进组里就会把错答案判对：story 多出「故事」、meter 多出「仪表」、
    // tire 多出「疲劳」、curb 多出「抑制」、draft 多出「草稿」。
    // 这几条是钉子——想重新加进变体表之前先想清楚为什么。
    expect(spellingVariantKey('story')).toBeNull();
    expect(spellingVariantKey('storey')).toBeNull();
    expect(spellingVariantKey('meter')).toBeNull();
    expect(spellingVariantKey('metre')).toBeNull();
    expect(spellingVariantKey('tire')).toBeNull();
    expect(spellingVariantKey('tyre')).toBeNull();
    expect(spellingVariantKey('curb')).toBeNull();
    expect(spellingVariantKey('kerb')).toBeNull();
    expect(spellingVariantKey('draft')).toBeNull();
    expect(spellingVariantKey('draught')).toBeNull();
  });

  it('危险组里的词也不能互相判对', () => {
    expect(isEnglishWordMatch('storey', 'story')).toBe(false);
    expect(isEnglishWordMatch('meter', 'metre')).toBe(false);
    expect(isEnglishWordMatch('tyre', 'tire')).toBe(false);
    expect(isEnglishWordMatch('kerb', 'curb')).toBe(false);
    expect(isEnglishWordMatch('draught', 'draft')).toBe(false);
  });

  it('归一化后再查组（大小写与首尾空白不影响）', () => {
    expect(spellingVariantKey(' COLOR ')).toBe(spellingVariantKey('colour'));
  });
});

// ---------------------------------------------------------------- 释义原子拆分

describe('splitGlossAtoms', () => {
  it('按中文分号拆', () => {
    expect(splitGlossAtoms('照顾；小心')).toEqual(['照顾', '小心']);
  });

  it('按多种分隔符拆（中英文分号逗号、顿号、斜杠、竖线）', () => {
    expect(splitGlossAtoms('处理;对付,问题、题目/答案|回复')).toEqual([
      '处理',
      '对付',
      '问题',
      '题目',
      '答案',
      '回复',
    ]);
  });

  it('带括号的释义同时产出「含括号」与「去括号」两个原子', () => {
    expect(splitGlossAtoms('处理；对付（问题）')).toEqual(['处理', '对付（问题）', '对付']);
  });

  it('去重且保序', () => {
    expect(splitGlossAtoms('地址；地址；住址')).toEqual(['地址', '住址']);
  });

  it('剥掉原子上的词性前缀', () => {
    expect(splitGlossAtoms('n. 地址；v. 处理')).toEqual(['地址', '处理']);
  });

  it('空串与空括号不产出空原子', () => {
    expect(splitGlossAtoms('')).toEqual([]);
    expect(splitGlossAtoms('地址；')).toEqual(['地址']);
    expect(splitGlossAtoms('地址（）')).toEqual(['地址']);
  });
});

describe('normalizeChineseGloss', () => {
  it('去空白与中英文标点、转小写', () => {
    expect(normalizeChineseGloss(' 照顾 、关心。 ')).toBe('照顾关心');
    expect(normalizeChineseGloss('ABC')).toBe('abc');
  });

  it('先剥词性前缀再去标点（顺序不能反）', () => {
    // 若先去标点，`n. 地址` 会变成 `n地址`，词性前缀就认不出来了
    expect(normalizeChineseGloss('n. 地址')).toBe('地址');
  });

  it('全半角归一', () => {
    expect(normalizeChineseGloss('ＡＢＣ')).toBe('abc');
  });
});

// ---------------------------------------------------------------- 英→中 判对错

describe('isGlossMatch', () => {
  it('命中任一原子即算对', () => {
    expect(isGlossMatch('照顾', ['照顾；小心'])).toBe(true);
    expect(isGlossMatch('小心', ['照顾；小心'])).toBe(true);
  });

  it('忽略标点、空白与全半角', () => {
    expect(isGlossMatch('照顾。', ['照顾；小心'])).toBe(true);
    expect(isGlossMatch(' 照顾 ', ['照顾'])).toBe(true);
  });

  it('答带括号的完整释义算对', () => {
    expect(isGlossMatch('对付（问题）', ['处理；对付（问题）'])).toBe(true);
  });

  it('同义但不同词不命中，留给 LLM 判（「照料」≠「照顾」）', () => {
    expect(isGlossMatch('照料', ['照顾；小心'])).toBe(false);
  });

  it('不做包含匹配：「使用」不能命中「不使用」', () => {
    // 这是刻意收紧的口径——用包含会让反义噪声判对
    expect(isGlossMatch('使用', ['不使用'])).toBe(false);
    expect(isGlossMatch('不使用', ['使用'])).toBe(false);
  });

  it('多释义组里命中任一组都算对', () => {
    expect(isGlossMatch('地址', ['地址', '演说；演讲'])).toBe(true);
    expect(isGlossMatch('演讲', ['地址', '演说；演讲'])).toBe(true);
  });

  it('空答案判错', () => {
    expect(isGlossMatch('', ['照顾'])).toBe(false);
    expect(isGlossMatch('   ', ['照顾'])).toBe(false);
  });

  it('空释义列表判错', () => {
    expect(isGlossMatch('照顾', [])).toBe(false);
  });
});

// ---------------------------------------------------------------- 义项取值

const ADDRESS: EnglishWordMeaning[] = [
  { pos: 'n.', gloss: '地址', extended: false },
  { pos: 'n.', gloss: '演说；演讲', extended: false },
  {
    pos: 'v.',
    gloss: '处理；对付（问题）',
    extended: true,
    context: 'address the problem',
    note: '中高考阅读完型高频僻义',
  },
];

const CARE: EnglishWordMeaning[] = [{ pos: 'n.', gloss: '照顾；小心', extended: false }];

describe('义项分组', () => {
  it('commonMeanings 只返回非僻义义项', () => {
    expect(commonMeanings(ADDRESS).map((m) => m.gloss)).toEqual(['地址', '演说；演讲']);
    expect(commonMeanings(CARE).length).toBe(1);
  });

  it('extendedMeanings 只返回僻义义项', () => {
    expect(extendedMeanings(ADDRESS).map((m) => m.gloss)).toEqual(['处理；对付（问题）']);
    expect(extendedMeanings(CARE)).toEqual([]);
  });

  it('extendedSenseIndexes 给出僻义在 meanings 里的下标', () => {
    expect(extendedSenseIndexes(ADDRESS)).toEqual([2]);
    expect(extendedSenseIndexes(CARE)).toEqual([]);
  });

  it('primaryGloss 取第一个非僻义义项，不会取到僻义', () => {
    expect(primaryGloss(ADDRESS)).toBe('地址');
    expect(primaryGloss(CARE)).toBe('照顾；小心');
  });

  it('primaryGloss 没有非僻义义项时退回首义项，空数组返回空串', () => {
    const onlyExtended: EnglishWordMeaning[] = [
      { pos: 'v.', gloss: '处理', extended: true, context: 'address the problem' },
    ];
    expect(primaryGloss(onlyExtended)).toBe('处理');
    expect(primaryGloss([])).toBe('');
  });
});

describe('computeHasExtendedSense', () => {
  it('有僻义义项给 1', () => {
    expect(computeHasExtendedSense(ADDRESS)).toBe(1);
  });

  it('无僻义义项给 0', () => {
    expect(computeHasExtendedSense(CARE)).toBe(0);
    expect(computeHasExtendedSense([])).toBe(0);
  });
});

// ---------------------------------------------------------------- 词库范围

describe('levelsForPool', () => {
  it('junior 含 primary（小学词并入初中池，不单列一档）', () => {
    expect(levelsForPool('junior')).toEqual(['primary', 'junior']);
  });

  it('senior 只含高中两层，绝不落回初中', () => {
    expect(levelsForPool('senior')).toEqual(['senior_required', 'senior_elective']);
    expect(levelsForPool('senior')).not.toContain('junior');
    expect(levelsForPool('senior')).not.toContain('primary');
  });

  it('all 含四层', () => {
    expect(levelsForPool('all')).toEqual([
      'primary',
      'junior',
      'senior_required',
      'senior_elective',
    ]);
  });

  it('返回的是新数组，调用方改动不会污染内部常量', () => {
    const first = levelsForPool('all');
    first.push('junior');
    expect(levelsForPool('all').length).toBe(4);
  });
});

// ---------------------------------------------------------------- 拼写差异视图

describe('diffWordChars', () => {
  it('完全相同只产出一个 equal', () => {
    expect(diffWordChars('chinese', 'chinese')).toEqual([{ type: 'equal', text: 'chinese' }]);
  });

  it('忽略大小写（大小写不同不算错）', () => {
    expect(diffWordChars('Chinese', 'chinese')).toEqual([{ type: 'equal', text: 'Chinese' }]);
  });

  it('漏字母时标出缺失', () => {
    const ops = diffWordChars('adress', 'address');
    // 学生少了一个 d，正确答案里多出的那个 d 必须出现在 wrong.expected
    expect(ops.some((op) => op.type === 'wrong' && op.expected === 'd')).toBe(true);
  });

  it('错字母时同时给出学生写的与正确的', () => {
    const ops = diffWordChars('chineze', 'chinese');
    const wrong = ops.find((op) => op.type === 'wrong');
    expect(wrong).toEqual({ type: 'wrong', actual: 'z', expected: 's' });
  });

  it('合并相邻的同类差异，避免碎片化', () => {
    const ops = diffWordChars('xy', 'ab');
    expect(ops).toEqual([{ type: 'wrong', actual: 'xy', expected: 'ab' }]);
  });

  it('空串边界安全', () => {
    expect(diffWordChars('', 'abc')).toEqual([{ type: 'wrong', actual: '', expected: 'abc' }]);
    expect(diffWordChars('abc', '')).toEqual([{ type: 'wrong', actual: 'abc', expected: '' }]);
    expect(diffWordChars('', '')).toEqual([]);
  });
});
