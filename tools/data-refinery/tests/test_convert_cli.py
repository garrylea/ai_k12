from pathlib import Path
from unittest.mock import MagicMock, patch

from convert_cli import _load_material_entries, _match_materials, _match_source, main
from scanner import Material


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
