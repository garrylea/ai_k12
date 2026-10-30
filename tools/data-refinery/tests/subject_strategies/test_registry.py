"""注册表与策略契约测试。"""

import pytest

from subject_strategies import get_strategy, register
from subject_strategies.types import (
    NO_MATERIAL, MaterialPolicy, UnknownStrategyError,
)


def test_get_strategy_returns_generic_instance():
    s = get_strategy("generic")
    assert s.code == "generic"
    assert s.material_policy() == NO_MATERIAL


def test_get_strategy_unknown_subject_raises():
    with pytest.raises(UnknownStrategyError) as exc:
        get_strategy("biology")
    assert "biology" in str(exc.value)


def test_get_strategy_none_raises():
    with pytest.raises(UnknownStrategyError):
        get_strategy(None)


def test_politics_registered_with_generic_answers():
    """道法：重构前 `get_case("politics")` 明确 fallback 到 generic，策略化后必须保持。

    这条是防「顺手缩能力」的钉子——politics 一旦漏登记，答案回填会把道法卷
    计入 skipped，看着像「没答案段」，实际是学科没接上。
    """
    strategy = get_strategy("politics")
    assert strategy.code == "politics"
    # 与数学共用同一份 generic 实现（不是复制一份，也不是空实现）
    assert strategy.answers is get_strategy("math").answers


@pytest.mark.parametrize(("code", "split", "choice"), [
    ("chinese", (2, 6), (3, 6)),
    ("generic", (4, 4), (4, 4)),
    ("math", (4, 4), (4, 4)),
    ("physics", (4, 4), (4, 4)),
    ("chemistry", (4, 4), (4, 4)),
    ("politics", (4, 4), (4, 4)),
    ("english", (4, 4), (4, 4)),
])
def test_option_bounds_are_per_subject(code, split, choice):
    """项数区间只有策略一份：split_bounds（拆出几项算拆成功）≠ choice_bounds（算不算选择题）。

    语文分别是 2–6 / 3–6，其余学科都是 4–4。此前这三个数散在 chinese.py、
    question_labeler.py、question_extract.py 三处，改一处漏两处。
    """
    strategy = get_strategy(code)
    assert strategy.split_bounds() == split
    assert strategy.choice_bounds() == choice


def test_material_policy_defaults_do_not_attach():
    policy = MaterialPolicy()
    assert policy.attach is False
    assert policy.is_material_title(["a"], 0, "a") is False
    assert policy.looks_like_between_material("x", "y") is False


def test_register_does_not_allow_silent_override():
    class Fake:
        code = "faketest"
        def is_stem(self, line): return False, None
        def split_options(self, content): return content, None
        def material_policy(self): return NO_MATERIAL
        def extract_answers(self, text, md_path): return []

    register(Fake())
    assert get_strategy("faketest").code == "faketest"
    with pytest.raises(ValueError):
        register(Fake())  # 重复注册直接报错，避免顺序依赖


def test_unknown_subject_dir_is_not_silently_math():
    from question_extract import _subject_code_for

    assert _subject_code_for(("科学", "初中", "first")) is None
    assert _subject_code_for(("物理", "初中", "first")) == "physics"
