"""pipeline_cli：convert 之后的一站式总控（toc_parse → extract → publish → toc_merge → db_loader）。

用法：
    python src/pipeline_cli.py --source all                      # 全流程（增量入库）
    python src/pipeline_cli.py --source all --dry-run            # 每步只打印
    python src/pipeline_cli.py --source smartedu --skip-extract   # 只跑其余步骤
    python src/pipeline_cli.py --source all --purge-business-data # 全量重载（清业务数据，慎用）

说明：
- 教材/试卷自动分流（extract/publish/db_loader 内部按文件名路由）；
- 各阶段沿用原有 checkpoint，重复执行只处理新增/未完成部分；
- 首次运行时若 tools/data-refinery/.env 未配置，会从 deploy.sh 生成的
  apps/server/.env 等文件引导用户选择 provider 并生成（见 env_bootstrap）；
- 目录合并：card 分析发现的新小节在入库前合并进 TOC（toc_merge 产出
  *.merged.json sidecar），db_loader 用合并版建骨架后挂卡。
"""

import argparse
import os

from config import RefineryConfig
from db_loader_cli import main as db_loader_main
from env_bootstrap import ensure_refinery_env
from extract_cli import main as extract_main
from publish_cli import main as publish_main
from toc_merge import run_merge
from toc_parse_cli import main as toc_parse_main


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="总控管线：toc_parse → extract → publish → toc_merge → db_loader",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python src/pipeline_cli.py                          # 无参数：交互式向导
  python src/pipeline_cli.py --source all             # 教材+试卷，增量入库
  python src/pipeline_cli.py --source all --dry-run    # 只打印
  python src/pipeline_cli.py --book "九年级/下册" --pages "8-30"   # 部分提取
  python src/pipeline_cli.py --skip-toc --skip-load    # 只跑 extract+publish+merge
  python src/pipeline_cli.py --purge-business-data    # 全量重载（清学生侧业务数据）
        """,
    )
    parser.add_argument("--source", choices=["all", "zgkao", "smartedu"], default="all",
                        help="素材来源过滤（默认 all）")
    parser.add_argument("--book", help="只处理指定书目（rel_path 子串匹配，如 '九年级/下册'），"
                        "作用于 toc_parse 和 extract")
    parser.add_argument("--pages", help="只提取指定页码（如 '8-30'），作用于 extract")
    parser.add_argument("--dry-run", action="store_true", help="所有步骤只打印，不写盘/不入库")
    parser.add_argument("--reconvert", action="store_true",
                        help="忽略已提取/已发布记录，重新切割 + LLM 标注 + 重新发布"
                             "（仅作用 extract/publish；作用域由 --book/--pages 限定，未限定则全量重做）")
    parser.add_argument("--purge-business-data", action="store_true",
                        help="全量重载前清空业务数据（answers/错题本/变式题/作业提交/progress，"
                             "不可恢复）；默认增量入库（--load-cards）")
    parser.add_argument("--skip-toc", action="store_true", help="跳过 toc_parse（目录提取）")
    parser.add_argument("--skip-extract", action="store_true", help="跳过 extract（卡片拆分+标注）")
    parser.add_argument("--skip-publish", action="store_true", help="跳过 publish（图片物化+路径改写）")
    parser.add_argument("--skip-load", action="store_true", help="跳过 toc_merge + db_loader（入库）")
    # extract 节流透传
    parser.add_argument("--interval", type=float, default=0.0,
                        help="extract 每次 LLM 调用后 sleep 秒数")
    parser.add_argument("--batch-size", type=int, default=0,
                        help="extract 每处理 N 页后进入批次间歇")
    parser.add_argument("--batch-sleep", type=float, default=0.0,
                        help="extract 批次之间 sleep 秒数")
    return parser.parse_args(argv)


def main(argv=None):
    # 配置引导必须在任何 RefineryConfig 使用之前（首跑时生成 .env 并 override 加载）
    ensure_refinery_env()

    # 无参数运行：交互式向导（逐项选择来源/范围/模型/入库，确认后执行）
    if argv is None or (isinstance(argv, (list, tuple)) and len(argv) == 0):
        from pipeline_wizard import apply_model_env, run_wizard
        config0 = RefineryConfig.from_env()
        result = run_wizard(md_dir=config0.output_dir / "md",
                            current_provider=config0.llm_provider,
                            current_model=config0.llm_model)
        if result is None:
            print("已取消。")
            return
        argv, model_env = result
        if model_env:
            apply_model_env(model_env)

    args = parse_args(argv)

    config = RefineryConfig.from_env()
    toc_dir = config.output_dir / "toc"

    dry = ["--dry-run"] if args.dry_run else []
    redo = ["--reconvert"] if args.reconvert else []
    scope = (["--book", args.book] if args.book else []) \
        + (["--pages", args.pages] if args.pages else [])

    # 1. toc_parse（仅教材；zgkao 试卷无目录；--reconvert 不连带目录重解析——
    #    目录重解析有独立 LLM 成本，需要时用 toc_parse_cli --reconvert 单独跑）
    if not args.skip_toc and args.source in ("all", "smartedu"):
        print("=== toc_parse（前几页目录 → toc.json） ===", flush=True)
        toc_parse_main(["--source", "smartedu"] + dry
                      + (["--book", args.book] if args.book else []))

    # 2. extract（教材+试卷；教材注入目录约束 + 逐书后置校验）
    if not args.skip_extract:
        print("=== extract（md → cards/questions + LLM 标注） ===", flush=True)
        extract_main(
            ["--source", args.source, "--toc-dir", str(toc_dir)]
            + scope + dry + redo + _throttle_args(args)
        )

    # 3. publish（图片物化 + 路径改写；scope 让重发布限定在所选书/页）
    if not args.skip_publish:
        print("=== publish（extracted → published + assets） ===", flush=True)
        publish_main(["--source", args.source] + scope + dry + redo)

    if not args.skip_load:
        # 4. toc_merge（card 发现的新小节合并进 TOC，确定性重算，无 checkpoint）
        print("=== toc_merge（card 标签 → toc.merged.json） ===", flush=True)
        run_merge(config.output_dir, source=args.source, dry_run=args.dry_run)

        # 5. db_loader（默认增量：先按 merged TOC 建骨架，再挂卡；
        #    --purge-business-data 时全量重载）
        print("=== db_loader（published → MySQL） ===", flush=True)
        load_args = ["--source", args.source, "--toc-dir", str(toc_dir)] + dry
        if args.purge_business_data:
            load_args.append("--purge-business-data")
        else:
            load_args.append("--load-cards")
        db_loader_main(load_args)


def _throttle_args(args) -> list[str]:
    """extract 节流参数透传。"""
    out = []
    if args.interval > 0:
        out += ["--interval", str(args.interval)]
    if args.batch_size > 0:
        out += ["--batch-size", str(args.batch_size)]
    if args.batch_sleep > 0:
        out += ["--batch-sleep", str(args.batch_sleep)]
    return out


if __name__ == "__main__":
    import sys
    # 必须传 argv：无参时进入交互式向导，带参时直接执行
    main(sys.argv[1:])
