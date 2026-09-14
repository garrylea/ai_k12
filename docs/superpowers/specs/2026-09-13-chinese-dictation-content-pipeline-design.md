# 九年级语文课本 → 默写题库数据管线

- 日期：2026-09-13
- 状态：设计已与用户逐节确认
- 关联文档：`docs/superpowers/specs/2026-09-13-chinese-dictation-special-design.md`（默写专项功能设计，本管线是它 §6「内容管线」的落地）、`docs/data-refinery-管线总结与后续.md`、`docs/data-refinery-使用手册.md`、`docs/superpowers/specs/2026-09-02-math-training-module-design.md`

## 1. 背景与问题

默写专项的前后端链路已实现并合并（三端点、纯程序判题、错因能力、前端三页），但**题库里只有两篇开发假数据**（`source_ref='DEV-FIXTURE'` 的《静夜思》《登鹳雀楼》），真实内容覆盖为零——学生实际练不到东西。

本文设计把**统编版九年级上/下册教材里的全部古诗文与文言文**抽成结构化篇目入库的离线管线。

## 2. 目标与非目标

**目标**

1. 用现有爬虫抓取统编版九年级上/下册语文教材（逐页 JPEG）；
2. 用现有 `convert_cli` 转成每页一个 Markdown（**不改动该工具**）；
3. 从教材目录解析出全部课文候选；
4. 判定其中哪些是古诗文/文言文，定位每篇的正文起止，原样切片入库（篇名/作者/朝代/正文 + 册次/页码）；
5. 通过自动自检 + 人工过目清单守住「正文逐字准确」。

**非目标**

- **不抽注释**（为后续「古诗文解释」专项留待那时再抽；页面图片留在本地，重跑只花转换时间，不需重爬）；
- **本次不判必背**：全量入库时一律置「非必背」，由用户后续标定；
- 不做后台管理界面（必背的日常维护后续再议）；
- 不改动 `convert_cli` / `extract_cli` / `publish_cli` / `db_loader_cli` 的既有行为，避免波及数学管线。

## 3. 关键决策

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 收录范围 | 九年级上/下册教材里**全部古诗文与文言文**（含各单元课文与「课外古诗词诵读」），不预先筛必背 |
| 2 | 教材版本 | 已在功能设计阶段闸门确认：**统编版 · 初中（六三制） · 九年级上/下册**，共 2 本 |
| 3 | 正文来源 | 教材（权威源）。爬取参数 `--subject 语文 --publisher 统编版 --level 初中 --grade 九年级 --semester 上册`（下册同理；`--level 初中` 精确匹配以排除「初中（五•四学制）」副本） |
| 4 | 正文抽取方式 | **LLM 只定位、程序按锚点原样切片**（详见 §5）——LLM 不产出正文字符 |
| 5 | 注释 | 切出去即丢弃，本次不入库 |
| 6 | 必背标志 | 新增 `dictation_passages.memorize_required`；本次全量置 0 |
| 7 | 过渡期 | 既有两篇开发假数据**保留 `memorize_required=1`**，保证管线落地后专项仍能抽到题练手；用户标完真篇目必背后再清理假数据 |
| 8 | 抽题池 | 由 `verified=1` 改为 **`verified=1 AND memorize_required=1`** |

## 4. 管线总览

| 步 | 做什么 | 复用 / 新建 |
|---|---|---|
| 1 爬取 | 抓九上/九下逐页 JPEG → `tools/crawler/data/语文/初中/统编版/九年级/上册/<书名>/page_NNN.jpg` | 复用 `crawler_cli --site smartedu` |
| 2 转换 | 图 → MD。**MinerU 每个输入文件产出一个 MD**，教材是逐页图片，故产物是 `page_001.md`、`page_002.md`…（页码在文件名，正文无页眉页脚） | 复用 `convert_cli --source smartedu`（**不动代码**） |
| 3 目录候选 | 目录页 → 单元/课文结构 JSON | 复用 `toc_parse_cli` + `toc_merge` |
| 4 定位与分类 | 判定候选里哪些是古诗文/文言文，给出正文起止锚点与作者/朝代 | **新建**（LLM 只做判断） |
| 5 切片 | 按锚点从 MD **原样**切正文，剥运行页眉 | **新建**（复用 `page_chrome`） |
| 6 入库 | 写 `questions` + `dictation_passages` | **新建 importer**（复用仓储） |

**产物**：`tools/data-refinery/output/dictation/语文/初中/统编版/九年级/<册>/` 下的 JSONL（篇目清单）+ 人工过目清单 Markdown + 待人工处理报告。

**第 3 步是中途闸门**：目录候选清单先给用户过目确认「哪些篇目在范围内」，再进入第 4 步。

## 5. 第 4/5 步设计（本文的技术核心）

### 5.1 候选来源

`toc_parse_cli` 输出的 JSON 结构为：

```json
{ "book": "...", "chapters": [ { "number": 3, "title": "...", "label": "第三单元 ...",
  "sections": [ { "number": [3,1], "title": "...", "label": "10 岳阳楼记", "printed_page": 46 } ],
  "supplements": [ { "type": "supplement", "label": "课外古诗词诵读", "printed_page": 60 } ] } ] }
```

候选 = 全部 `sections` + `supplements`。**单元标题（`chapters[].label`）是强信号**——部编版教材把古诗文集中在专门单元（如「第三单元 古诗文」），据此可先粗分。

**印刷页 → MD 页序的偏移**必须显式推导并校验，不能假设二者相等：取 TOC 中若干已知 `sections[].printed_page` 与其 `label` 在 MD 里实际出现的页序做比对，取偏移众数（与既有 `lesson_anchor` 的「偏移众数 + 余量」思路一致）。**若偏移不可靠**（众数不集中 / 样本不足），退化为**整书滑窗扫描**：按固定页窗（如 8 页）让 LLM 找篇目，TOC 此时仅用于完整性核对（目录里列了但滑窗没找到的，进待人工处理报告）。

### 5.2 LLM 的职责边界（只做判断，不产出正文）

**每单元一次调用**（不是每篇一次）：输入该单元涉及的若干页 MD 文本，输出每个候选的：

- `is_classical`：是不是古诗文/文言文（排除现代诗与现代文，**注意毛泽东《沁园春·雪》这类现代词牌作品属现代诗，不收**）
- `work_title`：篇名
- `author` / `dynasty`：作者与朝代（教材注释里有则在，缺失留空）
- `body_start_anchor`：正文起始锚点（正文首句前若干字，用于程序定位）
- `annotation_start_anchor`：注释起始锚点（若该篇无注释则给正文结束锚点）

**LLM 不输出正文内容本身**。正文由第 5 步按锚点从 MD 中切出。

### 5.3 切片

1. 用 `compute_book_chrome(md_dir)` 算出书级运行页眉集合，再对每页 `strip_chrome(text, chrome)`（均为现成函数，教材页眉正是它的设计目标）；
2. 按 `body_start_anchor` / `annotation_start_anchor` 在页文本中定位，**取两锚点之间的原始字符**作为正文；
3. 跨页的篇目按页序拼接；
4. 规范化：去掉 OCR 插入的换行与多余空格；**保留全部标点与全角符号**（判题时的标点/空格忽略发生在 `normalizeChineseAnswer`，与存储无关——存储保留原文便于展示）；
5. 记录 `source_ref`（书名 + 起止印刷页），供溯源。

## 6. 校验与闸门

「正文错一个字，写对的学生反而被判错」是本管线最贵的失败模式，故设两道闸门。

### 6.1 自动自检（每条必过）

- 正文非空；
- **体裁字数自检**：绝句/律诗按 5 言/7 言 × 句数可判，明显不符即标记（词与文言文只做长度下限）；
- 不含注释体例标记（「注释」「其：」「〔」「〕」等）；
- 不含页眉残留（书名、出版社、「练习」等）；
- 与篇名一致性（正文不得等于或包含篇名本身）。

### 6.2 低频字标记（无法自动消除的风险）

正文含**不在常用字集**的字符 → 标为 `needs_review`，进重点人工复核清单。原因：教材页是扫描图，MinerU OCR 对生僻字可能认错；而文言文里生僻字恰恰不少。**本方案无法自动消除这一风险，如实记录并请人工定向复核。**

### 6.3 结果分流

- 自检通过 → `verified = 1`（且 `memorize_required = 0`，故暂不进抽题池）
- 自检未通过 → 进「待人工处理」报告，`verified = 0`，管线**不阻断**（其余篇目照常入库）

### 6.4 人工过目清单

生成 Markdown 清单：篇名 / 作者 / 朝代 / 正文字数 / 正文首尾各 20 字 / 是否含低频字。用户只需抽看长文言文与低频字标记项。

## 7. 数据模型变更

```sql
ALTER TABLE dictation_passages
  ADD COLUMN memorize_required TINYINT(1) NOT NULL DEFAULT 0
  AFTER verified;
```

- 建表语句需**折回** `tools/db/schema.sql`（`install_mysql.sh` 只执行 `schema.sql`，迁移文件不会自动跑——仓库既有约定）；
- 同时提供 `tools/db/migrations/2026-09-13_add_dictation_memorize_required.sql`（幂等：`information_schema` 判存在再 `ALTER`，沿用上次迁移的写法）供已建库的环境；
- 字段名取 `memorize_required`（不叫 `required`，避免与列约束语义混淆）；
- `DictationPassagesRepository`：`DictationPassageRow` / `DictationUpsertInput` / `SELECT_COLS` 增加该字段；`upsert` 写入该字段；
- **三条抽题查询全部加 `AND dp.memorize_required = 1`**：`findRandomVerified`（随机抽）、`findVerifiedBySubject`（配置页清单）、`findVerifiedByQuestionIds`（按篇目指定）——保证「非必背」篇目在整个语文默写界面都不可见、也不可被指定；
- `findByQuestionId`（判题取篇目）**保持不加门**：这是功能设计阶段已裁决的口径（详见默写功能 spec §6 注记），本次不改变。
- **种子脚本 `apps/server/src/scripts/seed-dictation-fixture.ts` 的两篇假数据需置 `memorize_required=1`**（否则迁移后默认 0，抽题池会空掉、专项立刻不可用——这正是决策 7 要避免的）。配套改动：`DictationPassagesRepository.upsert` 的入参类型与两条 fixture 的 upsert 调用各加一个字段；该脚本的「按业务键定位后原地 UPDATE」逻辑沿用不变。
- **抽题池门禁需有测试钉住**：三条查询各自断言 SQL 含 `dp.memorize_required = 1`（沿用上次「删守卫验证 RED」的做法，证明断言非空洞）。

## 8. 运行方式

新增独立 CLI：`tools/data-refinery/src/dictation_cli.py`。**只服务语文默写，不改动既有管线路径。**

```bash
# 分步（可各自重跑）
python src/dictation_cli.py --crawl   --subject 语文 --grade 九年级 --term 上册
python src/dictation_cli.py --convert --subject 语文 --grade 九年级 --term 上册
python src/dictation_cli.py --toc     --subject 语文 --grade 九年级 --term 上册   # 产出候选清单供人工确认
python src/dictation_cli.py --extract --book "九年级/上册"                        # 定位 + 切片 + 自检 + 出清单
python src/dictation_cli.py --load                                                # 入库
python src/dictation_cli.py --all                                                 # 串起来
```

- 幂等：入库按 `dictation_passages` 业务键 `(work_title, semester)` upsert；`questions` 行的定位沿用种子脚本已采用的「按业务键找已有 `question_id` → 原地 UPDATE」策略（题面模板变化时不会插重复行）；
- 输出目录独立于数学管线（`output/dictation/`），互不干扰。

## 9. 测试与验收

**pytest 单测**（与既有 `tools/data-refinery/tests/` 同风格，网络与 LLM 依赖用例默认 skip）

- 切片：锚点定位、跨页拼接、标点保留、换行/空格规范化；
- 自检：字数不符、含注释标记、含页眉残留、与篇名重复 → 各自被拦下；
- 低频字标记命中与否；
- 入库映射：JSONL → `questions`（`content='请默写《篇名》'`、`answer='作者：…\n朝代：…\n正文：…'`、`type='poem_dictation'`）+ `dictation_passages`（`verified`、`memorize_required=0`）；
- 幂等：同一 JSONL 连续两次入库不产生重复行；
- 迁移：`memorize_required` 幂等添加。

**真库验收**

1. 九上/九下两本的篇目全部入库，人工过目清单无遗留未处理项（或已明确记录）；
2. 抽题池只出 `memorize_required=1` 的篇目——即此时**只有那两篇开发假数据**（验证门禁生效）；把某真篇目手动置 1 后能从抽题池抽到；
3. 数学专项抽题/判题无回归（三条数学查询未受影响）。

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| TOC 对语文目录解析不准（数学是先例，语文未验） | §4 第 3 步设为中途闸门，候选清单先给用户确认 |
| LLM 边界判断错（正文切多/切少） | 自动自检 + 锚点可追溯 + 人工过目长文言文 |
| **OCR 生僻字认错** | 低频字标记 + 定向人工复核；**无法自动消除，如实告知**（本方案唯一不可自动消除的风险） |
| 误判「是不是古诗文」（如现代词牌作品） | 单元上下文 + 候选清单人工过目 |
| `printed_page` 与 MD 页序偏移错位 | 沿用既有 `lesson_anchor` 锚定思路；自检中「与篇名一致性」可兜住明显错位 |
| 与数学管线互相干扰 | 独立 CLI + 独立产物目录；不改既有四阶段工具 |

## 11. 实施顺序

1. **爬取 + 转换**（九上先做一本）→ 肉眼确认 MD 形态与页码边界；
2. **目录候选**（第 3 步闸门）→ 候选清单给用户确认；
3. **定位 + 切片 + 自检**（九上）→ 出人工过目清单；
4. **数据模型变更**（`memorize_required` + 抽题池三处过滤 + 迁移折回）；
5. **入库**（九上）→ 真库验收；
6. **九下** 重复 1–3、5；
7. **收尾**：人工过目清单处理、验收第 2/3 条。

## 12. 后续（本次不做）

- **必背标定**：把教材课后的背诵要求读出来标 `memorize_required=1`（本次只留字段与门禁），或按公开必背清单标定；含必要的后台管理手段；
- **古诗文解释专项**：需要本管线丢弃的「书中注释」，届时按该专项自己的需求重跑第 2–5 步（图片留在本地，不需重爬）；
- **开发假数据清理**：真篇目必背标定完成后，清理两篇 `DEV-FIXTURE`（及其可能产生的错题行）。
