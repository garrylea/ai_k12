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
    parser.add_argument("--output-dir", help="输出根目录（MD 落 {该目录}/md/ 下；默认 tools/data-refinery/output）")
    parser.add_argument("--source", choices=["all", "zgkao", "smartedu"], default="all", help="素材来源过滤")
    parser.add_argument("--force", action="store_true", help="跳过 checkpoint，尝试继续处理未转完的页")
    parser.add_argument("--reconvert", action="store_true", help="删除已有输出，重新转换所有页")
    parser.add_argument("--dry-run", action="store_true", help="只打印将要处理的素材")
    parser.add_argument("--materials", help="只处理 rel_path 包含指定子串的素材，逗号分隔多个")
    parser.add_argument("--materials-file", help="素材列表文件，一行一个子串，# 开头为注释，空行忽略")
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


def _load_material_entries(materials: str | None, materials_file: str | None) -> list[str]:
    entries: list[str] = []
    if materials:
        entries.extend(e.strip() for e in materials.split(","))
    if materials_file:
        for line in Path(materials_file).read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                entries.append(line)
    return [e for e in entries if e]


def _match_materials(material: Material, entries: list[str]) -> bool:
    if not entries:
        return True
    rel = material.rel_path.as_posix()
    return any(entry in rel for entry in entries)


def _warn_unmatched_entries(entries: list[str], materials: list[Material]) -> None:
    for entry in entries:
        if not any(entry in m.rel_path.as_posix() for m in materials):
            print(f"[WARN] 未命中素材: {entry}")


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
    entries = _load_material_entries(args.materials, args.materials_file)
    materials = [m for m in materials if _match_materials(m, entries)]
    if args.dry_run:
        for m in materials:
            print(f"[dry-run] {m.rel_path} ({m.kind})")
        _warn_unmatched_entries(entries, materials)
        return

    converted = 0
    skipped = 0
    failed = 0

    for material in materials:
        rel = str(material.rel_path)
        # reconvert 时清除 checkpoint 记录，确保后续管线（extract 等）也能重新处理
        if args.reconvert and checkpoint.is_converted(rel):
            checkpoint.unmark_converted(rel)
        if not args.force and not args.reconvert and checkpoint.is_converted(rel):
            skipped += 1
            continue
        try:
            converter.convert(material, reconvert=args.reconvert)
            checkpoint.mark_converted(rel)
            converted += 1
        except Exception as e:
            print(f"[ERROR] {rel}: {e}")
            failed += 1

    print(f"Converted: {converted}, Skipped: {skipped}, Failed: {failed}")
    _warn_unmatched_entries(entries, materials)


if __name__ == "__main__":
    main()
