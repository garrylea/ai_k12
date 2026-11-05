from pathlib import Path

import scanner
from convert import MineruRunner
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


class TestOfficeDocuments:
    """发现层必须把 Word/PPT 交给 MinerU（extract 原生支持这些格式）。"""

    def test_finds_all_office_suffixes(self, tmp_path):
        for suffix in (".doc", ".docx", ".ppt", ".pptx"):
            (tmp_path / f"试卷{suffix}").write_text("office")
        materials = MaterialScanner(tmp_path).scan()
        assert len(materials) == 4
        assert all(m.kind == "pdf" for m in materials)  # 整份文档，与 PDF 同一类
        assert {m.input_paths[0].suffix for m in materials} == {".doc", ".docx", ".ppt", ".pptx"}

    def test_office_in_subdirectory_keeps_rel_path(self, tmp_path):
        sub = tmp_path / "语文/初中/first/2025"
        sub.mkdir(parents=True)
        (sub / "期末试卷.docx").write_text("office")
        materials = MaterialScanner(tmp_path).scan()
        assert len(materials) == 1
        assert materials[0].rel_path == Path("语文/初中/first/2025/期末试卷")

    def test_suffix_is_case_insensitive(self, tmp_path):
        (tmp_path / "试卷.DOCX").write_text("office")
        materials = MaterialScanner(tmp_path).scan()
        assert len(materials) == 1
        assert materials[0].input_paths[0].name == "试卷.DOCX"

    def test_ignores_unsupported_extensions(self, tmp_path):
        (tmp_path / "notes.txt").write_text("txt")
        (tmp_path / "figure.png").write_text("png")
        (tmp_path / "already.md").write_text("md")
        assert MaterialScanner(tmp_path).scan() == []

    def test_same_stem_pdf_and_docx_get_distinct_rel_paths(self, tmp_path):
        (tmp_path / "foo.pdf").write_text("pdf")
        (tmp_path / "foo.docx").write_text("office")
        materials = MaterialScanner(tmp_path).scan()
        assert len(materials) == 2
        rels = {m.rel_path.as_posix() for m in materials}
        assert rels == {"foo", "foo_docx"}  # 不撞输出目录

    def test_same_stem_office_without_pdf_both_suffixed(self, tmp_path):
        (tmp_path / "foo.docx").write_text("office")
        (tmp_path / "foo.pptx").write_text("office")
        rels = {m.rel_path.as_posix() for m in MaterialScanner(tmp_path).scan()}
        assert rels == {"foo_docx", "foo_pptx"}

    def test_document_and_image_book_coexist(self, tmp_path):
        (tmp_path / "试卷.docx").write_text("office")
        (tmp_path / "page_001.jpg").write_text("jpg")
        materials = MaterialScanner(tmp_path).scan()
        assert {m.kind for m in materials} == {"pdf", "images"}

    def test_suffixes_match_convert_layer(self):
        """发现层与执行层的后缀集合必须一致，否则会被当成拆页图片走错日志/节流。"""
        assert scanner.DOCUMENT_SUFFIXES == MineruRunner._DOCUMENT_SUFFIXES
