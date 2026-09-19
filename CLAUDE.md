# CLAUDE.md

This file provides guidance to Claude Code and CodeBuddy Code when working with this repository. 根目录 `AGENTS.md` 是本文件的软链（CodeBuddy 及其他读 AGENTS.md 的 agent 工具经它加载同一内容）。

## Project Overview

K12 智学系统 — an adaptive AI-powered K-12 education platform for Chinese students. The platform uses a dual-track learning model (mainline structured progression + auxiliary free exploration) with Socratic AI tutoring. MVP 已覆盖数学、语文古诗文专项、英语背单词。

## Monorepo Structure

```
apps/web/             — Active. React frontend (Vite + TypeScript + Tailwind)
apps/server/          — Active. Node.js backend; ai-core AI Agent Hub + HTTP API 层（10 个模块）均已实现
apps/desktop/         — Planned. Electron wrapper
packages/             — Planned. Shared configs/types
tools/crawler/        — Active. 爬虫（zgkao 试卷 / smartedu 教材）
tools/data-refinery/  — Active. 数据管线 convert->extract->publish->db_loader
tools/db/             — Active. MySQL schema + install_mysql.sh
docs/                 — PRD, API 设计, UX/UI, DB 设计, 数据管线文档
```

## Development Commands

```bash
# apps/web/
npm run dev        # Vite dev server at http://localhost:5173
npm run build      # tsc -b + vite build
npm run lint       # ESLint for .ts/.tsx
npm test           # vitest（676 tests / 72 files）

# apps/server/
npm test           # vitest（1263 tests / 103 files）
npm run build      # tsc + scripts/copy-assets.mjs（把 ai-core 的 yaml 与 prompts 复制进 dist）
npx tsx src/ai-core/__tests__/safety-classification.ts   # 确定性安全回归，无需 API Key

# tools/*（crawler / data-refinery / db）
pip install -r requirements.txt && pytest   # 测试在 tests/test_*.py；网络依赖测试标记 network，默认 skip
```

⚠️ **起后端的正确方式**：`node dist/main.js`。`npx tsx src/main.ts` 的 DI 是坏的（见下文 DI 坑）。

## 权威文档索引（动手之前先读这里）

| 文档 | 什么时候读 |
|---|---|
| `docs/K12智学系统-产品需求文档.md` | PRD，**所有功能的唯一真源**。与任何设计决策冲突时以它为准，且必须先与用户确认再实现 |
| `docs/UX-UI设计文档.md` | 页面规范与响应式规则 |
| `apps/web/style.md` | **唯一**样式参考：配色（§2）、登录页（§2.5）、入口选择页（§2.6）、学科选择页（§8） |
| `docs/API接口与数据流设计文档.md` + `docs/api/openapi.yaml` | API 契约，两份**互为对照、必须同步**（规则见下） |
| `docs/ai-core-changelog.md` | 历史工作日志。**本文件迁出的带日期细节都在这里**，它同时记录各次事故与踩坑 |
| `docs/data-refinery-管线总结与后续.md` / `使用手册.md` | 数据管线的约定与操作 |
| `docs/superpowers/specs/` 与 `docs/superpowers/plans/` | 各子系统的设计 spec 与任务级实施计划 |

## 基本原则（硬规则，勿违背）

### UI / 设计

1. UI、组件、文案里**不用 emoji**；图标必须是线性 SVG。
2. **不用吉祥物或装饰元素**（彩虹、气球、星星）。
3. **配色只有一套**（`style.md` §2），**不按学段分色**。
4. **PRD 覆盖任何设计决策**；有冲突必须先与用户确认再实现。
5. iPad 横屏（≥1024px）是**主断点**，PC（≥1280px）次要，移动端暂缓。
6. 苏格拉底原则：「提示」与「讨论」按钮**永远比「看答案」更醒目**。
7. 主线推进必须**先清零错题**才解锁，**这道门禁不许跳**。
8. **不支持小程序**：只做 WebApp、PC App（Electron）、家长 Web。不得引入微信/支付宝小程序等任何小程序相关代码、API、构建目标或文档引用。

### 主题与学段

- 三套主题经 CSS 变量 + 容器上的 `data-theme` 实现，token 真源在 `apps/web/style.md` §2。`student-day`（默认）/ `student-night` / `parent`。
- **主题作用域按 `UX-UI设计文档.md` §1.5 分两类**：①**学习沉浸页**（课程详情 P2.2、AI 讨论 P2.3、课后作业/作业解析 P2.4–2.5、单元检测/期中期末/成绩报告 P2.6–2.8、辅轨答疑 P3.1、错题本 P4.x）→ 包 `.student-theme-container`、按 18:00–06:00 自动切、并允许在**沉浸页内**手动切（如 `CourseDetailPage` 右下角的「护眼」按钮）；②**非学习阶段学生页**（登录、注册、学科选择、入口选择页、章节星链图 P2.1、个人中心 P5.1、奖励册 P5.2）→ **写死 `data-theme="student-day"`、不使用 `.student-theme-container`、无手动切换**。家长端/管理端全程日间。
- **页面外壳与归属（勿混）**：`StudentLayout` = 学习页外壳（跟随主题；当前承载 P2.4–P2.8 等占位页，将来实现时仍需自动切夜）；`StudentStayLayout` = **浅停留页外壳**（**个人中心/奖励册专用**：写死日间、不带侧栏、无日夜切换，顶栏「返回星图」是这两页回学习主线的唯一出口 + `LogoutButton`）——**不要把个人中心/奖励册合回 `StudentLayout`**；训练轨页面全屏、硬编码 `data-theme="student-day"`、不在任何 Layout 下。
- **学生端没有独立设置页**（UX P5.3「学习设置」已废止，2026-09-18）：护眼/日夜=自动 + 沉浸页内手动；字号由学段决定（`data-school` 的字号来自家长在「学习配置」里选的年级）；行距是排版规范（`style.md` §9 定死 1.6–1.8）；音效 PRD 未定义。`themeStore.motionEnabled` 存在但**无 UI 入口**，本期不做。
- **训练轨内的页面一律单一浅色主题**（硬编码 `data-theme="student-day"`，不跟随主题、无切换按钮）。
- `data-school`（`primary`/`junior`/`senior`）**只调字号**，颜色与圆角三学段一致。
- 双轨的区分靠**文字标签**（Tab 名、Tag 文案「主线」「辅线」），**不靠颜色**；物理隔离靠路由（入口选择页，无跨轨链接）。辅线颜色与主线同为一套 brand orange，旧紫色 `Aux #8B5A8E` 已废弃。

### 代码组织

- `src/components/base/` 通用原语；`src/components/business/` 领域组件；`src/components/layout/` 页面外壳。
- 路由用 React Router 6 `createBrowserRouter`；登录按用户名格式自动分流（手机号 → 家长，否则 → 学生）。
- 状态用 Zustand（主题/动效偏好）；API 层在 `src/services/api.ts`（JWT 三角色 student/parent/admin）。
- `src/tokens/` 的 JSON 是 CSS 变量生成的源。

## API 文档同步规则

`docs/API接口与数据流设计文档.md` 与 `docs/api/openapi.yaml` 必须始终一致：

1. **任何一方变更时，另一方必须同步更新**（路径、方法、参数、响应结构）。
2. **以 API 设计文档为主稿**：端点清单（§4）与数据流（§6）定义业务语义；openapi.yaml 是其机器可读实现。
3. **阶段标记**：openapi.yaml 只收 MVP 端点；P1/P2 在 API 文档里标阶段，进入开发时再补入。
4. **检查清单**：每次 API 变更后核对两文档的端点路径列表，确认无遗漏。
5. 注意 **Nest 的 `@Post` 默认返回 201 而非 200**（本仓无端点用 `@HttpCode` 覆盖）——新端点按实际记 `'201'`，以 `2xx` 判断成功。

## 工程约定（血泪教训，勿重蹈）

- **测试与文档同步铁律**：若测试断言与 config/types/设计文档冲突，**测试错** —— 改测试，勿改 config/设计文档。改代码或主文档时，同步更新所有引用该实现的设计/计划文档。
- **组件改动必须补一条渲染测试**，别只靠 `tsc + lint + build`：类型检查抓不到「运行时数据形状」问题。2026-09-16 栽过——`SentenceBlock` 的 `terms` 从 `string[]` 改成 `{term, plain}` 后只跑类型检查，线上旧 bundle 配新接口把对象当 React child 渲染，报 **React #31**（`SentenceBlock.test.tsx` 是那个回归钉子）。
- **`globals: false`**：`@testing-library/react` 不会自动注册 `afterEach(cleanup)`，多用例文件必须自己写 `afterEach(() => cleanup())`，否则上个用例的 DOM 泄漏导致选择器重复命中。
- **Nest DI 坑（接口类型的可选参数）**：带 `@Injectable()` 的类会发 `design:paramtypes`，**接口类型**的参数在运行时被写成 `Object`，Nest 当成真 token 去容器找、找不到就**启动直接失败**。必须加 `@Optional()`。对照 `ai-core/capabilities/*` 那些类**故意不写 `@Injectable()`**（零参实例化）才一直没踩到——区别在有没有装饰器，不在参数可选不可选。
- **数据库**：`ai_k12/ai_k12@localhost/ai_k12`（`.env` 的 `DB_*`）。schema 在 `tools/db/schema.sql`，迁移在 `tools/db/migrations/YYYY-MM-DD_*.sql`（**无迁移运行器，手工 apply**；必须幂等；新增表/列要同时进 schema.sql）。`updated_at` 一律用**列级** `ON UPDATE CURRENT_TIMESTAMP(3)`，**不要建 `*_updated_at` 触发器**（触发器是独立对象、会随 schema 漂移静默缺失，2026-09-19 已统一）。
- **派生状态必须带 `studentId` 归属**：家长端切孩子不重挂载、`useState` 跨孩子存活，只按自身维度守卫会在切换首帧画出上个孩子的数据（`useEffect(reset)` 救不了——它在 commit 之后才跑）；派生值必须与 `studentId` 一起存、读取时一并比较。
- **列表页换孩子必须回第 1 页**：否则带「上个孩子的第 N 页」请求新孩子，页数不够时停在空态且分页控件只在非空分支渲染（家长无法自救）；加 `useEffect(() => setPage(1), [studentId])`。
- **埋点不得影响请求**：analytics 日志走内存 buffer——满时丢最旧、失败批次直接丢弃不重试、**永不抛**；ledger / request-log 写入**绝不在请求路径上 await**。
- **埋点（学习会话）的两条纪律**：`active_seconds` **只由服务端**按 `last_heartbeat_at` 差值累加、**单次封顶 45s**、且只在上一状态为 visible 时计（客户端上报的秒数一律不采信；不封顶时「关标签 2 小时」会被算成 2 小时）。埋点写入**永不阻断主链路**：三个采集端点的失败由**前端传输层吞掉**（`analytics/tracker.ts` 全 `.catch(() => {})`，故端点允许 DB 失败直接 500），而**嵌在业务流里**的埋点写入（如家长 GET 里的 `closeStale`）必须 catch、失败只 warn。家长端「学习时长（会话）」与既有「近 7 天活跃天数」是**两套口径、并存不替换**（spec §10），UI 必须并列展示并区分文案。
- **`input_tokens` / `output_tokens` 可为 NULL，NULL = 量不到**：量不到就写 NULL，**绝不写 0**——否则报表无法区分「缺口」与「真实读数」（本期只记 token，不记价格/成本）。

## 数据管线（tools/data-refinery）

```
convert_cli (MinerU) -> extract_cli (LLM) -> publish_cli (物化图片) -> db_loader_cli (MySQL)
```

`refinery_cli.py` 串联 publish + db_loader；DB 由 `tools/db/install_mysql.sh` 初始化。题目内容回写工具 `answer_importer`（JSONL/Markdown → questions 的 answer/approach/explanation/type，`--export` 出模板 / `--apply` 幂等写入）。

**改动前必读的三条**（细节见 `docs/data-refinery-管线总结与后续.md` §3）：

1. **LLM 配置用 `.env` 的 `LLM_BASE_URL`/`LLM_AUTH_TOKEN`（refinery 专属），不要用 `ANTHROPIC_*`** —— 会被 shell 里 Claude Code 覆盖。
2. **`db_loader` 的 full-reload 有业务数据守卫** —— 库中存在业务数据（answers/error_books 等外键表）时默认报错退出；需显式 `--purge-business-data`（按 FK 安全序清空）或改用 `--load-cards` 增量。
3. **重抽目标页用 `unmark_extracted` 而非 `--force`** —— `--force` 绕过 skip 分支会断 lesson_id 的跨页继承回填。

其余 extract/publish/db_loader 的细则（全角括号归一、页眉页脚剥离与书尾识别、二维码过滤、版次 edition 维度、页码锚定 lesson_anchor 等）属已稳定行为，已迁至 `docs/ai-core-changelog.md`。

## 独立子系统（两条，共同原则）

**语文古诗文专项**与**英语背单词**是**独立子系统**：自己的表、自己的端点、自己的页面。
**共同原则（勿违背）**：作答单位不是「题」（语文是**篇目**、英语是**词/义项**），标准答案是内容自带属性，判题方式专项专属 —— 因此**不挂 `questions` 表、不进错题本、不参与主线清零门禁、不用「不再展示」/提示缓存/自评**。对应的表都**无外键**（或只挂学生表），表即完整边界。

**边界勿泛化到整个学科**：语文/英语的**试题类**（试卷/真题/考试）属正常题库业务，作答单位是「题」、错题要进错题本参与清零门禁，**仍走 `questions` + 错题本 + 考试/组卷既有体系，复用、不另起一套**。划界依据是**形态**（作答单位是「篇目/词」还是「题」），**不是学科**。

### 语文古诗文专项

- 表 `chinese_passages`。迁移 `tools/db/migrations/2026-09-15_chinese_passages.sql`（**改它之前记住**：删 `questions` 行前必须先摘掉 `dictation_passages` 的 CASCADE 外键——首跑曾因级联静默清空篇目、从备份恢复，事故记录见 `plans/2026-09-15-chinese-passages-standalone.md` Task 9）。
- 内容走 data-refinery **旁路**（`dictation_cli` / `interpretation_cli`），**不接**四阶段主线，不产出 `cards`、不写 `questions`。解释专项连 `convert_cli` 都不用：字词由**用户手工整理**后交 `interpretation_cli --input`。
- **解释专项的三条口径（勿「统一」掉）**：① 判题是**逐句**的——`judge` 入参带 `sentenceIndex`，答完一句立即出对错；② 抽题池 = `verified=1 AND is_active=1 AND JSON_LENGTH(sentences) > 0`，与默写的 `verified=1 AND memorize_required=1 AND is_active=1` **有意不同**（不设「必背」，加「内容就绪」）；③ `key_terms` 每项带 `sentenceIndex` 指向 `sentences` 下标——答题页「三行对译」第 2 行靠它渲染。
- **含义专项的两条口径（勿「统一」掉）**：① `method` 枚举**不含 `exact`**——含义/情感是理解性作答，一律过 LLM、无归一化全等短路；② 抽题池在解释专项基础上**再加「内容就绪」第四道闸门 `sentence_meanings IS NOT NULL`**。
- 契约见 `docs/api/openapi.yaml`；设计见 `docs/superpowers/plans/2026-09-16-chinese-interpretation-special.md`。

### 英语背单词

- 两张表（迁移 `tools/db/migrations/2026-09-16_english_vocabulary.sql`）：`english_words`（**无外键**；`word` 业务键；`level` 存四层 `primary`/`junior`/`senior_required`/`senior_elective`，页面只暴露「仅初中/仅高中/全部」三档；`meanings` JSON 承载义项与熟词僻义 `extended`+`context`；`root_key` 自关联表达词根族、`root_affixes` JSON 存词缀注记；`error_count` 全平台累计错次**只增**）与 `student_word_progress`（唯一外键 `student_id→students(id)`；`word_id` **故意不设外键**，否则内容表全量重灌会被入向外键卡死）。
- **判题三条路由**：中→英**纯程序比对**（归一化 + 人工拼写变体组，拼错给逐字符差异，**不调 LLM**）；英→中·常见义先拆 gloss 原子程序短路、未命中调 `english_word_judge` 场景（二档）；英→中·熟词僻义同前但**三档**（多一档 `off_target` = 答成常见义）。**计错口径（勿「统一」掉）**：只有 `wrong` 同时给学生 `wrong_count` 与全局 `error_count` 各 +1；`off_target` / `unanswered` / `undetermined` **三者都不计错**。记账唯一实现在 `normalize-english.util.ts` 的 `progressDelta`。
- **两条防泄漏铁律**：① `promptKind='cn2en'` 的题**后端不下发** `word`/`phonetic`/`context`/`hasFamily`；② **`+` 号只在 `promptKind==='en2cn' && hasFamily` 时渲染**——词根族树里必然含单词本身，中→英题点开等于直接看答案（有专门的渲染钉子用例）。
- **抽题**：不走 `ORDER BY RAND() + LIMIT ?`，改「先取候选 id 池 → 服务层洗牌/排序切 N → 按 id 取详情」，四种顺序模式共用一条 SQL。**一个词只出一道题**（会话长度 == count）。**普通模式下也会抽到熟词僻义题**，勾「只出熟词僻义」的作用是「只留」僻义，且此时**方向强制英→中**（三档口径的前提）。
- **内容管线**：词表来自 smartedu 课本（`crawler_cli.py --site smartedu`）书末附录 `Vocabulary in Each Unit` / `Vocabulary A-Z`；课标官方 PDF 只当**校验白名单**（课标两份词汇表的说明明确写「不标注词性和中文释义」，也不带音标）。**音标本期不做**（实测 macOS Vision 读不了 IPA，见 spec §6.2）。**loader 的 `ON DUPLICATE KEY UPDATE` 必须显式排除 `error_count`**，否则全量重灌抹掉全平台易错统计。抓取**必须串行 + `--crawl-delay 1.5`**（smartedu 会 403）。
- 场景 `english_word_judge` = primary `local` / fallback `deepseek-flash`。契约见 §4.18/§6.22。设计见 `docs/superpowers/specs/2026-09-16-english-vocabulary-special-design.md`。

## 家长端学情（P6.1 仪表盘 / P6.2 报告 / P6.3 错题 / P6.4 对话回放）

- 四页是**只读实时聚合**（`apps/server/src/modules/parent-insights/`）：学情报告**不落 `learning_reports`、不调 LLM**，服务层分次查 + JS 合成后直接返回。**不要往这四个端点里加写入逻辑**。
- **学习时长与掌握度都已不是代理**：时长走会话口径（`study_sessions`，Phase 1A）；掌握度自 Phase 1B 起由判题出口回写 `student_knowledge_mastery`（**与「错题数代理」`weakPoints` 并存不替换**，两卡标题不同、不得合并）；专项学情/目标达成是只读实时聚合（`special_practice_logs` / `goals.metric`）。**仅**活跃度（`activeDays7`）仍是时间戳代理。薄弱点必须给「未标注知识点的错题数」、掌握度必须给覆盖率三项，否则家长误读成「只有这些问题」。口径见 API 文档 §6.8/§6.27。**埋点写入永不阻断判题**（失败只 warn；掌握度回写走 `void` 不 `await`）——注意 **ODKU 的 SET 从左到右求值、读到的是已更新的列**（累计列须在计数列之后写且不得再 `+ new.x`），仓储占位符顺序必须与列清单逐位对应（`goals` 的 `title` 在 `period` 前），**这类错位置断言式单测拦不住**（详见 changelog 本批条目）。

## apps/server - ai-core AI Agent Hub

两层架构：`infra/`（ModelRouter、PromptBuilder、ModelClient + Kimi/Qwen/DeepSeek/Gemini/local 适配器、ResponseParser、SafetyGuard、FallbackHandler、Logger、Metrics）+ `capabilities/`（Tutoring/Grading/Explanation/Variation/Analytics/Judgment 及若干专项能力）+ `prompts/`（Mustache 模板）+ `*.yaml`（model-routes / retry / safety / fallback）。技术栈：Node + TS ESM、Vitest、Zod、Mustache、prom-client、dotenv。

**改代码前必读的关键约定**：

- **模型 ID（勿改）**：`kimi-latest`、`qwen3.8-max`、`gemini-3.1-pro`、`deepseek-flash`、`Qwen3.8-27B`（本地 llama.cpp，`local` provider）。配置里 kimi 的 key 是 `kimi` 但 modelId 是 `kimi-latest`。**DeepSeek 端点只认 `deepseek-flash` 与 `deepseek-v4-pro`**（传其它名字直接 400）；`deepseek-v4-flash` 已不在支持列表，仅作旧别名存活，**勿再新增引用**。
- **API Key 用 `.env` 的 `KIMI_API_KEY`/`QWEN_API_KEY`/`GEMINI_API_KEY`/`DEEPSEEK_API_KEY` 及对应 `*_BASE_URL`**（ai-core 专属）。**不要用 `ANTHROPIC_*`** —— 会被 shell 里 Claude Code 覆盖。
- **场景路由（勿随意切换）**：`judgment` primary=`local`、fallback=`qwen3.8-max`；`grading`/`structuring`/`hint` primary=`deepseek-flash`；`tutoring` 主模型 `qwen3.8-max`；`title`、`dictation_feedback`、`interpretation_judge`、`english_word_judge`、`chinese_meaning_judge` 均 primary=`local`、fallback=`deepseek-flash`。已 seed 的库用 `npx tsx src/scripts/set-*-route.ts` 幂等补路由（YAML 只服务新装/DB 空时）。**新增场景要改 8 处**：`types.ts` 两个 union、`model-routes.yaml`、`retry.yaml`、`prompts/` 模板、`prompt-builder.ts` 的 `resolveTemplatePath` 分支、capability 类、seed 脚本、**`admin-models.service.ts` 的 `SCENES` 白名单**（漏了后台下拉选不到；有漂移守卫用例钉着）。
- **给本地 llama.cpp 关 thinking 只能用 `extraBody`（易踩坑）**：`ChatRequest.thinking=false` 是 **DashScope 系**的开关，**对本地端点完全无效**（`LocalClient` 会把这个字段删掉）。本地要关必须走 `ChatRequest.extraBody: LLAMA_CPP_NO_THINKING_BODY`（`{chat_template_kwargs:{enable_thinking:false}}`，从 `infra/model-client/index.js` 导出）。实测：不传 → `reasoning_content` 45 字；prompt 末尾加 `/no_think` → 49 字（软开关无效）；`chat_template_kwargs` → **0 字**（1.2s 直接出正文）。⚠️ 既有的 `JudgmentCapability` 传了 `thinking:false` 但对 local 是**空操作**，2026-09-14 有意未改动它（会改变数学判题行为）。
- **流式用空闲超时，不是墙钟硬超时**：阈值取 `retry.yaml` 的 `streaming.firstTokenTimeoutMs`（默认 3s）/ `interTokenTimeoutMs`（默认 10s），有数据就重置；reasoner 难题思考 >45s 不会被砍。空闲触发抛 `TimeoutError`（408）→ 前端 1009「AI 响应超时」；外部 `request.signal` 仍走 `AbortError`。**副作用**：`request.timeout` 只在 `streaming.*` 缺失时兜底，且每收一字节就重新 arm，所以「持续吐思考 token」的调用**没有墙钟上限**——`retry.yaml` 里给 scene 配的 timeout 不会真的封顶（`maxRetries: 2` 还会乘上去）。**凡把 LLM 调用放在请求关键路径上都要意识到这一点。**
- **`PromptBuilder`**：`customVariables` 已展平进 Mustache 视图，可传对象/数组；**已关闭 HTML 转义**（数学符号 `=<>` 必须原样保留）；`{{> partial}}` 加载 `system/*.md` 并剥 frontmatter；模板用 `## System Prompt` / `## User Message` 分段。
- **判题与解析分离**：判题（`judgment`）只判对错，prompt **勿加回 analysis 输出**；判错解析由 `ExplanationCacheService` 后台生成入 `questions.explanation` 一次性复用。⚠️ 该服务**必须由 `PracticeModule` 导出后注入同一实例**，**勿在其它模块重复 provide**（会分裂 in-flight 队列）。
- **判题体系分层**：`choice`/`true_false` 程序比对；`fill_blank`/`calculation` 归一化比对 + AI 等价判断；`short_answer`/`proof` 由 `JUDGE_SUBJECTIVE_MODE` 控制（默认 `self_assess`：不判对错，学生自评）。空答案不计对错。设计见 `docs/superpowers/specs/2026-09-09-judging-rework-design.md`。
- **`npm run build` 会经 `scripts/copy-assets.mjs` 把 `ai-core/*.yaml` 与 `prompts/` 复制进 `dist/ai-core`**，使 `node dist/main.js` 与 `tsx src/...` 读到同一份配置。

**已知限制与历史实现细节**（metrics 未接入 capability、`detectWrongAnswer` 用正则推断、ConversationService 内存存储无上限、gemini 流式未实现、多模态图片直送、错误映射与对话持久化、辅线「详细解析」走题库、会话标题路由等）已迁至 `docs/ai-core-changelog.md`。
