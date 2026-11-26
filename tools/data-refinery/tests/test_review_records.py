"""review_records：三态草稿 → 补题记录（材料槽 / 图片模式 / 答案清空）。"""

import json

import review_records as rr
from review_content import Snapshot
from review_queue import ReviewItem


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
