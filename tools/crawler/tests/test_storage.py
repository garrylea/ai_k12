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

from classifier import Classification
from storage import Storage


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
    return Storage(
        base_dir=str(tmp_path),
        entry_url="https://www.zgkao.com/shitiku/89047.html",
        crawl_time=crawl_time,
    )


class TestSavePdfCreatesStructure:
    def test_creates_directory_tree(self, storage, classification, tmp_path):
        storage.save_pdf(classification, b"fake-pdf-content", "https://cdn.zgkao.com/x.pdf")
        expected_dir = tmp_path / "数学" / "初中" / "first" / "2026"
        assert expected_dir.is_dir()

    def test_writes_file_with_normalized_name(self, storage, classification, tmp_path):
        storage.save_pdf(classification, b"fake-pdf-content", "https://cdn.zgkao.com/x.pdf")
        expected_file = tmp_path / "数学" / "初中" / "first" / "2026" / "数学-初三(上)-202607-西城-期末-试卷.pdf"
        assert expected_file.is_file()
        assert expected_file.read_bytes() == b"fake-pdf-content"

    def test_returns_saved_path(self, storage, classification, tmp_path):
        path = storage.save_pdf(classification, b"fake-pdf-content", "https://cdn.zgkao.com/x.pdf")
        assert Path(path).is_file()
        assert "数学-初三(上)-202607-西城-期末-试卷.pdf" in str(path)


class TestMetaJsonCreation:
    def test_creates_meta_json(self, storage, classification, tmp_path):
        storage.save_pdf(classification, b"fake-pdf-content", "https://cdn.zgkao.com/x.pdf")
        meta_path = tmp_path / "数学" / "初中" / "first" / "2026" / "meta.json"
        assert meta_path.is_file()

    def test_meta_has_classification_section(self, storage, classification, tmp_path):
        storage.save_pdf(classification, b"fake-pdf-content", "https://cdn.zgkao.com/x.pdf")
        meta = _read_meta(tmp_path, classification)
        assert meta["classification"] == {
            "subject": "数学",
            "level": "初中",
            "semester": "first",
            "year": "2026",
        }

    def test_meta_has_source_section(self, storage, classification, tmp_path):
        storage.save_pdf(classification, b"fake-pdf-content", "https://cdn.zgkao.com/x.pdf")
        meta = _read_meta(tmp_path, classification)
        assert meta["source"]["site"] == "zgkao.com"
        assert meta["source"]["entry_url"] == "https://www.zgkao.com/shitiku/89047.html"
        assert meta["source"]["crawl_time"] == "2026-06-29T10:30:00Z"

    def test_meta_has_config_section(self, storage, classification, tmp_path):
        storage.save_pdf(classification, b"fake-pdf-content", "https://cdn.zgkao.com/x.pdf")
        meta = _read_meta(tmp_path, classification)
        assert meta["config"]["crawler_version"] == "1.0.0"
        assert meta["config"]["robots_txt_checked"] is True

    def test_meta_has_files_array_with_one_record(self, storage, classification, tmp_path):
        storage.save_pdf(classification, b"fake-pdf-content", "https://cdn.zgkao.com/x.pdf")
        meta = _read_meta(tmp_path, classification)
        assert len(meta["files"]) == 1


class TestFileRecord:
    def test_record_has_filename(self, storage, classification, tmp_path):
        storage.save_pdf(classification, b"fake-pdf-content", "https://cdn.zgkao.com/x.pdf")
        record = _read_meta(tmp_path, classification)["files"][0]
        assert record["filename"] == "数学-初三(上)-202607-西城-期末-试卷.pdf"

    def test_record_has_type_paper_for_试卷(self, storage, classification, tmp_path):
        storage.save_pdf(classification, b"fake-pdf-content", "https://cdn.zgkao.com/x.pdf")
        record = _read_meta(tmp_path, classification)["files"][0]
        assert record["type"] == "paper"

    def test_record_has_type_answer_for_答案(self, tmp_path, crawl_time):
        storage = Storage(base_dir=str(tmp_path), entry_url="https://www.zgkao.com/s.html", crawl_time=crawl_time)
        cls = Classification(
            subject="数学", semester="first", grade="初三", year="2026",
            year_code="202607", district="西城", exam_type="期末", file_type="答案",
        )
        storage.save_pdf(cls, b"content", "https://cdn.zgkao.com/a.pdf")
        record = _read_meta(tmp_path, cls)["files"][0]
        assert record["type"] == "answer"

    def test_record_has_source_url(self, storage, classification, tmp_path):
        storage.save_pdf(classification, b"content", "https://cdn.zgkao.com/specific.pdf")
        record = _read_meta(tmp_path, classification)["files"][0]
        assert record["source_url"] == "https://cdn.zgkao.com/specific.pdf"

    def test_record_has_download_time(self, storage, classification, tmp_path):
        storage.save_pdf(classification, b"content", "https://cdn.zgkao.com/x.pdf")
        record = _read_meta(tmp_path, classification)["files"][0]
        assert record["download_time"] == "2026-06-29T10:30:00Z"

    def test_record_has_size_bytes(self, storage, classification, tmp_path):
        content = b"hello-pdf"
        storage.save_pdf(classification, content, "https://cdn.zgkao.com/x.pdf")
        record = _read_meta(tmp_path, classification)["files"][0]
        assert record["size_bytes"] == len(content)

    def test_record_has_md5(self, storage, classification, tmp_path):
        content = b"hello-pdf"
        storage.save_pdf(classification, content, "https://cdn.zgkao.com/x.pdf")
        record = _read_meta(tmp_path, classification)["files"][0]
        expected_md5 = hashlib.md5(content).hexdigest()
        assert record["md5"] == expected_md5


class TestAppendBehavior:
    def test_second_save_keeps_first_record(self, storage, classification, tmp_path):
        storage.save_pdf(classification, b"paper", "https://cdn.zgkao.com/p1.pdf")
        answer_cls = Classification(
            subject="数学", semester="first", grade="初三", year="2026",
            year_code="202607", district="西城", exam_type="期末", file_type="答案",
        )
        storage.save_pdf(answer_cls, b"answer", "https://cdn.zgkao.com/a1.pdf")
        meta = _read_meta(tmp_path, classification)
        assert len(meta["files"]) == 2
        filenames = [f["filename"] for f in meta["files"]]
        assert "数学-初三(上)-202607-西城-期末-试卷.pdf" in filenames
        assert "数学-初三(上)-202607-西城-期末-答案.pdf" in filenames

    def test_second_save_does_not_overwrite_first_file(self, storage, classification, tmp_path):
        storage.save_pdf(classification, b"paper", "https://cdn.zgkao.com/p1.pdf")
        answer_cls = Classification(
            subject="数学", semester="first", grade="初三", year="2026",
            year_code="202607", district="西城", exam_type="期末", file_type="答案",
        )
        storage.save_pdf(answer_cls, b"answer", "https://cdn.zgkao.com/a1.pdf")
        base = tmp_path / "数学" / "初中" / "first" / "2026"
        assert (base / "数学-初三(上)-202607-西城-期末-试卷.pdf").read_bytes() == b"paper"
        assert (base / "数学-初三(上)-202607-西城-期末-答案.pdf").read_bytes() == b"answer"


class TestRobotsCheckedFlag:
    def test_robots_checked_false_reflected_in_config(self, tmp_path, crawl_time):
        storage = Storage(
            base_dir=str(tmp_path),
            entry_url="https://www.zgkao.com/s.html",
            crawl_time=crawl_time,
            robots_checked=False,
        )
        cls = Classification(
            subject="数学", semester="first", grade="初三", year="2026",
            year_code="202607", district="西城", exam_type="期末", file_type="试卷",
        )
        storage.save_pdf(cls, b"x", "https://cdn.zgkao.com/x.pdf")
        meta = _read_meta(tmp_path, cls)
        assert meta["config"]["robots_txt_checked"] is False


def _read_meta(base_dir: Path, cls: Classification) -> dict:
    meta_path = base_dir / cls.subject / cls.level / cls.semester / cls.year / "meta.json"
    return json.loads(meta_path.read_text(encoding="utf-8"))
