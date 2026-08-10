/**
 * 卡片级「思辨答疑」请求 DTO。
 *
 * 与题目级 `/practice/discuss` 区别：讨论整张卡片的知识（非某道题），
 * 不入错题本，故无 questionText。服务端 find-or-create 该学生在该卡片的
 * mainline 对话并返回 dialogueId，前端据此走 /api/ai/tutor/stream。
 */
export interface DiscussCardPracticeDto {
  cardId: number;
  lessonId: number;
  subjectId: number;
}
