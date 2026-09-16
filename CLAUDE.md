# CLAUDE.md

This file provides guidance to Claude Code and CodeBuddy Code when working with code in this repository. 根目录 `AGENTS.md` 是本文件的软链（CodeBuddy 及其他读 AGENTS.md 的 agent 工具经它加载同一内容）。

## Project Overview

K12 智学系统 — an adaptive AI-powered K-12 education platform for Chinese students. MVP scope: Mathematics only. The platform uses a dual-track learning model (mainline structured progression + auxiliary free exploration) with Socratic AI tutoring.

## Monorepo Structure

```
apps/web/             — Active. React frontend (Vite + TypeScript + Tailwind)
apps/server/          — Active. Node.js backend; ai-core AI Agent Hub + HTTP API 层（practice/ai/auth/admin/parent 等 10 个模块）均已实现
apps/desktop/         — Planned. Electron wrapper
packages/             — Planned. Shared configs/types
tools/crawler/        — Active. 爬虫（zgkao 试卷 / smartedu 教材）
tools/data-refinery/  — Active. 数据管线 convert->extract->publish->db_loader（见下文）
tools/db/             — Active. MySQL schema + install_mysql.sh
docs/                 — PRD, API 设计, UX/UI, DB 设计, 数据管线总结
```

`apps/web`、`apps/server`（ai-core + HTTP API 层）与 `tools/data-refinery`、`tools/db` 均已有可运行代码，前后端已接通。

## Development Commands

All commands run from `apps/web/`:

```bash
npm run dev      # Vite dev server at http://localhost:5173
npm run build    # tsc -b + vite build (type-check then bundle)
npm run preview  # Serve production build locally
npm run lint     # ESLint for .ts/.tsx
```

前端有测试基建：**vitest + @testing-library/react + jsdom**（`npm test` / `npm run test:watch`，配置在 `vitest.config.ts`，setup 在 `src/test/setup.ts`）。测试文件放被测文件同目录 `*.test.tsx`。

⚠️ `globals: false`：`@testing-library/react` **不会自动注册 `afterEach(cleanup)`**，多用例文件必须自己写 `afterEach(() => cleanup())`，否则上个用例的 DOM 泄漏导致选择器重复命中（见 `QuestionRunner.test.tsx` 顶部注释）。

⚠️ **组件改动必须补一条渲染测试**，别只靠 `tsc + lint + build`：类型检查抓不到「运行时数据形状」问题。2026-09-16 就栽过——`SentenceBlock` 的 `terms` 从 `string[]` 改成 `{term, plain}` 对象后只跑了类型检查，线上旧 bundle 配新接口把对象当 React child 渲染，直接报 **React #31**（`SentenceBlock.test.tsx` 就是那个回归钉子）。

### apps/server (ai-core)

Commands run from `apps/server/`:

```bash
npm test            # vitest run (72 tests across 14 files)
npm run test:watch  # vitest watch mode
npm run build       # tsc (type-check + emit). NOTE: does not copy YAML/prompt assets to dist/ - see ai-core known limitations
npx tsx src/ai-core/__tests__/safety-classification.ts   # deterministic safety regression (no API keys needed)
```

`grading-accuracy.ts` and `tutoring-quality.ts` in `__tests__/` are LLM eval scripts (require API keys, run via `tsx`, not picked up by vitest).

### Python tools（crawler / data-refinery / db）

Commands run from each `tools/*` directory:

```bash
pip install -r requirements.txt
pytest    # 测试在 tests/test_*.py，共享 fixtures 在 conftest.py；网络依赖测试标记 network，默认 skip
```

## Commit & PR Guidelines

- Conventional Commits：`feat(scope): subject` / `fix` / `test` / `docs`；常用 scope：`web`、`server`、`aux`、`ai-core`、`data-refinery`、`toc_parse`、`db_loader`（例：`feat(web): refactor CourseDetailPage layout`）
- TS 严格模式、2 空格缩进、组件/类 PascalCase、函数/变量 camelCase；Python PEP 8 snake_case；提交前跑 `npm run lint`（apps/web）
- PR 描述变更、关联 issue、行为变更引用对应设计文档章节（如 PRD §7.10）；UI 变更附截图

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

Zustand for theme/motion preferences; API 层在 `src/services/api.ts`（JWT 三角色：student/parent/admin）。

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

**现状**：管线已端到端跑通（refinery 237 tests 全绿、crawler 200 tests；2026-08-26 实测 `refinery_cli --purge-business-data` 全量重载 342 cards + 447 questions 成功，含幂等重跑与守卫复验）。详细总结与后续见 `docs/data-refinery-管线总结与后续.md`，使用见 `docs/data-refinery-使用手册.md`。题目内容回写工具 `answer_importer`（2026-09-10）在 `tools/data-refinery/src/`：JSONL/Markdown 输入，按单题/批量/按卷/按缺口回写 questions 的 answer/approach/explanation/type（`--export` 导出待补模板，`--apply` 幂等写入）。

**改代码前必读的关键约定**（详见上述总结文档 §3）：
- LLM 配置用 `.env` 的 `LLM_BASE_URL`/`LLM_AUTH_TOKEN`（refinery 专属），**不要用 `ANTHROPIC_*`**（会被 shell 里 Claude Code 覆盖）。当前用本地 llama.cpp `Qwen3.8-27B`（`LLM_PROVIDER=local`、`LLM_BASE_URL=http://192.168.1.8:12345/v1`，2026-08-26 起 Card 标注/目录解析走本地模型；`.env` 里注释保留了原远程 DeepSeek `deepseek-flash` 配置可切回）。
- extract：lesson_id 由 LLM 给标题标识 + CLI 跨页继承（per-book 状态）；只有编号标题（`N.M`/`N.M.K`/`第N章`）开新课；章综述归该章"第 0 节"；前置内容（封面/目录/版权/前言）不抽取；试卷答案只提取不生成（从参考答案按题号提取，无则空）；**全角括号统一半角**--读页 md 后 `normalize_fullwidth_parens`（`（）`→`()`，1:1 不改长度，NFKC 等价不影响 content_hash；其余全角标点 。，；！？ 不动——`。` 无 NFKC 映射会改 hash，`。！？；` 是 splitter 句末切分点，2026-09-01）；**页眉/页脚剥离 + 书尾识别**（2026-09-02）--`page_chrome.py` 书级频率统计自动发现运行页眉（≥3 页 + 安全模式：出版社/水印/纯页码/ISBN，「练习」等内容标题永不剥），`is_front_matter` 判定与 split 前都先 `strip_chrome`；`is_front_matter` 新增书尾规则（ISBN/绿色印刷/后记附录索引/电话+邮箱/组织说明页标记≥3/剥空页）。重抽目标页用 `unmark_extracted` 而非 `--force`（--force 绕过 skip 分支会断 lesson_id 跨页继承回填）。**试卷路径二维码过滤**（2026-09-12）--`question_extract` 在答案合并后、`split_page` 前调 `qr_detect.strip_qr_images` 剔除公众号二维码图（`cv2.QRCodeDetector` 解码成功 + 二维码占图面积 ≥ `_MIN_QR_AREA_RATIO`=0.3；护栏防误删"角落带二维码的真实配图"，实测占图仅 0.014 vs 真二维码 0.86+）；二维码独占一行则删行，与正文同行则只摘引用保正文；教材卡路径不受影响（实测 733 张零二维码）。详见 `docs/superpowers/specs/2026-09-12-qr-code-image-filter-design.md`。详见 `docs/superpowers/plans/2026-09-01-page-chrome-and-backmatter.md`。
- publish：资产路径用源相对稳定键；subject 按文件路径首段推导（2026-08-26 前曾硬编码 "math" 误标化学，已修）。
- db_loader：subject 别名归一（chem->chemistry）、rel_path/lesson_id 解析派生教材结构、cards sort_order 跨页全局重排、full-reload 幂等；**full-reload 有业务数据守卫**——库中存在业务数据（answers/error_books 等外键表）时默认报错退出，需显式 `--purge-business-data`（按 FK 安全序清空）或改用 `--load-cards` 增量；**版次（edition）维度**--textbook_versions 按 `(subject_id, publisher, grade_band, edition)` 4 元组唯一，edition 用 `edition_from_book_name` 从书名前导括号提取（只用括号内容不用完整书名，勿用随机值做 code 破坏幂等）；**页码锚定 lesson_anchor**（2026-09-02）——TOC 模式挂卡时 `load_book_cards` 先过 `LessonAnchor` 确定性修正：章边界首选综述卡锚定（每章「第N章」标签卡最小 md 页 = 章头页，无偏移误差；兜底首节 printed + 偏移众数 − 3 余量），规则 A 错章重写（content「复习题 N」> 时间线活跃节 > 标题匹配 > 章综述）/ B 同名消歧（「小结」「数学活动」按页所在章）/ C 复习题归一（挂该章「小结」，不建「复习题 N」lesson）；无 TOC/对不上 → 整体退化既有匹配。extract/publish/jsonl 不动，锚定每次 load 重算（重处理任意页不影响结构）。详见 `docs/superpowers/plans/2026-09-02-lesson-anchor-design.md`。
- DB：`ai_k12/ai_k12@localhost/ai_k12`（`.env` 的 `DB_*`）。

**HTTP API 层已建成**（`apps/server/src/modules/`：practice/ai/conversations/progress/auth/parent/admin/content/files/refinery），前后端已接通。API 契约见 `docs/api/openapi.yaml` + `docs/API接口与数据流设计文档.md`（两份互为对照，见上文同步规则）。已知待办（详见 `docs/ai-core-changelog.md` 各条目「局限/待办」）：管理员角色细分、模型用量计费、BanRegistry 多实例（需 Redis）、refresh token。


## 语文古诗文专项（独立子系统）

训练轨「**训练 → 语文 → 专项**」下的**古诗文默写**（作者/朝代/正文三字段整篇默写）与**古诗文解释**（重点字词释义 + 逐句翻译）是**独立子系统**，有自己的表 `chinese_passages`。

**原则（2026-09-15 确立，勿违背）**：作答单位是**篇目**、标准答案是**篇目自带属性**、判题方式专项专属——因此**不挂 `questions` 表、不进错题本、不参与主线清零门禁、不用「不再展示」/提示缓存/自评**。`chinese_passages` **无外键**（不指向任何表、也不被任何表指向），表本身就是完整边界。

**边界（勿泛化到整个语文学科）**：这条**只覆盖古诗文专项**。语文**试题类**（试卷/真题/考试）属正常题库业务，作答单位是「题」、标准答案属题、错题要进错题本参与清零门禁，**仍走 `questions` + 错题本 + 考试/组卷既有体系，复用、不另起一套**。划界依据是**形态**（作答单位是「篇目」还是「题」），**不是学科**。

- 「不进错题本」的判据：错题本本质是**接主线清零门禁的待办队列**，不是「错过的题的统一记事本」。篇目级作答没有「重做—清零」的对象（专项不接主线，无解锁可放行）、没有变式生成物（§7.10 的变式以知识点为轴，篇目无知识点维度）、拉进错题练习也只是「再默一遍」（与专项自己的配置页重复）。**依据**：PRD §6.3 / §7.4 例外说明、架构文档 §4.2.13、`docs/superpowers/specs/2026-09-15-chinese-interpretation-special-design.md` §2。
- 内容生产走 data-refinery **旁路**（默写 `dictation_cli`、解释 `interpretation_cli`，见 `docs/data-refinery-使用手册.md` §4.9），**不接** convert→extract→publish→db_loader 四阶段主线，不产出 `cards`、不写 `questions`。默写只看 `convert_cli` 一步；**解释连 `convert_cli` 都不用**——它的字词由**用户手工整理**后交 `interpretation_cli --input`（JSON 或 Markdown，字段名中英文都认），正文用库里已校验的 `body`，管线只做「解析 → 切句 → 字词归属 → 出译文 → 自检 → 幂等入库」。译文是**混合模式**：输入给了 `sentences` 就用输入的（不调模型），没给才由 LLM 生成。
- **实施状态**：独立化改造**已完成**（2026-09-15）——表为 `chinese_passages`（无 `question_id`、无外键、含 `is_active`），`questions` 上的 `poem_dictation` 行与 `main_error_books(source='dictation')` 已清，四端点对外字段为 `passageId`，判题不写任何学生状态。迁移 `tools/db/migrations/2026-09-15_chinese_passages.sql`（**删题前必须先摘 dictation_passages 的 CASCADE 外键**——首跑曾因级联静默清空篇目、从备份恢复，事故记录见 `docs/superpowers/plans/2026-09-15-chinese-passages-standalone.md` Task 9）。**解释专项已实施**（2026-09-16）：三列 `key_terms`/`sentences`/`full_translation` 已加（迁移 `2026-09-16_chinese_interpretation_columns.sql`，纯 ADD COLUMN），`/training/interpretation/{passages,start,judge}` 三端点已通，`interpretation_judge` 场景已配（primary=local、fallback=deepseek-flash），前端两页已上线。**内容尚未灌入**（库里仅 2 篇 `DEV-FIXTURE` 假数据供手测）。
- **解释专项的三条口径（勿「统一」掉）**：① 判题是**逐句**的（用户 2026-09-16 裁决，原设计为整篇批量）——`judge` 入参带 `sentenceIndex`，答完一句立即出对错；② 抽题池 = `verified=1 AND is_active=1 AND JSON_LENGTH(sentences) > 0`，与默写的 `verified=1 AND memorize_required=1 AND is_active=1` **有意不同**（不设「必背」，加「内容就绪」）；③ `key_terms` 每项带 `sentenceIndex` 指向 `sentences` 下标——答题页「三行对译」的第 2 行（该句有哪些关键字词）靠它渲染。API 字段契约见 `docs/api/openapi.yaml`；设计依据 `docs/superpowers/plans/2026-09-16-chinese-interpretation-special.md`。


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
- **模型 ID（勿改）**：`kimi-latest`（Moonshot）、`qwen3.8-max`、`gemini-3.1-pro`、`deepseek-flash`、`Qwen3.8-27B`（本地 llama.cpp，`local` provider）。配置里 kimi 的 key 是 `kimi` 但 modelId 是 `kimi-latest`。**DeepSeek 端点只认 `deepseek-flash` 与 `deepseek-v4-pro` 两个模型名**（2026-09-14 实测，传其它名字直接 400 并在错误里列出支持列表）；`deepseek-v4-flash` 已不在支持列表，仅作为能解析的旧别名存活，**勿再新增引用**。存量库的 `llm_models.model_key`/`llm_routes` 改名见 `tools/db/migrations/2026-09-14_rename_deepseek_flash_model_key.sql`（`llm_routes.primary_model_key` 对 `llm_models.model_key` 有 NO ACTION 外键，**不能直接 UPDATE 主表**，须「先建新行 → 改引用 → 删旧行」）。
- **API Key**：用 `.env` 的 `KIMI_API_KEY`/`QWEN_API_KEY`/`GEMINI_API_KEY`/`DEEPSEEK_API_KEY` 及对应 `*_BASE_URL`（ai-core 专属，**不要用 `ANTHROPIC_*`**，会被 shell 里 Claude Code 覆盖）。
- **错误处理**（基于 `../llm-client.js`）：provider 经 `classifyError`（`infra/model-client/errors.ts`）抛 11 个错误子类之一（`LLMClientError` 基类 + `AuthenticationError`401 / `InsufficientQuotaError`402·429-quota / `PermissionError`403 / `ResourceNotFoundError`404 / `RequestTooLargeError`413 / `ValidationFailedError`400·422 / `ContentFilteredError`406·SAFETY / `RateLimitError`429 / `ServerError`5xx / `TimeoutError`abort；retryable 由子类决定）；`ModelClient.chat` 用 `callWithRetry`（full-jitter 退避 + 遵守 Retry-After + onRetry 钩子）包装，非 retryable 立即抛。
- **Gemini**：system prompt 走 `systemInstruction`（不是 user 角色）；finishReason 映射 MAX_TOKENS->length、SAFETY->content_filter。**流式暂未实现**（streamGenerateContent 待配 GEMINI_API_KEY），`ModelClient` 对 gemini 强制 `stream=false` 非流式降级。
- **场景路由（勿随意切换）**：judgment（训练模块专项/考试/错题判题）primary 是 `local`（本地 llama.cpp `Qwen3.8-27B`，`LOCAL_LLM_BASE_URL`/`LOCAL_LLM_API_KEY`），fallback 是 `qwen3.8-max`——`JudgmentCapability` 对 primary 任何失败（连接/超时/4xx/5xx/解析失败）自动回退一次，且判题调用不带 thinking（`ChatRequest.thinking=false`，不建 `qwen3.8-max-nothink` 模型条目——**但注意这条对 `local` 是空操作，实际仍在 thinking，见下文「给本地 llama.cpp 关 thinking 只能用 extraBody」**）；grading/structuring/hint 的 primary 仍是 `deepseek-flash`（快模型，同题 ~19s 判对）；`qwen3.8-max` 是 reasoner（难几何题 >90s 仍超时），只作 fallback；tutoring 辅导主模型 `qwen3.8-max`；图片直接作为 `image_url` 部件随消息送给辅导模型（`qwen3.8-max` 多模态），无转录/确认两阶段。已 seed 的库用 `npx tsx src/scripts/set-judging-local.ts` 幂等切换路由（YAML 只服务新装/DB 空时）。
- **会话标题路由（2026-09-11 起）**：`title` 场景 primary=`local`、fallback=`deepseek-flash`（本地优先，不依赖外部余额）。`TutoringCapability.generateTitle` 走 `modelRouter.route({scene:'title'})`（**不再硬编码 deepseek**）：primary 失败回退 fallback，**两者都失败则不生成标题**（保留默认「辅线答疑」，由学生手动重命名，明确不做文本兜底）；两个模型都失败时 `console.warn` 留痕。已 seed 的库执行 `npx tsx src/scripts/set-title-route.ts` 补 `title/*` 路由。
- **多模态与图片（2026-09-11 起）**：`qwen3.8-max` 支持多模态，图片直接作为 `image_url` 部件随最后一条 user 消息送给辅导模型（`TutoringCapability.augmentWithImages`），无转录/确认两阶段（一图多题由 `prompts/tutoring/math/auxiliary.md` 的图片/多题处理段兜底）；`qwen-vl-max`/`qwen3-vl-plus` 两个 VL 模型与 `transcribe` 场景已删除，不再存在。`ai_dialogues.flow_state`/`pending_question`/`pending_questions` 为遗留死数据（未做破坏性迁移，勿再读写）。
- **判题与解析分离（2026-09-08 起）**：判题（judgment 场景）只判对错（isCorrect/errorType），prompt **勿加回 analysis 输出**；判错解析由 `ExplanationCacheService`（practice 模块，PracticeModule 导出供 TrainingModule 注入**同一实例**——勿重复 provide，会分裂 in-flight 队列）后台生成入 `questions.explanation` 一次性复用（`answer>=100` 字符直写不调 LLM；否则 explanation 场景 `solution` 模式强模型生成，可含 SVG）。结果页批量拉解析走 `GET /training/questions/explanations`（等 in-flight 60s），刷新走 `explanation-wait`（120s，失败写 admin_notifications）。
- **辅线答疑「详细解析」走题库（2026-09-11 起）**：`AIService.maybeStoredExplanation` 在 `mode='auxiliary'` 且满足「学生已与助手来回 ≥ `fallback.yaml.fallback.detailedExplanationAfterRounds`（默认 2）轮 + 当前消息命中 `detailedExplanationKeywords`」时，**直接从题库取 答案+解题思路+解析**（`questions.answer/approach/explanation`）输出，**不调用模型**。题目定位：优先会话 `ai_dialogues.question_id`（AI 首次结构化入库时由 `AiDialoguesRepository.updateQuestionId` 回填，幂等仅当 NULL）；老会话无锚点则用首条用户消息题干匹配——**`content_hash` 优先、`QuestionRepository.findByContentPrefix` 的「归一化去标点前 20 字」兜底**（同一题文字/格式微调也能命中），多命中取最新。**查不到题或题库无可用内容 → `TutoringRequest.forceFallback=true` 强制走 AI 完整解析兜底，不再回到苏格拉底追问。** 入库侧（`ingestStructuredQuestion`）：hash/前 20 字命中即复用、**不重复插入**，并**确保该学生 `main_error_books` 有这道题**（`source='auxiliary'`，`existsByStudentAndQuestionId` 幂等）。结构化题目输出新增 `approach`（解题思路）字段。辅线 prompt（`prompts/tutoring/math/auxiliary.md`）要求**每次引导必须给出关键信息**（关键已知条件/公式定理/下一步操作），不能只抛问题让学生干想，但仍不得给最终答案。**前端可发现性**：`AuxiliaryHomePage` 在会话 ≥2 条 assistant 消息时给 `AuxInputBar` 传 `showAnswerHint`，输入框上方提示「输入『详细解析』/『给我答案』即可获得 答案+思路+解析」（阈值 2 与后端 `detailedExplanationAfterRounds` 对齐，前端硬编码，改后端配置需同步）。
- **判题体系分层（2026-09-09 起）**：`JudgeCoreService` 四路由——choice/true_false 程序比对；fill_blank/calculation 归一化比对 + AI 等价判断；short_answer/proof 由 `JUDGE_SUBJECTIVE_MODE` 控制（默认 `self_assess`：不判对错，学生自评「我做对了/做错了」走 `recordSelfAssessment` 留痕 + 错题本写入/清零；`ai`：原 JudgmentCapability 逻辑保留可切回）。calculation 为新增题型（结果型计算题，从 short_answer 拆出，存量拆分依赖 answer_importer 回写）。空答案题守卫（method='unanswered' 不计对错）+ 抽题过滤 `answer <> ''`。考试主观题 `is_correct=NULL`、成绩只算客观题；课堂练习主观题 practice_results 推迟到自评端点落行（method='self_assess'）。设计见 `docs/superpowers/specs/2026-09-09-judging-rework-design.md`。
- **给本地 llama.cpp 关 thinking 只能用 `extraBody`（2026-09-14 起，易踩坑）**：`ChatRequest.thinking=false` 是 **DashScope 系**的开关（下发 `enable_thinking`），**对本地端点完全无效**——`LocalClient` 会把这个字段删掉，传了也只是白删一次。本地要关 thinking 必须走 `ChatRequest.extraBody: LLAMA_CPP_NO_THINKING_BODY`（`{chat_template_kwargs:{enable_thinking:false}}`，从 `infra/model-client/index.js` 导出）。2026-09-14 实测三组对照（Qwen3.8-27B）：什么都不传 `reasoning_content` 45 字、prompt 末尾加 `/no_think` 49 字（软开关无效）、`chat_template_kwargs` **0 字**（1.2s 直接出正文）。⚠️ 既有的 `JudgmentCapability` 传了 `thinking:false` 但对 local 是**空操作**（实际仍在 thinking）——2026-09-14 有意**未**改动它（会改变数学判题行为），只给 `dictation_feedback` 一个调用关掉了。要全局生效需先与用户确认。
- **per-scene timeout 已接线**：各 capability 的 chat 调用传 `retry.yaml` 的 per-scene timeout（如 judgment 90s、explanation 120s），调超时改 yaml 即可。⚠️ **但这项对流式调用是死的**（见下条），真正的兜底是空闲超时——2026-09-14 排查默写卡顿时的实测结论。
- **流式用空闲超时，不是墙钟硬超时（2026-09-11 起）**：`OpenAICompatibleClient.streamChat` 不再 `AbortSignal.timeout(per-scene)` 一刀切——改用「有数据就重置」的空闲超时，阈值取 `retry.yaml` 的 `streaming.firstTokenTimeoutMs`（首字节前，默认 3s）/ `interTokenTimeoutMs`（收到首字节后，默认 10s）；reasoner 模型（qwen3.8-max）难题思考 >45s 也不会被砍。空闲触发抛 `TimeoutError`（statusCode 408）→ 前端显示 1009「AI 响应超时」。外部 `request.signal`（用户停止）仍走 `AbortError` 语义。**注意副作用**：`request.timeout` 仅在 `streaming.*` 缺失时兜底，且每收到一个字节就重新 arm，故「持续吐思考 token」的调用**没有墙钟上限**——`retry.yaml` 里给某个 scene 配的 timeout 并不会真的封顶（`maxRetries: 2` 还会把它乘上去）。凡把 LLM 调用放在请求关键路径上都要意识到这一点。
- **语文默写判题与错因已解耦（2026-09-14 起）**：`POST /training/dictation/judge` **纯程序判对错、不等 LLM**（实测 12.6s → 25ms），答错回 `feedbackPending=true`；错因文案由 `POST /training/dictation/feedback` 单独取（实测 ~2s，关了 thinking）。错因端点只生成话术——服务端用纯函数 `evaluateDictation` 重算差异，**只读篇目、不写任何学生状态**（独立化后判题与错因都不入错题本）。前端提交后立刻渲染对错 + 正文对比，错因区转圈等文案。**正文差异视图展示层带标点**（`diffChineseInOriginalText` 把标点回投原文；判对错口径仍忽略标点与空格）。
- **流式与 response_format**：`ModelClient.chat` 默认流式（聚合 streamChat 的 content+reasoningContent）；`kimi-client.streamChat` 请求体已带 `response_format` 与 `chat()` 对齐——**勿回退**，丢了会静默丢失 json_object 约束。
- **错误映射与对话持久化**：`mapLLMErrorToClient`（`infra/model-client/errors.ts`）把 11 个错误子类映射为人类可读错误码（1001-1012/5000/5001 + retryable 标志）透传给前端；对话中模型错误若**尚未产出任何 reasoning/content**只持久化 user 消息（刷新回到「末条 user 待重试」），若**已流出部分思考/正文**（如空闲超时打断思考）则 best-effort 一并落库（assistant content 空时填 `[生成中断]`），刷新后仍可回看；重试请求带 `retry:true` 只追加 assistant、不重复落 user。前端 `setLastAssistantError` 不再清空已流出的内容/思考，错误气泡叠在思考过程下方。
- **测试与文档同步铁律**：若测试断言与 config/types/设计文档的值冲突，**测试错**——改测试，勿改 config/设计文档。改代码或主文档时，同步更新所有引用该实现的设计/计划文档。

**已知限制**（本次未修，记录待后续）：metrics/logger 模块已实现但尚未在 capability 层接入；`detectWrongAnswer` 用正则推断学生答错（plan 设计，脆弱）；ConversationService 内存存储无 TTL/容量上限；缺 essay/reading/translation 评分模板（MVP 仅数学 proof/calculation）；部分 YAML 字段（classifier.confidenceThreshold、outputStructure）为声明式意图未接线；gemini 流式（streamGenerateContent）未实现（待配 GEMINI_API_KEY，当前非流式降级）；流式 usage 尽力收（Kimi 流式不返回 usage，cost 可能 0）；`npm run build` 会通过 `scripts/copy-assets.mjs` 把 `src/ai-core/*.yaml`（model-routes/retry/safety/fallback）与 `prompts/` 复制进 `dist/ai-core`，`node dist/main.js` 与 `tsx src/...` 读到同一份配置。

**实现记录**：计划草稿偏差与 code-review 修正详见 `docs/superpowers/plans/2026-07-23-ai-agent-hub-mvp-implementation.md` 末尾「实现修正记录」「代码审查后修正」两节。

**历史日志**：2026-07-24 → 2026-09-01 的修正/新增记录（判题模型切换、hint 缓存、图片两阶段流、练习结果持久化、错题清零门禁、三角色账号、管理员中枢、管线 FK 守卫、edition 版次维度等）已迁至 `docs/ai-core-changelog.md`；各次变更的任务级计划见 `docs/superpowers/plans/`。

