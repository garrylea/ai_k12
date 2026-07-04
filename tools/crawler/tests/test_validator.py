"""validator.py 的 TDD 测试。

校验 PDF 文件完整性：能否正常打开、是否非空、能否读取页数。
"""

import pytest
from pypdf import PdfWriter

from validator import PdfValidator, ValidationResult


@pytest.fixture
def valid_pdf(tmp_path):
    """生成一个有效的单页空白 PDF。"""
    path = tmp_path / "valid.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    with open(path, "wb") as f:
        writer.write(f)
    return path


@pytest.fixture
def truncated_pdf(tmp_path, valid_pdf):
    """截断的有效 PDF：保留头部但删掉结尾，模拟下载不完整。"""
    path = tmp_path / "truncated.pdf"
    content = valid_pdf.read_bytes()
    path.write_bytes(content[: len(content) // 2])
    return path


@pytest.fixture
def text_file(tmp_path):
    """扩展名是 .pdf 但内容是纯文本。"""
    path = tmp_path / "fake.pdf"
    path.write_text("this is not a pdf", encoding="utf-8")
    return path


@pytest.fixture
def empty_file(tmp_path):
    path = tmp_path / "empty.pdf"
    path.write_bytes(b"")
    return path


class TestValidateValidPdf:
    def test_returns_is_valid_true(self, valid_pdf):
        result = PdfValidator().validate(str(valid_pdf))
        assert result.is_valid is True

    def test_returns_positive_page_count(self, valid_pdf):
        result = PdfValidator().validate(str(valid_pdf))
        assert result.page_count is not None
        assert result.page_count >= 1

    def test_returns_file_size_bytes(self, valid_pdf):
        result = PdfValidator().validate(str(valid_pdf))
        assert result.file_size_bytes > 0
        assert result.file_size_bytes == valid_pdf.stat().st_size

    def test_error_is_none_when_valid(self, valid_pdf):
        result = PdfValidator().validate(str(valid_pdf))
        assert result.error is None


class TestValidateInvalidPdf:
    def test_nonexistent_file_is_invalid(self, tmp_path):
        result = PdfValidator().validate(str(tmp_path / "no_such.pdf"))
        assert result.is_valid is False
        assert result.error is not None

    def test_empty_file_is_invalid(self, empty_file):
        result = PdfValidator().validate(str(empty_file))
        assert result.is_valid is False
        assert result.error is not None

    def test_text_file_is_invalid(self, text_file):
        result = PdfValidator().validate(str(text_file))
        assert result.is_valid is False
        assert result.error is not None

    def test_truncated_pdf_is_invalid(self, truncated_pdf):
        result = PdfValidator().validate(str(truncated_pdf))
        assert result.is_valid is False
        assert result.error is not None

    def test_file_size_reported_even_when_invalid(self, empty_file):
        result = PdfValidator().validate(str(empty_file))
        assert result.file_size_bytes == 0

    def test_page_count_is_none_when_invalid(self, text_file):
        result = PdfValidator().validate(str(text_file))
        assert result.page_count is None


class TestValidationResultShape:
    def test_result_has_required_fields(self, valid_pdf):
        result = PdfValidator().validate(str(valid_pdf))
        assert isinstance(result, ValidationResult)
        assert hasattr(result, "is_valid")
        assert hasattr(result, "file_size_bytes")
        assert hasattr(result, "page_count")
        assert hasattr(result, "error")
