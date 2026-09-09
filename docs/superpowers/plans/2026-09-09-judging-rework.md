# 判题体系重构（服务端 + 前端）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 主观题（short_answer/proof）由 AI 判对错改为学生对照参考答案自评（`JUDGE_SUBJECTIVE_MODE=self_assess` 默认，`ai` 保留可切回），新增 calculation 题型与自评数据链路，考试/专项/错题/课堂练习四场景全量接通。

**Architecture:** 在 `JudgeCoreService` 三路由上扩为四路由（新增主观题 self_assess 早退分支）；自评落库统一走 `JudgeCoreService.recordSelfAssessment`（留痕 `question_self_assessments` + 错题本写入/清零，门禁零改动）；考试主观题不判只存 `is_correct=NULL`，结果页自评；前端 `QuestionRunner` 对主观题改为同步提交 + 自评视图，`AnswerResultList` 主观题条目无对错状态。

**Tech Stack:** NestJS + mysql2 + Vitest（apps/server）；React 19 + Vite + Testing Library（apps/web）。

**设计文档:** `docs/superpowers/specs/2026-09-09-judging-rework-design.md`（冲突以 spec 为准）

**配套计划:** `docs/superpowers/plans/2026-09-09-answer-importer.md`（answer_importer CLI，可独立先行/后行，无代码依赖）

**关键现状（已核实）:**

- `JudgeCoreService`（`apps/server/src/modules/practice/judge-core.service.ts`）：题中心 `judgeQuestion`（训练/考试用）+ 卡中心 `judgeForPractice`（课堂练习用）；路由 1 exact（choice/true_false）→ 路由 1b fill_blank 归一化相等 → 路由 2 AI（fill_blank 不等/short_answer/proof）；答错入错题本 `findUnclearedByStudentQuestionId`/`create`，答对 `clearUnclearedByStudentQuestionId`。
- `QuestionRunner`（`apps/web/src/components/business/answer/QuestionRunner.tsx`）为 fire-and-forget 判题：提交即切下一题；消费方：TargetedRunPage / ErrorPracticeRunPage / ExamRunPage（`showResultFeedback={false}`）/ AnswerModal（modal）/ CleanupPhase。
- `practice_results.is_correct` **NOT NULL**——主观题 self_assess 模式下判题时不能落行，须推迟到自评端点。
- 仓库约定：repo 经 `@Inject('DATABASE_POOL')` 注入 Pool；`PracticeModule` providers 逐个列出 repo，`exports: [PracticeService, JudgeCoreService, ExplanationCacheService]`；Training/Exams 模块 import PracticeModule 复用 JudgeCoreService。
- DTO 均为 interface（`import type`），参数校验在 controller 手写（见 `training.controller.ts`）。
- ResponseInterceptor 把返回包成 `{code:0, data}`，前端 `fetchApi` 解包。

---

### Task 1: DB migration — question_self_assessments 表

**Files:**
- Create: `tools/db/migrations/2026-09-09_add_question_self_assessments.sql`
- Modify: `tools/db/schema.sql`（折回，先例：训练模块表区块注释「install_mysql.sh 只执行 schema.sql，迁移需同步折回」）
- Modify: `docs/K12智学系统-数据库设计文档.md`

- [ ] **Step 1: 写迁移文件**

`tools/db/migrations/2026-09-09_add_question_self_assessments.sql`：

```sql
-- 2026-09-09 判题体系重构：主观题学生自评留痕表
-- 设计：docs/superpowers/specs/2026-09-09-judging-rework-design.md §7.2
CREATE TABLE IF NOT EXISTS question_self_assessments (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  question_id BIGINT NOT NULL,
  assessment VARCHAR(10) NOT NULL,        -- 'correct' | 'incorrect'
  source VARCHAR(20) NOT NULL,            -- 'targeted' | 'error_practice' | 'exam' | 'practice'
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_qsa_student_question (student_id, question_id),
  CONSTRAINT fk_qsa_student FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_qsa_question FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 2: 折回 schema.sql**

在 `tools/db/schema.sql` 的 `practice_results` 表（:555-579）之后、`error_redo_logs` 之前插入同一份 CREATE TABLE，并带区块注释：

```sql
-- 学生主观题自评留痕（判题体系重构 2026-09-09）：short_answer/proof 在 self_assess 模式下
-- 由学生对照参考答案自评对错；每次自评留痕（学情分析 / 自评 vs AI 一致率数据源）。
-- 折回自 migrations/2026-09-09_add_question_self_assessments.sql。
```

- [ ] **Step 3: 应用到本地库**

```bash
mysql -u ai_k12 -pai_k12 ai_k12 < tools/db/migrations/2026-09-09_add_question_self_assessments.sql
mysql -u ai_k12 -pai_k12 ai_k12 -e "SHOW CREATE TABLE question_self_assessments\G"
```

Expected: 表存在，含 `idx_qsa_student_question` 索引与两个 FK。

- [ ] **Step 4: 更新 DB 设计文档**

在 `docs/K12智学系统-数据库设计文档.md` 中 questions 相关表章节（`grep -n "practice_results" docs/K12智学系统-数据库设计文档.md` 定位插入点）加入与 schema.sql 相同的字段说明表；`exam_answers.method` 的注释同步扩为 `exact | ai | self_assess | unanswered | failed`（后文 Task 3 会用到 `self_assess`/`unanswered` 取值），`practice_results.method` 注释扩为 `exact | ai | self_assess | unanswered`。

- [ ] **Step 5: Commit**

```bash
git add tools/db/migrations/2026-09-09_add_question_self_assessments.sql tools/db/schema.sql docs/K12智学系统-数据库设计文档.md
git commit -m "feat(db): question_self_assessments 自评留痕表（判题体系重构）"
```

---

### Task 2: QuestionSelfAssessmentsRepository

**Files:**
- Create: `apps/server/src/database/repositories/question-self-assessments.repo.ts`
- Modify: `apps/server/src/database/repositories/index.ts`
- Test: `apps/server/src/database/repositories/question-self-assessments.repo.test.ts`

- [ ] **Step 1: 写失败测试**（mockPool 模式照抄 `student-hidden-questions.repo.test.ts`）

```typescript
import { describe, it, expect, vi } from 'vitest';
import { QuestionSelfAssessmentsRepository } from './question-self-assessments.repo';

const mockPool = (rows: any[] = [], insertId = 1) => ({
  execute: vi.fn().mockImplementation((sql: string) =>
    Promise.resolve(
      sql.trim().toUpperCase().startsWith('SELECT')
        ? [rows, []]
        : [{ insertId, affectedRows: 1 }, []],
    ) as any),
  query: vi.fn().mockResolvedValue([rows, []] as any),
});

describe('QuestionSelfAssessmentsRepository.create', () => {
  it('INSERT 四列，参数 (studentId, questionId, assessment, source)', async () => {
    const pool = mockPool();
    const repo = new QuestionSelfAssessmentsRepository(pool as any);
    const id = await repo.create({ studentId: 7, questionId: 10, assessment: 'incorrect', source: 'targeted' });
    expect(id).toBe(1);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('INSERT INTO question_self_assessments');
    expect(sql).toContain('(student_id, question_id, assessment, source)');
    expect(params).toEqual([7, 10, 'incorrect', 'targeted']);
  });
});

describe('QuestionSelfAssessmentsRepository.findLatestByStudentAndQuestionIds', () => {
  it('空列表直接返回空 Map，不发 SQL', async () => {
    const pool = mockPool();
    const repo = new QuestionSelfAssessmentsRepository(pool as any);
    const m = await repo.findLatestByStudentAndQuestionIds(7, []);
    expect(m.size).toBe(0);
    expect(pool.execute).not.toHaveBeenCalled();
  });

  it('按 MAX(id) 取每题最近一次自评，返回 questionId -> assessment 映射', async () => {
    const pool = mockPool([
      { question_id: 10, assessment: 'incorrect' },
      { question_id: 12, assessment: 'correct' },
    ]);
    const repo = new QuestionSelfAssessmentsRepository(pool as any);
    const m = await repo.findLatestByStudentAndQuestionIds(7, [10, 11, 12]);
    expect(m.get(10)).toBe('incorrect');
    expect(m.get(11)).toBeUndefined();
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('MAX(id)');
    expect(sql).toContain('student_id = ?');
    expect(params).toEqual([7, 10, 11, 12]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/database/repositories/question-self-assessments.repo.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 repo**

```typescript
import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

/**
 * 学生主观题自评留痕 repo（判题体系重构 2026-09-09）。
 *
 * short_answer/proof 在 JUDGE_SUBJECTIVE_MODE=self_assess 下不判对错，学生对照参考答案
 * 自评「我做对了/我做错了」；每次自评写一行（不复用、不 upsert——历史自评序列是
 * 学情分析与「自评 vs AI 一致率」的数据源）。错题本写入/清零不在此 repo，
 * 见 JudgeCoreService.recordSelfAssessment。
 */
@Injectable()
export class QuestionSelfAssessmentsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async create(row: {
    studentId: number;
    questionId: number;
    assessment: 'correct' | 'incorrect';
    source: string;
  }): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO question_self_assessments (student_id, question_id, assessment, source)
       VALUES (?, ?, ?, ?)`,
      [row.studentId, row.questionId, row.assessment, row.source],
    );
    return result.insertId;
  }

  /** 每题最近一次自评（考试结果页恢复自评状态用）；空列表直接返回空 Map 不发 SQL。 */
  async findLatestByStudentAndQuestionIds(
    studentId: number,
    questionIds: number[],
  ): Promise<Map<number, 'correct' | 'incorrect'>> {
    if (questionIds.length === 0) return new Map();
    const placeholders = questionIds.map(() => '?').join(',');
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT qsa.question_id, qsa.assessment
       FROM question_self_assessments qsa
       JOIN (SELECT question_id, MAX(id) AS max_id
             FROM question_self_assessments
             WHERE student_id = ? AND question_id IN (${placeholders})
             GROUP BY question_id) latest ON latest.max_id = qsa.id`,
      [studentId, ...questionIds],
    );
    return new Map(rows.map((r) => [r.question_id as number, r.assessment as 'correct' | 'incorrect']));
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/database/repositories/question-self-assessments.repo.test.ts`
Expected: PASS（3 个用例）。

- [ ] **Step 5: 导出 + 注册**

`apps/server/src/database/repositories/index.ts` 按字母序插入：

```typescript
export { QuestionSelfAssessmentsRepository } from './question-self-assessments.repo.js';
```

`apps/server/src/modules/practice/practice.module.ts` providers 数组加入 `QuestionSelfAssessmentsRepository`（import 自 `../../database/repositories/index.js`）——JudgeCoreService（本模块）与 PracticeService 都要注入它。

- [ ] **Step 6: 全量测试 + tsc**

Run: `cd apps/server && npm test && npm run build`
Expected: 全绿（72+ 用例）、tsc 无错误。

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/database/repositories/ apps/server/src/modules/practice/practice.module.ts
git commit -m "feat(server): QuestionSelfAssessmentsRepository 自评留痕 repo"
```

---

### Task 3: JudgeCoreService 四路由 + recordSelfAssessment

**Files:**
- Modify: `apps/server/src/modules/practice/judge-core.service.ts`
- Test: `apps/server/src/modules/practice/judge-core.service.test.ts`（新建，此前无测试文件）

- [ ] **Step 1: 写失败测试**

新建 `apps/server/src/modules/practice/judge-core.service.test.ts`：

```typescript
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JudgeCoreService, subjectiveJudgeMode } from './judge-core.service';
import type { QuestionsRepository } from '../../database/repositories/questions.repo.js';
import type { MainErrorBooksRepository } from '../../database/repositories/main-error-books.repo.js';
import type { QuestionSelfAssessmentsRepository } from '../../database/repositories/question-self-assessments.repo.js';

/** 构造带 mock 依赖的 JudgeCoreService（capabilities 不会被 self_assess 路径触达，占位即可）。 */
function makeService(overrides: Partial<Record<'questions' | 'mainError' | 'selfAssess', any>> = {}) {
  const questions = overrides.questions ?? {
    findById: vi.fn(async () => null),
  };
  const mainError = overrides.mainError ?? {
    findUnclearedByStudentQuestionId: vi.fn(async () => null),
    create: vi.fn(async () => 101),
    clearUnclearedByStudentQuestionId: vi.fn(async () => {}),
  };
  const selfAssess = overrides.selfAssess ?? { create: vi.fn(async () => 1) };
  const svc = new JudgeCoreService(
    questions as unknown as QuestionsRepository,
    mainError as unknown as MainErrorBooksRepository,
    {} as any, // QuestionStructuringCapability（self_assess 路径不触达）
    {} as any, // JudgmentCapability（self_assess 路径不触达）
    {} as any, // ExplanationCacheService（self_assess 路径不触达）
    selfAssess as unknown as QuestionSelfAssessmentsRepository,
  );
  return { svc, questions, mainError, selfAssess };
}

const q = (type: string, answer = 'B', explanation: string | null = '解析文本') => ({
  id: 10, type, answer, explanation, options: null, content: '题面', subject_id: 1,
});

afterEach(() => { delete process.env.JUDGE_SUBJECTIVE_MODE; });

describe('subjectiveJudgeMode', () => {
  it('默认 self_assess；JUDGE_SUBJECTIVE_MODE=ai 切回', () => {
    delete process.env.JUDGE_SUBJECTIVE_MODE;
    expect(subjectiveJudgeMode()).toBe('self_assess');
    process.env.JUDGE_SUBJECTIVE_MODE = 'ai';
    expect(subjectiveJudgeMode()).toBe('ai');
  });
});

describe('judgeQuestion 四路由（self_assess 模式）', () => {
  it('short_answer：不判对错，返回 needsSelfAssessment + 参考答案/解析，不写错题本', async () => {
    const { svc, mainError } = makeService({
      questions: { findById: vi.fn(async () => q('short_answer', '过程…结果 x=3')) },
    });
    const out = await svc.judgeQuestion({ studentId: 7, subjectId: 1, questionId: 10, studentAnswer: 'x=3', source: 'targeted' });
    expect(out).toMatchObject({ questionId: 10, isCorrect: null, method: 'self_assess', needsSelfAssessment: true, referenceAnswer: '过程…结果 x=3', explanation: '解析文本' });
    expect(mainError.create).not.toHaveBeenCalled();
    expect(mainError.clearUnclearedByStudentQuestionId).not.toHaveBeenCalled();
  });

  it('proof 同样早退；calculation 走 fill_blank 同款归一化比对', async () => {
    const { svc } = makeService({
      questions: { findById: vi.fn(async () => q('calculation', '3')) },
    });
    const out = await svc.judgeQuestion({ studentId: 7, subjectId: 1, questionId: 10, studentAnswer: '3', source: 'targeted' });
    expect(out).toMatchObject({ isCorrect: true, method: 'exact' });
  });

  it('short_answer + JUDGE_SUBJECTIVE_MODE=ai：走 AI 判定（mock judgment）', async () => {
    const { svc } = makeService({
      questions: { findById: vi.fn(async () => q('short_answer')) },
    });
    // 动态替换 judgment capability（构造时传了 {}，运行时挂上）
    (svc as any).judgment = { judge: vi.fn(async () => ({ isCorrect: true, errorType: null })) };
    process.env.JUDGE_SUBJECTIVE_MODE = 'ai';
    const out = await svc.judgeQuestion({ studentId: 7, subjectId: 1, questionId: 10, studentAnswer: 'ans', source: 'targeted' });
    expect(out).toMatchObject({ isCorrect: true, method: 'ai' });
    expect((svc as any).judgment.judge).toHaveBeenCalledWith(expect.objectContaining({ questionType: 'calculation' }));
  });
});

describe('judgeForPractice 空答案守卫', () => {
  const input = { studentId: 7, subjectId: 1, cardId: 3, lessonId: 5, questionN: '0-1', questionText: '题面', studentAnswer: 'A' };

  it('choice 空答案：返回 noStandardAnswer，不入错题本不触发解析', async () => {
    const { svc, mainError } = makeService({
      questions: {}, // judgeForPractice 的 q 由 PracticeService 传入，不走 findById
    });
    (svc as any).explanationCache = { ensureExplanation: vi.fn() };
    const out = await svc.judgeForPractice(input, q('choice', '') as any);
    expect(out).toMatchObject({ isCorrect: null, method: 'unanswered', noStandardAnswer: true });
    expect(mainError.create).not.toHaveBeenCalled();
  });
});

describe('recordSelfAssessment', () => {
  it('incorrect：留痕 + find-or-create 错题本', async () => {
    const { svc, selfAssess, mainError } = makeService();
    const out = await svc.recordSelfAssessment({ studentId: 7, subjectId: 1, questionId: 10, assessment: 'incorrect', source: 'targeted' });
    expect(selfAssess.create).toHaveBeenCalledWith({ studentId: 7, questionId: 10, assessment: 'incorrect', source: 'targeted' });
    expect(mainError.create).toHaveBeenCalledWith(expect.objectContaining({ student_id: 7, question_id: 10, source: 'targeted' }));
    expect(out.errorBookId).toBe(101);
  });

  it('correct：留痕 + 清零未清错题（best-effort）', async () => {
    const { svc, mainError } = makeService();
    await svc.recordSelfAssessment({ studentId: 7, subjectId: 1, questionId: 10, assessment: 'correct', source: 'exam', sourceRefId: 55 });
    expect(mainError.clearUnclearedByStudentQuestionId).toHaveBeenCalledWith(7, 10);
    expect(mainError.create).not.toHaveBeenCalled();
  });
});
```

Run: `cd apps/server && npx vitest run src/modules/practice/judge-core.service.test.ts`
Expected: FAIL（subjectiveJudgeMode 未导出、recordSelfAssessment 不存在、构造参数不匹配）。

- [ ] **Step 2: 改造 judge-core.service.ts**

按下述要点修改（保持既有注释风格）：

2a. 顶部常量与模式函数（`EXACT_ONLY_TYPES` 之后）：

```typescript
/** 主观题（解答/证明）：self_assess 模式下不判对错，学生对照参考答案自评。 */
const SUBJECTIVE_TYPES = new Set(['short_answer', 'proof']);

/** 主观题判题模式：self_assess（默认，学生自评）| ai（现有 JudgmentCapability 判对错，
 *  预留国产模型能力提升后切回——只改环境变量，代码路径全保留）。 */
export type SubjectiveJudgeMode = 'self_assess' | 'ai';
export function subjectiveJudgeMode(): SubjectiveJudgeMode {
  return process.env.JUDGE_SUBJECTIVE_MODE === 'ai' ? 'ai' : 'self_assess';
}
```

2b. `JudgeOutput` 扩展：

```typescript
export interface JudgeOutput {
  questionId: number | null;
  /** null = 未判定（主观题 self_assess 待自评 / 客观题空答案不计对错） */
  isCorrect: boolean | null;
  method: 'exact' | 'ai' | 'self_assess' | 'unanswered';
  errorType: 'logic' | 'calculation' | 'format' | 'missing' | null;
  errorBookId: number | undefined;
  /** 主观题 self_assess 模式：前端据此渲染自评 UI。 */
  needsSelfAssessment?: boolean;
  /** 自评展示用（判题时一并带回，省一次往返）。 */
  referenceAnswer?: string | null;
  explanation?: string | null;
  /** 客观题空答案：该题暂无标准答案，不计对错（课堂练习守卫）。 */
  noStandardAnswer?: boolean;
}
```

2c. `judgeQuestion` 路由改造——在「路由 1b」的 else-if 之后、AI 路由之前插入两段，并扩展 1b 条件：

```typescript
    } else if ((q.type === 'fill_blank' || q.type === 'calculation') && compareAnswer(input.studentAnswer, q.answer, q.options)) {
      // 路由 1b：fill_blank/calculation 归一化相等 -> exact 判对（省 AI）；不等走 AI 复核
      isCorrect = true;
      method = 'exact';
    } else if (SUBJECTIVE_TYPES.has(q.type) && subjectiveJudgeMode() === 'self_assess') {
      // 路由 1c（判题体系重构 2026-09-09）：主观题 self_assess 模式 -> 不判对错。
      // 参考答案/解析随判题返回（前端当场展开自评）；错题本与清零由自评端点处理。
      return {
        questionId: q.id,
        isCorrect: null,
        method: 'self_assess',
        errorType: null,
        errorBookId: undefined,
        needsSelfAssessment: true,
        referenceAnswer: q.answer,
        explanation: q.explanation,
      };
    } else {
```

（`judgeQuestion` 中 `let isCorrect: boolean;` 改为 `let isCorrect: boolean | null;`，`let method: 'exact' | 'ai';` 改为 `let method: JudgeOutput['method'];`，两处同改。）

2d. `judgeForPractice` 同样插入路由 1b 扩展与路由 1c 早退（`q &&` 前缀）；另在最前（路由 1 之前）加空答案守卫：

```typescript
    // 路由 0（判题体系重构）：客观题空答案守卫——该题暂无标准答案，不计对错、
    // 不入错题本、不触发解析生成。practice_results 由 PracticeService 以
    // method='unanswered' 落行（保证课程完成门禁的作答覆盖计数不缺行）。
    if (q && (EXACT_ONLY_TYPES.has(q.type) || q.type === 'fill_blank' || q.type === 'calculation') && !q.answer) {
      return { questionId: q.id, isCorrect: null, method: 'unanswered', errorType: null, errorBookId: undefined, noStandardAnswer: true };
    }
```

2e. 新增 `recordSelfAssessment`（类尾部）+ 构造函数注入 `QuestionSelfAssessmentsRepository`：

```typescript
  /**
   * 主观题自评落库（self_assess 模式，训练/考试/课堂练习自评端点共用）：
   * 自评留痕（question_self_assessments）+ 错题本写入/清零——镜像判题的答错/答对路径，
   * 「错题清零」门禁因此零改动（主观题错题与客观题错题在 main_error_books 形态一致）。
   */
  async recordSelfAssessment(input: {
    studentId: number;
    subjectId: number;
    questionId: number;
    assessment: 'correct' | 'incorrect';
    source: string;
    sourceRefId?: number | null;
  }): Promise<{ errorBookId: number | undefined }> {
    await this.selfAssessRepo.create({
      studentId: input.studentId,
      questionId: input.questionId,
      assessment: input.assessment,
      source: input.source,
    });
    if (input.assessment === 'incorrect') {
      const existing = await this.mainErrorRepo.findUnclearedByStudentQuestionId(input.studentId, input.questionId);
      if (existing) return { errorBookId: existing.id };
      const errorBookId = await this.mainErrorRepo.create({
        student_id: input.studentId,
        subject_id: input.subjectId,
        question_id: input.questionId,
        source: input.source,
        source_ref_id: input.sourceRefId ?? null,
        question_n: null,
        lesson_id: null,
        wrong_answer_text: null,
      });
      return { errorBookId };
    }
    // 自评对 -> 清零（best-effort，失败不阻断）
    try {
      await this.mainErrorRepo.clearUnclearedByStudentQuestionId(input.studentId, input.questionId);
    } catch (err) {
      this.logger.error(`clearUnclearedByStudentQuestionId failed (self-assess, student=${input.studentId}, question=${input.questionId}): ${err}`);
    }
    return { errorBookId: undefined };
  }
```

构造函数末尾加 `private readonly selfAssessRepo: QuestionSelfAssessmentsRepository,`（import 值导入自 `../../database/repositories/index.js`，注意 repo 须值导入——NestJS DI 依赖设计时类型，参考 exams.service.ts 头部注释）。

- [ ] **Step 3: 修 PracticeService.judge 的落库分支**

`apps/server/src/modules/practice/practice.service.ts` `judge()` 中，判题后插入两个早退（在 `practiceResultsRepo.upsert` 之前）：

```typescript
    // 主观题 self_assess 模式：practice_results.is_correct NOT NULL，落行推迟到自评端点
    // （POST /practice/self-assess 补写 method='self_assess' 的完整行）。
    if (result.needsSelfAssessment) {
      return result;
    }
    // 客观题空答案：不计对错但仍落行（method='unanswered'），课程完成门禁按行覆盖计数不缺行。
    if (result.noStandardAnswer) {
      try {
        await this.practiceResultsRepo.upsert({
          student_id: input.studentId,
          subject_id: input.subjectId,
          card_id: input.cardId,
          lesson_id: input.lessonId,
          question_id: result.questionId,
          question_n: input.questionN,
          question_text: input.questionText,
          student_answer: input.studentAnswer,
          is_correct: 0,
          method: 'unanswered',
          analysis: null,
          error_type: null,
        });
      } catch (err) {
        this.logger.error(`practiceResultsRepo.upsert (noStandardAnswer) failed (student=${input.studentId}, card=${input.cardId}, qn=${input.questionN}): ${err}`);
      }
      return result;
    }
```

- [ ] **Step 4: 跑测试**

Run: `cd apps/server && npx vitest run src/modules/practice/judge-core.service.test.ts`
Expected: PASS（全部用例）。若有既有测试因 `JudgeOutput` 类型变化报错（如 practice 相关测试 mock 判题返回），以本计划契约为准修测试数据（`isCorrect` 可为 null、method 加新枚举）。

- [ ] **Step 5: 全量测试 + tsc**

Run: `cd apps/server && npm test && npm run build`
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/practice/
git commit -m "feat(server): JudgeCore 四路由（主观题 self_assess 早退 + calculation 并档 + 空答案守卫）+ recordSelfAssessment"
```

---

### Task 4: TARGETED_TYPES + 抽题空答案守卫扩展

**Files:**
- Modify: `apps/server/src/modules/training/training.controller.ts:17`
- Modify: `apps/server/src/database/repositories/questions.repo.ts:85-111`
- Test: `apps/server/src/database/repositories/questions.repo.test.ts`（追加用例）

- [ ] **Step 1: TARGETED_TYPES 加 calculation**

```typescript
  private static readonly TARGETED_TYPES = ['choice', 'fill_blank', 'true_false', 'short_answer', 'proof', 'calculation'] as const;
```

同文件 `startTargetedPractice` 的 400 文案同步为 `'type 仅允许 choice | fill_blank | true_false | short_answer | proof | calculation 或 null'`。

- [ ] **Step 2: 抽题守卫扩到全题型**

`questions.repo.ts` `findRandomByKpAndType` 的 SQL 中：

```sql
        AND NOT (q.type IN ('choice','true_false') AND q.answer = '')
```

改为：

```sql
        AND q.answer <> ''
```

注释同步改为：

```typescript
   *  空答案题一律排除（判题体系重构 2026-09-09）：客观题判不了对，主观题（self_assass
   *  模式）没有参考答案可对照自评——两类都不进专项练习（终审备忘语义扩展）。
```

- [ ] **Step 3: 追加 repo 测试用例**

在 `questions.repo.test.ts` 中追加（沿用文件内既有 mockPool 风格；先读文件确认 helper 名）：

```typescript
it('findRandomByKpAndType：空答案题全题型排除（q.answer <> \'\'）', async () => {
  const pool = mockPool([]);
  const repo = new QuestionsRepository(pool as any);
  await repo.findRandomByKpAndType(7, 1, 5, null, 10);
  const [sql] = pool.query.mock.calls[0];
  expect(sql).toContain("q.answer <> ''");
  expect(sql).not.toContain("NOT (q.type IN");
});
```

- [ ] **Step 4: 跑测试 + Commit**

Run: `cd apps/server && npx vitest run src/database/repositories/questions.repo.test.ts && npm test`
Expected: PASS。

```bash
git add apps/server/src/modules/training/training.controller.ts apps/server/src/database/repositories/questions.repo.ts apps/server/src/database/repositories/questions.repo.test.ts
git commit -m "feat(server): 专项练习支持 calculation 题型；抽题空答案守卫扩到全题型"
```

---

### Task 5: 训练自评端点（training）

**Files:**
- Create: `apps/server/src/modules/training/dto/self-assess.dto.ts`
- Modify: `apps/server/src/modules/training/training.controller.ts`
- Modify: `apps/server/src/modules/training/training.service.ts`

- [ ] **Step 1: DTO**

`apps/server/src/modules/training/dto/self-assess.dto.ts`（interface 风格与 judge-training.dto.ts 一致）：

```typescript
/** 主观题学生自评（JUDGE_SUBJECTIVE_MODE=self_assess 模式）。 */
export interface SelfAssessTrainingDto {
  questionId: number;
  subjectId: number;
  /** 'correct' = 我做对了（清零未清错题）；'incorrect' = 我做错了（入错题本） */
  assessment: 'correct' | 'incorrect';
  /** 'targeted' | 'error_practice' | 'exam'（考试结果页自评也走本端点） */
  source: 'targeted' | 'error_practice' | 'exam';
}
```

- [ ] **Step 2: Service 方法**

`training.service.ts` 加（`judgeTraining` 之后）：

```typescript
  /** 主观题自评：校验题目存在后委托 JudgeCore.recordSelfAssessment（留痕 + 错题本写入/清零）。 */
  async selfAssess(input: {
    studentId: number; questionId: number; subjectId: number;
    assessment: 'correct' | 'incorrect';
    source: 'targeted' | 'error_practice' | 'exam';
    sourceRefId?: number | null;
  }) {
    const q = await this.questionsRepo.findById(input.questionId);
    if (!q) {
      throw new NotFoundException(`题目不存在：${input.questionId}`);
    }
    return this.judgeCore.recordSelfAssessment(input);
  }
```

- [ ] **Step 3: Controller 端点**

`training.controller.ts` 加（`judge` 端点之后；import type SelfAssessTrainingDto）：

```typescript
  /** 主观题学生自评（self_assess 模式）：incorrect 入错题本 / correct 清零；每次自评留痕。
   *  考试结果页自评 source='exam' + sourceRefId=sessionId。 */
  @Post('self-assess')
  async selfAssess(@Body() dto: SelfAssessTrainingDto, @CurrentUser() user: JwtUser) {
    if (dto.source !== 'targeted' && dto.source !== 'error_practice' && dto.source !== 'exam') {
      throw new BadRequestException('source 仅允许 targeted | error_practice | exam');
    }
    if (dto.assessment !== 'correct' && dto.assessment !== 'incorrect') {
      throw new BadRequestException('assessment 仅允许 correct | incorrect');
    }
    if (!Number.isInteger(dto.questionId) || dto.questionId < 1 || !Number.isInteger(dto.subjectId) || dto.subjectId < 1) {
      throw new BadRequestException('questionId 与 subjectId 须为正整数');
    }
    return this.trainingService.selfAssess({
      studentId: user.sub,
      questionId: dto.questionId,
      subjectId: dto.subjectId,
      assessment: dto.assessment,
      source: dto.source,
      sourceRefId: dto.sourceRefId ?? null,
    });
  }
```

DTO 加可选 `sourceRefId?: number`。

- [ ] **Step 4: tsc + 测试 + Commit**

Run: `cd apps/server && npm run build && npm test`
Expected: 通过。

```bash
git add apps/server/src/modules/training/
git commit -m "feat(server): POST /api/training/self-assess 主观题自评端点"
```

---

### Task 6: 课堂练习自评端点（practice）

**Files:**
- Modify: `apps/server/src/modules/practice/practice.controller.ts`
- Modify: `apps/server/src/modules/practice/practice.service.ts`
- Modify: `apps/server/src/modules/practice/practice.module.ts`

- [ ] **Step 1: Service 方法**

`practice.service.ts` 加（构造函数注入 `QuestionSelfAssessmentsRepository selfAssessRepo`；`judge()` 之后）：

```typescript
  /**
   * 课堂练习主观题自评（self_assess 模式）：补写 practice_results（判题时因 is_correct
   * NOT NULL 推迟到此处，method='self_assess'）+ 自评留痕 + 错题本写入/清零。
   * questionId 可为 null（孤儿题：题库未命中、仅存题面）——留痕跳过、错题本走
   * card+题面变体匹配（镜像 judgeForPractice 既有模式）。
   */
  async selfAssess(input: {
    studentId: number; subjectId: number; cardId: number; lessonId: number;
    questionN: string; questionText: string; questionId: number | null;
    studentAnswer: string; assessment: 'correct' | 'incorrect';
  }): Promise<void> {
    if (input.questionId != null) {
      await this.selfAssessRepo.create({
        studentId: input.studentId,
        questionId: input.questionId,
        assessment: input.assessment,
        source: 'practice',
      });
    }
    // practice_results 补行（best-effort，与 judge() 同款容错）
    try {
      await this.practiceResultsRepo.upsert({
        student_id: input.studentId,
        subject_id: input.subjectId,
        card_id: input.cardId,
        lesson_id: input.lessonId,
        question_id: input.questionId,
        question_n: input.questionN,
        question_text: input.questionText,
        student_answer: input.studentAnswer,
        is_correct: input.assessment === 'correct' ? 1 : 0,
        method: 'self_assess',
        analysis: null,
        error_type: null,
      });
    } catch (err) {
      this.logger.error(`practiceResultsRepo.upsert (self-assess) failed (student=${input.studentId}, card=${input.cardId}, qn=${input.questionN}): ${err}`);
    }
    // 错题本写入/清零（questionId 中心 vs card+题面变体）
    if (input.assessment === 'incorrect') {
      const existing = input.questionId != null
        ? await this.mainErrorRepo.findUnclearedByStudentQuestionId(input.studentId, input.questionId)
        : await this.mainErrorRepo.findUnclearedByStudentQuestion(input.studentId, null, input.cardId, input.questionText);
      if (!existing) {
        await this.mainErrorRepo.create({
          student_id: input.studentId,
          subject_id: input.subjectId,
          question_id: input.questionId,
          source: 'practice',
          source_ref_id: input.cardId,
          question_n: input.questionN,
          lesson_id: input.lessonId,
          wrong_answer_text: input.questionId === null ? input.questionText : null,
        });
      }
    } else {
      try {
        if (input.questionId != null) {
          await this.mainErrorRepo.clearUnclearedByStudentQuestionId(input.studentId, input.questionId);
        } else {
          await this.mainErrorRepo.clearUnclearedByStudentQuestion(input.studentId, null, input.cardId, input.questionText);
        }
      } catch (err) {
        this.logger.error(`clearUncleared (self-assess) failed (student=${input.studentId}, card=${input.cardId}, qn=${input.questionN}): ${err}`);
      }
    }
  }
```

- [ ] **Step 2: Controller 端点**

`practice.controller.ts` 加（`judge` 端点之后；参数校验风格与 training 一致）：

```typescript
  /** 课堂练习主观题自评（self_assess 模式）：补写 practice_results + 留痕 + 错题本写入/清零。 */
  @Post('self-assess')
  async selfAssess(@Body() dto: {
    cardId: number; lessonId: number; subjectId: number;
    questionN: string; questionText: string; questionId: number | null;
    studentAnswer: string; assessment: 'correct' | 'incorrect';
  }, @CurrentUser() user: JwtUser) {
    if (!Number.isInteger(dto.cardId) || dto.cardId < 1 ||
        !Number.isInteger(dto.lessonId) || dto.lessonId < 1 ||
        !Number.isInteger(dto.subjectId) || dto.subjectId < 1) {
      throw new BadRequestException('cardId/lessonId/subjectId 须为正整数');
    }
    if (!dto.questionN || !dto.questionText) {
      throw new BadRequestException('questionN 与 questionText 必填');
    }
    if (dto.questionId != null && (!Number.isInteger(dto.questionId) || dto.questionId < 1)) {
      throw new BadRequestException('questionId 须为正整数或 null');
    }
    if (dto.assessment !== 'correct' && dto.assessment !== 'incorrect') {
      throw new BadRequestException('assessment 仅允许 correct | incorrect');
    }
    await this.practiceService.selfAssess({
      studentId: user.sub,
      cardId: dto.cardId,
      lessonId: dto.lessonId,
      subjectId: dto.subjectId,
      questionN: dto.questionN,
      questionText: dto.questionText,
      questionId: dto.questionId ?? null,
      studentAnswer: dto.studentAnswer ?? '',
      assessment: dto.assessment,
    });
    return null; // ResponseInterceptor 包成 { code: 0, data: null }
  }
```

（BadRequestException 若未导入则补 import；controller 现有 judge 端点的入参风格见 `practice.controller.ts:18-29`。）

- [ ] **Step 3: 模块注册**

`practice.module.ts` providers 确认含 `QuestionSelfAssessmentsRepository`（Task 2 已加；PracticeService 现在也注入它，同一 provider 即可）。

- [ ] **Step 4: tsc + 测试 + Commit**

Run: `cd apps/server && npm run build && npm test`
Expected: 通过。

```bash
git add apps/server/src/modules/practice/
git commit -m "feat(server): POST /api/practice/self-assess 课堂练习主观题自评端点"
```

---

### Task 7: 考试模块改造（主观题不判 + 结果页数据）

**Files:**
- Modify: `apps/server/src/modules/exams/exams.service.ts`
- Modify: `apps/server/src/database/repositories/exam-sessions.repo.ts`
- Modify: `apps/server/src/modules/exams/dto/session-create.dto.ts`（ExamSummaryDto / ExamResultItem）
- Modify: `apps/server/src/modules/exams/exams.module.ts`（如 QuestionSelfAssessmentsRepository 需注册——仅 getResults 读留痕需要）

- [ ] **Step 1: repo 查询带回参考答案 + 已有自评**

`exam-sessions.repo.ts`：

`ExamResultRow` 加字段：

```typescript
  answer: string | null;
```

`findAnswersWithQuestions` 的 SELECT 加 `q.answer AS answer,`（`q.explanation` 旁）。

- [ ] **Step 2: exams.service 改造**

2a. import：`subjectiveJudgeMode, SUBJECTIVE_TYPES` 需从 judge-core.service.ts 导出——**先在 judge-core.service.ts 导出 `SUBJECTIVE_TYPES`**（`export const SUBJECTIVE_TYPES = new Set(...)`）。

2b. `submitAnswer`（:187 判题调用前）插入分支：

```typescript
    // 主观题 self_assess 模式（判题体系重构）：不判题，作答已落库；结果页对照参考答案自评。
    if (subjectiveJudgeMode() === 'self_assess' && SUBJECTIVE_TYPES.has(q.type)) {
      await this.examSessionsRepo.upsertAnswer({
        sessionId,
        questionId: dto.questionId,
        questionOrder: q.questionNo,
        answerText: dto.answerText,
        isCorrect: null,
        method: 'self_assess',
        judgedAt: new Date(),
      });
      return { saved: true };
    }
```

（`q` 是 `findQuestionsByPaperId` 的行，含 `type`——见 `toSessionQuestion` 消费的字段。）

2c. `finalizeSession` 循环（:266 `for (const q of questions)` 开头）插入主观题跳过分支：

```typescript
    for (const q of questions) {
      // 主观题 self_assess 模式：不判题不按错计（无论是否作答），统一落
      // is_correct=NULL + method='self_assess'，结果页对照参考答案自评。
      if (subjectiveJudgeMode() === 'self_assess' && SUBJECTIVE_TYPES.has(q.type)) {
        const a0 = byQuestion.get(q.questionId);
        await this.examSessionsRepo.upsertAnswer({
          sessionId: session.id,
          questionId: q.questionId,
          questionOrder: q.questionNo,
          answerText: a0?.answer_text ?? null,
          isCorrect: null,
          method: 'self_assess',
          judgedAt: new Date(),
        });
        continue;
      }
      const a = byQuestion.get(q.questionId);
      ...
```

2d. `getResults` items 映射改造（保留 is_correct=null 语义 + 带参考答案 + 已有自评）：

```typescript
    const rows = await this.examSessionsRepo.findAnswersWithQuestions(sessionId);
    const selfAssessed = await this.selfAssessRepo.findLatestByStudentAndQuestionIds(
      studentId,
      rows.filter((r) => r.is_correct === null).map((r) => r.question_id),
    );
    const items = rows.map((row) => ({
      questionId: row.question_id,
      questionNo: row.question_order,
      text: row.text,
      type: row.type,
      options: parseOptions(row.options),
      answerText: row.answer_text,
      isCorrect: row.is_correct,               // null = 主观题待自评（不再 ?? 0）
      analysis: row.analysis,
      explanation: row.explanation,
      answer: row.answer,                       // 参考答案（自评展示）
      needsSelfAssessment: row.is_correct === null,
      selfAssessment: selfAssessed.get(row.question_id) ?? null, // 已自评状态（重进结果页恢复）
    }));
    const summary = this.summarize(items.length, items.map((i) => ({ is_correct: i.isCorrect }) as ExamAnswerRow));
    return { ...summary, items };
```

构造函数注入 `QuestionSelfAssessmentsRepository`（exams.module.ts providers 补注册）。

2e. `summarize` 改为客观题口径：

```typescript
  /** 汇总：主观题（is_correct NULL，self_assess 模式）不计入对错——correctCount/accuracy
   *  只算客观题，subjectiveCount 单列（结果页展示「客观题 X/Y · 主观题 N 题」）。 */
  private summarize(totalCount: number, answers: Array<Pick<ExamAnswerRow, 'is_correct'>>): ExamSummaryDto {
    const subjectiveCount = answers.filter((a) => a.is_correct === null).length;
    const objectiveTotal = totalCount - subjectiveCount;
    const correctCount = answers.filter((a) => a.is_correct === 1).length;
    const accuracy = objectiveTotal > 0 ? Math.round((correctCount / objectiveTotal) * 1000) / 10 : 0;
    return { correctCount, totalCount, accuracy, subjectiveCount };
  }
```

- [ ] **Step 3: DTO 更新**

`session-create.dto.ts`：

```typescript
// ExamSummaryDto 加：
  /** 主观题题数（self_assess 模式不判对错，单独计数） */
  subjectiveCount: number;

// ExamResultItem（items 元素类型）加/改：
  isCorrect: number | null;              // null = 主观题待自评
  answer?: string | null;                // 参考答案（自评对照）
  needsSelfAssessment?: boolean;
  selfAssessment?: 'correct' | 'incorrect' | null;
```

（先读该文件确认类型名与字段命名风格，按其注释风格补注释。）

- [ ] **Step 4: tsc + 测试 + Commit**

Run: `cd apps/server && npm run build && npm test`
Expected: 通过；若既有 exams 测试断言 `isCorrect ?? 0` 语义或 summarize 口径，按新契约修测试（铁律：测试错改测试）。

```bash
git add apps/server/src/modules/exams/ apps/server/src/database/repositories/exam-sessions.repo.ts apps/server/src/modules/practice/judge-core.service.ts
git commit -m "feat(server): 考试主观题 self_assess 模式（不判题/结果页带参考答案与自评状态/成绩只算客观题）"
```

---

### Task 8: 前端 API 层

**Files:**
- Modify: `apps/web/src/services/api.ts`

- [ ] **Step 1: JudgeResult 契约扩展**（`// --- Practice` 区段，:574-582）

```typescript
export interface JudgeResult {
  questionId: number | null;
  /** null = 未判定（主观题待自评 / 客观题空答案不计对错） */
  isCorrect: boolean | null;
  method: 'exact' | 'ai' | 'self_assess' | 'unanswered';
  errorType?: 'logic' | 'calculation' | 'format' | 'missing' | null;
  errorBookId?: number;
  /** 主观题 self_assess 模式：渲染自评 UI，参考答案/解析随判题返回 */
  needsSelfAssessment?: boolean;
  referenceAnswer?: string | null;
  explanation?: string | null;
  /** 客观题空答案：不计对错（中性展示） */
  noStandardAnswer?: boolean;
}
```

- [ ] **Step 2: 自评 API 函数**（Training 区段，`getTrainingExplanations` 附近）：

```typescript
/** 主观题学生自评（self_assess 模式）：incorrect 入错题本 / correct 清零。 */
export function selfAssessTraining(payload: {
  questionId: number;
  subjectId: number;
  assessment: 'correct' | 'incorrect';
  source: 'targeted' | 'error_practice' | 'exam';
  sourceRefId?: number;
}): Promise<{ errorBookId?: number }> {
  return fetchApi<{ errorBookId?: number }>('/training/self-assess', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** 课堂练习主观题自评：补写 practice_results + 留痕 + 错题本写入/清零。 */
export function selfAssessPractice(payload: {
  cardId: number;
  lessonId: number;
  subjectId: number;
  questionN: string;
  questionText: string;
  questionId: number | null;
  studentAnswer: string;
  assessment: 'correct' | 'incorrect';
}): Promise<void> {
  return fetchApi<void>('/practice/self-assess', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
```

- [ ] **Step 3: 考试结果类型**（`ExamSummary` / `ExamResultItem` 定义处，`grep -n "interface ExamResultItem" apps/web/src/services/api.ts` 定位）：

```typescript
// ExamSummary 加：
  subjectiveCount?: number;

// ExamResultItem 加/改：
  isCorrect: number | null;      // null = 主观题待自评
  answer?: string | null;
  needsSelfAssessment?: boolean;
  selfAssessment?: 'correct' | 'incorrect' | null;
```

- [ ] **Step 4: 类型检查 + Commit**

Run: `cd apps/web && npx tsc -b --noEmit 2>/dev/null || npm run build`
Expected: 编译错误只可能出现在消费 isCorrect 的地方——这些在 Task 10/11 修；本任务先允许 `ExamResultPage` 等处的既有消费报错，**须在 Task 11 内清零**。若要独立提交，临时用 `isCorrect: it.isCorrect === 1` 兼容旧行为，Task 11 再改。

```bash
git add apps/web/src/services/api.ts
git commit -m "feat(web): 判题/自评 API 契约（needsSelfAssessment + selfAssessTraining/Practice）"
```

---

### Task 9: QuestionRunner 主观题同步提交 + 自评视图

**Files:**
- Modify: `apps/web/src/components/business/answer/types.ts`
- Modify: `apps/web/src/components/business/answer/QuestionRunner.tsx`
- Test: `apps/web/src/components/business/answer/QuestionRunner.test.tsx`（追加 describe）

- [ ] **Step 1: types.ts 扩展**

```typescript
/** 单题作答记录：onFinish 快照交给父层，由父层决定后续（结果页/错题本等）。 */
export interface RunnerAnswerRecord {
  isCorrect: boolean;
  method: string;
  errorType?: string | null;
  studentAnswer: string;
  /** 判题请求失败（网络/服务端错误），区别于答错 */
  failed?: boolean;
}

/** onSubmit 的最小返回契约（JudgeResult 的结构子集；method 宽化为 string 以兼容旧 AnswerModal 回调签名）。 */
export interface RunnerJudgeOutcome {
  isCorrect: boolean | null;
  method: string;
  errorType?: string | null;
  /** 主观题 self_assess 模式：true 时 Runner 进入自评视图（同步等待，不 fire-and-forget） */
  needsSelfAssessment?: boolean;
  referenceAnswer?: string | null;
  explanation?: string | null;
  noStandardAnswer?: boolean;
}

/** 自评提交上下文：Runner 把判题返回的 questionId 与学生作答文本回传给父层落库。 */
export interface RunnerSelfAssessContext {
  questionId: number | null;
  studentAnswer: string;
}
```

（`RunnerAnswerRecord.isCorrect` 保持 boolean——自评结果落为布尔后再记。）

- [ ] **Step 2: QuestionRunner 改造**

2a. props 加：

```typescript
  /** 主观题自评提交（self_assess 模式）：学生点「我做对了/我做错了」后调用；父层落库。
   *  缺省时自评不落库但仍强制选择后才放行（防跳过）。 */
  onSelfAssess?: (q: RunnerQuestion, assessment: 'correct' | 'incorrect', ctx: RunnerSelfAssessContext) => Promise<void>;
```

2b. 组件内新增状态（`seqRef` 之后）：

```typescript
  // 主观题自评视图（self_assess 模式）：提交后判题即时返回待自评 + 参考答案/解析，
  // 学生点「我做对了/我做错了」后才放行下一题（强制自评，不跳过）。
  const [selfAssess, setSelfAssess] = useState<{
    question: RunnerQuestion;
    submittedAnswer: string;
    questionId: number | null;
    referenceAnswer: string;
    explanation: string;
    assessing: boolean;
    error: boolean;
  } | null>(null);
```

`phase` 类型扩为 `'answering' | 'judging' | 'self_assess'`。

2c. `handleSubmit` 重构——主观题同步等待（插在 `pendingRef.current.set(thisIdx, p);` 之前，替换整个函数体的提交部分）：

```typescript
    // 主观题（解答/证明）：同步等待判题返回——self_assess 模式即时返回待自评
    // （进入自评视图，强制自评后放行）；ai 模式返回判定结果（与客观题同样记录后切题）。
    // showResultFeedback=false（考试）：不在此自评（交卷后结果页自评），走 fire-and-forget。
    const inlineSelfAssess = showResultFeedback && (question.type === 'short_answer' || question.type === 'proof');
    if (inlineSelfAssess) {
      setPhase('judging');
      try {
        const res = await Promise.resolve(onSubmit(question, submittedAnswer));
        if (seqRef.current[question.n] !== seq) return; // 过期结果，丢弃
        if (res.needsSelfAssessment) {
          setSelfAssess({
            question,
            submittedAnswer,
            questionId: res.questionId ?? null,
            referenceAnswer: res.referenceAnswer ?? '',
            explanation: res.explanation ?? '',
            assessing: false,
            error: false,
          });
          setPhase('self_assess');
          return;
        }
        resultsRef.current[question.n] = {
          isCorrect: res.isCorrect ?? false,
          method: res.method,
          errorType: res.errorType ?? null,
          studentAnswer: submittedAnswer,
        };
        advance(thisIdx);
      } catch {
        if (seqRef.current[question.n] !== seq) return;
        resultsRef.current[question.n] = {
          isCorrect: false, method: 'ai', errorType: null, studentAnswer: submittedAnswer, failed: true,
        };
        advance(thisIdx);
      }
      return;
    }
```

并抽出 `advance`（放 handleSubmit 之前；原 fire-and-forget 末尾的切题逻辑改调它）：

```typescript
  const advance = useCallback((fromIdx: number) => {
    if (fromIdx + 1 < total) {
      setIdx(fromIdx + 1);
    } else {
      // 末题：进入等待态，等所有后台判题完成后交结果给父层
      setPhase('judging');
      void Promise.allSettled([...pendingRef.current.values()]).then(() => {
        onFinish({ ...resultsRef.current });
      });
    }
  }, [total, onFinish]);
```

（原 fire-and-forget 路径末尾的 `if (thisIdx + 1 < total) {...} else {...await Promise.allSettled...}` 替换为 `advance(thisIdx);`。）

2d. 自评提交处理：

```typescript
  const handleSelfAssess = useCallback(async (assessment: 'correct' | 'incorrect') => {
    if (!selfAssess || selfAssess.assessing) return;
    setSelfAssess((s) => (s ? { ...s, assessing: true, error: false } : s));
    const { question, submittedAnswer, questionId } = selfAssess;
    try {
      if (onSelfAssess) {
        await onSelfAssess(question, assessment, { questionId, studentAnswer: submittedAnswer });
      }
    } catch {
      // 落库失败：留在自评视图可重点（结果已本地记录，不重复入 resultsRef）
      setSelfAssess((s) => (s ? { ...s, assessing: false, error: true } : s));
      return;
    }
    resultsRef.current[question.n] = {
      isCorrect: assessment === 'correct',
      method: 'self_assess',
      errorType: null,
      studentAnswer: submittedAnswer,
    };
    const idxOf = questions.findIndex((x) => x.n === question.n);
    setSelfAssess(null);
    advance(idxOf < 0 ? idx : idxOf);
  }, [selfAssess, onSelfAssess, questions, advance, idx]);
```

2e. 自评视图（`judgingView` 旁）：

```typescript
  // ========== SELF-ASSESS 态（主观题 self_assess 模式） ==========
  const selfAssessView = selfAssess && (
    <div className="flex-1 min-h-0 flex flex-col gap-3">
      <h1 className="font-bold shrink-0" style={{ fontSize: 'var(--fs-learn-h1)', lineHeight: '1.75rem', color: 'var(--learn-heading-1)' }}>
        对照参考答案，自评这道题
      </h1>
      <div className="flex-1 min-h-0 overflow-y-auto p-4 rounded-xl border border-[var(--learn-card-border)] shadow-sm"
           style={{ backgroundColor: 'var(--learn-card-bg)' }}>
        <div className="text-xs font-semibold text-[var(--text-tertiary)] mb-1.5">参考答案</div>
        <div className="text-sm text-[var(--text-primary)] leading-[1.7]">
          <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={questionMarkdownComponents}>
            {preprocessMarkdown(selfAssess.referenceAnswer || '（暂无参考答案）')}
          </ReactMarkdown>
        </div>
        {selfAssess.explanation && (
          <>
            <div className="text-xs font-semibold text-[var(--text-tertiary)] mt-4 mb-1.5">解题思路与解析</div>
            <div className="text-sm text-[var(--text-primary)] leading-[1.7]">
              <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={questionMarkdownComponents}>
                {preprocessMarkdown(selfAssess.explanation)}
              </ReactMarkdown>
            </div>
          </>
        )}
      </div>
      <div className="shrink-0 flex items-center justify-between gap-3 p-3 rounded-xl border border-[var(--learn-card-border)]"
           style={{ backgroundColor: 'var(--learn-card-bg)' }}>
        <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
          你刚才的作答是对的（过程/结论与参考一致）还是错的（思路或结果有误）？
          {selfAssess.error && <span className="block text-[var(--error)]">自评提交失败，请重试。</span>}
        </p>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={() => void handleSelfAssess('incorrect')}
            disabled={selfAssess.assessing}
            className="h-10 px-4 rounded-lg border border-[var(--error)] text-[var(--error)] text-sm font-medium disabled:opacity-40 hover:bg-[#FCE8E6] transition-colors"
          >
            我做错了
          </button>
          <button
            onClick={() => void handleSelfAssess('correct')}
            disabled={selfAssess.assessing}
            className="h-10 px-4 rounded-lg border border-[var(--success)] text-[var(--success)] text-sm font-medium disabled:opacity-40 hover:bg-[#E8F5EE] transition-colors"
          >
            我做对了
          </button>
        </div>
      </div>
    </div>
  );
```

视图分发改为：

```typescript
  const view = phase === 'self_assess' ? selfAssessView
    : phase === 'judging' ? (judgingSlot ?? judgingView)
    : answeringView;
```

（modal 外壳的 `{phase === 'answering' && modalExtras}` 改为 `{(phase === 'answering' || phase === 'self_assess') && modalExtras}`，保证自评态仍可打开讨论抽屉。）

- [ ] **Step 3: 追加测试**

在 `QuestionRunner.test.tsx` 末尾追加（沿用文件顶部已导入的 render/screen/userEvent/cleanup 与 makeQuestions 风格）：

```typescript
describe('主观题自评（self_assess 模式）', () => {
  it('提交后进入自评视图，点「我做对了」才放行下一题', async () => {
    const user = userEvent.setup();
    const onSelfAssess = vi.fn(async () => {});
    const questions = useMemo(() => [
      { n: '1', text: '证明题题干', type: 'proof' },
      { n: '2', text: '第二题', type: 'proof' },
    ], []);
    render(
      <QuestionRunner
        questions={questions}
        subjectId={1}
        draftKeyPrefix="sa"
        variant="embedded"
        draftDisabled
        onSubmit={async (): Promise<RunnerJudgeOutcome> => ({
          isCorrect: null, method: 'self_assess', needsSelfAssessment: true,
          referenceAnswer: '参考证明过程', explanation: '解析内容',
        })}
        onSelfAssess={onSelfAssess}
        onFinish={() => {}}
      />,
    );
    // 文本作答 + 提交
    await user.type(screen.getByRole('textbox'), '我的证明');
    await user.click(screen.getByTitle('提交'));
    // 自评视图出现（参考答案可见），当前题尚未切走
    expect(await screen.findByText('参考证明过程')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '我做对了' }));
    expect(onSelfAssess).toHaveBeenCalledWith(
      expect.objectContaining({ n: '1' }),
      'correct',
      expect.objectContaining({ studentAnswer: '我的证明' }),
    );
    // 放行后进入第二题
    expect(await screen.findByText('第二题')).toBeTruthy();
  });

  it('未提供 onSelfAssess 也强制选择（自评不落库但不可跳过）', async () => {
    const user = userEvent.setup();
    const questions = useMemo(() => [
      { n: '1', text: '解答题', type: 'short_answer' },
    ], []);
    const onFinish = vi.fn();
    render(
      <QuestionRunner
        questions={questions}
        subjectId={1}
        draftKeyPrefix="sa2"
        variant="embedded"
        draftDisabled
        onSubmit={async (): Promise<RunnerJudgeOutcome> => ({
          isCorrect: null, method: 'self_assess', needsSelfAssessment: true, referenceAnswer: 'x=1',
        })}
        onFinish={onFinish}
      />,
    );
    await user.type(screen.getByRole('textbox'), '解答');
    await user.click(screen.getByTitle('提交'));
    await user.click(await screen.findByRole('button', { name: '我做错了' }));
    expect(onFinish).toHaveBeenCalledWith(
      expect.objectContaining({ '1': expect.objectContaining({ isCorrect: false, method: 'self_assess' }) }),
    );
  });
});
```

（`vi` 需在文件顶部 import 中补上；若 textbox 选择器与 LatexEditor 实际 role 不符，以现有测试中定位文本输入框的方式为准调整。）

Run: `cd apps/web && npx vitest run src/components/business/answer/QuestionRunner.test.tsx`
Expected: PASS（含既有回填用例不回归）。

- [ ] **Step 4: build + Commit**

Run: `cd apps/web && npm run build`
Expected: 通过。

```bash
git add apps/web/src/components/business/answer/
git commit -m "feat(web): QuestionRunner 主观题同步提交 + 强制自评视图"
```

---

### Task 10: AnswerResultList 主观题条目（无对错 + 参考答案/解析 + 结果页自评）

**Files:**
- Modify: `apps/web/src/components/business/AnswerResultList.tsx`

- [ ] **Step 1: 契约扩展**

`AnswerRecord` 接口加：

```typescript
  /** 主观题待自评（考试结果页）：渲染自评按钮 */
  needsSelfAssess?: boolean;
  /** 已有自评结果（重进结果页恢复）：'correct' | 'incorrect' */
  selfAssessment?: 'correct' | 'incorrect' | null;
```

`Props` 加：

```typescript
  /** 主观题参考答案（key = q.n；考试结果页传，训练结果页不传——自评时已看过） */
  referenceAnswers?: Record<string, string | null>;
  /** 结果页自评提交（考试结果页传）；返回后父层更新 answers 消除 needsSelfAssess */
  onSelfAssess?: (n: string, assessment: 'correct' | 'incorrect') => Promise<void>;
```

- [ ] **Step 2: 统计口径**

```typescript
  const failedCount = questions.filter(q => answers[q.n]?.failed).length;
  const subjectiveNs = questions.filter(q => answers[q.n]?.method === 'self_assess' || answers[q.n]?.needsSelfAssess);
  const subjectiveCount = subjectiveNs.length;
  const correctCount = questions.filter(q => answers[q.n]?.isCorrect && !answers[q.n]?.failed && answers[q.n]?.method !== 'self_assess' && !answers[q.n]?.needsSelfAssess).length;
  const wrongCount = questions.length - correctCount - failedCount - subjectiveCount;
```

Header 统计区在「未判定」之后追加：

```tsx
            {subjectiveCount > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-[var(--brand-500)]" />
                <span className="text-[13px] text-[var(--text-secondary)]">主观 {subjectiveCount}</span>
              </div>
            )}
```

- [ ] **Step 3: 条目渲染**

列表项内（`const failed = ...` 旁）加：

```tsx
              const rec = a;
              const subjective = !!rec?.needsSelfAssess || rec?.method === 'self_assess';
```

状态图标分支改为 `failed ? ... : subjective ? (中性圆点) : correct ? (对) : (错)`：

```tsx
                    <div className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center mt-0.5 ${failed ? 'bg-[var(--bg-subtle)]' : subjective ? 'bg-[var(--brand-100)]' : correct ? 'bg-[#E8F5EE]' : 'bg-[#FCE8E6]'}`}>
                      {failed ? (
                        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="3" strokeLinecap="round">
                          <line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                      ) : subjective ? (
                        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--brand-500)" strokeWidth="2.5" strokeLinecap="round">
                          <circle cx="12" cy="12" r="8" />
                          <path d="M12 8v4" />
                          <path d="M12 16h.01" />
                        </svg>
                      ) : correct ? (
                        /* 既有对勾 SVG 原样保留 */
                      ) : (
                        /* 既有叉号 SVG 原样保留 */
                      )}
                    </div>
```

「你的答案」块之后、判定失败提示之前，插入主观题专属块（替换原 `{!correct && !failed && (解析按钮)}` 的位置——主观题解析按钮无条件展示）：

```tsx
                      {/* 主观题：无对错状态；参考答案/解析展开 + （待自评时）自评按钮 */}
                      {subjective && !failed && (
                        <div className="mt-2.5 flex flex-col gap-2">
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => setExpandedN(expanded ? null : q.n)}
                              className="px-4 py-1.5 rounded-lg border border-[var(--warning)] bg-[var(--brand-100)] text-[var(--warning)] text-xs font-medium hover:bg-[var(--warning)] hover:text-white transition-colors"
                            >
                              {expanded ? '收起解析' : '查看解析'}
                            </button>
                            {rec?.selfAssessment && (
                              <span className="text-xs text-[var(--text-tertiary)]">已自评：{rec.selfAssessment === 'correct' ? '做对了' : '做错了'}</span>
                            )}
                          </div>
                          {rec?.needsSelfAssess && onSelfAssess && (
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-[var(--text-secondary)]">对照参考答案，这题你做对了还是做错了？</span>
                              <button
                                onClick={() => void handleSelfAssess(q.n, 'incorrect')}
                                disabled={assessingN != null}
                                className="px-3 py-1.5 rounded-lg border border-[var(--error)] text-[var(--error)] text-xs font-medium hover:bg-[#FCE8E6] transition-colors disabled:opacity-40"
                              >
                                我做错了
                              </button>
                              <button
                                onClick={() => void handleSelfAssess(q.n, 'correct')}
                                disabled={assessingN != null}
                                className="px-3 py-1.5 rounded-lg border border-[var(--success)] text-[var(--success)] text-xs font-medium hover:bg-[#E8F5EE] transition-colors disabled:opacity-40"
                              >
                                我做对了
                              </button>
                            </div>
                          )}
                        </div>
                      )}
```

新增 state 与 handler（`refreshingN` 旁）：

```typescript
  const [assessingN, setAssessingN] = useState<string | null>(null);

  const handleSelfAssess = async (n: string, assessment: 'correct' | 'incorrect') => {
    if (!onSelfAssess || assessingN) return;
    setAssessingN(n);
    try {
      await onSelfAssess(n, assessment);
    } finally {
      setAssessingN(null);
    }
  };
```

原客观题解析按钮的渲染条件改为 `{!correct && !failed && !subjective && (...)}`；展开区（expanded explanation）同样加 `&& !subjective` 由主观题共用——展开内容对主观题追加参考答案块（展开区顶部）：

```tsx
                      {expanded && subjective && referenceAnswers?.[q.n] && (
                        <div className="px-4 pb-1 pt-3.5 pl-[50px]">
                          <div className="p-3.5 bg-[var(--bg-base)] rounded-[10px]">
                            <div className="text-xs font-semibold text-[var(--text-tertiary)] mb-1.5">参考答案</div>
                            <div className="text-[13px] text-[var(--text-primary)] leading-[1.7]">
                              <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={markdownComponents}>
                                {preprocessMarkdown(referenceAnswers[q.n]!)}
                              </ReactMarkdown>
                            </div>
                          </div>
                        </div>
                      )}
```

（展开条件统一为 `{expanded && !failed && (subjective ? (explanation || referenceAnswers?.[q.n]) : (!correct && explanation)) && ...}`——按现文件结构把原 `{expanded && !correct && !failed && explanation && ...}` 的条件改写为兼容两态。）

- [ ] **Step 3: build + Commit**

Run: `cd apps/web && npm run build`
Expected: 通过。

```bash
git add apps/web/src/components/business/AnswerResultList.tsx
git commit -m "feat(web): AnswerResultList 主观题条目（无对错 + 参考答案/解析 + 结果页自评按钮）"
```

---

### Task 11: 页面接线（训练/错题/课堂/考试）

**Files:**
- Modify: `apps/web/src/pages/student/training/TargetedRunPage.tsx`
- Modify: `apps/web/src/pages/student/training/ErrorPracticeRunPage.tsx`
- Modify: `apps/web/src/pages/student/training/ExamResultPage.tsx`
- Modify: `apps/web/src/components/business/AnswerModal.tsx`
- Modify: `apps/web/src/components/business/CleanupPhase.tsx`

- [ ] **Step 1: TargetedRunPage**

1a. import `selfAssessTraining`（`judgeTraining` 旁）。

1b. `QuestionRunner` 加 prop（`onSubmit={handleSubmit}` 旁）：

```tsx
              onSelfAssess={async (q, assessment, ctx) => {
                const entry = entryByN.get(q.n);
                if (!entry) throw new Error('题单条目缺失，无法自评');
                await selfAssessTraining({
                  questionId: entry.questionId,
                  subjectId: MATH_SUBJECT_ID,
                  assessment,
                  source: 'targeted',
                });
              }}
```

1c. `handleFinish` 中解析拉取范围扩大（主观题无论自评对错都展示解析）：

```typescript
    const wrongIds: number[] = [];
    for (const q of questions ?? []) {
      const qid = entryByN.get(q.n)?.questionId;
      const r = results[q.n];
      if (qid == null || !r || r.failed) continue;
      // 客观题答错 + 主观题（self_assess，无论自评对错）都要解析
      if (!r.isCorrect || r.method === 'self_assess') wrongIds.push(qid);
    }
```

（`byN` 的写入保持不变。）

- [ ] **Step 2: ErrorPracticeRunPage**

同款接线：`onSelfAssess` 用 `source: 'error_practice'`；`handleFinish` 的解析收集做同款 `|| r.method === 'self_assess'` 扩展（读文件定位其 wrongIds 收集段，结构与 TargetedRunPage 一致）。仍错 bump 逻辑不动（自评 incorrect 的记录 isCorrect=false，自然进仍错集合）。

- [ ] **Step 3: AnswerModal（课堂练习）**

3a. import `selfAssessPractice`；`QuestionRunner` 加：

```tsx
      onSelfAssess={async (q, assessment, ctx) => {
        await selfAssessPractice({
          cardId,
          lessonId,
          subjectId,
          questionN: q.n,
          questionText: q.text,
          questionId: ctx.questionId,
          studentAnswer: ctx.studentAnswer,
          assessment,
        });
      }}
```

3b. 判题进度外壳文案兼容：主观题同步提交期间 `progress[q.n]='judging'` 已由 `handleRunnerSubmit` 覆盖（自评视图渲染时 QuestionRunner 处于 `self_assess` phase，进度外壳不干扰）。

- [ ] **Step 4: CleanupPhase（错题清零）**

读文件定位其 `handleSubmit`（:82 附近 `judgePractice({...})` 用 error 记录的 cardId/lessonId）。加同款 `onSelfAssess`——context 从其 `errorByN` 映射取 cardId/lessonId（变量名以文件实际为准）：

```tsx
      onSelfAssess={async (q, assessment, ctx) => {
        const err = errorByN.get(q.n);   // ← 以文件内既有映射名/取法为准
        await selfAssessPractice({
          cardId: err.cardId,
          lessonId: err.lessonId,
          subjectId: MATH_SUBJECT_ID,    // ← 以文件内既有 subjectId 来源为准
          questionN: q.n,
          questionText: q.text,
          questionId: ctx.questionId,
          studentAnswer: ctx.studentAnswer,
          assessment,
        });
      }}
```

- [ ] **Step 5: ExamResultPage**

5a. `answers` 映射改造（:110-124）：

```typescript
  const answers = useMemo(() => {
    const map: Record<
      string,
      { isCorrect: boolean; method: string; studentAnswer: string; failed: boolean; needsSelfAssess: boolean; selfAssessment: 'correct' | 'incorrect' | null }
    > = {};
    for (const it of items ?? []) {
      map[String(it.questionNo)] = {
        isCorrect: it.isCorrect === 1,
        method: it.isCorrect === null ? 'self_assess' : '',
        studentAnswer: it.answerText ?? '',
        failed: false,
        needsSelfAssess: it.isCorrect === null && it.selfAssessment == null,
        selfAssessment: it.selfAssessment ?? null,
      };
    }
    return map;
  }, [items]);
```

5b. 参考答案映射 + 自评提交：

```typescript
  const referenceAnswers = useMemo(() => {
    const map: Record<string, string | null> = {};
    for (const it of items ?? []) map[String(it.questionNo)] = it.answer ?? null;
    return map;
  }, [items]);

  // 自评提交后更新本地态（消除 needsSelfAssess / 记录 selfAssessment），未自评横幅随之消失
  const handleSelfAssess = async (n: string, assessment: 'correct' | 'incorrect') => {
    const qid = questionIdByN.get(n);
    if (qid == null) return;
    await selfAssessTraining({ questionId: qid, subjectId: 1, assessment, source: 'exam', sourceRefId: sid });
    setItems((prev) =>
      (prev ?? []).map((it) =>
        String(it.questionNo) === n ? { ...it, selfAssessment: assessment, needsSelfAssessment: false } : it,
      ),
    );
  };
```

（`subjectId` 若页面已有学科常量则用常量；import `selfAssessTraining`。）

5c. `AnswerResultList` 传新 props：

```tsx
          referenceAnswers={referenceAnswers}
          onSelfAssess={handleSelfAssess}
```

5d. 得分卡（headerExtra）改为客观题口径 + 未自评横幅：

```tsx
          headerExtra={
            summary && (
              <div>
                {(() => {
                  const unassessed = (items ?? []).filter((it) => it.isCorrect === null && it.selfAssessment == null).length;
                  if (unassessed > 0) {
                    return (
                      <div className="flex items-center justify-center gap-2 py-2 bg-[var(--brand-100)] text-[13px] text-[var(--warning)]">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                          <circle cx="12" cy="12" r="10" />
                          <path d="M12 8v4" />
                          <path d="M12 16h.01" />
                        </svg>
                        还有 {unassessed} 题未自评，请在下方列表完成自评
                      </div>
                    );
                  }
                  return null;
                })()}
                <div className="flex items-center justify-center gap-10 py-5">
                  {/* 答对题数 / 总题数 三块保留；「总题数」改为「客观题 X / Y」+ 主观题计数 */}
                  <div className="text-center">
                    <div className="font-mono text-4xl font-bold leading-none text-[var(--success)]">{summary.correctCount}</div>
                    <div className="mt-1.5 text-xs text-[var(--text-secondary)]">客观题答对</div>
                  </div>
                  <div className="h-10 w-px bg-[var(--bg-subtle)]" aria-hidden="true" />
                  <div className="text-center">
                    <div className="font-mono text-4xl font-bold leading-none text-[var(--text-primary)]">
                      {summary.totalCount - (summary.subjectiveCount ?? 0)}
                    </div>
                    <div className="mt-1.5 text-xs text-[var(--text-secondary)]">客观题总数</div>
                  </div>
                  <div className="h-10 w-px bg-[var(--bg-subtle)]" aria-hidden="true" />
                  <div className="text-center">
                    <div className="font-mono text-4xl font-bold leading-none text-[var(--brand-500)]">{summary.accuracy}%</div>
                    <div className="mt-1.5 text-xs text-[var(--text-secondary)]">客观题正确率</div>
                  </div>
                  {(summary.subjectiveCount ?? 0) > 0 && (
                    <>
                      <div className="h-10 w-px bg-[var(--bg-subtle)]" aria-hidden="true" />
                      <div className="text-center">
                        <div className="font-mono text-4xl font-bold leading-none text-[var(--brand-500)]">{summary.subjectiveCount}</div>
                        <div className="mt-1.5 text-xs text-[var(--text-secondary)]">主观题（自评）</div>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )
          }
```

5e. 解析初始化段（:60-67）：`it.isCorrect === 0` 的收集条件改为 `it.isCorrect === 0 || (it.isCorrect === null && it.selfAssessment === 'incorrect')`（自评做错的主观题也补拉解析）。

- [ ] **Step 6: build + lint + Commit**

Run: `cd apps/web && npm run build && npm run lint`
Expected: 通过。

```bash
git add apps/web/src/pages/student/training/ apps/web/src/components/business/AnswerModal.tsx apps/web/src/components/business/CleanupPhase.tsx
git commit -m "feat(web): 四场景自评接线（专项/错题/课堂/考试结果页）"
```

---

### Task 12: calculation 题型配套（labeler / prompt / 前端标签）

**Files:**
- Modify: `tools/data-refinery/src/question_labeler.py:12`
- Modify: `tools/data-refinery/src/prompts/exam_questions.txt`
- Modify: `apps/server/src/ai-core/prompts/judgment/math-calculation.md`
- Modify: 前端题型标签映射（`grep -rn "short_answer" apps/web/src --include="*.tsx" --include="*.ts" -l | grep -iv test` 定位，通常在训练配置页/题面标签组件）

- [ ] **Step 1: labeler 白名单**

`question_labeler.py` 的 `_VALID_TYPES` 加 `'calculation'`（读文件确认集合写法后追加）。

- [ ] **Step 2: 标注 prompt 规则**

`prompts/exam_questions.txt` 题型说明区追加一行规则（读文件定位题型枚举段后插入，增量编辑勿重写全文）：

```
- calculation：计算题——答案是一个简短最终结果（数值/表达式/坐标），过程性论述或证明不归此类（归 short_answer/proof）
```

- [ ] **Step 3: judgment prompt 措辞**

`apps/server/src/ai-core/prompts/judgment/math-calculation.md` 的「判断规则」列表追加（增量 Edit，勿动其余规则）：

```
6. 学生答案与标准答案**等价**即判对（如 $0.5$ 与 $\frac{1}{2}$、$x=3$ 与 $3$、$(-2,1)$ 与 $(1,-2)$ 当且仅当语义相同），解法不必与参考答案相同。
```

- [ ] **Step 4: 前端题型标签**

定位题型中文映射（如 `{ choice: '选择', fill_blank: '填空', ... }`），加 `calculation: '计算'`；专项训练配置页的题型选项列表同步加「计算」（TargetedRunPage 的配置页文件按 `grep -rn "专项" apps/web/src/pages/student/training/ -l` 定位）。

- [ ] **Step 5: 测试 + Commit**

Run: `cd tools/data-refinery && pytest tests/test_question_labeler.py -q`
Expected: PASS（若有用例断言合法类型集合，同步扩展断言）。

```bash
git add tools/data-refinery/src/ apps/server/src/ai-core/prompts/ apps/web/src/
git commit -m "feat: calculation 题型配套（labeler/prompt/前端标签）"
```

---

### Task 13: 文档同步（API 契约 + CLAUDE.md + changelog）

**Files:**
- Modify: `docs/api/openapi.yaml`
- Modify: `docs/API接口与数据流设计文档.md`
- Modify: `CLAUDE.md`
- Modify: `docs/ai-core-changelog.md`

- [ ] **Step 1: openapi.yaml** 加两个端点（找到 `/api/training/judge` 的定义块，同款风格追加）：

```yaml
  /api/training/self-assess:
    post:
      summary: 主观题学生自评（self_assess 模式）
      description: short_answer/proof 在 JUDGE_SUBJECTIVE_MODE=self_assess 下不判对错；学生对照参考答案自评。incorrect 入错题本 / correct 清零未清错题；每次自评写 question_self_assessments 留痕。
      tags: [training]
      security: [{ bearerAuth: [] }]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [questionId, subjectId, assessment, source]
              properties:
                questionId: { type: integer }
                subjectId: { type: integer }
                assessment: { type: string, enum: [correct, incorrect] }
                source: { type: string, enum: [targeted, error_practice, exam] }
                sourceRefId: { type: integer, nullable: true }
      responses:
        '200':
          description: 自评已落库
          content:
            application/json:
              schema:
                type: object
                properties:
                  code: { type: integer, example: 0 }
                  data:
                    type: object
                    properties:
                      errorBookId: { type: integer, nullable: true }

  /api/practice/self-assess:
    post:
      summary: 课堂练习主观题自评（self_assess 模式）
      description: 补写 practice_results（method='self_assess'）+ 自评留痕 + 错题本写入/清零。questionId 可为 null（孤儿题按 card+题面匹配错题本）。
      tags: [practice]
      security: [{ bearerAuth: [] }]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [cardId, lessonId, subjectId, questionN, questionText, assessment]
              properties:
                cardId: { type: integer }
                lessonId: { type: integer }
                subjectId: { type: integer }
                questionN: { type: string }
                questionText: { type: string }
                questionId: { type: integer, nullable: true }
                studentAnswer: { type: string }
                assessment: { type: string, enum: [correct, incorrect] }
      responses:
        '200':
          description: 自评已落库
          content:
            application/json:
              schema:
                type: object
                properties:
                  code: { type: integer, example: 0 }
                  data: { nullable: true }
```

（按文件内既有缩进与 tags 命名对齐；`/api/exams/sessions/{id}/results` 的响应 schema 同步加 `answer`/`needsSelfAssessment`/`selfAssessment`/`subjectiveCount` 字段说明。）

- [ ] **Step 2: API 设计文档** `docs/API接口与数据流设计文档.md`：§4 端点清单加两行；§6 数据流补「主观题自评」时序（提交 → needsSelfAssessment → 前端展开参考答案 → 自评落库 → 错题本/清零）；`GET /exams/sessions/:id/results` 条目说明补新字段。**跑对照检查**：`grep -n "self-assess" docs/api/openapi.yaml docs/API接口与数据流设计文档.md` 两边都有。

- [ ] **Step 3: CLAUDE.md** 「判题与解析分离」条目后追加一段（增量 Edit）：

```markdown
- **判题体系分层（2026-09-09 起）**：`JudgeCoreService` 四路由——choice/true_false 程序比对；fill_blank/calculation 归一化比对 + AI 等价判断；short_answer/proof 由 `JUDGE_SUBJECTIVE_MODE` 控制（默认 `self_assess`：不判对错，学生自评「我做对了/做错了」走 `recordSelfAssessment` 留痕 + 错题本写入/清零；`ai`：原 JudgmentCapability 逻辑保留可切回）。calculation 为新增题型（结果型计算题，从 short_answer 拆出）。考试主观题 `is_correct=NULL`、成绩只算客观题；课堂练习主观题 practice_results 推迟到自评端点落行。设计见 `docs/superpowers/specs/2026-09-09-judging-rework-design.md`。
```

- [ ] **Step 4: changelog** `docs/ai-core-changelog.md` 顶部加条目（沿用文件内既有格式）：日期 2026-09-09、变更摘要、动机（国产模型判题准确率不足）、局限/待办（存量 short_answer 拆 calculation 依赖 answer_importer 批次回写）。

- [ ] **Step 5: Commit**

```bash
git add docs/api/openapi.yaml docs/API接口与数据流设计文档.md CLAUDE.md docs/ai-core-changelog.md
git commit -m "docs: 判题体系重构文档同步（openapi/API 设计/CLAUDE.md/changelog）"
```

---

### Task 14: 端到端验证

- [ ] **Step 1: 重启服务**

用户环境用 services.sh（构建 + vite preview 5173）+ server。提醒用户重启（或自己跑 `cd apps/web && npm run build` 后由用户 restart）。**改了没变化先对 restart 与源码修改时间线**（记忆约定）。

- [ ] **Step 2: curl 验证服务端**（lc1/123456 登录取 token；**用 curl 不用截图**——记忆约定）

```bash
# 登录
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"lc1","password":"123456","role":"student"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['accessToken'])")

# 找一道 short_answer 题提交 → 期望 needsSelfAssessment=true、isCorrect=null、method=self_assess
QID=$(mysql -u ai_k12 -pai_k12 ai_k12 -N -e "SELECT id FROM questions WHERE type='short_answer' AND answer<>'' AND is_active=1 LIMIT 1")
curl -s -X POST http://localhost:3000/api/training/judge -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"questionId\":$QID,\"subjectId\":1,\"studentAnswer\":\"我的解答\",\"source\":\"targeted\"}"

# 自评 incorrect → 期望 errorBookId 返回
curl -s -X POST http://localhost:3000/api/training/self-assess -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"questionId\":$QID,\"subjectId\":1,\"assessment\":\"incorrect\",\"source\":\"targeted\"}"

# DB 验证：question_self_assessments 有行、main_error_books 有未清行
mysql -u ai_k12 -pai_k12 ai_k12 -e "SELECT * FROM question_self_assessments ORDER BY id DESC LIMIT 1; SELECT id,question_id,is_cleared FROM main_error_books WHERE question_id=$QID ORDER BY id DESC LIMIT 1;"

# 自评 correct → 清零
curl -s -X POST http://localhost:3000/api/training/self-assess -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"questionId\":$QID,\"subjectId\":1,\"assessment\":\"correct\",\"source\":\"targeted\"}"
mysql -u ai_k12 -pai_k12 ai_k12 -e "SELECT id,is_cleared FROM main_error_books WHERE question_id=$QID ORDER BY id DESC LIMIT 1;"
```

（auth 端点路径与响应结构以 `apps/server/src/modules/auth` 实际为准，先 `curl -s http://localhost:3000/api/...` 探测；server 端口同理。）

- [ ] **Step 3: 浏览器过三个结果页**（lc1 账号，5173）

- 专项训练选含主观题的知识点开练：主观题提交后出现「对照参考答案，自评这道题」视图，不点按钮点不了下一题；
- 考试：作答阶段主观题无反馈，交卷后结果页客观题对错 + 主观题自评按钮 + 未自评横幅，自评完横幅消失、刷新后已自评状态保留；
- 错题练习：自评 incorrect 的主观题出现在错题本，重做自评 correct 后清零。

浏览器只验交互细节，数据正确性以 Step 2 的 curl/DB 为准。

- [ ] **Step 4: 收尾 Commit（如有零星修正）**

```bash
git add -A && git commit -m "fix: 判题体系重构端到端联调修正"
```

---

## Self-Review 记录

- **Spec 覆盖**：§3 分层表 → Task 3/4；§4 答案补全 → 配套计划 answer-importer（本计划不含，已在头部声明）；§5 calculation 落地 → Task 4/12；§6 运行时改造 → Task 3（6.1 路由/6.2 契约/6.3 守卫）；§7 自评 → Task 2/3/5/6/9/10/11；§8 考试 → Task 7/11；§9 ExplanationCache → 无改动（保留兜底，spec 明确不动）；§10 测试 → 各任务 TDD + Task 14 端到端；§12 文档同步 → Task 1/13。
- **类型一致性**：`JudgeOutput.method` 四值（exact/ai/self_assess/unanswered）在 Task 3/7/8 一致；`assessment: 'correct'|'incorrect'` 全链路一致；`QuestionSelfAssessmentsRepository.findLatestByStudentAndQuestionIds` 在 Task 2 定义、Task 7 消费。
- **已知风险**：① `advance` 抽取改变了 QuestionRunner 末题等待时序（原为 await，现改为 then）——Task 9 Step 3 的测试覆盖末题自评后 onFinish 触发；② ExamResultItem.isCorrect 放宽为 `number|null` 可能影响其他消费方——Task 8 Step 4 已注明须在 Task 11 清零编译错误。
