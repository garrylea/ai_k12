import type { DictationDiffOp } from '../../../common/utils/normalize-chinese.util.js';

/**
 * 配置页篇目清单项。
 * 只出篇名 + 册次：作者/朝代/正文是学生要作答的三个字段，故意不下发（防答案泄露）。
 */
export interface DictationPassageListItem {
  questionId: number;
  workTitle: string;
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
  /** 判题接口恒为 null——错因已与判题解耦，由 POST dictation/feedback 单独取。 */
  feedback: string | null;
  /** true=判错且错因待补（前端应另调 dictation/feedback）；答对恒 false。 */
  feedbackPending: boolean;
  errorBookId?: number;
}

/** 错因接口返回：模型不可达/超时/两个模型都失败时为 null（前端显示兜底文案）。 */
export interface DictationFeedbackResult {
  feedback: string | null;
}
