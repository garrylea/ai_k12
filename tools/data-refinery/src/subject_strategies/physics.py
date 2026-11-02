"""物理策略：A–D 四项、图选项与数学共用规则、材料两种形态。

图选项（字母标在图下方，MinerU 线性化为「图\nA\n图\nB」）由 split_options 的
「标记在内容上方」分支处理 —— 规则共用，但归属在本文件：物理图选项出问题只改这里。
物理卷目前没有参考答案段（39 张上学期卷实测 0 命中），走 generic 的「无答案」路径。

物理材料题有**两种**形态，分别由两个钩子处理（规则都共用 `material_split.py`）：

1. **题内材料**（`31. 阅读以下文字…` + 材料 + `(1)(2)(3)`）→ `split_material()`，
   切题后按 content 切出材料。
2. **题前共享材料**（`请阅读《航天动力电池》并回答第 32 题。` + 材料 + `32. 请根据上述材料…`）
   → `attach_pre_material()`，切题后按引导语锚点挂到引用它的题目上。
   2026-11-02 之前这种形态的材料被整段丢弃（用户报告第 32 题）。
"""

from subject_strategies.generic import NaturalScienceStrategy
from subject_strategies.material_split import attach_pre_material, split_material_rule


class PhysicsStrategy(NaturalScienceStrategy):
    code = "physics"

    def split_material(self, content: str) -> tuple[str | None, str]:
        return split_material_rule(content)

    def attach_pre_material(self, questions, lines) -> int:
        return attach_pre_material(questions, lines)
