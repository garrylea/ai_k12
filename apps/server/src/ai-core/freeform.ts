/**
 * 做题入口（freeform）的提示词变量与学科解析。
 *
 * 与其它入口的区别：做题页的分科不走 `ConversationService.loadContext`（那里恒为
 * `math`，因为 `prompts/tutoring/` 只有数学目录），而是按
 * `dto.subjectId → ai_dialogues.subject_id → math` 的顺序解析，只用于选
 * `prompts/freeform/tutor/<科>.md` 与模板里的「当前学科」。
 *
 * 学习档案（年级/教材/已学内容/卡点）由前端问卷采集、随请求下发；缺失时模板走
 * 空态分支，绝不把空串渲染成看起来像坏掉的句子。
 */

export const FREE_FORM_SUBJECTS = ['math', 'physics', 'chemistry'] as const;
export type FreeFormSubject = (typeof FREE_FORM_SUBJECTS)[number];

/** 学科 id（subjects seed）：1=数学 4=物理 5=化学 */
const SUBJECT_ID_TO_NAME: Record<number, FreeFormSubject> = {
  1: 'math',
  4: 'physics',
  5: 'chemistry',
};

export const FREE_FORM_SUBJECT_LABELS: Record<FreeFormSubject, string> = {
  math: '数学',
  physics: '物理',
  chemistry: '化学',
};

/** 学习档案字段上限：防止把长文塞进 system prompt（也防提示词注入撑爆上下文）。 */
export const PROFILE_LIMITS = {
  grade: 20,
  textbook: 30,
  learnedContent: 2000,
  stuckPoint: 500,
} as const;

export interface FreeformLearningProfile {
  grade?: string;
  textbook?: string;
  learnedContent?: string;
  stuckPoint?: string;
}

/** 容错取学科 id：DTO 没校验层，可能是字符串/小数/负数；只认 1/4/5。 */
export function normalizeFreeFormSubjectId(raw: unknown): number | undefined {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isInteger(n)) return undefined;
  return n in SUBJECT_ID_TO_NAME ? n : undefined;
}

/** 解析成模板用的学科键；未知 id 一律回落数学（不抛错，避免影响别的入口）。 */
export function resolveFreeFormSubject(id?: number | null): FreeFormSubject {
  const normalized = normalizeFreeFormSubjectId(id);
  return normalized ? SUBJECT_ID_TO_NAME[normalized] : 'math';
}

/** 按上限裁剪；非字符串/纯空白一律视为未填。 */
function clean(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

export interface FreeformPromptVars {
  grade: string;
  textbook: string;
  /** 进正文的整句：有教材用「使用人教版教材」，没有则明确说明不要引用页码/章节号。 */
  textbookPhrase: string;
  learnedContent: string;
  stuckPoint: string;
  subjectName: string;
  hasTextbook: boolean;
  hasLearnedContent: boolean;
  hasStuckPoint: boolean;
  /** 直接透传给 PromptBuilder 的 customVariables（Mustache 视图） */
  [key: string]: string | boolean;
}

export function buildFreeformPromptVars(input: {
  profile?: FreeformLearningProfile | null;
  studentGrade?: string;
  subject: FreeFormSubject;
}): FreeformPromptVars {
  const p = input.profile ?? {};
  const grade = clean(p.grade, PROFILE_LIMITS.grade) || clean(input.studentGrade, PROFILE_LIMITS.grade) || '该年级';
  const textbook = clean(p.textbook, PROFILE_LIMITS.textbook);
  const learnedContent = clean(p.learnedContent, PROFILE_LIMITS.learnedContent);
  const stuckPoint = clean(p.stuckPoint, PROFILE_LIMITS.stuckPoint);

  return {
    grade,
    textbook,
    textbookPhrase: textbook ? `使用${textbook}教材` : '教材版本未填写（不要引用具体教材的章节号或页码）',
    learnedContent,
    stuckPoint,
    subjectName: FREE_FORM_SUBJECT_LABELS[input.subject],
    hasTextbook: Boolean(textbook),
    hasLearnedContent: Boolean(learnedContent),
    hasStuckPoint: Boolean(stuckPoint),
  };
}
