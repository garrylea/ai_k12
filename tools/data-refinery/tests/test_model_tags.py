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

EXPECTED_CATEGORY_NAMES = {
    "new_definition": "新定义",
    "geometry_synthesis": "几何综合",
    "circle_synthesis": "圆综",
    "extremum": "最值问题",
    "algebra_synthesis": "代数综合",
    "function_graph": "函数与图象",
    "stats_probability": "统计与概率",
    "application": "实际应用",
}

EXPECTED_MODEL_CODES = {
    "new_definition": {"algebra_new_definition", "geometry_new_definition"},
    "geometry_synthesis": {
        "median_doubling", "segment_cut_extend", "hand_in_hand", "half_angle",
        "three_equal_angles", "rotation_similarity", "midpoint_model",
        "angle_bisector", "isosceles_construction", "translation_construction",
        "axisymmetry_construction", "area_method",
    },
    "circle_synthesis": {
        "tangent", "perpendicular_chord", "inscribed_angle", "similarity_trig",
    },
    "extremum": {
        "point_circle_extremum", "general_drinking_horse", "apollonius_circle",
        "hu_bu_gui", "guadou_principle", "hidden_circle",
    },
    "algebra_synthesis": {"quadratic_equation", "parameter_discussion", "vieta"},
    "function_graph": {"basic_graphs", "graph_transform", "graph_inequality"},
    "stats_probability": {
        "data_representatives", "variance", "probability_calc", "statistical_charts",
    },
    "application": {"equation_modeling", "inequality_modeling", "function_modeling"},
}


def test_category_enum_has_eight_entries():
    assert CATEGORY_ORDER == [
        "new_definition", "geometry_synthesis", "circle_synthesis", "extremum",
        "algebra_synthesis", "function_graph", "stats_probability", "application",
    ]
    assert CATEGORY_NAMES == EXPECTED_CATEGORY_NAMES
    assert MODEL_DRIVEN == {"geometry_synthesis", "circle_synthesis", "extremum"}


def test_normalize_category_accepts_code_and_chinese_name():
    assert normalize_category("geometry_synthesis") == "geometry_synthesis"
    assert normalize_category(" 几何综合 ") == "geometry_synthesis"
    assert normalize_category("`new_definition`") == "new_definition"
    assert normalize_category("统计与概率") == "stats_probability"
    assert normalize_category("不存在的类") is None
    assert normalize_category(None) is None


def test_normalize_model_accepts_code_and_chinese_name():
    assert normalize_model("geometry_synthesis", "median_doubling") == "median_doubling"
    assert normalize_model("geometry_synthesis", "倍长中线") == "median_doubling"
    assert normalize_model("geometry_synthesis", "") == ""
    assert normalize_model("geometry_synthesis", "手拉手（旋转全等）") == "hand_in_hand"
    assert normalize_model("geometry_synthesis", "切线判定与性质") is None  # 属于圆综


def test_normalize_model_edge_cases():
    # 空模型：合法值 ""（strip 后为空即视为未给模型）
    assert normalize_model("geometry_synthesis", "   ") == ""
    assert normalize_model("geometry_synthesis", "` `") == ""
    # 非法输入：None / 非字符串 / 未知模型 → None
    assert normalize_model("geometry_synthesis", None) is None
    assert normalize_model("geometry_synthesis", 123) is None
    assert normalize_model("geometry_synthesis", ["median_doubling"]) is None
    assert normalize_model("geometry_synthesis", "不存在的模型") is None
    # 反引号包裹的 code 正常归一化
    assert normalize_model("geometry_synthesis", "`median_doubling`") == "median_doubling"
    # 未知大类：即使 code 存在也不匹配
    assert normalize_model("unknown_category", "median_doubling") is None
    assert normalize_model("unknown_category", "倍长中线") is None


def test_taxonomy_block_contains_every_code():
    assert sum(len(v) for v in MODEL_NAMES.values()) == 37
    for cat in CATEGORY_ORDER:
        assert set(MODEL_NAMES[cat]) == EXPECTED_MODEL_CODES[cat]
    block = build_taxonomy_block()
    for cat in CATEGORY_ORDER:
        assert cat in block
        for model in MODEL_NAMES[cat]:
            assert model in block
    # 中文名同样要出现在枚举块里（防止 code 在、名字错/缺）
    for name in ("倍长中线", "切线判定与性质", "胡不归", "根与系数关系", "方差", "方程建模"):
        assert name in block
    assert "模型驱动" in block


def test_system_prompt_contains_rules_and_taxonomy():
    prompt = build_system_prompt("规则：只输出 JSON")
    assert prompt.startswith("规则：只输出 JSON")
    assert "median_doubling" in prompt
    assert "倍长中线" in prompt
