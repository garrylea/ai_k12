/**
 * 训练轨学科配置的唯一真源（spec 2026-10-31 §3.1）。
 *
 * 为什么集中：训练轨原本只有「语文 / 其它=数学」两套三元分支（parseSubjectId、
 * subjectName、subjectHomePath、题型下拉、任务码），加第三个学科时每处都要再改一遍，
 * 漏一处就把物理静默当成数学。新增学科 = 在 TRAINING_SUBJECTS 加一项。
 *
 * 注意：本文件**不 import `@/constants`**（`constants` 反过来转出这里），避免循环依赖。
 */

export const SUBJECT_MATH = 1;
export const SUBJECT_CHINESE = 2;
export const SUBJECT_ENGLISH = 3;
export const SUBJECT_PHYSICS = 4;
export const SUBJECT_CHEMISTRY = 5;
export const SUBJECT_POLITICS = 9;

export type SubjectId =
  | typeof SUBJECT_MATH
  | typeof SUBJECT_CHINESE
  | typeof SUBJECT_ENGLISH
  | typeof SUBJECT_PHYSICS
  | typeof SUBJECT_CHEMISTRY
  | typeof SUBJECT_POLITICS;

/** 学科图标的 key；图形实现见 `components/business/SubjectGlyph.tsx`。 */
export type SubjectIconName =
  | 'math'
  | 'chinese'
  | 'english'
  | 'physics'
  | 'chemistry'
  | 'politics';

export interface SubjectTypeOption {
  value: string;
  label: string;
}

export interface TrainingSubjectConfig {
  id: SubjectId;
  name: string;
  desc: string;
  /** 选科卡片徽章里的学科图标（按学科区分，别再让六张卡共用一个图形）。 */
  icon: SubjectIconName;
  /** 选科页是否可点；false 渲染灰卡 + badge。 */
  enabled: boolean;
  badge?: string;
  /** 该学科在训练轨的落地页（含 query）。 */
  homePath: string;
  /** 专项配置页的题型下拉；空串 = 全部。 */
  typeOptions: readonly SubjectTypeOption[];
  /** 专项练习任务码（档位/发分用）；英语无专项练习。 */
  targetedTaskCode?: string;
  /** 理科：作答区用 LaTeX 输入 + 预览。 */
  isMathLike: boolean;
}

const ALL: SubjectTypeOption = { value: '', label: '全部' };

export const MATH_TYPE_OPTIONS: readonly SubjectTypeOption[] = [
  ALL,
  { value: 'choice', label: '选择' },
  { value: 'fill_blank', label: '填空' },
  { value: 'true_false', label: '判断' },
  { value: 'short_answer', label: '解答' },
  { value: 'proof', label: '证明' },
  { value: 'calculation', label: '计算' },
];

const CN_TYPE_OPTIONS: readonly SubjectTypeOption[] = [
  ALL,
  { value: 'choice', label: '选择' },
  { value: 'fill_blank', label: '填空' },
  { value: 'short_answer', label: '简答' },
];

const PHYSICS_TYPE_OPTIONS: readonly SubjectTypeOption[] = [
  ALL,
  { value: 'choice', label: '选择' },
  { value: 'fill_blank', label: '填空' },
  { value: 'short_answer', label: '简答' },
  { value: 'calculation', label: '计算' },
];

const HUMANITIES_TYPE_OPTIONS: readonly SubjectTypeOption[] = [
  ALL,
  { value: 'choice', label: '选择' },
  { value: 'fill_blank', label: '填空' },
  { value: 'short_answer', label: '简答' },
];

export const TRAINING_SUBJECTS: readonly TrainingSubjectConfig[] = [
  {
    id: SUBJECT_MATH, name: '数学', icon: 'math', desc: '考试 / 专项练习 / 错题练习',
    enabled: true, homePath: '/student/training/home',
    typeOptions: MATH_TYPE_OPTIONS, targetedTaskCode: 'math_targeted', isMathLike: true,
  },
  {
    id: SUBJECT_CHINESE, name: '语文', icon: 'chinese', desc: '真题考试 / 专项练习 / 古诗文专项',
    enabled: true, homePath: '/student/training/chinese/special',
    typeOptions: CN_TYPE_OPTIONS, targetedTaskCode: 'cn_targeted', isMathLike: false,
  },
  {
    id: SUBJECT_ENGLISH, name: '英语', icon: 'english', desc: '背单词',
    enabled: true, homePath: '/student/training/english/vocabulary',
    typeOptions: [], isMathLike: false,
  },
  {
    id: SUBJECT_PHYSICS, name: '物理', icon: 'physics', desc: '考试 / 专项练习 / 错题练习',
    enabled: true, homePath: '/student/training/home?subjectId=4',
    typeOptions: PHYSICS_TYPE_OPTIONS, targetedTaskCode: 'physics_targeted', isMathLike: true,
  },
  {
    id: SUBJECT_CHEMISTRY, name: '化学', icon: 'chemistry', desc: '考试 / 专项练习 / 错题练习',
    enabled: true, homePath: '/student/training/home?subjectId=5',
    typeOptions: HUMANITIES_TYPE_OPTIONS, targetedTaskCode: 'chemistry_targeted', isMathLike: true,
  },
  {
    id: SUBJECT_POLITICS, name: '道德与法治', icon: 'politics', desc: '考试 / 专项练习 / 错题练习',
    enabled: true, homePath: '/student/training/home?subjectId=9',
    typeOptions: HUMANITIES_TYPE_OPTIONS, targetedTaskCode: 'politics_targeted', isMathLike: false,
  },
];

const BY_ID = new Map<number, TrainingSubjectConfig>(TRAINING_SUBJECTS.map((s) => [s.id, s]));

export function getTrainingSubject(subjectId: number): TrainingSubjectConfig | undefined {
  return BY_ID.get(Number(subjectId));
}

export function subjectName(subjectId: number): string {
  return getTrainingSubject(subjectId)?.name ?? '数学';
}

export function subjectHomePath(subjectId: number): string {
  return getTrainingSubject(subjectId)?.homePath ?? '/student/training/home';
}

const ALLOWED_SUBJECT_IDS = new Set<number>([1, 2, 3, 4, 5, 9]);

/** URL 查询参数解析学科 id；缺省/未知一律数学（兼容既有不带参的数学链接）。 */
export function parseSubjectId(raw: string | null): number {
  const n = Number(raw);
  return ALLOWED_SUBJECT_IDS.has(n) ? n : SUBJECT_MATH;
}

export function isMathLikeSubject(subjectId: number): boolean {
  return getTrainingSubject(subjectId)?.isMathLike ?? false;
}

const OBJECTIVE_TYPES = new Set(['choice', 'true_false']);

/**
 * 闸门③：前端是否要「同步等判题 + 弹自评视图」。
 *
 * 不在名单里的题型，即使服务端返回 `needsSelfAssessment: true` 也会被记成
 * `isCorrect: false`（QuestionRunner 的 fire-and-forget 分支），学生看到「错」且没有
 * 自评入口。数学保持原样（fill_blank 仍 fire-and-forget），其余学科所有非客观题都等。
 */
export function selfAssessEligible(subjectId: number, type: string): boolean {
  if (OBJECTIVE_TYPES.has(type)) return false;
  if (Number(subjectId) === SUBJECT_MATH) return type === 'short_answer' || type === 'proof';
  return true;
}
