"""新字段必须能穿过 ExamQuestion / LabeledQuestion，不能被 Pydantic 丢掉。"""

from question_labeler import LabeledQuestion
from models import ExamQuestion
from question_splitter import RawQuestion


def test_exam_question_keeps_sub_fields():
    q = ExamQuestion(
        subject_id="politics", type="short_answer", difficulty=2,
        content="(1) 结合材料", answer="", sub_no=1,
        material_position="before",
    )
    dumped = q.model_dump(mode="json")
    assert dumped["sub_no"] == 1
    assert dumped["material_position"] == "before"


def test_labeled_from_raw_copies_sub_fields():
    raw = RawQuestion(group_order=26, group_id="二", content="(1) x",
                      sub_no=2, material_position="before")
    lab = LabeledQuestion.from_raw(raw)
    assert lab.sub_no == 2
    assert lab.material_position == "before"


def test_defaults_stay_backwards_compatible():
    q = ExamQuestion(subject_id="math", type="choice", difficulty=1,
                     content="1+1", answer="A")
    assert q.model_dump()["sub_no"] == 0
    assert q.model_dump()["material_position"] is None
