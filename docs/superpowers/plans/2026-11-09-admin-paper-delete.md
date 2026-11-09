# 管理员端「试卷管理」删除套卷 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在管理后台新增「试卷管理」页，管理员可预览影响面后一键删除套卷（独占题、考试会话、逐题作答），共享题只解绑、被学生数据引用的题保留。

**Architecture:** 后端新增 `AdminPapersRepository`（分页查询 + 影响面统计 + 单事务级联删除）、`AdminPapersService`、`AdminPapersController`（`api/admin/papers`），注册进 `AdminModule`；前端新增 `/admin/papers` 页面、侧栏入口与 API 客户端方法。删除规则见 spec `docs/superpowers/specs/2026-11-09-admin-paper-delete-design.md`。

**Tech Stack:** NestJS + mysql2（raw SQL，事务用 `pool.getConnection`）、zod 3.25、React 18 + Vite + Tailwind + Zustand、vitest + @testing-library/react。

## Global Constraints

- **删除语义**：只删该卷独占题；共享题只解除 `paper_questions` 关联；独占题被任一 RESTRICT 表引用则保留并计数；该卷 `exam_sessions` + `exam_answers` 一并删除。
- **RESTRICT 阻断表（固定 7 张）**：`main_error_books`、`aux_error_books`、`answers`、`exam_answers`、`variation_questions`、`special_answer_records`、`remediation_set_items`。
- **裸 `ZodError` 会被全局过滤器兜成 500/5000**：所有新入参校验必须 `safeParse` → `BadRequestException({ code: 1001 })`。
- **`LIMIT ?` 必须走 `pool.query`**（`pool.execute` 会执行失败，仓内有 `limit-placeholder.guard.test.ts` 护栏）。
- **不使用 emoji**；管理端样式沿用现有页（`--text-primary` / `--text-secondary` / `bg-white` / `rounded-2xl` / `border-gray-200`）。
- **API 文档双份同步**：`docs/API接口与数据流设计文档.md` 与 `docs/api/openapi.yaml` 必须同时更新。
- 后端测试命令在 `apps/server`，前端在 `apps/web`；提交信息用中文 conventional commit。

## 文件结构

| 文件 | 动作 | 责任 |
|---|---|---|
| `apps/server/src/database/repositories/admin-papers.repo.ts` | 新建 | 列表/预览/事务删除的 SQL 与计数 |
| `apps/server/src/database/repositories/admin-papers.repo.test.ts` | 新建 | SQL 形态、参数、事务回滚断言 |
| `apps/server/src/modules/admin/admin-papers.service.ts` | 新建 | DTO 映射、404/409 转换、id 校验 |
| `apps/server/src/modules/admin/admin-papers.service.test.ts` | 新建 | 业务分支单测 |
| `apps/server/src/modules/admin/admin-papers.controller.ts` | 新建 | 路由 + zod 入参 + admin 角色 |
| `apps/server/src/modules/admin/admin-papers.controller.test.ts` | 新建 | 路由元数据 + 400 分支 |
| `apps/server/src/modules/admin/admin.module.ts` | 修改 | 注册 controller/service/repo |
| `apps/web/src/services/api.ts` | 修改 | 3 个客户端方法 + 4 个类型 |
| `apps/web/src/pages/admin/AdminPapersPage.tsx` | 新建 | 列表 + 筛选 + 删除确认 |
| `apps/web/src/pages/admin/AdminPapersPage.test.tsx` | 新建 | 页面状态机测试 |
| `apps/web/src/routes/routeTable.tsx` | 修改 | 挂载 `/admin/papers` |
| `apps/web/src/components/layout/AdminNav.tsx` | 修改 | 侧栏入口 |
| `apps/web/src/components/layout/AdminNav.test.tsx` | 修改 | 断言入口存在 |
| `docs/API接口与数据流设计文档.md` | 修改 | §4.17 Admin 表新增 3 行 |
| `docs/api/openapi.yaml` | 修改 | 3 个路径 + schema |
| `docs/ai-core-changelog.md` | 修改 | 2026-11-09 条目 |

---

### Task 1: 仓储 — 列表与影响面统计

**Files:**
- Create: `apps/server/src/database/repositories/admin-papers.repo.ts`
- Test: `apps/server/src/database/repositories/admin-papers.repo.test.ts`

**Interfaces:**
- Produces:
  - `AdminPaperFilters`：`{ subjectId?: number; year?: number; gradeBand?: string; keyword?: string; page: number; pageSize: number }`
  - `AdminPaperListRow`（含 `linked_question_count`、`session_count`、`created_at: Date`）
  - `PaperImpact`：`{ questionCount, sharedCount, exclusiveCount, deletableCount, retainedCount, sessionCount, answerCount }`
  - `AdminPapersRepository.findPapers(filters): Promise<{ items: AdminPaperListRow[]; total: number }>`
  - `AdminPapersRepository.findPaper(id): Promise<{ id: number; title: string; subjectName: string } | null>`
  - `AdminPapersRepository.countImpact(paperId): Promise<PaperImpact>`

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/src/database/repositories/admin-papers.repo.test.ts
import { describe, expect, it, vi } from 'vitest';
import { AdminPapersRepository } from './admin-papers.repo.js';

/** mysql2 双返回形状：[rows, fields]；SELECT 可能走 execute 或 query。 */
function mockPool(rows: any[] = [], total = 0) {
  return {
    execute: vi.fn().mockImplementation((sql: string) => {
      if (/COUNT\(\*\) AS total/i.test(sql)) return Promise.resolve([[{ total }], []]);
      return Promise.resolve([rows, []]);
    }),
    query: vi.fn().mockResolvedValue([rows, []]),
  };
}

describe('AdminPapersRepository.findPapers', () => {
  it('分页查询走 pool.query（LIMIT ? 不能走 execute），总数走 execute', async () => {
    const pool = mockPool([{ id: 1 }], 3);
    const repo = new AdminPapersRepository(pool as any);

    const out = await repo.findPapers({ page: 2, pageSize: 20 });

    expect(out.total).toBe(3);
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('LIMIT ? OFFSET ?');
    expect(sql).toContain('linked_question_count');
    expect(params).toEqual([20, 20]);
    expect(pool.execute.mock.calls[0][0]).toContain('COUNT(*) AS total');
  });

  it('subjectId / year / gradeBand / keyword 全部落到 WHERE 且参数顺序一致', async () => {
    const pool = mockPool([], 0);
    const repo = new AdminPapersRepository(pool as any);

    await repo.findPapers({ subjectId: 9, year: 2026, gradeBand: 'junior', keyword: '汇文', page: 1, pageSize: 10 });

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('p.subject_id = ?');
    expect(sql).toContain('p.year = ?');
    expect(sql).toContain('p.grade_band = ?');
    expect(sql).toContain('p.title LIKE ?');
    // 4 个筛选 + LIMIT/OFFSET
    expect(params).toEqual([9, 2026, 'junior', '%汇文%', 10, 0]);
  });

  it('keyword 里的 % _ \\ 被转义，防通配符注入', async () => {
    const pool = mockPool([], 0);
    const repo = new AdminPapersRepository(pool as any);

    await repo.findPapers({ keyword: '50%_x\\y', page: 1, pageSize: 20 });

    expect(pool.query.mock.calls[0][1][0]).toBe('%50\\%\\_x\\\\y%');
  });
});

describe('AdminPapersRepository.countImpact', () => {
  it('独占 = 卷内题 - 共享；被引用题从可删里扣除', async () => {
    const pool = {
      execute: vi.fn().mockImplementation((sql: string, params: any[]) => {
        if (/FROM paper_questions WHERE paper_id = \?$/i.test(sql)) return Promise.resolve([[{ cnt: 14 }], []]);
        if (/EXISTS \(SELECT 1 FROM paper_questions x/.test(sql)) return Promise.resolve([[{ cnt: 2 }], []]);
        if (/FROM exam_sessions WHERE paper_id = \?/i.test(sql)) return Promise.resolve([[{ cnt: 1 }], []]);
        if (/FROM exam_answers ea[\s\S]*JOIN exam_sessions es/.test(sql)) return Promise.resolve([[{ cnt: 5 }], []]);
        if (/SELECT pq.question_id AS qid/.test(sql)) {
          return Promise.resolve([params.length ? Array.from({ length: 12 }, (_, i) => ({ qid: 100 + i })) : [], []]);
        }
        if (/SELECT DISTINCT qid FROM/.test(sql)) {
          // 12 道独占题里 3 道被错题本引用
          return Promise.resolve([[{ qid: 100 }, { qid: 101 }, { qid: 102 }], []]);
        }
        return Promise.resolve([[], []]);
      }),
    };
    const repo = new AdminPapersRepository(pool as any);

    const out = await repo.countImpact(446);

    expect(out.questionCount).toBe(14);
    expect(out.sharedCount).toBe(2);
    expect(out.exclusiveCount).toBe(12);
    expect(out.retainedCount).toBe(3);
    expect(out.deletableCount).toBe(9);
    expect(out.sessionCount).toBe(1);
    expect(out.answerCount).toBe(5);
  });

  it('被引用检测的 UNION 覆盖 7 张 RESTRICT 表', async () => {
    const pool = {
      execute: vi.fn().mockImplementation((sql: string) => {
        if (/SELECT pq.question_id AS qid/.test(sql)) {
          return Promise.resolve([[{ qid: 1 }, { qid: 2 }], []]);
        }
        if (/SELECT DISTINCT qid FROM/.test(sql)) return Promise.resolve([[], []]);
        return Promise.resolve([[{ cnt: 0 }], []]);
      }),
    };
    const repo = new AdminPapersRepository(pool as any);
    await repo.countImpact(1);

    const unionSql = pool.execute.mock.calls
      .map((c) => String(c[0]))
      .find((sql) => sql.includes('SELECT DISTINCT qid FROM'))!;
    for (const table of [
      'main_error_books', 'aux_error_books', 'answers', 'exam_answers',
      'variation_questions', 'special_answer_records', 'remediation_set_items',
    ]) {
      expect(unionSql).toContain(table);
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/database/repositories/admin-papers.repo.test.ts`
Expected: FAIL — `Cannot find module './admin-papers.repo.js'`

- [ ] **Step 3: 实现仓储（列表 + 计数部分）**

```ts
// apps/server/src/database/repositories/admin-papers.repo.ts
import { Inject, Injectable } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface AdminPaperFilters {
  subjectId?: number;
  year?: number;
  gradeBand?: string;
  keyword?: string;
  page: number;
  pageSize: number;
}

export interface AdminPaperListRow extends RowDataPacket {
  id: number;
  subject_id: number;
  subject_name: string;
  title: string;
  grade: string | null;
  grade_band: string | null;
  semester: string | null;
  year: number | null;
  district: string | null;
  exam_type: string | null;
  source_key: string;
  created_at: Date;
  linked_question_count: number;
  session_count: number;
}

export interface PaperImpact {
  questionCount: number;
  sharedCount: number;
  exclusiveCount: number;
  deletableCount: number;
  retainedCount: number;
  sessionCount: number;
  answerCount: number;
}

/** 删除题时会触发 ON DELETE RESTRICT 的表（schema 固定 7 张，勿凭印象增删）。 */
const BLOCKING_TABLES = [
  'main_error_books',
  'aux_error_books',
  'answers',
  'exam_answers',
  'variation_questions',
  'special_answer_records',
  'remediation_set_items',
] as const;

/** 只用到 execute 的最小执行器接口（Pool 与 PoolConnection 都满足）。 */
type Queryable = {
  execute(sql: string, values?: unknown[]): Promise<unknown>;
};

function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** 卷内独占题 id（不被其它卷引用）。 */
async function findExclusiveIds(db: Queryable, paperId: number): Promise<number[]> {
  const result = (await db.execute(
    `SELECT pq.question_id AS qid FROM paper_questions pq
      WHERE pq.paper_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM paper_questions x
           WHERE x.question_id = pq.question_id AND x.paper_id <> ?
        )`,
    [paperId, paperId],
  )) as [Array<{ qid: number }>, unknown];
  return result[0].map((r) => Number(r.qid));
}

/** 在被学生数据引用的题 id 集合。 */
async function findBlockedIds(db: Queryable, ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const placeholders = ids.map(() => '?').join(',');
  const union = BLOCKING_TABLES
    .map((t) => `SELECT question_id AS qid FROM ${t} WHERE question_id IN (${placeholders})`)
    .join(' UNION ALL ');
  const params = BLOCKING_TABLES.flatMap(() => ids);
  const result = (await db.execute(
    `SELECT DISTINCT qid FROM (${union}) t`,
    params,
  )) as [Array<{ qid: number }>, unknown];
  return new Set(result[0].map((r) => Number(r.qid)));
}

/**
 * 管理端试卷仓储。
 *
 * 列表分页用 `pool.query`：mysql2 的 `execute` 对 `LIMIT ?` 会预编译失败
 * （护栏测试 `limit-placeholder.guard.test.ts`）。计数/详情用 execute。
 */
@Injectable()
export class AdminPapersRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async findPapers(filters: AdminPaperFilters): Promise<{ items: AdminPaperListRow[]; total: number }> {
    const where: string[] = [];
    const params: Array<number | string> = [];
    if (filters.subjectId !== undefined) {
      where.push('p.subject_id = ?');
      params.push(filters.subjectId);
    }
    if (filters.year !== undefined) {
      where.push('p.year = ?');
      params.push(filters.year);
    }
    if (filters.gradeBand !== undefined && filters.gradeBand !== '') {
      where.push('p.grade_band = ?');
      params.push(filters.gradeBand);
    }
    if (filters.keyword !== undefined && filters.keyword !== '') {
      where.push("p.title LIKE ? ESCAPE '\\\\'");
      params.push(`%${escapeLike(filters.keyword)}%`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const [countRows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM exam_papers p ${whereSql}`,
      params,
    );
    const [rows] = await this.pool.query<AdminPaperListRow[]>(
      `SELECT p.id, p.subject_id, s.name AS subject_name, p.title, p.grade, p.grade_band,
              p.semester, p.year, p.district, p.exam_type, p.source_key, p.created_at,
              (SELECT COUNT(*) FROM paper_questions pq WHERE pq.paper_id = p.id) AS linked_question_count,
              (SELECT COUNT(*) FROM exam_sessions es WHERE es.paper_id = p.id) AS session_count
         FROM exam_papers p JOIN subjects s ON s.id = p.subject_id
         ${whereSql}
        ORDER BY p.id DESC
        LIMIT ? OFFSET ?`,
      [...params, filters.pageSize, (filters.page - 1) * filters.pageSize],
    );
    return { items: rows, total: Number(countRows[0]?.total ?? 0) };
  }

  async findPaper(id: number): Promise<{ id: number; title: string; subjectName: string } | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT p.id, p.title, s.name AS subject_name
         FROM exam_papers p JOIN subjects s ON s.id = p.subject_id
        WHERE p.id = ?`,
      [id],
    );
    const row = rows[0];
    if (!row) return null;
    return { id: Number(row.id), title: String(row.title), subjectName: String(row.subject_name) };
  }

  async countImpact(paperId: number): Promise<PaperImpact> {
    const [questionRows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT COUNT(*) AS cnt FROM paper_questions WHERE paper_id = ?',
      [paperId],
    );
    const [sharedRows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS cnt FROM paper_questions pq
        WHERE pq.paper_id = ?
          AND EXISTS (
            SELECT 1 FROM paper_questions x
             WHERE x.question_id = pq.question_id AND x.paper_id <> ?
          )`,
      [paperId, paperId],
    );
    const [sessionRows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT COUNT(*) AS cnt FROM exam_sessions WHERE paper_id = ?',
      [paperId],
    );
    const [answerRows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS cnt FROM exam_answers ea
         JOIN exam_sessions es ON es.id = ea.session_id
        WHERE es.paper_id = ?`,
      [paperId],
    );

    const exclusiveIds = await findExclusiveIds(this.pool, paperId);
    const blocked = await findBlockedIds(this.pool, exclusiveIds);

    const questionCount = Number(questionRows[0]?.cnt ?? 0);
    const sharedCount = Number(sharedRows[0]?.cnt ?? 0);
    return {
      questionCount,
      sharedCount,
      exclusiveCount: exclusiveIds.length,
      deletableCount: exclusiveIds.length - blocked.size,
      retainedCount: blocked.size,
      sessionCount: Number(sessionRows[0]?.cnt ?? 0),
      answerCount: Number(answerRows[0]?.cnt ?? 0),
    };
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/database/repositories/admin-papers.repo.test.ts`
Expected: PASS（5 个用例）

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/database/repositories/admin-papers.repo.ts apps/server/src/database/repositories/admin-papers.repo.test.ts
git commit -m "feat(admin): paper repo for listing and delete impact"
```

---

### Task 2: 仓储 — 单事务级联删除

**Files:**
- Modify: `apps/server/src/database/repositories/admin-papers.repo.ts`
- Test: `apps/server/src/database/repositories/admin-papers.repo.test.ts`

**Interfaces:**
- Produces:
  - `PaperDeleteOutcome`：`{ paperTitle: string; deletedQuestions: number; retainedQuestions: number; deletedSessions: number; deletedAnswers: number }`
  - `AdminPapersRepository.deletePaperCascade(paperId): Promise<PaperDeleteOutcome | null>`（`null` = 卷不存在）

- [ ] **Step 1: 写失败测试**

在 `admin-papers.repo.test.ts` 末尾追加：

```ts
function mockConn(overrides: { failOn?: string } = {}) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const conn = {
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
    execute: vi.fn().mockImplementation((sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (overrides.failOn && sql.includes(overrides.failOn)) {
        return Promise.reject(Object.assign(new Error('fk'), { code: 'ER_ROW_IS_REFERENCED_2' }));
      }
      if (/SELECT id, title FROM exam_papers/.test(sql)) return Promise.resolve([[{ id: 446, title: '汇文卷' }], []]);
      if (/COUNT\(\*\) AS cnt FROM exam_sessions/.test(sql)) return Promise.resolve([[{ cnt: 1 }], []]);
      if (/FROM exam_answers ea JOIN/.test(sql)) return Promise.resolve([[{ cnt: 5 }], []]);
      if (/SELECT pq.question_id AS qid/.test(sql)) return Promise.resolve([[{ qid: 11 }, { qid: 12 }, { qid: 13 }], []]);
      if (/SELECT DISTINCT qid FROM/.test(sql)) return Promise.resolve([[{ qid: 13 }], []]);
      return Promise.resolve([{ affectedRows: 1 }, []]);
    }),
  };
  const pool = { getConnection: vi.fn().mockResolvedValue(conn) };
  return { pool, conn, calls };
}

describe('AdminPapersRepository.deletePaperCascade', () => {
  it('按「会话 → 题 → 卷」顺序删除，只删未被引用的独占题，返回真实计数', async () => {
    const { pool, conn, calls } = mockConn();
    const repo = new AdminPapersRepository(pool as any);

    const out = await repo.deletePaperCascade(446);

    expect(out).toEqual({
      paperTitle: '汇文卷',
      deletedQuestions: 2,
      retainedQuestions: 1,
      deletedSessions: 1,
      deletedAnswers: 5,
    });
    const sqls = calls.map((c) => c.sql);
    const sessionIdx = sqls.findIndex((s) => s.startsWith('DELETE FROM exam_sessions'));
    const questionIdx = sqls.findIndex((s) => s.startsWith('DELETE FROM questions'));
    const paperIdx = sqls.findIndex((s) => s.startsWith('DELETE FROM exam_papers'));
    expect(sessionIdx).toBeGreaterThan(-1);
    expect(questionIdx).toBeGreaterThan(sessionIdx);
    expect(paperIdx).toBeGreaterThan(questionIdx);
    // 只删 11 / 12（13 被引用保留）
    expect(calls[questionIdx].params).toEqual([11, 12]);
    expect(conn.commit).toHaveBeenCalledTimes(1);
    expect(conn.rollback).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalledTimes(1);
  });

  it('卷不存在 → 返回 null 并回滚，不提交', async () => {
    const conn = {
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
      execute: vi.fn().mockResolvedValue([[], []]),
    };
    const repo = new AdminPapersRepository({ getConnection: vi.fn().mockResolvedValue(conn) } as any);

    expect(await repo.deletePaperCascade(999)).toBeNull();
    expect(conn.rollback).toHaveBeenCalledTimes(1);
    expect(conn.commit).not.toHaveBeenCalled();
  });

  it('外键冲突 → 回滚并原样抛出（由 service 转 409）', async () => {
    const { pool, conn } = mockConn({ failOn: 'DELETE FROM exam_papers' });
    const repo = new AdminPapersRepository(pool as any);

    await expect(repo.deletePaperCascade(446)).rejects.toMatchObject({ code: 'ER_ROW_IS_REFERENCED_2' });
    expect(conn.rollback).toHaveBeenCalledTimes(1);
    expect(conn.commit).not.toHaveBeenCalled();
  });

  it('全部题都被引用 → 跳过 DELETE questions，deletedQuestions=0', async () => {
    const conn = {
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
      execute: vi.fn().mockImplementation((sql: string) => {
        if (/SELECT id, title FROM exam_papers/.test(sql)) return Promise.resolve([[{ id: 1, title: 'x' }], []]);
        if (/COUNT\(\*\) AS cnt/.test(sql)) return Promise.resolve([[{ cnt: 0 }], []]);
        if (/SELECT pq.question_id AS qid/.test(sql)) return Promise.resolve([[{ qid: 11 }], []]);
        if (/SELECT DISTINCT qid FROM/.test(sql)) return Promise.resolve([[{ qid: 11 }], []]);
        return Promise.resolve([{ affectedRows: 0 }, []]);
      }),
    };
    const repo = new AdminPapersRepository({ getConnection: vi.fn().mockResolvedValue(conn) } as any);

    const out = await repo.deletePaperCascade(1);

    expect(out?.deletedQuestions).toBe(0);
    expect(out?.retainedQuestions).toBe(1);
    expect(conn.execute.mock.calls.some((c) => String(c[0]).includes('DELETE FROM questions WHERE id IN'))).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/database/repositories/admin-papers.repo.test.ts`
Expected: FAIL — `repo.deletePaperCascade is not a function`

- [ ] **Step 3: 实现方法**

在 `admin-papers.repo.ts` 的 `PaperImpact` 后面加接口，并在类里追加方法：

```ts
export interface PaperDeleteOutcome {
  paperTitle: string;
  deletedQuestions: number;
  retainedQuestions: number;
  deletedSessions: number;
  deletedAnswers: number;
}
```

```ts
  /**
   * 单事务级联删除：会话（级联作答）→ 可删独占题 → 试卷（级联剩余关联）。
   *
   * 顺序不可换：先删本卷会话，后面查到的 `exam_answers` 引用才只来自其它来源。
   * 返回 null 表示卷不存在（service 转 404）；外键冲突原样抛（service 转 409）。
   */
  async deletePaperCascade(paperId: number): Promise<PaperDeleteOutcome | null> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [paperRows] = await conn.execute<RowDataPacket[]>(
        'SELECT id, title FROM exam_papers WHERE id = ? FOR UPDATE',
        [paperId],
      );
      if (paperRows.length === 0) {
        await conn.rollback();
        return null;
      }
      const paperTitle = String(paperRows[0].title);

      const [sessionRows] = await conn.execute<RowDataPacket[]>(
        'SELECT COUNT(*) AS cnt FROM exam_sessions WHERE paper_id = ?',
        [paperId],
      );
      const [answerRows] = await conn.execute<RowDataPacket[]>(
        `SELECT COUNT(*) AS cnt FROM exam_answers ea
           JOIN exam_sessions es ON es.id = ea.session_id
          WHERE es.paper_id = ?`,
        [paperId],
      );
      const deletedSessions = Number(sessionRows[0]?.cnt ?? 0);
      const deletedAnswers = Number(answerRows[0]?.cnt ?? 0);

      await conn.execute('DELETE FROM exam_sessions WHERE paper_id = ?', [paperId]);

      const exclusiveIds = await findExclusiveIds(conn, paperId);
      const blocked = await findBlockedIds(conn, exclusiveIds);
      const deletable = exclusiveIds.filter((id) => !blocked.has(id));
      if (deletable.length > 0) {
        const placeholders = deletable.map(() => '?').join(',');
        await conn.execute(`DELETE FROM questions WHERE id IN (${placeholders})`, deletable);
      }

      await conn.execute('DELETE FROM exam_papers WHERE id = ?', [paperId]);
      await conn.commit();

      return {
        paperTitle,
        deletedQuestions: deletable.length,
        retainedQuestions: exclusiveIds.length - deletable.length,
        deletedSessions,
        deletedAnswers,
      };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/database/repositories/admin-papers.repo.test.ts`
Expected: PASS（9 个用例）

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/database/repositories/admin-papers.repo.ts apps/server/src/database/repositories/admin-papers.repo.test.ts
git commit -m "feat(admin): transactional paper cascade delete in repo"
```

---

### Task 3: 服务层 — DTO 映射与错误转换

**Files:**
- Create: `apps/server/src/modules/admin/admin-papers.service.ts`
- Test: `apps/server/src/modules/admin/admin-papers.service.test.ts`

**Interfaces:**
- Consumes: Task 1/2 的 `AdminPapersRepository`、`PaperImpact`、`PaperDeleteOutcome`
- Produces:
  - `AdminPaperQuery`：`{ subjectId?: number; year?: number; gradeBand?: 'primary' | 'junior' | 'senior'; keyword?: string; page: number; pageSize: number }`
  - `AdminPaperItem` / `AdminPaperListResult` / `AdminPaperDeletePreview` / `AdminPaperDeleteResult`
  - `AdminPapersService.list(query)`、`.preview(id)`、`.remove(id)`

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/src/modules/admin/admin-papers.service.test.ts
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { AdminPapersService } from './admin-papers.service.js';
import type { AdminPapersRepository, AdminPaperListRow } from '../../database/repositories/admin-papers.repo.js';

function row(over: Partial<AdminPaperListRow> = {}): AdminPaperListRow {
  return {
    id: 446,
    subject_id: 9,
    subject_name: '道德与法治',
    title: '汇文卷',
    grade: '初三',
    grade_band: 'junior',
    semester: 'first',
    year: 2026,
    district: '',
    exam_type: '期中',
    source_key: 'k',
    created_at: new Date('2026-11-07T01:15:00.029Z'),
    linked_question_count: 14,
    session_count: 1,
    ...over,
  } as AdminPaperListRow;
}

function mkRepo(over: Record<string, any> = {}) {
  return {
    findPapers: vi.fn().mockResolvedValue({ items: [row()], total: 1 }),
    findPaper: vi.fn().mockResolvedValue({ id: 446, title: '汇文卷', subjectName: '道德与法治' }),
    countImpact: vi.fn().mockResolvedValue({
      questionCount: 14, sharedCount: 0, exclusiveCount: 14,
      deletableCount: 14, retainedCount: 0, sessionCount: 1, answerCount: 5,
    }),
    deletePaperCascade: vi.fn().mockResolvedValue({
      paperTitle: '汇文卷', deletedQuestions: 14, retainedQuestions: 0,
      deletedSessions: 1, deletedAnswers: 5,
    }),
    ...over,
  };
}

function mkSvc(repo = mkRepo()) {
  return { svc: new AdminPapersService(repo as unknown as AdminPapersRepository), repo };
}

describe('AdminPapersService.list', () => {
  it('行 → DTO；题数用 linked_question_count，createdAt 转 ISO', async () => {
    const { svc } = mkSvc();
    const out = await svc.list({ page: 1, pageSize: 20 });

    expect(out.items[0]).toEqual({
      id: 446, subjectId: 9, subjectName: '道德与法治', title: '汇文卷',
      grade: '初三', gradeBand: 'junior', semester: 'first', year: 2026,
      district: '', examType: '期中', sourceKey: 'k',
      questionCount: 14, sessionCount: 1,
      createdAt: '2026-11-07T01:15:00.029Z',
    });
    expect(out.total).toBe(1);
    expect(out.page).toBe(1);
  });
});

describe('AdminPapersService.preview', () => {
  it('合并试卷元信息与影响面', async () => {
    const { svc } = mkSvc();
    const out = await svc.preview(446);
    expect(out).toMatchObject({ paperId: 446, title: '汇文卷', subjectName: '道德与法治', deletableCount: 14 });
  });

  it('卷不存在 → 404（全局过滤器落 code 1002）', async () => {
    const { svc } = mkSvc(mkRepo({ findPaper: vi.fn().mockResolvedValue(null) }));
    await expect(svc.preview(999)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('id 非正数 → 400', async () => {
    const { svc } = mkSvc();
    await expect(svc.preview(0)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.remove(-1)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('AdminPapersService.remove', () => {
  it('成功：返回四个计数，不透出 paperTitle', async () => {
    const { svc } = mkSvc();
    const out = await svc.remove(446);
    expect(out).toEqual({
      paperId: 446, deletedQuestions: 14, retainedQuestions: 0,
      deletedSessions: 1, deletedAnswers: 5,
    });
    expect('paperTitle' in out).toBe(false);
  });

  it('卷不存在 → 404', async () => {
    const { svc } = mkSvc(mkRepo({ deletePaperCascade: vi.fn().mockResolvedValue(null) }));
    await expect(svc.remove(999)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('外键冲突 → 409 / 4201', async () => {
    const { svc } = mkSvc(mkRepo({
      deletePaperCascade: vi.fn().mockRejectedValue(Object.assign(new Error('fk'), { code: 'ER_ROW_IS_REFERENCED_2' })),
    }));

    const err = await svc.remove(446).catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({ code: 4201 });
  });

  it('其它数据库异常原样抛（不吞成 409）', async () => {
    const boom = new Error('db down');
    const { svc } = mkSvc(mkRepo({ deletePaperCascade: vi.fn().mockRejectedValue(boom) }));
    await expect(svc.remove(446)).rejects.toBe(boom);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/admin/admin-papers.service.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现服务**

```ts
// apps/server/src/modules/admin/admin-papers.service.ts
import { BadRequestException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AdminPapersRepository,
  type AdminPaperListRow,
  type PaperImpact,
} from '../../database/repositories/admin-papers.repo.js';

export interface AdminPaperQuery {
  subjectId?: number;
  year?: number;
  gradeBand?: 'primary' | 'junior' | 'senior';
  keyword?: string;
  page: number;
  pageSize: number;
}

export interface AdminPaperItem {
  id: number;
  subjectId: number;
  subjectName: string;
  title: string;
  grade: string | null;
  gradeBand: string | null;
  semester: string | null;
  year: number | null;
  district: string | null;
  examType: string | null;
  sourceKey: string;
  questionCount: number;
  sessionCount: number;
  createdAt: string;
}

export interface AdminPaperListResult {
  items: AdminPaperItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AdminPaperDeletePreview extends PaperImpact {
  paperId: number;
  title: string;
  subjectName: string;
}

export interface AdminPaperDeleteResult {
  paperId: number;
  deletedQuestions: number;
  retainedQuestions: number;
  deletedSessions: number;
  deletedAnswers: number;
}

function toItem(row: AdminPaperListRow): AdminPaperItem {
  return {
    id: Number(row.id),
    subjectId: Number(row.subject_id),
    subjectName: row.subject_name,
    title: row.title,
    grade: row.grade,
    gradeBand: row.grade_band,
    semester: row.semester,
    year: row.year === null ? null : Number(row.year),
    district: row.district,
    examType: row.exam_type,
    sourceKey: row.source_key,
    questionCount: Number(row.linked_question_count),
    sessionCount: Number(row.session_count),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function isForeignKeyConflict(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && (err as { code?: string }).code === 'ER_ROW_IS_REFERENCED_2';
}

/**
 * 管理端试卷管理：列表 / 删除预览 / 删除。
 *
 * 删除规则（spec §5）：只删独占题；共享题只解绑；被学生数据引用的独占题保留；
 * 该卷考试会话连同作答一并删除。仓储负责事务，本层只做 id 校验与错误转换。
 */
@Injectable()
export class AdminPapersService {
  constructor(private readonly repo: AdminPapersRepository) {}

  async list(query: AdminPaperQuery): Promise<AdminPaperListResult> {
    const { items, total } = await this.repo.findPapers(query);
    return { items: items.map(toItem), total, page: query.page, pageSize: query.pageSize };
  }

  async preview(id: number): Promise<AdminPaperDeletePreview> {
    this.assertId(id);
    const paper = await this.repo.findPaper(id);
    if (!paper) {
      throw new NotFoundException(`试卷不存在：${id}`);
    }
    const impact = await this.repo.countImpact(id);
    return {
      paperId: paper.id,
      title: paper.title,
      subjectName: paper.subjectName,
      ...impact,
    };
  }

  async remove(id: number): Promise<AdminPaperDeleteResult> {
    this.assertId(id);
    let outcome;
    try {
      outcome = await this.repo.deletePaperCascade(id);
    } catch (err) {
      if (isForeignKeyConflict(err)) {
        throw new HttpException({ code: 4201, message: '该试卷正在被使用，请刷新后重试' }, 409);
      }
      throw err;
    }
    if (!outcome) {
      throw new NotFoundException(`试卷不存在：${id}`);
    }
    return {
      paperId: id,
      deletedQuestions: outcome.deletedQuestions,
      retainedQuestions: outcome.retainedQuestions,
      deletedSessions: outcome.deletedSessions,
      deletedAnswers: outcome.deletedAnswers,
    };
  }

  private assertId(id: number): void {
    if (!Number.isInteger(id) || id <= 0) {
      throw new BadRequestException({ code: 1001, message: '试卷 id 必须是正整数' });
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/admin/admin-papers.service.test.ts`
Expected: PASS（8 个用例）

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/modules/admin/admin-papers.service.ts apps/server/src/modules/admin/admin-papers.service.test.ts
git commit -m "feat(admin): paper admin service with impact preview"
```

---

### Task 4: 控制器与模块注册

**Files:**
- Create: `apps/server/src/modules/admin/admin-papers.controller.ts`
- Create: `apps/server/src/modules/admin/admin-papers.controller.test.ts`
- Modify: `apps/server/src/modules/admin/admin.module.ts`

**Interfaces:**
- Consumes: `AdminPapersService`（Task 3）
- Produces: 路由 `GET /api/admin/papers`、`GET /api/admin/papers/:id/delete-preview`、`DELETE /api/admin/papers/:id`

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/src/modules/admin/admin-papers.controller.test.ts
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { AdminPapersController } from './admin-papers.controller.js';
import type { AdminPapersService } from './admin-papers.service.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { ROLES_KEY } from '../../common/decorators/roles.js';

const GUARDS_METADATA = '__guards__';

function makeController() {
  const service = {
    list: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
    preview: vi.fn().mockResolvedValue({ paperId: 1 }),
    remove: vi.fn().mockResolvedValue({ paperId: 1 }),
  };
  return { controller: new AdminPapersController(service as unknown as AdminPapersService), service };
}

describe('AdminPapersController 路由形状', () => {
  it('类前缀 api/admin/papers，且挂 JwtAuthGuard + RolesGuard + admin 角色', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminPapersController)).toBe('api/admin/papers');
    const guards = Reflect.getMetadata(GUARDS_METADATA, AdminPapersController) as unknown[];
    expect(guards).toEqual([JwtAuthGuard, RolesGuard]);
    expect(new Reflector().get<string[]>(ROLES_KEY, AdminPapersController)).toEqual(['admin']);
  });

  it('三个方法的路由与方法', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminPapersController.prototype.list)).toBe('/');
    expect(Reflect.getMetadata(METHOD_METADATA, AdminPapersController.prototype.list)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, AdminPapersController.prototype.preview)).toBe(':id/delete-preview');
    expect(Reflect.getMetadata(METHOD_METADATA, AdminPapersController.prototype.preview)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, AdminPapersController.prototype.remove)).toBe(':id');
    expect(Reflect.getMetadata(METHOD_METADATA, AdminPapersController.prototype.remove)).toBe(RequestMethod.DELETE);
  });
});

describe('AdminPapersController.list 入参', () => {
  it('空 query → 默认 page=1 pageSize=20，空字符串不当作非法数字', async () => {
    const { controller, service } = makeController();
    await controller.list({ subjectId: '', year: '', gradeBand: '', keyword: '' });
    expect(service.list).toHaveBeenCalledWith({ subjectId: undefined, year: undefined, gradeBand: undefined, keyword: undefined, page: 1, pageSize: 20 });
  });

  it('非法 gradeBand / pageSize / subjectId → 400（不是 500）', async () => {
    const { controller } = makeController();
    expect(() => controller.list({ gradeBand: 'foo' })).toThrow(BadRequestException);
    expect(() => controller.list({ pageSize: '101' })).toThrow(BadRequestException);
    expect(() => controller.list({ pageSize: '0' })).toThrow(BadRequestException);
    expect(() => controller.list({ subjectId: 'abc' })).toThrow(BadRequestException);
  });

  it('合法参数原样透传（数字从字符串 coerce）', async () => {
    const { controller, service } = makeController();
    await controller.list({ subjectId: '9', year: '2026', gradeBand: 'junior', keyword: ' 汇文 ', page: '2', pageSize: '10' });
    expect(service.list).toHaveBeenCalledWith({ subjectId: 9, year: 2026, gradeBand: 'junior', keyword: '汇文', page: 2, pageSize: 10 });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/admin/admin-papers.controller.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现控制器**

```ts
// apps/server/src/modules/admin/admin-papers.controller.ts
import { BadRequestException, Controller, Delete, Get, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminPapersService } from './admin-papers.service.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';

/** 空字符串 = 未填（前端清空筛选后会带 `x=`），不能让它被 coerce 成 0 后报错。 */
function optionalInt(min: number, max?: number) {
  return z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : v),
    z.coerce.number().int().min(min).max(max ?? Number.MAX_SAFE_INTEGER).optional(),
  );
}

const PaperListQuerySchema = z.object({
  subjectId: optionalInt(1),
  year: optionalInt(2000, 2100),
  gradeBand: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : v),
    z.enum(['primary', 'junior', 'senior']).optional(),
  ),
  keyword: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : v),
    z.string().trim().max(50).optional(),
  ),
  page: optionalInt(1).transform((v) => v ?? 1),
  pageSize: optionalInt(1, 100).transform((v) => v ?? 20),
});

/**
 * 裸 ZodError 不是 HttpException，会被全局过滤器兜成 500/5000
 * （`http-exception.filter.ts:20-27`）—— 客户端入参错误必须 400/1001。
 * 同款：`auth.controller.ts` 的 parseInput。
 */
function parseQuery<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'query'}: ${issue.message}`)
      .join('; ');
    throw new BadRequestException({ code: 1001, message: `入参校验失败：${detail}` });
  }
  return parsed.data;
}

@Controller('api/admin/papers')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class AdminPapersController {
  constructor(private readonly service: AdminPapersService) {}

  /** 试卷列表：全学科分页，keyword 匹配标题。 */
  @Get()
  list(@Query() query: unknown) {
    return this.service.list(parseQuery(PaperListQuerySchema, query));
  }

  /** 删除前影响面预览（只读，不加锁）。 */
  @Get(':id/delete-preview')
  preview(@Param('id', ParseIntPipe) id: number) {
    return this.service.preview(id);
  }

  /** 删除套卷：独占题 + 考试会话 + 逐题作答，单事务。 */
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }
}
```

- [ ] **Step 4: 注册进模块**

修改 `apps/server/src/modules/admin/admin.module.ts`：

```ts
// 顶部 import 追加
import { AdminPapersRepository } from '../../database/repositories/admin-papers.repo.js';
import { AdminPapersController } from './admin-papers.controller.js';
import { AdminPapersService } from './admin-papers.service.js';
```

```ts
  controllers: [AdminController, AdminPapersController],
  providers: [
    // ...原有 provider 保留
    AdminPapersRepository,
    AdminPapersService,
  ],
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/admin/admin-papers.controller.test.ts`
Expected: PASS（5 个用例）

- [ ] **Step 6: 全量后端测试 + 构建**

Run: `cd apps/server && npm test && npm run build`
Expected: 全绿；`dist/modules/admin/admin-papers.controller.js` 存在

- [ ] **Step 7: 提交**

```bash
git add apps/server/src/modules/admin/admin-papers.controller.ts apps/server/src/modules/admin/admin-papers.controller.test.ts apps/server/src/modules/admin/admin.module.ts
git commit -m "feat(admin): expose papers list, delete preview and delete endpoints"
```

---

### Task 5: 前端 API 客户端 + 路由 + 侧栏

**Files:**
- Modify: `apps/web/src/services/api.ts`
- Modify: `apps/web/src/routes/routeTable.tsx`
- Modify: `apps/web/src/components/layout/AdminNav.tsx`
- Modify: `apps/web/src/components/layout/AdminNav.test.tsx`

**Interfaces:**
- Produces:
  - `AdminPaperItem`、`AdminPaperListResult`、`AdminPaperDeletePreview`、`AdminPaperDeleteResult`
  - `listAdminPapers(params)`、`getAdminPaperDeletePreview(id)`、`deleteAdminPaper(id)`
  - 路由 `/admin/papers`

- [ ] **Step 1: 在 `api.ts` 追加类型与方法**

放在 `purgeExpiredAlerts` 之后（约 `api.ts:908`）：

```ts
// --- Admin: papers（试卷管理，2026-11-09） ---

export interface AdminPaperItem {
  id: number;
  subjectId: number;
  subjectName: string;
  title: string;
  grade: string | null;
  gradeBand: string | null;
  semester: string | null;
  year: number | null;
  district: string | null;
  examType: string | null;
  sourceKey: string;
  questionCount: number;
  sessionCount: number;
  createdAt: string;
}

export interface AdminPaperListResult {
  items: AdminPaperItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AdminPaperDeletePreview {
  paperId: number;
  title: string;
  subjectName: string;
  questionCount: number;
  sharedCount: number;
  exclusiveCount: number;
  deletableCount: number;
  retainedCount: number;
  sessionCount: number;
  answerCount: number;
}

export interface AdminPaperDeleteResult {
  paperId: number;
  deletedQuestions: number;
  retainedQuestions: number;
  deletedSessions: number;
  deletedAnswers: number;
}

export function listAdminPapers(params: {
  subjectId?: number;
  year?: number;
  gradeBand?: string;
  keyword?: string;
  page: number;
  pageSize: number;
}): Promise<AdminPaperListResult> {
  const qs = new URLSearchParams();
  if (params.subjectId !== undefined) qs.set('subjectId', String(params.subjectId));
  if (params.year !== undefined) qs.set('year', String(params.year));
  if (params.gradeBand) qs.set('gradeBand', params.gradeBand);
  if (params.keyword) qs.set('keyword', params.keyword);
  qs.set('page', String(params.page));
  qs.set('pageSize', String(params.pageSize));
  return fetchApi(`/admin/papers?${qs.toString()}`);
}

export function getAdminPaperDeletePreview(id: number): Promise<AdminPaperDeletePreview> {
  return fetchApi(`/admin/papers/${id}/delete-preview`);
}

export function deleteAdminPaper(id: number): Promise<AdminPaperDeleteResult> {
  return fetchApi(`/admin/papers/${id}`, { method: 'DELETE' });
}
```

- [ ] **Step 2: 建页面占位文件（Task 6 填实）**

```tsx
// apps/web/src/pages/admin/AdminPapersPage.tsx
export default function AdminPapersPage() {
  return null;
}
```

- [ ] **Step 3: 挂路由**

`apps/web/src/routes/routeTable.tsx`：

```tsx
import AdminPapersPage from '@/pages/admin/AdminPapersPage';
```

children 里「订阅裁决」之前加：

```tsx
      { path: 'papers', element: <AdminPapersPage /> },
```

- [ ] **Step 4: 侧栏入口**

`apps/web/src/components/layout/AdminNav.tsx` 的 `navItems`，在「订阅裁决」后插入：

```tsx
  { to: '/admin/papers', label: '试卷管理' },
```

- [ ] **Step 4: 补侧栏断言**

`apps/web/src/components/layout/AdminNav.test.tsx` 末尾追加：

```tsx
describe('AdminNav 导航项', () => {
  it('包含「试卷管理」入口且指向 /admin/papers', () => {
    listClaimsMock.mockRejectedValue(new Error('隔离'));
    renderNav();
    const link = screen.getByRole('link', { name: '试卷管理' });
    expect(link).toHaveAttribute('href', '/admin/papers');
  });
});
```

- [ ] **Step 5: 跑测试**

Run: `cd apps/web && npx vitest run src/components/layout/AdminNav.test.tsx`
Expected: PASS（占位页已在 Step 2 建好，路由 import 不会报错）

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/services/api.ts apps/web/src/pages/admin/AdminPapersPage.tsx apps/web/src/routes/routeTable.tsx apps/web/src/components/layout/AdminNav.tsx apps/web/src/components/layout/AdminNav.test.tsx
git commit -m "feat(web): admin paper api client, route and nav entry"
```

---

### Task 6: 「试卷管理」页面

**Files:**
- Create: `apps/web/src/pages/admin/AdminPapersPage.tsx`
- Test: `apps/web/src/pages/admin/AdminPapersPage.test.tsx`

**Interfaces:**
- Consumes: Task 5 的 3 个 API 方法与类型、`@/components/base` 的 `ConfirmDialog` / `Skeleton` / `toast`、`@/subjectConfig` 的 `TRAINING_SUBJECTS`

- [ ] **Step 1: 写失败测试**

```tsx
// apps/web/src/pages/admin/AdminPapersPage.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AdminPapersPage from './AdminPapersPage';
import {
  ApiError,
  deleteAdminPaper,
  getAdminPaperDeletePreview,
  listAdminPapers,
  type AdminPaperDeletePreview,
  type AdminPaperListResult,
} from '@/services/api';
import { toast } from '@/components/base';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    listAdminPapers: vi.fn(),
    getAdminPaperDeletePreview: vi.fn(),
    deleteAdminPaper: vi.fn(),
  };
});

vi.mock('@/components/base', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/base')>();
  return { ...actual, toast: vi.fn() };
});

const listMock = vi.mocked(listAdminPapers);
const previewMock = vi.mocked(getAdminPaperDeletePreview);
const deleteMock = vi.mocked(deleteAdminPaper);
const toastMock = vi.mocked(toast);

function listResult(over: Partial<AdminPaperListResult> = {}): AdminPaperListResult {
  return {
    items: [
      {
        id: 446, subjectId: 9, subjectName: '道德与法治', title: '汇文卷',
        grade: '初三', gradeBand: 'junior', semester: 'first', year: 2026,
        district: '', examType: '期中', sourceKey: 'k',
        questionCount: 14, sessionCount: 1, createdAt: '2026-11-07T01:15:00.029Z',
      },
    ],
    total: 1, page: 1, pageSize: 20,
    ...over,
  };
}

const PREVIEW: AdminPaperDeletePreview = {
  paperId: 446, title: '汇文卷', subjectName: '道德与法治',
  questionCount: 14, sharedCount: 1, exclusiveCount: 13, deletableCount: 10,
  retainedCount: 3, sessionCount: 1, answerCount: 5,
};

beforeEach(() => {
  listMock.mockReset().mockResolvedValue(listResult());
  previewMock.mockReset().mockResolvedValue(PREVIEW);
  deleteMock.mockReset().mockResolvedValue({
    paperId: 446, deletedQuestions: 10, retainedQuestions: 3, deletedSessions: 1, deletedAnswers: 5,
  });
  toastMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AdminPapersPage 列表', () => {
  it('首屏渲染行数据与总数，默认 page=1 pageSize=20', async () => {
    render(<AdminPapersPage />);

    expect(await screen.findByTestId('papers-table')).toBeInTheDocument();
    expect(screen.getByText('汇文卷')).toBeInTheDocument();
    expect(screen.getByText('道德与法治')).toBeInTheDocument();
    expect(screen.getByText('共 1 条')).toBeInTheDocument();
    expect(listMock).toHaveBeenCalledWith({ page: 1, pageSize: 20 });
  });

  it('加载中 → Skeleton；失败 → 错误卡 + toast', async () => {
    listMock.mockReturnValueOnce(new Promise(() => {}));
    const { rerender } = render(<AdminPapersPage />);
    expect(screen.getByTestId('papers-loading')).toBeInTheDocument();

    listMock.mockReset().mockRejectedValueOnce(new ApiError(5000, '服务异常'));
    rerender(<AdminPapersPage />);
    expect(await screen.findByTestId('papers-error')).toBeInTheDocument();
    expect(toastMock).toHaveBeenCalledWith('error', '服务异常');
  });

  it('筛选提交后带条件重新请求并回第 1 页', async () => {
    render(<AdminPapersPage />);
    await screen.findByTestId('papers-table');

    fireEvent.change(screen.getByTestId('papers-filter-subject'), { target: { value: '9' } });
    fireEvent.change(screen.getByTestId('papers-filter-keyword'), { target: { value: '汇文' } });
    fireEvent.submit(screen.getByTestId('papers-filter-form'));

    await waitFor(() => {
      expect(listMock).toHaveBeenLastCalledWith({ subjectId: 9, keyword: '汇文', page: 1, pageSize: 20 });
    });
  });
});

describe('AdminPapersPage 删除', () => {
  it('点删除 → 先拉预览，确认框展示影响面数字', async () => {
    render(<AdminPapersPage />);
    await screen.findByTestId('papers-table');

    fireEvent.click(screen.getByTestId('paper-delete-446'));

    await waitFor(() => expect(previewMock).toHaveBeenCalledWith(446));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('共享题 1 道仅解除关联');
    expect(dialog).toHaveTextContent('被学生数据引用 3 道保留');
    expect(dialog).toHaveTextContent('考试会话 1 场、作答 5 条');
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('确认 → 调 delete、toast 结果、重新拉列表', async () => {
    render(<AdminPapersPage />);
    await screen.findByTestId('papers-table');
    fireEvent.click(screen.getByTestId('paper-delete-446'));
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByTitle('确认'));

    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith(446));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('success', '已删除《汇文卷》：题目 10 道、会话 1 场'));
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it('预览失败 → toast 且不开确认框', async () => {
    previewMock.mockRejectedValueOnce(new ApiError(5000, '服务异常'));
    render(<AdminPapersPage />);
    await screen.findByTestId('papers-table');

    fireEvent.click(screen.getByTestId('paper-delete-446'));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('error', '服务异常'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
```

> `ConfirmDialog` 的确认按钮是圆形对勾，`title="确认"` / `aria-label="确认"`（无 testid），测试统一用 `screen.getByTitle('确认')`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/admin/AdminPapersPage.test.tsx`
Expected: FAIL — 页面不存在

- [ ] **Step 3: 实现页面**

```tsx
// apps/web/src/pages/admin/AdminPapersPage.tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  deleteAdminPaper,
  getAdminPaperDeletePreview,
  listAdminPapers,
  type AdminPaperDeletePreview,
  type AdminPaperListResult,
} from '@/services/api';
import { ConfirmDialog, Skeleton, toast } from '@/components/base';
import { TRAINING_SUBJECTS } from '@/subjectConfig';

const PAGE_SIZE = 20;

const GRADE_OPTIONS = [
  { value: '', label: '全部年级' },
  { value: 'primary', label: '小学' },
  { value: 'junior', label: '初中' },
  { value: 'senior', label: '高中' },
];

interface FilterDraft {
  subjectId: string;
  gradeBand: string;
  year: string;
  keyword: string;
}

const EMPTY_DRAFT: FilterDraft = { subjectId: '', gradeBand: '', year: '', keyword: '' };

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : '操作失败';
}

/**
 * 管理端「试卷管理」：筛选 + 删除套卷。
 *
 * 删除前必须先调 delete-preview 展示真实影响面（题数/共享/保留/会话/作答）；
 * 确认删除不可恢复。防连点用 ref 闸门（ConfirmDialog 的确认按钮没有 disabled，
 * state 要等下一次渲染才生效——同 AdminAlertsPage 的 purgingRef）。
 */
export default function AdminPapersPage() {
  const [draft, setDraft] = useState<FilterDraft>(EMPTY_DRAFT);
  const [applied, setApplied] = useState<FilterDraft>(EMPTY_DRAFT);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AdminPaperListResult | null>(null);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<AdminPaperDeletePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);

  const load = useCallback(() => {
    setError('');
    const params: Parameters<typeof listAdminPapers>[0] = { page, pageSize: PAGE_SIZE };
    if (applied.subjectId) params.subjectId = Number(applied.subjectId);
    if (applied.gradeBand) params.gradeBand = applied.gradeBand;
    if (applied.year) params.year = Number(applied.year);
    if (applied.keyword.trim()) params.keyword = applied.keyword.trim();
    listAdminPapers(params)
      .then((res) => setData(res))
      .catch((err: unknown) => {
        setData(null);
        setError(errMessage(err));
        toast('error', errMessage(err));
      });
  }, [applied, page]);

  useEffect(() => {
    load();
  }, [load]);

  const submitFilters = (e: FormEvent) => {
    e.preventDefault();
    setPage(1);
    setApplied(draft);
  };

  const handleDeleteClick = async (paperId: number) => {
    if (previewing) return;
    setPreviewing(true);
    try {
      setPreview(await getAdminPaperDeletePreview(paperId));
    } catch (err) {
      toast('error', errMessage(err));
    } finally {
      setPreviewing(false);
    }
  };

  const handleConfirm = async () => {
    if (!preview || deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    try {
      const res = await deleteAdminPaper(preview.paperId);
      toast('success', `已删除《${preview.title}》：题目 ${res.deletedQuestions} 道、会话 ${res.deletedSessions} 场`);
      setPreview(null);
      if (page > 1 && data?.items.length === 1) {
        setPage(page - 1);
      } else {
        load();
      }
    } catch (err) {
      toast('error', errMessage(err));
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-black tracking-tight" style={{ color: 'var(--text-primary)' }}>试卷管理</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
          删除导错的套卷。只删该卷独占的题；共享题仅解除关联；删除不可恢复。
        </p>
      </div>

      <form
        data-testid="papers-filter-form"
        onSubmit={submitFilters}
        className="bg-white rounded-2xl border border-gray-200 p-4 flex flex-wrap items-end gap-3"
      >
        <label className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          学科
          <select
            data-testid="papers-filter-subject"
            value={draft.subjectId}
            onChange={(e) => setDraft({ ...draft, subjectId: e.target.value })}
            className="block mt-1 px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white"
          >
            <option value="">全部学科</option>
            {TRAINING_SUBJECTS.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>

        <label className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          年级
          <select
            data-testid="papers-filter-grade"
            value={draft.gradeBand}
            onChange={(e) => setDraft({ ...draft, gradeBand: e.target.value })}
            className="block mt-1 px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white"
          >
            {GRADE_OPTIONS.map((g) => (
              <option key={g.value} value={g.value}>{g.label}</option>
            ))}
          </select>
        </label>

        <label className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          年份
          <input
            data-testid="papers-filter-year"
            value={draft.year}
            onChange={(e) => setDraft({ ...draft, year: e.target.value.replace(/\D/g, '').slice(0, 4) })}
            placeholder="如 2026"
            className="block mt-1 w-28 px-3 py-2 rounded-lg border border-gray-200 text-sm"
          />
        </label>

        <label className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          标题关键词
          <input
            data-testid="papers-filter-keyword"
            value={draft.keyword}
            onChange={(e) => setDraft({ ...draft, keyword: e.target.value.slice(0, 50) })}
            placeholder="如 汇文"
            className="block mt-1 w-56 px-3 py-2 rounded-lg border border-gray-200 text-sm"
          />
        </label>

        <button
          type="submit"
          className="px-4 py-2 rounded-lg text-sm font-semibold bg-[var(--brand-500)] text-white hover:opacity-90"
        >
          查询
        </button>
      </form>

      {error ? (
        <div data-testid="papers-error" className="bg-white rounded-2xl border border-dashed border-gray-200 p-10 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
          试卷列表加载失败，请稍后重试
        </div>
      ) : data === null ? (
        <div data-testid="papers-loading" className="bg-white rounded-2xl border border-gray-200 p-5 space-y-3">
          <Skeleton width={180} height={16} />
          <Skeleton width="80%" height={14} />
          <Skeleton width="60%" height={14} />
        </div>
      ) : data.items.length === 0 ? (
        <div data-testid="papers-empty" className="bg-white rounded-2xl border border-dashed border-gray-200 p-10 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
          没有匹配的试卷
        </div>
      ) : (
        <div data-testid="papers-table" className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50" style={{ color: 'var(--text-secondary)' }}>
              <tr>
                <th className="text-left px-4 py-3 font-medium">标题</th>
                <th className="text-left px-4 py-3 font-medium">学科</th>
                <th className="text-left px-4 py-3 font-medium">年份</th>
                <th className="text-left px-4 py-3 font-medium">年级</th>
                <th className="text-right px-4 py-3 font-medium">题数</th>
                <th className="text-right px-4 py-3 font-medium">考试人次</th>
                <th className="text-right px-4 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody style={{ color: 'var(--text-primary)' }}>
              {data.items.map((paper) => (
                <tr key={paper.id} className="border-t border-gray-100">
                  <td className="px-4 py-3">{paper.title}</td>
                  <td className="px-4 py-3">{paper.subjectName}</td>
                  <td className="px-4 py-3">{paper.year ?? '—'}</td>
                  <td className="px-4 py-3">{paper.grade ?? '—'}</td>
                  <td className="px-4 py-3 text-right">{paper.questionCount}</td>
                  <td className="px-4 py-3 text-right">{paper.sessionCount}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      data-testid={`paper-delete-${paper.id}`}
                      disabled={previewing}
                      onClick={() => handleDeleteClick(paper.id)}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold text-[var(--error)] border border-[var(--error)]/40 hover:bg-[var(--error)]/5 disabled:opacity-40"
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.total > 0 && (
        <div className="flex items-center justify-between text-sm" style={{ color: 'var(--text-secondary)' }}>
          <span>{`共 ${data.total} 条`}</span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
              className="px-3 py-1.5 rounded-lg border border-gray-200 disabled:opacity-40"
            >
              上一页
            </button>
            <span className="px-2 py-1.5">{`${page} / ${totalPages}`}</span>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage(page + 1)}
              className="px-3 py-1.5 rounded-lg border border-gray-200 disabled:opacity-40"
            >
              下一页
            </button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={preview !== null}
        title="提示："
        message={
          preview
            ? `确认删除试卷《${preview.title}》？\n将删除题目 ${preview.deletableCount} 道（共享题 ${preview.sharedCount} 道仅解除关联、被学生数据引用 ${preview.retainedCount} 道保留）、考试会话 ${preview.sessionCount} 场、作答 ${preview.answerCount} 条。此操作不可恢复。`
            : ''
        }
        onConfirm={handleConfirm}
        onCancel={() => {
          if (!deleting) setPreview(null);
        }}
      />
    </div>
  );
}
```

- [ ] **Step 4: 跑页面测试**

Run: `cd apps/web && npx vitest run src/pages/admin/AdminPapersPage.test.tsx`
Expected: PASS（6 个用例）；若确认按钮无 testid，按 Step 1 注释改用 `getByTitle('确认')`

- [ ] **Step 5: 跑侧栏测试**

Run: `cd apps/web && npx vitest run src/components/layout/AdminNav.test.tsx`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/pages/admin/AdminPapersPage.tsx apps/web/src/pages/admin/AdminPapersPage.test.tsx
git commit -m "feat(web): admin papers page with delete preview confirm"
```

---

### Task 7: 文档同步与整体验收

**Files:**
- Modify: `docs/API接口与数据流设计文档.md`（§4.17 Admin 表格）
- Modify: `docs/api/openapi.yaml`（Admin 段）
- Modify: `docs/ai-core-changelog.md`

- [ ] **Step 1: API 设计文档加 3 行**

在 §4.17 的表格末尾（`/api/admin/billing/families/{parentId}/grant` 之后）追加：

```markdown
| GET | `/api/admin/papers?subjectId=&year=&gradeBand=&keyword=&page=&pageSize=` | **试卷列表**（2026-11-09）。全部参数可选；`gradeBand` 枚举 `primary/junior/senior`，`page` 默认 1、`pageSize` 默认 20（1–100），`keyword` 按标题 LIKE（`%`/`_`/`\` 已转义）。返回 `{items: [{id, subjectId, subjectName, title, grade, gradeBand, semester, year, district, examType, sourceKey, questionCount, sessionCount, createdAt}], total, page, pageSize}`；`questionCount` 是 `paper_questions` 真实关联数（非 `exam_papers.question_count` 冗余列） | MVP |
| GET | `/api/admin/papers/{id}/delete-preview` | **删除影响面预览**（只读，不加锁）：卷不存在 404/1002。返回 `{paperId, title, subjectName, questionCount, sharedCount, exclusiveCount, deletableCount, retainedCount, sessionCount, answerCount}`。`deletableCount` = 独占且未被 7 张 RESTRICT 表（main_error_books/aux_error_books/answers/exam_answers/variation_questions/special_answer_records/remediation_set_items）引用；`retainedCount` = 独占但被引用（删除时保留） | MVP |
| DELETE | `/api/admin/papers/{id}` | **删除套卷**（2026-11-09，单事务）：删该卷 `exam_sessions`（级联 `exam_answers`）→ 删可删独占题（级联 `paper_questions`/`question_knowledge_points` 等）→ 删 `exam_papers`。共享题只解除关联；被学生数据引用的独占题保留成孤儿题。卷不存在 404/1002；并发外键冲突 409/4201。返回 `{paperId, deletedQuestions, retainedQuestions, deletedSessions, deletedAnswers}`。**不可恢复** | MVP |
```

- [ ] **Step 2: openapi.yaml 加 3 个路径**

插在 `# Admin（管理员中枢，全部 @Roles('admin')）` 段的 `/admin/models` 之前：

```yaml
  /admin/papers:
    get:
      tags: [Admin]
      summary: 试卷列表（分页，可筛选）
      operationId: listAdminPapers
      parameters:
        - { name: subjectId, in: query, schema: { type: integer, minimum: 1 } }
        - { name: year, in: query, schema: { type: integer, minimum: 2000, maximum: 2100 } }
        - { name: gradeBand, in: query, schema: { type: string, enum: [primary, junior, senior] } }
        - { name: keyword, in: query, schema: { type: string, maxLength: 50 } }
        - { name: page, in: query, schema: { type: integer, minimum: 1, default: 1 } }
        - { name: pageSize, in: query, schema: { type: integer, minimum: 1, maximum: 100, default: 20 } }
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/AdminPaperListResult'
  /admin/papers/{id}/delete-preview:
    get:
      tags: [Admin]
      summary: 删除试卷前的影响面预览
      operationId: previewAdminPaperDelete
      parameters:
        - { name: id, in: path, required: true, schema: { type: integer, minimum: 1 } }
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/AdminPaperDeletePreview'
        '404':
          description: 试卷不存在（code=1002）
  /admin/papers/{id}:
    delete:
      tags: [Admin]
      summary: 删除套卷（独占题 + 考试会话 + 作答，单事务）
      operationId: deleteAdminPaper
      parameters:
        - { name: id, in: path, required: true, schema: { type: integer, minimum: 1 } }
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/AdminPaperDeleteResult'
        '404':
          description: 试卷不存在（code=1002）
        '409':
          description: 并发外键冲突，请刷新后重试（code=4201）
```

- [ ] **Step 3: openapi.yaml 加 4 个 schema**

在 `components.schemas` 里（挨着 `AdminModelItemList` 即可）追加：

```yaml
    AdminPaperItem:
      type: object
      required: [id, subjectId, subjectName, title, questionCount, sessionCount, createdAt]
      properties:
        id: { type: integer }
        subjectId: { type: integer }
        subjectName: { type: string }
        title: { type: string }
        grade: { type: string, nullable: true }
        gradeBand: { type: string, nullable: true }
        semester: { type: string, nullable: true }
        year: { type: integer, nullable: true }
        district: { type: string, nullable: true }
        examType: { type: string, nullable: true }
        sourceKey: { type: string }
        questionCount: { type: integer }
        sessionCount: { type: integer }
        createdAt: { type: string, format: date-time }
    AdminPaperListResult:
      type: object
      required: [items, total, page, pageSize]
      properties:
        items:
          type: array
          items: { $ref: '#/components/schemas/AdminPaperItem' }
        total: { type: integer }
        page: { type: integer }
        pageSize: { type: integer }
    AdminPaperDeletePreview:
      type: object
      required: [paperId, title, subjectName, questionCount, sharedCount, exclusiveCount, deletableCount, retainedCount, sessionCount, answerCount]
      properties:
        paperId: { type: integer }
        title: { type: string }
        subjectName: { type: string }
        questionCount: { type: integer }
        sharedCount: { type: integer }
        exclusiveCount: { type: integer }
        deletableCount: { type: integer }
        retainedCount: { type: integer }
        sessionCount: { type: integer }
        answerCount: { type: integer }
    AdminPaperDeleteResult:
      type: object
      required: [paperId, deletedQuestions, retainedQuestions, deletedSessions, deletedAnswers]
      properties:
        paperId: { type: integer }
        deletedQuestions: { type: integer }
        retainedQuestions: { type: integer }
        deletedSessions: { type: integer }
        deletedAnswers: { type: integer }
```

- [ ] **Step 4: changelog 追加**

`docs/ai-core-changelog.md` 顶部（按现有倒序格式）加一条：

```markdown
## 2026-11-09 管理端「试卷管理」删除套卷

- 新增 `GET /api/admin/papers`、`GET /api/admin/papers/{id}/delete-preview`、`DELETE /api/admin/papers/{id}`（admin）。
- 删除规则：只删该卷独占题；共享题仅解除关联；独占题被 7 张 RESTRICT 表引用则保留并计数；该卷考试会话 + 逐题作答一并删除；单事务。
- 前端 `/admin/papers` 页面 + 侧栏「试卷管理」。
- spec：`docs/superpowers/specs/2026-11-09-admin-paper-delete-design.md`。
```

- [ ] **Step 5: 全量校验**

```bash
cd apps/server && npm test && npm run build
cd ../web && npm test && npm run lint && npm run build
```

Expected: 全部通过（server 2428+ 用例、web 1517+ 用例）。

- [ ] **Step 6: 手工冒烟（需 admin token）**

```bash
cd apps/server && node dist/main.js
# 另开终端
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"<admin用户名>","password":"<密码>"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["token"])')
curl -s "http://localhost:3000/api/admin/papers?page=1&pageSize=5" -H "Authorization: Bearer $TOKEN"
curl -s "http://localhost:3000/api/admin/papers/446/delete-preview" -H "Authorization: Bearer $TOKEN"
```

Expected：列表返回分页数据；446 已在前一次手工清理中删除，预览返回 `404 / code=1002`。

- [ ] **Step 7: 提交**

```bash
git add docs/API接口与数据流设计文档.md docs/api/openapi.yaml docs/ai-core-changelog.md
git commit -m "docs(admin): document paper management endpoints"
```

---

## Self-Review 记录

- **Spec 覆盖**：§5 删除规则 → Task 1（独占/共享/阻断）、Task 2（事务顺序）；§6 三端点 → Task 1/3/4；§7 前端 → Task 5/6；§8 测试 → 各任务 TDD 步骤；§9 文档 → Task 7。无遗漏。
- **类型一致性**：`AdminPaperFilters`（repo）与 `AdminPaperQuery`（service）字段相同、`page/pageSize` 必填；前端 `AdminPaperDeletePreview` 与后端响应字段逐一对应；`paperTitle` 只在 repo 内部出现，service 不透出。
- **占位符扫描**：无 TBD/TODO；手工冒烟的用户名/密码用尖括号占位属“必须由人输入”的例外。
- **已知风险**：无。Task 5 先建页面占位文件，路由 import 在 Task 6 前也能编译；Task 6 会覆盖该文件。
