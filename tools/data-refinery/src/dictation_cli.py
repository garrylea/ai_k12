"""dictation_cli 子命令入口。语文默写内容管线：第 4-6 步（定位/切片/自检、入库）。

第 1-3 步请用既有 CLI：
  cd tools/crawler       && python src/crawler_cli.py  --site smartedu --subject 语文 --publisher 统编版 --grade 九年级 --semester 上册
  cd tools/data-refinery && python src/convert_cli.py   --source smartedu --subject 语文 --term 上册
  cd tools/data-refinery && python src/toc_parse_cli.py --source smartedu --subject 语文 --publisher 统编版 --grade 九上

本模块只编排，不做判断：篇目由 `dictation_locate`（LLM 只给锚点）、正文由 `dictation_slice`
（按锚点从 MD 原样切）、通过与否由 `dictation_check`（纯程序自检）决定。自检有 `errors`
的篇目先交给 `dictation_repair` 试着纠正（本地模型优先、ds flash 兜底），**纠正稿重跑
自检通过才采纳**；纠正不成的仍**不进 JSONL**（只进 unresolved 报告）。故入库的必是
自检通过的、`verified` 恒为 1——区别只在于正文是切片原样还是模型纠正稿（后者在
`{book}-review.md` 里留了原文与纠正稿供比对）。
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from config import RefineryConfig
from dictation_check import check_body
from dictation_locate import locate_unit
from dictation_repair import repair_body
from dictation_slice import cut_page_annotations, join_pages, normalize_body, slice_body
from extract_cli import _load_prompt
from llm import create_llm_client
from page_chrome import compute_book_chrome, strip_chrome

SUBJECT_DIR = "语文"


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


LEAD_PAGES = 2   # 单元扉页/导读可能早于该单元首篇的印刷页
WINDOW_TAIL = 3  # 单元末篇之后的余量（正文跨页时不把末句锚点切掉）

#: TOC label 的前导章号：「11 岳阳楼记/范仲淹」→「岳阳楼记/范仲淹」；「13* 湖心亭看雪」同
_NUM_PREFIX_RE = re.compile(r"^\d+\*?\s*")
_MD_HEADING_RE = re.compile(r"^#{1,6}\s*")
#: 行内注释角标（教材给每篇课文标题都标了角标，如 `# 11 岳阳楼记 $^{①}$`）
_TITLE_MARKER_RE = re.compile(r"\$\^\{[^}]*\}\$")
_WS_RE = re.compile(r"\s+")


def _title_of(label: str) -> str:
    """从 TOC 的 label 取篇名：「10 岳阳楼记」→「岳阳楼记」；无编号则原样。

    实测 toc_parse 的 label 是「篇名/作者」（`11 岳阳楼记/范仲淹`、`26 出师表 / 诸葛亮`），
    作者必须一并剥掉：留着会与 LLM 返回的 work_title（只有篇名）对不上，让「目录有但
    页文本中未找到」对**全部**候选误报。篇名里不出现「/」，故按第一个「/」切分是安全的。
    """
    s = _NUM_PREFIX_RE.sub("", label.strip())
    return s.split("/")[0].strip()


def _same_work(a: str, b: str) -> bool:
    """两个篇名是否指同一篇作品。

    TOC 的 label 与 LLM 回的 work_title 在标点上常有出入，逐字比对会把已收篇目误报成
    「目录有但页文本中未找到」（实测九上 5/6 条是这样来的）：`行路难(其一)` vs
    `行路难（其一）`、`南乡子 · 登京口北固亭有怀` vs `南乡子·登京口北固亭有怀`、
    词牌带副题时模型只回词牌（`浣溪沙（漠漠轻寒上小楼）` vs `浣溪沙`）。
    故归一（去空白 + 全半角括号）后比相等，或一方含另一方。
    """
    x = _WS_RE.sub("", a).replace("（", "(").replace("）", ")")
    y = _WS_RE.sub("", b).replace("（", "(").replace("）", ")")
    return bool(x) and bool(y) and (x == y or x in y or y in x)


def _find_book_dir(md_root: Path, book: str, subject: str = SUBJECT_DIR) -> Path | None:
    """在 MD 根目录下找含 page_*.md 的教材目录（--book 为路径子串）。找不到返回 None。

    只在**本科目**目录下找：--book 是路径子串（如「九年级/上册」），而 output/md 下同年级
    同册的其它学科目录也含这个子串。实测全库搜索会先命中数学书（`output/md/数学/…` 的
    字符串序在 `output/md/语文/…` 之前，九上实测抽到 163 页的数学书）——语文默写管线去抽
    数学教材，且候选清单一条也对不上（偏移直接退化）。
    """
    # --input-dir 既可能给 MD 根目录（output/md），也可能直接给到学科目录
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


def _has_title_line(text: str, title: str) -> bool:
    """该页是否含篇名的「标题行」——带注释角标的行，或整行就是篇名的行。"""
    for line in text.splitlines():
        s = _MD_HEADING_RE.sub("", line.strip())
        s = _NUM_PREFIX_RE.sub("", s)
        if _TITLE_MARKER_RE.search(s):
            # 带角标的标题行：`# 11 岳阳楼记 $^{①}$`、`月夜忆舍弟 $^{①}$ 杜甫`
            if title in _WS_RE.sub("", _TITLE_MARKER_RE.sub("", s)):
                return True
        elif _WS_RE.sub("", s) == title:
            # 篇名独立成行（OCR 偶尔不给角标）
            return True
    return False


def _offset_pairs(candidates: list[dict], pages: list[tuple[int, str]]) -> list[tuple[int, int]]:
    """把候选的 printed_page 与其篇名在 MD 中首次出现的**标题行**页号配成对。

    判「标题行」而不是「篇名在页里出现过」是实测必需（2026-09-14，九上）：目录页
    （page_004-007）逐字含每个篇名（`阅读 11 岳阳楼记/范仲淹 50`、继承页码的裸行
    `咸阳城东楼/许浑`），直接取「首次出现」会全部命中目录页，算出的偏移是
    -45…-152 的一堆杂值、众数占比 33% < 50% → 退化成整书滑窗（九上 170 页 ≈ 101k 字，
    整书喂给模型有超上下文的风险）。正文页的篇名标题行必带注释角标或独立成行，目录行两条都不满足。
    """
    pairs: list[tuple[int, int]] = []
    for c in candidates:
        title = _title_of(c.get("label", ""))
        pp = c.get("printed_page")
        if not title or pp is None:
            continue
        for page_no, text in pages:
            if _has_title_line(text, title):
                pairs.append((int(pp), page_no))
                break
    return pairs


def _offset_mode(pairs: list[tuple[int, int]], min_samples: int = 3, min_share: float = 0.5) -> int | None:
    """求「MD 页号 - 印刷页号」的众数偏移。

    样本少于 min_samples、或众数占比低于 min_share → 返回 None（调用方退化为整书滑窗）。
    本函数的意图是「宁可不信也不硬套」：偏移错了会整篇切错。
    """
    if len(pairs) < min_samples:
        return None
    diffs = [md - printed for printed, md in pairs]
    counter: dict[int, int] = {}
    for d in diffs:
        counter[d] = counter.get(d, 0) + 1
    offset, n = max(counter.items(), key=lambda kv: kv[1])
    return offset if n / len(diffs) >= min_share else None


def _unit_windows(
    candidates: list[dict],
    pages: list[tuple[int, str]],
    offset: int | None,
    lead: int = LEAD_PAGES,
) -> list[tuple[str, list[str]]]:
    """按 unit_label 分组，返回 [(单元标题, 该单元页文本列表)]，顺序为单元物理顺序。

    偏移可靠时按印刷页推算页窗；不可靠时**整书喂给每个单元**（TOC 仅用于完整性核对）。
    页窗上界取「下一个单元的起始页 − 1」与「本单元末篇印刷页 + 尾部余量」的较小者：
    候选清单只收古诗文单元时，相邻两个单元的印刷页可能隔开几十页（九上第三单元末篇
    P65、第六单元首篇 P136，中间第四/第五单元是没进清单的现代文单元），只按前者算会
    把中间整块现代文正文也喂给模型（实测 88 页 58k 字 vs 本单元 21 页 9.8k 字）。
    相邻单元页窗仍允许轻微重叠——重叠不致误切（锚点定位到即可），同篇重复命中由写出
    阶段按 work_title 去重。
    """
    nos = [n for n, _ in pages]
    if not nos:
        return []

    by_unit: dict[str, list[int]] = {}
    order: list[str] = []
    for c in candidates:
        label = c.get("unit_label") or "（未分单元）"
        if label not in by_unit:
            by_unit[label] = []
            order.append(label)
        pp = c.get("printed_page")
        if pp is not None:
            by_unit[label].append(int(pp))

    ordered = sorted([u for u in order if by_unit[u]], key=lambda u: min(by_unit[u]))
    if not ordered:
        return []

    if offset is None:
        return [(u, [t for _, t in pages]) for u in ordered]

    out: list[tuple[str, list[str]]] = []
    for idx, unit in enumerate(ordered):
        lo = min(by_unit[unit]) + offset - lead
        if idx + 1 < len(ordered):
            next_lo = min(by_unit[ordered[idx + 1]]) + offset - 1
            hi = min(next_lo, max(by_unit[unit]) + offset + WINDOW_TAIL)
        else:
            hi = max(nos) + WINDOW_TAIL
        out.append((unit, [t for n, t in pages if lo <= n <= hi]))
    return out


def _units_without_page(candidates: list[dict]) -> list[str]:
    """返回「候选全无 printed_page」的单元——这类单元算不出页窗，须在候选阶段避免。

    Task 12 实测发现：「课外古诗词诵读」下的诗题落在 supplements 里且没有页码；
    若该组的栏目行（如 `课外古诗词诵读 159`，带页码）没被收进候选，整组会被 `_unit_windows`
    的 `ordered` 过滤掉、彻底丢掉。`run_extract` 应在开头调用本函数，非空即打印 `[WARN]`
    并把这些单元列进 unresolved 报告（宁可让人看见，也不要静默丢一篇）。
    """
    seen: dict[str, bool] = {}
    for c in candidates:
        label = c.get("unit_label") or "（未分单元）"
        seen.setdefault(label, False)
        if c.get("printed_page") is not None:
            seen[label] = True
    return [u for u, has_page in seen.items() if not has_page]


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
        print(f"[ERROR] 候选清单不存在：{cand_path}（先跑 Task 3 并由用户确认）", flush=True)
        return 1
    candidates = json.loads(cand_path.read_text(encoding="utf-8"))

    pages = _md_pages(book_md_dir)
    chrome = compute_book_chrome(book_md_dir)
    # 逐页：剥运行页眉 → 切掉页尾注释块。两步都必须在 join_pages 之前按页做，
    # 否则跨页文言文的中间各页注释会落进切片区间（实测醉翁亭记 775 字含 〔〕）。
    clean = [(n, cut_page_annotations(strip_chrome(t, chrome))) for n, t in pages]

    offset = _offset_mode(_offset_pairs(candidates, clean))
    mode = "印刷页偏移" if offset is not None else "整书滑窗（偏移不可靠）"
    print(f"[ok] 页数 {len(pages)}，定位模式：{mode}" + (f"，偏移 {offset}" if offset is not None else ""), flush=True)

    llm = create_llm_client(
        provider=config.llm_provider, api_key=config.llm_api_key or "",
        auth_token=config.llm_auth_token, model=config.llm_model,
        base_url=config.llm_base_url, timeout=config.llm_timeout,
        max_tokens=config.llm_max_tokens, max_retries=config.llm_max_retries,
        thinking=config.llm_thinking, enable_cache=config.llm_enable_cache,
    )
    prompt = _load_prompt("dictation_locate")
    repair_prompt = _load_prompt("dictation_repair")

    # 正文纠正的兜底模型（用户 2026-09-14 指定：本地优先、ds flash 兜底）。
    # 未配置 LLM_FALLBACK_* 时只试主模型，不报错——纠正本就是尽力而为的一步。
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

    rows: list[dict] = []
    unresolved: list[tuple[str, str, str]] = []      # (篇名或单元, 原因, 细节)
    seen_titles: set[str] = set()

    # 候选里全无印刷页码的单元算不出页窗，会被下面的分组整块跳过——先响亮报出来
    for unit_label in _units_without_page(candidates):
        print(f"[WARN] 单元「{unit_label}」的候选全无 printed_page，算不出页窗，整块无法定位", flush=True)
        unresolved.append((unit_label, "候选无印刷页码", "该单元候选全无 printed_page，算不出页窗"))

    for unit_label, unit_pages in _unit_windows(candidates, clean, offset):
        unit_text = join_pages(unit_pages)
        if not unit_text.strip():
            unresolved.append((unit_label, "单元页窗为空", "偏移/滑窗未覆盖到任何页"))
            continue
        try:
            located = locate_unit(llm, unit_label, unit_text, prompt)
        except Exception as e:                        # LLM 失败不阻断整册
            print(f"[ERROR] 单元「{unit_label}」LLM 定位失败：{e}", flush=True)
            unresolved.append((unit_label, "LLM 定位失败", str(e)[:200]))
            continue

        # 逐条校验失败的条目（Task 4 的 LocateResult.rejected）——必须暴露，不能静默丢
        for reason in located.rejected:
            unresolved.append((unit_label, "条目校验失败被跳过", reason))

        found_titles: set[str] = set()
        for p in located.passages:
            if not p.is_classical:
                continue
            title = p.work_title.strip()
            if not title:
                unresolved.append((unit_label, "缺少篇名", p.reason[:120]))
                continue
            if title in seen_titles or title in found_titles:
                continue                              # 页窗重叠导致的重复命中
            found_titles.add(title)

            body = slice_body(unit_text, p.body_start_anchor, p.body_end_anchor)
            if body is None:
                unresolved.append((title, "锚点未找到", f"start={p.body_start_anchor!r} end={p.body_end_anchor!r}"))
                continue
            body = normalize_body(body)
            checked = check_body(body, title, p.genre, chrome)
            # 自检未过 → 交给模型纠正（本地优先、ds flash 兜底），**模型输出即采用**
            # （用户 2026-09-14 裁决：不设采纳闸门）。只有两个模型都拿不出非空输出时
            # 才维持 fail-closed（不进 JSONL，进待人工处理清单）。
            original_body: str | None = None
            repair_note = ""
            repair_errors: list[str] = []
            residual: list[str] = []
            if checked.errors:
                repaired = repair_body(
                    llm, fb_llm,
                    body=body, work_title=title,
                    author=p.author.strip(), dynasty=p.dynasty.strip(),
                    genre=p.genre, errors=checked.errors,
                    chrome=chrome, prompt=repair_prompt,
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
                # 复核标记按**纠正稿**重算：纠正可能消掉或引入 needs_review
                checked = check_body(body, title, p.genre, chrome)

            seen_titles.add(title)
            rows.append({
                "subject_id": "chinese", "work_title": title,
                "author": p.author.strip(), "dynasty": p.dynasty.strip(), "body": body,
                "semester": args.term, "grade_band": "junior", "grade": "九年级",
                "_sort_order": len(rows) + 1,
                "source_ref": f"{book_name} {unit_label}",
                "verified": 1,
                "_genre": p.genre,
                "_needs_review": checked.needs_review,
                "_review_reasons": checked.review_reasons,
                "_reason": p.reason,
                "_repair_note": repair_note,
                "_original_body": original_body,
                "_repair_errors": repair_errors,
                "_repair_residual": residual,
            })

        # 目录里列了、但本单元没被 LLM 找出来的 → 漏收信号，必须让用户看到
        for c in candidates:
            if (c.get("unit_label") or "（未分单元）") != unit_label:
                continue
            t = _title_of(c.get("label", ""))
            if t and not any(_same_work(t, seen) for seen in found_titles | seen_titles):
                unresolved.append((t, "目录有但页文本中未找到", f"{unit_label} p{c.get('printed_page')}"))

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
        # 入库（Task 9）：读 JSONL + 走 dictation_passages 幂等写入，本任务未接线
        print("[ERROR] --load（入库）由后续任务实现，当前 CLI 未接线", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
