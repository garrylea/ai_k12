"""dictation_locate 单测：**纯程序定位**，不涉及网络与 LLM。

夹具尽量照抄实测的真实版面（九上），因为本模块的每条规则都是被真实数据逼出来的：
导语有 `◎` 条目版与「阅读提示」版两种、作者可能与篇名同行、词整首写一行、
正文后跟编者白话赏析、以及「正文行带角标且很短」这个曾把《十五从军征》切成 12 字的坑。
"""

import pytest

from dictation_locate import (
    PROSE_LINE_MIN,
    REGULATED_SHI_LENS,
    _find_body_end,
    _find_body_start,
    _title_line_index,
    ci_pattern_of,
    find_anchor_page,
    find_anchor_pages,
    locate_body,
    norm_title,
    trim_to_form,
)

# —— 真实版面片段（照抄九上实测）——

#: 《醉翁亭记》首页：标题 → 作者 → `## 预习` + **两条** ◎ 提示 → 正文
PAGE_ZUIWENG = """# 12 醉翁亭记 $^{①}$

欧阳修

## 预习

◎ 庆历五年（1045），欧阳修被贬为滁州知州。到任以后，他寄情山水，与民同乐。本文就写于这一时期。

◎ 读课文时，注意文中“者”“也”“而”“之”等虚词的使用。

环滁 $^{②}$ 皆山也。其西南诸峰，林壑尤美。"""

#: 《湖心亭看雪》首页：「阅读提示」体例（没有 ◎，一段白话）
PAGE_HUXINTING = """# 13 湖心亭看雪 $^{①}$

张岱

## 阅读提示

大雪净化了天地，冻结了人声鸟语，也激发了作者游览西湖的雅兴。边读边思考：这是一番怎样的情景？

崇祯五年 $^{②}$ 十二月，余住西湖。"""

#: 《十五从军征》：正文行**带角标且很短**，曾被误判成「下一篇标题行」
PAGE_SHICONGJUN = """## 十五从军征 $^{①}$

十五从军征，八十始得归。
道逢乡里人，家中有阿 $^{②}$ 谁？
遥看是君家，松柏冢 $^{③}$ 累累 $^{④}$ 。
出门东向看，泪落沾我衣。"""

#: 《沁园春·雪》首页：题解日期 + 上半阙 + 作者 + **编者写作背景** + 下半阙开头
PAGE_QINYUAN = """## 1 沁园春·雪 $^{①}$

(一九三六年二月)

北国 $^{②}$ 风光，
千里冰封，
万里雪飘。

毛泽东

1936年2月，毛主席率领红一方面军从陕北出发，准备东渡黄河，进入山西西部。

江山如此多娇，
引无数英雄竞折腰 $^{⑩}$ 。"""


class TestNormTitle:
    def test_strips_whitespace(self):
        assert norm_title("南乡子 · 登京口北固亭有怀") == "南乡子·登京口北固亭有怀"

    def test_unifies_parens(self):
        assert norm_title("行路难（其一）") == norm_title("行路难(其一)")


class TestCiPattern:
    def test_known_ci_with_subtitle(self):
        assert ci_pattern_of("水调歌头(明月几时有)") == 95

    def test_dot_title_uses_base(self):
        # 沁园春·雪 的副题用 `·` 分隔，取词牌「沁园春」
        assert ci_pattern_of("沁园春·雪") == 114

    def test_unknown_returns_none(self):
        assert ci_pattern_of("岳阳楼记") is None


class TestTitleLineIndex:
    def test_markdown_heading_with_marker(self):
        lines = PAGE_ZUIWENG.splitlines()
        assert _title_line_index(lines, "醉翁亭记") == 0

    def test_author_on_same_line_via_marker_split(self):
        # `月夜忆舍弟 $^{①}$ 杜甫`：角标前是篇名、后是作者
        lines = ["月夜忆舍弟 $^{①}$ 杜甫", "", "戍鼓断人行，边秋一雁声。"]
        assert _title_line_index(lines, "月夜忆舍弟") == 0

    def test_subtitle_in_label_only_wumelody_in_page(self):
        # 目录 `水调歌头(明月几时有)` ↔ 正文只写 `水调歌头`
        lines = ["## 水调歌头 $^{①}$", "", "苏轼", "", "明月几时有？"]
        assert _title_line_index(lines, "水调歌头(明月几时有)") == 0

    def test_sha_huan_xi_paren_subtitle(self):
        lines = ["## 浣溪沙 $^{①}$ 秦观", "", "漠漠轻寒上小楼，"]
        assert _title_line_index(lines, "浣溪沙（漠漠轻寒上小楼）") == 0

    def test_body_line_is_not_a_title(self):
        lines = ["戍鼓 $^{②}$ 断人行 $^{③}$ ，边秋一雁声。", "露从今夜白 $^{④}$ ，月是故乡明。"]
        assert _title_line_index(lines, "月夜忆舍弟") is None

    def test_missing_returns_none(self):
        assert _title_line_index(["甲", "乙"], "岳阳楼记") is None


class TestFindAnchorPage:
    #: 按**页序**排列（真实调用方也是按页序传入）
    PAGES = [(6, "目录\n11 岳阳楼记/范仲淹 50\n1 沁园春·雪/毛泽东 3"),
             (57, "## 11 岳阳楼记 $^{①}$\n庆历四年春。"),
             (60, "# 12 醉翁亭记 $^{①}$\n环滁皆山也。")]

    def test_directory_line_is_not_a_title_hit(self):
        # 归一 + 去副题后要求**全等或前缀**，目录行 `11 岳阳楼记/范仲淹 50`
        # 带上作者与页码后既不全等也不是篇名前缀 → 不再命中。
        # 这是从源头消掉「锚点被定到目录页」的关键（曾需靠偏移众数兜）。
        assert find_anchor_pages("岳阳楼记", self.PAGES) == [57]

    def test_prefers_hit_near_printed_plus_offset(self):
        assert find_anchor_page("岳阳楼记", 50, self.PAGES, 7) == 57

    def test_without_offset_picks_nearest_to_printed(self):
        assert find_anchor_page("岳阳楼记", 50, self.PAGES, None) == 57

    def test_without_printed_falls_back_to_first_hit(self):
        # 页序在前者胜出（真实场景下同篇名重复出现时取最先的正文页）
        pages = [(30, "## 11 岳阳楼记 $^{①}$\n庆历四年春。"), (90, "## 11 岳阳楼记 $^{①}$\n越明年。")]
        assert find_anchor_page("岳阳楼记", None, pages, None) == 30

    def test_missing_piece_returns_none(self):
        assert find_anchor_page("不存在的篇", 1, self.PAGES, 7) is None


class TestFindBodyStart:
    def test_skips_multiple_guide_items(self):
        # `## 预习` 后有**两条** ◎ 提示；只跳一条会把第二条当正文（实测出师表/醉翁亭记）
        lines = PAGE_ZUIWENG.splitlines()
        start, notes = _find_body_start(lines, 0)
        assert lines[start].startswith("环滁")
        assert any("编者导语" in n for n in notes)

    def test_skips_reading_hint_paragraph(self):
        lines = PAGE_HUXINTING.splitlines()
        start, _ = _find_body_start(lines, 0)
        assert lines[start].startswith("崇祯五年")

    def test_skips_date_paren_line(self):
        lines = PAGE_QINYUAN.splitlines()
        start, notes = _find_body_start(lines, 0)
        assert lines[start].startswith("北国")
        assert any("题解日期" in n for n in notes)

    def test_skips_author_and_image(self):
        lines = ["# 11 岳阳楼记 $^{①}$", "", "范仲淹", "",
                 "![](images/x.jpg)", "", "庆历四年春，滕子京谪守巴陵郡。"]
        start, notes = _find_body_start(lines, 0)
        assert lines[start].startswith("庆历四年春")
        assert any("作者行" in n for n in notes) and any("图片行" in n for n in notes)


class TestFindBodyEnd:
    def test_terminates_at_section_heading(self):
        lines = ["环滁皆山也。", "", "## 思考·探究·积累", "一 朗读并背诵课文。"]
        body, notes = _find_body_end(lines, 0, frozenset())
        assert body == ["环滁皆山也。"]
        assert any("编者栏目" in n for n in notes)

    def test_terminates_at_next_known_title(self):
        lines = ["戍鼓断人行，边秋一雁声。", "", "## 长沙过贾谊宅 $^{⑥}$ 刘长卿", "三年谪宦此栖迟。"]
        body, notes = _find_body_end(lines, 0, frozenset({"长沙过贾谊宅"}))
        assert body == ["戍鼓断人行，边秋一雁声。"]
        assert any("下一篇标题行" in n for n in notes)

    def test_does_not_terminate_on_short_verse_line_with_marker(self):
        # 回归：曾用「带角标且 ≤12 字」当标题判据，把「道逢乡里人，家中有阿 $^{②}$ 谁？」
        # 误判成标题行，《十五从军征》只切出前两句 12 字
        lines = PAGE_SHICONGJUN.splitlines()
        start, _ = _find_body_start(lines, 0)
        body, _ = _find_body_end(lines, start, frozenset())
        assert len(body) == 4

    def test_skips_image_and_caption_rows(self):
        lines = ["辛苦遭逢起一经，干戈寥落四周星。", "![](images/x.jpg)",
                 "《过零丁洋》(局部)毛泽东手书", "山河破碎风飘絮。"]
        body, notes = _find_body_end(lines, 0, frozenset())
        assert body == ["辛苦遭逢起一经，干戈寥落四周星。", "山河破碎风飘絮。"]
        assert any("图片/图注" in n for n in notes)

    def test_terminates_at_annotation_line(self):
        lines = ["庆历四年春。", "① 选自《全唐诗》。"]
        body, notes = _find_body_end(lines, 0, frozenset())
        assert body == ["庆历四年春。"]
        assert any("注释式行" in n for n in notes)


class TestTrimToForm:
    def test_ci_drops_leading_preface(self):
        # 《水调歌头》：小序一行 + 词一行；词牌 95 字 → 只留词
        xiaoxu = "丙辰中秋，欢饮达旦，大醉，作此篇，兼怀子由。"
        ci = "明" * 95
        body, notes = trim_to_form(f"{xiaoxu}\n{ci}", "水调歌头(明月几时有)", "ci")
        assert body == ci
        assert any("词前小序" in n for n in notes)

    def test_ci_drops_trailing_commentary(self):
        ci = "少" * 44
        body, notes = trim_to_form(f"{ci}\n" + "编" * 119, "丑奴儿·书博山道中壁", "ci")
        assert body == ci
        assert any("词后编者赏析" in n for n in notes)

    def test_ci_untouched_when_no_run_matches(self):
        # 《沁园春·雪》：正文被课后题逐行插花，没有长度恰好的连续行段 → 原样返回
        messy = "\n".join(["北国风光，", "毛泽东", "1936年2月，编者写作背景说明" * 3, "江山如此多娇，"])
        body, notes = trim_to_form(messy, "沁园春·雪", "ci")
        assert body == messy and notes == []

    def test_shi_drops_trailing_prose(self):
        verse = "\n".join(["戍鼓断人行，边秋一雁声。", "露从今夜白，月是故乡明。",
                           "有弟皆分散，无家问死生。", "寄书长不达，况乃未休兵。"])
        commentary = "战" * PROSE_LINE_MIN
        body, notes = trim_to_form(f"{verse}\n{commentary}", "月夜忆舍弟", "shi")
        assert body == verse
        assert any("编者赏析" in n for n in notes)

    def test_shi_untouched_when_last_line_is_verse(self):
        # 古体/乐府（十五从军征）尾部是诗句，不是白话 → 不切
        verse = "\n".join(["十五从军征，八十始得归。", "道逢乡里人，家中有阿谁？"])
        body, notes = trim_to_form(verse, "十五从军征", "shi")
        assert body == verse and notes == []

    def test_shi_untouched_for_wen_style_long_lines(self):
        # 文言文整段长行（中位数 > 20）→ 不敢动，交给自检
        para = "庆历四年春，" * 8
        body, notes = trim_to_form(f"{para}\n{para}", "岳阳楼记", "shi")
        assert body == f"{para}\n{para}" and notes == []

    def test_shi_untouched_when_remainder_not_regulated(self):
        # 去掉尾部白话后剩余字数不在近体诗常见值里 → 宁可不动
        odd = "\n".join(["甲" * 13, "乙" * 13])
        body, notes = trim_to_form(f"{odd}\n" + "白" * PROSE_LINE_MIN, "某诗", "shi")
        assert body == f"{odd}\n" + "白" * PROSE_LINE_MIN and notes == []

    def test_empty_body_is_safe(self):
        assert trim_to_form("", "岳阳楼记", "wen") == ("", [])


class TestLocateBody:
    PAGES = [
        (60, PAGE_ZUIWENG),
        (63, PAGE_HUXINTING),
        (157, PAGE_SHICONGJUN),
    ]

    def test_cuts_body_via_anchor_and_trim(self):
        r = locate_body("醉翁亭记", 53, self.PAGES, 7, None, frozenset())
        assert r is not None
        assert r.body.startswith("环滁")
        assert r.start_page == 60

    def test_returns_none_when_title_absent(self):
        assert locate_body("不存在的篇", 1, self.PAGES, 7, None, frozenset()) is None

    def test_window_stops_at_next_anchor(self):
        # 湖心亭看雪锚点 63，下一篇锚点 157 → 窗口不越界
        r = locate_body("湖心亭看雪", 56, self.PAGES, 7, 157, frozenset())
        assert r is not None and r.end_page <= 157


@pytest.mark.parametrize("length", sorted(REGULATED_SHI_LENS))
def test_regulated_lens_are_the_expected_set(length):
    assert length in {20, 28, 40, 56}
