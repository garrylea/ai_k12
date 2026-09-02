"""LessonAnchor 单元测试（2026-09-02）。

TOC 页码锚定：卡片 md 页码 -> 所属章。
偏移 = 「同一标签卡片的 min md 页 - TOC printed_page」的众数；
章区间起点留 3 页章头余量。
"""

from lesson_anchor import LessonAnchor


def _toc(chapters):
    """chapters: [(chapter_no, [(label, printed_page), ...])]"""
    return {
        "book": "测试教材",
        "chapters": [
            {
                "number": no,
                "title": f"第{no}章",
                "label": f"第{no}章 标题",
                "sections": [
                    {"number": [no, i + 1],
                     "title": label.split(" ", 1)[1] if " " in label else label,
                     "label": label, "printed_page": pp, "subsections": []}
                    for i, (label, pp) in enumerate(secs)
                ],
                "supplements": [],
            }
            for no, secs in chapters
        ],
    }


def _cards(items):
    """items: [(lesson_id, textbook_page)]"""
    return [{"lesson_id": lid, "textbook_page": f"P{p}"} for lid, p in items]


class TestBuildOffset:
    def test_offset_from_matching_labels(self):
        # 两标签对齐：'25.1 ...' printed 2 首卡 md 10；'25.2 ...' printed 5 首卡 md 13 -> 偏移 8
        toc = _toc([(25, [("25.1 概念", 2), ("25.2 解法", 5)])])
        cards = _cards([("25.1 概念", 10), ("25.2 解法", 13), ("25.2 解法", 14)])
        anchor = LessonAnchor.build(toc, cards)
        assert anchor is not None
        assert anchor.offset == 8

    def test_offset_mode_among_noisy_samples(self):
        # 少数卡对不上（如某节首卡偏晚），众数仍取主流值
        toc = _toc([(25, [("25.1 概念", 2), ("25.2 解法", 5), ("25.3 应用", 20)])])
        # 25.1 首卡 md 10 -> 8；25.2 首卡 md 13 -> 8；25.3 首卡 md 31 -> 11（噪声）
        cards = _cards([("25.1 概念", 10), ("25.2 解法", 13),
                        ("25.3 应用", 31), ("25.3 应用", 32)])
        anchor = LessonAnchor.build(toc, cards)
        assert anchor is not None
        assert anchor.offset == 8

    def test_no_matching_labels_returns_none(self):
        # 卡片标签与 TOC 全对不上（如全是「小结」）-> 锚定关闭
        toc = _toc([(25, [("25.1 概念", 2)])])
        cards = _cards([("小结", 10), ("数学活动", 12)])
        assert LessonAnchor.build(toc, cards) is None

    def test_empty_cards_returns_none(self):
        assert LessonAnchor.build(_toc([(25, [("25.1 概念", 2)])]), []) is None

    def test_min_md_page_per_label(self):
        # 同一标签多页，取最小 md 页（节起始页）算样本
        toc = _toc([(25, [("25.1 概念", 2)])])
        cards = _cards([("25.1 概念", 12), ("25.1 概念", 10), ("25.1 概念", 11)])
        anchor = LessonAnchor.build(toc, cards)
        assert anchor is not None
        assert anchor.offset == 8

    def test_no_printed_pages_returns_none(self):
        # TOC 无 printed_page（异常输入）-> 锚定关闭
        toc = {"book": "t", "chapters": [{"number": 25, "title": "x", "label": "第二十五章 x",
                                          "sections": [{"number": [25, 1], "title": "a",
                                                        "label": "25.1 a", "subsections": []}],
                                          "supplements": []}]}
        assert LessonAnchor.build(toc, _cards([("25.1 a", 10)])) is None


class TestChapterOf:
    TOC = _toc([
        (25, [("25.1 概念", 2), ("25.3 应用", 20)]),   # printed 2 -> md 10
        (26, [("26.1 概念", 30)]),                     # printed 30 -> md 38
        (27, [("27.1 概念", 64)]),                      # printed 64 -> md 72
    ])

    def _anchor(self):
        cards = _cards([("25.1 概念", 10), ("26.1 概念", 38), ("27.1 概念", 72)])
        return LessonAnchor.build(self.TOC, cards)

    def test_within_chapter(self):
        a = self._anchor()
        assert a.chapter_of(28) == 25   # printed 20 附近
        assert a.chapter_of(50) == 26
        assert a.chapter_of(92) == 27

    def test_chapter_head_margin(self):
        # 27 章首个节 printed 64（md 72）；章头/章综述页 md 69-71（printed 61-63）也算 27 章
        a = self._anchor()
        assert a.chapter_of(72) == 27
        assert a.chapter_of(69) == 27   # 3 页余量内
        assert a.chapter_of(68) == 26

    def test_before_first_chapter_returns_none(self):
        # 前置页（封面/目录，md 1-6）：25 章首节 md 10，余量到 md 7 -> 之前返回 None
        a = self._anchor()
        assert a.chapter_of(6) is None
        assert a.chapter_of(7) == 25

    def test_after_last_chapter(self):
        # 27 章是最后一章 -> 尾部页（无下一章起点截断）仍属 27
        a = self._anchor()
        assert a.chapter_of(200) == 27


class TestParseHelpers:
    def test_chapter_from_label_overview(self):
        from lesson_anchor import parse_chapter_from_label
        assert parse_chapter_from_label("第二十七章 反比例函数") == 27

    def test_chapter_from_label_section(self):
        from lesson_anchor import parse_chapter_from_label
        assert parse_chapter_from_label("25.3 实际问题与一元二次方程") == 25
        assert parse_chapter_from_label("29.2.1 垂直于弦的直径") == 29

    def test_chapter_from_label_review(self):
        from lesson_anchor import parse_chapter_from_label
        assert parse_chapter_from_label("复习题 30") == 30
        assert parse_chapter_from_label("复习题27") == 27

    def test_chapter_from_label_unparseable(self):
        from lesson_anchor import parse_chapter_from_label
        assert parse_chapter_from_label("小结") is None
        assert parse_chapter_from_label(None) is None

    def test_chapter_from_content_review(self):
        from lesson_anchor import parse_chapter_from_content
        assert parse_chapter_from_content("## 复习题 27\n\n1. 下列式子中……") == 27
        assert parse_chapter_from_content("任务1 研究……复习题 30 相关") is None  # 仅认标题行

    def test_md_page_from_textbook_page(self):
        from lesson_anchor import md_page_of
        assert md_page_of("P92") == 92
        assert md_page_of("P183") == 183
        assert md_page_of(None) is None
        assert md_page_of("abc") is None


class TestOverviewAnchoring:
    """章边界首选综述卡锚定（md 空间直接锚，无偏移误差）；时间线活跃节。"""

    TOC = {
        "book": "测试书",
        "chapters": [
            {"number": 26, "title": "二次函数", "label": "第二十六章 二次函数",
             "sections": [{"label": "26.1 二次函数的概念", "printed_page": 30,
                           "subsections": []}],
             "supplements": [{"type": "supplement", "label": "小结",
                              "printed_page": 39}]},
            {"number": 27, "title": "反比例函数", "label": "第二十七章 反比例函数",
             "sections": [{"label": "27.1 反比例函数的概念", "printed_page": 64,
                           "subsections": []}],
             "supplements": [{"type": "supplement", "label": "小结",
                              "printed_page": 109}]},
        ],
    }

    def _cards(self):
        # 对齐卡（偏移 8）+ 综述卡（26 章头 md 35、27 章头 md 69）
        # + 一张错章综述标签（第26章 标签出现在 md 92，取 min 不受影响）
        return _cards([("26.1 二次函数的概念", 38), ("27.1 反比例函数的概念", 72)]) + [
            {"lesson_id": "第二十六章 二次函数", "textbook_page": "P35"},
            {"lesson_id": "第二十七章 反比例函数", "textbook_page": "P69"},
            {"lesson_id": "第二十六章 二次函数", "textbook_page": "P92"},
        ]

    def test_chapter_starts_prefer_overview_cards(self):
        a = LessonAnchor.build(self.TOC, self._cards())
        assert a is not None
        assert a.chapter_of(68) == 26      # 27 章头前一天
        assert a.chapter_of(69) == 27      # 27 章头页
        assert a.chapter_of(92) == 27      # 错章综述标签不污染边界（min 取 35）

    def test_overview_anchor_without_offset_samples(self):
        # 无节标签对齐卡、只有综述卡 -> 仍可锚定章边界（offset 退化 0）
        cards = [
            {"lesson_id": "第二十六章 二次函数", "textbook_page": "P35"},
            {"lesson_id": "第二十七章 反比例函数", "textbook_page": "P69"},
        ]
        a = LessonAnchor.build(self.TOC, cards)
        assert a is not None
        assert a.chapter_of(40) == 26
        assert a.chapter_of(70) == 27

    def test_active_label_at(self):
        a = LessonAnchor.build(self.TOC, self._cards())
        assert a is not None
        # 时间线：26头@35 -> 26.1@38 -> 26小结@47 -> 27头@69 -> 27.1@72 -> 27小结@117
        assert a.active_label_at(5) is None
        assert a.active_label_at(36) == "第二十六章 二次函数"
        assert a.active_label_at(40) == "26.1 二次函数的概念"
        assert a.active_label_at(50) == "小结"
        assert a.active_label_at(80) == "27.1 反比例函数的概念"
        assert a.active_label_at(118) == "小结"
