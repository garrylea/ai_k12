from pathlib import Path

from chinese_material_doc import (
    annotation_score,
    build_groups,
    choose_canonical,
    doc_key,
    is_heading_only,
    material_group_reason,
    normalize_for_group,
    rewrite_hash_for_row,
    strip_section_instruction,
    write_material_doc,
)


def test_strip_section_instruction_drops_paper_specific_line():
    text = "## (三)阅读下面《醉翁亭记》，完成 12-14题。(共 7分)\n\n## 醉翁亭记\n\n欧阳修"
    out = strip_section_instruction(text)
    assert out.startswith("## 醉翁亭记")
    assert "完成 12-14题" not in out


def test_strip_section_instruction_keeps_article_heading():
    text = "## 前言\n\n“典则”取自唐代窦蒙……"
    assert strip_section_instruction(text) == text


def test_strip_section_instruction_drops_topic_header_with_score():
    assert strip_section_instruction(
        "## (三)文言文阅读(共7分)\n## 岳阳楼记\n正文") == "## 岳阳楼记\n正文"
    assert strip_section_instruction("（一）（共 5 分）\n正文") == "正文"


def test_heading_only_true_for_mo_xie_heading():
    assert is_heading_only("## (一)默写。(共4分)") is True


def test_heading_only_true_for_bare_section_header():
    # 库里存的是无 `##` 的裸小节标题（东城模拟一 Q6 实测），旧实现只认 `##` 前缀，
    # 导致 publish 清理救不了，标题一直留着当材料。
    assert is_heading_only("(一)默写。(共4分)") is True
    assert is_heading_only("（一）默写，完成 8-10题。（共4 分）") is True
    # 标题下面有正文就不是纯标题，不能清
    assert is_heading_only("(一)默写。(共4分)\n(1)念天地之悠悠") is False


def test_heading_only_false_when_body_exists():
    assert is_heading_only("## 前言\n\n正文一段。") is False


def test_normalize_ignores_emphasis_tags_and_images():
    a = '初夏<span class="cn-emphasis-dot">高</span><u>涨</u> ![x](images/a.jpg)'
    b = "初夏高涨"
    assert normalize_for_group(a) == normalize_for_group(b)


def test_normalize_drops_sub_dot_content():
    a = "我静静<sub>．．</sub>地<sub>．</sub>听着"
    b = "我静静地听着"
    assert normalize_for_group(a) == normalize_for_group(b)


def test_choose_canonical_prefers_more_annotations():
    plain = "热啊，热啊。父亲说，还好。"
    annotated = "热啊，热<u>啊。</u>父亲说，<u>还好</u>。"
    assert choose_canonical([plain, annotated]) == annotated


def test_doc_key_stable_when_only_annotation_changes():
    a = "他<span class=\"cn-emphasis-dot\">静</span>静地听着。"
    b = "他静静地听着。"
    assert doc_key(a, []) == doc_key(b, [])


def test_doc_key_changes_when_image_changes():
    body = "同一段文字"
    assert doc_key(body, ["a"]) != doc_key(body, ["b"])


def test_material_group_reason_accepts_article():
    assert material_group_reason("## 醉翁亭记\n\n环滁皆山也。其西南诸峰，林壑尤美。") is None


def test_material_group_reason_detects_lost_question():
    # 顿号题号不被 is_main_stem 认，整道题会沉进上一节的「材料」
    assert material_group_reason("## (一)默写\n7、拔剑四顾心茫然。") == "punct_stem"


def test_material_group_reason_detects_option_block():
    assert material_group_reason("材料\nA. 甲\nB. 乙\nC. 丙\nD. 丁") == "option_block"


def test_material_group_reason_detects_answer_scaffold():
    assert material_group_reason("# 红楼\n示例：我选 A 隶书，因为古朴。") == "scaffold"


def test_material_group_reason_detects_cross_section():
    body = (
        "这是上一节的文章正文，用来测试跨小节积累，至少要有二十个汉字。\n"
        "## (三)阅读《岳阳楼记》，完成12-14题。\n庆历四年春，滕子京谪守巴陵郡。"
    )
    assert material_group_reason(body) == "cross_section"


def test_material_group_reason_detects_label_fragment():
    assert material_group_reason("【乙】\n![](a.jpg)\n【丙】") == "no_article"


class _Store:
    def __init__(self, root: Path):
        self.root = root

    def put(self, rel: str, src: Path) -> None:
        dest = self.root / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(src.read_bytes())


def test_write_material_doc_writes_md_and_images(tmp_path):
    assets = tmp_path / "assets"
    src_dir = tmp_path / "src"
    src_dir.mkdir()
    (src_dir / "a.jpg").write_bytes(b"img-a")
    body = "## 醉翁亭记\n\n环滁皆山也。\n\n![](images/a.jpg)"

    def resolver(ref: str):
        for c in (src_dir / ref, src_dir / "images" / Path(ref).name, src_dir / Path(ref).name):
            if c.exists():
                return c
        return None

    key, url = write_material_doc(
        body,
        resolver=resolver,
        store=_Store(assets),
        assets_dir=assets,
        subject_code="chinese",
    )

    assert url == f"materials/chinese/{key}/content.md"
    md = (assets / url).read_text(encoding="utf-8")
    assert "## 醉翁亭记" in md
    assert f"materials/chinese/{key}/fig_01.jpg" in md
    assert (assets / f"materials/chinese/{key}/fig_01.jpg").exists()


def test_build_groups_by_paper_and_normalized_text():
    rows = [
        {"id": 1, "paper_id": 667, "source": "八中", "material_text": "## 醉翁亭记\n\n甲"},
        {"id": 2, "paper_id": 667, "source": "八中", "material_text": "## 醉翁亭记\n\n甲"},
        {"id": 3, "paper_id": 667, "source": "八中", "material_text": "## 前言\n\n乙"},
    ]
    groups = build_groups(rows)
    assert len(groups) == 2
    assert sorted(len(v) for v in groups.values()) == [1, 2]


def test_rewrite_hash_for_row_uses_material_url():
    row = {"content": "题干", "options": None, "material_text": None,
           "material_url": "materials/chinese/aaa/content.md"}
    h = rewrite_hash_for_row(row)
    assert len(h) == 64


def test_write_material_doc_strips_page_marker_before_instruction(tmp_path):
    """页码在小节指令之前时，指令也必须被删；否则同 doc_key 会写出两份不同正文。"""
    assets = tmp_path / "assets"
    src_dir = tmp_path / "src"
    src_dir.mkdir()
    body = (
        "第 1 页 共 8 页\n"
        "## (三)阅读下面《醉翁亭记》，完成 12-14题。(共 7分)\n\n"
        "## 醉翁亭记\n\n环滁皆山也。"
    )
    key_with_marker, _ = write_material_doc(
        body, resolver=lambda ref: None, store=_Store(assets), assets_dir=assets,
    )
    key_without_marker, _ = write_material_doc(
        strip_section_instruction("## 醉翁亭记\n\n环滁皆山也。"),
        resolver=lambda ref: None, store=_Store(assets), assets_dir=assets,
    )
    assert key_with_marker == key_without_marker
    md = (assets / f"materials/chinese/{key_with_marker}/content.md").read_text(encoding="utf-8")
    assert "第 1 页" not in md
    assert "完成 12-14题" not in md
    assert md.startswith("## 醉翁亭记")


def test_write_material_doc_dry_run_does_not_write(tmp_path):
    assets = tmp_path / "assets"
    key, url = write_material_doc(
        "## 醉翁亭记\n\n正文", resolver=lambda ref: None,
        store=_Store(assets), assets_dir=assets, dry_run=True,
    )
    assert url == f"materials/chinese/{key}/content.md"
    assert not (assets / url).exists()


def test_doc_key_paper_scoped_same_content_different_papers():
    from chinese_material_doc import paper_scope_for
    body = "## 文章\n正文内容一样。"
    a = doc_key(body, [], paper_scope=paper_scope_for("语文/卷A", "卷A"))
    b = doc_key(body, [], paper_scope=paper_scope_for("语文/卷B", "卷B"))
    assert a != b, "同一段内容在不同试卷必须得到不同 key"
    assert a == doc_key(body, [], paper_scope=paper_scope_for("语文/卷A", "卷A"))


def test_doc_key_without_paper_scope_stable():
    body = "## 文章\n正文。"
    assert doc_key(body, []) == doc_key(body, [], paper_scope=None)


def test_same_article_tolerates_typo_and_annotations():
    from chinese_material_doc import same_article
    doc = "该中心舟搔传统展馆局限，融入市民生活，成为北京航天科普新地标。"
    fixed = "该中心开拓传统展馆局限，融入市民生活，成为北京航天科普新地标。"
    marked = "<u>该中心开拓传统展馆局限，融入市民生活，成为北京航天科普新地标</u>"
    other = "完全不同的另一段阅读材料，讲的是别的事情。"
    assert same_article(fixed, doc)
    assert same_article(marked, doc)
    assert not same_article(other, doc)


def test_externalize_english_materials(tmp_path):
    from chinese_material_doc import externalize_english_materials
    from models import ExamQuestion

    assets = tmp_path / "assets"
    md_dir = tmp_path / "md"
    md_dir.mkdir()

    def q(no, gid, material):
        return ExamQuestion(
            subject_id="english", group_id=gid, group_order=no,
            type="choice", content=f"q{no}", answer="A",
            difficulty=3,  # ExamQuestion 必填字段（简报示例省略，补上以通过建模校验）
            material_text=material,
            options=[{"label": "A", "text": "a"}] * 4,
        )

    items = [
        # 简报示例给组一填了卷面指令原文；但本函数消费的是 Task 1 产出，
        # Task 1 的 attach_post_material 已把该指令剥成 None，按真实契约构造。
        q(1, "一", None),
        q(13, "二", "## Passage\nText"),
        q(14, "二", "## Passage\nText"),
        q(24, "三", "## B\nText B"),
        q(38, "五", None),
    ]
    items[4].material_text = "题目①\n…\n题目②\n…"

    externalize_english_materials(
        items, md_images_dir=md_dir, assets_dir=assets,
        store=_Store(assets), paper_scope="英语/初中/first/2026/paper",
    )

    assert items[0].material_text is None and items[0].material_url is None
    assert items[1].material_text is None and items[1].material_url
    assert items[1].material_url == items[2].material_url       # 同文共用 URL
    assert items[3].material_url != items[1].material_url       # 不同篇不同 URL
    assert items[4].material_url is None and "题目①" in items[4].material_text
    assert items[1].material_url.startswith("materials/english/")
    body = (assets / items[1].material_url).read_text(encoding="utf-8")
    assert body.startswith("## Passage")
