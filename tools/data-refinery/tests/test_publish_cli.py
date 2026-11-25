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
    def test_file_exact_does_not_match_keyword_superset(self, tmp_path, capsys):
        """精确发布短卷时，不能同时发布包含短卷全部关键词的三帆卷。"""
        out = tmp_path / "out"
        root = out / "extracted" / "英语" / "初中" / "first" / "2026"
        short = root / "英语-初三(上)-202607-西城-期末-试卷"
        superset = root / "英语-初三(上)-202607-西城·三帆中学-期末-试卷"
        short.mkdir(parents=True)
        superset.mkdir(parents=True)
        item = json.dumps({
            "subject_id": "english", "type": "short_answer", "difficulty": 1,
            "content": "q", "answer": "A",
        }, ensure_ascii=False)
        (short / f"{short.name}.jsonl").write_text(item + "\n", encoding="utf-8")
        (superset / f"{superset.name}.jsonl").write_text(item + "\n", encoding="utf-8")

        rel = short.relative_to(out / "extracted").as_posix()
        with patch("publish_cli.RefineryConfig") as mock_config:
            mock_config.from_env.return_value = MagicMock(output_dir=out)
            main([
                "--input-dir", str(out / "extracted"),
                "--output-dir", str(out / "published"),
                "--file-exact", rel,
                "--dry-run",
            ])

        stdout = capsys.readouterr().out
        assert f"{short.name}.jsonl" in stdout
        assert f"{superset.name}.jsonl" not in stdout

    def test_legacy_checkpoint_without_version_is_republished(self, tmp_path, capsys):
        """旧版 checkpoint 没有口径版本 → 自动重发，用户不用记 --force。"""
        out = _setup(tmp_path)
        (out / ".publish_checkpoint.json").write_text(
            json.dumps({"published": ["数学/试卷/试卷"], "publish_versions": {}},
                       ensure_ascii=False),
            encoding="utf-8",
        )
        with patch("publish_cli.RefineryConfig") as mock_config:
            mock_config.from_env.return_value = MagicMock(output_dir=out)
            main(["--input-dir", str(out / "extracted"), "--output-dir", str(out / "published")])

        assert "Published: 1" in capsys.readouterr().out

    def test_changed_extracted_is_republished(self, tmp_path, capsys):
        """版本没变但 extracted 改了（重抽/补题回写）也必须重发，否则题目/题型停在旧状态。"""
        out = _setup(tmp_path)
        with patch("publish_cli.RefineryConfig") as mock_config:
            mock_config.from_env.return_value = MagicMock(output_dir=out)
            main(["--input-dir", str(out / "extracted"), "--output-dir", str(out / "published")])
        capsys.readouterr()

        ext = out / "extracted" / "数学" / "试卷" / "试卷.jsonl"
        item = json.loads(ext.read_text(encoding="utf-8").strip())
        item["type"] = "choice"
        item["options"] = [{"label": "A", "text": "甲"}, {"label": "B", "text": "乙"},
                           {"label": "C", "text": "丙"}, {"label": "D", "text": "丁"}]
        ext.write_text(json.dumps(item, ensure_ascii=False) + "\n", encoding="utf-8")

        with patch("publish_cli.RefineryConfig") as mock_config:
            mock_config.from_env.return_value = MagicMock(output_dir=out)
            main(["--input-dir", str(out / "extracted"), "--output-dir", str(out / "published")])

        assert "Published: 1" in capsys.readouterr().out
        published = json.loads(
            (out / "published" / "数学" / "试卷" / "试卷.jsonl").read_text(encoding="utf-8").strip())
        assert published["type"] == "choice"
        assert published["options"][0]["text"] == "甲"

    def test_current_version_checkpoint_is_skipped(self, tmp_path, capsys):
        out = _setup(tmp_path)
        with patch("publish_cli.RefineryConfig") as mock_config:
            mock_config.from_env.return_value = MagicMock(output_dir=out)
            main(["--input-dir", str(out / "extracted"), "--output-dir", str(out / "published")])
        capsys.readouterr()

        with patch("publish_cli.RefineryConfig") as mock_config:
            mock_config.from_env.return_value = MagicMock(output_dir=out)
            main(["--input-dir", str(out / "extracted"), "--output-dir", str(out / "published")])

        assert "Skipped: 1" in capsys.readouterr().out

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

    def test_book_filter_splits_keywords(self, tmp_path):
        """--book 也走分词：'九年级 上册 书A' 命中，'九年级 下册 书A' 不命中。"""
        out = tmp_path / "out"
        b1 = out / "extracted" / "数学/初中/人教版/九年级/上册/书A"
        b1.mkdir(parents=True)
        card = {"lesson_id": "26.1 X", "sort_order": 1, "card_type": "concept",
                "title": None, "content": "c", "content_metadata": None,
                "knowledge_point_ids": [], "textbook_page": "P1"}
        (b1 / "page_001.jsonl").write_text(
            json.dumps(card, ensure_ascii=False) + "\n", encoding="utf-8")

        with patch("publish_cli.RefineryConfig") as mock_config:
            mock_config.from_env.return_value = MagicMock(output_dir=out)
            main(["--input-dir", str(out / "extracted"), "--book", "九年级 下册"])

        assert not (out / "published/数学/初中/人教版/九年级/上册/书A/page_001.jsonl").exists()

        with patch("publish_cli.RefineryConfig") as mock_config:
            mock_config.from_env.return_value = MagicMock(output_dir=out)
            main(["--input-dir", str(out / "extracted"), "--book", "上册 书A"])

        assert (out / "published/数学/初中/人教版/九年级/上册/书A/page_001.jsonl").exists()

    def test_dry_run_applies_book_filter(self, tmp_path, capsys):
        """回归：--dry-run 必须与正式发布同口径应用 --book（曾忽略，预演范围偏大）。"""
        out = tmp_path / "out"
        for name in ("语文/初中/second/2025/语文-海淀-模拟二-试卷",
                     "数学/初中/second/2025/数学-海淀-模拟二-试卷"):
            d = out / "extracted" / name
            d.mkdir(parents=True)
            q = {"subject_id": "math", "type": "choice", "difficulty": 1,
                 "content": "题干", "options": [], "answer": "A"}
            (d / f"{Path(name).name}.jsonl").write_text(
                json.dumps(q, ensure_ascii=False) + "\n", encoding="utf-8")

        with patch("publish_cli.RefineryConfig") as mock_config:
            mock_config.from_env.return_value = MagicMock(output_dir=out)
            main(["--input-dir", str(out / "extracted"), "--dry-run", "--book", "语文/"])

        captured = capsys.readouterr()
        assert "语文/初中/second/2025/语文-海淀-模拟二-试卷" in captured.out
        assert "数学/初中/second/2025" not in captured.out


class TestPublishPageMarkers:
    def test_published_jsonl_has_no_page_footer(self, tmp_path, capsys):
        """published 是 db_loader 的唯一输入：页脚必须在这一步就清掉。"""
        out = _setup(tmp_path)
        ext = out / "extracted" / "数学" / "试卷" / "试卷.jsonl"
        item = json.loads(ext.read_text(encoding="utf-8").strip())
        item["content"] = item["content"] + "\n\n第5页（共8页）"
        item["answer"] = "1\n\n数学试卷答案及评分参考 第2页（共6页）"
        ext.write_text(json.dumps(item, ensure_ascii=False) + "\n", encoding="utf-8")

        with patch("publish_cli.RefineryConfig") as mock_config:
            mock_config.from_env.return_value = MagicMock(output_dir=out)
            main(["--input-dir", str(out / "extracted"),
                  "--output-dir", str(out / "published")])

        printed = capsys.readouterr().out
        assert "[page-marker]" in printed

        pub = out / "published" / "数学" / "试卷" / "试卷.jsonl"
        got = json.loads(pub.read_text(encoding="utf-8").strip())
        assert "第5页" not in got["content"]
        assert "第2页" not in got["answer"]
        assert "评分参考" not in got["answer"]

    def test_published_body_reference_kept(self, tmp_path):
        """正文里的「第 N 页」引用不能当页脚删。"""
        out = _setup(tmp_path)
        ext = out / "extracted" / "数学" / "试卷" / "试卷.jsonl"
        item = json.loads(ext.read_text(encoding="utf-8").strip())
        item["content"] = item["content"] + " 请阅读第 2 页的问题 1"
        ext.write_text(json.dumps(item, ensure_ascii=False) + "\n", encoding="utf-8")

        with patch("publish_cli.RefineryConfig") as mock_config:
            mock_config.from_env.return_value = MagicMock(output_dir=out)
            main(["--input-dir", str(out / "extracted"),
                  "--output-dir", str(out / "published")])

        pub = out / "published" / "数学" / "试卷" / "试卷.jsonl"
        got = json.loads(pub.read_text(encoding="utf-8").strip())
        assert "请阅读第 2 页的问题 1" in got["content"]


def test_chinese_publish_writes_material_doc_and_clears_text(tmp_path):
    out = tmp_path / "out"
    ext = out / "extracted" / "语文" / "试卷"
    ext.mkdir(parents=True)
    article = "## 醉翁亭记\n\n环滁皆山也。其西南诸峰，林壑尤美。"
    rows = [
        {"subject_id": "chinese", "type": "choice", "difficulty": 2,
         "content": "下列加点字意思都相同的一项是", "answer": "A", "material_text": article},
        {"subject_id": "chinese", "type": "choice", "difficulty": 2,
         "content": "下列翻译正确的是", "answer": "B", "material_text": article},
    ]
    (ext / "试卷.jsonl").write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n",
        encoding="utf-8",
    )
    (out / "md" / "语文" / "试卷").mkdir(parents=True)

    with patch("publish_cli.RefineryConfig") as mock_config:
        mock_config.from_env.return_value = MagicMock(output_dir=out)
        main(["--input-dir", str(out / "extracted"), "--output-dir", str(out / "published")])

    published = [
        json.loads(l) for l in
        (out / "published" / "语文" / "试卷" / "试卷.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    assert published[0]["material_url"] == published[1]["material_url"]
    assert published[0]["material_url"].startswith("materials/chinese/")
    assert published[0]["material_text"] is None
    assert published[1]["material_text"] is None
    md = out / "assets" / published[0]["material_url"]
    assert md.exists()
    assert "## 醉翁亭记" in md.read_text(encoding="utf-8")


def test_chinese_publish_keeps_non_article_material(tmp_path):
    """材料其实是选项块 → 不外置、不改 material_text，并落 skip 清单。"""
    out = tmp_path / "out"
    ext = out / "extracted" / "语文" / "试卷"
    ext.mkdir(parents=True)
    material = "A. 甲\nB. 乙\nC. 丙\nD. 丁"
    rows = [
        {"subject_id": "chinese", "type": "choice", "difficulty": 2,
         "content": "下列加点字意思都相同的一项是", "answer": "A",
         "material_text": material},
    ]
    (ext / "试卷.jsonl").write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n",
        encoding="utf-8",
    )
    (out / "md" / "语文" / "试卷").mkdir(parents=True)

    with patch("publish_cli.RefineryConfig") as mock_config:
        mock_config.from_env.return_value = MagicMock(output_dir=out)
        main(["--input-dir", str(out / "extracted"), "--output-dir", str(out / "published")])

    got = json.loads(
        (out / "published" / "语文" / "试卷" / "试卷.jsonl").read_text(encoding="utf-8").strip()
    )
    assert got["material_url"] is None
    assert got["material_text"] == material
    report = out / "material_group_skipped.jsonl"
    assert report.exists()
    assert "option_block" in report.read_text(encoding="utf-8")


def test_chinese_publish_keeps_article_url_and_adds_inline_post_material(tmp_path):
    """题后找回的材料写进 material_text，不能顶掉共享文章的 material_url。"""
    out = tmp_path / "out"
    ext = out / "extracted" / "语文" / "试卷"
    ext.mkdir(parents=True)
    article = "## 游山西村\n\n陆游\n莫笑农家腊酒浑。"
    inline = "## 行香子\n\n秦观\n树绕村庄，水满陂塘。\n注：①陂塘，池塘。"
    rows = [
        {"subject_id": "chinese", "type": "short_answer", "difficulty": 3,
         "content": "填写恰当的内容", "answer": "丰", "material_text": article},
        {"subject_id": "chinese", "type": "short_answer", "difficulty": 4,
         "content": "结合本诗画线句与《行香子》下片相关句子作答", "answer": "示例", "material_text": article,
         "_post_material_text": inline},
    ]
    (ext / "试卷.jsonl").write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n",
        encoding="utf-8",
    )
    (out / "md" / "语文" / "试卷").mkdir(parents=True)

    with patch("publish_cli.RefineryConfig") as mock_config:
        mock_config.from_env.return_value = MagicMock(output_dir=out)
        main(["--input-dir", str(out / "extracted"), "--output-dir", str(out / "published")])

    got = [
        json.loads(l) for l in
        (out / "published" / "语文" / "试卷" / "试卷.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    assert got[0]["material_url"] == got[1]["material_url"]
    assert got[0]["material_url"].startswith("materials/chinese/")
    assert got[0]["material_text"] is None          # Q11 不受影响
    assert got[1]["material_text"] == inline         # Q12 题内素材
    assert "_post_material_text" not in got[1]
    md = out / "assets" / got[1]["material_url"]
    assert "游山西村" in md.read_text(encoding="utf-8")
    assert "行香子" not in md.read_text(encoding="utf-8")


def test_publish_manual_inline_fix_wins_and_survives_extract(tmp_path):
    """人工 inline 修正从 manual_fixes 读，优先于 _post_material_text，且文章 URL 不变。"""
    out = tmp_path / "out"
    ext = out / "extracted" / "语文" / "试卷"
    ext.mkdir(parents=True)
    article = "## 游山西村\n\n陆游\n莫笑农家腊酒浑。"
    rows = [
        {"subject_id": "chinese", "type": "short_answer", "difficulty": 3,
         "content": "填写内容", "answer": "丰", "material_text": article,
         "source": "试卷", "group_order": 1},
        {"subject_id": "chinese", "type": "short_answer", "difficulty": 4,
         "content": "结合两句作答", "answer": "示例", "material_text": article,
         "source": "试卷", "group_order": 2,
         "_post_material_text": "## 自动找回的诗\n自动内容"},
    ]
    (ext / "试卷.jsonl").write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n",
        encoding="utf-8",
    )
    fixes = out / "manual_fixes"
    fixes.mkdir()
    (fixes / "试卷.jsonl").write_text(json.dumps({
        "source": "试卷", "group_order": 2, "applied": True,
        "material_scope": "inline", "material_text": "## 行香子\n人工修正后的题内素材",
    }, ensure_ascii=False) + "\n", encoding="utf-8")
    (out / "md" / "语文" / "试卷").mkdir(parents=True)

    with patch("publish_cli.RefineryConfig") as mock_config:
        mock_config.from_env.return_value = MagicMock(output_dir=out)
        main(["--input-dir", str(out / "extracted"), "--output-dir", str(out / "published")])

    got = [
        json.loads(l) for l in
        (out / "published" / "语文" / "试卷" / "试卷.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    assert got[0]["material_url"] == got[1]["material_url"]
    assert got[0]["material_text"] is None
    assert got[1]["material_text"] == "## 行香子\n人工修正后的题内素材"
    doc = (out / "assets" / got[1]["material_url"]).read_text(encoding="utf-8")
    assert "游山西村" in doc and "行香子" not in doc


def test_publish_uses_manual_article_override(tmp_path):
    """共享文章修正写 override 后，publish 用修正正文写文档，不被 extracted 旧正文冲掉。"""
    from chinese_material_doc import write_material_doc
    from asset_store import LocalAssetStore

    out = tmp_path / "out"
    ext = out / "extracted" / "语文" / "试卷"
    ext.mkdir(parents=True)
    old_article = "## 游山西村\n\n陆游\n莫笑农家腊酒浑。旧版。"
    (ext / "试卷.jsonl").write_text(json.dumps({
        "subject_id": "chinese", "type": "short_answer", "difficulty": 3,
        "content": "作答", "answer": "略", "material_text": old_article,
        "source": "试卷", "group_order": 1,
    }, ensure_ascii=False) + "\n", encoding="utf-8")
    (out / "md" / "语文" / "试卷").mkdir(parents=True)
    store = LocalAssetStore(out / "assets")
    old_key, _ = write_material_doc(old_article, resolver=lambda ref: None,
                                    store=store, assets_dir=out / "assets",
                                    subject_code="chinese", dry_run=True)
    corrected = "## 游山西村\n\n陆游\n莫笑农家腊酒浑。人工修正版。"
    (out / "material_doc_overrides.jsonl").write_text(json.dumps({
        "old_key": old_key, "new_key": old_key, "body": corrected,
        "provenance_source": "试卷",
    }, ensure_ascii=False) + "\n", encoding="utf-8")

    with patch("publish_cli.RefineryConfig") as mock_config:
        mock_config.from_env.return_value = MagicMock(output_dir=out)
        main(["--input-dir", str(out / "extracted"), "--output-dir", str(out / "published")])

    got = json.loads(
        (out / "published" / "语文" / "试卷" / "试卷.jsonl").read_text(encoding="utf-8").strip())
    doc = (out / "assets" / got["material_url"]).read_text(encoding="utf-8")
    assert "人工修正版" in doc and "旧版" not in doc


def test_article_override_matches_by_old_key_across_papers(tmp_path):
    """override 只按 old_key 命中：跨卷共用同一篇文章的题也要拿到修正正文。"""
    from chinese_material_doc import write_material_doc
    from asset_store import LocalAssetStore

    out = tmp_path / "out"
    article = "## 游山西村\n\n陆游\n莫笑农家腊酒浑。旧版。"
    for name in ("试卷A", "试卷B"):
        ext = out / "extracted" / "语文" / name
        ext.mkdir(parents=True)
        (ext / f"{name}.jsonl").write_text(json.dumps({
            "subject_id": "chinese", "type": "short_answer", "difficulty": 3,
            "content": "作答", "answer": "略", "material_text": article,
            "source": name, "group_order": 1,
        }, ensure_ascii=False) + "\n", encoding="utf-8")
        (out / "md" / "语文" / name).mkdir(parents=True)
    store = LocalAssetStore(out / "assets")
    old_key, _ = write_material_doc(article, resolver=lambda ref: None,
                                    store=store, assets_dir=out / "assets",
                                    subject_code="chinese", dry_run=True)
    corrected = "## 游山西村\n\n陆游\n莫笑农家腊酒浑。修正版。"
    (out / "material_doc_overrides.jsonl").write_text(json.dumps({
        "old_key": old_key, "new_key": old_key, "body": corrected,
        "provenance_source": "试卷A",
    }, ensure_ascii=False) + "\n", encoding="utf-8")

    with patch("publish_cli.RefineryConfig") as mock_config:
        mock_config.from_env.return_value = MagicMock(output_dir=out)
        main(["--input-dir", str(out / "extracted"), "--output-dir", str(out / "published")])

    for name in ("试卷A", "试卷B"):
        got = json.loads(
            (out / "published" / "语文" / name / f"{name}.jsonl").read_text(encoding="utf-8").strip())
        doc = (out / "assets" / got["material_url"]).read_text(encoding="utf-8")
        assert "修正版" in doc and "旧版" not in doc, name


def test_externalize_paper_scope_splits_same_article(tmp_path):
    """同一篇文章在两套卷 → 各自的 content.md，互不共用。"""
    from models import ExamQuestion
    from chinese_material_doc import externalize_chinese_materials
    from asset_store import LocalAssetStore

    md = tmp_path / "md"
    md.mkdir()
    assets = tmp_path / "assets"
    store = LocalAssetStore(assets)
    body = "## 同一篇文章\n完全相同的正文内容，用于验证卷内隔离。"
    a = ExamQuestion(subject_id="chinese", type="short_answer", difficulty=2,
                     content="题干", answer="", material_text=body, source="卷A")
    b = ExamQuestion(subject_id="chinese", type="short_answer", difficulty=2,
                     content="题干", answer="", material_text=body, source="卷B")
    externalize_chinese_materials([a], md_images_dir=md, assets_dir=assets,
                                  store=store, paper_scope="语文/卷A")
    externalize_chinese_materials([b], md_images_dir=md, assets_dir=assets,
                                  store=store, paper_scope="语文/卷B")
    assert a.material_url and b.material_url
    assert a.material_url != b.material_url
    assert a.material_text is None and b.material_text is None


def test_manual_inline_materials_only_inline_targets(tmp_path):
    """publish 只回注 inline/both.inline；article 目标绝不写进 material_text。"""
    from publish_cli import _manual_inline_materials

    fixes = tmp_path / "manual_fixes"
    fixes.mkdir()
    recs = [
        {"source": "卷A", "rel_path": "语文/卷A", "group_order": 1, "applied": True,
         "material_target": "article", "material_text": "## 文章\n正文"},
        {"source": "卷A", "rel_path": "语文/卷A", "group_order": 2, "applied": True,
         "material_target": "inline", "material_text": "素材二"},
        {"source": "卷A", "rel_path": "语文/卷A", "group_order": 3, "applied": True,
         "material_target": "both", "material_text": "文章三", "material_inline_text": "素材三"},
    ]
    (fixes / "卷A.jsonl").write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in recs) + "\n", encoding="utf-8")
    out = _manual_inline_materials(tmp_path, {"卷A"}, rel_path="语文/卷A")
    assert 1 not in out.get("卷A", {}), "article 目标不能进 material_text"
    assert out["卷A"][2] == "素材二"
    assert out["卷A"][3] == "素材三"


def test_publish_drops_article_duplicate_when_question_has_no_url(tmp_path):
    """本题 URL 为空、但同卷另一题已把同一篇文章外置：_post 素材要判重丢弃，
    不能再把整篇文章当题内素材注回 material_text（2026-11-22 Q21 事故）。"""
    out = tmp_path / "out"
    ext = out / "extracted" / "语文" / "试卷"
    ext.mkdir(parents=True)
    article = "## 只此眉山\n" + "这是一篇文章的正文。" * 20
    rows = [
        {"subject_id": "chinese", "type": "short_answer", "difficulty": 2,
         "content": "第一题", "answer": "甲", "material_text": article},
        {"subject_id": "chinese", "type": "short_answer", "difficulty": 2,
         "content": "第二题", "answer": "乙", "material_text": None,
         "_post_material_text": article},
    ]
    (ext / "试卷.jsonl").write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n",
        encoding="utf-8",
    )
    (out / "md" / "语文" / "试卷").mkdir(parents=True)

    with patch("publish_cli.RefineryConfig") as mock_config:
        mock_config.from_env.return_value = MagicMock(output_dir=out)
        main(["--input-dir", str(out / "extracted"), "--output-dir", str(out / "published")])

    got = [
        json.loads(l) for l in
        (out / "published" / "语文" / "试卷" / "试卷.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    assert got[0]["material_url"].startswith("materials/chinese/")
    assert got[1]["material_url"] is None
    assert got[1]["material_text"] is None, "与文章同段的 _post 素材必须被丢弃"
    assert "duplicate_of_doc" in (out / "material_duplicate_healed.jsonl").read_text(encoding="utf-8")
