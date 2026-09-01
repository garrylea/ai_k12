/** 年级标签 <-> grade_N code <-> 学段 映射。
 * 与 data-refinery db_loader.grade_to_code 约定对齐：semesters.grade 存 grade_N（如 grade_9），
 * students.grade 存中文标签（与家长端开通表单 GRADES 一致）。
 */

export type GradeBand = 'primary' | 'junior' | 'senior';

export interface GradeInfo {
  code: string;
  label: string;
  band: GradeBand;
}

export const GRADE_LIST: GradeInfo[] = [
  { code: 'grade_1', label: '小学一年级', band: 'primary' },
  { code: 'grade_2', label: '小学二年级', band: 'primary' },
  { code: 'grade_3', label: '小学三年级', band: 'primary' },
  { code: 'grade_4', label: '小学四年级', band: 'primary' },
  { code: 'grade_5', label: '小学五年级', band: 'primary' },
  { code: 'grade_6', label: '小学六年级', band: 'primary' },
  { code: 'grade_7', label: '初一', band: 'junior' },
  { code: 'grade_8', label: '初二', band: 'junior' },
  { code: 'grade_9', label: '初三', band: 'junior' },
  { code: 'grade_10', label: '高一', band: 'senior' },
  { code: 'grade_11', label: '高二', band: 'senior' },
  { code: 'grade_12', label: '高三', band: 'senior' },
];

export function gradeInfoByCode(code: string): GradeInfo | undefined {
  return GRADE_LIST.find(g => g.code === code);
}

export function gradeInfoByLabel(label: string): GradeInfo | undefined {
  return GRADE_LIST.find(g => g.label === label);
}

/** grade_N -> 学段；未知 code 返回 undefined。 */
export function bandFromGradeCode(code: string): GradeBand | undefined {
  return gradeInfoByCode(code)?.band;
}

/** 中文年级标签 -> grade_N code；未知标签返回 undefined。 */
export function gradeCodeFromLabel(label: string): string | undefined {
  return gradeInfoByLabel(label)?.code;
}
