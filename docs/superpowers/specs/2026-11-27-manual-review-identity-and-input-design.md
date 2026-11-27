# 人工校对：题号身份统一与输入栏改造设计

**日期**：2026-11-27
**状态**：待评审
**范围**：`tools/data-refinery` 人工校对链路 —— `recognition_scan.py`、`review_queue.py`、`manual_fix.py`、`review_editor.py`，新增 `terminal_input.py`
**关联**：2026-11-26 人工校对重构（`2026-11-26-manual-review-redesign-design.md`）、2026-11-27 数学题号全局链

---

## 1. 设计结论

把「缺号题的正文被上一题吞并」这一种情况，从「一张卡里同时操作两道题」改为「两道题各有独立 issue、各有独立卡片、各写各的题号」。

核心改动只有一句：**题号身份统一**。清单题号 = 卡片标题题号 = 补题记录题号 = 收口题号 = 显示给用户的题号，全部取 `item.group_order`，不再取 `target.group_order`。

由此一并消除 5 个 bug，再落实用户新提的 2 项交互需求（答案缺失显示题号、输入栏可编辑）和 1 项口径确认（关联组独立收口）。

---

## 2. Bug 清单（现象 / 根因 / 解决方法）

### B1 清单列 14 题，第一张卡却是第 13 题

**现象**

用户执行 `./src/import_cli.py --year 2024 --subject 数学 --file "76816"`，清单列出 14、18、22、26 四题（共 4 题待处理），但进入补录后第 1/4 步显示「第 13 题」，note 是「这一题的正文里混进了下一题，请只保留本题自己的内容」，依据里写着 14 题的 missing 标记（上一题 523 字、原 Markdown 找不到 14）。用户质疑：既然认为 13 题有问题，为什么有问题的清单里没有 13 题。

**根因**

- `manual_fix.py:691` 清单用 `item.group_order`（14）列题号。
- `review_queue.py:166-196` 的 `ReviewItem.targets()` 对带 `suspect_group_order` 的 `missing` flag，额外产出一张 `target=suspect`（13）的关联卡，且排在本卡之前。
- `manual_fix.py:232` 卡片标题用 `target.group_order`（13）显示。
- `manual_fix.py:638` 把同一个 `index/total`（1/4）传给一个 item 的所有 target 卡。
- 13 题从未生成独立 issue，它只是 14 题 issue 上的一个 `suspect_group_order` 数字，所以清单里永远不会有它。

**解决方法**

在扫描阶段为 suspect 题生成独立 issue（见 §3.1），取消 `targets()` 的额外关联卡（见 §3.2）。清单与卡片从此都按 `item.group_order` 列 13、14、18、22、25、26，逐行对齐；步数按实际卡数走。

### B2 同一份卷出现两个「第 25 题」

**现象**

第 9/10 步「第 25 题」是 `incomplete_content`（实心球抛物线题）；第 10/10 步又出现「第 25 题」，flag 是 `题号缺失 + stem_chain_boundary_uncertain + stem_chain_gap`，题干是实心球题混进下一题的参数 m 二次函数。两张卡题干高度相似，用户认为是重复。

**根因**

与 B1 同一个根因。第 10 步是 item(26) 的 suspect 关联卡：`recognition_scan.py:370-398` 判 26 题缺失时，因上一题 965 字（中位 166 字）且出现第二组小问，推断「正文被 25 题吞了」，写入 `suspect_group_order=25`；`targets()` 据此产出 target=25 的卡，`render_card:232` 显示成「第 25 题」。两张卡一条是 25 题自己的 issue，一条是 26 题的 suspect 卡。

**解决方法**

同 B1。26 题有自己的 `missing` issue，25 题有自己的 `merged_content` issue，两张卡题号分别是 25 和 26，且 `stem_chain_*` flag 与 `missing` 聚合在 26 题这一条上（现有 `group_items()` 已按 `(source, group_order, sub_no)` 聚合，无需改动）。

### B3 关联卡里「本题」指代两道题，编辑写错题

**现象**

B2 的第 10 步卡，note 写「这一题的正文里混进了下一题，请只保留**本题**自己的内容」（此处「本题」= 25 题），警告行却写「关联题的正文里可能混进了**本题**」（`manual_fix.py:245`，此处「本题」= 26 题）。用户按警告语义理解，在编辑器里保留了参数 m 二次函数、删掉了实心球部分。保存后卡片显示的内容确实变成了参数 m 二次函数，但这段编辑被写回了第 25 题——实心球正文被覆盖。

**根因**

- `review_queue.py:186` 关联卡 note 的「本题」指 `target`（25）。
- `manual_fix.py:245` 警告行的「本题」指 `item`（26）。同一张卡两个「本题」指向不同题。
- `manual_fix.py:667` 用 `target.group_order` 构造 record，所以编辑落到 25 题。
- `manual_fix.py:158-183` 的 `CardState.view` 用 draft patch 覆盖显示，所以界面上看到的 m 二次函数正是即将写回 25 题的内容，用户无从察觉错位。

**解决方法**

取消关联卡后，每张卡只对应一道题，note 与提示统一改为带明确题号的表述（如「第 26 题正文缺失，疑似被第 25 题吞并，请按原卷补录」「关联题：第 25 题（正文 965 字，含下一题内容）」）。`build_record`、`close_as_ok`、`snapshot_for`、`_issue_for` 全部使用 `item.group_order`，显示题号与写入题号恒等。

### B4 编辑完题干，同一张卡又出现一次

**现象**

B2 的第 10 步卡：用户按 `1` → `:e` 在 VS Code 改完 → 回车确认 → 界面又打印一遍完全相同的「第 10/10 步 第 25 题」卡，用户误以为没保存。

**根因**

`manual_fix.py:335-376` 的 `edit_content_slot()` 在普通编辑路径末尾 `return None`（`:376`）；`manual_fix.py:592-596` 的 `run_card()` 只在 `res is not None` 时返回，于是 `while True` 回到 `:585` 重新 `render_card()`，整卡重绘。

**解决方法**

编辑成功后不再整卡重绘：打印一行「已暂存（第 N 题）」后只重显菜单，用户可继续改其它槽位或回车结束。具体做法在 `run_card()` 内跟踪本轮是否发生过编辑，循环顶部仅在首帧渲染；已暂存状态通过 `CardState` 传递。保持「回车才保存并结束」的语义不变。

### B5 上一轮处理过的题，再执行导入命令又冒出来

**现象**

用户上一轮已处理 13、14、18、22 等题，再次执行同一条 `import_cli.py --year 2024 --subject 数学 --file "76816"` 命令时，这些题重新出现在待处理清单里。

**根因**

不是扫描器"忘了"处理过的题，而是上一轮的处理被记到了另一道题头上：

- `manual_fix.py:318` 的 `close_as_ok()` 用 `target.group_order` 收口。按 `k` 关掉的是 13 题，14 题的 `missing` flag 仍是 pending。
- `manual_fix.py:667` 的 `build_record()` 用 `target.group_order` 写补题记录，记录落在题号 13。
- `recognition_scan.py:806` 每次扫描都调用 `reopen_unbacked()`；`:616` 按 item 题号（14）去 `fixed_numbers()` 查补题记录，查不到，`:630` 把记录重开为 pending。
- `recognition_scan.py:807` 的 `reopen_changed()` 对 `verdict=no_change` 的记录按 `content_sig` 变化再重开一次。

**解决方法**

B1–B3 的题号统一同时修复此问题：补题记录按 `item.group_order` 写，`reopen_unbacked()` 按同一题号查，能正确识别"已补过"。本设计**不修改** `reopen_unbacked()` / `reopen_changed()` 的策略本身——它们的重开语义（补题未落库、内容变化则旧结论作废）是有意为之，B5 只源于题号不一致导致的误判。另补一条回归测试，钉住"处理 14 题后重扫不再重开"。

### B6 答案缺失卡不显示题号

**现象**

答案缺失进入补录时直接跳到答案输入框，没有任何题号或题干，用户不知道是哪道题的答案缺失。

**根因**

`manual_fix.py:579-583` 的特判绕过 `render_card()`，直接 `edit_answer_slot(state)`。

**解决方法**

改为先 `render_card(state)`（显示题号、题干、依据、答案空），再 `edit_answer_slot(state)`，然后按 `has_changes()` 返回 `record`/`noop`；用户不用多按一次 `4`。

---

## 3. 详细设计

### 3.1 关联题独立成 issue

在 `recognition_scan.py` 生成带 `suspect_group_order` 的 `missing` issue 时（`:398` 附近），同时为 suspect 题生成一条独立 issue：

| 字段 | 值 |
|---|---|
| `source` / `rel_path` / `pdf` / `md` | 与 missing issue 相同 |
| `group_order` | `suspect`（被吞并的上一题题号，如 13/25） |
| `kind` | `merged_content`（`KIND_TEXT` 已有「前后题可能被合并」映射） |
| `reasons` | `prev_has_second_subq_series` / `prev_len_*_vs_median_*` 等已有原因，复用 missing issue 的 |
| `excerpt` | suspect 题当前正文（`:391` 已经取到 `by_no[suspect]["content"]`） |
| `status` | `pending` |

`_issue_key()`（`:203-207`）为 `(source, group_order, kind[, line_no])`，两条 issue 题号不同，天然不会互相去重。

`load_stem_issues_for_source()` / `stem_issue_to_recognition()` 写入的 `stem_chain_*` flag 继续聚合在缺号题（26）上，不动。

### 3.2 取消 target 多卡机制

- `review_queue.py:166-196` 的 `ReviewItem.targets()` 改为只返回 `ReviewTarget(item.group_order, item.sub_no, item.note())`；删除 suspect 额外卡分支。`ReviewTarget` 保留（作为渲染入参），但不再有"关联卡"概念。
- `review_queue.py:162-164` 的 `note()` 对 `missing` 返回「题目缺失或被吞，请按原卷补录」，保持不变；B3 的措辞冲突随关联卡取消而消失。
- 警告行 `manual_fix.py:244-245` 改为基于 suspect 渲染的提示文字，明确写出两个题号，不再用「本题/关联题」的相对指代。
- `manual_fix.py` 中所有 `target.group_order` / `target.sub_no` 改回 `item.group_order` / `item.sub_no`，涉及 `:232`、`:306`、`:313`、`:318`、`:321`、`:430`、`:549`、`:636`、`:643`、`:667`。`ReviewTarget` 退化为纯展示参数，数据身份只取 item。

### 3.3 独立收口（用户口径）

用户明确要求：「关联组不能关一个同时也将另一个关掉，需要单独处理。」独立成 issue 后，13 和 25 各有自己的 issue，14 和 26 各有自己的 issue，`mark_issue()`（`:245-301`）按 `(source, group_order, sub_no)` 收口，天然互不影响。补测试：题 25 确认无问题后题 26 仍 pending，反之亦然。

### 3.4 输入栏改造（prompt_toolkit）

本机已装 `prompt_toolkit 3.0.51`，写入 `requirements.txt`（`prompt_toolkit>=3.0.51`）。

新增 `src/terminal_input.py`：

| 函数 | 行为 |
|---|---|
| `read_line(prompt) -> str \| None` | 单行。Enter 提交；←→ 移动光标；退格/Delete 删除；`Ctrl+A/E` 行首行尾；↑↓ 历史；空行按 `Ctrl+D` 返回 `None`（沿用 EOF 语义）。 |
| `read_block(prompt) -> str` | 多行。Enter 换行；↑↓ 跨行移动光标；`EOF`/`END`/`结束` 独占行时按 Enter 提交；`Meta+Enter`、`Ctrl+D` 也可提交。 |

`review_editor.py:41-48` 的 `_read_line()` 和 `:136-155` 的 `_read_block()` 在 `sys.stdin.isatty()` 时委托新模块；非 TTY（管道 / CI）保持原 `sys.stdin.readline()` 路径不变。

约束：

- 提交后的处理链不变：`_split_at_marker()`（`:54-76`）、空行保留、`_restore_swallowed_option_label()`、`looks_like_ui_echo()`，保证整段粘贴与 EOF 语义不回退。
- `Console.prompt()` 的 `›` 作为 prompt_toolkit 的 message 传入，不再单独 `print`。
- 不引入 Vi 模式、自动补全、语法高亮等未要求能力。

### 3.5 不改动的部分

- `stem_chain.py` 算法、全局链仲裁逻辑一行不动。
- `apply_fixes.py` 写库逻辑与 DB schema 不动。
- `reopen_unbacked()` / `reopen_changed()` 策略不动（靠题号一致消除误判）。
- `mark_issue()` 已忽略 `kind`、`CONTENT_KINDS`、槽位编辑器逻辑保持现状。

---

## 4. 测试策略

| 测试 | 内容 |
|---|---|
| `test_review_queue.py` | `targets()` 只产出本卡；题 25 与 26 独立收口互不关闭 |
| `test_recognition_scan.py`（新增） | 带 suspect 的 missing issue 同时产出 suspect 题的 `merged_content` issue，题号不同、excerpt 正确 |
| `test_manual_fix.py`（新增） | 清单题号与卡片题号一致；答案缺失卡先渲染题号再进编辑；编辑后不整卡重绘 |
| `test_terminal_input.py`（新增） | 用 prompt_toolkit `PipeInput` 测光标左右/上下、退格、EOF 提交；非 TTY 路径回归 |
| 全量 | `cd tools/data-refinery && pytest`；含 DDL 无，跳过 schema_reconcile |
| 端到端冒烟 | 对 76816 卷跑一遍 `--dry-run` 扫描，确认清单列出 13/14/25/26 且各自独立；人工确认原题不再重现 |

---

## 5. 验收标准

1. 同一份卷的清单里，13 与 14、25 与 26 各自成行；卡片题号与清单逐行一致。
2. 卡片标题题号 = 补题记录题号 = 收口题号，不存在"显示 25、写入 26"。
3. 按 `k` 关一张卡只关对应题，另一张仍在待处理。
4. 上一轮已补录且写库、或已确认无问题的题，再次执行同一条导入命令不再冒出来（未写库的补录按现有设计仍会再问一次，不算 bug）。
5. 答案缺失卡显示题号与题干；输入栏支持光标移动、删除、多行上下编辑。
6. 非交互环境下行为与改造前逐字节一致。
