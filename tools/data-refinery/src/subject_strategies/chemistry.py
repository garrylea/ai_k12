"""化学策略：A–D 四项、无跨题材料归属；答案段走 generic（表格/逐题）。

2026-11-02：新增 `split_material`（题内材料切分）。化学的「科普短文 / 实验探究题」
（`29. 阅读下面科普短文。`、`37. …【进行实验】…`）材料与小问在同一题号内，
切分后材料进 `material_text`、小问留在 `content`。规则与物理共用 `material_split.py`。
"""

from subject_strategies.generic import NaturalScienceStrategy
from subject_strategies.material_split import split_material_rule


class ChemistryStrategy(NaturalScienceStrategy):
    code = "chemistry"

    def split_material(self, content: str) -> tuple[str | None, str]:
        return split_material_rule(content)
