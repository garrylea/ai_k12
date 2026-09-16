"""vocabulary_book / vocabulary_loader 单测：课本单词表 md → 词条的处理。

这个解析器已经踩过 6 轮坑（每轮都是「词条悄悄消失或释义被别的词吃掉」，靠肉眼看词表
很难发现），所以这里把每个 bug 的**最小复现行**钉成测试：

1. 行内粘连（MinerU 漏断行）—— 一条坏行会同时毁掉两条词条
2. 词头与释义断成两行 —— 不收下词头，释义就会挂到上一个词身上
3. 词性写法认不全（`aux v.` / `pl.` / `abbr.`）—— 词性残留在词形里，整条被丢
4. 多组词性/多读音各占一行 —— 必须并成一条，不能变成垃圾词条
5. `n. & v.` 切分残留 —— 不能产出「释义 = &」的空壳义项
6. 释义里混进音标/页码 —— 不是释义，学生看不懂
"""

import pathlib

import pytest

import vocabulary_book as vb
import vocabulary_loader as vl

# 词表小节的标题行（解析器只在它之后才开始收词条）
HEADING = "## Words and Expressions in Each Unit"


def parse(tmp_path: pathlib.Path, *lines: str) -> list[vb.Entry]:
    """把若干行写成 page_101.md 后跑一遍解析。"""
    (tmp_path / "page_101.md").write_text("\n".join(lines), encoding="utf-8")
    return list(vb.parse_entries(tmp_path, "测试书"))


def senses(tmp_path: pathlib.Path, *lines: str) -> list[dict]:
    """解析 + 拆义项（入库时的形状）。"""
    out: list[dict] = []
    for e in parse(tmp_path, *lines):
        out.extend(vl.split_senses(e.pos, e.gloss))
    return out


class TestSplitGlued:
    """一行里塞着两条词条 → 必须拆开。不拆的话**两条都坏**。"""

    def test_page_ref_then_letter(self):
        # `everyday … 日常的 p.64prepare /…/`：靠页码引用粘连
        got = vb.split_glued("everyday /'evrideɪ/ adj. 每天的；日常的 p.64prepare /prɪˈpeə(r)/")
        assert got == ["everyday /'evrideɪ/ adj. 每天的；日常的 p.64",
                       "prepare /prɪˈpeə(r)/"]

    def test_page_ref_then_phrase(self):
        # 词组没有音标，只能靠页码引用发现（`帽子 p.32have fun 玩得高兴`）
        got = vb.split_glued("hat /hæt/ n. 帽子 p.32have fun 玩得高兴")
        assert got == ["hat /hæt/ n. 帽子 p.32", "have fun 玩得高兴"]

    def test_space_separated(self):
        # `half … 半数 p.60 shop /ʃɒp/ n. 商店`
        got = vb.split_glued("half /hɑːf/ n. 一半；半 pron. 半数 p.60 shop /ʃɒp/ n. 商店")
        assert got == ["half /hɑːf/ n. 一半；半 pron. 半数 p.60", "shop /ʃɒp/ n. 商店"]

    def test_no_separator_at_all(self):
        # `bark /bɑːk/ n. 树皮certain /'sɜːtn/ adj. 某些`：连空格都没有
        got = vb.split_glued("bark /bɑːk/ n. 树皮certain /'sɜːtn/ adj. 某些；确定的")
        assert got == ["bark /bɑːk/ n. 树皮", "certain /'sɜːtn/ adj. 某些；确定的"]

    def test_phonetic_inside_parens_is_not_a_cut(self):
        # `(pl. media /'miːdiə/)` 是词条自带的注释，不是下一条词条
        line = "medium /'miːdiəm/ n. (pl. media /'miːdiə/)媒介;手段;方法"
        assert vb.split_glued(line) == [line]

    def test_second_pronunciation_is_not_a_cut(self):
        # `record /rɪˈkɔːd/ v. 记录 /'rekɔːd/ n. 记录` 是**同一条**的两个读音
        line = "record /rɪˈkɔːd/ v. 记录 /'rekɔːd/ n. 记录 p.54"
        assert vb.split_glued(line) == [line]

    def test_proper_noun_with_phonetic_in_middle(self):
        # 专名的音标可能夹在中间（`the Western Regions /…/ 西域`），切在 `Western` 前
        # 就只剩 `the`，名字整个丢掉（实测丢了 5 个人名地名）
        line = "the Western Regions /'riːdʒəns/ 西域 p.15"
        assert vb.split_glued(line) == [line]

    def test_two_names_in_one_line(self):
        # `Guglielmo /g/ Marconi /m/ 古列尔莫·马科尼` 是一个人，不是一个词条 + 一个词条
        line = "Guglielmo /'gʊjelməʊ/ Marconi /mɑː'kəʊni/ 古列尔莫·马科尼 p.44"
        assert vb.split_glued(line) == [line]


class TestNormalizeHead:
    """词条头 → (词形, 音标, 词性, 词尾大写字母)。"""

    def test_phonetic_and_pos(self):
        assert vb.normalize_head("mistake /mɪˈsteɪk/ n.")[:3] == ("mistake", "mɪˈsteɪk", ["n."])

    def test_aux_v_is_a_pos(self):
        # `aux v.` 认不出来 → 词形变成 `do aux`
        word, _, pos, _ = vb.normalize_head("do /duː; də/ aux v. & v.")
        assert word == "do"
        assert pos == ["aux v.", "v."]

    def test_pl_abbr_sing_are_pos(self):
        assert vb.normalize_head("grandchild /'græntʃaɪld/ n. (pl. grandchildren)")[0] == "grandchild"
        assert vb.normalize_head("TV /ˌtiː 'viː/ abbr.")[0] == "TV"
        assert vb.normalize_head("you /juː/ pron. sing.")[0] == "you"

    def test_ampersand_is_dropped(self):
        assert vb.normalize_head("both /bəʊθ/ adj. & pron.")[0] == "both"

    def test_phrase_keeps_spaces(self):
        assert vb.normalize_head("a lot of")[0] == "a lot of"

    def test_tail_capital_belongs_to_gloss(self):
        # 课本印 `T-shirt T恤衫`，切点落在 `恤` 前会把 `T` 留在词里
        word, _, _, tail = vb.normalize_head("T-shirt T")
        assert (word, tail) == ("T-shirt", "T")

    def test_paren_note_is_dropped(self):
        assert vb.normalize_head("would ('d) like to /wʊd/ modal v.")[0] == "would like to"

    def test_paren_alone_is_dropped(self):
        # `(at) first hand 第一手；亲自` —— `(at)` 是可选成分
        assert vb.normalize_head("(at) first hand")[0] == "first hand"

    def test_star_marker_is_dropped(self):
        # 课本用 △ 标「不要求掌握」；不剥掉整条过不了 WORD_RE
        assert vb.normalize_head("△ the Eiffel Tower /ˌaɪflˈtaʊə(r)/")[0] == "the Eiffel Tower"

    def test_leading_digit_is_kept(self):
        # `3D`：把 3 当符号剥掉会剩下一个单词 `d` 混进题库
        assert vb.normalize_head("3D /ˌθriː ˈdiː/ adj.")[0] == "3D"

    def test_unit_noise_prefix_is_dropped(self):
        assert vb.normalize_head("Unit 7 doll")[0] == "doll"


class TestParseEntries:
    def test_simple_entry(self, tmp_path):
        es = parse(tmp_path, HEADING, "mistake /mɪˈsteɪk/ n. 错误；失误 p.21")
        assert [(e.word, e.phonetic, e.pos, e.gloss) for e in es] == [
            ("mistake", "mɪˈsteɪk", "n.", "错误;失误")]   # NFKC 把全角；转成半角

    def test_head_only_then_continuation(self, tmp_path):
        # `orange /'ɒrɪndʒ/` 与它的释义分成两行：词头丢了 → 释义挂到上一个词身上
        es = parse(tmp_path, HEADING,
                   "excuse /ɪkˈskjuːs/ v. 原谅",
                   "orange /'ɒrɪndʒ/",
                   "adj. & n. 橙红色(的);橘黄色(的)")
        assert [e.word for e in es] == ["excuse", "orange"]
        assert es[0].gloss == "原谅"          # 没被 orange 的释义污染
        assert es[1].pos == "adj."

    def test_head_with_pos_but_no_cjk(self, tmp_path):
        # `across /ə'krɒs/ adv. & prep.`：剥完还剩词性，第一版判非法整条丢
        es = parse(tmp_path, HEADING,
                   "building /'bɪldɪŋ/ n. 建筑物",
                   "across /ə'krɒs/ adv. & prep.",
                   "在（……）对面；横过")
        assert [e.word for e in es] == ["building", "across"]
        assert es[0].gloss == "建筑物"
        assert es[1].gloss == "在(......)对面;横过"   # NFKC 归一化：（）→() ……→......

    def test_pos_only_line_is_never_a_head(self, tmp_path):
        # `v. (sped/sped/, sped; speeded, speeded)` 这种纯词性行不能收下 ——
        # 收下就会把下一行的中文吸成自己的释义，变成一条垃圾词条
        es = parse(tmp_path, HEADING,
                   "speed /spiːd/ n. 速度",
                   "v. (sped/sped/, sped; speeded, speeded)",
                   "加速；促进")
        assert [e.word for e in es] == ["speed"]
        assert es[0].gloss == "速度 v. (sped/sped/, sped; speeded, speeded) 加速;促进"

    def test_continuation_starting_with_phonetic(self, tmp_path):
        # `use /juːz/ v. 使用；利用` ⏎ `/juːs/ n. 使用;用途`：音标属于词头，不属于释义
        es = parse(tmp_path, HEADING,
                   "use /juːz/ v. 使用；利用 p.47",
                   "/juːs/ n. 使用;用途")
        assert es[0].gloss == "使用;利用 n. 使用;用途"

    def test_entry_without_gloss_is_dropped(self, tmp_path):
        # 书后「阅读书目」页的书名、练答案页的 `a price`、OCR 掉了释义的真词 —— 都不能进库
        es = parse(tmp_path, HEADING,
                   "doll /dɒl/ n. 玩偶",
                   "Oliver Twist",
                   "a price")
        assert [e.word for e in es] == ["doll"]

    def test_line_outside_wordlist_is_ignored(self, tmp_path):
        es = parse(tmp_path, HEADING, "doll /dɒl/ n. 玩偶", "## Unit 3", "## 语法聚焦",
                   "could /kʊd/ modal v. 能")
        assert [e.word for e in es] == ["doll"]

    def test_continuation_with_unclosed_paren(self, tmp_path):
        # `app /æp/ (= application /…/)` ⏎ `(application 的缩略形式)`：
        # ⚠️ `_norm` 走 NFKC 会把全角 `（` 变成半角 `(`，所以「以全角左括号开头算续行」
        # 这条规则**永远不可能命中**；靠 GLOSS_START_RE 漏到了词条路径上，
        # 于是 `application` 被当成了词形、释义变成 `的缩略形式)`。
        es = parse(tmp_path, HEADING,
                   "app /æp/ (= application /ˌæplɪˈkeɪʃn/)",
                   "n. 应用程序",
                   "(application 的缩略形式)")
        assert [e.word for e in es] == ["app"]
        assert es[0].gloss == "n. 应用程序 (application 的缩略形式)"

    def test_line_with_closed_paren_is_still_an_entry(self, tmp_path):
        # 反例：`(at) first hand 第一手；亲自` 是完整词条，括号是闭合的
        es = parse(tmp_path, HEADING, "(at) first hand 第一手；亲自")
        assert [e.word for e in es] == ["first hand"]

    def test_ipa_variant_annotation_is_not_suspicious(self, tmp_path):
        # 高中课本的音标带 `; NAmE …` 变体标注，`NAmE` 是英文词但不该报警
        es = parse(tmp_path, HEADING, "clerk /klɑːk; NAmE klɜːrk/ n. 职员")
        assert es[0].flags == []

    def test_note_line_is_not_a_gloss(self, tmp_path):
        # 词表里反复出现的编辑说明以中文开头，会被「中文开头 = 释义折行」吃进去，
        # 挂到上一行的词上（Clark/Jones/Philippines 的释义尾部都拖过这条）
        note = "注：依据《义务教育英语课程标准（2022年版）》，本词表中的重点词汇用粗体显示。"
        es = parse(tmp_path, HEADING, "Clark /klɑːk/ 克拉克 p.72", note)
        assert [e.word for e in es] == ["Clark"]
        assert es[0].gloss == "克拉克"

    def test_missing_wordlist_heading_raises(self, tmp_path):
        (tmp_path / "page_101.md").write_text("doll /dɒl/ n. 玩偶", encoding="utf-8")
        with pytest.raises(RuntimeError, match="没找到单词表小节标题"):
            list(vb.parse_entries(tmp_path, "测试书"))


class TestSplitSenses:
    def test_two_senses(self):
        got = vl.split_senses("v.", "听起来;好像 n. 声音;响声")
        assert got == [{"pos": "v.", "extended": False, "gloss": "听起来;好像"},
                       {"pos": "n.", "extended": False, "gloss": "声音;响声"}]

    def test_leading_pos_inside_gloss(self):
        assert vl.split_senses("n.", "n. 信息；消息") == [
            {"pos": "n.", "extended": False, "gloss": "信息；消息"}]

    def test_connector_atom_shares_next_gloss(self):
        # `n. & v. 运动;锻炼;练习` → 两个词性共用释义，不能产出「释义 = &」的空壳义项
        got = vl.split_senses("n.", "& v. 运动;锻炼;练习")
        assert got == [{"pos": "n.", "extended": False, "gloss": "运动;锻炼;练习"},
                       {"pos": "v.", "extended": False, "gloss": "运动;锻炼;练习"}]

    def test_trailing_connector_atom_is_dropped(self):
        assert vl.split_senses("vi.", "用球板击球 vt. &") == [
            {"pos": "vi.", "extended": False, "gloss": "用球板击球"}]

    def test_punctuation_atom_shares_next_gloss(self):
        # `受欢迎的 interj., v. & n. 欢迎` → `,` 和 `&` 都是残留
        got = vl.split_senses("adj.", "受欢迎的 interj., v. & n. 欢迎")
        assert [s["gloss"] for s in got] == ["受欢迎的", "欢迎", "欢迎", "欢迎"]

    def test_bare_phonetic_is_stripped(self):
        # 括号外的音标是解析残留；括号内的要留（它是词条自带的注释）
        assert vl.split_senses("v.", "使用;利用 /juːs/")[0]["gloss"] == "使用;利用"
        assert vl.split_senses("n.", "(pl. media /'miːdiə/)媒介")[0]["gloss"] == \
            "(pl. media /'miːdiə/)媒介"

    def test_gloss_without_cjk_is_dropped(self):
        # `(= organization)` 这类只有拼写注解、没有意思的义项不能留给学生
        assert vl.split_senses("", "(= organisation)") == []
        assert vl.split_senses("n.", "组织;机构 (= organisation)") == [
            {"pos": "n.", "extended": False, "gloss": "组织;机构 (= organisation)"}]


class TestCaseFold:
    def test_lowercased(self):
        assert vl.normalize_case("China") == "china"

    @pytest.mark.parametrize("word", ["I", "UK", "Mr", "T-shirt", "X-ray", "OK"])
    def test_orthographic_exceptions_keep_case(self, word):
        assert vl.normalize_case(word) == word


class TestLevel:
    @pytest.mark.parametrize(("dirname", "level"), [
        ("初中__人教版__七年级__下册", "junior"),
        ("高中__人教版__高中年级__必修 第一册", "senior_required"),
        ("高中__人教版__高中年级__选择性必修 第二册", "senior_elective"),
    ])
    def test_level_from_directory(self, dirname, level):
        assert vl.level_of(dirname) == level

    def test_junior_comes_before_senior(self):
        # 去重时保留「先初中后高中、册次从低到高」的首次出现
        assert vl.grade_order("初中__人教版__九年级__下册") < \
            vl.grade_order("高中__人教版__高中年级__必修 第一册")
        assert vl.grade_order("初中__人教版__七年级__上册") < \
            vl.grade_order("初中__人教版__八年级__上册")
