"""内核必须真的问策略 `is_stem`，而不是绕过它直接调 `is_main_stem`。

这条钉子来自 2026-10-30 全分支审查的 I1：重构把「题号判定」写成策略方法，
但主切分循环与 `_has_next_stem` 仍直接调模块级 `is_main_stem` —— 单元测试
（只测策略对象自己）全绿，管线却完全无视覆盖，正是这轮重构要消灭的失败模式。
所以这里注册一个 `is_stem` 恒为 `(True, 42)` 的策略，断言 `split_page` 真的按它切。
"""

from pathlib import Path

from question_splitter import _has_next_stem, split_page
from subject_strategies import get_strategy, register
from subject_strategies.types import NO_MATERIAL


class _AlwaysStemStrategy:
    """把每一行都当第 42 题（其余能力全委托内核，避免干扰）。"""

    code = "test_always_stem"
    _inner = get_strategy("generic")

    def is_stem(self, line: str):
        return True, 42

    def split_options(self, content: str):
        return self._inner.split_options(content)

    def split_bounds(self):
        return self._inner.split_bounds()

    def choice_bounds(self):
        return self._inner.choice_bounds()

    def material_policy(self):
        return NO_MATERIAL

    def extract_answers(self, text, md_path):
        return []


register(_AlwaysStemStrategy())


def test_split_page_uses_strategy_is_stem():
    """没有题号的文本按通用规则切出 0 题；换成恒真谓词的策略必须切出第 42 题。"""
    text = "题干一行，没有任何数字题号\n"

    assert [q.group_order for q in split_page(text, Path("x.md"))] == []

    questions = split_page(text, Path("x.md"), strategy=get_strategy("test_always_stem"))

    assert [q.group_order for q in questions] == [42]
    assert questions[0].content == "题干一行，没有任何数字题号"


def test_has_next_stem_honours_injected_predicate():
    """「下一行是不是新题」的判定也走同一个谓词：默认口径下没有下一题，假谓词下有。"""
    lines = ["这是题干续行", "还是续行"]

    assert _has_next_stem(lines, 0, 6) is False
    assert _has_next_stem(lines, 0, 6, is_stem=_AlwaysStemStrategy().is_stem) is True
