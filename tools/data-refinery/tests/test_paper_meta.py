import pytest

from paper_meta import parse_paper_meta


def test_parse_full_path():
    m = parse_paper_meta("数学/初中/second/2024/数学-初三(下)-202407-海淀-模拟二-试卷.jsonl")
    assert m is not None
    assert m.subject == "数学"
    assert m.grade == "初三"
    assert m.grade_band == "junior"
    assert m.semester == "second"
    assert m.year == 2024
    assert m.district == "海淀"
    assert m.exam_type == "模拟二"
    assert m.file_type == "试卷"
    assert m.title == "2024 海淀 初三 模拟二"


def test_parse_first_semester_primary():
    m = parse_paper_meta("数学/小学/first/2023/数学-小六(上)-202301-东城-期中-试卷.jsonl")
    assert m is not None
    assert m.grade_band == "primary"
    assert m.semester == "first"
    assert m.year == 2023


def test_parse_senior():
    m = parse_paper_meta("数学/高中/first/2025/数学-高一(上)-202509-西城-期末-答案.jsonl")
    assert m is not None
    assert m.grade_band == "senior"
    assert m.file_type == "答案"


def test_parse_invalid_returns_none():
    assert parse_paper_meta("random/file.jsonl") is None
    assert parse_paper_meta("") is None
