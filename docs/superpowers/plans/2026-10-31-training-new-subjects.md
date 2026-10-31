# 训练轨新增物理 / 化学 / 道法 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让训练轨选科页支持物理（4）/ 化学（5）/ 道德与法治（9），四卡（专项/考试/错题/图谱）与数学同构，学科差异收敛到前后端各一张配置表。

**Architecture:** 后端新增 `common/subject-config.ts` 承载任务码映射与两个自评谓词；前端新增 `subjectConfig.ts` 承载学科卡片数据、路径、题型下拉与内联自评谓词。判题链路上有三道闸门（考试跳过判题 / 判题兜底自评 / 前端内联自评），三者口径不同，必须分别实现（见 spec §3.5）。

**Tech Stack:** NestJS + mysql2（server）、React 18 + React Router 6 + Zustand（web）、vitest + Testing Library。

## Global Constraints

- 设计真源：`docs/superpowers/specs/2026-10-31-training-new-subjects-design.md`。与本文冲突时以 spec 为准，并先向用户确认。
- **数学、语文、英语的现有行为必须逐字不变**（专项任务码、判题分支、题型下拉、页面标题）。任何变化都要有回归用例显式说明。
- 新学科（4/5/9）任意题型**不得调用 `JudgmentCapability`**（AI 判题写死 `subject:'math'`）。
- 不新增路由；训练四卡页与子页复用现有路径，只多带 `?subjectId=`。
- 不做：主线选科、相似题套题（remediation）、题库数据补齐、按年级过滤。
- 文案/图标：不用 emoji；新增图标必须是线性 SVG（本计划不新增图标）。
- 测试铁律：组件改动必须补渲染测试；`vitest globals:false`，多用例文件自己写 `afterEach(() => cleanup())`。
- 每个 Task 结束跑一次对应包的 `npm test` 再提交；提交信息用 `feat(scope): ...` / `test(scope): ...` / `docs(scope): ...`。
- 服务端命令：`cd apps/server && npm test`；前端：`cd apps/web && npm test`。
- API 双文档规则：`docs/API接口与数据流设计文档.md` 与 `docs/api/openapi.yaml` 必须同步；PRD 是唯一真源。

---

### Task 1: 后端学科配置表

**Files:**
- Create: `apps/server/src/common/subject-config.ts`
- Test: `apps/server/src/common/subject-config.test.ts`

**Interfaces:**
- Produces:
  - `SUBJECT_MATH=1 / SUBJECT_CHINESE=2 / SUBJECT_ENGLISH=3 / SUBJECT_PHYSICS=4 / SUBJECT_CHEMISTRY=5 / SUBJECT_POLITICS=9`
  - `targetedTaskCode(subjectId: number): string`（表外回落 `'math_targeted'`）
  - `paperTaskCode(subjectId: number): string`（表外回落 `'math_paper'`）
  - `isSelfAssessSubject(subjectId: number): boolean`（2/4/5/9）
  - `selfAssessSkipsJudging(subjectId: number, type: string): boolean`（闸门 ①）
  - `prefersExactBeforeSelfAssess(subjectId: number): boolean`（4/5/9）

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/src/common/subject-config.test.ts
import { describe, expect, it } from 'vitest';
import {
  isSelfAssessSubject,
  paperTaskCode,
  prefersExactBeforeSelfAssess,
  selfAssessSkipsJudging,
  targetedTaskCode,
} from './subject-config.js';

describe('subject-config 任务码', () => {
  it('五科各自独立', () => {
    expect([1, 2, 4, 5, 9].map(targetedTaskCode)).toEqual([
      'math_targeted', 'cn_targeted', 'physics_targeted', 'chemistry_targeted', 'politics_targeted',
    ]);
    expect([1, 2, 4, 5, 9].map(paperTaskCode)).toEqual([
      'math_paper', 'cn_paper', 'physics_paper', 'chemistry_paper', 'politics_paper',
    ]);
  });

  it('表外学科（6/7/8/NaN）回落数学口径', () => {
    expect(targetedTaskCode(6)).toBe('math_targeted');
    expect(paperTaskCode(8)).toBe('math_paper');
    expect(targetedTaskCode(Number.NaN)).toBe('math_targeted');
  });
});

describe('subject-config 自评口径', () => {
  it('自评学科只有 2/4/5/9', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].filter(isSelfAssessSubject)).toEqual([2, 4, 5, 9]);
  });

  it('闸门①：语文非客观题跳过判题；新学科只有 short_answer/proof 跳过', () => {
    expect(selfAssessSkipsJudging(2, 'fill_blank')).toBe(true);
    expect(selfAssessSkipsJudging(2, 'choice')).toBe(false);
    expect(selfAssessSkipsJudging(4, 'short_answer')).toBe(true);
    expect(selfAssessSkipsJudging(4, 'proof')).toBe(true);
    expect(selfAssessSkipsJudging(4, 'calculation')).toBe(false);
    expect(selfAssessSkipsJudging(5, 'fill_blank')).toBe(false);
    expect(selfAssessSkipsJudging(9, 'short_answer')).toBe(true);
    expect(selfAssessSkipsJudging(1, 'short_answer')).toBe(false);
  });

  it('只有 4/5/9 先做归一化相等再自评', () => {
    expect([1, 2, 3, 4, 5, 9].filter(prefersExactBeforeSelfAssess)).toEqual([4, 5, 9]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/common/subject-config.test.ts`
Expected: FAIL，`Failed to resolve import "./subject-config.js"`。

- [ ] **Step 3: 实现**

```ts
// apps/server/src/common/subject-config.ts
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
const OBJECTIVE_TYPES = new Set(['choice', 'true_false']);
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/common/subject-config.test.ts`
Expected: PASS（4 个用例）。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/common/subject-config.ts apps/server/src/common/subject-config.test.ts
git commit -m "feat(server): 新增学科配置表（任务码/自评口径）"
```

---

### Task 2: 判题兜底自评 + 新学科填空/计算先比对

**Files:**
- Modify: `apps/server/src/modules/practice/judge-core.service.ts:137-139`、`:269-270`
- Test: `apps/server/src/modules/practice/judge-core.service.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `isSelfAssessSubject`、`prefersExactBeforeSelfAssess`
- Produces: `judgeQuestion` 对新学科返回 `method='self_assess' | 'exact' | 'unanswered'`（绝不 `'ai'`）

- [ ] **Step 1: 写失败测试**

追加到 `judge-core.service.test.ts` 的 `describe('JudgeCoreService.judgeQuestion')` 内：

```ts
  const subjectQuestion = (subjectId: number, type: string, answer: string) => ({
    questionsRepo: {
      findById: vi.fn().mockResolvedValue({ id: 30, subject_id: subjectId, type, answer, options: null }),
      findByContentHash: vi.fn(),
      findOrCreate: vi.fn(),
      deleteById: vi.fn(),
    },
  });

  it('化学填空：归一化相等 -> exact 判对，不进自评', async () => {
    const deps = mk(subjectQuestion(5, 'fill_blank', 'CO2'));
    const r = await mkSvc(deps).judgeQuestion({
      studentId: 1, subjectId: 5, questionId: 30, studentAnswer: ' co2 ', source: 'targeted',
    });
    expect(r.isCorrect).toBe(true);
    expect(r.method).toBe('exact');
    expect(r.needsSelfAssessment).toBeUndefined();
  });

  it('化学填空：不等 -> self_assess（不调 AI）', async () => {
    const deps = mk(subjectQuestion(5, 'fill_blank', 'CO2'));
    const r = await mkSvc(deps).judgeQuestion({
      studentId: 1, subjectId: 5, questionId: 30, studentAnswer: 'O2', source: 'targeted',
    });
    expect(r.isCorrect).toBeNull();
    expect(r.method).toBe('self_assess');
    expect(r.needsSelfAssessment).toBe(true);
    expect(r.referenceAnswer).toBe('CO2');
    expect(deps.judgment.judge).not.toHaveBeenCalled();
  });

  it('物理计算题：不等 -> self_assess（不调 AI）', async () => {
    const deps = mk(subjectQuestion(4, 'calculation', '0.5A'));
    const r = await mkSvc(deps).judgeQuestion({
      studentId: 1, subjectId: 4, questionId: 30, studentAnswer: '1A', source: 'exam',
    });
    expect(r.method).toBe('self_assess');
    expect(deps.judgment.judge).not.toHaveBeenCalled();
  });

  it('语文填空仍直接自评（回归钉子：第 3 步不抢语文）', async () => {
    const deps = mk(subjectQuestion(2, 'fill_blank', '春风又绿江南岸'));
    const r = await mkSvc(deps).judgeQuestion({
      studentId: 1, subjectId: 2, questionId: 30, studentAnswer: '春风又绿江南岸', source: 'targeted',
    });
    expect(r.method).toBe('self_assess');
    expect(r.isCorrect).toBeNull();
  });

  it('数学填空不等仍走 AI（回归钉子：数学分支不变）', async () => {
    const deps = mk(subjectQuestion(1, 'fill_blank', '2/3'));
    deps.judgment.judge.mockResolvedValue({ isCorrect: true, errorType: null });
    const r = await mkSvc(deps).judgeQuestion({
      studentId: 1, subjectId: 1, questionId: 30, studentAnswer: '0.66', source: 'targeted',
    });
    expect(deps.judgment.judge).toHaveBeenCalled();
    expect(r.method).toBe('ai');
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/practice/judge-core.service.test.ts`
Expected: 化学不等用例 FAIL（当前会调 `judgment.judge`，`method` 为 `'ai'`）。

- [ ] **Step 3: 改实现**

顶部导入：

```ts
import { isSelfAssessSubject, prefersExactBeforeSelfAssess } from '../../common/subject-config.js';
```

把 `isChineseNonObjective`（:137-139）替换为：

```ts
/** 闸门②：该学科的非客观题在归一化比对失败后一律自评。
 *  语文自 2026-10-28 起如此；物理/化学/道法沿用同一口径（spec 2026-10-31 §3.5）。 */
function isSelfAssessNonObjective(q: { subject_id?: number | null; type: string }): boolean {
  return isSelfAssessSubject(Number(q.subject_id)) && !EXACT_ONLY_TYPES.has(q.type);
}
```

在 `judgeQuestion` 里，把 `:269` 的分支改为（**新增一条前置分支**）：

```ts
    } else if (prefersExactBeforeSelfAssess(Number(q.subject_id))
               && (q.type === 'fill_blank' || q.type === 'calculation')
               && compareAnswer(input.studentAnswer, q.answer, q.options)) {
      // 新学科：填空/计算先做归一化比对，命中即判对（语文不走这里，仍直接自评）
      isCorrect = true;
      method = 'exact';
    } else if (isSelfAssessNonObjective(q) ||
               (SUBJECTIVE_TYPES.has(q.type) && subjectiveJudgeMode() === 'self_assess')) {
```

保留其后的 `fill_blank/calculation && compareAnswer` 分支（数学路径 1b）与 AI 分支不变。

- [ ] **Step 4: 跑整个判题测试**

Run: `cd apps/server && npx vitest run src/modules/practice/`
Expected: 全绿（含既有 87+ 用例）。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/modules/practice/judge-core.service.ts apps/server/src/modules/practice/judge-core.service.test.ts
git commit -m "feat(practice): 新学科非客观题自评，填空/计算先归一化比对"
```

---

### Task 3: 考试闸门 + 无答案题不写错题本

**Files:**
- Modify: `apps/server/src/modules/exams/exams.service.ts:36-39`、`:307-345`
- Modify: `apps/server/src/database/repositories/exam-papers.repo.ts:18-28`、`:85-95`
- Test: `apps/server/src/modules/exams/exams.service.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `selfAssessSkipsJudging`
- Produces: `shouldSelfAssess(subjectId, type)` 语义收窄（化学填空返回 false）；`PaperQuestionRow.hasAnswer: number`（0 = 无参考答案）

- [ ] **Step 1: 写失败测试**

追加到 `exams.service.test.ts`：

```ts
describe('ExamsService.shouldSelfAssess（闸门①）', () => {
  it('语文非客观题放行，客观题不放行', () => {
    expect(shouldSelfAssess(2, 'fill_blank')).toBe(true);
    expect(shouldSelfAssess(2, 'choice')).toBe(false);
  });

  it('新学科只有 short_answer/proof 跳过判题，填空/计算必须进判题', () => {
    expect(shouldSelfAssess(4, 'short_answer')).toBe(true);
    expect(shouldSelfAssess(5, 'short_answer')).toBe(true);
    expect(shouldSelfAssess(9, 'short_answer')).toBe(true);
    expect(shouldSelfAssess(4, 'calculation')).toBe(false);
    expect(shouldSelfAssess(5, 'fill_blank')).toBe(false);
  });

  it('数学主观题沿用 JUDGE_SUBJECTIVE_MODE=self_assess', () => {
    expect(shouldSelfAssess(1, 'short_answer')).toBe(true);
    expect(shouldSelfAssess(1, 'fill_blank')).toBe(false);
  });

  it('新学科即使 JUDGE_SUBJECTIVE_MODE=ai 也跳过判题（闸门①先于模式开关）', () => {
    process.env.JUDGE_SUBJECTIVE_MODE = 'ai';
    expect(shouldSelfAssess(4, 'short_answer')).toBe(true);
    expect(shouldSelfAssess(5, 'short_answer')).toBe(true);
    expect(shouldSelfAssess(9, 'proof')).toBe(true);
    expect(shouldSelfAssess(1, 'short_answer')).toBe(false);
  });
});

describe('ExamsService.finalizeSession 无答案题', () => {
  it('未作答且无参考答案 -> 记 0 分但不写错题本', async () => {
    const deps = mk();
    deps.examPapersRepo.findById.mockResolvedValue(paperRow);
    deps.examPapersRepo.findQuestionsByPaperId.mockResolvedValue([
      { questionId: 10, questionNo: 1, text: '无答案题', type: 'choice', options: null, materialText: null, hasAnswer: 0 },
    ]);
    deps.examSessionsRepo.findAnswersBySession.mockResolvedValue([]);
    deps.examSessionsRepo.findById.mockResolvedValue(sessionRow());

    await mkSvc(deps).submit(1, 77);

    expect(deps.examSessionsRepo.upsertAnswer).toHaveBeenCalledWith(expect.objectContaining({
      questionId: 10, isCorrect: 0, method: 'unanswered',
    }));
    expect(deps.mainErrorRepo.create).not.toHaveBeenCalled();
  });

  it('未作答但有参考答案 -> 仍写错题本（旧行为）', async () => {
    const deps = mk();
    deps.examPapersRepo.findById.mockResolvedValue(paperRow);
    deps.examPapersRepo.findQuestionsByPaperId.mockResolvedValue([
      { questionId: 10, questionNo: 1, text: '正常题', type: 'choice', options: null, materialText: null, hasAnswer: 1 },
    ]);
    deps.examSessionsRepo.findAnswersBySession.mockResolvedValue([]);
    deps.examSessionsRepo.findById.mockResolvedValue(sessionRow());

    await mkSvc(deps).submit(1, 77);

    expect(deps.mainErrorRepo.create).toHaveBeenCalled();
  });
});
```

文件顶部导入改为：`import { ExamsService, computeRecommendedDuration, shouldSelfAssess } from './exams.service';`

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/exams/exams.service.test.ts`
Expected: FAIL ——「JUDGE_SUBJECTIVE_MODE=ai」用例（新学科当前返回 false）与「无答案题」用例（`hasAnswer` 尚未生效，仍写错题本）都会失败；其余闸门用例在默认 `self_assess` 模式下与现状同值，属回归钉子。

- [ ] **Step 3: 改实现**

`exams.service.ts`：

```ts
import { selfAssessSkipsJudging } from '../../common/subject-config.js';

/**
 * 是否「跳过判题、直接自评」（闸门①）。
 *
 * - 语文：非客观题一律自评（2026-10-28）。
 * - 物理/化学/道法：仅 short_answer/proof；fill_blank/calculation 必须进 JudgeCore
 *   先做归一化比对，否则化学填空永远判不对（spec 2026-10-31 §3.5）。
 * - 数学：沿用 JUDGE_SUBJECTIVE_MODE（默认 self_assess）。
 */
export function shouldSelfAssess(subjectId: number, type: string): boolean {
  if (selfAssessSkipsJudging(subjectId, type)) return true;
  return subjectiveJudgeMode() === 'self_assess' && SUBJECTIVE_TYPES.has(type);
}
```

`finalizeSession` 的未作答分支（:332-344）改成：

```ts
        await this.writeExamErrorBookIfAnswerable(session, q);
```

并新增私有方法（放在 `writeExamErrorBook` 上方）：

```ts
  /** 未作答按错计入错题本；**无参考答案的题不入本**——否则错题练习再遇到它走空答案守卫，
   *  既不自评也不清零，学生在 App 里永远清不掉（物理 51/52/53 号卷即此情况）。 */
  private async writeExamErrorBookIfAnswerable(
    session: ExamSessionRow,
    q: { questionId: number; hasAnswer?: number },
  ): Promise<void> {
    if (q.hasAnswer === 0) return;
    await this.writeExamErrorBook(session, q.questionId);
  }
```

`exam-papers.repo.ts`：

```ts
/** 试卷题目元数据行（不含 answer/explanation 正文；hasAnswer 只暴露布尔标记）。 */
export interface PaperQuestionRow {
  questionId: number;
  questionNo: number;
  text: string;
  type: string;
  options: string | null;
  materialText: string | null;
  /** 1 = 有参考答案；0 = 空答案（判不了分，交卷时不入错题本）。 */
  hasAnswer: number;
}
```

查询改为：

```sql
      `SELECT q.id AS questionId, pq.question_no AS questionNo, q.content AS text, q.type,
              q.options, q.material_text AS materialText,
              (q.answer IS NOT NULL AND TRIM(q.answer) <> '') AS hasAnswer
       FROM paper_questions pq JOIN questions q ON q.id = pq.question_id
       WHERE pq.paper_id = ? AND q.is_active = 1 AND pq.in_exam = 1
       ORDER BY pq.question_no`,
```

> `hasAnswer` 不进 `toSessionQuestion`，对客户端不可见；测试 fixture 缺该字段时 `=== 0` 不成立，保持旧行为。

- [ ] **Step 4: 跑考试测试**

Run: `cd apps/server && npx vitest run src/modules/exams/`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/modules/exams apps/server/src/database/repositories/exam-papers.repo.ts
git commit -m "feat(exams): 新学科自评闸门收窄，无答案题交卷不入错题本"
```

---

### Task 4: 积分任务码

**Files:**
- Modify: `apps/server/src/modules/points/default-rules.ts:11-62`
- Test: `apps/server/src/modules/points/default-rules.test.ts`

**Interfaces:**
- Produces: `DEFAULT_RULES` 增加 15 行；`TASK_NAMES` 增加 6 条（Task 5 依赖这些任务码存在，否则 `listTierKeys` 返回空、开练 400）

- [ ] **Step 1: 写失败测试**

修改 `default-rules.test.ts`：

```ts
  it('共 38 行', () => {
    expect(DEFAULT_RULES).toHaveLength(38);
  });
```

在「有每日上限的只有三类任务」用例里补：

```ts
    for (const code of ['physics_targeted', 'chemistry_targeted', 'politics_targeted']) {
      expect(tiersOf(code)).toEqual(['1', '3', '5', '10']);
    }
```

黄金值数组在 `['cn_paper', ...]` 后插入三行：

```ts
      ['physics_paper', 'default', 50, null],
      ['chemistry_paper', 'default', 50, null],
      ['politics_paper', 'default', 50, null],
```

并在 `['cn_targeted', '10', 35, 5],` 之后追加：

```ts
      ['physics_targeted', '1', 2, 5],
      ['physics_targeted', '3', 8, 5],
      ['physics_targeted', '5', 15, 5],
      ['physics_targeted', '10', 35, 5],
      ['chemistry_targeted', '1', 2, 5],
      ['chemistry_targeted', '3', 8, 5],
      ['chemistry_targeted', '5', 15, 5],
      ['chemistry_targeted', '10', 35, 5],
      ['politics_targeted', '1', 2, 5],
      ['politics_targeted', '3', 8, 5],
      ['politics_targeted', '5', 15, 5],
      ['politics_targeted', '10', 35, 5],
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/points/default-rules.test.ts`
Expected: FAIL，长度 23 ≠ 38。

- [ ] **Step 3: 改实现**

`TASK_NAMES` 补：

```ts
  physics_paper: '物理卷子一套',
  chemistry_paper: '化学卷子一套',
  politics_paper: '道法卷子一套',
  physics_targeted: '物理专项',
  chemistry_targeted: '化学专项',
  politics_targeted: '道法专项',
```

`DEFAULT_RULES` 在 `cn_paper` 后插入：

```ts
  { taskCode: 'physics_paper',     taskName: '物理卷子一套', tierKey: 'default', tierLabel: '一套',   points: 50, dailyLimit: null, sortOrder: 26 },
  { taskCode: 'chemistry_paper',   taskName: '化学卷子一套', tierKey: 'default', tierLabel: '一套',   points: 50, dailyLimit: null, sortOrder: 27 },
  { taskCode: 'politics_paper',    taskName: '道法卷子一套', tierKey: 'default', tierLabel: '一套',   points: 50, dailyLimit: null, sortOrder: 28 },
```

数组末尾（`cn_targeted` 四行之后）追加：

```ts
  { taskCode: 'physics_targeted',   taskName: '物理专项', tierKey: '1',  tierLabel: '1 题',  points: 2,  dailyLimit: 5, sortOrder: 100 },
  { taskCode: 'physics_targeted',   taskName: '物理专项', tierKey: '3',  tierLabel: '3 题',  points: 8,  dailyLimit: 5, sortOrder: 101 },
  { taskCode: 'physics_targeted',   taskName: '物理专项', tierKey: '5',  tierLabel: '5 题',  points: 15, dailyLimit: 5, sortOrder: 102 },
  { taskCode: 'physics_targeted',   taskName: '物理专项', tierKey: '10', tierLabel: '10 题', points: 35, dailyLimit: 5, sortOrder: 103 },
  { taskCode: 'chemistry_targeted', taskName: '化学专项', tierKey: '1',  tierLabel: '1 题',  points: 2,  dailyLimit: 5, sortOrder: 110 },
  { taskCode: 'chemistry_targeted', taskName: '化学专项', tierKey: '3',  tierLabel: '3 题',  points: 8,  dailyLimit: 5, sortOrder: 111 },
  { taskCode: 'chemistry_targeted', taskName: '化学专项', tierKey: '5',  tierLabel: '5 题',  points: 15, dailyLimit: 5, sortOrder: 112 },
  { taskCode: 'chemistry_targeted', taskName: '化学专项', tierKey: '10', tierLabel: '10 题', points: 35, dailyLimit: 5, sortOrder: 113 },
  { taskCode: 'politics_targeted',  taskName: '道法专项', tierKey: '1',  tierLabel: '1 题',  points: 2,  dailyLimit: 5, sortOrder: 120 },
  { taskCode: 'politics_targeted',  taskName: '道法专项', tierKey: '3',  tierLabel: '3 题',  points: 8,  dailyLimit: 5, sortOrder: 121 },
  { taskCode: 'politics_targeted',  taskName: '道法专项', tierKey: '5',  tierLabel: '5 题',  points: 15, dailyLimit: 5, sortOrder: 122 },
  { taskCode: 'politics_targeted',  taskName: '道法专项', tierKey: '10', tierLabel: '10 题', points: 35, dailyLimit: 5, sortOrder: 123 },
```

- [ ] **Step 4: 跑积分测试**

Run: `cd apps/server && npx vitest run src/modules/points/`
Expected: 全绿（含 point-rules 的懒初始化用例）。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/modules/points/default-rules.ts apps/server/src/modules/points/default-rules.test.ts
git commit -m "feat(points): 物理/化学/道法各自专项与试卷任务码"
```

---

### Task 5: 训练端点任务码查表

**Files:**
- Modify: `apps/server/src/modules/training/training.controller.ts:168`
- Modify: `apps/server/src/modules/training/training.service.ts:689`
- Modify: `apps/server/src/modules/exams/exams.service.ts:414`
- Test: `apps/server/src/modules/training/training.controller.test.ts`、`training.service.test.ts`、`exams.service.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `targetedTaskCode` / `paperTaskCode`

- [ ] **Step 1: 写失败测试**

`training.controller.test.ts` 追加：

```ts
  it('物理（subjectId=4）按 physics_targeted 校验档位', async () => {
    const { controller, pointRulesService } = makeTargetedController(['1', '3', '5', '10']);
    await controller.startTargetedPractice({ subjectId: 4, kpId: 900, type: null, count: 5 }, USER);
    expect(pointRulesService.listTierKeys).toHaveBeenCalledWith(7, 'physics_targeted');
  });

  it('化学（subjectId=5）按 chemistry_targeted 校验档位', async () => {
    const { controller, pointRulesService } = makeTargetedController(['1', '3', '5', '10']);
    await controller.startTargetedPractice({ subjectId: 5, kpId: 901, type: null, count: 3 }, USER);
    expect(pointRulesService.listTierKeys).toHaveBeenCalledWith(7, 'chemistry_targeted');
  });
```

`training.service.test.ts` 追加：

```ts
  it('物理专项会话 task_code=physics_targeted（学科不串到数学）', async () => {
    const deps = mk({
      questionsRepo: { findRandomByKpAndType: vi.fn().mockResolvedValue([{ ...questionRow, subject_id: 4 }]) },
    });
    await mkSvc(deps).startTargetedPractice({ studentId: 7, subjectId: 4, kpId: 900, type: null, count: 5 });
    expect(deps.trainingSessionsRepo.create).toHaveBeenCalledWith(expect.objectContaining({
      task_code: 'physics_targeted', subject_id: 4, tier_key: '5',
    }));
  });
```

`exams.service.test.ts` 追加：

```ts
describe('ExamsService 交卷发分任务码', () => {
  it.each([
    [4, 'physics_paper'],
    [5, 'chemistry_paper'],
    [9, 'politics_paper'],
    [1, 'math_paper'],
    [2, 'cn_paper'],
  ])('subjectId=%i -> %s', async (subjectId, taskCode) => {
    const deps = mk();
    deps.examPapersRepo.findById.mockResolvedValue({ ...paperRow, subject_id: subjectId });
    deps.examPapersRepo.findQuestionsByPaperId.mockResolvedValue([]);
    deps.examSessionsRepo.findAnswersBySession.mockResolvedValue([]);
    deps.examSessionsRepo.findById.mockResolvedValue(sessionRow({ subject_id: subjectId }));

    await mkSvc(deps).submit(1, 77);

    expect(deps.pointsService.award).toHaveBeenCalledWith(expect.objectContaining({ taskCode }));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/training src/modules/exams`
Expected: 物理/化学任务码用例 FAIL（当前分别得到 `math_targeted` / `math_paper`）。

- [ ] **Step 3: 改实现**

`training.controller.ts`：

```ts
import { targetedTaskCode } from '../../common/subject-config.js';
// ...
    const taskCode = targetedTaskCode(dto.subjectId);
```

`training.service.ts`（两处：建会话与 warn 文案）：

```ts
import { targetedTaskCode } from '../../common/subject-config.js';
// ...
        const taskCode = targetedTaskCode(input.subjectId);
        sessionId = await this.trainingSessionsRepo.create({ /* ... */ task_code: taskCode, /* ... */ });
      } catch (err) {
        this.logger.warn(
          `training_sessions.create failed (taskCode=${targetedTaskCode(input.subjectId)}, studentId=${input.studentId}, tierKey=${input.count}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
```

`exams.service.ts:414`：

```ts
import { paperTaskCode } from '../../common/subject-config.js';
// ...
        taskCode: paperTaskCode(subjectId),
```

- [ ] **Step 4: 跑测试**

Run: `cd apps/server && npx vitest run src/modules/training src/modules/exams`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/modules/training apps/server/src/modules/exams/exams.service.ts apps/server/src/modules/exams/exams.service.test.ts
git commit -m "feat(training): 专项与试卷发分任务码按学科查表"
```

---

### Task 6: 薄弱点图谱门禁放宽

**Files:**
- Modify: `apps/server/src/modules/knowledge-graph/knowledge-graph.controller.ts:43-85`
- Test: `apps/server/src/modules/knowledge-graph/knowledge-graph.controller.test.ts`

**Interfaces:**
- Produces: `subjectId ∈ {1,4,5,9}` 放行；`6/7/8` 仍 400 + 1001

- [ ] **Step 1: 写失败测试**

把 `describe('KnowledgeGraphController subjectId 校验')` 整个替换为：

```ts
describe('KnowledgeGraphController subjectId 校验', () => {
  it.each([1, 4, 5, 9])('subjectId=%i 放行并透传', async (subjectId) => {
    const { ctrl, service } = makeCtrl();
    service.getMastery.mockResolvedValue({});
    await ctrl.getMastery(7, user, subjectId);
    expect(service.getMastery).toHaveBeenCalledWith(7, subjectId);
  });

  it.each([6, 7, 8])('未开放学科 %i -> 400 + code 1001', async (subjectId) => {
    const { ctrl, service } = makeCtrl();
    await expect(ctrl.getMastery(7, user, subjectId)).rejects.toMatchObject({
      response: { code: 1001 },
      status: 400,
    });
    expect(service.getMastery).not.toHaveBeenCalled();
  });

  it('weak-points 同样拒绝未开放学科', async () => {
    const { ctrl } = makeCtrl();
    await expect(ctrl.getWeakPoints(7, user, 6, undefined)).rejects.toMatchObject({
      response: { code: 1001 },
      status: 400,
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/knowledge-graph/knowledge-graph.controller.test.ts`
Expected: 4/5/9 放行用例 FAIL（当前 400）。

- [ ] **Step 3: 改实现**

```ts
import { SUBJECT_MATH, SUBJECT_PHYSICS, SUBJECT_CHEMISTRY, SUBJECT_POLITICS } from '../../common/subject-config.js';

/** 图谱目前开放的学科：数学 + 物理/化学/道法（服务层按 subjectId 通用，仅这里设门禁）。 */
const SUPPORTED_SUBJECTS = new Set([SUBJECT_MATH, SUBJECT_PHYSICS, SUBJECT_CHEMISTRY, SUBJECT_POLITICS]);

  private assertSupportedSubject(subjectId: number): void {
    if (!SUPPORTED_SUBJECTS.has(subjectId)) {
      throw new BadRequestException({ code: 1001, message: 'subjectId 仅支持 1 / 4 / 5 / 9' });
    }
  }
```

两处 `this.assertMathSubject(subjectId)` 改为 `this.assertSupportedSubject(subjectId)`，删除旧方法与旧的 `MATH_SUBJECT_ID` 常量（若仅此处使用）。

- [ ] **Step 4: 跑测试**

Run: `cd apps/server && npx vitest run src/modules/knowledge-graph`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/modules/knowledge-graph
git commit -m "feat(knowledge-graph): 薄弱点图谱放开物理/化学/道法"
```

---

### Task 7: 前端学科配置表 + constants 改造

**Files:**
- Create: `apps/web/src/subjectConfig.ts`
- Modify: `apps/web/src/constants.ts`（整体替换为转出口）
- Test: `apps/web/src/subjectConfig.test.ts`

**Interfaces:**
- Produces:
  - `SUBJECT_MATH/CHINESE/ENGLISH/PHYSICS/CHEMISTRY/POLITICS`、`SubjectId`
  - `TrainingSubjectConfig { id, name, desc, enabled, badge?, homePath, typeOptions, targetedTaskCode?, isMathLike }`
  - `TRAINING_SUBJECTS: readonly TrainingSubjectConfig[]`（顺序 1/2/3/4/5/9）
  - `getTrainingSubject(id: number): TrainingSubjectConfig | undefined`
  - `subjectName(id): string`、`subjectHomePath(id): string`、`parseSubjectId(raw): number`、`isMathLikeSubject(id): boolean`、`selfAssessEligible(subjectId, type): boolean`
  - `MATH_TYPE_OPTIONS`（兜底题型下拉）

- [ ] **Step 1: 写失败测试**

```ts
// apps/web/src/subjectConfig.test.ts
import { describe, expect, it } from 'vitest';
import {
  getTrainingSubject, isMathLikeSubject, parseSubjectId, selfAssessEligible,
  subjectHomePath, subjectName, TRAINING_SUBJECTS,
  SUBJECT_CHEMISTRY, SUBJECT_CHINESE, SUBJECT_ENGLISH, SUBJECT_MATH, SUBJECT_PHYSICS, SUBJECT_POLITICS,
} from './subjectConfig';

describe('TRAINING_SUBJECTS', () => {
  it('六科按 1/2/3/4/5/9 排列，只有道法未开放', () => {
    expect(TRAINING_SUBJECTS.map((s) => s.id)).toEqual([1, 2, 3, 4, 5, 9]);
    expect(TRAINING_SUBJECTS.filter((s) => !s.enabled).map((s) => s.id)).toEqual([9]);
    expect(getTrainingSubject(9)?.badge).toBe('内容准备中');
  });

  it('物理题型含计算，化学/道法不含', () => {
    const values = (id: number) => (getTrainingSubject(id)?.typeOptions ?? []).map((o) => o.value);
    expect(values(SUBJECT_PHYSICS)).toContain('calculation');
    expect(values(SUBJECT_CHEMISTRY)).not.toContain('calculation');
    expect(values(SUBJECT_POLITICS)).not.toContain('calculation');
  });
});

describe('学科辅助函数', () => {
  it('parseSubjectId 识别 4/5/9，未知回落数学', () => {
    expect(parseSubjectId('4')).toBe(4);
    expect(parseSubjectId('5')).toBe(5);
    expect(parseSubjectId('9')).toBe(9);
    expect(parseSubjectId('6')).toBe(SUBJECT_MATH);
    expect(parseSubjectId(null)).toBe(SUBJECT_MATH);
  });

  it('subjectName', () => {
    expect(subjectName(SUBJECT_PHYSICS)).toBe('物理');
    expect(subjectName(SUBJECT_CHEMISTRY)).toBe('化学');
    expect(subjectName(SUBJECT_POLITICS)).toBe('道德与法治');
    expect(subjectName(SUBJECT_MATH)).toBe('数学');
  });

  it('subjectHomePath：数学不带参，物理带 subjectId，语文/英语走专项页', () => {
    expect(subjectHomePath(SUBJECT_MATH)).toBe('/student/training/home');
    expect(subjectHomePath(SUBJECT_CHINESE)).toBe('/student/training/chinese/special');
    expect(subjectHomePath(SUBJECT_ENGLISH)).toBe('/student/training/english/vocabulary');
    expect(subjectHomePath(SUBJECT_PHYSICS)).toBe('/student/training/home?subjectId=4');
  });

  it('isMathLikeSubject：1/4/5 true，2/3/9 false', () => {
    expect([1, 2, 3, 4, 5, 9].map(isMathLikeSubject)).toEqual([true, false, false, true, true, false]);
  });
});

describe('selfAssessEligible（闸门③）', () => {
  it('数学只放 short_answer/proof（与今天一致）', () => {
    expect(selfAssessEligible(SUBJECT_MATH, 'short_answer')).toBe(true);
    expect(selfAssessEligible(SUBJECT_MATH, 'fill_blank')).toBe(false);
    expect(selfAssessEligible(SUBJECT_MATH, 'calculation')).toBe(false);
  });

  it('非数学学科非客观题全部走自评（含语文填空）', () => {
    expect(selfAssessEligible(SUBJECT_CHINESE, 'fill_blank')).toBe(true);
    expect(selfAssessEligible(SUBJECT_CHEMISTRY, 'fill_blank')).toBe(true);
    expect(selfAssessEligible(SUBJECT_PHYSICS, 'calculation')).toBe(true);
    expect(selfAssessEligible(SUBJECT_POLITICS, 'short_answer')).toBe(true);
  });

  it('客观题任何学科都不自评', () => {
    for (const id of [1, 2, 3, 4, 5, 9]) {
      expect(selfAssessEligible(id, 'choice')).toBe(false);
      expect(selfAssessEligible(id, 'true_false')).toBe(false);
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/subjectConfig.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 写实现**

```ts
// apps/web/src/subjectConfig.ts
/**
 * 训练轨学科配置的唯一真源（spec 2026-10-31 §3.1）。
 *
 * 为什么集中：训练轨原本只有「语文 / 其它=数学」两套三元分支（parseSubjectId、
 * subjectName、subjectHomePath、题型下拉、任务码），加第三个学科时每处都要再改一遍，
 * 漏一处就把物理静默当成数学。新增学科 = 在 TRAINING_SUBJECTS 加一项。
 *
 * 注意：本文件**不 import `@/constants`**（`constants` 反过来转出这里），避免循环依赖。
 */

export const SUBJECT_MATH = 1;
export const SUBJECT_CHINESE = 2;
export const SUBJECT_ENGLISH = 3;
export const SUBJECT_PHYSICS = 4;
export const SUBJECT_CHEMISTRY = 5;
export const SUBJECT_POLITICS = 9;

export type SubjectId =
  | typeof SUBJECT_MATH
  | typeof SUBJECT_CHINESE
  | typeof SUBJECT_ENGLISH
  | typeof SUBJECT_PHYSICS
  | typeof SUBJECT_CHEMISTRY
  | typeof SUBJECT_POLITICS;

export interface SubjectTypeOption {
  value: string;
  label: string;
}

export interface TrainingSubjectConfig {
  id: SubjectId;
  name: string;
  desc: string;
  /** 选科页是否可点；false 渲染灰卡 + badge。 */
  enabled: boolean;
  badge?: string;
  /** 该学科在训练轨的落地页（含 query）。 */
  homePath: string;
  /** 专项配置页的题型下拉；空串 = 全部。 */
  typeOptions: readonly SubjectTypeOption[];
  /** 专项练习任务码（档位/发分用）；英语无专项练习。 */
  targetedTaskCode?: string;
  /** 理科：作答区用 LaTeX 输入 + 预览。 */
  isMathLike: boolean;
}

const ALL: SubjectTypeOption = { value: '', label: '全部' };

export const MATH_TYPE_OPTIONS: readonly SubjectTypeOption[] = [
  ALL,
  { value: 'choice', label: '选择' },
  { value: 'fill_blank', label: '填空' },
  { value: 'true_false', label: '判断' },
  { value: 'short_answer', label: '解答' },
  { value: 'proof', label: '证明' },
  { value: 'calculation', label: '计算' },
];

const CN_TYPE_OPTIONS: readonly SubjectTypeOption[] = [
  ALL,
  { value: 'choice', label: '选择' },
  { value: 'fill_blank', label: '填空' },
  { value: 'short_answer', label: '简答' },
];

const PHYSICS_TYPE_OPTIONS: readonly SubjectTypeOption[] = [
  ALL,
  { value: 'choice', label: '选择' },
  { value: 'fill_blank', label: '填空' },
  { value: 'short_answer', label: '简答' },
  { value: 'calculation', label: '计算' },
];

const HUMANITIES_TYPE_OPTIONS: readonly SubjectTypeOption[] = [
  ALL,
  { value: 'choice', label: '选择' },
  { value: 'fill_blank', label: '填空' },
  { value: 'short_answer', label: '简答' },
];

export const TRAINING_SUBJECTS: readonly TrainingSubjectConfig[] = [
  {
    id: SUBJECT_MATH, name: '数学', desc: '考试 / 专项练习 / 错题练习',
    enabled: true, homePath: '/student/training/home',
    typeOptions: MATH_TYPE_OPTIONS, targetedTaskCode: 'math_targeted', isMathLike: true,
  },
  {
    id: SUBJECT_CHINESE, name: '语文', desc: '真题考试 / 专项练习 / 古诗文专项',
    enabled: true, homePath: '/student/training/chinese/special',
    typeOptions: CN_TYPE_OPTIONS, targetedTaskCode: 'cn_targeted', isMathLike: false,
  },
  {
    id: SUBJECT_ENGLISH, name: '英语', desc: '背单词',
    enabled: true, homePath: '/student/training/english/vocabulary',
    typeOptions: [], isMathLike: false,
  },
  {
    id: SUBJECT_PHYSICS, name: '物理', desc: '考试 / 专项练习 / 错题练习',
    enabled: true, homePath: '/student/training/home?subjectId=4',
    typeOptions: PHYSICS_TYPE_OPTIONS, targetedTaskCode: 'physics_targeted', isMathLike: true,
  },
  {
    id: SUBJECT_CHEMISTRY, name: '化学', desc: '考试 / 专项练习 / 错题练习',
    enabled: true, homePath: '/student/training/home?subjectId=5',
    typeOptions: HUMANITIES_TYPE_OPTIONS, targetedTaskCode: 'chemistry_targeted', isMathLike: true,
  },
  {
    id: SUBJECT_POLITICS, name: '道德与法治', desc: '考试 / 专项练习 / 错题练习',
    enabled: false, badge: '内容准备中', homePath: '/student/training/home?subjectId=9',
    typeOptions: HUMANITIES_TYPE_OPTIONS, targetedTaskCode: 'politics_targeted', isMathLike: false,
  },
];

const BY_ID = new Map<number, TrainingSubjectConfig>(TRAINING_SUBJECTS.map((s) => [s.id, s]));

export function getTrainingSubject(subjectId: number): TrainingSubjectConfig | undefined {
  return BY_ID.get(Number(subjectId));
}

export function subjectName(subjectId: number): string {
  return getTrainingSubject(subjectId)?.name ?? '数学';
}

export function subjectHomePath(subjectId: number): string {
  return getTrainingSubject(subjectId)?.homePath ?? '/student/training/home';
}

const ALLOWED_SUBJECT_IDS = new Set<number>([1, 2, 3, 4, 5, 9]);

/** URL 查询参数解析学科 id；缺省/未知一律数学（兼容既有不带参的数学链接）。 */
export function parseSubjectId(raw: string | null): number {
  const n = Number(raw);
  return ALLOWED_SUBJECT_IDS.has(n) ? n : SUBJECT_MATH;
}

export function isMathLikeSubject(subjectId: number): boolean {
  return getTrainingSubject(subjectId)?.isMathLike ?? false;
}

const OBJECTIVE_TYPES = new Set(['choice', 'true_false']);

/**
 * 闸门③：前端是否要「同步等判题 + 弹自评视图」。
 *
 * 不在名单里的题型，即使服务端返回 `needsSelfAssessment: true` 也会被记成
 * `isCorrect: false`（QuestionRunner 的 fire-and-forget 分支），学生看到「错」且没有
 * 自评入口。数学保持原样（fill_blank 仍 fire-and-forget），其余学科所有非客观题都等。
 */
export function selfAssessEligible(subjectId: number, type: string): boolean {
  if (OBJECTIVE_TYPES.has(type)) return false;
  if (Number(subjectId) === SUBJECT_MATH) return type === 'short_answer' || type === 'proof';
  return true;
}
```

`constants.ts` 整体替换为：

```ts
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
```

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `cd apps/web && npx vitest run src/subjectConfig.test.ts && npx tsc -b --noEmit`
Expected: 测试全绿；tsc 无新增错误。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/subjectConfig.ts apps/web/src/subjectConfig.test.ts apps/web/src/constants.ts
git commit -m "feat(web): 学科配置表集中化，parseSubjectId 识别物理/化学/道法"
```

---

### Task 8: 选科页六卡

**Files:**
- Modify: `apps/web/src/pages/student/TrainingSubjectPage.tsx`
- Test: `apps/web/src/pages/student/TrainingSubjectPage.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 7 的 `TRAINING_SUBJECTS`、`TrainingSubjectConfig`

- [ ] **Step 1: 写失败测试**

```tsx
// apps/web/src/pages/student/TrainingSubjectPage.test.tsx
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import TrainingSubjectPage from './TrainingSubjectPage';

afterEach(() => cleanup());

function renderPage() {
  const router = createMemoryRouter(
    [
      { path: '/student/training', element: <TrainingSubjectPage /> },
      { path: '/student/training/home', element: <div>四卡页</div> },
      { path: '/student/training/chinese/special', element: <div>语文专项页</div> },
      { path: '/student/training/english/vocabulary', element: <div>背单词页</div> },
    ],
    { initialEntries: ['/student/training'] },
  );
  return { router, ...render(<RouterProvider router={router} />) };
}

describe('TrainingSubjectPage', () => {
  it('渲染六个学科', () => {
    renderPage();
    for (const name of ['数学', '语文', '英语', '物理', '化学', '道德与法治']) {
      expect(screen.getByText(name)).toBeTruthy();
    }
  });

  it('道法卡禁用且显示「内容准备中」', () => {
    renderPage();
    expect(screen.getByLabelText('道德与法治训练暂未开放')).toBeTruthy();
    expect(screen.getByText('内容准备中')).toBeTruthy();
  });

  it('点物理进入四卡页并带 subjectId=4', async () => {
    const { router } = renderPage();
    fireEvent.click(screen.getByLabelText('选择物理训练'));
    expect(router.state.location.pathname).toBe('/student/training/home');
    expect(router.state.location.search).toBe('?subjectId=4');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/student/TrainingSubjectPage.test.tsx`
Expected: FAIL，找不到「物理」。

- [ ] **Step 3: 改实现**

删除文件内 `SUBJECTS` 常量与 `interface TrainingSubject`，改为：

```tsx
import { useNavigate } from 'react-router-dom';
import { BackButton } from '@/components/base';
import { TRAINING_SUBJECTS, type TrainingSubjectConfig } from '@/subjectConfig';

// ...DumbbellIcon 不变...

export default function TrainingSubjectPage() {
  const navigate = useNavigate();

  const handleSelect = (subject: TrainingSubjectConfig) => {
    if (!subject.enabled) return;
    navigate(subject.homePath);
  };
```

渲染部分：`{TRAINING_SUBJECTS.map((subject) => subject.enabled ? (...) : (...))}`；禁用卡的角标文案改为 `{subject.badge ?? '敬请期待'}`，其余样式不动；可点卡的 `aria-label` 保持 `` `选择${subject.name}训练` ``，禁用卡保持 `` `${subject.name}训练暂未开放` ``。

- [ ] **Step 4: 跑测试**

Run: `cd apps/web && npx vitest run src/pages/student/TrainingSubjectPage.test.tsx`
Expected: PASS（3 个用例）。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/pages/student/TrainingSubjectPage.tsx apps/web/src/pages/student/TrainingSubjectPage.test.tsx
git commit -m "feat(web): 训练选科页新增物理/化学/道法三卡"
```

---

### Task 9: 训练首页按学科参数化

**Files:**
- Modify: `apps/web/src/pages/student/training/TrainingHomePage.tsx:7,93-119,141-146,176-299`
- Test: `apps/web/src/pages/student/training/TrainingHomePage.test.tsx`

**Interfaces:**
- Consumes: Task 7 的 `parseSubjectId`、`subjectName`、`SUBJECT_MATH`
- Produces: 四卡链接契约 `/student/training/{targeted|exam|errors|weak-points}?subjectId=<id>`

- [ ] **Step 1: 写失败测试**

在 `TrainingHomePage.test.tsx` 追加（沿用文件已有的 mock 与 `renderPage` 结构，**新增一个可传 entry 的渲染函数**）：

```tsx
function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      { path: '/student/training/home', element: <TrainingHomePage /> },
      { path: '/student/training/targeted', element: <div>专项页桩</div> },
      { path: '/student/training/exam', element: <div>考试页桩</div> },
      { path: '/student/training/errors', element: <div>错题页桩</div> },
      { path: '/student/training/weak-points', element: <div>图谱页桩</div> },
      { path: '/student/training/remediation/run', element: <div>作答页桩</div> },
    ],
    { initialEntries: [path] },
  );
  return { router, ...render(<RouterProvider router={router} />) };
}

describe('TrainingHomePage 学科参数化', () => {
  it('?subjectId=4：标题、错题学科、四卡链接都带物理', async () => {
    getRemediationOverview.mockResolvedValue(overview());
    const { router } = renderAt('/student/training/home?subjectId=4');

    expect(await screen.findByText('物理 · 训练')).toBeTruthy();
    await waitFor(() => expect(getTrainingErrorBook).toHaveBeenCalledWith({ subjectId: 4 }));
    // 新学科不发相似题请求、不渲染提示条
    expect(getRemediationOverview).not.toHaveBeenCalled();
    expect(screen.queryByText(/相似题专项练习待完成/)).toBeNull();

    fireEvent.click(screen.getByLabelText(/进入专项练习/));
    expect(router.state.location.pathname).toBe('/student/training/targeted');
    expect(router.state.location.search).toBe('?subjectId=4');
  });

  it('不带参：仍是数学标题且请求相似题（旧行为）', async () => {
    getRemediationOverview.mockResolvedValue(overview());
    renderAt('/student/training/home');
    expect(await screen.findByText('数学 · 训练')).toBeTruthy();
    await waitFor(() => expect(getRemediationOverview).toHaveBeenCalled());
    expect(getTrainingErrorBook).toHaveBeenCalledWith({ subjectId: 1 });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/student/training/TrainingHomePage.test.tsx`
Expected: FAIL，标题仍是「数学 · 训练」、`getRemediationOverview` 被调用。

- [ ] **Step 3: 改实现**

```tsx
import { useNavigate, useSearchParams } from 'react-router-dom';
import { parseSubjectId, subjectName, SUBJECT_MATH } from '@/constants';

export default function TrainingHomePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const subjectId = parseSubjectId(searchParams.get('subjectId'));
  const isMath = subjectId === SUBJECT_MATH;
  // 数学保持原 URL（不带参），新学科带 subjectId —— 数学的既有链接/测试逐字不变
  const subjectQuery = isMath ? '' : `?subjectId=${subjectId}`;
  // ...
```

- 相似题 effect：`if (!isMath) return;` 放在 `useEffect` 内第一行（依赖数组加 `isMath`）。
- 错题 effect：`getTrainingErrorBook({ subjectId })`（依赖 `[subjectId]`）。
- 提示条渲染条件加 `isMath &&`。
- `PageHeader` 的 `title={`${subjectName(subjectId)} · 训练`}`。
- 四卡 `onClick`：`navigate(\`/student/training/targeted${subjectQuery}\`)`，其余三卡同理。
- 删除 `const MATH_SUBJECT_ID = 1;`。

- [ ] **Step 4: 跑测试**

Run: `cd apps/web && npx vitest run src/pages/student/training/TrainingHomePage.test.tsx`
Expected: 全绿（含既有提示条用例）。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/pages/student/training/TrainingHomePage.tsx apps/web/src/pages/student/training/TrainingHomePage.test.tsx
git commit -m "feat(web): 训练首页按 subjectId 参数化"
```

---

### Task 10: QuestionRunner 自评闸门

**Files:**
- Modify: `apps/web/src/components/business/answer/QuestionRunner.tsx:24,241`
- Test: `apps/web/src/components/business/answer/QuestionRunner.test.tsx`

**Interfaces:**
- Consumes: Task 7 的 `selfAssessEligible`

- [ ] **Step 1: 写失败测试**

追加到 `describe('主观题自评（self_assess 模式）')` 之后：

```tsx
const SA_FILL_QUESTIONS: RunnerQuestion[] = [
  { n: '1', text: '化学填空题干', type: 'fill_blank' },
];

describe('内联自评闸门按学科开放（闸门③）', () => {
  it('化学填空返回 needsSelfAssessment 时进入自评视图', async () => {
    const user = userEvent.setup();
    const onSelfAssess = vi.fn(async () => {});
    render(
      <QuestionRunner
        questions={SA_FILL_QUESTIONS}
        subjectId={5}
        draftKeyPrefix="chem"
        variant="embedded"
        draftDisabled
        onSubmit={async (): Promise<RunnerJudgeOutcome> => ({
          isCorrect: null, method: 'self_assess', needsSelfAssessment: true, referenceAnswer: 'CO2',
        })}
        onSelfAssess={onSelfAssess}
        onFinish={() => {}}
      />,
    );
    await user.type(screen.getByRole('textbox'), 'CO2');
    await user.click(screen.getByTitle('提交'));
    expect(await screen.findByText('CO2')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '我做对了' }));
    expect(onSelfAssess).toHaveBeenCalledTimes(1);
  });

  it('数学填空保持 fire-and-forget：不弹自评、直接记结果', async () => {
    const user = userEvent.setup();
    const onFinish = vi.fn();
    render(
      <QuestionRunner
        questions={[{ n: '1', text: '数学填空题干', type: 'fill_blank' }]}
        subjectId={1}
        draftKeyPrefix="math"
        variant="embedded"
        draftDisabled
        onSubmit={async (): Promise<RunnerJudgeOutcome> => ({ isCorrect: true, method: 'exact' })}
        onFinish={onFinish}
      />,
    );
    await user.type(screen.getByRole('textbox'), '2/3');
    await user.click(screen.getByTitle('提交'));
    await waitFor(() => expect(onFinish).toHaveBeenCalled());
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/components/business/answer/QuestionRunner.test.tsx`
Expected: 化学填空用例 FAIL（进入 fire-and-forget，`onSelfAssess` 未被调用、页面无 `CO2`）。

- [ ] **Step 3: 改实现**

```tsx
import { isMathLikeSubject, selfAssessEligible } from '@/constants';
// ...
    // 主观题/新学科非客观题：同步等判题返回——needsSelfAssessment 时进入自评视图。
    // 名单由 subjectConfig.selfAssessEligible 统一口径（数学与历史行为逐字一致）。
    const inlineSelfAssess = showResultFeedback && selfAssessEligible(subjectId, question.type);
```

- [ ] **Step 4: 跑测试**

Run: `cd apps/web && npx vitest run src/components/business/answer/QuestionRunner.test.tsx`
Expected: 全绿（含既有回填/自评用例）。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/business/answer/QuestionRunner.tsx apps/web/src/components/business/answer/QuestionRunner.test.tsx
git commit -m "fix(web): 自评闸门按学科放开，化学填空/物理计算不再被记成答错"
```

---

### Task 11: 专项配置页与图谱页按学科

**Files:**
- Modify: `apps/web/src/pages/student/training/TargetedConfigPage.tsx:9-36,160-162,180,260`
- Modify: `apps/web/src/pages/student/training/WeakPointGraphPage.tsx:14-18,58-64,66-90,140-150`
- Test: `apps/web/src/pages/student/training/TargetedConfigPage.test.tsx`、`WeakPointGraphPage.test.tsx`

**Interfaces:**
- Consumes: Task 7 的 `getTrainingSubject`、`MATH_TYPE_OPTIONS`、`subjectName`、`parseSubjectId`

- [ ] **Step 1: 写失败测试**

`TargetedConfigPage.test.tsx` 追加：

```tsx
describe('按学科取题型与任务码', () => {
  it('物理：题型下拉含「计算」，档位请求 physics_targeted', async () => {
    getKpsMock.mockResolvedValue(KPS);
    getRulesMock.mockResolvedValue({ tasks: [{ taskCode: 'physics_targeted', taskName: '物理专项', tiers: MATH_TIERS }] });
    renderPage('/student/training/targeted?subjectId=4');

    await waitFor(() => expect(getRulesMock).toHaveBeenCalledWith('physics_targeted'));
    expect(screen.getByRole('option', { name: '计算' })).toBeTruthy();
    expect(await screen.findByText('物理 · 专项')).toBeTruthy();
  });

  it('化学：题型下拉不含「计算」，档位请求 chemistry_targeted', async () => {
    getKpsMock.mockResolvedValue(KPS);
    getRulesMock.mockResolvedValue({ tasks: [{ taskCode: 'chemistry_targeted', taskName: '化学专项', tiers: MATH_TIERS }] });
    renderPage('/student/training/targeted?subjectId=5');

    await waitFor(() => expect(getRulesMock).toHaveBeenCalledWith('chemistry_targeted'));
    expect(screen.queryByRole('option', { name: '计算' })).toBeNull();
  });

  it('数学：标题与任务码保持不变（回归钉子）', async () => {
    getKpsMock.mockResolvedValue(KPS);
    getRulesMock.mockResolvedValue({ tasks: [{ taskCode: 'math_targeted', taskName: '数学专项', tiers: MATH_TIERS }] });
    renderPage('/student/training/targeted');

    await waitFor(() => expect(getRulesMock).toHaveBeenCalledWith('math_targeted'));
    expect(await screen.findByText('专项练习')).toBeTruthy();
  });
});
```

> 若现有测试文件没有 `renderPage(path)` 辅助函数，按其现有渲染方式加一个接受 `initialEntries` 的版本（参考 Task 9 的 `renderAt`）。

`WeakPointGraphPage.test.tsx` 追加：

```tsx
it('?subjectId=4 时按物理请求图谱与档位', async () => {
  getKnowledgeGraphMastery.mockResolvedValue(mastery());
  getWeakPoints.mockResolvedValue({ weakPoints: [] });
  getMyPointRules.mockResolvedValue({
    tasks: [{ taskCode: 'physics_targeted', taskName: '物理专项', tiers: [{ tierKey: '3' }] }],
  });

  renderPage('/student/training/weak-points?subjectId=4');

  await waitFor(() => expect(getKnowledgeGraphMastery).toHaveBeenCalledWith(7, 4));
  expect(getMyPointRules).toHaveBeenCalled();
});
```

> 若现测试的 `renderPage` 不带参数，按 Task 9 的方式加 `initialEntries` 形参。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/student/training/TargetedConfigPage.test.tsx src/pages/student/training/WeakPointGraphPage.test.tsx`
Expected: FAIL（物理页没有「计算」选项、档位请求是 math_targeted）。

- [ ] **Step 3: 改实现**

`TargetedConfigPage.tsx`：

```tsx
import { getTrainingSubject, MATH_TYPE_OPTIONS, parseSubjectId, subjectHomePath, subjectName, SUBJECT_MATH } from '@/constants';
// 删除本地 MATH_TYPE_OPTIONS / CN_TYPE_OPTIONS / CN_TASK_CODE
// ...
  const subjectId = parseSubjectId(searchParams.get('subjectId'));
  const subject = getTrainingSubject(subjectId);
  const typeOptions = subject?.typeOptions ?? MATH_TYPE_OPTIONS;
  const subjectQuery = `?subjectId=${subjectId}`;
  // ...
  } = usePointTiers(subject?.targetedTaskCode ?? MATH_TASK_CODE);
  // ...
          <PageHeader
            to={subjectHomePath(subjectId)}
            caption="返回训练"
            title={subjectId === SUBJECT_MATH ? '专项练习' : `${subjectName(subjectId)} · 专项`}
          />
```

删除 `isChinese` 变量（如无其它用途，`grep -n "isChinese" 该文件` 应为 0）。

`WeakPointGraphPage.tsx`：

```tsx
import { useNavigate, useSearchParams } from 'react-router-dom';
import { getTrainingSubject, parseSubjectId } from '@/constants';
// 删除 MATH_SUBJECT_ID
// ...
  const [searchParams] = useSearchParams();
  const subjectId = parseSubjectId(searchParams.get('subjectId'));
  const taskCode = getTrainingSubject(subjectId)?.targetedTaskCode ?? MATH_TASK_CODE;
  const { tiers, error: tierError, retry: retryTiers } = usePointTiers(taskCode);
```

`getKnowledgeGraphMastery(studentId, subjectId)`、`getWeakPoints({ studentId, subjectId, ... })`、`startTargetedPractice({ subjectId, ... })` 三处替换为变量；`loadMastery` / `loadRec` 的 `useCallback` 依赖加 `subjectId`。

- [ ] **Step 4: 跑测试**

Run: `cd apps/web && npx vitest run src/pages/student/training/`
Expected: 全绿（含既有 5 个训练页测试文件）。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/pages/student/training/TargetedConfigPage.tsx apps/web/src/pages/student/training/WeakPointGraphPage.tsx apps/web/src/pages/student/training/TargetedConfigPage.test.tsx apps/web/src/pages/student/training/WeakPointGraphPage.test.tsx
git commit -m "feat(web): 专项配置页与薄弱点图谱按学科取题型/任务码"
```

---

### Task 12: 文档同步与全量回归

**Files:**
- Modify: `docs/API接口与数据流设计文档.md`
- Modify: `docs/api/openapi.yaml`
- Modify: `docs/K12智学系统-产品需求文档.md`
- Modify: `docs/UX-UI设计文档.md`
- Modify: `docs/constraints/专项子系统.md`
- Modify: `docs/ai-core-changelog.md`（追加本次工作日志，日期 2026-10-31）

**Interfaces:**
- Consumes: 前 11 个任务的全部行为

- [ ] **Step 1: 改文档**

1. `docs/API接口与数据流设计文档.md`
   - 弱科图谱端点（`/knowledge-graph/.../weak-points`、`/mastery`）：`subjectId` 允许值改为 `1 / 4 / 5 / 9`，**删掉**「仅支持 1（数学）」的旧表述。
   - 考试交卷段落（约 :1428）：补「无参考答案的题未作答：记 0 分但不写错题本」；自评学科由「语文」改为「语文、物理、化学、道法」。
   - 积分段落（约 :1707、:1769）：补 6 个新任务码；**删掉**「其余学科暂沿用数学码」的旧表述。
2. `docs/api/openapi.yaml`：`weak-points` / `mastery` 的 `subjectId` 参数 `description` 同步允许值。
3. PRD §7.13 积分表：追加 `physics_paper / chemistry_paper / politics_paper / physics_targeted / chemistry_targeted / politics_targeted` 六行，分值/上限照 Task 4。
4. `docs/UX-UI设计文档.md`：训练选科页六卡（道法灰卡「内容准备中」）；专项配置页题型「按学科裁剪」（物理含计算）。
5. `docs/constraints/专项子系统.md`：追加一段「题库类训练（专项/考试/错题/图谱）按 `subjectId` 参数化；学科差异集中在 `apps/server/src/common/subject-config.ts` 与 `apps/web/src/subjectConfig.ts`，**新增学科不要在各页写 `if subject ===`**」。
6. `docs/ai-core-changelog.md`：追加 2026-10-31 条目（做了什么、三道闸门为何分开、物理数据缺口）。

- [ ] **Step 2: 检查双文档端点一致性**

Run:
```bash
grep -n "weak-points" docs/api/openapi.yaml docs/API接口与数据流设计文档.md | head
grep -n "physics_paper\|chemistry_targeted" docs/api/openapi.yaml docs/API接口与数据流设计文档.md docs/K12智学系统-产品需求文档.md
```
Expected: 两份 API 文档的允许学科与任务码描述一致；PRD 有 6 个新任务码。

- [ ] **Step 3: 全量测试**

Run:
```bash
cd apps/server && npm test
cd ../web && npm test
cd ../server && npm run build
cd ../web && npm run build
```
Expected: 全绿；两个 build 通过。

- [ ] **Step 4: 手工冒烟（本机 `node dist/main.js` + `npm run dev`）**

1. 训练 → 物理：四卡可进；专项页题型含「计算」，选知识点后档位显示「1/3/5/10 题」；开练答题，填空/计算不等时弹自评。
2. 训练 → 化学：考试 2 套卷任选一套，填空答对（如 `CO2`）应直接判对；简答交卷后结果页可自评；发分流水显示「化学卷子一套」。
3. 物理 51 号卷交卷：错题本**不新增**条目。
4. 训练 → 道法：灰卡「内容准备中」不可点；手输 `/student/training/home?subjectId=9` 四卡均空态、不报错。
5. 回归：数学专项标题仍「专项练习」、任务码 `math_targeted`；语文填空仍弹自评；英语背单词不受影响。
6. 家长端：完成一次物理专项后，仪表盘出现「物理」；积分页出现「物理专项」分组。

- [ ] **Step 5: 提交**

```bash
git add docs
git commit -m "docs: 训练轨新增三学科的 API/PRD/UX/约束同步"
```

---

## Self-Review

**Spec 覆盖核对：**

| spec 条目 | 对应任务 |
|---|---|
| §3.1 前端配置表 | Task 7 |
| §3.1 后端配置表 | Task 1 |
| §3.2 选科页六卡 / 道法灰卡 | Task 8 |
| §3.3 训练首页参数化 | Task 9 |
| §3.4 四入口行为 | Task 5（任务码）、Task 6（图谱）、Task 9（链接） |
| §3.5 闸门①②③ | Task 2（②）、Task 3（①）、Task 10（③） |
| §3.5 交卷无答案题 | Task 3 |
| §3.6 图谱门禁 | Task 6 |
| §3.7 积分 | Task 4、Task 5 |
| §3.8 埋点 | 无需改动（spec 已说明） |
| §3.9 错误处理 | Task 3、Task 9（失败不阻塞）、Task 11（空态沿用） |
| §4 文档同步 | Task 12 |
| §5 测试 | 各任务内 + Task 12 全量 |
| §7 数据项 | 明确不做，仅记录在 changelog |

**类型/命名一致性：** `selfAssessSkipsJudging`（后端闸门①）、`isSelfAssessNonObjective`（后端闸门②）、`selfAssessEligible`（前端闸门③）三名分开，Task 2/3/10 引用一致；`targetedTaskCode` / `paperTaskCode` 在 Task 1 定义、Task 5 使用；`hasAnswer` 在 Task 3 一处定义一处使用。

**风险提醒（实现时注意）：**
- Task 3 的 `hasAnswer` 是 `number`（MySQL 0/1），判断用 `=== 0`；测试 fixture 缺字段时保持旧行为。
- Task 9 的相似题 effect 必须**同时**在依赖数组加 `isMath`，否则切学科不重新求值（页面本身不会切，但守卫更稳）。
- Task 11 若现有测试没有可传 entry 的渲染函数，先加参数再写新用例，不要复制第二套渲染逻辑。
