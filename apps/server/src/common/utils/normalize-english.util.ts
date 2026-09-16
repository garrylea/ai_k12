import { PREFIX_STRIP } from './content-hash.util.js';

/**
 * 英语背单词判题口径（纯函数，无 IO）。
 *
 * 三条判题路由都收敛到这里，服务层只负责挑路由、调 LLM、记账：
 *   1. 答案是英文单词的方向（中→英、看音标写单词）：`isEnglishWordMatch` —— 纯程序，答案唯一，不调 LLM
 *   2. 英→中（普通）：`isGlossMatch` 对**非僻义义项组**做程序短路，未命中才调 LLM
 *   3. 英→中（僻义）：`isGlossMatch` 对**单个 extended 义项**做程序短路，未命中调 LLM 判三档
 *
 * 设计要点（改这里之前先读）：
 * - **程序短路的口径是「归一化后相等」，不是包含**。用包含会让「使用」命中「不使用」这类
 *   反义噪声，宁可漏给 LLM 判，也不能错判对。
 * - **拼写变体走人工整理的组表，不用规则推导**。`-ise/-ize`、`-our/-or` 看着能规则化，
 *   但规则会误伤（如 `sise`），而组表是逐条可核对的——宁可少收，也不要假阳性。
 * - **连字符/空格只在正确答案本身含连字符或空格时才放宽**。否则 `a part` 会命中 `apart`、
 *   `no one` 会命中 `noone`；单词题必须严格。
 * - **不剥离撇号**：`its`/`it's`、`were`/`we're` 正是要抓的错，剥了就等于放过。
 */

// ---------------------------------------------------------------- 领域类型

/** 词库分层。与课标原文一一对应，页面只暴露三档（见 levelsForPool）。 */
export type EnglishLevel = 'primary' | 'junior' | 'senior_required' | 'senior_elective';

/** 配置页暴露的三档词库范围。 */
export type LevelPool = 'junior' | 'senior' | 'all';

export const ENGLISH_LEVELS: readonly EnglishLevel[] = [
  'primary',
  'junior',
  'senior_required',
  'senior_elective',
];

/**
 * 一个义项。
 * - `extended: true` = 熟词僻义（熟词的不常见含义，中高考阅读完型高频考点），
 *   **必须**带 `context`（锁定僻义的搭配/短例），因为僻义题就是靠它出题的。
 * - 不变式：一个词的 meanings 至少有一个 `extended: false` 义项。
 */
export interface EnglishWordMeaning {
  pos: string;
  gloss: string;
  extended: boolean;
  context?: string;
  note?: string;
}

/** 词根族成员相对族中心的词缀注记。 */
export interface RootAffix {
  type: 'prefix' | 'suffix';
  code: string;
  gloss: string;
  posHint?: string;
}

/**
 * 判题结论五档。
 * - `off_target`：「答成常见义」——学生答的没错，但没答到本题考的僻义。
 *   **不计错**（不动学生 wrong_count，也不动全局 error_count）。
 * - `unanswered`：显式点「不认识」。同样不计错——「不会」不等于「易错」。
 * - `undetermined`：LLM 判题失败。不计错，也不能判错——判题失败不该让学生背锅。
 */
export type VocabularyVerdict =
  | 'correct'
  | 'off_target'
  | 'wrong'
  | 'unanswered'
  | 'undetermined';

/** 判定方式。`exact` = 程序短路命中；`ai` = LLM 判定。 */
export type VocabularyJudgeMethod = 'exact' | 'ai';

/**
 * 判题结论 → 进度增量。**全系统唯一一处记账规则**，仓储层只收增量、不含规则。
 *
 * 只有 `correct` 置 learned、只有 `wrong` 加错次；`off_target`（答成常见义，学生答的没错
 * 只是没答到考点）、`unanswered`（显式点「不认识」）、`undetermined`（LLM 判题失败）
 * **三者全都不计错**——「不会」不等于「易错」，判题失败更不该让学生背锅。
 * 全局 `english_words.error_count` 用同一个 `wrongDelta` 决定是否自增，两处口径必须一致。
 */
export function progressDelta(verdict: VocabularyVerdict): {
  learned: 0 | 1;
  wrongDelta: 0 | 1;
} {
  return {
    learned: verdict === 'correct' ? 1 : 0,
    wrongDelta: verdict === 'wrong' ? 1 : 0,
  };
}

// ---------------------------------------------------------------- 归一化

/** 词性缩写。要求后面跟 `.` 或空白才算，避免把 `no` 的 n、`art` 的 art 误当词性剥掉。 */
const POS_PREFIX_RE =
  /^(?:n|v|vt|vi|adj|adv|prep|conj|pron|num|art|int|aux|det|pl|abbr)(?:\.|\s)+/i;

/** 剥掉答案开头的词性标注：`n. 地址` → `地址`、`v 处理` → `处理`。 */
export function stripPosPrefix(s: string): string {
  return (s ?? '').replace(POS_PREFIX_RE, '').trim();
}

/**
 * 英文答案归一化。用于**拼写**比对（中→英方向），不用于中文释义。
 * NFKC → 小写 → trim → 内部空白折叠为单个空格 → 去首尾引号 → 去末尾标点 → 剥词性前缀。
 *
 * 注意顺序：先折叠空白再去末尾标点，这样 `ice cream .` 也能收干净。
 */
export function normalizeEnglishAnswer(s: string): string {
  let out = (s ?? '').normalize('NFKC').toLowerCase().trim();
  out = out.replace(/\s+/g, ' ');
  out = out.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '');
  out = out.replace(/[.,!?;:、。！？；：]+$/g, '');
  return stripPosPrefix(out);
}

/**
 * 去掉连字符与空格的宽松键。**只在正确答案本身含连字符或空格时**才用它兜底
 * （见 isEnglishWordMatch 的注释），单独使用会造成大量假阳性。
 */
function looseEnglishKey(s: string): string {
  return s.replace(/[-\s]/g, '');
}

// ---------------------------------------------------------------- 拼写变体

/**
 * 人工整理的拼写变体组（英式/美式同词异拼，含义完全相同）。
 * 组内**任意两成员互相接受**。加一条就是加一行，不要改成规则推导（见文件头注释）。
 *
 * ⚠️ 收录门槛：**组内每个成员的含义必须完全相同**。只要有一个成员多出别的义项就不能收，
 * 否则会把错答案判对。因此下面这几组**刻意排除**（它们看着像变体，其实不是）：
 *   storey(楼层) / story(故事)      —— story 多出「故事」
 *   metre(米)    / meter(仪表)      —— meter 多出「仪表」
 *   tyre(轮胎)   / tire(疲劳)       —— tire 多出「疲劳」
 *   kerb(路缘)   / curb(抑制)       —— curb 多出「抑制」
 *   draught(气流)/ draft(草稿)      —— draft 多出「草稿、征兵」
 * 代价是学生写美式拼写时会被判错；但这个方向（多判错）比「把错答案判对」安全，
 * 且教学以教材的英式拼写为准。normalize-english.util.test.ts 有对应的钉子用例。
 */
const SPELLING_VARIANT_GROUPS: readonly string[][] = [
  // -our / -or
  ['colour', 'color'],
  ['favourite', 'favorite'],
  ['honour', 'honor'],
  ['labour', 'labor'],
  ['neighbour', 'neighbor'],
  ['behaviour', 'behavior'],
  ['flavour', 'flavor'],
  ['humour', 'humor'],
  ['rumour', 'rumor'],
  ['vapour', 'vapor'],
  // -re / -er（不含 metre/meter，见上方排除清单）
  ['centre', 'center'],
  ['litre', 'liter'],
  ['theatre', 'theater'],
  ['fibre', 'fiber'],
  // -ise / -ize（K12 词表内的常见词）
  ['realise', 'realize'],
  ['organise', 'organize'],
  ['recognise', 'recognize'],
  ['apologise', 'apologize'],
  ['memorise', 'memorize'],
  ['criticise', 'criticize'],
  ['analyse', 'analyze'],
  ['paralyse', 'paralyze'],
  // 双写辅音（英式） / 单写（美式）
  ['travelling', 'traveling'],
  ['travelled', 'traveled'],
  ['traveller', 'traveler'],
  ['cancelled', 'canceled'],
  ['modelling', 'modeling'],
  ['labelled', 'labeled'],
  ['quarrelling', 'quarreling'],
  ['skilful', 'skillful'],
  ['fulfil', 'fulfill'],
  ['enrolment', 'enrollment'],
  ['instalment', 'installment'],
  // 其它高频异拼
  ['programme', 'program'],
  ['catalogue', 'catalog'],
  ['dialogue', 'dialog'],
  ['grey', 'gray'],
  ['plough', 'plow'],
  ['aluminium', 'aluminum'],
  ['defence', 'defense'],
  ['offence', 'offense'],
  ['licence', 'license'],
  ['pretence', 'pretense'],
  ['jewellery', 'jewelry'],
  ['judgement', 'judgment'],
  ['acknowledgement', 'acknowledgment'],
  ['practise', 'practice'],
  ['moustache', 'mustache'],
  ['aeroplane', 'airplane'],
  ['e-mail', 'email'],
];

/** 归一化拼写 → 组内规范键。不在任何组里返回 null。 */
const SPELLING_VARIANT_KEY: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const group of SPELLING_VARIANT_GROUPS) {
    const canonical = normalizeEnglishAnswer(group[0]);
    for (const member of group) {
      map.set(normalizeEnglishAnswer(member), canonical);
    }
  }
  return map;
})();

/** 取拼写变体组的规范键；不在任何组里返回 null。 */
export function spellingVariantKey(word: string): string | null {
  return SPELLING_VARIANT_KEY.get(normalizeEnglishAnswer(word)) ?? null;
}

// ---------------------------------------------------------------- 中→英判对错

/**
 * 中→英：学生答案是否为正确答案（或它的拼写变体）。
 *
 * 判据依次为：
 *   1. 归一化后完全相等（覆盖大小写、首尾空白、末尾句号、词性前缀）
 *   2. 同属一个拼写变体组（colour / color）
 *   3. 正确答案本身含连字符或空格时，去掉连字符与空格后相等（ice-cream / ice cream / icecream）
 *
 * 第 3 条的门槛是刻意的：单词题要求严格，`a part` / `apart` 不是同一个词。
 */
export function isEnglishWordMatch(studentAnswer: string, expectedWord: string): boolean {
  const s = normalizeEnglishAnswer(studentAnswer);
  const e = normalizeEnglishAnswer(expectedWord);
  if (!s || !e) return false;
  if (s === e) return true;

  const variantS = spellingVariantKey(s);
  const variantE = spellingVariantKey(e);
  if (variantS !== null && variantS === variantE) return true;

  if (/[-\s]/.test(e)) return looseEnglishKey(s) === looseEnglishKey(e);
  return false;
}

// ---------------------------------------------------------------- 释义原子拆分

/** 释义内部的义项分隔符：中英文分号、逗号、顿号、斜杠、竖线。 */
const GLOSS_SPLIT_RE = /[;；,，、/|｜]+/;
/** 括号及其内容（中英文括号）。`对付（问题）` 既要保留原样，也要能取到 `对付`。 */
const PAREN_RE = /[（(][^）)]*[）)]/g;
/** 释义开头「…的」「…地」之类的词尾提示，不去掉；这里只去掉空括号残留。 */
const EMPTY_PAREN_RE = /[（(]\s*[）)]/g;

/**
 * 把一个释义拆成若干**可接受的答案原子**。
 *
 *   处理；对付（问题）  →  ['处理', '对付（问题）', '对付']
 *   照顾；小心          →  ['照顾', '小心']
 *   地址                →  ['地址']
 *
 * 每个原子都被归一化（剥词性前缀、去首尾空白、NFKC）。去重且保序。
 * 括号内为空时只留去括号的形式，避免产出空原子。
 *
 * 与 refinery 侧 `vocabulary_check.py` 的 `gloss_atoms`（Plan B 落地）**同一套规则**，
 * 改一边要同步另一边。
 */
export function splitGlossAtoms(gloss: string): string[] {
  // 先把空括号删掉，免得产出 `地址()` 这种噪声原子。
  // 刻意**不整体 NFKC**：原子保留源文的全角括号，人工审阅词库时看到的就是教材原样；
  // 比较时由 normalizeChineseGloss 统一做全半角归一，不影响判对错。
  const raw = (gloss ?? '').replace(EMPTY_PAREN_RE, '');
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (value: string) => {
    const atom = stripPosPrefix(value.trim());
    if (!atom) return;
    if (seen.has(atom)) return;
    seen.add(atom);
    out.push(atom);
  };

  for (const piece of raw.split(GLOSS_SPLIT_RE)) {
    const withParen = stripPosPrefix(piece.trim());
    if (!withParen) continue;
    push(withParen);
    // 括号内为空时，去括号的形式与原文相同，不必重复登记
    const withoutParen = stripPosPrefix(piece.replace(PAREN_RE, '').trim());
    if (withoutParen && withoutParen !== withParen) push(withoutParen);
  }
  return out;
}

/**
 * 英→中：学生答案是否命中了给定释义里的任一个可接受原子。
 * `glosses` 传「本题认可的释义集合」：普通模式传全部非僻义义项，僻义模式只传目标僻义义项。
 *
 * 判据是**归一化后相等**（不区分全半角、标点、空白），刻意不做包含匹配。
 */
export function isGlossMatch(studentAnswer: string, glosses: readonly string[]): boolean {
  const s = normalizeChineseGloss(studentAnswer);
  if (!s) return false;
  for (const gloss of glosses) {
    for (const atom of splitGlossAtoms(gloss)) {
      if (normalizeChineseGloss(atom) === s) return true;
    }
  }
  return false;
}

/**
 * 中文释义归一化：NFKC → 剥词性前缀 → 去所有空白与中英文标点 → 转小写。
 * 复用 content-hash.util 的 PREFIX_STRIP，保证全仓只有一套标点表（同 normalizeChineseAnswer）。
 *
 * 注意顺序：**必须先剥词性前缀再去标点**。PREFIX_STRIP 会把 `.` 和空格一起吃掉，
 * 先跑它的话 `n. 地址` 就变成 `n地址`，词性前缀再也认不出来。
 */
export function normalizeChineseGloss(s: string): string {
  return stripPosPrefix((s ?? '').normalize('NFKC')).replace(PREFIX_STRIP, '').toLowerCase();
}

// ---------------------------------------------------------------- 义项取值

/** 非僻义（常见）义项。普通模式判对错只认这些。 */
export function commonMeanings(meanings: readonly EnglishWordMeaning[]): EnglishWordMeaning[] {
  return meanings.filter((m) => !m.extended);
}

/** 熟词僻义义项。**每个各成一道题**（senseIndex 指向它在 meanings 里的下标）。 */
export function extendedMeanings(meanings: readonly EnglishWordMeaning[]): EnglishWordMeaning[] {
  return meanings.filter((m) => m.extended);
}

/** 僻义义项在 meanings 里的下标列表。抽「只出熟词僻义」的池子与出题都用它。 */
export function extendedSenseIndexes(meanings: readonly EnglishWordMeaning[]): number[] {
  const out: number[] = [];
  meanings.forEach((m, i) => {
    if (m.extended) out.push(i);
  });
  return out;
}

/**
 * 中→英题面用的中文释义：取第一个非僻义义项的 gloss。
 *
 * 刻意取「第一个」而不是随机：一是可复现（同一次抽题结果稳定、测试好写），
 * 二是中→英只在普通模式出现（僻义模式强制英→中，见服务层），
 * 所以「考哪个义项」这个问题在中→英里根本不存在。
 * 没有非僻义义项时退回首义项，义项为空时返回空串（调用方据此过滤掉该词）。
 */
export function primaryGloss(meanings: readonly EnglishWordMeaning[]): string {
  return commonMeanings(meanings)[0]?.gloss ?? meanings[0]?.gloss ?? '';
}

/**
 * 音标是否可用于出「看音标写单词」题。
 *
 * `phonetic` 列可空，且课本抽取会产出 **空音标**（只有一对斜杠）——那种音标当题面等于
 * 让学生对着 `//` 猜单词。判据：去掉斜杠与空白后还有内容才算可用。
 * 返回 false 时调用方要**退化成别的方向**，而不是把这个词丢掉（同「没有可用中文释义」的处理）。
 */
export function isUsablePhonetic(phonetic: string | null | undefined): boolean {
  return (phonetic ?? '').replace(/[/\s]/g, '') !== '';
}

/**
 * 由 meanings 推 has_extended_sense 列的值。
 * 这列是冗余的（存在理由见 schema 注释：MySQL 搜不了 JSON 里的布尔值），
 * 一致性由内容管线 check 与仓储测试兜住，这里给出唯一权威算法免得两处各写一遍。
 */
export function computeHasExtendedSense(meanings: readonly EnglishWordMeaning[]): 0 | 1 {
  return extendedMeanings(meanings).length > 0 ? 1 : 0;
}

// ---------------------------------------------------------------- 词库范围

/**
 * 配置页三档 → 实际参与抽题的 level 列表。
 *
 * `junior` 含 `primary`：小学二级 505 词对初高中生是已会词，但它们属于义务教育 1600 词
 * 的一部分（课标 2022 版的口径就是 1600 = 小学 505 + 初中 ~1095），页面不单独列一档，
 * 直接并入初中池。不想要它们的唯一后果是多抽到几个简单词，比漏词好。
 */
export function levelsForPool(pool: LevelPool): EnglishLevel[] {
  switch (pool) {
    case 'junior':
      return ['primary', 'junior'];
    case 'senior':
      return ['senior_required', 'senior_elective'];
    case 'all':
      return [...ENGLISH_LEVELS];
  }
}

// ---------------------------------------------------------------- 拼写差异视图

/** 逐字符差异。与 DictationDiffOp 的 `wrong` 同形，便于前端复用渲染思路。 */
export type WordCharDiffOp =
  | { type: 'equal'; text: string }
  | { type: 'wrong'; actual: string; expected: string };

/**
 * 学生答案与正确答案的逐字符差异（LCS 对齐，比较时忽略大小写，输出保留原大小写）。
 * 供中→英答错时高亮「你差在哪」，纯展示用，**不参与判对错**。
 */
export function diffWordChars(actual: string, expected: string): WordCharDiffOp[] {
  const a = [...(actual ?? '')];
  const b = [...(expected ?? '')];
  const n = a.length;
  const m = b.length;
  const lc = (c: string) => c.toLowerCase();

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        lc(a[i]) === lc(b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: WordCharDiffOp[] = [];
  const pushEqual = (text: string) => {
    const last = ops[ops.length - 1];
    if (last?.type === 'equal') last.text += text;
    else ops.push({ type: 'equal', text });
  };
  const pushWrong = (actualChar: string, expectedChar: string) => {
    const last = ops[ops.length - 1];
    if (last?.type === 'wrong') {
      last.actual += actualChar;
      last.expected += expectedChar;
    } else {
      ops.push({ type: 'wrong', actual: actualChar, expected: expectedChar });
    }
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (lc(a[i]) === lc(b[j])) {
      pushEqual(a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      pushWrong(a[i], '');
      i++;
    } else {
      pushWrong('', b[j]);
      j++;
    }
  }
  while (i < n) {
    pushWrong(a[i], '');
    i++;
  }
  while (j < m) {
    pushWrong('', b[j]);
    j++;
  }
  return ops;
}
