# 题解内嵌分段拆分与存量整理设计

日期：2026-11-27

## 1. 背景与目标

当前 `questions.answer` 有时不是纯答案，而是把整段题解直接拼在一起，例如：

```text
【答案】C
【分析】先判断函数类型，再比较变化趋势。
【详解】由题意得……
```

也有 `答案：… 解析：… 详解：…`、`【解答】…`、`【点睛】…` 等变体。直接存入 `answer` 会让学生最终答案区域出现整段解析，也会使后续判题、解析复用和内容维护使用错误字段。

目标：

1. 从带明确分段标题的题解中拆出答案、思路和详解。
2. 存量 `questions` 一次性整理，已有 `approach` / `explanation` 时保留旧内容并把新内容追加到后面。
3. 后续数据管线复用同一套解析规则，新导入数据不再产生同类混合内容。

## 2. 字段口径

| 源标题 | 目标字段 | 语义 |
|---|---|---|
| `答案`、`正确答案`、`参考答案` | `questions.answer` | 可判定的最终答案 |
| `解析`、`分析`、`思路`、`解题思路` | `questions.approach` | 解题切入点、方法或简要分析 |
| `详解`、`解答`、`点睛` | `questions.explanation` | 完整解答过程、详细解析或总结 |

兼容标题外围写法：

- 中文方括号：`【答案】`
- 半角方括号：`[答案]`
- 冒号：`答案：`、`答案:`
- Markdown 强调：`**答案：**`、`__答案：__`
- 列表前缀：`- **答案：**`

裸 `解：`、`证明：`、`原式：` 不单独作为分段标题。它们通常已经是答案主体或评分过程的一部分，单独移动会把“参考答案”误挪进详解并留下空答案。

## 3. 非目标

- 不新增或修改数据库字段。
- 不调用 LLM 推断没有明确标题的答案和解析边界。
- 不修复答案内容本身的学科错误。
- 不处理 `answer` 中疑似混入多道题答案的脏数据；这类行只报告并跳过，交人工处理。
- 不重算 `content_hash`，不影响知识点、题目状态、掌握度、积分或作答历史。

## 4. 共享解析器

新增纯函数模块 `tools/data-refinery/src/answer_sections.py`。

核心数据结构：

```python
@dataclass(frozen=True)
class AnswerSections:
    answer: str
    approach: str
    explanation: str
    recognized: bool
    issues: tuple[str, ...]
```

入口：

```python
def split_answer_sections(text: str) -> AnswerSections:
    ...
```

规则：

1. 只识别位于行首的明确标题；标题前允许空白、Markdown 标题前缀、加粗标记和列表前缀。
2. 标题后的内容延续到下一个可识别标题、文末或围栏代码块边界。
3. 同一目标字段出现多个分段时，按原文顺序保留，并以空行连接。
4. 无任何明确标题时 `recognized=False`，原始文本整体作为 `answer`，不做内容搬迁。
5. 第一个标题前若有非空正文，默认保留为答案前导内容；若该前导内容只是页码、说明标题等噪声，交给现有页码清洗链路处理。
6. `【点睛】` 内容归入 `explanation`，保留标题语义带来的原有段落顺序。
7. 若出现多个顶层“答案”标题，或出现 `N. 答案：` 形式的多题答案证据，返回 issue，由调用方拒绝自动写入。
8. 输出字段去除标题本身，保留正文换行、LaTeX、HTML 表格、图片引用和围栏代码块。

## 5. 合并语义

存量整理时：

- 拆分后的答案替换原 `answer` 中的混合题解。
- 原 `approach` / `explanation` 非空时，旧值放前，新拆出的内容追加在后。
- 合并分隔符统一为两个换行。
- 若新内容已经完整存在于旧值中，不重复追加。
- 若拆分结果没有答案正文，而原文存在其他分段，保留原文作为 `answer` 并记录 issue，避免空答案。
- `answer_verified` 保持原值。此次操作只是把同一来源的文本归位，不产生新的“人工已核验”事实。
- `updated_at` 由列级 `ON UPDATE CURRENT_TIMESTAMP(3)` 自动更新，不新增触发器。

## 6. 管线接入

### 6.1 答案块层

`answer_blocks.AnswerFragment` 增加 `approach` 和 `explanation`，默认值为空字符串，保持现有构造调用兼容。

`answer_region.parse_answer_region()` 在每个 fragment 完成题号归属后统一调用 `split_answer_sections()`：

- `text` 保存拆分后的纯答案。
- 新增字段保存思路和详解。
- 拆分 issue 转成 `AnswerIssue`，沿用现有问题报告链路。

先归属题号再拆字段。这样不会把详解中的 `(1)`、`(2)` 或公式编号误当作答案题号。

### 6.2 RawQuestion 与 extract

`question_splitter.RawQuestion` 增加 `approach` 字段。`split_page_result()` 按题号把 fragment 的三字段分别写入：

- `RawQuestion.answer`
- `RawQuestion.approach`
- `RawQuestion.explanation`

`question_extract` 的 JSONL 新增 `approach` 输出。

`generic.extract_generic_answers()` 同时返回 `answer`、`approach`、`explanation`，不再丢弃答案提取阶段已拆出的两个补充字段。

### 6.3 语文策略

语文的 `extract_chinese_answers()` 在按题号聚合原始答案后、现有评分说明抽取前调用共享解析器：

1. 先拆 `答案 / 解析 / 详解` 等明确标题。
2. 再对纯答案执行现有 `_extract_scoring_notes()`，继续把评分表、给分说明移入详解。
3. 合并共享解析器与评分说明抽取得到的 `explanation`，保持旧逻辑不丢内容。

### 6.4 答案文档与导入

`answer_extract_cli.render_answer_doc()` 输出规范字段：

- `答案：`
- `思路：`
- `解析：`

其中 `思路` 来自 `approach`，`解析` 来自 `explanation`。`answer_doc` / `answer_importer` 现有语义保持不变。

### 6.5 publish / db_loader

`models.ExamQuestion` 增加 `approach`，防止 publish 使用 Pydantic 重建记录时静默丢弃该字段。

同步补齐：

- `publish_cli._QUESTION_TEXT_FIELDS` 清洗 `approach` 中的页码标记。
- `image_rewrite.rewrite_fields()` 物化 `approach` 中的图片，使用 `approach_NN` 规范名。
- `db_loader.assert_materialized_images()` 检查 `approach` 图片路径。

## 7. 存量整理 CLI

新增 `tools/data-refinery/src/normalize_embedded_answers_cli.py`。

命令：

```bash
python3 src/normalize_embedded_answers_cli.py --apply
```

行为：

1. 扫描所有 `questions`，只选择 `answer` 中出现明确分段标题的行。
2. 输出候选数、各字段拆出行数、合并行数、异常跳过行数和前若干条明细预览。
3. 无 `--apply` 时只预览。
4. 有 `--apply` 时先展示同一份预览，再要求输入 `yes`；“一条命令完成预览、确认、备份、写入、复查”的用户入口不变。自动化可显式加 `--yes`。
5. 写入前把本次受影响行的 `id / answer / approach / explanation / answer_verified` 保存为 JSONL 备份，路径为：

   `output/backups/embedded_answers_<timestamp>.jsonl`

6. 单事务写入；每条 UPDATE 带旧 `answer` 条件，发生并发修改时整批回滚并提示重跑。
7. 写入后重新查询受影响题，核对：

   - `answer` 不再含目标分段标题；
   - 新 `approach` / `explanation` 包含应追加内容；
   - `answer_verified` 与预期一致；
   - 其它不相关字段未改变。
8. 幂等重跑时不再命中已整理行。

异常跳过条件：

- 同一段里出现多个顶层“答案”标题；
- 出现 `N. 答案：` 且题号与当前题身份不匹配；
- 拆分后答案为空，但原文只包含解析/详解；
- 围栏代码块未闭合，无法可靠判断段落边界。

所有跳过项都必须进入报告，不允许静默忽略。

## 8. 可观测性

报告至少包含：

- 候选总题数与学科分布；
- 成功整理、目标字段追加、异常跳过数量；
- 每题 `id`、学科、题型、原字段长度、各目标字段长度；
- 追加到旧 `approach` / `explanation` 的题号；
- 无法安全拆分的 `id` 与原因；
- 备份文件路径和写入后复查结果。

## 9. 测试

### 9.1 纯解析器单测

覆盖：

- `【答案】【分析】【详解】`
- `答案： / 解析： / 详解：`
- `【解答】`、`【点睛】`
- Markdown 加粗与列表前缀
- 多段同字段连接
- 无标题原样返回
- 裸 `解：` 不误拆
- 多个答案标题和 `N. 答案：` 异常
- 围栏代码块与 HTML 表格保留

### 9.2 管线回归

- `answer_region` 产出三字段 fragment。
- `split_page_result` 把三字段写入 `RawQuestion`。
- generic 与语文策略都返回 `approach` / `explanation`。
- `answer_extract_cli` 文档同时渲染`思路：`和`解析：`。
- `question_extract` JSONL 含 `approach`。
- `ExamQuestion` 能保留 `approach`。
- publish 物化 `approach` 图片且不丢字段。
- db_loader 拒绝未物化的 `approach` 图片。

### 9.3 存量 CLI 测试

使用 fake connection / fake cursor 覆盖：

- 默认只预览；
- `--apply --yes` 才写；
- 旧字段在前、新内容在后；
- 精确重复不重复追加；
- 备份先落盘再写库；
- 并发条件失败时回滚；
- 多题污染跳过；
- 重跑幂等。

## 10. 文档同步

实施时同步更新：

- `tools/data-refinery/README.md`：新增共享拆分规则与存量 CLI。
- `docs/data-refinery-使用手册.md`：补充一条命令的使用方式和报告字段。
- `docs/constraints/数据管线.md`：新增硬约束，明确字段映射、先归属题号再拆字段、旧值在前、published/extracted/库三层必须同步。
- `docs/ai-core-changelog.md`：记录本次变更和实测统计。

## 11. 验收标准

1. 存量脚本 dry-run 能准确列出当前库中的混合题解，且不误拆普通数学公式和裸 `解：`。
2. `--apply` 后抽查各学科真实题，答案只保留最终答案，思路和详解进入对应字段。
3. 已有目标字段的题，旧内容在前后追加关系正确。
4. 异常多题污染没有被自动写入，并在报告中明确列出。
5. 新导入一份包含三类标题的测试卷，extract → publish → db_loader 后三个字段均正确落库。
6. 全部新增测试与数据管线现有测试通过。
