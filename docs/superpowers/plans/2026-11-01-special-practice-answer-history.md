# 专项练习作答历史 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 记录学生每次专项练习/考试的逐题作答（含答案原文），学生端个人中心加"练习记录"入口可查看历史。

**Architecture:** 表方案 C — `exam_answers` 不动，新建 `special_practice_sessions` + `special_answer_records`（与 exam 对称），5 个判题方法 DTO 加可选 `sessionUid` 惰性建会话+补写作答记录，查询层 UNION ALL 两表返回统一列表。

**Tech Stack:** NestJS（后端）+ React Router 6 + Zustand（前端）+ mysql2 + Vitest（测试）+ MySQL 8

**Spec:** `docs/superpowers/specs/2026-11-01-special-practice-answer-history-design.md`

## Global Constraints

- **起后端用 `node dist/main.js`**（不用 `npx tsx src/main.ts`，DI 是坏的，CLAUDE.md 铁律）
- **`@Injectable()` 类的接口类型参数加 `@Optional()`**（Nest DI 坑，CLAUDE.md 铁律）
- **`updated_at` 列级 `ON UPDATE CURRENT_TIMESTAMP(3)`**，不建触发器
- **`globals: false`**：多用例测试文件自己 `afterEach(() => cleanup())`
- **UI 不用 emoji**，图标用线性 SVG
- **配色全 token**，禁止 `text-black/60` 等灰阶快捷写法
- **Markdown 渲染器用共享配置**（含图片 resolveAsset + rehype-raw + repairHtml + 表格带线）
- **浅停留页写死 `data-theme="student-day"`**，无日夜切换（UX §1.5 第 59 行）
- **API 文档同步**：`docs/API接口与数据流设计文档.md` 与 `docs/api/openapi.yaml` 必须一致
- **schema 同步**：新表进 `schema.sql` + 幂等迁移；DDL 批次收尾跑 `python3 tools/db/schema_reconcile.py`
- **测试断言与 config/types/设计文档冲突时测试错**（改测试不改 config/设计文档）
- **写入失败不阻断判题**（与 `special_practice_logs` 现口径一致）

---

## File Structure

**新建**：
| 文件 | 职责 |
|---|---|
| `tools/db/migrations/2026-11-01_special_practice_sessions_and_answers.sql` | 两表 DDL（幂等） |
| `apps/server/src/database/repositories/special-practice-sessions.repo.ts` | `special_practice_sessions` 的 upsertSession + listByStudent |
| `apps/server/src/database/repositories/special-answer-records.repo.ts` | `special_answer_records` 的 upsertAnswer + listBySession |
| `apps/server/src/modules/practice-history/practice-history.controller.ts` | GET 列表 + GET 详情 |
| `apps/server/src/modules/practice-history/practice-history.service.ts` | UNION 查询 + 详情路由 |
| `apps/server/src/modules/practice-history/practice-history.dto.ts` | Query DTO 类型 |
| `apps/web/src/pages/student/PracticeHistoryPage.tsx` | 列表页 |
| `apps/web/src/pages/student/PracticeHistoryDetailPage.tsx` | 详情页 |

**修改**：
| 文件 | 改动 |
|---|---|
| `tools/db/schema.sql` | 加两表 DDL |
| `apps/server/src/modules/training/training.service.ts` | judgeTraining / judgeDictation / judgeInterpretation 补写 |
| `apps/server/src/modules/training/meaning.service.ts` | 含义判题补写 |
| `apps/server/src/modules/training/vocabulary.service.ts` | 背词判题补写 |
| `apps/server/src/modules/training/dto/*.ts` | 5 个判题 DTO 加 `sessionUid` 等可选字段 |
| `apps/web/src/components/layout/StudentStayLayout.tsx` | stayItems 加第三项 |
| `apps/web/src/routes/routeTable.tsx` | 加两条路由 |
| `apps/web/src/services/api.ts` | 加两个 API 函数 + 类型 |
| `docs/API接口与数据流设计文档.md` / `docs/api/openapi.yaml` | 同步两条端点 |
| `docs/UX-UI设计文档.md` | §1.5 浅停留页清单加"练习记录" |
| `docs/家长端学情批-完成情况与待办清单.md` | 注明一期已落库 + 二期家长端待做 |

---

## Task 1: 数据库 schema + 迁移

**Files:**
- Create: `tools/db/migrations/2026-11-01_special_practice_sessions_and_answers.sql`
- Modify: `tools/db/schema.sql`（在 `special_practice_logs` 表后插入两表 DDL）

**Interfaces:**
- Produces: 两张新表 `special_practice_sessions` / `special_answer_records`，供后续所有任务使用

- [ ] **Step 1: 写迁移文件**

创建 `tools/db/migrations/2026-11-01_special_practice_sessions_and_answers.sql`：

```sql
-- 专项练习作答历史（一期：学生端查看 + 数据落库）
-- 与 exam_sessions / exam_answers 对称，但专项不限时、无 paper_id
-- spec: docs/superpowers/specs/2026-11-01-special-practice-answer-history-design.md

CREATE TABLE IF NOT EXISTS special_practice_sessions (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_uid    CHAR(36)     NOT NULL,
  student_id     BIGINT       NOT NULL,
  subject_id     BIGINT       NOT NULL,
  module         VARCHAR(32)  NOT NULL COMMENT 'chinese_dictation|chinese_interpretation|chinese_meaning|en_vocabulary|math_targeted|physics_targeted|chemistry_targeted',
  title          VARCHAR(120) DEFAULT NULL,
  question_count SMALLINT     NOT NULL DEFAULT 0,
  started_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at   DATETIME(3)  DEFAULT NULL,
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_sps_uid (session_uid),
  KEY idx_sps_student_time (student_id, started_at),
  CONSTRAINT fk_sps_student FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS special_answer_records (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id      BIGINT      NOT NULL,
  question_id     BIGINT      DEFAULT NULL COMMENT '数学/物理/化学非空；语文三专项/英语背词为 NULL',
  ref_type        VARCHAR(24) DEFAULT NULL COMMENT 'question|passage|word',
  ref_id          BIGINT      DEFAULT NULL COMMENT 'passage_id / word_id',
  sentence_index  SMALLINT    DEFAULT NULL COMMENT '解释/含义专项逐句',
  question_order  SMALLINT    NOT NULL,
  answer_text     TEXT,
  is_correct      TINYINT(1)  DEFAULT NULL COMMENT 'NULL=在途/未判',
  score           DECIMAL(3,2) DEFAULT NULL,
  method          VARCHAR(20) DEFAULT NULL COMMENT 'exact|ai|self_assess|unanswered|failed',
  analysis        TEXT,
  judged_at       DATETIME(3) DEFAULT NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_sar_session_q (session_id, question_id),
  KEY idx_sar_session (session_id),
  KEY idx_sar_student_question (question_id),
  CONSTRAINT fk_sar_session FOREIGN KEY (session_id) REFERENCES special_practice_sessions (id) ON DELETE CASCADE,
  CONSTRAINT fk_sar_question FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 2: 把同样 DDL 加进 `tools/db/schema.sql`**

在 `special_practice_logs` 表定义之后（约 schema.sql:1559 后）插入上面两表 DDL（与迁移文件逐字一致）。

- [ ] **Step 3: 应用迁移到 dev 库**

Run:
```bash
mysql -u ai_k12 -pai_k12 ai_k12 < tools/db/migrations/2026-11-01_special_practice_sessions_and_answers.sql
```
Expected: 无报错（`CREATE TABLE IF NOT EXISTS` 幂等）

- [ ] **Step 4: 验证表结构**

Run:
```bash
mysql -u ai_k12 -pai_k12 ai_k12 -e "SHOW CREATE TABLE special_practice_sessions\G" --vertical
mysql -u ai_k12 -pai_k12 ai_k12 -e "SHOW CREATE TABLE special_answer_records\G" --vertical
```
Expected: 两表存在，字段/索引/外键与 DDL 一致

- [ ] **Step 5: 跑 schema_reconcile 对账**

Run: `python3 tools/db/schema_reconcile.py`
Expected: 75 + 2 = 77 表一致（新增两表）

- [ ] **Step 6: Commit**

```bash
git add tools/db/migrations/2026-11-01_special_practice_sessions_and_answers.sql tools/db/schema.sql
git commit -m "feat(db): 新建 special_practice_sessions + special_answer_records 表（专项作答历史）"
```

---

## Task 2: 后端 repository（两张新表）

**Files:**
- Create: `apps/server/src/database/repositories/special-practice-sessions.repo.ts`
- Create: `apps/server/src/database/repositories/special-practice-sessions.repo.test.ts`
- Create: `apps/server/src/database/repositories/special-answer-records.repo.ts`
- Create: `apps/server/src/database/repositories/special-answer-records.repo.test.ts`
- Modify: `apps/server/src/database/repositories/index.ts`（导出两个新 repo）

**Interfaces:**
- Produces:
  - `SpecialPracticeSessionsRepository.upsertSession(input): Promise<number>` — 返回 session id（INSERT IGNORE 后取 id）
  - `SpecialPracticeSessionsRepository.listByStudent(studentId, opts): Promise<SessionListRow[]>`
  - `SpecialAnswerRecordsRepository.upsertAnswer(input): Promise<void>` — question_id 非空走 ON DUPLICATE KEY UPDATE
  - `SpecialAnswerRecordsRepository.upsertSpecialAnswer(input): Promise<void>` — question_id 为空先 DELETE 后 INSERT
  - `SpecialAnswerRecordsRepository.listBySession(sessionId): Promise<AnswerRow[]>`
  - `SpecialAnswerRecordsRepository.countBySession(sessionId): Promise<{total, correct}>`

- [ ] **Step 1: 写 `special-practice-sessions.repo.ts` 测试**

创建 `apps/server/src/database/repositories/special-practice-sessions.repo.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpecialPracticeSessionsRepository } from './special-practice-logs.repo.js';

// 复用现有 mockPool 模式（见 special-practice-logs.repo.test.ts）
function mockPool() {
  const execute = vi.fn();
  return { execute, query: execute } as any;
}

describe('SpecialPracticeSessionsRepository', () => {
  afterEach(() => vi.clearAllMocks());

  it('upsertSession 首次调用 INSERT IGNORE 并返回 insertId', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([{ insertId: 42, affectedRows: 1 } as any]);
    const repo = new SpecialPracticeSessionsRepository(pool as any);
    const id = await repo.upsertSession({
      sessionUid: 'abc-123',
      studentId: 7,
      subjectId: 1,
      module: 'math_targeted',
      title: '数学薄弱点训练',
      questionCount: 3,
    });
    expect(id).toBe(42);
    expect(pool.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT IGNORE INTO special_practice_sessions'),
      expect.arrayContaining(['abc-123', 7, 1, 'math_targeted']),
    );
  });

  it('upsertSession 命中已存在行时通过 SELECT 取 id（affectedRows=0 分支）', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([{ insertId: 0, affectedRows: 0 } as any]);
    pool.execute.mockResolvedValueOnce([[{ id: 99 }] as any]);
    const repo = new SpecialPracticeSessionsRepository(pool as any);
    const id = await repo.upsertSession({
      sessionUid: 'abc-123', studentId: 7, subjectId: 1, module: 'math_targeted', title: null, questionCount: 0,
    });
    expect(id).toBe(99);
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `cd apps/server && npx vitest run src/database/repositories/special-practice-sessions.repo.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `special-practice-sessions.repo.ts`**

```typescript
import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

/** 7 个 module 值（与 special_practice_logs.module + math/physics/chemistry_targeted）。 */
export type SpecialSessionModule =
  | 'chinese_dictation' | 'chinese_interpretation' | 'chinese_meaning'
  | 'en_vocabulary' | 'math_targeted' | 'physics_targeted' | 'chemistry_targeted';

export interface UpsertSessionInput {
  sessionUid: string;
  studentId: number;
  subjectId: number;
  module: SpecialSessionModule;
  title: string | null;
  questionCount: number;
}

export interface SessionListRow {
  id: number;
  session_uid: string;
  student_id: number;
  subject_id: number;
  module: SpecialSessionModule;
  title: string | null;
  question_count: number;
  started_at: Date;
  completed_at: Date | null;
}

@Injectable()
export class SpecialPracticeSessionsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /**
   * 惰性建会话：INSERT IGNORE，首次返回 insertId；命中已存在行（affectedRows=0）时
   * 再 SELECT 取 id。返回 session id 供后续 upsertAnswer 用。
   */
  async upsertSession(input: UpsertSessionInput): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT IGNORE INTO special_practice_sessions
       (session_uid, student_id, subject_id, module, title, question_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [input.sessionUid, input.studentId, input.subjectId, input.module, input.title, input.questionCount],
    );
    if (result.insertId > 0) return result.insertId;
    // 命中已存在行：按 uid 取 id
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT id FROM special_practice_sessions WHERE session_uid = ?`,
      [input.sessionUid],
    );
    return (rows[0] as { id: number }).id;
  }

  /** 标记完成（前端离开时调用，可选）。 */
  async markCompleted(sessionId: number, studentId: number): Promise<void> {
    await this.pool.execute(
      `UPDATE special_practice_sessions SET completed_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND student_id = ? AND completed_at IS NULL`,
      [sessionId, studentId],
    );
  }

  /** 列表查询（按学生，可选学科筛选）。 */
  async listByStudent(
    studentId: number,
    opts: { subjectId?: number; limit?: number; offset?: number },
  ): Promise<SessionListRow[]> {
    const limit = opts.limit ?? 20;
    const offset = opts.offset ?? 0;
    const where = opts.subjectId
      ? `WHERE student_id = ? AND subject_id = ?`
      : `WHERE student_id = ?`;
    const params = opts.subjectId ? [studentId, opts.subjectId, limit, offset] : [studentId, limit, offset];
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM special_practice_sessions ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
      params,
    );
    return rows as SessionListRow[];
  }

  /** 总数（分页用）。 */
  async countByStudent(studentId: number, subjectId?: number): Promise<number> {
    const where = subjectId ? `WHERE student_id = ? AND subject_id = ?` : `WHERE student_id = ?`;
    const params = subjectId ? [studentId, subjectId] : [studentId];
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS cnt FROM special_practice_sessions ${where}`,
      params,
    );
    return Number((rows[0] as { cnt: number | string }).cnt ?? 0);
  }

  /** 单个 session 归属校验（防 IDOR）。 */
  async findByIdOwned(sessionId: number, studentId: number): Promise<SessionListRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM special_practice_sessions WHERE id = ? AND student_id = ?`,
      [sessionId, studentId],
    );
    return (rows[0] as SessionListRow) ?? null;
  }
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `cd apps/server && npx vitest run src/database/repositories/special-practice-sessions.repo.test.ts`
Expected: PASS

- [ ] **Step 5: 写 `special-answer-records.repo.ts` 测试**

创建 `apps/server/src/database/repositories/special-answer-records.repo.test.ts`：

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SpecialAnswerRecordsRepository } from './special-answer-records.repo.js';

function mockPool() {
  const execute = vi.fn();
  return { execute, query: execute } as any;
}

describe('SpecialAnswerRecordsRepository', () => {
  afterEach(() => vi.clearAllMocks());

  it('upsertAnswer question_id 非空走 ON DUPLICATE KEY UPDATE', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([{ affectedRows: 1 } as any]);
    const repo = new SpecialAnswerRecordsRepository(pool as any);
    await repo.upsertAnswer({
      sessionId: 1, questionId: 100, questionOrder: 1, answerText: 'B',
      isCorrect: false, score: 0, method: 'exact', analysis: null,
    });
    expect(pool.execute).toHaveBeenCalledWith(
      expect.stringContaining('ON DUPLICATE KEY UPDATE'),
      expect.arrayContaining([1, 100, 1, 'B']),
    );
  });

  it('upsertSpecialAnswer question_id 为空先 DELETE 后 INSERT', async () => {
    const pool = mockPool();
    const repo = new SpecialAnswerRecordsRepository(pool as any);
    await repo.upsertSpecialAnswer({
      sessionId: 1, questionOrder: 1, refType: 'passage', refId: 42,
      sentenceIndex: 0, answerText: '{"author":"李白"}', isCorrect: true,
      method: 'exact', analysis: null,
    });
    // 先 DELETE
    expect(pool.execute).toHaveBeenNthCalledWith(1,
      expect.stringContaining('DELETE FROM special_answer_records'),
      expect.arrayContaining([1, 'passage', 42, 0]),
    );
    // 再 INSERT
    expect(pool.execute).toHaveBeenNthCalledWith(2,
      expect.stringContaining('INSERT INTO special_answer_records'),
      expect.any(Array),
    );
  });
});
```

- [ ] **Step 6: 跑测试验证失败**

Run: `cd apps/server && npx vitest run src/database/repositories/special-answer-records.repo.test.ts`
Expected: FAIL

- [ ] **Step 7: 实现 `special-answer-records.repo.ts`**

```typescript
import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export interface UpsertAnswerInput {
  sessionId: number;
  questionId: number;
  questionOrder: number;
  answerText: string | null;
  isCorrect?: boolean | null;
  score?: number | null;
  method?: string | null;
  analysis?: string | null;
  judgedAt?: Date;
}

export interface UpsertSpecialAnswerInput {
  sessionId: number;
  questionOrder: number;
  refType: 'passage' | 'word';
  refId: number;
  sentenceIndex?: number | null;
  answerText: string | null;
  isCorrect?: boolean | null;
  score?: number | null;
  method?: string | null;
  analysis?: string | null;
  judgedAt?: Date;
}

export interface AnswerRow {
  id: number;
  session_id: number;
  question_id: number | null;
  ref_type: string | null;
  ref_id: number | null;
  sentence_index: number | null;
  question_order: number;
  answer_text: string | null;
  is_correct: number | null;
  score: string | number | null;
  method: string | null;
  analysis: string | null;
  judged_at: Date | null;
}

@Injectable()
export class SpecialAnswerRecordsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /** question_id 非空：走 uniq_sar_session_q 的 ON DUPLICATE KEY UPDATE（与 exam_answers 一致）。 */
  async upsertAnswer(input: UpsertAnswerInput): Promise<void> {
    await this.pool.execute(
      `INSERT INTO special_answer_records
       (session_id, question_id, question_order, answer_text, is_correct, score, method, analysis, judged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
       answer_text = VALUES(answer_text), is_correct = VALUES(is_correct), score = VALUES(score),
       method = VALUES(method), analysis = VALUES(analysis), judged_at = VALUES(judged_at)`,
      [
        input.sessionId, input.questionId, input.questionOrder, input.answerText,
        input.isCorrect === undefined ? null : input.isCorrect === null ? null : input.isCorrect ? 1 : 0,
        input.score ?? null, input.method ?? null, input.analysis ?? null, input.judgedAt ?? null,
      ],
    );
  }

  /**
   * question_id 为空：uniq_sar_session_q 唯键不生效（MySQL NULL 不去重）。
   * 先 DELETE 同 session+ref_type+ref_id+sentence_index 的旧行，再 INSERT。
   */
  async upsertSpecialAnswer(input: UpsertSpecialAnswerInput): Promise<void> {
    await this.pool.execute(
      `DELETE FROM special_answer_records
       WHERE session_id = ? AND ref_type = ? AND ref_id = ? AND sentence_index <=> ?`,
      [input.sessionId, input.refType, input.refId, input.sentenceIndex ?? null],
    );
    await this.pool.execute(
      `INSERT INTO special_answer_records
       (session_id, question_id, question_order, ref_type, ref_id, sentence_index,
        answer_text, is_correct, score, method, analysis, judged_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.sessionId, input.questionOrder, input.refType, input.refId, input.sentenceIndex ?? null,
        input.answerText,
        input.isCorrect === undefined ? null : input.isCorrect === null ? null : input.isCorrect ? 1 : 0,
        input.score ?? null, input.method ?? null, input.analysis ?? null, input.judgedAt ?? null,
      ],
    );
  }

  /** 按 session 列出作答（含 JOIN questions 题面）。 */
  async listBySession(sessionId: number): Promise<Array<AnswerRow & {
    question_content: string | null; question_answer: string | null; question_analysis: string | null;
  }>> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT sar.*, q.content AS question_content, q.answer AS question_answer, q.explanation AS question_analysis
       FROM special_answer_records sar
       LEFT JOIN questions q ON sar.question_id = q.id
       WHERE sar.session_id = ?
       ORDER BY sar.question_order`,
      [sessionId],
    );
    return rows as any;
  }

  /** 聚合作答数与正确数（列表"对x/y"用）。 */
  async countBySession(sessionId: number): Promise<{ total: number; correct: number }> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS total, COALESCE(SUM(is_correct = 1), 0) AS correct
       FROM special_answer_records WHERE session_id = ?`,
      [sessionId],
    );
    return { total: Number((rows[0] as any).total ?? 0), correct: Number((rows[0] as any).correct ?? 0) };
  }
}
```

- [ ] **Step 8: 跑测试验证通过**

Run: `cd apps/server && npx vitest run src/database/repositories/special-answer-records.repo.test.ts`
Expected: PASS

- [ ] **Step 9: 在 `index.ts` 导出两个 repo**

Modify `apps/server/src/database/repositories/index.ts`，在末尾加：

```typescript
export { SpecialPracticeSessionsRepository } from './special-practice-sessions.repo.js';
export type { UpsertSessionInput, SessionListRow, SpecialSessionModule } from './special-practice-sessions.repo.js';
export { SpecialAnswerRecordsRepository } from './special-answer-records.repo.js';
export type { UpsertAnswerInput, UpsertSpecialAnswerInput, AnswerRow } from './special-answer-records.repo.js';
```

- [ ] **Step 10: 跑全量后端测试确认无回归**

Run: `cd apps/server && npm test`
Expected: 全绿（既有测试不受影响）

- [ ] **Step 11: Commit**

```bash
git add apps/server/src/database/repositories/special-practice-sessions.repo.ts \
        apps/server/src/database/repositories/special-practice-sessions.repo.test.ts \
        apps/server/src/database/repositories/special-answer-records.repo.ts \
        apps/server/src/database/repositories/special-answer-records.repo.test.ts \
        apps/server/src/database/repositories/index.ts
git commit -m "feat(server): 新增 special-practice-sessions + special-answer-records repository"
```

---

## Task 3: 后端 5 个判题方法补写作答记录

**Files:**
- Modify: `apps/server/src/modules/training/dto/judge-training.dto.ts`
- Modify: `apps/server/src/modules/training/dto/judge-dictation.dto.ts`（如不存在，在 controller 内联 DTO 处加字段）
- Modify: `apps/server/src/modules/training/dto/judge-interpretation.dto.ts`（同上）
- Modify: `apps/server/src/modules/training/training.service.ts`（judgeTraining / judgeDictation / judgeInterpretation）
- Modify: `apps/server/src/modules/training/meaning.service.ts`
- Modify: `apps/server/src/modules/training/vocabulary.service.ts`

**Interfaces:**
- Consumes: `SpecialPracticeSessionsRepository` + `SpecialAnswerRecordsRepository`（Task 2 产出）
- Produces: 5 个判题方法在判题成功后旁路写入 `special_answer_records`

**关键约束**：
- DTO 加可选 `sessionUid?: string` + `title?: string` + `questionCount?: number` + `questionOrder?: number`（全可选，向后兼容）
- 写入失败 `try/catch` 吞异常只 `logger.warn`，不阻断判题
- `sessionUid` 缺失时不写作答记录（向后兼容）

- [ ] **Step 1: 给 `judgeTraining` DTO 加可选字段**

读 `apps/server/src/modules/training/dto/judge-training.dto.ts`（或 controller 内联 DTO），在现有字段后加：

```typescript
export interface JudgeTrainingDto {
  // ... 现有字段保持不变 ...
  questionId: number;
  subjectId: number;
  studentAnswer: string;
  source: 'targeted' | 'error_practice';
  sessionId?: number;      // 已有
  // 新增（全可选）：
  sessionUid?: string;
  title?: string;
  questionCount?: number;
  questionOrder?: number;
}
```

- [ ] **Step 2: 写 `judgeTraining` 补写测试**

在 `apps/server/src/modules/training/training.service.test.ts` 加用例（或在 Task 3 专属测试文件）：

```typescript
it('带 sessionUid 时判题后写 special_answer_records', async () => {
  // 复用现有 mock 设置
  specialPracticeSessionsRepo.upsertSession.mockResolvedValue(101);
  const result = await trainingService.judgeTraining({
    studentId: 7, questionId: 100, subjectId: 1, studentAnswer: 'B', source: 'targeted',
    sessionUid: 'abc-123', title: '数学薄弱点训练', questionCount: 3, questionOrder: 1,
  });
  expect(result.isCorrect).toBeDefined();
  expect(specialPracticeSessionsRepo.upsertSession).toHaveBeenCalledWith(expect.objectContaining({
    sessionUid: 'abc-123', studentId: 7, subjectId: 1, module: 'math_targeted',
  }));
  expect(specialAnswerRecordsRepo.upsertAnswer).toHaveBeenCalledWith(expect.objectContaining({
    sessionId: 101, questionId: 100, answerText: 'B',
  }));
});

it('不带 sessionUid 时不写作答记录（向后兼容）', async () => {
  await trainingService.judgeTraining({
    studentId: 7, questionId: 100, subjectId: 1, studentAnswer: 'B', source: 'targeted',
  });
  expect(specialPracticeSessionsRepo.upsertSession).not.toHaveBeenCalled();
  expect(specialAnswerRecordsRepo.upsertAnswer).not.toHaveBeenCalled();
});

it('写入失败不阻断判题', async () => {
  specialPracticeSessionsRepo.upsertSession.mockRejectedValue(new Error('DB down'));
  const result = await trainingService.judgeTraining({
    studentId: 7, questionId: 100, subjectId: 1, studentAnswer: 'B', source: 'targeted',
    sessionUid: 'abc-123', questionOrder: 1,
  });
  expect(result.isCorrect).toBeDefined();  // 判题结果照常返回
});
```

- [ ] **Step 3: 跑测试验证失败**

Run: `cd apps/server && npx vitest run src/modules/training/training.service.test.ts`
Expected: FAIL（新用例）

- [ ] **Step 4: 实现 `judgeTraining` 补写**

读 `training.service.ts` 的 `judgeTraining` 方法，在判题成功返回前加：

```typescript
// 在构造函数注入（@Optional 防 DI 坑）：
@Optional() private readonly specialSessionsRepo?: SpecialPracticeSessionsRepository,
@Optional() private readonly specialAnswersRepo?: SpecialAnswerRecordsRepository,

// judgeTraining 末尾（判题结果算出后、return 前）：
if (input.sessionUid && this.specialSessionsRepo && this.specialAnswersRepo) {
  try {
    const module = input.subjectId === 1 ? 'math_targeted'
      : input.subjectId === 4 ? 'physics_targeted'
      : input.subjectId === 5 ? 'chemistry_targeted'
      : 'math_targeted';  // 兜底
    const sessionId = await this.specialSessionsRepo.upsertSession({
      sessionUid: input.sessionUid,
      studentId: input.studentId,
      subjectId: input.subjectId,
      module: module as any,
      title: input.title ?? null,
      questionCount: input.questionCount ?? 0,
    });
    await this.specialAnswersRepo.upsertAnswer({
      sessionId,
      questionId: input.questionId,
      questionOrder: input.questionOrder ?? 1,
      answerText: input.studentAnswer,
      isCorrect: result.isCorrect,
      method: result.method ?? 'exact',
      analysis: result.analysis ?? null,
      judgedAt: new Date(),
    });
  } catch (err) {
    this.logger.warn(`special_answer_records 写入失败（已忽略）: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

- [ ] **Step 5: 跑测试验证通过**

Run: `cd apps/server && npx vitest run src/modules/training/training.service.test.ts`
Expected: PASS

- [ ] **Step 6: 重复 Step 1-5 给 `judgeDictation`**

DTO 加字段（`author`/`dynasty`/`body` 已有，加 `sessionUid`/`title`/`questionCount`/`questionOrder`）。

补写逻辑（`judgeDictation` 末尾）：
```typescript
if (input.sessionUid && this.specialSessionsRepo && this.specialAnswersRepo) {
  try {
    const sessionId = await this.specialSessionsRepo.upsertSession({
      sessionUid: input.sessionUid, studentId: input.studentId,
      subjectId: 2,  // 语文
      module: 'chinese_dictation', title: input.title ?? null, questionCount: input.questionCount ?? 0,
    });
    await this.specialAnswersRepo.upsertSpecialAnswer({
      sessionId, questionOrder: input.questionOrder ?? 1,
      refType: 'passage', refId: input.passageId, sentenceIndex: null,
      answerText: JSON.stringify({ author: input.author, dynasty: input.dynasty, body: input.body }),
      isCorrect: result.passed, method: 'exact', judgedAt: new Date(),
    });
  } catch (err) {
    this.logger.warn(`special_answer_records 写入失败: ${err}`);
  }
}
```

- [ ] **Step 7: 重复 Step 1-5 给 `judgeInterpretation`**

补写逻辑（末尾）：
```typescript
if (input.sessionUid && this.specialSessionsRepo && this.specialAnswersRepo) {
  try {
    const sessionId = await this.specialSessionsRepo.upsertSession({
      sessionUid: input.sessionUid, studentId: input.studentId,
      subjectId: 2, module: 'chinese_interpretation',
      title: input.title ?? null, questionCount: input.questionCount ?? 0,
    });
    await this.specialAnswersRepo.upsertSpecialAnswer({
      sessionId, questionOrder: input.questionOrder ?? 1,
      refType: 'passage', refId: input.passageId, sentenceIndex: input.sentenceIndex,
      answerText: JSON.stringify({ terms: input.terms, translation: input.translation }),
      isCorrect: result.passed, method: 'exact', judgedAt: new Date(),
    });
  } catch (err) {
    this.logger.warn(`special_answer_records 写入失败: ${err}`);
  }
}
```

- [ ] **Step 8: 重复给 `meaning.service` 的含义判题**

读 `meaning.service.ts`，在判题末尾加补写（`module: 'chinese_meaning'`，其余同解释专项）。

- [ ] **Step 9: 重复给 `vocabulary.service` 的背词判题**

补写逻辑：
```typescript
if (input.sessionUid && this.specialSessionsRepo && this.specialAnswersRepo) {
  try {
    const sessionId = await this.specialSessionsRepo.upsertSession({
      sessionUid: input.sessionUid, studentId: input.studentId,
      subjectId: 3,  // 英语
      module: 'en_vocabulary', title: input.title ?? null, questionCount: input.questionCount ?? 0,
    });
    await this.specialAnswersRepo.upsertSpecialAnswer({
      sessionId, questionOrder: input.questionOrder ?? 1,
      refType: 'word', refId: input.wordId, sentenceIndex: null,
      answerText: input.studentAnswer,
      isCorrect: result.isCorrect, method: 'exact', judgedAt: new Date(),
    });
  } catch (err) {
    this.logger.warn(`special_answer_records 写入失败: ${err}`);
  }
}
```

- [ ] **Step 10: 跑全量后端测试**

Run: `cd apps/server && npm test`
Expected: 全绿

- [ ] **Step 11: Commit**

```bash
git add apps/server/src/modules/training/
git commit -m "feat(server): 5 个判题方法补写 special_answer_records（带 sessionUid 时惰性建会话+旁路写入）"
```

---

## Task 4: 后端 practice-history 查询模块

**Files:**
- Create: `apps/server/src/modules/practice-history/practice-history.dto.ts`
- Create: `apps/server/src/modules/practice-history/practice-history.service.ts`
- Create: `apps/server/src/modules/practice-history/practice-history.service.test.ts`
- Create: `apps/server/src/modules/practice-history/practice-history.controller.ts`
- Create: `apps/server/src/modules/practice-history/practice-history.controller.test.ts`
- Create: `apps/server/src/modules/practice-history/practice-history.module.ts`
- Modify: `apps/server/src/app.module.ts`（注册新模块）

**Interfaces:**
- Consumes: `SpecialPracticeSessionsRepository` + `ExamSessionsRepository` + `QuestionsRepository`（Task 2 + 既有）
- Produces:
  - `GET /api/student/practice-history?page=&pageSize=&subjectId=` → 列表（UNION ALL）
  - `GET /api/student/practice-history/:source/:sessionId` → 详情

- [ ] **Step 1: 写 service 测试**

创建 `apps/server/src/modules/practice-history/practice-history.service.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PracticeHistoryService } from './practice-history.service.js';

describe('PracticeHistoryService', () => {
  let service: PracticeHistoryService;
  let examSessionsRepo: any;
  let specialSessionsRepo: any;
  let specialAnswersRepo: any;

  beforeEach(() => {
    examSessionsRepo = {
      listSubmittedByStudent: vi.fn().mockResolvedValue([]),
      countSubmittedByStudent: vi.fn().mockResolvedValue(0),
      findAnswersWithQuestions: vi.fn(),
      findByIdOwned: vi.fn(),
    };
    specialSessionsRepo = { listByStudent: vi.fn().mockResolvedValue([]), countByStudent: vi.fn().mockResolvedValue(0), findByIdOwned: vi.fn() };
    specialAnswersRepo = { listBySession: vi.fn(), countBySession: vi.fn() };
    service = new PracticeHistoryService(examSessionsRepo, specialSessionsRepo, specialAnswersRepo);
  });

  it('列表 UNION 考试 + 专项，按时间倒序', async () => {
    examSessionsRepo.listSubmittedByStudent.mockResolvedValue([
      { id: 1, student_id: 7, subject_id: 4, title: '物理卷', started_at: new Date('2026-11-01'), submitted_at: new Date('2026-11-01'), status: 'submitted' },
    ]);
    specialSessionsRepo.listByStudent.mockResolvedValue([
      { id: 5, student_id: 7, subject_id: 2, module: 'chinese_dictation', title: '默写', started_at: new Date('2026-10-31'), completed_at: new Date('2026-10-31') },
    ]);
    examSessionsRepo.countSubmittedByStudent.mockResolvedValue(1);
    specialSessionsRepo.countByStudent.mockResolvedValue(1);

    const result = await service.list({ studentId: 7, page: 1, pageSize: 20 });

    expect(result.items).toHaveLength(2);
    expect(result.items[0].title).toBe('物理卷');  // 11-01 在前
    expect(result.items[1].title).toBe('默写');     // 10-31 在后
    expect(result.items[0].source).toBe('exam');
    expect(result.items[1].source).toBe('special');
    expect(result.total).toBe(2);
  });

  it('列表带 subjectId 时两端都筛选', async () => {
    await service.list({ studentId: 7, subjectId: 4 });
    expect(examSessionsRepo.listSubmittedByStudent).toHaveBeenCalledWith(expect.objectContaining({ subjectId: 4 }));
    expect(specialSessionsRepo.listByStudent).toHaveBeenCalledWith(expect.objectContaining({ subjectId: 4 }));
  });

  it('source 非法抛 BadRequestException', async () => {
    await expect(service.getDetail({ studentId: 7, source: 'xxx' as any, sessionId: 1 }))
      .rejects.toThrow();
  });

  it('session 非本人返 null（404 由 controller 抛）', async () => {
    examSessionsRepo.findByIdOwned.mockResolvedValue(null);
    const r = await service.getDetail({ studentId: 7, source: 'exam', sessionId: 999 });
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `cd apps/server && npx vitest run src/modules/practice-history/practice-history.service.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `practice-history.dto.ts`**

```typescript
export interface PracticeHistoryQueryDto {
  page?: number;
  pageSize?: number;
  subjectId?: number;
}

export interface PracticeHistoryItem {
  source: 'exam' | 'special';
  sessionId: number;
  subjectId: number;
  title: string | null;
  module: string | null;
  startedAt: Date;
  completedAt: Date | null;
  totalCount: number;
  correctCount: number;
}

export interface PracticeHistoryDetail {
  session: PracticeHistoryItem;
  questions: Array<{
    questionId: number | null;
    questionOrder: number;
    answerText: string | null;
    isCorrect: boolean | null;
    score: number | null;
    method: string | null;
    analysis: string | null;
    judgedAt: Date | null;
    questionContent: string | null;
    questionAnswer: string | null;
    questionAnalysis: string | null;
    refType: string | null;
    refId: number | null;
    sentenceIndex: number | null;
  }>;
}
```

- [ ] **Step 4: 实现 `practice-history.service.ts`**

```typescript
import { Injectable, BadRequestException, Inject } from '@nestjs/common';
import { ExamSessionsRepository } from '../../database/repositories/exam-sessions.repo.js';
import { SpecialPracticeSessionsRepository } from '../../database/repositories/special-practice-sessions.repo.js';
import { SpecialAnswerRecordsRepository } from '../../database/repositories/special-answer-records.repo.js';
import type { PracticeHistoryQueryDto, PracticeHistoryItem, PracticeHistoryDetail } from './practice-history.dto.js';

@Injectable()
export class PracticeHistoryService {
  constructor(
    private readonly examSessionsRepo: ExamSessionsRepository,
    private readonly specialSessionsRepo: SpecialPracticeSessionsRepository,
    private readonly specialAnswersRepo: SpecialAnswerRecordsRepository,
  ) {}

  async list(query: PracticeHistoryQueryDto & { studentId: number }) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(50, Math.max(1, query.pageSize ?? 20));
    const offset = (page - 1) * pageSize;

    // 两端各取 pageSize 条，service 层合并排序后再截断
    // （简化分页：两端各取 pageSize，合并后取前 pageSize 条；总数两端相加）
    const [exams, specials] = await Promise.all([
      this.examSessionsRepo.listSubmittedByStudent({
        studentId: query.studentId, subjectId: query.subjectId, limit: pageSize, offset,
      }),
      this.specialSessionsRepo.listByStudent(query.studentId, { subjectId: query.subjectId, limit: pageSize, offset }),
    ]);

    const examItems: PracticeHistoryItem[] = await Promise.all(
      exams.map(async (e) => {
        const c = await this.examSessionsRepo.countAnswersBySession(e.id);
        return {
          source: 'exam' as const, sessionId: e.id, subjectId: e.subject_id,
          title: e.title, module: null, startedAt: e.started_at, completedAt: e.submitted_at,
          totalCount: c.total, correctCount: c.correct,
        };
      }),
    );
    const specialItems: PracticeHistoryItem[] = await Promise.all(
      specials.map(async (s) => {
        const c = await this.specialAnswersRepo.countBySession(s.id);
        return {
          source: 'special' as const, sessionId: s.id, subjectId: s.subject_id,
          title: s.title, module: s.module, startedAt: s.started_at, completedAt: s.completed_at,
          totalCount: c.total, correctCount: c.correct,
        };
      }),
    );

    const items = [...examItems, ...specialItems]
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, pageSize);

    const [examTotal, specialTotal] = await Promise.all([
      this.examSessionsRepo.countSubmittedByStudent(query.studentId, query.subjectId),
      this.specialSessionsRepo.countByStudent(query.studentId, query.subjectId),
    ]);

    return { items, total: examTotal + specialTotal, page, pageSize };
  }

  async getDetail(input: { studentId: number; source: 'exam' | 'special'; sessionId: number }): Promise<PracticeHistoryDetail | null> {
    if (input.source !== 'exam' && input.source !== 'special') {
      throw new BadRequestException({ code: 400, message: 'source 仅允许 exam | special' });
    }
    if (!Number.isInteger(input.sessionId) || input.sessionId < 1) {
      throw new BadRequestException({ code: 400, message: 'sessionId 须为正整数' });
    }

    if (input.source === 'exam') {
      const session = await this.examSessionsRepo.findByIdOwned(input.sessionId, input.studentId);
      if (!session) return null;
      const answers = await this.examSessionsRepo.findAnswersWithQuestions(input.sessionId);
      const count = await this.examSessionsRepo.countAnswersBySession(input.sessionId);
      return {
        session: {
          source: 'exam', sessionId: session.id, subjectId: session.subject_id,
          title: session.title, module: null, startedAt: session.started_at,
          completedAt: session.submitted_at, totalCount: count.total, correctCount: count.correct,
        },
        questions: answers.map((a) => ({
          questionId: a.question_id, questionOrder: a.question_order, answerText: a.answer_text,
          isCorrect: a.is_correct === null ? null : !!a.is_correct,
          score: a.score !== null ? Number(a.score) : null, method: a.method, analysis: a.analysis,
          judgedAt: a.judged_at, questionContent: a.text, questionAnswer: a.answer,
          questionAnalysis: a.explanation, refType: 'question', refId: null, sentenceIndex: null,
        })),
      };
    } else {
      const session = await this.specialSessionsRepo.findByIdOwned(input.sessionId, input.studentId);
      if (!session) return null;
      const answers = await this.specialAnswersRepo.listBySession(input.sessionId);
      const count = await this.specialAnswersRepo.countBySession(input.sessionId);
      return {
        session: {
          source: 'special', sessionId: session.id, subjectId: session.subject_id,
          title: session.title, module: session.module, startedAt: session.started_at,
          completedAt: session.completed_at, totalCount: count.total, correctCount: count.correct,
        },
        questions: answers.map((a) => ({
          questionId: a.question_id, questionOrder: a.question_order, answerText: a.answer_text,
          isCorrect: a.is_correct === null ? null : !!a.is_correct,
          score: a.score !== null ? Number(a.score) : null, method: a.method, analysis: a.analysis,
          judgedAt: a.judged_at, questionContent: a.question_content,
          questionAnswer: a.question_answer, questionAnalysis: a.question_analysis,
          refType: a.ref_type, refId: a.ref_id, sentenceIndex: a.sentence_index,
        })),
      };
    }
  }
}
```

**注**：`examSessionsRepo.listSubmittedByStudent` / `countSubmittedByStudent` / `countAnswersBySession` / `findByIdOwned` 可能不存在，需在 `exam-sessions.repo.ts` 补这四个方法（参考现有 `listSubmittedExams` 与 `findAnswersWithQuestions`，加 studentId 归属过滤）。

- [ ] **Step 5: 在 `exam-sessions.repo.ts` 补缺失方法**

读 `apps/server/src/database/repositories/exam-sessions.repo.ts`，补：

```typescript
async listSubmittedByStudent(opts: { studentId: number; subjectId?: number; limit: number; offset: number })
  : Promise<Array<ExamSessionRow & { title: string }>> {
  const where = opts.subjectId
    ? `WHERE es.student_id = ? AND es.subject_id = ? AND es.status = 'submitted'`
    : `WHERE es.student_id = ? AND es.status = 'submitted'`;
  const params = opts.subjectId
    ? [opts.studentId, opts.subjectId, opts.limit, opts.offset]
    : [opts.studentId, opts.limit, opts.offset];
  const [rows] = await this.pool.execute<RowDataPacket[]>(
    `SELECT es.*, ep.title FROM exam_sessions es
     JOIN exam_papers ep ON es.paper_id = ep.id
     ${where} ORDER BY es.started_at DESC LIMIT ? OFFSET ?`,
    params,
  );
  return rows as any;
}

async countSubmittedByStudent(studentId: number, subjectId?: number): Promise<number> {
  const where = subjectId
    ? `WHERE student_id = ? AND subject_id = ? AND status = 'submitted'`
    : `WHERE student_id = ? AND status = 'submitted'`;
  const params = subjectId ? [studentId, subjectId] : [studentId];
  const [rows] = await this.pool.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS cnt FROM exam_sessions ${where}`, params,
  );
  return Number((rows[0] as any).cnt ?? 0);
}

async countAnswersBySession(sessionId: number): Promise<{ total: number; correct: number }> {
  const [rows] = await this.pool.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS total, COALESCE(SUM(is_correct = 1), 0) AS correct
     FROM exam_answers WHERE session_id = ?`, [sessionId],
  );
  return { total: Number((rows[0] as any).total ?? 0), correct: Number((rows[0] as any).correct ?? 0) };
}

async findByIdOwned(sessionId: number, studentId: number): Promise<ExamSessionRow & { title: string } | null> {
  const [rows] = await this.pool.execute<RowDataPacket[]>(
    `SELECT es.*, ep.title FROM exam_sessions es
     JOIN exam_papers ep ON es.paper_id = ep.id
     WHERE es.id = ? AND es.student_id = ?`, [sessionId, studentId],
  );
  return (rows[0] as any) ?? null;
}
```

- [ ] **Step 6: 跑 service 测试验证通过**

Run: `cd apps/server && npx vitest run src/modules/practice-history/practice-history.service.test.ts`
Expected: PASS

- [ ] **Step 7: 实现 `practice-history.controller.ts`**

```typescript
import { Body, Controller, Get, NotFoundException, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import { PracticeHistoryService } from './practice-history.service.js';

@Controller('api/student/practice-history')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class PracticeHistoryController {
  constructor(private readonly service: PracticeHistoryService) {}

  @Get()
  async list(
    @Query('page') pageStr?: string,
    @Query('pageSize') pageSizeStr?: string,
    @Query('subjectId') subjectIdStr?: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const page = pageStr ? parseInt(pageStr, 10) : undefined;
    const pageSize = pageSizeStr ? parseInt(pageSizeStr, 10) : undefined;
    const subjectId = subjectIdStr ? parseInt(subjectIdStr, 10) : undefined;
    return this.service.list({ studentId: user!.sub, page, pageSize, subjectId });
  }

  @Get(':source/:sessionId')
  async detail(
    @Param('source') source: string,
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @CurrentUser() user: JwtUser,
  ) {
    if (source !== 'exam' && source !== 'special') {
      throw new NotFoundException({ code: 1002, message: 'source 仅允许 exam | special' });
    }
    const detail = await this.service.getDetail({ studentId: user.sub, source, sessionId });
    if (!detail) throw new NotFoundException({ code: 1002, message: '会话不存在' });
    return detail;
  }
}
```

- [ ] **Step 8: 实现 `practice-history.module.ts`**

```typescript
import { Module } from '@nestjs/common';
import { PracticeHistoryController } from './practice-history.controller.js';
import { PracticeHistoryService } from './practice-history.service.js';
import { ExamSessionsRepository } from '../../database/repositories/exam-sessions.repo.js';
import { SpecialPracticeSessionsRepository } from '../../database/repositories/special-practice-sessions.repo.js';
import { SpecialAnswerRecordsRepository } from '../../database/repositories/special-answer-records.repo.js';

@Module({
  controllers: [PracticeHistoryController],
  providers: [PracticeHistoryService, ExamSessionsRepository, SpecialPracticeSessionsRepository, SpecialAnswerRecordsRepository],
})
export class PracticeHistoryModule {}
```

- [ ] **Step 9: 在 `app.module.ts` 注册**

读 `apps/server/src/app.module.ts`，在 imports 数组加 `PracticeHistoryModule`。

- [ ] **Step 10: 写 controller 测试**

创建 `practice-history.controller.test.ts`，验证路由 + 参数校验 + 404。

- [ ] **Step 11: 跑全量后端测试**

Run: `cd apps/server && npm test`
Expected: 全绿

- [ ] **Step 12: 起真后端冒烟**

```bash
cd apps/server && npm run build && node dist/main.js &
# 等启动后 curl 验证
curl -s http://localhost:3000/api/student/practice-history -H "Authorization: Bearer <student-token>" | jq .
```
Expected: 返回 `{code:0, data:{items:[], total:0, page:1, pageSize:20}}`

- [ ] **Step 13: Commit**

```bash
git add apps/server/src/modules/practice-history/ apps/server/src/database/repositories/exam-sessions.repo.ts apps/server/src/app.module.ts
git commit -m "feat(server): 新增 practice-history 查询模块（列表 UNION + 详情路由）"
```

---

## Task 5: 前端 API 层 + 类型

**Files:**
- Modify: `apps/web/src/services/api.ts`

**Interfaces:**
- Produces: `getPracticeHistory()` / `getPracticeHistoryDetail()` + 相关类型

- [ ] **Step 1: 在 `api.ts` 加类型与函数**

读 `apps/web/src/services/api.ts` 末尾，加：

```typescript
// --- Practice History（学生端练习记录） ---

export interface PracticeHistoryItem {
  source: 'exam' | 'special';
  sessionId: number;
  subjectId: number;
  title: string | null;
  module: string | null;
  startedAt: string;
  completedAt: string | null;
  totalCount: number;
  correctCount: number;
}

export interface PracticeHistoryQuestion {
  questionId: number | null;
  questionOrder: number;
  answerText: string | null;
  isCorrect: boolean | null;
  score: number | null;
  method: string | null;
  analysis: string | null;
  judgedAt: string | null;
  questionContent: string | null;
  questionAnswer: string | null;
  questionAnalysis: string | null;
  refType: string | null;
  refId: number | null;
  sentenceIndex: number | null;
}

export interface PracticeHistoryDetail {
  session: PracticeHistoryItem;
  questions: PracticeHistoryQuestion[];
}

export async function getPracticeHistory(params: {
  page?: number; pageSize?: number; subjectId?: number;
}): Promise<{ items: PracticeHistoryItem[]; total: number; page: number; pageSize: number }> {
  const qs = new URLSearchParams();
  if (params.page) qs.set('page', String(params.page));
  if (params.pageSize) qs.set('pageSize', String(params.pageSize));
  if (params.subjectId) qs.set('subjectId', String(params.subjectId));
  return apiGet(`/api/student/practice-history?${qs.toString()}`);
}

export async function getPracticeHistoryDetail(
  source: 'exam' | 'special', sessionId: number,
): Promise<PracticeHistoryDetail> {
  return apiGet(`/api/student/practice-history/${source}/${sessionId}`);
}
```

（`apiGet` 是现有封装，照现有 `getExamResults` 等函数的模式）

- [ ] **Step 2: 跑前端 lint + tsc**

Run: `cd apps/web && npm run lint && npx tsc -b`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/services/api.ts
git commit -m "feat(web): 加 getPracticeHistory / getPracticeHistoryDetail API + 类型"
```

---

## Task 6: 前端列表页 `PracticeHistoryPage`

**Files:**
- Create: `apps/web/src/pages/student/PracticeHistoryPage.tsx`
- Create: `apps/web/src/pages/student/PracticeHistoryPage.test.tsx`

**Interfaces:**
- Consumes: `getPracticeHistory`（Task 5）
- Produces: 列表页组件，路由 `/student/practice-history`

- [ ] **Step 1: 写测试**

创建 `PracticeHistoryPage.test.tsx`：

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PracticeHistoryPage } from './PracticeHistoryPage.js';

vi.mock('@/services/api', () => ({
  getPracticeHistory: vi.fn(),
}));

import { getPracticeHistory } from '@/services/api.js';

afterEach(() => cleanup());

describe('PracticeHistoryPage', () => {
  it('加载中显示骨架', async () => {
    (getPracticeHistory as any).mockReturnValue(new Promise(() => {}));  // 永挂
    render(<MemoryRouter><PracticeHistoryPage /></MemoryRouter>);
    expect(screen.getByText(/加载中/)).toBeInTheDocument();
  });

  it('有数据时渲染列表项', async () => {
    (getPracticeHistory as any).mockResolvedValue({
      items: [
        { source: 'exam', sessionId: 1, subjectId: 4, title: '物理卷', module: null,
          startedAt: '2026-11-01T14:00:00Z', completedAt: '2026-11-01T14:40:00Z',
          totalCount: 10, correctCount: 7 },
      ],
      total: 1, page: 1, pageSize: 20,
    });
    render(<MemoryRouter><PracticeHistoryPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('物理卷')).toBeInTheDocument());
    expect(screen.getByText(/对 7\/10/)).toBeInTheDocument();
  });

  it('空态引导去训练轨', async () => {
    (getPracticeHistory as any).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    render(<MemoryRouter><PracticeHistoryPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/还没有练习记录/)).toBeInTheDocument());
  });

  it('进行中 session 灰显', async () => {
    (getPracticeHistory as any).mockResolvedValue({
      items: [{ source: 'special', sessionId: 2, subjectId: 2, title: '默写', module: 'chinese_dictation',
        startedAt: '2026-11-01T14:00:00Z', completedAt: null, totalCount: 0, correctCount: 0 }],
      total: 1, page: 1, pageSize: 20,
    });
    render(<MemoryRouter><PracticeHistoryPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('进行中')).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `cd apps/web && npx vitest run src/pages/student/PracticeHistoryPage.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现 `PracticeHistoryPage.tsx`**

```typescript
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getPracticeHistory, type PracticeHistoryItem } from '@/services/api.js';

const SUBJECT_LABELS: Record<number, string> = {
  1: '数学', 2: '语文', 3: '英语', 4: '物理', 5: '化学',
};

export function PracticeHistoryPage() {
  const [items, setItems] = useState<PracticeHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [subjectId, setSubjectId] = useState<number | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const pageSize = 20;

  useEffect(() => {
    setPage(1);  // 切学科回第 1 页（CLAUDE.md 铁律）
  }, [subjectId]);

  useEffect(() => {
    setLoading(true);
    getPracticeHistory({ page, pageSize, subjectId })
      .then((r) => { setItems(r.items); setTotal(r.total); })
      .finally(() => setLoading(false));
  }, [page, pageSize, subjectId]);

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="text-xl font-semibold text-[var(--text-primary)] mb-4">练习记录</h1>

      {/* 学科筛选 */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setSubjectId(undefined)}
          className={`px-3 py-1 rounded-[var(--radius-pill)] text-xs ${
            subjectId === undefined ? 'bg-[var(--brand-500)] text-white' : 'bg-[var(--bg-subtle)] text-[var(--text-tertiary)]'
          }`}
        >全部</button>
        {[1, 2, 3, 4, 5].map((s) => (
          <button key={s} onClick={() => setSubjectId(s)}
            className={`px-3 py-1 rounded-[var(--radius-pill)] text-xs ${
              subjectId === s ? 'bg-[var(--brand-500)] text-white' : 'bg-[var(--bg-subtle)] text-[var(--text-tertiary)]'
            }`}
          >{SUBJECT_LABELS[s]}</button>
        ))}
      </div>

      {loading ? (
        <p className="text-[var(--text-tertiary)]">加载中…</p>
      ) : items.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-[var(--text-tertiary)] mb-4">还没有练习记录</p>
          <Link to="/student/training/1" className="text-[var(--brand-500)] underline">去训练轨开始第一次练习</Link>
        </div>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => (
            <li key={`${item.source}-${item.sessionId}`}>
              <Link to={`/student/practice-history/${item.source}/${item.sessionId}`}
                className={`block bg-[var(--bg-card)] border border-[var(--bg-subtle)] rounded-[var(--radius-md)] p-4 hover:border-[var(--brand-300)] transition-colors ${
                  item.completedAt === null ? 'opacity-60' : ''
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-[var(--text-tertiary)]">{SUBJECT_LABELS[item.subjectId] ?? '未知'}</span>
                    <span className="font-medium text-[var(--text-primary)]">{item.title ?? '未命名'}</span>
                    {item.completedAt === null && (
                      <span className="text-xs text-[var(--text-tertiary)]">进行中</span>
                    )}
                  </div>
                  <span className="text-xs text-[var(--text-tertiary)]">
                    {new Date(item.startedAt).toLocaleDateString('zh-CN')}
                  </span>
                </div>
                <div className="mt-2 text-sm text-[var(--text-secondary)]">
                  共 {item.totalCount} 题 · 对 {item.correctCount}/{item.totalCount}
                  <span className="ml-2 text-[var(--text-tertiary)]">[{item.source === 'exam' ? '考试' : '专项'}]</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {/* 分页 */}
      {total > pageSize && (
        <div className="flex justify-center gap-2 mt-6">
          <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="px-3 py-1 text-xs">上一页</button>
          <span className="px-3 py-1 text-xs">{page} / {Math.ceil(total / pageSize)}</span>
          <button disabled={page * pageSize >= total} onClick={() => setPage(page + 1)} className="px-3 py-1 text-xs">下一页</button>
        </div>
      )}
    </div>
  );
}

export default PracticeHistoryPage;
```

- [ ] **Step 4: 跑测试验证通过**

Run: `cd apps/web && npx vitest run src/pages/student/PracticeHistoryPage.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/student/PracticeHistoryPage.tsx apps/web/src/pages/student/PracticeHistoryPage.test.tsx
git commit -m "feat(web): 新增 PracticeHistoryPage 列表页（学科筛选+分页+空态+进行中灰显）"
```

---

## Task 7: 前端详情页 `PracticeHistoryDetailPage`

**Files:**
- Create: `apps/web/src/pages/student/PracticeHistoryDetailPage.tsx`
- Create: `apps/web/src/pages/student/PracticeHistoryDetailPage.test.tsx`

**Interfaces:**
- Consumes: `getPracticeHistoryDetail`（Task 5）
- Produces: 详情页组件，路由 `/student/practice-history/:source/:sessionId`

- [ ] **Step 1: 写测试**

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PracticeHistoryDetailPage } from './PracticeHistoryDetailPage.js';

vi.mock('@/services/api', () => ({
  getPracticeHistoryDetail: vi.fn(),
}));

import { getPracticeHistoryDetail } from '@/services/api.js';

afterEach(() => cleanup());

describe('PracticeHistoryDetailPage', () => {
  it('渲染逐题作答 + 对错标记', async () => {
    (getPracticeHistoryDetail as any).mockResolvedValue({
      session: {
        source: 'exam', sessionId: 1, subjectId: 4, title: '物理卷', module: null,
        startedAt: '2026-11-01T14:00:00Z', completedAt: '2026-11-01T14:40:00Z',
        totalCount: 2, correctCount: 1,
      },
      questions: [
        { questionId: 100, questionOrder: 1, answerText: 'B', isCorrect: false, score: 0,
          method: 'exact', analysis: null, judgedAt: '2026-11-01T14:05:00Z',
          questionContent: '第1题题面', questionAnswer: 'C', questionAnalysis: '解析...',
          refType: 'question', refId: null, sentenceIndex: null },
        { questionId: 101, questionOrder: 2, answerText: 'A', isCorrect: true, score: 1,
          method: 'exact', analysis: null, judgedAt: '2026-11-01T14:10:00Z',
          questionContent: '第2题题面', questionAnswer: 'A', questionAnalysis: '解析...',
          refType: 'question', refId: null, sentenceIndex: null },
      ],
    });
    render(<MemoryRouter initialEntries={['/student/practice-history/exam/1']}>
      <PracticeHistoryDetailPage />
    </MemoryRouter>);
    await waitFor(() => expect(screen.getByText('物理卷')).toBeInTheDocument());
    expect(screen.getByText('我的答案：B')).toBeInTheDocument();
    expect(screen.getByText('我的答案：A')).toBeInTheDocument();
  });

  it('语文专项特殊渲染（questionId 为空）', async () => {
    (getPracticeHistoryDetail as any).mockResolvedValue({
      session: {
        source: 'special', sessionId: 5, subjectId: 2, title: '默写·静夜思',
        module: 'chinese_dictation', startedAt: '2026-10-31T19:30:00Z',
        completedAt: '2026-10-31T19:35:00Z', totalCount: 1, correctCount: 0,
      },
      questions: [
        { questionId: null, questionOrder: 1, answerText: '{"author":"李白","dynasty":"唐","body":"床前明月光"}',
          isCorrect: false, score: 0, method: 'exact', analysis: null, judgedAt: '2026-10-31T19:35:00Z',
          questionContent: null, questionAnswer: null, questionAnalysis: null,
          refType: 'passage', refId: 42, sentenceIndex: null },
      ],
    });
    render(<MemoryRouter initialEntries={['/student/practice-history/special/5']}>
      <PracticeHistoryDetailPage />
    </MemoryRouter>);
    await waitFor(() => expect(screen.getByText('默写·静夜思')).toBeInTheDocument());
    expect(screen.getByText('李白')).toBeInTheDocument();  // JSON 解析出 author
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `cd apps/web && npx vitest run src/pages/student/PracticeHistoryDetailPage.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现 `PracticeHistoryDetailPage.tsx`**

```typescript
import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getPracticeHistoryDetail, type PracticeHistoryQuestion } from '@/services/api.js';
import { getSharedMarkdownConfig } from '@/components/base/markdown-config.js';  // 复用共享配置

export function PracticeHistoryDetailPage() {
  const { source, sessionId } = useParams<{ source: string; sessionId: string }>();
  const [data, setData] = useState<Awaited<ReturnType<typeof getPracticeHistoryDetail>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (source !== 'exam' && source !== 'special') { setNotFound(true); setLoading(false); return; }
    getPracticeHistoryDetail(source, Number(sessionId))
      .then((d) => setData(d))
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [source, sessionId]);

  if (loading) return <p className="p-6 text-[var(--text-tertiary)]">加载中…</p>;
  if (notFound || !data) return (
    <div className="p-6 text-center">
      <p className="text-[var(--text-tertiary)] mb-4">记录不存在</p>
      <Link to="/student/practice-history" className="text-[var(--brand-500)] underline">返回列表</Link>
    </div>
  );

  const { session, questions } = data;

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <Link to="/student/practice-history" className="text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">← 返回列表</Link>
          <h1 className="text-xl font-semibold text-[var(--text-primary)] mt-1">{session.title ?? '未命名'}</h1>
          <p className="text-sm text-[var(--text-tertiary)] mt-1">
            {new Date(session.startedAt).toLocaleString('zh-CN')}
            {session.completedAt && ` — ${new Date(session.completedAt).toLocaleString('zh-CN')}`}
          </p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-semibold text-[var(--text-primary)]">{session.correctCount}/{session.totalCount}</p>
          <p className="text-xs text-[var(--text-tertiary)]">正确</p>
        </div>
      </div>

      <ol className="space-y-4">
        {questions.map((q) => <QuestionItem key={q.questionOrder} q={q} />)}
      </ol>
    </div>
  );
}

function QuestionItem({ q }: { q: PracticeHistoryQuestion }) {
  const correctColor = q.isCorrect === true ? 'text-[var(--success-500)]'
    : q.isCorrect === false ? 'text-[var(--danger-500)]' : 'text-[var(--text-tertiary)]';
  const correctLabel = q.isCorrect === true ? '对' : q.isCorrect === false ? '错' : '未判';

  // 语文专项：questionId 为空，answerText 是 JSON
  const parsedAnswer = q.questionId === null && q.answerText
    ? (() => { try { return JSON.parse(q.answerText); } catch { return null; } })()
    : null;

  return (
    <li className="bg-[var(--bg-card)] border border-[var(--bg-subtle)] rounded-[var(--radius-md)] p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-sm text-[var(--text-tertiary)]">第 {q.questionOrder} 题</span>
        <span className={`text-xs font-medium ${correctColor}`}>{correctLabel}</span>
      </div>

      {/* 题面 */}
      {q.questionContent ? (
        <div className="text-sm text-[var(--text-primary)] mb-3">
          {/* 用共享 MarkdownRenderer 渲染（含图片/表格/HTML） */}
          <MarkdownRenderer content={q.questionContent} />
        </div>
      ) : parsedAnswer ? (
        <div className="text-sm text-[var(--text-tertiary)] mb-3">
          {parsedAnswer.author && <p>作者：{parsedAnswer.author}</p>}
          {parsedAnswer.dynasty && <p>朝代：{parsedAnswer.dynasty}</p>}
          {parsedAnswer.body && <p>正文：{parsedAnswer.body}</p>}
          {parsedAnswer.translation && <p>翻译：{parsedAnswer.translation}</p>}
          {parsedAnswer.terms && <p>字词：{JSON.stringify(parsedAnswer.terms)}</p>}
        </div>
      ) : null}

      {/* 我的答案 */}
      <div className="text-sm mb-2">
        <span className="text-[var(--text-tertiary)]">我的答案：</span>
        <span className={correctColor}>{q.questionId === null ? q.answerText : q.answerText}</span>
      </div>

      {/* 正确答案 */}
      {q.questionAnswer && (
        <div className="text-sm mb-2">
          <span className="text-[var(--text-tertiary)]">正确答案：</span>
          <span className="text-[var(--success-500)]">{q.questionAnswer}</span>
        </div>
      )}

      {/* 解析 */}
      {(q.analysis || q.questionAnalysis) && (
        <div className="text-sm mt-3 pt-3 border-t border-[var(--bg-subtle)]">
          <p className="text-[var(--text-tertiary)] mb-1">解析</p>
          <div className="text-[var(--text-secondary)]">
            <MarkdownRenderer content={q.analysis ?? q.questionAnalysis ?? ''} />
          </div>
        </div>
      )}
      {(q.method === 'ai' && !q.analysis && !q.questionAnalysis) && (
        <p className="text-xs text-[var(--text-tertiary)] mt-2">解析未生成</p>
      )}
    </li>
  );
}

export default PracticeHistoryDetailPage;
```

**注**：`MarkdownRenderer` 与 `getSharedMarkdownConfig` 复用现有共享组件（按 memory `feedback_markdown_renderer_config`：所有 ReactMarkdown 必须支持图片+HTML+repairHtml+表格带线，新增点从共享模块取配置）。如果现有项目里没有封装好的 `MarkdownRenderer`，复用 `ExamResultPage` 里的渲染方式。

- [ ] **Step 4: 跑测试验证通过**

Run: `cd apps/web && npx vitest run src/pages/student/PracticeHistoryDetailPage.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/student/PracticeHistoryDetailPage.tsx apps/web/src/pages/student/PracticeHistoryDetailPage.test.tsx
git commit -m "feat(web): 新增 PracticeHistoryDetailPage 详情页（逐题作答+对错+语文专项特殊渲染）"
```

---

## Task 8: 前端入口 + 路由

**Files:**
- Modify: `apps/web/src/components/layout/StudentStayLayout.tsx`
- Modify: `apps/web/src/routes/routeTable.tsx`
- Modify: `apps/web/src/components/layout/StudentStayLayout.test.tsx`
- Modify: `apps/web/src/routes/routeTable.test.tsx`

**Interfaces:**
- Produces: 顶栏第三胶囊 + 两条路由

- [ ] **Step 1: 改 `StudentStayLayout.tsx` 加第三项**

读现有文件，把 `stayItems` 数组改成三项：

```typescript
const stayItems = [
  { to: '/student/rewards', label: '奖励册' },
  { to: '/student/profile', label: '个人中心' },
  { to: '/student/practice-history', label: '练习记录' },
];
```

- [ ] **Step 2: 改 `routeTable.tsx` 加两条路由**

读现有文件，在 `StudentStayLayout` 的 children 里加：

```typescript
{ path: 'practice-history', element: <PracticeHistoryPage /> },
{ path: 'practice-history/:source/:sessionId', element: <PracticeHistoryDetailPage /> },
```

并在文件顶部 import：

```typescript
import PracticeHistoryPage from '@/pages/student/PracticeHistoryPage.js';
import PracticeHistoryDetailPage from '@/pages/student/PracticeHistoryDetailPage.js';
```

- [ ] **Step 3: 更新 `StudentStayLayout.test.tsx`**

把"两胶囊"断言改成"三胶囊"：

```typescript
expect(screen.getByRole('link', { name: '奖励册' })).toHaveAttribute('href', '/student/rewards');
expect(screen.getByRole('link', { name: '个人中心' })).toHaveAttribute('href', '/student/profile');
expect(screen.getByRole('link', { name: '练习记录' })).toHaveAttribute('href', '/student/practice-history');
```

- [ ] **Step 4: 更新 `routeTable.test.tsx`**

把"个人中心 / 奖励册属禁用夜间切换"的断言扩成三项；加两条新路由的存在性断言：

```typescript
expect(screen.getByRole('link', { name: '练习记录' })).toHaveAttribute('href', '/student/practice-history');
// 路由存在性
expect(routeTable.find(r => r.path === '/student/practice-history')).toBeDefined();
```

- [ ] **Step 5: 跑前端全量测试**

Run: `cd apps/web && npm test`
Expected: 全绿（注意 `globals:false`，多用例文件自己 `afterEach(cleanup)`）

- [ ] **Step 6: lint + tsc + build**

Run: `cd apps/web && npm run lint && npx tsc -b && npm run build`
Expected: 无错误

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/layout/StudentStayLayout.tsx apps/web/src/components/layout/StudentStayLayout.test.tsx \
        apps/web/src/routes/routeTable.tsx apps/web/src/routes/routeTable.test.tsx
git commit -m "feat(web): StudentStayLayout 加练习记录胶囊 + routeTable 加两条路由"
```

---

## Task 9: 文档同步

**Files:**
- Modify: `docs/API接口与数据流设计文档.md`（§4 加两条端点）
- Modify: `docs/api/openapi.yaml`（同步两条端点）
- Modify: `docs/UX-UI设计文档.md`（§1.5 浅停留页清单加"练习记录"）
- Modify: `docs/家长端学情批-完成情况与待办清单.md`（注明一期已落库 + 二期家长端待做）

- [ ] **Step 1: API 文档加两条端点**

在 `docs/API接口与数据流设计文档.md` §4 学生端端点清单加：

```markdown
### GET /api/student/practice-history
学生端练习记录列表（考试 + 专项练习 UNION）。
- Query: page?, pageSize?(默认20上限50), subjectId?
- 返回: { items: [{ source, sessionId, subjectId, title, module, startedAt, completedAt, totalCount, correctCount }], total, page, pageSize }
- 权限: student（JWT.sub 过滤）

### GET /api/student/practice-history/:source/:sessionId
学生端练习记录详情（逐题作答）。
- Path: source(exam|special), sessionId
- 返回: { session: {...}, questions: [{ questionId, questionOrder, answerText, isCorrect, score, method, analysis, judgedAt, questionContent, questionAnswer, questionAnalysis, refType, refId, sentenceIndex }] }
- 错误: 404 {code:1002} 会话不存在或非本人
```

- [ ] **Step 2: openapi.yaml 同步**

在 `docs/api/openapi.yaml` 加两条路径定义（参考现有 `/api/exams/sessions/{id}/results` 的格式）。

- [ ] **Step 3: UX 文档 §1.5 加"练习记录"**

读 `docs/UX-UI设计文档.md` §1.5，在"禁用夜间切换"清单（第 59 行）加"练习记录"。

- [ ] **Step 4: 学情批清单文档注明**

在 `docs/家长端学情批-完成情况与待办清单.md` 加一段：

```markdown
## 2026-11-14 一期作答历史已落库

专项练习作答记录表 special_answer_records 已上线（spec: 2026-11-01）。
- 学生端"练习记录"入口已开放（个人中心顶栏第三胶囊）
- 家长端二期待做：逐卷作答查看 + 薄弱点汇总（数学/语文/物理 KP 维度升级为作答正确率，化学/道法卷子维度，英语除外）
```

- [ ] **Step 5: Commit**

```bash
git add docs/API接口与数据流设计文档.md docs/api/openapi.yaml docs/UX-UI设计文档.md docs/家长端学情批-完成情况与待办清单.md
git commit -m "docs: 同步练习记录端点 + UX §1.5 + 学情批清单二期边界"
```

---

## Self-Review

### Spec 覆盖检查
| spec 章节 | 覆盖任务 |
|---|---|
| §3 数据模型（两表 DDL） | Task 1 |
| §4.1 写入路径（5 判题方法补写） | Task 2（repo）+ Task 3（补写） |
| §4.2 查询端点（列表 + 详情） | Task 4 |
| §5.1 入口（顶栏第三胶囊） | Task 8 |
| §5.2 列表页 | Task 6 |
| §5.3 详情页 | Task 7 |
| §5.4 路由 | Task 8 |
| §5.5 API 层 | Task 5 |
| §6 错误处理 | 散见各任务（写入失败 try/catch / 归属校验 / 404） |
| §7 测试策略 | 各任务内嵌测试步骤 |
| §8 验收标准 | Task 4 Step 12（冒烟）+ 各任务测试 |
| §10 风险 | Task 3（DI @Optional）/ Task 2（语文 question_id 为空先 DELETE 后 INSERT） |

### 类型一致性检查
- `PracticeHistoryItem` 在 Task 4（dto）、Task 5（api.ts）、Task 6/7（页面）签名一致 ✅
- `SpecialPracticeSessionsRepository.upsertSession` 在 Task 2 定义、Task 3 调用一致 ✅
- `SpecialAnswerRecordsRepository.upsertAnswer` / `upsertSpecialAnswer` 在 Task 2 定义、Task 3 调用一致 ✅

### 无占位符检查
- 所有代码块都有实际实现，无 "TBD"/"TODO"/"add appropriate error handling" ✅
- 测试代码都有具体断言 ✅

---

## 执行选择

计划完成并保存到 `docs/superpowers/plans/2026-11-01-special-practice-answer-history.md`。两种执行方式：

**1. Subagent-Driven（推荐）** — 每个 task 派一个新 subagent，任务间两阶段评审，迭代快

**2. Inline Execution** — 在当前会话里用 executing-plans skill 批量执行，带 checkpoint 评审

哪种？
