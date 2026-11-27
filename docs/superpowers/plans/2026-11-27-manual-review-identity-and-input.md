# 人工校对题号身份与输入栏改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 统一人工校对的题号身份，把吞并关系拆成可独立收口的 issue，并完成不会重复重绘的编辑流程与可编辑终端输入栏。

**Architecture:** 扫描阶段为 suspect 题生成带关联字段和 `content_sig` 的独立 `merged_content` issue；人工校对只使用 `ReviewItem(source, group_order, sub_no)` 作为数据身份；草稿 revision 区分“本次编辑”与“历史已有修改”；prompt_toolkit 通过显式 prompt 适配层接入 TTY，非 TTY 保持原路径。真实 76816 的 md 与 extracted 快照进入 fixtures，其 E2E 测试是最终完成门禁。

**Tech Stack:** Python 3.10、pytest、prompt_toolkit 3.0.51、JSONL fixtures、现有 data-refinery 模块。

## Global Constraints

- `ReviewItem(source, group_order, sub_no)` 是唯一题目身份；显示、记录、收口不得使用第二身份。
- `recognition_issues.jsonl` 只新增可选字段，不新增必填字段。
- 不新增数据库列，不运行 migration，不修改 `apply_fixes` 写库协议。
- 非 TTY 的 stdin 读取、提示顺序、EOF 和返回文本必须与改造前一致。
- 不得读取被 gitignore 的 `tools/data-refinery/output/` 作为测试 fixture。
- 最终完成前必须运行并通过 `pytest tests/test_manual_review_76816_e2e.py -q`。
- 行为变化必须同步更新测试与设计文档。

---

## File Structure

**Fixtures**

- Create: `tools/data-refinery/tests/fixtures/real_cases/76816/paper.md`
- Create: `tools/data-refinery/tests/fixtures/real_cases/76816/extracted.jsonl`
- Responsibility: 冻结真实 76816 试卷 Markdown 和对应切题快照。

**Recognition and review**

- Modify: `tools/data-refinery/src/recognition_scan.py`
- Modify: `tools/data-refinery/src/review_queue.py`
- Modify: `tools/data-refinery/src/manual_fix.py`
- Modify: `tools/data-refinery/src/review_records.py`
- Modify: `tools/data-refinery/src/review_editor.py`
- Create: `tools/data-refinery/src/terminal_input.py`
- Modify: `tools/data-refinery/requirements.txt`

**Tests and docs**

- Create: `tools/data-refinery/tests/test_manual_review_76816_e2e.py`
- Create: `tools/data-refinery/tests/test_terminal_input.py`
- Modify: `tools/data-refinery/tests/test_recognition_scan.py`
- Modify: `tools/data-refinery/tests/test_review_queue.py`
- Modify: `tools/data-refinery/tests/test_manual_fix.py`
- Modify: `tools/data-refinery/tests/test_review_flow.py`
- Modify: `docs/superpowers/specs/2026-11-26-manual-review-redesign-design.md`
- Modify: `docs/superpowers/specs/2026-11-27-manual-review-identity-and-input-design.md`

---

### Task 1: 冻结 76816 真实 case 并先建立失败门禁

**Files:**
- Create: `tools/data-refinery/tests/fixtures/real_cases/76816/paper.md`
- Create: `tools/data-refinery/tests/fixtures/real_cases/76816/extracted.jsonl`
- Create: `tools/data-refinery/tests/test_manual_review_76816_e2e.py`

**Interfaces:**
- Consumes: 当前真实 76816 `.md` 与 extracted JSONL。
- Produces: `REAL_76816_PAPER`、`REAL_76816_EXTRACTED`、`REAL_76816_SOURCE`、`REAL_76816_REL`；后续任务持续运行本文件。

- [x] **Step 1: 原样复制真实 fixture**

从当前被 gitignore 的 `output/` 原样复制，不重新生成或清洗：

```text
源 md:
tools/data-refinery/output/md/数学/初中/first/2024/数学-初三(上)-202407-北京各-（上）期中-试卷-76816/数学-初三(上)-202407-北京各-（上）期中-试卷-76816.md

目标:
tools/data-refinery/tests/fixtures/real_cases/76816/paper.md

源 extracted:
tools/data-refinery/output/extracted/数学/初中/first/2024/数学-初三(上)-202407-北京各-（上）期中-试卷-76816/数学-初三(上)-202407-北京各-（上）期中-试卷-76816.jsonl

目标:
tools/data-refinery/tests/fixtures/real_cases/76816/extracted.jsonl
```

目标哈希：

```text
paper.md          ca9c91bcd9d5fb4ba670be106ae302f7e71dfddf522095dbf03a0cf34b201257
extracted.jsonl   011b17dfa11d3da7663cc60cdd0680a711a16f6695d0aa6b3077e04d25f669d3
```

- [x] **Step 2: 写真实 case 测试**

Create `tools/data-refinery/tests/test_manual_review_76816_e2e.py`:

```python
"""真实 76816 卷的人工校对身份与关系门禁。"""

import hashlib
import json
import shutil
from pathlib import Path

import manual_fix
import recognition_scan as R
import review_content
import review_editor
import review_queue
from review_records import Patch, ReviewDraft


HERE = Path(__file__).resolve().parent
FIXTURE_DIR = HERE / "fixtures" / "real_cases" / "76816"
REAL_76816_PAPER = FIXTURE_DIR / "paper.md"
REAL_76816_EXTRACTED = FIXTURE_DIR / "extracted.jsonl"
REAL_76816_SOURCE = "数学-初三(上)-202407-北京各-（上）期中-试卷-76816"
REAL_76816_REL = (
    "数学/初中/first/2024/"
    "数学-初三(上)-202407-北京各-（上）期中-试卷-76816"
)


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _jsonl(path: Path) -> list[dict]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )


def _stage_case(tmp_path: Path, monkeypatch) -> tuple[Path, Path, list[dict]]:
    md_dir = tmp_path / "output" / "md" / REAL_76816_REL
    ex_dir = tmp_path / "output" / "extracted" / REAL_76816_REL
    md_dir.mkdir(parents=True)
    ex_dir.mkdir(parents=True)
    md = md_dir / f"{REAL_76816_SOURCE}.md"
    extracted = ex_dir / f"{REAL_76816_SOURCE}.jsonl"
    shutil.copy2(REAL_76816_PAPER, md)
    shutil.copy2(REAL_76816_EXTRACTED, extracted)

    issues_file = tmp_path / "output" / "recognition_issues.jsonl"
    stem_file = tmp_path / "output" / "stem_chain_issues.jsonl"
    labeling_file = tmp_path / "output" / "labeling_issues.jsonl"
    fixes_dir = tmp_path / "output" / "manual_fixes"
    fixes_dir.mkdir(parents=True)
    _write_jsonl(stem_file, [])
    _write_jsonl(labeling_file, [])

    monkeypatch.setattr(review_editor, "ROOT", tmp_path)
    monkeypatch.setattr(review_content, "ROOT", tmp_path)
    monkeypatch.setattr(review_queue, "ISSUES_FILE", issues_file)
    monkeypatch.setattr(review_queue, "FIXES_DIR", fixes_dir)
    monkeypatch.setattr(R, "ROOT", tmp_path)
    monkeypatch.setattr(R, "ISSUES_FILE", issues_file)
    monkeypatch.setattr(R, "STEM_ISSUES_FILE", stem_file)
    monkeypatch.setattr(R, "FIXES_DIR", fixes_dir)
    monkeypatch.setattr(manual_fix, "ISSUES_FILE", issues_file)
    monkeypatch.setattr(manual_fix, "FIXES_DIR", fixes_dir)
    return md, extracted, _jsonl(extracted)


def _scan_case(tmp_path: Path, monkeypatch) -> tuple[list[dict], Path]:
    md, _extracted, rows = _stage_case(tmp_path, monkeypatch)
    issues = R.scan_paper(
        REAL_76816_SOURCE,
        Path(REAL_76816_REL),
        md,
        rows,
        None,
        [],
    )
    _write_jsonl(tmp_path / "output" / "recognition_issues.jsonl", issues)
    return issues, md


def test_real_76816_fixture_hashes_are_frozen():
    assert _sha256(REAL_76816_PAPER) == (
        "ca9c91bcd9d5fb4ba670be106ae302f7e71dfddf522095dbf03a0cf34b201257"
    )
    assert _sha256(REAL_76816_EXTRACTED) == (
        "011b17dfa11d3da7663cc60cdd0680a711a16f6695d0aa6b3077e04d25f669d3"
    )


def test_real_76816_creates_independent_identity_issues(tmp_path, monkeypatch):
    issues, _md = _scan_case(tmp_path, monkeypatch)
    missing = {row["group_order"] for row in issues if row["kind"] == "missing"}
    assert missing == {14, 18, 22, 26}

    pairs = {
        (row["group_order"], row["related_group_order"])
        for row in issues
        if row["kind"] == "merged_content"
        and row.get("related_issue_kind") == "missing"
    }
    assert pairs == {(13, 14), (21, 22), (25, 26)}

    items = review_queue.group_items(issues)
    assert {item.group_order for item in items} >= {13, 14, 18, 21, 22, 25, 26}
    by_no = {item.group_order: item for item in items}
    assert {"incomplete_content", "merged_content"} <= by_no[25].kinds
    for item in items:
        if item.group_order in {13, 14, 21, 22, 25, 26}:
            assert [(t.group_order, t.sub_no) for t in item.targets()] == [
                (item.group_order, item.sub_no)
            ]


def test_real_76816_renders_and_records_same_identity(tmp_path, monkeypatch, capsys):
    issues, md = _scan_case(tmp_path, monkeypatch)
    by_no = {item.group_order: item for item in review_queue.group_items(issues)}

    for no in (13, 14, 25, 26):
        target = by_no[no].targets()[0]
        snap = manual_fix.snapshot_for(by_no[no], no, by_no[no].sub_no)
        state = manual_fix.CardState(
            item=by_no[no],
            target=target,
            snap=snap,
            draft=ReviewDraft(snap),
            paper_dir=md.parent,
            index=1,
            total=7,
        )
        manual_fix.render_card(state)

    out = capsys.readouterr().out
    assert "第 13 题" in out
    assert "第 14 题" in out
    assert "可能混入了第 14 题" in out
    assert "第 25 题" in out
    assert "第 26 题" in out
    assert "疑似被第 25 题吞并" in out

    item13 = by_no[13]
    snap13 = manual_fix.snapshot_for(item13, 13, item13.sub_no)
    rec13 = manual_fix.build_record(
        item13, 13, item13.sub_no, Patch(content="第 13 题修正正文"), snap13
    )
    assert rec13["group_order"] == 13

    item26 = by_no[26]
    snap26 = manual_fix.snapshot_for(item26, 26, item26.sub_no)
    rec26 = manual_fix.build_record(
        item26, 26, item26.sub_no, Patch(content="第 26 题补录正文"), snap26
    )
    assert rec26["group_order"] == 26


def test_real_76816_group_pair_closes_independently(tmp_path, monkeypatch):
    issues, _md = _scan_case(tmp_path, monkeypatch)
    by_no = {item.group_order: item for item in review_queue.group_items(issues)}
    manual_fix.close_as_ok(by_no[13], by_no[13].targets()[0])

    saved = _jsonl(tmp_path / "output" / "recognition_issues.jsonl")
    status13 = {
        row["status"] for row in saved
        if row["group_order"] == 13 and row.get("related_group_order") == 14
    }
    status14 = {row["status"] for row in saved if row["group_order"] == 14}
    assert status13 == {"resolved"}
    assert status14 == {"pending"}


def test_real_76816_merged_issue_reopens_on_content_change(tmp_path, monkeypatch):
    issues, _md = _scan_case(tmp_path, monkeypatch)
    current = next(
        row for row in issues
        if row["group_order"] == 13
        and row["kind"] == "merged_content"
        and row.get("related_group_order") == 14
    )
    resolved = {
        **current,
        "status": "resolved",
        "verdict": "no_change",
    }
    fresh = {
        **current,
        "content_sig": "changed-after-confirmation",
    }
    assert R.reopen_changed([resolved], [fresh]) == 1
    assert resolved["status"] == "pending"
```

- [x] **Step 3: 运行门禁，确认当前实现失败**

Run:

```bash
cd tools/data-refinery
pytest tests/test_manual_review_76816_e2e.py -q
```

Expected: FAIL。至少缺少 `related_group_order`，且 targets 仍返回 suspect 卡。

- [x] **Step 4: Commit fixtures 与失败门禁**（git add 暂存；按指令不 commit）

```bash
git add tools/data-refinery/tests/fixtures/real_cases/76816 \
        tools/data-refinery/tests/test_manual_review_76816_e2e.py
git commit -m "test(refinery): freeze manual review case 76816"
```

> 执行注记（2026-11-27）：按 team-lead 指令本次不 commit/push，已用 `git add` 暂存替代。

---

### Task 2: 生成带关系与指纹的独立 suspect issue

**Files:**
- Modify: `tools/data-refinery/src/recognition_scan.py`
- Test: `tools/data-refinery/tests/test_recognition_scan.py`

**Interfaces:**
- Produces: `_issue_key()` 包含 `sub_no`；`fixed_numbers()` 返回 `(group_order, sub_no)` key；
  suspect issue 带 `related_group_order`、`related_issue_kind`、`content_sig`、`sub_no`。

- [x] **Step 1: 写失败测试**（`test_suspect_missing_creates_related_merged_issue` 的 missing 选择器按用户裁决加 `group_order == 14` 过滤，生产扫描范围不变）

Append to `test_recognition_scan.py`:

```python
def test_suspect_missing_creates_related_merged_issue(tmp_path):
    md = _md(tmp_path, "13. 甲题 14. 乙题\n15. 丙题\n")
    rows = _rows(
        (13, "甲题 14. 乙题"),
        (15, "丙题"),
        (16, "丁题"),
        (17, "戊题"),
    )
    issues = R.scan_paper("卷A", Path("数学/x/卷A"), md, rows, None, [])

    missing_by_no = {
        issue["group_order"]: issue
        for issue in issues
        if issue["kind"] == "missing"
    }
    missing = missing_by_no[14]
    derived = next(
        i for i in issues
        if i["kind"] == "merged_content"
        and i.get("related_issue_kind") == "missing"
    )
    assert missing["group_order"] == 14
    assert derived["group_order"] == 13
    assert derived["related_group_order"] == 14
    assert derived["sub_no"] == 0
    assert derived["content_sig"] == R.content_sig("甲题 14. 乙题")
    assert "body_contains_stem_14" in derived["reasons"]
    assert not any(
        reason in {"missing_stem", "md_has_no_such_stem", "next_starts_with_subq_no_stem"}
        for reason in derived["reasons"]
    )


def test_issue_key_and_fixed_numbers_include_sub_no(tmp_path):
    issue = {
        "source": "卷A",
        "group_order": 26,
        "sub_no": 2,
        "kind": "incomplete_content",
    }
    assert R._issue_key(issue) == ("卷A", 26, 2, "incomplete_content")

    fixes = tmp_path / "fixes"
    fixes.mkdir()
    (fixes / "卷A.jsonl").write_text(
        json.dumps({"group_order": 26, "sub_no": 1, "applied": True}) + "\n"
        + json.dumps({"group_order": 26, "sub_no": 2, "applied": False}) + "\n",
        encoding="utf-8",
    )
    assert R.fixed_numbers("卷A", fixes) == {(26, 1): True, (26, 2): False}


def test_related_merged_issue_reopens_when_suspect_content_changes():
    old = {
        "source": "卷A",
        "group_order": 13,
        "sub_no": 0,
        "kind": "merged_content",
        "related_group_order": 14,
        "status": "resolved",
        "verdict": "no_change",
        "content_sig": "old",
    }
    fresh = {
        "source": "卷A",
        "group_order": 13,
        "sub_no": 0,
        "kind": "merged_content",
        "related_group_order": 14,
        "content_sig": "new",
    }
    assert R.reopen_changed([old], [fresh]) == 1
    assert old["status"] == "pending"
```

- [x] **Step 2: 运行失败测试**

```bash
cd tools/data-refinery
pytest \
  tests/test_recognition_scan.py::test_suspect_missing_creates_related_merged_issue \
  tests/test_recognition_scan.py::test_issue_key_and_fixed_numbers_include_sub_no \
  tests/test_recognition_scan.py::test_related_merged_issue_reopens_when_suspect_content_changes \
  -q
```

Expected: FAIL。

- [x] **Step 3: 修改 issue key 与 applied lookup**

Implement:

```python
def _issue_key(i: dict) -> tuple:
    base = (
        i["source"],
        int(i.get("group_order") or 0),
        int(i.get("sub_no") or 0),
        str(i.get("kind") or ""),
    )
    related = i.get("related_group_order")
    if related is not None:
        base += ("related", int(related))
    line_no = i.get("line_no")
    return base if line_no is None else base + ("line", line_no)


def fixed_numbers(
    source: str, fixes_dir: Path | None = None,
) -> dict[tuple[int, int], bool]:
    path = Path(fixes_dir or FIXES_DIR) / f"{source}.jsonl"
    out: dict[tuple[int, int], bool] = {}
    for rec in _read_jsonl(path):
        try:
            key = (int(rec["group_order"]), int(rec.get("sub_no") or 0))
        except (KeyError, TypeError, ValueError):
            continue
        out[key] = bool(rec.get("applied"))
    return out
```

In `reopen_unbacked()`:

```python
applied = fix_cache[it["source"]].get(
    (int(it["group_order"]), int(it.get("sub_no") or 0))
)
```

- [x] **Step 4: 生成 suspect issue**

Implement:

```python
def _suspect_merged_issue(
    *, source: str, rel_path: Path, md_path: Path, pdf_path: Path | None,
    missing_no: int, suspect_row: dict, missing_reasons: list[str],
) -> dict:
    reasons = [r for r in missing_reasons if str(r).startswith("prev_")]
    reasons.insert(0, f"body_contains_stem_{missing_no}")
    body = suspect_row.get("content") or ""
    return {
        "source": source,
        "rel_path": str(rel_path),
        "group_order": int(suspect_row["group_order"]),
        "sub_no": int(suspect_row.get("sub_no") or 0),
        "kind": "merged_content",
        "reasons": reasons,
        "excerpt": _excerpt(body),
        "pdf": str(pdf_path) if pdf_path else None,
        "md": str(md_path),
        "content_sig": content_sig(body),
        "related_group_order": missing_no,
        "related_issue_kind": "missing",
        "status": "pending",
    }
```

Make `add()` return the created `issue`, then after adding missing:

```python
missing_issue = add(n, "missing", reasons, excerpt, suspect_group_order=suspect)
if suspect is not None and suspect in by_no:
    issues.append(
        _suspect_merged_issue(
            source=source,
            rel_path=rel_path,
            md_path=md_path,
            pdf_path=pdf_path,
            missing_no=n,
            suspect_row=by_no[suspect],
            missing_reasons=reasons,
        )
    )
```

- [x] **Step 5: 更新旧 fixed_numbers 断言**

```python
assert R.fixed_numbers("物理-卷A-试卷", fixes) == {
    (7, 0): True,
    (16, 0): False,
}
```

- [x] **Step 6: 验证并提交**（git add 暂存；按指令不 commit）

```bash
cd tools/data-refinery
pytest tests/test_recognition_scan.py -q
pytest tests/test_manual_review_76816_e2e.py -q
git add tools/data-refinery/src/recognition_scan.py \
        tools/data-refinery/tests/test_recognition_scan.py
git commit -m "feat(refinery): derive independent suspect review issues"
```

> 执行注记：按 team-lead 指令不 commit，已 `git add` 暂存替代。

Expected: 扫描测试 PASS；真实门禁只剩 target/UI 断言失败。

---

### Task 3: 取消 target 多卡并统一记录/收口身份

**Files:**
- Modify: `tools/data-refinery/src/review_queue.py`
- Modify: `tools/data-refinery/src/manual_fix.py`
- Modify: `tools/data-refinery/tests/test_review_queue.py`
- Modify: `tools/data-refinery/tests/test_review_flow.py`
- Modify: `tools/data-refinery/tests/test_manual_fix.py`

**Interfaces:**
- Consumes: `related_group_order`、`related_issue_kind`、`suspect_group_order`。
- Produces: `ReviewItem.targets()` 始终只返回自身；`ReviewItem.relation_text() -> str | None`；
  记录、收口、显示全部使用 item 身份。

- [x] **Step 1: 重写 target 测试**

In `test_review_queue.py` replace suspect-first tests with:

```python
def test_targets_always_returns_self_only():
    rows = [
        {"source": "卷A", "group_order": 14, "sub_no": 0, "kind": "missing",
         "status": "pending", "suspect_group_order": 13},
    ]
    item = review_queue.group_items(rows)[0]
    assert [(t.group_order, t.sub_no) for t in item.targets()] == [(14, 0)]


def test_relation_text_uses_explicit_numbers():
    missing = review_queue.ReviewItem(
        source="卷A", rel_path="数学/x/卷A", group_order=26,
        flags=[{"kind": "missing", "status": "pending", "suspect_group_order": 25}],
    )
    merged = review_queue.ReviewItem(
        source="卷A", rel_path="数学/x/卷A", group_order=25,
        flags=[{
            "kind": "merged_content",
            "status": "pending",
            "related_group_order": 26,
            "related_issue_kind": "missing",
        }],
    )
    assert missing.relation_text() == "第 26 题疑似被第 25 题吞并"
    assert merged.relation_text() == "第 25 题可能混入了第 26 题"
```

In `test_review_flow.py`, replace `test_missing_question_asks_suspect_card_first` with:

```python
def test_related_questions_are_independent_items(tmp_path, monkeypatch):
    md = str(tmp_path / "output/md" / REL / "卷A.md")
    issues = _env(
        tmp_path, monkeypatch,
        questions=[_q(27, content="27. 上一题"), _q(28, content="")],
        issues=[
            _i(28, "missing", md=md, suspect_group_order=27),
            _i(
                27,
                "merged_content",
                md=md,
                related_group_order=28,
                related_issue_kind="missing",
            ),
        ],
    )
    monkeypatch.setattr("sys.stdin", io.StringIO("s\ns\n"))
    manual_fix.review_pending(fixes_dir=tmp_path / "fixes")
    rows = [json.loads(line) for line in issues.read_text(encoding="utf-8").splitlines()]
    assert {(r["group_order"], r["status"]) for r in rows} == {
        (27, "pending"),
        (28, "pending"),
    }
```

- [x] **Step 2: 运行失败测试**

```bash
cd tools/data-refinery
pytest \
  tests/test_review_queue.py::test_targets_always_returns_self_only \
  tests/test_review_queue.py::test_relation_text_uses_explicit_numbers \
  tests/test_review_flow.py::test_related_questions_are_independent_items \
  -q
```

Expected: FAIL。

- [x] **Step 3: 实现单 target 与关系文案**

Implement in `review_queue.py`:

```python
def _label(no: int, sub_no: int = 0) -> str:
    return f"{no}({sub_no})" if sub_no else str(no)


class ReviewItem:
    def relation_text(self) -> str | None:
        for flag in self.flags:
            related = flag.get("related_group_order")
            if related is not None and flag.get("related_issue_kind") == "missing":
                return (
                    f"第 {_label(self.group_order, self.sub_no)} 题"
                    f"可能混入了第 {int(related)} 题"
                )
            suspect = flag.get("suspect_group_order")
            if isinstance(suspect, int) and suspect != self.group_order:
                return (
                    f"第 {_label(self.group_order, self.sub_no)} 题"
                    f"疑似被第 {suspect} 题吞并"
                )
        return None

    def targets(self) -> list["ReviewTarget"]:
        return [ReviewTarget(self.group_order, self.sub_no, self.note())]
```

- [x] **Step 4: 卡片改用 item 身份和关系文案**

In `render_card()`:

```python
c.step(
    state.index,
    state.total,
    f"第 {_label(item.group_order, item.sub_no)} 题",
    target.note,
)
relation = item.relation_text()
if relation:
    c.warn(relation)
```

In `close_as_ok()` call:

```python
mark_issue(
    item.source,
    item.group_order,
    "resolved",
    sub_no=item.sub_no,
    statuses={"pending"},
    note=note,
    verdict="no_change",
    content_sig=flag.get("content_sig"),
)
```

In `run_item()` use:

```python
snap = snapshot_for(item, item.group_order, item.sub_no, load_repair=item.is_repair)
result = run_card(item, item.targets()[0], snap, index, total)
...
build_record(
    item,
    item.group_order,
    item.sub_no,
    result.patch,
    snap,
)
```

Keep multi-number paste passing `part.group_order/part.sub_no`.

In `edit_whole_in_editor()` create the temp-file label with
`state.item.group_order`, not target.

- [x] **Step 5: 运行身份测试和真实门禁**

```bash
cd tools/data-refinery
pytest \
  tests/test_review_queue.py \
  tests/test_review_flow.py \
  tests/test_manual_fix.py \
  tests/test_manual_review_76816_e2e.py \
  -q
```

Expected: PASS。

- [x] **Step 6: Commit**（git add 暂存；按指令不 commit）

```bash
git add tools/data-refinery/src/review_queue.py \
        tools/data-refinery/src/manual_fix.py \
        tools/data-refinery/tests/test_review_queue.py \
        tools/data-refinery/tests/test_review_flow.py \
        tools/data-refinery/tests/test_manual_fix.py
git commit -m "fix(refinery): unify manual review question identity"
```

> 执行注记：按 team-lead 指令不 commit，已 `git add` 暂存替代。

---

### Task 4: revision 控制重绘并修答案缺失卡

**Files:**
- Modify: `tools/data-refinery/src/review_records.py`
- Modify: `tools/data-refinery/src/manual_fix.py`
- Modify: `tools/data-refinery/tests/test_review_records.py`
- Modify: `tools/data-refinery/tests/test_manual_fix.py`

**Interfaces:**
- Produces: `ReviewDraft.revision: int`；所有实际字段修改递增 revision；
  `run_card()` 只在首帧整卡渲染；answer missing 先渲染再编辑。

- [x] **Step 1: 写失败测试**（`test_answer_missing_renders_card_before_edit` 从 `test_review_flow` 复用 `_env/_q/_i/REL` 助手）

Append to `test_review_records.py`:

```python
def test_review_draft_revision_only_changes_on_real_edit():
    draft = rr.ReviewDraft(object())
    assert draft.revision == 0
    draft.set_content("新正文", [])
    assert draft.revision == 1
    draft.clear_answer()
    assert draft.revision == 2
    draft.use_restore_original("修复前原文")
    assert draft.revision == 3
```

Append to `test_manual_fix.py`:

```python
def test_edit_success_does_not_render_whole_card_again(tmp_path, monkeypatch):
    _prep_content(tmp_path, monkeypatch)
    calls = []
    original = manual_fix.render_card
    monkeypatch.setattr(
        manual_fix,
        "render_card",
        lambda state: calls.append(state.item.group_order) or original(state),
    )
    monkeypatch.setattr("sys.stdin", io.StringIO("1\n修正后的题干\nEOF\n\n"))
    manual_fix.review_pending(fixes_dir=tmp_path / "fixes")
    assert calls == [27]


def test_answer_missing_renders_card_before_edit(tmp_path, monkeypatch):
    md = str(tmp_path / "output/md" / REL / "卷A.md")
    _env(
        tmp_path, monkeypatch,
        questions=[_q(19, content="19. 题干", answer="")],
        issues=[_i(19, "answer_missing", md=md)],
    )
    seen = []
    original_render = manual_fix.render_card
    monkeypatch.setattr(
        manual_fix,
        "render_card",
        lambda state: seen.append("render") or original_render(state),
    )

    def edit(state):
        seen.append("edit")
        state.draft.set_answer("D")

    monkeypatch.setattr(manual_fix, "edit_answer_slot", edit)
    manual_fix.review_pending(fixes_dir=tmp_path / "fixes")
    assert seen == ["render", "edit"]
```

- [x] **Step 2: 运行失败测试**

```bash
cd tools/data-refinery
pytest \
  tests/test_review_records.py::test_review_draft_revision_only_changes_on_real_edit \
  tests/test_manual_fix.py::test_edit_success_does_not_render_whole_card_again \
  tests/test_manual_fix.py::test_answer_missing_renders_card_before_edit \
  -q
```

Expected: FAIL。

- [x] **Step 3: 实现 revision**

In `ReviewDraft`:

```python
def __init__(self, snap):
    self.snap = snap
    self.patch = Patch()
    self.revision = 0

def _touch(self):
    self.revision += 1

def _regular_edit(self):
    self.patch.content_only = False
    self._touch()

def use_restore_original(self, content):
    self.patch.content = content
    self.patch.content_only = True
    self._touch()
```

Do not increment for `unchanged`, parse failure, or cancelled editor.

- [x] **Step 4: 重构 run_card**

Implement:

```python
render_card(state)

if item.kinds == {"answer_missing"} and snap.content:
    before = state.draft.revision
    edit_answer_slot(state)
    changed = has_changes(state.draft.patch)
    if changed and state.draft.revision > before:
        c.ok(
            f"第 {_label(item.group_order, item.sub_no)} 题"
            "修改已加入本次记录（尚未保存）"
        )
    return CardResult(
        "record" if changed else "noop",
        patch=state.draft.patch if changed else None,
    )

while True:
    action, arg = ask_menu(...)
    before = state.draft.revision
    # execute action
    if action not in ("ok", "skip"):
        state.armed = None
    if state.draft.revision > before:
        c.ok(
            f"第 {_label(item.group_order, item.sub_no)} 题"
            "修改已加入本次记录（尚未保存）"
        )
```

Remove `render_card(state)` from inside the loop. `ask_menu()` continues to print the menu on
each iteration.

- [x] **Step 5: 验证并提交**（git add 暂存；按指令不 commit）

```bash
cd tools/data-refinery
pytest \
  tests/test_review_records.py \
  tests/test_manual_fix.py \
  tests/test_manual_review_76816_e2e.py \
  -q
git add tools/data-refinery/src/review_records.py \
        tools/data-refinery/src/manual_fix.py \
        tools/data-refinery/tests/test_review_records.py \
        tools/data-refinery/tests/test_manual_fix.py
git commit -m "fix(refinery): avoid duplicate manual review redraw"
```

> 执行注记：按 team-lead 指令不 commit，已 `git add` 暂存替代。

Expected: PASS。

---

### Task 5: prompt_toolkit 输入与显式 prompt 适配

**Files:**
- Create: `tools/data-refinery/src/terminal_input.py`
- Create: `tools/data-refinery/tests/test_terminal_input.py`
- Modify: `tools/data-refinery/src/review_editor.py`
- Modify: `tools/data-refinery/src/manual_fix.py`
- Modify: `tools/data-refinery/requirements.txt`

**Interfaces:**
- Produces: `terminal_input.read_line(message="")`、`terminal_input.read_block(message="", default="")`、
  `review_editor.read_prompt(c, prompt)`。
- Consumes: 现有 `_split_at_marker()`、`_restore_swallowed_option_label()` 和非 TTY loop。

- [x] **Step 1: 添加依赖与输入测试**

Add to `requirements.txt`:

```text
prompt_toolkit>=3.0.51
```

Create `test_terminal_input.py`:

```python
from prompt_toolkit.input.defaults import create_pipe_input
from prompt_toolkit.output import DummyOutput

import review_editor
import terminal_input


def test_read_line_moves_cursor_and_submits():
    with create_pipe_input() as pipe:
        pipe.send_text("ab\x1b[DX\r")
        got = terminal_input.read_line(
            "> ", input=pipe, output=DummyOutput(),
            history=terminal_input.new_history(),
        )
    assert got == "aXb"


def test_read_line_keeps_history_across_calls():
    history = terminal_input.new_history()
    with create_pipe_input() as pipe:
        pipe.send_text("first\r")
        first = terminal_input.read_line(
            "", input=pipe, output=DummyOutput(), history=history
        )
    with create_pipe_input() as pipe:
        pipe.send_text("\x1b[A\r")
        second = terminal_input.read_line(
            "", input=pipe, output=DummyOutput(), history=history
        )
    assert first == "first"
    assert second == "first"


def test_read_block_accepts_eof_marker():
    with create_pipe_input() as pipe:
        pipe.send_text("第一行\n第二行\nEOF\r")
        got = terminal_input.read_block(
            "", input=pipe, output=DummyOutput(),
            history=terminal_input.new_history(),
        )
    assert got == "第一行\n第二行\nEOF"


def test_read_line_ctrl_d_returns_none():
    with create_pipe_input() as pipe:
        pipe.send_text("\x04")
        got = terminal_input.read_line(
            "", input=pipe, output=DummyOutput(),
            history=terminal_input.new_history(),
        )
    assert got is None


def test_read_prompt_non_tty_prints_once(monkeypatch):
    prompts = []

    class FakeConsole:
        def prompt(self, text):
            prompts.append(text)

        def paint(self, text, *_styles):
            return text

    monkeypatch.setattr(review_editor.sys.stdin, "isatty", lambda: False)
    monkeypatch.setattr(review_editor, "_read_line", lambda: "answer")
    assert review_editor.read_prompt(FakeConsole(), "题目 › ") == "answer"
    assert prompts == ["题目 › "]
```

- [x] **Step 2: 运行失败测试**

```bash
cd tools/data-refinery
pytest tests/test_terminal_input.py -q
```

Expected: FAIL with `ModuleNotFoundError: terminal_input`。

- [x] **Step 3: 实现 terminal_input**

Create `src/terminal_input.py`:

```python
"""prompt_toolkit-backed terminal editing used only on a TTY."""

from prompt_toolkit import PromptSession
from prompt_toolkit.history import InMemoryHistory
from prompt_toolkit.key_binding import KeyBindings


def new_history() -> InMemoryHistory:
    return InMemoryHistory()


_LINE_HISTORY = new_history()
_LINE_SESSION = PromptSession(history=_LINE_HISTORY)


def read_line(message="", *, input=None, output=None, history=None):
    session = (
        PromptSession(
            message=message,
            history=history or _LINE_HISTORY,
            input=input,
            output=output,
        )
        if input is not None or output is not None or history is not None
        else _LINE_SESSION
    )
    try:
        if session is _LINE_SESSION:
            return session.prompt(message)
        return session.prompt()
    except EOFError:
        return None


def _block_bindings():
    bindings = KeyBindings()

    @bindings.add("enter")
    def _enter(event):
        line = event.current_buffer.document.current_line_before_cursor
        upper = line.strip().upper()
        if "EOF" in upper or upper in {"END", "结束"}:
            event.current_buffer.validate_and_handle()
        else:
            event.current_buffer.insert_text("\n")

    @bindings.add("escape", "enter")
    @bindings.add("c-d")
    def _submit(event):
        event.current_buffer.validate_and_handle()

    return bindings


_BLOCK_SESSION = PromptSession(
    multiline=True,
    key_bindings=_block_bindings(),
    history=new_history(),
)


def read_block(message="", *, default="", input=None, output=None, history=None):
    session = (
        PromptSession(
            message=message,
            multiline=True,
            key_bindings=_block_bindings(),
            history=history or new_history(),
            input=input,
            output=output,
        )
        if input is not None or output is not None or history is not None
        else _BLOCK_SESSION
    )
    try:
        if session is _BLOCK_SESSION:
            return session.prompt(message, default=default)
        return session.prompt(default=default)
    except EOFError:
        return default
```

- [x] **Step 4: 实现 prompt 适配与 TTY 委托**

In `review_editor.py`:

```python
def read_prompt(c: Console, prompt: str) -> str | None:
    if sys.stdin.isatty():
        from terminal_input import read_line
        return read_line(c.paint(prompt, "cyan"))
    c.prompt(prompt)
    return _read_line()


def _read_line(prompt: str = "") -> str | None:
    if prompt and sys.stdin.isatty():
        from terminal_input import read_line
        return read_line(prompt)
    if prompt:
        print(prompt, end="", flush=True)
    line = sys.stdin.readline()
    return None if line == "" else line.rstrip("\n")


def _read_block(first_chunk: str = "") -> str:
    c = console()
    if sys.stdin.isatty():
        from terminal_input import read_block
        raw = read_block(default=first_chunk)
        body, _done = _split_at_marker(raw)
        lines = body.splitlines() if body else []
        c.ok(f"已收到 {len(lines)} 行")
        return "\n".join(_restore_swallowed_option_label(lines)).strip()
    # Keep the existing non-TTY loop unchanged here.
```

- [x] **Step 5: 替换 prompt 配对**

Replace every:

```python
c.prompt("提示 › ")
raw = _read_line()
```

with:

```python
raw = read_prompt(c, "提示 › ")
```

Convert all `manual_fix.py` and `review_editor.py` call sites, including menus, shared material,
replace-all, paper/subquestion selection, read slots, image slots, editor waits, and apply
confirmation. Export `read_prompt` through the `manual_fix.py` named imports.

- [x] **Step 6: 验证与提交**（git add 暂存；按指令不 commit）

```bash
cd tools/data-refinery
pytest \
  tests/test_terminal_input.py \
  tests/test_manual_fix.py \
  tests/test_review_flow.py \
  -q
git add tools/data-refinery/requirements.txt \
        tools/data-refinery/src/terminal_input.py \
        tools/data-refinery/src/review_editor.py \
        tools/data-refinery/src/manual_fix.py \
        tools/data-refinery/tests/test_terminal_input.py
git commit -m "feat(refinery): add editable terminal input"
```

> 执行注记：按 team-lead 指令不 commit，已 `git add` 暂存替代。

Expected: PASS。

- [x] **Step 7: TTY 冒烟**（PTY 实测：↑ 找回上一条、EOF 独立行收尾、整卡只渲染一次、Exit 0；:e 由单测覆盖）

```bash
cd tools/data-refinery
python3 src/fix_question_cli.py --source 76816
```

Verify: 提示只出现一次、↑ 能找回上一条单行输入、`:e` 返回后不整卡重绘、空输入
Ctrl+D 不崩栈、`EOF` 独立行结束多行输入。

---

### Task 6: 文档同步与最终 76816 门禁

**Files:**
- Modify: `docs/superpowers/specs/2026-11-26-manual-review-redesign-design.md`
- Modify: `docs/superpowers/specs/2026-11-27-manual-review-identity-and-input-design.md`

**Interfaces:**
- Consumes: Task 1-5 的最终接口和测试。
- Produces: 设计、计划、旧设计替代说明与真实 case 一致。

- [x] **Step 1: 核对文档无冲突和占位**

```bash
rg -n "target 卡|整卡重绘|修改已加入本次记录" \
  docs/superpowers/specs/2026-11-26-manual-review-redesign-design.md
rg -n "T[B]D|T[O]DO|待[定]|以后[再]说" \
  docs/superpowers/specs/2026-11-27-manual-review-identity-and-input-design.md \
  docs/superpowers/plans/2026-11-27-manual-review-identity-and-input.md
```

Expected: 第一条命中替代说明；第二条零命中。

- [x] **Step 2: 运行唯一真实 case 门禁**

```bash
cd tools/data-refinery
pytest tests/test_manual_review_76816_e2e.py -q
```

Expected: PASS。失败时立即停止。

- [x] **Step 3: 运行全量回归**（2345 passed, 10 skipped；同步更新了 test_review_editor 的两处假 TTY 用例以适配 read_prompt 适配层）

```bash
cd tools/data-refinery
pytest -q
```

Expected: PASS，network 用例按仓库规则 skip。

- [x] **Step 4: 检查工作区**

```bash
git diff --check
git status --short
```

Expected: 无空白错误；真实 fixtures 已被 Git 跟踪。

- [x] **Step 5: 最终提交**（git add 暂存全部改动；按 team-lead 指令不 commit/push）

```bash
git add docs/superpowers/specs/2026-11-26-manual-review-redesign-design.md \
        docs/superpowers/specs/2026-11-27-manual-review-identity-and-input-design.md \
        docs/superpowers/plans/2026-11-27-manual-review-identity-and-input.md
git commit -m "docs(refinery): finalize manual review identity plan"
```

> 执行注记：按 team-lead 指令不 commit/push；全部改动已 `git add` 暂存，工作区无未暂存改动。

---

## Final Completion Gate

不得以“单项测试通过”或“人工看起来正常”代替真实 case。完成条件必须同时满足：

```bash
cd tools/data-refinery
pytest tests/test_manual_review_76816_e2e.py -q
pytest -q
```

两条命令都 PASS 后，才能宣称人工校对身份与输入栏改造完成。
