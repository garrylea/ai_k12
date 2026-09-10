"""answer_records：JSONL 记录解析/校验 + export 序列化。"""

import json

import pytest

from answer_records import (
    AnswerRecordError,
    ExportRow,
    build_export_jsonl,
    parse_answer_records,
)


class TestParseLocators:
    def test_question_id(self):
        recs = parse_answer_records('{"question_id": 7, "answer": "B"}')
        assert len(recs) == 1
        assert recs[0].question_id == 7
        assert recs[0].answer == "B"
        assert recs[0].locator() == "questions#7"

    def test_paper_no(self):
        recs = parse_answer_records('{"paper_id": 3, "question_no": 17, "approach": "设未知数"}')
        assert (recs[0].paper_id, recs[0].question_no) == (3, 17)
        assert recs[0].locator() == "paper#3 题17"

    def test_content_hash(self):
        h = "a" * 64
        recs = parse_answer_records(json.dumps({"content_hash": h, "explanation": "过程"}))
        assert recs[0].content_hash == h
        assert recs[0].locator() == "hash:aaaaaaaa"

    def test_comment_and_blank_lines_ignored(self):
        text = "# 注释\n\n" + '{"question_id": 1, "answer": "A"}' + "\n"
        assert len(parse_answer_records(text)) == 1


class TestParseErrors:
    def test_missing_locator(self):
        with pytest.raises(AnswerRecordError, match="定位键"):
            parse_answer_records('{"answer": "B"}')

    def test_two_locators(self):
        with pytest.raises(AnswerRecordError, match="定位键"):
            parse_answer_records('{"question_id": 1, "paper_id": 2, "question_no": 3, "answer": "A"}')

    def test_paper_partial(self):
        with pytest.raises(AnswerRecordError, match="paper_id 与 question_no"):
            parse_answer_records('{"paper_id": 2, "answer": "A"}')

    def test_no_content_field(self):
        with pytest.raises(AnswerRecordError, match="内容字段"):
            parse_answer_records('{"question_id": 1}')

    def test_invalid_type(self):
        with pytest.raises(AnswerRecordError, match="题型非法"):
            parse_answer_records('{"question_id": 1, "type": "single_choice"}')

    def test_bad_json(self):
        with pytest.raises(AnswerRecordError, match="JSON"):
            parse_answer_records("{not json}")

    def test_non_object(self):
        with pytest.raises(AnswerRecordError, match="JSON 对象"):
            parse_answer_records("[1, 2]")

    def test_bad_hash(self):
        with pytest.raises(AnswerRecordError, match="content_hash"):
            parse_answer_records('{"content_hash": "xyz", "answer": "A"}')

    def test_non_positive_question_id(self):
        with pytest.raises(AnswerRecordError, match="question_id"):
            parse_answer_records('{"question_id": 0, "answer": "A"}')

    def test_non_string_value(self):
        with pytest.raises(AnswerRecordError, match="answer"):
            parse_answer_records('{"question_id": 1, "answer": 123}')

    def test_duplicate_locator(self):
        text = '{"question_id": 1, "answer": "A"}\n{"question_id": 1, "answer": "B"}\n'
        with pytest.raises(AnswerRecordError, match="重复"):
            parse_answer_records(text)

    def test_empty_file(self):
        with pytest.raises(AnswerRecordError, match="没有任何有效记录"):
            parse_answer_records("\n# only comment\n")


class TestNormalization:
    def test_empty_strings_become_none(self):
        recs = parse_answer_records('{"question_id": 1, "answer": "", "approach": "  ", "explanation": "x"}')
        assert recs[0].answer is None
        assert recs[0].approach is None
        assert recs[0].explanation == "x"

    def test_has_content_false_when_all_empty(self):
        recs = parse_answer_records('{"question_id": 1, "answer": "", "approach": ""}')
        assert recs[0].has_content() is False

    def test_has_content_true(self):
        recs = parse_answer_records('{"question_id": 1, "approach": "配方"}')
        assert recs[0].has_content() is True

    def test_note_preserved(self):
        recs = parse_answer_records('{"question_id": 1, "answer": "A", "note": "核对过"}')
        assert recs[0].note == "核对过"


class TestExport:
    def test_round_trip_ignores_ref(self):
        rows = [ExportRow(question_id=9, content="题干", type="choice", answer="A",
                          options="[]", approach=None, explanation="旧解析",
                          paper_id=3, question_no=1)]
        recs = parse_answer_records(build_export_jsonl(rows))
        assert len(recs) == 1
        r = recs[0]
        assert r.question_id == 9
        assert r.answer is None and r.approach is None and r.explanation is None
        assert r.has_content() is False

    def test_ref_contains_old_values(self):
        rows = [ExportRow(question_id=9, content="题干", type="choice", answer="A",
                          explanation="旧解析")]
        obj = json.loads(build_export_jsonl(rows).strip())
        assert obj["_ref"]["answer"] == "A"
        assert obj["_ref"]["explanation"] == "旧解析"
        assert obj["answer"] == ""

    def test_empty_rows(self):
        assert build_export_jsonl([]) == ""
