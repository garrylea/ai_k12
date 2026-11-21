from chinese_material_doc import (
    annotation_score,
    choose_canonical,
    doc_key,
    is_heading_only,
    normalize_for_group,
    strip_section_instruction,
)


def test_strip_section_instruction_drops_paper_specific_line():
    text = "## (三)阅读下面《醉翁亭记》，完成 12-14题。(共 7分)\n\n## 醉翁亭记\n\n欧阳修"
    out = strip_section_instruction(text)
    assert out.startswith("## 醉翁亭记")
    assert "完成 12-14题" not in out


def test_strip_section_instruction_keeps_article_heading():
    text = "## 前言\n\n“典则”取自唐代窦蒙……"
    assert strip_section_instruction(text) == text


def test_heading_only_true_for_mo_xie_heading():
    assert is_heading_only("## (一)默写。(共4分)") is True


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
