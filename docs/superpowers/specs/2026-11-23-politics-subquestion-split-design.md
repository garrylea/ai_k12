# 道法大题按小问拆题设计（sub_no / material_position）

**日期**：2026-11-23
**状态**：已批准（2026-11-23）；实施计划见 `docs/superpowers/plans/2026-11-23-politics-subquestion-split.md`
**范围**：道法（politics）试卷题；语文 / 数学 / 物理 / 化学本期不动
**试点卷**：2026 北京市第三十五中学 初三 期中（DB paper 862，35 中道法卷）

---

## 1. 背景与目标

道法的大题（26、27、28）是**「一段材料 + 一个小问 + 另一段材料 + 另一个小问」**的结构。现在整道大题被切成一条题：

- `material_text` 只有第一段材料；
- `content` = `(1)…` + 第二段材料 + `(2)…`；
- 两个小问共用一条题的答案、分值、知识点；
- 前端按「`material_url` 在上、`material_text` 在下」渲染，这条题的 12 分材料跑到题干**下面**，顺序是反的。

目标：

1. 道法大题按小问拆成独立题：26(1)、26(2)、27(1)…，每条有自己的材料；分值能解析就带上，解析不到不影响拆分。
2. 每小问的材料放 `material_text`，显示在**题干上方**。
3. 切题规则与语文、物理/化学彻底分开，互不影响。
4. 只重导 35 中；海淀卷（有学生作答与错题）不动。

---

## 2. 非目标

- 不改语文的共享材料体系（`material_policy` + `material_url` 文档 + 题内 `material_text` 在题干下方）。
- 不拆物理/化学的实验探究题（形态相近，本次不动）。
- 不拆语文的作文二选一、文言文多问。
- 不重编整卷题号（26(2) 不会变成第 27 题）。
- 不做道法答案的自动回填（两份道法卷都没有参考答案段；规则先定，不实现抓取）。

---

## 3. 实测现状（2026-11-23）

### 3.1 切题结果

| 卷 | 题 | 当前形态 | 小问 | 分值 |
|---|---|---|---|---|
| 35 中 | 26 | 1 条题 | (1)(2) | 8 + 4 = 12 |
| 35 中 | 27 | 1 条题 | (1)(2)(3) | 6 + 9 + 4 = 19 |
| 35 中 | 28 | 1 条题 | (1)(2)(3) | 6 + 3 + 10 = 19 |
| 汇文 | 25 | 1 条题 | (1)(2) | 6 + 4 = 10 |

实测小问分值之和与题号行写的总分一致（12/19/19/10）。这只是现状观察：**分值不参与能否拆的判定**，读不到就留空，不影响拆分。

### 3.2 26 题的原始切分（问题样例）

```
material_text: （12分）承先之志，启时代新程。
               【活动一】长征铸魂，薪火承志
               …片一 / 片段二…
content:       (1) 结合材料…写一篇国旗下演讲稿…(8 分)
               ## 【活动二】文物载史，回望峥嵘
               …文物1/2/3…
               (2) 请你在以上文物中任意推荐一个文物…(4分)
               +学科观点
```

期望：

- 26(1)：材料 = 12 分导语 + 活动一 + 片一/片段二；正文 = `(1)…(8 分)`；`full_score=8`
- 26(2)：材料 = 活动二 + 文物 1/2/3；正文 = `(2)…(4分)`（`+学科观点` 整行丢弃）；`full_score=4`

### 3.3 库里数据

| 来源 | 题数 | 考试作答 | 错题本 |
|---|---|---|---|
| 2026 北京海淀初三（上）期中道德与法治 | 30 | 90 条（3 个 session） | 22 条 |
| 35中初三上道法期中试卷 | 28 | 28 条（session 862，2026-11-23 07:13） | 0 |

35 中的 28 条是当天验收产生的测试作答，本次清理后重导。海淀不动。

---

## 4. 切题规则（道法独立模块）

新增 `src/subject_strategies/politics_subquestions.py`，由 `PoliticsStrategy` 挂一个可选钩子；`split_page` 末尾按 `getattr` 探测调用，与现有 `attach_pre_material` / `attach_post_material` 同一机制。**内核 `question_splitter.py` 不出现任何学科判断。**

### 4.1 触发条件

一行开头的 `(N)` / `（N）` 是主题号之外的小问标记：

```
MARK_RE = ^[（(]\s*(\d{1,2})\s*[）)]
```

同时满足才拆：

1. 标记编号恰好是 `1,2,…,n`（n ≥ 2，连续、从 1 起、不跳号）；
2. 每个小问都能切出非空正文（见 4.2）；
3. 每个小问的正文都含设问特征（`？` / `?` / `请` / `结合` / `谈谈` / `说明` / `分析` / `写` / `补全` / `推荐` / `认识` 任一），防止把题干里的 `（1）（2）` 枚举误当成小问。

**分值不参与能否拆的判定**：`full_score` 只是展示字段，解析到就写、解析不到写 NULL；分值缺失、读错、之和对不上大题总分，都不影响拆分。

任一条件不满足 → **不拆**，保留整题，打印一行日志，交识别问题扫描/人工复核。不猜。

### 4.2 正文与材料的边界

`content` 里的空行已被切题内核剥掉，不能按空行切。规则按内容判：

1. **正文** = 从 `(N)` 行开始，到该小问的**分值行**（`[（(]\s*\d+\s*分\s*[）)]\s*$`，即分值写在**行尾**；含该行）为止。分值行在这里只用来找准正文结尾，**不是拆分门槛**；找不到就退到第 2 条，仍按结构切。必须行尾匹配，避免题干里的「每小题 2 分」把正文截断。
2. 找不到分值行时，退化为：到该小问之后第一个**材料头**为止（材料头那一行归材料，不归正文；材料头 = `^#{1,6}\s`、`^【`、`^☆`、`^<table`、`^!\[`）。
3. 仍找不到 → 该小问切不出正文，放弃整题拆分（条件 2 不满足）。
4. **材料** = 上一小问正文结束的下一行，到本条 `(N)` 行之前。
   - 第 1 个小问的材料 = `content` 开头到 `(1)` 行之前，包含「（12分）承先之志…」这类大题导语。
   - 最后一个小问之后若还有内容（如 26(2) 的 `+学科观点`），归入最后一个小问的正文（已知平台残留按第 6 条丢弃），不当材料。
5. **无自有材料的指代题**：某小问没有新材料，但正文出现 `结合材料 / 根据材料 / 上述材料 / 结合两个活动 / 依据材料` 等指代 → `material_text` = 本大题此前所有小问材料（含已继承的）按 `\n\n` 拼接。例：28(3)「结合两个活动内容」自身无材料，继承 28(1)+28(2) 的材料，否则单独抽到这道题时学生看不到活动材料。
6. **已知平台残留**：单独一行 `+学科观点` 是扫描件的平台按钮文字，切题时整行丢弃（不影响其它行）；28 题的 OCR 噪声（`做法`、`受: 线矛盾` 等）保留，由人工补题处理，不做启发式清洗。

### 4.3 字段映射

| 输出 | 取值 |
|---|---|
| `group_order` | 原大题题号（26），**不重排整卷** |
| `sub_no` | 1..n |
| `content` | 小问正文（保留 `(1)` 前缀，原文不改） |
| `material_text` | 该小问自己的材料；没有且不指代前文则 `None`（指代时见 4.2 第 5 条） |
| `material_position` | `before`（有材料时） |
| `score` | 该小问的分值，解析到就写；解析不到留 `None`，不影响拆分与入库 |
| `answer` | 见 4.4 |
| `group_id` / `multi_choice` | 沿用原题 |
| `post_material_*` | 清空（道法不走题后材料） |

### 4.4 答案

原题 `answer` 先按同样的 `MARK_RE` 切：

- 切出数量 == 小问数 → 按序号分配（同时按 `MARK_RE` 去掉行首 `(N)`）；
- 否则 → 所有小问 `answer=""`，打印 `[politics] 题N 答案无法按小问拆分，已清空待回填`。

**不允许**把整段答案复制给每个小问（那会让每个小问都判「对」）。

道法两份卷目前没有答案段，本条暂不会触发；规则先定死，避免以后接答案文件时错位。

### 4.5 不拆的判定与日志

以下情况保留整题并打印一行日志（不写库、不阻断导入）：

```
[politics] 题26 小问结构不完整（编号 1,3 / 正文为空），保留整题
[politics] 题26 小问正文缺少设问特征，保留整题
```

分值不在此列：读不到分值、分值之和与题号行写的总分不一致，都照常拆，`full_score` 该空就空。

### 4.6 期望产物（黄金样例）

| 题 | sub_no | full_score | material 首行 | content 首行 |
|---|---|---|---|---|
| 26 | 1 | 8 | `（12分）承先之志，启时代新程。` | `(1) 结合材料…` |
| 26 | 2 | 4 | `## 【活动二】文物载史，回望峥嵘` | `(2) 请你在以上文物中…` |
| 27 | 1 | 6 | `（19 分）2026 年是中国共产党成立 105 周年…` | `(1) 运用所学…补全表格` |
| 27 | 2 | 9 | `【活动二】平陆运河映初心，党的领导惠民生` | `(2) 结合材料…谈谈…密码` |
| 27 | 3 | 4 | `☆ 行动倡议 ☆` | `(3) 请你完成倡议书…` |
| 28 | 1 | 6 | `（19分）某校开展了“奋进新时代”系列活动。` | `(1) 结合材料…` |
| 28 | 2 | 3 | `做法`（(1) 后的 OCR 噪声 + `【活动二】镜头里的新时代`） | `(2) 你拍摄的新时代镜头是什么? …` |
| 28 | 3 | 10 | 无自有材料 → 继承 28(1)+28(2)（正文含「结合两个活动内容」） | `(3) 结合两个活动内容…` |
| 汇文 25 | 1 | 6 | `（10分）阅读材料，回答问题。` | `(1) 结合材料…幸福河` |
| 汇文 25 | 2 | 4 | `<table><tr><td>类别</td>…` | `(2) 结合以上素材，设计…` |

35 中重导后题数：28 − 3 + (2+3+3) = **33**。

表中的 `full_score` 是尽力解析的结果，只用于展示/计分；读不到留 NULL，不触发不拆。

### 4.7 单小问材料题的回退

若一道道法题只有 `(1)` 一个小问（或没有编号，只有末句设问），不做小问拆分，但仍要取出材料：

- 规则与 `material_split.split_tail_question_rule` 相同（「最后一个非空行是设问」），但**实现搬进 `politics_subquestions.py`**，不再从物化模块 import。

这样 `material_split.py` 只服务物理/化学。

---

## 5. 与其它学科的边界

| 学科 | 材料形态 | 是否拆小问 | 材料位置 |
|---|---|---|---|
| 语文 | 跨题共享文章（`material_url` 文档）+ 题内 `material_text` | 否 | 文档在上、题内材料在下（2026-11-21 规则不变） |
| 英语 | 篇章标签 + 竖排选项 | 否 | 同上 |
| 物理 / 化学 | 题内材料 + 题前共享材料 | 否 | 保持现状（`material_position` 为 NULL = 题干下方） |
| 数学 | 无材料 | 否 | 不涉及 |
| **道法** | **每个小问自带材料** | **是** | **`material_position='before'`（题干上方）** |

`politics.py` 删除对 `material_split.py` 的 import；`material_split.py` 删除只被道法使用的 `split_tail_question_rule`（搬到道法模块），docstring 改为「物理/化学共用」。

---

## 6. 数据模型

### 6.1 新增列

```sql
-- questions：小问序号（0 = 不是小问，1..n = 第几个小问）
sub_no TINYINT UNSIGNED NOT NULL DEFAULT 0

-- questions：材料显示位置（NULL = 现有行为「题干下方」；before = 题干上方）
material_position VARCHAR(8) DEFAULT NULL
```

不新增 `paper_questions` 列：卷面题号仍是 26，`group_order` 与 `sub_no` 一起构成题内身份。

**为什么 `sub_no` 放 `questions` 而不是 `paper_questions`**：服务端的考试结果、专项抽题、练习历史、特殊作答都直接查 `questions`，只有试卷详情查 `paper_questions`。放 `questions` 与现有 `group_order` 同级、读路径零额外 JOIN。代价是「同一题行被多卷共享」时 `sub_no` 只反映首次入库那份卷——与 `group_order` 现有的取舍一致，接受。

### 6.2 迁移

新增 `tools/db/migrations/2026-11-23_politics_subquestion.sql`，按现有幂等写法（`information_schema` + `PREPARE`）：

1. `questions.sub_no`：不存在则 `ALTER TABLE questions ADD COLUMN sub_no TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER group_order`
2. `questions.material_position`：不存在则 `ALTER TABLE questions ADD COLUMN material_position VARCHAR(8) DEFAULT NULL AFTER material_method`

同步改 `tools/db/schema.sql` 的 `questions` 建表段（220-249 行）。DDL 批次收尾跑 `python3 tools/db/schema_reconcile.py`。

### 6.3 常量

- `sub_no=0`：无小问。前端/接口一律把 0 当「没有」。
- `material_position` 只写 `before`，读时 `'before'` 才是上方，其余（NULL/after）都按下方。

---

## 7. 数据管线改动

### 7.1 模型与标注结构

| 文件 | 改动 |
|---|---|
| `src/models.py` | `ExamQuestion` 加 `sub_no: int = 0`、`material_position: Literal["before","after"] \| None = None`。**必须声明**，否则 `publish_cli.py:289` 的 `ExamQuestion(**raw)` 会静默丢掉（知识点事故同款）。 |
| `src/question_splitter.py` | `RawQuestion` 加 `sub_no: int = 0`、`material_position: str \| None = None`；`split_page` 末尾（1352-1357 行的两个 attach 钩子之后）加 `expand_subquestions` 钩子 |
| `src/question_labeler.py` | `LabeledQuestion` 加 `sub_no`、`material_position`；`from_raw`（428-446 行）显式拷贝 |
| `src/question_extract.py` | `_write_exam_questions_jsonl`（396-490 行）写 `sub_no`、`material_position`；`_print_split_preview`（186-226 行）题号显示 `26(1)`，有 `score` 时显示 `8分`，便于验收直接比对 |

### 7.2 道法模块

**`src/subject_strategies/politics.py`**

- 删除 `from subject_strategies.material_split import ...` 与 `split_material` 覆盖（继承 `NaturalScienceStrategy` 的 no-op）；
- 新增：

```python
def expand_subquestions(self, questions):
    from subject_strategies.politics_subquestions import expand
    return expand(questions)
```

- `is_stem` / `split_options` / `split_bounds` / `choice_bounds` / `material_policy` 不变（A–D 四项、无跨题材料）。

**新文件 `src/subject_strategies/politics_subquestions.py`**

- `MARK_RE`、`SCORE_RE`、材料头/末句设问的判断；
- `expand(questions) -> list[RawQuestion]`：逐题调用 `_split_one`，再补 4.7 的单小问材料，最后对有材料的题设 `material_position='before'`；
- `_split_one(q)`：按 4.1–4.5 实现，`dataclasses.replace` 复制原题、清空 `post_material_*`；
- `_split_answer(answer, n)`：按 `MARK_RE` 切答案；
- `split_tail_question(content)`：从 `material_split.py` 搬过来（原 115-160 行），去掉「物化」表述。

**`src/subject_strategies/material_split.py`**

- 删除 `split_tail_question_rule`；
- docstring #1 行改为「题内材料切分（物理/化学共用规则）」；
- 其余不动。

### 7.3 切题入口

`split_page` 末尾：

```python
expand = getattr(strategy, "expand_subquestions", None)
if callable(expand):
    questions = expand(questions)
```

位置在 `attach_pre_material` / `attach_post_material` 之后、`return questions` 之前。理由：

- `--preview` 走 `split_page`，预览与正式提取看到同一结果；
- `split_snapshot.py` 也走 `split_page`，快照能覆盖新行为；
- 语文/数学/物化没有这个方法，行为不变。

`question_extract._split_inline_material`（378-392 行）不动：道法不再实现 `split_material`，循环里 `splitter` 是父类的 no-op，已拆出的题因 `material_text` 非空直接跳过。

### 7.4 publish

`publish_cli.py` 不需要额外逻辑：`ExamQuestion(**raw)` 声明字段后 `model_dump` 会原样带回。检查两点：

- `_strip_page_markers_from_question` 只改文本字段，不动新字段；
- `rewrite_item` 只改图片引用，不动新字段。

### 7.5 入库

`src/db_loader.py`：

| 位置 | 改动 |
|---|---|
| `_update_question_row`（1298-1319 行） | SET 加 `sub_no=%s, material_position=%s` |
| 同卷原址更新查询（1369-1400 行） | 匹配键从 `(paper_id, group_order)` 改为 `(paper_id, group_order, q.sub_no)`；`group_order` 缺失时的兜底分支同样加 `q.sub_no`。**不改会让两条小问抢同一行** |
| 原址更新 UPDATE（1426-1430 行） | 加 `sub_no`、`material_position` |
| INSERT（1493-1505 行） | 列与值加 `sub_no`、`material_position` |
| `paper_questions` 重排（1541-1560 行） | JOIN `questions` 后 `ORDER BY pq.group_order, q.sub_no, pq.question_no`；`COALESCE(group_order, rn)` 不变（仍是 26） |
| 组卷查重（1563-1571 行） | JOIN `questions` 后 `GROUP BY pq.question_no, q.sub_no`，26(1)/26(2) 不再报「同号题」 |
| `delete_paper`（1640 行起） | `purge_paper_data=True` 时顺带删该卷下**已无作答记录**的 `exam_sessions`，避免留下 0 题会话 |

### 7.6 import_cli：一条命令重导

新增 `--reload-paper`：

- 与 `--cards-only`、`--skip-load` 互斥；
- 必须能解析出唯一一份卷（`--file` 或 `--files` 拆出的单个），批量导入时逐份执行；
- 入库阶段把 `--load-cards` 换成 `--reload-source <卷名> --purge-paper-data`；
- 交互终端下先打印「将删除该卷 N 道旧题、M 条考试作答」，问一次 `y` 才执行；非交互终端直接报错退出（防 CI 误删）。

`load_argv`（232-244 行）相应分支；dry-run 只打印不执行。

35 中的重导命令（唯一一条）：

```bash
python3 src/import_cli.py --subject 道法 --file "35中" --re-extract --re-publish --reload-paper
```

### 7.7 识别扫描与人工补题

现在 `recognition_scan` / `apply_fixes` / `manual_fix` 都以 `(source, group_order)` 为身份键。拆开后 26(1)/26(2) 同号，存在两个风险：

1. 扫描的 `by_no`、issue 去重会把两条小问并成一条（覆盖不全）；
2. **apply_fixes 按 `(paper_id, group_order)` 定位写入，可能把 26(1) 的补题写到 26(2) 上**。

处理分两步：

**阶段 A（本次必须做，防写错）**

- `apply_fixes` 写入前守卫：按 `(paper_id, group_order)` 查出多行且记录没有 `sub_no` → 拒绝写该条，打印「第 26 题有 2 个小问，无法确定目标；请用 sub_no 定位」；
- `manual_fix` 记录带 `sub_no`（从 extracted/published jsonl 读），提示文案显示 `26(1)`；
- 识别扫描的 issue 记录带 `sub_no`，但去重键暂不升级（覆盖不全不影响正确性）。

**阶段 B（同批建议做，可独立排期）**

- 身份键统一升级为 `(source, group_order, sub_no)`：
  - `recognition_scan.add()` 与 `by_no` / 去重键；
  - `apply_fixes._existing_question` / `_orphan_question` / UPDATE WHERE / INSERT / 重排 ORDER BY；
  - `manual_fix` 的问题清单、`_ask_one`、重录记录、`mark_issue`；
  - 文案统一 `第 26 题(1)`；
- 阶段 B 完成前，道法小问的人工补题只能靠改 md 重切，UI 会明确提示。

---

## 8. 接口与前端

### 8.1 服务端

| 位置 | 改动 |
|---|---|
| `exam-papers.repo.ts:92-103` | SELECT 加 `q.sub_no AS subNo`、`q.material_position AS materialPosition`；`ORDER BY pq.question_no, q.sub_no` |
| `exam-papers.repo.ts:21-27` | 行类型加两个字段 |
| `exams.service.ts:498-511` `toSessionQuestion` | DTO 加 `subNo`、`materialPosition` |
| `exams.service.ts` 结果映射（约 275 行） | `questionNo` 仍是 `row.question_order`，另加 `subNo`、`materialPosition` |
| `exam-sessions.repo.ts:158-170` | SELECT 加 `q.sub_no`、`q.material_position`；`ORDER BY ea.question_order, q.sub_no, ea.question_id` |
| `exam-sessions.repo.ts:53-71` `ExamResultRow` | 类型加两字段 |
| `practice-history` DTO / service | `materialPosition` 透传（历史页材料位置）；`subNo` 不需要（历史页按会话顺序显示「第 N 题」） |
| `special-answer-records.repo.ts:124-140` | SELECT 加 `q.sub_no`、`q.material_position`（详情页材料位置） |
| `questions.repo.ts` `PAPER_QUESTION_NO_SQL` | 不变（仍按 `pq.question_no` 取 26）；抽题主查询是 `q.*`，已带 `sub_no` / `material_position` |
| `questions.repo.ts` 按题号抽题（`findByPaperPosition` 等） | 查询条件不变（`pq.question_no = ?` 会同时命中两条小问）；排序加 `q.sub_no` 保证 26(1) 在 26(2) 前 |
| `training.service.ts:894-907` | **不变**：题号面板仍按 `question_no` 分组，26 一格、`total=2`；点 26 抽到两条小问，符合「按试卷题号抽题」现有语义 |

**不改** `training` 的按题号抽题签名（仍只传 `questionNo`），保证其它学科与现有前端不受影响。

### 8.2 前端身份键（关键）

`ExamRunPage.tsx:169-185` 和 `ExamResultPage.tsx:170-182` 现在用 `n = String(questionNo)` 作为题目标识，并同时用作 `answers[q.n]`、`questionIdMap` 的键。两条 26 会**撞键**（作答串题、Map 覆盖）。

改为：

```ts
const n = q.subNo ? `${q.questionNo}(${q.subNo})` : String(q.questionNo);
```

`RunnerQuestion` 加 `subNo?: number | null`、`materialPosition?: 'before' | 'after' | null`。

专项 `TargetedRunPage.tsx:134-156` 的 `n` 用 `questionId`，本身唯一，不需要改键；但要补 `subNo`（来源行展示）和 `materialPosition`（材料位置）。

### 8.3 材料位置

新增 10 行小工具（`apps/web/src/components/business/answer/materialPlacement.ts`）：

```ts
export function materialSlots(q: { material?: string | null; materialPosition?: string | null }) {
  const text = q.material?.trim() ? q.material : null;
  return q.materialPosition === 'before'
    ? { above: text, below: null }
    : { above: null, below: text };
}
```

四处渲染组件改为用它，不再按字段硬编码：

| 文件 | 现在 | 改后 |
|---|---|---|
| `QuestionRunner.tsx:585-640` | `material_url` 在上、`material_text` 在下 | 文档恒在上；`material_text` 按 `materialSlots` 放上/下 |
| `AnswerResultList.tsx:224-241` | 同上硬编码 | 同上 |
| `PrintPaper.tsx:84-128` | 同上硬编码 | 同上（`showText` 的相邻去重逻辑保留） |
| `PracticeHistoryDetailPage.tsx:226-248` | 同上硬编码 | 同上 |

文档（`material_url`）永远在题干上方，不受 `material_position` 影响。

### 8.4 题号展示

`formatPaperQuestionNo`（`apps/web/src/utils/questionSource.ts:22-25`）加可选 `subNo`：

```ts
formatPaperQuestionNo(26)      → 试卷第 26 题
formatPaperQuestionNo(26, 1)   → 试卷第 26 题(1)
```

调用点：`QuestionRunner.tsx:465,646`、`TargetedRunPage.tsx` 来源行、其它用到的地方（全仓 grep `formatPaperQuestionNo`）。

`AnswerResultList` 的题号直接显示 `q.n`，因此自动变成 `26(1)`；`data-testid="result-qno-26(1)"` 同步变化（测试改断言）。

打印页 `PrintPaper.tsx:92` 用 `i + 1` 作练习卷序号，不显示原卷题号，**不改**。

### 8.5 家长端 / 教研端

- 家长端不展示题目原文，只展示统计，**不改**。
- 教研端（`ResearchPaperDetailPage`）显示 `q.questionNo`（26 两次），改为 `26(1)` / `26(2)`；`ResearchQuestionEditDrawer` 的 `#26` 标题同改。编辑面板的接口按 `questionId` 定位，不受影响。

---

## 9. 存量迁移

只动 35 中；海淀、汇文不动。

1. 执行迁移（6.2），跑 `schema_reconcile.py`。
2. 重导 35 中（7.6 的单一命令）。脚本会：
   - 重跑 extract（LLM 标注 33 次）与 publish；
   - `--reload-paper` 删除该卷 28 道旧题、28 条 `exam_answers`、空的 session 862，再按 33 条重插；
3. 校验：
   - `questions` 中该卷 33 行，`group_order, sub_no, full_score` 为：26 → (1,8)、(2,4)；27 → (1,6)、(2,9)、(3,4)；28 → (1,6)、(2,3)、(3,10)；
   - `paper_questions` 中该卷 33 行，`question_no=26` 出现两次（两条小问挂同一题号），其余题号各一次；
   - `sub_no` 只在 `questions` 上，`paper_questions` 没有该列。
4. 海淀卷保持旧形态（`sub_no=0`、`material_position=NULL`），不重切、不删任何作答/错题。
5. 文档收尾：更新 `docs/constraints/数据管线.md` 的切题策略条目（道法独立小问拆分）、`docs/ai-core-changelog.md` 记本次改动与实测数字。

---

## 10. 测试

### 10.1 后端单测（data-refinery）

新增 `tests/subject_strategies/test_politics_subquestions.py`：

- 黄金样例：用 35 中 26/27/28 与汇文 25 的 `content` 原文，断言小问数、`sub_no`、`full_score`（按 4.6 表）、材料首行、材料归属；
- 材料继承：28(3) 无自有材料 → 等于 28(1)+28(2) 材料拼接；27(3) 有自有材料 → 不继承；
- 平台残留：`+学科观点` 整行被丢弃，正文其余不变；
- 负例：编号 `1,3`、从 2 开始、正文为空、正文无设问特征 → 返回原题一条；
- 分值不参与判定：缺 `(N分)`、分值写成 0、分值之和与题号行总分不一致 → **照常拆**，`full_score` 为 `None` 或实际解析值；
- 答案拆分：`(1)…(2)…` → 两条；只有一段 → 两条都空并打日志；
- `material_position`：有材料的道法题 = `before`，无材料 = `None`；
- 单小问材料题走 4.7 的末句规则。

更新：

- `tests/test_politics_material.py`：`split_tail_question_rule` 的 import 改为道法新模块；
- `tests/test_material_split.py`：去掉对道法规则的引用（若有）；
- `tests/test_no_subject_conditionals.py`：保持通过（内核无学科判断）。

### 10.2 快照

`python3 src/split_snapshot.py --check`：预期**只有道法两份卷**出现差异（题数 28→33、33 项小问），语文/数学/物理/化学零差异；确认后 `--write` 重写基线并提交（否则后续检查会一直红）。快照 item 增加 `sub` 字段（`_ITEM_FIELDS` 同步），差异行才能看出是 26(1) 还是 26(2)。

### 10.3 服务端单测

- `exam-papers.repo.test.ts`：断言 SQL 含 `subNo`、`materialPosition`、排序含 `sub_no`；
- `exams.service.test.ts`：`toSessionQuestion` / 结果 item 的精确键断言补 `subNo`、`materialPosition`；
- `training.service.test.ts`：白名单键断言补两个字段；题号面板的 `positions` 断言不变（26 一格 total=2）。

### 10.4 前端单测

- `QuestionRunner.test.tsx`：`materialPosition='before'` 时材料在题干上方、`default` 时在下方；
- `AnswerResultList.test.tsx`：同上；题号显示 `26(1)`、两个小问 key 不冲突；
- `PrintPaper.test.tsx`：`before` 材料印在题干上方，`after` 在下方；相邻相同材料仍只印一次；
- `ExamRunPage.test.tsx`：两条 `questionNo=26`、`subNo=1/2` 时 `n` 分别为 `26(1)/26(2)`，作答不串；
- `questionSource` 工具：`formatPaperQuestionNo` 两种形态。

---

## 11. 验收步骤

1. `python3 src/import_cli.py --subject 道法 --file "35中" --preview`
   → 26 显示 2 条（8 分 / 4 分），27 三条、28 三条；材料各归各的，26(1) 不再包含「活动二」。
2. 同一条（去掉 `--preview`，加 `--re-extract --re-publish --reload-paper`）真正重导，确认库中 33 题。
3. 页面上看：
   - 作答页：26(1) 材料在题干上方、正文只有 `(1)…`；
   - 结果页 / 历史页 / 打印：材料位置一致，题号 `26(1)`；
   - 专项「按题号」面板：第 26 题一格，可练 2 题。
4. `npm test`（server + web）、`pytest`、`split_snapshot --check` 全绿。
5. 海淀卷抽一条旧题确认 `sub_no=0`、材料仍在下方、页面无变化。

---

## 12. 风险与回滚

| 风险 | 影响 | 处理 |
|---|---|---|
| 同号 26 撞前端作答键 | 作答串题/丢答 | 8.2 的 `n` 复合键；单测覆盖 |
| 补题按题号写错小问 | 内容被覆盖 | 7.7 阶段 A 守卫；阶段 B 升级键 |
| 小问分值读不到或与总分不一致 | 该题 `full_score` 为空/不准 | 照常拆；分值只展示，不参与能否拆的判定 |
| 指代材料的题（28(3)）单独抽到后无上下文 | 学生无法作答 | 4.2 第 5 条继承前序材料 |
| `ExamQuestion` 未声明新字段 | 字段静默丢失 | 7.1 显式声明 + JSONL/入库断言 |
| 重导误删海淀学生数据 | 数据不可恢复 | 只对 35 中执行 `--reload-paper`；海淀不动 |
| 其它学科被牵连 | 切题结果变化 | `split_snapshot --check` + 各学科策略无钩子 |

回滚：

- 代码回滚到本次之前；
- 数据库保留的新列无副作用（`sub_no=0`、`material_position=NULL` 即旧行为）；
- 35 中旧数据已删，无法回滚，重导前先备份该卷 `questions` / `paper_questions` / `exam_answers` 到临时表。
