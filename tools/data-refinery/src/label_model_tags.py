"""数学题中考模型标签：一条命令完成读库 → LLM 打标 → 写库 → 抽检 CSV。

用法：
    cd tools/data-refinery && python3 src/label_model_tags.py

设计：docs/superpowers/specs/2026-11-14-math-model-tags-design.md
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import sys
from base64 import b64encode
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pymysql
from PIL import Image

from config import RefineryConfig
from llm import create_llm_client
from model_tags import (
    LOW_CONFIDENCE, build_review_rows, build_system_prompt,
    build_user_prompt, collect_image_data_urls, compute_flags,
    extract_image_refs, normalize_base_url, pick_review_sample, validate_tags,
)
from extract import _parse_json_object

SUBJECT_ID = 1
SUPPORTED_PROVIDERS = {"qwen", "local", "kimi", "deepseek", "openai"}
PROMPT_FILE = Path(__file__).parent / "prompts" / "model_tagger" / "math.txt"
REVIEW_DIR = Path(__file__).parent.parent / "output" / "model_tags"
REVIEW_FIELDS = [
    "question_id", "paper_refs", "type", "difficulty",
    "category", "category_name", "model", "model_name",
    "confidence", "reason", "flags",
]


@dataclass(frozen=True)
class ModelConfig:
    provider: str
    model: str
    base_url: str
    api_key: str


@dataclass
class Outcome:
    question: dict
    tags: list
    flags: list[str]
    dropped: int
    image_missing: bool
    error: str = ""
    raw: str = ""


def parse_tags_response(raw: str) -> list[dict] | None:
    # _parse_json_object 在完全无法解析时抛 JSONDecodeError（ValueError 子类），
    # 这里统一降级为 None，交给调用方决定是否重试。
    try:
        data = _parse_json_object(raw)
    except (TypeError, ValueError):
        return None
    # 合法 JSON 未必是对象（"5" -> int、'"tags"' -> str、'[]' -> list），
    # 非 dict 直接判失败，避免 `in` / 下标访问抛 TypeError。
    if not isinstance(data, dict) or not data:
        return None
    if "tags" not in data:
        return None
    tags = data["tags"]
    if not isinstance(tags, list):
        return None
    return [t for t in tags if isinstance(t, dict)]


def load_model_config(conn, model_key: str) -> ModelConfig:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT provider_type, model_id, base_url, api_key "
            "FROM llm_models WHERE model_key=%s AND is_enabled=1",
            (model_key,),
        )
        row = cur.fetchone()
    if not row:
        raise SystemExit(f"[error] llm_models 没有启用的 model_key={model_key!r}")
    provider, model, base_url, api_key = row
    if provider not in SUPPORTED_PROVIDERS:
        raise SystemExit(
            f"[error] 打标暂只支持 OpenAI 兼容 provider {sorted(SUPPORTED_PROVIDERS)}，"
            f"当前 {provider!r}；请用 --model-key qwen3.8-max"
        )
    return ModelConfig(provider, model, normalize_base_url(base_url), api_key)


def load_questions(conn, limit: int | None, question_ids: list[int] | None) -> list[dict]:
    where = [
        "q.subject_id=%s",
        "q.is_active=1",
        "(q.grade_band='junior' OR q.grade_band IS NULL)",
    ]
    params: list[Any] = [SUBJECT_ID]
    if question_ids:
        where.append(f"q.id IN ({','.join(['%s'] * len(question_ids))})")
        params.extend(question_ids)
    sql = f"""
        SELECT q.id, q.type, q.difficulty, q.grade_band,
               q.content, q.options, q.material_text, q.explanation, q.approach,
               GROUP_CONCAT(DISTINCT CONCAT(ep.title, ' 第', pq.question_no, '题')
                            ORDER BY ep.title SEPARATOR ' | ') AS paper_refs
        FROM questions q
        LEFT JOIN paper_questions pq ON pq.question_id = q.id
        LEFT JOIN exam_papers ep ON ep.id = pq.paper_id
        WHERE {' AND '.join(where)}
        GROUP BY q.id
        ORDER BY q.id
    """
    with conn.cursor() as cur:
        cur.execute(sql, params)
        cols = [d[0] for d in cur.description]
        rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    assert all(r["grade_band"] in (None, "junior") for r in rows), "年级守卫失败"
    if limit is not None:
        rows = rows[:limit]
    return rows


def _has_evidence(question: dict) -> bool:
    """只有图、解析或思路算证据；纯文字题干不算（对应 spec 的 55 道无证据题）。"""
    return bool(
        extract_image_refs(question.get("content"), question.get("options"))
        or (question.get("explanation") or "").strip()
        or (question.get("approach") or "").strip()
    )


def _red_png_data_url() -> str:
    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (255, 0, 0)).save(buf, format="PNG")
    return "data:image/png;base64," + b64encode(buf.getvalue()).decode("ascii")


def preflight(llm: Any, with_images: bool) -> None:
    try:
        resp = llm.complete("你是助手。", "回复 ok")
    except Exception as e:
        raise SystemExit(f"[error] LLM 预检失败：{e}（检查网络 / VPN / Key）") from e
    if "ok" not in (resp.content or "").lower():
        raise SystemExit(f"[error] LLM 预检返回异常：{resp.content!r}")
    if not with_images:
        return
    try:
        resp = llm.complete_with_images(
            "你是图片识别助手。", "这张图是什么颜色？只回答颜色。",
            [_red_png_data_url()],
        )
    except Exception as e:
        raise SystemExit(f"[error] 多模态预检失败：{e}（模型不支持图片？）") from e
    text = (resp.content or "").lower()
    if not any(k in text for k in ("红", "red", "255")):
        raise SystemExit(f"[error] 多模态预检失败：模型没识别出红色（{resp.content!r}）")


def label_one(question: dict, llm: Any, system_prompt: str,
              assets_root: Path, with_images: bool) -> Outcome:
    image_urls: list[str] = []
    image_missing = False
    raw = ""
    try:
        if with_images:
            image_urls, image_missing = collect_image_data_urls(question, assets_root)
        user_prompt = build_user_prompt(question)

        def call(text: str) -> str:
            if image_urls:
                return llm.complete_with_images(system_prompt, text, image_urls).content
            return llm.complete(system_prompt, text).content

        raw = call(user_prompt)
        parsed = parse_tags_response(raw)
        if parsed is None:
            raw = call(user_prompt + "\n\n上次输出无法解析。只输出 JSON，不要解释。")
            parsed = parse_tags_response(raw)
        if parsed is None:
            return Outcome(question, [], [], 0, image_missing,
                           error="parse_failed", raw=(raw or "")[:1000])
    except Exception as e:
        return Outcome(question, [], [], 0, image_missing, error=str(e),
                       raw=raw[:1000])

    result = validate_tags(parsed)
    flags = compute_flags(
        result.tags,
        difficulty=int(question.get("difficulty") or 0),
        has_evidence=_has_evidence(question),
        image_missing=image_missing,
        extra_flags=result.flags,
    )
    return Outcome(question, result.tags, flags, result.dropped, image_missing,
                   raw=(raw or "")[:1000])


def write_tags(conn, question_id: int, tags: list) -> None:
    from model_tags import CATEGORY_NAMES, MODEL_NAMES
    conn.begin()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM question_model_tags "
                "WHERE question_id=%s AND source='llm'",
                (question_id,),
            )
            if tags:
                cur.executemany(
                    "INSERT IGNORE INTO question_model_tags "
                    "(question_id, category, category_name, model, model_name, "
                    " confidence, reason, source) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,'llm')",
                    [
                        (question_id, t.category, CATEGORY_NAMES[t.category],
                         t.model, MODEL_NAMES[t.category].get(t.model, ""),
                         t.confidence, t.reason)
                        for t in tags
                    ],
                )
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def write_csv(path: Path, rows: list[dict], fields: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description="数学题中考模型标签")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--question-id", type=int, action="append", default=None)
    parser.add_argument("--model-key", default="qwen3.8-max")
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--no-images", action="store_true")
    args = parser.parse_args()
    if args.limit is not None and args.limit < 1:
        parser.error("--limit 必须 >= 1")
    if args.concurrency < 1:
        parser.error("--concurrency 必须 >= 1")

    cfg = RefineryConfig.from_env()
    conn = pymysql.connect(
        host=cfg.db_host, port=cfg.db_port, user=cfg.db_user,
        password=cfg.db_pass, database=cfg.db_name, charset="utf8mb4",
    )
    try:
        model_cfg = load_model_config(conn, args.model_key)
        # 先查题再预检：空集合直接返回，不建客户端、不发任何网络请求。
        questions = load_questions(conn, args.limit, args.question_id)
        if not questions:
            print("[done] 没有需要标注的题", flush=True)
            if args.question_id:
                requested = ",".join(str(qid) for qid in args.question_id)
                print(f"[warn] --question-id {requested} 没有匹配到可标注的题"
                      f"（不存在 / 非数学 / 已停用 / 非初中），请核对题号", flush=True)
            return 0

        llm = create_llm_client(
            provider=model_cfg.provider, api_key=model_cfg.api_key,
            model=model_cfg.model, base_url=model_cfg.base_url,
            timeout=120, max_tokens=512, max_retries=2,
            thinking=False, enable_cache=False,
        )
        with_images = not args.no_images
        preflight(llm, with_images)

        try:
            prompt_rules = PROMPT_FILE.read_text(encoding="utf-8")
        except OSError as e:
            raise SystemExit(f"[error] 找不到 prompt 文件 {PROMPT_FILE}：{e}") from e
        system_prompt = build_system_prompt(prompt_rules)
        assets_root = cfg.output_dir / "assets"
        print(f"[start] 待标注 {len(questions)} 题，模型 {args.model_key}，"
              f"图片 {'on' if with_images else 'off'}，并发 {args.concurrency}",
              flush=True)

        outcomes: list[Outcome] = []
        failed: list[Outcome] = []
        with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
            futures = {
                pool.submit(label_one, q, llm, system_prompt, assets_root, with_images): q
                for q in questions
            }
            for i, fut in enumerate(as_completed(futures), 1):
                question = futures[fut]
                try:
                    outcome = fut.result()
                except Exception as e:
                    outcome = Outcome(question, [], [], 0, False, error=str(e))
                outcomes.append(outcome)
                if outcome.error:
                    failed.append(outcome)
                else:
                    try:
                        write_tags(conn, outcome.question["id"], outcome.tags)
                    except Exception as e:
                        outcome.error = f"db_write_failed: {e}"
                        # 事务已回滚，标签没进库；抽检 CSV 不能显示一份未落库的结果。
                        outcome.tags = []
                        failed.append(outcome)
                if i % 20 == 0 or i == len(futures):
                    print(f"[progress] {i}/{len(futures)} "
                          f"failed={len(failed)}", flush=True)

        for outcome in outcomes:
            if outcome.error and "failed" not in outcome.flags:
                outcome.flags = sorted([*outcome.flags, "failed"])

        rows: list[dict] = []
        for outcome in outcomes:
            rows.extend(build_review_rows(
                outcome.question, outcome.tags, outcome.flags))
        # 稳定排序：只按题号，保留 build_review_rows 的「置信度降序」标签顺序（spec §6.8）。
        rows.sort(key=lambda r: r["question_id"])
        REVIEW_DIR.mkdir(parents=True, exist_ok=True)
        write_csv(REVIEW_DIR / "review.csv", rows, REVIEW_FIELDS)
        sample = pick_review_sample(rows)
        write_csv(REVIEW_DIR / "review_sample.csv", sample,
                  REVIEW_FIELDS + ["pick_reason"])

        failures_path = REVIEW_DIR / "failures.jsonl"
        if failed:
            with failures_path.open("w", encoding="utf-8") as f:
                for outcome in failed:
                    f.write(json.dumps({
                        "question_id": outcome.question["id"],
                        "error": outcome.error,
                        "raw": outcome.raw,
                    }, ensure_ascii=False) + "\n")
        elif failures_path.exists():
            # 全绿重跑要清掉上一轮的失败清单，否则会被误读成本轮仍有失败。
            failures_path.unlink()

        tagged = sum(1 for o in outcomes if o.tags)
        tag_rows = sum(len(o.tags) for o in outcomes)
        low_conf = sum(1 for o in outcomes
                       if any(t.confidence < LOW_CONFIDENCE for t in o.tags))
        dropped = sum(o.dropped for o in outcomes)
        cat_counts: dict[str, int] = {}
        for outcome in outcomes:
            for tag in outcome.tags:
                cat_counts[tag.category] = cat_counts.get(tag.category, 0) + 1
        by_category = " ".join(
            f"{cat}={cat_counts[cat]}" for cat in sorted(cat_counts)) or "-"
        print(f"[done] total={len(outcomes)} tagged_questions={tagged} "
              f"tag_rows={tag_rows} empty={len(outcomes) - tagged} "
              f"low_confidence={low_conf} dropped={dropped} "
              f"failed={len(failed)}", flush=True)
        print(f"[by_category] {by_category}", flush=True)
        print(f"[csv] {REVIEW_DIR / 'review.csv'}", flush=True)
        print(f"[csv] {REVIEW_DIR / 'review_sample.csv'}", flush=True)
        if failed:
            failed_ids = ",".join(
                str(o.question["id"]) for o in sorted(
                    failed, key=lambda o: o.question["id"]))
            print(f"[failed_ids] {failed_ids}", flush=True)
            print(f"[fail] {len(failed)} 题失败，详情见 "
                  f"{failures_path}；重跑同一命令即可补齐",
                  flush=True)
            return 1
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
