# 埋点 Phase 1B（专项 + 掌握度 + 目标）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让家长端第一次看到**专项学情**（语文三专项 + 英语背单词）、**真掌握度**（不再用错题数代理）、**目标达成率**（可读可写），并把 `student_knowledge_mastery` / `goals` 两张死表复活。

**Architecture:** 后端两条写链 + 三个读端点。写链①：四个专项的判题出口各写一行 `special_practice_logs`（新表，无外键，`student_id` 除外）。写链②：`JudgeCoreService` 的对错出口（`isCorrect` 为 boolean 时）UPSERT `student_knowledge_mastery`。读侧：新建 `SpecialPracticeLogsRepository` / `StudentKnowledgeMasteryRepository` / `GoalsRepository`，由 `ParentInsightsModule` 的三个新 service 聚合成 3 个只读端点；写侧 1 个 `PUT .../goals/{metric}` 按 metric upsert。前端在仪表盘加专项卡、报告页加掌握度卡（与既有「薄弱知识点」**并存**）、`/parent/goals` 从 Placeholder 变可读可写真页。

**Tech Stack:** NestJS + TypeScript ESM + mysql2（`DATABASE_POOL`）+ Zod（controller 校验）+ Vitest；React + Zustand + recharts（家长端图表）+ Tailwind（CSS 变量 token）。

## Global Constraints

> 每一条都是**硬规则**，每个任务的要求都隐含包含本节。

**隐私分层（spec §5.4 三道锁，缺一不可）**
- 一部分行为信号（看答案/提示依赖、连续失败、放弃点、「我不会」自评）**只进运营端，永不进家长端**。
- 1B 的 3 个读端点**不得**含任何 `tier='ops'` 派生字段；「建议」类文案若要有，必须由后端生成中性结论、**不暴露任何次数**。

**§10 并存不替换（本批最容易做错的地方）**
- `weakPoints`（错题数**代理**）与新的 `mastery`（**真掌握度**）是两套口径，**两张卡并存、标题必须不同、不得合并**。
- `rate` 口径：`answered = 0 → null`，**不是 0**（沿用 `parent-insights/rate.util.ts` 的 `toRate`，不另写一套）。

**`special_practice_logs` 的写入口径**
- `error_counted` **不得**另写一套「什么算错」：英语必须复用 `normalize-english.util.ts` 的 `progressDelta`（只有 `wrong` 计错，`off_target` / `unanswered` / `undetermined` 三者都不计）。
- `is_correct`：`correct → 1`、`incorrect → 0`、**其它一律 NULL**（沿用「空答案不计对错」）。
- 语文三专项没有五档 verdict（默写是 boolean、解释/含义是 `correct: null` 的逐项），它们的 `verdict` 映射见 Task 3，**不要**硬套 `progressDelta`。

**掌握度回写的四条规则（spec §4.8）**
1. 只在该题**绑了 KP** 时写（`question_knowledge_points` 实测只覆盖 **203/530 ≈ 38%**，UI 必须显式展示「未覆盖」计数）。
2. `isCorrect === null`（空答案 / `self_assess` 待评）**不写**。
3. `questionId == null` **跳过**。
4. 失败**只 warn，不阻断判题**。

**时区**：家长端的窗口 `from`/`to` 由**应用层**按服务器本地时区算好传参，**刻意不用 `CURDATE()`**（DB 会话时区与 Node 可能不一致，会算错一天）。`< endExclusive` 半开区间。

**DB 约定**
- 所有时间列 `DATETIME(3)`；`updated_at` 用**列级** `ON UPDATE CURRENT_TIMESTAMP(3)`，**绝不加触发器**。
- 建表一律 `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`。
- **无迁移运行器**：新迁移**手工 apply**，且**必须幂等**（建表 `CREATE TABLE IF NOT EXISTS`；加列/加索引用 `information_schema` + `PREPARE` 守卫——MySQL 8/9 没有 `ADD COLUMN IF NOT EXISTS`）。
- 新表/新列**必须同时写进 `tools/db/schema.sql`**，且该表的 `CREATE TABLE` 语句在迁移文件与 `schema.sql` 中**逐字一致**。

**独立子系统的边界（勿泛化）**
- 语文三专项与英语背单词是**独立子系统**：不挂 `questions` 表、不进错题本、不参与主线清零门禁、不用「不再展示」/提示缓存/自评。`special_practice_logs` 只挂 `student_id` 一个外键。

**测试约定**
- `globals: false` → 多用例文件必须自己 `afterEach(() => cleanup())`，并复位模块级 Zustand 单例（`useParentStudentStore` / `useThemeStore`）。
- **每个新页面/组件补至少一条渲染测试**（React #31 的教训）。
- 测试与被测文件同目录；ESM import 带 `.js` 后缀；仓储测试用假 pool 复刻 mysql2 的双返回形状。

**环境**
- 起后端用 `node dist/main.js`（`npx tsx src/main.ts` 的 DI 是坏的）。
- 冒烟用**独立端口 + 按 PID 收尾**，**别** `pkill -f 'node dist/main.js'`（会杀掉用户本机在跑的服务）。
- ⚠️ **既有、与 1B 无关的红**：`apps/web` 的 `routes/routeTable.test.tsx` 里「主轨侧边导航不含辅轨入口」那条断言 `[data-theme="student-day"]`，而 `StudentLayout` 按挂钟在 18:00–06:00 切夜间 → **夜间跑必红**。别算到本批头上（清单文档 §3.3 第 6 项）。

## 范围与前置裁决（2026-09-19，用户已确认）

**做**（spec §12 的 Phase 1 条目 3–6 剩余部分）：
1. `special_practice_logs` 建表 + **4 个**判题点写入（语文默写 / 语文解释 / 语文含义 / 英语背单词）。
2. `student-knowledge-mastery.repo.ts` + `MasteryService` + 挂到 `JudgeCoreService` 的对错出口。
3. `goals` 加 `metric` 列 + `/parent/goals` 从 Placeholder 变真页（读 + 写）。
4. 家长端点 3 个读 + 1 个写，以及家长页新卡片（仪表盘专项卡 / 报告页掌握度卡 / 目标页 + 达成率卡）。

**两个已裁决的分歧（不要自己改回来）**：
- **判题点写 4 个**：spec 条目 3 的字面是「三个专项」，但 §4.4 的 `module` 枚举与 §8.2 的 `/specials` 形状都是 **4 个**（含 `en_vocabulary`）。只有条目 3 的文字是笔误。
- **`goals` 走精简契约**：读用 `GET .../goals/attainment`（spec §8.2），写用**新增**的 `PUT .../goals/{metric}`（按 metric upsert）。旧 API 文档/openapi 里那套 `GET/POST/PATCH/DELETE /goals` CRUD（字段 `title/period/target/reminderEnabled`、**没有 `metric`**）**标为废弃**并在 Task 12 同步两份文档。

**不做**（spec §13 明确排除，别顺手做）：`homeworks` / `assessments` 接线；`variation_questions` / `knowledge_relations` / `safety_alerts` / `learning_reports` / `error_redo_logs` 的复活；`daily_study_stats` rollup（Phase 3）；`behavior_events` 与 `POST /api/track/events`（Phase 2）；家长端暴露任何 ops 信号或逐学生 token 消耗；新增 LLM scene。

## File Structure

**新建（后端）**

| 文件 | 职责 |
|---|---|
| `tools/db/migrations/2026-09-22_special_practice_logs_and_goals.sql` | `special_practice_logs` 建表 + `goals` 加 `metric` 列与唯一键；幂等 |
| `apps/server/src/database/repositories/special-practice-logs.repo.ts` | 唯一写入口 + 专项聚合读（按 module / 按天 / 计数） |
| `apps/server/src/database/repositories/student-knowledge-mastery.repo.ts` | 掌握度 UPSERT + 取最弱 N 项 + 覆盖率计数 |
| `apps/server/src/database/repositories/goals.repo.ts` | `goals` 的读 / 按 metric upsert / 懒初始化默认目标 |
| `apps/server/src/modules/parent-insights/specials.service.ts` | `/specials` 聚合（四模块 + rate 口径） |
| `apps/server/src/modules/parent-insights/mastery.service.ts` | `/mastery` 聚合（最弱 + 覆盖率三计数） |
| `apps/server/src/modules/parent-insights/goals.service.ts` | `/goals/attainment` 读 + `PUT /goals/{metric}` 写 + 达成值分派 |
| `apps/server/src/modules/practice/mastery.service.ts` | **判题侧**的掌握度回写（与上表同名不同职责，注意路径） |
| `apps/web/src/pages/parent/ParentGoalsPage.tsx` | `/parent/goals` 真页（读目标 + 改目标） |
| `apps/web/src/components/business/parent/SpecialsPanel.tsx` | 仪表盘的专项卡（四模块） |
| `apps/web/src/components/business/parent/MasteryPanel.tsx` | 报告页的真掌握度卡 |

**修改（后端）**

| 文件 | 改什么 |
|---|---|
| `tools/db/schema.sql` | 同步 `special_practice_logs`（§16 附近）+ `goals` 的 `metric` 列与唯一键（§8） |
| `apps/server/src/database/repositories/index.ts` | 三个新仓储的 barrel 导出 |
| `apps/server/src/modules/training/training.service.ts` | `judgeDictation` / `judgeInterpretation` 各写一行 `special_practice_logs` |
| `apps/server/src/modules/training/meaning.service.ts` | `judgeMeaning` 写一行 |
| `apps/server/src/modules/training/vocabulary.service.ts` | `judge` 写一行 |
| `apps/server/src/modules/training/training.module.ts` | provide 新仓储 |
| `apps/server/src/modules/practice/judge-core.service.ts` | 对错出口调 `MasteryService` |
| `apps/server/src/modules/practice/practice.module.ts` | provide + export `MasteryService`（仿 `ExplanationCacheService`） |
| `apps/server/src/modules/parent-insights/parent-insights.controller.ts` | 加 3 个 `@Get` + 1 个 `@Put` |
| `apps/server/src/modules/parent-insights/parent-insights.module.ts` | providers 加三个 service + 三个仓储 |
| `apps/server/src/modules/parent-insights/dto/parent-insights.dto.ts` | 加 4 组响应类型 + 1 个请求类型 |

**修改（前端）**

| 文件 | 改什么 |
|---|---|
| `apps/web/src/routes/routeTable.tsx:330` | `/parent/goals` 的 `<Placeholder>` → `<ParentGoalsPage />` |
| `apps/web/src/services/api.ts` | 家长端学情段（L2098–L2139 之后）加 6 个类型 + 4 个方法 |
| `apps/web/src/pages/parent/ParentDashboardPage.tsx` | 每个孩子的 panel 加专项卡 |
| `apps/web/src/pages/parent/ParentReportPage.tsx` | 加真掌握度卡（**保留**既有「薄弱知识点」卡） |

**文档**

| 文件 | 改什么 |
|---|---|
| `docs/API接口与数据流设计文档.md` | §4.13 加 4 端点 + 新增 §4.24（专项/掌握度数据流）+ goals 旧 CRUD 标废弃 + 变更日志 v4.3 |
| `docs/api/openapi.yaml` | 同步 4 条路径 + schema；goals 旧 CRUD 标注 deprecated |
| `docs/K12智学系统-数据库设计文档.md` | `special_practice_logs` 表 + `goals.metric` |
| `docs/ai-core-changelog.md` | 追加 1B 条目（含两处裁决与四处口径） |
| 根 `CLAUDE.md` | 「独立子系统」「工程约定」按需补一条 |

---

### Task 1: 迁移与 schema —— `special_practice_logs` 建表 + `goals` 加 `metric` 与唯一键

**Files:**
- Create: `tools/db/migrations/2026-09-22_special_practice_logs_and_goals.sql`
- Modify: `tools/db/schema.sql`（新增 §17 段放 `special_practice_logs`；改 §8 的 `goals` 列定义与键）

**Interfaces:**
- Consumes: 无（本任务是全批的第一个）
- Produces: 表 `special_practice_logs`（列名见下）、`goals.metric` 列与唯一键 `uniq_goals_student_metric (student_id, metric)`

**背景（为什么这么设计，别改）**
- `special_practice_logs` 属**独立子系统**：**只挂 `student_id` 一个外键**，`ref_id` **故意不设外键**——否则内容表（`chinese_passages` / `english_words`）全量重灌会被入向外键卡死（同 `student_word_progress.word_id` 的既有教训）。
- `metric` 为 `NULL` 的历史行按 `daily_study_minutes` 解释（spec §4.7），故迁移里**回填**。
- 写端点要「按 metric upsert」，所以需要**唯一键 `(student_id, metric)`**。MySQL 的唯一索引允许多个 `NULL`，故回填后剩下的 `NULL` 行（被停用的重复行）不会互相冲突。
- **`period` 不是列**：它由 `metric` 决定（`daily_study_minutes`/`daily_words` → `daily`；`weekly_passages`/`weekly_clear_errors` → `weekly`），由代码派生。`goals.period` 列仍要填，见 Task 6。

- [ ] **Step 1: 写迁移文件**

创建 `tools/db/migrations/2026-09-22_special_practice_logs_and_goals.sql`，内容**逐字**如下（顶部注释块是本仓迁移的既有惯例：写清「做什么 / 为什么 / 怎么回滚」）：

```sql
-- 2026-09-22 埋点 Phase 1B：special_practice_logs 建表 + goals 加 metric 列与唯一键
--
-- 做什么：
--   1) 新建 special_practice_logs（专项练习日志，spec §4.4）——语文三专项 + 英语背单词的判题流水
--   2) goals 加 metric 列（spec §4.7），并把 NULL 历史行按 daily_study_minutes 回填
--   3) 给 goals 加唯一键 uniq_goals_student_metric (student_id, metric)，供「按 metric upsert」
--
-- 为什么：
--   * special_practice_logs 是独立子系统：只挂 student_id 一个外键，ref_id 故意不设外键
--     （内容表全量重灌会被入向外键卡死，同 student_word_progress.word_id 的教训）
--   * goals.metric 为 NULL 的历史行按 daily_study_minutes 解释（spec §4.7 原文）
--   * 写端点走「按 metric upsert」，必须有唯一键可 ON DUPLICATE KEY
--
-- 幂等：建表用 IF NOT EXISTS；加列/加索引/回填/去重全部带守卫，可重复执行
-- 回滚：DROP TABLE special_practice_logs；ALTER TABLE goals DROP KEY uniq_goals_student_metric,
--       DROP COLUMN metric（无数据损失——metric 是本批新加的）

-- ── 1. 专项练习日志 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS special_practice_logs (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id     BIGINT       NOT NULL,
  module         VARCHAR(32)  NOT NULL COMMENT 'chinese_dictation|chinese_interpretation|chinese_meaning|en_vocabulary',
  subject_id     BIGINT       DEFAULT NULL,
  ref_type       VARCHAR(24)  NOT NULL COMMENT 'passage|word',
  ref_id         BIGINT       DEFAULT NULL COMMENT 'passage_id / word_id；**故意不设外键**（同 student_word_progress.word_id）',
  ref_key        VARCHAR(128) DEFAULT NULL COMMENT '篇目标题 / 词面快照，便于排查与无 id 场景',
  sentence_index SMALLINT     DEFAULT NULL COMMENT '解释/含义专项逐句；默写/背词为 NULL',
  verdict        VARCHAR(20)  NOT NULL COMMENT 'correct|incorrect|off_target|unanswered|undetermined',
  is_correct     TINYINT(1)   DEFAULT NULL COMMENT 'correct=1 / incorrect=0 / 其它 NULL（沿用「空答案不计对错」）',
  error_counted  TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '必须复用 normalize-english.util 的 progressDelta 判决',
  session_uid    CHAR(36)     DEFAULT NULL,
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_spl_student_module_time (student_id, module, created_at),
  KEY idx_spl_student_ref         (student_id, module, ref_id),
  KEY idx_spl_time                (created_at),
  CONSTRAINT fk_spl_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 2. goals 加 metric 列（MySQL 8/9 无 ADD COLUMN IF NOT EXISTS，只能守卫）──
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'goals' AND COLUMN_NAME = 'metric'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE goals ADD COLUMN metric VARCHAR(40) DEFAULT NULL COMMENT ''daily_study_minutes|daily_words|weekly_passages|weekly_clear_errors''',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 3. 回填：metric 为 NULL 的历史行 = 每日学习时长目标 ──
UPDATE goals SET metric = 'daily_study_minutes' WHERE metric IS NULL;

-- ── 4. 去重：同一 (student_id, metric) 只留 id 最大的那条，其余停用并清 metric ──
--   必须放在加唯一键之前，否则历史重复行会让 ADD UNIQUE KEY 直接失败。
--   用派生表而不是 IN (SELECT ... FROM goals)，绕过 MySQL「不能在同一语句里更新并查询同表」的限制。
UPDATE goals g
  JOIN (
    SELECT student_id, metric, MAX(id) AS keep_id
    FROM goals WHERE metric IS NOT NULL
    GROUP BY student_id, metric HAVING COUNT(*) > 1
  ) d ON g.student_id = d.student_id AND g.metric = d.metric AND g.id <> d.keep_id
SET g.is_active = 0, g.metric = NULL;

-- ── 5. goals 加唯一键 (student_id, metric) ──
SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'goals' AND INDEX_NAME = 'uniq_goals_student_metric'
);
SET @ddl := IF(@idx_exists = 0,
  'ALTER TABLE goals ADD UNIQUE KEY uniq_goals_student_metric (student_id, metric)',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
```

- [ ] **Step 2: 手工 apply 迁移**

仓库**没有迁移运行器**，在仓库根手工执行：

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
mysql -u ai_k12 -pai_k12 ai_k12 < tools/db/migrations/2026-09-22_special_practice_logs_and_goals.sql
```

Expected: **无任何输出**（成功即静默）。若报 `ERROR 1064` 说明 `PREPARE` 里的引号转义写错了；若报 `ERROR 1075` 或唯一键冲突说明去重步骤没生效。

> ⚠️ 本机 mysql 客户端是 Homebrew 9.5，**非交互 `-e` 下不认 `\G`**——要看建表语句请用 `--vertical`。

- [ ] **Step 3: 验证表与键（5 项断言，逐条跑）**

```bash
mysql -u ai_k12 -pai_k12 ai_k12 -N -e "
SELECT CONCAT('columns=', COUNT(*)) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='special_practice_logs';
SELECT CONCAT('fk=', COUNT(*)) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='special_practice_logs' AND CONSTRAINT_TYPE='FOREIGN KEY';
SELECT CONCAT('datetim3=', COUNT(*)) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='special_practice_logs'
    AND DATA_TYPE='datetime' AND DATETIME_PRECISION=3;
SELECT CONCAT('triggers=', COUNT(*)) FROM information_schema.TRIGGERS
  WHERE EVENT_OBJECT_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE='special_practice_logs';
SELECT CONCAT('goals_metric=', COUNT(*)) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='goals' AND COLUMN_NAME='metric';
SELECT CONCAT('goals_uniq=', COUNT(*)) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='goals' AND INDEX_NAME='uniq_goals_student_metric';
"
```

Expected: `columns=13`、`fk=1`、`datetim3=1`、`triggers=0`、`goals_metric=1`、`goals_uniq=2`（唯一键两列各一行，故是 2）。

> 2026-09-22 执行订正：原写 `columns=14` 是数错——Step 1 的 DDL 就是 13 列（`id`/`student_id`/`module`/`subject_id`/`ref_type`/`ref_id`/`ref_key`/`sentence_index`/`verdict`/`is_correct`/`error_counted`/`session_uid`/`created_at`），实测库中亦为 13。**以 DDL 为准，不是补一列。**

- [ ] **Step 4: 幂等复跑**

```bash
mysql -u ai_k12 -pai_k12 ai_k12 < tools/db/migrations/2026-09-22_special_practice_logs_and_goals.sql && echo "RE-APPLY OK（幂等）"
```

Expected: `RE-APPLY OK（幂等）`，且 Step 3 的六条数字不变。

- [ ] **Step 5: 同步 `tools/db/schema.sql`**

两处改动：

**(a)** 在 §16「学习会话（2026-09-21，埋点 Phase 1A）」段之后、`SET FOREIGN_KEY_CHECKS = 1;` 之前，新增 §17 段，**把 Step 1 里那条完整的 `CREATE TABLE IF NOT EXISTS special_practice_logs (...)` 语句逐字粘进来**（含全部注释与索引）：

```sql
-- ============================================================
-- 17. 专项练习日志（2026-09-22，埋点 Phase 1B）
-- ============================================================
-- 语文三专项 + 英语背单词的判题流水。独立子系统：只挂 student_id 一个外键，
-- ref_id 故意不设外键（内容表全量重灌会被入向外键卡死）。
-- 迁移：tools/db/migrations/2026-09-22_special_practice_logs_and_goals.sql

<把 Step 1 的 CREATE TABLE 语句整段粘到这里，一个字符都不要改>
```

**(b)** 改 §8 的 `goals` 定义：在 `subject_id` 之后插入 `metric` 列，并在 `KEY idx_goals_student (student_id, is_active),` 之后加唯一键。改完该表的 `CREATE TABLE` 应为：

```sql
CREATE TABLE IF NOT EXISTS goals (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  subject_id BIGINT DEFAULT NULL,
  metric VARCHAR(40) DEFAULT NULL COMMENT 'daily_study_minutes|daily_words|weekly_passages|weekly_clear_errors',
  title VARCHAR(200) NOT NULL,
  period VARCHAR(10) NOT NULL,
  target_value SMALLINT NOT NULL,
  reminder_enabled TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_goals_student (student_id, is_active),
  UNIQUE KEY uniq_goals_student_metric (student_id, metric),
  CONSTRAINT fk_goals_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_goals_subject_id FOREIGN KEY (subject_id) REFERENCES subjects (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 6: 验证迁移与 `schema.sql` 的建表语句逐字一致**

这是本仓的硬约定（无迁移运行器，两处必须同源）：

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
diff <(sed -n '/^CREATE TABLE IF NOT EXISTS special_practice_logs/,/^) ENGINE=InnoDB/p' tools/db/migrations/2026-09-22_special_practice_logs_and_goals.sql) \
     <(sed -n '/^CREATE TABLE IF NOT EXISTS special_practice_logs/,/^) ENGINE=InnoDB/p' tools/db/schema.sql) \
  && echo "special_practice_logs: IDENTICAL"
diff <(sed -n '/^CREATE TABLE IF NOT EXISTS goals/,/^) ENGINE=InnoDB/p' tools/db/schema.sql | grep -E 'metric|uniq_goals_student_metric') \
     <(echo "  metric VARCHAR(40) DEFAULT NULL COMMENT 'daily_study_minutes|daily_words|weekly_passages|weekly_clear_errors',
  UNIQUE KEY uniq_goals_student_metric (student_id, metric),") \
  && echo "goals: 新列与新键都在 schema.sql 里"
```

Expected: 两行 `IDENTICAL` / 都在。

- [ ] **Step 7: 提交**

```bash
git add tools/db/migrations/2026-09-22_special_practice_logs_and_goals.sql tools/db/schema.sql
git commit -m "feat(db): special_practice_logs 建表 + goals 加 metric 与唯一键（埋点 Phase 1B）"
```

---

### Task 2: `SpecialPracticeLogsRepository`（唯一写入口 + 三个聚合读）

**Files:**
- Create: `apps/server/src/database/repositories/special-practice-logs.repo.ts`
- Test: `apps/server/src/database/repositories/special-practice-logs.repo.test.ts`
- Modify: `apps/server/src/database/repositories/index.ts`（追加两行 barrel 导出）

**Interfaces:**
- Consumes: `DATABASE_POOL`（全局池）
- Produces（后面的 Task 3/4/7 都依赖这些名字，**逐字照抄**）：
  - `type SpecialPracticeModule = 'chinese_dictation' | 'chinese_interpretation' | 'chinese_meaning' | 'en_vocabulary'`
  - `type SpecialPracticeVerdict = 'correct' | 'incorrect' | 'off_target' | 'unanswered' | 'undetermined'`
  - `interface SpecialPracticeLogInsert`（字段见 Step 3）
  - `class SpecialPracticeLogsRepository`，四个方法：
    - `insert(row: SpecialPracticeLogInsert): Promise<number>`
    - `aggregateByModule(studentId: number, from: Date, toExclusive: Date): Promise<Array<{ module: SpecialPracticeModule; units: number; answered: number; correct: number }>>`
    - `countByDayByModule(studentId: number, from: Date, toExclusive: Date): Promise<Array<{ module: SpecialPracticeModule; day: string; count: number }>>`
    - `countDistinctCorrectWords(studentId: number, from: Date, toExclusive: Date): Promise<number>`

**两处口径决定（写进代码注释，别当实现细节）**
- **`units` = `COUNT(*)`**：因为每个专项的**一行 = 一个作答单位**（默写=一篇、解释/含义=一句、背单词=一道题）。所以三张专项共用同一个计数表达式，不需要按 module 分别写。
- **`answered` = `SUM(is_correct IS NOT NULL)`**：与家长端既有正确率口径一致（**排除** `unanswered`/`undetermined` 这类「没有明确对错」的行）。`rate` 在 service 层用 `toRate(answered, correct)` 算，**注意该函数签名是 `(answered, correct)`**，别把顺序写反。

- [ ] **Step 1: 写失败测试**

创建 `apps/server/src/database/repositories/special-practice-logs.repo.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { SpecialPracticeLogsRepository } from './special-practice-logs.repo.js';

/** 复刻 mysql2 的双返回形状 [rows, fields]（同 point-ledger.repo.test.ts） */
const mockPool = () => ({
  execute: vi.fn().mockResolvedValue([[], []]),
  query: vi.fn().mockResolvedValue([[], []]),
});

describe('SpecialPracticeLogsRepository', () => {
  it('insert：11 个占位符按列顺序绑参，subject_id 显式传 null', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([{ insertId: 77 }, []]);
    const repo = new SpecialPracticeLogsRepository(pool as any);

    const id = await repo.insert({
      studentId: 11,
      module: 'chinese_dictation',
      refType: 'passage',
      refId: 3,
      refKey: '静夜思',
      sentenceIndex: null,
      verdict: 'incorrect',
      isCorrect: false,
      errorCounted: true,
      sessionUid: null,
    });

    expect(id).toBe(77);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('INSERT INTO special_practice_logs');
    expect(sql).toContain('(student_id, module, subject_id, ref_type, ref_id, ref_key, sentence_index, verdict, is_correct, error_counted, session_uid)');
    expect(params).toEqual([11, 'chinese_dictation', null, 'passage', 3, '静夜思', null, 'incorrect', 0, 1, null]);
  });

  it('aggregateByModule：SUM/COUNT 的字符串结果被 Number() 化，空结果给 []', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([
      [
        { module: 'chinese_dictation', units: '5', answered: '4', correct: '3' },
        { module: 'en_vocabulary', units: 2, answered: 2, correct: 1 },
      ],
      [],
    ]);
    const repo = new SpecialPracticeLogsRepository(pool as any);

    const rows = await repo.aggregateByModule(11, new Date('2026-09-13'), new Date('2026-09-20'));

    expect(rows).toEqual([
      { module: 'chinese_dictation', units: 5, answered: 4, correct: 3 },
      { module: 'en_vocabulary', units: 2, answered: 2, correct: 1 },
    ]);
    // answered 必须用 is_correct IS NOT NULL，不能用 COUNT(*)
    expect(pool.execute.mock.calls[0][0]).toContain('SUM(is_correct IS NOT NULL) AS answered');
    // 窗口参数化 + 半开区间，绝不用 CURDATE()
    expect(pool.execute.mock.calls[0][1]).toEqual([11, new Date('2026-09-13'), new Date('2026-09-20')]);
    expect(pool.execute.mock.calls[0][0]).not.toContain('CURDATE()');
  });

  it('aggregateByModule：无数据 → 空数组（由 service 补四个模块的 0，不在这里造行）', async () => {
    const repo = new SpecialPracticeLogsRepository(mockPool() as any);
    expect(await repo.aggregateByModule(11, new Date(), new Date())).toEqual([]);
  });

  it('countByDayByModule：按 module + 本地日期分组，计数 Number() 化', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([
      [
        { module: 'chinese_meaning', day: '2026-09-15', count: '3' },
        { module: 'chinese_meaning', day: '2026-09-16', count: 1 },
      ],
      [],
    ]);
    const repo = new SpecialPracticeLogsRepository(pool as any);

    const rows = await repo.countByDayByModule(11, new Date('2026-09-13'), new Date('2026-09-20'));

    expect(rows).toEqual([
      { module: 'chinese_meaning', day: '2026-09-15', count: 3 },
      { module: 'chinese_meaning', day: '2026-09-16', count: 1 },
    ]);
    // 对齐 parent-analytics.repo 的 byDay 写法
    expect(pool.execute.mock.calls[0][0]).toContain("DATE_FORMAT(created_at, '%Y-%m-%d') AS day");
    expect(pool.execute.mock.calls[0][0]).toContain('GROUP BY module, day');
  });

  it('countDistinctCorrectWords：只数 en_vocabulary 且 verdict=correct 的去重 ref_id', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([[{ words: '12' }], []]);
    const repo = new SpecialPracticeLogsRepository(pool as any);

    expect(await repo.countDistinctCorrectWords(11, new Date('2026-09-13'), new Date('2026-09-20'))).toBe(12);
    const sql = pool.execute.mock.calls[0][0] as string;
    expect(sql).toContain('COUNT(DISTINCT ref_id)');
    expect(sql).toContain("module = 'en_vocabulary'");
    expect(sql).toContain("verdict = 'correct'");
  });

  it('countDistinctCorrectWords：无数据返回 0（不是 null）', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([[{ words: null }], []]);
    const repo = new SpecialPracticeLogsRepository(pool as any);

    expect(await repo.countDistinctCorrectWords(11, new Date(), new Date())).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/server && npx vitest run src/database/repositories/special-practice-logs.repo.test.ts
```

Expected: FAIL —— `Failed to resolve import "./special-practice-logs.repo.js"`（文件还不存在）。

- [ ] **Step 3: 写实现**

创建 `apps/server/src/database/repositories/special-practice-logs.repo.ts`：

```ts
import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

/** 四个专项模块（与 `special_practice_logs.module` 的列注释逐字一致）。 */
export type SpecialPracticeModule =
  | 'chinese_dictation'
  | 'chinese_interpretation'
  | 'chinese_meaning'
  | 'en_vocabulary';

/**
 * 统一 verdict 字典（与 `special_practice_logs.verdict` 的列注释一致）。
 *
 * ⚠️ 英语那边原始枚举里叫 `wrong`，**入库前映射成 `incorrect`**（见 Task 4）：
 * 这一列是跨专项的统一字典，不该出现 `wrong` 这个同义词。
 */
export type SpecialPracticeVerdict =
  | 'correct'
  | 'incorrect'
  | 'off_target'
  | 'unanswered'
  | 'undetermined';

export interface SpecialPracticeLogInsert {
  studentId: number;
  module: SpecialPracticeModule;
  refType: 'passage' | 'word';
  /** passage_id / word_id；无 id 场景可为 null（故列上不设外键）。 */
  refId: number | null;
  /** 篇目标题 / 词面快照，便于排查。 */
  refKey: string | null;
  /** 解释/含义专项逐句；默写/背词为 null。 */
  sentenceIndex: number | null;
  verdict: SpecialPracticeVerdict;
  /** correct → true / incorrect → false / 其它 → null（沿用「空答案不计对错」）。 */
  isCorrect: boolean | null;
  errorCounted: boolean;
  sessionUid: string | null;
}

/**
 * 专项练习日志：**唯一写入口** + 三个聚合读（埋点 Phase 1B）。
 *
 * 独立子系统：只挂 `student_id` 一个外键。**不挂 `questions`、不进错题本、不参与清零门禁**。
 */
@Injectable()
export class SpecialPracticeLogsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /** 写一行。返回自增 id（调用方只用于日志，不落业务字段）。 */
  async insert(row: SpecialPracticeLogInsert): Promise<number> {
    // subject_id 恒传 null：专项内容表本身没有学科维度，学科可由 module 前缀推出（chinese_* / en_vocabulary）。
    // 若将来要按学科过滤，正确做法是按 module 白名单筛，而不是回填这一列。
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO special_practice_logs
       (student_id, module, subject_id, ref_type, ref_id, ref_key, sentence_index, verdict, is_correct, error_counted, session_uid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.studentId,
        row.module,
        null,
        row.refType,
        row.refId,
        row.refKey,
        row.sentenceIndex,
        row.verdict,
        row.isCorrect === null ? null : row.isCorrect ? 1 : 0,
        row.errorCounted ? 1 : 0,
        row.sessionUid,
      ],
    );
    return result.insertId;
  }

  /**
   * 按 module 聚合「单位数 / 有明确对错数 / 正确数」。
   *
   * `units = COUNT(*)`：每个专项**一行就是一个作答单位**（默写=一篇、解释/含义=一句、背单词=一道题）。
   * `answered = SUM(is_correct IS NOT NULL)`：与家长端既有正确率口径一致，**排除**没有明确对错的行。
   * `rate` 不在这里算——service 层用 `toRate(answered, correct)`（注意签名是 (answered, correct)）。
   */
  async aggregateByModule(
    studentId: number,
    from: Date,
    toExclusive: Date,
  ): Promise<
    Array<{ module: SpecialPracticeModule; units: number; answered: number; correct: number }>
  > {
    const [rows] = await this.pool.execute<
      (RowDataPacket & {
        module: SpecialPracticeModule;
        units: number | string | null;
        answered: number | string | null;
        correct: number | string | null;
      })[]
    >(
      `SELECT module,
              COUNT(*)                    AS units,
              SUM(is_correct IS NOT NULL) AS answered,
              SUM(is_correct = 1)         AS correct
       FROM special_practice_logs
       WHERE student_id = ? AND created_at >= ? AND created_at < ?
       GROUP BY module
       ORDER BY module`,
      [studentId, from, toExclusive],
    );
    return rows.map((r) => ({
      module: r.module,
      units: Number(r.units ?? 0),
      answered: Number(r.answered ?? 0),
      correct: Number(r.correct ?? 0),
    }));
  }

  /**
   * 按 module + 日期分组的单位数（喂家长端柱状图）。
   *
   * 日期在 SQL 里用 `DATE_FORMAT(created_at, '%Y-%m-%d')` 切——与 `parent-analytics.repo.ts`
   * 的 byDay 完全同一写法（同机同库，DB 会话时区与 Node 一致，故和「应用层算窗口」不冲突）。
   * **窗口边界仍然由应用层算好传参**，不用 `CURDATE()`。
   */
  async countByDayByModule(
    studentId: number,
    from: Date,
    toExclusive: Date,
  ): Promise<Array<{ module: SpecialPracticeModule; day: string; count: number }>> {
    const [rows] = await this.pool.execute<
      (RowDataPacket & { module: SpecialPracticeModule; day: string; count: number | string | null })[]
    >(
      `SELECT module,
              DATE_FORMAT(created_at, '%Y-%m-%d') AS day,
              COUNT(*)                            AS count
       FROM special_practice_logs
       WHERE student_id = ? AND created_at >= ? AND created_at < ?
       GROUP BY module, day
       ORDER BY day`,
      [studentId, from, toExclusive],
    );
    return rows.map((r) => ({ module: r.module, day: r.day, count: Number(r.count ?? 0) }));
  }

  /**
   * 窗口内**答对过的去重词数**，即 `/specials` 里 vocabulary 的 `newWords`。
   *
   * 口径说明（写进注释是为了别被「新词」二字带偏）：它是「本期答对过的不同单词数」，
   * 不是「本期第一次学会的词数」——后者需要跨窗口历史，`special_practice_logs` 单窗口查不出来。
   */
  async countDistinctCorrectWords(
    studentId: number,
    from: Date,
    toExclusive: Date,
  ): Promise<number> {
    const [rows] = await this.pool.execute<(RowDataPacket & { words: number | string | null })[]>(
      `SELECT COUNT(DISTINCT ref_id) AS words
       FROM special_practice_logs
       WHERE student_id = ? AND module = 'en_vocabulary' AND verdict = 'correct'
         AND ref_id IS NOT NULL AND created_at >= ? AND created_at < ?`,
      [studentId, from, toExclusive],
    );
    return Number(rows[0]?.words ?? 0);
  }
}
```

- [ ] **Step 4: 加 barrel 导出**

在 `apps/server/src/database/repositories/index.ts` **末尾**追加两行（不要重排该文件）：

```ts
export { SpecialPracticeLogsRepository } from './special-practice-logs.repo.js';
export type {
  SpecialPracticeLogInsert,
  SpecialPracticeModule,
  SpecialPracticeVerdict,
} from './special-practice-logs.repo.js';
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd apps/server && npx vitest run src/database/repositories/special-practice-logs.repo.test.ts && npx tsc --noEmit
```

Expected: `6 passed`，`tsc` 无输出（通过）。

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/database/repositories/special-practice-logs.repo.ts \
        apps/server/src/database/repositories/special-practice-logs.repo.test.ts \
        apps/server/src/database/repositories/index.ts
git commit -m "feat(analytics): SpecialPracticeLogsRepository —— 专项日志唯一写入口 + 三个聚合读"
```

---

### Task 3: 纯函数 util + 语文三专项的写入点

**Files:**
- Create: `apps/server/src/common/utils/special-practice.util.ts`
- Test: `apps/server/src/common/utils/special-practice.util.test.ts`
- Modify: `apps/server/src/modules/training/training.service.ts`（`judgeDictation`、`judgeInterpretation` 各写一行）
- Modify: `apps/server/src/modules/training/meaning.service.ts`（`judgeMeaning` 写一行）
- Modify: 承载上述两个 service 的模块的 `providers`（见 Step 5）

**Interfaces:**
- Consumes: `SpecialPracticeLogsRepository`（Task 2）、`SpecialPracticeVerdict`（Task 2 导出的类型）
- Produces:
  - `isCorrectOf(verdict: SpecialPracticeVerdict): boolean | null`
  - `collapseUnitVerdict(items: ReadonlyArray<{ correct: boolean | null; method: string }>): SpecialPracticeVerdict`

**为什么需要 `collapseUnitVerdict`（先看这段再动手）**
- 解释/含义专项是**逐句**作答，而**一句话**的判定由「若干字词项 + 翻译项（含义专项还多一个情感项）」组成。日志表一行 = 一个作答单位 = **一句**，所以必须把多项塌缩成一个句级 verdict。
- 塌缩**不能只看 `correct`**：按现有实现，`unanswered` 的项也是 `correct: false`（见 `training.service.ts` 的 slot 构造），所以必须**结合 `method`**。
- 优先级（顺序就是语义，别调换）：**确定错 → 没能判定 → 没作答 → 全对**。理由：「LLM 判错」比「LLM 失败」更确定；「LLM 失败」比「孩子没写」更值得记为待查；只有全部为真才是 `correct`。

- [ ] **Step 1: 写失败测试（表驱动）**

创建 `apps/server/src/common/utils/special-practice.util.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { collapseUnitVerdict, isCorrectOf } from './special-practice.util.js';

describe('isCorrectOf', () => {
  it('只有 correct/incorrect 是明确对错，其余一律 null', () => {
    expect(isCorrectOf('correct')).toBe(true);
    expect(isCorrectOf('incorrect')).toBe(false);
    expect(isCorrectOf('off_target')).toBeNull();
    expect(isCorrectOf('unanswered')).toBeNull();
    expect(isCorrectOf('undetermined')).toBeNull();
  });
});

describe('collapseUnitVerdict', () => {
  const ok = { correct: true, method: 'exact' };
  const aiOk = { correct: true, method: 'ai' };
  const aiWrong = { correct: false, method: 'ai' };
  const blank = { correct: false, method: 'unanswered' };
  const unknown = { correct: null, method: 'undetermined' };

  it.each([
    ['全对 → correct', [ok, aiOk], 'correct'],
    ['有一项 LLM 判错 → incorrect', [ok, aiWrong], 'incorrect'],
    // 优先级：确定错压过「没作答」
    ['判错 + 没作答 → incorrect', [aiWrong, blank], 'incorrect'],
    // 优先级：没能判定压过「没作答」
    ['没能判定 + 没作答 → undetermined', [unknown, blank], 'undetermined'],
    ['只有没作答 → unanswered', [ok, blank], 'unanswered'],
    ['全没能判定 → undetermined', [unknown, unknown], 'undetermined'],
    // 空集合不该出现（一句话至少有一个待判项），但要有个确定行为而不是抛
    ['空数组 → undetermined（不该发生，但不能抛）', [], 'undetermined'],
  ])('%s', (_name, items, expected) => {
    expect(collapseUnitVerdict(items as any)).toBe(expected);
  });

  it('纯函数：不改动入参', () => {
    const items = [{ correct: false, method: 'ai' }];
    collapseUnitVerdict(items);
    expect(items).toEqual([{ correct: false, method: 'ai' }]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/server && npx vitest run src/common/utils/special-practice.util.test.ts
```

Expected: FAIL —— `Failed to resolve import "./special-practice.util.js"`。

- [ ] **Step 3: 写实现**

创建 `apps/server/src/common/utils/special-practice.util.ts`：

```ts
import type { SpecialPracticeVerdict } from '../../database/repositories/special-practice-logs.repo.js';

/**
 * 专项日志的两个**纯函数**（埋点 Phase 1B）。
 *
 * 放在 `common/utils` 而不是各 service 里：待判项的形状（`{correct, method}`）是三个专项共用的，
 * 塌缩规则若各写一份，两个专项很快会给出不一致的 verdict——而家长端的正确率就是按它算的。
 */

/** `correct` / `incorrect` 才是明确对错；`off_target` / `unanswered` / `undetermined` 都不是。 */
export function isCorrectOf(verdict: SpecialPracticeVerdict): boolean | null {
  if (verdict === 'correct') return true;
  if (verdict === 'incorrect') return false;
  return null;
}

/** 待判项的形状——解释/含义专项的 slot（字词项、翻译项、含义项、情感项）都长这样。 */
export interface UnitItem {
  correct: boolean | null;
  method: string;
}

/**
 * 把一句话的若干待判项塌缩成**句级 verdict**。
 *
 * 优先级（顺序即语义，勿调换）：确定错 → 没能判定 → 没作答 → 全对。
 * **不能只看 `correct`**：`unanswered` 的项也是 `correct: false`，必须结合 `method`。
 */
export function collapseUnitVerdict(items: ReadonlyArray<UnitItem>): SpecialPracticeVerdict {
  if (items.length === 0) return 'undetermined';
  // ① 有「不是没作答、但被判错」的项 → 整句算错
  if (items.some((i) => i.correct === false && i.method !== 'unanswered')) return 'incorrect';
  // ② 有没能判定的项 → 整句记为待查（比「没作答」优先：那是要追查的系统问题）
  if (items.some((i) => i.method === 'undetermined')) return 'undetermined';
  // ③ 有没作答的项 → 整句记为没作答
  if (items.some((i) => i.method === 'unanswered')) return 'unanswered';
  // ④ 剩下只能是全对（防御：若出现 correct === null 而 method 不是上面两者，也归为待查）
  return items.every((i) => i.correct === true) ? 'correct' : 'undetermined';
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/server && npx vitest run src/common/utils/special-practice.util.test.ts
```

Expected: `9 passed`（1 个 isCorrectOf + 7 个 it.each + 1 个纯函数用例）。

- [ ] **Step 5: 接线 —— 三个写入点**

三个写入点的**共同写法**（照抄这个骨架，只换 payload）：

```ts
try {
  await this.specialLogsRepo.insert({ /* payload */ });
} catch (err) {
  // 埋点绝不阻断判题：失败只 warn（spec 的四条规则之④）
  this.logger.warn('special_practice_logs 写入失败（已忽略，不影响判题）', err);
}
```

**先做两件准备**：
1. 两个 service 各注入 `SpecialPracticeLogsRepository`（构造函数参数，类型用具体类即可——它是 class token，不触发 Nest 的接口参数坑），并确认各自有 `private readonly logger = new Logger(XxxService.name)`（没有就加，与其他 service 同款）。
2. 先找模块：`grep -rn "MeaningService\|TrainingService" apps/server/src/modules/*/*.module.ts`。在**实际承载这两个 service 的模块**的 `providers` 里加 `SpecialPracticeLogsRepository`（它只依赖全局 `DATABASE_POOL`，按模块 provide 是本仓既有惯例）。若 `MeaningService` 与 `TrainingService` 不在同一模块，**两个模块都要加**。

**(a) `training.service.ts` 的 `judgeDictation`** —— 在 `judged` 已算出（`judgeCore.judgeDictation` 返回之后）、`return` 之前插入：

```ts
// 专项日志：默写的作答单位是「一篇」，一行记一篇
const dictationVerdict: SpecialPracticeVerdict = judged.isCorrect ? 'correct' : 'incorrect';
try {
  await this.specialLogsRepo.insert({
    studentId: input.studentId,
    module: 'chinese_dictation',
    refType: 'passage',
    refId: passage.id,
    refKey: passage.work_title ?? null,
    sentenceIndex: null,
    verdict: dictationVerdict,
    isCorrect: isCorrectOf(dictationVerdict),
    errorCounted: dictationVerdict === 'incorrect',
    sessionUid: null,
  });
} catch (err) {
  this.logger.warn('special_practice_logs 写入失败（已忽略，不影响判题）', err);
}
```

**(b) `training.service.ts` 的 `judgeInterpretation`** —— 在该方法已经算出「所有项判定」的位置（现在算 `allCorrect` 的那一带）之后插入：

```ts
// 专项日志：解释专项逐句作答，一行记一句；句级 verdict 由「字词项 + 翻译项」塌缩而来
const interpretationVerdict = collapseUnitVerdict([...termItems, sentSlot]);
try {
  await this.specialLogsRepo.insert({
    studentId: input.studentId,
    module: 'chinese_interpretation',
    refType: 'passage',
    refId: passage.id,
    refKey: passage.work_title ?? null,
    sentenceIndex: input.sentenceIndex,
    verdict: interpretationVerdict,
    isCorrect: isCorrectOf(interpretationVerdict),
    errorCounted: interpretationVerdict === 'incorrect',
    sessionUid: null,
  });
} catch (err) {
  this.logger.warn('special_practice_logs 写入失败（已忽略，不影响判题）', err);
}
```

> ⚠️ 局部变量名以**文件为准**：解释专项里是 `termItems` 与 `sentSlot`（`allCorrect` 就是它俩拼出来的）。若实际叫别的名字，用实际的那两个——**不要**为了对齐 plan 去重命名生产变量。

**(c) `meaning.service.ts` 的 `judgeMeaning`** —— 同「计算 `allCorrect` 的那一带」之后：

```ts
// 专项日志：含义专项逐句作答，一行记一句；句级 verdict 由「字词项 + 含义项 + 情感项」塌缩而来
const meaningVerdict = collapseUnitVerdict([...terms, meaningSlot, emotionSlot]);
try {
  await this.specialLogsRepo.insert({
    studentId: input.studentId,
    module: 'chinese_meaning',
    refType: 'passage',
    refId: passage.id,
    refKey: passage.work_title ?? null,
    sentenceIndex: input.sentenceIndex,
    verdict: meaningVerdict,
    isCorrect: isCorrectOf(meaningVerdict),
    errorCounted: meaningVerdict === 'incorrect',
    sessionUid: null,
  });
} catch (err) {
  this.logger.warn('special_practice_logs 写入失败（已忽略，不影响判题）', err);
}
```

**关于 `errorCounted` 与 `sessionUid` 的两个口径（写进注释）**
- 语文三专项没有 `off_target` 这个概念，也不复用英语的 `progressDelta`（它只吃英语的五档枚举）。这里的口径是：**只有 `incorrect` 计错**，`unanswered` / `undetermined` 都不计——精神与 `progressDelta` 一致（只算「确定错」），但**实现必须是本文件这套**，不要去 import 英语那个函数。
- `sessionUid` 本期恒 `null`：1B 不做「把这次学习会话与做的专项串起来」，留列给后续（`study_sessions.session_uid` 已在 1A 落地）。

- [ ] **Step 6: 加一条写入点测试（钉住「失败不阻断判题」+ payload 形状）**

在 `apps/server/src/modules/training/training.service.test.ts`（已存在）追加一条；若 `meaning.service.ts` 有自己的测试文件则在其中追加一条同构用例：

```ts
  it('默写判题会写一行专项日志；日志写入失败**不阻断**判题', async () => {
    const d = mkDeps();                       // 沿用该文件既有的 mkDeps 风格
    const svc = mkService(d);
    d.specialLogsRepo.insert.mockRejectedValueOnce(new Error('db down'));

    const res = await svc.judgeDictation({
      studentId: 7, passageId: 3, author: '李白', dynasty: '唐', body: '床前明月光',
    });

    // 判题结果照常返回（这是本条用例的重点）
    expect(res).toHaveProperty('isCorrect');
    expect(d.specialLogsRepo.insert).toHaveBeenCalledWith(expect.objectContaining({
      studentId: 7, module: 'chinese_dictation', refType: 'passage', refId: 3,
      sentenceIndex: null, errorCounted: expect.any(Boolean),
    }));
  });
```

> 该用例需要 `mkDeps()` 里多一个 `specialLogsRepo: { insert: vi.fn() }`，并在 `mkService` 里作为新构造参数传入——**先读该文件现有的 mkDeps/mkService 再改**，别照抄本段示例的名字。

- [ ] **Step 7: 跑该模块测试 + 全量后端测试 + 类型检查**

```bash
cd apps/server && npx vitest run src/modules/training src/common/utils/special-practice.util.test.ts && npx tsc --noEmit
cd apps/server && npm test 2>&1 | tail -5
```

Expected: 定向用例全绿；`tsc` 无输出；全量为 **`103 passed` 文件、`1268 + 新增` 条全绿**（1A 结束时是 1268）。

- [ ] **Step 8: 提交**

```bash
git add apps/server/src/common/utils/special-practice.util.ts \
        apps/server/src/common/utils/special-practice.util.test.ts \
        apps/server/src/modules/training/
git commit -m "feat(analytics): 语文三专项判题点写 special_practice_logs（含句级 verdict 塌缩）"
```

---

### Task 4: 英语背单词的写入点（复用 `progressDelta`，映射 `wrong → incorrect`）

**Files:**
- Modify: `apps/server/src/modules/training/vocabulary.service.ts`（`judge` 方法内，`delta` 算出之后）
- Modify: 承载 `VocabularyService` 的模块的 `providers`（若与 Task 3 同模块则已加过）
- Test: `apps/server/src/modules/training/vocabulary.service.test.ts`（追加）

**Interfaces:**
- Consumes: `SpecialPracticeLogsRepository`（Task 2）、`isCorrectOf`（Task 3）、既有的 `progressDelta`（`common/utils/normalize-english.util.ts:83`）
- Produces: 无新导出（纯接线）

**三条口径（都要写进代码注释）**
1. **`wrong → incorrect` 的入库映射**：英语原始枚举是 `wrong`，而 `special_practice_logs.verdict` 的列注释是跨专项统一字典（`correct|incorrect|off_target|unanswered|undetermined`，**没有 `wrong`**）。所以写库前把 `wrong` 映射成 `incorrect`，**不能**把 `wrong` 直接写进去。
2. **`errorCounted` 必须复用 `progressDelta(outcome.verdict)` 的 `wrongDelta`**，不另写一套判断（spec §4.4 明文要求）。注意要用**原始 verdict**（`'wrong'`）去调它，不是映射后的。
3. **义项下标本期不入库**（见 Step 2 的说明）。

- [ ] **Step 1: 追加测试**

在 `apps/server/src/modules/training/vocabulary.service.test.ts` 追加：

```ts
  it('判题后写一行专项日志：wrong 映射成 incorrect，errorCounted 取 progressDelta', async () => {
    const d = mkDeps();                          // 沿用该文件既有 mkDeps
    const svc = mkService(d);
    d.specialLogsRepo = { insert: vi.fn().mockResolvedValue(1) };
    // ……用该文件既有的方式把 wordId/答案构造成「中→英拼错」这一路（纯程序判定，不调 LLM）
    //    具体构造照抄该文件里已有的「中→英 拼错」用例

    await svc.judge({ wordId: 42, senseIndex: 0, promptKind: 'cn2en', answer: 'recieve' }, 7);

    expect(d.specialLogsRepo.insert).toHaveBeenCalledWith(expect.objectContaining({
      studentId: 7,
      module: 'en_vocabulary',
      refType: 'word',
      refId: 42,
      verdict: 'incorrect',      // ← 原始是 'wrong'
      isCorrect: false,
      errorCounted: true,        // ← 来自 progressDelta('wrong').wrongDelta
      sentenceIndex: null,
    }));
  });

  it('答对：verdict=correct、errorCounted=false', async () => {
    // 同上，用「中→英拼对」这一路
    await svc.judge({ wordId: 42, senseIndex: 0, promptKind: 'cn2en', answer: 'receive' }, 7);
    expect(d.specialLogsRepo.insert).toHaveBeenCalledWith(expect.objectContaining({
      verdict: 'correct', isCorrect: true, errorCounted: false,
    }));
  });

  it('日志写入失败不阻断判题', async () => {
    const d = mkDeps();
    const svc = mkService(d);
    d.specialLogsRepo = { insert: vi.fn().mockRejectedValue(new Error('db down')) };

    await expect(
      svc.judge({ wordId: 42, senseIndex: 0, promptKind: 'cn2en', answer: 'receive' }, 7),
    ).resolves.toHaveProperty('verdict');
  });
```

> 该文件若无 `specialLogsRepo` 字段，需在 `mkDeps()` 里补一个 `{ insert: vi.fn() }` 并作为新构造参数传给 `mkService` —— **先读文件再改**。

- [ ] **Step 2: 实现接线**

在 `vocabulary.service.ts` 里：
1. 构造函数注入 `private readonly specialLogsRepo: SpecialPracticeLogsRepository`；
2. 在 `const delta = progressDelta(outcome.verdict);`（现约 `:433`）之后、`return` 之前插入：

```ts
    // 专项日志：英语的作答单位是「词的一个义项」，一行记一道题。
    //
    // ⚠️ 义项下标（senseIndex）**本期不入库**：spec §4.4 的 DDL 没有这一列，且
    // `sentence_index` 的列注释写明「默写/背词为 NULL」。所以想知道「哪个义项容易错」
    // 目前做不到——那需要加列或改 spec，属 spec 变更，**先与用户确认再做**，别偷偷塞进
    // sentence_index（会污染「逐句」这个语义）或 ref_key（它语义是词面快照）。
    //
    // 入库映射：英语原始枚举叫 'wrong'，而本表的 verdict 是跨专项统一字典（没有 'wrong'），
    // 故映射成 'incorrect'。errorCounted 用**原始** verdict 走 progressDelta，不另写一套。
    const logVerdict: SpecialPracticeVerdict =
      outcome.verdict === 'wrong' ? 'incorrect' : outcome.verdict;
    try {
      await this.specialLogsRepo.insert({
        studentId,
        module: 'en_vocabulary',
        refType: 'word',
        refId: row.id,
        refKey: row.word,
        sentenceIndex: null,
        verdict: logVerdict,
        isCorrect: isCorrectOf(logVerdict),
        errorCounted: delta.wrongDelta === 1,
        sessionUid: null,
      });
    } catch (err) {
      this.logger.warn('special_practice_logs 写入失败（已忽略，不影响判题）', err);
    }
```

- [ ] **Step 3: 跑测试 + 类型检查**

```bash
cd apps/server && npx vitest run src/modules/training/vocabulary.service.test.ts && npx tsc --noEmit
```

Expected: 全绿（含新增 3 条），`tsc` 无输出。

- [ ] **Step 4: 提交**

```bash
git add apps/server/src/modules/training/vocabulary.service.ts \
        apps/server/src/modules/training/vocabulary.service.test.ts
git commit -m "feat(analytics): 英语背单词判题点写 special_practice_logs（wrong→incorrect 映射）"
```

---

### Task 5: 掌握度回写 —— `StudentKnowledgeMasteryRepository` + `MasteryService` + 挂到判题出口

**Files:**
- Create: `apps/server/src/database/repositories/student-knowledge-mastery.repo.ts`
- Test: `apps/server/src/database/repositories/student-knowledge-mastery.repo.test.ts`
- Create: `apps/server/src/modules/practice/mastery.service.ts`
- Test: `apps/server/src/modules/practice/mastery.service.test.ts`
- Modify: `apps/server/src/database/repositories/questions.repo.ts`（加 `findKnowledgePointIdsByQuestion`）
- Modify: `apps/server/src/database/repositories/index.ts`（barrel）
- Modify: `apps/server/src/modules/practice/judge-core.service.ts`（对错出口调用）
- Modify: `apps/server/src/modules/practice/practice.module.ts`（provide + export）

**Interfaces:**
- Consumes: `DATABASE_POOL`、`QuestionsRepository`（新增的方法）
- Produces（Task 7 依赖，**逐字照抄**）：
  - `class StudentKnowledgeMasteryRepository`：
    - `upsertOnJudge(studentId: number, knowledgePointId: number, isCorrect: boolean): Promise<void>`
    - `listWeakest(studentId: number, limit: number): Promise<Array<{ knowledgePointId: number; name: string; masteryScore: number; level: number; correctCount: number; errorCount: number; lastSeenAt: Date | null }>>`
    - `countQuestionCoverage(): Promise<{ coveredQuestions: number; totalQuestions: number }>`
  - `class MasteryService`（practice 模块）：`recordFromJudge(input: { studentId: number; questionId: number | null; isCorrect: boolean | null }): Promise<void>`

**四条规则（spec §4.8，代码注释里逐条写明）**
1. 只在该题**绑了 KP** 时写（`question_knowledge_points` 实测只覆盖 **203/530 ≈ 38%**，家长端必须显式展示「未覆盖」计数）。
2. `isCorrect === null`（空答案 / `self_assess` 待评）**不写**。
3. `questionId == null` **跳过**。
4. 失败**只 warn，不阻断判题**。

- [ ] **Step 1: 写仓储测试**

创建 `apps/server/src/database/repositories/student-knowledge-mastery.repo.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { StudentKnowledgeMasteryRepository } from './student-knowledge-mastery.repo.js';

const mockPool = () => ({
  execute: vi.fn().mockResolvedValue([[], []]),
  query: vi.fn().mockResolvedValue([[], []]),
});

describe('StudentKnowledgeMasteryRepository', () => {
  it('upsertOnJudge：用 AS new 别名写法（VALUES() 在 MySQL 8.0.20+ 已废弃）', async () => {
    const pool = mockPool();
    const repo = new StudentKnowledgeMasteryRepository(pool as any);

    await repo.upsertOnJudge(11, 42, true);

    const sql = pool.execute.mock.calls[0][0] as string;
    expect(sql).toContain('INSERT INTO student_knowledge_mastery');
    expect(sql).toContain('AS new');
    expect(sql).not.toContain('VALUES(');          // 不许用已废弃写法
    expect(sql).toContain('ON DUPLICATE KEY UPDATE');
    // 累加而不是覆盖
    expect(sql).toContain('correct_count = student_knowledge_mastery.correct_count + new.correct_count');
    expect(sql).toContain('error_count   = student_knowledge_mastery.error_count   + new.error_count');
    // 分数与段位由累计值现算，且分母用 NULLIF 防除零
    expect(sql).toContain('NULLIF');
    expect(sql).toContain('FLOOR(5 *');
    // 首次插入：答对 → correct=1,error=0,score=1,level=5
    expect(pool.execute.mock.calls[0][1]).toEqual([11, 42, 1, 0, 1, 5]);
  });

  it('upsertOnJudge：答错 → correct=0,error=1,score=0,level=0', async () => {
    const pool = mockPool();
    const repo = new StudentKnowledgeMasteryRepository(pool as any);

    await repo.upsertOnJudge(11, 42, false);

    expect(pool.execute.mock.calls[0][1]).toEqual([11, 42, 0, 1, 0, 0]);
  });

  it('listWeakest：JOIN knowledge_points 取名字，按 mastery_score 升序，Number() 化', async () => {
    const pool = mockPool();
    pool.query.mockResolvedValueOnce([
      [{ knowledge_point_id: 42, name: '分数加减', mastery_score: '0.500', level: '2',
         correct_count: '3', error_count: '3', last_seen_at: new Date('2026-09-16T10:00:00Z') }],
      [],
    ]);
    const repo = new StudentKnowledgeMasteryRepository(pool as any);

    const rows = await repo.listWeakest(11, 10);

    expect(rows).toEqual([{
      knowledgePointId: 42, name: '分数加减', masteryScore: 0.5, level: 2,
      correctCount: 3, errorCount: 3, lastSeenAt: new Date('2026-09-16T10:00:00Z'),
    }]);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('ORDER BY mastery_score ASC');
    // LIMIT ? 必须用 query（客户端转义），execute 会被 MySQL 拒绝——既有约定
    expect(params).toEqual([11, 10]);
  });

  it('countQuestionCoverage：分母是 questions 总数，分子是去重后有 KP 的题数', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([[{ total: '530', covered: '203' }], []]);
    const repo = new StudentKnowledgeMasteryRepository(pool as any);

    expect(await repo.countQuestionCoverage()).toEqual({ coveredQuestions: 203, totalQuestions: 530 });
    const sql = pool.execute.mock.calls[0][0] as string;
    expect(sql).toContain('COUNT(DISTINCT question_id)');
    expect(sql).toContain('FROM questions');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/server && npx vitest run src/database/repositories/student-knowledge-mastery.repo.test.ts
```

Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 写仓储实现**

创建 `apps/server/src/database/repositories/student-knowledge-mastery.repo.ts`：

```ts
import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface WeakMasteryRow {
  knowledgePointId: number;
  name: string;
  masteryScore: number;
  level: number;
  correctCount: number;
  errorCount: number;
  lastSeenAt: Date | null;
}

/**
 * 知识点掌握度：**唯一写入口** + 家长端两个读（埋点 Phase 1B）。
 *
 * 这张表在 1B 之前是**死表**（全仓唯一命中是一句注释），本批由 `MasteryService` 在判题出口回写。
 * 写侧只碰 `student_knowledge_mastery`；`question_knowledge_points` 的读取在 `questions.repo.ts`。
 */
@Injectable()
export class StudentKnowledgeMasteryRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /**
   * 判题后 UPSERT 一条（spec §4.8）。
   *
   * 用 `AS new` 别名而不是 `VALUES()`（后者在 MySQL 8.0.20+ 已废弃）。
   * 首次插入时 score/level 由**本次**的对错给出（答对 1.0/5、答错 0.0/0）。
   *
   * ⚠️ **2026-09-22 执行期实测订正**（原 snippet 有 bug，已同步改 spec §4.8）：
   *   MySQL 的 ODKU SET 子句**从左到右求值，后面的表达式读到的是前面刚写入的值**。
   *   故（a）计数列必须写在 score/level 之前；（b）score/level 里**绝不能再写 `+ new.correct_count`**，
   *   否则本次增量算两遍——实测 1 对 + 1 错本应 0.500，旧式得 **0.333**，且会被后续判题持续放大。
   */
  async upsertOnJudge(studentId: number, knowledgePointId: number, isCorrect: boolean): Promise<void> {
    const correctDelta = isCorrect ? 1 : 0;
    const errorDelta = isCorrect ? 0 : 1;
    const score = isCorrect ? 1 : 0;
    const level = isCorrect ? 5 : 0;
    await this.pool.execute(
      `INSERT INTO student_knowledge_mastery
         (student_id, knowledge_point_id, correct_count, error_count, mastery_score, level, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW(3)) AS new
       ON DUPLICATE KEY UPDATE
         correct_count = student_knowledge_mastery.correct_count + new.correct_count,
         error_count   = student_knowledge_mastery.error_count   + new.error_count,
         mastery_score = student_knowledge_mastery.correct_count
                       / NULLIF(student_knowledge_mastery.correct_count + student_knowledge_mastery.error_count, 0),
         level         = FLOOR(5 * (student_knowledge_mastery.correct_count
                       / NULLIF(student_knowledge_mastery.correct_count + student_knowledge_mastery.error_count, 0))),
         last_seen_at  = NOW(3)`,
      [studentId, knowledgePointId, correctDelta, errorDelta, score, level],
    );
  }

  /** 最弱的 N 个知识点（家长端 `/mastery`）；`limit` 由 service 夹在 1..50。 */
  async listWeakest(studentId: number, limit: number): Promise<WeakMasteryRow[]> {
    // LIMIT ? 必须用 pool.query（客户端转义），execute 会被 MySQL 拒绝——既有约定
    const [rows] = await this.pool.query<
      (RowDataPacket & {
        knowledge_point_id: number; name: string; mastery_score: number | string | null;
        level: number; correct_count: number | string | null; error_count: number | string | null;
        last_seen_at: Date | null;
      })[]
    >(
      `SELECT skm.knowledge_point_id, kp.name, skm.mastery_score, skm.level,
              skm.correct_count, skm.error_count, skm.last_seen_at
       FROM student_knowledge_mastery skm
       JOIN knowledge_points kp ON kp.id = skm.knowledge_point_id
       WHERE skm.student_id = ?
       ORDER BY mastery_score ASC, error_count DESC, skm.knowledge_point_id ASC
       LIMIT ?`,
      [studentId, limit],
    );
    return rows.map((r) => ({
      knowledgePointId: Number(r.knowledge_point_id),
      name: r.name,
      masteryScore: Number(r.mastery_score ?? 0),
      level: Number(r.level ?? 0),
      correctCount: Number(r.correct_count ?? 0),
      errorCount: Number(r.error_count ?? 0),
      lastSeenAt: r.last_seen_at,
    }));
  }

  /**
   * 题库的 KP 覆盖率（家长端必须展示，否则家长会以为「薄弱点只有这几个」）。
   * 实测基线：530 题里 203 题有 KP（38%）。
   */
  async countQuestionCoverage(): Promise<{ coveredQuestions: number; totalQuestions: number }> {
    const [rows] = await this.pool.execute<
      (RowDataPacket & { total: number | string | null; covered: number | string | null })[]
    >(
      `SELECT (SELECT COUNT(*) FROM questions)                          AS total,
              (SELECT COUNT(DISTINCT question_id) FROM question_knowledge_points) AS covered`,
    );
    return {
      coveredQuestions: Number(rows[0]?.covered ?? 0),
      totalQuestions: Number(rows[0]?.total ?? 0),
    };
  }
}
```

- [ ] **Step 4: 给 `questions.repo.ts` 加按题取 KP**

在 `apps/server/src/database/repositories/questions.repo.ts` 追加（紧邻既有的 `bindKnowledgePoint`）：

```ts
  /** 该题绑定的知识点 id（掌握度回写用；无绑定返回空数组，不是 null）。 */
  async findKnowledgePointIdsByQuestion(questionId: number): Promise<number[]> {
    const [rows] = await this.pool.execute<(RowDataPacket & { knowledge_point_id: number })[]>(
      `SELECT knowledge_point_id FROM question_knowledge_points WHERE question_id = ?`,
      [questionId],
    );
    return rows.map((r) => Number(r.knowledge_point_id));
  }
```

> 确认该文件已 import `RowDataPacket`；没有就补 `import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';` 里缺的那项。

同时把 `StudentKnowledgeMasteryRepository` 加进 `repositories/index.ts` 的 barrel（与 Task 2 同款两行）。

- [ ] **Step 5: 写 `MasteryService` 的测试**

创建 `apps/server/src/modules/practice/mastery.service.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { MasteryService } from './mastery.service.js';

const mk = () => ({
  questionsRepo: { findKnowledgePointIdsByQuestion: vi.fn().mockResolvedValue([42]) },
  masteryRepo: { upsertOnJudge: vi.fn().mockResolvedValue(undefined) },
});
const mkSvc = (d = mk()) =>
  new MasteryService(d.questionsRepo as any, d.masteryRepo as any);

describe('MasteryService.recordFromJudge', () => {
  it('答对：每个绑定的 KP 各写一条（isCorrect=true）', async () => {
    const d = mk();
    d.questionsRepo.findKnowledgePointIdsByQuestion.mockResolvedValue([42, 43]);

    await mkSvc(d).recordFromJudge({ studentId: 11, questionId: 330, isCorrect: true });

    expect(d.masteryRepo.upsertOnJudge).toHaveBeenCalledTimes(2);
    expect(d.masteryRepo.upsertOnJudge).toHaveBeenCalledWith(11, 42, true);
    expect(d.masteryRepo.upsertOnJudge).toHaveBeenCalledWith(11, 43, true);
  });

  it('规则③ questionId 为 null → 不查不写', async () => {
    const d = mk();

    await mkSvc(d).recordFromJudge({ studentId: 11, questionId: null, isCorrect: true });

    expect(d.questionsRepo.findKnowledgePointIdsByQuestion).not.toHaveBeenCalled();
    expect(d.masteryRepo.upsertOnJudge).not.toHaveBeenCalled();
  });

  it('规则② isCorrect 为 null（空答案 / 待自评）→ 不查不写', async () => {
    const d = mk();

    await mkSvc(d).recordFromJudge({ studentId: 11, questionId: 330, isCorrect: null });

    expect(d.questionsRepo.findKnowledgePointIdsByQuestion).not.toHaveBeenCalled();
    expect(d.masteryRepo.upsertOnJudge).not.toHaveBeenCalled();
  });

  it('规则① 该题没绑 KP → 不写任何行', async () => {
    const d = mk();
    d.questionsRepo.findKnowledgePointIdsByQuestion.mockResolvedValue([]);

    await mkSvc(d).recordFromJudge({ studentId: 11, questionId: 330, isCorrect: false });

    expect(d.masteryRepo.upsertOnJudge).not.toHaveBeenCalled();
  });

  it('规则④ 仓储抛错 → 不冒泡（埋点不阻断判题）', async () => {
    const d = mk();
    d.masteryRepo.upsertOnJudge.mockRejectedValue(new Error('db down'));

    await expect(
      mkSvc(d).recordFromJudge({ studentId: 11, questionId: 330, isCorrect: true }),
    ).resolves.toBeUndefined();
  });

  it('规则④ 取 KP 抛错 → 同样不冒泡', async () => {
    const d = mk();
    d.questionsRepo.findKnowledgePointIdsByQuestion.mockRejectedValue(new Error('db down'));

    await expect(
      mkSvc(d).recordFromJudge({ studentId: 11, questionId: 330, isCorrect: true }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 6: 写 `MasteryService`**

创建 `apps/server/src/modules/practice/mastery.service.ts`：

```ts
import { Injectable, Logger } from '@nestjs/common';
import { QuestionsRepository } from '../../database/repositories/questions.repo.js';
import { StudentKnowledgeMasteryRepository } from '../../database/repositories/student-knowledge-mastery.repo.js';

/**
 * 判题后的**知识点掌握度回写**（spec §4.8）。
 *
 * 四条规则（逐条对应 spec 原文，改动前先读）：
 *   ① 只在该题**绑了 KP** 时写——`question_knowledge_points` 实测只覆盖 203/530 题（38%），
 *      所以家长端必须**显式展示未覆盖计数**，否则家长会以为「薄弱点只有这几个」；
 *   ② `isCorrect === null`（空答案 / `self_assess` 待评）**不写**；
 *   ③ `questionId == null` **跳过**；
 *   ④ 失败只 warn，**不阻断判题**（判题是主链路，掌握度是派生数据）。
 *
 * 为什么单独立一个 service 而不是塞进 `JudgeCoreService`：`JudgeCoreService` 已经很大，
 * 而且回写要注入两个仓储——分开后它能被单独表驱动测试（spec §15 的必测项之一）。
 */
@Injectable()
export class MasteryService {
  private readonly logger = new Logger(MasteryService.name);

  constructor(
    private readonly questionsRepo: QuestionsRepository,
    private readonly masteryRepo: StudentKnowledgeMasteryRepository,
  ) {}

  async recordFromJudge(input: {
    studentId: number;
    questionId: number | null;
    isCorrect: boolean | null;
  }): Promise<void> {
    // 规则③④之前的两道闸门：任何一条不满足都直接返回，且**不做任何 IO**
    if (input.questionId === null) return;
    if (input.isCorrect === null) return;
    const questionId = input.questionId;
    const isCorrect = input.isCorrect;

    try {
      const kpIds = await this.questionsRepo.findKnowledgePointIdsByQuestion(questionId);
      // 规则①：没绑 KP 就什么都不写（这是常态，不是异常）
      for (const kpId of kpIds) {
        await this.masteryRepo.upsertOnJudge(input.studentId, kpId, isCorrect);
      }
    } catch (err) {
      // 规则④
      this.logger.warn('掌握度回写失败（已忽略，不影响判题）', err);
    }
  }
}
```

- [ ] **Step 7: 挂到判题出口 + 模块接线**

**(a)** `judge-core.service.ts`：构造函数注入 `private readonly masteryService: MasteryService`；在 `judgeQuestion` 的**统一返回点之前**（现约 `:240` 的 `return { questionId, isCorrect, ... }` 之前）插入：

```ts
    // 掌握度回写（spec §4.8）：只判对错的客观题才写，空答案 / 待自评由 service 内部挡掉
    await this.masteryService.recordFromJudge({ studentId: input.studentId, questionId, isCorrect });
```

> ⚠️ **必须 `await`** 吗？不必——它是「派生数据、失败只 warn」，可以 `void`。但 `judgeQuestion` 是 `async`，直接 `await` 会让判题多两次 DB 往返（取 KP + UPSERT）。**选 `void`**（fire-and-forget），并加注释说明为什么：主链路延迟不该被埋点拖长。测试要相应改成「等一个微任务」再断言（见 Step 8）。
>
> **2026-09-22 执行期调整（已实现，勿改回）**：`judgeQuestion` 里**不只有一个**返回点——路由 0（题目无标准答案）与路由 1c（主观题 self_assess）都是 **isCorrect=null 的早退**。若只在最后那个统一 `return` 前插一行，这两条路径就绕过了掌握度回写，Step 8 的第 2 条用例也永远不可能绿。
> 实现改为抽一个私有出口方法 `finishJudge(studentId, out)`（`void` 回写 + 原样返回 `out`），三个返回点一律 `return this.finishJudge(input.studentId, {...})`。好处：调用点仍然**不做** `isCorrect === null` 判断（规则②只留在 `MasteryService` 里，杜绝两处漂移），且服务只被调一次。

**(b)** `practice.module.ts`：`providers` 加 `StudentKnowledgeMasteryRepository` 与 `MasteryService`；`exports` 加 `MasteryService`（供将来别的模块复用，与 `ExplanationCacheService` 同款做法）。**注意**：`StudentKnowledgeMasteryRepository` 只在本模块 provide 一次（重复 provide 会得到两份实例）。

- [ ] **Step 8: 补 `judge-core.service.test.ts` 的接线用例**

在既有测试文件里追加（`mkDeps()` 需补 `masteryService: { recordFromJudge: vi.fn() }`）：

```ts
  it('客观题判完会把对错交给 MasteryService（fire-and-forget，不拖慢判题）', async () => {
    const d = mkDeps();
    const svc = mkSvc(d);

    await svc.judgeQuestion({ studentId: 1, subjectId: 1, questionId: 10, studentAnswer: 'A', source: 'targeted' });
    // fire-and-forget：必须让出一次微任务再断言
    await Promise.resolve();

    expect(d.masteryService.recordFromJudge).toHaveBeenCalledWith({
      studentId: 1, questionId: 10, isCorrect: true,
    });
  });

  it('空答案（isCorrect=null）也照样交给 service —— 挡在 service 里，不在调用点分叉', async () => {
    const d = mkDeps();
    const svc = mkSvc(d);

    await svc.judgeQuestion({ studentId: 1, subjectId: 1, questionId: 10, studentAnswer: '', source: 'targeted' });
    await Promise.resolve();

    // 调用点**不做** isCorrect === null 的判断：规则②统一在 MasteryService 里守，避免两处漂移
    expect(d.masteryService.recordFromJudge).toHaveBeenCalledWith({
      studentId: 1, questionId: 10, isCorrect: null,
    });
  });
```

> ⚠️ **2026-09-22 执行期订正**：上面第 2 条用例的夹具必须让 `isCorrect` **真的是 null**。
> 路由 0 的守卫看的是**题目**有没有标准答案（`!q.answer`），不是学生答案空不空——
> 拿一个 `answer: 'A'` 的 choice 题配 `studentAnswer: ''` 只会得到 `isCorrect: false`（判错），用例会假绿/假红。
> 实现时应把 `questionsRepo.findById` 返回成 `{ id: 10, type: 'choice', answer: '' }`（题目无标准答案 → 路由 0 → null）；
> 另建议再补一条主观题 `self_assess` 路径（`type: 'short_answer'`）的同构断言，两条早退路径都钉住。

> 若该文件既有的用例用 `mkService` 而非 `mkSvc`，按实际名字来。

- [ ] **Step 9: 跑全部相关测试 + 类型检查 + 全量**

```bash
cd apps/server && npx vitest run src/modules/practice src/database/repositories/student-knowledge-mastery.repo.test.ts && npx tsc --noEmit
cd apps/server && npm test 2>&1 | tail -5
```

Expected: 全绿；`tsc` 无输出；全量文件数 `103 passed`，用例数为 `1268 + Task 2/3/4/5 新增`。

- [ ] **Step 10: 提交**

```bash
git add apps/server/src/database/repositories/student-knowledge-mastery.repo.ts \
        apps/server/src/database/repositories/student-knowledge-mastery.repo.test.ts \
        apps/server/src/database/repositories/questions.repo.ts \
        apps/server/src/database/repositories/index.ts \
        apps/server/src/modules/practice/
git commit -m "feat(analytics): 掌握度回写 —— MasteryService 挂判题出口 + 仓储与覆盖率读"
```

---

### Task 6: `GoalsRepository`（懒初始化 + 按 metric upsert）

**Files:**
- Create: `apps/server/src/database/repositories/goals.repo.ts`
- Test: `apps/server/src/database/repositories/goals.repo.test.ts`
- Modify: `apps/server/src/database/repositories/index.ts`（barrel）

**Interfaces:**
- Produces（Task 8 依赖）：
  - `type GoalMetric = 'daily_study_minutes' | 'daily_words' | 'weekly_passages' | 'weekly_clear_errors'`
  - `type GoalPeriod = 'daily' | 'weekly'`
  - `interface GoalRow { id: number; metric: GoalMetric | null; period: string; targetValue: number; title: string }`
  - `class GoalsRepository`：
    - `findActiveByStudent(studentId: number): Promise<GoalRow[]>`
    - `ensureDefaults(studentId: number, defaults: ReadonlyArray<{ metric: GoalMetric; period: GoalPeriod; title: string; target: number }>): Promise<void>`
    - `upsertTarget(studentId: number, metric: GoalMetric, period: GoalPeriod, title: string, target: number): Promise<void>`

**两个关键设计（别改）**
- **懒初始化必须用 `INSERT IGNORE`**，不能用 `ON DUPLICATE KEY UPDATE`：后者会把家长**已经设过**的目标值覆盖回默认值（唯一键是 `(student_id, metric)`，冲突时会走 UPDATE）。`INSERT IGNORE` 遇到已存在就跳过——正是「只补缺失的默认目标」的语义。
- **显式保存（PUT）才用 `ON DUPLICATE KEY UPDATE`**，并把 `is_active` 置回 1（家长重新启用一个曾被停用的目标）。

- [ ] **Step 1: 写失败测试**

创建 `apps/server/src/database/repositories/goals.repo.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { GoalsRepository } from './goals.repo.js';

const mockPool = () => ({
  execute: vi.fn().mockResolvedValue([[], []]),
  query: vi.fn().mockResolvedValue([[], []]),
});

describe('GoalsRepository', () => {
  it('ensureDefaults：必须用 INSERT IGNORE（否则会覆盖家长已设的值）', async () => {
    const pool = mockPool();
    const repo = new GoalsRepository(pool as any);

    await repo.ensureDefaults(11, [
      { metric: 'daily_study_minutes', period: 'daily', title: '每日学习时长', target: 60 },
      { metric: 'daily_words', period: 'daily', title: '每日背单词', target: 20 },
    ]);

    expect(pool.execute).toHaveBeenCalledTimes(2);
    const sql = pool.execute.mock.calls[0][0] as string;
    expect(sql).toContain('INSERT IGNORE INTO goals');
    expect(sql).not.toContain('ON DUPLICATE KEY UPDATE');
    expect(pool.execute.mock.calls[0][1]).toEqual([11, 'daily_study_minutes', 'daily', '每日学习时长', 60]);
  });

  it('ensureDefaults：空数组不发任何 SQL', async () => {
    const pool = mockPool();
    const repo = new GoalsRepository(pool as any);

    await repo.ensureDefaults(11, []);

    expect(pool.execute).not.toHaveBeenCalled();
  });

  it('upsertTarget：ON DUPLICATE KEY UPDATE 更新目标值并把 is_active 置回 1', async () => {
    const pool = mockPool();
    const repo = new GoalsRepository(pool as any);

    await repo.upsertTarget(11, 'weekly_passages', 'weekly', '每周古诗文篇目', 8);

    const sql = pool.execute.mock.calls[0][0] as string;
    expect(sql).toContain('INSERT INTO goals');
    expect(sql).toContain('ON DUPLICATE KEY UPDATE');
    expect(sql).toContain('target_value = new.target_value');
    expect(sql).toContain('is_active     = 1');
    expect(pool.execute.mock.calls[0][1]).toEqual([11, 'weekly_passages', 'weekly', '每周古诗文篇目', 8]);
  });

  it('findActiveByStudent：只取 is_active=1，返回 camelCase 且 Number() 化', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([
      [{ id: 7, metric: 'daily_words', period: 'daily', target_value: '20', title: '每日背单词' }],
      [],
    ]);
    const repo = new GoalsRepository(pool as any);

    const rows = await repo.findActiveByStudent(11);

    expect(rows).toEqual([
      { id: 7, metric: 'daily_words', period: 'daily', targetValue: 20, title: '每日背单词' },
    ]);
    expect(pool.execute.mock.calls[0][0]).toContain('is_active = 1');
    expect(pool.execute.mock.calls[0][1]).toEqual([11]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/server && npx vitest run src/database/repositories/goals.repo.test.ts
```

Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 写实现**

创建 `apps/server/src/database/repositories/goals.repo.ts`：

```ts
import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

/** 四个目标维度（与 `goals.metric` 的列注释逐字一致）。 */
export type GoalMetric =
  | 'daily_study_minutes'
  | 'daily_words'
  | 'weekly_passages'
  | 'weekly_clear_errors';

export type GoalPeriod = 'daily' | 'weekly';

export interface GoalRow {
  id: number;
  metric: GoalMetric | null;
  period: string;
  targetValue: number;
  title: string;
}

/**
 * `goals` 的读写（埋点 Phase 1B，复活这张死表）。
 *
 * 唯一键 `(student_id, metric)`（Task 1 加的）让「按 metric upsert」成立。
 * `metric` 为 NULL 的历史行按 `daily_study_minutes` 解释（迁移里已回填）。
 */
@Injectable()
export class GoalsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /** 该学生所有**启用中**的目标。 */
  async findActiveByStudent(studentId: number): Promise<GoalRow[]> {
    const [rows] = await this.pool.execute<
      (RowDataPacket & { id: number; metric: GoalMetric | null; period: string; target_value: number | string | null; title: string })[]
    >(
      `SELECT id, metric, period, target_value, title
       FROM goals
       WHERE student_id = ? AND is_active = 1
       ORDER BY id`,
      [studentId],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      metric: r.metric,
      period: r.period,
      targetValue: Number(r.target_value ?? 0),
      title: r.title,
    }));
  }

  /**
   * **只补缺失的**默认目标。
   *
   * ⚠️ 必须 `INSERT IGNORE`：唯一键是 `(student_id, metric)`，若用 `ON DUPLICATE KEY UPDATE`，
   * 家长已改过的目标会被默认值**覆盖回去**。IGNORE 遇到已存在就跳过，正是懒初始化要的语义。
   */
  async ensureDefaults(
    studentId: number,
    defaults: ReadonlyArray<{ metric: GoalMetric; period: GoalPeriod; title: string; target: number }>,
  ): Promise<void> {
    for (const d of defaults) {
      await this.pool.execute(
        `INSERT IGNORE INTO goals
           (student_id, subject_id, metric, title, period, target_value, reminder_enabled, is_active)
         VALUES (?, NULL, ?, ?, ?, ?, 0, 1)`,
        [studentId, d.metric, d.period, d.title, d.target],
      );
    }
  }

  /**
   * 家长显式保存某个 metric 的目标值（PUT 路径）。
   *
   * 用 `ON DUPLICATE KEY UPDATE`（与 `ensureDefaults` 相反，这里**就是**要覆盖），
   * 并把 `is_active` 置回 1——家长重新启用一个曾被停用的目标时不该另插一行。
   */
  async upsertTarget(
    studentId: number,
    metric: GoalMetric,
    period: GoalPeriod,
    title: string,
    target: number,
  ): Promise<void> {
    await this.pool.execute(
      `INSERT INTO goals
         (student_id, subject_id, metric, title, period, target_value, reminder_enabled, is_active)
       VALUES (?, NULL, ?, ?, ?, ?, 0, 1) AS new
       ON DUPLICATE KEY UPDATE
         target_value = new.target_value,
         period       = new.period,
         title        = new.title,
         is_active    = 1`,
      [studentId, metric, period, title, target],
    );
  }
}
```

- [ ] **Step 4: barrel + 跑测试**

`repositories/index.ts` 追加（与 Task 2 同款）：

```ts
export { GoalsRepository } from './goals.repo.js';
export type { GoalMetric, GoalPeriod, GoalRow } from './goals.repo.js';
```

```bash
cd apps/server && npx vitest run src/database/repositories/goals.repo.test.ts && npx tsc --noEmit
```

Expected: `4 passed`，`tsc` 无输出。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/database/repositories/goals.repo.ts \
        apps/server/src/database/repositories/goals.repo.test.ts \
        apps/server/src/database/repositories/index.ts
git commit -m "feat(analytics): GoalsRepository —— 懒初始化用 INSERT IGNORE、显式保存用 upsert"
```

---

### Task 7: 两个家长聚合 service —— `SpecialsService` + `ParentMasteryService`

**Files:**
- Create: `apps/server/src/modules/parent-insights/specials.service.ts`
- Test: `apps/server/src/modules/parent-insights/specials.service.test.ts`
- Create: `apps/server/src/modules/parent-insights/parent-mastery.service.ts`
- Test: `apps/server/src/modules/parent-insights/parent-mastery.service.test.ts`
- Modify: `apps/server/src/modules/parent-insights/dto/parent-insights.dto.ts`（加两组响应类型）

**Interfaces:**
- Consumes: `SpecialPracticeLogsRepository`（Task 2）、`StudentKnowledgeMasteryRepository`（Task 5）、`rate.util.ts` 的 `toRate`、`window.util.ts` 的 `resolveRange`（1A 已导出）
- Produces（Task 8 依赖）：
  - `class SpecialsService`：`getSpecials(studentId: number, from?: string, to?: string): Promise<SpecialsSummary>`
  - `class ParentMasteryService`：`getMastery(studentId: number, limit: number): Promise<MasterySummary>`
  - DTO：`SpecialsSummary`、`SpecialModuleSummary`、`MasterySummary`、`MasteryItem`

> ⚠️ **命名**：家长端这个类叫 `ParentMasteryService`（文件 `parent-mastery.service.ts`），因为 practice 模块已经有一个 `MasteryService`（Task 5，判题侧回写）。两者职责完全不同，**不要合并、不要同名**。

**`rate` 口径**（两个 service 都涉及）：`toRate(answered, correct)` —— **注意签名是 `(answered, correct)`**，别把参数顺序写反；`answered = 0` 返回 `null`，**不是 0**。

- [ ] **Step 1: 写 `SpecialsService` 的失败测试**

创建 `apps/server/src/modules/parent-insights/specials.service.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { SpecialsService } from './specials.service.js';

const mkRepo = () => ({
  aggregateByModule: vi.fn().mockResolvedValue([]),
  countByDayByModule: vi.fn().mockResolvedValue([]),
  countDistinctCorrectWords: vi.fn().mockResolvedValue(0),
});
const mkSvc = (repo = mkRepo()) => new SpecialsService(repo as any);

describe('SpecialsService', () => {
  it('四个模块一定都在：没数据的模块给 units=0 / correct=0 / rate=null / byDay=[]', async () => {
    const out = await mkSvc().getSpecials(11);

    expect(Object.keys(out)).toEqual(['dictation', 'interpretation', 'meaning', 'vocabulary']);
    expect(out.dictation).toEqual({ units: 0, correct: 0, rate: null, byDay: [] });
    // rate 必须是 null 而不是 0（spec §10 第 2 条）
    expect(out.vocabulary).toEqual({ units: 0, correct: 0, rate: null, byDay: [], newWords: 0 });
  });

  it('rate 用 toRate(answered, correct)；answered 排除没有明确对错的行', async () => {
    const repo = mkRepo();
    repo.aggregateByModule.mockResolvedValue([
      // 5 个单位，只有 4 个有明确对错，其中 3 个对 → 3/4 = 75%
      { module: 'chinese_dictation', units: 5, answered: 4, correct: 3 },
    ]);

    const out = await mkSvc(repo).getSpecials(11);

    expect(out.dictation).toMatchObject({ units: 5, correct: 3, rate: 75 });
  });

  it('byDay 按模块切分并映射成 {date, count}', async () => {
    const repo = mkRepo();
    repo.countByDayByModule.mockResolvedValue([
      { module: 'chinese_meaning', day: '2026-09-15', count: 3 },
      { module: 'en_vocabulary', day: '2026-09-16', count: 2 },
    ]);

    const out = await mkSvc(repo).getSpecials(11);

    expect(out.meaning.byDay).toEqual([{ date: '2026-09-15', count: 3 }]);
    expect(out.vocabulary.byDay).toEqual([{ date: '2026-09-16', count: 2 }]);
  });

  it('vocabulary 多一个 newWords，且只由 countDistinctCorrectWords 提供', async () => {
    const repo = mkRepo();
    repo.countDistinctCorrectWords.mockResolvedValue(12);

    const out = await mkSvc(repo).getSpecials(11);

    expect(out.vocabulary.newWords).toBe(12);
    // 其余三个模块没有这个字段
    expect(out.dictation).not.toHaveProperty('newWords');
  });

  it('窗口由 resolveRange 算好传参，仓储收到的是 Date 半开区间', async () => {
    const repo = mkRepo();

    await mkSvc(repo).getSpecials(11, '2026-09-13', '2026-09-19');

    const [, from, toExclusive] = repo.aggregateByModule.mock.calls[0];
    expect(from).toBeInstanceOf(Date);
    expect(toExclusive).toBeInstanceOf(Date);
    // 两端闭区间 → 排他上界是 09-20 的 00:00
    expect((toExclusive as Date).getTime() - (from as Date).getTime()).toBe(7 * 24 * 3_600_000);
  });
});
```

- [ ] **Step 2: 写 `SpecialsService` 实现**

创建 `apps/server/src/modules/parent-insights/specials.service.ts`：

```ts
import { Injectable } from '@nestjs/common';
import { SpecialPracticeLogsRepository } from '../../database/repositories/special-practice-logs.repo.js';
import type { SpecialPracticeModule } from '../../database/repositories/special-practice-logs.repo.js';
import { resolveRange } from './window.util.js';
import { toRate } from './rate.util.js';
import type { SpecialModuleSummary, SpecialsSummary } from './dto/parent-insights.dto.js';

/** 响应键（短名）→ 表里的 module（长名）。响应形状按 spec §8.2，用短名。 */
const MODULE_BY_KEY: Record<keyof SpecialsSummary, SpecialPracticeModule> = {
  dictation: 'chinese_dictation',
  interpretation: 'chinese_interpretation',
  meaning: 'chinese_meaning',
  vocabulary: 'en_vocabulary',
};

/**
 * 家长端专项学情（spec §8.2 `/specials`）：**只读聚合** `special_practice_logs`。
 *
 * 三条口径：
 *   1. **四个模块一定都在响应里**——没有数据的模块给 `units=0 / rate=null / byDay=[]`，
 *      让前端不必判空（与「未绑知识点时是空数组」同规矩）。
 *   2. `rate = toRate(answered, correct)`，`answered` 由仓储用 `is_correct IS NOT NULL` 统计
 *      （排除「没有明确对错」的行）。**`answered=0` → `null`，不是 0**。
 *   3. 只有 vocabulary 多一个 `newWords`（窗口内答对过的去重词数），其余三个模块没有这个键。
 */
@Injectable()
export class SpecialsService {
  constructor(private readonly logsRepo: SpecialPracticeLogsRepository) {}

  async getSpecials(studentId: number, from?: string, to?: string): Promise<SpecialsSummary> {
    // 窗口由应用层算（不用 CURDATE()）；resolveRange 的语义与 1A 的 study-time 完全一致
    // ⚠️ 2026-09-22 执行期订正：字段名是 start / endExclusive（原 snippet 写的 range.from 不存在，tsc 会直接报错）
    const window = resolveRange(from, to);

    const [agg, byDay, newWords] = await Promise.all([
      this.logsRepo.aggregateByModule(studentId, window.start, window.endExclusive),
      this.logsRepo.countByDayByModule(studentId, window.start, window.endExclusive),
      this.logsRepo.countDistinctCorrectWords(studentId, window.start, window.endExclusive),
    ]);

    const build = (module: SpecialPracticeModule): SpecialModuleSummary => {
      const row = agg.find((a) => a.module === module);
      return {
        units: row?.units ?? 0,
        correct: row?.correct ?? 0,
        rate: toRate(row?.answered ?? 0, row?.correct ?? 0),
        byDay: byDay.filter((d) => d.module === module).map((d) => ({ date: d.day, count: d.count })),
      };
    };

    return {
      dictation: build(MODULE_BY_KEY.dictation),
      interpretation: build(MODULE_BY_KEY.interpretation),
      meaning: build(MODULE_BY_KEY.meaning),
      vocabulary: { ...build(MODULE_BY_KEY.vocabulary), newWords },
    };
  }
}
```

> `resolveRange` 返回的字段名以 `window.util.ts` 实际为准（1A 的实现里是 `from` / `toExclusive`）；若字段名不同，用实际的那两个。**先读该文件**。

- [ ] **Step 3: 写 `ParentMasteryService` 的失败测试**

创建 `apps/server/src/modules/parent-insights/parent-mastery.service.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { ParentMasteryService } from './parent-mastery.service.js';

const mkRepo = () => ({
  listWeakest: vi.fn().mockResolvedValue([]),
  countQuestionCoverage: vi.fn().mockResolvedValue({ coveredQuestions: 203, totalQuestions: 530 }),
});
const mkSvc = (repo = mkRepo()) => new ParentMasteryService(repo as any);

describe('ParentMasteryService', () => {
  it('返回 items + 三个覆盖率计数；uncovered = total - covered', async () => {
    const repo = mkRepo();
    repo.listWeakest.mockResolvedValue([
      { knowledgePointId: 42, name: '分数加减', masteryScore: 0.5, level: 2,
        correctCount: 3, errorCount: 3, lastSeenAt: new Date('2026-09-16T10:00:00Z') },
    ]);

    const out = await mkSvc(repo).getMastery(11, 10);

    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ knowledgePointId: 42, name: '分数加减', masteryScore: 0.5, level: 2 });
    expect(out).toMatchObject({ coveredQuestions: 203, totalQuestions: 530, uncovered: 327 });
    expect(repo.listWeakest).toHaveBeenCalledWith(11, 10);
  });

  it('无掌握度数据 → items 空，但覆盖率计数照给（否则家长不知道是「没数据」还是「没覆盖」）', async () => {
    const out = await mkSvc().getMastery(11, 10);

    expect(out.items).toEqual([]);
    expect(out.uncovered).toBe(327);
  });

  it('lastSeenAt 为 null 时原样传 null（不编成 0）', async () => {
    const repo = mkRepo();
    repo.listWeakest.mockResolvedValue([
      { knowledgePointId: 42, name: 'x', masteryScore: 0, level: 0, correctCount: 0, errorCount: 0, lastSeenAt: null },
    ]);

    const out = await mkSvc(repo).getMastery(11, 10);

    expect(out.items[0].lastSeenAt).toBeNull();
  });
});
```

- [ ] **Step 4: 写 `ParentMasteryService` 实现**

创建 `apps/server/src/modules/parent-insights/parent-mastery.service.ts`：

```ts
import { Injectable } from '@nestjs/common';
import { StudentKnowledgeMasteryRepository } from '../../database/repositories/student-knowledge-mastery.repo.js';
import type { MasterySummary } from './dto/parent-insights.dto.js';

/**
 * 家长端真掌握度（spec §8.2 `/mastery`）：**只读** `student_knowledge_mastery` + `knowledge_points`。
 *
 * 与既有的 `weakPoints`（**错题数代理**）是两套口径：spec §10 明确要求两张卡**并存、标题区分、不得合并**，
 * 所以本 service 不碰 `parent-insights.repo.ts` 的 weakPoints 查询。
 *
 * `coveredQuestions` / `totalQuestions` / `uncovered` **必须回**：题库的 KP 覆盖率只有 38%，
 * 不展示会让家长把「只有这几个薄弱点」当成事实（spec §4.8 规则①）。
 *
 * 调用方（controller）负责把 `limit` 校验为 1..50 的整数。
 */
@Injectable()
export class ParentMasteryService {
  constructor(private readonly masteryRepo: StudentKnowledgeMasteryRepository) {}

  async getMastery(studentId: number, limit: number): Promise<MasterySummary> {
    const [items, coverage] = await Promise.all([
      this.masteryRepo.listWeakest(studentId, limit),
      this.masteryRepo.countQuestionCoverage(),
    ]);

    return {
      items,
      coveredQuestions: coverage.coveredQuestions,
      totalQuestions: coverage.totalQuestions,
      uncovered: Math.max(0, coverage.totalQuestions - coverage.coveredQuestions),
    };
  }
}
```

- [ ] **Step 5: 加 DTO（两处，Task 8 的 controller 要用）**

在 `apps/server/src/modules/parent-insights/dto/parent-insights.dto.ts` **末尾**追加：

```ts
/**
 * 一个专项模块的窗口内聚合（spec §8.2 `/specials`）。
 * `rate` 为 `null` 表示「本期没有可判对错的作答」，**不是 0**。
 */
export interface SpecialModuleSummary {
  /** 作答单位数：默写=篇、解释/含义=句、背单词=题（日志一行 = 一个单位）。 */
  units: number;
  correct: number;
  rate: number | null;
  byDay: Array<{ date: string; count: number }>;
}

/** 四个模块的聚合。只有 `vocabulary` 多一个 `newWords`。 */
export interface SpecialsSummary {
  dictation: SpecialModuleSummary;
  interpretation: SpecialModuleSummary;
  meaning: SpecialModuleSummary;
  vocabulary: SpecialModuleSummary & { newWords: number };
}

/** `/mastery` 的一行。`lastSeenAt` 为 null = 从未见过（不要编成 0）。 */
export interface MasteryItem {
  knowledgePointId: number;
  name: string;
  /** 0..1 的比值（后端已算好，前端不要再除）。 */
  masteryScore: number;
  level: number;
  correctCount: number;
  errorCount: number;
  lastSeenAt: Date | null;
}

/**
 * `/mastery` 响应。三个覆盖率计数**必须都回**：题库只有 38% 的题绑了 KP，
 * 不给出「未覆盖」计数会让家长以为薄弱点只有列出的这些（spec §4.8 规则①）。
 */
export interface MasterySummary {
  items: MasteryItem[];
  coveredQuestions: number;
  totalQuestions: number;
  /** = totalQuestions - coveredQuestions，后端算好，前端不要自己减。 */
  uncovered: number;
}
```

- [ ] **Step 6: 跑两个 service 的测试 + 类型检查**

```bash
cd apps/server && npx vitest run src/modules/parent-insights/specials.service.test.ts src/modules/parent-insights/parent-mastery.service.test.ts && npx tsc --noEmit
```

Expected: `SpecialsService` 5 条 + `ParentMasteryService` 3 条全绿；`tsc` 无输出。

> 若 `tsc` 报 `resolveRange` 的返回字段名不对，去读 `window.util.ts` 用它的真实字段名——**不要**为迁就本 plan 去改 `window.util.ts`（1A 已交付并有测试）。

- [ ] **Step 7: 提交**

```bash
git add apps/server/src/modules/parent-insights/specials.service.ts \
        apps/server/src/modules/parent-insights/specials.service.test.ts \
        apps/server/src/modules/parent-insights/parent-mastery.service.ts \
        apps/server/src/modules/parent-insights/parent-mastery.service.test.ts \
        apps/server/src/modules/parent-insights/dto/parent-insights.dto.ts
git commit -m "feat(parent): 专项与掌握度两个聚合 service（四模块补齐 + 覆盖率计数）"
```

---

### Task 8: 暴露读/写链 —— 两个仓储新查询 + `GoalsService` + 4 个端点 + 模块接线

**Files:**
- Modify: `apps/server/src/database/repositories/special-practice-logs.repo.ts`（加 `countDistinctPassages`）
- Modify: `apps/server/src/database/repositories/special-practice-logs.repo.test.ts`
- Modify: `apps/server/src/database/repositories/main-error-books.repo.ts`（加 `countClearedBetween`）
- Modify: `apps/server/src/database/repositories/student-knowledge-mastery.repo.ts`（订正一处**失实注释**，见 Step 1）
- Create: `apps/server/src/modules/parent-insights/goals.service.ts`
- Test: `apps/server/src/modules/parent-insights/goals.service.test.ts`
- Modify: `apps/server/src/modules/parent-insights/dto/parent-insights.dto.ts`（加目标达成两组类型）
- Modify: `apps/server/src/modules/parent-insights/parent-insights.controller.ts`（3 `@Get` + 1 `@Put`）
- Modify: `apps/server/src/modules/parent-insights/parent-insights.controller.test.ts`（`makeController` 加 3 个位置参数 + 4 条端点用例）
- Modify: `apps/server/src/modules/parent-insights/parent-insights.module.ts`（providers）

**Interfaces:**
- Consumes: `SpecialPracticeLogsRepository`（Task 2）、`StudentKnowledgeMasteryRepository`（Task 5）、`GoalsRepository`（Task 6）、既有的 `ParentAnalyticsRepository.getStudyTimeTotal(studentId, from, toExclusive): Promise<number>`（秒）、既有的 `MainErrorBooksRepository`
- Produces:
  - `SpecialPracticeLogsRepository.countDistinctPassages(studentId, from, toExclusive): Promise<number>`
  - `MainErrorBooksRepository.countClearedBetween(studentId, from, toExclusive): Promise<number>`
  - `class GoalsService`：`getAttainment(studentId): Promise<GoalAttainmentSummary>`、`upsertTarget(studentId, metric: GoalMetric, target: number): Promise<GoalAttainmentItem>`
  - DTO：`GoalAttainmentItem`、`GoalAttainmentSummary`

---

#### 两处已裁决的口径（2026-09-22 用户确认，勿自行改回）

**① `weekly_passages` 的达成值 = 三个语文专项在窗口内的去重篇目数**

spec §8.2 只写了「← `special_practice_logs`」，但该表里**一行 = 一个作答单位**：默写一篇一行、解释/含义是一句一行。若直接把行数当「篇目数」，家长看到的「8」可能是「8 句」，语义崩坏。故口径定为：

```sql
COUNT(DISTINCT ref_id) WHERE module IN ('chinese_dictation','chinese_interpretation','chinese_meaning')
```

即「本周学过（任一语文专项作答过）的不同篇目数」。`ref_id IS NOT NULL` 必须显式排除（`ref_id` 可空，是排查用的兜底列）。

**② 四个默认目标：60 分钟 / 20 词 / 8 篇 / 10 道**

| metric | period | title | 默认 target |
|---|---|---|---|
| `daily_study_minutes` | `daily` | 每日学习时长 | 60 |
| `daily_words` | `daily` | 每日背单词 | 20 |
| `weekly_passages` | `weekly` | 每周古诗文篇目 | 8 |
| `weekly_clear_errors` | `weekly` | 每周清零错题 | 10 |

默认值只写在 `GoalsService` 的 `GOAL_DEFAULTS` 常量里（仿 `points/default-rules.ts` 的 `DEFAULT_RULES`），**不进 DB、不写迁移**；家长改过之后 `INSERT IGNORE` 不会再覆盖（Task 6 已保证）。

**③ 窗口口径沿用 1A（不另立一套）**：`daily` = 今天 00:00 → 明天 00:00；`weekly` = **近 7 天（含今天）00:00 → 明天 00:00**。一律用 `window.util.ts` 的 `startOfDaysAgo()`，**不用 `CURDATE()`**（DB 会话时区与 Node 可能不一致）。这与 1A 的 `resolveWindow('weekly')` 是同一个口径，家长端「周」只有一种含义。

**④ `rate` 复用 `toRate`（分母是 target）**：`rate = toRate(target, achieved)`。`target = 0` → `null`（与 `answered=0 → null` 同一条纪律）。**允许 > 100**（超额完成），前端据此显示「已超额」，**不截断**。

---

- [ ] **Step 1: 两个仓储新查询 + 一处失实注释订正**

**(a)** `special-practice-logs.repo.ts` 追加（紧邻 `countDistinctCorrectWords` 之后，写法与它同款）：

```ts
  /**
   * 窗口内**答过的去重篇目数**，即目标 `weekly_passages` 的达成值（2026-09-22 用户裁决）。
   *
   * 为什么必须去重而不是 COUNT(*)：本表**一行 = 一个作答单位**——默写一篇一行，
   * 解释/含义却是**一句一行**。直接数行数会把「8 句」当成「8 篇」汇报给家长。
   * 三个语文专项合并统计：孩子只要在任一个专项里碰过这篇，就算「本周学过这篇」。
   */
  async countDistinctPassages(
    studentId: number,
    from: Date,
    toExclusive: Date,
  ): Promise<number> {
    const [rows] = await this.pool.execute<(RowDataPacket & { passages: number | string | null })[]>(
      `SELECT COUNT(DISTINCT ref_id) AS passages
       FROM special_practice_logs
       WHERE student_id = ?
         AND module IN ('chinese_dictation', 'chinese_interpretation', 'chinese_meaning')
         AND ref_id IS NOT NULL
         AND created_at >= ? AND created_at < ?`,
      [studentId, from, toExclusive],
    );
    return Number(rows[0]?.passages ?? 0);
  }
```

**(b)** `main-error-books.repo.ts` 追加（紧邻 `markCleared` 之后）：

```ts
  /**
   * 窗口内**清零**的错题数，即目标 `weekly_clear_errors` 的达成值。
   *
   * 口径：按 `cleared_at` 落在窗口内数（`is_cleared = 1 AND cleared_at IS NOT NULL`）。
   * 同一道题清了又被做错会**再新建一行**（`create`），所以这里数的是「清零动作次数」而不是
   * 「去重题数」——这正是家长要的「这周订正掉几道」。`cleared_at` 为 NULL 的历史行不计
   * （老数据 `is_cleared=1` 但没时间戳，无法判断属于哪一周，宁少不猜）。
   */
  async countClearedBetween(studentId: number, from: Date, toExclusive: Date): Promise<number> {
    const [rows] = await this.pool.execute<(RowDataPacket & { n: number | string | null })[]>(
      `SELECT COUNT(*) AS n
       FROM main_error_books
       WHERE student_id = ? AND is_cleared = 1 AND cleared_at IS NOT NULL
         AND cleared_at >= ? AND cleared_at < ?`,
      [studentId, from, toExclusive],
    );
    return Number(rows[0]?.n ?? 0);
  }
```

> 该文件已 import `RowDataPacket`（`findByStudent` 等处已用）；若没有就补进 `import type { … } from 'mysql2/promise'`。

**(c) 订正失实注释（别跳过）**：`student-knowledge-mastery.repo.ts` 的 `listWeakest` 注释现在写「`limit` 由 service 夹在 1..50」——**没有任何地方夹**，Task 8 起由 controller 用 `parsePositiveInt(limit, 'limit', 10, 50)` **校验并 400**（本仓全局纪律：越界一律 400，不静默钳制）。把该行改成：

```ts
  /** 最弱的 N 个知识点（家长端 `/mastery`）；`limit` 由 controller 校验为 1..50（越界 400，不钳制）。 */
```

- [ ] **Step 2: 加仓储测试（两条）**

`special-practice-logs.repo.test.ts` 追加：

```ts
  it('countDistinctPassages：三个语文专项合并去重，排除 ref_id 为 NULL', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([[{ passages: '6' }], []]);
    const repo = new SpecialPracticeLogsRepository(pool as any);

    expect(await repo.countDistinctPassages(11, new Date('2026-09-13'), new Date('2026-09-20'))).toBe(6);
    const sql = pool.execute.mock.calls[0][0] as string;
    expect(sql).toContain('COUNT(DISTINCT ref_id)');
    for (const m of ['chinese_dictation', 'chinese_interpretation', 'chinese_meaning']) {
      expect(sql).toContain(`'${m}'`);
    }
    // 英语不在篇目口径里
    expect(sql).not.toContain('en_vocabulary');
    expect(sql).toContain('ref_id IS NOT NULL');
    // 无数据返回 0（不是 null）
    const empty = mockPool();
    empty.execute.mockResolvedValueOnce([[{ passages: null }], []]);
    expect(await new SpecialPracticeLogsRepository(empty as any)
      .countDistinctPassages(11, new Date(), new Date())).toBe(0);
  });
```

`main-error-books.repo.test.ts`（该文件不存在，**新建**，mock 形状照抄 `point-ledger.repo.test.ts` 的 `mockPool`）：

```ts
import { describe, it, expect, vi } from 'vitest';
import { MainErrorBooksRepository } from './main-error-books.repo.js';

const mockPool = () => ({
  execute: vi.fn().mockResolvedValue([[], []]),
  query: vi.fn().mockResolvedValue([[], []]),
});

describe('MainErrorBooksRepository.countClearedBetween', () => {
  it('只数窗口内 cleared_at 非空的已清零行', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([[{ n: '4' }], []]);
    const repo = new MainErrorBooksRepository(pool as any);

    expect(await repo.countClearedBetween(11, new Date('2026-09-13'), new Date('2026-09-20'))).toBe(4);
    const sql = pool.execute.mock.calls[0][0] as string;
    expect(sql).toContain('is_cleared = 1');
    expect(sql).toContain('cleared_at IS NOT NULL');
    expect(sql).toContain('cleared_at >= ? AND cleared_at < ?');
    expect(pool.execute.mock.calls[0][1]).toEqual([11, new Date('2026-09-13'), new Date('2026-09-20')]);
  });

  it('无数据 → 0', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([[{ n: null }], []]);
    const repo = new MainErrorBooksRepository(pool as any);
    expect(await repo.countClearedBetween(11, new Date(), new Date())).toBe(0);
  });
});
```

- [ ] **Step 3: 加 DTO（两组类型）**

`dto/parent-insights.dto.ts` 末尾追加：

```ts
/**
 * 目标达成的一行（spec §8.2 `/goals/attainment`）。
 *
 * `rate` = `toRate(target, achieved)`，**分母是 target**（与其它 rate 口径同一条纪律：
 * 分母为 0 → `null`，不是 0）。**允许 > 100** = 超额完成，前端不要截断。
 */
export interface GoalAttainmentItem {
  metric: GoalMetric;
  period: GoalPeriod;
  title: string;
  target: number;
  achieved: number;
  rate: number | null;
}

/** 四个目标维度的达成情况（懒初始化后必然齐 4 条）。 */
export interface GoalAttainmentSummary {
  items: GoalAttainmentItem[];
}
```

> 需在文件顶部 `import type { GoalMetric, GoalPeriod } from '../../../database/repositories/goals.repo.js';`（DTO 文件目前没有任何 import，这是第一处——加在文件最上方）。

- [ ] **Step 4: 写 `GoalsService`（含两个窗口常量）**

```ts
import { Injectable } from '@nestjs/common';
import { GoalsRepository } from '../../database/repositories/goals.repo.js';
import type { GoalMetric, GoalPeriod } from '../../database/repositories/goals.repo.js';
import { SpecialPracticeLogsRepository } from '../../database/repositories/special-practice-logs.repo.js';
import { MainErrorBooksRepository } from '../../database/repositories/main-error-books.repo.js';
import { ParentAnalyticsRepository } from '../../database/repositories/parent-analytics.repo.js';
import { startOfDaysAgo, toDayString } from './window.util.js';
import { toRate } from './rate.util.js';
import type { GoalAttainmentItem, GoalAttainmentSummary } from './dto/parent-insights.dto.js';

/** 默认目标（2026-09-22 用户裁决：60 分钟 / 20 词 / 8 篇 / 10 道）。只补缺失的，不覆盖家长改过的值。 */
export const GOAL_DEFAULTS: ReadonlyArray<{
  metric: GoalMetric; period: GoalPeriod; title: string; target: number;
}> = [
  { metric: 'daily_study_minutes', period: 'daily', title: '每日学习时长', target: 60 },
  { metric: 'daily_words', period: 'daily', title: '每日背单词', target: 20 },
  { metric: 'weekly_passages', period: 'weekly', title: '每周古诗文篇目', target: 8 },
  { metric: 'weekly_clear_errors', period: 'weekly', title: '每周清零错题', target: 10 },
];

/** `period` 由 `metric` 派生（`goals.period` 是列，要落库，但不接受家长自定义）。 */
const PERIOD_BY_METRIC: Record<GoalMetric, GoalPeriod> = {
  daily_study_minutes: 'daily',
  daily_words: 'daily',
  weekly_passages: 'weekly',
  weekly_clear_errors: 'weekly',
};

/** 标题也由 metric 派生：库里没有「自定义标题」的入口，统一用常量，避免同名目标两种写法。 */
const TITLE_BY_METRIC: Record<GoalMetric, string> = Object.fromEntries(
  GOAL_DEFAULTS.map((d) => [d.metric, d.title]),
) as Record<GoalMetric, string>;

/**
 * 家长端目标达成（spec §8.2 `/goals/attainment` + Phase 1B 新增的 `PUT /goals/{metric}`）。
 *
 * 四件事，逐条对应口径：
 *   1. **懒初始化**：`getAttainment` 先 `ensureDefaults`（只补缺失）——全新学生第一次打开
 *      `/parent/goals` 就有四条目标，不必家长先手动创建。
 *   2. **达成值按 metric 分派**（spec §8.2）：`daily_study_minutes` ← `study_sessions`（秒→分钟，
 *      **向下取整**，宁少报不虚报达成）；`daily_words` ← `special_practice_logs` 的
 *      `en_vocabulary` 单位数；`weekly_passages` ← 三个语文专项去重篇目数（见本批裁决①）；
 *      `weekly_clear_errors` ← `main_error_books` 窗口内清零数。
 *   3. **窗口用 `startOfDaysAgo()`**：daily = 今天 00:00 → 明天 00:00；weekly = 近 7 天含今天。
 *      绝不 `CURDATE()`（DB 会话时区与 Node 可能不一致，会算错一天）。
 *   4. **达成值不缓存**：四个查询每次实时算——目标页是低频只读页，不值得引入缓存失效问题。
 */
@Injectable()
export class GoalsService {
  constructor(
    private readonly goalsRepo: GoalsRepository,
    private readonly logsRepo: SpecialPracticeLogsRepository,
    private readonly mainErrorRepo: MainErrorBooksRepository,
    private readonly analyticsRepo: ParentAnalyticsRepository,
  ) {}

  async getAttainment(studentId: number): Promise<GoalAttainmentSummary> {
    await this.goalsRepo.ensureDefaults(studentId, GOAL_DEFAULTS);
    const rows = await this.goalsRepo.findActiveByStudent(studentId);

    const items = await Promise.all(
      rows
        // 脏数据防御：`metric` 为 NULL 的历史行（迁移已回填，但手工改库仍可能留下）不入响应——
        // 前端按 metric 渲染，收到 null 会渲染出一个没有名字的目标。
        .filter((r): r is typeof r & { metric: GoalMetric } => r.metric !== null)
        .map(async (r): Promise<GoalAttainmentItem> => {
          const achieved = await this.achievedOf(studentId, r.metric);
          return {
            metric: r.metric,
            period: PERIOD_BY_METRIC[r.metric],
            title: r.title,
            target: r.targetValue,
            achieved,
            rate: toRate(r.targetValue, achieved),
          };
        }),
    );
    // 稳定排序：按 GOAL_DEFAULTS 的顺序（家长看到的顺序应与页面固定顺序一致，不随 id 漂移）
    const order = new Map(GOAL_DEFAULTS.map((d, i) => [d.metric, i]));
    items.sort((a, b) => (order.get(a.metric) ?? 99) - (order.get(b.metric) ?? 99));
    return { items };
  }

  async upsertTarget(studentId: number, metric: GoalMetric, target: number): Promise<GoalAttainmentItem> {
    const period = PERIOD_BY_METRIC[metric];
    await this.goalsRepo.upsertTarget(studentId, metric, period, TITLE_BY_METRIC[metric], target);
    const achieved = await this.achievedOf(studentId, metric);
    return {
      metric,
      period,
      title: TITLE_BY_METRIC[metric],
      target,
      achieved,
      rate: toRate(target, achieved),
    };
  }

  /** 窗口：`daily` = 今天 → 明天；`weekly` = 近 7 天（含今天）→ 明天。 */
  private windowOf(period: GoalPeriod): { start: Date; endExclusive: Date } {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const start = startOfDaysAgo(period === 'daily' ? 0 : 6);
    const today = startOfDaysAgo(0);
    return { start, endExclusive: new Date(today.getTime() + DAY_MS) };
  }

  private async achievedOf(studentId: number, metric: GoalMetric): Promise<number> {
    const period = PERIOD_BY_METRIC[metric];
    const { start, endExclusive } = this.windowOf(period);
    switch (metric) {
      case 'daily_study_minutes': {
        const seconds = await this.analyticsRepo.getStudyTimeTotal(studentId, start, endExclusive);
        return Math.floor(seconds / 60); // 向下取整：59 秒不算 1 分钟，不虚报达成
      }
      case 'daily_words': {
        const rows = await this.logsRepo.aggregateByModule(studentId, start, endExclusive);
        return rows.find((r) => r.module === 'en_vocabulary')?.units ?? 0;
      }
      case 'weekly_passages':
        return this.logsRepo.countDistinctPassages(studentId, start, endExclusive);
      case 'weekly_clear_errors':
        return this.mainErrorRepo.countClearedBetween(studentId, start, endExclusive);
    }
  }
}
```

- [ ] **Step 5: 写 `GoalsService` 测试（表驱动 + 边界）**

创建 `apps/server/src/modules/parent-insights/goals.service.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { GoalsService, GOAL_DEFAULTS } from './goals.service.js';

const mk = () => ({
  goalsRepo: {
    ensureDefaults: vi.fn().mockResolvedValue(undefined),
    findActiveByStudent: vi.fn().mockResolvedValue([]),
    upsertTarget: vi.fn().mockResolvedValue(undefined),
  },
  logsRepo: {
    aggregateByModule: vi.fn().mockResolvedValue([]),
    countDistinctPassages: vi.fn().mockResolvedValue(0),
  },
  mainErrorRepo: { countClearedBetween: vi.fn().mockResolvedValue(0) },
  analyticsRepo: { getStudyTimeTotal: vi.fn().mockResolvedValue(0) },
});
const mkSvc = (d = mk()) =>
  new GoalsService(d.goalsRepo as any, d.logsRepo as any, d.mainErrorRepo as any, d.analyticsRepo as any);

const goalRow = (metric: string, target: number, title = 'T') =>
  ({ id: 1, metric, period: 'daily', targetValue: target, title });

describe('GoalsService.getAttainment', () => {
  it('先懒初始化（只补缺失），再读启用中的目标', async () => {
    const d = mk();
    await mkSvc(d).getAttainment(11);
    expect(d.goalsRepo.ensureDefaults).toHaveBeenCalledWith(11, GOAL_DEFAULTS);
    expect(d.goalsRepo.findActiveByStudent).toHaveBeenCalledWith(11);
  });

  it('四个 metric 的达成值各走自己的数据源', async () => {
    const d = mk();
    d.goalsRepo.findActiveByStudent.mockResolvedValue([
      goalRow('daily_study_minutes', 60), goalRow('daily_words', 20),
      goalRow('weekly_passages', 8), goalRow('weekly_clear_errors', 10),
    ]);
    d.analyticsRepo.getStudyTimeTotal.mockResolvedValue(3599); // 59 分 59 秒 → 向下取整 59
    d.logsRepo.aggregateByModule.mockResolvedValue([
      { module: 'en_vocabulary', units: 7, answered: 7, correct: 5 },
    ]);
    d.logsRepo.countDistinctPassages.mockResolvedValue(3);
    d.mainErrorRepo.countClearedBetween.mockResolvedValue(4);

    const out = await mkSvc(d).getAttainment(11);

    expect(Object.fromEntries(out.items.map((i) => [i.metric, i.achieved]))).toEqual({
      daily_study_minutes: 59, daily_words: 7, weekly_passages: 3, weekly_clear_errors: 4,
    });
  });

  it('rate 复用 toRate（分母 = target）：达标 100、超额可 >100、target=0 → null', async () => {
    const d = mk();
    d.goalsRepo.findActiveByStudent.mockResolvedValue([
      goalRow('daily_words', 10), goalRow('weekly_clear_errors', 0),
    ]);
    d.logsRepo.aggregateByModule.mockResolvedValue([{ module: 'en_vocabulary', units: 15, answered: 0, correct: 0 }]);

    const out = await mkSvc(d).getAttainment(11);

    expect(out.items.find((i) => i.metric === 'daily_words')?.rate).toBe(150);
    expect(out.items.find((i) => i.metric === 'weekly_clear_errors')?.rate).toBeNull();
  });

  it('daily 用今天窗口、weekly 用近 7 天窗口（半开区间，绝不用 CURDATE）', async () => {
    const d = mk();
    d.goalsRepo.findActiveByStudent.mockResolvedValue([
      goalRow('daily_study_minutes', 60), goalRow('weekly_passages', 8),
    ]);
    await mkSvc(d).getAttainment(11);

    const [dailyFrom, dailyTo] = d.analyticsRepo.getStudyTimeTotal.mock.calls[0] as [number, Date, Date];
    const [weekFrom, weekTo] = d.logsRepo.countDistinctPassages.mock.calls[0] as [number, Date, Date];
    const DAY = 24 * 3_600_000;
    expect(dailyTo.getTime() - dailyFrom.getTime()).toBe(DAY);
    expect(weekTo.getTime() - weekFrom.getTime()).toBe(7 * DAY);
    expect(dailyFrom.getHours()).toBe(0);   // 本地 00:00
    expect(weekFrom.getHours()).toBe(0);
  });

  it('metric 为 NULL 的历史脏行不进响应（前端按 metric 渲染）', async () => {
    const d = mk();
    d.goalsRepo.findActiveByStudent.mockResolvedValue([goalRow('daily_words', 20), { ...goalRow('x', 1), metric: null }]);
    const out = await mkSvc(d).getAttainment(11);
    expect(out.items.map((i) => i.metric)).toEqual(['daily_words']);
  });

  it('返回顺序固定按 GOAL_DEFAULTS，不随 id 漂移', async () => {
    const d = mk();
    d.goalsRepo.findActiveByStudent.mockResolvedValue([
      goalRow('weekly_clear_errors', 10), goalRow('daily_words', 20), goalRow('daily_study_minutes', 60),
    ]);
    const out = await mkSvc(d).getAttainment(11);
    expect(out.items.map((i) => i.metric)).toEqual([
      'daily_study_minutes', 'daily_words', 'weekly_clear_errors',
    ]);
  });
});

describe('GoalsService.upsertTarget', () => {
  it('period/title 由 metric 派生（不接受家长自定义），并回填达成值', async () => {
    const d = mk();
    d.logsRepo.aggregateByModule.mockResolvedValue([{ module: 'en_vocabulary', units: 12, answered: 0, correct: 0 }]);

    const out = await mkSvc(d).upsertTarget(11, 'daily_words', 24);

    expect(d.goalsRepo.upsertTarget).toHaveBeenCalledWith(11, 'daily_words', 'daily', '每日背单词', 24);
    expect(out).toMatchObject({ metric: 'daily_words', period: 'daily', target: 24, achieved: 12, rate: 50 });
  });

  it('weekly 维度 → period=weekly', async () => {
    const d = mk();
    await mkSvc(d).upsertTarget(11, 'weekly_passages', 6);
    expect(d.goalsRepo.upsertTarget).toHaveBeenCalledWith(11, 'weekly_passages', 'weekly', '每周古诗文篇目', 6);
  });
});
```

- [ ] **Step 6: 控制器加 4 个端点**

`parent-insights.controller.ts` 四处改动：

**(a)** 顶部 import 追加：

```ts
import { Body, Put } from '@nestjs/common';        // 并入既有的 '@nestjs/common' 具名导入
import { GoalsService } from './goals.service.js';
import { SpecialsService } from './specials.service.js';
import { ParentMasteryService } from './parent-mastery.service.js';
import { GOAL_METRICS } from './goals.service.js';  // 若把白名单放在 service 里（见下）
import type {
  GoalAttainmentItem,
  GoalAttainmentSummary,
  MasterySummary,
  SpecialsSummary,
} from './dto/parent-insights.dto.js';
import type { GoalMetric } from '../../database/repositories/goals.repo.js';
```

**(b)** 类文档那句「全部端点**只读**」必须改掉（本批新增了唯一的写端点）：

```ts
 * `GET` 端点全部只读；**唯一的写端点是 `PUT students/:studentId/goals/:metric`**（家长改目标值）——
 * 它同样先做归属校验，且只允许改 `target`，`metric`/`period`/`title` 由服务端派生。
```

**(c)** 白名单常量（放在 `PeriodSchema` 旁边）：

```ts
/** 目标维度白名单（与 `goals.metric` 的列注释、`GoalMetric` 类型逐字一致）。 */
const GOAL_METRICS: readonly GoalMetric[] =
  ['daily_study_minutes', 'daily_words', 'weekly_passages', 'weekly_clear_errors'];

/**
 * `PUT .../goals/:metric` 的 body。**只收 `target`**：`metric` 在路径里、`period`/`title`
 * 由服务端按 metric 派生，家长无从自定义。上限 9999 与 `points` 的规则值同一档，
 * 顺带挡住 `SMALLINT` 溢出；**下限 1**：目标 0 没有意义（达成率永远是 null）。
 */
const UpsertGoalSchema = z.object({ target: z.number().int().min(1).max(9999) });
```

**(d)** 构造函数加 3 个参数（**加在末尾**，顺序即测试里的位置参数）：

```ts
    private readonly studyTimeService: StudyTimeService,
    private readonly specialsService: SpecialsService,
    private readonly parentMasteryService: ParentMasteryService,
    private readonly goalsService: GoalsService,
  ) {}
```

**(e)** 四个 handler（追加在 `getTodayUsage` 之后）：

```ts
  @Get('students/:studentId/specials')
  async getSpecials(
    @CurrentUser() user: JwtUser,
    @Param('studentId', ParseIntPipe) studentId: number,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<SpecialsSummary> {
    await this.parentService.requireOwnedStudent(user.sub, studentId);
    return this.specialsService.getSpecials(studentId, from, to);
  }

  /**
   * `limit` 走 `parsePositiveInt`：**越界 400，不静默钳制**（本仓全局纪律）。
   * 缺省 10，上限 50（spec §8.2）。
   */
  @Get('students/:studentId/mastery')
  async getMastery(
    @CurrentUser() user: JwtUser,
    @Param('studentId', ParseIntPipe) studentId: number,
    @Query('limit') limit?: string,
  ): Promise<MasterySummary> {
    await this.parentService.requireOwnedStudent(user.sub, studentId);
    return this.parentMasteryService.getMastery(studentId, parsePositiveInt(limit, 'limit', 10, 50));
  }

  @Get('students/:studentId/goals/attainment')
  async getGoalAttainment(
    @CurrentUser() user: JwtUser,
    @Param('studentId', ParseIntPipe) studentId: number,
  ): Promise<GoalAttainmentSummary> {
    await this.parentService.requireOwnedStudent(user.sub, studentId);
    return this.goalsService.getAttainment(studentId);
  }

  /**
   * 家长改目标值（本批唯一的写端点）。响应回**该 metric 的最新达成情况**，
   * 前端拿它原地替换行数据，不必再发一次 GET（省一次往返，也避免写后读不一致的窗口）。
   *
   * 错误码：`metric` 不在白名单 → 400/1001；body 校验失败 → 400/1001；
   * 不是自己孩子 → 403/1005；孩子不存在 → 404/1002（都由 requireOwnedStudent 抛）。
   */
  @Put('students/:studentId/goals/:metric')
  async putGoalTarget(
    @CurrentUser() user: JwtUser,
    @Param('studentId', ParseIntPipe) studentId: number,
    @Param('metric') metric: string,
    @Body() body: unknown,
  ): Promise<GoalAttainmentItem> {
    await this.parentService.requireOwnedStudent(user.sub, studentId);
    if (!GOAL_METRICS.includes(metric as GoalMetric)) {
      throw new BadRequestException({
        code: 1001,
        message: `metric 仅允许 ${GOAL_METRICS.join(' | ')}（收到 ${metric}）`,
      });
    }
    const parsed = UpsertGoalSchema.safeParse(body);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ');
      throw new BadRequestException({ code: 1001, message: `入参校验失败：${detail}` });
    }
    return this.goalsService.upsertTarget(studentId, metric as GoalMetric, parsed.data.target);
  }
```

> 需要把 `BadRequestException` 加进 `@nestjs/common` 的具名导入。
> ⚠️ **与既有 `/goals/{goalId}` 的路径重叠**：新 `PUT .../goals/{metric}` 与旧 `PATCH/DELETE .../goals/{goalId}` 匹配同一批 URL，但 **HTTP 方法不同**，Nest 路由不冲突。旧 CRUD 本期只标废弃、**不删**（Task 12），故两者会共存一段时间。

- [ ] **Step 7: 模块接线**

`parent-insights.module.ts`：providers 追加 6 项（**服务在前、仓储在后**，与现有顺序风格一致）：

```ts
    StudyTimeService,
    SpecialsService,
    ParentMasteryService,
    GoalsService,
    ...
    ParentAnalyticsRepository,
    ControlsRepository,
    // 埋点 Phase 1B：三个新仓储只在本模块 provide（仓储无状态，其它模块要用各自 provide）
    SpecialPracticeLogsRepository,
    StudentKnowledgeMasteryRepository,
    GoalsRepository,
    MainErrorBooksRepository,
```

> `MainErrorBooksRepository` 目前**不在**本模块 providers 里（Task 8 是第一个需要它的家长端点），`ParentAnalyticsRepository` 已在。漏加任何一项 → Nest **启动直接失败**（"can't resolve dependencies"），Step 9 的启动冒烟会立刻抓到。

- [ ] **Step 8: 控制器测试（改 `makeController` + 4 条用例）**

**(a)** `makeController` 必须补 3 个位置参数（放在 `studyTime` 之后），否则所有既有用例都会因构造参数错位而炸：

```ts
function makeController(requireOwnedStudent: ReturnType<typeof vi.fn>) {
  const parentService = { requireOwnedStudent } as unknown as ParentService;
  const studyTime = { /* …既有… */ } as unknown as StudyTimeService;
  const specials = { getSpecials: vi.fn().mockResolvedValue({}) } as unknown as SpecialsService;
  const mastery = { getMastery: vi.fn().mockResolvedValue({}) } as unknown as ParentMasteryService;
  const goals = {
    getAttainment: vi.fn().mockResolvedValue({ items: [] }),
    upsertTarget: vi.fn().mockResolvedValue({}),
  } as unknown as GoalsService;
  const controller = new ParentInsightsController(
    parentService, {} as never, {} as never, {} as never, {} as never, studyTime,
    specials, mastery, goals,
  );
  return { controller, studyTime, specials, mastery, goals };
}
```

**(b)** 新增用例（都遵循「先归属校验、再取数」的既有断言风格）：

```ts
describe('ParentInsightsController 专项 / 掌握度 / 目标端点', () => {
  it('specials：归属校验先于取数，from/to 原样透传', async () => {
    const order: string[] = [];
    const requireOwned = vi.fn(async () => { order.push('ownership'); });
    const { controller, specials } = makeController(requireOwned);
    (specials.getSpecials as any).mockImplementation(async () => { order.push('query'); return {}; });

    await controller.getSpecials(USER, 11, '2026-09-13', '2026-09-19');

    expect(order).toEqual(['ownership', 'query']);
    expect(specials.getSpecials).toHaveBeenCalledWith(11, '2026-09-13', '2026-09-19');
  });

  it('mastery：limit 缺省 10；越界 400 且**不取数**', async () => {
    const requireOwned = vi.fn(async () => {});
    const { controller, mastery } = makeController(requireOwned);

    await controller.getMastery(USER, 11, undefined);
    expect(mastery.getMastery).toHaveBeenCalledWith(11, 10);

    await expect(controller.getMastery(USER, 11, '51')).rejects.toMatchObject({ status: 400 });
    await expect(controller.getMastery(USER, 11, 'abc')).rejects.toMatchObject({ status: 400 });
    expect(mastery.getMastery).toHaveBeenCalledTimes(1); // 只有缺省那次真取数
  });

  it('goals/attainment：归属校验后取达成', async () => {
    const requireOwned = vi.fn(async () => {});
    const { controller, goals } = makeController(requireOwned);
    await controller.getGoalAttainment(USER, 11);
    expect(requireOwned).toHaveBeenCalledWith(3, 11);
    expect(goals.getAttainment).toHaveBeenCalledWith(11);
  });

  it('PUT goals/:metric：白名单外 400、body 非法 400，都不写库', async () => {
    const { controller, goals } = makeController(vi.fn(async () => {}));

    await expect(controller.putGoalTarget(USER, 11, 'daily_x', { target: 30 }))
      .rejects.toMatchObject({ status: 400 });
    await expect(controller.putGoalTarget(USER, 11, 'daily_words', { target: 0 }))
      .rejects.toMatchObject({ status: 400 });
    await expect(controller.putGoalTarget(USER, 11, 'daily_words', { target: 20.5 }))
      .rejects.toMatchObject({ status: 400 });
    expect(goals.upsertTarget).not.toHaveBeenCalled();
  });

  it('PUT goals/:metric：合法入参 → 调 service 并回该行达成情况', async () => {
    const { controller, goals } = makeController(vi.fn(async () => {}));
    await controller.putGoalTarget(USER, 11, 'daily_words', { target: 30 });
    expect(goals.upsertTarget).toHaveBeenCalledWith(11, 'daily_words', 30);
  });

  it('归属校验失败时不写库（403 不许泄漏存在性）', async () => {
    const { controller, goals } = makeController(vi.fn().mockRejectedValue(new Error('1005')));
    await expect(controller.putGoalTarget(USER, 11, 'daily_words', { target: 30 })).rejects.toThrow();
    expect(goals.upsertTarget).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 9: 定向测试 + 全量 + 类型检查 + 启动冒烟**

```bash
cd apps/server && npx vitest run src/modules/parent-insights src/database/repositories && npx tsc --noEmit
cd apps/server && npm test 2>&1 | tail -5
```

Expected: 全绿；`tsc` 无输出。

**启动冒烟（必须做，抓 DI）**——本批新增了 3 个 service + 4 个仓储进 providers，类型检查抓不到漏配：

```bash
cd apps/server && npm run build
cd apps/server && PORT=3117 node dist/main.js > /tmp/boot_1b.log 2>&1 & echo $! > /tmp/boot_1b.pid
sleep 6 && grep -E "successfully started|Mapped \{/api/parent/students/:studentId/(specials|mastery|goals/attainment)" /tmp/boot_1b.log
kill $(cat /tmp/boot_1b.pid) && rm -f /tmp/boot_1b.pid /tmp/boot_1b.log
```

Expected: `Nest application successfully started` + 三条新路由被 mapped。
⚠️ **按 PID 收尾**，**别** `pkill -f 'node dist/main.js'`（会杀掉用户本机在跑的服务）。

> 本机 dev 库**没有任何 students 行**（2026-09-22 实测 `SELECT COUNT(*) FROM students` = 0），所以**做不了**「登录 → 调端点 → 查库」的端到端冒烟。写入链的语义已在 Task 5/6 用真库 SQL（事务 + ROLLBACK）逐条验过；Task 8 的剩余风险只是「路由有没有挂上 / DI 有没有解析」，由上面的启动冒烟覆盖。**不要**为了冒烟往 dev 库塞假学生。

- [ ] **Step 10: 提交**

```bash
git add apps/server/src/database/repositories/special-practice-logs.repo.ts \
        apps/server/src/database/repositories/special-practice-logs.repo.test.ts \
        apps/server/src/database/repositories/main-error-books.repo.ts \
        apps/server/src/database/repositories/main-error-books.repo.test.ts \
        apps/server/src/database/repositories/student-knowledge-mastery.repo.ts \
        apps/server/src/modules/parent-insights/
git commit -m "feat(parent): 暴露专项/掌握度/目标达成 4 个端点（GoalsService + 两个仓储新查询）"
```

---

### Task 9: 前端 API 层 —— 6 个类型 + 4 个方法

**Files:**
- Modify: `apps/web/src/services/api.ts`（家长端学情段之后）

**Interfaces:**
- Produces（Task 10/11 依赖，**逐字照抄名字**）：
  - `type ParentGoalMetric = 'daily_study_minutes' | 'daily_words' | 'weekly_passages' | 'weekly_clear_errors'`
  - `interface ParentSpecialModule { units; correct; rate: number | null; byDay: Array<{date;count}> }`
  - `interface ParentSpecials { dictation; interpretation; meaning; vocabulary: ParentSpecialModule & { newWords: number } }`
  - `interface ParentMasteryItem`、`interface ParentMastery`
  - `interface ParentGoalAttainmentItem`、`interface ParentGoalAttainment`
  - `getParentSpecials(studentId, from?, to?)`、`getParentMastery(studentId, limit?)`、`getParentGoalAttainment(studentId)`、`putParentGoalTarget(studentId, metric, target)`

**口径（都要进注释）**
- `rate` 一律可能是 `null`（分母为 0），前端**不得**把它当 0 显示成「0%」。
- 目标的 `rate` **允许 > 100**（超额），前端不要 `Math.min(100, …)`。
- 四个模块**后端保证都在**，前端不需要判空兜底；但 `byDay` 可能是空数组。

- [ ] **Step 1: 追加类型与方法**

在 `api.ts` 的家长端学情段（`getParentTodayUsage` 之后）追加，风格照抄既有的 `ParentStudyTime` / `getParentStudyTime`（`URLSearchParams` 只在有值时 set、`fetchApi<T>`、不手工包 `{code,message,data}`）：

```ts
// --- Parent: 专项学情 / 真掌握度 / 目标达成（埋点 Phase 1B） ---

/** 目标维度（与后端 `goals.metric` 的列注释逐字一致）。 */
export type ParentGoalMetric =
  | 'daily_study_minutes'
  | 'daily_words'
  | 'weekly_passages'
  | 'weekly_clear_errors';

/**
 * 一个专项模块的窗口内聚合。
 * ⚠️ `rate` 为 `null` = **本期没有可判对错的作答**，不是 0——显示「暂无数据」，不要显示 0%。
 */
export interface ParentSpecialModule {
  /** 作答单位数：默写=篇、解释/含义=句、背单词=题。 */
  units: number;
  correct: number;
  rate: number | null;
  byDay: Array<{ date: string; count: number }>;
}

/**
 * 四个专项模块。后端**保证四个键都在**（没数据给 0 / rate null / byDay 空），
 * 所以前端不必做「模块缺失」兜底；只有 `vocabulary` 多一个 `newWords`。
 */
export interface ParentSpecials {
  dictation: ParentSpecialModule;
  interpretation: ParentSpecialModule;
  meaning: ParentSpecialModule;
  vocabulary: ParentSpecialModule & { newWords: number };
}

/**
 * 真掌握度（`student_knowledge_mastery`）的一行。
 * `masteryScore` 是 **0..1 的比值**（后端已算好，前端不要再除 100）。
 * `lastSeenAt` 为 null = 从未见过。
 */
export interface ParentMasteryItem {
  knowledgePointId: number;
  name: string;
  masteryScore: number;
  level: number;
  correctCount: number;
  errorCount: number;
  lastSeenAt: string | null;
}

/**
 * `/mastery` 响应。三个覆盖率计数必须一起展示：题库只有 **38%** 的题绑了知识点，
 * 只列最弱几项会让家长以为「孩子的问题只有这几个」。
 */
export interface ParentMastery {
  items: ParentMasteryItem[];
  coveredQuestions: number;
  totalQuestions: number;
  /** = totalQuestions - coveredQuestions（后端算好，前端不要自己减）。 */
  uncovered: number;
}

/** 目标达成的一行。`rate` 允许 > 100（超额完成），前端**不要截断**。 */
export interface ParentGoalAttainmentItem {
  metric: ParentGoalMetric;
  period: 'daily' | 'weekly';
  title: string;
  target: number;
  achieved: number;
  rate: number | null;
}

export interface ParentGoalAttainment {
  items: ParentGoalAttainmentItem[];
}

/**
 * 专项学情。`from`/`to` 形如 `YYYY-MM-DD`，缺省近 7 天；
 * 非法值后端**宽容回落**默认窗口、不报错（与 `getParentStudyTime` 一致）。
 */
export function getParentSpecials(
  studentId: number,
  from?: string,
  to?: string,
): Promise<ParentSpecials> {
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return fetchApi<ParentSpecials>(`/parent/students/${studentId}/specials${suffix}`);
}

/** 真掌握度。`limit` 缺省 10、上限 50（越界后端 400，前端不要传超）。 */
export function getParentMastery(studentId: number, limit?: number): Promise<ParentMastery> {
  const qs = new URLSearchParams();
  if (limit !== undefined) qs.set('limit', String(limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return fetchApi<ParentMastery>(`/parent/students/${studentId}/mastery${suffix}`);
}

/** 目标达成（首次调用后端会懒初始化四个默认目标）。 */
export function getParentGoalAttainment(studentId: number): Promise<ParentGoalAttainment> {
  return fetchApi<ParentGoalAttainment>(`/parent/students/${studentId}/goals/attainment`);
}

/**
 * 改某个目标的值。响应是**该 metric 的最新达成情况**——调用方应拿它原地替换该行，
 * 不要再发一次 GET（省一次往返，也避免写后读不一致的窗口）。
 */
export function putParentGoalTarget(
  studentId: number,
  metric: ParentGoalMetric,
  target: number,
): Promise<ParentGoalAttainmentItem> {
  return fetchApi<ParentGoalAttainmentItem>(
    `/parent/students/${studentId}/goals/${metric}`,
    { method: 'PUT', body: JSON.stringify({ target }) },
  );
}
```

- [ ] **Step 2: 验证**

```bash
cd apps/web && npx tsc -b && npm run lint
```

Expected: 均无输出/无错。本步骤**不加测试**（纯类型 + 薄封装，行为由 Task 10/11 的页面测试覆盖）。

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/services/api.ts
git commit -m "feat(parent): api 层加专项/掌握度/目标达成 4 个方法（埋点 Phase 1B）"
```

---

### Task 10: `/parent/goals` 真页（读 + 改目标）

**Files:**
- Create: `apps/web/src/pages/parent/ParentGoalsPage.tsx`
- Test: `apps/web/src/pages/parent/ParentGoalsPage.test.tsx`
- Modify: `apps/web/src/routes/routeTable.tsx`（`/parent/goals` 的 `<Placeholder>` → `<ParentGoalsPage />`；顶部加 import）
- Modify: `apps/web/src/routes/routeTable.test.tsx`（加一条「渲染 ParentGoalsPage，不是 Placeholder」的钉子）

**口径与约束**
- 家长端**全程日间**：页面**不加** `data-theme`、不用 `.student-theme-container`（由 `ParentLayout` 统一写 `data-theme="parent"`）。
- **不用 emoji、不用图标库**；要图标就内联线性 `<svg>`（照抄 `ParentLayout` 的写法）。本页无图标需求。
- **派生数据必须带 `studentId` 归属**（切孩子不重挂载 + `useEffect` 在 commit 之后跑 = 会闪上一个孩子的数据）。照抄 `ParentReportPage` 的 `{ studentId, value }` 写法，**不要**在 effect 里 `setData(null)`。
- 行的顺序由后端固定（`GOAL_DEFAULTS` 顺序），前端**原样渲染**、不重排、不按 metric 自定义顺序。

**状态机（逐态都要有断言）**

| 状态 | 触发 | 渲染 |
|---|---|---|
| `no-student` | `studentId === null` | 「请先选择孩子」卡 + 链接 `/parent/students`，`data-testid="goals-no-student"` |
| `student-missing` | `err.code === 1002` | 「学生不存在或已删除」卡，`data-testid="goals-student-missing"` |
| `student-forbidden` | `err.code === 1005` | 「无权查看该学生」卡，`data-testid="goals-student-forbidden"` |
| `loading` | 已选孩子且 `data === null` 且无错 | `<Skeleton>` 堆叠，`data-testid="goals-skeleton"` |
| `error` | 其它错误 | 错误卡（`border-[var(--error)]`）+ 「重试」按钮（bump `reload`），`data-testid="goals-error"` |
| `ready` | `data.items` 非空 | 四行目标，每行：标题、`period` 文案（每日/每周）、输入框（type=number）、「保存」按钮、达成进度（`achieved / target` + 百分比或「暂无数据」） |
| `empty` | `data.items.length === 0` | 「暂无目标」文案（正常不该出现——后端保证四条） |
| 行级 `saving` | 该行点保存 | 该行按钮 disabled + 文案「保存中…」；**其它行不受影响**（行级状态用 `savingMetric` 单值） |
| 行级 `saved` | 保存成功 | 用响应 item 原地替换该行（`target`/`achieved`/`rate` 一起更新），无 toast 也可（页面自带反馈：数字变了） |
| 行级 `save-failed` | 保存失败 | 该行下方红字错误（`data-testid={`goal-error-${metric}`}`），**保留家长输入不回滚**，按钮恢复可点 |

- [ ] **Step 1: 写实现**

```tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, Skeleton } from '@/components/base';
import { ApiError } from '@/services/api';
import {
  getParentGoalAttainment,
  putParentGoalTarget,
  type ParentGoalAttainment,
  type ParentGoalAttainmentItem,
  type ParentGoalMetric,
} from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';

const PERIOD_LABEL: Record<ParentGoalAttainmentItem['period'], string> = {
  daily: '每日',
  weekly: '每周',
};

/** 达成率文案：null（未设定/分母为 0）显示「暂无数据」，>100 明确写「已超额」。 */
function rateText(item: ParentGoalAttainmentItem): string {
  if (item.rate === null) return '暂无数据';
  const pct = `${item.rate}%`;
  return item.rate > 100 ? `${pct}（已超额）` : pct;
}

export default function ParentGoalsPage() {
  const studentId = useParentStudentStore((s) => s.studentId);
  const [data, setData] = useState<{ studentId: number; value: ParentGoalAttainment } | null>(null);
  const [failure, setFailure] = useState<{ studentId: number; code: number | null } | null>(null);
  const [reload, setReload] = useState(0);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [savingMetric, setSavingMetric] = useState<ParentGoalMetric | null>(null);
  const [saveError, setSaveError] = useState<{ metric: ParentGoalMetric; message: string } | null>(null);

  /** 派生值带 studentId 归属：切孩子不重挂载，只按当前孩子比对（effect 在 commit 之后跑，清空会闪）。 */
  const value = data && data.studentId === studentId ? data.value : null;
  const err = failure && failure.studentId === studentId ? failure : null;

  useEffect(() => {
    if (studentId === null) return;
    let cancelled = false;
    getParentGoalAttainment(studentId)
      .then((res) => {
        if (cancelled) return;
        setData({ studentId, value: res });
        setFailure(null);
        // 换孩子/重载时清掉上一份草稿与行级错误，否则会把上个孩子的输入带过来
        setDraft({});
        setSaveError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setData(null);
        setFailure({ studentId, code: error instanceof ApiError ? error.code : null });
      });
    return () => { cancelled = true; };
  }, [studentId, reload]);

  const save = async (item: ParentGoalAttainmentItem) => {
    if (studentId === null) return;
    const raw = draft[item.metric] ?? String(item.target);
    const target = Number(raw);
    if (!Number.isInteger(target) || target < 1 || target > 9999) {
      setSaveError({ metric: item.metric, message: '目标值需为 1–9999 的整数' });
      return;
    }
    setSavingMetric(item.metric);
    setSaveError(null);
    try {
      const updated = await putParentGoalTarget(studentId, item.metric, target);
      // 原地替换该行：用后端回的最新达成情况，避免再发一次 GET
      setData((prev) =>
        prev && prev.studentId === studentId
          ? { studentId, value: { items: prev.value.items.map((it) => (it.metric === updated.metric ? updated : it)) } }
          : prev,
      );
      setDraft((prev) => { const next = { ...prev }; delete next[item.metric]; return next; });
    } catch (error: unknown) {
      setSaveError({ metric: item.metric, message: error instanceof Error ? error.message : '保存失败' });
    } finally {
      setSavingMetric(null);
    }
  };
  // …渲染见 Step 2 的状态分支
}
```

> `Card` / `Skeleton` 从 `@/components/base` 具名导入（与 `ParentReportPage` 同款）。`Input` 若基座组件的 props 不便，直接写 `<input type="number" className="…">` 也可以——**不要**为了复用而改基座组件。

- [ ] **Step 2: 渲染分支（骨架）**

```tsx
  if (studentId === null) { /* goals-no-student 卡 + <Link to="/parent/students"> */ }
  if (err?.code === 1002) { /* goals-student-missing */ }
  if (err?.code === 1005) { /* goals-student-forbidden */ }
  if (err) { /* goals-error 卡 + 重试按钮 onClick={() => setReload((n) => n + 1)} */ }
  if (value === null) { /* goals-skeleton：3 个 Skeleton */ }
  // ready / empty：
  // <Card className="p-5" data-testid="goals-card">
  //   每行 <div data-testid={`goal-row-${item.metric}`}>
  //     标题 + period 文案 + `${item.achieved} / ${item.target}` + rateText(item)
  //     <input type="number" value={draft[item.metric] ?? String(item.target)}
  //            onChange={e => setDraft(p => ({...p, [item.metric]: e.target.value}))}
  //            aria-label={`${item.title}目标值`} />
  //     <button disabled={savingMetric === item.metric} onClick={() => save(item)}>
  //       {savingMetric === item.metric ? '保存中…' : '保存'}
  //     </button>
  //     {saveError?.metric === item.metric && <p data-testid={`goal-error-${item.metric}`} className="text-[var(--error)]">{saveError.message}</p>}
```

- [ ] **Step 3: 写测试（8 条，逐态一条）**

新建 `ParentGoalsPage.test.tsx`，照抄 `ParentReportPage.test.tsx` 的骨架：`vi.mock('@/services/api', importOriginal)` 只 mock 本页用到的四个方法、`createMemoryRouter(routes)` + `validToken()`、`beforeEach` 里 `useParentStudentStore.setState({ studentId: 11 })`、`afterEach` 里 `cleanup()` + 复位两个 store。

必须覆盖：
1. 四行都渲染（`goal-row-daily_study_minutes` 等四个 testid 都在）；标题用后端给的 `title`。
2. `rate === null` → 文案「暂无数据」，**不出现「0%」**。
3. `rate === 150` → 文案含「已超额」。
4. 改值 + 点保存 → 调 `putParentGoalTarget(11, 'daily_words', 30)`，且该行数字按**响应**更新（mock 返回 `achieved: 12, rate: 40`，断言页面显示 `12 / 30`）。
5. 保存失败（mock reject `new ApiError(1001, '入参校验失败')`）→ 该行出现红字、**输入框仍是用户输入的值**（不回滚）、按钮恢复可点。
6. 非法输入（输入 `0` 或 `abc`）→ 不发请求、直接显示校验文案。
7. `studentId === null` → `goals-no-student`；`err.code === 1005` → `goals-student-forbidden`。
8. 切孩子不闪旧数据（Pin 反闪）：先 `studentId=11` 渲染出 A 的目标，再 `act(() => useParentStudentStore.setState({ studentId: 12 }))` 且让 12 的请求挂起 → 断言**看不到** A 的数字（`goals-skeleton` 出现或内容为空）。

- [ ] **Step 4: 路由替换 + 路由钉子**

```tsx
// routeTable.tsx 顶部
import ParentGoalsPage from '@/pages/parent/ParentGoalsPage';
// 家长路由表内
{ path: 'goals', element: <ParentGoalsPage /> },
```

`routeTable.test.tsx` 的 Parent 路由块追加：

```tsx
  it('/parent/goals 渲染真页而不是占位', () => {
    const { router } = renderAt('/parent/goals');
    const el = router.state.matches.at(-1)?.route.element as React.ReactElement;
    expect((el.type as { name?: string })?.name ?? String(el.type)).toContain('ParentGoalsPage');
  });
```

> 该文件既有 Parent 路由用例的写法是什么样，就照那个写法来（先读再改，别照抄本段的 cast 写法）。

- [ ] **Step 5: 跑测试 + 类型检查 + lint**

```bash
cd apps/web && npx vitest run src/pages/parent/ParentGoalsPage.test.tsx src/routes/routeTable.test.tsx && npx tsc -b && npm run lint
```

Expected: 全绿；`tsc`/lint 无输出。
⚠️ 既有红：`routeTable.test.tsx` 里「主轨侧边导航不含辅轨入口」那条断言 `[data-theme="student-day"]`，`StudentLayout` 按挂钟 18:00–06:00 切夜间 → **夜间跑必红**，与本任务无关（清单文档 §3.3 第 6 项）。**不要**顺手去改它。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/pages/parent/ParentGoalsPage.tsx \
        apps/web/src/pages/parent/ParentGoalsPage.test.tsx \
        apps/web/src/routes/routeTable.tsx apps/web/src/routes/routeTable.test.tsx
git commit -m "feat(parent): /parent/goals 从占位变真页（读四目标 + 逐行改目标）"
```

---

### Task 11: 仪表盘「专项学情」卡 + 报告页「真掌握度」卡

**Files:**
- Create: `apps/web/src/components/business/parent/SpecialsPanel.tsx`
- Test: `apps/web/src/components/business/parent/SpecialsPanel.test.tsx`
- Create: `apps/web/src/components/business/parent/MasteryPanel.tsx`
- Test: `apps/web/src/components/business/parent/MasteryPanel.test.tsx`
- Modify: `apps/web/src/pages/parent/ParentDashboardPage.tsx`（`StudentPanel` 里 `<StudyTimePanel>` 之后加 `<SpecialsPanel studentId={…} />`）
- Modify: `apps/web/src/pages/parent/ParentReportPage.tsx`（`report-weak-points` 卡**旁边**加 `<MasteryPanel … />`）
- Modify: `apps/web/src/pages/parent/ParentReportPage.test.tsx`（加「两卡并存」断言）

**§10 并存不替换（本任务最容易做错的地方）**
- 报告页上「薄弱知识点」（**错题数代理**，`weakPoints`）与「真掌握度」（`student_knowledge_mastery`）**两张卡并存、标题不同、不得合并**，也**不得**用新卡替换旧卡。旧卡的 `data-testid="report-weak-points"` 与它内部的「未标注知识点的错题数」提示**一个字都不许动**。
- 仪表盘「专项学情」与既有「学习时长」卡也是并列关系（前者是专项作答量，后者是会话时长），**不相互替代**。

**组件契约（两个都走「自己的数据自己取」）**

`SpecialsPanel`：
- props：`{ studentId: number }`（**只收 id，不收父组件已取的数据**——每个孩子一份，父组件不重复取数）
- 内部 state：`{ studentId, value } | null` + `failure`（同 `StudentPanel` 的 `study/usage` 写法），请求 `getParentSpecials(studentId)`
- 派生值按 `value && value.studentId === studentId` 比对（**反闪**）
- 渲染：`<Card className="p-5" data-testid={`dashboard-special-${studentId}`}>`，标题「专项学情」；四个模块各一行：模块名（语文默写 / 语文解释 / 语文含义 / 英语背单词）+ `units` 单位数 + `rate === null ? '暂无数据' : `${rate}%``；英语那行额外显示 `newWords`（文案「答对 N 词」）
- 图：把该学生的 `byDay` **合并四个模块**后喂 `ChartBar`（`points = [{label: date, value: 总数}]`，按日期升序）。**若无 byDay 数据** → 不渲染图（`ChartBar` 自带「暂无数据」空态，直接喂空数组即可）
- 取数失败：**静默降级**为「暂无数据」（与 `StudyTimePanel` 同款——专项是增值信息，不该让整页报错）

`MasteryPanel`：
- props：`{ studentId: number; mastery: ParentMastery | null; error?: number | null }`——**报告页已经把数据取回来了吗？没有**：报告页的 `getParentReport` 不含 mastery，所以本组件**自己取**：props 只收 `{ studentId }`，内部 `getParentMastery(studentId, 10)`，`{ studentId, value }` 反闪写法同上。
- 渲染：`<Card className="p-5" data-testid="report-mastery">`，标题「真掌握度」+ 副标题「（按知识点掌握度，累计）」；两段内容：
  1. **覆盖率说明（必显）**：`共 ${totalQuestions} 道题中 ${coveredQuestions} 道标注了知识点，另有 ${uncovered} 道未标注、未计入下面的统计。`（`data-testid="mastery-coverage"`）
     —— 不显示这句，家长会把「列出的几个弱项」当成全部问题（spec §4.8 规则①）。
  2. 最弱 10 项列表：每行 `name` + `correctCount`/`errorCount` 文案 + 掌握度（`Math.round(masteryScore * 100)` 显示百分比，**注意后端给的是 0..1 比值**）+ 段位 `level`（0–5）
- 空态：`items.length === 0` → 「暂无掌握度数据」（**但覆盖率句仍要显示**——否则家长分不清「没数据」与「没覆盖」）
- 取数失败：卡内错误文案 + 「重试」（`data-testid="mastery-error"`）；**不得**影响同页其它卡（尤其 `report-weak-points`）

- [ ] **Step 1: 写两个组件（含反闪写法）+ 各自的渲染测试**

测试重点（组件级，直接 `<SpecialsPanel studentId={11} />` 渲染，**不走路由表**）：

`SpecialsPanel.test.tsx`：
1. 四模块名都在；`units` / `rate` 正确显示。
2. `rate === null` → 「暂无数据」，**不出现 0%**。
3. `vocabulary.newWords` 显示为「答对 N 词」，另三个模块**不出现**这个词。
4. 取数失败 → 出现「暂无数据」，**不抛错、不渲错误卡**。
5. 反闪：`studentId` 从 11 改到 12（12 的请求挂起）→ 看不到 11 的 `units`。

`MasteryPanel.test.tsx`：
1. `mastery-coverage` 文案含 530 / 203 / 327（用 mock 的 `coveredQuestions: 203, totalQuestions: 530, uncovered: 327`）。
2. `masteryScore: 0.5` 显示「50%」（**不是 0.5% 也不是 0%**）。
3. `items` 为空 → 「暂无掌握度数据」**且覆盖率句仍在**。
4. 取数失败 → `mastery-error` 出现且有「重试」。
5. 反闪：同 `SpecialsPanel` 第 5 条。

`afterEach(() => cleanup())` 必须写（`globals: false`，不自动 cleanup）。

- [ ] **Step 2: 接到两个页面**

**(a)** `ParentDashboardPage.tsx` 的 `StudentPanel` 内，`<StudyTimePanel … />` 之后：

```tsx
        <SpecialsPanel studentId={student.studentId} />
```

**(b)** `ParentReportPage.tsx` 的 `report-weak-points` 卡**之后**（同级、不嵌套）：

```tsx
          {/* 真掌握度：与上面的「薄弱知识点」（错题数代理）**并存不替换**，标题必须不同（spec §10） */}
          <MasteryPanel studentId={studentId} />
```

**(c)** `ParentReportPage.test.tsx` 追加一条「两卡并存」钉子：

```tsx
  it('真掌握度与薄弱知识点两张卡并存、标题不同（不合并、不替换）', async () => {
    renderAt('/parent/report');
    expect(await screen.findByTestId('report-weak-points')).toBeTruthy();
    expect(await screen.findByTestId('report-mastery')).toBeTruthy();
    // 旧卡内容一个字没动
    expect(screen.getByTestId('report-weak-points').textContent).toContain('薄弱知识点');
    expect(screen.getByTestId('report-mastery').textContent).toContain('真掌握度');
  });
```

> 该文件已 mock 整个 `@/services/api`；`MasteryPanel` 会调 `getParentMastery`，**必须在 mock 里补上这个方法**（否则是 `undefined` → 组件抛错）。这是本任务最容易漏的一步。

- [ ] **Step 3: 跑测试 + 类型检查 + lint + 构建**

```bash
cd apps/web && npx vitest run src/components/business/parent src/pages/parent && npx tsc -b && npm run lint && npm run build
```

Expected: 全绿；`tsc`/lint 无输出；`vite build` 成功。

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/components/business/parent/SpecialsPanel.tsx \
        apps/web/src/components/business/parent/SpecialsPanel.test.tsx \
        apps/web/src/components/business/parent/MasteryPanel.tsx \
        apps/web/src/components/business/parent/MasteryPanel.test.tsx \
        apps/web/src/pages/parent/ParentDashboardPage.tsx \
        apps/web/src/pages/parent/ParentReportPage.tsx \
        apps/web/src/pages/parent/ParentReportPage.test.tsx
git commit -m "feat(parent): 仪表盘专项卡 + 报告页真掌握度卡（与薄弱知识点并存）"
```

---

### Task 12: 文档同步（两份 API 文档必须同时改）

**Files:**
- Modify: `docs/API接口与数据流设计文档.md`（§4.13 加 4 行 + 旧 goals CRUD 标废弃；新增 §4.24；新增 §6.27；§7 的 P6.5 行；§10 加 v4.3）
- Modify: `docs/api/openapi.yaml`（4 条新路径 + 3 个新 schema + 旧 goals 4 个 operation 标 `deprecated: true`）
- Modify: `docs/K12智学系统-数据库设计文档.md`（新增 §3.17 `special_practice_logs`；§3.8 `goals` 加 `metric` 行；§4 枚举值汇总；§8 加 v2.5）
- Modify: `docs/ai-core-changelog.md`（追加 Phase 1B 条目）
- Modify: `CLAUDE.md`（家长端学情节订正一处**已失实**的描述）

**⚠️ 本任务是「同一事实写五处」，逐处核对，别只改两份 API 文档。**

- [ ] **Step 1: `docs/API接口与数据流设计文档.md`**

**(a) §4.13 表格**（4 列：`方法 | 路径 | 说明 | 阶段`）追加 4 行，写法照抄 §4.13 既有的 `study-time` 行（单行、把校验与返回形状都写在「说明」列里）：

```markdown
| GET | `/api/parent/students/{studentId}/specials` | **专项学情（埋点 Phase 1B）**。query `from`/`to`（`YYYY-MM-DD`，缺省近 7 天；非法**宽容回落**、不 400）。响应四模块 `{dictation,interpretation,meaning,vocabulary}`，每模块 `{units,correct,rate\|null,byDay:[{date,count}]}`，`vocabulary` 多 `newWords`。**四个键后端保证都在**（没数据给 0 / `rate:null` / `byDay:[]`）；`rate` 沿用 `answered=0 → null`（**不许写 0**）。口径见 §6.27 | MVP |
| GET | `/api/parent/students/{studentId}/mastery` | **真掌握度（埋点 Phase 1B）**。query `limit`（缺省 10、上限 50；**越界 400/1001，不静默钳制**）。按 `mastery_score ASC` 取最弱 N 个知识点，响应 `{items:[{knowledgePointId,name,masteryScore(0..1),level,correctCount,errorCount,lastSeenAt}],coveredQuestions,totalQuestions,uncovered}`。**覆盖率三项必须展示**——题库仅 38% 的题绑了知识点，不展示会让家长误以为「问题只有这几个」。**与 §6.8 的 `weakPoints`（错题数代理）是两套口径、并存不替换** | MVP |
| GET | `/api/parent/students/{studentId}/goals/attainment` | **目标达成（埋点 Phase 1B）**。无 query。读 `goals WHERE is_active=1`；**无目标时懒初始化四个默认目标**（60 分钟/20 词/8 篇/10 道，只补缺失、不覆盖家长已改的值）。达成值按 `metric` 分派（`daily_study_minutes` ← `study_sessions` 秒→分钟向下取整；`daily_words` ← `special_practice_logs` 的 `en_vocabulary` 单位数；`weekly_passages` ← 三个语文专项**去重篇目数**；`weekly_clear_errors` ← `main_error_books` 窗口内清零数）。响应 `{items:[{metric,period,title,target,achieved,rate\|null}]}`，`rate = toRate(target, achieved)`（**分母是 target**，为 0 → null；**允许 > 100 = 超额**）。窗口：daily=今天、weekly=近 7 天，应用层算好传参（不用 `CURDATE()`） | MVP |
| PUT | `/api/parent/students/{studentId}/goals/{metric}` | **改目标值（本批唯一写端点）**。路径 `metric ∈ daily_study_minutes\|daily_words\|weekly_passages\|weekly_clear_errors`（**白名单外 400/1001**）；body `{target: int 1..9999}`（**只收 target**，`period`/`title` 由服务端按 `metric` 派生）。按 `(student_id, metric)` upsert 并把 `is_active` 置回 1（复活被停用的目标）。响应 = **该 metric 的最新达成情况**（形状同 attainment 的一行），调用方原地替换即可、不必再 GET。归属校验同其它家长端点（403/1005、404/1002） | MVP |
```

**(b) 旧 goals CRUD 标废弃**（§4.13 里那 4 行之后插一个引用块——这是本文档既有的废弃写法，照 §7 的 P5.3 那条来）：

```markdown
> **已废弃（2026-09-22 用户裁决）**：以下 4 个 `goals` CRUD（`GET/POST/PATCH/DELETE /students/{studentId}/goals`）**没有 `metric` 维度**，被上方的 `/goals/attainment` 与 `PUT /goals/{metric}` 取代。保留仅为兼容存量调用方，**新代码勿引用**。
```

**(c) 新增 §4.24**：插在 §4.23 之后、`## 5. WebSocket 设计` 之前的 `---` 处（**§4.24 是下一个空号**）。内容写「家长端学情聚合（Phase 1B）」的端点总览 + 一张 `方法 | 路径 | 入参 | 校验与逻辑 | 返回` 的宽表（把上面 4 行浓缩）+ 一段 blockquote 讲**隐私分层**（本批 3 个读端点**不含任何 `tier='ops'` 派生字段**，「建议」类文案若要有必须由后端生成中性结论、**不暴露任何次数**）。

**(d) 新增 §6.27**：追加在 §6 末尾（**§6.27 是下一个空号**，§6.26 是 LLM 账本）。照抄 §6.25 的骨架（一句「设计见 spec」→ ` ```text ` 流程图 → 加粗小标题段落）：

```text
判题出口（4 个写入点 + 1 个回写）
  · training.service.judgeDictation     ┐
  · training.service.judgeInterpretation├─► special_practice_logs（一行 = 一个作答单位）
  · meaning.service.judgeMeaning        │      · 语文：句级 verdict 由 collapseUnitVerdict 塌缩
  · vocabulary.service.judge            ┘      · 英语：wrong→incorrect，error_counted 取 progressDelta
  · practice.JudgeCoreService.finishJudge ─► student_knowledge_mastery（UPSERT 累计 + 现算 score/level）

读侧（家长端，全部只读实时聚合）
  GET /specials  ─► aggregateByModule / countByDayByModule / countDistinctCorrectWords
  GET /mastery   ─► listWeakest + countQuestionCoverage
  GET /goals/attainment ─► goals（+ 懒初始化）→ 四路达成值
  PUT /goals/{metric}   ─► upsertTarget → 回该 metric 最新达成
```

必须写进 §6.27 的**四条口径**（会被反复问）：① 一行 = 一个作答单位（默写一篇/解释含义一句/背词一题），故 `units = COUNT(*)`；② `answered = SUM(is_correct IS NOT NULL)` 排除「没有明确对错」的行、`rate` 用 `toRate(answered, correct)`；③ **掌握度与 `weakPoints` 两套口径并存不替换**；④ 埋点写入**绝不阻断判题**（`try/catch` 只 warn；掌握度回写走 `void`，不 await）。

**(e) §7 的 P6.5 行**（`| P6.5 目标设定 | /parent/goals | GET/POST/PATCH/DELETE … |`）改成真页 + 新端点，旧 CRUD 标废弃（§7 的废弃写法见同表 P5.3 那条：`~~删除线~~` + `**已废止（日期 用户裁决）**`）。

**(f) §10 变更日志**：表头下第一行插 `v4.3`，行格式与 v4.2/v4.1 一致（**行尾有一个空格再跟 `| `**）：

```markdown
| v4.3 | 2026-09-22 | **埋点 Phase 1B：专项学情 / 真掌握度 / 目标达成**。契约变更：新增 `GET /api/parent/students/{studentId}/specials`、`/mastery`、`/goals/attainment` 与 `PUT /api/parent/students/{studentId}/goals/{metric}`（§4.13 四行 + §4.24 总览，`openapi.yaml` 同步）；旧 `goals` CRUD（无 `metric`）**标废弃保留**。数据面：`special_practice_logs` 新表（DB 文档 §3.17）、`goals` 加 `metric` 列与唯一键 `(student_id, metric)`（迁移 `2026-09-22_special_practice_logs_and_goals.sql`）。两条口径裁决（2026-09-22 用户确认）：① `weekly_passages` 的达成值 = 三个语文专项**去重篇目数**（不要用行数——解释/含义是一句一行，会把「8 句」当「8 篇」）；② 默认目标 60 分钟/20 词/8 篇/10 道。四处新增口径：专项日志一行 = 一个作答单位、`rate` 分母为 0 时恒 `null`、掌握度**与 `weakPoints` 并存不替换**、埋点写入**永不阻断判题**。顺带修 spec §4.8 的 UPSERT 算式 bug（`ON DUPLICATE KEY UPDATE` 的 SET 从左到右读到的已是更新后的列，原式把本次增量算了两遍：1 对 1 错实测 0.333，应为 0.500） | 
```

- [ ] **Step 2: `docs/api/openapi.yaml`**

**(a)** 在 `/parent/students/{studentId}/study-time` 与 `/parent/students/{studentId}/today-usage` 之后、旧的 `/parent/students/{studentId}/goals:` **之前**，插 4 个 path item。逐条照抄 `study-time` 的写法：`tags: [Parent]`、`operationId` 驼峰、响应 `allOf: [CommonResponse, {type: object, properties: {data: <Schema>}}]`、成功码 `'200'`、**`studentId` 的 schema 用 `type: integer`**（新端点一律 integer；旧 goals 那几条写的是 `string`，属历史不一致，**不要跟着抄**）。

必须写进 description 的：`specials` 的「`rate` 缺省 null = 本期无可判作答，不是 0」与「四个键保证都在」；`mastery` 的「`limit` 缺省 10 上限 50，越界 400」与「覆盖率三项必须展示」；`goals/attainment` 的懒初始化与四路达成值分派；`PUT` 的白名单 400 与只收 `target`。

**(b)** 旧 goals 的 4 个 operation（`get`/`post`/`patch`/`delete`）各加一行 `deprecated: true`（放在 `summary` 之后、`operationId` 之前），并在 `description` 开头写 `**已废弃**：旧目标 CRUD 无 metric 维度，被 /goals/attainment 与 PUT /goals/{metric} 取代。` —— 本文件此前**从未用过** `deprecated`，这是第一处。

> ⚠️ 新的 `PUT /parent/students/{studentId}/goals/{metric}` 与旧的 `/parent/students/{studentId}/goals/{goalId}` 是**两个模板路径匹配同一批 URL**：OpenAPI 视为两个 path key，方法不同（PUT vs PATCH/DELETE）故不冲突，但易混淆。在 §4.24 与 openapi 的 PUT description 里各写一句说明两者共存的原因。

**(c)** `components.schemas` 末尾（`EndSessionRequest` 之后）追加 3 个 schema：`SpecialModuleSummary`、`SpecialsSummary`、`ParentMasterySummary`、`GoalAttainmentItem`、`GoalAttainmentSummary`（PascalCase、feature-prefixed；`rate` 用 `nullable: true` + `type: number`，与 `TodayUsageSummary.limitMinutes` 同款——**不要**用 `type: [number,'null']`，本文件既有风格是 `nullable`）。

- [ ] **Step 3: `docs/K12智学系统-数据库设计文档.md`**

**(a)** 新增 `### 3.17 专项练习日志（Phase 1B，2026-09-22）`：插在 §3.16 之后、`## 4. 枚举值汇总` 之前。照 §3.16 的骨架写（`>` blockquote 三行：实施状态 / 背景 / 设计指针 → `#### special_practice_logs（…）` → 5 列表格 `列名|类型|可空|默认值|说明` → `PK/FK/Index/口径` 项目符号）。**必须写清**：只挂 `student_id` 一个外键（`ref_id` 故意不设，理由同 `student_word_progress.word_id`）、`verdict` 是跨专项统一字典（**没有 `wrong`**，英语入库前映射成 `incorrect`）、`error_counted` 必须复用 `progressDelta`。

**(b)** §3.8 的 `goals` 表：在 `target_value` 行之后插 `metric` 行；并在项目符号里补唯一键 `uniq_goals_student_metric (student_id, metric)`（这是「按 metric upsert」的前提）。

**(c)** §4 枚举值汇总：在 `goal.period` 附近补 `goal.metric`；在 `study_session.*` 附近补 `special_practice_logs.module` / `.verdict`。

**(d)** §8 变更日志：表头下插 `v2.5` 行。

- [ ] **Step 4: `docs/ai-core-changelog.md`**

在引言 `---` 之后、现有最新条目之上，追加：

```markdown
## 2026-09-22 埋点 Phase 1B：专项学情 / 真掌握度 / 目标达成

- 新表 `special_practice_logs`（迁移 `2026-09-22_special_practice_logs_and_goals.sql` + `schema.sql`；DB 文档 §3.17）与 `goals.metric` 列（唯一键 `(student_id, metric)`）。四个写入点：语文默写/解释/含义 + 英语背单词的判题出口（`units` 一行 = 一个作答单位）。写侧**永不阻断判题**。
- 掌握度回写：`MasteryService` 挂在 `JudgeCoreService` 的**出口收尾** `finishJudge`（`void`，不 await），四条规则见 spec §4.8。⚠️ 顺手修掉 spec §4.8 的 UPSERT 算式 bug：`ON DUPLICATE KEY UPDATE` 的 SET **从左到右求值、读到的已是更新后的列**，原式把本次增量算了两遍（1 对 1 错实测 0.333，应为 0.500，且错值会被后续判题持续放大）。已改为「计数在前、score/level 只引用更新后的列」。
- 家长端 4 端点：`GET /specials`、`GET /mastery`、`GET /goals/attainment`、`PUT /goals/{metric}`（API 设计文档 §4.13/§4.24、数据流 §6.27、契约 `openapi.yaml`）；旧 `goals` CRUD 标废弃保留。
- 两条口径裁决（用户确认）：`weekly_passages` 用三个语文专项**去重篇目数**（不是行数——解释/含义一句一行）；默认目标 60 分钟/20 词/8 篇/10 道。
- 前端：`/parent/goals` 从占位变真页；仪表盘加「专项学情」卡；报告页加「真掌握度」卡（**与「薄弱知识点」并存不替换**，spec §10）。
```

- [ ] **Step 5: `CLAUDE.md` 订正失实描述**

「家长端学情」节那条现在写「知识点掌握度底层无数据，用错题数代理替代」——**Phase 1B 起前半句已不成立**。改成（**只加半句、不新增段落**，本文件已 22.9KB、超 ~15KB 维护目标）：

```markdown
- 学习时长走会话口径（`study_sessions`，1A）；知识点掌握度自 Phase 1B 起由 `student_knowledge_mastery` 实时回写（**与「错题数代理」的 `weakPoints` 并存不替换**，两卡标题必须不同）；专项学情/目标达成为只读实时聚合。薄弱点必须同时给「未标注知识点的错题数」，否则家长会误读成「只有这些问题」。口径见 `docs/API接口与数据流设计文档.md` §6.27 与 `docs/ai-core-changelog.md` 本批条目。
```

- [ ] **Step 6: 两份 API 文档的端点清单核对（本仓硬规则）**

文档类改动**没有自动化测试**，只能靠这道人工核验；逐条比对两份文档的路径列表：

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
echo "--- openapi 新增 4 条 ---"
grep -nE "^\s+/parent/students/\{studentId\}/(specials|mastery|goals/attainment):" docs/api/openapi.yaml
grep -nE "^\s+/parent/students/\{studentId\}/goals/\{metric\}:" docs/api/openapi.yaml
echo "--- API 文档新增 4 条 ---"
grep -nE "students/\{studentId\}/(specials|mastery|goals/attainment|goals/\{metric\})" docs/API接口与数据流设计文档.md
echo "--- 旧 goals CRUD 是否两边都标了废弃 ---"
grep -n "deprecated: true" docs/api/openapi.yaml | head
grep -n "已废弃" docs/API接口与数据流设计文档.md | head
```

Expected: 两边都能找到对应路径；openapi 里 `deprecated: true` **恰好 4 处**（旧 goals 的 4 个 operation）；API 文档里有一处「已废弃」引用块。

- [ ] **Step 7: 提交**

```bash
git add docs/API接口与数据流设计文档.md docs/api/openapi.yaml \
        docs/K12智学系统-数据库设计文档.md docs/ai-core-changelog.md CLAUDE.md
git commit -m "docs: 同步埋点 Phase 1B（§4.13/§4.24/§6.27、openapi、DB 设计、changelog、CLAUDE.md）"
```

---

## 完工判据（1B 整体）

1. `apps/server`：`npm test` 全绿 + `npx tsc --noEmit` 无输出 + `npm run build` 成功 + `node dist/main.js` 启动冒烟里三条新路由被 mapped。
2. `apps/web`：`npm test` 全绿（除清单文档 §3.3 第 6 项那条既有夜间红）+ `npx tsc -b` + `npm run lint` + `npm run build`。
3. DB：迁移可幂等复跑；`schema.sql` 与迁移建表语句 `diff` 一致；`goals.metric` 唯一键存在。
4. 文档：Task 12 Step 6 的两份文档路径核对通过。
5. **人工走查（无法自动化，留给用户）**：家长端登录 → 仪表盘看到专项卡 → 报告页两张卡并存 → `/parent/goals` 改一个目标并刷新确认已保存。








