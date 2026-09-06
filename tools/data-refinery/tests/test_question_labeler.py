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
                '"knowledge_points":["M0101"],"suggested_new_kps":[]}'
            )
    return FakeLLM()


def _fake_llm_with_suggested_new_kp():
    """mock LLM：输出一个 suggested_new_kp。"""
    class FakeLLM:
        def complete(self, system, user):
            return _fake_response(
                '{"type":"short_answer","difficulty":3,'
                '"knowledge_points":["M0302"],"suggested_new_kps":["新知识点X"]}'
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
                '"knowledge_points":[],"suggested_new_kps":[]}'
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


def test_label_llm_failure_returns_empty_fields():
    """LLM 抛异常时该题 type=""、knowledge_points=[]，不影响其他题。"""
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
    assert labeled[0].type == ""
    assert labeled[0].knowledge_points == []
