"""递归扫描已转换的 Markdown 文件。"""

from dataclasses import dataclass
from pathlib import Path


@dataclass
class MarkdownSource:
    md_path: Path
    rel_path: Path
    kind: str  # "questions" | "cards"


class MarkdownScanner:
    def __init__(self, md_dir: Path):
        self._md_dir = Path(md_dir)

    def scan(self) -> list[MarkdownSource]:
        results: list[MarkdownSource] = []
        for md_path in sorted(self._md_dir.rglob("*.md")):
            rel = md_path.relative_to(self._md_dir)
            kind = self._infer_kind(rel)
            results.append(MarkdownSource(md_path=md_path, rel_path=rel.parent, kind=kind))
        return results

    @staticmethod
    def _infer_kind(rel_path: Path) -> str:
        name = rel_path.name
        if "试卷" in name or "答案" in name:
            return "questions"
        return "cards"
