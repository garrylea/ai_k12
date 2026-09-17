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

## 体裁标定（2026-09-17，服务闯关积分的发分档位）

`chinese_passages.genre` 决定默写/翻译按哪一档发分（诗 2 分 / 文言文 5 分）。本 CLI 提供
两个**只读写、不猜**的入口（spec §4.1：**不用 LLM 猜体裁**——《木兰诗》是诗、《出师表》是文，
但《陋室铭》这类边界确实有争议，猜错就按错的档位发分）：

  python src/dictation_cli.py --export-genre                       # 出待标定清单（Markdown）
  python src/dictation_cli.py --set-genre --id 12 --genre poem     # 单篇
  python src/dictation_cli.py --set-genre --input genre.tsv        # 批量（id<TAB>poem|prose）

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

import pymysql

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
    parser.add_argument("--book", help="教材路径子串，如 '九年级/上册'（--extract / --load / --all 必填）")
    parser.add_argument("--term", choices=["上册", "下册"], help="册次（写入 chinese_passages.semester；--extract / --load / --all 必填）")
    parser.add_argument("--input-dir", help="MD 根目录（默认 output/md）")
    parser.add_argument("--output-dir", help="产物根目录（默认 output/dictation）")
    parser.add_argument("--candidates", help="候选清单 JSON 路径（默认 output/dictation/<book 同名>/candidates.json）")
    parser.add_argument("--extract", action="store_true", help="定位 + 切片 + 自检，出 JSONL 与两份清单")
    parser.add_argument("--load", action="store_true", help="把 JSONL 入库（幂等）")
    parser.add_argument("--all", action="store_true", help="等价于 --extract --load")
    parser.add_argument("--export-genre", action="store_true", help="导出待标定体裁清单（Markdown 表格）")
    parser.add_argument("--set-genre", action="store_true", help="写回篇目体裁：--id+--genre（单篇）或 --input（批量）")
    parser.add_argument("--id", type=int, help="单篇标定：chinese_passages.id")
    parser.add_argument("--genre", help="单篇标定：poem | prose")
    parser.add_argument("--input", help="批量标定文件：每行 `id<TAB>poem|prose`，空行与 # 注释跳过")

    args = parser.parse_args(argv)

    # 动作互斥：抽取/入库与体裁标定是两条互不相干的路径，混着传必然是误用。
    actions = [args.extract, args.load, args.all]
    genre_actions = [args.export_genre, args.set_genre]
    if sum(actions) + sum(genre_actions) != 1:
        parser.error("需且只能指定 --extract / --load / --all / --export-genre / --set-genre 之一")
    # 体裁标定只碰数据库，不需要教材定位参数；抽取/入库缺一不可（旧行为保留）。
    if any(actions) and (not args.book or not args.term):
        parser.error("--extract / --load / --all 必须同时给 --book 与 --term")
    return args


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


def _author_of(label: str) -> str:
    """从 TOC 的 label 取**作者**（`南安军 / 文天祥` → `文天祥`）；没有则返回空串。

    **作者以教材目录为准，不交给 LLM**（2026-09-14 实测教训）：九下《南安军》的目录
    白纸黑字写着「/ 文天祥」，`ask_identity` 却回了「韩偓 / 唐」（韩偓是唐代诗人，张冠李戴）。
    教材目录是权威且免费的，凡它给了作者就用它；LLM 只在目录没写时才补（如《十五从军征》
    在目录里没有作者）。两者不一致时**留痕进复核**，不静默采用。
    """
    parts = _NUM_PREFIX_RE.sub("", label.strip()).split("/")
    return parts[1].strip() if len(parts) >= 2 else ""


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
                        offset: int | None) -> list[tuple[str, int | None, int, str, str]]:
    """返回按锚点页排序的 [(篇名, 印刷页, 锚点页, 单元标题, 目录里的作者)]。

    锚点找不到的丢弃（调用方另行报告）。
    """
    rows: list[tuple[str, int | None, int, str, str]] = []
    for c in candidates:
        label = c.get("label", "")
        title = _title_of(label)
        printed = c.get("printed_page")
        if not title:
            continue
        anchor = find_anchor_page(title, printed, pages, offset)
        if anchor is None:
            continue
        rows.append((title, printed, anchor,
                     c.get("unit_label") or "（未分单元）", _author_of(label)))
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

    for index, (title, printed, anchor, unit_label, toc_author) in enumerate(ordered):
        if title in seen_titles:
            continue
        next_anchor = ordered[index + 1][2] if index + 1 < len(ordered) else None
        others = frozenset(t for t in all_titles if t != norm_title(title))

        located = locate_body(title, printed, clean, offset, next_anchor, others)
        if located is None:
            unresolved.append((title, "未切出正文",
                               f"锚点页 {anchor}｜印刷页 {printed}"))
            continue

        # 朝代/体裁问 LLM；**作者优先取教材目录**，并把目录的作者**告诉模型**——
        # 否则模型会先猜错作者再据错作者给朝代（实测《南安军》猜「韩偓」→朝代「唐」，
        # 正确是 文天祥/宋；《临江仙》猜「陈廷焯」→「清」，正确是 陈与义/宋）。
        review_reasons_extra: list[str] = []
        try:
            identity = ask_identity(llm, title, identity_prompt, known_author=toc_author)
        except Exception as e:
            identity = None
            print(f"[WARN] 《{title}》朝代/体裁获取失败：{e}", flush=True)
            review_reasons_extra.append(f"朝代/体裁获取失败（{str(e)[:80]}）")

        genre = identity.genre if identity else "other"
        dynasty = identity.dynasty if identity else ""
        author = toc_author or (identity.author if identity else "")
        if toc_author and identity and identity.model_author and identity.model_author != toc_author:
            # 即使把作者告诉了模型，仍比对它自己的答复——实测 4/48 篇模型答错过作者
            review_reasons_extra.append(
                f"作者分歧：目录作「{toc_author}」，模型作「{identity.model_author}」，已采用目录")

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

    print(f"[ok] 入库完成：篇目 upsert {stats['passages_upserted']}", flush=True)
    return 0


# ==================== 体裁标定（--export-genre / --set-genre） ====================
#
# `chinese_passages.genre` 决定默写/翻译按哪一档发分（'poem' 诗/词、'prose' 文言文），
# NULL = 未标定（发分时跳过并留日志）。**不用 LLM 猜体裁**：短字段猜错没有兜底，
# 且边界篇目（如《陋室铭》）本身有争议——工具只负责读写，人来决定。

#: 合法体裁。只认这两个值，不接收同义词（'shi' / 'wen' / '诗词' 一律拒绝）。
GENRES: tuple[str, ...] = ("poem", "prose")

#: 待标定清单的文件名（相对 output/dictation/语文/）。
GENRE_EXPORT_NAME = "genre-todo.md"


def validate_genre(value: str) -> str:
    """校验体裁并去空白；非法值抛 `ValueError`。

    刻意不做「模糊匹配」：`shi`、`古诗`、`poem `（带别的东西）都拒绝——
    批量文件里一个拼错的词会静默标错体裁，进而按错档发分，宁可让整批失败。
    """
    genre = (value or "").strip()
    if genre not in GENRES:
        raise ValueError(f"genre 必须是 {' | '.join(GENRES)}（收到 {value!r}）")
    return genre


def parse_genre_updates(text: str) -> list[tuple[int, str]]:
    """解析批量标定文件内容，返回 `[(passage_id, genre)]`。

    格式：一行一条 `id<TAB>poem|prose`；空行与 `#` 注释跳过。
    任何一行不合规（列数不对 / id 非正整数 / genre 非法）都抛 `ValueError`——
    在碰数据库**之前**整份校验完，避免写到一半才发现第 30 行是错的。
    """
    updates: list[tuple[int, str]] = []
    for lineno, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue

        parts = line.split("\t")
        if len(parts) != 2:
            raise ValueError(f"第 {lineno} 行格式应为「id<TAB>poem|prose」：{raw!r}")
        id_text, genre_text = parts[0].strip(), parts[1].strip()
        if not id_text.isdigit() or int(id_text) <= 0:
            raise ValueError(f"第 {lineno} 行的 id 必须是正整数（收到 {id_text!r}）")
        try:
            genre = validate_genre(genre_text)
        except ValueError as e:
            raise ValueError(f"第 {lineno} 行：{e}") from e
        updates.append((int(id_text), genre))
    return updates


def render_genre_table(rows: list[tuple]) -> str:
    """把 `(id, work_title, dynasty, genre)` 渲染成 Markdown 表格（空体裁标 `待定`）。"""
    lines = [
        "# 待标定体裁清单",
        "",
        "`genre` 决定默写/翻译按哪一档发分（`poem` 诗/词、`prose` 文言文），**不猜、不默认**。",
        "填好后用 `--set-genre --input <文件>` 批量写回，或 `--set-genre --id <n> --genre poem|prose` 单篇写回。",
        "",
        "| id | 篇名 | 朝代 | 体裁 |",
        "|---|---|---|---|",
    ]
    for passage_id, work_title, dynasty, genre in rows:
        lines.append(f"| {passage_id} | {work_title} | {dynasty or ''} | {genre or '待定'} |")
    if not rows:
        lines.append("| - | （无 verified 篇目） | | |")
    return "\n".join(lines) + "\n"


def _connect(config: RefineryConfig):
    """体裁标定专用的数据库连接（不重跑抽取，只读写 `chinese_passages.genre`）。"""
    return pymysql.connect(host=config.db_host, port=config.db_port, user=config.db_user,
                           password=config.db_pass, database=config.db_name, charset="utf8mb4")


def _genre_out_path(args, config) -> Path:
    out_root = Path(args.output_dir) if args.output_dir else config.output_dir / "dictation"
    return out_root / SUBJECT_DIR / GENRE_EXPORT_NAME


def run_export_genre(args, config) -> int:
    """导出待标定清单：`verified = 1` 的篇目按册次/篇序排，空体裁标 `待定`。"""
    conn = _connect(config)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, work_title, dynasty, genre FROM chinese_passages "
                "WHERE verified = 1 ORDER BY semester, sort_order"
            )
            rows = list(cur.fetchall())
    finally:
        conn.close()

    path = _genre_out_path(args, config)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render_genre_table(rows), encoding="utf-8")
    unset = sum(1 for r in rows if not r[3])
    print(f"[ok] 待标定体裁清单 -> {path}（{len(rows)} 篇，其中未标定 {unset} 篇）", flush=True)
    return 0


def _set_one_genre(conn, passage_id: int, genre: str) -> bool:
    """写回一篇并打印篇名；该 id 不存在时跳过（返回 False）。"""
    with conn.cursor() as cur:
        cur.execute("SELECT work_title FROM chinese_passages WHERE id = %s LIMIT 1", (passage_id,))
        found = cur.fetchone()
        if not found:
            print(f"[WARN] 未找到篇目 id={passage_id}，跳过", flush=True)
            return False
        cur.execute("UPDATE chinese_passages SET genre = %s WHERE id = %s", (genre, passage_id))
    print(f"[ok] 《{found[0]}》 -> {genre}", flush=True)
    return True


def run_set_genre(args, config) -> int:
    """写回体裁：单篇（`--id` + `--genre`）或批量（`--input`，整份先校验再落库）。"""
    if args.input:
        if args.id is not None or args.genre is not None:
            print("[ERROR] --input 与 --id/--genre 互斥", flush=True)
            return 2
        path = Path(args.input)
        if not path.exists():
            print(f"[ERROR] 批量文件不存在：{path}", flush=True)
            return 1
        try:
            updates = parse_genre_updates(path.read_text(encoding="utf-8"))
        except ValueError as e:
            print(f"[ERROR] {e}", flush=True)
            return 2
        if not updates:
            print("[WARN] 批量文件里没有可写回的行（空行与 # 注释会被跳过）", flush=True)
            return 1
    elif args.id is not None or args.genre is not None:
        if args.id is None or args.genre is None:
            print("[ERROR] 单篇标定需同时给 --id 与 --genre", flush=True)
            return 2
        try:
            updates = [(args.id, validate_genre(args.genre))]
        except ValueError as e:
            print(f"[ERROR] {e}", flush=True)
            return 2
    else:
        print("[ERROR] --set-genre 需给 --id+--genre 或 --input <file>", flush=True)
        return 2

    conn = _connect(config)
    updated = 0
    try:
        for passage_id, genre in updates:
            if _set_one_genre(conn, passage_id, genre):
                updated += 1
        conn.commit()
    finally:
        conn.close()

    print(f"[ok] 体裁写回完成：{updated}/{len(updates)} 篇", flush=True)
    return 0


def main(argv=None) -> int:
    args = parse_args(argv)
    if args.export_genre or args.set_genre:
        config = RefineryConfig.from_env()
        return run_export_genre(args, config) if args.export_genre else run_set_genre(args, config)

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
