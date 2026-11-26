import json

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
