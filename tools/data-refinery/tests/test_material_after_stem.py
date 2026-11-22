"""题后材料（题号之后出现的独立材料块）找回规则的单测。

只用假 Question 对象 + 行列表，不碰 DB / LLM。
"""

from types import SimpleNamespace

import pytest

from subject_strategies.material_after_stem import (
    attach_post_material, find_post_material_blocks, resolve_owner,
)


LINES = [
    "## （二）阅读《游山西村》，完成 11-12 题。（共 6分）", "",
    "## 游山西村", "", "陆游", "",
    "莫笑农家腊酒浑，丰年留客足鸡豚。山重水复疑无路，柳暗花明又一村。箫鼓追随春社近，衣冠简朴古风存。", "",
    "11.根据你的理解，在下面横线上填写恰当的内容。（2分）", "",
    "12.在记游抒情的古诗词中，诗人常通过所见来抒发所感。结合本诗画线句与《行香子》下片的相关句子，说说诗人是如何描绘农家风情画卷来抒发情感的。（4分）", "",
    "## 行香子", "", "## 秦观", "",
    "树绕村庄，水满陂塘<sup>①</sup>。倚东风，豪兴徜徉<sup>②</sup>。小园几许<sup>③</sup>，收尽春光。有桃花红，李花白，菜花黄。远远围墙，隐隐茅堂。", "",
    "注：①〔陂塘〕池塘。②〔徜徉〕闲游。③〔几许〕多少。", "",
    "## （三）阅读《岳阳楼记》，完成 13-14 题。（共 7分）", "",
    "## 岳阳楼记", "", "范仲淹", "",
    "庆历四年春，滕子京谪守巴陵郡。越明年，政通人和，百废具兴。", "",
    "13.下列加点词解释有误的一项是(2分)", "",
]


def fake_q(n, content, material=None):
    return SimpleNamespace(
        group_order=n, content=content, material_text=material,
        post_material_base=material, post_material_appended=None,
        post_material_pending=None,
    )


def two_questions():
    base = "## （二）阅读《游山西村》，完成 11-12 题。\n## 游山西村\n陆游\n莫笑农家腊酒浑。"
    return [
        fake_q(11, "根据你的理解填写。", base),
        fake_q(12, "结合本诗画线句与《行香子》下片的相关句子，说说诗人如何抒发情感。", base),
        fake_q(13, "《岳阳楼记》中加点词解释有误的一项。", "## 岳阳楼记\n范仲淹\n庆历四年春。"),
    ]


def test_finds_post_stem_block_without_crossing_section():
    blocks = find_post_material_blocks(LINES)
    assert len(blocks) == 1
    block = blocks[0]
    assert block["title"] == "行香子"
    assert "## 秦观" in block["text"]       # 子标题属于材料块内部
    assert "注：" in block["text"]
    assert "<sup>①</sup>" in block["text"]  # 原样保留标注
    assert "（三）" not in block["text"]     # 下一节标题不能混进来


def test_exact_title_match_picks_citing_question():
    questions = two_questions()
    block = find_post_material_blocks(LINES)[0]
    owner, status = resolve_owner(questions, block, LINES)
    assert (owner, status) == (12, "exact")


def test_attach_appends_without_touching_base_or_content():
    questions = two_questions()
    hits = attach_post_material(questions, LINES, paper_stem="模拟二")
    assert hits == 1
    q12 = questions[1]
    assert "游山西村" in q12.material_text and "行香子" in q12.material_text
    assert q12.material_text.index("游山西村") < q12.material_text.index("行香子")
    assert "行香子" not in q12.post_material_base
    assert "树绕村庄" not in q12.content
    assert "行香子" not in questions[0].material_text
    assert "行香子" not in questions[2].material_text


def test_dedupe_skips_already_attached_block():
    questions = two_questions()
    questions[1].material_text += "\n\n## 行香子\n树绕村庄，水满陂塘。"
    assert attach_post_material(questions, LINES) == 0
    assert questions[1].post_material_appended is None


def test_nearest_preceding_stem_with_unresolved_marker():
    questions = two_questions()
    questions[1].content = "结合本诗画线句说说诗人如何抒发情感。"
    block = find_post_material_blocks(LINES)[0]
    owner, status = resolve_owner(questions, block, LINES)
    assert (owner, status) == (12, "nearest")


def test_ambiguous_case_leaves_data_untouched_and_waits_for_llm():
    questions = two_questions()
    # 两题都带未决指代、都没有精确标题引用 → 不能猜
    lines = list(LINES)
    questions[0].content = "结合上述材料，填写恰当的内容。"
    questions[1].content = "结合上述材料，说说诗人如何抒发情感。"
    block = find_post_material_blocks(lines)[0]
    owner, status = resolve_owner(questions, block, lines)
    assert owner is None and status == "ambiguous"

    hits = attach_post_material(questions, lines, paper_stem="模拟二")
    assert hits == 0
    assert all(q.post_material_appended is None for q in questions)
    assert questions[0].post_material_pending and questions[1].post_material_pending
    assert questions[2].post_material_pending is None


def test_short_block_is_ignored():
    lines = [
        "12.结合本诗填写。", "", "## 行香子", "", "树绕村庄。", "",
        "## （三）阅读《岳阳楼记》，完成题。", "",
    ]
    assert find_post_material_blocks(lines) == []


# ---------- 2026-11-22 海淀模拟一：题后材料跨站拼接事故 ----------

HAIDIAN_LINES = [
    "## 一、基础·运用", "",
    "“进京赶考”原指古代科举学子赴京应试。", "",
    "## 第一站 清华园车站旧址", "", "清华园车站旧址是京张铁路上的地标。" * 4, "",
    "1.你审核资料中标注的字音。下列加点字读音标注不正确的一项是（2分）", "",
    "2.文段中的画线句存在问题，请你修改。(2分)", "",
    "## 第二站 颐和园益寿堂", "", "颐和园益寿堂是清光绪年间修建的四合院。" * 4, "",
    "3.一位同学想为益寿堂拟写一副对联。", "",
    "②铸魂育人", "",                      # 重复的残句小标题（不是材料标题）
    "## 第三站 双清别墅", "", "双清别墅位于海淀区香山公园南部山腰。" * 4, "",
    "4.你检查了文段中成语使用的情况。", "",
    "## 第四站 香山革命纪念馆", "", "香山革命纪念馆6000平方米的展厅里陈列着文物。" * 4, "",
    "5.文段中“革故鼎新”的意思是什么。", "",
]


def test_circled_number_line_is_not_a_material_title():
    """①-⑳ 开头的是选项/子项序号，不是材料标题。"""
    from subject_strategies.material_after_stem import _title_at

    for i, line in enumerate(HAIDIAN_LINES):
        if line.strip().startswith("②"):
            assert _title_at(HAIDIAN_LINES, i) is None
            return
    raise AssertionError("测试夹具里没找到 ② 开头的行")


def test_post_material_does_not_span_next_section():
    """题后材料块不能跨过「## 第X站」把下一节吞进来（Q2 事故回归）。"""
    blocks = find_post_material_blocks(HAIDIAN_LINES)
    # 可能识别出「第二站/第三站/第四站」，但每块都只含自己那一站
    for b in blocks:
        title = b["title"]
        assert ("第三站" in b["text"]) == (title == "第三站 双清别墅"), \
            f"块 {title!r} 串进了不相干的站点内容"
        assert "②铸魂育人" not in b["text"], "残句小标题不该成为材料块正文"
    # 最关键：没有任何块把「第二站」和「第三站」拼在一起
    assert not any("第二站" in b["text"] and "第三站" in b["text"] for b in blocks)


def test_q2_does_not_get_wrong_post_material():
    """Q2 题干带「画线句」也不该收到跨站拼来的假块。"""
    # 各站材料已挂在对应题上（真实卷子里 Q3=第二站/Q4=第三站…），题后钩子按
    # already 规则跳过这些块，不该再往带「画线句」的 Q2 上追加任何一块。
    questions = [
        fake_q(1, "你审核资料中标注的字音。", "## 第一站 清华园车站旧址\n清华园车站旧址是京张铁路上的地标。"),
        fake_q(2, "文段中的画线句存在问题，请你修改。", "## 第一站 清华园车站旧址\n清华园车站旧址是京张铁路上的地标。"),
        fake_q(3, "拟写一副对联。", "## 第二站 颐和园益寿堂\n颐和园益寿堂是清光绪年间修建的四合院。"),
        fake_q(4, "检查成语使用。", "## 第三站 双清别墅\n双清别墅位于海淀区香山公园南部山腰。"),
        fake_q(5, "革故鼎新是什么意思。", "## 第四站 香山革命纪念馆\n香山革命纪念馆6000平方米的展厅里陈列着文物。"),
    ]
    attach_post_material(questions, HAIDIAN_LINES, paper_stem="海淀模拟一")
    q2 = questions[1]
    assert q2.post_material_appended is None, "Q2 不该被追加上「②铸魂育人+第三站」假块"
    assert "第三站" not in (q2.material_text or "")