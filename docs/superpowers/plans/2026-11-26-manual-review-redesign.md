# 人工校对（补题）交互重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `tools/data-refinery` 的人工校对从“按 flag 排队 + 多套菜单”改为“按题目身份一卡 + 一张主菜单 + 五个槽位共用编辑器”，同时保证清空、组合修改、多题粘贴、小问收口和写库语义正确。

**Architecture:** 先抽取输入/内容/队列/记录四个基础模块，再给记录 Patch 建立显式三态和组合语义，最后重写 `manual_fix.py` 的卡片编排。`apply_fixes.py` 只新增向后兼容的 `clear_answer` 分支、迁移 import，并让状态回写携带 `sub_no`。

**Tech Stack:** Python 3.10、pytest、`cli_ui.Console`、Local MySQL 既有 schema；无新依赖、无 migration。

**Spec:** `docs/superpowers/specs/2026-11-26-manual-review-redesign-design.md`

## Global Constraints

- `recognition_scan.py`、publish/回灌规则、旧 `manual_fixes/*.jsonl` 行为不动。
- `apply_fixes.py` 只允许新增 `clear_answer=True` 分支、更新搬迁后的 import、把
  `sub_no` 传给状态回写；不重写其它业务路径。
- 题目身份是 `(source, group_order, sub_no)`；同一身份的多个 kind 一次关闭，不跨 `sub_no`。
- 草稿必须区分 `UNSET`（未改）、`None` / clear（显式清空）、普通值（写入）。
- 禁止用 `state.patch.material = MaterialPatch(...)` 覆盖整个材料 Patch；只能调用字段级 setter。
- `k`、回车、`s` 三个出口必须使用不同结果类型；`s` 立即结束当前 `ReviewItem`。
- 槽内只解释已知 `:` 命令；不再支持裸 `@路径`，统一使用 `:f`。
- 卡片“可整段拷贝”区域不得折行、截断、简化图片引用或添加复制边框。
- 非 TTY 不读取 stdin，打印唯一入口命令。
- 每个 Task 结束运行 `cd tools/data-refinery && python3 -m pytest -q`，全绿后单独提交。
- 真实基线测试数在实施开始时用 `python3 -m pytest --collect-only -q | tail -n 1` 记录；计划中的定向测试数不是全量测试数。

---

## File Structure

| 文件 | 职责 | 状态 |
|---|---|---|
| `tools/data-refinery/src/review_editor.py` | 终端原语、槽位输入、图片输入、剪贴板/MinerU、原样渲染 | Create |
| `tools/data-refinery/src/review_content.py` | Snapshot、extracted/published/article 读取、材料路由 | Create |
| `tools/data-refinery/src/review_queue.py` | issues 读写、题目身份聚合、mark_issue、统计 | Create |
| `tools/data-refinery/src/review_records.py` | MaterialPatch/Patch、字段合并、记录生成、落盘、保图/清图、discard | Create |
| `tools/data-refinery/src/manual_fix.py` | 卡片、菜单、五个槽位、`R/E/u/k`、入口编排 | Modify |
| `tools/data-refinery/src/apply_fixes.py` | import 迁移 + `clear_answer` 分支 + 小问状态回写 | Modify |
| `tools/data-refinery/tests/test_review_editor.py` | 槽位/图片/原样渲染测试 | Create |
| `tools/data-refinery/tests/test_review_content.py` | Snapshot 与材料测试 | Create |
| `tools/data-refinery/tests/test_review_queue.py` | 聚合并发/小问测试 | Create |
| `tools/data-refinery/tests/test_review_records.py` | Patch 组合、清空、记录形状测试 | Create |
| `tools/data-refinery/tests/test_review_flow.py` | 黄金会话、多题粘贴、TTY 测试 | Create |
| `tools/data-refinery/tests/test_apply_fixes.py` | `clear_answer` 兼容测试 | Modify |
| `tools/data-refinery/tests/test_manual_fix.py` | 保留入口夹具；删除旧菜单流程用例 | Modify |
| `tools/data-refinery/README.md`、`docs/data-refinery-使用手册.md`、`docs/data-refinery-管线总结与后续.md`、`docs/constraints/数据管线.md`、`docs/ai-core-changelog.md` | 文档同步 | Modify |

---

## Task 1: 抽出 `review_editor.py` 并建立槽位输入

**Files:**
- Create: `tools/data-refinery/src/review_editor.py`
- Modify: `tools/data-refinery/src/manual_fix.py`
- Modify: `tools/data-refinery/src/apply_fixes.py`
- Create: `tools/data-refinery/tests/test_review_editor.py`
- Modify: `tools/data-refinery/tests/test_manual_fix.py`

**Interfaces:**

- Produces:
  - `ROOT: Path`
  - `console() -> Console`
  - `_read_line(prompt="") -> str | None`
  - `_read_block(first_chunk="") -> str`
  - `_line_edit(text) -> str | None`
  - `_file_edit(text, label="题干", *, path=None) -> tuple[str | None, Path]`
  - `_from_file(paper_md_dir, raw=None) -> str | None`
  - `_from_image(paper_md_dir, path=None) -> str | None`
  - `_from_clipboard(paper_md_dir, *, silent=False) -> str | None`
  - `from_any(paper_md_dir) -> str | None`
  - `read_slot(...) -> tuple[str, str]`
  - `read_images(...) -> tuple[str, list[Path]]`
  - `render_copyable(c, label, text, *, max_lines=None) -> None`

- [ ] **Step 1: 记录基线测试数**

Run:

```bash
cd tools/data-refinery
python3 -m pytest --collect-only -q | tail -n 1
```

把实际数字写入本任务提交说明。不要沿用旧计划中的“166 左右”。

- [ ] **Step 2: 写槽位与原样渲染失败测试**

`tests/test_review_editor.py`：

```python
import io
from pathlib import Path

import review_editor as ed
from cli_ui import Console


def _c():
    return Console(color=False, width=60)


def test_read_slot_enter_is_unchanged(monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO("\n"))
    assert ed.read_slot(
        _c(), label="答案", hint="", current="旧答案", paper_md_dir=Path(".")
    ) == ("unchanged", "")


def test_read_slot_single_letters_are_content(monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO("e\nEOF\n"))
    assert ed.read_slot(
        _c(), label="答案", hint="", current="", paper_md_dir=Path(".")
    ) == ("value", "e")


def test_read_slot_at_path_is_content(monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO("@foo\nEOF\n"))
    assert ed.read_slot(
        _c(), label="答案", hint="", current="", paper_md_dir=Path(".")
    ) == ("value", "@foo")


def test_read_slot_clear(monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO(":c\n"))
    assert ed.read_slot(
        _c(), label="答案", hint="", current="旧答案", paper_md_dir=Path(".")
    ) == ("clear", "")


def test_render_copyable_keeps_full_line_and_image_ref():
    stream = io.StringIO()
    c = Console(stream=stream, color=False, width=20)
    text = "甲" * 40 + "\n![](images/a.jpg)"
    ed.render_copyable(c, "题干", text)
    shown = stream.getvalue()
    assert "甲" * 40 in shown
    assert "![](images/a.jpg)" in shown
    assert "│" not in shown
```

- [ ] **Step 3: 运行测试确认失败**

Run:

```bash
cd tools/data-refinery
python3 -m pytest tests/test_review_editor.py -q
```

Expected: `ModuleNotFoundError: No module named 'review_editor'`.

- [ ] **Step 4: 搬迁输入原语**

从 `manual_fix.py` 整段搬迁这些实现到 `review_editor.py`，函数体保持行为：

```text
_CONSOLE / console
IMAGE_SUFFIXES
_END_MARKERS
_read_line
_END_WORD_RE / _split_at_marker
_OPTION_LINE_HEAD_RE / _LOST_LABEL_HEAD_RE
_restore_swallowed_option_label
_read_block
_image_to_markdown
_STRONG_ECHO / _WEAK_ECHO / _ECHO_MARKERS / _ECHO_RULE_RE
looks_like_ui_echo
_ask_path
_from_image
_from_file
_CLIPBOARD_APPLESCRIPT / _probe_macos_clipboard / _probe_linux_clipboard
_clipboard_to_path / _from_clipboard
_EDIT_HINT / _line_edit
_find_editor / _file_edit
_clear_clipboard
looks_like_wrapped_copy
```

`manual_fix.py` 通过具名 import 保留旧名字：

```python
from review_editor import (  # noqa: F401
    IMAGE_SUFFIXES,
    ROOT,
    _ask_path,
    _clear_clipboard,
    _clipboard_to_path,
    _file_edit,
    _from_clipboard,
    _from_file,
    _from_image,
    _line_edit,
    _read_block,
    _read_line,
    _restore_swallowed_option_label,
    _split_at_marker,
    console,
    looks_like_ui_echo,
    looks_like_wrapped_copy,
)
```

实现槽位与渲染：

```python
def render_copyable(c, label: str, text: str, *, max_lines: int | None = None) -> None:
    lines = (text or "").splitlines()
    if not lines:
        c.write(f"  {c.paint(label, 'dim')}  无")
        return
    shown = lines if max_lines is None else lines[:max_lines]
    c.write(f"  {c.paint(label, 'dim')}")
    for line in shown:
        c.write(f"  {line}")
    if len(lines) > len(shown):
        c.write(f"  {c.paint(f'... 还有 {len(lines) - len(shown)} 行，输入 :p 看全文', 'dim')}")


def read_slot(
    c,
    *,
    label: str,
    hint: str,
    current: str | None,
    paper_md_dir: Path,
    allow_clear: bool = True,
    allow_line_edit: bool = True,
    allow_peek: bool = True,
    reject_wrapped: bool = False,
    first_line: str | None = None,
) -> tuple[str, str]:
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
                c.warn("这个槽不能单独清空；清全部材料请用 R")
                continue
            return "clear", ""
        if low in (":p", ":peek"):
            if not allow_peek:
                c.warn("这个槽没有可重看的内容")
                continue
            render_copyable(c, f"当前{label}", current or "", max_lines=None)
            continue
        if low in (":f", ":from"):
            text = from_any(paper_md_dir)
            if text is None:
                continue
            render_copyable(c, f"{label}已收到", text, max_lines=6)
            return "value", text
        text = _read_block(raw)
        if not text.strip():
            c.warn("没有收到内容，请重新输入")
            continue
        if looks_like_ui_echo(text):
            c.err("这段像是界面文字，已拒收")
            continue
        if reject_wrapped and looks_like_wrapped_copy(text):
            c.err("这段带终端折行痕迹，请清理后重新复制")
            continue
        return "value", text
```

`read_images()` 与 `_collect_image_paths()` 使用设计 §4.5 的规则；显式路径和剪贴板图都按文件内容 hash 去重。

- [ ] **Step 5: 修正 `apply_fixes.py` 的输入原语 import**

把：

```python
from manual_fix import looks_like_ui_echo, looks_like_wrapped_copy
```

改为：

```python
from review_editor import looks_like_ui_echo, looks_like_wrapped_copy
```

- [ ] **Step 6: 修正现有测试的 monkeypatch 目标**

Run:

```bash
cd tools/data-refinery
rg -n 'monkeypatch\.setattr\(manual_fix, "(_image_to_markdown|_clipboard_to_path|_clear_clipboard|_file_edit|looks_like_)' tests/test_manual_fix.py
```

这些函数已经由 `review_editor` 执行，测试必须 patch `review_editor` 中的实现。ROOT 仅在 `_file_edit` 使用处 patch `review_editor.ROOT`；仍由 `manual_fix` 使用的 ROOT 暂继续 patch 原模块。

- [ ] **Step 7: 运行测试**

Run:

```bash
cd tools/data-refinery
python3 -m pytest tests/test_review_editor.py -q
python3 -m pytest -q
```

Expected:

- 定向测试全 passed；
- 全量测试数与 Step 1 基线一致或只增加 Task 1 新测试。

- [ ] **Step 8: 提交**

```bash
git add tools/data-refinery/src/review_editor.py \
        tools/data-refinery/src/manual_fix.py \
        tools/data-refinery/src/apply_fixes.py \
        tools/data-refinery/tests/test_review_editor.py \
        tools/data-refinery/tests/test_manual_fix.py
git commit -m "refactor(refinery): 抽出人工校对输入原语"
```

---

## Task 2: 抽出 `review_content.py` 与 Snapshot

**Files:**
- Create: `tools/data-refinery/src/review_content.py`
- Create: `tools/data-refinery/tests/test_review_content.py`
- Modify: `tools/data-refinery/src/manual_fix.py`
- Modify: `tools/data-refinery/tests/test_manual_fix.py`

**Interfaces:**

- Consumes: `review_editor.ROOT`
- Produces:
  - `Snapshot(content, options, answer, article_url, article, inline, images, repair_original)`
  - `snapshot(issue, *, load_repair=False) -> Snapshot`
  - `_current_question(issue) -> dict | None`，匹配 `group_order + sub_no`
  - `_material_slots(issue) -> dict`
  - `_published_material_urls(issue) -> list[tuple[int, str]]`
  - `_paper_question_rows(issue) -> list[tuple[int, int, str]]`
  - `_copyable_question_text(issue) -> str`
  - `editable_body(snap) -> str`
  - `split_questions()`、`_one_question_body()`、`split_material_and_options()`

- [ ] **Step 1: 写失败测试**

`tests/test_review_content.py`：

```python
import json

import review_content


def _write(tmp_path, monkeypatch, issue, rows):
    ex = tmp_path / "output" / "extracted" / issue["rel_path"] / f"{issue['source']}.jsonl"
    ex.parent.mkdir(parents=True, exist_ok=True)
    ex.write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows),
        encoding="utf-8",
    )
    md = tmp_path / "output" / "md" / issue["rel_path"] / f"{issue['source']}.md"
    md.parent.mkdir(parents=True, exist_ok=True)
    md.write_text("", encoding="utf-8")
    monkeypatch.setattr(review_content, "ROOT", tmp_path)
    return {**issue, "md": str(md)}


def test_snapshot_matches_sub_no(tmp_path, monkeypatch):
    issue = _write(
        tmp_path,
        monkeypatch,
        {
            "source": "政治-卷A",
            "rel_path": "道法/初中/2026/卷A",
            "group_order": 26,
            "sub_no": 2,
        },
        [
            {"group_order": 26, "sub_no": 1, "content": "第一问", "answer": "甲"},
            {"group_order": 26, "sub_no": 2, "content": "第二问", "answer": "乙"},
        ],
    )
    snap = review_content.snapshot(issue)
    assert snap.content == "第二问"
    assert snap.answer == "乙"


def test_snapshot_images_include_inline_material(tmp_path, monkeypatch):
    issue = _write(
        tmp_path,
        monkeypatch,
        {
            "source": "物理-卷A",
            "rel_path": "物理/初中/2026/卷A",
            "group_order": 3,
            "sub_no": 0,
        },
        [{
            "group_order": 3,
            "sub_no": 0,
            "content": "题干",
            "material_text": "",
            "_post_material_text": "素材 ![](images/inline.jpg)",
        }],
    )
    snap = review_content.snapshot(issue)
    assert "images/inline.jpg" in snap.images
```

- [ ] **Step 2: 运行确认失败**

```bash
cd tools/data-refinery
python3 -m pytest tests/test_review_content.py -q
```

Expected: `ModuleNotFoundError`.

- [ ] **Step 3: 搬迁内容读取与材料路由**

从 `manual_fix.py` 搬迁：

```text
split_questions / _STEM_PREFIX_RE
_one_question_body
split_material_and_options
_subject_of
_copyable_question_text
_published_material_urls
_looks_like_article_text
_read_article_body
_article_slots
_question_article
_article_similarity
_material_slots
_paper_question_rows
_current_question
_IMG_REF_RE / _IMG_PLACEHOLDER_RE / _image_refs
_append_missing_images / _apply_image_placeholders
_repair_original
```

旧 `_KEEP_URL` 随 `_ask_material_url()` 一起删除；新槽位统一使用
`review_records.UNSET`，`review_content` 不依赖 `review_records`。

`_current_question()` 必须同时匹配 `group_order` 和 `sub_no`：

```python
def _current_question(issue: dict) -> dict | None:
    rel = issue.get("rel_path")
    source = issue.get("source")
    if not rel or not source:
        return None
    path = ROOT / "output" / "extracted" / rel / f"{source}.jsonl"
    if not path.exists():
        return None
    go = int(issue.get("group_order") or 0)
    sub = int(issue.get("sub_no") or 0)
    for row in _read_jsonl(path):
        if (int(row.get("group_order") or -1) == go
                and int(row.get("sub_no") or 0) == sub):
            return row
    return None
```

实现 Snapshot：

```python
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


def snapshot(issue: dict, *, load_repair: bool = False) -> Snapshot:
    row = _current_question(issue) or {}
    slots = _material_slots(issue)
    opts = row.get("options") or []
    images = _image_refs(
        row.get("content") or "",
        row.get("material_text") or "",
        row.get("_post_material_text") or "",
        *(str((o or {}).get("text") or "") for o in opts),
    )
    return Snapshot(
        content=(row.get("content") or "").strip(),
        options=opts,
        answer=(row.get("answer") or "").strip(),
        article_url=slots["article_url"],
        article=slots["article"],
        inline=slots["inline"],
        images=images,
        repair_original=_repair_original(issue) if load_repair else None,
    )
```

`editable_body(snap)` 只包含题干、选项、非外置 article、inline；外置 article 不进入编辑器。

- [ ] **Step 4: 迁移 ROOT monkeypatch**

在 `tests/test_manual_fix.py` 顶部定义：

```python
def _patch_content_roots(monkeypatch, root):
    import review_content, review_editor
    monkeypatch.setattr(review_editor, "ROOT", root)
    monkeypatch.setattr(review_content, "ROOT", root)
```

把仍由搬迁函数消费的 `manual_fix.ROOT` patch 改为对应模块 patch。不得 import 尚未创建的 `review_records`。

- [ ] **Step 5: 运行测试**

```bash
cd tools/data-refinery
python3 -m pytest tests/test_review_content.py -q
python3 -m pytest -q
```

Expected: 定向测试全 passed；全量全绿。

- [ ] **Step 6: 提交**

```bash
git add tools/data-refinery/src/review_content.py \
        tools/data-refinery/src/manual_fix.py \
        tools/data-refinery/tests/test_review_content.py \
        tools/data-refinery/tests/test_manual_fix.py
git commit -m "refactor(refinery): 抽出人工校对现状快照"
```

---

## Task 3: 抽出 `review_queue.py` 与题目身份聚合

**Files:**
- Create: `tools/data-refinery/src/review_queue.py`
- Create: `tools/data-refinery/tests/test_review_queue.py`
- Modify: `tools/data-refinery/src/manual_fix.py`
- Modify: `tools/data-refinery/src/review_content.py`
- Modify: `tools/data-refinery/src/apply_fixes.py`

**Interfaces:**

- Produces:
  - `ISSUES_FILE`、`FIXES_DIR`
  - `_read_jsonl()`、`_write_jsonl()`
  - `ReviewItem(source, rel_path, group_order, sub_no, flags, manual=False)`
  - `ReviewTarget(group_order, sub_no, note)`
  - `ReviewItem.targets() -> list[ReviewTarget]`
  - `group_items(issues) -> list[ReviewItem]`
  - `pending_items(sources=None, file=None) -> list[ReviewItem]`
  - `mark_issue(source, group_order, status, *, sub_no=None, statuses=None, note=None, fix_file=None, **extra)`
  - `recorded_flags(item, fix_file, recorded_at) -> int`
  - `humanize_reasons()`、`KIND_TEXT`、`CONTENT_KINDS`

- [ ] **Step 1: 写失败测试**

`tests/test_review_queue.py`：

```python
import json

import review_queue


def test_group_items_merges_kinds_and_splits_sub_no(tmp_path):
    rows = [
        {"source": "卷A", "group_order": 26, "sub_no": 0, "kind": "incomplete_content", "status": "pending"},
        {"source": "卷A", "group_order": 26, "sub_no": 0, "kind": "answer_missing", "status": "pending"},
        {"source": "卷A", "group_order": 26, "sub_no": 1, "kind": "incomplete_content", "status": "pending"},
        {"source": "卷A", "group_order": 26, "sub_no": 2, "kind": "answer_missing", "status": "pending"},
    ]
    items = review_queue.group_items(rows)
    assert [i.key for i in items] == [
        ("卷A", 26, 0),
        ("卷A", 26, 1),
        ("卷A", 26, 2),
    ]
    assert len(items[0].flags) == 2


def test_recorded_flags_does_not_close_other_sub_no(tmp_path, monkeypatch):
    p = tmp_path / "issues.jsonl"
    rows = [
        {"source": "卷A", "group_order": 26, "sub_no": 1, "kind": "incomplete_content", "status": "pending"},
        {"source": "卷A", "group_order": 26, "sub_no": 1, "kind": "answer_missing", "status": "pending"},
        {"source": "卷A", "group_order": 26, "sub_no": 2, "kind": "answer_missing", "status": "pending"},
    ]
    p.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    monkeypatch.setattr(review_queue, "ISSUES_FILE", p)
    item = next(i for i in review_queue.group_items(rows) if i.key == ("卷A", 26, 1))
    assert review_queue.recorded_flags(item, "fixes/卷A.jsonl", "t0") == 2
    saved = [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines()]
    assert [r["status"] for r in saved] == ["recorded", "recorded", "pending"]


def test_recorded_flags_does_not_downgrade_resolved(tmp_path, monkeypatch):
    p = tmp_path / "issues.jsonl"
    rows = [
        {"source": "卷A", "group_order": 19, "sub_no": 0, "kind": "incomplete_content", "status": "pending"},
        {"source": "卷A", "group_order": 19, "sub_no": 0, "kind": "answer_missing", "status": "resolved", "verdict": "no_change"},
    ]
    p.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    monkeypatch.setattr(review_queue, "ISSUES_FILE", p)
    item = review_queue.group_items(rows)[0]
    review_queue.recorded_flags(item, "fixes/卷A.jsonl", "t0")
    saved = [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines()]
    assert [r["status"] for r in saved] == ["recorded", "resolved"]
```

- [ ] **Step 2: 运行确认失败**

```bash
cd tools/data-refinery
python3 -m pytest tests/test_review_queue.py -q
```

Expected: `ModuleNotFoundError`.

- [ ] **Step 3: 实现题目身份与可选 sub_no 收口**

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

    @property
    def kinds(self) -> set[str]:
        return {str(f.get("kind") or "") for f in self.flags}

    @property
    def is_repair(self) -> bool:
        return "repair_truncated" in self.kinds

    @property
    def dominant_type(self) -> str | None:
        return next(
            (f.get("dominant_type") for f in self.flags if f.get("dominant_type")),
            None,
        )

    def note(self) -> str:
        if "type_mismatch" in self.kinds:
            return "题型与同大题不一致，请录入完整题目和选项"
        if "merged_content" in self.kinds:
            return "正文混入了别题内容，请只保留本题内容"
        if "options_incomplete" in self.kinds:
            return "选项不全，请录入完整题目和选项"
        if "answer_missing" in self.kinds:
            return "答案缺失，请补答案"
        if "missing" in self.kinds or "punct_stem" in self.kinds:
            return "题目缺失或被吞，请按原卷补录"
        return "请按原卷校对本题"

    def targets(self) -> list["ReviewTarget"]:
        seq: list[ReviewTarget] = []
        if "missing" in self.kinds:
            flag = next(
                (f for f in self.flags if f.get("suspect_group_order")),
                None,
            )
            if flag:
                suspect = int(flag["suspect_group_order"])
                suspect_sub = int(flag.get("suspect_sub_no") or 0)
                if (suspect, suspect_sub) != (self.group_order, self.sub_no):
                    seq.append(
                        ReviewTarget(
                            suspect,
                            suspect_sub,
                            "这一题的正文里混进了下一题，请只保留本题自己的内容",
                        )
                    )
        seq.append(
            ReviewTarget(
                self.group_order,
                self.sub_no,
                self.note(),
            )
        )
        return seq


@dataclass
class ReviewTarget:
    group_order: int
    sub_no: int = 0
    note: str = ""


def group_items(issues: list[dict]) -> list[ReviewItem]:
    order: dict[tuple[str, int, int], ReviewItem] = {}
    for rec in issues:
        if rec.get("status") != "pending":
            continue
        key = (
            rec["source"],
            int(rec.get("group_order") or 0),
            int(rec.get("sub_no") or 0),
        )
        item = order.get(key)
        if item is None:
            item = order[key] = ReviewItem(
                source=key[0],
                rel_path=rec.get("rel_path") or "",
                group_order=key[1],
                sub_no=key[2],
            )
        item.flags.append(rec)
    return sorted(order.values(), key=lambda i: i.key)
```

`mark_issue()` 增加可选过滤：

```python
def mark_issue(
    source,
    group_order,
    status,
    *,
    sub_no=None,
    statuses=None,
    note=None,
    fix_file=None,
    **extra,
):
    ...
    for rec in rows:
        if rec.get("source") != source or int(rec.get("group_order", -1)) != int(group_order):
            continue
        if sub_no is not None and int(rec.get("sub_no") or 0) != int(sub_no):
            continue
        if statuses is not None and rec.get("status") not in statuses:
            continue
        # 后续状态更新代码保持现有语义
```

`recorded_flags()` 必须传 `item.sub_no` 和 `statuses={"pending"}`。

- [ ] **Step 4: 迁移 import**

`review_content.py`：

```python
from review_queue import _read_jsonl
```

`apply_fixes.py`：

```python
from review_queue import mark_issue
```

所有函数内 `from manual_fix import _read_jsonl, _write_jsonl` 改为从 `review_queue` 导入。

`discard_fixes_for_source` 不在本任务实现或搬迁；Task 4 放到 `review_records`。

- [ ] **Step 5: 运行测试**

```bash
cd tools/data-refinery
python3 -m pytest tests/test_review_queue.py -q
python3 -m pytest -q
```

Expected: 定向测试全 passed；全量全绿。

- [ ] **Step 6: 提交**

```bash
git add tools/data-refinery/src/review_queue.py \
        tools/data-refinery/src/review_content.py \
        tools/data-refinery/src/manual_fix.py \
        tools/data-refinery/src/apply_fixes.py \
        tools/data-refinery/tests/test_review_queue.py
git commit -m "refactor(refinery): 按题目身份聚合人工校对队列"
```

---

## Task 4: `review_records.py`、三态 Patch 与记录生成

**Files:**
- Create: `tools/data-refinery/src/review_records.py`
- Create: `tools/data-refinery/tests/test_review_records.py`
- Modify: `tools/data-refinery/src/manual_fix.py`
- Modify: `tools/data-refinery/tests/test_manual_fix.py`

**Interfaces:**

- Consumes: `review_content.Snapshot`
- Produces:
  - `UNSET`
  - `MaterialPatch`
  - `Patch`
  - `ReviewDraft`
  - `has_changes(patch) -> bool`
  - `build_record(item, group_order, sub_no, patch, snap, *, dominant_type=None) -> dict`
  - `strip_all_images(text) -> str`
  - `preserve_images(text, refs) -> str`
  - `_copy_new_images(paths, paper_md_dir) -> list[str]`
  - `_keep_prior_images(old, new)`
  - `_save_records(source, records, out_dir) -> Path`
  - `discard_fixes_for_source(...)`

- [ ] **Step 1: 写失败测试**

`tests/test_review_records.py`：

```python
from review_content import Snapshot
from review_queue import ReviewItem
import review_records as rr


ITEM = ReviewItem(
    source="卷A",
    rel_path="物理/初中/2026/卷A",
    group_order=19,
    sub_no=0,
    flags=[{"kind": "incomplete_content", "reasons": [], "md": "m", "pdf": None}],
)


def test_two_material_slots_merge():
    snap = Snapshot(content="题干", article="旧文章", inline="旧素材")
    draft = rr.ReviewDraft(snap)
    draft.set_article("新文章")
    draft.set_inline("新素材")
    rec = rr.build_record(ITEM, 19, 0, draft.patch, snap)
    assert rec["material_target"] == "both"
    assert rec["material_text"] == "新文章"
    assert rec["material_inline_text"] == "新素材"


def test_clear_inline_with_article():
    snap = Snapshot(content="题干", article="文章", inline="旧素材")
    draft = rr.ReviewDraft(snap)
    draft.clear_inline()
    rec = rr.build_record(ITEM, 19, 0, draft.patch, snap)
    assert rec["material_target"] == "both"
    assert rec["material_text"] == "文章"
    assert rec["material_inline_text"] == ""


def test_clear_images_strips_all_record_fields():
    snap = Snapshot(
        content="题干 ![](images/a.jpg)",
        options=[{"label": "A", "text": "![](images/b.jpg)"}],
        inline="素材 ![](images/c.jpg)",
        images=["images/a.jpg", "images/b.jpg", "images/c.jpg"],
    )
    draft = rr.ReviewDraft(snap)
    draft.set_images([], "clear")
    rec = rr.build_record(ITEM, 19, 0, draft.patch, snap)
    assert "images/" not in rec["content"]
    assert "images/" not in rec["options"][0]["text"]
    for key in ("material_text", "material_inline_text"):
        if key in rec:
            assert "images/" not in rec[key]


def test_replace_images_uses_final_draft_sequence():
    snap = Snapshot(content="题干 ![](images/old.jpg)", images=["images/old.jpg"])
    draft = rr.ReviewDraft(snap)
    draft.set_images(["images/new.jpg"], "replace")
    rec = rr.build_record(ITEM, 19, 0, draft.patch, snap)
    assert "images/old.jpg" not in rec["content"]
    assert "images/new.jpg" in rec["content"]


def test_clear_answer_uses_explicit_record_field():
    snap = Snapshot(content="题干", answer="旧答案")
    draft = rr.ReviewDraft(snap)
    draft.clear_answer()
    rec = rr.build_record(ITEM, 19, 0, draft.patch, snap)
    assert rec["answer"] == ""
    assert rec["clear_answer"] is True


def test_untouched_material_chinese_omits_material_keys():
    """语文只改题干：不要带 material_* 键，apply 自己会保留 existing_text。"""
    item = ReviewItem(source="卷A", rel_path="语文/初中/2026/卷A", group_order=19)
    snap = Snapshot(content="题干", article="文章", inline="素材")
    rec = rr.build_record(item, 19, 0, rr.Patch(content="新题干"), snap)
    assert "material_target" not in rec
    assert "material_text" not in rec


def test_untouched_material_physics_carries_inline():
    """非语文必须带原 material_text，否则 apply 的 rec.get() 会把它写成 NULL。"""
    snap = Snapshot(content="题干", inline="题前阅读")
    rec = rr.build_record(ITEM, 19, 0, rr.Patch(content="新题干"), snap)
    assert rec["material_target"] == "inline"
    assert rec["material_text"] == "题前阅读"


def test_clear_images_keeps_shared_article_body():
    """清本题图不能删共享文章正文里的图。"""
    item = ReviewItem(source="卷A", rel_path="语文/初中/2026/卷A", group_order=19)
    snap = Snapshot(content="题干", article="旧文章", inline="素材")
    draft = rr.ReviewDraft(snap)
    draft.set_article("文章 ![](images/doc.jpg)")
    draft.set_images([], "clear")
    rec = rr.build_record(item, 19, 0, draft.patch, snap)
    assert rec["material_target"] == "both"
    assert "images/doc.jpg" in rec["material_text"]
    assert "images/" not in rec["content"]


def test_save_records_matches_sub_no(tmp_path):
    src = "卷A"
    p = tmp_path / f"{src}.jsonl"
    p.write_text(
        '{"source":"卷A","group_order":26,"sub_no":1,"content":"旧1"}\n'
        '{"source":"卷A","group_order":26,"sub_no":2,"content":"旧2"}\n',
        encoding="utf-8",
    )
    out = rr._save_records(
        src,
        [{"source": src, "group_order": 26, "sub_no": 2, "content": "新2"}],
        tmp_path,
    )
    rows = [__import__("json").loads(line) for line in out.read_text(encoding="utf-8").splitlines()]
    assert [(r["sub_no"], r["content"]) for r in rows] == [(1, "旧1"), (2, "新2")]
```

- [ ] **Step 2: 运行确认失败**

```bash
cd tools/data-refinery
python3 -m pytest tests/test_review_records.py -q
```

Expected: `ModuleNotFoundError`.

- [ ] **Step 3: 实现三态草稿**

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
    images_mode: str = "keep"
    content_only: bool = False


class ReviewDraft:
    def __init__(self, snap):
        self.snap = snap
        self.patch = Patch()

    def _regular_edit(self):
        self.patch.content_only = False

    def set_content(self, content, options):
        self._regular_edit()
        self.patch.content = content
        self.patch.options = options

    def set_answer(self, answer):
        self._regular_edit()
        self.patch.answer = answer
        self.patch.clear_answer = False

    def clear_answer(self):
        self._regular_edit()
        self.patch.answer = ""
        self.patch.clear_answer = True

    def set_article(self, article):
        self._regular_edit()
        self.patch.material.article = article
        self.patch.material.url_claim = UNSET

    def set_inline(self, inline):
        self._regular_edit()
        self.patch.material.inline = inline

    def clear_inline(self):
        self.set_inline(None)

    def claim_url(self, url):
        self._regular_edit()
        self.patch.material.url_claim = url

    def set_share_with(self, numbers):
        self._regular_edit()
        self.patch.material.share_with = list(numbers)

    def clear_materials(self):
        self._regular_edit()
        self.patch.material.article = None
        self.patch.material.inline = None
        self.patch.material.url_claim = None
        self.patch.material.share_with = None

    def set_images(self, refs, mode):
        self._regular_edit()
        self.patch.images = list(refs)
        self.patch.images_mode = mode

    def use_restore_original(self, content):
        self.patch.content = content
        self.patch.content_only = True


def has_changes(patch: Patch) -> bool:
    m = patch.material
    return any(
        (
            patch.content is not None,
            patch.options is not None,
            patch.answer is not None,
            patch.clear_answer,
            patch.content_only,
            patch.images_mode != "keep",
            m.article is not UNSET,
            m.inline is not UNSET,
            m.url_claim is not UNSET,
            m.share_with is not None,
        )
    )
```

- [ ] **Step 4: 生成记录**

`build_record()` 按此顺序：

1. 生成 head，`issue_kind` 取当前目标 flag；没有 flag 时用 `manual_override`。
2. 若 `patch.content_only` 且没有后续普通修改，返回 content_only 记录。
3. 若 `clear_answer`，记录 `answer=""`、`clear_answer=True`。
4. 否则 answer 取 patch 或 Snapshot。
5. material 按三态和设计 §5.3 生成。
6. 图片按设计 §5.4：
   - `clear`：对 content/options/material 字段执行 `strip_all_images()`；
   - `replace`：先清旧图，再 `_apply_image_placeholders()`；
   - `append`：直接应用最终序列；
   - `keep`：仅在没有任何显式清理时保留旧图；
   - `explicit`：不自动补旧图。

关键实现：

```python
def strip_all_images(text: str) -> str:
    out = re.sub(r"!\[[^\]]*\]\([^)]+\)\n?", "", text or "")
    return re.sub(r"\n{3,}", "\n\n", out).strip()


def _apply_images_to_record(rec: dict, patch: Patch, snap: Snapshot) -> None:
    mode = patch.images_mode
    if mode in ("clear", "replace"):
        rec["content"] = strip_all_images(rec.get("content") or "")
        rec["options"] = [
            {**o, "text": strip_all_images(o.get("text") or "")}
            for o in (rec.get("options") or [])
        ]
        # material_text 在 target=article/both 时承载共享文章正文，清它会删掉文章里的图。
        if rec.get("material_target") not in ("article", "both") and "material_text" in rec:
            rec["material_text"] = strip_all_images(rec.get("material_text") or "")
        if "material_inline_text" in rec:
            rec["material_inline_text"] = strip_all_images(rec.get("material_inline_text") or "")
    if mode in ("append", "replace") and patch.images:
        rec["content"] = _apply_image_placeholders(rec["content"], patch.images)
    elif mode == "keep":
        rec["content"] = preserve_images(rec["content"], snap.images)
```

材料字段实现必须直接在同一个 `MaterialPatch` 上读取三态，不新增第二份状态：

```python
def _material_record_values(patch: Patch, snap: Snapshot, subject: str) -> dict:
    m = patch.material
    out: dict = {}
    if m.url_claim is not UNSET:
        out["material_url"] = m.url_claim
    if m.article is UNSET and m.inline is UNSET:
        # 材料一段都没改：语文不带键（apply 用 existing_text 保留原值）；
        # 非语文必须带原 material_text，否则 apply 的 rec.get() 会把它写成 NULL。
        if subject != "chinese" and (snap.inline or "").strip():
            out.update(material_target="inline", material_text=snap.inline)
        return out
    article = snap.article if m.article is UNSET else m.article
    inline = snap.inline if m.inline is UNSET else m.inline
    if article is None and inline is None:
        if m.article is not UNSET and m.inline is not UNSET and m.url_claim is None:
            return out
        if m.inline is None:
            out.update(
                material_target="inline",
                material_text="",
                material_scope="inline",
            )
        return out
    if article is not None and m.inline is None:
        out.update(
            material_target="both",
            material_text=article,
            material_inline_text="",
        )
    elif article is not None and inline is not None:
        out.update(
            material_target="both",
            material_text=article,
            material_inline_text=inline,
        )
    elif article is not None:
        out.update(
            material_target="article",
            material_text=article,
            material_scope="article",
        )
    else:
        out.update(
            material_target="inline",
            material_text=inline,
            material_scope="inline",
        )
    return out


def build_record(
    item,
    group_order: int,
    sub_no: int,
    patch: Patch,
    snap: Snapshot,
    *,
    dominant_type: str | None = None,
) -> dict:
    flag = next(
        (
            f for f in item.flags
            if int(f.get("group_order") or item.group_order) == group_order
            and int(f.get("sub_no") or 0) == sub_no
        ),
        item.flags[0] if item.flags else {},
    )
    head = {
        "source": item.source,
        "rel_path": item.rel_path,
        "group_order": group_order,
        "sub_no": sub_no,
        "issue_kind": flag.get("kind") or "manual_override",
        "issue_reasons": flag.get("reasons") or [],
        "pdf": flag.get("pdf"),
        "md": flag.get("md"),
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "operator": getpass.getuser(),
        "status": "ready",
        "applied": False,
    }
    if patch.content_only:
        return {
            **head,
            "content": patch.content or snap.content,
            "content_only": True,
            "issue_kind": "repair_truncated",
        }
    if set(item.kinds) == {"answer_missing"} and patch.answer and not patch.clear_answer:
        return {
            **head,
            "content": snap.content,
            "options": snap.options,
            "answer": patch.answer,
            "material_text": None,
            "answer_only": True,
            "expected_type": None,
        }
    rec = {
        **head,
        "content": (patch.content if patch.content is not None else snap.content).strip(),
        "options": patch.options if patch.options is not None else snap.options,
        "answer": patch.answer if patch.answer is not None else snap.answer,
        "expected_type": dominant_type,
    }
    if patch.clear_answer:
        rec["answer"] = ""
        rec["clear_answer"] = True
    if patch.material.share_with is not None:
        rec["material_share_with"] = patch.material.share_with
    rec.update(_material_record_values(patch, snap, item.subject))
    _apply_images_to_record(rec, patch, snap)
    return rec
```

- [ ] **Step 5: 落盘与 discard**

`_save_records()` 返回输出路径，并按 `(group_order, sub_no)` 覆盖：

```python
def _save_records(source: str, records: list[dict], out_dir: Path) -> Path:
    out_file = out_dir / f"{source}.jsonl"
    rows = _read_jsonl(out_file)
    batch: dict[tuple[int, int], dict] = {}
    for record in records:
        key = (int(record["group_order"]), int(record.get("sub_no") or 0))
        _keep_prior_images(batch.get(key), record)
        rows = [
            r for r in rows
            if (int(r["group_order"]), int(r.get("sub_no") or 0)) != key
        ]
        rows.append(record)
        batch[key] = record
    _write_jsonl(out_file, rows)
    return out_file
```

`discard_fixes_for_source()` 从 `manual_fix.py` 搬到本模块，保持原逻辑；`manual_fix` re-export。

- [ ] **Step 6: 修正测试 ROOT helper**

现在 `review_records` 已存在，把测试 helper 扩展为：

```python
def _patch_all_roots(monkeypatch, root):
    import review_content, review_editor, review_records
    for mod in (review_editor, review_content, review_records):
        monkeypatch.setattr(mod, "ROOT", root)
```

清理 Task 2 留下的临时 `_read_jsonl` 副本，改用 `review_queue._read_jsonl`。

- [ ] **Step 7: 运行测试**

```bash
cd tools/data-refinery
python3 -m pytest tests/test_review_records.py -q
python3 -m pytest -q
```

Expected: 定向测试全 passed；全量全绿。

- [ ] **Step 8: 提交**

```bash
git add tools/data-refinery/src/review_records.py \
        tools/data-refinery/src/review_content.py \
        tools/data-refinery/src/manual_fix.py \
        tools/data-refinery/tests/test_review_records.py \
        tools/data-refinery/tests/test_manual_fix.py
git commit -m "refactor(refinery): 三态人工校对草稿与记录生成"
```

---

## Task 5: `apply_fixes` 支持清空答案与小问状态回写

**Files:**
- Modify: `tools/data-refinery/src/apply_fixes.py`
- Modify: `tools/data-refinery/tests/test_apply_fixes.py`

**Interfaces:**

- Consumes: `rec.clear_answer`
- Produces: 后向兼容的单字段答案清空分支；`mark_issue` 状态回写携带 `sub_no`

- [ ] **Step 1: 写失败测试**

追加到 `tests/test_apply_fixes.py`：

```python
def test_clear_answer_updates_db_to_empty_string(tmp_path, monkeypatch):
    rec = {
        **REC,
        "answer": "",
        "clear_answer": True,
    }
    cur = FakeCursor(paper=(17, 2), existing=5190)
    msg = apply_fixes.apply_record(
        cur, rec, True, assets_root=tmp_path / "assets", output_dir=tmp_path
    )
    assert "更新" in msg or "已清空" in msg
    assert any("answer=''" in sql for sql in cur.executed)


def test_clear_answer_with_content_edit_keeps_both(tmp_path):
    """同一张卡改题干 + 清答案：两条都必须写，不能因为清答案早退把题干丢了。"""
    rec = {**REC, "content": "新题干", "answer": "", "clear_answer": True}
    cur = FakeCursor(paper=(17, 2), existing=5192)
    apply_fixes.apply_record(
        cur, rec, True, assets_root=tmp_path / "assets", output_dir=tmp_path
    )
    assert any(sql.startswith("UPDATE questions SET content=") for sql in cur.executed)
    assert any("answer=''" in sql for sql in cur.executed)


def test_old_record_with_empty_answer_still_does_not_clear(tmp_path):
    rec = {**REC, "answer": ""}
    cur = FakeCursor(paper=(17, 2), existing=5191)
    apply_fixes.apply_record(
        cur, rec, True, assets_root=tmp_path / "assets", output_dir=tmp_path
    )
    assert not any(
        sql.startswith("UPDATE questions SET answer=%s")
        for sql in cur.executed
    )


def test_apply_status_echo_carries_sub_no(tmp_path, monkeypatch):
    import apply_fixes as impl

    (tmp_path / "A.jsonl").write_text(json.dumps({
        "source": "A",
        "rel_path": "道法/A",
        "group_order": 26,
        "sub_no": 2,
        "content": "第二问",
        "applied": False,
    }, ensure_ascii=False) + "\n", encoding="utf-8")

    notes: list[tuple] = []

    class Cur:
        def __enter__(self): return self
        def __exit__(self, *args): return False

    class Conn:
        def cursor(self): return Cur()
        def commit(self): pass
        def rollback(self): pass
        def close(self): pass

    monkeypatch.setattr(impl.pymysql, "connect", lambda *a, **kw: Conn())
    monkeypatch.setattr(
        impl,
        "mark_issue",
        lambda src, go, status, **kw: notes.append((src, go, status, kw)),
    )
    monkeypatch.setattr(
        impl,
        "apply_record",
        lambda cur, rec, apply, **kw: (rec.update(applied=True) or "更新：ok"),
    )
    assert impl.run(["--fixes-dir", str(tmp_path), "--apply"]) == 0
    assert notes[0][3]["sub_no"] == 2
```

如果 `FakeCursor` 未记录 SQL，先扩展夹具增加 `self.executed.append(sql)`。

- [ ] **Step 2: 运行确认失败**

```bash
cd tools/data-refinery
python3 -m pytest tests/test_apply_fixes.py -q
```

Expected: `test_clear_answer_updates_db_to_empty_string` failed.

- [ ] **Step 3: 实现（不要顶层早退）**

`answer=COALESCE(NULLIF(%s,''), answer)` 在主 UPDATE 里（`apply_fixes.py:1018`），空串清不掉；
但一张卡可以同时改题干和清答案，**顶层 `return` 会把题干/选项/材料一起吞掉**（记录仍会被
标 applied、flag 仍会被关）。所以只改两条已有路径：

1. 主 UPDATE 之后补一句：

```python
if rec.get("clear_answer"):
    cur.execute("UPDATE questions SET answer='' WHERE id=%s", (qid,))
```

2. `answer_only` 分支把空值拒绝改成：

```python
if not answer and not rec.get("clear_answer"):
    return "跳过：答案为空"
if rec.get("clear_answer"):
    answer = ""          # 该分支的 UPDATE answer=%s 传空串即清空
```

- [ ] **Step 4: 确认旧兼容**

把 `applied_keys` / `rejected_keys` 的元组扩展为
`(source, group_order, sub_no, fix_file, reason)`，三处 `mark_issue()` 都传
`sub_no=sub_no, statuses={"pending", "recorded"}`。

Run:

```bash
cd tools/data-refinery
python3 -m pytest tests/test_apply_fixes.py -q
python3 -m pytest -q
```

Expected:

- 新分支测试 passed；
- 既有 `answer_only`、空答案不覆盖、材料路由测试全部保持 passed。

- [ ] **Step 5: 提交**

```bash
git add tools/data-refinery/src/apply_fixes.py tools/data-refinery/tests/test_apply_fixes.py
git commit -m "feat(refinery): 人工校对支持清空答案与小问状态"
```

---

## Task 6: 卡片、主菜单与五个槽位

**Files:**
- Modify: `tools/data-refinery/src/manual_fix.py`
- Create: `tools/data-refinery/tests/test_review_flow.py`
- Modify: `tools/data-refinery/tests/test_manual_fix.py`

**Interfaces:**

- Consumes: `ReviewItem`、`Snapshot`、`ReviewDraft`、`build_record`、`read_slot`、`read_images`
- Produces:
  - `CardResult(action, patch=None, batch=[])`
  - `QuestionPart(group_order, sub_no, content, options, material)`
  - `_issue_for(item, group_order, sub_no) -> dict`
  - `snapshot_for(item, group_order, sub_no, *, load_repair=False) -> Snapshot`
  - `run_item(item, index, total) -> RunResult`
  - `run_card(item, target, snap, note, index, total) -> CardResult`
  - `render_card(state)`
  - `ask_menu(...)`
  - `_ask_share_with(issue) -> list[int]`
  - 五个槽位函数

- [ ] **Step 1: 写黄金会话测试**

`tests/test_review_flow.py`：

```python
import io
import json

import manual_fix


def _prep(tmp_path, monkeypatch, kind="incomplete_content", answer="甲"):
    rel = "物理/初中/2026/卷A"
    md = tmp_path / "md" / rel / "卷A.md"
    md.parent.mkdir(parents=True)
    md.write_text("", encoding="utf-8")
    ex = tmp_path / "extracted" / rel / "物理-卷A.jsonl"
    ex.parent.mkdir(parents=True)
    ex.write_text(json.dumps({
        "group_order": 19,
        "sub_no": 0,
        "content": "19. 旧题干 ![](images/a.jpg)",
        "options": [{"label": "A", "text": "甲"}],
        "answer": answer,
        "material_text": "旧素材",
    }, ensure_ascii=False) + "\n", encoding="utf-8")
    issues = tmp_path / "issues.jsonl"
    issues.write_text(json.dumps({
        "source": "物理-卷A",
        "rel_path": rel,
        "group_order": 19,
        "sub_no": 0,
        "kind": kind,
        "reasons": [],
        "status": "pending",
        "md": str(md),
        "content_sig": "sig",
    }, ensure_ascii=False) + "\n", encoding="utf-8")
    import review_content, review_queue
    monkeypatch.setattr(review_queue, "ISSUES_FILE", issues)
    monkeypatch.setattr(review_content, "ROOT", tmp_path)
    return issues


def _records(tmp_path):
    path = tmp_path / "fixes" / "物理-卷A.jsonl"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def test_s_stops_entire_item_without_record(tmp_path, monkeypatch):
    _prep(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.stdin", io.StringIO("s\n"))
    res = manual_fix.review_pending(fixes_dir=tmp_path / "fixes")
    assert res["skipped"] == 1
    assert not (tmp_path / "fixes" / "物理-卷A.jsonl").exists()


def test_enter_without_change_keeps_pending(tmp_path, monkeypatch):
    issues = _prep(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.stdin", io.StringIO("\n"))
    res = manual_fix.review_pending(fixes_dir=tmp_path / "fixes")
    assert res["skipped"] == 1
    assert json.loads(issues.read_text(encoding="utf-8"))["status"] == "pending"


def test_modify_two_slots_then_enter_records_both(tmp_path, monkeypatch):
    _prep(tmp_path, monkeypatch)
    monkeypatch.setattr(
        "sys.stdin",
        io.StringIO("1\n新题干\nEOF\n3\n新素材\nEOF\n\n"),
    )
    manual_fix.review_pending(fixes_dir=tmp_path / "fixes")
    rec = _records(tmp_path)[0]
    assert rec["content"].startswith("新题干")
    assert rec["material_text"] == "新素材"
    assert rec["answer"] == "甲"


def test_clear_answer_records_explicit_flag(tmp_path, monkeypatch):
    _prep(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.stdin", io.StringIO("4\n:c\n\n"))
    manual_fix.review_pending(fixes_dir=tmp_path / "fixes")
    rec = _records(tmp_path)[0]
    assert rec["clear_answer"] is True and rec["answer"] == ""
```

- [ ] **Step 2: 运行确认失败**

```bash
cd tools/data-refinery
python3 -m pytest tests/test_review_flow.py -q
```

Expected: 旧流程不接受新 key 序列。

- [ ] **Step 3: 实现结果类型**

```python
@dataclass
class QuestionPart:
    group_order: int
    sub_no: int
    content: str
    options: list[dict] | None
    material: str | None


@dataclass
class CardResult:
    action: str  # record / ok / skip / batch / noop
    patch: Patch | None = None
    batch: list[QuestionPart] = field(default_factory=list)


@dataclass
class RunResult:
    records: list[dict] = field(default_factory=list)
    outcome: str = "skipped"  # recorded / ok / skipped


def _issue_for(item: ReviewItem, group_order: int, sub_no: int) -> dict:
    flag = next(
        (
            f for f in item.flags
            if int(f.get("group_order") or item.group_order) == group_order
            and int(f.get("sub_no") or 0) == sub_no
        ),
        item.flags[0] if item.flags else {},
    )
    return {
        "source": item.source,
        "rel_path": item.rel_path,
        "group_order": group_order,
        "sub_no": sub_no,
        "kind": flag.get("kind"),
        "reasons": flag.get("reasons") or [],
        "md": flag.get("md"),
        "pdf": flag.get("pdf"),
        "content_sig": flag.get("content_sig"),
        "suspect_group_order": flag.get("suspect_group_order"),
        "suspect_sub_no": flag.get("suspect_sub_no"),
    }


def snapshot_for(
    item: ReviewItem,
    group_order: int,
    sub_no: int,
    *,
    load_repair: bool = False,
) -> Snapshot:
    return snapshot(_issue_for(item, group_order, sub_no), load_repair=load_repair)
```

`run_card()`：

- `k`：`close_as_ok()` 后返回 `CardResult("ok")`；
- `s` / EOF：返回 `CardResult("skip")`；
- 回车有改动：`CardResult("record", patch=state.draft.patch)`；
- 回车无改动：`CardResult("noop")`；
- 多题粘贴：`CardResult("batch", batch=parts)`；
- `q`：抛 `SystemExit(0)`。

- [ ] **Step 4: 实现 `run_item()` 的分支**

```python
def run_item(item: ReviewItem, index: int, total: int) -> RunResult:
    out = RunResult()
    primary_ok = False
    for target in item.targets():
        snap = snapshot_for(item, target.group_order, target.sub_no,
                            load_repair=item.is_repair)
        result = run_card(item, target, snap, index, total)
        if result.action == "skip":
            # 关联题卡已生成的记录不能丢：有记录就按 recorded 交给上层落盘
            out.outcome = "recorded" if out.records else "skipped"
            return out
        if result.action == "ok":
            if (target.group_order, target.sub_no) == (item.group_order, item.sub_no):
                primary_ok = True
                break
            continue
        if result.action == "noop":
            continue
        if result.action == "batch":
            for part in result.batch:
                part_snap = snapshot_for(item, part.group_order, part.sub_no)
                patch = Patch(
                    content=part.content,
                    options=part.options,
                    material=MaterialPatch(
                        article=UNSET,
                        inline=part.material if part.material is not None else UNSET,
                    ),
                )
                out.records.append(
                    build_record(
                        item,
                        part.group_order,
                        part.sub_no,
                        patch,
                        part_snap,
                    )
                )
            out.outcome = "recorded"
            return out
        if result.action == "record" and result.patch is not None:
            out.records.append(
                build_record(
                    item,
                    target.group_order,
                    target.sub_no,
                    result.patch,
                    snap,
                    dominant_type=item.dominant_type if "type_mismatch" in item.kinds else None,
                )
            )
    if out.records:
        out.outcome = "recorded"
    elif primary_ok:
        out.outcome = "ok"
    return out
```

- [ ] **Step 5: 实现主菜单与槽位**

主菜单按设计 §4.3 输出。槽位函数必须调用 `ReviewDraft` setter，不能整体替换 `MaterialPatch`。

题干/选项槽：

```python
def edit_content_slot(state) -> CardResult | None:
    kind, text = read_slot(
        console(),
        label="题干/选项",
        hint="回车=不改；粘贴=整段替换，EOF 结束；:e · :l · :f · :c",
        current=state.view.content,
        paper_md_dir=state.paper_dir,
    )
    if kind == "unchanged":
        return None
    if kind == "clear":
        state.draft.set_content("", [])
        return None
    parts = split_questions(text, get_strategy(state.item.subject))
    parts = _one_question_body(parts) or parts
    if len(parts) > 1:
        batch = []
        for no, body in parts:
            material, stem, options = split_material_and_options(
                get_strategy(state.item.subject), body
            )
            if not stem.strip():
                console().err(f"第 {no} 题解析出的题干为空，这批未记录")
                return None
            sub_no = state.item.sub_no if no == state.item.group_order else 0
            batch.append(QuestionPart(no, sub_no, stem.strip(), options, material))
        return CardResult("batch", batch=batch)
    material, stem, options = split_material_and_options(
        get_strategy(state.item.subject), text
    )
    if not stem.strip():
        console().err("题干解析为空，本条未记录")
        return None
    if not options and state.view.options:
        options = state.view.options
    state.draft.set_content(stem.strip(), options)
    if material:
        state.draft.set_inline(material)
    return None
```

共享材料槽：

```python
def edit_article_slot(state) -> None:
    c = console()
    issue = _issue_for(state.item, state.target.group_order, state.target.sub_no)
    cands = [] if state.view.article_url else _published_material_urls(issue)
    hint = "回车=不改；粘贴=替换全文；:e · :f · :p 看全文"
    if cands:
        hint += " · 序号=沿用 · n=本题无材料"
    c.prompt(f"共享材料 › （{hint}）")
    first = _read_line()
    if first is None or not first.strip():
        return
    text = first.strip()
    if cands and text.isdigit() and 1 <= int(text) <= len(cands):
        state.draft.claim_url(cands[int(text) - 1][1])
        return
    if text.lower() == "n":
        state.draft.clear_materials()
        return
    kind, article = read_slot(
        c,
        label="共享材料",
        hint="回车=不改；粘贴=替换全文；:e · :f · :p",
        current=state.view.article,
        paper_md_dir=state.paper_dir,
        allow_clear=False,
        allow_line_edit=False,
        first_line=text,
    )
    if kind != "value":
        return
    state.draft.set_article(article)
    if not state.view.article_url and not state.view.article:
        state.draft.set_share_with(_ask_share_with(issue))
```

`_ask_share_with()` 读取 `_paper_question_rows()` 的 `(group_order, sub_no, content)`；
候选列表同时显示题号与小问号，返回的 `material_share_with` 仍沿用现有记录字段，
只传题号；同题号多小问时拒绝把当前题号之外的歧义候选列入默认值。

```python
def _ask_share_with(issue: dict) -> list[int]:
    c = console()
    current = int(issue["group_order"])
    taken = {no for no, _url in _published_material_urls(issue)}
    candidates = [
        (no, sub_no, text)
        for no, sub_no, text in _paper_question_rows(issue)
        if no != current and no not in taken
    ]
    c.write("这篇共享材料还给哪些题用？（回车=仅本题；可填 12-14 或 12,13,14）")
    for no, sub_no, text in candidates[:15]:
        label = f"{no}({sub_no})" if sub_no else str(no)
        c.write(f"  {label}  {text[:28]}")
    c.prompt("共用题号 › ")
    raw = _read_line()
    if raw is None or not raw.strip():
        return [current]
    nums = _parse_question_numbers(raw)
    if nums is None:
        c.warn("没认出题号，请输入如 12-14 或 12,13,14")
        return [current]
    allowed = {no for no, _sub, _text in candidates} | {current}
    bad = [no for no in nums if no not in allowed]
    if bad:
        c.warn(f"第 {'、'.join(map(str, bad))} 题不在可选范围")
        return [current]
    return [current] + sorted({no for no in nums if no != current})
```

题内材料槽：

```python
def edit_inline_slot(state) -> None:
    kind, text = read_slot(
        console(),
        label="题内材料",
        hint="回车=不改；粘贴=替换；:e · :l · :f · :c 删除",
        current=state.view.inline,
        paper_md_dir=state.paper_dir,
        reject_wrapped=True,
    )
    if kind == "unchanged":
        return
    if kind == "clear":
        state.draft.clear_inline()
    else:
        state.draft.set_inline(text)
```

答案槽：

```python
def edit_answer_slot(state) -> None:
    kind, text = read_slot(
        console(),
        label="答案",
        hint="回车=不改；粘贴答案；:e · :f · :c 置空",
        current=state.view.answer,
        paper_md_dir=state.paper_dir,
    )
    if kind == "unchanged":
        return
    if kind == "clear":
        state.draft.clear_answer()
    else:
        state.draft.set_answer(text)
```

图片槽：

```python
def edit_image_slot(state) -> None:
    mode, paths = read_images(console(), state.view.images, state.paper_dir)
    if mode == "unchanged":
        return
    if mode == "clear":
        state.draft.set_images([], "clear")
        return
    refs = _copy_new_images(paths, state.paper_dir)
    if not refs:
        console().warn("拷图失败，未改动")
        return
    if mode == "append":
        state.draft.set_images([*state.view.images, *refs], "append")
    else:
        state.draft.set_images(refs, "replace")
```

- [ ] **Step 6: 重新渲染当前草稿**

`render_card()` 使用 `state.view`：

- `view.content/options/answer` 来自 Patch 覆盖值；
- `view.article/inline` 来自三态材料解析；
- `view.images` 来自 `patch.images`（有图片操作时）或 Snapshot；
- 所有“可整段拷贝”字段调用 `render_copyable()`。

- [ ] **Step 7: 删除旧流程函数和旧测试**

删除：

```text
_ask_verdict
_ask_edit_mode
_ask_image_mode
_ask_slots
_ask_one
_confirm_text
_collect_content
_collect_answer
_ask_answer_only
_collect_multi_image_flow
_targets
_ask_material_url
_collect_optional_block
_ask_choice
_ask_yes
```

同步删除或改写只测这些旧菜单的用例。明确保留并改写的旧能力测试：

- 一次粘贴多个题号；
- 同题号覆盖；
- 图片追加/替换/清空；
- `_restore_swallowed_option_label`；
- `_line_edit` / `_file_edit`；
- `same_article` 与材料槽路由。

- [ ] **Step 8: 运行测试**

```bash
cd tools/data-refinery
python3 -m pytest tests/test_review_flow.py -q
python3 -m pytest -q
```

Expected: 定向测试全 passed；全量全绿。

- [ ] **Step 9: 提交**

```bash
git add tools/data-refinery/src/manual_fix.py \
        tools/data-refinery/src/review_editor.py \
        tools/data-refinery/src/review_records.py \
        tools/data-refinery/tests/test_review_flow.py \
        tools/data-refinery/tests/test_manual_fix.py
git commit -m "feat(refinery): 人工校对改为题目卡片与统一槽位"
```

---

## Task 7: 全换、编辑器、修复前原文与入口编排

**Files:**
- Modify: `tools/data-refinery/src/manual_fix.py`
- Modify: `tools/data-refinery/src/review_records.py`
- Modify: `tools/data-refinery/src/review_queue.py`
- Modify: `tools/data-refinery/tests/test_review_flow.py`

**Interfaces:**

- Produces:
  - `replace_all(state)`
  - `edit_whole_in_editor(state)`
  - `use_repair_original(state)`
  - `close_as_ok(item, target)`
  - `review_pending(...) -> dict`
  - `review_by_numbers(...) -> int`

- [ ] **Step 1: 写失败测试**

追加到 `tests/test_review_flow.py`：

```python
def test_repair_u_returns_to_card_then_enter_records(tmp_path, monkeypatch):
    _prep(tmp_path, monkeypatch, kind="repair_truncated")
    lab = tmp_path / "output" / "labeling_issues.jsonl"
    lab.parent.mkdir(parents=True)
    lab.write_text(json.dumps({
        "source": "物理-卷A",
        "group_order": 19,
        "sub_no": 0,
        "original_content": "修复前完整原文",
        "regenerated": {"content": "短"},
    }, ensure_ascii=False) + "\n", encoding="utf-8")
    monkeypatch.setattr("sys.stdin", io.StringIO("u\n\n"))
    manual_fix.review_pending(fixes_dir=tmp_path / "fixes")
    rec = _records(tmp_path)[0]
    assert rec["content"] == "修复前完整原文"
    assert rec["content_only"] is True


def test_r_clears_material_url_and_images_but_keeps_answer(tmp_path, monkeypatch):
    _prep(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.stdin", io.StringIO("R\n1\n新题面\nEOF\n\n"))
    manual_fix.review_pending(fixes_dir=tmp_path / "fixes")
    rec = _records(tmp_path)[0]
    assert rec["content"] == "新题面"
    assert rec["answer"] == "甲"
    assert rec["material_url"] is None
    assert "images/" not in rec["content"]


def test_non_tty_does_not_read_stdin(tmp_path, monkeypatch):
    _prep(tmp_path, monkeypatch)

    class NonTTY:
        def isatty(self):
            return False

        def readline(self):
            raise AssertionError("非 TTY 不得读取 stdin")

    monkeypatch.setattr(manual_fix.sys, "stdin", NonTTY())
    res = manual_fix.review_pending(fixes_dir=tmp_path / "fixes")
    assert res["pending"] == 1
    assert res["skipped"] == 0
```

- [ ] **Step 2: 运行确认失败**

```bash
cd tools/data-refinery
python3 -m pytest tests/test_review_flow.py -q
```

Expected: 至少 `u`、`R`、非 TTY 用例失败。

- [ ] **Step 3: 实现 `R/E/u`**

`replace_all()`：

```python
def replace_all(state) -> None:
    ans = ask_replace_mode()
    if ans is None:
        return
    text = collect_replace_text(state, ans)
    if not text or not text.strip():
        console().warn("没有收到内容")
        return
    material, stem, options = split_material_and_options(
        get_strategy(state.item.subject), text
    )
    if not stem.strip():
        console().err("题干解析为空，未改动")
        return
    state.draft.set_content(stem.strip(), options or [])
    state.draft.clear_materials()
    state.draft.set_images([], "clear")
    if material:
        state.draft.set_inline(material)
```

`edit_whole_in_editor()`：

- 调 `editable_body(snap)`；
- `_file_edit()` 读回；
- `split_material_and_options()`；
- `draft.set_content()`；
- 从编辑器内容不能可靠判断哪些图被用户故意删除，因此设置 `images_mode="explicit"`；
- 编辑器返回的 material 用 `set_inline()`；没有返回 material 不自动清旧材料，只有用户显式清空那一段才清。

`use_repair_original()`：

```python
def use_repair_original(state) -> None:
    original = state.snap.repair_original
    if not original:
        console().warn("找不到修复前原文")
        return
    state.draft.use_restore_original(original)
```

不立即生成记录；返回主循环。用户继续修改其他槽位时，`ReviewDraft` setter 会清掉 `content_only`。

- [ ] **Step 4: 实现 `close_as_ok()`**

```python
def close_as_ok(item, target) -> None:
    note = "人工确认无问题，未改动"
    if item.kinds == {"junk_question"}:
        note = "人工确认：这行不是题目，忽略"
    elif (target.group_order, target.sub_no) != (item.group_order, item.sub_no):
        note = "人工确认：关联题没有问题"
    elif "missing" in item.kinds:
        note = "人工确认：卷面本来没有这道题"
    flag = next(
        (
            f for f in item.flags
            if int(f.get("group_order") or item.group_order) == target.group_order
            and int(f.get("sub_no") or 0) == target.sub_no
        ),
        item.flags[0] if item.flags else {},
    )
    mark_issue(
        item.source,
        target.group_order,
        "resolved",
        sub_no=target.sub_no,
        statuses={"pending"},
        note=note,
        verdict="no_change",
        content_sig=flag.get("content_sig"),
    )
```

- [ ] **Step 5: 接入入口**

`review_pending()`：

```python
if not list_only and not sys.stdin.isatty():
    c.info(f"待处理 {len(items)} 题；当前非交互终端")
    c.info("唯一入口：python3 src/fix_question_cli.py --source <卷名>")
    return {
        "pending": len(items),
        "fixed": 0,
        "skipped": 0,
        "confirmed_ok": 0,
        "unapplied": len(pending_records(fixes_dir=fixes_dir)),
    }
```

`fix_question_cli.py` 的 `--list` 仍可直接运行；非 `--list` 且非 TTY 时同样不读 stdin。

`_review_loop()` 的保存与状态回写：

```python
def _review_loop(items: list[ReviewItem], out_dir: Path, result: dict, c) -> None:
    for n, item in enumerate(items, 1):
        live = {i.key for i in group_items(_read_jsonl(ISSUES_FILE))}
        if item.key not in live:
            continue
        res = run_item(item, n, len(items))
        if res.outcome == "recorded":
            out_file = _save_records(item.source, res.records, out_dir)
            recorded_at = res.records[0]["created_at"]
            for group_order, sub_no in {
                (int(r["group_order"]), int(r.get("sub_no") or 0))
                for r in res.records
            }:
                recorded_flags(
                    ReviewItem(
                        source=item.source,
                        rel_path=item.rel_path,
                        group_order=group_order,
                        sub_no=sub_no,
                    ),
                    str(out_file),
                    recorded_at,
                )
            result["fixed"] += len(res.records)
        elif res.outcome == "ok":
            result["confirmed_ok"] += 1
        else:
            result["skipped"] += 1
```

`review_by_numbers()`：

- 先列出该题号的 extracted 行；
- 若同题号有多个 `sub_no`，提示用户选择 `sub_no`；
- 构造 `ReviewItem(sub_no=选中的值)`；
- `_save_records()` 返回实际路径，记录状态时使用该路径。

- [ ] **Step 6: 修正 summary**

- `unapplied = len(pending_records(fixes_dir=out_dir))`；
- `fixed` 按实际记录的题数计数；
- `confirmed_ok`、`skipped` 按 `ReviewItem` 计数；
- 0 条待写库时不显示该行。

- [ ] **Step 7: 运行测试**

```bash
cd tools/data-refinery
python3 -m pytest tests/test_review_flow.py -q
python3 -m pytest -q
```

Expected: 定向测试全 passed；全量全绿。

- [ ] **Step 8: 提交**

```bash
git add tools/data-refinery/src/manual_fix.py \
        tools/data-refinery/src/review_records.py \
        tools/data-refinery/src/review_queue.py \
        tools/data-refinery/tests/test_review_flow.py
git commit -m "feat(refinery): 完成人工校对入口与状态编排"
```

---

## Task 8: 文档同步、回归与人工冒烟

**Files:**
- Modify: `tools/data-refinery/README.md`
- Modify: `docs/data-refinery-使用手册.md`
- Modify: `docs/data-refinery-管线总结与后续.md`
- Modify: `docs/constraints/数据管线.md`
- Modify: `docs/ai-core-changelog.md`

- [ ] **Step 1: 更新 README**

把人工补题段改为：

```text
一题一卡：卡片给全现状，主菜单选段。
1 题干/选项 · 2 共享材料 · 3 题内材料 · 4 答案 · 5 图
E 编辑器改整题 · R 全换 · k 确认无问题 · 回车=结束 · s 稍后 · q 退出

槽内：回车=不改，其余都是内容（EOF 结束），命令：
:e 编辑器 · :l 逐行 · :f 文件/剪贴板 · :c 清空 · :p 看全文
旧 @路径 不再支持，请用 :f。
```

- [ ] **Step 2: 更新使用手册**

把“补题时图片怎么处理”“只补答案”合成“人工校对：一题一卡”，并写清：

- `k` / 回车 / `s` 三个不写库出口；
- 答案 `:c` 的实际写库结果；
- 图片清空、替换、追加；
- 多题号粘贴只批量改题干/选项/材料，不改答案；
- 非 TTY 的唯一入口命令。

- [ ] **Step 3: 更新管线总结**

`docs/data-refinery-管线总结与后续.md` 的“人工校对修材料（2026-11-22 修订）”改为当前一题一卡流程。保留以下写库约束：

- article / inline / both 自动路由；
- `same_article` 判重；
- 卷内隔离 key；
- `apply_fixes` 后 publish + `--load-cards` 增量回灌；
- 原文档不直接修改。

- [ ] **Step 4: 更新 constraints**

修改 `docs/constraints/数据管线.md` 人工校对段落：

- 保留“全部 kind 按题目身份收口”；
- 增补 `sub_no` 身份规则；
- 把旧多套菜单改为新卡片/槽位；
- 保留 AppleScript 先 `furl` 后 PNGf、不要另写 OCR 入口；
- 写入答案清空必须用 `clear_answer=True`，禁止把普通空答案当清空。

- [ ] **Step 5: 追加 changelog**

```text
**人工校对改为一题一卡（2026-11-26）**：题目身份升级为
(source, group_order, sub_no)；卡片展示全部现状，槽位统一“回车=不改 / 冒号命令”；
材料使用三态 Patch，图片支持追加/替换/清空；答案清空新增 clear_answer 兼容字段；
多题号粘贴按题拆分但不批量改答案。旧补题记录继续兼容。
```

- [ ] **Step 6: 文档反查**

Run:

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
rg -n '按 flag 排队|@路径|保留原图只改文字|先在文件里改|_ask_image_mode|_ask_verdict|三段式槽位' \
  tools/data-refinery/README.md \
  docs/data-refinery-使用手册.md \
  docs/data-refinery-管线总结与后续.md \
  docs/constraints/数据管线.md
```

Expected: 只允许历史 changelog 或明确标注“已废弃”的命中；活文档不得继续把旧交互写成当前行为。

- [ ] **Step 7: 全量回归**

```bash
cd tools/data-refinery
python3 -m pytest -q
npx tsc --noEmit
```

`npx tsc --noEmit` 仅用于确认本仓库没有跨包类型生成物被误改；若 data-refinery 不含 TS 工程，则跳过并在交付说明记录原因。

- [ ] **Step 8: 人工冒烟**

```bash
cd tools/data-refinery
python3 src/fix_question_cli.py --source 西城
```

检查：

- 一屏能给全内容；
- `k` 只关当前题目身份；
- 改题干 + 改材料后回车，两条修改都保留；
- 答案 `:c` 预览显示将清空；
- 图片图槽清空后卡片不再显示旧图；
- `R` 清空材料/图，答案仍在；
- 多题号粘贴生成多条记录；
- `s` 后不再弹同一 ReviewItem 的关联卡；
- `q` 后剩余列表正确；
- 非 TTY 打印唯一入口命令。

- [ ] **Step 9: 提交**

```bash
git add tools/data-refinery/README.md \
        docs/data-refinery-使用手册.md \
        docs/data-refinery-管线总结与后续.md \
        docs/constraints/数据管线.md \
        docs/ai-core-changelog.md
git commit -m "docs(refinery): 同步人工校对一题一卡流程"
```

---

## Self-Review

### Spec Coverage

| 设计要求 | 对应任务 |
|---|---|
| 输入原语、槽位命令、原样渲染 | Task 1 |
| Snapshot、文章读取、`sub_no` 当前题 | Task 2 |
| 按题目身份聚合、全部 kind 收口 | Task 3 |
| 三态材料、图片模式、组合草稿、多小问覆盖 | Task 4 |
| 清空答案写库 | Task 5 |
| 卡片、菜单、五槽位、多题粘贴、`s` 停止 | Task 6 |
| `R/E/u/k`、TTY、主动重录、summary | Task 7 |
| README/手册/约束/管线总结/changelog | Task 8 |

### Type Consistency

- 队列身份：`(source, group_order, sub_no)`；
- `ReviewItem.key`、`recorded_flags()`、`mark_issue(sub_no=...)`、`_save_records()` 使用同一键；
- 记录覆盖键：`(group_order, sub_no)`；
- 图片模式：`keep / append / replace / clear / explicit`；
- 材料三态：`UNSET / None / value`；
- 卡片目标统一使用 `ReviewTarget(group_order, sub_no, note)`；多题粘贴使用
  `QuestionPart(group_order, sub_no, content, options, material)`，两者都携带题号与小问号。

### 验收口径（可量化）

| 场景 | 输入次数上限 | 断言方式 |
|---|---|---|
| 改题干（粘贴替换） | 4 | `test_review_flow.py` 里 `sys.stdin` 行数 |
| 只改共享材料 / 题内材料 | 4 | 同上 |
| 只补答案 | 2 | 同上 |
| 砍短保留现状 | 1 | 同上 |
| 同一张卡改题干 + 清答案 | 6 | 同条记录同时含 `content` 与 `clear_answer` |

旧能力落点逐条见 spec §12。Task 6/7 的黄金会话至少要覆盖：改题干、改共享材料、
改题内材料、只补答案、砍短用原文、缺题 + 关联题、换图/清图、清答案；其余输入原语
（剪贴板、行编辑、回显、折行）由 Task 1 的单元测试覆盖。

### Placeholder Scan

- 每项已给出具体文件、接口、测试和验证命令；
- 不复用旧计划中的“7 passed/4 passed”等过期计数；
- 不再把 `apply_fixes` 说成零改动；
- 不再要求 `@路径` 与“其他输入都是内容”并存。
