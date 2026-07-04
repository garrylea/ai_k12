"""断点续传模块。

记录已下载的 URL，重启后可跳过。存储在 data/.checkpoint.json。
"""

import json
from pathlib import Path


class Checkpoint:
    def __init__(self, path: Path) -> None:
        self._path = Path(path)
        self._urls: set[str] = set()

    def load(self) -> None:
        if not self._path.exists():
            return
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, ValueError):
            return
        self._urls = set(data.get("downloaded_urls", []))

    def is_downloaded(self, url: str) -> bool:
        return url in self._urls

    def mark_downloaded(self, url: str) -> None:
        self._urls.add(url)
        self.save()

    def clear(self) -> None:
        self._urls.clear()
        if self._path.exists():
            self._path.unlink()

    def save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(
            json.dumps({"downloaded_urls": sorted(self._urls)}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
