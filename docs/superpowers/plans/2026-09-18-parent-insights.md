# 家长端「看得见」批 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把家长端的仪表盘、学情报告、错题查看、AI 对话回放四页从 `Placeholder` 落地为真实页，后端新增 6 个只读端点。

**Architecture:** 后端新建 `apps/server/src/modules/parent-insights/`（与 `modules/points/` 同范式）：1 个 controller 挂 6 个端点、4 个领域 service、1 个聚合仓储。归属校验一律复用 `ParentService.requireOwnedStudent`，进度复用 `ProgressService.getStarMap`。前端新增 4 个页面 + 6 个 api 方法 + recharts 图表薄封装。

**Tech Stack:** Nest 10 + TS ESM（import 路径带 `.js`）+ Vitest + mysql2/promise；React 18 + Vite + Tailwind + Zustand + Vitest + @testing-library/react + recharts（新增）。

**设计文档：** `docs/superpowers/specs/2026-09-18-parent-insights-design.md`

## Global Constraints

- **只读**：本批不写任何业务表、不改学生端行为、不动既有门禁。
- **归属校验**：除 `GET /api/parent/dashboard` 外，每个 handler **第一行**必须 `await this.parentService.requireOwnedStudent(user.sub, studentId)`。`chat-logs/:dialogueId` 还要二次校验 `dialogue.student_id === studentId`。
- **不改既有仓储**：`main-error-books.repo.ts` 等共享 repo 一行不动（它们正被训练轨调用）。所有家长侧聚合 SQL 进新文件 `parent-insights.repo.ts`。
- **controller 不手工包 `{code, message, data}`**：全局 `ResponseInterceptor` 统一包，直接 `return service.xxx()`。
- **入参校验**：不要用裸 `Schema.parse()`（抛出的 `ZodError` 不是 `HttpException`，会被全局 filter 映射成 500/5000）。query 用 `parsePositiveInt`，body 用 `safeParse` + `BadRequestException({ code: 1001 })`。
- **分页**：`pageSize` 服务端固定 20（前端不传）；`page` 用 `parsePositiveInt(page, 'page', DEFAULT_PAGE)`，非法 → 400/1001，**不静默回落**。带 `LIMIT ?` 的 SQL 必须用 `pool.query`（客户端转义），用 `execute` 会报 `Incorrect arguments to mysqld_stmt_execute`。
- **正确率口径**：排除 `method IN ('unanswered','self_assess')`；`exam_answers` 排除 `is_correct IS NULL`。`answered = 0` 时 `rate = null`（不是 0）。
- **错误码**：1002 = 学生不存在；1005 = 无权操作该学生；1001 = 入参校验失败。抛出方式 `new NotFoundException({ code: 1002, message: '学生不存在' })`，**本仓没有自定义异常类**。
- **前端组件改动必须补渲染测试**；多用例文件必须自己写 `afterEach(() => cleanup())`（`vitest.config.ts` 里 `globals: false`）。
- **UI**：不用 emoji、不用装饰元素（无渐变填充 / 无雷达图网格 / 不用饼图）、图标必须线性 SVG、配色只用 CSS 变量。
- **图表取色**：家长主题变量定义在 `[data-theme="parent"]` 容器上、**不在 `:root`** —— 必须从 `document.querySelector('[data-theme="parent"]')` 读；从 `documentElement` 读到的是学生端橙色 `#ff6b35`。
- 提交信息用中文，格式 `feat(parent-insights): ...` / `refactor(...)` / `docs(...)`。

---

### Task 1: 仓储 — 已开始学科列表 + 活跃度聚合

**Files:**
- Create: `apps/server/src/database/repositories/parent-insights.repo.ts`
- Test: `apps/server/src/database/repositories/parent-insights.repo.test.ts`

**Interfaces:**
- Consumes: `@Inject('DATABASE_POOL')`（来自 `@Global()` 的 `DatabaseModule`，无需 import）
- Produces:
  - `class ParentInsightsRepository`，构造签名 `constructor(@Inject('DATABASE_POOL') private readonly pool: Pool)`
  - `listTrackedSubjectIds(studentId: number): Promise<number[]>`
  - `getActivitySummary(studentId: number, windowStart: Date): Promise<{ lastActiveAt: Date | null; activeDays: number }>`

- [ ] **Step 1: 写失败的测试**

创建 `apps/server/src/database/repositories/parent-insights.repo.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { ParentInsightsRepository } from './parent-insights.repo.js';

/**
 * mockPool 模拟 mysql2 的 pool 双返回形状：[rows, fields]。
 * SELECT 走 execute 或 query，两者都要给。
 */
const mockPool = (rows: any[] = [], insertId = 7) => ({
  execute: vi.fn().mockImplementation((sql: string) => {
    const trimmed = sql.trim();
    if (/^INSERT/i.test(trimmed)) {
      return Promise.resolve([{ insertId, affectedRows: 1 }, []]);
    }
    return Promise.resolve([rows, []]);
  }),
  query: vi.fn().mockResolvedValue([rows, []]),
});

describe('ParentInsightsRepository：已开始学科', () => {
  it('按 subject_id 升序返回去重后的学科 id（DISTINCT + ORDER BY 都钉住）', async () => {
    const pool = mockPool([{ subject_id: 1 }, { subject_id: 3 }]);
    const repo = new ParentInsightsRepository(pool as any);

    const result = await repo.listTrackedSubjectIds(9);

    expect(result).toEqual([1, 3]);
    const sql = pool.execute.mock.calls[0][0] as string;
    expect(sql).toContain('FROM progress');
    expect(sql).toContain('DISTINCT');
    expect(sql).toContain('ORDER BY subject_id');
    expect(pool.execute.mock.calls[0][1]).toEqual([9]);
  });

  it('只配了教材、还没开始学的学科不算「已开始」（status = not_started 被排除）', async () => {
    const pool = mockPool([]);
    const repo = new ParentInsightsRepository(pool as any);

    await repo.listTrackedSubjectIds(9);

    // 「有 progress 行」≠「已开始」：家长在「学习配置」里配教材就会建 not_started 行
    const sql = pool.execute.mock.calls[0][0] as string;
    expect(sql).toContain("status <> 'not_started'");
  });

  it('无 progress 行 → 空数组', async () => {
    const repo = new ParentInsightsRepository(mockPool([]) as any);
    expect(await repo.listTrackedSubjectIds(9)).toEqual([]);
  });
});

describe('ParentInsightsRepository：活跃度', () => {
  it('lastActiveAt 取全时段 MAX，activeDays 只数窗口内的天', async () => {
    const pool = mockPool([]);
    // 第一次 execute = lastActiveAt（全时段），第二次 = activeDays（窗口内）
    pool.execute
      .mockResolvedValueOnce([[{ last_active_at: new Date('2026-09-18T12:00:00Z') }], []])
      .mockResolvedValueOnce([[{ active_days: 3 }], []]);

    const repo = new ParentInsightsRepository(pool as any);
    const result = await repo.getActivitySummary(9, new Date('2026-09-12T00:00:00Z'));

    expect(result.lastActiveAt?.toISOString()).toBe('2026-09-18T12:00:00.000Z');
    expect(result.activeDays).toBe(3);

    const maxSql = pool.execute.mock.calls[0][0] as string;
    // 全时段查询**不带**时间条件（只有 4 个 student_id 参数）
    expect(pool.execute.mock.calls[0][1]).toEqual([9, 9, 9, 9]);
    expect(maxSql).toContain('practice_results');
    expect(maxSql).toContain('point_ledger');
    expect(maxSql).toContain('exam_sessions');
    expect(maxSql).toContain('ai_messages');

    const daysSql = pool.execute.mock.calls[1][0] as string;
    expect(daysSql).toContain('COUNT(DISTINCT DATE(ts))');
    // 窗口内查询：4 个 student_id + 4 个下界
    expect(pool.execute.mock.calls[1][1]).toHaveLength(8);
  });

  it('完全无记录 → lastActiveAt null、activeDays 0', async () => {
    const pool = mockPool([]);
    pool.execute
      .mockResolvedValueOnce([[{ last_active_at: null }], []])
      .mockResolvedValueOnce([[{ active_days: 0 }], []]);
    const repo = new ParentInsightsRepository(pool as any);

    const result = await repo.getActivitySummary(9, new Date('2026-09-12T00:00:00Z'));

    expect(result.lastActiveAt).toBeNull();
    expect(result.activeDays).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/database/repositories/parent-insights.repo.test.ts`
Expected: FAIL — `Failed to resolve import "./parent-insights.repo.js"`

- [ ] **Step 3: 实现**

创建 `apps/server/src/database/repositories/parent-insights.repo.ts`：

```ts
import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

/**
 * 家长端只读聚合仓储（spec `2026-09-18-parent-insights-design.md`）。
 *
 * 三条铁律（勿违背）：
 * 1. **只读**：本文件不出现 INSERT / UPDATE / DELETE。
 * 2. **既有的共享仓储一行不动**（如 `main-error-books.repo.ts` 正被训练轨调用），
 *    需要类似查询就在这里照抄写法自建。
 * 3. 带 `LIMIT ?` 的查询必须用 `pool.query`（客户端转义）：MySQL 对预处理语句的
 *    `LIMIT ?` 报 "Incorrect arguments to mysqld_stmt_execute"（见 point-ledger.repo.ts:148 的既有注释）。
 *    其余用 `execute`。
 *
 * 返回一律是**扁平行**，嵌套 DTO 由各 service 组装（与 `point-ledger.repo.ts` 同约定）。
 */
@Injectable()
export class ParentInsightsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /**
   * 该学生**已开始**的学科 id，升序。仪表盘只为这些学科出卡片。
   *
   * 判定是 `status <> 'not_started'`，**不是「有 progress 行」**：家长在「学习配置」里配教材
   * 就会为该学科建一行 `status='not_started'` 的 progress（`progress.repo.ts` 的 `createConfig`），
   * `applyConfig(reset=true)` 也会重置回该状态。只看行存在会让仪表盘为「只配过教材、没开始学」
   * 的学科渲染空卡片。
   *
   * 也不能用 `started_at IS NOT NULL`：真正开始学习的那条路径（`progress.repo.ts` 的 `create`）
   * 只写 `status='in_progress'`、不写 `started_at`，用它会把刚自动初始化的学科漏掉。
   */
  async listTrackedSubjectIds(studentId: number): Promise<number[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT DISTINCT subject_id FROM progress
       WHERE student_id = ? AND status <> 'not_started'
       ORDER BY subject_id`,
      [studentId],
    );
    return rows.map((r) => Number(r.subject_id));
  }

  /**
   * 活跃度（「学习时长」的代理指标，spec §2.2）。
   *
   * 「活跃」= 下列四张表任一在该时刻有记录。四条并集路径的理由：`point_ledger` 是唯一在
   * **所有**轨道任务完成时都写一行的表（含语文/英语专项），光靠它 + `practice_results` +
   * `exam_sessions` 会漏掉纯答疑活跃，故补 `ai_messages`。
   *
   * `lastActiveAt` 是**全时段** MAX、`activeDays` 只数 `windowStart` 之后——两者窗口不同，
   * 必须分两次查，合并成一个 SQL 会算错。
   */
  async getActivitySummary(
    studentId: number,
    windowStart: Date,
  ): Promise<{ lastActiveAt: Date | null; activeDays: number }> {
    const [maxRows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT MAX(ts) AS last_active_at FROM (
         SELECT judged_at AS ts FROM practice_results WHERE student_id = ?
         UNION ALL SELECT created_at AS ts FROM point_ledger WHERE student_id = ?
         UNION ALL SELECT submitted_at AS ts FROM exam_sessions
                   WHERE student_id = ? AND submitted_at IS NOT NULL
         UNION ALL SELECT m.created_at AS ts FROM ai_messages m
                   JOIN ai_dialogues d ON d.id = m.dialogue_id
                   WHERE d.student_id = ? AND m.deleted_at IS NULL
       ) t`,
      [studentId, studentId, studentId, studentId],
    );

    const [dayRows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT COUNT(DISTINCT DATE(ts)) AS active_days FROM (
         SELECT judged_at AS ts FROM practice_results WHERE student_id = ? AND judged_at >= ?
         UNION ALL SELECT created_at AS ts FROM point_ledger WHERE student_id = ? AND created_at >= ?
         UNION ALL SELECT submitted_at AS ts FROM exam_sessions
                   WHERE student_id = ? AND submitted_at IS NOT NULL AND submitted_at >= ?
         UNION ALL SELECT m.created_at AS ts FROM ai_messages m
                   JOIN ai_dialogues d ON d.id = m.dialogue_id
                   WHERE d.student_id = ? AND m.deleted_at IS NULL AND m.created_at >= ?
       ) t`,
      [studentId, windowStart, studentId, windowStart, studentId, windowStart, studentId, windowStart],
    );

    const raw = maxRows[0]?.last_active_at;
    return {
      lastActiveAt: raw ? new Date(raw as string | Date) : null,
      activeDays: Number(dayRows[0]?.active_days ?? 0),
    };
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/database/repositories/parent-insights.repo.test.ts`
Expected: PASS（本任务新增的用例全绿）

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/database/repositories/parent-insights.repo.ts apps/server/src/database/repositories/parent-insights.repo.test.ts
git commit -m "feat(parent-insights): 新增家长端聚合仓储（已开始学科 + 活跃度）"
```

---

### Task 2: 仓储 — 正确率 / 自评 / 考试场次

**Files:**
- Modify: `apps/server/src/database/repositories/parent-insights.repo.ts`
- Test: `apps/server/src/database/repositories/parent-insights.repo.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ParentInsightsRepository`
- Produces（在 `parent-insights.repo.ts` 顶部 `export` 这些行类型）:
  - `interface AccuracyRow { subjectId: number; answered: number; correct: number }`
  - `interface SelfAssessRow { subjectId: number; count: number; correctCount: number }`
  - `interface SubjectCountRow { subjectId: number; count: number }`
  - `getAccuracyBySubject(studentId: number, from?: Date, to?: Date): Promise<AccuracyRow[]>`
  - `getSelfAssessBySubject(studentId: number, from?: Date, to?: Date): Promise<SelfAssessRow[]>`
  - `getExamCounts(studentId: number, from?: Date, to?: Date): Promise<SubjectCountRow[]>`

- [ ] **Step 1: 写失败的测试**

追加到 `parent-insights.repo.test.ts`：

```ts
describe('ParentInsightsRepository：正确率（口径钉子）', () => {
  it('合并 practice_results 与 exam_answers；排除 unanswered/self_assess 与 is_correct IS NULL', async () => {
    const pool = mockPool([]);
    pool.execute.mockResolvedValueOnce([
      [
        { subject_id: 1, answered: 42, correct: 31 },
        { subject_id: 2, answered: 10, correct: 4 },
      ],
      [],
    ]);
    const repo = new ParentInsightsRepository(pool as any);

    const result = await repo.getAccuracyBySubject(9);

    expect(result).toEqual([
      { subjectId: 1, answered: 42, correct: 31 },
      { subjectId: 2, answered: 10, correct: 4 },
    ]);

    const sql = pool.execute.mock.calls[0][0] as string;
    expect(sql).toContain("method IN ('exact','ai')");
    expect(sql).toContain("es.status = 'submitted'");
    expect(sql).toContain('ea.is_correct IS NOT NULL');
    // 不传窗口 → 无时间条件，参数只有两个 studentId
    expect(pool.execute.mock.calls[0][1]).toEqual([9, 9]);
  });

  it('传窗口 → 两个源各自带 judged_at 半开区间', async () => {
    const pool = mockPool([]);
    const from = new Date('2026-09-12T00:00:00Z');
    const to = new Date('2026-09-19T00:00:00Z');
    const repo = new ParentInsightsRepository(pool as any);

    await repo.getAccuracyBySubject(9, from, to);

    const sql = pool.execute.mock.calls[0][0] as string;
    // 两个源各出现一次窗口条件（practice 的 judged_at、exam 的 ea.judged_at）
    expect(sql.match(/judged_at >= \?/g)).toHaveLength(2);
    expect(sql).toContain('ea.judged_at < ?');
    expect(pool.execute.mock.calls[0][1]).toEqual([9, from, to, 9, from, to]);
  });

  it('answered 为 0 时原样返回（rate 的 null 判定在 util）', async () => {
    const pool = mockPool([{ subject_id: 1, answered: 0, correct: 0 }]);
    const repo = new ParentInsightsRepository(pool as any);
    expect(await repo.getAccuracyBySubject(9)).toEqual([
      { subjectId: 1, answered: 0, correct: 0 },
    ]);
  });
});

describe('ParentInsightsRepository：自评与考试场次', () => {
  it('自评全部计入 count、只有 correct 计入 correctCount', async () => {
    const pool = mockPool([{ subject_id: 1, count: 5, correct_count: 3 }]);
    const repo = new ParentInsightsRepository(pool as any);

    const result = await repo.getSelfAssessBySubject(9);

    expect(result).toEqual([{ subjectId: 1, count: 5, correctCount: 3 }]);
    const sql = pool.execute.mock.calls[0][0] as string;
    expect(sql).toContain('FROM question_self_assessments');
    expect(sql).toContain("assessment = 'correct'");
  });

  it('考试场次按学科计数，只算已交卷', async () => {
    const pool = mockPool([{ subject_id: 1, count: 4 }]);
    const repo = new ParentInsightsRepository(pool as any);

    const result = await repo.getExamCounts(9);

    expect(result).toEqual([{ subjectId: 1, count: 4 }]);
    const sql = pool.execute.mock.calls[0][0] as string;
    expect(sql).toContain("status = 'submitted'");
    expect(sql).toContain('GROUP BY subject_id');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/database/repositories/parent-insights.repo.test.ts`
Expected: FAIL — `repo.getAccuracyBySubject is not a function`

- [ ] **Step 3: 实现**

在 `parent-insights.repo.ts` 的 import 之后加行类型：

```ts
/** 按学科的答题量与答对数（已排除空答案与学生自评）。 */
export interface AccuracyRow {
  subjectId: number;
  answered: number;
  correct: number;
}

/** 按学科的学生自评统计（主观题，**不进正确率**，单独出数）。 */
export interface SelfAssessRow {
  subjectId: number;
  count: number;
  correctCount: number;
}

/** 按学科的计数行（考试场次等）。 */
export interface SubjectCountRow {
  subjectId: number;
  count: number;
}
```

在类里追加三个方法：

```ts
  /**
   * 正确率（spec §4.3，**本批唯一实现，勿分散**）：`practice_results` + `exam_answers` 两源合并。
   *
   * 口径（最容易被「统一」掉的地方，测试钉死）：
   * - `practice_results` 排除 `method IN ('unanswered','self_assess')`——空答案守卫与学生自评
   *   都会落行，朴素 `AVG(is_correct)` 会把「没答」算成错。
   * - `exam_answers` 排除 `is_correct IS NULL`（主观题 self_assess 模式落 NULL = 不判对错）。
   *
   * 窗口可选：`from`/`to` 都不传 = 累计（仪表盘）；都传 = 窗口（报告页）。**一套 SQL 按参数
   * 拼条件**，不写两份，否则口径必然分叉。`to` 是半开区间上界（service 传「末日 + 1 天」）。
   */
  async getAccuracyBySubject(studentId: number, from?: Date, to?: Date): Promise<AccuracyRow[]> {
    const windowed = from !== undefined && to !== undefined;
    const practiceWindow = windowed ? ' AND judged_at >= ? AND judged_at < ?' : '';
    const examWindow = windowed ? ' AND ea.judged_at >= ? AND ea.judged_at < ?' : '';
    const params: unknown[] = windowed
      ? [studentId, from, to, studentId, from, to]
      : [studentId, studentId];

    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT subject_id, SUM(total) AS answered, SUM(correct) AS correct FROM (
         SELECT subject_id, SUM(is_correct = 1) AS correct, COUNT(*) AS total
         FROM practice_results
         WHERE student_id = ? AND method IN ('exact','ai')${practiceWindow}
         GROUP BY subject_id
         UNION ALL
         SELECT es.subject_id, SUM(ea.is_correct = 1) AS correct, COUNT(*) AS total
         FROM exam_sessions es JOIN exam_answers ea ON ea.session_id = es.id
         WHERE es.student_id = ? AND es.status = 'submitted' AND ea.is_correct IS NOT NULL${examWindow}
         GROUP BY es.subject_id
       ) t
       GROUP BY subject_id
       ORDER BY subject_id`,
      params,
    );
    return rows.map((r) => ({
      subjectId: Number(r.subject_id),
      answered: Number(r.answered ?? 0),
      correct: Number(r.correct ?? 0),
    }));
  }

  /** 学生自评（主观题）按学科统计。`assessment = 'correct'` 才计入 correctCount。 */
  async getSelfAssessBySubject(
    studentId: number,
    from?: Date,
    to?: Date,
  ): Promise<SelfAssessRow[]> {
    const windowed = from !== undefined && to !== undefined;
    const window = windowed ? ' AND qsa.created_at >= ? AND qsa.created_at < ?' : '';
    const params: unknown[] = windowed ? [studentId, from, to] : [studentId];

    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT q.subject_id,
              COUNT(*) AS count,
              SUM(qsa.assessment = 'correct') AS correct_count
       FROM question_self_assessments qsa
       JOIN questions q ON q.id = qsa.question_id
       WHERE qsa.student_id = ?${window}
       GROUP BY q.subject_id
       ORDER BY q.subject_id`,
      params,
    );
    return rows.map((r) => ({
      subjectId: Number(r.subject_id),
      count: Number(r.count ?? 0),
      correctCount: Number(r.correct_count ?? 0),
    }));
  }

  /** 已交卷的考试场次按学科计数。窗口按 `submitted_at`。 */
  async getExamCounts(studentId: number, from?: Date, to?: Date): Promise<SubjectCountRow[]> {
    const windowed = from !== undefined && to !== undefined;
    const window = windowed ? ' AND submitted_at >= ? AND submitted_at < ?' : '';
    const params: unknown[] = windowed ? [studentId, from, to] : [studentId];

    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT subject_id, COUNT(*) AS count
       FROM exam_sessions
       WHERE student_id = ? AND status = 'submitted'${window}
       GROUP BY subject_id
       ORDER BY subject_id`,
      params,
    );
    return rows.map((r) => ({ subjectId: Number(r.subject_id), count: Number(r.count ?? 0) }));
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/database/repositories/parent-insights.repo.test.ts`
Expected: PASS（本任务新增的用例全绿）

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/database/repositories/parent-insights.repo.ts apps/server/src/database/repositories/parent-insights.repo.test.ts
git commit -m "feat(parent-insights): 正确率合并口径 + 自评 + 考试场次聚合"
```

---

### Task 3: 仓储 — 错题统计与薄弱点

**Files:**
- Modify: `apps/server/src/database/repositories/parent-insights.repo.ts`
- Test: `apps/server/src/database/repositories/parent-insights.repo.test.ts`

**Interfaces:**
- Consumes: Task 1/2 的 `ParentInsightsRepository`
- Produces:
  - `interface ErrorBookSummaryRow { subjectId: number; uncleared: number; total: number }`
  - `interface WeakPointRow { knowledgePointId: number; name: string; unclearedCount: number; totalWrongCount: number }`
  - `getErrorBookSummary(studentId: number): Promise<ErrorBookSummaryRow[]>`
  - `getErrorDateCounts(studentId: number, from: Date, to: Date): Promise<{ added: number; cleared: number }>`
  - `getWeakPoints(studentId: number, limit: number): Promise<WeakPointRow[]>`
  - `countUncoveredUnclearedErrors(studentId: number): Promise<number>`

- [ ] **Step 1: 写失败的测试**

追加到 `parent-insights.repo.test.ts`：

```ts
describe('ParentInsightsRepository：错题统计', () => {
  it('按学科出「未清零 / 总数」两个数（累计，不按时间窗）', async () => {
    const pool = mockPool([{ subject_id: 1, uncleared: 12, total: 20 }]);
    const repo = new ParentInsightsRepository(pool as any);

    const result = await repo.getErrorBookSummary(9);

    expect(result).toEqual([{ subjectId: 1, uncleared: 12, total: 20 }]);
    const sql = pool.execute.mock.calls[0][0] as string;
    expect(sql).toContain('FROM main_error_books');
    expect(sql).toContain('SUM(is_cleared = 0)');
  });

  it('新增/清零各按 created_at / cleared_at 落窗', async () => {
    const pool = mockPool([]);
    pool.execute
      .mockResolvedValueOnce([[{ added: 6 }], []])
      .mockResolvedValueOnce([[{ cleared: 4 }], []]);
    const from = new Date('2026-09-12T00:00:00Z');
    const to = new Date('2026-09-19T00:00:00Z');
    const repo = new ParentInsightsRepository(pool as any);

    const result = await repo.getErrorDateCounts(9, from, to);

    expect(result).toEqual({ added: 6, cleared: 4 });
    expect(pool.execute.mock.calls[0][0]).toContain('created_at >= ?');
    expect(pool.execute.mock.calls[1][0]).toContain('cleared_at >= ?');
    expect(pool.execute.mock.calls[1][0]).toContain('is_cleared = 1');
  });

  it('薄弱点按未清零数降序、按 limit 截断（LIMIT 走 query，不走 execute）', async () => {
    const pool = mockPool([
      { knowledge_point_id: 42, name: '分数加减', uncleared_count: 3, total_wrong_count: 5 },
    ]);
    const repo = new ParentInsightsRepository(pool as any);

    const result = await repo.getWeakPoints(9, 10);

    expect(result).toEqual([
      { knowledgePointId: 42, name: '分数加减', unclearedCount: 3, totalWrongCount: 5 },
    ]);
    const sql = pool.query.mock.calls[0][0] as string;
    expect(sql).toContain('JOIN question_knowledge_points');
    expect(sql).toContain('JOIN knowledge_points');
    expect(sql).toContain('ORDER BY uncleared_count DESC');
    expect(pool.query.mock.calls[0][1]).toEqual([9, 10]);
    // LIMIT 场景绝不能用 execute（服务端预处理会报 mysqld_stmt_execute）
    expect(pool.execute).not.toHaveBeenCalled();
  });

  it('未标注知识点的未清零错题单独计数', async () => {
    const pool = mockPool([{ uncovered: 8 }]);
    const repo = new ParentInsightsRepository(pool as any);

    expect(await repo.countUncoveredUnclearedErrors(9)).toBe(8);
    const sql = pool.execute.mock.calls[0][0] as string;
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('is_cleared = 0');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/database/repositories/parent-insights.repo.test.ts`
Expected: FAIL — `repo.getErrorBookSummary is not a function`

- [ ] **Step 3: 实现**

追加行类型：

```ts
/** 按学科的错题本统计（累计）。 */
export interface ErrorBookSummaryRow {
  subjectId: number;
  uncleared: number;
  total: number;
}

/**
 * 薄弱点（**错题数代理**，不是掌握度）。
 *
 * 实测只有约 40% 的错题能映射到知识点（`question_knowledge_points` 由 migration 灌入，
 * 覆盖不完整），所以必须配合 `countUncoveredUnclearedErrors` 一起展示，否则家长会以为
 * 「只有这些问题」。真掌握度需要写 `student_knowledge_mastery`，不属本批。
 */
export interface WeakPointRow {
  knowledgePointId: number;
  name: string;
  unclearedCount: number;
  totalWrongCount: number;
}
```

追加方法：

```ts
  /** 错题本「未清零 / 总数」按学科统计（累计，不按时间窗）。 */
  async getErrorBookSummary(studentId: number): Promise<ErrorBookSummaryRow[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT subject_id,
              SUM(is_cleared = 0) AS uncleared,
              COUNT(*) AS total
       FROM main_error_books
       WHERE student_id = ?
       GROUP BY subject_id
       ORDER BY subject_id`,
      [studentId],
    );
    return rows.map((r) => ({
      subjectId: Number(r.subject_id),
      uncleared: Number(r.uncleared ?? 0),
      total: Number(r.total ?? 0),
    }));
  }

  /** 窗口内「新增错题」与「清零错题」条数（报告页 stats）。 */
  async getErrorDateCounts(
    studentId: number,
    from: Date,
    to: Date,
  ): Promise<{ added: number; cleared: number }> {
    const [addedRows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS added FROM main_error_books
       WHERE student_id = ? AND created_at >= ? AND created_at < ?`,
      [studentId, from, to],
    );
    const [clearedRows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS cleared FROM main_error_books
       WHERE student_id = ? AND is_cleared = 1 AND cleared_at >= ? AND cleared_at < ?`,
      [studentId, from, to],
    );
    return {
      added: Number(addedRows[0]?.added ?? 0),
      cleared: Number(clearedRows[0]?.cleared ?? 0),
    };
  }

  /**
   * 薄弱点 Top N：按「未清零错题数」聚合知识点。
   *
   * 统计**全部未清零错题**（不按时间窗）——「现在还剩哪些没清」才是家长关心的。
   * 只覆盖 `question_id` 非空且已绑 KP 的错题，未覆盖部分由
   * `countUncoveredUnclearedErrors` 兜住。
   */
  async getWeakPoints(studentId: number, limit: number): Promise<WeakPointRow[]> {
    // LIMIT ? 必须用 pool.query（客户端转义），用 execute 会被 MySQL 拒绝
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT kp.id AS knowledge_point_id,
              kp.name,
              SUM(meb.is_cleared = 0) AS uncleared_count,
              COUNT(*) AS total_wrong_count
       FROM main_error_books meb
       JOIN question_knowledge_points qkp ON qkp.question_id = meb.question_id
       JOIN knowledge_points kp ON kp.id = qkp.knowledge_point_id
       WHERE meb.student_id = ?
       GROUP BY kp.id, kp.name
       ORDER BY uncleared_count DESC, total_wrong_count DESC, kp.id ASC
       LIMIT ?`,
      [studentId, limit],
    );
    return rows.map((r) => ({
      knowledgePointId: Number(r.knowledge_point_id),
      name: String(r.name ?? ''),
      unclearedCount: Number(r.uncleared_count ?? 0),
      totalWrongCount: Number(r.total_wrong_count ?? 0),
    }));
  }

  /**
   * 未清零错题里**映射不到任何知识点**的条数（`question_id` 为 NULL，或该题未绑 KP）。
   *
   * 与 `getWeakPoints` 是同一口径的补集，UI 必须显式展示这个数（spec §9.1）。
   */
  async countUncoveredUnclearedErrors(studentId: number): Promise<number> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS uncovered
       FROM main_error_books meb
       WHERE meb.student_id = ? AND meb.is_cleared = 0
         AND NOT EXISTS (
           SELECT 1 FROM question_knowledge_points qkp WHERE qkp.question_id = meb.question_id
         )`,
      [studentId],
    );
    return Number(rows[0]?.uncovered ?? 0);
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/database/repositories/parent-insights.repo.test.ts`
Expected: PASS（本任务新增的用例全绿）

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/database/repositories/parent-insights.repo.ts apps/server/src/database/repositories/parent-insights.repo.test.ts
git commit -m "feat(parent-insights): 错题统计与薄弱点聚合（含未标注知识点计数）"
```

---

### Task 4: 仓储 — 按天趋势 + 考试列表

**Files:**
- Modify: `apps/server/src/database/repositories/parent-insights.repo.ts`
- Test: `apps/server/src/database/repositories/parent-insights.repo.test.ts`

**Interfaces:**
- Consumes: Task 1–3 的 `ParentInsightsRepository`
- Produces:
  - `interface TrendRow { date: string; answered: number; correct: number }`
  - `interface ExamSummaryRow { sessionId: number; paperTitle: string; subjectId: number; submittedAt: Date; correctCount: number; objectiveCount: number }`
  - `getAccuracyTrend(studentId: number, from: Date, to: Date): Promise<TrendRow[]>`
  - `listSubmittedExams(studentId: number, limit: number): Promise<ExamSummaryRow[]>`

- [ ] **Step 1: 写失败的测试**

追加到 `parent-insights.repo.test.ts`：

```ts
describe('ParentInsightsRepository：趋势与考试列表', () => {
  it('趋势按日聚合，只含有记录的天（不补零，由前端铺 X 轴）', async () => {
    const pool = mockPool([
      { date: '2026-09-15', answered: 10, correct: 7 },
      { date: '2026-09-17', answered: 4, correct: 4 },
    ]);
    const repo = new ParentInsightsRepository(pool as any);
    const from = new Date('2026-09-12T00:00:00Z');
    const to = new Date('2026-09-19T00:00:00Z');

    const result = await repo.getAccuracyTrend(9, from, to);

    expect(result).toEqual([
      { date: '2026-09-15', answered: 10, correct: 7 },
      { date: '2026-09-17', answered: 4, correct: 4 },
    ]);
    const sql = pool.execute.mock.calls[0][0] as string;
    expect(sql).toContain('DATE(judged_at)');
    // 与 getAccuracyBySubject 同口径（两源合并、排除未答/自评/未判）
    expect(sql).toContain("method IN ('exact','ai')");
    expect(sql).toContain('ea.is_correct IS NOT NULL');
    expect(sql).toContain('ORDER BY date ASC');
  });

  it('MySQL 返回 Date 时按**本地**日期拼（toISOString 会在 UTC+8 下切到前一天）', async () => {
    const pool = mockPool([
      // mysql2 对 DATE 列返回本地零点的 Date：2026-09-15 本地零点
      { date: new Date(2026, 8, 15), answered: 10, correct: 7 },
    ]);
    const repo = new ParentInsightsRepository(pool as any);

    const result = await repo.getAccuracyTrend(9, new Date(2026, 8, 12), new Date(2026, 8, 19));

    expect(result[0].date).toBe('2026-09-15');
  });

  it('考试列表只取已交卷、按交卷时间倒序、带卷名与客观题数', async () => {
    const pool = mockPool([
      {
        session_id: 7,
        paper_title: '2025 学年七年级上期中',
        subject_id: 1,
        submitted_at: new Date('2026-09-16T19:20:00Z'),
        correct_count: 18,
        objective_count: 22,
      },
    ]);
    const repo = new ParentInsightsRepository(pool as any);

    const result = await repo.listSubmittedExams(9, 20);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      sessionId: 7,
      paperTitle: '2025 学年七年级上期中',
      subjectId: 1,
      correctCount: 18,
      objectiveCount: 22,
    });
    const sql = pool.query.mock.calls[0][0] as string;
    expect(sql).toContain('JOIN exam_papers');
    expect(sql).toContain("status = 'submitted'");
    expect(sql).toContain('ORDER BY es.submitted_at DESC');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/database/repositories/parent-insights.repo.test.ts`
Expected: FAIL — `repo.getAccuracyTrend is not a function`

- [ ] **Step 3: 实现**

追加行类型：

```ts
/** 按天的答题量与答对数（报告页折线）。只含有记录的天。 */
export interface TrendRow {
  date: string;
  answered: number;
  correct: number;
}

/** 已交卷考试的摘要行（报告页考试记录）。客观题数 = 已判对错的题数。 */
export interface ExamSummaryRow {
  sessionId: number;
  paperTitle: string;
  subjectId: number;
  submittedAt: Date;
  correctCount: number;
  objectiveCount: number;
}
```

追加方法：

```ts
  /**
   * 按天趋势（口径与 `getAccuracyBySubject` 完全一致，只是 GROUP BY 换成日期）。
   * 只返回有记录的天；窗口内没做过的天不补零——前端按窗口铺 X 轴。
   */
  async getAccuracyTrend(studentId: number, from: Date, to: Date): Promise<TrendRow[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT date, SUM(total) AS answered, SUM(correct) AS correct FROM (
         SELECT DATE(judged_at) AS date, SUM(is_correct = 1) AS correct, COUNT(*) AS total
         FROM practice_results
         WHERE student_id = ? AND method IN ('exact','ai')
           AND judged_at >= ? AND judged_at < ?
         GROUP BY DATE(judged_at)
         UNION ALL
         SELECT DATE(ea.judged_at) AS date, SUM(ea.is_correct = 1) AS correct, COUNT(*) AS total
         FROM exam_sessions es JOIN exam_answers ea ON ea.session_id = es.id
         WHERE es.student_id = ? AND es.status = 'submitted' AND ea.is_correct IS NOT NULL
           AND ea.judged_at >= ? AND ea.judged_at < ?
         GROUP BY DATE(ea.judged_at)
       ) t
       GROUP BY date
       ORDER BY date ASC`,
      [studentId, from, to, studentId, from, to],
    );
    return rows.map((r) => ({
      // `DATE(x)` 经 mysql2 回来的是**本地零点**的 Date。UTC+8 下 `toISOString()` 会把它切成
      // 前一天（2026-09-15 本地零点 = 2026-09-14T16:00Z），整条折线的 X 轴会集体前移一天。
      // 必须按本地字段拼 —— 与 `modules/parent-insights/window.util.ts` 的 `toDayString` 同口径。
      date: typeof r.date === 'string' ? r.date : toLocalDayString(new Date(r.date as Date)),
      answered: Number(r.answered ?? 0),
      correct: Number(r.correct ?? 0),
    }));
  }

  /**
   * 已交卷考试列表（不限时间窗，让家长看到全部考试史）。
   * `objectiveCount` = 已判对错的题数（`exam_answers.is_correct IS NOT NULL`），
   * 与 `ExamsService.summarize` 口径一致——主观题不参与正确率。
   */
  async listSubmittedExams(studentId: number, limit: number): Promise<ExamSummaryRow[]> {
    // LIMIT ? 必须用 pool.query（客户端转义）
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT es.id AS session_id, ep.title AS paper_title, es.subject_id, es.submitted_at,
              SUM(ea.is_correct = 1) AS correct_count,
              SUM(ea.is_correct IS NOT NULL) AS objective_count
       FROM exam_sessions es
       JOIN exam_papers ep ON ep.id = es.paper_id
       LEFT JOIN exam_answers ea ON ea.session_id = es.id
       WHERE es.student_id = ? AND es.status = 'submitted'
       GROUP BY es.id, ep.title, es.subject_id, es.submitted_at
       ORDER BY es.submitted_at DESC, es.id DESC
       LIMIT ?`,
      [studentId, limit],
    );
    return rows.map((r) => ({
      sessionId: Number(r.session_id),
      paperTitle: String(r.paper_title ?? ''),
      subjectId: Number(r.subject_id),
      submittedAt: new Date(r.submitted_at as Date),
      correctCount: Number(r.correct_count ?? 0),
      objectiveCount: Number(r.objective_count ?? 0),
    }));
  }
```

> **`date` 的映射是本任务最容易踩的坑**：`DATE(judged_at)` 经 mysql2（`connection.ts` 未设 `dateStrings`/`timezone`）
> 回来是**本地零点**的 `Date` 对象。若用 `toISOString().slice(0,10)`，UTC+8 下会得到**前一天**，
> 整条折线 X 轴集体前移一天。必须在仓储文件里加一个模块级 helper 按本地字段拼：

```ts
/** 本地时区的 `YYYY-MM-DD`。**不要用 `toISOString()`**：那会按 UTC 切，跨时区差一天。 */
function toLocalDayString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
```

> 为什么不复用 `modules/parent-insights/window.util.ts` 的 `toDayString`：那是**模块层**的工具，
> 从 `database/repositories/` 反向 import 模块层是分层倒挂。两处各自保留一份 4 行实现是有意的，
> **不要**为了 DRY 把它们抽成跨层共享。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/database/repositories/parent-insights.repo.test.ts`
Expected: PASS（本任务新增的用例全绿）

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/database/repositories/parent-insights.repo.ts apps/server/src/database/repositories/parent-insights.repo.test.ts
git commit -m "feat(parent-insights): 按天趋势与考试记录聚合"
```

---

### Task 5: 仓储 — 错题列表（筛选 + 分页）

**Files:**
- Modify: `apps/server/src/database/repositories/parent-insights.repo.ts`
- Test: `apps/server/src/database/repositories/parent-insights.repo.test.ts`

**Interfaces:**
- Consumes: Task 1–4 的 `ParentInsightsRepository`
- Produces:
  - `interface ParentErrorFilters { subjectId?: number; track?: 'main' | 'aux'; source?: string; cleared?: 'uncleared' | 'cleared'; from?: string; to?: string }`
  - `interface ParentErrorRow { id: number; questionId: number | null; subjectId: number; source: string; level: number; isCleared: boolean; wrongAnswerText: string | null; createdAt: Date; clearedAt: Date | null; questionContent: string | null; questionType: string | null; questionDifficulty: number | null }`
  - `interface ErrorKnowledgePointRow { questionId: number; knowledgePointId: number; knowledgePointName: string }`
  - `listParentErrors(studentId: number, filters: ParentErrorFilters, limit: number, offset: number): Promise<{ items: ParentErrorRow[]; total: number }>`
  - `listErrorKnowledgePoints(questionIds: number[]): Promise<ErrorKnowledgePointRow[]>`

> ⚠️ **不要在分页查询里 JOIN `question_knowledge_points`。** 实测 dev 库：203 道绑了知识点的题里 **83 道（41%）绑了多个 KP**，139 条错题里 **26 条（19%）** 会因此产出多行。`LIMIT ? OFFSET ?` 作用在**翻倍后的行**上，后果是：一页返回的错题数少于 `pageSize`、同一道错题重复出现、`items.length` 与 `total` 对不上（`total` 走的是不带 join 的 `COUNT(*)`）。这是真实数据上会发生的问题，不是理论边角。
>
> 所以：**分页查询只出「一行一道错题」**（保留 `LEFT JOIN questions` 拿题面，去掉两个 KP join），知识点由 `listErrorKnowledgePoints(本页 questionIds)` **另一条查询批量取回**，由 service 组装成 `question.knowledgePoints[]`。
>
> **为什么不在 SQL 里聚合 KP**（`GROUP_CONCAT` / `JSON_ARRAYAGG`）：要么得到需要二次解析的字符串（分隔符还得防内容里出现），要么要处理 LEFT JOIN 无匹配时 `[{"id":null}]` 的脏形状。两条查询更直白，且本页数据量很小（≤20 条）。

> **`track` 用「反向排除」而不是「白名单」**：`aux` → `source = 'auxiliary'`；`main` → `source <> 'auxiliary'`。
> 白名单（`IN ('practice','discuss','exam','targeted','error_practice')`）看似更严格，但未来「智能组卷」
> 会写入 `homework` / `unit_test` / `midterm` / `final` 等新 source，白名单会让它们从「主线」Tab 里
> **静默消失**——家长看不到孩子的作业错题，而且不会报错。反向排除对新 source 天然免疫。
> （顺带：`main_error_books.source` 无 CHECK 约束，实际写入值由代码决定，白名单无法穷举。）

- [ ] **Step 1: 写失败的测试**

追加到 `parent-insights.repo.test.ts`：

```ts
describe('ParentInsightsRepository：错题列表', () => {
  const listRows = [
    {
      id: 91, question_id: 330, subject_id: 1, source: 'exam', level: 2, is_cleared: 0,
      wrong_answer_text: 'x=3', created_at: new Date('2026-09-16T19:21:00Z'), cleared_at: null,
      question_content: '解方程', question_type: 'calculation', question_difficulty: 3,
    },
  ];

  it('返回 items + total；列表行与错题**一比一**（不 JOIN 知识点）', async () => {
    const pool = mockPool([]);
    pool.execute.mockResolvedValueOnce([[{ count: 139 }], []]);
    pool.query.mockResolvedValueOnce([listRows, []]);
    const repo = new ParentInsightsRepository(pool as any);

    const result = await repo.listParentErrors(9, {}, 20, 0);

    expect(result.total).toBe(139);
    expect(result.items).toEqual([
      {
        id: 91, questionId: 330, subjectId: 1, source: 'exam', level: 2, isCleared: false,
        wrongAnswerText: 'x=3', createdAt: listRows[0].created_at, clearedAt: null,
        questionContent: '解方程', questionType: 'calculation', questionDifficulty: 3,
      },
    ]);
    expect(pool.execute.mock.calls[0][0]).toContain('COUNT(*) AS count');
    const listSql = pool.query.mock.calls[0][0] as string;
    expect(listSql).toContain('LEFT JOIN questions');
    expect(listSql).toContain('ORDER BY meb.created_at DESC, meb.id DESC');
    // 关键：分页查询**不能**碰知识点关联表，否则一题多 KP 会把行翻倍、分页就错了
    expect(listSql).not.toContain('question_knowledge_points');
    expect(listSql).not.toContain('knowledge_points');
  });

  it('筛选条件逐条下推（学科 / source / 轨道 / 清零态 / 时间窗）', async () => {
    const pool = mockPool([]);
    pool.execute.mockResolvedValueOnce([[{ count: 0 }], []]);
    pool.query.mockResolvedValueOnce([[], []]);
    const repo = new ParentInsightsRepository(pool as any);

    await repo.listParentErrors(
      9,
      {
        subjectId: 1, source: 'exam', cleared: 'uncleared',
        from: '2026-09-01', to: '2026-09-18',
      },
      20,
      0,
    );

    const countSql = pool.execute.mock.calls[0][0] as string;
    expect(countSql).toContain('meb.subject_id = ?');
    expect(countSql).toContain('meb.source = ?');
    expect(countSql).toContain('meb.is_cleared = 0');
    expect(countSql).toContain('meb.created_at >= ?');
    expect(countSql).toContain('meb.created_at < DATE_ADD(?, INTERVAL 1 DAY)');
    expect(pool.execute.mock.calls[0][1]).toEqual([
      9, 1, 'exam', '2026-09-01', '2026-09-18',
    ]);
    // count 与 list 用的是同一份 WHERE
    expect(pool.query.mock.calls[0][0]).toContain('meb.subject_id = ?');
  });

  it('track=aux → source = auxiliary；track=main → source <> auxiliary（反向排除）', async () => {
    const pool = mockPool([]);
    pool.execute.mockResolvedValueOnce([[{ count: 0 }], []]);
    pool.query.mockResolvedValueOnce([[], []]);
    const repo = new ParentInsightsRepository(pool as any);

    await repo.listParentErrors(9, { track: 'aux' }, 20, 0);
    expect(pool.execute.mock.calls[0][0]).toContain("meb.source = 'auxiliary'");

    pool.execute.mockClear();
    pool.execute.mockResolvedValueOnce([[{ count: 0 }], []]);
    await repo.listParentErrors(9, { track: 'main' }, 20, 0);
    // 关键：不带具体的 source 值，未来新 source 自动归入主线，不会静默消失
    expect(pool.execute.mock.calls[0][0]).toContain("meb.source <> 'auxiliary'");
    expect(pool.execute.mock.calls[0][1]).toEqual([9]);
  });

  it('cleared=cleared → is_cleared = 1；不传 → 不过滤清零态', async () => {
    const pool = mockPool([]);
    pool.execute.mockResolvedValueOnce([[{ count: 0 }], []]);
    pool.query.mockResolvedValueOnce([[], []]);
    const repo = new ParentInsightsRepository(pool as any);

    await repo.listParentErrors(9, { cleared: 'cleared' }, 20, 0);
    expect(pool.execute.mock.calls[0][0]).toContain('meb.is_cleared = 1');

    pool.execute.mockClear();
    pool.execute.mockResolvedValueOnce([[{ count: 0 }], []]);
    await repo.listParentErrors(9, {}, 20, 0);
    expect(pool.execute.mock.calls[0][0]).not.toContain('meb.is_cleared');
  });

  it('question_id 为 NULL 的行不炸（题目相关列全 null）', async () => {
    const pool = mockPool([
      {
        id: 5, question_id: null, subject_id: 1, source: 'practice', level: 1, is_cleared: 0,
        wrong_answer_text: '只会题面', created_at: new Date('2026-09-10T10:00:00Z'), cleared_at: null,
        question_content: null, question_type: null, question_difficulty: null,
      },
    ]);
    pool.execute.mockResolvedValueOnce([[{ count: 1 }], []]);
    const repo = new ParentInsightsRepository(pool as any);

    const result = await repo.listParentErrors(9, {}, 20, 0);

    expect(result.items[0]).toMatchObject({
      questionId: null, questionContent: null, wrongAnswerText: '只会题面',
    });
  });
});

describe('ParentInsightsRepository：本页错题的知识点', () => {
  it('按 questionIds 批量取，一题多 KP 出多行', async () => {
    const pool = mockPool([
      { question_id: 330, knowledge_point_id: 42, knowledge_point_name: '分数加减' },
      { question_id: 330, knowledge_point_id: 43, knowledge_point_name: '整式' },
      { question_id: 331, knowledge_point_id: 44, knowledge_point_name: '方程' },
    ]);
    const repo = new ParentInsightsRepository(pool as any);

    const result = await repo.listErrorKnowledgePoints([330, 331]);

    expect(result).toEqual([
      { questionId: 330, knowledgePointId: 42, knowledgePointName: '分数加减' },
      { questionId: 330, knowledgePointId: 43, knowledgePointName: '整式' },
      { questionId: 331, knowledgePointId: 44, knowledgePointName: '方程' },
    ]);
    const sql = pool.execute.mock.calls[0][0] as string;
    expect(sql).toContain('question_knowledge_points');
    expect(sql).toContain('IN (?,?)');
    expect(pool.execute.mock.calls[0][1]).toEqual([330, 331]);
  });

  it('空数组 → 直接返回 []，**不发 SQL**（IN () 是语法错误）', async () => {
    const pool = mockPool([]);
    const repo = new ParentInsightsRepository(pool as any);

    expect(await repo.listErrorKnowledgePoints([])).toEqual([]);
    expect(pool.execute).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/database/repositories/parent-insights.repo.test.ts`
Expected: FAIL — `repo.listParentErrors is not a function`

- [ ] **Step 3: 实现**

追加行类型与筛选类型：

```ts
/**
 * 家长端错题列表的筛选条件。
 *
 * `track` 是**反向排除**语义（不是白名单）：
 * - `aux` → `source = 'auxiliary'`
 * - `main` → `source <> 'auxiliary'`
 *
 * 为什么 main 不用白名单 `IN (...)`：未来「智能组卷」会写入 `homework`/`unit_test`/`midterm`/
 * `final` 等新 source，白名单会让这些错题从「主线」Tab **静默消失**且不报错。反向排除对新
 * source 天然免疫。`source` 是「具体来源」筛选（与 `track` 可叠加）。
 *
 * `from`/`to` 是 `YYYY-MM-DD`，`to` 用 `DATE_ADD(..., INTERVAL 1 DAY)` 做闭区间。
 */
export interface ParentErrorFilters {
  subjectId?: number;
  track?: 'main' | 'aux';
  source?: string;
  cleared?: 'uncleared' | 'cleared';
  from?: string;
  to?: string;
}

/**
 * 错题列表行（已 JOIN 题面；`question_id` 为 NULL 时后三列为 null）。
 *
 * **不含知识点**：知识点单独用 `listErrorKnowledgePoints` 批量取（一题多 KP，见方法注释）。
 */
export interface ParentErrorRow {
  id: number;
  questionId: number | null;
  subjectId: number;
  source: string;
  level: number;
  isCleared: boolean;
  wrongAnswerText: string | null;
  createdAt: Date;
  clearedAt: Date | null;
  questionContent: string | null;
  questionType: string | null;
  questionDifficulty: number | null;
}

/** 「题 × 知识点」扁平行，交给 service 按 questionId 聚成 `question.knowledgePoints[]`。 */
export interface ErrorKnowledgePointRow {
  questionId: number;
  knowledgePointId: number;
  knowledgePointName: string;
}
```

追加方法（**count 与 list 共用同一份 WHERE 构造**，避免两处口径分叉）：

```ts
  /**
   * 家长端错题列表（只读、分页）。
   *
   * 为什么不在 `main-error-books.repo.ts` 上扩展 `findErrorBookEntries`：那个方法正被训练轨
   * 的错题练习调用，改它会连带改训练轨行为。这里照抄它的筛选写法自建。
   *
   * count 与 list **共用 `buildErrorWhere`**，否则「总数」与「列表」迟早对不上。
   *
   * **分页查询刻意不 JOIN 知识点**：实测 41% 的题绑了多个 KP，一 JOIN 就会让行翻倍，而
   * `LIMIT` 作用在翻倍后的行上——一页的错题数会少于 `pageSize`、同一道错题重复出现、`items`
   * 与 `total` 对不上。知识点由 `listErrorKnowledgePoints(本页 questionIds)` 另查（见该方法的注释）。
   */
  async listParentErrors(
    studentId: number,
    filters: ParentErrorFilters,
    limit: number,
    offset: number,
  ): Promise<{ items: ParentErrorRow[]; total: number }> {
    const { where, params } = this.buildErrorWhere(studentId, filters);

    const [countRows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS count FROM main_error_books meb WHERE ${where}`,
      params,
    );

    // LIMIT ? / OFFSET ? 必须用 pool.query（客户端转义）
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT meb.id, meb.question_id, meb.subject_id, meb.source, meb.level, meb.is_cleared,
              meb.wrong_answer_text, meb.created_at, meb.cleared_at,
              q.content AS question_content, q.type AS question_type,
              q.difficulty AS question_difficulty
       FROM main_error_books meb
       LEFT JOIN questions q ON q.id = meb.question_id
       WHERE ${where}
       ORDER BY meb.created_at DESC, meb.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    return {
      total: Number(countRows[0]?.count ?? 0),
      items: rows.map((r) => ({
        id: Number(r.id),
        questionId: r.question_id === null ? null : Number(r.question_id),
        subjectId: Number(r.subject_id),
        source: String(r.source),
        level: Number(r.level),
        isCleared: Number(r.is_cleared) === 1,
        wrongAnswerText: (r.wrong_answer_text as string | null) ?? null,
        createdAt: new Date(r.created_at as Date),
        clearedAt: r.cleared_at ? new Date(r.cleared_at as Date) : null,
        questionContent: (r.question_content as string | null) ?? null,
        questionType: (r.question_type as string | null) ?? null,
        questionDifficulty: r.question_difficulty === null ? null : Number(r.question_difficulty),
      })),
    };
  }

  /**
   * 本页错题涉及的知识点（一题多 KP 会出多行，由 service 按 questionId 聚成数组）。
   *
   * 空数组**直接返回、不发 SQL**：`IN ()` 在 MySQL 里是语法错误。这个守卫必须留在仓储里，
   * 不能让每个调用方各自记得判空。
   */
  async listErrorKnowledgePoints(questionIds: number[]): Promise<ErrorKnowledgePointRow[]> {
    if (questionIds.length === 0) return [];

    const placeholders = questionIds.map(() => '?').join(',');
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT qkp.question_id, kp.id AS knowledge_point_id, kp.name AS knowledge_point_name
       FROM question_knowledge_points qkp
       JOIN knowledge_points kp ON kp.id = qkp.knowledge_point_id
       WHERE qkp.question_id IN (${placeholders})
       ORDER BY qkp.question_id ASC, kp.id ASC`,
      questionIds,
    );
    return rows.map((r) => ({
      questionId: Number(r.question_id),
      knowledgePointId: Number(r.knowledge_point_id),
      knowledgePointName: String(r.knowledge_point_name ?? ''),
    }));
  }

  /** 错题列表 count 与 list 的**唯一** WHERE 构造器（改这里就是改两处）。 */
  private buildErrorWhere(
    studentId: number,
    filters: ParentErrorFilters,
  ): { where: string; params: (number | string)[] } {
    const conditions = ['meb.student_id = ?'];
    const params: (number | string)[] = [studentId];

    if (filters.subjectId !== undefined) {
      conditions.push('meb.subject_id = ?');
      params.push(filters.subjectId);
    }
    if (filters.track === 'aux') {
      conditions.push("meb.source = 'auxiliary'");
    } else if (filters.track === 'main') {
      // 反向排除：新 source（homework/unit_test/...）自动归入主线，不会静默消失
      conditions.push("meb.source <> 'auxiliary'");
    }
    if (filters.source) {
      conditions.push('meb.source = ?');
      params.push(filters.source);
    }
    if (filters.cleared === 'uncleared') {
      conditions.push('meb.is_cleared = 0');
    } else if (filters.cleared === 'cleared') {
      conditions.push('meb.is_cleared = 1');
    }
    if (filters.from) {
      conditions.push('meb.created_at >= ?');
      params.push(filters.from);
    }
    if (filters.to) {
      conditions.push('meb.created_at < DATE_ADD(?, INTERVAL 1 DAY)');
      params.push(filters.to);
    }
    return { where: conditions.join(' AND '), params };
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/database/repositories/parent-insights.repo.test.ts`
Expected: PASS（本任务新增的用例全绿）

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/database/repositories/parent-insights.repo.ts apps/server/src/database/repositories/parent-insights.repo.test.ts
git commit -m "feat(parent-insights): 家长端错题列表（筛选 + 分页，count/list 共用 WHERE）"
```

---

### Task 6: 仓储 — 会话列表

**Files:**
- Modify: `apps/server/src/database/repositories/parent-insights.repo.ts`
- Test: `apps/server/src/database/repositories/parent-insights.repo.test.ts`

**Interfaces:**
- Consumes: Task 1–5 的 `ParentInsightsRepository`
- Produces:
  - `interface ParentChatLogFilters { track?: 'mainline' | 'auxiliary'; scene?: string; from?: string; to?: string; q?: string }`
  - `interface ParentChatLogRow { id: number; track: string; scene: string; title: string | null; subjectId: number | null; createdAt: Date; updatedAt: Date; messageCount: number; blockCount: number }`
  - `listParentChatLogs(studentId: number, filters: ParentChatLogFilters, limit: number, offset: number): Promise<{ items: ParentChatLogRow[]; total: number }>`

> **本任务的仓储不负责读消息正文**：`chat-logs/:dialogueId` 的消息直接用既有的 `AiMessagesRepository.findByDialogue(dialogueId)`（在 `ConversationsService` 里已被验证过），Task 10 注入它即可。这样同一份读逻辑不会在 plan 里出现两遍。

- [ ] **Step 1: 写失败的测试**

追加到 `parent-insights.repo.test.ts`：

```ts
describe('ParentInsightsRepository：会话列表', () => {
const logRows = [
  {
    id: 55, track: 'auxiliary', scene: 'aux_qna', title: '二次函数求最值', subject_id: null,
    created_at: new Date('2026-09-16T10:00:00Z'), last_active_at: new Date('2026-09-16T10:05:00Z'),
    message_count: 8, block_count: 2,
  },
];

it('带出 messageCount / blockCount（一条 JOIN 聚合，避免 N+1）', async () => {
  const pool = mockPool([]);
  pool.execute.mockResolvedValueOnce([[{ count: 80 }], []]);
  pool.query.mockResolvedValueOnce([logRows, []]);
  const repo = new ParentInsightsRepository(pool as any);

  const result = await repo.listParentChatLogs(9, {}, 20, 0);

  expect(result.total).toBe(80);
  expect(result.items[0]).toMatchObject({
    id: 55, track: 'auxiliary', scene: 'aux_qna', title: '二次函数求最值',
    subjectId: null, messageCount: 8, blockCount: 2,
  });
  // `updatedAt` 取的是「最后一条消息时间」（SQL 里的 last_active_at），不是 d.updated_at
  expect(result.items[0].updatedAt).toEqual(new Date('2026-09-16T10:05:00Z'));

  const listSql = pool.query.mock.calls[0][0] as string;
  expect(listSql).toContain('SUM(m.safety_flag = 1)');
  // 消息侧条件必须在 ON 里：写到 WHERE 会把 LEFT JOIN 变成 INNER JOIN，零消息会话会整条消失
  expect(listSql).toContain('LEFT JOIN ai_messages m');
  expect(listSql).toContain('m.deleted_at IS NULL');
  expect(listSql).toContain('d.deleted_at IS NULL');
  // 排序按「最后一条消息时间」——用 d.updated_at 会把横跨整个学期的主线卡片会话排错
  expect(listSql).toContain('COALESCE(MAX(m.created_at), d.created_at) AS last_active_at');
  expect(listSql).toContain('ORDER BY last_active_at DESC');
  // 会话行可能在几十毫秒内同时创建，没有 id 兜底 OFFSET 分页会漏行/重复行
  expect(listSql).toContain('d.id DESC');
});

it('筛选下推：轨道 / 场景 / 时间窗（按最后一条消息时间）/ 标题关键词', async () => {
    const pool = mockPool([]);
    pool.execute.mockResolvedValueOnce([[{ count: 0 }], []]);
    pool.query.mockResolvedValueOnce([[], []]);
    const repo = new ParentInsightsRepository(pool as any);

    await repo.listParentChatLogs(
      9,
      { track: 'auxiliary', scene: 'aux_qna', from: '2026-09-01', to: '2026-09-18', q: '函数' },
      20,
      0,
    );

    const countSql = pool.execute.mock.calls[0][0] as string;
    expect(countSql).toContain('d.track = ?');
    expect(countSql).toContain('d.scene = ?');
    // 时间窗走相关子查询（count 查询不带 JOIN，写聚合会报错；且 count/list 必须共用同一份 WHERE）
    expect(countSql).toContain('(SELECT MAX(m2.created_at) FROM ai_messages m2');
    expect(countSql).toContain('>= ?');
    expect(countSql).toContain('< DATE_ADD(?, INTERVAL 1 DAY)');
    expect(countSql).toContain('d.title LIKE ?');
    expect(pool.execute.mock.calls[0][1]).toEqual([
      9, 'auxiliary', 'aux_qna', '2026-09-01', '2026-09-18', '%函数%',
    ]);
  });

  it('关键词里的 % 与 _ 被转义，不当作通配符', async () => {
    const pool = mockPool([]);
    pool.execute.mockResolvedValueOnce([[{ count: 0 }], []]);
    pool.query.mockResolvedValueOnce([[], []]);
    const repo = new ParentInsightsRepository(pool as any);

    await repo.listParentChatLogs(9, { q: '50%_x' }, 20, 0);

    expect(pool.execute.mock.calls[0][1]).toEqual([9, '%50\\%\\_x%']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/database/repositories/parent-insights.repo.test.ts`
Expected: FAIL — `repo.listParentChatLogs is not a function`

- [ ] **Step 3: 实现**

追加行类型与筛选类型：

```ts
/**
 * 家长端对话回放列表的筛选条件。
 *
 * **没有学科筛选**：实测 `ai_dialogues.subject_id` 有 76% 是 NULL
 * （`ConversationService.createDialogue` 硬编码写 null），按学科筛会大面积漏。
 * 可靠维度是 `track` + `scene` + 时间 + 标题关键词。
 */
export interface ParentChatLogFilters {
  track?: 'mainline' | 'auxiliary';
  scene?: string;
  from?: string;
  to?: string;
  /** 只匹配 `ai_dialogues.title`，**不搜消息正文**。 */
  q?: string;
}

/** 会话列表行（含消息数与闲聊标记数）。`updatedAt` = 最后一条消息时间（见方法注释）。 */
export interface ParentChatLogRow {
  id: number;
  track: string;
  scene: string;
  title: string | null;
  subjectId: number | null;
  createdAt: Date;
  /** **最后一条消息时间**（无消息则退回 `createdAt`），不是 `ai_dialogues.updated_at`。 */
  updatedAt: Date;
  messageCount: number;
  blockCount: number;
}
```

追加方法：

```ts
  /**
   * 家长端会话列表（只读、分页）。`messageCount` / `blockCount` 由 JOIN 聚合带出，
   * 避免「先查会话再逐条查消息数」的 N+1。
   *
   * `blockCount` = 该会话里 `safety_flag = 1` 的消息数（温和阻断落库时就置 1），
   * 前端据此给「闲聊/偏离学习」打红色标记——本批唯一有真数据的预警信号。
   *
   * **`updatedAt` 是「最后一条消息时间」，不是 `ai_dialogues.updated_at`。**
   * 为什么不能直接用那一列：追加消息只 `INSERT INTO ai_messages`，**不 UPDATE 对话行**，
   * 所以 `ai_dialogues.updated_at` 实质冻结在创建时刻（schema 里那个
   * `trg_ai_dialogues_updated_at` 只在 UPDATE 对话行时触发，帮不上忙；而且当前 dev 库里
   * 它压根没装上——见 changelog）。主线卡片讨论是 find-or-create（一个会话横跨整个学期），
   * 用创建时间排序会把**最近在聊**的会话沉到列表底部。
   *
   * 因此统一用 `COALESCE(MAX(m.created_at), d.created_at)`：有消息取最后一条消息时间，
   * 没消息退回创建时间。排序与时间窗（`buildChatLogWhere` 里的相关子查询）都用它，
   * 保证「列表看到的顺序」与「筛选用的时间」是同一个东西。
   */
  async listParentChatLogs(
    studentId: number,
    filters: ParentChatLogFilters,
    limit: number,
    offset: number,
  ): Promise<{ items: ParentChatLogRow[]; total: number }> {
    const { where, params } = this.buildChatLogWhere(studentId, filters);

    const [countRows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS count FROM ai_dialogues d WHERE ${where}`,
      params,
    );

    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT d.id, d.track, d.scene, d.title, d.subject_id, d.created_at,
              COALESCE(MAX(m.created_at), d.created_at) AS last_active_at,
              COUNT(m.id) AS message_count,
              COALESCE(SUM(m.safety_flag = 1), 0) AS block_count
       FROM ai_dialogues d
       LEFT JOIN ai_messages m ON m.dialogue_id = d.id AND m.deleted_at IS NULL
       WHERE ${where}
       GROUP BY d.id, d.track, d.scene, d.title, d.subject_id, d.created_at
       ORDER BY last_active_at DESC, d.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    return {
      total: Number(countRows[0]?.count ?? 0),
      items: rows.map((r) => ({
        id: Number(r.id),
        track: String(r.track),
        scene: String(r.scene),
        title: (r.title as string | null) ?? null,
        subjectId: r.subject_id === null ? null : Number(r.subject_id),
        createdAt: new Date(r.created_at as Date),
        updatedAt: new Date(r.last_active_at as Date),
        messageCount: Number(r.message_count ?? 0),
        blockCount: Number(r.block_count ?? 0),
      })),
    };
  }

  /** 会话列表 count 与 list 的**唯一** WHERE 构造器。 */
  private buildChatLogWhere(
    studentId: number,
    filters: ParentChatLogFilters,
  ): { where: string; params: (number | string)[] } {
    const conditions = ['d.student_id = ?', 'd.deleted_at IS NULL'];
    const params: (number | string)[] = [studentId];

    if (filters.track) {
      conditions.push('d.track = ?');
      params.push(filters.track);
    }
    if (filters.scene) {
      conditions.push('d.scene = ?');
      params.push(filters.scene);
    }
    // 时间窗按「最后一条消息时间」算，与 ORDER BY 同一表达式。
    // 这里必须用**相关子查询**而不是 MAX(m.created_at)：count 查询是**不带 JOIN** 的
    // `SELECT COUNT(*) FROM ai_dialogues d`，写聚合函数会直接报错；而 count 与 list 必须
    // 共用同一份 WHERE（否则 total 与列表会各算各的）。
    const lastActive =
      'COALESCE((SELECT MAX(m2.created_at) FROM ai_messages m2 WHERE m2.dialogue_id = d.id AND m2.deleted_at IS NULL), d.created_at)';
    if (filters.from) {
      conditions.push(`${lastActive} >= ?`);
      params.push(filters.from);
    }
    if (filters.to) {
      conditions.push(`${lastActive} < DATE_ADD(?, INTERVAL 1 DAY)`);
      params.push(filters.to);
    }
    if (filters.q) {
      // LIKE 通配符转义：不转义的话家长搜「50%」会变成「任意字符」而匹配一切。
      // mysql2 的 `?` 占位只防注入，不处理 LIKE 元字符，必须自己转。
      const escaped = filters.q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
      conditions.push('d.title LIKE ?');
      params.push(`%${escaped}%`);
    }
    return { where: conditions.join(' AND '), params };
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/database/repositories/parent-insights.repo.test.ts`
Expected: PASS（本任务新增的用例全绿）

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/database/repositories/parent-insights.repo.ts apps/server/src/database/repositories/parent-insights.repo.test.ts
git commit -m "feat(parent-insights): 会话列表聚合（消息数/闲聊标记数 + LIKE 转义）"
```

---

### Task 7: 模块骨架 + DTO + DashboardService + dashboard 端点

**Files:**
- Create: `apps/server/src/modules/parent-insights/window.util.ts`
- Create: `apps/server/src/modules/parent-insights/rate.util.ts`
- Create: `apps/server/src/modules/parent-insights/dto/parent-insights.dto.ts`
- Create: `apps/server/src/modules/parent-insights/dashboard.service.ts`
- Create: `apps/server/src/modules/parent-insights/parent-insights.controller.ts`
- Create: `apps/server/src/modules/parent-insights/parent-insights.module.ts`
- Modify: `apps/server/src/app.module.ts`
- Test: `apps/server/src/modules/parent-insights/window.util.test.ts`
- Test: `apps/server/src/modules/parent-insights/rate.util.test.ts`
- Test: `apps/server/src/modules/parent-insights/dashboard.service.test.ts`

**Interfaces:**
- Consumes: `ParentInsightsRepository`（Task 1–6）、`ParentService.requireOwnedStudent(parentId, studentId)`、`ProgressService.getStarMap(studentId, subjectId): Promise<StarMapData>`、`StudentsRepository.findByParentId(parentId)`、`SubjectsRepository.findAll()`
- Produces:
  - `window.util.ts`：`type ReportPeriod = 'weekly' | 'monthly'`、`startOfDaysAgo(days: number): Date`、`resolveWindow(period: ReportPeriod): ReportWindow`（`ReportWindow = { start: Date; endExclusive: Date; startDay: string; endDay: string }`）
  - `rate.util.ts`：`toRate(answered: number, correct: number): number | null`
  - `dto/parent-insights.dto.ts`：`RateSummary` / `SelfAssessSummary` / `ErrorBookSummary` / `SubjectProgressSummary` / `DashboardSubject` / `DashboardStudent` / `ParentDashboard`
  - `class DashboardService { getDashboard(parentId: number): Promise<ParentDashboard> }`
  - `@Controller('api/parent') class ParentInsightsController`（本任务只有 `@Get('dashboard')`）
  - `class ParentInsightsModule`

> `toRate` 与 `resolveWindow` 在 Task 7 就抽成独立 util（不是写在 dashboard 里），因为 Task 8 的报告页要用**同一份**口径。两个小 util 各自带测试，是「口径唯一实现」这个硬要求的落地方式。

- [ ] **Step 1: 写 window.util 的失败测试**

创建 `apps/server/src/modules/parent-insights/window.util.test.ts`：

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { startOfDaysAgo, resolveWindow } from './window.util.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('window.util', () => {
  it('startOfDaysAgo(0) = 今天 00:00', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T15:30:00'));

    const d = startOfDaysAgo(0);

    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
    expect(d.getDate()).toBe(18);
  });

  it('startOfDaysAgo(6) 落在 6 天前的 00:00', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T15:30:00'));

    const d = startOfDaysAgo(6);

    expect(d.getDate()).toBe(12);
    expect(d.getHours()).toBe(0);
  });

  it('weekly = 近 7 天（含今天），endExclusive 是次日 00:00', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T15:30:00'));

    const w = resolveWindow('weekly');

    expect(w.startDay).toBe('2026-09-12');
    expect(w.endDay).toBe('2026-09-18');
    expect(w.endExclusive.getDate()).toBe(19);
    expect(w.endExclusive.getHours()).toBe(0);
  });

  it('monthly = 近 30 天', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T15:30:00'));

    const w = resolveWindow('monthly');

    expect(w.startDay).toBe('2026-08-20');
    expect(w.endDay).toBe('2026-09-18');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/parent-insights/window.util.test.ts`
Expected: FAIL — `Failed to resolve import "./window.util.js"`

- [ ] **Step 3: 实现 window.util**

创建 `apps/server/src/modules/parent-insights/window.util.ts`：

```ts
/**
 * 家长端报告的时间窗（spec §4.2 ②）。
 *
 * 口径：`weekly` = 近 7 天（含今天）、`monthly` = 近 30 天。`windowStart` / `windowEnd` 都是
 * **日期**，SQL 上用 `>= start` 与 `< endExclusive` 表达闭区间——半开区间跨月/跨年无需拼接。
 *
 * 一律按**服务器本地时区**的 00:00 算：刻意不在 SQL 里用 `CURDATE()`，因为 DB 会话时区与
 * 应用可能不一致，会算错一天（`point-ledger.repo.ts` 的既有约定）。
 */
export type ReportPeriod = 'weekly' | 'monthly';

export interface ReportWindow {
  start: Date;
  /** 窗口末日的**次日** 00:00（SQL 用 `<`）。 */
  endExclusive: Date;
  /** `YYYY-MM-DD`，给响应体回显。 */
  startDay: string;
  endDay: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 本地时区某天的 00:00。 */
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** N 天前的 00:00（`0` = 今天）。 */
export function startOfDaysAgo(days: number): Date {
  const today = startOfDay(new Date());
  return new Date(today.getTime() - days * DAY_MS);
}

/** `YYYY-MM-DD`（本地时区；**不用** `toISOString()`——那会按 UTC 切，跨时区差一天）。 */
function toDayString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function resolveWindow(period: ReportPeriod): ReportWindow {
  const days = period === 'monthly' ? 30 : 7;
  const start = startOfDaysAgo(days - 1);
  const endInclusive = startOfDaysAgo(0);
  const endExclusive = new Date(endInclusive.getTime() + DAY_MS);
  return {
    start,
    endExclusive,
    startDay: toDayString(start),
    endDay: toDayString(endInclusive),
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/parent-insights/window.util.test.ts`
Expected: PASS（本任务新增的用例全绿）

- [ ] **Step 5: 写并实现 rate.util（含测试）**

创建 `apps/server/src/modules/parent-insights/rate.util.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { toRate } from './rate.util.js';

describe('toRate', () => {
  it('保留一位小数', () => {
    expect(toRate(42, 31)).toBe(73.8);
    expect(toRate(3, 1)).toBe(33.3);
  });

  it('满分与零分', () => {
    expect(toRate(10, 10)).toBe(100);
    expect(toRate(10, 0)).toBe(0);
  });

  it('answered = 0 → null（不是 0）', () => {
    expect(toRate(0, 0)).toBeNull();
    expect(toRate(-1, 0)).toBeNull();
  });
});
```

创建 `apps/server/src/modules/parent-insights/rate.util.ts`：

```ts
/**
 * 正确率的**唯一**计算口径（spec §4.3）：一位小数。
 *
 * `answered = 0` 时返回 `null`，**不是 0** —— 0 会被家长读成「全错了」，那是另一回事，
 * 而「还没做过」应当显示为「暂无数据」。仪表盘与报告页共用这一份，勿各写一套。
 */
export function toRate(answered: number, correct: number): number | null {
  if (answered <= 0) return null;
  return Math.round((correct / answered) * 1000) / 10;
}
```

Run: `cd apps/server && npx vitest run src/modules/parent-insights/rate.util.test.ts`
Expected: PASS（本任务新增的用例全绿）

- [ ] **Step 6: 写 dashboard.service 的失败测试**

创建 `apps/server/src/modules/parent-insights/dashboard.service.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { DashboardService } from './dashboard.service.js';

const BOY = {
  id: 11, parentId: 3, username: 'xiaoming', passwordHash: 'h', name: '小明',
  age: 13, grade: '初一', schoolLevel: 'junior', isActive: true,
};

/** 与 ProgressService.getStarMap 的 StarMapData 同形状（注意 id 是 string、百分比字段叫 progress）。 */
const STAR_MAP = {
  subjectName: '数学',
  gradeName: '七年级上册',
  publisher: '人教版',
  totalUnits: 8,
  completedUnits: 2,
  chapters: [
    {
      id: '1', title: '第一章', order: 1, importance: 'medium',
      status: 'completed', progress: 100, sections: [],
    },
    {
      id: '2', title: '第二章 整式的加减', order: 2, importance: 'medium',
      status: 'current', progress: 30,
      sections: [
        { id: '5', title: '2.0 章综述', order: 0, knowledgePointCount: 0, status: 'completed', progress: 100 },
        { id: '6', title: '2.1 整式', order: 1, knowledgePointCount: 3, status: 'current', progress: 30 },
      ],
    },
  ],
};

const mkRepo = () => ({
  listTrackedSubjectIds: vi.fn().mockResolvedValue([1]),
  getActivitySummary: vi.fn().mockResolvedValue({
    lastActiveAt: new Date('2026-09-18T20:11:00Z'), activeDays: 3,
  }),
  getAccuracyBySubject: vi.fn().mockResolvedValue([{ subjectId: 1, answered: 42, correct: 31 }]),
  getSelfAssessBySubject: vi.fn().mockResolvedValue([{ subjectId: 1, count: 5, correctCount: 3 }]),
  getErrorBookSummary: vi.fn().mockResolvedValue([{ subjectId: 1, uncleared: 12, total: 20 }]),
  getExamCounts: vi.fn().mockResolvedValue([{ subjectId: 1, count: 4 }]),
});

const mk = (overrides: Record<string, any> = {}) => ({
  studentsRepo: { findByParentId: vi.fn().mockResolvedValue([BOY]) },
  subjectsRepo: { findAll: vi.fn().mockResolvedValue([{ id: 1, name: '数学' }]) },
  progressService: { getStarMap: vi.fn().mockResolvedValue(STAR_MAP) },
  repo: mkRepo(),
  ...overrides,
});

const mkSvc = (d: ReturnType<typeof mk>) =>
  new DashboardService(
    d.studentsRepo as any,
    d.subjectsRepo as any,
    d.progressService as any,
    d.repo as any,
  );

describe('DashboardService', () => {
  it('编排：多孩 × 已开始学科，拼出进度/正确率/自评/错题/考试数', async () => {
    const d = mk();

    const result = await mkSvc(d).getDashboard(3);

    expect(result.students).toHaveLength(1);
    const s = result.students[0];
    expect(s).toMatchObject({
      studentId: 11, name: '小明', grade: '初一', schoolLevel: 'junior', activeDays7: 3, unreadAlerts: 0,
    });
    expect(s.subjects).toEqual([
      {
        subjectId: 1,
        subjectName: '数学',
        progress: {
          completedUnits: 2,
          totalUnits: 8,
          currentUnitName: '第二章 整式的加减',
          currentLessonName: '2.1 整式',
          percent: 25,
        },
        accuracy: { answered: 42, correct: 31, rate: 73.8 },
        selfAssessed: { count: 5, correctCount: 3 },
        errorBook: { uncleared: 12, total: 20 },
        examCount: 4,
      },
    ]);
    // 累计口径：聚合方法都**不传窗口**
    expect(d.repo.getAccuracyBySubject).toHaveBeenCalledWith(11);
    expect(d.repo.getSelfAssessBySubject).toHaveBeenCalledWith(11);
  });

  it('已开始学科为空 → subjects 为空数组（不调 getStarMap）', async () => {
    const d = mk({ repo: { ...mkRepo(), listTrackedSubjectIds: vi.fn().mockResolvedValue([]) } });

    const result = await mkSvc(d).getDashboard(3);

    expect(result.students[0].subjects).toEqual([]);
    expect(d.progressService.getStarMap).not.toHaveBeenCalled();
  });

  it('answered = 0 → rate 为 null（不是 0）', async () => {
    const d = mk({
      repo: {
        ...mkRepo(),
        getAccuracyBySubject: vi.fn().mockResolvedValue([{ subjectId: 1, answered: 0, correct: 0 }]),
      },
    });

    const result = await mkSvc(d).getDashboard(3);

    expect(result.students[0].subjects[0].accuracy).toEqual({ answered: 0, correct: 0, rate: null });
  });

  it('totalUnits = 0 → percent 为 0，当前单元/课为 null（不除零）', async () => {
    const d = mk({
      progressService: {
        getStarMap: vi.fn().mockResolvedValue({
          ...STAR_MAP, totalUnits: 0, completedUnits: 0, chapters: [],
        }),
      },
    });

    const result = await mkSvc(d).getDashboard(3);

    expect(result.students[0].subjects[0].progress).toEqual({
      completedUnits: 0, totalUnits: 0, currentUnitName: null, currentLessonName: null, percent: 0,
    });
  });

  it('某学科 getStarMap 抛 1002（学科被停用/无教材版本）→ 跳过该学科，不炸整页', async () => {
    const d = mk({
      progressService: {
        getStarMap: vi
          .fn()
          .mockRejectedValueOnce(new NotFoundException({ code: 1002, message: '学科不存在' }))
          .mockResolvedValueOnce(STAR_MAP),
      },
      repo: { ...mkRepo(), listTrackedSubjectIds: vi.fn().mockResolvedValue([9, 1]) },
    });

    const result = await mkSvc(d).getDashboard(3);

    expect(result.students[0].subjects.map((x: any) => x.subjectId)).toEqual([1]);
  });

  it('非 1002 的异常照常抛出（不吞 bug）', async () => {
    const d = mk({
      progressService: { getStarMap: vi.fn().mockRejectedValue(new Error('DB 挂了')) },
    });

    await expect(mkSvc(d).getDashboard(3)).rejects.toThrow('DB 挂了');
  });

  it('多个孩子各自出卡片', async () => {
    const d = mk({
      studentsRepo: {
        findByParentId: vi.fn().mockResolvedValue([BOY, { ...BOY, id: 12, name: '小美' }]),
      },
    });

    const result = await mkSvc(d).getDashboard(3);

    expect(result.students.map((s: any) => s.studentId)).toEqual([11, 12]);
  });

  it('unreadAlerts 恒为 0（safety_alerts 无写入，字段先占位）', async () => {
    const d = mk();
    const result = await mkSvc(d).getDashboard(3);
    expect(result.unreadAlerts).toBe(0);
    expect(result.students[0].unreadAlerts).toBe(0);
  });
});
```

- [ ] **Step 7: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/parent-insights/dashboard.service.test.ts`
Expected: FAIL — `Failed to resolve import "./dashboard.service.js"`

- [ ] **Step 8: 写 DTO**

创建 `apps/server/src/modules/parent-insights/dto/parent-insights.dto.ts`：

```ts
/**
 * 家长端「看得见」批的响应形状（spec `2026-09-18-parent-insights-design.md` §4.2）。
 *
 * 与 `docs/api/openapi.yaml` 的 schema **必须一致**（CLAUDE.md 的 API 文档同步铁律）。
 * 注意 `rate` 是 `number | null`：`answered = 0` 时必须为 null，**不能是 0**——0 会被读成
 * 「全错了」，那是另一回事。
 */
export interface RateSummary {
  answered: number;
  correct: number;
  rate: number | null;
}

export interface SelfAssessSummary {
  count: number;
  correctCount: number;
}

export interface ErrorBookSummary {
  uncleared: number;
  total: number;
}

export interface SubjectProgressSummary {
  completedUnits: number;
  totalUnits: number;
  currentUnitName: string | null;
  currentLessonName: string | null;
  percent: number;
}

export interface DashboardSubject {
  subjectId: number;
  subjectName: string;
  progress: SubjectProgressSummary;
  accuracy: RateSummary;
  selfAssessed: SelfAssessSummary;
  errorBook: ErrorBookSummary;
  examCount: number;
}

export interface DashboardStudent {
  studentId: number;
  name: string;
  grade: string | null;
  schoolLevel: string | null;
  lastActiveAt: Date | null;
  activeDays7: number;
  /** 本期恒 0：`safety_alerts` 无写入，等预警闭环后填（spec §3 定案 #9）。 */
  unreadAlerts: number;
  subjects: DashboardSubject[];
}

export interface ParentDashboard {
  students: DashboardStudent[];
  unreadAlerts: number;
}
```

- [ ] **Step 9: 实现 DashboardService**

创建 `apps/server/src/modules/parent-insights/dashboard.service.ts`：

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { StudentsRepository } from '../../database/repositories/students.repo.js';
import { SubjectsRepository } from '../../database/repositories/subjects.repo.js';
import { ParentInsightsRepository } from '../../database/repositories/parent-insights.repo.js';
import { ProgressService } from '../progress/progress.service.js';
import type { StarMapData } from '../progress/progress.service.js';
import { startOfDaysAgo } from './window.util.js';
import { toRate } from './rate.util.js';
import type {
  DashboardStudent,
  DashboardSubject,
  ParentDashboard,
} from './dto/parent-insights.dto.js';

/** 近 7 天活跃 = 含今天在内的 7 天窗口。 */
const ACTIVE_WINDOW_DAYS = 7;

/**
 * 家长仪表盘（spec §4.2 ①）：**多孩聚合一个端点**，一次给完。
 *
 * 口径注意：
 * - `accuracy` / `selfAssessed` / `errorBook` / `examCount` 都是**累计值，不限时间窗**
 *   （报告页才是窗口口径）。三种聚合方法都不传 `from`/`to`。
 * - `lastActiveAt` 是全时段 MAX、`activeDays7` 是近 7 天——仓储内部两次查。
 * - 进度**复用 `ProgressService.getStarMap`，不改它的返回结构**；`percent` 由
 *   `completedUnits / totalUnits` 现算，**不要**拿 `StarMapData` 里的 `progress` 字段
 *   （那个是「本章已完成的节占比」，语义不同）。
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly studentsRepo: StudentsRepository,
    private readonly subjectsRepo: SubjectsRepository,
    private readonly progressService: ProgressService,
    private readonly repo: ParentInsightsRepository,
  ) {}

  async getDashboard(parentId: number): Promise<ParentDashboard> {
    const students = await this.studentsRepo.findByParentId(parentId);
    const weekStart = startOfDaysAgo(ACTIVE_WINDOW_DAYS - 1);
    const subjectNames = new Map((await this.subjectsRepo.findAll()).map((s) => [s.id, s.name]));

    const result: DashboardStudent[] = [];
    for (const student of students) {
      const activity = await this.repo.getActivitySummary(student.id, weekStart);
      const subjectIds = await this.repo.listTrackedSubjectIds(student.id);

      let subjects: DashboardSubject[] = [];
      if (subjectIds.length > 0) {
        const accuracy = new Map(
          (await this.repo.getAccuracyBySubject(student.id)).map((r) => [r.subjectId, r]),
        );
        const selfAssess = new Map(
          (await this.repo.getSelfAssessBySubject(student.id)).map((r) => [r.subjectId, r]),
        );
        const errorBook = new Map(
          (await this.repo.getErrorBookSummary(student.id)).map((r) => [r.subjectId, r]),
        );
        const examCounts = new Map(
          (await this.repo.getExamCounts(student.id)).map((r) => [r.subjectId, r.count]),
        );

        subjects = await this.buildSubjects(student.id, subjectIds, subjectNames, {
          accuracy,
          selfAssess,
          errorBook,
          examCounts,
        });
      }

      result.push({
        studentId: student.id,
        name: student.name,
        grade: student.grade,
        schoolLevel: student.schoolLevel,
        lastActiveAt: activity.lastActiveAt,
        activeDays7: activity.activeDays,
        unreadAlerts: 0,
        subjects,
      });
    }

    return { students: result, unreadAlerts: 0 };
  }

  /**
   * 逐学科取进度。**单个学科失败不拖垮整页**：`getStarMap` 在「学科被停用」或「该学科暂无
   * 教材版本」时抛 1002，而 `progress` 行可能还留着（家长之前配过教材）——那是真实的脏数据
   * 场景，跳过该学科即可，否则整个仪表盘 404。非 1002 的异常照常抛出（不吞 bug）。
   */
  private async buildSubjects(
    studentId: number,
    subjectIds: number[],
    subjectNames: Map<number, string>,
    maps: {
      accuracy: Map<number, { answered: number; correct: number }>;
      selfAssess: Map<number, { count: number; correctCount: number }>;
      errorBook: Map<number, { uncleared: number; total: number }>;
      examCounts: Map<number, number>;
    },
  ): Promise<DashboardSubject[]> {
    const subjects: DashboardSubject[] = [];
    for (const subjectId of subjectIds) {
      let starMap: StarMapData;
      try {
        starMap = await this.progressService.getStarMap(studentId, subjectId);
      } catch (err) {
        if (err instanceof NotFoundException) continue;
        throw err;
      }

      const acc = maps.accuracy.get(subjectId) ?? { answered: 0, correct: 0 };
      const self = maps.selfAssess.get(subjectId) ?? { count: 0, correctCount: 0 };
      const errBook = maps.errorBook.get(subjectId) ?? { uncleared: 0, total: 0 };
      const currentChapter = starMap.chapters.find((c) => c.status === 'current');

      subjects.push({
        subjectId,
        subjectName: subjectNames.get(subjectId) ?? starMap.subjectName,
        progress: {
          completedUnits: starMap.completedUnits,
          totalUnits: starMap.totalUnits,
          currentUnitName: currentChapter?.title ?? null,
          currentLessonName:
            currentChapter?.sections.find((s) => s.status === 'current')?.title ?? null,
          percent:
            starMap.totalUnits > 0
              ? Math.round((starMap.completedUnits / starMap.totalUnits) * 100)
              : 0,
        },
        accuracy: {
          answered: acc.answered,
          correct: acc.correct,
          rate: toRate(acc.answered, acc.correct),
        },
        selfAssessed: { count: self.count, correctCount: self.correctCount },
        errorBook: { uncleared: errBook.uncleared, total: errBook.total },
        examCount: maps.examCounts.get(subjectId) ?? 0,
      });
    }
    return subjects;
  }
}
```

- [ ] **Step 10: 跑 dashboard 测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/parent-insights/dashboard.service.test.ts`
Expected: PASS（本任务新增的用例全绿）

- [ ] **Step 11: 写 controller**

创建 `apps/server/src/modules/parent-insights/parent-insights.controller.ts`：

```ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import type { JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import { DashboardService } from './dashboard.service.js';
import type { ParentDashboard } from './dto/parent-insights.dto.js';

/**
 * 家长端「看得见」批（spec `2026-09-18-parent-insights-design.md`）。
 *
 * 与 `ParentController` 同前缀 `api/parent`（Nest 允许多个 controller 共前缀，
 * `ParentPointsController` 已是先例）。全部端点**只读**。
 *
 * 归属校验：除 `dashboard`（按 `parentId` 查自己名下全部孩子）外，每个 handler 第一行必须
 * `await this.parentService.requireOwnedStudent(user.sub, studentId)`（Task 9/10 的端点）。
 *
 * 不手工包 `{code, message, data}`——全局 `ResponseInterceptor` 统一包。
 */
@Controller('api/parent')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('parent')
export class ParentInsightsController {
  constructor(private readonly dashboardService: DashboardService) {}

  /** P6.1 家长仪表盘：一次返回名下所有孩子的概览（含各自的按学科卡片）。 */
  @Get('dashboard')
  async getDashboard(@CurrentUser() user: JwtUser): Promise<ParentDashboard> {
    return this.dashboardService.getDashboard(user.sub);
  }
}
```

- [ ] **Step 12: 写模块并注册进 AppModule**

创建 `apps/server/src/modules/parent-insights/parent-insights.module.ts`：

```ts
import { Module } from '@nestjs/common';
import { ParentInsightsController } from './parent-insights.controller.js';
import { DashboardService } from './dashboard.service.js';
import { ParentInsightsRepository } from '../../database/repositories/parent-insights.repo.js';
import { StudentsRepository } from '../../database/repositories/students.repo.js';
import { SubjectsRepository } from '../../database/repositories/subjects.repo.js';
import { ParentModule } from '../parent/parent.module.js';
import { ProgressModule } from '../progress/progress.module.js';

/**
 * 家长端「看得见」批（spec `2026-09-18-parent-insights-design.md`）。
 *
 * - `imports: [ParentModule]` —— handler 用 `ParentService.requireOwnedStudent` 做归属校验
 *   （`ParentModule` 已 `exports: [ParentService]`）。
 * - `imports: [ProgressModule]` —— 仪表盘复用 `ProgressService.getStarMap`
 *   （`ProgressModule` 已 `exports: [ProgressService]`；它自带 Content/Practice/Points 依赖，
 *   本模块不必再展开）。
 * - `providers` 必须**逐个列出 service 构造函数里注入的全部仓储**，少一个 Nest 启动就抛
 *   「can't resolve dependencies」。`@Inject('DATABASE_POOL')` 来自 `@Global()` 的
 *   `DatabaseModule`，不需要在这里 import。
 */
@Module({
  imports: [ParentModule, ProgressModule],
  controllers: [ParentInsightsController],
  providers: [
    DashboardService,
    ParentInsightsRepository,
    StudentsRepository,
    SubjectsRepository,
  ],
})
export class ParentInsightsModule {}
```

修改 `apps/server/src/app.module.ts`：在 `import { PointsModule } from './modules/points/points.module.js';` 之后加

```ts
import { ParentInsightsModule } from './modules/parent-insights/parent-insights.module.js';
```

并把 `imports` 数组里的 `PointsModule,` 改成

```ts
    PointsModule,
    // 家长端「看得见」批（2026-09-18）——仪表盘/学情报告/错题查看/AI 对话回放（纯只读）
    ParentInsightsModule,
```

- [ ] **Step 13: 真启动一次（DI 缺依赖只在启动时暴露，tsc 抓不到）**

> ⚠️ **不要用 `pkill -f 'node dist/main.js'`**：开发机上很可能有别人（或控制侧）已经跑着的后端，
> 一句 pkill 会把它一起杀掉。用**独立端口 + 按 PID 精确收尾**：

```bash
cd apps/server && npm run build
# 用 3399 而不是默认端口，避免撞上已在跑的服务
PORT=3399 node dist/main.js > /tmp/pi-smoke.log 2>&1 &
SMOKE_PID=$!
sleep 6
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3399/api/parent/dashboard
kill "$SMOKE_PID"
grep -E "dependencies initialized|Mapped \{/api/parent/dashboard|successfully started" /tmp/pi-smoke.log
```
Expected: 构建无错；日志出现 `ParentInsightsModule dependencies initialized`、`Mapped {/api/parent/dashboard, GET}`、
`Nest application successfully started`；`curl` 返回 `401`（无 token，被守卫拦下）——**返回 401 就说明模块装配与 DI 都对**。
若日志报 `Nest can't resolve dependencies of DashboardService (...)`，就是 `providers` 少列了仓储。若报 `EADDRINUSE`，
说明 3399 也被占用，**换一个端口重试**，不要 kill 占用者。

- [ ] **Step 14: 跑全量后端测试**

Run: `cd apps/server && npm test`
Expected: 全绿（原先 748 个用例 + 本批新增）

- [ ] **Step 15: 提交**

```bash
git add apps/server/src/modules/parent-insights apps/server/src/app.module.ts
git commit -m "feat(parent-insights): 家长仪表盘模块与端点（多孩聚合 + 归属校验）"
```

---

### Task 8: ReportService + report 端点

**Files:**
- Modify: `apps/server/src/modules/parent-insights/dto/parent-insights.dto.ts`
- Create: `apps/server/src/modules/parent-insights/report.service.ts`
- Modify: `apps/server/src/modules/parent-insights/parent-insights.controller.ts`
- Modify: `apps/server/src/modules/parent-insights/parent-insights.module.ts`
- Test: `apps/server/src/modules/parent-insights/report.service.test.ts`

**Interfaces:**
- Consumes: Task 7 的 `resolveWindow` / `startOfDaysAgo` / `toRate`、Task 1–4 的 `ParentInsightsRepository`、`ParentService.requireOwnedStudent`
- Produces:
  - DTO: `TrendPoint`、`ReportStats`、`ReportSubjectRow`、`WeakPointItem`、`ExamRecord`、`LearningReport`
  - `class ReportService { getReport(studentId: number, period: ReportPeriod): Promise<LearningReport> }`
  - 端点 `GET /api/parent/students/:studentId/reports`（`period` 非法 → 回落 `weekly`，见 spec §6）

- [ ] **Step 1: 写失败的测试**

创建 `apps/server/src/modules/parent-insights/report.service.test.ts`：

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ReportService } from './report.service.js';

afterEach(() => {
  vi.useRealTimers();
});

const mkRepo = () => ({
  getActivitySummary: vi.fn().mockResolvedValue({
    lastActiveAt: new Date('2026-09-18T20:11:00Z'), activeDays: 3,
  }),
  getAccuracyBySubject: vi.fn().mockResolvedValue([{ subjectId: 1, answered: 42, correct: 31 }]),
  getSelfAssessBySubject: vi.fn().mockResolvedValue([{ subjectId: 1, count: 5, correctCount: 3 }]),
  getExamCounts: vi.fn().mockResolvedValue([{ subjectId: 1, count: 2 }]),
  getErrorDateCounts: vi.fn().mockResolvedValue({ added: 6, cleared: 4 }),
  getAccuracyTrend: vi.fn().mockResolvedValue([{ date: '2026-09-15', answered: 10, correct: 7 }]),
  getWeakPoints: vi.fn().mockResolvedValue([
    { knowledgePointId: 42, name: '分数加减', unclearedCount: 3, totalWrongCount: 5 },
  ]),
  countUncoveredUnclearedErrors: vi.fn().mockResolvedValue(8),
  listSubmittedExams: vi.fn().mockResolvedValue([
    {
      sessionId: 7, paperTitle: '2025 学年七年级上期中', subjectId: 1,
      submittedAt: new Date('2026-09-16T19:20:00Z'), correctCount: 18, objectiveCount: 22,
    },
  ]),
});

const mk = (overrides: Record<string, any> = {}) => ({
  repo: mkRepo(),
  subjectsRepo: { findAll: vi.fn().mockResolvedValue([{ id: 1, name: '数学' }]) },
  ...overrides,
});

const mkSvc = (d: ReturnType<typeof mk>) => new ReportService(d.repo as any, d.subjectsRepo as any);

describe('ReportService', () => {
  it('weekly：窗口 7 天，聚合 stats / trend / subjects / weakPoints / exams', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T15:30:00'));
    const d = mk();

    const result = await mkSvc(d).getReport(11, 'weekly');

    expect(result.studentId).toBe(11);
    expect(result.period).toBe('weekly');
    expect(result.windowStart).toBe('2026-09-12');
    expect(result.windowEnd).toBe('2026-09-18');
    expect(result.stats).toEqual({
      activeDays: 3, answered: 42, correct: 31, rate: 73.8,
      selfAssessCount: 5, errorsAdded: 6, errorsCleared: 4, examCount: 2,
    });
    expect(result.trend).toEqual([{ date: '2026-09-15', answered: 10, correct: 7, rate: 70 }]);
    expect(result.subjects).toEqual([
      { subjectId: 1, subjectName: '数学', answered: 42, correct: 31, rate: 73.8 },
    ]);
    expect(result.weakPoints).toEqual([
      { knowledgePointId: 42, name: '分数加减', unclearedCount: 3, totalWrongCount: 5 },
    ]);
    expect(result.weakPointsUncoveredCount).toBe(8);
    expect(result.exams).toEqual([
      {
        sessionId: 7, paperTitle: '2025 学年七年级上期中', subjectName: '数学',
        submittedAt: new Date('2026-09-16T19:20:00Z'), correctCount: 18, objectiveCount: 22, rate: 81.8,
      },
    ]);
  });

  it('窗口口径：五个窗口聚合方法都收到同一对 [start, endExclusive)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T15:30:00'));
    const d = mk();
    const from = new Date(2026, 8, 12);
    const to = new Date(2026, 8, 19);

    await mkSvc(d).getReport(11, 'weekly');

    expect(d.repo.getActivitySummary).toHaveBeenCalledWith(11, from);
    expect(d.repo.getAccuracyBySubject).toHaveBeenCalledWith(11, from, to);
    expect(d.repo.getSelfAssessBySubject).toHaveBeenCalledWith(11, from, to);
    expect(d.repo.getExamCounts).toHaveBeenCalledWith(11, from, to);
    expect(d.repo.getErrorDateCounts).toHaveBeenCalledWith(11, from, to);
    expect(d.repo.getAccuracyTrend).toHaveBeenCalledWith(11, from, to);
  });

  it('weakPoints 与 uncovered 是**累计**口径；exams 也不限窗口', async () => {
    const d = mk();

    await mkSvc(d).getReport(11, 'monthly');

    expect(d.repo.getWeakPoints).toHaveBeenCalledWith(11, 10);
    expect(d.repo.countUncoveredUnclearedErrors).toHaveBeenCalledWith(11);
    expect(d.repo.listSubmittedExams).toHaveBeenCalledWith(11, 20);
  });

  it('跨学科汇总 stats：answered/correct 是各学科之和，rate 现算', async () => {
    const d = mk({
      repo: {
        ...mkRepo(),
        getAccuracyBySubject: vi.fn().mockResolvedValue([
          { subjectId: 1, answered: 30, correct: 20 },
          { subjectId: 2, answered: 10, correct: 9 },
        ]),
      },
    });

    const result = await mkSvc(d).getReport(11, 'weekly');

    expect(result.stats.answered).toBe(40);
    expect(result.stats.correct).toBe(29);
    expect(result.stats.rate).toBe(72.5);
  });

  it('完全无数据 → 全 0 / rate null / 空数组（不是 404）', async () => {
    const d = mk({
      repo: {
        ...mkRepo(),
        getActivitySummary: vi.fn().mockResolvedValue({ lastActiveAt: null, activeDays: 0 }),
        getAccuracyBySubject: vi.fn().mockResolvedValue([]),
        getSelfAssessBySubject: vi.fn().mockResolvedValue([]),
        getExamCounts: vi.fn().mockResolvedValue([]),
        getErrorDateCounts: vi.fn().mockResolvedValue({ added: 0, cleared: 0 }),
        getAccuracyTrend: vi.fn().mockResolvedValue([]),
        getWeakPoints: vi.fn().mockResolvedValue([]),
        countUncoveredUnclearedErrors: vi.fn().mockResolvedValue(0),
        listSubmittedExams: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await mkSvc(d).getReport(11, 'weekly');

    expect(result.stats).toMatchObject({
      activeDays: 0, answered: 0, correct: 0, rate: null, selfAssessCount: 0,
    });
    expect(result.trend).toEqual([]);
    expect(result.subjects).toEqual([]);
    expect(result.weakPoints).toEqual([]);
    expect(result.exams).toEqual([]);
  });

  it('学科名缺失时兜底为空串（不崩）', async () => {
    const d = mk({ subjectsRepo: { findAll: vi.fn().mockResolvedValue([]) } });

    const result = await mkSvc(d).getReport(11, 'weekly');

    expect(result.subjects[0].subjectName).toBe('');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/parent-insights/report.service.test.ts`
Expected: FAIL — `Failed to resolve import "./report.service.js"`

- [ ] **Step 3: 追加 DTO**

追加到 `dto/parent-insights.dto.ts`：

```ts
/** 报告页折线的一点（只含有记录的天）。 */
export interface TrendPoint {
  date: string;
  answered: number;
  correct: number;
  rate: number | null;
}

/** 报告页顶部数字卡。窗口口径见 spec §4.2 ②。 */
export interface ReportStats {
  activeDays: number;
  answered: number;
  correct: number;
  rate: number | null;
  selfAssessCount: number;
  errorsAdded: number;
  errorsCleared: number;
  examCount: number;
}

/** 报告页柱状：窗口内按学科的答题量与正确率。 */
export interface ReportSubjectRow {
  subjectId: number;
  subjectName: string;
  answered: number;
  correct: number;
  rate: number | null;
}

/** 薄弱点（错题数代理，不是掌握度）。 */
export interface WeakPointItem {
  knowledgePointId: number;
  name: string;
  unclearedCount: number;
  totalWrongCount: number;
}

/** 报告页考试记录一行。 */
export interface ExamRecord {
  sessionId: number;
  paperTitle: string;
  subjectName: string;
  submittedAt: Date;
  correctCount: number;
  objectiveCount: number;
  rate: number | null;
}

/**
 * 学情报告（spec §4.2 ②）——**实时聚合，不落 `learning_reports`、不调 LLM**。
 *
 * 契约变更：本结构取代了 openapi 里原 `LearningReport` / `ReportContent`
 * （`summary/strengths/weaknesses/suggestions` 的 AI 文本形状），且
 * `GET .../reports/{reportId}` 已降级出 MVP。
 */
export interface LearningReport {
  studentId: number;
  period: 'weekly' | 'monthly';
  windowStart: string;
  windowEnd: string;
  stats: ReportStats;
  trend: TrendPoint[];
  subjects: ReportSubjectRow[];
  /** Top 10，按未清零错题数降序。**累计口径**（不限窗口）。 */
  weakPoints: WeakPointItem[];
  /** 未清零错题里映射不到知识点的条数（实测约占 60%），UI 必须显式提示。 */
  weakPointsUncoveredCount: number;
  /** 全部考试史，最多 20 场（不限窗口）。 */
  exams: ExamRecord[];
}
```

- [ ] **Step 4: 实现 ReportService**

创建 `apps/server/src/modules/parent-insights/report.service.ts`：

```ts
import { Injectable } from '@nestjs/common';
import { SubjectsRepository } from '../../database/repositories/subjects.repo.js';
import { ParentInsightsRepository } from '../../database/repositories/parent-insights.repo.js';
import { resolveWindow } from './window.util.js';
import type { ReportPeriod } from './window.util.js';
import { toRate } from './rate.util.js';
import type {
  LearningReport,
  ReportSubjectRow,
  TrendPoint,
} from './dto/parent-insights.dto.js';

/** 薄弱点取前 N 个；考试记录取最近 N 场。 */
const WEAK_POINT_LIMIT = 10;
const EXAM_LIMIT = 20;

/**
 * 学情报告（spec §4.2 ②）：**纯实时聚合**，不落库、不调 LLM。
 *
 * 两套口径**必须分清**（spec §4.2 ② 逐条写明）：
 * - **窗口口径**（近 7 / 30 天）：`stats` 全部字段、`trend`、`subjects`
 * - **累计口径**（不限窗口）：`weakPoints` + `weakPointsUncoveredCount`（「现在还剩哪些没清」
 *   才是家长关心的）、`exams`（让家长看到全部考试史）
 */
@Injectable()
export class ReportService {
  constructor(
    private readonly repo: ParentInsightsRepository,
    private readonly subjectsRepo: SubjectsRepository,
  ) {}

  async getReport(studentId: number, period: ReportPeriod): Promise<LearningReport> {
    const window = resolveWindow(period);
    const { start, endExclusive } = window;

    // 窗口口径
    const [activity, accuracy, selfAssess, examCounts, errorCounts, trend] = await Promise.all([
      this.repo.getActivitySummary(studentId, start),
      this.repo.getAccuracyBySubject(studentId, start, endExclusive),
      this.repo.getSelfAssessBySubject(studentId, start, endExclusive),
      this.repo.getExamCounts(studentId, start, endExclusive),
      this.repo.getErrorDateCounts(studentId, start, endExclusive),
      this.repo.getAccuracyTrend(studentId, start, endExclusive),
    ]);

    // 累计口径
    const [weakPoints, uncovered, exams, subjects] = await Promise.all([
      this.repo.getWeakPoints(studentId, WEAK_POINT_LIMIT),
      this.repo.countUncoveredUnclearedErrors(studentId),
      this.repo.listSubmittedExams(studentId, EXAM_LIMIT),
      this.subjectsRepo.findAll(),
    ]);
    const subjectNames = new Map(subjects.map((s) => [s.id, s.name]));

    const answered = accuracy.reduce((sum, r) => sum + r.answered, 0);
    const correct = accuracy.reduce((sum, r) => sum + r.correct, 0);
    const selfAssessCount = selfAssess.reduce((sum, r) => sum + r.count, 0);
    const examCount = examCounts.reduce((sum, r) => sum + r.count, 0);

    const subjectRows: ReportSubjectRow[] = accuracy.map((r) => ({
      subjectId: r.subjectId,
      subjectName: subjectNames.get(r.subjectId) ?? '',
      answered: r.answered,
      correct: r.correct,
      rate: toRate(r.answered, r.correct),
    }));

    const trendPoints: TrendPoint[] = trend.map((t) => ({
      date: t.date,
      answered: t.answered,
      correct: t.correct,
      rate: toRate(t.answered, t.correct),
    }));

    return {
      studentId,
      period,
      windowStart: window.startDay,
      windowEnd: window.endDay,
      stats: {
        activeDays: activity.activeDays,
        answered,
        correct,
        rate: toRate(answered, correct),
        selfAssessCount,
        errorsAdded: errorCounts.added,
        errorsCleared: errorCounts.cleared,
        examCount,
      },
      trend: trendPoints,
      subjects: subjectRows,
      weakPoints,
      weakPointsUncoveredCount: uncovered,
      exams: exams.map((e) => ({
        sessionId: e.sessionId,
        paperTitle: e.paperTitle,
        subjectName: subjectNames.get(e.subjectId) ?? '',
        submittedAt: e.submittedAt,
        correctCount: e.correctCount,
        objectiveCount: e.objectiveCount,
        rate: toRate(e.objectiveCount, e.correctCount),
      })),
    };
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/parent-insights/report.service.test.ts`
Expected: PASS（本任务新增的用例全绿）

- [ ] **Step 6: 加端点**

修改 `parent-insights.controller.ts`：把 import 区与类体改成下面这样（新增 `Query`、`Param`、`ParseIntPipe`、`z`、`BadRequestException`、`ParentService`、`ReportService`）：

```ts
import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import type { JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import { ParentService } from '../parent/parent.service.js';
import { DashboardService } from './dashboard.service.js';
import { ReportService } from './report.service.js';
import type { LearningReport, ParentDashboard } from './dto/parent-insights.dto.js';
import type { ReportPeriod } from './window.util.js';

/** `period` 只认这两个值；非法值**回落 `weekly`**（spec §6：查询类参数宽容回落，不 400）。 */
const PeriodSchema = z.enum(['weekly', 'monthly']);

@Controller('api/parent')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('parent')
export class ParentInsightsController {
  constructor(
    private readonly parentService: ParentService,
    private readonly dashboardService: DashboardService,
    private readonly reportService: ReportService,
  ) {}

  /** P6.1 家长仪表盘：一次返回名下所有孩子的概览（含各自的按学科卡片）。 */
  @Get('dashboard')
  async getDashboard(@CurrentUser() user: JwtUser): Promise<ParentDashboard> {
    return this.dashboardService.getDashboard(user.sub);
  }

  /** P6.2 学情报告：**实时聚合**，不落 `learning_reports`。 */
  @Get('students/:studentId/reports')
  async getReport(
    @CurrentUser() user: JwtUser,
    @Param('studentId', ParseIntPipe) studentId: number,
    @Query('period') period?: string,
  ): Promise<LearningReport> {
    await this.parentService.requireOwnedStudent(user.sub, studentId);
    const parsed = PeriodSchema.safeParse(period);
    return this.reportService.getReport(studentId, (parsed.success ? parsed.data : 'weekly') as ReportPeriod);
  }
}
```

修改 `parent-insights.module.ts`：`providers` 里加 `ReportService`（`ParentService` 由 `ParentModule` 导出，控制器直接注入即可，**不要**在这里重复 provide —— 会分裂实例）：

```ts
  providers: [
    DashboardService,
    ReportService,
    ParentInsightsRepository,
    StudentsRepository,
    SubjectsRepository,
  ],
```

- [ ] **Step 7: 跑全量后端测试 + 真启动**

Run: `cd apps/server && npm test && npm run build`
Expected: 全绿 + 构建无错。

- [ ] **Step 8: 提交**

```bash
git add apps/server/src/modules/parent-insights
git commit -m "feat(parent-insights): 学情报告端点（实时聚合，周/月窗口）"
```

---

### Task 9: ErrorsService + errors 端点

**Files:**
- Modify: `apps/server/src/modules/parent-insights/dto/parent-insights.dto.ts`
- Create: `apps/server/src/modules/parent-insights/errors.service.ts`
- Modify: `apps/server/src/modules/parent-insights/parent-insights.controller.ts`
- Modify: `apps/server/src/modules/parent-insights/parent-insights.module.ts`
- Test: `apps/server/src/modules/parent-insights/errors.service.test.ts`

**Interfaces:**
- Consumes: Task 5 的 `listParentErrors(studentId, filters, limit, offset)` + `listErrorKnowledgePoints(questionIds)` + `ParentErrorFilters`、`modules/points/pagination.util.ts` 的 `DEFAULT_PAGE` / `parsePositiveInt`
- Produces:
  - DTO: `ParentErrorQuestion`、`ParentErrorItem`、`ParentErrorPage`
  - `const PAGE_SIZE = 20`（服务端固定，前端不传）
  - `class ErrorsService { listErrors(studentId: number, query: ErrorsQuery): Promise<ParentErrorPage> }`
  - `interface ErrorsQuery { subject?: number; source?: string; track?: 'main' | 'aux'; cleared?: 'uncleared' | 'cleared' | 'all'; from?: string; to?: string; page: number }`
  - 端点 `GET /api/parent/students/:studentId/errors`

> **service 要负责把「本页错题」与「本页知识点」拼起来**：仓储的分页查询**刻意不 JOIN 知识点**（一题多 KP 会让行翻倍、把分页算错，见 Task 5 的说明），知识点由 `listErrorKnowledgePoints(本页去重后的 questionIds)` 另查一次，再按 questionId 聚成 `question.knowledgePoints[]`。本页没有错题、或本页的错题全都没有 `question_id` 时，**跳过这次查询**。

- [ ] **Step 1: 写失败的测试**

创建 `apps/server/src/modules/parent-insights/errors.service.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { ErrorsService } from './errors.service.js';

const row = (over: Record<string, any> = {}) => ({
  id: 91, questionId: 330, subjectId: 1, source: 'exam', level: 2, isCleared: false,
  wrongAnswerText: 'x=3', createdAt: new Date('2026-09-16T19:21:00Z'), clearedAt: null,
  questionContent: '解方程', questionType: 'calculation', questionDifficulty: 3,
  ...over,
});

const mkRepo = () => ({
  listParentErrors: vi.fn().mockResolvedValue({ items: [row()], total: 139 }),
  listErrorKnowledgePoints: vi.fn().mockResolvedValue([
    { questionId: 330, knowledgePointId: 42, knowledgePointName: '分数加减' },
  ]),
});

const mkSvc = (d = mkRepo()) => new ErrorsService(d as any);

describe('ErrorsService', () => {
  it('track 映射：auxiliary → aux，其余 → main；知识点按 questionId 聚成数组', async () => {
    const repo = mkRepo();
    repo.listParentErrors.mockResolvedValue({
      items: [row(), row({ id: 92, questionId: 331, source: 'auxiliary' })],
      total: 2,
    });
    // 330 绑两个 KP、331 未绑 —— 一次批量查询同时覆盖两种情况
    repo.listErrorKnowledgePoints.mockResolvedValue([
      { questionId: 330, knowledgePointId: 42, knowledgePointName: '分数加减' },
      { questionId: 330, knowledgePointId: 43, knowledgePointName: '整式' },
    ]);

    const result = await mkSvc(repo).listErrors(11, { page: 1 });

    expect(result.items[0]).toMatchObject({ track: 'main', source: 'exam' });
    expect(result.items[1]).toMatchObject({ track: 'aux', source: 'auxiliary' });
    expect(result.items[0].question).toEqual({
      content: '解方程', type: 'calculation', difficulty: 3,
      knowledgePoints: [
        { id: 42, name: '分数加减' },
        { id: 43, name: '整式' },
      ],
    });
    // 未绑 KP 的那道题是空数组，不是 null
    expect(result.items[1].question?.knowledgePoints).toEqual([]);
    // 只查一次，入参是本页**去重后**的 questionId
    expect(repo.listErrorKnowledgePoints).toHaveBeenCalledTimes(1);
    expect(repo.listErrorKnowledgePoints).toHaveBeenCalledWith([330, 331]);
  });

  it('pageSize 固定 20，offset 由 page 推', async () => {
    const repo = mkRepo();

    const result = await mkSvc(repo).listErrors(11, { page: 3 });

    expect(repo.listParentErrors).toHaveBeenCalledWith(11, {}, 20, 40);
    expect(result).toMatchObject({ page: 3, pageSize: 20, total: 139 });
  });

  it('cleared=all（或不传）→ 不传给仓储；uncleared/cleared 原样透传', async () => {
    const repo = mkRepo();

    await mkSvc(repo).listErrors(11, { page: 1, cleared: 'all' });
    expect(repo.listParentErrors).toHaveBeenCalledWith(11, {}, 20, 0);

    await mkSvc(repo).listErrors(11, { page: 1, cleared: 'uncleared' });
    expect(repo.listParentErrors).toHaveBeenLastCalledWith(11, { cleared: 'uncleared' }, 20, 0);
  });

  it('question_id 为 NULL → question 整体为 null；且不拿空列表去查知识点', async () => {
    const repo = mkRepo();
    repo.listParentErrors.mockResolvedValue({
      items: [row({ questionId: null, questionContent: null, questionType: null, questionDifficulty: null })],
      total: 1,
    });

    const result = await mkSvc(repo).listErrors(11, { page: 1 });

    expect(result.items[0].question).toBeNull();
    expect(result.items[0].wrongAnswerText).toBe('x=3');
    // 本页没有可查的 questionId → 跳过批量查询（仓储对空数组也会早返回，少一次调用更省）
    expect(repo.listErrorKnowledgePoints).not.toHaveBeenCalled();
  });

  it('本页没有错题 → 不查知识点（避免无谓查询）', async () => {
    const repo = mkRepo();
    repo.listParentErrors.mockResolvedValue({ items: [], total: 0 });

    await mkSvc(repo).listErrors(11, { page: 1 });

    expect(repo.listErrorKnowledgePoints).not.toHaveBeenCalled();
  });

  it('无数据 → items 空数组 + total 0（不是 404）', async () => {
    const repo = mkRepo();
    repo.listParentErrors.mockResolvedValue({ items: [], total: 0 });

    const result = await mkSvc(repo).listErrors(11, { page: 1 });

    expect(result).toEqual({ items: [], page: 1, pageSize: 20, total: 0 });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/parent-insights/errors.service.test.ts`
Expected: FAIL — `Failed to resolve import "./errors.service.js"`

- [ ] **Step 3: 追加 DTO**

追加到 `dto/parent-insights.dto.ts`：

```ts
/** 错题里嵌套的题目信息；`main_error_books.question_id` 为 NULL 时整个 `question` 为 null。 */
export interface ParentErrorQuestion {
  content: string;
  type: string;
  difficulty: number | null;
  /** 未绑知识点时是**空数组**，不是 null（前端不必判两遍）。 */
  knowledgePoints: Array<{ id: number; name: string }>;
}

/**
 * 家长端错题一行（只读）。
 *
 * `track` 由 `source` 现算、**不落库**：`source === 'auxiliary'` → `'aux'`，其余 → `'main'`。
 * 与 `openapi` 原 `ErrorItem` 的差别：`source` enum 按**实际 5 个值**修正（原 enum 只有
 * `homework/unit_test/midterm/final/auxiliary/practice/discuss`，缺 `exam`/`targeted`/`error_practice`）。
 */
export interface ParentErrorItem {
  id: number;
  questionId: number | null;
  track: 'main' | 'aux';
  source: string;
  level: number;
  isCleared: boolean;
  wrongAnswerText: string | null;
  createdAt: Date;
  clearedAt: Date | null;
  question: ParentErrorQuestion | null;
}

/** 分页壳（`pageSize` 服务端固定 20，前端不传）。 */
export interface ParentErrorPage {
  items: ParentErrorItem[];
  page: number;
  pageSize: number;
  total: number;
}
```

- [ ] **Step 4: 实现 ErrorsService**

创建 `apps/server/src/modules/parent-insights/errors.service.ts`：

```ts
import { Injectable } from '@nestjs/common';
import { ParentInsightsRepository } from '../../database/repositories/parent-insights.repo.js';
import type { ParentErrorFilters } from '../../database/repositories/parent-insights.repo.js';
import type { ParentErrorItem, ParentErrorPage } from './dto/parent-insights.dto.js';

/** 服务端固定页大小：前端不传 `pageSize`（沿用家长端既有约定）。 */
export const PAGE_SIZE = 20;

export interface ErrorsQuery {
  subject?: number;
  source?: string;
  track?: 'main' | 'aux';
  cleared?: 'uncleared' | 'cleared' | 'all';
  from?: string;
  to?: string;
  page: number;
}

/**
 * 家长端错题查看（spec §4.2 ③）：**只读**，复用主线错题本 `main_error_books`。
 *
 * `track` 只在**响应里现算**、不落库，也**不参与筛选**——筛选走仓储的 `track` 反向排除
 * （`main` → `source <> 'auxiliary'`），由仓储负责 SQL 语义。
 */
@Injectable()
export class ErrorsService {
  constructor(private readonly repo: ParentInsightsRepository) {}

  async listErrors(studentId: number, query: ErrorsQuery): Promise<ParentErrorPage> {
    const filters: ParentErrorFilters = {};
    if (query.subject !== undefined) filters.subjectId = query.subject;
    if (query.source) filters.source = query.source;
    if (query.track) filters.track = query.track;
    // `cleared=all` 与不传等价：都不过滤清零态
    if (query.cleared === 'uncleared' || query.cleared === 'cleared') {
      filters.cleared = query.cleared;
    }
    if (query.from) filters.from = query.from;
    if (query.to) filters.to = query.to;

    const offset = (query.page - 1) * PAGE_SIZE;
    const { items, total } = await this.repo.listParentErrors(
      studentId,
      filters,
      PAGE_SIZE,
      offset,
    );

    // 知识点单独批量取：分页查询刻意不 JOIN KP（一题多 KP 会让行翻倍、把分页算错）。
    // 先去重（同一道题可能在同一页出现多次…不会，但去重能避免 IN 列表白长）；
    // 本页没有可查的 questionId 时跳过 —— 仓储对空数组也早返回，少一次调用更省。
    const questionIds = [
      ...new Set(items.map((r) => r.questionId).filter((id): id is number => id !== null)),
    ];
    const kpRows =
      questionIds.length > 0 ? await this.repo.listErrorKnowledgePoints(questionIds) : [];
    const kpByQuestion = new Map<number, Array<{ id: number; name: string }>>();
    for (const kp of kpRows) {
      const list = kpByQuestion.get(kp.questionId) ?? [];
      list.push({ id: kp.knowledgePointId, name: kp.knowledgePointName });
      kpByQuestion.set(kp.questionId, list);
    }

    return {
      items: items.map((r) => ({
        id: r.id,
        questionId: r.questionId,
        track: r.source === 'auxiliary' ? 'aux' : 'main',
        source: r.source,
        level: r.level,
        isCleared: r.isCleared,
        wrongAnswerText: r.wrongAnswerText,
        createdAt: r.createdAt,
        clearedAt: r.clearedAt,
        question:
          r.questionContent === null
            ? null
            : {
                content: r.questionContent,
                type: r.questionType ?? '',
                difficulty: r.questionDifficulty,
                knowledgePoints:
                  r.questionId === null ? [] : (kpByQuestion.get(r.questionId) ?? []),
              },
      })),
      page: query.page,
      pageSize: PAGE_SIZE,
      total,
    };
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/parent-insights/errors.service.test.ts`
Expected: PASS（本任务新增的用例全绿）

- [ ] **Step 6: 加端点**

在 `parent-insights.controller.ts` 的 import 区加：

```ts
import { ErrorsService } from './errors.service.js';
import type { ErrorsQuery } from './errors.service.js';
import type { ParentErrorPage } from './dto/parent-insights.dto.js';
import { DEFAULT_PAGE, parsePositiveInt } from '../points/pagination.util.js';
```

构造参数加 `private readonly errorsService: ErrorsService,`，并加端点：

```ts
  /** P6.3 错题查看（只读）。`pageSize` 服务端固定 20；`page` 非法 → 400/1001。 */
  @Get('students/:studentId/errors')
  async listErrors(
    @CurrentUser() user: JwtUser,
    @Param('studentId', ParseIntPipe) studentId: number,
    @Query('subject') subject?: string,
    @Query('source') source?: string,
    @Query('track') track?: string,
    @Query('cleared') cleared?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
  ): Promise<ParentErrorPage> {
    await this.parentService.requireOwnedStudent(user.sub, studentId);

    const query: ErrorsQuery = {
      page: parsePositiveInt(page, 'page', DEFAULT_PAGE),
    };
    if (subject !== undefined && /^\d+$/.test(subject)) query.subject = Number(subject);
    if (source) query.source = source;
    if (track === 'main' || track === 'aux') query.track = track;
    if (cleared === 'uncleared' || cleared === 'cleared') query.cleared = cleared;
    if (from) query.from = from;
    if (to) query.to = to;

    return this.errorsService.listErrors(studentId, query);
  }
```

`parent-insights.module.ts` 的 `providers` 加 `ErrorsService`。

- [ ] **Step 7: 跑全量后端测试 + 构建**

Run: `cd apps/server && npm test && npm run build`
Expected: 全绿 + 构建无错。

- [ ] **Step 8: 提交**

```bash
git add apps/server/src/modules/parent-insights
git commit -m "feat(parent-insights): 错题查看端点（只读 + 筛选 + 固定页大小）"
```

---

### Task 10: ChatLogsService + chat-logs 两个端点

**Files:**
- Modify: `apps/server/src/modules/parent-insights/dto/parent-insights.dto.ts`
- Create: `apps/server/src/modules/parent-insights/chat-logs.service.ts`
- Modify: `apps/server/src/modules/parent-insights/parent-insights.controller.ts`
- Modify: `apps/server/src/modules/parent-insights/parent-insights.module.ts`
- Test: `apps/server/src/modules/parent-insights/chat-logs.service.test.ts`

**Interfaces:**
- Consumes: Task 6 的 `listParentChatLogs(studentId, filters, limit, offset)` + `ParentChatLogFilters`、`AiDialoguesRepository.findById(id): Promise<AiDialogueRow | null>`、`AiMessagesRepository.findByDialogue(dialogueId, lastMessageId?)`、`parsePositiveInt` / `DEFAULT_PAGE`
- Produces:
  - DTO: `ParentChatLogItem`、`ParentChatLogMessage`、`ParentChatLogDetail`、`ParentChatLogPage`
  - `class ChatLogsService { listChatLogs(studentId, query): Promise<ParentChatLogPage>; getChatLog(studentId, dialogueId): Promise<ParentChatLogDetail> }`
  - `interface ChatLogsQuery { track?: 'mainline' | 'auxiliary'; scene?: string; from?: string; to?: string; q?: string; page: number }`
  - 端点 `GET /api/parent/students/:studentId/chat-logs` 与 `GET /api/parent/students/:studentId/chat-logs/:dialogueId`

- [ ] **Step 1: 写失败的测试**

创建 `apps/server/src/modules/parent-insights/chat-logs.service.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { ChatLogsService } from './chat-logs.service.js';

const logRow = {
  id: 55, track: 'auxiliary', scene: 'aux_qna', title: '二次函数求最值', subjectId: null,
  createdAt: new Date('2026-09-16T10:00:00Z'), updatedAt: new Date('2026-09-16T10:05:00Z'),
  messageCount: 8, blockCount: 2,
};

const dialogueRow = {
  id: 55, student_id: 11, track: 'auxiliary', scene: 'aux_qna', title: '二次函数求最值',
  subject_id: null, created_at: new Date('2026-09-16T10:00:00Z'),
  updated_at: new Date('2026-09-16T10:05:00Z'),
};

const messageRow = (over: Record<string, any> = {}) => ({
  id: 201, dialogue_id: 55, role: 'user', content: '怎么求最值', reasoning: null,
  type: null, attachments: null, model: null, token_input: null, token_output: null,
  response_time_ms: null, safety_flag: 0, created_at: new Date('2026-09-16T10:00:30Z'),
  deleted_at: null,
  ...over,
});

const mk = () => ({
  repo: { listParentChatLogs: vi.fn().mockResolvedValue({ items: [logRow], total: 80 }) },
  dialoguesRepo: { findById: vi.fn().mockResolvedValue(dialogueRow) },
  messagesRepo: { findByDialogue: vi.fn().mockResolvedValue([messageRow()]) },
});

const mkSvc = (d: ReturnType<typeof mk>) =>
  new ChatLogsService(d.repo as any, d.dialoguesRepo as any, d.messagesRepo as any);

describe('ChatLogsService：列表', () => {
  it('pageSize 固定 20，offset 由 page 推；筛选透传', async () => {
    const d = mk();

    const result = await mkSvc(d).listChatLogs(11, {
      page: 2, track: 'auxiliary', scene: 'aux_qna', from: '2026-09-01', to: '2026-09-18', q: '函数',
    });

    expect(d.repo.listParentChatLogs).toHaveBeenCalledWith(
      11,
      { track: 'auxiliary', scene: 'aux_qna', from: '2026-09-01', to: '2026-09-18', q: '函数' },
      20,
      20,
    );
    expect(result).toMatchObject({ page: 2, pageSize: 20, total: 80 });
    expect(result.items[0]).toMatchObject({ id: 55, track: 'auxiliary', messageCount: 8, blockCount: 2 });
  });

  it('无筛选 → 空 filters（不塞 undefined 字段）', async () => {
    const d = mk();

    await mkSvc(d).listChatLogs(11, { page: 1 });

    expect(d.repo.listParentChatLogs).toHaveBeenCalledWith(11, {}, 20, 0);
  });

  it('无数据 → items 空 + total 0', async () => {
    const d = mk();
    d.repo.listParentChatLogs.mockResolvedValue({ items: [], total: 0 });

    expect(await mkSvc(d).listChatLogs(11, { page: 1 })).toEqual({
      items: [], page: 1, pageSize: 20, total: 0,
    });
  });
});

describe('ChatLogsService：详情', () => {
  it('返回逐句消息（含 reasoning 与 safetyFlag）', async () => {
    const d = mk();
    d.messagesRepo.findByDialogue.mockResolvedValue([
      messageRow(),
      messageRow({ id: 202, role: 'assistant', content: '先判断开口方向', reasoning: '开口向上', type: 'socratic', model: 'qwen3.8-max' }),
      messageRow({ id: 203, role: 'assistant', content: '我是你的学习助手…', type: 'block', safety_flag: 1 }),
    ]);

    const result = await mkSvc(d).getChatLog(11, 55);

    expect(d.messagesRepo.findByDialogue).toHaveBeenCalledWith(55);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[1]).toMatchObject({
      id: 202, role: 'assistant', reasoning: '开口向上', type: 'socratic', model: 'qwen3.8-max', safetyFlag: 0,
    });
    expect(result.messages[2].safetyFlag).toBe(1);
  });

  it('不返回 token / 耗时字段（恒 NULL，返回只会误导）', async () => {
    const d = mk();

    const result = await mkSvc(d).getChatLog(11, 55);

    expect(result.messages[0]).not.toHaveProperty('tokenInput');
    expect(result.messages[0]).not.toHaveProperty('responseTimeMs');
  });

  it('会话不存在 → 1002', async () => {
    const d = mk();
    d.dialoguesRepo.findById.mockResolvedValue(null);

    await expect(mkSvc(d).getChatLog(11, 55)).rejects.toMatchObject({
      response: { code: 1002 },
    });
  });

  it('会话属于别的学生 → 1002（不泄漏存在性，防 IDOR）', async () => {
    const d = mk();
    d.dialoguesRepo.findById.mockResolvedValue({ ...dialogueRow, student_id: 999 });

    await expect(mkSvc(d).getChatLog(11, 55)).rejects.toMatchObject({
      response: { code: 1002 },
    });
    expect(d.messagesRepo.findByDialogue).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/parent-insights/chat-logs.service.test.ts`
Expected: FAIL — `Failed to resolve import "./chat-logs.service.js"`

- [ ] **Step 3: 追加 DTO**

追加到 `dto/parent-insights.dto.ts`：

```ts
/** 会话列表一行。`blockCount` = 该会话里 `safety_flag = 1` 的消息数（闲聊/偏离学习标记）。 */
export interface ParentChatLogItem {
  id: number;
  track: string;
  scene: string;
  title: string | null;
  subjectId: number | null;
  createdAt: Date;
  updatedAt: Date;
  messageCount: number;
  blockCount: number;
}

/**
 * 逐句消息。**不回传 `token_input` / `token_output` / `response_time_ms`**——那三列全仓
 * 永远写 NULL（`conversations.service.ts` 写死 null），回传只会让家长误以为「没有消耗」。
 */
export interface ParentChatLogMessage {
  id: number;
  role: 'system' | 'user' | 'assistant';
  content: string;
  reasoning: string | null;
  type: string | null;
  model: string | null;
  safetyFlag: number;
  createdAt: Date;
}

export interface ParentChatLogDetail extends ParentChatLogItem {
  messages: ParentChatLogMessage[];
}

export interface ParentChatLogPage {
  items: ParentChatLogItem[];
  page: number;
  pageSize: number;
  total: number;
}
```

- [ ] **Step 4: 实现 ChatLogsService**

创建 `apps/server/src/modules/parent-insights/chat-logs.service.ts`：

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { ParentInsightsRepository } from '../../database/repositories/parent-insights.repo.js';
import type { ParentChatLogFilters } from '../../database/repositories/parent-insights.repo.js';
import { AiDialoguesRepository } from '../../database/repositories/ai-dialogues.repo.js';
import { AiMessagesRepository } from '../../database/repositories/ai-messages.repo.js';
import type {
  ParentChatLogDetail,
  ParentChatLogPage,
} from './dto/parent-insights.dto.js';

/** 服务端固定页大小：前端不传 `pageSize`。 */
export const PAGE_SIZE = 20;

export interface ChatLogsQuery {
  track?: 'mainline' | 'auxiliary';
  scene?: string;
  from?: string;
  to?: string;
  q?: string;
  page: number;
}

/**
 * 家长端 AI 对话回放（spec §4.2 ④⑤）：**只读**。
 *
 * 筛选只有「轨道 + 场景 + 时间 + 标题关键词」，**没有学科**——实测 76% 的
 * `ai_dialogues.subject_id` 是 NULL（写入侧硬编码），按学科筛会大面积漏（spec §2.3）。
 *
 * 消息读取**直接复用** `AiMessagesRepository.findByDialogue`（不另写 SQL），但归属校验必须
 * 自己做：底层 `findById` 不带归属，不校验就是 IDOR。
 */
@Injectable()
export class ChatLogsService {
  constructor(
    private readonly repo: ParentInsightsRepository,
    private readonly dialoguesRepo: AiDialoguesRepository,
    private readonly messagesRepo: AiMessagesRepository,
  ) {}

  async listChatLogs(studentId: number, query: ChatLogsQuery): Promise<ParentChatLogPage> {
    const filters: ParentChatLogFilters = {};
    if (query.track) filters.track = query.track;
    if (query.scene) filters.scene = query.scene;
    if (query.from) filters.from = query.from;
    if (query.to) filters.to = query.to;
    if (query.q) filters.q = query.q;

    const offset = (query.page - 1) * PAGE_SIZE;
    const { items, total } = await this.repo.listParentChatLogs(
      studentId,
      filters,
      PAGE_SIZE,
      offset,
    );

    return { items, page: query.page, pageSize: PAGE_SIZE, total };
  }

  async getChatLog(studentId: number, dialogueId: number): Promise<ParentChatLogDetail> {
    const dialogue = await this.dialoguesRepo.findById(dialogueId);
    // 存在性与归属失败都用 1002：与 `ParentService.requireOwnedStudent` 同一套语义，
    // 不泄漏「这个 id 是否存在」。
    if (!dialogue || dialogue.student_id !== studentId) {
      throw new NotFoundException({ code: 1002, message: '对话不存在' });
    }

    const messages = await this.messagesRepo.findByDialogue(dialogueId);
    const listItem = {
      id: dialogue.id,
      track: dialogue.track,
      scene: dialogue.scene,
      title: dialogue.title,
      subjectId: dialogue.subject_id,
      createdAt: dialogue.created_at,
      updatedAt: dialogue.updated_at,
      messageCount: messages.length,
      blockCount: messages.filter((m) => m.safety_flag === 1).length,
    };

    return {
      ...listItem,
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        reasoning: m.reasoning,
        type: m.type,
        model: m.model,
        safetyFlag: m.safety_flag,
        createdAt: m.created_at,
      })),
    };
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/parent-insights/chat-logs.service.test.ts`
Expected: PASS（本任务新增的用例全绿）

- [ ] **Step 6: 加端点**

在 `parent-insights.controller.ts` 加 import：

```ts
import { ChatLogsService } from './chat-logs.service.js';
import type { ChatLogsQuery } from './chat-logs.service.js';
import type { ParentChatLogDetail, ParentChatLogPage } from './dto/parent-insights.dto.js';
```

构造参数加 `private readonly chatLogsService: ChatLogsService,`，并加两个端点：

```ts
  /** P6.4 对话回放列表。筛选 = 轨道 + 场景 + 时间 + 标题关键词（无学科，见 service 注释）。 */
  @Get('students/:studentId/chat-logs')
  async listChatLogs(
    @CurrentUser() user: JwtUser,
    @Param('studentId', ParseIntPipe) studentId: number,
    @Query('track') track?: string,
    @Query('scene') scene?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
  ): Promise<ParentChatLogPage> {
    await this.parentService.requireOwnedStudent(user.sub, studentId);

    const query: ChatLogsQuery = { page: parsePositiveInt(page, 'page', DEFAULT_PAGE) };
    if (track === 'mainline' || track === 'auxiliary') query.track = track;
    if (scene) query.scene = scene;
    if (from) query.from = from;
    if (to) query.to = to;
    if (q) query.q = q;

    return this.chatLogsService.listChatLogs(studentId, query);
  }

  /** P6.4 单条对话详情（逐句回放，含 `reasoning` 与闲聊标记）。 */
  @Get('students/:studentId/chat-logs/:dialogueId')
  async getChatLog(
    @CurrentUser() user: JwtUser,
    @Param('studentId', ParseIntPipe) studentId: number,
    @Param('dialogueId', ParseIntPipe) dialogueId: number,
  ): Promise<ParentChatLogDetail> {
    await this.parentService.requireOwnedStudent(user.sub, studentId);
    return this.chatLogsService.getChatLog(studentId, dialogueId);
  }
```

`parent-insights.module.ts`：`providers` 加 `ChatLogsService`、`AiDialoguesRepository`、`AiMessagesRepository`。最终 `providers` 为：

```ts
  providers: [
    DashboardService,
    ReportService,
    ErrorsService,
    ChatLogsService,
    ParentInsightsRepository,
    StudentsRepository,
    SubjectsRepository,
    AiDialoguesRepository,
    AiMessagesRepository,
  ],
```

- [ ] **Step 7: 跑全量后端测试 + 真启动 + 构建**

```bash
cd apps/server && npm run build
PORT=3399 node dist/main.js > /tmp/pi-smoke.log 2>&1 &
SMOKE_PID=$!
sleep 6
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3399/api/parent/students/1/chat-logs
kill "$SMOKE_PID"
```
Expected: 测试全绿、构建无错、`curl` 返回 `401`（无 token 被守卫拦下，说明 DI 装配正常）。
**不要用 `pkill`** —— 会连带杀掉开发机上别人在跑的后端（只按 `$SMOKE_PID` 收尾）。端口占用就换一个，别 kill 占用者。

- [ ] **Step 8: 提交**

```bash
git add apps/server/src/modules/parent-insights
git commit -m "feat(parent-insights): AI 对话回放端点（列表 + 详情 + 跨学生防 IDOR）"
```

---

### Task 11: 前端 — recharts 依赖 + 图表薄封装

**Files:**
- Modify: `apps/web/package.json`（`npm install` 自动改）
- Create: `apps/web/src/components/business/parent/chart-theme.ts`
- Create: `apps/web/src/components/business/parent/ChartLine.tsx`
- Create: `apps/web/src/components/business/parent/ChartBar.tsx`
- Test: `apps/web/src/components/business/parent/chart-theme.test.ts`
- Test: `apps/web/src/components/business/parent/ChartLine.test.tsx`
- Test: `apps/web/src/components/business/parent/ChartBar.test.tsx`

**Interfaces:**
- Produces:
  - `interface ChartPoint { label: string; value: number }`
  - `interface ChartLineProps { points: ChartPoint[]; height?: number; colorToken?: string; emptyText?: string }`
  - `interface ChartBarProps { points: ChartPoint[]; height?: number; colorToken?: string; emptyText?: string }`
  - `readChartColor(token: string, container: Element | null): string`

> **为什么不直接给 recharts 传 `var(--brand-500)`**：`stroke` 是 SVG **表现属性**，`var()` 只在 CSS 声明里有效，写在属性值里浏览器不解析，线会变成默认黑色。
> 必须在挂载后经 `getComputedStyle` 取出真实色值。**家长主题的变量挂在 `[data-theme="parent"]` 容器上、不在 `:root`**，从 `documentElement` 读到的是学生端橙色 —— 所以要从元素向上找最近的 `[data-theme]`。
> `readChartColor` 带一个与 `style.md` 一致的兜底值：jsdom 对自定义属性支持不完整，且生产环境若变量缺失，图表会静默变成黑色（比报错更难发现）。

- [ ] **Step 1: 装依赖**

Run: `cd apps/web && npm install recharts`
Expected: `package.json` 的 `dependencies` 里出现 `"recharts": "^2.x"`。

- [ ] **Step 2: 写 chart-theme 的失败测试**

创建 `apps/web/src/components/business/parent/chart-theme.test.ts`：

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { readChartColor, CHART_FALLBACK } from './chart-theme';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('readChartColor', () => {
  it('从最近的 [data-theme] 容器读变量（家长主题挂容器上，不在 :root）', () => {
    document.body.innerHTML =
      '<div data-theme="parent" style="--brand-500: #2563EB"><span id="inner"></span></div>';
    const container = document.querySelector('[data-theme="parent"]');
    const inner = document.getElementById('inner');

    expect(readChartColor('--brand-500', inner)).toBe('#2563EB');
    expect(readChartColor('--brand-500', container)).toBe('#2563EB');
  });

  it('变量缺失 → 回落兜底值（不是空串 / 黑色）', () => {
    document.body.innerHTML = '<div data-theme="parent"><span id="inner"></span></div>';

    expect(readChartColor('--brand-500', document.getElementById('inner'))).toBe(
      CHART_FALLBACK['--brand-500'],
    );
  });

  it('容器为 null 也不抛（组件可能还没挂载）', () => {
    expect(readChartColor('--brand-500', null)).toBe(CHART_FALLBACK['--brand-500']);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/components/business/parent/chart-theme.test.ts`
Expected: FAIL — `Failed to resolve import "./chart-theme"`

- [ ] **Step 4: 实现 chart-theme**

创建 `apps/web/src/components/business/parent/chart-theme.ts`：

```ts
/**
 * 图表取色（spec §5.3）。
 *
 * **必须从最近的 `[data-theme]` 容器读，不能用 `document.documentElement`**：家长主题
 * （`--brand-500: #2563EB` 商务蓝）定义在 `[data-theme="parent"]` 容器上，而 `:root` 是学生端
 * 日间值（`--brand-500: #ff6b35` 橙）——从根元素读会画出橙色的家长图表。
 *
 * 为什么要有兜底值：`getComputedStyle` 在没有 CSS 环境（jsdom 测试）下返回空串，变量缺失时
 * 图表会静默变成默认黑线——比报错更难发现。兜底值与 `style.md` §2.3 家长主题一致。
 */
export const CHART_FALLBACK: Record<string, string> = {
  '--brand-500': '#2563EB',
  '--brand-400': '#3B82F6',
  '--success': '#10B981',
  '--error': '#DC2626',
  '--text-tertiary': '#9CA3AF',
  '--bg-subtle': '#E5E9F0',
};

/** 从 `container` 向上找最近的 `[data-theme]`，取其上的 CSS 变量真实值。 */
export function readChartColor(token: string, container: Element | null): string {
  const themed = container?.closest('[data-theme]') ?? null;
  if (themed) {
    const value = getComputedStyle(themed).getPropertyValue(token).trim();
    if (value) return value;
  }
  return CHART_FALLBACK[token] ?? '#000000';
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/components/business/parent/chart-theme.test.ts`
Expected: PASS（本任务新增的用例全绿）

> 已实测确认：jsdom **支持**用 `getComputedStyle(el).getPropertyValue('--x')` 读**内联**声明的自定义属性
> （探针：`<div data-theme="parent" style="--brand-500: #2563EB">` → 返回 `#2563EB`）。
> 所以第 1 个用例照写即可，**不要**为了让它通过而把断言放宽成「等于内联值或兜底值」——
> 那种「两个都可能」的断言等于什么都没验证。

- [ ] **Step 6: 写图表封装的失败测试**

创建 `apps/web/src/components/business/parent/ChartLine.test.tsx`：

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import ChartLine from './ChartLine';

/**
 * 这里 mock 掉 recharts 本体：jsdom 里 `ResponsiveContainer` 量到 0 尺寸、SVG 不真渲染，
 * 断言「图上画了什么」既脆又假。改为断言**我们传给 recharts 的 props**——那才是本封装的
 * 职责（数据、系列、颜色、标签映射）。
 */
const lineProps = vi.fn();
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="chart-container">{children}</div>,
  LineChart: (props: any) => {
    lineProps(props);
    return <div data-testid="line-chart" />;
  },
  Line: (props: any) => <div data-testid="line-series" data-stroke={props.stroke} />,
  XAxis: (props: any) => <div data-testid="x-axis" data-key={props.dataKey} />,
  YAxis: () => <div data-testid="y-axis" />,
  Tooltip: () => <div data-testid="tooltip" />,
  CartesianGrid: (props: any) => <div data-testid="grid" data-stroke={props.stroke} />,
}));

afterEach(() => {
  cleanup();
  lineProps.mockReset();
});

describe('ChartLine', () => {
  it('把 points 映射成 label/value 并交给 recharts', () => {
    render(
      <div data-theme="parent">
        <ChartLine points={[{ label: '09-15', value: 70 }, { label: '09-16', value: 81.8 }]} />
      </div>,
    );

    expect(screen.getByTestId('line-chart')).toBeInTheDocument();
    expect(lineProps).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          { label: '09-15', value: 70 },
          { label: '09-16', value: 81.8 },
        ],
      }),
    );
    expect(screen.getByTestId('x-axis')).toHaveAttribute('data-key', 'label');
  });

  it('空数据 → 渲染空态文案，不渲染图表', () => {
    render(
      <div data-theme="parent">
        <ChartLine points={[]} emptyText="本期还没有记录" />
      </div>,
    );

    expect(screen.getByText('本期还没有记录')).toBeInTheDocument();
    expect(screen.queryByTestId('line-chart')).not.toBeInTheDocument();
  });

  it('series 颜色取自容器上的 CSS 变量（不是 recharts 默认色板）', () => {
    render(
      <div data-theme="parent" style={{ ['--brand-500' as any]: '#2563EB' }}>
        <ChartLine points={[{ label: 'a', value: 1 }]} colorToken="--brand-500" />
      </div>,
    );

    const stroke = screen.getByTestId('line-series').getAttribute('data-stroke');
    expect(stroke).toBeTruthy();
    expect(stroke).not.toBe('#8884d8'); // recharts 默认紫
  });
});
```

创建 `apps/web/src/components/business/parent/ChartBar.test.tsx`：

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import ChartBar from './ChartBar';

const barProps = vi.fn();
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="chart-container">{children}</div>,
  BarChart: (props: any) => {
    barProps(props);
    return <div data-testid="bar-chart" />;
  },
  Bar: (props: any) => <div data-testid="bar-series" data-fill={props.fill} />,
  XAxis: (props: any) => <div data-testid="x-axis" data-key={props.dataKey} />,
  YAxis: () => <div data-testid="y-axis" />,
  Tooltip: () => <div data-testid="tooltip" />,
  CartesianGrid: (props: any) => <div data-testid="grid" data-stroke={props.stroke} />,
}));

afterEach(() => {
  cleanup();
  barProps.mockReset();
});

describe('ChartBar', () => {
  it('把 points 交给 recharts，X 轴用 label', () => {
    render(
      <div data-theme="parent">
        <ChartBar points={[{ label: '数学', value: 73.8 }]} />
      </div>,
    );

    expect(barProps).toHaveBeenCalledWith(
      expect.objectContaining({ data: [{ label: '数学', value: 73.8 }] }),
    );
    expect(screen.getByTestId('x-axis')).toHaveAttribute('data-key', 'label');
  });

  it('空数据 → 空态文案', () => {
    render(
      <div data-theme="parent">
        <ChartBar points={[]} emptyText="本期还没有记录" />
      </div>,
    );

    expect(screen.getByText('本期还没有记录')).toBeInTheDocument();
    expect(screen.queryByTestId('bar-chart')).not.toBeInTheDocument();
  });

  it('series 颜色取自 CSS 变量', () => {
    render(
      <div data-theme="parent" style={{ ['--brand-500' as any]: '#2563EB' }}>
        <ChartBar points={[{ label: 'a', value: 1 }]} colorToken="--brand-500" />
      </div>,
    );

    const fill = screen.getByTestId('bar-series').getAttribute('data-fill');
    expect(fill).toBeTruthy();
    expect(fill).not.toBe('#8884d8');
  });
});
```

- [ ] **Step 7: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/components/business/parent/`
Expected: FAIL — `Failed to resolve import "./ChartLine"`

- [ ] **Step 8: 实现两个封装**

创建 `apps/web/src/components/business/parent/ChartLine.tsx`：

```tsx
import { useMemo, useRef } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { readChartColor } from './chart-theme';

export interface ChartPoint {
  label: string;
  value: number;
}

export interface ChartLineProps {
  points: ChartPoint[];
  height?: number;
  /** CSS 变量名，默认家长主色。**不要**直接传颜色字面量。 */
  colorToken?: string;
  emptyText?: string;
}

const DEFAULT_HEIGHT = 220;

/**
 * 折线图薄封装（spec §5.3）。
 *
 * 三条约束：① 页面不直接依赖 recharts API；② 配色只走 CSS 变量、**不用 recharts 默认色板**；
 * ③ 不做渐变填充、不做装饰（硬规则「不用装饰元素」）。
 */
export default function ChartLine({
  points,
  height = DEFAULT_HEIGHT,
  colorToken = '--brand-500',
  emptyText = '暂无数据',
}: ChartLineProps) {
  const wrapRef = useRef<HTMLDivElement>(null);

  const { line, grid, axis } = useMemo(
    () => ({
      line: readChartColor(colorToken, wrapRef.current),
      grid: readChartColor('--bg-subtle', wrapRef.current),
      axis: readChartColor('--text-tertiary', wrapRef.current),
    }),
    [colorToken],
  );

  if (points.length === 0) {
    return (
      <div
        ref={wrapRef}
        data-testid="chart-empty"
        className="flex items-center justify-center text-sm text-[var(--text-secondary)]"
        style={{ height }}
      >
        {emptyText}
      </div>
    );
  }

  return (
    <div ref={wrapRef}>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={points} margin={{ top: 8, right: 12, bottom: 4, left: -16 }}>
          <CartesianGrid stroke={grid} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" stroke={axis} tick={{ fill: axis, fontSize: 12 }} />
          <YAxis stroke={axis} tick={{ fill: axis, fontSize: 12 }} allowDecimals={false} />
          <Tooltip
            contentStyle={{
              background: '#FFFFFF',
              border: `1px solid ${grid}`,
              borderRadius: 8,
              fontSize: 12,
            }}
          />
          <Line
            type="monotone"
            dataKey="value"
            stroke={line}
            strokeWidth={2}
            dot={{ r: 3, fill: line }}
            activeDot={{ r: 4 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
```

创建 `apps/web/src/components/business/parent/ChartBar.tsx`：

```tsx
import { useMemo, useRef } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { readChartColor } from './chart-theme';
import type { ChartPoint } from './ChartLine';

export interface ChartBarProps {
  points: ChartPoint[];
  height?: number;
  colorToken?: string;
  emptyText?: string;
}

const DEFAULT_HEIGHT = 220;

/** 柱状图薄封装。约束同 `ChartLine`（CSS 变量取色、无装饰、页面不碰 recharts API）。 */
export default function ChartBar({
  points,
  height = DEFAULT_HEIGHT,
  colorToken = '--brand-500',
  emptyText = '暂无数据',
}: ChartBarProps) {
  const wrapRef = useRef<HTMLDivElement>(null);

  const { bar, grid, axis } = useMemo(
    () => ({
      bar: readChartColor(colorToken, wrapRef.current),
      grid: readChartColor('--bg-subtle', wrapRef.current),
      axis: readChartColor('--text-tertiary', wrapRef.current),
    }),
    [colorToken],
  );

  if (points.length === 0) {
    return (
      <div
        ref={wrapRef}
        data-testid="chart-empty"
        className="flex items-center justify-center text-sm text-[var(--text-secondary)]"
        style={{ height }}
      >
        {emptyText}
      </div>
    );
  }

  return (
    <div ref={wrapRef}>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={points} margin={{ top: 8, right: 12, bottom: 4, left: -16 }}>
          <CartesianGrid stroke={grid} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" stroke={axis} tick={{ fill: axis, fontSize: 12 }} />
          <YAxis stroke={axis} tick={{ fill: axis, fontSize: 12 }} allowDecimals={false} />
          <Tooltip
            contentStyle={{
              background: '#FFFFFF',
              border: `1px solid ${grid}`,
              borderRadius: 8,
              fontSize: 12,
            }}
          />
          <Bar dataKey="value" fill={bar} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 9: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/components/business/parent/`
Expected: PASS（本任务新增的用例全绿）

- [ ] **Step 10: 提交**

```bash
git add apps/web/package.json apps/web/package-lock.json apps/web/src/components/business/parent
git commit -m "feat(parent): 引入 recharts 并封装折线/柱状图（CSS 变量取色 + 空态）"
```

---

### Task 12: 前端 — api.ts 六个方法 + 类型

**Files:**
- Modify: `apps/web/src/services/api.ts`
- Test: `apps/web/src/services/api.test.ts`

**Interfaces:**
- Consumes: `fetchApi<T>(path, options?)`（`api.ts` 内既有私有函数，**不是** `request`）
- Produces（全部 `export`，与该文件既有约定一致：类型与端点函数写在同一个文件里）:
  - `getParentDashboard(): Promise<ParentDashboard>`
  - `getParentReport(studentId: number, period: ParentReportPeriod): Promise<ParentLearningReport>`
  - `getParentErrors(params: ParentErrorListParams): Promise<ParentErrorPage>`
  - `getParentChatLogs(params: ParentChatLogListParams): Promise<ParentChatLogPage>`
  - `getParentChatLogDetail(studentId: number, dialogueId: number): Promise<ParentChatLogDetail>`

> 类型名一律加 `Parent` 前缀，避免与已有的 `MyPoints` / `ErrorItem` 之类冲突（`api.ts` 是单文件、命名空间全局）。

- [ ] **Step 1: 写失败的测试**

追加到 `apps/web/src/services/api.test.ts`（文件顶部已从 `vitest` 导入 `describe/it/expect/vi`；若没有 `afterEach`，一并补进那条 import）：

```ts
import { getParentDashboard, getParentErrors, getParentReport, getParentChatLogs, getParentChatLogDetail } from './api';

function stubFetch(data: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ code: 0, message: 'ok', data }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('家长端学情端点：路径与 query', () => {
  it('getParentDashboard → GET /api/parent/dashboard', async () => {
    const fetchMock = stubFetch({ students: [], unreadAlerts: 0 });

    await getParentDashboard();

    expect(fetchMock.mock.calls[0][0]).toBe('/api/parent/dashboard');
    expect(fetchMock.mock.calls[0][1]?.method).toBeUndefined(); // GET 不写 method
  });

  it('getParentReport → 路径 + period query', async () => {
    const fetchMock = stubFetch({});

    await getParentReport(11, 'monthly');

    expect(fetchMock.mock.calls[0][0]).toBe('/api/parent/students/11/reports?period=monthly');
  });

  it('getParentErrors → 只拼有值的 query，page 省略时也不出现', async () => {
    const fetchMock = stubFetch({ items: [], page: 1, pageSize: 20, total: 0 });

    await getParentErrors({ studentId: 11, track: 'main', cleared: 'uncleared' });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url.startsWith('/api/parent/students/11/errors?')).toBe(true);
    expect(url).toContain('track=main');
    expect(url).toContain('cleared=uncleared');
    expect(url).not.toContain('page=');
    expect(url).not.toContain('undefined');
    expect(url).not.toContain('null');
  });

  it('getParentChatLogs → q 走 URL 编码（中文与空格不能裸拼）', async () => {
    const fetchMock = stubFetch({ items: [], page: 1, pageSize: 20, total: 0 });

    await getParentChatLogs({ studentId: 11, q: '二次 函数', page: 2 });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('q=%E4%BA%8C%E6%AC%A1+%E5%87%BD%E6%95%B0');
    expect(url).toContain('page=2');
  });

  it('getParentChatLogDetail → 两级路径', async () => {
    const fetchMock = stubFetch({});

    await getParentChatLogDetail(11, 55);

    expect(fetchMock.mock.calls[0][0]).toBe('/api/parent/students/11/chat-logs/55');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/services/api.test.ts`
Expected: FAIL — `getParentDashboard is not a function`

- [ ] **Step 3: 实现**

在 `apps/web/src/services/api.ts` 的「Parent: student accounts」区块之后追加：

```ts
// --- Parent: 学情可见性（仪表盘/报告/错题/对话回放） ---
// 形状与后端 `apps/server/src/modules/parent-insights/dto/parent-insights.dto.ts` 一一对应；
// `Date` 经 JSON 变成 ISO 字符串。

export interface ParentRateSummary {
  answered: number;
  correct: number;
  /** 未作答时是 null（不是 0）——「暂无数据」与「全错」是两回事。 */
  rate: number | null;
}

export interface ParentDashboardSubject {
  subjectId: number;
  subjectName: string;
  progress: {
    completedUnits: number;
    totalUnits: number;
    currentUnitName: string | null;
    currentLessonName: string | null;
    percent: number;
  };
  accuracy: ParentRateSummary;
  selfAssessed: { count: number; correctCount: number };
  errorBook: { uncleared: number; total: number };
  examCount: number;
}

export interface ParentDashboardStudent {
  studentId: number;
  name: string;
  grade: string | null;
  schoolLevel: string | null;
  lastActiveAt: string | null;
  /** 近 7 天有记录的天数（「学习时长」的代理指标）。 */
  activeDays7: number;
  /** 本期恒 0：`safety_alerts` 尚无写入。 */
  unreadAlerts: number;
  subjects: ParentDashboardSubject[];
}

export interface ParentDashboard {
  students: ParentDashboardStudent[];
  unreadAlerts: number;
}

export function getParentDashboard(): Promise<ParentDashboard> {
  return fetchApi<ParentDashboard>('/parent/dashboard');
}

export type ParentReportPeriod = 'weekly' | 'monthly';

export interface ParentTrendPoint {
  date: string;
  answered: number;
  correct: number;
  rate: number | null;
}

export interface ParentReportStats {
  activeDays: number;
  answered: number;
  correct: number;
  rate: number | null;
  selfAssessCount: number;
  errorsAdded: number;
  errorsCleared: number;
  examCount: number;
}

export interface ParentReportSubjectRow {
  subjectId: number;
  subjectName: string;
  answered: number;
  correct: number;
  rate: number | null;
}

export interface ParentWeakPoint {
  knowledgePointId: number;
  name: string;
  unclearedCount: number;
  totalWrongCount: number;
}

export interface ParentExamRecord {
  sessionId: number;
  paperTitle: string;
  subjectName: string;
  submittedAt: string;
  correctCount: number;
  objectiveCount: number;
  rate: number | null;
}

export interface ParentLearningReport {
  studentId: number;
  period: ParentReportPeriod;
  windowStart: string;
  windowEnd: string;
  stats: ParentReportStats;
  trend: ParentTrendPoint[];
  subjects: ParentReportSubjectRow[];
  weakPoints: ParentWeakPoint[];
  /** 未清零错题里映射不到知识点的条数——UI 必须显式提示口径。 */
  weakPointsUncoveredCount: number;
  exams: ParentExamRecord[];
}

export function getParentReport(
  studentId: number,
  period: ParentReportPeriod,
): Promise<ParentLearningReport> {
  const qs = new URLSearchParams();
  qs.set('period', period);
  return fetchApi<ParentLearningReport>(`/parent/students/${studentId}/reports?${qs.toString()}`);
}

export interface ParentErrorQuestion {
  content: string;
  type: string;
  difficulty: number | null;
  knowledgePoints: Array<{ id: number; name: string }>;
}

export interface ParentErrorItem {
  id: number;
  questionId: number | null;
  track: 'main' | 'aux';
  source: string;
  level: number;
  isCleared: boolean;
  wrongAnswerText: string | null;
  createdAt: string;
  clearedAt: string | null;
  /** `questionId` 为 null 时整个为 null，此时只能展示 `wrongAnswerText`。 */
  question: ParentErrorQuestion | null;
}

export interface ParentErrorPage {
  items: ParentErrorItem[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ParentErrorListParams {
  studentId: number;
  subject?: number;
  source?: string;
  track?: 'main' | 'aux';
  cleared?: 'uncleared' | 'cleared' | 'all';
  from?: string;
  to?: string;
  /** 从 1 起；不传则后端取 1。`pageSize` 服务端固定 20，前端**不传**。 */
  page?: number;
}

export function getParentErrors(params: ParentErrorListParams): Promise<ParentErrorPage> {
  const qs = new URLSearchParams();
  if (params.subject !== undefined) qs.set('subject', String(params.subject));
  if (params.source) qs.set('source', params.source);
  if (params.track) qs.set('track', params.track);
  if (params.cleared) qs.set('cleared', params.cleared);
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.page) qs.set('page', String(params.page));
  const query = qs.toString();
  return fetchApi<ParentErrorPage>(
    `/parent/students/${params.studentId}/errors${query ? `?${query}` : ''}`,
  );
}

export interface ParentChatLogItem {
  id: number;
  track: string;
  scene: string;
  title: string | null;
  subjectId: number | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /** 该会话里 `safety_flag = 1` 的消息数（闲聊/偏离学习）→ UI 打红色标记。 */
  blockCount: number;
}

export interface ParentChatLogMessage {
  id: number;
  role: 'system' | 'user' | 'assistant';
  content: string;
  reasoning: string | null;
  type: string | null;
  model: string | null;
  safetyFlag: number;
  createdAt: string;
}

export interface ParentChatLogDetail extends ParentChatLogItem {
  messages: ParentChatLogMessage[];
}

export interface ParentChatLogPage {
  items: ParentChatLogItem[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ParentChatLogListParams {
  studentId: number;
  track?: 'mainline' | 'auxiliary';
  scene?: string;
  from?: string;
  to?: string;
  /** 只搜会话标题（不搜消息正文）。 */
  q?: string;
  page?: number;
}

export function getParentChatLogs(params: ParentChatLogListParams): Promise<ParentChatLogPage> {
  const qs = new URLSearchParams();
  if (params.track) qs.set('track', params.track);
  if (params.scene) qs.set('scene', params.scene);
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.q) qs.set('q', params.q);
  if (params.page) qs.set('page', String(params.page));
  const query = qs.toString();
  return fetchApi<ParentChatLogPage>(
    `/parent/students/${params.studentId}/chat-logs${query ? `?${query}` : ''}`,
  );
}

export function getParentChatLogDetail(
  studentId: number,
  dialogueId: number,
): Promise<ParentChatLogDetail> {
  return fetchApi<ParentChatLogDetail>(
    `/parent/students/${studentId}/chat-logs/${dialogueId}`,
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/services/api.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/services/api.ts apps/web/src/services/api.test.ts
git commit -m "feat(parent): 学情可见性五个 api 方法与类型"
```

---

### Task 13: 前端 — 分页基座组件

**Files:**
- Create: `apps/web/src/components/base/Pagination.tsx`
- Modify: `apps/web/src/components/base/index.ts`（加导出）
- Test: `apps/web/src/components/base/Pagination.test.tsx`

**Interfaces:**
- Produces: `interface PaginationProps { page: number; totalPages: number; onChange: (page: number) => void }`
- 注意：`RedemptionHistoryPanel.tsx` **本批不动**（它已被测试覆盖，改它属于无关重构，风险大于收益）；它只是本组件的「第 1 个使用者形态」参考。

- [ ] **Step 1: 写失败的测试**

创建 `apps/web/src/components/base/Pagination.test.tsx`：

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Pagination } from './Pagination';

afterEach(() => cleanup());

describe('Pagination', () => {
  it('渲染「上一页 / 第 N / M 页 / 下一页」', () => {
    render(<Pagination page={2} totalPages={5} onChange={() => {}} />);

    expect(screen.getByRole('button', { name: '上一页' })).toBeInTheDocument();
    expect(screen.getByText('第 2 / 5 页')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下一页' })).toBeInTheDocument();
  });

  it('首页禁用「上一页」，末页禁用「下一页」', () => {
    const { unmount } = render(<Pagination page={1} totalPages={3} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '下一页' })).not.toBeDisabled();
    unmount();

    render(<Pagination page={3} totalPages={3} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
  });

  it('点击传回目标页码', () => {
    const onChange = vi.fn();
    render(<Pagination page={2} totalPages={5} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(onChange).toHaveBeenCalledWith(3);

    fireEvent.click(screen.getByRole('button', { name: '上一页' }));
    expect(onChange).toHaveBeenCalledWith(1);
  });

  it('只有一页时仍然渲染（不显示翻页按钮，禁用两侧）', () => {
    render(<Pagination page={1} totalPages={1} onChange={() => {}} />);

    expect(screen.getByText('第 1 / 1 页')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/components/base/Pagination.test.tsx`
Expected: FAIL — `Failed to resolve import "./Pagination"`

- [ ] **Step 3: 实现**

创建 `apps/web/src/components/base/Pagination.tsx`：

```tsx
import { Button } from './Button';

export interface PaginationProps {
  /** 当前页，从 1 起。 */
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
}

/**
 * 「上一页 / 第 N / M 页 / 下一页」三件套。
 *
 * 为什么现在抽出来：家长端已有第 3 处需要分页（兑换记录 + 错题 + 对话回放）。
 * 注意 `RedemptionHistoryPanel.tsx` **没有**改用它——那个文件已被测试覆盖，改它属于无关重构；
 * 本组件是「同形态」的通用版，新页面用。
 *
 * 命名导出（不是 default）：基座目录（`components/base/`）全部用具名导出，`index.ts` 逐行转出。
 * 从 `./Button` 直接引入而不是从 `'.'`：避免 `index ⇄ Pagination` 循环依赖。
 */
export function Pagination({ page, totalPages, onChange }: PaginationProps) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Button
        variant="ghost"
        size="sm"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
      >
        上一页
      </Button>
      <span className="text-xs text-[var(--text-secondary)]">
        {`第 ${page} / ${totalPages} 页`}
      </span>
      <Button
        variant="ghost"
        size="sm"
        disabled={page >= totalPages}
        onClick={() => onChange(page + 1)}
      >
        下一页
      </Button>
    </div>
  );
}
```

在 `apps/web/src/components/base/index.ts` 里按既有格式（逐行具名转出）加两行：

```ts
export { Pagination } from './Pagination';
export type { PaginationProps } from './Pagination';
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/components/base/Pagination.test.tsx`
Expected: PASS（本任务新增的用例全绿）

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/base/Pagination.tsx apps/web/src/components/base/index.ts apps/web/src/components/base/Pagination.test.tsx
git commit -m "feat(web): 抽出分页基座组件"
```

---

### Task 14: 前端 — 家长仪表盘页

**Files:**
- Create: `apps/web/src/pages/parent/ParentDashboardPage.tsx`
- Modify: `apps/web/src/routes/routeTable.tsx`（parent 段 `dashboard` 换成真实页；加 default import）
- Test: `apps/web/src/pages/parent/ParentDashboardPage.test.tsx`

**Interfaces:**
- Consumes: `getParentDashboard()` / `ParentDashboard`（Task 12）、`useParentStudentStore`、基座 `Card` / `Skeleton` / `Button` / `Tag`
- Produces: `export default function ParentDashboardPage()`

**页面行为（spec §5.1）**：
- 多孩时顶部孩子 Tab（本地 state，**不写 anchor**）；单孩时不出 Tab。
- 每个孩子一张学科卡片网格：进度百分比 + 当前单元/课、正确率、自评、未清零错题、考试场次、近 7 天活跃天数。
- 快捷入口（学情报告 / 错题查看 / 对话回放）：**点击时先 `setStudentId(该孩子)` 再 navigate**，否则报告页会跟随顶栏锚点、跳到别人身上。
- `rate === null` 显示「暂无数据」，**不是** `0%`。

- [ ] **Step 1: 写失败的测试**

创建 `apps/web/src/pages/parent/ParentDashboardPage.test.tsx`：

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { routes } from '@/routes/routeTable';
import { getParentDashboard, getUnreadMessageCount, listMyStudents, type ParentDashboard } from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';
import { useThemeStore } from '@/store/themeStore';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    listMyStudents: vi.fn(),
    getUnreadMessageCount: vi.fn(),
    getParentDashboard: vi.fn(),
  };
});

const listMyStudentsMock = vi.mocked(listMyStudents);
const getUnreadMock = vi.mocked(getUnreadMessageCount);
const getDashboardMock = vi.mocked(getParentDashboard);

const BOY = { id: 11, parentId: 3, username: 'xiaoming', name: '小明', age: 13, grade: '初一', schoolLevel: 'junior', isActive: true };
const GIRL = { ...BOY, id: 12, username: 'xiaomei', name: '小美' };

const DASHBOARD: ParentDashboard = {
  unreadAlerts: 0,
  students: [
    {
      studentId: 11, name: '小明', grade: '初一', schoolLevel: 'junior',
      lastActiveAt: '2026-09-18T20:11:00.000Z', activeDays7: 3, unreadAlerts: 0,
      subjects: [
        {
          subjectId: 1, subjectName: '数学',
          progress: {
            completedUnits: 2, totalUnits: 8,
            currentUnitName: '第二章 整式的加减', currentLessonName: '2.1 整式', percent: 25,
          },
          accuracy: { answered: 42, correct: 31, rate: 73.8 },
          selfAssessed: { count: 5, correctCount: 3 },
          errorBook: { uncleared: 12, total: 20 },
          examCount: 4,
        },
      ],
    },
    {
      studentId: 12, name: '小美', grade: '初一', schoolLevel: 'junior',
      lastActiveAt: null, activeDays7: 0, unreadAlerts: 0,
      subjects: [
        {
          subjectId: 1, subjectName: '数学',
          progress: { completedUnits: 0, totalUnits: 8, currentUnitName: null, currentLessonName: null, percent: 0 },
          // 没做过题：rate 必须是 null，UI 应显示「暂无数据」而不是 0%
          accuracy: { answered: 0, correct: 0, rate: null },
          selfAssessed: { count: 0, correctCount: 0 },
          errorBook: { uncleared: 0, total: 0 },
          examCount: 0,
        },
      ],
    },
  ],
};

function validToken(): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }));
  return `header.${payload}.signature`;
}

function renderAt(path: string) {
  localStorage.setItem('token', validToken());
  localStorage.setItem('userRole', 'parent');
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const result = render(<RouterProvider router={router} />);
  return { router, ...result };
}

beforeEach(() => {
  localStorage.clear();
  useParentStudentStore.setState({ studentId: null });
  listMyStudentsMock.mockReset();
  listMyStudentsMock.mockResolvedValue([BOY, GIRL] as any);
  getUnreadMock.mockReset();
  getUnreadMock.mockResolvedValue(0);
  getDashboardMock.mockReset();
  getDashboardMock.mockResolvedValue(DASHBOARD);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useParentStudentStore.setState({ studentId: null });
  useThemeStore.setState({ mode: 'student-day' });
});

describe('ParentDashboardPage', () => {
  it('渲染首个孩子的学科卡片（进度 / 正确率 / 错题 / 考试 / 活跃天数）', async () => {
    renderAt('/parent/dashboard');

    const panel = await screen.findByTestId('dashboard-student-11');
    expect(panel).toHaveTextContent('数学');
    expect(panel).toHaveTextContent('2 / 8');
    expect(panel).toHaveTextContent('第二章 整式的加减');
    expect(panel).toHaveTextContent('2.1 整式');
    expect(panel).toHaveTextContent('73.8%');
    expect(panel).toHaveTextContent('12');
    expect(panel).toHaveTextContent('4');
    expect(panel).toHaveTextContent('3');
  });

  it('rate 为 null → 显示「暂无数据」，不显示 0%', async () => {
    renderAt('/parent/dashboard');
    await screen.findByTestId('dashboard-student-11');

    fireEvent.click(screen.getByRole('tab', { name: '小美' }));

    const panel = await screen.findByTestId('dashboard-student-12');
    expect(panel).toHaveTextContent('暂无数据');
    expect(panel).not.toHaveTextContent('0%');
  });

  it('多孩 → 出孩子 Tab；点 Tab 只在本地切换，**不写锚点**', async () => {
    renderAt('/parent/dashboard');
    await screen.findByTestId('dashboard-student-11');

    fireEvent.click(screen.getByRole('tab', { name: '小美' }));

    await screen.findByTestId('dashboard-student-12');
    expect(useParentStudentStore.getState().studentId).toBeNull();
  });

  it('快捷入口先设锚点再导航（否则报告页会跟错孩子）', async () => {
    const { router } = renderAt('/parent/dashboard');
    await screen.findByTestId('dashboard-student-11');

    fireEvent.click(screen.getByRole('tab', { name: '小美' }));
    const panel = await screen.findByTestId('dashboard-student-12');
    fireEvent.click(within(panel).getByRole('button', { name: '学情报告' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/parent/report'));
    expect(useParentStudentStore.getState().studentId).toBe(12);
  });

  it('名下没有孩子 → 空态 + 去创建账号的入口', async () => {
    listMyStudentsMock.mockResolvedValue([]);
    getDashboardMock.mockResolvedValue({ students: [], unreadAlerts: 0 });

    renderAt('/parent/dashboard');

    expect(await screen.findByTestId('dashboard-empty')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /创建学生账号/ })).toBeInTheDocument();
  });

  it('加载中 → 骨架，不到货不渲染卡片', async () => {
    getDashboardMock.mockImplementation(() => new Promise(() => {}));

    renderAt('/parent/dashboard');

    expect(await screen.findByTestId('dashboard-skeleton')).toBeInTheDocument();
  });

  it('接口报错 → 错误条 + 重试可重新拉取', async () => {
    getDashboardMock.mockRejectedValueOnce(new Error('boom'));

    renderAt('/parent/dashboard');

    const errBox = await screen.findByTestId('dashboard-error');
    getDashboardMock.mockResolvedValue(DASHBOARD);
    fireEvent.click(within(errBox).getByRole('button', { name: '重试' }));

    expect(await screen.findByTestId('dashboard-student-11')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/parent/ParentDashboardPage.test.tsx`
Expected: FAIL — 路由仍指向 `Placeholder`，找不到 `dashboard-student-11`

- [ ] **Step 3: 实现页面**

创建 `apps/web/src/pages/parent/ParentDashboardPage.tsx`：

```tsx
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { Button, Card, Progress, Skeleton, Tag } from '@/components/base';
import { ApiError, getParentDashboard, type ParentDashboard, type ParentDashboardStudent } from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';

/** `rate` 为 null（一道题都没做过）时必须显示「暂无数据」——显示 0% 会被读成「全错了」。 */
function formatRate(rate: number | null): string {
  return rate === null ? '暂无数据' : `${rate}%`;
}

function formatLastActive(iso: string | null): string {
  if (!iso) return '暂无记录';
  const d = new Date(iso);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/** 学科卡片：进度 + 正确率 + 错题 + 考试场次。 */
function SubjectCard({ subject }: { subject: ParentDashboardStudent['subjects'][number] }) {
  return (
    <Card className="p-5" data-testid={`dashboard-subject-${subject.subjectId}`}>
      <div className="flex items-center justify-between">
        <h3 className="text-base font-bold text-[var(--text-primary)]">{subject.subjectName}</h3>
        <span className="text-sm text-[var(--text-secondary)]">
          {`${subject.progress.completedUnits} / ${subject.progress.totalUnits} 单元`}
        </span>
      </div>

      <div className="mt-3">
        <Progress value={subject.progress.percent} />
      </div>

      <p className="mt-2 text-sm text-[var(--text-secondary)]">
        {subject.progress.currentUnitName
          ? `当前：${subject.progress.currentUnitName}${
              subject.progress.currentLessonName ? ` · ${subject.progress.currentLessonName}` : ''
            }`
          : '尚未开始学习'}
      </p>

      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-[var(--text-tertiary)]">正确率</dt>
          <dd className="font-semibold text-[var(--text-primary)]">
            {formatRate(subject.accuracy.rate)}
          </dd>
        </div>
        <div>
          <dt className="text-[var(--text-tertiary)]">未清零错题</dt>
          <dd className="font-semibold text-[var(--text-primary)]">{subject.errorBook.uncleared}</dd>
        </div>
        <div>
          <dt className="text-[var(--text-tertiary)]">已考场次</dt>
          <dd className="font-semibold text-[var(--text-primary)]">{subject.examCount}</dd>
        </div>
        <div>
          <dt className="text-[var(--text-tertiary)]">主观自评</dt>
          <dd className="font-semibold text-[var(--text-primary)]">
            {`${subject.selfAssessed.correctCount} / ${subject.selfAssessed.count}`}
          </dd>
        </div>
      </dl>
    </Card>
  );
}

/** 单个孩子的概览面板（Tab 切换时整块换掉）。 */
function StudentPanel({ student }: { student: ParentDashboardStudent }) {
  const setStudentId = useParentStudentStore((s) => s.setStudentId);
  const navigate = useNavigate();

  /**
   * 快捷入口必须先 `setStudentId` 再跳：报告/错题/回放三页跟随顶栏锚点，
   * 只 navigate 不设锚点会跳到「顶栏那个孩子」身上，而不是当前 Tab 这个。
   *
   * 用 `Button + navigate` 而不是 `<Link><Button/></Link>`：后者是 `<a>` 里套 `<button>`，
   * 属于嵌套交互元素（无效 HTML，键盘/读屏行为不确定）。
   */
  const goto = (path: string) => {
    setStudentId(student.studentId);
    navigate(path);
  };

  return (
    <div data-testid={`dashboard-student-${student.studentId}`}>
      <Card elevation="flat" className="mb-4 flex flex-wrap items-center gap-4 p-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-[var(--text-primary)]">{student.name}</span>
          {student.grade && <Tag>{student.grade}</Tag>}
        </div>
        <span className="text-sm text-[var(--text-secondary)]">
          {`近 7 天活跃 ${student.activeDays7} 天`}
        </span>
        <span className="text-sm text-[var(--text-secondary)]">
          {`最近活跃 ${formatLastActive(student.lastActiveAt)}`}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => goto('/parent/report')}>
            学情报告
          </Button>
          <Button variant="secondary" size="sm" onClick={() => goto('/parent/errors')}>
            错题查看
          </Button>
          <Button variant="secondary" size="sm" onClick={() => goto('/parent/chat-logs')}>
            对话回放
          </Button>
        </div>
      </Card>

      {student.subjects.length === 0 ? (
        <Card className="p-10 text-center">
          <p className="text-sm text-[var(--text-secondary)]">
            这个孩子还没有开始任何学科的学习。
          </p>
          <Link
            to={`/parent/students/${student.studentId}/config`}
            className="mt-3 inline-block text-sm font-medium text-[var(--brand-600)] hover:underline"
          >
            去配置教材
          </Link>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {student.subjects.map((subject) => (
            <SubjectCard key={subject.subjectId} subject={subject} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function ParentDashboardPage() {
  const [data, setData] = useState<ParentDashboard | null>(null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [activeId, setActiveId] = useState<number | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    getParentDashboard()
      .then((res) => {
        if (cancelled) return;
        setData(res);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setData(null);
        // 1002/1005 是账号类问题（学生不存在/无权限），重试没有意义 → 引导去账号页
        if (err instanceof ApiError && (err.code === 1002 || err.code === 1005)) {
          navigate('/parent/students');
          return;
        }
        setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [reload, navigate]);

  const students = data?.students ?? [];
  // 选中的孩子：默认第一个；数据刷新后原 id 若不存在则回落第一个
  const current =
    students.find((s) => s.studentId === activeId) ?? students[0] ?? null;

  return (
    <div>
      <header className="mb-5">
        <h1 className="text-2xl font-black text-[var(--text-primary)]">仪表盘</h1>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          一屏掌握所有孩子的学情概览
        </p>
      </header>

      {failed ? (
        <Card
          data-testid="dashboard-error"
          className="flex flex-wrap items-center justify-between gap-4 border border-[var(--error)] p-4"
        >
          <span className="text-sm text-[var(--text-secondary)]">学情概览暂时加载失败</span>
          <Button variant="secondary" size="sm" onClick={() => setReload((n) => n + 1)}>
            重试
          </Button>
        </Card>
      ) : data === null ? (
        <div data-testid="dashboard-skeleton" className="space-y-4">
          <Skeleton width="100%" height={72} rounded />
          <Skeleton width="100%" height={196} rounded />
        </div>
      ) : students.length === 0 ? (
        <Card data-testid="dashboard-empty" className="p-10 text-center">
          <p className="text-sm text-[var(--text-secondary)]">还没有孩子账号</p>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            先为孩子开通学生账号，再回来查看学情概览。
          </p>
          <Link
            to="/parent/students"
            className="mt-3 inline-block text-sm font-medium text-[var(--brand-600)] hover:underline"
          >
            去创建学生账号
          </Link>
        </Card>
      ) : (
        <>
          {students.length > 1 && (
            <div role="tablist" className="mb-4 flex gap-2">
              {students.map((s) => (
                <button
                  key={s.studentId}
                  role="tab"
                  type="button"
                  aria-selected={s.studentId === current?.studentId}
                  onClick={() => setActiveId(s.studentId)}
                  className={clsx(
                    'px-4 py-1.5 rounded-full text-sm font-medium border transition-colors',
                    s.studentId === current?.studentId
                      ? 'border-[var(--brand-500)] bg-[var(--brand-100)] text-[var(--brand-600)]'
                      : 'border-[var(--bg-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)]',
                  )}
                >
                  {s.name}
                </button>
              ))}
            </div>
          )}

          {current && <StudentPanel student={current} />}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 接入路由**

`apps/web/src/routes/routeTable.tsx`：
1. 在 `import ParentPointsPage from '@/pages/parent/ParentPointsPage';` 之后加
   ```ts
   import ParentDashboardPage from '@/pages/parent/ParentDashboardPage';
   ```
2. parent 段里
   ```ts
   { path: 'dashboard', element: <Placeholder title="家长仪表盘 P6.1" /> },
   ```
   改成
   ```ts
   { path: 'dashboard', element: <ParentDashboardPage /> },
   ```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/pages/parent/ParentDashboardPage.test.tsx`
Expected: PASS（本任务新增的用例全绿）

- [ ] **Step 6: 全量前端测试 + 构建**

Run: `cd apps/web && npm test && npm run build`
Expected: 全绿 + 构建无错。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/pages/parent/ParentDashboardPage.tsx apps/web/src/pages/parent/ParentDashboardPage.test.tsx apps/web/src/routes/routeTable.tsx
git commit -m "feat(parent): 家长仪表盘页（多孩 Tab + 学科卡片 + 快捷入口带锚点）"
```

---

### Task 15: 前端 — 学情报告页

**Files:**
- Create: `apps/web/src/pages/parent/ParentReportPage.tsx`
- Modify: `apps/web/src/routes/routeTable.tsx`
- Test: `apps/web/src/pages/parent/ParentReportPage.test.tsx`

**Interfaces:**
- Consumes: `getParentReport(studentId, period)` / `ParentLearningReport`（Task 12）、`ChartLine` / `ChartBar`（Task 11）、`useParentStudentStore`、基座 `Card` / `Skeleton` / `Button` / `Banner` / `Tag`
- Produces: `export default function ParentReportPage()`

**页面行为（spec §5.1）**：
- 跟随顶栏锚点；无锚点 → 空态引导选孩子。
- 周/月切换（本地 state，切档重拉）。
- 数字卡（stats）→ 折线（trend.rate，null 当 0 处理会误导，**跳过 null 点**）→ 柱状（subjects 用 `answered`，正确率另列文字）→ 薄弱点列表 + **「另有 N 道错题未标注知识点」提示** → 考试表格。
- 薄弱点为空时也要显示「未标注」提示（否则家长会以为没问题）。

- [ ] **Step 1: 写失败的测试**

创建 `apps/web/src/pages/parent/ParentReportPage.test.tsx`：

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { routes } from '@/routes/routeTable';
import { getParentReport, getUnreadMessageCount, listMyStudents, type ParentLearningReport } from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';
import { useThemeStore } from '@/store/themeStore';

/**
 * 图表被替换成轻量桩：`recharts` 在 jsdom 里量不到尺寸、不真渲染 SVG，
 * 真实图表封装的取色/空态已由 `components/business/parent/*.test.tsx` 覆盖。
 * 本文件只验页面的**数据编排**（给图表喂了什么、有没有正确处理 null）。
 */
vi.mock('@/components/business/parent/ChartLine', () => ({
  default: ({ points }: any) => (
    <div data-testid="chart-line" data-count={points.length}>
      {points.map((p: any) => `${p.label}:${p.value}`).join(',')}
    </div>
  ),
}));
vi.mock('@/components/business/parent/ChartBar', () => ({
  default: ({ points }: any) => (
    <div data-testid="chart-bar" data-count={points.length}>
      {points.map((p: any) => `${p.label}:${p.value}`).join(',')}
    </div>
  ),
}));

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    listMyStudents: vi.fn(),
    getUnreadMessageCount: vi.fn(),
    getParentReport: vi.fn(),
  };
});

const listMyStudentsMock = vi.mocked(listMyStudents);
const getUnreadMock = vi.mocked(getUnreadMessageCount);
const getReportMock = vi.mocked(getParentReport);

const BOY = { id: 11, parentId: 3, username: 'xiaoming', name: '小明', age: 13, grade: '初一', schoolLevel: 'junior', isActive: true };

const REPORT: ParentLearningReport = {
  studentId: 11,
  period: 'weekly',
  windowStart: '2026-09-12',
  windowEnd: '2026-09-18',
  stats: {
    activeDays: 3, answered: 42, correct: 31, rate: 73.8,
    selfAssessCount: 5, errorsAdded: 6, errorsCleared: 4, examCount: 2,
  },
  trend: [
    { date: '2026-09-15', answered: 10, correct: 7, rate: 70 },
    { date: '2026-09-16', answered: 6, correct: 6, rate: 100 },
  ],
  subjects: [{ subjectId: 1, subjectName: '数学', answered: 42, correct: 31, rate: 73.8 }],
  weakPoints: [
    { knowledgePointId: 42, name: '分数加减', unclearedCount: 3, totalWrongCount: 5 },
  ],
  weakPointsUncoveredCount: 8,
  exams: [
    {
      sessionId: 7, paperTitle: '2025 学年七年级上期中', subjectName: '数学',
      submittedAt: '2026-09-16T19:20:00.000Z', correctCount: 18, objectiveCount: 22, rate: 81.8,
    },
  ],
};

function validToken(): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }));
  return `header.${payload}.signature`;
}

function renderAt(path: string) {
  localStorage.setItem('token', validToken());
  localStorage.setItem('userRole', 'parent');
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const result = render(<RouterProvider router={router} />);
  return { router, ...result };
}

beforeEach(() => {
  localStorage.clear();
  useParentStudentStore.setState({ studentId: 11 });
  listMyStudentsMock.mockReset();
  listMyStudentsMock.mockResolvedValue([BOY] as any);
  getUnreadMock.mockReset();
  getUnreadMock.mockResolvedValue(0);
  getReportMock.mockReset();
  getReportMock.mockResolvedValue(REPORT);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useParentStudentStore.setState({ studentId: null });
  useThemeStore.setState({ mode: 'student-day' });
});

describe('ParentReportPage', () => {
  it('按锚点孩子取 weekly 报告并渲染数字卡', async () => {
    renderAt('/parent/report');

    expect(await screen.findByTestId('report-stats')).toHaveTextContent('73.8%');
    expect(screen.getByTestId('report-stats')).toHaveTextContent('3');
    expect(getReportMock).toHaveBeenCalledWith(11, 'weekly');
  });

  it('切月报 → 用 monthly 重新拉取', async () => {
    renderAt('/parent/report');
    await screen.findByTestId('report-stats');

    fireEvent.click(screen.getByRole('button', { name: '月报' }));

    await waitFor(() => expect(getReportMock).toHaveBeenLastCalledWith(11, 'monthly'));
  });

  it('趋势折线喂的是 rate，标签是日期', async () => {
    renderAt('/parent/report');

    const line = await screen.findByTestId('chart-line');
    expect(line).toHaveTextContent('09-15:70,09-16:100');
  });

  it('趋势里 rate 为 null 的点被跳过（画成 0 会被家长读成「全错」）', async () => {
    getReportMock.mockResolvedValue({
      ...REPORT,
      trend: [
        { date: '2026-09-15', answered: 10, correct: 7, rate: 70 },
        { date: '2026-09-16', answered: 2, correct: 0, rate: null },
      ],
    });

    renderAt('/parent/report');

    const line = await screen.findByTestId('chart-line');
    expect(line).toHaveAttribute('data-count', '1');
    expect(line).toHaveTextContent('09-15:70');
  });

  it('薄弱点列表 + 「另有 N 道错题未标注知识点」提示', async () => {
    renderAt('/parent/report');

    const weak = await screen.findByTestId('report-weak-points');
    expect(weak).toHaveTextContent('分数加减');
    expect(weak).toHaveTextContent('3');
    expect(await screen.findByTestId('report-uncovered-hint')).toHaveTextContent('8');
  });

  it('薄弱点为空也要出「未标注」提示（否则家长以为没问题）', async () => {
    getReportMock.mockResolvedValue({ ...REPORT, weakPoints: [], weakPointsUncoveredCount: 8 });

    renderAt('/parent/report');

    expect(await screen.findByTestId('report-weak-points')).toHaveTextContent('暂无薄弱点数据');
    expect(screen.getByTestId('report-uncovered-hint')).toHaveTextContent('8');
  });

  it('考试表格列出卷名与正确率', async () => {
    renderAt('/parent/report');

    const exams = await screen.findByTestId('report-exams');
    expect(exams).toHaveTextContent('2025 学年七年级上期中');
    expect(exams).toHaveTextContent('81.8%');
  });

  it('全空报告 → 各区块出空态，不崩', async () => {
    getReportMock.mockResolvedValue({
      ...REPORT,
      stats: { activeDays: 0, answered: 0, correct: 0, rate: null, selfAssessCount: 0, errorsAdded: 0, errorsCleared: 0, examCount: 0 },
      trend: [], subjects: [], weakPoints: [], weakPointsUncoveredCount: 0, exams: [],
    });

    renderAt('/parent/report');

    expect(await screen.findByTestId('report-stats')).toHaveTextContent('暂无数据');
    expect(screen.getByTestId('chart-line')).toHaveAttribute('data-count', '0');
    expect(screen.getByTestId('report-exams')).toHaveTextContent('还没有考试记录');
  });

  it('没有选孩子 → 空态引导，不发请求', async () => {
    useParentStudentStore.setState({ studentId: null });

    renderAt('/parent/report');

    expect(await screen.findByTestId('report-no-student')).toBeInTheDocument();
    expect(getReportMock).not.toHaveBeenCalled();
  });

  it('孩子不存在（1002）→ 引导切换孩子，不给重试', async () => {
    const { ApiError } = await import('@/services/api');
    getReportMock.mockRejectedValue(new ApiError(1002, '学生不存在'));

    renderAt('/parent/report');

    expect(await screen.findByTestId('report-student-missing')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/parent/ParentReportPage.test.tsx`
Expected: FAIL — 路由仍指向 `Placeholder`

- [ ] **Step 3: 实现页面**

创建 `apps/web/src/pages/parent/ParentReportPage.tsx`：

```tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { Button, Card, Skeleton } from '@/components/base';
import ChartLine from '@/components/business/parent/ChartLine';
import ChartBar from '@/components/business/parent/ChartBar';
import {
  ApiError,
  getParentReport,
  type ParentLearningReport,
  type ParentReportPeriod,
} from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';

const PERIODS: Array<{ key: ParentReportPeriod; label: string }> = [
  { key: 'weekly', label: '周报' },
  { key: 'monthly', label: '月报' },
];

function formatRate(rate: number | null): string {
  return rate === null ? '暂无数据' : `${rate}%`;
}

/** `2026-09-15` → `09-15`（折线 X 轴太窄，放不下年份）。 */
function shortDay(date: string): string {
  return date.slice(5);
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-card)] bg-[var(--bg-subtle)] p-3">
      <div className="text-xs text-[var(--text-tertiary)]">{label}</div>
      <div className="mt-1 text-lg font-bold text-[var(--text-primary)]">{value}</div>
    </div>
  );
}

export default function ParentReportPage() {
  const studentId = useParentStudentStore((s) => s.studentId);
  const [period, setPeriod] = useState<ParentReportPeriod>('weekly');
  const [report, setReport] = useState<{ studentId: number; period: ParentReportPeriod; value: ParentLearningReport } | null>(null);
  const [failure, setFailure] = useState<{ studentId: number; code: number | null } | null>(null);
  const [reload, setReload] = useState(0);

  /**
   * 数据按 `studentId + period` 现算，而不是在 effect 里 setReport(null)：
   * effect 在 commit 之后才跑，清空会慢一帧——那一帧页面上是**上一个孩子/上一档**的报告。
   */
  const data =
    report && report.studentId === studentId && report.period === period ? report.value : null;
  const err = failure && failure.studentId === studentId ? failure : null;

  useEffect(() => {
    if (studentId === null) return;
    let cancelled = false;
    getParentReport(studentId, period)
      .then((res) => {
        if (cancelled) return;
        setReport({ studentId, period, value: res });
        setFailure(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setReport(null);
        setFailure({ studentId, code: error instanceof ApiError ? error.code : null });
      });
    return () => {
      cancelled = true;
    };
  }, [studentId, period, reload]);

  if (studentId === null) {
    return (
      <Card data-testid="report-no-student" className="p-10 text-center">
        <p className="text-sm text-[var(--text-secondary)]">还没有选择孩子账号</p>
        <Link
          to="/parent/students"
          className="mt-3 inline-block text-sm font-medium text-[var(--brand-600)] hover:underline"
        >
          去创建学生账号
        </Link>
      </Card>
    );
  }

  return (
    <div>
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black text-[var(--text-primary)]">学情报告</h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            {data ? `${data.windowStart} 至 ${data.windowEnd}` : '按学科与时间查看学习表现'}
          </p>
        </div>
        <div className="flex gap-2">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              type="button"
              aria-pressed={period === p.key}
              onClick={() => setPeriod(p.key)}
              className={clsx(
                'px-4 py-1.5 rounded-full text-sm font-medium border transition-colors',
                period === p.key
                  ? 'border-[var(--brand-500)] bg-[var(--brand-100)] text-[var(--brand-600)]'
                  : 'border-[var(--bg-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)]',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </header>

      {err?.code === 1002 ? (
        <Card data-testid="report-student-missing" className="p-10 text-center">
          <p className="text-sm text-[var(--text-secondary)]">
            该孩子账号不存在，请在顶部切换其它孩子
          </p>
        </Card>
      ) : err?.code === 1005 ? (
        <Card data-testid="report-student-forbidden" className="p-10 text-center">
          <p className="text-sm text-[var(--text-secondary)]">无权查看该孩子</p>
        </Card>
      ) : err ? (
        <Card
          data-testid="report-error"
          className="flex flex-wrap items-center justify-between gap-4 border border-[var(--error)] p-4"
        >
          <span className="text-sm text-[var(--text-secondary)]">学情报告暂时加载失败</span>
          <Button variant="secondary" size="sm" onClick={() => setReload((n) => n + 1)}>
            重试
          </Button>
        </Card>
      ) : data === null ? (
        <div data-testid="report-skeleton" className="space-y-4">
          <Skeleton width="100%" height={92} rounded />
          <Skeleton width="100%" height={220} rounded />
        </div>
      ) : (
        <div className="space-y-5">
          <Card className="p-5">
            <div data-testid="report-stats" className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatCard label="正确率" value={formatRate(data.stats.rate)} />
              <StatCard label="答题数" value={String(data.stats.answered)} />
              <StatCard label="活跃天数" value={String(data.stats.activeDays)} />
              <StatCard label="自评次数" value={String(data.stats.selfAssessCount)} />
              <StatCard label="新进错题本" value={String(data.stats.errorsAdded)} />
              <StatCard label="清零错题" value={String(data.stats.errorsCleared)} />
              <StatCard label="考试场次" value={String(data.stats.examCount)} />
            </div>
          </Card>

          <Card className="p-5">
            <h2 className="mb-3 text-base font-bold text-[var(--text-primary)]">正确率趋势</h2>
            <ChartLine
              points={data.trend
                // rate 为 null 的点（当天只有主观自评）跳过——画成 0 会被读成「全错」
                .filter((t) => t.rate !== null)
                .map((t) => ({ label: shortDay(t.date), value: t.rate as number }))}
              emptyText="本期还没有答题记录"
            />
          </Card>

          <Card className="p-5">
            <h2 className="mb-3 text-base font-bold text-[var(--text-primary)]">各学科答题量</h2>
            <ChartBar
              points={data.subjects.map((s) => ({
                label: `${s.subjectName} ${formatRate(s.rate)}`,
                value: s.answered,
              }))}
              emptyText="本期还没有答题记录"
            />
          </Card>

          <Card className="p-5" data-testid="report-weak-points">
            <h2 className="mb-3 text-base font-bold text-[var(--text-primary)]">薄弱知识点</h2>
            {data.weakPoints.length === 0 ? (
              <p className="text-sm text-[var(--text-secondary)]">暂无薄弱点数据</p>
            ) : (
              <ul className="space-y-2">
                {data.weakPoints.map((w) => (
                  <li
                    key={w.knowledgePointId}
                    className="flex items-center justify-between text-sm"
                  >
                    <span className="text-[var(--text-primary)]">{w.name}</span>
                    <span className="text-[var(--text-secondary)]">
                      {`未清零 ${w.unclearedCount} 道 / 共错 ${w.totalWrongCount} 道`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {/* 覆盖不到知识点的错题必须显式说清，否则家长会以为「只有这几个问题」 */}
            {data.weakPointsUncoveredCount > 0 && (
              <p
                data-testid="report-uncovered-hint"
                className="mt-3 text-xs text-[var(--text-tertiary)]"
              >
                {`另有 ${data.weakPointsUncoveredCount} 道未清零错题尚未标注知识点，未计入上面的统计。`}
              </p>
            )}
          </Card>

          <Card className="p-5" data-testid="report-exams">
            <h2 className="mb-3 text-base font-bold text-[var(--text-primary)]">考试记录</h2>
            {data.exams.length === 0 ? (
              <p className="text-sm text-[var(--text-secondary)]">还没有考试记录</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-[var(--text-tertiary)]">
                    <th className="pb-2 font-medium">试卷</th>
                    <th className="pb-2 font-medium">学科</th>
                    <th className="pb-2 font-medium">交卷时间</th>
                    <th className="pb-2 font-medium">正确率</th>
                  </tr>
                </thead>
                <tbody>
                  {data.exams.map((e) => (
                    <tr key={e.sessionId} className="border-t border-[var(--bg-subtle)]">
                      <td className="py-2 text-[var(--text-primary)]">{e.paperTitle}</td>
                      <td className="py-2 text-[var(--text-secondary)]">{e.subjectName}</td>
                      <td className="py-2 text-[var(--text-secondary)]">
                        {formatDateTime(e.submittedAt)}
                      </td>
                      <td className="py-2 text-[var(--text-primary)]">
                        {`${formatRate(e.rate)}（${e.correctCount}/${e.objectiveCount}）`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 接入路由**

`routeTable.tsx`：加 `import ParentReportPage from '@/pages/parent/ParentReportPage';`，并把
`<Placeholder title="学情报告 P6.2" />` 换成 `<ParentReportPage />`。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/pages/parent/ParentReportPage.test.tsx`
Expected: PASS（本任务新增的用例全绿）

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/pages/parent/ParentReportPage.tsx apps/web/src/pages/parent/ParentReportPage.test.tsx apps/web/src/routes/routeTable.tsx
git commit -m "feat(parent): 学情报告页（周/月切换 + 趋势折线 + 薄弱点口径提示）"
```

---

### Task 16: 前端 — 错题查看页

**Files:**
- Create: `apps/web/src/pages/parent/ParentErrorsPage.tsx`
- Modify: `apps/web/src/routes/routeTable.tsx`
- Test: `apps/web/src/pages/parent/ParentErrorsPage.test.tsx`

**Interfaces:**
- Consumes: `getParentErrors(params)` / `ParentErrorPage` / `ParentErrorItem`（Task 12）、`Pagination`（Task 13）、`useParentStudentStore`、基座 `Card` / `Skeleton` / `Button` / `Tag`
- Produces: `export default function ParentErrorsPage()`

**页面行为（spec §5.1）**：
- 跟随锚点；无锚点 → 空态。
- 主线/辅线 Tab（`track` 传给后端，后端做反向排除）。
- 筛选：**学科**（PRD §7.7 明确要求「可按学科筛选」）、来源（5 个实际值）、清零状态、时间范围；切筛选回到第 1 页。
- 学科下拉复用既有的 `fetchSubjects()`（`GET /content/subjects`），不新增端点。
- 行可展开：显示题干、题型、难度、知识点；`question === null` 时**只显示 `wrongAnswerText`**。
- `Pagination`：「自报家门」守卫——响应里的 `page` 与当前页不符就不渲染（防翻页时页码与内容错配）。

- [ ] **Step 1: 写失败的测试**

创建 `apps/web/src/pages/parent/ParentErrorsPage.test.tsx`：

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { routes } from '@/routes/routeTable';
import {
  fetchSubjects,
  getParentErrors,
  getUnreadMessageCount,
  listMyStudents,
  type ParentErrorPage,
} from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';
import { useThemeStore } from '@/store/themeStore';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    listMyStudents: vi.fn(),
    getUnreadMessageCount: vi.fn(),
    getParentErrors: vi.fn(),
    fetchSubjects: vi.fn(),
  };
});

const listMyStudentsMock = vi.mocked(listMyStudents);
const getUnreadMock = vi.mocked(getUnreadMessageCount);
const getErrorsMock = vi.mocked(getParentErrors);
const fetchSubjectsMock = vi.mocked(fetchSubjects);

const BOY = { id: 11, parentId: 3, username: 'xiaoming', name: '小明', age: 13, grade: '初一', schoolLevel: 'junior', isActive: true };

const PAGE: ParentErrorPage = {
  page: 1, pageSize: 20, total: 21,
  items: [
    {
      id: 91, questionId: 330, track: 'main', source: 'exam', level: 2, isCleared: false,
      wrongAnswerText: 'x=3', createdAt: '2026-09-16T19:21:00.000Z', clearedAt: null,
      question: {
        content: '解方程 2x+1=7', type: 'calculation', difficulty: 3,
        knowledgePoints: [{ id: 42, name: '分数加减' }],
      },
    },
    {
      id: 92, questionId: null, track: 'aux', source: 'auxiliary', level: 1, isCleared: true,
      wrongAnswerText: '只存了题面', createdAt: '2026-09-15T19:21:00.000Z',
      clearedAt: '2026-09-16T09:00:00.000Z', question: null,
    },
  ],
};

function validToken(): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }));
  return `header.${payload}.signature`;
}

function renderAt(path: string) {
  localStorage.setItem('token', validToken());
  localStorage.setItem('userRole', 'parent');
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const result = render(<RouterProvider router={router} />);
  return { router, ...result };
}

beforeEach(() => {
  localStorage.clear();
  useParentStudentStore.setState({ studentId: 11 });
  listMyStudentsMock.mockReset();
  listMyStudentsMock.mockResolvedValue([BOY] as any);
  getUnreadMock.mockReset();
  getUnreadMock.mockResolvedValue(0);
  getErrorsMock.mockReset();
  getErrorsMock.mockResolvedValue(PAGE);
  fetchSubjectsMock.mockReset();
  fetchSubjectsMock.mockResolvedValue([
    { id: 1, name: '数学', code: 'math', gradeBands: ['junior'] },
    { id: 2, name: '语文', code: 'chinese', gradeBands: ['junior'] },
  ]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useParentStudentStore.setState({ studentId: null });
  useThemeStore.setState({ mode: 'student-day' });
});

describe('ParentErrorsPage', () => {
  it('按锚点孩子取错题，默认 track=main、page=1', async () => {
    renderAt('/parent/errors');

    expect(await screen.findByTestId('error-row-91')).toBeInTheDocument();
    expect(getErrorsMock).toHaveBeenCalledWith({ studentId: 11, track: 'main', page: 1 });
  });

  it('展开行显示题干/题型/知识点；question 为 null 的行只显示 wrongAnswerText', async () => {
    renderAt('/parent/errors');
    await screen.findByTestId('error-row-91');

    fireEvent.click(within(screen.getByTestId('error-row-91')).getByRole('button', { name: /展开/ }));
    expect(screen.getByTestId('error-detail-91')).toHaveTextContent('解方程 2x+1=7');
    expect(screen.getByTestId('error-detail-91')).toHaveTextContent('分数加减');

    fireEvent.click(screen.getByRole('tab', { name: '辅线' }));
    await screen.findByTestId('error-row-92');
    fireEvent.click(within(screen.getByTestId('error-row-92')).getByRole('button', { name: /展开/ }));
    expect(screen.getByTestId('error-detail-92')).toHaveTextContent('只存了题面');
    expect(screen.getByTestId('error-detail-92')).toHaveTextContent('题目未入库');
  });

  it('切轨道 Tab → track 传给后端并回到第 1 页', async () => {
    renderAt('/parent/errors');
    await screen.findByTestId('error-row-91');

    fireEvent.click(screen.getByRole('tab', { name: '全部' }));

    await waitFor(() =>
      expect(getErrorsMock).toHaveBeenLastCalledWith({ studentId: 11, page: 1 }),
    );
  });

  it('翻页 → page 递增；「自报家门」不匹配时不渲染（防页码错配）', async () => {
    renderAt('/parent/errors');
    await screen.findByTestId('error-row-91');

    getErrorsMock.mockResolvedValue({ ...PAGE, page: 2, items: [PAGE.items[0]] });
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));

    await waitFor(() => expect(getErrorsMock).toHaveBeenLastCalledWith({ studentId: 11, track: 'main', page: 2 }));
    expect(await screen.findByTestId('error-row-91')).toBeInTheDocument();
  });

  it('清零状态筛选透传；切筛选回第 1 页', async () => {
    renderAt('/parent/errors');
    await screen.findByTestId('error-row-91');

    fireEvent.change(screen.getByLabelText('清零状态'), { target: { value: 'uncleared' } });

    await waitFor(() =>
      expect(getErrorsMock).toHaveBeenLastCalledWith({
        studentId: 11, track: 'main', cleared: 'uncleared', page: 1,
      }),
    );
  });

  it('学科筛选：下拉来自 /content/subjects，选中后 subject 透传', async () => {
    renderAt('/parent/errors');
    await screen.findByTestId('error-row-91');

    // 下拉选项是接口给的，不是硬编码
    const subjectSelect = await screen.findByLabelText('学科');
    expect(within(subjectSelect).getByRole('option', { name: '语文' })).toBeInTheDocument();

    fireEvent.change(subjectSelect, { target: { value: '2' } });

    await waitFor(() =>
      expect(getErrorsMock).toHaveBeenLastCalledWith({
        studentId: 11, track: 'main', subject: 2, page: 1,
      }),
    );
  });

  it('空数据 → 空态，不出分页', async () => {
    getErrorsMock.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });

    renderAt('/parent/errors');

    expect(await screen.findByTestId('errors-empty')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '下一页' })).not.toBeInTheDocument();
  });

  it('没有选孩子 → 空态，不发请求', async () => {
    useParentStudentStore.setState({ studentId: null });

    renderAt('/parent/errors');

    expect(await screen.findByTestId('errors-no-student')).toBeInTheDocument();
    expect(getErrorsMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/parent/ParentErrorsPage.test.tsx`
Expected: FAIL — 路由仍指向 `Placeholder`

- [ ] **Step 3: 实现页面**

创建 `apps/web/src/pages/parent/ParentErrorsPage.tsx`：

```tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { Button, Card, Pagination, Skeleton, Tag } from '@/components/base';
import {
  ApiError,
  fetchSubjects,
  getParentErrors,
  type ParentErrorItem,
  type ParentErrorPage,
  type SubjectItem,
} from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';

type TrackFilter = 'all' | 'main' | 'aux';

const TRACK_TABS: Array<{ key: TrackFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'main', label: '主线' },
  { key: 'aux', label: '辅线' },
];

/** `main_error_books.source` 的**实际** 5 个值（openapi 的 enum 不全，别照抄）。 */
const SOURCE_OPTIONS = [
  { value: '', label: '全部来源' },
  { value: 'practice', label: '课堂练习' },
  { value: 'discuss', label: '讨论' },
  { value: 'exam', label: '真题考试' },
  { value: 'targeted', label: '专项练习' },
  { value: 'error_practice', label: '错题练习' },
  { value: 'auxiliary', label: '辅线答疑' },
];

const SOURCE_LABEL = new Map(SOURCE_OPTIONS.map((o) => [o.value, o.label]));

function formatDay(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function ErrorRow({ item }: { item: ParentErrorItem }) {
  const [open, setOpen] = useState(false);

  return (
    <div data-testid={`error-row-${item.id}`} className="py-3">
      <div className="flex flex-wrap items-center gap-3">
        <Tag variant={item.track === 'aux' ? 'auxiliary' : 'mainline'}>
          {item.track === 'aux' ? '辅线' : '主线'}
        </Tag>
        <Tag>{SOURCE_LABEL.get(item.source) ?? item.source}</Tag>
        <span className="text-xs text-[var(--text-tertiary)]">{`难度级别 L${item.level}`}</span>
        <span className="text-xs text-[var(--text-tertiary)]">{formatDay(item.createdAt)}</span>
        <Tag variant={item.isCleared ? 'easy' : 'hard'}>
          {item.isCleared ? '已清零' : '未清零'}
        </Tag>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="ml-auto text-sm font-medium text-[var(--brand-600)] hover:underline"
        >
          {open ? '收起' : '展开'}
        </button>
      </div>

      {open && (
        <div
          data-testid={`error-detail-${item.id}`}
          className="mt-3 rounded-[var(--radius-card)] bg-[var(--bg-subtle)] p-4 text-sm"
        >
          {item.question ? (
            <>
              <p className="whitespace-pre-wrap text-[var(--text-primary)]">
                {item.question.content}
              </p>
              <p className="mt-2 text-xs text-[var(--text-secondary)]">
                {`题型：${item.question.type || '未标注'} · 难度：${
                  item.question.difficulty ?? '未标注'
                }`}
              </p>
              {item.question.knowledgePoints.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {item.question.knowledgePoints.map((kp) => (
                    <Tag key={kp.id} variant="knowledge">{kp.name}</Tag>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className="text-[var(--text-secondary)]">题目未入库（仅保存了作答内容）</p>
          )}

          <p className="mt-3 text-[var(--text-secondary)]">
            {`学生作答：${item.wrongAnswerText || '（空）'}`}
          </p>
          {item.clearedAt && (
            <p className="mt-1 text-xs text-[var(--text-tertiary)]">
              {`清零时间：${formatDay(item.clearedAt)}`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function ParentErrorsPage() {
  const studentId = useParentStudentStore((s) => s.studentId);
  const [track, setTrack] = useState<TrackFilter>('main');
  const [subject, setSubject] = useState('');
  const [source, setSource] = useState('');
  const [cleared, setCleared] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [subjects, setSubjects] = useState<SubjectItem[]>([]);
  const [data, setData] = useState<{ studentId: number; value: ParentErrorPage } | null>(null);
  const [failure, setFailure] = useState<{ studentId: number; code: number | null } | null>(null);
  const [reload, setReload] = useState(0);

  // 「自报家门」：不归当前孩子、或回显页号与当前页不符，都当作「还没到货」
  const list =
    data && data.studentId === studentId && data.value.page === page ? data.value : null;
  const err = failure && failure.studentId === studentId ? failure : null;

  // 学科下拉走既有的 /content/subjects（不新增端点）。失败就不显示这个筛选，不打扰家长。
  useEffect(() => {
    let cancelled = false;
    fetchSubjects()
      .then((res) => {
        if (!cancelled) setSubjects(res);
      })
      .catch(() => {
        /* 拉不到学科就退化为「不筛学科」 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (studentId === null) return;
    let cancelled = false;
    getParentErrors({
      studentId,
      ...(track === 'all' ? {} : { track }),
      ...(subject ? { subject: Number(subject) } : {}),
      ...(source ? { source } : {}),
      ...(cleared ? { cleared: cleared as 'uncleared' | 'cleared' } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      page,
    })
      .then((res) => {
        if (cancelled) return;
        setData({ studentId, value: res });
        setFailure(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setData(null);
        setFailure({ studentId, code: error instanceof ApiError ? error.code : null });
      });
    return () => {
      cancelled = true;
    };
  }, [studentId, track, subject, source, cleared, from, to, page, reload]);

  /** 任何筛选变化都要回第 1 页，否则会停在「第 3 页」而结果只有 1 页。 */
  const changeFilter = (apply: () => void) => {
    apply();
    setPage(1);
  };

  if (studentId === null) {
    return (
      <Card data-testid="errors-no-student" className="p-10 text-center">
        <p className="text-sm text-[var(--text-secondary)]">还没有选择孩子账号</p>
        <Link
          to="/parent/students"
          className="mt-3 inline-block text-sm font-medium text-[var(--brand-600)] hover:underline"
        >
          去创建学生账号
        </Link>
      </Card>
    );
  }

  const totalPages = list ? Math.max(1, Math.ceil(list.total / list.pageSize)) : 1;

  return (
    <div>
      <header className="mb-5">
        <h1 className="text-2xl font-black text-[var(--text-primary)]">错题查看</h1>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          孩子的错题本（只读），与学生在错题练习里看到的是同一份数据
        </p>
      </header>

      <div role="tablist" className="mb-4 flex gap-2">
        {TRACK_TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            type="button"
            aria-selected={track === t.key}
            // 切轨道时**必须清掉来源筛选**：`track=aux`（source = 'auxiliary'）叠加
            // `source='exam'` 在 SQL 里是永不匹配的组合，后端会安静地返回空列表 +
            // total 0，家长会读成「孩子没有错题」。这属于筛选器自相矛盾，前端负责不让它发生。
            onClick={() =>
              changeFilter(() => {
                setTrack(t.key);
                setSource('');
              })
            }
            className={clsx(
              'px-4 py-1.5 rounded-full text-sm font-medium border transition-colors',
              track === t.key
                ? 'border-[var(--brand-500)] bg-[var(--brand-100)] text-[var(--brand-600)]'
                : 'border-[var(--bg-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)]',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <Card className="mb-4 flex flex-wrap items-end gap-3 p-4">
        <label className="flex flex-col gap-1 text-xs text-[var(--text-tertiary)]">
          学科
          <select
            aria-label="学科"
            value={subject}
            onChange={(e) => changeFilter(() => setSubject(e.target.value))}
            className="rounded-[var(--radius-input)] border border-[var(--bg-subtle)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
          >
            <option value="">全部学科</option>
            {subjects.map((s) => (
              <option key={s.id} value={String(s.id)}>{s.name}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-[var(--text-tertiary)]">
          来源
          <select
            aria-label="来源"
            value={source}
            onChange={(e) => changeFilter(() => setSource(e.target.value))}
            className="rounded-[var(--radius-input)] border border-[var(--bg-subtle)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
          >
            {SOURCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-[var(--text-tertiary)]">
          清零状态
          <select
            aria-label="清零状态"
            value={cleared}
            onChange={(e) => changeFilter(() => setCleared(e.target.value))}
            className="rounded-[var(--radius-input)] border border-[var(--bg-subtle)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
          >
            <option value="">全部</option>
            <option value="uncleared">未清零</option>
            <option value="cleared">已清零</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-[var(--text-tertiary)]">
          起始日期
          <input
            aria-label="起始日期"
            type="date"
            value={from}
            onChange={(e) => changeFilter(() => setFrom(e.target.value))}
            className="rounded-[var(--radius-input)] border border-[var(--bg-subtle)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-[var(--text-tertiary)]">
          截止日期
          <input
            aria-label="截止日期"
            type="date"
            value={to}
            onChange={(e) => changeFilter(() => setTo(e.target.value))}
            className="rounded-[var(--radius-input)] border border-[var(--bg-subtle)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
          />
        </label>
      </Card>

      {err?.code === 1002 ? (
        <Card data-testid="errors-student-missing" className="p-10 text-center">
          <p className="text-sm text-[var(--text-secondary)]">
            该孩子账号不存在，请在顶部切换其它孩子
          </p>
        </Card>
      ) : err ? (
        <Card
          data-testid="errors-error"
          className="flex flex-wrap items-center justify-between gap-4 border border-[var(--error)] p-4"
        >
          <span className="text-sm text-[var(--text-secondary)]">错题暂时加载失败</span>
          <Button variant="secondary" size="sm" onClick={() => setReload((n) => n + 1)}>
            重试
          </Button>
        </Card>
      ) : list === null ? (
        <div data-testid="errors-skeleton" className="space-y-3">
          <Skeleton width="100%" height={56} />
          <Skeleton width="100%" height={56} />
        </div>
      ) : list.items.length === 0 ? (
        <Card data-testid="errors-empty" className="p-10 text-center">
          <p className="text-sm text-[var(--text-secondary)]">当前筛选下没有错题</p>
        </Card>
      ) : (
        <Card className="p-5">
          <p className="mb-2 text-sm text-[var(--text-secondary)]">{`共 ${list.total} 道`}</p>
          <div className="divide-y divide-[var(--bg-subtle)]">
            {list.items.map((item) => (
              <ErrorRow key={item.id} item={item} />
            ))}
          </div>
          {totalPages > 1 && (
            <div className="mt-4">
              <Pagination page={list.page} totalPages={totalPages} onChange={setPage} />
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 接入路由**

`routeTable.tsx`：加 `import ParentErrorsPage from '@/pages/parent/ParentErrorsPage';`，把
`<Placeholder title="错题查看 P6.3" />` 换成 `<ParentErrorsPage />`。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/pages/parent/ParentErrorsPage.test.tsx`
Expected: PASS（本任务新增的用例全绿）

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/pages/parent/ParentErrorsPage.tsx apps/web/src/pages/parent/ParentErrorsPage.test.tsx apps/web/src/routes/routeTable.tsx
git commit -m "feat(parent): 错题查看页（主线/辅线 Tab + 筛选 + 分页 + 展开详情）"
```

---

### Task 17: 前端 — AI 对话回放页 + 清理冗余路由

**Files:**
- Create: `apps/web/src/pages/parent/ParentChatLogsPage.tsx`
- Modify: `apps/web/src/routes/routeTable.tsx`（换页面 + **删除 `children-switch` 占位路由**）
- Test: `apps/web/src/pages/parent/ParentChatLogsPage.test.tsx`

**Interfaces:**
- Consumes: `getParentChatLogs(params)` / `getParentChatLogDetail(studentId, dialogueId)` / `ParentChatLogPage` / `ParentChatLogDetail`（Task 12）、`Pagination`（Task 13）、`useParentStudentStore`、基座 `Card` / `Skeleton` / `Button` / `Tag`
- Produces: `export default function ParentChatLogsPage()`

**页面行为（spec §5.1）**：
- 跟随锚点；无锚点 → 空态。
- 左侧会话列表：筛选（轨道 / 场景 / 时间范围 / 标题关键词）+ 分页 + 「自报家门」守卫。
- 右侧详情：逐句消息；`reasoning` 默认折叠（点「看 AI 思路」展开）；`safetyFlag === 1` 的消息**红色标记「闲聊/偏离学习」**。
- `blockCount > 0` 的会话在列表里也标红点。
- 删除 `/parent/children-switch` 冗余占位（顶栏 `StudentSwitcher` 已是真实实现）。

- [ ] **Step 1: 写失败的测试**

创建 `apps/web/src/pages/parent/ParentChatLogsPage.test.tsx`：

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { routes } from '@/routes/routeTable';
import {
  getParentChatLogDetail,
  getParentChatLogs,
  getUnreadMessageCount,
  listMyStudents,
  type ParentChatLogDetail,
  type ParentChatLogPage,
} from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';
import { useThemeStore } from '@/store/themeStore';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    listMyStudents: vi.fn(),
    getUnreadMessageCount: vi.fn(),
    getParentChatLogs: vi.fn(),
    getParentChatLogDetail: vi.fn(),
  };
});

const listMyStudentsMock = vi.mocked(listMyStudents);
const getUnreadMock = vi.mocked(getUnreadMessageCount);
const getLogsMock = vi.mocked(getParentChatLogs);
const getDetailMock = vi.mocked(getParentChatLogDetail);

const BOY = { id: 11, parentId: 3, username: 'xiaoming', name: '小明', age: 13, grade: '初一', schoolLevel: 'junior', isActive: true };

const LIST: ParentChatLogPage = {
  page: 1, pageSize: 20, total: 2,
  items: [
    {
      id: 55, track: 'auxiliary', scene: 'aux_qna', title: '二次函数求最值', subjectId: null,
      createdAt: '2026-09-16T10:00:00.000Z', updatedAt: '2026-09-16T10:05:00.000Z',
      messageCount: 8, blockCount: 2,
    },
    {
      id: 56, track: 'mainline', scene: 'mainline_card', title: '整式的加减', subjectId: 1,
      createdAt: '2026-09-15T10:00:00.000Z', updatedAt: '2026-09-15T10:05:00.000Z',
      messageCount: 4, blockCount: 0,
    },
  ],
};

const DETAIL: ParentChatLogDetail = {
  ...LIST.items[0],
  messages: [
    {
      id: 201, role: 'user', content: '怎么求最值', reasoning: null,
      type: null, model: null, safetyFlag: 0, createdAt: '2026-09-16T10:00:30.000Z',
    },
    {
      id: 202, role: 'assistant', content: '先判断开口方向', reasoning: '开口向上取最小值',
      type: 'socratic', model: 'qwen3.8-max', safetyFlag: 0, createdAt: '2026-09-16T10:01:00.000Z',
    },
    {
      id: 203, role: 'assistant', content: '我是你的学习助手，这个话题课后聊',
      reasoning: null, type: 'block', model: 'qwen3.8-max', safetyFlag: 1,
      createdAt: '2026-09-16T10:02:00.000Z',
    },
  ],
};

function validToken(): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }));
  return `header.${payload}.signature`;
}

function renderAt(path: string) {
  localStorage.setItem('token', validToken());
  localStorage.setItem('userRole', 'parent');
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const result = render(<RouterProvider router={router} />);
  return { router, ...result };
}

beforeEach(() => {
  localStorage.clear();
  useParentStudentStore.setState({ studentId: 11 });
  listMyStudentsMock.mockReset();
  listMyStudentsMock.mockResolvedValue([BOY] as any);
  getUnreadMock.mockReset();
  getUnreadMock.mockResolvedValue(0);
  getLogsMock.mockReset();
  getLogsMock.mockResolvedValue(LIST);
  getDetailMock.mockReset();
  getDetailMock.mockResolvedValue(DETAIL);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useParentStudentStore.setState({ studentId: null });
  useThemeStore.setState({ mode: 'student-day' });
});

describe('ParentChatLogsPage', () => {
  it('按锚点孩子取会话列表，默认无筛选、page=1', async () => {
    renderAt('/parent/chat-logs');

    expect(await screen.findByTestId('chatlog-item-55')).toBeInTheDocument();
    expect(getLogsMock).toHaveBeenCalledWith({ studentId: 11, page: 1 });
  });

  it('blockCount > 0 的会话在列表里标红', async () => {
    renderAt('/parent/chat-logs');

    expect(await screen.findByTestId('chatlog-block-badge-55')).toBeInTheDocument();
    expect(screen.queryByTestId('chatlog-block-badge-56')).not.toBeInTheDocument();
  });

  it('点会话 → 拉详情并逐句渲染；block 消息红色标记 + reasoning 折叠', async () => {
    renderAt('/parent/chat-logs');
    await screen.findByTestId('chatlog-item-55');

    fireEvent.click(screen.getByTestId('chatlog-item-55'));

    expect(await screen.findByTestId('chatlog-message-203')).toHaveTextContent('闲聊/偏离学习');
    // reasoning 默认折叠
    expect(screen.queryByTestId('chatlog-reasoning-202')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /看 AI 思路/ }));
    expect(screen.getByTestId('chatlog-reasoning-202')).toHaveTextContent('开口向上取最小值');
  });

  it('轨道筛选透传（选辅线答疑）', async () => {
    renderAt('/parent/chat-logs');
    await screen.findByTestId('chatlog-item-55');

    fireEvent.change(screen.getByLabelText('轨道'), { target: { value: 'auxiliary' } });

    await waitFor(() =>
      expect(getLogsMock).toHaveBeenLastCalledWith({ studentId: 11, track: 'auxiliary', page: 1 }),
    );
  });

  it('关键词搜索只搜标题（传 q）', async () => {
    renderAt('/parent/chat-logs');
    await screen.findByTestId('chatlog-item-55');

    fireEvent.change(screen.getByLabelText('搜索会话标题'), { target: { value: '函数' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));

    await waitFor(() =>
      expect(getLogsMock).toHaveBeenLastCalledWith({ studentId: 11, q: '函数', page: 1 }),
    );
  });

  it('空数据 → 空态，右侧显示「选择一条对话」', async () => {
    getLogsMock.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });

    renderAt('/parent/chat-logs');

    expect(await screen.findByTestId('chatlogs-empty')).toBeInTheDocument();
    expect(screen.getByTestId('chatlog-detail-placeholder')).toBeInTheDocument();
  });

  it('没有选孩子 → 空态，不发请求', async () => {
    useParentStudentStore.setState({ studentId: null });

    renderAt('/parent/chat-logs');

    expect(await screen.findByTestId('chatlogs-no-student')).toBeInTheDocument();
    expect(getLogsMock).not.toHaveBeenCalled();
  });
});

describe('路由清理', () => {
  it('/parent/children-switch 已从路由表删除（顶栏 StudentSwitcher 是真实实现）', () => {
    // 直接查路由表，而不是渲染该路径再看 404 兜底——后者依赖 react-router 的错误渲染行为，
    // 断言会很脆。这里要钉的是「这条路由不存在了」。
    const parentRoute = routes.find((r) => r.path === '/parent');
    const childPaths = (parentRoute?.children ?? []).map((c) => c.path);
    expect(childPaths).not.toContain('children-switch');
  });
});
```

> 本用例不需要 `render`，`ParentChatLogsPage.test.tsx` 的 `beforeEach` 里那些 mock 不影响它。
> 若 `routeTable.test.tsx` 里也有引用 `children-switch` 的断言，一并删掉（测试跟随实现变更）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/parent/ParentChatLogsPage.test.tsx`
Expected: FAIL — 路由仍指向 `Placeholder`

- [ ] **Step 3: 实现页面**

创建 `apps/web/src/pages/parent/ParentChatLogsPage.tsx`：

```tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { Button, Card, Pagination, Skeleton, Tag } from '@/components/base';
import {
  ApiError,
  getParentChatLogDetail,
  getParentChatLogs,
  type ParentChatLogDetail,
  type ParentChatLogItem,
  type ParentChatLogPage,
} from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';

type TrackFilter = '' | 'mainline' | 'auxiliary';

const SCENE_OPTIONS = [
  { value: '', label: '全部场景' },
  { value: 'aux_qna', label: '辅线答疑' },
  { value: 'aux_training', label: '训练讲一讲' },
  { value: 'mainline_card', label: '主线卡片讨论' },
  { value: 'mainline_question', label: '主线题目讨论' },
];

const SCENE_LABEL = new Map(SCENE_OPTIONS.map((o) => [o.value, o.label]));

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function MessageRow({ message }: { message: ParentChatLogDetail['messages'][number] }) {
  const [showReasoning, setShowReasoning] = useState(false);
  const isBlocked = message.safetyFlag === 1;
  const isUser = message.role === 'user';

  return (
    <div
      data-testid={`chatlog-message-${message.id}`}
      className={clsx(
        'rounded-[var(--radius-card)] p-3 text-sm',
        isUser ? 'bg-[var(--brand-100)]' : 'bg-[var(--bg-subtle)]',
        // 闲聊/偏离学习：红色边框 + 红字标签（本批唯一有真数据的预警信号）
        isBlocked && 'border border-[var(--error)]',
      )}
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="text-xs font-semibold text-[var(--text-secondary)]">
          {isUser ? '孩子' : 'AI'}
        </span>
        {isBlocked && <Tag variant="hard">闲聊/偏离学习</Tag>}
        {message.type && !isBlocked && (
          <span className="text-xs text-[var(--text-tertiary)]">{message.type}</span>
        )}
        <span className="ml-auto text-xs text-[var(--text-tertiary)]">
          {formatDateTime(message.createdAt)}
        </span>
      </div>

      <p className="whitespace-pre-wrap text-[var(--text-primary)]">{message.content}</p>

      {message.reasoning && (
        <>
          <button
            type="button"
            onClick={() => setShowReasoning((v) => !v)}
            className="mt-2 text-xs font-medium text-[var(--brand-600)] hover:underline"
          >
            {showReasoning ? '收起 AI 思路' : '看 AI 思路'}
          </button>
          {showReasoning && (
            <p
              data-testid={`chatlog-reasoning-${message.id}`}
              className="mt-2 whitespace-pre-wrap text-xs text-[var(--text-secondary)]"
            >
              {message.reasoning}
            </p>
          )}
        </>
      )}
    </div>
  );
}

export default function ParentChatLogsPage() {
  const studentId = useParentStudentStore((s) => s.studentId);
  const [track, setTrack] = useState<TrackFilter>('');
  const [scene, setScene] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [keyword, setKeyword] = useState('');
  const [appliedKeyword, setAppliedKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [list, setList] = useState<{ studentId: number; value: ParentChatLogPage } | null>(null);
  const [failure, setFailure] = useState(false);
  const [reload, setReload] = useState(0);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ParentChatLogDetail | null>(null);
  const [detailFailed, setDetailFailed] = useState(false);

  // 「自报家门」：不归当前孩子、或回显页号对不上 → 当作还没到货
  const pageData =
    list && list.studentId === studentId && list.value.page === page ? list.value : null;

  useEffect(() => {
    if (studentId === null) return;
    let cancelled = false;
    setFailure(false);
    getParentChatLogs({
      studentId,
      ...(track ? { track } : {}),
      ...(scene ? { scene } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(appliedKeyword ? { q: appliedKeyword } : {}),
      page,
    })
      .then((res) => {
        if (cancelled) return;
        setList({ studentId, value: res });
      })
      .catch(() => {
        if (cancelled) return;
        setList(null);
        setFailure(true);
      });
    return () => {
      cancelled = true;
    };
  }, [studentId, track, scene, from, to, appliedKeyword, page, reload]);

  useEffect(() => {
    if (studentId === null || activeId === null) return;
    let cancelled = false;
    setDetailFailed(false);
    getParentChatLogDetail(studentId, activeId)
      .then((res) => {
        if (cancelled) return;
        setDetail(res);
      })
      .catch(() => {
        if (cancelled) return;
        setDetail(null);
        setDetailFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [studentId, activeId]);

  /** 任何筛选变化都回第 1 页。 */
  const changeFilter = (apply: () => void) => {
    apply();
    setPage(1);
  };

  if (studentId === null) {
    return (
      <Card data-testid="chatlogs-no-student" className="p-10 text-center">
        <p className="text-sm text-[var(--text-secondary)]">还没有选择孩子账号</p>
        <Link
          to="/parent/students"
          className="mt-3 inline-block text-sm font-medium text-[var(--brand-600)] hover:underline"
        >
          去创建学生账号
        </Link>
      </Card>
    );
  }

  const totalPages = pageData ? Math.max(1, Math.ceil(pageData.total / pageData.pageSize)) : 1;

  return (
    <div>
      <header className="mb-5">
        <h1 className="text-2xl font-black text-[var(--text-primary)]">AI 对话回放</h1>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          逐句查看孩子与 AI 的完整对话（含主线讨论与辅线答疑）
        </p>
      </header>

      <Card className="mb-4 flex flex-wrap items-end gap-3 p-4">
        <label className="flex flex-col gap-1 text-xs text-[var(--text-tertiary)]">
          轨道
          <select
            aria-label="轨道"
            value={track}
            onChange={(e) => changeFilter(() => setTrack(e.target.value as TrackFilter))}
            className="rounded-[var(--radius-input)] border border-[var(--bg-subtle)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
          >
            <option value="">全部</option>
            <option value="mainline">主线讨论</option>
            <option value="auxiliary">辅线答疑</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-[var(--text-tertiary)]">
          场景
          <select
            aria-label="场景"
            value={scene}
            onChange={(e) => changeFilter(() => setScene(e.target.value))}
            className="rounded-[var(--radius-input)] border border-[var(--bg-subtle)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
          >
            {SCENE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-[var(--text-tertiary)]">
          起始日期
          <input
            aria-label="起始日期"
            type="date"
            value={from}
            onChange={(e) => changeFilter(() => setFrom(e.target.value))}
            className="rounded-[var(--radius-input)] border border-[var(--bg-subtle)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-[var(--text-tertiary)]">
          截止日期
          <input
            aria-label="截止日期"
            type="date"
            value={to}
            onChange={(e) => changeFilter(() => setTo(e.target.value))}
            className="rounded-[var(--radius-input)] border border-[var(--bg-subtle)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-[var(--text-tertiary)]">
          搜索会话标题
          <input
            aria-label="搜索会话标题"
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="只搜会话标题"
            className="rounded-[var(--radius-input)] border border-[var(--bg-subtle)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
          />
        </label>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => changeFilter(() => setAppliedKeyword(keyword))}
        >
          搜索
        </Button>
      </Card>

      {failure ? (
        <Card
          data-testid="chatlogs-error"
          className="flex flex-wrap items-center justify-between gap-4 border border-[var(--error)] p-4"
        >
          <span className="text-sm text-[var(--text-secondary)]">对话记录暂时加载失败</span>
          <Button variant="secondary" size="sm" onClick={() => setReload((n) => n + 1)}>
            重试
          </Button>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
          <Card className="p-4">
            {pageData === null ? (
              <div data-testid="chatlogs-skeleton" className="space-y-3">
                <Skeleton width="100%" height={56} />
                <Skeleton width="100%" height={56} />
              </div>
            ) : pageData.items.length === 0 ? (
              <p data-testid="chatlogs-empty" className="py-8 text-center text-sm text-[var(--text-secondary)]">
                当前筛选下没有对话记录
              </p>
            ) : (
              <>
                <div className="divide-y divide-[var(--bg-subtle)]">
                  {pageData.items.map((item: ParentChatLogItem) => (
                    <button
                      key={item.id}
                      type="button"
                      data-testid={`chatlog-item-${item.id}`}
                      onClick={() => setActiveId(item.id)}
                      className={clsx(
                        'w-full py-3 text-left transition-colors',
                        activeId === item.id && 'bg-[var(--brand-100)]',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-[var(--text-primary)]">
                          {item.title || '未命名会话'}
                        </span>
                        {item.blockCount > 0 && (
                          <span
                            data-testid={`chatlog-block-badge-${item.id}`}
                            className="rounded-full bg-[var(--error)] px-2 py-0.5 text-[10px] font-bold text-white"
                          >
                            {`闲聊 ${item.blockCount}`}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--text-tertiary)]">
                        <span>{item.track === 'mainline' ? '主线' : '辅线'}</span>
                        <span>{SCENE_LABEL.get(item.scene) ?? item.scene}</span>
                        <span>{`${item.messageCount} 句`}</span>
                        <span>{formatDateTime(item.updatedAt)}</span>
                      </div>
                    </button>
                  ))}
                </div>
                {totalPages > 1 && (
                  <div className="mt-3">
                    <Pagination page={pageData.page} totalPages={totalPages} onChange={setPage} />
                  </div>
                )}
              </>
            )}
          </Card>

          <Card className="p-4">
            {activeId === null ? (
              <p
                data-testid="chatlog-detail-placeholder"
                className="py-16 text-center text-sm text-[var(--text-secondary)]"
              >
                选择左侧一条对话查看逐句回放
              </p>
            ) : detailFailed ? (
              <p className="py-16 text-center text-sm text-[var(--text-secondary)]">
                这条对话暂时无法查看
              </p>
            ) : detail === null || detail.id !== activeId ? (
              <div className="space-y-3">
                <Skeleton width="100%" height={64} />
                <Skeleton width="100%" height={64} />
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-bold text-[var(--text-primary)]">
                    {detail.title || '未命名会话'}
                  </h2>
                  <span className="text-xs text-[var(--text-tertiary)]">
                    {`${detail.messageCount} 句 · ${formatDateTime(detail.createdAt)}`}
                  </span>
                </div>
                {detail.messages.map((m) => (
                  <MessageRow key={m.id} message={m} />
                ))}
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 接入路由 + 删除冗余占位**

`apps/web/src/routes/routeTable.tsx`：
1. 加 `import ParentChatLogsPage from '@/pages/parent/ParentChatLogsPage';`
2. `<Placeholder title="AI 对话全透明回放 P6.4" />` → `<ParentChatLogsPage />`
3. **删除**这一行：`{ path: 'children-switch', element: <Placeholder title="多孩切换 P6.8" /> },`
   —— 顶栏 `StudentSwitcher`（`ParentLayout.tsx:57`）是真实实现，这条路由从来没被导航到过。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/pages/parent/ParentChatLogsPage.test.tsx`
Expected: PASS（本任务新增的用例全绿）

- [ ] **Step 6: 全量前端测试 + lint + 构建**

Run: `cd apps/web && npm test && npm run lint && npm run build`
Expected: 全绿 + 构建无错。
注意：`routeTable.test.tsx` 里若有断言引用 `children-switch`，同步删掉那条断言（测试跟随实现变更）。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/pages/parent/ParentChatLogsPage.tsx apps/web/src/pages/parent/ParentChatLogsPage.test.tsx apps/web/src/routes/routeTable.tsx apps/web/src/routes/routeTable.test.tsx
git commit -m "feat(parent): AI 对话回放页（左列表右详情 + 闲聊红标 + 删冗余路由）"
```

---

### Task 18: 文档同步

**Files:**
- Modify: `docs/api/openapi.yaml`
- Modify: `docs/API接口与数据流设计文档.md`
- Modify: `docs/UX-UI设计文档.md`
- Modify: `docs/K12智学系统-产品需求文档.md`
- Modify: `docs/ai-core-changelog.md`
- Modify: `CLAUDE.md`（仅在确有必要时）

**这是硬规则，不能省**：CLAUDE.md 明写「`API接口与数据流设计文档.md` 与 `openapi.yaml` 必须始终一致」，且「任何一方变更时，另一方必须同步更新」。

- [ ] **Step 1: 改 openapi.yaml**

六处改动（照 spec §7 的表）：

1. `Dashboard` schema：去掉 `todayStudyMinutes`；`students[]` 加 `lastActiveAt` / `activeDays7`；新增 `subjects[]`（含 `subjectId` / `subjectName` / `progress{completedUnits,totalUnits,currentUnitName,currentLessonName,percent}` / `accuracy{answered,correct,rate}` / `selfAssessed{count,correctCount}` / `errorBook{uncleared,total}` / `examCount`）。`rate` 用 `nullable: true`。
2. `LearningReport` / `ReportContent`：替换为 spec §4.2 ② 的结构（`stats` / `trend[]` / `subjects[]` / `weakPoints[]` / `weakPointsUncoveredCount` / `exams[]`）。**删掉** `GET /parent/students/{studentId}/reports/{reportId}` 这条 path。
3. `GET /parent/students/{studentId}/reports`：加 query 参数 `period`（`enum: [weekly, monthly]`，默认 `weekly`）。
4. `GET /parent/students/{studentId}/errors`：加 query `subject` / `source` / `track`（enum main,aux）/ `cleared`（enum uncleared,cleared,all）/ `from` / `to` / `page`；响应改为分页壳 `{items, page, pageSize, total}`。`ErrorItem.source` 的 enum 按**实际值**改成 `[practice, discuss, exam, targeted, error_practice, auxiliary]`。
5. `GET /parent/students/{studentId}/chat-logs`：加 query `track` / `scene` / `from` / `to` / `q` / `page`；响应改为分页壳；新增 `ChatLogItem` schema（含 `messageCount` / `blockCount`）。
6. 新增 `ChatLogDetail` schema（`ChatLogItem` + `messages[]`，每条含 `id/role/content/reasoning/type/model/safetyFlag/createdAt`）。
   - **注意 `updatedAt` 的语义**：新 `ChatLogItem.updatedAt` 的 description 必须写清是「**最后一条消息时间**（无消息则退回创建时间）」。现在 `openapi.yaml:2399` 的家长端会话列表挂在**共享的 `Conversation` schema** 上，而那个 schema 的 `updatedAt`（约 `:6343`）与学生端端点同源、指的是 `ai_dialogues.updated_at`——不改就会在契约里留下「同一字段两种含义」的歧义。
   - 分页壳沿用 `{items, page, pageSize, total}`，与 errors 一致。

校验：
```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12 && grep -n 'parent/students/{studentId}/reports/{reportId}' docs/api/openapi.yaml docs/API接口与数据流设计文档.md
```
Expected: 无输出（两份文档里都删干净了）。

- [ ] **Step 2: 改 API 设计文档**

1. §4.13 端点表：删 `/api/parent/students/{studentId}/reports/{reportId}` 一行；`reports` 那行语义改成「实时聚合学情报告（不落库）」；`errors` / `chat-logs` 补上新 query 参数说明。
2. §6.8「学情报告生成与展示」**整节重写**：
   ```text
   触发时机：家长打开学情报告页，或切换周报/月报
     │
     ▼
   GET /api/parent/students/{studentId}/reports?period=weekly|monthly
     │
     ▼
   ReportService 实时聚合（不落库、不调 LLM）：
     │  - ParentInsightsRepository：活跃度 / 正确率 / 自评 / 错题统计 / 趋势 / 考试
     │  - ProgressService.getStarMap（仅仪表盘用）
     │  - 窗口口径 = 近 7 天（weekly）/ 近 30 天（monthly）
     │
     ▼
   直接返回结构化报告，家长端渲染图表
   ```
   并在节末加一行注：`learning_reports` 表本期**未使用**；AI 生成报告文本（`AnalyticsCapability` + `analysis` 场景）留作后续迭代。
3. §2.4 错误码表后的「实现注」补一条：家长端学情端点沿用 1002（学生不存在）/ 1005（无权操作该学生）。

- [ ] **Step 3: 改 UX 文档**

1. §5.6 P6.1：把「今日学习时长」改成「近 7 天活跃天数 + 最近活跃时间」，并加一句口径说明（系统当前无学习时长埋点）。
2. §5.6 P6.2：把「学习时长曲线」改成「答题量与正确率趋势」、「薄弱点雷达图」改成「薄弱知识点 Top（按未清零错题数）」，并注明「薄弱点为错题数代理，仅统计已标注知识点的错题，页面会显示未标注条数」。
3. §5.6 P6.4：筛选维度由「按日期/学科/课程筛选」改成「按轨道/场景/时间/标题关键词筛选」，并加一句「不提供学科筛选：`ai_dialogues.subject_id` 约 76% 为空」。

- [ ] **Step 4: 改 PRD**

§7.7 第一条「查看学习报告：按学科查看学习时长、完成进度、正确率、薄弱点」→ 把「学习时长」标注为后续迭代（与当前口径一致），其余不动。改动要最小。

- [ ] **Step 5: 追加 changelog**

在 `docs/ai-core-changelog.md` **顶部**追加本批条目，包含：

- 日期 2026-09-18、本批范围（四页 + 6 端点 + 新模块 `modules/parent-insights/`）。
- **实测数据**（写进文档，未来判断口径时有用）：错题 139 条仅 40% 能映射知识点；`exam_answers` 564 行 vs `practice_results` 1 行（正确率主源是考试）；`ai_dialogues.subject_id` 76% 为 NULL；`ai_messages.safety_flag=1` 共 22 条。
- **遗留风险 / 已知限制**：照 spec §9 八条抄进 changelog（学习时长为代理指标、`practice_results` 是覆盖式最新态、关键词只搜标题、`unreadAlerts` 恒 0 等）。

- [ ] **Step 6: 判断 CLAUDE.md 要不要改**

只有当本批引入了**新的、未来必须遵守的硬约束**时才改。本批值得写进 CLAUDE.md 的只有一条判断标准：

> 家长端学情四页（仪表盘/报告/错题/回放）是**实时聚合、只读**；学情报告**不落 `learning_reports`**，也不要往这四个端点里加写入逻辑。

若决定写入，加在「独立子系统」节后面，一两句话，**不要**把带日期的细节写进 CLAUDE.md（照项目约定，日期日志进 changelog）。

- [ ] **Step 7: 一致性自检**

Run:
```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12 && \
  grep -oE "^\s{2}/parent/[^:]+:" docs/api/openapi.yaml | sort -u && \
  grep -nE "GET \| /api/parent|POST \| /api/parent|PATCH \| /api/parent|PUT \| /api/parent" docs/API接口与数据流设计文档.md
```
Expected: 两份列表逐一对应（openapi 里的父路径 + 方法 vs API 文档 §4.13 的表）。有出入就补齐。

- [ ] **Step 8: 提交**

```bash
git add docs/
git commit -m "docs(parent): 同步学情四页契约（openapi/API/UX/PRD/changelog）"
```

---

## 附：全批完成后的人工验收清单

跑完自动化测试后，按这份清单在浏览器里过一遍（`cd apps/server && npm run build && PORT=3399 node dist/main.js`，另开 `cd apps/web && npm run dev`；**用 3399 而不是默认端口，别 kill 已在跑的后端**）：

1. 家长登录 → `/parent/dashboard`：能看到名下所有孩子；多孩时 Tab 可切；学科卡片数字与「学生账号 → 学习配置」里的配置一致。
2. 点某孩子的「学情报告」→ 报告页顶栏锚点是那个孩子（**不是**第一个）；切周报/月报数字会变。
3. `/parent/errors`：主线 Tab 有数据、辅线 Tab 只有 `source='auxiliary'` 的；点展开能看到题干；筛「未清零」条数变少。
4. `/parent/chat-logs`：左侧能看到主线讨论与辅线答疑；点进去逐句可读；有闲聊的会话列表上有红标、消息里红框。
5. **越权检查**：用 A 家长的 token 请求 `/api/parent/students/{B家长的孩子id}/errors` → 404/1002。
6. **空数据检查**：给一个刚创建、什么都没做过的孩子看四页 → 全是空态，**没有任何一页报错**。
7. iPad 横屏（1024px）与 PC（1280px）各看一遍四页，图表不溢出、不横向滚动。

