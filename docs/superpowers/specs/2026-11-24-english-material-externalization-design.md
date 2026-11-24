# 英语试卷材料化解析设计（五大题型 / material_url 与 material_text 分工）

**日期**：2026-11-24
**状态**：已批准（2026-11-24）
**范围**：只改「新导入的英语试卷」的解析与发布路径；存量英语题不回填；阅读理解 A 篇匹配题（21–23）不在范围
**试点卷**：2026 西城·三帆中学 初三 期末（`tools/data-refinery/output/md/英语/初中/first/2026/英语-初三(上)-202607-西城·三帆中学-期末-试卷/`）
**实现路径**：A —— 在现有「切题钩子 + 发布外置分支」两个挂载点加英语规则；不新建解析管线、不新建模块

---

## 1. 背景与目标

英语卷的题型结构与其它学科不同，五大题里材料形态各异。以试点卷切题产物（published jsonl）实测：

| 题 | 现状 | 问题 |
|---|---|---|
| 1–12（单选） | 每题 `material_text` 都挂着「从下面各题所给的 A、B、C、D 四个选项中…」 | 卷面说明被当成材料 |
| 13/14/16–20（完形） | `content` 为空；整篇短文（含 `_13_` 空格标记）塞在每题 `material_text` | 文章重复 8 份；题干空被 LLM 判「不完整」→ `is_active=0` |
| 24–26 / 27–29 / 30–33（阅读 B/C/D） | `material_text` 含 `## B`/`## C`/`## D` 与卷面指令 | 文章重复多份；指令混进正文 |
| 34–37（阅读表达） | `material_text` 以 `## 第二部分`、`## 本部分共 5 题…四、阅读表达(…)`、`阅读短文，根据短文内容回答问题。` 开头 | 卷面结构混进文章 |
| 38（作文） | 题目①②、提示词、内容提示、表格全挤在 `content` | 题干过长；LLM 判「缺两个题目选项」→ 待复核 |
| 21–23（匹配） | 完全没切出来（题干在 HTML 表格里） | 本次不处理，继续人工补题 |

语文已有成熟的文章外置链路（`docs/superpowers/specs/2026-11-20-chinese-material-doc-design.md`）：
`write_material_doc()` 写 `materials/{subject}/{doc_key}/content.md`、算哈希、物化图片；`publish_cli.py:290` 的 `if subject_code == "chinese"` 是唯一触发点。英语只需接上同一能力，并换成英语自己的材料归属规则。

**目标**：按大题把英语材料分成三类归位——① 题号前的共享文章写 md + `material_url`；② 作文题号后的内容进 `material_text`；③ 卷面说明与大题指令不进任何材料列。

---

## 2. 已确认裁决（用户 2026-11-24）

| 项 | 裁决 |
|---|---|
| 存量数据 | 只管新导入；库里已有英语题不回填，不写回填脚本 |
| 匹配题 21–23 | 不在本次范围，继续走人工补题；A 篇材料也不处理 |
| 卷面指令 | 不写进材料 md，只保留文章本体 |
| 作文切分点 | 第一段指令句当题干，其后所有内容（题目①②、提示词、内容提示、表格）进 `material_text` |
| 完形题干 | 保持为空；空格所在句在共享文章里，不再判为缺题干 |
| 单选说明 | 清掉，不进材料 |
| 实现路径 | A：现有两个挂载点加规则分支，复用语文外置代码，不动其它学科 |

---

## 3. 逐大题规则

以试点卷为例（`group_id` 已由切题器从 `## 一、…` 等大题标题写入，直接作为规则入口）：

| 大题 | 题号 | `content` | `options` | 材料归位 |
|---|---|---|---|---|
| 一 单项填空 | 1–12 | 原样保留 | 4 项照旧 | `material_text`、`material_url` 都清空 |
| 二 完形填空 | 13/14/16–20 | **保持为空** | 每题 4 项照旧，空格标记 `_13_` 保留在文章里 | 整篇短文 → 1 份 md；同组各题共用 1 个 `material_url`，`material_text` 清空 |
| 三 阅读理解 | B:24–26 / C:27–29 / D:30–33 | 原样保留 | 每题 4 项照旧 | 每篇短文各 1 份 md；同篇题共用 URL，跨篇不同 URL |
| 四 阅读表达 | 34–37 | 原样保留 | 无（简答） | "Be Smart About Your Smartphone" → 1 份 md，4 题共用 URL |
| 五 文段表达 | 38 | 只留第一段指令句 | 无 | 其余全部 → `material_text`；**不外置**（英语 `material_text` 按既有口径显示在题干下方，正好符合「题干在前、材料在后」） |

`material_url` 文章显示在题干上方、`material_text` 题库材料显示在题干下方——沿用 `2026-11-02-material-question-design.md` 与 2026-11-24 按学科定位置的既有规则，前端与服务端不改。

---

## 4. 架构与改动点

### 4.1 切题阶段：`src/subject_strategies/english.py`

在 `EnglishStrategy` 上实现切题器**已存在**的可选钩子 `attach_post_material(questions, lines, md_path.stem)`（`question_splitter.py:1370-1372` 调用；语文已用同一钩子）。这样不用给 splitter 加新钩子，其它学科行为不变；同步把 splitter 那行「题后材料（语文）」注释改成「题后材料/材料规整（语文、英语）」。

钩子内按 `group_id` 就地改写每条 `RawQuestion`：

1. **组一**：`q.material_text = ""`。
2. **组二/三/四**：剥掉 `q.material_text` 开头的卷面指令行，正文原样保留；`_13_` 这类空格标记不动（它是完形题的关键信息）。若剥完只剩标题/空，置空。
3. **组五**：把 `q.content` 按第一个空行切成两段：第一段留 `q.content`，其余含空行整体进 `q.material_text`。切不出两段时 `content` 保留原文、`material_text` 留空并打印 warn，不抛错。
4. 其它组 / `group_id` 缺失：不动。

**卷面指令判定**（纯结构，开头行匹配，按整行删，不按字数猜）：

```
^#{0,6}\s*本部分共
^#{0,6}\s*第[一二三四五六七八九十]+部分\s*$
^#{0,6}\s*(?:从下面各题所给|阅读下面的短文|阅读下列短文|阅读短文，根据)
^#{0,6}\s*[一二三四五]、
```

注意：`chinese_material_doc.strip_section_instruction()` 只认「阅读…完成…题」的中文模式，匹配不了英语指令，所以英语的剥离必须在这里做；`write_material_doc()` 仍可复用（它内部再洗一次页码，不冲突）。

### 4.2 发布阶段：`src/publish_cli.py` + `src/chinese_material_doc.py`

- `publish_cli.py:290` 在 `if subject_code == "chinese": …` 旁加 `elif subject_code == "english":`，调用新增函数 `externalize_english_materials(items, md_images_dir=…, assets_dir=…, store=…, subject_code=…, paper_scope=…)`。
- 新函数与 `externalize_chinese_materials()` 放在同一文件，复用 `doc_key()`、`write_material_doc()`、`choose_canonical()`、`build_groups()` 的思路和图片物化 `rewrite_material_doc()`；只把「哪些材料算文章」换成英语规则：
  - 仅处理 `group_id ∈ {二, 三, 四}` 且 `material_text` 非空的题；
  - 同卷内按规范化正文 + 图片哈希分组；同组取一个 canonical 正文，写一个 md，同组每题设同一个 `material_url`、清空 `material_text`；
  - `paper_scope = rel_file.as_posix()`（与语文一致，卷间隔离）；
  - 组一/五不写文档，也不写 `material_url`。
- 复用语文已有的 `build_groups()` 判重与 `choose_canonical()` 逻辑；不另建缓存、暂存目录或开关。

### 4.3 标注阶段：`src/question_labeler.py`

加一条英语窄豁免，仿照现有 `apply_true_false_exemption()` / `apply_kp_issue_exemption()` 的写法：

- 条件：`group_id == "二"` 且 `content` 为空/近空，`material_text` 非空，`options` 是完整 4 项；
- 动作：清掉「题干缺失/题干为空/仅显示为题干」这类完整性问题，置 `is_complete=True`；
- 反例：选项不足 4 项、材料为空 → 不放行，仍标待复核；
- 作文题拆分后 LLM 能看到题目①②，预期无需新豁免；验收时确认 `labeling_issues.jsonl` 不再出现 Q38 的「缺两个题目选项」。

### 4.4 不改的部分

convert、db_loader、服务端（material-doc / judge-core / explanation-cache）、前端（MaterialBlock / QuestionRunner 等）、语文及其它学科策略、schema。

---

## 5. 数据流

```
试卷 md
  → extract：英语钩子按 group_id 规整 content / options / material_text
  → published jsonl：题干、选项、材料各就位（英语作文题干已只剩第一段）
  → publish：英语分支把组二/三/四的文章写 materials/english/{key}/content.md，
             同卷同文共用一个 material_url，material_text 清空
  → db_loader：原样入库（content / material_text / material_url / content_hash）
  → 前端：material_url 文章在题干上方；英语 material_text 在题干下方
```

`content_hash` 由 db_loader 按 `material_url + material_text` 参与计算，现有逻辑不改。

---

## 6. 错误与边界

| 情形 | 处理 |
|---|---|
| 材料剥完只剩标题/空 | 不写文档，`material_url` 留空，`material_text` 清空，不报错 |
| 作文只有一行、切不出两段 | `content` 保留原文、`material_text` 留空，打印 warn |
| 材料含图片 | 走 `write_material_doc()` 内已有的图片物化与路径改写；否则前端 404 |
| 图片缺失 / 文档写入失败 | 沿用语文外置分支的现有失败策略，不静默写坏 URL |
| `group_id` 缺失或非一~五 | 不套规则，保持原样 |
| 完形选项不足 4 项 | 豁免不生效，仍标待复核 |
| 21–23 匹配题缺题 | 不在范围；扫描阶段照旧报缺号，走人工补题 |

---

## 7. 非目标

- 不回填已入库英语题；不清理试点卷已入库的 paper=975。
- 不修「1-5 CBBCD」区间答案不回填的问题。
- 不修「选了 1 却导入两份卷」的关键词重匹配问题。
- 不恢复 21–23 匹配题，不改匹配题表格解析。
- 不新增 CLI 参数、缓存、开关、独立模块或回填脚本。

---

## 8. 测试

就近加用例，不新建测试文件：

1. `tools/data-refinery/tests/subject_strategies/test_english.py`
   - 以三帆卷 md 片段为 fixture，断言：组一 `material_text` 为空；组二 `content` 空、材料含 `_13_`、选项中 4 项在；组三/四材料正文不含卷面指令；组五题干为第一段、材料含「题目①」「题目②」。
2. `tools/data-refinery/tests/test_chinese_material_doc.py`
   - 英语外置函数：只外置组二/三/四；同卷同文多题共用 URL；`material_text` 清空；组五不外置；文档首行不含「阅读短文 / 本部分共 / 四、阅读表达」；材料内图片路径被改写。
3. `tools/data-refinery/tests/test_question_labeler.py`
   - 完形豁免正例（题干空 + 材料 + 4 选项 → `is_complete=True`）与反例（选项不足 → 不放行）。
4. 回归：`cd tools/data-refinery && pytest -q`（现有基线约 1563 通过）。

---

## 9. 验收（不写库，一条命令）

```
cd tools/data-refinery && python src/import_cli.py --subject 英语 --year 2026 --file "西城·三帆中学" --re-extract --re-publish --skip-load --skip-answers --skip-review
```

`--re-extract --re-publish` 用来清掉该卷的提取/发布 checkpoint（否则会跳过，新规则不生效）；命令会覆盖 output 下该卷的派生 jsonl 与 assets，但**不写 MySQL**。跑完检查：

- 13 / 24 / 27 / 30 / 34 号题有 `material_url`、`material_text` 为空；
- 同篇题 URL 相同：24–26、27–29、30–33、34–37 各一组，且四组互不相同；
- 文章 md 开头不含「阅读短文 / 本部分共 / 四、阅读表达 / 阅读下面的短文」；
- 38 号 `content` 只剩第一段指令句，`material_text` 含「题目①」「题目②」；
- 1–12 号两列都空；
- `labeling_issues.jsonl` 不再出现 Q15「题干为空」与 Q38「缺两个题目选项」；
- 21–23 仍缺（已知不在范围）。

本次验收只覆盖新导入路径；要看到学生端效果仍需以后正式重新导入卷子。
