"""道法材料题：末句设问规则 + 不再复用物化 split_material。"""

from question_splitter import RawQuestion
from subject_strategies.politics import PoliticsStrategy
from subject_strategies.politics_subquestions import expand, split_tail_question_rule

MATERIAL = (
    "【研学目的】通过参观中国共产党历史展览馆，依托红色资源上一堂“行走的思政课”，"
    "重温党的百年奋斗历程，感悟党的领导是历史和人民的选择。\n"
    "以下是同学们在展馆中寻找到的不同时期的四件展品：\n"
    "## 展品一\n"
    "![](images/a.jpg)\n"
    "## 展品二\n"
    "![](images/b.jpg)\n"
    "推荐理由：因为这份责任书是党团结带领人民创造新时代中国特色社会主义伟大成就的一个缩影。"
)


def test_politics_does_not_override_split_material():
    """道法的小问拆分在 expand_subquestions；不能再实现 split_material 造成二次切。"""
    assert "split_material" not in PoliticsStrategy.__dict__


def test_tail_rule_rejects_choice_question():
    """材料里有两行以上 A–D 就是选择题，不能把选项当材料。"""
    content = ("某校同学准备排练情景剧，在他构思的情景中，合理的是\n"
               "A. 甲\nB. 乙\nC. 丙\nD. 丁\n"
               "请选择最符合题意的一项并说明理由。")
    assert split_tail_question_rule(content) == (None, content)


def test_tail_rule_rejects_short_material():
    content = "材料很短。\n结合材料，谈谈你的看法。"
    assert split_tail_question_rule(content) == (None, content)


def test_tail_rule_ignores_sub_question_numbering():
    """有 (1) 小问编号的交给小问拆分，末句规则不插手。"""
    content = MATERIAL + "\n(1) 小问\n(2) 小问"
    material, rest = split_tail_question_rule(content)
    assert material is None and rest == content


def test_plain_statement_is_not_split():
    content = "伟大建党精神是全党全国各族人民攻坚克难、奋勇前行的强大精神动力。"
    q = RawQuestion(group_order=30, group_id="二", content=content)
    out = expand([q])
    assert len(out) == 1
    assert out[0].material_text is None
    assert out[0].content == content


def test_split_inline_material_skips_strategy_without_hook():
    """语文/英语没有 split_material：重抽时不能 AttributeError（暗雷护栏）。"""
    from question_extract import _split_inline_material

    q = RawQuestion(group_order=1, group_id=None, content="材料" * 100)
    _split_inline_material(object(), [q])          # 没有 split_material 时静默跳过
    assert q.material_text is None

    class Fake:
        def split_material(self, content):
            return ("材料段", "问题段")

    _split_inline_material(Fake(), [q])
    assert q.material_text == "材料段" and q.content == "问题段"
