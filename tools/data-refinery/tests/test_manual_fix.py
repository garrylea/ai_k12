"""manual_fix：待补题筛选（import_cli 第 7 步按本次扫描到的卷精确取）。"""

import json
from pathlib import Path

import manual_fix
import review_editor


def _patch_issues(monkeypatch, path):
    """队列层已搬到 review_queue：两个模块的名字都要指到同一个临时文件。

    `manual_fix` 用具名 import 拿的是快照，只改 review_queue 时旧模块还看老路径；
    只改 manual_fix 时 `mark_issue/recorded_flags`（在 review_queue）又会写真实文件。
    """
    import manual_fix, review_queue
    monkeypatch.setattr(review_queue, "ISSUES_FILE", path)
    monkeypatch.setattr(manual_fix, "ISSUES_FILE", path)


def _write(path, rows):
    path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows),
                    encoding="utf-8")


def _patch_all_roots(monkeypatch, root):
    """editor / content / records 三层各有一份 ROOT 快照，临时目录必须一起改。

    `review_records` 本身不读真实输出目录（路径都由调用方传入），没有 ROOT 属性，
    所以第三个 setattr 用 `raising=False`。
    """
    import review_content, review_editor, review_records
    for mod in (review_editor, review_content, review_records):
        monkeypatch.setattr(mod, "ROOT", root, raising=False)


def test_pending_issues_filters_by_exact_sources(tmp_path, monkeypatch):
    issues = [
        {"source": "物理-卷A-试卷", "group_order": 7, "kind": "missing", "status": "pending"},
        {"source": "物理-卷B-试卷", "group_order": 2, "kind": "missing", "status": "pending"},
        {"source": "物理-卷A-试卷", "group_order": 3, "kind": "missing", "status": "resolved"},
    ]
    path = tmp_path / "issues.jsonl"
    _write(path, issues)
    _patch_issues(monkeypatch, path)

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
    _patch_issues(monkeypatch, path)

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
    _patch_issues(monkeypatch, issues_file)
    return issue, issues_file






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
    _patch_issues(monkeypatch, path)
    return path







def test_review_skips_issue_without_md(tmp_path, monkeypatch):
    path = tmp_path / "issues.jsonl"
    path.write_text(_json.dumps({
        "source": "物理-卷A-试卷", "rel_path": "物理/初中/first/2024/卷A",
        "group_order": 5, "kind": "missing", "reasons": [], "md": None,
        "status": "pending"}, ensure_ascii=False) + "\n", encoding="utf-8")
    _patch_issues(monkeypatch, path)

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
    _patch_issues(monkeypatch, path)
    return issue, path




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


# ---------- 状态流转：recorded → resolved 只在写库后发生 ----------

def test_mark_issue_moves_all_kinds_of_same_question(tmp_path, monkeypatch):
    path = tmp_path / "issues.jsonl"
    path.write_text("".join(_json.dumps(r, ensure_ascii=False) + "\n" for r in [
        {"source": "卷A", "group_order": 18, "kind": "missing", "status": "recorded"},
        {"source": "卷A", "group_order": 18, "kind": "punct_stem", "status": "recorded"},
        {"source": "卷A", "group_order": 19, "kind": "missing", "status": "pending"},
    ]), encoding="utf-8")
    _patch_issues(monkeypatch, path)

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
    _patch_issues(monkeypatch, path)

    manual_fix.mark_issue("卷A", 7, "pending", note="补录内容被拒，请重新补录")

    row = _json.loads(path.read_text(encoding="utf-8"))
    assert row["status"] == "pending"
    assert "resolved_at" not in row
    assert row["note"].startswith("补录内容被拒")


# ---------- 输入方式菜单（1/2/3）与预览确认 ----------


# ---------- 剪贴板图片（⌘V / 菜单 4） ----------

def _fake_clipboard(monkeypatch, tmp_path, suffix=".png", content=b"png"):
    img = tmp_path / f"clip{suffix}"
    img.write_bytes(content)
    monkeypatch.setattr(review_editor, "_clipboard_to_path", lambda d: img)
    return img


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


# ---------- 答案这一步也能返工（e 改题面 / r 重录 / s 放弃） ----------


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
    _patch_issues(monkeypatch, path)
    return issue, path




def test_content_issue_skip_keeps_pending(tmp_path, monkeypatch):
    _, path = _prep_content(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.stdin", io.StringIO("s\n"))

    res = manual_fix.review_pending(fixes_dir=tmp_path / "fixes")

    assert res["skipped"] == 1 and res["confirmed_ok"] == 0
    saved = _json.loads(path.read_text(encoding="utf-8").splitlines()[0])
    assert saved["status"] == "pending" and "verdict" not in saved






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
    _patch_all_roots(monkeypatch, tmp_path)
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
    _patch_all_roots(monkeypatch, tmp_path)
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
    _patch_all_roots(monkeypatch, tmp_path)
    issue = {"source": "卷A", "rel_path": "数学/卷A", "group_order": 9,
             "excerpt": "某题的旧快照"}
    assert manual_fix._copyable_question_text(issue) == "某题的旧快照"


def test_discard_fixes_for_source_moves_only_matching(tmp_path, monkeypatch):
    """重转后只作废「已恢复」的旧补题，且只动目标卷。"""
    _patch_all_roots(monkeypatch, tmp_path)
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
    _patch_all_roots(monkeypatch, tmp_path)
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
    _patch_all_roots(monkeypatch, tmp_path)
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
    _patch_all_roots(monkeypatch, tmp_path)
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


# ---------- 无图题配图 + 目录批量导入（第19题图变表格）----------




# ---------- 菜单 5：多图+题干（逐张裁剪→占位符）----------


def test_clear_clipboard_noop_when_no_tool(monkeypatch):
    """清空剪贴板在没有工具时静默不报错（实现在 review_editor）。"""
    import review_editor
    monkeypatch.setattr(review_editor.sys, "platform", "linux")
    monkeypatch.setattr(review_editor.shutil, "which", lambda x: None)
    manual_fix._clear_clipboard()  # 不抛异常即可


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


class _TtyStdin(io.StringIO):
    def isatty(self):
        return True


def test_copyable_text_includes_current_inline_material(tmp_path, monkeypatch):
    _patch_all_roots(monkeypatch, tmp_path)
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
    _patch_all_roots(monkeypatch, tmp_path)
    issue = {"rel_path": rel, "source": "语文-模拟二", "group_order": 20}
    assert manual_fix._published_material_urls(issue) == [
        (19, "materials/chinese/A/content.md"),
        (24, "materials/chinese/B/content.md"),
    ]


def test_published_material_urls_missing_file_returns_empty(tmp_path, monkeypatch):
    _patch_all_roots(monkeypatch, tmp_path)
    issue = {"rel_path": "语文/模拟二", "source": "不存在", "group_order": 20}
    assert manual_fix._published_material_urls(issue) == []


# ---------- 题干没问题、只改材料（2026-11-21 用户反馈：无法跳过题干去改材料）----------

def _prep_material_only(tmp_path, monkeypatch, *, with_url=True, post_material=None,
                        material_text="## 第三站中国(北京)航天科学中心\n该中心舟搔传统展馆局限。"):
    """题干完整的语文 incomplete_content：问题在共享文章缺画线标记。"""
    _patch_all_roots(monkeypatch, tmp_path)
    monkeypatch.setattr(manual_fix, "ROOT", tmp_path)  # _edit_material_file 仍在 manual_fix
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
    _patch_issues(monkeypatch, path)
    return issue, md.parent


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
    _patch_issues(monkeypatch, path)
    return issue, md.parent


def test_looks_like_wrapped_copy_detects_terminal_prefix_and_split_tag():
    assert manual_fix.looks_like_wrapped_copy("│ 第一行\n│ 第二行")
    assert manual_fix.looks_like_wrapped_copy(
        "她每天<span clas\ns=\"cn-emphasis-dot\">提</span>")
    assert not manual_fix.looks_like_wrapped_copy(
        "①第一段。\n②第二段。<span class=\"cn-emphasis-dot\">提</span>")


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


# ---------- 同一题多条 flag + 自动修复砍短（2026-11-23） ----------

def _prep_repair(tmp_path, monkeypatch, *, with_original=True, swap=False):
    """第18题同时命中 repair_truncated + incomplete_content 的清单。"""
    md_dir = tmp_path / "md" / "物理" / "初中" / "first" / "2024" / "卷A"
    md_dir.mkdir(parents=True, exist_ok=True)
    (md_dir / "卷A.md").write_text("", encoding="utf-8")
    _patch_all_roots(monkeypatch, tmp_path)

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
    _patch_issues(monkeypatch, path)
    return path


def _repair_issue_from(path):
    return next(_json.loads(l) for l in path.read_text(encoding="utf-8").splitlines()
                if _json.loads(l)["kind"] == "repair_truncated")


def test_repair_original_missing_returns_none(tmp_path, monkeypatch):
    _patch_all_roots(monkeypatch, tmp_path)
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


# ---------- revision 控制重绘（2026-11-27）----------


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
    # 临时环境助手与 test_review_flow 共用（题卡环境构造逻辑相同）。
    from test_review_flow import REL, _env, _i, _q

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


