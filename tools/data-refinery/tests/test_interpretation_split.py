"""interpretation_split 单测：切句与字词归属（纯函数）。

`''.join(sentences) == body` 这条不变式是全专项的地基——学生逐句答完就等于把整篇译了一遍，
切句漂移了没人发现才是灾难。所以这里对边界（空正文/无句末标点/句末标点后有残句/
标点归属）逐条钉住。
"""

from interpretation_input import InputKeyTerm
from interpretation_split import attribute_terms, join_sentences, split_sentences, term_plain


class TestSplitSentences:
    def test_basic(self):
        assert split_sentences("庆历四年春，滕子京谪守巴陵郡。越明年，政通人和。") == [
            "庆历四年春，滕子京谪守巴陵郡。",
            "越明年，政通人和。",
        ]

    def test_comma_is_not_a_boundary(self):
        # 逗号/顿号/冒号都不该断句，否则三行对译会碎成词组
        assert split_sentences("床前明月光，疑是地上霜。") == ["床前明月光，疑是地上霜。"]

    def test_all_four_end_marks(self):
        assert split_sentences("甲。乙！丙？丁；") == ["甲。", "乙！", "丙？", "丁；"]

    def test_punctuation_stays_at_sentence_end(self):
        sents = split_sentences("越明年，政通人和，百废具兴。")
        assert sents[0].endswith("。")
        assert not sents[0].endswith("，")

    def test_trailing_fragment_without_end_mark(self):
        assert split_sentences("甲。乙") == ["甲。", "乙"]

    def test_single_sentence_no_end_mark(self):
        assert split_sentences("床前明月光") == ["床前明月光"]

    def test_empty_body(self):
        assert split_sentences("") == []

    def test_join_invariant_holds_on_samples(self):
        bodies = [
            "庆历四年春，滕子京谪守巴陵郡。越明年，政通人和，百废具兴。",
            "床前明月光，疑是地上霜。举头望明月，低头思故乡。",
            "甲。乙！丙？丁；戊",           # 末尾无句末标点
            "无标点的整段",                 # 单句
            "。",                          # 只有一个标点
        ]
        for body in bodies:
            assert join_sentences(split_sentences(body)) == body, body


class TestAttributeTerms:
    SENTENCES = [
        "庆历四年春，滕子京谪守巴陵郡。",
        "越明年，政通人和，百废具兴。",
    ]

    def test_term_goes_to_the_sentence_containing_it(self):
        res = attribute_terms(self.SENTENCES, [
            InputKeyTerm(term="谪守", gloss="g1"),
            InputKeyTerm(term="政通人和", gloss="g2"),
        ])
        assert [(t["term"], t["sentenceIndex"]) for t in res.key_terms] == [
            ("谪守", 0), ("政通人和", 1),
        ]
        assert res.dropped_terms == []

    def test_term_appearing_in_multiple_sentences_takes_first(self):
        res = attribute_terms(["甲乙丙。", "甲乙。"], [InputKeyTerm(term="甲乙", gloss="g")])
        assert res.key_terms[0]["sentenceIndex"] == 0

    def test_unlocatable_term_dropped_not_kept(self):
        # 找不到就丢弃 + 记进 dropped（用户 2026-09-16 裁决）：
        # 挂不到句子，答题页没有落点，留下只会变成看不见的死数据
        res = attribute_terms(self.SENTENCES, [
            InputKeyTerm(term="谪守", gloss="g1"),
            InputKeyTerm(term="岳阳楼记", gloss="标题里的词"),
        ])
        assert [t["term"] for t in res.key_terms] == ["谪守"]
        assert res.dropped_terms == ["岳阳楼记"]

    def test_all_terms_dropped(self):
        res = attribute_terms(self.SENTENCES, [InputKeyTerm(term="不存在的词", gloss="g")])
        assert res.key_terms == []
        assert res.dropped_terms == ["不存在的词"]

    def test_carries_src_and_gloss(self):
        res = attribute_terms(self.SENTENCES, [InputKeyTerm(term="谪守", gloss="因罪贬谪流放")])
        assert res.key_terms[0] == {
            "term": "谪守", "gloss": "因罪贬谪流放", "src": "user", "sentenceIndex": 0,
        }

    def test_no_terms(self):
        assert attribute_terms(self.SENTENCES, []).key_terms == []


class TestPlainAndPinyin:
    """注音：**词保留拼音**（学生要看得见读音），只在**定位**时用去注音形式。

    用户 2026-09-16 裁决。若不这么做，《岳阳楼记》《陈涉世家》这类带注音的词
    （实测一个文件 100+ 条）会 100% 定位失败被丢弃。
    """

    SENTENCES = [
        "庆历四年春，滕子京谪守巴陵郡。",
        "越明年，政通人和，百废具兴。",
    ]

    def test_plain_strips_pinyin_parens(self):
        assert term_plain('滕子京谪（zhé）守巴陵郡') == '滕子京谪守巴陵郡'
        assert term_plain('妖娆（ráo）') == '妖娆'
        assert term_plain('雾凇（sōng）沆砀（hàng dàng）') == '雾凇沆砀'
        assert term_plain('蔚然(láng yá)深秀') == '蔚然深秀'

    def test_plain_keeps_real_parens(self):
        # 剥了就找不到了——这些括号是词的一部分
        assert term_plain('行路难（其一）') == '行路难（其一）'
        assert term_plain('秦皇汉武（前259—前210）') == '秦皇汉武（前259—前210）'

    def test_term_keeps_pinyin_but_located_by_plain(self):
        res = attribute_terms(self.SENTENCES, [
            InputKeyTerm(term='滕子京谪（zhé）守巴陵郡', gloss='g'),
        ])
        assert [t['term'] for t in res.key_terms] == ['滕子京谪（zhé）守巴陵郡']  # 原样入库
        assert res.key_terms[0]['sentenceIndex'] == 0
        assert res.dropped_terms == []

    def test_pinyin_term_would_fail_without_plain(self):
        # 回归钉子：带注音的词在正文里 `in` 不成立，必须靠 plain 找到
        res = attribute_terms(self.SENTENCES, [InputKeyTerm(term='谪（zhé）守', gloss='g')])
        assert res.dropped_terms == []
        assert res.key_terms[0]['sentenceIndex'] == 0

    def test_falls_back_to_raw_term_when_plain_not_found(self):
        # 万一注音其实是词的一部分（剥了反而找不到），再拿原样试一次
        res = attribute_terms(['甲乙（yǐ）丙。'], [InputKeyTerm(term='乙（yǐ）丙', gloss='g')])
        assert res.key_terms[0]['sentenceIndex'] == 0

    def test_duplicate_after_stripping_reported(self):
        res = attribute_terms(self.SENTENCES, [
            InputKeyTerm(term='谪（zhé）守', gloss='g1'),
            InputKeyTerm(term='谪守', gloss='g2'),
        ])
        # 归属层不去重（去重在解析层按 term 归一），两条都能挂上
        assert len(res.key_terms) == 2
