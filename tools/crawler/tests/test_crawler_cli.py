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
    items_filtered = 0
    items_skipped = 0
    items_duplicate = 0
    items_without_file = 0
    files_downloaded = 1
    files_skipped = 0
    files_failed = 0
    files_unresolved = 0


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


class TestZeroDownloadHint:
    """新下载 0 + 之前已下 > 0 时要说清「不是没下，是之前下过」。"""

    def _run_with(self, monkeypatch, downloaded, skipped):
        class _Result:
            items_total = 201
            items_filtered = 0
            items_skipped = skipped
            items_duplicate = 0
            items_without_file = 0
            files_downloaded = downloaded
            files_skipped = 0
            files_failed = 0
            files_unresolved = 0

        class _Crawler:
            def __init__(self, **kwargs):
                pass

            def run(self, filters):
                return _Result()

        class StubResolver:
            def __init__(self, prompt_fn=None):
                self.unresolved = []

        _stub_main_collaborators(monkeypatch, StubResolver)
        monkeypatch.setattr(crawler_cli, "Crawler", _Crawler)
        monkeypatch.setattr(crawler_cli.sys, "stdin", _FakeStdin(tty=False))
        return crawler_cli.main(["--site", "zgkao", "--url", "https://e.com"])

    def test_prints_hint_when_everything_skipped(self, monkeypatch, capsys):
        self._run_with(monkeypatch, downloaded=0, skipped=104)
        out = capsys.readouterr().out
        assert "本次没有新文件" in out
        assert "--force" in out

    def test_no_hint_when_files_downloaded(self, monkeypatch, capsys):
        self._run_with(monkeypatch, downloaded=6, skipped=0)
        assert "本次没有新文件" not in capsys.readouterr().out


class TestSummaryFormat:
    """汇总必须把「条目」和「文件」分开报。

    Total 数的是索引页的行，下载/已存在数的是文件，一行可以换 0 个或 2 个文件；
    混在一行里用户就会拿 Total 去减，对不上便以为漏下载（2026-10-30 的 203 vs 200）。
    """

    def _run_with(self, monkeypatch, capsys, dry_run=False, **fields):
        class _Result:
            items_total = fields["items_total"]
            items_filtered = 0
            items_skipped = fields["items_skipped"]
            items_duplicate = fields["items_duplicate"]
            items_without_file = fields["items_without_file"]
            files_downloaded = fields["files_downloaded"]
            files_skipped = fields["files_skipped"]
            files_failed = 0
            files_unresolved = 0

        class _Crawler:
            def __init__(self, **kwargs):
                pass

            def run(self, filters):
                return _Result()

        class StubResolver:
            def __init__(self, prompt_fn=None):
                self.unresolved = []

        _stub_main_collaborators(monkeypatch, StubResolver)
        monkeypatch.setattr(crawler_cli, "Crawler", _Crawler)
        monkeypatch.setattr(crawler_cli.sys, "stdin", _FakeStdin(tty=False))
        argv = ["--site", "zgkao", "--url", "https://e.com"] + (["--dry-run"] if dry_run else [])
        crawler_cli.main(argv)
        return capsys.readouterr().out

    def test_item_line_and_file_line_are_separate(self, monkeypatch, capsys):
        out = self._run_with(
            monkeypatch, capsys, items_total=203, items_skipped=33, items_duplicate=3,
            items_without_file=4, files_downloaded=45, files_skipped=152,
        )
        assert "条目：总计 203" in out
        assert "重复 3" in out and "无文件 4" in out
        assert "文件：新下载 45" in out and "已存在 152" in out
        # 旧口径（把文件数写成 Downloaded/Skipped）必须消失，否则又是一次误读
        assert "Downloaded:" not in out and "Skipped:" not in out

    def test_dry_run_says_would_download_not_downloaded(self, monkeypatch, capsys):
        """dry-run 一个文件都没下，就不能写「新下载 N」。"""
        out = self._run_with(
            monkeypatch, capsys, dry_run=True, items_total=203, items_skipped=33,
            items_duplicate=3, items_without_file=4, files_downloaded=165, files_skipped=0,
        )
        assert "文件：将下载 165" in out
        assert "新下载" not in out
