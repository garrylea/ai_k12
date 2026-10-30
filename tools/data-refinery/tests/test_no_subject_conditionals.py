"""内核不得残留学科判断（学科差异必须在 subject_strategies/ 里）。"""

from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src" / "question_splitter.py"


def test_core_has_no_subject_conditionals():
    code = SRC.read_text(encoding="utf-8")
    # 去掉行注释后再找，允许注释里解释策略机制
    executable = "\n".join(
        line for line in code.splitlines() if not line.lstrip().startswith("#")
    )
    assert 'subject ==' not in executable
    assert '"chinese"' not in executable
