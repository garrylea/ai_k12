"""存储模块：ResourceStore 接口 + PdfStore/ImageStore 实现。"""

import hashlib
import json
import re
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit


def _iso_format(dt: datetime) -> str:
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _extract_site(url: str) -> str:
    host = urlsplit(url).hostname or ""
    if host.startswith("www."):
        host = host[4:]
    return host


def _origin_suffix(origin: Optional[str], source_url: str) -> str:
    """由来源确定的稳定后缀：优先 origin 末尾数字段，否则退回 md5 前 6 位。

    不用随机值/time：同一个来源重跑必须得到同一个名字，否则 `--force` 会不断堆积文件。
    """
    digits = re.findall(r"\d+", origin or "")
    if digits:
        return digits[-1]
    return hashlib.md5((origin or source_url).encode("utf-8")).hexdigest()[:6]


def _insert_suffix(filename: str, suffix: str) -> str:
    """在扩展名前插入后缀：`数学-…-试卷.pdf` -> `数学-…-试卷-76320.pdf`。"""
    stem, dot, ext = filename.rpartition(".")
    if not dot:
        return f"{filename}-{suffix}"
    return f"{stem}-{suffix}{dot}{ext}"


class ResourceStore(ABC):
    @abstractmethod
    def save(
        self,
        dir_relpath: Path,
        filename: str,
        content: bytes,
        source_url: str,
        file_type: str,
        classification: dict,
        origin: Optional[str] = None,
    ) -> Path:
        ...

    @abstractmethod
    def read_meta(self, dir_relpath: Path) -> Optional[dict]:
        ...

    @abstractmethod
    def write_meta(self, dir_relpath: Path, meta: dict) -> None:
        ...


class BaseStore(ResourceStore):
    def __init__(
        self,
        base_dir: str,
        entry_url: str,
        crawl_time: datetime,
        crawler_version: str = "2.0.0",
        robots_checked: bool = True,
        site_adapter: str = "zgkao",
    ) -> None:
        self._base_dir = Path(base_dir)
        self._entry_url = entry_url
        self._crawl_time = crawl_time
        self._crawler_version = crawler_version
        self._robots_checked = robots_checked
        self._site_adapter = site_adapter

    def _abs_dir(self, dir_relpath: Path) -> Path:
        return self._base_dir / dir_relpath

    def read_meta(self, dir_relpath: Path) -> Optional[dict]:
        meta_path = self._abs_dir(dir_relpath) / "meta.json"
        if not meta_path.exists():
            return None
        try:
            return json.loads(meta_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, ValueError):
            return None

    def write_meta(self, dir_relpath: Path, meta: dict) -> None:
        target_dir = self._abs_dir(dir_relpath)
        target_dir.mkdir(parents=True, exist_ok=True)
        meta_path = target_dir / "meta.json"
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    def _init_meta(self, classification: dict) -> dict:
        return {
            "classification": classification,
            "source": {
                "site": _extract_site(self._entry_url),
                "entry_url": self._entry_url,
                "crawl_time": _iso_format(self._crawl_time),
            },
            "files": [],
            "config": {
                "crawler_version": self._crawler_version,
                "robots_txt_checked": self._robots_checked,
                "site_adapter": self._site_adapter,
            },
        }

    def _file_record(
        self, filename: str, file_type: str, source_url: str, content: bytes, page: Optional[int] = None,
    ) -> dict:
        record = {
            "filename": filename,
            "type": file_type,
            "source_url": source_url,
            "download_time": _iso_format(self._crawl_time),
            "size_bytes": len(content),
            "md5": hashlib.md5(content).hexdigest(),
        }
        if page is not None:
            record["page"] = page
        return record


class PdfStore(BaseStore):
    def save(
        self,
        dir_relpath: Path,
        filename: str,
        content: bytes,
        source_url: str,
        file_type: str,
        classification: dict,
        origin: Optional[str] = None,
    ) -> Path:
        meta = self.read_meta(dir_relpath) or self._init_meta(classification)
        filename = self._resolve_filename(meta, filename, source_url, origin)

        target_dir = self._abs_dir(dir_relpath)
        target_dir.mkdir(parents=True, exist_ok=True)
        file_path = target_dir / filename
        file_path.write_bytes(content)

        meta["files"] = [f for f in meta["files"] if f["filename"] != filename]
        meta["files"].append(self._file_record(filename, file_type, source_url, content))
        self.write_meta(dir_relpath, meta)
        return file_path

    def _resolve_filename(self, meta: dict, filename: str, source_url: str, origin: Optional[str]) -> str:
        """防覆盖兜底：同名但来自不同 source_url 必须改名，否则会静默丢掉先前下载的文件。

        同名且同 source_url 仍原样覆盖（重复下载保持幂等）。
        """
        if not self._has_conflict(meta, filename, source_url):
            return filename

        suffix = _origin_suffix(origin, source_url)
        candidate = _insert_suffix(filename, suffix)
        if self._has_conflict(meta, candidate, source_url):
            # 兜底的兜底：后缀也被另一个来源占了，再叠加 source_url 的 hash
            candidate = _insert_suffix(
                filename, f"{suffix}-{hashlib.md5(source_url.encode('utf-8')).hexdigest()[:6]}",
            )
        print(f"警告：文件名冲突，改名保存 {filename} → {candidate}（来源 {source_url}）")
        return candidate

    @staticmethod
    def _has_conflict(meta: dict, filename: str, source_url: str) -> bool:
        """meta 里该文件名是否已被另一个来源占用（来源缺失值也视为不同来源）。"""
        return any(
            record["filename"] == filename and record.get("source_url") != source_url
            for record in meta["files"]
        )


class ImageStore(BaseStore):
    def save(
        self,
        dir_relpath: Path,
        filename: str,
        content: bytes,
        source_url: str,
        file_type: str,
        classification: dict,
        origin: Optional[str] = None,
    ) -> Path:
        raise NotImplementedError("ImageStore does not support generic save; use save_page()")

    def save_page(
        self,
        dir_relpath: Path,
        page: int,
        content: bytes,
        source_url: str,
    ) -> Path:
        filename = f"page_{page:03d}.jpg"
        target_dir = self._abs_dir(dir_relpath)
        target_dir.mkdir(parents=True, exist_ok=True)
        file_path = target_dir / filename
        file_path.write_bytes(content)

        meta = self.read_meta(dir_relpath) or self._init_meta({})
        meta["files"] = [f for f in meta["files"] if f["filename"] != filename]
        meta["files"].append(self._file_record(filename, "image", source_url, content, page=page))
        self.write_meta(dir_relpath, meta)
        return file_path

    def init_book_meta(
        self,
        dir_relpath: Path,
        classification: dict,
        source: dict,
        total_pages: int,
    ) -> None:
        meta = self._init_meta(classification)
        meta["source"].update(source)
        meta["total_pages"] = total_pages
        meta["status"] = "in_progress"
        self.write_meta(dir_relpath, meta)

    def finalize_book(self, dir_relpath: Path, failed_pages: list[int]) -> None:
        meta = self.read_meta(dir_relpath)
        if meta is None:
            return
        meta["status"] = "partial" if failed_pages else "complete"
        if failed_pages:
            meta["failed_pages"] = sorted(failed_pages)
        self.write_meta(dir_relpath, meta)

    def rebuild_files_from_disk(self, dir_relpath: Path) -> list[dict]:
        target_dir = self._abs_dir(dir_relpath)
        files = []
        for path in sorted(target_dir.glob("page_*.jpg")):
            content = path.read_bytes()
            page = int(path.stem.split("_")[-1])
            files.append(self._file_record(path.name, "image", "", content, page=page))
        return files
