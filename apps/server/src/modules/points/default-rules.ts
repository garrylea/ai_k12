export interface DefaultRule {
  taskCode: string;
  taskName: string;      // 规则表里没有 task_name 列，taskName 只用于拼流水 title 与前端分组
  tierKey: string;
  tierLabel: string;
  points: number;
  dailyLimit: number | null;
  sortOrder: number;
}

export const TASK_NAMES: Record<string, string> = {
  mainline_lesson: '学完一课',
  math_paper: '数学卷子一套',
  math_targeted: '数学专项',
  error_fix: '错题订正',
  cn_dictation: '古诗文默写',
  cn_interpretation: '古诗文翻译',
  cn_meaning: '古诗情感',
  en_vocabulary: '英语背单词',
  remediation_question: '相似题专项',
};

/**
 * 默认规则表（家长可改，每学生一套）。
 *
 * ⚠️ **只对「新学生」生效**：写入走 `insertIgnoreBatch`（`INSERT IGNORE` 撞唯一键即跳过），
 * 已 seed 过规则的学生**不会被这里的默认值覆盖**。改 `dailyLimit` / `points` 只能修新账号，
 * 不能回溯修正存量学生（要修存量得走家长配置页或单独的迁移）。
 *
 * `dailyLimit` 是**主要防刷手段**（spec §3.2）。数学专项四档**共用 5 次**：
 * 档位由学生自选、幂等键按 sessionId（每次开练都是新 key），若不限次，
 * 把题池缩到 1 题就能用 `10` 档（35 分）反复 complete 无限刷（spec 明确接受
 * 「开一个 N 题会话立刻 complete 就等于做完 N 题」，所以上限是唯一闸门）。
 * 与 `en_vocabulary` 三档共用 2 次同一口径：同一 task_code 的各档不分档位计数。
 */
export const DEFAULT_RULES: DefaultRule[] = [
  { taskCode: 'mainline_lesson',   taskName: '学完一课',     tierKey: 'default', tierLabel: '一课',   points: 10, dailyLimit: null, sortOrder: 10 },
  { taskCode: 'math_paper',        taskName: '数学卷子一套', tierKey: 'default', tierLabel: '一套',   points: 50, dailyLimit: null, sortOrder: 20 },
  { taskCode: 'math_targeted',     taskName: '数学专项',     tierKey: '1',       tierLabel: '1 题',   points: 2,  dailyLimit: 5,    sortOrder: 30 },
  { taskCode: 'math_targeted',     taskName: '数学专项',     tierKey: '3',       tierLabel: '3 题',   points: 8,  dailyLimit: 5,    sortOrder: 31 },
  { taskCode: 'math_targeted',     taskName: '数学专项',     tierKey: '5',       tierLabel: '5 题',   points: 15, dailyLimit: 5,    sortOrder: 32 },
  { taskCode: 'math_targeted',     taskName: '数学专项',     tierKey: '10',      tierLabel: '10 题',  points: 35, dailyLimit: 5,    sortOrder: 33 },
  { taskCode: 'error_fix',         taskName: '错题订正',     tierKey: 'default', tierLabel: '一题',   points: 3,  dailyLimit: null, sortOrder: 40 },
  { taskCode: 'remediation_question', taskName: '相似题专项', tierKey: 'choice',     tierLabel: '选择题', points: 3, dailyLimit: null, sortOrder: 35 },
  { taskCode: 'remediation_question', taskName: '相似题专项', tierKey: 'fill_blank', tierLabel: '填空题', points: 4, dailyLimit: null, sortOrder: 36 },
  { taskCode: 'remediation_question', taskName: '相似题专项', tierKey: 'major',      tierLabel: '大题',   points: 6, dailyLimit: null, sortOrder: 37 },
  { taskCode: 'cn_dictation',      taskName: '古诗文默写',   tierKey: 'poem',    tierLabel: '古诗',   points: 2,  dailyLimit: null, sortOrder: 50 },
  { taskCode: 'cn_dictation',      taskName: '古诗文默写',   tierKey: 'prose',   tierLabel: '古文',   points: 5,  dailyLimit: null, sortOrder: 51 },
  { taskCode: 'cn_interpretation', taskName: '古诗文翻译',   tierKey: 'poem',    tierLabel: '古诗',   points: 3,  dailyLimit: null, sortOrder: 60 },
  { taskCode: 'cn_interpretation', taskName: '古诗文翻译',   tierKey: 'prose',   tierLabel: '古文',   points: 6,  dailyLimit: null, sortOrder: 61 },
  { taskCode: 'cn_meaning',        taskName: '古诗情感',     tierKey: 'default', tierLabel: '一篇',   points: 4,  dailyLimit: null, sortOrder: 70 },
  { taskCode: 'en_vocabulary',     taskName: '英语背单词',   tierKey: '10',      tierLabel: '10 词',  points: 2,  dailyLimit: 2,    sortOrder: 80 },
  { taskCode: 'en_vocabulary',     taskName: '英语背单词',   tierKey: '15',      tierLabel: '15 词',  points: 4,  dailyLimit: 2,    sortOrder: 81 },
  { taskCode: 'en_vocabulary',     taskName: '英语背单词',   tierKey: '20',      tierLabel: '20 词',  points: 7,  dailyLimit: 2,    sortOrder: 82 },
];
