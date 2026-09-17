"""meaning_backfill_cli：给**缺 `sentences`** 的古诗文补切句与整篇译文。

## 为什么需要它

「古诗含义」专项把每句的深层含义 + 作者情感存在 `chinese_passages.sentence_meanings`，
**按下标与 `sentences` 对齐**（`meaning.service.ts` 的 `meaningsOf()`）。用户手写的 31 篇里
有 15 篇走过解释（翻译）管线、`sentences` 已就绪，另外 16 篇 `sentences IS NULL`——
含义内容**没有落点**（长度不等时整篇按无含义处理），所以先得把句子切出来。

## 唯一的硬要求：下标不能错位

`sentence_meanings[i]` 描述的是 `sentences[i]`。切错一句、或错开一位，
**没有异常、没有日志**——学生会拿**另一句**的标准含义被判分。所以：

1. **切分位置来自用户文档的 `###` 行**（那是「一联一句」的口径，与已就绪的 15 篇一致）；
2. **字面文本一律取自库里的 `body`**，只按文档给的边界去 `body` 上取字符。
   于是 `''.join(结果) == body` **构造上必然成立**，文档与库的排版差异
   （半角/全角引号等，文档被机器转过）顺带被中和掉——测试里正钉着这一条。
3. **对不上就抛错**（`ValueError`，消息带首处差异的位置与上下文）：绝不猜、绝不部分采用。

**不用 `interpretation_split.split_sentences`**：它在 `？！` 处也断句，会把
「云横秦岭家何在？雪拥蓝关马不前。」拆成两个半句——既不是库里那 15 篇的口径，
也不是用户写含义时的口径。

## 只碰两列、只碰 `sentences IS NULL` 的行

    UPDATE chinese_passages SET sentences = %s, full_translation = %s WHERE id = %s

`key_terms`（解释专项在用，用户明确禁止改动）/ `verified` / `is_active` /
`memorize_required` 在语句里**根本不出现**，有钉子用例守着。
取数只取 `sentences IS NULL` 的行——已有句读的**一条都不取、不改**。

## 译文

复用 `interpretation_translate.translate_passage`（本地 LLM 优先、ds-flash 兜底），
`key_terms=[]` 只为凑参数签名（**不落库**）。**译文失败不阻断**：该篇仍写 `sentences`，
`translation` 留空串，并在 `<stem>-review.md` 里点名。

## `--dry-run` 不调模型

`--dry-run` 只做「解析文档 → 取目标行 → 切片 → 拼回正文」并落过目清单，
**既不写库、也不调 LLM**（16 篇 × 本地模型太慢，且切片才是这一步要核对的东西）。
译文在 `--apply` 时生成。

## 用法

    python src/meaning_backfill_cli.py --dry-run --input /path/诗深层含义.md
    python src/meaning_backfill_cli.py --apply   --input /path/诗深层含义.md
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pymysql

from config import RefineryConfig
from extract_cli import _load_prompt
from interpretation_check import check_passage
from interpretation_input import norm_title
from interpretation_translate import translate_passage
from llm import create_llm_client
from meaning_cli import parse_uidoc

SUBJECT_DIR = "语文"

#: 引号归一：库里是全角、文档被转成半角。**一换一**，不改变长度，
#: 所以「归一后比对」的下标可以直接映射回原文下标。
_QUOTE_FOLD = str.maketrans({
    "“": '"', "”": '"', "「": '"', "」": '"',
    "‘": "'", "’": "'", "『": "'", "』": "'",
})


def _sig(s: str) -> str:
    """比对用形式：去所有空白 + 引号归一。**只用于比对与计数，不用于落库文本。**"""
    return "".join(s.split()).translate(_QUOTE_FOLD)


def _first_diff(a: str, b: str) -> int:
    """首个不同的下标；一个是另一个的前缀时返回较短者的长度。"""
    for i in range(min(len(a), len(b))):
        if a[i] != b[i]:
            return i
    return min(len(a), len(b))


def slice_by_doc_boundaries(body: str, doc_sentences: list[str]) -> list[str]:
    """按文档给的切分位置切片，**字面一律取自 body**。

    这样 ``''.join(结果) == body`` 是构造上必然成立的，文档与库的排版差异
    （半角/全角引号等）不会带进库。
    对不上就抛 ``ValueError``——绝不猜、绝不部分采用。
    """
    body_sig = _sig(body)
    doc_sig = "".join(_sig(d) for d in doc_sentences)

    if doc_sig != body_sig:
        pos = _first_diff(body_sig, doc_sig)
        window = 12
        raise ValueError(
            f"文档切句拼不回库里的正文（文档 {len(doc_sig)} 字 vs 正文 {len(body_sig)} 字）"
            f"，首处差异在第 {pos} 字附近："
            f"正文「{body_sig[max(0, pos - window):pos + window]}」"
            f"／文档「{doc_sig[max(0, pos - window):pos + window]}」"
        )

    # body 里每个非空白字符的原始下标：positions[k] 即 body_sig 第 k 字的落点
    positions = [i for i, ch in enumerate(body) if not ch.isspace()]

    out: list[str] = []
    cursor = 0
    for d in doc_sentences:
        length = len(_sig(d))
        if length == 0:
            raise ValueError(f"文档第 {len(out) + 1} 句是空的，无法定位切分点")
        start = 0 if cursor == 0 else positions[cursor]
        end = positions[cursor + length - 1] + 1
        while end < len(body) and body[end].isspace():
            end += 1              # 紧随其后的空白并入本段，保证能拼回原文
        out.append(body[start:end])
        cursor += length

    return out


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="给缺 sentences 的古诗文补切句与整篇译文（只写 sentences / full_translation）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python src/meaning_backfill_cli.py --dry-run --input /path/诗深层含义.md
  python src/meaning_backfill_cli.py --apply   --input /path/诗深层含义.md
        """,
    )
    parser.add_argument("--input", required=True, help="用户手写文档路径")
    parser.add_argument("--output-dir", help="产物根目录（默认 output/meaning）")
    parser.add_argument("--limit", type=int, help="只处理前 N 行目标（打样用）")
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--dry-run", action="store_true",
                        help="只切片并核对拼回正文，不写库、不调模型")
    action.add_argument("--apply", action="store_true", help="切片 + 出译文并写库（只写两列）")
    args = parser.parse_args(argv)
    if args.limit is not None and args.limit <= 0:
        parser.error("--limit 必须为正整数")
    return args


# ==================== 产物路径 ====================


def _out_root(args, config) -> Path:
    return Path(args.output_dir) if args.output_dir else config.output_dir / "meaning"


def _review_path(args, config) -> Path:
    return _out_root(args, config) / SUBJECT_DIR / f"{Path(args.input).stem}-review.md"


# ==================== 数据库 ====================


def _connect(config: RefineryConfig):
    return pymysql.connect(host=config.db_host, port=config.db_port, user=config.db_user,
                           password=config.db_pass, database=config.db_name, charset="utf8mb4")


#: 只取 `sentences IS NULL` 的行——已有句读的（解释管线切过的）一条都不动。
_FETCH_SQL = (
    "SELECT id, semester, work_title, body FROM chinese_passages "
    "WHERE sentences IS NULL ORDER BY semester, sort_order, id"
)

_COUNT_UNTOUCHED_SQL = "SELECT COUNT(*) FROM chinese_passages WHERE sentences IS NOT NULL"

#: 只写两列。`key_terms` 归解释专项（用户明确禁止改动）、
#: `verified`/`is_active`/`memorize_required` 是人工标定——都不许出现。
_UPDATE_SENTENCES_SQL = (
    "UPDATE chinese_passages SET sentences = %s, full_translation = %s WHERE id = %s"
)


def _fetch_targets(conn, limit: int | None = None) -> list[tuple]:
    """→ [(id, semester, work_title, body)]，**只有 `sentences IS NULL` 的行**。"""
    sql = _FETCH_SQL
    if limit:
        sql += f" LIMIT {int(limit)}"
    with conn.cursor() as cur:
        cur.execute(sql)
        return list(cur.fetchall())


def _count_untouched(conn) -> int:
    with conn.cursor() as cur:
        cur.execute(_COUNT_UNTOUCHED_SQL)
        return int(cur.fetchone()[0])


# ==================== 编排 ====================


def _build_llms(config: RefineryConfig):
    """本地优先 + ds-flash 兜底（与 `interpretation_cli.run_extract` 同一套配置变量）。"""
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
        except Exception as e:                            # 兜底不可用不阻断
            print(f"[WARN] 兜底模型初始化失败（{e}），仅用主模型", flush=True)
    return primary, fallback


def _slice_targets(targets: list[tuple], by_title: dict) -> tuple[list[dict], list[str], list[str]]:
    """→ (切片成功的条目, 未处理的篇目, 切片失败的篇目)。

    每篇要么整篇切片成功、要么整篇不动（**绝不部分采用**）。
    """
    items: list[dict] = []
    missing: list[str] = []
    errors: list[str] = []

    for row_id, semester, work_title, body in targets:
        prefix = f"《{work_title}》(id={row_id})"
        entries = by_title.get(norm_title(work_title))
        if not entries:
            missing.append(f"{prefix} 库里 sentences 为空，但文档里没有这篇（或篇名对不上）——不猜，跳过")
            continue

        try:
            sliced = slice_by_doc_boundaries(body, [e[0] for e in entries])
        except ValueError as e:
            errors.append(f"{prefix} 切片对不上，整篇未处理：{e}")
            continue

        check = check_passage(
            body=body, sentences=sliced, translations=[], key_terms=[],
            full_translation=None, require_translation=False,
        )
        # check.warnings 里必然有一条「没有任何重点字词」——key_terms 本管线故意不碰，忽略
        if not check.ok:
            errors.extend(f"{prefix} {e}" for e in check.errors)
            continue

        items.append({
            "row_id": row_id,
            "semester": semester,
            "work_title": work_title,
            "sentences": [{"text": t, "translation": ""} for t in sliced],
            "full_translation": "",
            "translation_source": None,
            "translation_error": None,
        })

    return items, missing, errors


def _generate_translations(items: list[dict], config: RefineryConfig) -> None:
    """逐篇生成译文，**失败不阻断**（该篇 translation 留空串）。"""
    primary, fallback = _build_llms(config)
    prompt = _load_prompt("interpretation_translate")

    for it in items:
        result = translate_passage(
            primary, fallback,
            work_title=it["work_title"],
            sentences=[s["text"] for s in it["sentences"]],
            key_terms=[],                                  # 只为凑参数签名，不落库
            prompt=prompt,
        )
        if result.translations is None:
            it["translation_error"] = result.error or "未知原因"
            print(f"[WARN] 《{it['work_title']}》(id={it['row_id']}) 译文生成失败："
                  f"{it['translation_error']}（{'；'.join(result.attempts)}）"
                  f"——仍写 sentences，该篇 translation 留空串", flush=True)
            continue
        for s, tr in zip(it["sentences"], result.translations):
            s["translation"] = tr
        it["full_translation"] = result.full_translation or ""
        it["translation_source"] = result.source
        print(f"[ok] 《{it['work_title']}》(id={it['row_id']}) 译文来自 {result.source}", flush=True)


def _write_items(items: list[dict], config: RefineryConfig) -> None:
    conn = _connect(config)
    try:
        for it in items:
            with conn.cursor() as cur:
                cur.execute(_UPDATE_SENTENCES_SQL, (
                    json.dumps(it["sentences"], ensure_ascii=False),
                    it["full_translation"],
                    it["row_id"],
                ))
        conn.commit()
    finally:
        conn.close()


def render_review(args, items: list[dict], missing: list[str], errors: list[str],
                  n_doc_titles: int, n_targets: int, n_untouched: int) -> str:
    mode = "--dry-run" if args.dry_run else "--apply"
    lines = ["# 古诗含义专项 · 补切句与译文 · 过目清单", ""]
    lines.append(f"- 文档：`{args.input}`（解析出 {n_doc_titles} 篇）")
    lines.append(f"- 模式：`{mode}`")
    lines.append(f"- 目标行（`sentences IS NULL`）：**{n_targets}**")
    lines.append(f"- 切片成功：**{len(items)}**")
    lines.append(f"- 未处理（对不上/文档里没有）：**{len(missing) + len(errors)}**")
    lines.append(f"- 未取未改（`sentences` 非空）：**{n_untouched}** 行")
    if args.dry_run:
        lines.append("- 本模式不写库、不调模型（译文在 `--apply` 时生成）")
    lines.append("")

    lines.append("## 切片成功")
    lines.append("")
    for it in items:
        n = len(it["sentences"])
        joined = "".join(s["text"] for s in it["sentences"])
        lines.append(f"### 《{it['work_title']}》（{it['semester']}，id={it['row_id']}）")
        lines.append("")
        lines.append(f"- 句数：{n}｜text 拼回 body：{'是' if joined else '否'}")
        if it["translation_source"]:
            lines.append(f"- 译文来源：{it['translation_source']}")
            lines.append(f"- 整篇译文：{it['full_translation']}")
        elif it["translation_error"]:
            lines.append(f"- **译文生成失败**（translation 留空串）：{it['translation_error']}")
        else:
            lines.append("- 译文：未生成（dry-run，或未跑到译文步骤）")
        lines.append("")
        for i, s in enumerate(it["sentences"], start=1):
            lines.append(f"{i}. 原文：{s['text']}")
            lines.append(f"   译文：{s['translation'] or '（空）'}")
        lines.append("")

    failed_tr = [it for it in items if it["translation_error"]]
    if failed_tr:
        lines.append("## 译文失败（sentences 已写，translation 留空串——请人工补）")
        lines.append("")
        for it in failed_tr:
            lines.append(f"- 《{it['work_title']}》（id={it['row_id']}）：{it['translation_error']}")
        lines.append("")

    if errors:
        lines.append("## 切片失败（整篇未处理，绝不部分采用）")
        lines.append("")
        for e in errors:
            lines.append(f"- {e}")
        lines.append("")

    if missing:
        lines.append("## 文档里找不到对应条目")
        lines.append("")
        for m in missing:
            lines.append(f"- {m}")
        lines.append("")

    return "\n".join(lines)


def run(args, config: RefineryConfig) -> int:
    path = Path(args.input)
    if not path.exists():
        print(f"[ERROR] 文档不存在：{path}", flush=True)
        return 1

    by_title = parse_uidoc(path.read_text(encoding="utf-8"))
    if not by_title:
        print(f"[ERROR] 没从文档里解析出手写篇目：{path}"
              f"（判据：`### 句子` 且 `#### 深层含义` 同时出现）", flush=True)
        return 1
    print(f"[ok] 文档解析出 {len(by_title)} 篇", flush=True)

    conn = _connect(config)
    try:
        targets = _fetch_targets(conn, args.limit)
        n_untouched = _count_untouched(conn)
    finally:
        conn.close()
    print(f"[ok] 目标行（sentences IS NULL）：{len(targets)} 行；"
          f"已有 sentences 的 {n_untouched} 行本次不取、不改", flush=True)

    items, missing, errors = _slice_targets(targets, by_title)

    if args.apply and items:
        _generate_translations(items, config)
        _write_items(items, config)

    for it in items:
        if args.dry_run:
            print(f"[dry-run] 《{it['work_title']}》(id={it['row_id']}) {len(it['sentences'])} 句，"
                  f"text 拼回 body：ok（不写库、不调模型）", flush=True)
    for m in missing:
        print(f"[ERROR] {m}", flush=True)
    for e in errors:
        print(f"[ERROR] {e}", flush=True)

    review_path = _review_path(args, config)
    review_path.parent.mkdir(parents=True, exist_ok=True)
    review_path.write_text(
        render_review(args, items, missing, errors, len(by_title), len(targets), n_untouched),
        encoding="utf-8",
    )

    if args.dry_run:
        ok = len(items)
        print(f"[ok] dry-run：切片成功 {ok}/{len(targets)} 行，全部 text 拼回 body", flush=True)
        if ok < len(targets):
            print("[ERROR] 有行没切成，绝不下写——先人工核对文档与正文的差异", flush=True)
    else:
        n_failed_tr = sum(1 for it in items if it["translation_error"])
        print(f"[ok] 入库完成：写 {len(items)} 行（只 UPDATE sentences / full_translation）", flush=True)
        if n_failed_tr:
            print(f"[WARN] {n_failed_tr} 篇译文失败（sentences 已写、translation 留空串），"
                  f"见过目清单", flush=True)
    print(f"[ok] 过目清单：{review_path}", flush=True)

    return 0 if items and not missing and not errors else 1


def main(argv=None) -> int:
    args = parse_args(argv)
    return run(args, RefineryConfig.from_env())


if __name__ == "__main__":
    raise SystemExit(main())
