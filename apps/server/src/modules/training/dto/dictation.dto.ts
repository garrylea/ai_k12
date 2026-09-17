import type { DictationDiffOp } from '../../../common/utils/normalize-chinese.util.js';
import type { PointsAwardReason } from '../../points/dto/points.dto.js';

/**
 * 配置页篇目清单项。
 * 只出篇名 + 册次：作者/朝代/正文是学生要作答的三个字段，故意不下发（防答案泄露）。
 */
export interface DictationPassageListItem {
  passageId: number;
  workTitle: string;
  semester: string;
}

/** 开练题项（不含作者/朝代/正文答案，防答案泄露）。 */
export interface DictationQuestionItem {
  passageId: number;
  prompt: string;
  workTitle: string;
  semester: string;
}

export interface DictationJudgeResult {
  passageId: number;
  isCorrect: boolean;
  fields: { author: { match: boolean }; dynasty: { match: boolean }; body: { match: boolean } };
  bodyDiff: DictationDiffOp[];
  reference: { author: string; dynasty: string; body: string };
  /** 判题接口恒为 null——错因已与判题解耦，由 POST dictation/feedback 单独取。 */
  feedback: string | null;
  /** true=判错且错因待补（前端应另调 dictation/feedback）；答对恒 false。 */
  feedbackPending: boolean;
  /** 本次**实际入账**的积分（甲类逐目标发分，`cn_dictation`，一篇一次）。
   *  0 = 本次没加：同日重判（幂等命中）/ 体裁未标定 / 达上限 / 家长停用该档 / 发分失败。
   *  前端 `> 0` 弹「+N 分」轻反馈。 */
  pointsAwarded: number;
  /** 未发分原因（无值=静默）；`duplicate` 刻意不在枚举内，见 `PointsAwardReason`。 */
  awardReason?: PointsAwardReason;
}

/** 错因接口返回：模型不可达/超时/两个模型都失败时为 null（前端显示兜底文案）。 */
export interface DictationFeedbackResult {
  feedback: string | null;
}
