# -*- coding: utf-8 -*-
"""model_tags 纯函数测试（LLM/DB 不参与）。"""

from model_tags import (
    CATEGORY_NAMES,
    CATEGORY_ORDER,
    LOW_CONFIDENCE,
    MODEL_DRIVEN,
    MODEL_NAMES,
    Tag,
    build_system_prompt,
    build_taxonomy_block,
    compute_flags,
    normalize_category,
    normalize_model,
    validate_tags,
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


def _raw(cat, model="", conf=0.9, reason="依据"):
    return {"category": cat, "model": model, "confidence": conf, "reason": reason}


def test_unknown_category_dropped():
    result = validate_tags([_raw("不存在的类", "x")])
    assert result.tags == []
    assert result.dropped == 1


def test_model_driven_unknown_model_drops_whole_tag():
    result = validate_tags([_raw("geometry_synthesis", "不存在的模型")])
    assert result.tags == []
    assert result.dropped == 1


def test_non_model_driven_unknown_model_keeps_empty_and_flags():
    result = validate_tags([_raw("stats_probability", "不存在的模型")])
    assert [(t.category, t.model) for t in result.tags] == [("stats_probability", "")]
    assert "unknown_model" in result.flags


def test_model_from_other_category_flags_mismatch():
    result = validate_tags([_raw("stats_probability", "倍长中线")])
    assert [(t.category, t.model) for t in result.tags] == [("stats_probability", "")]
    assert "category_model_mismatch" in result.flags


def test_model_driven_empty_model_drops_whole_tag():
    result = validate_tags([_raw("circle_synthesis", "")])
    assert result.tags == []
    assert result.dropped == 1


def test_empty_model_removed_when_specific_model_exists():
    result = validate_tags([
        _raw("stats_probability", "统计图表", 0.8),
        _raw("stats_probability", "", 0.9),
    ])
    assert [(t.category, t.model) for t in result.tags] == [
        ("stats_probability", "statistical_charts")
    ]


def test_dedupe_keeps_highest_confidence():
    result = validate_tags([
        _raw("geometry_synthesis", "倍长中线", 0.6),
        _raw("geometry_synthesis", "median_doubling", 0.9),
    ])
    assert len(result.tags) == 1
    assert result.tags[0].confidence == 0.9


def test_caps_three_models_and_two_categories():
    result = validate_tags([
        _raw("geometry_synthesis", "倍长中线", 0.99),
        _raw("geometry_synthesis", "截长补短", 0.98),
        _raw("geometry_synthesis", "手拉手（旋转全等）", 0.97),
        _raw("circle_synthesis", "切线判定与性质", 0.60),
        _raw("stats_probability", "方差", 0.50),
    ])
    # 三条最高分同属几何综合 → 模型上限 3、大类上限 2 都命中；
    # 精确断言防止「整类丢失」仍能通过宽松的 len 检查。
    assert [(t.category, t.model) for t in result.tags] == [
        ("geometry_synthesis", "median_doubling"),
        ("geometry_synthesis", "segment_cut_extend"),
        ("geometry_synthesis", "hand_in_hand"),
    ]
    # dropped 只统计校验阶段丢弃（非法/未知/模型驱动缺模型），不含上限裁剪
    assert result.dropped == 0


def test_caps_empty_model_rows_occupy_slots():
    result = validate_tags([
        _raw("function_graph", "", 0.80),
        _raw("application", "", 0.70),
        _raw("stats_probability", "", 0.60),
        _raw("new_definition", "algebra_new_definition", 0.50),
    ])
    # 前 3 名是三条空模型行；大类再截到 2 → 只留 function_graph / application。
    # 空模型行占名额后，带具体模型的新定义行被上限挤掉。
    assert [(t.category, t.model) for t in result.tags] == [
        ("function_graph", ""),
        ("application", ""),
    ]
    # 上限挤掉的行不计入 dropped（dropped 是 pre-cap 口径）
    assert result.dropped == 0


def test_non_list_raw_tags_counts_as_dropped():
    for bad in (None, {"category": "geometry_synthesis"}, "not-a-list"):
        result = validate_tags(bad)
        assert result.tags == []
        assert result.flags == []
        assert result.dropped == 1


def test_bool_confidence_falls_back_to_default():
    result = validate_tags([_raw("geometry_synthesis", "倍长中线", True)])
    assert result.tags[0].confidence == 0.50


def test_nan_confidence_falls_back_to_default():
    result = validate_tags([_raw("geometry_synthesis", "倍长中线", float("nan"))])
    assert result.tags[0].confidence == 0.50


def test_model_driven_none_model_drops_whole_tag():
    result = validate_tags([_raw("geometry_synthesis", None)])
    assert result.tags == []
    assert result.dropped == 1


def test_dedupe_tie_keeps_first_input_order():
    result = validate_tags([
        _raw("geometry_synthesis", "median_doubling", 0.9, "第一条"),
        _raw("geometry_synthesis", "倍长中线", 0.9, "第二条"),
    ])
    assert len(result.tags) == 1
    assert result.tags[0].reason == "第一条"


def test_confidence_at_low_threshold_is_not_low_confidence():
    tags = [Tag("geometry_synthesis", "median_doubling", LOW_CONFIDENCE, "")]
    flags = compute_flags(tags, difficulty=2, has_evidence=True, image_missing=False)
    assert "low_confidence" not in flags
    assert flags == []


def test_confidence_clamped_and_missing_defaults():
    result = validate_tags([
        _raw("geometry_synthesis", "倍长中线", 1.7),
        _raw("geometry_synthesis", "截长补短", "bad"),
        _raw("geometry_synthesis", "中点模型", None),
    ])
    by_model = {t.model: t.confidence for t in result.tags}
    assert by_model["median_doubling"] == 1.0
    assert by_model["segment_cut_extend"] == 0.5
    assert by_model["midpoint_model"] == 0.5


def test_compute_flags():
    tags = [Tag("geometry_synthesis", "median_doubling", 0.6, "x")]
    flags = compute_flags(tags, difficulty=5, has_evidence=False,
                          image_missing=True, extra_flags=["unknown_model"])
    assert set(flags) == {"low_confidence", "no_evidence", "image_missing",
                          "unknown_model"}


def test_compute_flags_no_tag_hard_and_multi_category():
    flags = compute_flags([], difficulty=5, has_evidence=True, image_missing=False)
    assert "no_tag_hard" in flags
    two = [Tag("geometry_synthesis", "median_doubling", 0.9, ""),
           Tag("circle_synthesis", "tangent", 0.8, "")]
    assert "multi_category" in compute_flags(
        two, difficulty=3, has_evidence=True, image_missing=False)
