"""interpretation_check 单测：入库前自检（纯函数）。

自检必须 **fail-closed**：切句拼不回正文、译文缺失、字词下标越界，这几类错误会直接把
学生的答题页弄坏，宁可整篇不入库等人工看，也不要半截数据静默生效。
"""

from interpretation_check import check_passage

BODY = "庆历四年春，滕子京谪守巴陵郡。越明年，政通人和。"
SENTENCES = ["庆历四年春，滕子京谪守巴陵郡。", "越明年，政通人和。"]
TRANSLATIONS = ["庆历四年的春天，滕子京被贬到巴陵郡做太守。", "到了第二年，政事顺利，百姓和乐。"]
TERMS = [{"term": "谪守", "gloss": "因罪贬谪流放，出任外官", "sentenceIndex": 0}]


def _check(**overrides):
    kwargs = dict(
        body=BODY,
        sentences=SENTENCES,
        translations=TRANSLATIONS,
        key_terms=TERMS,
        full_translation="庆历四年的春天……到了第二年……",
    )
    kwargs.update(overrides)
    return check_passage(**kwargs)


class TestHappyPath:
    def test_passes(self):
        r = _check()
        assert r.ok and r.errors == []

    def test_no_key_terms_is_warning_not_error(self):
        # 某篇可能一个重点字词都没有（用户没给），照样能练「逐句翻译」
        r = _check(key_terms=[])
        assert r.ok
        assert any("没有任何重点字词" in w for w in r.warnings)


class TestJoinInvariant:
    def test_join_mismatch_is_fatal(self):
        r = _check(sentences=["庆历四年春，滕子京谪守巴陵郡。"])   # 少了一句
        assert not r.ok
        assert any("拼不回正文" in e for e in r.errors)

    def test_zero_sentences_is_fatal(self):
        r = _check(sentences=[], translations=[])
        assert not r.ok
        assert any("句数为 0" in e for e in r.errors)

    def test_blank_sentence_is_fatal(self):
        r = _check(sentences=["庆历四年春，滕子京谪守巴陵郡。", "   "])
        assert not r.ok
        assert any("第 1 句为空" in e for e in r.errors)

    def test_empty_body_is_fatal_and_exits_early(self):
        r = _check(body="")
        assert not r.ok
        assert any("正文为空" in e for e in r.errors)


class TestKeyTerms:
    def test_empty_gloss_is_fatal(self):
        r = _check(key_terms=[{"term": "谪守", "gloss": "  ", "sentenceIndex": 0}])
        assert not r.ok
        assert any("解释为空" in e for e in r.errors)

    def test_empty_term_is_fatal(self):
        r = _check(key_terms=[{"term": "", "gloss": "g", "sentenceIndex": 0}])
        assert not r.ok
        assert any("term 为空" in e for e in r.errors)

    def test_index_out_of_range_is_fatal(self):
        r = _check(key_terms=[{"term": "谪守", "gloss": "g", "sentenceIndex": 99}])
        assert not r.ok
        assert any("越界" in e for e in r.errors)

    def test_non_integer_index_is_fatal(self):
        r = _check(key_terms=[{"term": "谪守", "gloss": "g", "sentenceIndex": "0"}])
        assert not r.ok
        assert any("不是整数" in e for e in r.errors)

    def test_bool_index_is_fatal(self):
        # Python 里 True 是 int 的子类，不加 isinstance(x, bool) 判断会漏掉
        r = _check(key_terms=[{"term": "谪守", "gloss": "g", "sentenceIndex": True}])
        assert not r.ok
        assert any("不是整数" in e for e in r.errors)

    def test_term_not_in_its_sentence_is_fatal(self):
        r = _check(key_terms=[{"term": "政通人和", "gloss": "g", "sentenceIndex": 0}])
        assert not r.ok
        assert any("不在它所归属" in e for e in r.errors)


class TestTranslations:
    def test_count_mismatch_is_fatal(self):
        r = _check(translations=["只有一句译文。"])
        assert not r.ok
        assert any("条数" in e for e in r.errors)

    def test_blank_translation_is_fatal(self):
        r = _check(translations=["第一句译文。", "  "])
        assert not r.ok
        assert any("第 1 句的译文为空" in e for e in r.errors)

    def test_blank_full_translation_is_fatal(self):
        r = _check(full_translation="  ")
        assert not r.ok
        assert any("全文译文为空" in e for e in r.errors)

    def test_translation_not_required_when_skipped(self):
        r = _check(translations=[], full_translation=None, require_translation=False)
        assert r.ok, r.errors
