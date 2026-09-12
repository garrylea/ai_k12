"""crawler_cli.py 参数解析与学期未决退出码测试。"""

import pytest

from crawler_cli import _unique_keep_order, parse_args


class TestUniqueKeepOrder:
    def test_dedups_and_preserves_order(self):
        assert _unique_keep_order(["b", "a", "b", "c", "a"]) == ["b", "a", "c"]

    def test_empty(self):
        assert _unique_keep_order([]) == []


class TestCrawlerCliParseArgs:
    def test_site_required(self):
        with pytest.raises(SystemExit):
            parse_args([])

    def test_site_zgkao_requires_url(self):
        with pytest.raises(SystemExit):
            parse_args(["--site", "zgkao"])

    def test_site_zgkao_with_url(self):
        args = parse_args(["--site", "zgkao", "--url", "https://example.com"])
        assert args.site == "zgkao"
        assert args.url == "https://example.com"

    def test_site_smartedu_accepts_subject(self):
        args = parse_args(["--site", "smartedu", "--subject", "数学"])
        assert args.site == "smartedu"
        assert args.subject == "数学"

    def test_zgkao_accepts_grade_filter(self):
        args = parse_args(["--site", "zgkao", "--url", "https://example.com", "--grade", "初三"])
        assert args.grade == "初三"

    def test_zgkao_rejects_level_filter(self):
        with pytest.raises(SystemExit):
            parse_args(["--site", "zgkao", "--url", "https://example.com", "--level", "初中"])

    def test_smartedu_rejects_district_filter(self):
        with pytest.raises(SystemExit):
            parse_args(["--site", "smartedu", "--district", "海淀"])

    def test_output_default(self):
        args = parse_args(["--site", "smartedu"])
        assert args.output == "./data"

    def test_force_flag(self):
        assert parse_args(["--site", "smartedu", "--force"]).force is True

    def test_dry_run_flag(self):
        assert parse_args(["--site", "smartedu", "--dry-run"]).dry_run is True

    def test_crawl_delay_default_is_none(self):
        # 具体默认值（zgkao 0 / smartedu 0.5）在 main() 里按站点解析，parse_args 只保留 None
        assert parse_args(["--site", "zgkao", "--url", "https://e.com"]).crawl_delay is None
