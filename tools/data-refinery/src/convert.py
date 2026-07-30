"""Markdown 转换器：调用 MinerU 将 PDF/图片转换为 Markdown。"""

import os
import subprocess
import time
from pathlib import Path

from scanner import Material


class MineruRunner:
    def __init__(self, bin_path: str = "mineru-open-api", timeout: int = 600, token: str | None = None, max_retries: int = 3, retry_delay: int = 70):
        self._bin = bin_path
        self._timeout = timeout
        self._token = token
        self._max_retries = max_retries
        self._retry_delay = retry_delay

    _BATCH_SIZE = 10  # MinerU API rate limit: 50 files/min

    def run(self, input_paths: list[Path], output_dir: Path) -> None:
        output_dir.mkdir(parents=True, exist_ok=True)
        # Resume: skip pages that already have corresponding .md output
        existing_mds = {p.stem for p in output_dir.glob("*.md")}
        pending = [p for p in input_paths if p.stem not in existing_mds]
        if not pending:
            print(f"  [resume] all {len(input_paths)} pages already converted")
            return
        skipped = len(input_paths) - len(pending)
        if skipped:
            print(f"  [resume] {skipped}/{len(input_paths)} pages already converted, processing {len(pending)} remaining")
        # Batch to stay under MinerU API rate limit (~50 files/min)
        for i in range(0, len(pending), self._BATCH_SIZE):
            batch = pending[i : i + self._BATCH_SIZE]
            cmd = [
                self._bin,
                "extract",
                *[str(p) for p in batch],
                "-o", str(output_dir),
            ]
            self._run(cmd)
            if i + self._BATCH_SIZE < len(pending):
                print(f"  [batch] {i+1}-{min(i+self._BATCH_SIZE, len(pending))}/{len(pending)}, pausing 15s...")
                time.sleep(15)

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

    def convert(self, material: Material, reconvert: bool = False) -> Path:
        target_dir = self._output_dir / material.rel_path
        if reconvert:
            # Clear all output before re-converting from scratch
            if target_dir.exists():
                import shutil
                shutil.rmtree(target_dir)
        target_dir.mkdir(parents=True, exist_ok=True)

        self._runner.run(material.input_paths, target_dir)
        return target_dir
