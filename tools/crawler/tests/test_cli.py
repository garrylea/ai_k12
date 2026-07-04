"""CLI 调度器测试。"""

import pytest

from cli import parse_args


class TestCliParseArgs:
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

    def test_zgkao_rejects_grade_filter(self):
        with pytest.raises(SystemExit):
            parse_args(["--site", "zgkao", "--url", "https://example.com", "--grade", "九年级"])

    def test_smartedu_rejects_district_filter(self):
        with pytest.raises(SystemExit):
            parse_args(["--site", "smartedu", "--district", "海淀"])

    def test_output_default(self):
        args = parse_args(["--site", "smartedu"])
        assert args.output == "./data"

    def test_force_flag(self):
        args = parse_args(["--site", "smartedu", "--force"])
        assert args.force is True

    def test_dry_run_flag(self):
        args = parse_args(["--site", "smartedu", "--dry-run"])
        assert args.dry_run is True
