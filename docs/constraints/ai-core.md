# apps/server - ai-core AI Agent Hub

> **本文由根 `CLAUDE.md` 于 2026-09-24 迁出**（体量纪律：根文件只留仍生效硬规则与索引，带细节的「勿动」清单按主题搬到本目录）。**内容一字未改。**
>
> ⚠️ **动手改本主题之前必须先读本文** —— 这里的每一条都是「读代码/配置得不到的为什么」或「改了会踩坑的勿动」。索引见根 `CLAUDE.md` 的「权威文档索引」。

---

`infra/`（ModelRouter、PromptBuilder、ModelClient + 各厂商适配器、ResponseParser、SafetyGuard、FallbackHandler、Logger、Metrics）+ `capabilities/`（Tutoring/Grading/Explanation/Variation/Analytics/Judgment 及专项能力）+ `prompts/`（Mustache）+ `*.yaml`（model-routes / retry / safety / fallback）。Node + TS ESM、Vitest、Zod、Mustache、prom-client、dotenv。

**改代码前必读**：

- **模型 ID（勿改）**：`kimi-latest`、`qwen3.8-max`、`gemini-3.1-pro`、`deepseek-flash`、`Qwen3.8-27B`（本地 llama.cpp，`local` provider）。配置里 kimi 的 key 是 `kimi` 但 modelId 是 `kimi-latest`。**DeepSeek 端点只认 `deepseek-flash` 与 `deepseek-v4-pro`**（传其它名字直接 400）；`deepseek-v4-flash` 仅作旧别名存活，**勿再新增引用**。
- **API Key 用 `.env` 的 `KIMI_API_KEY`/`QWEN_API_KEY`/`GEMINI_API_KEY`/`DEEPSEEK_API_KEY` 及对应 `*_BASE_URL`**（ai-core 专属）。**不要用 `ANTHROPIC_*`**（会被 shell 里 Claude Code 覆盖）。
- **场景路由（勿随意切换）**：运行时真源是 DB 的 `llm_routes`（`model-routes.yaml` 只服务新装 / DB 空时）；已 seed 的库用 `npx tsx src/scripts/set-*-route.ts` 幂等补路由。**新增场景要改 8 处**：`types.ts` 两个 union、`model-routes.yaml`、`retry.yaml`、`prompts/` 模板、`prompt-builder.ts` 的 `resolveTemplatePath` 分支、capability 类、seed 脚本、**`admin-models.service.ts` 的 `SCENES` 白名单**（漏了后台下拉选不到；有漂移守卫用例钉着）。
- **给本地 llama.cpp 关 thinking 只能用 `extraBody`**：`ChatRequest.thinking=false` 是 **DashScope 系**的开关，**对本地端点完全无效**（`LocalClient` 会删掉该字段）；必须走 `ChatRequest.extraBody: LLAMA_CPP_NO_THINKING_BODY`（从 `infra/model-client/index.js` 导出）。`/no_think` 软开关**实测无效**（数据见 changelog）。⚠️ `JudgmentCapability` 既有的 `thinking:false` 对 local 是**空操作**，2026-09-14 有意未改（会改变数学判题行为）。
- **流式用空闲超时，不是墙钟硬超时**：阈值取 `retry.yaml` 的 `streaming.firstTokenTimeoutMs`（3s）/ `interTokenTimeoutMs`（10s），有数据就重置，reasoner 思考 >45s 不会被砍。空闲抛 `TimeoutError`（408）→ 前端 1009；外部 `request.signal` 走 `AbortError`。**副作用**：`request.timeout` 只在 `streaming.*` 缺失时兜底且每收一字节重新 arm，「持续吐思考 token」的调用**没有墙钟上限** —— **凡把 LLM 调用放请求关键路径都要意识到。**
- **`PromptBuilder`**：`customVariables` 已展平进 Mustache 视图（可传对象/数组）；**已关闭 HTML 转义**（数学符号 `=<>` 必须原样保留）；`{{> partial}}` 加载 `system/*.md` 并剥 frontmatter；模板用 `## System Prompt` / `## User Message` 分段。
- **判题与解析分离**：判题（`judgment`）只判对错，prompt **勿加回 analysis 输出**；判错解析由 `ExplanationCacheService` 后台生成入 `questions.explanation` 一次性复用。⚠️ 该服务**必须由 `PracticeModule` 导出后注入同一实例**，**勿在其它模块重复 provide**（会分裂 in-flight 队列）。
- **判题体系分层**：`choice`/`true_false` 程序比对；`fill_blank`/`calculation` 归一化比对 + AI 等价判断；`short_answer`/`proof` 由 `JUDGE_SUBJECTIVE_MODE` 控制（默认 `self_assess`：不判对错、学生自评）。空答案不计对错。设计见 `docs/superpowers/specs/2026-09-09-judging-rework-design.md`。
- **`npm run build` 经 `scripts/copy-assets.mjs` 把 `ai-core/*.yaml` 与 `prompts/` 复制进 `dist/ai-core`**，使 `node dist/main.js` 与 `tsx src/...` 读到同一份配置。

**已知限制与历史实现细节**（metrics 未接入 capability、ConversationService 内存存储无上限、gemini 流式未实现、多模态图片直送、辅线「详细解析」走题库、会话标题路由等）已迁至 `docs/ai-core-changelog.md`。