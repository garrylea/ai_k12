"""dictation_cli 体裁标定单测（纯部分 + 假连接，不碰真库）。

钉住三件事：
- 体裁只认 `poem` / `prose`，**不猜、不模糊匹配**（spec §4.1：猜错就按错档发分）；
- 批量文件**整份先校验再落库**，第 N 行非法不能写出前半批；
- 清单里未标定行渲染成 `待定`。
"""

from types import SimpleNamespace

import pytest

import dictation_cli as cli


class _FakeCursor:
    def __init__(self, exists: dict[int, str]):
        self._exists = exists
        self.executed = []

    def execute(self, sql, args=None):
        self.executed.append((sql, args))

    def fetchone(self):
        # 只服务 `SELECT work_title FROM chinese_passages WHERE id = %s`：按最后一次 execute 的 id 回
        if not self.executed:
            return None
        args = self.executed[-1][1]
        title = self._exists.get(args[0]) if args else None
        return (title,) if title is not None else None

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class _FakeConn:
    def __init__(self, exists: dict[int, str]):
        self.cur = _FakeCursor(exists)
        self.committed = 0
        self.closed = 0

    def cursor(self):
        return self.cur

    def commit(self):
        self.committed += 1

    def close(self):
        self.closed += 1


_FAKE_CONFIG = SimpleNamespace()


class TestValidateGenre:
    def test_accepts_known_genres(self):
        assert cli.validate_genre("poem") == "poem"
        assert cli.validate_genre("prose") == "prose"

    def test_strips_whitespace(self):
        assert cli.validate_genre("  poem ") == "poem"

    @pytest.mark.parametrize("bad", ["shi", "wen", "古诗", "", "   ", "Poem", "poems"])
    def test_rejects_unknown(self, bad):
        with pytest.raises(ValueError):
            cli.validate_genre(bad)


class TestParseGenreUpdates:
    def test_parses_rows_and_skips_blanks_and_comments(self):
        text = "11\tpoem\n\n# 这是注释\n12\tprose\n   \n"
        assert cli.parse_genre_updates(text) == [(11, "poem"), (12, "prose")]

    def test_rejects_space_separator(self):
        # 格式规定用 TAB；空格分隔是常见手误，必须响亮失败而不是被 split 成两列之一
        with pytest.raises(ValueError, match="格式"):
            cli.parse_genre_updates("11 poem\n")

    def test_rejects_extra_columns(self):
        with pytest.raises(ValueError, match="格式"):
            cli.parse_genre_updates("11\tpoem\textra\n")

    def test_rejects_non_positive_id(self):
        with pytest.raises(ValueError, match="正整数"):
            cli.parse_genre_updates("0\tpoem\n")

    def test_rejects_non_numeric_id(self):
        with pytest.raises(ValueError, match="正整数"):
            cli.parse_genre_updates("abc\tpoem\n")

    def test_rejects_invalid_genre_with_line_number(self):
        with pytest.raises(ValueError, match="第 2 行"):
            cli.parse_genre_updates("11\tpoem\n12\tshi\n")

    def test_empty_text_yields_no_updates(self):
        assert cli.parse_genre_updates("# 只有注释\n\n") == []


class TestRenderGenreTable:
    def test_marks_unset_as_pending(self):
        out = cli.render_genre_table([(11, "岳阳楼记", "宋", None), (12, "静夜思", "唐", "poem")])
        assert "待定" in out
        assert "| 11 | 岳阳楼记 | 宋 | 待定 |" in out
        assert "| 12 | 静夜思 | 唐 | poem |" in out

    def test_empty_rows_still_renders_header(self):
        out = cli.render_genre_table([])
        assert "| id | 篇名 | 朝代 | 体裁 |" in out
        assert "无 verified 篇目" in out


class TestGenreArgs:
    def test_export_genre_does_not_require_book_or_term(self):
        args = cli.parse_args(["--export-genre"])
        assert args.export_genre

    def test_set_genre_single(self):
        args = cli.parse_args(["--set-genre", "--id", "11", "--genre", "poem"])
        assert args.set_genre and args.id == 11 and args.genre == "poem"

    def test_extract_still_requires_book_and_term(self):
        # 旧行为保留：抽取/入库路径缺 --book/--term 仍是用法错误
        with pytest.raises(SystemExit):
            cli.parse_args(["--extract"])

    def test_actions_are_mutually_exclusive(self):
        with pytest.raises(SystemExit):
            cli.parse_args(["--all", "--book", "b", "--term", "上册", "--export-genre"])


class TestRunSetGenre:
    def _patch(self, monkeypatch, exists):
        conn = _FakeConn(exists)
        monkeypatch.setattr(cli, "_connect", lambda config: conn)
        return conn

    def test_single_writes_and_prints_title(self, monkeypatch, capsys):
        conn = self._patch(monkeypatch, {11: "岳阳楼记"})
        args = cli.parse_args(["--set-genre", "--id", "11", "--genre", "prose"])

        assert cli.run_set_genre(args, _FAKE_CONFIG) == 0
        assert conn.committed == 1 and conn.closed == 1
        updates = [e for e in conn.cur.executed if e[0].startswith("UPDATE")]
        assert updates and updates[0][1] == ("prose", 11)
        assert "岳阳楼记" in capsys.readouterr().out

    def test_batch_validates_all_before_writing(self, monkeypatch, tmp_path):
        # 第 2 行非法 → 整批不落库（连接都不该建立）
        path = tmp_path / "genre.tsv"
        path.write_text("11\tpoem\n12\tshi\n", encoding="utf-8")
        monkeypatch.setattr(cli, "_connect", lambda config: pytest.fail("非法批次不应连库"))
        args = cli.parse_args(["--set-genre", "--input", str(path)])

        assert cli.run_set_genre(args, _FAKE_CONFIG) == 2

    def test_unknown_id_is_skipped(self, monkeypatch, capsys):
        conn = self._patch(monkeypatch, {11: "岳阳楼记"})
        args = cli.parse_args(["--set-genre", "--id", "999", "--genre", "poem"])

        assert cli.run_set_genre(args, _FAKE_CONFIG) == 0
        assert not [e for e in conn.cur.executed if e[0].startswith("UPDATE")]
        assert "未找到篇目 id=999" in capsys.readouterr().out

    def test_invalid_genre_rejected_without_db(self, monkeypatch):
        monkeypatch.setattr(cli, "_connect", lambda config: pytest.fail("非法体裁不应连库"))
        args = cli.parse_args(["--set-genre", "--id", "11", "--genre", "shi"])

        assert cli.run_set_genre(args, _FAKE_CONFIG) == 2
