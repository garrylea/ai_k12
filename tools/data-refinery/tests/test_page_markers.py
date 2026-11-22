from page_markers import (
    BARE_PAGE_RE,
    BARE_TOTAL_RE,
    PAGE_MARKER_RE,
    is_page_marker_line,
    strip_page_markers,
)


def clean(text: str) -> str:
    return strip_page_markers(text)[0]


def test_empty_text_unchanged():
    assert strip_page_markers("") == ("", [])


def test_no_marker_unchanged():
    text = "24. 题干内容\n\n25. 下一题"
    assert strip_page_markers(text) == (text, [])


# 强锚点：第N页 + 共M页 / 斜杠


def test_strong_marker_fullwidth_parens():
    assert clean("第5页（共8页）") == ""


def test_strong_marker_halfwidth_parens():
    assert clean("第5页(共8页)") == ""


def test_strong_marker_no_parens_spaces():
    assert clean("第 1 页 共 5 页") == ""


def test_strong_marker_slash():
    assert clean("第2页/共6页") == ""


def test_strong_marker_fullwidth_slash():
    assert clean("第2页／6页") == ""


def test_strong_marker_comma():
    assert clean("第2页，共6页") == ""


def test_strong_marker_fullwidth_digits():
    assert clean("第５页（共８页）") == ""


def test_strong_marker_spaces_inside_parens():
    assert clean("第 5 页 （ 共 8 页 ）") == ""


# 弱锚点：整行只剩页码碎片


def test_bare_total_page():
    assert clean("共6页") == ""


def test_bare_page_only():
    assert clean("第5页") == ""


def test_bare_patterns_do_not_match_embedded_text():
    assert BARE_TOTAL_RE.match("本试卷共6页") is None
    assert BARE_PAGE_RE.match("请阅读第 2 页") is None


# 整行纯页眉/页脚


def test_running_head_answer_reference():
    assert clean("语文试卷答案及评分参考 第 1页（共 5页）") == ""


def test_running_head_region_and_answer_reference():
    assert clean(
        "北京市西城区九年级模拟测试试卷 数学答案及评分参考 2026.5 第2页（共6页）"
    ) == ""


def test_running_head_with_chinese_date():
    assert clean(
        "北京市西城区九年级模拟测试试卷 数学答案及评分参考 2026年5月 第2页（共6页）"
    ) == ""


def test_date_only_with_chinese_date():
    assert clean("2026年5月 第2页（共6页）") == ""


def test_paper_head_without_answer_words():
    assert clean("北京市西城区九年级模拟测试试卷 第2页（共6页）") == ""


def test_subject_head_without_answer_words():
    assert clean("语文 第5页（共8页）") == ""


def test_grade_subject_paper_head():
    assert clean("九年级物理试卷答案及评分标准 第2页（共2页）") == ""


def test_heading_prefix_is_not_left_behind():
    assert clean("# 第5页（共8页）") == ""


def test_heading_with_footer_keeps_heading_text():
    # 标题词「评分参考」不能被当运行页眉一起删掉
    assert clean("## 27．评分参考 第5页（共8页）") == "## 27．评分参考"


def test_protected_marker_does_not_trigger_whole_line_delete():
    text = "第5页（共8页）<table><tr><td>第6页（共8页）</td></tr></table>"
    cleaned, hits = strip_page_markers(text)
    assert cleaned == "<table><tr><td>第6页（共8页）</td></tr></table>"
    assert any(h.removed is False for h in hits)


# 行内删除


def test_inline_scoring_note_kept_page_footer_removed():
    text = "…（2分，每空 1 分。有错该空不得分）语文试卷答案及评分参考 第 1页（共 5页）"
    assert clean(text) == "…（2分，每空 1 分。有错该空不得分）"


def test_inline_fullwidth_scoring_note_kept():
    text = "（２分）语文试卷答案及评分参考 第5页（共8页）"
    assert clean(text) == "（２分）"


def test_inline_material_join_next_line():
    text = "⑪…全留在一桥一水一九年级（语文）第8页（共11页）\n人家之间了……"
    assert clean(text) == "⑪…全留在一桥一水一人家之间了……"


def test_multiple_markers_on_one_line():
    assert clean("…一第5页（共8页）中第6页（共8页）后") == "…一中后"


def test_page_reference_in_sentence_is_kept():
    text = "请阅读第 2 页的问题 1"
    assert clean(text) == text


def test_paper_reference_without_header_words_keeps_sentence():
    # 「请」被 _PAPER_HEAD_RE 排除；只删标记，句子留下
    assert clean("请参考试卷 第5页（共8页）") == "请参考试卷"


# 负例


def test_notice_total_pages_kept():
    text = "本试卷共8页，共两部分，28道题。"
    assert clean(text) == text


def test_notice_total_pages_fullwidth_digits_kept():
    text = "本试卷共６页，满分100分。"
    assert clean(text) == text


def test_bare_digits_kept():
    text = "1\n2\n3\n4"
    assert clean(text) == text


def test_english_page_number_not_supported_yet():
    text = "Page 1 of 8"
    assert clean(text) == text


def test_chinese_numeral_page_not_supported_yet():
    text = "第一页（共八页）"
    assert clean(text) == text


def test_date_plus_bare_page_kept():
    text = "2026.5 第2页"
    assert clean(text) == text


# 行尾续行合并不该发生的情况


def test_do_not_join_section_header():
    text = "…一桥一水一第5页（共8页）\n（二）下一节"
    assert clean(text) == "…一桥一水一\n（二）下一节"


def test_do_not_join_next_question():
    text = "…一桥一水一第5页（共8页）\n25. 下一题"
    assert clean(text) == "…一桥一水一\n25. 下一题"


def test_do_not_join_image_line():
    text = "…一桥一水一第5页（共8页）\n![img](x)"
    assert clean(text) == "…一桥一水一\n![img](x)"


def test_join_across_blank_line():
    # 真实八一学校 case：页脚后有一个空行，续行仍要并回同一句
    text = "…一桥一水一第5页（共8页）\n\n人家之间了"
    assert clean(text) == "…一桥一水一人家之间了"


def test_do_not_join_blank_line_before_structure():
    text = "…一桥一水一第5页（共8页）\n\n（二）下一节"
    assert clean(text) == "…一桥一水一\n\n（二）下一节"


def test_do_not_join_answer_field():
    text = "…一桥一水一第5页（共8页）\n答案：D"
    assert clean(text) == "…一桥一水一\n答案：D"


# 护栏


def test_fenced_block_untouched():
    text = "```\n第5页（共8页）\n```"
    cleaned, hits = strip_page_markers(text)
    assert cleaned == text
    assert len(hits) == 1 and hits[0].removed is False


def test_inline_html_tag_untouched():
    text = '<span title="第1页（共5页）">x</span>'
    cleaned, hits = strip_page_markers(text)
    assert cleaned == text
    assert len(hits) == 1 and hits[0].removed is False


def test_single_line_table_untouched():
    text = "<table><tr><td>第1页（共5页）</td></tr></table>"
    cleaned, hits = strip_page_markers(text)
    assert cleaned == text
    assert len(hits) == 1 and hits[0].removed is False


def test_multiline_table_untouched():
    text = "<table>\n<tr><td>第5页（共8页）</td></tr>\n</table>"
    cleaned, hits = strip_page_markers(text)
    assert cleaned == text
    assert len(hits) == 1 and hits[0].removed is False


def test_bare_total_inside_table_untouched():
    text = "<table>\n共6页\n</table>"
    cleaned, hits = strip_page_markers(text)
    assert cleaned == text
    assert len(hits) == 1 and hits[0].removed is False


def test_table_footer_after_close_removed():
    text = "<table><tr><td>x</td></tr></table> 第5页（共8页）"
    assert clean(text) == "<table><tr><td>x</td></tr></table>"


# 幂等 / 行号 / 换行


def test_idempotent():
    text = "a\n语文试卷答案及评分参考 第 1页（共 5页）\n共6页\nb"
    once = clean(text)
    assert clean(once) == once


def test_hit_line_number_is_one_based_original_text():
    text = "a\n第5页（共8页）\nb"
    _, hits = strip_page_markers(text)
    assert hits[0].line_no == 2


def test_crlf_normalized_but_content_kept():
    text = "a\r\n第5页（共8页）\r\nb"
    assert clean(text) == "a\nb"


# is_page_marker_line


def test_is_page_marker_line_true():
    assert is_page_marker_line("第5页（共8页）")
    assert is_page_marker_line("共6页")
    assert is_page_marker_line("第5页")


def test_is_page_marker_line_false():
    assert not is_page_marker_line("本试卷共6页")
    assert not is_page_marker_line("（二）")
    assert not is_page_marker_line("<table><tr><td>第1页（共5页）</td></tr></table>")


# 弱锚点：「第」字丢失，只剩「2页 共7页」（昌平一中语文 2024 实测）


def test_bare_page_total_without_di():
    assert clean("2页 共7页") == ""


def test_bare_page_total_fullwidth_comma_and_digits():
    assert clean("２页，共７页") == ""


def test_bare_page_total_does_not_touch_exam_notice():
    for line in ("本试卷共8页，共三道大题", "答题卡共2页", "第2页 共7页"):
        assert strip_page_markers(line)[0] == ("" if line == "第2页 共7页" else line)


def test_bare_page_total_in_body_sentence_kept():
    text = "材料共 7 页，其中 2页 共7页 是答案"  # 非整行，不动
    assert clean(text) == text


def test_bare_page_total_is_structure_line():
    assert is_page_marker_line("2页 共7页")
    assert is_page_marker_line("共7页")


# 重复的卷名/考试名（运行页眉，MinerU 夹在最后一题与答案区之间）
RUNNING_TITLE_DOC = """# 2026—2027 学年度第一学期北京市第三十五中学期中质量检测

# 初三数学

28. 最后一道题
![](images/q28.jpg)

# 北京市第三十五中学

# 2026—2027 学年度第一学期期中质量检测

# 数学答案

1. D
"""


def test_running_title_removed():
    out = clean(RUNNING_TITLE_DOC)
    assert "# 北京市第三十五中学" not in out
    assert "# 2026—2027 学年度第一学期期中质量检测" not in out
    assert "![](images/q28.jpg)" in out
    assert "# 数学答案" in out
    # 卷首标题本身不能删
    assert "# 2026—2027 学年度第一学期北京市第三十五中学期中质量检测" in out


def test_non_heading_repeat_kept():
    doc = "# 某某中学期中质量检测\n\n28. 题干\n\n期中质量检测\n"
    assert "期中质量检测" in clean(doc).split("28.")[1]


def test_unrelated_heading_kept():
    doc = "# 某某中学期中质量检测\n\n## 三、解答题\n\n28. 题干\n"
    assert "## 三、解答题" in clean(doc)


def test_answer_heading_sharing_prefix_with_title_kept():
    """卷首是「…试卷」、答案区是「…参考答案」：共享 8 字前缀也不能删。"""
    doc = (
        "# 初三年级数学学科试卷\n\n"
        "1. 题干\n\n"
        "# 初三年级数学学科参考答案\n\n"
        "1. D\n"
    )
    out = clean(doc)
    assert "# 初三年级数学学科参考答案" in out


def test_section_header_repeated_is_not_running_title():
    """「## 一、基础运用（共10分）」是章节标题，不是卷名。"""
    doc = (
        "## 一、基础运用（共10分）\n\n"
        "1. 题干\n\n"
        "## 参考答案\n\n"
        "## 一、基础运用（共10分）\n\n"
        "1. C\n"
    )
    out = clean(doc)
    assert out.count("## 一、基础运用（共10分）") == 2


def test_do_not_join_paragraph_start_after_footer():
    """页脚后是①开头的新段落：不能拼进上一段（2026-11-22 并段事故）。"""
    text = "…一桥一水一第5页（共8页）\n\n①下一段开头"
    assert clean(text) == "…一桥一水一\n\n①下一段开头"


def test_do_not_join_parenthesized_number_paragraph():
    text = "…一桥一水一第5页（共8页）\n\n（1）下一段开头"
    assert clean(text) == "…一桥一水一\n\n（1）下一段开头"
