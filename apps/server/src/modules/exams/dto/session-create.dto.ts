/**
 * 考试会话生命周期 DTO（exams 模块 Task 2）。
 *
 * plain interface（项目惯例，无 class-validator 管线）：
 * 数值/区间校验在 service 层（createSession 的 durationMinutes 10-300 整数）。
 */

import type { PointsAwardDto } from '../../points/dto/points.dto.js';

/** POST /api/exams/sessions 请求体。 */
export interface SessionCreateDto {
  paperId: number;
  durationMinutes: number;
}

/** POST /api/exams/sessions/:id/answers 请求体。 */
export interface SubmitAnswerDto {
  questionId: number;
  answerText: string;
}

/** 会话题单元数据（与 PaperDetailDto.questions 同构）。 */
export interface SessionQuestionDto {
  questionId: number;
  questionNo: number;
  text: string;
  type: string;
  options: unknown[] | null;
}

/** POST /api/exams/sessions 响应（新建/续考同构；续考不重置时长）。
 *  status 仅在「命中的续考会话已超时、服务端自动收卷后」返回 'submitted'
 *  （前端据此直接踢结果页）；新建/正常续考缺省（前端视为 in_progress）。 */
export interface SessionCreatedDto {
  sessionId: number;
  status?: 'in_progress' | 'submitted';
  deadlineAt: Date;
  remainingSeconds: number;
  questions: SessionQuestionDto[];
}

/** GET /api/exams/sessions/:id 响应（answered 只含 answerText，不泄露对错）。 */
export interface SessionStateDto {
  sessionId: number;
  status: 'in_progress' | 'submitted';
  remainingSeconds: number;
  questions: SessionQuestionDto[];
  answered: Record<number, { answerText: string | null }>;
}

/** 交卷/收卷汇总（submit 响应；getResults 内嵌同构字段）。
 *  `points` 为 Task 9 交卷发分结果（`math_paper`）；发分故障时为 undefined（JSON 里无该字段）。 */
export interface ExamSummaryDto {
  correctCount: number;
  totalCount: number;
  accuracy: number; // 百分比，一位小数（如 33.3）；分母只算客观题
  subjectiveCount: number; // 主观题题数（self_assess 模式不判对错，单独计数）
  points?: PointsAwardDto;
}

/** GET /api/exams/sessions/:id/results 响应条目（JOIN questions 带 explanation）。 */
export interface ExamResultItemDto {
  questionId: number;
  questionNo: number;
  text: string;
  type: string;
  options: unknown[] | null;
  answerText: string | null;
  isCorrect: number | null; // 0 | 1；null = 主观题待自评（self_assess 模式不判对错）
  analysis: string | null;
  explanation: string | null;
  answer?: string | null; // 参考答案（主观题自评对照展示）
  needsSelfAssessment?: boolean; // true = is_correct NULL，结果页待自评
  selfAssessment?: 'correct' | 'incorrect' | null; // 该生该题最近一次自评（恢复自评状态）
}

/** GET /api/exams/sessions/:id/results 响应（仅 submitted 可查）。 */
export interface ExamResultsDto extends ExamSummaryDto {
  items: ExamResultItemDto[];
}
