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


def test_parse_nested_layout_full_paper():
    m = parse_paper_meta(
        "数学/初中/second/2024/数学-初三(下)-202407-海淀-模拟二-试卷/"
        "数学-初三(下)-202407-海淀-模拟二-试卷.jsonl"
    )
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


def test_parse_nested_layout_answer():
    m = parse_paper_meta(
        "数学/初中/second/2024/数学-初三(下)-202407-海淀-模拟二-答案/"
        "数学-初三(下)-202407-海淀-模拟二-答案.jsonl"
    )
    assert m is not None
    assert m.file_type == "答案"
    assert m.grade_band == "junior"
    assert m.semester == "second"
    assert m.year == 2024


def test_parse_nested_dir_name_mismatch_returns_none():
    assert (
        parse_paper_meta(
            "数学/初中/second/2024/数学-初三(下)-202407-海淀-模拟一-试卷/"
            "数学-初三(下)-202407-海淀-模拟二-试卷.jsonl"
        )
        is None
    )


def test_district_with_school_keeps_only_district_in_column():
    """爬虫汇总表文件名是 `海淀·一零一中学`：入库 district 必须是 `海淀`，
    否则 /exams 的 district 精确筛选（p.district = ?）会漏掉这些卷子。"""
    m = parse_paper_meta("数学/初中/first/2025/数学-初三(上)-202507-海淀·一零一中学-（上）期中-试卷.jsonl")
    assert m is not None
    assert m.district == "海淀"
    assert m.title == "2025 海淀·一零一中学 初三 （上）期中"
