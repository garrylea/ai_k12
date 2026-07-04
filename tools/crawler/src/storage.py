"""存储模块。

创建目录结构、保存 PDF 文件、生成与更新 meta.json。
"""

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from classifier import Classification, Classifier


_FILE_TYPE_MAP = {"试卷": "paper", "答案": "answer"}


class Storage:
    def __init__(
        self,
        base_dir: str,
        entry_url: str,
        crawl_time: datetime,
        crawler_version: str = "1.0.0",
        robots_checked: bool = True,
    ) -> None:
        self._base_dir = base_dir
        self._entry_url = entry_url
        self._crawl_time = crawl_time
        self._crawler_version = crawler_version
        self._robots_checked = robots_checked

    def save_pdf(
        self,
        classification: Classification,
        content: bytes,
        source_url: str,
    ) -> Path:
        target_dir = Classifier.storage_dir(classification, self._base_dir)
        target_dir.mkdir(parents=True, exist_ok=True)

        filename = Classifier.filename(classification)
        file_path = target_dir / filename
        file_path.write_bytes(content)

        self._update_meta(target_dir / "meta.json", classification, filename, content, source_url)
        return file_path

    def _update_meta(
        self,
        meta_path: Path,
        classification: Classification,
        filename: str,
        content: bytes,
        source_url: str,
    ) -> None:
        if meta_path.exists():
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        else:
            meta = self._init_meta(classification)

        record = {
            "filename": filename,
            "type": _FILE_TYPE_MAP[classification.file_type],
            "source_url": source_url,
            "download_time": _iso_format(self._crawl_time),
            "size_bytes": len(content),
            "md5": hashlib.md5(content).hexdigest(),
        }

        meta["files"] = [f for f in meta["files"] if f["filename"] != filename]
        meta["files"].append(record)

        meta_path.write_text(
            json.dumps(meta, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def _init_meta(self, classification: Classification) -> dict:
        return {
            "classification": {
                "subject": classification.subject,
                "level": classification.level,
                "semester": classification.semester,
                "year": classification.year,
            },
            "source": {
                "site": _extract_site(self._entry_url),
                "entry_url": self._entry_url,
                "crawl_time": _iso_format(self._crawl_time),
            },
            "files": [],
            "config": {
                "crawler_version": self._crawler_version,
                "robots_txt_checked": self._robots_checked,
            },
        }


def _extract_site(url: str) -> str:
    host = urlsplit(url).hostname or ""
    if host.startswith("www."):
        host = host[4:]
    return host


def _iso_format(dt: datetime) -> str:
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
