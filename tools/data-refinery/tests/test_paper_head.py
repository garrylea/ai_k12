import json
from pathlib import Path

import paper_head
from paper_head import (
    HeadMeta,
    apply_sidecar,
    detect_district,
    detect_grade,
    detect_school,
    extract_head_meta,
    head_text,
    load_sidecar,
    merge_meta,
    sidecar_path,
    write_sidecar,
)
from paper_meta import PaperMeta, parse_paper_meta


def _meta(**kw):
    base = dict(subject="数学", grade="初三", grade_band="junior", semester="first",
                year=2025, district="北京各", exam_type="（上）期中", file_type="试卷",
                title="2025 北京各 初三 （上）期中", location="北京各")
    base.update(kw)
    return PaperMeta(**base)


def test_head_text_strips_markdown_table_and_images():
    md = "# 标题\n\n![](x.jpg)\n\n<table><tr><td>1</td></tr></table>\n\n正文行"
    assert head_text(md) == "标题\n正文行"


def test_detect_district_explicit_qu():
    head = "# 北京市西城区德胜中学 2025-2026 学年度第一学期期中诊断"
    d, _ = detect_district(head)
    assert d == "西城"


def test_detect_district_in_title_without_suffix():
    head = "# 2025 北京海淀初三（上）期中\n# 数学"
    d, _ = detect_district(head)
    assert d == "海淀"


def test_detect_district_returns_none_for_generic_text():
    assert detect_district("# 试卷\n学校 姓名 准考证号") == (None, None)


def test_detect_school_strips_boilerplate_prefix():
    head = "# 2025-2026 学年第一学期昌平二中教育集团 期中考试试卷"
    s, _ = detect_school(head)
    assert s == "昌平二中教育集团"


def test_detect_school_excludes_fill_instruction():
    head = "学校 姓名 准考证号\n在试卷和答题卡上准确填写学校名称"
    assert detect_school(head) == (None, None)


def test_detect_grade_eighth():
    head = "# 首都师大二附中 2025-2026 学年度第一学期期中练习初二数学"
    g, _ = detect_grade(head)
    assert g == "初二"


def test_detect_grade_ninth():
    head = "# 2025 北京海淀初三（上）期中"
    g, _ = detect_grade(head)
    assert g == "初三"


def test_merge_meta_collective_uses_head_district_and_school():
    path = _meta()
    head = HeadMeta(district="西城", school="北京市西城区德胜中学", grade="初三")
    merged, notes = merge_meta(path, head)
    assert merged.district == "西城"
    assert "德胜中学" in merged.title
    assert merged.grade == "初三"
    assert notes == []


def test_merge_meta_grade_conflict_uses_head_and_notes():
    path = _meta(grade="初三")
    head = HeadMeta(district=None, school="首都师大二附中", grade="初二")
    merged, notes = merge_meta(path, head)
    assert merged.grade == "初二"
    assert any("卷面是初二" in n for n in notes)
    assert merged.district is None


def test_merge_meta_keeps_path_when_not_collective():
    path = _meta(district="海淀", location="海淀·一零一中学")
    head = HeadMeta(district="朝阳", school="某中学", grade="初三")
    merged, _ = merge_meta(path, head)
    # 路径有真实区县时不被卷面覆盖
    assert merged.district == "海淀"
    assert "一零一中学" in merged.title


def test_merge_meta_no_info_falls_back_to_path_location():
    path = _meta()
    head = HeadMeta(district=None, school=None, grade="初二")
    merged, notes = merge_meta(path, head)
    assert merged.district is None
    assert "北京各" in merged.title  # 无任何信息时兜底，保留可识别性
    assert any("卷面是初二" in n for n in notes)


def test_extract_head_meta_no_llm_when_rules_succeed():
    md = "# 2025 北京海淀初三（上）期中\n# 数学\n2025.11"
    h = extract_head_meta(md, llm=None)
    assert h.district == "海淀"
    assert h.grade == "初三"


def test_extract_head_meta_llm_fills_missing_and_validates():
    class FakeLLM:
        def complete(self, system, user):
            return type("R", (), {"content": json.dumps(
                {"district": "海淀", "school": "某某中学", "grade": "初三"})})()
    md = "# 2025——2026学年度第一学期期中练习\n# 八年级数学学科试卷"
    h = extract_head_meta(md, llm=FakeLLM())
    assert h.district == "海淀"
    assert h.school == "某某中学"
    # 规则已抽到初二（八年级），LLM 给初三不应覆盖（只补空字段）
    assert h.grade == "初二"


def test_extract_head_meta_llm_invalid_district_dropped():
    class FakeLLM:
        def complete(self, system, user):
            return type("R", (), {"content": json.dumps(
                {"district": "不存在区", "school": None, "grade": None})})()
    md = "# 期中练习\n# 数学"
    h = extract_head_meta(md, llm=FakeLLM())
    assert h.district is None


def test_sidecar_roundtrip(tmp_path):
    rel = "数学/初中/first/2025/试卷.jsonl"
    path_meta = parse_paper_meta(
        "数学/初中/first/2025/数学-初三(上)-202507-北京各-（上）期中-试卷-86419.jsonl")
    head = HeadMeta(district="海淀", school=None, grade="初三")
    merged, _ = merge_meta(path_meta, head)
    written = write_sidecar(tmp_path, rel, head, merged)
    loaded = load_sidecar(tmp_path, rel)
    assert loaded is not None
    assert loaded["merged"]["district"] == "海淀"
    applied = apply_sidecar(path_meta, loaded)
    assert applied.district == "海淀"
    assert applied.title == merged.title
