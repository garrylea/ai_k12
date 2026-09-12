from pathlib import Path
from unittest.mock import MagicMock, patch

from convert_cli import (
    _load_material_entries,
    _match_filters,
    _match_materials,
    _match_source,
    _parse_dimensions,
    main,
)
from scanner import Material


def _paper(rel: str) -> Material:
    """构造试卷素材：{学科}/{学段}/{first|second}/{年份}/{试卷名}"""
    return Material(kind="pdf", source_dir=Path("."), rel_path=Path(rel), input_paths=[])


def _textbook(rel: str) -> Material:
    """构造教材素材：{学科}/{学段}/{出版社}/{年级}/{上册|下册}/{书名}"""
    return Material(kind="images", source_dir=Path("."), rel_path=Path(rel), input_paths=[])


def _run_dry_run(tmp_path, scanned, argv, capsys) -> str:
    """用 mock 的 scanner 跑一次 --dry-run，返回 stdout。"""
    with patch("convert_cli.RefineryConfig") as mock_config, \
         patch("convert_cli.MaterialScanner") as mock_scanner:
        mock_config.from_env.return_value = MagicMock(
            input_dir=tmp_path,
            output_dir=tmp_path / "out",
        )
        mock_scanner.return_value.scan.return_value = scanned
        main(["--input-dir", str(tmp_path), "--dry-run", *argv])
    return capsys.readouterr().out


class TestMatchSource:
    def test_all_passes_everything(self):
        m = Material(kind="pdf", source_dir=Path("."), rel_path=Path("数学/初中/试卷"), input_paths=[])
        assert _match_source(m, "all") is True

    def test_zgkao_matches_exam_paper(self):
        m = Material(kind="pdf", source_dir=Path("."), rel_path=Path("数学/初中/试卷"), input_paths=[])
        assert _match_source(m, "zgkao") is True

    def test_zgkao_matches_answer(self):
        m = Material(kind="pdf", source_dir=Path("."), rel_path=Path("数学/初中/答案"), input_paths=[])
        assert _match_source(m, "zgkao") is True

    def test_zgkao_rejects_textbook(self):
        m = Material(kind="images", source_dir=Path("."), rel_path=Path("数学/初中/书"), input_paths=[])
        assert _match_source(m, "zgkao") is False

    def test_smartedu_matches_images(self):
        m = Material(kind="images", source_dir=Path("."), rel_path=Path("数学/初中/书"), input_paths=[])
        assert _match_source(m, "smartedu") is True

    def test_smartedu_rejects_exam(self):
        m = Material(kind="pdf", source_dir=Path("."), rel_path=Path("数学/初中/试卷"), input_paths=[])
        assert _match_source(m, "smartedu") is False


class TestMatchMaterials:
    def test_no_entries_passes_everything(self):
        m = Material(kind="images", source_dir=Path("."), rel_path=Path("数学/初中/人教版/九年级/上册/书A"), input_paths=[])
        assert _match_materials(m, []) is True

    def test_entry_substring_match(self):
        m = Material(kind="images", source_dir=Path("."), rel_path=Path("数学/初中/人教版/九年级/上册/书A"), input_paths=[])
        assert _match_materials(m, ["九年级/上册/书A"]) is True
        assert _match_materials(m, ["书A"]) is True

    def test_entry_no_match(self):
        m = Material(kind="images", source_dir=Path("."), rel_path=Path("数学/初中/人教版/九年级/上册/书A"), input_paths=[])
        assert _match_materials(m, ["书B"]) is False

    def test_any_entry_matches(self):
        m = Material(kind="images", source_dir=Path("."), rel_path=Path("数学/初中/书A"), input_paths=[])
        assert _match_materials(m, ["书B", "书A"]) is True


class TestParseDimensions:
    def test_paper_flat_layout(self):
        dims = _parse_dimensions(Path("数学/初中/second/2025/数学-初三(下)-202507-海淀-模拟二-试卷"))
        assert dims == {"subject": "数学", "stage": "junior", "term": "second", "year": "2025"}

    def test_paper_nested_layout(self):
        dims = _parse_dimensions(Path("数学/初中/first/2024/试卷名/试卷名"))
        assert dims == {"subject": "数学", "stage": "junior", "term": "first", "year": "2024"}

    def test_textbook_layout_has_no_year(self):
        dims = _parse_dimensions(Path("数学/初中/人教版/九年级/上册/义务教育教科书·数学九年级上册"))
        assert dims == {"subject": "数学", "stage": "junior", "term": "first", "year": None}

    def test_textbook_second_term(self):
        dims = _parse_dimensions(Path("数学/初中/人教版/九年级/下册/义务教育教科书·数学九年级下册"))
        assert dims["term"] == "second"

    def test_shallow_path_has_no_dimensions(self):
        dims = _parse_dimensions(Path("试卷"))
        assert dims == {"subject": None, "stage": None, "term": None, "year": None}


class TestMatchFilters:
    PAPER = "数学/初中/second/2025/数学-初三(下)-202507-海淀-模拟二-试卷"
    TEXTBOOK = "数学/初中/人教版/九年级/上册/义务教育教科书·数学九年级上册"

    def test_no_filters_passes_everything(self):
        assert _match_filters(_paper(self.PAPER)) is True
        assert _match_filters(_textbook(self.TEXTBOOK)) is True

    def test_subject_exact_match(self):
        assert _match_filters(_paper(self.PAPER), subject="数学") is True
        assert _match_filters(_paper(self.PAPER), subject="物理") is False
        assert _match_filters(_paper(self.PAPER), subject="数") is False

    def test_stage_accepts_chinese_and_english(self):
        assert _match_filters(_paper(self.PAPER), stage="初中") is True
        assert _match_filters(_paper(self.PAPER), stage="junior") is True
        assert _match_filters(_paper(self.PAPER), stage="高中") is False

    def test_term_accepts_first_second_and_cn_aliases(self):
        assert _match_filters(_paper(self.PAPER), term="second") is True
        assert _match_filters(_paper(self.PAPER), term="下") is True
        assert _match_filters(_paper(self.PAPER), term="first") is False
        assert _match_filters(_paper(self.PAPER), term="上") is False

    def test_term_alias_crosses_paper_and_textbook(self):
        # 上册 == 上学期 == first，故教材的「上册」也能命中 --term second 之外的值
        assert _match_filters(_textbook(self.TEXTBOOK), term="上册") is True
        assert _match_filters(_textbook(self.TEXTBOOK), term="first") is True
        assert _match_filters(_textbook(self.TEXTBOOK), term="下册") is False

    def test_year_matches_paper_only(self):
        assert _match_filters(_paper(self.PAPER), year="2025") is True
        assert _match_filters(_paper(self.PAPER), year="2024") is False
        # 教材路径没有年份维度，--year 一律不命中
        assert _match_filters(_textbook(self.TEXTBOOK), year="2025") is False

    def test_filters_intersect(self):
        assert _match_filters(_paper(self.PAPER), subject="数学", stage="初中", term="second", year="2025") is True
        assert _match_filters(_paper(self.PAPER), subject="数学", year="2024") is False

    def test_multi_values_are_union(self):
        assert _match_filters(_paper(self.PAPER), year="2024,2025") is True
        assert _match_filters(_paper(self.PAPER), year="2024,2026") is False
        assert _match_filters(_paper(self.PAPER), subject="物理, 数学") is True
        assert _match_filters(_paper(self.PAPER), stage="junior,senior") is True
        assert _match_filters(_textbook(self.TEXTBOOK), term="下册,上册") is True
        assert _match_filters(_textbook(self.TEXTBOOK), term="下册,first") is True

    def test_blank_or_comma_only_value_is_no_filter(self):
        assert _match_filters(_paper(self.PAPER), year="") is True
        assert _match_filters(_paper(self.PAPER), year=",") is True
        assert _match_filters(_paper(self.PAPER), subject=" , ") is True


class TestLoadMaterialEntries:
    def test_inline_comma_separated(self):
        assert _load_material_entries("书A, 书B,,", None) == ["书A", "书B"]

    def test_file_entries_skip_comments_and_blanks(self, tmp_path):
        f = tmp_path / "books.txt"
        f.write_text("# 注释\n\n数学/初中/书A\n  数学/初中/书B  \n", encoding="utf-8")
        assert _load_material_entries(None, str(f)) == ["数学/初中/书A", "数学/初中/书B"]

    def test_inline_and_file_merge(self, tmp_path):
        f = tmp_path / "books.txt"
        f.write_text("数学/初中/书A\n", encoding="utf-8")
        assert _load_material_entries("书B", str(f)) == ["书B", "数学/初中/书A"]

    def test_no_args_returns_empty(self):
        assert _load_material_entries(None, None) == []


class TestConvertCliMain:
    def test_dry_run_prints_materials(self, tmp_path, capsys):
        (tmp_path / "试卷.pdf").write_text("pdf")

        with patch("convert_cli.RefineryConfig") as mock_config, \
             patch("convert_cli.MaterialScanner") as mock_scanner:
            mock_config.from_env.return_value = MagicMock(
                input_dir=tmp_path,
                output_dir=tmp_path / "out",
            )
            mock_scanner.return_value.scan.return_value = [
                Material(kind="pdf", source_dir=tmp_path, rel_path=Path("试卷"), input_paths=[tmp_path / "试卷.pdf"]),
            ]

            main(["--input-dir", str(tmp_path), "--dry-run"])

        captured = capsys.readouterr()
        assert "[dry-run]" in captured.out
        assert "试卷" in captured.out

    def test_dry_run_with_materials_filters_and_warns(self, tmp_path, capsys):
        with patch("convert_cli.RefineryConfig") as mock_config, \
             patch("convert_cli.MaterialScanner") as mock_scanner:
            mock_config.from_env.return_value = MagicMock(
                input_dir=tmp_path,
                output_dir=tmp_path / "out",
            )
            mock_scanner.return_value.scan.return_value = [
                Material(kind="images", source_dir=tmp_path, rel_path=Path("数学/初中/书A"), input_paths=[]),
                Material(kind="images", source_dir=tmp_path, rel_path=Path("数学/初中/书B"), input_paths=[]),
            ]

            main(["--input-dir", str(tmp_path), "--dry-run", "--materials", "书A,书C"])

        captured = capsys.readouterr()
        assert "书A" in captured.out
        assert "书B" not in captured.out
        assert "[WARN] 未命中素材: 书C" in captured.out

    def test_dry_run_with_materials_file(self, tmp_path, capsys):
        books = tmp_path / "books.txt"
        books.write_text("# 只转书B\n数学/初中/书B\n", encoding="utf-8")

        with patch("convert_cli.RefineryConfig") as mock_config, \
             patch("convert_cli.MaterialScanner") as mock_scanner:
            mock_config.from_env.return_value = MagicMock(
                input_dir=tmp_path,
                output_dir=tmp_path / "out",
            )
            mock_scanner.return_value.scan.return_value = [
                Material(kind="images", source_dir=tmp_path, rel_path=Path("数学/初中/书A"), input_paths=[]),
                Material(kind="images", source_dir=tmp_path, rel_path=Path("数学/初中/书B"), input_paths=[]),
            ]

            main(["--input-dir", str(tmp_path), "--dry-run", "--materials-file", str(books)])

        captured = capsys.readouterr()
        assert "书B" in captured.out
        assert "书A" not in captured.out

    def test_dry_run_with_year_and_term_filters_papers(self, tmp_path, capsys):
        scanned = [
            _paper("数学/初中/second/2024/数学-初三(下)-202407-东城-模拟二-试卷"),
            _paper("数学/初中/second/2025/数学-初三(下)-202507-海淀-模拟二-试卷"),
            _paper("数学/初中/first/2025/数学-初三(上)-202501-海淀-期末-试卷"),
        ]

        by_year = _run_dry_run(tmp_path, scanned, ["--source", "zgkao", "--year", "2025"], capsys)

        assert "202507-海淀" in by_year
        assert "202501-海淀" in by_year
        assert "202407-东城" not in by_year

        by_year_term = _run_dry_run(
            tmp_path, scanned,
            ["--source", "zgkao", "--year", "2025", "--term", "下"], capsys,
        )

        assert "202507-海淀" in by_year_term
        assert "202501-海淀" not in by_year_term

    def test_dry_run_filters_intersect_with_materials(self, tmp_path, capsys):
        scanned = [
            _paper("数学/初中/second/2025/数学-初三(下)-202507-海淀-模拟二-试卷"),
            _paper("物理/初中/second/2025/物理-初三(下)-202507-海淀-模拟二-试卷"),
        ]

        out = _run_dry_run(
            tmp_path, scanned,
            ["--source", "zgkao", "--year", "2025", "--subject", "物理"], capsys,
        )

        assert "物理/初中/second/2025" in out
        assert "数学/初中/second/2025" not in out

    def test_source_filter_does_not_false_warn_materials(self, tmp_path, capsys):
        """条目在输入目录里存在、只是被 --source 排除时，不应报未命中。"""
        scanned = [
            _paper("数学/初中/second/2025/数学-初三(下)-202507-海淀-模拟二-试卷"),
            _textbook("数学/初中/人教版/九年级/上册/义务教育教科书·数学九年级上册"),
        ]

        out = _run_dry_run(
            tmp_path, scanned,
            ["--source", "smartedu", "--materials", "义务教育教科书,202507-海淀"], capsys,
        )

        assert "[WARN] 未命中素材" not in out
        assert "义务教育教科书" in out

    def test_dry_run_warns_when_filters_match_nothing(self, tmp_path, capsys):
        scanned = [_textbook("数学/初中/人教版/九年级/上册/义务教育教科书·数学九年级上册")]

        out = _run_dry_run(tmp_path, scanned, ["--source", "smartedu", "--year", "2025"], capsys)

        assert "[dry-run]" not in out
        assert "[WARN] 过滤条件未命中任何素材" in out
