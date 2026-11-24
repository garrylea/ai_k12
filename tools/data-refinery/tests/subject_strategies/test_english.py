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


_FIVE_PARTS_MD = """# 英语试卷

## 一、单项填空
从下面各题所给的 A、B、C、D 四个选项中，选择可以填入空白处的最佳选项。
1. We visit \\_\\_\\_\\_ grandparents.
A. we B. us C. our D. ours

## 二、完形填空
阅读下面的短文，掌握其大意，然后从短文后各题所给的 A、B、C、D 四个选项中，选择最佳选项。
The Unexpected Detour
Last summer, our bus broke down. Mr. Evans, \\_13\\_ said "Let's explore."

13. A. simply B. hopelessly C. mainly D. properly

## 三、阅读理解
## B
Jameson stood outside the kitchen. He felt bored.

14. How did Jameson feel?
A. Hopeful. B. Happy. C. Worried. D. Bored.

## 四、阅读表达
## 第二部分
## 本部分共 5 题，共 20 分。根据题目要求，完成相应任务。 四、阅读表达(34-36题，共10分)
阅读短文，根据短文内容回答问题。
## Be Smart About Your Smartphone
Losing your phone is a bad thing.

34. How did the author feel?

## 五、文段表达
38.从下面两个题目中任选一题，完成一篇不少于50词的英语文段写作。请不要写出你的校名和姓名。

题目①
假设你是李华。

提示词语: reuse, donate

题目②
在生活中，你一定拍摄过很多美好的画面。

提示词: beautiful, friend
"""


def test_five_parts_material_assignment():
    from pathlib import Path
    from question_splitter import split_page
    from subject_strategies import get_strategy

    qs = split_page(_FIVE_PARTS_MD, Path("x.md"), strategy=get_strategy("english"))
    by = {q.group_order: q for q in qs}

    assert by[1].material_text is None                       # 一：单选说明清掉
    assert "simply" in (by[13].content or "")                 # 二：题干原文（选项）留给 extract 再拆
    assert "\\_13\\_" in (by[13].material_text or "")        # 空格标记保留
    assert "阅读下面的短文" not in (by[13].material_text or "")
    assert (by[14].material_text or "").startswith("## B")   # 三：篇章标题保留
    assert (by[34].material_text or "").startswith(
        "## Be Smart About Your Smartphone")                 # 四：文章标题保留
    assert "本部分共" not in (by[34].material_text or "")
    assert (by[38].content or "").startswith("从下面两个题目中任选一题")
    assert "题目①" in (by[38].material_text or "")
    assert "题目②" in (by[38].material_text or "")


def test_cloze_truncated_duplicate_number_is_restored_from_blank_marker():
    """完形题号 15 OCR 成 5：前文已有 5 时，按文章里的 _15_ 恢复题号。"""
    from question_splitter import split_page

    text = """# 英语试卷

## 一、单项填空
5. Earlier question
A. a B. b C. c D. d

## 二、完形填空
The passage has blanks \\_13\\_, \\_14\\_ and \\_15\\_.

13. A. simply B. hopelessly C. mainly D. properly

14. A. action B. policy C. words D. spirit

5. A. suffered B. recorded C. examined D. followed

16. A. stories B. ideas C. experiences D. records
"""

    questions = split_page(text, Path("x.md"), strategy=get_strategy("english"))
    by_no = {q.group_order: q for q in questions}

    assert [q.group_order for q in questions] == [5, 13, 14, 15, 16]
    assert by_no[15].content.startswith("A. suffered")
    assert "\\_15\\_" in (by_no[15].material_text or "")


def test_cloze_truncated_number_is_not_restored_without_blank_marker():
    """文章没有 _15_ 时，重复的 5 仍是 OCR 重复，不能顺延成 15。"""
    from question_splitter import split_page

    text = """# 英语试卷

## 一、单项填空
5. Earlier question
A. a B. b C. c D. d

## 二、完形填空
The passage has blanks \\_13\\_ and \\_14\\_.

13. A. simply B. hopelessly C. mainly D. properly

14. A. action B. policy C. words D. spirit

5. A. suffered B. recorded C. examined D. followed

16. A. stories B. ideas C. experiences D. records
"""

    questions = split_page(text, Path("x.md"), strategy=get_strategy("english"))
    assert [q.group_order for q in questions] == [5, 13, 14, 16]


_GROUPED_ANSWERS_PAPER = """# 英语试卷

## 一、单项填空
1. Question 1
2. Question 2
3. Question 3
4. Question 4
5. Question 5
6. Question 6
7. Question 7
8. Question 8
9. Question 9
10. Question 10
11. Question 11
12. Question 12

## 参考答案

1-5 CBBCD
6-10 CBABC
11-12 BB
"""


def test_english_expands_grouped_choice_answers_to_printed_question_numbers():
    """英语答案区的 `1-5 CBBCD` 必须展开成 1:C、2:B…5:D，而不是整行丢弃。"""
    answers = get_strategy("english").extract_answers(
        _GROUPED_ANSWERS_PAPER,
        Path("english/初中/first/2026/卷-试卷.md"),
    )
    by_no = {a.no: a.answer for a in answers}

    assert [by_no[no] for no in range(1, 13)] == [
        "C", "B", "B", "C", "D",
        "C", "B", "A", "B", "C",
        "B", "B",
    ]


def test_english_grouped_answer_count_mismatch_is_reported_without_guessing():
    """`1-3 AB` 只有两个答案：不能猜第 3 题，必须留下可人工处理的 issue。"""
    text = """# 英语试卷

## 一、单项填空
1. Question 1
2. Question 2
3. Question 3

## 参考答案

1-3 AB
"""
    answers = get_strategy("english").extract_answers(
        text,
        Path("english/初中/first/2026/卷-试卷.md"),
    )

    assert all(not item.answer for item in answers)
    issues = [issue for item in answers for issue in item.issues]
    assert any("1-3" in issue and "2" in issue and "3" in issue for issue in issues)


def test_english_grouped_answers_survive_missing_split_question():
    """答案区解析独立于切题：21–23 题干没切出时，区间答案仍不能被静默吞掉。"""
    text = """# 英语试卷

## 三、阅读理解
1. Question 1
3. Question 3

## 参考答案

1-3 ABC
"""
    answers = get_strategy("english").extract_answers(
        text,
        Path("english/初中/first/2026/卷-试卷.md"),
    )
    by_no = {item.no: item.answer for item in answers}

    assert by_no[1] == "A"
    assert by_no[2] == "B"
    assert by_no[3] == "C"
