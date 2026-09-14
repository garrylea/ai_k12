from dictation_slice import join_pages, normalize_body, slice_body

PAGE = """# 人民教育出版社

## 10 岳阳楼记

范仲淹

庆历四年春，滕子京谪守巴陵郡。越明年，政通人和，百废具兴。

乃重修岳阳楼，增其旧制，刻唐贤今人诗赋于其上。

时六年九月十五日。

注释

〔1〕选自《范仲淹全集》。"""


class TestSliceBody:
    def test_includes_both_anchors(self):
        out = slice_body(PAGE, "庆历四年春，滕子京谪守巴陵郡。", "时六年九月十五日。")
        assert out is not None
        # 两端锚点本身必须保留
        assert out.startswith("庆历四年春，滕子京谪守巴陵郡。")
        assert out.endswith("时六年九月十五日。")
        # 中间内容与尾部注释的处理
        assert "乃重修岳阳楼" in out
        assert "选自《范仲淹全集》" not in out

    def test_start_not_found_returns_none(self):
        assert slice_body(PAGE, "不存在的首句。", "时六年九月十五日。") is None

    def test_end_not_found_returns_none(self):
        assert slice_body(PAGE, "庆历四年春，滕子京谪守巴陵郡。", "不存在的末句。") is None

    def test_empty_anchor_returns_none(self):
        assert slice_body(PAGE, "", "时六年九月十五日。") is None
        assert slice_body(PAGE, "庆历四年春，滕子京谪守巴陵郡。", "") is None

    def test_end_searched_after_start_only(self):
        # 末句锚点出现在首句之前时（如标题重复），不得回退到它
        text = "时六年九月十五日。\n\n庆历四年春，滕子京谪守巴陵郡。\n\n时六年九月十五日。"
        out = slice_body(text, "庆历四年春，滕子京谪守巴陵郡。", "时六年九月十五日。")
        assert out is not None
        assert out.count("庆历四年春") == 1

    def test_end_anchor_inside_start_anchor_span(self):
        # 末句锚点落在首句锚点**内部**时，`find(..., len(start_anchor))` 的 offset 是唯一防线：
        # 少了它会把区间截断成「只剩首句」，静默产出错误正文——比返回 None 更坏。
        text = "庆历四年春，滕子京谪守巴陵郡。越明年，政通人和。"
        assert slice_body(text, "庆历四年春，滕子京谪守巴陵郡。", "谪守巴陵郡。") is None
        # offset 只跳过「与首句锚点重叠」的匹配，不跳过首句之后真正的重复句
        repeated = "甲乙丙丁戊。其余。甲乙丙丁戊。"
        assert slice_body(repeated, "甲乙丙丁戊。", "甲乙丙丁戊。") == repeated

    def test_spans_pages_after_join(self):
        p1 = "庆历四年春，滕子京谪守巴陵郡。越明年，"
        p2 = "政通人和，百废具兴。时六年九月十五日。"
        out = slice_body(join_pages([p1, p2]), "庆历四年春，滕子京谪守巴陵郡。", "时六年九月十五日。")
        assert out is not None and "百废具兴" in out


class TestNormalizeBody:
    def test_removes_newlines_and_spaces_keeps_punctuation(self):
        assert normalize_body("庆历四年春，\n滕子京 谪守巴陵郡。") == "庆历四年春，滕子京谪守巴陵郡。"

    def test_keeps_fullwidth_punctuation(self):
        assert normalize_body("床前明月光，疑是地上霜。") == "床前明月光，疑是地上霜。"

    def test_strips_inline_annotation_markers(self):
        # 实测九上 79/170 页正文含此类行内角标（指向注释，不是正文）
        assert normalize_body("崇祯五年 $^{②}$ 十二月") == "崇祯五年十二月"
        assert normalize_body("春和景 $^{⑰}$ 明") == "春和景明"

    def test_markers_and_whitespace_both_removed(self):
        # 当前角标正则不含空白，先删角标 / 先收空白结果相同，本用例钉的是**输出**而非次序
        # （次序为何仍保持「先删角标」见 dictation_slice 模块 normalize_body docstring）
        assert normalize_body("大雪三日 $^{③}$ ，湖中人鸟声俱绝") == "大雪三日，湖中人鸟声俱绝"

    def test_keeps_legitimate_fullwidth_punctuation_only(self):
        # 不能把「——」「·」这类正文标点当残留删掉（语文正文常见）
        assert normalize_body("你是人间的四月天 ——一句爱的赞颂") == "你是人间的四月天——一句爱的赞颂"


class TestJoinPages:
    def test_orders_as_given(self):
        assert join_pages(["甲", "乙"]) == "甲\n乙"
