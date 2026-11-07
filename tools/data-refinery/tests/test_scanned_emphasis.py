"""扫描件着重号/下划线 dry-run 检测的纯函数测试（不跑 PaddleOCR）。"""
import numpy as np
import pytest

from scanned_emphasis import (
    CharBox,
    Hit,
    _attribute,
    _group_hits,
    _norm,
    _page_selected,
    _underline_for,
    detect_dots,
)


def _box(ch="奔", x0=20, y0=20, x1=60, y1=60, line_id=0, index=0, line="护送志士奔赴"):
    return CharBox(ch=ch, x0=x0, y0=y0, x1=x1, y1=y1,
                   line_id=line_id, index=index, line_text=line)


def test_norm_drops_punctuation_and_whitespace():
    assert _norm("护送志士奔（bēn）赴，各个根据地。") == "护送志士奔bēn赴各个根据地"


def test_page_selected_ranges():
    assert _page_selected(1, "1-3,5")
    assert _page_selected(5, "1-3,5")
    assert not _page_selected(4, "1-3,5")


def test_detect_dots_under_character():
    """字框下方一个实心小圆点 → 识别为加点。"""
    img = np.full((120, 160), 255, dtype=np.uint8)
    # 字符主体（不是单点）
    img[20:60, 20:60] = 0
    # 字下居中的点
    img[66:72, 37:43] = 0
    hits = detect_dots(img, [_box()])
    assert [h.chars for h in hits] == ["奔"]
    assert hits[0].kind == "dots"


def test_detect_dots_skips_dot_inside_glyph():
    """字框里的笔画小点（如「想」字心里那一点）不能当加点。"""
    img = np.full((120, 160), 255, dtype=np.uint8)
    # 字符主体：两条竖笔 + 中间偏下的小点（分离的笔画）
    img[20:60, 20:28] = 0
    img[20:60, 52:60] = 0
    img[48:54, 34:40] = 0
    hits = detect_dots(img, [_box()])
    assert hits == []


def test_group_hits_merges_adjacent_chars():
    boxes = [_box("周", index=10, x0=20, x1=60), _box("旋", index=11, x0=60, x1=100)]
    hits = _group_hits([(b, (0, 0, 0, 0, 0)) for b in boxes], "dots")
    assert len(hits) == 1 and hits[0].chars == "周旋"


def test_attribute_question_by_longest_common_substring():
    hit = Hit(page=1, kind="dots", chars="周旋",
              line="与敌周旋，多次用自行车驮载（zài）药品")
    _attribute(hit, [
        (2, "平西地下交通线……与敌周旋，多次用自行车驮载（zài）药品，"
            "从王府井居所转运到贝家花园。"),
        (9, "《岳阳楼记》庆历四年春，滕子京谪守巴陵郡。"),
    ])
    assert hit.question_no == 2
    assert hit.match_len >= 6


def test_attribute_shared_material_picks_first_question():
    """题2/题3 共用材料时归小题号（材料块起始题），并标记 ambiguous。"""
    hit = Hit(page=1, kind="dots", chars="周旋", line="与敌周旋")
    same = "与敌周旋，多次用自行车驮载药品"
    _attribute(hit, [(2, same), (3, same)])
    assert hit.question_no == 2
    assert hit.ambiguous is True


def test_detect_underlines_requires_multi_char_run():
    """下划线必须跨多个字；单字底横不能算（Q6 的行内下划线在字框底部内侧）。"""
    from scanned_emphasis import detect_underlines

    img = np.full((80, 400), 255, dtype=np.uint8)
    boxes = [_box(ch, index=i, x0=10 + i * 50, x1=50 + i * 50, y0=10, y1=50,
                  line="一二三四五") for i, ch in enumerate("一二三四五")]
    img[47:50, 10:260] = 0   # 字框底部内侧的横线
    hits = detect_underlines(img, boxes)
    assert len(hits) == 1 and hits[0].chars == "一二三四五"

    one = np.full((80, 400), 255, dtype=np.uint8)
    one[47:50, 10:50] = 0    # 只有一个字的底横
    assert detect_underlines(one, boxes) == []


def test_underline_for_detects_horizontal_line():
    img = np.full((120, 160), 255, dtype=np.uint8)
    img[20:60, 20:60] = 0
    img[64:67, 20:60] = 0   # 字下横线
    assert _underline_for(_box(), img) is True

    blank = np.full((120, 160), 255, dtype=np.uint8)
    blank[20:60, 20:60] = 0
    assert _underline_for(_box(), blank) is False
