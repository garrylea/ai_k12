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

Expected: `columns=14`、`fk=1`、`datetim3=1`、`triggers=0`、`goals_metric=1`、`goals_uniq=2`（唯一键两列各一行，故是 2）。

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


