"""interpretation_input 单测：输入解析（JSON/JSONL/Markdown + 别名归一 + 清洗 + 去重）。

纯函数、不碰网络与数据库。核心钉住三件事：
- **别名归一**：中英文字段名混用都能读（用户手写 Markdown / 程序导 JSON 各按习惯来）；
- **行容错**：行首编号、词带括号、各种分隔符都认（用户举的 `1 则:那么` 必须认）；
- **不静默吞**：丢弃任何东西都要产生告警。
"""

from interpretation_input import (
    load_input,
    parse_json,
    parse_markdown,
    dedupe_passages,
    _split_term_line,
)


class TestJsonFormats:
    def test_jsonl_one_per_line(self):
        text = (
            '{"work_title":"岳阳楼记","semester":"上册","key_terms":[{"term":"谪守","gloss":"因罪贬谪流放"}]}\n'
            '{"work_title":"醉翁亭记","semester":"上册","key_terms":[{"term":"环","gloss":"环绕"}]}\n'
        )
        res = parse_json(text)
        assert [p.work_title for p in res.passages] == ["岳阳楼记", "醉翁亭记"]
        assert res.passages[0].semester == "上册"
        assert res.passages[0].key_terms[0].term == "谪守"

    def test_json_array(self):
        text = '[{"work_title":"岳阳楼记","key_terms":[{"term":"谪守","gloss":"g"}]}]'
        res = parse_json(text)
        assert len(res.passages) == 1
        assert res.passages[0].semester is None

    def test_blank_lines_and_garbage_line(self):
        text = '\n{"work_title":"岳阳楼记"}\n不是JSON\n'
        res = parse_json(text)
        assert [p.work_title for p in res.passages] == ["岳阳楼记"]
        assert any("第 3 行" in w for w in res.warnings)


class TestAliasNormalization:
    def test_chinese_field_names(self):
        text = '{"篇名":"岳阳楼记","册次":"下册","重点字词":[{"词":"谪守","解释":"因罪贬谪流放"}]}'
        p = parse_json(text).passages[0]
        assert p.work_title == "岳阳楼记"
        assert p.semester == "下册"
        assert p.key_terms[0].term == "谪守"
        assert p.key_terms[0].gloss == "因罪贬谪流放"

    def test_mixed_chinese_and_english(self):
        # 用户手写时最容易出现中英混用，必须都认
        text = '{"work_title":"岳阳楼记","重点字词":[{"term":"谪守","解释":"g"}]}'
        p = parse_json(text).passages[0]
        assert p.key_terms[0].term == "谪守" and p.key_terms[0].gloss == "g"

    def test_missing_title_warns_and_skips(self):
        res = parse_json('[{"semester":"上册"}]')
        assert res.passages == []
        assert any("缺少篇名" in w for w in res.warnings)

    def test_illegal_semester_downgraded_with_warning(self):
        res = parse_json('{"work_title":"岳阳楼记","semester":"中册"}')
        assert res.passages[0].semester is None
        assert any("中册" in w for w in res.warnings)


class TestMarkdownFormats:
    MD = """# 岳阳楼记

册次：上册

1. 谪守：因罪贬谪流放，出任外官
2. 越明年：到了第二年
3. 属：同"嘱"，嘱托

# 醉翁亭记

册次：下册

- 环：环绕
"""

    def test_headings_split_passages(self):
        res = parse_markdown(self.MD)
        assert [p.work_title for p in res.passages] == ["岳阳楼记", "醉翁亭记"]

    def test_semester_line(self):
        res = parse_markdown(self.MD)
        assert res.passages[0].semester == "上册"
        assert res.passages[1].semester == "下册"

    def test_term_lines(self):
        res = parse_markdown(self.MD)
        p = res.passages[0]
        assert [(t.term, t.gloss) for t in p.key_terms] == [
            ("谪守", "因罪贬谪流放，出任外官"),
            ("越明年", "到了第二年"),
            ("属", '同"嘱"，嘱托'),
        ]

    def test_all_enum_and_separator_variants(self):
        md = (
            "# 甲\n\n"
            "1. 谪守：A\n"
            "1、越明年: B\n"
            "①环＝C\n"
            "- 〔蔚然〕: D\n"
            "* 翼然 = E\n"
            "（1）临：F\n"
            "1 则:那么\n"          # 用户原话举的写法
            "醉翁 意趣\n"          # 无分隔符，退化为首个空白
        )
        p = parse_markdown(md).passages[0]
        got = [(t.term, t.gloss) for t in p.key_terms]
        assert got == [
            ("谪守", "A"), ("越明年", "B"), ("环", "C"), ("蔚然", "D"),
            ("翼然", "E"), ("临", "F"), ("则", "那么"), ("醉翁", "意趣"),
        ]

    def test_bracket_wrapped_term(self):
        p = parse_markdown("# 甲\n\n〔谪守〕：g\n").passages[0]
        assert p.key_terms[0].term == "谪守"

    def test_sentences_from_blockquote_pairs(self):
        md = (
            "# 甲\n\n"
            "> 庆历四年春，滕子京谪守巴陵郡。\n"
            "> 庆历四年的春天，滕子京被贬到巴陵郡做太守。\n\n"
            "1. 谪守：g\n"
        )
        p = parse_markdown(md).passages[0]
        assert [(s.text, s.translation) for s in p.sentences] == [
            ("庆历四年春，滕子京谪守巴陵郡。", "庆历四年的春天，滕子京被贬到巴陵郡做太守。"),
        ]

    def test_unpaired_blockquote_warns_and_drops(self):
        res = parse_markdown("# 甲\n\n> 落单的原文\n")
        assert res.passages[0].sentences is None
        assert any("没有配对" in w for w in res.warnings)

    def test_line_before_first_heading_warns(self):
        res = parse_markdown("谪守：g\n\n# 甲\n\n").passages
        assert [p.work_title for p in res] == ["甲"]
        # 首个标题前的行被忽略且告警
        got = parse_markdown("谪守：g\n\n# 甲\n\n")
        assert any("第一个" in w for w in got.warnings)

    def test_unparsable_line_warns(self):
        res = parse_markdown("# 甲\n\n这一行既没编号也没分隔符\n")
        assert res.passages[0].key_terms == []
        assert any("认不出" in w for w in res.warnings)

    def test_html_comment_lines_skipped_silently(self):
        # 输入稿里常留批注（如 `<!-- 作者：范仲淹（宋） -->`）：
        # 不跳过会被拆出「<!-- 作者」这种垃圾词，再报一堆「定位不到」把真问题淹掉
        md = "# 甲\n\n<!-- 作者：范仲淹（宋）。请按 `序号. 词：解释` 填写 -->\n\n1. 谪守：浅陋\n"
        res = parse_markdown(md)
        assert [t.term for t in res.passages[0].key_terms] == ["谪守"]
        assert res.warnings == []

    def test_multi_line_html_comment_skipped(self):
        md = "# 甲\n\n<!--\n作者：范仲淹\n朝代：宋\n-->\n\n1. 环：环绕\n"
        res = parse_markdown(md)
        assert [t.term for t in res.passages[0].key_terms] == ["环"]
        assert res.warnings == []

    def test_comment_does_not_swallow_following_content(self):
        # 单行注释写完即结束，下一行的字词照常收
        md = "# 甲\n\n<!-- 注 -->\n1. 环：环绕\n2. 蔚然：茂盛\n"
        res = parse_markdown(md)
        assert [(t.term, t.gloss) for t in res.passages[0].key_terms] == [
            ("环", "环绕"), ("蔚然", "茂盛"),
        ]


class TestSplitTermLine:
    def test_separator_variants(self):
        assert _split_term_line("1. 谪守：浅陋") == ("谪守", "浅陋")
        assert _split_term_line("①谪守:浅陋") == ("谪守", "浅陋")
        assert _split_term_line("- 谪守=浅陋") == ("谪守", "浅陋")
        assert _split_term_line("谪守 浅陋") == ("谪守", "浅陋")

    def test_no_separator_returns_none(self):
        assert _split_term_line("谪守浅陋") is None

    def test_wrapped_form_without_separator(self):
        # 课本注释原样形式：词由括号界定，解释直接跟在后面（无分隔符）
        assert _split_term_line("〔北国〕指我国北方。") == ("北国", "指我国北方。")
        assert _split_term_line("〔山舞银蛇，原驰蜡象〕群山好像银蛇在舞动。") == (
            "山舞银蛇，原驰蜡象", "群山好像银蛇在舞动。",
        )
        assert _split_term_line("[谪守]因罪贬谪流放") == ("谪守", "因罪贬谪流放")
        assert _split_term_line("【谪守】因罪贬谪流放") == ("谪守", "因罪贬谪流放")
        # 带分隔符也认
        assert _split_term_line("〔谪守〕：因罪贬谪流放") == ("谪守", "因罪贬谪流放")

    def test_wrapped_keeps_inner_pinyin(self):
        # 注音**保留在词里**（用户 2026-09-16 裁决），只由 term_plain 在定位时去掉
        assert _split_term_line("〔滕子京谪（zhé）守巴陵郡〕滕子京被贬到巴陵郡当太守。") == (
            "滕子京谪（zhé）守巴陵郡", "滕子京被贬到巴陵郡当太守。",
        )

    def test_wrapped_without_gloss_falls_through(self):
        # 只有词没有解释 → 拆不出（空 gloss 会被清洗层丢弃并告警）
        assert _split_term_line("〔北国〕") is None


class TestDocumentTitleAndRules:
    """`# 文档标题` + `## 篇名` 的写法（用户实际给的输入稿长这样）。"""

    FILE = """# 古诗文重点字词解释

> 说明：本文件由扫描图片自动识别整理而成。
> 格式为「篇名 + 分割线 + 逐条字词解释」。

---

## 沁园春·雪

〔北国〕指我国北方。

〔须〕等到。

## 岳阳楼记

〔谪守〕因罪贬谪流放，出任外官。
"""

    def test_h1_is_document_title_not_a_passage(self):
        res = parse_markdown(self.FILE)
        assert [p.work_title for p in res.passages] == ["沁园春·雪", "岳阳楼记"]

    def test_preface_and_hr_are_silent(self):
        res = parse_markdown(self.FILE)
        assert res.warnings == []
        assert res.passages[0].semester is None

    def test_wrapped_terms_parsed(self):
        res = parse_markdown(self.FILE)
        assert [(t.term, t.gloss) for t in res.passages[0].key_terms] == [
            ("北国", "指我国北方。"), ("须", "等到。"),
        ]
        assert [(t.term, t.gloss) for t in res.passages[1].key_terms] == [
            ("谪守", "因罪贬谪流放，出任外官。"),
        ]

    def test_single_level_file_still_uses_h1_as_passage(self):
        # 没有 level≥2 标题时，`#` 本身就是篇目（单篇/纯清单文件）
        res = parse_markdown("# 岳阳楼记\n\n1. 谪守：浅陋\n")
        assert [p.work_title for p in res.passages] == ["岳阳楼记"]
        assert res.passages[0].key_terms[0].term == "谪守"

    def test_hr_between_terms_ignored(self):
        res = parse_markdown("## 甲\n\n1. 环：环绕\n\n---\n\n2. 蔚然：茂盛\n")
        assert [t.term for t in res.passages[0].key_terms] == ["环", "蔚然"]
        assert res.warnings == []


class TestCleaning:
    def test_empty_term_or_gloss_dropped_with_warning(self):
        res = parse_json(
            '{"work_title":"甲","key_terms":['
            '{"term":"","gloss":"g"},{"term":"谪守","gloss":"  "},{"term":"环","gloss":"环绕"}]}'
        )
        p = res.passages[0]
        assert [t.term for t in p.key_terms] == ["环"]
        assert len([w for w in res.warnings if "丢弃字词" in w]) == 2

    def test_duplicate_term_keeps_first_with_warning(self):
        res = parse_json(
            '{"work_title":"甲","key_terms":['
            '{"term":"谪守","gloss":"第一次"},{"term":"谪守","gloss":"第二次"}]}'
        )
        p = res.passages[0]
        assert [(t.term, t.gloss) for t in p.key_terms] == [("谪守", "第一次")]
        assert any("重复" in w for w in res.warnings)

    def test_whitespace_trimmed(self):
        p = parse_json('{"work_title":"甲","key_terms":[{"term":"  谪守 ","gloss":" g "}]}').passages[0]
        assert (p.key_terms[0].term, p.key_terms[0].gloss) == ("谪守", "g")

    def test_term_field_not_array_warns(self):
        res = parse_json('{"work_title":"甲","key_terms":"x"}')
        assert res.passages[0].key_terms == []
        assert any("不是数组" in w for w in res.warnings)


class TestLoadInputBySuffix:
    def test_md_suffix_uses_markdown_parser(self, tmp_path):
        p = tmp_path / "a.md"
        p.write_text("# 甲\n\n1. 谪守：g\n", encoding="utf-8")
        assert load_input(p).passages[0].work_title == "甲"

    def test_jsonl_suffix_uses_json_parser(self, tmp_path):
        p = tmp_path / "a.jsonl"
        p.write_text('{"work_title":"甲"}\n', encoding="utf-8")
        assert load_input(p).passages[0].work_title == "甲"


class TestDedupe:
    def test_same_title_and_semester_merged(self):
        res = parse_json(
            '{"work_title":"甲","semester":"上册","key_terms":[{"term":"a","gloss":"1"}]}\n'
            '{"work_title":"甲","semester":"上册","key_terms":[{"term":"b","gloss":"2"}]}\n'
        )
        out = dedupe_passages(res)
        assert len(out.passages) == 1
        assert [t.term for t in out.passages[0].key_terms] == ["a", "b"]
        assert any("出现多次" in w for w in out.warnings)

    def test_different_semester_not_merged(self):
        res = parse_json(
            '{"work_title":"甲","semester":"上册"}\n{"work_title":"甲","semester":"下册"}\n'
        )
        assert len(dedupe_passages(res).passages) == 2
