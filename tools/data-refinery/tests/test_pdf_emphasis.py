"""语文试卷着重号/下划线检测与注入。"""

from pathlib import Path

import pytest

from pdf_emphasis import (
    Decoration,
    decorate_text,
    detect_decorations,
    is_option_line,
    normalize_subscript_dots,
)


def dec(kind: str, line: str, text: str, page: int = 1) -> Decoration:
    start = line.index(text)
    return Decoration(page=page, kind=kind, text=text, line=line, start=start, end=start + len(text))


def test_normalize_subscript_dots_two_chars():
    assert normalize_subscript_dots("初夏高涨<sub>．．</sub>，") == (
        '初夏<span class="cn-emphasis-dot">高</span><span class="cn-emphasis-dot">涨</span>，'
    )


def test_normalize_subscript_dots_single_char():
    assert normalize_subscript_dots("方<sub>．</sub>欲行") == (
        '<span class="cn-emphasis-dot">方</span>欲行'
    )


def test_normalize_dot_spans_splits_legacy_group():
    from pdf_emphasis import normalize_dot_spans
    legacy = '<span class="cn-emphasis-dot">高涨</span>'
    assert normalize_dot_spans(legacy) == (
        '<span class="cn-emphasis-dot">高</span><span class="cn-emphasis-dot">涨</span>'
    )


def test_normalize_subscript_dots_leaves_plain_text():
    assert normalize_subscript_dots("没有标注") == "没有标注"
    assert normalize_subscript_dots(None) == ""


def test_decorate_underline_and_dots():
    line = "这场科技与青春交织的嘉年华，让热情高涨。"
    decs = [dec("underline", line, "嘉年华"), dec("dots", line, "高涨")]
    text = "材料：" + line
    out, log = decorate_text(text, decs)
    assert '<u>嘉年华</u>' in out
    assert '<span class="cn-emphasis-dot">高</span><span class="cn-emphasis-dot">涨</span>' in out
    assert all(s == "applied" for _, s in log)


def test_decorate_is_idempotent():
    line = "初夏高涨，交织的嘉年华"
    decs = [dec("dots", line, "高涨"), dec("underline", line, "嘉年华")]
    once, _ = decorate_text(line, decs)
    twice, log = decorate_text(once, decs)
    assert twice == once
    assert all(s in ("already_marked", "not_found") for _, s in log)


def test_decorate_skips_ambiguous_match():
    line = "甲方案与乙方案"
    d = dec("dots", line, "方")
    # 同一整行出现两次：上下文放到最大仍有两处，必须跳过而不是猜一个
    text = line + "；" + line
    out, log = decorate_text(text, [d])
    assert out == text
    assert log[0][1] == "ambiguous"


def test_decorate_option_uses_cjk_context_only():
    # PDF 选项行带 A. 前缀和着重号「．」，选项文本没有；按汉字上下文匹配
    line = "A.为四方．行测者所用"
    out, log = decorate_text(
        "为四方行测者所用",
        [dec("dots", line, "方")],
        radii=(4, 3, 2, 1),
        cjk_context_only=True,
    )
    assert out == '为四<span class="cn-emphasis-dot">方</span>行测者所用'
    assert log[0][1] == "applied"


def test_is_option_line():
    assert is_option_line("A.为四方行测者所用")
    assert is_option_line(" B．方欲行")
    assert not is_option_line("因为表达的是“活动开始”的意思")


PDF = (
    Path(__file__).resolve().parents[2]
    / "crawler/data/语文/初中/second/2025/语文-初三(下)-202507-海淀-模拟二-试卷.pdf"
)


@pytest.mark.skipif(not PDF.exists(), reason="本机 crawler 数据不在（CI 不带试卷 PDF）")
def test_detect_decorations_on_haidian_paper():
    """真实卷 #17：第 1 题四个加点词 + 第 2 题画线「嘉年华」必须检出。"""
    decs = detect_decorations(PDF)
    dots = {d.text for d in decs if d.kind == "dots"}
    underlines = {d.text for d in decs if d.kind == "underline"}
    assert {"高涨", "启幕", "采撷", "汇聚"} <= dots
    assert "嘉年华" in underlines
    # 不把题干里的普通「项」误判成加点字
    assert "项" not in dots


@pytest.mark.skipif(not PDF.exists(), reason="本机 crawler 数据不在（CI 不带试卷 PDF）")
def test_decorate_material_for_paper17():
    decs = detect_decorations(PDF)
    material = (
        "创新的热情在初夏高涨，探索的号角已然吹响，我校以“科技无界，创新有我”为主题的"
        "科技节盛大启幕。这场科技与青春交织的嘉年华，让同学们在思维碰撞中激发创造潜能，"
        "在实践互动中采撷科技硕果。接下来，让我们跟随小记者的脚步，共赴这场汇聚智慧的校园科技之约吧！"
    )
    out, _ = decorate_text(material, [d for d in decs if not is_option_line(d.line)])
    for word in ("高涨", "启幕", "采撷", "汇聚"):
        marked = "".join(f'<span class="cn-emphasis-dot">{ch}</span>' for ch in word)
        assert marked in out
    assert "<u>嘉年华</u>" in out
