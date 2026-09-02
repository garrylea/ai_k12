"""is_front_matter 书尾（back matter）规则测试（2026-09-01）。

背景：新书尾部页 183（纯组织说明）/186（封底）被当成内容产出垃圾卡片，
而 184 后记/185 版权尾页靠「出版社/仅供个人学习」子串碰对跳过。
新规则确定性识别书尾内容；配套的页眉剥离见 test_page_chrome.py。
"""

from extract_cli import is_front_matter

BODY = "这是一段足够长的测试内容，超过三十个字符以避免被前置内容预过滤器拦截，用于验证判定逻辑。"


class TestBackMatter:
    def test_back_cover_isbn(self):
        # page_186 封底：ISBN 条码
        text = "义务教育教科书\n\n# 数学\n\n九年级 | 上册\n\nYIWU JIAOYU JIAOKESHU\n\nISBN 978-7-107-38924-5"
        assert is_front_matter(text, page_num=186) is True

    def test_back_cover_green_printing(self):
        text = f"绿色印刷产品\n\n{BODY}"
        assert is_front_matter(text, page_num=100) is True

    def test_afterword_heading(self):
        # page_184 后记
        text = "## 后记\n\n本套教科书由人民教育出版社课程教材研究所编写。" + BODY
        assert is_front_matter(text, page_num=184) is True

    def test_vocabulary_index_heading(self):
        # 老书 page_161 词汇索引
        text = "## 部分中英文词汇索引\n\n一元二次方程 quadratic equation 3"
        assert is_front_matter(text, page_num=161) is True

    def test_contact_block(self):
        # page_184 联系方式（电话 + 邮箱同现）
        text = f"{BODY}\n\n电话：010-58758398\n\n电子邮箱：jcfk@pep.com.cn"
        assert is_front_matter(text, page_num=184) is True

    def test_organizational_page_three_markers(self):
        # page_183 综合与实践纯组织说明页：组织标记 >=3 → front matter
        text = (
            "## 活动四 提出问题并解决\n\n"
            "## 1. 组建合作团队\n\n组成研究小组，每位同学参加其中一个小组。\n\n"
            "## 4. 展示交流\n\n制作向全班汇报的演示文稿，选出代表展示研究成果。\n\n"
            "## 活动评价\n\n通过成果展示与交流，完成自我评价。"
        )
        assert is_front_matter(text, page_num=183) is True

    def test_activity_math_page_not_front_matter(self):
        # page_182 活动三：真实数学任务（表面积计算），组织标记 0 个 → 保留
        text = (
            "## 活动三 产品包装箱的设计\n\n"
            "任务1 当圆柱体产品单层排列时，研究使长方体包装箱表面积最小的排列方式。\n\n"
            "（1）当圆柱体产品底面半径 $r = 60\\mathrm{mm}$ ，高 $h = 123\\mathrm{mm}$ ，"
            "规格为12个/箱时，有几种齐排列方案？分别计算它们的包装箱表面积。"
        )
        assert is_front_matter(text, page_num=182) is False

    def test_two_org_markers_below_threshold(self):
        # 组织标记只有 2 个 → 不足以判组织说明页（正常内容页可能顺带提到）
        text = f"{BODY}\n\n活动评价：完成后进行展示交流。"
        assert is_front_matter(text, page_num=50) is False

    def test_empty_after_strip(self):
        # page_185 版权尾页剥掉页眉/水印后为空 → front matter（不限页码）
        assert is_front_matter("", page_num=185) is True

    def test_normal_content_not_front_matter(self):
        # 回归：普通正文页（含数学公式、无书尾特征）
        text = (
            "## 25.3 实际问题与一元二次方程\n\n"
            "探究1 某种传染病的传染速度很快。经过两轮传染后共有121个人被传染，"
            "那么每轮传染中平均1个人传染了多少个人？\n\n"
            "解方程，得 $x_{1} = 10, x_{2} = -12$（不合题意，舍去）。"
        )
        assert is_front_matter(text, page_num=28) is False


class TestFrontMatterRegression:
    """原有规则 1-4 在书尾规则加入后保持不变。"""

    def test_copyright_page(self):
        text = "人民教育出版社 课程教材研究所 编著\n\n人民教育出版社\n\n·北京·"
        assert is_front_matter(text, page_num=2) is True

    def test_toc_page(self):
        text = "## 目录\n\n25.1 一元二次方程的概念 2\n\n25.2 降次 5"
        assert is_front_matter(text, page_num=5) is True

    def test_intro_heading(self):
        assert is_front_matter(f"## 致同学\n\n{BODY}", page_num=4) is True

    def test_short_early_page(self):
        assert is_front_matter("# 数学\n\n上册\n\n# 九年级", page_num=1) is True
