"""meaning_cli 单测：解析与「按原文定位下标」。

钉住四件事：
- 模板解析出 (原文, 含义, 情感) 三元组，按篇名归一定位；
- 产出数组**与 sentences 等长**，没填的位置是 `None`（不是压缩掉——压缩会让后面整体错位）；
- 定位**按原文**，不是按行号：模板调序了也跟着原文走；
- 定位不到的原文进 `skipped`，绝不猜、绝不静默丢。
"""

from src.meaning_cli import build_meanings_array, parse_template


TEMPLATE = """# 酬乐天扬州初逢席上见赠

## 第1句
> 巴山楚水凄凉地，二十三年弃置身。
含义：写被贬之地的荒凉。
情感：辛酸

## 第2句
> 沉舟侧畔千帆过，病树前头万木春。
含义：比喻新事物必将取代旧事物。
情感：豁达乐观
"""


def test_parse_template():
    got = parse_template(TEMPLATE)
    assert list(got) == ["酬乐天扬州初逢席上见赠"]
    entries = got["酬乐天扬州初逢席上见赠"]
    assert entries[0] == ("巴山楚水凄凉地，二十三年弃置身。", "写被贬之地的荒凉。", "辛酸")


def test_build_meanings_array_按原文定位下标():
    sentences = [
        {"text": "巴山楚水凄凉地，二十三年弃置身。"},
        {"text": "沉舟侧畔千帆过，病树前头万木春。"},
        {"text": "今日听君歌一曲，暂凭杯酒长精神。"},  # 人工没填这句
    ]
    entries = parse_template(TEMPLATE)["酬乐天扬州初逢席上见赠"]
    arr, skipped = build_meanings_array(sentences, entries)
    # 长度与 sentences 对齐；第 3 句没填 → null（不是压缩掉，否则整体错位）
    assert arr == [
        {"meaning": "写被贬之地的荒凉。", "emotion": "辛酸"},
        {"meaning": "比喻新事物必将取代旧事物。", "emotion": "豁达乐观"},
        None,
    ]
    assert skipped == []


def test_build_meanings_array_调序也不会错位():
    sentences = [
        {"text": "沉舟侧畔千帆过，病树前头万木春。"},
        {"text": "巴山楚水凄凉地，二十三年弃置身。"},
    ]
    entries = parse_template(TEMPLATE)["酬乐天扬州初逢席上见赠"]
    arr, _ = build_meanings_array(sentences, entries)
    assert arr[0]["emotion"] == "豁达乐观"   # 跟着原文走，不是跟着行号走
    assert arr[1]["emotion"] == "辛酸"


def test_build_meanings_array_对不上的原文进skipped():
    sentences = [{"text": "今日听君歌一曲，暂凭杯酒长精神。"}]
    entries = parse_template(TEMPLATE)["酬乐天扬州初逢席上见赠"]
    arr, skipped = build_meanings_array(sentences, entries)
    assert arr == [None]
    assert len(skipped) == 2
