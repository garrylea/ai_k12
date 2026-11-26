# 人工校对（补题）交互重构设计

**日期**：2026-11-26
**状态**：已确认（2026-11-26，§9 四个取舍均按推荐）；实施计划见 `docs/superpowers/plans/2026-11-26-manual-review-redesign.md`
**范围**：`tools/data-refinery` 人工校对链路 —— `manual_fix.py`、`import_cli` 第 7 步、`fix_question_cli`、`review_by_numbers`
**不动**：`apply_fixes.py` 的补题记录契约、`recognition_scan.py` 的判据与 `content_sig` 重开规则、写库后的 publish/回灌

---

## 1. 现状盘点

### 1.1 入口与真实队列

| 入口 | 触发 |
|---|---|
| `import_cli` 第 7 步 | TTY 下自动进 `review_pending(sources)`，随后 `review_by_numbers()` |
| `src/fix_question_cli.py` | 单独跑，末尾会问「是否写库」 |
| `--fix-only` | 只跑第 7/8/9 步 |

2026-11-26 实测 `output/recognition_issues.jsonl`：

- 853 条记录，其中 **待处理 420 条 = 389 道题**，30 道题挂着 2 条以上 flag；
- 待处理按 kind：`incomplete_content` 209、`answer_missing` 65、`label_failed` 42、`missing` 39、`merged_content` 29、`repair_truncated` 14、`type_mismatch` 13、`options_incomplete` 7、`junk_question` 1、`punct_stem` 1；
- 待处理里带 `sub_no` 的 0 条。

结论：**同一道题被拆成多条排队**是当前最直接的重复来源。

### 1.2 分支树（现状）

```
_ask(issue)
├─ repair_truncated ──────> _ask_repair_truncated（两版并列 → 专用裁决菜单）
├─ 内容类 5 种 kind ──────> _ask_verdict（有没有问题）
│                             ├─ 没问题 → 只落 verdict，关 flag
│                             └─ 有问题 → _ask_slots（题干 / 共享材料 / 题内材料）
├─ 语文 missing ──────────> _ask_slots（同上）
└─ 其余（missing / punct / label_failed / junk / manual_override）
   └─ _targets() ─────────> 1~2 次 _ask_one

_ask_one
├─ answer_missing + 有原题 → _ask_answer_only
├─ 有原内容 → _ask_edit_mode（1 编辑器改 / 2 重新录入）
├─ 有原图 → _ask_image_mode（keep / replace / ocr / text 四选一）
├─ replace → _ask_new_images
├─ _collect_content：1 粘贴 / 2 图片 / 3 文件 / 4 剪贴板 / 5 多图+题干
├─ _confirm_text：1 确认 / 2 逐行编辑 / 3 重新输入 / 4 放弃 / 5 文件编辑
├─ prep()：按 mode 决定补原图 / 换占位符 / 再问配图
├─ 文章误当题干护栏 → 自动转材料 或 拒收重贴
├─ _ask_material_url（缺号题认领同卷文章）
└─ 答案（富输入菜单 + e/r/s 命令）
```

### 1.3 一次典型修复要按几次键

| 场景 | 现状输入次数 | 其中纯选择 | 目标 |
|---|---|---|---|
| 内容不完整（有 2 张图），只重贴题干 | 10–11 | 6 | ≤ 4 |
| 选项缺失，重贴题干+选项+答案 | 10 | 5 | ≤ 6 |
| 缺题补录（含答案） | 5–6 | 2 | ≤ 6 |
| 只缺答案 | 1 | 0 | 1 |
| 砍短保留现状 | 1 | 1 | 1 |
| 只改共享材料 | 6–8 | 4 | ≤ 4 |

### 1.4 六条根因

| # | 根因 | 表现 |
|---|---|---|
| R1 | **按 flag 排队，不按题** | 同一道题（30 道）换 kind 再问一遍；表格里同一题号出现两次 |
| R2 | **决策顺序反了** | 先问「图怎么处理 / 已有内容怎么改」，此时用户还没看到当前内容 |
| R3 | **每段各有一套确认** | `_confirm_text` 1–5、`_ask_edit_mode` 1–2、`_ask_image_mode` 1–4、`_ask_choice` 1–2/回车、答案 `e/r/s` 五套语义 |
| R4 | **图片策略横切整条流程** | keep/replace/ocr/text 四种模式散落在 `prep()`、`_ask_one`、`_collect_content` 三处 |
| R5 | **命令与内容抢输入** | 小写 `e/r/s` 是命令但可能是答案；`1..5` 是菜单但也可能是正文首行；空行=读剪贴板；`@` 是文件；`EOF` 是终止 |
| R6 | **收口口径不一致** | `mark_issue` 已按题关全部 flag，但 `_review_loop` 落记录时只关 `missing/punct/repair_truncated/内容类`，`junk_question`/`label_failed` 永远 pending |

---

## 2. 设计原则

1. **先看全，再选段**：一张卡片给全部现状（题干/选项/材料/答案/图/依据），然后才问改哪段。
2. **一题一次**：队列按 `(source, group_order)` 聚合，flag 只是卡片上的理由；一题只问一轮。
3. **默认安全**：回车结束本题但不写库、不关 flag；关 flag 必须显式 `k`；不静默丢图。
4. **命令与内容不抢**：槽内除空行外**一切都是内容**；命令统一 `:` 前缀。
5. **记录契约不变**：`apply_fixes` 零改动，旧 `manual_fixes/*.jsonl` 记录全部兼容。

---

## 3. 交互规格（逐屏）

### 3.1 队列首屏

```
识别问题补录
待处理 389 题（420 条） · 一题一次问完 · 回车=结束本题 · k=确认无问题 · s=稍后 · q=退出
────────────────────────────────────────────────────────────
  卷                                  题号  问题
  2024-…-西城·北师大实验-（上）期中-试卷  19   内容不完整 + 答案缺失
  2024-…-西城·北师大实验-（上）期中-试卷  24   缺题
  …
```

- 计数与表格**按题**，问题列把该题所有 kind 的人话理由合并（`humanize_reasons` 不变）。
- `--list` 只打这张表，不读 stdin（现状保持）。

### 3.2 卡片

```
▸ 第 7/389 题 · 第 19 题 · 内容不完整 + 答案缺失
  卷    2024-…-西城·北师大实验-（上）期中-试卷
  原卷  2024/…/试卷.pdf
  文本  output/md/…/试卷.md
  依据  标注时判定题干不完整
        题库里这道题的答案为空
  ⚠ 第 18 题的正文里可能混进了本题（先处理第 18 题，再回到本题）

  题干（128 字，可整段拷贝）
  │ 19. 如图所示……
  选项  A. …  B. …  C. …  D. …
  共享材料（1,240 字，可整段拷贝）
  │ ## 醉翁亭记
  │ 欧阳修……
  题内材料  无
  答案      空
  图片      2 张（图1 page_3_fig_1.jpg · 图2 page_3_fig_2.jpg）
```

- 题干/材料**不按终端宽度截断**，整段可拷（现状保持）。
- 共享材料默认显示前 8 行，`:p` 重看全文；`_editable_body`/`_copyable_question_text` 的能力合并进这里。
- `repair_truncated` 额外多一段：

```
  自动修复前（完整，可整段拷贝）
  │ ……
```

### 3.3 主菜单

```
要改哪段？ 1 题干/选项 · 2 共享材料 · 3 题内材料 · 4 答案 · 5 图
           E 编辑器改整题 · R 全换（清空材料/图） · k 确认无问题
           回车=结束本题 · s 稍后再说 · q 退出
›
```

| 输入 | 行为 |
|---|---|
| `1`–`5` | 进对应槽位（编辑完**回到卡片**，可再选另一段） |
| `E` | 把「题干+选项+题内材料」写成 `output/edits/` 下的文件、VS Code 非阻塞打开，回车读回（现有 `_file_edit`） |
| `R` | 全换：清空题干/选项/材料/图，重新给内容（见 §3.6） |
| `u` | 仅 `repair_truncated`：用自动修复前的原文（`content_only` 记录），不写库前还可再改 |
| `k` | 确认无问题：关掉该题**全部** flag（`verdict=no_change`），一个字段都不写库 |
| `回车` | 结束本题：改过 → 落补题记录；没改 → 什么都不发生（仍待处理） |
| `s` | 稍后再说（保持 pending） |
| `q` | 退出，剩下的保留到下次 |

菜单差异：

- 题干为空（缺题）：`E` 不显示；`1` 的提示变成「补录整题」。
- `junk_question`：`k` 的文案是「这行不是题目，忽略」（不删库，重扫不再检出时照常自愈）。
- 只有 `answer_missing` 且快照存在：**跳过菜单**，直接进槽位 4（见 §3.4 特例）。
- `repair_truncated` 找不到修复前原文：`u` 不显示，卡片注明「找不到修复前原文」。

### 3.4 槽位编辑器（五个槽共用一套）

槽内**只有一条规则**：除空行外，输入的一切都是内容；命令一律 `:` 前缀，永远不会被当内容误伤。

- 回车 = 不改（只缺答案的题不走菜单，见下）；
- 其余任何输入 = 内容。多行内容以 `EOF`（`END`/`结束` 亦可，现状保持）结束；
- 命令见下表，提示语里只列该槽支持的项。

| 命令 | 含义 | 1 题干/选项 | 2 共享材料 | 3 题内材料 | 4 答案 |
|---|---|---|---|---|---|
| `:e` | 用编辑器改（副本写 `output/edits/`，原文档不动；回车读回） | ✓ | ✓ | ✓ | ✓ |
| `:l` | 终端逐行改（无编辑器时兜底） | ✓ | — | ✓ | — |
| `:f` | 从文件/剪贴板取（图片走 MinerU，文件读文本） | ✓ | ✓ | ✓ | ✓ |
| `:c` | 清空 | ✓ | —（清共享文章请用 `R`） | ✓ | ✓（置空答案） |
| `:p` | 重看全文（卡片上被截断的段） | —（正文已全显） | ✓ | — | — |

提示语（一行，不折行）：

```
题干/选项 › （回车=不改；粘贴=整段替换，EOF 结束；:e 编辑器 · :l 逐行 · :f 文件/剪贴板 · :c 清空）
共享材料 › （回车=不改；粘贴=替换全文；:e · :f · :p 看全文 · 序号=沿用同卷文章 · n=本题无材料）
题内材料 › （回车=不改；粘贴=替换；:e · :l · :f · :c 删除）
答案 ›     （回车=不改；粘贴；:e · :f · :c 置空）
```

**共享材料的「序号 / n」**（把现有 `_ask_material_url` 并进这一步，不再单独弹一问）：

- 无当前文章、但同卷兄弟题有 `material_url` 时，先在卡片上方列出 `1 第12题 …`、`2 第15题 …`；
- 输入序号 = 本题沿用那篇（写 `material_url`）；
- `n` = 显式确认本题无材料（写 `material_url=NULL`）；
- 粘贴正文 = 新建/替换文章正文；新建时追问一次共用题号（`_ask_share_with`，不变）。

**特例：只缺答案的题**——直接进 `答案 ›`，不显示菜单；编辑完即结束本题（不再弹卡片）。

### 3.5 图槽

```
图（当前 2 张：图1 page_3_fig_1.jpg · 图2 page_3_fig_2.jpg）
1 追加图片 · 2 替换全部 · 3 清空 · 回车=不改 ›
```

选 1/2 后：

```
图片路径（多个用逗号，顺序即图1/图2；回车=读剪贴板，可连续；eof 结束）›
```

- 路径按书写顺序编号；**不再有「顺序对吗」确认**（2026-11-26 已删）。
- 回车读剪贴板：读到图就收下、清空剪贴板、再问一次；剪贴板没图即结束（等价 `eof`）。内容相同的图按 hash 拒收并提示（现状 `_collect_multi_image_flow` 的能力，合并到这里）。
- `3 清空` = 本题所有图片引用移除（content / 选项 / 材料里的 `![](…)`）。
- **`[图N]` 指向本题最终图序列**（先原图、后追加，按卡片上「图1/图2」的编号）。选 `2 替换全部` 时序列就是新图。
- 文本里还有没替换的 `[图N]` 时，保存前提示并直接进图槽：`! 正文里还有 [图2]，先配图`。

### 3.6 整题全换 `R`

```
全换（题干/选项/材料/图清空，答案保留）› 1 粘贴文本 · 2 图片识别（MinerU）· 3 文件 · 回车=取消
```

- 这是旧 `_ask_image_mode` 的 `text` 与 `ocr` 两种模式的**唯一入口**：`1/3` = 纯文本全换，`2` = 重新截图识别。
- 「答案保留」是刻意的：旧 `text` 模式会把答案重新问一遍，误按回车会把答案清空。要清答案用槽位 4 的 `:c`。
- 选中后收起内容，回到卡片显示新内容，再按回车落记录。

### 3.7 落记录

```
  ✓ 第 19 题：题干、答案（1 条待写库）
```

- 只列**实际改过的槽位**；没改过则 `· 第 19 题未改动（仍待处理）`。
- 一题一条记录（与现状一致：同题号在 `manual_fixes/<卷>.jsonl` 内覆盖，覆盖时保图 `_keep_prior_images`）。
- 一次粘贴里出现多个题号时：`! 这段含 3 个题号，将分别记录（建议一次一题）`，各生成一条并**就地结束本题卡片**（其余槽位不再问，提示「其余段请对每题单独再跑一次」——多题号下槽位归属无法确定，与现状 `_ask_slots` 的口径一致）。

**图片不丢不变量**（取代 `prep()` 的四种补图分支）：

> 除 `R 全换`、`5 图 → 3 清空` 与 `E`（用户在编辑器里显式改过整段）外，保存记录前把「原题有、记录里没有」的图片引用补回题干末尾，并 warn 一行。

### 3.8 队列收尾

```
本次补录 12 题（另有 3 条以前补的待写库）
确认无问题 40 题
稍后 5 题
仍待处理 332 题
落盘 output/manual_fixes
```

- 「另有 N 条以前补的待写库」：读 `pending_records()` 补一行，解决「补完不写库下次看不到」的困惑。
- 仍待处理列表按卷聚合（现状 `_print_remaining` 保持）。
- `q` / Ctrl+C 后照常打印剩余。
- 写库确认：`fix_question_cli` 末尾、`import_cli` 第 9 步，语义不变（一条命令）。

### 3.9 边界

| 情况 | 行为 |
|---|---|
| 非 TTY | 不进交互，打印待处理数 + 唯一入口命令（现状） |
| 找不到该题的 md | 跳过并计数，warn 一次 |
| extracted 里没有这道题 | 卡片显示「无当前内容」，只能 `1` 补录 / `k` 卷面本来没这题 / `s` |
| 粘贴的是本题共享文章 | 题干槽拒收，提示「改文章请按 2」；相似度 ≥0.9 时仍自动按共享材料记录（现状） |
| 题干解析为空、选项字母写在下方 | 拒收 + 排版提示，重问该槽（现状） |
| 界面文字回显 | 拒收（`looks_like_ui_echo` 保持） |
| 材料带终端折行痕迹 | 拒收（`looks_like_wrapped_copy` 保持） |
| 选项字母被终端吞 | 自动补 + warn（`_restore_swallowed_option_label` 保持） |
| 输入流 EOF | 当作「稍后」，不崩栈（现状） |

---

## 4. 能力对照表（证明功能不减弱）

| # | 旧入口 | 新入口 |
|---|---|---|
| 1 | `_ask_verdict` 有没有问题 | 主菜单 `k` / 直接改 |
| 2 | `_ask_edit_mode` 编辑器改 / 重新录入 | `E` / 槽位 1 粘贴 |
| 3 | `_ask_image_mode` 保留原图 | 默认行为（不丢图不变量） |
| 4 | `_ask_image_mode` 换图 | `5 图 → 1 追加 / 2 替换` |
| 5 | `_ask_image_mode` 重新截图识别 | `R → 2 图片识别` |
| 6 | `_ask_image_mode` 只改文本（原内容全不留） | `R → 1 粘贴`（答案保留，要清用 `4 → :c`） |
| 7 | 输入方式菜单 1/2/3/4/5 | 槽内：粘贴 / `:f` / 图槽 |
| 8 | 「多图+题干」逐张裁剪 | `5 图 → 1 追加`（回车连续读剪贴板，eof/空剪贴板结束） |
| 9 | `[图N]` 占位符 | 同（指向最终图序列），保存前未替换会提示配图 |
| 10 | `@路径` 读文件 | 同（仍支持，命令区也给了 `:f`） |
| 11 | 空行先探剪贴板 | `:f`（显式，避免和「回车=不改」冲突） |
| 12 | 答案富输入菜单 + `e/r/s` | 槽位 4 + `:e/:f/:c`（返回菜单要改题干就按 `1`） |
| 13 | `_confirm_text` 2 逐行编辑 / 5 文件编辑 | `:l` / `:e` |
| 14 | 三段式：题干 / 共享材料 / 题内材料 | 主菜单 1 / 2 / 3 |
| 15 | 材料「1 在文件里改 / 2 粘贴」 | `:e` / 粘贴 |
| 16 | 新建共享材料 + 共用题号 | 槽位 2 粘贴 + 一次「共用题号」追问 |
| 17 | `_ask_material_url` 认领同卷文章 | 槽位 2 的「序号 / n」 |
| 18 | 砍短两版裁决 1/2/3 | 卡片并列 + `k`（保留）/`u`（用原文）/改槽位 |
| 19 | 只补答案 | 只有 answer_missing 时自动进槽位 4 |
| 20 | 缺题先修「吸收内容的那一题」 | 队列内同一卡片先出关联题，再出本题 |
| 21 | 缺题/跳号误报只能一直跳过 | `k` = 卷面本来没这题（**新增**收口能力） |
| 22 | 主动重录（`review_by_numbers`） | 同一个卡片流程（`kind=manual_override`） |
| 23 | 状态收口 / 重开 / replay | 不变（见 §5.3） |

---

## 5. 数据与状态

### 5.1 队列模型

```python
@dataclass
class ReviewItem:
    source: str
    rel_path: str
    group_order: int
    sub_no: int = 0
    flags: list[dict]        # 同一题的全部 pending issue 记录
    manual: bool = False     # 主动重录
```

- 聚合键 `(source, group_order)`。`sub_no` 只用于卡片显示（实测 pending 里 0 条带 sub_no；收口口径仍按卷+题号，见 §5.3）。
- 排序 `(source, group_order)`，与手边 PDF 同序（现状）。
- 缺题（`missing`）若带 `suspect_group_order`，**先出关联题的卡片**（提示「只保留本题自己的内容」），再出本题；两张卡片同一套流程，不额外菜单。
- 轮到某题时先查 live 状态：全部 flag 已不是 pending → 跳过（保留现有「一次粘贴顺带补好别的题」的去重）。

### 5.2 记录生成

所有槽位写进一个 `Patch`，最后统一生成记录，键名与现状完全一致：

| Patch 字段 | 记录字段 |
|---|---|
| `content` / `options` | `content` / `options` |
| `answer` | `answer` |
| `material.article` + `inline` | `material_target=both`、`material_text`、`material_inline_text` |
| 仅 `article` | `material_target=article`、`material_text`、`material_scope=article` |
| 仅 `inline` | `material_target=inline`、`material_text`、`material_scope=inline` |
| `material.url_claim` | `material_url`（`None` = 显式无材料） |
| `material.share_with` | `material_share_with` |
| 题型不一致 | `expected_type=dominant_type` |
| `k` | 不产记录，`mark_issue(..., "resolved", verdict="no_change", content_sig=…)` |
| `u` | `content_only=True` + `content` |
| 只补答案 | `answer_only=True` + 原 `content`/`options` |

### 5.3 状态与收口（沿用，不改语义）

- `pending → recorded`：落记录后把该题**全部** pending flag 置 recorded（修 R6：不再按 kind 过滤）。
- `pending → resolved`：`k`（`verdict=no_change`，不写库）。
- `resolved` 但内容变了：`recognition_scan.reopen_changed` 靠 `content_sig` 退回 pending（不动）。
- `applied` 后被重导冲掉：`apply_fixes._replay_reason` 重放（不动）。
- `discard_fixes_for_source` 的「只作废已重抽出来的旧补题」规则（不动）。

### 5.4 不变的不变量

1. 同一题号后写覆盖前写时保图（`_keep_prior_images`）。
2. `answer_only` 记录不携带材料（避免材料归属判定误拦）。
3. `content_only` 记录只改题干（选项/材料/答案一律不碰）。
4. 外置文章（`material_url`）不进 `_editable_body`，避免整篇被当题干写回。
5. `material_url` 三态：未提及 = 不写该列；`None` = 写 NULL；字符串 = 写入。

---

## 6. 模块拆分

目标：把「输入原语 / 读现状 / 队列状态 / 记录生成」从 2695 行的 `manual_fix.py` 里拆出去，让主流程只剩「卡片 → 菜单 → 槽位」。

| 文件 | 职责 | 大约行数 |
|---|---|---|
| `src/review_editor.py` | `_read_line` / `_read_block` / `_split_at_marker` / 选项字母补回 / `_line_edit` / `_file_edit` / 剪贴板三通道 / MinerU / `@文件` / 回显与折行校验 | ~600 |
| `src/review_content.py` | 读 extracted / published / 文章正文 → `Snapshot`；材料槽路由（文章/素材判定）、认领候选、`_editable_body`、`_copyable_question_text` | ~400 |
| `src/review_queue.py` | issues.jsonl 读写、按题聚合、排序、`mark_issue`、剩余统计 | ~200 |
| `src/review_records.py` | `Patch` → 记录、落盘覆盖、保图不变量 | ~250 |
| `src/manual_fix.py` | 卡片渲染、主菜单、五个槽位、`R`/`E`/`u`/`k`、入口编排（`review_pending` / `review_by_numbers` / `main`） | ~700 |

- 依赖方向：`manual_fix → review_records → review_content → review_editor`，`review_queue` 独立；不新增包（与仓库扁平 `src/*.py` 风格一致）。
- 外部引用面不变：`apply_fixes`（`mark_issue`、`_read_jsonl/_write_jsonl`、`looks_like_ui_echo`、`looks_like_wrapped_copy`）、`import_cli`（`review_pending`、`review_by_numbers`、`discard_fixes_for_source`）、`fix_question_cli`（`FIXES_DIR`、`review_pending`）继续从原名字导入；搬迁的函数在原模块留一行 re-export 或直接改调用方（实施计划里按文件逐个定）。
- **不重写 `apply_fixes`**：它是写库侧契约，本次只保证记录形状不变。

---

## 7. 兼容与迁移

### 7.1 存量数据

- `recognition_issues.jsonl`：不改结构；新增字段一律可缺省（`verdict`/`note` 已有）。
- `manual_fixes/*.jsonl`：记录形状不变，旧 pending 记录照常被 `apply_fixes` 消费。
- 已 `resolved` 的 412 条不受影响。

### 7.2 测试迁移

| 现状测试 | 处理 |
|---|---|
| 输入原语（`_split_at_marker`、`_read_block`、行编辑、`_file_edit`、剪贴板探测、选项字母补回） | 原样保留，改 import 路径 |
| 材料路由（`_material_slots`、`_article_slots`、`_published_material_urls`、`same_article` 相关） | 原样保留 |
| 记录与落盘（保图、同号覆盖、`discard_fixes_*`） | 原样保留 |
| 流程类（`_ask_verdict`、`_ask_image_mode`、`_ask_edit_mode`、`_confirm_text`、答案 `e/r/s`、`_collect_content` 菜单） | 随分支删除**改写**成新菜单的会话脚本 |
| 新补 | 黄金会话：每类 kind 一条「按键序列 → 产生的记录 / 收口状态 / 输入次数」断言（见 §10） |

### 7.3 文档更新点

- `tools/data-refinery/README.md` §人工补题段落
- `docs/data-refinery-使用手册.md`「补题时图片怎么处理」「只补答案」两节 → 新菜单
- `docs/constraints/数据管线.md` 第 15 条（补题口径）与第 92 条（剪贴板菜单）→ 新交互；约束本身（不丢图、按题收口、材料自动路由）保留
- `docs/ai-core-changelog.md` 追加一条（按仓库惯例，历史条目不回改）

---

## 8. 明确不做

| 不做 | 原因 |
|---|---|
| 批量文件校对（一题一个文件、一次改完再统一 apply） | 一次要读/写几十道题的文件，出错难定位；现有「一题一卡」已能压到 2–3 次输入。列为备选，先不做 |
| Web/TUI 图形界面 | 依赖零新增、且操作者就在终端里对照 PDF |
| 按 `sub_no` 收口 | 现行按卷+题号收口是 2026-11-23 的裁决，改动会重开「同题重复问」；实测 pending 无 sub_no |
| 改 `apply_fixes` 契约 | 写库侧有大量护栏与回归钉，收益低风险高 |
| 自动删除文章文档 | 清空 `material_url` 的写库语义未定义，`R 全换` 已能覆盖使用场景 |

---

## 9. 取舍（2026-11-26 已定）

| # | 变更 | 决定 | 影响 |
|---|---|---|---|
| 1 | 槽内命令 `:e/:f/:c/:l/:p` | **采用** | 每个命令多按一个字符；换来「粘贴内容永不被误当命令」 |
| 2 | 答案槽「回车=不改」（现状回车=留空） | **采用** | 少一次误清空；清空改为显式 `:c`，肌肉记忆要改 |
| 3 | 缺题仍强制先过关联题卡片 | **采用** | 保持现状质量，多一次卡片浏览 |
| 4 | `k` 可用于 `missing`（卷面本来没这题） | **采用** | 修掉跳号误报永远 pending 的问题 |
| 5 | 队列按题聚合 | **采用** | 389 题 vs 420 条；30 道多 flag 只问一次 |
| 6 | 不做批量文件校对、不做 Web UI、不改 `apply_fixes` 契约、不按 sub_no 收口 | **采用** | 见 §8 |

**验收口径**：`k`/`s`/回车 三种「不写库」的出口必须行为分明；任何一次粘贴都不能被当成命令；不静默丢图。

---

## 10. 验收标准

1. **输入次数**：§1.3 六个场景的按键数不超过目标值（黄金会话测试断言 stdin 行数）。
2. **不丢能力**：§4 的 23 项逐条有测试或人工冒烟记录。
3. **状态正确**：`k` 关该题全部 flag；落记录后该题全部 flag 转 `recorded`；`s`/回车（未改）保持 `pending`。
4. **回归**：`apply_fixes` 与 `recognition_scan` 的测试全绿（不改它们）；`pytest tools/data-refinery` 全绿。
5. **人工冒烟**：用一份真实卷（建议 `2026 西城模拟二`）跑 `--fix-only`：缺题、内容不完整、砍短、缺答案各处理一题，确认「一题一卡、改完即走」。
6. **非交互**：管道运行不进入交互、打印唯一入口命令。
