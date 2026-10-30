"""extract_answers 的返回元素必须是 subject_strategies.types.ExtractedAnswer。

Task 1 审查发现的缺陷：各策略标注 `-> list[ExtractedAnswer]`，实际返回的是
旧答案提取模块里**另一套同构的** ExtractedAnswer（2026-10-30 重构已删除该模块）
—— 字段结构相同、类不同，isinstance/类型检查都静默放过，只有 `type(x) is ...`
能拦。答案最终要交给 answer_importer 写库，两套类并存等于两份「同一件事」的
定义，改一处漏一处没人发现，所以在这里钉死。
"""

from pathlib import Path

import pytest

from subject_strategies import get_strategy
from subject_strategies.types import ExtractedAnswer

# 语文走自己的答案段算法（找「参考答案」标题），其余走 split_page 的整卷对齐
_CHINESE_PAPER = "# 卷\n\n1. 第一题\n\n# 参考答案\n\n1．A\n"
_GENERIC_PAPER = "# 试卷\n\n1. 单选题\nA. 甲\nB. 乙\nC. 丙\nD. 丁\n"

_PAPERS = {
    "chinese": _CHINESE_PAPER,
    "generic": _GENERIC_PAPER,
    "math": _GENERIC_PAPER,
    "english": _GENERIC_PAPER,
    "physics": _GENERIC_PAPER,
    "chemistry": _GENERIC_PAPER,
}


@pytest.mark.parametrize("code", sorted(_PAPERS))
def test_extract_answers_returns_strategy_types_extracted_answer(code):
    out = get_strategy(code).extract_answers(
        _PAPERS[code], Path(f"{code}/初中/first/2025/卷-试卷.md"))

    assert out, "样例试卷应至少提取到一题"
    for item in out:
        assert type(item) is ExtractedAnswer, (
            f"{code} 返回了 {type(item).__module__}.{type(item).__name__}，"
            "应为 subject_strategies.types.ExtractedAnswer"
        )
