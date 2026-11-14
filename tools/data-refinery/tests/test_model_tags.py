# -*- coding: utf-8 -*-
"""model_tags 纯函数测试（LLM/DB 不参与）。"""

from model_tags import (
    CATEGORY_NAMES,
    CATEGORY_ORDER,
    MODEL_DRIVEN,
    MODEL_NAMES,
    build_system_prompt,
    build_taxonomy_block,
    normalize_category,
    normalize_model,
)


def test_category_enum_has_eight_entries():
    assert CATEGORY_ORDER == [
        "new_definition", "geometry_synthesis", "circle_synthesis", "extremum",
        "algebra_synthesis", "function_graph", "stats_probability", "application",
    ]
    assert CATEGORY_NAMES["geometry_synthesis"] == "几何综合"
    assert MODEL_DRIVEN == {"geometry_synthesis", "circle_synthesis", "extremum"}


def test_normalize_category_accepts_code_and_chinese_name():
    assert normalize_category("geometry_synthesis") == "geometry_synthesis"
    assert normalize_category(" 几何综合 ") == "geometry_synthesis"
    assert normalize_category("`new_definition`") == "new_definition"
    assert normalize_category("不存在的类") is None
    assert normalize_category(None) is None


def test_normalize_model_accepts_code_and_chinese_name():
    assert normalize_model("geometry_synthesis", "median_doubling") == "median_doubling"
    assert normalize_model("geometry_synthesis", "倍长中线") == "median_doubling"
    assert normalize_model("geometry_synthesis", "") == ""
    assert normalize_model("geometry_synthesis", "手拉手（旋转全等）") == "hand_in_hand"
    assert normalize_model("geometry_synthesis", "切线判定与性质") is None  # 属于圆综


def test_taxonomy_block_contains_every_code():
    block = build_taxonomy_block()
    for cat in CATEGORY_ORDER:
        assert cat in block
        for model in MODEL_NAMES[cat]:
            assert model in block


def test_system_prompt_contains_rules_and_taxonomy():
    prompt = build_system_prompt("规则：只输出 JSON")
    assert prompt.startswith("规则：只输出 JSON")
    assert "median_doubling" in prompt
    assert "倍长中线" in prompt
