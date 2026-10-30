"""数学/物理/化学：显式登记，行为与 generic 一致（图选项走 A–D 同一套规则）。"""

import pytest

from subject_strategies import get_strategy
from subject_strategies.types import NO_MATERIAL


@pytest.mark.parametrize("code", ["math", "physics", "chemistry"])
def test_registered_with_own_code(code):
    s = get_strategy(code)
    assert s.code == code
    assert s.material_policy() == NO_MATERIAL


@pytest.mark.parametrize("code", ["math", "physics", "chemistry"])
def test_split_options_abcd(code):
    content = "下列说法正确的是\nA. 甲\nB. 乙\nC. 丙\nD. 丁"
    stem, opts = get_strategy(code).split_options(content)
    assert [o["label"] for o in opts] == ["A", "B", "C", "D"]
    assert "下列说法正确的是" in stem


def test_physics_sub_question_is_not_a_stem():
    """物理实验题 '21.（1）…' 里的小问号不算主题号。"""
    assert get_strategy("physics").is_stem("21.（1）如图甲所示")[0] is True
    assert get_strategy("physics").is_stem("（1）如图甲所示")[0] is False
