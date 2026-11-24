# 英语训练轨四模块 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让英语学生在训练轨走通「真题考试 / 专项练习（含背单词）/ 错题练习 / 薄弱点图谱」四条路径，复用现有题库体系，并处理英语卷无参考答案的题与图谱冷启动。

**Architecture:** 四个模块本就是学科参数化通用能力，不新建页面/表/端点。改动分四类：① 前后端学科配置真源补英语；② 考试结果新增 `no_standard_answer` 终态；③ 知识点种子 + 材料感知回填；④ 页面学科差异配置化，杜绝散落的 `subjectId === X`。

**Tech Stack:** React 18 + Vite + TS + Tailwind（web）；NestJS + TypeScript + mysql2（server）；Python + pymysql（data-refinery）；MySQL 8（schema: `tools/db/schema.sql`）。

## Global Constraints

- 起后端只能 `node dist/main.js`，禁止 `npx tsx src/main.ts`（DI 坏）。
- 新增/改 DDL 收尾跑 `python3 tools/db/schema_reconcile.py`；`updated_at` 用列级 `ON UPDATE CURRENT_TIMESTAMP(3)`。
- 分页 `LIMIT ?` 必须走 `pool.query`，不能 `pool.execute`（全仓护栏测试）。
- 埋点写入不得阻断主链路，失败只 warn。
- `input_tokens`/`output_tokens` 为 NULL 表示量不到，绝不写 0。
- 不用 WebSocket；AI 流式一律 SSE。
- 页面只显示对用户有实际作用的信息；UI 不用 emoji、不用装饰元素。
- 主题/学段/布局按 `CLAUDE.md`，训练轨页面全屏写死 `data-theme="student-day"`。
- API 文档 `docs/API接口与数据流设计文档.md` 与 `docs/api/openapi.yaml` 必须同步；无新端点但结果 schema 与图谱学科 enum 变了，必须改文档。
- 交付给用户的收尾流程只能有**一条**命令：`bash tools/english-training/setup.sh`。
- 测试断言与 config/设计文档冲突时改测试；组件改动必须补渲染测试；多用例文件自己写 `afterEach(() => cleanup())`。
- 构建会覆盖用户 dev server 的 `dist`，收尾必须主动披露。
- 用户其它未提交的 data-refinery 改动不属于本计划，**不要提交、不要覆盖**。

---

### Task 1: 后端学科配置补英语 + 英语显式自评 + module 映射函数

**Files:**
- Modify: `apps/server/src/common/subject-config.ts:15-21,23-29,31-34,49-58,60-64`
- Modify: `apps/server/src/modules/practice/judge-core.service.ts:12,160-169`
- Test: `apps/server/src/common/subject-config.test.ts`
- Test: `apps/server/src/modules/practice/judge-core.service.test.ts`（若存在，否则新建 `english-self-assess.test.ts`）

**Interfaces:**
- Consumes: 现有 `SUBJECT_ENGLISH=3`、`isSelfAssessSubject()`、`selfAssessSkipsJudging()`。
- Produces: `targetedTaskCode(3)='en_targeted'`、`paperTaskCode(3)='en_paper'`、`targetedSessionModule(3)='en_targeted'`、`isExplicitSelfAssessType(3,'short_answer'|'proof')=true`；英语 `fill_blank` **不**自评。

- [ ] **Step 1: 写失败测试**

在 `subject-config.test.ts` 加：

```ts
import {
  SUBJECT_ENGLISH, targetedTaskCode, paperTaskCode,
  targetedSessionModule, selfAssessSkipsJudging, isExplicitSelfAssessType,
} from '../subject-config.js';

describe('英语学科配置', () => {
  it('任务码不再回落数学', () => {
    expect(targetedTaskCode(SUBJECT_ENGLISH)).toBe('en_targeted');
    expect(paperTaskCode(SUBJECT_ENGLISH)).toBe('en_paper');
  });
  it('专项会话 module 六学科穷举', () => {
    expect(targetedSessionModule(1)).toBe('math_targeted');
    expect(targetedSessionModule(2)).toBe('cn_targeted');
    expect(targetedSessionModule(3)).toBe('en_targeted');
    expect(targetedSessionModule(4)).toBe('physics_targeted');
    expect(targetedSessionModule(5)).toBe('chemistry_targeted');
    expect(targetedSessionModule(9)).toBe('politics_targeted');
  });
  it('英语非客观题显式自评，但不吞 fill_blank', () => {
    expect(isExplicitSelfAssessType(3, 'short_answer')).toBe(true);
    expect(isExplicitSelfAssessType(3, 'proof')).toBe(true);
    expect(isExplicitSelfAssessType(3, 'fill_blank')).toBe(false);
    expect(selfAssessSkipsJudging(3, 'short_answer')).toBe(true);
    expect(selfAssessSkipsJudging(3, 'choice')).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/common/subject-config.test.ts`
Expected: FAIL — `targetedSessionModule` / `isExplicitSelfAssessType` is not exported。

- [ ] **Step 3: 实现**

`apps/server/src/common/subject-config.ts` 改动：

```ts
const TARGETED_TASK_CODE: Readonly<Record<number, string>> = {
  [SUBJECT_MATH]: 'math_targeted',
  [SUBJECT_CHINESE]: 'cn_targeted',
  [SUBJECT_ENGLISH]: 'en_targeted',          // 新增
  [SUBJECT_PHYSICS]: 'physics_targeted',
  [SUBJECT_CHEMISTRY]: 'chemistry_targeted',
  [SUBJECT_POLITICS]: 'politics_targeted',
};

const PAPER_TASK_CODE: Readonly<Record<number, string>> = {
  [SUBJECT_MATH]: 'math_paper',
  [SUBJECT_CHINESE]: 'cn_paper',
  [SUBJECT_ENGLISH]: 'en_paper',             // 新增
  [SUBJECT_PHYSICS]: 'physics_paper',
  [SUBJECT_CHEMISTRY]: 'chemistry_paper',
  [SUBJECT_POLITICS]: 'politics_paper',
};

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

/** 英语显式自评类型：只放 short_answer/proof，不含 fill_blank（将来出现要先归一化比对）。 */
const ENGLISH_SELF_ASSESS_TYPES = new Set(['short_answer', 'proof']);
export function isExplicitSelfAssessType(subjectId: number, type: string): boolean {
  return Number(subjectId) === SUBJECT_ENGLISH && ENGLISH_SELF_ASSESS_TYPES.has(type);
}

export function selfAssessSkipsJudging(subjectId: number, type: string): boolean {
  const id = Number(subjectId);
  if (id === SUBJECT_CHINESE) return !OBJECTIVE_TYPES.has(type);
  if (isExplicitSelfAssessType(id, type)) return true;   // 新增，先于 isSelfAssessSubject
  if (isSelfAssessSubject(id)) return NEW_SUBJECT_SKIP_JUDGE_TYPES.has(type);
  return false;
}
```

`apps/server/src/modules/practice/judge-core.service.ts`：

```ts
// import 行加上 isExplicitSelfAssessType
import { isSelfAssessSubject, isExplicitSelfAssessType, prefersExactBeforeSelfAssess, subjectCodeOf } from '../../common/subject-config.js';

function isSelfAssessNonObjective(q: { subject_id?: number | null; type: string }): boolean {
  const sid = Number(q.subject_id);
  return isExplicitSelfAssessType(sid, q.type)
    || (isSelfAssessSubject(sid) && !EXACT_ONLY_TYPES.has(q.type));
}
```

不要改 `SELF_ASSESS_SUBJECTS`（英语没进去），也不要改 `prefersExactBeforeSelfAssess`（英语仍 false）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/common/subject-config.test.ts`
Expected: PASS

- [ ] **Step 5: 加 ai 模式下的回归测试**

新建 `apps/server/src/modules/practice/english-self-assess.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { selfAssessSkipsJudging } from '../../common/subject-config.js';
import { shouldSelfAssess } from '../exams/exams.service.js';

describe('英语自评不依赖部署环境', () => {
  const old = process.env.JUDGE_SUBJECTIVE_MODE;
  afterEach(() => {
    if (old === undefined) delete process.env.JUDGE_SUBJECTIVE_MODE;
    else process.env.JUDGE_SUBJECTIVE_MODE = old;
    vi.restoreAllMocks();
  });
  it('JUDGE_SUBJECTIVE_MODE=ai 时英语 short_answer 仍自评', () => {
    process.env.JUDGE_SUBJECTIVE_MODE = 'ai';
    expect(selfAssessSkipsJudging(3, 'short_answer')).toBe(true);
    expect(shouldSelfAssess(3, 'short_answer')).toBe(true);
  });
  it('choice 仍走 exact', () => {
    process.env.JUDGE_SUBJECTIVE_MODE = 'ai';
    expect(shouldSelfAssess(3, 'choice')).toBe(false);
  });
});
```

Run: `cd apps/server && npx vitest run src/modules/practice/english-self-assess.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/common/subject-config.ts apps/server/src/common/subject-config.test.ts \
  apps/server/src/modules/practice/judge-core.service.ts \
  apps/server/src/modules/practice/english-self-assess.test.ts
git commit -m "feat(subject): 英语补 en_paper/en_targeted 任务码与显式自评规则"
```

---

### Task 2: 积分默认规则补 en_paper / en_targeted

**Files:**
- Modify: `apps/server/src/modules/points/default-rules.ts:11-29,44-85`
- Test: `apps/server/src/modules/points/default-rules.test.ts`（若不存在则新建同目录）

**Interfaces:**
- Consumes: `DefaultRule` 接口（同文件 `:1-9`）。
- Produces: `TASK_NAMES.en_paper='英语卷子一套'`、`TASK_NAMES.en_targeted='英语专项'`；`DEFAULT_RULES` 含 1 条 paper + 4 条 targeted；`PointsService.award()` 靠 `insertIgnoreBatch` 为存量学生补齐（`points.service.ts:107`），无需迁移。

- [ ] **Step 1: 写失败测试**

```ts
import { DEFAULT_RULES, TASK_NAMES } from './default-rules.js';

describe('英语默认积分规则', () => {
  it('任务名齐备', () => {
    expect(TASK_NAMES.en_paper).toBe('英语卷子一套');
    expect(TASK_NAMES.en_targeted).toBe('英语专项');
  });
  it('en_paper 一套 50 分', () => {
    expect(DEFAULT_RULES).toContainEqual(expect.objectContaining({
      taskCode: 'en_paper', tierKey: 'default', points: 50, dailyLimit: null,
    }));
  });
  it('en_targeted 四档与语文同口径', () => {
    const tiers = DEFAULT_RULES.filter((r) => r.taskCode === 'en_targeted');
    expect(tiers.map((r) => [r.tierKey, r.points])).toEqual([
      ['1', 2], ['3', 8], ['5', 15], ['10', 35],
    ]);
    expect(tiers.every((r) => r.dailyLimit === 5)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/points/default-rules.test.ts`
Expected: FAIL — `undefined` vs `英语卷子一套`。

- [ ] **Step 3: 实现**

`TASK_NAMES` 在 `politics_targeted` 之后加两行：

```ts
  en_paper: '英语卷子一套',
  en_targeted: '英语专项',
```

`DEFAULT_RULES` 中，`politics_paper`（sortOrder 28）之后插：

```ts
  { taskCode: 'en_paper',          taskName: '英语卷子一套', tierKey: 'default', tierLabel: '一套',   points: 50, dailyLimit: null, sortOrder: 29 },
```

`politics_targeted` 四档（sortOrder 120-123）之后插：

```ts
  { taskCode: 'en_targeted',       taskName: '英语专项',     tierKey: '1',       tierLabel: '1 题',   points: 2,  dailyLimit: 5,    sortOrder: 124 },
  { taskCode: 'en_targeted',       taskName: '英语专项',     tierKey: '3',       tierLabel: '3 题',   points: 8,  dailyLimit: 5,    sortOrder: 125 },
  { taskCode: 'en_targeted',       taskName: '英语专项',     tierKey: '5',       tierLabel: '5 题',   points: 15, dailyLimit: 5,    sortOrder: 126 },
  { taskCode: 'en_targeted',       taskName: '英语专项',     tierKey: '10',      tierLabel: '10 题',  points: 35, dailyLimit: 5,    sortOrder: 127 },
```

注意：`sortOrder` 是展示排序，不要改动任何既有行的值（家长端顺序会变）。

- [ ] **Step 4: 跑测试确认通过，并跑整个 points 模块**

Run: `cd apps/server && npx vitest run src/modules/points`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/modules/points/default-rules.ts apps/server/src/modules/points/default-rules.test.ts
git commit -m "feat(points): 英语真题/专项积分规则"
```

---

### Task 3: 考试结果新增 no_standard_answer 终态（后端）

**Files:**
- Modify: `apps/server/src/modules/exams/exams.service.ts:37-40,250-293,315-408,467-483`
- Modify: `apps/server/src/modules/exams/dto/session-create.dto.ts:59-101`
- Test: `apps/server/src/modules/exams/exams.service.test.ts`

**Interfaces:**
- Consumes: `ExamPapersRepository.findQuestionsByPaperId()` 返回的 `q.hasAnswer`（repo SELECT 里 `(q.answer IS NOT NULL AND TRIM(q.answer) <> '') AS hasAnswer`）；`ExamResultRow` 已含 `method` 与 `answer`（`exam-sessions.repo.ts:162-166`）。
- Produces: `ExamSummaryDto.unscoredCount`、`ExamResultItemDto.method`、`ExamResultItemDto.hasStandardAnswer`；单题 `method='no_standard_answer'`。

- [ ] **Step 1: 写失败测试**

在 `exams.service.test.ts` 加（沿用文件已有 harness 创建 session 的方式）：

```ts
it('无参考答案题落 no_standard_answer，不写错题本、不计客观分母', async () => {
  // paper 974 的题目 hasAnswer=0；用已有 harness 建 session 后交卷
  const summary = await service.submit(studentId, sessionId);
  expect(summary.unscoredCount).toBe(35);
  expect(summary.totalCount).toBe(0);          // 有效题数 = 35 - 35
  expect(summary.accuracy).toBe(0);
  const answers = await examSessionsRepo.findAnswersBySession(sessionId);
  expect(answers.every((a) => a.method === 'no_standard_answer')).toBe(true);
  expect(answers.every((a) => a.is_correct === null && a.score == null)).toBe(true);
  expect(mainErrorRepo.create).not.toHaveBeenCalled();
});

it('结果页 needsSelfAssessment 不再由 isCorrect===null 推断', async () => {
  const res = await service.getResults(studentId, submittedSessionId);
  const unscored = res.items.find((i) => i.method === 'no_standard_answer')!;
  expect(unscored.hasStandardAnswer).toBe(false);
  expect(unscored.needsSelfAssessment).toBe(false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/exams/exams.service.test.ts`
Expected: FAIL — `unscoredCount` undefined / `method` undefined。

- [ ] **Step 3: 改 DTO**

`session-create.dto.ts`：

```ts
export interface ExamSummaryDto {
  correctCount: number;
  totalCount: number;
  accuracy: number;
  subjectiveCount: number;
  partialCount?: number;
  /** 无参考答案、不判不计的题数；不计入 totalCount/subjectiveCount。 */
  unscoredCount: number;
  points?: PointsAwardDto;
}

export interface ExamResultItemDto {
  // ...其余字段不变
  isCorrect: number | null;
  /** 该题最终落库 method：exact/ai/self_assess/unanswered/failed/no_standard_answer。 */
  method: string | null;
  /** 是否有标准答案（no_standard_answer 为 false）。 */
  hasStandardAnswer: boolean;
  needsSelfAssessment?: boolean;
  // ...
}
```

- [ ] **Step 4: 改 finalizeSession**

把无答案分支放在 `shouldSelfAssess` **之前**（`exams.service.ts:320-335`）：

```ts
for (const q of questions) {
  // 1. 无参考答案：优先级最高，既不能按错计，也不能落 self_assess 让学生对空白答案自评
  if (!q.hasAnswer) {
    const a0 = byQuestion.get(q.questionId);
    await this.examSessionsRepo.upsertAnswer({
      sessionId: session.id,
      questionId: q.questionId,
      questionOrder: q.questionNo,
      answerText: a0?.answer_text ?? null,
      isCorrect: null,
      score: null,
      method: 'no_standard_answer',
      judgedAt: new Date(),
    });
    continue;
  }
  // 2. 自评（含英语 short_answer/proof 的显式规则）
  if (shouldSelfAssess(session.subject_id, q.type)) { /* 原逻辑不变 */ }
  // 3. 未作答 / 在途补判 原逻辑不变
}
```

`q.hasAnswer` 若 repo 返回的是 `0|1`，`!q.hasAnswer` 成立即可；若是字符串 `'0'`，改成 `String(q.hasAnswer) !== '1'`。实现时以该 repo 实际类型为准（读 `exam-papers.repo.ts:94-108` 和 `database/repositories/types.ts` 的对应行）。

- [ ] **Step 5: 改 summarize**

`exams.service.ts:467-483` 整段替换：

```ts
private summarize(
  totalCount: number,
  answers: Array<Pick<ExamAnswerRow, 'is_correct' | 'score' | 'method'>>,
): ExamSummaryDto {
  const unscoredCount = answers.filter((a) => a.method === 'no_standard_answer').length;
  const effectiveTotal = totalCount - unscoredCount;
  const subjectiveCount = answers.filter(
    (a) => a.is_correct === null && a.method !== 'no_standard_answer',
  ).length;
  const objectiveTotal = effectiveTotal - subjectiveCount;
  const correctCount = answers.filter((a) => a.is_correct === 1).length;
  const earned = answers
    .filter((a) => a.is_correct !== null)
    .reduce((sum, a) => sum + (a.score == null ? (a.is_correct === 1 ? 1 : 0) : Number(a.score)), 0);
  const partialCount = answers.filter(
    (a) => a.score != null && Number(a.score) > 0 && Number(a.score) < 1,
  ).length;
  const accuracy = objectiveTotal > 0 ? Math.round((earned / objectiveTotal) * 1000) / 10 : 0;
  return { correctCount, totalCount: effectiveTotal, accuracy, subjectiveCount, partialCount, unscoredCount };
}
```

`finalizeSession` 的 `this.summarize(questions.length, finalAnswers)` 不用改（`finalAnswers` 已含 method）。`submit()` 已提交分支的 `summarize(questions.length, answers)` 同理。

- [ ] **Step 6: 改 getResults**

`exams.service.ts:267-292` 整段替换关键部分：

```ts
const rows = await this.examSessionsRepo.findAnswersWithQuestions(sessionId);
const selfAssessed = await this.selfAssessRepo.findLatestByStudentAndQuestionIds(
  studentId,
  rows.filter((r) => r.is_correct === null && r.method !== 'no_standard_answer')
      .map((r) => r.question_id),
);
const items = rows.map((row) => {
  const hasStandardAnswer = !!row.answer && String(row.answer).trim() !== '';
  return {
    questionId: row.question_id,
    questionNo: row.question_order,
    subNo: Number(row.sub_no ?? 0),
    text: row.text,
    type: row.type,
    options: parseOptions(row.options),
    materialText: row.material_text ?? null,
    materialUrl: row.material_url ?? null,
    materialPosition: materialPositionFor(row.subject_id),
    answerText: row.answer_text,
    isCorrect: row.is_correct,
    method: row.method ?? null,
    hasStandardAnswer,
    analysis: row.analysis,
    explanation: row.explanation,
    answer: row.answer,
    needsSelfAssessment: hasStandardAnswer && row.method === 'self_assess',
    selfAssessment: selfAssessed.get(row.question_id) ?? null,
  };
});
const summary = this.summarize(
  items.length,
  items.map((i) => ({
    is_correct: i.isCorrect,
    score: null,
    method: i.method,
  })) as ExamAnswerRow[],
);
return { ...summary, items };
```

注意：结果页的 `earned` 计算需要 score —— 从 `rows` 直接取（原代码也没传 score），保持与原行为一致；如要精确可把 row 的 `score` 一并带上（`exam_answers.score` 已在表里，SELECT 补 `ea.score` 并加进 `ExamResultRow` 类型）。

- [ ] **Step 7: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/exams`
Expected: PASS（含既有语文/数学用例不回归）

- [ ] **Step 8: 提交**

```bash
git add apps/server/src/modules/exams/exams.service.ts \
  apps/server/src/modules/exams/dto/session-create.dto.ts \
  apps/server/src/modules/exams/exams.service.test.ts
git commit -m "feat(exams): 无参考答案题落 no_standard_answer 并从统计剔除"
```

---

### Task 4: 前端学科配置字段化

**Files:**
- Modify: `apps/web/src/subjectConfig.ts:40-57,59-124`
- Test: `apps/web/src/subjectConfig.test.ts`（若不存在则新建）

**Interfaces:**
- Consumes: 现有 `TrainingSubjectConfig`、`TRAINING_SUBJECTS`。
- Produces: 新增可选字段 `targetedExtras?` / `examListTitle?` / `errorPracticeTitle?` / `supportsRemediation?`；英语/语文/数学配置值；`EN_TYPE_OPTIONS`。

- [ ] **Step 1: 写失败测试**

```ts
import { getTrainingSubject, SUBJECT_ENGLISH, SUBJECT_CHINESE, SUBJECT_MATH } from './subjectConfig';

describe('学科配置驱动页面差异', () => {
  it('英语入口落到四卡页且题型按库内实际类型', () => {
    const s = getTrainingSubject(SUBJECT_ENGLISH)!;
    expect(s.homePath).toBe('/student/training/home?subjectId=3');
    expect(s.targetedTaskCode).toBe('en_targeted');
    expect(s.typeOptions.map((o) => o.value)).toEqual(['', 'choice', 'short_answer']);
    expect(s.targetedExtras).toEqual([{
      key: 'vocabulary', label: '背单词', cta: '进入',
      to: '/student/training/english/vocabulary?from=targeted',
    }]);
    expect(s.examListTitle).toBe('英语 · 真题');
    expect(s.errorPracticeTitle).toBe('英语 · 错题练习');
    expect(s.supportsRemediation ?? false).toBe(false);
  });
  it('语文特判迁入配置、数学补偿套题显式开启', () => {
    expect(getTrainingSubject(SUBJECT_CHINESE)!.examListTitle).toBe('语文 · 真题');
    expect(getTrainingSubject(SUBJECT_MATH)!.supportsRemediation).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/subjectConfig.test.ts`
Expected: FAIL — 属性不存在。

- [ ] **Step 3: 实现**

`apps/web/src/subjectConfig.ts` 的 `TrainingSubjectConfig` 接口追加：

```ts
  /** 专项配置页顶部的学科专属入口（英语=背单词）；页面遍历渲染，不写学科分支。 */
  targetedExtras?: readonly { key: string; label: string; cta: string; to: string }[];
  /** 考试列表页标题；缺省 '考试'。 */
  examListTitle?: string;
  /** 错题练习页标题；缺省 '错题练习'。 */
  errorPracticeTitle?: string;
  /** 是否显示相似题补偿入口；缺省 false（只有数学 true）。 */
  supportsRemediation?: boolean;
```

新增常量：

```ts
const EN_TYPE_OPTIONS: readonly SubjectTypeOption[] = [
  ALL,
  { value: 'choice', label: '选择' },
  { value: 'short_answer', label: '简答' },
];
```

`TRAINING_SUBJECTS` 改三项：

```ts
  // 数学
  { id: SUBJECT_MATH, ..., supportsRemediation: true },
  // 语文
  { id: SUBJECT_CHINESE, ..., examListTitle: '语文 · 真题', errorPracticeTitle: '语文 · 错题' },
  // 英语
  {
    id: SUBJECT_ENGLISH, name: '英语', icon: 'english',
    desc: '真题考试 / 专项练习 / 错题练习 / 薄弱点图谱',
    enabled: true, homePath: '/student/training/home?subjectId=3',
    typeOptions: EN_TYPE_OPTIONS, targetedTaskCode: 'en_targeted', isMathLike: false,
    targetedExtras: [{
      key: 'vocabulary', label: '背单词', cta: '进入',
      to: '/student/training/english/vocabulary?from=targeted',
    }],
    examListTitle: '英语 · 真题',
    errorPracticeTitle: '英语 · 错题练习',
  },
```

接口注释 `:53` 的「英语无专项练习」改为「英语专项走 en_targeted，背单词以 targetedExtras 形式挂在专项页」。

- [ ] **Step 4: 跑测试确认通过 + 全量前端测试**

Run: `cd apps/web && npx vitest run src/subjectConfig.test.ts && npm test -- --run`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/subjectConfig.ts apps/web/src/subjectConfig.test.ts
git commit -m "feat(web): 学科差异改配置驱动并补英语训练入口配置"
```

---

### Task 5: 专项练习的背单词入口与返回链路

**Files:**
- Modify: `apps/web/src/pages/student/training/targeted/TargetedConfigPage.tsx`（顶部 `targetedExtras` 遍历）
- Modify: `apps/web/src/pages/student/training/english/VocabularyConfigPage.tsx`（PageHeader 返回路径）
- Modify: `apps/web/src/pages/student/training/english/VocabularyRunPage.tsx`（保留 `from=targeted`）
- Test: `apps/web/src/pages/student/training/targeted/TargetedConfigPage.test.tsx`

**Interfaces:**
- Consumes: Task 4 的 `getTrainingSubject(subjectId)?.targetedExtras`。
- Produces: 英语专项页出现「背单词 + 进入」；`?from=targeted` 在配置页/答题页之间往返；词库与判题零改动。

- [ ] **Step 1: 写失败渲染测试**

```tsx
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => cleanup());

vi.mock('@/services/api', () => ({ /* 保留该测试文件已有的 API mock 形状 */ }));

describe('专项练习的学科扩展入口', () => {
  it('英语渲染背单词入口并带上 from=targeted', async () => {
    render(<MemoryRouter initialEntries={['/student/training/targeted?subjectId=3']}>
      <TargetedConfigPage />
    </MemoryRouter>);
    expect(await screen.findByText('背单词')).toBeTruthy();
    expect(screen.getByRole('button', { name: '进入' })).toBeTruthy();
  });
});
```

若文件已有 mock 工厂，沿用其形状，只加断言；不要新建第二套 mock。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/student/training/targeted/TargetedConfigPage.test.tsx`
Expected: FAIL — 找不到「背单词」。

- [ ] **Step 3: 实现专项页入口**

在 `TargetedConfigPage` 读取学科配置的位置（现有 `getTrainingSubject(...)` 调用附近）加：

```tsx
const extras = subject?.targetedExtras ?? [];
```

在模式切换区之前插入：

```tsx
{extras.length > 0 && (
  <div className="...">
    {extras.map((extra) => (
      <div key={extra.key} className="...">
        <span>{extra.label}</span>
        <button type="button" onClick={() => navigate(extra.to)}>{extra.cta}</button>
      </div>
    ))}
  </div>
)}
```

不要写 `if (subjectId === SUBJECT_ENGLISH)`。

- [ ] **Step 4: 实现返程**

`VocabularyConfigPage`：

```tsx
const fromTargeted = new URLSearchParams(location.search).get('from') === 'targeted';
const backTo = fromTargeted
  ? '/student/training/targeted?subjectId=3'
  : '/student/training';
// PageHeader 的返回/onBack 使用 backTo
// 点击「开始」时：navigate(`/student/training/english/vocabulary/run?from=targeted`)
```

只认枚举值 `'targeted'`，不接收任意 URL（防开放重定向）。

`VocabularyRunPage`：从 `location.search` 读 `from`，返回配置页时拼回 `?from=targeted`；词库查询、判题、错词池代码一行不改。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/pages/student/training/targeted/TargetedConfigPage.test.tsx`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/pages/student/training/targeted/TargetedConfigPage.tsx \
  apps/web/src/pages/student/training/english/VocabularyConfigPage.tsx \
  apps/web/src/pages/student/training/english/VocabularyRunPage.tsx \
  apps/web/src/pages/student/training/targeted/TargetedConfigPage.test.tsx
git commit -m "feat(web): 专项练习挂背单词入口并修返回路径"
```

---

### Task 6: 考试/错题/补偿入口标题配置化 + module 映射改用函数

**Files:**
- Modify: `apps/web/src/pages/student/training/ExamListPage.tsx:211` 附近标题
- Modify: `apps/web/src/pages/student/training/errors/ErrorPracticePage.tsx:252` 附近标题
- Modify: `apps/web/src/pages/student/training/TargetedRunPage.tsx`（补偿套题判断）
- Modify: `apps/server/src/modules/training/training.service.ts:217-221`
- Modify: `apps/server/src/database/repositories/special-practice-sessions.repo.ts:5-8`
- Test: 对应三个页面的渲染测试 + `training.service.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `targetedSessionModule()`；Task 4 的 `examListTitle` / `errorPracticeTitle` / `supportsRemediation`。
- Produces: 英语作答记录落 `en_targeted`；道法落 `politics_targeted`；只有数学显示补偿套题。

- [ ] **Step 1: 写失败测试**

`training.service.test.ts` 加：

```ts
it('英语专项会话落 en_targeted，不再串到 math_targeted', async () => {
  const session = await service.startTargetedPractice({ subjectId: 3, ...validInput });
  expect(session.module).toBe('en_targeted');
});
it('道法专项会话落 politics_targeted（既有缺口一并修）', async () => {
  const session = await service.startTargetedPractice({ subjectId: 9, ...validInput });
  expect(session.module).toBe('politics_targeted');
});
```

`TargetedRunPage.test.tsx` 加：

```tsx
it('英语判错后仍不显示相似题补偿入口', () => {
  // 复用已有 harness，subjectId=3 且 isCorrect=false
  expect(screen.queryByText(/补偿|相似题/)).toBeNull();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run:
`cd apps/server && npx vitest run src/modules/training/training.service.test.ts`
`cd apps/web && npx vitest run src/pages/student/training/TargetedRunPage.test.tsx`
Expected: FAIL — module 仍是 `math_targeted` / 补偿入口仍显示。

- [ ] **Step 3: 后端改映射**

`apps/server/src/modules/training/training.service.ts:217-221`：

```ts
import { targetedSessionModule } from '../../common/subject-config.js';
// 把内联 subjectId 三元/switch 整段替换为：
const moduleName = targetedSessionModule(subjectId) as SpecialSessionModule;
```

`special-practice-sessions.repo.ts:5-8` 的联合类型改为：

```ts
export type SpecialSessionModule =
  | 'math_targeted' | 'cn_targeted' | 'en_targeted'
  | 'physics_targeted' | 'chemistry_targeted' | 'politics_targeted'
  | /* 保留该联合类型中原有的其它成员 */;
```

- [ ] **Step 4: 前端改标题与补偿判断**

```tsx
// ExamListPage
const title = getTrainingSubject(subjectId)?.examListTitle ?? '考试';

// ErrorPracticePage
const title = getTrainingSubject(subjectId)?.errorPracticeTitle ?? '错题练习';

// TargetedRunPage：把 subjectId !== SUBJECT_CHINESE 换成配置
const showRemediation = getTrainingSubject(subjectId)?.supportsRemediation === true;
```

后端补偿端点保持“只认 math_targeted”的防御校验，不改。

- [ ] **Step 5: 跑测试确认通过**

Run:
`cd apps/server && npx vitest run src/modules/training`
`cd apps/web && npx vitest run src/pages/student/training`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/modules/training/training.service.ts \
  apps/server/src/database/repositories/special-practice-sessions.repo.ts \
  apps/server/src/modules/training/training.service.test.ts \
  apps/web/src/pages/student/training/ExamListPage.tsx \
  apps/web/src/pages/student/training/errors/ErrorPracticePage.tsx \
  apps/web/src/pages/student/training/TargetedRunPage.tsx \
  apps/web/src/pages/student/training/TargetedRunPage.test.tsx
git commit -m "feat: 学科 module 映射与页面标题改配置驱动"
```

---

### Task 7: 薄弱点图谱开放英语 + 所有动作携带学科上下文

**Files:**
- Modify: `apps/server/src/modules/knowledge-graph/knowledge-graph.controller.ts:28-29,87-90`
- Modify: `apps/web/src/pages/student/training/WeakPointGraphPage.tsx:44-170`（导航动作）
- Test: `apps/web/src/pages/student/training/WeakPointGraphPage.test.tsx`
- Test: `apps/server/src/modules/knowledge-graph/knowledge-graph.controller.test.ts`

**Interfaces:**
- Consumes: `SUBJECT_ENGLISH=3`；Task 4 的 `targetedTaskCode`。
- Produces: 英语 `GET /knowledge-graph/mastery|weak-points` 不再 400；四个跳转动作都带 `subjectId=3`。

- [ ] **Step 1: 写失败测试**

```tsx
it('英语图谱的四个动作都保留 subjectId=3', () => {
  // 用 WeakPointGraphPage 的已有测试 harness，初始 URL ?subjectId=3
  const links = screen.getAllByRole('link').map((el) => el.getAttribute('href'));
  expect(links).toContain('/student/training/targeted/run?subjectId=3');
  expect(links.some((h) => h?.startsWith('/student/training/errors?subjectId=3&kpId='))).toBe(true);
  expect(links).toContain('/student/training/targeted?subjectId=3');
  expect(links).toContain('/student/training/exam?subjectId=3');
});
```

后端测试：

```ts
it('英语学科可以通过图谱门禁', async () => {
  const res = await controller.getMastery(studentId, 3);
  expect(res).toBeDefined();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run:
`cd apps/server && npx vitest run src/modules/knowledge-graph`
`cd apps/web && npx vitest run src/pages/student/training/WeakPointGraphPage.test.tsx`
Expected: FAIL — 400 / href 缺 subjectId。

- [ ] **Step 3: 后端开放门禁**

```ts
const SUPPORTED_SUBJECTS = new Set([1, 3, 4, 5, 9]);
// 错误文案
throw new HttpException({ code: ..., message: 'subjectId 仅支持 1 / 3 / 4 / 5 / 9' }, 400);
```

- [ ] **Step 4: 前端统一 subjectQuery**

在 `WeakPointGraphPage` 顶部：

```tsx
const subjectQuery = subjectId === SUBJECT_MATH ? '' : `?subjectId=${subjectId}`;
```

四个动作分别改为：

```tsx
navigate(`/student/training/targeted/run${subjectQuery}`);                 // 开始补这个
navigate(`/student/training/errors?subjectId=${subjectId}&kpId=${kpId}`); // 看错题（同时保留 kpId）
navigate(`/student/training/targeted${subjectQuery}`);                    // 去专项练习
navigate(`/student/training/exam${subjectQuery}`);                        // 去考试
```

如果这些动作是 `<Link>`，改成拼好的 `to`，保持可访问性（不要全换成 button）。

- [ ] **Step 5: 跑测试确认通过**

Run:
`cd apps/server && npx vitest run src/modules/knowledge-graph`
`cd apps/web && npx vitest run src/pages/student/training/WeakPointGraphPage.test.tsx`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/modules/knowledge-graph/knowledge-graph.controller.ts \
  apps/server/src/modules/knowledge-graph/knowledge-graph.controller.test.ts \
  apps/web/src/pages/student/training/WeakPointGraphPage.tsx \
  apps/web/src/pages/student/training/WeakPointGraphPage.test.tsx
git commit -m "feat(weakpoint): 开放英语图谱门禁并保证跳转带学科"
```

---

### Task 8: 英语知识点种子迁移

**Files:**
- Create: `tools/db/migrations/2026-11-24_english_knowledge_points.sql`

**Interfaces:**
- Consumes: `knowledge_points` 表结构（`tools/db/schema.sql:180-195`），subjects 种子英语 id=3。
- Produces: 一级 E01–E07、二级 E0101…E0702，`grade_band='junior'`；重复执行行数不变。

- [ ] **Step 1: 写迁移（逐行 NOT EXISTS，照语文迁移写法）**

```sql
-- 初中英语知识点两级树种子（subject_id=3, grade_band='junior'）。
-- code 与 tools/data-refinery/src/prompts/question_kps/english.txt 类目对齐。
-- 幂等：knowledge_points 无唯一约束，逐行 NOT EXISTS 防重，可重复执行。

-- 一级 E01-E07
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 3, NULL, p.name, p.code, 'junior' FROM (
  SELECT 'E01' AS code, '语法' AS name UNION ALL
  SELECT 'E02', '词汇' UNION ALL
  SELECT 'E03', '完形填空' UNION ALL
  SELECT 'E04', '阅读理解' UNION ALL
  SELECT 'E05', '写作与表达' UNION ALL
  SELECT 'E06', '听力' UNION ALL
  SELECT 'E07', '情景交际'
) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points k
  WHERE k.subject_id = 3 AND k.grade_band = 'junior'
    AND k.parent_kp_id IS NULL AND k.code = p.code
);

-- 二级示例（E01 语法）：其余 E02-E07 同构，父节点用 code 定位
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 3, p.id, c.name, c.code, 'junior' FROM (
  SELECT 'E0101' AS code, '时态' AS name UNION ALL
  SELECT 'E0102', '语态' UNION ALL
  SELECT 'E0103', '从句' UNION ALL
  SELECT 'E0104', '非谓语动词' UNION ALL
  SELECT 'E0105', '情态动词' UNION ALL
  SELECT 'E0106', '比较级与最高级' UNION ALL
  SELECT 'E0107', '介词与连词'
) c
JOIN knowledge_points p ON p.subject_id = 3 AND p.grade_band = 'junior'
  AND p.parent_kp_id IS NULL AND p.code = 'E01'
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points k
  WHERE k.subject_id = 3 AND k.grade_band = 'junior' AND k.code = c.code
);
```

完整二级清单（必须全部写进迁移，不能只写 E01）：

- E02 词汇：E0201 词义辨析 / E0202 固定搭配 / E0203 词形变化 / E0204 构词法 / E0205 熟词僻义
- E03 完形填空：E0301 上下文推断 / E0302 逻辑衔接 / E0303 词义复现
- E04 阅读理解：E0401 细节理解 / E0402 推理判断 / E0403 主旨大意 / E0404 标题归纳 / E0405 词义猜测
- E05 写作与表达：E0501 信息提取 / E0502 观点表达 / E0503 文段表达 / E0504 书面表达
- E06 听力：E0601 对话理解 / E0602 独白理解
- E07 情景交际：E0701 情景问答 / E0702 交际用语

- [ ] **Step 2: 本地执行两次验证幂等**

Run:
```bash
mysql -h localhost -P 3306 -u ai_k12 -pai_k12 ai_k12 < tools/db/migrations/2026-11-24_english_knowledge_points.sql
mysql -h localhost -P 3306 -u ai_k12 -pai_k12 ai_k12 < tools/db/migrations/2026-11-24_english_knowledge_points.sql
mysql -h localhost -P 3306 -u ai_k12 -pai_k12 ai_k12 -e "SELECT COUNT(*) FROM knowledge_points WHERE subject_id=3"
```
Expected: 两次均成功，COUNT = 7 + 28 = 35（7 个一级 + 28 个二级：E01 7 / E02 5 / E03 3 / E04 5 / E05 4 / E06 2 / E07 2）。再查 `SELECT code, COUNT(*) ... GROUP BY code HAVING COUNT(*)>1` 应为空。

- [ ] **Step 3: 提交**

```bash
git add tools/db/migrations/2026-11-24_english_knowledge_points.sql
git commit -m "feat(db): 英语初中知识点种子 E01-E07"
```

---

### Task 9: 回填脚本支持材料感知与仅答可练题

**Files:**
- Modify: `tools/data-refinery/src/backfill_question_kps.py:248-330`（CLI + SQL + user message）
- Modify: `tools/data-refinery/src/prompts/question_kps/english.txt`（类目与 KP 树精确对齐）
- Test: `tools/data-refinery/tests/test_backfill_question_kps.py`（若不存在则新建）

**Interfaces:**
- Consumes: Task 8 的 KP 树；现有 `MaterialDocService` 素材读取能力；`questions.material_text` / `material_url`。
- Produces: `--include-material`、`--answerable-only` 两个开关；默认行为（其它学科）完全不变。

- [ ] **Step 1: 写失败测试**

```python
def test_answerable_only_filters_questions():
    sql = build_question_select_sql(subject_id=3, include_material=True, answerable_only=True)
    assert "q.is_active = 1" in sql
    assert "TRIM(q.answer) <> ''" in sql
    assert "q.material_text" in sql and "q.material_url" in sql

def test_default_flags_do_not_change_other_subjects():
    sql = build_question_select_sql(subject_id=1, include_material=False, answerable_only=False)
    assert "q.material_text" not in sql
    assert "q.is_active = 1" not in sql

def test_material_read_failure_is_reported_not_guessed():
    result = build_user_message(
        q={"content": ""}, material=None, material_error="404", options=[], qtype="choice"
    )
    assert result is None   # 由调用方记入 failed 清单
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd tools/data-refinery && pytest tests/test_backfill_question_kps.py -v`
Expected: FAIL — `build_question_select_sql` 不存在。

- [ ] **Step 3: 实现两个纯函数 + CLI**

把 SELECT 构造抽成可测纯函数：

```python
def build_question_select_sql(subject_id: int, include_material: bool, answerable_only: bool) -> str:
    cols = "q.id, q.content, q.options, q.type"
    if include_material:
        cols += ", q.material_text, q.material_url"
    where = ["qkp.question_id IS NULL", "q.subject_id = %s"]
    if answerable_only:
        where.append("q.is_active = 1")
        where.append("COALESCE(TRIM(q.answer), '') <> ''")
    return (
        f"SELECT {cols} FROM questions q "
        "LEFT JOIN question_knowledge_points qkp ON qkp.question_id = q.id "
        f"WHERE {' AND '.join(where)} ORDER BY q.id"
    )
```

CLI 加：

```python
parser.add_argument("--include-material", action="store_true",
                    help="读取 material_text/material_url 并随题目送模型（英语阅读/完形必需）")
parser.add_argument("--answerable-only", action="store_true",
                    help="只标注在架且有标准答案的题（英语本次只标 70 题）")
```

user message 构造：

```python
def build_user_message(q, material, material_error, options, qtype):
    if material_error:
        return None                      # 调用方记 failed，不退化成只看选项
    parts = [f"题型：{qtype}"]
    if q.get("content"):
        parts.append(f"题干：{q['content']}")
    if material:
        parts.append(f"材料：{material}")
    if not q.get("content") and not material:
        return None
    parts.append(f"选项：{options}")
    return "\n".join(parts)
```

`material_url` 读取用仓库现有 MaterialDoc 能力（搜 `material` 相关读取函数并复用，不新写下载逻辑）；读失败时把 question id 写进 `failed_ids` 并打印清单。

`english.txt` 改成与 Task 8 的 E01–E07 一一对应，例如：

```
只从下列二级知识点中选择（code 与名称必须完全一致）：
E0101 时态 / E0102 语态 / E0103 从句 / E0104 非谓语动词 / E0105 情态动词 / E0106 比较级与最高级 / E0107 介词与连词
E0201 词义辨析 / ... （完整 30 项按迁移清单写全）
语法题选具体语法点，不要只选「语法」；词汇/词形题选「词汇」下的具体类型；
完形与阅读选具体能力；书面表达选 E0504；听力选 E06 子类；情景交际选 E07 子类。
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd tools/data-refinery && pytest tests/test_backfill_question_kps.py -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add tools/data-refinery/src/backfill_question_kps.py \
  tools/data-refinery/src/prompts/question_kps/english.txt \
  tools/data-refinery/tests/test_backfill_question_kps.py
git commit -m "feat(refinery): KP 回填支持材料感知与仅答可练题"
```

---

### Task 10: 跑回填、核验知识点覆盖

**Files:**
- 无代码改动（数据写入 `question_knowledge_points`）

**Interfaces:**
- Consumes: Task 8 的 KP 树、Task 9 的脚本。
- Produces: 当前 70 道在架有答案英语题全部有 qkp；失败题清单可见。

- [ ] **Step 1: 小样本验证**

Run:
```bash
cd tools/data-refinery && python3 src/backfill_question_kps.py --subject english --include-material --answerable-only --limit 5
```
Expected: 打印 5 题的标注结果；抽查题目与所选 KP 是否明显错配。若错配率高，先回到 Task 9 调 prompt，不要直接全量跑。

- [ ] **Step 2: 全量回填**

Run:
```bash
cd tools/data-refinery && python3 src/backfill_question_kps.py --subject english --include-material --answerable-only
```
Expected: 处理 70 题；输出失败清单（若有）。失败题重跑一次，仍失败的记录在验收报告里。

- [ ] **Step 3: 数据库核验**

Run:
```bash
mysql -h localhost -P 3306 -u ai_k12 -pai_k12 ai_k12 -e "
SELECT COUNT(DISTINCT q.id) AS tagged FROM questions q
 JOIN question_knowledge_points qkp ON qkp.question_id=q.id
 WHERE q.subject_id=3 AND q.is_active=1 AND COALESCE(TRIM(q.answer),'')<>'';"
```
Expected: `tagged` = 70（或失败题数之外的全部）。

- [ ] **Step 4: 不提交数据**（DB 写入不是代码改动）

---

### Task 11: 前端无答案状态展示（结果页与共享组件）

**Files:**
- Modify: `apps/web/src/services/api.ts:2341,2362-2385`（`ExamSummary.unscoredCount`、`ExamResultItem.method/hasStandardAnswer`）
- Modify: `apps/web/src/pages/student/training/ExamResultPage.tsx:171-220`（映射 `unscored`）
- Modify: `apps/web/src/components/business/AnswerResultList.tsx:16-29, Props`（`AnswerRecord.unscored` 与渲染）
- Test: `apps/web/src/components/business/AnswerResultList.test.tsx`
- Test: `apps/web/src/pages/student/training/ExamResultPage.test.tsx`

**Interfaces:**
- Consumes: Task 3 的新 DTO 字段。
- Produces: 无答案题显示「无参考答案 · 不计分」，无自评按钮，不计入未自评数/主观数/错误数。

- [ ] **Step 1: 写失败组件测试**

在 `AnswerResultList.test.tsx` 加：

```tsx
it('unscored 项显示不计分且无自评按钮', () => {
  render(<AnswerResultList
    questions={[/* 复用已有 fixture */]}
    answers={{ '1': {
      isCorrect: false, method: 'no_standard_answer', studentAnswer: 'x', unscored: true,
    }}}
    onClose={() => {}}
  />);
  expect(screen.getByText(/无参考答案/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /自评|做对|做错/ })).toBeNull();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/components/business/AnswerResultList.test.tsx`
Expected: FAIL — 文案不存在 / 自评按钮仍在。

- [ ] **Step 3: 改前端契约**

`api.ts`：

```ts
export interface ExamSummary {
  // ...
  unscoredCount?: number;
}
export interface ExamResultItem {
  // ...
  method?: string | null;
  hasStandardAnswer?: boolean;
}
```

- [ ] **Step 4: 改 ExamResultPage 映射**

在 `:171-220` 的 items 映射里加：

```ts
const unscored = item.method === 'no_standard_answer';
// AnswerResultList 的 answers 条目：
{
  isCorrect: item.isCorrect === 1,
  method: item.method ?? '',
  studentAnswer: item.answerText ?? '',
  needsSelfAssess: !!item.needsSelfAssessment,
  selfAssessment: item.selfAssessment ?? null,
  unscored,
}
```

成绩卡四栏里：未自评横幅计数必须排除 `unscored`；客观题总数用 `summary.totalCount`（已由后端剔除）。

- [ ] **Step 5: 改 AnswerResultList**

`AnswerRecord` 加 `unscored?: boolean`。渲染分支：

```tsx
{record.unscored ? (
  <span className="...">无参考答案 · 不计分</span>
) : (
  /* 原有对错/自评渲染 */
)}
```

所有计数处（`needsSelfAssess` 数、`!isCorrect` 数、`method === 'self_assess'` 数）加 `&& !record.unscored` 守卫。

- [ ] **Step 6: 跑测试确认通过 + 全量前端测试**

Run:
`cd apps/web && npx vitest run src/components/business/AnswerResultList.test.tsx src/pages/student/training/ExamResultPage.test.tsx && npm test -- --run`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/services/api.ts \
  apps/web/src/pages/student/training/ExamResultPage.tsx \
  apps/web/src/components/business/AnswerResultList.tsx \
  apps/web/src/components/business/AnswerResultList.test.tsx \
  apps/web/src/pages/student/training/ExamResultPage.test.tsx
git commit -m "feat(web): 考试结果展示无参考答案不计分状态"
```

---

### Task 12: 文档同步与单一交付命令

**Files:**
- Modify: `docs/API接口与数据流设计文档.md`（任务码清单 §5、考试结果 schema §4.19/§5.17、图谱学科 §4.x）
- Modify: `docs/api/openapi.yaml`（ExamSummary/ExamResultItem schema、knowledge-graph subjectId enum、任务码枚举）
- Modify: `docs/K12智学系统-产品需求文档.md` §6.3 / §7.13
- Modify: `docs/UX-UI设计文档.md` §5.8 / §5.13
- Modify: `docs/ai-core-changelog.md`（带日期日志）
- Create: `tools/english-training/setup.sh`

**Interfaces:**
- Consumes: 前 11 个任务的所有改动。
- Produces: 一条命令 `bash tools/english-training/setup.sh` 完成预检→确认→迁移→回填→测试→构建→复查。

- [ ] **Step 1: 写 setup.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "== 1/6 预检 =="
mysql -h localhost -P 3306 -u ai_k12 -pai_k12 ai_k12 -e \
  "SELECT COUNT(*) AS english_papers FROM exam_papers WHERE subject_id=3;" >/dev/null
[ -f tools/db/migrations/2026-11-24_english_knowledge_points.sql ]

echo "== 2/6 确认（仅此一步需要人） =="
read -r -p "将写入英语知识点种子并重跑标注，确认？[y/N] " ans
[ "$ans" = "y" ] || { echo "已取消"; exit 0; }

echo "== 3/6 应用幂等迁移 =="
mysql -h localhost -P 3306 -u ai_k12 -pai_k12 ai_k12 \
  < tools/db/migrations/2026-11-24_english_knowledge_points.sql

echo "== 4/6 材料感知回填 =="
(cd tools/data-refinery && python3 src/backfill_question_kps.py \
  --subject english --include-material --answerable-only)

echo "== 5/6 测试与构建 =="
(cd apps/server && npx vitest run && npm run build)
(cd apps/web && npm test -- --run && npm run build)

echo "== 6/6 复查 =="
mysql -h localhost -P 3306 -u ai_k12 -pai_k12 ai_k12 -e "
SELECT (SELECT COUNT(*) FROM knowledge_points WHERE subject_id=3) AS kps,
       (SELECT COUNT(DISTINCT q.id) FROM questions q
        JOIN question_knowledge_points qkp ON qkp.question_id=q.id
        WHERE q.subject_id=3 AND q.is_active=1 AND COALESCE(TRIM(q.answer),'')<>'') AS tagged;"

echo "完成。启动后端请用：node dist/main.js"
echo "注意：npm run build 会覆盖 dev server 正在服务的 dist。"
```

脚本必须 `chmod +x`。除「确认」外不做任何交互式二次输入。

- [ ] **Step 2: 同步 API 文档与 openapi**

在 `docs/API接口与数据流设计文档.md`：
- §4.19 七端点表保持不变，补一段「英语真题考试复用同一组端点，`subjectId=3`」。
- §5.17 数据流补 `no_standard_answer` 分支与 `unscoredCount` 语义。
- 任务码清单补 `en_paper` / `en_targeted`。
- 知识图谱学科说明补 3。

在 `docs/api/openapi.yaml`：
- `ExamSummary` 加 `unscoredCount: integer`。
- `ExamResultItem` 加 `method: string`、`hasStandardAnswer: boolean`。
- knowledge-graph 的 `subjectId` enum 从 `[1,4,5,9]` 改 `[1,3,4,5,9]`。
- 任务码枚举补两个值。

改完核对两边端点路径列表一致（CLAUDE.md 的 API 文档同步规则）。

- [ ] **Step 3: 同步 PRD / UX / changelog**

- PRD §6.3 训练轨学科表补英语四模块；§7.13 积分表补 `en_paper` 50 分 / `en_targeted` 四档。
- UX §5.8 / §5.13 补英语真题列表与图谱页面状态。
- `docs/ai-core-changelog.md` 追加带日期条目，写清「974 无答案不判不计」的裁决与「图谱冷启动可接受」的裁决（日期日志不进根 CLAUDE.md）。

- [ ] **Step 4: 跑单一命令验收**

Run: `bash tools/english-training/setup.sh`
Expected: 六步全过；最后 `kps=37`、`tagged=70`（或与失败清单对应的数字）。

- [ ] **Step 5: 人工端到端冒烟**

- `node dist/main.js` 起后端。
- 学生账号：训练选科 → 英语 → 四卡页 → 真题考试（975/1008 交卷看分）→ 错题练习（英语题）→ 薄弱点图谱（节点可见）→ 开始补这个（作答页仍英语）→ 专项练习 → 背单词 → 返回专项。
- 974：可开考；无答案题显示「无参考答案 · 不计分」；不自评、不计错、不写错题本。
- 1008：有答案题正常判分；3 道缺答案题同 974 口径。

- [ ] **Step 6: 提交**

```bash
git add docs/API接口与数据流设计文档.md docs/api/openapi.yaml \
  docs/K12智学系统-产品需求文档.md docs/UX-UI设计文档.md \
  docs/ai-core-changelog.md tools/english-training/setup.sh
git commit -m "docs+tools: 英语训练轨四模块文档同步与单一交付入口"
```

---

## Self-Review（写完计划后已执行）

- **Spec coverage**：spec §4.1–4.5 的每项改动均落到 Task 1–11；§6 的 20 项文件清单全部覆盖（第 19 项文档 → Task 12）；单一交付命令 → Task 12 Step 1。
- **Placeholder scan**：无 TBD/TODO；所有代码步骤给了具体片段。Task 8 的 E02–E07 二级清单以完整枚举给出（不是「照 E01 写」）。
- **Type consistency**：`targetedSessionModule` / `isExplicitSelfAssessType` / `unscoredCount` / `hasStandardAnswer` / `unscored` 在产生方与使用方命名一致；`method='no_standard_answer'` 全链路统一。
