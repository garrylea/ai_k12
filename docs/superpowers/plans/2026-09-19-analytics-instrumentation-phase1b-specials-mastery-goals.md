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
