from pathlib import Path

from asset_store import LocalAssetStore


class TestLocalAssetStore:
    def test_put_creates_file_and_returns_rel_path(self, tmp_path):
        store = LocalAssetStore(tmp_path / "assets")
        src = tmp_path / "img.jpg"
        src.write_bytes(b"\xff\xd8\xff")

        rel = store.put("questions/math/1024/stem_01.jpg", src)

        assert rel == "questions/math/1024/stem_01.jpg"
        dst = tmp_path / "assets" / "questions" / "math" / "1024" / "stem_01.jpg"
        assert dst.exists()
        assert dst.read_bytes() == b"\xff\xd8\xff"

    def test_put_creates_nested_dirs(self, tmp_path):
        store = LocalAssetStore(tmp_path / "assets")
        src = tmp_path / "a.png"
        src.write_bytes(b"PNG")

        store.put("textbooks/math/55/page_01_fig_01.png", src)

        assert store.exists("textbooks/math/55/page_01_fig_01.png")

    def test_put_is_idempotent(self, tmp_path):
        store = LocalAssetStore(tmp_path / "assets")
        src = tmp_path / "img.jpg"
        src.write_bytes(b"data")

        rel = store.put("questions/math/1/stem_01.jpg", src)
        rel2 = store.put("questions/math/1/stem_01.jpg", src)

        assert rel == rel2
        assert store.exists(rel)

    def test_exists_returns_false_for_missing(self, tmp_path):
        store = LocalAssetStore(tmp_path / "assets")
        assert not store.exists("questions/math/999/stem_01.jpg")
