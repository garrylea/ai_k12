# smartedu 教材爬虫改造实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有 `tools/crawler/` 从单一 zgkao 试卷爬虫改造为多站点统一框架，新增 smartedu.cn 教材页面预览图抓取，同时保持 zgkao 140 个测试行为不变。

**Architecture:** 通过 `SiteAdapter` 抽象接口把站点无关共享层（fetcher/robots/checkpoint/validator/storage/crawler）与站点特定逻辑（zgkao/smartedu）解耦；smartedu adapter 基于静态 JSON 目录 + HEAD 探测页数 + 顺序下载图片；存储层拆分为 `PdfStore`（单文件）与 `ImageStore`（多文件按页累积 meta.json）。

**Tech Stack:** Python 3.11+, pytest, requests, beautifulsoup4, pypdf.

---

## 目录

- [Phase 1: 目录与模块重组（无行为变化）](#phase-1-目录与模块重组无行为变化)
- [Phase 2: 共享基础设施（TDD）](#phase-2-共享基础设施tdd)
- [Phase 3: zgkao Adapter 迁移](#phase-3-zgkao-adapter-迁移)
- [Phase 4: smartedu Adapter（TDD）](#phase-4-smartedu-adaptertdd)
- [Phase 5: CLI 集成与文档](#phase-5-cli-集成与文档)
- [自检清单](#自检清单)

---

## Phase 1: 目录与模块重组（无行为变化）

### Task 1: 创建 `src/core/` 与 `src/adapters/` 并迁移共享模块

**Files:**
- Create: `src/core/`
- Create: `src/adapters/`
- Move: `src/fetcher.py` → `src/core/fetcher.py`
- Move: `src/robots.py` → `src/core/robots.py`
- Move: `src/checkpoint.py` → `src/core/checkpoint.py`
- Move: `src/validator.py` → `src/core/validator.py`
- Move: `src/storage.py` → `src/core/storage.py`
- Keep: `src/parser.py` 和 `src/classifier.py` 仍在 `src/`（zgkao 专用）

- [ ] **Step 1: 创建目录结构**

```bash
mkdir -p tools/crawler/src/core tools/crawler/src/adapters
git mv tools/crawler/src/fetcher.py tools/crawler/src/core/fetcher.py
git mv tools/crawler/src/robots.py tools/crawler/src/core/robots.py
git mv tools/crawler/src/checkpoint.py tools/crawler/src/core/checkpoint.py
git mv tools/crawler/src/validator.py tools/crawler/src/core/validator.py
git mv tools/crawler/src/storage.py tools/crawler/src/core/storage.py
```

- [ ] **Step 2: 更新 `conftest.py` 的 `sys.path` 注入**

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "src"))
sys.path.insert(0, str(Path(__file__).parent / "src" / "core"))
```

- [ ] **Step 3: 创建临时兼容 shim，让未迁移的测试仍能找到模块**

Create `src/fetcher.py`, `src/robots.py`, `src/checkpoint.py`, `src/validator.py`, `src/storage.py` with:

```python
# src/fetcher.py — compatibility shim, will be removed in Task 2
from core.fetcher import Fetcher  # noqa: F401
```

Repeat for robots/checkpoint/validator/storage.

- [ ] **Step 4: 运行现有测试确认未破坏**

```bash
cd tools/crawler && pytest tests/ -q
```

Expected: 140 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/crawler/src/core tools/crawler/src/adapters tools/crawler/src/fetcher.py tools/crawler/src/robots.py tools/crawler/src/checkpoint.py tools/crawler/src/validator.py tools/crawler/src/storage.py tools/crawler/conftest.py
git commit -m "refactor: move shared crawler modules to src/core/"
```

---

### Task 2: 创建 `tests/core/` 与 `tests/adapters/` 目录结构

**Files:**
- Create: `tests/core/`
- Create: `tests/adapters/`
- Move: `tests/test_fetcher.py` → `tests/core/test_fetcher.py`
- Move: `tests/test_robots.py` → `tests/core/test_robots.py`
- Move: `tests/test_checkpoint.py` → `tests/core/test_checkpoint.py`
- Move: `tests/test_validator.py` → `tests/core/test_validator.py`
- Move: `tests/test_storage.py` → `tests/core/test_storage.py`
- Move: `tests/test_main.py`, `tests/test_parser.py`, `tests/test_classifier.py` → `tests/adapters/test_zgkao.py`（后续合并，本任务先移动）

- [ ] **Step 1: 移动测试文件**

```bash
cd tools/crawler
mkdir -p tests/core tests/adapters
git mv tests/test_fetcher.py tests/core/test_fetcher.py
git mv tests/test_robots.py tests/core/test_robots.py
git mv tests/test_checkpoint.py tests/core/test_checkpoint.py
git mv tests/test_validator.py tests/core/test_validator.py
git mv tests/test_storage.py tests/core/test_storage.py
git mv tests/test_main.py tests/adapters/test_zgkao.py
git mv tests/test_parser.py tests/adapters/test_zgkao_parser.py
git mv tests/test_classifier.py tests/adapters/test_zgkao_classifier.py
```

- [ ] **Step 2: 更新 `pytest.ini` 的 `testpaths`**

```ini
[pytest]
testpaths = tests
testpaths = tests tests/core tests/adapters
python_files = test_*.py
python_classes = Test*
python_functions = test_*
```

- [ ] **Step 3: 运行测试**

```bash
pytest tests/ -q
```

Expected: 140 passed（移动文件位置不影响导入，因 `sys.path` 已包含 `src/` 和 `src/core/`）。

- [ ] **Step 4: Commit**

```bash
git add tools/crawler/tests tools/crawler/pytest.ini
git commit -m "test: reorganize tests into core/ and adapters/"
```

---

## Phase 2: 共享基础设施（TDD）

### Task 3: 扩展 `validator.py` — 新增 `ImageValidator`

**Files:**
- Modify: `src/core/validator.py`
- Test: `tests/core/test_validator.py`

- [ ] **Step 1: 写失败测试**

在 `tests/core/test_validator.py` 末尾追加：

```python
import pytest

from validator import ImageValidator, ImageValidationResult


JPEG_BYTES = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"


@pytest.fixture
def valid_jpeg(tmp_path):
    path = tmp_path / "valid.jpg"
    path.write_bytes(JPEG_BYTES)
    return path


class TestImageValidator:
    def test_valid_jpeg_is_valid(self, valid_jpeg):
        result = ImageValidator().validate(str(valid_jpeg))
        assert result.is_valid is True

    def test_returns_jpeg_format(self, valid_jpeg):
        result = ImageValidator().validate(str(valid_jpeg))
        assert result.format == "jpeg"

    def test_missing_file_is_invalid(self, tmp_path):
        result = ImageValidator().validate(str(tmp_path / "missing.jpg"))
        assert result.is_valid is False

    def test_empty_file_is_invalid(self, tmp_path):
        path = tmp_path / "empty.jpg"
        path.write_bytes(b"")
        result = ImageValidator().validate(str(path))
        assert result.is_valid is False

    def test_html_disguised_as_jpg_is_invalid(self, tmp_path):
        path = tmp_path / "fake.jpg"
        path.write_text("<html>not an image</html>", encoding="utf-8")
        result = ImageValidator().validate(str(path))
        assert result.is_valid is False

    def test_truncated_jpeg_is_invalid(self, valid_jpeg):
        content = valid_jpeg.read_bytes()[:3]
        valid_jpeg.write_bytes(content)
        result = ImageValidator().validate(str(valid_jpeg))
        assert result.is_valid is False

    def test_result_has_size_bytes(self, valid_jpeg):
        result = ImageValidator().validate(str(valid_jpeg))
        assert result.file_size_bytes == len(JPEG_BYTES)
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pytest tests/core/test_validator.py::TestImageValidator -v
```

Expected: `ImportError: cannot import name 'ImageValidator'`.

- [ ] **Step 3: 最小实现**

在 `src/core/validator.py` 追加：

```python
@dataclass
class ImageValidationResult:
    is_valid: bool
    file_size_bytes: int
    format: Optional[str]
    error: Optional[str]


class ImageValidator:
    JPEG_MAGIC = b"\xff\xd8\xff"

    def validate(self, file_path) -> ImageValidationResult:
        path = Path(file_path)
        if not path.exists():
            return ImageValidationResult(
                is_valid=False, file_size_bytes=0, format=None,
                error=f"file not found: {path}",
            )
        size = path.stat().st_size
        if size < len(self.JPEG_MAGIC):
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
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pytest tests/core/test_validator.py -q
```

Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add tools/crawler/src/core/validator.py tools/crawler/tests/core/test_validator.py
git commit -m "feat(core): add ImageValidator with jpeg magic number check"
```

---

### Task 4: `Fetcher` 增加 `fetch_head` 方法

**Files:**
- Modify: `src/core/fetcher.py`
- Test: `tests/core/test_fetcher.py`

- [ ] **Step 1: 写失败测试**

在 `tests/core/test_fetcher.py` 末尾追加（若不存在则创建该文件）：

```python
import pytest

from fetcher import Fetcher


class TestFetchHead:
    def test_returns_status_and_headers(self, requests_mock):
        requests_mock.head("https://example.com/page.jpg", status_code=200, headers={"Content-Type": "image/jpeg"})
        fetcher = Fetcher()
        status, headers = fetcher.fetch_head("https://example.com/page.jpg")
        assert status == 200
        assert headers["Content-Type"] == "image/jpeg"

    def test_follows_redirects(self, requests_mock):
        requests_mock.head("https://example.com/a.jpg", status_code=302, headers={"Location": "https://example.com/b.jpg"})
        requests_mock.head("https://example.com/b.jpg", status_code=200)
        fetcher = Fetcher()
        status, _ = fetcher.fetch_head("https://example.com/a.jpg")
        assert status == 200

    def test_retries_on_500(self, requests_mock):
        requests_mock.head("https://example.com/page.jpg", [
            {"status_code": 500},
            {"status_code": 200},
        ])
        fetcher = Fetcher()
        status, _ = fetcher.fetch_head("https://example.com/page.jpg")
        assert status == 200
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pytest tests/core/test_fetcher.py::TestFetchHead -v
```

Expected: `AttributeError: 'Fetcher' object has no attribute 'fetch_head'`.

- [ ] **Step 3: 实现 `fetch_head`**

在 `src/core/fetcher.py` 的 `Fetcher` 类中 `fetch_text` 之前插入：

```python
    def fetch_head(self, url: str) -> tuple[int, dict]:
        response = self._fetch_with_retry(url, stream=False, method="HEAD")
        return response.status_code, dict(response.headers)
```

修改 `_fetch_with_retry` 支持 `method`：

```python
    def _fetch_with_retry(self, url: str, stream: bool, method: str = "GET", extra_headers: dict | None = None):
        last_response = None
        for attempt in range(self._max_retries):
            if attempt > 0 and self._crawl_delay > 0:
                time.sleep(self._crawl_delay)
            try:
                response = self._session.request(
                    method=method,
                    url=url,
                    headers=extra_headers or {},
                    timeout=self._timeout,
                    stream=stream,
                )
            except requests.RequestException:
                continue

            if response.status_code >= 500:
                last_response = response
                continue

            response.raise_for_status()
            return response

        if last_response is not None:
            last_response.raise_for_status()
        raise requests.HTTPError(f"failed after {self._max_retries} retries: {url}")
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pytest tests/core/test_fetcher.py -q
```

Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add tools/crawler/src/core/fetcher.py tools/crawler/tests/core/test_fetcher.py
git commit -m "feat(core): add Fetcher.fetch_head for smartedu page detection"
```

---

### Task 5: 重构 `storage.py` — `ResourceStore` 接口 + `PdfStore`

**Files:**
- Modify: `src/core/storage.py`
- Test: `tests/core/test_storage.py`

- [ ] **Step 1: 写失败测试（接口已存在但 PdfStore 未实现）**

先改写 `tests/core/test_storage.py` 顶部导入：

```python
from classifier import Classification
from core.storage import PdfStore, ResourceStore
```

运行：

```bash
pytest tests/core/test_storage.py -q
```

Expected: `ImportError: cannot import name 'PdfStore'`。

- [ ] **Step 2: 重构 `storage.py` 保留行为**

```python
"""存储模块：ResourceStore 接口 + PdfStore/ImageStore 实现。"""

import hashlib
import json
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit

from classifier import Classification, Classifier


_FILE_TYPE_MAP = {"试卷": "paper", "答案": "answer"}


def _iso_format(dt: datetime) -> str:
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _extract_site(url: str) -> str:
    host = urlsplit(url).hostname or ""
    if host.startswith("www."):
        host = host[4:]
    return host


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
    ) -> Path:
        target_dir = self._abs_dir(dir_relpath)
        target_dir.mkdir(parents=True, exist_ok=True)
        file_path = target_dir / filename
        file_path.write_bytes(content)

        meta = self.read_meta(dir_relpath) or self._init_meta(classification)
        meta["files"] = [f for f in meta["files"] if f["filename"] != filename]
        meta["files"].append(self._file_record(filename, file_type, source_url, content))
        self.write_meta(dir_relpath, meta)
        return file_path


class Storage:
    """向后兼容的旧 Storage 包装，实际委托给 PdfStore。"""

    def __init__(
        self,
        base_dir: str,
        entry_url: str,
        crawl_time: datetime,
        crawler_version: str = "1.0.0",
        robots_checked: bool = True,
    ) -> None:
        self._store = PdfStore(
            base_dir=base_dir,
            entry_url=entry_url,
            crawl_time=crawl_time,
            crawler_version=crawler_version,
            robots_checked=robots_checked,
            site_adapter="zgkao",
        )
        self._entry_url = entry_url
        self._crawl_time = crawl_time

    def save_pdf(self, classification: Classification, content: bytes, source_url: str) -> Path:
        dir_relpath = Classifier.storage_dir(classification)
        filename = Classifier.filename(classification)
        return self._store.save(
            dir_relpath=dir_relpath,
            filename=filename,
            content=content,
            source_url=source_url,
            file_type=_FILE_TYPE_MAP[classification.file_type],
            classification={
                "subject": classification.subject,
                "level": classification.level,
                "semester": classification.semester,
                "year": classification.year,
            },
        )
```

- [ ] **Step 3: 运行测试确认通过**

```bash
pytest tests/core/test_storage.py -q
```

Expected: all passed.

- [ ] **Step 4: Commit**

```bash
git add tools/crawler/src/core/storage.py tools/crawler/tests/core/test_storage.py
git commit -m "refactor(core): introduce ResourceStore and PdfStore"
```

---

### Task 6: 新增 `ImageStore`

**Files:**
- Modify: `src/core/storage.py`
- Test: `tests/core/test_storage.py`

- [ ] **Step 1: 写失败测试**

在 `tests/core/test_storage.py` 追加：

```python
from core.storage import ImageStore


@pytest.fixture
def image_store(tmp_path, crawl_time):
    return ImageStore(
        base_dir=str(tmp_path),
        entry_url="https://basic.smartedu.cn/tchMaterial",
        crawl_time=crawl_time,
        site_adapter="smartedu",
    )


class TestImageStore:
    def test_saves_page_with_zero_padded_name(self, image_store, tmp_path):
        image_store.save_page(
            dir_relpath=Path("数学/初中/人教版/九年级/上册/义务教育教科书·数学九年级上册"),
            page=1,
            content=b"\xff\xd8\xffpage1",
            source_url="https://example.com/1.jpg",
        )
        file_path = tmp_path / "数学" / "初中" / "人教版" / "九年级" / "上册" / "义务教育教科书·数学九年级上册" / "page_001.jpg"
        assert file_path.is_file()
        assert file_path.read_bytes() == b"\xff\xd8\xffpage1"

    def test_creates_meta_with_status_in_progress(self, image_store, tmp_path):
        dir_relpath = Path("数学/初中/人教版/九年级/上册/义务教育教科书·数学九年级上册")
        image_store.init_book_meta(
            dir_relpath=dir_relpath,
            classification={"subject": "数学", "level": "初中", "publisher": "人教版", "grade": "九年级", "semester": "上册", "title": "义务教育教科书·数学九年级上册"},
            source={"site": "smartedu.cn", "asset_id": "a1", "content_id": "c1"},
            total_pages=3,
        )
        meta = image_store.read_meta(dir_relpath)
        assert meta["status"] == "in_progress"
        assert meta["total_pages"] == 3
        assert meta["files"] == []

    def test_appends_file_record_after_save(self, image_store, tmp_path):
        dir_relpath = Path("数学/初中/人教版/九年级/上册/书")
        image_store.init_book_meta(dir_relpath, {"title": "书"}, {"asset_id": "a"}, 2)
        image_store.save_page(dir_relpath, 1, b"\xff\xd8\xffa", "https://example.com/1.jpg")
        meta = image_store.read_meta(dir_relpath)
        assert len(meta["files"]) == 1
        assert meta["files"][0]["filename"] == "page_001.jpg"
        assert meta["files"][0]["page"] == 1
        assert meta["files"][0]["type"] == "image"

    def test_finalize_marks_complete(self, image_store, tmp_path):
        dir_relpath = Path("数学/初中/人教版/九年级/上册/书")
        image_store.init_book_meta(dir_relpath, {"title": "书"}, {"asset_id": "a"}, 2)
        image_store.save_page(dir_relpath, 1, b"\xff\xd8\xffa", "https://example.com/1.jpg")
        image_store.save_page(dir_relpath, 2, b"\xff\xd8\xffb", "https://example.com/2.jpg")
        image_store.finalize_book(dir_relpath, failed_pages=[])
        meta = image_store.read_meta(dir_relpath)
        assert meta["status"] == "complete"

    def test_finalize_with_failed_pages_marks_partial(self, image_store, tmp_path):
        dir_relpath = Path("数学/初中/人教版/九年级/上册/书")
        image_store.init_book_meta(dir_relpath, {"title": "书"}, {"asset_id": "a"}, 2)
        image_store.save_page(dir_relpath, 1, b"\xff\xd8\xffa", "https://example.com/1.jpg")
        image_store.finalize_book(dir_relpath, failed_pages=[2])
        meta = image_store.read_meta(dir_relpath)
        assert meta["status"] == "partial"

    def test_rebuild_meta_from_disk(self, image_store, tmp_path):
        dir_relpath = Path("数学/初中/人教版/九年级/上册/书")
        target = tmp_path / "数学" / "初中" / "人教版" / "九年级" / "上册" / "书"
        target.mkdir(parents=True)
        (target / "page_001.jpg").write_bytes(b"\xff\xd8\xffa")
        (target / "page_003.jpg").write_bytes(b"\xff\xd8\xffc")
        rebuilt = image_store.rebuild_files_from_disk(dir_relpath)
        assert {f["page"] for f in rebuilt} == {1, 3}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pytest tests/core/test_storage.py::TestImageStore -v
```

Expected: `ImportError` / `AttributeError`。

- [ ] **Step 3: 实现 `ImageStore`**

在 `src/core/storage.py` 中 `PdfStore` 之后追加：

```python
class ImageStore(BaseStore):
    def save(
        self,
        dir_relpath: Path,
        filename: str,
        content: bytes,
        source_url: str,
        file_type: str,
        classification: dict,
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
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pytest tests/core/test_storage.py -q
```

Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add tools/crawler/src/core/storage.py tools/crawler/tests/core/test_storage.py
git commit -m "feat(core): add ImageStore for multi-page textbook images"
```

---

### Task 7: 定义 `SiteAdapter` 接口

**Files:**
- Create: `src/adapters/base.py`

- [ ] **Step 1: 创建文件**

```python
"""站点适配器抽象接口。"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator, Optional


@dataclass
class Item:
    id: str
    title: str
    tags: dict
    raw: dict


@dataclass
class DownloadResult:
    files_downloaded: int = 0
    files_skipped: int = 0
    files_failed: int = 0


@dataclass
class DownloadContext:
    fetcher: "Fetcher"  # type: ignore
    store: "ResourceStore"  # type: ignore
    checkpoint: "Checkpoint"  # type: ignore
    validator: "Validator"  # type: ignore
    force: bool = False
    dry_run: bool = False
    crawl_delay: float = 0.0


@dataclass
class CrawlResult:
    items_total: int = 0
    items_downloaded: int = 0
    items_skipped: int = 0
    items_failed: int = 0
    robots_blocked: bool = False


class SiteAdapter(ABC):
    name: str

    @abstractmethod
    def list_items(self, filters: dict) -> Iterator[Item]:
        ...

    @abstractmethod
    def download_item(self, item: Item, ctx: DownloadContext) -> DownloadResult:
        ...

    @abstractmethod
    def robots_urls(self) -> list[str]:
        ...

    @abstractmethod
    def supported_filters(self) -> set[str]:
        ...

    @abstractmethod
    def required_args(self) -> set[str]:
        ...

    def storage_dir(self, item: Item) -> Path:
        """返回相对 base_dir 的目录路径。"""
        raise NotImplementedError
```

- [ ] **Step 2: Commit**

```bash
git add tools/crawler/src/adapters/base.py
git commit -m "feat(adapters): define SiteAdapter interface"
```

---

### Task 8: 创建通用编排 `core/crawler.py`

**Files:**
- Create: `src/core/crawler.py`
- Test: `tests/core/test_crawler.py`

- [ ] **Step 1: 写失败测试**

Create `tests/core/test_crawler.py`:

```python
from adapters.base import Item, DownloadResult, DownloadContext, CrawlResult
from core.crawler import Crawler


class FakeAdapter:
    name = "fake"

    def __init__(self):
        self.items = [
            Item(id="a", title="A", tags={}, raw={}),
            Item(id="b", title="B", tags={}, raw={}),
        ]
        self.downloaded = []

    def list_items(self, filters: dict):
        for item in self.items:
            if filters.get("only") is None or item.id in filters["only"]:
                yield item

    def download_item(self, item, ctx):
        self.downloaded.append(item.id)
        return DownloadResult(files_downloaded=1)

    def robots_urls(self):
        return ["https://example.com/robots.txt"]

    def supported_filters(self):
        return set()

    def required_args(self):
        return set()


class FakeFetcher:
    def fetch_text(self, url: str) -> str:
        return "User-agent: *\nAllow: /\n"

    def fetch_bytes(self, url: str) -> bytes:
        return b""


class TestCrawlerRun:
    def test_downloads_all_items(self, tmp_path):
        adapter = FakeAdapter()
        crawler = Crawler(adapter=adapter, fetcher=FakeFetcher())
        result = crawler.run(filters={})
        assert result.items_downloaded == 2
        assert adapter.downloaded == ["a", "b"]

    def test_respects_robots_disallow(self, tmp_path):
        class DisallowFetcher(FakeFetcher):
            def fetch_text(self, url: str) -> str:
                return "User-agent: *\nDisallow: /\n"

        adapter = FakeAdapter()
        crawler = Crawler(adapter=adapter, fetcher=DisallowFetcher())
        result = crawler.run(filters={})
        assert result.items_downloaded == 0
        assert result.robots_blocked is True
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pytest tests/core/test_crawler.py -v
```

Expected: `ModuleNotFoundError: No module named 'core.crawler'`。

- [ ] **Step 3: 实现 `core/crawler.py`**

```python
"""通用爬虫编排：按 SiteAdapter 驱动 fetcher/store/checkpoint/validator。"""

from adapters.base import CrawlResult, DownloadContext
from core.robots import RobotsChecker


class Crawler:
    def __init__(
        self,
        adapter,
        fetcher,
        store=None,
        checkpoint=None,
        validator=None,
        force: bool = False,
        dry_run: bool = False,
    ):
        self._adapter = adapter
        self._fetcher = fetcher
        self._store = store
        self._checkpoint = checkpoint
        self._validator = validator
        self._force = force
        self._dry_run = dry_run

    def run(self, filters: dict) -> CrawlResult:
        result = CrawlResult()

        for robots_url in self._adapter.robots_urls():
            robots_content = self._fetcher.fetch_text(robots_url)
            checker = RobotsChecker(robots_content)
            if not checker.is_allowed(robots_url):
                result.robots_blocked = True
                return result

        ctx = DownloadContext(
            fetcher=self._fetcher,
            store=self._store,
            checkpoint=self._checkpoint,
            validator=self._validator,
            force=self._force,
            dry_run=self._dry_run,
        )

        for item in self._adapter.list_items(filters):
            result.items_total += 1
            if self._checkpoint and self._checkpoint.is_downloaded(item.id) and not self._force:
                result.items_skipped += 1
                continue

            download_result = self._adapter.download_item(item, ctx)
            result.items_downloaded += download_result.files_downloaded
            result.items_skipped += download_result.files_skipped
            result.items_failed += download_result.files_failed

        return result
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pytest tests/core/test_crawler.py -q
```

Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add tools/crawler/src/core/crawler.py tools/crawler/tests/core/test_crawler.py
git commit -m "feat(core): add generic Crawler orchestration"
```

---

## Phase 3: zgkao Adapter 迁移

### Task 9: 创建 `adapters/zgkao.py` 包装现有逻辑

**Files:**
- Create: `src/adapters/zgkao.py`
- Modify: `src/main.py`（临时保持旧入口，先让 zgkao adapter 可用）
- Test: `tests/adapters/test_zgkao.py`

- [ ] **Step 1: 创建 `adapters/zgkao.py`**

```python
"""zgkao.com 试卷站点适配器。"""

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator
from urllib.parse import urlsplit

from adapters.base import DownloadContext, DownloadResult, Item, SiteAdapter
from classifier import Classification, Classifier
from core.checkpoint import Checkpoint
from core.fetcher import Fetcher
from core.robots import RobotsChecker
from core.storage import PdfStore
from core.validator import PdfValidator
from parser import DetailParser, IndexParser


_EXAM_TYPE_SEMESTER = {
    "一模": "second",
    "二模": "second",
    "三模": "second",
    "期末": "second",
    "期中": "first",
    "月考": "first",
}


@dataclass
class ZgkaoItem:
    """内部 item，用于递归处理二级索引。"""
    paper_item: object
    detail_url: str


class ZgkaoAdapter(SiteAdapter):
    name = "zgkao"

    def __init__(
        self,
        fetcher,
        entry_url: str,
        filters: dict,
        force: bool = False,
        dry_run: bool = False,
    ):
        self._fetcher = fetcher
        self._entry_url = entry_url
        self._filters = filters
        self._force = force
        self._dry_run = dry_run
        self._visited: set[str] = set()

    def robots_urls(self) -> list[str]:
        parts = urlsplit(self._entry_url)
        return [f"{parts.scheme}://{parts.netloc}/robots.txt"]

    def supported_filters(self) -> set[str]:
        return {"year", "subject", "district"}

    def required_args(self) -> set[str]:
        return {"url"}

    def list_items(self, filters: dict) -> Iterator[Item]:
        html = self._fetcher.fetch_text(self._entry_url)
        for paper in IndexParser.parse(html):
            yield Item(
                id=paper.detail_url,
                title=f"{paper.subject}-{paper.grade}-{paper.exam_type}-{paper.year}",
                tags={"subject": paper.subject, "district": paper.district, "year": paper.year},
                raw={"paper": paper},
            )

    def download_item(self, item: Item, ctx: DownloadContext) -> DownloadResult:
        result = DownloadResult()
        paper = item.raw["paper"]

        if item.id in self._visited:
            return result
        self._visited.add(item.id)

        if not self._passes_filter(paper):
            return result

        detail_html = ctx.fetcher.fetch_text(item.id)
        pdf_links = DetailParser.parse(detail_html)

        if pdf_links:
            is_split = (
                len(pdf_links) == 2
                and any(l.has_answer for l in pdf_links)
                and any(not l.has_answer for l in pdf_links)
            )
            for link in pdf_links:
                result += self._download_pdf(ctx, paper, link, is_split)
            return result

        sub_items = IndexParser.parse(detail_html)
        for sub in sub_items:
            result += self.download_item(
                Item(
                    id=sub.detail_url,
                    title=sub.subject,
                    tags={},
                    raw={"paper": sub},
                ),
                ctx,
            )
        return result

    def _download_pdf(self, ctx, paper, link, is_split: bool) -> DownloadResult:
        result = DownloadResult()
        if not ctx.force and ctx.checkpoint and ctx.checkpoint.is_downloaded(link.url):
            result.files_skipped += 1
            return result

        if ctx.dry_run:
            result.files_downloaded += 1
            return result

        content = ctx.fetcher.fetch_bytes(link.url)
        classification = self._build_classification(paper, link, is_split)
        dir_relpath = Classifier.storage_dir(classification)
        filename = Classifier.filename(classification)

        path = ctx.store.save(
            dir_relpath=dir_relpath,
            filename=filename,
            content=content,
            source_url=link.url,
            file_type="paper" if not link.has_answer else "answer",
            classification={
                "subject": classification.subject,
                "level": classification.level,
                "semester": classification.semester,
                "year": classification.year,
            },
        )

        validation = ctx.validator.validate(str(path))
        if not validation.is_valid:
            path.unlink(missing_ok=True)
            result.files_failed += 1
            return result

        if ctx.checkpoint:
            ctx.checkpoint.mark_downloaded(link.url)
        result.files_downloaded += 1
        return result

    def _build_classification(self, item, link, is_split: bool) -> Classification:
        semester = _EXAM_TYPE_SEMESTER.get(item.exam_type, "second")
        file_type = "答案" if (is_split and link.has_answer) else "试卷"
        return Classification(
            subject=item.subject,
            semester=semester,
            grade=item.grade,
            year=item.year,
            year_code=item.year + "07",
            district=item.district,
            exam_type=item.exam_type,
            file_type=file_type,
        )

    def _passes_filter(self, item) -> bool:
        if "years" in self._filters and item.year not in self._filters["years"]:
            return False
        if "subjects" in self._filters and item.subject not in self._filters["subjects"]:
            return False
        if "districts" in self._filters and item.district not in self._filters["districts"]:
            return False
        return True
```

- [ ] **Step 2: 合并 zgkao 测试到 `tests/adapters/test_zgkao.py`**

将 `test_main.py`、`test_parser.py`、`test_classifier.py` 的内容合并到 `tests/adapters/test_zgkao.py`，并更新 import：

```python
from adapters.zgkao import ZgkaoAdapter
```

关键 fixture 更新示例（原 `Crawler` 构造改为 `ZgkaoAdapter` + `Crawler`）：

```python
@pytest.fixture
def adapter(tmp_path, crawl_time):
    fetcher = MockFetcher()
    return ZgkaoAdapter(
        fetcher=fetcher,
        entry_url="https://www.zgkao.com/shitiku/89047.html",
        filters={},
    )


@pytest.fixture
def crawler(adapter, tmp_path, storage, checkpoint):
    from core.crawler import Crawler
    return Crawler(
        adapter=adapter,
        fetcher=adapter._fetcher,
        storage=storage,
        checkpoint=checkpoint,
        validator=PdfValidator(),
    )
```

断言从 `result.papers_downloaded` 改为 `result.items_downloaded`。

`test_main.py` 中 `TestCrawlerNormalRun.test_downloads_and_saves_pdf` 等用例改为通过 `crawler.run({})` 调用。

- [ ] **Step 3: 运行测试**

```bash
pytest tests/adapters/test_zgkao.py -q
```

Expected: all passed.

- [ ] **Step 4: Commit**

```bash
git add tools/crawler/src/adapters/zgkao.py tools/crawler/tests/adapters/test_zgkao.py tools/crawler/tests/adapters/test_zgkao_parser.py tools/crawler/tests/adapters/test_zgkao_classifier.py
git commit -m "feat(adapters): add zgkao adapter wrapping existing parser/classifier"
```

---

## Phase 4: smartedu Adapter（TDD）

### Task 10: smartedu tag.json 解析

**Files:**
- Create: `src/adapters/smartedu.py`（逐步增长）
- Test: `tests/adapters/test_smartedu.py`

- [ ] **Step 1: 写失败测试**

```python
import pytest
from unittest.mock import MagicMock

from adapters.smartedu import SmartEduTagCache


TAG_JSON = {
    "zxxxd": [{"tag_id": "zxxxd1", "tag_name": "小学"}, {"tag_id": "zxxxd2", "tag_name": "初中"}],
    "zxxxk": [{"tag_id": "zxxxk1", "tag_name": "数学"}],
    "zxxbb": [{"tag_id": "zxxbb1", "tag_name": "人教版"}],
    "zxxnj": [{"tag_id": "zxxnj9", "tag_name": "九年级"}],
    "zxxcc": [{"tag_id": "zxxcc1", "tag_name": "上册"}],
}


class TestSmartEduTagCache:
    def test_loads_tag_mapping(self):
        cache = SmartEduTagCache(TAG_JSON)
        assert cache.name("zxxxd", "zxxxd2") == "初中"

    def test_returns_tag_id_for_name(self):
        cache = SmartEduTagCache(TAG_JSON)
        assert cache.tag_id("zxxxd", "初中") == "zxxxd2"

    def test_normalizes_subject(self):
        cache = SmartEduTagCache(TAG_JSON)
        assert cache.normalize_subject("zxxxk1") == "数学"

    def test_standardizes_tags(self):
        cache = SmartEduTagCache(TAG_JSON)
        assert cache.standardize({"zxxxd": "zxxxd2", "zxxxk": "zxxxk1"}) == {
            "level": "初中", "subject": "数学"
        }
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pytest tests/adapters/test_smartedu.py::TestSmartEduTagCache -v
```

Expected: `ImportError`。

- [ ] **Step 3: 实现 `SmartEduTagCache`**

在 `src/adapters/smartedu.py` 写入：

```python
"""smartedu.cn 教材适配器。"""

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

from adapters.base import DownloadContext, DownloadResult, Item, SiteAdapter


_DIMENSION_MAP = {
    "zxxxd": "level",
    "zxxxk": "subject",
    "zxxbb": "publisher",
    "zxxnj": "grade",
    "zxxcc": "semester",
}


@dataclass
class SmartEduTagCache:
    data: dict

    def name(self, dimension: str, tag_id: str) -> str:
        for item in self.data.get(dimension, []):
            if item.get("tag_id") == tag_id:
                return item.get("tag_name", "")
        return ""

    def tag_id(self, dimension: str, name: str) -> str | None:
        for item in self.data.get(dimension, []):
            if item.get("tag_name") == name:
                return item.get("tag_id")
        return None

    def normalize_subject(self, tag_id: str) -> str:
        return self.name("zxxxk", tag_id)

    def standardize(self, tag_dict: dict) -> dict:
        result = {}
        for dim, key in _DIMENSION_MAP.items():
            value = tag_dict.get(dim)
            if value:
                result[key] = self.name(dim, value)
        return result
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pytest tests/adapters/test_smartedu.py::TestSmartEduTagCache -q
```

Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add tools/crawler/src/adapters/smartedu.py tools/crawler/tests/adapters/test_smartedu.py
git commit -m "feat(adapters): smartedu tag cache and standardization"
```

---

### Task 11: smartedu catalog 列表解析

**Files:**
- Modify: `src/adapters/smartedu.py`
- Test: `tests/adapters/test_smartedu.py`

- [ ] **Step 1: 写失败测试**

```python
PART_100 = [
    {
        "id": "71a82bac-0c70-4d53-9e8f-22be536415f0",
        "title": "义务教育教科书·数学九年级上册",
        "tag_list": ["zxxxd2", "zxxxk1", "zxxbb1", "zxxnj9", "zxxcc1"],
        "update_time": "2024-01-15",
        "custom_properties": {
            "preview": {
                "Slide1": "https://r3-ndr.ykt.cbern.com.cn/edu_product/esp/assets/71a82bac.t/zh-CN/1710000000000/transcode/image/1.jpg"
            }
        },
    },
]


class TestSmartEduCatalog:
    def test_lists_items_from_parts(self):
        from adapters.smartedu import SmartEduAdapter
        from unittest.mock import MagicMock
        adapter = SmartEduAdapter(fetcher=MagicMock())
        items = list(adapter._parse_catalog(TAG_JSON, [PART_100]))
        assert len(items) == 1
        assert items[0].title == "义务教育教科书·数学九年级上册"
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pytest tests/adapters/test_smartedu.py::TestSmartEduCatalog -v
```

Expected: `AttributeError`。

- [ ] **Step 3: 实现 catalog 解析**

在 `SmartEduAdapter`（尚未完整）中加入：

```python
class SmartEduAdapter(SiteAdapter):
    name = "smartedu"

    TAG_URL = "https://s-file-1.ykt.cbern.com.cn/zxx/ndrs/tags/tch_material_tag.json"
    VERSION_URL = "https://s-file-1.ykt.cbern.com.cn/zxx/ndrs/resources/tch_material/version/data_version.json"
    PART_URL_TEMPLATE = "https://s-file-{host_id}.ykt.cbern.com.cn/zxx/ndrs/resources/tch_material/part_{index}.json"

    def __init__(self, fetcher, base_dir: str = "data", latest_only: bool = True):
        self._fetcher = fetcher
        self._base_dir = base_dir
        self._latest_only = latest_only

    def robots_urls(self) -> list[str]:
        return [self.TAG_URL, self.VERSION_URL]

    def supported_filters(self) -> set[str]:
        return {"subject", "level", "grade", "semester", "publisher"}

    def required_args(self) -> set[str]:
        return set()

    def _parse_catalog(self, tag_data: dict, parts: list[list[dict]]) -> Iterator[Item]:
        cache = SmartEduTagCache(tag_data)
        all_items = []
        for part in parts:
            for raw in part:
                tags = cache.standardize({dim: tid for dim in _DIMENSION_MAP for tid in raw.get("tag_list", []) if cache.name(dim, tid)})
                all_items.append(Item(
                    id=raw["id"],
                    title=raw["title"],
                    tags=tags,
                    raw=raw,
                ))
        if self._latest_only:
            all_items = self._dedup_latest(all_items)
        for item in all_items:
            yield item

    def _dedup_latest(self, items: list[Item]) -> list[Item]:
        groups: dict[tuple, list[Item]] = {}
        for item in items:
            key = (item.title, item.tags.get("publisher"), item.tags.get("subject"))
            groups.setdefault(key, []).append(item)
        result = []
        for group in groups.values():
            group_sorted = sorted(group, key=lambda x: x.raw.get("update_time", ""), reverse=True)
            result.append(group_sorted[0])
        return result
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pytest tests/adapters/test_smartedu.py::TestSmartEduCatalog -q
```

Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add tools/crawler/src/adapters/smartedu.py tools/crawler/tests/adapters/test_smartedu.py
git commit -m "feat(adapters): smartedu catalog parsing and latest-only dedup"
```

---

### Task 12: smartedu 过滤逻辑

**Files:**
- Modify: `src/adapters/smartedu.py`
- Test: `tests/adapters/test_smartedu.py`

- [ ] **Step 1: 写失败测试**

```python
class TestSmartEduFilters:
    def test_filter_by_subject(self):
        from adapters.smartedu import SmartEduAdapter
        adapter = SmartEduAdapter(fetcher=MagicMock())
        items = [
            Item(id="1", title="数学", tags={"subject": "数学"}, raw={}),
            Item(id="2", title="语文", tags={"subject": "语文"}, raw={}),
        ]
        result = [i for i in items if adapter._matches(i, {"subject": {"数学"}})]
        assert len(result) == 1
        assert result[0].id == "1"

    def test_filter_by_publisher(self):
        from adapters.smartedu import SmartEduAdapter
        adapter = SmartEduAdapter(fetcher=MagicMock())
        item = Item(id="1", title="数学", tags={"publisher": "人教版"}, raw={})
        assert adapter._matches(item, {"publisher": {"人教版"}}) is True
        assert adapter._matches(item, {"publisher": {"北师大版"}}) is False

    def test_empty_filter_passes(self):
        from adapters.smartedu import SmartEduAdapter
        adapter = SmartEduAdapter(fetcher=MagicMock())
        item = Item(id="1", title="数学", tags={"subject": "数学"}, raw={})
        assert adapter._matches(item, {}) is True
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pytest tests/adapters/test_smartedu.py::TestSmartEduFilters -v
```

Expected: `AttributeError`。

- [ ] **Step 3: 实现 `_matches`**

```python
    def _matches(self, item: Item, filters: dict) -> bool:
        supported = self.supported_filters()
        for raw_key, allowed in filters.items():
            key = raw_key.rstrip("s")
            if key not in supported:
                continue
            if item.tags.get(key) not in allowed:
                return False
        return True
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pytest tests/adapters/test_smartedu.py::TestSmartEduFilters -q
```

Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add tools/crawler/src/adapters/smartedu.py tools/crawler/tests/adapters/test_smartedu.py
git commit -m "feat(adapters): smartedu item filtering"
```

---

### Task 13: smartedu 页数探测

**Files:**
- Modify: `src/adapters/smartedu.py`
- Test: `tests/adapters/test_smartedu.py`

- [ ] **Step 1: 写失败测试**

```python
class TestSmartEduPageDetection:
    def test_detects_two_pages(self):
        from adapters.smartedu import SmartEduAdapter
        adapter = SmartEduAdapter(fetcher=MagicMock())

        class HeadFetcher:
            def fetch_head(self, url: str):
                if url.endswith("/3.jpg"):
                    return 404, {}
                return 200, {"Content-Type": "image/jpeg"}

        template = "https://example.com/image/{N}.jpg"
        assert adapter._detect_page_count(HeadFetcher(), template) == 2

    def test_first_page_404_returns_zero(self):
        from adapters.smartedu import SmartEduAdapter
        adapter = SmartEduAdapter(fetcher=MagicMock())

        class HeadFetcher:
            def fetch_head(self, url: str):
                return 404, {}

        assert adapter._detect_page_count(HeadFetcher(), "https://example.com/{N}.jpg") == 0

    def test_caps_at_500(self):
        from adapters.smartedu import SmartEduAdapter
        adapter = SmartEduAdapter(fetcher=MagicMock())

        class HeadFetcher:
            def fetch_head(self, url: str):
                return 200, {}

        assert adapter._detect_page_count(HeadFetcher(), "https://example.com/{N}.jpg") == 500
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pytest tests/adapters/test_smartedu.py::TestSmartEduPageDetection -v
```

Expected: `AttributeError`。

- [ ] **Step 3: 实现 `_detect_page_count`**

```python
    _MAX_PAGES = 500

    def _detect_page_count(self, fetcher, template: str) -> int:
        for page in range(1, self._MAX_PAGES + 1):
            url = template.format(N=page)
            status, _ = fetcher.fetch_head(url)
            if status == 404:
                return page - 1
        return self._MAX_PAGES
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pytest tests/adapters/test_smartedu.py::TestSmartEduPageDetection -q
```

Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add tools/crawler/src/adapters/smartedu.py tools/crawler/tests/adapters/test_smartedu.py
git commit -m "feat(adapters): smartedu page count detection via HEAD"
```

---

### Task 14: smartedu 单页下载与重试

**Files:**
- Modify: `src/adapters/smartedu.py`
- Test: `tests/adapters/test_smartedu.py`

- [ ] **Step 1: 写失败测试**

```python
class TestSmartEduPageDownload:
    def test_downloads_valid_page(self, tmp_path):
        from adapters.smartedu import SmartEduAdapter
        from core.storage import ImageStore
        from datetime import datetime, timezone

        store = ImageStore(base_dir=str(tmp_path), entry_url="https://basic.smartedu.cn", crawl_time=datetime.now(timezone.utc))
        adapter = SmartEduAdapter(fetcher=MagicMock())

        class BytesFetcher:
            def fetch_bytes(self, url: str) -> bytes:
                return b"\xff\xd8\xffvalid"

        path = adapter._download_page(BytesFetcher(), store, Path("书"), 1, "https://example.com/1.jpg")
        assert path.is_file()
        assert path.name == "page_001.jpg"

    def test_retries_on_invalid_image(self, tmp_path):
        from adapters.smartedu import SmartEduAdapter
        from core.storage import ImageStore
        from core.validator import ImageValidator
        from datetime import datetime, timezone

        store = ImageStore(base_dir=str(tmp_path), entry_url="https://basic.smartedu.cn", crawl_time=datetime.now(timezone.utc))
        adapter = SmartEduAdapter(fetcher=MagicMock())

        attempts = []

        class BadThenGoodFetcher:
            def fetch_bytes(self, url: str) -> bytes:
                attempts.append(url)
                if len(attempts) == 1:
                    return b"not an image"
                return b"\xff\xd8\xffvalid"

        path = adapter._download_page(
            BadThenGoodFetcher(), store, Path("书"), 1, "https://example.com/1.jpg",
            validator=ImageValidator(),
        )
        assert path.is_file()
        assert len(attempts) == 2

    def test_skips_after_retry_fails(self, tmp_path):
        from adapters.smartedu import SmartEduAdapter
        from core.storage import ImageStore
        from core.validator import ImageValidator
        from datetime import datetime, timezone

        store = ImageStore(base_dir=str(tmp_path), entry_url="https://basic.smartedu.cn", crawl_time=datetime.now(timezone.utc))
        adapter = SmartEduAdapter(fetcher=MagicMock())

        class AlwaysBadFetcher:
            def fetch_bytes(self, url: str) -> bytes:
                return b"not an image"

        path = adapter._download_page(
            AlwaysBadFetcher(), store, Path("书"), 1, "https://example.com/1.jpg",
            validator=ImageValidator(),
        )
        assert path is None
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pytest tests/adapters/test_smartedu.py::TestSmartEduPageDownload -v
```

Expected: `AttributeError`。

- [ ] **Step 3: 实现 `_download_page`**

```python
    def _download_page(self, fetcher, store, dir_relpath: Path, page: int, url: str, validator=None):
        from core.validator import ImageValidator
        if validator is None:
            validator = ImageValidator()

        content = fetcher.fetch_bytes(url)
        path = store.save_page(dir_relpath, page, content, url)
        result = validator.validate(str(path))
        if result.is_valid:
            return path

        path.unlink(missing_ok=True)
        # retry once
        content = fetcher.fetch_bytes(url)
        path = store.save_page(dir_relpath, page, content, url)
        result = validator.validate(str(path))
        if result.is_valid:
            return path

        path.unlink(missing_ok=True)
        return None
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pytest tests/adapters/test_smartedu.py::TestSmartEduPageDownload -q
```

Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add tools/crawler/src/adapters/smartedu.py tools/crawler/tests/adapters/test_smartedu.py
git commit -m "feat(adapters): smartedu single page download with one retry"
```

---

### Task 15: smartedu 熔断与断点

**Files:**
- Modify: `src/adapters/smartedu.py`
- Test: `tests/adapters/test_smartedu.py`

- [ ] **Step 1: 写失败测试**

```python
class TestSmartEduCircuitBreaker:
    def test_circuit_breaker_after_three_consecutive_failures(self, tmp_path):
        from adapters.smartedu import SmartEduAdapter, CircuitBreakerError
        from core.storage import ImageStore
        from core.validator import ImageValidator
        from datetime import datetime, timezone

        store = ImageStore(base_dir=str(tmp_path), entry_url="https://basic.smartedu.cn", crawl_time=datetime.now(timezone.utc))
        adapter = SmartEduAdapter(fetcher=MagicMock())

        class FailingFetcher:
            def fetch_head(self, url: str):
                return 404 if url.endswith("/4.jpg") else 200, {}

            def fetch_bytes(self, url: str) -> bytes:
                return b"bad"

        with pytest.raises(CircuitBreakerError):
            adapter._download_book(
                FailingFetcher(), store, None,
                Item(id="book1", title="书", tags={}, raw={"custom_properties": {"preview": {"Slide1": "https://example.com/{N}.jpg"}}}),
                validator=ImageValidator(),
            )

    def test_resets_consecutive_failures_on_success(self, tmp_path):
        from adapters.smartedu import SmartEduAdapter
        from core.storage import ImageStore
        from core.validator import ImageValidator
        from datetime import datetime, timezone

        store = ImageStore(base_dir=str(tmp_path), entry_url="https://basic.smartedu.cn", crawl_time=datetime.now(timezone.utc))
        adapter = SmartEduAdapter(fetcher=MagicMock())

        calls = []

        class MixedFetcher:
            def fetch_head(self, url: str):
                return 404 if url.endswith("/4.jpg") else 200, {}

            def fetch_bytes(self, url: str) -> bytes:
                calls.append(url)
                # pages 1 and 3 fail, page 2 succeeds
                if url.endswith("/1.jpg") or url.endswith("/3.jpg"):
                    return b"bad"
                return b"\xff\xd8\xffok"

        result = adapter._download_book(
            MixedFetcher(), store, None,
            Item(id="book1", title="书", tags={}, raw={"custom_properties": {"preview": {"Slide1": "https://example.com/{N}.jpg"}}}),
            validator=ImageValidator(),
        )
        assert result.files_failed == 2
        assert result.files_downloaded == 1
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pytest tests/adapters/test_smartedu.py::TestSmartEduCircuitBreaker -v
```

Expected: `ImportError`。

- [ ] **Step 3: 实现 CircuitBreakerError 和 `_download_book`**

```python
class CircuitBreakerError(Exception):
    pass


class SmartEduAdapter(SiteAdapter):
    # ... existing ...

    def _download_book(self, fetcher, store, checkpoint, item: Item, validator=None, force: bool = False, dry_run: bool = False):
        from core.validator import ImageValidator
        if validator is None:
            validator = ImageValidator()

        preview = item.raw.get("custom_properties", {}).get("preview", {})
        slide1 = preview.get("Slide1", "")
        if not slide1:
            return DownloadResult(files_failed=1)

        template = slide1.replace("/1.jpg", "/{N}.jpg")
        if dry_run:
            return DownloadResult(files_downloaded=1)

        total_pages = self._detect_page_count(fetcher, template)
        if total_pages == 0:
            return DownloadResult(files_failed=1)

        dir_relpath = self._storage_dir(item)
        classification = dict(item.tags)
        classification["title"] = item.title
        source = {"asset_id": item.id, "content_id": item.raw.get("content_id", "")}
        store.init_book_meta(dir_relpath, classification, source, total_pages)

        result = DownloadResult()
        failed_pages = []
        consecutive_failures = 0

        for page in range(1, total_pages + 1):
            url = template.format(N=page)
            if checkpoint and checkpoint.is_downloaded(url) and not force:
                result.files_skipped += 1
                consecutive_failures = 0
                continue

            path = self._download_page(fetcher, store, dir_relpath, page, url, validator=validator)
            if path is None:
                result.files_failed += 1
                failed_pages.append(page)
                consecutive_failures += 1
                if consecutive_failures >= 3:
                    store.finalize_book(dir_relpath, failed_pages)
                    raise CircuitBreakerError(f"3 consecutive failures at page {page}")
            else:
                result.files_downloaded += 1
                consecutive_failures = 0
                if checkpoint:
                    checkpoint.mark_downloaded(url)

        store.finalize_book(dir_relpath, failed_pages)
        if checkpoint and not failed_pages:
            checkpoint.mark_downloaded(item.id)
        return result

    def _storage_dir(self, item: Item) -> Path:
        parts = [item.tags.get(k, "其他") for k in ["subject", "level", "publisher", "grade", "semester"]]
        parts.append(item.title)
        return Path(*parts)
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pytest tests/adapters/test_smartedu.py::TestSmartEduCircuitBreaker -q
```

Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add tools/crawler/src/adapters/smartedu.py tools/crawler/tests/adapters/test_smartedu.py
git commit -m "feat(adapters): smartedu circuit breaker and checkpoint integration"
```

---

### Task 16: smartedu `download_item` 完整接口 + meta 状态

**Files:**
- Modify: `src/adapters/smartedu.py`
- Test: `tests/adapters/test_smartedu.py`

- [ ] **Step 1: 写失败测试**

```python
class TestSmartEduDownloadItem:
    def test_download_item_success(self, tmp_path):
        from adapters.smartedu import SmartEduAdapter
        from core.storage import ImageStore
        from core.validator import ImageValidator
        from core.checkpoint import Checkpoint
        from adapters.base import DownloadContext
        from datetime import datetime, timezone

        store = ImageStore(base_dir=str(tmp_path), entry_url="https://basic.smartedu.cn", crawl_time=datetime.now(timezone.utc))
        checkpoint = Checkpoint(tmp_path / ".checkpoint.json")
        adapter = SmartEduAdapter(fetcher=MagicMock())

        class OkFetcher:
            def fetch_head(self, url: str):
                return 404 if url.endswith("/4.jpg") else 200, {}

            def fetch_bytes(self, url: str) -> bytes:
                return b"\xff\xd8\xffok"

        ctx = DownloadContext(fetcher=OkFetcher(), store=store, checkpoint=checkpoint, validator=ImageValidator())
        item = Item(id="book1", title="书", tags={"subject": "数学", "level": "初中"}, raw={"custom_properties": {"preview": {"Slide1": "https://example.com/{N}.jpg"}}})
        result = adapter.download_item(item, ctx)
        assert result.files_downloaded == 3
        meta = store.read_meta(Path("数学/初中/其他/其他/其他/书"))
        assert meta["status"] == "complete"

    def test_download_item_skips_complete_book(self, tmp_path):
        from adapters.smartedu import SmartEduAdapter
        from core.storage import ImageStore
        from core.checkpoint import Checkpoint
        from adapters.base import DownloadContext
        from datetime import datetime, timezone

        store = ImageStore(base_dir=str(tmp_path), entry_url="https://basic.smartedu.cn", crawl_time=datetime.now(timezone.utc))
        checkpoint = Checkpoint(tmp_path / ".checkpoint.json")
        checkpoint.mark_downloaded("book1")
        adapter = SmartEduAdapter(fetcher=MagicMock())

        class NoCallFetcher:
            def fetch_head(self, url: str):
                raise AssertionError("should not be called")

            def fetch_bytes(self, url: str) -> bytes:
                raise AssertionError("should not be called")

        ctx = DownloadContext(fetcher=NoCallFetcher(), store=store, checkpoint=checkpoint, validator=None)
        item = Item(id="book1", title="书", tags={}, raw={})
        result = adapter.download_item(item, ctx)
        assert result.files_skipped == 1
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pytest tests/adapters/test_smartedu.py::TestSmartEduDownloadItem -v
```

Expected: `NotImplementedError` or `AttributeError`。

- [ ] **Step 3: 实现 `download_item`**

```python
    def download_item(self, item: Item, ctx: DownloadContext) -> DownloadResult:
        if not ctx.force and ctx.checkpoint and ctx.checkpoint.is_downloaded(item.id):
            return DownloadResult(files_skipped=1)
        return self._download_book(
            ctx.fetcher,
            ctx.store,
            ctx.checkpoint,
            item,
            validator=ctx.validator,
            force=ctx.force,
            dry_run=ctx.dry_run,
        )
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pytest tests/adapters/test_smartedu.py::TestSmartEduDownloadItem -q
```

Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add tools/crawler/src/adapters/smartedu.py tools/crawler/tests/adapters/test_smartedu.py
git commit -m "feat(adapters): smartedu download_item with complete/partial status"
```

---

### Task 17: smartedu 端到端集成测试

**Files:**
- Modify: `tests/adapters/test_smartedu.py`

- [ ] **Step 1: 写失败测试**

```python
class TestSmartEduEndToEnd:
    def test_full_flow_mocked(self, tmp_path):
        from adapters.smartedu import SmartEduAdapter, SmartEduTagCache
        from core.storage import ImageStore
        from core.validator import ImageValidator
        from core.checkpoint import Checkpoint
        from core.fetcher import Fetcher
        from adapters.base import DownloadContext
        from datetime import datetime, timezone

        store = ImageStore(base_dir=str(tmp_path), entry_url="https://basic.smartedu.cn", crawl_time=datetime.now(timezone.utc))
        checkpoint = Checkpoint(tmp_path / ".checkpoint.json")

        adapter = SmartEduAdapter(fetcher=MagicMock(), latest_only=True)
        # patch catalog fetch
        adapter._fetch_catalog = lambda fetcher: (
            SmartEduTagCache(TAG_JSON),
            [PART_100],
        )

        ctx = DownloadContext(
            fetcher=Fetcher(),
            store=store,
            checkpoint=checkpoint,
            validator=ImageValidator(),
        )

        # list_items will use _fetch_catalog
        items = list(adapter.list_items({"subject": {"数学"}}))
        assert len(items) == 1

        # mock fetcher for HEAD/bytes
        class EndToEndFetcher:
            def fetch_head(self, url: str):
                return 404 if url.endswith("/4.jpg") else 200, {}

            def fetch_bytes(self, url: str) -> bytes:
                return b"\xff\xd8\xffpage"

        ctx.fetcher = EndToEndFetcher()
        result = adapter.download_item(items[0], ctx)
        assert result.files_downloaded == 3
        meta = store.read_meta(Path("数学/初中/人教版/九年级/上册/义务教育教科书·数学九年级上册"))
        assert meta["status"] == "complete"
        assert len(meta["files"]) == 3
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pytest tests/adapters/test_smartedu.py::TestSmartEduEndToEnd -v
```

Expected: `_fetch_catalog` not found。

- [ ] **Step 3: 实现 `_fetch_catalog` 并让 `list_items` 调用它**

```python
    def list_items(self, filters: dict) -> Iterator[Item]:
        # For testing, allow injecting _fetch_catalog; in production use fetcher.
        fetch_catalog = getattr(self, "_fetch_catalog", None)
        if fetch_catalog is not None:
            tag_cache, parts = fetch_catalog(None)
        else:
            tag_cache, parts = self._load_catalog(self._fetcher)
        for item in self._parse_catalog(tag_cache.data, parts):
            if self._matches(item, filters):
                yield item

    def _load_catalog(self, fetcher):
        tag_text = fetcher.fetch_text(self.TAG_URL)
        tag_data = json.loads(tag_text)
        version_text = fetcher.fetch_text(self.VERSION_URL)
        version_data = json.loads(version_text)
        part_count = version_data.get("part_count", 1)
        parts = []
        for i in range(part_count):
            index = 100 + i
            url = self.PART_URL_TEMPLATE.format(host_id=(i % 2) + 1, index=index)
            part_text = fetcher.fetch_text(url)
            parts.append(json.loads(part_text))
        return SmartEduTagCache(tag_data), parts
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pytest tests/adapters/test_smartedu.py::TestSmartEduEndToEnd -q
```

Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add tools/crawler/src/adapters/smartedu.py tools/crawler/tests/adapters/test_smartedu.py
git commit -m "test(adapters): smartedu end-to-end mocked flow"
```

---

## Phase 5: CLI 集成与文档

### Task 18: 重写 `src/main.py` 为 CLI 调度器

**Files:**
- Modify: `src/main.py`
- Test: `tests/test_cli.py`

- [ ] **Step 1: 写失败测试**

Create `tests/test_cli.py`:

```python
import pytest

from main import parse_args


class TestCliParseArgs:
    def test_site_required(self):
        with pytest.raises(SystemExit):
            parse_args([])

    def test_site_zgkao_requires_url(self):
        with pytest.raises(SystemExit):
            parse_args(["--site", "zgkao"])

    def test_site_smartedu_accepts_subject(self):
        args = parse_args(["--site", "smartedu", "--subject", "数学"])
        assert args.site == "smartedu"
        assert args.subject == "数学"

    def test_rejects_unsupported_filter_for_site(self):
        with pytest.raises(SystemExit):
            parse_args(["--site", "zgkao", "--url", "https://example.com", "--grade", "九年级"])
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pytest tests/test_cli.py -v
```

Expected: `ImportError` / `ModuleNotFoundError`。

- [ ] **Step 3: 实现 `src/main.py`**

```python
"""CLI 入口：按 --site 选择 adapter 并运行通用 Crawler。"""

import argparse
from datetime import datetime, timezone
from pathlib import Path

from adapters.smartedu import SmartEduAdapter
from adapters.zgkao import ZgkaoAdapter
from core.checkpoint import Checkpoint
from core.crawler import Crawler
from core.fetcher import Fetcher
from core.storage import ImageStore, PdfStore
from core.validator import ImageValidator, PdfValidator


_ADAPTERS = {
    "zgkao": ZgkaoAdapter,
    "smartedu": SmartEduAdapter,
}


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="K12 试卷/教材爬虫")
    parser.add_argument("--site", required=True, choices=list(_ADAPTERS), help="站点适配器")
    parser.add_argument("--url", help="入口页 URL（zgkao 必填）")
    parser.add_argument("--output", default="./data", help="输出目录")
    parser.add_argument("--subject", help="学科过滤")
    parser.add_argument("--year", help="年份过滤（zgkao）")
    parser.add_argument("--district", help="区县过滤（zgkao）")
    parser.add_argument("--level", help="学段过滤（smartedu）")
    parser.add_argument("--grade", help="年级过滤（smartedu）")
    parser.add_argument("--semester", help="册次过滤（smartedu）")
    parser.add_argument("--publisher", help="版本过滤（smartedu）")
    parser.add_argument("--latest-only", action="store_true", default=True, help="smartedu 同书只取最新")
    parser.add_argument("--no-latest-only", dest="latest_only", action="store_false")
    parser.add_argument("--force", action="store_true", help="强制重新下载")
    parser.add_argument("--dry-run", action="store_true", help="只检查不下载")
    parser.add_argument("--crawl-delay", type=float, default=None, help="礼貌延时（秒）")
    args = parser.parse_args(argv)
    _validate_args(parser, args)
    return args


def _validate_args(parser, args):
    adapter_cls = _ADAPTERS[args.site]
    required = adapter_cls.required_args()
    if "url" in required and not args.url:
        parser.error(f"--site {args.site} requires --url")

    supported = adapter_cls.supported_filters()
    filter_map = {
        "year": args.year,
        "subject": args.subject,
        "district": args.district,
        "level": args.level,
        "grade": args.grade,
        "semester": args.semester,
        "publisher": args.publisher,
    }
    for key, value in filter_map.items():
        if value is not None and key not in supported:
            parser.error(f"--{key.replace('_', '-')} is not supported for site {args.site}")


def _build_filters(args):
    filters = {}
    for key in ["year", "subject", "district", "level", "grade", "semester", "publisher"]:
        value = getattr(args, key)
        if value:
            filters[key + "s"] = set(value.split(","))
    return filters


def main(argv=None):
    args = parse_args(argv)

    crawl_time = datetime.now(timezone.utc)
    output_path = Path(args.output)
    checkpoint = Checkpoint(output_path / ".checkpoint.json")
    checkpoint.load()

    crawl_delay = args.crawl_delay
    if crawl_delay is None:
        crawl_delay = 0.0 if args.site == "zgkao" else 0.5

    fetcher = Fetcher(crawl_delay=crawl_delay)
    filters = _build_filters(args)

    if args.site == "zgkao":
        store = PdfStore(
            base_dir=str(output_path),
            entry_url=args.url,
            crawl_time=crawl_time,
            site_adapter="zgkao",
        )
        validator = PdfValidator()
        adapter = ZgkaoAdapter(
            fetcher=fetcher,
            entry_url=args.url,
            filters=filters,
        )
    else:
        store = ImageStore(
            base_dir=str(output_path),
            entry_url="https://basic.smartedu.cn/tchMaterial",
            crawl_time=crawl_time,
            site_adapter="smartedu",
        )
        validator = ImageValidator()
        adapter = SmartEduAdapter(
            fetcher=fetcher,
            base_dir=str(output_path),
            latest_only=args.latest_only,
        )

    crawler = Crawler(
        adapter=adapter,
        fetcher=fetcher,
        store=store,
        checkpoint=checkpoint,
        validator=validator,
        force=args.force,
        dry_run=args.dry_run,
    )

    result = crawler.run(filters)
    print(
        f"Total: {result.items_total}, Downloaded: {result.items_downloaded}, "
        f"Skipped: {result.items_skipped}, Failed: {result.items_failed}"
    )


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pytest tests/test_cli.py -q
```

Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add tools/crawler/src/main.py tools/crawler/tests/test_cli.py
git commit -m "feat(cli): dispatcher for zgkao and smartedu adapters"
```

---

### Task 19: 删除兼容 shim 并全量跑测试

**Files:**
- Delete: `src/fetcher.py`, `src/robots.py`, `src/checkpoint.py`, `src/validator.py`, `src/storage.py`
- Delete: `tests/adapters/test_zgkao_parser.py`, `tests/adapters/test_zgkao_classifier.py`
- Modify: `tests/core/test_storage.py` import 路径
- Modify: `tests/adapters/test_zgkao.py` import 路径

- [ ] **Step 1: 删除 shim 文件**

```bash
cd tools/crawler
rm src/fetcher.py src/robots.py src/checkpoint.py src/validator.py src/storage.py
rm tests/adapters/test_zgkao_parser.py tests/adapters/test_zgkao_classifier.py
```

- [ ] **Step 2: 更新所有 import 为新的绝对路径**

Search/replace:
- `from fetcher import` → `from core.fetcher import`
- `from robots import` → `from core.robots import`
- `from checkpoint import` → `from core.checkpoint import`
- `from validator import` → `from core.validator import`
- `from storage import` → `from core.storage import`
- `from main import Crawler` → `from adapters.zgkao import ZgkaoAdapter`（在 test_zgkao.py）

- [ ] **Step 3: 运行全部测试**

```bash
pytest tests/ -q
```

Expected: 140 existing + new tests passed.

- [ ] **Step 4: Commit**

```bash
git add tools/crawler/
git commit -m "cleanup: remove compatibility shims and finalize imports"
```

---

### Task 20: 烟雾测试（`@pytest.mark.network`，默认跳过）

**Files:**
- Create: `tests/test_smoke_network.py`
- Modify: `pytest.ini`

- [ ] **Step 1: 创建烟雾测试**

```python
import pytest


pytestmark = pytest.mark.network


@pytest.mark.network
def test_smartedu_download_one_book(tmp_path):
    from adapters.smartedu import SmartEduAdapter
    from core.checkpoint import Checkpoint
    from core.crawler import Crawler
    from core.fetcher import Fetcher
    from core.storage import ImageStore
    from core.validator import ImageValidator
    from datetime import datetime, timezone

    output = tmp_path / "data"
    checkpoint = Checkpoint(output / ".checkpoint.json")
    store = ImageStore(
        base_dir=str(output),
        entry_url="https://basic.smartedu.cn/tchMaterial",
        crawl_time=datetime.now(timezone.utc),
    )
    fetcher = Fetcher(crawl_delay=1.0)
    adapter = SmartEduAdapter(base_dir=str(output), latest_only=True)
    crawler = Crawler(
        adapter=adapter,
        fetcher=fetcher,
        store=store,
        checkpoint=checkpoint,
        validator=ImageValidator(),
    )
    result = crawler.run({"subjects": {"数学"}, "levels": {"初中"}, "grades": {"九年级"}, "semesters": {"上册"}})
    assert result.items_downloaded >= 1
```

- [ ] **Step 2: 更新 `pytest.ini`**

```ini
[pytest]
testpaths = tests tests/core tests/adapters
python_files = test_*.py
python_classes = Test*
python_functions = test_*
markers =
    network: tests that hit real network (skipped by default)
addopts = -m "not network"
```

- [ ] **Step 3: 运行测试（烟雾测试被跳过）**

```bash
pytest tests/ -q
```

Expected: all passed except network marker skipped.

- [ ] **Step 4: Commit**

```bash
git add tools/crawler/tests/test_smoke_network.py tools/crawler/pytest.ini
git commit -m "test: add optional smartedu network smoke test"
```

---

### Task 21: 更新 README.md

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 在 README 中新增 adapter 架构和 smartedu 用法**

在“模块”节后追加：

```markdown
## 多站点架构

```
src/
├── core/               # 站点无关：fetcher, robots, checkpoint, validator, storage, crawler
└── adapters/           # 站点适配器
    ├── base.py         # SiteAdapter 接口
    ├── zgkao.py        # zgkao.com 试卷
    └── smartedu.py     # basic.smartedu.cn 教材预览图
```

新增 smartedu 用法小节：

```markdown
## smartedu 教材用法

```bash
python src/main.py --site smartedu \
  --subject 数学 \
  --level 初中 \
  --grade 九年级 \
  --semester 上册 \
  --publisher 人教版 \
  --output ./data
```

说明：
- smartedu 仅下载公开预览图（`page_001.jpg` ...），不登录、不下 PDF。
- `--latest-only` 默认开启，同书多版本只保留最新。
- 单页失败会重试 1 次；连续 3 页失败触发熔断并停止。
```

- [ ] **Step 2: Commit**

```bash
git add tools/crawler/README.md
git commit -m "docs: update README with multi-site architecture and smartedu usage"
```

---

## 自检清单

计划写完后必须运行以下检查：

1. **Spec 覆盖检查**：对照 `docs/superpowers/specs/2026-07-04-smartedu-textbook-crawler-design.md`：
   - [ ] SiteAdapter 接口已定义（§2）
   - [ ] core/crawler.py 通用编排已规划（§2）
   - [ ] smartedu JSON catalog + HEAD 探测 + 图片下载已规划（§3）
   - [ ] ImageValidator + ImageStore 已规划（§4、§7）
   - [ ] CLI --site + 参数校验已规划（§5）
   - [ ] 熔断 + 断点续传 + meta.json 生命周期已规划（§6）
   - [ ] 140 个现有测试迁移路径已规划（§7）
   - [ ] 烟雾测试已规划（§7）

2. **Placeholder 扫描**：搜索以下禁用词，确保不存在：
   - [ ] `TBD`、`TODO`、`implement later`、`fill in details`
   - [ ] 空泛的 "add error handling" / "write tests" 无代码描述
   - [ ] 未定义的类型/函数引用

3. **类型一致性检查**：
   - [ ] `DownloadContext` 字段名在 `adapters/base.py`、所有 adapter、`core/crawler.py`、`main.py` 中一致
   - [ ] `CrawlResult` 字段名在 `core/crawler.py`、`main.py`、测试中一致
   - [ ] `ImageStore.save_page` 签名与测试、smartedu adapter 中调用一致
   - [ ] `fetch_head` 返回 `tuple[int, dict]` 与测试、adapter 一致

4. **迁移安全**：
   - [ ] 迁移期间保留 `src/fetcher.py` 等兼容 shim，Task 19 再删除
   - [ ] 每步 commit 后都跑测试，确保 140 个断言不被破坏

---

## 执行选项

**Plan complete and saved to `docs/superpowers/plans/2026-07-04-smartedu-textbook-crawler.md`.**

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

Which approach?
