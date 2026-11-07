"""material_text → MinerU 块 bbox 的定位测试。"""
import json

from material_bbox import Block, load_blocks, match_material, norm_text, to_points


def _write_sidecar(tmp_path, blocks):
    md = tmp_path / "卷.md"
    md.write_text("md", encoding="utf-8")
    (tmp_path / "卷.json").write_text(json.dumps(blocks, ensure_ascii=False), encoding="utf-8")
    return md


def test_norm_text_drops_punctuation():
    assert norm_text("发言稿一 烽火古道·赤诚抗日。") == "发言稿一烽火古道赤诚抗日"


def test_load_blocks_missing_returns_none(tmp_path):
    assert load_blocks(tmp_path / "不存在.md") is None


def test_match_material_only_hits_material_blocks(tmp_path):
    paragraph = ("平西地下交通线是抗日战争时期平西抗日根据地与北平之间的一条重要秘密交通线，"
                 "它从西直门起，经海淀镇、西北旺、温泉、北安河，终至妙峰山。")
    blocks = [
        {"page_idx": 0, "bbox": [352, 363, 640, 381], "text": "发言稿一 烽火古道 赤诚抗日", "type": "text"},
        {"page_idx": 0, "bbox": [100, 391, 927, 513], "text": paragraph, "type": "text"},
        {"page_idx": 0, "bbox": [72, 677, 927, 826],
         "text": "2. 你检查文段中标注的加点字的字音和加点词语的字形。下列说法不正确的一项是", "type": "text"},
    ]
    md = _write_sidecar(tmp_path, blocks)
    loaded = load_blocks(md)
    material = f"发言稿一 烽火古道 赤诚抗日\n{paragraph}"
    regions = match_material(material, loaded)
    assert [r.bbox for r in regions] == [(352, 363, 640, 381), (100, 391, 927, 513)]
    assert all("检查文段" not in r.text for r in regions)


def test_match_material_handles_ocr_small_diff():
    """块文本有一两处 OCR 差异时，靠最长公共子串仍能命中。"""
    material = ("骑楼是岭南地区常见的建筑形式，既能遮阳又能避雨。"
                "街道两旁的骑楼连成一片，形成独特的城市景观。")
    blocks = [Block(page=2, bbox=(10, 20, 300, 80),
                    text="骑楼是岭南地区常见的建筑形式，既能遮阳又能避雨。"
                         "街道两旁骑楼连成一片，形成独特的城市景观。", type="text")]
    assert len(match_material(material, blocks)) == 1


def test_no_match_for_question_stem_only():
    material = "平西地下交通线是抗日战争时期的一条重要秘密交通线。"
    blocks = [Block(page=0, bbox=(0, 0, 10, 10),
                    text="你检查文段中标注的加点字的字音和加点词语的字形。下列说法不正确的一项是", type="text")]
    assert match_material(material, blocks) == []


def test_to_points_scales_normalized_bbox():
    assert to_points((0, 0, 1000, 500), 600, 800) == (0, 0, 600, 400)
