# 人工校对（补题）交互重构设计

**日期**：2026-11-26
**状态**：v2 已修订（2026-11-26，按设计 review 修正清空语义、Patch 合并、多题粘贴、`sub_no` 身份与写库边界）。
以下旧表述已被 `2026-11-27-manual-review-identity-and-input-design.md` v2 取代，**以新设计为准**：
1. §4.2 卡片示例里「! 第 18 题的正文里可能混进了本题」的含糊关联提示 → 改为 `relation_text()` 按字段生成明确题号（第 N 题可能混入了第 M 题 / 疑似被第 M 题吞并）。
2. §4.3 `s`「不继续它的关联题目标」、§4.3 `k`「在关联题卡按 k 后继续进入本题卡」、§12「缺题先修关联题 / `ReviewItem.targets()` 先出关联卡」→ 取消关联卡；缺号题与其 suspect 在扫描阶段各自生成独立 issue，`targets()` 只返回自身，各自独立收口。
3. §4.3「成功后只显示修改已加入本次记录」→ 提示由 `ReviewDraft.revision` 驱动，只在本次动作真改了草稿时打印「第 N 题修改已加入本次记录（尚未保存）」，不整卡重绘。
**范围**：`tools/data-refinery` 人工校对链路 —— `manual_fix.py`、`import_cli` 第 7 步、`fix_question_cli`、`review_by_numbers`
**实施计划**：`docs/superpowers/plans/2026-11-26-manual-review-redesign.md`

**写库边界**：

- `recognition_scan.py`、publish/回灌规则、旧补题记录的读取兼容不动。
- `apply_fixes.py` 只做三类最小改动：搬迁后 import 改指向新模块；支持向后兼容的
  `clear_answer`（主 UPDATE 后补一条清空、`answer_only` 放宽空值拒绝，均不早退）；
  状态回写时把 `sub_no` 传给 `mark_issue`。旧 `manual_fixes/*.jsonl` 记录行为不变。
- 不新增数据库列，不新增 migration。

---

## 1. 设计结论

人工校对从「按 flag 排队 + 多套菜单」改为「按题一张卡 + 一张主菜单 + 五个槽位共用编辑器」。

本版另修掉五个会直接造成“看起来改成功、实际没改或写错题”的问题：

1. `回车`、`s`、`k` 是三个独立结果，不再共用 `None`。
2. 材料与图片使用显式三态草稿；一张卡内多次修改按字段合并，不互相覆盖。
3. 清空答案用新增的 `clear_answer=True` 记录字段；答案列为 `NOT NULL`，写库值用空串。
4. 一次粘贴多个题号时，题干/选项/材料按题号分别生成记录；答案不批量改。
5. 有 `sub_no` 时，编辑与收口身份为 `(source, group_order, sub_no)`；同一小问的全部 kind
   仍一次关闭。

---

## 2. 现状与根因

2026-11-26 实测 `output/recognition_issues.jsonl`：

- 853 条记录，其中待处理 420 条，对应 389 道题；
- 30 道题挂着 2 条以上 flag；
- 待处理记录里 `sub_no != 0` 为 0 条；
- 待处理 kind：`incomplete_content` 209、`answer_missing` 65、`label_failed` 42、
  `missing` 39、`merged_content` 29、`repair_truncated` 14、`type_mismatch` 13、
  `options_incomplete` 7、`junk_question` 1、`punct_stem` 1。

主要根因：

| # | 根因 | 结果 |
|---|---|---|
| R1 | 按 flag 排队，不按题 | 同一道题换 kind 再问一遍 |
| R2 | 先问图片/编辑策略，后展示内容 | 用户没看全现状就要做决策 |
| R3 | 每段各有一套确认菜单 | 同类输入在不同步骤含义不同 |
| R4 | 图片策略散落在流程各处 | 保留、换图、OCR、纯文本互相交叉 |
| R5 | 裸字母与正文抢输入 | `e/r/s`、`1..5`、空行都可能误伤内容 |
| R6 | 收口只处理部分 kind | `junk_question`、`label_failed` 长期 pending |

---

## 3. 设计原则

1. **先看全，再选段**：卡片先展示题干、选项、共享材料、题内材料、答案、图片和依据。
2. **同题一次**：普通题按 `(source, group_order, sub_no)` 聚合；同一身份的多个 kind
   只问一轮。
3. **草稿三态**：每个可清空字段必须能区分“未改 / 写入新值 / 显式清空”。
4. **组合可累加**：一张卡内改多个槽位时，Patch 按字段合并，不覆盖此前修改。
5. **默认安全**：回车只结束当前卡；没改动不写记录、不关 flag。
6. **命令不与内容抢**：槽内只有以 `:` 开头的已知命令才是命令；其余输入都是内容。
7. **清空必须显式**：`k`、回车、`s` 都不清数据；`:c`、图槽清空、`R` 才清数据。
8. **写库契约兼容**：旧记录继续可读；新增清空答案字段只做加法。

---

## 4. 交互规格

### 4.1 队列首屏

```text
识别问题补录
待处理 389 题（420 条） · 一题一次问完 · 回车=结束本题 · k=确认无问题 · s=稍后 · q=退出
────────────────────────────────────────────────────────────
  卷                                  题号  问题
  2024-…-西城·北师大实验-（上）期中-试卷  19   内容不完整 + 答案缺失
  2024-…-西城·北师大实验-（上）期中-试卷  24   缺题
```

- 计数与表格按题显示。
- 问题列合并该题当前待处理身份下的全部 kind。
- `--list` 只打印表格，不读取 stdin。

### 4.2 卡片

```text
▸ 第 7/389 题 · 第 19 题 · 内容不完整 + 答案缺失
  卷    2024-…-西城·北师大实验-（上）期中-试卷
  原卷  2024/…/试卷.pdf
  文本  output/md/…/试卷.md
  依据  标注时判定题干不完整
        题库里这道题的答案为空
  ! 第 18 题的正文里可能混进了本题（先核对第 18 题，再回到本题）

  题干（128 字，可整段拷贝）
  19. 如图所示……
  选项  A. …  B. …  C. …  D. …
  共享材料（1,240 字，可整段拷贝）
  ## 醉翁亭记
  欧阳修……
  题内材料  无
  答案      空
  图片      2 张（图1 page_3_fig_1.jpg · 图2 page_3_fig_2.jpg）
```

- “可整段拷贝”区域必须使用专用原样渲染器：
  - 不折行、不中截断；
  - 不把 `![](images/x.jpg)` 简化成 `[图]`；
  - 不加会混入复制内容的 `│` 边框。
- 共享材料默认显示前 8 个逻辑行；`:p` 用同一原样渲染器显示全文。
- `repair_truncated` 额外显示 `labeling_issues.jsonl.original_content` 中的完整修复前原文；
  找不到时明确显示“找不到修复前原文”。

### 4.3 主菜单

```text
要改哪段？ 1 题干/选项 · 2 共享材料 · 3 题内材料 · 4 答案 · 5 图
           E 编辑器改整题 · R 全换（清空材料/图）
           回车 保存并结束 · s 稍后（不保存） · k 该题无问题（不写库） · q 退出
```

| 输入 | 行为 |
|---|---|
| `1`–`5` | 进入对应槽位；本次真改了草稿才显示“第 N 题修改已加入本次记录（尚未保存）”和菜单，不整卡重绘（revision 驱动，见新设计 §5.3） |
| `E` | 编辑“题干 + 选项 + 题内材料”的副本；外置共享文章不进编辑器 |
| `R` | 清空题干、选项、题内材料、共享材料和图片，答案保留，再收新题面 |
| `u` | 仅 `repair_truncated`；把修复前原文放入当前草稿并返回卡片，可继续改 |
| `k` | 当前题目身份全部 flag 置 resolved + `verdict=no_change`，不写库 |
| 回车 | 当前卡有改动则生成记录；无改动则不写记录、不关 flag |
| `s` | 立即结束当前 `ReviewItem`，全部保持 pending（见新设计：已无关联目标） |
| `q` | 抛 `SystemExit(0)`；后续由入口打印剩余 |

`k` 的边界（见新设计 §5.1）：

- 每张卡只有自身题目身份 `(source, group_order, sub_no)`；按 `k` 只关闭本题当前身份下的全部 flag，不跨题也不跨 `sub_no`。
- 缺号题与其 suspect 已是两张独立卡，各自按 `k` 独立收口，不存在“先关联卡再本题卡”的接续。
- `junk_question` 的 `k` 文案为“这行不是题目，忽略”。

### 4.4 槽位编辑器

槽内规则：

- 回车：不改，返回卡片；
- `EOF` / `END` / `结束`：结束多行输入；
- 以 `:` 开头的已知命令按命令处理；
- 其他所有输入都作为内容。

旧的裸 `@路径` 不再支持；等价能力统一为 `:f`，避免 `@` 开头的真实内容被误判。

| 命令 | 1 题干/选项 | 2 共享材料 | 3 题内材料 | 4 答案 |
|---|---|---|---|---|
| `:e` 编辑器改 | 是 | 是 | 是 | 是 |
| `:l` 终端逐行改 | 是 | 否 | 是 | 否 |
| `:f` 文件/剪贴板取 | 是 | 是 | 是 | 是 |
| `:c` 清空 | 是 | 否 | 是 | 是 |
| `:p` 重看全文 | 否 | 是 | 否 | 否 |

共享材料槽额外支持：

- 输入序号：沿用同卷已有文章 URL；
- 输入 `n`：显式确认本题无材料，记录 `material_url=None`；
- 粘贴正文：替换或新建文章；新建时追问共用题号。

答案槽 `:c`：

- 草稿设置 `clear_answer=True`；
- 生成记录时同时写 `"answer": ""` 和 `"clear_answer": true`；
- `apply_fixes` 对现有题执行 `UPDATE questions SET answer=''`，并回写 extracted；
- 旧记录没有 `clear_answer` 时，空答案仍按旧语义“不覆盖已有答案”。

### 4.5 图片槽

```text
图（当前 2 张：图1 page_3_fig_1.jpg · 图2 page_3_fig_2.jpg）
1 追加图片 · 2 替换全部 · 3 清空 · 回车=不改
```

规则：

- 路径按书写顺序编号，不再问“顺序对吗”。
- 回车读剪贴板图片；连续回车可连续收图；无图等价于 `eof`。
- 剪贴板图和显式路径都按文件内容 hash 去重。
- `3 清空`：从本次记录将生成的 `content`、`options[].text`、`material_inline_text`
  中删除全部 Markdown 图片引用；**不改 `material_text`**——`material_target=article/both`
  时它承载共享文章正文，清它会把文章文档里的图一起删掉。
- `2 替换全部`：先按上面的范围删除旧图片引用，再按最终图片序列应用 `[图N]`；
  未占用的新图追加到题干末尾。
- `1 追加`：最终图片序列 = 当前草稿图片 + 新图，不使用旧 Snapshot 覆盖已追加结果。
- 外置共享文章文档内的图片不通过本题图槽清空；需要时进入共享材料槽 `:e` 修改文档副本。
- `[图N]` 指向最终图片序列；仍有未匹配的 `[图N]` 时，保存前提示并进入图槽。

### 4.6 全换 `R`

```text
全换（题干/选项/材料/图清空，答案保留） 1 粘贴文本 · 2 图片识别（MinerU）· 3 文件 · 回车=取消
```

- `1/3`：纯文本全换；`2`：重新截图识别。
- 草稿清空：
  - `content`、`options`；
  - `article`、`inline`；
  - 全部本题图片引用；
  - `material_url` 写显式 `None`。
- 答案原样保留。
- 新材料若被解析为 article 或 inline，则覆盖上面的清空结果。
- 选择后返回卡片显示新草稿，再按回车落记录。

### 4.7 多题号粘贴

题干槽粘贴内容先经现有 `split_questions()` / `_one_question_body()` 解析。

- 只有一个题号：进入当前题目的普通草稿。
- 超过一个题号：
  - 每个题号分别执行 `split_material_and_options()`；
  - 为每个题号用对应 Snapshot 补齐未改字段并生成一条记录；
  - 本次粘贴不批量修改答案；答案沿用各题当前值；
  - 生成后结束当前卡片，并提示“其余字段请逐题再跑一次”。

这样保留“一次粘贴多道题”的题干/选项/材料录入能力，同时不猜多道题的答案归属。

### 4.8 落记录与队列收尾

```text
  ✓ 第 19 题：题干、答案（1 条待写库）
```

- 只列实际改过的字段。
- 没改动：`· 第 19 题未改动（仍待处理）`。
- 一套卡片流程内，一题最终只留最新的一个补题记录。
- 同题覆盖仍调用 `_keep_prior_images()`，但在显式“图片清空/替换”时不补旧图。

收尾：

```text
本次补录 12 题（另有 3 条以前补的待写库）
确认无问题 40 题
稍后 5 题
仍待处理 332 题
落盘 output/manual_fixes
```

- “另有 N 条”使用本次实际 `fixes_dir` 统计。
- `q` / Ctrl+C 后打印按卷聚合的剩余题。
- 写库确认入口与现有 `fix_question_cli` / `import_cli` 第 9 步一致。

### 4.9 边界

| 情况 | 行为 |
|---|---|
| 非 TTY | 不进入交互；打印待处理数和唯一入口命令 |
| `md` 路径缺失 | 跳过该题，warn 一次，不崩栈 |
| extracted 无当前题 | 卡片显示无当前内容；允许补录、`k`、`s` |
| 粘贴内容是本题共享文章 | 题干槽拒收，要求进入共享材料槽 |
| 题干解析为空 | 拒收并提示排版，不生成记录 |
| 界面文字回显 | 拒收 |
| 材料带终端折行痕迹 | 拒收 |
| 选项字母被终端吞 | 自动补并 warn |
| 输入流 EOF | 当作 `s`，不崩栈 |
| 同题号多个 `sub_no` | 按小问分别成卡，不合并 |

---

## 5. 数据模型

### 5.1 ReviewItem

```python
@dataclass
class ReviewItem:
    source: str
    rel_path: str
    group_order: int
    sub_no: int = 0
    flags: list[dict] = field(default_factory=list)
    manual: bool = False

    @property
    def key(self) -> tuple[str, int, int]:
        return self.source, self.group_order, self.sub_no
```

聚合规则：

- 无小问：`(source, group_order, 0)`；
- 有政治等小问题：`(source, group_order, sub_no)`；
- 同一 key 下多个 kind 合成一张卡；
- 收口关闭该 key 下的全部 kind，不跨 `sub_no`。

这仍然满足“按卷+题号收口而非按 kind”，只是把已有 `sub_no` 纳入题目身份，避免以后出现小问 issue 时写错。

### 5.2 ReviewDraft / Patch

`UNSET` 是进程内唯一哨兵，不写入 JSON。

```python
UNSET = object()

@dataclass
class MaterialPatch:
    article: str | None | object = UNSET
    inline: str | None | object = UNSET
    url_claim: object = UNSET
    share_with: list[int] | None = None

@dataclass
class Patch:
    content: str | None = None
    options: list[dict] | None = None
    answer: str | None = None
    clear_answer: bool = False
    material: MaterialPatch = field(default_factory=MaterialPatch)
    images: list[str] = field(default_factory=list)
    images_mode: str = "keep"  # keep / append / replace / clear / explicit
    content_only: bool = False
```

`ReviewDraft` 只暴露字段级修改方法：

- `set_content()`、`set_answer()`、`clear_answer()`；
- `set_article()`、`set_inline()`、`clear_inline()`、`clear_materials()`；
- `claim_url()`、`set_share_with()`；
- `set_images()`，由图片槽传入最终序列和 mode。

禁止直接写 `state.patch.material = MaterialPatch(...)`，防止后改槽位覆盖先改槽位。
唯一例外是 `ReviewDraft.clear_materials()` 内部把 article、inline、url 三态一起设为清空。
`set_article()` 会同时把未提交的 `url_claim` 复位为 `UNSET`；`clear_materials()` 后再
`set_inline()` 则保留显式 `url_claim=None`，用来表达“清旧文章、只补新题内材料”。

### 5.3 材料落记录规则

| 草稿状态 | 记录字段 |
|---|---|
| article 新值 + inline 不改，本题本来没有 inline | `material_target=article`、`material_text=article`、`material_scope=article` |
| article 新值 + inline 不改，本题本来有 inline | `material_target=both`、`material_text=article`、`material_inline_text=原 inline`（写成 `article` 会让 apply 清掉题内素材） |
| article 不改 + inline 新值 | `material_target=inline`、`material_text=inline`、`material_scope=inline`（`material_url` 不动，两段共存） |
| article 新值 + inline 新值 | `material_target=both`、`material_text=article`、`material_inline_text=inline` |
| article 存在 + inline 清空 | `material_target=both`、`material_text=article`、`material_inline_text=""` |
| 无 article + inline 清空 | `material_target=inline`、`material_text=""`、`material_scope=inline` |
| `n` 或 `R` 清空全部材料 | `material_url=None`，不携带材料正文 |
| 只认领 URL + inline 新值 | `material_url=<url>`、`material_target=inline`、`material_text=inline` |
| 材料全部未改（语文） | 不带 `material_*` 键；apply 的 `material_text = existing_text` 会保留原值 |
| 材料全部未改（非语文且有 `material_text`） | `material_target=inline`、`material_text=原值`；不带会被 apply 写成 NULL（`material_text = rec.get("material_text")`） |

### 5.4 图片落记录规则

| mode | 落记录处理 |
|---|---|
| `keep` | 以**最终记录的 options** 为准：选项引用的图只保留在选项中，并从题干删除；原题有、最终选项未引用且新题干缺失的题干图补回末尾 |
| `append` | 使用草稿最终图片序列；替换 `[图N]`，未占用图追加 |
| `replace` | 按 `clear` 的范围删除旧图引用，再应用最终图片序列 |
| `clear` | 删除 content/options/`material_inline_text` 中的图片引用；不动 `material_text`（可能是文章正文） |
| `explicit` | `E` 编辑器路径；以用户读回内容为准，不自动补旧图 |

`Snapshot.images` 只能按编辑前的 options 做预过滤；生成最终记录时还必须按
`patch.options` 落到 `rec["options"]` 后的图片引用再过滤。否则“编辑前 options 为空、
本次编辑才把图补成选项”的场景仍会被 `keep` 重新塞回题干（76707 第 2 题）。

### 5.5 记录字段

旧字段维持不变，新增字段只允许：

| 草稿 | 记录 |
|---|---|
| 普通修改 | `content` / `options` / `answer` / 材料字段 |
| 答案 `:c` | `answer=""`、`clear_answer=True` |
| `u` 且未再改其他字段 | `content_only=True`、`content=<原文>` |
| `u` 后又改其他字段 | 普通记录；用修复前原文作为 content，其余字段取当前 Snapshot |
| 只缺答案且成功写入非空答案 | `answer_only=True`、原 content/options、无材料 |
| 多题号粘贴 | 每题一条普通记录，不携带 `answer_only`/`content_only` |

---

## 6. 状态与收口

- `pending → recorded`：保存记录后，关闭该 `ReviewItem.key` 下全部 pending flag。
- `pending → resolved`：`k`，写 `verdict=no_change` 与匹配该 key 的 `content_sig`。
- `resolved` 且内容变化：继续由 `recognition_scan.reopen_changed` 重开。
- `applied` 后被重导冲掉：继续由 `apply_fixes._replay_reason` 重放。
- `mark_issue()` 增加可选 `sub_no`：
  - 补题 UI 和 `recorded_flags()` 必须传当前 `sub_no`；
  - 旧调用不传时保持原语义，更新同 source/group 的全部记录。
- `mark_issue()` 增加可选 `statuses`：
  - `k` 与 `recorded` 只更新 `pending`；
  - 写库成功/被拒时只更新 `pending`、`recorded`；
  - 不得把已有 `resolved` 或 `verdict=no_change` 的 kind 降级成 recorded/pending。
- `close_as_ok()` 的 `content_sig` 必须取当前 key 的 flag；取不到时回退该题卡 Snapshot 对应 issue。

---

## 7. 模块拆分

| 文件 | 职责 |
|---|---|
| `src/review_editor.py` | 终端输入原语、槽位读取、图片读取、剪贴板/MinerU、原样渲染 |
| `src/review_content.py` | extracted/published/文章读取、Snapshot、当前草稿视图、材料路由 |
| `src/review_queue.py` | issues.jsonl 读写、按 `(source, group_order, sub_no)` 聚合、mark_issue、统计 |
| `src/review_records.py` | MaterialPatch/Patch、字段合并、记录生成、落盘、保图/清图、discard |
| `src/manual_fix.py` | 卡片、菜单、槽位编排、`R/E/u/k`、入口 |

依赖方向：

```text
manual_fix
  -> review_records
    -> review_content
      -> review_queue (只读 JSONL helper)
      -> review_editor
  -> review_queue
```

`review_queue` 不依赖 `review_content`。`discard_fixes_for_source` 归 `review_records`，因为它是记录维护逻辑且需要 `_current_question()`。

`manual_fix` 对旧外部调用保留 re-export：

- `FIXES_DIR`
- `ISSUES_FILE`
- `review_pending`
- `review_by_numbers`
- `discard_fixes_for_source`
- `mark_issue`
- `looks_like_ui_echo`
- `looks_like_wrapped_copy`

---

## 8. `apply_fixes` 最小改动

### 8.1 import 迁移

以下名字改从新模块导入或用 `manual_fix` re-export 继续导入：

- `mark_issue`：`review_queue`
- `_read_jsonl` / `_write_jsonl`：`review_queue`
- `looks_like_ui_echo` / `looks_like_wrapped_copy`：`review_editor`

### 8.2 清空答案

**不要在 `apply_record` 顶层早退**：一张卡可以同时改题干和清答案，顶层 `return` 会把
题干/选项/材料的改动一起吞掉（记录仍会被标 applied、flag 仍会被关）。清空只做进两条
已有路径：

1. 普通路径的主 UPDATE 用 `answer=COALESCE(NULLIF(%s,''), answer)`
   （`apply_fixes.py:1018`），空串清不掉。在主 UPDATE 之后补：

```python
if rec.get("clear_answer"):
    cur.execute("UPDATE questions SET answer='' WHERE id=%s", (qid,))
```

   extracted 回写沿用主 UPDATE 已传入的 `answer=""`（`_patch_extracted` 按空串写）。

2. `answer_only` 分支当前是 `if not answer: return "跳过：答案为空"`，改成：

```python
if not answer and not rec.get("clear_answer"):
    return "跳过：答案为空"
if rec.get("clear_answer"):
    answer = ""                     # 显式清空：绕过上面的空值拒绝
cur.execute("UPDATE questions SET answer=%s WHERE id=%s", (answer, qid))
```

`questions.answer` 是 `TEXT NOT NULL`，清空值是空串，不写 NULL。旧记录没有该字段时
完全走原路径（空答案仍被 `COALESCE(NULLIF(...))` 保留为原值）。

### 8.3 小问状态回写

`apply_fixes` 成功或拒绝单条记录后调用 `mark_issue()` 时，必须传入该记录的
`sub_no`。`applied_keys` / `rejected_keys` 的元组同步增加 `sub_no`，否则同题号的
另一个小问会被一并标成 resolved 或 pending。

---

## 9. 兼容与迁移

- `recognition_issues.jsonl` 不加必填字段。
- `manual_fixes/*.jsonl` 旧记录不改写、不批量迁移。
- 新字段 `clear_answer` 可缺省；旧版 `apply_fixes` 也不会把空答案覆盖旧答案，但新入口统一使用新版代码。
- 外置 article 文档仍不删除；`R` / `n` 只把当前题（及 `material_share_with` 语义覆盖范围）的
  `material_url` 清成 NULL。
- 不加 schema 列，不加 migration。

---

## 10. 明确不做

| 不做 | 原因 |
|---|---|
| 批量文件校对 | 错误定位成本高；一题一卡已覆盖主要场景 |
| Web/TUI 图形界面 | 操作者在终端对照 PDF |
| 自动删除共享文章文档 | 写库清 URL 与删资产是两件事 |
| 裸 `@路径` | 与“其他输入都是内容”冲突；`:f` 等价且更明确 |
| 多题号粘贴时批量改答案 | 答案归属无法可靠确定 |
| 跨 `sub_no` 一次收口 | 会把同一大题的其他小问误标完成 |

---

## 11. 验收标准

1. **出口分明**
   - `k`：当前 key 全部 pending flag 变 resolved；
   - 回车有改动：生成记录，当前 key 变 recorded；
   - 回车无改动：仍 pending；
   - `s`：立即结束当前 ReviewItem，仍 pending；
   - EOF：按 `s` 处理。
2. **Patch 可组合**
   - 依次修改 article、inline、answer、图片后，所有修改都进入最终记录；
   - 连续追加两次图片不丢第一批。
3. **清空有效**
   - 答案 `:c` 写库后数据库中该题 answer 为空串；
   - 题内材料 `:c` 清空数据库和 extracted；
   - 图片清空移除 content/options/`material_inline_text` 中的图片引用，且不动共享文章正文；
   - `R` 清空材料与 URL，答案保留。
4. **多题粘贴**
   - 一次粘贴 27、28 两题生成两条记录；
   - 各题答案保持原值，未被批量清空或错填。
5. **小问安全**
   - 同题号 `sub_no=1,2` 生成两张卡；
   - 完成小问 1 不关闭小问 2 的 flag。
6. **输入不误判**
   - 答案 `e/r/s/1/@foo/:` 等普通内容可录入；
   - 只有已知 `:` 命令被解释为命令；
   - `:f` 支持文本文件、图片文件、剪贴板图片/文件。
7. **卡片可拷贝**
   - 长行不截断；
   - 图片引用显示真实 Markdown；
   - 修改后不整卡重绘；当前草稿状态由后续菜单动作和最终记录生成保持。
8. **回归**
   - `apply_fixes` 旧记录测试全绿；
   - `recognition_scan` 测试全绿；
   - `pytest tools/data-refinery` 全绿；
   - 非 TTY 不读 stdin，打印唯一入口命令。
9. **人工冒烟**
   - 真实卷处理缺题、内容不完整、砍短、缺答案各一题；
   - 每类记录实际写入后复扫状态正确。
10. **输入次数**（黄金会话按 stdin 行数断言）
    - 改题干（粘贴替换）：≤ 4 次输入；
    - 只改共享材料或题内材料：≤ 4 次；
    - 只补答案：≤ 2 次；
    - 砍短保留现状：1 次；
    - 改题干 + 清答案同一张卡：≤ 6 次，且两条修改都落进同一条记录。

---

## 12. 旧能力落点（抽查表）

| 旧入口 | 新入口 |
|---|---|
| `_ask_edit_mode` 编辑器改 | `E` |
| `_ask_edit_mode` 重新录入 | 槽位 1 粘贴 |
| `_ask_image_mode` 保留原图 | 默认 `keep` |
| `_ask_image_mode` 换图 | `5 图 → 1 追加 / 2 替换` |
| `_ask_image_mode` 重新识别 | `R → 2 图片识别` |
| `_ask_image_mode` 只改文本 | `R → 1 粘贴`（答案保留，清答案用 `4 → :c`） |
| 输入方式菜单 1/2/3/4/5 | 粘贴 / `:f` / 图槽（裸 `@路径` 取消） |
| 「多图+题干」逐张裁剪 | `5 图 → 1 追加`（回车连续读剪贴板） |
| `[图N]` 占位符 | 同，指向最终图片序列 |
| 答案富输入 + `e/r/s` | 槽位 4 + `:e/:f/:c`（改题干回菜单按 1） |
| `_confirm_text` 逐行/文件编辑 | `:l` / `:e` |
| 三段式：题干/共享材料/题内材料 | 主菜单 1/2/3 |
| 材料「1 文件改 / 2 粘贴」 | `:e` / 粘贴 |
| 新建共享材料 + 共用题号 | 槽位 2 粘贴 + 一次共用题号追问 |
| `_ask_material_url` 认领同卷文章 | 槽位 2 的「序号 / n」 |
| 砍短两版裁决 | 卡片并列 + `k`（保留）/`u`（用原文） |
| 只补答案 | `answer_missing` 直达槽位 4 |
| 缺题/被吞题 | 扫描阶段各自生成独立 issue、各自成卡收口；`ReviewItem.targets()` 只返回自身（见新设计 §5.1） |
| 跳号误报只能一直跳过 | `k` = 卷面本来没这题 |
| 主动重录 | 同一卡片流程（`manual_override`） |
