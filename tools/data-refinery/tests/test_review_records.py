"""review_records：三态草稿 → 补题记录（材料槽 / 图片模式 / 答案清空）。"""

import json
from pathlib import Path

import review_content
import review_records as rr
from review_content import Snapshot
from review_queue import ReviewItem


HERE = Path(__file__).resolve().parent
REAL_76707_DIR = HERE / "fixtures" / "real_cases" / "76707"
REAL_76707_SOURCE = "数学-初三(上)-202407-北京各-（上）期中-试卷-76707"
REAL_76707_REL = (
    "数学/初中/first/2024/"
    "数学-初三(上)-202407-北京各-（上）期中-试卷-76707"
)
REAL_76707_Q2_STEM = "下列图案是我国国产品牌汽车的标识，其中是中心对称图形的是"
REAL_76707_Q2_IMAGES = [
    "images/6c38dff6997c623f425af5a376af96ef90c46ebfe3d53746d79ff29c6be21217.jpg",
    "images/8bf675b6810221e2edf9ea9f847d7da0b9a5b1043583448cd0c4ca6e36bfd4af.jpg",
    "images/833baef6260c8d575b0742cf102ebdf99257a335da40fcd97a3688746be4855f.jpg",
    "images/8671b109d5ac83d34254dd8b49f7c21709a51317855809863c8136a8ee40f5e5.jpg",
]
REAL_76707_Q2_OLD_CONTENT = (
    f"{REAL_76707_Q2_STEM}\n\n"
    + "\n".join(f"![]({ref})" for ref in REAL_76707_Q2_IMAGES)
)


ITEM = ReviewItem(
    source="卷A",
    rel_path="物理/初中/2026/卷A",
    group_order=19,
    sub_no=0,
    flags=[{"kind": "incomplete_content", "reasons": [], "md": "m", "pdf": None}],
)


def test_two_material_slots_merge():
    snap = Snapshot(content="题干", article="旧文章", inline="旧素材")
    draft = rr.ReviewDraft(snap)
    draft.set_article("新文章")
    draft.set_inline("新素材")
    rec = rr.build_record(ITEM, 19, 0, draft.patch, snap)
    assert rec["material_target"] == "both"
    assert rec["material_text"] == "新文章"
    assert rec["material_inline_text"] == "新素材"


def test_clear_inline_with_article():
    snap = Snapshot(content="题干", article="文章", inline="旧素材")
    draft = rr.ReviewDraft(snap)
    draft.clear_inline()
    rec = rr.build_record(ITEM, 19, 0, draft.patch, snap)
    assert rec["material_target"] == "both"
    assert rec["material_text"] == "文章"
    assert rec["material_inline_text"] == ""


def test_clear_images_strips_all_record_fields():
    snap = Snapshot(
        content="题干 ![](images/a.jpg)",
        options=[{"label": "A", "text": "![](images/b.jpg)"}],
        inline="素材 ![](images/c.jpg)",
        images=["images/a.jpg", "images/b.jpg", "images/c.jpg"],
    )
    draft = rr.ReviewDraft(snap)
    draft.set_images([], "clear")
    rec = rr.build_record(ITEM, 19, 0, draft.patch, snap)
    assert "images/" not in rec["content"]
    assert "images/" not in rec["options"][0]["text"]
    for key in ("material_text", "material_inline_text"):
        if key in rec:
            assert "images/" not in rec[key]


def test_replace_images_uses_final_draft_sequence():
    snap = Snapshot(content="题干 ![](images/old.jpg)", images=["images/old.jpg"])
    draft = rr.ReviewDraft(snap)
    draft.set_images(["images/new.jpg"], "replace")
    rec = rr.build_record(ITEM, 19, 0, draft.patch, snap)
    assert "images/old.jpg" not in rec["content"]
    assert "images/new.jpg" in rec["content"]


def test_keep_mode_restores_stem_images_only():
    """keep 只补回快照里属于题干的图；选项图在 snapshot 阶段已被剔除。"""
    snap = Snapshot(
        content="旧题干 ![](images/stem.jpg)",
        options=[],
        images=["images/stem.jpg"],
    )
    draft = rr.ReviewDraft(snap)
    draft.set_content("新题干", None)
    rec = rr.build_record(ITEM, 19, 0, draft.patch, snap)
    assert "images/stem.jpg" in rec["content"]


def test_real_76707_q2_keep_does_not_restore_images_added_as_options(
        tmp_path, monkeypatch):
    """编辑前没有选项，编辑中把四张原图补成选项后，keep 不得再塞回题干。"""
    extracted = (
        tmp_path / "output" / "extracted" / REAL_76707_REL
        / f"{REAL_76707_SOURCE}.jsonl"
    )
    extracted.parent.mkdir(parents=True)
    extracted.write_text(
        (REAL_76707_DIR / "extracted_before_review.jsonl").read_text(
            encoding="utf-8"
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(review_content, "ROOT", tmp_path)

    issue = {
        "source": REAL_76707_SOURCE,
        "rel_path": REAL_76707_REL,
        "group_order": 2,
        "sub_no": 0,
    }
    snap = review_content.snapshot(issue)
    assert snap.options == []
    assert snap.images == REAL_76707_Q2_IMAGES

    options = [
        {"label": label, "text": f"![]({ref})"}
        for label, ref in zip("ABCD", REAL_76707_Q2_IMAGES)
    ]
    draft = rr.ReviewDraft(snap)
    draft.set_content(REAL_76707_Q2_STEM, options)
    item = ReviewItem(
        source=REAL_76707_SOURCE,
        rel_path=REAL_76707_REL,
        group_order=2,
        sub_no=0,
        flags=[{"kind": "incomplete_content", "reasons": ["options_0of4"]}],
    )
    rec = rr.build_record(item, 2, 0, draft.patch, snap)

    assert rec["content"] == REAL_76707_Q2_STEM
    assert [opt["text"] for opt in rec["options"]] == [
        f"![]({ref})" for ref in REAL_76707_Q2_IMAGES
    ]
    assert not any(ref in rec["content"] for ref in REAL_76707_Q2_IMAGES)


def test_real_76707_q2_keep_removes_option_images_still_in_stem_text():
    """即使编辑后的题干文本还带着旧图，已归入选项的同组图也必须从题干移除。"""
    snap = Snapshot(
        content=REAL_76707_Q2_OLD_CONTENT,
        options=[],
        images=REAL_76707_Q2_IMAGES,
    )
    options = [
        {"label": label, "text": f"![]({ref})"}
        for label, ref in zip("ABCD", REAL_76707_Q2_IMAGES)
    ]
    draft = rr.ReviewDraft(snap)
    draft.set_content(REAL_76707_Q2_OLD_CONTENT, options)
    item = ReviewItem(
        source=REAL_76707_SOURCE,
        rel_path=REAL_76707_REL,
        group_order=2,
        sub_no=0,
        flags=[{"kind": "incomplete_content", "reasons": ["options_0of4"]}],
    )
    rec = rr.build_record(item, 2, 0, draft.patch, snap)

    assert rec["content"] == REAL_76707_Q2_STEM
    assert [opt["text"] for opt in rec["options"]] == [
        f"![]({ref})" for ref in REAL_76707_Q2_IMAGES
    ]


def test_clear_answer_uses_explicit_record_field():
    snap = Snapshot(content="题干", answer="旧答案")
    draft = rr.ReviewDraft(snap)
    draft.clear_answer()
    rec = rr.build_record(ITEM, 19, 0, draft.patch, snap)
    assert rec["answer"] == ""
    assert rec["clear_answer"] is True


def test_untouched_material_chinese_omits_material_keys():
    """语文只改题干：不要带 material_* 键，apply 自己会保留 existing_text。"""
    item = ReviewItem(source="卷A", rel_path="语文/初中/2026/卷A", group_order=19)
    snap = Snapshot(content="题干", article="文章", inline="素材")
    rec = rr.build_record(item, 19, 0, rr.Patch(content="新题干"), snap)
    assert "material_target" not in rec
    assert "material_text" not in rec


def test_untouched_material_physics_carries_inline():
    """非语文必须带原 material_text，否则 apply 的 rec.get() 会把它写成 NULL。"""
    snap = Snapshot(content="题干", inline="题前阅读")
    rec = rr.build_record(ITEM, 19, 0, rr.Patch(content="新题干"), snap)
    assert rec["material_target"] == "inline"
    assert rec["material_text"] == "题前阅读"


def test_clear_images_keeps_shared_article_body():
    """清本题图不能删共享文章正文里的图。"""
    item = ReviewItem(source="卷A", rel_path="语文/初中/2026/卷A", group_order=19)
    snap = Snapshot(content="题干", article="旧文章", inline="素材")
    draft = rr.ReviewDraft(snap)
    draft.set_article("文章 ![](images/doc.jpg)")
    draft.set_images([], "clear")
    rec = rr.build_record(item, 19, 0, draft.patch, snap)
    assert rec["material_target"] == "both"
    assert "images/doc.jpg" in rec["material_text"]
    assert "images/" not in rec["content"]


def test_save_records_matches_sub_no(tmp_path):
    src = "卷A"
    p = tmp_path / f"{src}.jsonl"
    p.write_text(
        '{"source":"卷A","group_order":26,"sub_no":1,"content":"旧1"}\n'
        '{"source":"卷A","group_order":26,"sub_no":2,"content":"旧2"}\n',
        encoding="utf-8",
    )
    out = rr._save_records(
        src,
        [{"source": src, "group_order": 26, "sub_no": 2, "content": "新2"}],
        tmp_path,
    )
    rows = [json.loads(line) for line in out.read_text(encoding="utf-8").splitlines()]
    assert [(r["sub_no"], r["content"]) for r in rows] == [(1, "旧1"), (2, "新2")]


def test_content_only_then_clear_answer_keeps_both():
    """`u` 后再按 `:c`：既用修复前原文，也把清答案带出去（顺序反过来同理）。"""
    snap = Snapshot(content="短了", answer="旧答案")
    for order in ("u_then_clear", "clear_then_u"):
        draft = rr.ReviewDraft(snap)
        if order == "u_then_clear":
            draft.use_restore_original("完整原文")
            draft.clear_answer()
        else:
            draft.clear_answer()
            draft.use_restore_original("完整原文")
        rec = rr.build_record(ITEM, 19, 0, draft.patch, snap)
        assert rec["content"] == "完整原文", order
        assert rec["answer"] == "" and rec["clear_answer"] is True, order
        assert "content_only" not in rec, order


def test_review_draft_revision_only_changes_on_real_edit():
    draft = rr.ReviewDraft(object())
    assert draft.revision == 0
    draft.set_content("新正文", [])
    assert draft.revision == 1
    draft.clear_answer()
    assert draft.revision == 2
    draft.use_restore_original("修复前原文")
    assert draft.revision == 3
