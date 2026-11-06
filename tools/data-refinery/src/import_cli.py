"""import_cli：一条命令把素材导入题库（convert → extract → publish → db_loader → 答案回填）。

面向「单科/单卷」的日常导入，全部阶段共用同一套范围参数
（`--subject/--stage/--term/--year/--file`，见 scope_filter）：

    python src/import_cli.py --subject 物理 --files "一零一中学,人大附中"  # 一次导入多份卷
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

第 6 步扫识别问题（缺号/被吞/卷首页脚），第 7 步在**交互终端**下直接逐条引导
人工补题（粘贴 md 或给图片走 MinerU），补好的内容落 output/manual_fixes/；
第 8 步先预览「会改哪些题」，交互终端下问一次 `y` 才写库。非交互终端只打印
命令，不会卡住 CI。`--skip-review` 可关掉第 7/8 步。
"""

import argparse
import copy
import sys
from datetime import datetime
from pathlib import Path

from answer_backfill import backfill as answers_backfill
from config import RefineryConfig
from convert_cli import main as convert_main
from db_loader_cli import main as db_loader_main
from extract_cli import main as extract_main
from paper_meta_cli import main as paper_meta_main
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
    parser.add_argument("--skip-meta", action="store_true",
                        help="跳过卷面元数据（output/meta sidecar），文件名缺区县时不再补")
    parser.add_argument("--skip-load", action="store_true", help="跳过 db_loader（只到 published）")
    parser.add_argument("--answers", metavar="PATH",
                        help="指定答案/解析文件：.md 按卷答案文档（# 试卷：… + ## 题号 + "
                             "答案/思路/解析）或 .jsonl 记录；第 6 步直接写入，"
                             "非 dry-run 时自动 --apply --yes")
    parser.add_argument("--skip-answers", action="store_true", help="跳过第 6 步答案回填")
    parser.add_argument("--skip-review", action="store_true",
                        help="发现缺题时不进入人工补题（只打印清单与补题命令）")
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


def meta_argv(args) -> list[str]:
    """paper_meta_cli：与 extract 同样用 --file（rel_path 子串）。"""
    argv = _common(args)
    if args.file:
        argv += ["--file", args.file]
    if args.dry_run:
        argv.append("--dry-run")
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


def _lookup_paper_id(cfg, keyword: str) -> int | None:
    """按卷名/来源键子串在 exam_papers 里查 paper_id；唯一命中才返回。"""
    import pymysql

    conn = pymysql.connect(
        host=cfg.db_host, port=cfg.db_port, user=cfg.db_user,
        password=cfg.db_pass, database=cfg.db_name, charset="utf8mb4",
        connect_timeout=5,
    )
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id FROM exam_papers WHERE title LIKE %s OR source_key LIKE %s",
                (f"%{keyword}%", f"%{keyword}%"),
            )
            rows = cur.fetchall()
        return int(rows[0][0]) if len(rows) == 1 else None
    finally:
        conn.close()


def _answers_file_entry(args):
    """第 6 步（--answers 指定文件）：.jsonl 走 --records，.md 走 --doc。

    给了 --file/--files 就先查出 paper_id 显式传入，避免卷名重名时按文档标题
    定位到别的卷；没给则依赖文档里的 `# 试卷：<标题>`。
    """
    def run(_argv=None) -> int:
        from answer_importer_cli import main as importer_main

        path = Path(args.answers).expanduser()
        if not path.exists():
            print(f"[ERROR] --answers 文件不存在：{path}", flush=True)
            return 2
        argv = (["--records", str(path)] if path.suffix.lower() == ".jsonl"
                else ["--doc", str(path)])
        if path.suffix.lower() != ".jsonl" and args.file:
            pid = _lookup_paper_id(RefineryConfig.from_env(), args.file)
            if pid is not None:
                argv += ["--paper-id", str(pid)]
        if not args.dry_run:
            argv += ["--apply", "--yes"]
        return importer_main(argv)
    return run


def _scan_entry(args):
    """识别问题扫描：按本次范围（学科 + 卷名子串）扫已提取的 jsonl。"""
    def _run(_argv) -> int:
        from recognition_scan import run as scan_run
        issues = scan_run(args.subject or "物理", args.file, write=not args.dry_run)
        args._scanned_sources = {i["source"] for i in issues}
        if args.dry_run:
            for it in issues:
                print(f"[issue] {it['source'][:24]} 题{it['group_order']} {it['kind']}："
                      f"{'；'.join(it['reasons'])}", flush=True)
        return 0
    return _run


def _fix_entry(args):
    """人工补题：先处理扫描到的问题，再让用户主动点名重录（不依赖扫描）。"""
    def _run(_argv) -> int:
        import sys

        from manual_fix import review_by_numbers, review_pending

        sources = getattr(args, "_scanned_sources", None)
        if args.dry_run:
            if sources:
                print(f"[dry-run] {len(sources)} 份卷存在待补题；正式执行时会逐条确认", flush=True)
            print("[dry-run] 正式执行时还会问「还有哪道题要主动重录」", flush=True)
            return 0
        if args.skip_review or not sys.stdin.isatty():
            if sources:
                print(f"[提示] {len(sources)} 份卷有题目待人工确认；当前非交互终端，已跳过。",
                      flush=True)
                print("       唯一入口（录入后会自动问是否写库）：", flush=True)
                print("       python3 src/fix_question_cli.py --source <卷名>", flush=True)
            else:
                print("[done] 本次没有待人工处理的题", flush=True)
            return 0
        if sources:
            review_pending(sources=sources)
        # 扫描只报它认得出的结构问题；PDF→MD 阶段丢图/丢字它未必能发现
        # （2026-11-03 汇文题6 一张图没截出来）。所以每次都在交互终端里问一句
        # 「还有哪道题要主动重录」，用户可直接粘「材料+题干+选项+图片」整段。
        review_by_numbers(args.subject, args.file)
        return 0
    return _run


def _answers_only(args) -> bool:
    """只给了 --answers、没给任何范围/重建参数 → 只做答案导入，不重跑整条管线。

    否则 `import_cli --answers x.md` 会按全库范围跑 convert/extract/publish/入库，
    还会进人工补题交互 —— 用户只是补答案时完全没必要，且代价很大。
    """
    if not args.answers:
        return False
    scope_keys = (args.file, args.files, args.subject, args.stage, args.term, args.year)
    rebuild = args.reconvert or args.re_extract or args.re_publish or args.redo
    return not any(scope_keys) and not rebuild


def _execute(args) -> int:
    """按 args 里的范围跑完整管线（单卷/单批）。"""
    answers_only = _answers_only(args)
    if answers_only:
        # 把前 5 步与 7/8/9 步关掉，只保留第 6 步
        args.skip_convert = args.skip_extract = args.skip_publish = True
        args.skip_meta = args.skip_load = args.skip_review = True
        print("=== 只导入答案（未给 --file/--subject 等范围参数，跳过 convert~入库）===",
              flush=True)
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
        stages.append(("1/9 convert（素材 → md）", convert_main, convert_argv(args)))
    if not args.skip_extract:
        stages.append(("2/9 extract（md → cards/questions + LLM 标注）", extract_main, extract_argv(args)))
    if not args.skip_publish:
        stages.append(("3/9 publish（图片物化 + 路径改写）", publish_main, publish_argv(args)))
    # 卷面元数据 sidecar：文件名缺区县/学校时从 md 首屏补，写 output/meta/<卷>.json
    # 试卷才需要（教材卡不入 exam_papers）；--cards-only 时跳过避免空跑
    if not args.skip_meta and not args.cards_only:
        stages.append(("4/9 试卷元数据（卷面 → output/meta sidecar）",
                       paper_meta_main, meta_argv(args)))
    if not args.skip_load:
        stages.append(("5/9 db_loader（published → MySQL，增量）", db_loader_main, load_argv(args)))
    # 答案回填必须在入库之后（要按 source_key 反查 paper_id）；--skip-load 时无从查起。
    # --answers 是用户显式给的答案/解析文件：不依赖 md 里的答案段，也不受 --skip-load 限制
    if args.answers:
        label = ("答案/解析导入（--answers 指定文件）" if answers_only
                 else "6/9 答案/解析导入（--answers 指定文件）")
        stages.append((label, _answers_file_entry(args), []))
    elif not args.skip_answers and not args.cards_only and not args.skip_load:
        stages.append(("6/9 答案回填（试卷 md → questions.answer）", _answers_entry(args), []))
    # 识别问题扫描：缺号 / 被吞 / 内容不完整 / 前后题合并 / 卷首页脚被当题，
    # 落 output/recognition_issues.jsonl，供 src/fix_question_cli.py 逐条人工确认
    # （不阻塞入库，可随时补跑）
    if not args.cards_only and not answers_only:
        stages.append(("7/9 识别问题扫描（缺号/被吞/内容不完整/前后题合并/噪声题）",
                       _scan_entry(args), []))
        # 扫完直接引导人工补题：交互终端下会逐条问，非交互（CI/管道）只打印命令，
        # 避免 CI 卡在 input() 上。补完的内容在 output/manual_fixes/，
        # 用 src/apply_fixes_cli.py --apply 统一写库。
        stages.append(("8/9 人工补题（逐条确认，可跳过）", _fix_entry(args), []))
        # 补完就地入库：先跑一遍预览，TTY 下问一次 y 才写
        stages.append(("9/9 补题入库（预览后确认）", _apply_entry(args), []))

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
        print("\n[中断] 已停止；已完成阶段有 checkpoint，重跑同一命令即可继续",
              flush=True)
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


def _write_preview_log(recs: list[dict], scope: list[str]) -> Path | None:
    """把本次待写入清单写到 output/apply_preview.log（覆盖写，只保留最近一次）。"""
    try:
        out_dir = Path(__file__).resolve().parents[1] / "output"
        out_dir.mkdir(parents=True, exist_ok=True)
        path = out_dir / "apply_preview.log"
        lines = [f"[{datetime.now():%Y-%m-%d %H:%M:%S}] 范围: {' '.join(scope) or '全部学科'}"
                 f" · 待写入 {len(recs)} 条"]
        for rec in recs:
            lines.append(f"  {rec.get('source', '?')}  题{rec.get('group_order', '?')}"
                         f"  （{rec.get('_file', '')}）")
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"[日志] 清单已存到 {path}（看不清屏幕就打开它）", flush=True)
        return path
    except OSError as exc:                      # 日志失败绝不能挡住写库流程
        print(f"[WARN] 写预览日志失败：{exc}", flush=True)
        return None


def _apply_entry(args):
    """把第 7 步补的题写进库：先预览，交互终端下确认一次才真写。

    闸门同时看两种记录：还没写库的（pending）**和**写过后被重导冲掉的（needing_replay）。
    只看前者会漏掉「补过、后来又没了」的题，用户不额外跑命令就永远救不回来。
    """
    def _run(_argv) -> int:
        from apply_fixes import needing_replay, pending_records, run as apply_run

        recs = pending_records(args.subject, args.file)
        lost = needing_replay(args.subject, args.file)
        if not recs and not lost:
            print("[补题] 已是最新：没有待写入、也没有丢失的补题", flush=True)
            return 0

        scope = []
        if args.subject:
            scope += ["--subject", args.subject]
        if args.file:
            scope += ["--source", args.file]
        head = f"{len(recs)} 条待写入"
        if lost:
            head += f"，另有 {len(lost)} 条被重导冲掉需重放"
        print(f"[补题] {head}，先预览：", flush=True)
        apply_run(["--dry-run"] + scope, via_pipeline=True)
        # 终端可能滚动或被别的程序接管输出，把清单同时落一份文件，随时可查
        log_path = _write_preview_log(recs + lost, scope)
        if args.dry_run:
            return 0
        if args.skip_review or not sys.stdin.isatty():
            print("       这一步会在下次运行同一条导入命令时自动再问一次"
                  "（非交互终端下不写库）", flush=True)
            return 0

        print("\n是否现在写入题库？ y=写入 / 直接回车=暂不写 › ", end="", flush=True)
        ans = (sys.stdin.readline() or "").strip().lower()
        if ans not in ("y", "yes"):
            # 把清单再贴一遍：预览可能已经滚上去，这里是屏幕上最后的记录
            print(f"[跳过] 未写库，本次未写入的 {len(recs) + len(lost)} 条：", flush=True)
            for rec in (recs + lost)[:12]:
                label = rec.get("source", "?")
                if "202407-" in label:
                    label = label.split("202407-", 1)[1]
                print(f"       {label}  题{rec.get('group_order', '?')}", flush=True)
            if len(recs) + len(lost) > 12:
                print(f"       …另有 {len(recs) + len(lost) - 12} 条", flush=True)
            print("       补题记录仍在 output/manual_fixes/；"
                  "重新运行同一条导入命令会再问一次", flush=True)
            return 0
        return apply_run(["--apply"] + scope, via_pipeline=True)
    return _run


def main(argv=None) -> int:
    """入口：一次 Ctrl+C 必须整体停下（含 --files 批量）。"""
    from cli_ui import install_interrupt_handler

    install_interrupt_handler()
    try:
        return _main(argv)
    except KeyboardInterrupt:
        print("\n[中断] 已停止", flush=True)
        return 130


def _main(argv=None) -> int:
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
        if code in (130, -2):          # Ctrl+C：整批停下，别再问下一份
            print(f"[中断] 已在「{kw}」停止，剩余 {len(keywords) - idx} 份未处理",
                  flush=True)
            return 130
        if code not in (None, 0):
            rc = code
            print(f"[WARN] {kw} 返回 {code}，继续处理下一份", flush=True)
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
