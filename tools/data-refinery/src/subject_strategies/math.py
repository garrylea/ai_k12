"""数学策略：A–D 四项、无材料归属。"""

from subject_cases.generic import math_answers
from subject_strategies.generic import NaturalScienceStrategy


class MathStrategy(NaturalScienceStrategy):
    code = "math"
    answers = staticmethod(math_answers)
