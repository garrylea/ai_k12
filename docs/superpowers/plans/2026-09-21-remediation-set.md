# 错题补偿套题（相似题专项练习）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 数学考试/专项练习出分后，征得学生同意按（考点+题型+难度）三元组生成相似题套题（每组 3 题、题库优先 AI 兜底），挂训练轨三卡页提示，逐题作答答对清零、全对清套，按题型发积分。

**Architecture:** 训练轨内新增 `remediation` 三表（sets/groups/items）与两个 service（生成器 + 编排），判题复用 `JudgeCoreService`（新增 `remediation` 来源跳过错题本副作用），AI 补题复用 ai-core `VariationCapability` 走 fire-and-forget + in-flight 去重 + 惰性重试；前端新增询问卡组件、三卡页提示条与套题作答页（复用 `QuestionRunner`）。

**Tech Stack:** NestJS + mysql2（repo 模式）、Vitest（手写 mock，不连真库）、React 19 + React Router 6 + Zustand、React Testing Library（jsdom，`globals: false`）。

**Spec:** `docs/superpowers/specs/2026-09-21-remediation-set-design.md`（含 9 项用户裁决，本计划不再复述理由）

**关键铁律（执行中勿违背）：**

- 后端跑 `node dist/main.js`（`npx tsx src/main.ts` 的 DI 是坏的）；单测 `cd apps/server && npx vitest run <file>`。
- LLM 调用无墙钟上限 —— `fillWithAi` 绝不 await；积分/掌握度写入失败只 warn，绝不影响判题主链路。
- AI 生成题入库 `questions` 时 `options` 必须剥掉 `isCorrect`（否则选项里藏答案，判题前就泄漏）。
- 前端测试必须 `afterEach(() => cleanup())`（globals: false）；组件改动必须补渲染测试。
- 文档表格用 em dash（—），不是连字符。
- 测试断言与设计冲突时测试错——改测试，勿改设计文档。
- 新端点是 Nest `@Post`，响应按 201 记（openapi 写 `'201'`）。

---

### Task 1: DB 迁移 + schema.sql 折回

**Files:**
- Create: `tools/db/migrations/2026-09-21_remediation_sets.sql`
- Modify: `tools/db/schema.sql`（训练表家族，`training_sessions` 建表段之后）
- Modify: `tools/data-refinery/`（`--purge-business-data` 的 FK 安全清理序）

- [ ] **Step 1: 写迁移文件**

创建 `tools/db/migrations/2026-09-21_remediation_sets.sql`：

```sql
-- 日期：2026-09-21 主旨：错题补偿套题（相似题专项练习）三表
-- 设计：docs/superpowers/specs/2026-09-21-remediation-set-design.md

-- 做什么：
--   1. remediation_sets：套题头（每学生每学科至多一条 active；全对后整行删除，无其他状态）
--   2. remediation_groups：组（(set_id, kp_id, type, difficulty) 唯一 = 三元组追加合并去重键）
--   3. remediation_set_items：组内题目（is_correct 答对标记；points_awarded 首答发分防重）

-- 为什么：
--   - 套题自清零（spec §2 决策 7）状态必须落库才能跨会话续做
--   - ai_pending_count 记 AI 补题缺口：fire-and-forget 进程重启会悬挂，读取端惰性重试（spec §5.1）
--   - question_id 外键 RESTRICT（先例 variation_questions.fk_vq_question_id）：
--     db_loader full-reload 有业务数据守卫，--purge-business-data 按 FK 安全序清理
--   - 无 subject 外键（同 training_sessions——subjects 是 seed 维表，业务表不挂）

-- 幂等：CREATE TABLE IF NOT EXISTS，重复执行无副作用。
-- 回滚：DROP TABLE remediation_set_items; DROP TABLE remediation_groups; DROP TABLE remediation_sets;

CREATE TABLE IF NOT EXISTS remediation_sets (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT      NOT NULL,
  subject_id BIGINT      NOT NULL COMMENT '首期恒数学（MATH_SUBJECT_ID=1）',
  status     VARCHAR(16) NOT NULL DEFAULT 'active' COMMENT 'active（全对后整行删除）',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_rsets_student (student_id, status),
  CONSTRAINT fk_rsets_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS remediation_groups (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  set_id             BIGINT      NOT NULL,
  kp_id              BIGINT      NOT NULL COMMENT '触发原错题的 primary 知识点',
  type               VARCHAR(20) NOT NULL,
  difficulty         SMALLINT    NOT NULL,
  origin_question_id BIGINT      NOT NULL COMMENT '触发本组的原错题（审计）',
  ai_pending_count   SMALLINT    NOT NULL DEFAULT 0 COMMENT 'AI 补题缺口；补完/失败清零，>0 且无 in-flight = 进程重启悬挂',
  created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_rgroups_triple (set_id, kp_id, type, difficulty),
  CONSTRAINT fk_rgroups_set_id FOREIGN KEY (set_id) REFERENCES remediation_sets (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS remediation_set_items (
  id               BIGINT AUTO_INCREMENT PRIMARY KEY,
  group_id         BIGINT      NOT NULL,
  question_id      BIGINT      NOT NULL,
  is_correct       TINYINT(1)  NOT NULL DEFAULT 0 COMMENT '套题自清零标记：答对置 1',
  points_awarded   TINYINT(1)  NOT NULL DEFAULT 0 COMMENT '首答发分防重（dedupe_key rem:<id> 兜底）',
  attempts         SMALLINT    NOT NULL DEFAULT 0,
  last_answered_at DATETIME(3) DEFAULT NULL,
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_ritems_group_question (group_id, question_id),
  KEY idx_ritems_group (group_id, is_correct),
  CONSTRAINT fk_ritems_group_id FOREIGN KEY (group_id) REFERENCES remediation_groups (id) ON DELETE CASCADE,
  CONSTRAINT fk_ritems_question_id FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 2: 折回 schema.sql**

在 `tools/db/schema.sql` 中 `training_sessions` 建表语句之后（约 1160 行，`-- 14. 埋点与账本` 注释之前）插入与迁移文件**完全相同**的三段 `CREATE TABLE IF NOT EXISTS`，并在其前加注释行：

```sql
-- ===== 错题补偿套题（相似题专项，2026-09-21）=====
-- 折回自 migrations/2026-09-21_remediation_sets.sql（install_mysql.sh 只执行 schema.sql，迁移需同步折回）。
-- 设计：docs/superpowers/specs/2026-09-21-remediation-set-design.md
```

- [ ] **Step 3: 更新 db_loader 的业务数据清理序**

`remediation_set_items` 对 `questions` 有 RESTRICT 外键，full-reload 清 questions 前必须先清套题。在 `tools/data-refinery/` 中定位 purge 清理清单：

```bash
grep -rn "purge-business-data\|main_error_books" tools/data-refinery --include="*.py" -l
```

找到 FK 安全清理函数后，在**清理 `questions` 之前**插入一行（`remediation_sets` 级联清 groups/items，无需单列三表）：

```python
'DELETE FROM remediation_sets',
```

（清单若是 SQL 文本列表，按同样位置加同样的语句。）

- [ ] **Step 4: 手工 apply 迁移并验证**

```bash
mysql -u ai_k12 -pai_k12 ai_k12 < tools/db/migrations/2026-09-21_remediation_sets.sql
mysql -u ai_k12 -pai_k12 ai_k12 -e "SHOW CREATE TABLE remediation_groups\G" | head -30
```

Expected: 三张表存在，`remediation_groups` 有 `uniq_rgroups_triple` 唯一键。再跑一次迁移文件验证幂等（无报错、无变化）。

- [ ] **Step 5: Commit**

```bash
git add tools/db/migrations/2026-09-21_remediation_sets.sql tools/db/schema.sql tools/data-refinery
git commit -m "feat(db): 错题补偿套题三表（sets/groups/items）迁移与 schema 折回"
```

---

### Task 2: 积分默认规则（新任务 remediation_question）

**Files:**
- Modify: `apps/server/src/modules/points/default-rules.ts`
- Test: `apps/server/src/modules/points/default-rules.test.ts`

- [ ] **Step 1: 先改测试（失败测试）**

打开 `apps/server/src/modules/points/default-rules.test.ts`，把对任务数/规则条数的断言更新为「9 类任务、18 条默认档位」（原 8 类 15 条——具体断言写法以现文件为准，找到计数的 `expect` 改数值），并新增档位断言：

```ts
  it('remediation_question 按题型三档：选择 3 / 填空 4 / 大题 6，不限每日上限', () => {
    const tiers = DEFAULT_RULES.filter((r) => r.taskCode === 'remediation_question');
    expect(tiers.map((t) => [t.tierKey, t.points, t.dailyLimit])).toEqual([
      ['choice', 3, null],
      ['fill_blank', 4, null],
      ['major', 6, null],
    ]);
  });

  it('TASK_NAMES 含相似题专项', () => {
    expect(TASK_NAMES.remediation_question).toBe('相似题专项');
  });
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/server && npx vitest run src/modules/points/default-rules.test.ts
```

Expected: FAIL（`remediation_question` 规则不存在）。

- [ ] **Step 3: 实现默认规则**

`apps/server/src/modules/points/default-rules.ts`：`TASK_NAMES` 对象末尾（`en_vocabulary` 之后）加一行；`DEFAULT_RULES` 数组在 `error_fix`（sortOrder 40）之后插入三条（占 35–37 空档，紧邻数学专项）：

```ts
  remediation_question: '相似题专项',
```

```ts
  { taskCode: 'remediation_question', taskName: '相似题专项', tierKey: 'choice',     tierLabel: '选择题', points: 3, dailyLimit: null, sortOrder: 35 },
  { taskCode: 'remediation_question', taskName: '相似题专项', tierKey: 'fill_blank', tierLabel: '填空题', points: 4, dailyLimit: null, sortOrder: 36 },
  { taskCode: 'remediation_question', taskName: '相似题专项', tierKey: 'major',      tierLabel: '大题',   points: 6, dailyLimit: null, sortOrder: 37 },
```

存量学生无需回填脚本——`PointsService.award()` 的 `insertIgnoreBatch` 与 `PointRulesService.ensureRules()` 只补缺失的 `(taskCode, tierKey)`，新增任务零迁移（spec §7）。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/server && npx vitest run src/modules/points/default-rules.test.ts
```

Expected: PASS（全部用例）。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/points/default-rules.ts apps/server/src/modules/points/default-rules.test.ts
git commit -m "feat(points): 新任务 remediation_question 按题型三档（选择3/填空4/大题6）"
```

---

### Task 3: 仓储扩展（questions / knowledge-points / training-sessions）

**Files:**
- Modify: `apps/server/src/database/repositories/questions.repo.ts`（类末尾、`findRandomByKpAndType` 之后加三个方法）
- Modify: `apps/server/src/database/repositories/knowledge-points.repo.ts`（加 `findById`）
- Modify: `apps/server/src/database/repositories/training-sessions.repo.ts`（若缺 `findById` 则补）

- [ ] **Step 1: questions.repo.ts 加三个方法**

在 `QuestionsRepository` 类的 `findRandomByKpAndType` 方法之后（类闭括号前）加入：

```ts
  /** 补偿套题抽题（2026-09-21）：同考点 + 同题型 + 难度档（数组）随机取题。
   *  谓词与 findRandomByKpAndType 同源（「不再展示」排除、空答案排除、is_active）；
   *  难度由调用方按放宽阶梯（先同档，再 ±1 档）分次传入；
   *  excludeQuestionIds 排除原错题与套题已有题。kp 匹配不限 role（与专项抽题一致，次级标注也算考过该点）。 */
  async findRandomByKpTypeDifficulty(
    studentId: number,
    subjectId: number,
    kpId: number,
    type: string,
    difficulties: number[],
    count: number,
    excludeQuestionIds: number[],
  ): Promise<QuestionRow[]> {
    const diffFilter = difficulties.map(() => '?').join(',');
    const exclusion = excludeQuestionIds.length > 0
      ? ` AND q.id NOT IN (${excludeQuestionIds.map(() => '?').join(',')})`
      : '';
    const sql = `SELECT q.* FROM questions q
      JOIN question_knowledge_points qkp ON qkp.question_id = q.id
      LEFT JOIN student_hidden_questions shq
        ON shq.question_id = q.id AND shq.student_id = ?
      WHERE q.subject_id = ? AND qkp.knowledge_point_id = ? AND q.is_active = 1
        AND q.type = ? AND q.difficulty IN (${diffFilter})
        AND q.answer <> ''
        AND shq.id IS NULL${exclusion}
      ORDER BY RAND() LIMIT ?`;
    // pool.query（非 execute）：LIMIT 占位符会被 MySQL prepared statement 拒绝
    //（见 findRandomByKpAndType 注释，联调实测过的问题）。
    const [rows] = await this.pool.query<RowDataPacket[]>(sql, [
      studentId, subjectId, kpId, type, ...difficulties, ...excludeQuestionIds, count,
    ]);
    return rows as QuestionRow[];
  }

  /** 批量按主键取在用题（补偿套题生成：由错题 id 反查题型/难度/题干）。 */
  async findByIds(ids: number[]): Promise<QuestionRow[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM questions WHERE is_active = 1 AND id IN (${placeholders})`,
      ids,
    );
    return rows as QuestionRow[];
  }

  /** question_id -> primary 知识点 id（补偿套题按 primary 考点分组；无 primary 的题由调用方跳过）。 */
  async findPrimaryKpIds(questionIds: number[]): Promise<Map<number, number>> {
    if (questionIds.length === 0) return new Map();
    const placeholders = questionIds.map(() => '?').join(',');
    const [rows] = await this.pool.query<(RowDataPacket & { question_id: number; knowledge_point_id: number })[]>(
      `SELECT question_id, knowledge_point_id FROM question_knowledge_points
       WHERE role = 'primary' AND question_id IN (${placeholders})`,
      questionIds,
    );
    return new Map(rows.map((r) => [Number(r.question_id), Number(r.knowledge_point_id)]));
  }
```

- [ ] **Step 2: knowledge-points.repo.ts 加 findById**

先 `grep -n "async" apps/server/src/database/repositories/knowledge-points.repo.ts` 看现有方法与行接口名；若已有 `findById` 跳过此步。否则在类中加入（行接口沿用该文件已定义/导入的那个）：

```ts
  /** 单个知识点（补偿套题 AI 生成需要考点名，2026-09-21）。 */
  async findById(id: number): Promise<KnowledgePointRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM knowledge_points WHERE id = ?`,
      [id],
    );
    return (rows[0] as KnowledgePointRow) ?? null;
  }
```

（若该文件没有导出的行接口，先看 `findBySubject` 返回什么类型，照它定义/复用；`knowledge_points` 表至少有 `id`/`name` 列。）

- [ ] **Step 3: training-sessions.repo.ts 确认/补 findById**

```bash
grep -n "findById" apps/server/src/database/repositories/training-sessions.repo.ts
```

若已有则跳过；否则在类中加入（行接口名以文件 4-17 行定义的为准，通常叫 `TrainingSessionRow`）：

```ts
  /** 按 id 取会话（补偿套题 generate 校验专项会话归属，2026-09-21）。 */
  async findById(id: number): Promise<TrainingSessionRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM training_sessions WHERE id = ?`,
      [id],
    );
    return (rows[0] as TrainingSessionRow) ?? null;
  }
```

- [ ] **Step 4: 类型检查**

```bash
cd apps/server && npx tsc --noEmit
```

Expected: 无新增报错（存量报错如有，与本次改动无关则忽略）。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/database/repositories/questions.repo.ts apps/server/src/database/repositories/knowledge-points.repo.ts apps/server/src/database/repositories/training-sessions.repo.ts
git commit -m "feat(repo): 补偿套题抽题/批量取题/primary考点映射 + kp findById + sessions findById"
```

---

### Task 4: judge-core 支持 remediation 来源（跳过错题本副作用）

**Files:**
- Modify: `apps/server/src/modules/practice/judge-core.service.ts:108`（来源注释）
- Modify: `apps/server/src/modules/practice/judge-core.service.ts:233-260`（副作用块）
- Test: `apps/server/src/modules/practice/judge-core.service.test.ts`

- [ ] **Step 1: 先写失败测试**

在 `judge-core.service.test.ts` 中新增用例（mock 依赖的写法照该文件现有 harness；关键断言：source='remediation' 判错时**不调** `mainErrorRepo.create`/`findUnclearedByStudentQuestionId`，判对时**不调** `clearUnclearedByStudentQuestionId`，且不走 error_fix 发分）：

```ts
  it('remediation 来源：判错不入错题本、判对不清零不发 error_fix（套题自清零，spec §8）', async () => {
    // 题型 choice + 答错：走 exact 路由，不依赖 AI 判定
    questionsRepo.findById.mockResolvedValue({
      id: 11, subject_id: 1, type: 'choice', difficulty: 1,
      content: '1+1=?', options: JSON.stringify([{ label: 'A', text: '1' }, { label: 'B', text: '2' }]),
      answer: 'B', explanation: null, source: null, content_hash: null, is_active: 1, created_at: new Date(),
    });
    await service.judgeQuestion({ studentId: 1, subjectId: 1, questionId: 11, studentAnswer: 'A', source: 'remediation' });
    expect(mainErrorRepo.create).not.toHaveBeenCalled();
    expect(mainErrorRepo.findUnclearedByStudentQuestionId).not.toHaveBeenCalled();

    await service.judgeQuestion({ studentId: 1, subjectId: 1, questionId: 11, studentAnswer: 'B', source: 'remediation' });
    expect(mainErrorRepo.clearUnclearedByStudentQuestionId).not.toHaveBeenCalled();
    expect(pointsService.award).not.toHaveBeenCalled();
  });
```

（mock 对象名以该测试文件现有 harness 为准——若 harness 里叫别的名字，用现有名字。）

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/server && npx vitest run src/modules/practice/judge-core.service.test.ts
```

Expected: FAIL（当前 remediation 判错会走 `writeErrorBookOrReuse`，mock 被调用）。

- [ ] **Step 3: 改 judge-core**

`judge-core.service.ts:108` 的来源注释改为：

```ts
  source: string;            // 'targeted' | 'error_practice' | 'exam' | 'practice' | 'remediation'
```

在 233 行 `let errorBookId: number | undefined;` 之后、`if (!isCorrect) {` 之前插入早退分支：

```ts
    // 补偿套题（2026-09-21，spec §6/§8）：套题自清零——不入错题本、不清零原错题、不发 error_fix
    //（原错题已按 §7.4 入本，套题内做错不重复记账）。答错仍触发解析缓存（fire-and-forget，
    // 无害）供套题作答反馈复用；掌握度回写保留（finishJudge，派生数据与判题来源无关）。
    if (input.source === 'remediation') {
      if (!isCorrect) {
        this.explanationCache.ensureExplanation(q);
      }
      return this.finishJudge(input.studentId, {
        questionId: q.id, isCorrect, method, errorType, errorBookId: undefined, pointsAwarded: 0,
      });
    }
```

- [ ] **Step 4: 跑测试确认通过（含既有用例防回归）**

```bash
cd apps/server && npx vitest run src/modules/practice/judge-core.service.test.ts
```

Expected: PASS（新用例 + 既有 targeted/exam 来源用例全绿——早退分支只对 `'remediation'` 生效）。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/practice/judge-core.service.ts apps/server/src/modules/practice/judge-core.service.test.ts
git commit -m "feat(judge-core): remediation 来源跳过错题本/清零/error_fix（套题自清零）"
```

---

### Task 5: RemediationRepository（套题三表仓储）

**Files:**
- Create: `apps/server/src/database/repositories/remediation.repo.ts`
- Test: `apps/server/src/database/repositories/remediation.repo.test.ts`（可选，若仓库无单测文化可跳过；本计划要求至少一个 repo 冒烟测试，mock pool）

- [ ] **Step 1: 实现仓储**

创建 `apps/server/src/database/repositories/remediation.repo.ts`：

```ts
import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export interface RemediationSetRow {
  id: number;
  student_id: number;
  subject_id: number;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export interface RemediationGroupRow {
  id: number;
  set_id: number;
  kp_id: number;
  type: string;
  difficulty: number;
  origin_question_id: number;
  ai_pending_count: number;
  created_at: Date;
}

export interface RemediationItemRow {
  id: number;
  group_id: number;
  question_id: number;
  is_correct: number;
  points_awarded: number;
  attempts: number;
  last_answered_at: Date | null;
  created_at: Date;
}

@Injectable()
export class RemediationRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async findActiveByStudent(studentId: number, subjectId: number): Promise<RemediationSetRow | null> {
    // LIMIT 1 是字面常量，不是占位符，可用 execute
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM remediation_sets WHERE student_id = ? AND subject_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`,
      [studentId, subjectId],
    );
    return (rows[0] as RemediationSetRow) ?? null;
  }

  async createSet(studentId: number, subjectId: number): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO remediation_sets (student_id, subject_id) VALUES (?, ?)`,
      [studentId, subjectId],
    );
    return result.insertId;
  }

  async findGroupById(groupId: number): Promise<RemediationGroupRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM remediation_groups WHERE id = ?`,
      [groupId],
    );
    return (rows[0] as RemediationGroupRow) ?? null;
  }

  async findGroupsBySet(setId: number): Promise<RemediationGroupRow[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM remediation_groups WHERE set_id = ? ORDER BY id`,
      [setId],
    );
    return rows as RemediationGroupRow[];
  }

  async findGroupByTriple(setId: number, kpId: number, type: string, difficulty: number): Promise<RemediationGroupRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM remediation_groups WHERE set_id = ? AND kp_id = ? AND type = ? AND difficulty = ?`,
      [setId, kpId, type, difficulty],
    );
    return (rows[0] as RemediationGroupRow) ?? null;
  }

  async createGroup(setId: number, kpId: number, type: string, difficulty: number, originQuestionId: number): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO remediation_groups (set_id, kp_id, type, difficulty, origin_question_id) VALUES (?, ?, ?, ?, ?)`,
      [setId, kpId, type, difficulty, originQuestionId],
    );
    return result.insertId;
  }

  async updateGroupAiPending(groupId: number, count: number): Promise<void> {
    await this.pool.execute(`UPDATE remediation_groups SET ai_pending_count = ? WHERE id = ?`, [count, groupId]);
  }

  /** INSERT IGNORE：撞 uniq_ritems_group_question（同组同题）静默跳过，返回实际插入数。 */
  async insertItems(groupId: number, questionIds: number[]): Promise<number> {
    if (questionIds.length === 0) return 0;
    const values = questionIds.map(() => '(?, ?)').join(',');
    const params = questionIds.flatMap((qid) => [groupId, qid]);
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT IGNORE INTO remediation_set_items (group_id, question_id) VALUES ${values}`,
      params,
    );
    return result.affectedRows;
  }

  async findItemsBySet(setId: number): Promise<RemediationItemRow[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT i.* FROM remediation_set_items i
       JOIN remediation_groups g ON g.id = i.group_id
       WHERE g.set_id = ? ORDER BY i.id`,
      [setId],
    );
    return rows as RemediationItemRow[];
  }

  async findItemBySetQuestion(setId: number, questionId: number): Promise<RemediationItemRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT i.* FROM remediation_set_items i
       JOIN remediation_groups g ON g.id = i.group_id
       WHERE g.set_id = ? AND i.question_id = ?`,
      [setId, questionId],
    );
    return (rows[0] as RemediationItemRow) ?? null;
  }

  async markItemCorrect(itemId: number): Promise<void> {
    await this.pool.execute(`UPDATE remediation_set_items SET is_correct = 1 WHERE id = ?`, [itemId]);
  }

  async markPointsAwarded(itemId: number): Promise<void> {
    await this.pool.execute(`UPDATE remediation_set_items SET points_awarded = 1 WHERE id = ?`, [itemId]);
  }

  async recordAttempt(itemId: number): Promise<void> {
    await this.pool.execute(
      `UPDATE remediation_set_items SET attempts = attempts + 1, last_answered_at = NOW(3) WHERE id = ?`,
      [itemId],
    );
  }

  /** 全对清套：物理删除整套记录（CASCADE 清 groups/items；spec §2 决策 7）。 */
  async deleteSet(setId: number): Promise<void> {
    await this.pool.execute(`DELETE FROM remediation_sets WHERE id = ?`, [setId]);
  }
}
```

- [ ] **Step 2: 类型检查**

```bash
cd apps/server && npx tsc --noEmit
```

Expected: 无新增报错。

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/database/repositories/remediation.repo.ts
git commit -m "feat(repo): 错题补偿套题三表仓储（RemediationRepository）"
```

---

### Task 6: RemediationGeneratorService（三元组成组 + 题库抽题 + AI 异步补题）

**Files:**
- Create: `apps/server/src/modules/training/remediation-generator.service.ts`
- Create: `apps/server/src/modules/training/remediation-generator.service.test.ts`

> **延后项（本期未实现）**：spec §5.3 的「数学题过逻辑自洽校验（§7.10 风控要求）」本期未实现，延后到后续批次 —— 需新增「题目逻辑自洽性」校验能力，范围超出本期；服务端亦无 `validator_passed` 写入方。

- [ ] **Step 1: 写测试（失败）**

`apps/server/src/modules/training/remediation-generator.service.test.ts`，mock questionsRepo/knowledgePointsRepo/remediationRepo/variation，构造 service 新实例：

```ts
import { describe, it, expect, vi } from 'vitest';
import { RemediationGeneratorService } from './remediation-generator.service.js';

function harness() {
  const questionsRepo = {
    findPrimaryKpIds: vi.fn(),
    findRandomByKpTypeDifficulty: vi.fn(),
    findById: vi.fn(),
    findOrCreate: vi.fn(),
    bindKnowledgePoint: vi.fn(),
  };
  const knowledgePointsRepo = { findById: vi.fn() };
  const remediationRepo = {
    findItemsBySet: vi.fn().mockResolvedValue([]),
    findGroupByTriple: vi.fn().mockResolvedValue(null),
    createGroup: vi.fn().mockResolvedValue(100),
    insertItems: vi.fn().mockResolvedValue(0),
    updateGroupAiPending: vi.fn().mockResolvedValue(undefined),
  };
  const variation = { generate: vi.fn() };
  const service = new RemediationGeneratorService(
    questionsRepo as any,
    knowledgePointsRepo as any,
    remediationRepo as any,
    variation as any,
  );
  return { service, questionsRepo, remediationRepo, variation };
}

describe('RemediationGeneratorService.buildGroups', () => {
  it('同三元组合并：两道错题同(考点/题型/难度)只建一组', async () => {
    const { service, questionsRepo, remediationRepo } = harness();
    questionsRepo.findPrimaryKpIds.mockResolvedValue(new Map([[1, 10], [2, 10]]));
    questionsRepo.findRandomByKpTypeDifficulty.mockResolvedValue([
      { id: 101 }, { id: 102 }, { id: 103 },
    ] as any);
    const wrongs = [
      { id: 1, type: 'choice', difficulty: 1 },
      { id: 2, type: 'choice', difficulty: 1 },
    ] as any;
    const res = await service.buildGroups(7, 1, wrongs);
    expect(remediationRepo.createGroup).toHaveBeenCalledTimes(1);
    expect(res.groupsCreated).toBe(1);
  });

  it('题库抽到 1 题则缺口 2 并触发 AI fill（fillWithAi 被调用）', async () => {
    const { service, questionsRepo, remediationRepo, variation } = harness();
    questionsRepo.findPrimaryKpIds.mockResolvedValue(new Map([[1, 10]]));
    questionsRepo.findRandomByKpTypeDifficulty
      .mockResolvedValueOnce([{ id: 101 }] as any)   // 同档只有 1 题
      .mockResolvedValueOnce([] as any);             // ±1 档也没有
    const wrongs = [{ id: 1, type: 'choice', difficulty: 1 }] as any;
    const res = await service.buildGroups(7, 1, wrongs);
    expect(res.aiPendingCount).toBe(2);
    expect(remediationRepo.updateGroupAiPending).toHaveBeenCalledWith(100, 2);
    expect(variation.generate).toHaveBeenCalledTimes(1); // fillWithAi 内部调了
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/server && npx vitest run src/modules/training/remediation-generator.service.test.ts
```

Expected: FAIL（服务文件不存在）。

- [ ] **Step 3: 实现服务**

创建 `apps/server/src/modules/training/remediation-generator.service.ts`：

```ts
import { Injectable, Logger } from '@nestjs/common';
import { QuestionsRepository } from '../../database/repositories/questions.repo.js';
import { KnowledgePointsRepository } from '../../database/repositories/knowledge-points.repo.js';
import { RemediationRepository, type RemediationGroupRow } from '../../database/repositories/remediation.repo.js';
import { VariationCapability } from '../../ai-core/capabilities/variation.capability.js';
import { computeContentHash } from '../../common/utils/content-hash.util.js';
import type { QuestionRow } from '../../database/repositories/types.js';
import type { VariationQuestion } from '../../ai-core/types.js';

export interface BuildGroupsResult {
  groupsCreated: number;
  itemsCreated: number;
  skippedNoKp: number;
  aiPendingCount: number;
}

const GROUP_SIZE = 3;
const MATH_SUBJECT_ID = 1;

@Injectable()
export class RemediationGeneratorService {
  private readonly logger = new Logger(RemediationGeneratorService.name);
  /** groupId -> 补题 promise（进程内去重；重启丢失由 retryPending 惰性重试兜底，spec §5.1） */
  private readonly inFlight = new Map<number, Promise<void>>();

  constructor(
    private readonly questionsRepo: QuestionsRepository,
    private readonly knowledgePointsRepo: KnowledgePointsRepository,
    private readonly remediationRepo: RemediationRepository,
    private readonly variation: VariationCapability,
  ) {}

  /** 同步建组：三元组去重 -> 题库抽题（放宽阶梯）-> 记录 AI 缺口。不调用 LLM，可安全 await。 */
  async buildGroups(studentId: number, setId: number, wrongs: QuestionRow[]): Promise<BuildGroupsResult> {
    const kpMap = await this.questionsRepo.findPrimaryKpIds(wrongs.map((q) => q.id));
    const seenTriples = new Set<string>();
    const existingItems = (await this.remediationRepo.findItemsBySet(setId)).map((i) => i.question_id);
    const result: BuildGroupsResult = { groupsCreated: 0, itemsCreated: 0, skippedNoKp: 0, aiPendingCount: 0 };

    for (const q of wrongs) {
      const kpId = kpMap.get(q.id);
      if (!kpId) {
        result.skippedNoKp++;
        continue; // 无 primary 考点标注，无法成组（spec §5.2）
      }
      const tripleKey = `${kpId}|${q.type}|${q.difficulty}`;
      if (seenTriples.has(tripleKey)) continue;
      const existingGroup = await this.remediationRepo.findGroupByTriple(setId, kpId, q.type, q.difficulty);
      if (existingGroup) {
        seenTriples.add(tripleKey);
        continue; // 追加合并去重（spec §2 决策 5）
      }
      seenTriples.add(tripleKey);

      const groupId = await this.remediationRepo.createGroup(setId, kpId, q.type, q.difficulty, q.id);
      result.groupsCreated++;

      // 放宽阶梯：先同档，再 ±1 档（spec §5.2）
      const picked: number[] = [];
      for (const difficulties of [[q.difficulty], [q.difficulty - 1, q.difficulty + 1]] as number[][]) {
        if (picked.length >= GROUP_SIZE) break;
        const rows = await this.questionsRepo.findRandomByKpTypeDifficulty(
          studentId,
          MATH_SUBJECT_ID,
          kpId,
          q.type,
          difficulties,
          GROUP_SIZE - picked.length,
          [...existingItems, q.id, ...picked],
        );
        picked.push(...rows.map((r) => r.id));
      }

      const inserted = await this.remediationRepo.insertItems(groupId, picked);
      result.itemsCreated += inserted;
      existingItems.push(...picked);

      const shortfall = GROUP_SIZE - inserted;
      if (shortfall > 0) {
        await this.remediationRepo.updateGroupAiPending(groupId, shortfall);
        result.aiPendingCount += shortfall;
        this.fillWithAi(groupId, [...existingItems]);
      }
    }
    return result;
  }

  /** AI 补题入口（fire-and-forget）：调用方绝不 await（LLM 无墙钟上限，spec §5.1）。 */
  fillWithAi(groupId: number, excludeQuestionIds: number[]): void {
    if (this.inFlight.has(groupId)) return;
    const promise = this.runAiFill(groupId, excludeQuestionIds)
      .catch((err) => {
        this.logger.warn(`remediation AI fill failed (group=${groupId}): ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        this.inFlight.delete(groupId);
      });
    this.inFlight.set(groupId, promise);
  }

  /** 惰性重试：active 套题里 ai_pending > 0 且无 in-flight 的组 = 进程重启悬挂（spec §5.1）。 */
  retryPending(setId: number): void {
    void this.remediationRepo
      .findGroupsBySet(setId)
      .then((groups) => {
        for (const g of groups) {
          if (g.ai_pending_count > 0 && !this.inFlight.has(g.id)) {
            this.fillWithAi(g.id, []);
          }
        }
      })
      .catch((err) => this.logger.warn(`retryPending failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  private async runAiFill(groupId: number, excludeQuestionIds: number[]): Promise<void> {
    const group = await this.remediationRepo.findGroupById(groupId);
    if (!group || group.ai_pending_count <= 0) return;

    const origin = await this.questionsRepo.findById(group.origin_question_id);
    const kp = await this.knowledgePointsRepo.findById(group.kp_id);
    if (!origin || !kp) {
      // 原题/考点已下线：维持题库抽到的题，清缺口
      await this.remediationRepo.updateGroupAiPending(groupId, 0);
      return;
    }

    try {
      const res = await this.variation.generate({
        originalQuestion: { content: origin.content, answer: origin.answer, difficulty: origin.difficulty },
        knowledgePoint: { id: String(group.kp_id), name: kp.name },
        count: group.ai_pending_count,
        targetDifficulty: group.difficulty,
      });

      // 当前套题已占用的题（防止生成题与在套题重复）
      const setItems = await this.remediationRepo.findItemsBySet(group.set_id);
      const existing = new Set([...excludeQuestionIds, ...setItems.map((i) => i.question_id)]);

      for (const v of res.variations) {
        if (!this.isValidVariation(v, group.type)) continue; // 轻校验（spec §5.3）
        const { id } = await this.questionsRepo.findOrCreate({
          subject_id: MATH_SUBJECT_ID,
          type: group.type,
          difficulty: group.difficulty,
          content: v.content,
          // 选项只存 label/text，**绝不存 isCorrect**（防答案泄漏；spec 关键铁律）
          options: v.options ? JSON.stringify(v.options.map(({ label, text }) => ({ label, text }))) : null,
          answer: v.answer,
          explanation: v.explanation,
          source: 'remediation',
          content_hash: computeContentHash(v.content),
        });
        if (existing.has(id)) continue;
        await this.remediationRepo.insertItems(group.id, [id]);
        await this.questionsRepo.bindKnowledgePoint(id, group.kp_id, 'primary');
        existing.add(id);
      }
    } finally {
      // 无论成败都清缺口（spec §5.3）：失败则维持题库抽到的题；悬挂重试只管进程重启场景
      await this.remediationRepo.updateGroupAiPending(groupId, 0);
    }
  }

  private isValidVariation(v: VariationQuestion, type: string): boolean {
    if (!v.content.trim() || !v.answer.trim()) return false;
    if (type === 'choice') {
      return Array.isArray(v.options) && v.options.length >= 2;
    }
    return true;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/server && npx vitest run src/modules/training/remediation-generator.service.test.ts
```

Expected: PASS。如失败，按测试输出修服务（保持 spec 不变，修测试或服务代码）。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/training/remediation-generator.service.ts apps/server/src/modules/training/remediation-generator.service.test.ts
git commit -m "feat(training): 补偿套题生成器（三元组成组/题库抽题/AI异步补题）"
```

---

### Task 7: RemediationService（编排：generate / overview / questions / answer / self-assess）

**Files:**
- Create: `apps/server/src/modules/training/remediation.service.ts`
- Create: `apps/server/src/modules/training/remediation.service.test.ts`

- [ ] **Step 1: 写测试（失败）**

`apps/server/src/modules/training/remediation.service.test.ts` 用纯 mock：

```ts
import { describe, it, expect, vi } from 'vitest';
import { RemediationService } from './remediation.service.js';

function harness() {
  const remediationRepo = {
    findActiveByStudent: vi.fn().mockResolvedValue(null),
    createSet: vi.fn().mockResolvedValue(100),
    findItemsBySet: vi.fn().mockResolvedValue([]),
    findItemBySetQuestion: vi.fn().mockResolvedValue({ id: 901, question_id: 11, is_correct: 0, points_awarded: 0 }),
    markItemCorrect: vi.fn().mockResolvedValue(undefined),
    markPointsAwarded: vi.fn().mockResolvedValue(undefined),
    recordAttempt: vi.fn().mockResolvedValue(undefined),
    deleteSet: vi.fn().mockResolvedValue(undefined),
  };
  const questionsRepo = { findByIds: vi.fn().mockResolvedValue([]), findById: vi.fn().mockResolvedValue({ id: 11, type: 'choice' }) };
  const mainErrorRepo = { findUnclearedByStudentQuestionId: vi.fn().mockResolvedValue(null) };
  const examSessionsRepo = { findById: vi.fn().mockResolvedValue(null), findAnswersBySession: vi.fn().mockResolvedValue([]) };
  const trainingSessionsRepo = { findById: vi.fn().mockResolvedValue(null) };
  const generator = { buildGroups: vi.fn().mockResolvedValue({ groupsCreated: 0, itemsCreated: 0, skippedNoKp: 0, aiPendingCount: 0 }) };
  const judgeCore = { judgeQuestion: vi.fn() };
  const pointsService = { award: vi.fn().mockResolvedValue({ pointsAwarded: 3, balance: 100, totalEarned: 200, levelUp: null }) };
  const service = new RemediationService(
    remediationRepo as any, questionsRepo as any, mainErrorRepo as any,
    examSessionsRepo as any, trainingSessionsRepo as any, generator as any,
    judgeCore as any, pointsService as any,
  );
  return { service, remediationRepo, examSessionsRepo, judgeCore, pointsService, mainErrorRepo };
}

describe('generate', () => {
  it('exam 来源：按 exam_answers.is_correct=0 取错题，非本人会话抛 NotFound', async () => {
    const { service, examSessionsRepo } = harness();
    examSessionsRepo.findById.mockResolvedValue({ student_id: 2, status: 'submitted' });
    await expect(service.generate(1, { source: 'exam', sessionId: 7 })).rejects.toThrow('考试会话不存在');
  });
});

describe('submitAnswer', () => {
  it('答对后全对则删除 set 并返回 setCompleted=true，且首答发分', async () => {
    const { service, remediationRepo, judgeCore, pointsService } = harness();
    remediationRepo.findItemsBySet.mockResolvedValue([{ id: 901, is_correct: 1 }]);
    judgeCore.judgeQuestion.mockResolvedValue({ isCorrect: true, method: 'exact' });
    const res = await service.submitAnswer(1, { questionId: 11, studentAnswer: 'B' });
    expect(remediationRepo.markItemCorrect).toHaveBeenCalledWith(901);
    expect(remediationRepo.deleteSet).toHaveBeenCalledWith(100);
    expect(pointsService.award).toHaveBeenCalledWith(expect.objectContaining({ taskCode: 'remediation_question', tierKey: 'choice' }));
    expect(res.setCompleted).toBe(true);
  });

  it('答错不入错题本且仍发分（首答即发、不看对错）', async () => {
    const { service, remediationRepo, judgeCore, pointsService } = harness();
    judgeCore.judgeQuestion.mockResolvedValue({ isCorrect: false, method: 'ai', errorType: 'logic' });
    const res = await service.submitAnswer(1, { questionId: 11, studentAnswer: 'A' });
    expect(remediationRepo.markItemCorrect).not.toHaveBeenCalled();
    expect(pointsService.award).toHaveBeenCalled();
    expect(res.isCorrect).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/server && npx vitest run src/modules/training/remediation.service.test.ts
```

Expected: FAIL（服务文件不存在）。

- [ ] **Step 3: 实现服务**

创建 `apps/server/src/modules/training/remediation.service.ts`：

```ts
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { AwardResult } from '../points/points.service.js';
import { PointsService } from '../points/points.service.js';
import { JudgeCoreService } from '../practice/judge-core.service.js';
import { RemediationRepository } from '../../database/repositories/remediation.repo.js';
import { QuestionsRepository } from '../../database/repositories/questions.repo.js';
import { MainErrorBooksRepository } from '../../database/repositories/main-error-books.repo.js';
import { ExamSessionsRepository } from '../../database/repositories/exam-sessions.repo.js';
import { TrainingSessionsRepository } from '../../database/repositories/training-sessions.repo.js';
import { RemediationGeneratorService } from './remediation-generator.service.js';
import type { QuestionRow } from '../../database/repositories/types.js';
import type { RemediationItemRow, RemediationSetRow } from '../../database/repositories/remediation.repo.js';

const MATH_SUBJECT_ID = 1;

export interface GenerateRemediationInput {
  source: 'exam' | 'targeted';
  sessionId: number;
  wrongQuestionIds?: number[];
}

export interface GenerateRemediationResult {
  setId: number;
  groupsCreated: number;
  itemsCreated: number;
  skippedNoKp: number;
  aiPendingCount: number;
}

export interface RemediationOverviewDto {
  active: boolean;
  setId: number | null;
  groupCount: number;
  itemCount: number;
  correctCount: number;
}

export interface RemediationQuestionDto {
  questionId: number;
  text: string;
  type: string;
  options: Array<{ label: string; text: string }> | null;
}

export interface RemediationQuestionsDto {
  questions: RemediationQuestionDto[];
  itemCount: number;
  correctCount: number;
}

export interface SubmitRemediationAnswerInput {
  questionId: number;
  studentAnswer: string;
}

export interface RemediationAnswerResult {
  isCorrect: boolean | null;
  method: string;
  errorType: string | null;
  needsSelfAssessment: boolean;
  referenceAnswer: string | null;
  explanation: string | null;
  points: AwardResult | null;
  setCompleted: boolean;
  remainingCount: number;
}

@Injectable()
export class RemediationService {
  private readonly logger = new Logger(RemediationService.name);

  constructor(
    private readonly remediationRepo: RemediationRepository,
    private readonly questionsRepo: QuestionsRepository,
    private readonly mainErrorRepo: MainErrorBooksRepository,
    private readonly examSessionsRepo: ExamSessionsRepository,
    private readonly trainingSessionsRepo: TrainingSessionsRepository,
    private readonly generator: RemediationGeneratorService,
    private readonly judgeCore: JudgeCoreService,
    private readonly pointsService: PointsService,
  ) {}

  /** 题型 -> 积分档位（spec §7）：choice/true_false -> choice；fill_blank -> fill_blank；其余 -> major。 */
  private static tierKeyOf(type: string): 'choice' | 'fill_blank' | 'major' {
    if (type === 'choice' || type === 'true_false') return 'choice';
    if (type === 'fill_blank') return 'fill_blank';
    return 'major';
  }

  async generate(studentId: number, input: GenerateRemediationInput): Promise<GenerateRemediationResult> {
    const wrongIds = input.source === 'exam'
      ? await this.examWrongIds(studentId, input.sessionId)
      : await this.targetedWrongIds(studentId, input.sessionId, input.wrongQuestionIds ?? []);

    if (wrongIds.length === 0) {
      return { setId: 0, groupsCreated: 0, itemsCreated: 0, skippedNoKp: 0, aiPendingCount: 0 };
    }

    const wrongs = await this.questionsRepo.findByIds(wrongIds);
    let setId = (await this.remediationRepo.findActiveByStudent(studentId, MATH_SUBJECT_ID))?.id ?? null;
    if (setId === null) {
      setId = await this.remediationRepo.createSet(studentId, MATH_SUBJECT_ID);
    }
    const summary = await this.generator.buildGroups(studentId, setId, wrongs);
    return { setId, ...summary };
  }

  private async examWrongIds(studentId: number, sessionId: number): Promise<number[]> {
    const session = await this.examSessionsRepo.findById(sessionId);
    if (!session || session.student_id !== studentId) throw new NotFoundException('考试会话不存在');
    if (session.status !== 'submitted') throw new BadRequestException('考试尚未交卷');
    const answers = await this.examSessionsRepo.findAnswersBySession(sessionId);
    return answers.filter((a) => a.is_correct === 0).map((a) => a.question_id);
  }

  private async targetedWrongIds(studentId: number, sessionId: number, wrongQuestionIds: number[]): Promise<number[]> {
    const session = await this.trainingSessionsRepo.findById(sessionId);
    if (!session || session.student_id !== studentId || session.task_code !== 'math_targeted') {
      throw new NotFoundException('专项练习会话不存在');
    }
    const ids: number[] = [];
    for (const qid of new Set(wrongQuestionIds)) {
      const entry = await this.mainErrorRepo.findUnclearedByStudentQuestionId(studentId, qid);
      // 只认 source='targeted' 的未清错题：防前端伪造题号刷分（spec §5.1）
      if (entry && entry.source === 'targeted') ids.push(qid);
    }
    return ids;
  }

  async getOverview(studentId: number): Promise<RemediationOverviewDto> {
    const set = await this.remediationRepo.findActiveByStudent(studentId, MATH_SUBJECT_ID);
    if (!set) return { active: false, setId: null, groupCount: 0, itemCount: 0, correctCount: 0 };
    const [groups, items] = await Promise.all([
      this.remediationRepo.findGroupsBySet(set.id),
      this.remediationRepo.findItemsBySet(set.id),
    ]);
    // 惰性重试：AI 补题悬挂（进程重启）在这里补触发（spec §5.1）
    this.generator.retryPending(set.id);
    return {
      active: true,
      setId: set.id,
      groupCount: groups.length,
      itemCount: items.length,
      correctCount: items.filter((i) => i.is_correct === 1).length,
    };
  }

  async listQuestions(studentId: number): Promise<RemediationQuestionsDto> {
    const set = await this.remediationRepo.findActiveByStudent(studentId, MATH_SUBJECT_ID);
    if (!set) return { questions: [], itemCount: 0, correctCount: 0 };

    const items = await this.remediationRepo.findItemsBySet(set.id);
    let pending = items.filter((i) => i.is_correct === 0);

    if (pending.length === 0) {
      // 全对兜底清套（正常情况下由 submit/self-assess 清，但存在并发/外键窗口）
      await this.remediationRepo.deleteSet(set.id);
      return { questions: [], itemCount: items.length, correctCount: items.length };
    }

    const rows = await this.questionsRepo.findByIds(pending.map((i) => i.question_id));
    const byId = new Map(rows.map((r) => [r.id, r]));

    // 题目被下线（is_active=0）则永远答不了——直接标对，防套题死锁
    for (const item of pending) {
      if (!byId.has(item.question_id)) {
        await this.remediationRepo.markItemCorrect(item.id);
      }
    }
    pending = pending.filter((i) => byId.has(i.question_id));
    const correctCount = items.length - pending.length;

    const questions = pending.map((i) => {
      const q = byId.get(i.question_id)!;
      return {
        questionId: q.id,
        text: q.content,
        type: q.type,
        options: q.options ? (JSON.parse(q.options) as Array<{ label: string; text: string }>) : null,
      };
    });

    return { questions, itemCount: items.length, correctCount };
  }

  async submitAnswer(studentId: number, input: SubmitRemediationAnswerInput): Promise<RemediationAnswerResult> {
    const ctx = await this.requireItem(studentId, input.questionId);
    const judged = await this.judgeCore.judgeQuestion({
      studentId,
      subjectId: MATH_SUBJECT_ID,
      questionId: input.questionId,
      studentAnswer: input.studentAnswer,
      source: 'remediation',
    });
    return this.applyOutcome(ctx, judged.isCorrect, judged);
  }

  async selfAssess(studentId: number, input: { questionId: number; assessment: 'correct' | 'incorrect' }): Promise<RemediationAnswerResult> {
    const ctx = await this.requireItem(studentId, input.questionId);
    return this.applyOutcome(ctx, input.assessment === 'correct', { method: 'self_assess' });
  }

  private async requireItem(studentId: number, questionId: number) {
    const set = await this.remediationRepo.findActiveByStudent(studentId, MATH_SUBJECT_ID);
    if (!set) throw new BadRequestException('当前没有进行中的相似题专项练习');
    const item = await this.remediationRepo.findItemBySetQuestion(set.id, questionId);
    if (!item) throw new BadRequestException('该题不在当前套题中');
    if (item.is_correct === 1) throw new BadRequestException('该题已答对，无需重复作答');
    return { set, item };
  }

  private async applyOutcome(
    ctx: { set: RemediationSetRow; item: RemediationItemRow },
    isCorrect: boolean | null,
    judged: { method: string; errorType?: string | null; needsSelfAssessment?: boolean; referenceAnswer?: string | null; explanation?: string | null },
  ): Promise<RemediationAnswerResult> {
    const { set, item } = ctx;
    await this.remediationRepo.recordAttempt(item.id);
    if (isCorrect === true) await this.remediationRepo.markItemCorrect(item.id);

    // 首答即发分（不看对错，每题一次；spec §7）——积分失败绝不影响判题结果
    let points: AwardResult | null = null;
    if (item.points_awarded === 0) {
      await this.remediationRepo.markPointsAwarded(item.id);
      const q = await this.questionsRepo.findById(item.question_id);
      if (q) {
        try {
          points = await this.pointsService.award({
            studentId: set.student_id,
            taskCode: 'remediation_question',
            tierKey: RemediationService.tierKeyOf(q.type),
            dedupeKey: `rem:${item.id}`, // 不带日期：每题全程只发一次（spec §7）
            refType: 'question',
            refId: item.question_id,
          });
        } catch (err) {
          this.logger.warn(`remediation award failed (item=${item.id}): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    let setCompleted = false;
    if (isCorrect === true) {
      const items = await this.remediationRepo.findItemsBySet(set.id);
      if (items.every((i) => i.is_correct === 1)) {
        await this.remediationRepo.deleteSet(set.id);
        setCompleted = true;
      }
    }

    const remainingCount = setCompleted
      ? 0
      : (await this.remediationRepo.findItemsBySet(set.id)).filter((i) => i.is_correct === 0).length;

    return {
      isCorrect,
      method: judged.method,
      errorType: judged.errorType ?? null,
      needsSelfAssessment: judged.needsSelfAssessment ?? false,
      referenceAnswer: judged.referenceAnswer ?? null,
      explanation: judged.explanation ?? null,
      points,
      setCompleted,
      remainingCount,
    };
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/server && npx vitest run src/modules/training/remediation.service.test.ts
```

Expected: PASS。如有冲突按「测试错」原则修正测试或服务代码，不改 spec。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/training/remediation.service.ts apps/server/src/modules/training/remediation.service.test.ts
git commit -m "feat(training): 补偿套题编排服务（generate/overview/answer/self-assess）"
```

---

### Task 8: Controller + DTO + TrainingModule 注册

**Files:**
- Create: `apps/server/src/modules/training/dto/remediation.dto.ts`
- Create: `apps/server/src/modules/training/remediation.controller.ts`
- Create: `apps/server/src/modules/training/remediation.controller.test.ts`
- Modify: `apps/server/src/modules/training/training.module.ts`

- [ ] **Step 1: 写 DTO（纯 TS 接口，仓库习惯）**

创建 `apps/server/src/modules/training/dto/remediation.dto.ts`：

```ts
/** POST /api/training/remediation/generate 入参。 */
export interface GenerateRemediationDto {
  /** 错题来源：exam = 真题考试交卷后；targeted = 数学专项完成后。 */
  source: 'exam' | 'targeted';
  /** 考试会话 id / 专项训练会话 id（两者同名不同表，按 source 分流）。 */
  sessionId: number;
  /** targeted 专用：本场判错的题号（服务端逐题验证错题本记录，防伪造）。 */
  wrongQuestionIds?: number[];
}

export interface SubmitRemediationAnswerDto {
  questionId: number;
  studentAnswer: string;
}

export interface RemediationSelfAssessDto {
  questionId: number;
  assessment: 'correct' | 'incorrect';
}
```

- [ ] **Step 2: 写 Controller**

创建 `apps/server/src/modules/training/remediation.controller.ts`：

```ts
import { BadRequestException, Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { RemediationService } from './remediation.service.js';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import type { GenerateRemediationDto, RemediationSelfAssessDto, SubmitRemediationAnswerDto } from './dto/remediation.dto.js';

/** 错题补偿套题（相似题专项练习，2026-09-21）。
 *  设计：docs/superpowers/specs/2026-09-21-remediation-set-design.md */
@Controller('api/training/remediation')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class RemediationController {
  constructor(private readonly remediationService: RemediationService) {}

  /** 学生同意后生成套题：同步建组 + 题库抽题，AI 补题后台跑（201）。 */
  @Post('generate')
  async generate(@Body() dto: GenerateRemediationDto, @CurrentUser() user: JwtUser) {
    if (dto.source !== 'exam' && dto.source !== 'targeted') {
      throw new BadRequestException('source 仅允许 exam | targeted');
    }
    if (!Number.isInteger(dto.sessionId) || dto.sessionId < 1) {
      throw new BadRequestException('sessionId 非法');
    }
    if (dto.source === 'targeted') {
      if (!Array.isArray(dto.wrongQuestionIds) || dto.wrongQuestionIds.length === 0) {
        throw new BadRequestException('targeted 来源必须携带 wrongQuestionIds');
      }
      if (dto.wrongQuestionIds.length > 50) throw new BadRequestException('wrongQuestionIds 最多 50 题');
      if (!dto.wrongQuestionIds.every((id) => Number.isInteger(id) && id >= 1)) {
        throw new BadRequestException('wrongQuestionIds 含非法题号');
      }
    }
    return this.remediationService.generate(user.sub, dto);
  }

  @Get('me')
  async me(@CurrentUser() user: JwtUser) {
    return this.remediationService.getOverview(user.sub);
  }

  @Get('questions')
  async questions(@CurrentUser() user: JwtUser) {
    return this.remediationService.listQuestions(user.sub);
  }

  @Post('answers')
  async answer(@Body() dto: SubmitRemediationAnswerDto, @CurrentUser() user: JwtUser) {
    if (!Number.isInteger(dto.questionId) || dto.questionId < 1) {
      throw new BadRequestException('questionId 非法');
    }
    if (typeof dto.studentAnswer !== 'string') throw new BadRequestException('studentAnswer 非法');
    return this.remediationService.submitAnswer(user.sub, dto);
  }

  @Post('self-assess')
  async selfAssess(@Body() dto: RemediationSelfAssessDto, @CurrentUser() user: JwtUser) {
    if (!Number.isInteger(dto.questionId) || dto.questionId < 1) {
      throw new BadRequestException('questionId 非法');
    }
    if (dto.assessment !== 'correct' && dto.assessment !== 'incorrect') {
      throw new BadRequestException('assessment 仅允许 correct | incorrect');
    }
    return this.remediationService.selfAssess(user.sub, dto);
  }
}
```

- [ ] **Step 3: 注册模块**

`apps/server/src/modules/training/training.module.ts`：

```ts
import { RemediationController } from './remediation.controller.js';
import { RemediationService } from './remediation.service.js';
import { RemediationGeneratorService } from './remediation-generator.service.js';
import { RemediationRepository } from '../../database/repositories/remediation.repo.js';
import { ExamSessionsRepository } from '../../database/repositories/exam-sessions.repo.js';
import { VariationCapability } from '../../ai-core/capabilities/variation.capability.js';
```

修改 `controllers` 与 `providers`：

```ts
  controllers: [TrainingController, VocabularyController, MeaningController, RemediationController],
  providers: [TrainingService, VocabularyService, MeaningService,
    MainErrorBooksRepository, QuestionsRepository, QuestionHintsRepository,
    KnowledgePointsRepository, StudentHiddenQuestionsRepository, AdminNotificationsRepository,
    HintCapability, ChinesePassagesRepository, DictationFeedbackCapability,
    InterpretationJudgeCapability, EnglishWordsRepository, StudentWordProgressRepository,
    EnglishWordJudgeCapability, ChineseMeaningJudgeCapability, TrainingSessionsRepository,
    SpecialPracticeLogsRepository,
    RemediationService, RemediationGeneratorService, RemediationRepository,
    ExamSessionsRepository, VariationCapability],
```

说明：`VariationCapability` 无 `@Injectable()` 但构造参数可选，直接列 provider 由 Nest new 出零参实例（与 `HintCapability`/`QuestionStructuringCapability` 同一模式）；`JudgeCoreService`/`PointsService` 继续由 `imports: [PracticeModule, PointsModule]` 提供，不得重复 provide。

- [ ] **Step 4: 写 controller 测试**

`apps/server/src/modules/training/remediation.controller.test.ts`，mock 服务测边界校验：

```ts
import { describe, it, expect, vi } from 'vitest';
import { RemediationController } from './remediation.controller.js';

describe('RemediationController.generate', () => {
  it('source 不在白名单时 400', async () => {
    const ctrl = new RemediationController({ generate: vi.fn() } as any);
    await expect(ctrl.generate({ source: 'exam' as any, sessionId: 0 }, { sub: 1 } as any)).rejects.toThrow('sessionId 非法');
    await expect(ctrl.generate({ source: 'wrong' as any, sessionId: 1 }, { sub: 1 } as any)).rejects.toThrow('source 仅允许');
  });

  it('targeted 缺 wrongQuestionIds 或超限时 400', async () => {
    const ctrl = new RemediationController({ generate: vi.fn() } as any);
    await expect(ctrl.generate({ source: 'targeted', sessionId: 1 }, { sub: 1 } as any)).rejects.toThrow('wrongQuestionIds');
    await expect(ctrl.generate({ source: 'targeted', sessionId: 1, wrongQuestionIds: [0] }, { sub: 1 } as any)).rejects.toThrow('非法题号');
  });
});
```

- [ ] **Step 5: 跑测试 + 类型检查**

```bash
cd apps/server && npx vitest run src/modules/training/remediation.controller.test.ts
cd apps/server && npx tsc --noEmit
```

Expected: PASS（controller 测试） + tsc 无新增报错。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/training/dto apps/server/src/modules/training/remediation.controller.ts apps/server/src/modules/training/remediation.controller.test.ts apps/server/src/modules/training/training.module.ts
git commit -m "feat(training): 补偿套题 REST 端点与模块注册"
```

---

### Task 9: 前端 api.ts 函数

**Files:**
- Modify: `apps/web/src/services/api.ts`（在 `// --- Training: targeted practice ---` 与 `// --- Training · 语文古诗文默写 ---` 之间插入新区块）

- [ ] **Step 1: 加类型与函数**

在 `apps/web/src/services/api.ts` 找到 `// --- Training: targeted practice ---` 区块（约 970 行）末尾、`// --- Training · 语文古诗文默写 ---` 之前插入：

```ts
// --- Training: remediation set（错题补偿套题 / 相似题专项，2026-09-21） ---

export interface RemediationGenerateResult {
  setId: number;
  groupsCreated: number;
  itemsCreated: number;
  skippedNoKp: number;
  aiPendingCount: number;
}

export function generateRemediationSet(payload: {
  source: 'exam' | 'targeted';
  sessionId: number;
  wrongQuestionIds?: number[];
}): Promise<RemediationGenerateResult> {
  return fetchApi<RemediationGenerateResult>('/training/remediation/generate', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export interface RemediationOverview {
  active: boolean;
  setId: number | null;
  groupCount: number;
  itemCount: number;
  correctCount: number;
}

export function getRemediationOverview(): Promise<RemediationOverview> {
  return fetchApi<RemediationOverview>('/training/remediation/me');
}

export interface RemediationQuestion {
  questionId: number;
  text: string;
  type: string;
  options: Array<{ label: string; text: string }> | null;
}

export interface RemediationQuestionsResult {
  questions: RemediationQuestion[];
  itemCount: number;
  correctCount: number;
}

export function getRemediationQuestions(): Promise<RemediationQuestionsResult> {
  return fetchApi<RemediationQuestionsResult>('/training/remediation/questions');
}

export interface RemediationAnswerResult {
  isCorrect: boolean | null;
  method: string;
  errorType: string | null;
  needsSelfAssessment: boolean;
  referenceAnswer: string | null;
  explanation: string | null;
  points: {
    pointsAwarded: number;
    balance: number;
    totalEarned: number;
    levelUp: { from: { code: string; name: string }; to: { code: string; name: string } } | null;
    reason?: string;
  } | null;
  setCompleted: boolean;
  remainingCount: number;
}

export function submitRemediationAnswer(payload: {
  questionId: number;
  studentAnswer: string;
}): Promise<RemediationAnswerResult> {
  return fetchApi<RemediationAnswerResult>('/training/remediation/answers', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function selfAssessRemediation(payload: {
  questionId: number;
  assessment: 'correct' | 'incorrect';
}): Promise<RemediationAnswerResult> {
  return fetchApi<RemediationAnswerResult>('/training/remediation/self-assess', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
```

- [ ] **Step 2: 类型检查**

```bash
cd apps/web && npx tsc --noEmit
```

Expected: 无新增报错。

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/services/api.ts
git commit -m "feat(api): 补偿套题前端接口函数"
```

---

### Task 10: RemediationOfferCard 询问卡组件

**Files:**
- Create: `apps/web/src/components/business/RemediationOfferCard.tsx`
- Create: `apps/web/src/components/business/RemediationOfferCard.test.tsx`

- [ ] **Step 1: 写测试（失败）**

`apps/web/src/components/business/RemediationOfferCard.test.tsx`：

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RemediationOfferCard } from './RemediationOfferCard';

const generateRemediationSet = vi.hoisted(() => vi.fn());
vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, generateRemediationSet };
});

vi.mock('@/components/base/Toast', () => ({ toast: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  generateRemediationSet.mockReset();
});

describe('RemediationOfferCard', () => {
  it('错题数 > 0 时渲染询问卡', () => {
    render(<RemediationOfferCard source="exam" sessionId={7} wrongCount={3} />);
    expect(screen.getByText(/本场错了 3 道题/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /生成练习/ })).toBeInTheDocument();
  });

  it('点击“跳过”隐藏卡片', () => {
    render(<RemediationOfferCard source="exam" sessionId={7} wrongCount={3} />);
    fireEvent.click(screen.getByRole('button', { name: /跳过/ }));
    expect(screen.queryByText(/本场错了/)).not.toBeInTheDocument();
  });

  it('targeted 来源携带 wrongQuestionIds 调用生成', async () => {
    generateRemediationSet.mockResolvedValue({ setId: 5, groupsCreated: 2, itemsCreated: 6, skippedNoKp: 0, aiPendingCount: 0 });
    render(<RemediationOfferCard source="targeted" sessionId={8} wrongCount={2} wrongQuestionIds={[11, 12]} />);
    fireEvent.click(screen.getByRole('button', { name: /生成练习/ }));
    await screen.findByText(/已生成/);
    expect(generateRemediationSet).toHaveBeenCalledWith({ source: 'targeted', sessionId: 8, wrongQuestionIds: [11, 12] });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/web && npx vitest run src/components/business/RemediationOfferCard.test.tsx
```

Expected: FAIL（组件不存在）。

- [ ] **Step 3: 实现组件**

创建 `apps/web/src/components/business/RemediationOfferCard.tsx`：

```tsx
import { useState } from 'react';
import { Banner } from '@/components/base';
import { toast } from '@/components/base/Toast';
import { generateRemediationSet } from '@/services/api';

interface Props {
  source: 'exam' | 'targeted';
  sessionId: number | null;
  wrongCount: number;
  wrongQuestionIds?: number[];
  onGenerated?: () => void;
}

export function RemediationOfferCard({ source, sessionId, wrongCount, wrongQuestionIds, onGenerated }: Props) {
  const [state, setState] = useState<'offer' | 'generating' | 'done'>('offer');

  if (wrongCount === 0 || sessionId == null || state === 'done') return null;

  const handleGenerate = async () => {
    if (state === 'generating') return;
    setState('generating');
    try {
      const payload: Parameters<typeof generateRemediationSet>[0] = {
        source,
        sessionId,
        ...(source === 'targeted' && wrongQuestionIds ? { wrongQuestionIds } : {}),
      };
      const res = await generateRemediationSet(payload);
      if (res.groupsCreated > 0) {
        toast('success', `已生成 ${res.groupsCreated} 组 ${res.itemsCreated} 题相似题练习，可在训练首页开始练习`);
      } else {
        toast('success', '暂无可生成的相似题（错题缺少考点标注）');
      }
      setState('done');
      onGenerated?.();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '生成失败，请重试');
      setState('offer');
    }
  };

  return (
    <Banner
      type="info"
      title={`本场错了 ${wrongCount} 道题，生成相似题专项练习？`}
      description="按考点每组配 3 题，逐题作答，答对清零、全对清套"
      action={
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            disabled={state === 'generating'}
            onClick={() => setState('done')}
            className="rounded-lg border border-blue-300 bg-white px-3 py-1.5 text-[13px] font-medium text-blue-900 hover:bg-blue-50 disabled:opacity-60"
          >
            跳过
          </button>
          <button
            type="button"
            disabled={state === 'generating'}
            onClick={handleGenerate}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {state === 'generating' ? '生成中…' : '生成练习'}
          </button>
        </div>
      }
    />
  );
}
```

（若 `@/components/base` 不导出 `Banner`，改为 `import { Banner } from '@/components/base/Banner'`；PageHeader 从 `@/components/base` 导入，说明该 barrel 存在。）

> ⚠️ **按钮配色（勿照抄上面的 `bg-blue-600`）**：按钮一律用 `base/Button` 的 `primary` / `secondary` 变体（brand 橘红 token），计划片段里的 `bg-blue-600` / `border-blue-300 text-blue-900` 是笔误，**勿照抄**（`style.md` §2 主 CTA = Brand-500 `#ff6b35`；Tailwind 原生蓝是家长端主题色，学生端不得使用）。本卡实际实现：`<Button variant="primary" size="sm">生成练习</Button>` + `<Button variant="secondary" size="sm">跳过</Button>`。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/web && npx vitest run src/components/business/RemediationOfferCard.test.tsx
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/business/RemediationOfferCard.tsx apps/web/src/components/business/RemediationOfferCard.test.tsx
git commit -m "feat(web): 补偿套题询问卡组件"
```

---

### Task 11: TrainingHomePage 顶部提示条

**Files:**
- Modify: `apps/web/src/pages/student/training/TrainingHomePage.tsx`
- Create: `apps/web/src/pages/student/training/TrainingHomePage.test.tsx`

- [ ] **Step 1: 改页面**

在 `TrainingHomePage.tsx`：
1. 引入 `Banner`、`getRemediationOverview`：

```ts
import { Banner, PageHeader } from '@/components/base';
import { getTrainingErrorBook, getRemediationOverview } from '@/services/api';
```

2. 在组件内加状态与 effect（紧挨 `unclearedCount` state 之后）：

```ts
  const [remediation, setRemediation] = useState<RemediationOverview | null>(null);
  const [remediationDismissed, setRemediationDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getRemediationOverview()
      .then((overview) => { if (!cancelled) setRemediation(overview); })
      .catch(() => { /* 失败静默，不阻塞三卡页 */ });
    return () => { cancelled = true; };
  }, []);
```

3. 在 `<PageHeader ... />` 与 grid 之间插入提示条：

```tsx
        {remediation?.active && !remediationDismissed && (
          <div className="mt-6">
            <Banner
              type="info"
              title={`相似题专项练习待完成：${remediation.itemCount - remediation.correctCount} 题 / ${remediation.groupCount} 组`}
              description="考试与专项的错题已按考点配好相似题，逐题作答，答对清零"
              onClose={() => setRemediationDismissed(true)}
              action={
                <button
                  type="button"
                  onClick={() => navigate('/student/training/remediation/run')}
                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-blue-700"
                >
                  开始练习
                </button>
              }
            />
          </div>
        )}
```

> ⚠️ **按钮配色（勿照抄上面的 `bg-blue-600`）**：按钮一律用 `base/Button` 的 `primary` / `secondary` 变体（brand 橘红 token），计划片段里的 `bg-blue-600` 是笔误，**勿照抄**（`style.md` §2 主 CTA = Brand-500 `#ff6b35`）。此处「开始练习」应为 `<Button variant="primary" size="sm" onClick={…}>开始练习</Button>`。

- [ ] **Step 2: 写测试**

创建 `apps/web/src/pages/student/training/TrainingHomePage.test.tsx`：

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import TrainingHomePage from './TrainingHomePage';

const getRemediationOverview = vi.hoisted(() => vi.fn());
const getTrainingErrorBook = vi.hoisted(() => vi.fn());
vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, getRemediationOverview, getTrainingErrorBook };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  getTrainingErrorBook.mockResolvedValue([]);
});

function renderPage() {
  const router = createMemoryRouter([{ path: '/student/training/home', element: <TrainingHomePage /> }]);
  return { router, ...render(<RouterProvider router={router} />) };
}

describe('TrainingHomePage remediation banner', () => {
  it('有待完成套题时显示提示条', async () => {
    getRemediationOverview.mockResolvedValue({ active: true, setId: 5, groupCount: 2, itemCount: 6, correctCount: 1 });
    renderPage();
    expect(await screen.findByText(/相似题专项练习待完成：5 题/)).toBeInTheDocument();
  });

  it('点击“开始练习”跳转到 /student/training/remediation/run', async () => {
    getRemediationOverview.mockResolvedValue({ active: true, setId: 5, groupCount: 2, itemCount: 6, correctCount: 1 });
    const { router } = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /开始练习/ }));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/student/training/remediation/run'));
  });
});
```

- [ ] **Step 3: 跑测试 + 类型检查**

```bash
cd apps/web && npx vitest run src/pages/student/training/TrainingHomePage.test.tsx
cd apps/web && npx tsc --noEmit
```

Expected: PASS + tsc 无新增报错。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/student/training/TrainingHomePage.tsx apps/web/src/pages/student/training/TrainingHomePage.test.tsx
git commit -m "feat(web): 三卡页顶部提示条——待完成相似题专项练习"
```

---

### Task 12: RemediationRunPage 套题作答页 + 路由

**Files:**
- Create: `apps/web/src/pages/student/training/RemediationRunPage.tsx`
- Create: `apps/web/src/pages/student/training/RemediationRunPage.test.tsx`
- Modify: `apps/web/src/routes/routeTable.tsx`
- Modify: `apps/web/src/routes/routeTable.test.tsx`

- [ ] **Step 1: 新页面**

创建 `apps/web/src/pages/student/training/RemediationRunPage.tsx`：

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { QuestionRunner } from '@/components/business/answer/QuestionRunner';
import type { RunnerQuestion } from '@/components/business/answer/types';
import { DraftPanel, DraftIconButton } from '@/components/business/DraftPanel';
import { RunExitGuard } from '@/components/business/answer/RunExitGuard';
import { PageHeader } from '@/components/base';
import { toast } from '@/components/base/Toast';
import { usePointsStore } from '@/store/pointsStore';
import {
  getRemediationQuestions,
  getTrainingHint,
  selfAssessRemediation,
  submitRemediationAnswer,
} from '@/services/api';
import type { RemediationAnswerResult, RemediationQuestionsResult } from '@/services/api';

const MATH_SUBJECT_ID = 1;

export default function RemediationRunPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<RemediationQuestionsResult | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [round, setRound] = useState(0);
  const [hints, setHints] = useState<Record<string, string>>({});
  const [currentQ, setCurrentQ] = useState<RunnerQuestion | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);
  const [discussQ, setDiscussQ] = useState<RunnerQuestion | null>(null);
  const [exitConfirm, setExitConfirm] = useState(false);
  const guardRef = useRef(true);
  const bootstrappedRef = useRef(false);
  const pushPoints = usePointsStore((s) => s.push);
  const bumpRevision = usePointsStore((s) => s.bumpRevision);

  const load = useCallback(async () => {
    try {
      const res = await getRemediationQuestions();
      if (res.questions.length === 0) {
        if (res.itemCount > 0 && res.correctCount === res.itemCount) {
          toast('success', '套题全部答对，已清零');
        }
        navigate('/student/training/home', { replace: true });
        return;
      }
      setData(res);
      setLoaded(true);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '加载失败');
      navigate('/student/training/home', { replace: true });
    }
  }, [navigate]);

  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    load();
  }, [load]);

  const questions: RunnerQuestion[] = data
    ? data.questions.map((q) => ({ n: String(q.questionId), text: q.text, type: q.type, options: q.options ?? undefined }))
    : [];

  const handlePoints = useCallback(
    (res: RemediationAnswerResult) => {
      if (res.points && res.points.pointsAwarded > 0) {
        const levelUp = res.points.levelUp
          ? { from: res.points.levelUp.from.name, to: res.points.levelUp.to.name }
          : null;
        pushPoints({ points: res.points.pointsAwarded, title: '相似题专项', levelUp });
        bumpRevision();
      }
    },
    [pushPoints, bumpRevision],
  );

  const handleCompleted = useCallback(() => {
    toast('success', '套题全部答对，已清零');
    guardRef.current = false;
    navigate('/student/training/home', { replace: true });
  }, [navigate]);

  const handleSubmit = useCallback(
    async (q: RunnerQuestion, answer: string) => {
      const res = await submitRemediationAnswer({ questionId: Number(q.n), studentAnswer: answer });
      handlePoints(res);
      if (res.setCompleted) handleCompleted();
      return res;
    },
    [handlePoints, handleCompleted],
  );

  const handleRequestHint = useCallback(
    async (q: RunnerQuestion) => {
      const res = await getTrainingHint(Number(q.n));
      setHints((prev) => ({ ...prev, [q.n]: res.hint }));
      return res.hint;
    },
    [],
  );

  const handleSelfAssess = useCallback(
    async (q: RunnerQuestion, assessment: 'correct' | 'incorrect') => {
      const res = await selfAssessRemediation({ questionId: Number(q.n), assessment });
      handlePoints(res);
      if (res.setCompleted) handleCompleted();
    },
    [handlePoints, handleCompleted],
  );

  const handleFinish = useCallback(async () => {
    const res = await getRemediationQuestions();
    if (res.questions.length === 0) {
      handleCompleted();
    } else {
      setData(res);
      setRound((r) => r + 1);
    }
  }, [handleCompleted]);

  if (!loaded || !data) return null;

  return (
    <div className="student-theme-container" data-theme="student-day" data-school="junior">
      <div className="relative h-screen flex flex-col p-4 sm:p-6 bg-[var(--bg-page)] text-[var(--text-primary)]">
        <div className="flex items-center justify-between gap-4">
          <PageHeader
            to="/student/training/home"
            caption="返回训练"
            title={`相似题专项 · 已答对 ${data.correctCount}/${data.itemCount}`}
          />
        </div>

        <div className="flex-1 min-h-0 flex">
          <div className="flex-1 min-w-0 min-h-0 flex flex-col">
            <QuestionRunner
              key={round}
              questions={questions}
              subjectId={MATH_SUBJECT_ID}
              draftKeyPrefix="rem"
              variant="embedded"
              draftDisabled
              enableHint
              hints={hints}
              onRequestHint={handleRequestHint}
              headerActions={(q) => (
                <button
                  type="button"
                  onClick={() => setDiscussQ(q)}
                  className="w-[38px] h-[38px] rounded-xl border border-[var(--bg-subtle)] bg-[var(--learn-card-bg)] flex items-center justify-center text-[var(--text-secondary)] shadow-sm hover:bg-[var(--bg-base)] transition-colors"
                  aria-label="讲一讲"
                  title="讲一讲"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                </button>
              )}
              onSubmit={handleSubmit}
              onSelfAssess={handleSelfAssess}
              onFinish={handleFinish}
              onQuestionChange={setCurrentQ}
              onClose={() => setExitConfirm(true)}
            />
          </div>
          {draftOpen && currentQ && (
            <DraftPanel questionId={currentQ.n} draftKeyPrefix="rem" onClose={() => setDraftOpen(false)} />
          )}
        </div>

        {!draftOpen && (
          <div className="absolute top-4 right-4">
            <DraftIconButton onClick={() => setDraftOpen(true)} />
          </div>
        )}

        {discussQ && (
          <DiscussDrawer
            mode="training"
            questionText={discussQ.text}
            questionId={Number(discussQ.n)}
            onClose={() => setDiscussQ(null)}
          />
        )}

        <RunExitGuard
          guardRef={guardRef}
          title="离开练习"
          message="相似题练习进度已保存，离开后可在训练首页继续。"
          confirmLabel="确认离开"
        />
        {exitConfirm && (
          <Modal
            open={exitConfirm}
            title="离开练习"
            onClose={() => setExitConfirm(false)}
            actions={
              <>
                <button onClick={() => setExitConfirm(false)} className="...">继续练习</button>
                <button
                  onClick={() => { guardRef.current = false; navigate('/student/training/home'); }}
                  className="..."
                >离开</button>
              </>
            }
          >
            离开后可在训练首页继续相似题练习。
          </Modal>
        )}
      </div>
    </div>
  );
}
```

说明：
- 若 `DiscussDrawer` 未在文件顶部 import，加上 `import { DiscussDrawer } from '@/components/business/DiscussDrawer';`。
- 若 `Modal` 未使用/未 import，可把 `onClose={() => setExitConfirm(true)}` 直接换成 `guardRef.current = false; navigate(...)` 并删除 Modal 分支；`RunExitGuard` 已经自带 confirm UI。优先用 `RunExitGuard` 自带的 confirm 弹窗，不要自己再写一个 Modal。上面的 Modal 是兜底写法，**建议删除 Modal 分支**，只保留 `RunExitGuard`（它本身会接管 `beforeunload` 与 X 退出）。让 Task 执行者参考 `TargetedRunPage.tsx` 底部 309 行之后的 exit guard 用法，保持一致。

- [ ] **Step 2: 注册路由**

`apps/web/src/routes/routeTable.tsx`，在 `/student/training/exam/result/:sessionId` 路由之后（或训练轨路由区任意合适位置）插入：

```tsx
// 错题补偿套题（相似题专项练习，2026-09-21）
{
  path: '/student/training/remediation/run',
  element: (
    <RequireRole role="student">
      <RemediationRunPage />
    </RequireRole>
  ),
},
```

顶部 import 加：

```tsx
import RemediationRunPage from '../pages/student/training/RemediationRunPage';
```

- [ ] **Step 3: routeTable.test.tsx 钉路由映射**

在 `apps/web/src/routes/routeTable.test.tsx` 中，仿照现有训练轨路径断言新增一条：

```ts
  it('pins /student/training/remediation/run', () => {
    const matched = matchRoute('/student/training/remediation/run');
    expect(matched?.element?.type).toBe(RemediationRunPage);
  });
```

（具体断言 API 以现文件为准；若用对象引用比较，直接插入即可。）

- [ ] **Step 4: 写 RemediationRunPage 渲染测试**

`apps/web/src/pages/student/training/RemediationRunPage.test.tsx`：

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import RemediationRunPage from './RemediationRunPage';

const getRemediationQuestions = vi.hoisted(() => vi.fn());
vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, getRemediationQuestions };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  getRemediationQuestions.mockReset();
});

function renderPage() {
  const router = createMemoryRouter([{ path: '/student/training/remediation/run', element: <RemediationRunPage /> }]);
  return { router, ...render(<RouterProvider router={router} />) };
}

describe('RemediationRunPage', () => {
  it('加载并渲染套题题目', async () => {
    getRemediationQuestions.mockResolvedValue({
      questions: [{ questionId: 11, text: '1+1=?', type: 'choice', options: [{ label: 'A', text: '1' }, { label: 'B', text: '2' }] }],
      itemCount: 1,
      correctCount: 0,
    });
    renderPage();
    expect(await screen.findByText('1+1=?')).toBeInTheDocument();
  });

  it('空套题跳回训练首页', async () => {
    getRemediationQuestions.mockResolvedValue({ questions: [], itemCount: 0, correctCount: 0 });
    const { router } = renderPage();
    await waitFor(() => expect(router.state.location.pathname).toBe('/student/training/home'));
  });
});
```

- [ ] **Step 5: 跑测试 + 类型检查**

```bash
cd apps/web && npx vitest run src/pages/student/training/RemediationRunPage.test.tsx src/routes/routeTable.test.tsx
cd apps/web && npx tsc --noEmit
```

Expected: PASS + tsc 无新增报错。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/student/training/RemediationRunPage.tsx apps/web/src/pages/student/training/RemediationRunPage.test.tsx apps/web/src/routes/routeTable.tsx apps/web/src/routes/routeTable.test.tsx
git commit -m "feat(web): 补偿套题作答页 + 路由"
```

---

### Task 13: 在考试结果页与专项完成页挂载询问卡

**Files:**
- Modify: `apps/web/src/pages/student/training/ExamResultPage.tsx`（结果页 headerExtra 区）
- Modify: `apps/web/src/pages/student/training/ExamResultPage.test.tsx`
- Modify: `apps/web/src/pages/student/training/TargetedRunPage.tsx`（result 阶段）
- Modify: `apps/web/src/pages/student/training/TargetedRunPage.test.tsx`

- [ ] **Step 1: ExamResultPage 挂询问卡**

`apps/web/src/pages/student/training/ExamResultPage.tsx`：

1. 引入组件：

```tsx
import { RemediationOfferCard } from '@/components/business/RemediationOfferCard';
```

2. 在拿到 `items` 之后算错题数（在渲染 headerExtra 之前）：

```tsx
  const wrongCount = items?.filter((i) => i.isCorrect === 0).length ?? 0;
```

3. 把 `AnswerResultList` 的 `headerExtra` 改成复合节点（保留原有得分卡/未自评横幅，末尾追加询问卡）：

```tsx
            headerExtra={
              <div className="space-y-3">
                {/* 原有 headerExtra 内容 */}
                {needsRetry || unrecoverable ? (
                  <div className="px-5 py-3">
                    <SessionPointsRetryNotice ... />
                  </div>
                ) : undefined}
                <RemediationOfferCard source="exam" sessionId={sid} wrongCount={wrongCount} />
              </div>
            }
```

（保留原有的未自评横幅/得分卡位置不变；实际以现文件结构为准，把 RemediationOfferCard 加到 headerExtra 里即可。）

- [ ] **Step 2: ExamResultPage 测试补断言**

`apps/web/src/pages/student/training/ExamResultPage.test.tsx`：

在已有「有错题时渲染结果页」的用例里，mock 中加入 `getRemediationOverview` 并断言询问卡出现：

```tsx
import { generateRemediationSet, getRemediationOverview } from '@/services/api';
vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, getExamSession, getExamResults, generateRemediationSet, getRemediationOverview };
});
// ...
it('有错题时显示补偿套题询问卡', async () => {
  getRemediationOverview.mockResolvedValue({ active: false, setId: null, groupCount: 0, itemCount: 0, correctCount: 0 });
  sessionMock.mockResolvedValue({ status: 'submitted' } as any);
  resultsMock.mockResolvedValue({
    items: [{ questionId: 1, isCorrect: 0, text: 'x', type: 'choice', options: null }],
  } as any);
  renderResult();
  expect(await screen.findByText(/生成相似题专项练习/)).toBeInTheDocument();
});
```

- [ ] **Step 3: TargetedRunPage 挂询问卡**

`apps/web/src/pages/student/training/TargetedRunPage.tsx`：

1. 引入：

```tsx
import { RemediationOfferCard } from '@/components/business/RemediationOfferCard';
```

2. 在 result 阶段之前计算错题题号：

```tsx
  const remediationWrongIds = useMemo(() => {
    if (!finalResults || sessionId == null) return [];
    return questions
      .filter((q) => {
        const r = finalResults[q.n];
        return r && r.isCorrect !== true;
      })
      .map((q) => Number(q.n));
  }, [finalResults, questions, sessionId]);
```

3. `phase === 'result'` 分支的 `headerExtra` 复合：

```tsx
            headerExtra={
              <div className="space-y-3">
                {needsRetry || unrecoverable ? (
                  <div className="px-5 py-3">
                    <SessionPointsRetryNotice ... />
                  </div>
                ) : undefined}
                <RemediationOfferCard
                  source="targeted"
                  sessionId={sessionId}
                  wrongCount={remediationWrongIds.length}
                  wrongQuestionIds={remediationWrongIds}
                />
              </div>
            }
```

- [ ] **Step 4: TargetedRunPage 测试补断言**

`apps/web/src/pages/student/training/TargetedRunPage.test.tsx`：

mock `generateRemediationSet`/`getRemediationOverview` 并断言：完成结果页渲染错题时，询问卡出现。测试结构与现文件一致，不再展开；关键是触发 `handleFinish` 后进入 result phase，然后查文本 `/生成相似题专项练习/`。

- [ ] **Step 5: 跑测试 + 类型检查**

```bash
cd apps/web && npx vitest run src/pages/student/training/ExamResultPage.test.tsx src/pages/student/training/TargetedRunPage.test.tsx
cd apps/web && npx tsc --noEmit
```

Expected: PASS + tsc 无新增报错。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/student/training/ExamResultPage.tsx apps/web/src/pages/student/training/ExamResultPage.test.tsx apps/web/src/pages/student/training/TargetedRunPage.tsx apps/web/src/pages/student/training/TargetedRunPage.test.tsx
git commit -m "feat(web): 考试结果页与专项完成页挂补偿套题询问卡"
```

---

### Task 14: 文档同步

**Files:**
- Modify: `docs/API接口与数据流设计文档.md`
- Modify: `docs/api/openapi.yaml`
- Modify: `docs/K12智学系统-产品需求文档.md`
- Modify: `docs/K12智学系统-数据库设计文档.md`
- Modify: `docs/UX-UI设计文档.md`
- Modify: `docs/superpowers/specs/2026-09-21-remediation-set-design.md`（第 4 节数据模型精修：origin_question_id 放在 groups 而非 items）

- [ ] **Step 1: API 设计文档（端点清单 + 数据流）**

`docs/API接口与数据流设计文档.md`：
- §4（端点清单）的训练轨表格里新增四行：

| 方法 | 路径 | 说明 | 阶段 |
|---|---|---|---|
| POST | `/api/training/remediation/generate` | 学生同意后生成套题 | MVP |
| GET | `/api/training/remediation/me` | 当前 active 套题概要 | MVP |
| GET | `/api/training/remediation/questions` | 拉取未答对题目 | MVP |
| POST | `/api/training/remediation/answers` | 逐题提交答案 | MVP |
| POST | `/api/training/remediation/self-assess` | 主观题自评 | MVP |

- §5 新增一个数据流小节（编号顺延，例如 §5.29），描述：
  1. 考试交卷/专项完成后询问卡 → 同意 → `generate`
  2. 三元组去重 + 题库抽题 + AI 异步补题
  3. 三卡页轮询 `GET /me` 提示
  4. 作答页 `GET /questions` + `POST /answers`/`self-assess` → 全对 `deleteSet`

- [ ] **Step 2: openapi.yaml**

`docs/api/openapi.yaml` 在 `/api/training` 路径组附近新增 5 个 path（与 API 文档保持同步）：

```yaml
  /api/training/remediation/generate:
    post:
      tags: [Training]
      summary: 生成相似题专项练习
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [source, sessionId]
              properties:
                source: { type: string, enum: [exam, targeted] }
                sessionId: { type: integer }
                wrongQuestionIds: { type: array, items: { type: integer } }
      responses:
        '201':
          description: 已生成
          content:
            application/json:
              schema:
                type: object
                properties:
                  setId: { type: integer }
                  groupsCreated: { type: integer }
                  itemsCreated: { type: integer }
                  skippedNoKp: { type: integer }
                  aiPendingCount: { type: integer }
        '400': { description: 参数非法 }
        '404': { description: 会话不存在 }

  /api/training/remediation/me:
    get:
      tags: [Training]
      summary: 当前相似题套题概要
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  active: { type: boolean }
                  setId: { type: integer, nullable: true }
                  groupCount: { type: integer }
                  itemCount: { type: integer }
                  correctCount: { type: integer }

  /api/training/remediation/questions:
    get:
      tags: [Training]
      summary: 拉取未答对相似题
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  questions:
                    type: array
                    items:
                      type: object
                      properties:
                        questionId: { type: integer }
                        text: { type: string }
                        type: { type: string }
                        options: { type: array, items: { type: object } }
                  itemCount: { type: integer }
                  correctCount: { type: integer }

  /api/training/remediation/answers:
    post:
      tags: [Training]
      summary: 提交相似题答案
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [questionId, studentAnswer]
              properties:
                questionId: { type: integer }
                studentAnswer: { type: string }
      responses:
        '201':
          description: 已判题
          content:
            application/json:
              schema:
                type: object
                properties:
                  isCorrect: { type: boolean, nullable: true }
                  method: { type: string }
                  errorType: { type: string, nullable: true }
                  needsSelfAssessment: { type: boolean }
                  referenceAnswer: { type: string, nullable: true }
                  explanation: { type: string, nullable: true }
                  points: { type: object }
                  setCompleted: { type: boolean }
                  remainingCount: { type: integer }

  /api/training/remediation/self-assess:
    post:
      tags: [Training]
      summary: 相似题主观题自评
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [questionId, assessment]
              properties:
                questionId: { type: integer }
                assessment: { type: string, enum: [correct, incorrect] }
      responses:
        '201': { description: 已记录自评，结构与 /answers 一致 }
```

- [ ] **Step 3: PRD 更新**

`docs/K12智学系统-产品需求文档.md`：
- §6.3 训练轨第 4 点后新增第 5 条「相似题专项练习（错题补偿套题）」，说明：数学考试/专项判错后征得学生同意，按（考点+题型+难度）生成相似题，每组 3 题，逐题作答、答对清零、全对清套、按题型发积分。
- §7.10 末尾加姊妹说明：本功能与变式生成互补；变式是错题**再次**做错时触发，本功能是考/练**完成后**主动推送。
- §7.13 积分任务表新增一行：`remediation_question | 相似题专项 | 题型 | 选择→3 / 填空→4 / 大题→6 | 不限`。

- [ ] **Step 4: DB 设计文档 + UX-UI 文档**

`docs/K12智学系统-数据库设计文档.md`：
- 在训练表/题库相关章节插入 `remediation_sets`/`remediation_groups`/`remediation_set_items` 三表说明（或索引）。

`docs/UX-UI设计文档.md`：
- 在训练轨页面清单中新增「相似题专项作答页 `/student/training/remediation/run`」，并说明三卡页提示条、考试/专项结果页询问卡。

- [ ] **Step 5: 修正 spec 数据模型说明**

`docs/superpowers/specs/2026-09-21-remediation-set-design.md` 第 4 节表格：把 `origin_question_id` 从 `remediation_set_items` 移到 `remediation_groups`（因为组即三元组，触发原错题是组级审计字段），并加一句说明。这是实现层面的小精修，不推翻之前用户裁决。

- [ ] **Step 6: Commit**

```bash
git add docs/API接口与数据流设计文档.md docs/api/openapi.yaml docs/K12智学系统-产品需求文档.md docs/K12智学系统-数据库设计文档.md docs/UX-UI设计文档.md docs/superpowers/specs/2026-09-21-remediation-set-design.md
git commit -m "docs: 补偿套题 API/PRD/DB/UX/openapi 同步更新"
```

---

### Task 15: 全量构建与回归

- [ ] **Step 1: 后端全量测试**

```bash
cd apps/server && npm test
```

Expected: 全部通过（含本次新增 5 个测试文件 + 既有判题/训练/积分用例）。

- [ ] **Step 2: 后端构建与启动**

```bash
cd apps/server && npm run build
cd apps/server && node dist/main.js
```

在另一个 shell 跑确定性安全回归：

```bash
cd apps/server && npx tsx src/ai-core/__tests__/safety-classification.ts
```

Expected: 安全回归无异常；后端 3000 端口启动无 Nest DI 报错。

- [ ] **Step 3: 前端 lint / test / build**

```bash
cd apps/web && npm run lint
cd apps/web && npm test
cd apps/web && npm run build
```

Expected: lint 无新增错误、测试全绿、build 成功。

- [ ] **Step 4: 手工 smoke（用测试账号 lc1/123456）**

在浏览器/Postman 联调（记忆：本地 5173，测试账号 lc1/123456）：

1. 学生登录 → 入口选择 → 训练 → 数学。
2. 做一场专项练习，故意做错几题；完成页出现「生成相似题专项练习」询问卡。
3. 点击生成 → 三卡页顶部出现提示条「相似题专项练习待完成：N 题 / M 组」。
4. 点击「开始练习」 → 进入作答页，逐题作答。
5. 答错 → 该题留在列表稍后重出；答对 → 积分 toast 出现（如家长未禁用）。
6. 全部答对 → 自动回到三卡页，提示条消失，数据库中 `remediation_sets` 已无该学生记录。
7. 考试场景复测一遍：交卷后结果页询问卡 → 生成 → 作答 → 清套。

可选 curl 验证端点：

```bash
curl -s -H "Authorization: Bearer <token>" http://localhost:3000/api/training/remediation/me | jq .
```

- [ ] **Step 5: 最终 Commit（如无修正则无需单独 commit；若有修正，逐条 commit）**

若 smoke 中发现小 bug，按外科手术原则单条修正并 commit；若无需修正，本任务不产生单独 commit。

---

## Self-Review 检查单（写计划者已完成）

1. **Spec coverage**：
   - 三元组去重成组 → Task 6 `buildGroups`（含 add-merge-dedup 唯一键）
   - 题库抽题 + 难度放宽 → Task 3 repo + Task 6
   - AI 异步补题 + 校验入库 → Task 6
   - 三卡页提示条 → Task 11
   - 询问卡同意才生成 → Task 10/13
   - 逐题作答 + 答对清零 + 全对清套 → Task 7/12
   - 积分按题型 3/4/6 → Task 2/7
   - 不入错题本不参与门禁 → Task 4
   - 仅数学 + 考试/专项触发 → Task 7
   - 文档同步 → Task 14

2. **Placeholder scan**：无 TBD/TODO/"implement later"；每步含代码或精确命令。

3. **Type consistency**：
   - 服务端返回结构 `RemediationAnswerResult` 与 controller 返回一致。
   - `GenerateRemediationInput` 在 service 与 controller 间一致。
   - `RemediationGroupRow`/`RemediationItemRow` 在 repo/generator/service 间一致。

4. **已知风险点已处理**：
   - `LIMIT ?` 占位符 → 用字面量 `LIMIT 1` 或 `pool.query`。
   - AI options 泄漏答案 → 入库前剥 `isCorrect`。
   - targeted 刷分 → 后端用错题本 `source='targeted'` 验证。
   - 进程重启悬挂 → `ai_pending_count` + `retryPending` 惰性重试。
   - 题目下线死锁 → `listQuestions` 自动标对下线题。

---

## 执行交接

Plan complete and saved to `docs/superpowers/plans/2026-09-21-remediation-set.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`.
2. **Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach?
