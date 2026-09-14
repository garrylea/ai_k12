"""dictation_cli 单测：编排逻辑（定位/身份/自检/纠正/落产物）。

真正的版面判断在 `test_dictation_locate.py`（纯程序、有真书夹具）；
这里只钉编排：协议、分流、留痕、以及「两模型都拿不到稿才 fail-closed」。
"""

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from dictation_cli import (
    _compute_offset,
    _find_book_dir,
    _md_pages,
    _offset_mode,
    _same_work,
    _title_of,
    parse_args,
    run_extract,
)
from dictation_locate import LocatedBody, PieceIdentity
from dictation_repair import RepairResult

# —— 假教材：标题行 + 作者 + `## 预习` 两条 ◎ + 正文 ——
PAGE_1 = """## 10 岳阳楼记 $^{①}$

范仲淹

## 预习

◎ 朗读课文，注意重音和停连。

◎ 体会作者的思想感情。

庆历四年春，滕子京谪守巴陵郡。越明年，政通人和，百废具兴。
乃重修岳阳楼，增其旧制，刻唐贤今人诗赋于其上。
时六年九月十五日。"""

GOOD_BODY = ("庆历四年春，滕子京谪守巴陵郡。越明年，政通人和，百废具兴。"
             "乃重修岳阳楼，增其旧制，刻唐贤今人诗赋于其上。时六年九月十五日。")
FIXED_BODY = GOOD_BODY + "属予作文以记之。"


def _make_book(root: Path, name: str, pages: list[str]) -> Path:
    d = root / name
    d.mkdir(parents=True, exist_ok=True)
    for i, text in enumerate(pages, 1):
        (d / f"page_{i:03d}.md").write_text(text, encoding="utf-8")
    return d


class TestFindBookDir:
    def test_finds_book_by_substring(self, tmp_path):
        _make_book(tmp_path / "语文" / "初中" / "统编版" / "九年级" / "上册", "书", ["甲"])
        found = _find_book_dir(tmp_path, "九年级/上册")
        assert found is not None and found.name == "书"

    def test_returns_none_when_absent(self, tmp_path):
        _make_book(tmp_path / "语文" / "九年级" / "下册", "书", ["甲"])
        assert _find_book_dir(tmp_path, "九年级/上册") is None

    def test_searches_only_own_subject(self, tmp_path):
        # output/md 下同年级同册的其它学科目录也含 --book 子串，且「数学」的字符串序在
        # 「语文」之前：全库搜索会抽到数学书（实测九上 163 页）。必须只在本科目目录里找。
        _make_book(tmp_path / "数学" / "初中" / "人教版" / "九年级" / "上册", "数学书", ["甲"])
        _make_book(tmp_path / "语文" / "初中" / "统编版" / "九年级" / "上册", "语文书", ["乙"])
        found = _find_book_dir(tmp_path, "九年级/上册")
        assert found is not None and found.name == "语文书"


class TestMdPages:
    def test_page_ordered(self, tmp_path):
        book = _make_book(tmp_path, "书", ["甲", "乙", "丙"])
        assert [n for n, _ in _md_pages(book)] == [1, 2, 3]

    def test_reads_text(self, tmp_path):
        book = _make_book(tmp_path, "书", ["甲", "乙"])
        assert _md_pages(book)[1][1] == "乙"


class TestTitleOf:
    def test_strips_number_prefix(self):
        assert _title_of("10 岳阳楼记") == "岳阳楼记"

    def test_strips_star_prefix(self):
        assert _title_of("13* 湖心亭看雪") == "湖心亭看雪"

    def test_strips_author_after_slash(self):
        # TOC label 是「篇名/作者」，作者必须剥掉（留着会与正文标题行对不上）
        assert _title_of("11 岳阳楼记/范仲淹") == "岳阳楼记"
        assert _title_of("26 出师表 / 诸葛亮") == "出师表"


class TestSameWork:
    def test_ignores_paren_style(self):
        assert _same_work("行路难(其一)", "行路难（其一）")

    def test_ignores_spaces(self):
        assert _same_work("南乡子 · 登京口北固亭有怀", "南乡子·登京口北固亭有怀")

    def test_prefix_counts_as_same(self):
        assert _same_work("水调歌头", "水调歌头（明月几时有）")

    def test_different_titles(self):
        assert not _same_work("岳阳楼记", "醉翁亭记")

    def test_empty_is_not_same(self):
        assert not _same_work("", "岳阳楼记")


class TestOffsetMode:
    def test_returns_mode(self):
        assert _offset_mode([(50, 57), (53, 60), (56, 63)]) == 7

    def test_too_few_samples_returns_none(self):
        assert _offset_mode([(50, 57), (53, 60)]) is None

    def test_low_share_returns_none(self):
        # 4 个样本、差值全都不同 → 众数占比 25% < 50% → 判不可靠
        assert _offset_mode([(1, 8), (2, 20), (3, 30), (4, 40)]) is None


class TestComputeOffset:
    def test_ignores_directory_page_hits(self, tmp_path):
        # 目录页（page_001）也列了《岳阳楼记》，但它**不匹配标题行**，
        # 故只有正文页参与众数 → 干净得到 1（旧实现会被目录的离群差值拖到判不可靠）
        book = _make_book(tmp_path, "书", [
            "目录\n10 岳阳楼记/范仲淹 1\n11 醉翁亭记/欧阳修 2",
            "## 10 岳阳楼记 $^{①}$\n\n庆历四年春。",
            "## 11 醉翁亭记 $^{①}$\n\n环滁皆山也。",
            "## 12 湖心亭看雪 $^{①}$\n\n崇祯五年十二月。",
        ])
        candidates = [
            {"label": "10 岳阳楼记/范仲淹", "printed_page": 1, "unit_label": "第三单元"},
            {"label": "11 醉翁亭记/欧阳修", "printed_page": 2, "unit_label": "第三单元"},
            {"label": "12 湖心亭看雪/张岱", "printed_page": 3, "unit_label": "第三单元"},
        ]
        assert _compute_offset(candidates, _md_pages(book)) == 1


class TestParseArgs:
    def test_requires_book_and_term(self):
        with pytest.raises(SystemExit):
            parse_args(["--extract"])

    def test_term_is_whitelisted(self):
        assert parse_args(["--all", "--book", "b", "--term", "下册"]).all


class TestRunExtract:
    _FAKE_CONFIG = SimpleNamespace(
        output_dir=Path("."), llm_provider="local", llm_model="m", llm_api_key=None,
        llm_auth_token=None, llm_base_url=None, llm_timeout=1, llm_max_tokens=1,
        llm_max_retries=0, llm_thinking=False, llm_enable_cache=False,
        llm_fallback_provider=None, llm_fallback_model="", llm_fallback_api_key=None,
        llm_fallback_base_url=None,
    )

    def _args(self, md_root: Path, out_root: Path):
        return parse_args([
            "--extract", "--book", "九年级/上册", "--term", "上册",
            "--input-dir", str(md_root), "--output-dir", str(out_root),
        ])

    def _candidates(self, out_root: Path, label: str = "10 岳阳楼记/范仲淹") -> Path:
        p = out_root / "语文" / "上册" / "candidates.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(
            [{"label": label, "printed_page": 1, "unit_label": "第三单元"}], ensure_ascii=False),
            encoding="utf-8")
        return p

    def _setup(self, tmp_path, monkeypatch, body=None, identity=None, repair=None):
        md_root = tmp_path / "md"
        _make_book(md_root / "语文" / "初中" / "统编版" / "九年级" / "上册", "书", [PAGE_1])
        out_root = tmp_path / "dictation"
        self._candidates(out_root)
        monkeypatch.setattr("dictation_cli.create_llm_client", lambda **kw: object())
        monkeypatch.setattr("dictation_cli._load_prompt", lambda name: "PROMPT")
        monkeypatch.setattr(
            "dictation_cli.locate_body",
            lambda *a, **kw: LocatedBody(work_title="a", body=body if body is not None else GOOD_BODY,
                                         start_page=1, end_page=1, notes=["终止于编者栏目（预习）"]),
        )
        monkeypatch.setattr(
            "dictation_cli.ask_identity",
            lambda llm, title, prompt: identity or PieceIdentity(
                author="范仲淹", dynasty="宋", genre="wen"),
        )
        if repair is not None:
            monkeypatch.setattr("dictation_cli.repair_body", lambda *a, **kw: repair)
        return md_root, out_root

    def _rows(self, out_root: Path):
        return [json.loads(line) for line in
                (out_root / "语文" / "上册" / "书.jsonl").read_text(encoding="utf-8").splitlines()]

    def test_writes_verified_row_with_identity(self, tmp_path, monkeypatch):
        md_root, out_root = self._setup(tmp_path, monkeypatch)
        assert run_extract(self._args(md_root, out_root), self._FAKE_CONFIG) == 0

        rows = self._rows(out_root)
        assert len(rows) == 1
        r = rows[0]
        assert r["work_title"] == "岳阳楼记" and r["verified"] == 1
        assert r["author"] == "范仲淹" and r["dynasty"] == "宋"
        assert r["semester"] == "上册" and r["subject_id"] == "chinese"

        review = (out_root / "语文" / "上册" / "书-review.md").read_text(encoding="utf-8")
        assert "定位留痕" in review and "终止于编者栏目" in review
        assert "（无）" in (out_root / "语文" / "上册" / "书-unresolved.md").read_text(encoding="utf-8")

    def test_unlocated_piece_goes_to_unresolved(self, tmp_path, monkeypatch):
        md_root, out_root = self._setup(tmp_path, monkeypatch)
        monkeypatch.setattr("dictation_cli.locate_body", lambda *a, **kw: None)

        assert run_extract(self._args(md_root, out_root), self._FAKE_CONFIG) == 0
        assert (out_root / "语文" / "上册" / "书.jsonl").read_text(encoding="utf-8") == ""
        assert "未切出正文" in (out_root / "语文" / "上册" / "书-unresolved.md").read_text(encoding="utf-8")

    def test_missing_title_line_reported(self, tmp_path, monkeypatch):
        md_root, out_root = self._setup(tmp_path, monkeypatch)
        # 候选说有一篇《不存在的篇》，但页里没有它的标题行
        self._candidates(out_root, label="99 不存在的篇/某人")
        assert run_extract(self._args(md_root, out_root), self._FAKE_CONFIG) == 0
        assert "未找到标题行" in \
            (out_root / "语文" / "上册" / "书-unresolved.md").read_text(encoding="utf-8")

    def test_self_check_failure_repaired_and_adopted(self, tmp_path, monkeypatch):
        # 正文含角标 `$` → 自检报错 → 交模型纠正 → 纠正稿直接采用
        # 竖线是 normalize_body 删不掉的（角标会被删掉，故不能用角标当坏样本）
        broken = GOOD_BODY + "|"
        md_root, out_root = self._setup(
            tmp_path, monkeypatch, body=broken,
            repair=RepairResult(body=FIXED_BODY, source="local:fake",
                                attempts=["local:fake 已采用"], note="local:fake（76 -> 82 字）"),
        )
        assert run_extract(self._args(md_root, out_root), self._FAKE_CONFIG) == 0

        rows = self._rows(out_root)
        assert len(rows) == 1 and rows[0]["body"] == FIXED_BODY and rows[0]["verified"] == 1
        review = (out_root / "语文" / "上册" / "书-review.md").read_text(encoding="utf-8")
        assert "已由模型纠正" in review and "纠正前" in review and "纠正后" in review

    def test_self_check_failure_unresolved_when_models_give_nothing(self, tmp_path, monkeypatch):
        # 竖线是 normalize_body 删不掉的（角标会被删掉，故不能用角标当坏样本）
        broken = GOOD_BODY + "|"
        md_root, out_root = self._setup(
            tmp_path, monkeypatch, body=broken,
            repair=RepairResult(body=None, attempts=["local:x 调用失败：boom"]),
        )
        assert run_extract(self._args(md_root, out_root), self._FAKE_CONFIG) == 0
        assert (out_root / "语文" / "上册" / "书.jsonl").read_text(encoding="utf-8") == ""
        unresolved = (out_root / "语文" / "上册" / "书-unresolved.md").read_text(encoding="utf-8")
        assert "纠正未成" in unresolved and "boom" in unresolved

    def test_repair_not_called_when_check_passes(self, tmp_path, monkeypatch):
        # 触发范围只限致命档：自检通过不得送去纠正
        md_root, out_root = self._setup(tmp_path, monkeypatch)
        called: list[int] = []
        monkeypatch.setattr("dictation_cli.repair_body", lambda *a, **kw: called.append(1))
        assert run_extract(self._args(md_root, out_root), self._FAKE_CONFIG) == 0
        assert called == []
        assert self._rows(out_root)[0]["_original_body"] is None

    def test_identity_failure_does_not_block_but_flags_review(self, tmp_path, monkeypatch):
        md_root, out_root = self._setup(tmp_path, monkeypatch)
        def boom(llm, title, prompt):
            raise RuntimeError("identity down")
        monkeypatch.setattr("dictation_cli.ask_identity", boom)

        assert run_extract(self._args(md_root, out_root), self._FAKE_CONFIG) == 0
        rows = self._rows(out_root)
        assert len(rows) == 1
        assert rows[0]["author"] == "" and rows[0]["_genre"] == "other"
        assert rows[0]["_needs_review"] is True
        assert any("作者/朝代获取失败" in reason for reason in rows[0]["_review_reasons"])

    def test_missing_candidates_file_returns_1(self, tmp_path):
        md_root = tmp_path / "md"
        _make_book(md_root / "语文" / "九年级" / "上册", "书", ["甲"])
        assert run_extract(self._args(md_root, tmp_path / "dictation"), self._FAKE_CONFIG) == 1

    def test_missing_book_dir_returns_1(self, tmp_path):
        out_root = tmp_path / "dictation"
        self._candidates(out_root)
        assert run_extract(self._args(tmp_path / "md", out_root), self._FAKE_CONFIG) == 1
