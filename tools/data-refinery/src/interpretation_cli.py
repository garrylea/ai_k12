"""interpretation_cli：语文古诗文「解释（翻译）」专项内容管线。

## 与 dictation_cli 的根本差别

默写管线的正文是**从教材页 MD 里定位切出来的**（爬虫 + MinerU + 版面规则）；
解释管线的正文**不碰教材页**——用的是库里已经校验过的 `chinese_passages.body`，
字词由**用户手工整理**后交进来。所以本 CLI 没有爬取/定位/切片/纠正那一整套，
只剩四步：**解析输入 → 切句与归属 → 出译文 → 自检 → 入库**。

## 用法

    # 1) 解析 + 切句 + 出译文 + 自检，落 JSONL 与过目清单（不写库）
    python src/interpretation_cli.py --extract --input path/to/words.md

    # 2) 人工过目（想删哪篇就从 JSONL 里删掉），再入库（幂等，只更新三列）
    python src/interpretation_cli.py --load --input path/to/words.md

    # 3) 校对闭环：导出可编辑稿 → 改 → 回写（只回写被改过的行）
    python src/interpretation_cli.py --export --input words.md
    python src/interpretation_cli.py --apply  --input words.md

## 为什么 --load 不重跑抽取

与默写一致：`--load` 只吃已落盘的 JSONL。这样**人工过目可以发生在入库之前**——
觉得哪篇不合适，直接从 JSONL 里删掉即可，不必改输入再重跑一遍模型。
（`--all` 才是一条龙。）

## 译文来源（用户 2026-09-16 裁决的混合模式）

输入给了 `sentences` → 用输入的，**不调模型**；没给 → 调模型生成（本地优先、ds flash 兜底）。
两种都会过 `interpretation_check` 的自检。

## 输入格式

见 `interpretation_input` 的模块文档（JSON/JSONL 或 Markdown，字段名中英文都认）。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pymysql

from config import RefineryConfig
from extract_cli import _load_prompt
from interpretation_check import check_passage
from interpretation_input import PassageInput, dedupe_passages, load_input
from interpretation_split import attribute_terms, split_sentences
from interpretation_translate import translate_passage
from llm import create_llm_client

SUBJECT_DIR = "语文"

#: 过目清单里每篇最多列几个字词样例
SAMPLE_TERMS = 5


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="语文古诗文解释（翻译）专项内容管线",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python src/interpretation_cli.py --extract --input data/interpretation/九上.md
  python src/interpretation_cli.py --load    --input data/interpretation/九上.md
  python src/interpretation_cli.py --all     --input data/interpretation/九上.md
  python src/interpretation_cli.py --export  --input data/interpretation/九上.md
  python src/interpretation_cli.py --apply   --input data/interpretation/九上.md
        """,
    )
    parser.add_argument("--input", required=True, help="字词输入文件（.md / .json / .jsonl）")
    parser.add_argument("--output-dir", help="产物根目录（默认 output/interpretation）")
    parser.add_argument("--limit", type=int, help="只处理前 N 篇（打样用）")
    parser.add_argument("--extract", action="store_true", help="解析+切句+出译文+自检，落 JSONL 与过目清单")
    parser.add_argument("--load", action="store_true", help="把 JSONL 入库（幂等，只更新内容三列）")
    parser.add_argument("--all", action="store_true", help="等价于 --extract --load")
    parser.add_argument("--export", action="store_true", help="导出可编辑校对稿 JSONL")
    parser.add_argument("--apply", action="store_true", help="把校对稿回写（只写被改过的行）")
    return parser.parse_args(argv)


# ==================== 产物路径 ====================


def _out_root(args, config) -> Path:
    return Path(args.output_dir) if args.output_dir else config.output_dir / "interpretation"


def _stem(args) -> str:
    return Path(args.input).stem


def _jsonl_path(args, config) -> Path:
    return _out_root(args, config) / SUBJECT_DIR / f"{_stem(args)}.jsonl"


def _review_path(args, config) -> Path:
    return _out_root(args, config) / SUBJECT_DIR / f"{_stem(args)}-review.md"


# ==================== 数据库读取（只读正文与状态列） ====================


def _connect(config: RefineryConfig):
    return pymysql.connect(host=config.db_host, port=config.db_port, user=config.db_user,
                           password=config.db_pass, database=config.db_name, charset="utf8mb4")


def _find_rows(conn, work_title: str, semester: str | None) -> list[tuple]:
    """定位目标行 → [(id, semester, body, source_ref)]。册次给了就精确到册。"""
    with conn.cursor() as cur:
        if semester:
            cur.execute(
                "SELECT id, semester, body, source_ref FROM chinese_passages "
                "WHERE work_title=%s AND semester=%s ORDER BY id",
                (work_title, semester),
            )
        else:
            cur.execute(
                "SELECT id, semester, body, source_ref FROM chinese_passages "
                "WHERE work_title=%s ORDER BY id",
                (work_title,),
            )
        return list(cur.fetchall())


def _near_titles(conn, work_title: str, limit: int = 5) -> list[str]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT DISTINCT work_title FROM chinese_passages WHERE work_title LIKE %s LIMIT %s",
            (f"%{work_title[:2]}%", limit),
        )
        return [r[0] for r in cur.fetchall()]


# ==================== 单篇处理 ====================


def _resolve_sentences(p: PassageInput, body: str) -> tuple[list[str], list[str] | None, list[str]]:
    """→ (句子文本, 输入给的译文或 None, 告警)。

    输入给了 `sentences` 且**每句都带原文** → 以**输入的切法**为准（用户可能有意按自己的
    断句方式切）；否则用程序切句，输入里的译文按位置对齐（条数不符则丢掉重生成）。
    """
    warnings: list[str] = []
    provided = p.sentences

    if provided and all(s.text.strip() for s in provided):
        return [s.text for s in provided], [s.translation for s in provided], warnings

    sentences = split_sentences(body)
    if provided:
        if all(s.text.strip() for s in provided):
            pass
        elif len(provided) == len(sentences):
            warnings.append("输入给了译文但没给逐句原文，按程序切句的位置对齐采用")
            return sentences, [s.translation for s in provided], warnings
        else:
            warnings.append(
                f"输入给了 {len(provided)} 条译文但程序切成 {len(sentences)} 句，条数不符，译文改为模型生成"
            )
    return sentences, None, warnings


def process_passage(
    conn,
    p: PassageInput,
    *,
    primary_llm,
    fallback_llm,
    translate_prompt: str,
    skip_translation: bool = False,
) -> tuple[list[dict], list[str], list[str]]:
    """处理一篇 → (入库项列表, 致命错误列表, 告警列表)。

    一篇可能命中多行（未给册次且九上/九下都收了同一篇）——那就**每行各出一项**，
    因为两册的正文可能不一致，切句与字词归属都得按各自正文来。
    """
    items: list[dict] = []
    errors: list[str] = []
    warnings: list[str] = []

    rows = _find_rows(conn, p.work_title, p.semester)
    if not rows:
        near = "、".join(_near_titles(conn, p.work_title)) or "（无相近篇名）"
        errors.append(f"《{p.work_title}》{p.semester or ''} 在库里找不到；相近篇名：{near}")
        return items, errors, warnings

    if len(rows) > 1:
        warnings.append(
            f"《{p.work_title}》未给册次且匹配到 {len(rows)} 行（九上/九下重复收录），逐行分别处理"
        )

    for row_id, row_semester, body, source_ref in rows:
        prefix = f"《{p.work_title}》{row_semester}"
        if source_ref == "DEV-FIXTURE":
            warnings.append(f"{prefix} 原为 DEV-FIXTURE（开发假数据），将由真实内容覆盖")

        sentence_texts, given_translations, w = _resolve_sentences(p, body)
        warnings.extend(f"{prefix} {x}" for x in w)

        attr = attribute_terms(sentence_texts, p.key_terms)
        for term in attr.dropped_terms:
            warnings.append(f"{prefix} 丢弃字词「{term}」：在正文里定位不到（挂不到句子，学生没处填）")

        translations = given_translations
        full_translation = None
        if given_translations is not None:
            # 输入给了译文：整篇译文用输入的（不给整篇就由逐句拼一个兜底）
            full_translation = "".join(t for t in given_translations if t)
        elif not skip_translation:
            result = translate_passage(
                primary_llm, fallback_llm,
                work_title=p.work_title,
                sentences=sentence_texts,
                key_terms=attr.key_terms,
                prompt=translate_prompt,
            )
            if result.translations is None:
                errors.append(f"{prefix} 译文生成失败：{result.error}（{'；'.join(result.attempts)}）")
                continue
            translations = result.translations
            full_translation = result.full_translation
            warnings.append(f"{prefix} 译文来自 {result.source}")

        translations = translations or [""] * len(sentence_texts)

        check = check_passage(
            body=body,
            sentences=sentence_texts,
            translations=translations,
            key_terms=attr.key_terms,
            full_translation=full_translation,
            require_translation=not skip_translation or given_translations is not None,
        )
        if not check.ok:
            errors.extend(f"{prefix} {e}" for e in check.errors)
            continue
        warnings.extend(f"{prefix} {x}" for x in check.warnings)

        items.append({
            "work_title": p.work_title,
            "semester": row_semester,
            "key_terms": attr.key_terms,
            "sentences": [
                {"text": t, "translation": tr}
                for t, tr in zip(sentence_texts, translations)
            ],
            "full_translation": full_translation,
            "_passage_id": row_id,
            "_source_ref": source_ref,
        })

    return items, errors, warnings


# ==================== 过目清单 ====================


def render_review(items: list[dict], errors: list[str], warnings: list[str]) -> str:
    lines = ["# 古诗文解释专项 · 过目清单", ""]
    lines.append(f"- 通过并落盘：**{len(items)}** 篇")
    lines.append(f"- 未通过：**{len(errors)}** 条")
    lines.append(f"- 告警：**{len(warnings)}** 条")
    lines.append("")

    lines.append("## 通过")
    lines.append("")
    for it in items:
        terms = it["key_terms"]
        lines.append(
            f"### 《{it['work_title']}》（{it['semester']}，id={it['_passage_id']}）"
        )
        lines.append("")
        lines.append(
            f"- 句数：{len(it['sentences'])}｜重点字词：{len(terms)}｜"
            f"正文字数：{sum(len(s['text']) for s in it['sentences'])}"
        )
        if terms:
            sample = "、".join(f"{t['term']}（第{t['sentenceIndex']}句）" for t in terms[:SAMPLE_TERMS])
            more = f" 等 {len(terms)} 个" if len(terms) > SAMPLE_TERMS else ""
            lines.append(f"- 字词样例：{sample}{more}")
        else:
            lines.append("- 字词样例：（无，只有逐句翻译）")
        lines.append(f"- 首句原文：{it['sentences'][0]['text']}")
        lines.append(f"- 首句译文：{it['sentences'][0]['translation']}")
        lines.append(f"- 整篇译文：{it['full_translation']}")
        lines.append("")

    if errors:
        lines.append("## 未通过（不入库，需人工处理）")
        lines.append("")
        for e in errors:
            lines.append(f"- {e}")
        lines.append("")

    if warnings:
        lines.append("## 告警（照常入库，但请看一眼）")
        lines.append("")
        for w in warnings:
            lines.append(f"- {w}")
        lines.append("")

    return "\n".join(lines)


# ==================== 各动作 ====================


def run_extract(args, config) -> int:
    res = load_input(args.input)
    res = dedupe_passages(res)
    for w in res.warnings:
        print(f"[WARN] {w}", flush=True)

    passages = res.passages[: args.limit] if args.limit else res.passages
    if not passages:
        print(f"[ERROR] 输入里没有解析出任何篇目：{args.input}", flush=True)
        return 1
    print(f"[ok] 输入解析出 {len(passages)} 篇", flush=True)

    prompt = _load_prompt("interpretation_translate")
    primary = create_llm_client(
        provider=config.llm_provider, api_key=config.llm_api_key or "",
        auth_token=config.llm_auth_token, model=config.llm_model,
        base_url=config.llm_base_url, timeout=config.llm_timeout,
        max_tokens=config.llm_max_tokens, max_retries=config.llm_max_retries,
        thinking=config.llm_thinking, enable_cache=config.llm_enable_cache,
    )
    fallback = None
    if config.llm_fallback_provider:
        try:
            fallback = create_llm_client(
                provider=config.llm_fallback_provider,
                api_key=config.llm_fallback_api_key or "",
                model=config.llm_fallback_model,
                base_url=config.llm_fallback_base_url,
                timeout=config.llm_timeout,
                max_tokens=config.llm_max_tokens,
                max_retries=config.llm_max_retries,
            )
            print(f"[ok] 兜底模型就绪：{config.llm_fallback_provider} / {config.llm_fallback_model}",
                  flush=True)
        except Exception as e:                            # 兜底不可用不阻断抽取
            print(f"[WARN] 兜底模型初始化失败（{e}），仅用主模型", flush=True)

    conn = _connect(config)
    all_items: list[dict] = []
    all_errors: list[str] = []
    all_warnings: list[str] = []
    try:
        for i, p in enumerate(passages, start=1):
            print(f"[..] ({i}/{len(passages)}) 《{p.work_title}》", flush=True)
            items, errors, warnings = process_passage(
                conn, p,
                primary_llm=primary, fallback_llm=fallback, translate_prompt=prompt,
            )
            all_items.extend(items)
            all_errors.extend(errors)
            all_warnings.extend(warnings)
            for e in errors:
                print(f"[ERROR] {e}", flush=True)
            for w in warnings:
                print(f"[WARN] {w}", flush=True)
    finally:
        conn.close()

    jsonl_path = _jsonl_path(args, config)
    review_path = _review_path(args, config)
    jsonl_path.parent.mkdir(parents=True, exist_ok=True)

    with jsonl_path.open("w", encoding="utf-8") as f:
        for it in all_items:
            f.write(json.dumps(it, ensure_ascii=False) + "\n")
    review_path.write_text(render_review(all_items, all_errors, all_warnings), encoding="utf-8")

    print(f"[ok] 落盘：{jsonl_path}（{len(all_items)} 篇）", flush=True)
    print(f"[ok] 过目清单：{review_path}", flush=True)
    return 0 if all_items else 1


def run_load(args, config) -> int:
    from interpretation_loader import InterpretationLoader

    path = _jsonl_path(args, config)
    if not path.exists():
        print(f"[ERROR] JSONL 不存在：{path}（先跑 --extract）", flush=True)
        return 1
    items = InterpretationLoader.read_jsonl(path)
    if not items:
        print(f"[WARN] {path} 没有可入库的篇目", flush=True)
        return 1

    loader = InterpretationLoader(config.db_host, config.db_port, config.db_user,
                                  config.db_pass, config.db_name)
    try:
        stats = loader.load_passages(items)
    finally:
        loader.close()

    for w in stats["warnings"]:
        print(f"[WARN] {w}", flush=True)
    for s in stats["skipped"]:
        print(f"[ERROR] {s}", flush=True)
    print(f"[ok] 入库完成：更新 {stats['updated']} 行，跳过 {len(stats['skipped'])} 行", flush=True)
    return 0 if stats["updated"] else 1


def _load_db_rows(conn, limit: int | None = None) -> list[dict]:
    sql = ("SELECT id, work_title, semester, body, key_terms, sentences, full_translation "
           "FROM chinese_passages ORDER BY sort_order, id")
    if limit:
        sql += f" LIMIT {int(limit)}"
    with conn.cursor() as cur:
        cur.execute(sql)
        rows = cur.fetchall()
    out = []
    for row_id, title, semester, body, key_terms, sentences, full_translation in rows:
        out.append({
            "passage_id": row_id,
            "work_title": title,
            "semester": semester,
            "body": body,
            "key_terms": json.loads(key_terms) if key_terms else [],
            "sentences": json.loads(sentences) if sentences else [],
            "full_translation": full_translation or "",
        })
    return out


def run_export(args, config) -> int:
    """导出**可编辑**校对稿：要改的字段留空，只读参考放 `_ref`（照 answer_importer 的约定）。"""
    conn = _connect(config)
    try:
        rows = _load_db_rows(conn, args.limit)
    finally:
        conn.close()

    path = _jsonl_path(args, config)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps({
                "work_title": r["work_title"],
                "semester": r["semester"],
                # 可编辑字段：留空表示「不改」
                "key_terms": [],
                "sentences": [],
                "full_translation": "",
                "_ref": {
                    "passage_id": r["passage_id"],
                    "body": r["body"],
                    "key_terms": r["key_terms"],
                    "sentences": r["sentences"],
                    "full_translation": r["full_translation"],
                },
            }, ensure_ascii=False) + "\n")
    print(f"[ok] 导出校对稿：{path}（{len(rows)} 行；改完用 --apply 回写）", flush=True)
    return 0


def run_apply(args, config) -> int:
    """回写校对稿：逐行 diff，**只写被改过的行**（没改的行不产生 SQL）。"""
    path = _jsonl_path(args, config)
    if not path.exists():
        print(f"[ERROR] 校对稿不存在：{path}（先跑 --export）", flush=True)
        return 1
    rows = [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]

    conn = _connect(config)
    changed = 0
    try:
        for r in rows:
            ref = r.get("_ref") or {}
            passage_id = ref.get("passage_id")
            if not passage_id:
                print(f"[WARN] 跳过一条没有 _ref.passage_id 的行（--apply 只回写 --export 的产物）", flush=True)
                continue

            new_key_terms = r.get("key_terms") or ref.get("key_terms") or []
            new_sentences = r.get("sentences") or ref.get("sentences") or []
            new_full = (r.get("full_translation") or "").strip() or ref.get("full_translation") or ""

            # 先自检：校对稿改坏了（拼不回正文/译文空缺）就拒绝，不写库
            check = check_passage(
                body=ref.get("body") or "",
                sentences=[s.get("text", "") for s in new_sentences],
                translations=[s.get("translation", "") for s in new_sentences],
                key_terms=new_key_terms,
                full_translation=new_full,
            )
            if not check.ok:
                for e in check.errors:
                    print(f"[ERROR] 《{r.get('work_title')}》校对稿未通过自检：{e}", flush=True)
                continue

            if (new_key_terms == (ref.get("key_terms") or [])
                    and new_sentences == (ref.get("sentences") or [])
                    and new_full == (ref.get("full_translation") or "")):
                continue  # 没改 → 不写

            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE chinese_passages SET key_terms=%s, sentences=%s, full_translation=%s WHERE id=%s",
                    (json.dumps(new_key_terms, ensure_ascii=False),
                     json.dumps(new_sentences, ensure_ascii=False),
                     new_full, passage_id),
                )
            changed += 1
        conn.commit()
    finally:
        conn.close()

    print(f"[ok] 回写完成：{changed} 行被改动（其余未变，不写库）", flush=True)
    return 0


def main(argv=None) -> int:
    args = parse_args(argv)
    if not (args.extract or args.load or args.all or args.export or args.apply):
        print("[ERROR] 需指定 --extract / --load / --all / --export / --apply 之一", flush=True)
        return 2

    config = RefineryConfig.from_env()
    # 逐个显式 return：只给 --extract 时绝不能穿透到 --apply（四个动作是互斥的语义）
    if args.all:
        rc = run_extract(args, config)
        return run_load(args, config) if rc == 0 else rc
    if args.extract:
        return run_extract(args, config)
    if args.load:
        return run_load(args, config)
    if args.export:
        return run_export(args, config)
    return run_apply(args, config)


if __name__ == "__main__":
    raise SystemExit(main())
