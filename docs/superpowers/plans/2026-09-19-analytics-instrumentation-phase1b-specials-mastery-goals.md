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
   * 判题后 UPSERT 一条（spec §4.8 的 SQL，逐字对齐）。
   *
   * 用 `AS new` 别名而不是 `VALUES()`（后者在 MySQL 8.0.20+ 已废弃）。
   * 首次插入时 score/level 由**本次**的对错给出（答对 1.0/5、答错 0.0/0）；
   * 命中已有行时 SQL 会用**累计后**的计数重算它们（故传入的这两个值只在首插生效）。
   * 分母 `NULLIF(..., 0)` 防除零（首插时分子分母都非零，防御的是极端历史数据）。
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
         mastery_score = (student_knowledge_mastery.correct_count + new.correct_count)
                       / NULLIF(student_knowledge_mastery.correct_count + new.correct_count
                              + student_knowledge_mastery.error_count + new.error_count, 0),
         level         = FLOOR(5 * ((student_knowledge_mastery.correct_count + new.correct_count)
                       / NULLIF(student_knowledge_mastery.correct_count + new.correct_count
                              + student_knowledge_mastery.error_count + new.error_count, 0))),
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




