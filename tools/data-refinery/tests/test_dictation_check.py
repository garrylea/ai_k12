from dictation_check import CheckResult, check_body

WEN = "庆历四年春，滕子京谪守巴陵郡。越明年，政通人和，百废具兴。乃重修岳阳楼，增其旧制，刻唐贤今人诗赋于其上。属予作文以记之。"


class TestErrors:
    def test_clean_body_passes(self):
        r = check_body(WEN, "岳阳楼记", "wen", set())
        assert isinstance(r, CheckResult)
        assert r.errors == []

    def test_empty_body_is_error(self):
        assert "正文为空" in check_body("", "岳阳楼记", "wen", set()).errors

    def test_too_short_is_error(self):
        r = check_body("庆历四年春。", "岳阳楼记", "wen", set())
        assert any("过短" in e for e in r.errors)

    def test_annotation_marker_is_error(self):
        r = check_body(WEN + "注释〔1〕选自《范仲淹全集》。", "岳阳楼记", "wen", set())
        assert any("注释" in e for e in r.errors)

    def test_chrome_residue_is_error(self):
        r = check_body(WEN + "人民教育出版社", "岳阳楼记", "wen", {"人民教育出版社"})
        assert any("页眉" in e for e in r.errors)

    def test_latex_marker_residue_is_error(self):
        # 实测新增：角标没删净（normalize_body 漏删）会在正文留下 $
        r = check_body(WEN + " $^{②}$", "岳阳楼记", "wen", set())
        assert any("$" in e for e in r.errors)

    def test_pipe_furniture_residue_is_error(self):
        # 实测新增：页码页脚「60 | 阅读 | 第三单元」混进正文
        r = check_body(WEN + "60 | 阅读 | 第三单元", "岳阳楼记", "wen", set())
        assert any("竖线" in e for e in r.errors)

    def test_markdown_image_residue_is_error(self):
        # 实测新增：page_061 的图片行会落进正文区间（版面元素混入）
        r = check_body(WEN + "![](images/a9ee.jpg)", "岳阳楼记", "wen", set())
        assert any("图片" in e for e in r.errors)

    def test_unbalanced_bracket_is_error(self):
        # 实测新增：醉翁亭记的注释 ⑤ 起始行在 OCR 里丢失，只剩续行带一个落单的 ），
        # 浅切按设计抓不到它 —— 靠括号配平兜住（进人工复核，不静默）
        r = check_body(WEN + "起）像鸟张开翅膀一样，高踞于泉水之上。", "醉翁亭记", "wen", set())
        assert any("不配平" in e for e in r.errors)

    def test_balanced_brackets_are_fine(self):
        # 正文里有成对括号（如注音）不得误报
        r = check_body(WEN + "（其一）", "岳阳楼记", "wen", set())
        assert not any("不配平" in e for e in r.errors)


class TestReviewFlags:
    def test_rare_char_flagged_for_review(self):
        # U+3400 属 CJK 扩展 A 区（基本区 U+4E00–U+9FFF 之外），是最可能被 OCR 认错的一类
        r = check_body(WEN + "\u3400", "岳阳楼记", "wen", set())
        assert r.needs_review is True
        assert any("生僻" in x or "低频" in x for x in r.review_reasons)
        # 钉住档位边界：可疑生僻字只提复核优先级，**不**判错（否则会误杀正常篇目）
        assert r.errors == []

    def test_regulated_shi_length_mismatch_flagged(self):
        # 声明为诗、但字数不是五/七言绝句或律诗的常见字数 → 提示复核（不判错）
        r = check_body("床前明月光疑是地上霜举头望明月低头思故乡啊", "静夜思", "shi", set())
        assert r.needs_review is True
        assert r.errors == []

    def test_common_body_not_flagged(self):
        r = check_body(WEN, "岳阳楼记", "wen", set())
        assert r.needs_review is False

    def test_title_at_body_start_flags_review_not_error(self):
        r = check_body("岳阳楼记" + WEN, "岳阳楼记", "wen", set())
        assert r.errors == [], r.errors
        assert r.needs_review is True
        assert any("篇名" in x for x in r.review_reasons)

    def test_title_mid_body_is_not_flagged(self):
        body = "崇祯五年十二月，余住西湖。大雪三日，独往湖心亭看雪。莫说相公痴，更有痴似相公者。"
        r = check_body(body, "湖心亭看雪", "wen", set())
        assert r.errors == [] and r.needs_review is False

    def test_poem_whose_first_line_is_its_title(self):
        body = ("十五从军征，八十始得归。道逢乡里人：家中有阿谁？遥看是君家，松柏冢累累。"
                "兔从狗窦入，雉从梁上飞。中庭生旅谷，井上生旅葵。舂谷持作饭，采葵持作羹。"
                "羹饭一时熟，不知贻阿谁。出门东向看，泪落沾我衣。")
        r = check_body(body, "十五从军征", "shi", set())
        assert r.errors == [], r.errors
