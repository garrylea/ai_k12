"""新字段必须能穿过 ExamQuestion / LabeledQuestion，不能被 Pydantic 丢掉。"""

import json
from pathlib import Path
from types import SimpleNamespace

from question_extract import _write_exam_questions_jsonl
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


def test_jsonl_write_emits_sub_fields(tmp_path):
    """JSONL 是对外契约：key 名敲错时 `ExamQuestion(**raw)` 会按 extra='ignore'
    静默丢弃，字段凭空消失，只有读回产物才能拦住。"""
    lab = LabeledQuestion(
        group_order=26, group_id="二", content="(1) 结合材料", answer="",
        explanation=None, type="short_answer", sub_no=1, material_position="before",
    )
    source = SimpleNamespace(rel_path=Path("政治/初中/first/2026/试卷"),
                             md_path=Path("试卷.md"))
    _write_exam_questions_jsonl([lab], source, tmp_path, "politics", "junior", 2026)

    out = tmp_path / "政治/初中/first/2026/试卷/试卷.jsonl"
    row = json.loads(out.read_text(encoding="utf-8").splitlines()[0])
    assert row["sub_no"] == 1
    assert row["material_position"] == "before"
