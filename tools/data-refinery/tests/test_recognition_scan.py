"""recognition_scan：缺号 / 顿号题号 / 修复删内容 / 噪声题 的判定。"""

import json
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


# ---------- 已标记问题的复核（补题被作废/没写库时要重新打开） ----------

def _rec(status, go=28, source="物理-卷A-试卷", kind="missing"):
    return {"source": source, "group_order": go, "kind": kind, "status": status}


def _fix(tmp_path, pairs: dict[int, bool], source="物理-卷A-试卷"):
    d = tmp_path / "fixes"
    d.mkdir(exist_ok=True)
    lines = [{"source": source, "group_order": go, "applied": bool(ap)}
             for go, ap in pairs.items()]
    (d / f"{source}.jsonl").write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in lines), encoding="utf-8")
    return d


def test_reopen_when_fix_file_was_discarded(tmp_path):
    """resolved 但补题文件已作废（如被移进 _discarded）→ 退回待处理。"""
    recs = [_rec("resolved")]
    kept = [{"source": "物理-卷A-试卷", "group_order": 28, "kind": "missing"}]

    reopened = R.reopen_unbacked(recs, kept, fixes_dir=tmp_path / "fixes")

    assert reopened == 1
    assert recs[0]["status"] == "pending"
    assert "作废" in recs[0]["note"]


def test_resolved_stays_when_fix_applied(tmp_path):
    fixes = _fix(tmp_path, {28: True})
    recs = [_rec("resolved")]
    kept = [{"source": "物理-卷A-试卷", "group_order": 28, "kind": "missing"}]

    assert R.reopen_unbacked(recs, kept, fixes_dir=fixes) == 0
    assert recs[0]["status"] == "resolved"


def test_recorded_stays_until_applied(tmp_path):
    """已补录但没写库：仍算「有救」，不重复打扰；写库后才转 resolved。"""
    fixes = _fix(tmp_path, {28: False})
    recs = [_rec("recorded")]
    kept = [{"source": "物理-卷A-试卷", "group_order": 28, "kind": "missing"}]

    assert R.reopen_unbacked(recs, kept, fixes_dir=fixes) == 0
    assert recs[0]["status"] == "recorded"


def test_recorded_reopens_when_fix_file_gone(tmp_path):
    recs = [_rec("recorded")]
    kept = [{"source": "物理-卷A-试卷", "group_order": 28, "kind": "missing"}]

    assert R.reopen_unbacked(recs, kept, fixes_dir=tmp_path / "nope") == 1
    assert recs[0]["status"] == "pending"


def test_discarded_dir_is_not_counted(tmp_path):
    """`_discarded/` 里的作废记录不能当作已补。"""
    d = tmp_path / "fixes" / "_discarded"
    d.mkdir(parents=True)
    (d / "物理-卷A-试卷-1330.jsonl").write_text(
        json.dumps({"source": "物理-卷A-试卷", "group_order": 28, "applied": True}) + "\n",
        encoding="utf-8")
    recs = [_rec("resolved")]
    kept = [{"source": "物理-卷A-试卷", "group_order": 28, "kind": "missing"}]

    assert R.reopen_unbacked(recs, kept, fixes_dir=tmp_path / "fixes") == 1


def test_fixed_numbers_reads_applied_flag(tmp_path):
    fixes = _fix(tmp_path, {7: True, 16: False})
    assert R.fixed_numbers("物理-卷A-试卷", fixes) == {7: True, 16: False}
    assert R.fixed_numbers("不存在的卷", fixes) == {}


# ---------- 内容层：不完整 / 前后题合并（2026-11-01）----------

def _kinds(issues):
    return {i["kind"] for i in issues}


def test_incomplete_content_when_subq_starts_at_2(tmp_path):
    """小问从 (2) 起 = 丢了 (1)，题号再对也要报。"""
    md = _md(tmp_path, "27. 重力势能\n")
    rows = _rows((27, "为探究重力势能的大小与什么因素有关……\n(2) 则 $E_A$ ____ $E_C$。"))
    issues = R.scan_paper("卷A", Path("物理/x/卷A"), md, rows, None, [])

    inc = [i for i in issues if i["kind"] == "incomplete_content"]
    assert len(inc) == 1
    assert inc[0]["group_order"] == 27
    assert "subq_starts_at_2" in inc[0]["reasons"]
    assert inc[0]["content_sig"], "要带内容指纹，供「确认无问题」后判定是否失效"


def test_incomplete_content_reports_llm_flag(tmp_path):
    md = _md(tmp_path, "5. 甲\n")
    rows = [{"group_order": 5, "content": "甲", "type": "choice", "needs_review": True}]
    labeling = [{"source": "卷A", "group_order": 5, "issues": ["题干缺填空横线"]}]
    issues = R.scan_paper("卷A", Path("物理/x/卷A"), md, rows, None, labeling)

    inc = [i for i in issues if i["kind"] == "incomplete_content"]
    assert inc and "llm_marked_incomplete" in inc[0]["reasons"]
    assert "题干缺填空横线" in inc[0]["reasons"], "LLM 的原话要带出来，人工才好判"


def test_content_check_still_runs_after_fix(tmp_path):
    """补过的题也要继续查内容：补坏了（题干仍空/小问仍缺）必须还能检出来。

    2026-11-01 人大附题2：补完题干还是空串，就因为「按 applied 跳过内容检查」
    扫不出来，也没人再被问一次。
    """
    fixes = tmp_path / "fixes"
    fixes.mkdir()
    (fixes / "卷A.jsonl").write_text(
        json.dumps({"group_order": 27, "applied": True}) + "\n", encoding="utf-8")
    md = _md(tmp_path, "27. 重力势能\n")
    rows = _rows((27, "……\n(2) 则 ____ 。"))

    issues = R.scan_paper("卷A", Path("物理/x/卷A"), md, rows, None, [], fixes_dir=fixes)
    assert len([i for i in issues if i["kind"] == "incomplete_content"]) == 1


def test_fixed_content_no_longer_reported(tmp_path):
    """补好了（正文完整）就自然不再报，不需要靠 applied 去压。"""
    md = _md(tmp_path, "27. 重力势能\n")
    rows = _rows((27, "为探究重力势能…\n(1) 与质量有关。\n(2) 则 $E_A$ > $E_C$。"))

    issues = R.scan_paper("卷A", Path("物理/x/卷A"), md, rows, None, [])
    assert [i for i in issues if i["kind"] == "incomplete_content"] == []


def test_merged_content_when_body_contains_next_stem(tmp_path):
    """17 题正文里出现「18、结合表中数据」= 18 题被吞进 17 题。"""
    md = _md(tmp_path, "17. 关于电阻、电流和电压\n18. 结合表中数据\n")
    rows = _rows((17, "关于电阻、电流和电压，下列说法正确的是 18、结合表中数据，下列说法正确的是"),
                 (18, "结合表中数据，下列说法正确的是"))
    issues = R.scan_paper("卷A", Path("物理/x/卷A"), md, rows, None, [])

    merged = [i for i in issues if i["kind"] == "merged_content"]
    assert len(merged) == 1
    assert merged[0]["group_order"] == 17
    assert merged[0]["suspect_group_order"] == 18
    assert "body_contains_stem_18" in merged[0]["reasons"]


def test_merged_content_when_body_belongs_to_other_number(tmp_path):
    """25 号装的是 23 号的正文：按正文在 md 里的归属反查。"""
    md = _md(tmp_path, "23. 在物理课上小碧和小乐利用西红柿自制了水果电池\n"
                       "24. 小红在探究影响导体电阻大小的因素\n"
                       "25. 小明在用伏安法测量电阻\n")
    rows = _rows((24, "小红在探究影响导体电阻大小的因素时实验收集的部分数据如下表所示"),
                 (25, "在物理课上小碧和小乐利用西红柿自制了水果电池她们将铜片插入"))
    issues = R.scan_paper("卷A", Path("物理/x/卷A"), md, rows, None, [])

    merged = [i for i in issues if i["kind"] == "merged_content"]
    assert [i["group_order"] for i in merged] == [25]
    assert "body_belongs_to_stem_23" in merged[0]["reasons"]


def test_same_opening_under_two_numbers_is_not_reported(tmp_path):
    """两题开头相同但各自挂在正确题号下（如「如图所示, 电源两端电压 U 保持不变」）→ 不报。"""
    md = _md(tmp_path, "32. 如图所示电源两端电压U保持不变电阻\n"
                       "33. 如图所示电源两端电压U保持不变电阻\n")
    rows = _rows((32, "如图所示, 电源两端电压 U 保持不变, 电阻 R1 为 6 欧"),
                 (33, "如图所示, 电源两端电压 U 保持不变, 电阻 R0 阻值为 20 欧"))
    issues = R.scan_paper("卷A", Path("物理/x/卷A"), md, rows, None, [])
    assert [i for i in issues if i["kind"] == "merged_content"] == []


def test_number_like_quantity_is_not_treated_as_stem(tmp_path):
    """「盐水 1、盐水 2」不能被当成题号 1 的合并线索。"""
    md = _md(tmp_path, "1. 在国际单位制中电流的单位是\n")
    rows = _rows((19, "取质量相同的盐水 1、盐水 2 和纯水进行加热, 收集数据"))
    issues = R.scan_paper("卷A", Path("物理/x/卷A"), md, rows, None, [])
    assert [i for i in issues if i["kind"] == "merged_content"] == []


def test_reopen_unbacked_keeps_no_change_verdict(tmp_path):
    """人工确认无问题的条目没有补题记录，不能被 reopen_unbacked 退回待处理。"""
    rec = {"source": "卷A", "group_order": 27, "kind": "incomplete_content",
           "status": "resolved", "verdict": "no_change"}
    kept = [{"source": "卷A", "group_order": 27, "kind": "incomplete_content"}]
    assert R.reopen_unbacked([rec], kept, fixes_dir=tmp_path / "fixes") == 0


def test_reopen_changed_when_content_changes(tmp_path):
    """正文变了 → 之前的「确认无问题」作废，退回待确认。"""
    rec = {"source": "卷A", "group_order": 27, "kind": "incomplete_content",
           "status": "resolved", "verdict": "no_change", "content_sig": "old"}
    fresh = [{"source": "卷A", "group_order": 27, "kind": "incomplete_content",
              "content_sig": "new"}]

    assert R.reopen_changed([rec], fresh) == 1
    assert rec["status"] == "pending" and "verdict" not in rec
    assert "内容已变化" in rec["note"]


def test_reopen_changed_keeps_verdict_when_content_same():
    rec = {"source": "卷A", "group_order": 27, "kind": "incomplete_content",
           "status": "resolved", "verdict": "no_change", "content_sig": "same"}
    fresh = [{"source": "卷A", "group_order": 27, "kind": "incomplete_content",
              "content_sig": "same"}]
    assert R.reopen_changed([rec], fresh) == 0
    assert rec["status"] == "resolved"


def test_llm_flag_not_reported_for_unrepaired_ok_subjects(tmp_path):
    """语文/道法这类「原文缺失可接受」的学科，不能把 is_complete=false 全报成缺陷。

    （实测 30 张语文卷会出 197 条画线句/加点字，真正要修的结构缺陷会被淹没。）
    """
    md = _md(tmp_path, "4. 甲\n")
    rows = [{"group_order": 4, "content": "甲", "type": "choice", "needs_review": True}]
    labeling = [{"source": "卷A", "group_order": 4, "issues": ["画线句丢失，无法确定指代"]}]
    issues = R.scan_paper("卷A", Path("语文/x/卷A"), md, rows, None, labeling)
    assert [i for i in issues if i["kind"] == "incomplete_content"] == []


def test_empty_stem_is_reported(tmp_path):
    """题干为空（正文没有有效文字）：典型是图片/题干整段被拆进了选项。"""
    md = _md(tmp_path, "2. 图1所示的物品中，通常情况下属于导体的是\n")
    rows = _rows((2, ""))
    issues = R.scan_paper("卷A", Path("物理/x/卷A"), md, rows, None, [])

    inc = [i for i in issues if i["kind"] == "incomplete_content"]
    assert len(inc) == 1 and inc[0]["group_order"] == 2
    assert "empty_stem" in inc[0]["reasons"]


def test_empty_stem_not_reported_when_body_has_text(tmp_path):
    md = _md(tmp_path, "2. 甲\n")
    rows = _rows((2, "![](images/a.jpg)\n图1"))
    assert [i for i in R.scan_paper("卷A", Path("物理/x/卷A"), md, rows, None, [])
            if i["kind"] == "incomplete_content"] == []


def test_reopen_when_fix_applied_but_number_still_absent(tmp_path):
    """补题记录说已入库、清单也标 resolved，但这次切题产物里仍缺该题号 → 必须重新打开。"""
    fixes = tmp_path / "fixes"
    fixes.mkdir()
    (fixes / "卷A.jsonl").write_text(
        json.dumps({"group_order": 16, "applied": True}) + "\n", encoding="utf-8")
    rec = {"source": "卷A", "group_order": 16, "kind": "missing", "status": "resolved"}
    kept = [{"source": "卷A", "group_order": 16, "kind": "missing"}]

    assert R.reopen_unbacked([rec], kept, fixes_dir=fixes, present={"卷A": {1, 2}}) == 1
    assert rec["status"] == "pending" and "被后续导入冲掉" in rec["note"]


def test_no_reopen_when_fixed_number_present(tmp_path):
    fixes = tmp_path / "fixes"
    fixes.mkdir()
    (fixes / "卷A.jsonl").write_text(
        json.dumps({"group_order": 16, "applied": True}) + "\n", encoding="utf-8")
    rec = {"source": "卷A", "group_order": 16, "kind": "missing", "status": "resolved"}
    kept = [{"source": "卷A", "group_order": 16, "kind": "missing"}]

    assert R.reopen_unbacked([rec], kept, fixes_dir=fixes, present={"卷A": {16, 17}}) == 0


# ---------- 题型与同大题不一致（选择题丢选项 → 变简答题）----------

def _group_rows(n, group="一", type_="choice"):
    return [{"group_order": i, "content": f"第{i}题的题干", "type": type_, "group_id": group}
            for i in range(1, n + 1)]


def test_type_mismatch_inside_choice_group(tmp_path):
    """单项选择 10 题里只有第 9 题是 short_answer → 报它（选项很可能丢了）。"""
    md = _md(tmp_path, "9. 甲\n")
    rows = _group_rows(10)
    rows[8]["type"] = "short_answer"

    issues = R.scan_paper("卷A", Path("物理/x/卷A"), md, rows, None, [])

    tm = [i for i in issues if i["kind"] == "type_mismatch"]
    assert [i["group_order"] for i in tm] == [9]
    assert "type_outlier_choice_9of10" in tm[0]["reasons"]
    assert tm[0]["group_id"] == "一" and tm[0]["dominant_type"] == "choice"


def test_type_mismatch_skips_mixed_group(tmp_path):
    """实验题大题本来就混排（一半选择一半简答）→ 不报。"""
    md = _md(tmp_path, "1. 甲\n")
    rows = _group_rows(10)
    for r in rows[5:]:
        r["type"] = "short_answer"

    issues = R.scan_paper("卷A", Path("物理/x/卷A"), md, rows, None, [])
    assert [i for i in issues if i["kind"] == "type_mismatch"] == []


def test_type_mismatch_skips_small_group(tmp_path):
    """大题只有 4 题，样本太小，不判。"""
    md = _md(tmp_path, "1. 甲\n")
    rows = _group_rows(4)
    rows[0]["type"] = "short_answer"

    issues = R.scan_paper("卷A", Path("物理/x/卷A"), md, rows, None, [])
    assert [i for i in issues if i["kind"] == "type_mismatch"] == []


def test_type_mismatch_ignores_rows_without_group(tmp_path):
    md = _md(tmp_path, "1. 甲\n")
    rows = _group_rows(6)
    rows[0]["group_id"] = None
    rows[0]["type"] = "short_answer"

    issues = R.scan_paper("卷A", Path("物理/x/卷A"), md, rows, None, [])
    assert [i for i in issues if i["kind"] == "type_mismatch"] == []
