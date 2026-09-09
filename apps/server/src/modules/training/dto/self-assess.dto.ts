/**
 * POST /api/training/self-assess 请求 DTO（主观题学生自评）。
 *
 * plain interface（项目惯例，无 class-validator 管线）：controller 手写白名单校验。
 */
export interface SelfAssessTrainingDto {
  questionId: number;
  subjectId: number;
  /** 'correct' = 我做对了（清零未清错题）；'incorrect' = 我做错了（入错题本） */
  assessment: 'correct' | 'incorrect';
  /** 'targeted' | 'error_practice' | 'exam'（考试结果页自评也走本端点） */
  source: 'targeted' | 'error_practice' | 'exam';
  /** 考试来源传 sessionId */
  sourceRefId?: number;
}
