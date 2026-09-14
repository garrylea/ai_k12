# 训练 → 语文 → 专项：古诗文解释（翻译）+ 古诗文专项独立化改造

- 日期：2026-09-15
- 状态：设计已与用户逐节确认
- 关联文档：`docs/superpowers/specs/2026-09-13-chinese-dictation-special-design.md`（第一个专项，本次要**改造它**）、`docs/superpowers/specs/2026-09-13-chinese-dictation-content-pipeline-design.md`（默写内容管线）、`docs/superpowers/specs/2026-09-10-question-content-importer-design.md`（`--export`/`--apply` 校对闭环先例）、`docs/K12智学系统-产品需求文档.md` §6.3

## 1. 背景与问题

语文的第一个专项「古诗文默写」已上线（50 篇入库、三端点、纯程序判题、错因能力、前端三页）。本设计做语文的第二个专项——**古诗文解释**（重点字词释义 + 逐句翻译），并借此完成一次**架构归位**。

### 1.1 为什么第二个专项会牵出「独立化」

默写专项当初是「贴着 `questions` 表」建的：每篇必须有一行 `questions`（`type='poem_dictation'`），`dictation_passages.question_id` 指向它并加唯一约束。当时这样做的理由是错题本 / 隐藏题 / 提示缓存都挂 `question_id`。

实测**这个理由不成立**（2026-09-15 用户裁决）：古诗文专项是「一篇一练、篇目自带标准答案、判题方式自成一套」的形态——默写答错该不该进错题本？不该。点「不再展示」有没有意义？没有。于是 `question_id` 现在实际只承担三件事，且三件都不该由它承担：

| 现在由 `question_id` 承担 | 代码位置 | 正确的承担者 |
|---|---|---|
| 题面 `content`、学科过滤 `subject_id`、停用 `is_active` | 三条抽题 SQL 全部 `JOIN questions q ... WHERE q.subject_id = 2 AND q.is_active = 1` | 题面由 `work_title` 生成；学科由表本身承担；停用改本表一列 |
| 「不再展示」排除 | `findRandomVerified` 的 `LEFT JOIN student_hidden_questions ... AND shq.id IS NULL` | 无（去掉） |
| 错题本写入 / 清零 | `judgeDictation`：`writeErrorBookOrReuse(source='dictation')` / `clearUnclearedByStudentQuestionId` | 无（去掉） |

`poem_dictation` **不在** `TrainingController.TARGETED_TYPES` 白名单内，故那 50 行 `questions` 除上表三件事外无人读取——摘除不会波及其它链路。

### 1.2 本次要做两件事

1. **架构归位**：古诗文专项脱离 `questions` 体系，一张自己的表承载全部；
2. **功能新增**：古诗文解释专项（重点字词 + 逐句翻译）。

两件事动的是同一张表、同一批文件，**必须一次改完**，分两次做等于把同一处重构做两遍。

## 2. 核心原则：古诗文专项是独立子系统（**本次确立，写入四份文档**）

> **训练轨下的「语文古诗文专项」（默写、解释/翻译）是独立子系统**：篇目级数据、自成一体的判题方式，**不挂 `questions`、不进错题本、不参与主线清零门禁、不参与「不再展示」/提示缓存/自评**。它们自己的 `chinese_passages` 表就是全部，与既有业务表**没有关系**。
>
> **但这条原则只覆盖「古诗文专项」这一类，不是「语文整个学科独立」**：后续的**语文试题**（试卷 / 真题 / 考试）属于正常题库业务，仍走 `questions` + 错题本 + 考试/组卷既有体系，**复用、不另起一套**。

**判据（为什么默写/解释算「专项」而试题不算）**：专项的作答单位是**篇目**（一篇一次练习），标准答案是**篇目自带的属性**（正文、释义、译文），判题方式是**专属的**（程序化 diff / LLM 释义比对）；而试题的作答单位是「题」，标准答案属题、错题要进错题本参与清零门禁，与既有 `questions` 体系天然同构。形态不同则存储不同，不是按学科划界。

## 3. 目标与非目标

**目标**

1. 初三学生可从 训练 → 语文 → 专项 → 「古诗文解释」进入练习；
2. 覆盖与默写同一批篇目（九上/下册古诗文，`verified=1`）；
3. 每篇**整篇作答**：全部重点字词（教材注释逐条）+ 全部句子逐句翻译——答完所有句子即等于把全文译了一遍；
4. 判题由 LLM 完成（本地模型优先、`deepseek-flash` 兜底、关 thinking），整篇一次批量调用；
5. 判题结果与标准答案逐项回呈，附全文对照；
6. 完成架构归位：`dictation_passages` → `chinese_passages`，摘除 `question_id` 及其三处用途。

**非目标**

- 不做语文真题考试页、语文错题练习页（试题类走既有体系，另案）；
- 不做手写拍照识别（OCR / VLM）；
- 不做「注释从页面图片转录」的支线（MinerU 丢注释的问题本次用「先入现有数据 + 人工校对回写」应对，见 §5.2）；
- 不做语文知识点树，不做主线/辅线联动；
- 不改动数学侧任何行为。

## 4. 关键决策

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 专项是否独立于 `questions` | **独立**。默写+解释都不挂 `questions`、不进错题本、不用「不再展示」。语文试题类**不适用**本原则（§2） |
| 2 | 数据模型 | 一张 `chinese_passages`，一篇一行，两个专项共用；无外键、无 `questions` 行 |
| 3 | 内容存储 | 允许 MySQL **JSON 类型**（本次修订数据库约定，见 §6.4）：`key_terms` / `sentences` 用 JSON，`full_translation` 用 TEXT |
| 4 | 作答形态 | **字词 + 逐句翻译**（不做「整篇翻译一次作答」——学生译文与标准句的对齐很脆弱；也不做「整篇 + 逐句都答」——同一篇写两遍） |
| 5 | 题量 | 每篇**全篇作答**（全部字词 + 全部句子），配置页只控**篇数**（1/2/3） |
| 6 | 字词标准答案来源 | 教材注释（`⑧〔鄙〕浅陋。`）**原样成条**（`src:"textbook"`）；注释覆盖不到的由 LLM 从原文补（`src:"llm"`）。两种来源并存入库，靠 `--export`/`--apply` 供人工校对统一 |
| 7 | 字词出题范围 | **全部注释项都出**，不做长度筛选（教材认为值得注的就是重点） |
| 8 | 逐句 / 全文翻译标准答案 | 数据入库时由 **LLM 生成**（用户确认「现在 LLM 给的答案准确率很高」）；切句由**程序**做，模型只填 `translation` |
| 9 | 判题方式 | 整篇一次**批量** LLM 调用；程序短路先行（空答案、归一化全等）；本地优先 + ds flash 兜底 + 关 thinking |
| 10 | 判题失败 | **逐项** `undetermined`（模型漏项、整次失败都算），前端逐项显示「未判定」+ 整篇「重新判题」；已判定的项不清空 |
| 11 | 抽题池门禁 | 解释专项：`verified=1 AND is_active=1`（**不设** `memorize_required` 门——「要背诵」不是「要理解翻译」的必要条件）。默写专项保持 `verified=1 AND memorize_required=1 AND is_active=1` 不变 |
| 12 | 存量数据 | `main_error_books(source='dictation')`、`student_hidden_questions` 指向 `poem_dictation` 的行、50 行 `poem_dictation` 题**一并删除** |

## 5. 内容管线

### 5.1 注释源的实测结论（决定了 §5.2 的做法）

爬到的页面图片证明**教材注释是完整的**，但 MinerU 转出的 MD **把页底注释块大量丢弃**（实测 2026-09-15）：

| 篇目 | 正文角标 | MD 里的注释行 |
|---|---|---|
| 《岳阳楼记》 | 73 | **6**（图上 31 条清晰可见，全丢） |
| 《醉翁亭记》 | 37 | 11 |
| 《曹刿论战》 | 48 | 31 |
| 《出师表》 | 20 | 16 |
| **两册合计** | **637** | **178（28%）** |

图片全在本地（`tools/crawler/data/语文/...`），故未来可另行走 VLM 转录补齐——**本次不做**，改为「先用现有数据入库 + 人工校对回写」。

### 5.2 CLI `interpretation_cli.py`（新建）

```
--extract   抽注释 + LLM 出翻译 → JSONL + 过目清单
--load      幂等入库
--export    导出可编辑校对稿（JSONL）
--apply     校对稿幂等回写
```

`--export` / `--apply` 对标既有 `answer_importer`（JSONL 输入、幂等回写），构成人工校对闭环：**用户改完校对稿后 `--apply` 回写，不直接改库**。

**步骤**

1. **原文不重新定位** —— 读 `chinese_passages.body`（已校验的权威正文）。上一阶段的定位逻辑（浅切、角标剥离、偏移众数、词牌格律切尾）**一行都不重走**。
2. **抽注释** —— 从**原始页 MD**（`output/md/语文/.../page_NNN.md`，即未被 `cut_page_annotations` 切过的版本）取页底注释行，按「页窗 + 圈号序列重启」归属到篇。要处理的实测形态：

   | 形态 | 例子 | 处理 |
   |---|---|---|
   | 词条 | `⑧〔鄙〕浅陋。这里指目光短浅。` | 直接成条 |
   | 短语 | `⑨〔何以战〕即"以何战"，凭借什么作战？以，凭、靠。` | 直接成条 |
   | 带注音 | `⑭〔牺牲玉帛（bó）〕…` | 剥 `（bó）` |
   | 跨页续行 | `①〔然则〕表示承接上文…⏎"既然这样，那么"。` | 合并续行（次行不以圈号开头） |
   | 圈号 OCR 变体 | `②⑨`（实为 ㉙）、`⑳`~`㉟` 多字符 | 先归一化再对位 |

3. **LLM 补字词** —— 注释抽到的**原样成条**（`src:"textbook"`）；LLM 再从原文补它认为重要而注释缺失的字词（`src:"llm"`）。按 `term` 归一化去重（教材注释优先）。
4. **LLM 出逐句 + 全文翻译** —— 切句由程序做（按 `。！？；`，标点留句尾），**模型只填 `translation`、不产出原文字符**（沿用上一阶段「LLM 不产出正文」的裁决）。输入附上已抽到的注释作参考。本地模型优先、ds flash 兜底（关 thinking）。
5. **自检（不过不放行）**
   - `''.join(s.text for s in sentences) == body` **逐字相等**（含标点）；
   - 每条 `translation` 非空、每项 `gloss` 非空；
   - 句数 ≥ 1；`full_translation` 非空。
6. **过目清单 Markdown** —— 篇名 / 作者 / 朝代 / 正文字数 / 字词数（分 `textbook`/`llm` 计数）/ 句数 / 首尾样例。
7. **幂等入库** —— 业务键 `(work_title, semester)` 先找既有行、有则原地 UPDATE、无则 INSERT（沿用默写 loader 的策略与理由：题面/正文一改 `content_hash` 就变，按 hash 去重会插重复行）。`ON DUPLICATE KEY UPDATE` **不出现** `verified` / `memorize_required` / `is_active`（否则管线重跑会刷掉用户手标的必背与停用状态）。

### 5.3 归属算法（注释 → 篇目）

- **页窗**：篇目正文的锚点页到下一个候选的锚点页之间的页（复用 `dictation_locate` 的页计算方法）；
- **圈号序列重启**：教材注释编号按篇从 ① 起算，取窗口中「首个 ① 之后」的连续序列作为本篇注释——这同时排除掉窗口起始处属于上一篇的注释尾巴。

## 6. 数据模型

### 6.1 `chinese_passages`（改造自 `dictation_passages`）

```sql
CREATE TABLE IF NOT EXISTS chinese_passages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,   -- 篇目身份（取代 question_id）
  work_title VARCHAR(100) NOT NULL,
  semester VARCHAR(20) NOT NULL,          -- 业务键 (work_title, semester)
  author VARCHAR(50) DEFAULT NULL,
  dynasty VARCHAR(20) DEFAULT NULL,
  body TEXT NOT NULL,                     -- 权威原文，全系统唯一一份
  -- 解释专项内容
  key_terms JSON DEFAULT NULL,            -- [{"term":"谪守","gloss":"…","src":"textbook"|"llm"}]
  sentences JSON DEFAULT NULL,            -- [{"text":"…","translation":"…"}]
  full_translation TEXT DEFAULT NULL,
  -- 公共
  grade_band VARCHAR(20) NOT NULL,
  grade VARCHAR(20) DEFAULT NULL,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  source_ref VARCHAR(200) DEFAULT NULL,
  verified TINYINT(1) NOT NULL DEFAULT 0,
  memorize_required TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,   -- 取代原 questions.is_active
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_chinese_passages_work (work_title, semester),
  KEY idx_chinese_passages_filter (grade_band, semester, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**设计说明**

- **无外键**：这张表不指向任何表，也不被任何表指向（错题本 / 隐藏题已摘除）。表本身就是完整边界。
- **`body` 为什么还单独存**：不变式 `''.join(s.text for s in sentences) == body` 必须逐字成立（含标点），独立成列才能在入库自检里断言它；否则切句漂移了没人发现。同时它也服务默写专项（三字段作答的正文）。
- **建表语句折回 `tools/db/schema.sql`**（`install_mysql.sh` 只执行 `schema.sql`），迁移文件供已建库环境。

### 6.2 存量数据清理（迁移的一部分）

FK 行为实测（`tools/db/schema.sql`）：`student_hidden_questions` / `question_hints` / `question_self_assessments` 对 `questions` 都是 **`ON DELETE CASCADE`**，`main_error_books.question_id` 是 **`ON DELETE RESTRICT`**。故只需先手动清错题本，其余靠级联：

```sql
-- RESTRICT，必须显式先删
DELETE FROM main_error_books WHERE source = 'dictation';
-- 级联清掉 student_hidden_questions / question_hints / question_self_assessments 中
-- 指向这 50 行的记录
DELETE FROM questions WHERE type = 'poem_dictation';
```

级联删掉的隐藏题 / 提示缓存 / 自评记录按「本就不该存在、有则一并清掉」处理（`poem_dictation` 从未走过提示缓存与自评路径，实际应为空）。

### 6.3 表改名与结构迁移

```sql
RENAME TABLE dictation_passages TO chinese_passages;
ALTER TABLE chinese_passages
  DROP FOREIGN KEY fk_dp_question,
  DROP INDEX uniq_dp_question,
  DROP COLUMN question_id,
  ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER memorize_required;
-- 索引改名，对齐《数据库设计文档》§1.1 的命名约定
ALTER TABLE chinese_passages
  DROP INDEX uniq_dp_work, ADD UNIQUE KEY uniq_chinese_passages_work (work_title, semester),
  DROP INDEX idx_dp_filter, ADD KEY idx_chinese_passages_filter (grade_band, semester, sort_order);
```

迁移文件幂等（`information_schema` 判存在再改，沿用既有迁移写法）。

### 6.4 数据库约定变更：允许 JSON 类型

用户 2026-09-15 裁决：**修改数据库约定，可以用 JSON 类型**。`docs/K12智学系统-数据库设计文档.md` §1.1 通用规则需：

- 保留 TEXT 行（既有场景不变），**新增** JSON 行：用于「结构化的可变结构」（如篇目的重点字词、逐句翻译）；MySQL 原生 JSON 类型；
- 补两处驱动差异说明（本次实测确认）：
  - **Node 侧**：mysql2 读 JSON 列**已自动 parse**（不要再 `JSON.parse`，会抛错），写时必须 `JSON.stringify`（直接传对象会被 `toString()` 成 `[object Object]`）；
  - **Python 侧**：pymysql 读回来是**字符串**，须 `json.loads`；写用 `json.dumps`。

## 7. 判题设计

`POST /api/training/interpretation/judge`

```json
{ "passageId": 12,
  "terms":     [{"term": "谪守", "answer": "被贬官"}],
  "sentences": [{"index": 0, "answer": "庆历四年春天，滕子京被贬到巴陵郡。"}] }
```

**流程**

1. **程序短路**（不进 LLM，省 token 也更快）
   - 学生答案空白 → `correct:false, method:'unanswered'`；
   - `normalizeChineseAnswer(学生) === normalizeChineseAnswer(标准)` → `correct:true, method:'exact'`（复用 `common/utils/normalize-chinese.util.ts`）。
2. **剩余项打包一次调用** —— 新场景 `interpretation_judge`，primary=`local`（`Qwen3.8-27B`，下发 `extraBody: LLAMA_CPP_NO_THINKING_BODY` 关 thinking——`thinking:false` 对 llama.cpp 无效）、fallback=`deepseek-flash`。输出 `{"results":[{"id":"T0","correct":true,"comment":"…"}],"…}`。
   - 判题口径写进 prompt：判的是**意思是否到位**，不是措辞是否一致；字词释义要求覆盖核心义项；句子翻译要求关键实词与句式理解正确、大意准确；可接受同义表述。
3. **未判定** —— 模型漏项的 id、或整次调用失败 → 逐项标 `undetermined`。**已判定的项不清空**（学生不会因模型抖动丢掉已得的反馈）。
4. **不写任何学生状态** —— 无错题本、无隐藏题、无提示缓存、无自评。
5. **返回**

```json
{ "passageId": 12, "allCorrect": false, "undetermined": 2,
  "terms":     [{"term":"谪守","correct":false,"standard":"因罪贬谪流放，出任外官","comment":"…"}],
  "sentences": [{"index":0,"correct":true,"standard":"…","comment":null}],
  "fullTranslation": "…" }
```

`standard` **只在判题响应里下发**（`start` 不出——释义与译文就是答案，防泄题）；`undetermined > 0` 时前端显示「N 项未判定」+「重新判题」。

## 8. 前端设计

| 路径 | 页面 |
|---|---|
| `/student/training/chinese/special` | `ChineseSpecialPage` —— 第二张卡由「敬请期待」改为可点 |
| `/student/training/chinese/interpretation` | `InterpretationConfigPage` —— 范围（九上/九下/全部）+ 篇数（1/2/3）随机抽 |
| `/student/training/chinese/interpretation/run` | `InterpretationRunPage` —— 答题 + 逐项反馈 |

**`InterpretationRunPage` 结构**

- 顶部：篇名 + 册次 + 进度；
- 区段一「重点字词」：逐条 `〔term〕` + 释义输入框；
- 区段二「逐句翻译」：逐句原文 + 译文输入框；
- 提交 → 转圈（线性 SVG，`animate-spin`，与 `DictationRunPage` 同款）+「AI 正在判题…」；
- 结果：逐项对错标记 + 标准答案 + 点评；`undetermined` 项显示「未判定」；底部「重新判题」；
- 底部「全文对照」：学生译文按句拼接 vs `fullTranslation`。

**约束**：遵循 `apps/web/style.md`（无 emoji、线性 SVG、单一配色、iPad 横屏优先）；题单经 `sessionStorage` 交接（镜像 `DictationRunPage`）；复用 `PageHeader` / `RunExitGuard` / 草稿面板。

## 9. 后端改造清单

| 文件 | 改动 |
|---|---|
| `database/repositories/dictation-passages.repo.ts` | **改名** `chinese-passages.repo.ts`；三条查询去掉 `JOIN questions` 与 `LEFT JOIN student_hidden_questions`，原 `q.subject_id = 2`（表本身就是语文）与 `q.is_active = 1` 两个谓词合并为本表的 `is_active = 1`；`upsert` 去 `questionId`；新增解释三列的读写与 `findById` |
| `modules/practice/judge-core.service.ts` | `judgeDictation` 去掉 `questionsRepo.findById` 与错题本写入/清零 |
| `modules/training/training.service.ts` | 入参 `questionId` → `passageId`（`questionIds` → `passageIds`）；题面服务端由 `work_title` 生成（保持响应字段 `prompt` 不变，前端零改）；新增 `listInterpretationPassages` / `startInterpretation` / `judgeInterpretation` |
| `modules/training/training.controller.ts` | 三个 dictation 端点字段改名；新增三个 interpretation 端点；`passageIds` 校验同 `questionIds` |
| `modules/training/dto/dictation.dto.ts` + 新建 `interpretation.dto.ts` | 字段名同步 / 新 DTO |
| `ai-core/capabilities/interpretation-judge.capability.ts` | **新建**：场景 `interpretation_judge`，JSON 输出 |
| `ai-core/prompts/interpretation/judge.md` | **新建** |
| `ai-core/model-routes.yaml` | 新增 `interpretation_judge` 路由（primary `local`，fallback `deepseek-flash`） |
| `ai-core/retry.yaml` | 新增 `interpretation_judge` 超时 |
| `ai-core/types.ts` | `Scene` 加 `'interpretation_judge'`；新增请求/结果类型 |
| `ai-core/infra/prompt-builder.ts` | `resolveTemplatePath` 支持 interpretation 模板 |
| `scripts/seed-dictation-fixture.ts` | 去 `questions` 行写入，改 `chinese_passages` |
| `tools/data-refinery/src/dictation_loader.py` | 不再写 `questions` 行；写 `chinese_passages` |
| `tools/data-refinery/src/interpretation_cli.py` 等 | **新建**（§5.2） |
| `tools/db/schema.sql` | 折回 `chinese_passages` 建表 |
| `tools/db/migrations/2026-09-15_chinese_passages.sql` | **新建**（§6.2 / §6.3） |
| `apps/server/src/scripts/set-*.ts` 或新脚本 | 已 seed 的库补 `interpretation_judge` 路由 |

## 10. 文档更新清单（用户明确要求）

| 文档 | 更新内容 |
|---|---|
| `docs/K12智学系统-产品需求文档.md` | §6.3 训练轨：写入「古诗文专项是独立子系统」及其边界（试题类不适用） |
| `docs/K12智学系统-架构设计文档.md` | §4.2 核心子系统：新增「语文古诗文专项」子系统；§6.2 主要数据表：新增 `chinese_passages` |
| `docs/K12智学系统-数据库设计文档.md` | §1.1 通用规则：**允许 JSON 类型**（新增 JSON 行 + 驱动差异说明）；§3 表定义：新增 `chinese_passages`（原 `dictation_passages` 条目替换）；§2 ER 总览同步 |
| `CLAUDE.md`（根目录） | 写入「古诗文专项独立于 `questions` 体系」这条原则及其边界 |
| `docs/API接口与数据流设计文档.md` + `docs/api/openapi.yaml` | 字段改名（`questionId`→`passageId`）+ 新增 3 端点 + 数据流（两份互为对照，须同步） |
| `docs/ai-core-changelog.md` | 本次变更条目 |
| `docs/superpowers/specs/2026-09-13-chinese-dictation-special-design.md` | 标注「§4.3 错题本 / §5 第 6 条落库 / `question_id` 相关」已被本 spec 推翻 |

## 11. 测试与验收

**vitest 单测**

- 切句纯函数：拼接恒等于 `body`；空正文 / 无句末标点 / 单句等边界；
- 短路：空答案 → `unanswered`；归一化全等 → `exact`；两者都不进 LLM（断言模型调用次数为 0）；
- 判题 capability：mock `modelClient`——部分返回 → 对应项 `undetermined` 且已判项保留；整次失败 → 全部 `undetermined`；两者都**不抛错**；
- 「不写学生状态」：`judgeInterpretation` 完成后 `main_error_books` / `student_hidden_questions` 无新增（断言 repo 未被调用）；
- 抽题池门禁：解释专项查询断言 SQL 含 `verified = 1` 与 `is_active = 1`、**不含** `memorize_required`；默写查询断言**含** `memorize_required = 1`（证明两条门禁确实不同）；
- 「全部册次」按篇名去重的子查询仍在（九上/九下有 9 篇重复收录）。

**pytest 管线测试**

- 注释解析四形态 + 圈号 OCR 变体归一；
- 注释归属：圈号序列重启切分正确；
- 自检：拼接不等 → 拒绝；`gloss` 空 → 拒绝；
- 幂等入库：重跑不产生重复行、不改 `verified`/`memorize_required`/`is_active`；
- `--export` → 改动 → `--apply` 往返一致。

**手测**：真机走通 训练 → 语文 → 专项 → 解释 → 判题 → 结果（含一篇长文言文《岳阳楼记》、一首词）；确认**默写专项无回归**（改名后三端点仍通）；确认数学专项页无回归。

**内容验收**：`chinese_passages` 50 行的 `key_terms` / `sentences` 自检全绿；人工抽看长文言文的释义与译文。

## 12. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 表改名波及已上线的默写（7 个代码文件） | 一次改完，靠现有测试兜底；手测默写全链路 |
| 删存量错题本 / 隐藏题行不可逆 | 用户已明确裁决「一并删掉」；迁移前建议 `mysqldump` 相关行留底 |
| 本地模型判题质量不稳 | ds flash 兜底；判错风险由「逐项 + 可重新判题 + 标准答案并列」缓解，最终由人工校对统一标准答案 |
| LLM 全文翻译/逐句译文出错 | 入库自检只管格式、看不懂内容——故留 `--export`/`--apply` 供人工校对（用户已确认会做） |
| 教材注释残缺（28%）导致题量与质量不齐 | 本次先用现有数据 + LLM 补；图片留在本地，未来可另行走 VLM 转录补齐 |
| JSON 列在 Node/Python 两侧的解析差异 | §6.4 已写明两处坑；两侧各配单测钉住 |

## 13. 实施顺序

1. **数据层**：`chinese_passages` 建表折回 `schema.sql` + 迁移文件（改名 / 摘 `question_id` / 清存量）→ 跑迁移 → 确认 50 行完好；
2. **默写改造**：repo 改名与去 JOIN → `judgeDictation` 去掉错题本 → service/controller 字段改名 → 种子脚本 → **默写全链路手测无回归**；
3. **解释后端**：repo 解释列读写 → capability + prompt + 路由 → 三端点；
4. **内容管线**：`interpretation_cli.py`（抽注释 → LLM 翻译 → 自检 → 入库 → 校对闭环）→ 全量 50 篇入库；
5. **前端**：专项页第二张卡启用 → 配置页 → 答题页；
6. **文档**：§10 清单（含四份主文档 + CLAUDE.md）一次补齐；
7. **验收**：单测 + 管线测试 + 真机手测（含默写回归）。

## 14. 后续（本次不做）

- 语文真题考试页、语文错题练习页（走既有 `questions` 体系）；
- 从页面图片 VLM 转录教材注释，补齐其余 72%；
- 字词 / 句子级错题统计（如「全站最常错的 10 个字词」）——现数据结构（JSON 列）不支持按项聚合查询，需要时再评估是否拆子表；
- 语文知识点树、主线/辅线联动。
