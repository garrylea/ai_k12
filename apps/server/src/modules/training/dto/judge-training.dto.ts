/**
 * POST /api/training/judge 请求 DTO（错题练习判题，题中心变体）。
 *
 * plain interface（项目惯例，无 class-validator 管线）：questionId/subjectId
 * 必填 number，studentAnswer 为学生作答文本；source 由端点语义决定（白名单
 * 'targeted' | 'error_practice'，controller 校验），不透传客户端任意值。
 */
export interface JudgeTrainingDto {
  questionId: number;
  subjectId: number;
  studentAnswer: string;
  source: 'targeted' | 'error_practice';
  /** 可选：本轮训练会话 id（`math_targeted`）。只用于累加 `judged_count` 审计留痕，
   *  不传也能判题；不存在/非本人/已完成都静默跳过（spec §6.4）。 */
  sessionId?: number;
  /** 作答记录旁路写入（Task 3，2026-11-01）：全可选，缺 sessionUid 时不写作答记录（向后兼容）。
   *  - sessionUid：唯一标识本次专项练习会话（同 uid 多次判题复用同一行）
   *  - title：会话标题（如「数学薄弱点训练」），缺省写 null
   *  - questionCount：本轮题数，缺省写 0
   *  - questionOrder：本题在本轮中的序号（1-based），缺省写 1 */
  sessionUid?: string;
  title?: string;
  questionCount?: number;
  questionOrder?: number;
  /** 数理化专项开练的整轮题单（有序，含已答与未答）；缺省不写占位行。
   *  服务端只保留存在、在架、与 `subjectId` 同学科的 id，按本数组顺序落 `question_order`。 */
  plannedQuestionIds?: number[];
}
