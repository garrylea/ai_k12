from answer_sections import merge_old_then_new, split_answer_sections


def test_splits_bracket_sections():
    got = split_answer_sections(
        "【答案】C\n"
        "【分析】先判断函数图象。\n"
        "【详解】由题意得到 y=x+1。\n"
        "【点睛】注意定义域。"
    )
    assert got.recognized is True
    assert got.answer == "C"
    assert got.approach == "先判断函数图象。"
    assert got.explanation == "由题意得到 y=x+1。\n\n注意定义域。"
    assert got.issues == ()


def test_splits_colon_sections_and_markdown():
    got = split_answer_sections(
        "- **答案：** B\n"
        "__解析__：先配方。\n"
        "**详解：** 完整过程如下。"
    )
    assert got.answer == "B"
    assert got.approach == "先配方。"
    assert got.explanation == "完整过程如下。"


def test_keeps_body_and_code_fence():
    got = split_answer_sections(
        "答案：\n"
        "```svg\n"
        "【分析】代码块内不是标题\n"
        "```\n"
        "详解：\n"
        "正文"
    )
    assert got.answer == "```svg\n【分析】代码块内不是标题\n```"
    assert got.explanation == "正文"


def test_without_heading_keeps_original_answer():
    text = "解：x=2"
    got = split_answer_sections(text)
    assert got.recognized is False
    assert got.answer == text
    assert got.approach == ""
    assert got.explanation == ""


def test_preamble_before_first_heading_stays_in_answer():
    got = split_answer_sections("C\n解析：因为……")
    assert got.answer == "C"
    assert got.approach == "因为……"


def test_missing_answer_body_falls_back_with_issue():
    text = "【解析】只给了思路\n【详解】过程"
    got = split_answer_sections(text)
    assert got.answer == text
    assert "answer_body_missing" in got.issues


def test_multiple_answer_sections_are_ambiguous():
    got = split_answer_sections("答案：A\n解析：第一题\n答案：B")
    assert "multiple_answer_sections" in got.issues


def test_numbered_answer_heading_is_ambiguous():
    got = split_answer_sections("1. 答案：A\n解析：第一题")
    assert "numbered_answer_heading" in got.issues


def test_unclosed_fence_is_ambiguous():
    got = split_answer_sections("答案：C\n详解：\n```text\n未闭合")
    assert "unclosed_code_fence" in got.issues


def test_merges_old_first_and_new_after():
    assert merge_old_then_new("旧思路", "新思路") == "旧思路\n\n新思路"
    assert merge_old_then_new(None, "新思路") == "新思路"
    assert merge_old_then_new("旧思路", None) == "旧思路"
    assert merge_old_then_new("旧思路", "旧思路") == "旧思路"
