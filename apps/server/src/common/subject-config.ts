/**
 * 训练轨学科差异的唯一真源（spec 2026-10-31 §3.1）。
 *
 * 表外学科（6/7/8）尚无训练入口，任务码回落数学口径：入口误开时行为与今天一致，
 * 不会 500。新增学科时**只改本文件的映射**，不要在业务代码里写 `subjectId === 2`。
 */

export const SUBJECT_MATH = 1;
export const SUBJECT_CHINESE = 2;
export const SUBJECT_ENGLISH = 3;
export const SUBJECT_PHYSICS = 4;
export const SUBJECT_CHEMISTRY = 5;
export const SUBJECT_POLITICS = 9;

const TARGETED_TASK_CODE: Readonly<Record<number, string>> = {
  [SUBJECT_MATH]: 'math_targeted',
  [SUBJECT_CHINESE]: 'cn_targeted',
  [SUBJECT_ENGLISH]: 'en_targeted',
  [SUBJECT_PHYSICS]: 'physics_targeted',
  [SUBJECT_CHEMISTRY]: 'chemistry_targeted',
  [SUBJECT_POLITICS]: 'politics_targeted',
};

const PAPER_TASK_CODE: Readonly<Record<number, string>> = {
  [SUBJECT_MATH]: 'math_paper',
  [SUBJECT_CHINESE]: 'cn_paper',
  [SUBJECT_ENGLISH]: 'en_paper',
  [SUBJECT_PHYSICS]: 'physics_paper',
  [SUBJECT_CHEMISTRY]: 'chemistry_paper',
  [SUBJECT_POLITICS]: 'politics_paper',
};

/** 非客观题一律自评的学科：语文 + 物理 + 化学 + 道法。 */
const SELF_ASSESS_SUBJECTS = new Set<number>([
  SUBJECT_CHINESE, SUBJECT_PHYSICS, SUBJECT_CHEMISTRY, SUBJECT_POLITICS,
]);

/** 闸门①：考试侧「跳过判题直接自评」。语文放全部非客观题；新学科只放真正主观的题型，
 *  填空/计算必须进 JudgeCore 先做归一化比对（spec §3.5）。 */
const OBJECTIVE_TYPES = new Set(['choice', 'multi_choice', 'true_false']);
const NEW_SUBJECT_SKIP_JUDGE_TYPES = new Set(['short_answer', 'proof']);

export function targetedTaskCode(subjectId: number): string {
  return TARGETED_TASK_CODE[Number(subjectId)] ?? 'math_targeted';
}

export function paperTaskCode(subjectId: number): string {
  return PAPER_TASK_CODE[Number(subjectId)] ?? 'math_paper';
}

/** 专项会话的 module 落点（旧内联映射会把英语/道法都写成 math_targeted）。 */
const TARGETED_SESSION_MODULE: Readonly<Record<number, string>> = {
  [SUBJECT_MATH]: 'math_targeted',
  [SUBJECT_CHINESE]: 'cn_targeted',
  [SUBJECT_ENGLISH]: 'en_targeted',
  [SUBJECT_PHYSICS]: 'physics_targeted',
  [SUBJECT_CHEMISTRY]: 'chemistry_targeted',
  [SUBJECT_POLITICS]: 'politics_targeted',
};
export function targetedSessionModule(subjectId: number): string {
  return TARGETED_SESSION_MODULE[Number(subjectId)] ?? 'math_targeted';
}

export function isSelfAssessSubject(subjectId: number): boolean {
  return SELF_ASSESS_SUBJECTS.has(Number(subjectId));
}

/** 英语显式自评类型：只放 short_answer/proof，不含 fill_blank（将来出现要先归一化比对）。 */
const ENGLISH_SELF_ASSESS_TYPES = new Set(['short_answer', 'proof']);
export function isExplicitSelfAssessType(subjectId: number, type: string): boolean {
  return Number(subjectId) === SUBJECT_ENGLISH && ENGLISH_SELF_ASSESS_TYPES.has(type);
}

export function selfAssessSkipsJudging(subjectId: number, type: string): boolean {
  const id = Number(subjectId);
  if (id === SUBJECT_CHINESE) return !OBJECTIVE_TYPES.has(type);
  if (isExplicitSelfAssessType(id, type)) return true;
  if (isSelfAssessSubject(id)) return NEW_SUBJECT_SKIP_JUDGE_TYPES.has(type);
  return false;
}

/** 新学科：fill_blank/calculation 先归一化比对，不等才自评；语文不做（2026-10-28 裁决）。 */
export function prefersExactBeforeSelfAssess(subjectId: number): boolean {
  const id = Number(subjectId);
  return id === SUBJECT_PHYSICS || id === SUBJECT_CHEMISTRY || id === SUBJECT_POLITICS;
}

/**
 * subject_id → AI 路由学科档位（2026-11-01）。
 *
 * 此前 `ai-core` 的 `Subject` 只有 math/chinese/english，物化道共用 math 档位，
 * 导致运营管理里无法给它们单独配模型。现在三科各自成档；生物/历史/地理仍无入口，
 * 回落 math（与 `TARGETED_TASK_CODE` 的兜底口径一致）。
 */
export type RouteSubject = 'math' | 'chinese' | 'english' | 'physics' | 'chemistry' | 'politics';

const ROUTE_SUBJECT: Readonly<Record<number, RouteSubject>> = {
  [SUBJECT_MATH]: 'math',
  [SUBJECT_CHINESE]: 'chinese',
  [SUBJECT_ENGLISH]: 'english',
  [SUBJECT_PHYSICS]: 'physics',
  [SUBJECT_CHEMISTRY]: 'chemistry',
  [SUBJECT_POLITICS]: 'politics',
};

export function subjectCodeOf(subjectId: number | null | undefined): RouteSubject {
  return ROUTE_SUBJECT[Number(subjectId)] ?? 'math';
}

/** 支持「同类型练习」的学科：数学、物理、语文（语文仅基础运用/古诗文类知识点）。 */
export const SIMILAR_PRACTICE_SUBJECTS: ReadonlySet<number> = new Set([
  SUBJECT_MATH, SUBJECT_CHINESE, SUBJECT_PHYSICS,
]);

/**
 * 材料显示位置（2026-11-24 用户裁决：由学科决定，不入库）。
 *
 * 物理/化学/道法的材料在原卷里位于设问**之前**（题前科技阅读、实验材料、道法逐小问材料）
 * → 题干上方；语文/英语的题中材料是设问**之后**的文段/素材 → 题干下方（2026-11-21 口径）。
 * 数学无材料，回落 `null` 与「不渲染材料块」等价。
 */
const MATERIAL_ABOVE_SUBJECTS = new Set<number>([
  SUBJECT_PHYSICS, SUBJECT_CHEMISTRY, SUBJECT_POLITICS,
]);

export function materialPositionFor(subjectId: number | null | undefined): 'before' | null {
  return MATERIAL_ABOVE_SUBJECTS.has(Number(subjectId)) ? 'before' : null;
}

/** 语文同类型练习开放的顶层知识点 code：积累与运用 / 古诗文。 */
export const CN_SIMILAR_KP_ROOTS: readonly string[] = ['C01', 'C02'];
