"""paper_meta_cli：把卷面元数据写到 output/meta/<卷>.json（sidecar）。

只读 md、只写 sidecar，不碰库。db_loader 入库时读这份 sidecar 决定
`exam_papers.title/district/grade`（见 paper_head.merge_meta / apply_sidecar）。

参数与其它阶段同源（add_scope_args + --source + --file），由 import_cli 第 4 步透传。
"""

import argparse
from pathlib import Path

from config import RefineryConfig
from llm import create_llm_client
from markdown_scanner import MarkdownScanner
from paper_head import extract_head_meta, merge_meta, write_sidecar
from paper_meta import parse_paper_meta
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


def _is_paper(source) -> bool:
    name = source.md_path.name
    return source.kind == "questions" and "试卷" in name and "答案" not in name


def run(cfg: RefineryConfig, args, llm=None) -> int:
    md_dir = Path(args.input_dir) if args.input_dir else cfg.output_dir / "md"
    scanner = MarkdownScanner(md_dir)
    scope = scope_from_args(args)
    sources = [s for s in scanner.scan() if _is_paper(s)]
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
        path_meta = parse_paper_meta(rel_jsonl.as_posix())
        if path_meta is None:
            print(f"[meta] 跳过 {rel_jsonl}：文件名不符合试卷命名规则", flush=True)
            continue
        text = s.md_path.read_text(encoding="utf-8")
        head = extract_head_meta(text, llm=None if args.no_llm else llm)
        merged, notes = merge_meta(path_meta, head)
        line = f"[meta] {s.rel_path.name}: 区县={merged.district or '空'} " \
               f"学校={head.school or '无'} 年级={merged.grade}"
        if path_meta.district in {"", "北京各", "北京各区"} and merged.district:
            line += f"（文件名={path_meta.district or '空'} → 卷面）"
        for note in notes:
            line += f" · {note}"
        print(line, flush=True)
        if args.dry_run:
            continue
        write_sidecar(cfg.output_dir, rel_jsonl, head, merged, notes)
        written += 1
    print(f"[meta] 写入 sidecar {written} 份", flush=True)
    return 0


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
