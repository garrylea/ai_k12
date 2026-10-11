/** GET /api/training/variations/me 的可选 query。 */
export interface VariationListQueryDto {
  /** 可选：只取某条错题条目的 pending 变式（错题本条目入口）。 */
  errorBookId?: number;
}

/** POST /api/training/variations/answers 入参。 */
export interface SubmitVariationAnswerDto {
  questionId: number;
  studentAnswer: string;
}

/** POST /api/training/variations/self-assess 入参。 */
export interface VariationSelfAssessDto {
  questionId: number;
  assessment: 'correct' | 'incorrect';
}
