"""语文策略：选项体系与材料归属。"""

from subject_strategies import get_strategy

S = get_strategy("chinese")


def test_split_options_cn_labels_three_items():
    content = "下列对文中语句理解最恰当的一项是\n甲. 春和景明\n乙. 波澜不惊\n丙. 上下天光"
    stem, opts = S.split_options(content)
    assert [o["label"] for o in opts] == ["A", "B", "C"]
    assert [o["original_label"] for o in opts] == ["甲", "乙", "丙"]
    assert "春和景明" in opts[0]["text"]


def test_split_options_circled_labels():
    content = "选出正确的一项\n① 甲句\n② 乙句\n③ 丙句"
    _, opts = S.split_options(content)
    assert [o["label"] for o in opts] == ["A", "B", "C"]


def test_split_options_gives_up_when_first_label_missing():
    """OCR 丢掉 A 的点号时不许重编号（会把 A/B 内容并进题干）。"""
    content = "题干\nA ①\nB. ②\nC. ③"
    stem, opts = S.split_options(content)
    assert opts is None
    assert stem == content


def test_material_policy_attaches():
    assert S.material_policy().attach is True
