"""化学策略：A–D 四项、无跨题材料归属；答案段走 generic（表格/逐题）。

化学材料题与物理同为两种形态（2026-11-02 补第二种）：

1. **题内材料**（`29. 阅读下面科普短文。`、`37. …【进行实验】…` + 小问）→ `split_material()`
2. **题前共享材料**（`请阅读《…》并回答第 N 题。` + 材料 + `N. 请根据上述材料…`）
   → `attach_pre_material()`

规则都共用 `material_split.py`。
"""

from subject_strategies.generic import NaturalScienceStrategy
from subject_strategies.material_split import attach_pre_material, split_material_rule


class ChemistryStrategy(NaturalScienceStrategy):
    code = "chemistry"

    def split_material(self, content: str) -> tuple[str | None, str]:
        return split_material_rule(content)

    def attach_pre_material(self, questions, lines) -> int:
        return attach_pre_material(questions, lines)
