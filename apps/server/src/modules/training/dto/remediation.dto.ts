/** POST /api/training/remediation/generate 入参。 */
export interface GenerateRemediationDto {
  /** 错题来源：exam = 真题考试交卷后；targeted = 数学专项完成后。 */
  source: 'exam' | 'targeted';
  /** 考试会话 id / 专项训练会话 id（两者同名不同表，按 source 分流）。 */
  sessionId: number;
  /** targeted 专用：本场判错的题号（服务端逐题验证错题本记录，防伪造）。 */
  wrongQuestionIds?: number[];
}

export interface SubmitRemediationAnswerDto {
  questionId: number;
  studentAnswer: string;
}

export interface RemediationSelfAssessDto {
  questionId: number;
  assessment: 'correct' | 'incorrect';
}
