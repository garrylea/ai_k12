"""数学题中考模型标签：枚举、归一化、校验、图片、抽样等纯函数。

设计真源：docs/superpowers/specs/2026-11-14-math-model-tags-design.md。
本文件是 category/model code 的唯一真源；prompt 的枚举块由这里生成。
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Any, Iterable

CATEGORY_NAMES: dict[str, str] = {
    "new_definition": "新定义",
    "geometry_synthesis": "几何综合",
    "circle_synthesis": "圆综",
    "extremum": "最值问题",
    "algebra_synthesis": "代数综合",
    "function_graph": "函数与图象",
    "stats_probability": "统计与概率",
    "application": "实际应用",
}

CATEGORY_ORDER: list[str] = list(CATEGORY_NAMES)

MODEL_NAMES: dict[str, dict[str, str]] = {
    "new_definition": {
        "algebra_new_definition": "代数新定义",
        "geometry_new_definition": "几何新定义",
    },
    "geometry_synthesis": {
        "median_doubling": "倍长中线",
        "segment_cut_extend": "截长补短",
        "hand_in_hand": "手拉手（旋转全等）",
        "half_angle": "半角模型",
        "three_equal_angles": "一线三等角",
        "rotation_similarity": "旋转相似",
        "midpoint_model": "中点模型",
        "angle_bisector": "角平分线模型",
        "isosceles_construction": "等腰/等边构造",
        "translation_construction": "平移构造",
        "axisymmetry_construction": "轴对称构造",
        "area_method": "面积法",
    },
    "circle_synthesis": {
        "tangent": "切线判定与性质",
        "perpendicular_chord": "垂径定理",
        "inscribed_angle": "圆周角与圆内接四边形",
        "similarity_trig": "相似与三角函数",
    },
    "extremum": {
        "point_circle_extremum": "点圆最值",
        "general_drinking_horse": "将军饮马（轴对称最值）",
        "apollonius_circle": "阿氏圆",
        "hu_bu_gui": "胡不归",
        "guadou_principle": "瓜豆原理",
        "hidden_circle": "隐圆（定弦定角/四点共圆）",
    },
    "algebra_synthesis": {
        "quadratic_equation": "二次函数与方程",
        "parameter_discussion": "含参讨论",
        "vieta": "根与系数关系",
    },
    "function_graph": {
        "basic_graphs": "一次/反比例/二次图象",
        "graph_transform": "图象变换",
        "graph_inequality": "图象与不等式",
    },
    "stats_probability": {
        "data_representatives": "数据代表数",
        "variance": "方差",
        "probability_calc": "概率计算",
        "statistical_charts": "统计图表",
    },
    "application": {
        "equation_modeling": "方程建模",
        "inequality_modeling": "不等式建模",
        "function_modeling": "函数建模",
    },
}

MODEL_DRIVEN: set[str] = {"geometry_synthesis", "circle_synthesis", "extremum"}

_CATEGORY_BY_NAME = {name: code for code, name in CATEGORY_NAMES.items()}
_MODEL_BY_NAME = {
    cat: {name: code for code, name in models.items()}
    for cat, models in MODEL_NAMES.items()
}


def normalize_category(raw: object) -> str | None:
    if not isinstance(raw, str):
        return None
    key = raw.strip().strip("`").strip()
    if key in CATEGORY_NAMES:
        return key
    return _CATEGORY_BY_NAME.get(key)


def normalize_model(category: str, raw: object) -> str | None:
    """归一化模型 code：空模型返回 ""；非法/未知（含跨类）返回 None。"""
    if raw is None:
        return None
    if not isinstance(raw, str):
        return None
    key = raw.strip().strip("`").strip()
    if not key:
        return ""
    models = MODEL_NAMES.get(category, {})
    if key in models:
        return key
    return _MODEL_BY_NAME.get(category, {}).get(key)


def build_taxonomy_block() -> str:
    lines = [
        "【大类与模型（必须从中选，禁止自造 code）】",
        "格式：category_code（中文名）：model_code（中文名）、……",
    ]
    for cat in CATEGORY_ORDER:
        models = "；".join(
            f"{code}（{name}）" for code, name in MODEL_NAMES[cat].items()
        )
        lines.append(f"- {cat}（{CATEGORY_NAMES[cat]}）：{models}")
    lines.append("")
    lines.append(
        "几何综合 / 圆综 / 最值问题是模型驱动类，必须给出具体 model；"
        "其他大类没有合适模型时 model 用空字符串。"
    )
    return "\n".join(lines)


def build_system_prompt(rules: str) -> str:
    return f"{rules.strip()}\n\n{build_taxonomy_block()}"


MAX_CATEGORIES = 2
MAX_MODELS = 3
LOW_CONFIDENCE = 0.70


@dataclass(frozen=True)
class Tag:
    category: str
    model: str
    confidence: float
    reason: str


@dataclass
class ValidationResult:
    tags: list[Tag]
    flags: list[str]
    dropped: int


def _to_confidence(raw: Any) -> float:
    if isinstance(raw, bool) or not isinstance(raw, (int, float, str)):
        return 0.50
    try:
        val = float(raw)
    except (TypeError, ValueError):
        return 0.50
    if val != val:  # NaN
        return 0.50
    return round(min(1.0, max(0.0, val)), 2)


def _sort_key(tag: Tag) -> tuple:
    models = list(MODEL_NAMES.get(tag.category, {}))
    model_idx = models.index(tag.model) if tag.model in models else -1
    return (-tag.confidence, CATEGORY_ORDER.index(tag.category), model_idx)


def _known_model_anywhere(raw: object) -> bool:
    """判断这个 model 值是否属于别的某个大类（用于区分 mismatch 与纯未知）。"""
    if not isinstance(raw, str):
        return False
    key = raw.strip().strip("`").strip()
    if not key:
        return False
    for models in MODEL_NAMES.values():
        if key in models:
            return True
    for names in _MODEL_BY_NAME.values():
        if key in names:
            return True
    return False


def validate_tags(raw_tags: Any) -> ValidationResult:
    """LLM 原始 tags -> 合法、去重、清理空模型、截上限后的 Tag 列表。"""
    if not isinstance(raw_tags, list):
        return ValidationResult([], [], 0)

    flags: set[str] = set()
    dropped = 0
    merged: dict[tuple[str, str], Tag] = {}

    for raw in raw_tags:
        if not isinstance(raw, dict):
            dropped += 1
            continue
        category = normalize_category(raw.get("category"))
        if category is None:
            dropped += 1
            continue

        raw_model = raw.get("model", "")
        model = normalize_model(category, raw_model) if raw_model not in (None, "") else ""
        if raw_model not in (None, "") and model is None:
            if category in MODEL_DRIVEN:
                dropped += 1
                continue
            model = ""
            if _known_model_anywhere(raw_model):
                flags.add("category_model_mismatch")
            else:
                flags.add("unknown_model")
        if model is None:
            model = ""
        if category in MODEL_DRIVEN and not model:
            dropped += 1
            continue

        tag = Tag(
            category=category,
            model=model,
            confidence=_to_confidence(raw.get("confidence")),
            reason=str(raw.get("reason") or "")[:255],
        )
        key = (category, model)
        if key not in merged or tag.confidence > merged[key].confidence:
            merged[key] = tag

    cats_with_model = {t.category for t in merged.values() if t.model}
    tags = [
        t for t in merged.values()
        if t.model or t.category not in cats_with_model
    ]

    tags.sort(key=_sort_key)
    tags = tags[:MAX_MODELS]
    cat_best: dict[str, float] = {}
    for tag in tags:
        cat_best[tag.category] = max(cat_best.get(tag.category, 0.0), tag.confidence)
    kept = sorted(cat_best, key=lambda c: (-cat_best[c], CATEGORY_ORDER.index(c)))
    kept_set = set(kept[:MAX_CATEGORIES])
    tags = [t for t in tags if t.category in kept_set]

    return ValidationResult(tags=tags, flags=sorted(flags), dropped=dropped)


def compute_flags(tags: list[Tag], *, difficulty: int, has_evidence: bool,
                  image_missing: bool, extra_flags: Iterable[str] = ()) -> list[str]:
    flags = set(extra_flags)
    if any(t.confidence < LOW_CONFIDENCE for t in tags):
        flags.add("low_confidence")
    if not has_evidence:
        flags.add("no_evidence")
    if image_missing:
        flags.add("image_missing")
    if difficulty >= 4 and not tags:
        flags.add("no_tag_hard")
    if len({t.category for t in tags}) == 2:
        flags.add("multi_category")
    return sorted(flags)
