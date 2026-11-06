"""道法材料题切分：材料 + 小问编号 / 材料 + 末句设问 两种形态。"""

from subject_strategies.material_split import split_tail_question_rule
from subject_strategies.politics import PoliticsStrategy

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

SUBQ_TAIL = "(1) 参考示例, 请从展品一、展品二、展品三中任选两件最触动你的展品, 完成推荐理由。(8 分)\n" \
            "(2) 结合活动内容和所学, 以“民族复兴的领路人”为题, 撰写一份观展心得。(6 分)"


def test_split_material_with_sub_questions_reuses_science_rule():
    content = MATERIAL + "\n" + SUBQ_TAIL
    material, rest = PoliticsStrategy().split_material(content)
    assert material is not None
    assert rest.lstrip().startswith("(1)")
    assert material + rest == content


def test_split_material_with_tail_question():
    """27/29：材料后只有一句「结合材料…」，没有小问编号。"""
    tail = "结合材料，运用所学，谈谈“三双鞋”中蕴含的“变”与“不变”。"
    content = "27.（10分）学校组织“寻访老物件 感悟精神力量”实践探究活动。\n" + MATERIAL + "\n" + tail
    material, rest = PoliticsStrategy().split_material(content)
    assert material is not None
    assert rest.strip() == tail
    assert material + rest == content


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
    """有 (1) 小问编号的交给 split_material_rule，末句规则不插手。"""
    content = MATERIAL + "\n(1) 小问\n(2) 小问"
    material, rest = split_tail_question_rule(content)
    assert material is None and rest == content


def test_plain_statement_is_not_split():
    content = "伟大建党精神是全党全国各族人民攻坚克难、奋勇前行的强大精神动力。"
    assert PoliticsStrategy().split_material(content) == (None, content)


def test_split_inline_material_skips_strategy_without_hook():
    """语文/英语没有 split_material：重抽时不能 AttributeError（暗雷护栏）。"""
    from question_extract import _split_inline_material
    from question_splitter import RawQuestion

    q = RawQuestion(group_order=1, group_id=None, content="材料" * 100)
    _split_inline_material(object(), [q])          # 没有 split_material 时静默跳过
    assert q.material_text is None

    class Fake:
        def split_material(self, content):
            return ("材料段", "问题段")

    _split_inline_material(Fake(), [q])
    assert q.material_text == "材料段" and q.content == "问题段"
