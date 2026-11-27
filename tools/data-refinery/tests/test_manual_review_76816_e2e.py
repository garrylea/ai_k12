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
