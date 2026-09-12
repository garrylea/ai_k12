"""crawler_cli.py 参数解析、学期未决退出码与 TTY 接线测试。"""

import pytest

import crawler_cli
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


class TestBuildFilters:
    def test_maps_grade_and_subject_to_plural_keys(self):
        args = parse_args([
            "--site", "zgkao", "--url", "https://e.com", "--grade", "初三", "--subject", "数学",
        ])
        assert crawler_cli._build_filters(args) == {"grades": {"初三"}, "subjects": {"数学"}}

    def test_empty_when_no_filters(self):
        args = parse_args(["--site", "zgkao", "--url", "https://e.com"])
        assert crawler_cli._build_filters(args) == {}


class _FakeResult:
    items_total = 1
    items_downloaded = 1
    items_skipped = 0
    items_failed = 0


class _FakeCrawler:
    def __init__(self, **kwargs):
        self.kwargs = kwargs

    def run(self, filters):
        return _FakeResult()


class _FakeCheckpoint:
    def __init__(self, path):
        self.path = path

    def load(self):
        pass


class _FakeStdin:
    def __init__(self, tty: bool):
        self._tty = tty

    def isatty(self) -> bool:
        return self._tty


def _stub_main_collaborators(monkeypatch, resolver_cls):
    monkeypatch.setattr(crawler_cli, "Checkpoint", _FakeCheckpoint)
    monkeypatch.setattr(crawler_cli, "Fetcher", lambda **kwargs: object())
    monkeypatch.setattr(crawler_cli, "PdfStore", lambda **kwargs: object())
    monkeypatch.setattr(crawler_cli, "PdfValidator", lambda: object())
    monkeypatch.setattr(crawler_cli, "ZgkaoAdapter", lambda **kwargs: object())
    monkeypatch.setattr(crawler_cli, "Crawler", _FakeCrawler)
    monkeypatch.setattr(crawler_cli, "SemesterResolver", resolver_cls)


class TestMainSemesterContract:
    """spec 验收标准：非交互判不出 → 跳过 + 警告 + 退出码 2；TTY 才接线 stdin 询问。"""

    def test_returns_exit_code_2_and_dedups_unresolved(self, monkeypatch, capsys):
        class StubResolver:
            def __init__(self, prompt_fn=None):
                self.prompt_fn = prompt_fn
                # 同一份试卷的「试卷/答案」都判不出 → identity 重复
                self.unresolved = ["初三-月考-2024", "初三-月考-2024"]

        _stub_main_collaborators(monkeypatch, StubResolver)
        monkeypatch.setattr(crawler_cli.sys, "stdin", _FakeStdin(tty=False))

        code = crawler_cli.main(["--site", "zgkao", "--url", "https://e.com"])

        assert code == 2
        out = capsys.readouterr().out
        assert "Unresolved: 1" in out
        assert out.count("初三-月考-2024") == 1

    def test_returns_zero_when_nothing_unresolved(self, monkeypatch):
        class StubResolver:
            def __init__(self, prompt_fn=None):
                self.prompt_fn = prompt_fn
                self.unresolved = []

        _stub_main_collaborators(monkeypatch, StubResolver)
        monkeypatch.setattr(crawler_cli.sys, "stdin", _FakeStdin(tty=False))

        assert crawler_cli.main(["--site", "zgkao", "--url", "https://e.com"]) == 0

    def test_wires_stdin_prompt_only_for_tty(self, monkeypatch):
        seen = {}

        class StubResolver:
            def __init__(self, prompt_fn=None):
                self.prompt_fn = prompt_fn
                self.unresolved = []
                seen["prompt_fn"] = prompt_fn

        _stub_main_collaborators(monkeypatch, StubResolver)

        monkeypatch.setattr(crawler_cli.sys, "stdin", _FakeStdin(tty=False))
        crawler_cli.main(["--site", "zgkao", "--url", "https://e.com"])
        assert seen["prompt_fn"] is None

        monkeypatch.setattr(crawler_cli.sys, "stdin", _FakeStdin(tty=True))
        crawler_cli.main(["--site", "zgkao", "--url", "https://e.com"])
        assert seen["prompt_fn"] is crawler_cli._stdin_prompt

    def test_smartedu_never_builds_a_resolver(self, monkeypatch):
        seen = {}

        class StubResolver:
            def __init__(self, prompt_fn=None):
                seen["built"] = True

        monkeypatch.setattr(crawler_cli, "Checkpoint", _FakeCheckpoint)
        monkeypatch.setattr(crawler_cli, "Fetcher", lambda **kwargs: object())
        monkeypatch.setattr(crawler_cli, "ImageStore", lambda **kwargs: object())
        monkeypatch.setattr(crawler_cli, "ImageValidator", lambda: object())
        monkeypatch.setattr(crawler_cli, "SmartEduAdapter", lambda **kwargs: object())
        monkeypatch.setattr(crawler_cli, "Crawler", _FakeCrawler)
        monkeypatch.setattr(crawler_cli, "SemesterResolver", StubResolver)

        assert crawler_cli.main(["--site", "smartedu", "--subject", "数学"]) == 0
        assert seen == {}
