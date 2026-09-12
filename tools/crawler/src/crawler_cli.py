"""CLI 入口：按 --site 选择 adapter 并运行通用 Crawler。

zgkao 线在下载前解析学期：优先从页面/文件名识别，判不出时交互询问；
非交互场景判不出则跳过该文件并在结束时以退出码 2 报告。
"""

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

from adapters.smartedu import SmartEduAdapter
from adapters.zgkao import ZgkaoAdapter
from classifier import SemesterResolver
from core.checkpoint import Checkpoint
from core.crawler import Crawler
from core.fetcher import Fetcher
from core.storage import ImageStore, PdfStore
from core.validator import ImageValidator, PdfValidator


_ADAPTERS = {
    "zgkao": ZgkaoAdapter,
    "smartedu": SmartEduAdapter,
}

_ADAPTER_REQUIRED = {"zgkao": {"url"}, "smartedu": set()}
_ADAPTER_FILTERS = {
    "zgkao": {"years", "subjects", "districts", "grades"},
    "smartedu": {"subject", "level", "grade", "semester", "publisher"},
}

_UNRESOLVED_EXIT_CODE = 2


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="K12 试卷/教材爬虫")
    parser.add_argument("--site", required=True, choices=list(_ADAPTERS.keys()), help="站点适配器")
    parser.add_argument("--url", help="入口页 URL（zgkao 必填）")
    parser.add_argument("--output", default="./data", help="输出目录")
    parser.add_argument("--subject", help="学科过滤")
    parser.add_argument("--year", help="年份过滤（zgkao）")
    parser.add_argument("--district", help="区县过滤（zgkao）")
    parser.add_argument("--level", help="学段过滤（smartedu）")
    parser.add_argument("--grade", help="年级过滤（zgkao: 初一/初二/初三/高一/高二/高三；smartedu: 九年级）")
    parser.add_argument("--semester", help="册次过滤（smartedu）")
    parser.add_argument("--publisher", help="版本过滤（smartedu）")
    parser.add_argument("--latest-only", action="store_true", default=True, help="smartedu 同书只取最新")
    parser.add_argument("--no-latest-only", dest="latest_only", action="store_false")
    parser.add_argument("--force", action="store_true", help="强制重新下载")
    parser.add_argument("--dry-run", action="store_true", help="只检查不下载")
    parser.add_argument("--crawl-delay", type=float, default=None, help="礼貌延时（秒）")
    args = parser.parse_args(argv)
    _validate_args(parser, args)
    return args


def _validate_args(parser, args):
    required = _ADAPTER_REQUIRED[args.site]
    if "url" in required and not args.url:
        parser.error(f"--site {args.site} requires --url")

    supported = _ADAPTER_FILTERS[args.site]
    filter_map = {
        "year": args.year,
        "subject": args.subject,
        "district": args.district,
        "level": args.level,
        "grade": args.grade,
        "semester": args.semester,
        "publisher": args.publisher,
    }
    for key, value in filter_map.items():
        if value is not None and key not in supported and key + "s" not in supported:
            parser.error(f"--{key.replace('_', '-')} is not supported for site {args.site}")


def _build_filters(args):
    filters = {}
    for key in ["year", "subject", "district", "level", "grade", "semester", "publisher"]:
        value = getattr(args, key, None)
        if value:
            filters[key + "s"] = set(value.split(","))
    return filters


def _stdin_prompt(label: str) -> str:
    return input(f"无法从页面判断学期：{label}，请填写学期 [上/下]：")


def _unique_keep_order(items):
    """去重但保持原顺序（同一份试卷的「试卷/答案」都判不出时 identity 会重复）。"""
    return list(dict.fromkeys(items))


def main(argv=None) -> int:
    args = parse_args(argv)

    crawl_time = datetime.now(timezone.utc)
    output_path = Path(args.output)
    checkpoint = Checkpoint(output_path / ".checkpoint.json")
    checkpoint.load()

    crawl_delay = args.crawl_delay
    if crawl_delay is None:
        crawl_delay = 0.0 if args.site == "zgkao" else 0.5

    fetcher = Fetcher(crawl_delay=crawl_delay)
    filters = _build_filters(args)

    resolver = None
    if args.site == "zgkao":
        # 非 TTY（管道/CI）不询问：判不出就跳过，结束时报未决并以非零码退出
        prompt_fn = _stdin_prompt if sys.stdin.isatty() else None
        resolver = SemesterResolver(prompt_fn=prompt_fn)
        store = PdfStore(
            base_dir=str(output_path),
            entry_url=args.url,
            crawl_time=crawl_time,
            site_adapter="zgkao",
        )
        validator = PdfValidator()
        adapter = ZgkaoAdapter(
            fetcher=fetcher,
            entry_url=args.url,
            filters=filters,
            semester_resolver=resolver,
        )
    else:
        store = ImageStore(
            base_dir=str(output_path),
            entry_url="https://basic.smartedu.cn/tchMaterial",
            crawl_time=crawl_time,
            site_adapter="smartedu",
        )
        validator = ImageValidator()
        adapter = SmartEduAdapter(
            fetcher=fetcher,
            base_dir=str(output_path),
            latest_only=args.latest_only,
        )

    crawler = Crawler(
        adapter=adapter,
        fetcher=fetcher,
        store=store,
        checkpoint=checkpoint,
        validator=validator,
        force=args.force,
        dry_run=args.dry_run,
    )

    result = crawler.run(filters)
    print(
        f"Total: {result.items_total}, Downloaded: {result.items_downloaded}, "
        f"Skipped: {result.items_skipped}, Failed: {result.items_failed}"
    )

    if resolver and resolver.unresolved:
        unresolved = _unique_keep_order(resolver.unresolved)
        print(f"Unresolved: {len(unresolved)}（无法判断学期，已跳过）")
        for identity in unresolved:
            print(f"  - {identity}")
        return _UNRESOLVED_EXIT_CODE
    return 0


if __name__ == "__main__":
    sys.exit(main())
