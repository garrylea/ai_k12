# CLAUDE.md 历史工作日志（迁出归档）

本文件是从根目录 `CLAUDE.md` 迁出的带日期修正/新增记录（2026-07-24 → 2026-09-16；迁出后的新条目继续追加在顶部），原文保留、未做删改。目的是控制 CLAUDE.md 体积、避免模型上下文失焦。

- 各条目引用的任务级实现计划见 `docs/superpowers/plans/`
- 仍生效的行为约束已提炼回 CLAUDE.md 的「关键约定」节，本文件仅作历史溯源
- 阅读当前约定请以根 `CLAUDE.md` 为准；本文件内容可能包含已被后续条目修正的过时描述

---

## 2026-09-17 新增（闯关积分与段位体系：6 张表 + 14 条路径 + 快照重建 + 体裁标定）

**做了什么**：`apps/server/src/modules/points/`（`PointsService` 唯一发分入口、`PointRulesService` 家长可配分值、`RedemptionService` 兑换）；迁移 `2026-09-17_gamification_points.sql`（`point_rules`/`point_ledger`/`student_points`/`reward_catalog`/`point_redemptions`/`training_sessions` + `controls.points_per_yuan` + `chinese_passages.genre`）；埋点接全 8 类任务（甲类逐目标：`cn_dictation`/`cn_interpretation`/`cn_meaning`/`error_fix`；乙类整批：`math_targeted`/`en_vocabulary` 走 `POST /api/training/sessions/:id/complete`；丙类既有事件：`mainline_lesson`/`math_paper`）。学生端 4 端点 + 家长端 11 端点 + 会话完成 1 端点；快照重建脚本 `rebuild-student-points.ts`；体裁标定工具 `dictation_cli.py --export-genre / --set-genre`（**不猜体裁**，人工标定）。

**为什么每日上限用应用层算好的日界、不用 SQL 的 `CURDATE()`**：DB 会话时区与应用时区可能不一致，`CURDATE()` 会算错一天（仓内 `student-word-progress.repo.ts` / `vocabulary.service.ts` 早有注释）。两个边界（当日 00:00 / 次日 00:00）在 Node 侧按服务器本地时区算好、作为绑定参数传进 SQL，半开区间 `>= start && < end`。**一次调用只取一次 `now`、两个边界由同一个 `now` 派生**——各自取钟若跨过午夜会撑出 48 小时窗口，把两天的发分都算进今天。也不去改 `connection.ts` 的会话时区（会改变全应用 `NOW(3)`，blast radius 太大）。

**为什么 `error_fix` 排除考试来源**：发放条件是 `clearUnclearedByStudentQuestionId` 的 `affectedRows > 0`，它只覆盖「做题时清零」的路径。考试交卷的补判路径（`finalizeSession` 对在途/未作答题目补判）**不调用 award**——否则交卷会顺带冒出大量错题订正分，与 `math_paper` 的交卷分重复，而学生什么额外的事都没做。

**为什么 `cn_meaning` 用「最后一个可作答句」而不是 `sentences.length - 1`**：末句可能没有标准含义（`sentence_meanings[i] == null`、`answerable:false`、根本不出题），按下标判定会让这类篇目**永远拿不到分**。正确口径是「最大的 `i` 使 `meanings[i] != null`」。

**为什么解释专项「最后一句才发分」**：`cn_interpretation` 的发放点绑定「整篇最后一句判完」，中间句一律 0。否则学生只答第一句就能拿一篇的分；同一原因，`fullTranslation` 也只在最后一句下发（提前给整篇译文等于泄题）。判题本身仍是逐句的（学生答完一句立刻知对错）。

**为什么 `math_targeted` 也要每日上限（默认 5 次）**：四档是**打包价**（「3 题 8 分」不是 3×2），档位由学生自选、幂等键按 `sessionId`（每次开练都是新 key）。不限次时，把题池缩到 1 题就能用 `10` 档（35 分）反复 complete 无限刷。每日上限按 `task_code` 计数、四档共用 5 次（与 `en_vocabulary` 三档共用 2 次同口径），是主要且唯一的防刷手段。

**为什么兑换写 `earnedDelta: 0`**：`student_points.total_earned` 是段位唯一依据、语义上不可回退。兑换扣的是「可用余额」`balance`；若同事务里也减 `total_earned`，段位立刻会降，破坏「段位只升不降」。所以 `deductBalanceIfEnough` 的 SQL **只 `SET balance`、根本不出现 `total_earned`**，这是结构性保证而非约定。权威余额闸门也是它的条件 UPDATE（`WHERE balance >= ?`），并发兑换由 InnoDB 行锁串行化，只有一方 `affectedRows = 1`。

**其它易踩点**：`PointsService`/`RedemptionService` 的函数型参数 `now` 必须 `@Optional()`（带 `@Injectable()` 时 Nest 按 `design:paramtypes` 把函数类型当 token）；`dedupe_key` 只能由服务端从已知 id 拼（key 里嵌自增 id，可被枚举）；`title` 存快照（家长改分值后历史流水不变）；`duplicate` **不在** `awardReason` 枚举内（幂等命中本次未入账，报出去会弹假 `+N 分`）；发分失败一律 try/catch 吞异常且 `balance` 回 `null`、**不伪造 0**。

---

## 2026-09-17 新增（ai-core 场景 `chinese_meaning_judge`：语文古诗文「含义/情感」判题）

- `ChineseMeaningJudgeCapability` + `prompts/meaning/judge.md`（JSON 输出 + Zod：字词 / 整体含义 / 情感三项，模型漏项不视为解析失败，由调用方标 `undetermined`）。路由 primary=`local`（Qwen3.8-27B）、fallback=`deepseek-flash`，`retry.yaml` 加 `chinese_meaning_judge`。
- 与 `interpretation_judge` 同策略：**只对 `provider==='local'` 下发 `extraBody: LLAMA_CPP_NO_THINKING_BODY`**，且**不传 `thinking:false`**（对 llama.cpp 是空操作，对云端 fallback 会拉低判题质量）。已有测试钉住这条（本地带 extraBody 无 thinking / 非本地两者都不带）。
- 新场景按约定改了 8 处：`types.ts` 两个 union、`model-routes.yaml`、`retry.yaml`、`prompts/meaning/judge.md`、`prompt-builder.ts` 的 `resolveTemplatePath` 分支、capability 类、`seed-chinese-meaning-judge-route.ts`、**`admin-models.service.ts` 的 `SCENES` 白名单**。
- 已 seed 的库需跑 `npx tsx src/scripts/seed-chinese-meaning-judge-route.ts` 幂等补路由（YAML 只服务新装 / DB 空时）。

---

## 2026-09-16 归档（CLAUDE.md 瘦身：32.3KB → 18.6KB，迁出的稳定细节存此处）

**动作**：按用户要求把根 `CLAUDE.md` 收敛成「基本原则 + 文档索引 + 最新需特别注意的问题」三段式。
**所有「勿 / 必须 / 铁律」类约束一条都没删**（已按 26 个关键词逐条核验仍在），迁出的都是**长篇实现细节与已稳定行为**的叙述。以下为该次迁出的原文/要点，按主题归拢。

### 一、Data Refinery 细节（CLAUDE.md 现只留三条必读 + 指针）

`tools/data-refinery/` 是离线数据准备管线，四阶段顺序执行：
`convert_cli (MinerU) -> extract_cli (LLM) -> publish_cli (物化图片) -> db_loader_cli (MySQL)`。
`refinery_cli.py` 串联 publish + db_loader 一键执行；DB 由 `tools/db/install_mysql.sh` 初始化（schema + subjects seed）。

**现状**：管线已端到端跑通（refinery 237 tests 全绿、crawler 200 tests；2026-08-26 实测 `refinery_cli --purge-business-data` 全量重载 342 cards + 447 questions 成功，含幂等重跑与守卫复验）。题目内容回写工具 `answer_importer`（2026-09-10）在 `tools/data-refinery/src/`：JSONL/Markdown 输入，按单题/批量/按卷/按缺口回写 questions 的 answer/approach/explanation/type（`--export` 导出待补模板，`--apply` 幂等写入）。

**LLM 配置**：用 `.env` 的 `LLM_BASE_URL`/`LLM_AUTH_TOKEN`（refinery 专属），**不要用 `ANTHROPIC_*`**（会被 shell 里 Claude Code 覆盖）。当前用本地 llama.cpp `Qwen3.8-27B`（`LLM_PROVIDER=local`、`LLM_BASE_URL=http://192.168.1.8:12345/v1`，2026-08-26 起 Card 标注/目录解析走本地模型；`.env` 里注释保留了原远程 DeepSeek `deepseek-flash` 配置可切回）。

**extract 的细则**：lesson_id 由 LLM 给标题标识 + CLI 跨页继承（per-book 状态）；只有编号标题（`N.M`/`N.M.K`/`第N章`）开新课；章综述归该章"第 0 节"；前置内容（封面/目录/版权/前言）不抽取；试卷答案只提取不生成（从参考答案按题号提取，无则空）；
**全角括号统一半角**（2026-09-01）——读页 md 后 `normalize_fullwidth_parens`（`（）`→`()`，1:1 不改长度，NFKC 等价不影响 content_hash；其余全角标点 。，；！？ 不动——`。` 无 NFKC 映射会改 hash，`。！？；` 是 splitter 句末切分点）；
**页眉/页脚剥离 + 书尾识别**（2026-09-02）——`page_chrome.py` 书级频率统计自动发现运行页眉（≥3 页 + 安全模式：出版社/水印/纯页码/ISBN，「练习」等内容标题永不剥），`is_front_matter` 判定与 split 前都先 `strip_chrome`；`is_front_matter` 新增书尾规则（ISBN/绿色印刷/后记附录索引/电话+邮箱/组织说明页标记≥3/剥空页）。详见 `docs/superpowers/plans/2026-09-01-page-chrome-and-backmatter.md`；
**试卷路径二维码过滤**（2026-09-12）——`question_extract` 在答案合并后、`split_page` 前调 `qr_detect.strip_qr_images` 剔除公众号二维码图（`cv2.QRCodeDetector` 解码成功 + 二维码占图面积 ≥ `_MIN_QR_AREA_RATIO`=0.3；护栏防误删"角落带二维码的真实配图"，实测占图仅 0.014 vs 真二维码 0.86+）；二维码独占一行则删行，与正文同行则只摘引用保正文；教材卡路径不受影响（实测 733 张零二维码）。详见 `docs/superpowers/specs/2026-09-12-qr-code-image-filter-design.md`。

**publish**：资产路径用源相对稳定键；subject 按文件路径首段推导（2026-08-26 前曾硬编码 "math" 误标化学，已修）。

**db_loader 的细则**：subject 别名归一（chem->chemistry）、rel_path/lesson_id 解析派生教材结构、cards sort_order 跨页全局重排、full-reload 幂等；
**版次（edition）维度**——textbook_versions 按 `(subject_id, publisher, grade_band, edition)` 4 元组唯一，edition 用 `edition_from_book_name` 从书名前导括号提取（只用括号内容不用完整书名，勿用随机值做 code 破坏幂等）；
**页码锚定 lesson_anchor**（2026-09-02）——TOC 模式挂卡时 `load_book_cards` 先过 `LessonAnchor` 确定性修正：章边界首选综述卡锚定（每章「第N章」标签卡最小 md 页 = 章头页，无偏移误差；兜底首节 printed + 偏移众数 − 3 余量），规则 A 错章重写（content「复习题 N」> 时间线活跃节 > 标题匹配 > 章综述）/ B 同名消歧（「小结」「数学活动」按页所在章）/ C 复习题归一（挂该章「小结」，不建「复习题 N」lesson）；无 TOC/对不上 → 整体退化既有匹配。extract/publish/jsonl 不动，锚定每次 load 重算（重处理任意页不影响结构）。详见 `docs/superpowers/plans/2026-09-02-lesson-anchor-design.md`。

### 二、语文古诗文专项的实施状态（CLAUDE.md 现只留原则/边界/三条口径）

- 独立化改造**已完成**（2026-09-15）：表为 `chinese_passages`（无 `question_id`、无外键、含 `is_active`），`questions` 上的 `poem_dictation` 行与 `main_error_books(source='dictation')` 已清，四端点对外字段为 `passageId`，判题不写任何学生状态。
- **解释专项已实施**（2026-09-16）：三列 `key_terms`/`sentences`/`full_translation` 已加（迁移 `2026-09-16_chinese_interpretation_columns.sql`，纯 ADD COLUMN），`/training/interpretation/{passages,start,judge}` 三端点已通，`interpretation_judge` 场景已配，前端两页已上线。
- 内容生产走旁路：默写只看 `convert_cli` 一步；解释连 `convert_cli` 都不用——字词由用户手工整理后交 `interpretation_cli --input`（JSON/Markdown，字段名中英文都认），正文用库里已校验的 `body`，管线只做「解析 → 切句 → 字词归属 → 出译文 → 自检 → 幂等入库」。译文**混合模式**：输入给了 `sentences` 就用输入的（不调模型），没给才由 LLM 生成。
- **内容尚未灌入**（库里仅 2 篇 `DEV-FIXTURE` 假数据供手测）。
- 「不进错题本」的判据：错题本本质是**接主线清零门禁的待办队列**，不是「错过的题的统一记事本」。篇目级作答没有「重做—清零」的对象（专项不接主线，无解锁可放行）、没有变式生成物（§7.10 的变式以知识点为轴，篇目无知识点维度）、拉进错题练习也只是「再默一遍」（与专项自己的配置页重复）。**依据**：PRD §6.3 / §7.4 例外说明、架构文档 §4.2.13、spec §2。

### 三、apps/web 主题系统的细节（CLAUDE.md 现只留硬规则）

Canonical tokens 在 `apps/web/style.md` §2，实现于 `apps/web/src/styles/global.css`。
- `student-day` —— 暖橙红（`Brand-500 #ff6b35`）、`Bg-Page #F5F0E8`（默认）
- `student-night` —— 现已改为**浅灰底 + 白卡 + 浅灰蓝按钮**（学生反馈原「暗茶金」太暗字看不清），18:00–06:00 由 Zustand themeStore 自动激活
- `parent` —— 商务蓝白，强制白天

切换入口只有两处：`StudentLayout` 顶栏的「日间/夜间」按钮 + `CourseDetailPage`（两者也跑 `autoToggleNightMode` 每分钟一次）。训练轨内 22 个页面**全部硬编码 `student-day`**，无切换、无自动切换。

### 四、ai-core 的其他实现细节（CLAUDE.md 现只留仍需遵守的约定）

- **ModelClient DI**：各 capability 构造函数接受 `opts?: { modelClient?: ModelClient }`，测试注入 mock（无 API Key 也能跑）。生产用 `new ModelClient()`。
- **错误处理**（基于 `../llm-client.js`）：provider 经 `classifyError`（`infra/model-client/errors.ts`）抛 11 个错误子类之一（`LLMClientError` 基类 + `AuthenticationError`401 / `InsufficientQuotaError`402·429-quota / `PermissionError`403 / `ResourceNotFoundError`404 / `RequestTooLargeError`413 / `ValidationFailedError`400·422 / `ContentFilteredError`406·SAFETY / `RateLimitError`429 / `ServerError`5xx / `TimeoutError`abort；retryable 由子类决定）；`ModelClient.chat` 用 `callWithRetry`（full-jitter 退避 + 遵守 Retry-After + onRetry 钩子）包装，非 retryable 立即抛。
- **错误映射与对话持久化**：`mapLLMErrorToClient` 把 11 个错误子类映射为人类可读错误码（1001-1012/5000/5001 + retryable 标志）透传给前端；对话中模型错误若**尚未产出任何 reasoning/content**只持久化 user 消息（刷新回到「末条 user 待重试」），若**已流出部分思考/正文**（如空闲超时打断思考）则 best-effort 一并落库（assistant content 空时填 `[生成中断]`），刷新后仍可回看；重试请求带 `retry:true` 只追加 assistant、不重复落 user。前端 `setLastAssistantError` 不再清空已流出的内容/思考，错误气泡叠在思考过程下方。
- **Gemini**：system prompt 走 `systemInstruction`（不是 user 角色）；finishReason 映射 MAX_TOKENS->length、SAFETY->content_filter。**流式暂未实现**（streamGenerateContent 待配 GEMINI_API_KEY），`ModelClient` 对 gemini 强制 `stream=false` 非流式降级。
- **会话标题路由**（2026-09-11 起）：`title` 场景 primary=`local`、fallback=`deepseek-flash`。`TutoringCapability.generateTitle` 走 `modelRouter.route({scene:'title'})`（**不再硬编码 deepseek**）：primary 失败回退 fallback，**两者都失败则不生成标题**（保留默认「辅线答疑」，由学生手动重命名，明确不做文本兜底）；两个模型都失败时 `console.warn` 留痕。已 seed 的库执行 `npx tsx src/scripts/set-title-route.ts`。
- **多模态与图片**（2026-09-11 起）：`qwen3.8-max` 支持多模态，图片直接作为 `image_url` 部件随最后一条 user 消息送给辅导模型（`TutoringCapability.augmentWithImages`），无转录/确认两阶段（一图多题由 `prompts/tutoring/math/auxiliary.md` 的图片/多题处理段兜底）；`qwen-vl-max`/`qwen3-vl-plus` 两个 VL 模型与 `transcribe` 场景已删除。`ai_dialogues.flow_state`/`pending_question`/`pending_questions` 为遗留死数据（未做破坏性迁移，勿再读写）。
- **判题与解析分离**（2026-09-08 起）：判题（judgment）只判对错（isCorrect/errorType），prompt 勿加回 analysis 输出；判错解析由 `ExplanationCacheService`（practice 模块，**PracticeModule 导出供 TrainingModule 注入同一实例——勿重复 provide，会分裂 in-flight 队列**）后台生成入 `questions.explanation` 一次性复用（`answer>=100` 字符直写不调 LLM；否则 explanation 场景 `solution` 模式强模型生成，可含 SVG）。结果页批量拉解析走 `GET /training/questions/explanations`（等 in-flight 60s），刷新走 `explanation-wait`（120s，失败写 admin_notifications）。
- **辅线答疑「详细解析」走题库**（2026-09-11 起）：`AIService.maybeStoredExplanation` 在 `mode='auxiliary'` 且满足「学生已与助手来回 ≥ `fallback.yaml` 的 `detailedExplanationAfterRounds`（默认 2）轮 + 当前消息命中 `detailedExplanationKeywords`」时，**直接从题库取 答案+解题思路+解析**（`questions.answer/approach/explanation`）输出，**不调用模型**。题目定位：优先会话 `ai_dialogues.question_id`（AI 首次结构化入库时由 `AiDialoguesRepository.updateQuestionId` 回填，幂等仅当 NULL）；老会话无锚点则用首条用户消息题干匹配——**`content_hash` 优先、`QuestionRepository.findByContentPrefix` 的「归一化去标点前 20 字」兜底**，多命中取最新。**查不到题或题库无可用内容 → `TutoringRequest.forceFallback=true` 强制走 AI 完整解析兜底，不再回到苏格拉底追问。** 入库侧（`ingestStructuredQuestion`）：hash/前 20 字命中即复用、不重复插入，并确保该学生 `main_error_books` 有这道题（`source='auxiliary'`，`existsByStudentAndQuestionId` 幂等）。结构化输出新增 `approach` 字段。辅线 prompt 要求**每次引导必须给出关键信息**（关键已知条件/公式定理/下一步操作），不能只抛问题，但仍不得给最终答案。前端可发现性：`AuxiliaryHomePage` 在会话 ≥2 条 assistant 消息时给 `AuxInputBar` 传 `showAnswerHint`，提示「输入『详细解析』/『给我答案』即可获得 答案+思路+解析」（阈值 2 与后端配置对齐，前端硬编码，改后端需同步）。
- **测试与文档同步铁律**：若测试断言与 config/types/设计文档的值冲突，**测试错**——改测试，勿改 config/设计文档。（此条已保留在 CLAUDE.md。）

**已知限制（当时未修）**：metrics/logger 模块已实现但尚未在 capability 层接入；`detectWrongAnswer` 用正则推断学生答错（plan 设计，脆弱）；ConversationService 内存存储无 TTL/容量上限；缺 essay/reading/translation 评分模板（MVP 仅数学 proof/calculation）；部分 YAML 字段（classifier.confidenceThreshold、outputStructure）为声明式意图未接线；gemini 流式未实现；流式 usage 尽力收（Kimi 流式不返回 usage，cost 可能 0）。

**实现记录**：计划草稿偏差与 code-review 修正详见 `docs/superpowers/plans/2026-07-23-ai-agent-hub-mvp-implementation.md` 末尾「实现修正记录」「代码审查后修正」两节。

---

## 2026-09-16 新增（英语背单词子系统：表 + 端点 + 前端三页，内容管线待落地）

- **变更摘要**：
  1. **新子系统**：训练 → 英语 → 背单词（入口 `TrainingSubjectPage` 的英语由「敬请期待」翻成可点）。与语文古诗文专项同形——独立表、独立端点 `/api/training/vocabulary/*`、独立页面；**不挂 `questions`、不进错题本、不参与主线清零门禁、不用「不再展示」/提示缓存/自评**。
  2. **DB 两张表**（迁移 `2026-09-16_english_vocabulary.sql`，纯 `CREATE TABLE IF NOT EXISTS` 故重跑天然幂等；`schema.sql` 同步收录，两处 DDL 逐字节一致，已脚本校验）：`english_words`（**无外键**，表即完整边界；`word` 业务键；`level` 四层；`meanings` JSON；`root_key` 自关联表词根族；`root_affixes` JSON 存词缀注记；`error_count` 全平台累计错次**只增**）与 `student_word_progress`（唯一外键 `student_id→students(id)`；`word_id` **故意不设外键**——否则内容表全量重灌会被入向外键卡死）。
  3. **判题三条路由**：中→英**纯程序**（归一化 + 人工拼写变体组 + 逐字符差异，不调 LLM）；英→中·常见义（gloss 拆原子程序短路 → 未命中调 `english_word_judge`，二档）；英→中·熟词僻义（三档，多一档 `off_target` = 答成常见义）。
  4. **新场景 `english_word_judge`**：primary `local` / fallback `deepseek-flash`；本地端点靠 `chat_template_kwargs:{enable_thinking:false}` 关 thinking（`thinking:false` 对 llama.cpp 是空操作）。两个模式共用一份模板，靠调用方传的 `isExtended` 布尔标志分段。
  5. **前端**：`VocabularyConfigPage`（范围/数量/顺序/方向/四个筛选）+ `VocabularyRunPage`（提交即翻下一个词、判定异步回填）+ 四个业务组件（`WordPromptCard`/`WordFamilyTree`/`AnswerFeedList`/`SpellingDiffView`）。
- **动机**：用户要求「每天背 10-20 个单词（可选）」「可随机给中文或英文」「**特别特别重要的是熟词另意**（中高考阅读完型常考）」「词库要含初中 1600 词与高中 3000 词」「有词根的词点小 + 号看词之间关系和意思」。经头脑风暴逐项定案：词源用**课标官方 PDF 附录**（不用文库转载版，实测有 AI 生成副本）、分层存四层页面暴露三档、熟词僻义内嵌标记 + 配置页勾选（不另开专项入口页）、易错计数**两处都存**（词表全局只增 + 学生自己的可清除）、异步判定**落在前端**（后端 judge 单题同步，不引 job 队列）、词根族**不建新表**（`root_key` 自关联）、词根族 UI 用**就地展开缩进树**（不用放射图/图形库）。
- **实测**：起真服务 + 真 JWT + 真本地模型跑 **58 项端到端手测全绿**。其中僻义三档判题实得 `off_target`，模型给出的提示为「本题 address 在 address the problem 里是「处理；对付」；它更常见的义是「地址」」，与设计一致；中→英拼错走纯程序并给出逐字符差异；`off_target`/`unanswered` 确实未动两份错次。
- **验证**：`apps/server` vitest **748 passed**（本子系统新增 **185** 条：`normalize-english.util` 62、两个仓储 44、`english-word-judge` capability 18、`vocabulary.service` 45、`vocabulary.controller` 14、管理员 SCENES 漂移守卫 2；基线 563）；`apps/web` vitest **107 passed**（新增 30 条渲染用例）；两端 tsc 干净、web lint 0 error；`npm run build` 后 dist 资源与产物 bundle 均含新路由与文案。
- **踩坑（已记录进代码注释）**：① `VocabularyService` 带 `@Injectable()` 会发 `design:paramtypes`，**接口类型**的 `deps` 参数被写成 `Object`，Nest 当成真 token 去容器找、找不到就**启动直接失败**，必须 `@Optional()`；对照 `ai-core/capabilities/*` 故意不写 `@Injectable()` 才一直没踩到。② 拼写变体组**刻意排除** `storey/story`、`metre/meter`、`tyre/tire`、`kerb/curb`、`draught/draft`——它们看着像英式/美式变体，但其中一个成员多出别的义项，收进来就会把错答案判对。③ 抽题绕开 `ORDER BY RAND() + LIMIT ?`（mysql2 的 `execute` 不能传 `LIMIT ?`），改「取候选 id 池 → 服务层洗牌切 N」。
- **顺手修既有漂移**：管理员 `SCENES` 白名单漏了 `interpretation_judge`，写漂移守卫用例时又发现 `analysis`、`safety` 也漏（下拉里选不到 = 那条路由存得进却改不了），三条一起补齐并加用例把「YAML routes 的每个场景都必须在 SCENES 里」钉住。
- **待办**：**词库内容未灌入**——库里只有 16 条 `source_ref='DEV-FIXTURE'` 假数据（`npx tsx src/scripts/seed-vocabulary-fixture.ts`）。真实词库（课标官方 PDF → 1600/3000 词表 + 熟词僻义审校 + 词根族审校）与内容管线（`vocabulary_cli`/`vocabulary_loader`/`vocabulary_check`）**尚未开工**，见 `docs/superpowers/specs/2026-09-16-english-vocabulary-special-design.md` §6。另：义务教育课标附录**可能不带音标**（2011 版就不带），实现管线时先确认，没有就让 `phonetic` 留空、UI 隐藏该位置——**不要用 LLM 补音标**。
- **落地关键文件**：`tools/db/{schema.sql,migrations/2026-09-16_english_vocabulary.sql}`、`apps/server/src/{common/utils/normalize-english.util.ts,database/repositories/{english-words,student-word-progress}.repo.ts,modules/training/{vocabulary.service.ts,vocabulary.controller.ts,dto/vocabulary.dto.ts},ai-core/{capabilities/english-word-judge.capability.ts,prompts/english/word-judge.md},scripts/{seed-english-word-judge-route.ts,seed-vocabulary-fixture.ts}}`、`apps/web/src/{pages/student/training/english/*,components/business/vocabulary/*,services/api.ts,routes/index.tsx}`。

---

## 2026-09-16 新增（语文古诗文解释（翻译）专项 + 内容管线）

- **变更摘要**：
  1. **新专项落地**：训练 → 语文 → 专项 的第二张卡（古诗文解释）由「敬请期待」改为开放。**逐句判题**：学生按「三行对译」作答（原文 → 该句关键字词 → 整句翻译），点「下一句」即把该句送去判题（**异步不阻塞**，不等 LLM 回来就展开下一句；结果回填到该句卡片原位）。判题粒度经**用户 2026-09-16 裁决由「整篇一次批量」改为逐句**——学生答完一句立即知道对错，好及时纠正。
  2. **新场景 `interpretation_judge`**：`prompts/interpretation/judge.md` + `InterpretationJudgeCapability`（JSON 输出，`ResponseParser.parse({mode:'json'})` + Zod）。路由 primary=`local`（Qwen3.8-27B）、fallback=`deepseek-flash`；**只对 local 下发 `extraBody: LLAMA_CPP_NO_THINKING_BODY` 关 thinking**（与 `dictation_feedback` 同策略），**不传 `thinking:false`**（对本地是空操作、对云端 fallback 会拉低判题质量）。`retry.yaml` 加 `interpretation_judge: 30000`。
  3. **判题流程三段**：① 程序短路（空白 → `unanswered`；`normalizeChineseAnswer` 全等 → `exact`），**不进 LLM**；② 剩余待判项**打包一次**调用；③ 模型漏项 / 整次失败 → 那些项 `correct: null, method: 'undetermined'`，**不抛错、已判项不清空**。
  4. **不写任何学生状态**：无错题本 / 隐藏项 / 提示缓存 / 自评（古诗文专项是独立子系统，PRD §6.3 / §7.4 例外）。
  5. **DB**：`chinese_passages` 加 `key_terms`(JSON) / `sentences`(JSON) / `full_translation`(TEXT)，迁移 `tools/db/migrations/2026-09-16_chinese_interpretation_columns.sql`（**纯 ADD COLUMN，无 DELETE/DROP**）。`key_terms` 每项带 `sentenceIndex` 指向 `sentences` 下标。
  6. **内容管线**：`interpretation_cli` + `interpretation_input`（JSON/Markdown 解析，字段名中英文都认）/ `interpretation_split`（切句 + 字词归属）/ `interpretation_check`（自检）/ `interpretation_translate`（译文生成）/ `interpretation_loader`（幂等入库，只 SET 三列）。**字词由用户手工整理**，管线不碰教材页 MD。
- **动机**：用户要求「可以随机选，也可以指定篇目练习，每一篇完了才能下一篇」，并要求按「原文 → 该句关键字词 → 整句翻译」的三行对译逐句作答、每句答完立即判。字词内容用户自己整理，故原 spec §5 的「从教材页抽注释 + LLM 补字词 + 注释归属」整块作废。
- **实测**：判题响应——全空 0 次 LLM 调用（全 `unanswered`）、归一化全等 0 次调用（全 `exact`）、需语义判断的项走本地模型**整句判题 ~1.3s**（含字词 + 整句，一次调用）。curl 手测：`err_books=0 / hidden=0`（判题零学生状态）、越界 400、篇目不存在 404、`count=4` 400、非法 `semester` 400。
- **验证**：`apps/server` vitest **558 passed**（新增 46：repo 12 + capability 11 + service 24 + controller 11，含「两条抽题池口径不同」的反向对照）；`tools/data-refinery` pytest **994 passed**（新增 103）；`apps/web` lint 0 error + build 通过；openapi.yaml 解析通过（150 端点 / 136 schema，新增 3 端点 11 schema）。
- **抓到的 bug（已修）**：`interpretation_cli.main` 只给 `--extract` 时**没 return，穿透到 `run_apply`**——一次性违反了「只出 JSONL 不写库」的承诺。已改为四个动作各自显式 return，并加 5 条 dispatch 单测钉住。
- **抽题池口径有意不同（勿统一）**：默写 = `verified=1 AND memorize_required=1 AND is_active=1`；解释 = `verified=1 AND is_active=1 AND JSON_LENGTH(sentences) > 0`（**不设必背、加内容就绪**——「要背诵」不是「要理解翻译」的必要条件；没切过句的篇目点进去没题目）。
- **落地关键文件**：`database/repositories/chinese-passages.repo.ts`、`ai-core/{types.ts,capabilities/interpretation-judge.capability.ts,prompts/interpretation/judge.md,model-routes.yaml,retry.yaml,infra/prompt-builder.ts}`、`modules/training/{training.service,training.controller,training.module}.ts` + `dto/interpretation.dto.ts`、`scripts/seed-interpretation-{judge-route,fixture}.ts`、`tools/data-refinery/src/interpretation_*.py`、`apps/web/src/{services/api.ts,routes/index.tsx,pages/student/training/chinese/{ChineseSpecialPage,InterpretationConfigPage,InterpretationRunPage}.tsx,components/business/interpretation/*}`、`tools/db/{schema.sql,migrations/2026-09-16_chinese_interpretation_columns.sql}`。
- **待办**：内容未灌入（库里仅 2 篇 `DEV-FIXTURE` 假数据供手测）。用户整理好字词后跑 `interpretation_cli --all --input <file>` 即可，**不需改任何代码**。

---

## 2026-09-14 修正（默写判题与错因解耦 + 本地端点关 thinking + 差异回投标点）

- **变更摘要**：
  1. **错因移出判题关键路径**：`TrainingService.judgeDictation` 不再 `await` LLM（实测 12.6s → **25ms**），响应加 `feedbackPending`、`feedback` 恒 `null`；错因改由新端点 `POST /api/training/dictation/feedback` 单独取（实测 ~2s）。前端 `DictationRunPage` 提交后**立刻**渲染对错 + 正文对比，错因区转圈 +「AI 正在生成错因提醒…」。
  2. **新增 `ChatRequest.extraBody`**（`ai-core/types.ts` + `OpenAICompatibleClient.buildRequestBody` 末尾 `Object.assign`）：provider 专有参数逃生舱，允许覆盖默认字段。
  3. **本地端点关 thinking 的正确姿势**：`LocalClient` 导出 `LLAMA_CPP_NO_THINKING_BODY = { chat_template_kwargs: { enable_thinking: false } }`；`DictationFeedbackCapability` 只对 `provider === 'local'` 下发。**`thinking: false` 对 llama.cpp 完全无效**——它不认 DashScope 的 `enable_thinking`，而 `LocalClient` 会把这个字段删掉。
  4. **差异视图回投原文标点**：新增 `diffChineseInOriginalText`（`diffChinese` 保持归一文语义不变），`judgeDictation` 改用它。判对错口径**未变**（仍忽略标点与空格）。
  5. **新增纯函数 `evaluateDictation`**：判题逻辑从 `judgeDictation` 抽出，判题与错因两条路径共用，避免重复实现。
- **动机**：学生答错后要盯着一个变灰的「正在判题…」按钮等 13–16 秒（本地 `Qwen3.8-27B` 是思考模型，先出 `reasoning_content` 再出正文），全程无任何等待反馈，用户报「一直处理等待状态，不给对错结果……也应该有一个等待的动画呀」。同时用户报「判对错时显示错误点为什么没有标点符号」——判题忽略标点是设计，但**展示不该跟着去标点**。
- **实测**：`extraBody` 关 thinking 三组对照——什么都不传 `reasoning_content` 45 字、prompt 末尾加 `/no_think` 49 字（软开关无效）、`chat_template_kwargs` **0 字**（1.2s 直接出正文）。全链路：判题 25ms（答对/答错同）、错因 2.3s、浏览器端「正在判题…」→ 13ms 后出结果 → 错因转圈 1949ms 后填充。
- **验证**：`apps/server` vitest **497 passed**（新增 12 个：标点回投 5、`evaluateDictation` 3、解耦 2、`extraBody` 3 等）；openapi.yaml 与 `API接口与数据流设计文档.md` 端点清单对齐（dictation 4 端点）。
- **遗留**：`retry.yaml` 的 `dictation_feedback: 30000` 仍是**死配置**——流式调用只认 `streaming.firstTokenTimeoutMs`(3s)/`interTokenTimeoutMs`(10s)，`request.timeout` 仅在 `streaming.*` 缺失时兜底；而每收到字节都会重置空闲计时器，故持续吐思考 token 的调用**没有墙钟上限**。本次未改（解耦后它已不在关键路径上）。
- **落地关键文件**：`modules/training/{training.service,training.controller}.ts`、`modules/training/dto/dictation.dto.ts`、`modules/practice/judge-core.service.ts`、`common/utils/normalize-chinese.util.ts`、`ai-core/{types.ts,infra/model-client/{local-client,openai-compatible-client,index}.ts,capabilities/dictation-feedback.capability.ts}`、`apps/web/src/{services/api.ts,pages/student/training/chinese/DictationRunPage.tsx}`。

---

## 2026-09-14 新增（语文默写内容管线：九年级教材 → 题库）

- **变更摘要**：
  1. **新增旁路管线**（`tools/data-refinery`，不接进四阶段主线，避免动到 `textbook_cards`/`questions` 的既有语义）：爬 + 转 + 目录三步复用现成 CLI，抽取/入库/串联三步新建（`dictation_cli.py` + `dictation_locate.py` / `dictation_slice.py` / `dictation_check.py` / `dictation_repair.py` / `dictation_loader.py`）。产物落 `output/dictation/语文/<册次>/`。
  2. **定位改纯程序**（**本节最关键的修正**）：原设计让 LLM 返回「正文首末句锚点」且**一次调用喂一整个单元**（实测第六单元 30 页 1.45 万字、一次找 13 篇）；因 `llm.py` 不传 `temperature`，**同代码同输入连跑 3 次得 23 / 22 / 20 篇**、每次漏的还不同。用户指出「篇目在目录里、按页码定位是程序的事」后改为纯程序版面规则（标题行 → 跳过编者导语/作者/题解/图片 → 终止符 → 按格律收尾）。改后实测 **24/24 篇、0 未解决、连跑两次完全一致**。
  3. **LLM 只留两件事**：`ask_identity`（每篇一次极小调用，只要作者/朝代/体裁——目录 label 只有「篇名/作者」、没朝代）与 `dictation_repair`（正文纠正）。**LLM 不再产出锚点、不参与判断正文起止**。
  4. **词牌格律作「切不出来」的确定性出口**：教材里《沁园春·雪》的正文被写作背景与课后思考题**逐行插花**、还跨页拆开，任何连续子串都取不到正确的词（实测切出 376 字 vs 词牌 114 字，且旧实现一直把这个错稿入库）。新增 `CI_PATTERNS` 词牌字数表与 `check_body` 的格律判错项 → 转模型重写 + 人工过目（376 → 139 字正确的词）。
  5. **`memorize_required` 字段与抽题池两道闸门**：抽题池 = `verified=1` **且** `memorize_required=1`（前者是内容已校验、后者是教学上要求背诵）。三条查询全部收紧，与 `questions.is_active` 共同作用；`findByQuestionId`（判题路径）**有意不设门禁**。
  6. **入库器按业务键幂等**（`dictation_loader.py`）：身份是 `(work_title, semester)`，命中既有篇目就**原地 UPDATE 复用其 `question_id`**。**刻意不用 `content_hash` 去重**（题面模板一改 hash 就变，会插新行、把旧行变孤儿，而 `main_error_books.question_id` 外键是 RESTRICT）。`memorize_required` 只在 INSERT 写死 0、**不在冲突分支出现**（否则重跑会把用户标好的必背刷回 0）。
  7. **小作文案约定**：题面只放篇名（`请默写《X》`），作者/朝代/正文进 `answer` 三行——三者都是学生要默写的答案，写进题面等于泄题。
- **动机**：训练轨「专项练习」此前全链路写死数学，语文学科除模拟卷 Markdown 外无任何入库内容。默写适合程序化判题（答案确定、无需 AI 判对错），且能顺带补上语文第一份结构化题库。设计见 `docs/superpowers/specs/2026-09-13-chinese-dictation-content-pipeline-design.md`（§5.2/§5.3 已按纯程序定位重写，§13 为实现结果）。
- **实测（九上，170 页）**：候选 24 篇 → 命中标题行 24/24 → 入库 24 篇、**待人工处理 0 项**；其中 2 篇由模型纠正（《醉翁亭记》《沁园春·雪》）；偏移众数可靠（+7，未退化滑窗）；首轮入库 `新增题 24/复用 0`、二次 `新增题 0/复用 24`（幂等）、26 行 26 个不同题号、孤儿默写题 0；**抽题池仍只有两篇 `DEV-FIXTURE`**（真篇目 `verified=1` 但 `memorize_required=0`，门禁生效的证据）。
- **落地关键文件**：`tools/data-refinery/src/dictation_{cli,locate,slice,check,repair,loader}.py` + `prompts/dictation_{locate,identity,repair}.txt`；测试 `tests/test_dictation_*.py`（refinery 全量 **885 passed / 10 skipped**）。`apps/server` 侧为 Task 1 已有的三端点 + 仓储门禁，本次仅改两处陈旧注释与仓储 `upsert` 的一致性说明。
- **九下（同日跑完）**：规则**零改动**即泛化——24/24 命中、0 未解决、偏移众数同样可靠（+7）。两册合计 **48 行 / 39 个不同篇名**全部入库。九下暴露并修掉 4 类新问题：① 尾部编者赏析漏切（原 `trim_to_form` 只对收录在 `CI_PATTERNS` 的 `ci` 生效，而《定风波》《临江仙》《太常引》词牌没收录、两首是**曲**——曲有衬字不能用定数）→ 新增通用规则「丢掉尾部 ≥60 字的长白话行」，词牌表补 `定风波 62`；② 正文混入插图/书法页的**繁体无标点文字块**（九上《邹忌讽齐王纳谏》702 → 438 字，与九下一致）→ 新增自检项「连续 ≥30 字无标点判错」，实测 48 篇命中 1 篇零误报；③ **LLM 答错作者 4/48 篇**（《南安军》→「韩偓」、《临江仙》→「陈廷焯」等）→ 改为**作者以教材目录为准**（目录 label 就是「篇名/作者」），不一致时留痕（正是这条留痕暴露了 4 处错误）；④ 朝代跟着错作者一起错（《南安军》「文天祥/唐」、正确宋）→ `ask_identity` 把目录作者写进请求、要求据此判朝代，三处全部纠正。
- **两册重复 9 篇**（《曹刿论战》《邹忌讽齐王纳谏》《陈涉世家》《出师表》《十五从军征》《白雪歌》《南乡子》《过零丁洋》《山坡羊·潼关怀古》——两册的第六单元都是文言文单元，各印一次；已核对原书页，课号不同不是解析错误）。用户裁决：**两册都收 + 抽题时按篇名去重**。`findRandomVerified` 在**无册次过滤**时按 `work_title` 取 `MIN(id)`（实测 48 行 → 39 个不同篇名），**有册次过滤时不加**该子查询（跨册取 MIN 会把该册的行整体排除）。
- **遗留**：**必背标定未做**（全部 `memorize_required=0`，真篇目暂不进抽题池）；`findVerifiedBySubject`（配置页清单）暂未去重，「全部册次」下会看到重复条目；`llm.py` 不传 `temperature` 仍使 `ask_identity`/`dictation_repair` 不可复现（定位已绕开）。

---

## 2026-09-14 新增（语文默写内容管线：自检未过的正文交模型纠正）

- **变更摘要**：
  1. **新模块 `tools/data-refinery/src/dictation_repair.py` + `prompts/dictation_repair.txt`**：这是本管线**唯一允许模型产出正文字符**的环节。`dictation_cli --extract` 切片后 `check_body` 报 `errors` 的篇目，不再直接丢进待人工处理清单，而是先把正文与自检问题交给模型纠正，**模型输出经 `normalize_body` 清理后直接采用**（用户裁决：不设采纳闸门）。
  2. **模型选择**：本地模型优先（`.env` 的 `LLM_PROVIDER`，当前 `Qwen3.8-27B`），本地失败或拿不出非空输出 → 回退 `LLM_FALLBACK_*`（当前 `deepseek-flash`）。两者都拿不出非空输出才维持 fail-closed（不进 JSONL）。**不硬编码任何模型名**。
  3. **触发范围只限致命档**：`needs_review` **不触发**纠正——后者故意装着正常情况（《十五从军征》首行即篇名、古体诗字数不在常见值内），送去纠正只会改坏正确正文。
  4. **`normalize_body` 这步不能省**：模型常把角标 `$^{①}$` 原样抄回，不清理就进库，而学生不会打角标 → 判题必然不等（已加测试钉住）。
  5. **留痕**：`{book}-review.md` 新增「已由模型纠正」一节，逐篇并列**纠正前 / 纠正后**全文、原自检问题、以及「纠正后自检仍报什么」（只提示、不阻断）。清单表也加了「已纠正」列。CLI 末行打印「其中模型纠正 N 篇」。
- **动机**：用户 2026-09-14 指示「如果判定这道古诗、古文内容可能存在问题，调用本地大模型进行纠正；本地失败则用 ds flash 更正」。加它是因为有一类错误**在页面上就是错的**——OCR 认错字、注释碎片混进正文——不存在「原样可切的正确源」，程序修不了。这是对管线原设计原则「LLM 只做判断、不产出正文」的**显式例外**。
- **实测（真书 + 真本地模型，非 mock）**：九上实跑把原先被拦下的《醉翁亭记》救回来——原文 584 字里混着注释 ⑤ 的续行 `起）像鸟张开翅膀一样，高踞于泉水之上。临，居高面下。`（起始行 OCR 丢失，浅切抓不到）与行内图片 `![](images/a9ee…jpg)`；模型纠正稿 478 字把两者都剔净，语句自然衔接，且纠正后自检通过（`residual` 为空）。
- **中途回退的设计（重要教训，勿改回去）**：曾实现 `[0.7, 1.5]` 的**长度比护栏**（本意是拦「纠正实为截断」）。实测发现它与最常见的一类错误**「正文过短」自相矛盾**——修「过短」本来就**必须**让正文变长，而任何长到能让 `check_body` 通过的长度都会超出上界，于是把最需要它修的情形全部拒掉。用户裁决「直接用 LLM 输出就可以」后去除。**残留风险如实记录**：模型凭记忆补写古文可能补出「形式干净但内容不对」的文字，而自检**只看格式看不懂内容**，抓不到——这正是留痕要把原文与纠正稿并列、须人工比对的原因。设计见 `docs/superpowers/specs/2026-09-13-chinese-dictation-content-pipeline-design.md` §5.4。
- **落地关键文件**：`tools/data-refinery/src/dictation_repair.py`、`src/prompts/dictation_repair.txt`、`src/dictation_cli.py`（`run_extract` 接线 + 报告节）、`tests/test_dictation_repair.py`（25 例，全 mock）、`tests/test_dictation_cli.py`（+3 集成例：纠正采纳 / 两者皆空 fail-closed / 自检通过时不触发纠正）。**845 passed / 10 skipped**。
- **⚠️ 同时暴露的既有缺陷（与本次改动无关，已单独立项）**：`locate` 环节**不可复现**——同代码同输入连跑 3 次得 23 / 22 / 20 篇。根因：`llm.py` 不传 `temperature`（走服务端默认采样），且「第六单元」页窗 30 页（全书最大，末单元的 `hi` 一路延伸到书尾），本地 27B 在长窗口里不稳定地漏掉尾部那组 `课外古诗词诵读`（印刷页 159）。漏收在 `{book}-unresolved.md` 里有记录、非静默，但**记录在案 ≠ 收全**。

---

## 2026-09-14 修正（DeepSeek 模型改名：`deepseek-v4-flash` → `deepseek-flash`）

- **变更摘要**：
  1. **DeepSeek 端点现状（实测确认）**：`GET /v1/chat/completions` 只接受**两个**模型名——`deepseek-flash`、`deepseek-v4-pro`；传其它名字直接 400 并在错误体里列出支持列表（`"The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed X"`）。`deepseek-v4-flash` 目前**仍能解析**（响应 `model` 字段已回落成 `deepseek-flash`、`deepseek-chat`/`deepseek-reasoner`/`deepseek-coder` 同样回落），但已不在支持列表里，属不再保证的旧别名，故全面改名。
  2. **配置与代码改名**：`ai-core/model-routes.yaml`（模型块 key + `modelId` + 13 处路由 primary/fallback 引用）、`ai-core/safety.yaml`（classifier）、`ai-core/infra/model-router.test.ts`、`capabilities/{judgment,hint,tutoring}.capability.test.ts`、`scripts/llm-route-seed.util.test.ts`、三个 `__tests__/` 联调脚本（`error-baseurl`/`error-badkey`/`deepseek-stream`）、若干注释，以及工具侧 `tools/deploy.sh` 默认模型名、`tools/deploy/apply-llm-config.mjs` 的 `MODEL_KEY`、`tools/data-refinery/src/env_bootstrap.py` 的 `YAML_MAIN_KEY`、`apps/server/.env.example`、refinery `.env` 的 `LLM_FALLBACK_MODEL`。
  3. **存量库迁移** `tools/db/migrations/2026-09-14_rename_deepseek_flash_model_key.sql`：`llm_routes.primary_model_key` 对 `llm_models.model_key` 有外键（`fk_llm_routes_primary`，`UPDATE_RULE=NO ACTION`），**直接 UPDATE 主表会因「子表仍引用旧值」失败**；故按「① 建新行（复制旧行连接参数与 api_key 密文、`model_id` 对齐新名）→ ② 改 `llm_routes` 的 fallback 与 primary 引用 → ③ 删旧行」三步走，且第 ③ 步要**同时**满足「替代行已在库」+「无任何路由仍引用旧 key」才执行（拒绝在替代行缺失时误删）。幂等：旧 key 不存在时全为 no-op。
  4. **路由表已 seed 的库不必重跑 seed 脚本**：改名只动 key 与引用，路由指向关系不变（`judgment/math` 仍是 `local / qwen3.8-max`）。
- **动机**：用户反馈「DeepSeek 推出了新模型、模型名统一改成了 deepseek-flash」，要求实测确认并同步 ai-core。改名前 `deepseek-v4-flash` 是唯一写死的 DeepSeek 名字，散落在配置、测试断言、部署脚本与 refinery 引导逻辑里；一旦官方下线该别名，报错面会横跨 ai-core 与部署链路。趁别名尚可用时改到规范名，代价最低。
- **实测**：迁移对 dev 库跑两遍——第 1 遍 `llm_models` 5 行（`deepseek-flash` 就位、旧行删除）、17 条路由 `deepseek-flash` 全覆盖；第 2 遍全 no-op（输出 4 个 `SELECT 1` 占位）。孤儿检查（路由指向不存在的 `model_key`，含 fallback）返回 0 行。`apps/server` 478 tests 全绿；`tools/data-refinery` 824 passed / 10 skipped。
- **落地关键文件**：`apps/server/src/ai-core/{model-routes,safety}.yaml`、`ai-core/**/*.test.ts`、`ai-core/__tests__/*.ts`、`src/scripts/*.ts`（注释）、`tools/db/migrations/2026-09-14_rename_deepseek_flash_model_key.sql`、`tools/deploy.sh`、`tools/deploy/apply-llm-config.mjs`、`tools/data-refinery/src/env_bootstrap.py`、`tools/data-refinery/tests/{test_env_bootstrap,test_llm}.py`；文档 `CLAUDE.md`、`docs/K12智学系统-AI-Agent中枢设计文档.md`、`docs/K12智学系统-数据库设计文档.md`、`docs/API接口与数据流设计文档.md` + `docs/api/openapi.yaml`、`docs/data-refinery-{使用手册,管线总结与后续}.md`。历史计划/旧 spec 中的旧名**未回改**（保历史原貌）。
- **遗留（未改，待后续）**：`tools/data-refinery/src/llm.py` 的 `DeepSeekClient.__init__` 里有一段「`thinking=False` 且模型名是 `deepseek-reasoner`/`deepseek-r*` 时切成 `deepseek-chat`」的旧适配——新端点下 `deepseek-reasoner` 与 `deepseek-chat` **都**回落到 `deepseek-flash`，这段切换已无实际意义（当前也无配置走 `deepseek-r*`，故未触发）；`deepseek-v4-pro` 是本次新出现的模型，尚未纳入任何路由。

---


- **题面去掉「（并写出作者与朝代）」**：该文字出现在答题页标题上（用户实测反馈「不应该出现」），来源是库里的 `questions.content`——题干由 `seed-dictation-fixture.ts` 按模板生成，前端只是原样渲染 `prompt`，并非前端硬编码。作者/朝代/正文三者都是要学生默写的**答案**，已由答题页三个字段承载，题面重复一遍纯属噪音。约定改为 **`questions.content` 只放「请默写《篇名》」**，已写入 spec §4.1（内容管线生成题面时须遵守），同步更新 `docs/api/openapi.yaml` 的题面描述示例、种子脚本与两处测试夹具。
- **种子脚本幂等键由 `content_hash` 改为篇目业务键**：原实现按 `content_hash`（由题面算出）去重，**题面模板一改 hash 就变** → 重跑会 `INSERT` 出**新行**并把旧行变孤儿（旧行仍占 `content_hash` 唯一键，且 `main_error_books.question_id` 外键为 `RESTRICT`，删旧行还可能被拦住）。现改为先按 `dictation_passages` 的业务键 `(work_title, semester)` 定位已有 `question_id`，有则**原地 `UPDATE`** `questions`（保住 `question_id`，错题本/隐藏题等挂在它上面的数据不受影响），无则插入。
- **新增安全阀**：若目标篇目已存在且其 `questions.source` 不是 `DEV-FIXTURE`（即已由内容管线导入的真实题库），脚本**跳过并告警**，绝不覆盖真题——避免这个开发假数据脚本在内容上线后误伤生产数据。
- **实测**：本地库 `questions` 5036/5037 被原地改写为新题面（`请默写《静夜思》` / `请默写《登鹳雀楼》`），连续两次运行打印的 `questionId` 不变、`questions` 与 `dictation_passages` 计数恒为 2/2，无孤儿行、无重复行。

---

## 2026-09-13 新增（训练 → 语文 → 专项：古诗文默写）

- **变更摘要**：
  1. **新题型 `poem_dictation`**：`questions.type` 新增语文古诗文默写题型（整篇默写，`questions.answer` 以「作者：…/朝代：…/正文：…」存参考答案，`questions` 行作错题本/隐藏/提示的锚点）。
  2. **新表 `dictation_passages`**：承载篇目级结构化字段（`question_id` FK / `work_title` / `author` / `dynasty` / `body` / `grade_band` / `grade` / `semester` / `sort_order` / `source_ref` / `verified`）。业务主键 `uniq_dp_work (work_title, semester)` + `uniq_dp_question (question_id)`；`semester VARCHAR(20) NOT NULL`（册次为必填维度，参与唯一键与抽题过滤，不允许空值）。校验闸门 `verified`：只有 `verified=1` 的篇目进抽题池；导入侧可先落全量再逐篇校验放行。schema 见 `tools/db/schema.sql`。
  3. **`JudgeCoreService.judgeDictation`（纯程序化，不调用任何 LLM）**：三字段各自 `normalizeChineseAnswer`（NFKC 全半角归一 → 去空白 → 去中英文标点 → 小写，复用语料库唯一标点表 `PREFIX_STRIP`）后全等，**三项全对才判对**；正文不等时用 `diffChinese`（LCS 最长公共子序列回溯）做逐字差异，相邻「漏写 + 多写」合并为一个 `wrong`（写错字）、连续同类项合并成段。答错 find-or-create 写 `main_error_books`（**新增 `source='dictation'`**）；答对清零该题所有未清记录（不限 source）。**刻意不触发 `ExplanationCacheService`**——其「`answer>=100` 字直写解析」规则会让长文言文的解析变成「解析 = 正文」。
  4. **新场景 `dictation_feedback` + `DictationFeedbackCapability`**：只写错因 prose，不参与判对错。路由 `model-routes.yaml` primary=`local`（本地 llama.cpp `Qwen3.8-27B`）、fallback=`deepseek-v4-flash`；`retry.yaml` per-scene timeout 30s；`Scene` / `CapabilityType` 联合类型补 `dictation_feedback`。模型不可达/超时/解析失败 → `feedback=null`，**判题结果与错题本写入照常返回，不阻断**。
  5. **三端点**（`TrainingController`，student JWT）：`GET /api/training/dictation/passages`（已校验篇目清单，作者/朝代/正文均不下发）、`POST /api/training/dictation/start`（`semester: 上册|下册|null` + `questionIds: number[]|null` + `count: 1-20`；题项白名单只出 `questionId/prompt/workTitle/semester`，作者/朝代/正文一律剥离防答案泄露；随机抽题路径按 `student_hidden_questions` 排除该生已标记『不再展示』的篇目，按 `questionIds` 指定篇目的路径不做该排除）、`POST /api/training/dictation/judge`（返回 `{questionId, isCorrect, fields, bodyDiff, reference, feedback, errorBookId?}`）。新增仓库 `DictationPassagesRepository`（`findVerifiedBySubject` / `findRandomVerified` / `findVerifiedByQuestionIds` / `upsert`）。
  6. **`questions.content_hash` 唯一索引漂移修复迁移** `tools/db/migrations/2026-09-13_ensure_uniq_q_content_hash.sql`：老库 `questions` 由 `CREATE TABLE IF NOT EXISTS` 创建，`uniq_q_content_hash` 从未补上，导致种子/`answer_importer` 的 `ON DUPLICATE KEY UPDATE` 静默插重复行、`findOrCreate` 的并发兜底失效。迁移幂等（查 `information_schema` 无单列唯一索引才 `ALTER`）；库中已有重复 `content_hash` 时以 `ER_DUP_ENTRY` 响亮失败（先诊断清理再重跑）。种子脚本 `seed-dictation-fixture.ts` 启动时断言该索引存在，缺失即报错退出。
  7. **前端**：`TrainingSubjectPage` 开放语文入口 → `ChineseSpecialPage`（两卡：古诗文默写可点 / 古诗文解释灰化「敬请期待」）→ `DictationConfigPage`（范围 + 题量）→ `DictationRunPage`（三字段作答 + `DictationDiffView` 差异高亮 + 错因提醒）；`DictationAnswerForm` / `DictationDiffView` 为业务组件；`api.ts` 加三接口。
  8. **开发种子**：`src/scripts/seed-dictation-fixture.ts` 以 `source_ref='DEV-FIXTURE'` 播种《静夜思》《登鹳雀楼》两篇（幂等：questions 走 `content_hash`，passages 走 `(work_title, semester)` upsert）。
- **动机**：训练轨「专项练习」此前全链路写死数学（`TrainingSubjectPage` 语文 `enabled:false`），语文学科除模拟卷 Markdown 外无任何入库内容。默写适合程序化判题（答案确定、无需 AI 判对错），且能顺带补上语文第一份结构化题库，故作为语文第一个专项打通链路。设计见 `docs/superpowers/specs/2026-09-13-chinese-dictation-special-design.md`。
- **落地关键文件**：`modules/practice/judge-core.service.ts`（+`judgeDictation`）、`modules/training/training.{controller,service}.ts`（+3 端点/3 方法）、`modules/training/dto/dictation.dto.ts`、`database/repositories/dictation-passages.repo.ts`、`common/utils/normalize-chinese.util.ts`（`normalizeChineseAnswer`+`diffChinese`）、`ai-core/capabilities/dictation-feedback.capability.ts`、`ai-core/{model-routes,retry}.yaml`、`ai-core/types.ts`、`ai-core/prompts/`；DB `tools/db/schema.sql` + 迁移；web 3 页 + 2 组件。server 测试 478 绿（新增 judge-core 默写 / repo / service / controller 各测试），web tsc + lint + build 通过。
- **验证**：本任务（Task 16）以本地起 server（`:3000`）+ 手工签发 student JWT 做 HTTP 端到端——篇目清单出 2 篇 fixture、开练题项确认无正文/作者泄露、故意错一字判 `isCorrect=false` 且 `bodyDiff` 定位该错字并写入 `main_error_books(source='dictation')`、全对（标点/空格不同）判 `isCorrect=true` 且清零该错题行；验证后清理了本次产生的错题行。**浏览器点击手测未做**（见下）。
- **局限/待办**：
  - **九年级必背篇目全量内容未做**：库中仅两篇 `source_ref='DEV-FIXTURE'` 开发假数据，真实篇目（九年级上下册教材背诵/默写篇目全量 + 逐字校验）待**内容管线**（爬 smartedu 教材 + 逐篇校验）按 `dictation_passages` 导入，见 spec §6；当前三端点与判题链路已通，但内容覆盖为零。
  - **语文错题练习页未做**：默写错题已进 `main_error_books(source='dictation')`，但**不计入**错题清零门禁（门禁 `findUnclearedPracticeByStudentSubject` 只查 `source='practice'`），故默写错题不阻塞主线推进（见 spec §4.3）；语文的错题练习前端页亦未建（数学错题练习按 `subjectId` 过滤，不会误显示默写题）。
  - **开发假数据待清理**：两篇 `DEV-FIXTURE` 篇目（含其 `questions`/`dictation_passages`/可能产生的错题行）在生产内容上线后需清理。
- 文档：API 设计文档 §4.18 / §6.20 / 版本日志 v3.1；`docs/api/openapi.yaml`（3 路径 + 10 schema）；spec `docs/superpowers/specs/2026-09-13-chinese-dictation-special-design.md`；plan `docs/superpowers/plans/2026-09-13-chinese-dictation-feature.md`。

---

## 2026-09-11 辅线答疑：输入框 ≥2 轮后提示「输入关键词可要答案+思路+解析」

- **变更摘要**：辅线对话已够 **≥2 条 assistant 回复**时，在输入框上方提示「想直接看答案？输入『详细解析』或『给我答案』，即可获得 答案 + 解题思路 + 解析」，让学生知道后端这条快路径存在。`AuxiliaryHomePage` 统计 `messages` 中 assistant 条数 → 传 `showAnswerHint` 给 `AuxInputBar`；`AuxInputBar` 新增 `showAnswerHint` prop，在非 busy 时渲染该提示。
- **动机**：后端已实现「≥2 轮 + 关键词 → 题库解析 / AI 兜底」，但学生无从知道该输入什么关键词，入口不可发现（此前讨论时只落定了后端触发规则，UI 提示漏做）。
- **落地**：`apps/web/src/components/business/AuxInputBar.tsx`（+`showAnswerHint`）、`apps/web/src/pages/student/AuxiliaryHomePage.tsx`（阈值 2，与后端 `fallback.yaml.fallback.detailedExplanationAfterRounds` 对齐）。web tsc/vite build 通过、eslint 0 error。
- **局限/待办**：阈值在前端硬编码为 2（未从后端下发，改后端配置需同步前端）；提示文案里的关键词为示例（后端关键词表更全）；学生在提示出现前就问也照样触发（提示只是可发现性）。
- 文档：PRD §7.9；辅线设计 `docs/superpowers/specs/2026-08-02-auxiliary-track-design.md` §8.1.1；CLAUDE.md。

---

## 2026-09-11 辅线答疑：前20字兜底匹配 + 查不到强制 AI 解析 + 入库去重/错题本 + 会话管理入口常显

- **变更摘要**：
  1. **题库匹配加「前 20 字」兜底**：`QuestionsRepository.findByContentPrefix`（NFKC + 去空白/标点后取前 20 字；先 6 字 LIKE 粗筛再 JS 精确比对，按 id 倒序取最新）。`maybeStoredExplanation` 定位题目改为：锚点 `question_id` 优先 → 首条题干 `content_hash` → **前 20 字兜底**。
  2. **查不到题强制 AI 完整解析**：`maybeStoredExplanation` 返回 `{kind:'stored'} | {kind:'forceFallback'} | null`；题库查不到或内容全空 → `TutoringRequest.forceFallback=true`，`TutoringCapability.prepare` 据此走 `FallbackHandler` 的 AI 完整解析，**不再回到苏格拉底式追问**。
  3. **入库去重 + 错题本**：`ingestStructuredQuestion` 先 hash、再前 20 字，命中即复用已有题、**不再插入重复题**；随后 `ensureErrorBook` 确保该学生 `main_error_books` 有这道题（`source='auxiliary'`，新增 `existsByStudentAndQuestionId` 幂等跳过，含已清零；新建后回填 `dialogue_id`）。`AIModule` 注入 `MainErrorBooksRepository`。
  4. **会话管理入口常显**：`ConversationList` 原先进入「会话管理」页（改名/删除）的入口只在会话数 >7 时才渲染，导致会话少的学生进不去、像功能消失；改为**常显**。
  5. **标题不随话题更新**：明确**不做**（首次设定后固定）。
- **动机**：用户实测「已超 2 轮 + 明确要求输出答案」仍不出解析——老会话 `question_id` 为 NULL 且 `content_hash` 对不上（实测首条消息 hash `64e8e188…` 与题库 4 条都不等）；同一道题被模型改写致重复入库 3 次（5005/5006/5007）；会话管理入口被条件藏住。
- **落地**：`common/utils/content-hash.util.ts`（+`normalizeForPrefix`/`contentPrefix`）、`questions.repo.ts`（+`findByContentPrefix`）、`main-error-books.repo.ts`（+`existsByStudentAndQuestionId`）、`ai-core/types.ts`（`TutoringRequest.forceFallback`）、`tutoring.capability.ts`（prepare 认 forceFallback）、`modules/ai/ai.service.ts`（匹配/兜底/入库去重/错题本）、`ai.module.ts`、`ConversationList.tsx`。测试 8 个（含前缀兜底、forceFallback、入库去重复用 id、错题本幂等），全套 **433 tests** 通过。
- **E2E 实测**：① 复刻 dialogue 76（`question_id` NULL + 2 条 assistant + 真实题干）→ **0.03s 命中** 题库 5005，返回答案+解析、`done.fallback=true`、无模型调用；② 题库无匹配 → 触发 AI 兜底，63.6s 输出 3385 字完整解析（温和开场+分步解析）、`fallback:true`。
- **局限/待办**：存量辅线题（如 5005/5006/5007）**没有 `approach`**，快路径只给答案+解析，需后续重生成/回填；关键词仍是子串匹配（`不要给我答案` 会误命中 `给答案`）；前 20 字匹配对同开头但不同题的极端情况可能误判（现按最新取）；`标题随话题更新` 明确不做。
- 文档：PRD §7.9/§7.10；辅线设计 `docs/superpowers/specs/2026-08-02-auxiliary-track-design.md` §8.1.1；中枢设计文档 §3.6.2.1；CLAUDE.md。

---

## 2026-09-11 会话标题生成改「本地优先」+ 新增 title 场景

- **变更摘要**：会话标题由 `TutoringCapability.generateTitle` 生成，原来**硬编码 `deepseek-v4-flash`**。新增 `title` 场景路由，**primary=`local`、fallback=`deepseek-v4-flash`**（本地优先，不依赖外部余额）；`generateTitle` 改走 `modelRouter.route({scene:'title'})`，primary 失败自动回退 fallback；**两者都失败则不生成标题**（保留默认「辅线答疑」，由学生手动重命名，明确不做文本兜底），并 `console.warn` 留痕（原先 `catch { return null }` 完全静默）。`ai-core/types.ts` 的 `Scene` 联合 + `model-routes.yaml` routes + 后台 `SCENES` 增加 `title`；新增 `src/scripts/set-title-route.ts` 幂等 upsert `llm_routes`（已 seed 库用）。
- **动机**：用户反馈「会话标题时有时无」。实测根因是 `deepseek-v4-flash` 账号 **HTTP 402 Insufficient Balance**（env key 与 DB 解密 key 均 402，`qwen3.8-max` 正常 200），标题生成失败又被静默吞掉 → 有余额时（09-07、今天 16:24 前）的会话有标题，之后全部停在默认标题。改为本地优先可绕开外部余额依赖。
- **落地**：`tutoring.capability.ts`（generateTitle 路由+回退+日志）、`types.ts`（Scene）、`model-routes.yaml`、`admin-models.service.ts`（SCENES）、`scripts/set-title-route.ts`。新增 4 个单测（本地可用用本地、本地失败回退 deepseek、两者皆败返回 null、返回 NONE 不改标题）；全套 **430 tests** 通过。迁移脚本已在 dev 库执行，`llm_routes` 新增 `title/* -> local / deepseek-v4-flash`。
- **局限/待办**：写此条时本地 llama.cpp（`192.168.1.8:12345`）连接超时、DeepSeek 余额不足——**两个模型都不可用，标题会保持默认**（符合预期，学生可手动改）。`title` 路由改动需重启后端或后台保存一次路由才进内存 registry（`registry.reload()`）。标题仍是**首次设定后不再随话题变化**。另：`deepseek-v4-flash` 还是 grading(math)/hint/structuring 的 primary，DeepSeek 欠费会影响这些场景，需一并关注（safety 实际走本地关键词、不受影响）。
- 文档：中枢设计文档 §7.1 路由决策树（新增 judgment/hint/structuring/title 并修正 grading math）+ `title` 场景说明 + §3.1 Scene 联合；CLAUDE.md「会话标题路由」。

---

## 2026-09-11 辅线答疑：明确索要详细解析走题库 + 引导必须给关键信息

- **变更摘要**：① **详细解析走题库，不调模型**——辅线答疑（`mode='auxiliary'`）中，学生已与 AI 来回 ≥2 轮、且当前消息命中「详细解析/完整解析/给我答案/告诉我答案」等关键词时，`AIService.maybeStoredExplanation` 直接从题库取该题的 **答案 + 解题思路 + 解析**（`questions.answer/approach/explanation`）输出并落库（`type='fallback'`），**不调用大模型**；未命中题或题库无解析内容才退回正常苏格拉底流程。② **题目锚定**——结构化题目输出新增 `approach`（解题思路）字段，与 answer/explanation 一起入 `questions`；AI 首次结构化入库后把 `question_id` 回填会话 `ai_dialogues.question_id`（`AiDialoguesRepository.updateQuestionId`，幂等仅当 NULL），老会话无锚点则用首条用户消息题干 `content_hash` 匹配兜底。③ **引导必须给关键信息**——辅线 prompt（`prompts/tutoring/math/auxiliary.md`）新增硬性要求：每次回复至少给出一个关键已知条件/方法公式/下一步具体操作，不能只抛问题让学生干想；仍不给最终答案。
- **动机**：用户实测反馈——(a) 学生明确要解析时不应再耗 AI 生成、题库里已有该题解析可复用；(b) 提示太绕，只让学生「想一想」而没有任何关键抓手。
- **落地**：`fallback.yaml` 新增 `detailedExplanationAfterRounds: 2` + `detailedExplanationKeywords`（`config.ts` 类型同步）；`ai-core/types.ts` `StructuredQuestionOutput.approach?`；`tutoring.capability.ts` Zod schema 加 `approach`；`questions.repo.ts` create INSERT `approach`；`database/repositories/types.ts` `QuestionRow.approach?`；`ai-dialogues.repo.ts` +`updateQuestionId`；`ai.service.ts` +`maybeStoredExplanation`/`composeStoredExplanation`/`persistStoredExplanation`/`isDetailedExplanationRequest`/`linkDialogueQuestion`（注入 `ConversationService`+`AiDialoguesRepository`，`tutor()` 与 `tutorStream()` 双路短路）。新增 5 个单测（命中短路不调模型、未满 2 轮/无解析/非 aux 回退 AI、入库回填 question_id）。E2E（临时实例 3003 + 种入 question_id/2 条历史）实测：**0.02s 命中**，返回答案+思路+解析、`done.fallback=true`、无模型调用。
- **局限/待办**：`content_hash` 兜底匹配的是**原始题干文本**，与题库里模型结构化后的 `content` 很可能对不上（故以 `question_id` 回填为主路径）；存量辅线题（旧数据）没有 `approach`，快路径只会给答案+解析，需后续重生成/回填；关键词表为硬编码子串匹配，可能误触发（如「不要给我答案」含「给答案」语义相反），待观察。
- 设计文档：PRD §7.9/§7.10；辅线设计 `docs/superpowers/specs/2026-08-02-auxiliary-track-design.md` §8.1.1；中枢设计文档 §3.6.2.1。

---

## 2026-09-11 辅线答疑流式空闲超时 + 思考链分段标题 + 出错保留已流出思考

- **变更摘要**：修 qwen3.8-max 换代后暴露的两个辅线答疑缺陷。① `OpenAICompatibleClient.streamChat` 原本用 `AbortSignal.timeout(per-scene)`（tutoring=45s）做**从请求开始的墙钟硬超时**，reasoner 难题思考 >45s 被拦腰砍断（实测第 45.0s 断流，reasoning 已吐 444 片、content=0），且 `AbortSignal.timeout` 抛的 `DOMException(name='TimeoutError')` 不被 capability 的 `isAbort` 识别、也不被 `mapLLMErrorToClient` 识别 → 兜底成 `code:5000 "AI 服务异常"`。改为**空闲超时**：每收到数据就重置计时器，阈值取 `retry.yaml` 的 `streaming.firstTokenTimeoutMs`（首字节前 3s）/ `interTokenTimeoutMs`（首字节后 10s）（这两个字段原为声明式未接线），空闲触发抛 `TimeoutError`（statusCode 408）→ 前端 1009「AI 响应超时」；外部 `request.signal`（用户停止）仍保持 `AbortError` 语义。② 前端 `ReasoningBlock` 的折叠标题启发式是照 qwen3.7-max 的「冒号短标题」写的，对 qwen3.8-max 的散文式 CoT 命中 0 条 → 标题恒空、回退成不断变长的整行。改为**按段落切块**：砍掉末尾 ```json 块，取最后一个「首句已完成」段落的 `标签：`（标签≤12字）或首句/首分句（≤20字）作当前阶段标题，段内稳定、换段才变。③ 出错/超时不再丢弃已流出的思考：前端 `setLastAssistantError` 保留 content/reasoning、错误气泡叠在思考下方；后端 `tutoring.capability.tutorStream` catch 在已有 reasoning/content 时 best-effort 落库部分 assistant（content 空填 `[生成中断]`）。
- **动机**：用户实测辅线答疑「模型回复后最终报 AI 服务异常」且「思考链所有内容拼到一起、不按标题」。
- **落地**：`apps/server/src/ai-core/infra/model-client/openai-compatible-client.ts`（空闲超时 + `idleTimeoutError`）、`apps/server/src/ai-core/capabilities/tutoring.capability.ts`（部分落库）、`apps/web/src/components/business/AuxChatPanel.tsx`（`titleForParagraph`/`deriveStageTitle` + 错误态渲染思考）、`apps/web/src/store/chatStore.ts`（保留已流出内容）。新增 3 个回归测试（空闲超时→TimeoutError、用户停止→AbortError、持续有数据不超时）。实测：同一道背包题旧代码 45.0s 断流报错，新代码 86.9s 完整走完（reasoning 848 片 + content 113 片 + done 带 structuredQuestion，无 error）。文档：CLAUDE.md 增「流式用空闲超时」约束、更新「错误映射与对话持久化」、从已知限制移除 streaming.* 未接线。
- **局限/待办**：qwen3.8-max 的 CoT 无显式标题语法，标题是**启发式合成**（取段落首句/标签），质量受模型措辞影响；简单题整条思考链只有 1 个段落，没有「阶段变化」属模型真实行为；空闲阈值 10s 相对实测最大分片间隔 1.13s 余量充足，但本地模型（llama.cpp）是否适用未单独调参。
- 设计文档：`docs/superpowers/plans/2026-08-04-aux-streaming-thinking.md`（思考链折叠标题的原始设计）。

---

## 2026-09-11 qwen3.8-max 改名 + 多模态替代 VL / 去掉两阶段图片流程

- **变更摘要**：`qwen3.7-max` 全局改名 `qwen3.8-max`（YAML 模型定义/所有路由/`default`/DB/deploy 脚本）。因 `qwen3.8-max` 支持多模态（实测 OpenAI 兼容模式 `image_url` 可用），删除 `qwen-vl-max`/`qwen3-vl-plus` 两个模型与 `transcribe` 场景，图片+文本直接送给辅导模型（`TutoringCapability.augmentWithImages` 把最后一条 user 消息改为 text+image_url 部件）。删除图片两阶段流程：`TutoringCapability` 的 `transcribeImage`/`classifySelection`/`parseTranscribeResult`/`parseSelectionResult`、`AIService` 的 `transcribeStage`/`selectionStage`/`correctStage` 与 flow 分支、`TutorDto.flowAction`、`ConversationService.updateFlowState`、前端 `chatStore` 的 `ChatFlow`/`ChatMessage.flow`、`useAuxChat` 的 flowAction/flow 事件、`AuxChatPanel` 的「确认/重新识别」UI；一图多题交给 `prompts/tutoring/math/auxiliary.md` 已有的图片/多题处理段。新增请求级 thinking 开关（`ChatRequest.thinking?: boolean`，`buildRequestBody` 下发 `enable_thinking = thinking !== false`），`JudgmentCapability` 判题两次调用都传 `false`（不建 `qwen3.8-max-nothink` 模型条目）。`judgment` 路由 fallback 由 `deepseek-v4-flash` 改为 `qwen3.8-max`（统一运行时回退与新装降级目标）。后台 `SCENES` 与 `admin.controller` 相关枚举去 `transcribe`。
- **动机**：单多模态模型替代「文本模型 + VL 模型 + 两阶段确认」，减复杂度与一次模型往返；`qwen3.8-max` 全面替代 `qwen3.7-max`；判题不带 thinking 保速度。
- **落地**：`npx tsx src/scripts/migrate-qwen38-multimodal.ts` 幂等迁移已 seed 的库（顺序：插新模型 → 改路由 → 改判题路由 → 删 transcribe 路由 → 删旧模型行 → 重置遗留 flow 状态；受 primary FK 约束）；`tools/deploy/apply-llm-config.mjs`/`deploy.sh` 默认模型改名；重启后端或后台保存路由生效。`npm run build` 现经 `scripts/copy-assets.mjs` 把 `src/ai-core/*.yaml` 与 `prompts/` 复制进 `dist/ai-core`，修掉此前「build 不拷资源致 dist YAML 陈旧」的局限。
- **局限/待办**：`ai_dialogues.flow_state/pending_question(s)` 三列保留为死数据（未做破坏性迁移）；本地 llama.cpp 判题仍带 thinking（llama.cpp 忽略 `enable_thinking`，需 `chat_template_kwargs`，另议）；多模态替代两阶段后学生失去「识别对不对」确认，靠识别质量与 prompt 兜底；Qwen 账号曾欠费，公网模型可用性依赖账号状态。端到端手动验收（辅线直送图片 / 一图多题 / 判题回退）待实测，结论由后续手动验收补记。
- 设计 spec：`docs/superpowers/specs/2026-09-11-qwen38-multimodal-design.md`；实施计划 `docs/superpowers/plans/2026-09-11-qwen38-multimodal.md`。

---

## 2026-09-11 训练模块判题默认走本地模型（失败回退 ds v4 flash）

- **变更摘要**：`judgment` 场景 primary 由 `deepseek-v4-flash` 改为 `local`（本地 llama.cpp `Qwen3.8-27B`，OpenAI 兼容，`LOCAL_LLM_BASE_URL`/`LOCAL_LLM_API_KEY`），fallback 改为 `deepseek-v4-flash`。`JudgmentCapability` 新增失败回退：primary 任何失败（连接拒绝/超时/4xx/5xx/返回解析不了）→ fallback 重试一次；两者皆败才抛错（`JudgeCoreService` 仍映射 503 不变）。覆盖训练模块专项/考试/错题全部模型判题（三者同走 `judgeQuestion → JudgmentCapability`）；课堂练习共用该场景，一并切到本地模型。Provider 层抽出 `OpenAICompatibleClient` 基类（原 `KimiClient` 一直兼任基类但命名误导），`KimiClient`/`QwenClient`/`DeepSeekClient`/新增 `LocalClient` 各自为其薄子类；`LocalClient` 去掉 `enable_thinking`（llama.cpp 非 DashScope 端点），保留 `response_format`。`Provider` 联合类型与后台 provider 下拉新增 `local`。后台 `PROVIDER_TYPES` 与 `admin.controller.ts` 的 `providerType` zod 枚举均新增 `'local'`，后台可创建/辨识本地模型。
- **动机**：训练模块判题量大，走本地模型省调用成本；本地不可用时必须自动兜底，学生判题不能因本地服务挂掉而失败。
- **落地**：`model-routes.yaml` 新增 `local` 模型 + judgment 路由；`npx tsx src/scripts/set-judging-local.ts` 幂等 upsert 到已 seed 的库（`seed-llm-config.ts` 是 skip-if-exists，无法更新既有行）；`seed-llm-config.ts` 另新增路由按模型可用性降级——primary 未配置（如缺 `LOCAL_LLM_*` 使 `local` 缺失）但 fallback 已 seed 时以 fallback 顶上当 primary 落库并打 warning，主/备均未配置才跳过（helper `llm-route-seed.util.ts` / `resolveSeedRoute`）；运行后需重启后端或后台保存路由触发 `registry.reload()`。
- **局限/待办**：本地不可用时 `ModelClient` 内置重试（2 次 + 退避）后才回退——「多约 1–3s」仅适用于连接被立即拒绝（ECONNREFUSED）的情形；若本地主机 blackhole/不可达，请求会一直阻塞到 90s 的 judgment 超时 × 内置 2 次重试（≈4.5 分钟）后才触发 fallback，本次有意不为 `local` 单独调 `retry.yaml` 的重试/超时（留待后续）；llama.cpp 对 `response_format: json_object` 的兼容性与本地 27B 判题准确率待实测；无本地健康检查/preflight。
- 设计 spec：`docs/superpowers/specs/2026-09-11-local-judging-model-design.md`；实施计划 `docs/superpowers/plans/2026-09-11-local-judging-model.md`。

---

## 2026-09-10 判题体系重构（四路由 + 主观题自评）

- **变更摘要**：`JudgeCoreService` 判题四路由——choice/true_false 程序比对；fill_blank/calculation 归一化比对 + AI 等价判断；short_answer/proof 由 `JUDGE_SUBJECTIVE_MODE` 控制（默认 `self_assess` 不判对错，学生自评；`ai` 保留原 JudgmentCapability 逻辑可切回）。calculation 为新增题型（结果型计算题，从 short_answer 拆出）。自评端点 ×2：`POST /api/training/self-assess`（题中心：留痕 + 错题本写入/清零）与 `POST /api/practice/self-assess`（卡中心：补写 practice_results method='self_assess'）。考试主观题不判（`exam_answers.is_correct=NULL`、method='self_assess'），成绩只算客观题，结果页带 `answer`/`needsSelfAssessment`/`selfAssessment`/`subjectiveCount`；空答案题守卫（method='unanswered' 不计对错）+ 抽题过滤 `answer <> ''`。DB：新增 `question_self_assessments` 表，`practice_results.method`/`exam_answers.method` 列加宽 VARCHAR(20) 容纳 `self_assess`。
- **动机**：国产模型对主观题判题准确率不足（同题同答多次判定结果漂移，误判直接伤学生信任）；主观题改为学生对照参考答案自评，AI 退出判错位。参考答案补全（错题缺答案无法自评）转离线人工 + AI 批量导入，见 answer_importer 计划（`docs/superpowers/plans/`）。
- **局限/待办**：存量 short_answer→calculation 拆分依赖答案导入批次回写（导入前 calculation 题池空）；考试结果页自评失败无 toast 提示；AnswerModal 本地 store 不回写自评态，重进后自评状态从留痕表恢复。
- 设计 spec：`docs/superpowers/specs/2026-09-09-judging-rework-design.md`；API 文档 v2.9/v3.0；DB 设计文档 v2.1。

---

## 2026-09-08 判题解析缓存化（ExplanationCacheService）

- **判题只判对错**：judgment prompt（math-calculation/math-proof）去 `analysis` 输出，只留 `{isCorrect, errorType}`（省输出 token）；`JudgeOutput` 删 `analysis`，`/api/practice/judge`、`/api/training/judge` 响应瘦身（exam answers 落库 analysis 恒 null，列保留存历史）。客观题判错的「正确答案：X」一并移除——正确答案与解法在解析里。
- **解析缓存**：判错后 `JudgeCoreService` fire-and-forget 调 `ExplanationCacheService`（practice 模块，进程内队列并发 ≤2 + in-flight 去重）：`questions.explanation` 已有跳过；`answer>=100` 字符直接当题解直写（不调 LLM）；否则 explanation 场景（qwen3.7-max 强模型，新 `solution` 模式 prompt——标准题解、可含内嵌 SVG，前端 rehype-raw 可渲染）生成后入库，一次生成全生命周期复用；失败不入库，下次判错自然重试（幂等）。`retry.yaml` explanation 超时 60s→120s。
- **端点**：`GET /api/training/questions/explanations?ids=`（批量拉解析，等 in-flight 60s，不触发新生成）；`GET /api/training/questions/{id}/explanation-wait`（单题刷新等待 120s：无在途且无解析则重新触发；题目不存在/停用直接 null 不触发；超时后重读防误报；失败写 `admin_notifications` type=explanation_failed，同题未读去重）。`ExplanationCacheService` 由 PracticeModule 导出、TrainingModule 注入同一实例（防第二空队列）。
- **admin 通知**：新表 `admin_notifications`（复刻 parent_messages 模式）+ 三端点（列表/未读数/已读，markRead 幂等——已读重复标返回 true）；Admin Dashboard 通知区（未读徽章+列表+标为已读）。
- **前端**：结果页（专项/错题重做/考试/错题巩固）末题后收集错题 questionId 批量拉解析；解析为 null 显示「正在生成中…+刷新」（120s 倒计时，调 explanation-wait）；孤儿题显示「暂无解析，试试让 AI 讲一讲」；考试结果页 `explanation ?? 存量 analysis` 兜底 + mount 后台补拉。
- **已知局限**：进程内队列，重启丢在途（下次判错重试）；多实例会重复生成（当前单实例）；`explanation-wait` 存在成本滥用面（任意学生可枚举 id 触发强模型生成——已加题目存在性检查缓解，平台级限流缺口与 hint 端点同源待统一治理）；管理员人工补题解入口未做（见 spec §10 待办）。
- 设计 spec：`docs/superpowers/specs/2026-09-08-question-explanation-cache-design.md`；实施计划 `docs/superpowers/plans/2026-09-08-question-explanation-cache.md`；API 文档 v2.8。

---

## 2026-09-07 会话场景分型（scene）与训练「讲一讲」重构

- **问题**：各系统聊天共用 `ai_dialogues` 一张表，只有 `track`（mainline/auxiliary）可区分；专项/错题训练里的「讲一讲」（track=auxiliary）与辅线答疑自由问答混在同一列表，历史互相污染。且训练讲一讲旧实现把整段题面前缀进每条学生消息，气泡显示成「题目+我的问题」。
- **DB**：`ai_dialogues` 新增 `scene`（默认 `aux_qna`，枚举 aux_qna/aux_training/mainline_question/mainline_card）与 `question_id`（训练讲一讲按题锚）；索引 `idx_dlg_student_scene_question(student_id, track, scene, question_id)`。迁移 `tools/db/migrations/2026-09-07_add_ai_dialogues_scene.sql`（含存量回填：auxiliary 带「这道题目是：」前缀 -> aux_training；mainline 经 main_error_books.dialogue_id 关联 -> mainline_question，其余 mainline_card）。
- **conversations**：`POST /api/conversations` 支持 `scene/questionId/questionText`；`scene=aux_training` 且带 questionId 按题 find-or-create（跨刷新续接同一对话），仅新建时把题面写一条 assistant 题面锚消息（type='transcription'）进历史；`GET /api/conversations` 支持 `scene` 过滤（辅线答疑列表只返回 aux_qna）。
- **practice**：`startDiscuss` 新建 mainline 标 `mainline_question`；`startCardDiscuss`/findOrCreateMainlineByCard 标 `mainline_card`。
- **前端**：训练讲一讲（useDiscussChat training 模式）改为锚定建会话 + `send` 只发学生原话（不再前缀题面）；历史回放隐藏题面锚消息、剥离旧会话前缀。辅线列表（ConversationList/会话管理/auxiliaryStore）按 `scene=aux_qna` 拉取。
- 设计 spec：`docs/superpowers/specs/2026-09-04-training-run-ux-design.md`（已加 2026-09-07 变更注记）；API 数据流见设计文档 §6.18（v2.6）。**注**：课堂练习 question 模式仍保留前缀展示（本次只修 training 模式，将来统一时复用题面锚方案）。

---

## 2026-09-04 专项训练「不再展示」功能

- 新增 `student_hidden_questions` 表（`student_id + question_id` 全局排除，不分知识点）
- `QuestionsRepository.findRandomByKpAndType` 加 `LEFT JOIN ... IS NULL` 排除已标记题（**仅此一处**选题路径受影响；主线练习/错题重做/考试不动）
- `TrainingController` 加 4 端点：`POST /training/hidden/mark`、`GET /training/hidden`、`DELETE /training/hidden/:questionId`、`DELETE /training/hidden`
- 前端 `QuestionRunner` 加 ungated `questionMetaActions` 插槽；`TargetedRunPage` 答题页加「不再展示」按钮 + 确认 Modal
- 新建 `HiddenQuestionsPage` 清单页（逐条撤销 + 全部重置），学生端自助管理
- 设计 spec：`docs/superpowers/specs/2026-09-04-targeted-practice-exclude-marked-design.md`
- 实施计划：`docs/superpowers/plans/2026-09-04-targeted-practice-exclude-marked.md`

---

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

---

**2026-09-02 修正（refinery：页眉剥离 + 书尾识别，extract 前置内容误判）**：现象--新书（2024 修订版九上）20 页正文被 `is_front_matter` 规则 1 整页子串「出版社」/「仅供个人学习」误杀（17 页 OCR 运行页眉「# 人民教育出版社」+ 4 页 PDF 水印页脚：028,029,050,056,064,067,092,097,119,124,132,156,159,177,179,182,123,133,154,181），静默丢 0 卡片；反向 183（综合与实践纯组织说明页）产出 7 张垃圾卡、186（封底 ISBN）产出 2 张垃圾卡。修复：① 新模块 `src/page_chrome.py`--`compute_book_chrome` 书级频率统计自动发现页眉/页脚行（每页开头/结尾各 2 非空行归一化计数，出现 ≥3 页 **且** 命中安全模式：含出版社/版权水印/纯 1-3 位数字页码/ISBN；「练习」8 页、「小结」6 页等高频内容标题因无安全模式永不剥离，题干偶现「某出版社」因频率 1 保留），`strip_chrome` 整行剥离；统计必须扫书目录全部页（--pages/--book 过滤会让频率失真）。② `extract_cli` 主流程两处剥行：read_text 后（is_front_matter 判定基于干净文本）+ scan_page 返回后（页眉不进卡片内容）。③ `is_front_matter` 新增书尾规则--ISBN 正则/绿色印刷产品/标题行 后记|附录|词汇索引/电话+邮箱同现/组织说明页标记（活动评价、展示交流、演示文稿、组建合作团队、研究小组、研究报告、方案构思、自我反思）命中 ≥3（183 命中 6，182 活动数学任务页命中 0 正确保留）/剥离后空页不限页码。④ 重跑方式--用 `RefineryCheckpoint.unmark_extracted` 解除目标页标记后正常跑（其余页走 skip 分支回填 per-book lesson_id 继承链），**不要用 --force/--pages**（绕过 skip 分支会断跨页继承回填）。⑤ 验证：refinery 423 tests 绿（新增 page_chrome 14 + back_matter 14 + 主流程接线 3）；真书 5 页实测 028→4 卡（25.3）/123→6 卡（29.1，继承回填生效）/181,182→综合与实践卡保留/183,186→front matter 跳过，页眉水印零泄漏。⑥ 遗留：DB 新书（version 277）仅第 25 章 50 卡入库、落后于 published；补抽后需 publish + db_loader 刷新。详见 `docs/superpowers/plans/2026-09-01-page-chrome-and-backmatter.md`。

---

**2026-08-28~29 补录（迁自根目录 `Agent.md`，2026-09-02 迁移；08-26 修复清单主体见上方同日条目，此处只补独有内容）**：① pipeline_cli 一键全流程--`pipeline_cli.py` 总控（toc_parse -> extract -> publish -> toc_merge -> db_loader）+ 交互式向导 `pipeline_wizard.py` + `env_bootstrap.py`（首次运行从 apps/server/.env 引导生成 refinery .env）+ `toc_merge.py`（card 发现的新小节入库前合并进 TOC，`*.merged.json` sidecar）；refinery 测试增至 350 个全绿（commit `fed6376`）。② 静态图片服务架构澄清--图片由 apps/server 直接托管（`apps/server/src/main.ts` 的 `useStaticAssets`：`/assets/*` -> `tools/data-refinery/output/assets/*`），web 的 Vite dev server 把 `/assets` 代理到 server（与 `/api`/`/uploads` 同一套代理），前端用相对路径 `/assets/...` 取图，不跨域；**无需单独起 python http.server**（旧方案已废弃，refinery README/使用手册 §6.1 已同步修正）；本地开发只需两个服务：web（:5173）+ server（:3001）（commit `933f64a`）。③ ⚠️ **遗留（业务数据备份丢失）**：08-26 purge 前的备份写在 `/tmp/ai_k12_backup/business_tables_20260826_195502.sql`（28KB，含 main_error_books 23 行、aux_error_books 7 行、progress 2 行、practice_results 6 行等），已被系统 /tmp 清理删掉。**待办**：检查 MySQL binlog 是否可恢复被 purge 的行；今后备份一律放持久目录（勿用 /tmp）。④ 关联提交：`a56d6f0`（数据管道一键导入：FK 守卫 + dry-run bug + 测试/手册修复）、`fed6376`（pipeline_cli 一键全流程）、`933f64a`（图片静态服务说明修正）。

---

**2026-09-02 新增（refinery：lesson_anchor 页码锚定，db_loader 章归属确定性判定）**：背景--LLM 标签三类归属错误：① 错章（page_092 复习题27 标成「第二十六章 二次函数」、page_119 复习题28 续页同，prompt 规定复习题/小结填 null 继承但 LLM 违规自选错章标签，CLI 无法防御「合法格式的错值」）；② 同名歧义（各章「小结」「数学活动」lesson 同名，`_match_lesson_scoped` 按名取第一个 → 26-30 章约 14 页小结/复习题卡全挂 25 章小结，老书同潜伏）；③ 非 TOC 标签（「复习题 30」会经 `_find_or_create` 建 TOC 外 lesson）。方案（业内标准做法：TOC 页码锚定，最强信号参与判定）--每张卡的章归属由「textbook_page（md 页码）→ TOC 章区间」独立确定，LLM lesson_id 降级为章内小节建议，冲突时锚定赢；**锚定只在 db_loader 挂卡时做**（零 LLM 成本、不动 extract/publish/toc_merge、直接修存量数据；每次 load 重算，重处理任意页不影响结构）。实现--① 新模块 `src/lesson_anchor.py`：章边界两级推导（首选综述卡锚定：每章「第N章」标签卡最小 md 页=章头页，md 空间直接锚零误差、取 min 免疫错章综述标签；兜底首节 printed+偏移众数−3 余量）+ 节时间线 `active_label_at`（错章卡兜底定位活跃节）；② `db_loader.load_book_cards` TOC 模式挂卡前修正（`_build_anchor_ctx` 预查 units/lessons/同名集合，`_anchor_lesson_id` 规则 A 错章重写（content「复习题 N」>时间线活跃节>标题匹配>章综述）/B 同名消歧（按页所在章）/C 复习题归一（挂该章「小结」，用户决策不建「复习题 N」lesson））+ `[anchor] offset/corrected/disambiguated/normalized` 观测日志；无 TOC/对不上整体退化既有匹配。实施修正--首版偏移法实测 P119 误入 29 章+老书 17 个假修正，综述卡锚定后 corrected 17→0、P119 归 28 章小结。验证--451 tests 绿（lesson_anchor 19 + TestAnchorCorrection 9 新增）；真库重载新书 799 卡（corrected=6/disambiguated=119/normalized=6），P92/P93→27 章小结、P119→28 章小结、P177/178/179→30 章小结，各章小结卡分布正常，幂等重跑一致；老书 313 卡重载无错章。数据修复顺带完成--删 7 条测试练习记录（学生 7）解锁新书入库。遗留--老书 9 个「复习题21-29」空壳 lesson（历史 load 遗留 0 卡可清理）；老书 39 张裸编号标签卡 skipped（既有数据质量项）。详见 `docs/superpowers/plans/2026-09-02-lesson-anchor-design.md`。
