"""recognition_scan：缺号 / 顿号题号 / 修复删内容 / 噪声题 的判定。"""

from pathlib import Path

import recognition_scan as R


def _md(tmp_path, text):
    p = tmp_path / "卷A.md"
    p.write_text(text, encoding="utf-8")
    return p


def _rows(*specs):
    """specs: (group_order, content)"""
    return [{"group_order": no, "content": c, "type": "choice"} for no, c in specs]


def test_no_issues_when_numbers_are_contiguous(tmp_path):
    md = _md(tmp_path, "1. 甲\n2. 乙\n")
    rows = _rows((1, "甲"), (2, "乙"))
    assert R.scan_paper("卷A", Path("物理/x/卷A"), md, rows, None, []) == []


def test_missing_question_points_at_previous_when_it_is_too_long(tmp_path):
    md = _md(tmp_path, "1. 甲\n\n3. 丙\n")
    # 多给几道短题，中位数才会被压下来，200 字那道才算"异常长"
    rows = _rows((1, "甲" * 200), (3, "丙"), (4, "丁"), (5, "戊"), (6, "己"))
    issues = R.scan_paper("卷A", Path("物理/x/卷A"), md, rows, None, [])

    missing = [i for i in issues if i["kind"] == "missing"]
    assert len(missing) == 1
    assert missing[0]["group_order"] == 2
    assert missing[0]["suspect_group_order"] == 1
    assert any("prev_len" in r for r in missing[0]["reasons"])


def test_missing_question_flags_absent_stem_in_markdown(tmp_path):
    md = _md(tmp_path, "1. 甲\n\n3. 丙\n")
    rows = _rows((1, "甲"), (3, "丙"))
    issues = R.scan_paper("卷A", Path("物理/x/卷A"), md, rows, None, [])
    assert "md_has_no_such_stem" in issues[0]["reasons"]


def test_punct_separator_stem_is_reported(tmp_path):
    """md 里写成「18、」，切题器不认 —— 要单独报出来。"""
    md = _md(tmp_path, "17. 甲\n18、乙题\n19. 丙\n")
    rows = _rows((17, "甲"), (19, "丙"))
    issues = R.scan_paper("卷A", Path("物理/x/卷A"), md, rows, None, [])

    punct = [i for i in issues if i["kind"] == "punct_stem"]
    assert len(punct) == 1
    assert punct[0]["group_order"] == 18


def test_repair_truncated_keeps_original_text(tmp_path):
    md = _md(tmp_path, "1. 甲\n")
    rows = _rows((1, "甲"))
    labeling = [{"source": "卷A", "group_order": 1,
                 "original_content": "原" * 100,
                 "regenerated": {"content": "缩" * 20}}]
    issues = R.scan_paper("卷A", Path("物理/x/卷A"), md, rows, None, labeling)

    rep = [i for i in issues if i["kind"] == "repair_truncated"]
    assert len(rep) == 1
    assert rep[0]["excerpt"].startswith("原")
    assert "repair_shrank_100_to_20" in rep[0]["reasons"]


def test_junk_question_detected_for_signature_line(tmp_path):
    md = _md(tmp_path, "1. 命题人：李岩\n")
    rows = _rows((1, "命题人: 李岩 覃凌 审核人：许建荣"))
    issues = R.scan_paper("卷A", Path("物理/x/卷A"), md, rows, None, [])

    junk = [i for i in issues if i["kind"] == "junk_question"]
    assert len(junk) == 1 and junk[0]["group_order"] == 1


def test_issue_carries_pdf_and_md_paths(tmp_path):
    md = _md(tmp_path, "1. 甲\n\n3. 丙\n")
    rows = _rows((1, "甲"), (3, "丙"))
    pdf = tmp_path / "卷A.pdf"
    pdf.write_bytes(b"%PDF")
    issues = R.scan_paper("卷A", Path("物理/x/卷A"), md, rows, pdf, [])

    assert issues[0]["pdf"] == str(pdf)
    assert issues[0]["md"] == str(md)
    assert issues[0]["status"] == "pending"
