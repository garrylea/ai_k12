"""dictation_cli 子命令入口。语文默写内容管线：第 4-6 步（定位/切片/自检、入库）。

第 1-3 步请用既有 CLI：
  cd tools/crawler       && python src/crawler_cli.py  --site smartedu --subject 语文 --publisher 统编版 --grade 九年级 --semester 上册
  cd tools/data-refinery && python src/convert_cli.py   --source smartedu --subject 语文 --term 上册
  cd tools/data-refinery && python src/toc_parse_cli.py --source smartedu --subject 语文 --publisher 统编版 --grade 九上

## 分工（2026-09-14 用户裁决后定型）

| 环节 | 谁做 |
|---|---|
| 哪些篇目、在第几页 | **程序**（目录 `candidates.json` + 印刷页偏移） |
| 正文起止 | **程序**（`dictation_locate` 的版面规则：标题行 → 跳过导语/作者/题解/图片 → 终止符） |
| 尾部编者赏析 / 词前小序 | **程序**（`dictation_locate.trim_to_form` 按格律切） |
| 作者 / 朝代 / 体裁 | **LLM**（`dictation_locate.ask_identity`，输入只有篇名，短字段可人工核） |
| 正文纠正 | **LLM**（`dictation_repair`，本地优先、ds flash 兜底） |
| 通过与否 | **程序**（`dictation_check` 纯程序自检） |

旧实现让 LLM 返回「正文首句/末句锚点」，**一次调用要喂一整个单元**
（实测「第六单元」30 页 1.45 万字、一次找 13 篇），又不传 `temperature`，
于是同代码同输入连跑 3 次得 **23 / 22 / 20 篇**。现已改为纯程序定位，可复现。

自检有 `errors` 的篇目仍先交 `dictation_repair`，**模型输出即采用**（用户裁决：
不设采纳闸门）；两个模型都拿不出非空输出才**不进 JSONL**（只进 unresolved 报告）。
入库的 `verified` 恒为 1——区别只在于正文是程序原样切片还是模型纠正稿
（后者在 `{book}-review.md` 里留了原文与纠正稿供比对）。
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from config import RefineryConfig
from dictation_check import check_body
from dictation_locate import (
    ask_identity,
    find_anchor_page,
    find_anchor_pages,
    locate_body,
    norm_title,
    trim_to_form,
)
from dictation_repair import repair_body
from dictation_slice import cut_page_annotations, normalize_body
from extract_cli import _load_prompt
from llm import create_llm_client
from page_chrome import compute_book_chrome, strip_chrome

SUBJECT_DIR = "语文"

#: 偏移众数需要的最少样本数与占比（低于此值判为不可靠，退回「不套偏移」）
OFFSET_MIN_SAMPLES = 3
OFFSET_MIN_SHARE = 0.5


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="语文默写内容管线（定位/切片/自检/入库）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python src/dictation_cli.py --extract --book "九年级/上册" --term 上册
  python src/dictation_cli.py --load    --book "九年级/上册" --term 上册
  python src/dictation_cli.py --all     --book "九年级/上册" --term 上册
        """,
    )
    parser.add_argument("--book", required=True, help="教材路径子串，如 '九年级/上册'")
    parser.add_argument("--term", required=True, choices=["上册", "下册"], help="册次（写入 dictation_passages.semester）")
    parser.add_argument("--input-dir", help="MD 根目录（默认 output/md）")
    parser.add_argument("--output-dir", help="产物根目录（默认 output/dictation）")
    parser.add_argument("--candidates", help="候选清单 JSON 路径（默认 output/dictation/<book 同名>/candidates.json）")
    parser.add_argument("--extract", action="store_true", help="定位 + 切片 + 自检，出 JSONL 与两份清单")
    parser.add_argument("--load", action="store_true", help="把 JSONL 入库（幂等）")
    parser.add_argument("--all", action="store_true", help="等价于 --extract --load")
    return parser.parse_args(argv)


#: TOC label 的前导章号：「11 岳阳楼记/范仲淹」→「岳阳楼记/范仲淹」；「13* 湖心亭看雪」同
_NUM_PREFIX_RE = re.compile(r"^\d+\*?\s*")
_WS_RE = re.compile(r"\s+")


def _title_of(label: str) -> str:
    """从 TOC 的 label 取篇名：「10 岳阳楼记」→「岳阳楼记」；无编号则原样。

    实测 toc_parse 的 label 是「篇名/作者」（`11 岳阳楼记/范仲淹`、`26 出师表 / 诸葛亮`），
    作者必须一并剥掉：留着会与正文页里的标题行对不上。篇名里不出现「/」，
    故按第一个「/」切分是安全的。
    """
    return _NUM_PREFIX_RE.sub("", label.strip()).split("/")[0].strip()


def _same_work(a: str, b: str) -> bool:
    """两个篇名是否指同一篇作品（去空白 + 全半角括号，相等或一方含另一方）。"""
    x = _WS_RE.sub("", a).replace("（", "(").replace("）", ")")
    y = _WS_RE.sub("", b).replace("（", "(").replace("）", ")")
    return bool(x) and bool(y) and (x == y or x in y or y in x)


def _find_book_dir(md_root: Path, book: str, subject: str = SUBJECT_DIR) -> Path | None:
    """在 MD 根目录下找含 page_*.md 的教材目录（--book 为路径子串）。找不到返回 None。

    只在**本科目**目录下找：--book 是路径子串（如「九年级/上册」），而 output/md 下同年级
    同册的其它学科目录也含这个子串。实测全库搜索会先命中数学书（`output/md/数学/…` 的
    字符串序在 `output/md/语文/…` 之前，九上实测抽到 163 页的数学书）。
    """
    root = md_root / subject if (md_root / subject).is_dir() else md_root
    for d in sorted(root.rglob("*")):
        if d.is_dir() and book in str(d) and list(d.glob("page_*.md")):
            return d
    return None


def _md_pages(book_md_dir: Path) -> list[tuple[int, str]]:
    """按页序返回 (页号, 文本)。页号取自文件名 page_NNN.md。"""
    out: list[tuple[int, str]] = []
    for p in sorted(book_md_dir.glob("page_*.md")):
        digits = "".join(c for c in p.stem if c.isdigit())
        if digits:
            out.append((int(digits), p.read_text(encoding="utf-8")))
    return out


def _offset_mode(pairs: list[tuple[int, int]], min_samples: int = OFFSET_MIN_SAMPLES,
                 min_share: float = OFFSET_MIN_SHARE) -> int | None:
    """求「MD 页号 - 印刷页号」的众数偏移。

    样本过少、或众数占比不足 → 返回 None（调用方按「不套偏移」处理）。
    意图是「宁可不信也不硬套」：偏移错了会把锚点定到别的页。
    """
    if len(pairs) < min_samples:
        return None
    counter: dict[int, int] = {}
    for printed, md in pairs:
        diff = md - printed
        counter[diff] = counter.get(diff, 0) + 1
    offset, n = max(counter.items(), key=lambda kv: kv[1])
    return offset if n / len(pairs) >= min_share else None


def _compute_offset(candidates: list[dict], pages: list[tuple[int, str]]) -> int | None:
    """用「标题行所在页 − 印刷页」的众数求偏移。

    每个候选**可能命中多处**标题行（实测《十五从军征》在目录页 page_006 也命中），
    故取**离印刷页最近**的那个：正文页紧挨着它标称的印刷页，目录页则在书前很远处，
    取最近即自动排除目录误命中。若直接把所有命中都算进众数，
    目录那批离群值会把众数占比压到 50% 以下、判成「不可靠」而**整册退化为不套偏移**。
    """
    pairs: list[tuple[int, int]] = []
    for c in candidates:
        title = _title_of(c.get("label", ""))
        printed = c.get("printed_page")
        if not title or printed is None:
            continue
        hits = find_anchor_pages(title, pages)
        if not hits:
            continue
        nearest = min(hits, key=lambda no: abs(no - int(printed)))
        pairs.append((int(printed), nearest))
    return _offset_mode(pairs)


def _ordered_candidates(candidates: list[dict], pages: list[tuple[int, str]],
                        offset: int | None) -> list[tuple[str, int | None, int, str]]:
    """返回按锚点页排序的 [(篇名, 印刷页, 锚点页, 单元标题)]（锚点找不到的丢弃，另行报告）。"""
    rows: list[tuple[str, int | None, int, str]] = []
    for c in candidates:
        title = _title_of(c.get("label", ""))
        printed = c.get("printed_page")
        if not title:
            continue
        anchor = find_anchor_page(title, printed, pages, offset)
        if anchor is None:
            continue
        rows.append((title, printed, anchor, c.get("unit_label") or "（未分单元）"))
    rows.sort(key=lambda r: r[2])
    return rows


def run_extract(args, config) -> int:
    md_root = Path(args.input_dir) if args.input_dir else config.output_dir / "md"
    out_root = Path(args.output_dir) if args.output_dir else config.output_dir / "dictation"

    book_md_dir = _find_book_dir(md_root, args.book)
    if book_md_dir is None:
        print(f"[ERROR] 没找到含 page_*.md 的教材目录（--book {args.book}）", flush=True)
        return 1
    book_name = book_md_dir.name

    cand_path = Path(args.candidates) if args.candidates else out_root / SUBJECT_DIR / args.term / "candidates.json"
    if not cand_path.exists():
        print(f"[ERROR] 候选清单不存在：{cand_path}（先跑 toc_parse 并由用户确认）", flush=True)
        return 1
    candidates = json.loads(cand_path.read_text(encoding="utf-8"))

    pages = _md_pages(book_md_dir)
    chrome = compute_book_chrome(book_md_dir)
    # 逐页：剥运行页眉 → 切掉页尾注释块。两步都必须在拼接前按页做，否则跨页文言文的
    # 中间各页注释会落进正文区间（实测醉翁亭记 775 字含 〔〕）；见 dictation_slice 的说明。
    clean = [(n, cut_page_annotations(strip_chrome(t, chrome))) for n, t in pages]

    offset = _compute_offset(candidates, clean)
    mode = "印刷页偏移" if offset is not None else "未套偏移（众数不可靠）"
    print(f"[ok] 页数 {len(pages)}，定位模式：{mode}" + (f"，偏移 {offset}" if offset is not None else ""), flush=True)

    ordered = _ordered_candidates(candidates, clean, offset)
    titles = [r[0] for r in ordered]
    all_titles = frozenset(norm_title(t) for t in titles)
    print(f"[ok] 候选 {len(candidates)} 篇，命中标题行 {len(ordered)} 篇", flush=True)

    rows: list[dict] = []
    unresolved: list[tuple[str, str, str]] = []
    seen_titles: set[str] = set()

    # 候选里连标题行都找不到的（多半是排版特殊），必须响亮报出来，不能静默丢
    for c in candidates:
        title = _title_of(c.get("label", ""))
        if title and title not in titles:
            unresolved.append((title, "未找到标题行",
                               f"印刷页 {c.get('printed_page')}｜{c.get('unit_label')}"))

    # 作者/朝代/体裁：LLM 只干这一件事（用户裁决）
    llm = create_llm_client(
        provider=config.llm_provider, api_key=config.llm_api_key or "",
        auth_token=config.llm_auth_token, model=config.llm_model,
        base_url=config.llm_base_url, timeout=config.llm_timeout,
        max_tokens=config.llm_max_tokens, max_retries=config.llm_max_retries,
        thinking=config.llm_thinking, enable_cache=config.llm_enable_cache,
    )
    identity_prompt = _load_prompt("dictation_identity")
    repair_prompt = _load_prompt("dictation_repair")

    # 正文纠正的兜底模型（本地优先、ds flash 兜底）。未配置 LLM_FALLBACK_* 时只试主模型。
    fb_llm = None
    if config.llm_fallback_provider:
        try:
            fb_llm = create_llm_client(
                provider=config.llm_fallback_provider,
                api_key=config.llm_fallback_api_key or "",
                model=config.llm_fallback_model,
                base_url=config.llm_fallback_base_url,
                timeout=config.llm_timeout,
                max_tokens=config.llm_max_tokens,
                max_retries=config.llm_max_retries,
            )
            print(f"[ok] 正文纠正兜底模型就绪："
                  f"{config.llm_fallback_provider} / {config.llm_fallback_model}", flush=True)
        except Exception as e:                        # 兜底不可用不阻断抽取
            print(f"[WARN] 纠正兜底模型初始化失败（{e}），仅用主模型纠正", flush=True)

    for index, (title, printed, anchor, unit_label) in enumerate(ordered):
        if title in seen_titles:
            continue
        next_anchor = ordered[index + 1][2] if index + 1 < len(ordered) else None
        others = frozenset(t for t in all_titles if t != norm_title(title))

        located = locate_body(title, printed, clean, offset, next_anchor, others)
        if located is None:
            unresolved.append((title, "未切出正文",
                               f"锚点页 {anchor}｜印刷页 {printed}"))
            continue

        # 作者/朝代/体裁（LLM）；失败不阻断，但留痕进复核
        review_reasons_extra: list[str] = []
        try:
            identity = ask_identity(llm, title, identity_prompt)
        except Exception as e:
            identity = None
            print(f"[WARN] 《{title}》作者/朝代获取失败：{e}", flush=True)
            review_reasons_extra.append(f"作者/朝代获取失败（{str(e)[:80]}）")

        genre = identity.genre if identity else "other"
        author = identity.author if identity else ""
        dynasty = identity.dynasty if identity else ""

        # 按格律切掉尾部编者赏析 / 词前小序（程序，确定性）
        body, trim_notes = trim_to_form(located.body, title, genre)
        body = normalize_body(body)
        checked = check_body(body, title, genre, chrome)
        if review_reasons_extra:
            checked.needs_review = True
            checked.review_reasons.extend(review_reasons_extra)

        # 自检未过 → 交给模型纠正（本地优先、ds flash 兜底），模型输出即采用
        # （用户裁决：不设采纳闸门）。两个模型都拿不出非空输出才维持 fail-closed。
        original_body: str | None = None
        repair_note = ""
        repair_errors: list[str] = []
        residual: list[str] = []
        if checked.errors:
            repaired = repair_body(
                llm, fb_llm,
                body=body, work_title=title, author=author, dynasty=dynasty,
                genre=genre, errors=checked.errors, chrome=chrome, prompt=repair_prompt,
            )
            if repaired.body is None:
                unresolved.append((
                    title, "自检未通过（纠正未成）",
                    "；".join(checked.errors) + "｜" + "｜".join(repaired.attempts),
                ))
                continue
            repair_errors = checked.errors
            original_body = body
            repair_note = repaired.note
            residual = repaired.residual
            body = repaired.body
            # 复核标记按**纠正稿**重算
            checked = check_body(body, title, genre, chrome)

        seen_titles.add(title)
        rows.append({
            "subject_id": "chinese", "work_title": title,
            "author": author, "dynasty": dynasty, "body": body,
            "semester": args.term, "grade_band": "junior", "grade": "九年级",
            "_sort_order": len(rows) + 1,
            "source_ref": f"{book_name} {unit_label}",
            "verified": 1,
            "_genre": genre,
            "_needs_review": checked.needs_review,
            "_review_reasons": checked.review_reasons,
            "_locate_notes": located.notes + trim_notes,
            "_repair_note": repair_note,
            "_original_body": original_body,
            "_repair_errors": repair_errors,
            "_repair_residual": residual,
        })

    book_out = out_root / SUBJECT_DIR / args.term
    book_out.mkdir(parents=True, exist_ok=True)
    jsonl_path = book_out / f"{book_name}.jsonl"
    with jsonl_path.open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    review_path = book_out / f"{book_name}-review.md"
    repaired_rows = [r for r in rows if r["_original_body"] is not None]
    with review_path.open("w", encoding="utf-8") as f:
        f.write(f"# 人工过目清单：{book_name}\n\n")
        f.write("按「需复核优先」排序。抽看长文言文与标了需复核的行即可。\n\n")
        f.write("| 需复核 | 已纠正 | 篇名 | 作者 | 朝代 | 体裁 | 字数 | 正文首 20 字 | 正文末 20 字 |\n")
        f.write("|---|---|---|---|---|---|---|---|---|\n")
        for r in sorted(rows, key=lambda x: (not x["_needs_review"], x["_sort_order"])):
            b = r["body"]
            flag = "⚠ " + "；".join(r["_review_reasons"]) if r["_needs_review"] else ""
            fixed = r["_repair_note"] if r["_original_body"] is not None else ""
            f.write(f"| {flag} | {fixed} | {r['work_title']} | {r['author']} | {r['dynasty']} | {r['_genre']} | {len(b)} | {b[:20]} | {b[-20:]} |\n")

        # 纠正过的篇目单独展开原文与纠正稿：模型改写是「可能改对也可能改错」的一步，
        # 只看纠正后无法判断，必须把两者的差异摆到人眼前。
        if repaired_rows:
            f.write("\n## 已由模型纠正（**请逐篇比对**）\n\n")
            f.write("下列篇目的切片正文未通过确定性自检，已由模型改写后**直接采用**。\n")
            f.write("纠正**可能改对、也可能改错**（例如把生僻字改成常见字）——务必对照原文复核。\n\n")
            for r in repaired_rows:
                orig = r["_original_body"]
                f.write(f"### {r['work_title']}（{r['_repair_note']}）\n\n")
                f.write(f"- 自检问题：{'；'.join(r['_repair_errors'])}\n")
                if r["_repair_residual"]:
                    f.write(f"- **纠正后自检仍报**：{'；'.join(r['_repair_residual'])}\n")
                f.write(f"- 纠正前（{len(orig)} 字）：{orig}\n")
                f.write(f"- 纠正后（{len(r['body'])} 字）：{r['body']}\n\n")

        # 定位留痕：写清楚程序跳过了哪些块、被什么终止，便于复核「切得对不对」
        f.write("\n## 定位留痕（程序判断）\n\n")
        for r in sorted(rows, key=lambda x: x["_sort_order"]):
            if r["_locate_notes"]:
                f.write(f"- **{r['work_title']}**：{'；'.join(r['_locate_notes'])}\n")

    unresolved_path = book_out / f"{book_name}-unresolved.md"
    with unresolved_path.open("w", encoding="utf-8") as f:
        f.write(f"# 待人工处理：{book_name}\n\n")
        if not unresolved:
            f.write("（无）\n")
        for name, reason, detail in unresolved:
            f.write(f"- **{name}** —— {reason}：{detail}\n")

    print(f"[ok] {book_name}：入库候选 {len(rows)} 篇（其中模型纠正 {len(repaired_rows)} 篇），"
          f"待人工处理 {len(unresolved)} 项", flush=True)
    print(f"[ok] JSONL -> {jsonl_path}", flush=True)
    print(f"[ok] 过目清单 -> {review_path}", flush=True)
    print(f"[ok] 待处理 -> {unresolved_path}", flush=True)
    return 0


def _jsonl_path(args, config) -> Path:
    """定位 `--extract` 已落盘的 JSONL。"""
    out_root = Path(args.output_dir) if args.output_dir else config.output_dir / "dictation"
    md_root = Path(args.input_dir) if args.input_dir else config.output_dir / "md"
    book_md_dir = _find_book_dir(md_root, args.book)
    if book_md_dir is None:
        raise FileNotFoundError(f"没找到含 page_*.md 的教材目录（--book {args.book}）")
    return out_root / SUBJECT_DIR / args.term / f"{book_md_dir.name}.jsonl"


def run_load(args, config) -> int:
    """把 `--extract` 的 JSONL 入库（幂等）。

    **刻意不重跑抽取**：只吃已落盘的 JSONL，这样人工过目可以发生在入库**之前**——
    用户否决的篇目直接从 JSONL 里删掉即可。
    """
    from dictation_loader import DictationLoader

    try:
        path = _jsonl_path(args, config)
    except FileNotFoundError as e:
        print(f"[ERROR] {e}", flush=True)
        return 1
    if not path.exists():
        print(f"[ERROR] JSONL 不存在：{path}（先跑 --extract）", flush=True)
        return 1

    items = DictationLoader.read_jsonl(path)
    if not items:
        print(f"[WARN] {path} 没有可入库的篇目", flush=True)
        return 1

    loader = DictationLoader(config.db_host, config.db_port, config.db_user,
                             config.db_pass, config.db_name)
    try:
        stats = loader.load_passages(items)
    finally:
        loader.close()

    print(f"[ok] 入库完成：新增题 {stats['inserted']}、复用并更新 {stats['updated']}、"
          f"篇目 upsert {stats['passages_upserted']}", flush=True)
    return 0


def main(argv=None) -> int:
    args = parse_args(argv)
    if not (args.extract or args.load or args.all):
        print("[ERROR] 需指定 --extract / --load / --all 之一", flush=True)
        return 2

    config = RefineryConfig.from_env()
    if args.extract or args.all:
        rc = run_extract(args, config)
        if rc != 0:
            return rc

    if args.load or args.all:
        return run_load(args, config)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
