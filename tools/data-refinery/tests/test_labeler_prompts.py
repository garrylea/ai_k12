"""标注提示词按学科拆分：公共契约一份，学科规则各自一份。"""

from question_extract import _load_labeler_prompt


def test_chinese_prompt_has_own_rules_not_math():
    prompt = _load_labeler_prompt("chinese")
    assert "本学科判定标准：语文" in prompt
    assert "本学科判定标准：数学" not in prompt
    assert "禁止修复" in prompt                      # 画线句/链接材料只报告
    assert "3 项" in prompt                          # 语文选项不要求 4 项


def test_math_prompt_requires_four_options():
    prompt = _load_labeler_prompt("math")
    assert "本学科判定标准：数学" in prompt
    assert "固定 4 项" in prompt
    assert "编造" in prompt


def test_each_configured_subject_has_prompt():
    for subject in ("chinese", "math", "english", "physics", "chemistry", "politics"):
        prompt = _load_labeler_prompt(subject)
        assert "【输出格式" in prompt
        assert "{{subject_rules}}" not in prompt


def test_unknown_subject_falls_back_to_generic():
    prompt = _load_labeler_prompt("biology")
    assert "通用（未单独配置的学科）" in prompt


def test_common_contract_appears_once():
    """公共 JSON 契约只维护一份：拼接后不能重复出现两次输出格式说明。"""
    prompt = _load_labeler_prompt("chinese")
    assert prompt.count("【输出格式 -- 必须严格遵守】") == 1
    assert prompt.count("【已有知识点列表（code + name）】") == 1
