"""内核不得残留学科判断（学科差异必须在 subject_strategies/ 里）。

判据故意放宽到 `subject` / `subject_code` 上的 `==` / `!=` / `in`，单双引号都查——
旧版只认 `subject ==` + 双引号 `"chinese"`，`subject in ("chinese",)`、
`subject != 'chinese'`、`subject_code == "chinese"` 都能溜过去。
只对 `question_splitter.py` 断言：`question_labeler.py` / `question_extract.py`
里仍有学科分支（PDF 下划线注入等），那是有意保留的例外，不在本守卫范围。
"""

import re
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src" / "question_splitter.py"

# 学科条件表达式的形状（不含注释行，允许注释里解释策略机制）
_CONDITION_PATTERNS = (
    re.compile(r"subject\s*(==|!=|in)"),
    re.compile(r"subject_code\s*(==|!=|in)"),
)
_CHINESE_LITERAL_RE = re.compile(r"""["']chinese["']""")


def test_core_has_no_subject_conditionals():
    code = SRC.read_text(encoding="utf-8")
    # 去掉行注释后再找，允许注释里解释策略机制
    executable = "\n".join(
        line for line in code.splitlines() if not line.lstrip().startswith("#")
    )
    for pattern in _CONDITION_PATTERNS:
        hit = pattern.search(executable)
        assert hit is None, f"内核出现学科条件判断：{hit.group(0) if hit else ''}"
    assert _CHINESE_LITERAL_RE.search(executable) is None, "内核出现 chinese 字面量"
