"""道法小问拆分：26/27/28 的结构、材料归属、分值缺失仍拆。"""

from pathlib import Path

from question_splitter import RawQuestion, split_page
from subject_strategies import get_strategy
from subject_strategies.politics_subquestions import expand


def _q(content: str, group_order: int = 26, answer: str = "") -> RawQuestion:
    return RawQuestion(group_order=group_order, group_id="二",
                       content=content, answer=answer)


Q26 = """（12分）承先之志，启时代新程。
【活动一】长征铸魂，薪火承志
2026年9月1日，以“我们的长征路”为主题的《开学第一课》正式开讲，同学们参与观看。
片一：长征途中，红军将粮食与财物分发给劳苦大众，真心实意把百姓当亲人。
(1) 结合材料, 运用所学, 以 “承先辈之志, 启时代新程” 为主题写一篇国旗下演讲稿。(8 分)
## 【活动二】文物载史，回望峥嵘
为纪念红军长征胜利90周年，国家推出很多关于长征文物的节目。
文物1：半截皮带，现收藏于中国国家博物馆
(2) 请你在以上文物中任意推荐一个文物并阐述推荐理由。(4分)
+学科观点"""

Q27 = """（19 分）2026 年是中国共产党成立 105 周年。某校九年级开展研学活动。
【活动一】十八洞村践初心，精准扶贫促共富
湖南湘西“十八洞村”在精准扶贫理念指导下脱贫摘帽。
(1) 运用所学, 仿照示例, 补全表格。(6分)
【活动二】平陆运河映初心，党的领导惠民生
平陆运河是西部陆海新通道骨干工程，于2026年9月16日正式建成通航。
(2) 结合材料, 运用所学, 谈谈平陆运河工程顺利建成的密码。(9分)
☆ 行动倡议 ☆
结合本次探究活动，班级拟向全校同学发出行动倡议。
(3) 请你完成倡议书。要求: 倡议内容需贴合青少年身份, 具体可行。(4分)"""

Q28 = """（19分）某校开展了“奋进新时代”系列活动。
【活动一】数据里的新时代
同学们调查了有关新时代的两组数据。
(1) 结合材料, 运用 “社会主要矛盾的变化” 相关知识, 谈谈你对我国当前发展状况的认识。(6分)
做法
【活动二】镜头里的新时代
同学们用自己的镜头，记录了新时代的中国故事。
(2) 你拍摄的新时代镜头是什么? 运用所学, 结合生活实际, 补全镜头四的标题和内容。(3分)
(3) 结合两个活动内容, 运用所学, 以 “奋进新时代” 为主题写一篇活动感受。(10 分)"""


def test_26_splits_two_with_own_materials():
    out = expand([_q(Q26)])
    assert [q.sub_no for q in out] == [1, 2]
    assert [q.score for q in out] == [8, 4]
    assert out[0].content.startswith("(1)")
    assert out[0].material_text.startswith("（12分）承先之志")
    assert "【活动二】" not in out[0].material_text
    assert out[1].material_text.startswith("## 【活动二】文物载史")
    assert out[1].content.startswith("(2)")
    assert "+学科观点" not in out[1].content
    assert all(q.material_position == "before" for q in out)
    assert all(q.group_order == 26 for q in out)


def test_27_splits_three():
    out = expand([_q(Q27, group_order=27)])
    assert [q.sub_no for q in out] == [1, 2, 3]
    assert [q.score for q in out] == [6, 9, 4]
    assert out[1].material_text.startswith("【活动二】平陆运河")
    assert out[2].material_text.startswith("☆ 行动倡议")


def test_28_third_inherits_previous_materials():
    out = expand([_q(Q28, group_order=28)])
    assert [q.sub_no for q in out] == [1, 2, 3]
    assert "【活动一】数据里的新时代" in out[0].material_text
    assert "【活动二】镜头里的新时代" in out[1].material_text
    # 28(3) 无自有材料，且正文指代「两个活动」→ 继承前两问材料
    assert "【活动一】数据里的新时代" in out[2].material_text
    assert "【活动二】镜头里的新时代" in out[2].material_text


def test_missing_scores_still_splits():
    content = Q26.replace("(8 分)", "").replace("(4分)", "")
    out = expand([_q(content)])
    assert len(out) == 2
    assert [q.score for q in out] == [None, None]


def test_score_mismatch_still_splits():
    content = Q26.replace("(8 分)", "(5 分)")
    out = expand([_q(content)])
    assert len(out) == 2
    assert [q.score for q in out] == [5, 4]


def test_non_contiguous_numbers_do_not_split():
    content = Q26.replace("(2) 请你", "(3) 请你")
    out = expand([_q(content)])
    assert len(out) == 1
    assert out[0].sub_no == 0


def test_stem_without_question_cue_does_not_split():
    content = """材料一
（1）这是正文里的枚举
材料二
（2）这也是正文
"""
    out = expand([_q(content)])
    assert len(out) == 1


def test_existing_material_position_is_set_for_single_question():
    q = _q(
        "（10分）阅读材料，回答问题。\n"
        "材料正文不少于六十个字：黄河是中华民族的母亲河，黄河治理事关中华民族伟大复兴，"
        "要坚持生态优先、绿色发展，让黄河成为造福人民的幸福河。\n"
        "结合材料，运用所学，谈谈你对黄河治理的认识。"
    )
    out = expand([q])
    assert len(out) == 1
    assert out[0].material_text.startswith("（10分）阅读材料")
    assert out[0].material_position == "before"


def test_split_page_applies_politics_expansion():
    qs = split_page("26. " + Q26, Path("35中.md"), strategy=get_strategy("politics"))
    assert [(q.group_order, q.sub_no) for q in qs] == [(26, 1), (26, 2)]


def test_generic_strategy_has_no_subquestion_hook():
    assert not hasattr(get_strategy("math"), "expand_subquestions")
