"""HTTP 请求模块。

基于 requests 实现，支持重试、自定义 User-Agent、Range 断点续传。
"""

import time
from pathlib import Path

import requests


_DEFAULT_TIMEOUT = 30


class Fetcher:
    def __init__(
        self,
        user_agent: str = "K12Crawler/1.0",
        max_retries: int = 3,
        crawl_delay: float = 0.0,
        timeout: int = _DEFAULT_TIMEOUT,
    ) -> None:
        self._user_agent = user_agent
        self._max_retries = max_retries
        self._crawl_delay = crawl_delay
        self._timeout = timeout
        self._session = requests.Session()
        self._session.headers["User-Agent"] = user_agent

    def fetch_text(self, url: str) -> str:
        response = self._fetch_with_retry(url, stream=False)
        return response.text

    def fetch_bytes(self, url: str) -> bytes:
        response = self._fetch_with_retry(url, stream=False)
        return response.content

    def download_with_resume(self, url: str, dest_path: Path) -> int:
        dest_path = Path(dest_path)
        existing_size = dest_path.stat().st_size if dest_path.exists() else 0

        headers = {}
        if existing_size > 0:
            headers["Range"] = f"bytes={existing_size}-"

        response = self._fetch_with_retry(url, stream=True, extra_headers=headers)
        mode = "ab" if response.status_code == 206 and existing_size > 0 else "wb"
        bytes_written = 0
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        with open(dest_path, mode) as f:
            for chunk in response.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)
                    bytes_written += len(chunk)
        return bytes_written

    def fetch_head(self, url: str) -> tuple[int, dict]:
        """Send HEAD request. Returns (status_code, headers_dict). Does not raise on 4xx."""
        for attempt in range(self._max_retries):
            if attempt > 0 and self._crawl_delay > 0:
                time.sleep(self._crawl_delay)
            try:
                response = self._session.request(
                    method="HEAD",
                    url=url,
                    timeout=self._timeout,
                )
            except requests.RequestException:
                continue
            if response.status_code >= 500:
                continue
            return response.status_code, dict(response.headers)
        return 503, {}

    def _fetch_with_retry(self, url: str, stream: bool, extra_headers: dict | None = None):
        last_response = None
        for attempt in range(self._max_retries):
            if attempt > 0 and self._crawl_delay > 0:
                time.sleep(self._crawl_delay)
            try:
                response = self._session.get(
                    url,
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
