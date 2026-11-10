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

const CN_DIGIT_CODE: Record<string, string> = {
  一: 'grade_1', 二: 'grade_2', 三: 'grade_3', 四: 'grade_4', 五: 'grade_5', 六: 'grade_6',
  七: 'grade_7', 八: 'grade_8', 九: 'grade_9',
};

/**
 * 宽容解析：标准标签（初一 / 小学三年级）、grade_N code、以及历史脏数据里的
 * 「七年级」「三年级」都收；用于读取旧数据（`students.grade` 曾混存三种写法）。
 * 仍然解析不出（如「大学」）返回 undefined。
 */
export function resolveGradeInfo(raw: string): GradeInfo | undefined {
  const label = (raw ?? '').trim();
  if (!label) return undefined;

  const exact = gradeInfoByLabel(label) ?? gradeInfoByCode(label);
  if (exact) return exact;

  const m = label.match(/^([一二三四五六七八九])年级$/);
  if (m) return gradeInfoByCode(CN_DIGIT_CODE[m[1]]);

  return undefined;
}

const LAST_GRADE_CODE = 'grade_12'; // 高三：不再升级

/**
 * 登录时的年级/年龄校准（纯函数，不碰 DB）。
 *
 * 规则（用户 2026-11-09 裁决）：
 * - 每经过一个 **9 月 1 日**（学年开学）升一级，封顶高三；
 * - 年龄按满 12 个月 +1（`students` 只存 age，没有生日，只能以同一基准年化）；
 * - 年级标签不在表内（历史脏数据，如「三年级」）→ 只加年龄、不动年级，且不抛错；
 * - `changed=false` 时调用方**不要**写库，否则会把基准日往后推、漏掉下一次开学。
 */
export interface GradeAdvanceInput {
  gradeLabel: string;
  schoolLevel: string;
  age: number;
  /** 上次校准时间（grade_updated_at；为空时用 created_at） */
  baselineAt: Date;
  now: Date;
}

export interface GradeAdvanceResult {
  gradeLabel: string;
  schoolLevel: string;
  age: number;
  changed: boolean;
}

/** 数 [baselineAt, now] 之间经过的 9/1 个数（按本地时区）。 */
function countSchoolYearStarts(baselineAt: Date, now: Date): number {
  let count = 0;
  for (let year = baselineAt.getFullYear(); year <= now.getFullYear(); year += 1) {
    const boundary = new Date(year, 8, 1, 0, 0, 0, 0); // 9 月 1 日
    if (boundary > baselineAt && boundary <= now) count += 1;
  }
  return count;
}

/** 满 12 个月的个数（日历口径，2/29 不会算错）。 */
function fullYearsBetween(baselineAt: Date, now: Date): number {
  let years = now.getFullYear() - baselineAt.getFullYear();
  const beforeAnniversary =
    now.getMonth() < baselineAt.getMonth() ||
    (now.getMonth() === baselineAt.getMonth() && now.getDate() < baselineAt.getDate());
  if (beforeAnniversary) years -= 1;
  return Math.max(0, years);
}

export function advanceGradeOnLogin(input: GradeAdvanceInput): GradeAdvanceResult {
  const years = fullYearsBetween(input.baselineAt, input.now);
  const nextAge = input.age + years;

  const info = resolveGradeInfo(input.gradeLabel);
  // 未知标签：只校准年龄，年级/学段原样保留（脏数据不该让登录失败）
  if (!info) {
    return {
      gradeLabel: input.gradeLabel,
      schoolLevel: input.schoolLevel,
      age: nextAge,
      changed: years > 0,
    };
  }

  const starts = countSchoolYearStarts(input.baselineAt, input.now);
  const currentIndex = GRADE_LIST.findIndex(g => g.code === info.code);
  const lastIndex = GRADE_LIST.findIndex(g => g.code === LAST_GRADE_CODE);
  const nextIndex = Math.min(currentIndex + starts, lastIndex);
  const next = GRADE_LIST[nextIndex];

  return {
    // 输出统一写成标准标签：顺便把历史脏数据（grade_N / 「七年级」）收敛掉
    gradeLabel: next.label,
    schoolLevel: next.band,
    age: nextAge,
    changed: next.code !== info.code || nextAge !== input.age || input.gradeLabel !== next.label,
  };
}
