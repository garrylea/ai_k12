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

    def test_title_inside_body_is_error(self):
        r = check_body("岳阳楼记" + WEN, "岳阳楼记", "wen", set())
        assert any("篇名" in e for e in r.errors)

    def test_title_mid_body_is_not_error(self):
        # 实测回归：《湖心亭看雪》正文里本来就含篇名（末段「独往湖心亭看雪」），
        # 只做 substring 判断会误杀一篇完全正确的正文。只有正文**开头**出现篇名才算切多了。
        body = "崇祯五年十二月，余住西湖。大雪三日，独往湖心亭看雪。莫说相公痴，更有痴似相公者。"
        r = check_body(body, "湖心亭看雪", "wen", set())
        assert r.errors == [], r.errors

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
