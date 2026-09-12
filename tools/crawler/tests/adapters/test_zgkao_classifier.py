"""classifier.py 的 TDD 测试。

验证分类维度、规范化文件名、存储路径生成。

计划示例（来自 .claude/plans/tools-k12-pdf-robot-txt-luminous-ripple.md）：
    data/数学/初中/first/2026/数学-初三(上)-202607-西城-期末-试卷.pdf

注意：目录用 4 位年份(2026)，文件名用 6 位 year_code(202607)。
"""

import pytest

from classifier import Classification, Classifier, resolve_semester


def make_classification(**overrides) -> Classification:
    defaults = dict(
        subject="数学",
        semester="first",
        grade="初三",
        year="2026",
        year_code="202607",
        district="西城",
        exam_type="期末",
        file_type="试卷",
    )
    defaults.update(overrides)
    return Classification(**defaults)


class TestFilename:
    def test_paper_filename_matches_plan_example(self):
        cls = make_classification()
        assert Classifier.filename(cls) == "数学-初三(上)-202607-西城-期末-试卷.pdf"

    def test_answer_filename_matches_plan_example(self):
        cls = make_classification(file_type="答案")
        assert Classifier.filename(cls) == "数学-初三(上)-202607-西城-期末-答案.pdf"

    def test_filename_uses_year_code_not_year(self):
        cls = make_classification(year="2026", year_code="202607")
        name = Classifier.filename(cls)
        assert "202607" in name
        assert "2026-" not in name  # 4 位 year 不应出现在文件名

    def test_filename_uses_chinese_semester_first(self):
        cls = make_classification(semester="first")
        assert "(上)" in Classifier.filename(cls)

    def test_filename_uses_chinese_semester_second(self):
        cls = make_classification(semester="second")
        assert "(下)" in Classifier.filename(cls)

    def test_filename_has_pdf_extension(self):
        cls = make_classification()
        assert Classifier.filename(cls).endswith(".pdf")


class TestStorageDir:
    def test_storage_dir_matches_plan_structure(self):
        cls = make_classification()
        path = Classifier.storage_dir(cls, base_dir="data")
        assert str(path) == "data/数学/初中/first/2026"

    def test_storage_dir_uses_custom_base(self):
        cls = make_classification()
        path = Classifier.storage_dir(cls, base_dir="output")
        assert str(path).startswith("output/")

    def test_storage_dir_uses_4_digit_year_not_year_code(self):
        cls = make_classification(year="2026", year_code="202607")
        path = Classifier.storage_dir(cls, base_dir="data")
        assert "2026" in str(path)
        assert "202607" not in str(path)


class TestDeriveLevel:
    @pytest.mark.parametrize("grade,expected", [
        ("初一", "初中"),
        ("初二", "初中"),
        ("初三", "初中"),
        ("高一", "高中"),
        ("高二", "高中"),
        ("高三", "高中"),
    ])
    def test_derive_level_from_grade(self, grade, expected):
        assert Classifier.derive_level(grade) == expected

    def test_unknown_grade_raises(self):
        with pytest.raises(ValueError):
            Classifier.derive_level("大学")


class TestNormalizeExamType:
    @pytest.mark.parametrize("raw,expected", [
        ("一模", "模拟一"),
        ("二模", "模拟二"),
        ("三模", "模拟三"),
        ("期中", "期中"),
        ("期末", "期末"),
        ("月考", "月考"),
    ])
    def test_normalize_exam_type(self, raw, expected):
        assert Classifier.normalize_exam_type(raw) == expected

    def test_unknown_exam_type_passes_through(self):
        assert Classifier.normalize_exam_type("周测") == "周测"


class TestClassificationFields:
    def test_level_is_derived_when_not_provided(self):
        cls = make_classification(grade="高三")
        assert cls.level == "高中"

    def test_level_uses_explicit_value_when_provided(self):
        cls = make_classification(grade="初三", level="自定义")
        assert cls.level == "自定义"


class TestResolveSemester:
    @pytest.mark.parametrize("exam_type,filename,expected", [
        # ① 表头标记优先
        ("（上）期末考", "", "first"),
        ("（下）期末考", "", "second"),
        ("上学期期末", "", "first"),
        ("第二学期期末", "", "second"),
        # ② 文件名标记
        ("期末", "2025北京海淀初二（上）期末数学.pdf", "first"),
        ("期末", "2026北京海淀初一(下)期末数学.pdf", "second"),
        # ③ 模拟考约定
        ("二模", "2026北京海淀初三二模数学 无答案.pdf", "second"),
        ("一模", "", "second"),
        ("三模", "", "second"),
        # ④ 文件名月份
        ("期末", "2026.01海淀区初三期末数学.pdf", "first"),
        ("期末", "202507海淀初三期末数学.pdf", "second"),
        # ⑤ 判不出
        ("月考", "", None),
        ("期中", "", None),
        ("期末", "", None),
        ("期末", "2026.02海淀初三期末数学.pdf", None),   # 2 月跨学期
        ("期末", "2025北京海淀初三期末数学.pdf", None),  # 年份不能被当成月份
    ])
    def test_resolve_semester(self, exam_type, filename, expected):
        assert resolve_semester(exam_type, filename=filename) == expected

    def test_exam_type_marker_beats_filename_month(self):
        assert resolve_semester("（上）期末考", filename="202506海淀初三期末.pdf") == "first"

    def test_title_marker_used_when_header_and_filename_have_none(self):
        assert resolve_semester("月考", title="2025海淀初三（下）月考数学.pdf") == "second"

    def test_bare_up_char_is_not_a_marker(self):
        # 「上海」不应被当成「上」学期
        assert resolve_semester("期末", filename="2025上海初三期末数学.pdf") is None
