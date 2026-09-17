/**
 * 语文古诗文「含义」专项 DTO。
 *
 * 三条铁律（与默写/解释同规矩）：
 *   1. `start` 只出**原文与字词名**，`meaning` / `emotion` / `translation` /
 *      `full_translation` / `author` / `dynasty` / `body` 一律不下发——它们就是答案。
 *   2. `judge` 是**逐句**判：一次请求判一句（该句的字词 + 深层含义 + 作者情感）。
 *   3. 判题不写任何学生状态（独立子系统，不入错题本）。
 */

import type { PointsAwardReason } from '../../points/dto/points.dto.js';

/**
 * 判定方式。**没有 `exact`** —— 本专项不做字符串归一化全等短路（理解性作答
 * 拿字符串相等去判不成立），全部交给 LLM。
 * `undetermined` 的 `correct` 为 `null`（模型没判出来，前端显示「未判定」）。
 */
export type MeaningMethod = 'ai' | 'unanswered' | 'undetermined';

/** 配置页篇目清单项（供「指定篇目」勾选）。只有名字，没有内容。 */
export interface MeaningPassageListItem {
  passageId: number;
  workTitle: string;
  semester: string;
}

/**
 * 答题页的一个关键字词。**两个形式并存**（不要合并）：
 *   `term`  —— 原样，**带注音**（`谪（zhé）守`）：展示用
 *   `plain` —— 去注音（`谪守`）：前端在原文里高亮用
 */
export interface MeaningTermItem {
  term: string;
  plain: string;
}

/** 答题页的一句骨架。 */
export interface MeaningSentenceItem {
  /** 真实句下标（在 sentences 里的位置），判题回传用 */
  index: number;
  text: string;
  terms: MeaningTermItem[];
  /**
   * false = 该句没有标准含义（人工没填），**只显示在顶部原文条里、不出题**。
   * 诗要完整显示，所以 answerable:false 的句子也要下发 text。
   */
  answerable: boolean;
}

/** 开练下发的一篇：整篇句子一次给全（顶部原文条要渲染完整一首诗）。 */
export interface MeaningPassageItem {
  passageId: number;
  workTitle: string;
  semester: string;
  sentences: MeaningSentenceItem[];
}

/** 单块（含义 / 情感）的判定结果。`standard` 只在判题响应里下发。 */
export interface MeaningPartJudge {
  /** `null` = 未判定 */
  correct: boolean | null;
  method: MeaningMethod;
  standard: string;
  comment: string | null;
}

export interface MeaningTermJudgeItem {
  term: string;
  /** `null` = 未判定 */
  correct: boolean | null;
  method: MeaningMethod;
  standard: string;
  comment: string | null;
}

export interface MeaningJudgeResult {
  passageId: number;
  sentenceIndex: number;
  /** 该句所有项（字词 + 含义 + 情感）全 `correct === true` 才是 true；有 `null` 即 false。 */
  allCorrect: boolean;
  /** 顺序与「该句应有的字词」一致。 */
  terms: MeaningTermJudgeItem[];
  meaning: MeaningPartJudge;
  emotion: MeaningPartJudge;
  /**
   * 本次**实际入账**的积分（甲类逐目标发分，`cn_meaning`，**整篇答完发一次**）。
   * 只有该篇**最后一个可作答句**判完时才可能非 0；其余句恒 0。
   * 「整篇答完」= 最大的 `i` 使 `meanings[i] != null` —— **不是** `sentences.length - 1`
   * （末句可能没有标准含义、根本不出题，按末句下标判定会让这些篇目永远拿不到分）。
   */
  pointsAwarded: number;
  /** 未发分原因（无值=静默）；`duplicate` 刻意不在枚举内，见 `PointsAwardReason`。 */
  awardReason?: PointsAwardReason;
}
