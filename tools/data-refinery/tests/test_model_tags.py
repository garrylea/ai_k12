# -*- coding: utf-8 -*-
"""model_tags 纯函数测试（LLM/DB 不参与）。"""

import base64
import json
import random

import model_tags
from model_tags import (
    CATEGORY_NAMES,
    CATEGORY_ORDER,
    LOW_CONFIDENCE,
    MAX_IMAGES,
    MODEL_DRIVEN,
    MODEL_NAMES,
    Tag,
    build_review_rows,
    build_system_prompt,
    build_taxonomy_block,
    build_user_prompt,
    collect_image_data_urls,
    compute_flags,
    encode_image_data_url,
    extract_image_refs,
    normalize_base_url,
    normalize_category,
    normalize_model,
    pick_review_sample,
    resolve_image_path,
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


def test_normalize_base_url():
    assert normalize_base_url("https://x/compatible-mode/") == "https://x/compatible-mode/v1"
    assert normalize_base_url("https://x/v1") == "https://x/v1"
    assert normalize_base_url("http://192.168.1.8:12345") == "http://192.168.1.8:12345/v1"


def test_extract_image_refs_content_and_options():
    content = "如图 ![](questions/math/a/1/stem_01.jpg) 和 <img src='questions/math/a/1/stem_02.png'>"
    options = '[{"label":"A","text":"","image_url":"questions/math/a/1/opt_a.jpg"}]'
    refs = extract_image_refs(content, options)
    assert refs == [
        "questions/math/a/1/stem_01.jpg",
        "questions/math/a/1/stem_02.png",
        "questions/math/a/1/opt_a.jpg",
    ]


def test_extract_image_refs_options_non_json_fallback():
    options = 'A. ![](questions/math/a/1/opt_a.jpg) B. 文本'
    assert extract_image_refs("", options) == ["questions/math/a/1/opt_a.jpg"]


def test_resolve_image_path_rejects_traversal(tmp_path):
    assets = tmp_path / "assets"
    (assets / "questions").mkdir(parents=True)
    (assets / "questions" / "ok.jpg").write_bytes(b"x")
    assert resolve_image_path("questions/ok.jpg", assets) == (assets / "questions" / "ok.jpg")
    assert resolve_image_path("../../etc/passwd", assets) is None
    assert resolve_image_path("https://evil/x.jpg", assets) is None


def test_resolve_image_path_query_leading_slash_and_schemes(tmp_path):
    assets = tmp_path / "assets"
    (assets / "questions").mkdir(parents=True)
    ok = assets / "questions" / "ok.jpg"
    ok.write_bytes(b"x")
    (assets / "evil").mkdir()
    (assets / "evil" / "x.jpg").write_bytes(b"x")
    # 查询串 / 片段 / 前导斜杠都按相对 assets_root 解析
    assert resolve_image_path("questions/ok.jpg?v=2", assets) == ok
    assert resolve_image_path("questions/ok.jpg#frag", assets) == ok
    assert resolve_image_path("/questions/ok.jpg", assets) == ok
    # 协议大小写不敏感；data: 与协议相对 //host/... 一律拒绝
    assert resolve_image_path("HTTPS://evil/x.jpg", assets) is None
    assert resolve_image_path("Data:image/png;base64,AAA", assets) is None
    assert resolve_image_path("//evil/x.jpg", assets) is None


def test_encode_image_data_url(tmp_path):
    p = tmp_path / "a.png"
    p.write_bytes(b"\x89PNG\r\n\x1a\n")
    url = encode_image_data_url(p)
    assert url.startswith("data:image/png;base64,")
    assert base64.b64decode(url.split(",", 1)[1]) == b"\x89PNG\r\n\x1a\n"


def _decoded(urls: list[str]) -> list[bytes]:
    return [base64.b64decode(u.split(",", 1)[1]) for u in urls]


def test_collect_images_caps_and_missing(tmp_path):
    assets = tmp_path / "assets"
    qdir = assets / "questions" / "q"
    qdir.mkdir(parents=True)
    refs = []
    for i in range(5):
        name = f"s{i}.png"
        (qdir / name).write_bytes(b"x")
        refs.append(f"questions/q/{name}")
    question = {"content": " ".join(f"![]({r})" for r in refs) + " ![](questions/q/none.png)",
                "options": None}
    urls, missing = collect_image_data_urls(question, assets)
    assert len(urls) == MAX_IMAGES
    assert missing is True


def test_collect_images_keeps_ref_order_within_cap(tmp_path):
    assets = tmp_path / "assets"
    qdir = assets / "questions" / "q"
    qdir.mkdir(parents=True)
    refs = []
    for i in range(5):
        name = f"s{i}.png"
        (qdir / name).write_bytes(f"s{i}".encode())
        refs.append(f"questions/q/{name}")
    question = {"content": " ".join(f"![]({r})" for r in refs), "options": None}
    urls, missing = collect_image_data_urls(question, assets)
    assert missing is False
    assert _decoded(urls) == [b"s0", b"s1", b"s2"]


def test_collect_images_query_leading_slash_and_data_refs(tmp_path):
    assets = tmp_path / "assets"
    qdir = assets / "questions" / "q"
    qdir.mkdir(parents=True)
    (qdir / "a.png").write_bytes(b"a")
    (qdir / "b.png").write_bytes(b"b")
    question = {
        "content": "![](questions/q/a.png?v=2) ![](/questions/q/b.png)"
                   " ![](data:image/png;base64,AAA)",
        "options": None,
    }
    urls, missing = collect_image_data_urls(question, assets)
    assert _decoded(urls) == [b"a", b"b"]
    assert missing is True


def test_collect_images_oversized_beyond_cap_marks_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(model_tags, "MAX_IMAGE_BYTES", 4)
    assets = tmp_path / "assets"
    qdir = assets / "questions" / "q"
    qdir.mkdir(parents=True)
    for name in ("s0.png", "s1.png", "s2.png"):
        (qdir / name).write_bytes(b"x")
    (qdir / "big.png").write_bytes(b"xxxxx")  # 超出 MAX_IMAGE_BYTES(4)，且在第 4 张
    refs = [f"questions/q/{n}" for n in ("s0.png", "s1.png", "s2.png", "big.png")]
    question = {"content": " ".join(f"![]({r})" for r in refs), "options": None}
    urls, missing = collect_image_data_urls(question, assets)
    assert len(urls) == MAX_IMAGES
    assert missing is True


def test_build_user_prompt_truncates_and_includes_options():
    q = {
        "type": "short_answer", "difficulty": 4,
        "content": "长" * 4000,
        "options": '[{"label":"A","text":"1"},{"label":"B","text":"2"}]',
        "explanation": "解析", "approach": "思路",
    }
    text = build_user_prompt(q)
    assert "题型: short_answer" in text
    assert "难度: 4" in text
    stem = next(line for line in text.splitlines() if line.startswith("题干: "))
    assert len(stem) == len("题干: ") + 3000
    assert "长" * 3001 not in text
    assert "A. 1" in text and "B. 2" in text
    assert "解析: 解析" in text
    assert "思路: 思路" in text


def test_build_user_prompt_section_truncation_boundaries():
    q = {
        "content": "长" * 4000,
        "options": json.dumps(
            [{"label": "A", "text": "选" * 1200}], ensure_ascii=False),
        "explanation": "解" * 1600,
        "approach": "思" * 1600,
    }
    lines = {
        line.split(": ", 1)[0]: line.split(": ", 1)[1]
        for line in build_user_prompt(q).splitlines() if ": " in line
    }
    assert len(lines["题干"]) == 3000
    assert len(lines["选项"]) == 1000
    assert len(lines["解析"]) == 1500
    assert len(lines["思路"]) == 1500


def test_build_user_prompt_omits_missing_type_and_difficulty():
    text = build_user_prompt({"content": "题干"})
    assert "题型:" not in text
    assert "难度:" not in text
    assert "题干: 题干" in text
    # 0 是合法难度，必须照常输出
    assert "难度: 0" in build_user_prompt({"content": "x", "difficulty": 0})


def _row(qid, cat="", model="", conf=0.9, flags=""):
    return {"question_id": qid, "category": cat, "model": model,
            "confidence": conf, "flags": flags}


def test_build_review_rows_no_tag_outputs_one_row():
    q = {"id": 7, "type": "short_answer", "difficulty": 5, "paper_refs": "卷 A"}
    rows = build_review_rows(q, [], ["no_tag_hard"])
    assert len(rows) == 1
    assert rows[0]["question_id"] == 7
    assert rows[0]["category"] == ""
    assert rows[0]["flags"] == "no_tag_hard"


def test_build_review_rows_multi_tags():
    q = {"id": 7, "type": "proof", "difficulty": 4, "paper_refs": None}
    tags = [Tag("geometry_synthesis", "median_doubling", 0.9, "延长"),
            Tag("geometry_synthesis", "hand_in_hand", 0.8, "旋转")]
    rows = build_review_rows(q, tags, ["multi_category"])
    assert len(rows) == 2
    assert rows[0]["category_name"] == "几何综合"
    assert rows[1]["model_name"] == "手拉手（旋转全等）"


def test_build_review_rows_keeps_zero_difficulty():
    q = {"id": 8, "type": "choice", "difficulty": 0}
    rows = build_review_rows(q, [], [])
    assert rows[0]["difficulty"] == 0
    # 缺失难度仍落空串
    assert build_review_rows({"id": 9}, [], [])[0]["difficulty"] == ""


def test_pick_review_sample_prefers_no_tag_hard_and_is_deterministic():
    rows = []
    for i in range(1, 41):
        rows.append(_row(i, "geometry_synthesis", "median_doubling", 0.9))
    rows.append(_row(100, "", "", 0, "no_tag_hard"))
    rows.append(_row(101, "", "", 0, "no_tag_hard"))
    a = pick_review_sample(rows, seed=42, total=30)
    b = pick_review_sample(rows, seed=42, total=30)
    assert a == b
    expected = (
        [(100, "no_tag_hard"), (101, "no_tag_hard")]
        + [(i, "model_driven_fill") for i in range(1, 14)]
        + [(i, "fill") for i in range(14, 29)]
    )
    assert [(r["question_id"], r["pick_reason"]) for r in a] == expected


def test_pick_review_sample_dedupes_questions():
    rows = [_row(1, "geometry_synthesis", "median_doubling", 0.9),
            _row(1, "geometry_synthesis", "hand_in_hand", 0.8)]
    picked = pick_review_sample(rows, total=1)
    assert len(picked) == 1
    # 同一题保留最高置信度的那条标签
    assert picked[0]["model"] == "median_doubling"
    assert float(picked[0]["confidence"]) == 0.9


def test_pick_review_sample_mixed_group_a_and_b():
    rows = [_row(i, "geometry_synthesis", "median_doubling", 0.9)
            for i in range(1, 31)]
    rows += [_row(i, "stats_probability", "variance", 0.85) for i in range(31, 51)]
    picked = pick_review_sample(rows, seed=42, total=30)
    assert len(picked) == 30
    assert len({r["question_id"] for r in picked}) == 30

    group_a = [(r["question_id"], r["pick_reason"]) for r in picked
               if r["pick_reason"] != "random_high_confidence"]
    assert group_a == [(i, "model_driven_fill") for i in range(1, 16)]

    group_b = [r["question_id"] for r in picked
               if r["pick_reason"] == "random_high_confidence"]
    assert group_b == random.Random(42).sample(list(range(31, 51)), 15)


def test_pick_review_sample_all_stats_splits_a_and_b():
    rows = [_row(i, "stats_probability", "variance", 0.85) for i in range(1, 41)]
    picked = pick_review_sample(rows, seed=42, total=30)
    assert len(picked) == 30
    assert len({r["question_id"] for r in picked}) == 30

    a_ids = [r["question_id"] for r in picked
             if r["pick_reason"] == "low_confidence_fill"]
    assert a_ids == list(range(1, 16))

    b_ids = [r["question_id"] for r in picked
             if r["pick_reason"] == "random_high_confidence"]
    assert b_ids == random.Random(42).sample(list(range(16, 41)), 15)


def test_pick_review_sample_total_zero_returns_empty():
    rows = [_row(i, "stats_probability", "variance", 0.85) for i in range(1, 41)]
    assert pick_review_sample(rows, total=0) == []


def test_pick_review_sample_tolerates_unparseable_confidence():
    rows = [_row(1, "stats_probability", "variance", "0.9x"),
            _row(2, "stats_probability", "variance", " "),
            _row(3, "stats_probability", "variance", None),
            _row(1, "stats_probability", "probability_calc", 0.95)]
    picked = pick_review_sample(rows, total=2)
    assert len({r["question_id"] for r in picked}) == 2
    # 同题仍取可解析的高置信度标签
    full = pick_review_sample(rows, total=30)
    row1 = next(r for r in full if r["question_id"] == 1)
    assert row1["model"] == "probability_calc"


def test_pick_review_sample_short_pool_returns_all():
    rows = [_row(i, "stats_probability", "variance", 0.9) for i in range(1, 4)]
    picked = pick_review_sample(rows, total=30)
    assert len(picked) == 3
