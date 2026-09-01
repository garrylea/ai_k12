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

**现状**：管线已端到端跑通（refinery 237 tests 全绿、crawler 200 tests；2026-08-26 实测 `refinery_cli --purge-business-data` 全量重载 342 cards + 447 questions 成功，含幂等重跑与守卫复验）。详细总结与后续见 `docs/data-refinery-管线总结与后续.md`，使用见 `docs/data-refinery-使用手册.md`。

**改代码前必读的关键约定**（详见上述总结文档 §3）：
- LLM 配置用 `.env` 的 `LLM_BASE_URL`/`LLM_AUTH_TOKEN`（refinery 专属），**不要用 `ANTHROPIC_*`**（会被 shell 里 Claude Code 覆盖）。当前用本地 llama.cpp `Qwen3.8-27B`（`LLM_PROVIDER=local`、`LLM_BASE_URL=http://192.168.1.8:12345/v1`，2026-08-26 起 Card 标注/目录解析走本地模型；`.env` 里注释保留了原远程 DeepSeek `deepseek-v4-flash` 配置可切回）。
- extract：lesson_id 由 LLM 给标题标识 + CLI 跨页继承（per-book 状态）；只有编号标题（`N.M`/`N.M.K`/`第N章`）开新课；章综述归该章"第 0 节"；前置内容（封面/目录/版权/前言）不抽取；试卷答案只提取不生成（从参考答案按题号提取，无则空）。
- publish：资产路径用源相对稳定键；subject 按文件路径首段推导（2026-08-26 前曾硬编码 "math" 误标化学，已修）。
- db_loader：subject 别名归一（chem->chemistry）、rel_path/lesson_id 解析派生教材结构、cards sort_order 跨页全局重排、full-reload 幂等；**full-reload 有业务数据守卫**（见 2026-08-26 note）；**版次（edition）维度**--textbook_versions 按 `(subject_id, publisher, grade_band, edition)` 4 元组唯一，edition 从书名前导括号提取（见 2026-08-31 note）。
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

**2026-08-09 新增（课堂练习「让 AI 讲一讲」- 弹窗内苏格拉底讨论）**：① 复用 `/api/ai/tutor`+`/ai/tutor/stream`（mode=mainline）做苏格拉底多轮讨论，`prompts/tutoring/math/mainline.md` 已是苏格拉底式 + 严格限定卡片范围 + 3 次失败兜底，服务端对话部分零改动。② **修 mainline cardContent gap**（必须）--`loadContext` 此前 `cardContent:undefined`（注释自承未接线）、`ConversationsService.create` 硬编码 `card_id:null`，导致 mainline.md 的 `<card_content>` 为空、AI 无范围边界；现 `create` 接受 `cardId` 存 `card_id`、`loadContext` 注入 `CardsRepository.findContentById` 解析 card content 作 `cardContent`（auxiliary 无 card_id 行为不变，additive）；`ai.service.resolveDialogue` 传 cardId（mainline）；`AIModule` providers 加 `CardsRepository`。③ 新增 `POST /api/practice/discuss`--`PracticeService.startDiscuss`：`questionsRepo.findByContentHash` 快查 questionId（不调 AI 结构化，未命中 null）-> `mainErrorRepo.findUnclearedByStudentQuestion` 幂等查（新增 repo 方法，无 `(student_id,question_id)` 唯一约束故应用层 find-or-create）-> 无则 `create(source='discuss',source_ref_id=cardId)` -> `conversationsService.create(track='mainline',cardId)` 返回 dialogueId；`PracticeModule` import `ConversationsModule`。**打开讨论即入错题本（无论后续答对答错都保留）**--`markCleared` 全仓库无调用方，清除门禁尚未实现，故"答对也保留"自然成立。④ 前端--`api.ts` 放宽 `tutor()` mode 为 `mainline|auxiliary`、新增 `startDiscuss` + 共享 SSE `streamTutorEvents`（仿 `streamExtraction`，useAuxChat 不动避免回归）；`useDiscussChat` hook（本地消息状态，不与辅线 chatStore 冲突）：首开调 startDiscuss 缓存 dialogueId 后自动发**种子消息**（"我想请你带我思考这道题…请用提问的方式一步步启发我"，⚠️避开 giveUpKeywords 否则首轮触发兜底给答案），重开续接拉历史；`DiscussDrawer` 组件（AnswerModal 内右侧抽屉，实色背景，手动开/关/放大缩小，不自动收起），复用 AuxChatPanel 的 Markdown+KaTeX+ReasoningBlock 呈现风格；`practiceStore` 加 `discussDialogues`（key=questionText->dialogueId）session 缓存续接；`AnswerModal` 的 `handleDiscuss` 由跳占位页改为开抽屉（加 `subjectId` prop），`CourseDetailPage` 传 `subjectId`。⑤ 文档同步--openapi 加 `/practice/discuss`+`DiscussRequest`/`DiscussResult`；API 设计文档 §4.16 加端点、§6.11 加数据流、版本日志 v1.4。⑥ 验证：server tsc + 141 测试绿（含 startDiscuss 4 例 + findUnclearedByStudentQuestion 2 例）；web tsc 绿。详见 `docs/superpowers/plans/2026-08-09-practice-discuss-drawer.md`。

**2026-08-10 新增（卡片级「思辨答疑」右侧抽屉 + 题目级/卡片级讨论历史续接 B方案）**：① 题目级历史续接：`main_error_books` 表新增 `dialogue_id`；`startDiscuss` 复用错题本上已绑对话，失效则重建并回写；跨刷新/跨设备回到同一讨论线。② 卡片级历史续接：新增 `POST /api/practice/discuss-card`，`startCardDiscuss` 按 `(student_id, card_id, track='mainline')` find-or-create 对话（不入错题本，锚=卡片本身）。③ 前端--抽离共享 `DiscussChat`（消息列表+输入+Markdown/KaTeX/ReasoningBlock 原语），`useDiscussChat` 加 `mode:'question'|'card'`；卡片级抽屉在 CourseDetailPage `<main>` 内贴右，宽度限定在右侧主内容区（缩小约45%/放大封顶约70%），不覆盖左侧阶段栏；题目级抽屉仍在 AnswerModal 内（缩小55%/放大铺满）。④ 类型加固：`CreateConversationDto` 加 `cardId?:number`。⑤ 验证：server tsc + 147 测试绿、web tsc 绿。详见 `docs/superpowers/plans/2026-08-09-card-level-discuss.md`。

**2026-08-11 新增（课堂练习对错持久化）**：① DB--新建 `practice_results` 表（一行=学生×卡×题判题结果，UNIQUE `student_id+card_id+question_n` 支撑单题重做 upsert；`schema.sql` + 迁移 + 触发器 + DB 设计文档同步；顺带修正 `main_error_books` 列表陈旧的 `lesson_id`/`dialogue_id`/`discuss`；`practice_results.subject_id` 加 FK->subjects ON DELETE RESTRICT 对齐 `main_error_books`）。② `PracticeResultsRepository`（`upsert` 走 `INSERT ... ON DUPLICATE KEY UPDATE`、`findByStudentCard`、`deleteByStudentCard`/`deleteByStudentLesson`，best-effort 由 `judge` try/catch）。③ `judge()` 改造--`JudgeInput` 加 `questionN`；对/错都 best-effort upsert `practice_results`；**答错改 find-or-create 错题本**（`findUnclearedByStudentQuestion` 命中复用、未命中才 create，避免重复答错堆积，孤儿题回滚补偿仅新建分支保留）；**答对调新方法 `clearUnclearedByStudentQuestion`**（镜像 find 条件批量 `is_cleared=1`，不限 source，影响跨课门禁计数；接线此前未接线的 markCleared 语义）。④ 新端点 `GET /api/practice/results?cardId=`（取持久化结果）、`DELETE /api/practice/results?cardId=|lessonId=`（单卡/课程级 reset，互斥校验，只删 `practice_results` 不动 `main_error_books`）。⑤ 前端--`practiceStore.loadResults`（合并语义：同卡重入保留在途作答、DB 填空缺，防加载晚于作答覆盖）；`CourseDetailPage` 进卡 effect 拉取结果回显 ✓/✗、`handleOpenModal` 不再 `setSession` 清空、reset 工具条（重置本卡/清空本课）、`onSubmit` 直传 `n`（消除题面文本反查）；**`AnswerResultList`「完成」由 `onRetry` 改 `onClose`、移除 `reset()`**（修核心 bug：关闭结果表单不再清空 ✓/✗）。⑥ 验证：server tsc + 172 测试绿、web tsc 绿。详见 `docs/superpowers/plans/2026-08-11-practice-results-persistence.md`。

**2026-08-12 修正（错题清零门禁不触发）**：根因--原 `GET /practice/previous-errors`（计数读 `main_error_books`）与 `GET /practice/previous-error-details`（详情以 `practice_results` 驱动匹配 `main_error_books`）数据源不同；`practice_results` 缺失（08-11 持久化上线前的历史错题 / `resetPracticeLesson` 清空 / upsert 失败）时计数>0 但详情为空，前端条件 `previousErrorCount>0 && cleanupErrors.length>0` 为 false，CleanupPhase 不渲染。① 设计改为「进每节课前清空错题本里所有 practice 未清题」（不限课时，兜住历史/跳过/孤儿错题，更贴合 PRD 规则 7「never skip gate」）。② DB--`main_error_books` 新增 `question_n VARCHAR(20)`（迁移 `2026-08-12_add_main_error_books_question_n.sql` 从 `practice_results` 回填 + `apps/server/src/scripts/backfill-error-question-n.ts` 按 `card.content_metadata` 题面匹配回填历史行；`judge`/`startDiscuss` 写入带上）。③ 后端--`MainErrorBooksRepository.findUnclearedPracticeByStudentSubject`（LEFT JOIN `questions` 补题面，`COALESCE(q.content, wrong_answer_text)`）；`PracticeService.getUnclearedErrorDetails`（按 `(cardId, questionN)` 去重保留最早一条；`question_n` 缺失合成 `cleanup-<id>` 唯一键）；移除 `countUnclearedByLesson`/`findUnclearedByStudentLesson`/`findWrongByStudentLesson` + `LessonsRepository` 注入（`findPreviousLessonId` 不再用于门禁）。④ 端点合并为单一 `GET /api/practice/uncleared-errors?subjectId=`（计数=`errors.length`，与详情同源）+ `POST /api/practice/bump-error-levels`（清零后仍错递增 level）；移除 `previous-errors`/`previous-error-details`。⑤ 前端--`getUnclearedErrors(subjectId)`；`CourseDetailPage` 渲染条件简化为 `cleanupErrors.length>0 && !cleanupDone`，侧边栏文案改「错题清零」+ 总数。⑥ 文档同步--openapi/API 设计文档 §4/§6.13/§P2.2/版本日志 v1.8、DB 设计文档 v1.6。⑦ 验证：server tsc + 172 测试绿、web tsc 绿。**遗留**：并发判题导致同题多条 `main_error_books` 行（如 question_id=2776 出现两次），详情端点按 `(cardId,questionN)` 去重展示，但题面变体产生不同 question_id 的重复行需多轮清零逐步消除；`question` 表按 `content_hash` 去重在题面文本变体（如「多2」vs「多 2」）时失效，是数据质量后续项。

**2026-08-14 修正（练习 reset UI 重组 + 错题清零跳过移除 + 显示逻辑校正 + ESLint 接入）**：① reset UI 重组--H1 标题行橡皮擦按钮（仅 practice 卡）由课程级 `resetPracticeLesson`（「清空本课练习」）改为单卡级 `resetPracticeCard`（「重置本卡」）；**橡皮擦 `.then` 回调用 `clearAnswers()` 而非 `reset()`**（`reset()` 是整课/换课级清空，会连带清掉 session 级 `hints`/`discussDialogues` 缓存且语义像「清空整课」；单卡橡皮擦只应清本卡 `answers`，`clearAnswers()` 保留 cardId/questions/hints/discussDialogues。后端 `resetCard`->`deleteByStudentCard` 仅 `DELETE FROM practice_results WHERE student_id=? AND card_id=?` 删本卡，本就正确）；左侧栏用戶登录区上方新增「重置本课错题」按钮（`resetPracticeLesson`，`border-t/b` 分割线与上方阶段状态/下方登录区分隔，清零进行中 `cleanupErrors.length>0 && !cleanupDone` 时隐藏）；移除练习卡内容区内的「重置本卡」文本链接（遗留自 a4223d2，ef5e2aa 把课程级按钮移出卡片时未清理）。**后端 reset 端点未变**（`DELETE /practice/results?cardId=|lessonId=`，仅删 `practice_results` 不动 `main_error_books`），openapi/API 设计文档 §6.14 无需改。② 错题清零跳过移除--`CleanupPhase` 移除「跳过清零，开始学习」按钮（`handleSkip`+`cancelledRef`+跳过 UI）。门禁不再可跳过；学生答完仍有错题时经 `hasErrors`->`onComplete(false)` 进入学习，仍错题由 `bumpErrorLevels` 升级 level 留待下次上课清零（契合用户决策：不必一次性全清，遗留错题下次继续；注意与 PRD §6.1「必须先清除所有主线错题」的严格表述存在张力，按用户明确意图保留 carry-over）。③ 错题清零显示逻辑校正--`onComplete` 恢复 `(allCleared) => { setCleanupDone(true); if (allCleared) setCleanupErrors([]); }`：仅当存在未清错题时侧栏显示「错题清零」（进行中='current'），全部清零或无错题时隐藏；撤销此前误改（清零后仍保留 'completed'）。即 2026-08-12 原始逻辑本就正确，此前「不显示」的 bug 报告为误解。④ ESLint 10 接入--`apps/web` 安装 `eslint@10`+`@eslint/js`+`typescript-eslint@8`+`eslint-plugin-react-hooks@7`（仅启用 `rules-of-hooks`/`exhaustive-deps` 两条经典规则，不启 v7 新严格规则避免既有代码误报）+`eslint-plugin-react-refresh`+`globals`；新建 `eslint.config.js`（flat config）；`lint` 脚本 `eslint . --ext .ts,.tsx`->`eslint .`（flat config 不需 `--ext`）；`no-irregular-whitespace` 加 `skipRegExps:true`（CJK 正则范围合法用全角空格 U+3000）。修复 11 个既有 error（`no-explicit-any` 6 处 catch/JSX 改 `unknown`+类型收窄、`no-useless-escape` `[\.\)]`->`[.)]`、`no-constant-binary-expression` 移除不可达 `?? 0`、`no-irregular-whitespace` 经 `skipRegExps` 解决）。剩 7 个 warning（`exhaustive-deps` 5+`react-refresh` 2，均为既有、可接受）。⑤ 验证：web `tsc -b`+`npm run lint`（0 error）绿；`CleanupPhase` 全程无 lint 问题，`CourseDetailPage` 的 lint 修复均在无关行，不影响 reset/清零逻辑。⑥ 文档：API/DB 未变，openapi/API 设计文档/DB 设计文档无需同步；`docs/superpowers/` 下 2026-08-10/11 的 plan/spec 为历史记录（描述当时的 reset 工具条/跳过按钮设计），按惯例不回改，以本 note 为准。

**2026-08-14 新增（三角色账号体系：管理员/家长/学生）**：分支 `feat/parent-admin-account-system`，spec/plan 见 `docs/superpowers/specs|plans/2026-08-14-parent-admin-account-system*.md`。① DB--新增 `admins` 表（username/password_hash/is_active/软删），`parents`/`students` 加 `is_active`（停用=登录被拒、数据保留；parents 字段为管理员台子项目占位）；迁移 `2026-08-14_add_admins_and_active_flags.sql` + schema/DB 设计文档 v1.7。② 统一三角色登录--`POST /api/auth/login` 按 admins(username)->parents(手机号正则)->students(username) 顺序查询命中，签发带 `role:'admin'|'parent'|'student'` 的 JWT（学生带 `familyId/parentId`，家长/管理员不带；`JwtUser.familyId` 改可选）；停用账号返回 `1003 账号已停用`。`POST /api/auth/register` 改家长注册（**注册即登录**直接发 parent token），学生自主注册下线（PRD §7.8）。③ 角色守卫--`RolesGuard`（已存在未接线，本次补 401/403 显式异常）+ `@Roles('student')` 接线到 practice/ai/conversations/progress 四控制器（家长/管理员 token 调学生接口 403/1005）。④ ParentModule--`/api/parent/students` GET 列表（脱敏）/POST 新建（grade 推导 school_level + 连带建 student_settings）/PATCH `:id/reset-password`/PATCH `:id/status`；归属校验先查存在（1002）再比 parent_id（1005，不泄漏存在性）。⑤ 登录限流--`ThrottleInterceptor`（内存计数，10 次/分/IP，超限 `429 1008`）。⑥ seed--`scripts/seed-admin.ts`（读 `.env` 的 `ADMIN_INITIAL_USERNAME/PASSWORD`，幂等；顺带确保占位家长 id=1 存在接管存量学生）。⑦ 前端--登录按返回 role 路由（admin->/admin 占位页、parent->/parent/students、student 不变）；`RequireRole` 路由守卫；新 `RegisterPage`（家长注册）+ `ParentStudentsPage`（建/列表/重置密码/停用启用，base 组件 + parent 主题变量）；`api.ts` 三角色类型 + 家长侧 API。⑧ 错误码实现注（API 设计文档 §2.4）：1003=未登录/密码错/停用、1004=手机号或用户名已存在、1005=无权访问/无权操作该学生、1008=登录限流。⑨ 验证：server tsc+202 测试绿（auth 8 + roles guard 3 + parent 8 新增）、web tsc+lint 0 error、curl 端到端验收全过（含越权/限流/幂等）。**局限（待后续子项目）**：无刷新 token；管理员无改密 UI；家长无改自己密码；管理员中枢（模型配置/封禁/推送/AI 聊天）、家长学情、计费、BYO model 均未实现（本子项目仅账号地基）。

**2026-08-18 新增（管理员中枢）**：① 模型配置动态化--`llm_models`/`llm_routes` 落库为运行时真源（YAML 兜底 + seed 脚本 `seed-llm-config.ts`）；`ModelConfigRegistry` 单例内存快照（AppModule 启动 ConfigModule reload，DB 空/失败回落 YAML）；`ModelRouter`/`ModelClient` 改造 apiKey 随模型条目走（`RoutedModel`），支持 `openai_compatible` 自定义 OpenAI 兼容模型；管理台保存即 reload 生效无需重启。② apiKey 安全--AES-256-GCM 加密落库（`common/utils/api-key-crypto.ts`，密钥 `.env` 的 `LLM_CONFIG_ENC_KEY`，未设用 dev key 仅本机），接口只返回打码。③ 封禁即时生效--`BanRegistry` 进程内 Set + `AuthMiddleware` 拦截旧 token（重启从 DB is_active=0 重建，`CommonModule` 单例共享），封家长连带封其名下学生。④ 站内消息中心--`parent_messages`(parent_id NULL=广播)+`message_reads`(广播已读 upsert)；admin 发送/撤回（DELETE `/api/admin/messages/:id`），家长侧 GET `/api/parent/messages*` 列表/未读/标已读 + 铃铛徽章。⑤ 管理员 AI 聊天--独立 `admin_dialogues`/`admin_messages` 表（不复用学生链路）、无 K12 学习边界、SSE 流式 `POST /api/admin/chat/stream`、新建会话自选模型、管理员可见自己的会话。⑥ 前端--`AdminNav` 侧栏 + 六页（总览/模型配置/账号管理/消息推送/AI 助手/账号安全）+ 家长消息中心；`AdminLayout` 升级。⑦ 验证：server 243 测试绿（新增 ~20）+ web build/lint 0 error + curl 端到端全过（模型池 CRUD/路由保存即生效/封禁旧 token 即时 401/消息广播已读回传/管理员聊天 SSE+落库）。**局限（待后续）**：BanRegistry 单进程（多实例需 Redis）；广播触达数=活跃家长数近似；`validate-connection` 超时后底层请求后台跑满自身超时；admin chat 客户端断开未中断上游 fetch；管理员角色细分（超管/普通）未做；模型调用计费/用量未做。

**2026-08-26 修正（数据管线一键入库 FK 阻断 + 爬虫/管线腐化测试 + 手册补全）**：① db_loader full-reload 业务数据守卫--`DELETE FROM questions`/`textbook_versions` 会被 apps/server 后加的业务表 FK（`answers`/`main_error_books`/`aux_error_books`/`variation_questions` 对 questions 的 RESTRICT；`progress.textbook_version_id` RESTRICT；`homeworks->lessons` 级联被 `homework_submissions` RESTRICT 挡住）阻断，一键 `refinery_cli` 在有业务数据的库上中途失败。修复：`DbLoader` 新增 `business_data_summary()`（预检，`_table_exists` 兼容 schema.sql 与线上库漂移如 aux_error_books）+ `purge_business_data()`（按 FK 安全序清空：error_redo_logs/answers/aux_error_books/main_error_books/variation_questions/homework_submissions + progress 中 textbook_version_id 非空行）；CLI 加 `--purge-business-data`（默认遇业务数据**报错退出**并提示两条出路：显式 purge 或 `--load-cards` 增量），`refinery_cli` 透传。② 爬虫 `--dry-run` 污染 checkpoint bug--`zgkao.py` dry-run 下仍 `mark_downloaded(item.id)`，后续真实爬取整批跳过；dry-run 不再标记（smartedu 本就正确）。③ 恢复 extract 断点续传 lesson 继承回归--skip 分支「从已抽页 jsonl 回填 per-book 状态」（`_last_lesson_id`）在重构中丢失，恢复。④ 修腐化测试 21 项：crawler 4 个（smartedu 测试 fake fetcher 缺 `fetch_head`，加 `NoHeadFetcher` 基类）+ 网络烟雾测试（上游 tag JSON 已改 hierarchies 结构，重写为验证 version/分片/tag_list 对象格式三件套）+ refinery 6 failed（extract_cli 测试 mock 已不存在的 `Extractor`，改 mock `CardLabeler`；convert resume 断言改适配新设计--resume 已移入 `MineruRunner.run`）+ 9 集成 error（fixture 加业务数据守卫：默认 skip，`REFINERY_TEST_PURGE=1` 才清空后跑）。⑤ 手册补全--使用手册修 5 处 TOC 路径错例（实际 `output/toc/{学科}/{学段}/{版本}/{年级}/{册次}/{书名}.json`）、补 extract 三节流参数（--interval/--batch-size/--batch-sleep）、--output-dir 语义（convert/extract 是输出根）、FK 守卫+FAQ；crawler README 补 refinery 衔接章节/--no-latest-only/旧版 main.py 参数/Python 3.10+/页数获取设计勘误（HEAD 二分探测）；.env.example 补 LLM_AUTH_TOKEN/DB_*/REFINERY_*；refinery README 目录树/三模式/env 表更新。⑥ SUBJECT_CODE 硬编码修复--`publish_cli.py` 资产路径前缀由硬编码 `math` 改为按文件相对路径首段（中文学科名）推导（`_subject_code_for`，映射与 db_loader 一致，识别不出回退 math），化学等学科资产路径不再误标（回归测试覆盖）。⑦ `migrate_flat_to_groups.py`/`backfill_practice_content.py` 的 `DB_PASSWORD` 误用改 `DB_PASS`（与 config.py 一致，此前仅默认值撞对才工作）。⑧ 验证：crawler 200 tests 绿 + 网络烟雾 1 过；refinery 237 tests 全绿（业务数据清空后 9 个集成测试恢复运行）；端到端实测 `refinery_cli --purge-business-data` 全量重载 342 cards + 447 questions、幂等重跑一致、造业务数据后守卫正确拦截+提示。⑨ Card 标注模型切本地--`.env` 由远程 DeepSeek（anthropic 兼容路径）切到本地 llama.cpp `Qwen3.8-27B`（`LLM_PROVIDER=local` + `LLM_BASE_URL=http://192.168.1.8:12345/v1`，原配置注释保留可切回）；`create_llm_client` 对 local provider 无 key 时补哑 `api_key="local_key"`（OpenAI SDK 拒空 key，本地 server 不校验鉴权）；冒烟实测连通。⑩ refinery_cli 透传 bug 修复--`--purge-business-data` 曾同时传给 publish_cli（其无此参数，argparse 报错中断），改为只传 db_loader_cli（`_loader_args`）。**遗留**：MinerU 安装说明已补（手册 §2.2）；限速语义（crawl_delay 仅重试间隔生效）已在 README 如实标注；已发布数据的 published JSONL 未用本地模型重新抽取（现有 extracted 产物仍是 DeepSeek 生成；如需用 Qwen3.8-27B 重抽需先 5 条验证再确认，见 memory 规则）。

**2026-08-31 新增（textbook_versions 版次维度 edition）**：背景--2024 新版人教版九上数学（书名「（根据2022年版课程标准修订）义务教育教科书·数学九年级上册」）入库时与 2012 版撞同一 textbook_version（此前仅 `subject+publisher+grade_band` 唯一），落到同一 semester 互相覆盖卡片（`_replace_semester_cards` 静默替换）+ 混合 lesson 骨架。修复：① DB--`textbook_versions` 加 `edition VARCHAR(50) NOT NULL DEFAULT ''`（书名前导括号内容，如「根据2022年版课程标准修订」，空=旧版 2012 课标）+ 唯一键 `uniq_textbook_versions_edition (subject_id, publisher, grade_band, edition)`；迁移 `2026-08-31_add_textbook_versions_edition.sql`（存量行 edition='' 与旧书名推导兼容，无需回填）。② db_loader--新增纯函数 `edition_from_book_name`（前导全/半角括号提取；**只用括号内容不用完整书名**，九上/九下归同一版次）；`_find_or_create_textbook_version` 查/插改 4 元组（code 仅展示用，edition 非空时拼入）；`_lookup_semester`/`load_toc_structure`（TOC 文件名剥 `.merged` 取书名）/`load_book_cards` 动态路径均接版次。③ 不用随机值做 code--破坏 find-or-create 幂等。④ 验证：refinery 386 tests 绿（新增 edition 单测 + `_make_loader` 补缓存字典初始化）；真实库实测旧书名命中存量行 275、新版建新行、幂等重查一致（测试行已清理）。⑤ 文档同步：DB 设计文档 v1.9、使用手册 §4.5、管线总结 §3、本文件。**注意**：新版书目前只有 md（未 extract/publish/TOC），入库需先 `toc_parse_cli` 产 TOC 再走管线。

**2026-09-01 修正（错题清零门禁误触发：本课错题弹出清零阶段）**：现象--学生在当前课课堂练习中答错几题，刷新本课时侧栏多出「错题清零」阶段（此前无任何历史错题）。根因：`GET /practice/uncleared-errors` 不带课时维度（2026-08-12 设计为「不限课时兜历史」），本课练习刚产生的错题也进清零列表。修复：① 端点加可选 `lessonId` 参数，service 层后置过滤 `lesson_id < currentLessonId`（与星图同一 id 数值序约定，db_loader 按书序插入故 id 随教学顺序单调）；**本课及后续课错题不触发清零门禁**，留待进入下一课时再清；`lesson_id` null 的孤儿历史行保守保留（兜历史语义不变）；不传参数行为不变（兼容）。② 前端 `getUnclearedErrors(subjectId, lessonId)`、CourseDetailPage 拉取时带当前 lessonId。③ repo 注释更新（「不限课时」的过滤职责移到 service 层）。④ 文档同步：openapi.yaml 加 lessonId 参数、API 设计文档 §4.16/§6.13/P2.2/版本日志 v2.2。⑤ 验证：server tsc + 261 测试绿（新增 1 例：传/不传 currentLessonId 过滤行为）、web tsc + lint 0 error。

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
