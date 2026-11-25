# 答案解析块级重构设计

日期：2026-11-25
状态：已评审，待实施
关联模块：`tools/data-refinery` 的试卷答案区解析、答案文档生成与答案回填

## 1. 背景与问题

数学卷的选择题和填空题答案经常使用同一份“参考答案”版面，但 MinerU 的
Markdown 输出会把它们变成完全不同的结构：

| 题段 | 常见 Markdown 形态 | 当前实际路径 |
|---|---|---|
| 1–8 | 完整 HTML 表格，题号行与答案行分开 | 表格解析器 |
| 9–16 | 一行多题、两行四列、填空题公式、无点题号 | `split_page()` 行级状态机 |
| 17+ | 逐题展开的解答和证明 | `split_page()` 行级状态机 |

1–8 题并不是天然更简单，而是通常拥有明确的表格单元边界。9–16 题在 MinerU
输出中经常失去表格边界，答案被压成连续文本，因此需要正则和全局游标猜测
下一题的位置。

历史 `recognition_issues.jsonl` 中，数学卷报过 `answer_missing` 的题段分布为：

| 题段 | 历史记录 |
|---|---:|
| 1–8 | 8 |
| 9–16 | 38 |
| 17–28 | 14 |

对同一批卷用当前解析器重跑后，1–8 题仍有 0 条空答案，9–16 题仍有 8 条。
这说明问题不是“第 9 题以后特殊”，而是当前答案切分架构把表格、视觉网格、
一行多题和展开解答都塞进同一个行级状态机，版式差异最终表现为题号段差异。

已确认的具体缺陷：

1. 大题标题优先于同行答案处理。
   `二、填空题(...)9. ... 10. ... 11. ...` 先被识别为标题并 `continue`，
   同行 9–11 的答案没有进入解析。
2. 行内题号必须满足 `N.` 后跟非数字。
   `12.2(1+x)^2` 被当成小数；`$1 3 . 2...$` 中的 13 被公式遮罩。
3. `fill_blank` 行内切分依赖从 `last_answer_n + 1` 开始的完美连续序列。
   前面缺一个题号，后面即便有合法题号也不会切分。
4. 空答案在答案文档渲染时静默跳过。
   缺少覆盖完整性校验，坏解析继续进入后续流程，直到扫描阶段才被发现。
5. 最近多轮修复持续给同一个状态机增加 HTML 表、裸题号、colspan、粘连答案等
   例外。每轮能修好几份卷，但新卷会继续暴露另一种边界。

## 2. 目标与非目标

### 2.1 目标

1. 将答案区解析从题干状态机中分离，答案区内部不再维护
   `current_answer_n`、`last_answer_n` 等全局游标。
2. 以版式块为单位解析答案：表格、视觉网格、一行多题、逐题展开、裸选择答案。
3. 使用题干切分结果作为期望题号集合，逐题做覆盖校验。
4. 所有缺失、错序、未知块都产出可定位 issue，不静默丢题。
5. 保持题干、选项、材料、小问、语文独立答案策略和英语区间答案逻辑不变。
6. 修复已知失败样例，包括密云 2025 数学 Q9–13。

### 2.2 非目标

- 不重写语文学科答案策略。
- 不改英语 `1-5 CBBCD` 等区间答案的学科规则。
- 不改题干识别、材料归属、选项拆分、道法小问扩展算法。
- 不改数据库 schema、答案导入格式和 `answer_verified` 语义。
- 不自动覆盖已有正确答案或 `answer_verified=1` 的人工结果。
- 不引入 LLM 补答案；边界不确定时保持确定性和“宁空不猜”。
- 不在本次重构中批量修复所有历史错题；历史错误需要单独三方核对。

## 3. 范围

第一阶段覆盖所有使用 `generic` 答案链的学科：

- 数学
- 物理
- 化学
- 道法
- 英语

语文继续使用 `ChineseStrategy.extract_answers()` 的独立实现。英语先使用新的
通用块解析，再叠加自己的区间答案适配器。语文和英语的学科特例不能写进
`question_splitter.py` 或通用块解析器。

## 4. 架构

### 4.1 模块职责

| 模块 | 职责 | 不负责 |
|---|---|---|
| `question_splitter.py` | 识别题干、选项、材料、小问；定位答案区边界；保存原始答案行 | 答案区内部题号和边界解析 |
| `answer_blocks.py` | 答案结构谓词、块类型、表格解析、块检测与具体块解析 | 不读数据库、不写文件、不知道学科 |
| `answer_region.py` | 接收答案行与期望题号，组织块解析、合并片段、覆盖校验 | 不参与题干或材料切分 |
| `legacy_answer_parser.py` | 第一阶段供语文适配器使用的旧答案状态机 | 不接入 generic 链，不供新学科使用 |
| `subject_strategies/generic.py` | 调用新答案链，将答案和 issue 转成 `ExtractedAnswer` | 不实现具体版式 |
| `EnglishStrategy.extract_answers()` | 使用通用链后再合并区间答案 | 不在通用内核写英语规则 |
| `ChineseStrategy.extract_answers()` | 第一阶段保持现状 | 不迁入新块解析 |
| `ChineseStrategy.parse_answers()` | 通过 `legacy_answer_parser.py` 保持既有 `RawQuestion.answer` 行为 | 不进入通用块解析 |

### 4.2 依赖方向

```text
question_splitter
  ├─> answer_region
  │     └─> answer_blocks
  │           └─> page_markers / 标准库
  └─> strategy.parse_answers()
        ├─> generic/natural-science/english: answer_region
        └─> chinese: legacy_answer_parser
```

禁止反向依赖：

- `answer_blocks.py` 不 import `question_splitter.py`。
- `answer_region.py` 不 import `subject_strategies`。
- `question_splitter.py` 不按学科写答案分支。
- `legacy_answer_parser.py` 只能被 `ChineseStrategy.parse_answers()` 使用。

现有 `question_splitter.parse_answer_table()`、`is_answer_structure_line()` 等
答案结构函数迁入 `answer_blocks.py`，由 `question_splitter.py` 兼容导入并重新
导出，避免现有调用方和测试一次性改动。

### 4.3 数据模型

```python
@dataclass(frozen=True)
class AnswerQuestion:
    no: int
    group_id: str | None


@dataclass(frozen=True)
class AnswerLine:
    line_no: int              # 原 MD 的 1-based 行号
    text: str


@dataclass(frozen=True)
class AnswerBlock:
    kind: str                 # table | compact_choice | numbered | unknown
    lines: tuple[AnswerLine, ...]
    group_id: str | None


@dataclass(frozen=True)
class AnswerFragment:
    question_no: int
    text: str
    block_kind: str
    line_start: int
    line_end: int


@dataclass(frozen=True)
class AnswerIssue:
    code: str
    severity: str             # warning | error
    message: str
    question_no: int | None
    line_start: int | None
    line_end: int | None
    excerpt: str


@dataclass
class AnswerParseResult:
    fragments: list[AnswerFragment]
    blocks: list[AnswerBlock]
    issues: list[AnswerIssue]
```

所有 issue 必须可追溯到原 Markdown 行。禁止使用无法解释的置信度分数。

### 4.4 `split_page` 兼容接口

```python
@dataclass
class SplitPageResult:
    questions: list[RawQuestion]
    answer_result: AnswerParseResult | None


def split_page_result(
    text: str,
    md_path: Path,
    strategy,
    *,
    forced_stem_lines: set[int] | None = None,
    suspects_out: list | None = None,
) -> SplitPageResult:
    ...


def split_page(
    text: str,
    md_path: Path,
    strategy=None,
    *,
    forced_stem_lines: set[int] | None = None,
    suspects_out: list | None = None,
) -> list[RawQuestion]:
    return split_page_result(...).questions
```

`question_extract.py`、`split_snapshot.py` 和其它只关心题目的调用方继续使用
`split_page()`。`generic.extract_generic_answers()` 改用
`split_page_result()` 获取结构化答案诊断。

### 4.5 学科答案解析钩子

`QuestionStrategy` 增加可选方法：

```python
def parse_answers(
    self,
    answer_lines: list[AnswerLine],
    questions: list[AnswerQuestion],
    *,
    first_line_no: int,
) -> AnswerParseResult:
    ...
```

- `GenericStrategy`、数学、物理、化学、道法、英语调用
  `answer_region.parse_answer_region()`。
- `ChineseStrategy.parse_answers()` 调用 `legacy_answer_parser.py`，保持第一阶段
  `RawQuestion.answer` 行为不变。
- `ChineseStrategy.extract_answers()` 仍走自己的答案文档实现，不调用块解析。
- 测试或临时策略未实现该钩子时，`question_splitter` 使用通用块解析器兜底；
  这个兜底不包含任何学科条件。

## 5. 数据流

```text
split_page_result()
  ├─ 正常切分题干、材料、选项和小问
  ├─ 遇到参考答案边界：
  │    ├─ 结束题干解析
  │    ├─ 保存答案区原始行和原始行号
  │    └─ 记录期望题号及其 group_id
  ├─ strategy.parse_answers()
  │    ├─ 清洗答案结构行
  │    ├─ 识别 AnswerBlock
  │    ├─ 将块解析为 AnswerFragment
  │    ├─ 合并重复片段
  │    └─ 对期望题号做完整覆盖检查
  ├─ 将非空答案写回 RawQuestion
  ├─ 执行 attach_pre_material / attach_post_material
  └─ 最后执行 expand_subquestions
```

答案必须在道法 `expand_subquestions()` 之前写回父题，因为道法小问扩展依赖
父题答案按 `(1)(2)` 拆分。材料钩子不读取答案，但保持既有执行顺序。

## 6. 答案区定位与预处理

### 6.1 定位规则

- `参考答案`、`评分参考`、`答案及评分` 作为答案区起点。
- `# 数学试卷参考答案及评分标准` 识别为答案区标题。
- `6.答案：C` 这类逐题入口也作为答案区起点，但保留整行题号。
- 没有答案区时，`answer_result=None`，不产生 `answer_missing`。

### 6.2 预处理规则

| 输入 | 处理 |
|---|---|
| `# 参考答案` | 丢弃标题，建立答案区 |
| `## 数学试卷参考答案及评分标准` | 丢弃标题，建立答案区 |
| `二、填空题(...)9. ... 10. ...` | 剥离大题标题前缀，保留 `9...10...` 并设置 group scope |
| `一、选择题（共 16 分）` 后下一行开始答案 | 标题只更新 group scope |
| 页码、纯小节标题 | 从块扫描视图移除，保留原行号映射 |
| 空行 | 保留在原始答案文本中；块检测时可跳过，但不得从答案正文删除 |
| `6.答案：C` | 整行保留，不能当标题剥掉题号 |

清洗只改变解析视图，不改写原 Markdown 文件。

解析器必须同时保留两份表示：

- `scan_text`：供块识别和行号定位使用，可忽略空行；
- `render_lines`：块内答案原文，保留空行、缩进和围栏代码块。

## 7. 块识别与解析

按以下固定优先级扫描，禁止多个解析器同时消费同一段文本：

```text
table
  → compact_choice
  → numbered
  → unknown
```

### 7.1 `table`

识别完整 `<table>...</table>`，包括跨行表。

规则：

- 复用现有表格解析，不另写第二套。
- 支持横向题号行/答案行、纵向题号/答案、多组行、`colspan`、格内
  `9. 答案`。
- 表格声明了题号但某组列数不齐时，该组整组不写。
- 无法解析的表格产生 `table_incomplete` 或 `answer_block_unparsed`。
- `<table>` 未闭合时产生 `table_unclosed`。

### 7.2 `compact_choice`

识别一整行只有裸选项串，例如：

```text
B C A D
BBCAD
```

裸选项串没有显式题号，只允许使用当前答案大题中尚未填充的期望题号。

- 字母数量必须与期望题号数量完全相等。
- 至少包含两个选项字母；单个字母不视为裸答案串。
- 当前大题至少有两个待填题时才启用。
- 当前大题无法定位时产生 `group_scope_unresolved`，不分配。
- 数量不等时产生 `compact_choice_count_mismatch`，整串不展开。

### 7.3 `numbered`

统一处理一行多题、视觉网格和逐题展开。禁止再根据“短块/长块”猜测两个不同的
块类型。解析器只使用一个 `numbered` 块，块内题号标记按边界强度分类。

```text
9. A 10. B 11. C 12. D
17. 解：...
方法二：...

18. 证明：...
（1）...
（2）...
```

解析器按当前期望题号定向扫描：

```text
期望 9  → 查找第 9 题强边界
期望 10 → 从第 9 题答案后继续查找第 10 题强边界
期望 11 → 继续按顺序查找
```

每个答案从该题标记后开始，到下一个已识别期望题号前结束。块内答案原文保留
空行、缩进和围栏代码块。

题号边界分为：

**强边界**

- 行首；
- 块首；
- 明确的分值边界后，如 `6分26.解：`；
- 公式或数学环境中的 `$1 3 .`，仅在题号等于当前期望值时接受；
- `；`、`。` 等明确答案分隔符后。

**弱边界**

- 同一物理行内，前一个答案是紧凑答案且题号正在严格递增；
- 弱边界只在当前块第一行或已确认的紧凑编号行内启用。

以下数字不得成为下一题：

- 普通正文中的小数，如 `约为 12.2 米`；
- 公式中的 `x=13.5`；
- 解答内部的 `1.`、`2.` 评分细则编号；
- 题号不递增、超出当前作用域或不在期望集合中的数字。

### 7.4 `unknown`

连续文本无法归入上述块时形成 `unknown` 块：

- 不分配任何题号；
- 产生 `answer_block_unparsed`；
- 记录最多 200 字的原文摘要和完整行范围；
- 不影响其它已识别块的写入。

## 8. 题号标记规则

### 8.1 允许的真实形态

```text
12.2(1+x)^2=5.8       → 第 12 题，答案是 2(1+x)^2=5.8
$1 3 . 2(1+x)^2=5.8$  → 数字空格归一后为第 13 题
9 $x \neq 5$           → 第 9 题，无点题号
11. <                  → 第 11 题，答案是 <
```

### 8.2 接受条件

题号候选必须满足：

1. 位于块首、行首，或前面是空白、`；`、`$` 等明确边界。
2. 前面不能紧接字母、数字或 `= + - × ÷` 等数学运算符。
3. 题号必须在当前期望题号集合中。
4. 块内题号只能递增。
5. 题号后紧跟数字时，只有该题号正好等于当前期望值才接受。
6. 数字之间允许由 MinerU 插入空格，如 `1 3` 归一为 `13`。
7. 点后紧跟数字的候选只允许出现在：
   - 块首或行首；
   - `；`、`。`、分值和 `$` 等强边界后。
8. 普通正文中间的 `约为 12.2 米` 不得成为第 12 题。

因此：

- `12.2` 可以被解释为第 12 题；
- 解答中的 `x=13.5` 不会成为第 13 题；
- 上一题正文中的 `约为 12.2 米` 不会成为第 12 题；
- `$1 3 . 2...$` 只在期望第 13 题时接受；
- 未知或回退题号不会被静默写入。

## 9. 大题作用域

答案区中的大题标题更新当前 group scope：

```text
一、选择题 → group_id="一"
二、填空题 → group_id="二"
三、解答题 → group_id="三"
```

期望题号由题干切分结果按 `group_id` 得到。

- `table` 和显式编号不依赖 group scope，也能解析。
- `compact_choice` 必须有 group scope。
- 大题标题与答案同行时，标题前缀剥离后，同行答案归该 group。
- 遇到新大题标题时结束当前块，避免跨大题拼接。
- group scope 找不到对应题号时产生 `group_scope_unresolved`。

## 10. 片段合并

同一题可能有多个答案块。为防止后续详解污染或覆盖首套标准答案：

| 情况 | 行为 |
|---|---|
| 首次非空片段 | 写入 `RawQuestion.answer` |
| 后续同题片段完全相同 | 忽略 |
| 后续同题片段包含更多内容 | 仍忽略，记录 `answer_duplicate_ignored` warning |
| 首次片段为空、后续片段非空 | 后续片段成为首套答案 |
| 空片段 | 不写入，记录 `answer_empty` |
| 题号不在期望集合 | 丢弃，记录 `answer_number_unexpected` |
| 题号回退或乱序 | 丢弃，记录 `answer_number_out_of_order` |

单个 `numbered` 块内部属于同一题的连续多行答案仍然原样保留。上述“第一套优先”
只作用于多个独立答案块之间，确保现有
`test_second_answer_block_does_not_pollute_last_question` 行为不变。

## 11. 完整覆盖校验

答案区存在时，以当前题干题号作为期望集合。所有块完成解析和合并后逐题检查：

- 有非空答案：通过。
- 没有答案：产生 `answer_missing` error。
- 表格声明了题号但解析缺失：额外产生 `table_incomplete`。
- 未知块包含内容：产生 `answer_block_unparsed`。
- 答案区存在但最终 0 道题有答案：额外产生 `answer_region_no_assignments` error。

不确定时保持“宁空不猜”：

- 未知块不分配。
- 表格列数不齐的组不写。
- 裸字母数量不等时整串不展开。
- 题号不连续但不影响已找到片段时，已有片段保留，缺失题逐题报错。

## 12. issue 字典

| code | severity | 触发条件 |
|---|---|---|
| `answer_missing` | error | 期望题号最终没有非空答案 |
| `answer_empty` | error | 有题号但答案文本为空 |
| `answer_duplicate_ignored` | warning | 同题后续独立答案块被忽略 |
| `answer_number_unexpected` | error | 题号不在期望集合 |
| `answer_number_out_of_order` | error | 块内题号回退或乱序 |
| `answer_region_no_assignments` | error | 答案区存在但 0 道题有答案 |
| `group_scope_unresolved` | error | 依赖 group 的块找不到题号范围 |
| `table_incomplete` | error | 表格声明题号但未解析出全部答案 |
| `table_unclosed` | error | HTML 表格没有闭合 |
| `compact_choice_count_mismatch` | error | 裸答案数量与大题题数不等 |
| `answer_block_unparsed` | error | 未知块无法解析 |
| `answer_region_unmatched_text` | warning | 答案区开头有一段未归入任何块的文本 |

## 13. CLI 与调用方集成

### 13.1 `ExtractedAnswer`

保留现有字段，并增加结构化 issue：

```python
@dataclass
class ExtractedAnswer:
    no: int
    answer: str = ""
    approach: str = ""
    explanation: str = ""
    issues: list[str] = field(default_factory=list)
    issue_details: list[dict] = field(default_factory=list)
```

没有 `issue_details` 的学科继续使用字符串 issue。

### 13.2 `answer_extract_cli`

- 没有参考答案区：保持现状，不产生全局解析错误。
- 部分题成功：正常生成答案文档，同时打印并持久化缺失题。
- 答案区存在但 0 道题成功：不写答案文档，返回 `2`。
- 单块失败：该块不分配，其它块继续。
- issue 写 `output/answer_issues.jsonl`。

“答案区存在但零命中”通过 sentinel 传递：

```python
ExtractedAnswer(
    no=0,
    issues=["答案区存在但未解析出任何答案"],
    issue_details=[{
        "code": "answer_region_no_assignments",
        "severity": "error",
        ...
    }],
)
```

`answer_extract_cli` 和 `answer_backfill` 只把
`answer_region_no_assignments` 当作块解析失败；其它学科原有的 `no=0` issue
语义不变。

示例：

```text
提取：28 题，有答案 23 题，issues 5 条
[INCOMPLETE] 缺失答案：9, 10, 11, 12, 13
  [answer_missing] Q9 第 220 行：题干存在，答案块未匹配到该题
```

### 13.3 `answer_backfill`

- 复用同一个 issue 写入函数。
- 没有答案区：维持 `no_answer` 统计。
- 有 `answer_region_no_assignments`：计入 `failed`，不按“无答案段”跳过。
- 部分成功：继续回填非空答案，并输出 issue。

## 14. 实施步骤

| 步骤 | 内容 | 完成判据 |
|---|---|---|
| 1 | 增加块类型、解析接口和真实版式夹具，不接入主链 | 新单测全绿，现有测试无改动 |
| 2 | 将表格解析迁入 `answer_blocks.py`，旧 API 兼容导出 | `test_answer_table.py` 原断言全绿 |
| 3 | 实现 `AnswerRegionParser` 和覆盖校验 | 密云、顺义、昌平、门头沟、石景山夹具全绿 |
| 4 | 增加策略 `parse_answers` 钩子和语文 legacy adapter；增加 `split_page_result()`，旧 `split_page()` 变薄包装 | 现有切题、语文答案和语文 `RawQuestion.answer` 测试全绿 |
| 5 | 题干循环在答案边界停止，内容交给块解析器 | 密云 Q9–13 全部恢复 |
| 6 | `generic` 链接入结构化 issue；英语保留区间答案适配 | 数理化道法英语答案测试全绿 |
| 7 | 删除 `split_page` 内旧答案游标和逐行答案分支 | 源码中不再有 `current_answer_n/last_answer_n` |
| 8 | 语料回归、文档同步 | 历史问题集无新增空答案或串题 |

第 7 步必须最后做。正式接入后只能由块解析器消费答案区，不能在新块解析失败后
偷偷回退旧状态机。

## 15. 测试策略

### 15.1 块解析单测

新增 `tests/test_answer_blocks.py`，并扩展 `tests/test_answer_table.py`：

- 密云：`二、填空题(...)9...10...11.` 标题与答案同行。
- 密云：`12.2(1+x)^2` 和公式内的 `$1 3 . 2...`。
- 密云：Q9–13 完整期望结果。
- 顺义：带点和无点题号混排。
- 昌平：HTML 填空答案表。
- 门头沟：`colspan` 合并答案。
- 石景山：每格自带 `9. 答案` 的网格。
- 解答题：`6分26.解：` 行尾粘连。
- 裸选择答案：`B C A D` 与 `BBCAD`。
- 单字母 `A` 不得被当作裸选择答案串。
- 页码和小节标题夹在答案中。
- 多行答案中的空行、缩进和围栏代码块必须保留。
- 表格列数不等、多组表、未知块。
- 同一 `numbered` 块混用紧凑编号和多行展开。
- 题号乱序、意外题号、重复答案。
- 上一题正文中的 `约为 12.2 米` 不得成为第 12 题。

### 15.2 集成测试

在 `test_question_splitter.py` 和 `subject_strategies/test_natural_sciences.py`：

- `split_page_result()` 的题干数量、`content`、`options`、`material_text`
  与旧实现逐项一致。
- 密云 Q9–13 分别得到：
  - `(-1,-2)`
  - `x1=4,x2=-4`
  - `<`
  - `2`
  - `2(1+x)^2=5.8`
- 答案不能写入相邻题号。
- 空答案必须在 `answer_missing` 中出现。
- 语文独立答案文档不变。
- 语文 `RawQuestion.answer` 与重构前逐题一致。
- 英语 `1-5 CBBCD` 合并后不重复、不覆盖。
- 道法父题答案在小问扩展前完成写回。
- 答案区存在但零命中时，`answer_extract_cli` 返回 `2`，
  `answer_backfill` 计入 `failed`。

### 15.3 语料回归

以 `recognition_issues.jsonl` 中历史报过 `answer_missing` 的数学卷为基线：

- 1–8 题保持当前零失败。
- 9–16 已知解析失败数量下降。
- 每个仍为空的题必须属于：
  - 原卷确实没有答案；或
  - 未知块并已产生明确 issue。
- 新解析器写入的答案做三方核对：
  - Markdown 原行；
  - `output/answers/*.md`；
  - `questions.answer`。

## 16. 上线与回退

- 不自动覆盖已有正确答案。
- 先对目标卷执行 dry-run，确认答案数量和缺失题。
- 只回填已知为空且已确认的卷。
- 已有 `answer_verified=1` 的错误答案不在本次自动纠正，需单独人工审核。
- 不涉及数据库迁移。
- 回退只需撤回代码，答案文档可由原 Markdown 重新生成。
- 实施完成后同步更新：
  - `docs/constraints/数据管线.md`
  - `docs/ai-core-changelog.md`

## 17. 风险与应对

| 风险 | 应对 |
|---|---|
| 新块解析改变题干或材料 | `split_page_result()` 对既有题干、选项、材料做逐项回归；只替换答案段 |
| 为兼容语文保留两套答案实现 | 语文通过旧状态机 adapter 隔离；通用块内核不出现学科分支 |
| 宽松匹配误把公式数字当题号 | 只搜索期望题号，要求顺序、集合和前缀边界同时成立 |
| 部分答案串到相邻题 | 期望集合和完整覆盖校验；夹具逐题断言 |
| 后续详解覆盖首套标准答案 | 独立答案块“第一套优先”，后续片段只记 issue |
| 英语区间答案被覆盖 | 英语适配器只在空答案上填区间答案，再按源顺序合并 |
| 旧答案产物未重生成 | 明确只对新解析流程生效；目标卷重新执行答案提取和核对 |

## 18. 验收标准

- [ ] 密云 2025 数学 Q9–13 全部正确入库。
- [ ] 同类答案区不再从第 8 题直接跳到第 14 题。
- [ ] HTML 表、视觉网格、一行多题、逐题展开均有真实回归测试。
- [ ] 无法确定边界时整块不猜，并生成可定位 issue。
- [ ] `question_splitter.py` 不再包含答案游标状态机。
- [ ] 旧切题、材料、小问、语文答案和英语区间答案测试全部通过。
- [ ] `answer_backfill` 与 `answer_extract_cli` 使用同一套 issue 口径。
- [ ] 历史数学问题集中，新增空答案或串题均为 0。
