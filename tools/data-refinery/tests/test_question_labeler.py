from question_labeler import QuestionLabeler, LabeledQuestion
from question_splitter import RawQuestion


def _fake_response(content: str):
    return type("R", (), {"content": content})()


def _fake_llm_single_question():
    """mock LLM：对单题返回 type/difficulty/kp。"""
    class FakeLLM:
        def complete(self, system, user):
            return _fake_response(
                '{"type":"fill_blank","difficulty":2,'
                '"knowledge_points":["M0101"],"suggested_new_kps":[],'
                '"completeness":{"is_complete":true,"issues":[]}}'
            )
    return FakeLLM()


def _fake_llm_with_suggested_new_kp():
    """mock LLM：输出一个 suggested_new_kp。"""
    class FakeLLM:
        def complete(self, system, user):
            return _fake_response(
                '{"type":"short_answer","difficulty":3,'
                '"knowledge_points":["M0302"],"suggested_new_kps":["新知识点X"],'
                '"completeness":{"is_complete":true,"issues":[]}}'
            )
    return FakeLLM()


KPS = [
    {"code": "M0101", "name": "有理数的概念与分类"},
    {"code": "M0302", "name": "分式及其性质"},
]


def test_label_single_question_no_new_kp():
    labeler = QuestionLabeler(
        llm=_fake_llm_single_question(),
        prompt="type/difficulty/kp:\n{{question}}\nKP列表:\n{{knowledge_points}}",
        knowledge_points=KPS,
    )
    q = RawQuestion(group_order=9, group_id=None, content="若代数式 ...")
    labeled = labeler.label([q], batch_size=1)
    assert len(labeled) == 1
    assert labeled[0].type == "fill_blank"
    assert labeled[0].difficulty == 2
    assert labeled[0].knowledge_points == ["M0101"]
    assert labeled[0].suggested_new_kps == []


def test_label_single_question_with_suggested_new_kp():
    labeler = QuestionLabeler(
        llm=_fake_llm_with_suggested_new_kp(),
        prompt="{{question}}\n{{knowledge_points}}",
        knowledge_points=KPS,
    )
    q = RawQuestion(group_order=17, group_id="三", content="某新颖题...")
    labeled = labeler.label([q], batch_size=1)
    assert labeled[0].suggested_new_kps == ["新知识点X"]


def test_label_prompt_injects_kp_list():
    """prompt 的 {{knowledge_points}} 占位符被替换为已有 KP 列表。"""
    captured = {}

    class CaptureLLM:
        def complete(self, system, user):
            captured["user"] = user
            return _fake_response(
                '{"type":"fill_blank","difficulty":1,'
                '"knowledge_points":[],"suggested_new_kps":[],'
                '"completeness":{"is_complete":true,"issues":[]}}'
            )
    labeler = QuestionLabeler(
        llm=CaptureLLM(),
        prompt="KP:\n{{knowledge_points}}\nQ:\n{{question}}",
        knowledge_points=KPS,
    )
    q = RawQuestion(group_order=1, group_id=None, content="题干")
    labeler.label([q], batch_size=1)
    assert "M0101" in captured["user"]
    assert "有理数的概念与分类" in captured["user"]


def test_label_llm_failure_returns_none():
    """LLM 抛异常 + 重试 + 无 fallback 全部失败时，该题跳过返回 None（不写坏数据）。"""
    class FailingLLM:
        def complete(self, system, user):
            raise RuntimeError("network error")
    labeler = QuestionLabeler(
        llm=FailingLLM(),
        prompt="{{question}}",
        knowledge_points=KPS,
    )
    q = RawQuestion(group_order=1, group_id=None, content="题干")
    labeled = labeler.label([q], batch_size=1)
    assert labeled == [None]  # 跳过：调用方不写 JSONL


# === 标注必填字段校验 + 重试/备选/跳过 ===


def _seq_llm(*responses):
    """按调用顺序返回 JSON 字符串的 mock LLM；耗尽后抛异常。"""
    calls = {"n": 0}
    class FakeLLM:
        def __init__(self):
            self.called = 0
        def complete(self, system, user):
            self.called += 1
            calls["n"] += 1
            if calls["n"] > len(responses):
                raise RuntimeError("responses exhausted")
            return _fake_response(responses[calls["n"] - 1])
    return FakeLLM()


def _good_item(type_="fill_blank", difficulty=2, complete=True):
    return (f'{{"type":"{type_}","difficulty":{difficulty},'
            '"knowledge_points":["M0101"],"suggested_new_kps":[],'
            f'"completeness":{{"is_complete":{str(complete).lower()},"issues":[]}}}}')


def test_validate_rejects_missing_type():
    """type 缺失 → 校验失败 → 重试后成功。"""
    bad = '{"difficulty":2,"knowledge_points":[],"suggested_new_kps":[],"completeness":{"is_complete":true,"issues":[]}}'
    llm = _seq_llm(bad, _good_item())
    labeler = QuestionLabeler(llm=llm, prompt="{{content}}", knowledge_points=KPS)
    q = RawQuestion(group_order=3, group_id=None, content="题干")
    res = labeler.label([q], batch_size=1)
    assert res[0].type == "fill_blank"
    assert llm.called == 2  # 重试了一次


def test_validate_rejects_bad_difficulty():
    """difficulty 缺失/越界 → 校验失败 → 重试后成功。"""
    bad = '{"type":"choice","difficulty":9,"knowledge_points":[],"suggested_new_kps":[],"completeness":{"is_complete":true,"issues":[]}}'
    llm = _seq_llm(bad, _good_item())
    labeler = QuestionLabeler(llm=llm, prompt="{{content}}", knowledge_points=KPS)
    q = RawQuestion(group_order=3, group_id=None, content="题干")
    res = labeler.label([q], batch_size=1)
    assert res[0].type == "fill_blank"
    assert llm.called == 2


def test_validate_rejects_incomplete_missing_regen():
    """is_complete=false 但缺 regenerated → 校验失败。"""
    bad = ('{"type":"choice","difficulty":2,"knowledge_points":[],"suggested_new_kps":[],'
           '"completeness":{"is_complete":false,"issues":["选项缺失"]}}')
    llm = _seq_llm(bad, _good_item())
    labeler = QuestionLabeler(llm=llm, prompt="{{content}}", knowledge_points=KPS)
    q = RawQuestion(group_order=3, group_id=None, content="题干")
    res = labeler.label([q], batch_size=1)
    assert res[0].type == "fill_blank"
    assert llm.called == 2


def test_validate_accepts_physics_missing_image_unrepairable():
    """物理实验题缺图（图未随卷给出）：模型返回 is_complete=false + regenerated=null
    + issues 含「缺图」「无法修复」→ 属于 content 型缺陷，接受只报告不修复，
    保留 type/difficulty/KP，不重试。

    事故（2026-11-03 汇文题21）：Qwen3.8-27B 正确返回了 type=short_answer /
    difficulty=3 / KP=[P1003] + is_complete=false + regenerated=null + issues
    含「缺图缺陷，无法修复」，被旧规则判失败→重试→兜底→402→完全丢失，
    最后用确定性兜底（difficulty 降级 2、KP 丢空）。
    """
    good_with_content_defect = (
        '{"type":"short_answer","difficulty":3,"knowledge_points":["P1003"],'
        '"suggested_new_kps":[],'
        '"completeness":{"is_complete":false,"issues":'
        '["题干提及图2未随卷给出，属于缺图缺陷，无法修复"]},'
        '"regenerated":null}'
    )
    llm = _seq_llm(good_with_content_defect)
    labeler = QuestionLabeler(llm=llm, prompt="{{content}}", knowledge_points=KPS,
                              subject="physics")
    q = RawQuestion(group_order=21, group_id="三",
                    content="(1)实验中通过观察 来比较电阻大小；(2)把A、B、C、D电阻丝接入...")
    res = labeler.label([q], batch_size=1)
    assert llm.called == 1, "content 型缺陷应一次通过，不重试"
    assert res[0].type == "short_answer"
    assert res[0].difficulty == 3
    assert res[0].knowledge_points == ["P1003"]
    assert res[0].is_complete is False  # 标 needs_review，is_active=0 不进抽题池


def test_validate_rejects_physics_missing_options_still_requires_regen():
    """物理缺选项（option 型缺陷）：regenerated=null 仍要求修复，重试后成功。

    缺选项有上下文残片可依（数学/物理/化学的设计约定），不能只报告不修复。
    """
    bad = ('{"type":"choice","difficulty":2,"knowledge_points":["P1003"],'
           '"suggested_new_kps":[],'
           '"completeness":{"is_complete":false,"issues":["选项不足4个"]},'
           '"regenerated":null}')
    llm = _seq_llm(bad, _good_item())
    labeler = QuestionLabeler(llm=llm, prompt="{{content}}", knowledge_points=KPS,
                              subject="physics")
    q = RawQuestion(group_order=5, group_id="一", content="题干 A. 甲 B. 乙 C. 丙")
    res = labeler.label([q], batch_size=1)
    assert llm.called == 2, "option 型缺陷应重试"
    assert res[0].type == "fill_blank"  # 第二次（_good_item）的 type


def test_image_option_false_positive_is_treated_complete():
    """「选项是图片、无法文本校验」是误判：图选项题本身完整，不标 needs_review。

    事故（2026-11-03 汇文题8）：4 张图片选项的合法题被 LLM 判 is_complete=false
    → needs_review=True → is_active=0 → 被考试题单过滤，页面题号整体前移
    （用户看到"第8题"其实是第9题，以为图被挪走了）。

    判据是**结构**（4 个选项全是纯图片），不依赖 LLM 措辞——实测三轮措辞都不同。
    """
    item = ('{"type":"choice","difficulty":2,"knowledge_points":["P1003"],'
            '"suggested_new_kps":[],'
            '"completeness":{"is_complete":false,'
            '"issues":["选择题选项均为电路图图片，且无法从文本中校验图片内容"]}}')
    llm = _seq_llm(item)  # 只给一次，若重试会耗尽抛错
    labeler = QuestionLabeler(llm=llm, prompt="{{content}}", knowledge_points=KPS,
                              subject="physics")
    q = RawQuestion(group_order=8, group_id="一",
                    content="题干\nA.\n![](images/a.jpg)\nB.\n![](images/b.jpg)\n"
                            "C.\n![](images/c.jpg)\nD.\n![](images/d.jpg)")
    res = labeler.label([q], batch_size=1)
    assert llm.called == 1
    assert res[0].is_complete is True
    assert res[0].completeness_issues == []


def test_text_options_without_images_and_missing_figure_stay_incomplete():
    """content 里一张图都没有 + LLM 说缺图 → 真缺图，仍标待复核。"""
    item = ('{"type":"choice","difficulty":2,"knowledge_points":["P1003"],'
            '"suggested_new_kps":[],'
            '"completeness":{"is_complete":false,'
            '"issues":["题干要求连接实物图，但未包含实物元件图，无法修复"]}}')
    llm = _seq_llm(item)
    labeler = QuestionLabeler(llm=llm, prompt="{{content}}", knowledge_points=KPS,
                              subject="physics")
    q = RawQuestion(group_order=20, group_id="三",
                    content="题干\nA. 电源电压\nB. 电阻R的阻值\nC. R两端电压\nD. 滑动变阻器阻值")
    res = labeler.label([q], batch_size=1)
    assert res[0].is_complete is False
    assert res[0].completeness_issues


def test_missing_figure_claim_ignored_when_images_present():
    """content 里其实有图 + LLM 说缺图 → 误判（MinerU 已抽图、LLM 看不到），判完整。

    事故（2026-11-03 汇文题20/题21）：实物图、图2（电阻丝参数图）都在 md 里，
    LLM 纯文本看不到图，判「缺图」→ needs_review → is_active=0 → 考试题单过滤
    → 页面题号整体前移。
    """
    item = ('{"type":"short_answer","difficulty":3,"knowledge_points":["P1003"],'
            '"suggested_new_kps":[],'
            '"completeness":{"is_complete":false,'
            '"issues":["题干提到图2，但原文中缺失图2，无法完整解题"]}}')
    llm = _seq_llm(item)
    labeler = QuestionLabeler(llm=llm, prompt="{{content}}", knowledge_points=KPS,
                              subject="physics")
    q = RawQuestion(group_order=21, group_id="三",
                    content="探究电阻大小\n![](images/fig1.jpg)\n"
                            "![](images/fig2.jpg)\n(1)观察____来比较电阻大小")
    res = labeler.label([q], batch_size=1)
    assert res[0].is_complete is True
    assert res[0].completeness_issues == []


def test_missing_figure_claim_ignored_when_images_in_material_text():
    """图片被 split_material 移到 material_text、content 里没图 → 也要判完整。

    事故（2026-11-03 汇文题18/21/25）：content 图数=0，但 material_text 里有
    1-3 张图；只查 content 会漏，仍被误标 needs_review。
    """
    item = ('{"type":"short_answer","difficulty":3,"knowledge_points":["P1003"],'
            '"suggested_new_kps":[],'
            '"completeness":{"is_complete":false,'
            '"issues":["题干写如图所示但图片文件未随卷给出，属于缺图"]}}')
    llm = _seq_llm(item)
    labeler = QuestionLabeler(llm=llm, prompt="{{content}}", knowledge_points=KPS,
                              subject="physics")
    q = RawQuestion(group_order=25, group_id="五",
                    content="如图所示，求电流",
                    material_text="如图所示的电路\n![](images/fig.jpg)")
    res = labeler.label([q], batch_size=1)
    assert res[0].is_complete is True
    assert res[0].completeness_issues == []


def test_structural_defect_with_images_stays_incomplete():
    """有图但缺陷是文本结构问题（选项冲突/截断）→ 不被图误判吞掉，仍待复核。

    事故（2026-11-03 汇文题24）：选项 A-D 只对应第(1)小题、题干混入 (2)(3)(4)，
    是真结构问题，不能因为题里有图就放过。
    """
    from question_labeler import LabeledQuestion
    labeler = QuestionLabeler(llm=None, prompt="", knowledge_points=KPS, subject="physics")
    q = RawQuestion(group_order=24, group_id="四",
                    content="题干\n![](images/a.jpg)\nA. 甲 B. 乙 C. 丙 D. 丁")
    labeled = LabeledQuestion.from_raw(q)
    item = {"type": "short_answer", "difficulty": 3,
            "knowledge_points": ["P1003"], "suggested_new_kps": [],
            "completeness": {"is_complete": False,
                             "issues": ["题目结构混乱：选项A-D仅对应第(1)小题，"
                                        "题干混入第(2)(3)(4)小题"]}}
    labeler._fill_from_item(labeled, item)
    assert labeled.is_complete is False
    assert labeled.completeness_issues


def test_missing_figure_keeps_incomplete():
    """缺图（题干引用的图未随卷给出）是真缺陷，仍保持 is_complete=False（标待复核）。"""
    item = ('{"type":"short_answer","difficulty":3,"knowledge_points":["P1003"],'
            '"suggested_new_kps":[],'
            '"completeness":{"is_complete":false,'
            '"issues":["题干提及图2未随卷给出，属于缺图缺陷，无法修复"]}}')
    llm = _seq_llm(item)
    labeler = QuestionLabeler(llm=llm, prompt="{{content}}", knowledge_points=KPS,
                              subject="physics")
    q = RawQuestion(group_order=21, group_id="三", content="(1)观察 来比较电阻大小")
    res = labeler.label([q], batch_size=1)
    assert res[0].is_complete is False
    assert res[0].completeness_issues


def test_validate_rejects_regen_bad_structure():
    """choice 且 is_complete=false：regenerated.options 非 4 项/空 text → 校验失败。"""
    bad = ('{"type":"choice","difficulty":2,"knowledge_points":[],"suggested_new_kps":[],'
           '"completeness":{"is_complete":false,"issues":[]},'
           '"regenerated":{"content":"题干","options":[{"label":"A","text":"x"},{"label":"B","text":""}]}}')
    llm = _seq_llm(bad, _good_item())
    labeler = QuestionLabeler(llm=llm, prompt="{{content}}", knowledge_points=KPS)
    q = RawQuestion(group_order=3, group_id=None, content="题干")
    res = labeler.label([q], batch_size=1)
    assert res[0].type == "fill_blank"
    assert llm.called == 2


def test_validate_rejects_python_split_complete_but_llm_rewrites():
    """Python 已确定性拆出完整 4 选项，LLM 却判 is_complete=false 且重写 options
    （与 Python 不一致）→ 校验失败，重试后成功。"""
    content = ("如图, 则 $\\angle AOE$ 的大小为 (A) $25^{\\circ}$ "
               "(B) $35^{\\circ}$ (C) $45^{\\circ}$ (D) $55^{\\circ}$\n![](images/a.jpg)")
    bad = ('{"type":"choice","difficulty":2,"knowledge_points":[],"suggested_new_kps":[],'
           '"completeness":{"is_complete":false,"issues":["选项D内容缺失"]},'
           '"regenerated":{"content":"如图...","options":'
           '[{"label":"A","text":"$25^{\\\\circ}$"},{"label":"B","text":"$35^{\\\\circ}$"},'
           '{"label":"C","text":"$45^{\\\\circ}$"},{"label":"D","text":"(编造)"}]}}')
    llm = _seq_llm(bad, _good_item())
    labeler = QuestionLabeler(llm=llm, prompt="{{content}}", knowledge_points=KPS)
    q = RawQuestion(group_order=3, group_id=None, content=content)
    res = labeler.label([q], batch_size=1)
    assert res[0].type == "fill_blank"
    assert llm.called == 2


def test_label_fallback_model_used_after_main_fails():
    """主模型两次失败后换备选模型标注成功。"""
    bad = '{"difficulty":2,"knowledge_points":[],"suggested_new_kps":[],"completeness":{"is_complete":true,"issues":[]}}'
    main = _seq_llm(bad, bad)          # 主模型两次都坏（type 缺失）
    fb = _seq_llm(_good_item())        # 备选一次成功
    fallback = QuestionLabeler(llm=fb, prompt="{{content}}", knowledge_points=KPS)
    labeler = QuestionLabeler(llm=main, prompt="{{content}}", knowledge_points=KPS,
                              fallback_labeler=fallback)
    q = RawQuestion(group_order=3, group_id=None, content="题干")
    res = labeler.label([q], batch_size=1)
    assert res[0].type == "fill_blank"
    assert main.called == 2
    assert fb.called == 1


def test_label_all_fail_returns_none():
    """主模型 2 次 + 备选 1 次全部失败 → 跳过返回 None。"""
    bad = '{"difficulty":2,"knowledge_points":[],"suggested_new_kps":[],"completeness":{"is_complete":true,"issues":[]}}'
    main = _seq_llm(bad, bad)
    fb = _seq_llm(bad)
    fallback = QuestionLabeler(llm=fb, prompt="{{content}}", knowledge_points=KPS)
    labeler = QuestionLabeler(llm=main, prompt="{{content}}", knowledge_points=KPS,
                              fallback_labeler=fallback)
    q = RawQuestion(group_order=3, group_id=None, content="题干")
    res = labeler.label([q], batch_size=1)
    assert res == [None]
    assert main.called == 2
    assert fb.called == 1


def test_label_batch_invalid_item_falls_back_to_single():
    """多题批中某题 item 无效 → 该题降级为单题走重试流程；其他题正常。"""
    good1 = '{"type":"fill_blank","difficulty":2,"knowledge_points":[],"suggested_new_kps":[],"completeness":{"is_complete":true,"issues":[]}}'
    # 批调用返回 2 个 item，第 2 个坏（type 缺失）
    batch_resp = ('{"items":[' + good1 + ',{"difficulty":1,"knowledge_points":[],'
                  '"suggested_new_kps":[],"completeness":{"is_complete":true,"issues":[]}}]}')
    main = _seq_llm(batch_resp, good1)  # 批调用 + 第2题单题重试成功
    labeler = QuestionLabeler(llm=main, prompt="{{content}}", knowledge_points=KPS)
    q1 = RawQuestion(group_order=1, group_id=None, content="题一")
    q2 = RawQuestion(group_order=2, group_id=None, content="题二")
    res = labeler.label([q1, q2], batch_size=2)
    assert res[0].type == "fill_blank"
    assert res[1].type == "fill_blank"
    assert main.called == 2  # 批调用1次 + 题2单题重试1次


# === Task 6: 双模型确认新增 KP ===

def _confirm_llm(is_new: bool, matched: str | None = None):
    """mock fallback LLM：返回 is_new/matched_existing_code。"""
    class FakeLLM:
        def complete(self, system, user):
            import json
            return _fake_response(json.dumps({"is_new": is_new, "matched_existing_code": matched}))
    return FakeLLM()


def _make_labeler_with_fallback(main_llm, fallback_llm):
    """构造主+兜底 labeler。"""
    fallback = QuestionLabeler(
        llm=fallback_llm,
        prompt="{{question}}\n{{knowledge_points}}",
        knowledge_points=KPS,
    )
    return QuestionLabeler(
        llm=main_llm,
        prompt="{{question}}\n{{knowledge_points}}",
        knowledge_points=KPS,
        fallback_labeler=fallback,
    )


def test_confirm_new_kps_both_agree_new():
    """两个模型都认为是新增 → 填入 _confirmed_new_kps。"""
    labeler = _make_labeler_with_fallback(_fake_llm_with_suggested_new_kp(), _confirm_llm(True))
    q = RawQuestion(group_order=1, group_id=None, content="题")
    labeled = labeler.label([q], batch_size=1)
    assert labeled[0].suggested_new_kps == ["新知识点X"]
    confirmed = labeler.confirm_new_kps(labeled)
    assert len(confirmed[0]._confirmed_new_kps) == 1
    assert confirmed[0]._confirmed_new_kps[0]["name"] == "新知识点X"


def test_confirm_new_kps_fallback_says_not_new():
    """兜底认为不新增 → _confirmed_new_kps 为空，matched 加入 knowledge_points。"""
    labeler = _make_labeler_with_fallback(_fake_llm_with_suggested_new_kp(), _confirm_llm(False, "M0101"))
    q = RawQuestion(group_order=1, group_id=None, content="题")
    labeled = labeler.label([q], batch_size=1)
    confirmed = labeler.confirm_new_kps(labeled)
    assert confirmed[0]._confirmed_new_kps == []
    assert "M0101" in confirmed[0].knowledge_points


def test_confirm_new_kps_no_suggested():
    """没有 suggested_new_kps → confirm 不做任何事。"""
    labeler = _make_labeler_with_fallback(_fake_llm_single_question(), _confirm_llm(True))
    q = RawQuestion(group_order=1, group_id=None, content="题")
    labeled = labeler.label([q], batch_size=1)
    assert labeled[0].suggested_new_kps == []
    confirmed = labeler.confirm_new_kps(labeled)
    assert confirmed[0]._confirmed_new_kps == []


def test_confirm_new_kps_no_fallback_skipped():
    """无 fallback_labeler → 跳过确认。"""
    labeler = QuestionLabeler(
        llm=_fake_llm_with_suggested_new_kp(),
        prompt="{{question}}\n{{knowledge_points}}",
        knowledge_points=KPS,
    )
    q = RawQuestion(group_order=1, group_id=None, content="题")
    labeled = labeler.label([q], batch_size=1)
    confirmed = labeler.confirm_new_kps(labeled)
    assert confirmed[0]._confirmed_new_kps == []


def test_label_prompt_renders_split_content():
    """选择题拆分成功时，prompt 的 {{content}} 以「题干：/选项A：...」拆分形式
    呈现（完整性检测基于确定性拆分结果，不基于原文排版）。"""
    captured = {}

    class CaptureLLM:
        def complete(self, system, user):
            captured["user"] = user
            return _fake_response(
                '{"type":"choice","difficulty":1,'
                '"knowledge_points":[],"suggested_new_kps":[]}'
            )
    labeler = QuestionLabeler(
        llm=CaptureLLM(),
        prompt="Q:\n{{content}}",
        knowledge_points=KPS,
    )
    q = RawQuestion(
        group_order=3, group_id="一",
        content="如图, 直线 $AB$ 与 $CD$ 相交于点 $O$ , 则 $\\angle AOE$ 的大小为 "
                "(A) $25^{\\circ}$ (B) $35^{\\circ}$ (C) $45^{\\circ}$ (D) $55^{\\circ}$\n"
                "![](images/9630d93f.jpg)",
    )
    labeler.label([q], batch_size=1)
    assert "题干：如图" in captured["user"]
    assert "选项A：$25^{\\circ}$" in captured["user"]
    assert "选项D：$55^{\\circ}$" in captured["user"]
    assert "![](images/9630d93f.jpg)" in captured["user"]  # 题干配图在题干里


def test_label_prompt_keeps_raw_content_when_no_split():
    """非选择题（拆分失败）时，prompt 的 {{content}} 用原文。"""
    captured = {}

    class CaptureLLM:
        def complete(self, system, user):
            captured["user"] = user
            return _fake_response(
                '{"type":"fill_blank","difficulty":1,'
                '"knowledge_points":[],"suggested_new_kps":[],'
                '"completeness":{"is_complete":true,"issues":[]}}'
            )
    labeler = QuestionLabeler(
        llm=CaptureLLM(),
        prompt="Q:\n{{content}}",
        knowledge_points=KPS,
    )
    q = RawQuestion(group_order=9, group_id="二", content="若代数式 $\\frac{1}{x-3}$ 有意义")
    labeler.label([q], batch_size=1)
    assert captured["user"] == "Q:\n若代数式 $\\frac{1}{x-3}$ 有意义"


def test_answer_fabrication_cleared_not_rejected():
    """原文无答案（Python 对齐 answer 为空），LLM 在 regenerated.answer 返回了答案：
    **不判缺陷、不重试**（一次调用通过），但答案被确定性清空——其他字段正常入库。"""
    bad = ('{"type":"short_answer","difficulty":2,"knowledge_points":[],"suggested_new_kps":[],'
           '"completeness":{"is_complete":false,"issues":["题干截断"]},'
           '"regenerated":{"content":"计算: $1+1$","options":null,"answer":"$2$"}}')
    llm = _seq_llm(bad)
    labeler = QuestionLabeler(llm=llm, prompt="{{content}}", knowledge_points=KPS)
    q = RawQuestion(group_order=17, group_id=None, content="计算: $1+1$.", answer="")
    res = labeler.label([q], batch_size=1)
    assert llm.called == 1  # 不重试
    assert res[0].type == "short_answer"
    assert res[0].is_complete is False
    assert res[0].regenerated["answer"] == ""  # 答案被清空，不影响其他字段


def test_validate_allows_keep_existing_answer():
    """原文已有答案时，regenerated.answer 保留原答案不算编造（允许）。"""
    good = ('{"type":"proof","difficulty":3,"knowledge_points":[],"suggested_new_kps":[],'
            '"completeness":{"is_complete":false,"issues":["题干截断"]},'
            '"regenerated":{"content":"求证: AB=CD","options":null,"answer":"$AB=CD$"}}')
    llm = _seq_llm(good)
    labeler = QuestionLabeler(llm=llm, prompt="{{content}}", knowledge_points=KPS)
    q = RawQuestion(group_order=17, group_id=None, content="求证: AB=CD", answer="$AB=CD$")
    res = labeler.label([q], batch_size=1)
    assert res[0].type == "proof"
    assert res[0].is_complete is False
    assert res[0].regenerated["answer"] == "$AB=CD$"


def test_labels_only_retry_when_python_options_complete():
    """Python 已拆出完整 4 选项、LLM 两次都要重写选项 → 第三次只标注，不再整题降级。"""
    content = ("如图, 则 $\\angle AOE$ 的大小为 (A) $25^{\\circ}$ "
               "(B) $35^{\\circ}$ (C) $45^{\\circ}$ (D) $55^{\\circ}$")
    bad = ('{"type":"choice","difficulty":2,"knowledge_points":[],"suggested_new_kps":[],'
           '"completeness":{"is_complete":false,"issues":["选项D内容缺失"]},'
           '"regenerated":{"content":"如图...","options":'
           '[{"label":"A","text":"1"},{"label":"B","text":"2"},'
           '{"label":"C","text":"3"},{"label":"D","text":"(编造)"}]}}')
    # 第三次是「只标注」响应：仍故意带 is_complete=false，验证代码会强制 complete
    llm = _seq_llm(bad, bad, _good_item("choice", complete=False))
    labeler = QuestionLabeler(llm=llm, prompt="{{content}}", knowledge_points=KPS)
    q = RawQuestion(group_order=4, group_id=None, content=content)

    res = labeler.label([q], batch_size=1)

    assert llm.called == 3
    assert res[0] is not None
    assert res[0].type == "choice"
    assert res[0].is_complete is True
    assert res[0].knowledge_points == ["M0101"]


def test_error_log_includes_status_and_body(capsys):
    """APIStatusError 只打类名无法定位（402 余额不足 / 401 key 错），要把 message 带上。"""
    class BoomLLM:
        def complete(self, system, user):
            raise RuntimeError("402 Insufficient Balance")

    labeler = QuestionLabeler(llm=BoomLLM(), prompt="{{content}}", knowledge_points=KPS)
    q = RawQuestion(group_order=1, group_id=None, content="题干")
    labeler.label([q], batch_size=1)

    out = capsys.readouterr().out
    assert "402 Insufficient Balance" in out


def test_chinese_three_options_labels_only_after_fabricated_fourth():
    """语文 3 选项：LLM 两次判不完整并补第 4 项 → 第三次只标注，保留 Python 的 3 项。"""
    content = (
        "阅读全文，下列说法不恰当的一项是（2分）\n"
        "【甲】第②段举北斗卫星团队中青年人的例子，证明了青年人要珍惜时间。\n"
        "【乙】第④段“宝剑锋从磨砺出”论证人生道路上总会遇到荆棘坎坷。\n"
        "【丙】第⑤段引用习近平总书记的话，意在证明奋斗无止境。"
    )
    bad = ('{"type":"choice","difficulty":2,"knowledge_points":[],"suggested_new_kps":[],'
           '"completeness":{"is_complete":false,"issues":["选项不足4个"]},'
           '"regenerated":{"content":"阅读全文...","options":'
           '[{"label":"A","text":"甲"},{"label":"B","text":"乙"},'
           '{"label":"C","text":"丙"},{"label":"D","text":"编造"}]}}')
    llm = _seq_llm(bad, bad, _good_item("choice"))
    labeler = QuestionLabeler(
        llm=llm, prompt="{{content}}", knowledge_points=KPS, subject="chinese",
    )
    q = RawQuestion(group_order=25, group_id=None, content=content)

    res = labeler.label([q], batch_size=1)

    assert llm.called == 3
    assert res[0].type == "choice"
    assert res[0].is_complete is True


def test_chinese_unrepairable_defect_accepted_without_retry():
    """语文画线句丢失属原文缺失型缺陷：只报告不修复，接受标注并标待复核，
    不能重试三次再整题降级（那样会丢知识点）。"""
    item = ('{"type":"short_answer","difficulty":3,"knowledge_points":["M0101"],'
            '"suggested_new_kps":[],"completeness":{"is_complete":false,'
            '"issues":["画线句具体内容缺失，无法定位是哪一句"]}}')
    llm = _seq_llm(item)
    labeler = QuestionLabeler(llm=llm, prompt="{{content}}", knowledge_points=KPS,
                             subject="chinese")
    q = RawQuestion(group_order=5, group_id=None, content="请赏析第⑥段画线句。")

    res = labeler.label([q], batch_size=1)

    assert llm.called == 1                      # 不重试
    assert res[0].is_complete is False          # 缺陷如实保留 → needs_review
    assert res[0].knowledge_points == ["M0101"]  # 知识点没丢
    assert "画线" in res[0].completeness_issues[0]


def test_math_missing_repair_is_still_rejected():
    """数学缺选项属于可修复缺陷：只报告不修复仍判失败，要求重试。"""
    item = ('{"type":"choice","difficulty":2,"knowledge_points":["M0101"],'
            '"suggested_new_kps":[],"completeness":{"is_complete":false,'
            '"issues":["选项D缺失"]}}')
    llm = _seq_llm(item, _good_item("choice"))
    labeler = QuestionLabeler(llm=llm, prompt="{{content}}", knowledge_points=KPS,
                             subject="math")
    q = RawQuestion(group_order=2, group_id=None, content="下列正确的是 A.1 B.2 C.3")

    labeler.label([q], batch_size=1)

    assert llm.called == 2


def test_chinese_material_defect_wins_over_complete_options():
    """Python 已拆出完整选项、LLM 指出缺材料 → 接受 false（标待复核），
    不能用「只标注」把真实材料缺陷抹掉。"""
    content = ("根据链接材料回答问题。\nA.甲句\nB.乙句\nC.丙句")
    item = ('{"type":"choice","difficulty":3,"knowledge_points":["M0101"],'
            '"suggested_new_kps":[],"completeness":{"is_complete":false,'
            '"issues":["缺少链接材料原文，无法作答"]}}')
    llm = _seq_llm(item)
    labeler = QuestionLabeler(llm=llm, prompt="{{content}}", knowledge_points=KPS,
                             subject="chinese")
    q = RawQuestion(group_order=9, group_id=None, content=content)

    res = labeler.label([q], batch_size=1)

    assert llm.called == 1
    assert res[0].is_complete is False
    assert "链接材料" in res[0].completeness_issues[0]


def test_chinese_option_only_defect_still_ignored():
    """Python 已完整拆出选项、LLM 只说选项有问题（说不出具体内容缺陷）→ 以 Python 为准。"""
    content = "下列正确的一项是\nA.甲\nB.乙\nC.丙"
    item = ('{"type":"choice","difficulty":2,"knowledge_points":["M0101"],'
            '"suggested_new_kps":[],"completeness":{"is_complete":false,'
            '"issues":["选项不足4个"]}}')
    llm = _seq_llm(item, _good_item("choice"))
    labeler = QuestionLabeler(llm=llm, prompt="{{content}}", knowledge_points=KPS,
                             subject="chinese")
    q = RawQuestion(group_order=4, group_id=None, content=content)

    res = labeler.label([q], batch_size=1)

    assert llm.called == 2          # 第一次被拒，重试后按完整处理
    assert res[0].is_complete is True


def test_chinese_option_truncation_not_treated_as_material_defect():
    """「选项C截断/缺少D」是选项类问题：语文 3 项合法，以 Python 拆分为准，
    不能被当成材料缺陷标成待复核。"""
    content = "翻译文中三处画线语句，有误的一项是\nA.甲\nB.乙\nC.丙"
    item = ('{"type":"choice","difficulty":3,"knowledge_points":["M0101"],'
            '"suggested_new_kps":[],"completeness":{"is_complete":false,'
            '"issues":["选项C的内容在‘滁人游也’后截断","缺少选项D"]}}')
    llm = _seq_llm(item, _good_item("choice"))
    labeler = QuestionLabeler(llm=llm, prompt="{{content}}", knowledge_points=KPS,
                             subject="chinese")
    q = RawQuestion(group_order=11, group_id=None, content=content)

    res = labeler.label([q], batch_size=1)

    assert llm.called == 2
    assert res[0].is_complete is True


def test_true_false_statement_without_question_is_complete():
    """判断题的题干就是一句陈述，LLM 判「缺设问」是误判，不能因此 is_active=0。

    事故（2026-11-06 海淀道法）：10 道判断题里 8 道被判「题干缺失具体设问」，
    全部 needs_review → is_active=0，学生端整卷少 8 题。
    """
    item = ('{"type":"true_false","difficulty":1,"knowledge_points":[],'
            '"suggested_new_kps":[],'
            '"completeness":{"is_complete":false,'
            '"issues":["题干缺失具体设问（如判断正误），仅包含陈述性文字"]}}')
    llm = _seq_llm(item)  # 只给一次：若走重试会耗尽抛错
    labeler = QuestionLabeler(llm=llm, prompt="{{content}}", knowledge_points=KPS,
                              subject="politics")
    q = RawQuestion(group_order=1, group_id="一",
                    content="伟大建党精神是全党全国各族人民攻坚克难、奋勇前行的强大精神动力。")
    res = labeler.label([q], batch_size=1)
    assert llm.called == 1
    assert res[0].type == "true_false"
    assert res[0].is_complete is True
    assert res[0].completeness_issues == []


def test_true_false_empty_or_truncated_stays_incomplete():
    """真缺陷仍然拦：题干几乎为空、或明显截断（结尾停在逗号/括号）→ 保持待复核。"""
    item = ('{"type":"true_false","difficulty":1,"knowledge_points":[],'
            '"suggested_new_kps":[],'
            '"completeness":{"is_complete":false,"issues":["题干截断"]}}')
    for content in ("。", "", "发展是执政兴国的第一要务，"):
        labeler = QuestionLabeler(llm=_seq_llm(item), prompt="{{content}}",
                                  knowledge_points=KPS, subject="politics")
        q = RawQuestion(group_order=2, group_id="一", content=content)
        res = labeler.label([q], batch_size=1)
        assert res[0].is_complete is False, content


def test_true_false_with_image_is_complete():
    """带图的判断题（看图判断）也算完整，文字少不等于截断。"""
    item = ('{"type":"true_false","difficulty":2,"knowledge_points":[],'
            '"suggested_new_kps":[],'
            '"completeness":{"is_complete":false,"issues":["无法校验图片内容"]}}')
    labeler = QuestionLabeler(llm=_seq_llm(item), prompt="{{content}}",
                              knowledge_points=KPS, subject="politics")
    q = RawQuestion(group_order=3, group_id="一",
                    content="![](images/q3.jpg)")
    res = labeler.label([q], batch_size=1)
    assert res[0].is_complete is True


def test_true_false_exemption_applies_after_section_typing():
    """按大题定型后才变成 true_false 的题也要放行（LLM 常把判断题标成 short_answer）。"""
    from question_labeler import apply_true_false_exemption

    lab = LabeledQuestion.from_raw(RawQuestion(
        group_order=1, group_id="一",
        content="伟大建党精神是全党全国各族人民攻坚克难、奋勇前行的强大精神动力。"))
    lab.type = "short_answer"            # 标注阶段模型给错
    lab.is_complete = False
    lab.completeness_issues = ["题干缺失具体设问"]

    assert apply_true_false_exemption([lab]) == 0      # 还不是判断题，不动
    assert lab.is_complete is False

    lab.type = "true_false"               # 按大题定型后
    assert apply_true_false_exemption([lab]) == 1
    assert lab.is_complete is True
    assert lab.completeness_issues == []


def test_material_subq_claim_is_checked_against_content():
    """LLM 说「仅包含第(1)问」但 content 里有 (2) → 误判放行。

    事故（2026-11-06 海淀道法题26，14 分）：材料 + 两个小问都在，
    LLM 判「仅包含第(1)问的题干、缺失第(2)问」→ is_active=0，整题消失。
    """
    from question_labeler import apply_material_subq_exemption

    lab = LabeledQuestion.from_raw(RawQuestion(
        group_order=26, group_id=None,
        content="(1) 任选两件展品完成推荐理由。(8 分)\n(2) 撰写观展心得。(6 分)"))
    lab.material_text = "展馆研学材料……"
    lab.is_complete = False
    lab.completeness_issues = [
        "题目切分不完整：仅包含第(1)问的题干，缺失第(2)问的题干及设问要求。"]
    assert apply_material_subq_exemption([lab]) == 1
    assert lab.is_complete is True and lab.completeness_issues == []


def test_material_missing_source_is_not_exempted():
    """材料里确实没有分段（真缺素材）时仍拦，不能因为「题型是材料题」就放过。"""
    from question_labeler import apply_material_sections_exemption

    lab = LabeledQuestion.from_raw(RawQuestion(
        group_order=28, group_id=None,
        content="(1) 请将三段视频素材排序。(4分)\n(2) 续写旁白。(6分)"))
    lab.material_text = "同学们收集到关于文化篇的相关素材……"
    lab.is_complete = False
    lab.completeness_issues = ["题干中缺失具体的三段视频素材内容（通常以①②③列出）"]
    assert apply_material_sections_exemption([lab]) == 0
    assert lab.is_complete is False


def test_material_three_sections_is_complete():
    """材料已是三段文字（视频脚本），LLM 还要求 ①②③ 编号就是误判。

    2026-11-06 海淀道法题 28：「今日答卷 / 昔日之问 / 思想领航」三段就是被排序的素材，
    原文没有真正的视频，也没有 ①②③ 标号。
    """
    from question_labeler import apply_material_sections_exemption

    lab = LabeledQuestion.from_raw(RawQuestion(
        group_order=28, group_id=None,
        content="(1) 请将三段视频素材排序。(4分)\n(2) 续写旁白。(6分)"))
    lab.material_text = (
        "## 今日答卷\n三大文化地标落成……\n"
        "## 昔日之问\n戏迷小张：早年优秀的展览要远赴中心城区观看……\n"
        "## 思想领航\n规划建设北京城市副中心……")
    lab.is_complete = False
    lab.completeness_issues = [
        "题干中要求填写‘序号’，但材料部分未明确标出今日答卷、昔日之问、思想领航三段素材对应的具体序号"]
    assert apply_material_sections_exemption([lab]) == 1
    assert lab.is_complete is True and lab.completeness_issues == []


def test_kp_only_issue_is_not_a_content_defect():
    """「知识点列表为空」是配置状态，不能因此把整题隐藏（道法题26实测）。"""
    from question_labeler import apply_kp_issue_exemption

    lab = LabeledQuestion.from_raw(RawQuestion(
        group_order=26, group_id=None, content="(1) 小问\n(2) 小问"))
    lab.is_complete = False
    lab.completeness_issues = ["知识点列表为空，无法匹配已有知识点 code"]
    assert apply_kp_issue_exemption([lab]) == 1
    assert lab.is_complete is True

    lab2 = LabeledQuestion.from_raw(RawQuestion(
        group_order=27, group_id=None, content="题干"))
    lab2.is_complete = False
    lab2.completeness_issues = ["知识点列表为空", "题干截断"]
    assert apply_kp_issue_exemption([lab2]) == 0
    assert lab2.is_complete is False


def test_material_subq_exemption_does_not_clear_source_issues():
    """「缺素材」不是「缺小问」，两条豁免各管各的，不能互相放过。"""
    from question_labeler import apply_material_subq_exemption

    lab = LabeledQuestion.from_raw(RawQuestion(
        group_order=28, group_id=None,
        content="(1) 请将三段视频素材排序。(4分)\n(2) 续写旁白。(6分)"))
    lab.material_text = "同学们收集到关于文化篇的相关素材……"
    lab.is_complete = False
    lab.completeness_issues = ["题干中缺失具体的三段视频素材内容（通常以①②③列出）"]
    assert apply_material_subq_exemption([lab]) == 0
    assert lab.is_complete is False
