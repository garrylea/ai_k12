/**
 * 语文古诗文「解释（翻译）」专项 DTO。
 *
 * 三条铁律（与默写同规矩）：
 *   1. `start` 只出**原文与字词名**，`gloss`（释义）/`translation`（译文）/
 *      `full_translation`（全文译文）一律不下发——它们就是答案。
 *   2. `judge` 是**逐句**判：一次请求判一句（该句的字词 + 整句翻译）。
 *   3. 判题不写任何学生状态（独立子系统，不入错题本）。
 */

import type { PointsAwardReason } from '../../points/dto/points.dto.js';

/** 判定方式。`undetermined` 的 `correct` 为 `null`（模型没判出来，前端显示「未判定」）。 */
export type InterpretationMethod = 'exact' | 'ai' | 'unanswered' | 'undetermined';

/** 配置页篇目清单项（供「指定篇目」勾选）。只有名字，没有内容。 */
export interface InterpretationPassageListItem {
  passageId: number;
  workTitle: string;
  semester: string;
}

/**
 * 答题页的一个关键字词。
 *
 * **两个形式并存**，各司其职（不要合并成一个）：
 *   `term`  —— 原样，**带注音**（`谪（zhé）守`）：展示用，学生要看得见读音
 *   `plain` —— 去注音（`谪守`）：前端在原文里高亮用；正文里没有注音，拿 `term` 去找永远找不到
 */
export interface InterpretationTermItem {
  term: string;
  plain: string;
}

/** 答题页的一句骨架：原文 + 该句有哪些关键字词（只有词名，没有释义）。 */
export interface InterpretationSentenceItem {
  index: number;
  text: string;
  terms: InterpretationTermItem[];
}

/** 开练下发的篇目：整篇所有句子一次给全（前端才能把整篇铺出来、看见上下文）。 */
export interface InterpretationPassageItem {
  passageId: number;
  workTitle: string;
  semester: string;
  sentences: InterpretationSentenceItem[];
}

/** 字词判定结果。`standard` 只在判题响应里下发。 */
export interface InterpretationTermJudgeItem {
  term: string;
  /** `null` = 未判定 */
  correct: boolean | null;
  method: InterpretationMethod;
  standard: string;
  comment: string | null;
}

/** 整句翻译判定结果。 */
export interface InterpretationSentenceJudgeItem {
  correct: boolean | null;
  method: InterpretationMethod;
  standard: string;
  comment: string | null;
}

export interface InterpretationJudgeResult {
  passageId: number;
  sentenceIndex: number;
  /** 该句所有项（字词 + 整句）全 `correct === true` 才是 true；有 `null`（未判定）即 false。 */
  allCorrect: boolean;
  /** 顺序与「该句应有的字词」一致。 */
  terms: InterpretationTermJudgeItem[];
  sentence: InterpretationSentenceJudgeItem;
  /** **仅当被判的是最后一句时**非 null——整篇译文提前下发等于泄题。 */
  fullTranslation: string | null;
  /** 本次**实际入账**的积分（甲类逐目标发分，`cn_interpretation`，一篇一天一次；
   *  判题是逐句的，所以首句判完即发，同日后续句子靠幂等键命中而不再入账）。
   *  0 = 体裁未标定 / 同日重判 / 达上限 / 停用 / 失败。 */
  pointsAwarded: number;
  /** 未发分原因（无值=静默）；`duplicate` 刻意不在枚举内，见 `PointsAwardReason`。 */
  awardReason?: PointsAwardReason;
}
