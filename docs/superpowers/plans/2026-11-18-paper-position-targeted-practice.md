# 专项练习「试卷题号」抽题 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在数学专项练习里新增第三种选题方式「试卷题号」：按年级 + 学期 + 题号，从该范围所有试卷的同题号题中抽题，错题本未清的优先、从未做过的补足。

**Architecture:** 只读现有题库表，无 schema 变更。仓储层（`questions.repo.ts`）承担选项统计与两段抽题 SQL；服务层（`training.service.ts`）算众数、校验组合与题号、拼接两池；控制器（`training.controller.ts`）扩展既有 `/training/targeted/start` 并新增一个只读 GET；前端新增纯展示面板，接入既有 `TargetedConfigPage`，作答/判题/积分/错题本全部复用。

**Tech Stack:** NestJS + mysql2 (pool.query) + vitest（后端）；React 18 + TypeScript + Tailwind CSS 变量 + vitest/Testing Library（前端）。

## Global Constraints

- 设计真源：`docs/superpowers/specs/2026-11-18-paper-position-targeted-practice-design.md`。
- **只做数学**（`subjectId=1`），非数学接口 400、前端不渲染入口。
- **不改 schema**；不新建表、不加列、不写迁移。
- 题池谓词统一：`q.is_active=1 AND q.answer <> '' AND 不在该生 student_hidden_questions`。
- `LIMIT ?` 必须走 `pool.query`，**不许用 `pool.execute`**（mysql2 prepared statement 对 `LIMIT ?` 报错）。
- 题单必须白名单序列化：响应只含 `questionId/text/type/options/materialText/source/questionNo`，**不得泄漏 `answer` / `explanation`**。
- 抽题不足 `count` 一律 400，不建会话、不静默少给。
- UI 不使用 emoji、不加装饰性文案；配色只用现有 CSS token。
- 每个改代码的任务都要同时补测试；`globals: false`，前端测试文件必须自己 `afterEach(cleanup)`。
- 文档同步：`docs/API接口与数据流设计文档.md` 与 `docs/api/openapi.yaml` 必须同时改。

---

## File Structure

| 文件 | 责任 |
|---|---|
| `apps/server/src/database/repositories/questions.repo.ts` | 新增 4 个只读方法：选项分组、题号计数、错题优先抽题、未做补足抽题 |
| `apps/server/src/database/repositories/questions.repo.test.ts` | 上述 SQL 形状与参数单测 |
| `apps/server/src/modules/training/training.service.ts` | `listPaperPositions`（选项/众数/校验）+ `startTargetedPractice` 新增 paper 分支 |
| `apps/server/src/modules/training/training.service.test.ts` | 众数、题号补零、校验、开练顺序/会话字段 |
| `apps/server/src/modules/training/training.controller.ts` | 新增 `GET /api/training/paper-positions`；扩展 `targeted/start` 参数 |
| `apps/server/src/modules/training/training.controller.test.ts` | 互斥/缺参/非数学/type 校验 |
| `apps/web/src/services/api.ts` | 新增类型、`getPaperPositions`、扩展 `StartTargetedPayload` |
| `apps/web/src/services/api.paper-positions.test.ts` | URL 拼接单测 |
| `apps/web/src/pages/student/training/PaperPositionPanel.tsx` | 纯展示面板（年级/学期/题号/题量/开始） |
| `apps/web/src/pages/student/training/PaperPositionPanel.test.tsx` | 面板渲染与交互测试 |
| `apps/web/src/pages/student/training/TargetedConfigPage.tsx` | 第三种模式的状态与接口调用 |
| `apps/web/src/pages/student/training/TargetedConfigPage.test.tsx` | 接入后端到端（mock API）测试 |
| `docs/API接口与数据流设计文档.md` | 端点表 + 数据流 |
| `docs/api/openapi.yaml` | 新路径 + 请求 schema |
| `docs/ai-core-changelog.md` | 落地后补日期记录 |

---

### Task 1: 仓储层 — 题号选项与计数

**Files:**
- Modify: `apps/server/src/database/repositories/questions.repo.ts`（在 `findModelSpecialQuestions` 之后追加）
- Test: `apps/server/src/database/repositories/questions.repo.test.ts`（追加 describe）

**Interfaces:**
- Produces:
  - `interface PaperPositionOptionRow { grade: string; semester: string; question_count: number; papers: number }`
  - `listPaperPositionOptions(subjectId: number): Promise<PaperPositionOptionRow[]>`
  - `interface PaperPositionCountRow { question_no: number; total: number; wrong_count: number; untried_count: number }`
  - `countPaperPositionQuestions(studentId: number, subjectId: number, grade: string, semester: string): Promise<PaperPositionCountRow[]>`

- [ ] **Step 1: 写失败测试**

在 `questions.repo.test.ts` 末尾追加：

```ts
describe('QuestionsRepository — 试卷题号', () => {
  const optionsRow = { grade: '初三', semester: 'first', question_count: 28, papers: 5 };

  it('listPaperPositionOptions：按 grade/semester/question_count 分组，只统计可判题', async () => {
    const pool = mockPool([optionsRow]);
    const repo = new QuestionsRepository(pool as any);
    const rows = await repo.listPaperPositionOptions(1);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('COUNT(DISTINCT p.id) AS papers');
    expect(sql).toContain("p.semester IN ('first', 'second')");
    expect(sql).toContain('GROUP BY p.grade, p.semester, p.question_count');
    expect(sql).toContain('q.is_active = 1');
    expect(sql).toContain("q.answer <> ''");
    expect(params).toEqual([1]);
    expect(rows).toEqual([optionsRow]);
  });

  it('countPaperPositionQuestions：三张作答表都参与「从未做过」判定', async () => {
    const pool = mockPool([{ question_no: 24, total: 6, wrong_count: 2, untried_count: 3 }]);
    const repo = new QuestionsRepository(pool as any);
    const rows = await repo.countPaperPositionQuestions(7, 1, '初三', 'first');

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('COUNT(DISTINCT CASE WHEN EXISTS (');
    expect(sql).toContain('FROM main_error_books meb');
    expect(sql).toContain('meb.is_cleared = 0');
    expect(sql).toContain('FROM special_answer_records sar');
    expect(sql).toContain('JOIN special_practice_sessions sps');
    expect(sql).toContain('FROM exam_answers ea');
    expect(sql).toContain('JOIN exam_sessions es');
    expect(sql).toContain('FROM practice_results pr');
    expect(sql).toContain('sar.is_correct IS NOT NULL');
    expect(sql).toContain('ea.is_correct IS NOT NULL');
    expect(sql).toContain('FROM student_hidden_questions shq');
    expect(sql).toContain('GROUP BY pq.question_no');
    expect(params).toEqual([7, 1, 7, 1, 7, 7, 7, 1, '初三', 'first', 7, 1]);
    expect(rows[0].wrong_count).toBe(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/database/repositories/questions.repo.test.ts -t "试卷题号"`
Expected: FAIL，提示 `repo.listPaperPositionOptions is not a function`。

- [ ] **Step 3: 实现两个方法**

在 `questions.repo.ts` 的 `findModelSpecialQuestions` 方法之后追加（文件顶部 import 不变）：

```ts
export interface PaperPositionOptionRow extends RowDataPacket {
  grade: string;
  semester: string;
  question_count: number;
  papers: number;
}

export interface PaperPositionCountRow extends RowDataPacket {
  question_no: number;
  total: number;
  wrong_count: number;
  untried_count: number;
}

/** 「试卷题号」选项：按年级+学期+卷面题数分组统计卷数（只算可判题，避免空卷占位）。 */
async listPaperPositionOptions(subjectId: number): Promise<PaperPositionOptionRow[]> {
  const sql = `SELECT p.grade, p.semester, p.question_count, COUNT(DISTINCT p.id) AS papers
    FROM exam_papers p
    JOIN paper_questions pq ON pq.paper_id = p.id
    JOIN questions q ON q.id = pq.question_id
    WHERE p.subject_id = ? AND p.semester IN ('first', 'second')
      AND q.is_active = 1 AND q.answer <> ''
    GROUP BY p.grade, p.semester, p.question_count`;
  const [rows] = await this.pool.query<RowDataPacket[]>(sql, [subjectId]);
  return rows as PaperPositionOptionRow[];
}

/**
 * 「试卷题号」每个题号的三个数：
 * - total：排除 hidden 后的可判题数；
 * - wrong_count：未清错题本中的题数；
 * - untried_count：不在错题本、且专项/考试/主线三处都无已判记录的题数。
 * 参数顺序：错题 2 + 未做 5 + 范围 3 + hidden 2。
 */
async countPaperPositionQuestions(
  studentId: number,
  subjectId: number,
  grade: string,
  semester: string,
): Promise<PaperPositionCountRow[]> {
  const sql = `SELECT pq.question_no,
      COUNT(DISTINCT q.id) AS total,
      COUNT(DISTINCT CASE WHEN EXISTS (
        SELECT 1 FROM main_error_books meb
        WHERE meb.student_id = ? AND meb.subject_id = ?
          AND meb.question_id = q.id AND meb.is_cleared = 0
      ) THEN q.id END) AS wrong_count,
      COUNT(DISTINCT CASE WHEN NOT EXISTS (
        SELECT 1 FROM main_error_books meb
        WHERE meb.student_id = ? AND meb.subject_id = ?
          AND meb.question_id = q.id AND meb.is_cleared = 0
      ) AND NOT EXISTS (
        SELECT 1 FROM special_answer_records sar
        JOIN special_practice_sessions sps ON sps.id = sar.session_id
        WHERE sar.question_id = q.id AND sps.student_id = ?
          AND sar.is_correct IS NOT NULL
      ) AND NOT EXISTS (
        SELECT 1 FROM exam_answers ea
        JOIN exam_sessions es ON es.id = ea.session_id
        WHERE ea.question_id = q.id AND es.student_id = ?
          AND ea.is_correct IS NOT NULL
      ) AND NOT EXISTS (
        SELECT 1 FROM practice_results pr
        WHERE pr.question_id = q.id AND pr.student_id = ?
      ) THEN q.id END) AS untried_count
    FROM paper_questions pq
    JOIN exam_papers p ON p.id = pq.paper_id
    JOIN questions q ON q.id = pq.question_id
    WHERE p.subject_id = ? AND p.grade = ? AND p.semester = ?
      AND q.is_active = 1 AND q.answer <> ''
      AND NOT EXISTS (
        SELECT 1 FROM student_hidden_questions shq
        WHERE shq.student_id = ? AND shq.subject_id = ? AND shq.question_id = q.id
      )
    GROUP BY pq.question_no`;
  const [rows] = await this.pool.query<RowDataPacket[]>(
    sql,
    [studentId, subjectId, studentId, subjectId, studentId, studentId, studentId,
      subjectId, grade, semester, studentId, subjectId],
  );
  return rows as PaperPositionCountRow[];
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/database/repositories/questions.repo.test.ts`
Expected: PASS（含既有用例）。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/database/repositories/questions.repo.ts apps/server/src/database/repositories/questions.repo.test.ts
git commit -m "feat(training): 试卷题号选项与可练数统计查询"
```

---

### Task 2: 仓储层 — 错题优先 / 未做补足抽题

**Files:**
- Modify: `apps/server/src/database/repositories/questions.repo.ts`
- Test: `apps/server/src/database/repositories/questions.repo.test.ts`

**Interfaces:**
- Produces:
  - `findPaperPositionWrongQuestions(studentId: number, subjectId: number, grade: string, semester: string, questionNo: number, limit: number): Promise<QuestionRow[]>`
  - `findPaperPositionUntriedQuestions(studentId: number, subjectId: number, grade: string, semester: string, questionNo: number, limit: number): Promise<QuestionRow[]>`
- 两句都返回 `QuestionRow[]`，并带 `question_no`（来自 `MIN(pq.question_no)`）。

- [ ] **Step 1: 写失败测试**

在 Task 1 的 describe 里追加：

```ts
  it('findPaperPositionWrongQuestions：JOIN 未清错题本 + level 降序 + LIMIT ?', async () => {
    const pool = mockPool([]);
    const repo = new QuestionsRepository(pool as any);
    await repo.findPaperPositionWrongQuestions(7, 1, '初三', 'first', 24, 3);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('JOIN main_error_books meb');
    expect(sql).toContain('meb.is_cleared = 0');
    expect(sql).toContain('MIN(pq.question_no) AS question_no');
    expect(sql).toContain('GROUP BY q.id');
    expect(sql).toContain('ORDER BY wrong_level DESC, last_wrong_at DESC, q.id ASC');
    expect(sql).toContain('LIMIT ?');
    expect(params).toEqual([7, 1, 1, '初三', 'first', 24, 7, 1, 3]);
  });

  it('findPaperPositionUntriedQuestions：排除三张作答表 + 错题本 + hidden', async () => {
    const pool = mockPool([]);
    const repo = new QuestionsRepository(pool as any);
    await repo.findPaperPositionUntriedQuestions(7, 1, '初三', 'first', 24, 2);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('NOT EXISTS (');
    expect(sql).toContain('FROM special_answer_records sar');
    expect(sql).toContain('FROM exam_answers ea');
    expect(sql).toContain('FROM practice_results pr');
    expect(sql).toContain('FROM main_error_books meb');
    expect(sql).toContain('FROM student_hidden_questions shq');
    expect(sql).toContain('ORDER BY q.id ASC');
    expect(sql).toContain('LIMIT ?');
    expect(params).toEqual([1, '初三', 'first', 24, 7, 1, 7, 1, 7, 7, 7, 2]);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/database/repositories/questions.repo.test.ts -t "findPaperPosition"`
Expected: FAIL（方法不存在）。

- [ ] **Step 3: 实现两段抽题**

在 `countPaperPositionQuestions` 之后追加：

```ts
/** 错题优先池：未清错题本中的同题号题，level 高→低、同级别最近答错在前。 */
async findPaperPositionWrongQuestions(
  studentId: number,
  subjectId: number,
  grade: string,
  semester: string,
  questionNo: number,
  limit: number,
): Promise<QuestionRow[]> {
  const sql = `SELECT q.*, MIN(pq.question_no) AS question_no,
      MAX(meb.level) AS wrong_level, MAX(meb.created_at) AS last_wrong_at
    FROM paper_questions pq
    JOIN exam_papers p ON p.id = pq.paper_id
    JOIN questions q ON q.id = pq.question_id
    JOIN main_error_books meb ON meb.question_id = q.id
      AND meb.student_id = ? AND meb.subject_id = ? AND meb.is_cleared = 0
    WHERE p.subject_id = ? AND p.grade = ? AND p.semester = ? AND pq.question_no = ?
      AND q.is_active = 1 AND q.answer <> ''
      AND NOT EXISTS (
        SELECT 1 FROM student_hidden_questions shq
        WHERE shq.student_id = ? AND shq.subject_id = ? AND shq.question_id = q.id
      )
    GROUP BY q.id
    ORDER BY wrong_level DESC, last_wrong_at DESC, q.id ASC
    LIMIT ?`;
  const [rows] = await this.pool.query<RowDataPacket[]>(
    sql,
    [studentId, subjectId, subjectId, grade, semester, questionNo, studentId, subjectId, limit],
  );
  return rows as QuestionRow[];
}

/** 补足池：不在错题本、且三处都无已判记录的题；id 升序确定性取。 */
async findPaperPositionUntriedQuestions(
  studentId: number,
  subjectId: number,
  grade: string,
  semester: string,
  questionNo: number,
  limit: number,
): Promise<QuestionRow[]> {
  const sql = `SELECT q.*, MIN(pq.question_no) AS question_no
    FROM paper_questions pq
    JOIN exam_papers p ON p.id = pq.paper_id
    JOIN questions q ON q.id = pq.question_id
    WHERE p.subject_id = ? AND p.grade = ? AND p.semester = ? AND pq.question_no = ?
      AND q.is_active = 1 AND q.answer <> ''
      AND NOT EXISTS (
        SELECT 1 FROM student_hidden_questions shq
        WHERE shq.student_id = ? AND shq.subject_id = ? AND shq.question_id = q.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM main_error_books meb
        WHERE meb.student_id = ? AND meb.subject_id = ?
          AND meb.question_id = q.id AND meb.is_cleared = 0
      )
      AND NOT EXISTS (
        SELECT 1 FROM special_answer_records sar
        JOIN special_practice_sessions sps ON sps.id = sar.session_id
        WHERE sar.question_id = q.id AND sps.student_id = ?
          AND sar.is_correct IS NOT NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM exam_answers ea
        JOIN exam_sessions es ON es.id = ea.session_id
        WHERE ea.question_id = q.id AND es.student_id = ?
          AND ea.is_correct IS NOT NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM practice_results pr
        WHERE pr.question_id = q.id AND pr.student_id = ?
      )
    GROUP BY q.id
    ORDER BY q.id ASC
    LIMIT ?`;
  const [rows] = await this.pool.query<RowDataPacket[]>(
    sql,
    [subjectId, grade, semester, questionNo, studentId, subjectId,
      studentId, subjectId, studentId, studentId, studentId, limit],
  );
  return rows as QuestionRow[];
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/database/repositories/questions.repo.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/database/repositories/questions.repo.ts apps/server/src/database/repositories/questions.repo.test.ts
git commit -m "feat(training): 按题号抽题（错题优先 + 未做补足）"
```

---

### Task 3: 服务层 — 选项、众数与题号清单

**Files:**
- Modify: `apps/server/src/modules/training/training.service.ts`（`listModelSpecials` 之前插入）
- Test: `apps/server/src/modules/training/training.service.test.ts`（`startTargetedPractice` 前追加 describe；并扩 `mk`）

**Interfaces:**
- Consumes: Task 1 的 `listPaperPositionOptions` / `countPaperPositionQuestions`
- Produces:
  - `listPaperPositions(studentId: number, subjectId: number, grade?: string | null, semester?: string | null): Promise<PaperPositionsResult>`
  - `type PaperPositionsResult = { options: Array<{grade: string; semester: 'first'|'second'; paperCount: number; typicalQuestionCount: number}>; grade: string | null; semester: 'first'|'second' | null; typicalQuestionCount: number | null; positions: Array<{questionNo: number; total: number; wrongCount: number; untriedCount: number}> }`

- [ ] **Step 1: 扩展测试依赖工厂**

在 `training.service.test.ts` 的 `mk` 里 `questionsRepo` 段追加：

```ts
    listPaperPositionOptions: vi.fn().mockResolvedValue([]),
    countPaperPositionQuestions: vi.fn().mockResolvedValue([]),
    findPaperPositionWrongQuestions: vi.fn().mockResolvedValue([]),
    findPaperPositionUntriedQuestions: vi.fn().mockResolvedValue([]),
```

- [ ] **Step 2: 写失败测试**

在 `describe('TrainingService.startTargetedPractice'` 之前追加：

```ts
describe('TrainingService.listPaperPositions', () => {
  const optionsRows = [
    { grade: '初三', semester: 'first', question_count: 28, papers: 5 },
    { grade: '初三', semester: 'first', question_count: 21, papers: 1 },
    { grade: '初三', semester: 'first', question_count: 29, papers: 1 },
    { grade: '初三', semester: 'second', question_count: 28, papers: 10 },
  ];

  it('众数取 28（并列取较大），选项按学期 first→second', async () => {
    const deps = mk({ questionsRepo: { listPaperPositionOptions: vi.fn().mockResolvedValue(optionsRows) } as never });
    const r = await mkSvc(deps).listPaperPositions(7, 1);
    expect(r.options).toEqual([
      { grade: '初三', semester: 'first', paperCount: 7, typicalQuestionCount: 28 },
      { grade: '初三', semester: 'second', paperCount: 10, typicalQuestionCount: 28 },
    ]);
    expect(r.positions).toEqual([]);
    expect(r.typicalQuestionCount).toBeNull();
  });

  it('题号清单按 1..28 补零并映射三个数', async () => {
    const deps = mk({
      questionsRepo: {
        listPaperPositionOptions: vi.fn().mockResolvedValue(optionsRows),
        countPaperPositionQuestions: vi.fn().mockResolvedValue([
          { question_no: 1, total: 5, wrong_count: 2, untried_count: 3 },
          { question_no: 24, total: 6, wrong_count: 1, untried_count: 4 },
        ]),
      } as never,
    });
    const r = await mkSvc(deps).listPaperPositions(7, 1, '初三', 'first');
    expect(r.positions).toHaveLength(28);
    expect(r.positions[0]).toEqual({ questionNo: 1, total: 5, wrongCount: 2, untriedCount: 3 });
    expect(r.positions[23]).toEqual({ questionNo: 24, total: 6, wrongCount: 1, untriedCount: 4 });
    expect(r.positions[2]).toEqual({ questionNo: 3, total: 0, wrongCount: 0, untriedCount: 0 });
  });

  it('非数学 400；grade/semester 只给一个 400；组合不存在 400', async () => {
    const deps = mk({ questionsRepo: { listPaperPositionOptions: vi.fn().mockResolvedValue(optionsRows) } as never });
    const svc = mkSvc(deps);
    await expect(svc.listPaperPositions(7, 2)).rejects.toThrow('试卷题号仅支持数学');
    await expect(svc.listPaperPositions(7, 1, '初三', null)).rejects.toThrow('grade 与 semester 必须同时出现');
    await expect(svc.listPaperPositions(7, 1, '初二', 'first')).rejects.toThrow('该年级学期暂无试卷');
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/training/training.service.test.ts -t "listPaperPositions"`
Expected: FAIL（方法不存在）。

- [ ] **Step 4: 实现服务方法**

在 `training.service.ts` 的 `listModelSpecials` 方法前插入：

```ts
/** 学期排序用（API 只认 first/second）。 */
private static readonly SEMESTER_ORDER: Record<string, number> = { first: 0, second: 1 };

/**
 * 试卷题号：选项 + 题号清单。
 * 不传 grade/semester 只回选项；两者必须同时出现。
 * 题号列表固定为 1..typicalQuestionCount（该组合下卷面题数的众数，并列取较大），
 * 没有题的题号补 0，前端据此置灰。
 */
async listPaperPositions(
  studentId: number,
  subjectId: number,
  grade?: string | null,
  semester?: string | null,
): Promise<{
  options: Array<{ grade: string; semester: string; paperCount: number; typicalQuestionCount: number }>;
  grade: string | null;
  semester: string | null;
  typicalQuestionCount: number | null;
  positions: Array<{ questionNo: number; total: number; wrongCount: number; untriedCount: number }>;
}> {
  if (subjectId !== SUBJECT_MATH) {
    throw new BadRequestException('试卷题号仅支持数学');
  }
  if ((grade == null) !== (semester == null)) {
    throw new BadRequestException('grade 与 semester 必须同时出现');
  }
  if (semester != null && semester !== 'first' && semester !== 'second') {
    throw new BadRequestException('semester 仅允许 first | second');
  }

  const rows = await this.questionsRepo.listPaperPositionOptions(subjectId);
  const grouped = new Map<string, {
    grade: string; semester: string; paperCount: number; counts: Map<number, number>;
  }>();
  for (const r of rows) {
    const key = `${r.grade}::${r.semester}`;
    const g = grouped.get(key) ?? {
      grade: r.grade, semester: r.semester, paperCount: 0, counts: new Map<number, number>(),
    };
    const qCount = Number(r.question_count);
    const papers = Number(r.papers);
    g.paperCount += papers;
    g.counts.set(qCount, (g.counts.get(qCount) ?? 0) + papers);
    grouped.set(key, g);
  }

  const options = Array.from(grouped.values())
    .sort((a, b) =>
      a.grade.localeCompare(b.grade)
      || (TrainingService.SEMESTER_ORDER[a.semester] ?? 9) - (TrainingService.SEMESTER_ORDER[b.semester] ?? 9))
    .map((g) => ({
      grade: g.grade,
      semester: g.semester,
      paperCount: g.paperCount,
      typicalQuestionCount: this.pickTypicalQuestionCount(g.counts),
    }));

  if (grade == null || semester == null) {
    return { options, grade: null, semester: null, typicalQuestionCount: null, positions: [] };
  }

  const option = options.find((o) => o.grade === grade && o.semester === semester);
  if (!option) {
    throw new BadRequestException('该年级学期暂无试卷');
  }

  const countRows = await this.questionsRepo.countPaperPositionQuestions(
    studentId, subjectId, grade, semester,
  );
  const byNo = new Map<number, { total: number; wrong_count: number; untried_count: number }>();
  for (const r of countRows) {
    byNo.set(Number(r.question_no), r);
  }
  const positions = Array.from({ length: option.typicalQuestionCount }, (_, i) => {
    const questionNo = i + 1;
    const r = byNo.get(questionNo);
    return {
      questionNo,
      total: Number(r?.total ?? 0),
      wrongCount: Number(r?.wrong_count ?? 0),
      untriedCount: Number(r?.untried_count ?? 0),
    };
  });

  return { options, grade, semester, typicalQuestionCount: option.typicalQuestionCount, positions };
}

/** 卷长众数；并列取较大值（宁可多给题位，也不隐藏可练题）。 */
private pickTypicalQuestionCount(counts: Map<number, number>): number {
  let best = 0;
  let bestPapers = -1;
  for (const [qCount, papers] of counts) {
    if (papers > bestPapers || (papers === bestPapers && qCount > best)) {
      best = qCount;
      bestPapers = papers;
    }
  }
  return best;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/training/training.service.test.ts`
Expected: PASS（含既有用例）。

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/modules/training/training.service.ts apps/server/src/modules/training/training.service.test.ts
git commit -m "feat(training): 试卷题号选项与题号清单服务"
```

---

### Task 4: 服务层 — 开练 paper 分支

**Files:**
- Modify: `apps/server/src/modules/training/training.service.ts`（`startTargetedPractice`）
- Test: `apps/server/src/modules/training/training.service.test.ts`

**Interfaces:**
- Consumes: Task 1/2 的仓储方法、Task 3 的 `listPaperPositions`
- Produces: `startTargetedPractice` 入参新增 `paperPosition?: { grade: string; semester: 'first' | 'second'; questionNo: number } | null`

- [ ] **Step 1: 写失败测试**

在 `startTargetedPractice` 的 describe 内追加：

```ts
  it('paper 模式：错题在前、未做补足，不足 count 直接 400 且不建会话', async () => {
    const wrong = { ...questionRow, id: 21, question_no: 24 };
    const untried = { ...questionRow, id: 22, question_no: 24 };
    const deps = mk({
      questionsRepo: {
        listPaperPositionOptions: vi.fn().mockResolvedValue([
          { grade: '初三', semester: 'first', question_count: 28, papers: 6 },
        ]),
        countPaperPositionQuestions: vi.fn().mockResolvedValue([]),
        findPaperPositionWrongQuestions: vi.fn().mockResolvedValue([wrong]),
        findPaperPositionUntriedQuestions: vi.fn().mockResolvedValue([untried]),
      } as never,
    });
    const r = await mkSvc(deps).startTargetedPractice({
      studentId: 7, subjectId: 1, paperPosition: { grade: '初三', semester: 'first', questionNo: 24 },
      type: null, count: 2,
    });

    expect(deps.questionsRepo.findPaperPositionWrongQuestions)
      .toHaveBeenCalledWith(7, 1, '初三', 'first', 24, 2);
    expect(deps.questionsRepo.findPaperPositionUntriedQuestions)
      .toHaveBeenCalledWith(7, 1, '初三', 'first', 24, 1);
    expect(r.questions.map((q) => q.questionId)).toEqual([21, 22]);
    expect(deps.trainingSessionsRepo.create).toHaveBeenCalledWith(expect.objectContaining({
      task_code: 'math_targeted', tier_key: '2', expected_count: 2,
      ref_type: 'paper_position', ref_id: 24,
    }));
  });

  it('paper 模式：可练数不足 400，不建会话', async () => {
    const deps = mk({
      questionsRepo: {
        listPaperPositionOptions: vi.fn().mockResolvedValue([
          { grade: '初三', semester: 'first', question_count: 28, papers: 6 },
        ]),
        countPaperPositionQuestions: vi.fn().mockResolvedValue([]),
        findPaperPositionWrongQuestions: vi.fn().mockResolvedValue([]),
        findPaperPositionUntriedQuestions: vi.fn().mockResolvedValue([{ ...questionRow, id: 21 }]),
      } as never,
    });
    await expect(mkSvc(deps).startTargetedPractice({
      studentId: 7, subjectId: 1, paperPosition: { grade: '初三', semester: 'first', questionNo: 24 },
      type: null, count: 3,
    })).rejects.toThrow('该题号可练题数不足（当前 1 题）');
    expect(deps.trainingSessionsRepo.create).not.toHaveBeenCalled();
  });

  it('paper 模式：题号超出常见卷长 400', async () => {
    const deps = mk({
      questionsRepo: {
        listPaperPositionOptions: vi.fn().mockResolvedValue([
          { grade: '初三', semester: 'first', question_count: 28, papers: 6 },
        ]),
        countPaperPositionQuestions: vi.fn().mockResolvedValue([]),
      } as never,
    });
    await expect(mkSvc(deps).startTargetedPractice({
      studentId: 7, subjectId: 1, paperPosition: { grade: '初三', semester: 'first', questionNo: 29 },
      type: null, count: 1,
    })).rejects.toThrow('题号超出卷面范围（1-28）');
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/training/training.service.test.ts -t "paper 模式"`
Expected: FAIL（`paperPosition` 未使用，实际走 KP 分支）。

- [ ] **Step 3: 实现分支**

在 `training.service.ts` 顶部补 import：

```ts
import type { QuestionRow } from '../../database/repositories/types.js';
```

把 `startTargetedPractice` **入参类型**改为下面这样（**返回类型那一大块保持文件里原样，一行都不要动**）：

```ts
  async startTargetedPractice(input: {
    studentId: number;
    subjectId: number;
    kpId?: number | null;
    /** 模型微专题；与 kpId / paperPosition 三选一，控制器已校验。 */
    modelSpecial?: ModelSpecial | null;
    /** 试卷题号；与 kpId / modelSpecial 三选一，控制器已校验。 */
    paperPosition?: { grade: string; semester: 'first' | 'second'; questionNo: number } | null;
    type: string | null;
    count: number;
  }): Promise<{
```

方法体开头（`const modelSpecial = ...` 之前）插入：

```ts
    const paperPosition = input.paperPosition ?? null;
    if (paperPosition) {
      const meta = await this.listPaperPositions(
        input.studentId, input.subjectId, paperPosition.grade, paperPosition.semester,
      );
      if (meta.typicalQuestionCount == null) {
        throw new BadRequestException('该年级学期暂无试卷');
      }
      if (paperPosition.questionNo < 1 || paperPosition.questionNo > meta.typicalQuestionCount) {
        throw new BadRequestException(`题号超出卷面范围（1-${meta.typicalQuestionCount}）`);
      }
    }
```

把原来的抽题三元表达式改为：

```ts
    let rows: QuestionRow[];
    if (paperPosition) {
      const wrong = await this.questionsRepo.findPaperPositionWrongQuestions(
        input.studentId, input.subjectId,
        paperPosition.grade, paperPosition.semester, paperPosition.questionNo, input.count,
      );
      const remaining = input.count - wrong.length;
      const untried = remaining > 0
        ? await this.questionsRepo.findPaperPositionUntriedQuestions(
            input.studentId, input.subjectId,
            paperPosition.grade, paperPosition.semester, paperPosition.questionNo, remaining,
          )
        : [];
      rows = [...wrong, ...untried];
    } else if (modelSpecial) {
      rows = await this.questionsRepo.findModelSpecialQuestions(
        input.studentId, input.subjectId, modelSpecial.category,
        modelSpecial.model, input.count,
      );
    } else {
      rows = await this.questionsRepo.findRandomByKpAndType(
        input.studentId,
        input.subjectId,
        input.kpId as number,
        input.type,
        input.count,
      );
    }
```

把题数不足检查改为：

```ts
    if ((modelSpecial || paperPosition) && rows.length < input.count) {
      throw new BadRequestException(
        paperPosition
          ? `该题号可练题数不足（当前 ${rows.length} 题）`
          : `题量超过可练题数（当前 ${rows.length} 题）`,
      );
    }
```

会话字段改为：

```ts
          ref_type: paperPosition ? 'paper_position' : modelSpecial ? 'model' : 'question',
          ref_id: paperPosition ? paperPosition.questionNo : null,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/training/training.service.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/modules/training/training.service.ts apps/server/src/modules/training/training.service.test.ts
git commit -m "feat(training): 专项开练支持试卷题号抽题"
```

---

### Task 5: 控制器 — 新端点与三选一校验

**Files:**
- Modify: `apps/server/src/modules/training/training.controller.ts`
- Test: `apps/server/src/modules/training/training.controller.test.ts`

**Interfaces:**
- Consumes: Task 3 `listPaperPositions`、Task 4 `startTargetedPractice({paperPosition})`
- Produces: `GET /api/training/paper-positions?subjectId&grade&semester`；`POST /api/training/targeted/start` 接受 `grade` / `semester` / `paperQuestionNo`

- [ ] **Step 1: 写失败测试**

在 `training.controller.test.ts` 追加：

```ts
describe('TrainingController.getPaperPositions', () => {
  it('透传 subjectId + grade/semester + studentId', async () => {
    const service = { listPaperPositions: vi.fn().mockResolvedValue({ options: [] }) };
    const controller = new TrainingController(service as never, {} as never, {} as never, {} as never);
    await controller.getPaperPositions(1, USER, '初三', 'first');
    expect(service.listPaperPositions).toHaveBeenCalledWith(7, 1, '初三', 'first');
  });

  it('缺省 grade/semester 传 null', async () => {
    const service = { listPaperPositions: vi.fn().mockResolvedValue({ options: [] }) };
    const controller = new TrainingController(service as never, {} as never, {} as never, {} as never);
    await controller.getPaperPositions(1, USER, undefined, undefined);
    expect(service.listPaperPositions).toHaveBeenCalledWith(7, 1, null, null);
  });
});

describe('TrainingController.startTargetedPractice — 试卷题号校验', () => {
  function makeController(allowed = ['1', '2', '3', '5', '10']) {
    const service = { startTargetedPractice: vi.fn().mockResolvedValue({ questions: [], sessionId: null }) };
    const pointRulesService = { listTierKeys: vi.fn().mockResolvedValue(allowed) };
    return {
      controller: new TrainingController(service as never, {} as never, {} as never, pointRulesService as never),
      service,
    };
  }

  it('三选一互斥：paper 字段与 kpId 同给 400', async () => {
    const { controller } = makeController();
    await expect(controller.startTargetedPractice({
      subjectId: 1, kpId: 3, grade: '初三', semester: 'first', paperQuestionNo: 24, type: null, count: 2,
    }, USER)).rejects.toThrow('三选一');
  });

  it('缺 grade/semester 400；type 非 null 400；非数学 400', async () => {
    const { controller } = makeController();
    await expect(controller.startTargetedPractice({
      subjectId: 1, grade: '初三', paperQuestionNo: 24, type: null, count: 2,
    }, USER)).rejects.toThrow('必须同时出现');

    await expect(controller.startTargetedPractice({
      subjectId: 1, grade: '初三', semester: 'first', paperQuestionNo: 24, type: 'choice', count: 2,
    }, USER)).rejects.toThrow('试卷题号不支持题型筛选');

    await expect(controller.startTargetedPractice({
      subjectId: 4, grade: '初三', semester: 'first', paperQuestionNo: 24, type: null, count: 2,
    }, USER)).rejects.toThrow('试卷题号仅支持数学');
  });

  it('合法请求透传 paperPosition、type 归一为 null', async () => {
    const { controller, service } = makeController();
    await controller.startTargetedPractice({
      subjectId: 1, grade: '初三', semester: 'first', paperQuestionNo: 24, type: null, count: 2,
    }, USER);
    expect(service.startTargetedPractice).toHaveBeenCalledWith(expect.objectContaining({
      subjectId: 1,
      paperPosition: { grade: '初三', semester: 'first', questionNo: 24 },
      type: null,
      count: 2,
    }));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/training/training.controller.test.ts -t "试卷题号"`
Expected: FAIL（`getPaperPositions` 不存在 / 校验未实现）。

- [ ] **Step 3: 实现端点与校验**

在 `model-specials` 端点上方插入：

```ts
  /** 试卷题号选项 + 题号清单：subjectId 必填；grade/semester 同时给或同时不给。 */
  @Get('paper-positions')
  async getPaperPositions(
    @Query('subjectId', ParseIntPipe) subjectId: number,
    @CurrentUser() user: JwtUser,
    @Query('grade') grade?: string,
    @Query('semester') semester?: string,
  ) {
    return this.trainingService.listPaperPositions(
      user.sub, subjectId, grade ?? null, semester ?? null,
    );
  }
```

把 `startTargetedPractice` 的 body 类型补上：

```ts
      paperQuestionNo?: number;
      grade?: string;
      semester?: string;
```

把方法体开头的校验替换为：

```ts
    const hasKp = Number.isInteger(dto.kpId) && (dto.kpId as number) > 0;
    const hasCategory = typeof dto.category === 'string' && dto.category.trim() !== '';
    const hasModel = typeof dto.model === 'string' && dto.model.trim() !== '';
    const hasPaperNo = Number.isInteger(dto.paperQuestionNo) && (dto.paperQuestionNo as number) > 0;
    const hasGrade = typeof dto.grade === 'string' && dto.grade.trim() !== '';
    const hasSemester = typeof dto.semester === 'string' && dto.semester.trim() !== '';
    const hasPaperPosition = hasPaperNo || hasGrade || hasSemester;

    const modes = [hasKp, hasCategory || hasModel, hasPaperPosition].filter(Boolean).length;
    if (modes !== 1) {
      throw new BadRequestException('kpId、category+model 与 paperQuestionNo 必须三选一');
    }
    if (!hasKp && hasCategory !== hasModel) {
      throw new BadRequestException('category 与 model 必须同时出现');
    }
    if (hasPaperPosition) {
      if (!hasPaperNo || !hasGrade || !hasSemester) {
        throw new BadRequestException('paperQuestionNo、grade、semester 必须同时出现');
      }
      if (dto.subjectId !== SUBJECT_MATH) {
        throw new BadRequestException('试卷题号仅支持数学');
      }
      if (dto.semester !== 'first' && dto.semester !== 'second') {
        throw new BadRequestException('semester 仅允许 first | second');
      }
      if (dto.type !== null && dto.type !== undefined) {
        throw new BadRequestException('试卷题号不支持题型筛选');
      }
    }

    const special = hasKp || hasPaperPosition
      ? null
      : findModelSpecial(dto.category, dto.model);
    if (!hasKp && !hasPaperPosition) {
      if (dto.subjectId !== SUBJECT_MATH) {
        throw new BadRequestException('模型专项仅支持数学');
      }
      if (!special) throw new BadRequestException('不支持的模型专项');
      if (dto.type !== null && dto.type !== undefined) {
        throw new BadRequestException('模型专项不支持题型筛选');
      }
    }
```

把 tier 检查里的 `!hasKp` 改成 `(!hasKp)` 保持不变（它同时覆盖模型和 paper，语义正确）。

最后把 service 调用改为：

```ts
    return this.trainingService.startTargetedPractice({
      studentId: user.sub,
      subjectId: dto.subjectId,
      kpId: hasKp ? dto.kpId! : null,
      modelSpecial: special,
      paperPosition: hasPaperPosition
        ? {
            grade: dto.grade as string,
            semester: dto.semester as 'first' | 'second',
            questionNo: dto.paperQuestionNo as number,
          }
        : null,
      type: special ? null : type,
      count,
    });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/training/training.controller.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/modules/training/training.controller.ts apps/server/src/modules/training/training.controller.test.ts
git commit -m "feat(training): 新增试卷题号接口与开练校验"
```

---

### Task 6: 前端 API 层

**Files:**
- Modify: `apps/web/src/services/api.ts`（`TrainingModelSpecial` 段之后）
- Test: `apps/web/src/services/api.paper-positions.test.ts`（新建）

**Interfaces:**
- Produces:
  - `type TrainingSemester = 'first' | 'second'`
  - `interface TrainingPaperPositionOption { grade: string; semester: TrainingSemester; paperCount: number; typicalQuestionCount: number }`
  - `interface TrainingPaperPosition { questionNo: number; total: number; wrongCount: number; untriedCount: number }`
  - `getPaperPositions(subjectId: number, grade?: string, semester?: TrainingSemester): Promise<{options: TrainingPaperPositionOption[]; grade: string | null; semester: TrainingSemester | null; typicalQuestionCount: number | null; positions: TrainingPaperPosition[]}>`
  - `StartTargetedPayload` 增加第三个联合分支

- [ ] **Step 1: 写失败测试**

新建 `apps/web/src/services/api.paper-positions.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPaperPositions } from './api';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(data: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    json: () => Promise.resolve({ code: 0, message: 'ok', data }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('getPaperPositions query', () => {
  it('只传学科：不带 grade/semester', async () => {
    const fetchMock = stubFetch({ options: [] });
    await getPaperPositions(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/training/paper-positions?subjectId=1');
  });

  it('带年级学期：两者都拼进 query（中文编码）', async () => {
    const fetchMock = stubFetch({ options: [] });
    await getPaperPositions(1, '初三', 'first');
    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/training/paper-positions?subjectId=1&grade=%E5%88%9D%E4%B8%89&semester=first',
    );
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/services/api.paper-positions.test.ts`
Expected: FAIL（`getPaperPositions` 未导出）。

- [ ] **Step 3: 实现类型与函数**

在 `api.ts` 的 `getModelSpecials` 之后追加：

```ts
export type TrainingSemester = 'first' | 'second';

export interface TrainingPaperPositionOption {
  grade: string;
  semester: TrainingSemester;
  paperCount: number;
  typicalQuestionCount: number;
}

export interface TrainingPaperPosition {
  questionNo: number;
  total: number;
  wrongCount: number;
  untriedCount: number;
}

export interface TrainingPaperPositionsResult {
  options: TrainingPaperPositionOption[];
  grade: string | null;
  semester: TrainingSemester | null;
  typicalQuestionCount: number | null;
  positions: TrainingPaperPosition[];
}

/** 试卷题号选项；带 grade+semester 时同时返回题号清单。 */
export function getPaperPositions(
  subjectId: number,
  grade?: string,
  semester?: TrainingSemester,
): Promise<TrainingPaperPositionsResult> {
  const qs = new URLSearchParams({ subjectId: String(subjectId) });
  if (grade && semester) {
    qs.set('grade', grade);
    qs.set('semester', semester);
  }
  return fetchApi<TrainingPaperPositionsResult>(
    `/training/paper-positions?${qs.toString()}`,
  );
}
```

把 `StartTargetedPayload` 改为三分支（给既有两分支补上互斥字段）：

```ts
export type StartTargetedPayload =
  | {
      subjectId: number;
      kpId: number;
      category?: never;
      model?: never;
      grade?: never;
      semester?: never;
      paperQuestionNo?: never;
      type: string | null;
      count: number;
    }
  | {
      subjectId: number;
      kpId?: never;
      category: string;
      model: string;
      grade?: never;
      semester?: never;
      paperQuestionNo?: never;
      type: null;
      count: number;
    }
  | {
      subjectId: number;
      kpId?: never;
      category?: never;
      model?: never;
      grade: string;
      semester: TrainingSemester;
      paperQuestionNo: number;
      type: null;
      count: number;
    };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/services/api.paper-positions.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/services/api.ts apps/web/src/services/api.paper-positions.test.ts
git commit -m "feat(web): 试卷题号接口类型与客户端"
```

---

### Task 7: 前端面板 `PaperPositionPanel`

**Files:**
- Create: `apps/web/src/pages/student/training/PaperPositionPanel.tsx`
- Test: `apps/web/src/pages/student/training/PaperPositionPanel.test.tsx`

**Interfaces:**
- Consumes: `TrainingPaperPositionOption` / `TrainingPaperPosition` / `TrainingSemester` / `PointRuleTier`
- Produces: `PaperPositionPanel`、`SEMESTER_LABELS`、`PaperPositionPanelProps`

- [ ] **Step 1: 写失败测试**

新建 `PaperPositionPanel.test.tsx`：

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PaperPositionPanel, type PaperPositionPanelProps } from './PaperPositionPanel';
import type { PointRuleTier, TrainingPaperPositionOption } from '@/services/api';

afterEach(cleanup);

const OPTIONS: TrainingPaperPositionOption[] = [
  { grade: '初三', semester: 'first', paperCount: 7, typicalQuestionCount: 28 },
  { grade: '初三', semester: 'second', paperCount: 12, typicalQuestionCount: 28 },
];

function tier(key: string, label: string, points: number): PointRuleTier {
  return {
    tierKey: key, tierLabel: label, points,
    dailyLimit: null, completedToday: null, remainingToday: null, isActive: true,
  };
}

function props(over: Partial<PaperPositionPanelProps> = {}): PaperPositionPanelProps {
  return {
    options: OPTIONS,
    optionsStatus: 'ok',
    optionsError: null,
    grade: '初三',
    semester: 'first',
    onSelectGrade: vi.fn(),
    onSelectSemester: vi.fn(),
    positionsStatus: 'ok',
    positionsError: null,
    positions: [
      { questionNo: 1, total: 5, wrongCount: 2, untriedCount: 3 },
      { questionNo: 24, total: 6, wrongCount: 1, untriedCount: 4 },
      { questionNo: 25, total: 6, wrongCount: 0, untriedCount: 0 },
    ],
    typicalQuestionCount: 28,
    selectedQuestionNo: 24,
    onSelectQuestionNo: vi.fn(),
    tiers: [tier('1', '1 题', 2), tier('3', '3 题', 8), tier('5', '5 题', 15)],
    tiersError: null,
    eligibleTiers: [tier('1', '1 题', 2), tier('3', '3 题', 8), tier('5', '5 题', 15)],
    tierKey: '3',
    starting: false,
    startError: null,
    emptyHint: false,
    onRetryOptions: vi.fn(),
    onRetryPositions: vi.fn(),
    onRetryTiers: vi.fn(),
    onSelectTier: vi.fn(),
    onStart: vi.fn(),
    ...over,
  };
}

describe('PaperPositionPanel', () => {
  it('渲染年级/学期/共 28 题/可练数，点题号与档位', () => {
    const p = props();
    render(<PaperPositionPanel {...p} />);
    expect(screen.getByLabelText('年级')).toHaveValue('初三');
    expect(screen.getByLabelText('学期')).toHaveValue('first');
    expect(screen.getByText('共 28 题')).toBeTruthy();
    expect(screen.getByRole('button', { name: '第1题，可练5题' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '第1题，可练5题' }));
    expect(p.onSelectQuestionNo).toHaveBeenCalledWith(1);

    fireEvent.click(screen.getByRole('button', { name: /^3 题/ }));
    expect(p.onSelectTier).toHaveBeenCalledWith('3');
    fireEvent.click(screen.getByRole('button', { name: '开始练习' }));
    expect(p.onStart).toHaveBeenCalled();
  });

  it('可练 0 的题号禁用', () => {
    render(<PaperPositionPanel {...props()} />);
    expect(screen.getByRole('button', { name: '第25题，可练0题' })).toBeDisabled();
  });

  it('无可用试卷 / 无可练题 / 无档位三种空态', () => {
    const { rerender } = render(<PaperPositionPanel {...props({ options: [] })} />);
    expect(screen.getByText('暂无可用试卷。')).toBeTruthy();
    rerender(<PaperPositionPanel {...props({ positions: [] })} />);
    expect(screen.getByText('该年级学期暂无可练题目。')).toBeTruthy();
    rerender(<PaperPositionPanel {...props({ eligibleTiers: [], tierKey: null })} />);
    expect(screen.getByText('家长未开启可用题量档位，暂不能开练。')).toBeTruthy();
  });

  it('未选题号：开始禁用并提示', () => {
    render(<PaperPositionPanel {...props({ selectedQuestionNo: null, eligibleTiers: [], tierKey: null })} />);
    expect(screen.getByText('请先选择题号')).toBeTruthy();
    expect(screen.getByRole('button', { name: '开始练习' })).toBeDisabled();
  });

  it('选项加载失败：固定文案 + 重试', () => {
    const p = props({ optionsStatus: 'error', optionsError: '试卷题号加载失败' });
    render(<PaperPositionPanel {...p} />);
    expect(screen.getByText('试卷题号加载失败')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(p.onRetryOptions).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/student/training/PaperPositionPanel.test.tsx`
Expected: FAIL（文件不存在）。

- [ ] **Step 3: 实现面板**

新建 `PaperPositionPanel.tsx`：

```tsx
import { Button, Card, Skeleton } from '@/components/base';
import type {
  PointRuleTier,
  TrainingPaperPosition,
  TrainingPaperPositionOption,
  TrainingSemester,
} from '@/services/api';
import { tierStatus } from './point-tiers';
import { TierChip } from './TierChip';

export const SEMESTER_LABELS: Record<TrainingSemester, string> = {
  first: '上学期',
  second: '下学期',
};

export interface PaperPositionPanelProps {
  options: TrainingPaperPositionOption[];
  optionsStatus: 'idle' | 'loading' | 'ok' | 'error';
  optionsError: string | null;
  grade: string | null;
  semester: TrainingSemester | null;
  onSelectGrade: (grade: string) => void;
  onSelectSemester: (semester: TrainingSemester) => void;
  positionsStatus: 'idle' | 'loading' | 'ok' | 'error';
  positionsError: string | null;
  positions: TrainingPaperPosition[];
  typicalQuestionCount: number | null;
  selectedQuestionNo: number | null;
  onSelectQuestionNo: (questionNo: number) => void;
  tiers: PointRuleTier[] | null;
  tiersError: string | null;
  eligibleTiers: PointRuleTier[];
  tierKey: string | null;
  starting: boolean;
  startError: string | null;
  emptyHint: boolean;
  onRetryOptions: () => void;
  onRetryPositions: () => void;
  onRetryTiers: () => void;
  onSelectTier: (key: string) => void;
  onStart: () => void;
}

const selectClassName =
  'h-10 px-3 rounded-[var(--radius-button)] border border-[var(--learn-card-border)] ' +
  'bg-[var(--learn-card-bg)] text-[var(--learn-text-primary)] text-sm ' +
  'focus:outline-none focus:ring-2 focus:ring-[var(--brand-100)]';

export function PaperPositionPanel(props: PaperPositionPanelProps) {
  const {
    options, optionsStatus, optionsError, grade, semester,
    onSelectGrade, onSelectSemester,
    positionsStatus, positionsError, positions, typicalQuestionCount,
    selectedQuestionNo, onSelectQuestionNo,
    tiers, tiersError, eligibleTiers, tierKey,
    starting, startError, emptyHint,
    onRetryOptions, onRetryPositions, onRetryTiers, onSelectTier, onStart,
  } = props;

  if (optionsStatus === 'idle' || optionsStatus === 'loading') {
    return (
      <Card className="mt-6 space-y-4 bg-[var(--learn-card-bg)] border border-[var(--learn-card-border)]">
        <Skeleton width="40%" height={18} />
        <Skeleton height={44} />
      </Card>
    );
  }
  if (optionsStatus === 'error') {
    return (
      <Card className="mt-6 space-y-4 bg-[var(--learn-card-bg)] border border-[var(--learn-card-border)]">
        <p className="text-sm text-[var(--learn-text-secondary)]">
          {optionsError ?? '试卷题号加载失败'}
        </p>
        <Button variant="secondary" size="sm" onClick={onRetryOptions}>重试</Button>
      </Card>
    );
  }
  if (options.length === 0) {
    return (
      <Card className="mt-6 space-y-4 bg-[var(--learn-card-bg)] border border-[var(--learn-card-border)]">
        <p className="text-sm text-[var(--learn-text-secondary)]">暂无可用试卷。</p>
        <Button variant="primary" size="lg" disabled>开始练习</Button>
      </Card>
    );
  }

  const grades = Array.from(new Set(options.map((o) => o.grade)));
  const semesters = options.filter((o) => o.grade === grade);
  const allZero = positions.length === 0
    || positions.every((p) => p.wrongCount + p.untriedCount === 0);
  const canStart = selectedQuestionNo != null
    && tierKey != null
    && eligibleTiers.some((t) => t.tierKey === tierKey)
    && !starting;

  return (
    <Card className="mt-6 space-y-6 bg-[var(--learn-card-bg)] border border-[var(--learn-card-border)]">
      <div className="flex flex-wrap items-end gap-6">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-[var(--learn-text-secondary)]">年级</span>
          <select
            aria-label="年级"
            value={grade ?? ''}
            onChange={(e) => onSelectGrade(e.target.value)}
            className={selectClassName}
          >
            {grades.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-[var(--learn-text-secondary)]">学期</span>
          <select
            aria-label="学期"
            value={semester ?? ''}
            onChange={(e) => onSelectSemester(e.target.value as TrainingSemester)}
            className={selectClassName}
          >
            {semesters.map((o) => (
              <option key={o.semester} value={o.semester}>{SEMESTER_LABELS[o.semester]}</option>
            ))}
          </select>
        </label>
      </div>

      <section aria-label="题号选择">
        <div className="flex items-baseline gap-2 mb-3">
          <h2 className="text-sm font-semibold text-[var(--learn-text-secondary)]">题号</h2>
          {typicalQuestionCount != null && (
            <span className="text-xs text-[var(--learn-text-tertiary)]">共 {typicalQuestionCount} 题</span>
          )}
        </div>
        {positionsStatus === 'loading' || positionsStatus === 'idle' ? (
          <Skeleton height={96} />
        ) : positionsStatus === 'error' ? (
          <div className="flex items-center gap-4">
            <p className="text-sm text-[var(--learn-text-secondary)]">
              {positionsError ?? '试卷题号加载失败'}
            </p>
            <Button variant="secondary" size="sm" onClick={onRetryPositions}>重试</Button>
          </div>
        ) : allZero ? (
          <p className="text-sm text-[var(--learn-text-secondary)]">该年级学期暂无可练题目。</p>
        ) : (
          <div className="grid grid-cols-7 sm:grid-cols-10 gap-2">
            {positions.map((p) => {
              const available = p.wrongCount + p.untriedCount;
              const disabled = available === 0;
              const active = selectedQuestionNo === p.questionNo;
              return (
                <button
                  key={p.questionNo}
                  type="button"
                  disabled={disabled}
                  aria-pressed={active}
                  aria-label={`第${p.questionNo}题，可练${available}题`}
                  onClick={() => onSelectQuestionNo(p.questionNo)}
                  className={
                    'flex flex-col items-center justify-center gap-0.5 h-14 rounded-[var(--radius-button)] border transition-colors ' +
                    (disabled
                      ? 'cursor-not-allowed border-[var(--learn-card-border)] bg-[var(--bg-base)] text-[var(--learn-text-tertiary)] opacity-70'
                      : active
                        ? 'border-[var(--brand-500)] bg-[var(--brand-100)] text-[var(--learn-text-primary)]'
                        : 'border-[var(--learn-card-border)] bg-[var(--learn-card-bg)] text-[var(--learn-text-primary)] hover:border-[var(--brand-500)]')
                  }
                >
                  <span className="text-sm font-semibold leading-none">{p.questionNo}</span>
                  <span className="text-[10px] leading-none text-[var(--learn-text-tertiary)]">
                    {disabled ? '暂无' : `可练 ${available}`}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {selectedQuestionNo != null && (
        <section aria-label="题量选择">
          <span className="text-xs font-medium text-[var(--learn-text-secondary)]">题量</span>
          {tiersError ? (
            <div className="mt-2 flex items-center gap-3">
              <p className="text-sm text-[var(--learn-text-secondary)]">{tiersError}</p>
              <Button variant="secondary" size="sm" onClick={onRetryTiers}>重试</Button>
            </div>
          ) : tiers == null ? (
            <div className="mt-2 flex flex-wrap gap-2" data-testid="paper-tier-skeleton">
              <Skeleton width={72} height={44} rounded />
              <Skeleton width={72} height={44} rounded />
            </div>
          ) : eligibleTiers.length === 0 ? (
            <p className="mt-2 text-sm text-[var(--learn-text-secondary)]">
              家长未开启可用题量档位，暂不能开练。
            </p>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              {eligibleTiers.map((t) => {
                const { text, capped } = tierStatus(t);
                return (
                  <TierChip
                    key={t.tierKey}
                    label={t.tierLabel}
                    points={t.points}
                    status={text}
                    active={tierKey === t.tierKey}
                    capped={capped}
                    onClick={() => onSelectTier(t.tierKey)}
                  />
                );
              })}
            </div>
          )}
        </section>
      )}

      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-4">
          <Button
            variant="primary"
            size="lg"
            loading={starting}
            disabled={!canStart}
            onClick={onStart}
          >
            {starting ? '开练中…' : '开始练习'}
          </Button>
          {selectedQuestionNo == null && !starting && (
            <span className="text-xs text-[var(--learn-text-tertiary)]">请先选择题号</span>
          )}
        </div>
        {startError && <p className="text-sm text-[var(--error)]">{startError}</p>}
        {emptyHint && (
          <p className="text-sm text-[var(--learn-text-secondary)]">
            该题号暂时没有可练的题。
          </p>
        )}
      </section>
    </Card>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/pages/student/training/PaperPositionPanel.test.tsx`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/pages/student/training/PaperPositionPanel.tsx apps/web/src/pages/student/training/PaperPositionPanel.test.tsx
git commit -m "feat(web): 试卷题号选择面板"
```

---

### Task 8: 接入 `TargetedConfigPage`

**Files:**
- Modify: `apps/web/src/pages/student/training/TargetedConfigPage.tsx`
- Test: `apps/web/src/pages/student/training/TargetedConfigPage.test.tsx`

**Interfaces:**
- Consumes: Task 6 `getPaperPositions` / `StartTargetedPayload` 第三分支；Task 7 `PaperPositionPanel` / `SEMESTER_LABELS`
- Produces: 无对外接口，行为变更

- [ ] **Step 1: 写失败测试**

在 `TargetedConfigPage.test.tsx` 顶部 import 里加入 `getPaperPositions`，在 `vi.mock('@/services/api', ...)` 的返回对象里加入 `getPaperPositions: vi.fn(),`，并在 `const getModelSpecialsMock = ...` 之后加一行：

```ts
const getPaperPositionsMock = vi.mocked(getPaperPositions);
```

追加：

```tsx
describe('试卷题号模式', () => {
  const POSITIONS = [
    { questionNo: 1, total: 5, wrongCount: 2, untriedCount: 3 },
    { questionNo: 24, total: 6, wrongCount: 1, untriedCount: 1 },
  ];

  beforeEach(() => {
    getKpsMock.mockResolvedValue(KPS);
    getRulesMock.mockResolvedValue(rulesOf(MATH_TIERS));
    getPaperPositionsMock.mockReset();
    getPaperPositionsMock.mockResolvedValue({
      options: [
        { grade: '初三', semester: 'first', paperCount: 7, typicalQuestionCount: 28 },
      ],
      grade: null, semester: null, typicalQuestionCount: null, positions: [],
    });
    startMock.mockReset();
    startMock.mockResolvedValue({ questions: [STARTED_QUESTION], sessionId: 9 });
  });

  it('切到试卷题号：拉选项+清单，选题号与档位后按 paper 字段开练', async () => {
    getPaperPositionsMock.mockImplementation(async (_s, grade) => grade
      ? { options: [{ grade: '初三', semester: 'first', paperCount: 7, typicalQuestionCount: 28 }],
          grade: '初三', semester: 'first', typicalQuestionCount: 28, positions: POSITIONS }
      : { options: [{ grade: '初三', semester: 'first', paperCount: 7, typicalQuestionCount: 28 }],
          grade: null, semester: null, typicalQuestionCount: null, positions: [] });

    await renderPage('/?subjectId=1');
    fireEvent.click(screen.getByRole('button', { name: '试卷题号' }));
    await waitFor(() => expect(getPaperPositionsMock).toHaveBeenCalledWith(1, '初三', 'first'));

    fireEvent.click(await screen.findByRole('button', { name: '第24题，可练2题' }));
    // 可练 2 题：只应出现 1/2 档，3 档不可选
    await waitFor(() => expect(screen.getByRole('button', { name: /^1 题/ })).toBeTruthy());
    expect(screen.queryByRole('button', { name: /^3 题/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^2 题/ }));
    fireEvent.click(screen.getByRole('button', { name: '开始练习' }));

    await waitFor(() => expect(startMock).toHaveBeenCalledWith({
      subjectId: 1,
      grade: '初三',
      semester: 'first',
      paperQuestionNo: 24,
      type: null,
      count: 2,
    }));
  });

  it('非数学不显示试卷题号入口', async () => {
    getKpsMock.mockResolvedValue(KPS);
    getRulesMock.mockResolvedValue(rulesOf(MATH_TIERS));
    await renderPage('/?subjectId=2');
    expect(screen.queryByRole('button', { name: '试卷题号' })).toBeNull();
  });
});
```

若 `renderPage` 默认参数不含 `subjectId`，用例里用 `'/?subjectId=1'` / `'/?subjectId=2'` 显式给出。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/student/training/TargetedConfigPage.test.tsx -t "试卷题号"`
Expected: FAIL（找不到按钮）。

- [ ] **Step 3: 实现页面接入**

`TargetedConfigPage.tsx` 的 import 补：

```ts
import { getPaperPositions, type TrainingPaperPosition, type TrainingPaperPositionOption, type TrainingSemester } from '@/services/api';
import { PaperPositionPanel, SEMESTER_LABELS } from './PaperPositionPanel';
```

`mode` 类型改为 `'kp' | 'model' | 'paper'`，并新增状态：

```ts
  const [paperStatus, setPaperStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [paperError, setPaperError] = useState<string | null>(null);
  const [paperOptions, setPaperOptions] = useState<TrainingPaperPositionOption[]>([]);
  const [paperGrade, setPaperGrade] = useState<string | null>(null);
  const [paperSemester, setPaperSemester] = useState<TrainingSemester | null>(null);
  const [posStatus, setPosStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [posError, setPosError] = useState<string | null>(null);
  const [paperPositions, setPaperPositions] = useState<TrainingPaperPosition[]>([]);
  const [typicalQuestionCount, setTypicalQuestionCount] = useState<number | null>(null);
  const [paperQuestionNo, setPaperQuestionNo] = useState<number | null>(null);
  const [paperTierKey, setPaperTierKey] = useState<string | null>(null);
```

新增加载函数（放在 `loadModelSpecials` 之后）：

```ts
  const loadPaperOptions = useCallback(async () => {
    const requested = subjectId;
    setPaperStatus('loading');
    setPaperError(null);
    try {
      const data = await getPaperPositions(requested);
      if (subjectIdRef.current !== requested) return;
      setPaperOptions(data.options);
      const first = data.options[0] ?? null;
      setPaperGrade(first?.grade ?? null);
      setPaperSemester(first?.semester ?? null);
      setPaperQuestionNo(null);
      setPaperTierKey(null);
      setPaperStatus('ok');
    } catch {
      if (subjectIdRef.current !== requested) return;
      setPaperStatus('error');
      setPaperError('试卷题号加载失败');
      setPaperOptions([]);
      setPaperGrade(null);
      setPaperSemester(null);
    }
  }, [subjectId]);

  const loadPaperPositions = useCallback(async (
    subject: number, grade: string, semester: TrainingSemester,
  ) => {
    setPosStatus('loading');
    setPosError(null);
    try {
      const data = await getPaperPositions(subject, grade, semester);
      if (subjectIdRef.current !== subject) return;
      setPaperPositions(data.positions);
      setTypicalQuestionCount(data.typicalQuestionCount);
      setPosStatus('ok');
    } catch {
      if (subjectIdRef.current !== subject) return;
      setPosStatus('error');
      setPosError('试卷题号加载失败');
      setPaperPositions([]);
      setTypicalQuestionCount(null);
    }
  }, []);
```

加 effect（放在现有 `subjectId` 重置 effect 里补重置，并新增位置加载 effect）：

```ts
  // 学科变化：试卷题号状态全部清空（与模型模式一致）
  useEffect(() => {
    setPaperStatus('idle');
    setPaperError(null);
    setPaperOptions([]);
    setPaperGrade(null);
    setPaperSemester(null);
    setPosStatus('idle');
    setPosError(null);
    setPaperPositions([]);
    setTypicalQuestionCount(null);
    setPaperQuestionNo(null);
    setPaperTierKey(null);
  }, [subjectId]);

  useEffect(() => {
    if (mode !== 'paper' || !paperGrade || !paperSemester) return;
    setPaperQuestionNo(null);
    setPaperTierKey(null);
    void loadPaperPositions(subjectId, paperGrade, paperSemester);
  }, [mode, subjectId, paperGrade, paperSemester, loadPaperPositions]);
```

档位计算（放在 `eligibleModelTiers` 之后）：

```ts
  const selectedPosition = useMemo(
    () => paperPositions.find((p) => p.questionNo === paperQuestionNo) ?? null,
    [paperPositions, paperQuestionNo],
  );
  const paperAvailable = selectedPosition
    ? selectedPosition.wrongCount + selectedPosition.untriedCount
    : 0;
  const eligiblePaperTiers = useMemo(() => {
    if (!selectedPosition || tiers == null) return [];
    return tiers.filter((t) => {
      const n = Number(t.tierKey);
      return Number.isInteger(n) && n >= 1 && n <= paperAvailable;
    });
  }, [selectedPosition, tiers, paperAvailable]);

  useEffect(() => {
    if (mode !== 'paper') return;
    if (!selectedPosition || eligiblePaperTiers.length === 0) {
      setPaperTierKey(null);
      return;
    }
    if (paperTierKey == null || !eligiblePaperTiers.some((t) => t.tierKey === paperTierKey)) {
      const count = pickPracticeCount(eligiblePaperTiers);
      setPaperTierKey(count == null ? null : String(count));
    }
  }, [mode, selectedPosition, eligiblePaperTiers, paperTierKey]);
```

`selectMode` 改为支持 `'paper'`：

```ts
  const selectMode = (next: 'kp' | 'model' | 'paper') => {
    setMode(next);
    setStartError(null);
    setEmptyHint(false);
    if (next === 'model' && modelStatus === 'idle') void loadModelSpecials();
    if (next === 'paper' && paperStatus === 'idle') void loadPaperOptions();
  };
```

开练函数：

```ts
  const canStartPaper = paperQuestionNo != null
    && paperGrade != null
    && paperSemester != null
    && paperTierKey != null
    && eligiblePaperTiers.some((t) => t.tierKey === paperTierKey)
    && !starting;

  const startPaperPractice = async () => {
    if (!canStartPaper || paperQuestionNo == null || paperGrade == null || paperSemester == null || paperTierKey == null) return;
    setStarting(true);
    setStartError(null);
    setEmptyHint(false);
    try {
      const res = await startTargetedPractice({
        subjectId,
        grade: paperGrade,
        semester: paperSemester,
        paperQuestionNo,
        type: null,
        count: Number(paperTierKey),
      });
      if (res.questions.length === 0) {
        setEmptyHint(true);
        return;
      }
      const handoff: TargetedRunHandoff = {
        sessionId: res.sessionId,
        questions: res.questions,
        title: `${paperGrade}${SEMESTER_LABELS[paperSemester]} · 第${paperQuestionNo}题`,
      };
      sessionStorage.setItem('training:targeted', JSON.stringify(handoff));
      navigate(`/student/training/targeted/run${subjectQuery}`);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : '开练失败，请重试');
    } finally {
      setStarting(false);
    }
  };
```

类型组加第三个 Chip：

```tsx
              <KpChip label="试卷题号" active={mode === 'paper'} onClick={() => selectMode('paper')} />
```

配置区加分支：

```tsx
          {mode === 'paper' && (
            <PaperPositionPanel
              options={paperOptions}
              optionsStatus={paperStatus}
              optionsError={paperError}
              grade={paperGrade}
              semester={paperSemester}
              onSelectGrade={(g) => {
                setPaperGrade(g);
                const next = paperOptions.find((o) => o.grade === g);
                if (next) setPaperSemester(next.semester);
              }}
              onSelectSemester={setPaperSemester}
              positionsStatus={posStatus}
              positionsError={posError}
              positions={paperPositions}
              typicalQuestionCount={typicalQuestionCount}
              selectedQuestionNo={paperQuestionNo}
              onSelectQuestionNo={(n) => { setPaperQuestionNo(n); setEmptyHint(false); }}
              tiers={tiers}
              tiersError={tiersError}
              eligibleTiers={eligiblePaperTiers}
              tierKey={paperTierKey}
              starting={starting}
              startError={startError}
              emptyHint={emptyHint}
              onRetryOptions={() => void loadPaperOptions()}
              onRetryPositions={() => {
                if (paperGrade && paperSemester) void loadPaperPositions(subjectId, paperGrade, paperSemester);
              }}
              onRetryTiers={() => void loadTiers()}
              onSelectTier={(k) => { setPaperTierKey(k); setEmptyHint(false); }}
              onStart={() => void startPaperPractice()}
            />
          )}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/pages/student/training/TargetedConfigPage.test.tsx`
Expected: PASS（新增用例 + 既有用例）。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/pages/student/training/TargetedConfigPage.tsx apps/web/src/pages/student/training/TargetedConfigPage.test.tsx
git commit -m "feat(web): 专项练习接入试卷题号模式"
```

---

### Task 9: 文档同步、全量回归与冒烟

**Files:**
- Modify: `docs/API接口与数据流设计文档.md`
- Modify: `docs/api/openapi.yaml`
- Modify: `docs/ai-core-changelog.md`

- [ ] **Step 1: 同步 API 设计文档**

在 §4.18 Training 端点表 `model-specials` 行之后新增一行：

```md
| GET | `/api/training/paper-positions?subjectId={subjectId}&grade={grade}&semester={semester}` | 试卷题号选项与题号清单（student JWT）。`subjectId` 必填且**仅支持 1（数学）**，否则 400；`grade`/`semester` 必须同时给或同时不给，`semester` 仅 `first`/`second`。响应 `{options: [{grade, semester, paperCount, typicalQuestionCount}], grade, semester, typicalQuestionCount, positions: [{questionNo, total, wrongCount, untriedCount}]}`。`typicalQuestionCount` 是该年级学期卷面题数的众数（并列取较大），`positions` 固定为 1..该值，无题题号补 0；`total` 已排除该生「不再展示」；`wrongCount` 是未清错题本中的题数；`untriedCount` 是错题本无未清行且专项/考试/主线三处均无已判记录的题数。 | MVP |
```

更新 `POST /api/training/targeted/start` 行：在 `kpId` 与 `category+model` 后补「`paperQuestionNo+grade+semester` **三选一**」、paper 模式 `subjectId=1`、`type` 必须 null、题号范围 1..typicalQuestionCount、不足 400 `该题号可练题数不足（当前 N 题）`、会话 `ref_type='paper_position'` + `ref_id=题号`。

在 §5 的「模型专项」段之后补：

```md
**试卷题号（2026-11-18）**：专项页切到「试卷题号」→ `GET /api/training/paper-positions?subjectId=1` 取年级/学期选项 → 选年级+学期后再取 1..N 题号清单（每题带错题数/未做数）→ 选题号与家长已开档位（≤可练数）→ `POST /api/training/targeted/start` 传 `{grade, semester, paperQuestionNo, type:null, count}` → 服务端先取未清错题本中的同题号题（level 降序、同级别最近答错在前），不足再用从未做过的同题号题补足；仍不足 400 → 建 `training_sessions`（`math_targeted`, `ref_type='paper_position'`, `ref_id=题号`）→ 复用 `TargetedRunPage`。
```

- [ ] **Step 2: 同步 openapi.yaml**

在 `/training/model-specials` 之后新增：

```yaml
  /training/paper-positions:
    get:
      tags: [Training]
      summary: 试卷题号选项与题号清单
      description: >-
        student JWT。subjectId 仅支持 1（数学），否则 400。grade 与 semester 必须同时出现；
        semester 仅 first/second。typicalQuestionCount 是该年级学期卷面题数的众数（并列取较大），
        positions 固定为 1..该值，无题题号三个数都为 0。
      operationId: listPaperPositions
      security: [{ bearerAuth: [] }]
      parameters:
        - in: query
          name: subjectId
          required: true
          schema: { type: integer, enum: [1] }
        - in: query
          name: grade
          required: false
          schema: { type: string }
        - in: query
          name: semester
          required: false
          schema: { type: string, enum: [first, second] }
      responses:
        '200':
          description: 选项与题号清单
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/CommonResponse'
                  - type: object
                    properties:
                      data:
                        $ref: '#/components/schemas/PaperPositionsResult'
        '400':
          description: 非数学 / grade 与 semester 只给一个 / 组合不存在
```

在 `components.schemas` 中 `TargetedStartRequest` 之前新增：

```yaml
    PaperPositionsResult:
      type: object
      properties:
        options:
          type: array
          items:
            type: object
            properties:
              grade: { type: string }
              semester: { type: string, enum: [first, second] }
              paperCount: { type: integer }
              typicalQuestionCount: { type: integer }
        grade: { type: string, nullable: true }
        semester: { type: string, nullable: true, enum: [first, second] }
        typicalQuestionCount: { type: integer, nullable: true }
        positions:
          type: array
          items:
            type: object
            properties:
              questionNo: { type: integer }
              total: { type: integer }
              wrongCount: { type: integer }
              untriedCount: { type: integer }
```

扩展 `TargetedStartRequest`：

```yaml
      description: kpId / category+model / paperQuestionNo+grade+semester 三选一；模型与 paper 模式 type 必须 null。
```

properties 追加：

```yaml
        paperQuestionNo: { type: integer, description: 卷面题号；必须与 grade、semester 同时出现 }
        grade: { type: string, description: 年级；必须与 semester、paperQuestionNo 同时出现 }
        semester: { type: string, enum: [first, second], description: 学期 }
```

- [ ] **Step 3: 跑后端全量测试**

Run: `cd apps/server && npm test`
Expected: 全部 PASS（含 2712+ 既有用例）。

- [ ] **Step 4: 跑前端全量测试与构建**

Run: `cd apps/web && npm test && npm run build`
Expected: 全部 PASS，`tsc -b + vite` 无错误。

- [ ] **Step 5: 冒烟（真实服务）**

1. 构建后端并启动：`cd apps/server && npm run build && node dist/main.js`。
2. 用测试学生登录（沿用仓库现有学生账号），进入「训练 → 数学 → 专项练习 → 试卷题号」。
3. 选「初三 / 上学期 / 第 24 题」：页面应显示「共 28 题」，第 24 题可练数 = 错题数 + 未做数。
4. 开局 3 题：前两道必须是错题本里 level 高的 24 题（可在错题本对照），第三道是未做过的 24 题。
5. 作答页每题显示「来源：… · 试卷第 24 题」；做完按档位发分；答错进错题本。
6. 再到题号清单，第 24 题可练数应减少对应数量。

- [ ] **Step 6: 补 changelog 并提交**

在 `docs/ai-core-changelog.md` 顶部按现有格式追加一条 2026-11-18 记录（背景、改动文件、验证结果、已知限制：题号只近似同题型、错题级别≠次数）。

```bash
git add docs/API接口与数据流设计文档.md docs/api/openapi.yaml docs/ai-core-changelog.md
git commit -m "docs: 同步试卷题号专项接口与数据流"
```

---

## Self-Review

- **Spec coverage**：入口/四段选择 → Task 7–8；选项与众数 → Task 1/3；错题优先 + 未做补足 → Task 2/4；只数学/校验 → Task 3/5；无 schema → 全局约束；判题/积分/错题本复用 → Task 8 不改既有链路；文档 → Task 9；测试 → 每个任务内。
- **Placeholder scan**：无 TBD/TODO；所有代码步骤都有可执行代码。
- **Type consistency**：仓储方法名、服务方法名、前端类型名在跨任务引用处保持一致；`TrainingSemester` 在 API 层定义、面板与页面复用。
- **已知前提**：`TargetedConfigPage.test.tsx` 的 `renderPage` 已存在；`mk` 工厂按 Step 1 扩展；`QuestionRow` 从 `database/repositories/types.js` 导入。
