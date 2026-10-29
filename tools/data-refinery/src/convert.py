"""Markdown 转换器：调用 MinerU 将 PDF/图片转换为 Markdown。"""

import base64
import json
import os
import subprocess
import time
from pathlib import Path

from scanner import Material


def token_problem_message(token: str | None) -> str | None:
    """MINERU_TOKEN 支持两种形态（MinerU 控制台现在发的是后一种）：

    - 旧版 JWT：`eyJ...`，约 400 字符，OpenXLab 签发，有效期约 90 天；
    - 新版 API Key：`sk-...`，约 50 字符，无 exp。

    常见坑：从某些配置界面复制到的是 `mineru-api/sk-...`（带 provider 前缀），
    直接当 token 发出去会被 MinerU 判 A0202；这里提前提示只取 `sk-` 那段。
    """
    if not token:
        return None
    where = "https://mineru.net/apiManage/token"

    if "/" in token:
        return (
            f"MINERU_TOKEN 带了 provider 前缀（当前「{token[:18]}…」）。"
            "只填 `sk-` 开头的那一段，例如 `mineru-api/sk-xxx` 要裁成 `sk-xxx`；"
            f"Token 可在 {where} 查看。"
        )

    parts = token.split(".")
    if token.startswith("sk-"):
        return None
    if not token.startswith("eyJ") or len(parts) != 3:
        return (
            f"MINERU_TOKEN 格式不对（当前以「{token[:12]}…」开头，长度 {len(token)}）。"
            f"MinerU 的 Token 应为 `eyJ` 开头的 JWT 或 `sk-` 开头的 API Key，请到 {where} 复制。"
        )
    try:
        payload = parts[1] + "=" * (-len(parts[1]) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload))
        exp = int(claims.get("exp", 0))
    except (ValueError, TypeError, json.JSONDecodeError):
        return None
    if not exp or exp > time.time():
        return None
    when = time.strftime("%Y-%m-%d %H:%M", time.localtime(exp))
    return (
        f"MINERU_TOKEN 已于 {when} 过期（MinerU 会回 401 / A0202 user authenticate failed）。"
        f"请到 {where} 重新生成，更新 tools/data-refinery/.env "
        "以及 shell 里的 export MINERU_TOKEN 后重跑。"
    )


class MineruRunner:
    def __init__(self, bin_path: str = "mineru-open-api", timeout: int = 600, token: str | None = None, max_retries: int = 3, retry_delay: int = 70):
        self._bin = bin_path
        self._timeout = timeout
        self._token = token
        self._max_retries = max_retries
        self._retry_delay = retry_delay

    _BATCH_SIZE = 10  # MinerU API rate limit: 50 files/min

    _DOCUMENT_SUFFIXES = frozenset({".pdf", ".doc", ".docx", ".ppt", ".pptx"})

    @classmethod
    def _is_document(cls, paths: list[Path]) -> bool:
        """整份文档（PDF/Office）vs 教材拆页图片。

        两者日志和节流语义不同：文档是「一份文件一个任务」，图片是「一页一张」。
        早期统一按页打日志，PDF 会被说成 `pages 1-1/1`（1 份 12 页的卷也这么显示）。
        """
        return bool(paths) and all(p.suffix.lower() in cls._DOCUMENT_SUFFIXES for p in paths)

    def run(self, input_paths: list[Path], output_dir: Path) -> None:
        output_dir.mkdir(parents=True, exist_ok=True)
        is_document = self._is_document(input_paths)
        unit = "files" if is_document else "pages"
        # Resume: skip pages that already have corresponding .md output
        existing_mds = {p.stem for p in output_dir.glob("*.md")}
        pending = [p for p in input_paths if p.stem not in existing_mds]
        if not pending:
            print(f"  [resume] all {len(input_paths)} {unit} already converted")
            return
        skipped = len(input_paths) - len(pending)
        if skipped:
            print(f"  [resume] {skipped}/{len(input_paths)} {unit} already converted, processing {len(pending)} remaining")
        # Batch to stay under MinerU API rate limit (~50 files/min)
        # 页码用 input_paths 里的原始序号（全书第几页）；/后是本次剩余待转页数
        page_no = {p: idx + 1 for idx, p in enumerate(input_paths)}
        for i in range(0, len(pending), self._BATCH_SIZE):
            batch = pending[i : i + self._BATCH_SIZE]
            cmd = [
                self._bin,
                "extract",
                *[str(p) for p in batch],
                "-o", str(output_dir),
            ]
            self._run(cmd)
            if is_document:
                # 文档按份提交，一份一个任务；不再假装是「第 1-1/1 页」
                names = "、".join(p.name for p in batch)
                print(f"  [doc] {names} done")
                continue
            if i + self._BATCH_SIZE < len(pending):
                print(f"  [batch] pages {page_no[batch[0]]}-{page_no[batch[-1]]}/{len(pending)} done, pausing 15s...")
            else:
                print(f"  [batch] pages {page_no[batch[0]]}-{page_no[batch[-1]]}/{len(pending)} done")
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
