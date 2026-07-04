"""PDF 文件校验模块。

验证 PDF 完整性：文件存在、非空、可被 pypdf 正常解析、能读取页数。
"""

from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from pypdf import PdfReader
from pypdf.errors import PdfReadError


@dataclass
class ValidationResult:
    is_valid: bool
    file_size_bytes: int
    page_count: Optional[int]
    error: Optional[str]


class PdfValidator:
    def validate(self, file_path) -> ValidationResult:
        path = Path(file_path)

        if not path.exists():
            return ValidationResult(
                is_valid=False,
                file_size_bytes=0,
                page_count=None,
                error=f"file not found: {path}",
            )

        size = path.stat().st_size
        if size == 0:
            return ValidationResult(
                is_valid=False,
                file_size_bytes=0,
                page_count=None,
                error="file is empty",
            )

        try:
            reader = PdfReader(str(path))
            page_count = len(reader.pages)
        except (PdfReadError, ValueError) as e:
            return ValidationResult(
                is_valid=False,
                file_size_bytes=size,
                page_count=None,
                error=f"invalid pdf: {e}",
            )

        return ValidationResult(
            is_valid=True,
            file_size_bytes=size,
            page_count=page_count,
            error=None,
        )


@dataclass
class ImageValidationResult:
    is_valid: bool
    file_size_bytes: int
    format: Optional[str]
    error: Optional[str]


class ImageValidator:
    JPEG_MAGIC = b"\xff\xd8\xff"
    MIN_JPEG_SIZE = 4  # A valid JPEG needs more than just the magic bytes

    def validate(self, file_path: str) -> ImageValidationResult:
        path = Path(file_path)
        if not path.exists():
            return ImageValidationResult(
                is_valid=False, file_size_bytes=0, format=None,
                error=f"file not found: {path}",
            )
        size = path.stat().st_size
        if size < self.MIN_JPEG_SIZE:
            return ImageValidationResult(
                is_valid=False, file_size_bytes=size, format=None,
                error="file too small or empty",
            )
        content = path.read_bytes()
        if not content.startswith(self.JPEG_MAGIC):
            return ImageValidationResult(
                is_valid=False, file_size_bytes=size, format=None,
                error="invalid jpeg magic number",
            )
        return ImageValidationResult(
            is_valid=True, file_size_bytes=size, format="jpeg", error=None,
        )
