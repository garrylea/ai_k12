"""storage.py 的 TDD 测试。

验证目录创建、PDF 保存、meta.json 生成与追加更新。

meta.json 结构参考计划：
    {
      "classification": {...},
      "source": {"site", "entry_url", "crawl_time"},
      "files": [{"filename", "type", "source_url", "download_time", "size_bytes", "md5"}],
      "config": {"crawler_version", "robots_txt_checked"}
    }
"""

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from classifier import Classification, Classifier
from core.storage import ImageStore, PdfStore


@pytest.fixture
def classification():
    return Classification(
        subject="数学",
        semester="first",
        grade="初三",
        year="2026",
        year_code="202607",
        district="西城",
        exam_type="期末",
        file_type="试卷",
    )


@pytest.fixture
def crawl_time():
    return datetime(2026, 6, 29, 10, 30, 0, tzinfo=timezone.utc)


@pytest.fixture
def storage(tmp_path, crawl_time):
    return PdfStore(
        base_dir=str(tmp_path),
        entry_url="https://www.zgkao.com/shitiku/89047.html",
        crawl_time=crawl_time,
    )


_FILE_TYPE_MAP = {"试卷": "paper", "答案": "answer"}


def save_pdf(store, cls, content=b"fake-pdf-content", source_url="https://cdn.zgkao.com/x.pdf"):
    """等价于被删除的 Storage.save_pdf：按分类推导目录/文件名/类型。"""
    return store.save(
        dir_relpath=Classifier.storage_dir(cls, ""),
        filename=Classifier.filename(cls),
        content=content,
        source_url=source_url,
        file_type=_FILE_TYPE_MAP[cls.file_type],
        classification={
            "subject": cls.subject,
            "level": cls.level,
            "semester": cls.semester,
            "year": cls.year,
        },
    )


class TestSavePdfCreatesStructure:
    def test_creates_directory_tree(self, storage, classification, tmp_path):
        save_pdf(storage, classification, b"fake-pdf-content", "https://cdn.zgkao.com/x.pdf")
        expected_dir = tmp_path / "数学" / "初中" / "first" / "2026"
        assert expected_dir.is_dir()

    def test_writes_file_with_normalized_name(self, storage, classification, tmp_path):
        save_pdf(storage, classification, b"fake-pdf-content", "https://cdn.zgkao.com/x.pdf")
        expected_file = tmp_path / "数学" / "初中" / "first" / "2026" / "数学-初三(上)-202607-西城-期末-试卷.pdf"
        assert expected_file.is_file()
        assert expected_file.read_bytes() == b"fake-pdf-content"

    def test_returns_saved_path(self, storage, classification, tmp_path):
        path = save_pdf(storage, classification, b"fake-pdf-content", "https://cdn.zgkao.com/x.pdf")
        assert Path(path).is_file()
        assert "数学-初三(上)-202607-西城-期末-试卷.pdf" in str(path)


class TestMetaJsonCreation:
    def test_creates_meta_json(self, storage, classification, tmp_path):
        save_pdf(storage, classification, b"fake-pdf-content", "https://cdn.zgkao.com/x.pdf")
        meta_path = tmp_path / "数学" / "初中" / "first" / "2026" / "meta.json"
        assert meta_path.is_file()

    def test_meta_has_classification_section(self, storage, classification, tmp_path):
        save_pdf(storage, classification, b"fake-pdf-content", "https://cdn.zgkao.com/x.pdf")
        meta = _read_meta(tmp_path, classification)
        assert meta["classification"] == {
            "subject": "数学",
            "level": "初中",
            "semester": "first",
            "year": "2026",
        }

    def test_meta_has_source_section(self, storage, classification, tmp_path):
        save_pdf(storage, classification, b"fake-pdf-content", "https://cdn.zgkao.com/x.pdf")
        meta = _read_meta(tmp_path, classification)
        assert meta["source"]["site"] == "zgkao.com"
        assert meta["source"]["entry_url"] == "https://www.zgkao.com/shitiku/89047.html"
        assert meta["source"]["crawl_time"] == "2026-06-29T10:30:00Z"

    def test_meta_has_config_section(self, storage, classification, tmp_path):
        save_pdf(storage, classification, b"fake-pdf-content", "https://cdn.zgkao.com/x.pdf")
        meta = _read_meta(tmp_path, classification)
        assert meta["config"]["crawler_version"] == "2.0.0"
        assert meta["config"]["robots_txt_checked"] is True

    def test_meta_has_files_array_with_one_record(self, storage, classification, tmp_path):
        save_pdf(storage, classification, b"fake-pdf-content", "https://cdn.zgkao.com/x.pdf")
        meta = _read_meta(tmp_path, classification)
        assert len(meta["files"]) == 1


class TestFileRecord:
    def test_record_has_filename(self, storage, classification, tmp_path):
        save_pdf(storage, classification, b"fake-pdf-content", "https://cdn.zgkao.com/x.pdf")
        record = _read_meta(tmp_path, classification)["files"][0]
        assert record["filename"] == "数学-初三(上)-202607-西城-期末-试卷.pdf"

    def test_record_has_type_paper_for_试卷(self, storage, classification, tmp_path):
        save_pdf(storage, classification, b"fake-pdf-content", "https://cdn.zgkao.com/x.pdf")
        record = _read_meta(tmp_path, classification)["files"][0]
        assert record["type"] == "paper"

    def test_record_has_type_answer_for_答案(self, tmp_path, crawl_time):
        storage = PdfStore(base_dir=str(tmp_path), entry_url="https://www.zgkao.com/s.html", crawl_time=crawl_time)
        cls = Classification(
            subject="数学", semester="first", grade="初三", year="2026",
            year_code="202607", district="西城", exam_type="期末", file_type="答案",
        )
        save_pdf(storage, cls, b"content", "https://cdn.zgkao.com/a.pdf")
        record = _read_meta(tmp_path, cls)["files"][0]
        assert record["type"] == "answer"

    def test_record_has_source_url(self, storage, classification, tmp_path):
        save_pdf(storage, classification, b"content", "https://cdn.zgkao.com/specific.pdf")
        record = _read_meta(tmp_path, classification)["files"][0]
        assert record["source_url"] == "https://cdn.zgkao.com/specific.pdf"

    def test_record_has_download_time(self, storage, classification, tmp_path):
        save_pdf(storage, classification, b"content", "https://cdn.zgkao.com/x.pdf")
        record = _read_meta(tmp_path, classification)["files"][0]
        assert record["download_time"] == "2026-06-29T10:30:00Z"

    def test_record_has_size_bytes(self, storage, classification, tmp_path):
        content = b"hello-pdf"
        save_pdf(storage, classification, content, "https://cdn.zgkao.com/x.pdf")
        record = _read_meta(tmp_path, classification)["files"][0]
        assert record["size_bytes"] == len(content)

    def test_record_has_md5(self, storage, classification, tmp_path):
        content = b"hello-pdf"
        save_pdf(storage, classification, content, "https://cdn.zgkao.com/x.pdf")
        record = _read_meta(tmp_path, classification)["files"][0]
        expected_md5 = hashlib.md5(content).hexdigest()
        assert record["md5"] == expected_md5


class TestAppendBehavior:
    def test_second_save_keeps_first_record(self, storage, classification, tmp_path):
        save_pdf(storage, classification, b"paper", "https://cdn.zgkao.com/p1.pdf")
        answer_cls = Classification(
            subject="数学", semester="first", grade="初三", year="2026",
            year_code="202607", district="西城", exam_type="期末", file_type="答案",
        )
        save_pdf(storage, answer_cls, b"answer", "https://cdn.zgkao.com/a1.pdf")
        meta = _read_meta(tmp_path, classification)
        assert len(meta["files"]) == 2
        filenames = [f["filename"] for f in meta["files"]]
        assert "数学-初三(上)-202607-西城-期末-试卷.pdf" in filenames
        assert "数学-初三(上)-202607-西城-期末-答案.pdf" in filenames

    def test_second_save_does_not_overwrite_first_file(self, storage, classification, tmp_path):
        save_pdf(storage, classification, b"paper", "https://cdn.zgkao.com/p1.pdf")
        answer_cls = Classification(
            subject="数学", semester="first", grade="初三", year="2026",
            year_code="202607", district="西城", exam_type="期末", file_type="答案",
        )
        save_pdf(storage, answer_cls, b"answer", "https://cdn.zgkao.com/a1.pdf")
        base = tmp_path / "数学" / "初中" / "first" / "2026"
        assert (base / "数学-初三(上)-202607-西城-期末-试卷.pdf").read_bytes() == b"paper"
        assert (base / "数学-初三(上)-202607-西城-期末-答案.pdf").read_bytes() == b"answer"


class TestRobotsCheckedFlag:
    def test_robots_checked_false_reflected_in_config(self, tmp_path, crawl_time):
        storage = PdfStore(
            base_dir=str(tmp_path),
            entry_url="https://www.zgkao.com/s.html",
            crawl_time=crawl_time,
            robots_checked=False,
        )
        cls = Classification(
            subject="数学", semester="first", grade="初三", year="2026",
            year_code="202607", district="西城", exam_type="期末", file_type="试卷",
        )
        save_pdf(storage, cls, b"x", "https://cdn.zgkao.com/x.pdf")
        meta = _read_meta(tmp_path, cls)
        assert meta["config"]["robots_txt_checked"] is False


def _read_meta(base_dir: Path, cls: Classification) -> dict:
    meta_path = base_dir / cls.subject / cls.level / cls.semester / cls.year / "meta.json"
    return json.loads(meta_path.read_text(encoding="utf-8"))


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
