"""语文答案提取 case 单测（纯函数，不连库、不调 LLM）。"""

from pathlib import Path

from subject_cases import ExtractedAnswer, UnknownSubjectError, detect_subject, get_case
from subject_cases import chinese


def _case(text: str) -> list[ExtractedAnswer]:
    return chinese.extract_answers(text, Path("语文/初中/second/2025/卷-试卷.md"))


SAMPLE = """# 2025 海淀 初三 模拟二

## 一、基础·运用（共 4分）

1.小组成员请你确认文段中加点词语的读音。
2.请根据语境作出解释。

## 二、古诗文阅读（共 6分）

3.默写。

# 参考答案

## 一、基础·运用（共 4 分）

1．C（2 分）

2．示例：集知识性、创新性、趣味性于一体的科技盛会。（共 2分。根据语境，1分；合理解释，1分。有其他答法，视其合理程度给分）

## 二、古诗文阅读（共 6 分）

（一）（共 2 分）

3．益慕圣贤之道（1分。有错该空不得分）

（二）（共 4 分）

4．示例：晴川历历汉阳树 芳草萋萋鹦鹉洲（2分。共 2空，每空 1分）

## 五、写作（40 分）

## 5．评分参考

说明：1. 字数不足 600字，每少 50字扣 1分，最多扣 3分。

2.作文中如出现所在学校的校名或师生姓名，从总得分中扣 4分。
"""


def test_extract_basic_alignment_and_clean_answer():
    answers = {a.no: a for a in _case(SAMPLE)}
    assert sorted(answers) == [1, 2, 3, 4, 5]
    # 选择题：答案只留字母，纯分值不进解析（避免「（2 分）」噪声）
    assert answers[1].answer == "C"
    assert answers[1].explanation == ""
    # 示例答案：保留正文，评分说明进解析
    assert answers[2].answer.startswith("示例：集知识性")
    assert "给分" in answers[2].explanation
    # 填空：剥离「（1分。有错该空不得分）」
    assert answers[3].answer == "益慕圣贤之道"
    assert "不得分" in answers[3].explanation


def test_fullwidth_dot_question_numbers():
    answers = {a.no: a for a in _case(SAMPLE)}
    assert answers[4].answer.startswith("示例：晴川历历汉阳树")


def test_group_and_section_headers_not_in_answers():
    answers = {a.no: a for a in _case(SAMPLE)}
    joined = "\n".join(a.answer for a in answers.values())
    assert "基础·运用" not in joined
    assert "古诗文阅读" not in joined
    assert "（一）" not in joined


def test_regressing_number_in_answer_is_continuation_not_new_block():
    """作文评分细则「1. 字数不足…」是回退编号，不能串到第 1 题。"""
    answers = {a.no: a for a in _case(SAMPLE)}
    assert "字数不足" not in answers[1].answer
    assert "字数不足" in answers[5].answer
    assert "校名" in answers[5].answer


def test_sparse_missing_answer_records_issue_and_stays_empty():
    text = """# 卷

1. 第一题
2. 第二题

# 参考答案

1．A

3．C
"""
    answers = _case(text)
    by_no = {a.no: a for a in answers}
    # 没有第 2 题答案：不猜、不凭空造，只留空并记 issue
    assert by_no[1].answer == "A"
    assert by_no[3].answer == "C"
    # 未对齐的题不出现（由 CLI 与题库题号比对发现缺口）
    assert 2 not in by_no


def test_no_answer_section_returns_issue():
    answers = _case("# 卷\n\n1. 第一题\n2. 第二题\n")
    assert len(answers) == 1
    assert answers[0].no == 0
    assert "未找到参考答案段" in answers[0].issues[0]


def test_blank_answer_section_item_records_issue():
    # 光秃题号行「1．」：题号在、答案缺失 -> 留空 + issue，绝不猜
    text = (
        "# 卷\n\n1. 第一题\n\n# 参考答案\n\n"
        "1．\n2．B\n"
    )
    answers = {a.no: a for a in _case(text)}
    assert 1 in answers
    assert answers[1].answer == ""
    assert answers[1].issues
    assert answers[2].answer == "B"


def test_markdown_heading_question_number():
    """『## 27．评分参考』的 markdown 标题前缀不影响题号识别。"""
    text = """# 卷

1. 第一题

# 参考答案

1．A

## 2．评分参考

评分细则正文
"""
    answers = {a.no: a for a in _case(text)}
    assert answers[2].answer.startswith("评分参考")


def test_detect_subject_by_path_segment():
    assert detect_subject(Path("语文/初中/second/2025/x-试卷.md")) == "chinese"
    assert detect_subject(Path("数学/初中/second/2025/x-试卷.md")) == "math"


def test_detect_subject_unknown_raises():
    try:
        detect_subject(Path("音乐/初中/second/2025/x-试卷.md"))
    except UnknownSubjectError as e:
        assert "无法从路径识别学科" in str(e)
    else:  # pragma: no cover
        raise AssertionError("未知学科应抛错")


def test_get_case_dispatch():
    assert get_case("chinese") is chinese.extract_answers
    assert get_case("math") is not chinese.extract_answers
    try:
        get_case("music")
    except UnknownSubjectError as e:
        assert "music" in str(e)
    else:  # pragma: no cover
        raise AssertionError("未支持学科应抛错")


def test_subject_codes_shared_mapping():
    """publish/extract/答案提取共用一份学科映射（subject_codes）。"""
    from pathlib import Path as P

    from subject_codes import SUBJECT_NAME_TO_CODE, subject_code_for_path

    assert SUBJECT_NAME_TO_CODE["语文"] == "chinese"
    assert subject_code_for_path(P("语文/初中/second/2025/x-试卷")) == "chinese"
    assert subject_code_for_path(P("化学/初中/second/2025/x-试卷")) == "chemistry"
    # 识别不出回退 math（历史资产路径兼容），不会把语文误判成数学之外的值
    assert subject_code_for_path(P("音乐/初中/second/2025/x-试卷")) == "math"


def test_scoring_table_moved_to_explanation():
    """作文题的评分表整体进解析，答案只留标题。"""
    text = (
        "# 卷\n\n1. 第一题\n\n# 参考答案\n\n"
        "1．评分参考\n"
        "<table><tr><td>项目等级</td><td>内容(36分)</td></tr></table>\n"
        "说明：1. 字数不足 600字，每少 50字扣 1分。\n"
    )
    answers = {a.no: a for a in _case(text)}
    assert answers[1].answer == "评分参考"
    assert "<table" in answers[1].explanation
    assert "字数不足" in answers[1].explanation
