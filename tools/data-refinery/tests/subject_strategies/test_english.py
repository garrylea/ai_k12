"""英语策略：A–D 四项 + 阅读理解短文按篇挂到题上。"""

from pathlib import Path

from subject_strategies import get_strategy

FIXTURE = Path(__file__).parent / "fixtures" / "english_paper.md"


def test_english_registered_with_material_attach():
    s = get_strategy("english")
    assert s.code == "english"
    assert s.material_policy().attach is True


def test_split_options_abcd():
    stem, opts = get_strategy("english").split_options(
        "1. What is it?\nA. a\nB. b\nC. c\nD. d")
    assert [o["label"] for o in opts] == ["A", "B", "C", "D"]


def test_each_reading_passage_attached_to_its_own_question():
    """同一大题内两篇短文必须各归各的题，不能把 A 篇反复挂给题 2。"""
    from question_splitter import split_page

    questions = split_page(
        FIXTURE.read_text(encoding="utf-8"), FIXTURE,
        strategy=get_strategy("english"),
    )

    assert [q.group_order for q in questions] == [1, 2]
    assert "three tips" in (questions[0].material_text or "")
    assert "healthy diet" not in (questions[0].material_text or "")
    assert "healthy diet" in (questions[1].material_text or "")
    assert "three tips" not in (questions[1].material_text or "")
