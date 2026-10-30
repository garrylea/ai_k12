"""学科策略注册表。

未登记学科抛 UnknownStrategyError —— 不允许静默回退到 generic。
各学科模块在 import 时调用 register()。
"""

from subject_strategies.types import QuestionStrategy, UnknownStrategyError

_STRATEGIES: dict[str, QuestionStrategy] = {}


def register(strategy: QuestionStrategy) -> None:
    """登记一个学科策略；重复登记同名 code 直接报错（避免 import 顺序决定行为）。"""
    if strategy.code in _STRATEGIES:
        raise ValueError(f"学科策略重复登记：{strategy.code}")
    _STRATEGIES[strategy.code] = strategy


def get_strategy(code: str | None) -> QuestionStrategy:
    """按学科 code 取策略；code 为空或未登记则抛 UnknownStrategyError。"""
    if not code:
        raise UnknownStrategyError("学科 code 为空，无法选择切题策略")
    strategy = _STRATEGIES.get(code)
    if strategy is None:
        raise UnknownStrategyError(
            f"学科 {code} 未实现切题策略；请在 src/subject_strategies/ 下实现并 register()"
        )
    return strategy


from subject_strategies.generic import GenericStrategy  # noqa: E402

register(GenericStrategy())

from subject_strategies.math import MathStrategy  # noqa: E402
from subject_strategies.physics import PhysicsStrategy  # noqa: E402
from subject_strategies.chemistry import ChemistryStrategy  # noqa: E402

register(MathStrategy())
register(PhysicsStrategy())
register(ChemistryStrategy())

from subject_strategies.chinese import ChineseStrategy  # noqa: E402

register(ChineseStrategy())

from subject_strategies.english import EnglishStrategy  # noqa: E402

register(EnglishStrategy())
