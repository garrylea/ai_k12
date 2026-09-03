/**
 * GET /api/exams/papers 查询参数 DTO。
 *
 * plain interface（项目惯例，无 class-validator 管线）：
 * subjectId 必填（controller ParseIntPipe），year/district/examType/gradeBand 可选。
 */
export interface PaperQueryDto {
  subjectId: number;
  year?: number;
  district?: string;
  examType?: string;
  gradeBand?: string;
}

/** 试卷列表条目（ResponseInterceptor 包装在 data 字段内返回）。 */
export interface ExamPaperDto {
  id: number;
  title: string;
  year: number | null;
  district: string | null;
  examType: string | null;
  gradeBand: string | null;
  questionCount: number;
}

/** 试卷详情：题目元数据 + 推荐时长（不含 answer/explanation，防答案泄露）。 */
export interface PaperDetailDto {
  id: number;
  title: string;
  durationMinutes: number;
  questions: Array<{
    questionId: number;
    questionNo: number;
    text: string;
    type: string;
    options: unknown[] | null;
  }>;
}
