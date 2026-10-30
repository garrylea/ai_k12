"""物理策略：A–D 四项、图选项与数学共用规则、无材料归属。

图选项（字母标在图下方，MinerU 线性化为「图\nA\n图\nB」）由 split_options 的
「标记在内容上方」分支处理 —— 规则共用，但归属在本文件：物理图选项出问题只改这里。
物理卷目前没有参考答案段（39 张上学期卷实测 0 命中），走 generic 的「无答案」路径。
"""

from subject_strategies.generic import NaturalScienceStrategy


class PhysicsStrategy(NaturalScienceStrategy):
    code = "physics"
