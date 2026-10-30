# Data Refinery 管线总结与后续

> 进展截止：2026-10-28。本文是 data-refinery 数据管线的现状总结与后续工作指引，供后续开发参考。

## 1. 管线概览

四阶段顺序管线 + 答案提取支线 + 一个编排入口，全部在 `tools/data-refinery/`：

```
convert_cli  ->  extract_cli  ->  publish_cli  ->  db_loader_cli
   (MinerU)      (LLM 提取)       (物化图片)      (入库 MySQL)
                                                   ^
              import_cli 串联四阶段（单科/单卷日常导入，增量入库）
                              refinery_cli 串联 publish + db_loader

试卷答案补录（独立支线，可选）：
answer_extract_cli（按学科 case 提取答案 -> 答案文档）-> answer_importer_cli --doc（回写库）
```

| 阶段 | 程序 | 输入 | 输出 | 状态 |
|---|---|---|---|---|
| 1 convert | `src/convert_cli.py` | 爬虫素材（PDF/图片书，`tools/crawler/data`） | `output/md/*.md` + `images/` | ✅ 跑通（2340 文件） |
| 2 extract | `src/extract_cli.py` | `output/md/*.md` | `output/extracted/<stem>.jsonl` | ✅ 跑通（25 文件） |
| 3 publish | `src/publish_cli.py` | `output/extracted/*.jsonl` | `output/published/<stem>.jsonl` + `output/assets/` | ✅ 跑通（25 + 211 assets） |
| 4 db_loader | `src/db_loader_cli.py` | `output/published/*.jsonl` | MySQL `ai_k12` | ✅ 跑通（34 cards + 466 questions） |
| 一键导入 | `src/import_cli.py` | 爬虫素材 | 上述四阶段产物（统一范围参数、增量入库） | ✅ 2026-10-28 |
| 答案提取 | `src/answer_extract_cli.py` | `output/md/*.md` | `output/answers/*.md`（答案文档） | ✅ 语文首发（2026-10-28） |
| 答案回写 | `src/answer_importer_cli.py --doc` | 答案文档 + `paper_id` | `questions.answer/explanation`（`answer_verified=1`） | ✅ |
| 编排 | `src/pipeline_cli.py` / `src/refinery_cli.py` | - | 教材全流程 / 后段 publish->db_loader | ✅ |

DB 一次性初始化：`tools/db/install_mysql.sh`（建库 + ai_k12 用户 + schema + subjects seed）。

## 2. 当前数据现状

- `output/md/`：2340 文件（convert 产物）。
- `output/extracted/`：25 jsonl = 9 下册 card 页 + 16 试卷/答案。
- `output/published/`：25 jsonl；`output/assets/`：211 图片。
- MySQL `ai_k12`：subjects 9 行（seed）、cards 34、questions 466、textbook_versions 1（math_人教版_junior）、semesters 1（九年级下册）、units 1（第二十六章）、lessons 3（章综述 + 26.1.1 + 26.1.2）。
- 0 个未映射 lesson_id（所有 card 都映射到 lessons.id）。

## 3. 关键实现决策（gotchas，改代码前必读）

### LLM 配置
- 走 **DeepSeek**（Anthropic 兼容端点 `https://api.deepseek.com/anthropic`，模型 `deepseek-flash`，reasoner，需 `LLM_MAX_TOKENS=65536`）。
- `.env` 用 **`LLM_BASE_URL` / `LLM_AUTH_TOKEN`**（refinery 专属），**不要用 `ANTHROPIC_*`**--shell 里 Claude Code 的 `ANTHROPIC_*` 会通过 `load_dotenv(override=False)` 覆盖 refinery 的配置。`config.py` 已优先读 `LLM_*`。
- `llm.py` 支持 `openai` / `anthropic` 两种 provider（`LLM_PROVIDER`）。

### extract（教材 card）
- **lesson_id 跨页继承**：LLM 每张 card 输出小节/章标题原文（标识），续页/续卡片填 `null`；CLI 维护 per-book running 状态继承 null（`extract_cli.py` 的 `book_lesson`）。**只有编号标题**（`N.M`/`N.M.K`/`第N章`）开新课；练习/习题/侧栏标题填 null 继承。章综述归该章"第 0 节"（lesson sort_order=0）。
- **前置内容不抽取**：封面/书名/编委/版权/前言/目录（条目带页码）输出 `{items:[]}`，CLI 不写 jsonl 但记 checkpoint。
- **全角括号统一半角**（2026-09-01）：extract_cli 读页 md 后（`scan_page` 之后、`split_page` 之前）做 `normalize_fullwidth_parens`——全角 `（）`→半角 `()`（OCR 原文同页混用 `（1）`/`(1)` 导致题号括号展示不一致）。1:1 字符替换不改长度（图片 `position_in_text` 偏移仍有效）；NFKC 对两者等价（`content_hash` 去重不受影响）。**其余全角标点（。，；！？）不动**：`。` U+3002 无 NFKC 映射会改变 content_hash；`。！？；` 是 card_splitter 的句末切分点，归一半角会破坏长段落切分。
- **断点续传**：跳过的页从其 jsonl 末条 lesson_id 回填 `book_lesson`（`_last_lesson_id`）。
- `--file` 单页不携带跨页状态（续页 card 的 lesson_id 可能为 null）。

### extract（试卷 question）
- **答案只提取不生成**：从原文"参考答案"按题号提取（选择题填字母、填空填值、解答题填解题过程）；原文无答案填 `""`。**绝不自行推断/计算**（模型答案不可靠，系统另有获取答案机制）。
- **按题号切分**：同一题号的 (1)(2)(3) 小问合并为一个 item，不拆分。
- **答案对齐是纯 Python 状态机**（`question_splitter.split_page`），LLM 只标注元数据、不碰答案。
- **题号正则支持全角句点/冒号**（2026-10-28）：`[.．]` / `[:：]`。语文参考答案段写作 `1．C（2 分）`（全角 `．`），修复前整段不被识别 → 答案丢弃或串题（2025 海淀语文卷题1 曾把作文扣分说明当成答案入库）。
- **答案段题号必须递增**（2026-10-28）：回退编号当作当前答案续行。语文作文评分细则常写 `1．字数不足600字…`，若不设守卫会串到第 1 题。
- **同节材料归属**（2026-10-28，策略 `material_policy().attach`，仅语文启用）：语文阅读材料写在题号**之前**（材料一/二/三、两封信、文章原文），切分器按「大题标题 / （一）（二）子标题 / markdown 小标题 / 材料N」分段，把本节材料挂到**本节每道题**的 `material_text`（含图片引用）。不归属时材料被吞进上一题题干、题面缺材料只能靠 LLM 重写（实测 19/27 题触发）。
- **行内粘连标题**（2026-10-28）：OCR 会把下一节标题并在上一题题干末尾（`…（100 字左右）四、现代文阅读（共 23分）`）。切分器拆出标题、本题留在原分组、后续题归新分组，并关闭本题（否则后续材料被吞）。
- **选择题选项边界**（2026-10-28）：语文卷选项紧贴标点无空格（`…的一项是(2分)A.呼之欲出 B.…`）。裸字母标记的前导边界从「空白」放宽为「非英文/数字」，能拆 4 个选项的题确定性校正为 `choice`（LLM 偶发误标 short_answer）。
- **标注失败不丢题**（2026-10-28）：LLM 网关抖动会随机挂 1 题；失败时用确定性兜底（题型按选项判定、难度 2、知识点空、不做修复），日志记 `label_failed_fallback`，不再整题跳过（曾导致重载后试卷少题）。
- **Python 已拆出完整选项时的冲突处理**（2026-10-28 首版，2026-10-29 修订）：LLM 要**重写** options 且与 Python 拆分不一致 → 拒绝（防丢内容/编造），第 3 次走「只标注」：强制 `is_complete=true`、丢弃 `regenerated`，只取 type/difficulty/知识点。LLM **只判 false、不重写** 时按缺陷类型分流（`_defect_kind`）：提到材料/画线/图片/题干截断等 → 接受 false（真缺陷，标待复核）；只提选项或说不出缺陷 → 视为误判，以 Python 为准。此前一律当作冲突，会把真实的材料缺失用「只标注」抹成完整题。LLM 调用失败日志带 HTTP 状态与 message。
- **标注提示词按学科拆**（2026-10-29）：`prompts/question_labeler/` = `_common.txt`（JSON 契约/字段/知识点约束，唯一真源）+ `chinese/math/english/physics/chemistry/politics.txt`，未配置学科回退 `_generic.txt`。九科共用一份提示词时，模型只能按数学标准处理语文：语文 3 选项被判「不足 4 个」、画线句/链接材料丢失被判「可修复」后编造。学科文件负责「什么叫完整、哪些缺陷可修复、题型映射、难度分层」。
- **原文缺失型缺陷只报告不修复**（2026-10-29）：语文/道法/史地生（`_UNREPAIRED_OK`）的 `is_complete=false` **允许 `regenerated=null`**——画线句指向、加点字、图片内文字、未随卷给出的链接材料/时政原文，任何补全都是编造。这类题以原文入库 + `needs_review=true`（`is_active=0`，不进抽题池），不再重试三次后走「知识点为空」的确定性兜底。数学/物理/化学的缺选项、缺单位仍有上下文残片可依，仍要求修复后才通过。
- **语文拆选项/材料按学科处理**（2026-10-28）：`split_options(subject="chinese")` 支持 3-6 项、`【甲】【乙】【丙】`、`①②③`，label 归一为 A/B/C 并保留 `original_label`（参考答案写「乙」时映射为 B）；两题之间的「文段标题 + 长段落」（如「流光溢彩」）归下一题 `material_text`，不再被上一题正文吞掉。数学仍要求 A-D 四项，行为不变。
- **AI 修复题默认待复核**（2026-10-28）：`is_complete=false`（LLM 补过选项/材料）在 extract 打 `needs_review=true`，db_loader 入库置 `is_active=0` → 不进抽题池（抽题 SQL 过滤 `is_active=1`），人工看 `labeling_issues.jsonl` 后手动置 1。原因：实测会编造原文没有的内容（大兴题12 补出「D.三人都正确」、大兴题5 编了两句【甲】【乙】、房山题25 补出「D.…放弃奋斗」）。存量库用 `python mark_needs_review.py --apply` 回刷（幂等）。
- **占位文本防线**（2026-10-28）：LLM 修复产出的 `【注：此处应填入…】`/`待补充` 一类占位说明不得入库，命中即回退原始切分内容。
- 无题号/答案的表格（如作文评分标准表）整表并入当前题答案，不丢弃。
- **JSON 兼容**：`extract.py` 的 `_parse_json_object` 去除 ```` ```json ```` 代码块 + 修复 LaTeX 反斜杠漏转义（`\_`/`\%` 等非法转义补双反斜杠），保留合法 `\n`/`\t`/`\uXXXX`。
- 跳过 `content` 为 null/空的 item（纯图片片段偶发 null，避免整页失败）。

### publish
- 物化图片到 `output/assets/`，路径改写为源相对稳定键（`questions/{subject}/{hash}/{idx}`、`textbooks/{subject}/{hash}/{sort_order}`），填 `content_metadata.images[]` / `options[].image_url`。
- **subject 按素材路径首段推导**（`subject_codes.subject_code_for_path`）：`数学/`->math、`语文/`->chinese、`化学/`->chemistry。映射表唯一维护在 `src/subject_codes.py`（publish / extract / 答案提取共用），识别不出时回退 `math`（历史兼容）。

### 答案提取（按学科策略分派，2026-10-28 起；已并入 import_cli 第 5 步）
`import_cli` 的第 5 步会自动完成「试卷 md → 答案文档 → questions.answer」：逐卷查 `exam_papers.source_key` 拿 paper_id，**默认 `--where answer_empty` 只补空答案**，`--re-answer` 才覆盖；没有「参考答案」段的卷跳过并打印原因。下面两段式仍保留，用于单独重跑或人工修正：

1. `src/answer_extract_cli.py --file <相对路径子串>`：定位唯一的试卷 md → 按路径首段识别学科（`subject_codes.subject_code_for_path`）→ 调 `get_strategy(subject).extract_answers` → 输出 `answer_doc` 规范文档（`# 试卷：<标题>` / `## 题号` / `答案：` / `解析：`）+ `output/answer_issues.jsonl`。
2. `src/answer_importer_cli.py --doc <文档> --paper-id <id> [--apply]`：按 `(paper_id, question_no)` 回写，语义=缺省不改/非空覆盖/空串不改/幂等/写 `answer_verified=1`。

分派结构（`src/subject_strategies/`，2026-10-30 起）：`chinese.py` 独立实现，`math/physics/chemistry` 继承 `generic.py` 的默认答案提取（复用 `split_page`，与主管线一致），`english.py` 直接用同一份 generic 实现。新增学科时在策略文件里实现 `extract_answers` 并 `register()`，未登记学科抛 `UnknownStrategyError`（不静默回退 generic；`politics` 等尚无策略）。

语文答案提取五步：答案段分离 → 标点归一（仅解析，1:1 映射，不回写文本）→ 题号对齐（递增守卫）→ 评分说明拆到「解析」列（纯分值 `（2 分）` 只剥末尾；`（共 2分。…给分）` 全文剥）→ 校验（空答案留空 + issue）。

⚠️ 归一化不要映射「、」：它是中文大题序号分隔符（`三、名著阅读`），归一后 `is_group_header` 失效，大题标题会混进上一题答案。

### 知识点（KP）标定（2026-10-28 起支持语文）
抽题 SQL 必须 JOIN `question_knowledge_points`，**题目不标知识点就永远抽不到**（只能从试卷入口看到）。

- **语文 KP 树**：`tools/db/migrations/2026-10-28_add_chinese_knowledge_points.sql`（幂等，可重跑）。两级 33 条（1 级 4 + 2 级 29），code 前缀 `C`（数学为 `M`），`grade_band='junior'`：

| 一级 | 二级 |
|---|---|
| 积累与运用 | 字词（字音字形）、词语与成语、标点符号、病句辨析与修改、书法、对联、修辞与语言运用、句子衔接与补写、文学文化常识、名著阅读 |
| 古诗文 | 古诗文默写、古诗理解与鉴赏、文言实词与虚词、文言断句与翻译、古文内容理解 |
| 现代文阅读 | 内容概括与信息筛选、词句理解与赏析、人物形象（人物特点）、中心思想与主旨、表达方式、写作手法（表现手法与结构）、说明方法与说明文阅读、论证方法与议论文阅读、开放性探究与迁移 |
| 写作 | 命题作文、半命题作文、材料作文、话题作文、应用文写作 |

- **标定命令**：`python src/backfill_question_kps.py --subject chinese`（默认 math）。提示词按学科取 `prompts/question_kps/<subject>.txt`（公共契约 `_common.txt`，未配置学科回退 `_generic.txt`）；此前只有数学/语文两版，其它学科会用「初中数学老师」的角色标 KP。幂等，只处理无 qkp 的题。
- **作文题不标 KP**（2026-10-28 用户裁决）：作文题的 `answer` 是评分参考而非可判答案，标了 KP 就会被专项练习抽到。导入含作文的卷后，需把作文题从 `question_knowledge_points` 移除（本卷题27 已移）。当前无字段区分作文，后续要么加题型（如 `essay`），要么在导入脚本里按卷末大题排除。
- **LLM 标注需人工抽检**：2026-10-28 实测 27 题中有 3 题偏差（文言人物理解被标成现代文「人物形象」、文言填空被标成「古诗文默写」、二选一作文漏「半命题作文」），已人工校正。抽检维度：文言/古诗题不该出现现代文考点；作文题按命题/半命题/材料归类。

### db_loader
- **subject 归一**：`SUBJECT_ALIASES`（`chem`->`chemistry` 等）-> canonical code -> subjects.id。cards 按 rel_path 学科名查、questions 按 jsonl subject_id 查。
- **rel_path 解析**（cards）：`学科/学段/版本/年级/学期/书名` -> textbook_versions + semesters（find-or-create，幂等）。
- **版次（edition）维度**（2026-08-31 加）：textbook_versions 按 `(subject_id, publisher, grade_band, edition)` 4 元组唯一；edition 从**书名前导括号**提取（`edition_from_book_name`，如「（根据2022年版课程标准修订）义务教育教科书·数学九年级上册」->「根据2022年版课程标准修订」，无标记 = 旧版 2012 课标）。同一出版社不同课标版次是各自独立的 textbook_version/semesters/cards，互不覆盖；九上/九下书名不同但前导括号相同 -> 归同一版次。存量 2012 行 edition='' 与旧书名推导兼容，无需迁移数据（仅 DDL 迁移 `2026-08-31_add_textbook_versions_edition.sql`）。
- **lesson_id 解析**：`第N章 X`（中文数字转 int）-> unit + 章综述 lesson；`N.M[.K] X` -> unit + 节 lesson。find-or-create。
- **页码锚定 lesson_anchor**（2026-09-02 加）：TOC 模式挂卡前 `load_book_cards` 用 `LessonAnchor` 确定性修正章归属——章边界首选综述卡锚定（每章「第N章」标签卡最小 md 页 = 章头页，零偏移误差、取 min 免疫错章综述标签；兜底首节 printed + 偏移众数 − 3 余量）；规则 A 错章重写（content「复习题 N」> 时间线活跃节 > 标题匹配 > 章综述兜底）/ B 同名消歧（「小结」「数学活动」按页所在章，修各章同名 lesson 全挂第一个的 bug）/ C 复习题归一（「复习题 N」挂该章「小结」，不建 TOC 外 lesson）。无 TOC/对不上整体退化纯标签匹配。extract/publish/jsonl 不动；锚定每次 load 重算，重处理任意页不影响结构。观测日志 `[anchor] offset/corrected/disambiguated/normalized`。
- **cards sort_order 跨页全局重排**：每 lesson 内 1..N（抽取的页内序会碰撞 `uniq_cards_lesson_sort`）。
- **范围过滤（2026-10-28，P0）**：`--subject <code或中文名>` / `--file <路径子串>` / `--questions-only` / `--cards-only`。默认扫全库会让「导入语文」顺带重载数学教材卡；加过滤后**只碰指定范围**。范围过滤只能配 `--load-cards`（full-reload 会删全库，CLI 直接拒绝）。
- **卡片增量 upsert（2026-10-28，P1）**：无 TOC 动态建结构分支改为按唯一键 `(lesson_id, sort_order)` **原地 upsert**——`id` 不变、内容不变则跳过、只有变化行才 UPDATE。不再「删旧卡重插」（那会换 id，`practice_results.card_id` 是 CASCADE、`ai_dialogues.card_id` 会被置 NULL）。输出 `新增/更新/未变` 统计；published 少页导致的陈旧行只告警不删除（防误删未参与本次导入的数据）。
- **题目同卷原址更新（2026-10-28，P1）**：带试卷上下文入库时按 `(paper_id, question_no)` 定位旧题原址更新。重抽会让 `content_hash` 变化，只按 hash 去重会插出重复题；`answer_verified=1` 的题**不覆盖**（人工核验优先），新内容与已有题撞 hash 时也保留原题并告警。
- **full-reload 幂等**：`reset_cards()` 删 `textbook_versions`（级联清 cards/lessons/units/semesters）+ `reset_questions()` 删 questions，再重插。结构 find-or-create。每次跑都全量重载（无增量）。
- **full-reload 守卫**：`business_data_summary` 额外把 `questions.answer_verified=1`（answer_importer 写入的人工/AI 核验内容）计入 blocking——未加 `--purge-business-data` 时 full-reload 会中止而非静默丢弃；确认要丢弃再显式 purge。

### DB
- `ai_k12` 库，业务用户 `ai_k12/ai_k12`（`.env` 的 `DB_*`）。
- `schema.sql` 末尾 `INSERT IGNORE` seed subjects（9 个 K12 学科），由 `install_mysql.sh` 加载。详见数据库设计文档 §3.12。
- ⚠️ `install_mysql.sh` 的 `CREATE USER IF NOT EXISTS` 不重置密码（重跑脚本时 ai_k12 密码不会更新，需手动 ALTER）。

### 辅轨答疑与 data-refinery 的关系（PRD §6.2/§7.10）
- **data-refinery 逻辑不变**：convert+extract 继续做离线教材/试卷管线，不参与辅轨答疑。
- **辅轨图片转换**：apps/server（Node.js）直接 `child_process.spawn('mineru-open-api', ['extract', img, '-o', outDir])` 调 MinerU CLI（`convert.py:12` 的 `MineruRunner` 即此 CLI 的 Python subprocess 封装），拿到 md 文档+图片后交 ai-core 在线 LLM 结构化。不经 Python data-refinery，无需在 apps/server 部署 Python 运行时。
- **题目结构化**：辅轨答疑的 题干/题型/知识点/难度/答案+解析 由 ai-core 调 LLM 在线完成（新 prompt，**不用 data-refinery 的 extract**--extract prompt 要求"答案只提取不生成"，辅轨题无答案需 LLM 生成）。
- **题目入库去重（content_hash）**：
  - `schema.sql` questions 表新增 `content_hash CHAR(64)` + `uniq_q_content_hash` 唯一索引。
  - `db_loader.load_questions` 改造：插入前算 `content_hash`（`normalize_content` NFKC 归一 + 去空白 + 转小写 -> SHA-256），`SELECT id FROM questions WHERE content_hash=%s` 命中则跳过复用，未命中则插入含 hash。辅轨答疑入库走同一去重逻辑。
  - **回填现有 466 题**：因 full-reload 先 DELETE 再全插，重建 DB 后重跑 `refinery_cli` 即可给所有题写入 content_hash，无需单独回填脚本。
  - hash 精确匹配为主，未命中时辅以限制范围（同学科+题型）文本相似度兜底（辅轨入库侧实现）。

## 4. 如何运行

```bash
cd tools/data-refinery

# 一次性：初始化 DB（建库+用户+schema+seed）
./../db/install_mysql.sh -r <root_pass> -t 9.5.0 -p ai_k12

# 前段（单独跑）
python src/convert_cli.py --source all          # 素材 -> md
python src/extract_cli.py --source all          # md -> extracted
python src/extract_cli.py --file "2024/...西城-模拟二-试卷"  # 单文件
python src/extract_cli.py --subject 语文 --year 2025 --dry-run  # 统一范围参数（各阶段同义）
python src/publish_cli.py --subject 语文 --dry-run              # 同上；配合 --book 更细

# 一键导入（convert → extract → publish → 入库 → 答案回填，增量）
python src/import_cli.py --subject 语文 --year 2025 --dry-run
python src/import_cli.py --subject 语文 --year 2025
python src/import_cli.py --file "202507-海淀-模拟二-试卷" --re-extract --re-publish
python src/import_cli.py --subject 语文 --skip-answers        # 只到入库，不回填答案
python src/import_cli.py --subject 语文 --re-answer           # 覆盖已有答案（默认只补空）

# 后段（一键）
python src/refinery_cli.py --source all         # publish + db_loader
python src/refinery_cli.py --source all --dry-run
python src/refinery_cli.py --skip-publish       # 只 db_loader
python src/refinery_cli.py --skip-load          # 只 publish

# 增量入库（只动指定范围，推荐用于单科/单卷）
python src/db_loader_cli.py --load-cards --subject 语文 --questions-only          # 只导语文题
python src/db_loader_cli.py --load-cards --subject 语文 --questions-only --dry-run # 先看范围
python src/db_loader_cli.py --load-cards --file "202507-海淀-模拟二-试卷"          # 只导单卷/单书
python src/db_loader_cli.py --load-cards --subject 数学 --cards-only              # 只导数学教材卡

# 答案回填已并入 import_cli 第 5 步；需要单独重跑/人工修正时仍可两段式：
python src/answer_extract_cli.py --file "语文/初中/second/2025/语文-初三(下)-202507-海淀-模拟二-试卷" --dry-run
python src/answer_extract_cli.py --file "<同上>"            # -> output/answers/<卷名>.md
python src/answer_importer_cli.py --doc output/answers/<卷名>.md --paper-id 17          # dry-run 看 diff
echo yes | python src/answer_importer_cli.py --doc output/answers/<卷名>.md --paper-id 17 --apply

# 测试
pytest tests/ -q                                # 1175 passed, 10 skipped
```

## 5. 测试

`tools/data-refinery/tests/`，1175 个测试全绿（10 个集成/网络测试默认 skip）：
- 单元：extract 解析/escape 修复、db_loader 纯函数（subject 归一、rel_path 解析、中文数字、lesson_id 解析、sort_order 重排）、CLI dry-run/过滤、语文答案 case（全角题号/评分说明拆分/空答案不猜）、答案文档渲染与 `parse_answer_doc` 衔接。
- 集成：db_loader 连真实 ai_k12 库（find-or-create、入库、幂等），每个测试前后清派生表。

## 6. 已知遗留（按优先级）

1. **`install_mysql.sh` CREATE USER 不重置密码**--小修（改 `CREATE OR REPLACE USER`）。
2. **题目数据质量**：466 题里多数是 gemma 旧提示词抽的（答案有捏造、解答题被拆分），需用新提示词 + deepseek 重抽，再 `refinery_cli` 重跑（full-reload 幂等）。
3. **教材 card 覆盖不全**：只有下册 16 页（34 cards），整本下册 50 页 + 上册 + 其它学科教材未抽。
4. **增量加载**：db_loader 用 full-reload，无 checkpoint 增量。
5. **资产静态服务**：开发期用 `python -m http.server` 临时方案，生产需 CDN/OSS（`ASSET_BASE_URL`）。
6. **`questions.content` 字面 `\n` 双转义未还原**（2026-09-04 发现）--LLM 输出 JSON 时把换行写成 `\\n`（双反斜杠+n），`json.loads` 解析后变成**字面 `\n` 两字符**（0x5C 0x6E，反斜杠+n），而非真换行 0x0A。`extract.py:_repair_json_escapes` 把 `\\` 当合法 JSON 转义跳过，没修正，字面 `\n` 一路进 DB。`react-markdown` 不认字面 `\n`（CommonMark 反斜杠转义只对 ASCII 标点生效），原样显示成可见文本。**MVP 阶段前端兼容处理**：`QuestionRunner`/`ChoiceOptionList` 的 `preprocessMarkdown` 把 `\n`（后非字母）还原成真换行，避开 LaTeX 命令（`\ne` `\newline` `\nonumber` `\nabla` `\neg` `\nu` 等）。将来在管线层统一修复（`_repair_json_escapes` 增加 `\\n` → `\n` 的规范化，或 LLM 提示词强调换行用真 0x0A），改完撤掉前端的 `preprocessMarkdown` 兼容层。
7. **题目内容缺口**：`answer_importer`（2026-09-10）已建成，可按单题/批量/按卷/按缺口回写 `answer`/`approach`（新增解题思路列）/`explanation`/`type`。存量约 188 道空答案、451 道无解析待按卷（或按 `--where ..._empty` 导出模板）补全；用法见 `docs/data-refinery-使用手册.md` §4.8，设计见 `docs/superpowers/specs/2026-09-10-question-content-importer-design.md`。
8. ~~**`db_loader --load-cards` 全量重载撞 `uniq_cards_lesson_sort`**~~ **已修（2026-10-28）**：非 TOC 分支改原地 upsert + CLI 范围过滤。注意 `--questions-only`/`--subject` 等过滤必须配合 `--load-cards`（full-reload 会删全库，CLI 直接拒绝）。

## 7. 下一步（最大缺口）

**后端 API（`apps/server`）**--若从零起步时的结论；当前 `apps/server` 已实现（ai-core + HTTP API），此节仅保留历史背景，实际待办以 §6 清单为准。

建议顺序：先做小修（§6 的 1），再处理数据重抽（2、3）可后台并行。

---

## 8. 旁路管线：语文古诗文默写（2026-09-14 新增）

四阶段主管线（convert → extract → publish → db_loader）服务的是**数学/化学教材卡片与试卷
题目**（语文试卷题 2026-10-28 起也走同一主管线，答案补录走独立的 `answer_extract_cli` 支线），
产物进 `textbook_cards` / `questions`。语文默写是**另一条独立旁路**，产物进
`chinese_passages`（2026-09-15 独立化改名，原名 `dictation_passages`、已摘除 `question_id`）——
它刻意不接进四阶段，避免动到主链路的表结构与幂等语义。

### 为什么独立

- 目标不同：主管线抽「卡片/题目」，这条抽「**整篇古诗文正文**」（学生要逐字默写，
  错一个字就判错，故对正文准确性的要求比卡片高得多）。
- 产物不同：`chinese_passages` 是篇目级结构（篇名/作者/朝代/正文/册次/必背标志），
  与 `questions` 的题面/答案语义不重合（详见 `docs/superpowers/specs/2026-09-13-chinese-dictation-special-design.md` §4.1.1 的「为什么另建表」；2026-09-15 起进一步**完全不挂 `questions`**，见
  `docs/superpowers/specs/2026-09-15-chinese-interpretation-special-design.md` §2）。
- 复用但不动：前 3 步直接用现成 CLI（`crawler_cli` / `convert_cli` / `toc_parse_cli`），
  后 3 步是本管线新建。

### 三段复用 + 三段新建

| 步骤 | 命令 | 说明 |
|---|---|---|
| 1. 爬 | `cd tools/crawler && python src/crawler_cli.py --site smartedu --subject 语文 --publisher 统编版 --level 初中 --grade 九年级 --semester 下册` | 复用 |
| 2. 转 | `cd tools/data-refinery && python src/convert_cli.py --source smartedu --subject 语文 --term 下册` | 复用（MinerU） |
| 3. 目录 | `python src/toc_parse_cli.py --source smartedu --subject 语文 --publisher 统编版 --grade 九下` | 复用（产物即候选清单） |
| 4. 抽取 | `python src/dictation_cli.py --extract --book "九年级/上册" --term 上册` | **新建** |
| 5. 入库 | `python src/dictation_cli.py --load --book "九年级/上册" --term 上册` | **新建** |
| 6. 串联 | `python src/dictation_cli.py --all --book "九年级/上册" --term 上册` | **新建** |

产物落在 `output/dictation/语文/<册次>/`：`<书名>.jsonl`（入库候选）、
`<书名>-review.md`（人工过目清单 + 定位留痕 + 已纠正篇目）、`<书名>-unresolved.md`（待人工处理）。

### 分工（用户 2026-09-14 裁决后定型，改代码前必读）

| 环节 | 谁做 |
|---|---|
| 哪些篇目、在第几页 | **程序**（目录 + 印刷页偏移） |
| 正文起止 | **程序**（`dictation_locate` 版面规则） |
| 尾部编者赏析 / 词前小序 | **程序**（`trim_to_form` 按格律切） |
| 作者 / 朝代 / 体裁 | **LLM**（`ask_identity`，每次只问一个篇名） |
| 正文纠正 | **LLM**（`dictation_repair`，本地优先、ds flash 兜底） |
| 通过与否 | **程序**（`dictation_check` 纯程序自检，含词牌格律） |

> **曾走过的弯路（别再回去）**：最初让 LLM 返回「正文首末句锚点」、且**一次调用喂一整个
> 单元**（第六单元 30 页 1.45 万字、一次找 13 篇）。因为 `llm.py` 不传 `temperature`，
> 同代码同输入连跑 3 次得 **23 / 22 / 20 篇**，每次漏的还不一样。改为纯程序定位后实测
> **24/24 篇、0 未解决、连跑两次完全一致**。详见 spec §5.2/§5.3。

### 实测结论（九上，170 页）

- 24 篇全部入库，偏移众数可靠（+7）。
- 《沁园春·雪》的正文在教材里被**写作背景与课后思考题逐行插花**、还跨页拆开——
  **任何连续子串都取不到正确的词**。它由「词牌格律判错 → 交模型重写」这条通道修好
  （376 字错稿 → 139 字正确的词）。这是「程序切不出来」的确定性出口，见 spec §6.1。
- 入库的篇目一律 `verified=1`、`memorize_required=0`——**必背标定留给后续人工步骤**，
  故此时抽题池里仍只有开发假数据（门禁生效的证据）。

### 后续（不在本次）

- **必背标定**：读教材课后背诵要求标 `memorize_required=1`（含人工确认）。
- **古诗文解释专项**：需要本管线丢弃的教材注释（图片留在本地，重跑第 2–5 步即可）。
- **开发假数据清理**：真篇目必背标定完成后清理两篇 `DEV-FIXTURE`。


---

## 语文试卷着重号/下划线（2026-10-28 落库回填 / 2026-10-29 前置到切题后）

MinerU 的 Markdown 没有下划线语义，着重号也只能偶尔识别成 `<sub>．．</sub>`，导致「文段中加点词语」「画横线句」类题目丢指令。

**现行做法（2026-10-29 起）**：`question_extract` 在 `split_page` 之后、**标注之前**调 `_pdf_decorations` + `_apply_emphasis`，把标记直接注入 `RawQuestion.content/material_text`。顺序不能反——模型标注时看不到标记，就会把「画线句」判成原文缺失（东直门 2024 题2/4/7/11/20/24）。扫描件无文字层，检测为空，日志打 `[emphasis] … 无文字层或未检出标记（扫描件），跳过`。

**存量回填**（入库后补，仍可用）：

```bash
cd tools/data-refinery/src
python emphasis_cli.py --paper-id 17          # 预演：检测 + 打印将变化的题
python emphasis_cli.py --paper-id 17 --apply  # 备份完整行 → 只改展示字段
python emphasis_cli.py --all-chinese          # 全部语文卷预演（--apply 需 --yes）
```

- 检测实现在 `pdf_emphasis.py`：下划线取 PDF 细矩形；着重号取字符下方 3pt 窄带内的小墨点（4x 灰度渲染 + 连通域），排除表格区域（`page.find_tables()`）。
- 输出 `<u>…</u>` / **逐字** `<span class="cn-emphasis-dot">字</span>`；前端 `global.css` 用 `::after` 画 0.15em 纯黑字下点，下划线 2px 深色（视觉反馈：点要更精更黑、线要更重）。
- 匹配用上下文唯一性（8→2 字）；选项按 `A./B．` 行 + 纯汉字上下文；题干只做 `<sub>` 归一化，不套标注。步骤幂等（`decorate_text` 见 `already_marked` 跳过），extract 与 emphasis_cli 都跑不会重复插标签。
- 安全：`emphasis_cli` 默认 dry-run、幂等；只 UPDATE `content/material_text/options/content_hash`，写后逐列校验其它列未变；备份在 `tools/db/backups/`。
- 适用范围：**电子版（有文字层）PDF**（实测大兴 36 处、五中 14 处）；纯扫描件 0 命中，需 OCR 字符框 + 图像层横线检测或视觉模型，本期不做，这类题一律 `needs_review`。
