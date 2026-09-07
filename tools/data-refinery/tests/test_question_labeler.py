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
