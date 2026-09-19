# 埋点 Phase 0（地基与「钱」）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「每次 LLM 调用花了多少钱、哪个学生烧得最多、哪个接口在失败」三件事第一次真正可查——把 token 采集修好、把单价搬进 DB、把调用与请求落成账本。

**Architecture:** 两条独立的数据管线。① **账本线**：`ModelClient.chat()` 是所有 capability 的唯一出口，在那里把「每次逻辑调用 + 每次重试尝试」记成一条 `llm_call_logs`；归因（scene/subject/isFallback）挂在 `RoutedModel` 上由 router 打标，学生/请求上下文走 `AsyncLocalStorage`。② **请求线**：一个全局 `AnalyticsInterceptor` 记录每个 HTTP 请求的方法/归一化路由/状态码/耗时到 `api_request_logs`，SSE 也在内。两条线都只 `push()` 进内存缓冲，由 `TelemetryBuffer` 批量落库、失败静默——**埋点永远不能让业务请求变慢或 500**。

**Tech Stack:** NestJS 10（`APP_INTERCEPTOR` / 中间件 / `@Inject('DATABASE_POOL')`）、TypeScript ESM、MySQL 9（mysql2/promise）、Vitest、prom-client、Zod。

**Spec:** `docs/superpowers/specs/2026-09-19-analytics-instrumentation-design.md`（本计划只做 §12 的 Phase 0；Phase 1/2 另立计划）

## Global Constraints

- **DB 约定**：所有时间列 `DATETIME(3)`；`updated_at` 用**列级** `ON UPDATE CURRENT_TIMESTAMP(3)`，**绝不加触发器**；引擎/字符集 `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`。
- **迁移**：无迁移运行器，**手工 apply**；必须**幂等**（建表用 `CREATE TABLE IF NOT EXISTS`，加列用 `information_schema` + `PREPARE` 守卫）；新表/新列**必须同时写进 `tools/db/schema.sql`**。
- **`cost` 的 NULL 语义**：算不出成本写 **NULL**，**绝不写 0**（0 只代表「真免费」，如本地模型）。tokens 同理：拿不到写 NULL，不写 0。
- **埋点不得影响主链路**：分析类日志只进内存缓冲，flush 失败**整批丢弃、不重试、不抛**；`llm_call_logs` / `api_request_logs` 的写入永不 `await` 在请求路径上。
- **Nest DI 坑**：`@Injectable()` 的类若构造参数是**接口类型**（非 class），运行时 `design:paramtypes` 会序列化成 `Object`，Nest 找不到 token 会**启动直接失败**。必须显式 `@Inject(TOKEN)` 或 `@Optional()`。仓库先例：`admin-models.service.ts:21` 的 `@Inject(ModelConfigRegistry)`。
- **模型 ID 勿改**：`kimi-latest`、`qwen3.8-max`、`gemini-3.1-pro`、`deepseek-flash`。配置里 kimi 的**路由 key 是 `kimi`**、modelId 是 `kimi-latest`——聚合一律按 **model_key**，不要按 model_id 关联 `llm_models`。
- **测试约定**：`globals: false` → 每个用例文件自己 `import { describe, it, expect, vi } from 'vitest'`；测试文件与被测文件同目录；repo 测试用**假 pool**（见 `point-ledger.repo.test.ts` 的 `mockPool` 双返回形状）。
- **分层约束（对 spec §6.1 的一处修正）**：`request-context.ts`（ALS）放 **`ai-core/infra/`**，不放 `modules/analytics/`——`ai-core` 不允许反向依赖 `modules/`（`ModelClient` 要读它），放错会形成循环依赖。
- **命令**：后端测试 `cd apps/server && npm test`；起服务 `node dist/main.js`（`npx tsx src/main.ts` 的 DI 是坏的）；冒烟用**独立端口 + 按 PID 收尾**，**别 `pkill -f 'node dist/main.js'`**。
- **UI 规则**（本计划只碰管理端表单）：不用 emoji，图标用线性 SVG，配色只用 `apps/web/style.md` §2 的 token，管理端全程日间主题。

## File Structure

**新建（后端）**

| 文件 | 职责 |
|---|---|
| `tools/db/migrations/2026-09-20_analytics_ledger.sql` | 建 `llm_call_logs` + `api_request_logs`；`llm_models` 加两个价格列（带守卫） |
| `apps/server/src/database/repositories/llm-call-logs.repo.ts` | `llm_call_logs` 的批量插入（列序常量是唯一真源） |
| `apps/server/src/database/repositories/api-request-logs.repo.ts` | `api_request_logs` 的批量插入 + `ApiRequestLogEntry` 类型 |
| `apps/server/src/modules/analytics/telemetry-buffer.ts` | 通用环形缓冲（纯类，无 DB 依赖，可单测） |
| `apps/server/src/modules/analytics/telemetry.service.ts` | 持有两个 buffer，接 repo 的 flush，`OnModuleDestroy` 收尾 |
| `apps/server/src/modules/analytics/analytics.module.ts` | 组装 provider；启动时把 sink 注册给 ai-core |
| `apps/server/src/ai-core/infra/llm-call-log.ts` | `LlmCallLogEntry` 类型 + 全局 sink 单例（`setLlmCallSink` / `emitLlmCall`） |
| `apps/server/src/ai-core/infra/request-context.ts` | `AsyncLocalStorage<RequestContext>` |
| `apps/server/src/ai-core/infra/usage-estimate.ts` | token 估算兜底（CJK 按字、拉丁 char/4） |
| `apps/server/src/common/middleware/request-context.middleware.ts` | 每请求 `runWithRequestContext(...)` |
| `apps/server/src/common/interceptors/analytics.interceptor.ts` | 记录 `api_request_logs`（含 SSE 时长、错误码、跳过名单） |
| `apps/server/src/scripts/seed-llm-prices.ts` | 从 `model-routes.yaml` 幂等回填两个价格列 |

**新建（前端）**

| 文件 | 职责 |
|---|---|
| `apps/web/src/pages/admin/AdminModelsPage.test.tsx` | 价格列的渲染测试 |

**修改**

| 文件 | 改动 |
|---|---|
| `tools/db/schema.sql` | 新增 §15 两张表；`llm_models` 加两个价格列 |
| `apps/server/src/database/repositories/llm-models.repo.ts` | `LlmModelRow`/`LlmModel` 加价格；`create`/`update`/`mapRow` 带上 |
| `apps/server/src/database/repositories/index.ts` | 导出两个新 repo 与类型 |
| `apps/server/src/ai-core/infra/model-config-registry.ts` | `costPer1K` 从 DB 价格列来（不再写死 `{0,0}`） |
| `apps/server/src/ai-core/types.ts` | `RoutedModel` 加归因字段；`ChatRequest` 加 `meta`；`ChatResponse.usage` 支持 NULL + `source`；`StreamChunk` 加 `usage` |
| `apps/server/src/ai-core/infra/model-router.ts` | `route()` 给 primary/fallback 打 `scene`/`subject`/`modelKey`/`isFallbackEntry` |
| `apps/server/src/ai-core/infra/model-client/index.ts` | usage 采集修复 + 每次尝试发 `emitLlmCall` |
| `apps/server/src/ai-core/infra/model-client/openai-compatible-client.ts` | 流式请求体加 `stream_options.include_usage`；usage 缺失时不再写 0；流式透出 usage |
| `apps/server/src/ai-core/infra/model-client/local-client.ts` | 删掉 `stream_options`（llama.cpp 不认） |
| `apps/server/src/ai-core/infra/model-client/gemini-client.ts` | usage 补 `source: 'provider'` |
| `apps/server/src/modules/admin/admin-models.service.ts` | create/update 接受价格字段 |
| `apps/server/src/modules/admin/admin.controller.ts` | `ModelSchema` 加价格校验 |
| `apps/server/src/modules/admin/admin-chat.service.ts` | 消除硬编码 `costPer1K: {0,0}` |
| `apps/server/src/app.module.ts` | 注册 `RequestContextMiddleware` + `APP_INTERCEPTOR(useExisting AnalyticsInterceptor)` + `AnalyticsModule` |
| `apps/server/src/main.ts` | `enableShutdownHooks()` |
| `apps/web/src/services/api.ts` | `AdminModelItem` 加价格；create/update 参数加价格 |
| `apps/web/src/pages/admin/AdminModelsPage.tsx` | 表单加两个价格输入（**编辑态可改**） |

**任务依赖**：Task 1 →（2、3、4、5、6、7 可并行）→ Task 8（依赖 2、3、6、7）→ Task 9（依赖 7、8）→ Task 10。Task 5 依赖 Task 4。

---

### Task 1: 迁移与 schema——两张账本表 + `llm_models` 价格列

**Files:**
- Create: `tools/db/migrations/2026-09-20_analytics_ledger.sql`
- Modify: `tools/db/schema.sql`（`llm_models` 定义 + 末尾新增 §15）

**Interfaces:**
- Consumes: 无
- Produces: 表 `llm_call_logs`、`api_request_logs`；列 `llm_models.input_price_per_1k`、`llm_models.output_price_per_1k`（后续所有任务依赖这些确切列名）

- [ ] **Step 1: 写迁移文件**

Create `tools/db/migrations/2026-09-20_analytics_ledger.sql`：

```sql
-- 2026-09-20 埋点 Phase 0：模型调用账本 + API 请求日志 + 模型单价列。
--
-- 背景（见 docs/superpowers/specs/2026-09-19-analytics-instrumentation-design.md §2.3）：
--   * `ai_messages` 的 model/token_input/token_output/response_time_ms 四列**生产恒写 NULL**；
--   * `ModelClient.chat()` 默认走流式，`aggregateStream()` 把 usage 硬编码成 {0,0,0}；
--   * `model-config-registry.ts:70` 把 costPer1K 写死 {input:0,output:0}；`llm_models` 根本没有价格列。
--   即「次数 / token / 钱」三样全算不出。本迁移只补**存储**；采集修复在代码侧。
--
-- 幂等：建表用 CREATE TABLE IF NOT EXISTS；ADD COLUMN 先查 information_schema 再 PREPARE
-- （沿用 2026-09-16_chinese_interpretation_columns.sql 的固定套路）。本文件**没有任何
-- DELETE/DROP**——2026-09-15 那次迁移因级联删题静默清空 50 行的教训见
-- docs/superpowers/plans/2026-09-15-chinese-passages-standalone.md Task 9。

-- ---- llm_models 单价列 ----
SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'llm_models'
    AND COLUMN_NAME = 'input_price_per_1k'
);
SET @ddl := IF(
  @has_col = 0,
  'ALTER TABLE llm_models ADD COLUMN input_price_per_1k DECIMAL(10,6) NOT NULL DEFAULT 0 COMMENT ''每 1K 输入 token 价，单位与 model-routes.yaml 的 costPer1K.input 一致'' AFTER max_output_tokens',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'llm_models'
    AND COLUMN_NAME = 'output_price_per_1k'
);
SET @ddl := IF(
  @has_col = 0,
  'ALTER TABLE llm_models ADD COLUMN output_price_per_1k DECIMAL(10,6) NOT NULL DEFAULT 0 COMMENT ''每 1K 输出 token 价，单位与 costPer1K.output 一致'' AFTER input_price_per_1k',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---- llm_call_logs：每次 LLM 调用（含重试尝试、失败、超时、fallback）一行 ----
-- student_id 用 ON DELETE SET NULL（**有意**偏离仓库 CASCADE 约定）：账本是审计数据，
-- 学生被删后聚合量应保留、仅匿名化；列可空故 FK 合法。
-- cost / input_tokens / output_tokens 允许 NULL —— **NULL = 算不出，绝不是 0**；
-- 0 只代表「真免费」（本地模型）。与家长端 answered=0 → rate=null 同一纪律。
CREATE TABLE IF NOT EXISTS llm_call_logs (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  request_id          VARCHAR(64)   DEFAULT NULL COMMENT '关联 api_request_logs.request_id',
  student_id          BIGINT        DEFAULT NULL COMMENT '有归属时必填；仅 admin-chat/探活/系统任务为 NULL',
  dialogue_id         BIGINT        DEFAULT NULL COMMENT '无外键：对话可删，账本不可',
  scene               VARCHAR(30)   NOT NULL,
  subject             VARCHAR(20)   DEFAULT NULL,
  capability          VARCHAR(30)   DEFAULT NULL,
  model_key           VARCHAR(50)   DEFAULT NULL COMMENT '路由条目 key（聚合按它，不按 model_id）',
  model_id            VARCHAR(100)  DEFAULT NULL COMMENT '实际下发 model id',
  provider            VARCHAR(20)   NOT NULL,
  attempt             SMALLINT      NOT NULL DEFAULT 1,
  request_kind        VARCHAR(8)    NOT NULL COMMENT 'chat|stream',
  is_fallback         TINYINT(1)    NOT NULL DEFAULT 0,
  success             TINYINT(1)    NOT NULL,
  error_type          VARCHAR(40)   DEFAULT NULL COMMENT 'LLMClientError 子类名，如 TimeoutError',
  http_status         SMALLINT      DEFAULT NULL,
  input_tokens        INT           DEFAULT NULL,
  output_tokens       INT           DEFAULT NULL,
  usage_source        VARCHAR(12)   NOT NULL DEFAULT 'unavailable' COMMENT 'provider|estimated|unavailable',
  input_price_per_1k  DECIMAL(10,6) DEFAULT NULL COMMENT '价格快照，防改价后历史成本漂移',
  output_price_per_1k DECIMAL(10,6) DEFAULT NULL,
  cost                DECIMAL(12,6) DEFAULT NULL COMMENT 'NULL = 算不出，绝不写 0',
  latency_ms          INT           NOT NULL,
  created_at          DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_lcl_scene_time    (scene, created_at),
  KEY idx_lcl_model_time    (model_key, created_at),
  KEY idx_lcl_student_time  (student_id, created_at),
  KEY idx_lcl_fallback_time (is_fallback, created_at),
  KEY idx_lcl_time          (created_at),
  CONSTRAINT fk_lcl_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---- api_request_logs：每个 HTTP 请求一行（技术日志，30 天滚动） ----
-- route 是**归一化模板**（如 /api/practice/:cardId/results），raw_path 才带真实 id。
CREATE TABLE IF NOT EXISTS api_request_logs (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  request_id  VARCHAR(64)  DEFAULT NULL,
  actor_role  VARCHAR(10)  DEFAULT NULL COMMENT 'student|parent|admin|anonymous',
  student_id  BIGINT       DEFAULT NULL,
  method      VARCHAR(8)   NOT NULL,
  route       VARCHAR(120) NOT NULL COMMENT '归一化模板：/api/practice/:cardId/results',
  raw_path    VARCHAR(255) DEFAULT NULL COMMENT '原路径（含 id），仅排查用',
  module      VARCHAR(32)  DEFAULT NULL COMMENT '由 route 前缀推导',
  status_code SMALLINT     NOT NULL,
  biz_code    INT          DEFAULT NULL COMMENT '响应体 code（1001/5001...）',
  error_code  VARCHAR(40)  DEFAULT NULL COMMENT 'TimeoutError 等',
  latency_ms  INT          NOT NULL,
  is_sse      TINYINT(1)   NOT NULL DEFAULT 0,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_arl_route_time   (route, created_at),
  KEY idx_arl_status_time  (status_code, created_at),
  KEY idx_arl_student_time (student_id, created_at),
  KEY idx_arl_time         (created_at),
  CONSTRAINT fk_arl_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 2: 同步 `tools/db/schema.sql`（两处）**

**2a.** 在 `llm_models` 定义（`schema.sql:937-951`）的 `max_output_tokens` 之后插入两列：

```sql
  max_output_tokens INT NOT NULL DEFAULT 16384,
  -- 每 1K token 单价，单位与 ai-core/model-routes.yaml 的 costPer1K 一致。
  -- 这两个列是**价格的唯一真源**：model-config-registry 从这里读进 costPer1K。
  input_price_per_1k  DECIMAL(10,6) NOT NULL DEFAULT 0,
  output_price_per_1k DECIMAL(10,6) NOT NULL DEFAULT 0,
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
```

**2b.** 在 `training_sessions` 之后、`-- 14.（已移除）updated_at 自动触发器` 之前（约 `schema.sql:1154`）插入新段落——内容就是把 Step 1 里的两个 `CREATE TABLE` 原样粘贴，前面加段落头：

```sql
-- ============================================================
-- 15. 埋点与账本（2026-09-20，埋点 Phase 0）
-- ============================================================
-- 见 tools/db/migrations/2026-09-20_analytics_ledger.sql 的头部注释（口径与幂等说明）。
```

- [ ] **Step 3: 应用迁移到 dev 库并验证幂等**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
mysql -u ai_k12 -pai_k12 ai_k12 < tools/db/migrations/2026-09-20_analytics_ledger.sql
# 再跑一次证明幂等（必须同样成功、且不报 Duplicate column）
mysql -u ai_k12 -pai_k12 ai_k12 < tools/db/migrations/2026-09-20_analytics_ledger.sql
```
Expected: 两次都无错误输出（第二次因为走 `SELECT 1` 分支而静默成功）。

- [ ] **Step 4: 断言结构与列名**

```bash
mysql -u ai_k12 -pai_k12 ai_k12 -e "SHOW COLUMNS FROM llm_call_logs; SHOW COLUMNS FROM api_request_logs; SHOW COLUMNS FROM llm_models LIKE '%price%';"
```
Expected: `llm_call_logs` 含 `usage_source` / `input_price_per_1k` / `output_price_per_1k` / `cost` 且 `cost` 的 `Null=YES`；`api_request_logs` 含 `route` / `raw_path` / `is_sse`；`llm_models` 两行价格列 `Null=NO`、默认 `0.000000`。

- [ ] **Step 5: 断言 schema.sql 与库一致（防「schema 漂移」老毛病）**

```bash
# 两张表都要看：单看 llm_call_logs 只有 1 处，合计才是 2 处。
# 用 --vertical（不要用 \G：本机 mysql 9.5 客户端在 -e 下不认 \G）
mysql -u ai_k12 -pai_k12 ai_k12 --vertical -e "SHOW CREATE TABLE llm_call_logs; SHOW CREATE TABLE llm_models;" | grep -c "input_price_per_1k"
grep -c "input_price_per_1k" tools/db/schema.sql
```
Expected: 两条命令都输出 `2`（`llm_call_logs` 的列定义 1 处 + `llm_models` 的列定义 1 处）。
若数字不等，说明 schema.sql 漏改，回去补——**「schema.sql 与既有库不同步」是本仓记录在案的事故类型**。

- [ ] **Step 6: Commit**

```bash
git add tools/db/migrations/2026-09-20_analytics_ledger.sql tools/db/schema.sql
git commit -m "feat(db): llm_call_logs + api_request_logs 建表，llm_models 加单价列（埋点 Phase 0）"
```

---

### Task 2: `LlmModelsRepository` 支持价格字段

**Files:**
- Modify: `apps/server/src/database/repositories/llm-models.repo.ts`
- Test: `apps/server/src/database/repositories/llm-models.repo.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的列 `input_price_per_1k` / `output_price_per_1k`
- Produces: `LlmModel` 接口新增 `inputPricePer1k: number`、`outputPricePer1k: number`（Task 3 的 registry、Task 4 的 service、Task 5 的 API 都按这两个**驼峰名**用）

- [ ] **Step 1: 写失败测试**

Create `apps/server/src/database/repositories/llm-models.repo.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { LlmModelsRepository } from './llm-models.repo';

/** 模拟 mysql2 pool 的双返回形状：SELECT -> [rows, fields] */
const mockPool = (rows: any[] = []) => ({
  execute: vi.fn().mockImplementation((sql: string) => {
    if (/^\s*(INSERT|UPDATE)/i.test(sql)) return Promise.resolve([{ affectedRows: 1 }, []]);
    return Promise.resolve([rows, []]);
  }),
  query: vi.fn().mockResolvedValue([rows, []]),
});

const dbRow = () => ({
  id: 1, model_key: 'kimi', name: 'Kimi', provider_type: 'kimi', model_id: 'kimi-latest',
  base_url: 'https://x', api_key: 'plain-key-does-not-decrypt', context_window: 131072,
  max_output_tokens: 16384, is_enabled: 1,
  input_price_per_1k: '0.012000', output_price_per_1k: '0.028000',
});

describe('LlmModelsRepository 单价映射', () => {
  it('mapRow 把 DECIMAL 字符串转成 number（mysql2 对 DECIMAL 返回字符串）', async () => {
    const repo = new LlmModelsRepository(mockPool([dbRow()]) as any);
    const [m] = await repo.listAll();
    expect(m.inputPricePer1k).toBeCloseTo(0.012, 6);
    expect(m.outputPricePer1k).toBeCloseTo(0.028, 6);
    expect(typeof m.inputPricePer1k).toBe('number');
  });

  it('create 落单价，缺省写 0', async () => {
    const pool = mockPool();
    const repo = new LlmModelsRepository(pool as any);
    await repo.create({
      modelKey: 'm1', name: 'M1', providerType: 'kimi', modelId: 'm1',
      baseUrl: 'https://x', apiKey: 'sk-1', contextWindow: 8, maxOutputTokens: 8,
      inputPricePer1k: 0.007, outputPricePer1k: 0.028,
    });
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('input_price_per_1k');
    expect(sql).toContain('output_price_per_1k');
    expect(params).toContain(0.007);
    expect(params).toContain(0.028);
  });

  it('update 只写显式传入的单价（未传则不动该列）', async () => {
    const pool = mockPool();
    const repo = new LlmModelsRepository(pool as any);
    await repo.update('m1', { inputPricePer1k: 0.02 });
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('input_price_per_1k = ?');
    expect(sql).not.toContain('output_price_per_1k');
    expect(params).toEqual([0.02, 'm1']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/server && npx vitest run src/database/repositories/llm-models.repo.test.ts
```
Expected: FAIL —— `m.inputPricePer1k` 是 `undefined`（`expected undefined to be close to 0.012`）。

- [ ] **Step 3: 实现**

修改 `apps/server/src/database/repositories/llm-models.repo.ts`：

**3a.** `LlmModelRow` 加两列（`llm-models.repo.ts:5-9`）：
```ts
export interface LlmModelRow extends RowDataPacket {
  id: number; model_key: string; name: string; provider_type: string;
  model_id: string; base_url: string; api_key: string;
  context_window: number; max_output_tokens: number; is_enabled: number;
  // mysql2 对 DECIMAL 返回字符串，mapRow 负责转 number
  input_price_per_1k: string | number; output_price_per_1k: string | number;
}
```

**3b.** `LlmModel` 加两个驼峰字段（`llm-models.repo.ts:11-14`）：
```ts
export interface LlmModel {
  modelKey: string; name: string; providerType: string; modelId: string;
  baseUrl: string; apiKey: string; contextWindow: number; maxOutputTokens: number; isEnabled: boolean;
  /** 每 1K 输入 token 单价，与 model-routes.yaml 的 costPer1K.input 同单位 */
  inputPricePer1k: number;
  /** 每 1K 输出 token 单价 */
  outputPricePer1k: number;
}
```

**3c.** `create` 插入两列（替换 `llm-models.repo.ts:37-43`）：
```ts
  async create(data: Omit<LlmModel, 'isEnabled'> & { isEnabled?: boolean }): Promise<void> {
    await this.pool.execute(
      `INSERT INTO llm_models (model_key, name, provider_type, model_id, base_url, api_key, context_window, max_output_tokens, input_price_per_1k, output_price_per_1k, is_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [data.modelKey, data.name, data.providerType, data.modelId, data.baseUrl,
       encryptApiKey(data.apiKey), data.contextWindow, data.maxOutputTokens,
       data.inputPricePer1k ?? 0, data.outputPricePer1k ?? 0,
       data.isEnabled === false ? 0 : 1]);
  }
```

**3d.** `update` 加两个分支（在 `maxOutputTokens` 分支之后、`llm-models.repo.ts:53` 之前）：
```ts
    if (data.inputPricePer1k !== undefined) { sets.push('input_price_per_1k = ?'); args.push(data.inputPricePer1k); }
    if (data.outputPricePer1k !== undefined) { sets.push('output_price_per_1k = ?'); args.push(data.outputPricePer1k); }
```

**3e.** `mapRow` 映射（`llm-models.repo.ts:66-72`）：
```ts
  private mapRow(r: LlmModelRow): LlmModel {
    return {
      modelKey: r.model_key, name: r.name, providerType: r.provider_type,
      modelId: r.model_id, baseUrl: r.base_url, apiKey: decryptApiKey(r.api_key),
      contextWindow: r.context_window, maxOutputTokens: r.max_output_tokens, isEnabled: r.is_enabled === 1,
      inputPricePer1k: Number(r.input_price_per_1k ?? 0),
      outputPricePer1k: Number(r.output_price_per_1k ?? 0),
    };
  }
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/server && npx vitest run src/database/repositories/llm-models.repo.test.ts && npm test 2>&1 | tail -20
```
Expected: 新文件 3 passed；全量测试此前是 1166，现在应为 1169 通过、0 失败。
**注意**：`admin-models.service.test.ts:15` 的 `dbModel()` 固定装置缺两个新字段——若 tsc 报错，给它补 `inputPricePer1k: 0, outputPricePer1k: 0`。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/database/repositories/llm-models.repo.ts apps/server/src/database/repositories/llm-models.repo.test.ts apps/server/src/modules/admin/admin-models.service.test.ts
git commit -m "feat(repo): LlmModelsRepository 支持输入/输出单价（DECIMAL 字符串转 number）"
```

---

### Task 3: registry 读真价 + 价格回填脚本

**Files:**
- Modify: `apps/server/src/ai-core/infra/model-config-registry.ts:70`
- Create: `apps/server/src/scripts/seed-llm-prices.ts`
- Test: `apps/server/src/ai-core/infra/model-config-registry.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 2 的 `LlmModel.inputPricePer1k` / `outputPricePer1k`
- Produces: registry 快照里的 `models[key].costPer1K = { input, output }` 为**真实价格**（Task 8 的 `ModelClient` 用它算 cost）；脚本命令 `npx tsx src/scripts/seed-llm-prices.ts`

- [ ] **Step 1: 写失败测试**

`ModelConfigRegistry` 的依赖走**构造函数**注入（`model-config-registry.ts:42` `constructor(private deps?: RegistryDeps)`），`RegistryDeps` 形状是 `{ llmModelsRepo: Pick<LlmModelsRepository,'listEnabled'>; llmRoutesRepo: Pick<LlmRoutesRepository,'listAll'> }`（`:34-37`）。在该测试文件末尾追加：

```ts
describe('ModelConfigRegistry 单价来自 DB（不再写死 0）', () => {
  it('DB 行的单价列进 costPer1K', async () => {
    const registry = new ModelConfigRegistry({
      llmModelsRepo: {
        listEnabled: async () => [{
          modelKey: 'kimi', name: 'Kimi', providerType: 'kimi', modelId: 'kimi-latest',
          baseUrl: 'https://x', apiKey: 'sk-1', contextWindow: 131072, maxOutputTokens: 16384,
          isEnabled: true, inputPricePer1k: 0.012, outputPricePer1k: 0.028,
        }],
      } as any,
      llmRoutesRepo: { listAll: async () => [] } as any,
    });
    await registry.reload();
    expect(registry.getSnapshot().models['kimi'].costPer1K).toEqual({ input: 0.012, output: 0.028 });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/server && npx vitest run src/ai-core/infra/model-config-registry.test.ts
```
Expected: FAIL —— `costPer1K` 实际是 `{ input: 0, output: 0 }`。

- [ ] **Step 3: 实现 registry 读真价**

修改 `apps/server/src/ai-core/infra/model-config-registry.ts`，把第 70 行的写死值换成读列（`m` 的类型是 Task 2 的 `LlmModel`）：

```ts
          // 单价唯一真源是 DB（llm_models 两个价格列）；YAML 只在 DB 空时兜底。
          // 改价后必须走 AdminModelsService.update → registry.reload() 才生效（进程内快照）。
          costPer1K: { input: m.inputPricePer1k, output: m.outputPricePer1k },
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/server && npx vitest run src/ai-core/infra/model-config-registry.test.ts
```
Expected: PASS。

- [ ] **Step 5: 写回填脚本**

Create `apps/server/src/scripts/seed-llm-prices.ts`：

```ts
/**
 * 把 model-routes.yaml 里的 costPer1K 幂等回填进 llm_models 的两个价格列。
 *
 * 为什么需要它：YAML 是历史真源（kimi 0.012/0.012、qwen3.8-max 0.007/0.028、
 * gemini-3.1-pro 0.0025/0.01、deepseek-flash 0.001/0.004、local 0/0），而 DB 里
 * 新建的模型行默认 0。迁移后若不回填，registry 会读到 0 → cost 全 0 → 成本面板全空。
 *
 * 幂等：只 UPDATE 已存在的 model_key，不 INSERT；重复跑结果相同。
 * 用法：cd apps/server && npx tsx src/scripts/seed-llm-prices.ts
 */
import 'dotenv/config';
import { routeConfig } from '../ai-core/config.js';
import { createPool } from '../database/connection.js';
import { LlmModelsRepository } from '../database/repositories/llm-models.repo.js';

async function main(): Promise<void> {
  const pool = createPool();
  const repo = new LlmModelsRepository(pool);
  const yamlModels = routeConfig.models as Record<string, { costPer1K?: { input: number; output: number } }>;

  let updated = 0;
  const skipped: string[] = [];
  for (const [modelKey, cfg] of Object.entries(yamlModels)) {
    const price = cfg.costPer1K;
    if (!price) { skipped.push(`${modelKey}(YAML 无 costPer1K)`); continue; }
    const existing = await repo.findByKey(modelKey);
    if (!existing) { skipped.push(`${modelKey}(DB 无此模型)`); continue; }
    await repo.update(modelKey, { inputPricePer1k: price.input, outputPricePer1k: price.output });
    updated += 1;
    console.log(`[ok] ${modelKey}: ${price.input} / ${price.output}`);
  }

  console.log(`\n回填完成：更新 ${updated} 个模型`);
  if (skipped.length > 0) console.log(`跳过：${skipped.join(', ')}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 6: 跑脚本验证（需 DB 可达）**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/server && npx tsx src/scripts/seed-llm-prices.ts
```
Expected: 打印每个已存在模型的价格与「回填完成：更新 N 个模型」（N ≥ 1）。再跑一次，输出完全相同（幂等）。若全部 `DB 无此模型`，说明 dev 库 `llm_models` 还没 seed——那是既有状态，脚本行为正确，不阻塞后续任务。

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/ai-core/infra/model-config-registry.ts apps/server/src/ai-core/infra/model-config-registry.test.ts apps/server/src/scripts/seed-llm-prices.ts
git commit -m "feat(ai-core): costPer1K 改读 DB 单价列，附 YAML→DB 幂等回填脚本"
```

---

### Task 4: 管理端后端——价格的增改接口 + 消除 admin-chat 硬编码

**Files:**
- Modify: `apps/server/src/modules/admin/admin-models.service.ts`
- Modify: `apps/server/src/modules/admin/admin.controller.ts:15-26`
- Modify: `apps/server/src/modules/admin/admin-chat.service.ts:84`
- Test: `apps/server/src/modules/admin/admin-models.service.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 2 的 `LlmModelsRepository.create/update` 价格参数
- Produces: 端点 `POST /api/admin/models` 与 `PATCH /api/admin/models/:modelKey` 接受 `inputPricePer1k` / `outputPricePer1k`（number，≥0）；`GET /api/admin/models` 返回它们（Task 5 的前端依赖）

- [ ] **Step 1: 写失败测试**

在 `apps/server/src/modules/admin/admin-models.service.test.ts` 的 `describe('AdminModelsService', ...)` 内追加：

```ts
  it('create 透传单价给 repo', async () => {
    const d = mk();
    await svc(d).create({
      modelKey: 'm9', name: 'M9', providerType: 'kimi', modelId: 'm9',
      baseUrl: 'https://x', apiKey: 'sk-1', inputPricePer1k: 0.007, outputPricePer1k: 0.028,
    });
    expect(d.llmModelsRepo.create).toHaveBeenCalledWith(expect.objectContaining({
      inputPricePer1k: 0.007, outputPricePer1k: 0.028,
    }));
  });

  it('create 不给单价 -> 记 0（不是 undefined）', async () => {
    const d = mk();
    await svc(d).create({ modelKey: 'm8', name: 'M8', providerType: 'kimi', modelId: 'm8', baseUrl: 'https://x', apiKey: 'sk-1' });
    expect(d.llmModelsRepo.create).toHaveBeenCalledWith(expect.objectContaining({
      inputPricePer1k: 0, outputPricePer1k: 0,
    }));
  });

  it('update 透传单价并触发 registry.reload', async () => {
    const d = mk({ llmModelsRepo: { ...mk().llmModelsRepo, findByKey: vi.fn().mockResolvedValue(dbModel('m1')) } });
    await svc(d).update('m1', { inputPricePer1k: 0.02 });
    expect(d.llmModelsRepo.update).toHaveBeenCalledWith('m1', { inputPricePer1k: 0.02 });
    expect(d.registry.reload).toHaveBeenCalled();
  });
```

同时更新该文件的固定装置 `dbModel`（`admin-models.service.test.ts:15`），补两个字段以免 tsc 报错：

```ts
const dbModel = (key: string) => ({ modelKey: key, name: key, providerType: 'kimi', modelId: key, baseUrl: 'https://x', apiKey: 'sk-secret123', contextWindow: 8, maxOutputTokens: 8, isEnabled: true, inputPricePer1k: 0, outputPricePer1k: 0 });
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/server && npx vitest run src/modules/admin/admin-models.service.test.ts
```
Expected: FAIL —— `create` 收到的对象不含 `inputPricePer1k`。

- [ ] **Step 3: 实现 service**

修改 `apps/server/src/modules/admin/admin-models.service.ts` 的 `create` 与 `update`（替换 `admin-models.service.ts:32-55`）：

```ts
  async create(dto: { modelKey: string; name: string; providerType: string; modelId: string; baseUrl: string; apiKey: string; contextWindow?: number; maxOutputTokens?: number; inputPricePer1k?: number; outputPricePer1k?: number }) {
    if (!(PROVIDER_TYPES as readonly string[]).includes(dto.providerType)) {
      throw new ConflictException({ code: 1001, message: '供应商类型不合法' });
    }
    if (await this.llmModelsRepo.findByKey(dto.modelKey)) {
      throw new ConflictException({ code: 1004, message: 'model_key 已存在' });
    }
    await this.llmModelsRepo.create({
      modelKey: dto.modelKey, name: dto.name, providerType: dto.providerType, modelId: dto.modelId,
      baseUrl: dto.baseUrl, apiKey: dto.apiKey,
      contextWindow: dto.contextWindow ?? 131072, maxOutputTokens: dto.maxOutputTokens ?? 16384,
      // 单价缺省写 0（= 免费），不是 undefined：llm_models 两列 NOT NULL DEFAULT 0，
      // 传 undefined 会让 INSERT 显式写 NULL 而报错。
      inputPricePer1k: dto.inputPricePer1k ?? 0,
      outputPricePer1k: dto.outputPricePer1k ?? 0,
    });
    await this.registry.reload();
  }

  async update(modelKey: string, dto: Partial<{ name: string; providerType: string; modelId: string; baseUrl: string; apiKey: string; contextWindow: number; maxOutputTokens: number; inputPricePer1k: number; outputPricePer1k: number }>) {
    if (!(await this.llmModelsRepo.findByKey(modelKey))) {
      throw new NotFoundException({ code: 1002, message: '模型不存在' });
    }
    const { apiKey, ...rest } = dto;
    const patch = apiKey === '' ? rest : dto; // 空串=不改 key
    await this.llmModelsRepo.update(modelKey, patch);
    await this.registry.reload();
  }
```

- [ ] **Step 4: 实现 controller 校验**

修改 `apps/server/src/modules/admin/admin.controller.ts` 的 `ModelSchema`（`admin.controller.ts:15-24`）——价格**允许 0**，用 `nonnegative()`：

```ts
const ModelSchema = z.object({
  modelKey: z.string().min(2).max(50).regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().min(1).max(100),
  providerType: z.enum(['kimi', 'qwen', 'deepseek', 'gemini', 'openai_compatible', 'local']),
  modelId: z.string().min(1).max(100),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1).max(400),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  // 每 1K token 单价；0 合法（本地模型免费），因此用 nonnegative 而非 positive
  inputPricePer1k: z.number().nonnegative().max(1000).optional(),
  outputPricePer1k: z.number().nonnegative().max(1000).optional(),
});
```
`ModelUpdateSchema` 由 `ModelSchema.partial()` 派生（`admin.controller.ts:26`），**不用改**。

- [ ] **Step 5: 消除 admin-chat 硬编码**

`admin-chat.service.ts:84` 的硬编码就在私有方法 `toModelConfig(m: LlmModel)` 里（`:77-88`），而它拿到的正是**带价格列的 DB `LlmModel`**（`requireEnabledModel()` 走 `modelsRepo.listEnabled()`，`:69-74`）。所以直接替换那一行：

```ts
      // 单价从 DB 行取。旧代码写死 {0,0}，导致管理员自己对话的成本永远算不出来，
      // 进 llm_call_logs 后同样失真。
      costPer1K: { input: m.inputPricePer1k, output: m.outputPricePer1k },
```

**判断标准**：改完 `toModelConfig` 里不再出现字面量 `0`。`ModelConfigRegistry.reload()` 的同类映射（Task 3 已改）与这里保持一致——两处都从 `llm_models` 价格列来。

- [ ] **Step 6: 跑测试 + 类型检查**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/server && npx vitest run src/modules/admin/ && npx tsc --noEmit
```
Expected: 全部 PASS；tsc 无错误。

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/modules/admin/admin-models.service.ts apps/server/src/modules/admin/admin-models.service.test.ts apps/server/src/modules/admin/admin.controller.ts apps/server/src/modules/admin/admin-chat.service.ts
git commit -m "feat(admin): 模型单价增改接口 + 消除 admin-chat 的 costPer1K 硬编码 0"
```

---

### Task 5: 管理端前端——价格输入

**Files:**
- Modify: `apps/web/src/services/api.ts:731-741`
- Modify: `apps/web/src/pages/admin/AdminModelsPage.tsx`
- Test: `apps/web/src/pages/admin/AdminModelsPage.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 4 的端点字段 `inputPricePer1k` / `outputPricePer1k`
- Produces: 无（终端 UI）

- [ ] **Step 1: 扩展 API 层**

修改 `apps/web/src/services/api.ts`（`api.ts:731-741`）：**保留现有字段**，`AdminModelItem` 追加：

```ts
  /** 每 1K 输入 token 单价（与模型供应商计价单位一致） */
  inputPricePer1k: number;
  /** 每 1K 输出 token 单价 */
  outputPricePer1k: number;
```
`createAdminModel` 参数类型追加 `inputPricePer1k?: number; outputPricePer1k?: number`；`updateAdminModel` 的 `Partial<{...}>` 里追加 `inputPricePer1k: number; outputPricePer1k: number`。

- [ ] **Step 2: 写失败测试**

Create `apps/web/src/pages/admin/AdminModelsPage.test.tsx`：

```tsx
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import AdminModelsPage from './AdminModelsPage';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    listAdminModels: vi.fn().mockResolvedValue([{
      modelKey: 'kimi', name: 'Kimi', providerType: 'kimi', modelId: 'kimi-latest',
      baseUrl: 'https://x', apiKeyMasked: 'sk-***123', contextWindow: 131072,
      maxOutputTokens: 16384, isEnabled: true, inputPricePer1k: 0.012, outputPricePer1k: 0.028,
    }]),
    listAdminRoutes: vi.fn().mockResolvedValue({ routes: [], scenes: [], providerTypes: [] }),
  };
});

describe('AdminModelsPage 单价展示', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => cleanup()); // globals:false，必须自己 cleanup

  it('列表显示每个模型的输入/输出单价', async () => {
    render(<AdminModelsPage />);
    expect(await screen.findByText(/输入单价/)).toBeTruthy();
    expect(screen.getByText(/输出单价/)).toBeTruthy();
    // 数值渲染（0.012 / 0.028），证明读的是接口返回值
    expect(screen.getAllByText('0.012').length).toBeGreaterThan(0);
    expect(screen.getAllByText('0.028').length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/web && npx vitest run src/pages/admin/AdminModelsPage.test.tsx
```
Expected: FAIL —— 找不到 `输入单价`（页面上还没有这两列）。

- [ ] **Step 4: 实现页面改动**

修改 `apps/web/src/pages/admin/AdminModelsPage.tsx`，五处改动：

**4a.** `ModelFormState` 加两个字段，`emptyModelForm` 加两个空串（`AdminModelsPage.tsx:18-38`）：
```ts
  inputPricePer1k: string;
  outputPricePer1k: string;
```
```ts
  inputPricePer1k: '',
  outputPricePer1k: '',
```

**4b.** 编辑时回填（`AdminModelsPage.tsx:112-121` 的 `setForm({...})` 内，紧跟 `maxOutputTokens` 之后）：
```ts
      inputPricePer1k: m.inputPricePer1k ? String(m.inputPricePer1k) : '',
      outputPricePer1k: m.outputPricePer1k ? String(m.outputPricePer1k) : '',
```

**4c.** 提交时带上：`handleCreateModel` 的 `createAdminModel({...})` 内、`maxOutputTokens` 之后加：
```ts
        ...(form.inputPricePer1k ? { inputPricePer1k: Number(form.inputPricePer1k) } : {}),
        ...(form.outputPricePer1k ? { outputPricePer1k: Number(form.outputPricePer1k) } : {}),
```
`handleUpdateModel` 的 `updateAdminModel(...)` 内**同样加这两行**。

**4d.** 表单加两个输入框：在 `AdminModelsPage.tsx:529-554` 那个 grid（上下文窗口 / 最大输出）之后新增同构 grid：
```tsx
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold mb-1.5" style={{ color: 'var(--text-secondary)' }}>输入单价（每 1K token）</label>
              <input
                type="number"
                step="0.0001"
                value={form.inputPricePer1k}
                onChange={(e) => setForm({ ...form, inputPricePer1k: e.target.value })}
                placeholder="如：0.012（本地模型填 0）"
                min={0}
                className={fieldCls}
              />
            </div>
            <div>
              <label className="block text-xs font-bold mb-1.5" style={{ color: 'var(--text-secondary)' }}>输出单价（每 1K token）</label>
              <input
                type="number"
                step="0.0001"
                value={form.outputPricePer1k}
                onChange={(e) => setForm({ ...form, outputPricePer1k: e.target.value })}
                placeholder="如：0.028"
                min={0}
                className={fieldCls}
              />
            </div>
          </div>
```
**两个输入都不要加 `disabled={modalMode === 'edit'}`**——改价是常态操作，这与上面 `contextWindow` / `maxOutputTokens` 有意不同。

**4e.** 列表加两列：`AdminModelsPage.tsx:287` 的 `<th>apiKey</th>` 之后追加：
```tsx
                <th className="px-5 py-3 font-semibold">输入单价</th>
                <th className="px-5 py-3 font-semibold">输出单价</th>
```
`AdminModelsPage.tsx:300` 对应 `<td>` 之后追加：
```tsx
                  <td className="px-5 py-3">{m.inputPricePer1k}</td>
                  <td className="px-5 py-3">{m.outputPricePer1k}</td>
```

- [ ] **Step 5: 跑测试确认通过 + 前端全量回归**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/web && npx vitest run src/pages/admin/AdminModelsPage.test.tsx && npm test 2>&1 | tail -15
```
Expected: 新文件 1 passed；全量此前 573，现在应为 574 通过。
⚠️ **若在 18:00–06:00 跑**，`routes/routeTable.test.tsx` 会多 1 条红（`StudentLayout` 挂载时按挂钟切 `data-theme`）——那是**既有问题、与本批无关**，别算到这次改动头上。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/services/api.ts apps/web/src/pages/admin/AdminModelsPage.tsx apps/web/src/pages/admin/AdminModelsPage.test.tsx
git commit -m "feat(admin-ui): 模型表单与列表展示输入/输出单价（编辑态可改）"
```

---

### Task 6: usage 采集修复——token 不再恒为 0

**Files:**
- Create: `apps/server/src/ai-core/infra/usage-estimate.ts`
- Create: `apps/server/src/ai-core/infra/usage-estimate.test.ts`
- Modify: `apps/server/src/ai-core/types.ts:144-158`（`ChatResponse.usage` + `StreamChunk.usage`）
- Modify: `apps/server/src/ai-core/infra/model-client/openai-compatible-client.ts:15-36, 88-92, 195-205`
- Modify: `apps/server/src/ai-core/infra/model-client/local-client.ts:28-32`
- Modify: `apps/server/src/ai-core/infra/model-client/index.ts:82-102`
- Modify: `apps/server/src/ai-core/infra/model-client/gemini-client.ts:70-84`

**Interfaces:**
- Consumes: 无（与 Task 2/3 独立）
- Produces: `UsageSource`；`ChatResponse.usage: { inputTokens: number | null; outputTokens: number | null; cost: number | null; source?: UsageSource }`；`StreamChunk.usage?`；`estimateTokens(text: string): number`（Task 7、8 依赖）

- [ ] **Step 1: 写估算函数的失败测试**

Create `apps/server/src/ai-core/infra/usage-estimate.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { estimateTokens } from './usage-estimate';

describe('estimateTokens（流式拿不到 usage 时的兜底）', () => {
  it('纯中文按 1 字 = 1 token', () => {
    expect(estimateTokens('你好世界')).toBe(4);
  });

  it('纯拉丁按 4 字符 = 1 token，向上取整', () => {
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('中英混合分别计数后相加', () => {
    // 3 个中文 = 3；'abcdefgh' = 2 => 5
    expect(estimateTokens('你好吗abcdefgh')).toBe(5);
  });

  it('空白与空串为 0', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('   ')).toBe(0);
  });

  it('半角标点算作拉丁字符（去空格后 12 字符 → ceil(12/4)=3）', () => {
    expect(estimateTokens('hello, world!')).toBe(3);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/server && npx vitest run src/ai-core/infra/usage-estimate.test.ts
```
Expected: FAIL —— `Failed to resolve import "./usage-estimate"`。

- [ ] **Step 3: 实现估算函数**

Create `apps/server/src/ai-core/infra/usage-estimate.ts`：

```ts
/**
 * 流式调用的 token 估算兜底。
 *
 * 为什么需要：`ModelClient.chat()` 默认走流式（model-client/index.ts:64），而多数
 * OpenAI 兼容端点的流式响应默认**不带 usage**（Kimi 明确不带，见同文件 :79 的注释）。
 * 不估算的话 token 恒为 0、成本恒为 0，成本面板全空。
 *
 * 口径（**唯一实现处**，改动只改这里）：
 *   - CJK 文字与全角标点：约 1 字 = 1 token
 *   - 其余（拉丁字母/数字/半角标点）：约 4 字符 = 1 token，向上取整
 * 这是**估算**，调用方必须把 usage_source 标成 'estimated' 让上层能区分。
 */
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK)?.length ?? 0;
  const rest = text.replace(CJK, '');
  const latin = rest.replace(/\s/g, '').length;
  return cjk + Math.ceil(latin / 4);
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/server && npx vitest run src/ai-core/infra/usage-estimate.test.ts
```
Expected: 5 passed。
（这 5 个期望值已用 node 实测确认：`'你好世界'`→4、`'abcdefgh'`→2、`'abcde'`→2、`'你好吗abcdefgh'`→5、`'hello, world!'`→3、空白/空串→0。）

- [ ] **Step 5: 扩类型**

修改 `apps/server/src/ai-core/types.ts`。在 `ChatResponse` 之前加：

```ts
/** usage 的来源：provider=端点回了真值；estimated=估算兜底；unavailable=完全拿不到 */
export type UsageSource = 'provider' | 'estimated' | 'unavailable';
```

替换 `ChatResponse`（`types.ts:144-152`）：

```ts
export interface ChatResponse {
  id: string;
  model: string;
  content: string;
  reasoningContent?: string;          // thinking 内容(reasoner 模型的 reasoning_content 聚合)
  finishReason: 'stop' | 'length' | 'content_filter' | 'error';
  /**
   * token 与成本。**NULL = 算不出，绝不是 0**（0 只代表真免费，如本地模型）——
   * 与家长端 answered=0 → rate=null 同一纪律。source 缺省视为 'unavailable'。
   */
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    cost: number | null;
    source?: UsageSource;
  };
  latencyMs: number;
}
```

替换 `StreamChunk`（`types.ts:154-158`）：

```ts
export interface StreamChunk {
  content: string;
  reasoningContent?: string;          // 增量 thinking delta(reasoning_content)
  finishReason?: 'stop' | 'length' | 'content_filter' | 'error';
  /** 仅在端点回传 usage 时出现（openai 兼容端点开了 include_usage 会放最后一个 chunk） */
  usage?: { inputTokens: number; outputTokens: number };
}
```

- [ ] **Step 6: 修请求体与本地端点例外**

**6a.** `openai-compatible-client.ts` 的 `buildRequestBody`（`openai-compatible-client.ts:23-27`）：

```ts
    if (stream) {
      body.stream = true;
      // 让端点把 usage 放进最后一个 chunk（OpenAI 扩展）。没有它，流式路径
      // 永远拿不到 token —— 生产 100% 走流式，成本就永远算不出。
      body.stream_options = { include_usage: true };
    } else {
      body.stop = request.stopSequences;
    }
```

**6b.** `local-client.ts` 的 `buildRequestBody`（`local-client.ts:28-32`）：

```ts
  protected buildRequestBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const body = super.buildRequestBody(request, stream);
    delete body.enable_thinking;
    // llama.cpp 不认 OpenAI 的 stream_options（可能直接 400），本地端点也不计费，
    // 删掉后走估算兜底即可。
    delete body.stream_options;
    return body;
  }
```

**6c.** `openai-compatible-client.ts:88-92` 的非流式 usage —— 端点没回 usage 时**不再写 0**：

```ts
      usage: data.usage
        ? {
            inputTokens: data.usage.prompt_tokens ?? null,
            outputTokens: data.usage.completion_tokens ?? null,
            cost: this.calculateCost(data.usage.prompt_tokens ?? 0, data.usage.completion_tokens ?? 0, request.model.costPer1K),
            source: 'provider' as const,
          }
        : { inputTokens: null, outputTokens: null, cost: null, source: 'unavailable' as const },
```

**6d.** 流式透出 usage：在 `openai-compatible-client.ts` 的 `streamChat` 解析循环内，紧跟 `finish_reason` 的 yield 之后（约 `:203-205`）追加：

```ts
            if (parsed.usage) {
              yield {
                content: '',
                usage: {
                  inputTokens: parsed.usage.prompt_tokens ?? 0,
                  outputTokens: parsed.usage.completion_tokens ?? 0,
                },
              };
            }
```

**6e.** `gemini-client.ts:70-84` 的 usage 对象补 `source: 'provider' as const`（数值语义不变）。

- [ ] **Step 7: 先写估算档的失败测试**

输入与输出是**两个独立的量**，各有自己的数据源——输入估自 `request.messages`，输出估自响应正文。不要用「一个 estimated 就一起含糊过去」的写法。

在 `apps/server/src/ai-core/infra/model-client/model-client.test.ts` 追加：

```ts
describe('流式拿不到 usage 时的估算（输入/输出各自的数据源）', () => {
  it('输入估自请求 messages，输出估自响应正文', async () => {
    const providers = new Map([
      ['kimi', {
        chat: vi.fn(),
        streamChat: async function* () {
          yield { content: '你好世界' };      // 输出 4 token
        },
      }],
    ]);
    const mc = new ModelClient({ providers } as any);
    const res = await mc.chat({
      model: {
        provider: 'kimi', modelId: 'kimi-latest', baseUrl: 'https://x', contextWindow: 8,
        maxOutputTokens: 8, supportsStreaming: true, costPer1K: { input: 0.01, output: 0.02 },
      } as any,
      messages: [{ role: 'user', content: 'abcdefgh' }],   // 输入 2 token
      stream: true,
    });
    expect(res.usage.source).toBe('estimated');
    expect(res.usage.inputTokens).toBe(2);    // 来自请求
    expect(res.usage.outputTokens).toBe(4);   // 来自响应
    // cost 按两段分别计价：2/1000*0.01 + 4/1000*0.02 = 0.00002 + 0.00008
    expect(res.usage.cost).toBeCloseTo(0.0001, 8);
  });

  it('请求与响应都为空 -> unavailable，token/cost 全 NULL（不写 0）', async () => {
    const providers = new Map([
      ['kimi', { chat: vi.fn(), streamChat: async function* () { /* 什么都不 yield */ } }],
    ]);
    const mc = new ModelClient({ providers } as any);
    const res = await mc.chat({
      model: {
        provider: 'kimi', modelId: 'kimi-latest', baseUrl: 'https://x', contextWindow: 8,
        maxOutputTokens: 8, supportsStreaming: true, costPer1K: { input: 0.01, output: 0.02 },
      } as any,
      messages: [],
      stream: true,
    });
    expect(res.usage.source).toBe('unavailable');
    expect(res.usage.inputTokens).toBeNull();
    expect(res.usage.outputTokens).toBeNull();
    expect(res.usage.cost).toBeNull();
  });
});
```

- [ ] **Step 8: 跑测试确认失败**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/server && npx vitest run src/ai-core/infra/model-client/model-client.test.ts
```
Expected: FAIL —— `res.usage.source` 是 `undefined`（旧代码返回 `{inputTokens:0,outputTokens:0,cost:0}`，没有 source），`inputTokens` 是 0 而非 2。

- [ ] **Step 9: 实现流式聚合（本任务核心）**

替换 `apps/server/src/ai-core/infra/model-client/index.ts:82-102` 的 `aggregateStream`，并在类外（文件靠上、`ModelClient` 定义之前）加两个辅助函数：

```ts
/**
 * 估算**请求侧**的输入 token。输入与输出相互独立，各用自己的数据源：
 * 输入 = request.messages 的文本，输出 = 响应正文（见 buildStreamUsage）。
 * 用 contentToText 兼容多模态消息（ContentPart[] 只取 text 部分）。
 */
function estimateInputTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(contentToText(m.content)), 0);
}

/**
 * 流式 usage 的三级降级：
 *   1) 端点回了 usage -> provider，按真值算钱
 *   2) 拿不到 -> 输入/输出**分别估算** -> estimated（两段都来自估算，故共用一个来源标签；
 *      端点要么两段都给、要么都不给，不存在只估一段的情况）
 *   3) 请求与响应都为空 -> unavailable，token/cost 写 NULL（**不写 0**）
 */
function buildStreamUsage(
  providerUsage: { inputTokens: number; outputTokens: number } | null,
  estimatedInputTokens: number,
  content: string,
  reasoningContent: string,
  costPer1K: { input: number; output: number },
): ChatResponse['usage'] {
  if (providerUsage) {
    const { inputTokens, outputTokens } = providerUsage;
    return {
      inputTokens,
      outputTokens,
      cost: (inputTokens / 1000) * costPer1K.input + (outputTokens / 1000) * costPer1K.output,
      source: 'provider',
    };
  }
  const inputTokens = estimatedInputTokens;
  const outputTokens = estimateTokens(content) + estimateTokens(reasoningContent);
  if (inputTokens === 0 && outputTokens === 0) {
    return { inputTokens: null, outputTokens: null, cost: null, source: 'unavailable' };
  }
  return {
    inputTokens,
    outputTokens,
    cost: (inputTokens / 1000) * costPer1K.input + (outputTokens / 1000) * costPer1K.output,
    source: 'estimated',
  };
}
```

`aggregateStream` 改为：

```ts
  private async aggregateStream(provider: ProviderAdapter, request: ChatRequest, startTime: number): Promise<ChatResponse> {
    let content = '';
    let reasoningContent = '';
    let finishReason: ChatResponse['finishReason'] = 'stop';
    // 端点在最后一个 chunk 里回传的 usage（需 stream_options.include_usage）
    let providerUsage: { inputTokens: number; outputTokens: number } | null = null;

    for await (const chunk of provider.streamChat(request)) {
      if (chunk.reasoningContent) reasoningContent += chunk.reasoningContent;
      if (chunk.content) content += chunk.content;
      if (chunk.finishReason) finishReason = chunk.finishReason;
      if (chunk.usage) providerUsage = chunk.usage;
    }

    return {
      id: `stream_${Date.now()}`,
      model: request.model.modelId,
      content,
      reasoningContent: reasoningContent || undefined,
      finishReason,
      usage: buildStreamUsage(
        providerUsage,
        estimateInputTokens(request.messages),
        content,
        reasoningContent,
        request.model.costPer1K,
      ),
      latencyMs: Date.now() - startTime,
    };
  }
```

同文件顶部 import 追加：`estimateTokens`（来自 `../usage-estimate.js`），并把 `ChatMessage`、`contentToText` 加进 `../../types.js` 的 import（`contentToText` 是**值**不是类型，不能放 `import type` 里）。

- [ ] **Step 10: 跑测试确认通过 + 类型检查 + 全量回归**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/server && npx vitest run src/ai-core/ && npx tsc --noEmit && npm test 2>&1 | tail -6
```
Expected: 全绿（含 Step 7 新加的两条）；tsc 无错误。
**注意**：能力测试里大量固定装置写了 `usage: { inputTokens: 10, outputTokens: 5, cost: 0 }`（如 `grading.capability.test.ts:52`）——`source` 是可选的，**这些文件不需要改**。若 tsc 报 usage 相关错误，说明我把某字段写成了必填，回去检查。

- [ ] **Step 11: Commit**

```bash
git add apps/server/src/ai-core/infra/usage-estimate.ts apps/server/src/ai-core/infra/usage-estimate.test.ts apps/server/src/ai-core/types.ts apps/server/src/ai-core/infra/model-client/
git commit -m "fix(ai-core): 流式 usage 三级降级——输入/输出分别估算，token 不再恒为 0"
```

---

### Task 7: 账本仓储 + `TelemetryBuffer` + sink 类型

**Files:**
- Create: `apps/server/src/ai-core/infra/llm-call-log.ts`（**只建类型与 sink，不接线**）
- Create: `apps/server/src/database/repositories/llm-call-logs.repo.ts`
- Create: `apps/server/src/database/repositories/api-request-logs.repo.ts`
- Create: `apps/server/src/database/repositories/analytics-logs.repo.test.ts`
- Create: `apps/server/src/modules/analytics/telemetry-buffer.ts`
- Create: `apps/server/src/modules/analytics/telemetry-buffer.test.ts`
- Modify: `apps/server/src/database/repositories/index.ts`

**Interfaces:**
- Consumes: Task 1 的两张表；Task 6 的 `UsageSource`
- Produces:
  - `LlmCallLogEntry`、`setLlmCallSink`、`emitLlmCall`（Task 8、9 用）
  - `ApiRequestLogEntry`（Task 9 用）
  - `LlmCallLogsRepository.insertMany(rows)`、`ApiRequestLogsRepository.insertMany(rows)`（Task 9 用）
  - `TelemetryBuffer<T>`：`push` / `flushNow` / `start` / `stop` / `size` / `dropped` / `failed`（Task 9 用）

- [ ] **Step 1: 定义 sink 类型**

Create `apps/server/src/ai-core/infra/llm-call-log.ts`：

```ts
import type { UsageSource } from '../types.js';

/**
 * 一次 LLM 调用的账本条目。**每次逻辑调用一行，每次重试尝试各一行**（attempt 递增）。
 *
 * 为什么放 ai-core：`ModelClient` 是全部 14 个 capability 的唯一出口，在这里埋点
 * 才能既不漏又不改 capability。但这个文件**不能依赖 Nest DI**（capability 是零参
 * `new` 出来的，见 CLAUDE.md 的 DI 坑），所以用**模块级 sink 单例**——由
 * AnalyticsModule 在启动时把「推入 TelemetryBuffer」的函数注册进来。
 */
export interface LlmCallLogEntry {
  requestId: string | null;
  studentId: number | null;
  dialogueId: number | null;
  scene: string | null;
  subject: string | null;
  capability: string | null;
  modelKey: string | null;
  modelId: string | null;
  provider: string;
  attempt: number;
  requestKind: 'chat' | 'stream';
  isFallback: boolean;
  success: boolean;
  errorType: string | null;
  httpStatus: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  usageSource: UsageSource;
  inputPricePer1k: number | null;
  outputPricePer1k: number | null;
  /** NULL = 算不出，绝不写 0 */
  cost: number | null;
  latencyMs: number;
}

export type LlmCallSink = (entry: LlmCallLogEntry) => void;

let sink: LlmCallSink | null = null;

export function setLlmCallSink(next: LlmCallSink | null): void {
  sink = next;
}

/** 记账永不抛：埋点坏了也不能让一次 LLM 调用失败。 */
export function emitLlmCall(entry: LlmCallLogEntry): void {
  if (!sink) return;
  try {
    sink(entry);
  } catch {
    /* 记账失败只吞掉，不冒泡 */
  }
}
```

- [ ] **Step 2: 写两个 repo 的失败测试**

Create `apps/server/src/database/repositories/analytics-logs.repo.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { LlmCallLogsRepository } from './llm-call-logs.repo';
import { ApiRequestLogsRepository } from './api-request-logs.repo';

const mockPool = () => ({
  execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]),
  query: vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]),
});

const entry = () => ({
  requestId: 'r1', studentId: 9, dialogueId: 3, scene: 'judgment', subject: 'math',
  capability: 'judgment', modelKey: 'local', modelId: 'Qwen3.8-27B', provider: 'local',
  attempt: 1, requestKind: 'chat' as const, isFallback: false, success: true,
  errorType: null, httpStatus: null, inputTokens: 120, outputTokens: 8,
  usageSource: 'provider' as const, inputPricePer1k: 0, outputPricePer1k: 0,
  cost: 0, latencyMs: 1180,
});

describe('LlmCallLogsRepository.insertMany', () => {
  it('多行 INSERT 走 pool.query（占位符数量动态，不能用 execute）', async () => {
    const pool = mockPool();
    await new LlmCallLogsRepository(pool as any).insertMany([entry(), entry()]);
    expect(pool.execute).not.toHaveBeenCalled();
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO llm_call_logs');
    expect(sql).toContain('student_id');
    expect(params).toHaveLength(44); // 2 行 × 22 列（列数见实现 COLUMNS）
    expect(params[0]).toBe('r1');
  });

  it('空数组直接 return，不发 SQL', async () => {
    const pool = mockPool();
    await new LlmCallLogsRepository(pool as any).insertMany([]);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('cost 为 null 时原样写 null（不洗成 0）', async () => {
    const pool = mockPool();
    await new LlmCallLogsRepository(pool as any).insertMany([
      { ...entry(), cost: null, usageSource: 'unavailable', inputTokens: null, outputTokens: null },
    ]);
    const [, params] = pool.query.mock.calls[0];
    // cost 在 COLUMNS 里的下标（0-based）——以实现为准
    const costIdx = 20;
    expect(params[costIdx]).toBeNull();
    expect(params[params.length - 1]).toBe(1180); // latency_ms 是最后一列
  });

  it('isFallback / success 布尔转 0|1', async () => {
    const pool = mockPool();
    await new LlmCallLogsRepository(pool as any).insertMany([{ ...entry(), isFallback: true, success: false }]);
    const [, params] = pool.query.mock.calls[0];
    expect(params[11]).toBe(1); // is_fallback
    expect(params[12]).toBe(0); // success
  });
});

describe('ApiRequestLogsRepository.insertMany', () => {
  it('落一条请求日志，含归一化 route 与 is_sse', async () => {
    const pool = mockPool();
    await new ApiRequestLogsRepository(pool as any).insertMany([{
      requestId: 'r1', actorRole: 'student', studentId: 9, method: 'POST',
      route: '/api/practice/:cardId/judge', rawPath: '/api/practice/12/judge',
      module: 'practice', statusCode: 201, bizCode: 0, errorCode: null,
      latencyMs: 1500, isSse: false,
    }]);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO api_request_logs');
    expect(params).toEqual(['r1', 'student', 9, 'POST', '/api/practice/:cardId/judge', '/api/practice/12/judge', 'practice', 201, 0, null, 1500, 0]);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/server && npx vitest run src/database/repositories/analytics-logs.repo.test.ts
```
Expected: FAIL —— 无法解析 `./llm-call-logs.repo`。

- [ ] **Step 4: 实现两个 repo**

Create `apps/server/src/database/repositories/llm-call-logs.repo.ts`：

```ts
import { Injectable, Inject } from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import type { LlmCallLogEntry } from '../../ai-core/infra/llm-call-log.js';

/** 列顺序即 INSERT 的参数顺序；改列序必须同步改 COLUMNS 常量与测试里的下标断言 */
const COLUMNS = [
  'request_id', 'student_id', 'dialogue_id', 'scene', 'subject', 'capability',
  'model_key', 'model_id', 'provider', 'attempt', 'request_kind', 'is_fallback',
  'success', 'error_type', 'http_status', 'input_tokens', 'output_tokens',
  'usage_source', 'input_price_per_1k', 'output_price_per_1k', 'cost', 'latency_ms',
] as const;

@Injectable()
export class LlmCallLogsRepository {
  constructor(@Inject('DATABASE_POOL') private pool: Pool) {}

  /**
   * 批量落账本。必须走 pool.query 而非 execute：占位符数量随行数变化，
   * 预处理语句不能这样拼（与 point-ledger.repo 的 LIMIT ? 同一个坑）。
   */
  async insertMany(entries: LlmCallLogEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const placeholders = entries.map(() => `(${COLUMNS.map(() => '?').join(', ')})`).join(', ');
    const args = entries.flatMap((e) => [
      e.requestId, e.studentId, e.dialogueId, e.scene, e.subject, e.capability,
      e.modelKey, e.modelId, e.provider, e.attempt, e.requestKind, e.isFallback ? 1 : 0,
      e.success ? 1 : 0, e.errorType, e.httpStatus, e.inputTokens, e.outputTokens,
      e.usageSource, e.inputPricePer1k, e.outputPricePer1k, e.cost, e.latencyMs,
    ]);
    await this.pool.query(
      `INSERT INTO llm_call_logs (${COLUMNS.join(', ')}) VALUES ${placeholders}`,
      args,
    );
  }
}
```

Create `apps/server/src/database/repositories/api-request-logs.repo.ts`：

```ts
import { Injectable, Inject } from '@nestjs/common';
import type { Pool } from 'mysql2/promise';

export interface ApiRequestLogEntry {
  requestId: string | null;
  actorRole: string | null;
  studentId: number | null;
  method: string;
  /** 归一化模板，如 /api/practice/:cardId/judge */
  route: string;
  rawPath: string;
  module: string | null;
  statusCode: number;
  bizCode: number | null;
  errorCode: string | null;
  latencyMs: number;
  isSse: boolean;
}

const COLUMNS = [
  'request_id', 'actor_role', 'student_id', 'method', 'route', 'raw_path',
  'module', 'status_code', 'biz_code', 'error_code', 'latency_ms', 'is_sse',
] as const;

@Injectable()
export class ApiRequestLogsRepository {
  constructor(@Inject('DATABASE_POOL') private pool: Pool) {}

  async insertMany(entries: ApiRequestLogEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const placeholders = entries.map(() => `(${COLUMNS.map(() => '?').join(', ')})`).join(', ');
    const args = entries.flatMap((e) => [
      e.requestId, e.actorRole, e.studentId, e.method, e.route, e.rawPath,
      e.module, e.statusCode, e.bizCode, e.errorCode, e.latencyMs, e.isSse ? 1 : 0,
    ]);
    await this.pool.query(
      `INSERT INTO api_request_logs (${COLUMNS.join(', ')}) VALUES ${placeholders}`,
      args,
    );
  }
}
```

- [ ] **Step 5: 跑 repo 测试确认通过**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/server && npx vitest run src/database/repositories/analytics-logs.repo.test.ts
```
Expected: PASS。列下标由 `COLUMNS` 常量决定，当前顺序下为：`is_fallback`=11、`success`=12、`cost`=20，共 22 列（2 行 → 44 个参数）。**若日后调整 `COLUMNS` 顺序，这些下标断言与 `toHaveLength(44)` 必须一起改。**

- [ ] **Step 6: 写 buffer 的失败测试**

Create `apps/server/src/modules/analytics/telemetry-buffer.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TelemetryBuffer } from './telemetry-buffer';

describe('TelemetryBuffer', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const mk = (flush = vi.fn().mockResolvedValue(undefined)) => ({
    flush,
    buf: new TelemetryBuffer<{ n: number }>(flush, { name: 't', maxEntries: 3, flushIntervalMs: 1000, flushAt: 2 }),
  });

  it('达到 flushAt 立即 flush', async () => {
    const { flush, buf } = mk();
    buf.push({ n: 1 });
    expect(flush).not.toHaveBeenCalled();
    buf.push({ n: 2 });
    await vi.waitFor(() => expect(flush).toHaveBeenCalledWith([{ n: 1 }, { n: 2 }]));
  });

  it('定时到点 flush 未满的批次', async () => {
    const { flush, buf } = mk();
    buf.start();
    buf.push({ n: 1 });
    vi.advanceTimersByTime(1000);
    await vi.waitFor(() => expect(flush).toHaveBeenCalledWith([{ n: 1 }]));
    buf.stop();
  });

  it('超过 maxEntries 丢最旧并计数 dropped，保留最新', async () => {
    // 用 flushAt:100 让 flush 不介入，才能确定性地观察丢弃行为
    const flush = vi.fn().mockResolvedValue(undefined);
    const buf = new TelemetryBuffer<{ n: number }>(flush, { name: 't', maxEntries: 3, flushIntervalMs: 1000, flushAt: 100 });
    for (let n = 1; n <= 5; n += 1) buf.push({ n });
    expect(buf.size).toBe(3);
    expect(buf.dropped).toBe(2);
    expect(flush).not.toHaveBeenCalled();   // flushAt=100 未到，不该触发
    await buf.flushNow();
    expect(flush).toHaveBeenCalledWith([{ n: 3 }, { n: 4 }, { n: 5 }]);  // 丢的是最旧的 1、2
  });

  it('flush 失败整批丢弃、不抛、不重试', async () => {
    const flush = vi.fn().mockRejectedValue(new Error('db down'));
    const buf = new TelemetryBuffer<{ n: number }>(flush, { name: 't', maxEntries: 10, flushIntervalMs: 1000, flushAt: 2 });
    buf.push({ n: 1 });
    expect(() => buf.push({ n: 2 })).not.toThrow();
    await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(1));
    expect(buf.size).toBe(0);      // 失败后缓冲已清空
    expect(buf.failed).toBe(1);
  });

  it('flushNow 空缓冲不发请求', async () => {
    const { flush, buf } = mk();
    await buf.flushNow();
    expect(flush).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 7: 跑测试确认失败**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/server && npx vitest run src/modules/analytics/telemetry-buffer.test.ts
```
Expected: FAIL —— 无法解析 `./telemetry-buffer`。

- [ ] **Step 8: 实现 buffer**

Create `apps/server/src/modules/analytics/telemetry-buffer.ts`：

```ts
/**
 * 埋点日志的内存缓冲：攒批落库，**永不阻塞、永不抛、永不重试**。
 *
 * 设计要点：
 *   - push 是同步 O(1)，只入数组；到 flushAt 条或定时到点才异步落库
 *   - 超过 maxEntries 丢**最旧**的并累加 dropped（宁可丢样本，不可把内存吃光）
 *   - flush 失败：整批丢弃 + 计数，不做重试 —— 埋点故障绝不能放大成 DB 压力
 *   - stop() 在 OnModuleDestroy 调用，兜一次最后的 flush（仍可能丢 <1 个间隔的数据）
 */
export interface TelemetryBufferOptions {
  /** 仅用于日志标识 */
  name: string;
  maxEntries?: number;
  flushIntervalMs?: number;
  /** 达到该条数立即 flush */
  flushAt?: number;
}

export class TelemetryBuffer<T> {
  private rows: T[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private flushing = false;
  private droppedCount = 0;
  private failedFlushes = 0;
  private readonly maxEntries: number;
  private readonly flushIntervalMs: number;
  private readonly flushAt: number;

  constructor(
    private readonly flushFn: (rows: T[]) => Promise<void>,
    private readonly opts: TelemetryBufferOptions,
  ) {
    this.maxEntries = opts.maxEntries ?? 5000;
    this.flushIntervalMs = opts.flushIntervalMs ?? 2000;
    this.flushAt = opts.flushAt ?? 200;
  }

  get size(): number { return this.rows.length; }
  get dropped(): number { return this.droppedCount; }
  get failed(): number { return this.failedFlushes; }

  push(row: T): void {
    if (this.rows.length >= this.maxEntries) {
      this.rows.shift();
      this.droppedCount += 1;
    }
    this.rows.push(row);
    if (this.rows.length >= this.flushAt) void this.flushNow();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.flushNow(); }, this.flushIntervalMs);
    // 别让定时器拖住进程退出
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async flushNow(): Promise<void> {
    if (this.flushing || this.rows.length === 0) return;
    this.flushing = true;
    const batch = this.rows;
    this.rows = [];
    try {
      await this.flushFn(batch);
    } catch {
      // 整批丢弃，不重试（重试会把故障放大）
      this.failedFlushes += 1;
    } finally {
      this.flushing = false;
    }
  }
}
```

- [ ] **Step 9: 导出 repo + 跑测试**

在 `apps/server/src/database/repositories/index.ts` 末尾追加：

```ts
export { LlmCallLogsRepository } from './llm-call-logs.repo.js';
export { ApiRequestLogsRepository } from './api-request-logs.repo.js';
export type { ApiRequestLogEntry } from './api-request-logs.repo.js';
```

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/server && npx vitest run src/modules/analytics/telemetry-buffer.test.ts src/database/repositories/analytics-logs.repo.test.ts && npx tsc --noEmit
```
Expected: 全绿。

- [ ] **Step 10: Commit**

```bash
git add apps/server/src/ai-core/infra/llm-call-log.ts apps/server/src/database/repositories/llm-call-logs.repo.ts apps/server/src/database/repositories/api-request-logs.repo.ts apps/server/src/database/repositories/analytics-logs.repo.test.ts apps/server/src/database/repositories/index.ts apps/server/src/modules/analytics/
git commit -m "feat(analytics): 账本/请求日志仓储 + TelemetryBuffer（丢最旧、失败静默不重试）"
```

---

### Task 8: 账本接线——ALS 上下文 + router 打标 + `ModelClient` 记账

**Files:**
- Create: `apps/server/src/ai-core/infra/request-context.ts`
- Create: `apps/server/src/ai-core/infra/request-context.test.ts`
- Modify: `apps/server/src/ai-core/types.ts`（`RoutedModel` + `ChatRequest.meta`）
- Modify: `apps/server/src/ai-core/infra/model-router.ts:54-58`
- Modify: `apps/server/src/ai-core/infra/model-client/index.ts:61-75`
- Test: `apps/server/src/ai-core/infra/model-router.test.ts`（追加）
- Test: `apps/server/src/ai-core/infra/model-client/model-client.test.ts`（追加）

**Interfaces:**
- Consumes: Task 6 的 `usage.source`；Task 7 的 `emitLlmCall` / `LlmCallLogEntry`
- Produces: `RequestContext` / `runWithRequestContext` / `getRequestContext`（Task 9 用）；`RoutedModel` 带 `scene`/`subject`/`modelKey`/`isFallbackEntry`；`ChatRequest.meta`；效果——每次 `ModelClient.chat()` 尝试都调一次 `emitLlmCall`

- [ ] **Step 1: 写 ALS 的失败测试**

Create `apps/server/src/ai-core/infra/request-context.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { runWithRequestContext, getRequestContext } from './request-context';

describe('request-context（ALS）', () => {
  it('上下文内可读到 studentId/requestId', () => {
    runWithRequestContext({ requestId: 'r1', studentId: 9, role: 'student' }, () => {
      expect(getRequestContext()).toEqual({ requestId: 'r1', studentId: 9, role: 'student' });
    });
  });

  it('上下文外返回 null', () => {
    expect(getRequestContext()).toBeNull();
  });

  it('跨 await 保留（后台 fire-and-forget 也能归因）', async () => {
    await runWithRequestContext({ requestId: 'r2', studentId: 7, role: 'student' }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(getRequestContext()?.studentId).toBe(7);
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/server && npx vitest run src/ai-core/infra/request-context.test.ts
```
Expected: FAIL —— 无法解析 `./request-context`。

- [ ] **Step 3: 实现 ALS**

Create `apps/server/src/ai-core/infra/request-context.ts`：

```ts
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 请求级上下文，让 ai-core 深处的 `ModelClient` 能知道「这次调用来自哪个学生/哪个请求」，
 * 而不必改 14 个 capability 的签名（见 spec §6.5）。
 *
 * 放在 ai-core/infra（而非 spec 写的 modules/analytics）是**有意的**：ai-core 不能反向
 * 依赖 modules，否则形成循环依赖。
 *
 * 局限：ALS 只对「同一条 async 链」有效。HTTP 请求内 fire-and-forget 的
 * ExplanationCacheService 能拿到（Promise 链保留上下文）；若将来改成 setTimeout /
 * 队列调度，必须改传 `ChatRequest.meta.studentId` 显式归因（spec 把这条列为硬要求）。
 */
export interface RequestContext {
  requestId: string | null;
  studentId: number | null;
  role: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getRequestContext(): RequestContext | null {
  return storage.getStore() ?? null;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/server && npx vitest run src/ai-core/infra/request-context.test.ts
```
Expected: 3 passed。

- [ ] **Step 5: 扩类型与 router 打标**

**5a.** `apps/server/src/ai-core/types.ts`——替换 `types.ts:41-42`：

```ts
/**
 * 路由结果模型带 apiKey（registry 快照/新 YAML 路径不再剥离；供 ModelClient 直接取用），
 * 并带上**归因信息**——ModelClient 靠它把每次调用记进 llm_call_logs：
 * scene/subject/modelKey 由 ModelRouter 打标；isFallbackEntry 只有 fallback 条目为 true。
 */
export type RoutedModel = ModelConfig & {
  apiKey?: string;
  scene?: Scene;
  subject?: Subject;
  /** 路由条目 key（≠ modelId）。账本聚合按它，不按 modelId。 */
  modelKey?: string;
  isFallbackEntry?: boolean;
};
```

**5b.** `types.ts` 的 `ChatRequest`（`types.ts:123-142`）末尾加：

```ts
  /**
   * 归因信息（可选）。HTTP 路径不用传——走 AsyncLocalStorage 自动带出；
   * **后台路径必须显式传**（判错解析 ExplanationCacheService、会话标题生成等），
   * 否则账本里这条调用的 student_id 为 NULL，会污染「哪个学生最费 LLM」的统计。
   */
  meta?: {
    studentId?: number | null;
    scene?: Scene;
    subject?: Subject;
    dialogueId?: number | null;
    capability?: string;
  };
```

**5c.** `model-router.ts` 的 `route()`（替换 `model-router.ts:54-58` 的 return）：

```ts
    return {
      primary: { ...this.models[rule.primary], scene: request.scene, subject: request.subject, modelKey: rule.primary },
      fallback: rule.fallback
        ? { ...this.models[rule.fallback], scene: request.scene, subject: request.subject, modelKey: rule.fallback, isFallbackEntry: true }
        : undefined,
      reason,
    };
```

- [ ] **Step 6: 写 router 打标的失败测试**

在 `apps/server/src/ai-core/infra/model-router.test.ts` 追加（**若该文件已有构造方式，照它写**）：

```ts
  it('route() 给 primary/fallback 打 scene/subject/modelKey；fallback 额外带 isFallbackEntry', () => {
    const result = new ModelRouter().route({ scene: 'judgment', subject: 'math' });
    expect(result.primary.scene).toBe('judgment');
    expect(result.primary.subject).toBe('math');
    expect(result.primary.modelKey).toBeTruthy();
    expect(result.primary.isFallbackEntry).toBeUndefined();
    if (result.fallback) {
      expect(result.fallback.isFallbackEntry).toBe(true);
      expect(result.fallback.modelKey).toBeTruthy();
      expect(result.fallback.scene).toBe('judgment');
    }
  });
```

- [ ] **Step 7: 跑测试确认失败**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/server && npx vitest run src/ai-core/infra/model-router.test.ts
```
Expected: FAIL —— `result.primary.scene` 是 `undefined`。

- [ ] **Step 8: 实现 ModelClient 记账**

修改 `apps/server/src/ai-core/infra/model-client/index.ts`：

**8a.** 顶部 import 追加：
```ts
import { LLMClientError } from '../../types.js';
import { emitLlmCall } from '../llm-call-log.js';
import { getRequestContext } from '../request-context.js';
```
（`types.js` 若已 import 其它类型，合并到同一行/同一段。）

**8b.** 替换 `chat()`（`model-client/index.ts:61-75`）：

```ts
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const provider = this.getProvider(request.model.provider, request.model.apiKey);
    const startTime = Date.now();
    const useStream = request.stream !== false && request.model.provider !== 'gemini';
    // callWithRetry 会**重复调用同一个闭包**，所以闭包内自增即为 attempt（1-based）；
    // 每次尝试（含失败与最终放弃的那次）都要落一行账本。
    let attempt = 0;

    const run = async (): Promise<ChatResponse> => {
      attempt += 1;
      const attemptStart = Date.now();
      try {
        const response = useStream
          ? await this.aggregateStream(provider, request, startTime)
          : { ...(await provider.chat(request)), latencyMs: Date.now() - startTime };
        this.recordCall(request, attempt, useStream, response, Date.now() - attemptStart, null);
        return response;
      } catch (err) {
        this.recordCall(request, attempt, useStream, null, Date.now() - attemptStart, err);
        throw err;
      }
    };

    return callWithRetry(run, this.retryOptions);
  }

  /**
   * 写一条账本。**永不抛**（emitLlmCall 内部吞异常），也永不 await。
   * 归因优先级：request.meta（后台路径显式传）> model 上的 router 打标 > ALS 上下文。
   */
  private recordCall(
    request: ChatRequest,
    attempt: number,
    useStream: boolean,
    response: ChatResponse | null,
    latencyMs: number,
    err: unknown,
  ): void {
    const model = request.model as RoutedModel;
    const ctx = getRequestContext();
    const llmErr = err instanceof LLMClientError ? err : null;
    const usage = response?.usage;
    emitLlmCall({
      requestId: ctx?.requestId ?? null,
      studentId: request.meta?.studentId ?? ctx?.studentId ?? null,
      dialogueId: request.meta?.dialogueId ?? null,
      scene: request.meta?.scene ?? model.scene ?? null,
      subject: request.meta?.subject ?? model.subject ?? null,
      capability: request.meta?.capability ?? null,
      modelKey: model.modelKey ?? null,
      modelId: request.model.modelId ?? null,
      provider: request.model.provider,
      attempt,
      requestKind: useStream ? 'stream' : 'chat',
      isFallback: model.isFallbackEntry === true,
      success: response !== null,
      errorType: llmErr ? llmErr.name : err ? ((err as Error).name || 'Error') : null,
      httpStatus: llmErr ? llmErr.statusCode : null,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      usageSource: usage?.source ?? 'unavailable',
      inputPricePer1k: request.model.costPer1K?.input ?? null,
      outputPricePer1k: request.model.costPer1K?.output ?? null,
      cost: usage?.cost ?? null,
      latencyMs,
    });
  }
```

同文件补 `RoutedModel` 到类型 import：`import type { ChatRequest, ChatResponse, StreamChunk, RetryOptions, RoutedModel } from '../../types.js';`

- [ ] **Step 9: 写 ModelClient 记账的失败测试**

在 `apps/server/src/ai-core/infra/model-client/model-client.test.ts` 追加（顶部补 `afterEach` 与 `setLlmCallSink` 的 import）：

```ts
import { setLlmCallSink } from '../llm-call-log';

describe('ModelClient 写 llm_call_logs', () => {
  afterEach(() => setLlmCallSink(null));

  const baseModel = (extra: Record<string, unknown> = {}) => ({
    provider: 'kimi', modelId: 'kimi-latest', baseUrl: 'https://x', contextWindow: 8,
    maxOutputTokens: 8, supportsStreaming: true, costPer1K: { input: 0.012, output: 0.012 }, ...extra,
  });

  it('成功调用记一条：带 scene/attempt/cost，usage 来自响应', async () => {
    const entries: any[] = [];
    setLlmCallSink((e) => entries.push(e));
    const providers = new Map([
      ['kimi', {
        chat: vi.fn().mockResolvedValue({
          id: 'r1', model: 'kimi-latest', content: 'ok', finishReason: 'stop',
          usage: { inputTokens: 100, outputTokens: 20, cost: 0.0012, source: 'provider' }, latencyMs: 5,
        }),
        streamChat: async function* () {},
      }],
    ]);
    const mc = new ModelClient({ providers } as any);
    await mc.chat({
      model: baseModel({ scene: 'judgment', subject: 'math', modelKey: 'kimi' }) as any,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      meta: { studentId: 9, capability: 'judgment' },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      studentId: 9, scene: 'judgment', subject: 'math', modelKey: 'kimi', provider: 'kimi',
      attempt: 1, requestKind: 'chat', isFallback: false, success: true,
      inputTokens: 100, outputTokens: 20, usageSource: 'provider', cost: 0.0012,
    });
  });

  it('失败也记一条：success=false，cost 为 null', async () => {
    const entries: any[] = [];
    setLlmCallSink((e) => entries.push(e));
    const boom = Object.assign(new Error('nope'), { name: 'ServerError', statusCode: 500 });
    const providers = new Map([
      ['kimi', { chat: vi.fn().mockRejectedValue(boom), streamChat: async function* () {} }],
    ]);
    const mc = new ModelClient({ providers, retryOptions: { maxRetries: 0, baseDelayMs: 1, maxBackoffMs: 1 } } as any);
    await expect(mc.chat({
      model: baseModel() as any,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })).rejects.toThrow();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ success: false, cost: null, usageSource: 'unavailable' });
  });

  it('没注册 sink 时调用照常成功（埋点缺席不能影响业务）', async () => {
    setLlmCallSink(null);
    const providers = new Map([
      ['kimi', { chat: vi.fn().mockResolvedValue({ content: 'ok', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, cost: 0 }, model: 'm', id: 'i', latencyMs: 1 }), streamChat: async function* () {} }],
    ]);
    const mc = new ModelClient({ providers } as any);
    const res = await mc.chat({ model: baseModel() as any, messages: [{ role: 'user', content: 'hi' }], stream: false });
    expect(res.content).toBe('ok');
  });
});
```

- [ ] **Step 10: 跑测试确认通过 + 全量回归**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/server && npx vitest run src/ai-core/ && npx tsc --noEmit && npm test 2>&1 | tail -6
```
Expected: 全绿；tsc 无错误。

- [ ] **Step 11: Commit**

```bash
git add apps/server/src/ai-core/infra/request-context.ts apps/server/src/ai-core/infra/request-context.test.ts apps/server/src/ai-core/types.ts apps/server/src/ai-core/infra/model-router.ts apps/server/src/ai-core/infra/model-router.test.ts apps/server/src/ai-core/infra/model-client/
git commit -m "feat(ai-core): ModelClient 记 llm_call_logs（含重试尝试/失败），router 打归因标，ALS 传学生上下文"
```

---

### Task 9: API 请求埋点——中间件 + 拦截器 + 模块接线

**Files:**
- Create: `apps/server/src/common/middleware/request-context.middleware.ts`
- Create: `apps/server/src/modules/analytics/telemetry.service.ts`
- Create: `apps/server/src/modules/analytics/analytics.module.ts`
- Create: `apps/server/src/common/interceptors/analytics.interceptor.ts`
- Create: `apps/server/src/common/interceptors/analytics.interceptor.test.ts`
- Modify: `apps/server/src/app.module.ts`
- Modify: `apps/server/src/main.ts`

**Interfaces:**
- Consumes: Task 7 的两个 repo + `TelemetryBuffer`；Task 8 的 `setLlmCallSink` / `runWithRequestContext`
- Produces: 效果——每请求一行 `api_request_logs`；`llm_call_logs` 的 sink 已注册且 buffer 已启动

- [ ] **Step 1: 写拦截器纯函数的失败测试**

Create `apps/server/src/common/interceptors/analytics.interceptor.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { normalizeRoute, moduleFromRoute, shouldSkipRoute } from './analytics.interceptor';

describe('normalizeRoute', () => {
  it('用 Express 路由模板（req.baseUrl + req.route.path）', () => {
    expect(normalizeRoute({ baseUrl: '/api/practice', routePath: '/:cardId/judge', path: '/api/practice/12/judge' }))
      .toBe('/api/practice/:cardId/judge');
  });

  it('拿不到模板时把数字/UUID 段替换掉，避免基数爆炸', () => {
    expect(normalizeRoute({ baseUrl: '', routePath: undefined, path: '/api/exams/sessions/42/results' }))
      .toBe('/api/exams/sessions/:id/results');
    expect(normalizeRoute({ baseUrl: '', routePath: undefined, path: '/api/study-sessions/3f2504e0-4f89-11d3-9a0c-0305e82c3301/end' }))
      .toBe('/api/study-sessions/:uuid/end');
  });
});

describe('moduleFromRoute', () => {
  it('按第二段路径推导 module', () => {
    expect(moduleFromRoute('/api/practice/12/judge')).toBe('practice');
    expect(moduleFromRoute('/api/training/vocabulary/judge')).toBe('training');
    expect(moduleFromRoute('/api/admin/models')).toBe('admin');
    expect(moduleFromRoute('/health')).toBeNull();
  });
});

describe('shouldSkipRoute', () => {
  it('跳过自指与静态资源', () => {
    expect(shouldSkipRoute('/api/admin/analytics/llm-cost')).toBe(true);
    expect(shouldSkipRoute('/assets/textbooks/a.jpg')).toBe(true);
    expect(shouldSkipRoute('/uploads/x.png')).toBe(true);
    expect(shouldSkipRoute('/api/track/events')).toBe(true);
    expect(shouldSkipRoute('/api/practice/12/judge')).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/server && npx vitest run src/common/interceptors/analytics.interceptor.test.ts
```
Expected: FAIL —— 无法解析模块（文件还没建）。

- [ ] **Step 3: 实现中间件**

Create `apps/server/src/common/middleware/request-context.middleware.ts`：

```ts
import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { JwtUser } from '../guards/jwt-auth.guard.js';
import { runWithRequestContext } from '../../ai-core/infra/request-context.js';

/**
 * 每请求开一个 AsyncLocalStorage 上下文，让 ai-core 深处的 ModelClient 能归因到学生。
 * 必须排在 AuthMiddleware **之后**（需要 request.user）；见 app.module.ts 的注册顺序。
 * 同时给 req 挂 requestId，供拦截器与账本关联。
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const user = (req as Request & { user?: JwtUser }).user;
    const requestId = randomUUID();
    (req as Request & { requestId?: string }).requestId = requestId;
    runWithRequestContext(
      {
        requestId,
        studentId: user?.role === 'student' ? Number(user.sub) : null,
        role: user?.role ?? null,
      },
      next,
    );
  }
}
```

- [ ] **Step 4: 实现遥测服务与模块**

Create `apps/server/src/modules/analytics/telemetry.service.ts`：

```ts
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { LlmCallLogsRepository } from '../../database/repositories/llm-call-logs.repo.js';
import { ApiRequestLogsRepository } from '../../database/repositories/api-request-logs.repo.js';
import { TelemetryBuffer } from './telemetry-buffer.js';
import type { LlmCallLogEntry } from '../../ai-core/infra/llm-call-log.js';
import type { ApiRequestLogEntry } from '../../database/repositories/api-request-logs.repo.js';

/**
 * 两个埋点 buffer 的持有者。buffer 的 flush 直接调 repo 的批量插入；
 * 失败由 TelemetryBuffer 吞掉（整批丢弃、不重试），因此这里不做 try/catch。
 */
@Injectable()
export class TelemetryService implements OnModuleInit, OnModuleDestroy {
  readonly llmCalls: TelemetryBuffer<LlmCallLogEntry>;
  readonly apiRequests: TelemetryBuffer<ApiRequestLogEntry>;

  constructor(
    llmCallLogsRepo: LlmCallLogsRepository,
    apiRequestLogsRepo: ApiRequestLogsRepository,
  ) {
    this.llmCalls = new TelemetryBuffer<LlmCallLogEntry>(
      (rows) => llmCallLogsRepo.insertMany(rows),
      { name: 'llm_call_logs' },
    );
    this.apiRequests = new TelemetryBuffer<ApiRequestLogEntry>(
      (rows) => apiRequestLogsRepo.insertMany(rows),
      { name: 'api_request_logs' },
    );
  }

  onModuleInit(): void {
    this.llmCalls.start();
    this.apiRequests.start();
  }

  async onModuleDestroy(): Promise<void> {
    this.llmCalls.stop();
    this.apiRequests.stop();
    // 退出前兜最后一次落库（仍可能丢不足一个 flush 间隔的数据，可接受）
    await this.llmCalls.flushNow();
    await this.apiRequests.flushNow();
  }
}
```

Create `apps/server/src/modules/analytics/analytics.module.ts`：

```ts
import { Module } from '@nestjs/common';
import { LlmCallLogsRepository } from '../../database/repositories/llm-call-logs.repo.js';
import { ApiRequestLogsRepository } from '../../database/repositories/api-request-logs.repo.js';
import { TelemetryService } from './telemetry.service.js';
import { AnalyticsInterceptor } from '../../common/interceptors/analytics.interceptor.js';
import { setLlmCallSink } from '../../ai-core/infra/llm-call-log.js';

/**
 * 埋点模块（Phase 0：只做账本 + 请求日志）。
 *
 * 为什么把 sink 注册放这里：capability 是零参 `new` 出来的、拿不到 DI 容器
 * （见 CLAUDE.md 的 DI 坑），所以 ai-core 用模块级 sink 单例，由本模块在启动时接上。
 */
@Module({
  providers: [LlmCallLogsRepository, ApiRequestLogsRepository, TelemetryService, AnalyticsInterceptor],
  exports: [TelemetryService, AnalyticsInterceptor],
})
export class AnalyticsModule {
  constructor(private telemetry: TelemetryService) {
    setLlmCallSink((entry) => this.telemetry.llmCalls.push(entry));
  }
}
```

- [ ] **Step 5: 实现拦截器**

Create `apps/server/src/common/interceptors/analytics.interceptor.ts`：

```ts
import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import type { Request } from 'express';
import type { JwtUser } from '../guards/jwt-auth.guard.js';
import type { ApiRequestLogEntry } from '../../database/repositories/api-request-logs.repo.js';
import { TelemetryService } from '../../modules/analytics/telemetry.service.js';

/** 不做埋点的路径：自指噪音 + 静态资源 */
const SKIP_PREFIXES = ['/assets/', '/uploads/'];
const SKIP_PATTERNS = [/^\/api\/admin\/analytics(\/|$)/, /^\/api\/track(\/|$)/];

export function shouldSkipRoute(path: string): boolean {
  if (SKIP_PREFIXES.some((p) => path.startsWith(p))) return true;
  return SKIP_PATTERNS.some((re) => re.test(path));
}

/** 按第二段路径推导模块名（/api/practice/... -> practice） */
export function moduleFromRoute(path: string): string | null {
  const m = /^\/api\/([^/?]+)/.exec(path);
  return m ? m[1] : null;
}

/** 优先用 Express 路由模板；拿不到时按形状替换，避免每个 id 一个基数 */
export function normalizeRoute(input: { baseUrl: string; routePath?: string; path: string }): string {
  if (input.routePath) return `${input.baseUrl}${input.routePath}`;
  const full = input.path.split('?')[0];
  return full
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:uuid')
    .replace(/\/\d+/g, '/:id');
}

@Injectable()
export class AnalyticsInterceptor implements NestInterceptor {
  constructor(private telemetry: TelemetryService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { user?: JwtUser; requestId?: string }>();
    const path = (req.originalUrl ?? req.url ?? '').split('?')[0];
    if (shouldSkipRoute(path)) return next.handle();

    const started = Date.now();
    const push = (statusCode: number, bizCode: number | null, errorCode: string | null) => {
      const user = req.user;
      const entry: ApiRequestLogEntry = {
        requestId: req.requestId ?? null,
        actorRole: user?.role ?? 'anonymous',
        studentId: user?.role === 'student' ? Number(user.sub) : null,
        method: req.method,
        route: normalizeRoute({
          baseUrl: req.baseUrl ?? '',
          routePath: (req as Request & { route?: { path?: string } }).route?.path,
          path,
        }),
        rawPath: path.slice(0, 255),
        module: moduleFromRoute(path),
        statusCode,
        bizCode,
        errorCode,
        latencyMs: Date.now() - started,
        isSse: String(req.headers['accept'] ?? '').includes('text/event-stream'),
      };
      this.telemetry.apiRequests.push(entry);
    };

    return next.handle().pipe(
      tap({
        // 全局 ResponseInterceptor 包成 {code,message,data}，这里读不到最终响应体；
        // 成功路径只记 HTTP 状态码（失败路径能拿到业务码，见 catchError）。
        next: () => push(http.getResponse().statusCode, null, null),
      }),
      catchError((err) => {
        const status = typeof err?.getStatus === 'function' ? err.getStatus() : 500;
        const payload = typeof err?.getResponse === 'function' ? err.getResponse() : null;
        const bizCode = payload && typeof payload === 'object' && typeof (payload as { code?: unknown }).code === 'number'
          ? (payload as { code: number }).code
          : null;
        push(status, bizCode, err?.name ?? 'Error');
        return throwError(() => err);
      }),
    );
  }
}
```

**关于 SSE**：`@Res()` 直写的流式端点（`/api/ai/tutor/stream`、`/api/admin/chat/stream`）里 `next.handle()` 的 `tap` 在处理器返回时触发，`latencyMs` 与 `is_sse` 即该时刻的值——**这正是我们要的「整段流时长」**。

- [ ] **Step 6: 接线 app.module 与 main.ts**

**6a.** `apps/server/src/app.module.ts`：

```ts
import { AnalyticsModule } from './modules/analytics/analytics.module.js';
import { AnalyticsInterceptor } from './common/interceptors/analytics.interceptor.js';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware.js';
```
imports 数组末尾加 `AnalyticsModule`；providers 改为：
```ts
  providers: [
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    // 埋点拦截器排在 ResponseInterceptor 之后。用 useExisting 而不是 useClass：
    // AnalyticsInterceptor 已由 AnalyticsModule 提供（它依赖同一个 TelemetryService
    // 实例），useClass 会new 出第二个实例、连带第二个 buffer，日志会被劈成两半。
    { provide: APP_INTERCEPTOR, useExisting: AnalyticsInterceptor },
  ],
```
`configure()` 里在既有 `consumer.apply(AuthMiddleware)...` 之后追加：
```ts
    // ALS 上下文要读 AuthMiddleware 填的 request.user，因此必须在其后注册。
    // 同样排除公开路径（登录/学科列表），它们本来也没有学生身份。
    consumer
      .apply(RequestContextMiddleware)
      .exclude(
        { path: 'api/auth', method: RequestMethod.ALL },
        { path: 'api/auth/*', method: RequestMethod.ALL },
        { path: 'api/content', method: RequestMethod.ALL },
        { path: 'api/content/*', method: RequestMethod.ALL },
      )
      .forRoutes({ path: '*', method: RequestMethod.ALL });
```

**6b.** `apps/server/src/main.ts` 的 `bootstrap()` 内、`app.enableCors({...})` 之后：
```ts
  // 让 OnModuleDestroy 生效，退出时把埋点 buffer 里剩余的行 flush 掉
  app.enableShutdownHooks();
```

- [ ] **Step 7: 跑测试 + 构建**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/server && npx vitest run src/common/ src/modules/analytics/ && npx tsc --noEmit && npm run build
```
Expected: 测试全绿；tsc 无错误；`build` 成功。

- [ ] **Step 8: 冒烟——起服务确认 DI 没炸**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/server && PORT=3099 node dist/main.js > /tmp/k12_smoke.log 2>&1 & echo $! > /tmp/k12_smoke.pid
sleep 4
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3099/api/content/subjects
kill "$(cat /tmp/k12_smoke.pid)"; rm -f /tmp/k12_smoke.pid
```
Expected: 输出一个 HTTP 状态码（200 或 401 都算健康——**关键是进程没崩**）。若进程退出且日志里有 Nest DI 错误，检查 `app.module.ts` 的 `useExisting` 写法与 `AnalyticsModule` 的 `exports`。
**注意**：**不要** `pkill -f 'node dist/main.js'`（会杀掉本机在跑的服务）。

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/common/middleware/request-context.middleware.ts apps/server/src/common/interceptors/analytics.interceptor.ts apps/server/src/common/interceptors/analytics.interceptor.test.ts apps/server/src/modules/analytics/telemetry.service.ts apps/server/src/modules/analytics/analytics.module.ts apps/server/src/app.module.ts apps/server/src/main.ts
git commit -m "feat(analytics): API 请求拦截器 + ALS 中间件 + 模块接线（每请求一行 api_request_logs）"
```

---

### Task 10: 端到端验收与文档同步

**Files:**
- Modify: `docs/API接口与数据流设计文档.md`
- Modify: `docs/api/openapi.yaml`
- Modify: `docs/K12智学系统-数据库设计文档.md`
- Modify: `docs/ai-core-changelog.md`

**Interfaces:**
- Consumes: 前面全部任务
- Produces: 无（验收 + 文档）

- [ ] **Step 1: 端到端验收——真实调用是否落账本且 token 不为 0**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/server && PORT=3099 node dist/main.js > /tmp/k12_smoke.log 2>&1 & echo $! > /tmp/k12_smoke.pid
sleep 4
# 登录拿 token（用本机测试账号）
curl -s -X POST http://localhost:3099/api/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"<测试账号>","password":"<密码>"}' | head -c 300
```
用拿到的 token 触发一次真实 LLM 调用（管理员模型探活，或一次学生判题 / 讨论 / 背单词判题），然后收尾查询：

```bash
kill "$(cat /tmp/k12_smoke.pid)"; rm -f /tmp/k12_smoke.pid
mysql -u ai_k12 -pai_k12 ai_k12 -e "SELECT scene, model_key, provider, attempt, success, usage_source, input_tokens, output_tokens, cost, latency_ms, student_id FROM llm_call_logs ORDER BY id DESC LIMIT 5; SELECT route, method, status_code, latency_ms, is_sse FROM api_request_logs ORDER BY id DESC LIMIT 5;"
```

**验收标准（三条，缺一不可）**：
1. `api_request_logs` 有刚触发的请求行，`route` 是**归一化模板**（含 `:id` / `:uuid` 之类占位符），不是带真实 id 的路径。
2. `llm_call_logs` 有对应行，`usage_source` 是 `provider` 或 `estimated`（**不是 `unavailable`**），且 `output_tokens > 0`。
3. 非本地模型 `cost > 0`；本地模型 `cost = 0` 且 `usage_source = 'provider'`（真免费，不是算不出）。

排查指引：第 2 条得到 `unavailable` → 检查是否真的下发了 `stream_options`（`local` provider 有意删除，属预期）；第 3 条非本地模型 `cost = 0` → 检查 Task 3 Step 6 的回填是否执行过。

- [ ] **Step 2: 同步 API 文档（主稿）**

`docs/API接口与数据流设计文档.md`：

1. §4.17 Admin 的 `POST /api/admin/models` 与 `PATCH /api/admin/models/:modelKey` 请求体各加两字段：`inputPricePer1k?: number`（每 1K 输入 token 单价，≥0，0 表示免费）、`outputPricePer1k?: number`；`GET /api/admin/models` 响应体加同名字段。
2. §6 末尾新增：

```markdown
### 6.26 LLM 调用 → 账本 → 成本（2026-09-20）

任何 capability 最终都经 `ModelClient.chat()`（`ai-core/infra/model-client/index.ts`）。在那里：

1. **归因**：`ModelRouter.route()` 给 primary/fallback 条目打 `scene`/`subject`/`modelKey`/`isFallbackEntry`；
   HTTP 路径的 `student_id`/`request_id` 由 `AsyncLocalStorage`（`ai-core/infra/request-context.ts`）带出，
   后台路径（判错解析、会话标题）由调用方显式传 `ChatRequest.meta`。
2. **usage**：流式默认拿不到，故请求体下发 `stream_options.include_usage`（本地 llama.cpp 例外，它不认）；
   仍拿不到则按 `estimateTokens()` 估算并把 `usage_source` 标为 `estimated`；两者都无则 `unavailable`
   且 tokens/cost 写 **NULL**（**绝不写 0** —— 0 只代表真免费）。
3. **落库**：每次逻辑调用 + 每次重试尝试各一行，`attempt` 递增；失败/超时也记（`success=0`、`error_type`）。
   写入走 `TelemetryBuffer`（2s 或 200 条 flush，满 5000 丢最旧，失败整批丢弃不重试）。
4. **成本**：单价唯一真源是 `llm_models` 的 `input_price_per_1k`/`output_price_per_1k`（后台可改），
   `model-config-registry` 读进 `costPer1K`；账本存**价格快照**，改价不会让历史成本漂移。
```

- [ ] **Step 3: 同步 openapi.yaml**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12 && grep -n "modelKey" docs/api/openapi.yaml | head
```
找到 `/api/admin/models` 的请求/响应 schema，加 `inputPricePer1k` / `outputPricePer1k`（`type: number`、`format: double`、`minimum: 0`）。**只加字段，不新增端点**（openapi 只收 MVP 端点）。

- [ ] **Step 4: 同步数据库设计文档**

`docs/K12智学系统-数据库设计文档.md`：按该文档既有表清单格式追加 `llm_call_logs`、`api_request_logs`，以及 `llm_models` 的两个新列；口径直接引用 spec §4.6。

- [ ] **Step 5: 追加 changelog**

`docs/ai-core-changelog.md` **顶部**追加（按该文件既有格式）：

```markdown
## 2026-09-20 埋点 Phase 0：模型调用账本 + API 请求日志

- 新增 `llm_call_logs`（每次 LLM 调用一行，含重试尝试/失败/fallback，带 token/cost/价格快照）
  与 `api_request_logs`（每请求一行，归一化 route / 状态码 / 业务码 / 耗时 / is_sse）
- `llm_models` 新增 `input_price_per_1k` / `output_price_per_1k`：**单价唯一真源进 DB**，
  后台可改；`model-config-registry` 改读它（此前 DB 路径写死 `{0,0}`）
- **修正「生产 token 恒为 0」**：`ModelClient.chat()` 默认流式，而 `aggregateStream()` 把 usage
  硬编码 `{0,0,0}`；现改为三级降级 —— 端点 usage > `estimateTokens()` 估算 > NULL
  （**绝不把未知写成 0**）。流式请求体下发 `stream_options.include_usage`，本地 llama.cpp 除外
- `student_id` 是**硬要求**：HTTP 走 ALS，后台路径（判错解析/标题生成）必须显式传 `ChatRequest.meta`
- 埋点两条纪律：分析日志走 `TelemetryBuffer`（失败整批丢弃、不重试、不抛）；埋点异常绝不让请求 500
- 已知待办（属 Phase 2）：`llmAttributionCoverage` 归属覆盖率、`/api/admin/analytics/*` 查询端与页面
```

- [ ] **Step 6: 全量回归 + 最终提交**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/server && npm test 2>&1 | tail -6
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/web && npm test 2>&1 | tail -6
```
Expected: 后端全绿（1166 + 本批新增）；前端全绿（573 + 1）。

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
git add docs/
git commit -m "docs: 同步埋点 Phase 0（价格字段 / 账本数据流 §6.26 / DB 设计 / changelog）"
```

---

## Self-Review

### 1. Spec coverage（逐节核对）

| spec 章节 | 覆盖它的任务 |
|---|---|
| §4.6 `llm_call_logs` DDL + `llm_models` 价格列 | Task 1、2 |
| §4.5 `api_request_logs` DDL | Task 1、7、9 |
| §6.2 API 自动埋点（拦截器、跳过名单、route 归一化、biz_code） | Task 9 |
| §6.3 `TelemetryBuffer`（环形丢弃 / 失败静默 / `pool.query` 多行） | Task 7 |
| §6.5 账本写入点（ModelClient，含重试尝试）+ 归因传播 | Task 8 |
| §6.5 第 4 条「student_id 硬要求 + 后台显式 `meta`」 | Task 8（`meta` 类型 + `recordCall` 优先级链） |
| §6.6 usage 修复（`include_usage`、估算兜底、NULL 不写 0、价格真源进 DB） | Task 3、6 |
| §8.4 现有端点形状变化（`GET/POST/PATCH /api/admin/models`） | Task 4、5、10 |
| §12 Phase 0 第 1–7 项 | Task 1（1）、3（2）、4（3、7）、6（4）、8（5）、9（6） |
| §14 陷阱（token 恒 0 / 价格漂移 / NULL vs 0 / 流式 usage / `model_key`≠`model_id` / DI 坑 / 无迁移运行器） | Task 6（1、4）、3（2）、6（3）、8（5）、4（9）、1（10） |
| §15 测试义务 | 各任务的测试步骤 |

**本计划有意不覆盖**（属 Phase 1/2，另有计划）：`study_sessions`、`behavior_events`、`special_practice_logs`、`student_knowledge_mastery`、`goals.metric`、家长端 5 个端点、设备画像列与 UA 分类器、`/api/admin/analytics/*` 查询端与页面、`llmAttributionCoverage` 指标。

### 2. Placeholder scan

已逐任务扫描，无 "TBD" / "TODO" / "implement later" / "similar to Task N" / 「加适当的错误处理」这类空话；每个改动步骤都给了可直接粘贴的代码。

计划阶段无法凭读代码确定的两个事实，**已实测消解**而不是留成占位符：

- `estimateTokens` 的 5 个期望值 → 用 node 跑过实际实现确认（见 Task 6 Step 4）。
- `admin-chat.service.ts:84` 的取数来源 → 读代码确认它在 `toModelConfig(m: LlmModel)` 内、`m` 来自 `modelsRepo.listEnabled()`，故改法唯一（Task 4 Step 5 已写成确定代码，不再给二选一）。

另核实：`LlmModelsRepository.create` 全仓**只有一个调用方**（`admin-models.service.ts:39`，本计划 Task 4 会改），没有其它地方凭空构造 `LlmModel`——所以 Task 2 把两个价格字段设成**必填**不会打坏别的调用点。

### 3. Type consistency（跨任务名称核对）

| 名称 | 定义处 | 使用处 | 一致 |
|---|---|---|---|
| `inputPricePer1k` / `outputPricePer1k`（驼峰） | Task 2 `LlmModel` | Task 3 registry、Task 4 service/controller、Task 5 api.ts | ✅ |
| `input_price_per_1k` / `output_price_per_1k`（下划线） | Task 1 DDL | Task 2 repo SQL、Task 7 账本快照列 | ✅ |
| `UsageSource` | Task 6 `types.ts` | Task 7 `LlmCallLogEntry.usageSource`、Task 8 `recordCall` | ✅ |
| `LlmCallLogEntry` | Task 7 `llm-call-log.ts` | Task 7 repo、Task 8 `emitLlmCall`、Task 9 `TelemetryService` | ✅ |
| `ApiRequestLogEntry` | Task 7 `api-request-logs.repo.ts` | Task 9 拦截器 | ✅ |
| `TelemetryBuffer.push/flushNow/start/stop/size/dropped/failed` | Task 7 | Task 9 `TelemetryService` | ✅ |
| `RequestContext` / `runWithRequestContext` / `getRequestContext` | Task 8 | Task 9 中间件、Task 8 `recordCall` | ✅ |
| `RoutedModel.{scene,subject,modelKey,isFallbackEntry}` | Task 8 `types.ts` | Task 8 `model-router.route()`、`recordCall` | ✅ |
| `AnalyticsInterceptor` | Task 9 | Task 9 `app.module.ts`（`useExisting`）+ `AnalyticsModule.exports` | ✅ |
| `normalizeRoute` / `moduleFromRoute` / `shouldSkipRoute` | Task 9 | Task 9 测试 + 拦截器自身 | ✅ |
| `seed-llm-prices.ts` 用的 `repo.findByKey` / `repo.update` | Task 2 | Task 3 脚本 | ✅ |
