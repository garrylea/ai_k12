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
  [SUBJECT_PHYSICS]: 'physics_targeted',
  [SUBJECT_CHEMISTRY]: 'chemistry_targeted',
  [SUBJECT_POLITICS]: 'politics_targeted',
};

const PAPER_TASK_CODE: Readonly<Record<number, string>> = {
  [SUBJECT_MATH]: 'math_paper',
  [SUBJECT_CHINESE]: 'cn_paper',
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

export function isSelfAssessSubject(subjectId: number): boolean {
  return SELF_ASSESS_SUBJECTS.has(Number(subjectId));
}

export function selfAssessSkipsJudging(subjectId: number, type: string): boolean {
  const id = Number(subjectId);
  if (id === SUBJECT_CHINESE) return !OBJECTIVE_TYPES.has(type);
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

/** 语文同类型练习开放的顶层知识点 code：积累与运用 / 古诗文。 */
export const CN_SIMILAR_KP_ROOTS: readonly string[] = ['C01', 'C02'];
