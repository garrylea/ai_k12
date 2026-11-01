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
  questionAnswer: string | null;
  questionAnalysis: string | null;
  /** 语文专项：passage|word；考试为 question。 */
  refType: string | null;
  refId: number | null;
  sentenceIndex: number | null;
  /** 语文专项回放：篇名 + 该句原文（其他场景 null）。 */
  passageTitle: string | null;
  passageSentence: string | null;
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
