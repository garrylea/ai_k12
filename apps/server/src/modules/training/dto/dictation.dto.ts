import type { DictationDiffOp } from '../../../common/utils/normalize-chinese.util.js';

/** 配置页篇目清单项（不含正文，防答案泄露）。 */
export interface DictationPassageListItem {
  questionId: number;
  workTitle: string;
  author: string;
  dynasty: string;
  semester: string;
}

/** 开练题项（不含作者/朝代/正文答案，防答案泄露）。 */
export interface DictationQuestionItem {
  questionId: number;
  prompt: string;
  workTitle: string;
  semester: string;
}

export interface DictationJudgeResult {
  questionId: number;
  isCorrect: boolean;
  fields: { author: { match: boolean }; dynasty: { match: boolean }; body: { match: boolean } };
  bodyDiff: DictationDiffOp[];
  reference: { author: string; dynasty: string; body: string };
  feedback: string | null;
  errorBookId?: number;
}
