"""断点续传：记录已转换和已提取的素材路径。"""

import json
from pathlib import Path


class RefineryCheckpoint:
    def __init__(self, path: Path) -> None:
        self._path = Path(path)
        self._converted: set[str] = set()
        self._extracted: set[str] = set()

    def load(self) -> None:
        if not self._path.exists():
            return
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, ValueError):
            return
        self._converted = set(data.get("converted", []))
        self._extracted = set(data.get("extracted", []))

    def is_converted(self, rel_path: str) -> bool:
        return rel_path in self._converted

    def is_extracted(self, rel_path: str) -> bool:
        return rel_path in self._extracted

    def mark_converted(self, rel_path: str) -> None:
        self._converted.add(rel_path)
        self.save()

    def mark_extracted(self, rel_path: str) -> None:
        self._extracted.add(rel_path)
        self.save()

    def save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(
            json.dumps(
                {"converted": sorted(self._converted), "extracted": sorted(self._extracted)},
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
