# 数学薄弱点图谱与推荐 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 学生端训练轨新增「薄弱点图谱」全屏页——以掌握度给两级知识点树着色，并给出一条「最该补」的推荐，一键开练。

**Architecture:** 后端新建只读模块 `knowledge-graph`（两个 GET 端点），复用既有三个仓储 + 新增 4 个只读查询；推荐算法三道闸门（有行 / 样本 ≥5 / 有题可抽）+ 稳定排序，`MIN_SAMPLE_SIZE` 是唯一阈值真源。前端新增独立全屏页，一级折叠树 + 右栏详情（窄屏降级底部抽屉），热力梯度与档位选择各抽成单一实现模块，避免页面内重算。

**Tech Stack:** NestJS + MySQL2（apps/server）、React 18 + Vite + Tailwind + Vitest/RTL（apps/web）、React Router 6。

**Spec:** `docs/superpowers/specs/2026-09-23-math-weakpoint-graph-design.md`（已提交 `d2b21b4`）

## Global Constraints

- **仅数学**：`subjectId` 只接受 `1`，其它值一律 400 / code 1001。
- **训练轨页面**：全屏、硬编码 `data-theme="student-day"`、**不在任何 Layout 下**、无侧栏、无日夜切换（CLAUDE.md 硬约束）。
- **无 emoji**；所有图标一律线性 SVG（`fill="none" stroke="currentColor" strokeWidth="1.5"`）。
- **配色只有一套**（`apps/web/style.md` §2）：热力梯度只能从 brand 橘红 `#ff6b35` 派生，**不得引入第二套配色**。
- **`data-school` 只调字号**，不改颜色与圆角。
- **错误码约定**：`BadRequestException({code:1001, ...})`；**403 必须显式传 `{code:1005}`**——`HttpExceptionFilter.httpStatusToCode` 对 403 的默认值是 **1003**，不显式传会得到错的 code。
- **阈值单一真源**：`MIN_SAMPLE_SIZE = 5` 由后端导出，前端**不重算** `confidence`。
- **只读端点**：本期两个端点无任何写入；查询失败按 Nest 默认 500 抛出（不加吞异常——这不是埋点路径）。
- **不新增表 / 列 / 迁移**（`tools/db/migrations/` 本期不动）。
- **测试与文档同步铁律**：测试断言与 config / types / 设计文档冲突时**测试错**，改测试。
- **状态由界面表达，不加说明文案**：某个状态（加载中 / 失败 / 不可用）要让学生看懂时，用**控件本身**表达——loading 转圈、可操作的**重试按钮**、干脆不渲染死控件；**不要**加一行解释文字。界面表达不了，说明状态被合并/丢失了（先查是不是该复用既有 hook，如 `usePointTiers`）。
- **`globals: false`**：前端多用例测试文件必须自己 `afterEach(() => cleanup())`。
- **组件改动必须补渲染测试**（类型检查抓不到运行时数据形状问题）。
- 前端命令在 `apps/web/` 执行；后端命令在 `apps/server/` 执行。

---

## 文件结构

**后端（新增模块 + 既有仓储扩方法）**

| 文件 | 职责 |
|---|---|
| `apps/server/src/database/repositories/knowledge-points.repo.ts`（改） | 加 `countAvailableQuestionsByKp()`：一次分组查询取「该生可抽题数」 |
| `apps/server/src/database/repositories/student-knowledge-mastery.repo.ts`（改） | 加 `listBySubject()`、`countQuestionCoverageBySubject()` |
| `apps/server/src/database/repositories/main-error-books.repo.ts`（改） | 加 `countUncoveredUncleared()` |
| `apps/server/src/database/sql-fragments.ts`（新） | 跨模块共享的 SQL 片段常量（目前只有「未标注知识点的错题」谓词） |
| `apps/server/src/database/repositories/parent-insights.repo.ts`（改） | `countUncoveredUnclearedErrors` 改用同一共享常量（消除漂移） |
| `apps/server/src/modules/knowledge-graph/dto/knowledge-graph.dto.ts`（新） | 端点出参类型 + `MIN_SAMPLE_SIZE` + `WEAK_LEVEL_MAX` |
| `apps/server/src/modules/knowledge-graph/knowledge-graph.service.ts`（新） | 组装树 + overlay；推荐算法 |
| `apps/server/src/modules/knowledge-graph/knowledge-graph.controller.ts`（新） | 两个 GET 路由 + 入参/归属校验 |
| `apps/server/src/modules/knowledge-graph/knowledge-graph.module.ts`（新） | 模块注册（只 provide，无 imports） |
| `apps/server/src/app.module.ts`（改） | 注册 `KnowledgeGraphModule` |

**前端（新页 + 两处抽取 + 入口）**

| 文件 | 职责 |
|---|---|
| `apps/web/src/services/api.ts`（改） | 4 个类型 + 2 个函数 |
| `apps/web/src/pages/student/training/point-tiers.ts`（改） | 加 `MATH_TASK_CODE`（两页共用的任务代号真源）+ `MIN_PRACTICE_COUNT` + `pickPracticeCount()` |
| `apps/web/src/pages/student/training/TargetedConfigPage.tsx`（改） | 私有 `MATH_TASK_CODE` 改为从 `point-tiers` import（行为零变化） |
| `apps/web/src/pages/student/training/weak-point-heat.ts`（新） | 热力梯度 / 中性态 / 一级汇总——**唯一实现** |
| `apps/web/src/pages/student/training/WeakPointGraphPage.tsx`（新） | 页面 |
| `apps/web/src/routes/routeTable.tsx`（改） | 注册 `/student/training/weak-points` |
| `apps/web/src/pages/student/training/TrainingHomePage.tsx`（改） | 三卡 → 四卡 |
| `apps/web/src/pages/student/training/ErrorPracticePage.tsx`（改） | 支持 `?kpId=` 预填筛选 |

**测试**

| 文件 | 覆盖 |
|---|---|
| `knowledge-points.repo.test.ts`（**已存在 25 行，追加**） | SQL 谓词钉子 |
| `student-knowledge-mastery.repo.test.ts`（**已存在 88 行，追加**） | 两方法形状 + SQL 谓词钉子 |
| `main-error-books.repo.test.ts`（**已存在 242 行，追加**） | `countUncoveredUncleared` 谓词钉子 |
| `sql-fragments.test.ts`（新） | 共享片段文本钉子（两处共用的唯一真源） |
| `knowledge-graph.service.test.ts`（新） | 三道闸门 / 排序 / 空候选 / confidence 三态 |
| `knowledge-graph.controller.test.ts`（新） | 403/1005、400/1001、透传 |
| `weak-point-heat.test.ts`（新） | 梯度夹取 / 三态 / 汇总 |
| `point-tiers.test.ts`（改） | `pickPracticeCount` 三种边界 + `MATH_TASK_CODE` 真源钉子 |
| `WeakPointGraphPage.test.tsx`（新） | 折叠 / 详情 / 推荐两态 / 档位四态 / 三态渲染 / 页脚 |
| `TrainingHomePage.test.tsx`（改） | 第 4 张卡存在且可点 |
| `routeTable.test.tsx`（改） | 「路由确实指到 `WeakPointGraphPage`」的唯一证明 |
| `ErrorPracticePage.test.tsx`（改） | `?kpId=` 预填 |

---

## Task 1: 后端仓储读方法（4 个查询）

**Files:**
- Modify: `apps/server/src/database/repositories/knowledge-points.repo.ts`
- Modify: `apps/server/src/database/repositories/student-knowledge-mastery.repo.ts`
- Modify: `apps/server/src/database/repositories/main-error-books.repo.ts`
- Modify: `apps/server/src/database/repositories/parent-insights.repo.ts`（**只改 `countUncoveredUnclearedErrors` 一处，用共享常量**）
- Create: `apps/server/src/database/sql-fragments.ts`
- Test: `apps/server/src/database/repositories/knowledge-points.repo.test.ts`（**已存在，追加一个 describe**）
- Test: `apps/server/src/database/repositories/student-knowledge-mastery.repo.test.ts`（**已存在，追加两个 describe**）
- Test: `apps/server/src/database/repositories/main-error-books.repo.test.ts`（**已存在，追加一个 describe**）
- Test: `apps/server/src/database/sql-fragments.test.ts`（**新建**）

**Interfaces:**
- Produces:
  - `KnowledgePointsRepository.countAvailableQuestionsByKp(studentId: number, subjectId: number): Promise<Map<number, number>>`
  - `StudentKnowledgeMasteryRepository.listBySubject(studentId: number, subjectId: number): Promise<Array<{ knowledgePointId: number; masteryScore: number; level: number; correctCount: number; errorCount: number; lastSeenAt: Date | null }>>`
  - `StudentKnowledgeMasteryRepository.countQuestionCoverageBySubject(subjectId: number): Promise<{ coveredQuestions: number; totalQuestions: number }>`
  - `MainErrorBooksRepository.countUncoveredUncleared(studentId: number, subjectId: number): Promise<number>`
  - `apps/server/src/database/sql-fragments.ts` 导出 `UNCOVERED_ERROR_PREDICATE: string`

**为什么这些谓词必须逐字对齐：** 本仓既有盲区是 `mockPool` 不看 SQL 文本——别名 / 谓词改错也全绿（见 `docs/ai-core-changelog.md` 2026-09-20 的 I2 教训）。故每个方法都要用 `expect(sql).toContain(...)` 把谓词钉住。

**注意 `subjectId` 作用域：** spec §5.1 说「口径照抄」家长端 `countUncoveredUnclearedErrors`，但那个查询**不带学科**。本页是数学专用页，`coverage` 与「未标注错题数」都必须是**数学口径**，否则页脚会把语文/英语的错题算进数学页。这是对 spec 的**有意细化**，已在 spec §9 文档同步清单外补记于本计划。

**为什么抽共享片段（2026-09-23 用户裁决，替代原「两处各写一份」）：** 两个查询的 `NOT EXISTS (...)` 子句**逐字相同**，只有外层 `subject_id` 谓词不同。原先「各写一份」的写法在 Task 1 审查中被 reviewer 标为 Important（plan-mandated 近重复），残留风险是**改一处忘另一处会静默漂移**，而两边的测试各自只钉住自己那份、钉不住对方。用户裁决：把**子句**抽成中立常量、两处共用；`subject_id` 的差异仍留在各自查询里（这是**语义差异**，不是重复）。常量放 `src/database/sql-fragments.ts`（纯字符串、无依赖），两个仓储 import 它 —— 只共享字符串，不造成模块耦合，也没有 import `ParentInsightsRepository`。

**⚠️ 两处查询都用 `meb` 作为 `main_error_books` 的别名**（`parent-insights.repo.ts:484`、`main-error-books.repo.ts:168`），所以片段可以逐字共用。若将来给某一边换别名，必须同步改片段或改用参数化别名。

- [ ] **Step 1: 写失败的仓储测试**

`apps/server/src/database/repositories/knowledge-points.repo.test.ts` —— **该文件已存在（25 行）**，不要覆盖。它顶部已有 `mockPool(rows)`（只有 `execute`，够本用例用）与 `KnowledgePointsRepository` 的 import。把下面这个 `describe` **追加到文件末尾**，**不新增任何 import**：

```ts
describe('KnowledgePointsRepository.countAvailableQuestionsByKp', () => {
  it('一次分组查询返回 kp_id -> 可抽题数 的 Map', async () => {
    const pool = mockPool([
      { kp_id: 11, n: 7 },
      { kp_id: 12, n: 0 },
      { kp_id: 13, n: '3' },
    ]);
    const repo = new KnowledgePointsRepository(pool as any);

    const result = await repo.countAvailableQuestionsByKp(9, 1);

    expect(result.get(11)).toBe(7);
    expect(result.get(12)).toBe(0);
    // DECIMAL/COUNT 可能以字符串回来，必须 Number() 归一
    expect(result.get(13)).toBe(3);
    expect(result.get(999)).toBeUndefined();
  });

  it('SQL 谓词与 findRandomByKpAndType 同源（is_active / 空答案 / 不再展示排除）', async () => {
    const pool = mockPool([]);
    const repo = new KnowledgePointsRepository(pool as any);

    await repo.countAvailableQuestionsByKp(9, 1);

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('JOIN question_knowledge_points qkp ON qkp.question_id = q.id');
    expect(sql).toContain('LEFT JOIN student_hidden_questions shq');
    expect(sql).toContain('q.subject_id = ?');
    expect(sql).toContain('q.is_active = 1');
    expect(sql).toContain("q.answer <> ''");
    expect(sql).toContain('shq.id IS NULL');
    expect(sql).toContain('GROUP BY qkp.knowledge_point_id');
    // 参数顺序：LEFT JOIN 的 studentId 在前，WHERE 的 subjectId 在后
    expect(params).toEqual([9, 1]);
  });
});
```

`apps/server/src/database/repositories/student-knowledge-mastery.repo.test.ts` —— **该文件已存在（88 行）**，不要覆盖。⚠️ **它的 `mockPool` 是无参的**（`const mockPool = () => ({ execute: vi.fn().mockResolvedValue([[], []]) })`），**不能喂行数据**，也**不要改它**（会动到既有 4 个用例）。在追加块里另起一个可传行的工厂。把下面内容**追加到文件末尾**（顶部已有 `describe/it/expect/vi` 与 `StudentKnowledgeMasteryRepository` 的 import，无需新增）：

```ts
/**
 * 追加块专用：既有 `mockPool()` 不接受行数据（它只回空结果），
 * 这里另起一个可传行的工厂，**不改动既有用例**。
 */
const mockPoolWithRows = (rows: any[]) => ({
  execute: vi.fn().mockResolvedValue([rows, []]),
  query: vi.fn().mockResolvedValue([rows, []]),
});

describe('StudentKnowledgeMasteryRepository.listBySubject', () => {
  it('按学科取该生全部掌握度行，数值字段 Number 归一、lastSeenAt 保留 Date', async () => {
    const seen = new Date('2026-09-20T10:00:00Z');
    const pool = mockPoolWithRows([
      {
        knowledge_point_id: 11, mastery_score: '0.4000', level: '2',
        correct_count: '4', error_count: '6', last_seen_at: seen,
      },
    ]);
    const repo = new StudentKnowledgeMasteryRepository(pool as any);

    const rows = await repo.listBySubject(9, 1);

    expect(rows).toEqual([
      { knowledgePointId: 11, masteryScore: 0.4, level: 2, correctCount: 4, errorCount: 6, lastSeenAt: seen },
    ]);
  });

  it('SQL 按 student_id + 学科过滤，不设 LIMIT（服务层要全量）', async () => {
    const pool = mockPoolWithRows([]);
    const repo = new StudentKnowledgeMasteryRepository(pool as any);

    await repo.listBySubject(9, 1);

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('FROM student_knowledge_mastery skm');
    expect(sql).toContain('JOIN knowledge_points kp ON kp.id = skm.knowledge_point_id');
    expect(sql).toContain('skm.student_id = ?');
    expect(sql).toContain('kp.subject_id = ?');
    expect(sql).not.toContain('LIMIT');
    expect(params).toEqual([9, 1]);
  });
});

describe('StudentKnowledgeMasteryRepository.countQuestionCoverageBySubject', () => {
  it('覆盖数与总数都按学科 + is_active 统计', async () => {
    const pool = mockPoolWithRows([{ total: '457', covered: '205' }]);
    const repo = new StudentKnowledgeMasteryRepository(pool as any);

    const result = await repo.countQuestionCoverageBySubject(1);

    expect(result).toEqual({ coveredQuestions: 205, totalQuestions: 457 });
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('FROM questions');
    expect(sql).toContain('is_active = 1');
    expect(sql).toContain('COUNT(DISTINCT q.id)');
    expect(params).toEqual([1, 1]);
  });
});
```

创建 `apps/server/src/database/repositories/main-error-books.repo.test.ts` —— **该文件已存在**，不要覆盖。把下面这个 `describe` **追加到文件末尾**（它复用文件顶部已有的 `mockPool` 与 `MainErrorBooksRepository` import；另需**新增一行 import**：`import { UNCOVERED_ERROR_PREDICATE } from '../sql-fragments';`）：

```ts
describe('MainErrorBooksRepository.countUncoveredUncleared', () => {
  it('返回未清零且映射不到任何知识点的错题数（数学口径）', async () => {
    const pool = mockPool([{ uncovered: '8' }]);
    const repo = new MainErrorBooksRepository(pool as any);

    expect(await repo.countUncoveredUncleared(9, 1)).toBe(8);
  });

  it('SQL 谓词：subject_id + is_cleared = 0 + NOT EXISTS(qkp)', async () => {
    const pool = mockPool([{ uncovered: 0 }]);
    const repo = new MainErrorBooksRepository(pool as any);

    await repo.countUncoveredUncleared(9, 1);

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('FROM main_error_books meb');
    expect(sql).toContain('meb.student_id = ?');
    expect(sql).toContain('meb.subject_id = ?');
    expect(sql).toContain('meb.is_cleared = 0');
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('qkp.question_id = meb.question_id');
    // 共享片段必须**真的被插值进来**：只钉子串的话，将来有人把 `NOT EXISTS` 重新内联回
    // 查询里，两边测试仍全绿、共享就白抽了（漂移静默复活）。这一行把「共用同一常量」钉死。
    expect(sql).toContain(UNCOVERED_ERROR_PREDICATE);
    expect(params).toEqual([9, 1]);
  });

  it('无数据 → 0（不是 null）', async () => {
    const pool = mockPool([{ uncovered: null }]);
    const repo = new MainErrorBooksRepository(pool as any);

    expect(await repo.countUncoveredUncleared(9, 1)).toBe(0);
  });
});
```

创建 `apps/server/src/database/sql-fragments.test.ts`（**新文件**）：

```ts
import { describe, it, expect } from 'vitest';
import { UNCOVERED_ERROR_PREDICATE } from './sql-fragments';

/**
 * 共享片段是**两处查询的唯一真源**（`MainErrorBooksRepository.countUncoveredUncleared`
 * 与 `ParentInsightsRepository.countUncoveredUnclearedErrors` 都拼它）。
 * 这个用例把片段文本钉死：片段被改宽/改窄（比如漏掉 `qkp.question_id = meb.question_id`
 * 变成恒真子查询）时，两处会**同时**静默错掉，只有这里能拦住。
 */
describe('sql-fragments.UNCOVERED_ERROR_PREDICATE', () => {
  it('谓词文本与两处仓储的期望逐字一致', () => {
    expect(UNCOVERED_ERROR_PREDICATE).toBe(
      'NOT EXISTS (SELECT 1 FROM question_knowledge_points qkp WHERE qkp.question_id = meb.question_id)',
    );
  });

  it('不含外层过滤条件（student_id / is_cleared / subject_id 归各自查询管）', () => {
    expect(UNCOVERED_ERROR_PREDICATE).not.toContain('student_id');
    expect(UNCOVERED_ERROR_PREDICATE).not.toContain('is_cleared');
    expect(UNCOVERED_ERROR_PREDICATE).not.toContain('subject_id');
  });

  it('别名固定为 meb（两处查询都用 meb 指 main_error_books，换别名必须同步改片段）', () => {
    expect(UNCOVERED_ERROR_PREDICATE).toContain('meb.question_id');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/database/repositories/knowledge-points.repo.test.ts src/database/repositories/student-knowledge-mastery.repo.test.ts src/database/repositories/main-error-books.repo.test.ts src/database/sql-fragments.test.ts`
Expected: FAIL —— `repo.countAvailableQuestionsByKp is not a function`（三个新方法都不存在）与 `Cannot find module './sql-fragments'`

- [ ] **Step 3: 实现 `KnowledgePointsRepository.countAvailableQuestionsByKp`**

在 `apps/server/src/database/repositories/knowledge-points.repo.ts` 的 `findById` 之后追加（类内）：

```ts
  /**
   * 该生在某学科下、每个知识点**可抽题数**（一次分组查询，别 79 次单查）。
   *
   * 谓词与 `QuestionsRepository.findRandomByKpAndType` **逐字同源**：
   * `is_active = 1` + `answer <> ''` + 排除该生 `student_hidden_questions`。
   * 不同步就会出现「推荐说有题、开练抽不到」的落差。
   *
   * 返回 `Map<kpId, 数量>`；没有可抽题的 KP **不出现**在 Map 里（调用方 `?? 0`）。
   */
  async countAvailableQuestionsByKp(
    studentId: number,
    subjectId: number,
  ): Promise<Map<number, number>> {
    const [rows] = await this.pool.execute<
      (RowDataPacket & { kp_id: number; n: number | string | null })[]
    >(
      `SELECT qkp.knowledge_point_id AS kp_id, COUNT(DISTINCT q.id) AS n
       FROM questions q
       JOIN question_knowledge_points qkp ON qkp.question_id = q.id
       LEFT JOIN student_hidden_questions shq
         ON shq.question_id = q.id AND shq.student_id = ?
       WHERE q.subject_id = ? AND q.is_active = 1
         AND q.answer <> ''
         AND shq.id IS NULL
       GROUP BY qkp.knowledge_point_id`,
      [studentId, subjectId],
    );
    return new Map(rows.map((r) => [Number(r.kp_id), Number(r.n ?? 0)]));
  }
```

- [ ] **Step 4: 实现两个 `StudentKnowledgeMasteryRepository` 方法**

在 `apps/server/src/database/repositories/student-knowledge-mastery.repo.ts` 的 `countQuestionCoverage()` 之后追加（类内）：

```ts
  /**
   * 该生在某学科下的**全部**掌握度行（图谱 overlay 用）。
   *
   * 与 `listWeakest` 的区别：那个只给最弱 N 个、且不按学科过滤，图谱要全量 + 按学科。
   * **不设 LIMIT**：79 个 KP 规模下无需分页。
   */
  async listBySubject(
    studentId: number,
    subjectId: number,
  ): Promise<
    Array<{
      knowledgePointId: number;
      masteryScore: number;
      level: number;
      correctCount: number;
      errorCount: number;
      lastSeenAt: Date | null;
    }>
  > {
    const [rows] = await this.pool.execute<
      (RowDataPacket & {
        knowledge_point_id: number; mastery_score: number | string | null; level: number | string | null;
        correct_count: number | string | null; error_count: number | string | null;
        last_seen_at: Date | null;
      })[]
    >(
      `SELECT skm.knowledge_point_id, skm.mastery_score, skm.level,
              skm.correct_count, skm.error_count, skm.last_seen_at
       FROM student_knowledge_mastery skm
       JOIN knowledge_points kp ON kp.id = skm.knowledge_point_id
       WHERE skm.student_id = ? AND kp.subject_id = ?
       ORDER BY skm.knowledge_point_id`,
      [studentId, subjectId],
    );
    return rows.map((r) => ({
      knowledgePointId: Number(r.knowledge_point_id),
      masteryScore: Number(r.mastery_score ?? 0),
      level: Number(r.level ?? 0),
      correctCount: Number(r.correct_count ?? 0),
      errorCount: Number(r.error_count ?? 0),
      lastSeenAt: r.last_seen_at,
    }));
  }

  /**
   * 题库 KP 覆盖率的**学科口径**（图谱页页脚必须展示，否则学生会以为「只有这些问题」）。
   *
   * 与 `countQuestionCoverage()`（全库口径、家长端用）并存不替换：那个不带 subject 过滤，
   * 本页只讲数学，混进语文/英语的数会让页脚数字对不上图谱。
   */
  async countQuestionCoverageBySubject(
    subjectId: number,
  ): Promise<{ coveredQuestions: number; totalQuestions: number }> {
    const [rows] = await this.pool.execute<
      (RowDataPacket & { total: number | string | null; covered: number | string | null })[]
    >(
      `SELECT (SELECT COUNT(*) FROM questions WHERE subject_id = ? AND is_active = 1) AS total,
              (SELECT COUNT(DISTINCT q.id) FROM questions q
                 JOIN question_knowledge_points qkp ON qkp.question_id = q.id
                WHERE q.subject_id = ? AND q.is_active = 1) AS covered`,
      [subjectId, subjectId],
    );
    return {
      coveredQuestions: Number(rows[0]?.covered ?? 0),
      totalQuestions: Number(rows[0]?.total ?? 0),
    };
  }
```

- [ ] **Step 5: 新建共享片段 `sql-fragments.ts`**

创建 `apps/server/src/database/sql-fragments.ts`：

```ts
/**
 * 跨仓储共享的 SQL 片段常量。
 *
 * **为什么要有这个文件**：`MainErrorBooksRepository.countUncoveredUncleared`（学生端图谱页）
 * 与 `ParentInsightsRepository.countUncoveredUnclearedErrors`（家长端报告）的
 * `NOT EXISTS (...)` 子句**逐字相同**，只有外层过滤条件不同。原先两边各写一份，
 * 残留风险是改一处忘另一处会**静默漂移**，而两边的测试各自只钉住自己那份。
 * 抽成常量后，两边拼的是同一段文本，漂移在结构上不可能发生。
 *
 * **只共享字符串**：这里不 import 任何仓储 / service，所以不造成模块耦合
 * （与「不要把 `ParentInsightsRepository` 跨模块复用」并不冲突 —— 那说的是不要共享**实例**）。
 *
 * ⚠️ 片段里的 `meb` 是 `main_error_books` 的别名，两处查询都这么写
 * （`parent-insights.repo.ts:484`、`main-error-books.repo.ts:168`）。
 * 谁换别名，谁必须同步改这里。
 */

/**
 * 「这条错题映射不到任何知识点」的判定子句。
 *
 * 语义：`main_error_books` 的某行（别名 `meb`）在 `question_knowledge_points` 里
 * 找不到任何关联行 —— 即该题的 KP 标注缺失，进不了知识点图谱。
 *
 * **不含** `student_id` / `is_cleared` / `subject_id`：那些是外层查询的过滤条件，
 * 两处口径不同（家长端跨学科、学生端仅数学），故意留在各自查询里。
 */
export const UNCOVERED_ERROR_PREDICATE =
  'NOT EXISTS (SELECT 1 FROM question_knowledge_points qkp WHERE qkp.question_id = meb.question_id)';
```

- [ ] **Step 6: 实现 `MainErrorBooksRepository.countUncoveredUncleared`**

在 `apps/server/src/database/repositories/main-error-books.repo.ts` 的 `countClearedBetween` 之后追加（类内）：

```ts
  /**
   * 未清零错题里**映射不到任何知识点**的条数（数学口径，图谱页页脚用）。
   *
   * 与家长端 `ParentInsightsRepository.countUncoveredUnclearedErrors` 共用
   * `UNCOVERED_ERROR_PREDICATE`（见 `sql-fragments.ts`），只有外层过滤不同：
   * 家长端跨学科汇总，本页只讲数学，故这里按 `subject_id` 收窄。
   */
  async countUncoveredUncleared(studentId: number, subjectId: number): Promise<number> {
    const [rows] = await this.pool.execute<(RowDataPacket & { uncovered: number | string | null })[]>(
      `SELECT COUNT(*) AS uncovered
       FROM main_error_books meb
       WHERE meb.student_id = ? AND meb.subject_id = ? AND meb.is_cleared = 0
         AND ${UNCOVERED_ERROR_PREDICATE}`,
      [studentId, subjectId],
    );
    return Number(rows[0]?.uncovered ?? 0);
  }
```

同时在文件顶部 import 区加：

```ts
import { UNCOVERED_ERROR_PREDICATE } from '../sql-fragments.js';
```

- [ ] **Step 7: 让家长端也用同一片段**

改 `apps/server/src/database/repositories/parent-insights.repo.ts` 的 `countUncoveredUnclearedErrors`（约 481-492 行）——**只动这一处**，把内联的 `NOT EXISTS (...)` 换成常量：

```ts
  /**
   * 未清零错题里**映射不到任何知识点**的条数（`question_id` 为 NULL，或该题未绑 KP）。
   *
   * 与 `getWeakPoints` 是同一口径的补集，UI 必须显式展示这个数（spec §9.1）。
   *
   * 谓词子句与 `MainErrorBooksRepository.countUncoveredUncleared` **共用**
   * `UNCOVERED_ERROR_PREDICATE`（见 `sql-fragments.ts`）；本查询**不带学科**
   * （家长端跨学科汇总），学生端图谱那份按 `subject_id` 收窄。
   */
  async countUncoveredUnclearedErrors(studentId: number): Promise<number> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS uncovered
       FROM main_error_books meb
       WHERE meb.student_id = ? AND meb.is_cleared = 0
         AND ${UNCOVERED_ERROR_PREDICATE}`,
      [studentId],
    );
    return Number(rows[0]?.uncovered ?? 0);
  }
```

并在 `parent-insights.repo.ts` 顶部 import 区加：

```ts
import { UNCOVERED_ERROR_PREDICATE } from '../sql-fragments.js';
```

**⚠️ 不要改这个方法的签名、不要改它的 `subject_id` 缺失（那是家长端跨学科口径）、不要动该文件里的任何其它方法。** 既有的 `parent-insights.repo.test.ts` 有用例钉着这个方法（`toContain('NOT EXISTS')`、`toContain('is_cleared = 0')`），改完必须仍然通过。

- [ ] **Step 7b: 给家长端那条 SQL 钉子也加上「共用常量」断言**

改 `apps/server/src/database/repositories/parent-insights.repo.test.ts` 的「未标注知识点的未清零错题单独计数」用例（约 246-254 行）——在现有两条 `toContain` 之后**加一行**，并在该文件顶部 import 区加 `import { UNCOVERED_ERROR_PREDICATE } from '../sql-fragments';`：

```ts
    // 与 MainErrorBooksRepository.countUncoveredUncleared 共用同一片段——这一行把「共用」本身钉死，
    // 否则将来把 NOT EXISTS 重新内联回查询，两边测试仍绿、漂移静默复活。
    expect(sql).toContain(UNCOVERED_ERROR_PREDICATE);
```

**为什么两处都要加**：`UNCOVERED_ERROR_PREDICATE` 的唯一价值就是「两处共用」，而 mockPool 不看 SQL 文本 —— 只钉子串的话，重新内联不会被任何测试发现。

- [ ] **Step 8: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/database/repositories/knowledge-points.repo.test.ts src/database/repositories/student-knowledge-mastery.repo.test.ts src/database/repositories/main-error-books.repo.test.ts src/database/sql-fragments.test.ts src/database/repositories/parent-insights.repo.test.ts src/modules/parent-insights/report.service.test.ts`
Expected: PASS（6 文件全绿；后两个是既有家长端用例，验证这次重构没打破它们）

- [ ] **Step 9: 提交**

```bash
git add apps/server/src/database/sql-fragments.ts \
        apps/server/src/database/sql-fragments.test.ts \
        apps/server/src/database/repositories/knowledge-points.repo.ts \
        apps/server/src/database/repositories/student-knowledge-mastery.repo.ts \
        apps/server/src/database/repositories/main-error-books.repo.ts \
        apps/server/src/database/repositories/parent-insights.repo.ts \
        apps/server/src/database/repositories/knowledge-points.repo.test.ts \
        apps/server/src/database/repositories/student-knowledge-mastery.repo.test.ts \
        apps/server/src/database/repositories/main-error-books.repo.test.ts \
        apps/server/src/database/repositories/parent-insights.repo.test.ts
git commit -m "feat(server): 图谱读侧仓储——可抽题数/按学科掌握度/学科覆盖率/未标注错题数（未标注谓词抽共享片段）"
```

---

## Task 2: DTO 与 `KnowledgeGraphService.getMastery`

**Files:**
- Create: `apps/server/src/modules/knowledge-graph/dto/knowledge-graph.dto.ts`
- Create: `apps/server/src/modules/knowledge-graph/knowledge-graph.service.ts`
- Test: `apps/server/src/modules/knowledge-graph/knowledge-graph.service.test.ts`

**Interfaces:**
- Consumes: Task 1 的四个仓储方法
- Produces:
  - `export const MIN_SAMPLE_SIZE = 5;`
  - `export const WEAK_LEVEL_MAX = 2;`
  - `export type MasteryConfidence = 'none' | 'insufficient' | 'ok';`
  - `export interface KnowledgeGraphNode { id: number; name: string; parentId: number | null; masteryScore: number | null; level: number | null; correctCount: number | null; errorCount: number | null; lastSeenAt: string | null; sampleSize: number; confidence: MasteryConfidence; availableQuestionCount: number; }`
  - `export interface KnowledgeGraphMastery { subjectId: number; nodes: KnowledgeGraphNode[]; coverage: { coveredQuestions: number; totalQuestions: number; uncoveredUnclearedErrors: number }; }`
  - `KnowledgeGraphService.getMastery(studentId: number, subjectId: number): Promise<KnowledgeGraphMastery>`

- [ ] **Step 1: 写失败的 service 测试**

创建 `apps/server/src/modules/knowledge-graph/knowledge-graph.service.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { KnowledgeGraphService, MIN_SAMPLE_SIZE } from './knowledge-graph.service.js';

/**
 * 造一个只关心「树 × 掌握度 overlay」组装逻辑的 service：
 * 三个仓储全 mock，断言 confidence 三态、null ≠ 0、覆盖口径。
 */
function mk(overrides: Record<string, any> = {}) {
  const kpRepo = {
    findBySubject: vi.fn().mockResolvedValue([
      { id: 1, name: '数与式', parentKpId: null, gradeBand: 'junior' },
      { id: 11, name: '有理数', parentKpId: 1, gradeBand: 'junior' },
      { id: 12, name: '整式', parentKpId: 1, gradeBand: 'junior' },
    ]),
    countAvailableQuestionsByKp: vi.fn().mockResolvedValue(new Map([[11, 7], [12, 0]])),
    ...overrides.kpRepo,
  };
  const masteryRepo = {
    listBySubject: vi.fn().mockResolvedValue([]),
    countQuestionCoverageBySubject: vi.fn().mockResolvedValue({ coveredQuestions: 205, totalQuestions: 457 }),
    ...overrides.masteryRepo,
  };
  const errorsRepo = {
    countUncoveredUncleared: vi.fn().mockResolvedValue(4),
    ...overrides.errorsRepo,
  };
  const svc = new KnowledgeGraphService(kpRepo as any, masteryRepo as any, errorsRepo as any);
  return { svc, kpRepo, masteryRepo, errorsRepo };
}

const seen = new Date('2026-09-20T10:00:00.000Z');

describe('KnowledgeGraphService.getMastery', () => {
  it('未作答的 KP：masteryScore/level/计数全为 null（不是 0），confidence = none', async () => {
    const { svc } = mk();

    const result = await svc.getMastery(9, 1);

    const node11 = result.nodes.find((n) => n.id === 11)!;
    expect(node11.masteryScore).toBeNull();
    expect(node11.level).toBeNull();
    expect(node11.correctCount).toBeNull();
    expect(node11.errorCount).toBeNull();
    expect(node11.lastSeenAt).toBeNull();
    expect(node11.sampleSize).toBe(0);
    expect(node11.confidence).toBe('none');
  });

  it('样本 < 5 → insufficient（即使有行有分数）', async () => {
    const { svc } = mk({
      masteryRepo: {
        listBySubject: vi.fn().mockResolvedValue([
          { knowledgePointId: 11, masteryScore: 0, level: 0, correctCount: 0, errorCount: 1, lastSeenAt: seen },
        ]),
      },
    });

    const node11 = (await svc.getMastery(9, 1)).nodes.find((n) => n.id === 11)!;

    expect(node11.sampleSize).toBe(1);
    expect(node11.confidence).toBe('insufficient');
    // 分数照给（详情栏要显示「对 0 错 1」），只是不下强弱结论
    expect(node11.masteryScore).toBe(0);
  });

  it('样本正好 = 5 → ok（含边界）', async () => {
    const { svc } = mk({
      masteryRepo: {
        listBySubject: vi.fn().mockResolvedValue([
          { knowledgePointId: 11, masteryScore: 0.6, level: 3, correctCount: 3, errorCount: 2, lastSeenAt: seen },
        ]),
      },
    });

    const node11 = (await svc.getMastery(9, 1)).nodes.find((n) => n.id === 11)!;

    expect(node11.sampleSize).toBe(MIN_SAMPLE_SIZE);
    expect(node11.confidence).toBe('ok');
  });

  it('样本 = 4 → insufficient（不含边界）', async () => {
    const { svc } = mk({
      masteryRepo: {
        listBySubject: vi.fn().mockResolvedValue([
          { knowledgePointId: 11, masteryScore: 0.5, level: 2, correctCount: 2, errorCount: 2, lastSeenAt: seen },
        ]),
      },
    });

    expect((await svc.getMastery(9, 1)).nodes.find((n) => n.id === 11)!.confidence).toBe('insufficient');
  });

  it('lastSeenAt 序列化为 ISO 字符串；availableQuestionCount 缺省补 0', async () => {
    const { svc } = mk({
      masteryRepo: {
        listBySubject: vi.fn().mockResolvedValue([
          { knowledgePointId: 11, masteryScore: 0.6, level: 3, correctCount: 3, errorCount: 2, lastSeenAt: seen },
        ]),
      },
    });

    const nodes = (await svc.getMastery(9, 1)).nodes;

    expect(nodes.find((n) => n.id === 11)!.lastSeenAt).toBe('2026-09-20T10:00:00.000Z');
    expect(nodes.find((n) => n.id === 12)!.availableQuestionCount).toBe(0);
    expect(nodes.find((n) => n.id === 11)!.availableQuestionCount).toBe(7);
  });

  it('一级节点 parentId 为 null，二级指向一级；nodes 覆盖全树', async () => {
    const { svc } = mk();

    const nodes = (await svc.getMastery(9, 1)).nodes;

    expect(nodes).toHaveLength(3);
    expect(nodes.find((n) => n.id === 1)!.parentId).toBeNull();
    expect(nodes.find((n) => n.id === 11)!.parentId).toBe(1);
  });

  it('coverage 三字段都来自各自查询（学科口径）', async () => {
    const { svc, errorsRepo, masteryRepo } = mk();

    const result = await svc.getMastery(9, 1);

    expect(result.subjectId).toBe(1);
    expect(result.coverage).toEqual({
      coveredQuestions: 205,
      totalQuestions: 457,
      uncoveredUnclearedErrors: 4,
    });
    expect(masteryRepo.countQuestionCoverageBySubject).toHaveBeenCalledWith(1);
    expect(errorsRepo.countUncoveredUncleared).toHaveBeenCalledWith(9, 1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/knowledge-graph/knowledge-graph.service.test.ts`
Expected: FAIL —— `Cannot find module './knowledge-graph.service.js'`

- [ ] **Step 3: 写 DTO**

创建 `apps/server/src/modules/knowledge-graph/dto/knowledge-graph.dto.ts`：

```ts
/**
 * 数学薄弱点图谱的 wire 类型（API 文档 §4.5 / spec `2026-09-23-math-weakpoint-graph-design.md`）。
 *
 * 这些类型同时是**前后端契约的唯一真源**：`apps/web/src/services/api.ts` 里有镜像定义，
 * 改这里必须同步改那里（两处都是手写的，没有代码生成）。
 */

/**
 * 判定「强弱」所需的最小样本量（`correct_count + error_count`）。
 *
 * ⚠️ **唯一真源**：`confidence` 由后端算好下发，前端**不得重算**这个阈值
 * （重算就会出现两处漂移）。`5` 是拍出来的值，后续应按数据分布校准（spec §8 第 4 条）。
 */
export const MIN_SAMPLE_SIZE = 5;

/**
 * 「待补」的展示阈值：`level <= 2`（即掌握度 < 60%）记为待补。
 *
 * **纯展示口径**，只用于一级行的「N 个待补」汇总，**不参与推荐算法**
 * （推荐只看 `mastery_score` 排序 + 三道闸门）。spec 未定义此阈值，本计划定稿为 2。
 */
export const WEAK_LEVEL_MAX = 2;

/** 掌握度的可信度三态：`none` = 从未作答 / `insufficient` = 样本 < 5 / `ok` = 可下结论。 */
export type MasteryConfidence = 'none' | 'insufficient' | 'ok';

/** 图谱节点（一级 + 二级平铺，树形组装放前端）。 */
export interface KnowledgeGraphNode {
  id: number;
  name: string;
  /** null = 一级知识点 */
  parentId: number | null;
  /** null = 从未作答（**不是 0**——0 是「很弱」，语义相反） */
  masteryScore: number | null;
  level: number | null;
  correctCount: number | null;
  errorCount: number | null;
  /** ISO 字符串；未作答为 null */
  lastSeenAt: string | null;
  /** correct + error；未作答 = 0 */
  sampleSize: number;
  confidence: MasteryConfidence;
  /** 该 KP 对**该生**可抽的题数（已排除「不再展示」） */
  availableQuestionCount: number;
}

/** `GET /api/knowledge-graph/students/{studentId}/mastery` 的 data。 */
export interface KnowledgeGraphMastery {
  subjectId: number;
  nodes: KnowledgeGraphNode[];
  coverage: {
    /** 该学科 active 题里带 KP 标注的 */
    coveredQuestions: number;
    /** 该学科 active 题总数 */
    totalQuestions: number;
    /** 该生未标注知识点的未清零错题数（页脚用） */
    uncoveredUnclearedErrors: number;
  };
}
```

- [ ] **Step 4: 写 service 的 `getMastery`**

创建 `apps/server/src/modules/knowledge-graph/knowledge-graph.service.ts`：

```ts
import { Injectable } from '@nestjs/common';
import { KnowledgePointsRepository } from '../../database/repositories/knowledge-points.repo.js';
import { StudentKnowledgeMasteryRepository } from '../../database/repositories/student-knowledge-mastery.repo.js';
import { MainErrorBooksRepository } from '../../database/repositories/main-error-books.repo.js';
import {
  MIN_SAMPLE_SIZE,
  type KnowledgeGraphMastery,
  type KnowledgeGraphNode,
  type MasteryConfidence,
} from './dto/knowledge-graph.dto.js';

/**
 * 转出阈值常量，供**本模块的测试**引用。
 *
 * 定义仍然只有一处（DTO 的 `MIN_SAMPLE_SIZE`），这里只是把「服务判定样本够不够」
 * 这件事的阈值暴露在服务自己的 API 面上 —— 测试因此可以从被测对象侧取值，
 * 而不必跨层去 import DTO。（Task 3 的 `getWeakPoints` 也用它。）
 */
export { MIN_SAMPLE_SIZE };

/**
 * 数学薄弱点图谱（只读）：把知识点全树与该生掌握度 overlay 组装成可直渲的形状。
 *
 * **本服务零写入**：掌握度由判题出口（`MasteryService.recordFromJudge`）回写，
 * 这里只读。发分也不在这里（开练走 `POST /api/training/targeted/start`，由训练模块负责）。
 */
@Injectable()
export class KnowledgeGraphService {
  constructor(
    private readonly kpRepo: KnowledgePointsRepository,
    private readonly masteryRepo: StudentKnowledgeMasteryRepository,
    private readonly errorsRepo: MainErrorBooksRepository,
  ) {}

  /**
   * 全树 + 掌握度 overlay（spec §5.2）。
   *
   * **以全树为基准左连掌握度行**：未作答的 KP 在 `student_knowledge_mastery` 里**没有行**
   * （不是 0）——缺失一律给 `null` + `confidence: 'none'`，前端渲染为「未开始」灰显。
   * 把缺失当 0 会让「没做过」被读成「很弱」，语义相反（spec §4.3 第 2 条）。
   */
  async getMastery(studentId: number, subjectId: number): Promise<KnowledgeGraphMastery> {
    const [kps, masteryRows, availableMap, coverage, uncoveredUnclearedErrors] = await Promise.all([
      this.kpRepo.findBySubject(subjectId),
      this.masteryRepo.listBySubject(studentId, subjectId),
      this.kpRepo.countAvailableQuestionsByKp(studentId, subjectId),
      this.masteryRepo.countQuestionCoverageBySubject(subjectId),
      this.errorsRepo.countUncoveredUncleared(studentId, subjectId),
    ]);

    const masteryByKp = new Map(masteryRows.map((r) => [r.knowledgePointId, r]));

    const nodes: KnowledgeGraphNode[] = kps.map((kp) => {
      const row = masteryByKp.get(kp.id);
      if (!row) {
        return {
          id: kp.id,
          name: kp.name,
          parentId: kp.parentKpId,
          masteryScore: null,
          level: null,
          correctCount: null,
          errorCount: null,
          lastSeenAt: null,
          sampleSize: 0,
          confidence: 'none' as MasteryConfidence,
          availableQuestionCount: availableMap.get(kp.id) ?? 0,
        };
      }
      const sampleSize = row.correctCount + row.errorCount;
      return {
        id: kp.id,
        name: kp.name,
        parentId: kp.parentKpId,
        masteryScore: row.masteryScore,
        level: row.level,
        correctCount: row.correctCount,
        errorCount: row.errorCount,
        lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
        sampleSize,
        confidence: this.confidenceFor(sampleSize),
        availableQuestionCount: availableMap.get(kp.id) ?? 0,
      };
    });

    return {
      subjectId,
      nodes,
      coverage: {
        coveredQuestions: coverage.coveredQuestions,
        totalQuestions: coverage.totalQuestions,
        uncoveredUnclearedErrors,
      },
    };
  }

  /**
   * 样本量 → 可信度三态。**唯一实现**：前端拿后端算好的值，不重算阈值。
   *
   * `0` 与 `1..4` 要分开：前者是「从未作答」（灰显「未开始」），后者是
   * 「做过但样本不足」（灰显 + 虚线边 + 注明「暂不判定强弱」）。
   */
  private confidenceFor(sampleSize: number): MasteryConfidence {
    if (sampleSize <= 0) return 'none';
    if (sampleSize < MIN_SAMPLE_SIZE) return 'insufficient';
    return 'ok';
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/knowledge-graph/knowledge-graph.service.test.ts`
Expected: PASS（7 用例全绿）

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/modules/knowledge-graph/dto/knowledge-graph.dto.ts \
        apps/server/src/modules/knowledge-graph/knowledge-graph.service.ts \
        apps/server/src/modules/knowledge-graph/knowledge-graph.service.test.ts
git commit -m "feat(server): 图谱 service 组装全树 overlay（null≠0、confidence 三态）"
```

---

## Task 3: `KnowledgeGraphService.getWeakPoints`（推荐算法）

**Files:**
- Modify: `apps/server/src/modules/knowledge-graph/dto/knowledge-graph.dto.ts`
- Modify: `apps/server/src/modules/knowledge-graph/knowledge-graph.service.ts`
- Test: `apps/server/src/modules/knowledge-graph/knowledge-graph.service.test.ts`（追加）

**Interfaces:**
- Consumes: Task 2 的 `MIN_SAMPLE_SIZE`、`KnowledgeGraphService`
- Produces:
  - `export interface WeakPointCandidate { knowledgePointId: number; name: string; parentId: number | null; masteryScore: number; level: number; correctCount: number; errorCount: number; sampleSize: number; availableQuestionCount: number; lastSeenAt: string | null; }`
  - `export interface WeakPointRecommendation { subjectId: number; candidates: WeakPointCandidate[]; recommendation: WeakPointCandidate | null; reason: 'ok' | 'no_qualified_candidate'; }`
  - `KnowledgeGraphService.getWeakPoints(studentId: number, subjectId: number, limit: number): Promise<WeakPointRecommendation>`

- [ ] **Step 1: 写失败的测试（追加到 `knowledge-graph.service.test.ts` 末尾）**

```ts
describe('KnowledgeGraphService.getWeakPoints', () => {
  /** 三个够格候选 + 一个样本不足 + 一个无题可抽，用于验闸门与排序。 */
  const rows = [
    { knowledgePointId: 11, masteryScore: 0.5, level: 2, correctCount: 5, errorCount: 5, lastSeenAt: seen },
    { knowledgePointId: 12, masteryScore: 0.5, level: 2, correctCount: 3, errorCount: 3, lastSeenAt: seen },
    { knowledgePointId: 13, masteryScore: 0.2, level: 1, correctCount: 1, errorCount: 4, lastSeenAt: seen },
    { knowledgePointId: 14, masteryScore: 0, level: 0, correctCount: 0, errorCount: 2, lastSeenAt: seen },
  ];
  const available = new Map([[11, 7], [12, 3], [13, 0]]);

  it('三道闸门：样本不足（14）与无题可抽（13）都被排除', async () => {
    const { svc } = mk({
      kpRepo: {
        findBySubject: vi.fn().mockResolvedValue([
          { id: 1, name: '数与式', parentKpId: null, gradeBand: 'junior' },
          { id: 11, name: '有理数', parentKpId: 1, gradeBand: 'junior' },
          { id: 12, name: '整式', parentKpId: 1, gradeBand: 'junior' },
          { id: 13, name: '分式', parentKpId: 1, gradeBand: 'junior' },
          { id: 14, name: '根式', parentKpId: 1, gradeBand: 'junior' },
        ]),
        countAvailableQuestionsByKp: vi.fn().mockResolvedValue(available),
      },
      masteryRepo: { listBySubject: vi.fn().mockResolvedValue(rows) },
    });

    const result = await svc.getWeakPoints(9, 1, 10);

    expect(result.candidates.map((c) => c.knowledgePointId)).toEqual([11, 12]);
    expect(result.reason).toBe('ok');
  });

  it('排序：mastery_score 升序 → error_count 降序 → kp_id 升序', async () => {
    const { svc } = mk({
      kpRepo: {
        findBySubject: vi.fn().mockResolvedValue([
          { id: 1, name: '数与式', parentKpId: null, gradeBand: 'junior' },
          { id: 11, name: '有理数', parentKpId: 1, gradeBand: 'junior' },
          { id: 12, name: '整式', parentKpId: 1, gradeBand: 'junior' },
          { id: 21, name: '方程', parentKpId: 1, gradeBand: 'junior' },
        ]),
        countAvailableQuestionsByKp: vi.fn().mockResolvedValue(new Map([[11, 5], [12, 5], [21, 5]])),
      },
      masteryRepo: {
        listBySubject: vi.fn().mockResolvedValue([
          // 同分（0.5），error_count 大者在前
          { knowledgePointId: 11, masteryScore: 0.5, level: 2, correctCount: 5, errorCount: 5, lastSeenAt: seen },
          // ⚠️ 样本量必须 ≥ MIN_SAMPLE_SIZE（3+3=6），否则会被闸门 2 排除、这个用例就测不到排序了
          { knowledgePointId: 21, masteryScore: 0.5, level: 2, correctCount: 3, errorCount: 3, lastSeenAt: seen },
          // 分最低，排第一
          { knowledgePointId: 12, masteryScore: 0.2, level: 1, correctCount: 1, errorCount: 4, lastSeenAt: seen },
        ]),
      },
    });

    const result = await svc.getWeakPoints(9, 1, 10);

    expect(result.candidates.map((c) => c.knowledgePointId)).toEqual([12, 11, 21]);
  });

  it('同分同错数时按 kp_id 升序（结果不抖动）', async () => {
    const { svc } = mk({
      kpRepo: {
        findBySubject: vi.fn().mockResolvedValue([
          { id: 1, name: '数与式', parentKpId: null, gradeBand: 'junior' },
          { id: 31, name: 'A', parentKpId: 1, gradeBand: 'junior' },
          { id: 22, name: 'B', parentKpId: 1, gradeBand: 'junior' },
        ]),
        countAvailableQuestionsByKp: vi.fn().mockResolvedValue(new Map([[31, 5], [22, 5]])),
      },
      masteryRepo: {
        listBySubject: vi.fn().mockResolvedValue([
          { knowledgePointId: 31, masteryScore: 0.5, level: 2, correctCount: 5, errorCount: 5, lastSeenAt: seen },
          { knowledgePointId: 22, masteryScore: 0.5, level: 2, correctCount: 5, errorCount: 5, lastSeenAt: seen },
        ]),
      },
    });

    expect((await svc.getWeakPoints(9, 1, 10)).candidates.map((c) => c.knowledgePointId)).toEqual([22, 31]);
  });

  it('limit 生效：默认 1 时只回 1 个候选，recommendation = candidates[0]', async () => {
    const { svc } = mk({
      kpRepo: {
        findBySubject: vi.fn().mockResolvedValue([
          { id: 1, name: '数与式', parentKpId: null, gradeBand: 'junior' },
          { id: 11, name: '有理数', parentKpId: 1, gradeBand: 'junior' },
          { id: 12, name: '整式', parentKpId: 1, gradeBand: 'junior' },
        ]),
        countAvailableQuestionsByKp: vi.fn().mockResolvedValue(new Map([[11, 7], [12, 3]])),
      },
      masteryRepo: {
        listBySubject: vi.fn().mockResolvedValue([
          { knowledgePointId: 11, masteryScore: 0.5, level: 2, correctCount: 5, errorCount: 5, lastSeenAt: seen },
          { knowledgePointId: 12, masteryScore: 0.2, level: 1, correctCount: 1, errorCount: 4, lastSeenAt: seen },
        ]),
      },
    });

    const result = await svc.getWeakPoints(9, 1, 1);

    expect(result.candidates).toHaveLength(1);
    expect(result.recommendation!.knowledgePointId).toBe(12);
  });

  it('无够格候选 → 200 + recommendation null + reason no_qualified_candidate（不是错误）', async () => {
    const { svc } = mk();

    const result = await svc.getWeakPoints(9, 1, 1);

    expect(result.candidates).toEqual([]);
    expect(result.recommendation).toBeNull();
    expect(result.reason).toBe('no_qualified_candidate');
  });

  it('候选带 name（由 KP 树补全）与 availableQuestionCount', async () => {
    const { svc } = mk({
      kpRepo: {
        findBySubject: vi.fn().mockResolvedValue([
          { id: 1, name: '数与式', parentKpId: null, gradeBand: 'junior' },
          { id: 11, name: '有理数', parentKpId: 1, gradeBand: 'junior' },
        ]),
        countAvailableQuestionsByKp: vi.fn().mockResolvedValue(new Map([[11, 7]])),
      },
      masteryRepo: {
        listBySubject: vi.fn().mockResolvedValue([
          { knowledgePointId: 11, masteryScore: 0.4, level: 2, correctCount: 4, errorCount: 6, lastSeenAt: seen },
        ]),
      },
    });

    const c = (await svc.getWeakPoints(9, 1, 1)).candidates[0];

    expect(c).toEqual({
      knowledgePointId: 11,
      name: '有理数',
      parentId: 1,
      masteryScore: 0.4,
      level: 2,
      correctCount: 4,
      errorCount: 6,
      sampleSize: 10,
      availableQuestionCount: 7,
      lastSeenAt: '2026-09-20T10:00:00.000Z',
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/knowledge-graph/knowledge-graph.service.test.ts -t getWeakPoints`
Expected: FAIL —— `svc.getWeakPoints is not a function`

- [ ] **Step 3: 追加 DTO 类型**

在 `apps/server/src/modules/knowledge-graph/dto/knowledge-graph.dto.ts` 末尾追加：

```ts
/** 够格的薄弱点候选（三道闸门全过才有资格进来）。 */
export interface WeakPointCandidate {
  knowledgePointId: number;
  name: string;
  parentId: number | null;
  masteryScore: number;
  level: number;
  correctCount: number;
  errorCount: number;
  sampleSize: number;
  availableQuestionCount: number;
  lastSeenAt: string | null;
}

/** `GET /api/knowledge-graph/students/{studentId}/weak-points` 的 data。 */
export interface WeakPointRecommendation {
  subjectId: number;
  candidates: WeakPointCandidate[];
  /** = `candidates[0] ?? null` */
  recommendation: WeakPointCandidate | null;
  /** 无候选**不是错误**：端点仍返回 200，前端据此转引导态 */
  reason: 'ok' | 'no_qualified_candidate';
}
```

- [ ] **Step 4: 实现 `getWeakPoints`**

在 `knowledge-graph.service.ts` 的 `getMastery` 之后、`confidenceFor` 之前插入（类内）：

```ts
  /**
   * 薄弱点推荐（spec §5.4）：三道闸门筛候选 + 稳定排序，取前 `limit` 个。
   *
   * **候选资格（三条同时满足）**：
   * 1. 有该生的掌握度行（做过至少一题且题带 KP 标注）
   * 2. `sampleSize >= MIN_SAMPLE_SIZE` —— 滤掉「做 1 题答对 = 满分」的小样本噪声
   * 3. `availableQuestionCount > 0` —— 否则推了也练不了
   *
   * **排序**：`mastery_score ASC, error_count DESC, knowledge_point_id ASC`。
   * 前两项与 `StudentKnowledgeMasteryRepository.listWeakest` 既有排序一致；
   * 第三项补稳定性，避免并列时每次请求结果抖动。
   *
   * **无候选不是错误**：返回 200 + `recommendation: null`，
   * 让前端转「先做一次练习/考试生成诊断」的引导态（spec §5.3/§6.4）。
   */
  async getWeakPoints(
    studentId: number,
    subjectId: number,
    limit: number,
  ): Promise<WeakPointRecommendation> {
    const [kps, masteryRows, availableMap] = await Promise.all([
      this.kpRepo.findBySubject(subjectId),
      this.masteryRepo.listBySubject(studentId, subjectId),
      this.kpRepo.countAvailableQuestionsByKp(studentId, subjectId),
    ]);

    const kpById = new Map(kps.map((kp) => [kp.id, kp]));

    const candidates: WeakPointCandidate[] = masteryRows
      .filter((row) => {
        const sampleSize = row.correctCount + row.errorCount;
        if (sampleSize < MIN_SAMPLE_SIZE) return false;
        return (availableMap.get(row.knowledgePointId) ?? 0) > 0;
      })
      .map((row) => {
        const kp = kpById.get(row.knowledgePointId);
        return {
          knowledgePointId: row.knowledgePointId,
          // 掌握度行理论上必挂在 KP 上（JOIN 保证），`?? ''` 只防御脏数据
          name: kp?.name ?? '',
          parentId: kp?.parentKpId ?? null,
          masteryScore: row.masteryScore,
          level: row.level,
          correctCount: row.correctCount,
          errorCount: row.errorCount,
          sampleSize: row.correctCount + row.errorCount,
          availableQuestionCount: availableMap.get(row.knowledgePointId) ?? 0,
          lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
        };
      })
      .sort(
        (a, b) =>
          a.masteryScore - b.masteryScore ||
          b.errorCount - a.errorCount ||
          a.knowledgePointId - b.knowledgePointId,
      )
      .slice(0, limit);

    return {
      subjectId,
      candidates,
      recommendation: candidates[0] ?? null,
      reason: candidates.length > 0 ? 'ok' : 'no_qualified_candidate',
    };
  }
```

同时把文件顶部的 import 补上两个新类型：

```ts
import {
  MIN_SAMPLE_SIZE,
  type KnowledgeGraphMastery,
  type KnowledgeGraphNode,
  type MasteryConfidence,
  type WeakPointCandidate,
  type WeakPointRecommendation,
} from './dto/knowledge-graph.dto.js';
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/knowledge-graph/knowledge-graph.service.test.ts`
Expected: PASS（13 用例全绿）

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/modules/knowledge-graph/dto/knowledge-graph.dto.ts \
        apps/server/src/modules/knowledge-graph/knowledge-graph.service.ts \
        apps/server/src/modules/knowledge-graph/knowledge-graph.service.test.ts
git commit -m "feat(server): 薄弱点推荐——三道闸门 + 稳定排序，无候选返回 null 不报错"
```

---

## Task 4: Controller + Module + 应用注册

**Files:**
- Create: `apps/server/src/modules/knowledge-graph/knowledge-graph.controller.ts`
- Create: `apps/server/src/modules/knowledge-graph/knowledge-graph.module.ts`
- Modify: `apps/server/src/app.module.ts`
- Test: `apps/server/src/modules/knowledge-graph/knowledge-graph.controller.test.ts`

**Interfaces:**
- Consumes: Task 2/3 的 `KnowledgeGraphService`
- Produces:
  - `GET /api/knowledge-graph/students/:studentId/mastery?subjectId=1` → `KnowledgeGraphMastery`
  - `GET /api/knowledge-graph/students/:studentId/weak-points?subjectId=1&limit=1` → `WeakPointRecommendation`

- [ ] **Step 1: 写失败的 controller 测试**

创建 `apps/server/src/modules/knowledge-graph/knowledge-graph.controller.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { KnowledgeGraphController } from './knowledge-graph.controller.js';

/** 造一个只关心入参/归属校验的 controller：service 全 mock。 */
function makeCtrl() {
  const service = { getMastery: vi.fn(), getWeakPoints: vi.fn() };
  return { ctrl: new KnowledgeGraphController(service as any), service };
}

const user = { sub: 7 } as any;

describe('KnowledgeGraphController 归属校验', () => {
  it('studentId 非本人 → 403 + code 1005（不是默认的 1003）', async () => {
    const { ctrl, service } = makeCtrl();

    await expect(ctrl.getMastery(9, user, 1)).rejects.toMatchObject({
      response: { code: 1005, message: '无权访问该资源' },
      status: 403,
    });
    expect(service.getMastery).not.toHaveBeenCalled();
  });

  it('weak-points 同样拦非本人', async () => {
    const { ctrl, service } = makeCtrl();

    await expect(ctrl.getWeakPoints(9, user, 1, undefined)).rejects.toMatchObject({
      response: { code: 1005 },
      status: 403,
    });
    expect(service.getWeakPoints).not.toHaveBeenCalled();
  });
});

describe('KnowledgeGraphController subjectId 校验', () => {
  it('subjectId 非 1 → 400 + code 1001', async () => {
    const { ctrl, service } = makeCtrl();

    await expect(ctrl.getMastery(7, user, 2)).rejects.toMatchObject({
      response: { code: 1001 },
      status: 400,
    });
    expect(service.getMastery).not.toHaveBeenCalled();
  });

  it('weak-points 的 subjectId 非 1 → 400 + code 1001', async () => {
    const { ctrl, service } = makeCtrl();

    await expect(ctrl.getWeakPoints(7, user, 3, undefined)).rejects.toMatchObject({
      response: { code: 1001 },
      status: 400,
    });
  });
});

describe('KnowledgeGraphController limit 校验', () => {
  it('缺省 → 1；空串 → 1', async () => {
    const { ctrl, service } = makeCtrl();
    service.getWeakPoints.mockResolvedValue({});

    await ctrl.getWeakPoints(7, user, 1, undefined);
    await ctrl.getWeakPoints(7, user, 1, '');

    expect(service.getWeakPoints).toHaveBeenNthCalledWith(1, 7, 1, 1);
    expect(service.getWeakPoints).toHaveBeenNthCalledWith(2, 7, 1, 1);
  });

  it('非整数 / 0 / 11 / 负数 → 400 + code 1001', async () => {
    const { ctrl, service } = makeCtrl();

    for (const bad of ['abc', '0', '11', '-1', '1.5']) {
      await expect(ctrl.getWeakPoints(7, user, 1, bad)).rejects.toMatchObject({
        response: { code: 1001 },
        status: 400,
      });
    }
    expect(service.getWeakPoints).not.toHaveBeenCalled();
  });

  it('合法 limit 透传（含上界 10）', async () => {
    const { ctrl, service } = makeCtrl();
    service.getWeakPoints.mockResolvedValue({});

    await ctrl.getWeakPoints(7, user, 1, '10');

    expect(service.getWeakPoints).toHaveBeenCalledWith(7, 1, 10);
  });
});

describe('KnowledgeGraphController 透传', () => {
  it('mastery 合法入参：studentId 取 URL 段、subjectId 透传', async () => {
    const { ctrl, service } = makeCtrl();
    service.getMastery.mockResolvedValue({ subjectId: 1, nodes: [], coverage: {} });

    await expect(ctrl.getMastery(7, user, 1)).resolves.toEqual({
      subjectId: 1, nodes: [], coverage: {},
    });
    expect(service.getMastery).toHaveBeenCalledWith(7, 1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/knowledge-graph/knowledge-graph.controller.test.ts`
Expected: FAIL —— `Cannot find module './knowledge-graph.controller.js'`

- [ ] **Step 3: 写 controller**

创建 `apps/server/src/modules/knowledge-graph/knowledge-graph.controller.ts`：

```ts
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { KnowledgeGraphService } from './knowledge-graph.service.js';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import type { KnowledgeGraphMastery, WeakPointRecommendation } from './dto/knowledge-graph.dto.js';

/** 本期只支持数学（spec §2/§3 裁决 1）。 */
const MATH_SUBJECT_ID = 1;

/** `limit` 默认值与上界（spec §5.3）。 */
const DEFAULT_LIMIT = 1;
const MAX_LIMIT = 10;

/**
 * 数学薄弱点图谱（API 文档 §4.5）。
 *
 * **只读**：两个 GET 都不写库、不发分。归属校验用「URL 段 studentId 必须等于 JWT sub」，
 * 不符一律 403 —— ⚠️ **必须显式传 `code: 1005`**：`HttpExceptionFilter.httpStatusToCode`
 * 对 403 的默认值是 1003（那是 token 失效码），不传会给出误导性的错误码。
 */
@Controller('api/knowledge-graph')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class KnowledgeGraphController {
  constructor(private readonly service: KnowledgeGraphService) {}

  /** 全树 + 掌握度 overlay。 */
  @Get('students/:studentId/mastery')
  async getMastery(
    @Param('studentId', ParseIntPipe) studentId: number,
    @CurrentUser() user: JwtUser,
    @Query('subjectId', ParseIntPipe) subjectId: number,
  ): Promise<KnowledgeGraphMastery> {
    this.assertSelf(studentId, user.sub);
    this.assertMathSubject(subjectId);
    return this.service.getMastery(studentId, subjectId);
  }

  /** 薄弱点候选 + 一条推荐。无候选仍 200（`recommendation: null`）。 */
  @Get('students/:studentId/weak-points')
  async getWeakPoints(
    @Param('studentId', ParseIntPipe) studentId: number,
    @CurrentUser() user: JwtUser,
    @Query('subjectId', ParseIntPipe) subjectId: number,
    @Query('limit') limitStr?: string,
  ): Promise<WeakPointRecommendation> {
    this.assertSelf(studentId, user.sub);
    this.assertMathSubject(subjectId);

    // 空串等同缺省（前端 URLSearchParams 不会产出空串，但手拼 URL 会）
    const limit =
      limitStr === undefined || limitStr === ''
        ? DEFAULT_LIMIT
        : Number(limitStr);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new BadRequestException({ code: 1001, message: `limit 仅允许 1-${MAX_LIMIT} 的整数` });
    }

    return this.service.getWeakPoints(studentId, subjectId, limit);
  }

  /** URL 段 studentId 必须是登录者本人（防 IDOR）。 */
  private assertSelf(studentId: number, selfId: number): void {
    if (studentId !== selfId) {
      throw new ForbiddenException({ code: 1005, message: '无权访问该资源' });
    }
  }

  /** 本期只支持数学。 */
  private assertMathSubject(subjectId: number): void {
    if (subjectId !== MATH_SUBJECT_ID) {
      throw new BadRequestException({ code: 1001, message: 'subjectId 仅支持 1（数学）' });
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/knowledge-graph/knowledge-graph.controller.test.ts`
Expected: PASS（8 用例全绿）

- [ ] **Step 5: 写 module**

创建 `apps/server/src/modules/knowledge-graph/knowledge-graph.module.ts`：

```ts
import { Module } from '@nestjs/common';
import { KnowledgeGraphController } from './knowledge-graph.controller.js';
import { KnowledgeGraphService } from './knowledge-graph.service.js';
import { KnowledgePointsRepository } from '../../database/repositories/knowledge-points.repo.js';
import { StudentKnowledgeMasteryRepository } from '../../database/repositories/student-knowledge-mastery.repo.js';
import { MainErrorBooksRepository } from '../../database/repositories/main-error-books.repo.js';

/**
 * 数学薄弱点图谱模块（spec `2026-09-23-math-weakpoint-graph-design.md`）。
 *
 * - **无 `imports`**：三个仓储都只依赖 `@Inject('DATABASE_POOL')`，而 `DatabaseModule` 是
 *   `@Global()`，不需要 import。仓储是**无状态**的（只有一个连接池），与
 *   `TrainingModule` / `ParentInsightsModule` 里各自那份是不同实例、不分裂任何状态。
 * - **不注入 `PointsService`**：本模块只读、不发分。发分仍由
 *   `POST /api/training/targeted/start` → 训练模块负责。
 * - 别把 `StudentKnowledgeMasteryRepository` 改成从别的模块 import：那些模块**不导出**仓储，
 *   强行加 export 会让两个模块的演进互相绑死。
 */
@Module({
  controllers: [KnowledgeGraphController],
  providers: [
    KnowledgeGraphService,
    KnowledgePointsRepository,
    StudentKnowledgeMasteryRepository,
    MainErrorBooksRepository,
  ],
})
export class KnowledgeGraphModule {}
```

- [ ] **Step 6: 在 `app.module.ts` 注册**

在 `apps/server/src/app.module.ts` 顶部 import 区（`ParentInsightsModule` 之后）加：

```ts
import { KnowledgeGraphModule } from './modules/knowledge-graph/knowledge-graph.module.js';
```

在 `imports` 数组末尾（`AnalyticsModule` 之后）加：

```ts
    // 数学薄弱点图谱（2026-09-23）——学生端训练轨第 4 张卡；两个只读端点
    KnowledgeGraphModule,
```

- [ ] **Step 7: 全量后端测试 + 类型检查**

Run: `cd apps/server && npm test && npx tsc --noEmit`
Expected: 全部 PASS；`tsc` 无输出（0 error）

- [ ] **Step 8: 提交**

```bash
git add apps/server/src/modules/knowledge-graph/knowledge-graph.controller.ts \
        apps/server/src/modules/knowledge-graph/knowledge-graph.module.ts \
        apps/server/src/modules/knowledge-graph/knowledge-graph.controller.test.ts \
        apps/server/src/app.module.ts
git commit -m "feat(server): 图谱两个 GET 端点 + 模块注册（403/1005、400/1001）"
```

---

## Task 5: 前端 API 层

**Files:**
- Modify: `apps/web/src/services/api.ts`
- Test: `apps/web/src/services/api.weak-point-graph.test.ts`（新建）

**Interfaces:**
- Consumes: Task 4 的两个端点
- Produces:
  - `export type MasteryConfidence = 'none' | 'insufficient' | 'ok';`
  - `export interface KnowledgeGraphNode { ... }`（与后端 DTO 同形）
  - `export interface KnowledgeGraphMastery { ... }`
  - `export interface WeakPointCandidate { ... }`
  - `export interface WeakPointRecommendation { ... }`
  - `export function getKnowledgeGraphMastery(studentId: number, subjectId: number): Promise<KnowledgeGraphMastery>`
  - `export function getWeakPoints(studentId: number, subjectId: number, limit?: number): Promise<WeakPointRecommendation>`

- [ ] **Step 1: 写失败的测试**

创建 `apps/web/src/services/api.weak-point-graph.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getKnowledgeGraphMastery, getWeakPoints } from './api';

/**
 * 只钉 URL 拼装：断言**全串**（含 `API_BASE` 的 `/api` 前缀），与后端
 * `@Controller('api/knowledge-graph')` 逐字对上。
 *
 * 拼错（少 `/api`、把 subjectId 写成 path 段）在本仓是静默 404，只有这个用例能拦住 ——
 * 所以必须钉全串。用 `toContain('/knowledge-graph/...')` 会**漏掉 `/api` 前缀回归**：
 * 那个子串恰好不含 `/api`，`API_BASE` 改成 `/api/v2` 时测试仍全绿而线上 404。
 */
afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(data: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    json: () => Promise.resolve({ code: 0, message: 'ok', data }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('getKnowledgeGraphMastery', () => {
  it('打 /knowledge-graph/students/:id/mastery?subjectId=1', async () => {
    const fetchMock = stubFetch({ subjectId: 1, nodes: [], coverage: {} });

    await getKnowledgeGraphMastery(7, 1);

    expect(fetchMock.mock.calls[0][0]).toBe('/api/knowledge-graph/students/7/mastery?subjectId=1');
  });
});

describe('getWeakPoints', () => {
  it('默认 limit=1，写在查询串里', async () => {
    const fetchMock = stubFetch({ subjectId: 1, candidates: [], recommendation: null, reason: 'no_qualified_candidate' });

    await getWeakPoints(7, 1);

    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/knowledge-graph/students/7/weak-points?subjectId=1&limit=1',
    );
  });

  it('显式 limit 透传', async () => {
    const fetchMock = stubFetch({ subjectId: 1, candidates: [], recommendation: null, reason: 'ok' });

    await getWeakPoints(7, 1, 5);

    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/knowledge-graph/students/7/weak-points?subjectId=1&limit=5',
    );
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/services/api.weak-point-graph.test.ts`
Expected: FAIL —— `getKnowledgeGraphMastery is not a function`

- [ ] **Step 3: 追加类型与函数**

在 `apps/web/src/services/api.ts` 的 `getMyRewards()` 之后（积分区块末尾）追加：

```ts
// --- 数学薄弱点图谱（GET /api/knowledge-graph/*；spec 2026-09-23-math-weakpoint-graph-design） ---

/** 与后端 `knowledge-graph.dto.ts` 同形；改一处必须同步另一处。 */
export type MasteryConfidence = 'none' | 'insufficient' | 'ok';

export interface KnowledgeGraphNode {
  id: number;
  name: string;
  /** null = 一级知识点 */
  parentId: number | null;
  /** null = 从未作答（**不是 0**——0 是「很弱」） */
  masteryScore: number | null;
  level: number | null;
  correctCount: number | null;
  errorCount: number | null;
  /** ISO 字符串；未作答为 null */
  lastSeenAt: string | null;
  /** correct + error；未作答 = 0 */
  sampleSize: number;
  /** **由后端算好**，前端不重算阈值（阈值唯一真源在服务端 `MIN_SAMPLE_SIZE`） */
  confidence: MasteryConfidence;
  availableQuestionCount: number;
}

export interface KnowledgeGraphMastery {
  subjectId: number;
  nodes: KnowledgeGraphNode[];
  coverage: {
    coveredQuestions: number;
    totalQuestions: number;
    uncoveredUnclearedErrors: number;
  };
}

export interface WeakPointCandidate {
  knowledgePointId: number;
  name: string;
  parentId: number | null;
  masteryScore: number;
  level: number;
  correctCount: number;
  errorCount: number;
  sampleSize: number;
  availableQuestionCount: number;
  lastSeenAt: string | null;
}

export interface WeakPointRecommendation {
  subjectId: number;
  candidates: WeakPointCandidate[];
  /** 无候选时为 null（**不是错误**，端点仍 200） */
  recommendation: WeakPointCandidate | null;
  reason: 'ok' | 'no_qualified_candidate';
}

export function getKnowledgeGraphMastery(
  studentId: number,
  subjectId: number,
): Promise<KnowledgeGraphMastery> {
  const qs = new URLSearchParams({ subjectId: String(subjectId) });
  return fetchApi<KnowledgeGraphMastery>(
    `/knowledge-graph/students/${studentId}/mastery?${qs.toString()}`,
  );
}

export function getWeakPoints(
  studentId: number,
  subjectId: number,
  limit = 1,
): Promise<WeakPointRecommendation> {
  const qs = new URLSearchParams({ subjectId: String(subjectId), limit: String(limit) });
  return fetchApi<WeakPointRecommendation>(
    `/knowledge-graph/students/${studentId}/weak-points?${qs.toString()}`,
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/services/api.weak-point-graph.test.ts`
Expected: PASS（3 用例全绿）

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/services/api.ts apps/web/src/services/api.weak-point-graph.test.ts
git commit -m "feat(web): 图谱 API 层——两个 GET + 与后端同形的类型"
```

---

## Task 6: 热力梯度与档位选择（两个纯函数模块）

**Files:**
- Create: `apps/web/src/pages/student/training/weak-point-heat.ts`
- Modify: `apps/web/src/pages/student/training/point-tiers.ts`
- Test: `apps/web/src/pages/student/training/weak-point-heat.test.ts`（新建）
- Test: `apps/web/src/pages/student/training/point-tiers.test.ts`（追加）

**Interfaces:**
- Produces:
  - `export const HEAT_ALPHA: readonly number[]`
  - `export interface HeatStyle { background: string; color: string; }`
  - `export const NEUTRAL_HEAT: HeatStyle`
  - `export function heatForLevel(level: number): HeatStyle`
  - `export function heatForNode(node: { confidence: MasteryConfidence; level: number | null }): HeatStyle`
  - `export function isDashedBorder(confidence: MasteryConfidence): boolean`
  - `export function summarizeParent(children: Array<{ confidence: MasteryConfidence; level: number | null }>): { weakestLevel: number | null; pendingCount: number; }`
  - `export const MIN_PRACTICE_COUNT = 3;`
  - `export function pickPracticeCount(tiers: Array<{ tierKey: string }>): number | null`

**为什么抽模块：** 热力色若在页面里内联，一级汇总、二级 chip、详情栏三处会各算一遍；档位选择若内联，`TargetedConfigPage` 与本页会各有一份。抽出来后测试能直接钉住边界，页面测试只验渲染。

- [ ] **Step 1: 写失败的测试**

创建 `apps/web/src/pages/student/training/weak-point-heat.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  HEAT_ALPHA,
  NEUTRAL_HEAT,
  heatForLevel,
  heatForNode,
  isDashedBorder,
  summarizeParent,
} from './weak-point-heat';

describe('heatForLevel', () => {
  it('level 0–5 取对应不透明度，色相固定为 brand 橘红', () => {
    for (let level = 0; level <= 5; level++) {
      const style = heatForLevel(level);
      expect(style.background).toBe(`rgba(255, 107, 53, ${HEAT_ALPHA[level]})`);
    }
  });

  it('越弱越深：level 0 比 level 5 实', () => {
    expect(HEAT_ALPHA[0]).toBeGreaterThan(HEAT_ALPHA[5]);
  });

  it('高不透明度用白字、低不透明度用正文色（对比度）', () => {
    expect(heatForLevel(0).color).toBe('#ffffff');
    expect(heatForLevel(5).color).toBe('var(--text-primary)');
  });

  it('越界 level 夹到 0–5，不产生 undefined 颜色', () => {
    expect(heatForLevel(-3).background).toBe(heatForLevel(0).background);
    expect(heatForLevel(99).background).toBe(heatForLevel(5).background);
    // 2.6 → 3（四舍五入到最近档）
    expect(heatForLevel(2.6).background).toBe(heatForLevel(3).background);
  });

  it('NaN 兜底到 level 0，不产出 undefined 颜色（畸形载荷防线）', () => {
    expect(heatForLevel(NaN).background).toBe(heatForLevel(0).background);
    expect(heatForLevel(NaN).background).not.toContain('undefined');
  });

  it('±Infinity 仍走夹取（守卫只拦 NaN，不反转无穷的语义）', () => {
    expect(heatForLevel(Infinity).background).toBe(heatForLevel(5).background);
    expect(heatForLevel(-Infinity).background).toBe(heatForLevel(0).background);
  });
});

describe('heatForNode', () => {
  it('none（从未作答）→ 中性灰，即使 level 是 0', () => {
    expect(heatForNode({ confidence: 'none', level: null })).toEqual(NEUTRAL_HEAT);
    expect(heatForNode({ confidence: 'none', level: 0 })).toEqual(NEUTRAL_HEAT);
  });

  it('insufficient（样本 < 5）→ 中性灰，即使 level 是 5', () => {
    expect(heatForNode({ confidence: 'insufficient', level: 5 })).toEqual(NEUTRAL_HEAT);
  });

  it('ok → 按 level 着色', () => {
    expect(heatForNode({ confidence: 'ok', level: 2 })).toEqual(heatForLevel(2));
  });

  it('ok 但 level 为 null 时兜底 level 0（不崩）', () => {
    expect(heatForNode({ confidence: 'ok', level: null })).toEqual(heatForLevel(0));
  });
});

describe('isDashedBorder', () => {
  it('只有 insufficient 用虚线边（区分「有结论但浅」与「没结论」）', () => {
    expect(isDashedBorder('insufficient')).toBe(true);
    expect(isDashedBorder('none')).toBe(false);
    expect(isDashedBorder('ok')).toBe(false);
  });
});

describe('summarizeParent', () => {
  it('只看有结论（ok）的子项；取最弱 level 作汇总色', () => {
    const result = summarizeParent([
      { confidence: 'ok', level: 4 },
      { confidence: 'ok', level: 1 },
      { confidence: 'none', level: null },
      { confidence: 'insufficient', level: 5 },
    ]);

    expect(result.weakestLevel).toBe(1);
    // level ≤ 2 记待补：只有 level 1 那个
    expect(result.pendingCount).toBe(1);
  });

  it('无任何 ok 子项 → weakestLevel null、pendingCount 0（一级行显示「未开始」）', () => {
    const result = summarizeParent([
      { confidence: 'none', level: null },
      { confidence: 'insufficient', level: 3 },
    ]);

    expect(result.weakestLevel).toBeNull();
    expect(result.pendingCount).toBe(0);
  });

  it('空数组不崩', () => {
    expect(summarizeParent([])).toEqual({ weakestLevel: null, pendingCount: 0 });
  });
});
```

在 `apps/web/src/pages/student/training/point-tiers.test.ts` 末尾追加（文件顶部 import 需补 `pickPracticeCount`、`MIN_PRACTICE_COUNT`、`MATH_TASK_CODE`）：

```ts
describe('pickPracticeCount', () => {
  // 不加 `as any`：`tseslint.configs.recommended` 的 no-explicit-any 是 error 级、
  // 且配置里没有测试文件豁免，加了会让 Task 11 的 `npm run lint` 门禁失败。
  // `{ tierKey: string }` 本就满足 `Array<{ tierKey: string }>`，断言是多余的。
  const t = (tierKey: string) => ({ tierKey });

  it('取 ≥3 的最小档（默认档位 1/3/5/10 → 3）', () => {
    expect(pickPracticeCount([t('1'), t('3'), t('5'), t('10')])).toBe(3);
  });

  it('全部 < 3（家长只留 1 题档）→ 退化为最大档，不报错', () => {
    expect(pickPracticeCount([t('1')])).toBe(1);
  });

  it('档位顺序打乱也取最小值', () => {
    expect(pickPracticeCount([t('10'), t('5'), t('3')])).toBe(3);
  });

  it('空数组 → null（调用方据此不渲染开练按钮，不硬发请求）', () => {
    expect(pickPracticeCount([])).toBeNull();
  });

  it('非数字 / 非正档位被忽略', () => {
    expect(pickPracticeCount([t('abc'), t('0'), t('5')])).toBe(5);
    expect(pickPracticeCount([t('abc')])).toBeNull();
  });

  it('MIN_PRACTICE_COUNT 是 3（spec §10 裁决：1 题偏少）', () => {
    expect(MIN_PRACTICE_COUNT).toBe(3);
  });

  it('MATH_TASK_CODE 是 math_targeted（两页共用的真源，改名必须显式改这里）', () => {
    expect(MATH_TASK_CODE).toBe('math_targeted');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/student/training/weak-point-heat.test.ts src/pages/student/training/point-tiers.test.ts`
Expected: FAIL —— `Cannot find module './weak-point-heat'` 且 `pickPracticeCount is not a function`

- [ ] **Step 3: 写 `weak-point-heat.ts`**

创建 `apps/web/src/pages/student/training/weak-point-heat.ts`：

```ts
/**
 * 薄弱点图谱的**热力梯度唯一实现**。
 *
 * 为什么抽成模块：一级行汇总色、二级 chip、详情栏三处都要着色，内联就会各算一遍、
 * 改一处漏一处（本仓既有教训：`point-tiers.ts` 的注释里记着同类问题）。
 *
 * 语义：`level` 0（最弱）→ 5（最强），**越弱越深**，让薄弱点跳出来。
 * 色相固定为 brand 橘红（`#ff6b35` = `--brand-500`），只调不透明度——
 * 这样不引入第二套配色（`style.md` §2 硬约束），且日/夜间主题下都读得通。
 */
import type { MasteryConfidence } from '@/services/api';

/** `--brand-500` 的 RGB 分量；改品牌色时必须同步这里（唯一硬编码点）。 */
const BRAND_RGB = '255, 107, 53';

/** level 0→5 对应的 brand 不透明度（越弱越实）。 */
export const HEAT_ALPHA: readonly number[] = [1, 0.82, 0.64, 0.46, 0.28, 0.14];

/** 达到该不透明度及以上用白字，否则用正文色（保证对比度）。 */
const WHITE_TEXT_THRESHOLD = 0.6;

export interface HeatStyle {
  background: string;
  color: string;
}

/** 未作答 / 样本不足的中性表现（灰底灰字）。 */
export const NEUTRAL_HEAT: HeatStyle = {
  background: 'var(--bg-subtle)',
  color: 'var(--text-tertiary)',
};

/** 由 level 取热力样式；level 越界或非整数一律夹/四舍五入到 0–5。 */
export function heatForLevel(level: number): HeatStyle {
  // NaN 单独兜底：`Math.round(NaN)` → NaN 会一路穿透到 `HEAT_ALPHA[NaN]` === undefined，
  // 产出 `rgba(255, 107, 53, undefined)` 这种非法颜色（畸形载荷防线）。
  // **只拦 NaN，不用 `Number.isFinite`**——±Infinity 走下面的夹取本就正确
  // （+∞→5、-∞→0），换成 isFinite 会把它反转成 0，语义反而错。
  const clamped = Number.isNaN(level) ? 0 : Math.min(5, Math.max(0, Math.round(level)));
  const alpha = HEAT_ALPHA[clamped];
  return {
    background: `rgba(${BRAND_RGB}, ${alpha})`,
    color: alpha >= WHITE_TEXT_THRESHOLD ? '#ffffff' : 'var(--text-primary)',
  };
}

/**
 * 节点热力样式：`confidence` 决定「有没有结论」，`level` 决定深浅。
 *
 * - `none`（从未作答）→ 中性灰
 * - `insufficient`（样本 < 5）→ 中性灰（虚线边由 `isDashedBorder` 另行给出）
 * - `ok` → 按 level 着色
 *
 * **`confidence` 由后端算好**，这里只做映射，不重算阈值。
 */
export function heatForNode(node: {
  confidence: MasteryConfidence;
  level: number | null;
}): HeatStyle {
  if (node.confidence !== 'ok') return NEUTRAL_HEAT;
  return heatForLevel(node.level ?? 0);
}

/** 样本不足（`insufficient`）用虚线边，与「有结论但浅」区分开。 */
export function isDashedBorder(confidence: MasteryConfidence): boolean {
  return confidence === 'insufficient';
}

/** 「待补」的 level 上界：`level <= 2`（掌握度 < 60%）。纯展示口径，不参与推荐算法。 */
const WEAK_LEVEL_MAX = 2;

/**
 * 一级行的汇总：只统计**有结论**（`ok`）的子项。
 *
 * - `weakestLevel` = 子项里最弱的 level（汇总色块用）；无 `ok` 子项 → null（一级行显示「未开始」）
 * - `pendingCount` = `ok` 子项里 `level <= WEAK_LEVEL_MAX` 的个数（「N 个待补」）
 *
 * `insufficient` 与 `none` **都不计入**任何一边：前者没结论、后者没做过，
 * 混进来会让「待补」数字失去意义（spec §6.4：不假装有数据）。
 */
export function summarizeParent(
  children: Array<{ confidence: MasteryConfidence; level: number | null }>,
): { weakestLevel: number | null; pendingCount: number } {
  const concluded = children.filter((c) => c.confidence === 'ok');
  if (concluded.length === 0) return { weakestLevel: null, pendingCount: 0 };
  const levels = concluded.map((c) => c.level ?? 0);
  return {
    weakestLevel: Math.min(...levels),
    pendingCount: levels.filter((l) => l <= WEAK_LEVEL_MAX).length,
  };
}
```

- [ ] **Step 4: 在 `point-tiers.ts` 追加档位选择**

在 `apps/web/src/pages/student/training/point-tiers.ts` 末尾追加：

```ts
/**
 * 数学专项练习的任务代号（`GET /points/me/rules` 返回的 `taskCode`）。
 *
 * **单一真源**：专项配置页与薄弱点图谱页都从这里 import。以前两页各写一份字面量，
 * 哪天后端/别处改了这个代号而只改一处 → 图谱页查不到档位 → 「开始补这个」不渲染，
 * 学生只看到一个莫名其妙的缺失动作（专项配置页那侧则照旧能用）。
 */
export const MATH_TASK_CODE = 'math_targeted';

/**
 * 专项练习的最小题量（spec §10 裁决：1 题偏少，改取「≥3 的最小可用档」）。
 */
export const MIN_PRACTICE_COUNT = 3;

/**
 * 从可用档位里挑一个开练题量（薄弱点图谱「开始补这个」用）。
 *
 * 规则（spec §6.3）：
 * 1. 取 **≥ `MIN_PRACTICE_COUNT` 的最小档**（默认档位 `1/3/5/10` 下即 3）
 * 2. 若可用档**全部 < 3**（家长只留了 1 题档）→ 退化为其中**最大**的一档，**不报错**
 * 3. 一个可用档都没有（空数组 / 全非数字）→ `null`，调用方据此**不渲染开练按钮**，
 *    不硬发请求（否则会被 `targeted/start` 以 400 拒绝）
 *
 * `tierKey` 对 `math_targeted` 是纯数字字符串（家长端不能新增档位），可直接 `Number()`。
 */
export function pickPracticeCount(tiers: Array<{ tierKey: string }>): number | null {
  const counts = tiers
    .map((t) => Number(t.tierKey))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (counts.length === 0) return null;

  const usable = counts.filter((n) => n >= MIN_PRACTICE_COUNT);
  if (usable.length > 0) return Math.min(...usable);
  return Math.max(...counts);
}
```

- [ ] **Step 4b: 让专项配置页改用同一常量**

改 `apps/web/src/pages/student/training/TargetedConfigPage.tsx`：删掉文件里的私有 `const MATH_TASK_CODE = 'math_targeted';`（约第 16 行），改成从 `./point-tiers` import：

```ts
import { MATH_TASK_CODE, tierStatus, usePointTiers } from './point-tiers';
```

**行为零变化**（值一样），目的是让两页共用一份真源。既有 `TargetedConfigPage.test.tsx` 全部用例必须仍通过。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/pages/student/training/weak-point-heat.test.ts src/pages/student/training/point-tiers.test.ts src/pages/student/training/TargetedConfigPage.test.tsx`
Expected: PASS（两文件全绿）

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/pages/student/training/weak-point-heat.ts \
        apps/web/src/pages/student/training/weak-point-heat.test.ts \
        apps/web/src/pages/student/training/point-tiers.ts \
        apps/web/src/pages/student/training/point-tiers.test.ts \
        apps/web/src/pages/student/training/TargetedConfigPage.tsx
git commit -m "feat(web): 热力梯度与开练题量抽取（单一实现 + 边界测试）"
```

---

## Task 7: `WeakPointGraphPage` 页面

**Files:**
- Create: `apps/web/src/pages/student/training/WeakPointGraphPage.tsx`
- Test: `apps/web/src/pages/student/training/WeakPointGraphPage.test.tsx`

**Interfaces:**
- Consumes: Task 5 的 API 函数与类型；Task 6 的 `heatForNode` / `isDashedBorder` / `summarizeParent` / `pickPracticeCount` / **`MATH_TASK_CODE` / `usePointTiers`**（档位一律走它，不要自己调 `getMyPointRules`）；既有 `startTargetedPractice` / `parseRunHandoff` / `TargetedRunHandoff`
- Produces: `export default function WeakPointGraphPage(): JSX.Element`；写 `sessionStorage['training:targeted']` 后跳 `/student/training/targeted/run`

**页面结构（spec §6.2 逐条落地）**

```
[PageHeader: 返回训练 / 薄弱点图谱 · 数学]
[推荐条]  有候选 → 「最该补：X」+ 掌握度/样本/可抽题数 + [开始补这个] [看这个知识点的错题]
          无候选 → 引导文案 + [去专项练习] [去考试]
          拉取失败 → 整条不渲染（图谱仍可用）
[主体 lg: 两栏]
  左：一级折叠树（默认全收起）
  右：详情栏（未选中 → 提示；选中 → 详情 + 两个动作）；< lg 时为底部抽屉
[页脚] 覆盖 x/y 道题 · 另有 N 道未标注知识点的题，不计入上图 · [去错题页看]
```

- [ ] **Step 1: 写失败的页面测试**

创建 `apps/web/src/pages/student/training/WeakPointGraphPage.test.tsx`：

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import WeakPointGraphPage from './WeakPointGraphPage';
import type { KnowledgeGraphMastery, WeakPointRecommendation } from '@/services/api';

/**
 * 薄弱点图谱页（spec §6）。
 *
 * 钉住：折叠树默认收起、展开出二级、点 chip 出详情、推荐条两态（有候选 / 引导）、
 * 推荐拉取失败时**只降级推荐条**（图谱仍渲染）、**档位四态**（加载中转圈 / 失败给重试控件 /
 * 家长停用不渲染死按钮 / 正常可点）、confidence 三态渲染各异、页脚口径。
 *
 * vitest globals:false —— 必须显式 import + 自己写 afterEach(cleanup)。
 */

const getKnowledgeGraphMastery = vi.hoisted(() => vi.fn());
const getWeakPoints = vi.hoisted(() => vi.fn());
const getMyPointRules = vi.hoisted(() => vi.fn());
const startTargetedPractice = vi.hoisted(() => vi.fn());

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, getKnowledgeGraphMastery, getWeakPoints, getMyPointRules, startTargetedPractice };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

beforeEach(() => {
  getKnowledgeGraphMastery.mockReset();
  getWeakPoints.mockReset();
  getMyPointRules.mockReset();
  startTargetedPractice.mockReset();
  localStorage.setItem('userId', '7');
  getMyPointRules.mockResolvedValue({
    tasks: [{ taskCode: 'math_targeted', taskName: '数学专项', tiers: [{ tierKey: '1' }, { tierKey: '3' }, { tierKey: '10' }] }],
  });
});

/** 一级 1 下有 11（ok/level2）、12（insufficient）、13（none）。 */
function mastery(overrides: Partial<KnowledgeGraphMastery> = {}): KnowledgeGraphMastery {
  return {
    subjectId: 1,
    nodes: [
      { id: 1, name: '数与式', parentId: null, masteryScore: null, level: null, correctCount: null, errorCount: null, lastSeenAt: null, sampleSize: 0, confidence: 'none', availableQuestionCount: 0 },
      { id: 11, name: '有理数', parentId: 1, masteryScore: 0.4, level: 2, correctCount: 4, errorCount: 6, lastSeenAt: '2026-09-20T10:00:00.000Z', sampleSize: 10, confidence: 'ok', availableQuestionCount: 7 },
      { id: 12, name: '整式', parentId: 1, masteryScore: 0, level: 0, correctCount: 0, errorCount: 1, lastSeenAt: '2026-09-19T10:00:00.000Z', sampleSize: 1, confidence: 'insufficient', availableQuestionCount: 3 },
      { id: 13, name: '分式', parentId: 1, masteryScore: null, level: null, correctCount: null, errorCount: null, lastSeenAt: null, sampleSize: 0, confidence: 'none', availableQuestionCount: 5 },
    ],
    coverage: { coveredQuestions: 205, totalQuestions: 457, uncoveredUnclearedErrors: 4 },
    ...overrides,
  };
}

function recommendation(): WeakPointRecommendation {
  return {
    subjectId: 1,
    candidates: [
      { knowledgePointId: 11, name: '有理数', parentId: 1, masteryScore: 0.4, level: 2, correctCount: 4, errorCount: 6, sampleSize: 10, availableQuestionCount: 7, lastSeenAt: '2026-09-20T10:00:00.000Z' },
    ],
    recommendation: { knowledgePointId: 11, name: '有理数', parentId: 1, masteryScore: 0.4, level: 2, correctCount: 4, errorCount: 6, sampleSize: 10, availableQuestionCount: 7, lastSeenAt: '2026-09-20T10:00:00.000Z' },
    reason: 'ok',
  };
}

function renderPage() {
  const router = createMemoryRouter(
    [
      { path: '/student/training/weak-points', element: <WeakPointGraphPage /> },
      { path: '/student/training/targeted/run', element: <div>专项作答页桩</div> },
      { path: '/student/training/errors', element: <div>错题页桩</div> },
      { path: '/student/training/targeted', element: <div>专项配置页桩</div> },
      { path: '/student/training/exam', element: <div>考试页桩</div> },
    ],
    { initialEntries: ['/student/training/weak-points'] },
  );
  return { router, ...render(<RouterProvider router={router} />) };
}

async function renderSettled() {
  const utils = renderPage();
  expect(await screen.findByText('数与式')).toBeInTheDocument();
  return utils;
}

describe('WeakPointGraphPage 折叠树', () => {
  it('默认全部收起：一级可见、二级不可见', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockResolvedValue(recommendation());

    await renderSettled();

    expect(screen.getByText('数与式')).toBeInTheDocument();
    expect(screen.queryByText('有理数')).toBeNull();
  });

  it('点一级展开出二级；再点收起', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockResolvedValue(recommendation());

    await renderSettled();
    fireEvent.click(screen.getByRole('button', { name: /数与式/ }));
    expect(screen.getByText('有理数')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /数与式/ }));
    await waitFor(() => expect(screen.queryByText('有理数')).toBeNull());
  });

  it('一级行显示「N 个待补」（只看有结论的 ok 子项，level ≤ 2 计数）', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockResolvedValue(recommendation());

    await renderSettled();

    expect(screen.getByText('1 个待补')).toBeInTheDocument();
  });
});

describe('WeakPointGraphPage 详情栏', () => {
  it('未选中时显示提示文案', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockResolvedValue(recommendation());

    await renderSettled();

    expect(screen.getByText('点左侧知识点看详情')).toBeInTheDocument();
  });

  it('点二级 chip 后详情栏显示对错数与样本可信度', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockResolvedValue(recommendation());

    await renderSettled();
    fireEvent.click(screen.getByRole('button', { name: /数与式/ }));
    fireEvent.click(screen.getByRole('button', { name: '有理数' }));

    expect(screen.getByText('对 4 错 6')).toBeInTheDocument();
    // 必须用**精确串**而非正则：`/样本 10 题/` 会同时命中推荐条的
    // 「掌握度 40% · 样本 10 题 · 可抽 7 题」与详情栏的「样本 10 题」→ getByText 因多命中而抛错。
    // 精确串只命中详情栏（推荐条那个节点的 textContent 还含前后文）。
    expect(screen.getByText('样本 10 题')).toBeInTheDocument();
  });

  it('样本不足的 KP：详情栏注明「暂不判定强弱」', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockResolvedValue(recommendation());

    await renderSettled();
    fireEvent.click(screen.getByRole('button', { name: /数与式/ }));
    fireEvent.click(screen.getByRole('button', { name: '整式' }));

    expect(screen.getByText(/样本不足（<5 题），暂不判定强弱/)).toBeInTheDocument();
  });

  it('从未作答的 KP：详情栏显示「未开始」，不显示百分比', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockResolvedValue(recommendation());

    await renderSettled();
    fireEvent.click(screen.getByRole('button', { name: /数与式/ }));
    fireEvent.click(screen.getByRole('button', { name: '分式' }));

    expect(screen.getByText('未开始')).toBeInTheDocument();
    expect(screen.queryByText('0%')).toBeNull();
  });
});

describe('WeakPointGraphPage 推荐条', () => {
  it('有候选：显示「最该补：X」+ 样本 + 可抽题数 + 两个动作', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockResolvedValue(recommendation());

    await renderSettled();

    expect(screen.getByText(/最该补：有理数/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始补这个' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '看这个知识点的错题' })).toBeInTheDocument();
  });

  it('无候选：转引导态，显示引导文案 + [去专项练习] / [去考试]', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockResolvedValue({ subjectId: 1, candidates: [], recommendation: null, reason: 'no_qualified_candidate' });

    await renderSettled();

    expect(screen.getByText(/还没有足够的数据来判断你的薄弱点/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '去专项练习' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '去考试' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '开始补这个' })).toBeNull();
  });

  it('推荐拉取失败：推荐条整条不渲染，但树照常渲染', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockRejectedValue(new Error('boom'));

    await renderSettled();

    expect(screen.queryByText(/最该补/)).toBeNull();
    expect(screen.queryByText(/还没有足够的数据/)).toBeNull();
    expect(screen.getByText('数与式')).toBeInTheDocument();
  });

  it('「开始补这个」按 ≥3 的最小档开练并跳作答页', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockResolvedValue(recommendation());
    startTargetedPractice.mockResolvedValue({
      sessionId: 3,
      questions: [{ questionId: 1, text: 't', type: 'choice', options: null }],
    });

    const { router } = await renderSettled();
    // 档位是异步拉的，到位前按钮 disabled —— 点击会静默失效，必须先等它可用
    await waitFor(() => expect(screen.getByRole('button', { name: '开始补这个' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '开始补这个' }));

    await waitFor(() =>
      expect(startTargetedPractice).toHaveBeenCalledWith({ subjectId: 1, kpId: 11, type: null, count: 3 }),
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/student/training/targeted/run'),
    );
  });

  it('抽到空题单：留在本页并提示，不跳转', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockResolvedValue(recommendation());
    startTargetedPractice.mockResolvedValue({ sessionId: null, questions: [] });

    const { router } = await renderSettled();
    await waitFor(() => expect(screen.getByRole('button', { name: '开始补这个' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '开始补这个' }));

    expect(await screen.findByText(/暂时抽不到这个知识点的题/)).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/student/training/weak-points');
  });

  it('「看这个知识点的错题」带 kpId 跳错题页', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockResolvedValue(recommendation());

    const { router } = await renderSettled();
    fireEvent.click(screen.getByRole('button', { name: '看这个知识点的错题' }));

    await waitFor(() =>
      expect(router.state.location.pathname + router.state.location.search).toBe(
        '/student/training/errors?kpId=11',
      ),
    );
  });
});

describe('WeakPointGraphPage 档位状态（靠界面表达，不加说明文案）', () => {
  it('档位加载失败：主 CTA 换成「重试」控件，点它能重新拉到档位', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockResolvedValue(recommendation());
    getMyPointRules.mockRejectedValueOnce(new Error('boom'));

    await renderSettled();

    // 失败不是「灰着不动」：给可操作的重试控件，而不是一行说明文字
    expect(screen.queryByRole('button', { name: '开始补这个' })).toBeNull();
    const retry = screen.getByRole('button', { name: '重试' });

    getMyPointRules.mockResolvedValue({
      tasks: [{ taskCode: 'math_targeted', taskName: '数学专项', tiers: [{ tierKey: '3' }] }],
    });
    fireEvent.click(retry);

    await waitFor(() => expect(screen.getByRole('button', { name: '开始补这个' })).toBeEnabled());
  });

  it('家长停用全部档位：不渲染点不动的死按钮，只留「看这个知识点的错题」', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockResolvedValue(recommendation());
    getMyPointRules.mockResolvedValue({
      tasks: [{ taskCode: 'math_targeted', taskName: '数学专项', tiers: [] }],
    });

    await renderSettled();

    expect(screen.queryByRole('button', { name: '开始补这个' })).toBeNull();
    // 能用的动作仍在，学生不至于无路可走
    expect(screen.getByRole('button', { name: '看这个知识点的错题' })).toBeInTheDocument();
  });

  it('档位加载中：CTA 转圈（loading），不是静默置灰', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockResolvedValue(recommendation());
    getMyPointRules.mockReturnValue(new Promise(() => {})); // 永不 resolve → 停在加载态

    renderPage();

    // 渲染出来（区别于 unavailable 的「不渲染」）+ disabled + 有 spinner
    const cta = await screen.findByRole('button', { name: '开始补这个' });
    expect(cta).toBeDisabled();
    expect(cta.querySelector('.animate-spin')).not.toBeNull();
  });
});

describe('WeakPointGraphPage confidence 三态渲染', () => {
  it('ok 用 brand 橘红实底；insufficient / none 用中性灰', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockResolvedValue(recommendation());

    await renderSettled();
    fireEvent.click(screen.getByRole('button', { name: /数与式/ }));

    expect(screen.getByRole('button', { name: '有理数' }).style.background).toContain('rgba(255, 107, 53');
    expect(screen.getByRole('button', { name: '整式' }).style.background).toContain('var(--bg-subtle)');
    expect(screen.getByRole('button', { name: '分式' }).style.background).toContain('var(--bg-subtle)');
  });

  it('insufficient 额外带虚线边，none 不带', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockResolvedValue(recommendation());

    await renderSettled();
    fireEvent.click(screen.getByRole('button', { name: /数与式/ }));

    expect(screen.getByRole('button', { name: '整式' }).className).toContain('border-dashed');
    expect(screen.getByRole('button', { name: '分式' }).className).not.toContain('border-dashed');
  });
});

describe('WeakPointGraphPage 页脚与错误态', () => {
  it('页脚显示覆盖数与未标注错题数，并可跳错题页', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(mastery());
    getWeakPoints.mockResolvedValue(recommendation());

    const { router } = await renderSettled();

    expect(screen.getByText(/205 \/ 457/)).toBeInTheDocument();
    expect(screen.getByText(/另有 4 道未标注知识点的题/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '去错题页看' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/student/training/errors'));
  });

  it('未标注错题为 0 时不渲染页脚那半句', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(
      mastery({ coverage: { coveredQuestions: 205, totalQuestions: 457, uncoveredUnclearedErrors: 0 } }),
    );
    getWeakPoints.mockResolvedValue(recommendation());

    await renderSettled();

    expect(screen.queryByText(/另有 0 道/)).toBeNull();
  });

  it('mastery 拉取失败：显示重试，不留白', async () => {
    getKnowledgeGraphMastery.mockRejectedValue(new Error('boom'));
    getWeakPoints.mockResolvedValue(recommendation());

    renderPage();

    expect(await screen.findByRole('button', { name: '重试' })).toBeInTheDocument();
  });

  it('全灰树不显示「暂无数据」（不是错误态）', async () => {
    getKnowledgeGraphMastery.mockResolvedValue(
      mastery({
        nodes: [
          { id: 1, name: '数与式', parentId: null, masteryScore: null, level: null, correctCount: null, errorCount: null, lastSeenAt: null, sampleSize: 0, confidence: 'none', availableQuestionCount: 0 },
        ],
      }),
    );
    getWeakPoints.mockResolvedValue({ subjectId: 1, candidates: [], recommendation: null, reason: 'no_qualified_candidate' });

    await renderSettled();

    expect(screen.queryByText('暂无数据')).toBeNull();
    expect(screen.getByText('数与式')).toBeInTheDocument();
    expect(screen.getByText('未开始')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/student/training/WeakPointGraphPage.test.tsx`
Expected: FAIL —— `Cannot find module './WeakPointGraphPage'`

- [ ] **Step 3: 写页面**

创建 `apps/web/src/pages/student/training/WeakPointGraphPage.tsx`：

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { Button, Card, PageHeader, Skeleton } from '@/components/base';
import {
  getKnowledgeGraphMastery,
  getWeakPoints,
  startTargetedPractice,
  type KnowledgeGraphMastery,
  type KnowledgeGraphNode,
  type WeakPointRecommendation,
} from '@/services/api';
import { MATH_TASK_CODE, pickPracticeCount, usePointTiers } from './point-tiers';
import { heatForNode, isDashedBorder, summarizeParent } from './weak-point-heat';
import type { TargetedRunHandoff } from './run-handoff';

/** id 对应 subjects 表 seed（1=数学），与训练轨各页一致。 */
const MATH_SUBJECT_ID = 1;

/** 作答页读的 sessionStorage 键（与 TargetedConfigPage 同键，勿另起）。 */
const TARGETED_SESSION_KEY = 'training:targeted';

/** 展开箭头（线性 SVG，展开时旋转 90°）。 */
const ChevronIcon = ({ expanded }: { expanded: boolean }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" strokeLinejoin="round"
    className={clsx('w-4 h-4 transition-transform', expanded && 'rotate-90')} aria-hidden="true">
    <path d="m9 6 6 6-6 6" />
  </svg>
);

function percent(score: number): string {
  return `${Math.round(score * 100)}%`;
}

/**
 * 数学薄弱点图谱（spec `2026-09-23-math-weakpoint-graph-design.md` §6）。
 *
 * 训练轨全屏页：**不在任何 Layout 下、硬编码 `data-theme="student-day"`**（CLAUDE.md 硬约束）。
 *
 * 两个请求**并行发、各自独立状态**：`weak-points` 失败只降级推荐条（图谱仍可用），
 * `mastery` 失败才整页给重试——一栏坏掉不拖垮另一栏。
 */
export default function WeakPointGraphPage() {
  const navigate = useNavigate();
  const studentId = Number(localStorage.getItem('userId')) || 0;

  const [mastery, setMastery] = useState<KnowledgeGraphMastery | null>(null);
  const [masteryError, setMasteryError] = useState(false);
  const [rec, setRec] = useState<WeakPointRecommendation | null>(null);
  const [recFailed, setRecFailed] = useState(false);

  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [selectedKpId, setSelectedKpId] = useState<number | null>(null);

  // 档位：决定「开始补这个」的题量（≥3 的最小可用档）。
  //
  // **必须复用 `usePointTiers`，不要自己再手搓一次 `getMyPointRules()`**：它把状态分成
  // `null`=加载中 / `error`=失败 / `[]`=家长停用，并给了 `retry()`，与专项配置页是同一份实现。
  // 手搓会把三种状态塌成「空数组」一种 —— 失败时主 CTA 就成了一个**永远点不动、也没人
  // 解释为什么**的死按钮。spec §6.3 要求「档位取不到 → 不硬发请求」，而这件事要由**界面**
  // 说清楚（loading 转圈 / 重试控件 / 干脆不渲染），不是加一行文案。
  const { tiers, error: tierError, retry: retryTiers } = usePointTiers(MATH_TASK_CODE);
  const [starting, setStarting] = useState(false);
  const [startNotice, setStartNotice] = useState<string | null>(null);

  const loadMastery = useCallback(async () => {
    setMasteryError(false);
    try {
      setMastery(await getKnowledgeGraphMastery(studentId, MATH_SUBJECT_ID));
    } catch {
      setMasteryError(true);
      setMastery(null);
    }
  }, [studentId]);

  const loadRec = useCallback(async () => {
    setRecFailed(false);
    try {
      setRec(await getWeakPoints(studentId, MATH_SUBJECT_ID, 1));
    } catch {
      // 失败只降级推荐条：图谱是主内容，不该被推荐拖垮
      setRecFailed(true);
      setRec(null);
    }
  }, [studentId]);

  useEffect(() => {
    void loadMastery();
    void loadRec();
  }, [loadMastery, loadRec]);

  // 必须 useMemo：`mastery?.nodes ?? []` 每次渲染都是**新数组身份**，会让下面三个
  // 记忆化钩子（parents / childrenOf / nodeById）每帧重算、等于白写，且触发 3 条
  // react-hooks/exhaustive-deps 警告（训练目录原本 lint 干净）。
  const nodes = useMemo(() => mastery?.nodes ?? [], [mastery]);

  const parents = useMemo(() => nodes.filter((n) => n.parentId == null), [nodes]);
  const childrenOf = useCallback(
    (parentId: number) => nodes.filter((n) => n.parentId === parentId),
    [nodes],
  );
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const selected = selectedKpId != null ? nodeById.get(selectedKpId) ?? null : null;

  // null = 还没拉到档位（加载中）或没有可用档位（家长停用）——两种都由界面表达，见 PracticeAction。
  const practiceCount = tiers == null ? null : pickPracticeCount(tiers);

  /** 「开始补这个」的界面状态：四种都靠控件本身表达，不用文案解释。 */
  const practiceState: PracticeActionState =
    tiers == null
      ? 'loading'
      : tierError != null
        ? 'failed'
        : practiceCount == null
          ? 'unavailable'
          : 'ready';

  const toggleParent = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** 「开始补这个」：复用专项练习开练端点，成功后走既有作答页交接。 */
  const startPractice = async (kpId: number) => {
    if (practiceCount == null || starting) return;
    setStarting(true);
    setStartNotice(null);
    try {
      const res = await startTargetedPractice({
        subjectId: MATH_SUBJECT_ID,
        kpId,
        // 不限题型：薄弱点补漏不该被题型卡住
        type: null,
        count: practiceCount,
      });
      if (res.questions.length === 0) {
        // 空题单非错误：留在本页提示，学生可换知识点
        setStartNotice('暂时抽不到这个知识点的题，换一个试试');
        return;
      }
      const handoff: TargetedRunHandoff = { sessionId: res.sessionId, questions: res.questions };
      sessionStorage.setItem(TARGETED_SESSION_KEY, JSON.stringify(handoff));
      navigate('/student/training/targeted/run');
    } catch (err) {
      setStartNotice(err instanceof Error ? err.message : '开练失败，请重试');
    } finally {
      setStarting(false);
    }
  };

  const goErrors = (kpId?: number) => {
    navigate(kpId == null ? '/student/training/errors' : `/student/training/errors?kpId=${kpId}`);
  };

  return (
    <div
      data-theme="student-day"
      className="min-h-screen flex flex-col items-center p-4"
      style={{ backgroundColor: 'var(--bg-page)' }}
    >
      <div className="w-full max-w-5xl px-4 sm:px-8 py-8">
        <PageHeader
          to="/student/training/home"
          caption="返回训练"
          title="薄弱点图谱 · 数学"
          titleClassName="text-3xl font-extrabold"
        />

        {/* 推荐条：recFailed 时整条不渲染 */}
        {!recFailed && (
          <div className="mt-6">
            {rec == null ? (
              <Skeleton height={72} />
            ) : rec.recommendation ? (
              <Card className="flex flex-wrap items-center gap-4 border border-[var(--learn-card-border)] bg-[var(--learn-card-bg)]">
                <div className="min-w-0 flex-1">
                  <div className="text-lg font-bold text-[var(--text-primary)]">
                    最该补：{rec.recommendation.name}
                  </div>
                  <div className="mt-1 text-sm text-[var(--text-secondary)]">
                    掌握度 {percent(rec.recommendation.masteryScore)} · 样本 {rec.recommendation.sampleSize} 题
                    · 可抽 {rec.recommendation.availableQuestionCount} 题
                  </div>
                </div>
                <div className="flex gap-3">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => goErrors(rec.recommendation!.knowledgePointId)}
                  >
                    看这个知识点的错题
                  </Button>
                  <PracticeAction
                    state={practiceState}
                    starting={starting}
                    onStart={() => void startPractice(rec.recommendation!.knowledgePointId)}
                    onRetry={retryTiers}
                  />
                </div>
              </Card>
            ) : (
              <Card className="flex flex-wrap items-center gap-4 border border-[var(--learn-card-border)] bg-[var(--learn-card-bg)]">
                <div className="min-w-0 flex-1">
                  <div className="text-lg font-bold text-[var(--text-primary)]">
                    还没有足够的数据来判断你的薄弱点
                  </div>
                  <div className="mt-1 text-sm text-[var(--text-secondary)]">
                    先做一次练习或考试，我们就能给你诊断。
                  </div>
                </div>
                <div className="flex gap-3">
                  <Button variant="secondary" size="sm" onClick={() => navigate('/student/training/targeted')}>
                    去专项练习
                  </Button>
                  <Button variant="primary" size="sm" onClick={() => navigate('/student/training/exam')}>
                    去考试
                  </Button>
                </div>
              </Card>
            )}
          </div>
        )}

        {startNotice && (
          <div className="mt-4 text-sm text-[var(--text-secondary)]" role="status">
            {startNotice}
          </div>
        )}

        {/* 主体：lg 两栏；窄屏详情降级为底部抽屉（同一个 DOM 节点，靠 class 切换） */}
        {masteryError ? (
          <div className="mt-12 flex flex-col items-center gap-4">
            <p className="text-[var(--text-secondary)]">图谱加载失败</p>
            <Button variant="primary" onClick={() => void loadMastery()}>
              重试
            </Button>
          </div>
        ) : mastery == null ? (
          <div className="mt-8 grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="space-y-3">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} height={52} />
              ))}
            </div>
            <Skeleton height={200} />
          </div>
        ) : (
          <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
            {/* 左：一级折叠树 */}
            <div className="space-y-2" aria-label="知识点树">
              {parents.map((parent) => {
                const children = childrenOf(parent.id);
                const summary = summarizeParent(children);
                const isOpen = expanded.has(parent.id);
                return (
                  <div key={parent.id}>
                    <button
                      type="button"
                      onClick={() => toggleParent(parent.id)}
                      aria-expanded={isOpen}
                      className="w-full flex items-center gap-3 rounded-[var(--radius-card)] border border-[var(--learn-card-border)] bg-[var(--learn-card-bg)] px-4 py-3 text-left transition-colors hover:bg-[var(--bg-subtle)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-100)]"
                    >
                      <span className="text-[var(--text-tertiary)]">
                        <ChevronIcon expanded={isOpen} />
                      </span>
                      <span
                        className="w-3 h-3 rounded-full shrink-0"
                        style={
                          summary.weakestLevel == null
                            ? { background: 'var(--bg-subtle)' }
                            : { background: heatForNode({ confidence: 'ok', level: summary.weakestLevel }).background }
                        }
                        aria-hidden="true"
                      />
                      <span className="flex-1 font-semibold text-[var(--text-primary)]">{parent.name}</span>
                      <span className="text-sm text-[var(--text-secondary)]">
                        {summary.weakestLevel == null ? '未开始' : `${summary.pendingCount} 个待补`}
                      </span>
                    </button>

                    {isOpen && (
                      <div className="mt-2 flex flex-wrap gap-2 pl-8">
                        {children.map((child) => {
                          const style = heatForNode(child);
                          return (
                            <button
                              key={child.id}
                              type="button"
                              onClick={() => setSelectedKpId(child.id)}
                              className={clsx(
                                'rounded-[var(--radius-button)] px-3 py-2 text-sm font-medium transition-opacity hover:opacity-80 focus:outline-none focus:ring-2 focus:ring-[var(--brand-100)]',
                                isDashedBorder(child.confidence) && 'border border-dashed border-[var(--text-tertiary)]',
                              )}
                              style={style}
                            >
                              {child.name}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* 右：详情栏。未选中 → 提示（窄屏隐藏）；选中 → 详情（窄屏为底部抽屉） */}
            <aside
              className={clsx(
                'rounded-[var(--radius-card)] border border-[var(--learn-card-border)] bg-[var(--learn-card-bg)] p-4',
                selected == null
                  ? 'hidden lg:block'
                  : 'fixed inset-x-0 bottom-0 z-20 max-h-[70vh] overflow-y-auto rounded-b-none lg:static lg:max-h-none lg:rounded-b-[var(--radius-card)]',
              )}
              aria-label="知识点详情"
            >
              {selected == null ? (
                <p className="text-sm text-[var(--text-tertiary)]">点左侧知识点看详情</p>
              ) : (
                <KpDetail
                  node={selected}
                  practiceState={practiceState}
                  starting={starting}
                  onStart={() => void startPractice(selected.id)}
                  onRetry={retryTiers}
                  onViewErrors={() => goErrors(selected.id)}
                />
              )}
            </aside>
          </div>
        )}

        {/* 页脚：覆盖口径 + 未标注错题（为 0 时不渲染后半句） */}
        {mastery && (
          <footer className="mt-8 border-t border-[var(--bg-subtle)] pt-4 text-sm text-[var(--text-tertiary)]">
            <p>
              知识点覆盖 {mastery.coverage.coveredQuestions} / {mastery.coverage.totalQuestions} 道题
            </p>
            {mastery.coverage.uncoveredUnclearedErrors > 0 && (
              <p className="mt-1 flex items-center gap-2">
                另有 {mastery.coverage.uncoveredUnclearedErrors} 道未标注知识点的题，不计入上图
                <Button variant="secondary" size="sm" onClick={() => goErrors()}>
                  去错题页看
                </Button>
              </p>
            )}
          </footer>
        )}
      </div>
    </div>
  );
}

/** 详情栏内容：掌握度条 / 对错数 / 最近作答 / 可信度说明 + 两个动作。 */
function KpDetail({
  node,
  practiceState,
  starting,
  onStart,
  onRetry,
  onViewErrors,
}: {
  node: KnowledgeGraphNode;
  practiceState: PracticeActionState;
  starting: boolean;
  onStart: () => void;
  onRetry: () => void;
  onViewErrors: () => void;
}) {
  return (
    <div className="space-y-3">
      <h2 className="text-lg font-bold text-[var(--text-primary)]">{node.name}</h2>

      {node.confidence === 'none' ? (
        <p className="text-sm text-[var(--text-secondary)]">未开始</p>
      ) : (
        <>
          <div className="text-sm text-[var(--text-secondary)]">
            掌握度 {percent(node.masteryScore ?? 0)}
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--bg-subtle)]">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.round((node.masteryScore ?? 0) * 100)}%`,
                background: heatForNode(node).background,
              }}
            />
          </div>
          <div className="text-sm text-[var(--text-secondary)]">
            对 {node.correctCount} 错 {node.errorCount}
          </div>
          <div className="text-sm text-[var(--text-secondary)]">
            样本 {node.sampleSize} 题
            {node.confidence === 'insufficient' && '（样本不足（<5 题），暂不判定强弱）'}
          </div>
          {node.lastSeenAt && (
            <div className="text-sm text-[var(--text-tertiary)]">
              最近作答 {node.lastSeenAt.slice(0, 10)}
            </div>
          )}
        </>
      )}

      <div className="text-sm text-[var(--text-tertiary)]">
        可抽 {node.availableQuestionCount} 题
      </div>

      <div className="flex flex-col gap-2 pt-1">
        <Button variant="secondary" size="sm" onClick={onViewErrors}>
          看这个知识点的错题
        </Button>
        <PracticeAction state={practiceState} starting={starting} onStart={onStart} onRetry={onRetry} />
      </div>
    </div>
  );
}

/** 「开始补这个」的界面状态。 */
type PracticeActionState = 'loading' | 'failed' | 'unavailable' | 'ready';

/**
 * 「开始补这个」的四种界面状态——**不用文案解释，靠控件本身表达**：
 * - `loading`：档位加载中 → 按钮 loading（转圈），学生看得出在跑，不是坏了
 * - `failed`：档位加载失败 → 换成**「重试」按钮**（可操作控件，不是说明文字）
 * - `unavailable`：家长停用了全部档位 → **不渲染**（不提供点不动的死按钮，只留「看错题」）
 * - `ready`：正常可点
 */
function PracticeAction({
  state,
  starting,
  onStart,
  onRetry,
}: {
  state: PracticeActionState;
  starting: boolean;
  onStart: () => void;
  onRetry: () => void;
}) {
  if (state === 'unavailable') return null;
  if (state === 'failed') {
    return (
      <Button variant="secondary" size="sm" onClick={onRetry}>
        重试
      </Button>
    );
  }
  return (
    <Button
      variant="primary"
      size="sm"
      loading={state === 'loading'}
      disabled={state !== 'ready' || starting}
      onClick={onStart}
    >
      开始补这个
    </Button>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/pages/student/training/WeakPointGraphPage.test.tsx`
Expected: PASS（22 用例全绿：折叠树 3 + 详情栏 4 + 推荐条 6 + **档位状态 3** + confidence 三态 2 + 页脚与错误态 4）

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/pages/student/training/WeakPointGraphPage.tsx \
        apps/web/src/pages/student/training/WeakPointGraphPage.test.tsx
git commit -m "feat(web): 薄弱点图谱页——折叠树 + 右栏详情（窄屏抽屉）+ 推荐两态"
```

---

## Task 8: 路由注册 + 训练页第 4 张卡

**Files:**
- Modify: `apps/web/src/routes/routeTable.tsx`
- Modify: `apps/web/src/pages/student/training/TrainingHomePage.tsx`
- Test: `apps/web/src/pages/student/training/TrainingHomePage.test.tsx`（追加）
- Test: `apps/web/src/routes/routeTable.test.tsx`（追加；「路由确实指到页面」的唯一证明）

**Interfaces:**
- Consumes: Task 7 的 `WeakPointGraphPage`
- Produces: 路由 `/student/training/weak-points`；四卡网格

- [ ] **Step 1: 写失败的测试（追加到 `TrainingHomePage.test.tsx` 末尾）**

先在该文件顶部的 `createMemoryRouter` 路由数组里补一个桩（否则点击会报无匹配路由）：

```tsx
      { path: '/student/training/weak-points', element: <div>薄弱点图谱页桩</div> },
```

再追加用例：

```tsx
describe('TrainingHomePage 薄弱点图谱入口（第 4 张卡）', () => {
  it('渲染第 4 张卡「薄弱点图谱」', async () => {
    getRemediationOverview.mockResolvedValue({ active: false, setId: 0, groupCount: 0, itemCount: 0, correctCount: 0 });

    await renderSettled();

    expect(screen.getByText('薄弱点图谱')).toBeInTheDocument();
  });

  it('点第 4 张卡跳 /student/training/weak-points', async () => {
    getRemediationOverview.mockResolvedValue({ active: false, setId: 0, groupCount: 0, itemCount: 0, correctCount: 0 });

    const { router } = await renderSettled();
    fireEvent.click(screen.getByRole('button', { name: '进入薄弱点图谱' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/student/training/weak-points'));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/student/training/TrainingHomePage.test.tsx`
Expected: FAIL —— `Unable to find an element with the text: 薄弱点图谱`

- [ ] **Step 3: 改 `TrainingHomePage` 为四卡**

在 `TrainingHomePage.tsx` 的 `RedoIcon` 之后加第 4 个图标：

```tsx
/** 薄弱点图谱：节点连线。 */
const GraphIcon = ({ className = 'w-8 h-8' }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <circle cx="12" cy="5" r="2.5" />
    <circle cx="5" cy="18" r="2.5" />
    <circle cx="19" cy="18" r="2.5" />
    <path d="M10.8 7.2 6.2 15.8" />
    <path d="M13.2 7.2 17.8 15.8" />
  </svg>
);
```

把容器宽度改宽（4 卡不压扁）：

```tsx
      <div className="w-full max-w-5xl px-4 sm:px-8">
```

把网格断点改为两列 → 四列：

```tsx
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mt-12">
```

在错题练习那张卡之后（`</button>` 与 `</div>` 之间）加第 4 张卡：

```tsx
          {/* 薄弱点图谱（第 4 张卡，2026-09-23）：纯导航，无状态徽标 */}
          <button
            onClick={() => navigate('/student/training/weak-points')}
            className="h-64 rounded-3xl bg-white p-8 flex flex-col items-center justify-center gap-4 transition-all duration-300 hover:-translate-y-1 focus:outline-none focus:ring-4 focus:ring-[var(--brand-500)]/20"
            style={{
              border: '1px solid rgba(226, 232, 240, 0.8)',
              boxShadow: 'var(--shadow-card)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.boxShadow = 'var(--shadow-elevated)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.boxShadow = 'var(--shadow-card)';
            }}
            aria-label="进入薄弱点图谱"
          >
            <div
              className="w-20 h-20 rounded-2xl flex items-center justify-center text-white shadow-sm"
              style={{
                background: 'linear-gradient(to top right, #FF6B35, #FFB25A)',
              }}
              aria-hidden="true"
            >
              <GraphIcon />
            </div>
            <span className="text-3xl font-black tracking-tight text-[var(--text-primary)]">
              薄弱点图谱
            </span>
          </button>
```

同时更新页面顶部注释里的「训练三卡选择页」为「训练四卡选择页（PRD §6.3 三类训练 + 薄弱点图谱）」。

- [ ] **Step 4: 注册路由**

在 `apps/web/src/routes/routeTable.tsx` 顶部 import 区（`TargetedRunPage` 之后）加：

```tsx
import WeakPointGraphPage from '@/pages/student/training/WeakPointGraphPage';
```

在 `remediation/run` 那条路由之后加：

```tsx
  // 薄弱点图谱（2026-09-23）：全屏沉浸层，训练轨第 4 张卡；两个只读端点
  {
    path: '/student/training/weak-points',
    element: (
      <RequireRole role="student">
        <WeakPointGraphPage />
      </RequireRole>
    ),
  },
```

- [ ] **Step 4b: 补 routeTable 级集成钉子（`apps/web/src/routes/routeTable.test.tsx`）**

**为什么必须补**：Task 7 的页面测试挂的是**页面本身**、Step 1 的卡片测试给这条路径挂了**桩** —— 两处都绕过了真路由表，所以「路由确实指到 `WeakPointGraphPage`」**没有任何测试证明**：`path` 写错一个字符，卡片照样 `navigate`，落到 React Router 的无匹配路由，而**所有测试依旧全绿**。本仓对此有先例与自述理由（同文件的 `describe('路由表：补偿套题作答页')`：*「页面自己有组件测试，但那个测试挂的是页面本身、绕过了路由表——『路由确实指到这个页面』只有这里能证明」*）。

先在该文件的 `vi.mock('@/services/api', ...)` 返回对象里补两个（页面挂载即拉这两个只读端点，档位也走它）：

```tsx
    // `/student/training/weak-points`（薄弱点图谱页新页）：挂载即拉掌握度 + 推荐，并拉档位
    getKnowledgeGraphMastery: vi.fn(),
    getWeakPoints: vi.fn(),
    getMyPointRules: vi.fn(),
```

在顶部 `@/services/api` 的 import 清单里补 `getKnowledgeGraphMastery`、`getWeakPoints`、`getMyPointRules`，并加：

```tsx
const getKnowledgeGraphMasteryMock = vi.mocked(getKnowledgeGraphMastery);
const getWeakPointsMock = vi.mocked(getWeakPoints);
const getMyPointRulesMock = vi.mocked(getMyPointRules);
```

在 `beforeEach` 里补 reset + 默认返回（档位给一个可用档，避免页面停在「重试」态）：

```tsx
  getKnowledgeGraphMasteryMock.mockReset();
  getWeakPointsMock.mockReset();
  getMyPointRulesMock.mockReset();
  getMyPointRulesMock.mockResolvedValue({
    tasks: [{ taskCode: 'math_targeted', taskName: '数学专项', tiers: [{ tierKey: '3' }] }],
  });
```

再在文件末尾追加：

```tsx
/**
 * 薄弱点图谱页（2026-09-23 批）：`/student/training/weak-points` 是新页，从零加进路由表。
 *
 * 页面自己有组件测试，但那个测试挂的是**页面本身**、绕过了路由表；
 * TrainingHomePage 的卡片测试又给这条路径挂了**桩** —— 两处都证明不了「路由确实指到这个页面」。
 * 路径写错一个字符，卡片仍会 navigate、落到无匹配路由，而所有测试依旧全绿。只有这里能证明。
 */
describe('路由表：薄弱点图谱页', () => {
  it('/student/training/weak-points 渲染 WeakPointGraphPage（数据来自接口），而非无匹配路由', async () => {
    setStudentSession();
    getKnowledgeGraphMasteryMock.mockResolvedValue({
      subjectId: 1,
      nodes: [
        { id: 1, name: '数与式', parentId: null, masteryScore: null, level: null, correctCount: null, errorCount: null, lastSeenAt: null, sampleSize: 0, confidence: 'none', availableQuestionCount: 0 },
      ],
      coverage: { coveredQuestions: 0, totalQuestions: 0, uncoveredUnclearedErrors: 0 },
    });
    getWeakPointsMock.mockResolvedValue({
      subjectId: 1,
      candidates: [],
      recommendation: null,
      reason: 'no_qualified_candidate',
    });

    renderAt('/student/training/weak-points');

    // 真页面内容：一级知识点来自 getKnowledgeGraphMastery（无匹配路由 / 占位页都渲染不出它）
    expect(await screen.findByText('数与式')).toBeInTheDocument();
    expect(getKnowledgeGraphMasteryMock).toHaveBeenCalled();
  });

  it('无 token 访问 /student/training/weak-points → 回登录页，不拉数据', async () => {
    localStorage.clear();

    renderAt('/student/training/weak-points');

    expect(await screen.findByRole('heading', { name: '智学系统' })).toBeInTheDocument();
    expect(getKnowledgeGraphMasteryMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/pages/student/training/TrainingHomePage.test.tsx src/routes/routeTable.test.tsx`
Expected: PASS（TrainingHomePage 原 6 用例 + 新 2 用例；routeTable 原有用例 + 新 2 用例，全绿）

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/routes/routeTable.tsx \
        apps/web/src/routes/routeTable.test.tsx \
        apps/web/src/pages/student/training/TrainingHomePage.tsx \
        apps/web/src/pages/student/training/TrainingHomePage.test.tsx
git commit -m "feat(web): 训练页四卡 + 薄弱点图谱路由注册（含 routeTable 级映射钉子）"
```

---

## Task 9: 错题页支持 `?kpId=` 预填

**Files:**
- Modify: `apps/web/src/pages/student/training/ErrorPracticePage.tsx`
- Test: `apps/web/src/pages/student/training/ErrorPracticePage.test.tsx`（新建；该文件当前不存在）

**Interfaces:**
- Consumes: 无
- Produces: `/student/training/errors?kpId=<id>` 打开时筛选下拉预填该知识点并**立即按它查询**

**为什么必须改：** spec §6.3 说「学生端错题页已支持按知识点过滤 → 直接带上即可」。**实测这句话只对了一半**：`GET /api/training/error-book` 确实收 `kpId`（`training.controller.ts:39`），但 `ErrorPracticePage` 的 `kpId` 是纯内部 `useState('')`（`ErrorPracticePage.tsx:79`），**不读 URL 参数**。不改这里，「看这个知识点的错题」跳过去只会看到全部错题。

- [ ] **Step 1: 写失败的测试**

创建 `apps/web/src/pages/student/training/ErrorPracticePage.test.tsx`：

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import ErrorPracticePage from './ErrorPracticePage';

/**
 * 错题页 `?kpId=` 预填（2026-09-23）：薄弱点图谱的「看这个知识点的错题」依赖它。
 * 钉住：带参数时下拉预填 + **首屏就按该 kpId 查询**（不是等用户点「查询」）。
 *
 * vitest globals:false —— 必须显式 import + 自己写 afterEach(cleanup)。
 */

const getTrainingErrorBook = vi.hoisted(() => vi.fn());
const getKnowledgePoints = vi.hoisted(() => vi.fn());

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, getTrainingErrorBook, getKnowledgePoints };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  getTrainingErrorBook.mockReset();
  getKnowledgePoints.mockReset();
  getTrainingErrorBook.mockResolvedValue([]);
  getKnowledgePoints.mockResolvedValue([
    { id: 1, name: '数与式', parentKpId: null, gradeBand: 'junior' },
    { id: 11, name: '有理数', parentKpId: 1, gradeBand: 'junior' },
  ]);
});

function renderAt(path: string) {
  const router = createMemoryRouter(
    [{ path: '/student/training/errors', element: <ErrorPracticePage /> }],
    { initialEntries: [path] },
  );
  return render(<RouterProvider router={router} />);
}

describe('ErrorPracticePage ?kpId= 预填', () => {
  it('带 kpId 时首屏查询就带上该 kpId', async () => {
    renderAt('/student/training/errors?kpId=11');

    await waitFor(() =>
      expect(getTrainingErrorBook).toHaveBeenCalledWith(
        expect.objectContaining({ kpId: 11 }),
      ),
    );
  });

  it('带 kpId 时筛选下拉预填为「数与式 / 有理数」', async () => {
    renderAt('/student/training/errors?kpId=11');

    // 该 select 既有的可访问名就是「专项筛选」（ErrorPracticePage.tsx:215），别改它
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '专项筛选' })).toHaveValue('11'),
    );
  });

  it('不带 kpId 时按 undefined 查询（向后兼容）', async () => {
    renderAt('/student/training/errors');

    await waitFor(() =>
      expect(getTrainingErrorBook).toHaveBeenCalledWith(
        expect.objectContaining({ kpId: undefined }),
      ),
    );
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/student/training/ErrorPracticePage.test.tsx`
Expected: FAIL —— 第一条用例得到 `kpId: undefined`（URL 参数被忽略）

- [ ] **Step 3: 让页面读 URL 参数**

在 `ErrorPracticePage.tsx` 顶部 import 加 `useSearchParams`：

```tsx
import { useNavigate, useSearchParams } from 'react-router-dom';
```

把 `kpId` 的初始化改为从 URL 读（其余筛选保持空）：

```tsx
  // 筛选条件。kpId 支持从 URL 预填（薄弱点图谱「看这个知识点的错题」跳进来时带 ?kpId=）——
  // 用 useState 惰性初始化，mount 时的 load() 就会带上它，不需要额外的同步 effect。
  const [searchParams] = useSearchParams();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [type, setType] = useState('');
  const [kpId, setKpId] = useState(() => searchParams.get('kpId') ?? '');
```

**不要改那个 `<select>` 的 `aria-label`**——它已经是 `aria-label="专项筛选"`（`ErrorPracticePage.tsx:215`），改掉会破坏既有测试与读屏文案。本任务只加 `useSearchParams` + 惰性初始化两处。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/pages/student/training/ErrorPracticePage.test.tsx`
Expected: PASS（3 用例全绿）

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/pages/student/training/ErrorPracticePage.tsx \
        apps/web/src/pages/student/training/ErrorPracticePage.test.tsx
git commit -m "feat(web): 错题页支持 ?kpId= 预填（图谱「看这个知识点的错题」依赖）"
```

---

## Task 10: 文档同步

**Files:**
- Modify: `docs/API接口与数据流设计文档.md`（§4.5 + 版本号）
- Modify: `docs/api/openapi.yaml`
- Modify: `docs/UX-UI设计文档.md`
- Modify: `docs/K12智学系统-产品需求文档.md`（§7.4 / §7.6）
- Modify: `CLAUDE.md`
- Modify: `docs/ai-core-changelog.md`

**为什么是硬要求：** CLAUDE.md「API 文档同步规则」——两份文档**必须始终一致**，任何一方变更时另一方必须同步（路径、方法、参数、响应结构）。且 API 设计文档是主稿。

- [ ] **Step 1: 改 API 设计文档 §4.5**

把 `docs/API接口与数据流设计文档.md` 第 204-212 行的表格替换为：

```markdown
### 4.5 Knowledge Graph — `/api/knowledge-graph`

**仅数学**（`subjectId=1`；语文/英语无知识点体系）。全部为**只读**端点，`studentId` 必须等于 JWT 的 `sub`（不符 403 / code 1005），`subjectId` 非 1 一律 400 / code 1001。

| 方法 | 路径 | 说明 | 阶段 |
|---|---|---|---|
| GET | `/api/knowledge-graph/knowledge-points/{id}/relations` | 知识点前置/包含关系（`knowledge_relations` 表零数据，**降级 P1**） | P1 |
| GET | `/api/knowledge-graph/students/{studentId}/mastery` | 学生知识点掌握度 overlay：全树 + 掌握度，`?subjectId=1` | MVP |
| GET | `/api/knowledge-graph/students/{studentId}/weak-points` | 薄弱点候选 + 一条推荐，`?subjectId=1&limit=1`（limit 1–10） | MVP |
| GET | `/api/knowledge-graph/students/{studentId}/learning-path` | 基于薄弱点的建议复习路径 | P1 |

**`mastery` 返回**：`{ subjectId, nodes[], coverage }`。`nodes[]` 每项含 `id / name / parentId / masteryScore / level / correctCount / errorCount / lastSeenAt / sampleSize / confidence / availableQuestionCount`。

- `masteryScore` 为 **`null` 表示从未作答**（**不是 0**——0 是「很弱」，语义相反）。
- `confidence` 由后端算好下发（`none` 从未作答 / `insufficient` 样本 < 5 / `ok` 可下结论），**前端不重算阈值**（`MIN_SAMPLE_SIZE = 5` 是唯一真源）。
- `availableQuestionCount` 谓词与专项抽题同源：`is_active=1 AND answer <> '' AND` 排除该生「不再展示」。
- `coverage` = `{ coveredQuestions, totalQuestions, uncoveredUnclearedErrors }`，**均为数学口径**。

**`weak-points` 返回**：`{ subjectId, candidates[], recommendation, reason }`。

- 候选资格（三条同时满足）：① 有该生掌握度行 ② `sampleSize >= 5` ③ `availableQuestionCount > 0`。
- 排序：`mastery_score ASC, error_count DESC, knowledge_point_id ASC`。
- `recommendation = candidates[0] ?? null`；**无候选仍返回 200**（`reason='no_qualified_candidate'`），前端据此转引导态——**不是错误**。
```

- [ ] **Step 2: 改 API 设计文档版本号**

把第 3 行 `> 版本：v4.9` 改为 `> 版本：v4.10`。

- [ ] **Step 3: 改 openapi.yaml 的两个端点与 schema**

把 `docs/api/openapi.yaml` 中 `/knowledge-graph/students/{studentId}/mastery` 与 `/knowledge-graph/students/{studentId}/weak-points` 两段（约 897-950 行）替换为：

```yaml
  /knowledge-graph/students/{studentId}/mastery:
    get:
      tags: [KnowledgeGraph]
      summary: 学生知识点掌握度 overlay（仅数学）
      operationId: getMastery
      parameters:
        - name: studentId
          in: path
          required: true
          schema:
            type: integer
        - name: subjectId
          in: query
          required: true
          description: 本期仅支持 1（数学）；其它值 400
          schema:
            type: integer
            enum: [1]
      responses:
        '200':
          description: 全树 + 掌握度 overlay
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/CommonResponse'
                  - type: object
                    properties:
                      data:
                        $ref: '#/components/schemas/KnowledgeGraphMastery'
        '403':
          description: studentId 非本人（code 1005）
  /knowledge-graph/students/{studentId}/weak-points:
    get:
      tags: [KnowledgeGraph]
      summary: 薄弱点候选 + 一条推荐（仅数学）
      operationId: getWeakPoints
      parameters:
        - name: studentId
          in: path
          required: true
          schema:
            type: integer
        - name: subjectId
          in: query
          required: true
          description: 本期仅支持 1（数学）；其它值 400
          schema:
            type: integer
            enum: [1]
        - name: limit
          in: query
          required: false
          description: 默认 1，范围 1-10
          schema:
            type: integer
            minimum: 1
            maximum: 10
            default: 1
      responses:
        '200':
          description: 候选与推荐；无候选时 recommendation 为 null（仍 200）
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/CommonResponse'
                  - type: object
                    properties:
                      data:
                        $ref: '#/components/schemas/WeakPointRecommendation'
        '403':
          description: studentId 非本人（code 1005）
```

把 components 里的 `KnowledgeMastery` 与 `WeakPoint` 两个 schema（约 6812-6834 行）替换为（`KnowledgeRelation` 保留原样，`relations` 端点降级 P1 但 schema 先留着）：

```yaml
    KnowledgeGraphNode:
      type: object
      properties:
        id:
          type: integer
        name:
          type: string
        parentId:
          type: integer
          nullable: true
          description: null = 一级知识点
        masteryScore:
          type: number
          nullable: true
          description: null = 从未作答（不是 0）
        level:
          type: integer
          nullable: true
        correctCount:
          type: integer
          nullable: true
        errorCount:
          type: integer
          nullable: true
        lastSeenAt:
          type: string
          format: date-time
          nullable: true
        sampleSize:
          type: integer
          description: correct + error；未作答 = 0
        confidence:
          type: string
          enum: [none, insufficient, ok]
        availableQuestionCount:
          type: integer

    KnowledgeGraphMastery:
      type: object
      properties:
        subjectId:
          type: integer
        nodes:
          type: array
          items:
            $ref: '#/components/schemas/KnowledgeGraphNode'
        coverage:
          type: object
          properties:
            coveredQuestions:
              type: integer
            totalQuestions:
              type: integer
            uncoveredUnclearedErrors:
              type: integer

    WeakPointCandidate:
      type: object
      properties:
        knowledgePointId:
          type: integer
        name:
          type: string
        parentId:
          type: integer
          nullable: true
        masteryScore:
          type: number
        level:
          type: integer
        correctCount:
          type: integer
        errorCount:
          type: integer
        sampleSize:
          type: integer
        availableQuestionCount:
          type: integer
        lastSeenAt:
          type: string
          format: date-time
          nullable: true

    WeakPointRecommendation:
      type: object
      properties:
        subjectId:
          type: integer
        candidates:
          type: array
          items:
            $ref: '#/components/schemas/WeakPointCandidate'
        recommendation:
          allOf:
            - $ref: '#/components/schemas/WeakPointCandidate'
          nullable: true
        reason:
          type: string
          enum: [ok, no_qualified_candidate]
```

- [ ] **Step 3b: 从 openapi 移除 P1 的 `relations`（用户裁决，CLAUDE.md 规则 3）**

⚠️ **原文勘误（Task 10 评审标为 Important，用户裁决「按 CLAUDE.md 规则移除」）**：Step 3 原写「`relations` 端点降级 P1 但 schema 先留着」，**与 CLAUDE.md 规则 3「openapi.yaml 只收 MVP 端点；P1/P2 在 API 文档里标阶段」冲突**。证据：同一张 §4.5 表里 P1 的 `learning-path` 被正确排除在 openapi 之外，而 P1 的 `relations` 却在 —— openapi 自己对「P1 该不该收」自相矛盾（且这处不一致是本次提交新造的：改前两边都是 MVP）。

**做法**：
1. 删掉 `docs/api/openapi.yaml` 里 `/knowledge-graph/knowledge-points/{id}/relations` 的**整个路径块**。
2. 删掉 components 里的 **`KnowledgeRelation`** schema —— 先 `grep -n "KnowledgeRelation" docs/api/openapi.yaml` 确认除该 schema 定义与其 `$ref` 外**无其它引用**，有引用就停下报告。
3. `docs/API接口与数据流设计文档.md` §4.5 的 `relations` 行**保持 P1 不动**（主稿是阶段真源）。

- [ ] **Step 3c: 给两个端点补 `'400'` 响应（用户裁决）**

⚠️ 评审 Minor（用户裁决「补上」）：主稿 §4.5 明写「`subjectId` 非 1 一律 400 / code 1001」，但 openapi 两个端点都**没有 `'400'` 响应**，而 CLAUDE.md 规则 1 把「响应结构」列为必须同步的字段（实现确实返回 400，已由 `knowledge-graph.controller.test.ts` 钉住）。

给 `mastery` 与 `weak-points` 两条各补一条，紧挨既有的 `'403'`：

```yaml
        '400':
          description: subjectId 非 1（code 1001）
```

- [ ] **Step 4: 校验 openapi 可解析 + 端点清单对齐**

⚠️ **原文勘误（我预检核实，两处）**：① 原命令 `cd /Users/lichao/Downloads/claude/imooc/ai_k12` 指向**父仓库**，读到的会是未改动的 `openapi.yaml`（假通过）——必须在工作树内执行；② 原命令用 `require('js-yaml')`，但本仓**无根 `package.json`**，js-yaml 无法解析。`python3` 的 PyYAML 可用（已实测 6.0.2）。

Run（在工作树根执行）:
```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/.codebuddy/worktrees/math-weakpoint-graph && python3 -c "
import yaml
d = yaml.safe_load(open('docs/api/openapi.yaml'))
kg = [p for p in d['paths'] if 'knowledge-graph' in p]
print(len(kg))
print('\n'.join(kg))
"
```
Expected: 先打印 **2**，再是 `/knowledge-graph/students/{studentId}/mastery` 与 `/knowledge-graph/students/{studentId}/weak-points`（Step 3b 移除 `relations` 后由 3 变 2），且无 YAML 解析异常。

再人工核对（CLAUDE.md 检查清单第 4 条）：API 文档 §4.5 表格的 **4** 条路径里，**2 条 MVP** 必须与 openapi 的 `paths` 键**逐字对上**（除 `/api` 前缀）；**2 条 P1**（`relations` / `learning-path`）**按规则 3 只存在于主稿**——这个不对称是**预期且正确**的。

- [ ] **Step 5: 改 UX 文档**

⚠️ **原文勘误（我预检核实）**：本节原写「在训练轨页面清单里新增一行（与既有 `/student/training/errors` 等条目同格式）」——**该清单不存在**。`docs/UX-UI设计文档.md` 里没有任何 `| \`/student/training…` 表格行；§5.0 页面总览表只覆盖 P1.x–P7.x，且 §5.7 开头明确写着「训练轨页面此前**从未进入本文档**…其余训练轨页面待后续单独立项补齐」。

**正确做法**：仿照 §5.7（`### 5.7 训练轨：错题补偿套题（相似题专项，2026-09-21）`，该轨首个详细规范）的体例，**在 §5.7 之后、`---` 与 `## 6. 交互规范` 之前**新增一个平级小节：

```markdown
### 5.8 训练轨：薄弱点图谱（数学，2026-09-23）

> 训练轨页面一律**全屏、写死 `data-theme="student-day"`、不在任何 Layout 下**（既有规则）。仅数学（语文/英语无知识点体系）。

#### 页面 `/student/training/weak-points`
- **入口**：训练首页第 4 张卡（四卡：专项练习 / 真题考试 / 错题练习 / 薄弱点图谱）。
- **布局**：顶部 `PageHeader`（回训练首页、标题「薄弱点图谱 · 数学」）；下方推荐条；主体 `lg` 起两栏——左为**一级折叠树（默认全收起）**、右为详情栏（**窄屏降级为底部抽屉**，同一 DOM 节点切 class）；底部页脚给覆盖口径。
- **推荐条三态**：有候选 →「最该补：X」+ 掌握度/样本/可抽题数 + 两个动作；无候选 → 引导文案 +「去专项练习」/「去考试」；**拉取失败 → 整条不渲染**（图谱仍可用，一栏坏掉不拖垮另一栏）。
- **两个动作**：「开始补这个」按「≥3 的最小可用档」开练并跳作答页；「看这个知识点的错题」跳 `/student/training/errors?kpId=<id>`（该页据此预填筛选并**首屏即按它查询**）。
- **树与详情**：点一级展开/收起二级；点二级 chip 在详情栏出对错数、样本可信度、最近作答与两个动作。

#### 约束
- **热力梯度**（`weak-point-heat.ts` 唯一实现）：色相固定 brand 橘红 `#ff6b35` 只调不透明度，**不得引入第二套配色**；一级汇总的「待补」阈值 `level <= 2` 是**纯展示口径**、不参与推荐算法。
- **`masteryScore: null` = 从未作答**，**不是 0**（0 是「很弱」，语义相反）——渲染为「未开始」灰显，**绝不显示 0%**。
- **`confidence` 三态**由后端算好下发（`none`/`insufficient`/`ok`），前端**不重算阈值**；`insufficient` 额外用虚线边与「有结论但浅」区分。
- **页脚必须给覆盖口径**（`covered/total` + 未标注错题数）：数学约 457 道 active 题里只有约 45% 带 KP 标注，不说明会让学生误读成「只有这些问题」。
- **无 emoji**；图标用线性 SVG。
```

并把 P2.8 成绩报告那处的薄弱点诊断明确标注「**未实现**」——在该小节 `#### P2.8 成绩报告` 的 `- **布局**：…` 行**之后**追加一行（本期只做训练轨入口；两处将来共用同一后端服务）：

```markdown
- **薄弱点诊断：未实现**（本期仅训练轨 `/student/training/weak-points`）。将来两处入口共用同一后端服务（`KnowledgeGraphService`）。
```

- [ ] **Step 6: 改 PRD（先确认再改）**

⚠️ CLAUDE.md：「PRD 覆盖任何设计决策；有冲突必须先与用户确认再实现」。在 §7.4（错题本节）与 §7.6（测评节）的「推荐」处各补一句指向本设计，**不改动原意**：

```markdown
> 落地说明：数学薄弱点推荐已实现于学生端训练轨「薄弱点图谱」（`/student/training/weak-points`），
> 口径为**掌握度**（`student_knowledge_mastery` 累计正确率），与家长端「薄弱点（错题数代理）」并存不替换。
> 详见 `docs/superpowers/specs/2026-09-23-math-weakpoint-graph-design.md`。
```

**若发现 PRD 原文与「仅数学 / 掌握度口径 / 一条推荐」有实质冲突，停下先问用户**，不要自行改 PRD 正文。

✅ **冲突条件已由我预检排除（不必再停）**：§7.4 第 175 行原文为「支持薄弱点图谱生成和针对性内容推荐。」（位于 §7.4 错题本与薄弱点诊断内）；§7.6 第 194 行原文为「测评后推荐薄弱点专项练习。」。两者都是**方向性表述**，与「仅数学 / 掌握度口径 / 一条推荐」**不冲突**（§7.6 的「推荐专项练习」正对应本页「开始补这个」的开练动作）。按上文「不改动原意、只补落地说明」执行即可。

- [ ] **Step 7: 改根 CLAUDE.md（体量纪律）**

在「家长端」小节之后新增一小节（只写仍生效的「勿动」，日期日志进 changelog）：

⚠️ **原文勘误（Task 10 评审标为 Minor，用户裁决「按体量纪律删重」）**：原稿有三处违反 CLAUDE.md 体量纪律——① 重复了主稿 §4.5 已写的**三道闸门 + 排序**；② 重复了 `subjectId=1`；③ 写了**实测数字**「数学 457 道 active 题里只有约 45% 带 KP 标注」（体量纪律明写实测数字进 changelog，且该数字会随题库增长失效）。以下为删重后的版本：

```markdown
## 数学薄弱点图谱（2026-09-23）

- **仅数学、两个端点只读**：不写库、不发分（发分仍归 `POST /api/training/targeted/start`）。端点与阶段见 API 文档 §4.5。
- **`masteryScore: null` = 从未作答**，**不是 0**（0 是「很弱」，语义相反）。前端渲染为「未开始」灰显，**绝不显示 0%**。
- **`confidence` 由后端算好下发**（`none`/`insufficient`/`ok`），`MIN_SAMPLE_SIZE = 5` 是**唯一真源**，前端不重算阈值。
- **无候选不是错误**：端点仍 200 + `recommendation: null`，前端据此转引导态——**不要改成 404/4xx**。
- **热力梯度唯一实现在 `weak-point-heat.ts`**：色相固定 brand 橘红只调不透明度，**不得引入第二套配色**；一级汇总的「待补」阈值 `level <= 2` 是**纯展示口径**、不参与推荐算法。
- **开练题量取「≥3 的最小可用档」**（`point-tiers.ts` 的 `pickPracticeCount`）。**档位状态一律走 `usePointTiers`**（与专项配置页同一实现）：加载中转圈、失败给重试控件、家长停用则不渲染开练按钮——**不加说明文案**，也不硬发请求（否则被 `targeted/start` 400 拒绝）。
- **页脚必须给覆盖口径**（`covered/total` + 未标注错题数）：不说明会让学生以为「只有这些问题」。
```

- [ ] **Step 8: 补 changelog**

在 `docs/ai-core-changelog.md` 顶部追加一条（与既有条目同格式）：

```markdown
## 2026-09-23 数学薄弱点图谱与推荐（学生端训练轨）

- 新增只读模块 `apps/server/src/modules/knowledge-graph/`，落地 API 文档 §4.5 的两个 MVP 端点；
  `relations` 端点**降级 P1**（`knowledge_relations` 表零数据，等于要先做一轮数据工程），
  并已按 CLAUDE.md 规则 3（openapi 只收 MVP）**从 `docs/api/openapi.yaml` 移除其路径与 `KnowledgeRelation` schema**。
- 实测数字（原写在 CLAUDE.md，按体量纪律移到此）：数学约 **457** 道 active 题里只有约 **45%** 带 KP 标注，
  故图谱页脚必须给覆盖口径，否则学生会误读成「只有这些问题」。该数字随题库增长会变，勿写回 CLAUDE.md。
- 新增 4 个只读仓储查询：可抽题数（按 KP 分组）、按学科掌握度行、按学科题库覆盖率、未标注知识点的未清零错题数。
  最后一条的「未标注」判定子句与家长端 `ParentInsightsRepository.countUncoveredUnclearedErrors`
  **共用 `apps/server/src/database/sql-fragments.ts` 的 `UNCOVERED_ERROR_PREDICATE`**
  （原计划是两边各写一份，Task 1 审查标为 plan-mandated 近重复 → 用户裁决抽共享片段消漂移）；
  外层过滤仍各自保留（家长端跨学科、本页仅数学），两处**不共享仓储实例**。
- 前端新增 `/student/training/weak-points`（训练轨第 4 张卡）+ `weak-point-heat.ts`（热力梯度唯一实现）
  + `point-tiers.ts` 的 `pickPracticeCount`；`ErrorPracticePage` 补 `?kpId=` 预填
  （spec §6.3 原写「已支持」，实测只到 API 层，页面不读 URL）。
- 实测勘误：brainstorming 调研摘要曾断言「training 判题不回写掌握度」——**错**，
  `training.service.ts:173-174` 经 `judgeCore.judgeQuestion` → `finishJudge` → `recordFromJudge`，
  **无 source 分支**，四个来源（practice/training/exams/remediation）都回写。
```

- [ ] **Step 9: 提交**

```bash
git add docs/API接口与数据流设计文档.md docs/api/openapi.yaml \
        docs/UX-UI设计文档.md docs/K12智学系统-产品需求文档.md \
        CLAUDE.md docs/ai-core-changelog.md
git commit -m "docs: 同步薄弱点图谱契约（API §4.5 / openapi / UX / PRD / CLAUDE.md / changelog）"
```

---

## Task 11: 终检门禁

**Files:** 无（只跑命令）

- [ ] **Step 1: 后端全量**

Run: `cd apps/server && npm test && npx tsc --noEmit`
Expected: 全部 PASS（含本批新增 ~40 用例）；`tsc` 无输出

- [ ] **Step 2: 后端 build（确认 `copy-assets` 不受影响）**

Run: `cd apps/server && npm run build`
Expected: 成功；`dist/main.js` 生成

⚠️ **注意**：本仓 `npm run build` 会覆盖 `apps/server/dist/`——若用户本机有 `node dist/main.js` 在跑，其进程已加载旧代码。**build 后主动告知用户**，不要擅自回退或重启用户的服务。

- [ ] **Step 3: 前端全量**

Run: `cd apps/web && npm test && npx tsc -b && npm run lint`
Expected: 全部 PASS；`tsc -b` 无输出；`lint` 0 error

- [ ] **Step 4: 人工冒烟（真数据，可选但推荐）**

按 CLAUDE.md 起后端：`node dist/main.js`（**不要用 `npx tsx src/main.ts`**，DI 是坏的）。前端 `npm run dev`。用学生账号登录：

1. 训练页应看到 **4 张卡**（新增「薄弱点图谱」），4 卡不被压扁
2. 点进图谱页：因库里掌握度只有 3 行，**大概率是全灰树 + 引导态推荐条**——这是**正确表现**，不是 bug
3. 展开任一有二级的一级行，点一个二级 chip → 右栏出详情
4. 若该生有够格候选，点「开始补这个」→ 应跳到专项作答页且题量 = 3
5. 点「看这个知识点的错题」→ 错题页应预填该知识点且列表已按它过滤
6. 页脚应显示「知识点覆盖 205 / 457 道题」与（若有）「另有 N 道未标注知识点的题」

- [ ] **Step 5: 确认无遗留分支 / 未提交改动**

Run: `git status --short && git log --oneline -12`
Expected: 工作区干净；本批提交按序在列（数量随计划修正提交累计而变，不必对数字）

---

## Self-Review（写完后自查，已执行）

**1. Spec 覆盖**

| Spec 章节 | 落地任务 |
|---|---|
| §3 裁决 1（仅数学） | Task 4 `assertMathSubject` |
| §3 裁决 2/5（训练轨入口、第 4 张卡、独立全屏页） | Task 7 + Task 8 |
| §3 裁决 3（树状热力图） | Task 7（折叠树）+ Task 6（热力梯度） |
| §3 裁决 4（掌握度为主 + 样本兜底 + 未标注说明） | Task 2 `confidence` + Task 7 页脚 |
| §3 裁决 6/7（一条推荐 + 三道闸门） | Task 3 |
| §3 裁决 8（一级折叠） | Task 7 |
| §3 裁决 9/14（右栏详情 / 窄屏抽屉） | Task 7 `aside` 的 class 切换 |
| §3 裁决 10（新建模块 + relations 降级 P1） | Task 4 + Task 10 |
| §3 裁决 11（`type=null` + ≥3 最小档） | Task 6 `pickPracticeCount` + Task 7 |
| §3 裁决 12（全量累计、无时间窗） | Task 1/2 无窗口谓词 |
| §3 裁决 13（未标注的题页脚 + 可点进错题页） | Task 1 `countUncoveredUncleared` + Task 7 页脚 |
| §4.3 数据缺口两条 | Task 2（null≠0）+ Task 1/7（覆盖口径） |
| §5.1 新增仓储方法（含「不可跨模块复用」） | Task 1（独立实现，注释说明理由） |
| §5.2 端点 1（含一次分组查询） | Task 1 + Task 2 + Task 4 |
| §5.3 端点 2（limit 1–10） | Task 3 + Task 4 |
| §5.4 推荐算法 + `MIN_SAMPLE_SIZE` | Task 2（常量）+ Task 3（闸门/排序） |
| §5.5 错误处理表 | Task 4（403/1005、400/1001） |
| §6.1 路由与入口（无深链参数） | Task 8 |
| §6.2 状态机 + 着色表 | Task 7 |
| §6.3 三个交互（开练 / 看错题 / 边界） | Task 7 + Task 9 |
| §6.3 边界「档位取不到 → 不硬发请求」 | Task 6（复用 `usePointTiers`，状态不塌）+ Task 7 `PracticeAction`（**界面表达**：转圈 / 重试控件 / 不渲染） |
| §6.4 空态与引导 | Task 7 |
| §6.5 窄屏降级 | Task 7 |
| §6.6 样式硬约束 | Task 7（`data-theme` / 线性 SVG / token 派生色） |
| §7 测试策略（含 SQL 谓词钉子、样本边界 5/4） | Task 1（SQL 钉子）+ Task 2（5/4 边界）+ 各页测试 |
| §8 已知限制 | 无需代码；Task 10 changelog 记录 |
| §9 文档同步清单 6 项 | Task 10 |
| §10 裁决补记（题量 / kpId 可达 / role 不区分） | Task 6（题量）+ Task 9（kpId）+ 无 role 过滤（Task 1/2 一致） |

**覆盖缺口：无。** 其中两处对 spec 的**有意细化**已在计划内标注：① `uncoveredUnclearedErrors` / `coverage` 收窄为**学科口径**（spec 只写「照抄」，但本页是数学专用页）；② `WEAK_LEVEL_MAX = 2`（spec 未定义的「待补」阈值，已标为纯展示口径）。

**2. 占位符扫描**：无 TBD / TODO / 「类似 Task N」/「加上适当的错误处理」。每个代码步骤都是完整可粘贴代码。

**3. 类型一致性核对**

- `MIN_SAMPLE_SIZE` 只在 Task 2 定义，Task 3 从同一模块 import；前端**不定义**该阈值 ✅
- `KnowledgeGraphNode` 后端（Task 2 DTO）与前端（Task 5）字段逐字一致：`id/name/parentId/masteryScore/level/correctCount/errorCount/lastSeenAt/sampleSize/confidence/availableQuestionCount` ✅
- `WeakPointCandidate` 后端（Task 3 DTO）与前端（Task 5）一致：`knowledgePointId/name/parentId/masteryScore/level/correctCount/errorCount/sampleSize/availableQuestionCount/lastSeenAt` ✅
- `heatForNode` 参数形状（`{ confidence, level }`）在 Task 6 定义、Task 7 三处调用均传 `KnowledgeGraphNode` 或 `{confidence:'ok', level: summary.weakestLevel}`——后者在 `weakestLevel != null` 分支内，`level` 为 number ✅
- `summarizeParent` 返回 `{ weakestLevel, pendingCount }`，Task 7 两处使用一致 ✅
- `pickPracticeCount(tiers)` 接受 `Array<{tierKey: string}>`，Task 7 传 `PointRuleTier[]`（有 `tierKey`）✅
- `parseRunHandoff` / `TargetedRunHandoff` 在 Task 7 只用到 `TargetedRunHandoff`（写入侧），未误用解析函数 ✅
- 仓储方法名在 Task 1 定义、Task 2/3 调用：`countAvailableQuestionsByKp` / `listBySubject` / `countQuestionCoverageBySubject` / `countUncoveredUncleared` 四处拼写一致 ✅
- Controller 测试断言 `ctrl.getMastery(9, user, 1)` 的**参数顺序**（studentId, user, subjectId）与实现签名一致 ✅
