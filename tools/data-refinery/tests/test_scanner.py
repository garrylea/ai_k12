from pathlib import Path

from scanner import Material, MaterialScanner


class TestMaterialScanner:
    def test_finds_single_pdf(self, tmp_path):
        (tmp_path / "数学-初三(下)-202407-东城-模拟二-试卷.pdf").write_text("pdf")
        scanner = MaterialScanner(tmp_path)
        materials = list(scanner.scan())
        assert len(materials) == 1
        assert materials[0].kind == "pdf"
        assert materials[0].input_paths[0].name == "数学-初三(下)-202407-东城-模拟二-试卷.pdf"

    def test_finds_image_book_directory(self, tmp_path):
        (tmp_path / "page_001.jpg").write_text("jpg")
        (tmp_path / "page_002.jpg").write_text("jpg")
        scanner = MaterialScanner(tmp_path)
        materials = list(scanner.scan())
        assert len(materials) == 1
        assert materials[0].kind == "images"
        assert len(materials[0].input_paths) == 2

    def test_ignores_non_page_jpg(self, tmp_path):
        (tmp_path / "cover.jpg").write_text("jpg")
        scanner = MaterialScanner(tmp_path)
        materials = list(scanner.scan())
        assert len(materials) == 0

    def test_recurses_subdirectories(self, tmp_path):
        sub = tmp_path / "数学/初中/second/2024"
        sub.mkdir(parents=True)
        (sub / "试卷.pdf").write_text("pdf")
        scanner = MaterialScanner(tmp_path)
        materials = list(scanner.scan())
        assert len(materials) == 1
