/**
 * 练习记录（学生端）DTO —— 一期学生端查看历史作答（2026-11-01）。
 *
 * 列表把「考试（exam_sessions）」与「专项练习（special_practice_sessions）」UNION 成一个
 * 统一视角：孩子不关心底层是两张表，只看到「我做过的卷子」。
 */

export interface PracticeHistoryQueryDto {
  page?: number;
  pageSize?: number;
  subjectId?: number;
}

/** 列表项 / 详情头（同一形状）。 */
export interface PracticeHistoryItem {
  source: 'exam' | 'special';
  sessionId: number;
  subjectId: number;
  title: string | null;
  module: string | null;
  startedAt: Date;
  completedAt: Date | null;
  totalCount: number;
  correctCount: number;
}

/** 详情里的一题（考试与专项统一为这一形状）。 */
export interface PracticeHistoryQuestion {
  questionId: number | null;
  questionOrder: number;
  answerText: string | null;
  isCorrect: boolean | null;
  score: number | null;
  method: string | null;
  analysis: string | null;
  judgedAt: Date | null;
  /** 题面（考试：questions.content；语文专项：null，改用 passageTitle + passageSentence）。 */
  questionContent: string | null;
  /** 材料（questions.material_text，语文/英语阅读材料、物化题内材料）。无材料为 null。 */
  materialText: string | null;
  /** 整段材料在素材库中的路径（语文阅读等整篇材料题）；无整篇材料为 null。 */
  materialUrl: string | null;
  /** 标准答案（考试取自 questions.answer；语文含义专项按句回查题库重建）。 */
  questionAnswer: string | null;
  questionAnalysis: string | null;
  /** 题目来源（questions.source，如「北京市西城区九年级模拟测试试卷」）；用于溯源。 */
  questionSource: string | null;
  /** 该题在原试卷中的题号（专项记录用，paper_questions.question_no；无卷关联时退回 questions.group_order）；考试恒 null。 */
  questionNo: number | null;
  /** 语文专项：passage|word；考试为 question。 */
  refType: string | null;
  refId: number | null;
  sentenceIndex: number | null;
  /** 语文专项回放：篇名 + 该句原文（其他场景 null）。 */
  passageTitle: string | null;
  passageSentence: string | null;
  /** 有题目 id 且在架 -> 可单题重做（语文/英语专项为 false）。 */
  canRedo: boolean;
  /** canRedo + 学科数/理 + 有答案 + 有知识点 -> 可同类型练习。 */
  canSimilar: boolean;
}

export interface PracticeHistoryDetail {
  session: PracticeHistoryItem;
  questions: PracticeHistoryQuestion[];
}

export interface PracticeHistoryListResult {
  items: PracticeHistoryItem[];
  total: number;
  page: number;
  pageSize: number;
}
