"""递归扫描素材文件。"""

from dataclasses import dataclass
from pathlib import Path


@dataclass
class Material:
    kind: str  # "pdf" | "images"
    source_dir: Path
    rel_path: Path
    input_paths: list[Path]


class MaterialScanner:
    def __init__(self, data_dir: Path):
        self._data_dir = Path(data_dir)

    def scan(self) -> list[Material]:
        results: list[Material] = []

        # PDFs
        for path in sorted(self._data_dir.rglob("*.pdf")):
            results.append(Material(
                kind="pdf",
                source_dir=path.parent,
                rel_path=path.parent.relative_to(self._data_dir) / path.stem,
                input_paths=[path],
            ))

        # Image books: check the root directory and every subdirectory
        dirs = {self._data_dir} | {p for p in self._data_dir.rglob("*") if p.is_dir()}
        for dir_path in sorted(dirs):
            images = sorted(dir_path.glob("page_*.jpg"))
            if images:
                rel = dir_path.relative_to(self._data_dir)
                if rel == Path("."):
                    rel = Path(self._data_dir.name)
                results.append(Material(
                    kind="images",
                    source_dir=dir_path,
                    rel_path=rel,
                    input_paths=images,
                ))

        return results
