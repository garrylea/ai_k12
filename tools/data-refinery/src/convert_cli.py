"""convert 子命令入口。"""

import argparse
from pathlib import Path

from checkpoint import RefineryCheckpoint
from config import RefineryConfig
from convert import Converter, MineruRunner
from scanner import Material, MaterialScanner


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="将爬虫素材转换为 Markdown")
    parser.add_argument("--input-dir", help="素材输入目录（默认 tools/crawler/data）")
    parser.add_argument("--output-dir", help="Markdown 输出目录（默认 tools/data-refinery/output/md）")
    parser.add_argument("--source", choices=["all", "zgkao", "smartedu"], default="all", help="素材来源过滤")
    parser.add_argument("--force", action="store_true", help="强制重新转换")
    parser.add_argument("--dry-run", action="store_true", help="只打印将要处理的素材")
    return parser.parse_args(argv)


def _match_source(material: Material, source: str) -> bool:
    if source == "all":
        return True
    name = material.rel_path.name
    if source == "zgkao":
        return "试卷" in name or "答案" in name
    if source == "smartedu":
        return material.kind == "images"
    return False


def main(argv=None):
    args = parse_args(argv)
    config = RefineryConfig.from_env(
        input_dir=args.input_dir,
        output_dir=args.output_dir or None,
    )
    output_md_dir = config.output_dir / "md"

    scanner = MaterialScanner(config.input_dir)
    checkpoint = RefineryCheckpoint(config.output_dir / ".checkpoint.json")
    checkpoint.load()

    runner = MineruRunner(bin_path=config.mineru_bin, timeout=config.mineru_timeout, token=config.mineru_token)
    converter = Converter(runner=runner, output_dir=output_md_dir)

    materials = [m for m in scanner.scan() if _match_source(m, args.source)]
    if args.dry_run:
        for m in materials:
            print(f"[dry-run] {m.rel_path} ({m.kind})")
        return

    converted = 0
    skipped = 0
    failed = 0

    for material in materials:
        rel = str(material.rel_path)
        if not args.force and checkpoint.is_converted(rel):
            skipped += 1
            continue
        try:
            converter.convert(material)
            checkpoint.mark_converted(rel)
            converted += 1
        except Exception as e:
            print(f"[ERROR] {rel}: {e}")
            failed += 1

    print(f"Converted: {converted}, Skipped: {skipped}, Failed: {failed}")


if __name__ == "__main__":
    main()
