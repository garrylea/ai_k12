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
# 内核跨行分支在 A/B/C 三段都不含图时，会把 D 行之后的尾部并入题干、D 变空
# （数学/语文共用的既有行为，不改内核）；英语策略必须先按竖排切，否则选项静默错位入库。
_VERTICAL_OPTIONS_PAPER = """# 英语试卷

1. What can we learn from the passage?

A

Students should read only when they feel relaxed.

B

Reading aloud helps remember new words.

C

Sharing books with friends makes reading fun.

D

Talking about what they read helps understanding.
"""

_VERTICAL_EXPECTED = {
    "A": "Students should read only when they feel relaxed.",
    "B": "Reading aloud helps remember new words.",
    "C": "Sharing books with friends makes reading fun.",
    "D": "Talking about what they read helps understanding.",
}


def test_vertical_options_keep_body_aligned_with_label():
    """竖排 A/B/C/D：正文必须与字母一一对应，D 不能空、D 的正文不能跑进题干。"""
    from question_splitter import split_page

    strategy = get_strategy("english")
    questions = split_page(_VERTICAL_OPTIONS_PAPER, Path("x.md"), strategy=strategy)
    assert [q.group_order for q in questions] == [1]

    stem, opts = strategy.split_options(questions[0].content)
    assert [o["label"] for o in opts] == ["A", "B", "C", "D"]
    assert [o["text"] for o in opts] == [_VERTICAL_EXPECTED[k] for k in "ABCD"]
    assert all(o["text"].strip() for o in opts)
    assert stem == "What can we learn from the passage?"
    assert "Talking about what they read" not in stem
    assert "Students should" not in stem
    # 选项正文不许被搬去材料
    assert "Students should" not in (questions[0].material_text or "")
    assert "Talking about" not in (questions[0].material_text or "")


# 「A 篇 / 题1（竖排 A–D）/ B 篇 / 题2」：篇章标签 B 后面是长段落、紧接着题 2，
# 不能因为题 1 的竖排选项也在同一大段里就把 B 判成选项标记。
_TWO_PASSAGES_PAPER = """# 英语试卷

## 一、阅读理解

A

Many students find it hard to keep a reading habit, but reading every day helps them learn new words.

1. What is the first passage mainly about?

A

Students should read for thirty minutes every day after school.

B

Students should choose books that are easy and interesting to finish.

C

Students should never take notes while they are reading at home.

D

Students should talk about their books with parents and teachers.

B

A healthy diet matters more than you think, and doctors keep saying that vegetables and fruit belong on every plate.

2. What is the second passage mainly about?

A

Children should eat more vegetables and fruit every day.

B

Children should sleep for at least eight hours every night.

C

Children should do more exercise instead of eating snacks.

D

Children should drink less water when they feel hungry.
"""


def test_second_passage_label_after_vertical_options():
    """题1 的竖排选项之后的 B 是第二篇的标签，不是第五个选项标记。"""
    from question_splitter import split_page

    strategy = get_strategy("english")
    questions = split_page(_TWO_PASSAGES_PAPER, Path("x.md"), strategy=strategy)
    assert [q.group_order for q in questions] == [1, 2]

    q1, q2 = questions
    assert "keep a reading habit" in (q1.material_text or "")
    assert "healthy diet" not in (q1.material_text or "")
    assert "healthy diet" in (q2.material_text or "")
    assert "keep a reading habit" not in (q2.material_text or "")
    assert "keep a reading habit" not in q1.content

    stem, opts = strategy.split_options(q1.content)
    assert stem == "What is the first passage mainly about?"
    assert [o["label"] for o in opts] == ["A", "B", "C", "D"]
    assert opts[3]["text"] == (
        "Students should talk about their books with parents and teachers.")
