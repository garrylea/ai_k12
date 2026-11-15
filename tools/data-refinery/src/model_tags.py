"""数学题中考模型标签：枚举、归一化、校验、图片、抽样等纯函数。

设计真源：docs/superpowers/specs/2026-11-14-math-model-tags-design.md。
本文件是 category/model code 的唯一真源；prompt 的枚举块由这里生成。
"""

from __future__ import annotations

import base64
import json
import mimetypes
import os
import random
import re
from dataclasses import dataclass
from pathlib import Path
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
        "coordinate_new_definition": "坐标新定义",
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
    # 只统计校验阶段丢弃的原始条目（非法结构 / 未知大类 / 未知或缺失的模型驱动模型 /
    # 非列表入参），**不包含** MAX_MODELS / MAX_CATEGORIES 上限裁剪掉的行。
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
    """LLM 原始 tags -> 合法、去重、清理空模型、截上限后的 Tag 列表。

    ``dropped`` 只统计校验阶段丢弃的条目（含非列表入参记为 1），
    截断到 MAX_MODELS / MAX_CATEGORIES 时被上限挤掉的行**不计入**，
    因此 ``len(raw_tags) - dropped`` 可能大于最终 ``len(tags)``。
    """
    if not isinstance(raw_tags, list):
        return ValidationResult([], [], 1)

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


MAX_IMAGES = 3
MAX_IMAGE_BYTES = 6 * 1024 * 1024

_MD_IMAGE_RE = re.compile(r"!\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
_HTML_IMAGE_RE = re.compile(
    r"""<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']""", re.IGNORECASE
)
_EXT_MIME = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif",
}


def normalize_base_url(url: str) -> str:
    base = (url or "").strip().rstrip("/")
    if not base:
        return base
    return base if base.endswith("/v1") else base + "/v1"


def _loads_json(raw: Any) -> Any:
    if isinstance(raw, (list, dict)):
        return raw
    if not isinstance(raw, (str, bytes)):
        return None
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return None


def _options_text(raw: Any) -> str:
    data = _loads_json(raw)
    if isinstance(data, list):
        parts = []
        for opt in data:
            if not isinstance(opt, dict):
                continue
            label = str(opt.get("label") or "").strip()
            text = str(opt.get("text") or "").strip()
            if text:
                parts.append(f"{label}. {text}" if label else text)
        if parts:
            return " ".join(parts)
    return str(raw or "")


def extract_image_refs(content: str | None, options_raw: Any) -> list[str]:
    texts = [content or "", _options_text(options_raw)]
    refs: list[str] = []
    for text in texts:
        refs.extend(_MD_IMAGE_RE.findall(text))
        refs.extend(_HTML_IMAGE_RE.findall(text))
    data = _loads_json(options_raw)
    if isinstance(data, list):
        for opt in data:
            if isinstance(opt, dict) and opt.get("image_url"):
                refs.append(str(opt["image_url"]))
    seen: set[str] = set()
    out: list[str] = []
    for ref in refs:
        ref = ref.strip()
        if ref and ref not in seen:
            seen.add(ref)
            out.append(ref)
    return out


def resolve_image_path(ref: str, assets_root: Path) -> Path | None:
    ref = (ref or "").strip()
    if not ref or ref.lower().startswith(("http://", "https://", "data:", "//")):
        return None
    ref = ref.split("?", 1)[0].split("#", 1)[0].lstrip("/")
    root = assets_root.resolve()
    path = (root / ref).resolve()
    try:
        path.relative_to(root)
    except ValueError:
        return None
    return path if path.is_file() else None


def encode_image_data_url(path: Path) -> str | None:
    try:
        if path.stat().st_size > MAX_IMAGE_BYTES:
            return None
        raw = path.read_bytes()
    except OSError:
        return None
    mime = (_EXT_MIME.get(path.suffix.lower())
            or mimetypes.guess_type(path.name)[0]
            or "application/octet-stream")
    return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"


def collect_image_data_urls(question: dict, assets_root: Path) -> tuple[list[str], bool]:
    refs = extract_image_refs(question.get("content"), question.get("options"))
    urls: list[str] = []
    missing = False
    for ref in refs:
        path = resolve_image_path(ref, assets_root)
        if path is None:
            missing = True
            continue
        # 容量上限只限制「产出」，不掩盖坏文件：超出前 3 张的不可读/超大文件同样算 missing。
        try:
            oversized = path.stat().st_size > MAX_IMAGE_BYTES
        except OSError:
            missing = True
            continue
        if oversized or not os.access(path, os.R_OK):
            missing = True
            continue
        if len(urls) >= MAX_IMAGES:
            continue
        url = encode_image_data_url(path)
        if url is None:
            missing = True
            continue
        urls.append(url)
    return urls, missing


def build_user_prompt(question: dict) -> str:
    parts = ["<question>"]
    qtype = str(question.get("type") or "").strip()
    if qtype:
        parts.append(f"题型: {qtype}")
    difficulty = question.get("difficulty")
    if difficulty is not None:
        parts.append(f"难度: {difficulty}")
    parts.append(f"题干: {(question.get('content') or '')[:3000]}")
    options = _options_text(question.get("options"))
    if options.strip():
        parts.append(f"选项: {options[:1000]}")
    explanation = (question.get("explanation") or "").strip()
    if explanation:
        parts.append(f"解析: {explanation[:1500]}")
    approach = (question.get("approach") or "").strip()
    if approach:
        parts.append(f"思路: {approach[:1500]}")
    parts.append("</question>")
    return "\n".join(parts)


def build_review_rows(question: dict, tags: list[Tag], flags: list[str]) -> list[dict]:
    difficulty = question.get("difficulty")
    base = {
        "question_id": question["id"],
        "paper_refs": question.get("paper_refs") or "",
        "type": question.get("type") or "",
        # 0 是合法难度，只有 None/缺失才落空串
        "difficulty": "" if difficulty is None else difficulty,
        "flags": ";".join(flags),
    }
    if not tags:
        return [{**base, "category": "", "category_name": "", "model": "",
                 "model_name": "", "confidence": "", "reason": ""}]
    return [
        {**base,
         "category": t.category,
         "category_name": CATEGORY_NAMES[t.category],
         "model": t.model,
         "model_name": MODEL_NAMES[t.category].get(t.model, ""),
         "confidence": f"{t.confidence:.2f}",
         "reason": t.reason}
        for t in tags
    ]


def _safe_float(raw: Any) -> float:
    """抽样排序用的容错置信度：非法/NaN 一律 0.0，绝不抛。"""
    if isinstance(raw, bool):
        return 0.0
    try:
        val = float(raw)
    except (TypeError, ValueError):
        return 0.0
    return 0.0 if val != val else val


def _representative_rows(rows: list[dict]) -> list[dict]:
    best: dict[int, dict] = {}
    for row in rows:
        qid = row["question_id"]
        prev = best.get(qid)
        if prev is None:
            best[qid] = row
            continue
        if _safe_float(row.get("confidence")) > _safe_float(prev.get("confidence")):
            best[qid] = row
    return list(best.values())


def _flag_set(row: dict) -> set[str]:
    return {f for f in str(row.get("flags") or "").split(";") if f}


_RISK_FLAGS = ["low_confidence", "no_evidence", "multi_category", "image_missing"]


def _risk_flag(row: dict) -> str | None:
    """按风险优先级返回第一个命中的 flag 名；无风险返回 None。"""
    flags = _flag_set(row)
    for flag in _RISK_FLAGS:
        if flag in flags:
            return flag
    return None


def _risk_rank(row: dict) -> int:
    flag = _risk_flag(row)
    return _RISK_FLAGS.index(flag) if flag else len(_RISK_FLAGS)


def pick_review_sample(rows: list[dict], seed: int = 42, total: int = 30) -> list[dict]:
    """A 组风险抽样 + B 组固定种子随机；一题一行（取最高置信度标签）。"""
    if total <= 0:
        return []
    reps = _representative_rows(rows)
    if len(reps) <= total:
        return [{**r, "pick_reason": "all"} for r in sorted(
            reps, key=lambda x: x["question_id"])]

    picked: list[dict] = []
    picked_ids: set[int] = set()

    def take(row: dict, reason: str) -> None:
        if row["question_id"] in picked_ids:
            return
        picked.append({**row, "pick_reason": reason})
        picked_ids.add(row["question_id"])

    # A 组：先 no_tag_hard（最多 3 条），再模型驱动类风险
    hard = [r for r in sorted(reps, key=lambda x: x["question_id"])
            if "no_tag_hard" in _flag_set(r)][:3]
    for row in hard:
        take(row, "no_tag_hard")
    a_target = total // 2
    model_rows = [r for r in reps
                  if r.get("category") in MODEL_DRIVEN and r["question_id"] not in picked_ids]
    model_rows.sort(key=lambda r: (_risk_rank(r),
                                   _safe_float(r.get("confidence")),
                                   r["question_id"]))
    for row in model_rows:
        if len(picked) >= a_target:
            break
        flag = _risk_flag(row)
        take(row, f"flag:{flag}" if flag else "model_driven_fill")

    # A 组不够：用剩余题按置信度从低到高补
    if len(picked) < a_target:
        rest = sorted((r for r in reps if r["question_id"] not in picked_ids),
                      key=lambda r: (_safe_float(r.get("confidence")), r["question_id"]))
        for row in rest:
            if len(picked) >= a_target:
                break
            take(row, "low_confidence_fill")

    # B 组：其他大类高置信度，固定种子随机
    b_target = total - len(picked)
    b_pool = [r for r in reps
              if r["question_id"] not in picked_ids
              and r.get("category") not in MODEL_DRIVEN
              and _safe_float(r.get("confidence")) >= LOW_CONFIDENCE]
    b_pool.sort(key=lambda r: r["question_id"])
    b_pick = random.Random(seed).sample(b_pool, min(b_target, len(b_pool)))
    for row in b_pick:
        take(row, "random_high_confidence")

    # 仍不够：全库剩余按题号补
    if len(picked) < total:
        rest = sorted((r for r in reps if r["question_id"] not in picked_ids),
                      key=lambda r: r["question_id"])
        for row in rest:
            if len(picked) >= total:
                break
            take(row, "fill")

    return picked[:total]
