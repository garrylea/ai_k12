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
