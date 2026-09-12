"""parser.py 的 TDD 测试。

索引页：从表格提取试卷条目（学科/区县/年级/考试类型/年份/详情 URL）。
详情页：从 __NUXT_DATA__ 提取 PDF 下载链接。
"""

import pytest

from parser import IndexParser, DetailParser, PaperItem, PdfLink


INDEX_HTML = """
<html><body>
<table>
  <tr><td colspan="4"><strong>2026海淀初三二模试卷&答案</strong></td></tr>
  <tr><td>科目</td><td>2026年</td><td>2025年</td><td>2024年</td></tr>
  <tr>
    <td>语文</td>
    <td><a href="https://www.zgkao.com/shitiku/90298.html" target="_blank">试卷 | 答案</a></td>
    <td><a href="https://www.zgkao.com/shitiku/82020.html">试卷 | 答案</a></td>
    <td>收集中</td>
  </tr>
  <tr>
    <td>数学</td>
    <td><a href="https://www.zgkao.com/shitiku/90299.html">试卷</a></td>
    <td>收集中</td>
    <td>收集中</td>
  </tr>
</table>
<table>
  <tr><td colspan="4"><strong>2026西城初三二模试卷&答案</strong></td></tr>
  <tr><td>科目</td><td>2026年</td><td>2025年</td><td>2024年</td></tr>
  <tr>
    <td>语文</td>
    <td><a href="https://www.zgkao.com/shitiku/90303.html">试卷 | 答案</a></td>
    <td>收集中</td>
    <td>收集中</td>
  </tr>
</table>
</body></html>
"""

DETAIL_HTML = """
<html><body>
<h1>2026年北京西城初三二模数学试卷在哪能下载?</h1>
<div><span>下载</span></div>
<script id="__NUXT_DATA__" type="application/json">
[["Reactive",1],{"data":2},"2026北京西城初三二模数学 有答案.pdf","https://cdn.zgkao.com/zixunzhan/17797587243432026北京西城初三二模数学 有答案.pdf"]
</script>
</body></html>
"""

DETAIL_HTML_NO_PDF = """
<html><body>
<h1>2026年北京西城初三二模数学试卷在哪能下载?</h1>
<script id="__NUXT_DATA__" type="application/json">
[["Reactive",1],{"data":2},"no pdf here"]
</script>
</body></html>
"""

# 2024 页面结构：__NUXT_DATA__ 不含 PDF URL，PDF 在 <a class="download" href="..."> 中
DETAIL_HTML_2024 = """
<html><body>
<h1>2024年海淀初三二模数学试卷和答案可以下载了!</h1>
<script id="__NUXT_DATA__" type="application/json">
[["Reactive",1],{"data":2},"some image","https://cdn.zgkao.com/zixunzhan/img.png"]
</script>
<p><a class="download" href="https://cdn.zgkao.com/17169649993212024北京海淀初三二模数学（教师版）.pdf"><strong>立即下载：</strong>2024年海淀初三二模数学试卷及答案</a></p>
</body></html>
"""


class TestIndexParser:
    def test_extracts_all_paper_items(self):
        items = IndexParser.parse(INDEX_HTML)
        assert len(items) == 4

    def test_extracts_district_from_header(self):
        items = IndexParser.parse(INDEX_HTML)
        districts = {item.district for item in items}
        assert "海淀" in districts
        assert "西城" in districts

    def test_extracts_subject_from_row(self):
        items = IndexParser.parse(INDEX_HTML)
        subjects = {item.subject for item in items}
        assert "语文" in subjects
        assert "数学" in subjects

    def test_extracts_year_from_column_header(self):
        items = IndexParser.parse(INDEX_HTML)
        years = {item.year for item in items}
        assert "2026" in years
        assert "2025" in years

    def test_extracts_grade_from_header(self):
        items = IndexParser.parse(INDEX_HTML)
        assert all(item.grade == "初三" for item in items)

    def test_extracts_exam_type_from_header(self):
        items = IndexParser.parse(INDEX_HTML)
        assert all(item.exam_type == "二模" for item in items)

    def test_extracts_detail_url(self):
        items = IndexParser.parse(INDEX_HTML)
        urls = {item.detail_url for item in items}
        assert "https://www.zgkao.com/shitiku/90298.html" in urls
        assert "https://www.zgkao.com/shitiku/90299.html" in urls
        assert "https://www.zgkao.com/shitiku/90303.html" in urls

    def test_skips_collecting_cells(self):
        items = IndexParser.parse(INDEX_HTML)
        assert all(item.detail_url for item in items)
        assert len(items) == 4

    def test_returns_empty_for_no_tables(self):
        items = IndexParser.parse("<html><body>no table</body></html>")
        assert items == []

    def test_parses_secondary_index_table_with_district_column(self):
        html = """
        <html><body>
        <table>
          <tr><td colspan="5"><strong>2023海淀初三二模试卷&答案汇总</strong></td></tr>
          <tr><td>区</td><td>科目</td><td>2023年</td><td>2022年</td><td>2021年</td></tr>
          <tr>
            <td>海淀区</td>
            <td>语文</td>
            <td><a href="https://www.zgkao.com/zk/202305/61530.html">试卷</a></td>
            <td><a href="https://www.zgkao.com/zk/202301/57975.html">试卷丨答案</a></td>
            <td><a href="https://www.zgkao.com/zk/202103/44690.html">试卷|答案</a></td>
          </tr>
          <tr>
            <td>海淀区</td>
            <td>数学</td>
            <td><a href="https://www.zgkao.com/zk/202305/61551.html">试卷</a></td>
            <td>收集中</td>
            <td>收集中</td>
          </tr>
        </table>
        </body></html>
        """
        items = IndexParser.parse(html)
        assert len(items) == 4
        subjects = [i.subject for i in items]
        assert subjects == ["语文", "语文", "语文", "数学"]
        years = [i.year for i in items]
        assert "2023" in years
        assert "2022" in years
        assert "2021" in years
        assert all(i.district == "海淀" for i in items)
        assert all(i.grade == "初三" for i in items)
        assert all(i.exam_type == "二模" for i in items)
        urls = [i.detail_url for i in items]
        assert "https://www.zgkao.com/zk/202305/61530.html" in urls
        assert "https://www.zgkao.com/zk/202305/61551.html" in urls

    def test_parses_secondary_index_table_with_rowspan_district(self):
        html = """
        <html><body>
        <table>
          <tr><td colspan="3"><strong>2023海淀初三二模试卷&答案汇总</strong></td></tr>
          <tr><td>区</td><td>科目</td><td>2023年</td></tr>
          <tr>
            <td rowspan="2">海淀区</td>
            <td>语文</td>
            <td><a href="https://www.zgkao.com/zk/202305/61530.html">试卷</a></td>
          </tr>
          <tr>
            <td>数学</td>
            <td><a href="https://www.zgkao.com/zk/202305/61551.html">试卷</a></td>
          </tr>
        </table>
        </body></html>
        """
        items = IndexParser.parse(html)
        assert len(items) == 2
        subjects = [i.subject for i in items]
        assert subjects == ["语文", "数学"]
        assert all(i.district == "海淀" for i in items)
        assert all(i.year == "2023" for i in items)
        urls = [i.detail_url for i in items]
        assert "https://www.zgkao.com/zk/202305/61530.html" in urls
        assert "https://www.zgkao.com/zk/202305/61551.html" in urls


class TestDetailParser:
    def test_extracts_pdf_url(self):
        links = DetailParser.parse(DETAIL_HTML)
        assert len(links) == 1
        assert links[0].url == "https://cdn.zgkao.com/zixunzhan/17797587243432026北京西城初三二模数学 有答案.pdf"

    def test_extracts_filename(self):
        links = DetailParser.parse(DETAIL_HTML)
        assert links[0].filename == "2026北京西城初三二模数学 有答案.pdf"

    def test_detects_combined_answer_type(self):
        links = DetailParser.parse(DETAIL_HTML)
        assert links[0].has_answer is True

    def test_returns_empty_when_no_pdf(self):
        links = DetailParser.parse(DETAIL_HTML_NO_PDF)
        assert links == []

    def test_returns_empty_when_no_nuxt_data(self):
        links = DetailParser.parse("<html><body>no script</body></html>")
        assert links == []

    def test_handles_multiple_pdf_urls(self):
        html = """
        <html><body>
        <script id="__NUXT_DATA__" type="application/json">
        ["a", "https://cdn.zgkao.com/x/paper.pdf", "b", "https://cdn.zgkao.com/x/answer.pdf"]
        </script>
        </body></html>
        """
        links = DetailParser.parse(html)
        assert len(links) == 2
        urls = {link.url for link in links}
        assert "https://cdn.zgkao.com/x/paper.pdf" in urls
        assert "https://cdn.zgkao.com/x/answer.pdf" in urls

    def test_extracts_pdf_from_download_anchor_when_nuxt_has_no_pdf(self):
        links = DetailParser.parse(DETAIL_HTML_2024)
        assert len(links) == 1
        assert links[0].url == "https://cdn.zgkao.com/17169649993212024北京海淀初三二模数学（教师版）.pdf"

    def test_extracted_download_anchor_filename_from_href(self):
        links = DetailParser.parse(DETAIL_HTML_2024)
        assert links[0].filename == "2024年海淀初三二模数学试卷及答案.pdf"

    def test_download_anchor_marked_as_has_answer_when_filename_says_so(self):
        links = DetailParser.parse(DETAIL_HTML_2024)
        assert links[0].has_answer is True

    def test_uses_anchor_text_as_filename_for_uuid_urls(self):
        html = """
        <html><body>
        <a class="download" href="https://cdn.zgkao.com/zixunzhan/202401/fdd76929-bba0-4b87-86ac-744bb6dd0a3b.pdf">立即下载：2023海淀初三二模语文试卷</a>
        </body></html>
        """
        links = DetailParser.parse(html)
        assert links[0].filename == "2023海淀初三二模语文试卷.pdf"

    def test_marks_answer_when_anchor_text_contains_answer_keyword(self):
        html = """
        <html><body>
        <a class="download" href="https://cdn.zgkao.com/zixunzhan/202401/b7af36d9-665d-4234-a97b-53d7b47a4a96.pdf">立即下载：2023海淀初三二模语文试卷答案</a>
        </body></html>
        """
        links = DetailParser.parse(html)
        assert links[0].has_answer is True
        assert links[0].filename == "2023海淀初三二模语文试卷答案.pdf"

    def test_extracts_multiple_pdf_from_download_anchors(self):
        html = """
        <html><body>
        <a class="download" href="https://cdn.zgkao.com/zixunzhan/202401/aaa.pdf">立即下载：2023海淀初三二模语文试卷</a>
        <a class="download" href="https://cdn.zgkao.com/zixunzhan/202401/bbb.pdf">立即下载：2023海淀初三二模语文试卷答案</a>
        </body></html>
        """
        links = DetailParser.parse(html)
        assert len(links) == 2
        assert links[0].filename == "2023海淀初三二模语文试卷.pdf"
        assert links[1].filename == "2023海淀初三二模语文试卷答案.pdf"
        assert links[0].has_answer is False
        assert links[1].has_answer is True


class TestPaperItemShape:
    def test_item_has_all_fields(self):
        items = IndexParser.parse(INDEX_HTML)
        item = items[0]
        assert hasattr(item, "subject")
        assert hasattr(item, "district")
        assert hasattr(item, "grade")
        assert hasattr(item, "exam_type")
        assert hasattr(item, "year")
        assert hasattr(item, "detail_url")


class TestParseHeaderDistrict:
    def test_district_before_academic_year_range(self):
        # 海淀区2024-2025学年初三（上）期末考试卷和答案汇总
        header = "海淀区2024-2025学年初三（上）期末考试卷和答案汇总"
        info = IndexParser._parse_header(header)
        assert info["district"] == "海淀"
        assert info["grade"] == "初三"
        assert info["exam_type"] == "（上）期末考"

    def test_district_after_academic_year_range(self):
        header = "2025-2026学年海淀区初二期末试卷&答案汇总"
        info = IndexParser._parse_header(header)
        assert info["district"] == "海淀"
        assert info["grade"] == "初二"
        assert info["exam_type"] == "期末"

    def test_district_after_academic_year_range_with_city_prefix(self):
        header = "2025-2026学年北京海淀区初一期末试卷&答案汇总"
        info = IndexParser._parse_header(header)
        assert info["district"] == "北京海淀"

    def test_district_without_academic_year_range_unchanged(self):
        header = "2026海淀初三二模试卷&答案"
        info = IndexParser._parse_header(header)
        assert info["district"] == "海淀"

    def test_district_after_academic_year_degree_spelling(self):
        # 「学年度」也是站点写法之一，不能把「度」留在区县里（度海淀）
        header = "2024-2025学年度海淀区初三期末试卷"
        info = IndexParser._parse_header(header)
        assert info["district"] == "海淀"
        assert info["grade"] == "初三"
        assert info["exam_type"] == "期末"

    def test_district_strips_semester_marker_after_academic_year(self):
        header = "2025-2026学年（上）海淀区初二期末试卷&答案汇总"
        info = IndexParser._parse_header(header)
        assert info["district"] == "海淀"

    def test_district_trailing_qu_stripped_for_both_spellings(self):
        """带「区」与不带「区」的表头必须落到同一个区县值（精确匹配的 --district 才能命中）。"""
        with_qu = IndexParser._parse_header("海淀区2024-2025学年初三（上）期末考试卷和答案汇总")
        without_qu = IndexParser._parse_header("2026海淀初三二模试卷&答案")
        assert with_qu["district"] == without_qu["district"] == "海淀"
