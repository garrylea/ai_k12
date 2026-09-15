# 训练 → 语文 → 专项：古诗文默写

- 日期：2026-09-13
- 状态：**部分已被推翻** —— 见下方「取代说明」
- 关联文档：`docs/superpowers/specs/2026-09-02-math-training-module-design.md`（训练模块蓝本）、`docs/superpowers/specs/2026-09-09-judging-rework-design.md`（分层判题）、`docs/superpowers/specs/2026-09-10-question-content-importer-design.md`（内容导入先例）、`docs/K12智学系统-产品需求文档.md` §6.3

> ## ⚠️ 取代说明（2026-09-15）
>
> 本文的**数据模型与错题本部分已被推翻**，改造方案见
> `docs/superpowers/specs/2026-09-15-chinese-interpretation-special-design.md` §2 / §6。
>
> **已作废的章节**（下文对应位置均有内联标记，保留原文仅为记录当时的论证过程）：
>
> | 本文位置 | 原结论 | 现行结论 |
> |---|---|---|
> | §4.1 复用 `questions` 作锚点 | 每篇挂一行 `questions` | **不挂**。`questions` 上的 50 行 `poem_dictation` 删除 |
> | §4.1.1 为什么不把篇名/作者/正文全塞进 `questions` | 论证「独立明细表 + `questions` 锚点」 | 表仍是独立的，但**锚点摘掉**；`question_id` 由 `chinese_passages` 自身承载篇目字段后已无用途 |
> | §4.3 错题本 | 复用 `main_error_books`，`source='dictation'` | **不入错题本**（PRD §7.4 已加例外），存量行删除 |
> | §5 第 6 条 落库 | 判错 `writeErrorBookOrReuse` / 判对清零 | 均去掉 |
> | §8 后端改造清单 | 涉及 `question_id` 的条目 | 见新 spec §9 |
>
> **未被推翻、仍然有效**：§5 的归一化口径 / 逐字段比对 / LCS diff / 标点回投 / 判题与错因解耦 / 关 thinking，§6 的内容管线，§7 的前端设计，§9 的测试口径。

## 1. 背景与问题

平台目前只有数学一科的训练内容。三轨入口（学习 / 答疑 / 训练）中，「训练」轨的「专项练习」本质是「按知识点 + 题型从 `questions` 随机抽题」，全链路写死数学：

- 前端 `TrainingSubjectPage.tsx` 硬编码三科，语文 `enabled:false`；9 处 `MATH_SUBJECT_ID = 1`，无路由参数、无全局学科状态；
- 后端 `judge-core.service.ts` 判题时硬编码 `subject:'math'`，`training.service.ts` 的 hint 同样硬编码；
- `model-routes.yaml` 已预置 chinese 的 tutoring / grading / explanation 路由，但无 chinese 的 judgment 路由；
- 语文内容侧除 6 套初三模拟卷 Markdown 外**没有任何已入库数据**：无题目、无知识点、无必背篇目。

本设计新增语文的第一个专项——**古诗文默写**，同时做「语文能跑起来」所需的最小多学科化改造。古诗文解释专项另起一份 spec。

## 2. 目标与非目标

**目标**

1. 初三学生可从 训练 → 语文 → 专项 → 「古诗文默写」进入练习；
2. 题库覆盖九年级上/下册教材要求「背诵/默写」的古诗词与文言文，均**整篇**默写；
3. 学生分**三个字段**作答（作者 / 朝代 / 正文）；
4. 判题程序化：归一化比对定对错 + diff 定位错处，三项全对才算整题对；
5. LLM 只为错题写「错因文案」，本地模型优先、`deepseek-flash` 兜底，模型不可用不阻断判题。

**非目标**

- 不做古诗文解释专项（下一个 spec）；
- 不做语文的真题考试页、错题练习页；
- 不做手写拍照识别（OCR / VLM）；
- 不对数学专项页做多学科化重构（保留现状，另案处理）；
- 不做语文知识点树，不做主线/辅线联动。

## 3. 关键决策

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 篇目范围 | 古诗词 + 文言文，均整篇默写 |
| 2 | 内容来源 | 爬国家中小学智慧教育平台（smartedu）教材作权威源 |
| 3 | 教材版本 | 已闸门确认（2026-09-13）：**统编版 · 初中（六三制） · 九年级 上册 + 下册**，共 2 本。平台语文出版社标签只有「统编版」——无「部编版」标签，也无「人教版·语文」标签；语文这一科统编版即人教社统编教材（= 常说的部编版）。平台上另有 `初中（五•四学制）` 副本，本项目不取。爬取参数：`--site smartedu --subject 语文 --publisher 统编版 --level 初中 --grade 九年级 --semester 上册`（下册同理；`--level 初中` 须精确匹配才能排除五四学制） |
| 4 | 年级 × 筛选 | 九年级上/下册，且只收教材课后标注需「背诵/默写」的篇目 |
| 5 | 作答形态 | 三个独立字段：作者 / 朝代 / 正文 |
| 6 | 判题 | 程序归一化比对定对错 + diff 定位错处；LLM 只写错因文案 |
| 7 | 对错口径 | 作者 / 朝代 / 正文三项全对才算整题对 |
| 8 | 选题方式 | 默认随机抽（范围 + 题量），支持展开篇目清单勾选指定篇目 |
| 9 | 整体方案 | 语文专用页面 + 最小多学科化；不动数学专项页 |
| 10 | 入口结构 | 训练 → 语文 → 语文专项页（两卡），直达不走三卡页 |

## 4. 数据模型

### 4.1 复用 `questions` 作锚点 【已作废，2026-09-15】

> **本节结论已废**：篇目**不再挂** `questions`。`question_id` 原本承担的题面 / 学科过滤 / 停用 /「不再展示」/ 错题本五件事，交由 `chinese_passages` 自身与 PRD §7.4 的例外处理。存量 50 行 `poem_dictation` 及 `main_error_books(source='dictation')` 行一并删除。见 `2026-09-15-chinese-interpretation-special-design.md` §1.1 / §6。

每篇必须有一行 `questions`：错题本 `main_error_books`、`student_hidden_questions`、`question_hints`、`question_self_assessments` 全部挂 `question_id`。

- `type = 'poem_dictation'`（新题型值；`questions.type` 是自由 `VARCHAR(20)`，DB 无 CHECK 约束）
- `subject_id = 2`（chinese）
- `content = '请默写《岳阳楼记》'` —— **题面只放篇名，不要写「（并写出作者与朝代）」之类的提示**：作者/朝代/正文都是要学生默写的**答案**，由答题页的三个字段承载，题面重复一遍只是噪音（2026-09-13 用户实测反馈后确定；内容管线生成题面时须遵守同一约定）
- `answer` = 可读合成答案（作者 / 朝代 / 正文），供通用展示路径使用
- `content_hash = computeContentHash(content)`（`uniq_q_content_hash` 唯一约束）
- `answer_verified` = 校验闸门标记

### 4.1.1 为什么不把篇名/作者/正文全塞进 `questions`（被否方案）【结论部分作废，2026-09-15】

> **本节论证「为什么需要一张独立表」仍然成立**（四条代价今日逐条复核后依然成立，且代码里三条抽题 SQL 确实全打在独立表上）。
> **作废的只有推论方向**：本节以「所以 = 独立表 **+ 保留 `questions` 锚点**」收尾；现行结论是「独立表 **且不挂 `questions`**」。
> 另需注意：本节第 1 条（身份 / `content_hash`）**不适用于**「把三字段作为 JSON 存进 `answer`」这个方案 —— 那种存法下 `content` 仍是 `请默写《X》`，hash 不随正文变。该方案被否的真正理由是「篇目级字段没有列、筛排与唯一约束全丢」以及「`answer` 语义污染」，不在此节。

可行性上，「把篇名、作者、正文以 markdown 存进 `content`」是能跑通的。之所以不采用，是因为它带来四条持续存在的代价：

1. **丢掉稳定身份，重导入不幂等（最关键）**。篇名是稳定身份，正文会因校对而修正；而 `content` 上挂着 `uniq_q_content_hash`，`content_hash` 由 `content` 算出。正文改一个字 → hash 变 → 重新导入匹配不上旧行 → 插重复题或静默新增，而错题本 / 隐藏题 / 提示缓存都挂在旧 `question_id` 上，学生数据成孤儿。独立表以 `work_title`（+ 册次）作业务主键，正文可任意修正而重导入仍是幂等更新同一行。
2. **「按篇选练」的列表 / 筛选 / 排序做不了**。配置页要列出全部篇目、按册次筛、按顺序排；markdown 里没有册次字段，只能塞进 `group_id` / `source` 这类语义不符的列，或用 `LIKE '%《岳阳楼记》%'` 匹配篇名——等于拿字符串当主键，书名号或异体字写法一变就静默失配。
3. **判题要三字段，必须先反解析**。判题输出是 `fields:{author,dynasty,body}` + diff；存 markdown 意味着「存进去 → 解析回三字段 → 判 → 再拼装展示」，来回转换每一跳都可能出错，且 markdown 无 schema，格式一漂即崩。
4. **`content` 语义被污染**。`content` 现在被 `content_hash`、详细解析、`answer_importer` 一致当作「题干」使用。塞入篇名/作者/朝代/正文后，同一字段同时承担题面与数据；后续想改题面（如「请默写《岳阳楼记》第 3 段」）会与存储格式冲突。后续「古诗文解释」专项要复用同一份正文，也会被迫再解析或重复存。

被否的折中方案：给 `questions` 加 `dictation_author` / `dictation_dynasty` / `dictation_body` 三个可空列，免去 JOIN。但其代价是——篇名、册次、排序、校验状态仍无处安放、还得继续加列，`questions` 会逐渐变成语文专属表；第 1 条的稳定身份问题依旧；且该表数学侧也在读，属于跨学科污染。

**成本对比**：独立表的一次性成本是「一张表 + 一个 repo + 一次 JOIN」；塞 `content` 的一次性成本为 0，但换来上述四条持续脆弱性。故选择独立表。

### 4.2 新表 `dictation_passages` 【DDL 已作废，2026-09-15】

> **表改名为 `chinese_passages`，并摘除 `question_id` / `uniq_dp_question` / `fk_dp_question`**；新增 `is_active` 与解释专项的 `key_terms` / `sentences` / `full_translation` 列。现行 DDL 见 `2026-09-15-chinese-interpretation-special-design.md` §6.1。下方 DDL 保留以记录当时形状。

```sql
CREATE TABLE IF NOT EXISTS dictation_passages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  question_id BIGINT NOT NULL,
  work_title VARCHAR(100) NOT NULL,      -- 篇名，如《岳阳楼记》
  author VARCHAR(50) NOT NULL,           -- 作者
  dynasty VARCHAR(20) NOT NULL,          -- 朝代
  body TEXT NOT NULL,                    -- 正文（权威原文，含标点）
  grade_band VARCHAR(20) NOT NULL,       -- 'junior'
  grade VARCHAR(20) DEFAULT NULL,        -- '九年级'
  semester VARCHAR(20) NOT NULL,         -- '上册' / '下册'（篇目必来自某册，故 NOT NULL）
  sort_order SMALLINT NOT NULL DEFAULT 0,
  source_ref VARCHAR(200) DEFAULT NULL,  -- 教材来源（书名 + 页码）
  verified TINYINT(1) NOT NULL DEFAULT 0,
  -- 教学上是否要求背诵。与 verified 是**两道正交的闸门**（2026-09-13 追加）：
  --   verified           = 内容是否已校验（正文准确）—— 内容管线自检通过后置 1
  --   memorize_required  = 教学上是否要求背 —— 由人后续标定
  -- 抽题池 = verified = 1 AND memorize_required = 1。
  memorize_required TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_dp_question (question_id),
  UNIQUE KEY uniq_dp_work (work_title, semester),
  KEY idx_dp_filter (grade_band, semester, sort_order),
  CONSTRAINT fk_dp_question FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

建表语句需**折回** `tools/db/schema.sql`（`install_mysql.sh` 只执行 `schema.sql`，迁移文件必须同步折回，平台既有先例）。

### 4.3 错题本 【已作废，2026-09-15】

> **默写 / 解释专项一律不入错题本**（用户 2026-09-15 裁决，PRD §7.4 已写入例外）。判据：作答单位是**篇目**，标准答案属篇目自带，既无「重做—清零」的对象，也无「变式」的生成物，错题本机制整体不适用。
> 存量 `main_error_books(source='dictation')` 行删除。原结论下方的「不阻塞主线」在当时成立，现已被「不入本」取代。

复用 `main_error_books`，`source='dictation'`。错题按 `subject_id` 隔离，不会串进数学错题练习；主线清零门禁只看 `source='practice'`，故默写错题不阻塞主线。

## 5. 判题设计

入口：`POST /api/training/dictation/judge { questionId, author, dynasty, body }`

1. **归一化**：NFKC 全半角归一 → 去所有空白 → 去中英文标点 → 转小写。即用户要求的「不算标点符号和空格」。标点集直接复用并扩展 `apps/server/src/common/utils/content-hash.util.ts` 的 `PREFIX_STRIP`，实现放同目录 `normalize-chinese.util.ts`，两边共用同一常量，避免出现两套标点表。

   > **NFKC 顺序陷阱（2026-09-13 评审发现并修复）**：因为是「先 NFKC 再去标点」，全角字符会先被 NFKC 改写。只往集合里加全角 `～`(U+FF5E) 是无效的——它会被 NFKC 变成半角 `~`(U+007E)，所以集合里必须同时有半角 `~` 与不被 NFKC 映射的 `〜`(U+301C)，才能真正忽略波浪号。**新增任何标点条目都要按「NFKC 之后是什么」来核对，否则会写下永不匹配的死条目。**（对照：`…`(U+2026) 经 NFKC 展开为 `...`，由集合里的 `.` 兜住，无需单列。）
2. **逐字段比对**：作者 / 朝代 / 正文分别比对（归一化后全等）。
3. **正文差异定位**：LCS 求最小编辑序列，标注「错字 / 漏写 / 多写」及位置，输出结构化 diff 供前端高亮。
   - **展示回投标点（2026-09-14 修正）**：diff 在归一文上算（判对错口径不变），但 `text`/`expected`/`actual` 回投到**原文**，学生看到的是带标点的整句。归属规则：标点归**其后**那个字、串尾标点归末字；`equal` 段带前后标点、`wrong` 段保持单字干净（避免 expected/actual 两侧重复同一标点）、整段漏写保留段内段尾标点。
   - **动因**：原实现直接展示归一文，学生看到的对比是「庆历四年春滕子京谪守巴陵郡」（无标点），读不成句，无法对照改错。判对错忽略标点是对的，**展示不该跟着去标点**。
4. **对错**：三项全对 → `isCorrect=true`；任一不符 → `false`。
5. **错因（LLM，可选）**：`DictationFeedbackCapability` + 场景 `dictation_feedback`，primary=`local`（`Qwen3.8-27B`）、fallback=`deepseek-flash`；输入「学生答案 + 正确答案 + diff 点位」，输出给学生看的提醒文案。
   - 两个模型都失败 → **不阻断判题**，照常返回对错 + diff，`feedback=null`。
   - 错因与具体作答绑定，不做缓存。
   - **与判题解耦（2026-09-14 修正）**：错因**不在 `judge` 的关键路径上**，改由 `POST /api/training/dictation/feedback` 单独取。
     - **动因**：本地 `Qwen3.8-27B` 是**思考模型**（先出 `reasoning_content` 再出正文），挂在关键路径上一次错答要等 **13–16 秒**；而前端全程只有一个变灰的「正在判题…」按钮——学生以为卡死。实测同一个接口答对 25ms、答错 12.6s，差别全在错因这一步。
     - 现在：`judge` 只回判题结果（实测 ~25ms）+ `feedbackPending`；前端立刻渲染对错与正文对比，错因区先转圈（「AI 正在生成错因提醒…」）后填充。
     - 错因端点**只生成话术**，服务端用纯函数 `evaluateDictation` 重算差异——**不写错题本、不重复判题**（重复调 `judgeDictation` 会二次写 `main_error_books`）。
   - **关 thinking（2026-09-14）**：错因对本地端点下发 `chat_template_kwargs:{enable_thinking:false}`（`ChatRequest.extraBody`）。**`thinking:false` 对 llama.cpp 无效**——它只认 chat template 开关，`LocalClient` 会把 DashScope 的 `enable_thinking` 删掉；实测 prompt 末尾加 `/no_think` 也无效（仍出 49 字 reasoning）。关掉后错因 13–16s → **2s 量级**。
     - 只对 `provider === 'local'` 下发：fallback 是云端 deepseek，收到未知字段可能 400。
6. **落库**：【已作废，2026-09-15】原为「对 → `clearUnclearedByStudentQuestionId`；错 → `writeErrorBookOrReuse`（`source='dictation'`）」。现判题**不写任何学生状态**（不入错题本、不清零）。
   - **不调用 `ExplanationCacheService.ensureExplanation`**：该服务对 `answer.length >= 100` 的题会把答案直接当解析写入，而默写长正文必然命中，会产生无意义的「解析 = 正文」。默写的解析就是「正确答案 + diff + 错因」，由结果页直接呈现。
7. **返回**：`judge` → `{ isCorrect, method:'exact', fields:{author,dynasty,body}, bodyDiff, reference, feedback(恒 null), feedbackPending, errorBookId? }`；`feedback` 端点 → `{ feedback: string|null }`。【2026-09-15 起 `errorBookId` 字段取消】

**关键简化**：判对错纯程序化，**不触碰 `JudgmentCapability`**，也不需要给 chinese 补 `judgment` 路由。

## 6. 内容管线

| 步骤 | 做法 | 新/旧 |
|---|---|---|
| 0. 验版本（**闸门**，已完成 2026-09-13） | 结论：平台有统编版六三制九年级上/下册（详见 §3 决策 3）。爬取参数：`--site smartedu --subject 语文 --publisher 统编版 --level 初中 --grade 九年级 --semester 上册`（下册同理） | 旧工具 |
| 1. 爬教材 | 抓九年级上/下册 → 逐页 JPEG | 旧工具 |
| 2. 图转 Markdown | `convert_cli`（MinerU），学科无关 | 旧工具 |
| 3. 抽篇目 | 新建脚本：按「必背篇目清单」在教材 MD 中定位每篇，抽 {篇名, 作者, 朝代, 正文, 册次, 页码} → JSONL | **新建** |
| 4. 校验 | 与权威文本交叉比对 + 长文言文人工抽检 | **新建** |
| 5. 入库 | 新建 importer：写 `questions` + `dictation_passages`，校验通过才置 `verified=1` / `answer_verified=1` 【2026-09-15 起**不写 `questions`**，只写 `chinese_passages`】 | **新建** |

- **篇目清单来源**：教材课后习题的「背诵/默写」标注；抽不出来则回退到公开必背清单人工确认。
- **抽题池守卫**：`verified=0` 的篇目不进抽题池。

  > **守卫的适用范围（2026-09-13 裁决）**：`verified` 门禁只作用于**抽题池**（三条查询全部卡 `verified = 1 AND is_active = 1`）。判定路径按题 id 取篇目时**有意不设门禁**——实测影响面为：非默写题无 `dictation_passages` 行（404，跨学科无泄露）、已停用题由 `judgeCore` 内部的 `questions.findById`（过滤 `is_active = 1`）拦下、残留可达的只有 `verified = 0` 的默写题，而古诗文正文属公开内容、且学生在任何一次提交后都会看到参考答案，故不构成实际新增能力。**不要为该路径补门禁**——那会误伤后续「按 ID 直接练某篇」等合法用法。
  >
  > 【2026-09-15 更新】该裁决的**结论仍然有效**（判定路径按 `passage_id` 取篇目时不卡 `verified`），但**依据要换**：不再有 `questions.findById`，停用改由 `chinese_passages.is_active` 承担；「按 ID 直接练某篇」正是保留该路径的理由。
- **不做**：不走数学那套 `extract_cli → publish_cli → db_loader_cli`（其卡/题模型与篇目级数据不匹配，改动会波及数学）。仅复用 `convert_cli`。

## 7. 前端设计

新增路由（`apps/web/src/routes/index.tsx`，均 `RequireRole student` + 全屏沉浸）：

| 路径 | 页面 |
|---|---|
| `/student/training/chinese/special` | `ChineseSpecialPage` —— 两卡：古诗文默写（可点）/ 古诗文解释（敬请期待） |
| `/student/training/chinese/dictation` | `DictationConfigPage` —— 范围（九上/九下/全部）+ 题量（3/5/8/10）随机抽；可展开篇目清单勾选指定篇目 |
| `/student/training/chinese/dictation/run` | `DictationRunPage` —— 题面 + 三字段作答 + 提交 → 逐项反馈 |

**提交后的等待态（2026-09-14 修正）**：判题回来即渲染对错 + 正文对比；答错时错因区显示**转圈 +「AI 正在生成错因提醒…」**，错因到位后替换为文案。提交按钮在判题期间也带转圈。
**动因**：原实现提交后只有一个变灰的「正在判题…」按钮，而实际要等 13–16 秒（见 §5 第 5 条），学生以为页面卡死——用户原话「不给对错结果……也应该有一个等待的动画呀」。
转圈用线性 SVG（`animate-spin`，与 `QuestionRunner` 判题等待视图同款），无 emoji、无装饰元素，符合 `style.md` 硬约束。

改动：

- `TrainingSubjectPage.tsx`：语文改 `enabled:true`，`handleSelect` 按学科跳转（数学 → 原 `/student/training/home`；语文 → `/student/training/chinese/special`）；
- 新建 `components/business/dictation/` 下的「三字段作答 + 差异高亮结果」组件；
- 复用 `RunExitGuard`、草稿面板、`AnswerResultList` 的视觉语言；
- 样式遵循 `apps/web/style.md`（无 emoji、线性 SVG、单一配色、iPad 横屏优先）。

## 8. 后端改造清单 【部分作废，2026-09-15】

> 下表为**当时**的新增清单，均已实施。**下列条目已被 2026-09-15 改造二次修改**：`judge-core.service.ts`（去错题本写入/清零）、`dictation-passages.repo.ts`（改名 `chinese-passages.repo.ts`、去 `JOIN questions`）、`tools/db/schema.sql`（改折 `chinese_passages`）。改造后的完整清单见 `2026-09-15-chinese-interpretation-special-design.md` §9。

| 文件 | 改动 |
|---|---|
| `modules/training/training.controller.ts` | 新增 `GET /dictation/passages`、`POST /dictation/start`、`POST /dictation/judge`、`POST /dictation/feedback`（2026-09-14 增） |
| `modules/training/training.service.ts` | 新增 `listPassages` / `startDictation` / `judgeDictation`（纯判题不等 LLM）/ `generateDictationFeedback`（2026-09-14 增） |
| `modules/practice/judge-core.service.ts` | 新增 `dictation` 分支（纯程序比对 + diff）；math 分支一行不动 |
| `database/repositories/dictation-passages.repo.ts` | **新建** |
| `common/utils/normalize-chinese.util.ts` | **新建**：`normalizeChineseAnswer` + LCS diff；标点常量与 `content-hash.util.ts` 共用。2026-09-14 增 `evaluateDictation`（纯判题）与 `diffChineseInOriginalText`（标点回投） |
| `ai-core/capabilities/dictation-feedback.capability.ts` | **新建**：场景 `dictation_feedback`，文本输出；2026-09-14 起对 local 下发关 thinking 的 `extraBody` |
| `ai-core/prompts/dictation/feedback.md` | **新建** |
| `ai-core/model-routes.yaml` | 新增 `dictation_feedback` 路由（primary `local`，fallback `deepseek-flash`） |
| `ai-core/retry.yaml` | 新增 `dictation_feedback` 超时（注：流式调用下 `request.timeout` 只在 `streaming.*` 缺失时兜底，实际生效的是 idle 超时——见 CLAUDE.md 已知限制） |
| `ai-core/types.ts` | `Scene` 加入 `'dictation_feedback'`；新增结果类型接口；2026-09-14 增 `ChatRequest.extraBody` |
| `ai-core/infra/model-client/local-client.ts` | 2026-09-14 增 `LLAMA_CPP_NO_THINKING_BODY`（关 thinking 的 chat template 开关） |
| `ai-core/infra/prompt-builder.ts` | `resolveTemplatePath` 支持 dictation feedback 模板 |
| `tools/db/schema.sql` | 折回 `dictation_passages` 建表 |
| `scripts/seed-llm-config.ts` **或**新脚本 | 已 seed 的库补 `dictation_feedback` 路由（YAML 只服务新装 / DB 空时） |

## 9. 测试与验收

**vitest 单测**

- `normalizeChineseAnswer`：标点、空格、全半角归一；简繁不转换；
- 逐字段比对：全对 / 仅作者错 / 仅朝代错 / 仅正文错 / 空字段；
- LCS diff：错字、漏字、多字、换位；
- **标点回投**（2026-09-14 增）：相等段带标点、错字段保持单字不重复标点、整段漏写保留段内段尾标点、**学生整篇不打标点也能用 expected 侧标点展示**；
- 判题分支：三项全对 → 答对清零；任一不符 → 入错题本（`source='dictation'`）；【2026-09-15 起改为：判题**不写任何学生状态**，测试应断言 `mainErrorRepo` 未被调用】
- **判题与错因解耦**（2026-09-14 增）：判错时 `judgeDictation` **不调用 LLM**（`dictationFeedback.generate` 调用次数为 0）、回 `feedbackPending=true`；`generateDictationFeedback` 失败回 `feedback=null` 且不抛错；错因端点**不写错题本**；
- LLM 不可用 → 仍返回对错 + diff，`feedback=null`，不抛错。

**pytest 管线测试**：篇目抽取、校验、`verified` 守卫。

**手测**：真机走通 训练 → 语文 → 专项 → 默写 → 判题 → 结果；含 1 篇长文言文；确认数学专项页无回归。

**内容验收**：全量篇目正文与权威文本一致（脚本比对 + 人工抽检长文）。

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 平台无九年级语文教材 / 版本标签不确定 | 步骤 0 的 `--dry-run` 闸门，用户确认后才继续 |
| 文言文生僻字 OCR + 正文夹注释/旁批，抽取精度不稳 | 逐字校验硬闸门 + 长文言文人工抽检；建议先小批打样 5 篇（含 1 长文）再全量 |
| 教材版本差异导致篇目/正文不一致 | 版本确认 + 逐篇校验；`source_ref` 记录来源可追溯 |
| 抽题池混入未校验内容 | `verified=1` 守卫 |
| LLM 不可用 | 判题不依赖 LLM，仅少错因文案 |

## 11. 实施顺序

1. **步骤 0 闸门**：跑 `crawler --dry-run` 列语文版本 → 用户确认；
2. **小批打样**：爬 1 册 → convert → 抽 5 篇（含 1 长文）→ 校验 → 入库 → 打通判题与页面；
3. **最小多学科化**：语文入口 enabled + 新路由 + 三端点 + 判题分支 + 错因能力；
4. **全量内容**：补齐九年级上/下册必背篇目 → 逐篇校验 → 入库；
5. **验收**：单测 + 管线测试 + 真机手测 + 内容比对。

## 12. 后续（本次不做）

- 古诗文解释专项（另起 spec）；
- 语文真题考试页、语文错题练习页；
- 数学专项页的多学科化泛化；
- 手写拍照默写识别（OCR / VLM）。
