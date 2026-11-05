import pytest

from models import ExamQuestion, TextbookCard


def test_exam_question_validates_type():
    q = ExamQuestion(
        subject_id="math",
        type="choice",
        difficulty=2,
        content="1+1=?",
        answer="2",
    )
    assert q.type == "choice"


def test_exam_question_rejects_invalid_type():
    with pytest.raises(ValueError):
        ExamQuestion(
            subject_id="math",
            type="invalid",
            difficulty=2,
            content="1+1=?",
            answer="2",
        )


def test_exam_question_rejects_out_of_range_difficulty():
    """难度合法范围 1-5（5 档），6 越界报错。"""
    with pytest.raises(ValueError):
        ExamQuestion(
            subject_id="math",
            type="choice",
            difficulty=6,
            content="1+1=?",
            answer="2",
        )
    with pytest.raises(ValueError):
        ExamQuestion(
            subject_id="math",
            type="choice",
            difficulty=0,
            content="1+1=?",
            answer="2",
        )


def test_exam_question_accepts_5_tier_difficulty():
    """5 档难度边界值 1/5 合法。"""
    q = ExamQuestion(subject_id="math", type="choice", difficulty=5,
                     content="压轴题", answer="C")
    assert q.difficulty == 5


def test_textbook_card_validates_card_type():
    c = TextbookCard(
        sort_order=1,
        card_type="example",
        content="例题内容",
    )
    assert c.card_type == "example"


def test_exam_question_accepts_calculation_type():
    """labeler 允许 calculation，publish 的 Literal 也必须收，否则会整卷发布失败。"""
    q = ExamQuestion(subject_id="math", type="calculation", difficulty=2, content="求值", answer="1")
    assert q.type == "calculation"


def test_exam_question_accepts_multi_choice_type():
    """section_analyzer 把「多项选择」标成 multi_choice，前后端/DB 都已支持，
    publish 的 Literal 也必须收，否则会整卷发布失败（2026-11-03 汇文物理卷事故）。"""
    q = ExamQuestion(subject_id="physics", type="multi_choice", difficulty=2,
                     content="多选", answer="ABD")
    assert q.type == "multi_choice"


def test_exam_question_keeps_needs_review_flag():
    q = ExamQuestion(subject_id="chinese", type="choice", difficulty=2, content="题干", answer="A", needs_review=True)
    assert q.needs_review is True


def test_exam_question_keeps_knowledge_points_through_model_dump():
    """publish 用 `ExamQuestion(**raw)` + `model_dump()` 重建记录。

    模型里没有的字段会被 Pydantic 静默丢弃 —— 2026-11-05 之前 `knowledge_points`
    就是这样丢的，导致题目入库后永远没有知识点、进不了专项练习。
    """
    q = ExamQuestion(subject_id="math", type="choice", difficulty=2,
                     content="1+1=?", answer="2",
                     knowledge_points=["M0306", "M0101"])
    assert q.knowledge_points == ["M0306", "M0101"]
    assert q.model_dump(mode="json")["knowledge_points"] == ["M0306", "M0101"]


def test_exam_question_knowledge_points_optional():
    q = ExamQuestion(subject_id="math", type="choice", difficulty=2, content="x", answer="1")
    assert q.knowledge_points is None
