# 人工校对（补题）交互重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `tools/data-refinery` 的人工校对从「按 flag 排队 + 5 套菜单」改成「一题一卡 + 一张菜单 + 五个槽位共用一套编辑器」，在功能不减的前提下把典型场景的输入次数从 10–11 次压到 ≤4 次。

**Architecture:** 先做四个纯搬迁式抽离（输入原语 / 现状快照 / 队列聚合 / 记录生成），再新增槽位原语，最后重写 `manual_fix.py` 的流程编排并删除旧菜单。补题记录契约（`apply_fixes` 读取的字段）保持不变。

**Tech Stack:** Python 3.10 + pytest（`tools/data-refinery`）、纯终端交互（`cli_ui.Console`）、无新依赖。

**Spec:** `docs/superpowers/specs/2026-11-26-manual-review-redesign-design.md`

## Global Constraints

- 不改 `apply_fixes.py`、`recognition_scan.py`：记录形状与 `content_sig` 重开规则一律不动。
- 不改 `import_cli` 第 7/9 步的调用方式（`review_pending(sources=…)`、`review_by_numbers(…)`、`discard_fixes_for_source(…)`）。
- 不变的不变量：同题号覆盖保图；`answer_only` 不带材料；`content_only` 只改题干；外置文章不进编辑器正文；`material_url` 三态（未提及 / `None` / 字符串）。
- 槽位命令统一 `:` 前缀；槽内除空行外一切都是内容。
- 三条「不写库」出口必须分明：`k`（关该题全部 flag）、`回车`（有改动才落记录）、`s`（保持 pending）。
- 提示语不用 emoji；沿用 `cli_ui` 的 `✓ ! ·` 既有符号。
- 每个 Task 结束跑 `cd tools/data-refinery && python3 -m pytest -q`，必须全绿；单独提交。
- 搬迁函数**保留原名**（含前导下划线），`manual_fix` 顶部 import 后旧名字仍可解析，测试不必跟着改名。

---

## File Structure

| 文件 | 职责 | 状态 |
|---|---|---|
| `tools/data-refinery/src/review_editor.py` | 终端读行/读块、结束标记、选项字母补回、逐行编辑、外部编辑器、剪贴板三通道、MinerU、回显/折行校验、`Console` 单例 | Create |
| `tools/data-refinery/src/review_content.py` | 读 extracted/published/文章正文 → `Snapshot`；材料槽路由；题干/选项拆分；图片引用工具 | Create |
| `tools/data-refinery/src/review_queue.py` | `issues.jsonl` 读写、按题聚合 `ReviewItem`、排序、收口、剩余统计 | Create |
| `tools/data-refinery/src/review_records.py` | `Patch` → 补题记录（`apply_fixes` 契约）、落盘覆盖、保图 | Create |
| `tools/data-refinery/src/manual_fix.py` | 卡片渲染、主菜单、五个槽位、`R/E/u/k`、入口编排 | Modify（2695 → ~700 行） |
| `tools/data-refinery/tests/test_review_editor.py` | 原语测试（从 `test_manual_fix.py` 迁入） | Create |
| `tools/data-refinery/tests/test_review_content.py` | 快照与材料路由测试 | Create |
| `tools/data-refinery/tests/test_review_queue.py` | 聚合/收口测试 | Create |
| `tools/data-refinery/tests/test_review_records.py` | 记录形状黄金测试 | Create |
| `tools/data-refinery/tests/test_review_flow.py` | 新交互的会话脚本（按键序列 → 记录/状态/输入次数） | Create |
| `tools/data-refinery/tests/test_manual_fix.py` | 保留入口/夹具；流程类用例迁出后删除 | Modify |
| `tools/data-refinery/README.md`、`docs/data-refinery-使用手册.md`、`docs/constraints/数据管线.md`、`docs/ai-core-changelog.md` | 口径同步 | Modify |

依赖方向：`manual_fix → review_records → review_content → review_editor`；`review_queue` 只被 `manual_fix` 使用。

---

## Task 1: 抽出 `review_editor.py`（输入原语，纯搬迁）

**Files:**
- Create: `tools/data-refinery/src/review_editor.py`
- Modify: `tools/data-refinery/src/manual_fix.py`（删函数体，改为 import）
- Test: `tools/data-refinery/tests/test_manual_fix.py`（不改）

**Interfaces:**
- Produces（`manual_fix` 会 `from review_editor import …`，旧名可用）：
  - `console() -> Console`、`IMAGE_SUFFIXES: set[str]`、`_END_MARKERS: set[str]`
  - `_read_line(prompt="") -> str | None`、`_split_at_marker(text) -> tuple[str, bool]`、`_read_block(first_chunk="") -> str`
  - `_restore_swallowed_option_label(lines: list[str]) -> list[str]`
  - `_line_edit(text: str) -> str | None`、`_file_edit(text, label="题干", *, path=None) -> tuple[str | None, Path]`
  - `_clipboard_to_path(tmp_dir: Path) -> Path | None`、`_from_clipboard(paper_md_dir, *, silent=False) -> str | None`
  - `_from_image(paper_md_dir, path=None) -> str | None`、`_from_file(paper_md_dir, raw=None) -> str | None`
  - `_clear_clipboard() -> None`、`looks_like_ui_echo(text) -> bool`、`looks_like_wrapped_copy(text) -> bool`
  - `ROOT: Path`

- [ ] **Step 1: 建立模块并原样剪切函数**

从 `src/manual_fix.py` **整段剪切**（函数体一个字不改）到新文件，顺序：

`_CONSOLE`/`console`、`IMAGE_SUFFIXES`、`_END_MARKERS`、`_read_line`、`_END_WORD_RE`、`_split_at_marker`、`_OPTION_LINE_HEAD_RE`、`_LOST_LABEL_HEAD_RE`、`_restore_swallowed_option_label`、`_read_block`、`_image_to_markdown`、`_STRONG_ECHO`/`_WEAK_ECHO`/`_ECHO_MARKERS`/`_ECHO_RULE_RE`/`looks_like_ui_echo`、`_ask_path`、`_from_image`、`_from_file`、`_CLIPBOARD_APPLESCRIPT`/`_probe_macos_clipboard`/`_probe_linux_clipboard`/`_clipboard_to_path`/`_from_clipboard`、`_EDIT_HINT`/`_line_edit`、`_find_editor`/`_file_edit`、`_clear_clipboard`、`looks_like_wrapped_copy`。

顶部 import：

```python
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

from cli_ui import Console

ROOT = Path(__file__).resolve().parents[1]
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
```

- [ ] **Step 2: 在 `manual_fix.py` 顶部改为 import**

```python
from review_editor import (          # noqa: F401 - 旧调用点/测试仍用这些名字
    IMAGE_SUFFIXES, ROOT, _ask_path, _clear_clipboard, _clipboard_to_path,
    _file_edit, _from_clipboard, _from_file, _from_image, _line_edit,
    _read_block, _read_line, _restore_swallowed_option_label, _split_at_marker,
    console, looks_like_ui_echo, looks_like_wrapped_copy,
)
```

删除 `manual_fix.py` 里已搬走的 import（`hashlib`/`tempfile`/`subprocess` 若不再使用也删；`getpass`/`json`/`shutil`/`re`/`sys` 后续任务还会用）。

`apply_fixes.py` 的 `from manual_fix import looks_like_ui_echo, looks_like_wrapped_copy` 改为：

```python
from review_editor import looks_like_ui_echo, looks_like_wrapped_copy
```

- [ ] **Step 3: 跑测试确认零行为变化**

```bash
cd tools/data-refinery && python3 -m pytest -q
```

Expected: `PASS`（与改动前同样的通过数，166 左右）。

- [ ] **Step 4: 提交**

```bash
git add tools/data-refinery/src/review_editor.py tools/data-refinery/src/manual_fix.py
git commit -m "refactor(refinery): 抽出人工校对的输入原语到 review_editor"
```

---

## Task 2: 抽出 `review_content.py` + 现状快照 `Snapshot`

**Files:**
- Create: `tools/data-refinery/src/review_content.py`
- Create: `tools/data-refinery/tests/test_review_content.py`
- Modify: `tools/data-refinery/src/manual_fix.py`

**Interfaces:**
- Consumes: `review_editor.ROOT`、`subject_codes`、`chinese_material_doc`
- Produces:
  - `@dataclass Snapshot(content, options, answer, article_url, article, inline, images, repair_original)`（字段全部可空/可为空列表）
  - `snapshot(issue: dict) -> Snapshot`
  - `split_questions(text, strategy)`、`_one_question_body(parts)`、`split_material_and_options(strategy, body)`
  - `_image_refs(*texts)`、`_append_missing_images(text, refs)`、`_apply_image_placeholders(text, refs)`
  - `_material_slots(issue) -> dict`、`_published_material_urls(issue)`、`_paper_question_rows(issue)`
  - `_copyable_question_text(issue)`、`editable_body(snap: Snapshot) -> str`、`_subject_of(issue)`、`_repair_original(issue) -> str | None`、`_KEEP_URL`

- [ ] **Step 1: 写失败测试**

`tests/test_review_content.py`：

```python
import json
from pathlib import Path

import pytest

import review_content


def _write(tmp_path, monkeypatch, issue, extracted_row):
    md_dir = tmp_path / "md" / issue["rel_path"]
    md_dir.mkdir(parents=True, exist_ok=True)
    (md_dir / "卷A.md").write_text("", encoding="utf-8")
    ex = tmp_path / "extracted" / issue["rel_path"] / f"{issue['source']}.jsonl"
    ex.parent.mkdir(parents=True, exist_ok=True)
    ex.write_text(json.dumps(extracted_row, ensure_ascii=False) + "\n", encoding="utf-8")
    monkeypatch.setattr(review_content, "ROOT", tmp_path)
    return {**issue, "md": str(md_dir / "卷A.md")}


def test_snapshot_reads_current_question(tmp_path, monkeypatch):
    issue = _write(
        tmp_path, monkeypatch,
        {"source": "卷A", "rel_path": "物理/初中/first/2024/卷A", "group_order": 19},
        {"group_order": 19, "content": "19. 旧题干", "options": [{"label": "A", "text": "甲"}],
         "answer": "甲", "material_text": "题内素材", "material_url": None},
    )
    snap = review_content.snapshot(issue)
    assert snap.content == "19. 旧题干"
    assert snap.options == [{"label": "A", "text": "甲"}]
    assert snap.answer == "甲"
    assert snap.inline == "题内素材"
    assert snap.images == []


def test_snapshot_missing_question_is_empty(tmp_path, monkeypatch):
    issue = _write(
        tmp_path, monkeypatch,
        {"source": "卷A", "rel_path": "物理/初中/first/2024/卷A", "group_order": 20},
        {"group_order": 19, "content": "别的题"},
    )
    snap = review_content.snapshot(issue)
    assert snap.content == "" and snap.answer == "" and snap.options == []
```

- [ ] **Step 2: 运行确认失败**

```bash
cd tools/data-refinery && python3 -m pytest tests/test_review_content.py -q
```

Expected: `ModuleNotFoundError: No module named 'review_content'` 或 `AttributeError: snapshot`。

- [ ] **Step 3: 搬迁 + 实现 `Snapshot`**

把下列函数整段剪切到 `review_content.py`（不改函数体）：`split_questions`/`_STEM_PREFIX_RE`、`_one_question_body`、`split_material_and_options`、`_subject_of`、`_copyable_question_text`、`_KEEP_URL`、`_published_material_urls`、`_looks_like_article_text`、`_read_article_body`、`_article_slots`、`_question_article`、`_article_similarity`、`_material_slots`、`_paper_question_rows`、`_current_question`、`_IMG_REF_RE`/`_IMG_PLACEHOLDER_RE`/`_image_refs`/`_append_missing_images`/`_apply_image_placeholders`。

新增：

```python
from dataclasses import dataclass, field


@dataclass
class Snapshot:
    content: str = ""
    options: list[dict] = field(default_factory=list)
    answer: str = ""
    article_url: str | None = None
    article: str | None = None
    inline: str | None = None
    images: list[str] = field(default_factory=list)
    repair_original: str | None = None


def snapshot(issue: dict) -> Snapshot:
    """一道题的全部现状，供卡片展示与记录兜底（不改库）。"""
    row = _current_question(issue) or {}
    slots = _material_slots(issue)
    opts = row.get("options") or []
    imgs = _image_refs(
        row.get("content") or "",
        row.get("material_text") or "",
        *(str((o or {}).get("text") or "") for o in opts),
    )
    return Snapshot(
        content=(row.get("content") or "").strip(),
        options=opts,
        answer=(row.get("answer") or "").strip(),
        article_url=slots["article_url"],
        article=slots["article"],
        inline=slots["inline"],
        images=imgs,
        repair_original=_repair_original(issue),
    )
```

`_repair_original` 从 `manual_fix.py` 一起搬过来（它只依赖 `ROOT` 与 `_read_jsonl`；`_read_jsonl` 此时还在 `manual_fix`，为避免循环 import，把 `_read_jsonl` 的**实现**复制一份私有函数到 `review_content.py`——Task 3 完成后改成 `from review_queue import _read_jsonl`）。

`editable_body` 取代原 `_editable_body(original: dict)`，改为吃快照（外置文章不进正文，与旧行为一致）：

```python
def editable_body(snap: Snapshot) -> str:
    lines = [snap.content.strip()]
    for o in snap.options:
        label = (o.get("label") or "").strip()
        if label:
            lines.append(f"{label}. {(o.get('text') or '').strip()}".rstrip())
    if not snap.article_url and snap.article:
        lines += ["", snap.article]      # 未外置的整篇仍在 material_text 里
    if snap.inline:
        lines += ["", snap.inline]
    return "\n".join(lines).strip()
```

- [ ] **Step 4: 测试适配（ROOT 挪家）**

`tests/test_manual_fix.py` 里 `monkeypatch.setattr(manual_fix, "ROOT", X)` 共 20 处，搬迁后要落到真正读它的模块。在文件顶部加：

```python
def _patch_root(monkeypatch, root):
    import review_content, review_editor, review_records
    for mod in (review_editor, review_content, review_records):
        monkeypatch.setattr(mod, "ROOT", root)
```

把每处 `monkeypatch.setattr(manual_fix, "ROOT", X)` 替换成 `_patch_root(monkeypatch, X)`：

```bash
cd tools/data-refinery
perl -0pi -e 's/monkeypatch\.setattr\(manual_fix, "ROOT", ([^\n]+)\)/_patch_root(monkeypatch, $1)/g' tests/test_manual_fix.py
```

`_patch_root` 定义放在第一个用到它的用例之前（`import` 段之后）。

- [ ] **Step 5: 运行测试**

```bash
cd tools/data-refinery && python3 -m pytest tests/test_review_content.py -q && python3 -m pytest -q
```

Expected: 新测试 2 passed；全量通过。

- [ ] **Step 6: 提交**

```bash
git add tools/data-refinery/src/review_content.py tools/data-refinery/src/manual_fix.py tools/data-refinery/tests/
git commit -m "refactor(refinery): 抽出校对的现状快照与材料路由到 review_content"
```

---

## Task 3: 抽出 `review_queue.py` + 按题聚合

**Files:**
- Create: `tools/data-refinery/src/review_queue.py`
- Create: `tools/data-refinery/tests/test_review_queue.py`
- Modify: `tools/data-refinery/src/manual_fix.py`、`tools/data-refinery/src/review_content.py`、`tools/data-refinery/src/apply_fixes.py`（只改 import）

**Interfaces:**
- Produces:
  - `ISSUES_FILE: Path`、`FIXES_DIR: Path`
  - `_read_jsonl(path) -> list[dict]`、`_write_jsonl(path, rows) -> None`
  - `@dataclass ReviewItem(source, rel_path, group_order, sub_no, flags, manual=False)`
  - `group_items(issues: list[dict]) -> list[ReviewItem]`（按 `(source, group_order)` 聚合、按 `(source, group_order)` 排序）
  - `pending_items(sources=None, file=None) -> list[ReviewItem]`
  - `mark_issue(source, group_order, status, *, note=None, fix_file=None, **extra) -> int`（保持现名，`apply_fixes` 在用）
  - `recorded_flags(item, fix_file, recorded_at) -> int`（把该题全部 pending flag 置 recorded，**不按 kind 过滤**）
  - `remaining_items(sources=None, file=None) -> list[ReviewItem]`
  - `humanize_reasons(reasons) -> list[str]`、`KIND_TEXT: dict[str, str]`、`CONTENT_KINDS: tuple[str, ...]`
  - （`discard_fixes_for_source` 不放这里：它要读 `_current_question`，放 `review_records`，见 Task 4）

- [ ] **Step 1: 写失败测试**

`tests/test_review_queue.py`：

```python
import json

import review_queue


def _rows(tmp_path):
    return [
        {"source": "卷A", "group_order": 19, "kind": "incomplete_content",
         "reasons": ["subq_starts_at_2"], "status": "pending", "rel_path": "r", "md": "m"},
        {"source": "卷A", "group_order": 19, "kind": "answer_missing",
         "reasons": ["answer_empty"], "status": "pending", "rel_path": "r", "md": "m"},
        {"source": "卷A", "group_order": 7, "kind": "missing",
         "reasons": ["missing_stem"], "status": "pending", "rel_path": "r", "md": "m"},
        {"source": "卷A", "group_order": 8, "kind": "missing",
         "reasons": ["missing_stem"], "status": "resolved", "rel_path": "r", "md": "m"},
    ]


def test_group_items_merges_flags_of_same_question(tmp_path):
    items = review_queue.group_items(_rows(tmp_path))
    assert [(i.group_order, len(i.flags)) for i in items] == [(7, 1), (19, 2)]


def test_recorded_flags_closes_every_kind(tmp_path, monkeypatch):
    p = tmp_path / "issues.jsonl"
    p.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in _rows(tmp_path)),
                 encoding="utf-8")
    monkeypatch.setattr(review_queue, "ISSUES_FILE", p)
    item = review_queue.group_items(_rows(tmp_path))[1]
    assert review_queue.recorded_flags(item, "fixes/卷A.jsonl", "t0") == 2
    saved = [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines()]
    assert {r["status"] for r in saved if r["group_order"] == 19} == {"recorded"}
    assert {r["status"] for r in saved if r["group_order"] == 7} == {"pending"}


def test_remaining_items_is_per_question():
    items = review_queue.group_items([
        {"source": "卷A", "group_order": 19, "kind": "incomplete_content", "status": "pending"},
        {"source": "卷A", "group_order": 19, "kind": "answer_missing", "status": "pending"},
    ])
    assert len(items) == 1
```

- [ ] **Step 2: 运行确认失败**

```bash
cd tools/data-refinery && python3 -m pytest tests/test_review_queue.py -q
```

Expected: `ModuleNotFoundError`.

- [ ] **Step 3: 搬迁 + 实现**

搬入 `review_queue.py`：`ISSUES_FILE`/`FIXES_DIR`、`_read_jsonl`/`_write_jsonl`、`_REASON_TEXT`/`humanize_reasons`、`_KIND_TEXT`（改名 `KIND_TEXT`，保留 `_KIND_TEXT = KIND_TEXT` 别名）、`_CONTENT_KINDS`（保留别名）、`discard_fixes_for_source`、`mark_issue`、`pending_issues`。

```python
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from pathlib import Path

from scope_filter import match_keyword
from subject_codes import subject_code_for_path


@dataclass
class ReviewItem:
    source: str
    rel_path: str
    group_order: int
    sub_no: int = 0
    flags: list[dict] = field(default_factory=list)
    manual: bool = False

    @property
    def subject(self) -> str:
        return subject_code_for_path(Path(self.rel_path), default="") or "generic"

    @property
    def kinds(self) -> set[str]:
        return {f.get("kind") or "" for f in self.flags}

    @property
    def is_repair(self) -> bool:
        return "repair_truncated" in self.kinds

    @property
    def dominant_type(self) -> str | None:
        return next((f.get("dominant_type") for f in self.flags
                     if f.get("dominant_type")), None)

    def only_answer_missing(self) -> bool:
        return self.kinds == {"answer_missing"}

    def note(self) -> str:
        k = self.kinds
        if "type_mismatch" in k:
            return "这一题与同大题其它题的题型不一致，请录入完整题目（含 A–D 选项）"
        if "merged_content" in k:
            return "这一题混进了别的题的内容，请只录入本题自己的完整内容"
        if "options_incomplete" in k:
            return "这一题选项不全（PDF 转换时丢了），请录入完整题目（含 A–D 选项）"
        if "answer_missing" in k:
            return "这一题答案缺失，请补答案"
        if "missing" in k or "punct_stem" in k:
            return "这一题是缺失/被吞的，请录入完整题目"
        return "按原卷校对本题"

    def targets(self) -> list[tuple[int, str]]:
        """缺题先修「可能吸收了本题」的那一题，再补本题（2026-11-26 裁决保留）。"""
        suspect = next((f.get("suspect_group_order") for f in self.flags
                        if f.get("suspect_group_order")), None)
        seq: list[tuple[int, str]] = []
        if isinstance(suspect, int) and suspect != self.group_order:
            seq.append((suspect, "这一题的正文里混进了下一题，请只保留本题自己的内容"))
        seq.append((self.group_order, self.note()))
        return seq


def group_items(issues: list[dict]) -> list[ReviewItem]:
    """同卷同题号的多条 flag 合成一条，一道题只问一次（2026-11-26）。"""
    order: dict[tuple[str, int], ReviewItem] = {}
    for rec in issues:
        if rec.get("status") != "pending":
            continue
        key = (rec["source"], int(rec.get("group_order") or 0))
        item = order.get(key)
        if item is None:
            item = order[key] = ReviewItem(
                source=rec["source"],
                rel_path=rec.get("rel_path") or "",
                group_order=key[1],
                sub_no=int(rec.get("sub_no") or 0),
            )
        item.flags.append(rec)
        if int(rec.get("sub_no") or 0):
            item.sub_no = int(rec["sub_no"])
    return sorted(order.values(), key=lambda i: (i.source, i.group_order))


def pending_items(sources: set[str] | None = None,
                  file: str | None = None) -> list[ReviewItem]:
    rows = _read_jsonl(ISSUES_FILE)
    if sources is not None:
        rows = [r for r in rows if r.get("source") in sources]
    if file:
        rows = [r for r in rows if match_keyword(r.get("source") or "", file)]
    return group_items(rows)


def recorded_flags(item: ReviewItem, fix_file: str, recorded_at: str) -> int:
    """落记录后把该题**全部** pending flag 转 recorded（不再按 kind 过滤，修 R6）。"""
    return mark_issue(item.source, item.group_order, "recorded",
                      fix_file=fix_file, recorded_at=recorded_at)


def remaining_items(sources=None, file=None) -> list[ReviewItem]:
    return pending_items(sources, file)
```

`mark_issue` 现在把 `recorded_at` 走 `**extra`（已经支持 `extra` 写入）。若 `recorded_at` 传 None 则跳过（`extra` 里 `value is None: continue`）。

`apply_fixes.py` 的 `from manual_fix import mark_issue` 改为 `from review_queue import mark_issue`；`_read_jsonl/_write_jsonl` 同样改。`manual_fix.py` 顶部 import 这些名字，保持对外兼容。

同时清掉 Task 2 留的临时副本：`review_content.py` 里私有 `_read_jsonl` 删掉，改 `from review_queue import _read_jsonl`（依赖方向 queue ← content，不循环）。

- [ ] **Step 4: 测试适配（ISSUES_FILE 挪家）**

在 `tests/test_manual_fix.py` 顶部加：

```python
def _patch_issues(monkeypatch, path):
    import manual_fix, review_queue
    monkeypatch.setattr(review_queue, "ISSUES_FILE", path)
    monkeypatch.setattr(manual_fix, "ISSUES_FILE", path, raising=False)
```

把每处 `monkeypatch.setattr(manual_fix, "ISSUES_FILE", X)` 换成 `_patch_issues(monkeypatch, X)`：

```bash
cd tools/data-refinery
perl -0pi -e 's/monkeypatch\.setattr\(manual_fix, "ISSUES_FILE", ([^\n]+)\)/_patch_issues(monkeypatch, $1)/g' tests/test_manual_fix.py
```

（`mark_issue`/`pending_issues`/`group_items` 都在 `review_queue` 里读这个常量。）

- [ ] **Step 5: 运行测试**

```bash
cd tools/data-refinery && python3 -m pytest tests/test_review_queue.py -q && python3 -m pytest -q
```

Expected: 3 passed；全量通过。

- [ ] **Step 6: 提交**

```bash
git add tools/data-refinery/src/review_queue.py tools/data-refinery/src/manual_fix.py \
        tools/data-refinery/src/apply_fixes.py tools/data-refinery/tests/
git commit -m "refactor(refinery): 校对队列按题聚合，抽出 review_queue"
```

---

## Task 4: 抽出 `review_records.py` + `Patch` → 记录

**Files:**
- Create: `tools/data-refinery/src/review_records.py`
- Create: `tools/data-refinery/tests/test_review_records.py`
- Modify: `tools/data-refinery/src/manual_fix.py`

**Interfaces:**
- Consumes: `review_content.Snapshot`、`review_content._image_refs`
- Produces:
  - `KEEP_URL: object`（三态哨兵，与其他模块共用；`review_content._KEEP_URL` 指向同一个对象）
  - `@dataclass MaterialPatch(article=None, inline=None, url_claim=KEEP_URL, share_with=None)`
  - `@dataclass Patch(content=None, options=None, answer=None, material=None, images=None, cleared=False, images_cleared=False, images_replaced=False, restore_original=None, answer_only=False)`
  - `has_changes(patch) -> bool`
  - `build_record(item, target_no, patch, snap, *, dominant_type=None, kind=None) -> dict`
  - `preserve_images(text, refs) -> str`、`strip_images(text, refs) -> str`
  - `_copy_new_images(paths, paper_md_dir) -> list[str]`、`_keep_prior_images(old, new) -> None`、`_save_records(source, records, out_dir) -> Path`、`discard_fixes_for_source(...)`（原样搬，`manual_fix` 再导出给 `import_cli`）

- [ ] **Step 1: 写失败测试（记录形状黄金测试）**

`tests/test_review_records.py`：

```python
import json

import review_records as rr
from review_content import Snapshot
from review_queue import ReviewItem

ITEM = ReviewItem(
    source="卷A", rel_path="物理/初中/first/2024/卷A", group_order=19,
    flags=[{"kind": "incomplete_content", "reasons": ["subq_starts_at_2"],
            "md": "m", "pdf": None}],
)
SNAP = Snapshot(content="旧题干", options=[{"label": "A", "text": "甲"}],
                answer="甲", inline="题内素材")
SNAP_IMG = Snapshot(content="旧题干\n\n![](images/a.jpg)", options=[],
                    answer="", images=["images/a.jpg"])


def test_stem_only_edit_keeps_answer_options_and_material():
    """只改题干：答案/选项/题内素材必须原样带过去，不能被写库清空。"""
    rec = rr.build_record(ITEM, 19, rr.Patch(content="新题干"), SNAP)
    assert rec["content"] == "新题干"
    assert rec["answer"] == "甲"
    assert rec["options"] == [{"label": "A", "text": "甲"}]
    assert rec["material_target"] == "inline"
    assert rec["material_text"] == "题内素材"
    assert rec["status"] == "ready" and rec["applied"] is False
    assert "answer_only" not in rec and "content_only" not in rec


def test_unchanged_images_are_kept():
    """旧图在题干里、新题干没提到它：补回末尾（不静默丢图）。"""
    rec = rr.build_record(ITEM, 19, rr.Patch(content="新题干"), SNAP_IMG)
    assert rec["content"].startswith("新题干")
    assert "![](images/a.jpg)" in rec["content"]


def test_cleared_images_are_dropped():
    rec = rr.build_record(ITEM, 19, rr.Patch(content="新题干", images_cleared=True), SNAP_IMG)
    assert "images/a.jpg" not in rec["content"]


def test_replaced_images_drop_old_refs():
    """换图：旧引用要被摘掉，不能和新图并存。"""
    p = rr.Patch(content="新题干\n\n![](images/b.jpg)",
                 images=["images/b.jpg"], images_replaced=True)
    rec = rr.build_record(ITEM, 19, p, SNAP_IMG)
    assert "images/a.jpg" not in rec["content"]
    assert "images/b.jpg" in rec["content"]


def test_article_plus_inline_uses_both_target():
    p = rr.Patch(material=rr.MaterialPatch(article="文章正文", inline="题内素材"))
    rec = rr.build_record(ITEM, 19, p, SNAP)
    assert rec["material_target"] == "both"
    assert rec["material_text"] == "文章正文"
    assert rec["material_inline_text"] == "题内素材"


def test_url_claim_none_means_explicit_no_material():
    rec = rr.build_record(ITEM, 19, rr.Patch(material=rr.MaterialPatch(url_claim=None)), SNAP)
    assert "material_url" in rec and rec["material_url"] is None


def test_restore_original_is_content_only():
    rec = rr.build_record(ITEM, 19, rr.Patch(restore_original="修复前原文"), SNAP)
    assert rec["content"] == "修复前原文" and rec["content_only"] is True
    assert "options" not in rec and "answer" not in rec


def test_answer_only_keeps_stem_and_never_carries_material():
    rec = rr.build_record(ITEM, 19, rr.Patch(answer="乙", answer_only=True), SNAP)
    assert rec["answer"] == "乙" and rec["content"] == "旧题干"
    assert rec["material_text"] is None and rec["answer_only"] is True
```

- [ ] **Step 2: 运行确认失败**

```bash
cd tools/data-refinery && python3 -m pytest tests/test_review_records.py -q
```

Expected: `ModuleNotFoundError`.

- [ ] **Step 3: 实现**

```python
import getpass
import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from review_content import _KEEP_URL, _apply_image_placeholders, _image_refs

KEEP_URL = _KEEP_URL


@dataclass
class MaterialPatch:
    article: str | None = None
    inline: str | None = None
    url_claim: object = KEEP_URL
    share_with: list[int] | None = None


@dataclass
class Patch:
    content: str | None = None
    options: list[dict] | None = None
    answer: str | None = None
    material: MaterialPatch | None = None
    images: list[str] | None = None
    cleared: bool = False
    images_cleared: bool = False
    images_replaced: bool = False
    restore_original: str | None = None
    answer_only: bool = False


def has_changes(patch: Patch) -> bool:
    if patch.restore_original is not None or patch.answer_only:
        return True
    if any(v is not None for v in (patch.content, patch.options, patch.answer, patch.material, patch.images)):
        return True
    return patch.cleared


def strip_images(text: str, refs: list[str]) -> str:
    """替换图片时把旧引用从正文里摘掉（不是追加，是换掉）。"""
    out = text
    for ref in refs:
        out = re.sub(r"!\[[^\]]*\]\(" + re.escape(ref) + r"\)\n?", "", out)
    return re.sub(r"\n{3,}", "\n\n", out).strip()


def preserve_images(text: str, refs: list[str]) -> str:
    missing = [r for r in refs if r not in text]
    if not missing:
        return text
    return text.rstrip() + "\n\n" + "\n".join(f"![]({r})" for r in missing)


def build_record(item, target_no: int, patch: Patch, snap, *,
                 dominant_type: str | None = None, kind: str | None = None) -> dict:
    head = {
        "source": item.source,
        "rel_path": item.rel_path,
        "group_order": target_no,
        "sub_no": item.sub_no,
        "issue_kind": kind or (item.flags[0].get("kind") if item.flags else "manual_override"),
        "issue_reasons": (item.flags[0].get("reasons") if item.flags else []) or [],
        "pdf": item.flags[0].get("pdf") if item.flags else None,
        "md": item.flags[0].get("md") if item.flags else None,
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "operator": getpass.getuser(),
        "status": "ready",
        "applied": False,
    }
    if patch.restore_original is not None:
        return {**head, "content": patch.restore_original.strip(), "content_only": True,
                "issue_kind": "repair_truncated"}
    if patch.answer_only:
        return {**head, "content": snap.content, "options": snap.options,
                "material_text": None, "answer": patch.answer or "",
                "answer_only": True, "expected_type": None}

    rec = {
        **head,
        "content": (patch.content if patch.content is not None else snap.content).strip(),
        "options": patch.options if patch.options is not None else snap.options,
        "answer": patch.answer if patch.answer is not None else snap.answer,
        "expected_type": dominant_type,
    }
    m = patch.material
    if m and (m.article is not None or m.inline is not None):
        # 动了任一段就把两段都带上：没动的那段用快照原值，避免写库把它清空。
        article = m.article if m.article is not None else (
            snap.article if snap.article_url else None)
        inline = m.inline if m.inline is not None else (snap.inline or None)
        if article is not None and inline is not None:
            rec.update(material_target="both", material_text=article,
                       material_inline_text=inline)
        elif article is not None:
            rec.update(material_target="article", material_text=article,
                       material_scope="article")
        else:
            rec.update(material_target="inline", material_text=inline,
                       material_scope="inline")
    elif m and m.url_claim is not KEEP_URL:
        rec["material_url"] = m.url_claim
    elif (snap.inline or "").strip() and item.subject != "chinese":
        # 非语文只改题干时，apply 会用 rec.get("material_text") 覆盖该列；
        # 不带原值就会把题前科技阅读清空（2026-11-26 修）。
        rec.update(material_target="inline", material_text=snap.inline)
    if m and m.share_with:
        rec["material_share_with"] = m.share_with
    refs = patch.images if patch.images is not None else snap.images
    if patch.images_replaced and patch.images is not None:
        rec["content"] = strip_images(rec["content"], snap.images)
        if rec.get("options"):
            rec["options"] = [{**o, "text": strip_images(o.get("text") or "", snap.images)}
                              for o in rec["options"]]
    if refs and not patch.images_cleared:
        rec["content"] = _apply_image_placeholders(rec["content"], refs)
    if not patch.cleared and not patch.images_cleared:
        rec["content"] = preserve_images(rec["content"], refs)
    return rec
```

`item.subject` 由 `ReviewItem` 派生：在 `review_queue.ReviewItem` 上加 `@property def subject(self): return subject_code_for_path(Path(self.rel_path), default="") or "generic"`（Task 3 里补，测试里用 `ITEM.subject == "physics"`）。

搬入 `_copy_new_images`、`_keep_prior_images`、`_save_records`（原样）。

- [ ] **Step 4: 运行测试**

```bash
cd tools/data-refinery && python3 -m pytest tests/test_review_records.py -q && python3 -m pytest -q
```

Expected: 7 passed；全量通过。

- [ ] **Step 5: 提交**

```bash
git add tools/data-refinery/src/review_records.py tools/data-refinery/src/review_queue.py \
        tools/data-refinery/src/manual_fix.py tools/data-refinery/tests/test_review_records.py
git commit -m "refactor(refinery): 抽出校对记录生成与图片保留规则"
```

---

## Task 5: 槽位原语 `read_slot` / `read_images`

**Files:**
- Modify: `tools/data-refinery/src/review_editor.py`
- Test: `tools/data-refinery/tests/test_review_editor.py`

**Interfaces:**
- Produces:
  - `read_slot(c, *, label: str, hint: str, current: str | None, paper_md_dir: Path, allow_clear=True, allow_line_edit=True, allow_peek=True, reject_wrapped=False, first_line: str | None = None) -> tuple[str, str]`（`first_line`：调用方已读好的首行，用于「序号/n」这类前置判定）
    返回 `("value", text)` / `("unchanged", "")` / `("clear", "")`
  - `from_any(paper_md_dir: Path) -> str | None`（`:f`：回车=剪贴板、给路径=文件/图片）
  - `read_images(c, current: list[str], paper_md_dir: Path) -> tuple[str, list[Path]]`
    返回 `("append", paths)` / `("replace", paths)` / `("clear", [])` / `("unchanged", [])`

- [ ] **Step 1: 写失败测试**

`tests/test_review_editor.py`：

```python
import io
from pathlib import Path

import review_editor as ed


def _c():
    return ed.console()


def test_read_slot_enter_is_unchanged(monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO("\n"))
    assert ed.read_slot(_c(), label="答案", hint="回车=不改", current="旧答案",
                        paper_md_dir=Path(".")) == ("unchanged", "")


def test_read_slot_paste_is_value(monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO("新答案\nEOF\n"))
    assert ed.read_slot(_c(), label="答案", hint="", current="旧答案",
                        paper_md_dir=Path(".")) == ("value", "新答案")


def test_read_slot_colon_commands_are_not_content(monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO(":c\n"))
    assert ed.read_slot(_c(), label="答案", hint="", current="旧答案",
                        paper_md_dir=Path(".")) == ("clear", "")


def test_read_slot_single_letter_is_content(monkeypatch):
    """答案就是 e 时不能当命令（命令带冒号）。"""
    monkeypatch.setattr("sys.stdin", io.StringIO("e\nEOF\n"))
    assert ed.read_slot(_c(), label="答案", hint="", current="", paper_md_dir=Path(".")) == ("value", "e")


def test_read_slot_echo_is_rejected_then_accepts_next(monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO("请提供真题 s) 跳过\nEOF\n真答案\nEOF\n"))
    assert ed.read_slot(_c(), label="答案", hint="", current="", paper_md_dir=Path(".")) == ("value", "真答案")


def test_read_slot_clear_refused_when_not_allowed(monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO(":c\n正文\nEOF\n"))
    assert ed.read_slot(_c(), label="共享材料", hint="", current="旧",
                        paper_md_dir=Path("."), allow_clear=False) == ("value", "正文")


def test_read_images_enter_is_unchanged(monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO("\n"))
    assert ed.read_images(_c(), ["images/a.jpg"], Path(".")) == ("unchanged", [])


def test_read_images_clear(monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO("3\n"))
    assert ed.read_images(_c(), ["images/a.jpg"], Path(".")) == ("clear", [])
```

- [ ] **Step 2: 运行确认失败**

```bash
cd tools/data-refinery && python3 -m pytest tests/test_review_editor.py -q
```

Expected: `AttributeError: read_slot`.

- [ ] **Step 3: 实现**

```python
def from_any(paper_md_dir: Path) -> str | None:
    """`:f`：回车读剪贴板，给路径则读文件（图片走 MinerU）。"""
    c = console()
    c.prompt("路径（回车=读剪贴板；s 取消）› ")
    raw = _read_line()
    if raw is None:
        return None
    s = raw.strip()
    if s.lower() == "s":
        return None
    if not s:
        return _from_clipboard(paper_md_dir)
    return _from_file(paper_md_dir, s)


def read_slot(c, *, label: str, hint: str, current: str | None,
              paper_md_dir: Path, allow_clear: bool = True,
              allow_line_edit: bool = True, allow_peek: bool = True,
              reject_wrapped: bool = False,
              first_line: str | None = None) -> tuple[str, str]:
    """槽位统一输入：回车=不改；其余都是内容；命令一律 `:` 前缀。"""
    pre = first_line
    while True:
        if pre is None:
            tail = f"（{hint}）" if hint else ""
            c.prompt(f"{label} › {tail}")
            raw = _read_line()
        else:
            raw, pre = pre, None
        if raw is None:
            return "unchanged", ""
        s = raw.strip()
        if not s:
            return "unchanged", ""
        low = s.lower()
        if low in (":e", ":edit"):
            edited, _path = _file_edit(current or "", label)
            if edited is None:
                c.warn("没有改内容")
                continue
            return "value", edited
        if low in (":l", ":line"):
            if not allow_line_edit:
                c.warn("这个槽不支持逐行改，请用 :e")
                continue
            edited = _line_edit(current or "")
            if edited is None:
                c.warn("已放弃编辑")
                continue
            return "value", edited
        if low in (":c", ":clear"):
            if not allow_clear:
                c.warn("这个槽不能清空（清共享文章请用 R 全换）")
                continue
            return "clear", ""
        if low in (":p", ":peek"):
            if not allow_peek:
                c.warn("这个槽没有可重看的内容")
                continue
            if current:
                c.block(f"当前{label}", current, max_lines=len(current.splitlines()) + 1)
            else:
                c.info("当前为空")
            continue
        if low in (":f", ":from"):
            text = from_any(paper_md_dir)
            if text is None:
                continue
            c.block(f"{label}已收到", text, max_lines=6)
            return "value", text
        text = _read_block(raw)
        if not text.strip():
            c.warn("没有收到内容，请重新输入")
            continue
        if looks_like_ui_echo(text):
            c.err("这段像是界面文字（含「请提供真题」等），已拒收")
            continue
        if reject_wrapped and looks_like_wrapped_copy(text):
            c.err("这段带终端折行痕迹（行首 │ / 标签被换行截断），请用 :e 改或重新复制")
            continue
        return "value", text


def read_images(c, current: list[str], paper_md_dir: Path) -> tuple[str, list[Path]]:
    """图槽：1 追加 / 2 替换全部 / 3 清空 / 回车=不改。"""
    while True:
        c.prompt("图怎么改？ 1 追加 · 2 替换全部 · 3 清空 · 回车=不改 › ")
        raw = _read_line()
        if raw is None:
            return "unchanged", []
        ans = raw.strip()
        if not ans:
            return "unchanged", []
        if ans == "3":
            return "clear", []
        if ans in ("1", "2"):
            paths = _collect_image_paths(c)
            if not paths:
                c.warn("没有收到图片")
                continue
            return ("append" if ans == "1" else "replace"), paths
        c.warn("请输入 1/2/3 或回车")


def _collect_image_paths(c) -> list[Path]:
    """路径（逗号分隔，顺序即图1/图2）或回车读剪贴板（可连续），eof 结束。"""
    with tempfile.TemporaryDirectory(prefix="refinery-clip-") as tmp:
        out: list[Path] = []
        seen: set[str] = set()
        while True:
            c.prompt("图片路径（多个用逗号，顺序即图1/图2；回车=读剪贴板，可连续；eof 结束）› ")
            raw = _read_line()
            if raw is None:
                break
            s = raw.strip()
            if s.lower() in ("eof", "end", "结束"):
                break
            if not s:
                clip = _clipboard_to_path(Path(tmp))
                if clip is None:
                    break
                digest = hashlib.sha1(clip.read_bytes()).hexdigest()
                if digest in seen:
                    c.warn("和已收到的图内容相同，已跳过（重新裁剪后再回车，或 eof 结束）")
                    continue
                seen.add(digest)
                out.append(clip)
                _clear_clipboard()
                c.ok(f"已收到第 {len(out)} 张")
                continue
            for part in re.split(r"[,，]", s):
                token = part.strip().strip("'\"")
                if not token:
                    continue
                p = Path(token).expanduser()
                if not p.is_absolute():
                    p = Path.cwd() / p
                if not p.exists():
                    c.warn(f"找不到文件：{p}")
                    continue
                if p.suffix.lower() not in IMAGE_SUFFIXES:
                    c.warn(f"不是图片：{p.name}")
                    continue
                out.append(p)
        return out
```

- [ ] **Step 4: 运行测试**

```bash
cd tools/data-refinery && python3 -m pytest tests/test_review_editor.py -q
```

Expected: 8 passed。

- [ ] **Step 5: 提交**

```bash
git add tools/data-refinery/src/review_editor.py tools/data-refinery/tests/test_review_editor.py
git commit -m "feat(refinery): 槽位统一编辑器（回车=不改、冒号命令、图片连续收）"
```

---

## Task 6: 卡片 + 主菜单 + 五个槽位接入（切换点）

**Files:**
- Modify: `tools/data-refinery/src/manual_fix.py`
- Create: `tools/data-refinery/tests/test_review_flow.py`

**Interfaces:**
- Consumes: `review_queue.ReviewItem/pending_items/mark_issue/recorded_flags`、`review_content.snapshot/Snapshot/split_*`、`review_records.Patch/build_record/has_changes/_save_records`、`review_editor.read_slot/read_images`
- Produces:
  - `@dataclass RunResult(records: list[dict], outcome: str)`，`outcome ∈ {"recorded","ok","skipped"}`
  - `run_item(item: ReviewItem, index: int, total: int) -> RunResult`
  - `run_card(item, target_no: int, snap: Snapshot, note: str, index: int, total: int) -> Patch | None`
  - `render_card(state: State, note: str, index: int, total: int) -> None`
  - `ask_menu(c, *, is_repair: bool, has_original: bool, has_content: bool) -> tuple[str, str | None]`
  - `_issue_for(item, target_no) -> dict`、`snapshot_for(item, target_no) -> Snapshot`
  - `edit_content_slot(state) -> None` / `edit_article_slot` / `edit_inline_slot` / `edit_answer_slot` / `edit_image_slot`
  - `State` dataclass：`item, target_no, snap, patch, dirty: set[str]`，属性 `paper_dir`（`Path(flags[0]["md"]).parent`）

**行为变更（本任务落地）**：删除 `_ask_verdict`、`_ask_edit_mode`、`_ask_image_mode`、`_ask_slots`、`_ask_one`、`_confirm_text`、`_collect_content` 及其菜单分支、答案富输入菜单、`_targets`、`_ask_material_url`（并进槽位 2）、`_collect_optional_block`/`_ask_choice`/`_ask_yes`（并进槽位编辑器）；`_ask` 改为 `run_item`。保留 `_from_clipboard`（`:f` 在用）、`_ask_share_with`、`_parse_question_numbers`。对应旧测试在本任务删除，由 `test_review_flow.py` 覆盖。

`manual_fix.py` 顶部补齐新依赖：

```python
from review_queue import (ISSUES_FILE, KIND_TEXT, _read_jsonl, group_items,
                          mark_issue, pending_items, recorded_flags)
from review_content import (Snapshot, editable_body, snapshot,
                            split_material_and_options, _paper_question_rows,
                            _published_material_urls, _IMG_PLACEHOLDER_RE)
from review_records import MaterialPatch, Patch, _copy_new_images, _save_records, \
    build_record, has_changes
from review_editor import read_images, read_slot
```

> `_ask_share_with` 留在 `manual_fix.py`（它要读 `ISSUES_FILE` 与同卷题干），不要从 content 导入；上面那行只写 `from review_editor import read_images, read_slot`，`_ask_share_with` 用本模块内的旧函数。

- [ ] **Step 1: 写失败测试（黄金会话）**

`tests/test_review_flow.py`：

```python
import io
import json
from pathlib import Path

import manual_fix


def _prep_question(tmp_path, monkeypatch, *, kind="incomplete_content",
                   answer="甲", material="题内素材", images=(), options=None):
    rel = "物理/初中/first/2024/卷A"
    md_dir = tmp_path / "md" / rel
    md_dir.mkdir(parents=True, exist_ok=True)
    (md_dir / "卷A.md").write_text("", encoding="utf-8")
    ex = tmp_path / "extracted" / rel / "物理-卷A-试卷.jsonl"
    ex.parent.mkdir(parents=True, exist_ok=True)
    content = "19. 旧题干" + "".join(f"\n\n![](images/{n})" for n in images)
    ex.write_text(json.dumps({
        "group_order": 19, "content": content, "answer": answer,
        "options": options or [{"label": "A", "text": "甲"}],
        "material_text": material,
    }, ensure_ascii=False) + "\n", encoding="utf-8")
    issues = tmp_path / "issues.jsonl"
    issues.write_text(json.dumps({
        "source": "物理-卷A-试卷", "rel_path": rel, "group_order": 19,
        "kind": kind, "reasons": ["subq_starts_at_2"], "status": "pending",
        "md": str(md_dir / "卷A.md"), "content_sig": "sig-1",
    }, ensure_ascii=False) + "\n", encoding="utf-8")
    import manual_fix as mf
    import review_queue
    monkeypatch.setattr(review_queue, "ISSUES_FILE", issues)
    monkeypatch.setattr(mf, "ISSUES_FILE", issues, raising=False)
    return issues


def _recs(tmp_path):
    p = tmp_path / "fixes" / "物理-卷A-试卷.jsonl"
    return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines()]


def test_k_closes_all_flags_without_record(tmp_path, monkeypatch):
    _prep_question(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.stdin", io.StringIO("k\n"))
    res = manual_fix.review_pending(fixes_dir=tmp_path / "fixes")
    assert res["confirmed_ok"] == 1 and res["fixed"] == 0
    assert not (tmp_path / "fixes" / "物理-卷A-试卷.jsonl").exists()


def test_enter_without_change_keeps_pending(tmp_path, monkeypatch):
    _prep_question(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.stdin", io.StringIO("\n"))
    res = manual_fix.review_pending(fixes_dir=tmp_path / "fixes")
    assert res["skipped"] == 1 and res["confirmed_ok"] == 0


def test_paste_stem_then_enter_records_and_keeps_other_fields(tmp_path, monkeypatch):
    """改题干只按 4 次键：菜单 1 / 粘贴 / EOF / 回车。"""
    _prep_question(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.stdin", io.StringIO("1\n新题干\nEOF\n\n"))
    res = manual_fix.review_pending(fixes_dir=tmp_path / "fixes")
    rec = _recs(tmp_path)[0]
    assert rec["content"].startswith("新题干")
    assert rec["answer"] == "甲"            # 未改的答案不许被清空
    assert rec["material_text"] == "题内素材"
    assert res["fixed"] == 1


def test_answer_slot_enter_keeps_old_answer(tmp_path, monkeypatch):
    _prep_question(tmp_path, monkeypatch, kind="answer_missing")
    monkeypatch.setattr("sys.stdin", io.StringIO("\n"))
    res = manual_fix.review_pending(fixes_dir=tmp_path / "fixes")
    assert res["skipped"] == 1
    assert not (tmp_path / "fixes" / "物理-卷A-试卷.jsonl").exists()


def test_inline_material_slot_records_inline(tmp_path, monkeypatch):
    _prep_question(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.stdin", io.StringIO("3\n新材料\nEOF\n\n"))
    manual_fix.review_pending(fixes_dir=tmp_path / "fixes")
    rec = _recs(tmp_path)[0]
    assert rec["material_target"] == "inline"
    assert rec["material_text"] == "新材料"
    assert rec["content"] == "19. 旧题干"          # 题干不动


def test_new_shared_article_asks_share_numbers(tmp_path, monkeypatch):
    _prep_question(tmp_path, monkeypatch, material="")
    monkeypatch.setattr("sys.stdin", io.StringIO("2\n文章正文\nEOF\n\n\n"))
    manual_fix.review_pending(fixes_dir=tmp_path / "fixes")
    rec = _recs(tmp_path)[0]
    assert rec["material_target"] == "article"
    assert rec["material_text"] == "文章正文"
    assert rec["material_share_with"] == [19]
```

- [ ] **Step 2: 运行确认失败**

```bash
cd tools/data-refinery && python3 -m pytest tests/test_review_flow.py -q
```

Expected: 第一条就失败（`k` 不被识别 / 旧流程要求先答 verdict）。

- [ ] **Step 3: 实现卡片、菜单、槽位**

`State` 与主循环：

```python
@dataclass
class State:
    item: ReviewItem
    target_no: int
    snap: Snapshot
    patch: Patch = field(default_factory=Patch)
    dirty: set[str] = field(default_factory=set)

    @property
    def paper_dir(self) -> Path:
        md = next((f.get("md") for f in self.item.flags if f.get("md")), None)
        return Path(md).parent


@dataclass
class RunResult:
    records: list[dict] = field(default_factory=list)
    outcome: str = "skipped"       # recorded / ok / skipped


def _issue_for(item: ReviewItem, target_no: int) -> dict:
    flag = item.flags[0] if item.flags else {}
    return {
        "source": item.source, "rel_path": item.rel_path, "group_order": target_no,
        "sub_no": item.sub_no, "kind": flag.get("kind"),
        "reasons": flag.get("reasons") or [], "md": flag.get("md"),
        "pdf": flag.get("pdf"), "content_sig": flag.get("content_sig"),
        "suspect_group_order": flag.get("suspect_group_order"),
    }


def snapshot_for(item: ReviewItem, target_no: int) -> Snapshot:
    return snapshot(_issue_for(item, target_no))


def run_item(item: ReviewItem, index: int, total: int) -> RunResult:
    out = RunResult()
    for target_no, note in item.targets():
        snap = snapshot_for(item, target_no)
        patch = run_card(item, target_no, snap, note, index, total)
        if patch is None:
            continue
        if not has_changes(patch):
            console().info(f"第 {target_no} 题未改动（仍待处理）")
            continue
        out.records.append(build_record(item, target_no, patch, snap,
                                        dominant_type=item.dominant_type))
    if out.records:
        out.outcome = "recorded"
    elif not any(i.group_order == item.group_order and i.source == item.source
                 for i in group_items(_read_jsonl(ISSUES_FILE))):
        out.outcome = "ok"        # 该题 flag 已被 close_as_ok 全部关掉
    return out


def run_card(item, target_no, snap, note, index, total) -> Patch | None:
    state = State(item=item, target_no=target_no, snap=snap)
    if item.only_answer_missing() and snap.content:
        edit_answer_slot(state)              # 只缺答案：跳过菜单，一次输入
        return state.patch
    while True:
        render_card(state, note, index, total)
        action, arg = ask_menu(console(), is_repair=item.is_repair,
                               has_original=bool(snap.repair_original),
                               has_content=bool(snap.content))
        if action == "slot":
            {"1": edit_content_slot, "2": edit_article_slot, "3": edit_inline_slot,
             "4": edit_answer_slot, "5": edit_image_slot}[arg](state)
        elif action == "edit_all":
            edit_whole_in_editor(state)
        elif action == "replace":
            replace_all(state)
        elif action == "restore":
            state.patch.restore_original = snap.repair_original
            return state.patch
        elif action == "ok":
            close_as_ok(item, target_no)
            return None
        elif action == "skip":
            return None
        elif action == "enter":
            return state.patch
        elif action == "quit":
            raise SystemExit(0)
```

菜单：

```python
def ask_menu(c, *, is_repair: bool, has_original: bool, has_content: bool):
    c.write("")
    c.write("  要改哪段？ " + c.paint(
        "1 题干/选项 · 2 共享材料 · 3 题内材料 · 4 答案 · 5 图", "dim"))
    tail = []
    if has_content:
        tail.append("E 编辑器改整题")
    tail += ["R 全换（清空材料/图）", "k 确认无问题"]
    if is_repair and has_original:
        tail.append("u 用修复前原文")
    c.write("           " + c.paint(" · ".join(tail), "dim"))
    c.write("           " + c.paint("回车=结束本题 · s 稍后再说 · q 退出", "dim"))
    while True:
        c.prompt("› ")
        raw = _read_line()
        if raw is None:
            return "skip", None
        ans = raw.strip()
        if not ans:
            return "enter", None
        if ans in ("1", "2", "3", "4", "5"):
            return "slot", ans
        low = ans.lower()
        if low == "e":
            return "edit_all", None
        if low == "r":
            return "replace", None
        if low in ("k", "ok"):
            return "ok", None
        if low in ("s", "skip"):
            return "skip", None
        if low in ("q", "quit"):
            return "quit", None
        if low == "u" and is_repair and has_original:
            return "restore", None
        c.warn("请按 1–5 / E / R / k / u / 回车 / s / q")
```

槽位 1（题干/选项）：

```python
def edit_content_slot(state: State) -> None:
    c = console()
    kind, text = read_slot(
        c, label="题干/选项", current=state.snap.content, paper_md_dir=state.paper_dir,
        hint="回车=不改；粘贴=整段替换，EOF 结束；:e 编辑器 · :l 逐行 · :f 文件/剪贴板 · :c 清空")
    if kind == "unchanged":
        return
    if kind == "clear":
        state.patch.content, state.patch.options = "", []
        state.dirty.add("content")
        return
    material, stem, options = split_material_and_options(get_strategy(state.item.subject), text)
    if not stem.strip():
        c.err("题干被解析成空串（选项字母写在内容下面的排版会造成这样），本条未记录")
        c.info("请按「题干单独一行 → A. 内容 → B. 内容 …」重粘；没有配图的选项只写文字即可")
        return
    if not options and state.snap.options:
        c.warn(f"这段没有选项，保留原题 {len(state.snap.options)} 个选项")
        options = state.snap.options
    state.patch.content, state.patch.options = stem.strip(), options
    if material:
        c.info(f"这段里的材料已归到题内材料（{len(material)} 字）")
        state.patch.material = MaterialPatch(inline=material)
    if _IMG_PLACEHOLDER_RE.search(stem):
        c.warn("正文里还有 [图N]，按 5 配图（不配会原样保留）")
    state.dirty.add("content")
```

槽位 2（共享材料，含序号认领 / n）：

```python
def edit_article_slot(state: State) -> None:
    c = console()
    issue = _issue_for(state.item, state.target_no)
    cands = [] if state.snap.article_url else _published_material_urls(issue)
    if cands:
        c.write("  同卷已有文章：")
        for i, (no, url) in enumerate(cands[:8], 1):
            c.write(f"    {i}) 第{no}题  {url}")
    hint = "回车=不改；粘贴=替换全文；:e · :f · :p 看全文"
    if cands:
        hint += " · 序号=沿用 · n=本题无材料"
    c.prompt(f"共享材料 › （{hint}）")
    first = _read_line()
    if first is None or not first.strip():
        return
    s = first.strip()
    if cands and s.isdigit() and 1 <= int(s) <= len(cands):
        state.patch.material = MaterialPatch(url_claim=cands[int(s) - 1][1])
        state.dirty.add("material")
        return
    if cands and s.lower() == "n":
        state.patch.material = MaterialPatch(url_claim=None)
        state.dirty.add("material")
        return
    kind, text = read_slot(c, label="共享材料", current=state.snap.article,
                           paper_md_dir=state.paper_dir, allow_clear=False,
                           allow_line_edit=False, first_line=first)
    if kind != "value":
        return
    share = None
    if not state.snap.article_url and not state.snap.article:
        share = _ask_share_with(issue)      # 新建文章时问共用题号
    state.patch.material = MaterialPatch(article=text, share_with=share)
    state.dirty.add("material")
```

槽位 3（题内材料）：

```python
def edit_inline_slot(state: State) -> None:
    c = console()
    kind, text = read_slot(
        c, label="题内材料", current=state.snap.inline, paper_md_dir=state.paper_dir,
        hint="回车=不改；粘贴=替换；:e · :l · :f · :c 删除", reject_wrapped=True)
    if kind == "unchanged":
        return
    m = state.patch.material or MaterialPatch()
    m.inline = None if kind == "clear" else text
    state.patch.material = m
    state.dirty.add("material")
```

槽位 4（答案）：

```python
def edit_answer_slot(state: State) -> None:
    c = console()
    kind, text = read_slot(
        c, label="答案", current=state.snap.answer, paper_md_dir=state.paper_dir,
        hint="回车=不改；粘贴答案；:e · :f · :c 置空")
    if kind == "unchanged":
        return
    state.patch.answer = "" if kind == "clear" else text
    if state.item.only_answer_missing() and state.target_no == state.item.group_order:
        state.patch.answer_only = True
    state.dirty.add("answer")
```

槽位 5（图）：

```python
def edit_image_slot(state: State) -> None:
    c = console()
    mode, paths = read_images(c, state.snap.images, state.paper_dir)
    if mode == "unchanged":
        return
    if mode == "clear":
        state.patch.images, state.patch.images_cleared = [], True
        state.dirty.add("images")
        return
    refs = _copy_new_images(paths, state.paper_dir)
    if not refs:
        c.warn("拷图失败，未改动")
        return
    state.patch.images = (state.snap.images + refs) if mode == "append" else refs
    state.patch.images_replaced = (mode == "replace")
    state.dirty.add("images")
    c.ok(f"已收 {len(refs)} 张图：" + "、".join(r.split("/")[-1] for r in refs))
```

卡片渲染 `render_card`：把现有 `_print_context` 的「卷/原卷/文本/依据 + 完整题干」原样搬进 `render_card`，并在其后加四行块（`_block_or_none(label, text, max_lines)` 小助手）：

```python
def render_card(state: State, note: str, index: int, total: int) -> None:
    c = console()
    item, no = state.item, state.target_no
    kinds = " + ".join(KIND_TEXT.get(k, k) for k in sorted(item.kinds))
    c.step(index, total, f"第 {no} 题", note)
    c.write(f"{c.paint('· ' + kinds, 'cyan')}")
    _print_issue_header(item, no)              # 卷/原卷/文本/依据（原 _print_context 前半段）
    if any(f.get("suspect_group_order") for f in item.flags):
        c.warn("关联题的正文里可能混进了本题：先核对关联题，再回到本题")
    content = (state.patch.content if state.patch.content is not None else state.snap.content)
    _block_or_none("题干（可整段拷贝）", content, 200)
    opts = state.patch.options if state.patch.options is not None else state.snap.options
    if opts:
        c.write("  选项  " + " ".join(f"{o.get('label')}. {o.get('text')}" for o in opts))
    _block_or_none("共享材料（可整段拷贝）", state.snap.article, 8)
    _block_or_none("题内材料", state.snap.inline, 8)
    c.write(f"  {c.paint('答案', 'dim')}      "
            f"{(state.patch.answer if state.patch.answer is not None else state.snap.answer) or '空'}")
    c.write(f"  {c.paint('图片', 'dim')}      "
            f"{len(state.snap.images)} 张" + ("：" + "、".join(state.snap.images) if state.snap.images else ""))
    if state.snap.repair_original:
        _block_or_none("自动修复前（完整，可整段拷贝）", state.snap.repair_original, 200)
```

`_print_issue_header` / `_block_or_none` 就是把 `_print_context` 拆成两半：

```python
def _print_issue_header(item: ReviewItem, no: int) -> None:
    c = console()
    flag = item.flags[0] if item.flags else {}
    c.kv([("卷", item.source),
          ("原卷", flag.get("pdf") or "（未找到对应 PDF）"),
          ("文本", flag.get("md") or "—")], label_width=4)
    reasons: list[str] = []
    for f in item.flags:
        for r in humanize_reasons(f.get("reasons") or []):
            if r not in reasons:
                reasons.append(r)
    from cli_ui import wrap_items
    for i, line in enumerate(wrap_items(reasons, c.width - 8)):
        c.write(f"  {c.paint('依据' if i == 0 else '    ', 'dim')}  {line}")


def _block_or_none(label: str, text: str | None, max_lines: int) -> None:
    c = console()
    if not (text or "").strip():
        c.write(f"  {c.paint(label, 'dim')}  无")
        return
    c.block(label, text, max_lines=max_lines, wrap=False)
```

**本任务必须同时改的旧测试**：删除 `tests/test_manual_fix.py` 中这些用例（它们测的函数被删）：
`test_content_issue_confirm_*`、`test_ask_image_mode_*`、`test_answer_e_*`、`test_answer_r_*`、`test_answer_s_*`、`test_confirm_*`、`test_blank_lines_after_paste_*`、`test_edit_command_typed_*`、`test_ask_guides_two_questions_*`、`test_ask_skipping_first_*`、`test_menu_*`、`test_empty_line_*`、`test_collect_content_*`、`test_enter_at_material_scope_*`、`test_collect_optional_block_*`、`test_content_issue_material_only_*`（材料编辑改走槽位 2/3）、`test_missing_chinese_question_*`（改走槽位 2）。

保留并改造的：`test_uppercase_E_is_still_a_valid_answer`（改断言：槽位 4 输入 `e` 得到答案 `e`）、`test_ask_one_splits_material_then_options`（改成直接测 `split_material_and_options`）、`test_restore_swallowed_option_label_*`、`test_line_edit_*`、`test_file_edit_*`、`test_same_number_overwrite_*`、`test_discard_fixes_*`。

新行为测试全部写进 `tests/test_review_flow.py`（含槽位 2/3 的 `inline` / `article` / 共用题号三条；认领同卷 URL 的用例放 Task 8 之后，需要先造 `published/` 目录）。

- [ ] **Step 4: 跑测试**

```bash
cd tools/data-refinery && python3 -m pytest tests/test_review_flow.py -q && python3 -m pytest -q
```

Expected: 新 4 条通过；全量通过（删掉的旧用例不计）。

- [ ] **Step 5: 提交**

```bash
git add tools/data-refinery/src/manual_fix.py tools/data-refinery/src/review_queue.py \
        tools/data-refinery/tests/test_review_flow.py tools/data-refinery/tests/test_manual_fix.py
git commit -m "feat(refinery): 人工校对改为一题一卡一菜单，五个槽位统一输入"
```

---

## Task 7: `R` 全换 / `E` 编辑器 / `u` 砍短 / 答案直达 + 删除旧菜单

**Files:**
- Modify: `tools/data-refinery/src/manual_fix.py`
- Modify: `tools/data-refinery/tests/test_review_flow.py`

**Interfaces:**
- Produces: `replace_all(state)`、`edit_whole_in_editor(state)`、`close_as_ok(item, target_no)`、`edit_answer_slot(state)`（答案直达复用）
- Consumes: `editable_body(snap)`、`_file_edit`、`_from_image`、`_from_file`

- [ ] **Step 1: 写失败测试**

追加到 `tests/test_review_flow.py`：

```python
def test_repair_truncated_u_restores_original(tmp_path, monkeypatch):
    _prep_question(tmp_path, monkeypatch, kind="repair_truncated")
    lab = tmp_path / "output" / "labeling_issues.jsonl"
    lab.parent.mkdir(parents=True, exist_ok=True)
    lab.write_text(json.dumps({
        "source": "物理-卷A-试卷", "group_order": 19,
        "original_content": "修复前完整原文",
        "regenerated": {"content": "修复后短"},
    }, ensure_ascii=False) + "\n", encoding="utf-8")
    import review_content
    monkeypatch.setattr(review_content, "ROOT", tmp_path)
    monkeypatch.setattr("sys.stdin", io.StringIO("u\n"))
    manual_fix.review_pending(fixes_dir=tmp_path / "fixes")
    rec = _recs(tmp_path)[0]
    assert rec["content"] == "修复前完整原文" and rec["content_only"] is True


def test_replace_all_clears_material_and_images(tmp_path, monkeypatch):
    _prep_question(tmp_path, monkeypatch, images=("images/a.jpg",))
    monkeypatch.setattr("sys.stdin", io.StringIO("R\n1\n新题面\nEOF\n\n"))
    manual_fix.review_pending(fixes_dir=tmp_path / "fixes")
    rec = _recs(tmp_path)[0]
    assert rec["content"] == "新题面"
    assert "images/a.jpg" not in rec["content"]


def test_answer_only_item_takes_one_input(tmp_path, monkeypatch):
    _prep_question(tmp_path, monkeypatch, kind="answer_missing")
    monkeypatch.setattr("sys.stdin", io.StringIO("乙\nEOF\n"))
    manual_fix.review_pending(fixes_dir=tmp_path / "fixes")
    rec = _recs(tmp_path)[0]
    assert rec["answer_only"] is True and rec["answer"] == "乙"
```

- [ ] **Step 2: 运行确认失败**

```bash
cd tools/data-refinery && python3 -m pytest tests/test_review_flow.py -q
```

Expected: `u`/`R`/答案直达至少一条失败。

- [ ] **Step 3: 实现**

```python
def close_as_ok(item: ReviewItem, target_no: int) -> None:
    c = console()
    note = "人工确认无问题，未改动"
    if item.kinds == {"junk_question"}:
        note = "人工确认：这行不是题目，忽略"
    elif "missing" in item.kinds and not (snapshot_for(item, target_no).content):
        note = "人工确认：卷面本来没有这道题"
    sig = next((f.get("content_sig") for f in item.flags if f.get("content_sig")), None)
    mark_issue(item.source, target_no, "resolved", note=note,
               verdict="no_change", content_sig=sig)
    c.ok(f"第 {target_no} 题已标记「确认无问题」，题库未改动")


def replace_all(state: State) -> None:
    c = console()
    c.prompt("全换（题干/选项/材料/图清空，答案保留）› "
             "1 粘贴文本 · 2 图片识别（MinerU）· 3 文件 · 回车=取消 ")
    raw = _read_line()
    if raw is None:
        return
    ans = raw.strip()
    if not ans:
        return
    if ans == "2":
        text = _from_image(state.paper_dir)
    elif ans == "3":
        text = _from_file(state.paper_dir)
    else:
        kind, text = read_slot(c, label="新题面", hint="粘贴全文，EOF 结束",
                               current="", paper_md_dir=state.paper_dir)
        if kind != "value":
            return
    if not text or not text.strip():
        c.warn("没有收到内容")
        return
    material, stem, options = split_material_and_options(get_strategy(state.item.subject), text)
    if not stem.strip():
        c.err("题干被解析成空串，未改动")
        return
    state.patch = Patch(content=stem.strip(), options=options or [],
                        material=MaterialPatch(article=None, inline=material) if material else None,
                        cleared=True, images_cleared=True)
    state.dirty.update({"content", "material", "images"})


def edit_whole_in_editor(state: State) -> None:
    body = editable_body(state.snap)
    edited, _path = _file_edit(body, f"第{state.target_no}题题干")
    if edited is None or not edited.strip():
        console().warn("没有收到修改")
        return
    material, stem, options = split_material_and_options(get_strategy(state.item.subject), edited)
    if not stem.strip():
        console().err("题干被解析成空串，未改动")
        return
    state.patch.content, state.patch.options = stem.strip(), options
    state.patch.images_cleared = True        # 编辑器里删掉的图不自动补回（现状）
    if material:
        state.patch.material = MaterialPatch(article=None, inline=material)
    state.dirty.add("content")
```

删除的旧函数：`_ask_repair_truncated`、`_ask_repair_verdict`、`_ask_answer_only`、`_collect_answer`、`_print_context`（被 `render_card` 取代）、`_targets`（改由 `ReviewItem.targets()`）、`_edit_material_file`（`:e` 统一走 `_file_edit`，原文档不动）及其测试。

- [ ] **Step 4: 跑测试**

```bash
cd tools/data-refinery && python3 -m pytest tests/test_review_flow.py -q && python3 -m pytest -q
```

Expected: 新增 3 条通过；全量通过。

- [ ] **Step 5: 提交**

```bash
git add tools/data-refinery/src/manual_fix.py tools/data-refinery/tests/test_review_flow.py
git commit -m "feat(refinery): 校对支持全换/编辑器整题改/砍短用原文，删除旧菜单"
```

---

## Task 8: 队列编排（按题、summary、主动重录、recorded 关全部 flag）

**Files:**
- Modify: `tools/data-refinery/src/manual_fix.py`
- Modify: `tools/data-refinery/tests/test_review_flow.py`、`tests/test_manual_fix.py`

**Interfaces:**
- Produces:
  - `review_pending(sources=None, file=None, *, list_only=False, fixes_dir=None, limit=None) -> dict`
    返回键：`{"pending": int（题数）, "fixed": int（题数）, "skipped": int, "confirmed_ok": int, "unapplied": int}`
  - `review_by_numbers(subject, file, fixes_dir=None, *, sources=None) -> int`
  - `_print_table(items)`（按题）、`_print_remaining(sources, file)`

- [ ] **Step 1: 写失败测试**

```python
def test_review_pending_counts_questions_not_flags(tmp_path, monkeypatch):
    rel = "物理/初中/first/2024/卷A"
    md = tmp_path / "md" / rel
    md.mkdir(parents=True, exist_ok=True)
    (md / "卷A.md").write_text("", encoding="utf-8")
    issues = tmp_path / "issues.jsonl"
    issues.write_text("".join(json.dumps({
        "source": "物理-卷A-试卷", "rel_path": rel, "group_order": 19, "kind": k,
        "reasons": [], "status": "pending", "md": str(md / "卷A.md"),
    }, ensure_ascii=False) + "\n" for k in ("incomplete_content", "answer_missing")),
        encoding="utf-8")
    import review_queue
    monkeypatch.setattr(review_queue, "ISSUES_FILE", issues)
    monkeypatch.setattr(manual_fix, "ISSUES_FILE", issues, raising=False)
    monkeypatch.setattr("sys.stdin", io.StringIO("k\n"))
    res = manual_fix.review_pending(fixes_dir=tmp_path / "fixes")
    assert res["pending"] == 1 and res["confirmed_ok"] == 1


def test_record_closes_every_flag_of_question(tmp_path, monkeypatch):
    """题干录完后，同题的 answer_missing 也必须是 recorded，不能留 pending。"""
    _prep_question(tmp_path, monkeypatch)
    issues = tmp_path / "issues.jsonl"
    rows = [json.loads(l) for l in issues.read_text(encoding="utf-8").splitlines()]
    extra = dict(rows[0], kind="answer_missing", reasons=["answer_empty"])
    issues.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows + [extra]),
                      encoding="utf-8")
    monkeypatch.setattr("sys.stdin", io.StringIO("1\n新题干\nEOF\n\n"))
    manual_fix.review_pending(fixes_dir=tmp_path / "fixes")
    saved = [json.loads(l) for l in issues.read_text(encoding="utf-8").splitlines()]
    assert {r["status"] for r in saved if r["group_order"] == 19} == {"recorded"}
```

- [ ] **Step 2: 实现**

```python
def _review_loop(items: list[ReviewItem], out_dir: Path, result: dict, c) -> None:
    for n, item in enumerate(items, 1):
        live = {(i.source, i.group_order) for i in group_items(_read_jsonl(ISSUES_FILE))}
        if (item.source, item.group_order) not in live:
            continue                    # 前面的粘贴已顺带补好该题
        res = run_item(item, n, len(items))
        if res.outcome == "recorded":
            out_file = _save_records(item.source, res.records, out_dir)
            ts = res.records[0]["created_at"]
            for no in {r["group_order"] for r in res.records}:   # 一次粘贴可能含多题
                recorded_flags(ReviewItem(source=item.source, rel_path=item.rel_path,
                                          group_order=no, sub_no=item.sub_no), str(out_file), ts)
            result["fixed"] += len(res.records)
        elif res.outcome == "ok":
            result["confirmed_ok"] += 1
        else:
            result["skipped"] += 1
```

其余：

- `review_pending`：`items = pending_items(sources, file)`；`result["pending"] = len(items)`；`_print_table(items)`；`_review_loop(...)`。
- `unapplied = len(pending_records())`：`from apply_fixes import pending_records` 放在函数内 import（避免循环）。
- summary 追加 `("另有待写库", f"{unapplied} 条")`（0 时不显示）。
- `review_by_numbers`：

```python
item = ReviewItem(source=paper["source"], rel_path=str(paper["rel_path"]),
                  group_order=no, manual=True,
                  flags=[{"kind": "manual_override",
                          "reasons": ["用户主动指定重录"],
                          "md": str(md_path),
                          "pdf": str(paper["pdf"]) if paper["pdf"] else None}])
res = run_item(item, i, len(nums))
if res.outcome == "recorded":
    _save_records(paper["source"], res.records, out_dir)
    total += len(res.records)
```

- `_print_table`：每行一题，问题列 `" + ".join(KIND_TEXT.get(k, k) for k in sorted(item.kinds))`；依据行合并该题所有 flag 的理由（去重）。

- [ ] **Step 3: 跑测试**

```bash
cd tools/data-refinery && python3 -m pytest -q
```

Expected: 全绿。

- [ ] **Step 4: 提交**

```bash
git add tools/data-refinery/src/manual_fix.py tools/data-refinery/tests/
git commit -m "feat(refinery): 校对队列按题计数与收口，主动重录走同一卡片"
```

---

## Task 9: 文档同步 + 全量回归 + 人工冒烟

**Files:**
- Modify: `tools/data-refinery/README.md`（§人工补题段落）
- Modify: `docs/data-refinery-使用手册.md`（「补题时图片怎么处理」「只补答案」两节 → 「人工校对：一题一卡」）
- Modify: `docs/constraints/数据管线.md`（第 15 条与第 92 条：交互口径改新菜单，约束本身保留）
- Modify: `docs/ai-core-changelog.md`（追加一条，历史不改）

- [ ] **Step 1: 改文档**

README  §人工补题：把「三种图片策略 / 菜单 5 多图 / 答案菜单」改为：

```
一题一卡：卡片给全现状（题干/选项/共享材料/题内材料/答案/图），菜单选段：
1 题干/选项 · 2 共享材料 · 3 题内材料 · 4 答案 · 5 图 · E 编辑器改整题 ·
R 全换 · k 确认无问题 · 回车=结束 · s 稍后 · q 退出。
槽内：回车=不改，其余都是内容（EOF 结束），命令 `:e` 编辑器 / `:l` 逐行 /
`:f` 文件·剪贴板 / `:c` 清空 / `:p` 看全文。
```

使用手册：把两节合成「### 人工校对（一题一卡）」+ 一张表（槽位 → 行为）+ 三条不写库出口（k/回车/s）。

constraints：第 15 条保留判据与收口规则，把「两段门 / 三段式槽位 / 图片四策略」改成新菜单的等价描述；第 92 条改「槽内 `:f` 取剪贴板」，并保留 AppleScript 顺序与「别另写 OCR 入口」的原话。

changelog：追加

```
**人工校对改为一题一卡（2026-11-26）**：队列按 (source, group_order) 聚合；
卡片给全现状，一张菜单选段；槽位统一「回车=不改 / 冒号命令」；图片策略
keep/replace/ocr/text 并入「默认保图 / 5 图 / R 全换」；k 可按题关全部 flag
（含 missing 跳号误报）。记录契约与 apply_fixes 不变。
```

- [ ] **Step 2: 全量回归**

```bash
cd tools/data-refinery && python3 -m pytest -q
```

Expected: 全绿（含 `test_apply_fixes*` / `test_import_cli*` / `test_publish_cli*`）。

- [ ] **Step 3: 人工冒烟（非 CI，记录结果）**

```bash
cd tools/data-refinery
python3 src/fix_question_cli.py --list                     # 只看清单，不读 stdin
python3 src/fix_question_cli.py --source 西城               # 处理两三题后按 q 退出
```

检查：卡片一屏能给全内容；`k` 关掉该题全部 flag；改题干只按 4 次键；`5 图` 回车连续收剪贴板；`R` 全换后答案仍在；`q` 后剩余列表正确。

- [ ] **Step 4: 提交**

```bash
git add tools/data-refinery/README.md docs/data-refinery-使用手册.md \
        docs/constraints/数据管线.md docs/ai-core-changelog.md
git commit -m "docs(refinery): 人工校对交互改为「一题一卡」"
```

---

## Self-Review

- 设计 §3.1–§3.9 的每一屏都有对应任务：卡片/菜单/槽位（T6）、图槽（T6）、R/E/u（T7）、只缺答案（T6/T7）、队列收尾（T8）。
- §4 的 23 项能力：1–17 在 T6/T7 落地并有测试；18–20 在 T7/T8；21 在 T7（`close_as_ok` 的 missing 文案）；22 在 T8；23 不动。
- §5 的记录契约：T4 的 7 条黄金测试覆盖 content/options/answer/material 三态/answer_only/content_only/保图。
- §5.3 的 R6（recorded 关全部 flag）：T3 的 `recorded_flags` + T8 的接线。
- 未覆盖但已在 §8 明确不做：批量文件校对、Web UI、按 sub_no 收口、改 apply 契约。
