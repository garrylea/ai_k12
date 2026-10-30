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
