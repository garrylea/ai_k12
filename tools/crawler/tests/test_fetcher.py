"""fetcher.py 的 TDD 测试。

HTTP 请求、重试、User-Agent、Range 断点续传。
使用 requests_mock 模拟 HTTP 响应。
"""

from pathlib import Path

import pytest
import requests
import requests_mock

from fetcher import Fetcher


@pytest.fixture
def fetcher():
    return Fetcher(user_agent="K12Crawler/1.0", max_retries=3)


class TestFetchText:
    def test_returns_response_text(self, fetcher):
        with requests_mock.Mocker() as m:
            m.get("https://example.com/page.html", text="<html>hello</html>")
            result = fetcher.fetch_text("https://example.com/page.html")
            assert result == "<html>hello</html>"

    def test_sends_custom_user_agent(self, fetcher):
        with requests_mock.Mocker() as m:
            m.get("https://example.com/page.html", text="ok")
            fetcher.fetch_text("https://example.com/page.html")
            assert m.last_request.headers["User-Agent"] == "K12Crawler/1.0"

    def test_retries_on_server_error_then_succeeds(self, fetcher):
        with requests_mock.Mocker() as m:
            m.get(
                "https://example.com/page.html",
                [
                    {"status_code": 500},
                    {"status_code": 500},
                    {"status_code": 200, "text": "ok"},
                ],
            )
            result = fetcher.fetch_text("https://example.com/page.html")
            assert result == "ok"
            assert m.call_count == 3

    def test_raises_after_max_retries(self, tmp_path):
        fetcher = Fetcher(user_agent="K12Crawler/1.0", max_retries=3)
        with requests_mock.Mocker() as m:
            m.get("https://example.com/page.html", status_code=500)
            with pytest.raises(requests.HTTPError):
                fetcher.fetch_text("https://example.com/page.html")
            assert m.call_count == 3

    def test_does_not_retry_on_404(self, fetcher):
        with requests_mock.Mocker() as m:
            m.get("https://example.com/missing.html", status_code=404)
            with pytest.raises(requests.HTTPError):
                fetcher.fetch_text("https://example.com/missing.html")
            assert m.call_count == 1


class TestFetchBytes:
    def test_returns_binary_content(self, fetcher):
        with requests_mock.Mocker() as m:
            m.get("https://example.com/file.pdf", content=b"%PDF-1.4 fake")
            result = fetcher.fetch_bytes("https://example.com/file.pdf")
            assert result == b"%PDF-1.4 fake"


class TestDownloadWithResume:
    def test_new_download_writes_full_content(self, fetcher, tmp_path):
        dest = tmp_path / "out.pdf"
        with requests_mock.Mocker() as m:
            m.get("https://example.com/file.pdf", content=b"PDFCONTENT12345")
            written = fetcher.download_with_resume("https://example.com/file.pdf", dest)
            assert dest.read_bytes() == b"PDFCONTENT12345"
            assert written == len(b"PDFCONTENT12345")

    def test_new_download_sends_no_range_header(self, fetcher, tmp_path):
        dest = tmp_path / "out.pdf"
        with requests_mock.Mocker() as m:
            m.get("https://example.com/file.pdf", content=b"PDFCONTENT12345")
            fetcher.download_with_resume("https://example.com/file.pdf", dest)
            assert "Range" not in m.last_request.headers

    def test_resume_sends_range_header(self, fetcher, tmp_path):
        dest = tmp_path / "out.pdf"
        dest.write_bytes(b"PDF")  # already have first 3 bytes
        with requests_mock.Mocker() as m:
            m.get(
                "https://example.com/file.pdf",
                content=b"CONTENT12345",
                status_code=206,
                headers={"Content-Range": "bytes 3-13/14"},
            )
            fetcher.download_with_resume("https://example.com/file.pdf", dest)
            assert m.last_request.headers["Range"] == "bytes=3-"
            assert dest.read_bytes() == b"PDFCONTENT12345"

    def test_resume_returns_bytes_written_this_run(self, fetcher, tmp_path):
        dest = tmp_path / "out.pdf"
        dest.write_bytes(b"PDF")
        with requests_mock.Mocker() as m:
            m.get(
                "https://example.com/file.pdf",
                content=b"CONTENT12345",
                status_code=206,
            )
            written = fetcher.download_with_resume("https://example.com/file.pdf", dest)
            assert written == len(b"CONTENT12345")

    def test_resume_falls_back_to_full_download_on_200(self, fetcher, tmp_path):
        dest = tmp_path / "out.pdf"
        dest.write_bytes(b"PARTIAL")
        with requests_mock.Mocker() as m:
            m.get("https://example.com/file.pdf", content=b"FULLCONTENT", status_code=200)
            fetcher.download_with_resume("https://example.com/file.pdf", dest)
            assert dest.read_bytes() == b"FULLCONTENT"
