# 训练模块判题默认走本地模型 + 本地不可用回退 ds v4 flash

- 日期：2026-09-11
- 状态：设计已与用户逐节确认
- 关联文档：`CLAUDE.md`（ai-core 场景路由段）、`docs/ai-core-changelog.md`、`docs/superpowers/specs/2026-09-09-judging-rework-design.md`

## 1. 背景与问题

训练模块的专项练习、考试、错题重练，凡需要模型判题的地方都汇聚到同一条链路：

```
training.service / exams.service
  -> JudgeCoreService.judgeQuestion
    -> JudgmentCapability.judge（scene = judgment）
```

- 客观题（choice/true_false）与 fill_blank/calculation 归一化命中走程序比对，不调模型；
- fill_blank/calculation 归一化不等、short_answer/proof（`JUDGE_SUBJECTIVE_MODE=ai` 时）走 `JudgmentCapability`，即 `judgment` 场景。

两个现状事实决定了本次改动：

1. **`JudgmentCapability` 不读 `routeResult.fallback`**。它只调 `primary`，失败直接抛错（`apps/server/src/ai-core/capabilities/judgment.capability.ts:57`）。所以"本地不可用改用 ds v4 flash"必须**新增代码**，只改配置无效。
2. **运行时模型配置真源是数据库**。`ConfigModule.onModuleInit` 创建 `ModelConfigRegistry` 并从 `llm_models`/`llm_routes` reload；`judgment/math` 当前已 seed 为 `deepseek-v4-flash / qwen3.7-max`。YAML 只在 DB 为空/失败时兜底。所以 YAML 与 DB 两层都要改。

本地模型 = 数据管线同款 llama.cpp `Qwen3.8-27B`（`tools/data-refinery/.env`：`LLM_BASE_URL=http://192.168.1.8:12345`），OpenAI 兼容协议。ai-core 目前没有 `local` provider。

### ModelClient 客户端结构现状（本次顺带纠偏）

`git log -S "BaseClient"` 覆盖所有分支为空——仓库**从未存在 `BaseClient`**。CLAUDE.md 提到的 `../llm-client.js` 是错误体系的外部设计参考，不在本仓库。

现状是：

| 类 | 关系 | 职责 |
|---|---|---|
| `KimiClient` | `implements ProviderAdapter` | 事实上的基类：OpenAI 兼容 chat + SSE stream + cost |
| `QwenClient` | `extends KimiClient` | 仅 `providerName='Qwen'` |
| `DeepSeekClient` | `extends KimiClient` | 仅 `providerName='DeepSeek'` |
| `GeminiClient` | 独立 | 协议不同（systemInstruction / finishReason 映射） |

即"KimiClient 被当基类用，名字误导"。本次把它纠正为真正的 `OpenAICompatibleClient` 基类。

## 2. 目标与非目标

**目标**

1. 训练模块（专项/考试/错题）判题模型默认改为本地 `Qwen3.8-27B`；
2. 本地模型**任何失败**（连接拒绝/超时/4xx/5xx/返回解析不了）时回退 `deepseek-v4-flash`；
3. 抽出 `OpenAICompatibleClient` 基类，`Kimi/Qwen/DeepSeek/Local` 各自成为其薄子类，本地模型有独立类可裁剪请求体；
4. 配置可复现落地：YAML（新装环境）+ 幂等 upsert 脚本（已 seed 的库）。

**非目标**

- 不改 `hint` / `explanation` / `grading` / `tutoring` / `safety` / `structuring` / `transcribe` 场景；
- 不做本地模型健康检查/preflight 探测；
- 不为 `local` 单独调全局 `retry.yaml` 重试次数；
- 不改 `JudgeCoreService`（它已 catch 全部错误 → 503）与主观题 `self_assess` 逻辑；
- 不改 `seed-llm-config.ts` 的 skip-if-exists 语义。

## 3. 总体设计

### 3.1 配置层（.env + model-routes.yaml）

`.env` 与 `.env.example` 新增：

```
# 本地 llama.cpp 判题模型（训练模块判题主模型；不可用回退 deepseek-v4-flash）
LOCAL_LLM_BASE_URL=http://192.168.1.8:12345
LOCAL_LLM_API_KEY=local
LOCAL_LLM_MODEL=Qwen3.8-27B
```

`ai-core/model-routes.yaml`：

- `models` 新增 `local`（`provider: local`，`modelId/baseUrl/apiKey` 走上面 env，`costPer1K` 0，`supportsStreaming: true`，`contextWindow: 32768`，`maxOutputTokens: 4096`）；
- `routes.judgment` 改为：

```yaml
judgment:
  - subject: math
    # 训练模块（专项/考试/错题）判题默认走本地 Qwen3.8-27B；
    # 本地不可用回退 deepseek-v4-flash（快模型，实测同题 ~19s）。
    primary: local
    fallback: deepseek-v4-flash
```

`default` 与其它场景路由不变。`judgment` 仅 math 一条。

### 3.2 Provider 层：抽出 OpenAICompatibleClient（Option 2）

- 新增 `infra/model-client/openai-compatible-client.ts`：`OpenAICompatibleClient implements ProviderAdapter`，把 `KimiClient` 现有全部实现（`chat` / `streamChat` / `calculateCost` / 错误分类）原样搬入；新增 `protected buildRequestBody(request, stream): object` 钩子，`chat`/`streamChat` 都改为调用它。
- `kimi-client.ts` 改为薄子类：`class KimiClient extends OpenAICompatibleClient`，构造签名与行为不变（`(apiKey, providerName = 'Kimi')`）。
- `qwen-client.ts` / `deepseek-client.ts` 基类由 `KimiClient` 改为 `OpenAICompatibleClient`，仅 `providerName` 不同。
- 新增 `local-client.ts`：`class LocalClient extends OpenAICompatibleClient`，`providerName='Local'`；override `buildRequestBody`，**去掉 `enable_thinking`**（llama.cpp 非 Qwen 云端语义），保留 `response_format`（判题 JSON 依赖）。
- `types.ts`：`Provider` 加 `'local'`。
- `ModelClient.getProvider` switch 增 `case 'local': client = new LocalClient(key); break;`。
- `mapProviderType`（registry）与 `admin-chat.service` 的 `openai_compatible → kimi` 映射保持不变；`'local'` 直接透传为 Provider。
- `admin-models.service.ts` 的 `PROVIDER_TYPES` 与 `apps/web/src/pages/admin/AdminModelsPage.tsx` 的 `PROVIDER_TYPES` 各加 `'local'`（后台可创建/辨识）。

行为不变性：kimi/qwen/deepseek 的请求体、错误分类、重试语义与改动前逐字段一致。

### 3.3 判题失败回退（核心代码）

`JudgmentCapability` 改造：

1. `JudgmentCapabilityDeps` 增可选 `modelRouter?: ModelRouter`；构造 `this.modelRouter = deps?.modelRouter ?? new ModelRouter(getModelConfigRegistry())`（可测性，默认行为不变）。
2. 抽出私有 `callModel(model: RoutedModel, promptResult): Promise<JudgmentResult>`：`modelClient.chat({ model, messages, responseFormat: 'json_object', timeout: timeoutConfig.timeout.judgment })` + Zod 解析，失败抛错。
3. `judge()`：

```
route = router.route({ scene: 'judgment', subject })
prompt = promptBuilder.build(...)
try:
  return await callModel(route.primary, prompt)
catch primaryErr:
  if (!route.fallback) throw primaryErr
  try:
    return await callModel(route.fallback, prompt)
  catch fallbackErr:
    throw new Error(`Judgment failed: primary(${primary.modelId})=${msg(primaryErr)}; fallback(${fallback.modelId})=${msg(fallbackErr)}`)
```

prompt 只构建一次，primary 与 fallback 复用。回退是**一次**尝试，不递归。`JudgeCoreService` 的 catch → 503 映射不变：只有两条都失败才 503。

### 3.4 DB upsert 脚本

新增 `apps/server/src/scripts/set-judging-local.ts`（幂等，可重复运行）：

- 以 YAML 为源读取 `routeConfig.models.local` 与 `routeConfig.routes.judgment[0]`；
- `llm_models`：按 `model_key='local'` 存在则 UPDATE（provider_type/model_id/base_url/api_key/context_window/max_output_tokens/is_enabled=1），否则 INSERT（`api_key` 用 `encryptApiKey`）；
- `llm_routes`：按 `(scene='judgment', subject='math')` 存在则 UPDATE `primary_model_key='local', fallback_model_key='deepseek-v4-flash'`，否则 INSERT；
- 打印变更摘要；运行后需重启后端（或后台保存路由触发 `registry.reload()`）方生效。

不改 `seed-llm-config.ts`（它 skip-if-exists，无法更新已存在行）。

## 4. 关键决策与取舍

| 决策 | 选择 | 理由 |
|---|---|---|
| 改动层级 | 共享 `judgment` 路由 | 专项/考试/错题同链路，改一处全覆盖；课堂练习共用该场景，随之一并切到本地（用户确认接受） |
| 不可用判定 | 任何失败都回退 | 学生判题不应因本地模型挂掉而失败；本地模型配置错/返回格式异常同样应兜底 |
| 回退位置 | `JudgmentCapability` 内 | 不改共享 `ModelClient`（避免波及所有场景），改动面小、易测 |
| 客户端结构 | 抽 `OpenAICompatibleClient` 基类 | 对齐"一基类 + 各 provider 子类"，本地模型有独立类可裁剪参数 |
| 配置落地 | YAML + upsert 脚本 | 新装靠 YAML，当前已 seed 的库靠脚本；可复现、可追溯 |
| 重试 | 沿用全局 `retry.yaml`（2 次 + 退避） | 不因 local 改全局策略；本地挂时多等约 1–3s 后回退，可接受 |

## 5. 影响文件清单

**新增**

- `apps/server/src/ai-core/infra/model-client/openai-compatible-client.ts`
- `apps/server/src/ai-core/infra/model-client/local-client.ts`
- `apps/server/src/scripts/set-judging-local.ts`
- `apps/server/src/ai-core/infra/model-client/local-client.test.ts`（可选，见 §6）

**修改**

- `apps/server/.env`、`apps/server/.env.example`
- `apps/server/src/ai-core/model-routes.yaml`
- `apps/server/src/ai-core/types.ts`（Provider 加 'local'）
- `apps/server/src/ai-core/infra/model-client/kimi-client.ts`（改薄子类）
- `apps/server/src/ai-core/infra/model-client/qwen-client.ts`、`deepseek-client.ts`（换基类）
- `apps/server/src/ai-core/infra/model-client/index.ts`（local case + 导入）
- `apps/server/src/ai-core/capabilities/judgment.capability.ts`（fallback）
- `apps/server/src/modules/admin/admin-models.service.ts`（PROVIDER_TYPES）
- `apps/web/src/pages/admin/AdminModelsPage.tsx`（PROVIDER_TYPES）
- `apps/server/src/ai-core/infra/model-router.test.ts`（judgment 断言）
- `apps/server/src/ai-core/capabilities/judgment.capability.test.ts`（回退用例）
- `CLAUDE.md`、`docs/ai-core-changelog.md`

## 6. 测试与验收

**自动化**

- `model-router.test.ts`：`judgment/math` 断言改为 primary = `Qwen3.8-27B`、fallback = `deepseek-v4-flash`。
- `judgment.capability.test.ts`（注入 mock `modelRouter`，避免依赖全局 registry/YAML）：
  1. primary 抛错 → 用 fallback，且结果来自 fallback；
  2. primary 抛错且无 fallback → 抛错；
  3. primary 成功 → 不调用 fallback。
- `local-client.test.ts`：`buildRequestBody` 不含 `enable_thinking`；基类（如 KimiClient）请求体仍含该字段，保证 kimi/qwen/deepseek 行为未变。
- `cd apps/server && npm test`（现 72 tests 全绿）与 `npm run build` 通过。

**手动验收**

- `npx tsx src/scripts/set-judging-local.ts` 后重启后端，管理后台确认 `local` 模型存在、`judgment/math` 路由指向 `local`；
- 本地 llama.cpp 在线时发一次训练判题，确认走 `Qwen3.8-27B` 且返回正确 JSON；
- 关闭本地 llama.cpp（或断网）再判一次，确认日志/结果来自 `deepseek-v4-flash`。

## 7. 风险与待验证

1. **llama.cpp 参数兼容**：本地服务是否接受 `response_format: {type:'json_object'}` 未实测（探测 `:12345` 当时无响应）。若稳定拒绝，`LocalClient.buildRequestBody` 改为不下发该字段，改为依赖 prompt 约束 + `ResponseParser` 从文本提取 JSON；有回退兜底不至于中断。
2. **延迟**：本地不可用时，`ModelClient` 内置重试（2 次 + 退避）后才回退，单次判题多约 1–3s。
3. **`Qwen3.8-27B` 判题质量**：27B 本地模型判题准确率未经本项目评测；本设计只切路由，质量评估另跑 `grading-accuracy`/`tutoring-quality` 类脚本。
4. **全局 registry 与测试隔离**：judgment 测试通过注入 mock router 避免受全局 `ModelConfigRegistry` 影响。
