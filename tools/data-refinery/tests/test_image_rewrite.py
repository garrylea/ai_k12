from pathlib import Path

from asset_store import LocalAssetStore
from image_rewrite import rewrite_card, rewrite_item, rewrite_question
from models import ExamQuestion, TextbookCard


def _make_image(md_images_dir: Path, name: str) -> Path:
    images_dir = md_images_dir / "images"
    images_dir.mkdir(parents=True, exist_ok=True)
    f = images_dir / name
    f.write_bytes(b"\xff\xd8\xff" + name.encode())
    return f


class TestRewriteQuestion:
    def test_stem_image_materialized_and_rewritten(self, tmp_path):
        md_dir = tmp_path / "md" / "book"
        _make_image(md_dir, "fig1.jpg")
        store = LocalAssetStore(tmp_path / "assets")
        q = ExamQuestion(
            subject_id="math", type="short_answer", difficulty=1,
            content="如图 ![](images/fig1.jpg) 求面积", answer="1",
        )

        rewrite_question(q, md_dir, store, "questions/math/1024")

        assert "questions/math/1024/stem_01.jpg" in q.content
        assert "images/fig1.jpg" not in q.content
        assert store.exists("questions/math/1024/stem_01.jpg")

    def test_option_image_sets_image_url(self, tmp_path):
        md_dir = tmp_path / "md" / "book"
        _make_image(md_dir, "oa.jpg")
        store = LocalAssetStore(tmp_path / "assets")
        q = ExamQuestion(
            subject_id="math", type="choice", difficulty=1,
            content="题干", answer="A",
            options=[
                {"label": "A", "text": "![](images/oa.jpg)"},
                {"label": "B", "text": "文字"},
            ],
        )

        rewrite_question(q, md_dir, store, "questions/math/1024")

        assert q.options[0]["image_url"] == "questions/math/1024/opt_a.jpg"
        assert "questions/math/1024/opt_a.jpg" in q.options[0]["text"]
        assert "image_url" not in q.options[1]

    def test_explanation_image(self, tmp_path):
        md_dir = tmp_path / "md" / "book"
        _make_image(md_dir, "ex.jpg")
        store = LocalAssetStore(tmp_path / "assets")
        q = ExamQuestion(
            subject_id="math", type="short_answer", difficulty=1,
            content="题干", answer="1", explanation="见 ![](images/ex.jpg)",
        )

        rewrite_question(q, md_dir, store, "questions/math/1024")

        assert "questions/math/1024/explain_01.jpg" in q.explanation

    def test_no_images_unchanged(self, tmp_path):
        store = LocalAssetStore(tmp_path / "assets")
        q = ExamQuestion(
            subject_id="math", type="short_answer", difficulty=1,
            content="纯文字题干", answer="1",
        )

        _, materialized = rewrite_question(q, tmp_path, store, "questions/math/1024")

        assert materialized == []
        assert q.content == "纯文字题干"

    def test_missing_source_image_preserved(self, tmp_path):
        store = LocalAssetStore(tmp_path / "assets")
        q = ExamQuestion(
            subject_id="math", type="short_answer", difficulty=1,
            content="见 ![](images/missing.jpg)", answer="1",
        )

        rewrite_question(q, tmp_path, store, "questions/math/1024")

        # 源文件不存在，原引用保留，不物化
        assert "![](images/missing.jpg)" in q.content
        assert not store.exists("questions/math/1024/stem_01.jpg")


class TestRewriteCard:
    def test_card_image_populates_metadata_with_page(self, tmp_path):
        md_dir = tmp_path / "md" / "book"
        _make_image(md_dir, "cf.jpg")
        store = LocalAssetStore(tmp_path / "assets")
        c = TextbookCard(
            sort_order=1, card_type="concept",
            content="![](images/cf.jpg) 概念说明", textbook_page="P12",
        )

        rewrite_card(c, md_dir, store, "textbooks/math/55")

        assert "textbooks/math/55/page_12_fig_01.jpg" in c.content
        assert c.content_metadata is not None
        assert c.content_metadata["images"][0]["url"] == "textbooks/math/55/page_12_fig_01.jpg"
        assert store.exists("textbooks/math/55/page_12_fig_01.jpg")

    def test_card_no_image_no_metadata(self, tmp_path):
        store = LocalAssetStore(tmp_path / "assets")
        c = TextbookCard(sort_order=1, card_type="concept", content="纯文字卡片")

        rewrite_card(c, tmp_path, store, "textbooks/math/55")

        assert c.content_metadata is None
        assert c.content == "纯文字卡片"


class TestRewriteItemDispatch:
    def test_dispatch_questions(self, tmp_path):
        md_dir = tmp_path / "md" / "book"
        _make_image(md_dir, "fig1.jpg")
        store = LocalAssetStore(tmp_path / "assets")
        q = ExamQuestion(
            subject_id="math", type="short_answer", difficulty=1,
            content="![](images/fig1.jpg)", answer="1",
        )

        rewrite_item(q, "questions", md_dir, store, "questions/math/1024")

        assert "questions/math/1024/stem_01.jpg" in q.content

    def test_dispatch_cards(self, tmp_path):
        md_dir = tmp_path / "md" / "book"
        _make_image(md_dir, "cf.jpg")
        store = LocalAssetStore(tmp_path / "assets")
        c = TextbookCard(sort_order=1, card_type="concept", content="![](images/cf.jpg)")

        rewrite_item(c, "cards", md_dir, store, "textbooks/math/55")

        assert "textbooks/math/55/page_01_fig_01.jpg" in c.content
