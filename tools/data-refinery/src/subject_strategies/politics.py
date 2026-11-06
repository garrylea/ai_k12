"""道法策略：A–D 四项；材料题两种形态都在题号内（不需要跨题归属）。

道法材料大题（2026 海淀卷 26–30）有两种排版，都用 `split_material()` 处理：

1. **材料 + 小问编号**（26/28/30）：材料后跟 `(1)(2)` → 复用物化的
   `split_material_rule`（结构判据：行首 `(1)` + 存在 `(2)` + 材料够长）。
2. **材料 + 末句设问**（27/29）：材料后只有一句「结合材料，运用所学，谈谈……」，
   没有小问编号 → `split_tail_question_rule`（只看最后一个非空行是不是设问）。

**不要**实现 `material_policy`/`attach=True`：道法的 `## 研学任务单`/`## 展品一`
会被跨题材料状态机当成新的材料/小节边界，26 题会被切碎（实测）。

答案段走 generic（整卷对齐），与重构前一致。
"""

from subject_strategies.generic import NaturalScienceStrategy
from subject_strategies.material_split import split_material_rule, split_tail_question_rule


class PoliticsStrategy(NaturalScienceStrategy):
    code = "politics"

    def split_material(self, content: str) -> tuple[str | None, str]:
        material, rest = split_material_rule(content)
        if material:
            return material, rest
        return split_tail_question_rule(content)
