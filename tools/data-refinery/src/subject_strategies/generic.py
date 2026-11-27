"""通用策略：A–D 四项、无材料归属，答案复用 question_splitter 的整卷切分与对齐。

禁止把它当「未登记学科的兜底」——get_strategy 不认未登记 code。

答案提取也在本文件（2026-10-30 并入）：数学 / 物理 / 化学 / 道法 / 英语都用这一份实现
（与主管线 extract 行为一致），将来单科要定制答案规则就在自己文件里覆盖
`answers` / `extract_answers`，不影响其他学科。
"""

from pathlib import Path

from answer_blocks import AnswerLine, AnswerParseResult, AnswerQuestion
from question_splitter import is_main_stem, split_options, split_page_result
from subject_strategies.types import ExtractedAnswer, MaterialPolicy, NO_MATERIAL


def extract_generic_answers(text: str, md_path: Path,
                            strategy=None) -> list[ExtractedAnswer]:
    """整卷切分 → 取每题已对齐的答案（空答案原样留空，不猜）。

    `strategy` 必须与切题用的是同一个：某科一旦覆盖了 `split_options` /
    `material_policy`，答案按另一套切分对齐就会静默错位（题号对得上、内容对不上）。
    None 表示 generic（既有两参调用行为不变）。
    """
    result = split_page_result(text, md_path, strategy=strategy)
    parse_result = result.answer_result
    answers: list[ExtractedAnswer] = []
    for question in result.questions:
        details = [
            {
                "code": issue.code,
                "severity": issue.severity,
                "message": issue.message,
                "question_no": issue.question_no,
                "line_start": issue.line_start,
                "line_end": issue.line_end,
                "excerpt": issue.excerpt,
            }
            for issue in (parse_result.issues if parse_result else [])
            if issue.question_no == question.group_order
        ]
        answers.append(ExtractedAnswer(
            no=question.group_order,
            answer=(question.answer or "").strip(),
            approach=(question.approach or "").strip(),
            explanation=(question.explanation or "").strip(),
            issues=[detail["message"] for detail in details],
            issue_details=details,
        ))
    if parse_result is not None and not any(answer.answer for answer in answers):
        sentinel = next(
            (
                issue
                for issue in parse_result.issues
                if issue.code == "answer_region_no_assignments"
            ),
            None,
        )
        if sentinel is not None:
            answers.append(ExtractedAnswer(
                no=0,
                issues=[sentinel.message],
                issue_details=[{
                    "code": sentinel.code,
                    "severity": sentinel.severity,
                    "message": sentinel.message,
                    "question_no": sentinel.question_no,
                    "line_start": sentinel.line_start,
                    "line_end": sentinel.line_end,
                    "excerpt": sentinel.excerpt,
                }],
            ))
    return answers


class BlockAnswerMixin:
    """generic 答案链：答案区统一走块解析。"""

    def parse_answers(
        self,
        answer_lines: list[AnswerLine],
        questions: list[AnswerQuestion],
        *,
        first_line_no: int,
    ) -> AnswerParseResult:
        from answer_region import parse_answer_region

        return parse_answer_region(
            answer_lines, questions, first_line_no=first_line_no,
        )


class GenericStrategy(BlockAnswerMixin):
    code = "generic"
    supports_global_stem_chain = False

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

    def split_material(self, content: str) -> tuple[str | None, str]:
        """题内材料切分：默认不切（数学/语文/英语/道法都无此形态）。2026-11-02。"""
        return (None, content)

    def extract_answers(self, text: str, md_path: Path) -> list[ExtractedAnswer]:
        return extract_generic_answers(text, md_path, strategy=self)


class NaturalScienceStrategy(BlockAnswerMixin):
    """数学/物理/化学/道法的默认行为：A–D 四项、无材料归属、答案走 generic。

    各科文件继承本类并指定 `code` —— 学科差异写在子类里（覆盖 `answers` 或
    `extract_answers`），没有差异就只声明归属，不复制逻辑。
    """

    code: str = ""
    supports_global_stem_chain = False
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

    def split_material(self, content: str) -> tuple[str | None, str]:
        """题内材料切分：默认不切；物理/化学在各自文件覆盖。2026-11-02。"""
        return (None, content)

    def extract_answers(self, text: str, md_path: Path) -> list[ExtractedAnswer]:
        # 把 self 当 strategy 传回去：子类若覆盖 split_options / material_policy，
        # 答案与题干才会按同一套规则切开（`answers` 仍是可覆盖的 staticmethod）。
        return self.answers(text, md_path, strategy=self)
