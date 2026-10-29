"""知识点标定提示词按学科拆分。"""

from backfill_question_kps import _load_kps_prompt


def test_english_prompt_uses_english_role_not_math():
    prompt = _load_kps_prompt("english")
    assert "初中英语老师" in prompt
    assert "初中数学老师" not in prompt
    assert "时态" in prompt


def test_math_prompt_keeps_math_rules():
    prompt = _load_kps_prompt("math")
    assert "初中数学老师" in prompt
    assert "几何证明" in prompt


def test_chinese_prompt_keeps_specific_rules():
    prompt = _load_kps_prompt("chinese")
    assert "初中语文老师" in prompt
    assert "文言文阅读" in prompt
    assert "作文题" in prompt


def test_each_configured_subject_has_prompt():
    for subject in ("chinese", "math", "english", "physics", "chemistry", "politics"):
        prompt = _load_kps_prompt(subject)
        assert "【本学科选点规则】" in prompt
        assert "{{subject_name}}" not in prompt
        assert "{{subject_rules}}" not in prompt


def test_unknown_subject_falls_back_to_generic():
    prompt = _load_kps_prompt("biology")
    assert "初中生物老师" in prompt
    assert "最具体的节点" in prompt


def test_common_contract_appears_once():
    prompt = _load_kps_prompt("physics")
    assert prompt.count("【输出格式 -- 必须严格遵守】") == 1
