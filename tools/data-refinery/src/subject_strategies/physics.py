"""物理策略：A–D 四项、图选项与数学共用规则、**题内材料切分**。

图选项（字母标在图下方，MinerU 线性化为「图\nA\n图\nB」）由 split_options 的
「标记在内容上方」分支处理 —— 规则共用，但归属在本文件：物理图选项出问题只改这里。
物理卷目前没有参考答案段（39 张上学期卷实测 0 命中），走 generic 的「无答案」路径。

2026-11-02：新增 `split_material`（题内材料切分）。物理的「科普阅读题」
（`31. 阅读以下文字，并回答问题：` + 材料 + `(1)(2)(3)`）材料与小问在同一题号内，
切分后材料进 `material_text`、小问留在 `content`。规则见 `material_split.py`。
"""

from subject_strategies.generic import NaturalScienceStrategy
from subject_strategies.material_split import split_material_rule


class PhysicsStrategy(NaturalScienceStrategy):
    code = "physics"

    def split_material(self, content: str) -> tuple[str | None, str]:
        return split_material_rule(content)
