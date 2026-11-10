import { describe, it, expect, beforeAll } from 'vitest';
import { PromptBuilder } from './prompt-builder.js';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const testTemplateDir = resolve(__dirname, '../../test-fixtures/prompts');

beforeAll(() => {
  rmSync(testTemplateDir, { recursive: true, force: true });
  mkdirSync(resolve(testTemplateDir, 'tutoring/math'), { recursive: true });
  mkdirSync(resolve(testTemplateDir, 'system'), { recursive: true });
  mkdirSync(resolve(testTemplateDir, 'explanation'), { recursive: true });
  mkdirSync(resolve(testTemplateDir, 'grading'), { recursive: true });
  mkdirSync(resolve(testTemplateDir, 'freeform'), { recursive: true });

  writeFileSync(resolve(testTemplateDir, 'system/socratic-rules.md'), `---
version: "1.0"
description: "苏格拉底规则片段"
---

### 核心原则
1. 绝不直接给答案
2. 积极鼓励`);
  writeFileSync(resolve(testTemplateDir, 'system/safety-rules.md'), `### 安全规则
- 不讨论非学习内容`);
  writeFileSync(resolve(testTemplateDir, 'tutoring/math/mainline.md'), `---
version: "1.0"
description: "数学主线辅导"
---

## System Prompt
你是数学辅导老师。
{{> socratic-rules}}
{{> safety-rules}}

<card_content>
{{cardContent}}
</card_content>

## User Message
{{userMessage}}`);
  writeFileSync(resolve(testTemplateDir, 'explanation/error-analysis.md'), `---
version: "1.0"
description: "错题解析"
---

## System Prompt
错因分析模板。

## User Message
{{userMessage}}`);
  writeFileSync(resolve(testTemplateDir, 'explanation/knowledge-retry.md'), `---
version: "1.0"
description: "知识点重讲"
---

## System Prompt
知识点重讲模板。

## User Message
{{userMessage}}`);
  writeFileSync(resolve(testTemplateDir, 'explanation/solution.md'), `---
version: "1.0"
description: "标准题解"
---

## System Prompt
标准题解模板。

## User Message
{{userMessage}}`);
  writeFileSync(resolve(testTemplateDir, 'grading/math-proof.md'), `---
version: "1.0"
description: "证明题批改"
---

## System Prompt
评分模板，满分 {{maxScore}}。

## User Message
学生答案：{{studentAnswer}}
满分：{{maxScore}} 分
`);
  writeFileSync(resolve(testTemplateDir, 'freeform/split.md'), `---
version: "1.0"
description: "自由做题拆题"
---

## System Prompt
拆题模板。

## User Message
{{userMessage}}`);
  writeFileSync(resolve(testTemplateDir, 'freeform/judge.md'), `---
version: "1.0"
description: "自由做题判题"
---

## System Prompt
自由做题判题模板。

## User Message
{{userMessage}}`);

  // 做题页答疑：三学科模块共用一份核心 partial（与真实模板同构）
  mkdirSync(resolve(testTemplateDir, 'freeform/tutor'), { recursive: true });
  writeFileSync(resolve(testTemplateDir, 'system/freeform-core.md'), `# 学生信息
- 年级：{{grade}}
- 教材：{{textbookPhrase}}
{{#hasLearnedContent}}<learned_content>{{learnedContent}}</learned_content>{{/hasLearnedContent}}
{{^hasLearnedContent}}（学生未填写已学内容）{{/hasLearnedContent}}
通用核心：抽丝剥茧`);
  for (const [module, marker] of [
    ['math', '数学模块'],
    ['physics', '物理模块'],
    ['chemistry', '化学模块'],
  ] as const) {
    writeFileSync(resolve(testTemplateDir, `freeform/tutor/${module}.md`), `---
version: "2.0"
description: "做题入口答疑 - ${module}"
---

## System Prompt
{{> freeform-core}}

### 二、学科模块
${marker}

## User Message
{{userMessage}}`);
  }
});

describe('PromptBuilder', () => {
  const builder = new PromptBuilder(testTemplateDir);

  it('builds messages for math mainline tutoring', async () => {
    const result = await builder.build({
      capability: 'tutoring',
      subject: 'math',
      track: 'mainline',
      context: {
        student: { grade: '七年级', gradeLevel: 'junior' },
        cardContent: '一元一次方程：含有一个未知数且未知数的最高次数为1的方程。',
        knowledgePoint: { id: 'kp_001', name: '一元一次方程' },
        userMessage: '老师，这个方程怎么解？',
      },
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe('system');
    expect(result.messages[0].content).toContain('绝不直接给答案');
    expect(result.messages[0].content).not.toContain('苏格拉底规则片段');
    expect(result.messages[0].content).not.toContain('version');
    expect(result.messages[0].content).toContain('一元一次方程');
    expect(result.messages[1].role).toBe('user');
    expect(result.messages[1].content).toContain('老师，这个方程怎么解？');
    expect(result.templateVersion).toBe('1.0');
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  it('loads template from cache on second call', async () => {
    const context = {
      student: { grade: '七年级', gradeLevel: 'junior' },
      userMessage: '测试缓存',
    };

    const result1 = await builder.build({
      capability: 'tutoring', subject: 'math', track: 'mainline', context,
    });
    const result2 = await builder.build({
      capability: 'tutoring', subject: 'math', track: 'mainline', context,
    });

    expect(result1.messages[0].content).toBe(result2.messages[0].content);
  });

  it('throws for missing template file', async () => {
    await expect(builder.build({
      capability: 'tutoring',
      subject: 'math',
      track: 'nonexistent' as any,
      context: {
        student: { grade: '七年级', gradeLevel: 'junior' },
        userMessage: 'test',
      },
    })).rejects.toThrow(/Template not found/);
  });

  it('selects knowledge-retry template when mode is knowledge_retry', async () => {
    const result = await builder.build({
      capability: 'explanation',
      subject: 'math',
      mode: 'knowledge_retry',
      context: {
        student: { grade: '七年级', gradeLevel: 'junior' },
        userMessage: '帮我重新讲解',
      },
    });
    expect(result.templateVersion).toBe('1.0');
    expect(result.messages[0].content).toContain('知识点重讲模板');
  });

  it('selects error-analysis template when mode is error_analysis', async () => {
    const result = await builder.build({
      capability: 'explanation',
      subject: 'math',
      mode: 'error_analysis',
      context: {
        student: { grade: '七年级', gradeLevel: 'junior' },
        userMessage: '帮我分析错因',
      },
    });
    expect(result.messages[0].content).toContain('错因分析模板');
  });

  it('selects solution template when mode is solution', async () => {
    const result = await builder.build({
      capability: 'explanation',
      subject: 'math',
      mode: 'solution',
      context: {
        student: { grade: '七年级', gradeLevel: 'junior' },
        userMessage: '生成标准题解',
      },
    });
    expect(result.templateVersion).toBe('1.0');
    expect(result.messages[0].content).toContain('标准题解模板');
  });

  it('renders customVariables into template', async () => {
    const result = await builder.build({
      capability: 'grading',
      subject: 'math',
      questionType: 'proof',
      context: {
        student: { grade: '七年级', gradeLevel: 'junior' },
        studentAnswer: 'x=3',
        userMessage: '请批改',
        customVariables: { maxScore: '10' },
      },
    });
    expect(result.messages[0].content).toContain('满分 10');
    expect(result.messages[1].content).toContain('满分：10 分');
    expect(result.messages[0].content).not.toContain('{{maxScore}}');
  });

  it('does not HTML-escape special characters in rendered values', async () => {
    const result = await builder.build({
      capability: 'grading',
      subject: 'math',
      questionType: 'proof',
      context: {
        student: { grade: '七年级', gradeLevel: 'junior' },
        studentAnswer: 'x<3 & y>2',
        userMessage: '请批改',
        customVariables: { maxScore: '10' },
      },
    });
    // These are LLM prompts, not HTML: = < > & in math content must be preserved.
    expect(result.messages[1].content).toContain('x<3 & y>2');
    expect(result.messages[1].content).not.toContain('&lt;');
    expect(result.messages[1].content).not.toContain('&gt;');
    expect(result.messages[1].content).not.toContain('&amp;');
    expect(result.messages[1].content).not.toContain('&#x3D;');
  });

  it('loads freeform/split.md for freeform_split capability', async () => {
    const result = await builder.build({
      capability: 'freeform_split',
      subject: 'math',
      context: {
        student: { grade: '七年级', gradeLevel: 'junior' },
        userMessage: '帮我拆这道题',
      },
    });
    expect(result.messages[0].content).toContain('拆题模板');
  });

  it('loads freeform/judge.md for freeform_judge capability', async () => {
    const result = await builder.build({
      capability: 'freeform_judge',
      subject: 'physics',
      context: {
        student: { grade: '八年级', gradeLevel: 'junior' },
        userMessage: '请判这道题',
      },
    });
    expect(result.messages[0].content).toContain('自由做题判题模板');
  });

  it('preserves ## headings inside the user message', async () => {
    // Regression: buildMessages used to split the rendered prompt on /^##\s+/m
    // (every markdown H2), so injected content such as MinerU output with
    // "## 一、选择题" truncated the user message at the first heading.
    const result = await builder.build({
      capability: 'freeform_split',
      subject: 'math',
      context: {
        student: { grade: '八年级', gradeLevel: 'junior' },
        userMessage: '## 题目\n求 x 的值。\nEND',
      },
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[1].role).toBe('user');
    expect(result.messages[1].content).toContain('## 题目');
    expect(result.messages[1].content).toContain('求 x 的值。');
    expect(result.messages[1].content).toContain('END');
    // The injected heading must not leak into the system message either.
    expect(result.messages[0].content).not.toContain('## 题目');
  });

  it('splits a normal template into exactly one system and one user message', async () => {
    const result = await builder.build({
      capability: 'freeform_judge',
      subject: 'physics',
      context: {
        student: { grade: '八年级', gradeLevel: 'junior' },
        userMessage: '请判这道题',
      },
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe('system');
    expect(result.messages[1].role).toBe('user');
    expect(result.messages[0].content).toBe('自由做题判题模板。');
    expect(result.messages[1].content).toBe('请判这道题');
  });

  it('freeform_tutor 按学科选模块（物理/化学/其它回落数学）', async () => {
    const vars = {
      grade: '初二',
      textbookPhrase: '使用人教版教材',
      hasLearnedContent: false,
      learnedContent: '',
    };

    const physics = await builder.build({
      capability: 'freeform_tutor',
      subject: 'physics',
      context: { student: { grade: '初二', gradeLevel: 'junior' }, userMessage: '这题怎么做', customVariables: vars },
    });
    expect(physics.messages[0].content).toContain('物理模块');
    expect(physics.messages[0].content).not.toContain('数学模块');
    expect(physics.templateVersion).toBe('2.0');

    const chemistry = await builder.build({
      capability: 'freeform_tutor',
      subject: 'chemistry',
      context: { student: { grade: '初三', gradeLevel: 'junior' }, userMessage: '这题怎么做', customVariables: vars },
    });
    expect(chemistry.messages[0].content).toContain('化学模块');

    // chinese / politics 等非理科一律回落数学模板，不抛错
    const chinese = await builder.build({
      capability: 'freeform_tutor',
      subject: 'chinese',
      context: { student: { grade: '初二', gradeLevel: 'junior' }, userMessage: '这题怎么做', customVariables: vars },
    });
    expect(chinese.messages[0].content).toContain('数学模块');
  });

  it('freeform_tutor 渲染学习档案变量：多行原文保留、空态有兜底、无残留标签', async () => {
    const full = await builder.build({
      capability: 'freeform_tutor',
      subject: 'math',
      context: {
        student: { grade: '初三', gradeLevel: 'junior' },
        userMessage: '我不会',
        customVariables: {
          grade: '北京初三（上）',
          textbookPhrase: '使用北京版教材',
          hasLearnedContent: true,
          learnedContent: '一元二次方程\n二次函数',
          hasStuckPoint: true,
          stuckPoint: '不会配方',
        },
      },
    });
    expect(full.messages[0].content).toContain('北京初三（上）');
    expect(full.messages[0].content).toContain('使用北京版教材');
    expect(full.messages[0].content).toContain('一元二次方程\n二次函数');
    // 只发学生原话，系统提示词不掺进用户消息
    expect(full.messages[1].content).toBe('我不会');
    expect(full.messages[0].content).not.toContain('{{');

    const empty = await builder.build({
      capability: 'freeform_tutor',
      subject: 'math',
      context: {
        student: { grade: '初三', gradeLevel: 'junior' },
        userMessage: '我不会',
        customVariables: { grade: '初三', textbookPhrase: '教材版本未填写', hasLearnedContent: false, learnedContent: '' },
      },
    });
    expect(empty.messages[0].content).toContain('（学生未填写已学内容）');
    expect(empty.messages[0].content).not.toContain('{{');
  });
});
