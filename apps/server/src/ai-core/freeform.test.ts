import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  PROFILE_LIMITS,
  buildFreeformPromptVars,
  normalizeFreeFormSubjectId,
  resolveFreeFormSubject,
} from './freeform.js';
import { PromptBuilder } from './infra/prompt-builder.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 真实模板目录（src 而不是 dist）——顺手当作模板完整性检查
const realPrompts = resolve(__dirname, 'prompts');

describe('freeform 学科解析', () => {
  it('1/4/5 映射到数学/物理/化学', () => {
    expect(resolveFreeFormSubject(1)).toBe('math');
    expect(resolveFreeFormSubject(4)).toBe('physics');
    expect(resolveFreeFormSubject(5)).toBe('chemistry');
  });

  it('未知/缺失学科一律回落数学（不抛错）', () => {
    for (const v of [undefined, null, 2, 3, 99, 0, -1]) {
      expect(resolveFreeFormSubject(v as number | null | undefined)).toBe('math');
    }
  });

  it('学科 id 容错：字符串数字可用，小数/非数字丢弃', () => {
    expect(normalizeFreeFormSubjectId('4')).toBe(4);
    expect(normalizeFreeFormSubjectId(5)).toBe(5);
    expect(normalizeFreeFormSubjectId('x')).toBeUndefined();
    expect(normalizeFreeFormSubjectId(1.5)).toBeUndefined();
    expect(normalizeFreeFormSubjectId(undefined)).toBeUndefined();
  });
});

describe('buildFreeformPromptVars', () => {
  it('完整档案：三个 has* 均为 true，教材进整句', () => {
    const v = buildFreeformPromptVars({
      profile: { grade: '初三', textbook: '人教版', learnedContent: '二次函数', stuckPoint: '不会配方' },
      studentGrade: '初二',
      subject: 'physics',
    });
    expect(v).toMatchObject({
      grade: '初三',
      textbook: '人教版',
      learnedContent: '二次函数',
      stuckPoint: '不会配方',
      subjectName: '物理',
      hasTextbook: true,
      hasLearnedContent: true,
      hasStuckPoint: true,
    });
    expect(v.textbookPhrase).toContain('人教版');
  });

  it('无档案时回落学生年级，空态布尔为 false 且教材话术不承诺具体版本', () => {
    const v = buildFreeformPromptVars({ profile: null, studentGrade: '七年级', subject: 'math' });
    expect(v.grade).toBe('七年级');
    expect(v.hasTextbook).toBe(false);
    expect(v.hasLearnedContent).toBe(false);
    expect(v.hasStuckPoint).toBe(false);
    expect(v.textbookPhrase).toContain('未填写');
  });

  it('纯空白字段视为未填；超长按上限截断', () => {
    const v = buildFreeformPromptVars({
      profile: {
        grade: '   ',
        textbook: '',
        learnedContent: '   ',
        stuckPoint: 'x'.repeat(PROFILE_LIMITS.stuckPoint + 50),
      },
      studentGrade: '初三',
      subject: 'chemistry',
    });
    expect(v.grade).toBe('初三');
    expect(v.hasLearnedContent).toBe(false);
    expect(v.stuckPoint).toHaveLength(PROFILE_LIMITS.stuckPoint);

    const long = buildFreeformPromptVars({
      profile: { learnedContent: 'y'.repeat(PROFILE_LIMITS.learnedContent + 500) },
      subject: 'math',
    });
    expect(long.learnedContent).toHaveLength(PROFILE_LIMITS.learnedContent);
  });
});

describe('真实提示词模板（src/ai-core/prompts）', () => {
  const builder = new PromptBuilder(realPrompts);

  for (const [subject, marker] of [
    ['math', '学科模块 · 数学'],
    ['physics', '学科模块 · 物理'],
    ['chemistry', '学科模块 · 化学'],
  ] as const) {
    it(`${subject} 模板能渲染：含通用核心与对应学科模块，无残留 Mustache`, async () => {
      const r = await builder.build({
        capability: 'freeform_tutor',
        subject,
        context: {
          student: { grade: '初三', gradeLevel: 'junior' },
          userMessage: '这题怎么做？',
          customVariables: buildFreeformPromptVars({
            profile: { grade: '北京初三（上）', textbook: '北京版', learnedContent: '一元二次方程\n二次函数' },
            subject,
          }),
        },
      });
      const system = r.messages[0].content;
      expect(system).toContain('抽丝剥茧');
      expect(system).toContain('第一块：核心思路');
      // 做题页口径：默认直讲，不拖着学生做苏格拉底式反问
      expect(system).toContain('默认直讲');
      // 输出格式契约：Markdown + $..$ + 内联 SVG + HTML
      expect(system).toContain('输出格式');
      expect(system).toContain('内联 SVG');
      expect(system).toContain('不要**用「你觉得呢？」');
      expect(system).toContain(marker);
      expect(system).toContain('一元二次方程\n二次函数');
      expect(system).toContain('北京初三（上）');
      expect(system).not.toContain('{{');
      // 只发学生原话
      expect(r.messages[1].content).toBe('这题怎么做？');
    });
  }

  it('缺档案时走空态说明（不出现空洞的「已学内容：」）', async () => {
    const r = await builder.build({
      capability: 'freeform_tutor',
      subject: 'math',
      context: {
        student: { grade: '初二', gradeLevel: 'junior' },
        userMessage: '不会',
        customVariables: buildFreeformPromptVars({ profile: null, studentGrade: '初二', subject: 'math' }),
      },
    });
    const system = r.messages[0].content;
    expect(system).toContain('学生未填写');
    expect(system).toContain('不要引用具体教材的章节号或页码');
    expect(system).not.toContain('{{');
  });
});
