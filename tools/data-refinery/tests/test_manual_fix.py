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


# ---------- 交互输入：粘贴 / EOF 标记 ----------

import io
import json as _json


def _prep(tmp_path, monkeypatch, order=28):
    md_dir = tmp_path / "md" / "物理" / "初中" / "first" / "2024" / "卷A"
    md_dir.mkdir(parents=True)
    (md_dir / "卷A.md").write_text("", encoding="utf-8")
    issue = {"source": "物理-卷A-试卷", "rel_path": "物理/初中/first/2024/卷A",
             "group_order": order, "kind": "missing", "reasons": ["missing_stem"],
             "excerpt": "", "pdf": None, "md": str(md_dir / "卷A.md"), "status": "pending"}
    issues_file = tmp_path / "issues.jsonl"
    issues_file.write_text(_json.dumps(issue, ensure_ascii=False) + "\n", encoding="utf-8")
    monkeypatch.setattr(manual_fix, "ISSUES_FILE", issues_file)
    return issue, issues_file


def test_review_accepts_whole_paste_block_with_marker(tmp_path, monkeypatch):
    """终端整段粘贴（多行 + EOF 一次送到）不能卡住。"""
    _prep(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.stdin", io.StringIO("题干第一行\n(1) 小问\nEOF\n\n"))

    res = manual_fix.review_pending(fixes_dir=tmp_path / "fixes")

    assert res["fixed"] == 1
    out = (tmp_path / "fixes" / "物理-卷A-试卷.jsonl").read_text(encoding="utf-8")
    assert "题干第一行" in out and "(1) 小问" in out


def test_review_accepts_lowercase_eof(tmp_path, monkeypatch):
    _prep(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.stdin", io.StringIO("题干\neof\n\n"))
    assert manual_fix.review_pending(fixes_dir=tmp_path / "fixes")["fixed"] == 1


def test_review_ends_when_stream_ends_without_marker(tmp_path, monkeypatch):
    """没有 EOF 标记、输入流直接结束：把已输入的当正文，不能死等。"""
    _prep(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.stdin", io.StringIO("题干没有结束标记\n"))
    assert manual_fix.review_pending(fixes_dir=tmp_path / "fixes")["fixed"] == 1


def test_review_skip_with_s(tmp_path, monkeypatch):
    issue, issues_file = _prep(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.stdin", io.StringIO("s\n"))

    res = manual_fix.review_pending(fixes_dir=tmp_path / "fixes")

    assert res == {"pending": 1, "fixed": 0, "skipped": 1}
    assert '"status": "pending"' in issues_file.read_text(encoding="utf-8")


# ---------- 输入解析的边界 ----------

import pytest


@pytest.mark.parametrize("text,body,done", [
    ("a\nb\nEOF\n", "a\nb", True),
    ("a\nb\neof\n", "a\nb", True),
    ("a\nEND\n", "a", True),
    ("a\n结束\n", "a", True),
    ("a\nb", "a\nb", False),
    ("EOF\n", "", True),
    ("a\nEOF\n多余的尾巴", "a", True),
    ("题干正文 EOF 标记后面的都不算", "题干正文", True),   # 任意位置出现即结束
    ("a\nb\nEND\n", "a\nb", True),
])
def test_split_at_marker(text, body, done):
    assert manual_fix._split_at_marker(text) == (body, done)


def test_collect_content_reads_at_file(tmp_path, monkeypatch):
    src = tmp_path / "q.md"
    src.write_text("从文件来的题干", encoding="utf-8")
    monkeypatch.setattr("sys.stdin", io.StringIO(f"@{src}\n"))
    assert manual_fix._collect_content(tmp_path) == "从文件来的题干"


def test_collect_content_quit_raises():
    monkeypatch_stdin = io.StringIO("q\n")
    import sys as _sys
    old = _sys.stdin
    try:
        _sys.stdin = monkeypatch_stdin
        with pytest.raises(SystemExit):
            manual_fix._collect_content(Path("."))
    finally:
        _sys.stdin = old


def test_collect_content_image_goes_through_mineru(tmp_path, monkeypatch):
    img = tmp_path / "shot.png"
    img.write_bytes(b"png")
    monkeypatch.setattr("sys.stdin", io.StringIO(f"2\n{img}\n\n"))
    called = {}

    def fake_convert(image, md_dir):
        called["image"] = image
        return "OCR 出来的题干"

    monkeypatch.setattr(manual_fix, "_image_to_markdown", fake_convert)

    assert manual_fix._collect_content(tmp_path) == "OCR 出来的题干"
    assert called["image"] == img


def test_collect_content_image_rejected_asks_again(tmp_path, monkeypatch):
    img = tmp_path / "shot.png"
    img.write_bytes(b"png")
    # 第一次给图片并回 n，第二次直接粘贴文本
    monkeypatch.setattr("sys.stdin", io.StringIO(f"2\n{img}\nr\n手工题干\nEOF\n\n"))
    monkeypatch.setattr(manual_fix, "_image_to_markdown", lambda i, d: "OCR 题干")

    assert manual_fix._collect_content(tmp_path) == "手工题干"


# ---------- 记录与写回 ----------

def _prep_n(tmp_path, monkeypatch, n=1):
    md_dir = tmp_path / "md" / "物理" / "初中" / "first" / "2024" / "卷A"
    md_dir.mkdir(parents=True, exist_ok=True)
    (md_dir / "卷A.md").write_text("", encoding="utf-8")
    rows = [{"source": "物理-卷A-试卷", "rel_path": "物理/初中/first/2024/卷A",
             "group_order": 10 + i, "kind": "missing", "reasons": ["missing_stem"],
             "excerpt": "", "pdf": None, "md": str(md_dir / "卷A.md"), "status": "pending"}
            for i in range(n)]
    path = tmp_path / "issues.jsonl"
    path.write_text("".join(_json.dumps(r, ensure_ascii=False) + "\n" for r in rows),
                    encoding="utf-8")
    monkeypatch.setattr(manual_fix, "ISSUES_FILE", path)
    return path


def test_ask_records_choice_options(tmp_path, monkeypatch):
    path = _prep_n(tmp_path, monkeypatch)
    issue = _json.loads(path.read_text(encoding="utf-8").splitlines()[0])
    monkeypatch.setattr("sys.stdin",
                        io.StringIO("下列说法正确的是\nA. 甲\nB. 乙\nC. 丙\nD. 丁\nEOF\n\nA\n"))

    recs = manual_fix._ask(issue, tmp_path)

    assert len(recs) == 1
    rec = recs[0]
    assert rec["content"] == "下列说法正确的是"
    assert [o["label"] for o in rec["options"]] == ["A", "B", "C", "D"]
    assert rec["answer"] == "A"
    assert rec["status"] == "ready" and rec["applied"] is False


def test_ask_returns_none_on_empty_content(tmp_path, monkeypatch):
    path = _prep_n(tmp_path, monkeypatch)
    issue = _json.loads(path.read_text(encoding="utf-8").splitlines()[0])
    monkeypatch.setattr("sys.stdin", io.StringIO("\nEOF\n"))

    assert manual_fix._ask(issue, tmp_path) == []


def test_review_marks_issue_recorded_and_writes_fix_file(tmp_path, monkeypatch):
    """补录只标「recorded」：还没写库，不能算解决。"""
    path = _prep_n(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.stdin", io.StringIO("题干\nEOF\n\n"))

    res = manual_fix.review_pending(fixes_dir=tmp_path / "fixes")

    assert res["fixed"] == 1
    saved = _json.loads(path.read_text(encoding="utf-8").splitlines()[0])
    assert saved["status"] == "recorded"
    assert saved["fix_file"].endswith("物理-卷A-试卷.jsonl")


def test_review_processes_multiple_issues_in_order(tmp_path, monkeypatch):
    path = _prep_n(tmp_path, monkeypatch, n=3)
    monkeypatch.setattr("sys.stdin", io.StringIO("题一\nEOF\n\n\n题二\nEOF\n\n\n题三\nEOF\n\n\n"))

    res = manual_fix.review_pending(fixes_dir=tmp_path / "fixes")

    assert res == {"pending": 3, "fixed": 3, "skipped": 0}
    lines = (tmp_path / "fixes" / "物理-卷A-试卷.jsonl").read_text(encoding="utf-8").splitlines()
    assert [ _json.loads(l)["group_order"] for l in lines] == [10, 11, 12]


def test_review_reentry_same_question_overwrites(tmp_path, monkeypatch):
    _prep_n(tmp_path, monkeypatch)
    fixes = tmp_path / "fixes"
    monkeypatch.setattr("sys.stdin", io.StringIO("第一版\nEOF\n\n"))
    manual_fix.review_pending(fixes_dir=fixes)

    # 再把同一题改回来（reset 状态后重跑）
    path = manual_fix.ISSUES_FILE
    rows = [_json.loads(l) for l in path.read_text(encoding="utf-8").splitlines()]
    rows[0]["status"] = "pending"
    path.write_text("".join(_json.dumps(r, ensure_ascii=False) + "\n" for r in rows),
                    encoding="utf-8")
    monkeypatch.setattr("sys.stdin", io.StringIO("第二版\nEOF\n\n"))
    manual_fix.review_pending(fixes_dir=fixes)

    lines = (fixes / "物理-卷A-试卷.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1, "同题号只能留一条"
    assert "第二版" in lines[0]


def test_review_skips_issue_without_md(tmp_path, monkeypatch):
    path = tmp_path / "issues.jsonl"
    path.write_text(_json.dumps({
        "source": "物理-卷A-试卷", "rel_path": "物理/初中/first/2024/卷A",
        "group_order": 5, "kind": "missing", "reasons": [], "md": None,
        "status": "pending"}, ensure_ascii=False) + "\n", encoding="utf-8")
    monkeypatch.setattr(manual_fix, "ISSUES_FILE", path)

    res = manual_fix.review_pending(fixes_dir=tmp_path / "fixes")
    assert res["skipped"] == 1 and res["fixed"] == 0


def test_review_list_only_does_not_touch_stdin(tmp_path, monkeypatch):
    path = _prep_n(tmp_path, monkeypatch, n=2)
    monkeypatch.setattr("sys.stdin", io.StringIO(""))
    res = manual_fix.review_pending(list_only=True)
    assert res["pending"] == 2 and res["fixed"] == 0
    assert all(_json.loads(l)["status"] == "pending"
               for l in path.read_text(encoding="utf-8").splitlines())


# ---------- 行尾标记 / 一次粘贴多题 ----------

def test_split_at_marker_accepts_trailing_marker_on_last_line():
    """`…</table> EOF` 这种写在行尾的标记也要认（粘贴最常见的落法）。"""
    body, done = manual_fix._split_at_marker("第一行\n最后一行 EOF\n")
    assert done is True
    assert body == "第一行\n最后一行"


def test_ask_splits_multi_question_paste_into_records(tmp_path, monkeypatch):
    """一次粘贴里带 27、28 两个题号 → 两条记录，各留各的题号。"""
    path = _prep_n(tmp_path, monkeypatch)
    issue = _json.loads(path.read_text(encoding="utf-8").splitlines()[0])
    monkeypatch.setattr("sys.stdin", io.StringIO(
        "27. 甲题题干\n(1) 小问\n28. 乙题题干\n(1) 小问\nEOF\n\n答案甲\n答案乙\n"))

    recs = manual_fix._ask(issue, tmp_path)

    assert [r["group_order"] for r in recs] == [27, 28]
    assert recs[0]["content"].startswith("甲题题干")
    assert recs[1]["content"].startswith("乙题题干")
    assert [r["answer"] for r in recs] == ["答案甲", "答案乙"]


def test_review_writes_all_records_from_one_paste(tmp_path, monkeypatch):
    path = _prep_n(tmp_path, monkeypatch, n=2)   # 题 10、11 都待补
    monkeypatch.setattr("sys.stdin", io.StringIO(
        "10. 甲题正文\n11. 乙题正文\nEOF\n\n\n\n"))                                # 第二条 issue 已被顺带解决，再遇就跳过

    res = manual_fix.review_pending(fixes_dir=tmp_path / "fixes")

    lines = (tmp_path / "fixes" / "物理-卷A-试卷.jsonl").read_text(encoding="utf-8").splitlines()
    assert [ _json.loads(l)["group_order"] for l in lines] == [10, 11]
    # 两条 issue 都因这次粘贴而收口，不再重复询问
    statuses = [_json.loads(l)["status"] for l in path.read_text(encoding="utf-8").splitlines()]
    assert statuses == ["recorded", "recorded"]
    assert res["fixed"] == 2 and res["skipped"] == 0, "已收口的题不该再问一遍"


# ---------- 逐题引导（先修被吞的题，再补缺的题） ----------

def _prep_pair(tmp_path, monkeypatch):
    """造一条「题 28 缺失，疑被题 27 吸收」的 issue。"""
    md_dir = tmp_path / "md" / "物理" / "初中" / "first" / "2024" / "卷A"
    md_dir.mkdir(parents=True, exist_ok=True)
    (md_dir / "卷A.md").write_text("", encoding="utf-8")
    issue = {"source": "物理-卷A-试卷", "rel_path": "物理/初中/first/2024/卷A",
             "group_order": 28, "kind": "missing", "reasons": ["missing_stem"],
             "suspect_group_order": 27, "excerpt": "",
             "pdf": None, "md": str(md_dir / "卷A.md"), "status": "pending"}
    path = tmp_path / "issues.jsonl"
    path.write_text(_json.dumps(issue, ensure_ascii=False) + "\n", encoding="utf-8")
    monkeypatch.setattr(manual_fix, "ISSUES_FILE", path)
    return issue, path


def test_targets_puts_suspect_first():
    issue = {"group_order": 28, "suspect_group_order": 27}
    assert [no for no, _ in manual_fix._targets(issue)] == [27, 28]


def test_targets_single_when_no_suspect():
    issue = {"group_order": 28, "suspect_group_order": None}
    assert [no for no, _ in manual_fix._targets(issue)] == [28]


def test_ask_guides_two_questions_one_at_a_time(tmp_path, monkeypatch, capsys):
    """先录 27（改短）、再录 28（补缺），两块输入各以 EOF 结束。"""
    issue, _ = _prep_pair(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.stdin", io.StringIO(
        "27 题改短后的正文\nEOF\n\n\n"      # 正文 + 确认 + 答案留空
        "28 题补出来的正文\nEOF\n\n\n"))    # 题 28 正文 + 答案留空

    recs = manual_fix._ask(issue, tmp_path)

    assert [r["group_order"] for r in recs] == [27, 28]
    assert recs[0]["content"] == "27 题改短后的正文"
    assert recs[1]["content"] == "28 题补出来的正文"
    out = capsys.readouterr().out
    assert "第 1/2 步" in out and "录入第 27 题" in out
    assert "第 2/2 步" in out and "录入第 28 题" in out


def test_ask_skipping_first_still_prompts_second(tmp_path, monkeypatch, capsys):
    issue, _ = _prep_pair(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.stdin", io.StringIO("s\n28 题正文\nEOF\n\n"))

    recs = manual_fix._ask(issue, tmp_path)

    assert [r["group_order"] for r in recs] == [28]
    assert "第 27 题未录入" in capsys.readouterr().out


def test_review_pair_records_both_numbers(tmp_path, monkeypatch):
    issue, path = _prep_pair(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.stdin", io.StringIO(
        "27 正文\nEOF\n\n\n28 正文\nEOF\n\n\n"))

    res = manual_fix.review_pending(fixes_dir=tmp_path / "fixes")

    lines = (tmp_path / "fixes" / "物理-卷A-试卷.jsonl").read_text(encoding="utf-8").splitlines()
    assert [_json.loads(l)["group_order"] for l in lines] == [27, 28]
    assert res["fixed"] == 2
    assert _json.loads(path.read_text(encoding="utf-8"))["status"] == "recorded"


# ---------- 界面文字被误当题目时的拦截 ----------

def test_looks_like_ui_echo_detects_pasted_terminal_output():
    bad = ("1\n" + "─" * 40 + "\n"
           "请提供真题：1) 直接粘贴 Markdown（结束输入 EOF）\n"
           "             s) 跳过   q) 退出")
    assert manual_fix.looks_like_ui_echo(bad) is True


def test_looks_like_ui_echo_accepts_real_question():
    good = ("3. 如图所示，电源两端电压保持不变，闭合开关后电流表示数为 0.3A，\n"
            "(1) 求电阻 R 的阻值；\n(2) 若将滑片向右移动，电流表示数如何变化？")
    assert manual_fix.looks_like_ui_echo(good) is False


def test_collect_content_rejects_echo_then_accepts_next_input(tmp_path, monkeypatch, capsys):
    """粘错一次（连界面一起粘）要被拒收并重新提示，而不是直接存下来。"""
    bad = "1\n" + "─" * 30 + "\n请提供真题：1) 直接粘贴 Markdown（结束输入 EOF）\ns) 跳过   q) 退出\nEOF\n"
    good = "27. 题目正文内容\nEOF\n"
    monkeypatch.setattr("sys.stdin", io.StringIO(bad + good))

    text = manual_fix._collect_content(tmp_path)

    assert text.startswith("27. 题目正文内容")
    assert "拒收" in capsys.readouterr().out


def test_answer_containing_ui_text_is_cleared(tmp_path, monkeypatch):
    issue, _ = _prep_pair(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.stdin", io.StringIO(
        "27 题正文\nEOF\n\ns) 跳过   q) 退出\n"        # 答案位置混进界面文字
        "28 题正文\nEOF\n\n\n"))

    recs = manual_fix._ask(issue, tmp_path)

    assert recs[0]["answer"] == "", "界面文字不能当答案"


# ---------- 状态流转：recorded → resolved 只在写库后发生 ----------

def test_mark_issue_moves_all_kinds_of_same_question(tmp_path, monkeypatch):
    path = tmp_path / "issues.jsonl"
    path.write_text("".join(_json.dumps(r, ensure_ascii=False) + "\n" for r in [
        {"source": "卷A", "group_order": 18, "kind": "missing", "status": "recorded"},
        {"source": "卷A", "group_order": 18, "kind": "punct_stem", "status": "recorded"},
        {"source": "卷A", "group_order": 19, "kind": "missing", "status": "pending"},
    ]), encoding="utf-8")
    monkeypatch.setattr(manual_fix, "ISSUES_FILE", path)

    changed = manual_fix.mark_issue("卷A", 18, "resolved", note="已写入题库",
                                    fix_file="/tmp/x.jsonl")

    rows = [_json.loads(l) for l in path.read_text(encoding="utf-8").splitlines()]
    assert changed == 2
    assert [r["status"] for r in rows] == ["resolved", "resolved", "pending"]
    assert rows[0]["note"] == "已写入题库" and rows[0]["fix_file"] == "/tmp/x.jsonl"
    assert rows[0]["resolved_at"]
    assert "resolved_at" not in rows[2]


def test_mark_issue_reopen_clears_resolved_marks(tmp_path, monkeypatch):
    path = tmp_path / "issues.jsonl"
    path.write_text(_json.dumps({"source": "卷A", "group_order": 7, "kind": "missing",
                                 "status": "resolved", "resolved_at": "2026-10-31T13:00:00",
                                 "fix_file": "/old.jsonl"}, ensure_ascii=False) + "\n",
                    encoding="utf-8")
    monkeypatch.setattr(manual_fix, "ISSUES_FILE", path)

    manual_fix.mark_issue("卷A", 7, "pending", note="补录内容被拒，请重新补录")

    row = _json.loads(path.read_text(encoding="utf-8"))
    assert row["status"] == "pending"
    assert "resolved_at" not in row
    assert row["note"].startswith("补录内容被拒")


# ---------- 输入方式菜单（1/2/3）与预览确认 ----------

def test_menu_digit_is_not_part_of_content(tmp_path, monkeypatch):
    """输入 1 选「粘贴文本」时，1 不能被写进题目（这正是上一轮污染的来源）。"""
    monkeypatch.setattr("sys.stdin", io.StringIO("1\n27. 正文\nEOF\n\n\n"))

    text = manual_fix._collect_content(tmp_path)

    assert text == "27. 正文"


def test_menu_3_reads_local_file(tmp_path, monkeypatch):
    src = tmp_path / "q.md"
    src.write_text("从文件读到的正文", encoding="utf-8")
    monkeypatch.setattr("sys.stdin", io.StringIO(f"3\n{src}\n\n"))

    assert manual_fix._collect_content(tmp_path) == "从文件读到的正文"


def test_menu_2_missing_image_reports_and_reprompts(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr("sys.stdin", io.StringIO("2\n/不存在/x.png\n1\n正文\nEOF\n\n\n"))

    assert manual_fix._collect_content(tmp_path) == "正文"
    assert "找不到文件" in capsys.readouterr().out


def test_confirm_redo_discards_previous_text(tmp_path, monkeypatch):
    """粘错了按 r 重输：上一版不能残留。"""
    monkeypatch.setattr("sys.stdin", io.StringIO(
        "第一版糊了\nEOF\nr\n第二版正确\nEOF\n\n\n"))

    assert manual_fix._collect_content(tmp_path) == "第二版正确"


def test_confirm_edit_uses_editor(tmp_path, monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO("原始内容\nEOF\ne\n\n\n"))
    monkeypatch.setattr(manual_fix, "_edit_in_editor", lambda text: "编辑器改过的内容")

    assert manual_fix._collect_content(tmp_path) == "编辑器改过的内容"


def test_confirm_edit_without_editor_keeps_original(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr("sys.stdin", io.StringIO("原始内容\nEOF\ne\n\n\n"))
    monkeypatch.setattr(manual_fix, "_edit_in_editor", lambda text: None)

    assert manual_fix._collect_content(tmp_path) == "原始内容"
    assert "没找到可用的编辑器" in capsys.readouterr().out


def test_confirm_skip_returns_none(tmp_path, monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO("要丢掉的内容\nEOF\ns\n"))

    assert manual_fix._collect_content(tmp_path) is None


def test_editor_command_prefers_env(monkeypatch):
    monkeypatch.setenv("EDITOR", "my-editor --wait")
    assert manual_fix._editor_command() == ["my-editor", "--wait"]
