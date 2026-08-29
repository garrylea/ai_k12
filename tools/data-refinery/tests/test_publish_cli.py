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

    def test_subject_code_derived_from_path_not_hardcoded(self, tmp_path):
        """回归：化学试卷的资产路径应是 questions/chemistry/ 而不是硬编码的 math。"""
        out = tmp_path / "out"
        ext = out / "extracted" / "化学" / "初中" / "second" / "2024"
        ext.mkdir(parents=True)
        q = {
            "subject_id": "chem",
            "type": "short_answer",
            "difficulty": 1,
            "content": "如图 ![](images/fig1.jpg) 求质量分数",
            "answer": "1",
        }
        (ext / "化学-试卷.jsonl").write_text(json.dumps(q, ensure_ascii=False) + "\n", encoding="utf-8")
        md_images = out / "md" / "化学" / "初中" / "second" / "2024" / "images"
        md_images.mkdir(parents=True)
        (md_images / "fig1.jpg").write_bytes(b"\xff\xd8\xff" + b"fig1")

        with patch("publish_cli.RefineryConfig") as mock_config:
            mock_config.from_env.return_value = MagicMock(output_dir=out)
            main(["--input-dir", str(out / "extracted"), "--output-dir", str(out / "published")])

        published = out / "published" / "化学" / "初中" / "second" / "2024" / "化学-试卷.jsonl"
        assert published.exists()
        item = json.loads(published.read_text(encoding="utf-8").strip())
        assert "questions/chemistry/" in item["content"]
        assert "questions/math/" not in item["content"]
        # 图片物化到 output/assets/questions/chemistry/
        asset_root = out / "assets" / "questions" / "chemistry"
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

    def test_book_filter_scopes_publish(self, tmp_path):
        """--book：只发布匹配的书（rel_path 子串匹配，重发布不波及其他书）。"""
        out = tmp_path / "out"
        b1 = out / "extracted" / "数学/初中/人教版/九年级/上册/书A"
        b2 = out / "extracted" / "数学/初中/人教版/九年级/上册/书B"
        b1.mkdir(parents=True)
        b2.mkdir(parents=True)
        card = {"lesson_id": "26.1 X", "sort_order": 1, "card_type": "concept",
                "title": None, "content": "c", "content_metadata": None,
                "knowledge_point_ids": [], "textbook_page": "P1"}
        for b in (b1, b2):
            (b / "page_001.jsonl").write_text(
                json.dumps(card, ensure_ascii=False) + "\n", encoding="utf-8")

        with patch("publish_cli.RefineryConfig") as mock_config:
            mock_config.from_env.return_value = MagicMock(output_dir=out)
            main(["--input-dir", str(out / "extracted"), "--book", "书A"])

        assert (out / "published/数学/初中/人教版/九年级/上册/书A/page_001.jsonl").exists()
        assert not (out / "published/数学/初中/人教版/九年级/上册/书B/page_001.jsonl").exists()
