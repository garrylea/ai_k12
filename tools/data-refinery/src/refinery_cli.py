"""refinery_cli：串联后段管线 publish_cli -> db_loader_cli。

前段（convert_cli 素材->md、extract_cli md->extracted）单独跑；
本 CLI 把 extracted -> published -> MySQL 串起来一键执行。

用法：
    python src/refinery_cli.py --source all            # publish + db_loader
    python src/refinery_cli.py --source all --dry-run  # 两步都只打印
    python src/refinery_cli.py --skip-publish          # 只 db_loader
    python src/refinery_cli.py --skip-load             # 只 publish
    python src/refinery_cli.py --purge-business-data   # full-reload 前清业务数据（否则遇业务数据报错）
"""

import argparse

from db_loader_cli import main as db_loader_main
from publish_cli import main as publish_main
from scope_filter import scope_argv


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="串联 publish -> db_loader 后段管线")
    parser.add_argument("--source", choices=["all", "zgkao", "smartedu"], default="all", help="素材来源过滤")
    parser.add_argument("--subject", help="学科过滤（中文名或 code，如 语文 / chinese），逗号分隔多个")
    parser.add_argument("--stage", help="学段过滤（初中/小学/高中 或 junior/primary/senior），逗号分隔多个")
    parser.add_argument("--term", help="学期过滤（上/下 或 first/second；教材也可写 上册/下册），逗号分隔多个")
    parser.add_argument("--year", help="年份过滤（4 位，仅试卷素材，如 2025），逗号分隔多个")
    parser.add_argument("--file", help="只处理相对路径包含该子串的素材（单卷/单书）")
    parser.add_argument("--dry-run", action="store_true", help="两步都只打印，不发布/不入库")
    parser.add_argument("--skip-publish", action="store_true", help="跳过 publish，直接 db_loader")
    parser.add_argument("--skip-load", action="store_true", help="跳过 db_loader，只 publish")
    parser.add_argument("--purge-business-data", action="store_true",
                        help="透传给 db_loader_cli：full-reload 前清空引用 cards/questions 的业务数据"
                             "（answers/错题本/变式题/作业提交/progress，不可恢复）")
    return parser.parse_args(argv)


def _sub_args(args) -> list[str]:
    sub = ["--source", args.source] + scope_argv(args)
    if args.dry_run:
        sub.append("--dry-run")
    return sub


def _loader_args(args) -> list[str]:
    """db_loader 专属参数：--purge-business-data 只有 db_loader_cli 有，不能传给 publish_cli。"""
    sub = _sub_args(args)
    if scope_argv(args) and not args.purge_business_data:
        # 带范围时强制增量（full-reload 会删全库，db_loader 会拒绝该组合）
        sub.append("--load-cards")
    if args.purge_business_data:
        sub.append("--purge-business-data")
    return sub


def main(argv=None):
    args = parse_args(argv)
    if not args.skip_publish:
        print("=== publish（extracted -> published + assets） ===", flush=True)
        publish_main(_sub_args(args))
    if not args.skip_load:
        print("=== db_loader（published -> MySQL） ===", flush=True)
        db_loader_main(_loader_args(args))


if __name__ == "__main__":
    main()
