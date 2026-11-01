"""断点续传：记录已转换和已提取的素材路径。"""

import json
from pathlib import Path


class RefineryCheckpoint:
    def __init__(self, path: Path) -> None:
        self._path = Path(path)
        self._converted: set[str] = set()
        self._extracted: set[str] = set()
        self._published: set[str] = set()
        # published 的**发布口径版本**：改写逻辑升级后（如 2026-10-31 开始改写 answer），
        # 旧版本产出的 published 文件不能算数，必须自动重发，而不是让用户记得加 --force。
        self._publish_versions: dict[str, int] = {}
        self._toc_parsed: set[str] = set()

    def load(self) -> None:
        if not self._path.exists():
            return
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, ValueError):
            return
        self._converted = set(data.get("converted", []))
        self._extracted = set(data.get("extracted", []))
        self._published = set(data.get("published", []))
        self._publish_versions = {
            str(k): int(v) for k, v in (data.get("publish_versions") or {}).items()
        }
        self._toc_parsed = set(data.get("toc_parsed", []))

    def is_converted(self, rel_path: str) -> bool:
        return rel_path in self._converted

    def is_extracted(self, rel_path: str) -> bool:
        return rel_path in self._extracted

    def mark_converted(self, rel_path: str) -> None:
        self._converted.add(rel_path)
        self.save()

    def mark_extracted(self, rel_path: str) -> None:
        self._extracted.add(rel_path)
        self.save()

    def is_published(self, rel_path: str) -> bool:
        return rel_path in self._published

    def publish_version_of(self, rel_path: str) -> int | None:
        """该文件上次发布时的口径版本；None = 旧版 checkpoint（无版本号）→ 视为过期。"""
        return self._publish_versions.get(rel_path)

    def mark_published(self, rel_path: str, version: int | None = None) -> None:
        self._published.add(rel_path)
        if version is not None:
            self._publish_versions[rel_path] = version
        self.save()

    def unmark_converted(self, rel_path: str) -> None:
        self._converted.discard(rel_path)
        self.save()

    def unmark_extracted(self, rel_path: str) -> None:
        self._extracted.discard(rel_path)
        self.save()

    def unmark_published(self, rel_path: str) -> None:
        self._published.discard(rel_path)
        self._publish_versions.pop(rel_path, None)
        self.save()

    def is_toc_parsed(self, rel_path: str) -> bool:
        return rel_path in self._toc_parsed

    def mark_toc_parsed(self, rel_path: str) -> None:
        self._toc_parsed.add(rel_path)
        self.save()

    def unmark_toc_parsed(self, rel_path: str) -> None:
        self._toc_parsed.discard(rel_path)
        self.save()

    def save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(
            json.dumps(
                {
                    "converted": sorted(self._converted),
                    "extracted": sorted(self._extracted),
                    "published": sorted(self._published),
                    "publish_versions": dict(sorted(self._publish_versions.items())),
                    "toc_parsed": sorted(self._toc_parsed),
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
