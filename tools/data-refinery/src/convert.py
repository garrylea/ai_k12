"""Markdown 转换器：调用 MinerU 将 PDF/图片转换为 Markdown。"""

import subprocess
from pathlib import Path

from scanner import Material


class MineruRunner:
    def __init__(self, bin_path: str = "mineru-open-api", timeout: int = 300):
        self._bin = bin_path
        self._timeout = timeout

    def run(self, input_paths: list[Path], output_dir: Path) -> None:
        output_dir.mkdir(parents=True, exist_ok=True)
        cmd = [
            self._bin,
            "extract",
            *[str(p) for p in input_paths],
            "-o", str(output_dir),
            "-f", "md",
        ]
        self._run(cmd)

    def _run(self, cmd: list[str]) -> None:
        subprocess.run(cmd, check=True, timeout=self._timeout, capture_output=True, text=True)


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
