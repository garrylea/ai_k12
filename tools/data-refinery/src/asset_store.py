"""资源存储抽象：把图片复制到规范资源目录，返回 §9 规范相对路径。

MVP 用 ``LocalAssetStore``（本地 ``output/assets/``）。DB 仅存相对路径，
前端运行时拼 ``ASSET_BASE_URL``。后续可加 ``OssAssetStore``，相对路径不变，
只换 ``ASSET_BASE_URL``，无需改动 db_loader / image_rewrite。

参见 ``docs/K12智学系统-数据库设计文档.md`` §9（素材存储规范）。
"""

from pathlib import Path
from typing import Protocol


class AssetStore(Protocol):
    """资源存储接口：写入文件、返回供 DB 存储的规范相对路径。"""

    def put(self, rel_path: str, src_file: Path) -> str:
        """把 ``src_file`` 写入 ``rel_path``，返回 ``rel_path``（供 DB 存储）。"""
        ...

    def exists(self, rel_path: str) -> bool:
        """``rel_path`` 是否已存在。"""
        ...


class LocalAssetStore:
    """本地文件系统实现：复制到 ``root/<rel_path>``，幂等。"""

    def __init__(self, root: Path) -> None:
        self._root = Path(root)

    def put(self, rel_path: str, src_file: Path) -> str:
        src = Path(src_file)
        dst = self._root / rel_path
        dst.parent.mkdir(parents=True, exist_ok=True)
        # 幂等：目标已存在且同尺寸则跳过写入（规范名按 item 唯一，不会跨 item 碰撞）
        if not (dst.exists() and dst.stat().st_size == src.stat().st_size):
            dst.write_bytes(src.read_bytes())
        return rel_path

    def exists(self, rel_path: str) -> bool:
        return (self._root / rel_path).exists()
