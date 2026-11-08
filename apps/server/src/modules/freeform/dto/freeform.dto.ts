/** POST /api/freeform/recognize 请求体。二者至少给一个，具体校验在 FreeformRecognizeService。 */
export interface FreeformRecognizeDto {
  text?: string;
  fileIds?: string[];
}

/** POST /api/freeform/judge 请求体（Task 10 起使用）。 */
export interface FreeformJudgeDto {
  dialogueId?: string;
  subjectId: number;
  maxScore: number;
  questionId?: number;
  questionContent: string;
  questionImages?: Array<{ type: 'image'; fileId: string }>;
  figureUrls?: string[];
  answer: string;
  draftFileId?: string;
}
