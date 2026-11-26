import io
import json

import manual_fix

REL = "物理/初中/2026/卷A"
SOURCE = "物理-卷A"


def _env(tmp_path, monkeypatch, *, questions, issues):
    md = tmp_path / "output" / "md" / REL / "卷A.md"
    md.parent.mkdir(parents=True, exist_ok=True)
    md.write_text("", encoding="utf-8")
    ex = tmp_path / "output" / "extracted" / REL / f"{SOURCE}.jsonl"
    ex.parent.mkdir(parents=True, exist_ok=True)
    ex.write_text("".join(json.dumps(q, ensure_ascii=False) + "\n" for q in questions),
                  encoding="utf-8")
    issues_file = tmp_path / "issues.jsonl"
    issues_file.write_text(
        "".join(json.dumps(i, ensure_ascii=False) + "\n" for i in issues),
        encoding="utf-8")
    import review_content
    import review_queue
    monkeypatch.setattr(review_queue, "ISSUES_FILE", issues_file)
    monkeypatch.setattr(review_content, "ROOT", tmp_path)
    return issues_file


def _q(no, content="题干", answer="甲", **kw):
    return {"group_order": no, "sub_no": 0, "content": content,
            "options": [{"label": "A", "text": "甲"}], "answer": answer, **kw}


def _i(no, kind="incomplete_content", **kw):
    md = kw.pop("md", None)
    return {"source": SOURCE, "rel_path": REL, "group_order": no, "sub_no": 0,
            "kind": kind, "reasons": [], "status": "pending",
            "md": md or "", "content_sig": "sig", **kw}


def _prep(tmp_path, monkeypatch, kind="incomplete_content", answer="甲"):
    issues = _env(
        tmp_path, monkeypatch,
        questions=[_q(19, content="19. 旧题干 ![](images/a.jpg)",
                      answer=answer, material_text="旧素材")],
        issues=[_i(19, kind)],
    )
    md = tmp_path / "output" / "md" / REL / "卷A.md"
    rows = [json.loads(line) for line in issues.read_text(encoding="utf-8").splitlines()]
    for row in rows:
        row["md"] = str(md)
    issues.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows),
                      encoding="utf-8")
    return issues


def _records(tmp_path):
    path = tmp_path / "fixes" / f"{SOURCE}.jsonl"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def test_s_stops_entire_item_without_record(tmp_path, monkeypatch):
    _prep(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.stdin", io.StringIO("s\n"))
    res = manual_fix.review_pending(fixes_dir=tmp_path / "fixes")
    assert res["skipped"] == 1
    assert not (tmp_path / "fixes" / f"{SOURCE}.jsonl").exists()


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


def test_k_closes_every_flag_of_same_question(tmp_path, monkeypatch):
    issues = _env(
        tmp_path, monkeypatch,
        questions=[_q(19)],
        issues=[_i(19, "incomplete_content", md=str(tmp_path / "output/md" / REL / "卷A.md")),
                _i(19, "answer_missing", md=str(tmp_path / "output/md" / REL / "卷A.md"))],
    )
    monkeypatch.setattr("sys.stdin", io.StringIO("k\n"))
    manual_fix.review_pending(fixes_dir=tmp_path / "fixes")
    rows = [json.loads(line) for line in issues.read_text(encoding="utf-8").splitlines()]
    assert {r["status"] for r in rows} == {"resolved"}
    assert {r.get("verdict") for r in rows} == {"no_change"}


def test_record_marks_question_recorded_and_writes_fix_file(tmp_path, monkeypatch):
    issues = _prep(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.stdin", io.StringIO("1\n新题干\nEOF\n\n"))
    manual_fix.review_pending(fixes_dir=tmp_path / "fixes")
    saved = json.loads(issues.read_text(encoding="utf-8"))
    assert saved["status"] == "recorded"
    assert saved["fix_file"].endswith(f"{SOURCE}.jsonl")


def test_multi_number_paste_records_each_question(tmp_path, monkeypatch):
    md = str(tmp_path / "output/md" / REL / "卷A.md")
    issues = _env(
        tmp_path, monkeypatch,
        questions=[_q(10, content="10. 旧甲"), _q(11, content="11. 旧乙")],
        issues=[_i(10, "missing", md=md), _i(11, "missing", md=md)],
    )
    monkeypatch.setattr("sys.stdin", io.StringIO(
        "1\n10. 甲题正文\n11. 乙题正文\nEOF\n\n"))
    res = manual_fix.review_pending(fixes_dir=tmp_path / "fixes")
    recs = _records(tmp_path)
    assert [r["group_order"] for r in recs] == [10, 11]
    assert [r["answer"] for r in recs] == ["甲", "甲"]      # 答案沿用各题原值
    statuses = [json.loads(line)["status"]
                for line in issues.read_text(encoding="utf-8").splitlines()]
    assert statuses == ["recorded", "recorded"]
    assert res["fixed"] == 2


def test_missing_question_asks_suspect_card_first(tmp_path, monkeypatch):
    md = str(tmp_path / "output/md" / REL / "卷A.md")
    issues = _env(
        tmp_path, monkeypatch,
        questions=[_q(27, content="27. 上一题"), _q(28, content="")],
        issues=[_i(28, "missing", md=md, suspect_group_order=27)],
    )
    monkeypatch.setattr("sys.stdin", io.StringIO(
        "1\n27 只留自己的正文\nEOF\n\n"
        "1\n28 补录正文\nEOF\n\n"))
    manual_fix.review_pending(fixes_dir=tmp_path / "fixes")
    assert [r["group_order"] for r in _records(tmp_path)] == [27, 28]
    assert json.loads(issues.read_text(encoding="utf-8"))["status"] == "recorded"


def test_list_shows_question_count_and_remaining(tmp_path, monkeypatch, capsys):
    md = str(tmp_path / "output/md" / REL / "卷A.md")
    _env(
        tmp_path, monkeypatch,
        questions=[_q(n) for n in (10, 11, 12)],
        issues=[_i(n, "missing", md=md) for n in (10, 11, 12)],
    )
    monkeypatch.setattr("sys.stdin", io.StringIO("q\n"))
    res = manual_fix.review_pending(fixes_dir=tmp_path / "fixes")
    out = capsys.readouterr().out
    assert "共 3 题待处理" in out
    assert "还没处理" in out and "第10题" in out
    assert res["pending"] == 3


def test_placeholder_plus_image_slot_replaces_ref(tmp_path, monkeypatch):
    md = str(tmp_path / "output/md" / REL / "卷A.md")
    _env(
        tmp_path, monkeypatch,
        questions=[_q(19, content="19. 旧题干")],
        issues=[_i(19, md=md)],
    )
    img = tmp_path / "crop.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\nCROP1")
    monkeypatch.setattr("sys.stdin", io.StringIO(
        "1\n19. 如图 [图1] 求解析式\nEOF\n"
        f"5\n1\n{img}\neof\n\n"))
    manual_fix.review_pending(fixes_dir=tmp_path / "fixes")
    rec = _records(tmp_path)[0]
    assert "[图1]" not in rec["content"]
    assert "![](images/manual_" in rec["content"]
    assert list((tmp_path / "output" / "md" / REL / "images").glob("manual_*.png"))
