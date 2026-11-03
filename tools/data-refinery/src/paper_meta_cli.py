"""paper_meta_cli：把卷面元数据写到 output/meta/<卷>.json（sidecar）。

只读 md、只写 sidecar，不碰库。db_loader 入库时读这份 sidecar 决定
`exam_papers.title/district/grade`（见 paper_head.merge_meta / apply_sidecar）。

参数与其它阶段同源（add_scope_args + --source + --file），由 import_cli 第 4 步透传。
"""

import argparse
import sys
from pathlib import Path

from config import RefineryConfig
from llm import create_llm_client
from markdown_scanner import MarkdownScanner
from material_kind import PAPER, KindCache, MaterialKindUnknown, resolve as resolve_kind
from paper_head import (COLLECTIVE_LOCATIONS, detect_district, detect_exam_type,
                        detect_grade_from_name, detect_school, extract_head_meta,
                        load_sidecar, merge_meta, write_sidecar)
from paper_meta import build_paper_meta, parse_paper_meta, parse_path_parts
from scope_filter import add_scope_args, describe, match_scope, scope_from_args


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="试卷元数据：卷面首屏 -> output/meta sidecar")
    parser.add_argument("--source", choices=["all", "zgkao", "smartedu"], default="all")
    parser.add_argument("--input-dir", help="md 输入目录（默认 output/md）")
    parser.add_argument("--output-dir", help="output 根目录（默认 config.output_dir）")
    add_scope_args(parser)
    parser.add_argument("--dry-run", action="store_true", help="只打印，不写 sidecar")
    parser.add_argument("--no-llm", action="store_true", help="只用规则，不调 LLM 兜底")
    return parser.parse_args(argv)


def _is_paper(source, cache: KindCache) -> bool:
    """类型判定与 extract 同源：名称 → 卷面 → 结构 → 缓存里的用户选择。"""
    key = str(source.rel_path / source.md_path.name)
    try:
        return resolve_kind(key, source.md_path.name, source.md_path, cache,
                            allow_ask=False) == PAPER
    except MaterialKindUnknown:
        return False


def run(cfg: RefineryConfig, args, llm=None) -> int:
    md_dir = Path(args.input_dir) if args.input_dir else cfg.output_dir / "md"
    scanner = MarkdownScanner(md_dir)
    scope = scope_from_args(args)
    kind_cache = KindCache(cfg.output_dir / ".material_kinds.json")
    sources = [s for s in scanner.scan() if _is_paper(s, kind_cache)]
    if scope.active:
        sources = [s for s in sources if match_scope(s.rel_path / s.md_path.name, scope)]
    if args.file:
        sources = [s for s in sources if args.file in str(s.rel_path / s.md_path.name)]
    print(f"[meta] 范围 {describe(scope)} · 命中 {len(sources)} 份试卷", flush=True)
    if not sources:
        return 0

    written = 0
    for s in sources:
        rel_jsonl = (s.rel_path / s.md_path.name).with_suffix(".jsonl")
        text = s.md_path.read_text(encoding="utf-8")
        head = extract_head_meta(text, llm=None if args.no_llm else llm)
        path_meta = parse_paper_meta(rel_jsonl.as_posix())
        notes: list[str] = []

        if path_meta is not None:
            merged, notes = merge_meta(path_meta, head)
            line = f"[meta] {s.rel_path.name}: 区县={merged.district or '空'} " \
                   f"学校={head.school or '无'} 年级={merged.grade}"
            if path_meta.district in {"", "北京各", "北京各区"} and merged.district:
                line += f"（文件名={path_meta.district or '空'} → 卷面）"
            for note in notes:
                line += f" · {note}"
            print(line, flush=True)
        else:
            merged, notes = _fallback_meta(s, text, head, rel_jsonl, cfg, args)
            if merged is None:
                continue
            print(f"[meta] {s.rel_path.name}: 文件名不规范 → 按目录+卷面推断："
                  f"年份={merged.year} 学期={merged.semester} 年级={merged.grade} "
                  f"考试类型={merged.exam_type} 区县={merged.district or '空'}", flush=True)
            for note in notes:
                print(f"       · {note}", flush=True)

        if args.dry_run:
            continue
        write_sidecar(cfg.output_dir, rel_jsonl, head, merged, notes)
        written += 1
    print(f"[meta] 写入 sidecar {written} 份", flush=True)
    return 0


_GRADES = ["初一", "初二", "初三", "高一", "高二", "高三"]
_COMMON_EXAMS = ["期中", "期末", "一模", "二模", "月考", "联考"]


def _ask_choice(label: str, options: list[str], default: str | None = None) -> str | None:
    """TTY 下让用户选（数字）或直接输入；非 TTY 返回 None，由调用方跳过。"""
    if not sys.stdin.isatty():
        return None
    hint = f"（回车={default}）" if default else ""
    print(f"\n[?] 从目录和卷面推断不出「{label}」{hint}", flush=True)
    for i, opt in enumerate(options, 1):
        print(f"    {i} = {opt}", flush=True)
    while True:
        print(f"    输入序号，或直接输入{label} › ", end="", flush=True)
        ans = (sys.stdin.readline() or "").strip()
        if not ans and default:
            return default
        if ans.isdigit() and 1 <= int(ans) <= len(options):
            return options[int(ans) - 1]
        if ans:
            return ans


def _fallback_meta(source, text: str, head, rel_jsonl, cfg, args):
    """文件名不合规：目录给 学科/学段/学期/年份，卷面给 年级/考试类型，缺的再问用户。

    产物仍是 PaperMeta —— 下游（db_loader / exam_papers）不需要知道文件名长什么样。
    """
    parts = parse_path_parts(rel_jsonl.as_posix())
    if parts is None:
        print(f"[meta] 跳过 {rel_jsonl}：目录不符合「学科/学段/学期/年份」结构，"
              f"无法推断元数据", flush=True)
        return None, []

    prev = load_sidecar(cfg.output_dir, rel_jsonl) or {}
    prev_merged = prev.get("merged") or {}
    notes: list[str] = []
    name = source.md_path.name

    grade = head.grade or prev_merged.get("grade") or detect_grade_from_name(name)
    exam_type = prev_merged.get("exam_type")
    if not exam_type:
        exam_type, _ = detect_exam_type(name)
    if not exam_type:
        exam_type, _ = detect_exam_type(text)
    # 卷面首屏常常只有「学校：____」，学校/区县反倒还在文件名里（只是格式不合规）
    district = head.district or detect_district(name)[0]
    school = head.school or detect_school(name)[0]

    if not grade:
        grade = _ask_choice("年级", _GRADES, default="初三")
        if not grade:
            print(f"[meta] 跳过 {rel_jsonl}：推断不出年级（非交互终端不猜）；"
                  f"交互终端下重跑会问你", flush=True)
            return None, []
        notes.append(f"年级={grade}（用户指定）")
    if not exam_type:
        exam_type = _ask_choice("考试类型", _COMMON_EXAMS)
        if not exam_type:
            print(f"[meta] 跳过 {rel_jsonl}：推断不出考试类型（非交互终端不猜）；"
                  f"交互终端下重跑会问你", flush=True)
            return None, []

    if (district or "") in COLLECTIVE_LOCATIONS:
        district = ""
    merged = build_paper_meta(parts, grade, exam_type, district or "", school)
    if school:
        notes.append(f"学校={school}（{'卷面' if head.school else '文件名'}）")
    return merged, notes


def main(argv=None) -> int:
    args = parse_args(argv)
    cfg = RefineryConfig.from_env(
        output_dir=args.output_dir or None,
    )
    llm = None
    if not args.no_llm:
        llm = create_llm_client(
            provider=cfg.llm_provider,
            api_key=cfg.llm_api_key or "",
            auth_token=cfg.llm_auth_token,
            model=cfg.llm_model,
            base_url=cfg.llm_base_url,
            timeout=cfg.llm_timeout,
            max_tokens=cfg.llm_max_tokens,
            max_retries=cfg.llm_max_retries,
            thinking=cfg.llm_thinking,
            enable_cache=cfg.llm_enable_cache,
        )
    return run(cfg, args, llm=llm)


if __name__ == "__main__":
    raise SystemExit(main())
