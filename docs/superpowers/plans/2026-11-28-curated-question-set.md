# 学生精选题单推荐与年级发布 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现“学生推荐题集 → 教研员审核 → 按单一年级发布 → 学生在精选题单 Tab 作答”的精选题单闭环，并保证记录练习历史但不发积分。

**Architecture:** 新增独立 `featured-sets` 后端模块，题集、推荐、按年级 publication 和学生已读分开建模；发布后的 publication 就是学生收件项。学生端复用 `TargetedRunPage`，由 `open` 创建带 `featured_publication_id` 的服务端专项会话，判题服务据此强制压制 `error_fix`。

**Tech Stack:** NestJS 10、MySQL 8、mysql2、Vitest、React 18、React Router 6、Zustand、Tailwind。

## Global Constraints

- 不建设学生好友、学生私信、自由文本分享或通用学生消息中心。
- 学生只能从专项结果页和错题本单题行推荐；首期不接考试结果页。
- 推荐必须为同一学科、排序去重后 1～20 题、在架、有标准答案、非 `freeform`，且每道题都能在该生作答事实中找到。
- 一个 publication 只对应一个标准 `grade_N` 年级；同一题集可分别发布到多个年级。
- 标题属于 publication，不属于题集。
- 年级匹配使用 `resolveGradeInfo(student.grade)?.code`，不比较原始年级字符串。
- 完整精选题单列表在浅停留页独立「精选题单」Tab；训练首页仅保留未读 Banner，点击直达最新一条作答。
- 精选题单使用服务端 `sessionUid` 写现有专项历史；`sessionId` 恒为 `null`。
- featured session 必须由服务端强制压制 `error_fix`，不得只信客户端 `suppressErrorFixPoints`。
- 不新增 `judge source='featured'`；判题来源继续使用 `targeted`。
- 所有新增学生/教研端点显式声明角色；状态迁移 POST 显式 `@HttpCode(200)`。
- `featured_question_set_items` 必须进入教研删卷 `BLOCKING_TABLES`。
- 不新增 `behavior_events` 事件，不从 `SubscriptionGuard` 豁免新端点。
- UI 不用 emoji，图标只用线性 SVG；个人中心仍写死日间主题。

## File Structure

**数据库与后端**

- Create: `tools/db/migrations/2026-11-28_curated_question_sets.sql`
- Modify: `tools/db/schema.sql`
- Create: `apps/server/src/database/repositories/featured-question-sets.repo.ts`
- Create: `apps/server/src/database/repositories/featured-question-sets.repo.test.ts`
- Create: `apps/server/src/modules/featured-sets/content-key.ts`
- Create: `apps/server/src/modules/featured-sets/content-key.test.ts`
- Create: `apps/server/src/modules/featured-sets/featured-question-run.mapper.ts`
- Create: `apps/server/src/modules/featured-sets/featured-question-run.mapper.test.ts`
- Create: `apps/server/src/modules/featured-sets/featured-recommendation.service.ts`
- Create: `apps/server/src/modules/featured-sets/featured-recommendation.service.test.ts`
- Create: `apps/server/src/modules/featured-sets/featured-review.service.ts`
- Create: `apps/server/src/modules/featured-sets/featured-review.service.test.ts`
- Create: `apps/server/src/modules/featured-sets/featured-delivery.service.ts`
- Create: `apps/server/src/modules/featured-sets/featured-delivery.service.test.ts`
- Create: `apps/server/src/modules/featured-sets/student-featured-sets.controller.ts`
- Create: `apps/server/src/modules/featured-sets/student-featured-sets.controller.test.ts`
- Create: `apps/server/src/modules/featured-sets/research-featured-sets.controller.ts`
- Create: `apps/server/src/modules/featured-sets/research-featured-sets.controller.test.ts`
- Create: `apps/server/src/modules/featured-sets/featured-sets.module.ts`
- Modify: `apps/server/src/app.module.ts`
- Modify: `apps/server/src/database/repositories/questions.repo.ts`
- Modify: `apps/server/src/database/repositories/questions.repo.test.ts`
- Modify: `apps/server/src/database/repositories/special-practice-sessions.repo.ts`
- Modify: `apps/server/src/database/repositories/special-practice-sessions.repo.test.ts`
- Modify: `apps/server/src/modules/training/training.service.ts`
- Modify: `apps/server/src/modules/training/training.service.test.ts`
- Modify: `apps/server/src/database/repositories/research-papers.repo.ts`
- Modify: `apps/server/src/database/repositories/research-papers.repo.test.ts`

**前端**

- Modify: `apps/web/src/services/api.ts`
- Create: `apps/web/src/components/business/RecommendFeaturedSetButton.tsx`
- Create: `apps/web/src/components/business/RecommendFeaturedSetButton.test.tsx`
- Create: `apps/web/src/components/business/FeaturedSetsCard.tsx`
- Create: `apps/web/src/components/business/FeaturedSetsCard.test.tsx`
- Modify: `apps/web/src/pages/student/ProfilePage.tsx`
- Modify: `apps/web/src/pages/student/ProfilePage.test.tsx`
- Modify: `apps/web/src/pages/student/training/TrainingHomePage.tsx`
- Modify: `apps/web/src/pages/student/training/TrainingHomePage.test.tsx`
- Modify: `apps/web/src/pages/student/training/run-handoff.ts`
- Modify: `apps/web/src/pages/student/training/TargetedRunPage.tsx`
- Modify: `apps/web/src/pages/student/training/TargetedRunPage.test.tsx`
- Modify: `apps/web/src/pages/student/training/ErrorPracticePage.tsx`
- Modify: `apps/web/src/pages/student/training/ErrorPracticePage.test.tsx`
- Create: `apps/web/src/pages/research/ResearchFeaturedSetsPage.tsx`
- Create: `apps/web/src/pages/research/__tests__/ResearchFeaturedSetsPage.test.tsx`
- Modify: `apps/web/src/components/layout/ResearchNav.tsx`
- Modify: `apps/web/src/routes/routeTable.tsx`
- Modify: `apps/web/src/routes/routeTable.test.tsx`

**文档与度量**

- Create: `tools/db/featured_question_set_metrics.sql`
- Modify: `docs/K12智学系统-产品需求文档.md`
- Modify: `docs/API接口与数据流设计文档.md`
- Modify: `docs/api/openapi.yaml`
- Modify: `docs/K12智学系统-数据库设计文档.md`
- Modify: `docs/UX-UI设计文档.md`
- Modify: `docs/constraints/专项子系统.md`

---

### Task 1: 数据库结构与删卷引用基础

**Files:**
- Create: `tools/db/migrations/2026-11-28_curated_question_sets.sql`
- Modify: `tools/db/schema.sql`
- Test: `python3 tools/db/schema_reconcile.py`

**Interfaces:**
- Produces: 5 张新增表，以及 `special_practice_sessions.featured_publication_id`。
- Produces: `featured_question_set_publications.title` 与 `reach_count`。

- [ ] **Step 1: 写幂等迁移**

```sql
CREATE TABLE IF NOT EXISTS featured_question_sets (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  content_key CHAR(64) NOT NULL,
  subject_id BIGINT NOT NULL,
  created_by_student_id BIGINT DEFAULT NULL,
  review_status VARCHAR(16) NOT NULL DEFAULT 'pending',
  question_count SMALLINT NOT NULL,
  reviewed_by BIGINT DEFAULT NULL,
  reviewed_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_fqs_content_key (content_key),
  KEY idx_fqs_review (review_status, created_at),
  KEY idx_fqs_creator_day (created_by_student_id, created_at),
  CONSTRAINT fk_fqs_subject FOREIGN KEY (subject_id) REFERENCES subjects (id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_fqs_creator FOREIGN KEY (created_by_student_id)
    REFERENCES students (id) ON DELETE SET NULL,
  CONSTRAINT fk_fqs_reviewer FOREIGN KEY (reviewed_by) REFERENCES admins (id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS featured_question_set_items (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  set_id BIGINT NOT NULL,
  question_id BIGINT NOT NULL,
  sort_order SMALLINT NOT NULL,
  UNIQUE KEY uniq_fqsi_set_question (set_id, question_id),
  UNIQUE KEY uniq_fqsi_set_order (set_id, sort_order),
  KEY idx_fqsi_question (question_id),
  CONSTRAINT fk_fqsi_set FOREIGN KEY (set_id)
    REFERENCES featured_question_sets (id) ON DELETE CASCADE,
  CONSTRAINT fk_fqsi_question FOREIGN KEY (question_id)
    REFERENCES questions (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS featured_question_set_recommendations (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  set_id BIGINT NOT NULL,
  student_id BIGINT NOT NULL,
  student_grade_code VARCHAR(10) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_fqsr_set_student (set_id, student_id),
  KEY idx_fqsr_set_grade (set_id, student_grade_code),
  CONSTRAINT fk_fqsr_set FOREIGN KEY (set_id)
    REFERENCES featured_question_sets (id) ON DELETE CASCADE,
  CONSTRAINT fk_fqsr_student FOREIGN KEY (student_id)
    REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS featured_question_set_publications (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  set_id BIGINT NOT NULL,
  grade_code VARCHAR(10) NOT NULL,
  title VARCHAR(60) NOT NULL,
  reach_count INT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'published',
  published_by BIGINT NOT NULL,
  published_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  withdrawn_by BIGINT DEFAULT NULL,
  withdrawn_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_fqsp_set_grade (set_id, grade_code),
  KEY idx_fqsp_grade_status (grade_code, status, published_at),
  CONSTRAINT fk_fqsp_set FOREIGN KEY (set_id)
    REFERENCES featured_question_sets (id) ON DELETE CASCADE,
  CONSTRAINT fk_fqsp_publisher FOREIGN KEY (published_by) REFERENCES admins (id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_fqsp_withdrawer FOREIGN KEY (withdrawn_by) REFERENCES admins (id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS featured_question_set_reads (
  publication_id BIGINT NOT NULL,
  student_id BIGINT NOT NULL,
  read_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (publication_id, student_id),
  KEY idx_fqsr_student (student_id, read_at),
  CONSTRAINT fk_fqsread_publication FOREIGN KEY (publication_id)
    REFERENCES featured_question_set_publications (id) ON DELETE CASCADE,
  CONSTRAINT fk_fqsread_student FOREIGN KEY (student_id)
    REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 2: 写幂等增量列**

迁移脚本必须在 `information_schema.COLUMNS / STATISTICS / TABLE_CONSTRAINTS` 中分别判断后执行：

```sql
ALTER TABLE special_practice_sessions
  ADD COLUMN featured_publication_id BIGINT DEFAULT NULL,
  ADD KEY idx_sps_featured_publication (featured_publication_id),
  ADD CONSTRAINT fk_sps_featured_publication
    FOREIGN KEY (featured_publication_id)
    REFERENCES featured_question_set_publications (id) ON DELETE SET NULL;
```

- [ ] **Step 3: 折回 `tools/db/schema.sql`**

把 5 张表放在 `special_practice_sessions` 之前，把 `featured_publication_id` 直接写进 `special_practice_sessions` 建表定义和外键区。

- [ ] **Step 4: 对账**

Run: `python3 tools/db/schema_reconcile.py`

Expected: 所有表/列/索引/外键与 `schema.sql` 一致，无 drift。

- [ ] **Step 5: 提交**

```bash
git add tools/db/migrations/2026-11-28_curated_question_sets.sql tools/db/schema.sql
git commit -m "feat(db): add curated question set tables"
```

---

### Task 2: Content Key、共享题目映射与模块骨架

**Files:**
- Create: `apps/server/src/modules/featured-sets/content-key.ts`
- Create: `apps/server/src/modules/featured-sets/content-key.test.ts`
- Create: `apps/server/src/modules/featured-sets/featured-question-run.mapper.ts`
- Create: `apps/server/src/modules/featured-sets/featured-question-run.mapper.test.ts`
- Create: `apps/server/src/modules/featured-sets/featured-sets.module.ts`
- Modify: `apps/server/src/app.module.ts`

**Interfaces:**
- Produces: `createFeaturedContentKey(subjectId: number, questionIds: number[]): string`
- Produces: `toFeaturedRunQuestion(q: FeaturedSourceQuestion): FeaturedRunQuestion`
- Produces: `FeaturedSetsModule`

```ts
export interface FeaturedRunQuestion {
  questionId: number;
  text: string;
  type: string;
  options: unknown[] | null;
  materialText: string | null;
  materialUrl: string | null;
  subNo: number;
  materialPosition: 'before' | null;
  source: string | null;
  questionNo: number | null;
}
```

- [ ] **Step 1: 写 content key 失败测试**

```ts
import { describe, expect, it } from 'vitest';
import { createFeaturedContentKey } from './content-key.js';

describe('createFeaturedContentKey', () => {
  it('忽略题目顺序并对题目去重', () => {
    expect(createFeaturedContentKey(1, [9, 3, 9, 7]))
      .toBe(createFeaturedContentKey(1, [7, 3, 9]));
  });

  it('学科或题目集合不同则不同', () => {
    expect(createFeaturedContentKey(1, [1, 2]))
      .not.toBe(createFeaturedContentKey(2, [1, 2]));
    expect(createFeaturedContentKey(1, [1, 2]))
      .not.toBe(createFeaturedContentKey(1, [1, 3]));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/featured-sets/content-key.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 content key**

```ts
import { createHash } from 'node:crypto';

export function createFeaturedContentKey(subjectId: number, questionIds: number[]): string {
  const sorted = [...new Set(questionIds)].sort((a, b) => a - b);
  return createHash('sha256').update(`${subjectId}:${sorted.join(',')}`).digest('hex');
}
```

- [ ] **Step 4: 写 mapper 失败测试**

```ts
import { describe, expect, it } from 'vitest';
import { toFeaturedRunQuestion } from './featured-question-run.mapper.js';

it('保留材料、小问、来源和试卷题号', () => {
  expect(toFeaturedRunQuestion({
    id: 7, subject_id: 4, content: '物理材料题', type: 'short_answer',
    options: JSON.stringify([{ label: 'A', text: '甲' }]),
    material_text: '材料', material_url: null, sub_no: 2,
    source: '某卷', question_no: 18,
  })).toEqual({
    questionId: 7, text: '物理材料题', type: 'short_answer',
    options: [{ label: 'A', text: '甲' }], materialText: '材料', materialUrl: null,
    subNo: 2, materialPosition: 'before', source: '某卷', questionNo: 18,
  });
});
```

- [ ] **Step 5: 实现 mapper**

```ts
import { materialPositionFor } from '../../common/subject-config.js';
import { parseOptions } from '../../common/utils/parse-options.util.js';

export function toFeaturedRunQuestion(q: {
  id: number; subject_id: number; content: string; type: string; options: string | null;
  material_text: string | null; material_url: string | null; sub_no?: number | null;
  source?: string | null; question_no?: number | null;
}): FeaturedRunQuestion {
  return {
    questionId: Number(q.id),
    text: q.content,
    type: q.type,
    options: parseOptions(q.options),
    materialText: q.material_text ?? null,
    materialUrl: q.material_url ?? null,
    subNo: Number(q.sub_no ?? 0),
    materialPosition: materialPositionFor(q.subject_id),
    source: q.source ?? null,
    questionNo: q.question_no ?? null,
  };
}
```

- [ ] **Step 6: 建模块并接入 AppModule**

```ts
import { Module } from '@nestjs/common';

@Module({})
export class FeaturedSetsModule {}
```

在 `apps/server/src/app.module.ts` import `FeaturedSetsModule`，并加入 imports。

- [ ] **Step 7: 测试并提交**

Run: `cd apps/server && npx vitest run src/modules/featured-sets/content-key.test.ts src/modules/featured-sets/featured-question-run.mapper.test.ts`

Expected: PASS。

```bash
git add apps/server/src/modules/featured-sets apps/server/src/app.module.ts
git commit -m "feat(featured): add content key and run mapping"
```

---

### Task 3: 数据仓储与推荐事务

**Files:**
- Create: `apps/server/src/database/repositories/featured-question-sets.repo.ts`
- Create: `apps/server/src/database/repositories/featured-question-sets.repo.test.ts`
- Modify: `apps/server/src/database/repositories/index.ts`

**Interfaces:**
- Produces repository methods used by later tasks:

```ts
export interface CreateRecommendationInput {
  subjectId: number;
  questionIds: number[];
  contentKey: string;
  studentId: number;
  gradeCode: string;
}

export interface FeaturedSourceQuestion {
  id: number;
  subject_id: number;
  content: string;
  type: string;
  options: string | null;
  answer: string;
  explanation: string | null;
  material_text: string | null;
  material_url: string | null;
  sub_no: number;
  source: string | null;
  question_no: number | null;
}

export interface CreateRecommendationResult {
  setId: number;
  alreadyRecommended: boolean;
}

export interface StudentFeaturedPublication {
  publicationId: number;
  setId: number;
  title: string;
  subjectId: number;
  subjectName: string;
  questionCount: number;
  publishedAt: Date;
  isRead: boolean;
}

export interface FeaturedUnreadSummary {
  count: number;
  latest: { publicationId: number; title: string } | null;
}

export interface ReviewSetListItem {
  setId: number;
  subjectId: number;
  subjectName: string;
  questionCount: number;
  recommendationCount: number;
  gradeDistribution: Array<{ gradeCode: string; count: number }>;
  reviewStatus: 'pending' | 'approved' | 'rejected';
  createdAt: Date;
}

export interface OpenPublicationResult {
  publicationId: number;
  setId: number;
  title: string;
  subjectId: number;
  questions: FeaturedSourceQuestion[];
}

export class FeaturedQuestionSetsRepository {
  countSetsCreatedToday(studentId: number): Promise<number>;
  createRecommendation(input: CreateRecommendationInput): Promise<CreateRecommendationResult>;
  listReviewSets(status: ReviewStatus, page: number, pageSize: number): Promise<{ items: ReviewSetListItem[]; total: number }>;
  getReviewSet(id: number): Promise<ReviewSetDetail | null>;
  pendingCount(): Promise<number>;
  publish(input: { setId: number; title: string; gradeCode: string; reviewerId: number; reachCount: number }): Promise<{ publicationId: number }>;
  reject(setId: number, reviewerId: number): Promise<void>;
  reopen(setId: number): Promise<void>;
  withdraw(publicationId: number, reviewerId: number): Promise<void>;
  listStudentPublications(studentId: number, gradeCode: string, page: number, pageSize: number): Promise<{ items: StudentFeaturedPublication[]; total: number }>;
  unreadSummary(studentId: number, gradeCode: string): Promise<FeaturedUnreadSummary>;
  findOpenPublication(publicationId: number, gradeCode: string, executor?: PoolConnection): Promise<OpenPublicationResult | null>;
  markRead(publicationId: number, studentId: number, executor?: PoolConnection): Promise<void>;
}
```

- [ ] **Step 1: 写推荐事务失败测试**

```ts
it('相同 content_key 命中既有题集时不重复建 items', async () => {
  const conn = {
    beginTransaction: vi.fn(),
    execute: vi.fn()
      .mockResolvedValueOnce([{ insertId: 0, affectedRows: 1 }, []])
      .mockResolvedValueOnce([[{ id: 42 }], []])
      .mockResolvedValueOnce([{ affectedRows: 0 }, []])
      .mockResolvedValueOnce([{ affectedRows: 0 }, []])
      .mockResolvedValueOnce([[], []]),
    commit: vi.fn(),
    rollback: vi.fn(),
    release: vi.fn(),
  };
  const repo = new FeaturedQuestionSetsRepository({ getConnection: () => conn } as never);

  const out = await repo.createRecommendation({
    subjectId: 1, questionIds: [3, 7], contentKey: 'k', studentId: 9, gradeCode: 'grade_7',
  });

  expect(out).toEqual({ setId: 42, alreadyRecommended: false });
  expect(conn.execute.mock.calls.filter((c) => String(c[0]).includes('INSERT IGNORE INTO featured_question_set_items'))).toHaveLength(0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/database/repositories/featured-question-sets.repo.test.ts`

Expected: FAIL，repository 不存在。

- [ ] **Step 3: 实现推荐事务**

事务顺序固定：

```sql
INSERT INTO featured_question_sets
  (content_key, subject_id, created_by_student_id, question_count)
VALUES (?, ?, ?, ?)
ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id);
```

随后：

```sql
SELECT id FROM featured_question_sets WHERE content_key = ?;
```

若题集是新建的（inserted id 等于 select id），才批量写 items：

```sql
INSERT INTO featured_question_set_items (set_id, question_id, sort_order)
VALUES (?, ?, ?);
```

最后：

```sql
INSERT IGNORE INTO featured_question_set_recommendations
  (set_id, student_id, student_grade_code)
VALUES (?, ?, ?);
```

用 `affectedRows` 计算 `alreadyRecommended`。任一步失败必须 rollback。

- [ ] **Step 4: 写发布、撤回、学生列表和已读仓储测试**

```ts
it('发布时更新 publication 的独立标题和 reach_count', async () => {
  await repo.publish({
    setId: 5, title: '八年级数学精选', gradeCode: 'grade_8',
    reviewerId: 8, reachCount: 36,
  });
  const publishSql = conn.execute.mock.calls.map((c) => String(c[0])).find((s) => s.includes('featured_question_set_publications'))!;
  expect(publishSql).toContain('title');
  expect(publishSql).toContain('reach_count');
  expect(conn.execute).toHaveBeenCalledWith(expect.stringContaining('title'), expect.arrayContaining(['八年级数学精选', 36]));
});

it('学生列表只查目标年级、published 且至少一题在架', async () => {
  await repo.listStudentPublications(9, 'grade_7', 1, 20);
  const sql = pool.execute.mock.calls.map((c) => String(c[0])).find((s) => s.includes('featured_question_set_publications'))!;
  expect(sql).toContain("status = 'published'");
  expect(sql).toContain('grade_code = ?');
  expect(sql).toContain('available_count > 0');
  expect(pool.execute.mock.calls.at(-1)?.[1]).toEqual(['grade_7', 9, 20, 0]);
});

it('unreadSummary 返回 count 与 latest', async () => {
  pool.execute
    .mockResolvedValueOnce([[{ c: 2 }], []])
    .mockResolvedValueOnce([[{ publicationId: 8, title: '最新精选' }], []]);
  await expect(repo.unreadSummary(9, 'grade_7')).resolves.toEqual({
    count: 2,
    latest: { publicationId: 8, title: '最新精选' },
  });
});

it('withdraw 只改指定 publication，不删除历史', async () => {
  await repo.withdraw(22, 8);
  expect(conn.execute).toHaveBeenCalledWith(
    expect.stringContaining("status = 'withdrawn'"),
    [8, 22],
  );
  expect(conn.execute.mock.calls.some((c) => /DELETE FROM special_practice_sessions/.test(String(c[0])))).toBe(false);
});
```

- [ ] **Step 5: 实现仓储剩余方法**

- `listReviewSets` 用分页查询；推荐人数和年级分布由子查询聚合，不返回 student_id。
- `publish` 在事务内锁 set、upsert publication、置 set `approved`、写 reviewer；如果 publication 原为 withdrawn，同时执行 `DELETE FROM featured_question_set_reads WHERE publication_id=?`。
- `reopen` 只允许 `rejected`，置 `pending` 并清空 reviewer/时间。
- `withdraw` 只允许 `published`，写 `withdrawn_by/at`。
- `listStudentPublications` 的 `questionCount` 取当前在架题数，0 题不返回。
- `unreadSummary.latest` 取最新未读 publication。
- `findOpenPublication` 只返回 published 且目标年级匹配的题集，题目按 `sort_order, q.sub_no` 排序。
- `markRead` 使用 `INSERT IGNORE`。
- `listReviewSets` 默认 `pageSize=20`，越界返回空 items。

- [ ] **Step 6: 导出 repository**

在 `apps/server/src/database/repositories/index.ts` 导出类与上述公开接口。

- [ ] **Step 7: 测试并提交**

Run: `cd apps/server && npx vitest run src/database/repositories/featured-question-sets.repo.test.ts`

Expected: PASS。

```bash
git add apps/server/src/database/repositories/featured-question-sets.repo.ts apps/server/src/database/repositories/featured-question-sets.repo.test.ts apps/server/src/database/repositories/index.ts
git commit -m "feat(featured): add featured set repository"
```

---

### Task 4: 学生推荐服务与端点

**Files:**
- Create: `apps/server/src/modules/featured-sets/featured-recommendation.service.ts`
- Create: `apps/server/src/modules/featured-sets/featured-recommendation.service.test.ts`
- Create: `apps/server/src/modules/featured-sets/student-featured-sets.controller.ts`
- Create: `apps/server/src/modules/featured-sets/student-featured-sets.controller.test.ts`
- Modify: `apps/server/src/database/repositories/questions.repo.ts`
- Modify: `apps/server/src/database/repositories/questions.repo.test.ts`
- Modify: `apps/server/src/modules/featured-sets/featured-sets.module.ts`

**Interfaces:**
- Consumes: `FeaturedQuestionSetsRepository.createRecommendation`.
- Consumes: `QuestionsRepository.findAnsweredQuestionIds(studentId, questionIds): Promise<Set<number>>`.
- Produces: `POST /api/student/featured-sets/recommend`，201 `{setId,alreadyRecommended}`。

- [ ] **Step 1: 写“未做过不能推荐”失败测试**

```ts
it('有任意题不在该生作答事实中 -> 1004', async () => {
  questions.findByIds.mockResolvedValue([
    row({ id: 1, source: 'paper', answer: 'A' }),
    row({ id: 2, source: 'paper', answer: 'B' }),
  ]);
  questions.findAnsweredQuestionIds.mockResolvedValue(new Set([1]));

  await expect(service.recommend(7, [1, 2]))
    .rejects.toMatchObject({ response: { code: 1004, message: '只能推荐自己做过的题' } });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/featured-sets/featured-recommendation.service.test.ts`

Expected: FAIL。

- [ ] **Step 3: 给 QuestionsRepository 加作答事实查询**

```ts
async findAnsweredQuestionIds(studentId: number, questionIds: number[]): Promise<Set<number>> {
  const ids = [...new Set(questionIds)];
  if (ids.length === 0) return new Set();
  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await this.pool.execute<RowDataPacket[]>(
    `SELECT question_id FROM (${ANSWERED_TIMES_SQL}) answered
      WHERE question_id IN (${placeholders})`,
    [studentId, studentId, studentId, studentId, ...ids],
  );
  return new Set(rows.map((r) => Number(r.question_id)));
}
```

测试必须断言四个 `student_id` 参数和 IN 参数顺序正确。

- [ ] **Step 4: 实现推荐服务**

顺序固定：

1. `ids = [...new Set(questionIds)]`；
2. 数量必须 1～20，否则 `BadRequestException({code:1001})`；
3. `studentsRepo.findById(studentId)`，年级用 `resolveGradeInfo`，无法解析则 1001；
4. `questionsRepo.findByIds(ids)`，缺题/停用 1002；
5. 任一 `source === 'freeform'` → 1004；
6. 任一 `answer.trim()===''` → 1004；
7. subject 不唯一 → 1001；
8. `findAnsweredQuestionIds` 覆盖全部题，否则 1004；
9. `countSetsCreatedToday >= 10` → 429/1008；
10. 计算 content key；
11. 调 repository 创建/挂接推荐。

- [ ] **Step 5: 写 controller 契约测试**

```ts
it('学生推荐：POST 201 且只从 JWT 取 studentId', async () => {
  const controller = new StudentFeaturedSetsController(service as never);
  await expect(controller.recommend({ questionIds: [1, 2] }, { sub: 7 } as never))
    .resolves.toEqual({ setId: 3, alreadyRecommended: false });
  expect(service.recommend).toHaveBeenCalledWith(7, [1, 2]);
});
```

- [ ] **Step 6: 实现 controller 与模块注册**

```ts
@Controller('api/student/featured-sets')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class StudentFeaturedSetsController {
  constructor(private readonly recommendation: FeaturedRecommendationService) {}

  @Post('recommend')
  recommend(@Body() body: { questionIds: number[] }, @CurrentUser() user: JwtUser) {
    return this.recommendation.recommend(user.sub, body.questionIds);
  }
}
```

模块 providers 增加 `FeaturedRecommendationService`、`QuestionsRepository`、`StudentsRepository`。

- [ ] **Step 7: 测试并提交**

Run: `cd apps/server && npx vitest run src/modules/featured-sets/featured-recommendation.service.test.ts src/modules/featured-sets/student-featured-sets.controller.test.ts src/database/repositories/questions.repo.test.ts`

Expected: PASS。

```bash
git add apps/server/src/modules/featured-sets apps/server/src/database/repositories/questions.repo.ts apps/server/src/database/repositories/questions.repo.test.ts
git commit -m "feat(featured): add student recommendations"
```

---

### Task 5: 教研审核、发布、撤回与 pending count

**Files:**
- Create: `apps/server/src/modules/featured-sets/featured-review.service.ts`
- Create: `apps/server/src/modules/featured-sets/featured-review.service.test.ts`
- Create: `apps/server/src/modules/featured-sets/research-featured-sets.controller.ts`
- Create: `apps/server/src/modules/featured-sets/research-featured-sets.controller.test.ts`
- Modify: `apps/server/src/modules/featured-sets/featured-sets.module.ts`

**Interfaces:**
- Produces: `list(status,page)`, `detail(id)`, `pendingCount()`, `publish(input)`, `reject(id,user)`, `reopen(id)`, `withdraw(publicationId,user)`。
- Produces 7 个 `/api/research/featured-sets` GET/POST 端点。

- [ ] **Step 1: 写发布标题隔离失败测试**

```ts
it('同一题集发八年级时使用八年级自己的标题', async () => {
  repository.publish.mockResolvedValue({ publicationId: 22 });
  await service.publish(5, { title: '八年级数学精选题', gradeCode: 'grade_8' }, reviewer);
  expect(repository.publish).toHaveBeenCalledWith({
    setId: 5, title: '八年级数学精选题', gradeCode: 'grade_8',
    reviewerId: 8, reachCount: 36,
  });
});
```

- [ ] **Step 2: 写状态与参数校验失败测试**

```ts
it('空标题与非法年级均为 1001', async () => {
  await expect(service.publish(5, { title: '', gradeCode: 'grade_8' }, reviewer))
    .rejects.toMatchObject({ response: { code: 1001 } });
  await expect(service.publish(5, { title: 'x', gradeCode: '大学' }, reviewer))
    .rejects.toMatchObject({ response: { code: 1001 } });
});

it('rejected 题集不能直接发布', async () => {
  repository.getReviewSet.mockResolvedValue(detail({ reviewStatus: 'rejected' }));
  await expect(service.publish(5, { title: 'x', gradeCode: 'grade_8' }, reviewer))
    .rejects.toMatchObject({ response: { code: 1004 } });
});
```

- [ ] **Step 3: 实现 reach_count**

```ts
async countActiveStudentsForGrade(gradeCode: string): Promise<number> {
  const students = await this.studentsRepo.listAllActive();
  return students.filter((s) => resolveGradeInfo(s.grade ?? '')?.code === gradeCode).length;
}
```

若 `StudentsRepository` 没有 `listAllActive()`，本步新增该方法，SQL 条件固定为：

```sql
WHERE deleted_at IS NULL AND is_active = 1
```

- [ ] **Step 4: 实现 review service**

- `publish`：校验 title 1..60、`gradeInfoByCode` 存在、detail 非 rejected、reach count 后调 repo。
- `reject`：只允许 pending。
- `reopen`：只允许 rejected。
- `withdraw`：只允许 published。
- `detail` 不存在 → 1002。
- 所有角色校验由 controller 的 `@Roles('researcher')` 承担。

- [ ] **Step 5: 实现 controller**

```ts
@Controller('api/research/featured-sets')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('researcher')
export class ResearchFeaturedSetsController {
  @Get()
  list(@Query('status') status: string | undefined, @Query('page') page: string | undefined) {
    return this.service.list(status, page);
  }

  @Get('pending-count')
  pendingCount() { return this.service.pendingCount(); }

  @Post(':id/publish')
  @HttpCode(200)
  publish(@Param('id', ParseIntPipe) id: number, @Body() body: unknown, @CurrentUser() u: JwtUser) {
    return this.service.publish(id, body, u);
  }
}
```

`reject`、`reopen`、`withdraw` 同样显式 `@HttpCode(200)`。路由顺序先声明 `pending-count`，再声明 `:id`。

- [ ] **Step 6: 测试并提交**

Run: `cd apps/server && npx vitest run src/modules/featured-sets/featured-review.service.test.ts src/modules/featured-sets/research-featured-sets.controller.test.ts`

Expected: PASS，并断言 5 个状态迁移 POST 都是 200。

```bash
git add apps/server/src/modules/featured-sets apps/server/src/database/repositories/students.repo.ts
git commit -m "feat(featured): add review and grade publishing"
```

---

### Task 6: 学生列表、未读摘要与服务端 open 会话

**Files:**
- Create: `apps/server/src/modules/featured-sets/featured-delivery.service.ts`
- Create: `apps/server/src/modules/featured-sets/featured-delivery.service.test.ts`
- Modify: `apps/server/src/modules/featured-sets/student-featured-sets.controller.ts`
- Modify: `apps/server/src/modules/featured-sets/student-featured-sets.controller.test.ts`
- Modify: `apps/server/src/database/repositories/special-practice-sessions.repo.ts`
- Modify: `apps/server/src/database/repositories/special-practice-sessions.repo.test.ts`
- Modify: `apps/server/src/modules/featured-sets/featured-sets.module.ts`

**Interfaces:**
- Produces: `GET /api/student/featured-sets?page=1`
- Produces: `GET /api/student/featured-sets/unread-count` 返回 `{count,latest}`
- Produces: `POST /api/student/featured-sets/publications/:id/open` 200
- Produces handoff:

```ts
export interface FeaturedRunPayload {
  mode: 'featured';
  sessionUid: string;
  subjectId: number;
  title: string;
  questions: FeaturedRunQuestion[];
}
```

- [ ] **Step 1: 写 open 创建服务端 session 失败测试**

```ts
it('open 先生成 sessionUid、创建 featured session，再标已读', async () => {
  students.findById.mockResolvedValue(student({ grade: '初一' }));
  repository.findOpenPublication.mockResolvedValue(openResult());
  specialSessions.upsertSession.mockResolvedValue(101);

  const out = await service.open(9, 22);

  expect(out.sessionUid).toMatch(/^[0-9a-f-]{36}$/);
  expect(specialSessions.upsertSession).toHaveBeenCalledWith(expect.objectContaining({
    studentId: 9,
    subjectId: 1,
    title: '七年级数学精选',
    questionCount: 2,
    featuredPublicationId: 22,
  }));
  expect(repository.markRead).toHaveBeenCalledWith(22, 9);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/featured-sets/featured-delivery.service.test.ts`

Expected: FAIL。

- [ ] **Step 3: 扩展 `UpsertSessionInput`**

```ts
export interface UpsertSessionInput {
  sessionUid: string;
  studentId: number;
  subjectId: number;
  module: SpecialSessionModule;
  title: string | null;
  questionCount: number;
  featuredPublicationId?: number | null;
}
```

`INSERT IGNORE` 增加 `featured_publication_id` 列和参数；命中既有行时仍校验 student/subject/module。

- [ ] **Step 4: 实现 list、unread summary、open**

`open` 固定行为：

1. 查学生并 `resolveGradeInfo`；
2. `randomUUID()`；
3. `FeaturedDeliveryService` 从注入的 `DATABASE_POOL` 取连接并 `beginTransaction()`；
4. repository 用同一连接查 publication 和在架题；
5. 0 题或年级不匹配 → rollback + 1002；
6. special session repo 用同一连接创建 session，`module=targetedSessionModule(subjectId)`；
7. repository 用同一连接标已读并 commit；
8. 用 mapper 返回题单；任一步失败 rollback 并抛原错误。

不新增 `featured` module 枚举。

- [ ] **Step 5: 写 controller 200 与路由序测试**

```ts
it('unread-count 在 :id/open 前，open 显式 200', () => {
  expect(Reflect.getMetadata(PATH_METADATA, StudentFeaturedSetsController))
    .toBe('api/student/featured-sets');
  expect(Reflect.getMetadata(HTTP_CODE_METADATA, controller.open)).toBe(200);
});
```

在 `StudentFeaturedSetsController` 构造器追加 `FeaturedDeliveryService`，并在 recommend 路由之前声明 `unread-count`，其余 GET/open 方法如下：

```ts
@Get()
list(@Query('page') page: string | undefined, @CurrentUser() u: JwtUser) {
  return this.delivery.list(u.sub, page);
}

@Get('unread-count')
unreadCount(@CurrentUser() u: JwtUser) {
  return this.delivery.unreadSummary(u.sub);
}

@Post('publications/:id/open')
@HttpCode(200)
open(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: JwtUser) {
  return this.delivery.open(u.sub, id);
}
```

- [ ] **Step 6: 测试并提交**

Run: `cd apps/server && npx vitest run src/modules/featured-sets/featured-delivery.service.test.ts src/modules/featured-sets/student-featured-sets.controller.test.ts src/database/repositories/special-practice-sessions.repo.test.ts`

Expected: PASS。

```bash
git add apps/server/src/modules/featured-sets apps/server/src/database/repositories/special-practice-sessions.repo.ts apps/server/src/database/repositories/special-practice-sessions.repo.test.ts
git commit -m "feat(featured): deliver sets and create featured runs"
```

---

### Task 7: 服务端强制“记历史但不发积分”

**Files:**
- Modify: `apps/server/src/database/repositories/special-practice-sessions.repo.ts`
- Modify: `apps/server/src/database/repositories/special-practice-sessions.repo.test.ts`
- Modify: `apps/server/src/modules/training/training.service.ts`
- Modify: `apps/server/src/modules/training/training.service.test.ts`

**Interfaces:**
- Produces: `SpecialPracticeSessionsRepository.isFeaturedSession(sessionUid, studentId): Promise<boolean>`
- Consumes: `sessionUid` created by Task 6.

- [ ] **Step 1: 写服务端压制失败测试**

```ts
it('featured session 即使客户端传 false，也强制 suppressErrorFixPoints=true', async () => {
  deps.specialSessionsRepo.isFeaturedSession.mockResolvedValue(true);
  deps.judgeCore.judgeQuestion.mockResolvedValue({ questionId: 10, isCorrect: true, method: 'exact', pointsAwarded: 0 });

  await mkSvc(deps).judgeTraining({
    studentId: 7, questionId: 10, subjectId: 1, studentAnswer: 'A',
    source: 'targeted', sessionUid: 'featured-uid',
    suppressErrorFixPoints: false,
  });

  expect(deps.judgeCore.judgeQuestion).toHaveBeenCalledWith(
    expect.objectContaining({ suppressErrorFixPoints: true }),
  );
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/training/training.service.test.ts -t "featured session"`

Expected: FAIL。

- [ ] **Step 3: 实现 featured session 检测**

```ts
async isFeaturedSession(sessionUid: string, studentId: number): Promise<boolean> {
  const [rows] = await this.pool.execute<RowDataPacket[]>(
    `SELECT featured_publication_id
       FROM special_practice_sessions
      WHERE session_uid = ? AND student_id = ?`,
    [sessionUid, studentId],
  );
  return rows[0]?.featured_publication_id != null;
}
```

- [ ] **Step 4: 在 TrainingService.judgeTraining 中强制覆盖**

```ts
const featured = input.sessionUid
  ? await this.specialSessionsRepo?.isFeaturedSession(input.sessionUid, input.studentId)
  : false;
const suppressErrorFixPoints = input.suppressErrorFixPoints === true || featured === true;
```

把该值传给 `judgeCore.judgeQuestion`。普通 targeted/error_practice 行为保持不变。

- [ ] **Step 5: 补自评与积分表测试**

```ts
it('featured objective correct：不写 point_ledger，仍清零错题', async () => {
  deps.specialSessionsRepo.isFeaturedSession.mockResolvedValue(true);
  deps.judgeCore.judgeQuestion.mockImplementation(async (input) => ({
    questionId: 10,
    isCorrect: true,
    method: 'exact',
    pointsAwarded: input.suppressErrorFixPoints ? 0 : 8,
  }));

  const out = await mkSvc(deps).judgeTraining({
    studentId: 7, questionId: 10, subjectId: 1, studentAnswer: 'A',
    source: 'targeted', sessionUid: 'featured-uid',
  });

  expect(out.pointsAwarded).toBe(0);
  expect(deps.judgeCore.judgeQuestion).toHaveBeenCalledWith(
    expect.objectContaining({ suppressErrorFixPoints: true }),
  );
});

it('featured self-assess correct：不进入 recordSelfAssessment 发奖励分支', async () => {
  deps.questionsRepo.findById.mockResolvedValue(questionRow({ id: 10, answer: '答案' }));
  deps.settlement.confirmSelfAssessment.mockResolvedValue({ errorBookId: undefined });
  await mkSvc(deps).selfAssess({
    studentId: 7, questionId: 10, subjectId: 1,
    assessment: 'correct', source: 'targeted', sessionUid: 'featured-uid',
  });
  expect(deps.settlement.confirmSelfAssessment).toHaveBeenCalledWith(
    expect.objectContaining({ sessionUid: 'featured-uid', source: 'targeted' }),
  );
  expect(deps.judgeCore.recordSelfAssessment).not.toHaveBeenCalled();
});

it('featured answer：创建 special_practice_sessions/records，不创建 training_sessions', async () => {
  deps.specialSessionsRepo.isFeaturedSession.mockResolvedValue(true);
  deps.judgeCore.judgeQuestion.mockResolvedValue({
    questionId: 10, isCorrect: true, method: 'exact', pointsAwarded: 0,
  });
  deps.specialSessionsRepo.upsertSession.mockResolvedValue(101);
  deps.specialAnswersRepo.upsertAnswer.mockResolvedValue(undefined);
  await mkSvc(deps).judgeTraining({
    studentId: 7, questionId: 10, subjectId: 1, studentAnswer: 'A',
    source: 'targeted', sessionUid: 'featured-uid', questionOrder: 1,
  });
  expect(deps.specialSessionsRepo.upsertSession).toHaveBeenCalled();
  expect(deps.specialAnswersRepo.upsertAnswer).toHaveBeenCalled();
  expect(deps.trainingSessionsRepo.create).not.toHaveBeenCalled();
});
```

- [ ] **Step 6: 测试并提交**

Run: `cd apps/server && npx vitest run src/modules/training/training.service.test.ts src/database/repositories/special-practice-sessions.repo.test.ts`

Expected: PASS。

```bash
git add apps/server/src/modules/training/training.service.ts apps/server/src/modules/training/training.service.test.ts apps/server/src/database/repositories/special-practice-sessions.repo.ts apps/server/src/database/repositories/special-practice-sessions.repo.test.ts
git commit -m "fix(featured): enforce no points in featured sessions"
```

---

### Task 8: 教研删卷影响面纳入精选题单

**Files:**
- Modify: `apps/server/src/database/repositories/research-papers.repo.ts`
- Modify: `apps/server/src/database/repositories/research-papers.repo.test.ts`

**Interfaces:**
- Produces: 删卷 `BLOCKING_TABLES` 从 7 张变为 8 张。

- [ ] **Step 1: 写失败测试**

```ts
it('被引用检测覆盖 8 张 RESTRICT 表，包含 featured_question_set_items', async () => {
  await repo.countImpact(1);
  const unionSql = pool.execute.mock.calls
    .map((c) => String(c[0]))
    .find((sql) => sql.includes('SELECT DISTINCT qid FROM'))!;
  expect(unionSql).toContain('featured_question_set_items');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/database/repositories/research-papers.repo.test.ts`

Expected: FAIL。

- [ ] **Step 3: 修改阻断表**

```ts
const BLOCKING_TABLES = [
  'main_error_books',
  'aux_error_books',
  'answers',
  'exam_answers',
  'variation_questions',
  'special_answer_records',
  'remediation_set_items',
  'featured_question_set_items',
] as const;
```

把测试标题、API 文档和数据库文档里的“7 张”改为“8 张”。

- [ ] **Step 4: 测试并提交**

Run: `cd apps/server && npx vitest run src/database/repositories/research-papers.repo.test.ts`

Expected: PASS。

```bash
git add apps/server/src/database/repositories/research-papers.repo.ts apps/server/src/database/repositories/research-papers.repo.test.ts
git commit -m "fix(research): retain questions used by featured sets"
```

---

### Task 9: 前端 API 与推荐按钮

**Files:**
- Modify: `apps/web/src/services/api.ts`
- Create: `apps/web/src/components/business/RecommendFeaturedSetButton.tsx`
- Create: `apps/web/src/components/business/RecommendFeaturedSetButton.test.tsx`
- Modify: `apps/web/src/pages/student/training/ErrorPracticePage.tsx`
- Modify: `apps/web/src/pages/student/training/ErrorPracticePage.test.tsx`

**Interfaces:**
- Produces API functions:

```ts
export interface FeaturedSetListItem { publicationId: number; setId: number; title: string; subjectId: number; subjectName: string; questionCount: number; publishedAt: string; isRead: boolean; }
export interface FeaturedSetPage { items: FeaturedSetListItem[]; page: number; pageSize: number; total: number; }
export interface FeaturedUnreadSummary { count: number; latest: { publicationId: number; title: string } | null; }
export interface FeaturedRunPayload { mode: 'featured'; sessionUid: string; subjectId: number; title: string; questions: TargetedPracticeQuestion[]; }
export interface ResearchFeaturedSetItem { setId: number; subjectId: number; subjectName: string; questionCount: number; recommendationCount: number; gradeDistribution: Array<{ gradeCode: string; count: number }>; reviewStatus: 'pending' | 'approved' | 'rejected'; createdAt: string; }
export interface ResearchFeaturedSetDetail extends ResearchFeaturedSetItem { questions: Array<{ questionId: number; text: string; type: string; answer: string; explanation: string | null; }>; publications: Array<{ publicationId: number; gradeCode: string; title: string; reachCount: number; status: 'published' | 'withdrawn'; publishedAt: string; }>; }

export function recommendFeaturedSet(questionIds: number[]): Promise<{ setId: number; alreadyRecommended: boolean }>;
export function listFeaturedSets(page = 1): Promise<FeaturedSetPage>;
export function getFeaturedUnreadSummary(): Promise<FeaturedUnreadSummary>;
export function openFeaturedSet(publicationId: number): Promise<FeaturedRunPayload>;
export function listResearchFeaturedSets(status: string, page: number): Promise<{ items: ResearchFeaturedSetItem[]; total: number; page: number; pageSize: number }>;
export function getResearchFeaturedSet(id: number): Promise<ResearchFeaturedSetDetail>;
export function getResearchFeaturedPendingCount(): Promise<{ count: number }>;
export function publishFeaturedSet(id: number, input: { title: string; gradeCode: string }): Promise<{ publicationId: number }>;
export function rejectFeaturedSet(id: number): Promise<null>;
export function reopenFeaturedSet(id: number): Promise<null>;
export function withdrawFeaturedPublication(id: number): Promise<null>;
```

- [ ] **Step 1: 写按钮失败测试**

```tsx
it('点击推荐后变为已推荐，且不会重复提交', async () => {
  recommendFeaturedSetMock.mockResolvedValue({ setId: 3, alreadyRecommended: false });
  render(<RecommendFeaturedSetButton questionIds={[1, 2]} />);
  fireEvent.click(screen.getByRole('button', { name: '推荐这套题' }));
  expect(await screen.findByRole('button', { name: '已推荐' })).toBeDisabled();
  expect(recommendFeaturedSetMock).toHaveBeenCalledWith([1, 2]);
});
```

- [ ] **Step 2: 实现按钮**

```tsx
export default function RecommendFeaturedSetButton({
  questionIds,
  disabledReason,
}: { questionIds: number[]; disabledReason?: string }) {
  const [state, setState] = useState<'idle' | 'sending' | 'done'>('idle');
  if (disabledReason) return <Button disabled>{disabledReason}</Button>;
  async function submit() {
    if (state !== 'idle') return;
    setState('sending');
    try {
      await recommendFeaturedSet(questionIds);
      setState('done');
      toast('success', '已推荐给教研员');
    } catch (err) {
      setState('idle');
      toast('error', err instanceof Error ? err.message : '推荐失败');
    }
  }
  return <Button onClick={submit} disabled={state !== 'idle'}>{state === 'done' ? '已推荐' : '推荐这套题'}</Button>;
}
```

- [ ] **Step 3: 接入错题本单题**

在 `ErrorPracticePage` 行内按钮区加入：

```tsx
<RecommendFeaturedSetButton
  questionIds={entry.questionId == null ? [] : [entry.questionId]}
  disabledReason={
    entry.questionId == null ? '该题暂不支持推荐'
      : entry.source === 'freeform' ? '做题题暂不支持推荐'
      : !entry.answerable ? '暂无标准答案'
      : undefined
  }
/>
```

按钮的点击处理必须 `stopPropagation()`，不得触发行勾选。

- [ ] **Step 4: 测试并提交**

Run: `cd apps/web && npx vitest run src/components/business/RecommendFeaturedSetButton.test.tsx src/pages/student/training/ErrorPracticePage.test.tsx`

Expected: PASS。

```bash
git add apps/web/src/services/api.ts apps/web/src/components/business/RecommendFeaturedSetButton.tsx apps/web/src/components/business/RecommendFeaturedSetButton.test.tsx apps/web/src/pages/student/training/ErrorPracticePage.tsx apps/web/src/pages/student/training/ErrorPracticePage.test.tsx
git commit -m "feat(featured): expose student recommendations"
```

---

### Task 10: 运行器 featured 模式与交接体

**Files:**
- Modify: `apps/web/src/pages/student/training/run-handoff.ts`
- Modify: `apps/web/src/pages/student/training/TargetedRunPage.tsx`
- Modify: `apps/web/src/pages/student/training/TargetedRunPage.test.tsx`

**Interfaces:**
- Consumes: `FeaturedRunPayload` from Task 9.
- Produces: `mode='featured'` with server `sessionUid`.

- [ ] **Step 1: 写交接体失败测试**

```ts
it('featured 缺 sessionUid 时视为非法', () => {
  expect(parseRunHandoff(JSON.stringify({
    sessionId: null, questions: [], title: '精选', mode: 'featured',
  }))).toBeNull();
});

it('featured 带 sessionUid 时保留服务端 uid', () => {
  expect(parseRunHandoff(JSON.stringify({
    sessionId: null, questions: [], title: '精选', mode: 'featured', sessionUid: 'u-1',
  }))).toMatchObject({ mode: 'featured', sessionUid: 'u-1' });
});
```

- [ ] **Step 2: 扩交接体**

```ts
mode?: 'similar' | 'redo' | 'featured';
sessionUid?: string;
```

解析顺序：先校验 mode 白名单，再要求 `mode==='featured'` 时 `sessionUid` 是非空字符串；不满足返回 `null`。

- [ ] **Step 3: 运行页使用服务端 sessionUid**

```ts
const [sessionUid, setSessionUid] = useState(() => newSessionUid());

useEffect(() => {
  const handoff = parseRunHandoff<TargetedPracticeQuestion>(raw);
  if (handoff?.sessionUid) setSessionUid(handoff.sessionUid);
  // ...
}, []);
```

`featured` 不得重新生成 UUID。

- [ ] **Step 4: 写不发分与返回路径测试**

```tsx
it('featured 完成后只调 completeSpecialSession，不调积分完成', async () => {
  // completeTrainingSession mock 不应被调用
  // completeSpecialSession 应收到服务端 uid
});

it('featured 结果页不渲染积分反馈', async () => {
  expect(screen.queryByTestId('celebration-overlay')).toBeNull();
});
```

- [ ] **Step 5: 修改 submit/selfAssess/finish**

```ts
...(mode === 'redo'
  ? { suppressErrorFixPoints: true }
  : {
      sessionUid,
      title: runTitle ?? `${subjectName(subjectId)}专项练习`,
      questionCount: questions.length,
      plannedQuestionIds: (entries ?? []).map((e) => e.questionId),
      ...(mode === 'featured' ? { suppressErrorFixPoints: true } : {}),
    }),
```

自评同样在 featured 时传 `suppressErrorFixPoints: true`，但仍依赖服务端 session 做最终保证。

`handleFinish` 中 featured 与 similar 一样调用 `completeSpecialSession(sessionUid)`；`sessionId=null` 让积分 hook 自动跳过。

- [ ] **Step 6: 接入结果页推荐按钮**

在 `TargetedRunPage` 的 `AnswerResultList.headerExtra` 中加入：

```tsx
<RecommendFeaturedSetButton
  questionIds={(entries ?? []).map((q) => q.questionId)}
/>
```

正常专项、featured、redo 结果页都可推荐；推荐的是当前结果页里的实际题目集合。

- [ ] **Step 7: 测试并提交**

Run: `cd apps/web && npx vitest run src/pages/student/training/TargetedRunPage.test.tsx`

Expected: PASS。

```bash
git add apps/web/src/pages/student/training/run-handoff.ts apps/web/src/pages/student/training/TargetedRunPage.tsx apps/web/src/pages/student/training/TargetedRunPage.test.tsx
git commit -m "feat(featured): run curated sets without points"
```

---

### Task 11: 精选题单独立 Tab 与训练 Banner 直达

**Files:**
- Create: `apps/web/src/components/business/FeaturedSetsCard.tsx`
- Create: `apps/web/src/components/business/FeaturedSetsCard.test.tsx`
- Create: `apps/web/src/pages/student/FeaturedSetsPage.tsx`
- Modify: `apps/web/src/pages/student/ProfilePage.tsx`
- Modify: `apps/web/src/pages/student/ProfilePage.test.tsx`
- Modify: `apps/web/src/components/layout/StudentStayLayout.tsx`
- Modify: `apps/web/src/pages/student/training/TrainingHomePage.tsx`
- Modify: `apps/web/src/pages/student/training/TrainingHomePage.test.tsx`
- Modify: `apps/web/src/routes/routeTable.tsx`

**Interfaces:**
- Consumes: `listFeaturedSets`, `openFeaturedSet`, `getFeaturedUnreadSummary`.
- Produces: `FeaturedSetsCard` with pagination and open/dispatch.

- [ ] **Step 1: 写精选题单 Tab 失败测试**

```tsx
it('渲染未读精选题，点击开题后写入 featured 交接体并跳运行页', async () => {
  listFeaturedSetsMock.mockResolvedValue({
    items: [{ publicationId: 12, setId: 7, title: '七年级数学精选', subjectId: 1,
      subjectName: '数学', questionCount: 5, publishedAt: '2026-11-28T00:00:00Z', isRead: false }],
    page: 1, pageSize: 20, total: 1,
  });
  openFeaturedSetMock.mockResolvedValue({
    mode: 'featured', sessionUid: 'u-1', subjectId: 1, title: '七年级数学精选',
    questions: [{ questionId: 1, text: '题', type: 'choice', options: null,
      materialText: null, materialUrl: null }],
  });

  const { router } = renderCard();
  fireEvent.click(await screen.findByRole('button', { name: /七年级数学精选/ }));

  await waitFor(() => expect(router.state.location.pathname).toBe('/student/training/targeted/run'));
  expect(JSON.parse(sessionStorage.getItem('training:targeted')!)).toMatchObject({
    mode: 'featured', sessionId: null, sessionUid: 'u-1',
  });
});
```

- [ ] **Step 2: 实现 FeaturedSetsCard**

组件责任：

- 挂载时并行查 `listFeaturedSets(page)` 与 `getFeaturedUnreadSummary()`；翻页只重拉列表，未读总数不随页变化；
- 空态显示「暂无精选题单」；
- 分页固定 20；
- 未读总数显示在卡片标题旁，未读行显示线性 SVG 圆点或 `新` 标签；
- 点击时禁用该行，调 `openFeaturedSet`；
- 成功后写 `sessionStorage['training:targeted']`：

```ts
sessionStorage.setItem('training:targeted', JSON.stringify({
  sessionId: null,
  sessionUid: payload.sessionUid,
  questions: payload.questions,
  title: payload.title,
  mode: 'featured',
}));
navigate(`/student/training/targeted/run?subjectId=${payload.subjectId}&returnTo=${encodeURIComponent('/student/featured-sets')}`);
```

- [ ] **Step 3: 新增 `/student/featured-sets` 浅停留 Tab**

```tsx
// StudentStayLayout
{ to: '/student/featured-sets', label: '精选题单' }
```

个人中心移除 `FeaturedSetsCard`；精选题单列表只在独立 Tab 展示。

- [ ] **Step 4: 写训练 Banner 失败测试**

```tsx
it('有未读精选题时显示 Banner，点击直接打开最新一条并进入作答页', async () => {
  getFeaturedUnreadSummaryMock.mockResolvedValue({ count: 2, latest: { publicationId: 1, title: '七年级数学精选' } });
  const { router } = await renderSettled();
  expect(screen.getByText(/2 个新精选题单/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '查看' }));
  await waitFor(() => expect(router.state.location.pathname).toBe('/student/training/targeted/run'));
});
```

- [ ] **Step 5: 实现 Banner**

- 调 `getFeaturedUnreadSummary()`；
- `count=0` 或请求失败时静默；
- 放在相似题待办 Banner 之后；
- 点击「查看」调 `openFeaturedSet(latest.publicationId)`，写交接体并进入作答器；
- 挂载和 `window.focus` 时刷新；
- 关闭只设当前页面 state。

文案固定：

```text
有 {count} 个新精选题单
最新：{latest.title}
```

- [ ] **Step 6: 测试并提交**

Run: `cd apps/web && npx vitest run src/components/business/FeaturedSetsCard.test.tsx src/pages/student/ProfilePage.test.tsx src/pages/student/training/TrainingHomePage.test.tsx`

Expected: PASS。

```bash
git add apps/web/src/components/business/FeaturedSetsCard.tsx apps/web/src/components/business/FeaturedSetsCard.test.tsx apps/web/src/pages/student/ProfilePage.tsx apps/web/src/pages/student/ProfilePage.test.tsx apps/web/src/pages/student/training/TrainingHomePage.tsx apps/web/src/pages/student/training/TrainingHomePage.test.tsx
git commit -m "feat(featured): add curated sets tab and direct-open banner"
```

---

### Task 12: 教研精选题单页面、路由与角标

**Files:**
- Create: `apps/web/src/pages/research/ResearchFeaturedSetsPage.tsx`
- Create: `apps/web/src/pages/research/__tests__/ResearchFeaturedSetsPage.test.tsx`
- Modify: `apps/web/src/components/layout/ResearchNav.tsx`
- Modify: `apps/web/src/routes/routeTable.tsx`
- Modify: `apps/web/src/routes/routeTable.test.tsx`

**Interfaces:**
- Consumes: Task 9 research API functions.
- Produces: `/research/featured-sets` 页面和侧栏 pending 角标。

- [ ] **Step 1: 写页面失败测试**

```tsx
it('待审核列表显示题数、推荐人数和年级分布', async () => {
  listResearchFeaturedSetsMock.mockResolvedValue({
    items: [{ setId: 7, subjectId: 1, subjectName: '数学', questionCount: 5,
      recommendationCount: 3,
      gradeDistribution: [{ gradeCode: 'grade_7', count: 2 }, { gradeCode: 'grade_8', count: 1 }],
      reviewStatus: 'pending', createdAt: '2026-11-28T10:00:00Z' }],
    page: 1, pageSize: 20, total: 1,
  });
  renderAt('/research/featured-sets');
  expect(await screen.findByText('数学')).toBeInTheDocument();
  expect(screen.getByText('5 题')).toBeInTheDocument();
  expect(screen.getByText('3 人推荐')).toBeInTheDocument();
  expect(screen.getByText('初一 2 · 初二 1')).toBeInTheDocument();
});
```

- [ ] **Step 2: 实现 tabs 与详情抽屉**

页面固定三个 Tab：

```ts
const TABS = [
  { key: 'pending', label: '待审核' },
  { key: 'approved', label: '已发布' },
  { key: 'rejected', label: '已拒绝' },
] as const;
```

点击行调用 `getResearchFeaturedSet(setId)`，抽屉展示题目和 publication。题目正文使用共享 `markdownComponents` / `preprocessMarkdown`，不得另建 Markdown 管线。

- [ ] **Step 3: 实现发布弹窗**

输入：

```ts
{ title: string; gradeCode: string }
```

年级下拉来自 `GRADE_LIST`，提交调用 `publishFeaturedSet`。成功后关闭弹窗、保持当前 Tab、刷新列表和 pending count。标题空或超 60 字不发请求。

- [ ] **Step 4: 实现拒绝、重新审核、撤回**

- 拒绝：`ConfirmDialog` 后调 `rejectFeaturedSet`；
- 重新审核：只对 rejected 行显示，调 `reopenFeaturedSet`；
- 撤回：只对 published publication 显示，调 `withdrawFeaturedPublication`；
- 所有操作防止连点，错误用 `toast('error', ...)`。

- [ ] **Step 5: 实现 ResearchNav 角标**

```tsx
const [pending, setPending] = useState(0);
useEffect(() => {
  const load = () => getResearchFeaturedPendingCount()
    .then((r) => setPending(r.count))
    .catch(() => {});
  load();
  window.addEventListener('focus', load);
  return () => window.removeEventListener('focus', load);
}, []);
```

navItems 增加「精选题单」，显示 `pending > 99 ? '99+' : pending`。

- [ ] **Step 6: 加路由与路由测试**

```tsx
{ path: 'featured-sets', element: <ResearchFeaturedSetsPage /> }
```

`routeTable.test.tsx` 使用 researcher 登录态访问 `/research/featured-sets`，断言真实页面而不是占位或 404。

- [ ] **Step 7: 测试并提交**

Run: `cd apps/web && npx vitest run src/pages/research/__tests__/ResearchFeaturedSetsPage.test.tsx src/routes/routeTable.test.tsx`

Expected: PASS。

```bash
git add apps/web/src/pages/research/ResearchFeaturedSetsPage.tsx apps/web/src/pages/research/__tests__/ResearchFeaturedSetsPage.test.tsx apps/web/src/components/layout/ResearchNav.tsx apps/web/src/routes/routeTable.tsx apps/web/src/routes/routeTable.test.tsx
git commit -m "feat(featured): add research review workspace"
```

---

### Task 13: 文档、OpenAPI、度量查询与最终验收

**Files:**
- Create: `tools/db/featured_question_set_metrics.sql`
- Modify: `docs/K12智学系统-产品需求文档.md`
- Modify: `docs/API接口与数据流设计文档.md`
- Modify: `docs/api/openapi.yaml`
- Modify: `docs/K12智学系统-数据库设计文档.md`
- Modify: `docs/UX-UI设计文档.md`
- Modify: `docs/constraints/专项子系统.md`

**Interfaces:**
- Consumes all previous tasks.
- Produces the 14-day product metrics query.

- [ ] **Step 1: 写度量 SQL**

```sql
SET @window_start = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 14 DAY);

SELECT
  (SELECT COUNT(DISTINCT student_id)
     FROM featured_question_set_recommendations
    WHERE created_at >= @window_start) AS recommending_students,
  (SELECT COALESCE(SUM(reach_count), 0)
     FROM featured_question_set_publications
    WHERE published_at >= @window_start) AS reach_count,
  (SELECT COUNT(*)
     FROM (
       SELECT publication_id, student_id
       FROM featured_question_set_reads
       WHERE read_at >= @window_start
       GROUP BY publication_id, student_id
     ) t) AS opened_count,
  (SELECT COUNT(*)
     FROM (
       SELECT featured_publication_id, student_id
       FROM special_practice_sessions
       WHERE featured_publication_id IS NOT NULL
         AND completed_at IS NOT NULL
         AND started_at >= @window_start
       GROUP BY featured_publication_id, student_id
     ) t) AS completed_count;
```

- [ ] **Step 2: 同步产品文档**

PRD 新增精选题单章节，内容固定包含：

- 学生只推荐已做过的在架题；
- 教研员按单一年级发布；
- 「精选题单」浅停留 Tab 是完整列表，训练首页只有可直达作答的未读 Banner；
- 记录练习历史，不发积分；
- PRD §11 冲突修订为“学习明细仅家长可见；教研员可看推荐票的年级聚合，不可反查到个人”。

- [ ] **Step 3: 同步 API 文档与 OpenAPI**

API 文档必须列出 11 个端点，并补：

```text
open/publish/reject/reopen/withdraw = HTTP 200
recommend = HTTP 201
1008 = 请求过于频繁（含精选题每日新题集上限）
```

OpenAPI 必须同步：

- `StudentFeaturedSetListResponse`
- `StudentFeaturedSetUnreadSummary`
- `StudentFeaturedSetOpenResponse`
- `ResearchFeaturedSetListItem`
- `ResearchFeaturedSetDetail`
- `FeaturedSetPublication`
- `PublishFeaturedSetRequest`

- [ ] **Step 4: 同步数据库、UX 与约束文档**

- DB 文档新增 5 张表和增量列，删卷引用从 7 张改 8 张。
- UX 文档新增「精选题单」浅停留 Tab、训练 Banner 直达、教研审核页。
- `专项子系统.md` 记录：featured 无 `training_sessions`、无 `point_ledger`、`error_fix` 服务端压制、历史照常写。

- [ ] **Step 5: 全量验证**

Run:

```bash
cd apps/server && npm test
cd apps/server && npx vitest run src/modules/billing/subscription.guard.test.ts src/database/repositories/parent-analytics.privacy-guard.test.ts
cd apps/server && npm run build
cd apps/web && npm test
cd apps/web && npm run lint
cd apps/web && npm run build
```

Expected: 全部 PASS。

- [ ] **Step 6: 手工冒烟**

执行一条链路：

1. 学生完成 3 题专项；
2. 点「推荐这套题」；
3. 教研员看到 1 人推荐和年级分布；
4. 填写该年级标题并发布；
5. 学生「精选题单」Tab 看到未读精选题；
6. 训练首页看到 Banner，点「查看」直接进入作答器；
7. 打开精选题，完成题单；
8. 结果页无积分元素；
9. 练习记录可回看；
10. 答错题进入错题本；
11. 数据库无对应 `training_sessions` / `point_ledger`；
12. 教研员撤回后新用户列表不可见。

- [ ] **Step 7: 提交**

```bash
git add tools/db/featured_question_set_metrics.sql docs/K12智学系统-产品需求文档.md docs/API接口与数据流设计文档.md docs/api/openapi.yaml docs/K12智学系统-数据库设计文档.md docs/UX-UI设计文档.md docs/constraints/专项子系统.md
git commit -m "docs(featured): document curated set delivery"
```
