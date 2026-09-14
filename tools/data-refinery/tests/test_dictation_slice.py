from dictation_slice import cut_page_annotations, join_pages, normalize_body, slice_body

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


class TestCutPageAnnotations:
    """实测驱动：长文言文每页「上半页正文 + 下半页注释」，注释必须按页切掉。"""

    PAGE = (
        "环滁 $^{②}$ 皆山也。其西南诸峰，林壑尤美。\n"
        # 第二行**刻意不带角标**：全书注释行以上的非空行有 66% 不带角标（诗类正文常无角标），
        # 所以「切点前移」在这里会把紧邻注释的正文行一并吃掉——浅切必须原样保留它。
        "作亭者谁？山之僧智仙也。\n"
        "⑦〔意〕意趣，情趣。\n"
        "⑧〔山水之乐，得之心而寓之酒也〕欣赏山水的乐趣，领会于心间，寄托在酒中。"
    )

    def test_cuts_from_first_annotation_line(self):
        out = cut_page_annotations(self.PAGE)
        assert "环滁" in out and "作亭者谁" in out
        assert "〔" not in out and "⑦" not in out

    def test_page_without_annotations_is_unchanged(self):
        page = "庆历四年 $^{②}$ 春，滕子京谪守巴陵郡。\n越明年，政通人和。"
        assert cut_page_annotations(page) == page

    def test_all_annotation_page_becomes_empty(self):
        page = "⑥〔太守自谓也〕太守用自己的别号（醉翁）来命名。\n⑧〔谓〕为，是。"
        assert cut_page_annotations(page).strip() == ""

    def test_figure_caption_with_bracket_is_cut(self):
        # 实测 page_061 的图注「《醉翁亭图》（局部）〔清〕顾符稹作」也带 〔 〕，属页尾版面；
        # 图注行**本身**就命中 _PAGE_ANNOTATION_RE，浅切在它处截断即可，无需前移
        # （正文行即便不带角标也必须保留——见上一条 PAGE 夹具的说明）。
        page = "若夫日出而林霏开。\n《醉翁亭图》（局部）〔清〕顾符稹作"
        assert cut_page_annotations(page).strip() == "若夫日出而林霏开。"

    def test_keeps_markerless_body_line_above_annotation(self):
        # **回归护栏**：曾经试过让切点前移（理由是「正文行都带角标」），实测该前提不成立——
        # 全书注释行以上的非空行有 66% 不带角标，前移会把诗的正文行一起切掉（4 篇丢锚点、
        # 周总理你在哪里被静默删掉整页）。此用例钉住「注释行以上一律保留」。
        page = (
            "望长城内外，惟余莽莽；大河上下，顿失滔滔。\n"   # 无角标的正文行
            "还看今朝。\n"                                   # 无角标的正文行（曾是前移的受害者）
            "①②③④⑤⑥⑦⑧⑨⑩〔俱往矣〕都过去了。"
        )
        out = cut_page_annotations(page)
        assert "望长城内外" in out and "还看今朝" in out, out
        assert "俱往矣" not in out

    def test_image_above_first_annotation_is_left_for_checker(self):
        # 浅切**有意**不动注释行以上的内容：图片行若落在锚点区间内，由自检的
        # 图片语法检查判错（进人工复核），而不是靠切点前移去猜（上一条的教训）。
        page = (
            "若夫日出而林霏开 $^{①}$ ，云归而岩穴暝 $^{②}$ 。\n"
            "![](images/a9ee.jpg)\n"
            "⑩〔洌（liè）〕清。"
        )
        out = cut_page_annotations(page)
        assert "若夫日出" in out and "![" in out and "⑩" not in out

    def test_end_to_end_removes_interleaved_annotations(self):
        # 两页拼接：每页都有注释尾巴 → 切片结果不得含 〔〕
        p1 = "环滁 $^{②}$ 皆山也。\n⑦〔意〕意趣。"
        p2 = "太守谓 $^{⑧}$ 谁？庐陵 $^{⑨}$ 欧阳修也。\n⑨〔庐陵〕庐陵郡。"
        joined = join_pages([cut_page_annotations(p1), cut_page_annotations(p2)])
        body = slice_body(joined, "环滁 $^{②}$ 皆山也。", "太守谓 $^{⑧}$ 谁？庐陵 $^{⑨}$ 欧阳修也。")
        assert body is not None
        nb = normalize_body(body)
        assert "〔" not in nb and "⑦" not in nb and "⑨" not in nb
        assert nb == "环滁皆山也。太守谓谁？庐陵欧阳修也。"
