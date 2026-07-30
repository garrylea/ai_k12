from pathlib import Path

from checkpoint import RefineryCheckpoint


class TestRefineryCheckpoint:
    def test_mark_converted_and_extracted(self, tmp_path):
        cp = RefineryCheckpoint(tmp_path / "checkpoint.json")
        cp.load()
        assert not cp.is_converted("a/b")
        cp.mark_converted("a/b")
        cp.mark_extracted("a/b")
        cp.mark_published("a/b")

        cp2 = RefineryCheckpoint(tmp_path / "checkpoint.json")
        cp2.load()
        assert cp2.is_converted("a/b")
        assert cp2.is_extracted("a/b")
        assert cp2.is_published("a/b")

    def test_missing_file_loads_empty(self, tmp_path):
        cp = RefineryCheckpoint(tmp_path / "missing.json")
        cp.load()
        assert not cp.is_converted("x")
        assert not cp.is_extracted("x")

    def test_corrupt_file_loads_empty(self, tmp_path):
        path = tmp_path / "corrupt.json"
        path.write_text("not json")
        cp = RefineryCheckpoint(path)
        cp.load()
        assert not cp.is_converted("x")


class TestTocParsed:
    def test_mark_and_query_toc_parsed(self, tmp_path):
        from checkpoint import RefineryCheckpoint
        ckpt = RefineryCheckpoint(tmp_path / ".checkpoint.json")
        ckpt.load()
        assert not ckpt.is_toc_parsed("数学/人教版/九年级下册")
        ckpt.mark_toc_parsed("数学/人教版/九年级下册")
        assert ckpt.is_toc_parsed("数学/人教版/九年级下册")

    def test_unmark_toc_parsed(self, tmp_path):
        from checkpoint import RefineryCheckpoint
        ckpt = RefineryCheckpoint(tmp_path / ".checkpoint.json")
        ckpt.load()
        ckpt.mark_toc_parsed("a")
        ckpt.unmark_toc_parsed("a")
        assert not ckpt.is_toc_parsed("a")

    def test_persistence_toc_parsed(self, tmp_path):
        from checkpoint import RefineryCheckpoint
        ckpt = RefineryCheckpoint(tmp_path / ".checkpoint.json")
        ckpt.load()
        ckpt.mark_toc_parsed("b")
        ckpt2 = RefineryCheckpoint(tmp_path / ".checkpoint.json")
        ckpt2.load()
        assert ckpt2.is_toc_parsed("b")
