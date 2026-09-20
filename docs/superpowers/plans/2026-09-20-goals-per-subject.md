# P6.5 目标设定补齐：按学科 + 课时完成表 + 采集修正

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「目标设定」从**四个全局目标**改成 PRD/UX 要求的**按学科设定**，并顺手补上它依赖的两个数据缺口（课时完成事件、按学科的学习时长采集）。

**为什么会有这批**：1B 按 spec 实现了「四个全局 metric」（学习时长 / 背单词 / 古诗文篇目 / 清零错题），但 PRD 第 200 行写的是「**按学科**设定每日/每周学习目标」、UX §P6.5 写的是「**按学科**设定：每日学习时长目标、**每周完课目标**」。用户 2026-09-20 走查时提出这个不一致，并裁决**按 PRD 补齐**。

**Architecture:** 三条改动线。① 目标模型从「全局 metric」改为「(学科, 指标)」二元组：`goals` 加**生成列** `scope_subject_id`（条件式，`VIRTUAL`）把唯一键改到 `(student_id, scope_subject_id, metric)` —— 因为 MySQL 的唯一索引**把 NULL 视为互不相等**，直接用 `(student_id, subject_id, metric)` 会让「全局目标」失去唯一性、`ON DUPLICATE KEY` 静默失效（本批已实测）。② 新建 `lesson_completions`（每课完成事件）供「每周完课」用；③ 会话心跳支持**补写** `subject_id`，让「按学科学习时长」有数据。

**Tech Stack:** NestJS + TypeScript ESM + mysql2 + Zod + Vitest；React + Zustand + Tailwind（CSS 变量 token）。

## Global Constraints

> 本节每条都是硬规则，每个任务的要求都隐含包含。

**用户已裁决的三条（2026-09-20，勿自行改回）**

1. **提醒本期不做**：`goals.reminder_enabled` 列保留但继续恒 0（`upsertTarget` 不写 1）；**不引入任何调度器/cron**（本仓零调度基础）；**短信一律不做**（仓库内无任何短信/推送 SDK）。PRD 第 200 行与 UX §P6.5 的「接收提醒 / 提醒方式（系统通知 / 短信）」在文档里标「**本期不做，单独立项**」并写明原因，**不删需求原文**。
2. **「每周完课目标」用新表 `lesson_completions` 承载**（不用积分账本代理）。**已知历史缺口**：上线前的完课**补不回来**，达成值只从上线起算 —— 必须写进表注释、DB 文档与页面文案。
3. **修采集：心跳补写 `subject_id`**（会话的 `subject_id` 为 NULL 时才补），**只对之后的会话生效**，已存在的 NULL 会话不追溯。

**沿用 1B 已确立的硬规则（别违背）**

- **埋点/派生写入永不阻断主链路**：`lesson_completions` 写入、心跳补写都 best-effort，失败只 warn、绝不 500、绝不 `await` 拖长请求。
- **家长端四个学情端点保持只读**（`CLAUDE.md` 家长端学情节：「不要往这四个端点里加写入逻辑」）。本批的写入点只有 `ProgressService`（完课）与 `analytics` 的心跳（采集），都在写路径上。
- **`rate` 分母为 0 → `null`**，一律用 `rate.util.ts` 的 `toRate`；**`answered=0` 不是 0%**。
- **窗口由应用层算好传参**（`startOfDaysAgo` / `resolveRange`），**绝不用 `CURDATE()`**；半开区间 `< endExclusive`。
- **DB 约定**：时间列 `DATETIME(3)`；`updated_at` 用**列级** `ON UPDATE CURRENT_TIMESTAMP(3)`（**不加触发器**）；建表 `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`；**无迁移运行器 → 手工 apply 且必须幂等**（加列/索引用 `information_schema` + `PREPARE` 守卫）；新表/新列**必须同时进 `tools/db/schema.sql`**，且 `CREATE TABLE` 语句两处**逐字一致**。
- **`ON DUPLICATE KEY UPDATE` / 单表 `SET` 的赋值从左到右求值，后面读到的可能是新值** —— 这条在 `study-sessions.repo.ts:103-112` 早有记载（1A 留的注释 + 顺序钉子用例），1B 又踩了一次。**新增/修改任何 SET 子句或 INSERT 占位符顺序，必须逐位对照列清单**。
- **测试**：`globals: false` → 多用例文件自己 `afterEach(cleanup())` 并复位 Zustand 单例；**仓储测试不许只断言「自己传了什么 payload」**（证明不了落库语义）—— 用 `goals.repo.test.ts` 的 `zipInsert()` 按列名配对断言，凡「参数顺序 ↔ 列清单」的映射都要这样钉；每个新组件/页面补渲染测试。
- **环境**：起后端 `node dist/main.js`；冒烟用**独立端口 + 按 PID 收尾**，**别** `pkill -f 'node dist/main.js'`（用户本机有自己的服务在跑）。
- ⚠️ **既有夜间红**：`apps/web/src/routes/routeTable.test.tsx` 的「主轨侧边导航不含辅轨入口」断言 `[data-theme="student-day"]`，而 `themeStore.autoToggleNightMode` 在 18:00–06:00 切夜间 → **夜间跑必红**（已用 `TZ=America/Los_Angeles` 验证是挂钟所致）。**别算到本批头上、也别顺手改它**。

## 范围与模型设计

### 目标模型：`(学科, 指标)` 二元组

**所有指标都按学科**（不存在「全局目标」），学科取自学生**在学学科**：

| metric | 适用学科 | period | 默认 target | 达成值数据源 |
|---|---|---|---|---|
| `daily_study_minutes` | 每个在学学科 | daily | 30（分钟） | `study_sessions` where `subject_id = ?`（**依赖裁决 3 的采集修正**） |
| `weekly_lessons` | 每个在学学科 | weekly | 2（课） | **新表** `lesson_completions`（窗口内行数） |
| `weekly_clear_errors` | 每个在学学科 | weekly | 5（道） | `main_error_books`（`is_cleared=1 AND cleared_at` 落窗口，`subject_id = ?` 天然可按学科） |
| `daily_words` | **仅英语** | daily | 20（词） | `special_practice_logs` 的 `en_vocabulary` 单位数（该表 `subject_id` 恒 NULL，按 `module` 筛） |
| `weekly_passages` | **仅语文** | weekly | 8（篇） | `special_practice_logs` 三个 `chinese_*` 的**去重篇目数**（同上） |

**「在学学科」的定义**：`progress` 表里该生的行（一行 = 一 (student, subject)，家长配教材即产生）**∪ 固定兜底 {语文, 英语}**，再与 **MVP 学科白名单 {数学, 语文, 英语}** 求交。

- 为什么兜底加上语文/英语：`daily_words` / `weekly_passages` 属于**训练轨专项**（英语背单词、语文古诗文），不依赖家长配教材，得有位置可设。
- 为什么限白名单：PRD 的 MVP 只有数学/语文/英语；`subjects` 表里有 9 个学科，若全建默认目标，页面会冒出几十行无人设的条目。
- 学生在学学科为空且兜底也取不到 → `ensureDefaults` 不建行、`attainment` 返回空 items，前端提示「先去配置教材」（**不编造默认目标**）。

**默认目标行数**：数学 3 + 语文 4 + 英语 4 = **11 行**（分组展示后可接受）。学科顺序按 `subjects.sort_order`，指标顺序同表格。

### 为什么用生成列（`scope_subject_id`）而不是直接 `(student_id, subject_id, metric)`

**实测（MySQL 9.5.0，事务 + 临时表，已回滚）**：`UNIQUE (student_id, subject_id, metric)` 在 `subject_id IS NULL` 时**允许两行完全相同** —— 唯一索引把 NULL 视为互不相等。后果不是报错而是**静默失效**：`ON DUPLICATE KEY UPDATE` 不再命中，同一个目标会被反复插入。

所以加一列**生成列**把 NULL 折成 0，再把唯一键建在它上面：

```sql
scope_subject_id BIGINT AS (IF(metric IS NULL, NULL, COALESCE(subject_id, 0))) VIRTUAL
UNIQUE KEY uniq_goals_student_scope_metric (student_id, scope_subject_id, metric)
```

**为什么是「条件式」而不是简单的 `COALESCE(subject_id, 0)`（2026-09-20 执行期实测补充）**：1B 的去重步骤把重复行的 `metric` 清成了 `NULL`（`is_active=0`）。若 scope 对它们也算出 0，则同一个学生的多行 `metric IS NULL` 会在新唯一键上**互相冲突 → `ADD UNIQUE KEY` 直接失败**（`ERROR 1062`）。让 `metric IS NULL` 时 scope 也为 `NULL`，就回到 MySQL「NULL 互不相等」的语义——历史停用行继续共存，而真实目标（`metric NOT NULL`）的唯一性照常成立。已在真库用临时表验证：两行 `metric IS NULL` 可共存，而两行 `(7,1,'daily_words')` 会被拦。

好处：① 唯一性对真实目标成立，upsert 永远正确；② 迁移**不必删除任何历史行**；③ 将来若真要「全局目标」（`subject_id = NULL` 但有 metric），语义天然成立。

**必须是 `VIRTUAL` 而不是 `STORED`（2026-09-20 执行期实测）**：在 `goals` 上加 STORED 生成列报 `ERROR 1215 Cannot add foreign key constraint` —— STORED 要重建整表，而该表有 `fk_goals_student_id` / `fk_goals_subject_id`，重建时外键校验失败；VIRTUAL 不动行数据，加列与加索引都成功。**教训：别用临时表验证这类事**——临时表没有外键，我第一轮就是这么误判为可行的。

代价：**本仓首次使用生成列**（`grep GENERATED|STORED *.sql` 零命中）—— 必须在 DB 设计文档里记一笔，并说明为什么不用哨兵值 0（哨兵值会撞 `fk_goals_subject_id` 外键）。

### 端点契约变更（两份 API 文档必须同步）

| 端点 | 变更 |
|---|---|
| `GET /api/parent/students/{studentId}/goals/attainment` | `items[]` 每项**新增 `subjectId` / `subjectName`**；`metric` 不再全局唯一（同 metric 可出现在多个学科），故**排序固定为「学科 sort_order → 指标声明顺序」**；无在学学科时 `items: []` |
| `PUT /api/parent/students/{studentId}/goals/{metric}` | body 由 `{target}` 改为 **`{target, subjectId}`**（`subjectId` **必填**正整数）。校验顺序：归属校验 → `metric` 白名单 → `subjectId` 为正整数 → **该 metric 是否适用于该 subject**（如 `daily_words` 只允许英语，否则 400/1001）→ `target` 1–9999 → upsert。响应 = 该项最新达成情况（同 attainment 一行） |

**路径不再新增**（`/goals/{metric}` + body 里的 subjectId），避免又出现一条同深度模板路径。

## File Structure

**新建（后端）**

| 文件 | 职责 |
|---|---|
| `tools/db/migrations/2026-09-20_goals_per_subject_and_lesson_completions.sql` | `goals` 加生成列 + 改唯一键 + 回填；新建 `lesson_completions`；幂等 |
| `apps/server/src/database/repositories/lesson-completions.repo.ts` | 完课事件写入（`INSERT IGNORE`）+ 按学科窗口计数 |
| `apps/server/src/database/repositories/lesson-completions.repo.test.ts` | 同上测试（含列名配对断言） |

**修改（后端）**

| 文件 | 改什么 |
|---|---|
| `tools/db/schema.sql` | `goals` 段同步生成列与唯一键；新增 §18 `lesson_completions` |
| `apps/server/src/database/repositories/index.ts` | barrel 导出新仓储 |
| `apps/server/src/database/repositories/goals.repo.ts` | 三处 SQL 支持 `subjectId`；`GoalMetric` 加 `weekly_lessons` |
| `apps/server/src/database/repositories/study-sessions.repo.ts` | `heartbeat` 加可选 `subjectId` 补写（**注意 SET 顺序**） |
| `apps/server/src/database/repositories/parent-analytics.repo.ts` | 加「单学科窗口秒数」查询 |
| `apps/server/src/database/repositories/progress.repo.ts` | 加 `findSubjectIdsByStudent` |
| `apps/server/src/modules/analytics/study-sessions.service.ts` / `analytics.controller.ts` / `dto/*` | 心跳透传 `subjectId` |
| `apps/server/src/modules/progress/progress.service.ts` | 完课时写 `lesson_completions`（best-effort） |
| `apps/server/src/modules/parent-insights/goals.service.ts` | 目标模型改 `(学科, 指标)`：模板、默认值、达成值分派 |
| `apps/server/src/modules/parent-insights/parent-insights.controller.ts` | `PUT` body 加 `subjectId`；`GOAL_METRICS` 改「metric → 适用学科」表 |
| `apps/server/src/modules/parent-insights/dto/parent-insights.dto.ts` | `GoalAttainmentItem` 加 `subjectId`/`subjectName` |
| `apps/server/src/modules/parent-insights/parent-insights.module.ts` | providers 加两个新仓储 |

**修改（前端）**

| 文件 | 改什么 |
|---|---|
| `apps/web/src/analytics/tracker.ts` | 心跳带上当时可得的 `subjectId` |
| `apps/web/src/services/api.ts` | `ParentGoalMetric` 加 `weekly_lessons`；`ParentGoalAttainmentItem` 加学科字段；`putParentGoalTarget` 签名改 `(studentId, metric, target, subjectId)` |
| `apps/web/src/pages/parent/ParentGoalsPage.tsx` | **按学科分组**渲染；行 key 改 `${subjectId}:${metric}`（现在用 `metric` 当 key，同 metric 多学科会撞）；数字输入框**改用基座 `Input`**（见下） |
| `apps/web/src/pages/parent/ParentGoalsPage.test.tsx` | 按新契约重写断言 |

**文档**

| 文件 | 改什么 |
|---|---|
| `docs/API接口与数据流设计文档.md` | §4.13 两行改契约 + §4.24 口径改写 + §6.27 补完课/时长链路 + §10 加 v4.4 |
| `docs/api/openapi.yaml` | 两个端点的 request/response schema 同步（`metric` enum 加 `weekly_lessons`、加 `subjectId`） |
| `docs/K12智学系统-数据库设计文档.md` | `goals` 段改（生成列 + 新唯一键 + 指标表）；新增 `lesson_completions`；§4 枚举；§8 加 v2.6 |
| `docs/K12智学系统-产品需求文档.md` | 第 200 行「接收提醒」处加**本期不做**批注（**不删需求原文**） |
| `docs/UX-UI设计文档.md` | §P6.5 同上批注（提醒方式含短信 → 本期不做，短信单独立项） |
| `docs/ai-core-changelog.md` | 追加本批条目（含三条裁决与「1B 曾按 spec 偏离 PRD」的复盘） |
| `CLAUDE.md` | 家长端学情节补一句「目标是 (学科, 指标) 二元组」+ 生成列这条新约定 |

**顺带修掉的一处 1B 缺陷（用户走查发现）**：目标页的数字输入框当时写成原生 `<input>`（1px 浅灰边框、无聚焦态），在白卡上看起来像静态文字 → 用户找不到「哪里能改」。本批**改用基座 `Input`**（`border-2` + `focus-within` 变蓝 + 48px 高），并把该行的「保存」按钮与输入框放在同一视觉组里。

---

### Task 1: 迁移与 schema —— `goals` 改按学科 + 新建 `lesson_completions`

**Files:**
- Create: `tools/db/migrations/2026-09-20_goals_per_subject_and_lesson_completions.sql`
- Modify: `tools/db/schema.sql`（`goals` 段改；新增 §18 `lesson_completions`）

**Interfaces:**
- Consumes: 无（本批第一个任务）
- Produces: 生成列 `goals.scope_subject_id`、唯一键 `uniq_goals_student_scope_metric (student_id, scope_subject_id, metric)`、表 `lesson_completions`

**为什么这么设计（别改）**
- **生成列而不是哨兵值**：哨兵值 0 会撞 `fk_goals_subject_id`（0 不在 `subjects.id` 里）；生成列不动外键、不改数据语义。
- **保留 `subject_id` 可空**：迁移里的历史行（1B 去重时 `is_active=0`、`metric=NULL` 的行）不动它，靠 `is_active=1` 过滤——**迁移不做删除**（本仓纪律：不删既有数据）。
- **`lesson_completions.lesson_id` 不设外键**：`lessons` 是内容表、会全量重灌，设入向外键会把重灌卡死（同 `special_practice_logs.ref_id`、`student_word_progress.word_id` 的教训）。
- **`subject_id` 在 `lesson_completions` 里 NOT NULL**：写入时从 `progress.subject_id` 取（该列 NOT NULL），不需要可空。

- [ ] **Step 1: 写迁移**

创建 `tools/db/migrations/2026-09-20_goals_per_subject_and_lesson_completions.sql`：

```sql
-- 2026-09-20 P6.5 目标设定补齐：goals 改「按学科」+ 新建 lesson_completions
--
-- 做什么：
--   1) goals 加生成列 scope_subject_id = IF(metric IS NULL, NULL, COALESCE(subject_id, 0))（STORED），
--      唯一键从 (student_id, metric) 改到 (student_id, scope_subject_id, metric)
--   2) 新建 lesson_completions（每课完成事件），供「每周完课目标」用
--
-- 为什么：
--   * MySQL 的唯一索引把 NULL 视为互不相等 —— 直接用 (student_id, subject_id, metric)
--     会让 subject_id IS NULL 的行失去唯一性，ON DUPLICATE KEY 静默不命中、重复插行。
--     生成列把 NULL 折成 0，唯一性对真实目标成立（2026-09-20 实测确认）。
--   * 为什么是**条件式**（metric IS NULL 时 scope 也为 NULL）：1B 去重把重复行的 metric
--     清成了 NULL，若这些行的 scope 都算成 0，(student_id, 0, NULL) 会互相冲突，
--     ADD UNIQUE KEY 直接失败（ERROR 1062）。保持 NULL 就回到「NULL 互不相等」，
--     历史停用行继续共存、加键不失败。
--   * metric 变成「按学科」后，(student_id, metric) 这个旧键不再成立（同一 metric
--     在不同学科各有一行）。旧键必须先删，否则同一 metric 只能存一个学科。
--   * 不删任何历史行：subject_id 为 NULL 的历史行（1B 去重时停用的）留着，读侧靠
--     is_active=1 过滤。
--   * lesson_completions.lesson_id 故意不设外键（lessons 会全量重灌）。
--
-- 幂等：加列/加索引/改键全部带 information_schema 守卫；建表 IF NOT EXISTS
-- 回滚：DROP TABLE lesson_completions；
--       ALTER TABLE goals DROP KEY uniq_goals_student_scope_metric,
--                         ADD UNIQUE KEY uniq_goals_student_metric (student_id, metric),
--                         DROP COLUMN scope_subject_id;

-- ── 1. goals：加生成列（MySQL 8/9 无 ADD COLUMN IF NOT EXISTS，只能守卫）──
SET @col_scope := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'goals' AND COLUMN_NAME = 'scope_subject_id'
);
SET @ddl := IF(@col_scope = 0,
  'ALTER TABLE goals ADD COLUMN scope_subject_id BIGINT AS (IF(metric IS NULL, NULL, COALESCE(subject_id, 0))) VIRTUAL COMMENT ''生成列（条件式）：metric 非空时把 subject_id 的 NULL 折 0，供唯一键用；metric 为空的历史停用行保持 NULL，不参与唯一性''',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 2. goals：加新唯一键（必须先于删旧键：旧键会把同 metric 的多学科行拦住）──
--    注意顺序：先加新键不会失败（新键允许同 metric 多学科），再删旧键才放行多学科。
SET @idx_new := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'goals'
    AND INDEX_NAME = 'uniq_goals_student_scope_metric'
);
SET @ddl := IF(@idx_new = 0,
  'ALTER TABLE goals ADD UNIQUE KEY uniq_goals_student_scope_metric (student_id, scope_subject_id, metric)',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 3. goals：删旧唯一键（它按 (student_id, metric) 约束，会挡住「同 metric 多学科」）──
SET @idx_old := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'goals'
    AND INDEX_NAME = 'uniq_goals_student_metric'
);
SET @ddl := IF(@idx_old > 0,
  'ALTER TABLE goals DROP KEY uniq_goals_student_metric',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 4. lesson_completions：每课完成事件（「每周完课目标」的唯一数据源）──
CREATE TABLE IF NOT EXISTS lesson_completions (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id   BIGINT      NOT NULL,
  subject_id   BIGINT      NOT NULL COMMENT '取自 progress.subject_id（该列 NOT NULL）',
  lesson_id    BIGINT      NOT NULL COMMENT 'lessons.id；**故意不设外键**（内容表会全量重灌）',
  completed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- 一课只记一次：完成不可逆，重复上报/重放都靠它幂等（写入用 INSERT IGNORE）
  UNIQUE KEY uniq_lc_student_lesson (student_id, lesson_id),
  KEY idx_lc_student_subject_time (student_id, subject_id, completed_at),
  CONSTRAINT fk_lc_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 2: 手工 apply**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
mysql -u ai_k12 -pai_k12 ai_k12 < tools/db/migrations/2026-09-20_goals_per_subject_and_lesson_completions.sql
```

Expected: 无输出。若报 `ERROR 1553`（cannot drop index needed in a foreign key constraint）说明新键没加上，先检查 Step 1 的第 2 步是否真的执行了。

> ⚠️ 本机 mysql 9.5 非交互 `-e` 下不认 `\G`，要看建表用 `--vertical`。

- [ ] **Step 3: 验证（5 项断言）**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
mysql -u ai_k12 -pai_k12 ai_k12 -N -e "
SELECT CONCAT('gen_col=', COUNT(*)) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='goals'
    AND COLUMN_NAME='scope_subject_id' AND EXTRA LIKE '%STORED GENERATED%';
SELECT CONCAT('new_key_cols=', COUNT(*)) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='goals'
    AND INDEX_NAME='uniq_goals_student_scope_metric';
SELECT CONCAT('old_key=', COUNT(*)) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='goals'
    AND INDEX_NAME='uniq_goals_student_metric';
SELECT CONCAT('lc_fk=', COUNT(*)) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='lesson_completions' AND CONSTRAINT_TYPE='FOREIGN KEY';
SELECT CONCAT('lc_uniq=', COUNT(*)) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='lesson_completions'
    AND INDEX_NAME='uniq_lc_student_lesson';
" 2>/dev/null
```

Expected: `gen_col=1`、`new_key_cols=3`、`old_key=0`、`lc_fk=1`、`lc_uniq=2`。

- [ ] **Step 4: 验证「同 metric 多学科」真的能共存 + 幂等复跑**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
mysql -u ai_k12 -pai_k12 ai_k12 -t -e "
START TRANSACTION;
INSERT INTO goals (student_id, subject_id, metric, title, period, target_value) VALUES (7, 1, '__t', 't', 'daily', 1);
INSERT INTO goals (student_id, subject_id, metric, title, period, target_value) VALUES (7, 2, '__t', 't', 'daily', 1);
SELECT CONCAT('same_metric_two_subjects=', COUNT(*)) AS r FROM goals WHERE student_id=7 AND metric='__t';
INSERT INTO goals (student_id, subject_id, metric, title, period, target_value) VALUES (7, 1, '__t', 't', 'daily', 9)
  AS new ON DUPLICATE KEY UPDATE target_value = new.target_value;
SELECT CONCAT('upsert_hit=', target_value) AS r FROM goals WHERE student_id=7 AND subject_id=1 AND metric='__t';
ROLLBACK;
" 2>/dev/null
mysql -u ai_k12 -pai_k12 ai_k12 < tools/db/migrations/2026-09-20_goals_per_subject_and_lesson_completions.sql && echo "RE-APPLY OK（幂等）"
```

Expected: `same_metric_two_subjects=2`、`upsert_hit=9`（唯一键命中，不是新增第二行）、`RE-APPLY OK`，且 Step 3 的 5 个数字不变。

- [ ] **Step 5: 同步 `tools/db/schema.sql`**

**(a)** 改 `goals` 段：把 `metric` 列的注释扩到 5 个值；`subject_id` 行加「按学科目标：NOT NULL 语义（历史停用行可能为 NULL）」；在 `subject_id` 之后加生成列；把 `UNIQUE KEY uniq_goals_student_metric (student_id, metric)` 换成 `UNIQUE KEY uniq_goals_student_scope_metric (student_id, scope_subject_id, metric)`。改完该表为：

```sql
CREATE TABLE IF NOT EXISTS goals (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  subject_id BIGINT DEFAULT NULL COMMENT '按学科目标；为 NULL 的历史行是迁移前停用行，读侧被 is_active=1 过滤',
  scope_subject_id BIGINT AS (IF(metric IS NULL, NULL, COALESCE(subject_id, 0))) VIRTUAL COMMENT '生成列（条件式）：metric 非空时把 subject_id 的 NULL 折 0，供唯一键用；metric 为空的历史停用行保持 NULL，不参与唯一性',
  metric VARCHAR(40) DEFAULT NULL COMMENT 'daily_study_minutes|weekly_lessons|daily_words|weekly_passages|weekly_clear_errors',
  title VARCHAR(200) NOT NULL,
  period VARCHAR(10) NOT NULL,
  target_value SMALLINT NOT NULL,
  reminder_enabled TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_goals_student (student_id, is_active),
  UNIQUE KEY uniq_goals_student_scope_metric (student_id, scope_subject_id, metric),
  CONSTRAINT fk_goals_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_goals_subject_id FOREIGN KEY (subject_id) REFERENCES subjects (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**(b)** 在 §17（`special_practice_logs`）之后、`SET FOREIGN_KEY_CHECKS = 1;` 之前，新增 §18 段，把 Step 1 里那条完整的 `CREATE TABLE IF NOT EXISTS lesson_completions (...)` **逐字粘进来**，并加注释块（照 §17 的写法）：

```sql
-- ============================================================
-- 18. 课时完成事件（2026-09-20，P6.5 目标设定补齐）
-- ============================================================
-- 「每周完课目标」的唯一数据源。此前 progress 表只有游标（current_lesson_id，覆盖式更新、
-- 无历史），回答不了「本周完成了几课」。**历史完课补不回来**，达成值从本表上线起算。
-- lesson_id 故意不设外键（lessons 是内容表、会全量重灌）。
-- 迁移：tools/db/migrations/2026-09-20_goals_per_subject_and_lesson_completions.sql

<把 Step 1 的 CREATE TABLE 语句整段粘到这里，一个字符都不要改>
```

- [ ] **Step 6: 验证两处建表语句逐字一致**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
diff <(sed -n '/^CREATE TABLE IF NOT EXISTS lesson_completions/,/^) ENGINE=InnoDB/p' tools/db/migrations/2026-09-20_goals_per_subject_and_lesson_completions.sql) \
     <(sed -n '/^CREATE TABLE IF NOT EXISTS lesson_completions/,/^) ENGINE=InnoDB/p' tools/db/schema.sql) \
  && echo "lesson_completions: IDENTICAL"
diff <(sed -n '/^CREATE TABLE IF NOT EXISTS goals/,/^) ENGINE=InnoDB/p' tools/db/schema.sql | grep -E 'scope_subject_id|uniq_goals_student_scope_metric') \
     <(echo "  scope_subject_id BIGINT AS (IF(metric IS NULL, NULL, COALESCE(subject_id, 0))) VIRTUAL COMMENT '生成列（条件式）：metric 非空时把 subject_id 的 NULL 折 0，供唯一键用；metric 为空的历史停用行保持 NULL，不参与唯一性',
  UNIQUE KEY uniq_goals_student_scope_metric (student_id, scope_subject_id, metric),") \
  && echo "goals: 生成列与新键都在 schema.sql 里"
```

Expected: `IDENTICAL` / 都在。

- [ ] **Step 7: 提交**

```bash
git add tools/db/migrations/2026-09-20_goals_per_subject_and_lesson_completions.sql tools/db/schema.sql
git commit -m "feat(db): goals 改按学科（生成列 + 新唯一键）+ 新建 lesson_completions"
```

---

### Task 2: `LessonCompletionsRepository` + `ProgressService` 写入点

**Files:**
- Create: `apps/server/src/database/repositories/lesson-completions.repo.ts` + `.test.ts`
- Modify: `apps/server/src/database/repositories/index.ts`（barrel）
- Modify: `apps/server/src/modules/progress/progress.service.ts`（学完一课时写一行）
- Modify: `apps/server/src/modules/progress/progress.module.ts`（provide 新仓储）

**Interfaces:**
- Produces（Task 6 依赖）：
  - `class LessonCompletionsRepository`：
    - `recordCompletion(input: { studentId: number; subjectId: number; lessonId: number }): Promise<void>`
    - `countInWindow(studentId: number, subjectId: number, from: Date, toExclusive: Date): Promise<number>`

**两处口径（写进代码注释）**
- 写入用 **`INSERT IGNORE`**：唯一键 `(student_id, lesson_id)` 保证「一课只记一次」。完成不可逆，重复上报/重放都该被吞掉，**不是错误**。
- **best-effort**：写失败只 `warn`，**绝不能**让「学完一课」这个主动作失败（同 `awardLessonPoints` 的处理）。

- [ ] **Step 1: 仓储 + 测试**

`lesson-completions.repo.ts`：

```ts
import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

/**
 * 课时完成事件（P6.5「每周完课目标」的唯一数据源）。
 *
 * ⚠️ **历史完课补不回来**：本表上线前学完的课时没有记录，达成值从上线起算 ——
 * 页面文案要说清「从 2026-09-20 起统计」，否则家长会以为孩子少学了。
 *
 * `lesson_id` 无外键（lessons 是内容表、会全量重灌，设入向外键会卡住重灌）。
 */
@Injectable()
export class LessonCompletionsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /**
   * 记一次完课。**`INSERT IGNORE`**：唯一键 `(student_id, lesson_id)` 让「同一课重复完成」
   * 静默跳过（完成不可逆，重复上报不是错误）。返回自增 id，调用方只用于日志。
   */
  async recordCompletion(input: {
    studentId: number;
    subjectId: number;
    lessonId: number;
  }): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT IGNORE INTO lesson_completions (student_id, subject_id, lesson_id)
       VALUES (?, ?, ?)`,
      [input.studentId, input.subjectId, input.lessonId],
    );
    return result.insertId ?? 0;
  }

  /** 窗口内某学科完成的课时数（半开区间 `< endExclusive`；窗口由应用层算好传参）。 */
  async countInWindow(
    studentId: number,
    subjectId: number,
    from: Date,
    toExclusive: Date,
  ): Promise<number> {
    const [rows] = await this.pool.execute<(RowDataPacket & { n: number | string | null })[]>(
      `SELECT COUNT(*) AS n
       FROM lesson_completions
       WHERE student_id = ? AND subject_id = ?
         AND completed_at >= ? AND completed_at < ?`,
      [studentId, subjectId, from, toExclusive],
    );
    return Number(rows[0]?.n ?? 0);
  }
}
```

`lesson-completions.repo.test.ts`（**按列名配对断言**，照 `goals.repo.test.ts` 的 `zipInsert` 复制一份到本文件——它证明不了落库语义，见 Global Constraints）：

```ts
import { describe, it, expect, vi } from 'vitest';
import { LessonCompletionsRepository } from './lesson-completions.repo.js';

const mockPool = () => ({ execute: vi.fn().mockResolvedValue([[], []]), query: vi.fn().mockResolvedValue([[], []]) });

/** 列清单 ↔ VALUES 逐位配对（复制自 goals.repo.test.ts；位置断言拦不住列错位）。 */
function zipInsert(sql: string, params: unknown[]): Record<string, unknown> {
  const cols = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map((c) => c.trim());
  const valuesRaw = sql.slice(sql.indexOf('VALUES (') + 'VALUES ('.length);
  const tokens = valuesRaw.slice(0, valuesRaw.indexOf(')')).split(',').map((t) => t.trim());
  const out: Record<string, unknown> = {};
  let pi = 0;
  tokens.forEach((tok, i) => {
    const col = cols[i];
    if (col === undefined) return;
    if (tok === '?') out[col] = params[pi++];
    else if (/^NULL$/i.test(tok)) out[col] = null;
    else if (/^\d+$/.test(tok)) out[col] = Number(tok);
    else out[col] = tok.replace(/^'|'$/g, '');
  });
  return out;
}

describe('LessonCompletionsRepository', () => {
  it('recordCompletion：INSERT IGNORE，列与值逐位对应', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([{ insertId: 5 }, []]);
    const repo = new LessonCompletionsRepository(pool as any);

    await repo.recordCompletion({ studentId: 7, subjectId: 1, lessonId: 1113 });

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('INSERT IGNORE INTO lesson_completions');
    expect(zipInsert(sql as string, params as unknown[])).toEqual({
      student_id: 7, subject_id: 1, lesson_id: 1113,
    });
  });

  it('countInWindow：按学科 + 窗口计数，无数据回 0', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([[{ n: '3' }], []]);
    const repo = new LessonCompletionsRepository(pool as any);

    expect(await repo.countInWindow(7, 1, new Date('2026-09-14'), new Date('2026-09-21'))).toBe(3);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('subject_id = ?');
    expect(sql).toContain('completed_at >= ? AND completed_at < ?');
    expect(sql).not.toContain('CURDATE()');
    expect(params).toEqual([7, 1, new Date('2026-09-14'), new Date('2026-09-21')]);

    const empty = mockPool();
    empty.execute.mockResolvedValueOnce([[{ n: null }], []]);
    expect(await new LessonCompletionsRepository(empty as any).countInWindow(7, 1, new Date(), new Date())).toBe(0);
  });
});
```

- [ ] **Step 2: 写入点（`ProgressService`）**

在 `progress.service.ts` 的「学完一课」分支（现约 `:282-300`，`isLastCard` 内、`advanceLesson` / `markCompleted` 之后）插入。**先读该段再改**，变量名以文件为准（`progress` / `lessonId` / `studentId`）：

```ts
    // 完课事件（P6.5）：无论「还有下一课」还是「整科完成」，这一课都算完成。
    // best-effort：写失败只 warn —— 「学完一课」是主动作，不能被辅助记录拖垮。
    try {
      await this.lessonCompletionsRepo.recordCompletion({
        studentId,
        subjectId: progress.subject_id,
        lessonId,
      });
    } catch (err) {
      this.logger.warn(`lesson_completions 写入失败（已忽略）：${err}`);
    }
```

> 构造函数注入 `LessonCompletionsRepository`；`progress.module.ts` 的 `providers` 加它（漏了 Nest 启动直接失败）。
> `subjectId` 用 `progress.subject_id`（该行就是这门学科的游标，NOT NULL）。**不要**用请求里传来的 subjectId——那是「当前选中的学科」，不一定是这一课所属学科。

- [ ] **Step 3: barrel + 跑测试 + 类型检查**

```bash
cd apps/server && npx vitest run src/database/repositories/lesson-completions.repo.test.ts src/modules/progress && npx tsc --noEmit
```

Expected: 全绿；`tsc` 无输出。

- [ ] **Step 4: 提交**

```bash
git add apps/server/src/database/repositories/lesson-completions.repo.ts \
        apps/server/src/database/repositories/lesson-completions.repo.test.ts \
        apps/server/src/database/repositories/index.ts \
        apps/server/src/modules/progress/
git commit -m "feat(progress): 新增 lesson_completions 完课事件（每周完课目标的数据源）"
```

---

### Task 3: 心跳补写 `subject_id`（让「按学科学习时长」有数据）

**Files:**
- Modify: `apps/server/src/database/repositories/study-sessions.repo.ts`（`heartbeat` 加可选 `subjectId`）
- Modify: `apps/server/src/database/repositories/study-sessions.repo.test.ts`（**顺序钉子用例必须同步**）
- Modify: `apps/server/src/modules/analytics/study-sessions.service.ts`、`analytics.controller.ts`、`dto/*`（透传）
- Modify: `apps/web/src/analytics/tracker.ts`（心跳带上 `subjectId`）

**Interfaces:**
- `StudySessionsRepository.heartbeat(sessionUid: string, studentId: number, state: 'visible'|'hidden', subjectId: number | null): Promise<number | null>`
- `POST/PATCH /api/study-sessions/:uid/heartbeat` 的 body 变 `{ state, subjectId? }`

**三条口径（写进注释）**
1. **只补不覆盖**：`subject_id = COALESCE(subject_id, ?)` —— 会话开头没带学科时补上；已经带了就**不动**（同一个会话中途换学科不该改写已完成时段的归属）。
2. **`subjectId` 可选、非法值不 500**：非正整数 → 按 `null` 处理（等同于「没带」）。心跳是尽力而为，报错只会污染前端日志。
3. **⚠️ SET 顺序**：`IF(client_state = 'visible', ...)` **必须仍排在 `client_state = ?` 之前**（那是 1A 的时长口径钉子，见该方法注释）。`subject_id = COALESCE(subject_id, ?)` 与 `IF` 无交互，放在 `client_state` 之后、`heartbeat_count` 之前即可；**但改完必须跑顺序钉子用例**。

- [ ] **Step 1: 改仓储（含顺序钉子）**

`study-sessions.repo.ts` 的 `heartbeat`：

```ts
  async heartbeat(
    sessionUid: string,
    studentId: number,
    state: 'visible' | 'hidden',
    subjectId: number | null,
  ): Promise<number | null> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE study_sessions
       SET active_seconds = active_seconds
             + IF(client_state = 'visible',
                  GREATEST(0, LEAST(TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW(3)), 45)),
                  0),
           client_state = ?,
           -- 只补不覆盖：会话开头没带学科时补上；已带的保持原样。
           -- 放在 client_state 之后是为了不干扰上面那条 IF（它要读「本次上报前」的状态）。
           subject_id = COALESCE(subject_id, ?),
           heartbeat_count = heartbeat_count + 1,
           last_heartbeat_at = NOW(3)
       WHERE session_uid = ? AND student_id = ? AND status = 'active'`,
      [state, subjectId, sessionUid, studentId],
    );
    // …以下不变（affectedRows 判定 + 回读 active_seconds）
  }
```

**测试必须补两条**：
- 既有顺序钉子用例：断言 params 顺序改为 `['visible', null, uid, studentId]`（**参数位置变了，这条不改会红**——这是好事，说明钉子有效）。
- 新用例：「已带学科的会话，后续心跳传别的学科**不改写**」——用 `zipInsert` 式思路断言 SQL 里是 `COALESCE(subject_id, ?)` 而**不是** `subject_id = ?`（后者会覆盖）。真语义由 Task 9 的真库冒烟验证。

- [ ] **Step 2: service / controller / DTO**

- `study-sessions.service.ts` 的 `heartbeat(input)`：入参加 `subjectId?: number`，转成 `const subjectId = Number.isInteger(input.subjectId) && (input.subjectId as number) > 0 ? (input.subjectId as number) : null;` 再传给仓储。
- `analytics.controller.ts` 的心跳端点：从 body 取 `subjectId`（**不做 Zod 强校验**——非法按没带给，见口径 2），加进 service 入参。
- 若心跳 DTO 里有 Zod schema，则加 `subjectId: z.number().int().positive().optional()`；**但 controller 仍要容忍它缺失**。

- [ ] **Step 3: 前端 tracker 带上 `subjectId`**

`apps/web/src/analytics/tracker.ts` 的心跳处（现约 `:160-168` 一带，读文件确认）：把当时可得的 `subjectIdProvider()` 结果放进心跳 body（**有才带**，同 start 的写法）：

```ts
    const subjectId = subjectIdProvider();
    // 会话开头可能还没有学科（星图未加载完）→ 心跳时补写，否则这段时长永远归不了科
    body: JSON.stringify({ state, ...(subjectId !== null ? { subjectId } : {}) }),
```

- [ ] **Step 4: 跑测试 + 类型检查（两端）**

```bash
cd apps/server && npx vitest run src/database/repositories/study-sessions.repo.test.ts src/modules/analytics && npx tsc --noEmit
cd apps/web && npx vitest run src/analytics && npx tsc -b
```

Expected: 全绿；`tsc` 无输出。**若顺序钉子用例变红**：说明 SET 顺序被改动了，回去对齐注释里的要求。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/database/repositories/study-sessions.repo.ts \
        apps/server/src/database/repositories/study-sessions.repo.test.ts \
        apps/server/src/modules/analytics/ apps/web/src/analytics/tracker.ts
git commit -m "fix(analytics): 心跳补写 subject_id（按学科学习时长此前恒为 NULL）"
```

---

### Task 4: 两个查询补齐 —— 单学科时长 + 在学学科清单

**Files:**
- Modify: `apps/server/src/database/repositories/parent-analytics.repo.ts`（加 `getStudyTimeBySubjectOne`）+ 测试
- Modify: `apps/server/src/database/repositories/progress.repo.ts`（加 `findSubjectIdsByStudent`）+ 测试

**Interfaces:**
- `ParentAnalyticsRepository.getStudyTimeBySubjectOne(studentId, subjectId, from, toExclusive): Promise<number>`（秒）
- `ProgressRepository.findSubjectIdsByStudent(studentId): Promise<number[]>`

**口径**
- 时长沿用 `getStudyTimeBySubject` 的同一套过滤（`subject_id = ?` + `EFFECTIVE_SESSION`），**新增单学科标量版**（把那个方法的 SQL 抄过来加 `AND subject_id = ?`，别改原方法——它给 `bySubject` 用）。
- `findSubjectIdsByStudent` 取 `progress` 表的 `DISTINCT subject_id`，**按 `subject_id` 升序**（稳定顺序，页面分组依赖它）。

- [ ] **Step 1: 写两个方法 + 各自的仓储测试**

测试照本仓既有仓储存根式（假 pool + 断言 SQL 关键片段 + `Number()` 化 + **无 `CURDATE()`**）。

- [ ] **Step 2: 跑测试 + 类型检查**

```bash
cd apps/server && npx vitest run src/database/repositories/parent-analytics.repo.test.ts src/database/repositories/progress.repo.test.ts 2>/dev/null || npx vitest run src/database/repositories && npx tsc --noEmit
```

> `progress.repo.ts` 可能**没有**测试文件；没有就新建 `progress.repo.test.ts`（只覆盖本方法）。

- [ ] **Step 3: 提交**

```bash
git add apps/server/src/database/repositories/parent-analytics.repo.ts \
        apps/server/src/database/repositories/parent-analytics.repo.test.ts \
        apps/server/src/database/repositories/progress.repo.ts \
        apps/server/src/database/repositories/progress.repo.test.ts
git commit -m "feat(db): 单学科窗口时长 + 在学学科清单两个查询"
```

---

### Task 5: `goals.repo` 改按学科（含 `weekly_lessons`）

**Files:**
- Modify: `apps/server/src/database/repositories/goals.repo.ts`
- Modify: `apps/server/src/database/repositories/goals.repo.test.ts`

**Interfaces:**
- `type GoalMetric = 'daily_study_minutes' | 'weekly_lessons' | 'daily_words' | 'weekly_passages' | 'weekly_clear_errors'`（**加 `weekly_lessons`**）
- `GoalRow` 加 `subjectId: number | null`
- `findActiveByStudent(studentId): Promise<GoalRow[]>`（**返回加 `subjectId`**）
- `ensureDefaults(studentId, defaults: ReadonlyArray<{ metric: GoalMetric; subjectId: number; period: GoalPeriod; title: string; target: number }>): Promise<void>`
- `upsertTarget(studentId, subjectId: number, metric, period, title, target): Promise<void>`

**⚠️ 本任务的最高风险点：占位符顺序**
列清单是 `(student_id, subject_id, metric, title, period, target_value, reminder_enabled, is_active)` —— **`subject_id` 紧跟 `student_id`**，`title` 在 `period` 之前。1B 就在这里把 `title`/`period` 写反过（`goals.repo.ts:57-61` 已有警告注释）。**每条 SQL 写完都要用 `zipInsert` 断言到列名**。

- [ ] **Step 1: 改三处 SQL**

- `findActiveByStudent`：`SELECT id, subject_id, metric, period, target_value, title FROM goals WHERE student_id = ? AND is_active = 1 ORDER BY subject_id, id`（`subject_id` 升序，与 Task 4 的学科顺序一致）；映射 result 加 `subjectId: r.subject_id === null ? null : Number(r.subject_id)`。
- `ensureDefaults`：占位符改为 `(?, ?, ?, ?, ?, ?, 0, 1)` + 参数 `[studentId, d.subjectId, d.metric, d.title, d.period, d.target]`；仍用 **`INSERT IGNORE`**（不覆盖家长已改的值）。唯一键已换成 `(student_id, scope_subject_id, metric)`，`INSERT IGNORE` 照旧生效。
- `upsertTarget`：同样 6 个占位符 + `ON DUPLICATE KEY UPDATE target_value = new.target_value, period = new.period, title = new.title, subject_id = new.subject_id, is_active = 1`（**`subject_id` 也写回**，让「从 A 学科挪到 B 学科」这种调用也一致；正常调用不会挪）。`reminder_enabled` 仍写 0（裁决 1：提醒本期不做）。

- [ ] **Step 2: 更新测试（既有断言必改 + 新增）**

- 既有 `zipInsert` 断言：期望对象加 `subject_id`。
- 新增：「同一 metric 不同学科各一行，互不覆盖」——两次 `upsertTarget(7, 1, 'daily_study_minutes', ...)` / `(7, 2, ...)` 参数里 `subject_id` 分别是 1 / 2（唯一键维度正确）。
- 新增：「`weekly_lessons` 是合法 metric」（类型层面已保证，测试里断言它进 SQL 不报错、注释与枚举一致）。

- [ ] **Step 3: 跑测试 + 类型检查**

```bash
cd apps/server && npx vitest run src/database/repositories/goals.repo.test.ts && npx tsc --noEmit
```

Expected: 全绿；`tsc` 无输出（注意：`GoalsService` 会因 `GoalMetric` 多了一个值而**报穷尽检查错误**，那是任务 6 要修的——本步可以先只跑 goals.repo 测试，`tsc` 留给 Task 6 结束时统一清）。

- [ ] **Step 4: 提交**

```bash
git add apps/server/src/database/repositories/goals.repo.ts apps/server/src/database/repositories/goals.repo.test.ts
git commit -m "feat(goals): 仓储改按学科（(学科, 指标) 二元组 + weekly_lessons）"
```

---

### Task 6: `GoalsService` 改「(学科, 指标)」模型

**Files:**
- Modify: `apps/server/src/modules/parent-insights/goals.service.ts`
- Modify: `apps/server/src/modules/parent-insights/goals.service.test.ts`
- Modify: `apps/server/src/modules/parent-insights/dto/parent-insights.dto.ts`（`GoalAttainmentItem` 加 `subjectId`/`subjectName`）

**Interfaces:**
- Consumes: `GoalsRepository`（Task 5）、`LessonCompletionsRepository`（Task 2）、`ParentAnalyticsRepository.getStudyTimeBySubjectOne`（Task 4）、`ProgressRepository.findSubjectIdsByStudent`（Task 4）、`SpecialPracticeLogsRepository`（1B）、`MainErrorBooksRepository.countClearedBetween`（1B，**需加 subjectId 参数** → 见 Step 2）、`SubjectsRepository`（已在本模块 providers 里）
- Produces:
  - `getAttainment(studentId): Promise<GoalAttainmentSummary>`（items 带学科）
  - `upsertTarget(studentId, subjectId, metric, target): Promise<GoalAttainmentItem>`
  - `GOAL_TEMPLATES`（学科 × 指标 × 默认值，**唯一真源**）

- [ ] **Step 1: 重写常量与模板**

```ts
/** MVP 学科白名单（PRD 的 MVP 只有数学/语文/英语；subjects 表里有 9 个，别全建）。 */
const MVP_SUBJECT_CODES = ['math', 'chinese', 'english'] as const;

/**
 * 语文/英语**固定兜底**进「在学学科」：`weekly_passages` / `daily_words` 属训练轨专项
 * （古诗文、背单词），不依赖家长配教材，得有位置可设。
 */
const FALLBACK_SUBJECT_CODES = ['chinese', 'english'] as const;

/**
 * 指标模板：**唯一真源**。`defaultTarget` 是懒初始化的默认值（家长可改）。
 * `subjects: null` = 每个在学学科都建；否则只在这些学科建。
 */
export const GOAL_TEMPLATES: ReadonlyArray<{
  metric: GoalMetric;
  period: GoalPeriod;
  title: string;
  defaultTarget: number;
  subjects: readonly string[] | null;
}> = [
  { metric: 'daily_study_minutes', period: 'daily',  title: '每日学习时长', defaultTarget: 30, subjects: null },
  { metric: 'weekly_lessons',      period: 'weekly', title: '每周完课',     defaultTarget: 2,  subjects: null },
  { metric: 'weekly_clear_errors', period: 'weekly', title: '每周清零错题', defaultTarget: 5,  subjects: null },
  { metric: 'weekly_passages',     period: 'weekly', title: '每周古诗文篇目', defaultTarget: 8, subjects: ['chinese'] },
  { metric: 'daily_words',         period: 'daily',  title: '每日背单词',   defaultTarget: 20, subjects: ['english'] },
];

const TITLE_BY_METRIC = ...   // 由 GOAL_TEMPLATES 派生
const PERIOD_BY_METRIC = ...  // 同上
/** metric → 适用学科 code 集合（null = 全部）。供 controller 校验「该 metric 是否适用于该学科」。 */
export const SUBJECTS_BY_METRIC = ...  // 同上
```

- [ ] **Step 2: 加 `subjectId` 到「每周清零错题」的计数**

`MainErrorBooksRepository.countClearedBetween` 加第 2 个参数 `subjectId: number`（SQL 加 `AND subject_id = ?`），并同步它的测试（1B 写的两条断言要改参数数组）。`main_error_books.subject_id` 是 `NOT NULL`，天然可按学科。

- [ ] **Step 3: 达成值分派（按学科）**

```ts
  private async achievedOf(studentId: number, subjectId: number, metric: GoalMetric): Promise<number> {
    const { start, endExclusive } = this.windowOf(PERIOD_BY_METRIC[metric]);
    switch (metric) {
      case 'daily_study_minutes': {
        const seconds = await this.analyticsRepo.getStudyTimeBySubjectOne(studentId, subjectId, start, endExclusive);
        return Math.floor(seconds / 60);           // 向下取整：不虚报达成
      }
      case 'weekly_lessons':
        return this.lessonRepo.countInWindow(studentId, subjectId, start, endExclusive);
      case 'weekly_clear_errors':
        return this.mainErrorRepo.countClearedBetween(studentId, subjectId, start, endExclusive);
      case 'daily_words': {
        // 专项表 subject_id 恒 NULL，按 module 筛；该 metric 只可能挂在英语学科（模板已限）
        const rows = await this.logsRepo.aggregateByModule(studentId, start, endExclusive);
        return rows.find((r) => r.module === 'en_vocabulary')?.units ?? 0;
      }
      case 'weekly_passages':
        return this.logsRepo.countDistinctPassages(studentId, start, endExclusive);
    }
  }
```

- [ ] **Step 4: `getAttainment` / `upsertTarget`**

```ts
  async getAttainment(studentId: number): Promise<GoalAttainmentSummary> {
    const subjects = await this.resolveLearningSubjects(studentId);   // 见 Step 5
    if (subjects.length === 0) return { items: [] };                  // 不编造默认目标
    await this.goalsRepo.ensureDefaults(studentId, this.buildDefaults(subjects));
    const rows = await this.goalsRepo.findActiveByStudent(studentId);
    const nameOf = new Map(subjects.map((s) => [s.id, s.name]));
    const items = await Promise.all(
      rows
        .filter((r): r is typeof r & { metric: GoalMetric; subjectId: number } =>
          r.metric !== null && r.subjectId !== null && nameOf.has(r.subjectId))
        .map(async (r): Promise<GoalAttainmentItem> => {
          const achieved = await this.achievedOf(studentId, r.subjectId, r.metric);
          return {
            metric: r.metric, subjectId: r.subjectId, subjectName: nameOf.get(r.subjectId) ?? '',
            period: PERIOD_BY_METRIC[r.metric], title: r.title, target: r.targetValue,
            achieved, rate: toRate(r.targetValue, achieved),
          };
        }),
    );
    // 稳定排序：学科按 subjects 顺序（sort_order）→ 指标按 GOAL_TEMPLATES 顺序
    const subjOrder = new Map(subjects.map((s, i) => [s.id, i]));
    const metricOrder = new Map(GOAL_TEMPLATES.map((t, i) => [t.metric, i]));
    items.sort((a, b) =>
      (subjOrder.get(a.subjectId)! - subjOrder.get(b.subjectId)!) ||
      (metricOrder.get(a.metric)! - metricOrder.get(b.metric)!));
    return { items };
  }

  async upsertTarget(studentId, subjectId, metric, target): Promise<GoalAttainmentItem> {
    const period = PERIOD_BY_METRIC[metric];
    await this.goalsRepo.upsertTarget(studentId, subjectId, metric, period, TITLE_BY_METRIC[metric], target);
    const achieved = await this.achievedOf(studentId, subjectId, metric);
    return { metric, subjectId, subjectName: /* 查 subjects */, period,
             title: TITLE_BY_METRIC[metric], target, achieved, rate: toRate(target, achieved) };
  }
```

- [ ] **Step 5: `resolveLearningSubjects` / `buildDefaults`**

```ts
  /**
   * 「在学学科」= progress 行（家长配教材即产生）∪ 固定兜底 {语文,英语}，
   * 再与 MVP 白名单求交，按 subjects.sort_order 排序。
   * 返回空数组 = 这个孩子还没配任何教材 → 调用方**不建默认目标**、页面提示去配置。
   */
  private async resolveLearningSubjects(studentId: number) { /* progressRepo + subjectsRepo */ }

  /**
   * 默认目标 = 对每个在学学科，套用所有 `subjects === null` 的模板 + 该学科专属模板。
   * 数学 3 + 语文 4 + 英语 4 = 11 行（分组展示后可接受）。
   */
  private buildDefaults(subjects: Array<{ id: number; code: string }>) { /* 见上表 */ }
```

- [ ] **Step 6: 重写 service 测试**

必测（每条都对应一个真实翻车点）：
1. 在学学科 = `progress` 行 ∪ {语文,英语} ∩ 白名单 —— 学生只配了数学时，仍会建语文/英语的专项目标（背单词/古诗文得有位置）。
2. **没有在学学科 → 不建默认目标**（`ensureDefaults` 不被调用、`items: []`）。
3. 每个指标走自己的数据源（表驱动：5 个 metric 各断言一次取到哪个 repo 方法）。
4. **`weekly_lessons` 用 `lessonRepo.countInWindow(studentId, subjectId, …)`**（不是别的）。
5. `weekly_clear_errors` / `daily_study_minutes` **带 subjectId** 传参（按学科的关键）。
6. 同一 metric 两个学科 → 两条 items，各自算各自的达成值。
7. 排序：学科按 sort_order、指标按模板顺序（构造乱序输入断言输出顺序）。
8. `rate` 复用 `toRate(target, achieved)`：达标 100 / 超额 >100 / target=0 → null。
9. 窗口：daily = 今天、weekly = 近 7 天（半开区间、绝不用 `CURDATE()`）。

- [ ] **Step 7: 跑测试 + 类型检查**

```bash
cd apps/server && npx vitest run src/modules/parent-insights/goals.service.test.ts src/database/repositories && npx tsc --noEmit
```

> `tsc` 这时应已全清（Task 5 的穷尽检查错误在本任务补齐 case 后消失）。若还报 `never` 相关错误，说明 `GOAL_TEMPLATES` 与 switch 不同步。

- [ ] **Step 8: 提交**

```bash
git add apps/server/src/modules/parent-insights/goals.service.ts \
        apps/server/src/modules/parent-insights/goals.service.test.ts \
        apps/server/src/modules/parent-insights/dto/parent-insights.dto.ts \
        apps/server/src/database/repositories/main-error-books.repo.ts \
        apps/server/src/database/repositories/main-error-books.repo.test.ts
git commit -m "feat(parent): 目标模型改 (学科, 指标) —— 模板/默认值/达成值分派"
```

---

### Task 7: 端点契约扩展 + 模块接线

**Files:**
- Modify: `apps/server/src/modules/parent-insights/parent-insights.controller.ts`
- Modify: `apps/server/src/modules/parent-insights/parent-insights.module.ts`
- Modify: `apps/server/src/modules/parent-insights/parent-insights.controller.test.ts`

**契约（与两份 API 文档必须一致）**
- `GET /students/:studentId/goals/attainment` → `{ items: [{ metric, subjectId, subjectName, period, title, target, achieved, rate }] }`
- `PUT /students/:studentId/goals/:metric` → body `{ target, subjectId }`

**校验链路（顺序不能换，每步都给错误码）**
1. `await this.parentService.requireOwnedStudent(user.sub, studentId)` → 403/1005、404/1002
2. `metric` 在白名单内 → 否 400/1001
3. body Zod：`{ target: int 1..9999, subjectId: int positive }` → 否 400/1001
4. **该 metric 适用于该 subject**（`SUBJECTS_BY_METRIC[metric]` 为 null 或包含该学科 code）→ 否 400/1001，**文案要指名原因**（如「`daily_words` 只适用于英语」）
5. `subjectId` 必须是**该生的在学学科**（避免给没在学的学科写目标；本期不做「随意加学科」）→ 否 400/1001
6. 调 `goalsService.upsertTarget(...)`

> 第 5 步需要「在学学科」集合：让 `GoalsService` 暴露一个 `isLearningSubject(studentId, subjectId): Promise<boolean>`（内部复用 Task 6 的 `resolveLearningSubjects`），controller 调用它校验——**别在 controller 里重写一遍学科解析逻辑**。

- [ ] **Step 1: 改 controller**

```ts
/** 目标维度白名单（与 `goals.metric` 的列注释逐字一致）。 */
const GOAL_METRICS: readonly GoalMetric[] =
  ['daily_study_minutes', 'weekly_lessons', 'daily_words', 'weekly_passages', 'weekly_clear_errors'];

/**
 * `PUT .../goals/:metric` 的 body。`subjectId` **必填**：本批起所有目标都按学科
 * （不存在全局目标），路径里不再塞 subject，避免同深度模板路径撞车。
 */
const UpsertGoalSchema = z.object({
  target: z.number().int().min(1).max(9999),
  subjectId: z.number().int().positive(),
});
```

`putGoalTarget` 的 handler 按上面的校验链路重排（4、5 两步新增），并把 `goalsService.upsertTarget(studentId, subjectId, metric, target)` 的调用补上学科。

- [ ] **Step 2: 模块接线**

`parent-insights.module.ts` 的 providers 追加 `LessonCompletionsRepository`（`ParentAnalyticsRepository` / `StudentsRepository` / `SubjectsRepository` 已在）。

- [ ] **Step 3: 控制器测试**

必测：
1. `getGoalAttainment`：归属校验先于取数（既有风格不变）。
2. `PUT`：**缺 subjectId → 400**（这是新必填项，最容易漏）。
3. `daily_words` + 数学学科 → **400 且不写库**（metric/学科不匹配）。
4. `weekly_lessons` + 数学 → 放行（合法组合）。
5. `subjectId` 不是该生在学学科 → 400 且不写库。
6. `target` 0 / 10000 / 小数 → 400 且不写库。
7. 合法 → `upsertTarget(studentId, subjectId, metric, target)` 参数正确。
8. 归属校验失败 → 不写库（403 不泄漏存在性）。

- [ ] **Step 4: 跑测试 + 类型检查 + 启动冒烟**

```bash
cd apps/server && npx vitest run src/modules/parent-insights && npx tsc --noEmit && npm run build
PORT=3119 node dist/main.js > /tmp/boot_goals.log 2>&1 & echo $! > /tmp/boot_goals.pid
sleep 6 && grep -E "successfully started|can't resolve" /tmp/boot_goals.log
grep -E "Mapped \{/api/parent/students/:studentId/goals" /tmp/boot_goals.log
kill $(cat /tmp/boot_goals.pid) && rm -f /tmp/boot_goals.pid /tmp/boot_goals.log
```

Expected: 启动成功、两条 goals 路由 mapped、无 `can't resolve`。
⚠️ **按 PID 收尾**（用户本机有自己的 `node dist/main.js` 在跑，**绝不能** `pkill`）。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/modules/parent-insights/
git commit -m "feat(parent): goals 端点按学科（PUT 必填 subjectId + metric/学科匹配校验）"
```

---

### Task 8: 前端 —— api 层 + 目标页按学科分组

**Files:**
- Modify: `apps/web/src/services/api.ts`
- Modify: `apps/web/src/pages/parent/ParentGoalsPage.tsx`
- Modify: `apps/web/src/pages/parent/ParentGoalsPage.test.tsx`

**为什么行 key 必须改**：页面现在用 `item.metric` 当 React key / 草稿键 / 保存态键。同 metric 会在多个学科各有一行 → **key 冲突**（React 复用一个节点、草稿串行）。统一改成 `${subjectId}:${metric}`。

**同时修掉 1B 的输入框缺陷**：数字输入改用基座 `Input`（`border-2` + 聚焦变蓝 + 48px 高），让「能改」一眼可见。

- [ ] **Step 1: api 层**

```ts
export type ParentGoalMetric =
  | 'daily_study_minutes' | 'weekly_lessons' | 'daily_words'
  | 'weekly_passages' | 'weekly_clear_errors';

export interface ParentGoalAttainmentItem {
  metric: ParentGoalMetric;
  /** 学科（本批起所有目标都按学科）。 */
  subjectId: number;
  subjectName: string;
  period: 'daily' | 'weekly';
  title: string;
  target: number;
  achieved: number;
  rate: number | null;
}

export function putParentGoalTarget(
  studentId: number,
  metric: ParentGoalMetric,
  target: number,
  subjectId: number,
): Promise<ParentGoalAttainmentItem> {
  return fetchApi<ParentGoalAttainmentItem>(
    `/parent/students/${studentId}/goals/${metric}`,
    { method: 'PUT', body: JSON.stringify({ target, subjectId }) },
  );
}
```

- [ ] **Step 2: 页面按学科分组**

- 数据按 `subjectId` 分组（用 `subjectName` 做组标题），组内按后端给的顺序渲染 —— **前端不重排**。
- 行 key / 草稿 / 保存态键一律 `rowKey(item) = `${item.subjectId}:${item.metric}``。
- 空 `items` → 「这个孩子还没有在学学科，先去『学生账号 → 配置教材』」（**这是真实空态**：没配教材就没默认目标）。
- 保存调用带 `item.subjectId`；响应**原地替换该行**（`rowKey` 比对，不再用 metric 比）。
- 输入框换基座 `Input`（`type="number" min=1 max=9999`，`aria-label={`${item.title}目标值`}`），与「保存」按钮同组。
- `weekly_lessons` 的单位是「课」，`daily_study_minutes` 是「分钟」——行内文案带上单位（`已达成 1 / 2 课`），别让家长猜。

- [ ] **Step 3: 重写页面测试**

必测（在 1B 的 9 条基础上改）：
1. **按学科分组**：语文组里同时有「每周古诗文篇目」和「每周完课」，两组标题都在。
2. **同 metric 两学科不串**：造两行 `daily_study_minutes`（数学/语文），改数学那行 → `putParentGoalTarget` 收到的是数学的 `subjectId`，且**只有那一行**的显示变化。
3. `rate === null` → 「暂无数据」且该行不出现 `0%`（沿用 1B 的「限定在行内断言」写法，别对整卡断言——`80%` 含子串 `0%`）。
4. `rate === 150` → 「已超额」。
5. 保存失败 → 行内报错、**保留用户输入**、按钮恢复。（键改为 `subjectId:metric` 后要确认行级错误也只落该行。）
6. 非法 target（0 / 10000）→ 不发请求。
7. 无在学学科（`items: []`）→ 显示「先去配置教材」引导。
8. 切孩子反闪（沿用 1B 的挂起 promise 写法）。
9. **输入框可辨识**：断言数字输入用的是基座 `Input` 的类（`border-2` + `focus-within:border-[var(--brand-500)]`）——这是直接把 1B 那个走查缺陷钉住。

- [ ] **Step 4: 跑测试 + 类型检查 + lint + build**

```bash
cd apps/web && npx vitest run src/pages/parent src/routes/routeTable.test.tsx && npx tsc -b && npm run lint && npm run build
```

> `routeTable.test.tsx` 的 goals 钉子会因响应形状变化而红：它的 mock 里 `getParentGoalAttainment` 得补 `subjectId`/`subjectName`，否则页面渲染不出行 —— **同步改它**（不是放宽断言）。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/services/api.ts apps/web/src/pages/parent/ParentGoalsPage.tsx \
        apps/web/src/pages/parent/ParentGoalsPage.test.tsx apps/web/src/routes/routeTable.test.tsx
git commit -m "feat(parent): 目标页按学科分组（行 key 改 subjectId:metric + 输入框换基座 Input）"
```

---

### Task 9: 文档同步（含「提醒本期不做」的批注）

**Files:**
- Modify: `docs/API接口与数据流设计文档.md`（§4.13 两行改契约、§4.24 口径改写、§6.27 补完课/时长链路、§10 加 v4.4）
- Modify: `docs/api/openapi.yaml`（两个端点 request/response + `metric` enum 加 `weekly_lessons` + `subjectId`）
- Modify: `docs/K12智学系统-数据库设计文档.md`（`goals` 段改生成列与新键、指标表；新增 `lesson_completions`；§4 枚举；§8 加 v2.6）
- Modify: `docs/K12智学系统-产品需求文档.md`（第 200 行「接收提醒」加**本期不做**批注）
- Modify: `docs/UX-UI设计文档.md`（§P6.5 同批注）
- Modify: `docs/ai-core-changelog.md`（追加本批条目）
- Modify: `CLAUDE.md`（家长端学情节补「目标 = (学科, 指标)」+ 生成列约定）

**批注写法（PRD/UX：不删需求原文）**

```markdown
> **本期不做（2026-09-20 用户裁决）**：目标的「提醒」本期不实现 —— 本仓**零调度基础设施**
> （无 cron / `@nestjs/schedule` / 短信通道），做到期自动提醒需要新建调度 + 去重幂等，
> 属独立一批。`goals.reminder_enabled` 列保留但恒 0。**短信**单独立项。
```

**其余要点**
- 数据库文档要写清：为什么用生成列（NULL 唯一性陷阱 + 哨兵值撞外键）、`lesson_completions` **补不回历史**（达成值从 2026-09-20 起算）、`lesson_id` 无外键的原因。
- changelog 要点：三条用户裁决；**复盘「1B 按 spec 的四个全局目标偏离了 PRD/UX 的按学科」**（我应当先发现的）；`subject_id` 全 NULL 的采集缺口与修法；心跳 SET 顺序这条 1A 就写过的教训我在 1B 又踩了一次。
- API 文档 §4.24 要更新那句「四个全局 metric」的表述为「(学科, 指标)」，并说明「无在学学科 → items 为空，不编造默认目标」。

- [ ] **Step 1: 逐处改，然后用脚本核对两份 API 文档的路径/字段**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
grep -n "weekly_lessons" docs/api/openapi.yaml docs/API接口与数据流设计文档.md | head
cd apps/server && node -e "
const yaml=require('js-yaml'),fs=require('fs');
const d=yaml.load(fs.readFileSync('../../docs/api/openapi.yaml','utf8'));
const p=d.paths['/parent/students/{studentId}/goals/{metric}'];
console.log('PUT subjectId 必填:', JSON.stringify(p.put.requestBody.content['application/json'].schema.required));
console.log('enum:', JSON.stringify(p.put.parameters.find(x=>x.name==='metric').schema.enum));
console.log('item 有 subjectId:', !!d.components.schemas.ParentGoalAttainmentItem.properties.subjectId);
"
```

Expected: `PUT subjectId 必填: ["target","subjectId"]`、enum 含 `weekly_lessons`、`item 有 subjectId: true`。

- [ ] **Step 2: 提交**

```bash
git add docs/API接口与数据流设计文档.md docs/api/openapi.yaml \
        "docs/K12智学系统-数据库设计文档.md" "docs/K12智学系统-产品需求文档.md" \
        "docs/UX-UI设计文档.md" docs/ai-core-changelog.md CLAUDE.md
git commit -m "docs: 同步 P6.5 按学科目标（含提醒本期不做的批注与复盘）"
```

---

### Task 10: 集成验收（真库冒烟 + 门禁）

**Files:** 无（只跑验证）

- [ ] **Step 1: 真库验证三条新链路（事务 + ROLLBACK，不留脏数据）**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
mysql -u ai_k12 -pai_k12 ai_k12 -t -e "
START TRANSACTION;
-- ① 心跳补写：先建一个 subject_id 为 NULL 的会话，再模拟心跳补写
INSERT INTO study_sessions (student_id, session_uid, module, scene, status)
VALUES (7, '00000000-0000-4000-8000-000000000001', 'mainline', 'course_detail', 'active');
UPDATE study_sessions SET subject_id = COALESCE(subject_id, 1)
  WHERE session_uid = '00000000-0000-4000-8000-000000000001';
UPDATE study_sessions SET subject_id = COALESCE(subject_id, 2)
  WHERE session_uid = '00000000-0000-4000-8000-000000000001';
SELECT CONCAT('补齐后应为 1（后一次不覆盖）: subject_id=', subject_id) AS r
  FROM study_sessions WHERE session_uid = '00000000-0000-4000-8000-000000000001';
-- ② 完课表幂等：同课插两次只留一行
INSERT IGNORE INTO lesson_completions (student_id, subject_id, lesson_id) VALUES (7, 1, 999001);
INSERT IGNORE INTO lesson_completions (student_id, subject_id, lesson_id) VALUES (7, 1, 999001);
SELECT CONCAT('完课去重后行数应为 1: ', COUNT(*)) AS r
  FROM lesson_completions WHERE student_id=7 AND lesson_id=999001;
-- ③ 同 metric 两学科各一行、upsert 命中不新增
INSERT INTO goals (student_id, subject_id, metric, title, period, target_value) VALUES (7, 1, '__t', 't', 'daily', 5);
INSERT INTO goals (student_id, subject_id, metric, title, period, target_value) VALUES (7, 2, '__t', 't', 'daily', 5);
INSERT INTO goals (student_id, subject_id, metric, title, period, target_value) VALUES (7, 1, '__t', 't', 'daily', 7)
  AS new ON DUPLICATE KEY UPDATE target_value = new.target_value;
SELECT CONCAT('两学科两行 + 数学校正为 7: ', SUM(target_value), '/', COUNT(*)) AS r
  FROM goals WHERE student_id=7 AND metric='__t';
ROLLBACK;
" 2>/dev/null
```

Expected: `subject_id=1`（**不被第二次覆盖**）、完课 `1`、目标 `SUM=12/2 行`（5+7 / 两行）。

- [ ] **Step 2: 端到端冒烟（家长端点，真 dev 库）**

用 1B 用过的方式自签家长 token（`JWT_SECRET` 签 `{sub, role:'parent'}`，家长 1 名下有 student 1/2/4），在独立端口跑：

```bash
cd apps/server && PORT=3120 node dist/main.js > /tmp/smoke_goals.log 2>&1 & echo $! > /tmp/smoke_goals.pid
sleep 6
node -e "const jwt=require('jsonwebtoken');require('dotenv').config();require('fs').writeFileSync('/tmp/p.jwt',jwt.sign({sub:1,role:'parent'},process.env.JWT_SECRET||'k12-dev-secret',{expiresIn:'1h'}))"
T=$(cat /tmp/p.jwt)
curl -s -H "Authorization: Bearer $T" localhost:3120/api/parent/students/7/goals/attainment | head -c 800; echo
curl -s -X PUT -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"target":9,"subjectId":3}' localhost:3120/api/parent/students/7/goals/daily_words; echo
curl -s -X PUT -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"target":9,"subjectId":1}' localhost:3120/api/parent/students/7/goals/daily_words; echo   # 应 400：只适用英语
kill $(cat /tmp/smoke_goals.pid); rm -f /tmp/smoke_goals.pid /tmp/p.jwt /tmp/smoke_goals.log
```

Expected: `attainment` 返回按学科分组的 items（student 7 只配了数学 → 数学 3 项 + 语文/英语兜底共 11 项）；第一个 PUT 成功、第二个 **400 且提示只适用英语**。
⚠️ **这个 PUT 会真写库**（student 7 的英语目标被改成 9）——跑完要么改回 20，要么在报告里说明。**按 PID 收尾**。

- [ ] **Step 3: 门禁 + 人工走查清单**

```bash
cd apps/server && npm test 2>&1 | tail -3 && npx tsc --noEmit && npm run build
cd apps/web && npm test 2>&1 | tail -3 && npx tsc -b && npm run lint && npm run build
```

**人工走查（交付前必须做，自动化测不到）**：
1. 家长端 → 目标设定：页面按「数学 / 语文 / 英语」分组，每组下是适用指标，**数字输入框一眼看得出能改**。
2. 改一个目标并刷新 → 值仍在（这一条 1B 走查时没做，导致没发现输入框不可辨识）。
3. 仪表盘专项卡、报告页真掌握度卡未被本批破坏。
4. 学一节主线课 → `lesson_completions` 多一行 → 「每周完课」达成值 +1。
5. 学习页停留几分钟 → 该学科的「每日学习时长」不再恒为 0（**心跳补写的效果**）。

---

## 完工判据

1. `apps/server`：`npm test` 全绿 + `tsc` 干净 + `build` 成功 + 启动冒烟两条 goals 路由 mapped（**按 PID 收尾**）。
2. `apps/web`：`npm test` 全绿（夜间那条既有红除外）+ `tsc -b` + `lint` + `build`。
3. DB：迁移幂等复跑；`schema.sql` 与迁移的 `lesson_completions` 建表语句 `diff` 一致；生成列与两个唯一键就位（Task 1 Step 3 的 5 个数字）。
4. Task 10 Step 1 的三条真库验证全部符合预期（**事务已回滚，不留脏数据**）。
5. 两份 API 文档的 goals 契约一致（Task 9 Step 1 的脚本）；PRD/UX 的「提醒」已标本期不做（**需求原文未删**）。
6. 人工走查 5 条全过。

## 已知遗留（写进 changelog，别当没看见）

- **历史完课补不回来**：`lesson_completions` 只从上线起算。
- **`study_sessions.subject_id` 的历史 5 行仍为 NULL**：心跳补写只对之后的会话生效；这些会话不进任何学科的时长。
- **提醒与短信未做**：本批只按 PRD 的「按学科设定」补齐，提醒单独立项。
- **`special_practice_logs.subject_id` 仍恒 NULL**：语文/英语专项目标靠 `module` 筛，不靠该列（这是 1B 的有意设计）。
- **学生端 `StudentNav` 同样没有图标**（窄屏 4 行空白）：与本批无关的既有缺陷，待用户确认后另行处理。



