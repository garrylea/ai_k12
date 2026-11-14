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
  /** questions.full_score；做题错题重练时作为满分（null 时前端按 10）。 */
  fullScore: number | null;
  level: number;
  createdAt: string;
  kpIds: number[];
  /** 选择题选项（questions.options 解析后的 JSON 数组：字符串选项或 {label,text}），非选择题/解析失败为 null。 */
  options: unknown[] | null;
  /** 错题来源（main_error_books.source，如 practice/freeform）；前端据此显示「做题」标签。 */
  source: string | null;
  /** 是否有标准答案（false = 纯图片题/标注失败）：前端据此禁用勾选。2026-11-14 */
  answerable: boolean;
}
