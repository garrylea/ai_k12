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
  /** 专项练习来源传本轮会话 uid（2026-11-26）：自评后据此把作答历史的
   *  `is_correct` 从 NULL 补成最终结果；不传则不回写（考试/主线自评无专项作答行）。 */
  sessionUid?: string;
  /** 单题重做（2026-11-06）：自评对仍清零错题，但不发错题订正分。
   *  客户端布尔值，**不是安全边界**（只压制调用者自己的分数）；缺省/false 行为不变。 */
  suppressErrorFixPoints?: boolean;
}
