"""按大题区间判题型（section_analyzer）。"""

from section_analyzer import analyze_sections

PHYSICS_MD = """## 一、单项选择题（共4分）
1. 甲
A. 1
B. 2
C. 3
D. 4
2. 乙
A. 1
B. 2
C. 3
D. 4

## 二、多项选择题（共4分）
3. 丙
A. 1
B. 2
C. 3
D. 4
4. 丁
A. 1
B. 2
C. 3
D. 4

## 三、实验解答题（共8分）
5. 如图 16 是四个热学实验。请解释：
A. 说明____
B. 说明____
C. 说明____
D. 说明____
6. 小明做实验

## 四、科普阅读题（共4分）
7. 阅读短文，回答问题

## 五、计算题（共4分）
8. 求电流
"""


def test_physics_sections_map_types_by_range():
    mapping, sections = analyze_sections(PHYSICS_MD, "physics")

    assert [s.type for s in sections] == [
        "choice", "multi_choice", "short_answer", "short_answer", "calculation",
    ]
    # 实验题里出现 A/B/C/D 也必须是 short_answer（人大附第 22 题事故）
    assert mapping[5] == "short_answer"
    assert mapping[6] == "short_answer"
    assert mapping[1] == "choice" and mapping[3] == "multi_choice"


def test_missing_header_is_inferred_as_one_block():
    """大题标题丢了：缺口整段判一个题型，不逐题抖动。"""
    md = """## 一、单项选择题（共4分，每小题2分）
1. 甲
A. 1
B. 2
C. 3
D. 4
2. 乙
A. 1
B. 2
C. 3
D. 4
3. 丙
A. 1
B. 2
C. 3
D. 4
4. 丁
A. 1
B. 2
C. 3
D. 4

## 三、实验解答题（共4分）
5. 小明做实验
6. 小红做实验
"""
    mapping, sections = analyze_sections(md, "physics")

    assert any(s.inferred and s.type == "choice" for s in sections)
    assert mapping[3] == "choice" and mapping[4] == "choice"
    assert mapping[5] == "short_answer"


def test_math_answer_section_is_not_overridden():
    """数学「解答题」是混排（证明/计算），不能整节压成 short_answer。"""
    md = """## 一、选择题（共4分）
1. 甲
A. 1
B. 2
C. 3
D. 4
## 二、填空题（共4分）
2. 乙
## 三、解答题（共8分）
3. 丙
4. 丁
"""
    mapping, sections = analyze_sections(md, "math")

    assert mapping[1] == "choice"
    assert mapping[2] == "fill_blank"
    assert 3 not in mapping and 4 not in mapping, "解答题不整节覆盖"


def test_other_subjects_not_touched():
    mapping, sections = analyze_sections(PHYSICS_MD, "chinese")
    assert mapping == {} and sections == []
