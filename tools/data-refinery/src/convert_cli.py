"""convert 子命令入口。"""

import argparse
from pathlib import Path

from checkpoint import RefineryCheckpoint
from config import RefineryConfig
from convert import Converter, MineruRunner
from scanner import Material, MaterialScanner
from scope_filter import build_scope, match_scope
from scope_filter import parse_dimensions as _parse_dimensions  # 兼容旧引用/单测


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
    parser.add_argument("--subject", help="学科过滤，精确匹配目录第 1 段（如 数学、语文），逗号分隔多个")
    parser.add_argument("--stage", help="学段过滤，第 2 段（初中/小学/高中，或 junior/primary/senior），逗号分隔多个")
    parser.add_argument("--term", help="学期过滤：试卷用 first/second（可写 上/下），教材用 上册/下册，逗号分隔多个")
    parser.add_argument("--year", help="年份过滤（4 位，仅试卷素材，如 2025），逗号分隔多个")
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


def _match_filters(
    material: Material,
    subject: str | None = None,
    stage: str | None = None,
    term: str | None = None,
    year: str | None = None,
) -> bool:
    """按学科/学段/学期/年份精确过滤（语义与 extract/publish/db_loader 一致）。"""
    return match_scope(material.rel_path, build_scope(subject, stage, term, year))


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
    """按全量扫描结果判定，避免被 --source 过滤后误报未命中。"""
    for entry in entries:
        if not any(entry in m.rel_path.as_posix() for m in materials):
            print(f"[WARN] 未命中素材: {entry}")


def _warn_no_match(materials: list[Material], filters_active: bool) -> None:
    """带了过滤条件却一个素材都没剩下时提示，避免静默空转。"""
    if filters_active and not materials:
        print("[WARN] 过滤条件未命中任何素材（--source/--materials/--subject/--stage/--term/--year）")


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

    scanned = scanner.scan()
    materials = [m for m in scanned if _match_source(m, args.source)]
    entries = _load_material_entries(args.materials, args.materials_file)
    materials = [m for m in materials if _match_materials(m, entries)]
    materials = [
        m for m in materials
        if _match_filters(m, subject=args.subject, stage=args.stage, term=args.term, year=args.year)
    ]
    filters_active = bool(entries) or args.source != "all" or any(
        (args.subject, args.stage, args.term, args.year)
    )
    if args.dry_run:
        for m in materials:
            print(f"[dry-run] {m.rel_path} ({m.kind})")
        _warn_unmatched_entries(entries, scanned)
        _warn_no_match(materials, filters_active)
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
    _warn_unmatched_entries(entries, scanned)
    _warn_no_match(materials, filters_active)


if __name__ == "__main__":
    main()
