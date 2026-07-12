"""extract 子命令入口。"""

import argparse
import json
from pathlib import Path

from checkpoint import RefineryCheckpoint
from config import RefineryConfig
from extract import Extractor
from llm import LLMClient
from markdown_scanner import MarkdownScanner, MarkdownSource


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="从 Markdown 提取题目或卡片")
    parser.add_argument("--input-dir", help="Markdown 输入目录（默认 tools/data-refinery/output/md）")
    parser.add_argument("--output-dir", help="提取结果输出目录（默认 tools/data-refinery/output/extracted）")
    parser.add_argument("--source", choices=["all", "zgkao", "smartedu"], default="all", help="素材来源过滤")
    parser.add_argument("--force", action="store_true", help="强制重新提取")
    parser.add_argument("--dry-run", action="store_true", help="只打印将要处理的 Markdown")
    return parser.parse_args(argv)


def _load_prompt(kind: str) -> str:
    prompt_path = Path(__file__).with_suffix("").parent / "prompts" / f"{kind}.txt"
    return prompt_path.read_text(encoding="utf-8")


def _match_source(source: MarkdownSource, filter_value: str) -> bool:
    if filter_value == "all":
        return True
    name = source.rel_path.name
    if filter_value == "zgkao":
        return "试卷" in name or "答案" in name
    if filter_value == "smartedu":
        return "试卷" not in name and "答案" not in name
    return False


def main(argv=None):
    args = parse_args(argv)
    config = RefineryConfig.from_env(
        input_dir=None,
        output_dir=args.output_dir or None,
    )
    md_dir = Path(args.input_dir) if args.input_dir else config.output_dir / "md"
    extracted_dir = config.output_dir / "extracted"

    scanner = MarkdownScanner(md_dir)
    checkpoint = RefineryCheckpoint(config.output_dir / ".checkpoint.json")
    checkpoint.load()

    llm = LLMClient(
        api_key=config.llm_api_key or "",
        model=config.llm_model,
        base_url=config.llm_base_url,
        timeout=config.llm_timeout,
    )

    sources = [s for s in scanner.scan() if _match_source(s, args.source)]
    if args.dry_run:
        for s in sources:
            print(f"[dry-run] {s.rel_path} ({s.kind})")
        return

    extracted = 0
    skipped = 0
    failed = 0

    for source in sources:
        # 文件级唯一键：目录 + md 文件名，确保同一本书的每一页都有独立的 checkpoint 与输出路径，
        # 避免教材扁平结构（多页共享同一 rel_path 目录）时第一页后其余页被 skip 或输出互相覆盖。
        rel_file = source.rel_path / source.md_path.name
        file_key = str(rel_file)
        if not args.force and checkpoint.is_extracted(file_key):
            skipped += 1
            continue
        try:
            prompt = _load_prompt("exam_questions" if source.kind == "questions" else "textbook_cards")
            extractor = Extractor(llm=llm, prompt=prompt, kind=source.kind)
            result = extractor.run(source.md_path)

            # 每份 md 镜像一个 jsonl（md 路径换后缀），多页教材各自独立、互不覆盖。
            out_file = extracted_dir / rel_file.with_suffix(".jsonl")
            out_file.parent.mkdir(parents=True, exist_ok=True)
            with out_file.open("w", encoding="utf-8") as f:
                for item in result.items:
                    f.write(json.dumps(item.model_dump(mode="json"), ensure_ascii=False) + "\n")

            checkpoint.mark_extracted(file_key)
            extracted += 1
        except Exception as e:
            print(f"[ERROR] {file_key}: {e}")
            failed += 1

    print(f"Extracted: {extracted}, Skipped: {skipped}, Failed: {failed}")


if __name__ == "__main__":
    main()
