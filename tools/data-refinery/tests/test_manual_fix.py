"""manual_fix：待补题筛选（import_cli 第 7 步按本次扫描到的卷精确取）。"""

import json
from pathlib import Path

import manual_fix


def _write(path, rows):
    path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows),
                    encoding="utf-8")


def test_pending_issues_filters_by_exact_sources(tmp_path, monkeypatch):
    issues = [
        {"source": "物理-卷A-试卷", "group_order": 7, "kind": "missing", "status": "pending"},
        {"source": "物理-卷B-试卷", "group_order": 2, "kind": "missing", "status": "pending"},
        {"source": "物理-卷A-试卷", "group_order": 3, "kind": "missing", "status": "resolved"},
    ]
    path = tmp_path / "issues.jsonl"
    _write(path, issues)
    monkeypatch.setattr(manual_fix, "ISSUES_FILE", path)

    got = manual_fix.pending_issues({"物理-卷A-试卷"})
    assert [i["group_order"] for i in got] == [7], "只取指定卷、且只要 pending"


def test_pending_issues_filters_by_substring(tmp_path, monkeypatch):
    path = tmp_path / "issues.jsonl"
    _write(path, [
        {"source": "物理-海淀·人大附中-（上）期中-试卷", "group_order": 7,
         "kind": "missing", "status": "pending"},
        {"source": "物理-海淀·一零一中学-（上）期中-试卷", "group_order": 28,
         "kind": "missing", "status": "pending"},
    ])
    monkeypatch.setattr(manual_fix, "ISSUES_FILE", path)

    assert [i["group_order"] for i in manual_fix.pending_issues(file="人大附中")] == [7]


def test_locate_pdf_uses_sibling_of_paper_dir(tmp_path):
    """PDF 比 md 少一层目录：<年>/<卷名>.pdf vs <年>/<卷名>/<卷名>.md。"""
    from recognition_scan import locate_pdf

    rel = tmp_path / "物理" / "初中" / "first" / "2024" / "卷A"
    rel.mkdir(parents=True)
    pdf = rel.parent / "卷A.pdf"
    pdf.write_bytes(b"%PDF-1.4")

    assert locate_pdf(tmp_path, Path("物理/初中/first/2024/卷A"), "卷A") == pdf
