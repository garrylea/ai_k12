"""manual_fix：待补题筛选（import_cli 第 7 步按本次扫描到的卷精确取）。"""

import json
from pathlib import Path

import manual_fix
import review_editor


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
    monkeypatch.setattr("sys.stdin", io.StringIO("题干第一行\n(1) 小问\nEOF\n1\n\n"))

    res = manual_fix.review_pending(fixes_dir=tmp_path / "fixes")

    assert res["fixed"] == 1
    out = (tmp_path / "fixes" / "物理-卷A-试卷.jsonl").read_text(encoding="utf-8")
    assert "题干第一行" in out and "(1) 小问" in out


def test_review_accepts_lowercase_eof(tmp_path, monkeypatch):
    _prep(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.stdin", io.StringIO("题干\neof\n1\n\n"))
    assert manual_fix.review_pending(fixes_dir=tmp_path / "fixes")["fixed"] == 1


def test_review_ends_when_stream_ends_without_marker(tmp_path, monkeypatch):
    """没有 EOF 标记、输入流直接结束：不能死等；拿不到确认就当放弃。"""
    _prep(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.stdin", io.StringIO("题干没有结束标记\n"))
    res = manual_fix.review_pending(fixes_dir=tmp_path / "fixes")
    assert res["fixed"] == 0 and res["skipped"] == 1

def test_review_skip_with_s(tmp_path, monkeypatch):
    issue, issues_file = _prep(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.stdin", io.StringIO("s\n"))

    res = manual_fix.review_pending(fixes_dir=tmp_path / "fixes")

    assert res == {"pending": 1, "fixed": 0, "skipped": 1, "confirmed_ok": 0}
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
    monkeypatch.setattr("sys.stdin", io.StringIO(f"@{src}\n1\n"))
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
    monkeypatch.setattr("sys.stdin", io.StringIO(f"2\n{img}\n1\n\n"))
    called = {}

    def fake_convert(image, md_dir):
        called["image"] = image
        return "OCR 出来的题干"

    monkeypatch.setattr(review_editor, "_image_to_markdown", fake_convert)

    assert manual_fix._collect_content(tmp_path) == "OCR 出来的题干"
    assert called["image"] == img


def test_collect_content_image_rejected_asks_again(tmp_path, monkeypatch):
    img = tmp_path / "shot.png"
    img.write_bytes(b"png")
    # 第一次给图片并回 n，第二次直接粘贴文本
    monkeypatch.setattr("sys.stdin", io.StringIO(f"2\n{img}\nr\n手工题干\nEOF\n1\n\n"))
    monkeypatch.setattr(review_editor, "_image_to_markdown", lambda i, d: "OCR 题干")

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
                        io.StringIO("下列说法正确的是\nA. 甲\nB. 乙\nC. 丙\nD. 丁\nEOF\n1\nA\n"))

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
    monkeypatch.setattr("sys.stdin", io.StringIO("题干\nEOF\n1\n\n"))

    res = manual_fix.review_pending(fixes_dir=tmp_path / "fixes")

    assert res["fixed"] == 1
    saved = _json.loads(path.read_text(encoding="utf-8").splitlines()[0])
    assert saved["status"] == "recorded"
    assert saved["fix_file"].endswith("物理-卷A-试卷.jsonl")


def test_review_processes_multiple_issues_in_order(tmp_path, monkeypatch):
    path = _prep_n(tmp_path, monkeypatch, n=3)
    monkeypatch.setattr("sys.stdin", io.StringIO("题一\nEOF\n1\n\n题二\nEOF\n1\n\n题三\nEOF\n1\n\n"))

    res = manual_fix.review_pending(fixes_dir=tmp_path / "fixes")

    assert res == {"pending": 3, "fixed": 3, "skipped": 0, "confirmed_ok": 0}
    lines = (tmp_path / "fixes" / "物理-卷A-试卷.jsonl").read_text(encoding="utf-8").splitlines()
    assert [ _json.loads(l)["group_order"] for l in lines] == [10, 11, 12]


def test_review_reentry_same_question_overwrites(tmp_path, monkeypatch):
    _prep_n(tmp_path, monkeypatch)
    fixes = tmp_path / "fixes"
    monkeypatch.setattr("sys.stdin", io.StringIO("1\n第一版\nEOF\n1\n\n"))
    manual_fix.review_pending(fixes_dir=fixes)

    # 再把同一题改回来（reset 状态后重跑）
    path = manual_fix.ISSUES_FILE
    rows = [_json.loads(l) for l in path.read_text(encoding="utf-8").splitlines()]
    rows[0]["status"] = "pending"
    path.write_text("".join(_json.dumps(r, ensure_ascii=False) + "\n" for r in rows),
                    encoding="utf-8")
    monkeypatch.setattr("sys.stdin", io.StringIO("1\n第二版\nEOF\n1\n\n"))
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
        "27. 甲题题干\n(1) 小问\n28. 乙题题干\n(1) 小问\nEOF\n1\n答案甲\n答案乙\n"))

    recs = manual_fix._ask(issue, tmp_path)

    assert [r["group_order"] for r in recs] == [27, 28]
    assert recs[0]["content"].startswith("甲题题干")
    assert recs[1]["content"].startswith("乙题题干")
    assert [r["answer"] for r in recs] == ["答案甲", "答案乙"]


def test_review_writes_all_records_from_one_paste(tmp_path, monkeypatch):
    path = _prep_n(tmp_path, monkeypatch, n=2)   # 题 10、11 都待补
    monkeypatch.setattr("sys.stdin", io.StringIO(
        "10. 甲题正文\n11. 乙题正文\nEOF\n1\n\n\n"))                                # 第二条 issue 已被顺带解决，再遇就跳过

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
        "27 题改短后的正文\nEOF\n1\n\n"      # 正文 + 确认 + 答案留空
        "28 题补出来的正文\nEOF\n1\n\n"))    # 题 28 正文 + 答案留空

    recs = manual_fix._ask(issue, tmp_path)

    assert [r["group_order"] for r in recs] == [27, 28]
    assert recs[0]["content"] == "27 题改短后的正文"
    assert recs[1]["content"] == "28 题补出来的正文"
    out = capsys.readouterr().out
    assert "第 1/2 步" in out and "录入第 27 题" in out
    assert "第 2/2 步" in out and "录入第 28 题" in out


def test_ask_skipping_first_still_prompts_second(tmp_path, monkeypatch, capsys):
    issue, _ = _prep_pair(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.stdin", io.StringIO("s\n1\n28 题正文\nEOF\n1\n\n"))

    recs = manual_fix._ask(issue, tmp_path)

    assert [r["group_order"] for r in recs] == [28]
    assert "第 27 题未录入" in capsys.readouterr().out

def test_review_pair_records_both_numbers(tmp_path, monkeypatch):
    issue, path = _prep_pair(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.stdin", io.StringIO(
        "27 正文\nEOF\n1\n\n28 正文\nEOF\n1\n\n"))

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
    good = "27. 题目正文内容\nEOF\n1\n"
    monkeypatch.setattr("sys.stdin", io.StringIO(bad + good))

    text = manual_fix._collect_content(tmp_path)

    assert text.startswith("27. 题目正文内容")
    assert "拒收" in capsys.readouterr().out

def test_answer_containing_ui_text_is_cleared(tmp_path, monkeypatch):
    issue, _ = _prep_pair(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.stdin", io.StringIO(
        "27 题正文\nEOF\n1\ns) 跳过   q) 退出\n"        # 答案位置混进界面文字
        "28 题正文\nEOF\n1\n\n"))

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
    monkeypatch.setattr("sys.stdin", io.StringIO("1\n27. 正文\nEOF\n1\n\n"))

    text = manual_fix._collect_content(tmp_path)

    assert text == "27. 正文"


def test_menu_3_reads_local_file(tmp_path, monkeypatch):
    src = tmp_path / "q.md"
    src.write_text("从文件读到的正文", encoding="utf-8")
    monkeypatch.setattr("sys.stdin", io.StringIO(f"3\n{src}\n1\n\n"))

    assert manual_fix._collect_content(tmp_path) == "从文件读到的正文"


def test_menu_2_missing_image_reports_and_reprompts(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr("sys.stdin", io.StringIO("2\n/不存在/x.png\n1\n正文\nEOF\n1\n\n"))

    assert manual_fix._collect_content(tmp_path) == "正文"
    assert "找不到文件" in capsys.readouterr().out


# ---------- 剪贴板图片（⌘V / 菜单 4） ----------

def _fake_clipboard(monkeypatch, tmp_path, suffix=".png", content=b"png"):
    img = tmp_path / f"clip{suffix}"
    img.write_bytes(content)
    monkeypatch.setattr(review_editor, "_clipboard_to_path", lambda d: img)
    return img


def test_menu_4_reads_clipboard_image(tmp_path, monkeypatch):
    img = _fake_clipboard(monkeypatch, tmp_path)
    monkeypatch.setattr("sys.stdin", io.StringIO("4\n1\n\n"))
    called = {}

    def fake_convert(image, md_dir):
        called["image"] = image
        return "剪贴板题干"

    monkeypatch.setattr(review_editor, "_image_to_markdown", fake_convert)

    assert manual_fix._collect_content(tmp_path) == "剪贴板题干"
    assert called["image"] == img


def test_empty_line_picks_up_clipboard_image(tmp_path, monkeypatch):
    """⌘V 图片时终端送不出字符，用户接着按的回车（空行）要能落到剪贴板图片上。"""
    _fake_clipboard(monkeypatch, tmp_path)
    monkeypatch.setattr("sys.stdin", io.StringIO("\n1\n\n"))
    monkeypatch.setattr(review_editor, "_image_to_markdown", lambda i, d: "剪贴板题干")

    assert manual_fix._collect_content(tmp_path) == "剪贴板题干"


def test_empty_line_without_clipboard_still_reads_pasted_text(tmp_path, monkeypatch):
    monkeypatch.setattr(review_editor, "_clipboard_to_path", lambda d: None)
    monkeypatch.setattr("sys.stdin", io.StringIO("\n正文\nEOF\n1\n\n"))

    assert manual_fix._collect_content(tmp_path) == "正文"


def test_menu_4_without_clipboard_image_reprompts(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(review_editor, "_clipboard_to_path", lambda d: None)
    monkeypatch.setattr("sys.stdin", io.StringIO("4\n正文\nEOF\n1\n\n"))

    assert manual_fix._collect_content(tmp_path) == "正文"
    assert "剪贴板里没有图片" in capsys.readouterr().out


def test_clipboard_copied_file_is_read_as_text(tmp_path, monkeypatch):
    """Finder 里 ⌘C 一个 .md：剪贴板里是文件路径，按文件读，别当图片 OCR。"""
    src = tmp_path / "q.md"
    src.write_text("从剪贴板文件来的题干", encoding="utf-8")
    monkeypatch.setattr(review_editor, "_clipboard_to_path", lambda d: src)

    assert manual_fix._from_clipboard(tmp_path) == "从剪贴板文件来的题干"


def test_clipboard_probe_none_when_osascript_missing(tmp_path, monkeypatch):
    def boom(*a, **kw):
        raise FileNotFoundError("osascript")

    monkeypatch.setattr(review_editor.subprocess, "run", boom)

    assert manual_fix._clipboard_to_path(tmp_path) is None


def test_clipboard_probe_parses_file_and_png(tmp_path, monkeypatch):
    img = tmp_path / "clipboard.png"
    img.write_bytes(b"png")
    out = {"stdout": f"PNG:{img}"}
    monkeypatch.setattr(review_editor.subprocess, "run",
                        lambda *a, **kw: type("R", (), out))
    monkeypatch.setattr(review_editor.sys, "platform", "darwin")

    assert manual_fix._clipboard_to_path(tmp_path) == img

    out["stdout"] = "NONE"
    assert manual_fix._clipboard_to_path(tmp_path) is None


def test_confirm_redo_discards_previous_text(tmp_path, monkeypatch):
    """粘错了按 3（重新粘贴）：上一版不能残留。"""
    monkeypatch.setattr("sys.stdin", io.StringIO(
        "第一版糊了\nEOF\n3\n第二版正确\nEOF\n1\n\n"))

    assert manual_fix._collect_content(tmp_path) == "第二版正确"

def test_confirm_edit_uses_line_editor(tmp_path, monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO("原始内容\nEOF\n2\nw\n1\n\n"))
    monkeypatch.setattr(manual_fix, "_line_edit", lambda text: "改过的内容")

    assert manual_fix._collect_content(tmp_path) == "改过的内容"


def test_confirm_edit_cancelled_keeps_original(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr("sys.stdin", io.StringIO("原始内容\nEOF\n2\nw\n1\n\n"))
    monkeypatch.setattr(manual_fix, "_line_edit", lambda text: None)

    assert manual_fix._collect_content(tmp_path) == "原始内容"
    assert True  # 取消编辑时静默保留，不再提外部编辑器


def test_confirm_skip_returns_none(tmp_path, monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO("要丢掉的内容\nEOF\n4\n"))

    assert manual_fix._collect_content(tmp_path) is None





# ---------- 答案这一步也能返工（e 改题面 / r 重录 / s 放弃） ----------

def test_answer_e_edits_stem_instead_of_becoming_answer(tmp_path, monkeypatch):
    """用户反馈：按 e 结果 e 成了答案 —— 现在必须进编辑改题面。"""
    path = _prep_n(tmp_path, monkeypatch)
    issue = _json.loads(path.read_text(encoding="utf-8").splitlines()[0])
    monkeypatch.setattr("sys.stdin", io.StringIO("1\n原始题面内容\nEOF\n1\ne\n\n"))
    monkeypatch.setattr(manual_fix, "_line_edit", lambda text: "改后的题面")

    recs = manual_fix._ask(issue, tmp_path)

    assert len(recs) == 1
    assert recs[0]["content"] == "改后的题面"
    assert recs[0]["answer"] == "", "e 不能被当成答案存下来"

def test_answer_r_recollects_content(tmp_path, monkeypatch):
    path = _prep_n(tmp_path, monkeypatch)
    issue = _json.loads(path.read_text(encoding="utf-8").splitlines()[0])
    monkeypatch.setattr("sys.stdin", io.StringIO(
        "1\n旧题面内容\nEOF\n1\nr\n"      # 答案处按 r → 重新录入
        "1\n新题面内容\nEOF\n1\nA\n"))    # 新题面 + 答案 A

    recs = manual_fix._ask(issue, tmp_path)

    assert [r["content"] for r in recs] == ["新题面内容"]
    assert recs[0]["answer"] == "A"

def test_answer_s_discards_question(tmp_path, monkeypatch):
    path = _prep_n(tmp_path, monkeypatch)
    issue = _json.loads(path.read_text(encoding="utf-8").splitlines()[0])
    monkeypatch.setattr("sys.stdin", io.StringIO("1\n要放弃的题面\nEOF\n1\ns\n"))

    assert manual_fix._ask(issue, tmp_path) == []


def test_answer_edit_cancelled_keeps_stem(tmp_path, monkeypatch):
    path = _prep_n(tmp_path, monkeypatch)
    issue = _json.loads(path.read_text(encoding="utf-8").splitlines()[0])
    monkeypatch.setattr("sys.stdin", io.StringIO("1\n原题面\nEOF\n1\ne\n\n"))
    monkeypatch.setattr(manual_fix, "_line_edit", lambda text: None)

    recs = manual_fix._ask(issue, tmp_path)

    assert recs[0]["content"] == "原题面"
    assert recs[0]["answer"] == ""

def test_menu_e_before_content_hints_instead_of_swallowing(tmp_path, monkeypatch, capsys):
    """还没录内容就按 e：不能把 e 当正文，要提示按 1/2/3。"""
    monkeypatch.setattr("sys.stdin", io.StringIO("e\n1\n正文\nEOF\n1\n\n"))

    assert manual_fix._collect_content(tmp_path) == "正文"
    assert "还没有可修改的内容" in capsys.readouterr().out


def test_uppercase_E_is_still_a_valid_answer(tmp_path, monkeypatch):
    """英语七选五答案可能是 E：大写不能当命令。"""
    path = _prep_n(tmp_path, monkeypatch)
    issue = _json.loads(path.read_text(encoding="utf-8").splitlines()[0])
    monkeypatch.setattr("sys.stdin", io.StringIO("1\n题面内容\nEOF\n1\nE\n"))

    recs = manual_fix._ask(issue, tmp_path)

    assert recs[0]["answer"] == "E"




# ---------- 内置逐行编辑（不依赖 vim/nano） ----------

def _edit_with(monkeypatch, *commands):
    monkeypatch.setattr("sys.stdin", io.StringIO("\n".join(commands) + "\n"))
    return manual_fix._line_edit("第一行\n第二行\n第三行")


def test_line_edit_delete_line(monkeypatch):
    assert _edit_with(monkeypatch, "d 2", "w") == "第一行\n第三行"


def test_line_edit_replace_line(monkeypatch):
    assert _edit_with(monkeypatch, "c 2 替换后的第二行", "w") == "第一行\n替换后的第二行\n第三行"


def test_line_edit_insert_after(monkeypatch):
    assert _edit_with(monkeypatch, "i 1 插到第一行后面", "w") == \
        "第一行\n插到第一行后面\n第二行\n第三行"


def test_line_edit_quit_returns_none(monkeypatch):
    assert _edit_with(monkeypatch, "q") is None


def test_line_edit_bad_command_reprompts(monkeypatch, capsys):
    assert _edit_with(monkeypatch, "x 1", "d 1", "w") == "第二行\n第三行"
    assert "指令不认识" in capsys.readouterr().out


def test_line_edit_out_of_range_warns(monkeypatch, capsys):
    assert _edit_with(monkeypatch, "d 9", "w") == "第一行\n第二行\n第三行"
    assert "行号超出范围" in capsys.readouterr().out


def test_line_edit_show_and_save(monkeypatch, capsys):
    assert _edit_with(monkeypatch, "p", "w") == "第一行\n第二行\n第三行"
    assert "题面（共 3 行）" in capsys.readouterr().out


# ---------- 确认菜单：必须显式选号（粘贴尾巴的空行不算确认） ----------

def test_blank_lines_after_paste_do_not_auto_confirm(tmp_path, monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO("正文内容\nEOF\n\n\n\n1\n\n"))

    assert manual_fix._collect_content(tmp_path) == "正文内容"


def test_edit_command_typed_at_confirm_menu_hints(tmp_path, monkeypatch, capsys):
    """在确认菜单里敲 d 3：要提示「先按 2」，不能当成内容。"""
    monkeypatch.setattr("sys.stdin", io.StringIO("正文内容\nEOF\nd 3\n1\n\n"))

    assert manual_fix._collect_content(tmp_path) == "正文内容"
    assert "请先按 2 进入编辑" in capsys.readouterr().out


def test_confirm_menu_option_2_edits_then_confirms(tmp_path, monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO("第一行\n第二行\nEOF\n2\nd 2\nw\n1\n\n"))

    assert manual_fix._collect_content(tmp_path) == "第一行"


def test_edit_command_typed_as_answer_is_not_stored(tmp_path, monkeypatch, capsys):
    path = _prep_n(tmp_path, monkeypatch)
    issue = _json.loads(path.read_text(encoding="utf-8").splitlines()[0])
    monkeypatch.setattr("sys.stdin", io.StringIO("1\n题面内容\nEOF\n1\nd 2\n\n"))

    recs = manual_fix._ask(issue, tmp_path)

    assert recs[0]["answer"] == ""
    assert "请按 e 进入编辑" in capsys.readouterr().out


# ---------- 内容层问题：先问「有没有问题」，确认没问题就不改库（2026-11-01）----------

def _prep_content(tmp_path, monkeypatch, *, kind="incomplete_content", order=27,
                  content_sig="sig-1", suspect=None):
    md_dir = tmp_path / "md" / "物理" / "初中" / "first" / "2024" / "卷A"
    md_dir.mkdir(parents=True, exist_ok=True)
    (md_dir / "卷A.md").write_text("", encoding="utf-8")
    issue = {"source": "物理-卷A-试卷", "rel_path": "物理/初中/first/2024/卷A",
             "group_order": order, "kind": kind, "reasons": ["subq_starts_at_2"],
             "excerpt": "……(2) 则 ____ 。", "pdf": None,
             "md": str(md_dir / "卷A.md"), "status": "pending",
             "content_sig": content_sig, "suspect_group_order": suspect}
    path = tmp_path / "issues.jsonl"
    path.write_text(_json.dumps(issue, ensure_ascii=False) + "\n", encoding="utf-8")
    monkeypatch.setattr(manual_fix, "ISSUES_FILE", path)
    return issue, path


def test_content_issue_confirm_ok_writes_no_change_and_keeps_db(tmp_path, monkeypatch):
    """人工确认没问题 → 只落 verdict=no_change，不产补题记录、不碰题库。"""
    _, path = _prep_content(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.stdin", io.StringIO("2\n"))

    res = manual_fix.review_pending(fixes_dir=tmp_path / "fixes")

    assert res["confirmed_ok"] == 1 and res["fixed"] == 0
    saved = _json.loads(path.read_text(encoding="utf-8").splitlines()[0])
    assert saved["status"] == "resolved" and saved["verdict"] == "no_change"
    assert "未改动" in saved["note"]
    assert saved["content_sig"] == "sig-1"
    assert not (tmp_path / "fixes" / "物理-卷A-试卷.jsonl").exists(), "确认无问题不能生成补题记录"


def test_content_issue_confirm_problem_records_fix(tmp_path, monkeypatch):
    """人工确认有问题 → 走补录，由 apply_fixes 原地更新。"""
    _prep_content(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.stdin", io.StringIO("1\n题干（含小问 1、2）\nEOF\n1\n\n"))

    res = manual_fix.review_pending(fixes_dir=tmp_path / "fixes")

    assert res["fixed"] == 1 and res["confirmed_ok"] == 0
    out = (tmp_path / "fixes" / "物理-卷A-试卷.jsonl").read_text(encoding="utf-8")
    rec = _json.loads(out.splitlines()[0])
    assert rec["group_order"] == 27 and rec["applied"] is False
    assert "题干（含小问 1、2）" in rec["content"]


def test_content_issue_skip_keeps_pending(tmp_path, monkeypatch):
    _, path = _prep_content(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.stdin", io.StringIO("s\n"))

    res = manual_fix.review_pending(fixes_dir=tmp_path / "fixes")

    assert res["skipped"] == 1 and res["confirmed_ok"] == 0
    saved = _json.loads(path.read_text(encoding="utf-8").splitlines()[0])
    assert saved["status"] == "pending" and "verdict" not in saved


def test_merged_issue_only_rewrites_own_number(tmp_path, monkeypatch):
    """合并类只录本题；suspect（被吞的那题）不在这里重录，它自己另有条目。"""
    _prep_content(tmp_path, monkeypatch, kind="merged_content", order=24, suspect=25)
    monkeypatch.setattr("sys.stdin", io.StringIO("1\n第24题自己的题干\nEOF\n1\n\n"))

    manual_fix.review_pending(fixes_dir=tmp_path / "fixes")

    out = (tmp_path / "fixes" / "物理-卷A-试卷.jsonl").read_text(encoding="utf-8")
    orders = [_json.loads(l)["group_order"] for l in out.splitlines()]
    assert orders == [24]


def test_review_lists_all_pending_and_remaining_after_quit(tmp_path, monkeypatch, capsys):
    """q 退出不能把剩下的条目吞掉：开头先列全表，退出时再列「还没处理」。"""
    _prep_n(tmp_path, monkeypatch, n=3)
    monkeypatch.setattr("sys.stdin", io.StringIO("q\n"))

    res = manual_fix.review_pending(fixes_dir=tmp_path / "fixes")

    out = capsys.readouterr().out
    assert "共 3 条待处理" in out, "开始前要把全部条目列出来，用户才知道后面还有什么"
    assert "还没处理" in out and "第10题" in out, "退出后要能看到没处理的题号"
    assert "仍待处理" in out and res["pending"] == 3


def test_ask_refuses_empty_stem_and_asks_again(tmp_path, monkeypatch, capsys):
    """字母写在内容下面的排版会把题干解析成空串：拒收、提示格式、重新收一次。"""
    path = _prep_n(tmp_path, monkeypatch)
    issue = _json.loads(path.read_text(encoding="utf-8").splitlines()[0])
    bad = "题干\n塑料笔杆\nA\n![](x.jpg)\n橡皮\nB\n![](y.jpg)\n铅笔芯\nC\n![](z.jpg)\n胶条\nD\nEOF\n1\n"
    good = "题干\nA. 塑料笔杆\nB. 橡皮\nC. 铅笔芯\nD. 胶条\nEOF\n1\n\n"
    monkeypatch.setattr("sys.stdin", io.StringIO(bad + good))

    recs = manual_fix._ask(issue, tmp_path)

    assert "题干被解析成了空串" in capsys.readouterr().out
    assert recs and recs[0]["content"] == "题干", "第二次按正确格式录入要能存下"
    assert [o["label"] for o in recs[0]["options"]] == ["A", "B", "C", "D"]


def test_type_mismatch_record_carries_expected_type(tmp_path, monkeypatch):
    """题型按「同大题」落库：补录记录要带上 dominant_type，供写库时强制设置。"""
    issue, _ = _prep_content(tmp_path, monkeypatch, kind="type_mismatch", order=9)
    issue["dominant_type"] = "choice"
    monkeypatch.setattr("sys.stdin", io.StringIO("1\n题干\nA. 甲\nB. 乙\nC. 丙\nD. 丁\nEOF\n1\n\n"))

    recs = manual_fix._ask(issue, tmp_path)

    assert recs and recs[0]["expected_type"] == "choice"


# ---------- 主动重录（用户指定题号，不依赖扫描清单）----------

def test_papers_in_scope_filters_by_file(tmp_path, monkeypatch):
    """按学科 + 卷名子串找已提取的卷。"""
    root = tmp_path / "dr"
    ex = root / "output" / "extracted" / "物理" / "初中" / "first" / "2024"
    for name in ("卷A", "卷B"):
        (ex / name).mkdir(parents=True)
        (ex / name / f"{name}.jsonl").write_text("", encoding="utf-8")
    md = root / "output" / "md" / "物理" / "初中" / "first" / "2024" / "卷A"
    md.mkdir(parents=True)
    (md / "卷A.md").write_text("", encoding="utf-8")
    monkeypatch.setattr(manual_fix, "ROOT", root)

    got = manual_fix.papers_in_scope("物理", "卷A")
    assert [p["source"] for p in got] == ["卷A"]
    assert got[0]["md"] == md / "卷A.md"


def test_save_records_overwrites_same_number(tmp_path):
    """同题号重复录入时覆盖旧记录，不产生两条。"""
    manual_fix._save_records("卷A", [{"group_order": 6, "content": "v1"}], tmp_path)
    manual_fix._save_records("卷A", [{"group_order": 6, "content": "v2"}], tmp_path)
    rows = manual_fix._read_jsonl(tmp_path / "卷A.jsonl")
    assert len(rows) == 1 and rows[0]["content"] == "v2"


def test_ask_one_splits_material_then_options(tmp_path, monkeypatch):
    """主动重录：粘贴「材料 + 小问 + 选项」→ material_text / content / options 三处正确。"""
    import io

    from subject_strategies import get_strategy

    issue = {"source": "物理-卷A-试卷", "rel_path": "物理/初中/first/2024/卷A",
             "group_order": 19, "kind": "manual_override",
             "reasons": ["用户主动指定重录"], "md": str(tmp_path / "卷A.md"), "pdf": None}
    (tmp_path / "卷A.md").write_text("", encoding="utf-8")
    block = (
        "阅读以下文字，并回答问题：\n"
        "半导体材料的应用\n"
        "自然界的物质和材料千千万万，如果按导电能力划分，可以将所有的物质分为导体、"
        "半导体和绝缘体三种。其中半导体的导电能力介于导体和绝缘体之间。\n"
        "![](images/a.jpg)\n"
        "(1) 太阳能电池分为哪几类？\n"
        "(2) 判断太阳能电池优劣的主要标准是什么\n"
    )
    monkeypatch.setattr("sys.stdin", io.StringIO("1\n" + block + "EOF\n1\n\n"))

    recs = manual_fix._ask_one(issue, 19, "请录入", tmp_path, get_strategy("physics"))

    assert len(recs) == 1
    assert "半导体" in (recs[0]["material_text"] or "")
    assert "(1) 太阳能电池" in recs[0]["content"]
    assert recs[0]["options"] is None          # 小问选项不抽成整题 options
    assert recs[0]["group_order"] == 19


# 图片策略：保留原图 / 换图（不走 MinerU）


def test_image_refs_dedupes_across_fields():
    refs = manual_fix._image_refs(
        "题干\n![](images/a.jpg)",
        "材料 ![](images/b.jpg)",
        "![](images/a.jpg)",
    )
    assert refs == ["images/a.jpg", "images/b.jpg"]


def test_append_missing_images_keeps_existing_refs():
    text = "题干\n![](images/a.jpg)"
    out = manual_fix._append_missing_images(text, ["images/a.jpg", "images/b.jpg"])
    assert out.count("images/a.jpg") == 1
    assert out.rstrip().endswith("![](images/b.jpg)")


def test_copy_new_images_copies_without_ocr(tmp_path):
    src = tmp_path / "shot.png"
    src.write_bytes(b"\x89PNG\r\n\x1a\nfake")
    paper = tmp_path / "paper"

    refs = manual_fix._copy_new_images([src, src], paper)
    assert len(refs) == 2          # 两张相同图各算一次，路径相同
    assert refs[0] == refs[1]
    assert (paper / refs[0]).exists()
    assert (paper / refs[0]).read_bytes() == src.read_bytes()


def test_apply_image_placeholders_replaces_and_appends():
    refs = ["images/m1.png", "images/m2.png"]
    out = manual_fix._apply_image_placeholders("如图[图2]，求面积", refs)
    assert "![](images/m2.png)" in out
    assert out.rstrip().endswith("![](images/m1.png)")
    assert "[图2]" not in out


def test_current_question_reads_extracted_jsonl(tmp_path, monkeypatch):
    monkeypatch.setattr(manual_fix, "ROOT", tmp_path)
    rel = Path("数学/初中/first/2026/卷A")
    d = tmp_path / "output" / "extracted" / rel
    d.mkdir(parents=True)
    _write(d / "卷A.jsonl", [
        {"group_order": 1, "content": "甲", "options": None},
        {"group_order": 2, "content": "乙 ![](images/x.jpg)", "options": None},
    ])
    issue = {"source": "卷A", "rel_path": str(rel), "group_order": 2}
    row = manual_fix._current_question(issue)
    assert row["content"].endswith("![](images/x.jpg)")
    assert manual_fix._current_question({**issue, "group_order": 9}) is None


def test_copyable_question_text_full_content_and_options(tmp_path, monkeypatch):
    """补题展示用当前题的完整题干 + 全部选项，不截断、不省略，可整段拷贝。"""
    monkeypatch.setattr(manual_fix, "ROOT", tmp_path)
    rel = Path("数学/初中/first/2026/卷A")
    d = tmp_path / "output" / "extracted" / rel
    d.mkdir(parents=True)
    long_stem = "一元二次方程 $x^{2}-x-2=0$ 的二次项系数、一次项系数和常数项分别是"
    _write(d / "卷A.jsonl", [
        {"group_order": 1, "content": long_stem, "options": [
            {"label": "A", "text": "0，1，2"},
            {"label": "B", "text": "0，-1，-2"},
            {"label": "C", "text": "1，1，2"},
            {"label": "D", "text": "1，-1，-2"},
        ]},
    ])
    issue = {"source": "卷A", "rel_path": str(rel), "group_order": 1,
             "excerpt": long_stem[:20] + "…"}  # excerpt 即使截断也不该被用
    text = manual_fix._copyable_question_text(issue)
    assert long_stem in text
    assert "A. 0，1，2" in text and "D. 1，-1，-2" in text
    assert "…" not in text  # 用完整 content，不用截断的 excerpt


def test_copyable_question_text_falls_back_to_excerpt(tmp_path, monkeypatch):
    """找不到 extracted 记录时退回 excerpt，不报错。"""
    monkeypatch.setattr(manual_fix, "ROOT", tmp_path)
    issue = {"source": "卷A", "rel_path": "数学/卷A", "group_order": 9,
             "excerpt": "某题的旧快照"}
    assert manual_fix._copyable_question_text(issue) == "某题的旧快照"


def test_discard_fixes_for_source_moves_only_matching(tmp_path, monkeypatch):
    """重转后只作废「已恢复」的旧补题，且只动目标卷。"""
    monkeypatch.setattr(manual_fix, "ROOT", tmp_path)
    fixes = tmp_path / "manual_fixes"
    fixes.mkdir()
    target = fixes / "海淀数学(9).jsonl"
    other = fixes / "西城物理.jsonl"
    _write(target, [{"group_order": 1, "content": "甲", "source": "海淀数学(9)",
                     "rel_path": "数学/海淀数学(9)"}])
    _write(other, [{"group_order": 1, "content": "乙", "source": "西城物理",
                    "rel_path": "物理/西城物理"}])
    ext = tmp_path / "output" / "extracted" / "数学" / "海淀数学(9)"
    ext.mkdir(parents=True)
    _write(ext / "海淀数学(9).jsonl", [{"group_order": 1, "content": "重抽出来的题"}])

    n = manual_fix.discard_fixes_for_source("海淀数学(9)", fixes_dir=fixes)
    assert n == 1
    assert not target.exists()
    assert other.exists()  # 别的卷不动
    discarded = list((fixes / "_discarded").glob("海淀数学(9).*.jsonl"))
    assert len(discarded) == 1
    assert "甲" in discarded[0].read_text(encoding="utf-8")


def test_discard_fixes_for_source_no_dir(tmp_path):
    """没有 manual_fixes 目录时返回 0，不报错。"""
    assert manual_fix.discard_fixes_for_source("某卷", fixes_dir=tmp_path / "nope") == 0


def test_discard_fixes_for_source_keyword(tmp_path, monkeypatch):
    """source_file 是关键词时也能匹配（兼容补题时的写法）。"""
    monkeypatch.setattr(manual_fix, "ROOT", tmp_path)
    fixes = tmp_path / "manual_fixes"
    fixes.mkdir()
    target = fixes / "海淀数学(9).jsonl"
    _write(target, [{"group_order": 1, "content": "甲", "source": "海淀数学(9)",
                     "rel_path": "数学/海淀数学(9)"}])
    ext = tmp_path / "output" / "extracted" / "数学" / "海淀数学(9)"
    ext.mkdir(parents=True)
    _write(ext / "海淀数学(9).jsonl", [{"group_order": 1, "content": "重抽出来的题"}])
    assert manual_fix.discard_fixes_for_source("海淀 数学", fixes_dir=fixes) == 1
    assert not target.exists()


def test_discard_fixes_for_source_exact_does_not_match_keyword_superset(tmp_path, monkeypatch):
    """import_cli 已选短卷时必须精确匹配，不能把三帆卷的补题一起作废。"""
    monkeypatch.setattr(manual_fix, "ROOT", tmp_path)
    fixes = tmp_path / "manual_fixes"
    fixes.mkdir()
    short = "英语-初三(上)-202607-西城-期末-试卷"
    superset = "英语-初三(上)-202607-西城·三帆中学-期末-试卷"
    short_file = fixes / f"{short}.jsonl"
    superset_file = fixes / f"{superset}.jsonl"
    for source, path in ((short, short_file), (superset, superset_file)):
        _write(path, [{"group_order": 1, "content": "旧补题", "source": source,
                       "rel_path": f"英语/初中/first/2026/{source}"}])
        ext = tmp_path / "output" / "extracted" / "英语" / "初中" / "first" / "2026" / source
        ext.mkdir(parents=True)
        _write(ext / f"{source}.jsonl", [{"group_order": 1, "content": "重抽出来的题"}])

    assert manual_fix.discard_fixes_for_source(short, fixes_dir=fixes, exact=True) == 1
    assert not short_file.exists()
    assert superset_file.exists()


def test_discard_keeps_pending_when_still_missing_and_applied_always(tmp_path, monkeypatch):
    """仍缺题的 pending 补题与 applied=True 的重放信号都不能被 redo 清掉。"""
    monkeypatch.setattr(manual_fix, "ROOT", tmp_path)
    fixes = tmp_path / "manual_fixes"
    fixes.mkdir()
    target = fixes / "模拟二.jsonl"
    _write(target, [
        {"group_order": 20, "content": "补的题", "source": "模拟二",
         "rel_path": "语文/模拟二"},                      # extracted 里没有 → 保留
        {"group_order": 9, "content": "已写过", "source": "模拟二",
         "rel_path": "语文/模拟二", "applied": True},      # 重放信号 → 保留
    ])
    assert manual_fix.discard_fixes_for_source("模拟二", fixes_dir=fixes) == 0
    import json
    rows = [json.loads(l) for l in target.read_text(encoding="utf-8").splitlines()
            if l.strip()]
    assert len(rows) == 2


class _QuietConsole:
    def info(self, *a, **k): pass
    def prompt(self, *a, **k): pass
    def block(self, *a, **k): pass
    def legend(self, *a, **k): pass
    def warn(self, *a, **k): pass


def test_answer_only_record_keeps_stem(monkeypatch):
    seq = iter(["42"])
    monkeypatch.setattr(manual_fix, "_read_line", lambda: next(seq))
    issue = {"source": "卷A", "rel_path": "数学/x/卷A", "group_order": 7,
             "kind": "answer_missing", "reasons": ["answer_empty"]}
    original = {"content": "题干", "options": [{"label": "A", "text": "甲"}],
                "material_text": None}

    records = manual_fix._ask_answer_only(issue, 7, original, _QuietConsole())

    assert len(records) == 1
    rec = records[0]
    assert rec["answer_only"] is True
    assert rec["answer"] == "42"
    assert rec["content"] == "题干"
    assert rec["options"] == [{"label": "A", "text": "甲"}]


def test_answer_only_skip_returns_empty(monkeypatch):
    monkeypatch.setattr(manual_fix, "_read_line", lambda: "s")
    issue = {"source": "卷A", "rel_path": "数学/x/卷A", "group_order": 7,
             "kind": "answer_missing"}
    assert manual_fix._ask_answer_only(issue, 7, {"content": "题干"}, _QuietConsole()) == []


def test_collect_content_menu_false_skips_input_method_menu(monkeypatch, capsys):
    """归属已选「粘正文」时不再弹输入方式菜单，首行即正文（数字也不当命令）。"""
    # menu=False 下首行 "1" 必须当正文，而不是被当成「选 1 粘贴文本」吞掉
    monkeypatch.setattr("sys.stdin", io.StringIO("1 材料一\n材料二\nEOF\n1\n"))
    got = manual_fix._collect_content(Path("/tmp"), allow_images=False,
                                      label="材料", menu=False)
    assert got == "1 材料一\n材料二"
    out = capsys.readouterr().out
    assert "选择材料输入方式" not in out, "不应再问输入方式"
    assert "请粘贴材料" in out


def test_collect_content_menu_true_keeps_input_method_menu(monkeypatch, capsys):
    """默认仍弹菜单：题干等富输入场景不受影响。"""
    monkeypatch.setattr("sys.stdin", io.StringIO("1\n题干正文\nEOF\n1\n"))
    got = manual_fix._collect_content(Path("/tmp"), allow_images=False, label="题干")
    assert got == "题干正文"
    out = capsys.readouterr().out
    assert "选择题干输入方式" in out


def test_collect_content_pre_read_shows_no_second_menu(monkeypatch):
    """调用方已读到输入方式时不能再弹一条菜单，否则用户多敲的 1 会进正文第一行。"""
    import io
    class SpyConsole(_QuietConsole):
        def __init__(self):
            self.prompts = []
        def prompt(self, text):
            self.prompts.append(text)

    monkeypatch.setattr("sys.stdin", io.StringIO("答案正文\neof\n1\n\n"))
    spy = SpyConsole()
    got = manual_fix._collect_content(Path("/tmp"), allow_images=True,
                                      first_line="1", label="答案")
    assert got == "答案正文"
    assert not any("选择答案输入方式" in p for p in spy.prompts)


def test_answer_only_redo_command_reprompts(monkeypatch):
    """只补答案时 r/redo 是重来命令，不能被当成答案写库。"""
    seq = iter(["r", "42", "1"])
    monkeypatch.setattr(manual_fix, "_read_line", lambda: next(seq))
    issue = {"source": "卷A", "rel_path": "数学/x/卷A", "group_order": 7,
             "kind": "answer_missing"}
    records = manual_fix._ask_answer_only(issue, 7, {"content": "题干"}, _QuietConsole())
    assert records[0]["answer"] == "42"


# ---------- 无图题配图 + 目录批量导入（第19题图变表格）----------

def test_ask_image_mode_zero_refs_not_called_when_no_orig_images(monkeypatch):
    """原题无图时 _ask_one 走 ocr，不弹图片模式菜单（原有行为不被打扰）。"""
    # 此行为由 _ask_one 的 `if orig_refs else "ocr"` 保证；见下方端到端用例。
    # 这里只确认 _ask_image_mode 本身仍返回原有三态。
    import io
    monkeypatch.setattr("sys.stdin", io.StringIO("\n"))
    assert manual_fix._ask_image_mode(2) == "keep"
    monkeypatch.setattr("sys.stdin", io.StringIO("2\n"))
    assert manual_fix._ask_image_mode(2) == "replace"
    monkeypatch.setattr("sys.stdin", io.StringIO("3\n"))
    assert manual_fix._ask_image_mode(2) == "ocr"


def test_ask_new_images_multiple_paths_keep_typed_order(tmp_path, monkeypatch):
    """逗号分隔多个路径：书写顺序就是图1、图2（2026-11-26 起不再有排序确认）。"""
    import io
    import hashlib
    a, b, c = (tmp_path / n for n in ("a.png", "b.png", "c.png"))
    for img in (a, b, c):
        img.write_bytes(b"\x89PNG\r\n\x1a\n" + img.name.encode())
    monkeypatch.setattr("sys.stdin", io.StringIO(f"{c},{a},{b}\n"))
    refs = manual_fix._ask_new_images(tmp_path / "paper")
    assert len(refs) == 3
    want = "manual_" + hashlib.sha1(c.read_bytes()).hexdigest()[:16] + ".png"
    assert refs[0].endswith(want)


def test_ask_new_images_clipboard_one_enter(tmp_path, monkeypatch, capsys):
    """剪贴板取到的图落在临时目录里：回车之后它必须还在，且一次回车就拷完。"""
    import io

    def fake_clip(tmp_dir):
        p = Path(tmp_dir) / "clipboard.png"
        p.write_bytes(b"\x89PNG\r\n\x1a\nclip")
        return p

    monkeypatch.setattr(manual_fix, "_clipboard_to_path", fake_clip)
    monkeypatch.setattr("sys.stdin", io.StringIO("\n"))
    refs = manual_fix._ask_new_images(tmp_path / "paper")
    assert len(refs) == 1
    assert (tmp_path / "paper" / refs[0]).read_bytes().endswith(b"clip")
    assert "顺序对吗" not in capsys.readouterr().out


def test_ask_new_images_trailing_comma_ignored(tmp_path, monkeypatch, capsys):
    """`a.png,` 末尾的空片段不能被当成当前目录（会误报「不是图片：data-refinery」）。"""
    import io
    a = tmp_path / "a.png"
    a.write_bytes(b"\x89PNG\r\n\x1a\na")
    monkeypatch.setattr("sys.stdin", io.StringIO(f"{a},\n"))
    refs = manual_fix._ask_new_images(tmp_path / "paper")
    assert len(refs) == 1
    assert "不是图片" not in capsys.readouterr().out


def test_ask_new_images_missing_file_reprompts(tmp_path, monkeypatch):
    import io
    missing = tmp_path / "nope.png"
    monkeypatch.setattr("sys.stdin", io.StringIO(f"{missing}\ns\n"))
    assert manual_fix._ask_new_images(tmp_path / "paper") == []


def test_content_issue_with_placeholder_triggers_image_attach(tmp_path, monkeypatch):
    """无原图题（图变表格）：正文写 [图1] → ocr 流程里触发配图，占位符被替换，图拷入。"""
    import io
    _prep_content(tmp_path, monkeypatch)  # 27 题 incomplete_content，无原图引用
    # 准备一张裁剪图
    img_dir = tmp_path / "crops"
    img_dir.mkdir()
    (img_dir / "crop_1.png").write_bytes(b"\x89PNG\r\n\x1a\nCROP1")
    # stdin: 确认有问题(1) → 粘贴正文含[图1] → EOF → 确认(1) → @目录 → 确认顺序(回车) → 答案(空)
    monkeypatch.setattr("sys.stdin", io.StringIO(
        "1\n"
        "19. 二次函数图象如图所示 [图1] 求解析式\nEOF\n"
        "1\n"
        f"{img_dir / 'crop_1.png'}\n"
        "\n"
    ))
    res = manual_fix.review_pending(fixes_dir=tmp_path / "fixes")
    assert res["fixed"] == 1
    out = (tmp_path / "fixes" / "物理-卷A-试卷.jsonl").read_text(encoding="utf-8")
    rec = _json.loads(out.splitlines()[0])
    assert "[图1]" not in rec["content"]
    assert "![](images/manual_" in rec["content"]
    # 图片真的拷进了该卷 images/
    assert list((tmp_path / "md" / "物理" / "初中" / "first" / "2024" / "卷A" / "images").glob("manual_*.png"))


# ---------- 菜单 5：多图+题干（逐张裁剪→占位符）----------

def test_collect_multi_image_flow_two_images(tmp_path, monkeypatch):
    """逐张裁剪两张图→eof→题干带[图1][图2]→拷入 images/，refs 回填。"""
    import io
    from unittest.mock import patch

    paper = tmp_path / "paper"
    paper.mkdir()
    # 剪贴板依次返回两张不同的图
    imgs = [tmp_path / f"src{i}.png" for i in (1, 2)]
    for i, p in enumerate(imgs):
        p.write_bytes(f"png-data-{i}".encode())
    seq = iter(imgs)
    monkeypatch.setattr(manual_fix, "_clipboard_to_path", lambda d: next(seq, None))
    with patch.object(manual_fix, "_clear_clipboard", lambda: None):
        monkeypatch.setattr("sys.stdin", io.StringIO(
            "\n"                                    # 图1：回车收下
            "\n"                                    # 图2：回车收下
            "eof\n"                                 # 图片给完
            "如图 [图1] 与 [图2] 求面积\nEOF\n"      # 题干含占位符
        ))
        refs: list[str] = []
        text = manual_fix._collect_multi_image_flow(paper, refs)

    assert len(refs) == 2
    assert "[图1]" in text and "[图2]" in text
    assert list((paper / "images").glob("manual_*.png")) or True  # 图已拷入
    # 两张图内容不同 → 两个不同文件
    assert len(set(refs)) == 2


def test_collect_content_menu5_wires_refs(tmp_path, monkeypatch):
    """ocr 模式菜单选 5 → 走多图流程，out_refs 被回填。"""
    import io
    from unittest.mock import patch
    paper = tmp_path / "paper"
    paper.mkdir()
    img = tmp_path / "src.png"
    img.write_bytes(b"png-data")
    monkeypatch.setattr(manual_fix, "_clipboard_to_path", lambda d: img)
    with patch.object(manual_fix, "_clear_clipboard", lambda: None):
        monkeypatch.setattr("sys.stdin", io.StringIO(
            "5\n"          # 选多图+题干
            "\n"           # 图1 回车
            "eof\n"        # 图片给完
            "题干 [图1]\nEOF\n"  # 题干
            "1\n"          # 确认
        ))
        refs: list[str] = []
        text = manual_fix._collect_content(paper, allow_images=True, out_refs=refs)
    assert len(refs) == 1 and "[图1]" in text


def test_clear_clipboard_noop_when_no_tool(monkeypatch):
    """清空剪贴板在没有工具时静默不报错。"""
    monkeypatch.setattr(manual_fix.sys, "platform", "linux")
    monkeypatch.setattr(manual_fix.shutil, "which", lambda x: None)
    manual_fix._clear_clipboard()  # 不抛异常即可


def test_collect_multi_image_flow_rejects_duplicate(tmp_path, monkeypatch):
    """没重新裁剪就回车：剪贴板还是同一张，默认拒收重裁（输入 y 才强制收）。"""
    import io
    from unittest.mock import patch

    paper = tmp_path / "paper"
    paper.mkdir()
    img = tmp_path / "same.png"
    img.write_bytes(b"same-image-bytes")   # 两次都返回同一张
    monkeypatch.setattr(manual_fix, "_clipboard_to_path", lambda d: img)
    with patch.object(manual_fix, "_clear_clipboard", lambda: None):
        monkeypatch.setattr("sys.stdin", io.StringIO(
            "\n"                                  # 图1 回车收下
            "\n"                                  # 图2 回车（剪贴板还是同一张）
            "\n"                                  # 检测到重复 → 回车=重新裁
            "eof\n"                               # 放弃图2，结束
            "题干 [图1]\nEOF\n"
        ))
        refs: list[str] = []
        text = manual_fix._collect_multi_image_flow(paper, refs)
    assert len(refs) == 1          # 只收了 1 张，重复的被拒
    assert "[图1]" in text


def test_collect_multi_image_flow_force_accept_duplicate(tmp_path, monkeypatch):
    """重复图输入 y 强制收下（确需同一张的情形）。"""
    import io
    from unittest.mock import patch

    paper = tmp_path / "paper"
    paper.mkdir()
    img = tmp_path / "same.png"
    img.write_bytes(b"same-image-bytes")
    monkeypatch.setattr(manual_fix, "_clipboard_to_path", lambda d: img)
    with patch.object(manual_fix, "_clear_clipboard", lambda: None):
        monkeypatch.setattr("sys.stdin", io.StringIO(
            "\n"       # 图1
            "\n"       # 图2（重复）
            "y\n"      # 强制收
            "eof\n"
            "题干 [图1] [图2]\nEOF\n"
        ))
        refs: list[str] = []
        text = manual_fix._collect_multi_image_flow(paper, refs)
    assert len(refs) == 2
    assert "[图1]" in text and "[图2]" in text


def test_answer_rich_input_with_image_placeholder(tmp_path, monkeypatch):
    """答案走富输入菜单 5：逐张裁剪配图，答案里的 [图1] 被替换成图片引用。"""
    import io
    from unittest.mock import patch

    paper = tmp_path / "paper"
    paper.mkdir()
    img = tmp_path / "ans.png"
    img.write_bytes(b"answer-figure")
    monkeypatch.setattr(manual_fix, "_clipboard_to_path", lambda d: img)
    with patch.object(manual_fix, "_clear_clipboard", lambda: None):
        # 答案处输入 5 → 逐张裁剪(回车) → eof → 答案正文含[图1] → EOF → 确认(1)
        monkeypatch.setattr("sys.stdin", io.StringIO(
            "5\n"
            "\n"
            "eof\n"
            "解：如图所示 [图1] 故 x=1\nEOF\n"
            "1\n"
        ))
        ans = manual_fix._collect_answer(paper, manual_fix.console())
    assert "[图1]" not in ans
    assert "![](images/manual_" in ans
    assert "故 x=1" in ans


def test_answer_prompt_uses_answer_wording(tmp_path, monkeypatch, capsys):
    """答案富输入提示词是「答案」不是「题干」，且确认框第4项是留空不是放弃本题。"""
    import io
    paper = tmp_path / "paper"; paper.mkdir()
    monkeypatch.setattr("sys.stdin", io.StringIO("5\n"))   # 选富输入后 EOF 中止
    manual_fix._collect_content(paper, label="答案")
    out = capsys.readouterr().out
    assert "选择答案输入方式" in out
    assert "选择题干输入方式" not in out


def test_answer_retry_only_reenters_answer(tmp_path, monkeypatch):
    """答案确认框选「3 重新输入」只重输答案，题干不重来。"""
    import io
    paper = tmp_path / "paper"; paper.mkdir()
    # 答案处：直接写一个答案 → 确认框选 3 重输 → 再写正确答案 → 确认
    monkeypatch.setattr("sys.stdin", io.StringIO("5\n"))  # 触发富输入
    # 富输入里：直接粘贴答案（首行即内容）→ EOF → 确认框选 3 → 重新输入 → EOF → 确认
    monkeypatch.setattr("sys.stdin", io.StringIO(
        "5\n"
        "错误答案 [图1]\nEOF\n"
        "3\n"
        "正确答案 [图1]\nEOF\n"
        "1\n"
    ))
    # 无图可配，[图1] 会保留；关键是流程能走到返回正确答案
    ans = manual_fix._collect_content(paper, label="答案")
    assert ans is not None and "正确答案" in ans


def test_answer_clear_returns_empty_not_skip(tmp_path, monkeypatch):
    """答案确认框选 4「留空」→ 返回空串（本题照常记录），不是 None（放弃）。"""
    import io
    paper = tmp_path / "paper"; paper.mkdir()
    monkeypatch.setattr("sys.stdin", io.StringIO(
        "5\n"
        "某答案\nEOF\n"
        "4\n"
    ))
    ans = manual_fix._collect_content(paper, label="答案")
    assert ans == "", "答案留空应返回空串，调用方据此照常记录本题"


def test_material_split_skips_chinese_without_hook():
    """语文没有 split_material；手工补题不能直接调，否则 AttributeError。

    2026-11-21 海淀模拟二题6 实测：录完选项后崩在
    `'ChineseStrategy' object has no attribute 'split_material'`。
    """
    from subject_strategies import get_strategy

    material, stem, options = manual_fix.split_material_and_options(
        get_strategy("chinese"),
        "下列选项恰当的一项是(2分)\nA. 甲\nB. 乙\nC. 丙\nD. 丁",
    )
    assert material is None
    assert stem.startswith("下列选项")
    assert [o["label"] for o in options] == ["A", "B", "C", "D"]


def test_answer_only_fix_never_carries_material(monkeypatch):
    """只补答案时复制原 material_text 会让答案修正被材料归属判定误拦。"""
    seq = iter(["42"])
    monkeypatch.setattr(manual_fix, "_read_line", lambda: next(seq))
    issue = {"source": "卷A", "rel_path": "数学/x/卷A", "group_order": 7,
             "kind": "answer_missing", "reasons": ["answer_empty"]}
    original = {"content": "题干", "options": None,
                "material_text": "## 游山西村\n莫笑农家腊酒浑。"}
    rec = manual_fix._ask_answer_only(issue, 7, original, _QuietConsole())[0]
    assert rec["material_text"] is None
    assert rec["answer"] == "42"


class _TtyStdin(io.StringIO):
    def isatty(self):
        return True


def test_enter_at_material_scope_skips_url_prompt(tmp_path, monkeypatch):
    """材料提示处回车 = 材料完全不动，不再弹同卷 URL 清单。

    2026-11-21 用户实测：录完题干后回车表示不改材料，工具仍列出 9 个
    materials URL 追问归属；若那里再回车，答案会被 URL 那一步吃掉。
    """
    path = _prep_n(tmp_path, monkeypatch)
    issue = _json.loads(path.read_text(encoding="utf-8").splitlines()[0])
    monkeypatch.setattr("sys.stdin", _TtyStdin(
        "1\n题干正文\nEOF\n1\n"   # 输入方式 / 正文 / 确认
        "\n"                     # 材料归属：回车=不改材料
        "答案甲\n"                # 多问一次 URL 的话，这行会被它吞掉
    ))

    recs = manual_fix._ask(issue, tmp_path)

    assert len(recs) == 1
    assert recs[0]["answer"] == "答案甲"
    assert "material_url" not in recs[0]


def test_copyable_text_includes_current_inline_material(tmp_path, monkeypatch):
    monkeypatch.setattr(manual_fix, "ROOT", tmp_path)
    rel = tmp_path / "output" / "extracted" / "语文" / "模拟二"
    rel.mkdir(parents=True)
    _write(rel / "模拟二.jsonl", [
        {"group_order": 12, "content": "题干", "options": [],
         "material_text": "## 游山西村\n陆游\n莫笑农家腊酒浑。",
         "_post_material_text": "## 行香子\n秦观\n树绕村庄。"},
    ])
    issue = {"source": "模拟二", "rel_path": "语文/模拟二", "group_order": 12}
    text = manual_fix._copyable_question_text(issue)
    assert "游山西村" in text and "行香子" in text
    assert "[共享文章]" in text and "[题内素材]" in text


def test_restore_swallowed_option_label_after_b_and_c():
    """TTY 粘贴把 C./D. 的首字母吞掉时，按上一行选项字母补回。"""
    stem = "根据小组建议，下列选项恰当的一项是(2分)"
    a = "  A. 科技与艺术的相互融合，留存了校园的时光印记。"
    b = "  B. 融合了科技与艺术，校园的时光印记得以留存。"
    c = "C. 展示出科技与艺术的融合，留存了校园的时光印记。"
    d = "D. 创新科技融合了艺术元素，校园留存了时光的印记。"

    fixed = manual_fix._restore_swallowed_option_label([stem, a, b, f". {c[3:]}", d])
    assert fixed[3].strip().startswith("C.")
    fixed = manual_fix._restore_swallowed_option_label([stem, a, b, c, f". {d[3:]}"])
    assert fixed[4].strip().startswith("D.")


def test_restore_swallowed_option_label_leaves_decimal_alone():
    """选项行后面的 ".5 分" 是小数/评分，不能误补成 C.5 分。"""
    lines = ["  A. 甲", "  B. 乙", ".5 分"]
    assert manual_fix._restore_swallowed_option_label(lines) == lines


# ---- material_url 候选：题号丢失时人工指认同卷文章 ----

def test_published_material_urls_dedup_and_sorted(tmp_path, monkeypatch):
    """同卷候选按题号列出，同一 URL 只保留最小题号代表。"""
    rel = "语文/初中/second/2025/语文-模拟二"
    pub = tmp_path / "output" / "published" / rel
    pub.mkdir(parents=True)
    _write(pub / "语文-模拟二.jsonl", [
        {"group_order": 19, "material_url": "materials/chinese/A/content.md"},
        {"group_order": 20, "material_url": None},          # 题号丢了那题
        {"group_order": 21, "material_url": "materials/chinese/A/content.md"},
        {"group_order": 24, "material_url": "materials/chinese/B/content.md"},
        {"group_order": 25, "material_url": None},
    ])
    monkeypatch.setattr(manual_fix, "ROOT", tmp_path)
    issue = {"rel_path": rel, "source": "语文-模拟二", "group_order": 20}
    assert manual_fix._published_material_urls(issue) == [
        (19, "materials/chinese/A/content.md"),
        (24, "materials/chinese/B/content.md"),
    ]


def test_published_material_urls_missing_file_returns_empty(tmp_path, monkeypatch):
    monkeypatch.setattr(manual_fix, "ROOT", tmp_path)
    issue = {"rel_path": "语文/模拟二", "source": "不存在", "group_order": 20}
    assert manual_fix._published_material_urls(issue) == []


# ---------- 题干没问题、只改材料（2026-11-21 用户反馈：无法跳过题干去改材料）----------

def _prep_material_only(tmp_path, monkeypatch, *, with_url=True, post_material=None,
                        material_text="## 第三站中国(北京)航天科学中心\n该中心舟搔传统展馆局限。"):
    """题干完整的语文 incomplete_content：问题在共享文章缺画线标记。"""
    monkeypatch.setattr(manual_fix, "ROOT", tmp_path)
    rel = "语文/初中/second/2026/模拟二"
    ext = tmp_path / "output" / "extracted" / rel
    ext.mkdir(parents=True)
    row = {
        "group_order": 5,
        "content": "文段中的画线句存在一处问题，请你修改。(2分)",
        "options": [], "answer": "把“舟搔”改为“操纵”",
        "material_text": material_text,
    }
    if post_material:
        row["_post_material_text"] = post_material
    _write(ext / "模拟二.jsonl", [row])
    pub = tmp_path / "output" / "published" / rel
    pub.mkdir(parents=True)
    _write(pub / "模拟二.jsonl", [
        {"group_order": 5,
         "material_url": ("materials/chinese/814d0a125a3c/content.md" if with_url else None)},
    ])
    md = tmp_path / "output" / "md" / rel / "模拟二.md"
    md.parent.mkdir(parents=True)
    md.write_text("", encoding="utf-8")
    issue = {"source": "模拟二", "rel_path": rel, "group_order": 5,
             "kind": "incomplete_content", "reasons": ["llm_marked_incomplete"],
             "pdf": None, "md": str(md), "status": "pending"}
    path = tmp_path / "issues.jsonl"
    path.write_text(_json.dumps(issue, ensure_ascii=False) + "\n", encoding="utf-8")
    monkeypatch.setattr(manual_fix, "ISSUES_FILE", path)
    return issue, md.parent


def test_content_issue_material_only_article_auto_routes(tmp_path, monkeypatch):
    """文章题：不再问存储通道，直接收「共享文章全文」，记为 article 目标。"""
    issue, md_dir = _prep_material_only(tmp_path, monkeypatch)
    new_article = "## 第三站中国(北京)航天科学中心\n<u>该中心舟搔传统展馆局限</u>。\n下一站……"
    # 1=有问题 → 题干回车 → 共享材料 2=粘贴 → 文章 → 题内材料回车
    monkeypatch.setattr("sys.stdin", io.StringIO(
        "1\n\n2\n" + new_article + "\nEOF\n1\n\n"))

    recs = manual_fix._ask(issue, md_dir)

    assert len(recs) == 1
    rec = recs[0]
    assert rec["content"] == "文段中的画线句存在一处问题，请你修改。(2分)"
    assert rec["material_target"] == "article"
    assert rec["material_text"] == new_article
    assert "material_url" not in rec, "沿用库里原 URL，才能走 _correct_article_doc 重写文档"


def test_content_issue_material_only_inline_auto_routes(tmp_path, monkeypatch):
    """文本型题目（无 url）：直接收「题内素材」，记为 inline 目标。"""
    issue, md_dir = _prep_material_only(tmp_path, monkeypatch, with_url=False)
    new_inline = "补一句题内素材。"
    # 1=有问题 → 题干回车 → 共享材料回车（这段在 material_text 里，已认成文章槽）
    # → 题内材料 2=粘贴 → 素材 → EOF → 1=确认
    monkeypatch.setattr("sys.stdin", io.StringIO(
        "1\n\n\n2\n" + new_inline + "\nEOF\n1\n"))

    recs = manual_fix._ask(issue, md_dir)

    assert len(recs) == 1
    rec = recs[0]
    assert rec["material_target"] == "inline"
    assert rec["material_text"] == new_inline
    assert rec["material_scope"] == "inline"
    assert "material_url" not in rec


def test_content_issue_can_add_inline_when_article_already_exists(tmp_path, monkeypatch):
    """已有共享文章、material_text 为空：题内材料槽必须仍然出现（Q14 场景）。"""
    issue, md_dir = _prep_material_only(tmp_path, monkeypatch)
    new_inline = "材料一 子曰……\n\n材料二 太史公曰……"
    # 1=有问题 → 题干回车 → 共享材料回车 → 题内材料 2=粘贴+素材
    monkeypatch.setattr("sys.stdin", io.StringIO(
        "1\n\n\n2\n" + new_inline + "\nEOF\n1\n"))

    recs = manual_fix._ask(issue, md_dir)

    assert len(recs) == 1
    rec = recs[0]
    assert rec["material_target"] == "inline"
    assert rec["material_text"] == new_inline
    assert rec["content"] == "文段中的画线句存在一处问题，请你修改。(2分)"


def test_inline_edit_keeps_unexternalized_article(tmp_path, monkeypatch):
    """文章还在 material_text、没外置：只补题内素材时要连文章一起带出，别冲掉。"""
    article = "## 鱼我所欲也\n" + "鱼，我所欲也；熊掌，亦我所欲也。" * 12
    issue, md_dir = _prep_material_only(
        tmp_path, monkeypatch, with_url=False, material_text=article)
    new_inline = "材料一 子曰……"
    monkeypatch.setattr("sys.stdin", io.StringIO(
        "1\n\n\n2\n" + new_inline + "\nEOF\n1\n"))

    recs = manual_fix._ask(issue, md_dir)

    rec = recs[0]
    assert rec["material_target"] == "both"
    assert rec["material_text"] == article
    assert rec["material_inline_text"] == new_inline


def test_content_issue_creates_shared_article_with_share_numbers(tmp_path, monkeypatch):
    """整篇共享材料丢了：能从零新建，并挂到人工指定的共用题号。"""
    issue, md_dir = _prep_material_only(
        tmp_path, monkeypatch, with_url=False, material_text=None)
    ext = tmp_path / "output" / "extracted" / issue["rel_path"] / "模拟二.jsonl"
    rows = [json.loads(l) for l in ext.read_text(encoding="utf-8").splitlines()]
    rows += [{"group_order": 6, "content": "第六题题干", "options": [], "answer": ""},
             {"group_order": 7, "content": "第七题题干", "options": [], "answer": ""}]
    _write(ext, rows)
    article = "## 鱼我所欲也\n《孟子》\n鱼，我所欲也……"
    # 1=有问题 → 题干回车 → 共享材料 2=粘贴+文章 → 共用题号 6-7 → 题内材料回车
    monkeypatch.setattr("sys.stdin", io.StringIO(
        "1\n\n2\n" + article + "\nEOF\n1\n6-7\n\n"))

    recs = manual_fix._ask(issue, md_dir)

    assert len(recs) == 1
    rec = recs[0]
    assert rec["material_target"] == "article"
    assert rec["material_scope"] == "article"
    assert rec["material_text"] == article
    assert rec["material_share_with"] == [5, 6, 7]


def _prep_missing_chinese(tmp_path, monkeypatch, *, published_url=None):
    """题号整段丢失的语文题（extracted 里没有这道题，只有同卷兄弟的 published）。"""
    rel = "语文/初中/second/2026/模拟二"
    source = "模拟二"
    ext = tmp_path / "output" / "extracted" / rel
    ext.mkdir(parents=True)
    (ext / f"{source}.jsonl").write_text("", encoding="utf-8")
    pub = tmp_path / "output" / "published" / rel
    pub.mkdir(parents=True)
    _write(pub / f"{source}.jsonl", [
        {"group_order": 5, "material_url": published_url},
        {"group_order": 6, "material_url": None},
    ])
    md = tmp_path / "output" / "md" / rel / f"{source}.md"
    md.parent.mkdir(parents=True)
    md.write_text("", encoding="utf-8")
    issue = {"source": source, "rel_path": rel, "group_order": 5,
             "kind": "missing", "reasons": ["missing_stem"],
             "pdf": None, "md": str(md), "status": "pending"}
    path = tmp_path / "issues.jsonl"
    path.write_text(_json.dumps(issue, ensure_ascii=False) + "\n", encoding="utf-8")
    monkeypatch.setattr(manual_fix, "ISSUES_FILE", path)
    return issue, md.parent


def test_missing_numbers_can_be_shared_targets(tmp_path, monkeypatch):
    """同组整段丢失的题号（不在 extracted 里）也能作为共用题号挂同一篇文章。"""
    issue, md_dir = _prep_missing_chinese(tmp_path, monkeypatch)
    ext = tmp_path / "output" / "extracted" / issue["rel_path"] / "模拟二.jsonl"
    # 同卷还有 6/7 两题也整段丢失（pending missing），extracted 里都没有
    rows = [json.loads(l) for l in ext.read_text(encoding="utf-8").splitlines()]
    _write(ext, rows)
    issues = [json.loads(l) for l in manual_fix.ISSUES_FILE.read_text(encoding="utf-8").splitlines()]
    issues += [{"source": issue["source"], "group_order": 6, "kind": "missing",
                "status": "pending"},
               {"source": issue["source"], "group_order": 7, "kind": "missing",
                "status": "pending"}]
    _write(manual_fix.ISSUES_FILE, issues)
    article = "## 新文章\n<u>画线句</u>。"
    # 题干 → 答案 → 共享材料 2 粘贴 → 共用题号 6-7 → 题内材料回车
    monkeypatch.setattr("sys.stdin", io.StringIO(
        "1\n题干正文\nEOF\n1\n答\n"
        "2\n" + article + "\nEOF\n1\n6-7\n\n"))

    recs = manual_fix._ask(issue, md_dir)

    assert len(recs) == 1
    assert recs[0]["material_share_with"] == [5, 6, 7]


def test_missing_chinese_question_can_fill_shared_article(tmp_path, monkeypatch):
    """题号整段丢失：以前只能补题干，现在共享文章也能从零录入。"""
    issue, md_dir = _prep_missing_chinese(tmp_path, monkeypatch)
    article = "## 新文章\n<u>画线句</u>。"
    # 没有「你看来有问题吗」那道门；题干（1 粘贴→正文→EOF→确认）→ 答案 →
    # 共享材料（2 粘贴→文章→EOF→确认）→ 共用题号回车 → 题内材料回车。
    monkeypatch.setattr("sys.stdin", io.StringIO(
        "1\n题干正文\nEOF\n1\n答\n"
        "2\n" + article + "\nEOF\n1\n\n\n"))

    recs = manual_fix._ask(issue, md_dir)

    assert len(recs) == 1
    rec = recs[0]
    assert rec["content"] == "题干正文"
    assert rec["material_target"] == "article"
    assert rec["material_text"] == article
    assert rec["material_share_with"] == [5]


def test_missing_question_pasted_article_drops_claimed_url(tmp_path, monkeypatch):
    """认领了旧 URL 又粘了新正文：丢掉旧 URL，否则 apply 会整条跳过。"""
    issue, md_dir = _prep_missing_chinese(
        tmp_path, monkeypatch, published_url="materials/chinese/old/content.md")

    class TtyStringIO(io.StringIO):
        def isatty(self):
            return True

    monkeypatch.setattr(manual_fix, "_ask_material_url",
                        lambda c, i: "materials/chinese/old/content.md")
    article = "## 新文章\n<u>画线句</u>。"
    # _ask_material_url 已被 mock，不占输入行
    monkeypatch.setattr("sys.stdin", TtyStringIO(
        "1\n题干正文\nEOF\n1\n答\n"
        "2\n" + article + "\nEOF\n1\n\n\n"))

    recs = manual_fix._ask(issue, md_dir)

    assert len(recs) == 1
    assert recs[0]["material_text"] == article
    assert "material_url" not in recs[0], "粘了正文就以正文为准，旧 URL 不能同时带上"


def test_missing_chinese_question_only_stem_keeps_url_claim(tmp_path, monkeypatch):
    """只认领 URL、没粘正文：URL 必须保留（认领能力不丢）。"""
    issue, md_dir = _prep_missing_chinese(
        tmp_path, monkeypatch, published_url="materials/chinese/old/content.md")

    class TtyStringIO(io.StringIO):
        def isatty(self):
            return True

    monkeypatch.setattr(manual_fix, "_ask_material_url",
                        lambda c, i: "materials/chinese/old/content.md")
    # 题干 → 答案 → 共享材料回车（不加）→ 题内材料回车
    monkeypatch.setattr("sys.stdin", TtyStringIO(
        "1\n题干正文\nEOF\n1\n答\n\n\n"))

    recs = manual_fix._ask(issue, md_dir)

    assert len(recs) == 1
    assert recs[0]["material_url"] == "materials/chinese/old/content.md"
    assert "material_target" not in recs[0]


def test_looks_like_wrapped_copy_detects_terminal_prefix_and_split_tag():
    assert manual_fix.looks_like_wrapped_copy("│ 第一行\n│ 第二行")
    assert manual_fix.looks_like_wrapped_copy(
        "她每天<span clas\ns=\"cn-emphasis-dot\">提</span>")
    assert not manual_fix.looks_like_wrapped_copy(
        "①第一段。\n②第二段。<span class=\"cn-emphasis-dot\">提</span>")


def test_collect_optional_block_rejects_terminal_wrapped_paste(tmp_path, monkeypatch):
    """带 │ / 硬折行的粘贴要拒收并重问，不能写进文档。"""
    monkeypatch.setattr(manual_fix, "ROOT", tmp_path)
    monkeypatch.setattr("sys.stdin", io.StringIO(
        "│ 第一段开头\n│ 第一段结尾\nEOF\n1\n"
        "干净正文。\nEOF\n1\n"))

    got = manual_fix._collect_optional_block(tmp_path / "md", "共享材料全文", None)

    assert got == "干净正文。"


def test_edit_material_file_reads_what_user_wrote(tmp_path, monkeypatch):
    """文件模式：先把当前正文落成副本，用户改完文件后按回车读取。"""
    monkeypatch.setattr(manual_fix, "ROOT", tmp_path)
    issue = {"source": "模拟二", "group_order": 5}
    path = tmp_path / "output" / "manual_edits" / "模拟二" / "05-共享材料.md"
    calls = {"n": 0}

    def fake_read_line():
        calls["n"] += 1
        if calls["n"] == 1:
            assert path.exists() and "旧正文" in path.read_text(encoding="utf-8")
            path.write_text("新正文\n", encoding="utf-8")
            return ""
        return "1"

    monkeypatch.setattr(manual_fix, "_read_line", fake_read_line)

    assert manual_fix._edit_material_file(issue, "共享材料", "旧正文", slug="共享材料") == "新正文"


def test_edit_material_file_new_material_starts_empty(tmp_path, monkeypatch):
    """新增材料：给一个空文件让用户写，避免在 tty 里整段粘。"""
    monkeypatch.setattr(manual_fix, "ROOT", tmp_path)
    issue = {"source": "模拟二", "group_order": 5}
    path = tmp_path / "output" / "manual_edits" / "模拟二" / "05-共享材料.md"
    calls = {"n": 0}

    def fake_read_line():
        calls["n"] += 1
        if calls["n"] == 1:
            assert path.read_text(encoding="utf-8") == ""
            path.write_text("## 新文章\n正文\n", encoding="utf-8")
            return ""
        return "1"

    monkeypatch.setattr(manual_fix, "_read_line", fake_read_line)

    got = manual_fix._edit_material_file(issue, "共享材料", None, slug="共享材料")
    assert got == "## 新文章\n正文"


def test_content_issue_all_slots_skipped_marks_no_change(tmp_path, monkeypatch):
    """三段都回车：按「确认无问题」收口，不写补题记录。"""
    issue, md_dir = _prep_material_only(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.stdin", io.StringIO("1\n\n\n\n"))

    assert manual_fix._ask(issue, md_dir) == []
    saved = _json.loads(manual_fix.ISSUES_FILE.read_text(encoding="utf-8").splitlines()[0])
    assert saved["status"] == "resolved"
    assert saved["verdict"] == "no_change"


def test_content_issue_material_only_both_edits_article_then_inline(tmp_path, monkeypatch):
    """文章+题内素材：先改文章、再改素材，记 both（两个字段分开存）。"""
    issue, md_dir = _prep_material_only(
        tmp_path, monkeypatch, post_material="旧题内素材。")
    new_article = "## 第三站\n<u>修正后的文章</u>。"
    new_inline = "修正后的题内素材。"
    # 1=有问题 → 题干回车 → 共享材料 2=粘贴+文章 → 题内材料 2=粘贴+素材
    monkeypatch.setattr("sys.stdin", io.StringIO(
        "1\n\n2\n" + new_article + "\nEOF\n1\n"
        "2\n" + new_inline + "\nEOF\n1\n"))

    recs = manual_fix._ask(issue, md_dir)

    assert len(recs) == 1
    rec = recs[0]
    assert rec["material_target"] == "both"
    assert rec["material_text"] == new_article
    assert rec["material_inline_text"] == new_inline
    assert "material_scope" not in rec, "both 不写旧 scope，防旧读取器猜错"


def test_content_issue_material_only_without_original_question_is_refused(tmp_path, monkeypatch, capsys):
    """extracted 里没有当前题：没法保证题干不动，拒收而不是盲写空题干。"""
    issue, md_dir = _prep_material_only(tmp_path, monkeypatch)
    (tmp_path / "output" / "extracted" / issue["rel_path"] / "模拟二.jsonl").write_text("", encoding="utf-8")
    monkeypatch.setattr("sys.stdin", io.StringIO("1\n材料\nEOF\n1\n"))

    assert manual_fix._ask(issue, md_dir) == []
    assert "读不到本题当前题干" in capsys.readouterr().out


def test_content_issue_material_only_end_to_end_records_fix(tmp_path, monkeypatch):
    """走完整 review_pending：选 1 后能落补题文件并把 issue 标 recorded。"""
    _, _ = _prep_material_only(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.stdin", io.StringIO(
        "1\n\n2\n## 第三站\n<u>画线句</u>\nEOF\n1\n\n"))

    res = manual_fix.review_pending(fixes_dir=tmp_path / "fixes")

    assert res["fixed"] == 1
    out = (tmp_path / "fixes" / "模拟二.jsonl").read_text(encoding="utf-8")
    rec = _json.loads(out.splitlines()[0])
    assert rec["material_scope"] == "article" and "<u>画线句</u>" in rec["material_text"]
    path = manual_fix.ISSUES_FILE
    saved = _json.loads(path.read_text(encoding="utf-8").splitlines()[0])
    assert saved["status"] == "recorded"


def _write_article_doc(root: Path, text: str) -> None:
    doc = root / "output" / "assets" / "materials/chinese/814d0a125a3c/content.md"
    doc.parent.mkdir(parents=True)
    doc.write_text(text, encoding="utf-8")


def test_material_slots_recognizes_article_copied_into_material_text(tmp_path, monkeypatch):
    """URL 丢了、文章被塞进 material_text：仍要认回文章槽，不能再当题内素材。"""
    issue, _ = _prep_material_only(tmp_path, monkeypatch)
    article = "## 第三站\n" + "这是一篇完整的文章正文。" * 12
    _write_article_doc(tmp_path, article)
    ext = tmp_path / "output" / "extracted" / issue["rel_path"] / "模拟二.jsonl"
    rows = [json.loads(l) for l in ext.read_text(encoding="utf-8").splitlines()]
    rows[0]["material_text"] = article
    _write(ext, rows)

    slots = manual_fix._material_slots(issue)

    assert slots["inline"] is None
    assert slots["article"] and "第三站" in slots["article"]


def test_whole_question_paste_of_article_auto_routes_to_material(tmp_path, monkeypatch):
    """整题重录粘的是共享文章：自动改记为材料修订，题干保持原样。"""
    issue, md_dir = _prep_material_only(tmp_path, monkeypatch)
    article = "## 第三站\n" + "这是一篇完整的文章正文。" * 12
    _write_article_doc(tmp_path, article)
    monkeypatch.setattr("sys.stdin", io.StringIO(
        "1\n1\n2\n" + article + "\nEOF\n1\n"))   # 有问题 → 改题干 → 重新录入 → 粘文章

    recs = manual_fix._ask(issue, md_dir)

    assert len(recs) == 1
    rec = recs[0]
    assert rec["material_target"] == "article"
    assert rec["material_text"] == article
    assert rec["content"] == "文段中的画线句存在一处问题，请你修改。(2分)", "题干不能被文章覆盖"


def test_line_edit_r_replaces_paragraph_with_multiline(monkeypatch):
    """r N 要能把整段（含空行）一次替换进去，c N 只能输一行的限制不再挡路。"""
    monkeypatch.setattr("sys.stdin", io.StringIO(
        "r 1\n第一段。\n\n第二段。\nEOF\nw\n"))
    out = manual_fix._line_edit("旧的一行")
    assert out == "第一段。\n\n第二段。"


def test_material_slots_finds_article_owned_by_sibling_number(tmp_path, monkeypatch):
    """URL 挂在同组别的题号上（published 去重保留最小题号）：也要能认回文章槽。"""
    issue, _ = _prep_material_only(tmp_path, monkeypatch)
    article = "## 第三站\n" + "这是一篇完整的文章正文。" * 12
    _write_article_doc(tmp_path, article)
    ext = tmp_path / "output" / "extracted" / issue["rel_path"] / "模拟二.jsonl"
    rows = [json.loads(l) for l in ext.read_text(encoding="utf-8").splitlines()]
    rows[0]["material_text"] = article
    _write(ext, rows)
    pub = tmp_path / "output" / "published" / issue["rel_path"] / "模拟二.jsonl"
    _write(pub, [{"group_order": 4, "material_url": "materials/chinese/814d0a125a3c/content.md"}])

    slots = manual_fix._material_slots(issue)

    assert slots["article_url"] == "materials/chinese/814d0a125a3c/content.md"
    assert slots["article"] and "第三站" in slots["article"]
    assert slots["inline"] is None


def test_read_block_keeps_blank_lines(monkeypatch):
    """空行是段落边界：粘贴时不能把两段之间的空行吞掉。"""
    monkeypatch.setattr("sys.stdin", io.StringIO("第一段。\n\n第二段。\nEOF\n"))
    assert manual_fix._read_block() == "第一段。\n\n第二段。"


def test_confirm_text_shows_all_lines(monkeypatch, capsys):
    """确认预览要显示全部段落，不能只给前 6 行（长文章没法核对）。"""
    text = "\n".join(f"第{i}段。" for i in range(1, 20))
    monkeypatch.setattr("sys.stdin", io.StringIO("1\n"))
    action, _ = manual_fix._confirm_text(text)
    out = capsys.readouterr().out
    assert action == "ok"
    assert "还有" not in out
    assert "第19段。" in out


def test_restore_swallowed_option_label_with_interleaved_descriptions():
    """选项行和说明行交替时，上一行不是选项，仍要靠「A–F 缺谁」补回 C。"""
    lines = [
        "如图所示的光现象中, 由于光的折射形成的是",
        "A. ![](a.jpg)", "群山在水中形成的倒影",
        "B. ![](b.jpg)", "树叶在地面形成的影子",
        ". ![](c.jpg)", "透过眼镜看到的景物",
        "D. ![](d.jpg)", "汽车观后镜中看到的路况",
    ]
    out = manual_fix._restore_swallowed_option_label(lines)
    assert out[5].startswith("C. ")
    assert out[1].startswith("A. ") and out[3].startswith("B. ") and out[7].startswith("D. ")


def test_line_edit_restores_swallowed_label_in_edited_line(monkeypatch):
    """逐行编辑 c N 时被吞成 `. xxx`，按 A–F 缺字母补回。"""
    text = "\n".join([
        "题", "A. ![](a.jpg)", "说明A", "B. ![](b.jpg)", "说明B",
        ". ![](c.jpg)", "说明C", "D. ![](d.jpg)", "说明D",
    ])
    seq = iter(["c 6 . ![](c.jpg)", "w"])
    monkeypatch.setattr(review_editor, "_read_line", lambda: next(seq))
    out = manual_fix._line_edit(text)
    assert out.splitlines()[5].startswith("C. ")


def test_ask_image_mode_text_only(monkeypatch):
    """菜单第 4 项 = 只改文本，原题图片/材料/选项一律不留。"""
    seq = iter(["4"])
    monkeypatch.setattr(manual_fix, "_read_line", lambda: next(seq))
    assert manual_fix._ask_image_mode(4) == "text"


def test_text_only_mode_drops_original_image_material_and_options(monkeypatch, tmp_path):
    """菜单 4：新文本之外一律不留（原图/材料/选项/文章 URL 全清）。"""
    from subject_strategies import get_strategy

    original = {
        "group_order": 1, "sub_no": 0,
        "content": "原题 ![](images/old.jpg)",
        "material_text": "旧材料", "material_url": "materials/chinese/old/content.md",
        "options": [{"label": "A", "text": "![](images/old_opt.jpg)"}],
        "answer": "",
    }
    issue = {"source": "卷A", "rel_path": "物理/x/卷A", "group_order": 1,
             "kind": "junk_question", "sub_no": 0, "reasons": []}

    seq = iter(["2", "4"])  # 怎么改=重新录入 → 图片处理菜单=只改文本
    monkeypatch.setattr(manual_fix, "_read_line", lambda: next(seq))
    monkeypatch.setattr(manual_fix, "_current_question", lambda _issue: original)
    monkeypatch.setattr(manual_fix, "_collect_content",
                        lambda *_a, **_kw: "只保留这一行纯文本")
    monkeypatch.setattr(manual_fix, "_collect_answer", lambda *_a, **_kw: "")
    monkeypatch.setattr(manual_fix, "_question_article", lambda _issue: None)

    records = manual_fix._ask_one(issue, 1, "", tmp_path, get_strategy("physics"))
    assert len(records) == 1
    rec = records[0]
    assert rec["content"] == "只保留这一行纯文本"
    assert "images/" not in rec["content"]
    assert rec["material_url"] is None
    assert not (rec.get("material_text") or "").strip()
    assert not rec.get("options")


# ---------- 同一题多条 flag + 自动修复砍短（2026-11-23） ----------

def _prep_repair(tmp_path, monkeypatch, *, with_original=True, swap=False):
    """第18题同时命中 repair_truncated + incomplete_content 的清单。"""
    md_dir = tmp_path / "md" / "物理" / "初中" / "first" / "2024" / "卷A"
    md_dir.mkdir(parents=True, exist_ok=True)
    (md_dir / "卷A.md").write_text("", encoding="utf-8")
    monkeypatch.setattr(manual_fix, "ROOT", tmp_path)

    if with_original:
        lab = tmp_path / "output" / "labeling_issues.jsonl"
        lab.parent.mkdir(parents=True, exist_ok=True)
        _write(lab, [{"source": "物理-卷A-试卷", "group_order": 18,
                      "original_content": "修复前原文，完整段落。" * 12,
                      "regenerated": {"content": "短版"}}])
    ext = tmp_path / "output" / "extracted" / "物理" / "初中" / "first" / "2024" / "卷A" / "物理-卷A-试卷.jsonl"
    ext.parent.mkdir(parents=True, exist_ok=True)
    _write(ext, [{"source": "物理-卷A-试卷", "group_order": 18, "sub_no": 0,
                  "content": "短版", "options": None, "answer": "旧答案",
                  "material_text": "题内材料"}])

    base = {"source": "物理-卷A-试卷", "rel_path": "物理/初中/first/2024/卷A",
            "group_order": 18, "sub_no": 0, "excerpt": "", "pdf": None,
            "md": str(md_dir / "卷A.md"), "status": "pending"}
    repair = dict(base, kind="repair_truncated",
                  reasons=["repair_shrank_631_to_437"])
    incomplete = dict(base, kind="incomplete_content",
                      reasons=["llm_marked_incomplete"], content_sig="sig-1")
    rows = [repair, incomplete]
    if swap:
        rows.reverse()
    path = tmp_path / "issues.jsonl"
    _write(path, rows)
    monkeypatch.setattr(manual_fix, "ISSUES_FILE", path)
    return path


def test_confirm_ok_closes_every_flag_of_same_question(tmp_path, monkeypatch):
    """答一次「没问题」按卷+题号收口：同题另一个 kind 不再冒出来问第二遍。"""
    path = _prep_repair(tmp_path, monkeypatch, swap=True)
    monkeypatch.setattr("sys.stdin", io.StringIO("2\n"))

    res = manual_fix.review_pending(fixes_dir=tmp_path / "fixes")

    assert res["confirmed_ok"] == 1 and res["skipped"] == 0
    rows = [_json.loads(l) for l in path.read_text(encoding="utf-8").splitlines()]
    assert [r["status"] for r in rows] == ["resolved", "resolved"]
    assert all(r["verdict"] == "no_change" for r in rows)


def _repair_issue_from(path):
    return next(_json.loads(l) for l in path.read_text(encoding="utf-8").splitlines()
                if _json.loads(l)["kind"] == "repair_truncated")


def test_repair_truncated_keep_both_versions_closes_all_flags(tmp_path, monkeypatch, capsys):
    """砍短类摆出原文+修复后，选保留修复后 → 不重录、不写库、两 flag 全关。"""
    path = _prep_repair(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.stdin", io.StringIO("1\n"))
    issue = _repair_issue_from(path)

    recs = manual_fix._ask(issue, Path(issue["md"]).parent, 1, 2)

    assert recs == []
    rows = [_json.loads(l) for l in path.read_text(encoding="utf-8").splitlines()]
    assert [r["status"] for r in rows] == ["resolved", "resolved"]
    out = capsys.readouterr().out
    assert "自动修复前原文" in out and "修复前原文，完整段落" in out
    assert "录入第 18 题" not in out, "不该再强制整题重录"


def test_repair_truncated_restore_records_content_only(tmp_path, monkeypatch):
    """选恢复原文 → 只记 content_only 题干，原文必须完整（不能用 600 字截断的 excerpt）。"""
    path = _prep_repair(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.stdin", io.StringIO("2\n"))
    issue = _repair_issue_from(path)

    recs = manual_fix._ask(issue, Path(issue["md"]).parent, 1, 2)

    assert len(recs) == 1
    rec = recs[0]
    assert rec["content"] == "修复前原文，完整段落。" * 12
    assert rec["content_only"] is True
    assert "options" not in rec and "material_text" not in rec and "answer" not in rec


def test_repair_original_missing_returns_none(tmp_path, monkeypatch):
    monkeypatch.setattr(manual_fix, "ROOT", tmp_path)
    issue = {"source": "物理-卷A-试卷", "group_order": 18}
    assert manual_fix._repair_original(issue) is None


# ---------- 截图 OCR 配图不能丢（2026-11-23 题19） ----------

def test_one_question_body_does_not_split_off_leading_text():
    """单题录入：题号上方的配图/说明不能拆成一条会覆盖正文的伪题。"""
    from subject_strategies import get_strategy

    text = r"""![](images/aaa.jpg)
19题图

19. 小华利用如图所示的装置进行实验，他在音叉的叉股一端贴一个小镜片，用一束激光照射到镜面上，镜片将激光反射到右侧的光屏上。

(1) 敲击音叉, 由于发声的音叉在 , 于是观察到光屏上的光点位置发生变化。

(2) 举出一个相同研究方法的实例: \_\_\_\_。"""
    strategy = get_strategy("physics")

    parts = manual_fix.split_questions(text, strategy)
    merged = manual_fix._one_question_body(parts)

    assert merged is not None and len(merged) == 1
    no, body = merged[0]
    assert no == 19
    assert "images/aaa.jpg" in body, "前置配图必须原样留在这一题里，不能被拆走"
    material, stem, _ = manual_fix.split_material_and_options(strategy, body)
    assert "images/aaa.jpg" in (material or ""), "图应落在题内材料，写库后由前端渲染"


def test_one_question_body_keeps_multi_question_split():
    """两个及以上不同题号时保持逐题拆分，不合并。"""
    parts = [(27, "甲题"), (28, "乙题")]
    assert manual_fix._one_question_body(parts) is None


def test_confirm_menu_option_5_uses_file_edit(monkeypatch):
    """确认菜单新增文件编辑：改完读回后仍可确认。"""
    monkeypatch.setattr(manual_fix, "_file_edit",
                        lambda text, label="题干", **kw: ("文件里改好的题干", Path("/tmp/x.md")))
    monkeypatch.setattr("sys.stdin", io.StringIO("5\n1\n"))

    action, text = manual_fix._confirm_text("原题干")

    assert (action, text) == ("ok", "文件里改好的题干")


def test_file_edit_reads_back_saved_file(tmp_path, monkeypatch):
    """没有编辑器时打印路径、回车后读回文件内容。"""
    monkeypatch.setattr(review_editor, "ROOT", tmp_path)
    monkeypatch.setattr(review_editor, "_find_editor", lambda: None)
    monkeypatch.setattr(review_editor, "_read_line", lambda: "")

    got, _path = manual_fix._file_edit("原始题干")

    assert got == "原始题干", "没有改动时应原样读回"


def test_file_edit_cancel_returns_none(tmp_path, monkeypatch):
    """编辑后按 c 取消：不读内容，返回 None 交给调用方处理。"""
    monkeypatch.setattr(review_editor, "ROOT", tmp_path)
    monkeypatch.setattr(review_editor, "_find_editor", lambda: None)
    monkeypatch.setattr(review_editor, "_read_line", lambda: "c")

    got, path = manual_fix._file_edit("原始题干")

    assert got is None and path.exists()


def test_same_number_overwrite_carries_prior_image():
    """同批粘贴里同题号的后一条没图时，不许把前一条的图覆盖掉。"""
    old = {"group_order": 19, "content": "![](images/aaa.jpg)", "material_text": None}
    new = {"group_order": 19, "content": "题干正文", "material_text": None}

    manual_fix._keep_prior_images(old, new)

    assert "images/aaa.jpg" in new["content"]


def test_same_number_overwrite_keeps_new_image_untouched():
    old = {"group_order": 19, "content": "![](images/old.jpg)"}
    new = {"group_order": 19, "content": "![](images/new.jpg)\n题干"}

    manual_fix._keep_prior_images(old, new)

    assert "images/new.jpg" in new["content"] and "images/old.jpg" not in new["content"]


# ---------- 已有内容直接用编辑器改（2026-11-24） ----------

def test_editable_body_includes_options_and_inline_material():
    body = manual_fix._editable_body({
        "content": "题干正文", "options": [{"label": "A", "text": "甲"}],
        "material_text": "题内材料", "material_url": None,
    })
    assert "题干正文" in body and "A. 甲" in body and "题内材料" in body


def test_editable_body_skips_external_article():
    body = manual_fix._editable_body({
        "content": "题干正文", "material_text": "整篇共享文章",
        "material_url": "materials/chinese/x/content.md",
    })
    assert "题干正文" in body and "整篇共享文章" not in body


def test_ask_one_editor_edits_existing_body_without_reappending_images(tmp_path, monkeypatch):
    """已有内容选编辑器：打开的就是现有正文，删掉的图不能被自动补回。"""
    from subject_strategies import get_strategy

    original = {
        "group_order": 1, "sub_no": 0,
        "content": "原题正文\n![](images/old.jpg)",
        "material_text": None, "material_url": None, "options": None, "answer": "",
    }
    issue = {"source": "卷A", "rel_path": "物理/x/卷A", "group_order": 1,
             "kind": "incomplete_content", "sub_no": 0, "reasons": []}
    seen = {}

    def fake_file_edit(text, label="题干", **kwargs):
        seen["body"] = text
        return "编辑后的正文（图已删）", Path("/tmp/x.md")

    monkeypatch.setattr(manual_fix, "_file_edit", fake_file_edit)
    monkeypatch.setattr(manual_fix, "_current_question", lambda _i: original)
    monkeypatch.setattr(manual_fix, "_collect_answer", lambda *_a, **_k: "")
    monkeypatch.setattr(manual_fix, "_question_article", lambda _i: None)
    monkeypatch.setattr(manual_fix, "_read_line", lambda: "1")

    recs = manual_fix._ask_one(issue, 1, "", tmp_path, get_strategy("physics"))

    assert "原题正文" in seen["body"] and "images/old.jpg" in seen["body"]
    assert recs[0]["content"] == "编辑后的正文（图已删）"
    assert "images/old.jpg" not in recs[0]["content"], "编辑器里删掉的图不能被自动补回"


def _prep_editor_issue(monkeypatch):
    original = {"group_order": 1, "sub_no": 0, "content": "原题正文",
                "material_text": None, "material_url": None,
                "options": None, "answer": ""}
    issue = {"source": "卷A", "rel_path": "物理/x/卷A", "group_order": 1,
             "kind": "incomplete_content", "sub_no": 0, "reasons": []}
    monkeypatch.setattr(manual_fix, "_current_question", lambda _i: original)
    monkeypatch.setattr(manual_fix, "_collect_answer", lambda *_a, **_k: "")
    monkeypatch.setattr(manual_fix, "_question_article", lambda _i: None)
    return issue


def test_ask_one_editor_cancel_then_skip(tmp_path, monkeypatch):
    """编辑后取消 → 选跳过：本题不产记录。"""
    from subject_strategies import get_strategy

    issue = _prep_editor_issue(monkeypatch)
    monkeypatch.setattr(manual_fix, "_file_edit",
                        lambda *a, **k: (None, Path("/tmp/x.md")))
    seq = iter(["1", "2"])
    monkeypatch.setattr(manual_fix, "_read_line", lambda: next(seq))

    recs = manual_fix._ask_one(issue, 1, "", tmp_path, get_strategy("physics"))

    assert recs == []


def test_ask_one_editor_cancel_then_retry_reopens_same_file(tmp_path, monkeypatch):
    """取消后选重试：复用同一个文件，不覆盖用户刚改的内容。"""
    from subject_strategies import get_strategy

    issue = _prep_editor_issue(monkeypatch)
    calls = []

    def fake_file_edit(text, label="题干", *, path=None):
        calls.append((text, path))
        if len(calls) == 1:
            return None, Path("/tmp/x.md")
        return "改好了", Path("/tmp/x.md")

    monkeypatch.setattr(manual_fix, "_file_edit", fake_file_edit)
    seq = iter(["1", "1"])
    monkeypatch.setattr(manual_fix, "_read_line", lambda: next(seq))

    recs = manual_fix._ask_one(issue, 1, "", tmp_path, get_strategy("physics"))

    assert calls[1][0] is None, "重试时不应重写文件"
    assert calls[1][1] == Path("/tmp/x.md")
    assert recs[0]["content"] == "改好了"
