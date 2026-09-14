"""dictation_cli --extract 的测试：纯函数（页序/偏移/页窗/参数）+ 一次离线编排。

编排测试用假教材目录 + monkeypatch 掉 LLM（不碰网络），验证三件事：
1. 注释块必须**按页**在 join_pages 之前切掉（否则中间页的注释落进切片区间）；
2. LocateResult.rejected 必须进 unresolved 报告（不静默丢）；
3. 三份产物都落盘、自检通过的才进 JSONL（verified 恒为 1）。
"""

import json
from pathlib import Path
from types import SimpleNamespace

from dictation_cli import (
    _find_book_dir,
    _md_pages,
    _offset_mode,
    _offset_pairs,
    _same_work,
    _title_of,
    _unit_windows,
    _units_without_page,
    parse_args,
    run_extract,
)
from dictation_locate import LocateResult, LocatedPassage
from dictation_repair import RepairResult
from dictation_slice import join_pages, slice_body

# —— 假教材：封面 + 正文首页（下半页注释）+ 正文次页（末句与注释）——
PAGE_COVER = "封面"
PAGE_1 = """## 10 岳阳楼记 $^{①}$

庆历四年春，滕子京谪守巴陵郡。

①〔谪守〕贬官降职或流放。"""
PAGE_2 = """乃重修岳阳楼，增其旧制。

时六年九月十五日。

②〔胜状〕胜景，美好景色。"""

START = "庆历四年春，滕子京谪守巴陵郡。"
END = "时六年九月十五日。"

# —— 假教材（正文过短版）：切片成功但自检报「正文过短」，用来触发模型纠正 ——
PAGE_SHORT = """## 10 岳阳楼记 $^{①}$

庆历四年春，滕子京谪守巴陵郡。越明年。"""
SHORT_START = "庆历四年春，滕子京谪守巴陵郡。"
SHORT_END = "越明年。"
#: 模型纠正稿（比原文长很多——正是「过短」要补内容的情形，不得被长度规则拦住）
FIXED = ("庆历四年春，滕子京谪守巴陵郡。越明年，政通人和，百废具兴。"
         "乃重修岳阳楼，增其旧制，刻唐贤今人诗赋于其上。属予作文以记之。"
         "时六年九月十五日。")


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
        # output/md 下同年级同册的其它学科目录也含 --book 子串，且「数学」的字符串序在「语文」
        # 之前：全库搜索会抽到数学书（实测九上 163 页）。必须只在本科目目录里找。
        _make_book(tmp_path / "数学" / "初中" / "人教版" / "九年级" / "上册", "数学书", ["甲"])
        _make_book(tmp_path / "语文" / "初中" / "统编版" / "九年级" / "上册", "语文书", ["乙"])
        found = _find_book_dir(tmp_path, "九年级/上册")
        assert found is not None and found.name == "语文书"


class TestMdPages:
    def test_page_ordered(self, tmp_path):
        book = _make_book(tmp_path, "书", ["甲", "乙", "丙"])
        assert [n for n, _ in _md_pages(book)] == [1, 2, 3]
        assert _md_pages(book)[1][1] == "乙"


class TestTitleOf:
    def test_strips_number_prefix(self):
        assert _title_of("10 岳阳楼记") == "岳阳楼记"

    def test_keeps_label_without_number(self):
        assert _title_of("课外古诗词诵读") == "课外古诗词诵读"

    def test_strips_author_suffix(self):
        # 实测 toc_parse 的 label 是「篇名/作者」；作者不剥掉就与 LLM 的 work_title 对不上，
        # 会让「目录有但未找到」对全部候选误报
        assert _title_of("11 岳阳楼记/范仲淹") == "岳阳楼记"
        assert _title_of("13* 湖心亭看雪/张岱") == "湖心亭看雪"
        assert _title_of("26 出师表 / 诸葛亮") == "出师表"
        assert _title_of("十五从军征") == "十五从军征"


class TestOffset:
    def test_mode_when_consistent(self):
        assert _offset_mode([(2, 12), (3, 13), (4, 14), (5, 15)]) == 10

    def test_none_when_too_few_samples(self):
        assert _offset_mode([(2, 12), (3, 13)]) is None

    def test_none_when_inconsistent(self):
        assert _offset_mode([(2, 12), (3, 40), (4, 5), (5, 90)]) is None

    def test_pairs_use_first_occurrence(self):
        pages = [(1, "封面"), (2, "10 岳阳楼记\n正文"), (3, "10 岳阳楼记\n续")]
        cands = [{"label": "10 岳阳楼记", "printed_page": 46}]
        assert _offset_pairs(cands, pages) == [(46, 2)]

    def test_pairs_ignore_toc_lines(self):
        # 目录页把篇名写在「… 50」这种带页码的行里（或整条 label），不能算「篇名出现的页」
        pages = [
            (1, "封面"),
            (2, "目录\n阅读 11 岳阳楼记/范仲淹 50\n12 醉翁亭记/欧阳修 53"),
            (3, "# 11 岳阳楼记 $^{①}$\n\n范仲淹\n\n庆历四年春，滕子京谪守巴陵郡。"),
            (4, "# 12 醉翁亭记 $^{①}$\n\n环滁皆山也。"),
        ]
        cands = [{"label": "11 岳阳楼记/范仲淹", "printed_page": 50},
                 {"label": "12 醉翁亭记/欧阳修", "printed_page": 53}]
        assert _offset_pairs(cands, pages) == [(50, 3), (53, 4)]

    def test_pairs_accept_markerless_title_line(self):
        # 篇名独立成行也算标题行（LLM/OCR 有时不给角标）
        pages = [(1, "封面"), (2, "10 岳阳楼记\n庆历四年春。")]
        assert _offset_pairs([{"label": "10 岳阳楼记", "printed_page": 46}], pages) == [(46, 2)]


class TestUnitWindows:
    def test_windows_split_by_unit_with_offset(self):
        pages = [(n, f"第{n}页") for n in range(1, 31)]
        cands = [
            {"label": "10 岳阳楼记", "printed_page": 10, "unit_label": "第三单元"},
            {"label": "11 醉翁亭记", "printed_page": 14, "unit_label": "第三单元"},
            {"label": "12 湖心亭看雪", "printed_page": 30, "unit_label": "第四单元"},
        ]
        wins = _unit_windows(cands, pages, offset=2)
        assert [u for u, _ in wins] == ["第三单元", "第四单元"]
        # 第三单元窗：lo = 10+2-2 = 10；hi = min(30+2-1, 14+2+3) = 19
        assert wins[0][1][0] == "第10页"
        assert wins[0][1][-1] == "第19页"

    def test_window_not_inflated_by_distant_next_unit(self):
        # 相邻在候选清单里的单元可能隔着很远的页（第四/五单元是没进清单的现代文单元）：
        # 页窗只到本单元末篇 + 尾部余量，不把中间几十页也喂给模型
        pages = [(n, f"第{n}页") for n in range(1, 201)]
        cands = [
            {"label": "10 岳阳楼记", "printed_page": 50, "unit_label": "第三单元"},
            {"label": "26 出师表", "printed_page": 146, "unit_label": "第六单元"},
        ]
        wins = dict(_unit_windows(cands, pages, offset=7))
        assert wins["第三单元"][0] == "第55页"
        assert wins["第三单元"][-1] == "第60页"      # 50+7+3，而非 146+7-1
        assert wins["第六单元"][0] == "第151页"     # 146+7-2
        assert wins["第六单元"][-1] == "第200页"     # 末单元仍取到书尾

    def test_falls_back_to_whole_book_when_offset_none(self):
        pages = [(n, f"第{n}页") for n in range(1, 6)]
        cands = [{"label": "1 甲", "printed_page": 1, "unit_label": "第一单元"},
                 {"label": "2 乙", "printed_page": 3, "unit_label": "第二单元"}]
        wins = _unit_windows(cands, pages, offset=None)
        assert len(wins) == 2
        assert all(len(pgs) == 5 for _, pgs in wins)      # 整书喂给每个单元


class TestSameWork:
    def test_tolerates_paren_and_space_variants(self):
        # 目录 label 与 LLM 的 work_title 在标点上常有出入，逐字比会把已收篇目误报成漏收
        assert _same_work("行路难(其一)", "行路难（其一）")
        assert _same_work("南乡子 · 登京口北固亭有怀", "南乡子·登京口北固亭有怀")
        assert _same_work("浣溪沙（漠漠轻寒上小楼）", "浣溪沙")
        assert _same_work("岳阳楼记", "岳阳楼记")

    def test_different_works_do_not_match(self):
        assert not _same_work("岳阳楼记", "醉翁亭记")
        assert not _same_work("", "岳阳楼记")


class TestUnitsWithoutPage:
    def test_lists_units_without_any_printed_page(self):
        cands = [
            {"label": "咸阳城东楼/许浑", "printed_page": None, "unit_label": "第六单元"},
            {"label": "课外古诗词诵读", "printed_page": 159, "unit_label": "第六单元"},
            {"label": "十五从军征", "printed_page": None, "unit_label": "第三单元"},
        ]
        assert _units_without_page(cands) == ["第三单元"]

    def test_empty_when_all_units_have_page(self):
        assert _units_without_page([{"label": "甲", "printed_page": 1, "unit_label": "第一单元"}]) == []


class TestParseArgs:
    def test_requires_book_and_term(self):
        args = parse_args(["--extract", "--book", "九年级/上册", "--term", "上册"])
        assert args.extract and args.book == "九年级/上册" and args.term == "上册"

    def test_term_is_whitelisted(self):
        args = parse_args(["--all", "--book", "b", "--term", "下册"])
        assert args.all


class TestRunExtract:
    #: run_extract 会读 config 的 llm_* 构造客户端（测试里已把工厂换掉，值本身不参与）
    _FAKE_CONFIG = SimpleNamespace(
        output_dir=Path("."), llm_provider="local", llm_model="m", llm_api_key=None,
        llm_auth_token=None, llm_base_url=None, llm_timeout=1, llm_max_tokens=1,
        llm_max_retries=0, llm_thinking=False, llm_enable_cache=False,
        # 纠正兜底模型；置 None 表示未配置（只试主模型）
        llm_fallback_provider=None, llm_fallback_model="", llm_fallback_api_key=None,
        llm_fallback_base_url=None,
    )

    def _args(self, md_root: Path, out_root: Path):
        return parse_args([
            "--extract", "--book", "九年级/上册", "--term", "上册",
            "--input-dir", str(md_root), "--output-dir", str(out_root),
        ])

    def _patch_llm(self, monkeypatch, rejected: list[str], title: str = "岳阳楼记"):
        monkeypatch.setattr("dictation_cli.create_llm_client", lambda **kw: object())
        monkeypatch.setattr("dictation_cli._load_prompt", lambda name: "PROMPT")
        monkeypatch.setattr(
            "dictation_cli.locate_unit",
            lambda llm, label, text, prompt: LocateResult(
                passages=[LocatedPassage(
                    is_classical=True, work_title=title, author="范仲淹", dynasty="宋",
                    genre="wen", body_start_anchor=START, body_end_anchor=END, reason="测试用",
                )],
                rejected=list(rejected),
            ),
        )

    def _candidates(self, out_root: Path, label: str = "10 岳阳楼记/范仲淹") -> Path:
        p = out_root / "语文" / "上册" / "candidates.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(
            [{"label": label, "printed_page": 1,
              "unit_label": "第三单元", "unit_index": 3}], ensure_ascii=False), encoding="utf-8")
        return p

    def test_writes_three_artifacts_with_annotations_cut_per_page(self, tmp_path, monkeypatch):
        md_root = tmp_path / "md"
        _make_book(md_root / "语文" / "初中" / "统编版" / "九年级" / "上册", "书",
                   [PAGE_COVER, PAGE_1, PAGE_2])
        out_root = tmp_path / "dictation"
        self._candidates(out_root)
        self._patch_llm(monkeypatch, ["第1条《醉翁亭记》被丢弃：genre: 不是合法取值"])

        rc = run_extract(self._args(md_root, out_root), self._FAKE_CONFIG)
        assert rc == 0

        # 反证：不做按页切注释时，中间页的注释块会落进切片区间
        naive = slice_body(join_pages([PAGE_COVER, PAGE_1, PAGE_2]), START, END)
        assert naive is not None and "〔谪守〕" in naive

        book_out = out_root / "语文" / "上册"
        rows = [json.loads(line) for line in
                (book_out / "书.jsonl").read_text(encoding="utf-8").splitlines()]
        assert len(rows) == 1
        row = rows[0]
        assert row["work_title"] == "岳阳楼记" and row["verified"] == 1
        assert row["semester"] == "上册" and row["subject_id"] == "chinese"
        # 正文两端锚点都在、且中间页的注释已被按页切掉
        assert row["body"] == "庆历四年春，滕子京谪守巴陵郡。乃重修岳阳楼，增其旧制。时六年九月十五日。"
        assert "〔" not in row["body"] and "$^{" not in row["body"]
        assert row["_genre"] == "wen" and row["_needs_review"] is False

        # LocateResult.rejected 必须出现在待人工处理报告里
        unresolved = (book_out / "书-unresolved.md").read_text(encoding="utf-8")
        assert "条目校验失败被跳过" in unresolved
        assert "醉翁亭记" in unresolved

        review = (book_out / "书-review.md").read_text(encoding="utf-8")
        assert "| 岳阳楼记 | 范仲淹 | 宋 | wen |" in review

    def test_title_spelling_variant_not_reported_missing(self, tmp_path, monkeypatch):
        # 目录 label 用半角括号、模型回全角括号 → 不能因此报「目录有但页文本中未找到」
        md_root = tmp_path / "md"
        _make_book(md_root / "语文" / "初中" / "统编版" / "九年级" / "上册", "书",
                   [PAGE_COVER, PAGE_1, PAGE_2])
        out_root = tmp_path / "dictation"
        self._candidates(out_root, label="10 行路难(其一)/李白")
        self._patch_llm(monkeypatch, [], title="行路难（其一）")

        rc = run_extract(self._args(md_root, out_root), self._FAKE_CONFIG)
        assert rc == 0

        book_out = out_root / "语文" / "上册"
        rows = [json.loads(line) for line in
                (book_out / "书.jsonl").read_text(encoding="utf-8").splitlines()]
        assert [r["work_title"] for r in rows] == ["行路难（其一）"]
        assert "目录有但页文本中未找到" not in \
            (book_out / "书-unresolved.md").read_text(encoding="utf-8")

    def test_self_check_failure_goes_to_unresolved_not_jsonl(self, tmp_path, monkeypatch):
        md_root = tmp_path / "md"
        _make_book(md_root / "语文" / "初中" / "统编版" / "九年级" / "上册", "书",
                   [PAGE_COVER, PAGE_1, PAGE_2])
        out_root = tmp_path / "dictation"
        self._candidates(out_root)
        self._patch_llm(monkeypatch, [])
        # 末句锚点改成正文里不存在的句子 → 切片失败 → 只能进 unresolved
        monkeypatch.setattr(
            "dictation_cli.locate_unit",
            lambda llm, label, text, prompt: LocateResult(passages=[LocatedPassage(
                is_classical=True, work_title="岳阳楼记", author="范仲淹", dynasty="宋",
                genre="wen", body_start_anchor=START, body_end_anchor="不存在的末句。", reason="测试用",
            )]),
        )

        rc = run_extract(self._args(md_root, out_root), self._FAKE_CONFIG)
        assert rc == 0

        book_out = out_root / "语文" / "上册"
        assert (book_out / "书.jsonl").read_text(encoding="utf-8") == ""
        unresolved = (book_out / "书-unresolved.md").read_text(encoding="utf-8")
        assert "锚点未找到" in unresolved

    def _patch_locate_short(self, monkeypatch):
        """定位到「岳阳楼记」，但页文本只够切出**过短**的正文 → 触发自检 errors。"""
        monkeypatch.setattr(
            "dictation_cli.locate_unit",
            lambda llm, label, text, prompt: LocateResult(passages=[LocatedPassage(
                is_classical=True, work_title="岳阳楼记", author="范仲淹", dynasty="宋",
                genre="wen", body_start_anchor=SHORT_START, body_end_anchor=SHORT_END,
                reason="测试用",
            )]),
        )

    def _short_book_setup(self, tmp_path, monkeypatch):
        md_root = tmp_path / "md"
        _make_book(md_root / "语文" / "初中" / "统编版" / "九年级" / "上册", "书",
                   [PAGE_COVER, PAGE_SHORT])
        out_root = tmp_path / "dictation"
        self._candidates(out_root)
        self._patch_llm(monkeypatch, [])
        self._patch_locate_short(monkeypatch)
        return md_root, out_root

    def test_self_check_failure_repaired_and_adopted(self, tmp_path, monkeypatch):
        md_root, out_root = self._short_book_setup(tmp_path, monkeypatch)
        monkeypatch.setattr(
            "dictation_cli.repair_body",
            lambda *a, **kw: RepairResult(
                body=FIXED, source="local:fake", attempts=["local:fake 已采用"],
                note="local:fake（21 -> 76 字）"),
        )

        assert run_extract(self._args(md_root, out_root), self._FAKE_CONFIG) == 0

        book_out = out_root / "语文" / "上册"
        rows = [json.loads(line) for line in
                (book_out / "书.jsonl").read_text(encoding="utf-8").splitlines()]
        # 模型纠正稿被**直接采用**（用户 2026-09-14 裁决：不设采纳闸门），verified=1 进抽题池
        assert len(rows) == 1
        assert rows[0]["body"] == FIXED and rows[0]["verified"] == 1

        # 原文与纠正稿必须都摆进过目清单供人比对
        review = (book_out / "书-review.md").read_text(encoding="utf-8")
        assert "已由模型纠正" in review
        assert "纠正前" in review and "纠正后" in review
        assert FIXED in review and "越明年。" in review
        assert "自检未通过" not in (book_out / "书-unresolved.md").read_text(encoding="utf-8")

    def test_self_check_failure_unresolved_when_models_give_nothing(self, tmp_path, monkeypatch):
        # 两个模型都拿不出非空输出 → 维持 fail-closed，绝不把原文当「已纠正」放行
        md_root, out_root = self._short_book_setup(tmp_path, monkeypatch)
        monkeypatch.setattr(
            "dictation_cli.repair_body",
            lambda *a, **kw: RepairResult(
                body=None, source=None, attempts=["local:x 调用失败：boom"],
                note="所有模型均未给出非空输出，维持 fail-closed"),
        )

        assert run_extract(self._args(md_root, out_root), self._FAKE_CONFIG) == 0

        book_out = out_root / "语文" / "上册"
        assert (book_out / "书.jsonl").read_text(encoding="utf-8") == ""
        unresolved = (book_out / "书-unresolved.md").read_text(encoding="utf-8")
        assert "纠正未成" in unresolved and "boom" in unresolved

    def test_repair_not_called_when_check_passes(self, tmp_path, monkeypatch):
        # 触发范围只限「致命错误」档：自检通过的篇目不得送去纠正（用户明确裁决）
        md_root = tmp_path / "md"
        _make_book(md_root / "语文" / "初中" / "统编版" / "九年级" / "上册", "书",
                   [PAGE_COVER, PAGE_1, PAGE_2])
        out_root = tmp_path / "dictation"
        self._candidates(out_root)
        self._patch_llm(monkeypatch, [])
        calls: list[int] = []
        monkeypatch.setattr("dictation_cli.repair_body", lambda *a, **kw: calls.append(1))

        assert run_extract(self._args(md_root, out_root), self._FAKE_CONFIG) == 0
        assert calls == []

        book_out = out_root / "语文" / "上册"
        rows = [json.loads(line) for line in
                (book_out / "书.jsonl").read_text(encoding="utf-8").splitlines()]
        assert rows[0]["_original_body"] is None
        assert rows[0]["_repair_residual"] == []

    def test_missing_candidates_file_returns_1(self, tmp_path, capsys):
        md_root = tmp_path / "md"
        _make_book(md_root / "语文" / "九年级" / "上册", "书", ["甲"])
        rc = run_extract(self._args(md_root, tmp_path / "dictation"),
                         self._FAKE_CONFIG)
        assert rc == 1

    def test_missing_book_dir_returns_1(self, tmp_path):
        out_root = tmp_path / "dictation"
        self._candidates(out_root)
        rc = run_extract(self._args(tmp_path / "md", out_root),
                         self._FAKE_CONFIG)
        assert rc == 1
