"""化学策略：A–D 四项、无材料归属；答案段走 generic（表格/逐题）。"""

from subject_cases.generic import chemistry_answers
from subject_strategies.generic import NaturalScienceStrategy


class ChemistryStrategy(NaturalScienceStrategy):
    code = "chemistry"
    answers = staticmethod(chemistry_answers)
