import json

import pytest

import manual_fix
import review_content


def _write(tmp_path, monkeypatch, issue, rows):
    ex = tmp_path / "output" / "extracted" / issue["rel_path"] / f"{issue['source']}.jsonl"
    ex.parent.mkdir(parents=True, exist_ok=True)
    ex.write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows),
        encoding="utf-8",
    )
    md = tmp_path / "output" / "md" / issue["rel_path"] / f"{issue['source']}.md"
    md.parent.mkdir(parents=True, exist_ok=True)
    md.write_text("", encoding="utf-8")
    monkeypatch.setattr(review_content, "ROOT", tmp_path)
    return {**issue, "md": str(md)}


def test_snapshot_matches_sub_no(tmp_path, monkeypatch):
    issue = _write(
        tmp_path,
        monkeypatch,
        {
            "source": "政治-卷A",
            "rel_path": "道法/初中/2026/卷A",
            "group_order": 26,
            "sub_no": 2,
        },
        [
            {"group_order": 26, "sub_no": 1, "content": "第一问", "answer": "甲"},
            {"group_order": 26, "sub_no": 2, "content": "第二问", "answer": "乙"},
        ],
    )
    snap = review_content.snapshot(issue)
    assert snap.content == "第二问"
    assert snap.answer == "乙"


def test_snapshot_images_include_inline_material(tmp_path, monkeypatch):
    issue = _write(
        tmp_path,
        monkeypatch,
        {
            "source": "物理-卷A",
            "rel_path": "物理/初中/2026/卷A",
            "group_order": 3,
            "sub_no": 0,
        },
        [{
            "group_order": 3,
            "sub_no": 0,
            "content": "题干",
            "material_text": "",
            "_post_material_text": "素材 ![](images/inline.jpg)",
        }],
    )
    snap = review_content.snapshot(issue)
    assert "images/inline.jpg" in snap.images


def _editable_row(*, material_url, material_text, inline):
    """旧实现 `_editable_body` 吃的 row 形状（material_url / material_text / _post_material_text）。"""
    row = {
        "content": "题干正文",
        "options": [{"label": "A", "text": "甲"}, {"label": "B", "text": "乙"}],
        "material_url": material_url,
        "material_text": material_text,
    }
    if inline is not None:
        row["_post_material_text"] = inline
    return row


def _snapshot_of_row(row):
    """同一份数据换成新编辑器的入参。"""
    return review_content.Snapshot(
        content=row["content"],
        options=row["options"],
        article_url=row.get("material_url"),
        article=row.get("material_text"),
        inline=row.get("_post_material_text"),
    )


def test_editable_body_options_inline_and_external_article():
    row = _editable_row(
        material_url="materials/chinese/x/content.md",
        material_text="整篇共享文章",
        inline="题内素材",
    )
    body = review_content.editable_body(_snapshot_of_row(row))
    assert "A. 甲" in body and "B. 乙" in body
    assert "题内素材" in body and body.rstrip().endswith("题内素材")
    assert "整篇共享文章" not in body, "外置 article 不进入编辑器"


def test_snapshot_load_repair_reads_original_content(tmp_path, monkeypatch):
    monkeypatch.setattr(review_content, "ROOT", tmp_path)
    original = "修复前原文，完整段落。" * 12
    lab = tmp_path / "output" / "labeling_issues.jsonl"
    lab.parent.mkdir(parents=True)
    lab.write_text(json.dumps({
        "source": "物理-卷A",
        "group_order": 18,
        "original_content": original,
        "regenerated": {"content": "短版"},
    }, ensure_ascii=False) + "\n", encoding="utf-8")
    issue = {"source": "物理-卷A", "rel_path": "物理/初中/2026/卷A",
             "group_order": 18, "sub_no": 0}

    assert review_content.snapshot(issue).repair_original is None
    assert review_content.snapshot(issue, load_repair=True).repair_original == original
