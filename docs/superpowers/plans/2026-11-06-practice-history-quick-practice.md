# 练习记录：单题重做与同类型练习 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在练习记录详情页为单题提供「重做」与「同类型练习」，并让数理化专项的未作答题在历史中可见、可重做。

**Architecture:** 复用现有练习记录详情/专项答题页。重做走 `mode=redo`（不建会话、不落记录、不发分，只关闭订正分）；同类型由新增的 `HistoryPracticeService` 按 KP+题型+难度抽题、AI 补缺、建 `training_sessions` 发档位分，答题页复用 `TargetedRunPage` 并生成专项记录。

**Tech Stack:** NestJS + mysql2 + vitest（apps/server）；React + React Router + vitest/@testing-library（apps/web）。

## Global Constraints

- **重做不生成练习记录、不发任何积分**（含专项档位分、错题订正分）；判错仍进错题本、判对仍清零。
- **同类型练习落一条专项记录**，按实际题数取不超过它的最大档发分；题量 1/2/3/5。
- 同类型本期只开 **数学（1）与物理（4）**；化学（5）`canSimilar=false`。
- 重做覆盖 **全部套卷（不限学科）+ 数理化专项的每一道单题**；语文/英语专项（questionId=null）不支持。
- 不新增表；数理化专项未作答题用 `special_answer_records` 占位行。
- AI 单次硬上限 **20 秒**；超时/失败只用题库已有题，0 题返回空数组（200）。
- 新端点都校验会话与题目归属；非本人/不存在一律 404（不泄漏存在性）。
- `LIMIT ?` 必须走 `pool.query`（不要 `execute`）。
- 前端测试 `globals:false`：多用例文件自己 `afterEach(cleanup)`。
- UI 只用 token（`var(--...)`），不用 emoji，不用硬编码灰阶。
- 任何 API 变更同步 `docs/API接口与数据流设计文档.md` 与 `docs/api/openapi.yaml`。

---

## File Map

| 文件 | 责任 |
|---|---|
| `apps/server/src/modules/training/history-practice.service.ts`（新） | 重做题白名单加载、同类型抽题/AI/建发分会话 |
| `apps/server/src/modules/training/training.module.ts` | provide + export `HistoryPracticeService` |
| `apps/server/src/modules/training/training.service.ts` | 判题透传 `plannedQuestionIds` / `suppressErrorFixPoints`；自评透传 suppress |
| `apps/server/src/modules/training/training.controller.ts` | 判题/自评 DTO 字段 |
| `apps/server/src/modules/training/dto/judge-training.dto.ts` | 两个新可选字段 |
| `apps/server/src/modules/training/dto/self-assess.dto.ts` | `suppressErrorFixPoints?` |
| `apps/server/src/modules/practice/judge-core.service.ts` | 答对清零但可跳过订正分 |
| `apps/server/src/modules/practice-history/practice-history.*` | 详情 flags、redo/similar 端点 |
| `apps/server/src/database/repositories/questions.repo.ts` | 批量 KP 查询 |
| `apps/server/src/database/repositories/exam-sessions.repo.ts` | 详情联表补 `is_active` |
| `apps/server/src/database/repositories/special-answer-records.repo.ts` | 联表补 `is_active`、占位行 |
| `apps/server/src/ai-core/capabilities/variation.capability.ts` | 学科/超时参数 |
| `apps/server/src/ai-core/infra/prompt-builder.ts` | variation 按学科取模板 |
| `apps/server/src/ai-core/prompts/variation/physics.md`（新） | 物理变式 prompt |
| `apps/server/src/modules/training/variation-question.util.ts` | multi_choice 归一/校验 |
| `apps/server/src/modules/points/default-rules.ts` | 2 题档 |
| `tools/db/migrations/2026-11-06_add_targeted_2_tier.sql`（新） | 存量学生补 2 题档 |
| `apps/web/src/services/api.ts` | 类型 + 两个新 API + 判题字段 |
| `apps/web/src/pages/student/PracticeHistoryDetailPage.tsx` | 两个按钮、面板、未作答徽章 |
| `apps/web/src/pages/student/training/run-handoff.ts` | `title`/`mode` |
| `apps/web/src/pages/student/training/TargetedRunPage.tsx` | 两种模式、planned ids、题号、returnTo |

---

### Task 1: 2 题档（默认规则 + 存量迁移）

**Files:**
- Modify: `apps/server/src/modules/points/default-rules.ts:51-54,71-74`
- Modify: `apps/server/src/modules/points/point-rules.service.test.ts:101,191-192,281,301`
- Create: `tools/db/migrations/2026-11-06_add_targeted_2_tier.sql`

**Interfaces:**
- Produces: `DEFAULT_RULES` 中 `math_targeted` / `physics_targeted` 各有 `tierKey='2'`、`tierLabel='2 题'`、`points=5`、`dailyLimit=5`。

- [ ] **Step 1: 写失败测试**

在 `point-rules.service.test.ts` 把档位断言改成含 2 档，并加物理断言：

```ts
it("math_targeted → ['1','2','3','5','10']", async () => {
  const h = harness();
  h.rulesRepo.findByStudent.mockResolvedValue(defaultRows());
  await expect(h.service.listTierKeys(7, 'math_targeted')).resolves.toEqual(['1', '2', '3', '5', '10']);
});

it("physics_targeted → ['1','2','3','5','10']", async () => {
  const h = harness();
  h.rulesRepo.findByStudent.mockResolvedValue(defaultRows());
  await expect(h.service.listTierKeys(7, 'physics_targeted')).resolves.toEqual(['1', '2', '3', '5', '10']);
});
```

把同文件里两处旧数组 `['1','3','5','10']` 改成 `['1','2','3','5','10']`；把 `missing` 的 `toHaveLength(35)` 改成 `37`、`tasks.flatMap(t=>t.tiers)` 的 `38` 改成 `40`（新增 2 行档位）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/points/point-rules.service.test.ts`
Expected: FAIL（实际仍为 `1/3/5/10`）。

- [ ] **Step 3: 加默认档位**

`default-rules.ts` 的数学段改为：

```ts
  { taskCode: 'math_targeted',     taskName: '数学专项',     tierKey: '1',       tierLabel: '1 题',   points: 2,  dailyLimit: 5,    sortOrder: 30 },
  { taskCode: 'math_targeted',     taskName: '数学专项',     tierKey: '2',       tierLabel: '2 题',   points: 5,  dailyLimit: 5,    sortOrder: 31 },
  { taskCode: 'math_targeted',     taskName: '数学专项',     tierKey: '3',       tierLabel: '3 题',   points: 8,  dailyLimit: 5,    sortOrder: 32 },
  { taskCode: 'math_targeted',     taskName: '数学专项',     tierKey: '5',       tierLabel: '5 题',   points: 15, dailyLimit: 5,    sortOrder: 33 },
  { taskCode: 'math_targeted',     taskName: '数学专项',     tierKey: '10',      tierLabel: '10 题',  points: 35, dailyLimit: 5,    sortOrder: 34 },
```

物理段同样插 2 档，sortOrder 用 100/101/102/103/104。

- [ ] **Step 4: 写幂等迁移**

`tools/db/migrations/2026-11-06_add_targeted_2_tier.sql`：

```sql
-- 2026-11-06：数学/物理专项新增 2 题档（5 分），给存量学生补规则并重排档位顺序。
INSERT IGNORE INTO point_rules
  (student_id, task_code, tier_key, tier_label, points, daily_limit, sort_order)
SELECT DISTINCT student_id, task_code, '2', '2 题', 5, 5,
       CASE task_code WHEN 'math_targeted' THEN 31 ELSE 101 END
FROM point_rules
WHERE task_code IN ('math_targeted', 'physics_targeted');

UPDATE point_rules
SET sort_order = CASE task_code
  WHEN 'math_targeted' THEN
    CASE tier_key WHEN '1' THEN 30 WHEN '2' THEN 31 WHEN '3' THEN 32 WHEN '5' THEN 33 WHEN '10' THEN 34 END
  WHEN 'physics_targeted' THEN
    CASE tier_key WHEN '1' THEN 100 WHEN '2' THEN 101 WHEN '3' THEN 102 WHEN '5' THEN 103 WHEN '10' THEN 104 END
END
WHERE task_code IN ('math_targeted', 'physics_targeted');
```

- [ ] **Step 5: 跑测试**

Run: `cd apps/server && npx vitest run src/modules/points/point-rules.service.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/modules/points/default-rules.ts apps/server/src/modules/points/point-rules.service.test.ts tools/db/migrations/2026-11-06_add_targeted_2_tier.sql
git commit -m "feat(points): 数学/物理专项新增 2 题档（5 分）"
```

---

### Task 2: 详情接口返回 `canRedo` / `canSimilar`

**Files:**
- Modify: `apps/server/src/database/repositories/questions.repo.ts`（新增 `findKpIdsByQuestionIds`）
- Modify: `apps/server/src/database/repositories/exam-sessions.repo.ts:53-68,155-167`
- Modify: `apps/server/src/database/repositories/special-answer-records.repo.ts:92-104`
- Modify: `apps/server/src/modules/practice-history/practice-history.dto.ts:28-50`
- Modify: `apps/server/src/modules/practice-history/practice-history.service.ts`
- Modify: `apps/server/src/modules/practice-history/practice-history.module.ts`
- Test: `apps/server/src/modules/practice-history/practice-history.service.test.ts`

**Interfaces:**
- Produces: `PracticeHistoryQuestion.canRedo: boolean`、`canSimilar: boolean`；repo `findKpIdsByQuestionIds(ids: number[]): Promise<Map<number, number>>`。

- [ ] **Step 1: 写失败测试**

在 `practice-history.service.test.ts` 的 `make()` 增加：

```ts
const questionsRepo = {
  findKpIdsByQuestionIds: vi.fn().mockResolvedValue(new Map<number, number>()),
};
const service = new PracticeHistoryService(
  examSessionsRepo as never, specialSessionsRepo as never,
  specialAnswersRepo as never, passagesRepo as never,
  questionsRepo as never,
);
```

并加用例：

```ts
it('考试详情：在架 + 有答案 + 有 KP → canRedo/canSimilar 为 true', async () => {
  h.examSessionsRepo.findByIdOwned.mockResolvedValue(mkExamSession({ subject_id: 1 }));
  h.examSessionsRepo.findAnswersWithQuestions.mockResolvedValue([{
    question_id: 100, question_order: 1, answer_text: 'B', is_correct: 0, score: 0,
    analysis: null, method: 'exact', judged_at: null, text: '题干', type: 'choice',
    options: null, explanation: null, answer: 'A', material_text: null, is_active: 1,
  }]);
  h.examSessionsRepo.countAnswersBySession.mockResolvedValue({ total: 1, correct: 0 });
  h.questionsRepo.findKpIdsByQuestionIds.mockResolvedValue(new Map([[100, 28]]));

  const r = await h.service.getDetail({ studentId: 7, source: 'exam', sessionId: 1 });
  expect(r?.questions[0].canRedo).toBe(true);
  expect(r?.questions[0].canSimilar).toBe(true);
});

it('无 KP → canRedo=true / canSimilar=false', async () => {
  h.examSessionsRepo.findByIdOwned.mockResolvedValue(mkExamSession({ subject_id: 1 }));
  h.examSessionsRepo.findAnswersWithQuestions.mockResolvedValue([{
    question_id: 100, question_order: 1, answer_text: 'B', is_correct: 0, score: 0,
    analysis: null, method: 'exact', judged_at: null, text: '题干', type: 'choice',
    options: null, explanation: null, answer: 'A', material_text: null, is_active: 1,
  }]);
  h.questionsRepo.findKpIdsByQuestionIds.mockResolvedValue(new Map());

  const r = await h.service.getDetail({ studentId: 7, source: 'exam', sessionId: 1 });
  expect(r?.questions[0].canRedo).toBe(true);
  expect(r?.questions[0].canSimilar).toBe(false);
});

it('下架题 → 两个都 false；语文专项（questionId=null）也一样', async () => {
  h.examSessionsRepo.findByIdOwned.mockResolvedValue(mkExamSession({ subject_id: 4 }));
  h.examSessionsRepo.findAnswersWithQuestions.mockResolvedValue([{
    question_id: 100, question_order: 1, answer_text: null, is_correct: 0, score: 0,
    analysis: null, method: 'unanswered', judged_at: null, text: '题干', type: 'choice',
    options: null, explanation: null, answer: 'A', material_text: null, is_active: 0,
  }]);
  h.questionsRepo.findKpIdsByQuestionIds.mockResolvedValue(new Map([[100, 1]]));

  const r = await h.service.getDetail({ studentId: 7, source: 'exam', sessionId: 1 });
  expect(r?.questions[0].canRedo).toBe(false);
  expect(r?.questions[0].canSimilar).toBe(false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/practice-history/practice-history.service.test.ts`
Expected: FAIL（构造函数参数不匹配 / 字段 undefined）。

- [ ] **Step 3: 实现 repo**

`questions.repo.ts` 追加：

```ts
/** question_id -> 优先 primary 的最小知识点 id（详情判断 canSimilar / 同类型取种子 KP）。 */
async findKpIdsByQuestionIds(questionIds: number[]): Promise<Map<number, number>> {
  if (questionIds.length === 0) return new Map();
  const placeholders = questionIds.map(() => '?').join(',');
  const [rows] = await this.pool.query<
    (RowDataPacket & { question_id: number; knowledge_point_id: number })[]
  >(
    `SELECT question_id, knowledge_point_id
     FROM question_knowledge_points
     WHERE question_id IN (${placeholders})
     ORDER BY question_id, (role = 'primary') DESC, knowledge_point_id`,
    questionIds,
  );
  const map = new Map<number, number>();
  for (const r of rows) {
    const qid = Number(r.question_id);
    if (!map.has(qid)) map.set(qid, Number(r.knowledge_point_id));
  }
  return map;
}
```

`exam-sessions.repo.ts` 的 `ExamResultRow` 加 `is_active: number;`，SQL 加 `q.is_active`：

```sql
SELECT ea.question_id, ..., q.answer AS answer, q.material_text, q.is_active
```

`special-answer-records.repo.ts` 的 `listBySession` SQL 加 `q.is_active AS question_is_active`，返回类型加 `question_is_active: number | null`。

- [ ] **Step 4: 实现 DTO + service**

`practice-history.dto.ts` 的 `PracticeHistoryQuestion` 加：

```ts
  /** 有题目 id 且在架 -> 可单题重做（语文/英语专项为 false）。 */
  canRedo: boolean;
  /** canRedo + 学科数/理 + 有答案 + 有知识点 -> 可同类型练习。 */
  canSimilar: boolean;
```

`practice-history.service.ts` 构造函数追加 `questionsRepo`，exam 分支映射加：

```ts
const questionIds = answers.map((a) => a.question_id).filter((id): id is number => id != null);
const kpMap = await this.questionsRepo.findKpIdsByQuestionIds(questionIds);
const canRedo = a.question_id != null && a.is_active === 1;
const canSimilar = canRedo
  && (session.subject_id === 1 || session.subject_id === 4)
  && !!a.answer
  && kpMap.has(a.question_id);

canRedo,
canSimilar,
```

special 分支同理，用 `a.question_id != null && a.question_is_active === 1`、`!!a.question_answer`、`kpMap.has(a.question_id)`。`questionIds` 只取非空。

`practice-history.module.ts` 的 `providers` 加 `QuestionsRepository`。

- [ ] **Step 5: 跑测试**

Run: `cd apps/server && npx vitest run src/modules/practice-history/practice-history.service.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/database/repositories/questions.repo.ts apps/server/src/database/repositories/exam-sessions.repo.ts apps/server/src/database/repositories/special-answer-records.repo.ts apps/server/src/modules/practice-history/
git commit -m "feat(practice-history): 详情返回 canRedo/canSimilar"
```

---

### Task 3: 专项未作答占位行（后端）

**Files:**
- Modify: `apps/server/src/database/repositories/special-answer-records.repo.ts`
- Modify: `apps/server/src/modules/training/training.service.ts:189-227`
- Modify: `apps/server/src/modules/training/training.controller.ts:59-78`
- Modify: `apps/server/src/modules/training/dto/judge-training.dto.ts`
- Test: `apps/server/src/database/repositories/special-answer-records.repo.test.ts`
- Test: `apps/server/src/modules/training/training.service.test.ts`

**Interfaces:**
- Produces: `ensurePlannedQuestions(sessionId: number, questionIds: number[]): Promise<void>`；判题入参 `plannedQuestionIds?: number[]`。

- [ ] **Step 1: 写失败测试**

`special-answer-records.repo.test.ts` 加：

```ts
it('ensurePlannedQuestions 按顺序写入空作答行', async () => {
  const pool = { query: vi.fn().mockResolvedValue([{}]) };
  const repo = new SpecialAnswerRecordsRepository(pool as never);
  await repo.ensurePlannedQuestions(9, [11, 12]);
  const [sql, params] = pool.query.mock.calls[0];
  expect(sql).toContain('INSERT IGNORE INTO special_answer_records');
  expect(params).toEqual([9, 11, 1, 9, 12, 2]);
});
```

`training.service.test.ts` 的判题用例里加：传入 `plannedQuestionIds` 时，`specialAnswersRepo.ensurePlannedQuestions` 被调用，且只保留存在、在架、同学科的 id（用 `questionsRepo.findByIds` mock）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/database/repositories/special-answer-records.repo.test.ts src/modules/training/training.service.test.ts`
Expected: FAIL（方法不存在）。

- [ ] **Step 3: 实现占位行**

`special-answer-records.repo.ts`：

```ts
/** 数理化专项开练时保存整轮题单：未答的题写空行，历史详情才能显示「未作答」。 */
async ensurePlannedQuestions(sessionId: number, questionIds: number[]): Promise<void> {
  if (questionIds.length === 0) return;
  const values = questionIds.map(() => '(?, ?, ?, NULL, NULL, NULL, NULL)').join(',');
  const params: Array<number> = [];
  questionIds.forEach((qid, i) => params.push(sessionId, qid, i + 1));
  await this.pool.query(
    `INSERT IGNORE INTO special_answer_records
     (session_id, question_id, question_order, answer_text, is_correct, score, method)
     VALUES ${values}`,
    params,
  );
}
```

- [ ] **Step 4: 接进判题**

`judge-training.dto.ts` 加：

```ts
  /** 数理化专项开练的整轮题单（有序，含已答与未答）；缺省不写占位行。 */
  plannedQuestionIds?: number[];
```

`training.controller.ts` 的 `judgeTraining` 调用加：

```ts
plannedQuestionIds: Array.isArray(dto.plannedQuestionIds)
  ? dto.plannedQuestionIds.filter((n) => Number.isInteger(n) && n > 0)
  : undefined,
```

`training.service.ts` 的 `judgeTraining` 入参加 `plannedQuestionIds?: number[]`；在 `upsertSession` 之后、`upsertAnswer` 之前：

```ts
if (input.plannedQuestionIds?.length && this.questionsRepo) {
  const rows = await this.questionsRepo.findByIds(input.plannedQuestionIds);
  const valid = new Set(rows.filter((q) => q.subject_id === input.subjectId).map((q) => q.id));
  const ordered = input.plannedQuestionIds.filter((id) => valid.has(id));
  if (ordered.length > 0) {
    await this.specialAnswersRepo.ensurePlannedQuestions(sessionId, ordered);
  }
}
```

- [ ] **Step 5: 跑测试**

Run: `cd apps/server && npx vitest run src/database/repositories/special-answer-records.repo.test.ts src/modules/training/training.service.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/database/repositories/special-answer-records.repo.ts apps/server/src/modules/training/
git commit -m "feat(training): 专项判题保存整轮题单（未作答占位行）"
```

---

### Task 4: 重做/自评关闭错题订正分

**Files:**
- Modify: `apps/server/src/modules/training/dto/judge-training.dto.ts`
- Modify: `apps/server/src/modules/training/dto/self-assess.dto.ts`
- Modify: `apps/server/src/modules/training/training.controller.ts:59-113`
- Modify: `apps/server/src/modules/training/training.service.ts:189-227,677-692`
- Modify: `apps/server/src/modules/practice/judge-core.service.ts:130-140,400-413,756-794`
- Test: `apps/server/src/modules/practice/judge-core.service.test.ts`

**Interfaces:**
- Produces: `suppressErrorFixPoints?: boolean` 在判题/自评入参中；`JudgeInput` 同名可选字段。

- [ ] **Step 1: 写失败测试**

`judge-core.service.test.ts` 加：

```ts
it('suppressErrorFixPoints=true：答对清零但不发订正分', async () => {
  const deps = mk({
    questionsRepo: {
      findById: vi.fn().mockResolvedValue({
        id: 10, type: 'choice', answer: 'A',
        options: '[{"label":"A","text":"1","isCorrect":true}]',
      }),
    },
    mainErrorRepo: {
      ...mk().mainErrorRepo,
      clearUnclearedByStudentQuestionId: vi.fn().mockResolvedValue(1),
    },
  });
  const svc = mkSvc(deps);
  const r = await svc.judgeQuestion({
    studentId: 1, subjectId: 1, questionId: 10, studentAnswer: 'A',
    source: 'targeted', suppressErrorFixPoints: true,
  });
  expect(r.isCorrect).toBe(true);
  expect(r.pointsAwarded).toBe(0);
  expect(deps.pointsService.award).not.toHaveBeenCalled();
  expect(deps.mainErrorRepo.clearUnclearedByStudentQuestionId).toHaveBeenCalledWith(1, 10);
});

it('自评对 + suppressErrorFixPoints=true：清零但不发分', async () => {
  const deps = mk();
  deps.mainErrorRepo.clearUnclearedByStudentQuestionId.mockResolvedValue(1);
  const svc = mkSvc(deps);
  await svc.recordSelfAssessment({
    studentId: 1, subjectId: 1, questionId: 10,
    assessment: 'correct', source: 'targeted', suppressErrorFixPoints: true,
  });
  expect(deps.pointsService.award).not.toHaveBeenCalled();
  expect(deps.mainErrorRepo.clearUnclearedByStudentQuestionId).toHaveBeenCalledWith(1, 10);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/practice/judge-core.service.test.ts`
Expected: FAIL（类型不允许字段 / award 仍被调用）。

- [ ] **Step 3: 透传字段**

两个 DTO 加 `suppressErrorFixPoints?: boolean;`；`training.controller.ts` 的 judge/selfAssess 把它原样传给 service（`dto.suppressErrorFixPoints === true`）。

`training.service.ts` 的 `judgeTraining` / `selfAssess` 入参加该字段，并分别透传给 `judgeCore.judgeQuestion` / `judgeCore.recordSelfAssessment`。

- [ ] **Step 4: 关闭发分**

`judge-core.service.ts` 的 `JudgeInput` 加 `suppressErrorFixPoints?: boolean;`。

`judgeQuestion` 答对分支：

```ts
if (input.source !== 'exam' && !input.suppressErrorFixPoints) {
  const award = await this.awardErrorFixOnClear(input.studentId, input.questionId, cleared);
  pointsAwarded = award.pointsAwarded;
  awardReason = award.awardReason;
} else {
  this.trackCleared(input.studentId, input.questionId, cleared);
}
```

`recordSelfAssessment` 入参加字段，答对分支：

```ts
if (input.source !== 'exam' && !input.suppressErrorFixPoints) {
  await this.awardErrorFixOnClear(input.studentId, input.questionId, cleared);
} else {
  this.trackCleared(input.studentId, input.questionId, cleared);
}
```

- [ ] **Step 5: 跑测试**

Run: `cd apps/server && npx vitest run src/modules/practice/judge-core.service.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/modules/training/ apps/server/src/modules/practice/judge-core.service.ts apps/server/src/modules/practice/judge-core.service.test.ts
git commit -m "feat(training): 单题重做关闭错题订正分"
```

---

### Task 5: 重做端点（后端）

**Files:**
- Create: `apps/server/src/modules/training/history-practice.service.ts`
- Modify: `apps/server/src/modules/training/training.module.ts`
- Modify: `apps/server/src/modules/practice-history/practice-history.service.ts`
- Modify: `apps/server/src/modules/practice-history/practice-history.controller.ts`
- Modify: `apps/server/src/modules/practice-history/practice-history.module.ts`
- Test: `apps/server/src/modules/training/history-practice.service.test.ts`（新）
- Test: `apps/server/src/modules/practice-history/practice-history.service.test.ts`

**Interfaces:**
- Produces:
  - `HistoryPracticeService.loadRedoQuestion(questionId: number): Promise<HistoryRunQuestion | null>`
  - `PracticeHistoryService.redo(input: { studentId: number; source: 'exam'|'special'; sessionId: number; questionId: number }): Promise<{ questions: HistoryRunQuestion[]; title: string } | null>`
  - `POST /api/student/practice-history/:source/:sessionId/questions/:questionId/redo`

- [ ] **Step 1: 写失败测试**

`practice-history.service.test.ts` 的 `make()` 追加 `historyPractice` 与 `findAnswersBySession`：

```ts
const historyPractice = {
  loadRedoQuestion: vi.fn().mockResolvedValue(null),
  startSimilar: vi.fn(),
};
const service = new PracticeHistoryService(
  examSessionsRepo as never, specialSessionsRepo as never,
  specialAnswersRepo as never, passagesRepo as never,
  questionsRepo as never, historyPractice as never,
);
return { service, examSessionsRepo, specialSessionsRepo, specialAnswersRepo, passagesRepo, questionsRepo, historyPractice };
```

并给 `examSessionsRepo` 补 `findAnswersBySession: vi.fn().mockResolvedValue([])`。

`history-practice.service.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { HistoryPracticeService } from './history-practice.service.js';

const mkQ = (over: any = {}) => ({
  id: 100, subject_id: 1, type: 'choice', difficulty: 2, content: '题干',
  options: '[{"label":"A","text":"1"}]', answer: 'A', explanation: '解析',
  material_text: null, is_active: 1, ...over,
});

function make() {
  const questionsRepo = {
    findById: vi.fn().mockResolvedValue(mkQ()),
    findKpIdsByQuestionIds: vi.fn().mockResolvedValue(new Map()),
    findRandomByKpTypeDifficulty: vi.fn().mockResolvedValue([]),
    findOrCreate: vi.fn(),
    bindKnowledgePoint: vi.fn(),
  };
  const kpRepo = { findById: vi.fn() };
  const variation = { generate: vi.fn() };
  const trainingSessionsRepo = { create: vi.fn().mockResolvedValue(88) };
  const pointRules = { listTierKeys: vi.fn().mockResolvedValue(['1', '2', '3', '5', '10']) };
  const svc = new HistoryPracticeService(
    questionsRepo as never, kpRepo as never, variation as never,
    trainingSessionsRepo as never, pointRules as never,
  );
  return { svc, questionsRepo, kpRepo, variation, trainingSessionsRepo, pointRules };
}

it('loadRedoQuestion 返回白名单字段，不含答案', async () => {
  const { svc } = make();
  const q = await svc.loadRedoQuestion(100);
  expect(q).toEqual({
    questionId: 100, text: '题干', type: 'choice',
    options: [{ label: 'A', text: '1' }], materialText: null,
  });
});

it('题目下架 / 不存在 -> null', async () => {
  const { svc, questionsRepo } = make();
  questionsRepo.findById.mockResolvedValue(mkQ({ is_active: 0 }));
  await expect(svc.loadRedoQuestion(100)).resolves.toBeNull();
});
```

`practice-history.service.test.ts` 加：

```ts
it('redo：会话/题目归属通过时返回单题 + 标题', async () => {
  h.examSessionsRepo.findByIdOwned.mockResolvedValue(mkExamSession({ title: '期中卷' }));
  h.examSessionsRepo.findAnswersBySession.mockResolvedValue([{ question_id: 100, question_order: 3 }]);
  h.historyPractice.loadRedoQuestion.mockResolvedValue({
    questionId: 100, text: '题干', type: 'choice', options: null, materialText: null,
  });
  const r = await h.service.redo({ studentId: 7, source: 'exam', sessionId: 1, questionId: 100 });
  expect(r?.title).toBe('重做：期中卷 · 第 3 题');
  expect(r?.questions).toHaveLength(1);
});

it('redo：题目不在该会话 -> null（防越权）', async () => {
  h.examSessionsRepo.findByIdOwned.mockResolvedValue(mkExamSession());
  h.examSessionsRepo.findAnswersBySession.mockResolvedValue([{ question_id: 999, question_order: 1 }]);
  await expect(h.service.redo({ studentId: 7, source: 'exam', sessionId: 1, questionId: 100 })).resolves.toBeNull();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/training/history-practice.service.test.ts src/modules/practice-history/practice-history.service.test.ts`
Expected: FAIL（类/方法不存在）。

- [ ] **Step 3: 写 HistoryPracticeService**

```ts
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { QuestionsRepository } from '../../database/repositories/questions.repo.js';
import { KnowledgePointsRepository } from '../../database/repositories/knowledge-points.repo.js';
import { TrainingSessionsRepository } from '../../database/repositories/training-sessions.repo.js';
import { VariationCapability } from '../../ai-core/capabilities/variation.capability.js';
import { PointRulesService } from '../points/point-rules.service.js';
import { parseOptions } from '../../common/utils/parse-options.util.js';
import { targetedTaskCode } from '../../common/subject-config.js';

export interface HistoryRunQuestion {
  questionId: number;
  text: string;
  type: string;
  options: unknown[] | null;
  materialText: string | null;
}

export interface SimilarPracticeResult {
  questions: HistoryRunQuestion[];
  sessionId: number | null;
  title: string;
}

@Injectable()
export class HistoryPracticeService {
  private readonly logger = new Logger(HistoryPracticeService.name);

  constructor(
    private readonly questionsRepo: QuestionsRepository,
    private readonly kpRepo: KnowledgePointsRepository,
    private readonly variation: VariationCapability,
    private readonly trainingSessionsRepo: TrainingSessionsRepository,
    private readonly pointRules: PointRulesService,
  ) {}

  async loadRedoQuestion(questionId: number): Promise<HistoryRunQuestion | null> {
    const q = await this.questionsRepo.findById(questionId);
    if (!q || q.is_active !== 1) return null;
    return {
      questionId: q.id,
      text: q.content,
      type: q.type,
      options: parseOptions(q.options),
      materialText: q.material_text ?? null,
    };
  }

  // startSimilar 在 Task 6 加入
}
```

`PracticeHistoryModule` 加 `imports: [TrainingModule]`；`TrainingModule` 的 `providers` 加 `HistoryPracticeService`、`exports` 加它。

- [ ] **Step 4: 接进 practice-history**

`PracticeHistoryService` 构造函数追加 `historyPractice`，加私有归属查询 + `redo`：

```ts
private async loadSessionQuestion(input: {
  studentId: number; source: 'exam' | 'special'; sessionId: number; questionId: number;
}): Promise<{ subjectId: number; title: string | null; order: number } | null> {
  if (input.source === 'exam') {
    const session = await this.examSessionsRepo.findByIdOwned(input.sessionId, input.studentId);
    if (!session) return null;
    const answers = await this.examSessionsRepo.findAnswersBySession(input.sessionId);
    const row = answers.find((a) => a.question_id === input.questionId);
    if (!row) return null;
    return { subjectId: session.subject_id, title: session.title, order: row.question_order };
  }
  const session = await this.specialSessionsRepo.findByIdOwned(input.sessionId, input.studentId);
  if (!session) return null;
  const rows = await this.specialAnswersRepo.listBySession(input.sessionId);
  const row = rows.find((a) => a.question_id === input.questionId);
  if (!row) return null;
  return { subjectId: session.subject_id, title: session.title, order: row.question_order };
}

async redo(input: {
  studentId: number; source: 'exam' | 'special'; sessionId: number; questionId: number;
}): Promise<{ questions: HistoryRunQuestion[]; title: string } | null> {
  const found = await this.loadSessionQuestion(input);
  if (!found) return null;
  const question = await this.historyPractice.loadRedoQuestion(input.questionId);
  if (!question) throw new BadRequestException('题目已下架');
  return {
    questions: [question],
    title: `重做：${found.title ?? '练习'} · 第 ${found.order} 题`,
  };
}
```

`PracticeHistoryController` 加：

```ts
@Post(':source/:sessionId/questions/:questionId/redo')
async redo(
  @Param('source') source: string,
  @Param('sessionId', ParseIntPipe) sessionId: number,
  @Param('questionId', ParseIntPipe) questionId: number,
  @CurrentUser() user: JwtUser,
) {
  if (source !== 'exam' && source !== 'special') {
    throw new NotFoundException({ code: 1002, message: '记录不存在' });
  }
  const res = await this.service.redo({ studentId: user.sub, source, sessionId, questionId });
  if (!res) throw new NotFoundException({ code: 1002, message: '记录不存在' });
  return res;
}
```

- [ ] **Step 5: 跑测试**

Run: `cd apps/server && npx vitest run src/modules/training/history-practice.service.test.ts src/modules/practice-history/`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/modules/training/history-practice.service.ts apps/server/src/modules/training/training.module.ts apps/server/src/modules/practice-history/
git commit -m "feat(practice-history): 单题重做端点"
```

---

### Task 6: 同类型端点（题库抽题 + 发分）

**Files:**
- Modify: `apps/server/src/modules/training/history-practice.service.ts`
- Modify: `apps/server/src/modules/practice-history/practice-history.service.ts`
- Modify: `apps/server/src/modules/practice-history/practice-history.controller.ts`
- Test: `apps/server/src/modules/training/history-practice.service.test.ts`
- Test: `apps/server/src/modules/practice-history/practice-history.service.test.ts`

**Interfaces:**
- Produces: `HistoryPracticeService.startSimilar({ studentId, subjectId, questionId, count }): Promise<SimilarPracticeResult>`；`POST .../similar`。

- [ ] **Step 1: 写失败测试**

`history-practice.service.test.ts` 加：

```ts
it('同类型：题库抽满 3 题 -> 建 3 题档会话', async () => {
  const { svc, questionsRepo, kpRepo, trainingSessionsRepo } = make();
  questionsRepo.findKpIdsByQuestionIds.mockResolvedValue(new Map([[100, 28]]));
  kpRepo.findById.mockResolvedValue({ id: 28, name: '反比例函数' });
  questionsRepo.findRandomByKpTypeDifficulty
    .mockResolvedValueOnce([{ id: 201, content: '题1', type: 'choice', options: null, material_text: null }])
    .mockResolvedValueOnce([
      { id: 202, content: '题2', type: 'choice', options: null, material_text: null },
      { id: 203, content: '题3', type: 'choice', options: null, material_text: null },
    ]);
  const r = await svc.startSimilar({ studentId: 7, subjectId: 1, questionId: 100, count: 3 });
  expect(r.sessionId).toBe(88);
  expect(r.questions.map((q) => q.questionId)).toEqual([201, 202, 203]);
  expect(trainingSessionsRepo.create).toHaveBeenCalledWith(expect.objectContaining({
    task_code: 'math_targeted', tier_key: '3', expected_count: 3,
  }));
  expect(r.title).toBe('同类练习：反比例函数 · 3 题');
});

it('同类型：实际只有 2 题（请求 5）-> 按 2 题档发分', async () => {
  const { svc, questionsRepo, kpRepo, trainingSessionsRepo } = make();
  questionsRepo.findKpIdsByQuestionIds.mockResolvedValue(new Map([[100, 28]]));
  kpRepo.findById.mockResolvedValue({ id: 28, name: '反比例函数' });
  questionsRepo.findRandomByKpTypeDifficulty
    .mockResolvedValueOnce([{ id: 201, content: '题1', type: 'choice', options: null, material_text: null }])
    .mockResolvedValueOnce([{ id: 202, content: '题2', type: 'choice', options: null, material_text: null }]);
  const r = await svc.startSimilar({ studentId: 7, subjectId: 1, questionId: 100, count: 5 });
  expect(r.questions).toHaveLength(2);
  expect(trainingSessionsRepo.create).toHaveBeenCalledWith(expect.objectContaining({ tier_key: '2' }));
});

it('同类型：0 题 -> 不建会话', async () => {
  const { svc, questionsRepo, kpRepo, trainingSessionsRepo } = make();
  questionsRepo.findKpIdsByQuestionIds.mockResolvedValue(new Map([[100, 28]]));
  kpRepo.findById.mockResolvedValue({ id: 28, name: '反比例函数' });
  questionsRepo.findRandomByKpTypeDifficulty.mockResolvedValue([]);
  const r = await svc.startSimilar({ studentId: 7, subjectId: 1, questionId: 100, count: 3 });
  expect(r.questions).toEqual([]);
  expect(r.sessionId).toBeNull();
  expect(trainingSessionsRepo.create).not.toHaveBeenCalled();
});

it('化学 / 非法题量 -> 400', async () => {
  const { svc } = make();
  await expect(svc.startSimilar({ studentId: 7, subjectId: 5, questionId: 100, count: 3 }))
    .rejects.toBeInstanceOf(BadRequestException);
  await expect(svc.startSimilar({ studentId: 7, subjectId: 1, questionId: 100, count: 4 }))
    .rejects.toBeInstanceOf(BadRequestException);
});
```

`practice-history.service.test.ts` 加：

```ts
it('similar：归属通过后交给 HistoryPracticeService', async () => {
  h.specialSessionsRepo.findByIdOwned.mockResolvedValue(mkSpecialSession({ subject_id: 1 }));
  h.specialAnswersRepo.listBySession.mockResolvedValue([{ question_id: 100, question_order: 1 }]);
  h.historyPractice.startSimilar.mockResolvedValue({ questions: [], sessionId: null, title: '同类练习：X · 0 题' });
  const r = await h.service.similar({ studentId: 7, source: 'special', sessionId: 5, questionId: 100, count: 3 });
  expect(r?.title).toBe('同类练习：X · 0 题');
  expect(h.historyPractice.startSimilar).toHaveBeenCalledWith({ studentId: 7, subjectId: 1, questionId: 100, count: 3 });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/training/history-practice.service.test.ts src/modules/practice-history/practice-history.service.test.ts`
Expected: FAIL（startSimilar 不存在）。

- [ ] **Step 3: 实现 startSimilar**

在 `HistoryPracticeService` 追加：

```ts
async startSimilar(input: {
  studentId: number; subjectId: number; questionId: number; count: number;
}): Promise<SimilarPracticeResult> {
  if (input.subjectId !== 1 && input.subjectId !== 4) {
    throw new BadRequestException('该学科暂不支持同类型练习');
  }
  if (![1, 2, 3, 5].includes(input.count)) {
    throw new BadRequestException('题量仅允许 1 / 2 / 3 / 5');
  }
  const taskCode = targetedTaskCode(input.subjectId);
  const allowed = await this.pointRules.listTierKeys(input.studentId, taskCode);
  if (!allowed.includes(String(input.count))) {
    throw new BadRequestException(`题量仅允许 ${allowed.join(' | ')}`);
  }

  const seed = await this.questionsRepo.findById(input.questionId);
  if (!seed || seed.is_active !== 1) throw new BadRequestException('题目已下架');
  if (seed.subject_id !== input.subjectId) throw new BadRequestException('题目不属于该学科');
  if (!seed.answer) throw new BadRequestException('题目没有标准答案');
  const kpId = (await this.questionsRepo.findKpIdsByQuestionIds([seed.id])).get(seed.id);
  if (kpId == null) throw new BadRequestException('题目没有知识点');
  const kp = await this.kpRepo.findById(kpId);
  if (!kp) throw new BadRequestException('知识点不存在');

  const picked = await this.questionsRepo.findRandomByKpTypeDifficulty(
    input.studentId, input.subjectId, kpId, seed.type,
    [toDifficulty(seed.difficulty)], input.count, [seed.id],
  );
  let selected: HistoryRunQuestion[] = picked.map((q) => this.toRunQuestion(q));

  if (selected.length < input.count) {
    const ladder = [...new Set(
      [seed.difficulty - 1, seed.difficulty, seed.difficulty + 1]
        .filter((d) => d >= 1 && d <= 3)
        .map((d) => toDifficulty(d)),
    )];
    const more = await this.questionsRepo.findRandomByKpTypeDifficulty(
      input.studentId, input.subjectId, kpId, seed.type, ladder,
      input.count - selected.length,
      [seed.id, ...picked.map((q) => q.id)],
    );
    selected = [...selected, ...more.map((q) => this.toRunQuestion(q))];
  }

  const actual = selected.length;
  if (actual === 0) {
    return { questions: [], sessionId: null, title: `同类练习：${kp.name} · 0 题` };
  }

  const allowedCounts = [1, 2, 3, 5].filter((n) => allowed.includes(String(n)));
  const tier = allowedCounts.filter((n) => n <= actual).sort((a, b) => b - a)[0];
  let sessionId: number | null = null;
  if (tier != null) {
    try {
      sessionId = await this.trainingSessionsRepo.create({
        student_id: input.studentId,
        task_code: taskCode,
        subject_id: input.subjectId,
        tier_key: String(tier),
        expected_count: actual,
        ref_type: 'question',
        ref_id: null,
      });
    } catch (err) {
      this.logger.warn(
        `training_sessions.create failed (history similar, student=${input.studentId}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { questions: selected, sessionId, title: `同类练习：${kp.name} · ${actual} 题` };
}

private toRunQuestion(q: {
  id: number; content: string; type: string; options: string | null; material_text: string | null;
}): HistoryRunQuestion {
  return {
    questionId: q.id,
    text: q.content,
    type: q.type,
    options: parseOptions(q.options),
    materialText: q.material_text ?? null,
  };
}
```

顶部补 import：`toDifficulty` 来自 `./variation-question.util.js`；`BadRequestException` 已引入。

- [ ] **Step 4: 接进 practice-history + controller**

`PracticeHistoryService.similar`：

```ts
async similar(input: {
  studentId: number; source: 'exam' | 'special'; sessionId: number; questionId: number; count: number;
}): Promise<SimilarPracticeResult | null> {
  const found = await this.loadSessionQuestion(input);
  if (!found) return null;
  return this.historyPractice.startSimilar({
    studentId: input.studentId,
    subjectId: found.subjectId,
    questionId: input.questionId,
    count: input.count,
  });
}
```

`PracticeHistoryController`：

```ts
@Post(':source/:sessionId/questions/:questionId/similar')
async similar(
  @Param('source') source: string,
  @Param('sessionId', ParseIntPipe) sessionId: number,
  @Param('questionId', ParseIntPipe) questionId: number,
  @Body() body: { count?: number },
  @CurrentUser() user: JwtUser,
) {
  if (source !== 'exam' && source !== 'special') {
    throw new NotFoundException({ code: 1002, message: '记录不存在' });
  }
  const res = await this.service.similar({
    studentId: user.sub, source, sessionId, questionId, count: Number(body?.count),
  });
  if (!res) throw new NotFoundException({ code: 1002, message: '记录不存在' });
  return res;
}
```

- [ ] **Step 5: 跑测试**

Run: `cd apps/server && npx vitest run src/modules/training/history-practice.service.test.ts src/modules/practice-history/`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/modules/training/history-practice.service.ts apps/server/src/modules/practice-history/
git commit -m "feat(practice-history): 同类型练习端点（题库抽题 + 档位发分）"
```

---

### Task 7: AI 补题 + 物理 prompt

**Files:**
- Modify: `apps/server/src/ai-core/types.ts:565-570`
- Modify: `apps/server/src/ai-core/capabilities/variation.capability.ts`
- Modify: `apps/server/src/ai-core/infra/prompt-builder.ts:84-86`
- Modify: `apps/server/src/ai-core/model-routes.yaml:160-163`
- Create: `apps/server/src/ai-core/prompts/variation/physics.md`
- Modify: `apps/server/src/modules/training/variation-question.util.ts`
- Modify: `apps/server/src/modules/training/history-practice.service.ts`
- Test: `apps/server/src/modules/training/variation-question.util.test.ts`（新）
- Test: `apps/server/src/modules/training/history-practice.service.test.ts`

**Interfaces:**
- Produces: `VariationRequest.subject?: 'math' | 'physics'`、`timeoutMs?: number`；`toStoredAnswer` / `variationRejectionReason` 支持 `multi_choice`。

- [ ] **Step 1: 写失败测试**

`variation-question.util.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { toStoredAnswer, variationRejectionReason } from './variation-question.util.js';

describe('multi_choice 归一与校验', () => {
  const opts = [
    { label: 'A', text: '甲', isCorrect: false },
    { label: 'B', text: '乙', isCorrect: true },
    { label: 'D', text: '丁', isCorrect: true },
  ];
  it('答案按正确 label 集合排序拼接', () => {
    expect(toStoredAnswer({ content: 'x', answer: 'DB', explanation: '', difficulty: 2, variationType: '换数', options: opts }, 'multi_choice'))
      .toBe('BD');
  });
  it('答案与正确项不一致 -> 拒绝', () => {
    expect(variationRejectionReason(
      { content: 'x', answer: 'AB', explanation: '', difficulty: 2, variationType: '换数', options: opts },
      'multi_choice',
    )).toContain('不一致');
  });
  it('至少一个正确项', () => {
    expect(variationRejectionReason(
      { content: 'x', answer: 'A', explanation: '', difficulty: 2, variationType: '换数', options: opts.map((o) => ({ ...o, isCorrect: false })) },
      'multi_choice',
    )).toContain('至少');
  });
});
```

`history-practice.service.test.ts` 加 AI 用例（mock `variation.generate` 返回 2 道，`findOrCreate` 返回新 id）：

```ts
it('题库不够时 AI 补题并入库（source=history_practice）', async () => {
  const { svc, questionsRepo, kpRepo, variation } = make();
  questionsRepo.findKpIdsByQuestionIds.mockResolvedValue(new Map([[100, 28]]));
  kpRepo.findById.mockResolvedValue({ id: 28, name: '反比例函数' });
  questionsRepo.findRandomByKpTypeDifficulty.mockResolvedValue([]);
  variation.generate.mockResolvedValue({
    variations: [
      { content: 'AI题1', answer: 'B', explanation: '解析', difficulty: 2, variationType: '换数', options: [{ label: 'A', text: '1', isCorrect: false }, { label: 'B', text: '2', isCorrect: true }] },
      { content: 'AI题2', answer: 'A', explanation: '解析', difficulty: 2, variationType: '换数', options: [{ label: 'A', text: '1', isCorrect: true }, { label: 'B', text: '2', isCorrect: false }] },
    ],
  });
  questionsRepo.findOrCreate
    .mockResolvedValueOnce({ id: 301, created: true })
    .mockResolvedValueOnce({ id: 302, created: true });
  const r = await svc.startSimilar({ studentId: 7, subjectId: 1, questionId: 100, count: 2 });
  expect(r.questions.map((q) => q.questionId)).toEqual([301, 302]);
  expect(questionsRepo.findOrCreate).toHaveBeenCalledWith(expect.objectContaining({
    source: 'history_practice', subject_id: 1,
  }));
  expect(questionsRepo.bindKnowledgePoint).toHaveBeenCalledWith(301, 28, 'primary');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/training/variation-question.util.test.ts src/modules/training/history-practice.service.test.ts`
Expected: FAIL。

- [ ] **Step 3: 扩展变式能力**

`ai-core/types.ts`：

```ts
export interface VariationRequest {
  originalQuestion: { content: string; answer?: string; difficulty?: Difficulty };
  knowledgePoint: { id: string; name: string };
  count: number;
  targetDifficulty?: Difficulty;
  /** 2026-11-06：变式生成按学科选 prompt/路由（默认数学，现有调用方不变）。 */
  subject?: 'math' | 'physics';
  /** 2026-11-06：本次调用的硬上限（毫秒），不传走 retry.yaml 的 variation 超时。 */
  timeoutMs?: number;
}
```

`variation.capability.ts`：

```ts
const subject = request.subject ?? 'math';
const routeResult = this.modelRouter.route({ scene: 'variation', subject });
...
subject,
...
timeout: request.timeoutMs ?? timeoutConfig.timeout.variation ?? timeoutConfig.timeout.default,
```

`prompt-builder.ts`：

```ts
if (capability === 'variation') {
  return subject === 'math' ? 'variation/generate.md' : `variation/${subject}.md`;
}
```

`model-routes.yaml` 的 `variation` 段加：

```yaml
    - subject: physics
      primary: qwen3.8-max
      fallback: gemini-3.1-pro
```

> 部署时还要在管理端「模型管理」/DB 里确认 `variation + physics` 路由存在——模型配置真源在 DB，YAML 只在库空时兜底。

- [ ] **Step 4: 写物理 prompt**

`prompts/variation/physics.md`：

```markdown
---
version: "1.0"
description: "物理变式题生成"
---

## System Prompt

你是一位经验丰富的初中物理命题专家，请基于以下原题生成变式题。

### 变式规则
1. **保持知识点不变**：考查完全相同或高度相关的物理知识点
2. **难度匹配**：目标难度为{{difficulty}}（1=易 2=中 3=难）
3. **变式方式**（可组合）：换数（改数值）、换场景（改生活情境）、调整条件（改已知/未知）
4. **物理自洽**：单位正确、有效数字合理、题目有解，不得出现违背物理规律的情境
5. **选择题**：4 个选项，恰有 1 个正确项；**多选题**：4 个选项，至少 1 个正确项，答案用正确项 label 字母拼接（如 `BD`）
6. **不照抄原题**：题干必须与原题不同

### 输出格式
严格输出 JSON（{{count}} 道变式题）：
{
  "variations": [
    {
      "content": "题干（支持 LaTeX 公式，用 $...$）",
      "options": [
        { "label": "A", "text": "...", "isCorrect": false },
        { "label": "B", "text": "...", "isCorrect": true }
      ],
      "answer": "标准答案（多选题写正确项字母）",
      "explanation": "解析（步骤清晰，带单位）",
      "difficulty": 1,
      "variationType": "换数" | "换场景" | "调整条件" | "组合",
      "knowledgePoints": ["知识点1"]
    }
  ]
}

---

## User Message

**原题**：{{question.content}}
**标准答案**：{{question.answer}}
**目标知识点**：{{knowledgePoint.name}}
**生成数量**：{{count}} 道
**目标难度**：{{difficulty}}
```

- [ ] **Step 5: multi_choice 归一/校验**

`variation-question.util.ts`：

```ts
export function toStoredAnswer(v: VariationQuestion, type: string): string {
  if (type === 'multi_choice') {
    const correct = (v.options ?? []).filter((o) => o.isCorrect === true).map((o) => o.label);
    return correct.length > 0 ? [...correct].sort().join('') : v.answer;
  }
  if (type !== 'choice') return v.answer;
  const correct = (v.options ?? []).find((o) => o.isCorrect === true);
  return correct?.label ?? v.answer;
}
```

`variationRejectionReason` 在 `if (type === 'choice')` 前加：

```ts
if (type === 'multi_choice') {
  if (!Array.isArray(v.options) || v.options.length < 2) {
    return `multi_choice 选项不足 2 个（实际 ${v.options?.length ?? 0}）`;
  }
  const correct = v.options.filter((o) => o.isCorrect === true);
  if (correct.length < 1) return 'multi_choice 至少需要 1 个正确选项';
  const labels = correct.map((o) => o.label).sort().join('');
  if (!compareAnswer(v.answer, labels, JSON.stringify(v.options), 'multi_choice')) {
    return `multi_choice 答案与正确选项不一致（answer=${v.answer}，正确项 ${labels}）`;
  }
  return null;
}
```

- [ ] **Step 6: AI 补题接进 startSimilar**

在 Task 6 的 `startSimilar` 里，题库第二轮之后加：

```ts
if (selected.length < input.count) {
  const shortfall = input.count - selected.length;
  const subject = input.subjectId === 4 ? 'physics' as const : 'math' as const;
  const aiPromise = this.variation.generate({
    subject,
    originalQuestion: {
      content: seed.content,
      answer: seed.answer,
      difficulty: toDifficulty(seed.difficulty),
    },
    knowledgePoint: { id: String(kpId), name: kp.name },
    count: shortfall,
    targetDifficulty: toDifficulty(seed.difficulty),
    timeoutMs: 20000,
  }).catch((err) => {
    this.logger.warn(
      `history similar AI fill failed (student=${input.studentId}, kp=${kpId}): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  });

  let timer: NodeJS.Timeout;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), 20000);
    timer.unref?.();
  });
  const ai = await Promise.race([aiPromise, timedOut]);
  clearTimeout(timer!);

  const seen = new Set<number>(selected.map((q) => q.questionId));
  for (const v of ai?.variations ?? []) {
    const reason = variationRejectionReason(v, seed.type);
    if (reason) {
      this.logger.warn(`history similar variation rejected (kp=${kpId}): ${reason}`);
      continue;
    }
    const { id, created } = await this.questionsRepo.findOrCreate({
      subject_id: input.subjectId,
      type: seed.type,
      difficulty: seed.difficulty,
      content: v.content,
      options: v.options ? JSON.stringify(v.options.map(({ label, text }) => ({ label, text }))) : null,
      answer: toStoredAnswer(v, seed.type),
      explanation: v.explanation,
      source: 'history_practice',
      content_hash: computeContentHash(v.content),
    });
    if (seen.has(id)) continue;
    if (created) await this.questionsRepo.bindKnowledgePoint(id, kpId, 'primary');
    seen.add(id);
    selected.push({
      questionId: id,
      text: v.content,
      type: seed.type,
      options: v.options?.map(({ label, text }) => ({ label, text })) ?? null,
      materialText: null,
    });
  }
}
```

补 import：`computeContentHash`、`toStoredAnswer`、`variationRejectionReason`。

- [ ] **Step 7: 跑测试**

Run: `cd apps/server && npx vitest run src/modules/training/variation-question.util.test.ts src/modules/training/history-practice.service.test.ts`
Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add apps/server/src/ai-core/ apps/server/src/modules/training/
git commit -m "feat(training): 同类型练习 AI 补题 + 物理变式 prompt"
```

---

### Task 8: 前端详情页（按钮 / 面板 / 未作答徽章）

**Files:**
- Modify: `apps/web/src/services/api.ts:3505-3552`
- Modify: `apps/web/src/pages/student/PracticeHistoryDetailPage.tsx`
- Test: `apps/web/src/pages/student/PracticeHistoryDetailPage.test.tsx`

**Interfaces:**
- Consumes: `GET /student/practice-history/:source/:sessionId` 的 `canRedo/canSimilar`；`getMyPointRules()`。
- Produces: `redoPractice(source, sessionId, questionId)`、`startSimilarPractice(source, sessionId, questionId, count)`。

- [ ] **Step 1: 写失败测试**

`PracticeHistoryDetailPage.test.tsx` 的 mock 增加三个函数：

```ts
vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    getPracticeHistoryDetail: vi.fn(),
    getMyPointRules: vi.fn(),
    redoPractice: vi.fn(),
    startSimilarPractice: vi.fn(),
  };
});
```

加用例：

```ts
it('未作答且可重做：显示「未作答」+ 重做 / 同类型按钮', async () => {
  getDetailMock.mockResolvedValue({
    session: { ...EXAM_SESSION, subjectId: 1 },
    questions: [{
      questionId: 100, questionOrder: 1, answerText: null, isCorrect: null, score: null,
      method: 'unanswered', analysis: null, judgedAt: null, materialText: null,
      questionContent: '题干', questionAnswer: 'A', questionAnalysis: null,
      refType: 'question', refId: null, sentenceIndex: null,
      passageTitle: null, passageSentence: null,
      canRedo: true, canSimilar: true,
    }],
  });
  getMyPointRulesMock.mockResolvedValue({
    tasks: [{ taskCode: 'math_targeted', taskName: '数学专项', tiers: [
      { tierKey: '1', tierLabel: '1 题', points: 2, dailyLimit: 5, isActive: true, completedToday: 0, remainingToday: 5 },
      { tierKey: '2', tierLabel: '2 题', points: 5, dailyLimit: 5, isActive: true, completedToday: 0, remainingToday: 5 },
      { tierKey: '3', tierLabel: '3 题', points: 8, dailyLimit: 5, isActive: true, completedToday: 0, remainingToday: 5 },
      { tierKey: '5', tierLabel: '5 题', points: 15, dailyLimit: 5, isActive: true, completedToday: 0, remainingToday: 5 },
    ] }],
  });

  renderAt('exam', '1');
  expect(await screen.findByText('未作答')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '重做' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '同类型练习' })).toBeInTheDocument();
});

it('canRedo/canSimilar 为 false 时不渲染按钮', async () => {
  getDetailMock.mockResolvedValue({
    session: EXAM_SESSION,
    questions: [{
      questionId: 100, questionOrder: 1, answerText: 'B', isCorrect: false, score: 0,
      method: 'exact', analysis: null, judgedAt: null, materialText: null,
      questionContent: '第1题题面', questionAnswer: 'A', questionAnalysis: null,
      refType: 'question', refId: null, sentenceIndex: null,
      passageTitle: null, passageSentence: null,
      canRedo: false, canSimilar: false,
    }],
  });
  renderAt('exam', '1');
  expect(await screen.findByText('第1题题面')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '重做' })).toBeNull();
  expect(screen.queryByRole('button', { name: '同类型练习' })).toBeNull();
});
```

（现有所有旧题 fixture 都要补 `canRedo: false, canSimilar: false`，否则 TS 报错；上面的第一版未作答用例用 `canRedo: true, canSimilar: true`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/student/PracticeHistoryDetailPage.test.tsx`
Expected: FAIL。

- [ ] **Step 3: 加 API**

`api.ts`：

```ts
export interface PracticeHistoryQuestion {
  // ...现有字段
  canRedo: boolean;
  canSimilar: boolean;
}

export function redoPractice(
  source: 'exam' | 'special', sessionId: number, questionId: number,
): Promise<{ questions: TargetedPracticeQuestion[]; title: string }> {
  return fetchApi(`/student/practice-history/${source}/${sessionId}/questions/${questionId}/redo`, {
    method: 'POST',
  });
}

export function startSimilarPractice(
  source: 'exam' | 'special', sessionId: number, questionId: number, count: number,
): Promise<{ questions: TargetedPracticeQuestion[]; sessionId: number | null; title: string }> {
  return fetchApi(`/student/practice-history/${source}/${sessionId}/questions/${questionId}/similar`, {
    method: 'POST',
    body: JSON.stringify({ count }),
  });
}
```

- [ ] **Step 4: 改详情页**

`StatusBadge` 增加 `answered`：

```tsx
function StatusBadge({ isCorrect, answered }: { isCorrect: boolean | null; answered: boolean }) {
  if (!answered) {
    return (
      <span className="inline-flex items-center rounded-[var(--radius-pill)] bg-[var(--bg-subtle)] px-2 py-0.5 text-xs text-[var(--warning)]">
        未作答
      </span>
    );
  }
  // ...现有三态
}
```

`QuestionCard` 加 props：

```tsx
function QuestionCard({
  q,
  similarCounts,
  onRedo,
  onSimilar,
}: {
  q: PracticeHistoryQuestion;
  similarCounts: number[];
  onRedo: (q: PracticeHistoryQuestion) => Promise<void>;
  onSimilar: (q: PracticeHistoryQuestion, count: number) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const answered = q.method !== 'unanswered' && q.answerText != null;
  // ...
  return (
    <li ...>
      <div className="mb-3 flex items-center gap-2">
        <span className="text-sm text-[var(--text-tertiary)]">{`第 ${q.questionOrder} 题`}</span>
        <StatusBadge isCorrect={q.isCorrect} answered={answered} />
        {(q.canRedo || (q.canSimilar && similarCounts.length > 0)) && (
          <div className="ml-auto flex items-center gap-1">
            {q.canRedo && (
              <button
                type="button"
                disabled={busy}
                onClick={() => { setBusy(true); void onRedo(q).finally(() => setBusy(false)); }}
                className="inline-flex h-8 items-center gap-1 rounded-[var(--radius-button)] px-2 text-sm font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-subtle)] disabled:opacity-50"
              >
                <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 4 3 9 8 9"/></svg>
                重做
              </button>
            )}
            {q.canSimilar && similarCounts.length > 0 && (
              <div className="relative">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setOpen((v) => !v)}
                  className="inline-flex h-8 items-center gap-1 rounded-[var(--radius-button)] px-2 text-sm font-semibold text-[var(--brand-500)] hover:bg-[var(--brand-100)] disabled:opacity-50"
                >
                  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>
                  同类型练习
                </button>
                {open && (
                  <div className="absolute right-0 top-9 z-10 w-[236px] rounded-[var(--radius-md)] border border-[var(--bg-subtle)] bg-[var(--bg-card)] p-3 shadow-[var(--shadow-card)]">
                    <p className="mb-2 text-xs text-[var(--text-tertiary)]">练几题</p>
                    <div className="flex gap-1.5">
                      {similarCounts.map((n) => (
                        <button
                          key={n}
                          type="button"
                          disabled={busy}
                          onClick={() => { setOpen(false); setBusy(true); void onSimilar(q, n).finally(() => setBusy(false)); }}
                          className="h-8 flex-1 rounded-lg border border-[var(--bg-subtle)] text-sm font-semibold text-[var(--text-secondary)] hover:border-[var(--brand-500)] hover:text-[var(--brand-500)] disabled:opacity-50"
                        >
                          {n}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      {/* 其余题面/答案/解析不变 */}
    </li>
  );
}
```

页面里：

```tsx
const [similarCounts, setSimilarCounts] = useState<number[]>([]);

useEffect(() => {
  if (!data) return;
  const subjectId = data.session.subjectId;
  if (subjectId !== 1 && subjectId !== 4) { setSimilarCounts([]); return; }
  if (!data.questions.some((q) => q.canSimilar)) { setSimilarCounts([]); return; }
  let cancelled = false;
  getMyPointRules()
    .then((rules) => {
      const code = subjectId === 4 ? 'physics_targeted' : 'math_targeted';
      const tiers = rules.tasks.find((t) => t.taskCode === code)?.tiers ?? [];
      const allowed = new Set(tiers.filter((t) => t.isActive).map((t) => t.tierKey));
      if (!cancelled) setSimilarCounts([1, 2, 3, 5].filter((n) => allowed.has(String(n))));
    })
    .catch(() => { if (!cancelled) setSimilarCounts([]); });
  return () => { cancelled = true; };
}, [data]);

async function handleRedo(q: PracticeHistoryQuestion) {
  if (!data || q.questionId == null) return;
  try {
    const res = await redoPractice(data.session.source, data.session.sessionId, q.questionId);
    sessionStorage.setItem('training:targeted', JSON.stringify({
      sessionId: null, questions: res.questions, title: res.title, mode: 'redo',
    }));
    const returnTo = `/student/practice-history/${data.session.source}/${data.session.sessionId}`;
    navigate(`/student/training/targeted/run?subjectId=${data.session.subjectId}&returnTo=${encodeURIComponent(returnTo)}`);
  } catch {
    toast('error', '重做暂时不可用，请稍后再试');
  }
}

async function handleSimilar(q: PracticeHistoryQuestion, count: number) {
  if (!data || q.questionId == null) return;
  try {
    const res = await startSimilarPractice(data.session.source, data.session.sessionId, q.questionId, count);
    if (res.questions.length === 0) { toast('info', '暂时没有同类题'); return; }
    sessionStorage.setItem('training:targeted', JSON.stringify({
      sessionId: res.sessionId, questions: res.questions, title: res.title, mode: 'similar',
    }));
    const returnTo = `/student/practice-history/${data.session.source}/${data.session.sessionId}`;
    navigate(`/student/training/targeted/run?subjectId=${data.session.subjectId}&returnTo=${encodeURIComponent(returnTo)}`);
  } catch {
    toast('error', '暂时没有同类题，请稍后再试');
  }
}
```

页面渲染改为 `<QuestionCard q={q} similarCounts={similarCounts} onRedo={handleRedo} onSimilar={handleSimilar} />`；imports 补 `useNavigate`、`getMyPointRules`、`redoPractice`、`startSimilarPractice`、`toast`。

- [ ] **Step 5: 跑测试**

Run: `cd apps/web && npx vitest run src/pages/student/PracticeHistoryDetailPage.test.tsx`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/services/api.ts apps/web/src/pages/student/PracticeHistoryDetailPage.tsx apps/web/src/pages/student/PracticeHistoryDetailPage.test.tsx
git commit -m "feat(web): 练习记录详情单题重做/同类型入口"
```

---

### Task 9: 答题页复用（两模式 / 题号 / returnTo）

**Files:**
- Modify: `apps/web/src/pages/student/training/run-handoff.ts`
- Modify: `apps/web/src/pages/student/training/TargetedRunPage.tsx`
- Modify: `apps/web/src/services/api.ts:946-970,1002-1013`
- Test: `apps/web/src/pages/student/training/run-handoff.test.ts`
- Test: `apps/web/src/pages/student/training/TargetedRunPage.test.tsx`

**Interfaces:**
- Consumes: 交接体 `{sessionId, questions, title?, mode?}`；URL `?subjectId=&returnTo=`。
- Produces: redo 判题带 `suppressErrorFixPoints: true`；similar/targeted 带 `plannedQuestionIds` + `sessionUid`。

- [ ] **Step 1: 写失败测试**

`run-handoff.test.ts` 加：

```ts
it('可选 title/mode 原样返回', () => {
  const parsed = parseRunHandoff(JSON.stringify({
    sessionId: null, questions: [], title: '重做：卷 · 第 1 题', mode: 'redo',
  }));
  expect(parsed).toEqual({
    sessionId: null, questions: [], title: '重做：卷 · 第 1 题', mode: 'redo',
  });
});
it('非法 mode -> null', () => {
  expect(parseRunHandoff(JSON.stringify({ sessionId: 1, questions: [], mode: 'x' }))).toBeNull();
});
```

`TargetedRunPage.test.tsx` 加用例（复用该文件已有的 `answerOnlyQuestion()` 辅助；它点选 B 后点「提交」并等结果页）：

```ts
it('redo 模式：judge 带 suppressErrorFixPoints，不带 sessionUid/sessionId/plannedQuestionIds', async () => {
  sessionStorage.setItem(KEY, JSON.stringify({
    sessionId: null, questions: [QUESTION], mode: 'redo', title: '重做：卷 · 第 1 题',
  }));
  judgeMock.mockResolvedValue(JUDGED);
  await answerOnlyQuestion();
  expect(judgeMock).toHaveBeenCalledWith(expect.objectContaining({
    suppressErrorFixPoints: true,
    questionOrder: 1,
  }));
  const arg = judgeMock.mock.calls[0][0];
  expect(arg.sessionId).toBeUndefined();
  expect(arg.sessionUid).toBeUndefined();
  expect(arg.plannedQuestionIds).toBeUndefined();
});

it('similar 模式：judge 带 plannedQuestionIds 与真实题号', async () => {
  seed(88);
  judgeMock.mockResolvedValue(JUDGED);
  await answerOnlyQuestion();
  expect(judgeMock).toHaveBeenCalledWith(expect.objectContaining({
    sessionId: 88, plannedQuestionIds: [101], questionOrder: 1,
  }));
  expect(typeof judgeMock.mock.calls[0][0].sessionUid).toBe('string');
});
```

（结果页文案「答题结果」由 `AnswerResultList` 提供，与现有用例一致。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/student/training/run-handoff.test.ts src/pages/student/training/TargetedRunPage.test.tsx`
Expected: FAIL。

- [ ] **Step 3: 扩展交接体**

`run-handoff.ts`：

```ts
export interface TargetedRunHandoff {
  sessionId: number | null;
  questions: TargetedPracticeQuestion[];
  title?: string;
  mode?: 'similar' | 'redo';
}

export function parseRunHandoff<T>(raw: string | null): {
  sessionId: number | null; questions: T[]; title?: string; mode?: 'similar' | 'redo';
} | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
    const { sessionId, questions, title, mode } = value as {
      sessionId?: unknown; questions?: unknown; title?: unknown; mode?: unknown;
    };
    if (sessionId !== null && typeof sessionId !== 'number') return null;
    if (!Array.isArray(questions)) return null;
    if (title !== undefined && typeof title !== 'string') return null;
    if (mode !== undefined && mode !== 'similar' && mode !== 'redo') return null;
    return {
      sessionId, questions: questions as T[],
      ...(title !== undefined ? { title } : {}),
      ...(mode !== undefined ? { mode } : {}),
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 改答题页**

`TargetedRunPage.tsx`：

- 状态加 `const [mode, setMode] = useState<'similar' | 'redo'>('similar');`、`const [runTitle, setRunTitle] = useState<string | null>(null);`
- mount 读交接体时：`setMode(handoff?.mode ?? 'similar'); setRunTitle(handoff?.title ?? null);`
- 发分 hook：`useSessionPointsCompletion(sessionId, runTitle ?? \`${subjectName(subjectId)}专项 · ${entries?.length ?? 0} 题\`)`。
- 题号映射：

```ts
const orderByQuestionId = useMemo(() => {
  const m = new Map<string, number>();
  (entries ?? []).forEach((e, i) => m.set(String(e.questionId), i + 1));
  return m;
}, [entries]);
```

- `handleSubmit` 改成：

```ts
return judgeTraining({
  questionId: entry.questionId,
  subjectId,
  studentAnswer: answer,
  source: 'targeted',
  ...(sessionId != null ? { sessionId } : {}),
  ...(mode === 'redo'
    ? { suppressErrorFixPoints: true }
    : {
        sessionUid,
        title: runTitle ?? `${subjectName(subjectId)}专项练习`,
        questionCount: questions.length,
        plannedQuestionIds: (entries ?? []).map((e) => e.questionId),
      }),
  questionOrder: orderByQuestionId.get(q.n) ?? 1,
});
```

- `onSelfAssess` 的 `selfAssessTraining` 加 `suppressErrorFixPoints: mode === 'redo'`。
- URL 回跳：

```ts
const returnToRaw = searchParams.get('returnTo');
const returnTo = returnToRaw && returnToRaw.startsWith('/student/practice-history/') ? returnToRaw : null;
const exitTarget = returnTo ?? `/student/training/targeted${subjectQuery}`;
```

把结果页 `onClose`、退出确认 `navigate(...)`、空题单 redirect 全部改用 `exitTarget`。

- `api.ts` 的 `judgeTraining` 入参加 `suppressErrorFixPoints?: boolean; plannedQuestionIds?: number[];`；`selfAssessTraining` 入参加 `suppressErrorFixPoints?: boolean;`。

- [ ] **Step 5: 跑测试**

Run: `cd apps/web && npx vitest run src/pages/student/training/run-handoff.test.ts src/pages/student/training/TargetedRunPage.test.tsx`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/pages/student/training/ apps/web/src/services/api.ts
git commit -m "feat(web): 答题页支持重做/同类型两种模式"
```

---

### Task 10: 文档同步 + 全量验收

**Files:**
- Modify: `docs/API接口与数据流设计文档.md`（§4.29 + `/training/judge` + `/training/self-assess`）
- Modify: `docs/api/openapi.yaml`
- Modify: `docs/ai-core-changelog.md`

- [ ] **Step 1: 更新 API 文档 §4.29**

在端点表加两行（POST 默认 201）：

```markdown
| 3 | `POST /api/student/practice-history/:source/:sessionId/questions/:questionId/redo` | 单题重做：返回 `{questions:[{questionId,text,type,options,materialText}], title}`；不建会话、不发分 |
| 4 | `POST /api/student/practice-history/:source/:sessionId/questions/:questionId/similar` | 同类型练习：body `{count:1|2|3|5}`；返回 `{questions:[...], sessionId, title}`；0 题时 `questions:[]`、`sessionId:null` |
```

详情响应说明加 `canRedo` / `canSimilar`。`/training/judge` 与 `/training/self-assess` 的请求体加 `suppressErrorFixPoints?`；judge 再加 `plannedQuestionIds?`，并说明「重做不建会话、仅关闭订正分」。

- [ ] **Step 2: 更新 openapi**

`/student/practice-history/{source}/{sessionId}` 下加两个 post 路径（参数同现有 source/sessionId + questionId；请求体/响应 schema 直接内联）：

```yaml
  /student/practice-history/{source}/{sessionId}/questions/{questionId}/redo:
    post:
      tags: [PracticeHistory]
      summary: 单题重做（不落记录、不发分）
      operationId: redoPractice
      security: [{ bearerAuth: [] }]
      parameters:
        - { name: source, in: path, required: true, schema: { type: string, enum: [exam, special] } }
        - { name: sessionId, in: path, required: true, schema: { type: integer, minimum: 1 } }
        - { name: questionId, in: path, required: true, schema: { type: integer, minimum: 1 } }
      responses:
        '201':
          description: 单题运行数据
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/CommonResponse'
                  - type: object
                    properties:
                      data:
                        type: object
                        properties:
                          title: { type: string }
                          questions:
                            type: array
                            items: { $ref: '#/components/schemas/HistoryRunQuestion' }
        '404': { description: 记录或题目不属于当前学生（code=1002） }
        '400': { description: 题目已下架 }

  /student/practice-history/{source}/{sessionId}/questions/{questionId}/similar:
    post:
      tags: [PracticeHistory]
      summary: 同类型练习（落专项记录、按实际题数发档位分）
      operationId: startSimilarPractice
      security: [{ bearerAuth: [] }]
      parameters:
        - { name: source, in: path, required: true, schema: { type: string, enum: [exam, special] } }
        - { name: sessionId, in: path, required: true, schema: { type: integer, minimum: 1 } }
        - { name: questionId, in: path, required: true, schema: { type: integer, minimum: 1 } }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [count]
              properties:
                count: { type: integer, enum: [1, 2, 3, 5] }
      responses:
        '201':
          description: 同类型题单
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/CommonResponse'
                  - type: object
                    properties:
                      data:
                        type: object
                        properties:
                          title: { type: string }
                          sessionId: { type: integer, nullable: true }
                          questions:
                            type: array
                            items: { $ref: '#/components/schemas/HistoryRunQuestion' }
        '400': { description: 题量非法 / 学科不支持 / 无知识点或无答案 }
        '404': { description: 记录或题目不属于当前学生（code=1002） }
```

在 `components/schemas` 加：

```yaml
    HistoryRunQuestion:
      type: object
      properties:
        questionId: { type: integer }
        text: { type: string }
        type: { type: string }
        options:
          type: array
          nullable: true
          items: { type: object }
        materialText: { type: string, nullable: true }
      required: [questionId, text, type]
```

`PracticeHistoryQuestion` 加 `canRedo: { type: boolean }`、`canSimilar: { type: boolean }`，required 里加这两个；`TrainingJudgeRequest` 加 `suppressErrorFixPoints: { type: boolean }`、`plannedQuestionIds: { type: array, items: { type: integer } }`；`TrainingSelfAssessRequest` 加 `suppressErrorFixPoints: { type: boolean }`。

- [ ] **Step 3: changelog**

`docs/ai-core-changelog.md` 顶部加：

```markdown
## 2026-11-06 练习记录：单题重做与同类型练习

- 练习记录详情每题右上角新增「重做」「同类型练习」；重做单题、不落记录、不发分（错题本仍更新，关闭订正分）；同类型按 KP+题型+难度±1 出 1/2/3/5 题，题库优先、AI 补缺，落专项记录并按实际题数发档位分。
- 数理化专项开练保存整轮题单（`special_answer_records` 占位行），未作答的题在历史可见；修复专项答题页把 questionId 当题号的既有 bug。
- 同类型本期开数学/物理；新增 2 题档（5 分）与幂等迁移；新增物理变式 prompt 与 multi_choice 答案归一。
```

- [ ] **Step 4: 全量验证**

```bash
cd apps/server && npm test
cd ../web && npm test
cd ../server && npm run build
cd ../web && npm run build
```

Expected: 全部 PASS / 0 error。

- [ ] **Step 5: 提交**

```bash
git add docs/
git commit -m "docs: 练习记录单题重做/同类型练习 API 与 changelog"
```

---

## Self-Review

- **Spec coverage**：重做（Task 4/5/9）、同类型（Task 6/7/9）、未作答占位（Task 3）、详情 flags（Task 2）、2 题档（Task 1）、前端入口（Task 8）、题号修复（Task 9）、文档（Task 10）。
- **Placeholder scan**：无 TBD/TODO；每个代码步骤都有实际片段。
- **Type consistency**：`HistoryRunQuestion` 与前端 `TargetedPracticeQuestion` 同形；`suppressErrorFixPoints` / `plannedQuestionIds` 在 DTO、service、judge-core、api.ts、run 页一致；`mode` 只在交接体/run 页使用。
