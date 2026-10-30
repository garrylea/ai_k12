"""道法策略：A–D 四项、无材料归属；答案段走 generic。

道法是材料题，材料归属与主观题切分尚未实现（见 plan 附录），
当前行为与重构前一致：切题走通用规则、答案提取走 generic。
"""

from subject_strategies.generic import NaturalScienceStrategy


class PoliticsStrategy(NaturalScienceStrategy):
    code = "politics"
