# 埋点 Phase 2「Ops 产品面」· 设计（delta spec）

> 本文件是 `2026-09-19-analytics-instrumentation-design.md`（下称**母 spec**）Phase 2 的实施设计。母 spec 已定稿的部分（数据模型 DDL、事件字典、隐私分层、API 契约形状）**不再复制**，只引用章节号；本文件记录：① 用户裁决与母 spec 的差异/细化；② Phase 2 特有的落地设计（挂载点、漏斗定义、参数白名单、页面清单）。冲突时**先以母 spec 为准、再以本文件的显式修订为准**。

## 1. 范围与裁决（2026-10-09 brainstorm 确认）

1. **全量做**：行为事件（建表 + 采集 + 前端显式事件）+ ops 聚合 11 端点 + admin 分析 8 页，一批交付。
2. **单分支一波合并**：分支 `feat/analytics-phase2-ops`，顺序：迁移建表 → EventsService → 服务端挂载 → `/api/track/events` → ops 聚合端点 → admin 页面 → 文档同步，最后一个 `--no-ff` 合并进 main。
3. **`/events` 取 A（修订母 spec §8.3 字面）**：admin 事件流端点返回**全部 tier**。母 spec「仅 ops tier」的本意是家长端查不到 ops 信号——该约束由隐私三道锁锁在**家长端查询**上（母 spec §5.4），admin 作为运营端排查需要看到全量事件。
4. **`sendBeacon` 兜底端点不做**（母 spec §13 原文"Phase 2 可选"→ 本期裁决不做）：`pagehide` 时刻未 flush 的事件丢弃，与既有 tracker「失败丢弃不重试」口径一致。
5. **Phase 3 不做**：`daily_study_stats` rollup、分区、prom-client、beacon 端点、60s 大盘缓存均不在本期。

## 2. 数据模型

- 表 `behavior_events`：DDL 完全按母 spec §4.3（不增不删列、索引照抄）。迁移 `tools/db/migrations/2026-10-09_behavior_events.sql`（幂等，`CREATE TABLE IF NOT EXISTS`）；**必须同步进 `tools/db/schema.sql`** 与 `docs/K12智学系统-数据库设计文档.md`。手工 apply（无迁移运行器）。
- 180 天清理归 Phase 3，本期不建清理任务。
- `study_sessions` / `llm_call_logs` / `api_request_logs` / `special_practice_logs` 均已存在（Phase 0/1A/1B 交付），本期零 DDL。

## 3. 事件字典与隐私三道锁

- 字典：母 spec §5.2 的 18 个事件，**不增不删**；`study_session_heartbeat` 不落事件流的口径照旧。
- 三道锁（母 spec §5.4，缺一不可，写进本批为硬约束）：
  1. **写时定 tier**：`EventsService` 的 `EVENT_TIER` 是唯一真源，调用方不可覆盖；未登记事件**拒写**（TypeScript 穷尽类型 + 运行时拒绝双保险）。
  2. **查时硬过滤**：`parent-analytics.repo.ts` 一切查询硬编码 `tier='parent'`（本期家长端不新增端点，此锁防未来回归）。
  3. **守卫测试**：断言 `parent-analytics.repo.ts` 源码**不含** `hint_requested` / `answer_revealed` / `self_assess_answered` / `consecutive_failures` / `study_session_idle` 任一字符串。

## 4. 服务端打点挂载（server 来源 11 项，含 1 项兜底）

全部经新建 `EventsService.track()`；track **吞掉一切异常只 warn**（与 TelemetryBuffer 同纪律：任何埋点异常不许让请求 500）。

| 事件 | 收口点（2026-10-09 已核实存在） |
|---|---|
| `answer_submitted` | `JudgeCoreService`（`apps/server/src/modules/practice/judge-core.service.ts:130`，判题唯一出口；practice/training/exam/remediation 全走它；`module` 由调用方显式传，消除漂移） |
| `consecutive_failures` | 同上；同一学生同一 card 内连续判错计数，达 3 触发一次**并清零计数**（再连错 3 次可再触发）；`props.count` = 本次连续错数 |
| `hint_requested` | 提示端点（AI hint capability 的服务端调用处，落点在计划期钉到行） |
| `self_assess_answered` | 自评提交收口（含「我不会」，落点同上计划期钉） |
| `error_book_added` | 错题本 find-or-create 命中「新建」分支处 |
| `error_book_cleared` | 清零处（`JudgeCoreService.awardErrorFixOnClear` 一带） |
| `points_awarded` | `PointsService.award`（`apps/server/src/modules/points/points.service.ts:96`）内部，天然覆盖完课发分（`progress.service.ts:344 awardLessonPoints` 走 award） |
| `exam_submitted` | 考试提交收口（exam 模块 service，计划期钉到行） |
| `special_unit_judged` | 四个专项判题写入点（与 `SpecialPracticeLogsRepository` 写入同处；日志失败不回滚业务） |
| `llm_fallback_triggered` | ModelClient fallback 触发处（信息同时已在 `llm_call_logs`，事件只记 scene/from/to） |
| `study_session_ended`（server 兜底） | StudySessionsService 5 分钟惰性收尾时补发，`active_seconds` 取服务端累计值 |

## 5. 前端显式事件（client 来源 7 项）

- 事件：`study_session_started`、`study_session_ended`、`page_view`、`card_flipped`、`answer_revealed`、`ai_message_sent`、`study_session_idle`。
- **session 两事件必须补**（本 spec 审阅修正）：现状 tracker（1A 交付）只有 start/heartbeat/end 三个**会话 API 调用**（`transport.start/heartbeat/end`），没有行为事件队列；漏斗第一步依赖 `study_session_started`，不补则恒无数据。落点：`sessionMachine` 状态迁移的 `effects.start` 副作用出口里，在调会话 API 的同时向事件队列入队对应事件（`study_session_ended` 带 `end_reason`）。
- 载体：既有 `apps/web/src/analytics/tracker.ts` 队列（10s 定时 / 队列 ≥20 / 路由离开 / pagehide 触发 flush），新增指向 `/api/track/events` 的传输函数；传输失败全 `.catch(() => {})`。
- **节流**：`page_view` 同一路由 30s 内去重；`card_flipped` 每卡每次进页只记首翻。
- **`ai_message_sent` 只 client 记（修订母 spec §5.2 的 client+server 双来源）**：双记会重复计数且两侧无共同去重键；client 侧带 `dialogue_id` 上报，服务端不补记。

## 6. 采集端点

`POST /api/track/events`（student 角色 JWT；`@Post` 默认 201）：

- 入参 `{events:[{event, module?, scene?, subjectId?, refType?, refId?, sessionUid?, props?, clientTsMs?}]}`，批量 ≤ 50，超出 → 400/1001。
- 逐条校验：`event` 必须在 `EVENT_TIER` 字典内**且属于 client 白名单**（`study_session_started/ended`、`page_view`、`card_flipped`、`answer_revealed`、`ai_message_sent`、`study_session_idle`；服务端权威事件如 `answer_submitted`/`hint_requested` 伪造直接拒，计入 rejected）；`module`/`scene` 白名单、非法存 NULL；`subjectId` 若给需属于该学生可选学科 → 否则 1001（与 study-sessions 同口径）；`props` 序列化 ≤ 2KB。
- 返回 `{accepted, rejected}`（rejected 计数，不整体失败）。
- 失败口径与三个 study-sessions 端点一致：DB 失败 500、前端传输层吞掉。
- 新端点用 `parseInput` 模式转 400/1001（Zod 裸 parse 会 500——忘记密码批踩过的坑）。
- 本端点属 MVP，随 §9 清单一并进 openapi。

## 7. ops 聚合 11 端点（admin，`/api/admin/analytics`）

结构：扩既有 `modules/analytics/`——`ops-analytics.controller.ts`（11 个 GET，全部 `@Roles('admin')`）+ `ops-analytics.service.ts`（窗口计算、白名单校验）+ `ops-analytics.repo.ts`（只读 SQL）。全局 `ResponseInterceptor` 自动包 `{code,message,data}`。

通用纪律：
- 时间窗 `from,to`（YYYY-MM-DD，缺省近 7 天）**应用层**算窗口再传参（不用 `CURDATE()`，避免 DB 时区差一天）。
- 分页端点 20/页，`page` 从 1 起。
- 「正确率」类指标 `answered=0 → null`，**不许写 0**。
- 白名单参数越界 → 400/1001。

| # | 端点 | 数据源 | 要点 |
|---|---|---|---|
| 1 | `GET /overview` | study_sessions + behavior_events + special_practice_logs | DAU/WAU、总时长、总答题、正确率、模块 Top |
| 2 | `GET /modules` | 同上 | 各模块使用人数/时长/正确率横向对比 |
| 3 | `GET /funnel?module=` | behavior_events | 漏斗定义见 §7.1；每步 `COUNT(DISTINCT student_id)` 与相对上步转化率 |
| 4 | `GET /retention?cohortStart=&days=` | study_sessions | cohort = 首次活跃日落在 `cohortStart` 当天的学生；返回 D1/D7/D30（`days` 缺省 `1,7,30`）留存人数与占比 |
| 5 | `GET /cohort-compare?metric=&outcome=` | study_sessions 设备列 + behavior_events | 白名单 `metric ∈ {totalSeconds, accuracy, answerCount, daysActive}`、`outcome ∈ {platform_class, screen_class, app_shell, module}`；响应**必带** `disclaimer:'correlation-not-causation'` |
| 6 | `GET /quality` | api_request_logs + llm_call_logs + 内容表 | `apiFailureRate`、`errorCodeDistribution`、`llmTimeoutRate`、`llmFallbackRate`、`llmAttributionCoverage`（`student_id` 非空占比）；内容四指标见 §7.2 |
| 7 | `GET /llm-tokens?groupBy=` | llm_call_logs | `groupBy ∈ {scene, model, day, student}`；**按 model_key 聚合，不按 model_id**（母 spec 陷阱 #5）；同时返回 `attributed`/`unattributed` 调用数与 `usage_source='unavailable'` 调用数——**unavailable 不许当 0 求和** |
| 8 | `GET /llm-calls` | llm_call_logs | 过滤 `scene,model,success`，分页 20 |
| 9 | `GET /requests` | api_request_logs | 过滤 `path,status,minLatency`，分页 20 |
| 10 | `GET /events` | behavior_events | 过滤 `event,module,from,to`，分页 20；**返回全部 tier（裁决 3）** |
| 11 | `GET /devices` | study_sessions | 三块：① 分布按 `platform_class`（并列 `screen_class`/`input_type`/`app_shell`/`browser` 交叉），指标 = `COUNT(DISTINCT student_id)`（按人头不按会话）+ totalSeconds + accuracy + sessions；② 多设备学生（每生 DISTINCT platform_class 数）分档人数与占比；③ 设备切换（相邻两会话平台不同）次数与人次 |

### 7.1 漏斗定义（母 spec 未细化，此处定死）

每人计数 = `COUNT(DISTINCT student_id)`，窗口内同一事件去重到人：

| module | 步骤 |
|---|---|
| `mainline` | `study_session_started → answer_submitted → points_awarded`（进课 → 答题 → 完课发分） |
| `exam` | `study_session_started → answer_submitted → exam_submitted` |
| `training_targeted` / `training_error_practice` | `study_session_started → answer_submitted` |
| `chinese_dictation` / `chinese_interpretation` / `chinese_meaning` / `en_vocabulary` | `study_session_started → special_unit_judged` |

module 白名单 = 上述 8 个（不含 `aux_qna`/`admin`/`parent`——无漏斗语义）。

### 7.2 内容质量四指标

| 指标 | 来源 | 备注 |
|---|---|---|
| `questionsWithoutStandardAnswer` | questions / answers | 无标准答案的题目计数 |
| `kpCoverage:{covered,total,rate}` | question_knowledge_points | 有 KP 关联的题 / 总题 |
| `globalWordErrorRate:{wrong,total,rate}` | english_words.error_count | 全库词错误率 |
| `passageSkipRate` | **数据源待计划期核实** | 允许返回 `null`（不计为 0）；若核实无可靠来源则该项恒 null 并在响应中带 `source:'unavailable'` |

## 8. admin 分析页（8 页）

沿用 `AdminLayout` + `AdminNav`（navItems 加项），新建 `apps/web/src/pages/admin/analytics/`；图表复用既有 `chart-theme.ts` + `ChartLine`/`ChartBar`（recharts，取色从最近 `[data-theme]` 容器读）；数据获取在 `api.ts` 加 adminAnalytics 组。

| 路由 | 页面 | 内容 |
|---|---|---|
| `/admin/analytics` | `AnalyticsOverviewPage` | 今日/本周活跃、时长、答题、正确率卡 + 趋势线 + 模块 Top |
| `/admin/analytics/funnel` | `AnalyticsFunnelPage` | 模块选择器 + 分步人数/转化 |
| `/admin/analytics/retention` | `AnalyticsRetentionPage` | cohort 表（D1/D7/D30） |
| `/admin/analytics/modules` | `AnalyticsModulesPage` | 模块对比 + 分组对比（带「相关非因果」标注） |
| `/admin/analytics/quality` | `AnalyticsQualityPage` | 失败率/错误码/LLM 超时与 fallback/归属覆盖率 + 内容四指标 |
| `/admin/analytics/llm-tokens` | `AnalyticsLlmTokensPage` | groupBy 切换 + 「消耗最多的学生」排行 + 用量缺失计数 |
| `/admin/analytics/devices` | `AnalyticsDevicesPage` | 设备分布（按人头）、多设备占比、切换次数 |
| `/admin/analytics/events` | `AnalyticsEventsPage` | 全 tier 事件流表 + event/module 过滤 |

通用件：时间窗选择器（默认近 7 天）；空态按**空数组**判「暂无数据」，不许印「不足 1 分钟」类反向误读（1A 踩过的坑）。**不引入 emoji、装饰元素**；配色全 token。

## 9. 文档同步（硬清单）

- `docs/API接口与数据流设计文档.md`（主稿）：新增 §4.24 AdminAnalytics（11 端点）；§4.23 补 `POST /api/track/events`；§6 新增数据流（事件采集 → behavior_events；ops 聚合）；版本日志递增。
- `docs/api/openapi.yaml`：11 个 admin 端点 + `/api/track/events` 逐字段同步（本批即 MVP）。
- `docs/K12智学系统-数据库设计文档.md`：`behavior_events` 表。
- `docs/ai-core-changelog.md`：完成后追加一条。
- 根 `CLAUDE.md`「工程约定」：补隐私三道锁一条（若超出体量纪律则进 `docs/constraints/`）。

## 10. 测试义务

- 后端：`EventsService`（tier 不可覆盖 / 未登记拒写 / 异常不冒泡）；`/api/track/events`（批量 50 上限 / client 白名单拒伪造 / props 2KB / rejected 计数）；`ops-analytics.repo` 关键聚合（devices 按 DISTINCT student 不算重、llm-tokens 的 unavailable 不当 0、retention D1 计算、漏斗去重到人）；**隐私守卫测试**（§3 第 3 锁）。
- 前端：tracker 显式事件入队与节流（`setTransport` + `vi.useFakeTimers()`）；8 个页面每个至少一条渲染测试（CLAUDE.md 硬规则）；多用例文件自写 `afterEach(() => cleanup())`。
- 回归：`apps/server` + `apps/web` 全量 `npm test` 绿；起服务用 `node dist/main.js`；冒烟独立端口 + 按 PID 收尾（别 pkill）。
- 组件级验证纪律：凡「参数顺序 ↔ 列清单」的 INSERT（behavior_events 写入）按列名配对断言或真库事务验证（Phase 1B goals 占位符教训）。

## 11. 本批明确不做

- `sendBeacon` 兜底端点（裁决 4）。
- Phase 3 全部内容（rollup / 分区 / prom-client / 大盘缓存）。
- 母 spec §13 其余不做项照旧（A/B 框架、家长端暴露 ops 信号、价格成本、homeworks 接线等）。
- 挂载点改造以外的重构（不动 JudgeCoreService/PointsService 既有逻辑，只加 track 调用）。
