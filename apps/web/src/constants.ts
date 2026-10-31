/**
 * 训练轨学科的 id / 文案 / 路径 / 题型 / 自评闸门已迁到 `subjectConfig.ts`（唯一真源）。
 * 这里保留转出，避免改所有既有 import；新代码请直接从 `@/subjectConfig` 取。
 */
export {
  SUBJECT_MATH, SUBJECT_CHINESE, SUBJECT_ENGLISH, SUBJECT_PHYSICS, SUBJECT_CHEMISTRY, SUBJECT_POLITICS,
  MATH_TYPE_OPTIONS, TRAINING_SUBJECTS, getTrainingSubject,
  subjectName, subjectHomePath, parseSubjectId, isMathLikeSubject, selfAssessEligible,
} from './subjectConfig';
export type { SubjectId, TrainingSubjectConfig, SubjectTypeOption } from './subjectConfig';

/** 家长端移动/桌面落点分流断点：竖屏窄视口走移动路由组（spec §4.2）。 */
export const MOBILE_VIEWPORT_BREAKPOINT = 768;
