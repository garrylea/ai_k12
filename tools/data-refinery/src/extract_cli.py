"""extract 子命令入口。

处理流程：image_scan → card_splitter → LLM card_labeler
- Python 程序拆分卡片（内容不动）
- LLM 仅标注（page_type / card_type / lesson_id / title）
"""

import argparse
import json
from pathlib import Path

from card_labeler import CardLabeler
from card_splitter import split_page
from checkpoint import RefineryCheckpoint
from config import RefineryConfig
from image_scan import scan_page
from llm import LLMClient
from markdown_scanner import MarkdownScanner, MarkdownSource
from models import TextbookCard


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="从 Markdown 提取教材卡片")
    parser.add_argument("--input-dir", help="Markdown 输入目录（默认 output/md）")
    parser.add_argument("--output-dir", help="提取结果输出目录（默认 output/extracted）")
    parser.add_argument("--source", choices=["all", "zgkao", "smartedu"], default="all")
    parser.add_argument("--file", help="只提取匹配的文件（相对路径子串匹配）")
    parser.add_argument("--pages", help="只提取指定页码，如 '1-6' 或 '1,3,5-8'")
    parser.add_argument("--book", help="只提取指定教材（路径子串匹配，如'九年级/上册'）")
    parser.add_argument("--force", action="store_true", help="强制重新提取（忽略 checkpoint，但不删除已有输出）")
    parser.add_argument("--reconvert", action="store_true", help="清除 checkpoint + 删除已有 JSONL，重新提取匹配页")
    parser.add_argument("--toc", help="TOC JSON 路径，用于校验 lesson_id + 自动修正")
    parser.add_argument("--dry-run", action="store_true", help="只打印将要处理的 Markdown")
    return parser.parse_args(argv)


def _load_prompt(kind: str) -> str:
    prompt_path = Path(__file__).with_suffix("").parent / "prompts" / f"{kind}.txt"
    return prompt_path.read_text(encoding="utf-8")


def _match_source(source: MarkdownSource, filter_value: str) -> bool:
    if filter_value == "all":
        return True
    name = source.md_path.name
    if filter_value == "zgkao":
        return "试卷" in name or "答案" in name
    if filter_value == "smartedu":
        return "试卷" not in name and "答案" not in name
    return False


def _parse_pages(pages_spec: str) -> set[int]:
    """Parse page spec like '1-6' or '1,3,5-8' into a set of page numbers."""
    result: set[int] = set()
    for part in pages_spec.split(","):
        part = part.strip()
        if "-" in part:
            lo, hi = part.split("-", 1)
            result.update(range(int(lo.strip()), int(hi.strip()) + 1))
        else:
            result.add(int(part))
    return result


def _match_pages(md_name: str, page_nums: set[int]) -> bool:
    """Check if page_XXX.md matches any of the given page numbers."""
    import re
    m = re.search(r"page_(\d+)", md_name)
    if m:
        return int(m.group(1)) in page_nums
    return False


def _levenshtein(a: str, b: str) -> int:
    """计算两个字符串的编辑距离（Levenshtein distance）。"""
    if len(a) < len(b):
        return _levenshtein(b, a)
    if len(b) == 0:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(
                prev[j] + 1,
                cur[-1] + 1,
                prev[j - 1] + (0 if ca == cb else 1),
            ))
        prev = cur
    return prev[-1]


def _flatten_toc_labels(toc: dict) -> list[str]:
    """从 TOC JSON 提取所有合法的 lesson_id 标签（扁平列表）。"""
    labels: list[str] = []
    for ch in toc.get("chapters", []):
        if ch.get("label"):
            labels.append(ch["label"])
        for sec in ch.get("sections", []):
            if sec.get("label"):
                labels.append(sec["label"])
            for sub in sec.get("subsections", []):
                if sub.get("label"):
                    labels.append(sub["label"])
        for supp in ch.get("supplements", []):
            if supp.get("label"):
                labels.append(supp["label"])
    return labels


def validate_and_correct(cards_by_file: dict, toc: dict, output_dir: Path) -> dict:
    """校验 card 的 lesson_id 与 TOC 的一致性，自动修正编辑距离 ≤2 的不匹配。

    Args:
        cards_by_file: {file_key: [card_dict, ...]}
        toc: parsed TOC JSON
        output_dir: directory for diff_report.json

    Returns:
        dict: diff_report with matched/corrected/unmatched/missing_from_cards/summary
    """
    toc_labels = _flatten_toc_labels(toc)
    diff_report = {
        "book": toc.get("book", ""),
        "matched": 0,
        "corrected": [],
        "unmatched": [],
        "missing_from_cards": list(toc_labels),
        "summary": "",
    }
    all_card_labels: set[str] = set()

    for file_key, cards in cards_by_file.items():
        for card in cards:
            lid = card.get("lesson_id")
            if not lid:
                continue
            all_card_labels.add(lid)

            if lid in toc_labels:
                diff_report["matched"] += 1
                if lid in diff_report["missing_from_cards"]:
                    diff_report["missing_from_cards"].remove(lid)
                continue

            # Fuzzy match: Levenshtein distance ≤ 2
            if not toc_labels:
                diff_report["unmatched"].append(lid)
                continue
            best = min(toc_labels, key=lambda t: _levenshtein(lid, t))
            dist = _levenshtein(lid, best)
            if dist <= 2:
                card["lesson_id"] = best
                diff_report["corrected"].append({
                    "original": lid, "corrected": best, "distance": dist,
                })
                if best in diff_report["missing_from_cards"]:
                    diff_report["missing_from_cards"].remove(best)
            else:
                diff_report["unmatched"].append(lid)

    diff_report["summary"] = (
        f"{diff_report['matched']} matched, "
        f"{len(diff_report['corrected'])} auto-corrected, "
        f"{len(diff_report['unmatched'])} unmatched, "
        f"{len(diff_report['missing_from_cards'])} missing (TOC has but cards don't)"
    )
    return diff_report


def main(argv=None):
    args = parse_args(argv)
    config = RefineryConfig.from_env(
        input_dir=None, output_dir=args.output_dir or None,
    )
    md_dir = Path(args.input_dir) if args.input_dir else config.output_dir / "md"
    extracted_dir = config.output_dir / "extracted"

    scanner = MarkdownScanner(md_dir)
    checkpoint = RefineryCheckpoint(config.output_dir / ".checkpoint.json")
    checkpoint.load()

    llm = LLMClient(
        provider=config.llm_provider,
        api_key=config.llm_api_key or "",
        auth_token=config.llm_auth_token,
        model=config.llm_model,
        base_url=config.llm_base_url,
        timeout=config.llm_timeout,
        max_tokens=config.llm_max_tokens,
    )
    prompt = _load_prompt("textbook_cards")
    labeler = CardLabeler(llm=llm, prompt_template=prompt)

    sources = [s for s in scanner.scan() if _match_source(s, args.source)]
    if args.file:
        sources = [s for s in sources if args.file in str(s.rel_path / s.md_path.name)]
    if args.pages:
        page_nums = _parse_pages(args.pages)
        sources = [s for s in sources if _match_pages(s.md_path.name, page_nums)]
    if args.book:
        sources = [s for s in sources if args.book in str(s.rel_path)]
    if args.dry_run:
        for s in sources:
            print(f"[dry-run] {s.rel_path / s.md_path.name} ({s.kind})")
        return

    # --reconvert：清理匹配页的 checkpoint + 删除已有 JSONL
    if args.reconvert:
        cleared = 0
        for source in sources:
            rel_file = source.rel_path / source.md_path.name
            file_key = str(rel_file)
            if checkpoint.is_extracted(file_key):
                checkpoint.unmark_extracted(file_key)
            out_file = extracted_dir / rel_file.with_suffix(".jsonl")
            if out_file.exists():
                out_file.unlink()
                print(f"[reconvert] deleted {out_file}", flush=True)
            cleared += 1
        print(f"[reconvert] cleared checkpoint for {cleared} source(s)", flush=True)

    # Per-book state: 跨页 lesson_id 继承
    book_lesson: dict[str, str | None] = {}

    total_processed = len(sources)
    extracted = 0
    skipped = 0
    failed = 0

    for idx, source in enumerate(sources, 1):
        rel_file = source.rel_path / source.md_path.name
        file_key = str(rel_file)
        book_key = str(source.rel_path)

        if not args.force and not args.reconvert and checkpoint.is_extracted(file_key):
            skipped += 1
            print(f"[skip] ({idx}/{total_processed}) {file_key}", flush=True)
            continue

        try:
            # ① image_scan：获取图片尺寸 + 折算字数
            images = scan_page(source.md_path)

            # ② card_splitter：拆分卡片
            text = source.md_path.read_text(encoding="utf-8")
            cards = split_page(source.md_path, text, images)

            if not cards:
                # 空页，跳过
                checkpoint.mark_extracted(file_key)
                print(f"[ok] ({idx}/{total_processed}) {file_key} -> 0 items (empty)", flush=True)
                extracted += 1
                continue

            # ③ card_labeler：LLM 标注
            page_num = cards[0].textbook_page.replace("P", "") if cards else ""
            prev = book_lesson.get(book_key)

            try:
                result = labeler.label(
                    [c.content for c in cards],
                    page_number=f"P{page_num}",
                    prev_lesson_id=prev,
                )
            except Exception as e:
                print(f"[WARN] ({idx}/{total_processed}) {file_key}: LLM label failed ({e}), using defaults", flush=True)
                # LLM 失败时用默认标注
                from card_labeler import LabelResult, PageLabelResult
                result = PageLabelResult(
                    page_type="content",
                    labels=[LabelResult(
                        page_type="content", card_type="concept",
                        lesson_id=prev, title=None,
                        textbook_page=f"P{page_num}",
                    ) for _ in cards],
                )

            # 前置内容跳过
            if result.page_type == "front_matter":
                checkpoint.mark_extracted(file_key)
                print(f"[ok] ({idx}/{total_processed}) {file_key} -> 0 items (front matter)", flush=True)
                extracted += 1
                continue

            # ④ 组装 TextbookCard
            items = []
            for card, label in zip(cards, result.labels):
                # lesson_id 继承逻辑
                lesson_id = label.lesson_id
                if lesson_id:
                    book_lesson[book_key] = lesson_id
                else:
                    lesson_id = book_lesson.get(book_key)

                items.append(TextbookCard(
                    lesson_id=lesson_id,
                    sort_order=card.sort_order,
                    card_type=label.card_type,
                    title=label.title,
                    content=card.content,
                    content_metadata=None,  # publish 阶段写入
                    knowledge_point_ids=[],
                    textbook_page=label.textbook_page or card.textbook_page,
                ))

            # ⑤ 写入 JSONL
            if items:
                out_file = extracted_dir / rel_file.with_suffix(".jsonl")
                out_file.parent.mkdir(parents=True, exist_ok=True)
                with out_file.open("w", encoding="utf-8") as f:
                    for item in items:
                        f.write(json.dumps(item.model_dump(mode="json"), ensure_ascii=False) + "\n")
                print(f"[ok] ({idx}/{total_processed}) {file_key} -> {len(items)} items", flush=True)
            else:
                print(f"[ok] ({idx}/{total_processed}) {file_key} -> 0 items", flush=True)

            checkpoint.mark_extracted(file_key)
            extracted += 1
        except Exception as e:
            print(f"[ERROR] ({idx}/{total_processed}) {file_key}: {e}", flush=True)
            failed += 1

    # --toc：校验 + 自动修正（在所有 JSONL 写入完成后）
    if args.toc:
        toc_path = Path(args.toc)
        if toc_path.exists():
            toc = json.loads(toc_path.read_text(encoding="utf-8"))
            # 收集所有已写入的 cards
            cards_by_file = {}
            for source in sources:
                rel_file = source.rel_path / source.md_path.name
                out_file = extracted_dir / rel_file.with_suffix(".jsonl")
                if out_file.exists():
                    items = [json.loads(l) for l in out_file.read_text(encoding="utf-8").splitlines() if l.strip()]
                    if items:
                        cards_by_file[str(rel_file)] = items
            report = validate_and_correct(cards_by_file, toc, extracted_dir)
            # 写回修正后的 cards
            for file_key, cards in cards_by_file.items():
                out_file = extracted_dir / file_key.replace(".md", ".jsonl")
                with out_file.open("w", encoding="utf-8") as f:
                    for item in cards:
                        f.write(json.dumps(item, ensure_ascii=False) + "\n")
            # 输出 diff report
            report_path = extracted_dir / "diff_report.json"
            report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"[toc] diff report: {report['summary']}", flush=True)
        else:
            print(f"[WARN] TOC file not found: {args.toc}", flush=True)

    print(f"Extracted: {extracted}, Skipped: {skipped}, Failed: {failed}", flush=True)


if __name__ == "__main__":
    main()
