"""import_cli：一条命令把素材导入题库（convert → extract → publish → db_loader → 答案回填）。

面向「单科/单卷」的日常导入，全部阶段共用同一套范围参数
（`--subject/--stage/--term/--year/--file`，见 scope_filter）：

    python src/import_cli.py --subject 语文 --year 2025 --dry-run   # 先看范围
    python src/import_cli.py --subject 语文 --year 2025             # PDF → md → jsonl → 题库
    python src/import_cli.py --file "202507-海淀"                    # 单卷导入

设计原则（与 db_loader 的 P0/P1 一致）：
- **只碰指定范围**：每个子阶段都带同样的范围参数；未指定范围时才会全量。
- **增量入库**：固定使用 `--load-cards`（原地 upsert），**不会** full-reload；
  需要全量重建请直接用 `db_loader_cli` 并显式加 `--purge-business-data`。
- **分步可跳过/重做**：`--skip-convert/extract/publish/load/answers`、
  `--reconvert`（重跑 MinerU）、`--re-extract`、`--re-publish`，或 `--redo` 全部重做。

答案回填是第 5 步（2026-10-28 并入）：默认只补空答案，已有内容不动；
`--re-answer` 才覆盖；`--skip-answers` 可跳过。
"""

import argparse
import copy

from answer_backfill import backfill as answers_backfill
from config import RefineryConfig
from convert_cli import main as convert_main
from db_loader_cli import main as db_loader_main
from extract_cli import main as extract_main
from publish_cli import main as publish_main
from scope_filter import add_scope_args, describe, scope_argv, scope_from_args


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="一键导入：convert → extract → publish → db_loader（增量、按范围）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python src/import_cli.py --subject 语文 --year 2025 --dry-run
  python src/import_cli.py --subject 语文 --year 2025
  python src/import_cli.py --file "202507-海淀-模拟二-试卷"
  python src/import_cli.py --subject 物理 --files "一零一中学,人大附中,北师大实验"
  python src/import_cli.py --subject 语文 --re-extract --re-publish   # 只重抽+重发布
        """,
    )
    parser.add_argument("--source", choices=["all", "zgkao", "smartedu"], default="all",
                        help="素材来源过滤（默认 all）")
    add_scope_args(parser)
    parser.add_argument("--files", metavar="KW[,KW...]",
                        help="逗号分隔的多个卷名关键字：等价于对每个关键字各跑一遍 --file，"
                             "一次导入多份卷（与 --file 互斥）")
    parser.add_argument("--dry-run", action="store_true", help="每步只打印，不写盘/不入库")
    parser.add_argument("--skip-convert", action="store_true", help="跳过 convert（复用已有 md）")
    parser.add_argument("--skip-extract", action="store_true", help="跳过 extract")
    parser.add_argument("--skip-publish", action="store_true", help="跳过 publish")
    parser.add_argument("--skip-load", action="store_true", help="跳过 db_loader（只到 published）")
    parser.add_argument("--skip-answers", action="store_true", help="跳过第 5 步答案回填")
    parser.add_argument("--re-answer", action="store_true",
                        help="答案回填覆盖已有内容（默认只补空答案）")
    parser.add_argument("--reconvert", action="store_true", help="重跑 MinerU（删除已有 md 重新转换）")
    parser.add_argument("--re-extract", action="store_true", help="重新切题+LLM 标注（保留 md）")
    parser.add_argument("--re-publish", action="store_true", help="重新物化图片+改写路径")
    parser.add_argument("--redo", action="store_true", help="等价于 --reconvert --re-extract --re-publish")
    parser.add_argument("--questions-only", action="store_true", help="入库只写试卷题（不碰教材卡）")
    parser.add_argument("--cards-only", action="store_true", help="入库只写教材卡（不碰试卷题）")
    parser.add_argument("--interval", type=float, default=0.0,
                        help="extract 每次 LLM 调用后 sleep 秒数（默认 0）")
    parser.add_argument("--batch-size", type=int, default=0,
                        help="extract 每 N 页后批次间歇（默认 0=不分批）")
    parser.add_argument("--batch-sleep", type=float, default=0.0,
                        help="extract 批次之间 sleep 秒数")
    args = parser.parse_args(argv)
    if args.questions_only and args.cards_only:
        parser.error("--questions-only 与 --cards-only 互斥")
    if args.files and args.file:
        parser.error("--files 与 --file 只能用一个（--files 就是多个 --file）")
    return args


def _common(args) -> list[str]:
    """各阶段通用的 --source + 维度参数（不含 --file，各阶段映射方式不同）。"""
    return ["--source", args.source] + scope_argv(args, include_file=False)


def convert_argv(args) -> list[str]:
    """convert：--file 映射为 --materials（同为 rel_path 子串）。"""
    argv = _common(args)
    if args.file:
        argv += ["--materials", args.file]
    if args.dry_run:
        argv.append("--dry-run")
    if args.reconvert or args.redo:
        argv.append("--reconvert")
    return argv


def extract_argv(args) -> list[str]:
    argv = _common(args)
    if args.file:
        argv += ["--file", args.file]
    if args.dry_run:
        argv.append("--dry-run")
    if args.re_extract or args.redo:
        argv.append("--reconvert")
    if args.interval:
        argv += ["--interval", str(args.interval)]
    if args.batch_size:
        argv += ["--batch-size", str(args.batch_size)]
    if args.batch_sleep:
        argv += ["--batch-sleep", str(args.batch_sleep)]
    return argv


def publish_argv(args) -> list[str]:
    """publish：没有 --file，用 --book（同样是 rel_path 子串）。"""
    argv = _common(args)
    if args.file:
        argv += ["--book", args.file]
    if args.dry_run:
        argv.append("--dry-run")
    if args.re_publish or args.redo:
        argv.append("--reconvert")
    return argv


def load_argv(args) -> list[str]:
    """db_loader：固定增量（--load-cards），绝不隐式 full-reload。"""
    argv = _common(args)
    if args.file:
        argv += ["--file", args.file]
    argv.append("--load-cards")
    if args.questions_only:
        argv.append("--questions-only")
    if args.cards_only:
        argv.append("--cards-only")
    if args.dry_run:
        argv.append("--dry-run")
    return argv


def _matched_subjects(paths: list[str], keyword: str) -> set[str]:
    """从一组相对路径里找出包含 keyword 的素材所属学科（路径首段）。"""
    return {
        rel.split("/", 1)[0]
        for rel in paths
        if keyword in rel and "/" in rel
    }


def _scan_rel_paths(input_dir, md_dir) -> list[str]:
    """收集素材相对路径：爬虫素材（PDF/图片） + 已转 md（--skip-convert 时也能判）。"""
    rels: list[str] = []
    try:
        from scanner import MaterialScanner

        rels.extend(m.rel_path.as_posix() for m in MaterialScanner(input_dir).scan())
    except Exception:
        pass
    try:
        rels.extend(p.relative_to(md_dir).as_posix() for p in md_dir.rglob("*.md"))
    except Exception:
        pass
    return rels


def _subjects_for_file(args) -> set[str]:
    """--file 子串命中的学科集合（用于多学科守卫）。"""
    from config import RefineryConfig

    cfg = RefineryConfig.from_env()
    return _matched_subjects(_scan_rel_paths(cfg.input_dir, cfg.output_dir / "md"), args.file)


def _answers_entry(args):
    """第 5 步不是子 CLI（要逐卷查 paper_id 再调 importer），包装成同样的 (label, fn, argv) 形状。"""
    def run(_argv=None):
        cfg = RefineryConfig.from_env()
        answers_backfill(
            cfg, scope_from_args(args), dry_run=args.dry_run, overwrite=args.re_answer,
        )
    return run


def _scan_entry(args):
    """识别问题扫描：按本次范围（学科 + 卷名子串）扫已提取的 jsonl。"""
    def _run(_argv) -> int:
        from recognition_scan import run as scan_run
        if args.dry_run:
            issues = scan_run(args.subject or "物理", args.file, write=False)
            for it in issues:
                print(f"[issue] {it['source'][:24]} 题{it['group_order']} {it['kind']}："
                      f"{'；'.join(it['reasons'])}", flush=True)
            return 0
        scan_run(args.subject or "物理", args.file, write=True)
        return 0
    return _run


def _execute(args) -> int:
    """按 args 里的范围跑完整管线（单卷/单批）。"""
    scope = scope_from_args(args)
    print(f"=== import_cli：范围 {describe(scope)} "
          f"{'(dry-run)' if args.dry_run else ''} ===", flush=True)

    # 多学科守卫：只给 --file 不给 --subject 时，子串可能命中多科素材。
    # 各阶段都会照单全收（学科由路径判定，不会导错，但会顺带改别的学科），
    # 与「导一科不动别科」的原则冲突，直接拒绝并提示收窄范围。
    if args.file and not args.subject:
        subjects = _subjects_for_file(args)
        if len(subjects) > 1:
            print("[WARN] --file 子串命中了多个学科："
                  f"{' / '.join(sorted(subjects))}", flush=True)
            if not args.dry_run:
                print("[ERROR] 拒绝执行：请加 --subject 指定学科，或用更精确的 --file"
                      "（如 '语文/初中/second/2025/...'）后重试", flush=True)
                print("        （--dry-run 可继续查看完整命中清单）", flush=True)
                return 2
            print("        dry-run 继续；正式执行前请加 --subject 收窄范围", flush=True)

    stages = []
    if not args.skip_convert:
        stages.append(("1/6 convert（素材 → md）", convert_main, convert_argv(args)))
    if not args.skip_extract:
        stages.append(("2/6 extract（md → cards/questions + LLM 标注）", extract_main, extract_argv(args)))
    if not args.skip_publish:
        stages.append(("3/6 publish（图片物化 + 路径改写）", publish_main, publish_argv(args)))
    if not args.skip_load:
        stages.append(("4/6 db_loader（published → MySQL，增量）", db_loader_main, load_argv(args)))
    # 答案回填必须在入库之后（要按 source_key 反查 paper_id）；--skip-load 时无从查起
    if not args.skip_answers and not args.cards_only and not args.skip_load:
        stages.append(("5/6 答案回填（试卷 md → questions.answer）", _answers_entry(args), []))
    # 识别问题扫描：缺号 / 被吞 / 卷首页脚被当题，落 output/recognition_issues.jsonl，
    # 供 scripts/fix_question_cli.py 逐条人工补题（不阻塞入库，可随时补跑）
    if not args.cards_only:
        stages.append(("6/6 识别问题扫描（缺号/被吞/噪声题）", _scan_entry(args), []))

    try:
        for label, fn, sub_argv in stages:
            print(f"=== {label} ===", flush=True)
            if sub_argv:
                print(f"    argv: {' '.join(sub_argv)}", flush=True)
            rc = fn(sub_argv)
            # 子 CLI 出错时是「return 2」而不是抛异常（如 MinerU token 过期）；
            # 不能忽略返回值，否则会带着半截数据继续跑后面的阶段。
            if rc not in (None, 0):
                print(f"[ERROR] {label} 返回 {rc}，已停止；后续阶段未执行", flush=True)
                return rc
    except KeyboardInterrupt:
        print("\n[中断] 已停止；已完成阶段有 checkpoint，可从断点继续", flush=True)
        return 130
    except Exception as e:  # 子 CLI 的异常向上抛：立即停，不带着半截数据继续
        print(f"\n[ERROR] 阶段失败：{e}", flush=True)
        print("已完成的阶段有 checkpoint，修复后重跑同一命令即可", flush=True)
        return 1

    print("=== 完成 ===", flush=True)
    return 0


def _file_keywords(args) -> list[str]:
    """--files 拆成关键字列表（兼容中文逗号）。"""
    raw = (args.files or "").replace("，", ",")
    return [k.strip() for k in raw.split(",") if k.strip()]


def main(argv=None) -> int:
    args = parse_args(argv)
    keywords = _file_keywords(args)
    if not keywords:
        return _execute(args)

    rc = 0
    for idx, kw in enumerate(keywords, 1):
        sub = copy.copy(args)
        sub.file = kw
        sub.files = None
        print(f"\n=== [批量 {idx}/{len(keywords)}] {kw} ===", flush=True)
        code = _execute(sub)
        if code not in (None, 0):
            rc = code
            print(f"[WARN] {kw} 返回 {code}，继续处理下一份", flush=True)
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
