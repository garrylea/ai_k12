/**
 * 课堂练习「让 AI 讲一讲」请求 DTO。
 *
 * 打开讨论即：① 记入主线错题本（幂等 find-or-create）；② 创建带 card_id 的
 * mainline 对话并返回 dialogueId，前端据此走 /api/ai/tutor/stream 做苏格拉底讨论。
 * 沿用既有 DTO 模式（plain interface，见 hint-practice.dto.ts）。
 */
export interface DiscussPracticeDto {
  cardId: number;
  lessonId: number;
  subjectId: number;
  /** 题目文本，作为错题去重键之一（question_id 为空时按题面匹配）。 */
  questionText: string;
}
