/**
 * 课堂练习「提示」请求 DTO。
 *
 * 沿用既有 DTO 模式（plain interface，见 judge-practice.dto.ts），待后续统一接入
 * 校验管线时再补 class-validator 装饰器。
 */
export interface HintPracticeDto {
  cardId: number;
  lessonId: number;
  subjectId: number;
  /** 题目文本，同时作为 cards.hints JSON 的 key（即「题目标题」）。 */
  questionText: string;
}
