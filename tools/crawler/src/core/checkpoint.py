"""断点续传模块。

记录已下载的 URL 与对应文件位置，重启后可跳过。存储在 data/.checkpoint.json。

三份索引，缺一不可：
- `downloaded_urls`：所有已完成的 URL（详情页 + PDF），判断是否跳过；
- `downloaded_files`：PDF URL → 相对输出目录的路径，跳过时能直接打印文件在哪；
- `downloaded_items`：详情页 URL → 该页下载出的文件列表，整项跳过时打印文件路径。

`downloaded_files` / `downloaded_items` 是 2026-10-28 新增的。旧 checkpoint 没有这两项，
加载时按空处理：仍能正常跳过，只是打印不出路径（重跑一次 `--force` 或新下载时补齐）。
"""

import json
from pathlib import Path
from typing import Iterable, Optional


class Checkpoint:
    def __init__(self, path: Path) -> None:
        self._path = Path(path)
        self._urls: set[str] = set()
        self._files: dict[str, str] = {}
        self._items: dict[str, list[str]] = {}

    def load(self) -> None:
        if not self._path.exists():
            return
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, ValueError):
            return
        self._urls = set(data.get("downloaded_urls", []))
        self._files = {k: v for k, v in data.get("downloaded_files", {}).items() if v}
        self._items = {
            k: [p for p in v if p] for k, v in data.get("downloaded_items", {}).items()
        }

    def is_downloaded(self, url: str) -> bool:
        return url in self._urls

    def mark_downloaded(self, url: str, path: Optional[str] = None) -> None:
        self._urls.add(url)
        if path:
            self._files[url] = str(path)
        self.save()

    def mark_item(self, url: str, paths: Iterable[str]) -> None:
        """记录一个详情页最终落盘了哪些文件（整项跳过时用来打印路径）。"""
        self._urls.add(url)
        self._items[url] = [str(p) for p in paths]
        self.save()

    def path_for_file(self, url: str) -> Optional[str]:
        return self._files.get(url)

    def files_for_item(self, url: str) -> list[str]:
        return list(self._items.get(url, []))

    def clear(self) -> None:
        self._urls.clear()
        self._files.clear()
        self._items.clear()
        if self._path.exists():
            self._path.unlink()

    def save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "downloaded_urls": sorted(self._urls),
            "downloaded_files": dict(sorted(self._files.items())),
            "downloaded_items": {k: self._items[k] for k in sorted(self._items)},
        }
        self._path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
