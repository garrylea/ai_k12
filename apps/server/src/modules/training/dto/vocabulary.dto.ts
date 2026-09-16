import type {
  EnglishLevel,
  LevelPool,
  VocabularyJudgeMethod,
  VocabularyVerdict,
  WordCharDiffOp,
  RootAffix,
} from '../../../common/utils/normalize-english.util.js';

// 判题口径类型统一从本模块转出，调用方（controller / service / 前端契约）只认一个入口
export type { EnglishLevel, LevelPool, VocabularyJudgeMethod, VocabularyVerdict, WordCharDiffOp };

// ============ 配置页 ============

/** 词库范围档位（页面暴露三档，存储四层；小学词并入初中池，见 levelsForPool）。 */
export interface VocabularyPoolOption {
  key: LevelPool;
  label: string;
  count: number;
}

export interface VocabularyOptionsResult {
  pools: VocabularyPoolOption[];
  /** 今日已背（答对/答错/不认识/判题失败都算「见过」） */
  todayAnswered: number;
  counts: {
    /** 还没背过的（含从无进度行的） */
    notLearned: number;
    /** 我错过的词 */
    myWrong: number;
    /** 全平台高频易错词 */
    commonWrong: number;
    /** 有熟词僻义的词 */
    extended: number;
  };
}

// ============ 开练（抽题） ============

/** 出题顺序。`letter` = 按 `letter` 过滤后按字母序。 */
export type VocabularyOrder = 'random' | 'alpha' | 'alpha_desc' | 'letter';

/** 出题方向。`random` 表示逐题随机（僻义题恒为英→中，见服务层）。 */
export type VocabularyDirection = 'en2cn' | 'cn2en' | 'random';

/** 题面类型。与 direction 的区别：这是**实际**方向，`random` 已在服务层落定。 */
export type VocabularyPromptKind = 'en2cn' | 'cn2en';

export interface VocabularyStartInput {
  levelPool: LevelPool;
  /** 10–20，服务端校验 */
  count: number;
  order: VocabularyOrder;
  /** 仅 order='letter' 时使用，单字母 a-z */
  letter?: string | null;
  direction: VocabularyDirection;
  onlyNotLearned?: boolean;
  onlyMyWrong?: boolean;
  onlyCommonWrong?: boolean;
  onlyExtendedSense?: boolean;
}

export interface VocabularyQuestionItem {
  wordId: number;
  /** 目标义项在 meanings 里的下标。服务层据它判断走哪条判题路由。 */
  senseIndex: number;
  promptKind: VocabularyPromptKind;
  /** 题面。`en2cn` 是英文单词；`cn2en` 是中文释义 */
  prompt: string;
  /** 音标。**`cn2en` 下恒为 null**（否则等于给答案提示） */
  phonetic: string | null;
  /** 锁定僻义的搭配。**`cn2en` 下恒为 null**；普通义题也为 null */
  context: string | null;
  /** 是否是熟词僻义题（题面会给「熟词僻义」标记）。`cn2en` 下恒为 false */
  isExtendedSense: boolean;
  /** 是否有词根族可展开（前端据此决定要不要画「+」号）。`cn2en` 下恒为 false */
  hasFamily: boolean;
}

export interface VocabularyStartResult {
  questions: VocabularyQuestionItem[];
  /** 抽题池命中数。为 0 时 questions 为空，前端提示「当前筛选下没有词」 */
  poolSize: number;
}

// ============ 判题 ============

export interface VocabularyJudgeInput {
  wordId: number;
  senseIndex: number;
  promptKind: VocabularyPromptKind;
  answer: string;
}

/** 标准答案里的一个义项（判完就该让学生看见，含僻义标记与搭配）。 */
export interface VocabularyStandardMeaning {
  pos: string;
  gloss: string;
  extended: boolean;
  context?: string;
}

export interface VocabularyJudgeResult {
  wordId: number;
  senseIndex: number;
  verdict: VocabularyVerdict;
  method: VocabularyJudgeMethod;
  standard: {
    word: string;
    phonetic: string | null;
    meanings: VocabularyStandardMeaning[];
    /** 本题考的义项（学生对着它看自己差在哪） */
    target: { pos: string; gloss: string; extended: boolean; context?: string };
  };
  /** 仅中→英答错时有值：逐字符差异，供前端高亮「你差在哪」 */
  spellingDiff: WordCharDiffOp[] | null;
  /** 判错/未答到考点时的一句提示（LLM 给；程序判错时为 null） */
  comment: string | null;
  familyAvailable: boolean;
  /** 落库后的进度（读回值，不是本地推算） */
  progress: { learned: boolean; wrongCount: number };
}

// ============ 词根族 ============

export interface WordFamilyMember {
  word: string;
  phonetic: string | null;
  /** 该词第一顺位的中文释义（族里各词都取它，让树一眼能读） */
  gloss: string;
  pos: string;
  /** 相对族中心的词缀注记；中心词为空数组 */
  affixes: RootAffix[];
  isHead: boolean;
  level: EnglishLevel;
}

export interface WordFamilyResult {
  root: { word: string; phonetic: string | null; gloss: string };
  members: WordFamilyMember[];
}
