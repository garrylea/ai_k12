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
}

/** POST /api/training/bump-error-levels 请求 DTO（仍错升 level，镜像 practice）。 */
export interface BumpErrorLevelsDto {
  errorBookIds: number[];
}
