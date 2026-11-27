# 人工校对：题号身份统一与输入栏改造设计

**日期**：2026-11-27
**状态**：v2 已实现并通过门禁（2026-11-27；按 review 修正 B5 根因、独立 issue 契约、`sub_no` 身份、重绘边界与真实 case 门禁；真实 76816 E2E + 全量 pytest 均 PASS）
**范围**：`tools/data-refinery` 人工校对链路 —— `recognition_scan.py`、`review_queue.py`、`manual_fix.py`、`review_editor.py`、新增 `terminal_input.py`、对应测试及真实 case fixtures
**关联**：2026-11-26 人工校对重构（`2026-11-26-manual-review-redesign-design.md`）、2026-11-27 数学题号全局链
**实施计划**：`docs/superpowers/plans/2026-11-27-manual-review-identity-and-input.md`

---

## 1. 设计结论

题号身份只由 `ReviewItem` 决定：

```text
题目身份 = (source, group_order, sub_no)
显示题号 = group_order + sub_no
补题记录题号 = group_order + sub_no
收口题号 = group_order + sub_no
```

`ReviewTarget` 不再携带第二道题的身份，也不再有“关联卡”。被缺号题吞并的上一题在扫描阶段生成自己的 `merged_content` issue，两张卡各自读写自己的题号并独立收口。

同时完成四组边界修正：

1. 独立 issue 必须带明确关联字段、内容指纹和 `sub_no`，不能只复制 missing issue 的全部理由。
2. 编辑后的界面反馈由草稿 revision 驱动；只有本次动作真正修改了草稿才打印“已加入本次记录（尚未保存）”并继续显示菜单，不整卡重绘。
3. `answer_missing` 快速路径先显示完整卡片，再进入答案输入。
4. `prompt_toolkit` 输入由显式 prompt 适配层接入，共享历史；非 TTY 路径保持原行为。

最终验收以真实卷
`数学-初三(上)-202407-北京各-（上）期中-试卷-76816` 为准。该卷的原始 `.md` 和对应
extracted 快照进入测试 fixtures；只要该真实 case 未通过，不得把任务标记完成。

---

## 2. Bug 结论

### B1 清单列 14 题，第一张卡却是第 13 题

**真实。**

- 清单使用 `item.group_order`，当前为 14。
- `ReviewItem.targets()` 给 missing issue 额外产出 suspect 卡 13，并排在本卡前。
- `render_card()` 展示 target 13，依据却来自 item 14。

修复后清单和卡片统一显示 item 身份。13 是独立 issue，因此在清单中单独成行。

### B2 同一份卷出现两个「第 25 题」

**真实，与 B1 同一根因。**

25 题自己的 `incomplete_content` 和 26 题 missing issue 的 suspect 卡都显示成 25。取消 target 关联卡后：

- 25 题卡：25 自己的 `incomplete_content + merged_content`。
- 26 题卡：26 自己的 `missing + stem_chain_*`。

### B3 关联卡里「本题」指代两道题，编辑写错题

**真实，与 B1/B2 同一根因。**

同一张卡的 note、警告和记录写入分别指向 target/item。修复后每张卡只有一个题目身份，记录和收口都只取 item。

### B4 编辑完题干，同一张卡又出现一次

**真实，独立根因。**

`edit_content_slot()` 成功后返回 `None`，`run_card()` 的 `while True` 回到顶部再次整卡渲染。该问题不只影响题干槽：`E`、材料、答案、图片、`R`、`u` 成功后也会走同一重绘循环。

修复不使用全局 `has_changes()` 猜测“这次是否改过”。第一次修改后 draft 会一直是 changed，后续原样返回的槽位不能据此判定为已编辑。`ReviewDraft` 增加进程内 revision，每次实际字段修改递增；`run_card()` 比较动作前后的 revision。

### B5 上一轮处理过的题，再执行导入命令又冒出来

**原结论只有一部分成立，需拆成三种状态。**

#### B5a 关联题记录写到了另一道题

真实。13/14、21/22 这类 suspect 组：

- suspect 卡按 target 写记录或收口。
- 缺号题自己的 record/fix 不存在，下一次扫描仍 pending。

这由 B1-B3 的身份错位导致，身份统一后修复。

#### B5b 普通缺号题 applied 后仍缺题号

与 target 无关。`reopen_unbacked(present=...)` 会在补题记录显示 applied、但当前 extracted
仍没有该题号时重新打开，等待 `needs_replay` 在第 9 步重放。18 没有 suspect，不能归因于
13/14 身份错位。

该重开是有意设计，不改成静默关闭。若用户未完成写库/重放，下一次仍提示是正确行为。

#### B5c `verdict=no_change` 后内容变化

只适用于有 `content_sig` 的内容层 issue。现有 missing issue 不生成 `content_sig`，所以
`reopen_changed()` 不会重开 missing。新生成的 suspect `merged_content` issue 必须带
`content_sig`，否则用户对吞并内容按 `k` 后，正文变化永远不会让旧结论失效。

### B6 答案缺失卡不显示题号

**真实。**

`answer_missing` 单 kind 快速路径直接进入 `edit_answer_slot()`，绕过卡片。修复为先
`render_card()`，再直接进入答案输入，不要求用户多按一次 `4`。

---

## 3. 真实 76816 case 的冻结事实

只读扫描当前真实产物得到：

| 类型 | 题号 |
|---|---|
| `missing` | 14、18、22、26 |
| suspect（上一题） | 13、21、25 |
| 已存在的 25 题内容 issue | 25 |

因此新算法在该卷至少产生以下 7 个题目身份：

```text
13  21  25  14  18  22  26
```

其中关联对为：

```text
13 merged_content  <- 14 missing
21 merged_content  <- 22 missing
25 merged_content  <- 26 missing
```

25 题还会聚合原有的 `incomplete_content`。18 没有 suspect，保持独立 missing。

测试 fixture 必须原样保存：

- 真实试卷 Markdown。
- 对应 extracted JSONL 快照。

预期文件与哈希：

| fixture | 源文件 | SHA-256 |
|---|---|---|
| `tests/fixtures/real_cases/76816/paper.md` | 当前 76816 `.md` | `ca9c91bcd9d5fb4ba670be106ae302f7e71dfddf522095dbf03a0cf34b201257` |
| `tests/fixtures/real_cases/76816/extracted.jsonl` | 当前 76816 extracted JSONL | `011b17dfa11d3da7663cc60cdd0680a711a16f6695d0aa6b3077e04d25f669d3` |

fixture 不读取被 gitignore 的 `output/`。真实 case 测试自行把 fixture 放入临时
`ROOT/output/...` 再执行扫描和人工校对。

---

## 4. 数据契约

### 4.1 issue 身份

`issue_key` 统一为：

```python
(source, group_order, sub_no, kind[, related_group_order][, line_no])
```

旧记录缺少 `sub_no` 时按 `0` 解释。`line_no` 仍只在非空时加入，避免普通 issue 的 key
发生无意义变化；suspect issue 有 `related_group_order` 时把它加入 key，避免同一 suspect
被不同缺号题引用时互相覆盖。

`fixed_numbers()` 从 `group_order -> applied` 改为
`(group_order, sub_no) -> applied`。旧补题记录缺少 `sub_no` 时按 `0` 解释。

### 4.2 suspect 独立 issue

在 missing issue 有 `suspect_group_order` 时，同时生成：

```json
{
  "source": "<same>",
  "rel_path": "<same>",
  "pdf": "<same>",
  "md": "<same>",
  "group_order": 13,
  "sub_no": 0,
  "kind": "merged_content",
  "reasons": [
    "body_contains_stem_14",
    "prev_len_523_vs_median_166"
  ],
  "excerpt": "<13 当前完整 content>",
  "content_sig": "<content_sig(13.content)>",
  "related_group_order": 14,
  "related_issue_kind": "missing",
  "status": "pending"
}
```

规则：

1. `reasons` 只保留描述上一题的 `prev_*` 理由，并新增
   `body_contains_stem_<missing_no>`。不得复制 `missing_stem`、
   `md_has_no_such_stem`、`next_starts_with_subq_no_stem` 等缺号题自身理由。
2. `sub_no` 取 suspect 当前 extracted 行的 `sub_no`，缺省为 0。
3. `content_sig` 取 suspect 当前 content；这是 `reopen_changed()` 的依据。
4. `related_group_order` 指向缺号题；`related_issue_kind="missing"` 固定表示
   “本卡疑似吞并了关联题”。
5. 卡片文案由字段生成，不从 reasons 文本反解析关系。

### 4.3 issue 去重

同卷同题同小问同 kind、同 `related_group_order` 的 suspect issue 只保留一条。

`group_items()` 仍按 `(source, group_order, sub_no)` 聚合 kind。25 的
`incomplete_content` 与 `merged_content` 因而进入同一张 25 题卡。

---

## 5. 人工校对交互

### 5.1 取消 target 多卡

`ReviewItem.targets()` 固定只返回自己的 `ReviewTarget(item.group_order, item.sub_no,
item.note())`。`run_item()`、`build_record()`、`close_as_ok()`、`snapshot_for()`、
`_issue_for()`、`recorded_flags()` 和编辑器文件名全部以 item 身份为真源。

多题号粘贴是唯一例外：`build_record()` 的 `group_order/sub_no` 参数仍表示用户刚粘贴出的
目标题号；调用点把 `part.group_order/part.sub_no` 传入，而不是 target。

### 5.2 关联提示

卡片根据关系字段显示明确题号：

- missing 卡：`第 26 题正文缺失，疑似被第 25 题吞并，请按原卷补录。`
- merged 卡：`第 25 题正文可能混入了第 26 题，请只保留第 25 题内容。`

禁止在同一卡内使用无法区分指代对象的“本题/关联题”。

### 5.3 编辑反馈与重绘

`ReviewDraft` 新增：

```python
revision: int = 0
```

所有实际修改字段的方法递增 revision，包括内容、答案、材料、URL、图片、共享题号和
`u` 恢复原文。未改、解析失败和取消编辑不递增。

`run_card()`：

1. 首帧渲染整卡。
2. 每次动作前记录 `before = draft.revision`。
3. 动作返回后若 `draft.revision > before`，打印
   `第 N 题修改已加入本次记录（尚未保存）`。
4. 继续只显示菜单，不重绘整卡。
5. 回车才落记录；`k/s` 在已有修改时仍要求二次确认。

“已加入本次记录”不是“已落盘”；只有回车并生成 manual fix record 后才进入 recorded。

### 5.4 答案缺失

当 `item.kinds == {"answer_missing"}` 且当前 content 非空：

```python
render_card(state)
edit_answer_slot(state)
return record/noop by has_changes
```

不显示菜单，不要求额外按 `4`。

---

## 6. 终端输入

### 6.1 适配层

新增 `terminal_input.py`：

| 函数 | 行为 |
|---|---|
| `read_line(message="") -> str \| None` | 单行编辑；Enter 提交；支持光标、退格/Delete、Ctrl+A/E、↑↓ 历史；空行 Ctrl+D 返回 `None` |
| `read_block(message="") -> str` | 多行编辑；Enter 换行；支持上下移动；`EOF/END/结束` 独立行提交；Meta+Enter、Ctrl+D 提交 |

模块级复用：

- 一个共享 `PromptSession` + `InMemoryHistory` 服务所有单行输入。
- 一个共享多行 session，避免每次调用重建缓冲区状态。
- 测试可注入 `PipeInput/DummyOutput`，生产代码不暴露测试专用分支。

### 6.2 prompt 接入

不得在 TTY 路径先用 `Console.prompt()` `print()` 再由 `prompt_toolkit` 接管。新增：

```python
def read_prompt(c: Console, prompt: str) -> str | None
```

行为：

- TTY：调用 `terminal_input.read_line(c.paint(prompt, "cyan"))`，提示只出现一次。
- 非 TTY：走原 `c.prompt(prompt)` + `sys.stdin.readline()`，保持原字节输出和 EOF 语义。

`manual_fix.py` 与 `review_editor.py` 中所有
`c.prompt(...); raw = _read_line()` 的配对都改为 `read_prompt(c, ...)`。

### 6.3 既有提交处理不变

提交后继续调用：

- `_split_at_marker()`
- 空行保留逻辑
- `_restore_swallowed_option_label()`
- `looks_like_ui_echo()`

`EOF` 在正文中任意位置结束的既有语义保持不变；`END/结束` 仍需独立成行。

---

## 7. 状态与重扫

| 操作/状态 | 下一次扫描 |
|---|---|
| `k` → resolved + `verdict=no_change` | missing 无 content_sig，不靠 `reopen_changed`；内容层 issue 仅在 sig 变化时重开 |
| 回车生成记录 → recorded | 不进待校对清单；入口显示“待写库/重放” |
| applied 且 extracted 已恢复题号 | 保持 resolved |
| applied 但 extracted 仍缺题号 | `reopen_unbacked(present=...)` 重开，等待第 9 步重放 |
| 补题文件被删除/作废 | 重开 pending |

本设计不把已存在的 pending 状态静默升级为 resolved。历史错误状态必须经过补录、写库、
重放或人工 `k` 才会收口。

---

## 8. 兼容与迁移

- `recognition_issues.jsonl` 新增字段均为可选。
- 旧 issue 没有 `related_group_order/related_issue_kind` 时，卡片不显示关联提示，但身份仍正常。
- 旧 issue 缺 `sub_no` 时按 0。
- 旧 manual fix 记录缺 `sub_no` 时按 0。
- `applied` 的语义不变。
- 不新增 DB 列，不新增迁移。
- 更新 `2026-11-26-manual-review-redesign-design.md` 中与新行为冲突的“槽位返回后整卡重绘”表述。

---

## 9. 测试与验收

### 9.1 真实 case

新增：

```text
tools/data-refinery/tests/test_manual_review_76816_e2e.py
```

该测试必须：

1. 读取冻结的真实 `paper.md` 和 `extracted.jsonl`。
2. 校验两个 fixture 的 SHA-256。
3. 用真实 md + extracted 生成 issue。
4. 断言 missing 集合为 `{14, 18, 22, 26}`。
5. 断言 derived pairs 为 `{(13, 14), (21, 22), (25, 26)}`。
6. 断言 pending item 身份至少包含 `{13,14,18,21,22,25,26}`。
7. 断言 13/14、21/22、25/26 的 `targets()` 都只返回自身。
8. 渲染并断言 13 卡标题是 13、14 卡标题是 14、25 卡标题是 25、26 卡标题是 26。
9. 对 13 和 26 执行记录生成，断言 record 的 `group_order` 分别是 13 和 26。
10. 对 13/14 执行 `k`，断言只关闭当前题，另一题仍 pending。
11. 对 13 的 `merged_content` 执行“确认无问题”后改变 suspect content，
    断言 `reopen_changed()` 因 content_sig 变化重开。
12. 断言 25 卡同时聚合 `incomplete_content + merged_content`。

门禁命令：

```bash
cd tools/data-refinery
pytest tests/test_manual_review_76816_e2e.py -q
```

该命令失败时，整项工作视为未完成，不能用其它单测通过替代。

### 9.2 单元测试

- `test_recognition_scan.py`：suspect issue 字段、reasons 过滤、content_sig、
  `issue_key` 含 `sub_no`、`fixed_numbers` 含 `sub_no`。
- `test_review_queue.py`：targets 单卡、关系字段不跨题收口、同题不同 sub 不合并。
- `test_manual_fix.py`：真实身份写入、B4 revision、B6 先渲染、所有编辑入口不整卡重绘。
- `test_terminal_input.py`：单行/多行、跨调用历史、Ctrl+D、EOF 标记、PipeInput。
- `test_review_flow.py`：删除/重写旧的“关联题先出卡”用例。

### 9.3 全量回归

```bash
cd tools/data-refinery
pytest -q
```

---

## 10. 验收标准

1. 清单、卡片、记录、收口、用户可见题号全部由 item 身份决定。
2. 76816 真实 case 的 derived pairs 为 `{(13,14),(21,22),(25,26)}`；
   pending 身份包含 `{13,14,18,21,22,25,26}`。
3. 13/14、21/22、25/26 各自独立收口，不跨题、不跨 `sub_no`。
4. suspect issue 带直接关联字段、过滤后的 reasons 和 content_sig。
5. 编辑成功后不整卡重绘；所有成功编辑入口都只追加一条“已加入本次记录”反馈。
6. answer_missing 先显示题号和题干，再进入答案输入。
7. TTY 提示只打印一次，↑↓ 跨多次单行输入保留历史；非 TTY 输出与改造前一致。
8. 真实 76816 E2E、单项测试和全量 `pytest` 全部通过。
