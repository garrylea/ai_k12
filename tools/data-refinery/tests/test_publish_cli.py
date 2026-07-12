import json
from pathlib import Path
from unittest.mock import MagicMock, patch

from publish_cli import main


def _setup(tmp_path: Path) -> Path:
    out = tmp_path / "out"
    # extract 产物：一份试卷 JSONL，题干含图片引用
    ext = out / "extracted" / "数学" / "试卷"
    ext.mkdir(parents=True)
    q = {
        "subject_id": "math",
        "type": "short_answer",
        "difficulty": 1,
        "content": "如图 ![](images/fig1.jpg) 求面积",
        "answer": "1",
    }
    (ext / "试卷.jsonl").write_text(json.dumps(q, ensure_ascii=False) + "\n", encoding="utf-8")
    # 对应 md 目录下的 images/fig1.jpg
    md_images = out / "md" / "数学" / "试卷" / "images"
    md_images.mkdir(parents=True)
    (md_images / "fig1.jpg").write_bytes(b"\xff\xd8\xff" + b"fig1")
    return out


class TestPublishCli:
    def test_publish_rewrites_and_materializes(self, tmp_path, capsys):
        out = _setup(tmp_path)
        with patch("publish_cli.RefineryConfig") as mock_config:
            mock_config.from_env.return_value = MagicMock(output_dir=out)
            main(["--input-dir", str(out / "extracted"), "--output-dir", str(out / "published")])

        published = out / "published" / "数学" / "试卷" / "试卷.jsonl"
        assert published.exists()
        item = json.loads(published.read_text(encoding="utf-8").strip())
        assert "images/fig1.jpg" not in item["content"]
        assert "questions/math/" in item["content"]
        assert "/stem_01.jpg" in item["content"]
        # 图片已物化到 output/assets/
        asset_root = out / "assets" / "questions" / "math"
        assert any(asset_root.rglob("stem_01.jpg"))

    def test_checkpoint_skips_on_rerun(self, tmp_path, capsys):
        out = _setup(tmp_path)
        with patch("publish_cli.RefineryConfig") as mock_config:
            mock_config.from_env.return_value = MagicMock(output_dir=out)
            main(["--input-dir", str(out / "extracted"), "--output-dir", str(out / "published")])
            capsys.readouterr()  # 清空首次输出
            main(["--input-dir", str(out / "extracted"), "--output-dir", str(out / "published")])

        captured = capsys.readouterr()
        assert "Skipped: 1" in captured.out

    def test_dry_run_prints_without_writing(self, tmp_path, capsys):
        out = _setup(tmp_path)
        with patch("publish_cli.RefineryConfig") as mock_config:
            mock_config.from_env.return_value = MagicMock(output_dir=out)
            main(["--input-dir", str(out / "extracted"), "--dry-run"])

        captured = capsys.readouterr()
        assert "[dry-run]" in captured.out
        assert "试卷" in captured.out
        # dry-run 不应产出 published 文件
        assert not (out / "published").exists()
