# 试卷题切分与标注设计

**日期**：2026-09-05
**状态**：已通过头脑风暴，待写实现计划
**关联模块**：`tools/data-refinery/src/`
**关联问题**：试卷题被错误地按教材卡逻辑切分（card_splitter 按 400 字切 + image_scan 丢小图标），导致题干切碎、图片丢失、字段不匹配 ExamQuestion 模型

## 1. 背景与问题

### 1.1 现状

`extract_cli.py` 当前对**教材卡和试卷题**统一走同一条流水线：

```
image_scan（丢小图标 scaled_h≤78px）→ card_splitter（按 400 字贪心合并）
  → CardLabeler（标 page_type/card_type/lesson_id/title）
  → 输出 TextbookCard JSONL
```

对试卷题，这条流水线产生三个问题：

1. **图丢失**：`image_scan` 把渲染高度 ≤3 行（78px）的图判定为"装饰性图标"整行移除。试卷里的几何小图、统计图、坐标图经常是这个高度，被错误丢弃。
2. **题干被按字数切碎**：`card_splitter` 按 400 字贪心合并，一道解答题（含图、含多小问）会被切成多张卡片，跨卡片边界还会丢上下文。
3. **字段不匹配**：试卷题应是 `ExamQuestion`（type/answer/options/explanation/group_id/group_order/source/source_year），但当前输出 `TextbookCard`（lesson_id/card_type/title/content_metadata/textbook_page）。`publish_cli` 按文件名判 `kind=questions` 反序列化为 `ExamQuestion` 时字段对不上会失败。

### 1.2 历史成因

DB 里现存的 452 道试卷题（source 为"北京市西城区九年级模拟测试试卷"等）切分正确、字段齐全，是早期用 `extract.py` 的 `Extractor` 类 + `exam_questions.txt` prompt（**LLM 整份切题**）跑出来的。后来 `extract_cli.py` 改造为 `card_splitter + CardLabeler`（教材卡路径）后，`Extractor` 类和 `exam_questions.txt` prompt 没有接线进新 CLI，试卷路径被错误地塞进教材卡流程。**当前 pipeline 跑试卷到 publish 会失败**（试卷题从来没真正端到端跑通过新流程）。

### 1.3 设计目标

为试卷题建一条独立、确定性的切分路径：

- **Python 按题号切分**，题干原文原封不动（不调 LLM 切题，避免 LLM 改写）
- **保留所有图片**，不做小图标舍弃
- **LLM 只标注**（type / difficulty / 知识点），不给答案、不改 content
- **Python 按题号对齐答案**（试卷 MD 末尾自带 or 同名"答案.md"合并）
- **输出 ExamQuestion JSONL**，与 `publish_cli` 的 `kind=questions` 判定对齐
- **新增知识点双模型确认**（无人审核），db_loader 入库

### 1.4 非目标

- 不动教材卡（cards）现有流程
- 不做 `material_text` 抽取（数学不抽，道法/物理等后续做——见 §10）
- 不做 publish / db_loader 改造（db_loader 处理 `_confirmed_new_kps` 入库是后续任务）
- 不引入并发下载/标注

## 2. 数据流

```
试卷 MD（zgkao 单文件，如 数学-...-西城-模拟二-试卷.md）
  │
  ├─ ① 预处理（复用现有）：strip_chrome 剥页眉/水印 + normalize_fullwidth_parens 全角括号归一
  │   【不跑 image_scan】—— 试卷路径不丢任何图，图引用原样保留在 content 里
  │
  ├─ ② 答案合并检测：
  │   - 若试卷 MD 末尾无"答案"关键字 → 找同名 "-答案.md"（把文件名里 "-试卷" 换成 "-答案"），
  │     把内容合并到末尾
  │   - 仍无 → 所有题 answer 留空（做题时大模型补）
  │
  ├─ ③ question_splitter.split_page(text)：
  │   一次扫描同时完成题干切分 + 答案对齐（见 §3）
  │
  ├─ ④ question_labeler.label(questions, batch_size)：
  │   - LLM 标 type + difficulty + knowledge_points（已有列表选）+ suggested_new_kps（建议新增）
  │   - 双模型确认 suggested_new_kps（见 §4.3）
  │
  └─ ⑤ 组装 ExamQuestion JSONL → output/extracted/.../<试卷名>.jsonl
      （publish_cli 已支持 kind=questions → ExamQuestion 模型 + rewrite_question 物化图片，无需改）
```

## 3. 题号切分与答案对齐（question_splitter.py）

### 3.1 题号识别规则

| 类型 | 正则 | 处理 |
|---|---|---|
| 主题号（行首） | `^\s*(\d{1,2})\.\D` （行首 1-2 位数字 + `.` + 非数字字符） | **切分边界**：新题开始 |
| 主题号紧凑格式 | 行内 `(?<!\d)(\d{1,2})\.\D` （答案区一行多题号） | 行内正则切多个题号 |
| 小问号 | `^\s*\(\d{1,2}\)` 或 `^\s*（\d{1,2}）` | **不切**：合并到上一个主题号 content |
| 大题分组标题 | `^\s*[一二三四五六七八九十]+、` | 关闭当前题，记 group_id，标题行丢弃 |
| 日期/页码陷阱 | `^\d{4}\.\d` （如 `2026.5`） | 过滤，不当题号 |

**主题号正则说明**：
- 范围限制 `{1,2}`：1-99，避免 `2026.5` 被误识别为题号 2026
- `.` 后跟 `\D`（非数字字符）——不要求空格，兼容 `9. 若代数式`（有空格）、`9.若代数式`（无空格）、`9.$\frac{1}{x-3}$`（数学公式起头）等；同时排除 `9.5` 这种数字小数
- 答案区紧凑格式（`9. xxx 10. xxx 11. xxx`）用行内 `(?<!\d)(\d{1,2})\.\D` 切分（`(?<!\d)` 防止把行内 `19.5` 的小数点误切）

### 3.2 统一扫描算法

一次扫描同时完成题干切分和答案对齐，靠 `in_answer_section` 标志切换：

```
扫描 MD 每一行（维护：questions[] 数组，current_question，current_group_id，in_answer_section=False）：

  若是日期/页码陷阱（2026.5）
    → 跳过

  若是大题分组标题（"一、"/"二、"/"三、"...）
    → 关闭 current_question（若有，content 不含标题行）
    → current_group_id = "一"/"二"/"三"…
    → 标题行本身丢弃

  若是"答案"关键字行（行内含"参考答案"/"答案"/"评分参考"等）
    → 关闭 current_question（若有）
    → in_answer_section = True
    → 此行丢弃

  若是主题号行 N.（含紧凑格式一行多题号，行内正则切分）
    → 关闭当前正在累积的（题干 or 答案）
    → 若 !in_answer_section：
         开新题：questions.append({
           group_order=N, group_id=current_group_id,
           content="" + 后续  # 主题号"9."剥离存 group_order，content 只留题干
         })
    → 若 in_answer_section：
         按 group_order=N 找到 questions 里对应题，
         把答案塞入其 answer（若该题多次答案段落，合并）
         找不到对应题 → 单独记入 unused_answers（兜底，正常不发生）

  若是小问号行 (N)
    → current_question 非空 → 加入其 content；否则跳过

  其他行（含分组标题下的说明文字如"本题共 8 小题"）
    → current_question 非空 → 加入其 content
    → 否则跳过（说明文字不属于任何题）

末尾关闭最后一题。
```

### 3.3 答案部分的特征

两种格式并存：

**紧凑格式**（选择题/填空题答案）——一行多题号：
```
9. $x \neq 3$ 10. $3a(x - 1)^2$ 11. $x = \frac{2}{3}$ 12. 答案不唯一，如 $\sqrt{5}$ 13. ...
```

**展开格式**（解答题答案）——一题一段，含解题过程：
```
17. 解: $\left(\frac{1}{3}\right)^{-1} + 4\sin 45^{\circ} - \sqrt{18} - (\pi - 20...
18. 解: 原不等式组为 $\left\{ ... \right.$
20.（1）证明：∵ $AE \perp AC$ ,...
20. (2) 解: ...
```

### 3.4 answer / explanation 字段填法

- **选择题/判断题**：answer = 选项字母（如 "A"）；explanation = null
- **填空题**：answer = 原文给的值（如 "$x \neq 3$"）；explanation = null
- **解答题/证明题**：answer = 参考答案的"解：…""证明：…"原文（剥离"解：""证明："前缀，只留内容）；若另有【分析】【点睛】等附加段落 → 拆到 explanation
- **一题多小问的答案**（如 20 题 (1)(2)(3)）→ 合并到该题 answer，保留 (1)(2)(3) 结构
- **原文无答案** → answer = ""，explanation = null

### 3.5 主题号 vs 小问号的处理

- **主题号"9."剥离**：题号 N 存到 `group_order`，content 不含"9."字符（与 DB 现有数据一致：content 是"若代数式..."而不是"9. 若代数式..."）
- **小问号"(3)"保留在 content**：是题目结构的一部分（DB 现有数据样本：content = "(3) 把长为..."，小问号保留）

## 4. LLM 标注（question_labeler.py）

### 4.1 调用粒度（仅试卷，Card 不变）

新增参数 `--label-batch-size N`（仅对 questions 生效）：

| 值 | 行为 |
|---|---|
| `1`（默认） | 每题单独调 LLM |
| `0` | 全部题一次调 LLM |
| `N>1` | 每 N 题一批调 LLM |

Card（教材卡）保持现有行为（每张 Card 一次），不受此参数影响。复用 `--interval` / `--batch-size` / `--batch-sleep` 节流参数。

### 4.2 标注字段

LLM 输入：单题 content（题干原文，原封不动）+ 已有知识点列表（见 §4.4）

LLM 输出 JSON：

```json
{
  "type": "choice" | "fill_blank" | "true_false" | "short_answer" | "proof",
  "difficulty": 1 | 2 | 3,
  "knowledge_points": ["M0101", "M0302"],
  "suggested_new_kps": ["建议新增的知识点名称", ...]
}
```

难度定义（在 prompt 里写清，5 档）：

- **1 简单**：基础概念/直接套公式/一步计算
- **2 中等**：综合应用/多步推理
- **3 有一定难度**：如选择题中的最后一题
- **4 困难**：复杂证明/多知识点综合/开放探究
- **5 超困难**：新定义题、几何压轴题

### 4.3 双模型确认新增知识点（重点）

**AND 逻辑：两个 LLM 都认为应该新增才新增，任一不认同就不新增。无人审核。**

```
Step 1：主模型（如本地 Qwen3.8-27B）标所有题
  每题输出 type + knowledge_points(已有 code 列表) + suggested_new_kps(名称列表)

Step 2：收集所有 suggested_new_kps（去重）
  对每个建议新增的 KP，调第二个模型（兜底模型 deepseek-v4-flash）确认：
    输入：建议的新 KP 名称 + 当前已有 KP 全量列表
    输出：{ "is_new": bool, "matched_existing_code": "M01xx" | null }

Step 3：判定
  - 两个模型都认为 is_new=true → 标记"确认新增"，写入 _confirmed_new_kps
  - 第二个模型找到已有匹配 → 用 matched_existing_code 替换，加入 knowledge_points
  - 第二个模型认为是新增但名称不同 → 取主模型名称（写入 _suggested_new_kps 留存，但不入库）
  - 任一模型认为不新增 → 不新增（不写 _confirmed_new_kps）

Step 4：db_loader 入库时（后续任务）
  - _confirmed_new_kps → 插入 knowledge_points 表，拿新 id + 生成 code
  - 用新 code 建立 question_knowledge_points 关联
```

### 4.4 知识点列表动态从数据库读取（重点）

**prompt 里的已有知识点列表不写死在 prompt 文件中，每次运行时从数据库 `knowledge_points` 表动态查询，拼到 prompt 里。**

- 查询时机：`question_labeler` 初始化时一次性查全量 KP（71 个或更多）
- 查询内容：`SELECT id, code, name, parent_kp_id FROM knowledge_points WHERE subject_id=<对应学科>`
- 拼 prompt 格式：每行一个 KP，含 code + name + 父节点 name（如"M0101 有理数的概念与分类（数与式）"）
- 注入位置：在 `prompts/question_labeler.txt` 模板的占位符 `{{knowledge_points}}` 处（用 Mustache 或简单字符串替换）
- **效果**：后续 db_loader 入库新 KP 后，下次运行 question_labeler 自动吃到新增的 KP，无需改 prompt 文件

### 4.5 LLM 不做的事

- 不给答案（answer 由 Python 按题号对齐，§3）
- 不改 content（题干原样，Python 已切好）
- 不切分（Python 已切好边界）

### 4.6 prompt 关键约束（必须写入 question_labeler.txt）

在 prompt 里**必须**包含以下约束语句：

> **知识点标注约束**：除非确实是题目涉及表中没有的新知识点，禁止在没有合理理由的情况下增加新知识点。优先从已有列表中选；只有当题目确实涉及列表中不存在的知识点时，才输出 suggested_new_kps。

这是为了防止 LLM 滥建新知识点，导致 KP 表膨胀和重复。

## 5. 来源/日期元数据

| 字段 | 取值方式 |
|---|---|
| `source` | **文件名去扩展名**（如 "数学-初三(下)-202607-西城-模拟二-试卷"）。唯一区分试卷，避免 MD 标题重复 |
| `source_year` | 文件名里 `-(\d{6})-` 取前 4 位（202607 → 2026） |
| `subject_id` | 文件路径首段（"数学" → math），复用 `publish_cli._subject_code_for` |
| `grade_band` | 文件名"初三" → "junior"（初中），"高三" → "senior"，"小三" → "primary" |
| `difficulty` | LLM 标注（见 §4.2） |
| `material_text` | 数学不抽取（材料留在 content）；道法/物理后续做（见 §10） |

## 6. 输出 JSONL 结构

每行一个 ExamQuestion（扩展字段用下划线前缀，publish 原样保留，db_loader 处理）：

```json
{
  "subject_id": "math",
  "group_id": "二",
  "group_order": 9,
  "type": "fill_blank",
  "difficulty": 2,
  "content": "若代数式 $\\frac{1}{x - 3}$ 有意义, 则实数 $x$ 的取值范围是 \\_\\_\\_\\_.",
  "options": null,
  "answer": "$x \\neq 3$",
  "explanation": null,
  "material_text": null,
  "grade_band": "junior",
  "source": "数学-初三(下)-202607-西城-模拟二-试卷",
  "source_year": 2026,
  "knowledge_points": ["M0101", "M0302"],
  "_confirmed_new_kps": [],
  "_suggested_new_kps": []
}
```

输出路径：`output/extracted/数学/初中/second/2026/数学-初三(下)-202607-西城-模拟二-试卷/数学-初三(下)-202607-西城-模拟二-试卷.jsonl`

与 `publish_cli` 的路径期望一致（`_kind_for` 已按文件名含"试卷"/"答案"判 `questions`）。

## 7. 代码集成

### 7.1 extract_cli.py 加 kind 分支

```python
# main() 主循环改造：
for source in sources:
    kind = _kind_for(source)  # 复用 publish_cli 同款判断
    # "试卷"/"答案" → questions；否则 → cards

    if kind == "questions":
        # 试卷题路径
        text = strip_chrome(source.md_path.read_text(...), chrome)
        text = normalize_fullwidth_parens(text)

        # ② 答案合并检测
        text = _maybe_merge_answer_md(source, text)

        # ③ 题号切分 + 答案对齐（一次扫描）
        questions = question_splitter.split_page(text, source.md_path)

        # ④ LLM 标注（每题单独 or 批量，按 --label-batch-size）
        #    复用 _label_with_escalation（主模型 → 主模型重试 → 兜底模型 deepseek）
        labeled = question_labeler.label(questions, batch_size=args.label_batch_size)

        # ⑤ 双模型确认 suggested_new_kps
        labeled = question_labeler.confirm_new_kps(labeled, fallback_labeler)

        # ⑥ 组装 ExamQuestion，写 JSONL
        _write_exam_questions_jsonl(labeled, source, extracted_dir)
    else:
        # 现有教材卡路径（不动）
        # image_scan → card_splitter → CardLabeler
        ...
```

### 7.2 新增模块

| 模块 | 职责 |
|---|---|
| `question_splitter.py` | 题号切分 + 答案对齐（统一扫描算法，§3） |
| `question_labeler.py` | LLM 标注（type/difficulty/KP）+ 双模型确认新增 KP（§4） |
| `prompts/question_labeler.txt` | 标注 prompt（含难度定义 + 知识点标注约束 + `{{knowledge_points}}` 占位符 + `{{legal_types}}` 占位符） |

### 7.3 修改

- `extract_cli.py`：加 kind 分支 + `--subject`（学科过滤，默认数学）+ `--label-batch-size` 参数
- `publish_cli.py`：不动（已支持 questions）
- `db_loader_cli.py`：后续加处理 `_confirmed_new_kps` 入库 knowledge_points（本次范围外，单独任务）
- 遗留的 `extract.py` 的 `Extractor` 类 + `prompts/exam_questions.txt`：保留不动（不删除，作为遗留参考）

### 7.4 新增 CLI 参数

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--subject` | str | "数学" | 学科过滤。不同学科切题算法可能不同（§10），当前实现数学 |
| `--label-batch-size` | int | 1 | 仅 questions：每 N 题一批调 LLM。0=全部一次，1=每题一次，N=每 N 题一批 |

## 8. 测试策略

### 8.1 单元测试

- **question_splitter**：题号识别正则（含 `9.若代数式` 无空格格式、`9.$\frac{1}{x-3}$` 公式起头、`9.5` 数字小数排除）、小问合并、紧凑格式（一行多题号）、陷阱过滤（2026.5）、答案区检测（"答案"关键字）、答案对齐（紧凑/展开/一题多小问）、主题号剥离 + 小问号保留。用真实 MD 片段做 fixture（从西城模拟二 MD 截取）
- **question_labeler**：mock LLM 测双模型确认逻辑（两个都新增 / 任一不新增 / 名称不同等场景）。测知识点列表动态注入（mock DB 查询返回固定 KP 列表）
- 回归：现有教材卡测试不动，确保 `kind=cards` 路径不破坏

### 8.2 端到端验证

西城模拟二试卷 MD → 切题 → 标注 → 检查 JSONL：
- 每道题 content 完整（不被 400 字切）
- 图片引用保留（`![](images/xxx.jpg)` 在 content 里）
- 答案正确对齐（17. 题答案对应 17. 题题干）
- type / difficulty / knowledge_points 有值
- **不 publish 不入库**（用户明确要求）

### 8.3 失败处理

- LLM 标注失败（网络/JSON 异常）：复用 `_label_with_escalation`（主模型 → 主模型重试 → 兜底模型），全失败时该题 type=""、knowledge_points=[]，不影响其他题入库
- 题号切分无题（空试卷）：JSONL 不写，记 `[ok] 0 items (empty)`
- 答案对齐找不到对应题：写入 `unused_answers` 字段（兜底），正常不发生

## 9. 边界 case

- **答案部分一行多题号**（`9. xxx 10. xxx 11. xxx`）：行内正则切分，每个都按主题号逻辑处理
- **答案里出现题号字符**：如答案文本里写了"参考第 3 题"——用行首/段首正则（`^\s*N\.` 多行模式）+ 紧凑格式行内正则配合，减少误切
- **续页**：zgkao 试卷是单 MD，无跨页问题
- **空题**（切出的某题 content 为空）：跳过，不写入 JSONL
- **答案区没出现的题**：answer = ""，不影响切题
- **大题分组说明文字**（"本题共 8 小题"）：丢弃，不进任何题 content
- **图片引用格式非标准 `![]()`**（如 HTML `<img>`）：本次不处理，依赖 MinerU 输出标准 Markdown 图片语法

## 10. 未决/未来扩展

- **道法/物理/化学等学科的切题算法**：当前实现数学。不同学科题号格式、材料题结构可能不同（如物理有实验题、道法有阅读理解材料题），需学科适配器。`--subject` 参数已预留扩展点
- **`material_text` 抽取**：数学不抽（材料在 content）；道法/物理需要单独拆出共享材料（如阅读理解的多小题共享材料），后续做
- **db_loader 处理 `_confirmed_new_kps`**：本次范围外，单独任务。db_loader 入库时把 `_confirmed_new_kps` 插入 `knowledge_points` 表（生成 code + parent 关系），用新 code 建立 `question_knowledge_points` 关联
- **难度定义细化为学科相关**：当前 5 档通用定义（1 简单/2 中等/3 有一定难度/4 困难/5 超困难）。未来不同学科可能有不同难度维度（如语文的阅读难度 vs 写作难度），留待学科适配时扩展
- **遗留 `Extractor` 类和 `exam_questions.txt` prompt 的去留**：本次保留不动。后续若新路径稳定跑通，可考虑删除遗留代码（避免混淆）

## 11. 实现顺序建议

1. `question_splitter.py` + 单元测试（题号切分 + 答案对齐，先不接 LLM）
2. `question_labeler.py` + `prompts/question_labeler.txt` + 单元测试（mock LLM）
3. 双模型确认新增 KP 逻辑
4. `extract_cli.py` 加 kind 分支 + 新参数
5. 端到端验证（西城模拟二 → JSONL，检查正确性）
6. 回归测试（教材卡路径不破坏）

## 12. 实现修正记录（2026-09-05 → 09-07，真实数据验证后）

以下偏离/补充均为实现中由真实数据（2026 西城/丰台模拟二、DB 结构）验证后确认，更新本文档作为设计真相：

### 12.1 难度改为 5 档（用户追加）

§4.2 已更新为 5 档：1 简单 / 2 中等 / 3 有一定难度（如选择题最后一题）/ 4 困难（复杂证明/多知识点综合/开放探究）/ 5 超困难（新定义、几何压轴题）。`ExamQuestion.difficulty` 校验范围 le=5。

### 12.2 答案合并 Task 4 改为"内容判断"（非文件名）

zgkao 命名反向："试卷.pdf"=有答案版，实际"答案.pdf"=无答案版试卷（纯题干）。文件名只用于配对（"-试卷"↔"-答案"），**是否含答案看内容**：

- `_has_answer_section(text)`：末尾 500 字符含"参考答案/答案及评分/评分参考"关键字，或全文"解：/证明："≥5 次
- `_is_pure_answer(text)`：有答案部分 且 无选择题选项 (A)-(D) 无题干词（如图/下列）

`maybe_merge_answer_md` 5 case：
1. 只有一份文件 → 用它
2. 两份都有答案 → 留试卷，丢答案
3. 试卷有答案 + 答案纯题干 → 留试卷，丢答案
4. 试卷无答案 + 答案有答案 → 4a 纯答案则合并；4b 试卷+答案版则用答案文件
5. 两份都无答案 → 用试卷（answer 留空，做题时大模型补）

### 12.3 每题分数 full_score（用户追加）

`parse_group_scores` 从分组标题解析每题满分：
- "每题N分"（选择/填空）→ unified 组内统一分
- "第A-B题每题N分，第C题M分"（解答题）→ 逐题 map，范围展开
- 兼容全/半角括号逗号；"共78分"无逐题分 → none

链路：`RawQuestion.score` → `LabeledQuestion.score` → JSONL `full_score` → `ExamQuestion.full_score` → DB `questions.full_score`（schema.sql 加列）。真实西城全卷 100 核对通过。

### 12.4 真实数据暴露并修复的 bug（question_splitter）

- `_GROUP_HEADER_RE` 需兼容 markdown `#` 前缀（真实标题 "## 一、选择题"）
- `_ANSWER_KEYWORD_RE` 不匹配单独"答案"（"考生须知"里"试题答案"误触发答案区）
- `split_inline_stems` 跳过含 `\begin{`/`\end{`、`![](`、`解：/证明：/∵/∴/\therefore` 的行——防 LaTeX 小数（"b=2."）、图片文件名（"a3.jpg"）误匹配为题号
- 新增 `parse_answer_table`：选择题答案在 HTML `<table>` 里（非紧凑格式），解析行提取题号→答案

### 12.5 双模型确认新增 KP 的真实行为

主模型（本地 Qwen3.8-27B）多数遵守 prompt 约束（从已有 KP 选，suggested_new=[]）；偶发建议新增。DeepSeek 兜底确认——71 个 KP 缺相交线/平行线章时，双模型一致判"邻补角/对顶角/垂直的定义"为真新增（AND 逻辑触发）。已补 M09 章种子（见 12.7）。

### 12.6 extract_cli kind 分支 + 按卷重载（接入验证新增）

- `extract_cli.py` main 循环分流：文件名含"试卷"→ question_extract 新路径；含"答案"→ skip（内容由配对试卷 `maybe_merge_answer_md` 吸收，避免重复入库）；教材卡走原逻辑。
- `question_extract.py`：试卷 MD → maybe_merge_answer_md → split_page → QuestionLabeler（+双模型确认）→ ExamQuestion JSONL。KP 列表每次从 DB 动态查（不写死）。
- `db_loader_cli --reload-source "<source>"`：删该卷题（paper_questions/QKP CASCADE 连带）后重插；业务表（answers/错题本/变式题 RESTRICT）引用时需 `--purge-paper-data` 显式清理。
- publish 物化图引用改写为相对路径 `questions/{subject}/{hash}/{idx}/stem_NN.jpg`（无 /assets/ 前缀，前端经 /assets 代理）。

### 12.7 KP 种子补 M09 相交线与平行线（2026-09-06）

71 个 KP 缺相交线与平行线整章。`tools/db/migrations/2026-09-06_add_kp_intersecting_parallel.sql` 补 M09（相交线/垂线/同位角内错角同旁内角/平行线的判定/平行线的性质/命题定理与证明/平行线间的距离），79 个。验证：西城题3（直线相交求角）标注从误标 M0403 修正为 M0901/M0902，suggested_new_kps 清空。

### 12.8 JSONL 扩展字段确认

下划线前缀字段 `_confirmed_new_kps` / `_suggested_new_kps` publish 原样保留；`full_score` 标准字段贯通到 DB。db_loader 处理 `_confirmed_new_kps` 入库 knowledge_points（code 生成 + parent 策略待定）**未实现**——本次西城无确认新 KP 数据（KP 补齐后 LLM 不再滥建），留待有实际触发时按 §10 待办实现。
