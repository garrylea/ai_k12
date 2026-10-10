# LLM 账本按学习模块归因（module 列）+ 模块 API 调用聚合 · 设计

> 背景：埋点 Phase 2 上线后用户提出「模块统计不足」——**「学习模块 × AI 调用」交叉维度缺失**（llm_call_logs 无 module 列；scene 是 AI 任务种类，主线/辅线都走 tutoring，区分不开；api_request_logs 有 module 列但无聚合端点）。本设计补两个能力：**A** 账本加 module 列（token/次数可按模块精确拆分）+ **C** API 请求按模块聚合端点。

## 1. 口径裁决

1. **module 的值域 = API 第一段**（复用 `moduleFromRoute`：`/api/practice/...` → `practice`），**不做**「API 段 → 学习模块枚举」的映射改写。理由：与 `api_request_logs.module` **同源同值域**（两本账本口径一致、可 JOIN 互查）；学习模块视图（主线/辅线/专项）在报表层做一次映射展示，改映射不动数据。
   - 值域实测：`practice`(主线课堂) / `ai`(辅线答疑) / `training`(语文英语专项+数学训练) / `exams` / `chinese-passages` / `points` / `parent` / `admin` 等；`NULL` = 真正无 HTTP 触发链的调用（如启动期任务）；HTTP 触发的 fire-and-forget（解释缓存/标题生成）与 admin/parent 的 HTTP 调用带触发请求的 module（ALS 随 Promise 链延续，与 §2.2.4 归因边界一致）。
   - 展示层映射（仅前端/报表文案，不落数据）：`practice→主线课堂`、`ai→辅线答疑`、`training→专项训练`、`exams→考试`、`NULL→后台任务`。
2. **A 与 B 的取舍**（已向用户呈报）：不加列的 request_id JOIN 方案会漏掉解释缓存类后台调用（request_id 有意置空）——恰可能是 token 大头，故取加列。
3. **历史数据不可补**：module 列从上线起才有值，之前的行恒 NULL（报表单列「后台任务/未归因」，不当 0）。
4. **调用次数 0 是真实 0**：module 维度的 calls/tokens 为 0 就写 0（与「正确率 answered=0→null」不同——那是分母无意义的比率；计数不存在这个问题）。

## 2. A：`llm_call_logs` 加 `module` 列

### 2.1 DDL（迁移 `tools/db/migrations/2026-10-10_llm_call_logs_module.sql`）

```sql
-- 幂等：information_schema 守卫 + PREPARE（MySQL 8/9 无 ADD COLUMN IF NOT EXISTS；
-- 写法与 2026-09-20_analytics_ledger.sql 的带守卫 DROP 同套路，方向相反）
ALTER TABLE llm_call_logs
  ADD COLUMN module VARCHAR(32) DEFAULT NULL
    COMMENT 'HTTP 请求模块（api 第一段，同 api_request_logs.module）；后台任务为 NULL' AFTER scene,
  ADD KEY idx_lcl_module_time (module, created_at);
```

（守卫包裹：先查 `information_schema.columns`，列已存在则跳过；`schema.sql` 同步——`llm_call_logs` 建表块加列与索引；DB 设计文档 v3.2。）

### 2.2 采集链路（ai-core 零依赖改动）

1. **`ai-core/infra/request-context.ts`**：`RequestContext` 加可选字段 `module?: string | null`；把 `moduleFromRoute`（现为 `common/interceptors/analytics.interceptor.ts:26` 的 5 行纯函数）**迁移**到此导出——ai-core 不能反向 import common（循环依赖，文件头注释已有此裁定），公共纯函数放 ai-core 让两侧共用防漂移；`analytics.interceptor.ts` 改 import。
2. **`RequestContextMiddleware`**（common/middleware）：建 context 时带 `module: moduleFromRoute(req.originalUrl ?? req.url ?? '')`（AuthMiddleware 之后已可用；skip 名单不影响——middleware 先跑）。
3. **写入点**：`AnalyticsModule` 构造函数的 `setLlmCallSink((entry) => ...)` 回调里，从 ALS 读当前 context 的 module，**enrich 进 entry 再 push**（`{...entry, module: ctx?.module ?? null}`）。ai-core 的 `LlmCallLogEntry` 加可选 `module` 字段（类型层）+ repo INSERT 列清单加列——写入路径仍 fire-and-forget，埋点失败不影响调用。
4. **归因边界**（与 Phase 0 口径对齐，注释写明）：NULL = 真正无 HTTP 触发链的调用（如启动期任务）；HTTP 触发的 fire-and-forget（解释缓存/标题生成）与 admin/parent 的 HTTP 调用**带触发请求的 module**（ALS 随 Promise 链延续）。

### 2.3 查询端

- `GET /api/admin/analytics/llm-tokens` 的 `groupBy` 白名单加 `module`（service `LLM_TOKEN_GROUPS` + repo `LLM_TOKEN_GROUP_EXPRS` 各加一项 `module`；`NULL` module 聚为一组，key 输出 `"(background)"`? —— **不**，key 原样输出 NULL 由前端显示「后台任务」，避免字符串 magic value 污染数据）。
- `GET /api/admin/analytics/modules` 响应每行加三列：`llmCalls:number`、`llmInputTokens:number`、`llmOutputTokens:number`（`LEFT JOIN` 按 module 聚合的 llm_call_logs；无调用 = 0，真实 0；unavailable 的 token 仍不计入求和、不影响 calls 计数——与 `/llm-tokens` 同款 CASE 口径）。JOIN 侧 module 值域与 study_sessions.module **不同**（见 §1.1），modules 表行的 module（mainline/training_targeted/...）与 llm 的 module（practice/training/ai/...）**不做等值连接**——三列改为「按 API 段聚合后映射到学习模块」：repo 里 CASE WHEN practice→mainline、ai→aux_qna、training→training_targeted、exams→exam，其余归 NULL 不并入行（文档写明映射表）。**实现取简**：单独一条 SQL 按 API 段 GROUP BY 后在 service 内按映射累加进对应行。
- 文档同步：API 主稿 §4.28（llm-tokens groupBy、modules 三列、api-usage 新端点）、openapi、delta spec 不涉及、changelog 追加。

## 3. C：API 请求按模块聚合端点

### 3.1 端点契约

`GET /api/admin/analytics/api-usage?from=&to=`（admin，`@Roles('admin')`）：

- 逻辑：窗口内 `api_request_logs` 按 `module` GROUP BY（复用 `parseWindow`；NULL module 单独一组）。
- 响应：`{ items: [{ module: string|null, calls: number, failedCalls: number, failureRate: number|null, avgLatencyMs: number }] }`，按 calls DESC。
  - `failureRate` 谓词与 `/quality` 完全一致：`status_code >= 500 OR biz_code IS NOT NULL`；分母 0 → null（`answered=0→null` 同族纪律）。
  - `avgLatencyMs` = AVG(latency_ms) 取整；**不含** minLatency/status 过滤（那是 /requests 的排查职责）。
- 新文件挂 `ops-analytics.repo/service/controller` 既有三件套（repo 方法 `apiUsage(window)`、service `apiUsage(q)`、controller `@Get('api-usage')`）；TDD：repo 断 SQL 片段（GROUP BY module、失败谓词与 quality 同款字符串）、service 断形状/0 行→null/映射。

### 3.2 前端

- **ModulesPage**（模块页）成为「模块统计」一站式：
  1. 既有使用表格加三列（LLM 调用 / 输入 token / 输出 token，来自 `/modules` 新列；0 显示 0）；
  2. 底部新增「各模块 API 调用」表（module 中文映射同 §1.1 + calls/失败率/平均耗时；来自 `/api-usage`）。
- **LlmTokensPage**：groupBy 下拉加「模块」选项（key 列中文映射同上；NULL → 「后台任务」）。
- api.ts：`ModulesData` 加三列类型；新增 `getAdminApiUsage`；`LlmTokensData.groupBy` 文档注释加 module。
- 页面渲染测试同步（ModulesPage 新表/新列、LlmTokensPage 新选项各 ≥1 例）。

## 4. 测试义务

- 迁移幂等（跑两遍）；schema.sql 与迁移 diff 一致（`schema_reconcile.py` 收尾重跑，**本批完工判据**——CLAUDE.md 已写）。
- 采集链路：ALS context 带 module（middleware 单测）；sink enrich 读 ALS（analytics.module 单测：无 ALS → module null）；ai-core LlmCallLogEntry 加列后既有测试零语义改动。
- 查询：llm-tokens groupBy=module（白名单/聚合/NULL 组）；modules 三列映射累加（practice→mainline 等用例）；api-usage（failureRate 谓词与 quality 同款、分母 0→null、NULL module 组）。
- 前端：新列/新表/新下拉的渲染测试；全量回归两端绿。
- 冒烟：起服务 curl `/api/admin/analytics/api-usage` 与 `llm-tokens?groupBy=module`，`llm_call_logs` 真库验证新调用行 module 有值、旧行为 NULL。

## 5. 本批不做

- 「API 段 → 学习模块」映射**不落数据库**（报表层映射，改映射不迁数据）。
- 历史行 module 回填（无可靠来源，NULL 即口径）。
- subject 维度的 token 聚合端点（llm_call_logs 已有 subject 列，要加 groupBy 顺手可做，但本期 YAGNI，用户未要）。
- events/behavior_events 的模块口径不动。
