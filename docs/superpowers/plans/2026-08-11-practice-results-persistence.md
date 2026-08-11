# 课堂练习对错持久化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把课堂练习判题结果（对/错 + analysis 题解）持久化到 MySQL，跨设备/刷新后练习卡仍显示 ✓/✗，支持单题重做覆盖与两级 reset，并接线「重答正确清错题」。

**Architecture:** 新建 `practice_results` 表（一行 = 学生×卡×题，UNIQUE 键 `student_id+card_id+question_n` 支撑单题 upsert）。`judge()` 对/错都 best-effort upsert；答错改 find-or-create 错题本，答对清该题未清错题。前端 `CourseDetailPage` 进卡拉取持久化结果填 store，`AnswerResultList`「完成」只关闭不再 `reset()`（修核心 bug）。

**Tech Stack:** NestJS + TypeScript + mysql2（后端）、Vitest（后端测试）、React + Zustand + Vite（前端）、MySQL 9.7（schema）。

**Spec:** [docs/superpowers/specs/2026-08-10-practice-results-persistence-design.md](../specs/2026-08-10-practice-results-persistence-design.md)

---

## File Structure

**Create:**
- `tools/db/migrations/2026-08-11_add_practice_results.sql` - 新表迁移
- `apps/server/src/database/repositories/practice-results.repo.ts` - 新 repo
- `apps/server/src/database/repositories/practice-results.repo.test.ts` - repo 测试

**Modify:**
- `tools/db/schema.sql` - 新表 + 触发器
- `docs/K12智学系统-数据库设计文档.md` - 新表说明 + 修正陈旧 `main_error_books` 列表
- `apps/server/src/database/repositories/types.ts` - `PracticeResultRow`
- `apps/server/src/database/repositories/index.ts` - barrel 导出
- `apps/server/src/database/repositories/main-error-books.repo.ts` - `clearUnclearedByStudentQuestion`
- `apps/server/src/database/repositories/main-error-books.repo.test.ts` - 清错题测试
- `apps/server/src/modules/practice/practice.service.ts` - judge 改造 + 新方法 + DTO + 注入
- `apps/server/src/modules/practice/practice.service.test.ts` - mk 改造 + 新测试
- `apps/server/src/modules/practice/dto/judge-practice.dto.ts` - `questionN`
- `apps/server/src/modules/practice/practice.controller.ts` - GET/DELETE results
- `apps/server/src/modules/practice/practice.module.ts` - 注册 repo
- `apps/web/src/services/api.ts` - 类型 + 3 函数 + questionN
- `apps/web/src/store/practiceStore.ts` - `loadResults`
- `apps/web/src/components/business/AnswerModal.tsx` - onSubmit 传 n
- `apps/web/src/components/business/AnswerResultList.tsx` - onRetry->onClose（bug 修复）
- `apps/web/src/pages/student/CourseDetailPage.tsx` - 加载 effect + 工具条 + 接线
- `docs/api/openapi.yaml` - results 端点 + schema
- `docs/API接口与数据流设计文档.md` - §4/§6/日志
- `CLAUDE.md` - 实现记录段

---

## Task 1: DB schema - practice_results 表 + 迁移 + DB 设计文档

**Files:**
- Modify: `tools/db/schema.sql`（`main_error_books` 表后 ~line 428；触发器区 §11 ~line 750）
- Create: `tools/db/migrations/2026-08-11_add_practice_results.sql`
- Modify: `docs/K12智学系统-数据库设计文档.md`（§3.6 `main_error_books` 后；§8 日志）

- [ ] **Step 1: 在 `tools/db/schema.sql` 的 `main_error_books` 建表语句之后插入新表**

在 `main_error_books` 表的 `ENGINE=InnoDB ...;` 行之后插入：

```sql
-- ============================================================
-- 课堂练习判题结果持久化（学生×卡×题，单题重做 upsert）
-- ============================================================
CREATE TABLE IF NOT EXISTS practice_results (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  subject_id BIGINT NOT NULL,
  card_id BIGINT NOT NULL,
  lesson_id BIGINT NOT NULL,
  question_id BIGINT DEFAULT NULL,        -- 题库命中时填；未命中 null
  question_n VARCHAR(20) NOT NULL,         -- 卡内复合题号（如 "0-1"），upsert 去重键
  question_text TEXT NOT NULL,             -- 题面（question_id 为空时兜底身份 + 展示）
  student_answer TEXT NOT NULL,
  is_correct TINYINT(1) NOT NULL,
  method VARCHAR(10) NOT NULL,             -- 'exact' | 'ai'
  analysis TEXT DEFAULT NULL,              -- 题解（仅错题，复用判题 analysis）
  error_type VARCHAR(20) DEFAULT NULL,     -- logic|calculation|format|missing|null
  judged_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_pr_student_card_qn (student_id, card_id, question_n),
  KEY idx_pr_student_card (student_id, card_id),
  KEY idx_pr_student_lesson (student_id, lesson_id),
  CONSTRAINT fk_pr_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_pr_card_id   FOREIGN KEY (card_id)   REFERENCES cards (id)    ON DELETE CASCADE,
  CONSTRAINT fk_pr_question_id FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 2: 在 `tools/db/schema.sql` 第 11 节触发器区（`trg_main_error_books_updated_at` 之后）插入触发器**

```sql
DROP TRIGGER IF EXISTS trg_practice_results_updated_at;
CREATE TRIGGER trg_practice_results_updated_at
BEFORE UPDATE ON practice_results
FOR EACH ROW
SET NEW.updated_at = CURRENT_TIMESTAMP(3);
```

- [ ] **Step 3: 创建迁移 `tools/db/migrations/2026-08-11_add_practice_results.sql`**

```sql
-- 迁移：新建 practice_results 表（课堂练习判题结果持久化）
-- 适用：已在运行的 ai_k12 数据库（schema.sql 已同步更新）
-- 执行：mysql -u ai_k12 -p ai_k12 < tools/db/migrations/2026-08-11_add_practice_results.sql

CREATE TABLE IF NOT EXISTS practice_results (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  subject_id BIGINT NOT NULL,
  card_id BIGINT NOT NULL,
  lesson_id BIGINT NOT NULL,
  question_id BIGINT DEFAULT NULL,
  question_n VARCHAR(20) NOT NULL,
  question_text TEXT NOT NULL,
  student_answer TEXT NOT NULL,
  is_correct TINYINT(1) NOT NULL,
  method VARCHAR(10) NOT NULL,
  analysis TEXT DEFAULT NULL,
  error_type VARCHAR(20) DEFAULT NULL,
  judged_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_pr_student_card_qn (student_id, card_id, question_n),
  KEY idx_pr_student_card (student_id, card_id),
  KEY idx_pr_student_lesson (student_id, lesson_id),
  CONSTRAINT fk_pr_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_pr_card_id   FOREIGN KEY (card_id)   REFERENCES cards (id)    ON DELETE CASCADE,
  CONSTRAINT fk_pr_question_id FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TRIGGER IF EXISTS trg_practice_results_updated_at;
CREATE TRIGGER trg_practice_results_updated_at
BEFORE UPDATE ON practice_results
FOR EACH ROW
SET NEW.updated_at = CURRENT_TIMESTAMP(3);
```

- [ ] **Step 4: 对本地库执行迁移并验证表结构**

Run: `mysql -u ai_k12 -p ai_k12 < tools/db/migrations/2026-08-11_add_practice_results.sql`
Expected: 无报错。

验证：
Run: `mysql -u ai_k12 -p ai_k12 -e "SHOW CREATE TABLE practice_results\G" | grep -E "uniq_pr_student_card_qn|fk_pr_card_id|trg_practice_results"`
Expected: 输出含 `uniq_pr_student_card_qn`、`fk_pr_card_id` 三行（触发器不在此输出，单独验证）。

- [ ] **Step 5: 在 `docs/K12智学系统-数据库设计文档.md` §3.6 `main_error_books` 小节之后新增 `practice_results` 小节**

```markdown
#### practice_results（课堂练习判题结果持久化）

| 列名 | 类型 | 可空 | 默认值 | 说明 |
|------|------|------|--------|------|
| id | BIGINT AUTO_INCREMENT | NO | auto | PK |
| student_id | BIGINT | NO | - | FK -> students.id |
| subject_id | BIGINT | NO | - | 冗余：学生学科（FK 省略，同 main_error_books 冗余语义） |
| card_id | BIGINT | NO | - | FK -> cards.id |
| lesson_id | BIGINT | NO | - | 冗余：支撑课程级 reset 索引 |
| question_id | BIGINT | YES | NULL | FK -> questions.id（题库命中填，未命中 NULL） |
| question_n | VARCHAR(20) | NO | - | 卡内复合题号（如 "0-1"），单题重做 upsert 去重键 |
| question_text | TEXT | NO | - | 题面（question_id 为空时兜底身份 + 展示） |
| student_answer | TEXT | NO | - | 学生提交答案 |
| is_correct | TINYINT(1) | NO | - | 1=对 0=错 |
| method | VARCHAR(10) | NO | - | `exact` / `ai` |
| analysis | TEXT | YES | NULL | 题解（仅错题，复用判题 analysis；对题为 NULL） |
| error_type | VARCHAR(20) | YES | NULL | `logic`/`calculation`/`format`/`missing`（仅 AI 判错） |
| judged_at | DATETIME(3) | NO | CURRENT_TIMESTAMP(3) | 本次判题时间 |
| created_at | DATETIME(3) | NO | CURRENT_TIMESTAMP(3) | |
| updated_at | DATETIME(3) | NO | CURRENT_TIMESTAMP(3) | |

- PK: `id`
- FK: `student_id` -> `students(id)` ON DELETE CASCADE
- FK: `card_id` -> `cards(id)` ON DELETE CASCADE
- FK: `question_id` -> `questions(id)` ON DELETE SET NULL
- Unique: `uniq_pr_student_card_qn` ON `(student_id, card_id, question_n)` -- 单题重做即覆盖该行
- Index: `idx_pr_student_card` ON `(student_id, card_id)` -- 取该卡全部结果
- Index: `idx_pr_student_lesson` ON `(student_id, lesson_id)` -- 课程级 reset
```

- [ ] **Step 6: 修正同一文档陈旧的 `main_error_books` 列表**

在 `main_error_books` 列表中 `source_ref_id` 行之后补 `lesson_id` 行、`wrong_answer_text` 行之后补 `dialogue_id` 行，并把 `source` 列说明改为含 `discuss`：

补两行（按 schema.sql 顺序，`source_ref_id` 后插 `lesson_id`，`wrong_answer_text` 后插 `dialogue_id`）：
```markdown
| lesson_id | BIGINT | YES | NULL | 冗余：错题归属课时（practice/discuss 取 cards.lesson_id；homework 取 homeworks.lesson_id） |
| dialogue_id | BIGINT | YES | NULL | 关联的 mainline 讨论对话 id（软引用，跨刷新/跨设备续接同一讨论线） |
```
`source` 行说明改为：
```markdown
| source | VARCHAR(20) | NO | - | `homework` / `unit_test` / `midterm` / `final` / `practice`（课堂练习答错）/ `discuss`（打开讨论即入错题本） |
```

- [ ] **Step 7: 在该文档 §8 变更日志末尾加 v1.5 条目**

```markdown
| v1.5 | 2026-08-11 | 新增 `practice_results` 表（课堂练习判题结果持久化，UNIQUE(student_id,card_id,question_n) 支撑单题重做 upsert）；修正 `main_error_books` 列表补 `lesson_id`/`dialogue_id` 列与 `source` 的 `discuss` 枚举 |
```

- [ ] **Step 8: Commit**

```bash
git add tools/db/schema.sql tools/db/migrations/2026-08-11_add_practice_results.sql docs/K12智学系统-数据库设计文档.md
git commit -m "feat(db): 新增 practice_results 表 + 迁移 + DB 设计文档"
```

---

## Task 2: PracticeResultsRepository + PracticeResultRow + barrel（TDD）

**Files:**
- Modify: `apps/server/src/database/repositories/types.ts`
- Modify: `apps/server/src/database/repositories/index.ts`
- Create: `apps/server/src/database/repositories/practice-results.repo.ts`
- Test: `apps/server/src/database/repositories/practice-results.repo.test.ts`

- [ ] **Step 1: 写失败测试 `practice-results.repo.test.ts`**（镜像 `main-error-books.repo.test.ts` 的 `mockPool`）

```ts
import { describe, it, expect, vi } from 'vitest';
import { PracticeResultsRepository } from './practice-results.repo';

const mockPool = (rows: any[] = [], insertId = 7) => ({
  execute: vi.fn().mockImplementation((sql: string) => {
    const trimmed = sql.trim();
    if (/^INSERT/i.test(trimmed)) {
      return Promise.resolve([{ insertId, affectedRows: 1 }, []]);
    }
    if (/^UPDATE/i.test(trimmed)) {
      return Promise.resolve([{ affectedRows: 1, changedRows: 1 }, []]);
    }
    if (/^DELETE/i.test(trimmed)) {
      return Promise.resolve([{ affectedRows: 1 }, []]);
    }
    return Promise.resolve([rows, []]);
  }),
  query: vi.fn().mockResolvedValue([rows, []]),
});

describe('PracticeResultsRepository', () => {
  it('upsert 执行 INSERT ... ON DUPLICATE KEY UPDATE，is_correct=false -> 0', async () => {
    const pool = mockPool();
    const repo = new PracticeResultsRepository(pool as any);
    await repo.upsert({
      student_id: 1, subject_id: 2, card_id: 5, lesson_id: 9,
      question_id: 10, question_n: '0-1', question_text: '题面',
      student_answer: '答', is_correct: false, method: 'ai',
      analysis: '错因', error_type: 'calculation',
    });
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('INSERT INTO practice_results');
    expect(sql).toContain('ON DUPLICATE KEY UPDATE');
    expect(params).toEqual([1, 2, 5, 9, 10, '0-1', '题面', '答', 0, 'ai', '错因', 'calculation']);
  });

  it('upsert is_correct=true -> 1，question_id=null', async () => {
    const pool = mockPool();
    const repo = new PracticeResultsRepository(pool as any);
    await repo.upsert({
      student_id: 1, subject_id: 2, card_id: 5, lesson_id: 9,
      question_id: null, question_n: '0-2', question_text: '题',
      student_answer: '答', is_correct: true, method: 'exact',
      analysis: null, error_type: null,
    });
    const [, params] = pool.execute.mock.calls[0];
    expect(params[4]).toBeNull(); // question_id
    expect(params[8]).toBe(1);    // is_correct
  });

  it('findByStudentCard SELECT 按 student_id+card_id', async () => {
    const rows = [{ id: 1, question_n: '0-1', is_correct: 1 }];
    const pool = mockPool(rows);
    const repo = new PracticeResultsRepository(pool as any);
    const out = await repo.findByStudentCard(1, 5);
    expect(out).toEqual(rows);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('student_id = ?');
    expect(sql).toContain('card_id = ?');
    expect(params).toEqual([1, 5]);
  });

  it('deleteByStudentCard DELETE 按 student_id+card_id', async () => {
    const pool = mockPool();
    const repo = new PracticeResultsRepository(pool as any);
    await repo.deleteByStudentCard(1, 5);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('DELETE FROM practice_results');
    expect(sql).toContain('card_id = ?');
    expect(params).toEqual([1, 5]);
  });

  it('deleteByStudentLesson DELETE 按 student_id+lesson_id', async () => {
    const pool = mockPool();
    const repo = new PracticeResultsRepository(pool as any);
    await repo.deleteByStudentLesson(1, 9);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('DELETE FROM practice_results');
    expect(sql).toContain('lesson_id = ?');
    expect(params).toEqual([1, 9]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/server && npx vitest run src/database/repositories/practice-results.repo.test.ts`
Expected: FAIL - `Cannot find module './practice-results.repo'`

- [ ] **Step 3: 在 `types.ts` 末尾追加 `PracticeResultRow`**

```ts
export interface PracticeResultRow extends RowDataPacket {
  id: number;
  student_id: number;
  subject_id: number;
  card_id: number;
  lesson_id: number;
  question_id: number | null;
  question_n: string;
  question_text: string;
  student_answer: string;
  is_correct: number;
  method: 'exact' | 'ai';
  analysis: string | null;
  error_type: 'logic' | 'calculation' | 'format' | 'missing' | null;
  judged_at: Date;
  created_at: Date;
  updated_at: Date;
}
```

- [ ] **Step 4: 在 `index.ts` barrel 加导出**

在 value export 区加：`export { PracticeResultsRepository } from './practice-results.repo.js';`
在 type export 行加 `PracticeResultRow`（追加到现有 `export type { ... } from './types.js';` 列表）。

- [ ] **Step 5: 实现 `practice-results.repo.ts`**

```ts
import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { PracticeResultRow } from './types.js';

@Injectable()
export class PracticeResultsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /**
   * Upsert 一条判题结果（对/错都落库）。按 UNIQUE(student_id, card_id, question_n) 去重：
   * 单题重做即覆盖该行。best-effort：调用方（PracticeService.judge）负责 try/catch。
   */
  async upsert(row: {
    student_id: number;
    subject_id: number;
    card_id: number;
    lesson_id: number;
    question_id: number | null;
    question_n: string;
    question_text: string;
    student_answer: string;
    is_correct: boolean;
    method: 'exact' | 'ai';
    analysis: string | null;
    error_type: string | null;
  }): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `INSERT INTO practice_results
         (student_id, subject_id, card_id, lesson_id, question_id, question_n, question_text,
          student_answer, is_correct, method, analysis, error_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         subject_id = VALUES(subject_id), lesson_id = VALUES(lesson_id), question_id = VALUES(question_id),
         question_text = VALUES(question_text), student_answer = VALUES(student_answer),
         is_correct = VALUES(is_correct), method = VALUES(method), analysis = VALUES(analysis),
         error_type = VALUES(error_type), judged_at = NOW(3)`,
      [row.student_id, row.subject_id, row.card_id, row.lesson_id, row.question_id, row.question_n,
       row.question_text, row.student_answer, row.is_correct ? 1 : 0, row.method, row.analysis, row.error_type],
    );
  }

  /** 取该学生在该卡的全部持久化判题结果。 */
  async findByStudentCard(studentId: number, cardId: number): Promise<PracticeResultRow[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM practice_results WHERE student_id = ? AND card_id = ? ORDER BY question_n`,
      [studentId, cardId],
    );
    return rows as PracticeResultRow[];
  }

  /** 单卡 reset：删除该学生该卡的全部判题结果。 */
  async deleteByStudentCard(studentId: number, cardId: number): Promise<void> {
    await this.pool.execute(
      `DELETE FROM practice_results WHERE student_id = ? AND card_id = ?`,
      [studentId, cardId],
    );
  }

  /** 课程级 reset：删除该学生该课全部卡片的判题结果。 */
  async deleteByStudentLesson(studentId: number, lessonId: number): Promise<void> {
    await this.pool.execute(
      `DELETE FROM practice_results WHERE student_id = ? AND lesson_id = ?`,
      [studentId, lessonId],
    );
  }
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd apps/server && npx vitest run src/database/repositories/practice-results.repo.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/database/repositories/practice-results.repo.ts apps/server/src/database/repositories/practice-results.repo.test.ts apps/server/src/database/repositories/types.ts apps/server/src/database/repositories/index.ts
git commit -m "feat(practice): PracticeResultsRepository + PracticeResultRow"
```

---

## Task 3: MainErrorBooksRepository.clearUnclearedByStudentQuestion（TDD）

**Files:**
- Modify: `apps/server/src/database/repositories/main-error-books.repo.ts`
- Test: `apps/server/src/database/repositories/main-error-books.repo.test.ts`

- [ ] **Step 1: 在 `main-error-books.repo.test.ts` 末尾（`updateDialogueId` 用例后）加失败测试**

```ts
  it('clearUnclearedByStudentQuestion 批量清零该题未清记录（questionId 非空）', async () => {
    const pool = mockPool();
    const repo = new MainErrorBooksRepository(pool as any);
    await repo.clearUnclearedByStudentQuestion(1, 2, 5, '题面');
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('UPDATE main_error_books');
    expect(sql).toContain('is_cleared = 1');
    expect(sql).toContain('cleared_at = NOW(3)');
    expect(sql).toContain('is_cleared = 0');
    expect(sql).toContain('question_id = ?');
    expect(sql).toContain('source_ref_id = ?');
    expect(sql).toContain('wrong_answer_text = ?');
    expect(params).toEqual([1, 2, 2, 5, '题面']);
  });

  it('clearUnclearedByStudentQuestion questionId=null 走题面匹配分支', async () => {
    const pool = mockPool();
    const repo = new MainErrorBooksRepository(pool as any);
    await repo.clearUnclearedByStudentQuestion(1, null, 5, '未入库题面');
    const [, params] = pool.execute.mock.calls[0];
    expect(params).toEqual([1, null, null, 5, '未入库题面']);
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/server && npx vitest run src/database/repositories/main-error-books.repo.test.ts`
Expected: FAIL - `repo.clearUnclearedByStudentQuestion is not a function`

- [ ] **Step 3: 在 `main-error-books.repo.ts` 的 `markCleared` 方法之后追加 `clearUnclearedByStudentQuestion`**

```ts
  /**
   * 答对清零：把该学生此题所有「未清」错题记录一次性 is_cleared=1（兼容历史重复记录）。
   * 匹配条件镜像 findUnclearedByStudentQuestion（question_id 或 题面+cardId），不限 source。
   * best-effort：调用方（PracticeService.judge 答对路径）负责 try/catch。
   */
  async clearUnclearedByStudentQuestion(
    studentId: number,
    questionId: number | null,
    cardId: number,
    questionText: string,
  ): Promise<void> {
    await this.pool.execute(
      `UPDATE main_error_books
       SET is_cleared = 1, cleared_at = NOW(3)
       WHERE student_id = ? AND is_cleared = 0 AND (
         (? IS NOT NULL AND question_id = ?) OR
         (question_id IS NULL AND source_ref_id = ? AND wrong_answer_text = ?)
       )`,
      [studentId, questionId, questionId, cardId, questionText],
    );
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/server && npx vitest run src/database/repositories/main-error-books.repo.test.ts`
Expected: PASS（含新增 2 例）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/database/repositories/main-error-books.repo.ts apps/server/src/database/repositories/main-error-books.repo.test.ts
git commit -m "feat(practice): MainErrorBooksRepository.clearUnclearedByStudentQuestion 批量清错题"
```

---

## Task 4: PracticeService judge 改造 + 新方法 + DTO（TDD）

**Files:**
- Modify: `apps/server/src/modules/practice/practice.service.ts`
- Modify: `apps/server/src/modules/practice/practice.service.test.ts`
- Modify: `apps/server/src/modules/practice/dto/judge-practice.dto.ts`

- [ ] **Step 1: 改 `practice.service.test.ts` 的 `mk` 默认值，加 `practiceResultsRepo` 与 `clearUnclearedByStudentQuestion`**

替换现有 `mainErrorRepo` 默认行与 `mk` 末尾，使其变为（在 `lessonsRepo` 行后加 `practiceResultsRepo`，`mainErrorRepo` 加 `clearUnclearedByStudentQuestion`）：

原 `mainErrorRepo` 行：
```ts
  mainErrorRepo: { create: vi.fn().mockResolvedValue(42), findUnclearedByStudentQuestion: vi.fn().mockResolvedValue(null), updateDialogueId: vi.fn().mockResolvedValue(undefined), countUnclearedByLesson: vi.fn().mockResolvedValue(0) },
```
替换为：
```ts
  mainErrorRepo: { create: vi.fn().mockResolvedValue(42), findUnclearedByStudentQuestion: vi.fn().mockResolvedValue(null), clearUnclearedByStudentQuestion: vi.fn().mockResolvedValue(undefined), updateDialogueId: vi.fn().mockResolvedValue(undefined), countUnclearedByLesson: vi.fn().mockResolvedValue(0) },
```

原 `lessonsRepo` 行：
```ts
  lessonsRepo: { findPreviousLessonId: vi.fn().mockResolvedValue(null), findByUnitId: vi.fn(), findById: vi.fn() },
  ...overrides,
```
替换为：
```ts
  lessonsRepo: { findPreviousLessonId: vi.fn().mockResolvedValue(null), findByUnitId: vi.fn(), findById: vi.fn() },
  practiceResultsRepo: {
    upsert: vi.fn().mockResolvedValue(undefined),
    findByStudentCard: vi.fn().mockResolvedValue([]),
    deleteByStudentCard: vi.fn().mockResolvedValue(undefined),
    deleteByStudentLesson: vi.fn().mockResolvedValue(undefined),
  },
  ...overrides,
```

- [ ] **Step 2: 改 `mkSvc` 构造函数，加第 9 个参数 `practiceResultsRepo`**

原：
```ts
const mkSvc = (deps: ReturnType<typeof mk>) =>
  new PracticeService(deps.questionsRepo, deps.mainErrorRepo, deps.structuring, deps.judgment as any, deps.cardsRepo, deps.hint as any, deps.conversationsService as any, deps.lessonsRepo as any);
```
替换为：
```ts
const mkSvc = (deps: ReturnType<typeof mk>) =>
  new PracticeService(deps.questionsRepo, deps.mainErrorRepo, deps.structuring, deps.judgment as any, deps.cardsRepo, deps.hint as any, deps.conversationsService as any, deps.lessonsRepo as any, deps.practiceResultsRepo as any);
```

- [ ] **Step 3: 给 `describe('PracticeService.judge')` 块内全部 11 个 `svc.judge({...})` 调用加 `questionN`**

该块内每个 judge 调用形如 `svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionText: '...', studentAnswer: '...' })`。在每个调用的 `lessonId: 9,` 之后、`questionText:` 之前插入 `questionN: '0-1',`。

示例（第一个用例 line 42）原：
```ts
    const r = await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionText: '题', studentAnswer: 'B' });
```
改为：
```ts
    const r = await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionN: '0-1', questionText: '题', studentAnswer: 'B' });
```
对其余 10 个 judge 调用做同样插入（`describe('PracticeService.judge')` 块内，共 11 处，均含 `studentAnswer:`）。**注意：`getHint`/`startDiscuss`/`startCardDiscuss` 调用不要改**（它们不含 `studentAnswer:`，且其入参类型无 `questionN`）。

- [ ] **Step 4: 在 `describe('PracticeService.judge')` 块末尾（line ~218 `})` 前）追加新用例**

```ts
  it('judge 答对 -> upsert practice_results(is_correct=true) + clearUnclearedByStudentQuestion，不入错题本', async () => {
    const deps = mk({
      questionsRepo: {
        findByContentHash: vi.fn().mockResolvedValue({ id: 10, type: 'choice', answer: 'A', options: '[{"label":"A","isCorrect":true}]' }),
        findOrCreate: vi.fn(), deleteById: vi.fn(),
      },
    });
    const svc = mkSvc(deps);
    await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionN: '0-1', questionText: '题', studentAnswer: 'A' });
    expect(deps.practiceResultsRepo.upsert).toHaveBeenCalledWith(expect.objectContaining({
      student_id: 1, card_id: 5, lesson_id: 9, question_id: 10, question_n: '0-1',
      is_correct: true, method: 'exact', analysis: null,
    }));
    expect(deps.mainErrorRepo.clearUnclearedByStudentQuestion).toHaveBeenCalledWith(1, 10, 5, '题');
    expect(deps.mainErrorRepo.create).not.toHaveBeenCalled();
  });

  it('judge 答错 -> upsert practice_results(is_correct=false) + find-or-create 错题本', async () => {
    const deps = mk({
      questionsRepo: {
        findByContentHash: vi.fn().mockResolvedValue({ id: 10, type: 'choice', answer: 'A', options: '[{"label":"A","isCorrect":true}]' }),
        findOrCreate: vi.fn(), deleteById: vi.fn(),
      },
    });
    const svc = mkSvc(deps);
    await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionN: '0-1', questionText: '题', studentAnswer: 'B' });
    expect(deps.practiceResultsRepo.upsert).toHaveBeenCalledWith(expect.objectContaining({
      is_correct: false, question_n: '0-1', analysis: expect.any(String),
    }));
    expect(deps.mainErrorRepo.findUnclearedByStudentQuestion).toHaveBeenCalledWith(1, 10, 5, '题');
    expect(deps.mainErrorRepo.create).toHaveBeenCalled();
  });

  it('judge 答错且已有未清错题 -> find-or-create 复用，不重复 create', async () => {
    const deps = mk({
      questionsRepo: {
        findByContentHash: vi.fn().mockResolvedValue({ id: 10, type: 'choice', answer: 'A', options: '[{"label":"A","isCorrect":true}]' }),
        findOrCreate: vi.fn(), deleteById: vi.fn(),
      },
      mainErrorRepo: {
        create: vi.fn(),
        findUnclearedByStudentQuestion: vi.fn().mockResolvedValue({ id: 77 }),
        clearUnclearedByStudentQuestion: vi.fn(),
        updateDialogueId: vi.fn(), countUnclearedByLesson: vi.fn(),
      },
    });
    const svc = mkSvc(deps);
    const r = await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionN: '0-1', questionText: '题', studentAnswer: 'B' });
    expect(r.errorBookId).toBe(77);
    expect(deps.mainErrorRepo.create).not.toHaveBeenCalled();
  });

  it('judge AI 失败(503) -> 不 upsert practice_results', async () => {
    const deps = mk({
      judgment: { judge: vi.fn().mockRejectedValue(new Error('LLM timeout')) },
    });
    const svc = mkSvc(deps);
    await expect(
      svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionN: '0-1', questionText: '题', studentAnswer: '答' }),
    ).rejects.toThrow(HttpException);
    expect(deps.practiceResultsRepo.upsert).not.toHaveBeenCalled();
  });

  it('practiceResultsRepo.upsert 失败 -> 不阻断判题返回（best-effort）', async () => {
    const deps = mk({
      questionsRepo: {
        findByContentHash: vi.fn().mockResolvedValue({ id: 10, type: 'choice', answer: 'A', options: '[{"label":"A","isCorrect":true}]' }),
        findOrCreate: vi.fn(), deleteById: vi.fn(),
      },
      practiceResultsRepo: { upsert: vi.fn().mockRejectedValue(new Error('DB down')), findByStudentCard: vi.fn(), deleteByStudentCard: vi.fn(), deleteByStudentLesson: vi.fn() },
    });
    const svc = mkSvc(deps);
    const r = await svc.judge({ studentId: 1, subjectId: 1, cardId: 5, lessonId: 9, questionN: '0-1', questionText: '题', studentAnswer: 'A' });
    expect(r.isCorrect).toBe(true);
  });
```

- [ ] **Step 5: 在文件末尾追加 `getResults` / `resetCard` / `resetLesson` 测试 describe 块**

```ts
describe('PracticeService.getResults', () => {
  it('返回 PracticeResultDto[]，is_correct TINYINT -> boolean', async () => {
    const deps = mk({
      practiceResultsRepo: {
        upsert: vi.fn(),
        findByStudentCard: vi.fn().mockResolvedValue([
          { question_n: '0-1', question_text: '题1', student_answer: 'A', is_correct: 1, method: 'exact', analysis: null, error_type: null },
          { question_n: '0-2', question_text: '题2', student_answer: 'B', is_correct: 0, method: 'ai', analysis: '错因', error_type: 'calculation' },
        ]),
        deleteByStudentCard: vi.fn(), deleteByStudentLesson: vi.fn(),
      },
    });
    const svc = mkSvc(deps);
    const out = await svc.getResults(1, 5);
    expect(out).toEqual([
      { questionN: '0-1', questionText: '题1', studentAnswer: 'A', isCorrect: true, method: 'exact', analysis: null, errorType: null },
      { questionN: '0-2', questionText: '题2', studentAnswer: 'B', isCorrect: false, method: 'ai', analysis: '错因', errorType: 'calculation' },
    ]);
  });
});

describe('PracticeService.resetCard / resetLesson', () => {
  it('resetCard -> deleteByStudentCard', async () => {
    const deps = mk({
      practiceResultsRepo: { upsert: vi.fn(), findByStudentCard: vi.fn(), deleteByStudentCard: vi.fn().mockResolvedValue(undefined), deleteByStudentLesson: vi.fn() },
    });
    const svc = mkSvc(deps);
    await svc.resetCard(1, 5);
    expect(deps.practiceResultsRepo.deleteByStudentCard).toHaveBeenCalledWith(1, 5);
  });

  it('resetLesson -> deleteByStudentLesson', async () => {
    const deps = mk({
      practiceResultsRepo: { upsert: vi.fn(), findByStudentCard: vi.fn(), deleteByStudentCard: vi.fn(), deleteByStudentLesson: vi.fn().mockResolvedValue(undefined) },
    });
    const svc = mkSvc(deps);
    await svc.resetLesson(1, 9);
    expect(deps.practiceResultsRepo.deleteByStudentLesson).toHaveBeenCalledWith(1, 9);
  });
});
```

- [ ] **Step 6: 运行测试确认失败（judge 改造尚未实现）**

Run: `cd apps/server && npx vitest run src/modules/practice/practice.service.test.ts`
Expected: FAIL - 新用例失败（`practiceResultsRepo` 未被调用 / `questionN` 不在 JudgeInput / `clearUnclearedByStudentQuestion` 未调用）；旧用例可能因 `questionN` 缺失报 TS 错（vitest 用 esbuild 不做类型检查，应运行但断言失败）。

- [ ] **Step 7: 改 `practice.service.ts` - import 加 `PracticeResultsRepository`**

原 import 行：
```ts
import { QuestionsRepository, MainErrorBooksRepository, CardsRepository, LessonsRepository } from '../../database/repositories/index.js';
```
替换为：
```ts
import { QuestionsRepository, MainErrorBooksRepository, CardsRepository, LessonsRepository, PracticeResultsRepository } from '../../database/repositories/index.js';
```

- [ ] **Step 8: 改 `JudgeInput` 加 `questionN`**

原：
```ts
export interface JudgeInput {
  studentId: number;
  subjectId: number;
  cardId: number;
  lessonId: number;
  questionText: string;
  studentAnswer: string;
}
```
替换为：
```ts
export interface JudgeInput {
  studentId: number;
  subjectId: number;
  cardId: number;
  lessonId: number;
  questionN: string;
  questionText: string;
  studentAnswer: string;
}
```

- [ ] **Step 9: 在 `JudgeOutput` 接口之后追加 `PracticeResultDto`**

```ts
export interface PracticeResultDto {
  questionN: string;
  questionText: string;
  studentAnswer: string;
  isCorrect: boolean;
  method: 'exact' | 'ai';
  analysis: string | null;
  errorType: 'logic' | 'calculation' | 'format' | 'missing' | null;
}
```

- [ ] **Step 10: 构造函数追加第 9 个注入 `practiceResultsRepo`**

原：
```ts
  constructor(
    private readonly questionsRepo: QuestionsRepository,
    private readonly mainErrorRepo: MainErrorBooksRepository,
    private readonly structuring: QuestionStructuringCapability,
    private readonly judgment: JudgmentCapability,
    private readonly cardsRepo: CardsRepository,
    private readonly hint: HintCapability,
    private readonly conversationsService: ConversationsService,
    private readonly lessonsRepo: LessonsRepository,
  ) {}
```
替换为：
```ts
  constructor(
    private readonly questionsRepo: QuestionsRepository,
    private readonly mainErrorRepo: MainErrorBooksRepository,
    private readonly structuring: QuestionStructuringCapability,
    private readonly judgment: JudgmentCapability,
    private readonly cardsRepo: CardsRepository,
    private readonly hint: HintCapability,
    private readonly conversationsService: ConversationsService,
    private readonly lessonsRepo: LessonsRepository,
    private readonly practiceResultsRepo: PracticeResultsRepository,
  ) {}
```

- [ ] **Step 11: 改 `judge()` 错题本块为 find-or-create + 答对清错题 + 对/错都 upsert**

定位 `judge()` 中 `// 路由 3：答错 -> 入主线错题本` 注释起的 `if (!isCorrect) { ... }` 块及其后的 `return` 语句。原：
```ts
    // 路由 3：答错 -> 入主线错题本（未入库的题先结构化 + 插题）
    if (!isCorrect) {
      let questionCreated = false;
      if (!q) {
        try {
          const structured = await this.structuring.structure({
            rawInput: input.questionText,
            inputType: 'text',
            studentId: String(input.studentId),
            subjectHint: 'math',
          });
          if (structured.quality !== 'poor' && structured.content.trim().length > 0) {
            const created = await this.questionsRepo.findOrCreate({
              subject_id: input.subjectId,
              type: structured.type,
              difficulty: structured.difficulty,
              content: structured.content,
              options: structured.options ? JSON.stringify(structured.options) : null,
              answer: structured.answer,
              explanation: structured.explanation,
              source: 'practice',
              content_hash: computeContentHash(structured.content),
            });
            questionId = created.id;
            questionCreated = created.created;
          } else {
            questionId = null;
          }
        } catch (err) {
          this.logger.error(`structure/findOrCreate failed, falling back to questionId=null: ${err}`);
          questionId = null;
        }
      }
      // Important #2: 孤儿题补偿 -- mainErrorRepo.create 失败时若刚创建了题，
      // 删除孤儿题再抛（镜像 ErrorBookService.insertQuestionAndAux）。
      try {
        errorBookId = await this.mainErrorRepo.create({
          student_id: input.studentId,
          subject_id: input.subjectId,
          question_id: questionId,
          source: 'practice',
          source_ref_id: input.cardId,
          lesson_id: input.lessonId,
          wrong_answer_text: questionId === null ? input.questionText : null,
        });
      } catch (err) {
        if (questionCreated && questionId !== null) {
          await this.questionsRepo.deleteById(questionId).catch(() => {});
        }
        throw err;
      }
    }

    return { questionId, isCorrect, method, analysis, errorType, errorBookId };
```
替换为：
```ts
    // 路由 3：答错 -> 入主线错题本（find-or-create，避免重复答错堆积；未入库的题先结构化 + 插题）
    if (!isCorrect) {
      let questionCreated = false;
      if (!q) {
        try {
          const structured = await this.structuring.structure({
            rawInput: input.questionText,
            inputType: 'text',
            studentId: String(input.studentId),
            subjectHint: 'math',
          });
          if (structured.quality !== 'poor' && structured.content.trim().length > 0) {
            const created = await this.questionsRepo.findOrCreate({
              subject_id: input.subjectId,
              type: structured.type,
              difficulty: structured.difficulty,
              content: structured.content,
              options: structured.options ? JSON.stringify(structured.options) : null,
              answer: structured.answer,
              explanation: structured.explanation,
              source: 'practice',
              content_hash: computeContentHash(structured.content),
            });
            questionId = created.id;
            questionCreated = created.created;
          } else {
            questionId = null;
          }
        } catch (err) {
          this.logger.error(`structure/findOrCreate failed, falling back to questionId=null: ${err}`);
          questionId = null;
        }
      }
      // find-or-create：命中既有未清错题则复用（不重复 create）；否则新建（孤儿题回滚补偿仅新建分支）
      const existing = await this.mainErrorRepo.findUnclearedByStudentQuestion(
        input.studentId,
        questionId,
        input.cardId,
        input.questionText,
      );
      if (existing) {
        errorBookId = existing.id;
      } else {
        // Important #2: 孤儿题补偿 -- mainErrorRepo.create 失败时若刚创建了题，
        // 删除孤儿题再抛（镜像 ErrorBookService.insertQuestionAndAux）。
        try {
          errorBookId = await this.mainErrorRepo.create({
            student_id: input.studentId,
            subject_id: input.subjectId,
            question_id: questionId,
            source: 'practice',
            source_ref_id: input.cardId,
            lesson_id: input.lessonId,
            wrong_answer_text: questionId === null ? input.questionText : null,
          });
        } catch (err) {
          if (questionCreated && questionId !== null) {
            await this.questionsRepo.deleteById(questionId).catch(() => {});
          }
          throw err;
        }
      }
    } else {
      // 答对 -> 清零该题未清错题记录（展示掌握，影响跨课门禁计数；best-effort，失败不阻断）
      try {
        await this.mainErrorRepo.clearUnclearedByStudentQuestion(
          input.studentId,
          questionId,
          input.cardId,
          input.questionText,
        );
      } catch (err) {
        this.logger.error(`clearUnclearedByStudentQuestion failed: ${err}`);
      }
    }

    // 对/错都持久化判题结果（best-effort，失败不阻断判题返回）
    try {
      await this.practiceResultsRepo.upsert({
        student_id: input.studentId,
        subject_id: input.subjectId,
        card_id: input.cardId,
        lesson_id: input.lessonId,
        question_id: questionId,
        question_n: input.questionN,
        question_text: input.questionText,
        student_answer: input.studentAnswer,
        is_correct: isCorrect,
        method,
        analysis,
        error_type: errorType,
      });
    } catch (err) {
      this.logger.error(`practiceResultsRepo.upsert failed (student=${input.studentId}, card=${input.cardId}, qn=${input.questionN}): ${err}`);
    }

    return { questionId, isCorrect, method, analysis, errorType, errorBookId };
```

- [ ] **Step 12: 在 `judge()` 方法之后追加 `getResults` / `resetCard` / `resetLesson` 方法**

```ts
  /** 取该学生在该卡的持久化判题结果（is_correct TINYINT -> boolean）。 */
  async getResults(studentId: number, cardId: number): Promise<PracticeResultDto[]> {
    const rows = await this.practiceResultsRepo.findByStudentCard(studentId, cardId);
    return rows.map((r) => ({
      questionN: r.question_n,
      questionText: r.question_text,
      studentAnswer: r.student_answer,
      isCorrect: !!r.is_correct,
      method: r.method,
      analysis: r.analysis,
      errorType: r.error_type,
    }));
  }

  /** 单卡 reset：删除该学生该卡的全部判题结果（不动 main_error_books）。 */
  async resetCard(studentId: number, cardId: number): Promise<void> {
    await this.practiceResultsRepo.deleteByStudentCard(studentId, cardId);
  }

  /** 课程级 reset：删除该学生该课全部卡片的判题结果（不动 main_error_books）。 */
  async resetLesson(studentId: number, lessonId: number): Promise<void> {
    await this.practiceResultsRepo.deleteByStudentLesson(studentId, lessonId);
  }
```

- [ ] **Step 13: 改 `dto/judge-practice.dto.ts` 加 `questionN`**

原：
```ts
export interface JudgePracticeDto {
  cardId: number;
  lessonId: number;
  subjectId: number;
  questionText: string;
  studentAnswer: string;
}
```
替换为：
```ts
export interface JudgePracticeDto {
  cardId: number;
  lessonId: number;
  subjectId: number;
  questionN: string;
  questionText: string;
  studentAnswer: string;
}
```

- [ ] **Step 14: 运行测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/practice/practice.service.test.ts`
Expected: PASS（全部含新增用例）

- [ ] **Step 15: 类型检查 + 全量测试**

Run: `cd apps/server && npm run build && npm test`
Expected: tsc 通过；全部测试 PASS。

- [ ] **Step 16: Commit**

```bash
git add apps/server/src/modules/practice/practice.service.ts apps/server/src/modules/practice/practice.service.test.ts apps/server/src/modules/practice/dto/judge-practice.dto.ts
git commit -m "feat(practice): judge 持久化结果 + 答错 find-or-create + 答对清错题 + getResults/reset"
```

---

## Task 5: PracticeController 端点 + module 注册

**Files:**
- Modify: `apps/server/src/modules/practice/practice.controller.ts`
- Modify: `apps/server/src/modules/practice/practice.module.ts`

- [ ] **Step 1: 改 `practice.controller.ts` import 行加 `BadRequestException`、`Delete`**

原：
```ts
import { Body, Controller, Get, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
```
替换为：
```ts
import { BadRequestException, Body, Controller, Delete, Get, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
```

- [ ] **Step 2: 改 `judge` 端点透传 `questionN`**

原：
```ts
  @Post('judge')
  async judge(@Body() dto: JudgePracticeDto, @CurrentUser() user: JwtUser) {
    return this.practiceService.judge({
      studentId: user.sub,
      subjectId: dto.subjectId,
      cardId: dto.cardId,
      lessonId: dto.lessonId,
      questionText: dto.questionText,
      studentAnswer: dto.studentAnswer,
    });
  }
```
替换为：
```ts
  @Post('judge')
  async judge(@Body() dto: JudgePracticeDto, @CurrentUser() user: JwtUser) {
    return this.practiceService.judge({
      studentId: user.sub,
      subjectId: dto.subjectId,
      cardId: dto.cardId,
      lessonId: dto.lessonId,
      questionN: dto.questionN,
      questionText: dto.questionText,
      studentAnswer: dto.studentAnswer,
    });
  }
```

- [ ] **Step 3: 在 `previous-errors` 端点之前追加 `results` 的 GET / DELETE 端点**

```ts
  @Get('results')
  async getResults(@Query('cardId', ParseIntPipe) cardId: number, @CurrentUser() user: JwtUser) {
    return this.practiceService.getResults(user.sub, cardId);
  }

  @Delete('results')
  async resetResults(
    @Query('cardId') cardIdStr?: string,
    @Query('lessonId') lessonIdStr?: string,
    @CurrentUser() user: JwtUser,
  ) {
    if (cardIdStr !== undefined && lessonIdStr !== undefined) {
      throw new BadRequestException('cardId 与 lessonId 不可同时指定');
    }
    if (cardIdStr !== undefined) {
      const cardId = parseInt(cardIdStr, 10);
      if (Number.isNaN(cardId)) throw new BadRequestException('cardId 非法');
      return this.practiceService.resetCard(user.sub, cardId);
    }
    if (lessonIdStr !== undefined) {
      const lessonId = parseInt(lessonIdStr, 10);
      if (Number.isNaN(lessonId)) throw new BadRequestException('lessonId 非法');
      return this.practiceService.resetLesson(user.sub, lessonId);
    }
    throw new BadRequestException('须指定 cardId 或 lessonId');
  }
```

- [ ] **Step 4: 改 `practice.module.ts` 注册 `PracticeResultsRepository`**

原 import 行：
```ts
import { QuestionsRepository, MainErrorBooksRepository, CardsRepository, LessonsRepository } from '../../database/repositories/index.js';
```
替换为：
```ts
import { QuestionsRepository, MainErrorBooksRepository, CardsRepository, LessonsRepository, PracticeResultsRepository } from '../../database/repositories/index.js';
```
原 providers 数组末尾 `LessonsRepository,` 后追加 `PracticeResultsRepository,`（即 providers 列表加一项）。

- [ ] **Step 5: 类型检查**

Run: `cd apps/server && npm run build`
Expected: tsc 通过。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/practice/practice.controller.ts apps/server/src/modules/practice/practice.module.ts
git commit -m "feat(practice): GET/DELETE /api/practice/results 端点 + 注册 repo"
```

---

## Task 6: 前端 api.ts - 类型与函数

**Files:**
- Modify: `apps/web/src/services/api.ts`

- [ ] **Step 1: `judgePractice` payload 加 `questionN`**

原：
```ts
export function judgePractice(payload: {
  cardId: number;
  lessonId: number;
  subjectId: number;
  questionText: string;
  studentAnswer: string;
}): Promise<JudgeResult> {
  return fetchApi<JudgeResult>('/practice/judge', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
```
替换为：
```ts
export function judgePractice(payload: {
  cardId: number;
  lessonId: number;
  subjectId: number;
  questionN: string;
  questionText: string;
  studentAnswer: string;
}): Promise<JudgeResult> {
  return fetchApi<JudgeResult>('/practice/judge', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
```

- [ ] **Step 2: 在 `judgePractice` 之后追加 `PracticeResult` 类型与三个函数**

```ts
// --- Practice results（课堂练习判题结果持久化） ---

export interface PracticeResult {
  questionN: string;
  questionText: string;
  studentAnswer: string;
  isCorrect: boolean;
  method: 'exact' | 'ai';
  analysis: string | null;
  errorType: 'logic' | 'calculation' | 'format' | 'missing' | null;
}

export function getPracticeResults(cardId: number): Promise<PracticeResult[]> {
  return fetchApi<PracticeResult[]>(`/practice/results?cardId=${cardId}`);
}

export function resetPracticeCard(cardId: number): Promise<void> {
  return fetchApi<void>(`/practice/results?cardId=${cardId}`, { method: 'DELETE' });
}

export function resetPracticeLesson(lessonId: number): Promise<void> {
  return fetchApi<void>(`/practice/results?lessonId=${lessonId}`, { method: 'DELETE' });
}
```

- [ ] **Step 3: 类型检查 + 构建**

Run: `cd apps/web && npm run build`
Expected: tsc + vite 构建通过。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/services/api.ts
git commit -m "feat(web): PracticeResult 类型 + getPracticeResults/resetPracticeCard/resetPracticeLesson"
```

---

## Task 7: 前端 practiceStore.loadResults

**Files:**
- Modify: `apps/web/src/store/practiceStore.ts`

- [ ] **Step 1: import 加 `PracticeResult` 类型**

原：
```ts
import type { JudgeResult } from '../services/api';
```
替换为：
```ts
import type { JudgeResult, PracticeResult } from '../services/api';
```

- [ ] **Step 2: `PracticeState` 接口加 `loadResults` 签名**

在 `setSession` 签名行之后加：
```ts
  loadResults: (cardId: number, questions: { n: string; text: string }[], results: PracticeResult[]) => void;
```

- [ ] **Step 3: 实现 `loadResults`（合并语义：同卡重入保留在途作答）**

在 `setSession` 实现之后加：
```ts
  loadResults: (cardId, questions, results) => set((s) => {
    const dbAnswers: Record<string, AnswerRecord> = {};
    for (const r of results) {
      dbAnswers[r.questionN] = {
        questionId: null,
        isCorrect: r.isCorrect,
        method: r.method,
        analysis: r.analysis,
        errorType: r.errorType ?? null,
        studentAnswer: r.studentAnswer,
      };
    }
    // 同卡重入（effect 在用户作答后才返回）：保留在途作答（current 优先），DB 仅填补空缺
    const merged = s.cardId === cardId ? { ...dbAnswers, ...s.answers } : dbAnswers;
    return {
      cardId,
      questions,
      answers: merged,
      hints: s.cardId === cardId ? s.hints : {},
      discussDialogues: s.cardId === cardId ? s.discussDialogues : {},
      currentIndex: 0,
    };
  }),
```

- [ ] **Step 4: 类型检查 + 构建**

Run: `cd apps/web && npm run build`
Expected: 通过。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/store/practiceStore.ts
git commit -m "feat(web): practiceStore.loadResults 持久化结果填充（合并防覆盖）"
```

---

## Task 8: 前端 AnswerModal - onSubmit 直传 n

**Files:**
- Modify: `apps/web/src/components/business/AnswerModal.tsx`

- [ ] **Step 1: 改 Props 的 `onSubmit` 签名加 `n`**

原：
```ts
  onSubmit: (questionText: string, studentAnswer: string) => Promise<{
    isCorrect: boolean; method: string; analysis: string | null; errorType?: string | null;
  }>;
```
替换为：
```ts
  onSubmit: (questionText: string, studentAnswer: string, n: string) => Promise<{
    isCorrect: boolean; method: string; analysis: string | null; errorType?: string | null;
  }>;
```

- [ ] **Step 2: 改 `handleSubmit` 调用 `onSubmit` 传 `q.n`**

原：
```ts
    const p = Promise.resolve(onSubmit(q.text, submittedAnswer))
```
替换为：
```ts
    const p = Promise.resolve(onSubmit(q.text, submittedAnswer, q.n))
```

- [ ] **Step 3: 类型检查 + 构建**

Run: `cd apps/web && npm run build`
Expected: 报错 - `CourseDetailPage` 传给 `onSubmit` 的回调签名仍是两参（下一个 Task 修）。本步先不构建通过，记下错误，于 Task 10 一并修复。

> 说明：`onSubmit` 签名变更会引发 `CourseDetailPage` 的回调类型不匹配，属预期，Task 10 接线时消除。

- [ ] **Step 4: Commit（与 Task 10 合并提交，避免中间态构建失败）**

暂不单独提交，待 Task 10 完成后一并提交。

---

## Task 9: 前端 AnswerResultList - onRetry 改 onClose（修核心 bug）

**Files:**
- Modify: `apps/web/src/components/business/AnswerResultList.tsx`

- [ ] **Step 1: 改 Props `onRetry` 为 `onClose`**

原：
```ts
interface Props {
  questions: PracticeQuestion[];
  answers: Record<string, AnswerRecord>;
  onRetry: () => void;
}

export function AnswerResultList({ questions, answers, onRetry }: Props) {
```
替换为：
```ts
interface Props {
  questions: PracticeQuestion[];
  answers: Record<string, AnswerRecord>;
  onClose: () => void;
}

export function AnswerResultList({ questions, answers, onClose }: Props) {
```

- [ ] **Step 2: 改「完成」按钮 `onClick` 由 `onRetry` 改 `onClose`**

原：
```ts
          <button
            onClick={onRetry}
            className="px-8 py-2.5 rounded-[10px] bg-[var(--brand-500)] text-white text-sm font-semibold hover:bg-[var(--brand-600)] transition-colors shadow-sm"
          >
            完成
          </button>
```
替换为：
```ts
          <button
            onClick={onClose}
            className="px-8 py-2.5 rounded-[10px] bg-[var(--brand-500)] text-white text-sm font-semibold hover:bg-[var(--brand-600)] transition-colors shadow-sm"
          >
            完成
          </button>
```

- [ ] **Step 3: 暂不构建（待 Task 10 接线 `onClose` 后一并构建）**

- [ ] **Step 4: Commit（与 Task 10 合并）**

---

## Task 10: 前端 CourseDetailPage 集成（加载 effect + onSubmit + 工具条 + onClose）

**Files:**
- Modify: `apps/web/src/pages/student/CourseDetailPage.tsx`

- [ ] **Step 1: import 加 `useEffect, useRef`（react）与新 API 函数**

定位文件顶部 react import（含 `useMemo` 的那行），追加 `useEffect, useRef`。

原 api import 行：
```ts
import { fetchLessonCards, getPreviousLessonErrors, updateProgress, judgePractice, getPracticeHint, type LessonCard, type LessonCardsData, type PracticeGroupMeta } from '@/services/api';
```
替换为：
```ts
import { fetchLessonCards, getPreviousLessonErrors, updateProgress, judgePractice, getPracticeHint, getPracticeResults, resetPracticeCard, resetPracticeLesson, type LessonCard, type LessonCardsData, type PracticeGroupMeta } from '@/services/api';
```

- [ ] **Step 2: store 解构加 `loadResults`**

原：
```ts
const { cardId: sessionCardId, setSession, record, answers, questions: sessionQuestions, reset, hints, setHint } = usePracticeStore();
```
替换为：
```ts
const { cardId: sessionCardId, setSession, loadResults, record, answers, questions: sessionQuestions, reset, hints, setHint } = usePracticeStore();
```

- [ ] **Step 3: 加 `useRef` 标记已加载的 cardId**

在 store 解构行之后加：
```ts
  const loadedResultsRef = useRef<number | null>(null);
```

- [ ] **Step 4: 加进卡加载持久化结果的 effect**

在 `fallbackPractice` 的 `useMemo` 之后加：
```ts
  // 进卡加载持久化判题结果 -> ✓/✗ 回显（跨设备/刷新）
  useEffect(() => {
    if (card?.cardType !== 'practice') return;
    if (loadedResultsRef.current === card.id) return;
    loadedResultsRef.current = card.id;
    const questions = (practiceMeta && !practiceMeta.needsFallback)
      ? practiceMeta.questions
      : (fallbackPractice?.questions ?? []);
    if (questions.length === 0) return;
    getPracticeResults(card.id)
      .then((results) => loadResults(card.id, questions, results))
      .catch(() => { /* 加载失败静默，store 保持占位空 answers */ });
  }, [card?.id]);
```

- [ ] **Step 5: 改 `handleOpenModal` 不再 `setSession` 清空**

原：
```ts
  const handleOpenModal = (index: number) => {
    if (!card) return;
    const questions = (practiceMeta && !practiceMeta.needsFallback)
      ? practiceMeta.questions
      : (fallbackPractice?.questions ?? []);
    if (questions.length === 0) return;
    if (sessionCardId !== card.id) {
      setSession(card.id, questions);
    }
    setModalStart(index);
    setModalOpen(true);
  };
```
替换为：
```ts
  const handleOpenModal = (index: number) => {
    if (!card) return;
    const questions = (practiceMeta && !practiceMeta.needsFallback)
      ? practiceMeta.questions
      : (fallbackPractice?.questions ?? []);
    if (questions.length === 0) return;
    if (sessionCardId !== card.id) {
      // 首次进卡：DB 结果可能尚未加载，先放空 answers 占位（cardId+questions 就位即可开弹窗）；
      // loadResults effect 随后会用持久化结果填补 answers。
      loadResults(card.id, questions, []);
    }
    setModalStart(index);
    setModalOpen(true);
  };
```

- [ ] **Step 6: 改 AnswerModal 的 `onSubmit` 回调，直传 `n` + `questionN`**

原：
```ts
            onSubmit={async (questionText, studentAnswer) => {
              const n = questions.find(q => q.text === questionText)?.n ?? '0-0';
              try {
                const res = await judgePractice({
                  cardId: card.id,
                  lessonId,
                  subjectId,
                  questionText,
                  studentAnswer,
                });
                record(n, studentAnswer, res);
                return res;
              } catch {
                // 判定失败（超时/服务异常）：仍记录一条失败结果，重抛让 AnswerModal 标记该题 failed
                record(
                  n,
                  studentAnswer,
                  { questionId: null, isCorrect: false, method: 'ai', analysis: null, errorType: null },
                  { failed: true },
                );
                throw new Error('判定失败');
              }
            }}
```
替换为：
```ts
            onSubmit={async (questionText, studentAnswer, n) => {
              try {
                const res = await judgePractice({
                  cardId: card.id,
                  lessonId,
                  subjectId,
                  questionN: n,
                  questionText,
                  studentAnswer,
                });
                record(n, studentAnswer, res);
                return res;
              } catch {
                // 判定失败（超时/服务异常）：仍记录一条失败结果，重抛让 AnswerModal 标记该题 failed
                record(
                  n,
                  studentAnswer,
                  { questionId: null, isCorrect: false, method: 'ai', analysis: null, errorType: null },
                  { failed: true },
                );
                throw new Error('判定失败');
              }
            }}
```

- [ ] **Step 7: 改 AnswerResultList 接线 `onClose`（移除 reset）**

原：
```tsx
      {resultOpen && (
        <AnswerResultList
          questions={sessionQuestions}
          answers={answers}
          onRetry={() => { setResultOpen(false); reset(); }}
        />
      )}
```
替换为：
```tsx
      {resultOpen && (
        <AnswerResultList
          questions={sessionQuestions}
          answers={answers}
          onClose={() => setResultOpen(false)}
        />
      )}
```

- [ ] **Step 8: 在练习卡题块列表上方加 reset 工具条**

定位练习卡题块列表渲染处（`card.cardType === 'practice'` 分支内、题块列表之前）。在其前插入工具条：

```tsx
      {card?.cardType === 'practice' && (
        <div className="flex items-center gap-3 px-1 py-2 text-xs text-[var(--text-tertiary)]">
          {Object.keys(answers).length > 0 && (
            <button
              onClick={() => {
                if (!window.confirm('确定重置本卡练习记录吗？该卡所有对错记录将被清除。')) return;
                resetPracticeCard(card.id).then(() => reset());
              }}
              className="underline hover:text-[var(--text-secondary)]"
            >
              重置本卡
            </button>
          )}
          <button
            onClick={() => {
              if (!window.confirm('确定清空本课全部练习记录吗？本课所有练习卡的对错记录将被清除。')) return;
              resetPracticeLesson(lessonId).then(() => reset());
            }}
            className="underline hover:text-[var(--text-secondary)]"
          >
            清空本课练习
          </button>
        </div>
      )}
```

> 若该练习卡题块列表渲染处已有 `card?.cardType === 'practice'` 守卫的父容器，可将工具条直接放在该容器内列表之前，外层守卫可省略；以实际 JSX 结构为准，工具条代码不变。

- [ ] **Step 9: 类型检查 + 构建**

Run: `cd apps/web && npm run build`
Expected: tsc + vite 构建通过（Task 8/9 的签名变更于此消除）。

- [ ] **Step 10: Commit（含 Task 8/9/10）**

```bash
git add apps/web/src/components/business/AnswerModal.tsx apps/web/src/components/business/AnswerResultList.tsx apps/web/src/pages/student/CourseDetailPage.tsx
git commit -m "feat(web): 练习结果持久化回显 + 单卡/课程级 reset + 修复完成清空 bug"
```

---

## Task 11: 文档同步 - openapi + API 设计文档 + CLAUDE.md

**Files:**
- Modify: `docs/api/openapi.yaml`
- Modify: `docs/API接口与数据流设计文档.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: `openapi.yaml` - `JudgeRequest` schema 加 `questionN`**

在 `JudgeRequest` 的 `properties` 中 `studentAnswer` 之前加：
```yaml
    questionN:
      type: string
      description: 卡内复合题号（如 "0-1"），practice_results upsert 去重键
```
并把 `required` 改为 `[cardId, lessonId, subjectId, questionN, questionText, studentAnswer]`。

- [ ] **Step 2: `openapi.yaml` - 在 `/practice/previous-errors` path 之前加 `GET/DELETE /practice/results`**

```yaml
  /practice/results:
    get:
      tags: [Practice]
      operationId: getPracticeResults
      summary: 取该卡持久化判题结果（✓/✗ 回显）
      security: [{ bearerAuth: [] }]
      parameters:
        - name: cardId
          in: query
          required: true
          schema: { type: integer }
      responses:
        '200':
          description: 该卡全部持久化判题结果
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/CommonResponse'
                  - type: object
                    properties:
                      data:
                        type: array
                        items: { $ref: '#/components/schemas/PracticeResult' }
    delete:
      tags: [Practice]
      operationId: resetPracticeResults
      summary: 重置练习记录（cardId 单卡 / lessonId 本课全部，互斥）
      security: [{ bearerAuth: [] }]
      parameters:
        - name: cardId
          in: query
          required: false
          schema: { type: integer }
        - name: lessonId
          in: query
          required: false
          schema: { type: integer }
      responses:
        '200':
          description: 已删除
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/CommonResponse'
                  - type: object
                    properties:
                      data: { type: object, nullable: true }
        '400':
          description: 参数错误（cardId/lessonId 同传或都缺）
          content:
            application/json:
              schema:
                type: object
                properties:
                  code: { type: integer, example: 1001 }
                  message: { type: string, example: 须指定 cardId 或 lessonId }
```

- [ ] **Step 3: `openapi.yaml` - 在 practice schemas 区（`PreviousErrorsResult` 之后）加 `PracticeResult` schema**

```yaml
PracticeResult:
  type: object
  properties:
    questionN: { type: string, description: 卡内复合题号（如 "0-1"） }
    questionText: { type: string, description: 题面原文 }
    studentAnswer: { type: string, description: 学生提交答案 }
    isCorrect: { type: boolean, description: 对错 }
    method: { type: string, enum: [exact, ai] }
    analysis: { type: string, nullable: true, description: 题解（仅错题，复用判题 analysis；对题为 null） }
    errorType: { type: string, nullable: true, enum: [logic, calculation, format, missing] }
```

- [ ] **Step 4: API 设计文档 §4.16 表加两行**

在 `/api/practice/discuss-card` 行之后、`GET /api/practice/previous-errors` 行之前（或表末）加：
```markdown
| GET | `/api/practice/results?cardId={cardId}` | 取该练习卡持久化判题结果（对/错 + analysis 题解），驱动 ✓/✗ 跨设备/刷新回显。响应体：`[{questionN, questionText, studentAnswer, isCorrect, method, analysis, errorType}]` | MVP |
| DELETE | `/api/practice/results?cardId={cardId}` 或 `?lessonId={lessonId}` | 重置练习记录：`cardId` 清单卡、`lessonId` 清本课全部练习卡（二者互斥，同传/都缺 400）。只删 `practice_results`，不动 `main_error_books` | MVP |
```

- [ ] **Step 5: API 设计文档 §6.9 judge 数据流补语义**

在 §6.9 流程图末尾「响应返回前端」之前，把「答错（!isCorrect）-> 写入主线错题本」段说明由直接 create 改为 find-or-create，并在响应返回前补 `practice_results` 落库 + 答对清错题。具体：在该段 `mainErrorRepo.create({...})` 后加注释行：
```text
  │  （答错改为 find-or-create：先 findUnclearedByStudentQuestion，命中复用、未命中才 create）
  │
  ▼
答对（isCorrect）-> clearUnclearedByStudentQuestion 清该题未清错题（不限 source，影响跨课门禁计数）
  │
  ▼
对/错都 upsert practice_results（best-effort；UNIQUE student_id+card_id+question_n，单题重做覆盖）
```

- [ ] **Step 6: API 设计文档新增 §6.x 数据流（在 §6.13 之后）**

```text
### 6.14 课堂练习结果持久化与 reset

进 practice 卡 / 刷新 / 跨设备登录
  │
  ▼
前端 GET /api/practice/results?cardId=
  │  响应：[{questionN, questionText, studentAnswer, isCorrect, method, analysis, errorType}]
  ▼
practiceStore.loadResults 填充 answers -> 题块显示 ✓/✗（analysis 供题解展示）
  │
  ▼
单题重做 -> POST /api/practice/judge（带 questionN）-> ON DUPLICATE KEY UPDATE 覆盖该题行
  │
  ▼
重置本卡：DELETE /api/practice/results?cardId= -> deleteByStudentCard + 前端 reset()
清空本课：DELETE /api/practice/results?lessonId= -> deleteByStudentLesson + 前端 reset()
  │  （reset 只删 practice_results，不碰 main_error_books）
```

- [ ] **Step 7: API 设计文档 §10 变更日志加 v1.7**

```markdown
| v1.7 | 2026-08-11 | 新增 `GET/DELETE /api/practice/results`（判题结果持久化 + 两级 reset）；`JudgeRequest` 加 `questionN`；新增 §6.14 数据流；§6.9 judge 流程补「答错 find-or-create 错题本、答对清错题、对/错都落 `practice_results`」 |
```

- [ ] **Step 8: `CLAUDE.md` 追加实现记录段（在最后一组「2026-08-10 新增…」之后）**

```markdown
**2026-08-11 新增（课堂练习对错持久化）**：① DB--新建 `practice_results` 表（一行=学生×卡×题判题结果，UNIQUE `student_id+card_id+question_n` 支撑单题重做 upsert；`schema.sql` + 迁移 + 触发器 + DB 设计文档同步；顺带修正 `main_error_books` 列表陈旧的 `lesson_id`/`dialogue_id`/`discuss`）。② `PracticeResultsRepository`（`upsert` 走 `INSERT ... ON DUPLICATE KEY UPDATE`、`findByStudentCard`、`deleteByStudentCard`/`deleteByStudentLesson`，best-effort 由 `judge` try/catch）。③ `judge()` 改造--`JudgeInput` 加 `questionN`；对/错都 best-effort upsert `practice_results`；**答错改 find-or-create 错题本**（`findUnclearedByStudentQuestion` 命中复用、未命中才 create，避免重复答错堆积，孤儿题回滚补偿仅新建分支保留）；**答对调新方法 `clearUnclearedByStudentQuestion`**（镜像 find 条件批量 `is_cleared=1`，不限 source，影响跨课门禁计数；接线此前未接线的 markCleared 语义）。④ 新端点 `GET /api/practice/results?cardId=`（取持久化结果）、`DELETE /api/practice/results?cardId=|lessonId=`（单卡/课程级 reset，互斥校验，只删 `practice_results` 不动 `main_error_books`）。⑤ 前端--`practiceStore.loadResults`（合并语义：同卡重入保留在途作答、DB 填空缺，防加载晚于作答覆盖）；`CourseDetailPage` 进卡 effect 拉取结果回显 ✓/✗、`handleOpenModal` 不再 `setSession` 清空、reset 工具条（重置本卡/清空本课）、`onSubmit` 直传 `n`（消除题面文本反查）；**`AnswerResultList`「完成」由 `onRetry` 改 `onClose`、移除 `reset()`**（修核心 bug：关闭结果表单不再清空 ✓/✗）。⑥ 验证：server tsc + 测试绿、web tsc 绿。详见 `docs/superpowers/plans/2026-08-11-practice-results-persistence.md`。
```

- [ ] **Step 9: 端点对齐检查**

Run: `grep -n "/practice/results" docs/api/openapi.yaml docs/API接口与数据流设计文档.md`
Expected: 两文档均命中 `GET` 与 `DELETE` 的 `/practice/results` 路径。

- [ ] **Step 10: Commit**

```bash
git add docs/api/openapi.yaml docs/API接口与数据流设计文档.md CLAUDE.md
git commit -m "docs: 同步 practice_results 持久化端点/数据流/CLAUDE.md"
```

---

## 端到端验证（全部 Task 完成后）

- [ ] **后端全量测试绿**

Run: `cd apps/server && npm run build && npm test`
Expected: tsc 通过、全部测试 PASS（含新增 repo/service 用例）。

- [ ] **前端构建绿**

Run: `cd apps/web && npm run build`
Expected: tsc + vite 通过。

- [ ] **浏览器端到端实测（7 条，对应 spec §8）**

1. 答完一张卡 -> 关闭结果表单 -> ✓/✗ 仍显示在卡上（修 bug 验证）。
2. 刷新页面 / 重新进卡 -> ✓/✗ 仍在（持久化验证）。
3. 点错题重做 -> 该题 ✓/✗ 更新、其他题不变（单题覆盖）。
4. 单卡 reset -> 该卡全清、其他卡不变。
5. 全局 reset -> 本课所有练习卡全清。
6. 错题本不受 reset 影响（解耦验证：reset 后查 `main_error_books` 仍有记录）。
7. 答错 -> 重答正确 -> 该题错题记录 `is_cleared=1`、跨课门禁计数减少。

---

## Self-Review

**1. Spec 覆盖**
- §4 数据模型 → Task 1（表 + 触发器 + 迁移 + 文档）。✓
- §5.1 repo → Task 2。✓
- §5.2 judge 改造（questionN、find-or-create、答对清错题、对/错 upsert、`clearUnclearedByStudentQuestion`）→ Task 3（清错题方法）+ Task 4（judge）。✓
- §5.3 getResults/resetCard/resetLesson + PracticeResultDto → Task 4。✓
- §5.4 端点 → Task 5。✓
- §5.5 DTO questionN → Task 4 Step 13。✓
- §6.1 api.ts → Task 6。✓
- §6.2 practiceStore.loadResults → Task 7。✓
- §6.3 CourseDetailPage（effect、handleOpenModal、onSubmit n、reset 工具条）→ Task 10。✓
- §6.4 AnswerModal onSubmit 传 n → Task 8。✓
- §6.5 AnswerResultList onRetry->onClose → Task 9。✓
- §7 边界 → 测试覆盖（judge 失败不 upsert、upsert 失败不阻断、find-or-create 复用）；reset 解耦在 Task 5/10。✓
- §8 测试 + 文档同步 → Task 2-5 测试 + Task 11 文档 + E2E。✓
- §9 out of scope：判题失败不落库（无 `failed` 列，✓）、无题面 hash 校验（✓）、无家长端/聚合分析/独立题解端点（✓）。

**2. 占位符扫描**：无 TBD/TODO；所有代码步骤均含完整代码；Task 10 Step 8 工具条放置以「实际 JSX 结构为准」描述但工具条代码完整（非占位）。

**3. 类型一致性**：`questionN`（JudgeInput/JudgePracticeDto/judgePractice payload/PracticeResult/PracticeResultDto/practice_results.question_n）全程一致；`clearUnclearedByStudentQuestion` 签名（Task 3 定义、Task 4 调用）一致 `(studentId, questionId, cardId, questionText)`；`PracticeResultsRepository` 方法名（upsert/findByStudentCard/deleteByStudentCard/deleteByStudentLesson）Task 2 定义、Task 4 调用一致；`loadResults(cardId, questions, results)` Task 7 定义、Task 10 调用一致；`onClose` Task 9 定义、Task 10 接线一致。`mkSvc` 第 9 参 `practiceResultsRepo` 与 `PracticeService` 构造函数第 9 注入顺序一致。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-11-practice-results-persistence.md`. Two execution options:

**1. Subagent-Driven (recommended)** - 每个 Task 派一个 fresh subagent 实现，Task 间两阶段 review，快速迭代。

**2. Inline Execution** - 在本会话用 executing-plans 逐 Task 执行，带 checkpoint 复核。

Which approach?
