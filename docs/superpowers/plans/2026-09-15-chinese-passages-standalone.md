# 语文古诗文专项「独立化」改造 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把语文古诗文默写从 `questions` 体系里摘出来——`dictation_passages` 改名 `chinese_passages`、摘除 `question_id`、判题不再写错题本，**行为对用户完全不变**。

**Architecture:** 只动存储与内部标识，不动产品行为。表本身成为篇目的完整边界（无外键）；`questions` 上那 50 行 `poem_dictation` 与 `main_error_books(source='dictation')` 一并删除。对外 API 只把 `questionId` 改名为 `passageId`，端点、响应结构、判题口径全部保持。

**Tech Stack:** MySQL 9.7.1 / NestJS + TypeScript ESM / Vitest / Python 3 + pytest（data-refinery）

**上游设计：** `docs/superpowers/specs/2026-09-15-chinese-interpretation-special-design.md` §1.1 / §2 / §6 / §9

**本次不做（另案）：** 古诗文**解释**专项（`interpretation_cli.py`、`key_terms`/`sentences`/`full_translation` 三列、LLM 判题 capability、前端三页）。本计划**不加这三列**——表先归位，列随后加。

---

## 现状（改造前，已实测确认）

| 事实 | 证据 |
|---|---|
| 库中 50 行 `questions(type='poem_dictation')` + 50 行 `dictation_passages` | `SELECT COUNT(*)` 实测 |
| `main_error_books(source='dictation')` 有 7 行 | 实测 |
| `main_error_books.question_id` 是 `ON DELETE RESTRICT` | `schema.sql:556` —— **必须先行删除**，否则删 questions 被拦 |
| **删 questions 的安全性由数据决定，不只由 schema 决定** | 引用 `questions(id)` 的外键分三类：**CASCADE**（`question_hints` `:295` / `student_hidden_questions` `:578` / `question_self_assessments` `:622` / `paper_questions` / `question_knowledge_points`，跟着自动清）；**RESTRICT**（`main_error_books` / `answers` / `aux_error_books` / `exam_answers` / `variation_questions`，**有行就整个脚本中断**）；**SET NULL**（`practice_results` / `ai_dialogues`，有行则静默置空）。实测（2026-09-15）：对这 50 行**全部 0 行**（见 Task 9 Step 2 的前置检查） |
| 运行时**从不读** `questions.answer` | `training.service.ts` 全部走 `dictationRepo`；`poem_dictation` 不在 `TARGETED_TYPES` 白名单、不进试卷 |

**结论**：`questions` 行对本专项只剩「身份锚点」作用，而锚点服务的三件事（错题本 / 不再展示 / 提示缓存）已由 2026-09-15 裁决全部去掉。

---

## 文件结构

**新建**
- `tools/db/migrations/2026-09-15_chinese_passages.sql` —— 迁移（改名 / 删列 / 清存量 / 加 is_active）
- `apps/server/src/database/repositories/chinese-passages.repo.ts` —— 篇目 repo（取代 `dictation-passages.repo.ts`）
- `apps/server/src/database/repositories/chinese-passages.repo.test.ts` —— 上述的测试（取代旧测试）

**修改**
- `tools/db/schema.sql` —— 折回 `chinese_passages` 建表
- `apps/server/src/database/repositories/index.ts` —— 导出改名
- `apps/server/src/modules/practice/judge-core.service.ts` —— `judgeDictation` 去 questions 与错题本
- `apps/server/src/modules/training/training.service.ts` —— 字段改名 + 题面由篇名生成
- `apps/server/src/modules/training/training.controller.ts` —— 字段改名 + 校验
- `apps/server/src/modules/training/dto/dictation.dto.ts` —— 字段改名
- `apps/server/src/modules/training/training.module.ts` —— provider 改名
- `apps/server/src/scripts/seed-dictation-fixture.ts` —— 不再写 questions
- `tools/data-refinery/src/dictation_loader.py` —— 不再写 questions
- `tools/data-refinery/src/dictation_cli.py` —— 入库统计输出
- `apps/web/src/services/api.ts` + `DictationConfigPage.tsx` + `DictationRunPage.tsx` —— 字段改名

**删除**
- `apps/server/src/database/repositories/dictation-passages.repo.ts`（及其 `.test.ts`）

---

## Task 1: 迁移脚本 + schema.sql 折回

**Files:**
- Create: `tools/db/migrations/2026-09-15_chinese_passages.sql`
- Modify: `tools/db/schema.sql:300-322`（原 `dictation_passages` 建表段）

> ⚠️ 本任务**只编写、不执行**。执行放在 Task 9 —— 代码（Task 2–8）与库要一起切换，中间态会让应用读不到表。

- [ ] **Step 1: 写迁移脚本**

创建 `tools/db/migrations/2026-09-15_chinese_passages.sql`：

> **本步已于 2026-09-15 实施完毕**（commit `d91bdd0` → `9a131ca` → `a22495e`）。
> 脚本内容以 **`tools/db/migrations/2026-09-15_chinese_passages.sql` 文件本身为准**，此处不再复制全文
> —— 它在评审后经历过两轮修订（加两道中止闸门、守卫谓词 `= 1` 改正为 `> 0`），
> 计划里留存副本只会制造第二份真相。
>
> 实施过程中改掉的三处，供追溯：
> 1. 新增**闸门 0a/0b**（两表并存 / 挂错 source 的错题行）在**任何删除之前**中止 —— 前者是
>    `install_mysql.sh` 会重放 `schema.sql` 造成的真实风险，会让第 3 步 RENAME 报 1050
>    且重跑不自愈；
> 2. 索引存在性判据 `= 1` → **`> 0`**：`information_schema.STATISTICS` 对索引是**每列一行**，
>    复合索引返回多行（`uniq_dp_work` 2 行、`idx_dp_filter` 3 行），写 `= 1` 会让两个
>    `RENAME INDEX` 静默空转（本仓 `2026-09-13_ensure_uniq_q_content_hash.sql` 记过同一个坑）；
> 3. 用法行补「**不要加 `--force`**」——中止闸门靠报错让 mysql 停下，`--force` 会拆掉它。

- [ ] **Step 2: 折回 schema.sql**

把 `tools/db/schema.sql` 里 `dictation_passages` 那一段（约 300–322 行，从注释 `-- 语文古诗文默写篇目（2026-09-13）` 到 `ENGINE=InnoDB ...;`）整段替换为：

```sql
-- 语文古诗文专项篇目（2026-09-13 建；2026-09-15 独立化——改名自 dictation_passages、
-- 摘除 question_id）。**独立子系统**：不挂 questions、不进错题本、不参与主线清零门禁
-- （PRD §6.3 / §7.4）。**无外键**——本表不指向任何表，也不被任何表指向，表即完整边界。
-- 默写抽题池 = verified = 1 AND memorize_required = 1 AND is_active = 1。
-- 设计见 docs/superpowers/specs/2026-09-15-chinese-interpretation-special-design.md §6
CREATE TABLE IF NOT EXISTS chinese_passages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  work_title VARCHAR(100) NOT NULL,      -- 篇名，如《岳阳楼记》；业务键之一
  author VARCHAR(50) NOT NULL,           -- 作者
  dynasty VARCHAR(20) NOT NULL,          -- 朝代
  body TEXT NOT NULL,                    -- 正文（权威原文，含标点）
  grade_band VARCHAR(20) NOT NULL,       -- 'junior'
  grade VARCHAR(20) DEFAULT NULL,        -- '九年级'
  semester VARCHAR(20) NOT NULL,         -- '上册' / '下册'；业务键之一
  sort_order SMALLINT NOT NULL DEFAULT 0,
  source_ref VARCHAR(200) DEFAULT NULL,  -- 教材来源（书名 + 页码）
  verified TINYINT(1) NOT NULL DEFAULT 0,
  -- 教学上是否要求背诵。与 verified 是**两道正交的闸门**：
  --   verified           = 内容是否已校验（正文准确）—— 内容管线自检通过后置 1
  --   memorize_required  = 教学上是否要求背 —— 由人后续标定
  memorize_required TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,  -- 停用开关（取代原 questions.is_active）
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_chinese_passages_work (work_title, semester),
  KEY idx_chinese_passages_filter (grade_band, semester, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 3: 核对列顺序一致**

迁移路径（老库）的列顺序 = 原顺序去掉 `question_id`、`is_active` 追加在 `memorize_required` 之后：
`id, work_title, author, dynasty, body, grade_band, grade, semester, sort_order, source_ref, verified, memorize_required, is_active, created_at, updated_at`

上面 schema.sql 的书写顺序必须与之一致（新装库与迁移库列序相同，避免日后 `SELECT *` 踩坑）。

- [ ] **Step 4: Commit**

```bash
git add tools/db/migrations/2026-09-15_chinese_passages.sql tools/db/schema.sql
git commit -m "feat(db): chinese_passages 迁移脚本（dictation_passages 改名 + 摘 question_id）"
```

---

## Task 2: 篇目 repo 改名 + 三条查询去 JOIN

**Files:**
- Create: `apps/server/src/database/repositories/chinese-passages.repo.ts`
- Create: `apps/server/src/database/repositories/chinese-passages.repo.test.ts`
- Delete: `apps/server/src/database/repositories/dictation-passages.repo.ts`（及 `.test.ts`）
- Modify: `apps/server/src/database/repositories/index.ts:8-9`

- [ ] **Step 1: 写失败的测试**

创建 `apps/server/src/database/repositories/chinese-passages.repo.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { ChinesePassagesRepository, buildDictationPrompt } from './chinese-passages.repo';

const mockPool = (rows: any[] = []) => ({
  execute: vi.fn().mockResolvedValue([rows, []]),
  query: vi.fn().mockResolvedValue([rows, []]),
});

describe('buildDictationPrompt', () => {
  it('题面由篇名生成，且不含「并写出作者与朝代」这类噪音（写进题面等于泄题）', () => {
    expect(buildDictationPrompt('岳阳楼记')).toBe('请默写《岳阳楼记》');
    expect(buildDictationPrompt('岳阳楼记')).not.toContain('并写出');
  });
});

describe('ChinesePassagesRepository', () => {
  it('findVerifiedForDictation：三道闸门齐备 + 按 sort_order 排序 + 不再 JOIN questions', async () => {
    const pool = mockPool([]);
    const repo = new ChinesePassagesRepository(pool as any);
    await repo.findVerifiedForDictation();
    const [sql] = pool.execute.mock.calls[0];
    expect(sql).toContain('FROM chinese_passages dp');
    // 独立化的核心：表本身就是边界，不得再出现 questions
    expect(sql).not.toContain('questions');
    expect(sql).toContain('dp.verified = 1');
    expect(sql).toContain('dp.memorize_required = 1');
    expect(sql).toContain('dp.is_active = 1');
    expect(sql).toContain('ORDER BY dp.sort_order');
  });

  it('findRandomVerified：带册次过滤与 LIMIT，且抽题池守卫齐全', async () => {
    const pool = mockPool([]);
    const repo = new ChinesePassagesRepository(pool as any);
    await repo.findRandomVerified('上册', 5);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).not.toContain('questions');
    expect(sql).not.toContain('student_hidden_questions');
    expect(sql).toContain('dp.verified = 1');
    expect(sql).toContain('dp.memorize_required = 1');
    expect(sql).toContain('dp.is_active = 1');
    expect(sql).toContain('dp.semester = ?');
    expect(sql).toContain('ORDER BY RAND()');
    expect(sql).toContain('LIMIT ?');
    expect(params).toEqual(['上册', 5]);
  });

  it('findRandomVerified：semester=null 时不含册次过滤，参数只有 count', async () => {
    const pool = mockPool([]);
    const repo = new ChinesePassagesRepository(pool as any);
    await repo.findRandomVerified(null, 5);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).not.toContain('dp.semester = ?');
    expect(params).toEqual([5]);
  });

  it('findRandomVerified：「全部册次」时按篇名去重（MIN(id) 子查询）', async () => {
    // 实测九上/九下有 9 篇重复收录（同一篇两册各印一次，业务键含 semester 故各存一行）：
    // 不过滤册次时同一篇会被抽到两次，故必须按 work_title 去重。
    const pool = mockPool([]);
    const repo = new ChinesePassagesRepository(pool as any);
    await repo.findRandomVerified(null, 5);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain('MIN(dp2.id)');
    expect(sql).toContain('dp2.work_title = dp.work_title');
    // 子查询也必须守抽题池门禁，否则会挑到一个未校验/未标必背的同名行
    expect(sql).toContain('dp2.verified = 1');
    expect(sql).toContain('dp2.memorize_required = 1');
    expect(sql).toContain('dp2.is_active = 1');
  });

  it('findRandomVerified：指定册次时**不**加去重子查询', async () => {
    // 关键：子查询跨册取 MIN(id)，若外层已按册过滤会把该册的行整体排除掉
    // （上册行 id 更小 → 下册行 != 它）。单册内不会同名重复，无需去重。
    const pool = mockPool([]);
    const repo = new ChinesePassagesRepository(pool as any);
    await repo.findRandomVerified('下册', 5);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).not.toContain('MIN(dp2.id)');
  });

  it('findVerifiedByIds：空数组直接返回空，不查库', async () => {
    const pool = mockPool([]);
    const repo = new ChinesePassagesRepository(pool as any);
    const rows = await repo.findVerifiedByIds([]);
    expect(rows).toEqual([]);
    expect(pool.execute).not.toHaveBeenCalled();
  });

  it('findVerifiedByIds：IN 占位符数量与参数顺序正确', async () => {
    const pool = mockPool([]);
    const repo = new ChinesePassagesRepository(pool as any);
    await repo.findVerifiedByIds([10, 11]);
    const [sql, params] = pool.execute.mock.calls[0];
    // 只测空数组短路的话，参数顺序写反也不会被发现
    expect(sql).toContain('dp.id IN (?,?)');
    expect(sql).toContain('dp.memorize_required = 1');
    expect(params).toEqual([10, 11]);
  });

  it('findById：按篇目 id 查单篇（判定路径，不设 verified/is_active 守卫）', async () => {
    const pool = mockPool([]);
    const repo = new ChinesePassagesRepository(pool as any);
    await repo.findById(100);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('WHERE dp.id = ?');
    expect(sql).toContain('LIMIT 1');
    expect(params).toEqual([100]);
  });

  it('upsert：按 (work_title, semester) 业务主键 upsert，verified 由入参决定', async () => {
    const pool = mockPool([]);
    const repo = new ChinesePassagesRepository(pool as any);
    await repo.upsert({
      workTitle: '静夜思', author: '李白', dynasty: '唐',
      body: '床前明月光', gradeBand: 'junior', grade: '九年级', semester: '上册',
      sortOrder: 1, sourceRef: 'DEV-FIXTURE', verified: 0, memorizeRequired: 0,
    });
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('INSERT INTO chinese_passages');
    expect(sql).toContain('ON DUPLICATE KEY UPDATE');
    expect(sql).not.toContain('question_id');
    // 全参断言：若 verified 被写死成 1（覆盖导入器的校验闸门决定），只断 params[0] 不会发现
    expect(params).toEqual(['静夜思', '李白', '唐', '床前明月光', 'junior', '九年级', '上册', 1, 'DEV-FIXTURE', 0, 0]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/database/repositories/chinese-passages.repo.test.ts`
Expected: FAIL —— `Failed to resolve import "./chinese-passages.repo"`

- [ ] **Step 3: 实现 repo**

创建 `apps/server/src/database/repositories/chinese-passages.repo.ts`：

```ts
import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface ChinesePassageRow extends RowDataPacket {
  id: number;
  work_title: string;
  author: string;
  dynasty: string;
  body: string;
  grade_band: string;
  grade: string | null;
  semester: string;
  sort_order: number;
  source_ref: string | null;
  verified: number;
  memorize_required: number;
  is_active: number;
}

export interface ChinesePassageUpsertInput {
  workTitle: string;
  author: string;
  dynasty: string;
  body: string;
  gradeBand: string;
  grade: string | null;
  semester: string;
  sortOrder: number;
  sourceRef: string | null;
  verified: number;
  memorizeRequired: number;
}

const SELECT_COLS = `dp.id, dp.work_title, dp.author, dp.dynasty, dp.body,
  dp.grade_band, dp.grade, dp.semester, dp.sort_order, dp.source_ref, dp.verified,
  dp.memorize_required, dp.is_active`;

/**
 * 题面由篇名生成——**全系统唯一口径**。
 *
 * 题面**不落库**：作者 / 朝代 / 正文才是学生要默写的答案字段，写进题面等于泄题；
 * 而 `questions.content` 那条老路还要为它付 `content_hash` 的代价（正文一改 hash 就变）。
 */
export function buildDictationPrompt(workTitle: string): string {
  return `请默写《${workTitle}》`;
}

/**
 * 语文古诗文专项篇目 repo。
 *
 * **独立子系统**（2026-09-15）：本表不挂 `questions`、无外键，因此三条抽题查询
 * 不再 `JOIN questions`——原先由 `questions` 承担的三件事改由本表承担：
 *   题面 `content` → 由 `work_title` 生成（`buildDictationPrompt`，不落库）
 *   学科 `subject_id = 2` → 表本身就是语文，谓词取消
 *   停用 `is_active` → 本表自己的 `is_active` 列
 * 「不再展示」(`student_hidden_questions`) 与错题本已按设计**整体移除**。
 */
@Injectable()
export class ChinesePassagesRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /** 判定路径按篇目 id 取单篇。**有意不设门禁**——见 spec §6 的守卫适用范围说明。 */
  async findById(passageId: number): Promise<ChinesePassageRow | null> {
    const [rows] = await this.pool.execute<ChinesePassageRow[]>(
      `SELECT ${SELECT_COLS} FROM chinese_passages dp WHERE dp.id = ? LIMIT 1`,
      [passageId],
    );
    return rows[0] ?? null;
  }

  /** 配置页清单：默写专项抽题池（三道闸门） */
  async findVerifiedForDictation(): Promise<ChinesePassageRow[]> {
    const [rows] = await this.pool.execute<ChinesePassageRow[]>(
      `SELECT ${SELECT_COLS} FROM chinese_passages dp
       WHERE dp.verified = 1 AND dp.memorize_required = 1 AND dp.is_active = 1
       ORDER BY dp.sort_order, dp.id`,
    );
    return rows;
  }

  /** 随机抽篇（semester=null 即「全部册次」） */
  async findRandomVerified(semester: string | null, count: number): Promise<ChinesePassageRow[]> {
    const params: unknown[] = [];
    // 抽题池 = 已校验 且 必背：verified 只说内容对，memorize_required 才是教学上要背的。
    let sql = `SELECT ${SELECT_COLS} FROM chinese_passages dp
       WHERE dp.verified = 1 AND dp.memorize_required = 1 AND dp.is_active = 1`;
    if (semester != null) {
      sql += ' AND dp.semester = ?';
      params.push(semester);
    } else {
      // 「全部册次」时按**篇名**去重：实测九上/九下有 9 篇重复收录（两册的第六单元都是
      // 文言文单元，同一篇各印一次，如《出师表》上册第 26 课、下册第 23 课），
      // 业务键含 semester 故会各存一行 → 不过滤册次时同一篇可能被抽到两次。
      // 每个篇名只取一行（最小 id，确定性）。
      // ⚠️ 只在无册次过滤时加：子查询跨册取 MIN(id)，若外层已按册过滤会把该册的行
      // 整体排除掉（上册行 id 更小 → 下册行不等于它）。
      sql += ` AND dp.id = (
        SELECT MIN(dp2.id) FROM chinese_passages dp2
          WHERE dp2.work_title = dp.work_title
            AND dp2.verified = 1 AND dp2.memorize_required = 1 AND dp2.is_active = 1
      )`;
    }
    sql += ' ORDER BY RAND() LIMIT ?';
    params.push(count);
    // LIMIT ? 不能走 prepared statement（mysql2 execute 报 Incorrect arguments），用 query
    const [rows] = await this.pool.query<ChinesePassageRow[]>(sql, params);
    return rows;
  }

  /** 指定篇目出题（按 id 批量取，忽略册次） */
  async findVerifiedByIds(passageIds: number[]): Promise<ChinesePassageRow[]> {
    if (passageIds.length === 0) return [];
    const placeholders = passageIds.map(() => '?').join(',');
    const [rows] = await this.pool.execute<ChinesePassageRow[]>(
      `SELECT ${SELECT_COLS} FROM chinese_passages dp
       WHERE dp.verified = 1 AND dp.memorize_required = 1 AND dp.is_active = 1
         AND dp.id IN (${placeholders})`,
      [...passageIds],
    );
    return rows;
  }

  /**
   * 按 (work_title, semester) 业务主键 upsert：正文修正后重跑仍更新同一行（幂等）。
   *
   * ⚠️ 注意：**这里按入参覆盖 `memorize_required`**（调用方显式给出该值，如后台管理/
   * 开发种子）。内容管线的 loader（`tools/data-refinery/src/dictation_loader.py`）
   * **刻意不在它的冲突分支动这一列**——否则重跑管线会把用户标好的「必背」刷回 0。
   * 两处写法**不一致是有意的**，不要为了「统一」把 loader 也改成覆盖。
   */
  async upsert(row: ChinesePassageUpsertInput): Promise<void> {
    await this.pool.execute(
      `INSERT INTO chinese_passages
         (work_title, author, dynasty, body, grade_band, grade, semester,
          sort_order, source_ref, verified, memorize_required)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         author = VALUES(author), dynasty = VALUES(dynasty),
         body = VALUES(body), grade_band = VALUES(grade_band), grade = VALUES(grade),
         sort_order = VALUES(sort_order), source_ref = VALUES(source_ref), verified = VALUES(verified),
         memorize_required = VALUES(memorize_required)`,
      [
        row.workTitle, row.author, row.dynasty, row.body,
        row.gradeBand, row.grade, row.semester, row.sortOrder, row.sourceRef, row.verified,
        row.memorizeRequired,
      ],
    );
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/database/repositories/chinese-passages.repo.test.ts`
Expected: PASS（10 个）

- [ ] **Step 5: 删旧文件、改导出**

```bash
git rm apps/server/src/database/repositories/dictation-passages.repo.ts \
       apps/server/src/database/repositories/dictation-passages.repo.test.ts
```

修改 `apps/server/src/database/repositories/index.ts`，把第 8–9 行：

```ts
export { DictationPassagesRepository } from './dictation-passages.repo.js';
export type { DictationPassageRow, DictationListRow, DictationUpsertInput } from './dictation-passages.repo.js';
```

改为：

```ts
export { ChinesePassagesRepository, buildDictationPrompt } from './chinese-passages.repo.js';
export type { ChinesePassageRow, ChinesePassageUpsertInput } from './chinese-passages.repo.js';
```

- [ ] **Step 6: Commit**

```bash
git add -A apps/server/src/database/repositories
git commit -m "refactor(db): dictation-passages.repo -> chinese-passages.repo，三条查询去 JOIN questions"
```

---

## Task 3: JudgeCore.judgeDictation 去 questions 与错题本

**Files:**
- Modify: `apps/server/src/modules/practice/judge-core.service.ts:93-108`（类型）、`:220-256`（方法）
- Modify: `apps/server/src/modules/practice/judge-core.dictation.test.ts`（整文件重写）

- [ ] **Step 1: 重写测试**

把 `apps/server/src/modules/practice/judge-core.dictation.test.ts` **整个文件**替换为：

```ts
import { describe, it, expect, vi } from 'vitest';
import { JudgeCoreService } from './judge-core.service';

function makeService() {
  const mainErrorRepo = {
    clearUnclearedByStudentQuestionId: vi.fn().mockResolvedValue(undefined),
    findUnclearedByStudentQuestionId: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(555),
  };
  const service = new JudgeCoreService(
    {} as never, // questionsRepo —— judgeDictation 不再依赖它
    mainErrorRepo as never,
    {} as never, // structuring
    {} as never, // judgment
    { ensureExplanation: vi.fn() } as never,
    {} as never, // selfAssessRepo
  );
  return { service, mainErrorRepo };
}

const EXPECTED = { author: '李白', dynasty: '唐', body: '床前明月光，疑是地上霜。' };

describe('JudgeCoreService.judgeDictation', () => {
  it('三项全对（忽略标点与空格）→ isCorrect=true', async () => {
    const { service } = makeService();
    const res = await service.judgeDictation({
      expected: EXPECTED,
      student: { author: '李白', dynasty: '唐', body: '床前明月光疑是地上霜' },
    });
    expect(res.isCorrect).toBe(true);
    expect(res.fields).toEqual({ author: { match: true }, dynasty: { match: true }, body: { match: true } });
  });

  it('仅正文错一个字 → isCorrect=false，diff 标出该字', async () => {
    const { service } = makeService();
    const res = await service.judgeDictation({
      expected: EXPECTED,
      student: { author: '李白', dynasty: '唐', body: '床前明月先，疑是地上霜。' },
    });
    expect(res.isCorrect).toBe(false);
    expect(res.fields.body.match).toBe(false);
    expect(res.fields.author.match).toBe(true);
    expect(res.bodyDiff).toContainEqual({ type: 'wrong', expected: '光', actual: '先' });
  });

  it('仅朝代错 → isCorrect=false', async () => {
    const { service } = makeService();
    const res = await service.judgeDictation({
      expected: EXPECTED,
      student: { author: '李白', dynasty: '宋', body: EXPECTED.body },
    });
    expect(res.isCorrect).toBe(false);
    expect(res.fields.dynasty.match).toBe(false);
  });

  it('三项全空 → isCorrect=false（不同于客观题的空答案守卫）', async () => {
    const { service } = makeService();
    const res = await service.judgeDictation({
      expected: EXPECTED, student: { author: '', dynasty: '', body: '' },
    });
    expect(res.isCorrect).toBe(false);
  });

  // 独立化的核心断言（2026-09-15）：判题**不写任何学生状态**。
  // 一旦有人把错题本写回判题路径，这条会红——它守的是「古诗文专项不进错题本」这条原则。
  it('无论判对判错，都不碰错题本（不写、不清零）', async () => {
    const { service, mainErrorRepo } = makeService();

    await service.judgeDictation({
      expected: EXPECTED,
      student: { author: '李白', dynasty: '唐', body: '床前明月先，疑是地上霜。' },
    });
    await service.judgeDictation({
      expected: EXPECTED, student: EXPECTED,
    });

    expect(mainErrorRepo.create).not.toHaveBeenCalled();
    expect(mainErrorRepo.clearUnclearedByStudentQuestionId).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/practice/judge-core.dictation.test.ts`
Expected: FAIL —— `mainErrorRepo.create` 被调用过 / `expected` 参数不认识 `studentId` 等

- [ ] **Step 3: 改类型**

`apps/server/src/modules/practice/judge-core.service.ts`，把 `JudgeDictationInput` / `JudgeDictationOutput`（约 93–108 行）改为：

```ts
export interface JudgeDictationInput {
  expected: { author: string; dynasty: string; body: string };
  student: { author: string; dynasty: string; body: string };
}

export interface JudgeDictationOutput {
  isCorrect: boolean;
  method: 'exact';
  fields: { author: { match: boolean }; dynasty: { match: boolean }; body: { match: boolean } };
  bodyDiff: DictationDiffOp[];
}
```

- [ ] **Step 4: 改方法**

同文件，把 `judgeDictation`（约 220–256 行）改为：

```ts
  /**
   * 语文古诗文默写判题：**纯程序化**，不调用任何 LLM，**不写任何学生状态**。
   *
   * 对错完全由「归一化后逐字段全等」决定（三项全对才算对）；正文错处由 LCS 差异定位。
   * 错因文案由调用方（TrainingService）在判题之后单独调 DictationFeedbackCapability，
   * 失败不影响本方法返回值。
   *
   * 2026-09-15 独立化：**不再查 questions、不再写/清错题本**。篇目身份与存在性由调用方
   * （TrainingService，走 ChinesePassagesRepository）负责——本方法现在只做纯函数判题。
   * 错题本的三项机制（重做—清零 / 级别递进 / 错题练习数据源）对篇目级作答都没有落点，
   * 见 docs/superpowers/specs/2026-09-15-chinese-interpretation-special-design.md §2。
   *
   * 不调用 ExplanationCacheService.ensureExplanation：它的「answer >= 100 字直写解析」
   * 规则会让长文言文的解析变成「解析 = 正文」（设计 spec §5 第 6 步）。
   */
  async judgeDictation(input: JudgeDictationInput): Promise<JudgeDictationOutput> {
    // bodyDiff 已回投原文标点，学生看到的是带标点的整句，判对错口径不受影响。
    const { isCorrect, fields, bodyDiff } = evaluateDictation(input.expected, input.student);
    return { isCorrect, method: 'exact', fields, bodyDiff };
  }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/practice/judge-core.dictation.test.ts`
Expected: PASS（5 个）

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/practice/judge-core.service.ts apps/server/src/modules/practice/judge-core.dictation.test.ts
git commit -m "refactor(judging): judgeDictation 去 questions 与错题本写入，退化为纯函数判题"
```

---

## Task 4: TrainingService 字段改名 + 题面由篇名生成

**Files:**
- Modify: `apps/server/src/modules/training/training.service.ts:11`（import）、`:23`（`CHINESE_SUBJECT_ID`）、`:57`（构造参数）、`:95-215`（五个方法）
- Modify: `apps/server/src/modules/training/training.dictation.test.ts`（整文件重写）

- [ ] **Step 1: 重写测试**

把 `apps/server/src/modules/training/training.dictation.test.ts` **整个文件**替换为：

```ts
import { describe, it, expect, vi } from 'vitest';
import { TrainingService, renderBodyDiff } from './training.service';

const PASSAGE = {
  id: 1, work_title: '静夜思', author: '李白', dynasty: '唐',
  body: '床前明月光，疑是地上霜。', grade_band: 'junior', grade: '九年级',
  semester: '上册', sort_order: 1, source_ref: 'DEV-FIXTURE', verified: 1,
  memorize_required: 1, is_active: 1,
};

const WRONG_JUDGE = {
  isCorrect: false, method: 'exact',
  fields: { author: { match: true }, dynasty: { match: true }, body: { match: false } },
  bodyDiff: [{ type: 'wrong', expected: '光', actual: '先' }],
};

function makeService(overrides: { passage?: unknown; judgeResult?: unknown; feedback?: unknown } = {}) {
  const dictationRepo = {
    findById: vi.fn().mockResolvedValue(overrides.passage === undefined ? PASSAGE : overrides.passage),
    findVerifiedForDictation: vi.fn().mockResolvedValue([PASSAGE]),
    findRandomVerified: vi.fn().mockResolvedValue([PASSAGE]),
    findVerifiedByIds: vi.fn().mockResolvedValue([PASSAGE]),
  };
  const judgeCore = { judgeDictation: vi.fn().mockResolvedValue(overrides.judgeResult ?? WRONG_JUDGE) };
  const dictationFeedback = {
    generate: vi.fn().mockImplementation(() => {
      if (overrides.feedback instanceof Error) return Promise.reject(overrides.feedback);
      return Promise.resolve({ content: overrides.feedback ?? '注意「月光」的「光」' });
    }),
  };
  const service = new TrainingService(
    {} as never, judgeCore as never, {} as never, {} as never, {} as never,
    {} as never, {} as never, {} as never, {} as never,
    dictationRepo as never, dictationFeedback as never,
  );
  return { service, dictationRepo, judgeCore, dictationFeedback };
}

describe('renderBodyDiff', () => {
  it('把 diff 渲染成可读文本', () => {
    expect(renderBodyDiff([
      { type: 'equal', text: '床前明月' },
      { type: 'wrong', expected: '光', actual: '先' },
      { type: 'missing', text: '疑' },
      { type: 'extra', text: '啊' },
    ])).toBe('床前明月[光→先][漏:疑][多:啊]');
  });
});

describe('TrainingService.listDictationPassages', () => {
  it('只返回篇名 + 册次，不泄露作者/朝代/正文', async () => {
    const { service } = makeService();
    const res = await service.listDictationPassages();
    expect(res.passages).toEqual([
      { passageId: 1, workTitle: '静夜思', semester: '上册' },
    ]);
    expect(JSON.stringify(res)).not.toContain('床前明月光');
    expect(JSON.stringify(res)).not.toContain('李白');
  });
});

describe('TrainingService.startDictation', () => {
  it('未指定篇目 → 随机抽，题项不含答案字段；题面由篇名生成', async () => {
    const { service, dictationRepo } = makeService();
    const res = await service.startDictation({ semester: '上册', passageIds: null, count: 5 });
    expect(dictationRepo.findRandomVerified).toHaveBeenCalledWith('上册', 5);
    expect(res.questions).toEqual([
      { passageId: 1, prompt: '请默写《静夜思》', workTitle: '静夜思', semester: '上册' },
    ]);
    expect(JSON.stringify(res)).not.toContain('李白');
    expect(JSON.stringify(res)).not.toContain('床前明月光');
  });

  it('指定篇目 → 走 findVerifiedByIds，并按 count 截断', async () => {
    const { service, dictationRepo } = makeService();
    const res = await service.startDictation({ semester: null, passageIds: [1, 2], count: 1 });
    expect(dictationRepo.findVerifiedByIds).toHaveBeenCalledWith([1, 2]);
    expect(res.questions).toHaveLength(1);
  });
});

describe('TrainingService.judgeDictation（判题：纯程序、不等 LLM、不写学生状态）', () => {
  it('判错 → 回判题结果 + feedbackPending=true，且**不调用 LLM**', async () => {
    const { service, dictationFeedback } = makeService();
    const res = await service.judgeDictation({
      passageId: 1, author: '李白', dynasty: '唐', body: '床前明月先，疑是地上霜。',
    });
    expect(res.isCorrect).toBe(false);
    expect(res.feedback).toBeNull();
    expect(res.feedbackPending).toBe(true);
    expect(res.reference).toEqual({ author: '李白', dynasty: '唐', body: '床前明月光，疑是地上霜。' });
    // 解耦的核心断言：判题链路里不能再出现 LLM 调用，否则学生又要等十几秒
    expect(dictationFeedback.generate).not.toHaveBeenCalled();
  });

  it('判对 → feedbackPending=false', async () => {
    const { service, dictationFeedback } = makeService({
      judgeResult: {
        isCorrect: true, method: 'exact',
        fields: { author: { match: true }, dynasty: { match: true }, body: { match: true } },
        bodyDiff: [],
      },
    });
    const res = await service.judgeDictation({
      passageId: 1, author: '李白', dynasty: '唐', body: '床前明月光，疑是地上霜。',
    });
    expect(res.isCorrect).toBe(true);
    expect(res.feedback).toBeNull();
    expect(res.feedbackPending).toBe(false);
    expect(dictationFeedback.generate).not.toHaveBeenCalled();
  });

  // 独立化：判定路径只给「纯函数 + 篇目」两样东西，学生身份不再进入判题
  it('只把 expected/student 交给 judgeCore，不透传学生身份/学科/错题本相关字段', async () => {
    const { service, judgeCore } = makeService();
    await service.judgeDictation({ passageId: 1, author: '李', dynasty: '唐', body: '床' });
    expect(judgeCore.judgeDictation).toHaveBeenCalledWith({
      expected: { author: '李白', dynasty: '唐', body: '床前明月光，疑是地上霜。' },
      student: { author: '李', dynasty: '唐', body: '床' },
    });
  });

  it('篇目不存在 → 404', async () => {
    const { service } = makeService({ passage: null });
    await expect(
      service.judgeDictation({ passageId: 999, author: '', dynasty: '', body: '' }),
    ).rejects.toThrow();
  });
});

describe('TrainingService.generateDictationFeedback（错因：可选、失败降级）', () => {
  it('判错入参 → 返回 LLM 错因', async () => {
    const { service, dictationFeedback } = makeService();
    const res = await service.generateDictationFeedback({
      passageId: 1, author: '李白', dynasty: '唐', body: '床前明月先，疑是地上霜。',
    });
    expect(res.feedback).toBe('注意「月光」的「光」');
    expect(dictationFeedback.generate).toHaveBeenCalledOnce();
  });

  it('喂给模型的差异文本与错处字段一致（服务端自己重算，不依赖判题接口）', async () => {
    const { service, dictationFeedback } = makeService();
    await service.generateDictationFeedback({
      passageId: 1, author: '李白', dynasty: '唐', body: '床前明月先，疑是地上霜。',
    });
    const arg = dictationFeedback.generate.mock.calls[0][0];
    expect(arg.workTitle).toBe('静夜思');
    expect(arg.fieldMatch).toEqual({ author: true, dynasty: true, body: false });
    expect(arg.bodyDiffText).toBe('床前明月[光→先]，疑是地上霜。');
  });

  it('LLM 两个模型都失败 → feedback=null（不抛错，不阻断前端）', async () => {
    const { service } = makeService({ feedback: new Error('all down') });
    const res = await service.generateDictationFeedback({
      passageId: 1, author: '李白', dynasty: '唐', body: '床前明月先，疑是地上霜。',
    });
    expect(res.feedback).toBeNull();
  });

  it('篇目不存在 → 404', async () => {
    const { service } = makeService({ passage: null });
    await expect(
      service.generateDictationFeedback({ passageId: 999, author: '', dynasty: '', body: '' }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/training/training.dictation.test.ts`
Expected: FAIL —— `passageId` 与 `findById` 尚不存在

- [ ] **Step 3: 改 import 与构造参数**

`apps/server/src/modules/training/training.service.ts`：

第 11 行

```ts
import { DictationPassagesRepository } from '../../database/repositories/dictation-passages.repo.js';
```

改为

```ts
import { ChinesePassagesRepository, buildDictationPrompt } from '../../database/repositories/chinese-passages.repo.js';
```

第 23 行 `export const CHINESE_SUBJECT_ID = 2;` —— **整行删除**（独立化后无学科谓词，注释也一并删）。

第 57 行

```ts
    private readonly dictationRepo: DictationPassagesRepository,
```

改为

```ts
    private readonly dictationRepo: ChinesePassagesRepository,
```

- [ ] **Step 4a: 替换前三个方法**

同文件，把 `listDictationPassages`（约 95–106 行）/ `startDictation`（约 108–132 行）/
`judgeDictation`（约 134–175 行）**三个方法整体**替换为下面的代码。
`generateDictationFeedback` **本次不动**（下一步单独改它的两处）。

```ts
  /** 语文默写：配置页篇目清单（抽题池 = verified=1 且 memorize_required=1 且 is_active=1）。
   *  只出篇名 + 册次——作者/朝代/正文都是判题答案字段，一律不下发。 */
  async listDictationPassages(): Promise<{ passages: DictationPassageListItem[] }> {
    const rows = await this.dictationRepo.findVerifiedForDictation();
    return {
      passages: rows.map((r) => ({
        passageId: r.id,
        workTitle: r.work_title,
        semester: r.semester,
      })),
    };
  }

  /**
   * 语文默写开练：指定篇目则按篇目出题（忽略册次），否则按册次（null=全部）随机抽。
   * 题项做白名单序列化——只出 passageId/prompt/workTitle/semester，作者/朝代/正文
   * 一律剥离（防答案泄露，与 startTargetedPractice 同规矩）。
   * 题面由篇名生成（`buildDictationPrompt`），**不再从 questions.content 取**。
   */
  async startDictation(input: {
    semester: string | null;
    passageIds: number[] | null;
    count: number;
  }): Promise<{ questions: DictationQuestionItem[] }> {
    const rows = input.passageIds && input.passageIds.length > 0
      ? await this.dictationRepo.findVerifiedByIds(input.passageIds)
      : await this.dictationRepo.findRandomVerified(input.semester, input.count);
    return {
      questions: rows.slice(0, input.count).map((r) => ({
        passageId: r.id,
        prompt: buildDictationPrompt(r.work_title),
        workTitle: r.work_title,
        semester: r.semester,
      })),
    };
  }

  /**
   * 语文默写判题：**纯程序**判对错（JudgeCore.judgeDictation），不等 LLM，
   * 且**不写任何学生状态**（独立化后不入错题本、不清零）。
   *
   * 2026-09-14 起错因文案与判题解耦：本方法只回判题结果（~25ms），
   * 答错时带 `feedbackPending=true`，由前端另调 generateDictationFeedback 取文案。
   * 解耦前错因 LLM 调用在关键路径上——本地 Qwen3.8-27B 是思考模型，
   * 一次错答要等 13–16 秒才看到对错，学生以为卡死。
   */
  async judgeDictation(input: {
    passageId: number;
    author: string;
    dynasty: string;
    body: string;
  }): Promise<DictationJudgeResult> {
    const passage = await this.dictationRepo.findById(input.passageId);
    if (!passage) {
      throw new NotFoundException(`默写篇目不存在：${input.passageId}`);
    }

    const expected = { author: passage.author, dynasty: passage.dynasty, body: passage.body };
    const judged = await this.judgeCore.judgeDictation({
      expected,
      student: { author: input.author, dynasty: input.dynasty, body: input.body },
    });

    // 显式构造返回，不用 spread：judged 带 method 字段，spread 进对象字面量会触发
    // TS 多余属性检查（DictationJudgeResult 未声明 method）。
    return {
      passageId: passage.id,
      isCorrect: judged.isCorrect,
      fields: judged.fields,
      bodyDiff: judged.bodyDiff,
      reference: expected,
      feedback: null,
      feedbackPending: !judged.isCorrect,
    };
  }

  /**
   * 语文默写错因文案（LLM，可选；判题后异步补取）。
   *
   * 只生成话术，**不碰判题、不写任何学生状态**——故本方法只读篇目 + 纯函数算差异。
   * 模型不可达/超时/两个模型都失败一律回 `feedback=null`，由前端显示兜底文案。
   */
  async generateDictationFeedback(input: {
    passageId: number;
    author: string;
    dynasty: string;
    body: string;
  }): Promise<{ feedback: string | null }> {
    const passage = await this.dictationRepo.findById(input.passageId);
    if (!passage) {
      throw new NotFoundException(`默写篇目不存在：${input.passageId}`);
    }

    const expected = { author: passage.author, dynasty: passage.dynasty, body: passage.body };
    const student = { author: input.author, dynasty: input.dynasty, body: input.body };
    const { fields, bodyDiff } = evaluateDictation(expected, student);

    try {
      const result = await this.dictationFeedback.generate({
        workTitle: passage.work_title,
        expected,
        student,
        fieldMatch: {
          author: fields.author.match,
          dynasty: fields.dynasty.match,
          body: fields.body.match,
        },
        bodyDiffText: renderBodyDiff(bodyDiff),
      });
      return { feedback: result.content || null };
    } catch (err) {
```

- [ ] **Step 4b: 改 `generateDictationFeedback` 的两处**

**只做这两处替换，方法体其余部分（含 `catch` 块）一字不动：**

1. 入参类型：`questionId: number;` → `passageId: number;`
2. 取篇目：`const passage = await this.dictationRepo.findByQuestionId(input.questionId);` → `const passage = await this.dictationRepo.findById(input.passageId);`
3. 错误文案：`throw new NotFoundException(\`默写篇目不存在：${input.questionId}\`);` → `` `默写篇目不存在：${input.passageId}` ``
4. 方法头注释里那句「判题与错题本已由 judgeDictation 落定，这里重复调 judgeDictation 会二次写 main_error_books」
   → 「独立化后判题**不写任何学生状态**，本方法同样只读篇目、只算差异」
5. **`catch` 块里的日志也要改**：`this.logger.warn(\`... failed (questionId=${input.questionId}): ${err}\`)`
   里的 `questionId` → `passageId`（含日志文案前缀）。
   > ⚠️ 本步初版写的「`catch` 块一字不动」是**错的** —— 不改必然 TS2339，直接破坏本任务的验收标准。
   > 兜底语义（`return { feedback: null }`）保持不动，只改名。

> **验收标准的修正**：本任务结束时 `training.service.ts` 仍会有 **3 条** tsc 错误，全部由**尚未改名的
> `dictation.dto.ts`**（Task 5 整文件重写）引起 —— service 现在返回 `passageId`，而 DTO 仍声明
> `questionId`。在「只动 2 个文件」的约束下这 3 条不可能消除，属**跨任务依赖**，不是本任务失败。
> 真正该消失的是初版那 6 条（import 旧路径 + `studentId`/`questionId`/`errorBookId`）。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/training/training.dictation.test.ts`
Expected: PASS（**12 个** —— `renderBodyDiff` 1 + `listDictationPassages` 1 + `startDictation` 2 + `judgeDictation` 4 + `generateDictationFeedback` 4；初版写「11 个」是数错了）

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/training/training.service.ts apps/server/src/modules/training/training.dictation.test.ts
git commit -m "refactor(training): 默写 questionId->passageId，题面由篇名生成，判题结果去 errorBookId"
```

---

## Task 5: Controller + DTO 字段改名

> **承接 Task 4 评审的一处 Minor（必做）**：Task 4 的 12 个用例里**没有一条断言 `judgeDictation` 返回的
> `passageId`** —— 那行（如今是 `passageId: passage.id`）若写成 `passageId: 0` 或取自别处，12 条仍会全绿
> （`PASSAGE.id === 1` 与列表/题项里的 `1` 撞值，其它断言间接区分不了）。
> Task 4 时 DTO 还没改，加这条断言会多出第 4 条 tsc 错误、破坏验收标准，故延后到这里。
> **本任务里请在 `apps/server/src/modules/training/training.dictation.test.ts` 的 `judgeDictation` 用例中补上**
> `expect(res.passageId).toBe(1);`（放在 `expect(res.reference)` 附近），并确认它确实有牙。

**Files:**
- Modify: `apps/server/src/modules/training/dto/dictation.dto.ts`（整文件重写）
- Modify: `apps/server/src/modules/training/training.controller.ts:140-205`
- Modify: `apps/server/src/modules/training/training.module.ts:5,21`
- Modify: `apps/server/src/modules/training/training.controller.dictation.test.ts`（整文件重写）

- [ ] **Step 1: 重写 controller 测试**

把 `apps/server/src/modules/training/training.controller.dictation.test.ts` **整个文件**替换为：

```ts
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { TrainingController } from './training.controller';

function makeController() {
  const service = {
    listDictationPassages: vi.fn().mockResolvedValue({ passages: [] }),
    startDictation: vi.fn().mockResolvedValue({ questions: [] }),
    judgeDictation: vi.fn().mockResolvedValue({ isCorrect: true, feedback: null }),
    generateDictationFeedback: vi.fn().mockResolvedValue({ feedback: null }),
  };
  return { controller: new TrainingController(service as never), service };
}

describe('TrainingController dictation 端点', () => {
  it('GET dictation/passages → 透传 service', async () => {
    const { controller, service } = makeController();
    const res = await controller.listDictationPassages();
    expect(service.listDictationPassages).toHaveBeenCalledOnce();
    expect(res).toEqual({ passages: [] });
  });

  it('POST dictation/start：count 越界 → 400', async () => {
    const { controller } = makeController();
    await expect(
      controller.startDictation({ semester: null, passageIds: null, count: 0 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.startDictation({ semester: null, passageIds: null, count: 21 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it('POST dictation/start：semester 非法 → 400', async () => {
    const { controller } = makeController();
    await expect(
      controller.startDictation({ semester: '上学期', passageIds: null, count: 5 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('POST dictation/start：passageIds 含非法值 → 400', async () => {
    const { controller } = makeController();
    await expect(
      controller.startDictation({ semester: null, passageIds: [0], count: 5 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('POST dictation/start：合法入参 → 透传 semester/passageIds/count（不再传 studentId）', async () => {
    // 独立化后「不再展示」join 已移除，studentId 不再参与抽题——传了就是死参数
    const { controller, service } = makeController();
    await controller.startDictation({ semester: '上册', passageIds: null, count: 5 });
    expect(service.startDictation).toHaveBeenCalledWith({
      semester: '上册', passageIds: null, count: 5,
    });
  });

  it('POST dictation/judge：passageId 非正整数 → 400', async () => {
    const { controller } = makeController();
    await expect(
      controller.judgeDictation({ passageId: 0, author: '', dynasty: '', body: '' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('POST dictation/judge：缺字段按空串处理并透传（不传 studentId）', async () => {
    const { controller, service } = makeController();
    await controller.judgeDictation({ passageId: 1 } as never);
    expect(service.judgeDictation).toHaveBeenCalledWith({
      passageId: 1, author: '', dynasty: '', body: '',
    });
  });

  it('POST dictation/judge：非字符串字段降级为空串（不把 number 透传给 service）', async () => {
    const { controller, service } = makeController();
    await controller.judgeDictation(
      { passageId: 1, author: 123, dynasty: null, body: {} } as never,
    );
    expect(service.judgeDictation).toHaveBeenCalledWith({
      passageId: 1, author: '', dynasty: '', body: '',
    });
  });

  it('POST dictation/feedback：passageId 非正整数 → 400', async () => {
    const { controller } = makeController();
    await expect(
      controller.generateDictationFeedback({ passageId: -1, author: '', dynasty: '', body: '' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('POST dictation/feedback：合法入参 → 透传三字段', async () => {
    const { controller, service } = makeController();
    await controller.generateDictationFeedback({
      passageId: 1, author: '李白', dynasty: '唐', body: '床前明月先',
    });
    expect(service.generateDictationFeedback).toHaveBeenCalledWith({
      passageId: 1, author: '李白', dynasty: '唐', body: '床前明月先',
    });
  });

  it('POST dictation/feedback：非字符串字段同样降级为空串', async () => {
    const { controller, service } = makeController();
    await controller.generateDictationFeedback(
      { passageId: 1, author: 123, dynasty: null, body: {} } as never,
    );
    expect(service.generateDictationFeedback).toHaveBeenCalledWith({
      passageId: 1, author: '', dynasty: '', body: '',
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/training/training.controller.dictation.test.ts`
Expected: FAIL —— `passageIds` 校验未实现

- [ ] **Step 3: 重写 DTO**

把 `apps/server/src/modules/training/dto/dictation.dto.ts` **整个文件**替换为：

```ts
import type { DictationDiffOp } from '../../../common/utils/normalize-chinese.util.js';

/**
 * 配置页篇目清单项。
 * 只出篇名 + 册次：作者/朝代/正文是学生要作答的三个字段，故意不下发（防答案泄露）。
 */
export interface DictationPassageListItem {
  passageId: number;
  workTitle: string;
  semester: string;
}

/** 开练题项（不含作者/朝代/正文答案，防答案泄露）。 */
export interface DictationQuestionItem {
  passageId: number;
  prompt: string;
  workTitle: string;
  semester: string;
}

export interface DictationJudgeResult {
  passageId: number;
  isCorrect: boolean;
  fields: { author: { match: boolean }; dynasty: { match: boolean }; body: { match: boolean } };
  bodyDiff: DictationDiffOp[];
  reference: { author: string; dynasty: string; body: string };
  /** 判题接口恒为 null——错因已与判题解耦，由 POST dictation/feedback 单独取。 */
  feedback: string | null;
  /** true=判错且错因待补（前端应另调 dictation/feedback）；答对恒 false。 */
  feedbackPending: boolean;
}

/** 错因接口返回：模型不可达/超时/两个模型都失败时为 null（前端显示兜底文案）。 */
export interface DictationFeedbackResult {
  feedback: string | null;
}
```

- [ ] **Step 4: 改 controller 四个端点**

`apps/server/src/modules/training/training.controller.ts`，把「语文古诗文默写」段（约 140–205 行）替换为：

```ts
  // ==================== 语文古诗文专项：默写（2026-09-13） ====================

  /** 语文默写篇目清单（配置页用；只出已校验篇目，作者/朝代/正文均不下发）。 */
  @Get('dictation/passages')
  async listDictationPassages() {
    return this.trainingService.listDictationPassages();
  }

  /** 语文默写开练：count 限 1-20；semester 限 上册|下册|null；
   *  passageIds 非空时按指定篇目出题（忽略 semester）。 */
  @Post('dictation/start')
  async startDictation(
    @Body() dto: { semester: string | null; passageIds: number[] | null; count: number },
  ) {
    const { count } = dto;
    if (!Number.isInteger(count) || count < 1 || count > 20) {
      throw new BadRequestException('count 仅允许 1-20 的整数');
    }
    const semester = dto.semester ?? null;
    if (semester !== null && semester !== '上册' && semester !== '下册') {
      throw new BadRequestException('semester 仅允许 上册 | 下册 | null');
    }
    const passageIds = dto.passageIds ?? null;
    if (passageIds !== null &&
        (!Array.isArray(passageIds) || passageIds.some((id) => !Number.isInteger(id) || id < 1))) {
      throw new BadRequestException('passageIds 须为正整数数组或 null');
    }
    return this.trainingService.startDictation({ semester, passageIds, count });
  }

  /** 语文默写判题：三字段作答；**纯程序判对错、不等 LLM**（~25ms），
   *  答错时返回 `feedbackPending=true`，错因另调 dictation/feedback。
   *  **不写任何学生状态**（独立化后不入错题本）。
   *  非字符串字段（如 {"author":123}）降级为空串——否则会带着 number 进
   *  normalizeChineseAnswer 触发 TypeError 变 500。 */
  @Post('dictation/judge')
  async judgeDictation(
    @Body() dto: { passageId: number; author: string; dynasty: string; body: string },
  ) {
    if (!Number.isInteger(dto.passageId) || dto.passageId < 1) {
      throw new BadRequestException('passageId 须为正整数');
    }
    return this.trainingService.judgeDictation({
      passageId: dto.passageId,
      author: typeof dto.author === 'string' ? dto.author : '',
      dynasty: typeof dto.dynasty === 'string' ? dto.dynasty : '',
      body: typeof dto.body === 'string' ? dto.body : '',
    });
  }

  /** 语文默写错因文案（LLM，可选）：判题后单独取，失败回 feedback=null 不报错。
   *  入参与 judge 相同——服务端据此重算差异喂给模型，但**不写任何学生状态**。 */
  @Post('dictation/feedback')
  async generateDictationFeedback(
    @Body() dto: { passageId: number; author: string; dynasty: string; body: string },
  ) {
    if (!Number.isInteger(dto.passageId) || dto.passageId < 1) {
      throw new BadRequestException('passageId 须为正整数');
    }
    return this.trainingService.generateDictationFeedback({
      passageId: dto.passageId,
      author: typeof dto.author === 'string' ? dto.author : '',
      dynasty: typeof dto.dynasty === 'string' ? dto.dynasty : '',
      body: typeof dto.body === 'string' ? dto.body : '',
    });
  }
```

> `@CurrentUser()` / `JwtUser` 在本段已不再使用——若文件其它端点仍在用则保持 import 不动。

- [ ] **Step 5: 改 module**

`apps/server/src/modules/training/training.module.ts`：第 5 行 import 里 `DictationPassagesRepository` → `ChinesePassagesRepository`；第 21 行 providers 里同样替换。

- [ ] **Step 6: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/training/training.controller.dictation.test.ts`
Expected: PASS（**11 个** —— 计划给出的测试文件内容本身就是 11 个 `it`；初版写「10 个」是数错了）

- [ ] **Step 7: 全量服务器测试**

Run: `cd apps/server && npm test`
Expected: 全绿（改造前 497 passed）

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/modules/training
git commit -m "refactor(training): 默写端点 questionId->passageId，DTO 与 provider 同步改名"
```

---

## Task 6: seed-dictation-fixture.ts 不再写 questions

**Files:**
- Modify: `apps/server/src/scripts/seed-dictation-fixture.ts`（整文件重写）

- [ ] **Step 1: 重写脚本**

把 `apps/server/src/scripts/seed-dictation-fixture.ts` **整个文件**替换为：

```ts
/**
 * 【开发假数据】语文默写链路验证种子。
 *
 * 警告：这里的数据**不是生产题库**，仅为打通「训练 → 语文 → 专项 → 默写」链路。
 * 生产篇目由内容管线（爬 smartedu 教材 + 逐篇校验）导入，见
 * docs/superpowers/specs/2026-09-13-chinese-dictation-special-design.md §6。
 * 真篇目入库时 memorizeRequired=0（内容对的未必要求背），待用户标定必背后才进抽题池；
 * 本脚本的假数据则直接置 memorizeRequired=1，好让专项在标定前仍有题可练。
 * 两条记录以 source_ref = 'DEV-FIXTURE' 标记，便于后续清理。
 *
 * 2026-09-15 独立化：**不再写 questions 行**——古诗文专项已是独立子系统
 * （不挂 questions、不进错题本，PRD §6.3 / §7.4），表 chinese_passages 就是全部。
 *
 * 幂等：走 (work_title, semester) 业务键 upsert。
 * 运行：npx tsx src/scripts/seed-dictation-fixture.ts
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { ChinesePassagesRepository } from '../database/repositories/chinese-passages.repo.js';

const FIXTURES = [
  {
    workTitle: '静夜思',
    author: '李白',
    dynasty: '唐',
    body: '床前明月光，疑是地上霜。举头望明月，低头思故乡。',
    semester: '上册',
    sortOrder: 9001,
  },
  {
    workTitle: '登鹳雀楼',
    author: '王之涣',
    dynasty: '唐',
    body: '白日依山尽，黄河入海流。欲穷千里目，更上一层楼。',
    semester: '上册',
    sortOrder: 9002,
  },
];

async function main() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST ?? 'localhost',
    user: process.env.DB_USER ?? 'ai_k12',
    password: process.env.DB_PASS ?? 'ai_k12',
    database: process.env.DB_NAME ?? 'ai_k12',
  });
  const repo = new ChinesePassagesRepository(pool as never);

  for (const f of FIXTURES) {
    // 安全阀：若该篇目已属真实内容（内容管线导入的），绝不覆盖——本脚本只碰自己的假数据。
    const [existing] = await pool.execute<any[]>(
      `SELECT id, source_ref FROM chinese_passages
        WHERE work_title = ? AND semester = ? LIMIT 1`,
      [f.workTitle, f.semester],
    );
    if (existing.length > 0 && existing[0].source_ref !== 'DEV-FIXTURE') {
      console.warn(
        `[seed-dictation-fixture] 跳过《${f.workTitle}》：该篇目已存在且 source_ref=${existing[0].source_ref}，非开发假数据`,
      );
      continue;
    }

    await repo.upsert({
      workTitle: f.workTitle,
      author: f.author,
      dynasty: f.dynasty,
      body: f.body,
      gradeBand: 'junior',
      grade: '九年级',
      semester: f.semester,
      sortOrder: f.sortOrder,
      sourceRef: 'DEV-FIXTURE',
      verified: 1,
      // 假数据置「必背」：否则抽题池（verified AND memorize_required）会空掉，
      // 管线落地到真篇目标定必背之前，专项将无可练之题。
      memorizeRequired: 1,
    });
    console.log(`seeded 《${f.workTitle}》（${f.semester}）`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: 类型检查**

Run: `cd apps/server && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/scripts/seed-dictation-fixture.ts
git commit -m "refactor(scripts): 默写种子改走 chinese_passages，不再写 questions 行"
```

---

## Task 7: data-refinery loader 不再写 questions

**Files:**
- Modify: `tools/data-refinery/src/dictation_loader.py`（整文件重写）
- Modify: `tools/data-refinery/src/dictation_cli.py:446-451`
- Modify: `tools/data-refinery/tests/test_dictation_loader.py`（整文件重写）

- [ ] **Step 1: 重写测试**

把 `tools/data-refinery/tests/test_dictation_loader.py` **整个文件**替换为：

```python
"""dictation_loader 单测：用假连接，不碰真库。

核心是钉住**幂等策略**：以 `chinese_passages` 的业务键 `(work_title, semester)` 为身份，
命中既有篇目就**原地 UPDATE**（不插重复行）。
另钉三条容易被后续改动破坏的约定：
- **不写 `questions` 表**（2026-09-15 独立化：古诗文专项不挂 questions）；
- `memorize_required` **不得**被 upsert 覆盖（否则重跑会把用户标好的必背刷回 0）；
- `verified` 由 JSONL 决定，不写死。
"""

import json

from dictation_loader import DictationLoader


class _FakeCursor:
    """按 (子串, 返回行) 脚本应答的假游标；记录所有执行过的 SQL。"""

    def __init__(self, scripted):
        self._scripted = scripted
        self.executed = []
        self._last = []

    def execute(self, sql, args=None):
        self.executed.append((sql, args))
        for pat, rows in self._scripted:
            if pat in sql:
                self._last = rows
                return
        self._last = []

    def fetchall(self):
        return self._last

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def close(self):
        pass


class _FakeConn:
    def __init__(self, scripted):
        self.cur = _FakeCursor(scripted)
        self.committed = 0

    def cursor(self):
        return self.cur

    def commit(self):
        self.committed += 1


ITEM = {
    "subject_id": "chinese",
    "work_title": "岳阳楼记",
    "author": "范仲淹",
    "dynasty": "宋",
    "body": "庆历四年春，滕子京谪守巴陵郡。",
    "semester": "上册",
    "grade_band": "junior",
    "grade": "九年级",
    "source_ref": "统编版语文九年级上册 P46-49",
    "verified": 1,
    "_sort_order": 1,
}


def _loader(scripted):
    loader = DictationLoader.__new__(DictationLoader)   # 绕过真实连接
    loader._conn = _FakeConn(scripted)
    return loader


def _sqls(loader):
    return [s for s, _ in loader._conn.cur.executed]


class TestNoQuestionsWrites:
    """独立化的核心：整条链路不得再碰 questions。"""

    def test_never_writes_questions(self):
        scripted = [("FROM chinese_passages", [])]
        loader = _loader(scripted)
        loader.load_passages([ITEM])
        sqls = _sqls(loader)
        assert not any("questions" in s for s in sqls), sqls

    def test_never_reads_subjects(self):
        # subject_id 谓词随独立化取消（表本身就是语文），故不必再查 subjects
        scripted = [("FROM chinese_passages", [])]
        loader = _loader(scripted)
        loader.load_passages([ITEM])
        assert not any("FROM subjects" in s for s in _sqls(loader))


class TestIdempotency:
    def test_existing_passage_updates_in_place(self):
        scripted = [("FROM chinese_passages", [(5036, "PIPELINE")])]
        loader = _loader(scripted)
        stats = loader.load_passages([ITEM])
        assert any("INSERT INTO chinese_passages" in s for s in _sqls(loader))
        assert stats == {"passages_upserted": 1}
        assert loader._conn.committed >= 1

    def test_upsert_has_no_question_id(self):
        scripted = [("FROM chinese_passages", [(5036, "PIPELINE")])]
        loader = _loader(scripted)
        loader.load_passages([ITEM])
        upsert = [s for s in _sqls(loader) if "INSERT INTO chinese_passages" in s][0]
        assert "question_id" not in upsert

    def test_dev_fixture_row_is_warned(self, capsys):
        # 开发假数据必须能被真实内容覆盖，且明确告警（不能静默覆盖）
        scripted = [("FROM chinese_passages", [(5036, "DEV-FIXTURE")])]
        loader = _loader(scripted)
        loader.load_passages([ITEM])
        out = capsys.readouterr().out
        assert "DEV-FIXTURE" in out and "岳阳楼记" in out

    def test_memorize_required_never_overwritten(self):
        # 重跑不得把用户已标的必背刷回 0
        scripted = [("FROM chinese_passages", [(5036, "PIPELINE")])]
        loader = _loader(scripted)
        loader.load_passages([ITEM])
        upsert = [s for s in _sqls(loader) if "INSERT INTO chinese_passages" in s][0]
        assert "memorize_required=VALUES" not in upsert.replace(" ", "")
        assert "ON DUPLICATE KEY UPDATE" in upsert

    def test_verified_is_written_from_item(self):
        scripted = [("FROM chinese_passages", [])]
        loader = _loader(scripted)
        loader.load_passages([{**ITEM, "verified": 0}])
        upsert = [a for s, a in loader._conn.cur.executed if "INSERT INTO chinese_passages" in s][0]
        # 参数顺序：[work_title, author, dynasty, body, grade_band, grade, semester,
        #           sort_order, source_ref, verified]
        assert upsert[9] == 0

    def test_business_key_lookup_uses_title_and_semester(self):
        scripted = [("FROM chinese_passages", [])]
        loader = _loader(scripted)
        loader.load_passages([ITEM])
        lookup = [a for s, a in loader._conn.cur.executed if "FROM chinese_passages" in s][0]
        assert lookup == ("岳阳楼记", "上册")


class TestReadJsonl:
    def test_reads_rows_and_skips_blank_lines(self, tmp_path):
        p = tmp_path / "a.jsonl"
        p.write_text(json.dumps(ITEM, ensure_ascii=False) + "\n\n", encoding="utf-8")
        rows = DictationLoader.read_jsonl(p)
        assert len(rows) == 1 and rows[0]["work_title"] == "岳阳楼记"

    def test_ignores_underscore_keys(self, tmp_path):
        # JSONL 里带 `_locate_notes` / `_repair_note` 等内部字段，入库只取契约字段即可
        p = tmp_path / "a.jsonl"
        row = {**ITEM, "_locate_notes": ["跳过编者导语"], "_repair_note": ""}
        p.write_text(json.dumps(row, ensure_ascii=False) + "\n", encoding="utf-8")
        assert DictationLoader.read_jsonl(p)[0]["work_title"] == "岳阳楼记"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd tools/data-refinery && python -m pytest tests/test_dictation_loader.py -q`
Expected: FAIL —— loader 仍写 `questions`、仍查 `subjects`

- [ ] **Step 3: 重写 loader**

把 `tools/data-refinery/src/dictation_loader.py` **整个文件**替换为：

```python
"""语文古诗文管线：把抽取产物入库（幂等）。

## 幂等策略

以 `chinese_passages` 的业务键 `(work_title, semester)` 作为篇目身份：
**先找既有行，有则原地 UPDATE、无则 INSERT**。

**不用 `content_hash` 去重**——题面一旦调整，hash 就变，按 hash 去重会插出**新行**。
按业务键原地改，行 id 保持不变。

## 独立化（2026-09-15）

古诗文专项已是**独立子系统**：**不挂 `questions`、不进错题本、不参与主线清零门禁**
（PRD §6.3 / §7.4）。故本模块：

- **不再写 `questions` 行**（原先每篇挂一行 `poem_dictation` 题作错题本/隐藏题锚点，
  这些用途已按设计整体移除）；
- **不再查 `subjects`**（原先为取 `subject_id`；表本身就是语文，无此列）。

设计见 docs/superpowers/specs/2026-09-15-chinese-interpretation-special-design.md §6。

## 两条不要破坏的约定

- `memorize_required` 只在 INSERT 时写死 `0`，**`ON DUPLICATE KEY UPDATE` 里绝不出现它**：
  否则管线重跑会把用户已标好的「必背」刷回 0。
- `verified` 由 JSONL 决定（自检结果），不写死。

## 与 TS 种子脚本的关系

`apps/server/src/scripts/seed-dictation-fixture.ts` 是**开发假数据**（`source_ref='DEV-FIXTURE'`），
与本模块同构。真实内容覆盖到假数据行时**明确告警**，不静默盖掉。
"""

from __future__ import annotations

import json
from pathlib import Path

import pymysql


class DictationLoader:
    def __init__(self, host: str, port: int, user: str, password: str, db: str):
        self._conn = pymysql.connect(host=host, port=port, user=user,
                                     password=password, database=db, charset="utf8mb4")

    def close(self):
        self._conn.close()

    # ---- 低层 ----

    def _query(self, sql, args=None):
        with self._conn.cursor() as cur:
            cur.execute(sql, args)
            return cur.fetchall()

    def _exec(self, sql, args=None):
        with self._conn.cursor() as cur:
            cur.execute(sql, args)

    # ---- 主流程 ----

    def load_passages(self, items: list[dict]) -> dict:
        upserted = 0
        for it in items:
            work_title = it["work_title"]
            semester = it["semester"]

            existing = self._query(
                "SELECT id, source_ref FROM chinese_passages "
                "WHERE work_title=%s AND semester=%s LIMIT 1",
                (work_title, semester),
            )
            if existing and existing[0][1] == "DEV-FIXTURE":
                print(f"[WARN] 《{work_title}》原为 DEV-FIXTURE（开发假数据），"
                      f"将由真实内容覆盖", flush=True)

            # memorize_required 只在这里写 0；ON DUPLICATE KEY UPDATE 里不出现它
            self._exec(
                "INSERT INTO chinese_passages (work_title, author, dynasty, body, "
                "grade_band, grade, semester, sort_order, source_ref, verified, memorize_required) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,0) "
                "ON DUPLICATE KEY UPDATE author=VALUES(author), "
                "dynasty=VALUES(dynasty), body=VALUES(body), grade_band=VALUES(grade_band), "
                "grade=VALUES(grade), sort_order=VALUES(sort_order), source_ref=VALUES(source_ref), "
                "verified=VALUES(verified)",
                (work_title, it.get("author") or "", it.get("dynasty") or "", it["body"],
                 it.get("grade_band"), it.get("grade"), semester, it.get("_sort_order", 0),
                 it.get("source_ref"), int(it.get("verified", 1))),
            )
            upserted += 1

        self._conn.commit()
        return {"passages_upserted": upserted}

    @staticmethod
    def read_jsonl(path) -> list[dict]:
        """读抽取产物的 JSONL。带下划线的内部字段（`_locate_notes` 等）原样保留，
        入库只取契约字段，互不干扰。"""
        return [json.loads(l) for l in
                Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd tools/data-refinery && python -m pytest tests/test_dictation_loader.py -q`
Expected: PASS（9 个）

- [ ] **Step 5: 改 CLI 输出**

`tools/data-refinery/src/dictation_cli.py:446-451`，把：

```python
        stats = loader.load_passages(items)
```
```python
    print(f"[ok] 入库完成：新增题 {stats['inserted']}、复用并更新 {stats['updated']}、"
          f"篇目 upsert {stats['passages_upserted']}", flush=True)
```

的打印语句改为（`load_passages` 那行不动）：

```python
    print(f"[ok] 入库完成：篇目 upsert {stats['passages_upserted']}", flush=True)
```

同时把该文件 `--term` 帮助文本里的 `写入 dictation_passages.semester` 改为 `写入 chinese_passages.semester`。

- [ ] **Step 6: 全量 pytest**

Run: `cd tools/data-refinery && python -m pytest -q`
Expected: 全绿（改造前 237 passed）

- [ ] **Step 7: Commit**

```bash
git add tools/data-refinery/src/dictation_loader.py tools/data-refinery/src/dictation_cli.py tools/data-refinery/tests/test_dictation_loader.py
git commit -m "refactor(data-refinery): 默写 loader 改走 chinese_passages，不再写 questions"
```

---

## Task 8: 前端字段改名

**Files:**
- Modify: `apps/web/src/services/api.ts:980-1052`
- Modify: `apps/web/src/pages/student/training/chinese/DictationConfigPage.tsx`
- Modify: `apps/web/src/pages/student/training/chinese/DictationRunPage.tsx:79`

- [ ] **Step 1: 改 api.ts**

`apps/web/src/services/api.ts` 里 `// --- Training · 语文古诗文默写（2026-09-13） ---` 段：

```ts
export interface DictationPassageItem {
  passageId: number;
  workTitle: string;
  semester: string;
}

export interface DictationQuestionItem {
  passageId: number;
  prompt: string;
  workTitle: string;
  semester: string;
}
```

```ts
export interface DictationJudgeResult {
  passageId: number;
  isCorrect: boolean;
  fields: { author: { match: boolean }; dynasty: { match: boolean }; body: { match: boolean } };
  bodyDiff: DictationDiffOp[];
  reference: { author: string; dynasty: string; body: string };
  /** 判题接口恒为 null——错因已与判题解耦，改由 fetchDictationFeedback 单独取。 */
  feedback: string | null;
  /** true=判错且错因待补（应另调 fetchDictationFeedback）；答对恒 false。 */
  feedbackPending: boolean;
}
```

（`errorBookId?: number;` **删除** —— 判题不再写错题本。）

```ts
export function startDictation(payload: {
  semester: string | null;
  passageIds: number[] | null;
  count: number;
}): Promise<{ questions: DictationQuestionItem[] }> {
  return fetchApi<{ questions: DictationQuestionItem[] }>('/training/dictation/start', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function judgeDictation(payload: {
  passageId: number;
  author: string;
  dynasty: string;
  body: string;
}): Promise<DictationJudgeResult> {
  return fetchApi<DictationJudgeResult>('/training/dictation/judge', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** 错因文案（LLM，可选）：与判题解耦，判错后单独取；失败回 feedback=null。 */
export function fetchDictationFeedback(payload: {
  passageId: number;
  author: string;
  dynasty: string;
  body: string;
}): Promise<{ feedback: string | null }> {
  return fetchApi<{ feedback: string | null }>('/training/dictation/feedback', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
```

- [ ] **Step 2: 改 DictationConfigPage**

`apps/web/src/pages/student/training/chinese/DictationConfigPage.tsx`：把 `togglePick` 与勾选相关的 `questionId` 全部改为 `passageId`：

```ts
  const togglePick = (passageId: number) => {
    setPicked((prev) =>
      prev.includes(passageId) ? prev.filter((x) => x !== passageId) : [...prev, passageId],
    );
  };
```

```ts
      const res = await startDictation({
        semester: usePicked ? null : range,
        passageIds: usePicked ? picked : null,
        count,
      });
```

模板里 `key={p.questionId}` → `key={p.passageId}`、`checked={picked.includes(p.questionId)}` → `p.passageId`、`onChange={() => togglePick(p.questionId)}` → `p.passageId`。

- [ ] **Step 3: 改 DictationRunPage**

`apps/web/src/pages/student/training/chinese/DictationRunPage.tsx:79`：

```ts
    const payload = { passageId: current.passageId, ...answer };
```

> 题单经 `sessionStorage`（key `training:dictation`）交接，字段名变了。旧标签页里遗留的题单会带 `questionId` → `current.passageId` 为 `undefined` → 提交 400。`sessionStorage` 关标签页即清，**不为此加兼容代码**；手测时若撞上，刷新配置页重开即可。

- [ ] **Step 4: 类型检查 + lint**

Run: `cd apps/web && npm run build`
Expected: `tsc -b` 与 `vite build` 均通过（若 `DictationRunPage` 有 `res.errorBookId` 的残留引用会在此暴露）

Run: `cd apps/web && npm run lint`
Expected: 无错误

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/services/api.ts apps/web/src/pages/student/training/chinese
git commit -m "refactor(web): 默写接口字段 questionId->passageId，去掉 errorBookId"
```

---

## Task 9: 执行迁移 + 全量验证

**Files:** 无（只跑命令）

- [ ] **Step 1: 备份（**必须放持久目录**）**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
mkdir -p tools/db/backups
mysqldump -u ai_k12 -pai_k12 ai_k12 main_error_books questions dictation_passages \
  > tools/db/backups/20260915_chinese_passages.sql
wc -l tools/db/backups/20260915_chinese_passages.sql
```
Expected: 文件非空（改造前 50 题 + 50 篇目 + 7 错题行）

> ⚠️ **不要写 `/tmp`**。本仓 2026-08-26 已经吃过一次：purge 前的备份写在 `/tmp/ai_k12_backup/`，被系统清理删掉、业务数据丢失（见 `docs/ai-core-changelog.md` 2026-08-28~29 条目 ③「今后备份一律放持久目录」）。这是整个迁移唯一的安全网。

> ⚠️ **从 Task 1 到本步之间，不要重放 `tools/db/schema.sql`，也不要跑 `tools/db/install_mysql.sh`**。`install_mysql.sh` 的 `apply_schema()` 对**已有库也会无脑重放** `schema.sql`，而 `schema.sql` 现在已含 `CREATE TABLE IF NOT EXISTS chinese_passages` —— 那会在 populated 的 `dictation_passages` 旁边建出一张**空** `chinese_passages`，让迁移第 3 步 `RENAME` 报 1050 且无法自愈（迁移脚本第 0a 步的闸门会在**任何删除之前**中止，正是为这个场景准备的）。

- [ ] **Step 2: 前置检查（**执行迁移前必跑**）**

`DELETE FROM questions WHERE type='poem_dictation'` 会被 `ON DELETE RESTRICT` 外键拦住，而**哪些表有行是数据依赖的、不能只看 schema**。六列必须全为 0：

```bash
mysql -u ai_k12 -pai_k12 ai_k12 -e "
SELECT
  (SELECT COUNT(*) FROM answers              WHERE question_id IN (SELECT id FROM questions WHERE type='poem_dictation')) AS answers,
  (SELECT COUNT(*) FROM aux_error_books      WHERE question_id IN (SELECT id FROM questions WHERE type='poem_dictation')) AS aux_error_books,
  (SELECT COUNT(*) FROM exam_answers         WHERE question_id IN (SELECT id FROM questions WHERE type='poem_dictation')) AS exam_answers,
  (SELECT COUNT(*) FROM variation_questions  WHERE question_id IN (SELECT id FROM questions WHERE type='poem_dictation')) AS variation_questions,
  (SELECT COUNT(*) FROM practice_results     WHERE question_id IN (SELECT id FROM questions WHERE type='poem_dictation')) AS practice_results,
  (SELECT COUNT(*) FROM ai_dialogues         WHERE question_id IN (SELECT id FROM questions WHERE type='poem_dictation')) AS ai_dialogues;"
```
Expected: `0 0 0 0 0 0`（2026-09-15 实测已确认）。**任一列非 0 就停下来**——前三列会让迁移中断，后三列会被静默置空（`practice_results`/`ai_dialogues` 是 `ON DELETE SET NULL`）。

> **两条注意**：
> - `aux_error_books` 只存在于线上库、**不在 `tools/db/schema.sql` 里**（漂移表）。按 `schema.sql` 新建的库上这一列会报 `ERROR 1146` 而不是返回 0 —— 那种库上本迁移无事可做。
> - 上面六列之外，迁移脚本**自己**还有两道中止闸门会在任何删除之前拦住：① 两表并存；② 挂在默写题上却 `source<>'dictation'` 的错题行（第 1 步按 source 删、不是按 question_id 删，这类行会漏删并让第 2 步被 RESTRICT 拦停）。两者实测均为安全值（1 / 0）。

- [ ] **Step 3: 执行迁移**

```bash
mysql -u ai_k12 -pai_k12 ai_k12 < tools/db/migrations/2026-09-15_chinese_passages.sql
```
Expected: 输出 `migration 2026-09-15_chinese_passages done`

- [ ] **Step 4: 验库**

```bash
mysql -u ai_k12 -pai_k12 ai_k12 -e "
SHOW TABLES LIKE 'chinese_passages';
SHOW TABLES LIKE 'dictation_passages';
SHOW COLUMNS FROM chinese_passages;
SELECT COUNT(*) AS 篇目, SUM(verified=1 AND memorize_required=1 AND is_active=1) AS 抽题池 FROM chinese_passages;
SELECT COUNT(*) AS 残留默写题 FROM questions WHERE type='poem_dictation';
SELECT COUNT(*) AS 残留默写错题 FROM main_error_books WHERE source='dictation';
SHOW INDEX FROM chinese_passages;"
```
Expected:
- `chinese_passages` 在、`dictation_passages` **不在**
- 列里**没有** `question_id`、**有** `is_active`
- 篇目 50、抽题池 50
- 残留默写题 **0**、残留默写错题 **0**
- 索引为 `uniq_chinese_passages_work` / `idx_chinese_passages_filter`，**无** `fk_dp_question` 相关外键

- [ ] **Step 5: 重跑迁移验幂等**

```bash
mysql -u ai_k12 -pai_k12 ai_k12 < tools/db/migrations/2026-09-15_chinese_passages.sql
mysql -u ai_k12 -pai_k12 ai_k12 -e "SELECT COUNT(*) FROM chinese_passages;"
```
Expected: 再次输出 done，篇目仍为 50（不重复、不报错）

- [ ] **Step 6: 全量测试**

```bash
cd apps/server && npm test
cd ../../tools/data-refinery && python -m pytest -q
cd ../../apps/web && npm run build && npm run lint
```
Expected: 三条全绿

- [ ] **Step 7: 手测（真机）**

用学生账号 `lc1/123456` 走 `训练 → 语文 → 专项 → 古诗文默写`：

1. 配置页能看到篇目清单、能按册次筛、能勾选指定篇目；
2. 开练后三字段作答、提交 → 立刻出对错 + 带标点的正文对比；
3. 答错时错因区转圈后填充文案（或超时显示兜底文案）；
4. **确认答错默写不写错题本**——注意：迁移后 `source='dictation'` 恒为 0，直接断言它是**空断言**（写不写都是 0）。要看**错题本总行数**在手测前后不变：
   ```bash
   # 手测前记下 N
   mysql -u ai_k12 -pai_k12 ai_k12 -e "SELECT COUNT(*) AS 总行数 FROM main_error_books;"
   # → 回到页面，故意把一篇默写答错并提交，等错因文案出来
   # 再取一次，应与 N 相同
   mysql -u ai_k12 -pai_k12 ai_k12 -e "SELECT COUNT(*) AS 总行数 FROM main_error_books;"
   ```
   Expected: 两次数字相同（答错不新增行）。若变大，说明错题本写入被改回来了。
5. 数学专项页无回归（`训练 → 数学 → 专项练习` 仍可正常抽题判题）。

- [ ] **Step 8: Commit（若有零星修正）**

**只能 `git add` 本次任务实际改到的文件路径。严禁 `git add -A` / `git add .`** —— 工作区还有一批与本次改造无关的未提交改动（2026-09-14 的代码改动 + 更早的文档），卷进来会把两个不相干的变更集混进同一段历史。

```bash
git add <本次实际改动的文件...>
git commit -m "test: 独立化改造后全链路验证修正"
```

---

## Task 10: 文档同步

**Files:**
- Modify: `docs/API接口与数据流设计文档.md`
- Modify: `docs/api/openapi.yaml`
- Modify: `docs/K12智学系统-数据库设计文档.md`
- Modify: `docs/data-refinery-使用手册.md`
- Modify: `docs/superpowers/specs/2026-09-15-chinese-interpretation-special-design.md`

> 同步规则（CLAUDE.md）：API 设计文档与 `openapi.yaml` **必须互为对照**，改一份必改另一份；改代码须同步所有引用该实现的设计文档。

- [ ] **Step 1: 改 API 设计文档**

`docs/API接口与数据流设计文档.md`：

1. §4.18 Training 段落下那条「【2026-09-15 设计变更，待实施】」提示 —— 改为「已于 2026-09-15 实施」，并把措辞从「尚未实施」换成现状描述。
2. `/api/training/dictation/passages` 行：`{passages: [{questionId, workTitle, semester}]}` → `passageId`；删掉「仅返回 `questions.is_active=1` 且 `dictation_passages.verified=1`」里的 `questions`/`dictation_passages` 旧表述，改为「`chinese_passages` 的 `verified=1 AND memorize_required=1 AND is_active=1`」；删掉「本清单不排除该生已标记「不再展示」的篇目」整句（该机制已移除）。
3. `/api/training/dictation/start` 行：请求体 `questionIds` → `passageIds`；响应 `passageId`；补充「题面由篇名生成」。
4. `/api/training/dictation/judge` 行：`questionId` → `passageId`；**删掉「答错 find-or-create 写 `main_error_books`（`source='dictation'`）；答对清零该题所有未清记录」整句**，替换为「判题不写任何学生状态（不入错题本、不清零）」；响应中删除 `errorBookId`。
5. `/api/training/dictation/feedback` 行：`questionId` → `passageId`；删掉「重复调 `judgeDictation` 会二次写 `main_error_books`」的括号说明（已不可能发生）。
6. 全局 `grep -n "questionId" docs/API接口与数据流设计文档.md` 复核：**非 dictation 段落**的 `questionId` 一律不动（那是题目体系，与本次无关）。

- [ ] **Step 2: 改 openapi.yaml**

`docs/api/openapi.yaml`：与上一步逐条对应（`/training/dictation/*` 四个 path 的 parameters / requestBody / responses 字段名、描述文案；删掉 `errorBookId` 属性；删掉「待实施」提示段）。

改完立即验证解析：

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
python3 -c "
import yaml
d = yaml.safe_load(open('docs/api/openapi.yaml'))
print('YAML OK; paths:', len(d['paths']))
import json
p = d['paths']['/training/dictation/judge']['post']
print(json.dumps(p.get('requestBody', {}), ensure_ascii=False)[:300])
"
```
Expected: 解析通过；`requestBody` 里是 `passageId`

- [ ] **Step 3: 端点清单对照（铁律检查）**

```bash
grep -o "/training/dictation/[a-z]*" docs/API接口与数据流设计文档.md | sort -u
grep -o "/training/dictation/[a-z]*" docs/api/openapi.yaml | sort -u
```
Expected: 两份输出完全一致（4 个端点）

- [ ] **Step 4: 改数据库设计文档**

`docs/K12智学系统-数据库设计文档.md` §3.14：

- 把顶部「**实施状态**：设计已定，**表尚未建**……现库中该专项用的是改造前的 `dictation_passages`」整段改为「**实施状态**：独立化改造已于 2026-09-15 实施——`dictation_passages` 已改名 `chinese_passages`、`question_id` 已摘除；**解释专项三列（`key_terms`/`sentences`/`full_translation`）尚未加**，随解释专项一起落地」。
- 表定义里：`author` / `dynasty` 当前实为 **NOT NULL**（设计稿写的是可空，实际未改），按实现修正；`key_terms`/`sentences`/`full_translation` 三行前加标记「**待实施**」。
- §8 变更日志 v2.2 条目：把「设计已定、表尚未建」改为「已实施（独立化部分）」。

- [ ] **Step 5: 改 data-refinery 使用手册**

`docs/data-refinery-使用手册.md` §4.9：

- 删掉「⚠️ 改造待实施（2026-09-15）」整段提示（已完成）。
- 段首那句「产物进 `chinese_passages`」后面补「（2026-09-15 独立化后不再写 `questions`）」。

- [ ] **Step 6: 更新上游 spec 的 12 号决策状态**

`docs/superpowers/specs/2026-09-15-chinese-interpretation-special-design.md`：在 §2 末尾或 §13 实施顺序处追加一行状态：

```markdown
> **实施进度（2026-09-15）**：**架构归位部分已完成**——`chinese_passages` 改名、`question_id` 摘除、
> 存量 50 题 + 7 行错题已清、判题不再写学生状态、API 字段 `questionId`→`passageId` 已生效、
> 两份 API 文档已同步。**古诗文解释专项（§5 / §7 / §8 及三列 JSON 字段）尚未开始**，
> 计划见 `docs/superpowers/plans/2026-09-15-chinese-passages-standalone.md`。
```

- [ ] **Step 7: 对照检查**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
grep -rn "dictation_passages" docs/ --include="*.md" --include="*.yaml" | grep -v "specs/2026-09-13" | grep -v "migrations/"
```
Expected: **无输出**（旧表名只应留在 2026-09-13 那份历史 spec 的「取代说明」里，以及迁移脚本自身）

- [ ] **Step 8: Commit**

```bash
git add docs
git commit -m "docs: 同步古诗文专项独立化——API 两份 + 数据库设计 + 使用手册 + spec 状态"
```

---

## 完成标准

- [ ] `chinese_passages` 存在且**无 `question_id`、无外键**；`dictation_passages` 已不存在
- [ ] `questions` 中 `type='poem_dictation'` 行数为 0；`main_error_books(source='dictation')` 行数为 0
- [ ] `apps/server` vitest 全绿、`tools/data-refinery` pytest 全绿、`apps/web` build + lint 通过
- [ ] 真机走通默写全链路；**答错后 `main_error_books` 无新增**
- [ ] 迁移脚本重跑幂等
- [ ] API 两份文档端点清单一致（铁律）
- [ ] 全仓 `grep "dictation_passages"` 只剩历史 spec 与迁移脚本
