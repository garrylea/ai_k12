"""toc_parse 子命令入口。扫描教材 MD 目录，找目录页，LLM 解析为结构化 TOC JSON。"""

import argparse
import json
from pathlib import Path

from checkpoint import RefineryCheckpoint
from config import RefineryConfig
from llm import LLMClient
from extract_cli import _load_prompt


def _find_toc_pages(book_dir: Path, max_pages: int = 10) -> list[Path]:
    """在教材 MD 目录中找目录页。前 max_pages 页内 MD 内容包含 '目录' 的页。"""
    mds = sorted(book_dir.glob("page_*.md"))
    if not mds:
        return []
    candidates = mds[:max_pages]
    found = [p for p in candidates if "目录" in p.read_text(encoding="utf-8")]
    if not found and max_pages == 10:
        return _find_toc_pages(book_dir, max_pages=20)
    return found


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="从教材目录页 LLM 提取章节结构")
    parser.add_argument("--input-dir", help="MD 目录（默认 output/md）")
    parser.add_argument("--output-dir", help="TOC JSON 输出目录（默认 output/toc）")
    parser.add_argument("--book", help="只处理指定教材（路径子串匹配，如'九年级/下册'）")
    parser.add_argument("--reconvert", action="store_true", help="清除 checkpoint + 删除已有 TOC JSON，重新解析")
    parser.add_argument("--dry-run", action="store_true", help="只打印将要处理的目录页")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    config = RefineryConfig.from_env(input_dir=None, output_dir=args.output_dir or None)
    md_dir = Path(args.input_dir) if args.input_dir else config.output_dir / "md"
    toc_dir = Path(args.output_dir) if args.output_dir else config.output_dir / "toc"

    checkpoint = RefineryCheckpoint(config.output_dir / ".toc_checkpoint.json")
    checkpoint.load()

    book_dirs = sorted(md_dir.glob("*/*/*/*/*"))
    if args.book:
        book_dirs = [d for d in book_dirs if args.book in str(d.relative_to(md_dir))]

    if args.dry_run:
        for d in book_dirs:
            pages = _find_toc_pages(d)
            if pages:
                print(f"[dry-run] {d.relative_to(md_dir)} -> {len(pages)} toc page(s)", flush=True)
        return

    llm = LLMClient(
        provider=config.llm_provider, api_key=config.llm_api_key or "",
        auth_token=config.llm_auth_token, model=config.llm_model,
        base_url=config.llm_base_url, timeout=config.llm_timeout,
        max_tokens=config.llm_max_tokens,
    )
    prompt = _load_prompt("toc_parse")

    parsed = skipped = failed = 0
    for book_dir in book_dirs:
        toc_pages = _find_toc_pages(book_dir)
        if not toc_pages:
            print(f"[WARN] {book_dir.relative_to(md_dir)}: no toc pages found", flush=True)
            continue

        book_key = str(book_dir.relative_to(md_dir))

        if not args.reconvert and checkpoint.is_toc_parsed(book_key):
            skipped += 1
            print(f"[skip] {book_key}", flush=True)
            continue

        if args.reconvert:
            if checkpoint.is_toc_parsed(book_key):
                checkpoint.unmark_toc_parsed(book_key)
            out_file = toc_dir / f"{book_key}.json"
            if out_file.exists():
                out_file.unlink()
                print(f"[reconvert] deleted {out_file}", flush=True)

        try:
            toc_text = "\n\n".join(p.read_text(encoding="utf-8") for p in toc_pages)
            response = llm.complete(prompt, toc_text)
            data = json.loads(response.content)

            out_file = toc_dir / f"{book_key}.json"
            out_file.parent.mkdir(parents=True, exist_ok=True)
            out_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

            checkpoint.mark_toc_parsed(book_key)
            chapters = len(data.get("chapters", []))
            print(f"[ok] {book_key} -> {chapters} chapter(s)", flush=True)
            parsed += 1
        except Exception as e:
            print(f"[ERROR] {book_key}: {e}", flush=True)
            if "json" in str(e).lower() or "decode" in str(e).lower():
                try:
                    response2 = llm.complete(prompt, toc_text)
                    data2 = json.loads(response2.content)
                    out_file = toc_dir / f"{book_key}.json"
                    out_file.parent.mkdir(parents=True, exist_ok=True)
                    out_file.write_text(json.dumps(data2, ensure_ascii=False, indent=2), encoding="utf-8")
                    checkpoint.mark_toc_parsed(book_key)
                    chapters = len(data2.get("chapters", []))
                    print(f"[ok] {book_key} -> {chapters} chapter(s) (retry)", flush=True)
                    parsed += 1
                except Exception as e2:
                    print(f"[ERROR] {book_key}: retry also failed: {e2}", flush=True)
                    failed += 1
            else:
                failed += 1

    print(f"TOC parsed: {parsed}, Skipped: {skipped}, Failed: {failed}", flush=True)


if __name__ == "__main__":
    main()
