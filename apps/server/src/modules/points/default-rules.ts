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
};

export const DEFAULT_RULES: DefaultRule[] = [
  { taskCode: 'mainline_lesson',   taskName: '学完一课',     tierKey: 'default', tierLabel: '一课',   points: 10, dailyLimit: null, sortOrder: 10 },
  { taskCode: 'math_paper',        taskName: '数学卷子一套', tierKey: 'default', tierLabel: '一套',   points: 50, dailyLimit: null, sortOrder: 20 },
  { taskCode: 'math_targeted',     taskName: '数学专项',     tierKey: '1',       tierLabel: '1 题',   points: 2,  dailyLimit: null, sortOrder: 30 },
  { taskCode: 'math_targeted',     taskName: '数学专项',     tierKey: '3',       tierLabel: '3 题',   points: 8,  dailyLimit: null, sortOrder: 31 },
  { taskCode: 'math_targeted',     taskName: '数学专项',     tierKey: '5',       tierLabel: '5 题',   points: 15, dailyLimit: null, sortOrder: 32 },
  { taskCode: 'math_targeted',     taskName: '数学专项',     tierKey: '10',      tierLabel: '10 题',  points: 35, dailyLimit: null, sortOrder: 33 },
  { taskCode: 'error_fix',         taskName: '错题订正',     tierKey: 'default', tierLabel: '一题',   points: 3,  dailyLimit: null, sortOrder: 40 },
  { taskCode: 'cn_dictation',      taskName: '古诗文默写',   tierKey: 'poem',    tierLabel: '古诗',   points: 2,  dailyLimit: null, sortOrder: 50 },
  { taskCode: 'cn_dictation',      taskName: '古诗文默写',   tierKey: 'prose',   tierLabel: '古文',   points: 5,  dailyLimit: null, sortOrder: 51 },
  { taskCode: 'cn_interpretation', taskName: '古诗文翻译',   tierKey: 'poem',    tierLabel: '古诗',   points: 3,  dailyLimit: null, sortOrder: 60 },
  { taskCode: 'cn_interpretation', taskName: '古诗文翻译',   tierKey: 'prose',   tierLabel: '古文',   points: 6,  dailyLimit: null, sortOrder: 61 },
  { taskCode: 'cn_meaning',        taskName: '古诗情感',     tierKey: 'default', tierLabel: '一篇',   points: 4,  dailyLimit: null, sortOrder: 70 },
  { taskCode: 'en_vocabulary',     taskName: '英语背单词',   tierKey: '10',      tierLabel: '10 词',  points: 2,  dailyLimit: 2,    sortOrder: 80 },
  { taskCode: 'en_vocabulary',     taskName: '英语背单词',   tierKey: '15',      tierLabel: '15 词',  points: 4,  dailyLimit: 2,    sortOrder: 81 },
  { taskCode: 'en_vocabulary',     taskName: '英语背单词',   tierKey: '20',      tierLabel: '20 词',  points: 7,  dailyLimit: 2,    sortOrder: 82 },
];
