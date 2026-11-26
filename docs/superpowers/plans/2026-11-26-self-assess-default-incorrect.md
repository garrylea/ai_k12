# 主观题自评确定性（默认错 + 事务化结算）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让训练轨主观题自评结果永远确定（不表态默认错），并把「作答行 + 错题本 + 掌握度 + 自评留痕」放进同一事务结算。

**Architecture:** 新增 `self_assess_state` 列与 `SelfAssessmentSettlementService`；判题路由 1c 在带 `sessionUid` 时返回「默认错」但不写库，由 settlement 服务用单连接事务统一写会话/作答/错题本/掌握度；自评端点按状态机做幂等覆盖结算；不带 `sessionUid` 的考试/redo/老客户端走旧逻辑。

**Tech Stack:** NestJS + TypeScript、mysql2/promise 连接池与显式事务、vitest、React（Vite）+ @testing-library。

## Global Constraints（每个任务都隐含适用）

- 设计真源：`docs/superpowers/specs/2026-11-26-self-assess-default-incorrect-design.md`（下称 spec）。与本文冲突以 spec 为准。
- 事务内所有 SQL 必须用**同一 `PoolConnection`**；只对 `targeted/error_practice` 且**带 `sessionUid`** 生效。
- 掌握度回退 `revertOneError`：`correct_count+1`、`error_count=GREATEST(error_count-1,0)`，`mastery_score/level` **直接引用更新后的列名**（MySQL SET 从左到右）。更新 **0 行不是失败**，只 warn、不回滚。
- 只有 SQL **抛异常**才 `rollback()`；`catch` 里 `rollback` 后**重新抛出原错误**。
- 默认错**不写** `question_self_assessments`；学生点对/点错才追加一条。
- 默认错**不发** `error_fix` 积分；`error_book_cleared` 事件照发（仅 `cleared>0`）。
- 考试（`source='exam'`）、redo、老客户端（无 `sessionUid`）行为**逐字不变**。
- 不用 emoji；提交信息用中文 `feat/fix/docs/test` 前缀；每任务独立可测、结束即 commit。
- 后端：`cd apps/server && npm test`；类型检查 `npx tsc --noEmit`。前端：`cd apps/web && npm test`。

## 前置：工作区现状（务必先读）

1. 本仓库工作区当前有**未提交**的 A+B 改动（`questions.repo.*`、`special-answer-records.repo.*`、`training.service.*`、`self-assess.dto.ts`、`training.controller.ts`、`TargetedRunPage.tsx`、`api.ts` 及相关文档）。
   - **A（抽题判定纳入自评表）保留**，与本案不冲突。
   - **B（自评回写 `is_correct`，即 `markSelfAssessCorrectness`）被本案取代**：结算改由 `SelfAssessmentSettlementService` 在事务内把作答行置 0/1，`markSelfAssessCorrectness` 不再被调用，实施 Task 6 时**删除**它及其测试。
2. 开始前先让工作区干净：`git stash` 或先提交 A+B。若选择提交，先只提交 A 相关文件，B 相关改动带进 Task 6 一起改。
3. 起后端用 `node dist/main.js`（不用 `tsx`）；本计划只改代码与测试，联调由执行者在最终阶段做。

---

### Task 1: 数据库迁移与 schema —— `special_answer_records.self_assess_state`

**Files:**
- Create: `tools/db/migrations/2026-11-26_special_answer_self_assess_state.sql`
- Modify: `tools/db/schema.sql`（`special_answer_records` 建表块内加列与注释）

**Interfaces:**
- Produces: 列 `self_assess_state VARCHAR(24) NULL`，取值 `default_incorrect|confirmed_correct|confirmed_incorrect|NULL`。

- [ ] **Step 1: 写迁移（幂等加列）**

```sql
-- 2026-11-26 主观题自评确定性：作答行增加内部结算状态。
-- 语义见 docs/superpowers/specs/2026-11-26-self-assess-default-incorrect-design.md §2
-- 取值：default_incorrect|confirmed_correct|confirmed_incorrect；NULL=非本设计路径/旧数据
-- 幂等：先查列是否存在，不存在才 ADD。
SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'special_answer_records'
    AND COLUMN_NAME = 'self_assess_state'
);
SET @ddl := IF(
  @has_col = 0,
  "ALTER TABLE special_answer_records ADD COLUMN self_assess_state VARCHAR(24) DEFAULT NULL COMMENT 'default_incorrect|confirmed_correct|confirmed_incorrect；NULL=非本设计/旧数据' AFTER method",
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
```

- [ ] **Step 2: 同步 `tools/db/schema.sql`**

在 `special_answer_records` 建表语句中 `method` 行后加：

```sql
  self_assess_state VARCHAR(24) DEFAULT NULL COMMENT 'default_incorrect|confirmed_correct|confirmed_incorrect；NULL=非本设计/旧数据',
```

- [ ] **Step 3: 应用迁移到本机并核对**

Run:
```bash
mysql -h127.0.0.1 -uai_k12 -pai_k12 ai_k12 < tools/db/migrations/2026-11-26_special_answer_self_assess_state.sql
mysql -h127.0.0.1 -uai_k12 -pai_k12 ai_k12 -e "SHOW COLUMNS FROM special_answer_records LIKE 'self_assess_state';"
```
Expected: 出现该列，Type `varchar(24)`，Null `YES`。

- [ ] **Step 4: 收尾对账**

Run: `python3 tools/db/schema_reconcile.py`
Expected: 无差异（或仅本列一致）。

- [ ] **Step 5: Commit**

```bash
git add tools/db/migrations/2026-11-26_special_answer_self_assess_state.sql tools/db/schema.sql
git commit -m "feat(db): special_answer_records 增加 self_assess_state 结算状态列"
```

---

### Task 2: 仓储支持事务执行器（executor）—— 只改结算用到的写方法

**Files:**
- Modify: `apps/server/src/database/repositories/special-practice-sessions.repo.ts`
- Modify: `apps/server/src/database/repositories/special-answer-records.repo.ts`
- Modify: `apps/server/src/database/repositories/main-error-books.repo.ts`
- Test: 对应 `.repo.test.ts`（各加一条「传 executor 时用 executor 而非 pool」的断言）

**Interfaces:**
- Produces（方法签名，后续任务统一用）：
  - `upsertSession(input: UpsertSessionInput, executor?: PoolConnection): Promise<number>`
  - `markCompletedByUid(sessionUid: string, studentId: number, executor?: PoolConnection): Promise<number>`
  - `upsertAnswer(input: UpsertAnswerInput, executor?: PoolConnection): Promise<void>`
  - `clearUnclearedByStudentQuestionId(studentId: number, questionId: number, executor?: PoolConnection): Promise<number>`
  - `findOrCreateUncleared(input: {studentId:number; subjectId:number; questionId:number; source:string; sourceRefId?:number|null}, executor?: PoolConnection): Promise<number>`
- 约定：`const db = executor ?? this.pool;` 之后用 `db.execute/query`。

- [ ] **Step 1: 写失败测试（sessions repo）**

在 `special-practice-sessions.repo.test.ts` 增：
```ts
it('upsertSession 传 executor 时用该连接而非 pool', async () => {
  const pool = { execute: vi.fn(), query: vi.fn() };
  const exec = { execute: vi.fn().mockResolvedValue([{ insertId: 9, affectedRows: 1 }]), query: vi.fn() };
  const repo = new SpecialPracticeSessionsRepository(pool as any);
  await repo.upsertSession({ sessionUid:'u', studentId:1, subjectId:1, module:'math_targeted', title:null, questionCount:0 }, exec as any);
  expect(pool.execute).not.toHaveBeenCalled();
  expect(exec.execute).toHaveBeenCalled();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/database/repositories/special-practice-sessions.repo.test.ts -t "executor"`
Expected: FAIL（参数未生效，仍走 pool）。

- [ ] **Step 3: 实现 executor 参数（三个 repo 一起）**

`special-practice-sessions.repo.ts`：`upsertSession`/`markCompleted`/`listByStudent`/`countByStudent`/`findByIdOwned` 里把 `this.pool` 改为 `(executor ?? this.pool)`；给 `upsertSession`、新增的 `markCompletedByUid` 加 `executor?: PoolConnection`（import `PoolConnection`）。

新增 `markCompletedByUid`：
```ts
async markCompletedByUid(sessionUid: string, studentId: number, executor?: PoolConnection): Promise<number> {
  const db = executor ?? this.pool;
  const [r] = await db.execute<ResultSetHeader>(
    `UPDATE special_practice_sessions SET completed_at = NOW(3)
     WHERE session_uid = ? AND student_id = ? AND completed_at IS NULL`,
    [sessionUid, studentId],
  );
  return r.affectedRows;
}
```

`special-answer-records.repo.ts`：`upsertAnswer(input, executor?)`。`main-error-books.repo.ts`：`clearUnclearedByStudentQuestionId(..., executor?)`，并新增 `findOrCreateUncleared`（先 `SELECT ... FOR UPDATE` 查未清，无则 `INSERT`，返回 id；SQL 用 `executor ?? pool`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/database/repositories/special-practice-sessions.repo.test.ts src/database/repositories/special-answer-records.repo.test.ts src/database/repositories/main-error-books.repo.test.ts`
Expected: PASS（含既有 + 新用例）。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/database/repositories/*.ts
git commit -m "feat(repo): 结算相关写方法支持事务 executor"
```

---

### Task 3: 作答行状态机仓储方法

**Files:**
- Modify: `apps/server/src/database/repositories/special-answer-records.repo.ts`
- Test: `apps/server/src/database/repositories/special-answer-records.repo.test.ts`

**Interfaces:**
- Produces:
  - `findForUpdate(sessionId: number, questionId: number, executor: PoolConnection): Promise<AnswerRow | null>`（`SELECT ... FOR UPDATE`）
  - `insertDefaultIncorrect(input: {sessionId;questionId;questionOrder;answerText;method:'self_assess'}, executor): Promise<void>`
  - `transitionState(input: {sessionId;questionId;state:'confirmed_correct'|'confirmed_incorrect';isCorrect:0|1;judgedAt:Date}, executor): Promise<void>`

- [ ] **Step 1: 写失败测试（SQL 形状 + 参数）**

```ts
it('findForUpdate 用 FOR UPDATE 且带 session_id+question_id', async () => {
  const exec = { execute: vi.fn().mockResolvedValue([[], []]) };
  const repo = new SpecialAnswerRecordsRepository({} as any);
  await repo.findForUpdate(1, 5034, exec as any);
  const [sql, params] = exec.execute.mock.calls[0];
  expect(sql).toContain('FOR UPDATE');
  expect(params).toEqual([1, 5034]);
});
it('insertDefaultIncorrect 写 is_correct=0/self_assess_state=default_incorrect', async () => {
  const exec = { execute: vi.fn().mockResolvedValue([{ affectedRows:1 }]) };
  const repo = new SpecialAnswerRecordsRepository({} as any);
  await repo.insertDefaultIncorrect({ sessionId:1, questionId:5034, questionOrder:1, answerText:'x', method:'self_assess' }, exec as any);
  const [sql, params] = exec.execute.mock.calls[0];
  expect(sql).toContain('self_assess_state');
  expect(params).toContain(0);
  expect(params).toContain('default_incorrect');
});
it('transitionState 更新 is_correct/state/judged_at', async () => {
  const exec = { execute: vi.fn().mockResolvedValue([{ affectedRows:1 }]) };
  const repo = new SpecialAnswerRecordsRepository({} as any);
  await repo.transitionState({ sessionId:1, questionId:5034, state:'confirmed_correct', isCorrect:1, judgedAt:new Date() }, exec as any);
  const [sql] = exec.execute.mock.calls[0];
  expect(sql).toContain('self_assess_state');
  expect(sql).toContain('is_correct');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/database/repositories/special-answer-records.repo.test.ts -t "findForUpdate|insertDefaultIncorrect|transitionState"`
Expected: FAIL（方法不存在）。

- [ ] **Step 3: 实现三方法**

```ts
async findForUpdate(sessionId: number, questionId: number, executor: PoolConnection): Promise<AnswerRow | null> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT * FROM special_answer_records WHERE session_id = ? AND question_id = ? FOR UPDATE`,
    [sessionId, questionId],
  );
  return (rows[0] as AnswerRow) ?? null;
}

async insertDefaultIncorrect(input: { sessionId:number; questionId:number; questionOrder:number; answerText:string; method:string }, executor: PoolConnection): Promise<void> {
  await executor.execute(
    `INSERT INTO special_answer_records
       (session_id, question_id, question_order, answer_text, is_correct, method, self_assess_state, judged_at)
     VALUES (?, ?, ?, ?, 0, ?, 'default_incorrect', NOW(3))`,
    [input.sessionId, input.questionId, input.questionOrder, input.answerText, input.method],
  );
}

async transitionState(input: { sessionId:number; questionId:number; state:'confirmed_correct'|'confirmed_incorrect'; isCorrect:0|1; judgedAt:Date }, executor: PoolConnection): Promise<void> {
  await executor.execute(
    `UPDATE special_answer_records SET is_correct = ?, self_assess_state = ?, judged_at = ?
     WHERE session_id = ? AND question_id = ?`,
    [input.isCorrect, input.state, input.judgedAt, input.sessionId, input.questionId],
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/database/repositories/special-answer-records.repo.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/database/repositories/special-answer-records.repo.ts apps/server/src/database/repositories/special-answer-records.repo.test.ts
git commit -m "feat(repo): 作答行默认错/结算状态机方法"
```

---

### Task 4: 掌握度回退 `revertOneError`（0 行不视为失败）

**Files:**
- Modify: `apps/server/src/database/repositories/student-knowledge-mastery.repo.ts`
- Test: `apps/server/src/database/repositories/student-knowledge-mastery.repo.test.ts`（若无则创建）
- Modify: `apps/server/src/modules/practice/mastery.service.ts`（新增 `revertErrorToCorrect`）
- Test: `apps/server/src/modules/practice/mastery.service.test.ts`

**Interfaces:**
- Produces:
  - `StudentKnowledgeMasteryRepository.revertOneError(studentId, kpId, executor?: PoolConnection): Promise<number>`（返回 affectedRows）
  - `MasteryService.revertErrorToCorrect({studentId, questionId, executor?}): Promise<void>`
  - `StudentKnowledgeMasteryRepository.upsertOnJudge(studentId, kpId, isCorrect, executor?)`

- [ ] **Step 1: 写失败测试（SQL 公式 + 0 行语义）**

repo 测试：
```ts
it('revertOneError 用更新后列值重算 score/level', async () => {
  const pool = { execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }]) };
  const repo = new StudentKnowledgeMasteryRepository(pool as any);
  const n = await repo.revertOneError(11, 5);
  const [sql] = pool.execute.mock.calls[0];
  expect(sql).toContain('GREATEST(error_count - 1, 0)');
  expect(sql).toMatch(/mastery_score\s*=\s*correct_count/i);
  expect(n).toBe(1);
});
it('revertOneError 返回 0 不抛异常', async () => {
  const pool = { execute: vi.fn().mockResolvedValue([{ affectedRows: 0 }]) };
  const repo = new StudentKnowledgeMasteryRepository(pool as any);
  await expect(repo.revertOneError(11, 5)).resolves.toBe(0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/database/repositories/student-knowledge-mastery.repo.test.ts -t revertOneError`
Expected: FAIL（方法不存在）。

- [ ] **Step 3: 实现 repo 方法 + service**

repo：
```ts
async revertOneError(studentId: number, kpId: number, executor?: PoolConnection): Promise<number> {
  const db = executor ?? this.pool;
  const [r] = await db.execute<ResultSetHeader>(
    `UPDATE student_knowledge_mastery
     SET correct_count = correct_count + 1,
         error_count   = GREATEST(error_count - 1, 0),
         mastery_score = correct_count / NULLIF(correct_count + error_count, 0),
         level         = FLOOR(5 * (correct_count / NULLIF(correct_count + error_count, 0))),
         last_seen_at  = NOW(3)
     WHERE student_id = ? AND knowledge_point_id = ?`,
    [studentId, kpId],
  );
  return r.affectedRows;
}
```
`upsertOnJudge` 加 `executor?` 并用 `(executor ?? this.pool)`。

`MasteryService`：
```ts
async revertErrorToCorrect(input: { studentId: number; questionId: number; executor?: PoolConnection }): Promise<void> {
  if (input.questionId == null) return;
  try {
    const kpIds = await this.questionsRepo.findKnowledgePointIdsByQuestion(input.questionId);
    for (const kpId of kpIds) {
      const n = await this.masteryRepo.revertOneError(input.studentId, kpId, input.executor);
      if (n === 0) this.logger.warn(`revertOneError 0 行（student=${input.studentId}, kp=${kpId}）；不回滚`);
    }
  } catch (err) {
    this.logger.warn('掌握度回退失败（已忽略）', err);
  }
}
```
> 注意：本案结算要求**事务内**回退，所以事务里**不能**吞异常——见 Task 8：在 settlement 内直接用 `masteryRepo.revertOneError(...executor)` 并让异常冒泡；`MasteryService.revertErrorToCorrect` 仅供**非事务**的旧语义路径使用（可不接 executor）。若只服务事务路径，可省略 service 方法、直接在 settlement 调 repo。执行者按 Task 8 的实际调用决定，删除未用的 service 方法。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/database/repositories/student-knowledge-mastery.repo.test.ts src/modules/practice/mastery.service.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/database/repositories/student-knowledge-mastery.repo.ts apps/server/src/database/repositories/student-knowledge-mastery.repo.test.ts apps/server/src/modules/practice/mastery.service.ts apps/server/src/modules/practice/mastery.service.test.ts
git commit -m "feat(mastery): 新增 revertOneError 回退能力（0 行不视为失败）"
```

---

### Task 5: `SelfAssessmentSettlementService` —— 首次提交（默认错，事务）

**Files:**
- Create: `apps/server/src/modules/training/self-assessment-settlement.service.ts`
- Create: `apps/server/src/modules/training/self-assessment-settlement.service.test.ts`
- Modify: `apps/server/src/modules/training/training.module.ts`（providers 注册 + 补 `QuestionSelfAssessmentsRepository`、`StudentKnowledgeMasteryRepository`）

**Interfaces:**
- Consumes: Task 2/3/4 的 repo 方法。
- Produces:
```ts
type SubmitDefaultIncorrectInput = {
  studentId: number; subjectId: number; questionId: number;
  answerText: string; source: 'targeted'|'error_practice'; sessionUid: string;
  session: { module: SpecialSessionModule; title: string | null; questionCount: number };
  questionOrder: number;
};
submitDefaultIncorrect(input: SubmitDefaultIncorrectInput): Promise<{ sessionId: number; errorBookId: number }>
```

- [ ] **Step 1: 写失败测试（事务编排 + 幂等 + 不写留痕）**

```ts
it('首次提交：同事务写会话/作答0/default_incorrect/错题本/掌握度error+1，且不写自评留痕', async () => {
  // 用假 pool：getConnection 返回 conn，conn.beginTransaction/commit/rollback/release 记录调用
  // 假 repos：findForUpdate 返回 null（首次）
  const { svc, conn, mocks } = mkSettlement();
  const r = await svc.submitDefaultIncorrect({ studentId:2, subjectId:1, questionId:5034, answerText:'解', source:'targeted', sessionUid:'u-1',
    session:{ module:'math_targeted', title:'数学专项', questionCount:3 }, questionOrder:1 });
  expect(conn.beginTransaction).toHaveBeenCalled();
  expect(conn.commit).toHaveBeenCalled();
  expect(mocks.answers.insertDefaultIncorrect).toHaveBeenCalled();
  expect(mocks.errorBooks.findOrCreateUncleared).toHaveBeenCalled();
  expect(mocks.mastery.upsertOnJudge).toHaveBeenCalledWith(2, expect.any(Number), false, conn);
  expect(mocks.selfAssess.create).not.toHaveBeenCalled();
  expect(r.errorBookId).toBeGreaterThan(0);
});
it('重复提交同答案：幂等，不重复 error+1/错题本', async () => {
  // findForUpdate 返回 { is_correct:0, self_assess_state:'default_incorrect', answer_text:'解' }
  ...
  expect(mocks.mastery.upsertOnJudge).not.toHaveBeenCalled();
  expect(mocks.errorBooks.findOrCreateUncleared).not.toHaveBeenCalled();
});
it('同一作答行不同答案：抛 409', async () => {
  // findForUpdate 返回 default_incorrect, answer_text:'旧'
  await expect(svc.submitDefaultIncorrect({ ... , answerText:'新' })).rejects.toMatchObject({ status: 409 });
});
it('错题本写失败 -> rollback 并抛原错误', async () => {
  mocks.errorBooks.findOrCreateUncleared.mockRejectedValueOnce(new Error('db down'));
  await expect(svc.submitDefaultIncorrect({...})).rejects.toThrow('db down');
  expect(conn.rollback).toHaveBeenCalled();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/training/self-assessment-settlement.service.test.ts`
Expected: FAIL（文件/类不存在）。

- [ ] **Step 3: 实现服务（首次提交）**

```ts
@Injectable()
export class SelfAssessmentSettlementService {
  constructor(@Inject('DATABASE_POOL') private pool: Pool,
    private sessions: SpecialPracticeSessionsRepository,
    private answers: SpecialAnswerRecordsRepository,
    private errorBooks: MainErrorBooksRepository,
    private questions: QuestionsRepository,
    private mastery: StudentKnowledgeMasteryRepository,
    private selfAssess: QuestionSelfAssessmentsRepository) {}

  async submitDefaultIncorrect(input: SubmitDefaultIncorrectInput) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const sessionId = await this.sessions.upsertSession({
        sessionUid: input.sessionUid, studentId: input.studentId, subjectId: input.subjectId,
        module: input.session.module, title: input.session.title, questionCount: input.session.questionCount,
      }, conn);
      const existing = await this.answers.findForUpdate(sessionId, input.questionId, conn);
      if (existing) {
        if (existing.self_assess_state === 'default_incorrect' && existing.answer_text === input.answerText) {
          await conn.commit();
          return { sessionId, errorBookId: 0 }; // 幂等：errorBookId 由调用方从既有本查（见 Step 注）
        }
        throw new HttpException({ code: 1001, message: '该题已有不同作答或已确认' }, 409);
      }
      await this.answers.insertDefaultIncorrect({
        sessionId, questionId: input.questionId, questionOrder: input.questionOrder,
        answerText: input.answerText, method: 'self_assess',
      }, conn);
      const errorBookId = await this.errorBooks.findOrCreateUncleared({
        studentId: input.studentId, subjectId: input.subjectId, questionId: input.questionId,
        source: input.source, sourceRefId: null,
      }, conn);
      const kpIds = await this.questions.findKnowledgePointIdsByQuestion(input.questionId);
      for (const kpId of kpIds) await this.mastery.upsertOnJudge(input.studentId, kpId, false, conn);
      await conn.commit();
      return { sessionId, errorBookId };
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }
}
```

> 幂等分支的 `errorBookId`：调用方需要它填充响应。实现时在幂等分支用 `errorBooks.findUnclearedByStudentQuestionId(studentId, questionId, conn)` 取既有未清 id（无则 0）。加该方法（Task 2 已允许加 executor），并补一条测试。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/training/self-assessment-settlement.service.test.ts`
Expected: PASS。

- [ ] **Step 5: 注册 provider 并跑模块测试**

`training.module.ts` providers 追加 `SelfAssessmentSettlementService, QuestionSelfAssessmentsRepository, StudentKnowledgeMasteryRepository`（后两个在 PracticeModule 已 provide 但未 export，此处再 provide 一份——仓储无状态，与 `TrainingSessionsRepository` 既有做法一致）。
Run: `cd apps/server && npx tsc --noEmit && npx vitest run src/modules/training -t settlement`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/training/self-assessment-settlement.service.ts apps/server/src/modules/training/self-assessment-settlement.service.test.ts apps/server/src/modules/training/training.module.ts
git commit -m "feat(training): 新增 SelfAssessmentSettlementService 首次提交事务"
```

---

### Task 6: 结算 —— 点「我做对了」（事务 + 状态机 + 回退）

**Files:**
- Modify: `apps/server/src/modules/training/self-assessment-settlement.service.ts`
- Test: `apps/server/src/modules/training/self-assessment-settlement.service.test.ts`
- Modify: `apps/server/src/database/repositories/special-answer-records.repo.ts`（删除 B 的 `markSelfAssessCorrectness` 及其测试）

**Interfaces:**
- Produces:
```ts
confirmSelfAssessment(input: {
  studentId: number; questionId: number; assessment: 'correct'|'incorrect';
  source: string; sessionUid: string;
}): Promise<{ errorBookId?: number; idempotent?: boolean }>
```

- [ ] **Step 1: 写失败测试（correct 分支 + 幂等 + 冲突 + 0 行）**

```ts
it('default_incorrect + correct：留痕correct+清本+revert+state=confirmed_correct+is_correct=1；不发分', async () => {
  // findForUpdate 返回 default_incorrect
  const r = await svc.confirmSelfAssessment({ studentId:2, questionId:5034, assessment:'correct', source:'targeted', sessionUid:'u-1' });
  expect(mocks.selfAssess.create).toHaveBeenCalledWith(expect.objectContaining({ assessment:'correct' }), conn);
  expect(mocks.errorBooks.clearUnclearedByStudentQuestionId).toHaveBeenCalledWith(2, 5034, conn);
  expect(mocks.mastery.revertOneError).toHaveBeenCalled();
  expect(mocks.answers.transitionState).toHaveBeenCalledWith(expect.objectContaining({ state:'confirmed_correct', isCorrect:1 }), conn);
  expect(mocks.points.award).not.toHaveBeenCalled();
});
it('confirmed_correct + correct：幂等，不重复', async () => {
  // findForUpdate 返回 confirmed_correct
  const r = await svc.confirmSelfAssessment({...assessment:'correct'});
  expect(r.idempotent).toBe(true);
  expect(mocks.mastery.revertOneError).not.toHaveBeenCalled();
});
it('confirmed_incorrect + correct：409', async () => {
  // findForUpdate 返回 confirmed_incorrect
  await expect(svc.confirmSelfAssessment({...assessment:'correct'})).rejects.toMatchObject({ status:409 });
});
it('revertOneError 0 行：仍提交成功，不回滚', async () => {
  mocks.mastery.revertOneError.mockResolvedValue(0);
  await expect(svc.confirmSelfAssessment({...assessment:'correct'})).resolves.toBeTruthy();
  expect(conn.commit).toHaveBeenCalled();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/training/self-assessment-settlement.service.test.ts -t "correct"`
Expected: FAIL。

- [ ] **Step 3: 实现 correct 分支**

在 `confirmSelfAssessment` 内：
```ts
const conn = await this.pool.getConnection();
try {
  await conn.beginTransaction();
  const sessionId = await this.sessions.findIdByUid(input.sessionUid, input.studentId, conn); // 新增：按 uid+student 取 id，无则抛 409/1002
  const row = await this.answers.findForUpdate(sessionId, input.questionId, conn);
  if (!row) throw new HttpException({ code: 1002, message: '作答记录不存在或已失效，请重新提交' }, 409);
  const state = row.self_assess_state;
  if (input.assessment === 'correct') {
    if (state === 'confirmed_correct') { await conn.commit(); return { idempotent: true }; }
    if (state === 'confirmed_incorrect') throw new HttpException({ code: 1001, message: '该题自评结果已确认' }, 409);
    if (state === 'default_incorrect') {
      await this.selfAssess.create({ studentId: input.studentId, questionId: input.questionId, assessment:'correct', source: input.source }, conn);
      const cleared = await this.errorBooks.clearUnclearedByStudentQuestionId(input.studentId, input.questionId, conn);
      const kpIds = await this.questions.findKnowledgePointIdsByQuestion(input.questionId);
      for (const kpId of kpIds) {
        const n = await this.mastery.revertOneError(input.studentId, kpId, conn);
        if (n === 0) this.logger.warn(`revertOneError 0 行（student=${input.studentId}, kp=${kpId}）`);
      }
      await this.answers.transitionState({ sessionId, questionId: input.questionId, state:'confirmed_correct', isCorrect:1, judgedAt:new Date() }, conn);
      await conn.commit();
      if (cleared > 0) this.events?.track({ event:'error_book_cleared', source:'server', studentId:input.studentId, refType:'question', refId:input.questionId });
      return { errorBookId: undefined };
    }
    // state === NULL（迁移前旧行）：走旧语义补偿（Task 9 统一说明），此处先按 409/1002 处理并记录
    throw new HttpException({ code: 1002, message: '作答记录状态缺失，请重新提交' }, 409);
  }
  // incorrect 分支见 Task 7
} catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
```

- [ ] **Step 4: 实现 `findIdByUid`**

```ts
async findIdByUid(sessionUid: string, studentId: number, executor?: PoolConnection): Promise<number> {
  const db = executor ?? this.pool;
  const [rows] = await db.execute<RowDataPacket[]>(
    `SELECT id FROM special_practice_sessions WHERE session_uid = ? AND student_id = ?`, [sessionUid, studentId]);
  const id = (rows[0] as { id?: number })?.id;
  if (!id) throw new HttpException({ code: 1002, message: '作答记录不存在或已失效，请重新提交' }, 409);
  return id;
}
```
（放在 sessions repo；补一条测试。）

- [ ] **Step 5: 按测试失败点补全 + 删除 B 的 `markSelfAssessCorrectness`**

删除 `special-answer-records.repo.ts` 的 `markSelfAssessCorrectness` 及其在 `special-answer-records.repo.test.ts` 的两个用例（B 方案已被取代）。

- [ ] **Step 6: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/training/self-assessment-settlement.service.test.ts src/database/repositories/special-answer-records.repo.test.ts`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/modules/training apps/server/src/database/repositories/special-answer-records.repo.ts apps/server/src/database/repositories/special-answer-records.repo.test.ts apps/server/src/database/repositories/special-practice-sessions.repo.ts apps/server/src/database/repositories/special-practice-sessions.repo.test.ts
git commit -m "feat(training): 结算点对流程（覆盖+回退+幂等），移除旧 markSelfAssessCorrectness"
```

---

### Task 7: 结算 —— 点「我做错了」（只追加留痕 + 改状态）

**Files:**
- Modify: `apps/server/src/modules/training/self-assessment-settlement.service.ts`
- Test: `apps/server/src/modules/training/self-assessment-settlement.service.test.ts`

**Interfaces:** 复用 `confirmSelfAssessment`，`assessment='incorrect'`。

- [ ] **Step 1: 写失败测试**

```ts
it('default_incorrect + incorrect：只追加 incorrect 留痕 + state=confirmed_incorrect，不改 is_correct/错题本/掌握度', async () => {
  const r = await svc.confirmSelfAssessment({ studentId:2, questionId:5034, assessment:'incorrect', source:'targeted', sessionUid:'u-1' });
  expect(mocks.selfAssess.create).toHaveBeenCalledWith(expect.objectContaining({ assessment:'incorrect' }), conn);
  expect(mocks.answers.transitionState).toHaveBeenCalledWith(expect.objectContaining({ state:'confirmed_incorrect', isCorrect:0 }), conn);
  expect(mocks.errorBooks.findOrCreateUncleared).not.toHaveBeenCalled();
  expect(mocks.mastery.upsertOnJudge).not.toHaveBeenCalled();
  expect(mocks.mastery.revertOneError).not.toHaveBeenCalled();
});
it('confirmed_incorrect + incorrect：幂等，不重复留痕', async () => {
  const r = await svc.confirmSelfAssessment({...assessment:'incorrect'});
  expect(r.idempotent).toBe(true);
  expect(mocks.selfAssess.create).not.toHaveBeenCalled();
});
it('confirmed_correct + incorrect：409', async () => {
  await expect(svc.confirmSelfAssessment({...assessment:'incorrect'})).rejects.toMatchObject({ status:409 });
});
```

- [ ] **Step 2: 跑测试确认失败** → `npx vitest run ... -t incorrect`，Expected FAIL。

- [ ] **Step 3: 实现 incorrect 分支**

```ts
if (input.assessment === 'incorrect') {
  if (state === 'confirmed_incorrect') { await conn.commit(); return { idempotent: true }; }
  if (state === 'confirmed_correct') throw new HttpException({ code:1001, message:'该题自评结果已确认' }, 409);
  if (state === 'default_incorrect') {
    await this.selfAssess.create({ studentId: input.studentId, questionId: input.questionId, assessment:'incorrect', source: input.source }, conn);
    await this.answers.transitionState({ sessionId, questionId: input.questionId, state:'confirmed_incorrect', isCorrect:0, judgedAt:new Date() }, conn);
    await conn.commit();
    return {};
  }
  throw new HttpException({ code:1002, message:'作答记录状态缺失，请重新提交' }, 409);
}
```

- [ ] **Step 4: 跑测试确认通过** → PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/training/self-assessment-settlement.service.ts apps/server/src/modules/training/self-assessment-settlement.service.test.ts
git commit -m "feat(training): 结算点错流程（只追加留痕+状态迁移）"
```

---

### Task 8: 接入判题路由与 `judgeTraining` / `selfAssess`

**Files:**
- Modify: `apps/server/src/modules/practice/judge-core.service.ts`（`JudgeCoreQuestionInput` 加 `defaultIncorrect?: boolean`；路由 1c）
- Modify: `apps/server/src/modules/training/training.service.ts`（`judgeTraining`、`selfAssess`）
- Test: `apps/server/src/modules/practice/judge-core.service.test.ts`、`apps/server/src/modules/training/training.service.test.ts`

**Interfaces:**
- Consumes: `SelfAssessmentSettlementService.submitDefaultIncorrect` / `confirmSelfAssessment`。
- Produces: 判题响应带 uid 时 `isCorrect=false/needsSelfAssessment=true/errorBookId`。

- [ ] **Step 1: 写失败测试（judge-core）**

```ts
it('路由1c + defaultIncorrect=true：isCorrect=false、不写掌握度(finishJudge 不调)、needsSelfAssessment=true', async () => {
  const out = await svc.judgeQuestion({ studentId:2, subjectId:1, questionId:5034, studentAnswer:'x', source:'targeted', defaultIncorrect:true });
  expect(out.isCorrect).toBe(false);
  expect(out.needsSelfAssessment).toBe(true);
  expect(deps.masteryService.recordFromJudge).not.toHaveBeenCalled();
});
it('路由1c + defaultIncorrect 缺省：保持 isCorrect=null', async () => {
  const out = await svc.judgeQuestion({ ...同, defaultIncorrect: undefined });
  expect(out.isCorrect).toBeNull();
});
```

- [ ] **Step 2: 跑测试确认失败** → FAIL。

- [ ] **Step 3: 改 judge-core 路由 1c**

`JudgeCoreQuestionInput` 增 `defaultIncorrect?: boolean`。路由 1c 内：
```ts
const out = { questionId:q.id, isCorrect: input.defaultIncorrect ? false : null, method:'self_assess', errorType:null, errorBookId:undefined, needsSelfAssessment:true, referenceAnswer:q.answer, explanation:q.explanation, pointsAwarded:0 };
this.events?.track({ event:'self_assess_answered', ... }); // 保持不变
if (input.defaultIncorrect) return out; // 不 trackAnswer(避免误计连错)、不 finishJudge(掌握度交给 settlement)
return this.finishJudge(input.studentId, out);
```
> 注意：`defaultIncorrect` 只在 `source∈{targeted,error_practice}` 由调用方传 true；`exam` 永不传。

- [ ] **Step 4: 改 `training.service.judgeTraining`**

在 `judgeCore.judgeQuestion` 调用前计算：
```ts
const useDefaultIncorrect = input.source !== 'exam' && !!input.sessionUid;
const result = await this.judgeCore.judgeQuestion({ ...judgeInput, sourceRefId: null, defaultIncorrect: useDefaultIncorrect });
```
在 `result.needsSelfAssessment && useDefaultIncorrect` 分支：
```ts
const module = targetedSessionModule(input.subjectId) as SpecialSessionModule;
const settled = await this.settlement.submitDefaultIncorrect({
  studentId: input.studentId, subjectId: input.subjectId, questionId: input.questionId,
  answerText: input.studentAnswer, source: input.source as 'targeted'|'error_practice', sessionUid: input.sessionUid!,
  session: { module, title: input.title ?? null, questionCount: input.questionCount ?? 0 },
  questionOrder: input.questionOrder ?? 1,
});
return { ...result, errorBookId: settled.errorBookId };
```
并**跳过**原 `specialAnswersRepo.upsertAnswer` 旁路（该分支已由 settlement 写答案行）；其余分支（无 uid / 客观题 / 非自评）维持原逻辑。

- [ ] **Step 5: 改 `training.service.selfAssess`**

带 `sessionUid` 且 `source!=='exam'`：改调 `settlement.confirmSelfAssessment({studentId, questionId, assessment, source, sessionUid})`，不再调 `judgeCore.recordSelfAssessment`。
不带 uid 或 `source==='exam'`：保持 `judgeCore.recordSelfAssessment`（旧语义）。
（删除 Task 8 之前 B 加的 `markSelfAssessCorrectness` 调用。）

- [ ] **Step 6: 注入 settlement 到 TrainingService 构造**

`training.service.ts` 构造函数末尾加 `private readonly settlement: SelfAssessmentSettlementService`（import 值导入，注意 Nest 设计时类型）。同步补 `training.service.test.ts` 的 `mkSvc` 依赖桩。

- [ ] **Step 7: 跑测试**

Run: `cd apps/server && npx vitest run src/modules/practice/judge-core.service.test.ts src/modules/training/training.service.test.ts`
Expected: PASS（含既有 + 新增）。

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/modules/practice/judge-core.service.ts apps/server/src/modules/practice/judge-core.service.test.ts apps/server/src/modules/training/training.service.ts apps/server/src/modules/training/training.service.test.ts
git commit -m "feat(training): judge/self-assess 接入事务结算，默认错不再写假留痕"
```

---

### Task 9: 会话完成端点

**Files:**
- Modify: `apps/server/src/modules/training/training.controller.ts`（新增 `POST special-sessions/:sessionUid/complete`）
- Modify: `apps/server/src/modules/training/training.service.ts`（新增 `completeSpecialSession`）
- Test: `apps/server/src/modules/training/training.service.test.ts`

**Interfaces:**
- Produces: `POST /api/training/special-sessions/:sessionUid/complete` → 200 `{ completed: true }`；404/1002 非本人或不存在。

- [ ] **Step 1: 写失败测试**

```ts
it('completeSpecialSession：按 uid+student 置 completed_at，非本人 404', async () => {
  deps.specialSessionsRepo.markCompletedByUid.mockResolvedValue(1);
  await mkSvc(deps).completeSpecialSession('u-1', 2);
  expect(deps.specialSessionsRepo.markCompletedByUid).toHaveBeenCalledWith('u-1', 2);
});
it('未命中（0 行）抛 404/1002', async () => {
  deps.specialSessionsRepo.markCompletedByUid.mockResolvedValue(0);
  await expect(mkSvc(deps).completeSpecialSession('nope', 2)).rejects.toMatchObject({ status: 404 });
});
```

- [ ] **Step 2: 跑测试确认失败** → FAIL。

- [ ] **Step 3: 实现 service + controller**

service：
```ts
async completeSpecialSession(sessionUid: string, studentId: number): Promise<{ completed: true }> {
  const n = await this.specialSessionsRepo.markCompletedByUid(sessionUid, studentId);
  if (n === 0) throw new NotFoundException({ code: 1002, message: '会话不存在或非本人' });
  return { completed: true };
}
```
controller（注意状态迁移类 `@HttpCode(200)`）：
```ts
@Post('special-sessions/:sessionUid/complete')
@HttpCode(200)
async completeSpecialSession(@Param('sessionUid') uid: string, @CurrentUser() user: JwtUser) {
  return this.trainingService.completeSpecialSession(uid, user.sub);
}
```
（import `HttpCode`, `Param`。）

- [ ] **Step 4: 跑测试确认通过** → PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/training/training.controller.ts apps/server/src/modules/training/training.service.ts apps/server/src/modules/training/training.service.test.ts
git commit -m "feat(training): 新增专项会话完成端点"
```

---

### Task 10: 前端 —— error_practice 补 uid、完成端点、回退拦截与 409

**Files:**
- Modify: `apps/web/src/services/api.ts`（`completeSpecialSession(sessionUid)`；`selfAssessTraining` 无需新字段）
- Modify: `apps/web/src/pages/student/training/ErrorPracticeRunPage.tsx`（生成 sessionUid、judge/selfAssess 透传、完成后调完成端点）
- Modify: `apps/web/src/pages/student/training/TargetedRunPage.tsx`（完成后调完成端点）
- Modify: `apps/web/src/components/business/answer/QuestionRunner.tsx`（P1：回退拦截 + 409 不 advance）
- Test: `apps/web/src/pages/student/training/*.test.tsx`、`QuestionRunner.test.tsx`

- [ ] **Step 1: 写失败测试（P1 拦截普通 & 409 兜底）**

`QuestionRunner.test.tsx`：
```tsx
it('回退到已作答自评题再提交：不调用 onSubmit，显示提示', async () => {
  // resultsRef 已有该题（模拟先答后回退），selfAssessEligible 为 true
  // 点提交 -> 期望 onSubmit 未被调用、出现「本题已作答」提示
});
it('judge 返回 409：停留当前题、不 advance、显示提示', async () => {
  // onSubmit reject 一个带 status=409 的 error -> 期望仍在当前题、显示提示、未调用 onFinish/advance
});
```

- [ ] **Step 2: 跑测试确认失败** → `cd apps/web && npx vitest run src/components/business/answer/QuestionRunner.test.tsx` FAIL。

- [ ] **Step 3: 实现 P1 拦截 + 409 兜底（QuestionRunner）**

`handleSubmit` 入口（自评题分支）：
```ts
const alreadyAnswered = resultsRef.current[question.n] != null;
if (inlineSelfAssess && alreadyAnswered) {
  setSubmitBlocked('本题已作答，如需重做请重新进入练习'); // 新状态；渲染提示
  return;
}
```
`catch` 区分 409：
```ts
} catch (e: any) {
  if (seqRef.current[question.n] !== seq) return;
  if (e?.status === 409) { setSubmitBlocked('本题已作答，如需重做请重新进入练习'); return; } // 不 advance
  resultsRef.current[question.n] = { isCorrect:false, method:'ai', errorType:null, studentAnswer:submittedAnswer, failed:true };
  advance(thisIdx);
}
```
`fetchApi` 需在抛出值上带 `status`（若当前只带 message，则 `fetchApi` 里 `const err:any = new Error(...); err.status = res.status; throw err`）。

- [ ] **Step 4: error_practice 补 uid + 完成端点**

`ErrorPracticeRunPage`：`const sessionUid = useMemo(() => newSessionUid(), [])`；`judgeTraining` 加 `sessionUid, title:'错题练习', questionCount, questionOrder`；`selfAssessTraining` 加 `sessionUid`；`handleFinish` 成功后调 `completeSpecialSession(sessionUid)`（best-effort，`.catch(()=>{})`）。
`TargetedRunPage`：`handleFinish` 里在 `completeSession()` 之后调 `completeSpecialSession(sessionUid).catch(()=>{})`（非 redo）。

- [ ] **Step 5: 跑前端测试**

Run: `cd apps/web && npx vitest run src/components/business/answer/QuestionRunner.test.tsx src/pages/student/training/ErrorPracticeRunPage.test.tsx src/pages/student/training/TargetedRunPage.test.tsx`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/services/api.ts apps/web/src/pages/student/training apps/web/src/components/business/answer
git commit -m "feat(web): 错题练习补会话uid+完成端点；回退已答题拦截与409处理"
```

---

### Task 11: 文档同步与全量回归

**Files:**
- Modify: `docs/API接口与数据流设计文档.md`（§4.18/§5.19 自评语义、409、完成端点）
- Modify: `docs/api/openapi.yaml`（judge 响应说明、self-assess 409/1002、完成端点、`sessionUid` 行为）
- Modify: `docs/K12智学系统-数据库设计文档.md`、`docs/constraints/ai-core.md`、`docs/ai-core-changelog.md`

- [ ] **Step 1: 同步 API 文档与 openapi（按 spec §10 清单）**

在 openapi 加 `POST /training/special-sessions/{sessionUid}/complete`，`/training/judge` 带 uid 的响应补 `isCorrect=false`，`/training/self-assess` 的 409/1002 分支。

- [ ] **Step 2: 校验 openapi YAML**

Run: `python3 -c "import yaml; yaml.safe_load(open('docs/api/openapi.yaml')); print('ok')"`
Expected: `ok`。

- [ ] **Step 3: 全量回归**

Run:
```bash
cd apps/server && npm test && npx tsc --noEmit
cd ../../apps/web && npm test && npx tsc --noEmit
```
Expected: 全绿。

- [ ] **Step 4: schema 对账**

Run: `python3 tools/db/schema_reconcile.py`
Expected: 一致。

- [ ] **Step 5: Commit**

```bash
git add docs apps/server apps/web
git commit -m "docs: 同步自评默认错/事务结算的 API、DB、changelog"
```

---

## Self-Review 记录（写完自查）

- **Spec 覆盖**：§2 状态模型→Task 1/3；§3 事务/服务→Task 5；§4.1 提交→Task 5/8；§4.2 点对→Task 6；§4.3 点错→Task 7；§4.5 旧语义→Task 8；§5 掌握度 0 行→Task 4/6；§6.1 迁移→Task 1；§6.3/6.4 接口→Task 8/9；§7 P1 回退拦截→Task 10；§8 错误处理→Task 6/8/10；§9 测试→各任务内；§10 文档→Task 11。
- **占位符**：无 TBD；`findIdByUid`、`findOrCreateUncleared`、`markCompletedByUid`、`revertOneError` 均在首次出现的任务定义并提供实现。
- **类型一致**：`self_assess_state` 取值、`confirmSelfAssessment`/`submitDefaultIncorrect` 签名、`executor?: PoolConnection` 全篇统一。
- **已知风险（执行时留意）**：`SELECT ... FOR UPDATE` 于不存在的行可能触发间隙锁；若并发压测出现死锁，改为「先 INSERT IGNORE 再 SELECT FOR UPDATE」。结算事务内的掌握度异常必须冒泡回滚；只有 `revertOneError` 的 **0 行**不抛异常。
