"""递归扫描素材文件。"""

from dataclasses import dataclass
from pathlib import Path

# 整份文档（PDF / Word / PPT）：一份文件一个转换任务、一份文件一个输出目录。
# 必须与 convert.py 的 MineruRunner._DOCUMENT_SUFFIXES 保持一致 —— 发现层放进来、
# 执行层却认不出的话会被当成拆页图片走错日志与节流；tests/test_scanner.py 有对账用例。
# 教材拆页图片不在这里，走下面 page_*.jpg 的分支。
DOCUMENT_SUFFIXES = frozenset({".pdf", ".doc", ".docx", ".ppt", ".pptx"})


@dataclass
class Material:
    kind: str  # "pdf"（整份文档：PDF/Office） | "images"（教材拆页图片）
    source_dir: Path
    rel_path: Path
    input_paths: list[Path]


class MaterialScanner:
    def __init__(self, data_dir: Path):
        self._data_dir = Path(data_dir)

    def scan(self) -> list[Material]:
        results: list[Material] = []

        # 整份文档：PDF + Word + PPT。MinerU 的 extract 子命令原生支持这些格式，
        # convert.py 会把文件路径原样传给它，这里不需要按扩展名再分一次。
        documents = sorted(
            p for p in self._data_dir.rglob("*")
            if p.is_file() and p.suffix.lower() in DOCUMENT_SUFFIXES
        )
        # 同目录同名不同后缀（foo.pdf 与 foo.docx）会撞同一个 rel_path / 输出目录。
        # PDF 保留原名，其余按后缀加短后缀区分，避免静默覆盖。
        by_stem: dict[tuple[Path, str], list[Path]] = {}
        for path in documents:
            by_stem.setdefault((path.parent, path.stem), []).append(path)

        for path in documents:
            siblings = by_stem[(path.parent, path.stem)]
            rel_name = path.stem
            if len(siblings) > 1 and path.suffix.lower() != ".pdf":
                rel_name = f"{path.stem}_{path.suffix.lower().lstrip('.')}"
            results.append(Material(
                kind="pdf",
                source_dir=path.parent,
                rel_path=path.parent.relative_to(self._data_dir) / rel_name,
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
