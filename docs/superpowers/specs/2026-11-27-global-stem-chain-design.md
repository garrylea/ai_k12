# 题号识别的全局最优链设计

日期：2026-11-27
状态：草案 v2，待评审
修订：2026-11-27
关联模块：`tools/data-refinery` 的题干切分（`question_splitter.py`）、题号复核（`question_extract.py`）、答案对齐（`answer_blocks.py`）

**核心裁决**：先做确定性硬过滤，再做题号候选的全局序列对齐；只有前两名合法链无法区分时，
才把**整个歧义区间**交给本地 LLM 做闭集联合选择。LLM 不逐行回答「是不是题」，
也不能发明候选项、修改锚点或绕过题号/行号顺序约束。

## 1. 背景与问题

当前切题器在逐行扫描时**就地决定**某行是不是新题号：先跑主正则 `is_main_stem`，
失败后依次尝试选择题区的小数例外、解答题的粘连数字例外、孤立点例外、裸题号规则，
能接受就立刻建题，不能接受就把该行当上一题的续行。这个模式是**局部贪心**：
单行证据不足就永久丢弃，后面的行再正确也救不回来。

2026-11-27 连续出现两起同类事故：

| 卷 | 现象 | 直接原因 |
|---|---|---|
| 北京各 85487 | 第 23/24 题答案串题；第 2/12/15 等 11 题答案被切坏 | 答案数字 `2 4 0`、`- 4 x`、`$15cm$` 被当成题号 |
| 北京各 85434 | 第 24/25 题题干与答案都混在一起 | 题干 `25.16 世纪中叶…` 被判为小数 `25.16`，第 25 题没切出来 |

85434 的原 md 第 188/196/212 行：

```text
188: 24. 如图, 在 △ABC 中, AB = AC, …
196: 25.16 世纪中叶，我国发明了一种新式火箭 …
212: 26. 在平面直角坐标系 xOy 中，点 (2, c) …
```

第 196 行的 `25.` 与正文「16 世纪」的 `16` 粘在一起，主正则明确排除「数字.数字」，
于是扫描结果只有 `[23, 24, 26, 27, 28]`：

```text
[WARN] 题号跳跃 1 处（24→26@212）
Q24 content 尾部出现火箭题的两张图
Q24 answer 尾部出现「解得 x = 11.4」（第 25 题答案）
```

答案之所以跟着错，不是答案解析器单独出错，而是答案对齐拿题干切出的**题号列表**
当槽位；列表里没有 25，答案区的 `25.【答案】` 无处安放，只能并进第 24 题。
这证明题号识别是整条数据管线的根，不能靠给答案侧加例外来兜。

现有代码已在 `question_splitter.py:1093-1101` 加了一个「粘连数字 == 上一题+1 且后接成段中文就接受」的
局部补丁，在 `answer_blocks.py` 加了「题号单调递增才另起块」的局部补丁。两个补丁能过
当前夹具，但都是单行规则，换一种 OCR 形态就会再次失手。本设计用**全局题号链**替代这类补丁。

## 2. 目标与非目标

### 2.1 目标

1. 把「某行是不是题号」从**单行判定**改为**区间内多选一 + 全局链校验**：只在能和前后
   确信题号连成完整序列的候选中挑最优解。
2. 确信无误的题（锚点）一旦确定不再被候选覆盖；候选只会填空，不会改锚点。
3. 同一行可以产生多个**题号解释**。例如 `2.` 既可解释为字面题 2，也可在区间和个位序列
   同时吻合时解释为 OCR 丢了十位的题 12。
4. 强负证据是硬否决，不允许被若干小正分抵消。候选证据必须可解释，不使用黑盒置信度分数。
5. 全局链不只保留一条最高分路径，而保留前两条合法路径并计算分差。前两名打平或分差不足时，
   进入 LLM 仲裁，不能按行号先到先得。
6. LLM 仲裁以**一个歧义区间**为粒度，输入完整候选集合与待填题号，输出闭集内的一一分配；
   不沿用现有逐候选判断 `is_stem=true/false` 的口径。
7. 链接不上时报明确 issue（缺哪几个题号、候选在哪几行），不许静默吞题、不许硬凑。
8. 复用现有 `forced_stem_lines` 第二遍切题机制，不重写题干、材料、选项、小问的组装逻辑。
9. 同时覆盖题干区题号；答案区题号暂沿用现有块解析，但在设计中预留同一套候选/链选择抽象。

### 2.2 非目标

- 不改份数/大题分组、试卷元数据、材料归属、选项拆分、道法小问扩展等既有规则。
- 不改语文独立答案策略、英语区间答案适配。
- 不改数据库 schema、导入格式、`answer_verified` 语义。
- 不自动写库、不自动覆盖 `answer_verified=1` 的内容。
- 不追求识别所有历史错卷；本次以 85434/85487 及现有语料基线为准。
- 不让 LLM 自由生成题号或行号；模型只能在规则生成的候选集合中选择。
- 本设计中的新链仲裁只使用 refinery 配置的本地 LLM；本地模型不可用时不回退到远程模型。

## 3. 术语

| 术语 | 定义 |
|---|---|
| 锚点（anchor） | 证据充分、无需全局信息即可确认的题号行。题号固定，不参与竞争。 |
| 候选行（candidate） | 可能是题号、但单行证据不足以确认的行。一行可携带多个题号解释。 |
| 候选解释（option） | 同一行的一种题号解释，包含原始数字、最终题号、形态、恢复方式与证据。 |
| 题号链（chain） | 一组按行序排列、题号严格递增且尽量连续的题号节点。 |
| 断点（gap） | 两个相邻锚点之间缺少某个应有题号，且没有候选能补上。 |
| 确信区间 | 相邻两个锚点之间的行区间，候选选择只在这个区间内进行。 |
| 安全前缀（safe prefix） | 从左锚点开始连续成立、且每个候选都通过硬过滤的高置信链段。出现缺号时可保留该前缀，不能保留断开的后半段。 |
| 歧义区间（ambiguity） | 存在两条以上合法链，且最优链与次优链的分差不足以自动裁决的区间。 |

## 4. 现状算法为什么不够

`question_splitter.py:1084-1132` 的单行判定链：

```text
is_main_stem
  → 选择题区「数字.数字 + 后续更大题号」
  → 解答题「数字.数字 == last+1 且后接中文」
  → 孤立点「. 后接成段中文」
  → 裸题号 _bare_stem_ok / suspects_out
```

问题：

1. **证据没有累积**。`25.16` 单行看像小数，但它同时满足「上一题+1」「段落首行」
   「后接 120+ 字中文正文」「后面有第 26 题」四条正向证据；当前实现只因为第一条
   「数字.数字」就否决。
2. **没有竞争**。同一段里若出现两个数字候选，当前实现按行序先到先得，无法选证据更强的那个。
3. **无法识别假链**。正文里的 `约为 12.2 米`、`解得 x = 11.4` 单独看都像题号，
   当前靠一堆「不得是」例外去堵，每堵一个又漏一个。
4. **LLM 调用太晚**。`suspects_out` 只收集裸题号候选；`25.16` 这类粘连数字根本进不了
   LLM 复核队列（`question_extract.py:747-754` 两遍切题）。

## 5. 总体设计

### 5.1 处理流水线

```text
第一遍扫描（不改状态机）
  ├─ 收集锚点 + 候选行（含原始数字、候选解释、证据标签、行号、上下文）
  ├─ 切出确信区间
  └─ 输出 StemCandidate 列表（不建题）

候选解释与硬过滤（纯函数）
  ├─ 为每行生成 0..N 个题号解释（含 OCR 丢十位等可恢复解释）
  ├─ inside_math / answer_region / score_note 等强负证据直接淘汰
  └─ 只把通过硬过滤的解释送入链选择

全局链选择（纯函数）
  ├─ 在每个确信区间内做 top-2 序列对齐
  ├─ 唯一强链：直接 accepted
  ├─ 前两名打平或分差不足：输出 ambiguity
  └─ 无完整链：只接受从左锚点连续成立的安全前缀，其余记 gap

歧义仲裁（仅本地 LLM）
  ├─ 每卷批量收集 ambiguity；每个区间形成独立 assignment，可合批但不得混合候选集
  ├─ 输入左/右锚点、待填题号、全部候选解释及上下文
  ├─ 模型只在候选 ID 中做一一分配，输出后做顺序、唯一性、闭集校验
  └─ 无法得到合法分配：保留 gap，不猜

最终切题（复用现有状态机）
  ├─ accepted + 已校验的 LLM 分配作为 forced_stem_map 传入
  └─ 其余题干/材料/选项/小问组装逻辑完全不变
```

关键约束：**第一遍只读，不建题**。所有候选先摆在同一张表里，由全局链决定谁上岗。
这样 `25.16` 不再是「单行被否决」，而是「区间 24→26 中填补 25 的唯一候选」。
同理，锚点 11→15 之间连续出现 `2.`、`3.`、`4.` 时，规则可以生成
`2→12`、`3→13`、`4→14` 的恢复解释，但必须由全局顺序和上下文共同支持。

### 5.2 与现有 `forced_stem_lines` 的关系

现有第二遍只接受 `set[int]`，且强制逻辑只挂在裸题号分支
（`question_splitter.py:1116-1118`）。本设计把它升级为：

```python
forced_stem_map: dict[int, tuple[int, str, str]] | None
# 行号(0基) -> (最终题号, 形态, recovery)
# 形态 ∈ {"main", "bare", "glued_number", "orphan_dot", "inline_glued"}
# recovery ∈ {"exact", "glued_suffix", "missing_dot", "dropped_tens"}
```

`split_page()` / `split_page_result()` 保留 `forced_stem_lines: set[int] | None`
参数作为兼容入口；新参数非空时优先，内部统一转成 map。
形态决定用哪个前缀剥离函数：

| 形态 | 前缀剥离 | 例子 |
|---|---|---|
| `main` | `_strip_main_stem_prefix` | `24. 如图…` |
| `bare` | `_strip_bare_prefix` | `11 在平面直角坐标系…` |
| `glued_number` | `_strip_main_stem_prefix`（剥 `25.`，保留 `16 世纪…`） | `25.16 世纪中叶…` |
| `orphan_dot` | 剥行首孤立点 | `．题干…` |
| `inline_glued` | 走现有 `_split_glued_next_stem()` 专用分支 | `…楼房。16.根据…` |

`dropped_tens` 是解释来源，不是另一种前缀形态：`2. …` 仍按 `main` 剥离原文的 `2.`，
但最终题号可为 12。日志必须同时记录 `raw_number=2`、`number=12`、`recovery=dropped_tens`。

## 6. 数据结构

```python
@dataclass(frozen=True)
class StemEvidence:
    tag: str            # 见 §8.2-§8.3
    polarity: str       # positive | negative | veto
    detail: str = ""    # 可解释说明，如 "line_no=196 单独成段"

@dataclass(frozen=True)
class StemOption:
    candidate_id: str            # 区间内稳定 ID，供本地 LLM 闭集选择
    raw_number: int | None       # 原文前缀直接读到的数字，如 `2`、`12`
    number: int                  # 最终解释出的题号，如 `2 → 12`
    form: str                    # main | bare | glued_number | orphan_dot | inline_glued
    recovery: str                # exact | glued_suffix | missing_dot | dropped_tens
    evidence: tuple[StemEvidence, ...]
    content_rest: str            # 剥掉题号后的正文，供链选择校验

@dataclass(frozen=True)
class StemCandidate:
    line_no: int                 # 0 基，与 text.split('\n') 对齐
    text: str                    # 原文，最长 160 字
    options: tuple[StemOption, ...]
    context_before: str
    context_after: str
    anchor: bool                 # True = 锚点，题号固定

@dataclass(frozen=True)
class StemPath:
    assignments: tuple[tuple[int, str, str], ...]  # (行号, 题号, candidate_id)
    rank_key: tuple                               # 见 §9.1，前项优先
    selected_options: tuple[StemOption, ...]

@dataclass(frozen=True)
class StemAmbiguity:
    reason: str                        # ambiguous | high_risk_recovery
    left_anchor: int
    right_anchor: int
    expected_numbers: tuple[int, ...]
    candidates: tuple[StemCandidate, ...]
    top_paths: tuple[StemPath, ...]    # 最多保留前两条

@dataclass(frozen=True)
class StemChainResult:
    accepted: dict[int, tuple[int, str, str]]  # 行号 -> (题号, 形态, recovery)
    gaps: list[tuple[int, int, int]]          # (区间起点题号, 缺失题号, 行号)
    ambiguities: list[StemAmbiguity]
    safe_prefix: dict[int, tuple[int, str, str]]  # 与 accepted 合并；单独留痕便于诊断
```

`raw_number != number` 时必须在 `recovery` 和 evidence 中说明恢复依据；禁止无痕改号。
`candidate_id` 只在当前区间内有效，不能用题号代替，避免同一题号多个候选时 LLM 混淆。

`StemChainResult.gaps` 与现有 `jump_warnings` 分开：前者表示「链没接上」，后者表示
「锚点之间出现真跳号」，两者 issue 不同。

## 7. 锚点判定

锚点必须满足**全部**条件，宁少勿多：

1. `strategy.is_stem(line)` 返回真，且形态是标准 `N.` / `N．` / `N、` / `N：`；
2. 剥掉题号前缀后正文长度 ≥ 6，且含中文或含 `$` 数学环境；
3. 题号严格大于上一个锚点题号（**不要求 +1**；锚点之间允许缺号，这正是
   链选择要填的区间。首个锚点允许从 1 或卷面最小题号开始）；
4. 不在表格内、不是卷首说明、不是卷末 `要求：1. …` 评分细则（复用 `_JUNK_QUESTION_RE`、`_NOTICE_RE`）；
5. 是全卷同题号的 `main` 形态候选中排序最高者（重复题号取先出现者），
   避免把重复题号当锚点。该比较只看单行证据，不需要链选择。

锚点一旦确定，写入 `anchor_lines` 并锁定题号；后续链选择只能填两个锚点之间的空号，
不能改锚点题号、不能挪锚点行。

若首个锚点不是 1，前面区间 `[1, first_anchor_no)` 单独走一次链选择，允许空结果。

## 8. 候选生成、硬过滤与排序

### 8.1 候选来源

对每个**非锚点**行，依次尝试生成候选解释；同一行可有多个 `StemOption`。
`raw_number` 是原文直接读到的数字，`number` 是该解释最终对应的题号：

| 来源 | 形态 | recovery | 原始 → 题号 | 触发条件 |
|---|---|---|---|---|
| `is_main_stem` 命中但未过锚点条件 | `main` | `exact` | `12.…` → 12 | 主正则命中（如题号重复、正文过短） |
| `_AMBIGUOUS_NUM_RE` 命中 | `glued_number` | `glued_suffix` | `25.16 世纪…` → 25 | `N.` 后紧跟数字 |
| `_ORPHAN_STEM_DOT_RE` 命中 | `orphan_dot` | `missing_dot` | `．题干` → 上一题+1 | 题号点被单独拆行 |
| `_bare_stem_candidate` 命中 | `bare` | `missing_dot` | `11 在平面…` → 11 | OCR 丢了点 |
| `_GLUED_STEM_RE` 命中 | `inline_glued` | `exact` | `…楼房。16.根据…` → 16 | 上一行句末粘连下一题 |
| 区间内丢位恢复 | `main` / `bare` | `dropped_tens` | `2.…` → 12 | 见下文 |

`_GLUED_STEM_RE` 在当前主循环中已有专用分支（`question_splitter.py:1022-1035`），
它发生在题号判定之前。候选收集器必须**复用同一个 `_split_glued_next_stem()` 判定**，
并在生成 `forced_stem_map` 时标记该行已被专用分支消费；第二遍遇到已被消费的行
不得再按普通候选处理，避免重复建题或把题干拆两截。

**候选必须落在某个确信区间内**（两个相邻锚点之间，或首尾边界之间）。区间外的候选直接丢弃，
防止答案区、页脚、评分细则进入候集。

**丢十位恢复不是通用兜底规则**。只有同时满足以下条件才生成 `dropped_tens` 解释：

1. `raw_number` 为 1–9，期望题号 `expected >= 10`，且二者个位相同；
2. 该行位于两个锚点之间，不能跨大题/部分边界；
3. 行首是独立题号形态，`content_rest` 像成段题干，不是量词、分值或小问；
4. 同一区间内，产生恢复解释的候选与待填题号按行序一一对应；
5. 恢复解释保留高额恢复代价，并在最终自动采纳前强制要求本地 LLM 确认。

例如锚点 11、15 之间只有 `2.`、`3.`、`4.` 三行成段文本时，可以生成
12、13、14 三个候选解释；若其中夹着 `2 个`、`3 分` 等数据行，对应解释先被硬否决。

### 8.2 硬过滤

以下证据直接否决该候选解释，不进入候选链，也不允许被其它正证据抵消：

| 标签 | 含义 |
|---|---|
| `inside_math` | 候选位于 `$...$` / `$$...$$` 公式内 |
| `after_operator` | 候选前紧邻 `= + - × ÷`、字母或数字，属于算式续行 |
| `answer_region` | 候选位于参考答案/评分参考区 |
| `page_marker` | 命中页码、页眉页脚或卷面 chrome |
| `notice_junk` | 命中卷首说明、命题人/审核人、评分细则 |
| `score_note` | 命中分值说明或「评分参考」类文本 |
| `data_line` | 题号后以量词/单位开头（`2 个`、`3 分`、`15cm`） |
| `sub_question_only` | 行首是小问 `(1)` / `（2）`，没有主题号前缀 |
| `out_of_interval` | 字面题号与恢复题号都不在当前待填集合 |
| `section_reset_unsupported` | 候选需要跨大题题号重置才能成立（本期不支持） |

`inside_math` 判定复用 `answer_blocks._is_inside_math()` 的成对切换逻辑，
但题干区应单独实现为只读谓词，避免 `answer_blocks` 与 `question_splitter` 反向依赖。

### 8.3 候选排序

通过硬过滤后，候选按可解释的结构证据排序。这里不采用单一总分，避免多个弱正分
抵消一个强负分：

```text
rank_key = (
    recovery_cost,
    -paragraph_score,
    -stem_score,
    -context_score,
)
```

- `recovery_cost`：`exact=0`、`glued_suffix/missing_dot=1`、`dropped_tens=3`。
- `paragraph_score`：前有空行、独立成段、上一段句末结束、后文形成新段等结构证据数。
- `stem_score`：题号后正文长度、含中文/公式、含「求/证明/如图/已知」等题干词。
- `context_score`：后续还有更大锚点、与相邻候选题号顺序协调、答案区存在同题号提示等。

排序结果只用于形成候选链，**不得在进入链选择前按题号只留最高分候选**。
同一题号可以保留多个解释，因为局部最高分候选可能导致行号顺序不合法，而次高分候选
才能与前后题号组成合法链。

`dropped_tens` 即使形成唯一完整链，也标记 `high_risk_recovery`，必须经过本地 LLM
确认；模型不可用或返回不合法时按 gap 处理。

## 9. 链选择算法

### 9.1 区间内 top-2 序列对齐

设区间起锚点题号为 `a`（行 `la`），止锚点题号为 `b`（行 `lb`），`b = a + k`。
需要为 `a+1 … b-1` 每个题号挑一个候选，且行号严格递增：
`la < row(a+1) < ... < row(b-1) < lb`。

```text
paths[n] = 以题号 n 结尾、最多两条最优合法链
           n = a 时只有一条空链，行号 = la

对每个 n in (a+1 … b-1):
    对每条 prev in paths[n-1]:
        对每个 option with option.number == n and option.line_no > prev.last_row:
            扩展成新链
    按链级 rank_key 去重并保留前两条
    paths[n] = 前两条合法链

终点校验：每条 path 的最后行号 < lb
```

链级 `rank_key` 是对所选候选的汇总：先比较总 `recovery_cost`，再比较段落、题干和上下文
证据。若两条链的所有比较项相同，则它们属于真正的并列，行号只用于稳定日志排序，
**不能作为自动裁决依据**。

自动裁决阈值 `CHAIN_MARGIN` 的初值为 2 个结构证据项：

- 两条链 `recovery_cost` 不同：低成本链优先；
- `recovery_cost` 相同：最优链的段落/题干/上下文证据合计至少领先 2 项才自动采纳；
- 领先少于 2 项：视为“无法确认”，进入本地 LLM；
- 阈值只用语料校准，不写死在 prompt 中，也不交给 LLM 判断。

选择规则：

1. 只有一条完整合法链，且不含 `dropped_tens`：自动采纳。
2. 有两条完整合法链，但第一名分差达到配置阈值：自动采纳第一名。
3. 两条链打平或分差不足：生成 `reason=ambiguous` 的 `StemAmbiguity`。
4. 唯一合法链含 `dropped_tens`：生成 `reason=high_risk_recovery` 的 `StemAmbiguity`，
   仍交给本地 LLM 确认。
5. 没有完整链：从 `a+1` 开始逐个检查。只有该题号恰好有一个候选、且该候选满足上面的
   自动裁决阈值时，才加入安全前缀；遇到缺失、多个候选分差不足或高风险恢复即停止。
   从停止题号起记 gap，不采纳断开的后半段，避免半截链错位。

安全前缀示例：锚点 24、27 之间只有高置信的 25，没有 26。此时采纳 25，让 Q24 正确结束，
再报 `stem_chain_gap(25→26)`；不能因为缺 26 就把 25 也丢掉，让 Q25/26 一起并进 Q24。

### 9.2 歧义与异常形态

- 同一题号多个候选：全部留给 top-2 链选择，不提前取局部最高分；最终并列时交 LLM。
- 题号回退候选（字面题号和恢复题号都 `n <= a`）：硬过滤后记
  `stem_chain_out_of_order`，不进入链。
- 题号跳跃候选（`n > a+1`）：只有中间题号都能按行号补成连续链时才成立，否则进 gap 诊断。
- 锚点题号本身不连续（真跳号，如 `18→21`）：保留现有 `jump_warnings` 口径，
  不把缺失题号强行塞给候选。
- 同一候选区间存在多组可互斥解释（如 `12.8` 和 `12.16` 都能当第 12 题）：
  两候选都必须出现在 `StemAmbiguity.candidates` 中，不能先按行号选靠前者。
- `2→12` 这类丢十位恢复必须携带 `raw_number != number` 和 `recovery=dropped_tens`；
  日志中显示为「候选行 X：原文 2，恢复为 12」，不得伪装成原文就是 12。

### 9.3 复杂度

候选数量级为每页几十行，区间长度通常 ≤ 12。每个题号只保留前两条链，
复杂度为 `O(k × C × 2)`，`C` 为区间内候选解释数，可忽略。
禁止引入全卷级搜索；全卷不作为单个序列图处理，仍按相邻锚点切区间。

## 10. 与现有流程集成

### 10.1 函数调用链

```text
extract_questions_file (question_extract.py:709)
  ├─ collect_stem_candidates(text, strategy)         # 新增，第一遍只读
  ├─ select_stem_chains(candidates, anchors)         # 新增，硬过滤 + top-2 链
  ├─ arbitrate_stem_ambiguities(local_llm, ambiguities)
  │    ├─ 每个区间一个请求（或同一卷小批合并）
  │    └─ 闭集选择 + 顺序/唯一性/题号校验
  ├─ accepted |= validated_llm_assignments
  └─ split_page(text, forced_stem_map=accepted)      # 第二遍，现有状态机
```

`split_page()` 现有签名和 `forced_stem_lines: set[int]` 保留；新增 `forced_stem_map`
为可选参数，老调用方零改动。

现有 `_judge_suspects()` 是「逐行判断裸题号」的旧兜底。设计落地后：

- 规则已形成唯一强链时不再调用它；
- 所有需要 LLM 的歧义统一走新的区间仲裁；
- 迁移期间可保留旧函数处理尚未纳入新候选来源的裸题号，但一旦对应来源已接入，
  同一行不得再次逐行送 LLM，避免两份结论互相覆盖。

### 10.2 本地 LLM 输入、输出与校验

本地 LLM 只做闭集仲裁，不自由生成题号或行号。

输入必须包含：

- 稳定 `interval_id`；
- 左、右锚点的题号、行号和原文；
- 待填题号集合 `a+1 … b-1`；
- 区间内所有通过硬过滤的候选：
  `candidate_id / line_no / raw_number / number / recovery / 证据标签 / 前后文`；
- `reason=ambiguous` 时最多两条完整链的差异；
- `reason=high_risk_recovery` 时恢复前后的数字和恢复依据。

输出契约为：

```json
{
  "intervals": [
    {
      "interval_id": "C11-13",
      "result": "resolved",
      "assignments": [
        {"number": 12, "candidate_id": "L100-O1"}
      ]
    },
    {
      "interval_id": "C24-26",
      "result": "resolved",
      "assignments": [
        {"number": 25, "candidate_id": "L196-O1"}
      ]
    }
  ]
}
```

每个区间独自校验。`result` 只允许 `resolved` 或 `unresolved`。
`resolved` 必须覆盖该区间全部待填题号；
无法唯一分配时返回 `unresolved`，不得猜测。

服务端逐项校验，任一项失败即整条 LLM 结论作废：

1. `interval_id` 必须来自请求，候选只能来自该区间的集合；
2. `candidate_id` 必须来自请求；
3. 题号必须等于该区间的待填题号，不允许模型改号；
4. 一个题号只能选一个候选，一个候选只能用一次；
5. 分配后的行号必须严格递增，并位于左右锚点之间；
6. `raw_number != number` 的恢复解释仍保留原恢复标签，不能变成 `exact`。

校验失败写 `stem_chain_llm_invalid`，成功写 `stem_chain_llm_resolved`。
模型返回 `unresolved` 或本地服务不可用时保留规则结果与 gap，不回退远程模型，
也不阻断其它区间。

### 10.3 第一遍扫描的复用边界

`collect_stem_candidates()` 只识别题号，**不**处理：材料分段、选项拆分、小问扩展、
分数、group scope、junk 题过滤。这些仍由第二遍的 `_split_questions_only()` 处理，
避免两套状态机对同一行做出不同结论。

但锚点判定需要复用现有谓词：`is_main_stem`、`_JUNK_QUESTION_RE`、`_NOTICE_RE`、
`is_part_header`、`is_group_header`、`is_answer_keyword`。这些函数从 `question_splitter.py`
导入，不复制规则。

### 10.4 答案侧

答案块解析继续用 `answer_blocks.py` 的块级强/弱边界规则。本设计不改变答案解析算法，
但要求答案侧把「题号必须来自题干链结果」作为硬约束：

- 题干链确认的题号集合即答案期望集合（现状已是如此）。
- 解答题正文里的 `11.4 - 3 = 8.4` 一类小数/算式，由答案块的「题号递增 + 强边界」
  规则拦截；当前 `split_answer_blocks` 的单调递增守卫是过渡实现，实施本设计后
  保留为防御层，不删除。
- 未来若答案区也出现同类全局错位，复用本设计的 `StemOption/StemEvidence/top-2 链`
  抽象，在 `answer_blocks.py` 内实现独立链选择，不跨模块共享状态。
- 答案区能稳定解析出的题号可作为一个独立的 `context_score` 提示，用于辅助确认
  `2→12` 类恢复；但它不能单独决定题干边界，也不能覆盖题干侧硬否决。

## 11. issue 字典

| code | severity | 触发条件 |
|---|---|---|
| `stem_chain_gap` | error | 区间内某题号无候选，题号链断开 |
| `stem_chain_ambiguous` | warning | 前两条合法链并列或分差不足，已进入 LLM 仲裁 |
| `stem_chain_high_risk_recovery` | warning | 唯一链包含 `dropped_tens`，必须经本地 LLM 确认 |
| `stem_chain_out_of_order` | warning | 字面题号和恢复题号都回退或超出区间 |
| `stem_chain_llm_resolved` | info | 本地 LLM 的闭集分配通过全部校验 |
| `stem_chain_llm_unresolved` | warning | 本地 LLM 明确无法形成唯一合法分配 |
| `stem_chain_llm_invalid` | warning | LLM 返回越界候选、重复分配、乱序或漏填 |
| `stem_chain_anchor_conflict` | error | 两个锚点题号相同，无法建区间 |

所有 issue 必须带 `line_no`（1 基，面向用户）和 200 字以内的原文摘要。
`stem_chain_gap` 不阻断其它题的切分；安全前缀和已有题保留。
`stem_chain_llm_*` 只描述仲裁过程，不改变原始题号；原始映射必须另写结构化日志。

## 12. 边界与反例

| 输入 | 期望行为 |
|---|---|
| `25.16 世纪中叶…` 夹在锚点 24、26 之间 | 选为第 25 题，形态 `glued_number`，正文从「16 世纪」开始 |
| 锚点 11、13 之间出现 `10.5`、`12.8`、`12.16` | `10.5` 解释成 10，不属于待填 12，淘汰；`12.8`/`12.16` 都保留为题 12 候选，由段落/题干证据排序 |
| 上例中 `12.8`、`12.16` 的规则证据仍并列 | 形成 `reason=ambiguous`，把两条候选交给本地 LLM 二选一；禁止按行号靠前者自动选中 |
| 锚点 11、15 之间只有 `2.`、`3.`、`4.` 三行成段题干 | 生成 `2→12`、`3→13`、`4→14` 的 `dropped_tens` 恢复链，并由本地 LLM 确认后才采纳 |
| 上例中 `3.` 后面紧跟「个/分/cm」等量词 | 该行命中 `data_line` 硬否决，不参与恢复链；缺 13 时只保留安全前缀并报 gap |
| 锚点 8、9 之间出现 `9.5 米` | 区间 `8→9` 无中间题号，候选不进链；记 `stem_chain_out_of_order` |
| 锚点 24、26 之间同时有 `25.16 世纪…` 和裸 `25 如上所述` | 两条都作为题 25 候选；段落/题干证据可分出唯一强链则采纳，否则交 LLM 二选一 |
| 锚点 24、27 之间只有高置信的 25、没有 26 | 接受安全前缀 25，Q24 正确结束；记 `stem_chain_gap(25→26)`，不把 25/26 一起并进 Q24 |
| 答案区的 `11.4 - 3 = 8.4` | 区间判定为答案区外，不进题干候选；由答案块规则处理 |
| 本地 LLM 返回候选之外的 ID，或把同一行分给两个题号 | 整条 LLM 结论作废，记 `stem_chain_llm_invalid`，保留规则安全前缀和 gap |
| 题号重复锚点（同一题号两处 `is_main_stem` 命中） | `stem_chain_anchor_conflict`，保留第一次出现，第二个转候选 |
| 卷首说明 `4. 命题人: …` | `_JUNK_QUESTION_RE` 命中，不作为锚点也不作为候选 |
| 卷末 `要求：1. 文体不限 2. 字数…` | 第 20 题后回到个位数，沿用现有合并规则，不生成候选 |

## 13. 测试策略

### 13.1 纯函数单测（新增 `tests/test_stem_chain.py`）

- 候选解释：`12.8` / `12.16` 都能生成题 12 的 `glued_suffix` 候选。
- 候选解释：锚点 11→15、候选 `2/3/4` 在条件满足时生成 `12/13/14`，
  `raw_number` 与 `number` 各自保留。
- 硬过滤：`inside_math` / `after_operator` / `data_line` 命中后直接淘汰，
  不能靠其它正证据重新入链。
- top-2：局部最高分的题 12 因行号在题 13 之后而不合法时，次高分题 12 仍能组成合法链。
- top-2：两条链所有 rank 项相同，产出 `reason=ambiguous`，不能按行号自动选中。
- 唯一强链：只有一条合法链且不含 `dropped_tens` 时，零 LLM 调用直接采纳。
- 高风险恢复：唯一链含 `dropped_tens` 时，必须产生 `high_risk_recovery`。
- 安全前缀：`24→25→gap→27` 采纳 25 并报缺 26，不把整段候选都丢弃。
- 行号顺序：候选行号不满足严格递增时，该链不成立。
- 锚点：junk/notice/表格内行不成为锚点。
- 形态：`glued_number` 前缀剥离后正文保留 `16 世纪…`。
- LLM 校验：候选 ID 越界、漏填、重复使用、题号不匹配、行号乱序时整条结果作废。
- LLM 不可用：不回退远程模型，保留规则安全前缀与 gap。

### 13.2 真实夹具回归（`tests/test_question_splitter.py`）

- 合成卷：锚点 11、13，中间 `10.5/12.8/12.16`；规则可分时直接选 12，
  规则打平时本地 LLM 只在 `12.8/12.16` 中二选一。
- 合成卷：锚点 11、15，中间 `2/3/4`；生成 12/13/14 恢复链，
  LLM 确认前不改切题结果。
- 85434：`25.16 世纪中叶…` → 题号列表含 25；Q24 content 不含火箭题干和图；
  Q25 answer 以 `-2/27 < a < 0` 结尾。
- 85487：`2 4 0`、`- 4 x`、`$15cm$` 不新切题；答案 23/24 不串。
- 顺义 2025：裸题号 `9 $x$ 10 $y$` 仍按第 9/10 题切。
- 昌平一中：子题号 `1.1 材料` 不被切成两道第 1 题。
- 清华附中：`22→33→24` 十位错认仍纠正为 23。
- 汇文：`18` 排在 `14` 前的乱序不误合并。

### 13.3 语料基线

对 `output/md` 下全部数学卷跑新旧切题对比：

- 题号集合变化必须逐卷列出，新增/消失的题号要有对应 issue 或人工确认。
- 不得出现新的 `content` 串题（上一题尾部出现下一题题干关键词）。
- 答案片段长度统计：变长计为修复，变短逐条抽查（参照 2026-11-27 已核过的 8 条旧错值）。

## 14. 实施步骤

| 步骤 | 内容 | 完成判据 |
|---|---|---|
| 1 | 新增 `StemCandidate/StemOption/StemEvidence/StemPath/StemAmbiguity/StemChainResult` 与硬过滤函数，不动主链 | 数据结构与硬过滤单测全绿 |
| 2 | 实现 `collect_stem_candidates()`：直接题号、粘连数字、裸题号、孤立点、行内粘连、`dropped_tens` 六类解释 | 85434 候选含 25 的 `glued_suffix`；合成卷出现 `2→12` |
| 3 | 实现 `select_stem_chains()` top-2 序列对齐与安全前缀 | §13.1 的链选择单测全绿 |
| 4 | 实现 `arbitrate_stem_ambiguities()`、独立 prompt 和闭集结果校验；仅注入本地 LLM | 歧义/高风险恢复模拟测试全绿，零越界采纳 |
| 5 | 升级 `forced_stem_map`，第二遍切题接受全部候选形态 | 现有 `forced_stem_lines` 测试全绿 |
| 6 | 接入 `extract_questions_file`：收集 → 链选择 → 本地仲裁 → 最终切题 | 清晰区间零 LLM；歧义区间每区间一次联合请求 |
| 7 | 撤掉 85487/85434 两处局部补丁，由链选择统一处理 | 两卷回归通过，源码无局部例外注释 |
| 8 | 594 卷语料回归 + issue 核对 | 无新增串题，变短项已逐条裁决 |
| 9 | 同步 `docs/constraints/数据管线.md`、`docs/ai-core-changelog.md` | 文档与实现一致 |

第 7 步必须最后做：在链选择与本地仲裁未稳定前保留局部补丁，避免中间态回退。
若本地 LLM 尚未接入，第 4-6 步可以分两次合并，但不得先上线「歧义时按行号选较早候选」的中间版本。

## 15. 验收标准

- [ ] 85434 第 25 题被单独切出，Q24/Q25 的题干与答案不再互相包含。
- [ ] 85487 的 28 题答案与原 md 参考答案段逐题一致。
- [ ] 锚点 11、13 场景中 `10.5` 不进链，`12.8/12.16` 规则可分时自动选优，
      规则并列时只由本地 LLM 二选一。
- [ ] 锚点 11、15 场景中 `2/3/4` 可恢复为 `12/13/14`，且必须经本地 LLM 确认。
- [ ] 题号链断开时只接受安全前缀，并产出 `stem_chain_gap`；不静默补号、不静默吞题。
- [ ] 每个候选项能打印 `raw_number / number / recovery / evidence`，无黑盒分数。
- [ ] 本地 LLM 输出经过候选闭集、唯一分配、题号和行号顺序五类校验。
- [ ] 本地 LLM 不可用时不回退远程模型，切题失败只落在当前区间。
- [ ] `forced_stem_lines` 老调用方零改动。
- [ ] 全量测试通过，且新增测试覆盖上述真实卷。
- [ ] 594 卷语料对比无新增串题。

## 16. 风险与回退

| 风险 | 应对 |
|---|---|
| 锚点判错导致区间整体错 | 锚点条件取交集从严；保留 `jump_warnings` 交叉验证 |
| 候选排序阈值过拟合 85434/85487 | 硬过滤与排序分离；用 594 卷基线校准阈值，并保留异常 issue |
| `2→12` 类恢复产生假阳性 | 只在锚点区间内生成、要求个位与行序共同吻合、恢复代价最高，并强制本地 LLM 确认 |
| 链断开时丢题比局部贪心更严重 | 只接受从左锚点连续成立的安全前缀；其余 gap 显式报出，不扩大到全卷 |
| 本地模型不可用或输出幻觉 | 只接受闭集候选 ID；不可用/不合法即保留 gap，不回退远程模型 |
| 歧义候选全部送 LLM 导致调用过多 | 只有 top-2 分差不足或 `dropped_tens` 才请求；清晰区间零调用 |
| 第二遍状态机与候选形态不一致 | 每种 `form/recovery` 绑定唯一前缀剥离函数，单测逐一验证 |
| 回退 | 保留 `forced_stem_map=None` 的旧路径；回退只需关掉新入口，不改数据 |

## 17. 开放问题

1. **锚点是否允许跨大题题号重置**：部分语文卷每节从 1 重新编号。当前设计假设全卷
   题号递增，语文走独立策略，暂不纳入；若后续纳入，需要把 group_id 加入区间键。
2. **答案区是否复用同一 top-2 链**：本次只做题干区。答案块的 `11.4` 类问题目前由单调
   守卫处理，是否需要升级为同款链选择，待本次上线后观察。
