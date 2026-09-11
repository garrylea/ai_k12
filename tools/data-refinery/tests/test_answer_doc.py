"""answer_doc：Markdown 按卷答案文档解析。"""

import pytest

from answer_doc import AnswerDocError, doc_to_records, parse_answer_doc


class TestParseBasic:
    def test_标题与单题(self):
        doc = parse_answer_doc(
            "# 试卷：2024 海淀 初三 模拟二\n"
            "\n"
            "## 1\n"
            "答案：B\n"
            "思路：由顶点式可知顶点为 $(2,3)$。\n"
            "解析：完整过程。\n"
        )
        assert doc.title == "2024 海淀 初三 模拟二"
        assert len(doc.items) == 1
        it = doc.items[0]
        assert it.no == 1
        assert it.answer == "B"
        assert it.approach.startswith("由顶点式")
        assert it.explanation == "完整过程。"
        assert it.type_override is None

    def test_可选字段缺省(self):
        doc = parse_answer_doc("# 试卷：X\n## 2\n答案：$x=3$\n")
        assert doc.items[0].answer == "$x=3$"
        assert doc.items[0].approach == ""
        assert doc.items[0].explanation == ""

    def test_多题与题型标注(self):
        doc = parse_answer_doc(
            "# 试卷：X\n"
            "## 2\n答案：A\n"
            "## 17\n答案：解：所以 x=2。\n思路：设未知数。\n题型：calculation\n"
        )
        assert [i.no for i in doc.items] == [2, 17]
        assert doc.items[1].type_override == "calculation"

    def test_多行续写(self):
        doc = parse_answer_doc(
            "# 试卷：X\n"
            "## 25\n"
            "答案：（1）挥发性\n"
            "（2）$2H_2+O_2=2H_2O$\n"
            "思路：\n"
            "先判断物理性质，\n"
            "再写化学方程式。\n"
        )
        it = doc.items[0]
        assert it.answer == "（1）挥发性\n（2）$2H_2+O_2=2H_2O$"
        assert it.approach.startswith("先判断物理性质")
        assert it.approach.count("\n") == 1

    def test_全角冒号(self):
        doc = parse_answer_doc("# 试卷：X\n## 3\n答案：对\n思路：直接判断\n")
        assert doc.items[0].answer == "对"
        assert doc.items[0].approach == "直接判断"

    def test_空行断开续写(self):
        doc = parse_answer_doc("# 试卷：X\n## 3\n答案：第一行\n\n答案：第二行\n")
        assert doc.items[0].answer == "第二行"

    def test_解析内嵌围栏块跨空行保留(self):
        doc = parse_answer_doc(
            "# 试卷：X\n"
            "## 24\n"
            "答案：A\n"
            "解析：过程如下。\n"
            "\n"
            "```xml\n"
            "<svg viewBox=\"0 0 10 10\">\n"
            "\n"
            "  <circle cx=\"1\" cy=\"1\" r=\"1\"/>\n"
            "</svg>\n"
            "```\n"
        )
        expl = doc.items[0].explanation
        assert expl.startswith("过程如下。")
        assert "```xml" in expl
        assert "</svg>" in expl
        assert "<circle cx=\"1\"" in expl

    def test_解析空行后的普通续段保留(self):
        doc = parse_answer_doc("# 试卷：X\n## 1\n答案：A\n解析：第一段。\n\n第二段。\n")
        assert doc.items[0].explanation == "第一段。\n\n第二段。"

    def test_题间分隔线不进入解析(self):
        doc = parse_answer_doc(
            "# 试卷：X\n## 1\n答案：A\n解析：只此一句。\n\n---\n\n## 2\n答案：B\n"
        )
        assert doc.items[0].explanation == "只此一句。"
        assert doc.items[1].answer == "B"

    def test_答案多行含空行保留(self):
        doc = parse_answer_doc(
            "# 试卷：X\n## 3\n答案：\n(1) 甲\n\n(2) 乙\n思路：x\n题型：calculation\n"
        )
        assert doc.items[0].answer == "(1) 甲\n\n(2) 乙"
        assert doc.items[0].type_override == "calculation"


class TestValidation:
    def test_缺答案报错(self):
        with pytest.raises(AnswerDocError, match="第 4 题.*答案"):
            parse_answer_doc("# 试卷：X\n## 4\n思路：只有思路\n")

    def test_非法题型报错(self):
        with pytest.raises(AnswerDocError, match="第 5 题.*题型"):
            parse_answer_doc("# 试卷：X\n## 5\n答案：B\n题型：单选题\n")

    def test_无标题报错(self):
        with pytest.raises(AnswerDocError, match="试卷标题"):
            parse_answer_doc("## 1\n答案：B\n")

    def test_无题目报错(self):
        with pytest.raises(AnswerDocError, match="没有任何题目"):
            parse_answer_doc("# 试卷：X\n")

    def test_题号去重后写覆盖(self):
        doc = parse_answer_doc("# 试卷：X\n## 1\n答案：A\n## 1\n答案：B\n")
        assert len(doc.items) == 1
        assert doc.items[0].answer == "B"


class TestToRecords:
    def test_映射为记录(self):
        doc = parse_answer_doc("# 试卷：X\n## 1\n答案：B\n思路：配方\n解析：过程\n题型：choice\n")
        recs = doc_to_records(doc, paper_id=3)
        assert len(recs) == 1
        assert recs[0].paper_id == 3
        assert recs[0].question_no == 1
        assert recs[0].answer == "B"
        assert recs[0].approach == "配方"
        assert recs[0].explanation == "过程"
        assert recs[0].type == "choice"

    def test_空可选字段为None(self):
        doc = parse_answer_doc("# 试卷：X\n## 1\n答案：B\n")
        rec = doc_to_records(doc, paper_id=3)[0]
        assert rec.approach is None
        assert rec.explanation is None
        assert rec.type is None
