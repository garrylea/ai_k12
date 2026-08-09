# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

K12 智学系统 — an adaptive AI-powered K-12 education platform for Chinese students. MVP scope: Mathematics only. The platform uses a dual-track learning model (mainline structured progression + auxiliary free exploration) with Socratic AI tutoring.

## Monorepo Structure

```
apps/web/             — Active. React frontend (Vite + TypeScript + Tailwind)
apps/server/          — Active (ai-core). Node.js backend; ai-core AI Agent Hub 已实现（见下文 ai-core 节），HTTP API 层待建
apps/desktop/         — Planned. Electron wrapper
packages/             — Planned. Shared configs/types
tools/crawler/        — Active. 爬虫（zgkao 试卷 / smartedu 教材）
tools/data-refinery/  — Active. 数据管线 convert->extract->publish->db_loader（见下文）
tools/db/             — Active. MySQL schema + install_mysql.sh
docs/                 — PRD, API 设计, UX/UI, DB 设计, 数据管线总结
```

`apps/web`、`apps/server/ai-core` 与 `tools/data-refinery`、`tools/db` 已有可运行代码；`apps/server` 的 HTTP API 层待建。

## Development Commands

All commands run from `apps/web/`:

```bash
npm run dev      # Vite dev server at http://localhost:5173
npm run build    # tsc -b + vite build (type-check then bundle)
npm run preview  # Serve production build locally
npm run lint     # ESLint for .ts/.tsx
```

No test framework is configured yet for `apps/web`.

### apps/server (ai-core)

Commands run from `apps/server/`:

```bash
npm test            # vitest run (72 tests across 14 files)
npm run test:watch  # vitest watch mode
npm run build       # tsc (type-check + emit). NOTE: does not copy YAML/prompt assets to dist/ - see ai-core known limitations
npx tsx src/ai-core/__tests__/safety-classification.ts   # deterministic safety regression (no API keys needed)
```

`grading-accuracy.ts` and `tutoring-quality.ts` in `__tests__/` are LLM eval scripts (require API keys, run via `tsx`, not picked up by vitest).

## Architecture (apps/web)

### Theme System

Three themes via CSS variables + `data-theme` attribute on containers. The canonical tokens live in `apps/web/style.md` §2 and are implemented in `apps/web/src/styles/global.css`.

- `student-day` — warm orange-red palette (`Brand-500 #ff6b35`), `Bg-Page #F5F0E8` (default)
- `student-night` — dark tea-gold, auto-activates 18:00–06:00 via Zustand themeStore
- `parent` — business blue-white, forced day mode

Night mode only applies inside `.student-theme-container` (learning immersion pages). Login, subject select, star map, and parent pages are physically excluded from night mode.

### School-level Font Scaling

`data-school` attribute (`primary`/`junior`/`senior`) adjusts font sizes only — colors and radii stay consistent across all levels.

### Visual Distinction: Dual-track

- Mainline: orange-red (`Brand-500 #ff6b35`, see `apps/web/style.md` §2.1)
- Auxiliary: brand orange (same as mainline; previously purple `Aux #8B5A8E`, now deprecated/unused)

Dual-track distinction is via TEXT labels (Tab titles, Tag text "辅线"/"主线"), not color. Physical isolation is ensured by routing (entry selection page, no cross-track links), not color contrast.

### Component Layers

- `src/components/base/` — Reusable UI primitives (Button, Input, Card, Modal, Toast, etc.)
- `src/components/business/` — Domain components (PlanetNode, SectionCard, AIDialogue, TextbookCard, etc.)
- `src/components/layout/` — Page shells (StudentLayout, ParentLayout with nav + header + outlet)

### Routing

React Router 6 with `createBrowserRouter`. Login auto-routes by username format: phone number → parent, otherwise → student.

### State

Zustand for theme/motion preferences. No API layer yet.

### Design Tokens

`src/tokens/` contains JSON files (colors, layout, typography) that are the source of truth for CSS variable generation.

## Mandatory Design Constraints

Before any UI work, read the authoritative docs:
- `docs/K12智学系统-产品需求文档.md` — PRD (single source of truth for all features)
- `docs/UX-UI设计文档.md` — Page specs and responsive rules
- `apps/web/style.md` — Color palette, typography, spacing, shadows, and component specs (the only style reference). Key sections:
  - §1 设计原则、§2 配色（统一一套，不分学段）
  - §2.5 登录页规范、§2.6 入口选择页规范
  - §8 学科选择页设计
  - §11 实施清单

Hard rules:
1. No emoji in UI/components/copy. Icons must be linear SVG.
2. No mascots or decorative elements (rainbows, balloons, stars).
3. Single unified color palette from style.md — no per-school-level color variations.
4. PRD overrides any design decision. Conflicts must be resolved with the user before implementation.
5. iPad landscape (>=1024px) is the primary breakpoint; PC (>=1280px) secondary; mobile deferred.
6. Socratic principle: "hint" and "discuss" buttons always more prominent than "show answer".
7. Mainline progression requires error-clearing before unlock — never skip this gate.
8. **No mini-program support**: the platform targets WebApp, PC App (Electron), and parent-facing Web only. Do not introduce WeChat mini-program, Alipay mini-program, or any other mini-program specific code, APIs, build targets, or documentation references.

## API 文档同步规则

`docs/API接口与数据流设计文档.md` 与 `docs/api/openapi.yaml` 互为对照，必须始终保持一致：

1. **任何一方变更时，另一方必须同步更新**。新增、删除或修改端点（路径、方法、参数、响应结构）时，两份文档都要一并调整。
2. **以 API 设计文档为主稿**：端点清单（§4）和数据流（§6）定义需求级别和业务语义；openapi.yaml 是其机器可读实现，用于代码生成和接口测试。
3. **阶段标记**：openapi.yaml 当前仅收录 MVP 阶段端点。P1/P2 端点在 API 设计文档中标注阶段，待进入开发时再补入 openapi.yaml。
4. **检查清单**：每次 API 变更后，运行 `grep` 或对比两文档的端点路径列表，确认无遗漏。

## Data Refinery 数据管线

`tools/data-refinery/` 是离线数据准备管线，四阶段顺序执行：

```
convert_cli (MinerU) -> extract_cli (LLM) -> publish_cli (物化图片) -> db_loader_cli (MySQL)
```

`refinery_cli.py` 串联 publish + db_loader 一键执行；DB 由 `tools/db/install_mysql.sh` 初始化（schema + subjects seed）。

**现状**：管线已端到端跑通（105 tests），DB `ai_k12` 有 34 cards + 466 questions。详细总结与后续见 `docs/data-refinery-管线总结与后续.md`。

**改代码前必读的关键约定**（详见上述总结文档 §3）：
- LLM 配置用 `.env` 的 `LLM_BASE_URL`/`LLM_AUTH_TOKEN`（refinery 专属），**不要用 `ANTHROPIC_*`**（会被 shell 里 Claude Code 覆盖）。当前用 DeepSeek `deepseek-v4-flash`（reasoner，需 `LLM_MAX_TOKENS=65536`）。
- extract：lesson_id 由 LLM 给标题标识 + CLI 跨页继承（per-book 状态）；只有编号标题（`N.M`/`N.M.K`/`第N章`）开新课；章综述归该章"第 0 节"；前置内容（封面/目录/版权/前言）不抽取；试卷答案只提取不生成（从参考答案按题号提取，无则空）。
- publish：资产路径用源相对稳定键；⚠️ `SUBJECT_CODE="math"` 硬编码是遗留 bug（化学资产路径误标）。
- db_loader：subject 别名归一（chem->chemistry）、rel_path/lesson_id 解析派生教材结构、cards sort_order 跨页全局重排、full-reload 幂等。
- DB：`ai_k12/ai_k12@localhost/ai_k12`（`.env` 的 `DB_*`）。

**下一个大件**：`apps/server` 的 HTTP API 层（把已实现的 ai-core 接到前端 `apps/web`）——前端 `apps/web` 还连不上 DB。ai-core AI Agent Hub 已实现（见下文 ai-core 节）；HTTP 端点已设计（`docs/api/openapi.yaml` + `docs/API接口与数据流设计文档.md`），等实现接入。


## apps/server - ai-core AI Agent Hub（已实现）

分支 `feat/ai-agent-hub-mvp`（已推送 origin）。两层架构：infra 层 + capabilities 层。tsc 通过、72/72 测试绿。

**目录** `apps/server/src/ai-core/`：
- `infra/` — ModelRouter、PromptBuilder、ModelClient（+Kimi/Qwen/DeepSeek/Gemini 适配器）、ResponseParser、SafetyGuard、FallbackHandler、Logger、Metrics
- `capabilities/` — Tutoring（9 步：loadContext->give-up/fallback->safety/block->route->build->call->parse->persist->failcount）、Grading、Explanation、Variation、Analytics
- `prompts/` — Mustache 模板（system/tutoring/grading/explanation/variation/analytics/fallback/safety）
- `*.yaml` — model-routes / retry / safety / fallback 配置
- `__tests__/` — 回归脚本（safety-classification 确定 26/26；grading-accuracy、tutoring-quality 需 API Key）

**技术栈**：Node.js + TypeScript ESM（`"type":"module"`）、Vitest、Zod、Mustache、prom-client、dotenv。

**改代码前必读的关键约定**：
- **ModelClient DI**：各 capability 构造函数接受 `opts?: { modelClient?: ModelClient }`，测试注入 mock（无 API Key 也能跑）。生产用 `new ModelClient()`。
- **PromptBuilder**：`customVariables`（`Record<string, unknown>`）已展平进 Mustache 视图，可传对象/数组（如 AnalyticsCapability 传 `stats` 对象，配合 `{{stats.x}}` 与 `{{#stats.topWeakPoints}}`）；**已关闭 HTML 转义**（LLM prompt 非 HTML，数学符号 `=<>` 必须原样保留）；`{{> partial}}` 加载 `system/*.md` 并剥 frontmatter；模板用 `## System Prompt` / `## User Message` 分段。
- **模型 ID（勿改）**：`kimi-latest`（Moonshot）、`qwen3.7-max`、`gemini-3.1-pro`、`deepseek-v4-flash`。配置里 kimi 的 key 是 `kimi` 但 modelId 是 `kimi-latest`。
- **API Key**：用 `.env` 的 `KIMI_API_KEY`/`QWEN_API_KEY`/`GEMINI_API_KEY`/`DEEPSEEK_API_KEY` 及对应 `*_BASE_URL`（ai-core 专属，**不要用 `ANTHROPIC_*`**，会被 shell 里 Claude Code 覆盖）。
- **错误处理**（基于 `../llm-client.js`）：provider 经 `classifyError`（`infra/model-client/errors.ts`）抛 11 个错误子类之一（`LLMClientError` 基类 + `AuthenticationError`401 / `InsufficientQuotaError`402·429-quota / `PermissionError`403 / `ResourceNotFoundError`404 / `RequestTooLargeError`413 / `ValidationFailedError`400·422 / `ContentFilteredError`406·SAFETY / `RateLimitError`429 / `ServerError`5xx / `TimeoutError`abort；retryable 由子类决定）；`ModelClient.chat` 用 `callWithRetry`（full-jitter 退避 + 遵守 Retry-After + onRetry 钩子）包装，非 retryable 立即抛。
- **Gemini**：system prompt 走 `systemInstruction`（不是 user 角色）；finishReason 映射 MAX_TOKENS->length、SAFETY->content_filter。**流式暂未实现**（streamGenerateContent 待配 GEMINI_API_KEY），`ModelClient` 对 gemini 强制 `stream=false` 非流式降级。
- **测试与文档同步铁律**：若测试断言与 config/types/设计文档的值冲突，**测试错**——改测试，勿改 config/设计文档。改代码或主文档时，同步更新所有引用该实现的设计/计划文档。

**已知限制**（本次未修，记录待后续）：metrics/logger 模块已实现但尚未在 capability 层接入；`detectWrongAnswer` 用正则推断学生答错（plan 设计，脆弱）；ConversationService 内存存储无 TTL/容量上限；缺 essay/reading/translation 评分模板（MVP 仅数学 proof/calculation）；部分 YAML 字段（classifier.confidenceThreshold、outputStructure、streaming.firstTokenTimeoutMs/interTokenTimeoutMs）为声明式意图未接线；gemini 流式（streamGenerateContent）未实现（待配 GEMINI_API_KEY，当前非流式降级）；流式 usage 尽力收（Kimi 流式不返回 usage，cost 可能 0）；`npm run build` 不拷贝 YAML/prompts 到 dist（生产部署需另加 copy 步骤）。

**实现记录**：计划草稿偏差与 code-review 修正详见 `docs/superpowers/plans/2026-07-23-ai-agent-hub-mvp-implementation.md` 末尾「实现修正记录」「代码审查后修正」两节。

**2026-07-24 修正**：① modelId 拼写 bug——`qwen-3.7-max` 改为 `qwen3.7-max`（dashscope 实际 ID，原配置多一短横线导致 404 model_not_found；全仓库含 model key/modelId/routes 引用/文档/测试统一替换）。② per-scene timeout 接线——`retry.yaml` 的 per-scene timeout 此前未接线（capability 调 chat 未传 timeout，走 kimi-client 硬编码 30000），现已在 tutoring/grading/explanation/variation/analytics + fallback-handler 的 chat 调用传 `timeoutConfig.timeout[scene] ?? timeoutConfig.timeout.default`，并调大取值（default 30000→45000、tutoring 15000→45000、variation 45000→60000、safety 5000→10000、新增 explanation:60000），解决 qwen3.7-max 生成长文本（如 fallback 完整解析）超时。③ SafetyGuard 误拦--`LEARNING_PATTERNS` 未覆盖含方程表达式但无学习关键词的消息（如「3x+5=14,x等于多少」），误判 off_topic 而 block；加代数方程识别正则（半角等号/变量项），不误伤「1+1等于几」（中文「等于」）。④ 错误模型 + 流式 + reasoning 重构--采用 `../llm-client.js` 错误体系（11 个错误子类 + `classifyError` + `callWithRetry` full-jitter 退避 + Retry-After + onRetry，替换 `ModelErrorCode`/`ModelClientError`/`RetryConfig`/`mapHttpError`）；`ModelClient.chat` 默认流式（聚合 `streamChat` 的 content + reasoningContent，gemini 降级非流式）；`kimi-client.streamChat` 读 `delta.reasoning_content`（thinking）；reasoning 透传到所有 capability 响应的 `reasoning` 字段。详见 `docs/superpowers/plans/2026-07-24-ai-core-error-streaming-refactor.md`。⑤ provider fetch 网络错误归一--`kimi`/`gemini`-client 的 `fetch` 加 try/catch，DNS/连接失败/abort 经 `classifyError(status=0)` 归一为 `TimeoutError`（此前 raw `TypeError` 逃逸未归一为 LLMClientError；用错误 baseurl 实测验证：重试 maxRetries 次后抛 `TimeoutError`，retryable=true，见 `__tests__/error-baseurl-test.ts`）。

---

**2026-08-09 修正（判题转圈 bug）**：① 判题模型切换--`model-routes.yaml` 的 `judgment`/`grading`（math）primary 由 `qwen3.7-max` 改为 `deepseek-v4-flash`，`qwen3.7-max` 降为 fallback。根因：qwen3.7-max 是 reasoner，难几何题实测 >90s 仍超时（判不动，非等不够），且 `callWithRetry` 把 abort 当 retryable（`errors.ts:169` 非 LLMClientError 默认 retryable=true）×3 次 ≈ 135s 转圈后 503。deepseek-v4-flash 同题 ~19s 判对（已用于 structuring），kimi/gemini 的 API key 为空（fallback 形同虚设）。② `streamChat` 丢 `response_format` bug--`kimi-client.ts` 的 `streamChat` 请求体未带 `response_format`（非流式 `chat()` 有），导致 `ModelClient.chat` 默认流式路径下 judgment/grading/structuring 的 `json_object` 约束被静默丢弃；已在 `streamChat` body 补齐，与 `chat()` 对齐。③ judgment timeout 45s->90s--deepseek 通常 <20s，偶发慢调用（reasoner 思考久）>45s 会触发重试放大（~107s），90s 让偶发慢调用一次成功（worst-case 卡死仍可能 3×90=270s，罕见；并行判题 UX 下仅末题可见）。④ 前端并行判题--`AnswerModal` 改为提交即切题（fire-and-forget `onSubmit`），后台并行判题；末题交卷后渲染"判题进度页"逐题显示判完状态，全部判完自动弹结果列表（`practiceStore` 增 `failed` 字段，`AnswerResultList` 失败条目显示"判定失败"）。⑤ judgment prompt（`math-calculation.md`/`math-proof.md`）要求公式用 `$...$` 包裹（原"LaTeX 原样保留"导致 AI 输出裸 `\frac{2}{3}`，KaTeX 不渲染、显示原始文本）。⑥ `fill_blank` 判题路由修正--原 `fill_blank` 与 choice/true_false 同属 `OBJECTIVE_TYPES` 走 exact，但答案形式多样（学生 `2/3` vs 题库 `$\frac{2}{3}$`）会误判错；现 `EXACT_ONLY_TYPES` 仅 choice/true_false，`fill_blank` 命中且归一化相等（`normalizeAnswer` 新增 `\frac{a}{b}`->`a/b` 递归）走 exact 省 AI，不等走 AI 复核（避免误判）。⑦ 判题进度页"已判完"图标由绿色对勾改中性实心圆点（绿色对勾易被误解为"答对"）。详见 `docs/superpowers/plans/2026-08-09-parallel-practice-judging.md`。

**2026-08-09 新增（课堂练习提示 AI 生成 + Card 级缓存）**：① DB--`cards` 表新增 `hints` 字段（TEXT，存 JSON 字符串 `{ "<题目文本>": "<提示文本>" }`，与同表 `content_metadata` 一致用 JS 读改写；`schema.sql` + DB 设计文档同步）。② ai-core 新增 `hint` 场景--`HintCapability`（镜像 `ExplanationCapability`，route->build->chat->parse text）+ `prompts/hint/math.md`（苏格拉底式提示，**只启发不给答案**，遵循 CLAUDE.md 规则 6；公式用 `$...$`）；`types.ts` 的 `Scene`/`CapabilityType` 加 `'hint'`，新增 `HintRequest`/`HintResponse`；`prompt-builder.ts` 加 `capability==='hint'` -> `hint/${subject}.md`；`model-routes.yaml` 加 `hint` 场景（math: primary `deepseek-v4-flash`、fallback `qwen3.7-max`，轻量任务用快模型同 judgment/grading）；`retry.yaml` 加 `hint: 45000` timeout。③ practice 模块新增 `POST /api/practice/hint`--`PracticeService.getHint` 先查 `cardsRepo.findHintsById` 命中直返（`cached:true`，不调 AI），未命中调 `HintCapability.generate` 后 `cardsRepo.upsertHint` 写回（`cached:false`）；AI 失败抛 503 `code=5001`（前端降级，不阻断答题）。`CardsRepository` 新增 `findHintsById`/`upsertHint`（读改写，并发偶发覆盖可接受，结果幂等）。④ key = 题目文本（即「题目标题」），与 judge 流程传的 `questionText` 一致自洽；缓存是 Card 级共享（不分学生），同一题对所有人用同一提示，最大化省 AI。⑤ 前端--`AnswerModal` 点提示先查 `practiceStore.hints[q.n]`（session 缓存）命中直显，未命中显示 spinner 调 `/api/practice/hint`，结果用 ReactMarkdown+KaTeX 渲染（提示含 `$...$` 公式）；失败降级静态文案。`practiceStore` 增 `hints`/`setHint`（session 缓存免重复请求），`setSession`/`reset` 清空。⑥ 文档同步--`openapi.yaml` 加 `/practice/hint` + `HintRequest`/`HintResult` schema；API 设计文档 §4.16 加端点行、§6.10 加数据流、版本日志 v1.3。详见 `docs/superpowers/plans/2026-08-09-practice-hint-caching.md`。

**2026-08-09 P3｜大模型错误人类可读 + 不落库**（`docs/superpowers/plans/2026-08-09-aux-image-two-stage-and-error-retry.md` §3/§4）：① 新增共享错误映射 `mapLLMErrorToClient(err)`（`infra/model-client/errors.ts`）--把 [errors.ts](apps/server/src/ai-core/infra/model-client/errors.ts) 的 11 个 `LLMClientError` 子类映射成 `{ code, message, retryable }` 三元组（人类可读中文文案）：1005 欠费/1006 鉴权/1007 权限/1002 模型不存在/1010 内容违规/1011 请求过大/1001 参数有误（均不可重试）；1008 限流/1009 超时/1012 网络不通/5001 服务错误/5000 未知（均可重试）。② `ai.service.ts mapLLMError` 改调该映射，HttpException response 透传 `retryable`（异常过滤器已透传 `...rest`）；`tutoring.capability.ts` 流式 mid-stream 错误从 `yield {type:'error',message}` 改为 `yield {type:'error',code,message,retryable}`；`ai.controller.ts` pre-stream 错误同透传；`StreamEvent` 类型加 `code?/retryable?`。③ **AbortError（用户点停止）单独处理**：持久化 partial 内容但不发 error 事件；**模型错误只持久化 user 消息、不落库 assistant 错误**（决策11：刷新回到"末条 user 待重试"）。④ 前端--`ApiError` 加 `retryable`；`chatStore` `ChatMessage` 加 `error` 字段 + `setLastAssistantError` action（清 content、置 streaming:false）；`useAuxChat` error 事件/REST 兜底失败走 `setLastAssistantError`（不再吞 `ApiError`、不再写 `[生成中断]/[网络异常]` 通用文案），严重错误（1005/1006/1007）额外 `toast`；`AuxChatPanel` 新增 `ErrorBubble`（红底 + 错误图标 + 文案，retryable 时提示可重试，重试按钮 P2 接）。⑤ 验证：tsc + 136 测试绿；实测出错会话只落 user 消息、无 assistant 错误。**待办**：openapi/API 设计文档补错误码 1005-1012 + SSE error 事件字段（随 P1 一起同步）；重试按钮 + retry() 属 P2。

**2026-08-09 P2｜错误重试**（`docs/superpowers/plans/2026-08-09-aux-image-two-stage-and-error-retry.md` §5）：① 后端 `TutorDto`/`TutoringRequest` 加 `retry?:boolean`；`ai.service.ts buildRequest` 透传；`tutoring.capability.ts tutorStream` 在 `request.retry` 时**只持久化 assistant、不重复落 user**（user 已在出错时落库）--成功/中止路径 conditionally 拼 userMessage，错误路径 retry 时跳过 saveMessages。② 前端 `chatStore` 加 `resetLastAssistantToStreaming`（错误气泡/末条待重试 -> 重置为 streaming 占位）；`useAuxChat` 新增 `retry()`--复用 `lastSendRef` 缓存的上次发送上下文（或从 store 末条 user 消息重建，处理刷新后待重试），带 `retry:true` 重调 `streamTutor`/`fallbackToRest`；`streamTutor`/`fallbackToRest`/`tutor()` 加 retry 形参。③ `AuxChatPanel` 错误气泡（retryable 时）加"重试"按钮；末条 user 消息无回复时显示"未收到回复 + 重试"；`AuxiliaryHomePage` 接线 `onRetry={retry}`。④ 决策10（只重做出错阶段）当前 stage 固定 `'tutor'`（图片两阶段 P1 后才需区分 transcribe/tutor）。⑤ 验证：tsc + 136 测试绿；实测 `retry:true` 只追加 assistant、不重复 user。**待办**：openapi/API 文档补 retry 字段（随 P1 一起同步）。

**2026-08-09 P1｜图片两阶段 + 状态机**（`docs/superpowers/plans/2026-08-09-aux-image-two-stage-and-error-retry.md` §6）：① DB--`ai_dialogues` 加 `flow_state`(VARCHAR30, idle|awaiting_selection|awaiting_confirmation) + `pending_question` + `pending_questions`（`schema.sql` + `AiDialogueRow` + repo `updateFlowState` + `ConversationService.updateFlowState`/`loadContext` 透出）。② 模型--`model-routes.yaml` 加 `qwen3-vl-plus`（转录用，不开 thinking）+ `transcribe` 场景路由（fallback qwen-vl-max）；`model-router.ts` **移除 hasImage 辅导覆写**（辅导永远走 qwen3.7-max，图片改由 transcribe 场景单独处理）；`retry.yaml` 加 `transcribe: 60000`。③ prompt--新建 `prompts/transcribe/math.md`（VL 转录：题干文本 + 几何图括号描述 + 多题编号 + JSON 输出 `{recognizable,problems:[{index,text}]}`）；选择分类 prompt 内联在 `classifySelection`。④ capability--`TutoringCapability` 新增 `transcribeImage`（VL+JSON）、`classifySelection`（deepseek-v4-flash 分类 select/all/unclear）、`augmentWithImages`/`extractJsonObject`/`parseTranscribeResult`/`parseSelectionResult` 辅助；`StreamEvent` 加 `flow` 类型 + `stage/problems/question`；`SaveMessageEntry.type` 加 `'transcription'`。⑤ service--`ai.service.ts` `tutorStream` 改为按 `flow_state` 编排：idle+图->转录(confirm/select/unrecognizable)、awaiting_selection->分类、awaiting_confirmation+confirm->用 `pending_question` 走 qwen3.7-max 辅导(回 idle)、+reidentify->重转录、+correct->改 pending_question；`TutorDto`/`TutoringRequest` 加 `flowAction`(confirm|reidentify|correct)；`validateDto` 放宽(图/flowAction 允许空 message)；注入 ai-core `ConversationService`。⑥ 前端--`chatStore` 加 `flow` 字段 + `setLastAssistantFlow`；`useAuxChat` 处理 flow 事件(渲染转录/列表/无法识别 + 流 UI)、`send` 支持 flowAction(确认阶段打字=correct)、新增 `confirmQuestion`/`reidentify`；`AuxChatPanel` 渲染确认按钮 + 选择提示；`AuxiliaryHomePage` 接线。⑦ 验证：tsc+137 测试绿；浏览器端到端实测 图片->转录->选第1题->确认->qwen3.7-max 辅导(带思考链)->题入库(2786)；"全部都要"被拒。**移除**了旧的多题澄清 prompt 驱动（[auxiliary.md](apps/server/src/ai-core/prompts/tutoring/math/auxiliary.md) 的图片/多题段待精简）。**待办**：openapi/API 设计文档补 flow 事件 + flowAction + 错误码 1005-1012；auxiliary.md 精简图片段；REST 兜底(/api/ai/tutor)未接 flow_state 编排（流式失败兜底时图片流程会降级，罕见）。

## 双轨需求与前端风格（2026-07-27 锁定，2026-07-28 细化）

双轨需求已锁定并同步文档：主轨学习先行实现（登录->入口选择页->学科选择->星图），辅轨答疑暂不实现仅保留入口占位。

前端风格已对齐参考实现（`http://localhost:3000`）：
- 背景色统一为暖米白 `Bg-Page #F5F0E8`；
- 登录/入口/选科页采用独立白卡片、24px 大圆角、柔和分层阴影；
- 图标统一为线性 SVG 书形，可选态使用 `from-[#FF6B35] to-[#FF8C61]` 渐变徽章，锁定态使用 `opacity-55` + 灰渐变徽章；
- 标签使用 30px / font-black / tracking-tight；
- 选科页显示「你好，{用户名}！」问候语；
- PRD/UX/DB/data-refinery 文档已同步，`global.css` 与 `style.md` 一致，前端页面遵循简约风格（图标+词，去冗余文字，问候语除外）。

相关规范已写入 `apps/web/style.md` §2.5、§2.6、§8。
