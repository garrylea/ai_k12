/**
 * GET /api/training/error-book 查询参数 DTO。
 *
 * plain interface（项目惯例，无 class-validator 管线）：
 * subjectId 必填（controller ParseIntPipe），from/to/type 为日期/题型字符串，
 * kpId 为知识点 id（可选，用于专项筛选）。
 */
export interface ErrorBookQueryDto {
  from?: string;
  to?: string;
  type?: string;
  kpId?: number;
}

/** 错题练习筛选列表条目（ResponseInterceptor 包装在 data 字段内返回）。 */
export interface ErrorBookEntryDto {
  errorBookId: number;
  questionId: number | null;
  questionText: string;
  type: string | null;
  level: number;
  createdAt: string;
  kpIds: number[];
  /** 选择题选项（questions.options 解析后的 JSON 数组：字符串选项或 {label,text}），非选择题/解析失败为 null。 */
  options: unknown[] | null;
}
