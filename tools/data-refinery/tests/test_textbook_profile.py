"""textbook_profile 单测：学科版式档案（基类 + 每学科实现 + 注册表）。

两组最重要的用例：

1. **数学黄金回归**——`toc_parse_cli` 与 `card_splitter` 是数学管线（教材卡 + 试卷切题）
   共用的，重构**不得改变数学判定**。这里用三重保险钉住：
   a. 两条正则的 pattern 字符串与重构前逐字一致（test_patterns_frozen_verbatim）；
   b. brief 手工用例的前后判定（TestMathProfileUnchanged）；
   c. 真实数学教材抽样的 494 行冻结语料（TestMathGoldenCorpusConsistency）——
      预期值是用**重构前**的模块级正则实跑测出来的，见 tests/fixtures/math_layout_corpus.json。

2. **语文档案**——用例全部取自九上真实目录页（page_004–007）与版面实测，
   `CN_FURNITURE_POSITIVE` 的两条都是全书实跑 grep 出来的真实页眉/页脚残留。
"""

import json
from pathlib import Path

from textbook_profile import (
    ChineseTextbookProfile,
    MathTextbookProfile,
    TextbookProfile,
    get_profile,
    profile_for_md_path,
)

FIXTURES = Path(__file__).parent / "fixtures"


# ---------------------------------------------------------------------------
# 重构前正则的逐字快照（来源：toc_parse_cli._TOC_LINE_RE / card_splitter._PAGE_NUMBER_HEADER_RE）
# ---------------------------------------------------------------------------
_FROZEN_MATH_TOC_PATTERN = (
    r'^\s*(第[一二三四五六七八九十百零]+章.*\d+\s*$'      # 第N章 X 页码
    r'|\d+\.\d+.*\d+\s*$'                                # N.M X 页码
    r'|.*(小结|复习题|数学活动|阅读与思考).*\d+\s*$)'       # 非编号条目+页码
)
_FROZEN_MATH_FURNITURE_PATTERN = r'^\d+\s+第[一二三四五六七八九十百零]+章\s+\S+.*$'


# 数学黄金用例：前半「是否目录行」、后半「是否版面残留」
MATH_TOC_POSITIVE = [
    "第二十六章 反比例函数 1",
    "26.1 反比例函数 2",
    "小结 12",
    "复习题26 15",
    "数学活动 9",
    "阅读与思考 生活中的反比例关系 17",
]
MATH_TOC_NEGATIVE = [
    "## 练习",
    "第N单元",
    "1 沁园春·雪/毛泽东 3",
    "把一根长 3 米的绳子剪成两段，每段长多少？",
    "26.1",
]
MATH_FURNITURE_POSITIVE = ["3 第二十一章 一元二次方程", "81 第二十六章 反比例函数"]
MATH_FURNITURE_NEGATIVE = [
    "## 练习",
    "60 | 阅读 | 第三单元",
    "第二十六章 反比例函数",
    "在 Rt△ABC 中，∠C=90°，AC=3。",
]


class TestMathProfileUnchanged:
    """黄金回归：重构不得改变数学判定。"""

    def setup_method(self):
        self.p = MathTextbookProfile()

    def test_patterns_frozen_verbatim(self):
        """两条正则必须与重构前逐字一致——这是「行为零变化」的根保证。"""
        assert MathTextbookProfile._TOC_LINE_RE.pattern == _FROZEN_MATH_TOC_PATTERN
        assert (MathTextbookProfile._PAGE_NUMBER_HEADER_RE.pattern
                == _FROZEN_MATH_FURNITURE_PATTERN)

    def test_toc_positive(self):
        for line in MATH_TOC_POSITIVE:
            assert self.p.is_toc_line(line) is True, line

    def test_toc_negative(self):
        for line in MATH_TOC_NEGATIVE:
            assert self.p.is_toc_line(line) is False, line

    def test_furniture_positive(self):
        for line in MATH_FURNITURE_POSITIVE:
            assert self.p.is_page_furniture(line) is True, line

    def test_furniture_negative(self):
        for line in MATH_FURNITURE_NEGATIVE:
            assert self.p.is_page_furniture(line) is False, line

    def test_is_toc_line_returns_bool_not_match(self):
        """调用方做 `sum(1 for ... if profile.is_toc_line(l))`，必须返回 bool 而非 Match。"""
        assert self.p.is_toc_line("小结 12") is True
        assert self.p.is_page_furniture("3 第二十一章 一元二次方程") is True


class TestMathGoldenCorpusConsistency:
    """真实教材行的冻结语料回归：预期值 = 重构前两条正则的实跑判定。

    语料来源：`output/md/数学/初中/{八九}年级/*` 五本人教版教材的 page_*.md，
    取全部「目录行判定为 True」的行 + 均匀抽样的 300 条反例行（去重、行长 ≤120）。
    产物已固化为 fixtures/math_layout_corpus.json，故本测试不依赖被 gitignore 的 output/。
    """

    def setup_method(self):
        entries = json.loads((FIXTURES / "math_layout_corpus.json").read_text(encoding="utf-8"))
        self.entries = entries
        self.p = MathTextbookProfile()

    def test_corpus_is_non_trivial(self):
        """语料必须真有正例——否则回归形同虚设。"""
        assert len(self.entries) >= 400
        assert sum(1 for e in self.entries if e["toc"]) >= 100
        assert sum(1 for e in self.entries if e["furniture"]) >= 1

    def test_toc_verdicts_match_pre_refactor(self):
        mismatches = [
            (e["line"], e["toc"], self.p.is_toc_line(e["line"]))
            for e in self.entries if self.p.is_toc_line(e["line"]) is not e["toc"]
        ]
        assert mismatches == [], f"{len(mismatches)} 条目录判定与重构前不一致"

    def test_furniture_verdicts_match_pre_refactor(self):
        mismatches = [
            (e["line"], e["furniture"], self.p.is_page_furniture(e["line"]))
            for e in self.entries if self.p.is_page_furniture(e["line"]) is not e["furniture"]
        ]
        assert mismatches == [], f"{len(mismatches)} 条残留判定与重构前不一致"


# 语文用例全部取自九上真实目录页与版面实测（spec §4.1/§4.2）
CN_TOC_POSITIVE = [
    "第一单元 活动·探究 1",
    "任务一 学习鉴赏 2",
    "1 沁园春·雪/毛泽东 3",
    "阅读 7 培养德智体美劳全面发展的社会主义建设者和接班人/习近平 22",
    r"9\*谈骨气/吴晗 33",
    "课外古诗词诵读 159",
    "月夜忆舍弟/杜甫",          # 无页码的诗题行：靠「含 /」命中
    "写作 观点要明确 43",
]
CN_TOC_NEGATIVE = [
    "## 目录",
    "第二单元",
    "注：阅读单元的课文分“教读”和“自读”两类，篇名前标有*的为“自读”课文。",
    "仅供个人学习使用，未经授权不得另做他用",
]
CN_FURNITURE_POSITIVE = ["60 | 阅读 | 第三单元", "九年级 | 上册"]
CN_FURNITURE_NEGATIVE = [
    "庆历四年春，滕子京谪守巴陵郡。",
    "## 阅读提示",
    "1 沁园春·雪/毛泽东 3",
]


class TestChineseProfile:
    def setup_method(self):
        self.p = ChineseTextbookProfile()

    def test_toc_positive(self):
        for line in CN_TOC_POSITIVE:
            assert self.p.is_toc_line(line) is True, line

    def test_toc_negative(self):
        for line in CN_TOC_NEGATIVE:
            assert self.p.is_toc_line(line) is False, line

    def test_furniture(self):
        for line in CN_FURNITURE_POSITIVE:
            assert self.p.is_page_furniture(line) is True, line
        for line in CN_FURNITURE_NEGATIVE:
            assert self.p.is_page_furniture(line) is False, line

    def test_empty_and_blank_lines(self):
        assert self.p.is_toc_line("") is False
        assert self.p.is_toc_line("   ") is False

    def test_markdown_table_row_not_furniture(self):
        """markdown 表格行以 | 开头，不能被当成页眉残留误删。"""
        assert self.p.is_page_furniture("| 项目 | 数值 |") is False
        assert self.p.is_page_furniture("|---|---|") is False


class TestRegistry:
    def test_resolves_by_chinese_and_code(self):
        assert isinstance(get_profile("语文"), ChineseTextbookProfile)
        assert isinstance(get_profile("chinese"), ChineseTextbookProfile)
        assert isinstance(get_profile("数学"), MathTextbookProfile)
        assert isinstance(get_profile("math"), MathTextbookProfile)

    def test_unknown_falls_back_to_base(self):
        p = get_profile("物理")
        assert type(p) is TextbookProfile
        assert p.is_page_furniture("60 | 阅读 | 第三单元") is False   # 基类不猜

    def test_generic_alias_resolves_to_base(self):
        """英语显式登记为 generic：必须拿到基类而不是 KeyError。"""
        assert type(get_profile("英语")) is TextbookProfile
        assert type(get_profile("english")) is TextbookProfile

    def test_none_and_blank_fall_back_to_base(self):
        assert type(get_profile(None)) is TextbookProfile
        assert type(get_profile("")) is TextbookProfile

    def test_subject_is_stripped(self):
        assert isinstance(get_profile("  语文  "), ChineseTextbookProfile)

    def test_base_class_is_conservative(self):
        p = TextbookProfile()
        assert p.name == "generic"
        assert p.is_toc_line("26.1 反比例函数 2") is True    # 通用「行末页码」规则
        assert p.is_page_furniture("3 第二十一章 一元二次方程") is False


class TestProfileForMdPath:
    def test_chinese_path(self):
        p = profile_for_md_path(Path("语文/初中/统编版/九年级/上册/语文书/page_005.md"))
        assert isinstance(p, ChineseTextbookProfile)

    def test_math_path(self):
        p = profile_for_md_path(Path("数学/初中/人教版/九年级/上册/数学书/page_005.md"))
        assert isinstance(p, MathTextbookProfile)

    def test_absolute_path_still_resolves(self):
        p = profile_for_md_path(
            Path("/tmp/work/output/md/语文/初中/统编版/九年级/上册/语文书/page_005.md"))
        assert isinstance(p, ChineseTextbookProfile)

    def test_unknown_subject_falls_back_to_math(self):
        """兼容默认：推不出学科（含未注册学科）时回退数学档，保持既有调用方行为。"""
        assert isinstance(profile_for_md_path(Path("page_005.md")), MathTextbookProfile)
        assert isinstance(
            profile_for_md_path(Path("化学/初中/second/2024/海淀-试卷/page_001.md")),
            MathTextbookProfile)

    def test_generic_subject_falls_back_to_math(self):
        """英语只登记为 generic（无专属档案），路径推出 generic 时同样回退数学档。"""
        assert isinstance(
            profile_for_md_path(Path("英语/初中/人教版/七年级/上册/英语书/page_001.md")),
            MathTextbookProfile)


# ---------------------------------------------------------------------------
# 两个调用点的接线验证（hermetic：用真实目录页的逐字副本，不读被 gitignore 的 output/）
# ---------------------------------------------------------------------------

# 九上目录 page_004 的逐字副本（含「目录」锚点）
_CN_TOC_PAGE_004 = """## 人民教育出版社

## 目录

第一单元 活动·探究 1
任务一 学习鉴赏 2
1 沁园春·雪/毛泽东 3
2 周总理，你在哪里/柯岩 5
3 我爱这土地/艾青 8
4 乡愁/余光中 9
5 你是人间的四月天 ——一句爱的赞颂/林徽因 10
6 我看/穆旦 12
任务二 诗歌朗诵 14
任务三 尝试创作 18
第二单元
阅读 7 培养德智体美劳全面发展的社会主义建设者和接班人/习近平 22
8 中国人失掉自信力了吗/鲁迅 30
9\\*谈骨气/吴晗 33
10\\*创造宣言/陶行知 36
阅读综合实践 41
写作 观点要明确 43
"""

# page_005：第三单元（古诗文）+ 课外古诗词诵读，无「目录」标题，是续页
_CN_TOC_PAGE_005 = """## 人民教育出版社

专题学习活动
君子自强不息 46
第三单元
阅读 11 岳阳楼记/范仲淹 50
12 醉翁亭记/欧阳修 53
13\\* 湖心亭看雪/张岱 56
14 诗词三首 58
行路难(其一)/李白
酬乐天扬州初逢席上见赠/刘禹锡
水调歌头(明月几时有)/苏轼
阅读综合实践 61
写作 议论要言之有据 62
课外古诗词诵读 65
月夜忆舍弟/杜甫
长沙过贾谊宅/刘长卿
左迁至蓝关示侄孙湘/韩愈
商山早行/温庭筠
第四单元
阅读 15 故乡/鲁迅 68
16 我的叔叔于勒/莫泊桑 78
17\\* 孤独之旅/曹文轩 85
18\\* 蒲柳人家(节选)/刘绍棠 93
阅读综合实践 103
写作 学写小小说 105
"""

# page_007：目录末页，含书尾说明
_CN_TOC_PAGE_007 = """整本书阅读  
《唐诗三百首》 158  
课外古诗词诵读 159  
咸阳城东楼/许浑  
无题/李商隐  
浣溪沙（漠漠轻寒上小楼）/秦观  
丑奴儿·书博山道中壁/辛弃疾

注：阅读单元的课文分“教读”和“自读”两类，篇名前标有\\*的为“自读”课文。

仅供个人学习使用，未经授权不得另做他用
"""

_CN_BODY_PAGE_008 = """# 第一单元

## 1 沁园春·雪

北国风光，千里冰封，万里雪飘。望长城内外，惟余莽莽；大河上下，顿失滔滔。
山舞银蛇，原驰蜡象，欲与天公试比高。须晴日，看红装素裹，分外妖娆。
"""


class TestTocParseCliWiring:
    """toc_parse_cli 按 profile 判定目录页（重构前对语文只认出 page_004）。"""

    def _build_cn_book(self, tmp_path: Path) -> Path:
        book = tmp_path / "md" / "语文" / "初中" / "统编版" / "九年级" / "上册" / "语文书"
        book.mkdir(parents=True)
        (book / "page_004.md").write_text(_CN_TOC_PAGE_004, encoding="utf-8")
        (book / "page_005.md").write_text(_CN_TOC_PAGE_005, encoding="utf-8")
        (book / "page_006.md").write_text(_CN_TOC_PAGE_005, encoding="utf-8")
        (book / "page_007.md").write_text(_CN_TOC_PAGE_007, encoding="utf-8")
        (book / "page_008.md").write_text(_CN_BODY_PAGE_008, encoding="utf-8")
        return book

    def test_chinese_profile_collects_continuation_pages(self, tmp_path):
        from toc_parse_cli import _find_toc_pages
        book = self._build_cn_book(tmp_path)
        pages = _find_toc_pages(book, ChineseTextbookProfile())
        assert [p.name for p in pages] == [
            "page_004.md", "page_005.md", "page_006.md", "page_007.md"]

    def test_math_profile_would_stop_at_first_page(self, tmp_path):
        """对照：数学档看语文目录页 → 只有锚点页（这正是重构前的失效行为）。"""
        from toc_parse_cli import _find_toc_pages
        book = self._build_cn_book(tmp_path)
        pages = _find_toc_pages(book, MathTextbookProfile())
        assert [p.name for p in pages] == ["page_004.md"]

    def test_math_book_unaffected(self, tmp_path):
        from toc_parse_cli import _find_toc_pages
        book = tmp_path / "md" / "数学" / "初中" / "人教版" / "九年级" / "上册" / "数学书"
        book.mkdir(parents=True)
        (book / "page_004.md").write_text("# 前言", encoding="utf-8")
        (book / "page_005.md").write_text(
            "## 目录\n26.1 反比例函数 2\n小结 20\n", encoding="utf-8")
        (book / "page_006.md").write_text(
            "## 第二十八章 锐角三角函数\n28.1 锐角三角函数 61\n小结 83\n", encoding="utf-8")
        (book / "page_007.md").write_text(
            "# 第二十六章 反比例函数\n\n"
            "在本章中，我们将学习反比例函数的概念和性质。"
            "反比例函数是初中数学的重要内容之一。\n", encoding="utf-8")
        pages = _find_toc_pages(book, MathTextbookProfile())
        assert [p.name for p in pages] == ["page_005.md", "page_006.md"]

    def test_is_toc_like_page_needs_profile(self, tmp_path):
        from toc_parse_cli import _is_toc_like_page
        p = tmp_path / "page.md"
        p.write_text(_CN_TOC_PAGE_005, encoding="utf-8")
        assert _is_toc_like_page(p, ChineseTextbookProfile()) is True
        assert _is_toc_like_page(p, MathTextbookProfile()) is False


class TestCardSplitterWiring:
    """card_splitter 按 profile 剥离页眉/页脚残留。"""

    def test_chinese_furniture_dropped_from_bundles(self):
        from card_splitter import _make_bundles
        text = (
            "庆历四年春，滕子京谪守巴陵郡。\n\n"
            "60 | 阅读 | 第三单元\n\n"
            "越明年，政通人和，百废具兴。\n"
        )
        bundles = _make_bundles(text, [], ChineseTextbookProfile())
        joined = "\n".join(b.text for b in bundles)
        assert "60 | 阅读 | 第三单元" not in joined
        assert "庆历四年春，滕子京谪守巴陵郡。" in joined

    def test_math_furniture_still_dropped(self):
        from card_splitter import _make_bundles
        text = (
            "3 第二十一章 一元二次方程\n\n"
            "一元二次方程的一般形式是 ax²+bx+c=0。\n"
        )
        bundles = _make_bundles(text, [], MathTextbookProfile())
        joined = "\n".join(b.text for b in bundles)
        assert "3 第二十一章 一元二次方程" not in joined

    def test_math_page_number_header_not_dropped_for_chinese_profile(self):
        """数学残留形态在语文档下不剥——证明走的是 profile 而非全局放宽。"""
        from card_splitter import _make_bundles
        text = "3 第二十一章 一元二次方程\n\n一元二次方程的一般形式是 ax²+bx+c=0。\n"
        bundles = _make_bundles(text, [], ChineseTextbookProfile())
        joined = "\n".join(b.text for b in bundles)
        assert "3 第二十一章 一元二次方程" in joined

    def test_split_page_resolves_profile_from_md_path(self, tmp_path):
        """split_page 从 md_path 首段推学科：语文路径剥竖线页脚，数学路径不剥。"""
        from card_splitter import split_page
        text = "60 | 阅读 | 第三单元\n\n庆历四年春，滕子京谪守巴陵郡。\n"

        cn_md = tmp_path / "md" / "语文" / "初中" / "统编版" / "九年级" / "上册" / "书" / "page_067.md"
        cards_cn = split_page(cn_md, text, [])
        assert all("60 | 阅读 | 第三单元" not in c.content for c in cards_cn)

        math_md = tmp_path / "md" / "数学" / "初中" / "人教版" / "九年级" / "上册" / "书" / "page_067.md"
        cards_math = split_page(math_md, text, [])
        assert any("60 | 阅读 | 第三单元" in c.content for c in cards_math)
