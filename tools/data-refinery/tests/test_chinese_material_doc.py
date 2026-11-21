from pathlib import Path

from chinese_material_doc import (
    annotation_score,
    build_groups,
    choose_canonical,
    doc_key,
    is_heading_only,
    normalize_for_group,
    rewrite_hash_for_row,
    strip_section_instruction,
    write_material_doc,
)


def test_strip_section_instruction_drops_paper_specific_line():
    text = "## (三)阅读下面《醉翁亭记》，完成 12-14题。(共 7分)\n\n## 醉翁亭记\n\n欧阳修"
    out = strip_section_instruction(text)
    assert out.startswith("## 醉翁亭记")
    assert "完成 12-14题" not in out


def test_strip_section_instruction_keeps_article_heading():
    text = "## 前言\n\n“典则”取自唐代窦蒙……"
    assert strip_section_instruction(text) == text


def test_heading_only_true_for_mo_xie_heading():
    assert is_heading_only("## (一)默写。(共4分)") is True


def test_heading_only_false_when_body_exists():
    assert is_heading_only("## 前言\n\n正文一段。") is False


def test_normalize_ignores_emphasis_tags_and_images():
    a = '初夏<span class="cn-emphasis-dot">高</span><u>涨</u> ![x](images/a.jpg)'
    b = "初夏高涨"
    assert normalize_for_group(a) == normalize_for_group(b)


def test_normalize_drops_sub_dot_content():
    a = "我静静<sub>．．</sub>地<sub>．</sub>听着"
    b = "我静静地听着"
    assert normalize_for_group(a) == normalize_for_group(b)


def test_choose_canonical_prefers_more_annotations():
    plain = "热啊，热啊。父亲说，还好。"
    annotated = "热啊，热<u>啊。</u>父亲说，<u>还好</u>。"
    assert choose_canonical([plain, annotated]) == annotated


def test_doc_key_stable_when_only_annotation_changes():
    a = "他<span class=\"cn-emphasis-dot\">静</span>静地听着。"
    b = "他静静地听着。"
    assert doc_key(a, []) == doc_key(b, [])


def test_doc_key_changes_when_image_changes():
    body = "同一段文字"
    assert doc_key(body, ["a"]) != doc_key(body, ["b"])


class _Store:
    def __init__(self, root: Path):
        self.root = root

    def put(self, rel: str, src: Path) -> None:
        dest = self.root / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(src.read_bytes())


def test_write_material_doc_writes_md_and_images(tmp_path):
    assets = tmp_path / "assets"
    src_dir = tmp_path / "src"
    src_dir.mkdir()
    (src_dir / "a.jpg").write_bytes(b"img-a")
    body = "## 醉翁亭记\n\n环滁皆山也。\n\n![](images/a.jpg)"

    def resolver(ref: str):
        for c in (src_dir / ref, src_dir / "images" / Path(ref).name, src_dir / Path(ref).name):
            if c.exists():
                return c
        return None

    key, url = write_material_doc(
        body,
        resolver=resolver,
        store=_Store(assets),
        assets_dir=assets,
        subject_code="chinese",
    )

    assert url == f"materials/chinese/{key}/content.md"
    md = (assets / url).read_text(encoding="utf-8")
    assert "## 醉翁亭记" in md
    assert f"materials/chinese/{key}/fig_01.jpg" in md
    assert (assets / f"materials/chinese/{key}/fig_01.jpg").exists()


def test_build_groups_by_paper_and_normalized_text():
    rows = [
        {"id": 1, "paper_id": 667, "source": "八中", "material_text": "## 醉翁亭记\n\n甲"},
        {"id": 2, "paper_id": 667, "source": "八中", "material_text": "## 醉翁亭记\n\n甲"},
        {"id": 3, "paper_id": 667, "source": "八中", "material_text": "## 前言\n\n乙"},
    ]
    groups = build_groups(rows)
    assert len(groups) == 2
    assert sorted(len(v) for v in groups.values()) == [1, 2]


def test_rewrite_hash_for_row_uses_material_url():
    row = {"content": "题干", "options": None, "material_text": None,
           "material_url": "materials/chinese/aaa/content.md"}
    h = rewrite_hash_for_row(row)
    assert len(h) == 64
