"""convert 子命令入口。"""

import argparse


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="将爬虫素材转换为 Markdown")
    parser.add_argument("--input-dir", help="素材输入目录（默认 tools/crawler/data）")
    parser.add_argument("--output-dir", help="Markdown 输出目录（默认 tools/data-refinery/output/md）")
    parser.add_argument("--source", choices=["all", "zgkao", "smartedu"], default="all", help="素材来源过滤")
    parser.add_argument("--force", action="store_true", help="强制重新转换")
    parser.add_argument("--dry-run", action="store_true", help="只打印将要处理的素材")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    if args.dry_run:
        print("[dry-run] convert")
