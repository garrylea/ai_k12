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
});
