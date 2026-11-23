"""道法策略：A–D 四项、无跨题材料；大题按小问拆分（2026-11-23）。

材料与题目结构由 `politics_subquestions` 负责：材料→(1)→材料→(2)。
不再复用 `material_split.py`（那是物理/化学的「一段材料 + 小问」规则）。
"""

from subject_strategies.generic import NaturalScienceStrategy


class PoliticsStrategy(NaturalScienceStrategy):
    code = "politics"

    def expand_subquestions(self, questions):
        from subject_strategies.politics_subquestions import expand
        return expand(questions)
