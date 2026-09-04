# 专项训练「不再展示」功能实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在专项训练中让学生标记"不再展示"某题，下次选题随机抽题时排除已标记的题；学生可在清单页逐条撤销或全部重置。

**Architecture:** 新建 `student_hidden_questions` 表（`student_id + question_id` 全局排除，不分知识点），改 `QuestionsRepository.findRandomByKpAndType` 加 `LEFT JOIN ... IS NULL` 排除已标记题（仅此一处选题路径受影响）。4 个新 REST 端点走 NestJS + JWT 学生角色，响应统一经 `ResponseInterceptor` 包成 `{ code:0, data }`。前端在 `QuestionRunner` 新增 ungated `questionMetaActions` 插槽承载"不再展示"按钮，新建清单页 + 配置页入口。

**Tech Stack:** NestJS（后端）、React 18 + Vite + TS + Tailwind（前端）、MySQL 8（mysql2/promise）、Vitest（后端测试）、Conventional Commits。

## Global Constraints

- TS 严格模式、2 空格缩进、组件/类 PascalCase、函数/变量 camelCase；提交前 `apps/web` 跑 `npm run lint`
- 后端测试铁律：测试断言与 config/设计冲突时改测试，勿改设计文档
- 响应信封：`ResponseInterceptor` 把所有返回包成 `{ code:0, message:'ok', data: data ?? null }`；前端 `fetchApi` 做 `await res.json()` 检查 `code`——**禁用 `@HttpCode(204)` / 空响应**，void 操作 return `undefined` 即可
- 排除范围**仅专项训练**：`findRandomByKpAndType` 一处改，主线练习/错题重做/考试选题路径不动
- 防答案泄露：白名单序列化只出 `questionId/text/type/options`
- 防御性 SQL：repo 层 `WHERE` 含 `student_id` 防 IDOR，`student_id` 一律从 JWT `user.sub` 取
- 无 emoji、无吉祥物装饰；线性 SVG 图标
- iPad landscape (>=1024px) 主断点
- Socratic 原则："不再展示"按钮视觉权重低于"提示"/"讲一讲"
- `findRandomByKpAndType` 用 `pool.query`（非 `execute`）——`LIMIT ?` 在 prepared statement 下 mysql2 报 `Incorrect arguments to mysqld_stmt_execute`（既有注释 `questions.repo.ts:86-90`）

**Spec:** `docs/superpowers/specs/2026-09-04-targeted-practice-exclude-marked-design.md`

---

## File Structure

**新建：**
- `apps/server/src/database/repositories/student-hidden-questions.repo.ts` — repo，CRUD 隐藏标记
- `apps/server/src/database/repositories/student-hidden-questions.repo.test.ts` — repo 单测
- `apps/web/src/pages/student/training/HiddenQuestionsPage.tsx` — 清单页

**修改：**
- `tools/db/schema.sql` — 加 `student_hidden_questions` 建表
- `apps/server/src/database/repositories/types.ts` — 加 `StudentHiddenQuestionRow`
- `apps/server/src/database/repositories/index.ts` — 导出新 repo
- `apps/server/src/database/repositories/questions.repo.ts` — `findRandomByKpAndType` 签名 + SQL
- `apps/server/src/database/repositories/questions.repo.test.ts` — 更新签名断言
- `apps/server/src/modules/training/training.service.ts` — 改 `startTargetedPractice` + 4 新方法
- `apps/server/src/modules/training/training.service.test.ts` — 更新 + 新增测试
- `apps/server/src/modules/training/training.controller.ts` — 改 `startTargetedPractice` + 4 新端点
- `apps/server/src/modules/training/training.module.ts` — 注册新 repo
- `apps/web/src/services/api.ts` — 4 个新 API 函数 + `HiddenQuestion` 类型
- `apps/web/src/components/business/answer/QuestionRunner.tsx` — 新增 `questionMetaActions` 插槽
- `apps/web/src/pages/student/training/TargetedRunPage.tsx` — 加按钮 + Modal
- `apps/web/src/pages/student/training/TargetedConfigPage.tsx` — 加清单入口
- `apps/web/src/routes/index.tsx` — 加 `/student/training/targeted/hidden` 路由
- `docs/api/openapi.yaml` — 4 个新端点
- `docs/API接口与数据流设计文档.md` — 端点清单 + 数据流
- `docs/ai-core-changelog.md` — 2026-09-04 条目

---

## Task 1: DB schema 加 `student_hidden_questions` 表

**Files:**
- Modify: `tools/db/schema.sql`（在 `main_error_books` 建表之后、`practice_results` 之前加新表）

- [ ] **Step 1: 在 schema.sql 加建表语句**

在 `tools/db/schema.sql` 第 530 行（`main_error_books` 表结束的 `) ENGINE=InnoDB ...;` 之后、`practice_results` 注释之前）插入：

```sql

-- ============================================================
-- 学生「不再展示」清单（专项训练选题排除用）
-- ============================================================

CREATE TABLE IF NOT EXISTS student_hidden_questions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  subject_id BIGINT NOT NULL,
  question_id BIGINT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_shq_student_question (student_id, question_id),
  KEY idx_shq_student (student_id),
  KEY idx_shq_student_subject (student_id, subject_id),
  CONSTRAINT fk_shq_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_shq_subject_id FOREIGN KEY (subject_id) REFERENCES subjects (id) ON DELETE RESTRICT,
  CONSTRAINT fk_shq_question_id FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 2: 本地建表（幂等，不影响既有数据）**

Run:
```bash
mysql -u ai_k12 -pai_k12 ai_k12 < tools/db/schema.sql 2>&1 | tail -5 || \
  mysql -u ai_k12 -pai_k12 ai_k12 -e "CREATE TABLE IF NOT EXISTS student_hidden_questions (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    student_id BIGINT NOT NULL,
    subject_id BIGINT NOT NULL,
    question_id BIGINT NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uniq_shq_student_question (student_id, question_id),
    KEY idx_shq_student (student_id),
    KEY idx_shq_student_subject (student_id, subject_id),
    CONSTRAINT fk_shq_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
    CONSTRAINT fk_shq_subject_id FOREIGN KEY (subject_id) REFERENCES subjects (id) ON DELETE RESTRICT,
    CONSTRAINT fk_shq_question_id FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;"
```

Expected: 无报错（`IF NOT EXISTS` 幂等）。验证建表成功：
```bash
mysql -u ai_k12 -pai_k12 ai_k12 -e "DESC student_hidden_questions;"
```
Expected: 输出 6 行字段（id/student_id/subject_id/question_id/created_at/updated_at）。

- [ ] **Step 3: Commit**

```bash
git add tools/db/schema.sql
git commit -m "feat(db): 新增 student_hidden_questions 表（专项训练不再展示清单）"
```

---

## Task 2: 后端 `StudentHiddenQuestionsRepository` + 单测

**Files:**
- Create: `apps/server/src/database/repositories/student-hidden-questions.repo.ts`
- Create: `apps/server/src/database/repositories/student-hidden-questions.repo.test.ts`
- Modify: `apps/server/src/database/repositories/types.ts`
- Modify: `apps/server/src/database/repositories/index.ts`

**Interfaces:**
- Produces: `StudentHiddenQuestionsRepository` 类，方法 `mark(studentId, subjectId, questionId): Promise<void>`、`unmark(studentId, questionId): Promise<number>`、`unmarkAll(studentId): Promise<number>`、`findAllByStudent(studentId, subjectId): Promise<HiddenQuestionRow[]>`
- 供 Task 4 `TrainingService` 注入

- [ ] **Step 1: 在 types.ts 加 Row 类型**

在 `apps/server/src/database/repositories/types.ts` 末尾加：

```ts
export interface StudentHiddenQuestionRow extends RowDataPacket {
  id: number;
  student_id: number;
  subject_id: number;
  question_id: number;
  created_at: Date;
  updated_at: Date;
}

/** 不再展示清单展示用行（JOIN questions + qkp 聚合后）。 */
export interface HiddenQuestionListRow extends RowDataPacket {
  questionId: number;
  questionText: string;
  type: string;
  kpName: string | null;
  markedAt: Date;
}
```

- [ ] **Step 2: 在 index.ts 加导出**

在 `apps/server/src/database/repositories/index.ts` 末尾加（按字母序插在 `StudentsRepository`/`SubjectsRepository` 附近，但实际位置不影响功能，放末尾即可）：

```ts
export { StudentHiddenQuestionsRepository } from './student-hidden-questions.repo.js';
```

并在同文件 `export type { ... } from './types.js';` 行的 type 列表里加 `StudentHiddenQuestionRow, HiddenQuestionListRow`。

- [ ] **Step 3: 先写 repo 单测（TDD，验证 SQL 与参数）**

创建 `apps/server/src/database/repositories/student-hidden-questions.repo.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { StudentHiddenQuestionsRepository } from './student-hidden-questions.repo';

/** mockPool：execute 走 prepared statement（INSERT/DELETE 返回 [ResultSetHeader, []]），
 *  query 走客户端转义（SELECT 返回 [rows, []]）。findAllByStudent 用 execute。 */
const mockPool = (rows: any[] = [], affected = 0) => ({
  execute: vi.fn().mockResolvedValue([{ affectedRows: affected }, []] as any),
  query: vi.fn().mockResolvedValue([rows, []] as any),
});

describe('StudentHiddenQuestionsRepository.mark', () => {
  it('INSERT IGNORE 幂等，参数 (studentId, subjectId, questionId)', async () => {
    const pool = mockPool([], 1);
    const repo = new StudentHiddenQuestionsRepository(pool as any);
    await repo.mark(7, 1, 10);
    expect(pool.execute).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('INSERT IGNORE INTO student_hidden_questions');
    expect(sql).toContain('(student_id, subject_id, question_id)');
    expect(params).toEqual([7, 1, 10]);
  });
});

describe('StudentHiddenQuestionsRepository.unmark', () => {
  it('DELETE WHERE student_id=? AND question_id=?（归属校验防 IDOR）', async () => {
    const pool = mockPool([], 1);
    const repo = new StudentHiddenQuestionsRepository(pool as any);
    const n = await repo.unmark(7, 10);
    expect(n).toBe(1);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('DELETE FROM student_hidden_questions');
    expect(sql).toContain('student_id = ?');
    expect(sql).toContain('question_id = ?');
    expect(params).toEqual([7, 10]);
  });
});

describe('StudentHiddenQuestionsRepository.unmarkAll', () => {
  it('DELETE WHERE student_id=?', async () => {
    const pool = mockPool([], 3);
    const repo = new StudentHiddenQuestionsRepository(pool as any);
    const n = await repo.unmarkAll(7);
    expect(n).toBe(3);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('DELETE FROM student_hidden_questions');
    expect(sql).toContain('student_id = ?');
    expect(params).toEqual([7]);
  });
});

describe('StudentHiddenQuestionsRepository.findAllByStudent', () => {
  it('JOIN questions + 相关子查询取首个 primary kp 名，参数 (studentId, subjectId)', async () => {
    const rows = [{
      questionId: 10,
      questionText: '题面预览',
      type: 'choice',
      kpName: '有理数',
      markedAt: new Date('2026-09-04T00:00:00.000Z'),
    }];
    const pool = mockPool(rows);
    const repo = new StudentHiddenQuestionsRepository(pool as any);
    const r = await repo.findAllByStudent(7, 1);
    expect(r).toEqual(rows);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('FROM student_hidden_questions shq');
    expect(sql).toContain('JOIN questions q ON q.id = shq.question_id');
    expect(sql).toContain('shq.student_id = ?');
    expect(sql).toContain('shq.subject_id = ?');
    expect(sql).toContain('ORDER BY shq.created_at DESC');
    expect(params).toEqual([7, 1]);
  });
});
```

- [ ] **Step 4: 跑测试确认失败（类未定义）**

Run: `cd apps/server && npx vitest run src/database/repositories/student-hidden-questions.repo.test.ts`
Expected: FAIL，`StudentHiddenQuestionsRepository is not defined`。

- [ ] **Step 5: 实现 repo**

创建 `apps/server/src/database/repositories/student-hidden-questions.repo.ts`：

```ts
import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { HiddenQuestionListRow } from './types.js';

/**
 * 学生「不再展示」清单 repo。
 *
 * 仅服务专项训练选题排除（TrainingService.startTargetedPractice -> QuestionsRepository
 * .findRandomByKpAndType 的 LEFT JOIN）。其他选题路径（主线练习/错题重做/考试）不读此表。
 *
 * 防御性 WHERE：unmark/unmarkAll 一律含 student_id，避免 IDOR（学生只能撤销自己的标记）。
 * 幂等：mark 走 INSERT IGNORE（UNIQUE 约束兜底），unmark 删 0 行也不报错。
 */
@Injectable()
export class StudentHiddenQuestionsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /** 标记：INSERT IGNORE 幂等（重复标记不报错，UNIQUE 约束兜底）。 */
  async mark(studentId: number, subjectId: number, questionId: number): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `INSERT IGNORE INTO student_hidden_questions (student_id, subject_id, question_id)
       VALUES (?, ?, ?)`,
      [studentId, subjectId, questionId],
    );
  }

  /** 撤销单条：归属校验防 IDOR（WHERE 含 student_id）。返回删除行数。 */
  async unmark(studentId: number, questionId: number): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `DELETE FROM student_hidden_questions WHERE student_id = ? AND question_id = ?`,
      [studentId, questionId],
    );
    return result.affectedRows;
  }

  /** 全部重置：清空该生所有隐藏标记。返回删除行数。 */
  async unmarkAll(studentId: number): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `DELETE FROM student_hidden_questions WHERE student_id = ?`,
      [studentId],
    );
    return result.affectedRows;
  }

  /** 清单：JOIN questions 取题面预览（SUBSTRING 80 字截断）+ 相关子查询取首个 primary kp 名。 */
  async findAllByStudent(studentId: number, subjectId: number): Promise<HiddenQuestionListRow[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT shq.question_id AS questionId,
              SUBSTRING(q.content, 1, 80) AS questionText,
              q.type,
              (SELECT kp.name FROM question_knowledge_points qkp
               JOIN knowledge_points kp ON kp.id = qkp.knowledge_point_id
               WHERE qkp.question_id = q.id AND qkp.role = 'primary' LIMIT 1) AS kpName,
              shq.created_at AS markedAt
       FROM student_hidden_questions shq
       JOIN questions q ON q.id = shq.question_id
       WHERE shq.student_id = ? AND shq.subject_id = ?
       ORDER BY shq.created_at DESC`,
      [studentId, subjectId],
    );
    return rows as HiddenQuestionListRow[];
  }
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/database/repositories/student-hidden-questions.repo.test.ts`
Expected: PASS，4 个测试全绿。

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/database/repositories/student-hidden-questions.repo.ts \
        apps/server/src/database/repositories/student-hidden-questions.repo.test.ts \
        apps/server/src/database/repositories/types.ts \
        apps/server/src/database/repositories/index.ts
git commit -m "feat(server): StudentHiddenQuestionsRepository 仓储 + 单测"
```

---

## Task 3: 改 `QuestionsRepository.findRandomByKpAndType` 排除已标记题

**Files:**
- Modify: `apps/server/src/database/repositories/questions.repo.ts:68-93`
- Modify: `apps/server/src/database/repositories/questions.repo.test.ts`

**Interfaces:**
- Consumes: 新表 `student_hidden_questions`（Task 1）
- Produces: `findRandomByKpAndType(studentId, subjectId, kpId, type, count)` —— 供 Task 4 `TrainingService` 调用
- 破坏性签名变更：首个参数从 `subjectId` 改为 `studentId`，所有调用方须同步（仅 `TrainingService.startTargetedPractice` 一处）

- [ ] **Step 1: 先改测试（TDD，体现新签名与 SQL）**

修改 `apps/server/src/database/repositories/questions.repo.test.ts`，把 3 个测试里的 `findRandomByKpAndType` 调用都加 `studentId` 前置参数，并在 SQL 断言里加 `LEFT JOIN student_hidden_questions` 和 `shq.id IS NULL`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { QuestionsRepository } from './questions.repo';

/** mockPool：SELECT 一律返回 rows（main-error-books.repo.test.ts 同款形状）。
 *  findRandomByKpAndType 用 pool.query（LIMIT ? 不能走 prepared statement，
 *  联调实测 mysql2 execute 报 Incorrect arguments to mysqld_stmt_execute）。 */
const mockPool = (rows: any[] = []) => ({
  execute: vi.fn().mockResolvedValue([[], []]),
  query: vi.fn().mockResolvedValue([rows, []]),
});

describe('QuestionsRepository.findRandomByKpAndType', () => {
  it('SQL 含 LEFT JOIN student_hidden_questions / JOIN qkp / 空答案过滤 / RAND() / LIMIT ?，type 非空时带题型过滤', async () => {
    const pool = mockPool([]);
    const repo = new QuestionsRepository(pool as any);
    await repo.findRandomByKpAndType(7, 1, 3, 'proof', 5);
    expect(pool.execute).not.toHaveBeenCalled();
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('JOIN question_knowledge_points qkp');
    expect(sql).toContain('LEFT JOIN student_hidden_questions shq');
    expect(sql).toContain('shq.question_id = q.id AND shq.student_id = ?');
    expect(sql).toContain('shq.id IS NULL');
    expect(sql).toContain('qkp.knowledge_point_id = ?');
    expect(sql).toContain('q.subject_id = ?');
    expect(sql).toContain('q.is_active = 1');
    expect(sql).toContain('q.type = ?');
    // 终审备忘：choice/true_false 空答案题不出现在专项练习
    expect(sql).toContain("NOT (q.type IN ('choice','true_false') AND q.answer = '')");
    expect(sql).toContain('RAND()');
    expect(sql).toContain('LIMIT ?');
    expect(params).toEqual([7, 1, 3, 'proof', 5]);
  });

  it('type=null 时 SQL 不含题型过滤，参数省略 type', async () => {
    const pool = mockPool([]);
    const repo = new QuestionsRepository(pool as any);
    await repo.findRandomByKpAndType(7, 1, 3, null, 10);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).not.toContain('q.type = ?');
    expect(params).toEqual([7, 1, 3, 10]);
  });

  it('返回 QuestionRow 行', async () => {
    const row = { id: 10, type: 'choice', content: '题面', answer: 'A' };
    const repo = new QuestionsRepository(mockPool([row]) as any);
    const rows = await repo.findRandomByKpAndType(7, 1, 3, null, 5);
    expect(rows).toEqual([row]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败（旧实现签名不匹配）**

Run: `cd apps/server && npx vitest run src/database/repositories/questions.repo.test.ts`
Expected: FAIL（旧实现第一个参数当 `studentId` 用，SQL 无 LEFT JOIN，断言全挂）。

- [ ] **Step 3: 改 `questions.repo.ts` 实现**

修改 `apps/server/src/database/repositories/questions.repo.ts` 的 `findRandomByKpAndType`（line 68-93）为：

```ts
  /**
   * 专项练习随机抽题（训练模块 Task 8）：按学科 + 知识点（JOIN qkp）随机取 count 题。
   * type 传 null 时不过滤题型；choice/true_false 空答案题一律排除（终审备忘：
   * 判不了对的题不进专项练习）。
   *
   * 「不再展示」排除（2026-09-04）：LEFT JOIN student_hidden_questions，
   * 该生已标记的题 shq.id 非空 -> WHERE shq.id IS NULL 过滤掉。
   * studentId 由 TrainingService 从 controller JWT user.sub 透传。
   */
  async findRandomByKpAndType(
    studentId: number,
    subjectId: number,
    kpId: number,
    type: string | null,
    count: number,
  ): Promise<QuestionRow[]> {
    const typeFilter = type != null ? ' AND q.type = ?' : '';
    const sql = `SELECT q.* FROM questions q
      JOIN question_knowledge_points qkp ON qkp.question_id = q.id
      LEFT JOIN student_hidden_questions shq
        ON shq.question_id = q.id AND shq.student_id = ?
      WHERE q.subject_id = ? AND qkp.knowledge_point_id = ? AND q.is_active = 1${typeFilter}
        AND NOT (q.type IN ('choice','true_false') AND q.answer = '')
        AND shq.id IS NULL
      ORDER BY RAND() LIMIT ?`;
    const params = type != null
      ? [studentId, subjectId, kpId, type, count]
      : [studentId, subjectId, kpId, count];
    // Use pool.query (client-side escaping) instead of pool.execute (server-side
    // prepared statements): MySQL rejects `LIMIT ?` as a prepared-statement
    // placeholder with "Incorrect arguments to mysqld_stmt_execute"（联调实测；
    // 与 ai-dialogues.repo.ts findByStudentAndTrack 同款处理）。? 值仍经 mysql2
    // 转义，无注入风险。
    const [rows] = await this.pool.query<RowDataPacket[]>(sql, params);
    return rows as QuestionRow[];
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/database/repositories/questions.repo.test.ts`
Expected: PASS，3 个测试全绿。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/database/repositories/questions.repo.ts \
        apps/server/src/database/repositories/questions.repo.test.ts
git commit -m "feat(server): findRandomByKpAndType 排除已标记不再展示的题"
```

---

## Task 4: `TrainingService` 改 `startTargetedPractice` + 4 个新方法

**Files:**
- Modify: `apps/server/src/modules/training/training.service.ts`
- Modify: `apps/server/src/modules/training/training.service.test.ts`

**Interfaces:**
- Consumes: `StudentHiddenQuestionsRepository`（Task 2）、新签名 `findRandomByKpAndType`（Task 3）
- Produces: `startTargetedPractice({ studentId, subjectId, kpId, type, count })`、`markHidden(studentId, subjectId, questionId)`、`unmarkHidden(studentId, questionId)`、`unmarkAllHidden(studentId)`、`listHidden(studentId, subjectId)` —— 供 Task 5 controller 调用

- [ ] **Step 1: 先更新 `training.service.test.ts` 的 `mk` factory 与 `startTargetedPractice` 测试**

修改 `apps/server/src/modules/training/training.service.test.ts`：

`mk` factory（line 5-21）加 `hiddenRepo`，构造函数加参数。把整个 `mk` 与 `mkSvc` 替换为：

```ts
const mk = (overrides: any = {}) => ({
  mainErrorRepo: {
    findErrorBookEntries: vi.fn().mockResolvedValue([]),
    bumpLevels: vi.fn().mockResolvedValue(undefined),
  },
  judgeCore: { judgeQuestion: vi.fn() },
  questionsRepo: { findById: vi.fn(), findRandomByKpAndType: vi.fn().mockResolvedValue([]) },
  questionHintsRepo: {
    findByQuestionId: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue(undefined),
  },
  hint: { generate: vi.fn() },
  knowledgePointsRepo: { findBySubject: vi.fn().mockResolvedValue([]) },
  // 「不再展示」repo（2026-09-04）。
  hiddenRepo: {
    mark: vi.fn().mockResolvedValue(undefined),
    unmark: vi.fn().mockResolvedValue(1),
    unmarkAll: vi.fn().mockResolvedValue(0),
    findAllByStudent: vi.fn().mockResolvedValue([]),
  },
  ...overrides,
});
const mkSvc = (deps: ReturnType<typeof mk>) =>
  new TrainingService(
    deps.mainErrorRepo, deps.judgeCore, deps.questionsRepo, deps.knowledgePointsRepo,
    deps.questionHintsRepo, deps.hint, deps.hiddenRepo,
  );
```

`startTargetedPractice` 测试块（line 155-210）——给所有调用加 `studentId: 7`，断言里也加：

```ts
describe('TrainingService.startTargetedPractice', () => {
  const questionRow = {
    id: 10,
    subject_id: 1,
    type: 'choice',
    difficulty: 2,
    content: '题面文本',
    options: '["A. 1", "B. 2"]',
    answer: 'A',
    explanation: '解析内容',
    source: 'paper',
    content_hash: 'hash',
    is_active: 1,
    created_at: new Date('2026-09-01'),
  };

  it('透传抽题参数给 repo（studentId 首参 + type=null 不过滤题型）', async () => {
    const deps = mk();
    await mkSvc(deps).startTargetedPractice({ studentId: 7, subjectId: 1, kpId: 3, type: null, count: 5 });
    expect(deps.questionsRepo.findRandomByKpAndType).toHaveBeenCalledWith(7, 1, 3, null, 5);
  });

  it('透传非空 type', async () => {
    const deps = mk();
    await mkSvc(deps).startTargetedPractice({ studentId: 7, subjectId: 1, kpId: 3, type: 'proof', count: 10 });
    expect(deps.questionsRepo.findRandomByKpAndType).toHaveBeenCalledWith(7, 1, 3, 'proof', 10);
  });

  it('白名单序列化：只出 questionId/text/type/options，剥离 answer/explanation/material', async () => {
    const deps = mk({
      questionsRepo: { findRandomByKpAndType: vi.fn().mockResolvedValue([questionRow]) },
    });
    const r = await mkSvc(deps).startTargetedPractice({ studentId: 7, subjectId: 1, kpId: 3, type: 'choice', count: 5 });
    expect(r.questions).toHaveLength(1);
    const q = r.questions[0];
    expect(q).toEqual({ questionId: 10, text: '题面文本', type: 'choice', options: ['A. 1', 'B. 2'] });
    expect(Object.keys(q).sort()).toEqual(['options', 'questionId', 'text', 'type']);
    expect(JSON.stringify(r)).not.toContain('answer');
    expect(JSON.stringify(r)).not.toContain('explanation');
  });

  it('options 为 null 时原样返回 null，不抛错', async () => {
    const deps = mk({
      questionsRepo: { findRandomByKpAndType: vi.fn().mockResolvedValue([{ ...questionRow, options: null }]) },
    });
    const r = await mkSvc(deps).startTargetedPractice({ studentId: 7, subjectId: 1, kpId: 3, type: null, count: 5 });
    expect(r.questions[0].options).toBeNull();
  });

  it('抽不到题返回空数组（空集合非错误）', async () => {
    const deps = mk({ questionsRepo: { findRandomByKpAndType: vi.fn().mockResolvedValue([]) } });
    const r = await mkSvc(deps).startTargetedPractice({ studentId: 7, subjectId: 1, kpId: 999, type: null, count: 5 });
    expect(r).toEqual({ questions: [] });
  });
});
```

Controller 校验块（line 212-244）——`TrainingController.startTargetedPractice` 现在收 `(dto, user)`，调用要传 user mock，断言 service 收到 `studentId: user.sub`。替换该块：

```ts
describe('TrainingController.startTargetedPractice 校验', () => {
  const mkController = (service: any) => new TrainingController(service);
  const user = { sub: 7, role: 'student' } as any;

  it('count 越界（0 / 21 / 非整数）-> 400', async () => {
    const svc: any = { startTargetedPractice: vi.fn() };
    const c = mkController(svc);
    for (const count of [0, 21, 1.5, NaN]) {
      await expect(
        c.startTargetedPractice({ subjectId: 1, kpId: 3, type: null, count }, user),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(svc.startTargetedPractice).not.toHaveBeenCalled();
  });

  it('type 非白名单值 -> 400', async () => {
    const svc: any = { startTargetedPractice: vi.fn() };
    const c = mkController(svc);
    await expect(
      c.startTargetedPractice({ subjectId: 1, kpId: 3, type: 'essay', count: 5 }, user),
    ).rejects.toMatchObject({ status: 400 });
    expect(svc.startTargetedPractice).not.toHaveBeenCalled();
  });

  it('合法 type（含 null）与 count 1-20 透传 service（含 studentId）', async () => {
    const svc: any = { startTargetedPractice: vi.fn().mockResolvedValue({ questions: [] }) };
    const c = mkController(svc);
    await c.startTargetedPractice({ subjectId: 1, kpId: 3, type: null, count: 1 }, user);
    await c.startTargetedPractice({ subjectId: 1, kpId: 3, type: 'proof', count: 20 }, user);
    expect(svc.startTargetedPractice).toHaveBeenCalledTimes(2);
    expect(svc.startTargetedPractice).toHaveBeenNthCalledWith(1, { studentId: 7, subjectId: 1, kpId: 3, type: null, count: 1 });
    expect(svc.startTargetedPractice).toHaveBeenNthCalledWith(2, { studentId: 7, subjectId: 1, kpId: 3, type: 'proof', count: 20 });
  });
});
```

末尾新增 4 个 service 方法的测试块：

```ts
describe('TrainingService.markHidden', () => {
  it('题目存在 -> repo.mark(studentId, subjectId, questionId)', async () => {
    const deps = mk({
      questionsRepo: { findById: vi.fn().mockResolvedValue({ id: 10, content: '题面', type: 'choice' }) },
    });
    await mkSvc(deps).markHidden(7, 1, 10);
    expect(deps.hiddenRepo.mark).toHaveBeenCalledWith(7, 1, 10);
  });
  it('题目不存在 -> 404，不调 repo.mark', async () => {
    const deps = mk({ questionsRepo: { findById: vi.fn().mockResolvedValue(null) } });
    await expect(mkSvc(deps).markHidden(7, 1, 999)).rejects.toMatchObject({ status: 404 });
    expect(deps.hiddenRepo.mark).not.toHaveBeenCalled();
  });
});

describe('TrainingService.unmarkHidden', () => {
  it('透传 (studentId, questionId) 给 repo.unmark', async () => {
    const deps = mk();
    await mkSvc(deps).unmarkHidden(7, 10);
    expect(deps.hiddenRepo.unmark).toHaveBeenCalledWith(7, 10);
  });
});

describe('TrainingService.unmarkAllHidden', () => {
  it('透传 studentId 给 repo.unmarkAll', async () => {
    const deps = mk();
    await mkSvc(deps).unmarkAllHidden(7);
    expect(deps.hiddenRepo.unmarkAll).toHaveBeenCalledWith(7);
  });
});

describe('TrainingService.listHidden', () => {
  it('透传 (studentId, subjectId) 给 repo.findAllByStudent', async () => {
    const rows = [{ questionId: 10, questionText: '题面', type: 'choice', kpName: '有理数', markedAt: new Date('2026-09-04') }];
    const deps = mk({ hiddenRepo: { findAllByStudent: vi.fn().mockResolvedValue(rows) } });
    const r = await mkSvc(deps).listHidden(7, 1);
    expect(deps.hiddenRepo.findAllByStudent).toHaveBeenCalledWith(7, 1);
    expect(r).toEqual(rows);
  });
});
```

- [ ] **Step 2: 跑测试确认失败（service 签名/构造函数未变）**

Run: `cd apps/server && npx vitest run src/modules/training/training.service.test.ts`
Expected: FAIL（`new TrainingService(...)` 参数数不匹配 / `startTargetedPractice` 缺 studentId / 新方法未定义）。

- [ ] **Step 3: 改 `training.service.ts`**

修改 `apps/server/src/modules/training/training.service.ts`：

3.1 顶部 import 加 `StudentHiddenQuestionsRepository`（在现有 `import { QuestionHintsRepository }` 之后）：

```ts
import { StudentHiddenQuestionsRepository } from '../../database/repositories/student-hidden-questions.repo.js';
```

3.2 构造函数（line 21-28）加 `hiddenRepo`：

```ts
  constructor(
    private readonly mainErrorRepo: MainErrorBooksRepository,
    private readonly judgeCore: JudgeCoreService,
    private readonly questionsRepo: QuestionsRepository,
    private readonly knowledgePointsRepo: KnowledgePointsRepository,
    private readonly questionHintsRepo: QuestionHintsRepository,
    private readonly hint: HintCapability,
    private readonly hiddenRepo: StudentHiddenQuestionsRepository,
  ) {}
```

3.3 `startTargetedPractice`（line 117-143）入参加 `studentId`，透传：

```ts
  /**
   * 专项练习开练：按学科 + 知识点（可选题型）随机抽题，排除该生已标记「不再展示」的题。
   * 题单做白名单序列化——只出 questionId/text/type/options，answer/explanation
   * 等字段一律剥离（防答案泄露）；options 是 JSON 字符串，parse 成数组返回。
   * 抽不到题（含该专项题池全部被标记）返回空数组（空集合非错误，前端判空显示提示）。
   */
  async startTargetedPractice(input: {
    studentId: number;
    subjectId: number;
    kpId: number;
    type: string | null;
    count: number;
  }): Promise<{ questions: Array<{ questionId: number; text: string; type: string; options: unknown[] | null }> }> {
    const rows = await this.questionsRepo.findRandomByKpAndType(
      input.studentId,
      input.subjectId,
      input.kpId,
      input.type,
      input.count,
    );
    return {
      questions: rows.map((q) => ({
        questionId: q.id,
        text: q.content,
        type: q.type,
        options: parseOptions(q.options),
      })),
    };
  }
```

3.4 类末尾加 4 个新方法：

```ts
  /** 标记某题「不再展示」：校验题目存在（避免标记已删题），再 INSERT IGNORE 幂等写入。 */
  async markHidden(studentId: number, subjectId: number, questionId: number): Promise<void> {
    const q = await this.questionsRepo.findById(questionId);
    if (!q) {
      throw new NotFoundException(`题目不存在：${questionId}`);
    }
    await this.hiddenRepo.mark(studentId, subjectId, questionId);
  }

  /** 撤销单条标记（归属由 repo WHERE student_id 兜底）。 */
  async unmarkHidden(studentId: number, questionId: number): Promise<void> {
    await this.hiddenRepo.unmark(studentId, questionId);
  }

  /** 全部重置：清空该生所有不再展示标记。 */
  async unmarkAllHidden(studentId: number): Promise<void> {
    await this.hiddenRepo.unmarkAll(studentId);
  }

  /** 不再展示清单（按标记时间倒序）。 */
  async listHidden(studentId: number, subjectId: number) {
    return this.hiddenRepo.findAllByStudent(studentId, subjectId);
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/training/training.service.test.ts`
Expected: PASS，全部测试绿（原 12 + 新 6 = 18 个）。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/training/training.service.ts \
        apps/server/src/modules/training/training.service.test.ts
git commit -m "feat(server): TrainingService 加不再展示 4 方法 + startTargetedPractice 透传 studentId"
```

---

## Task 5: `TrainingController` 改 `startTargetedPractice` + 4 个新端点

**Files:**
- Modify: `apps/server/src/modules/training/training.controller.ts`
- Modify: `apps/server/src/modules/training/training.module.ts`

**Interfaces:**
- Consumes: `TrainingService` 5 个方法（Task 4）
- Produces: 5 个 REST 端点（`POST /api/training/targeted/start` + 4 个 hidden 端点）

- [ ] **Step 1: 改 `training.controller.ts`**

1.1 顶部 import 加 `Delete, Param`（已有 `Body, Controller, Get, ParseIntPipe, Post, Query, UseGuards`）：

```ts
import { BadRequestException, Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
```

1.2 `startTargetedPractice` 端点（line 74-95）加 `@CurrentUser() user: JwtUser`，透传 `studentId: user.sub`：

```ts
  /** 专项练习开练：count 限 1-20 整数，type 限白名单六值（含 null），越界/非法 400。
   *  studentId 从 JWT 取（用于排除该生已标记不再展示的题）。 */
  @Post('targeted/start')
  async startTargetedPractice(
    @Body() dto: { subjectId: number; kpId: number; type: string | null; count: number },
    @CurrentUser() user: JwtUser,
  ) {
    const { count } = dto;
    if (!Number.isInteger(count) || count < 1 || count > 20) {
      throw new BadRequestException('count 仅允许 1-20 的整数');
    }
    const type = dto.type ?? null;
    if (type !== null && !(TrainingController.TARGETED_TYPES as readonly string[]).includes(type)) {
      throw new BadRequestException(
        'type 仅允许 choice | fill_blank | true_false | short_answer | proof 或 null',
      );
    }
    return this.trainingService.startTargetedPractice({
      studentId: user.sub,
      subjectId: dto.subjectId,
      kpId: dto.kpId,
      type,
      count,
    });
  }
```

1.3 类末尾加 4 个新端点：

```ts
  // ==================== 「不再展示」清单（2026-09-04） ====================

  /** 标记某题不再展示（幂等）。questionId/subjectId 非正整数 -> 400。 */
  @Post('hidden/mark')
  async markHidden(
    @Body() dto: { questionId: number; subjectId: number },
    @CurrentUser() user: JwtUser,
  ) {
    if (!Number.isInteger(dto.questionId) || dto.questionId < 1 ||
        !Number.isInteger(dto.subjectId) || dto.subjectId < 1) {
      throw new BadRequestException('questionId 与 subjectId 须为正整数');
    }
    await this.trainingService.markHidden(user.sub, dto.subjectId, dto.questionId);
    // ResponseInterceptor 包成 { code:0, data:null }（void 返回 -> data:null）
  }

  /** 不再展示清单。 */
  @Get('hidden')
  async listHidden(
    @Query('subjectId', ParseIntPipe) subjectId: number,
    @CurrentUser() user: JwtUser,
  ) {
    return this.trainingService.listHidden(user.sub, subjectId);
  }

  /** 撤销单条标记（归属由 repo WHERE student_id 兜底防 IDOR）。 */
  @Delete('hidden/:questionId')
  async unmarkHidden(
    @Param('questionId', ParseIntPipe) questionId: number,
    @CurrentUser() user: JwtUser,
  ) {
    await this.trainingService.unmarkHidden(user.sub, questionId);
  }

  /** 全部重置：清空该生所有不再展示标记。 */
  @Delete('hidden')
  async unmarkAllHidden(@CurrentUser() user: JwtUser) {
    await this.trainingService.unmarkAllHidden(user.sub);
  }
```

- [ ] **Step 2: 在 `training.module.ts` 注册新 repo**

修改 `apps/server/src/modules/training/training.module.ts`，`providers` 加 `StudentHiddenQuestionsRepository`：

```ts
import { Module } from '@nestjs/common';
import { TrainingController } from './training.controller.js';
import { TrainingService } from './training.service.js';
import { PracticeModule } from '../practice/practice.module.js';
import { MainErrorBooksRepository, QuestionsRepository, QuestionHintsRepository, KnowledgePointsRepository, StudentHiddenQuestionsRepository } from '../../database/repositories/index.js';
import { HintCapability } from '../../ai-core/capabilities/hint.capability.js';

@Module({
  imports: [PracticeModule],
  controllers: [TrainingController],
  providers: [TrainingService, MainErrorBooksRepository, QuestionsRepository, QuestionHintsRepository, KnowledgePointsRepository, StudentHiddenQuestionsRepository, HintCapability],
})
export class TrainingModule {}
```

- [ ] **Step 3: 跑全量后端测试 + tsc 类型检查**

Run:
```bash
cd apps/server && npx tsc --noEmit && npm test
```
Expected: tsc 通过；vitest 全绿（原 72 + Task 2 新 4 + Task 3 改 3 + Task 4 新 6 = 85 个左右）。

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/modules/training/training.controller.ts \
        apps/server/src/modules/training/training.module.ts
git commit -m "feat(server): TrainingController 加不再展示 4 端点 + startTargetedPractice 取 JWT user.sub"
```

---

## Task 6: 前端 `api.ts` 加 4 个新函数

**Files:**
- Modify: `apps/web/src/services/api.ts`（在 `startTargetedPractice` 之后、`// --- Exams` 之前插入）

**Interfaces:**
- Produces: `HiddenQuestion` 类型、`markTrainingHidden` / `listTrainingHidden` / `unmarkTrainingHidden` / `unmarkAllTrainingHidden` 4 个函数

- [ ] **Step 1: 在 api.ts 加类型与函数**

在 `apps/web/src/services/api.ts` 的 `startTargetedPractice` 函数之后（line 863 之后、`// --- Exams` 注释之前）插入：

```ts
// --- 专项训练「不再展示」清单（2026-09-04） ---

/** 不再展示清单条目：题面预览（80 字截断）+ 首个 primary kp 名 + 标记时间。 */
export interface HiddenQuestion {
  questionId: number;
  questionText: string;
  type: string;
  kpName: string | null;
  markedAt: string;
}

/** 标记某题不再展示（幂等：重复标记不报错）。 */
export function markTrainingHidden(payload: {
  questionId: number;
  subjectId: number;
}): Promise<void> {
  return fetchApi<void>('/training/hidden/mark', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** 拉取不再展示清单（按标记时间倒序）。 */
export function listTrainingHidden(subjectId: number): Promise<HiddenQuestion[]> {
  const qs = new URLSearchParams({ subjectId: String(subjectId) });
  return fetchApi<HiddenQuestion[]>(`/training/hidden?${qs.toString()}`);
}

/** 撤销单条标记。 */
export function unmarkTrainingHidden(questionId: number): Promise<void> {
  return fetchApi<void>(`/training/hidden/${questionId}`, { method: 'DELETE' });
}

/** 全部重置：清空该生所有不再展示标记。 */
export function unmarkAllTrainingHidden(): Promise<void> {
  return fetchApi<void>('/training/hidden', { method: 'DELETE' });
}
```

- [ ] **Step 2: 类型检查 + lint**

Run:
```bash
cd apps/web && npx tsc --noEmit && npm run lint
```
Expected: 通过（无类型错误、无 lint 报错）。

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/services/api.ts
git commit -m "feat(web): api.ts 加不再展示 4 个函数 + HiddenQuestion 类型"
```

---

## Task 7: `QuestionRunner` 新增 `questionMetaActions` 插槽

**Files:**
- Modify: `apps/web/src/components/business/answer/QuestionRunner.tsx`

**Interfaces:**
- Produces: 可选 prop `questionMetaActions?: (q: RunnerQuestion) => ReactNode`，始终渲染（不 gate）；现有 `headerActions` 行为不变

- [ ] **Step 1: 加 prop 类型**

在 `apps/web/src/components/business/answer/QuestionRunner.tsx` 的 `QuestionRunnerProps` interface（line 90 附近的 `headerActions?: (q: RunnerQuestion) => ReactNode;`）之后加一行：

```ts
  /** 元动作插槽（如「不再展示」）：始终渲染，不 gate（区别于 headerActions 的「先看提示」门禁）。 */
  questionMetaActions?: (q: RunnerQuestion) => ReactNode;
```

- [ ] **Step 2: 解构 + 渲染**

在 props 解构（line 114 附近的 `headerActions,`）之后加 `questionMetaActions,`。

在渲染区（line 273-292）改成：

```tsx
            {(requestHint || headerActions || questionMetaActions) && (
              <div className="flex flex-col gap-2 shrink-0">
                {/* 元动作（始终可见，不 gate）：如「不再展示」按钮 */}
                {questionMetaActions && questionMetaActions(q)}
                {requestHint && (
                  <button
                    onClick={handleHintClick}
                    className="w-[38px] h-[38px] rounded-xl border border-[var(--bg-subtle)] bg-[var(--learn-card-bg)] flex items-center justify-center text-[var(--warning)] shadow-sm hover:bg-[var(--brand-100)] transition-colors"
                    title="提示"
                    aria-label="提示"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                      <line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                  </button>
                )}
                {/* 渐进式：提示开启时，「讲一讲」等 headerActions 仅在看过提示后出现（hints 有缓存即视为看过）；提示未开启时不 gate（向后兼容） */}
                {headerActions && (!requestHint || hints?.[q.n]) && headerActions(q)}
              </div>
            )}
```

- [ ] **Step 3: 类型检查 + lint + build**

Run:
```bash
cd apps/web && npx tsc --noEmit && npm run lint && npm run build
```
Expected: 通过（现有调用方不传 `questionMetaActions`，行为不变）。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/business/answer/QuestionRunner.tsx
git commit -m "feat(web): QuestionRunner 加 questionMetaActions ungated 插槽"
```

---

## Task 8: `TargetedRunPage` 加"不再展示"按钮 + 确认 Modal

**Files:**
- Modify: `apps/web/src/pages/student/training/TargetedRunPage.tsx`

**Interfaces:**
- Consumes: `QuestionRunner.questionMetaActions`（Task 7）、`markTrainingHidden`（Task 6）、`Modal`（`@/components/base`）、`toast`（`@/components/base/Toast`）

- [ ] **Step 1: 加 import**

在 `apps/web/src/pages/student/training/TargetedRunPage.tsx` 的 import 区加：

```ts
import { markTrainingHidden } from '@/services/api';
import { toast } from '@/components/base/Toast';
```

`Modal` 已 import（line 8）。

- [ ] **Step 2: 加 state**

在 `const [exitConfirm, ...]` 之后（line 36 附近）加：

```ts
  // 「不再展示」确认 Modal：open 时锚定当前题 questionId
  const [markConfirm, setMarkConfirm] = useState<{ open: boolean; questionId: number | null }>(
    { open: false, questionId: null },
  );
  const [marking, setMarking] = useState(false);
```

- [ ] **Step 3: 加确认处理函数**

在 `handleFinish`（line 133）之后加：

```ts
  const confirmMarkHidden = useCallback(async () => {
    if (markConfirm.questionId == null) return;
    setMarking(true);
    try {
      await markTrainingHidden({ questionId: markConfirm.questionId, subjectId: MATH_SUBJECT_ID });
      toast('success', '已加入不再展示清单');
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '标记失败，请重试');
    } finally {
      setMarking(false);
      setMarkConfirm({ open: false, questionId: null });
    }
  }, [markConfirm.questionId]);
```

- [ ] **Step 4: 给 `QuestionRunner` 传 `questionMetaActions`**

把 `<QuestionRunner>` 调用（line 154-168）改成：

```tsx
            <QuestionRunner
              questions={questions}
              subjectId={MATH_SUBJECT_ID}
              draftKeyPrefix="tp"
              variant="embedded"
              enableHint
              hints={hints}
              onRequestHint={handleRequestHint}
              headerActions={(q) => (
                <DiscussIconButton onClick={() => setDiscussQ(q)} />
              )}
              questionMetaActions={(q) => {
                const qid = Number(q.n);
                return (
                  <button
                    type="button"
                    disabled={marking}
                    onClick={() => setMarkConfirm({ open: true, questionId: qid })}
                    title="不再展示"
                    aria-label="不再展示这道题"
                    className="w-[38px] h-[38px] rounded-xl border border-[var(--bg-subtle)] bg-[var(--learn-card-bg)] flex items-center justify-center text-[var(--text-secondary)] shadow-sm hover:bg-[var(--bg-base)] transition-colors"
                  >
                    {/* 眼斜杠图标（线性 SVG）——视觉权重低于提示/讲一讲 */}
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                      <line x1="2" y1="2" x2="22" y2="22" />
                    </svg>
                  </button>
                );
              }}
              onSubmit={handleSubmit}
              onFinish={handleFinish}
              onClose={(answered) => setExitConfirm({ open: true, answered })}
            />
```

- [ ] **Step 5: 加确认 Modal**

在 `{exitConfirm.open && (...)}`（line 180）之后加：

```tsx
        {/* 「不再展示」确认 */}
        {markConfirm.open && (
          <Modal
            open
            onClose={() => setMarkConfirm({ open: false, questionId: null })}
            title="不再展示"
          >
            <p className="text-sm text-[var(--text-secondary)]">
              标记后，下次专项练习将不再抽到这道题。当前题仍可继续作答。可在「专项练习」配置页的「我的不再展示清单」中撤销。
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setMarkConfirm({ open: false, questionId: null })}
                className="h-10 px-4 rounded-[var(--radius-button)] border border-[var(--bg-subtle)] text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-base)]"
              >
                取消
              </button>
              <button
                onClick={() => void confirmMarkHidden()}
                disabled={marking}
                className="h-10 px-4 rounded-[var(--radius-button)] bg-[var(--brand-500)] text-sm font-semibold text-white transition-colors hover:bg-[var(--brand-600)] disabled:opacity-50"
              >
                {marking ? '提交中…' : '确认不再展示'}
              </button>
            </div>
          </Modal>
        )}
```

- [ ] **Step 6: 类型检查 + lint + build**

Run:
```bash
cd apps/web && npx tsc --noEmit && npm run lint && npm run build
```
Expected: 通过。

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/pages/student/training/TargetedRunPage.tsx
git commit -m "feat(web): TargetedRunPage 答题页加「不再展示」按钮 + 确认 Modal"
```

---

## Task 9: 新建 `HiddenQuestionsPage` 清单页

**Files:**
- Create: `apps/web/src/pages/student/training/HiddenQuestionsPage.tsx`

**Interfaces:**
- Consumes: `listTrainingHidden` / `unmarkTrainingHidden` / `unmarkAllTrainingHidden`（Task 6）、`Button` / `Card` / `PageHeader` / `Skeleton` / `Modal` / `toast`、`useThemeStore`

- [ ] **Step 1: 创建清单页**

创建 `apps/web/src/pages/student/training/HiddenQuestionsPage.tsx`：

```tsx
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, PageHeader, Skeleton } from '@/components/base';
import { Modal } from '@/components/base';
import { toast } from '@/components/base/Toast';
import {
  listTrainingHidden,
  unmarkTrainingHidden,
  unmarkAllTrainingHidden,
  type HiddenQuestion,
} from '@/services/api';
import { useThemeStore } from '@/store/themeStore';

const MATH_SUBJECT_ID = 1;

const TYPE_LABEL: Record<string, string> = {
  choice: '选择',
  fill_blank: '填空',
  true_false: '判断',
  short_answer: '解答',
  proof: '证明',
};

export default function HiddenQuestionsPage() {
  const navigate = useNavigate();
  const { mode, autoToggleNightMode } = useThemeStore();

  const [items, setItems] = useState<HiddenQuestion[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [unmarkingId, setUnmarkingId] = useState<number | null>(null);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    autoToggleNightMode();
    const t = setInterval(autoToggleNightMode, 60000);
    return () => clearInterval(t);
  }, [autoToggleNightMode]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const data = await listTrainingHidden(MATH_SUBJECT_ID);
      setItems(data);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : '加载失败');
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleUnmark = async (questionId: number) => {
    setUnmarkingId(questionId);
    try {
      await unmarkTrainingHidden(questionId);
      setItems((prev) => (prev ?? []).filter((it) => it.questionId !== questionId));
      toast('success', '已撤销');
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '撤销失败');
    } finally {
      setUnmarkingId(null);
    }
  };

  const handleResetAll = async () => {
    setResetting(true);
    try {
      await unmarkAllTrainingHidden();
      setItems([]);
      toast('success', '已清空不再展示清单');
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '重置失败');
    } finally {
      setResetting(false);
      setResetConfirm(false);
    }
  };

  return (
    <div className="student-theme-container" data-theme={mode} data-school="junior">
      <div className="min-h-screen bg-[var(--bg-page)] text-[var(--text-primary)]">
        <div className="mx-auto w-full max-w-[64rem] px-4 sm:px-8 pt-6 sm:pt-8 pb-16">
          <PageHeader
            to="/student/training/targeted"
            caption="返回专项练习"
            title="我的不再展示清单"
          />

          <Card className="mt-6 bg-[var(--learn-card-bg)] border border-[var(--learn-card-border)]">
            <div className="flex items-center justify-between p-4 border-b border-[var(--bg-subtle)]">
              <p className="text-sm text-[var(--learn-text-secondary)]">
                {items == null ? '加载中…' : `共 ${items.length} 题`}
              </p>
              <Button
                variant="danger"
                size="sm"
                disabled={items == null || items.length === 0 || resetting}
                onClick={() => setResetConfirm(true)}
              >
                全部重置
              </Button>
            </div>

            <div className="p-4">
              {items == null && !loadError ? (
                <div className="space-y-3">
                  <Skeleton width="60%" height={14} />
                  <Skeleton height={40} />
                  <Skeleton height={40} />
                </div>
              ) : loadError ? (
                <div className="flex items-center gap-4">
                  <p className="text-sm text-[var(--learn-text-secondary)]">{loadError}</p>
                  <Button variant="secondary" size="sm" onClick={() => void load()}>
                    重试
                  </Button>
                </div>
              ) : items.length === 0 ? (
                <p className="text-sm text-[var(--learn-text-secondary)]">
                  暂无标记的题目。做题时遇到熟悉的题，可点题面右侧的「不再展示」按钮加入清单。
                </p>
              ) : (
                <ul className="space-y-2">
                  {items.map((it) => (
                    <li
                      key={it.questionId}
                      className="flex items-start gap-3 rounded-[var(--radius-card)] border border-[var(--learn-card-border)] bg-[var(--learn-card-bg)] p-3"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--brand-100)] text-[var(--brand-500)]">
                            {TYPE_LABEL[it.type] ?? it.type}
                          </span>
                          {it.kpName && (
                            <span className="text-xs text-[var(--learn-text-tertiary)] truncate">
                              {it.kpName}
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-[var(--learn-text-primary)] line-clamp-2">
                          {it.questionText}
                        </p>
                        <p className="text-xs text-[var(--learn-text-tertiary)] mt-1">
                          标记于 {new Date(it.markedAt).toLocaleString('zh-CN')}
                        </p>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={unmarkingId === it.questionId}
                        onClick={() => void handleUnmark(it.questionId)}
                      >
                        撤销
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        </div>
      </div>

      {resetConfirm && (
        <Modal
          open
          onClose={() => setResetConfirm(false)}
          title="全部重置"
        >
          <p className="text-sm text-[var(--text-secondary)]">
            将清空所有不再展示标记，被排除的题目会重新进入专项练习抽题池。此操作不可撤销，确定继续吗？
          </p>
          <div className="mt-6 flex justify-end gap-3">
            <button
              onClick={() => setResetConfirm(false)}
              className="h-10 px-4 rounded-[var(--radius-button)] border border-[var(--bg-subtle)] text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-base)]"
            >
              取消
            </button>
            <button
              onClick={() => void handleResetAll()}
              disabled={resetting}
              className="h-10 px-4 rounded-[var(--radius-button)] bg-[var(--error)] text-sm font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-50"
            >
              {resetting ? '重置中…' : '确认清空'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 类型检查 + lint**

Run:
```bash
cd apps/web && npx tsc --noEmit && npm run lint
```
Expected: 通过。

- [ ] **Step 3: Commit（暂不验证路由——下一 Task 接）**

```bash
git add apps/web/src/pages/student/training/HiddenQuestionsPage.tsx
git commit -m "feat(web): 新建 HiddenQuestionsPage 不再展示清单页"
```

---

## Task 10: 加路由 + `TargetedConfigPage` 加清单入口

**Files:**
- Modify: `apps/web/src/routes/index.tsx`
- Modify: `apps/web/src/pages/student/training/TargetedConfigPage.tsx`

- [ ] **Step 1: 加路由**

在 `apps/web/src/routes/index.tsx` 顶部 import 区（line 14-15 附近）加：

```ts
import HiddenQuestionsPage from '@/pages/student/training/HiddenQuestionsPage';
```

在 `/student/training/targeted/run` 路由块（line 184-191）之后加：

```tsx
  // 专项练习「不再展示」清单页（全屏沉浸层，与 targeted 同层）
  {
    path: '/student/training/targeted/hidden',
    element: (
      <RequireRole role="student">
        <HiddenQuestionsPage />
      </RequireRole>
    ),
  },
```

- [ ] **Step 2: 在 `TargetedConfigPage` 加清单入口**

在 `apps/web/src/pages/student/training/TargetedConfigPage.tsx` 的 `<PageHeader />`（line 188）之后、`<Card>`（line 191）之前加工具条：

```tsx
          {/* 工具条：不再展示清单入口 */}
          <div className="flex justify-end mb-3">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => navigate('/student/training/targeted/hidden')}
            >
              我的不再展示清单
            </Button>
          </div>
```

- [ ] **Step 3: 类型检查 + lint + build**

Run:
```bash
cd apps/web && npx tsc --noEmit && npm run lint && npm run build
```
Expected: 通过。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/index.tsx \
        apps/web/src/pages/student/training/TargetedConfigPage.tsx
git commit -m "feat(web): 不再展示清单页路由 + 配置页入口按钮"
```

---

## Task 11: `TargetedConfigPage` emptyHint 文案 + 题池耗尽提示

**Files:**
- Modify: `apps/web/src/pages/student/training/TargetedConfigPage.tsx`

**Spec §5 题池耗尽**：后端返回空 + 前端提示"已练完，可在清单页重置"。

- [ ] **Step 1: 调整 emptyHint 文案**

修改 `apps/web/src/pages/student/training/TargetedConfigPage.tsx` 的 emptyHint 提示（line 302-304）：

```tsx
              {emptyHint && (
                <p className="text-sm text-[var(--learn-text-secondary)]">
                  该专项题目已练完或全部标记不再展示。可更换专项/题型，或在「我的不再展示清单」中重置。
                </p>
              )}
```

- [ ] **Step 2: 类型检查 + build**

Run:
```bash
cd apps/web && npx tsc --noEmit && npm run build
```
Expected: 通过。

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/student/training/TargetedConfigPage.tsx
git commit -m "feat(web): emptyHint 文案提示可在清单页重置"
```

---

## Task 12: 文档同步（openapi + API 设计文档 + changelog）

**Files:**
- Modify: `docs/api/openapi.yaml`
- Modify: `docs/API接口与数据流设计文档.md`
- Modify: `docs/ai-core-changelog.md`

按 CLAUDE.md「API 文档同步规则」两份文档保持一致。

- [ ] **Step 1: openapi.yaml 加 4 个端点**

在 `docs/api/openapi.yaml` 的 `/api/training/targeted/start` 端点定义之后加：

```yaml
  /api/training/hidden/mark:
    post:
      tags: [training]
      summary: 标记某题不再展示（幂等）
      security: [{ bearerAuth: [] }]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [questionId, subjectId]
              properties:
                questionId: { type: integer, format: int64, minimum: 1 }
                subjectId: { type: integer, format: int64, minimum: 1 }
      responses:
        '200':
          description: 标记成功（幂等：重复标记不报错）
          content:
            application/json:
              schema: { $ref: '#/components/schemas/CommonResponse' }
        '400': { $ref: '#/components/responses/BadRequest' }
        '404': { description: 题目不存在 }

  /api/training/hidden:
    get:
      tags: [training]
      summary: 不再展示清单（按标记时间倒序）
      security: [{ bearerAuth: [] }]
      parameters:
        - name: subjectId
          in: query
          required: true
          schema: { type: integer, minimum: 1 }
      responses:
        '200':
          description: 清单
          content:
            application/json:
              schema:
                type: array
                items: { $ref: '#/components/schemas/HiddenQuestion' }
    delete:
      tags: [training]
      summary: 全部重置（清空该生所有不再展示标记）
      security: [{ bearerAuth: [] }]
      responses:
        '200':
          description: 重置成功
          content:
            application/json:
              schema: { $ref: '#/components/schemas/CommonResponse' }

  /api/training/hidden/{questionId}:
    delete:
      tags: [training]
      summary: 撤销单条标记
      security: [{ bearerAuth: [] }]
      parameters:
        - name: questionId
          in: path
          required: true
          schema: { type: integer, format: int64, minimum: 1 }
      responses:
        '200':
          description: 撤销成功（幂等）
          content:
            application/json:
              schema: { $ref: '#/components/schemas/CommonResponse' }
```

并在 `components/schemas` 区加 `HiddenQuestion`：

```yaml
    HiddenQuestion:
      type: object
      properties:
        questionId: { type: integer, format: int64 }
        questionText: { type: string, description: 题面预览（80 字截断） }
        type: { type: string }
        kpName: { type: string, nullable: true, description: 首个 primary kp 名 }
        markedAt: { type: string, format: date-time }
```

- [ ] **Step 2: API 设计文档加端点与数据流**

在 `docs/API接口与数据流设计文档.md` §4 端点清单的训练模块下加 4 行：

```
- POST   /api/training/hidden/mark         标记某题不再展示（幂等）｜student
- GET    /api/training/hidden?subjectId=    不再展示清单｜student
- DELETE /api/training/hidden/:questionId   撤销单条标记｜student
- DELETE /api/training/hidden                全部重置｜student
```

在 §6 数据流补一节「专项训练选题排除已标记题」：

```
学生开专项练习 -> POST /api/training/targeted/start（JWT studentId 透传）
  -> QuestionsRepository.findRandomByKpAndType(studentId, ...)
  -> LEFT JOIN student_hidden_questions shq ON shq.student_id=? WHERE shq.id IS NULL
  -> 排除该生已标记不再展示的题，ORDER BY RAND() LIMIT count
题池排除后为空 -> 返回 { questions: [] }，前端 emptyHint 提示「可在清单页重置」
```

- [ ] **Step 3: changelog 加条目**

在 `docs/ai-core-changelog.md` 顶部加：

```markdown
## 2026-09-04 专项训练「不再展示」功能

- 新增 `student_hidden_questions` 表（`student_id + question_id` 全局排除，不分知识点）
- `QuestionsRepository.findRandomByKpAndType` 加 `LEFT JOIN ... IS NULL` 排除已标记题（**仅此一处**选题路径受影响；主线练习/错题重做/考试不动）
- `TrainingController` 加 4 端点：`POST /training/hidden/mark`、`GET /training/hidden`、`DELETE /training/hidden/:questionId`、`DELETE /training/hidden`
- 前端 `QuestionRunner` 加 ungated `questionMetaActions` 插槽；`TargetedRunPage` 答题页加「不再展示」按钮 + 确认 Modal
- 新建 `HiddenQuestionsPage` 清单页（逐条撤销 + 全部重置），学生端自助管理
- 设计 spec：`docs/superpowers/specs/2026-09-04-targeted-practice-exclude-marked-design.md`
- 实施计划：`docs/superpowers/plans/2026-09-04-targeted-practice-exclude-marked.md`
```

- [ ] **Step 4: 端点对照检查**

Run:
```bash
grep -oE '/api/training/hidden[^ ]*' docs/api/openapi.yaml | sort -u
grep -oE '/api/training/hidden[^ ]*' docs/API接口与数据流设计文档.md | sort -u
```
Expected: 两份文档都出现 4 个端点路径，无遗漏。

- [ ] **Step 5: Commit**

```bash
git add docs/api/openapi.yaml \
        docs/API接口与数据流设计文档.md \
        docs/ai-core-changelog.md
git commit -m "docs(server): 不再展示 4 端点同步 openapi + API 设计文档 + changelog"
```

---

## Task 13: 全量验证

- [ ] **Step 1: 后端全量测试 + 类型检查**

Run:
```bash
cd apps/server && npx tsc --noEmit && npm test
```
Expected: tsc 通过；vitest 全绿。

- [ ] **Step 2: 前端 lint + build**

Run:
```bash
cd apps/web && npm run lint && npm run build
```
Expected: 通过。

- [ ] **Step 3: 启动后端 + 前端，手测端到端流程**

启动：
```bash
# 终端 A
cd apps/server && npm run start:dev
# 终端 B
cd apps/web && npm run dev
```

手测路径：
1. 学生登录 -> 进专项练习配置页 -> 选知识点 + 题型 + 题量 5 -> 开练
2. 在某题上点「眼斜杠」按钮 -> 确认 Modal -> 「确认不再展示」-> 看到 toast「已加入不再展示清单」
3. 完成本轮（或退出）-> 回配置页 -> 再开练同一知识点 -> 验证刚才标记的题**不再出现**
4. 配置页点「我的不再展示清单」-> 看到刚标记的题 -> 点「撤销」-> toast「已撤销」
5. 再开练 -> 验证该题重新可抽
6. 标记该知识点下所有题 -> 开练 -> 验证返回空 + 配置页 emptyHint 文案「可在清单页重置」
7. 清单页「全部重置」-> 确认 -> 验证列表清空 + 再开练题目恢复

Expected: 全部通过。

- [ ] **Step 4: 检查其他选题路径未受影响**

在主线练习（课堂练习）/ 错题重做 / 考试模块各开一次练习，验证：
- 已标记「不再展示」的题在这些路径下**仍然会出现**（排除仅专项训练生效）

Expected: 主线/错题/考试路径行为不变。

- [ ] **Step 5: 最终 commit（如有手测中发现的小修）**

```bash
git status --short
# 若有未提交修复：
git add -A && git commit -m "fix(server): 不再展示手测修正"
```

---

## Self-Review Notes

- **Spec coverage**：spec §1-9 全部有对应 task。表（Task 1）、repo（Task 2）、SQL 改（Task 3）、service（Task 4）、controller（Task 5）、前端 api（Task 6）、QuestionRunner 插槽（Task 7）、答题页按钮（Task 8）、清单页（Task 9）、路由+配置页入口（Task 10）、emptyHint 文案（Task 11）、文档（Task 12）、验证（Task 13）。
- **Type consistency**：`findRandomByKpAndType(studentId, subjectId, kpId, type, count)` 在 Task 3/4/5 测试与实现签名一致；`mark/unmark/unmarkAll/findAllByStudent` 在 repo（Task 2）与 service（Task 4）名字一致；前端 `markTrainingHidden/listTrainingHidden/unmarkTrainingHidden/unmarkAllTrainingHidden` 在 api.ts（Task 6）与 HiddenQuestionsPage（Task 9）/ TargetedRunPage（Task 8）调用一致。
- **Response envelope**：void 端点 return undefined -> `ResponseInterceptor` 包 `{ code:0, data:null }` -> 前端 `fetchApi<void>` 收到 null（已核对 `response.interceptor.ts:22-28` 与 `api.ts:32-38`，spec §3.4 已修正禁用 204）。
- **YAGNI**：结果页补标记、家长端入口、按知识点细分排除均不做（spec §9）。
