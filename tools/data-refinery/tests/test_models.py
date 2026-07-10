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
    with pytest.raises(ValueError):
        ExamQuestion(
            subject_id="math",
            type="choice",
            difficulty=5,
            content="1+1=?",
            answer="2",
        )


def test_textbook_card_validates_card_type():
    c = TextbookCard(
        sort_order=1,
        card_type="example",
        content="例题内容",
    )
    assert c.card_type == "example"
