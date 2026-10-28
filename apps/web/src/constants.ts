/** 家长端移动/桌面落点分流断点：竖屏窄视口走移动路由组（spec §4.2）。 */
export const MOBILE_VIEWPORT_BREAKPOINT = 768;

/** subjects 表 seed id（与后端/数据管线一致；训练轨页面统一从这里取，不再散落局部常量）。 */
export const SUBJECT_MATH = 1;
export const SUBJECT_CHINESE = 2;
export const SUBJECT_ENGLISH = 3;
export const SUBJECT_PHYSICS = 4;
export const SUBJECT_CHEMISTRY = 5;

export type SubjectId = typeof SUBJECT_MATH | typeof SUBJECT_CHINESE | typeof SUBJECT_ENGLISH;

/**
 * 是否使用「左 LaTeX 输入 + 右预览」的两栏作答区。
 *
 * 理科（数学/物理/化学）需要公式与预览；语文/英语等文字学科只需要一个纯文本框。
 * 新增理科时把 id 加进这里，新增文字学科不用改（走 else 的纯文本）。
 */
export function isMathLikeSubject(subjectId: number): boolean {
  const id = Number(subjectId);
  return id === SUBJECT_MATH || id === SUBJECT_PHYSICS || id === SUBJECT_CHEMISTRY;
}

/** 学科名（页面标题/文案用）。 */
export function subjectName(subjectId: number): string {
  if (Number(subjectId) === SUBJECT_CHINESE) return '语文';
  if (Number(subjectId) === SUBJECT_ENGLISH) return '英语';
  return '数学';
}

/** 学科训练首页：语文已扩成 6 卡训练页，数学仍是三卡选择页。 */
export function subjectHomePath(subjectId: number): string {
  return Number(subjectId) === SUBJECT_CHINESE
    ? '/student/training/chinese/special'
    : '/student/training/home';
}

/** URL 查询参数解析学科 id；缺省/非法一律数学（兼容既有数学入口不带参数的链接）。 */
export function parseSubjectId(raw: string | null): number {
  const n = Number(raw);
  return n === SUBJECT_CHINESE || n === SUBJECT_ENGLISH || n === SUBJECT_MATH ? n : SUBJECT_MATH;
}
