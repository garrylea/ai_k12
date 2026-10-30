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


# 竖排选项：字母单独成行、选项正文在下一行（真实排版，内核 _BARE_LINE_RE 就是为它写的）。
# 选项正文故意都超过 30 字，旧实现会把 A 当篇章标签、关闭当前题，选项全变成下一篇材料。
_VERTICAL_OPTIONS_PAPER = """# 英语试卷

1. What can we learn from the passage?

A

Students should keep a reading habit and read for thirty minutes every day.

B

Students should pick books that are interesting and easy enough to finish.

C

Students should read only when they feel relaxed and never take any notes.

D

Students should talk about what they read with their parents and teachers.
"""


def test_vertical_options_are_not_mistaken_for_passage_labels():
    """裸字母 A/B/C/D 各占一行 + 正文在下一行 → 仍是选项，不能被当分篇吞掉。"""
    from question_splitter import split_page

    strategy = get_strategy("english")
    questions = split_page(_VERTICAL_OPTIONS_PAPER, Path("x.md"), strategy=strategy)

    assert [q.group_order for q in questions] == [1]
    # 选项正文不许被搬去材料（旧实现把 A 之后的整段并进了下一篇材料）
    assert "Students should" not in (questions[0].material_text or "")
    _, opts = strategy.split_options(questions[0].content)
    assert [o["label"] for o in opts] == ["A", "B", "C", "D"]
    assert all(o["text"].strip() for o in opts)
