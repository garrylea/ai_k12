"""标注提示词按学科拆分：公共契约一份，学科规则各自一份。"""

from question_extract import _load_labeler_prompt


def test_chinese_prompt_has_own_rules_not_math():
    prompt = _load_labeler_prompt("chinese")
    assert "本学科判定标准：语文" in prompt
    assert "本学科判定标准：数学" not in prompt
    assert "禁止修复" in prompt                      # 画线句/链接材料只报告
    assert "3 项" in prompt                          # 语文选项不要求 4 项


def test_chinese_prompt_checks_material_before_flagging_underline():
    """画线句缺失必须先查材料里是否已有标记，已有标记时判完整、不报缺陷。

    回归：八中 2026 期中题 7 的材料里有 `<u>观展过程中……</u>`，旧提示词把
    「画线句具体指哪一句」写成无条件只报告，LLM 看到标记仍报「指代不明」。
    """
    prompt = _load_labeler_prompt("chinese")
    assert "先看这段材料" in prompt
    assert "标记存在且能唯一确定指代" in prompt
    assert "判 `is_complete=true`" in prompt
    assert "不要把材料里已经存在的标记当成丢失" in prompt


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
