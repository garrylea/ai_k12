"""题内材料切分规则（物理/化学，2026-11-02）。

覆盖三件事：
1. **切得对**：长材料 + `(1)(2)(3)` 切成 material / rest，且 `material + rest == 原文`（构造上恒等）。
2. **不乱切**：选择题（无小问）、短题干（「求下列各式的值：(1)…(2)…」）、孤零零一个 `(1)` 都不切。
3. **该放宽的放宽**：材料段很短但**带图/表**时仍切（「用下图装置进行实验。」+ 图 + 小问）。
"""

from subject_strategies.material_split import needs_llm, split_material_rule


def test_splits_long_material_with_reading_hint():
    content = (
        "阅读以下文字，并回答问题：\n\n"
        "半导体材料的应用\n\n"
        "自然界的物质和材料千千万万，如果按导电能力划分，可以将所有的物质分为导体、半导体和绝缘体三种。"
        "其中半导体的导电能力介于导体和绝缘体之间，其电阻率在 $1\\mathrm{m}\\Omega\\cdot\\mathrm{cm}$ 之间。\n\n"
        "![](images/a.jpg)\n\n"
        "(1) 太阳能电池分为哪几类？\n"
        "(2) 判断太阳能电池优劣的主要标准是什么\n"
        "(3) 太阳能电池运行的基本原理是\n"
    )
    material, rest = split_material_rule(content)
    assert material is not None
    assert "半导体材料的应用" in material
    assert "![](images/a.jpg)" in material          # 图留在材料区
    assert rest.startswith("(1) 太阳能电池")
    assert material + rest == content               # 自校验：不丢字


def test_structure_first_without_hint_words():
    """物理/化学很多实验题**不写**「阅读以下文字」，开头直接是实验情境。"""
    content = (
        "小丽想要探究「导体两端的电压一定时，通过导体的电流与导体电阻的关系」。"
        "实验桌上的器材有：学生电源、滑动变阻器 R、电流表和电压表各一块、开关一个，阻值不等的定值电阻和导线若干。\n\n"
        "![](images/b.jpg)\n\n"
        "(1) 请画出实验电路图。\n"
        "(2) 闭合开关前，滑动变阻器的滑片应置于何处？\n"
    )
    material, rest = split_material_rule(content)
    assert material is not None
    assert "小丽想要探究" in material
    assert rest.startswith("(1)")
    assert material + rest == content


def test_short_stem_without_figure_is_not_split():
    """「求下列各式的值：(1)…(2)…」——材料段太短且无图，题干本身就是问题。"""
    content = "求下列各式的值：\n(1) $x+1$\n(2) $x-1$\n(3) $x\\times 2$\n"
    material, rest = split_material_rule(content)
    assert material is None
    assert rest == content


def test_short_stem_with_figure_is_split():
    """「用下图装置进行实验。」+ 图 + 小问：材料短但图必须留在材料区。"""
    content = (
        "用下图装置进行实验。\n"
        "![](images/c.jpg)\n"
        "(1) 向小烧杯中滴加足量稀硫酸，发生反应的化学方程式为____。\n"
        "(2) 能证明 $\\mathrm{CO_2}$ 密度比空气大的现象是____。\n"
    )
    material, rest = split_material_rule(content)
    assert material is not None
    assert "![](images/c.jpg)" in material
    assert rest.startswith("(1)")
    assert material + rest == content


def test_choice_question_with_material_is_not_split():
    """选择题（材料 + 选项，无小问）不该切——切了会把选项挪进材料区。"""
    content = (
        "下列实验操作正确的是\n\n"
        "![](images/d1.jpg)\n![](images/d2.jpg)\n\n"
        "A. 取固体粉末 B. 点燃酒精灯 C. 读取液体体积 D. 滴加液体\n"
    )
    material, rest = split_material_rule(content)
    assert material is None
    assert rest == content


def test_lone_subquestion_marker_is_not_split():
    """只有一个 `(1)`（多半是公式编号）不切。"""
    content = (
        "某实验小组测量某物质的密度，实验步骤如下所述，请阅读后回答问题并记录数据。"
        "同学们使用了天平和量筒，读数时视线要与液面齐平，注意记录单位与有效数字。\n"
        "(1) 该物质的密度是 $3 \\mathrm{g/cm^3}$\n"
    )
    material, rest = split_material_rule(content)
    assert material is None
    assert rest == content


def test_missing_left_paren_subquestion_is_supported():
    """OCR 常丢左括号：`1）` 也要能识别（化学 4274 实测形态）。"""
    content = (
        "利用水的化学变化研究水的组成。同学们取来水样，用右图装置进行电解，"
        "通电一段时间后观察两极气体的体积比，并检验气体的成分，记录实验现象。\n"
        "![](images/e.jpg)\n"
        "1）用右图装置电解水，正极产生的气体是____。\n"
        "2）氢气燃烧也能验证水的组成，产物是____。\n"
    )
    material, rest = split_material_rule(content)
    assert material is not None
    assert rest.startswith("1）")
    assert material + rest == content


def test_needs_llm_only_when_structure_looks_like_material():
    long_material = "阅读以下文字，并回答问题：" + "材料正文。" * 40 + "\n(1) 问题一\n"
    assert needs_llm(long_material) is True
    assert needs_llm("求下列各式的值：(1) 1 (2) 2") is False
    assert needs_llm("") is False


def test_concat_invariant_on_all_samples():
    """任何输入下 `material + rest == 原文`（不 rstrip，构造上恒等）。"""
    samples = [
        "阅读下面科普短文。" + "正文。" * 60 + "\n(1) 甲\n(2) 乙\n",
        "实验情境描述。" * 20 + "\n![](x.jpg)\n(1) 甲\n(2) 乙\n",
        "没有小问的短题",
    ]
    for s in samples:
        material, rest = split_material_rule(s)
        if material is not None:
            assert material + rest == s
