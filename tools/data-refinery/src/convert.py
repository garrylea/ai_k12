"""Markdown 转换器：调用 MinerU 将 PDF/图片转换为 Markdown。"""

import os
import subprocess
import time
from pathlib import Path

from scanner import Material


class MineruRunner:
    def __init__(self, bin_path: str = "mineru-open-api", timeout: int = 300, token: str | None = None, max_retries: int = 3, retry_delay: int = 30):
        self._bin = bin_path
        self._timeout = timeout
        self._token = token
        self._max_retries = max_retries
        self._retry_delay = retry_delay

    def run(self, input_paths: list[Path], output_dir: Path) -> None:
        output_dir.mkdir(parents=True, exist_ok=True)
        cmd = [
            self._bin,
            "extract",
            *[str(p) for p in input_paths],
            "-o", str(output_dir),
        ]
        self._run(cmd)

    def _run(self, cmd: list[str]) -> None:
        env = os.environ.copy()
        if self._token:
            env["MINERU_TOKEN"] = self._token
        last_err: Exception | None = None
        for attempt in range(1, self._max_retries + 1):
            try:
                subprocess.run(cmd, check=True, timeout=self._timeout, capture_output=True, text=True, env=env)
                return
            except subprocess.CalledProcessError as e:
                last_err = e
                stderr_tail = (e.stderr or "")[-500:]
                print(f"  [attempt {attempt}/{self._max_retries}] failed (exit {e.returncode}): {stderr_tail}")
            except subprocess.TimeoutExpired as e:
                last_err = e
                print(f"  [attempt {attempt}/{self._max_retries}] timeout after {self._timeout}s")
            if attempt < self._max_retries:
                print(f"  retrying in {self._retry_delay}s...")
                time.sleep(self._retry_delay)
        raise last_err


class Converter:
    def __init__(self, runner: MineruRunner, output_dir: Path):
        self._runner = runner
        self._output_dir = Path(output_dir)

    def convert(self, material: Material) -> Path:
        target_dir = self._output_dir / material.rel_path
        target_dir.mkdir(parents=True, exist_ok=True)
        if self._already_converted(target_dir):
            return target_dir

        self._runner.run(material.input_paths, target_dir)
        return target_dir

    @staticmethod
    def _already_converted(target_dir: Path) -> bool:
        if not target_dir.exists():
            return False
        return any(target_dir.glob("*.md"))
