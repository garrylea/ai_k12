"""通用策略：A–D 四项、无材料归属，答案复用 question_splitter 的整卷切分与对齐。

禁止把它当「未登记学科的兜底」——get_strategy 不认未登记 code。

答案提取也在本文件（2026-10-30 并入）：数学 / 物理 / 化学 / 道法 / 英语都用这一份实现
（与主管线 extract 行为一致），将来单科要定制答案规则就在自己文件里覆盖
`answers` / `extract_answers`，不影响其他学科。
"""

from pathlib import Path

from question_splitter import is_main_stem, split_options, split_page
from subject_strategies.types import ExtractedAnswer, MaterialPolicy, NO_MATERIAL


def extract_generic_answers(text: str, md_path: Path,
                            strategy=None) -> list[ExtractedAnswer]:
    """整卷切分 → 取每题已对齐的答案（空答案原样留空，不猜）。

    `strategy` 必须与切题用的是同一个：某科一旦覆盖了 `split_options` /
    `material_policy`，答案按另一套切分对齐就会静默错位（题号对得上、内容对不上）。
    None 表示 generic（既有两参调用行为不变）。
    """
    questions = split_page(text, md_path, strategy=strategy)
    return [
        ExtractedAnswer(no=q.group_order, answer=(q.answer or "").strip())
        for q in questions
    ]


class GenericStrategy:
    code = "generic"

    def is_stem(self, line: str) -> tuple[bool, int | None]:
        return is_main_stem(line)

    def split_options(self, content: str) -> tuple[str, list[dict] | None]:
        return split_options(content)

    def split_bounds(self) -> tuple[int, int]:
        return (4, 4)

    def choice_bounds(self) -> tuple[int, int]:
        return (4, 4)

    def material_policy(self) -> MaterialPolicy:
        return NO_MATERIAL

    def extract_answers(self, text: str, md_path: Path) -> list[ExtractedAnswer]:
        return extract_generic_answers(text, md_path, strategy=self)


class NaturalScienceStrategy:
    """数学/物理/化学/道法的默认行为：A–D 四项、无材料归属、答案走 generic。

    各科文件继承本类并指定 `code` —— 学科差异写在子类里（覆盖 `answers` 或
    `extract_answers`），没有差异就只声明归属，不复制逻辑。
    """

    code: str = ""
    answers = staticmethod(extract_generic_answers)

    def is_stem(self, line: str) -> tuple[bool, int | None]:
        return is_main_stem(line)

    def split_options(self, content: str) -> tuple[str, list[dict] | None]:
        return split_options(content)

    def split_bounds(self) -> tuple[int, int]:
        return (4, 4)

    def choice_bounds(self) -> tuple[int, int]:
        return (4, 4)

    def material_policy(self) -> MaterialPolicy:
        return NO_MATERIAL

    def extract_answers(self, text: str, md_path: Path) -> list[ExtractedAnswer]:
        # 把 self 当 strategy 传回去：子类若覆盖 split_options / material_policy，
        # 答案与题干才会按同一套规则切开（`answers` 仍是可覆盖的 staticmethod）。
        return self.answers(text, md_path, strategy=self)
