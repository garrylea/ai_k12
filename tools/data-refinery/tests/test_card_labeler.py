from card_labeler import CardLabeler, LabelResult, QuestionMarker


def test_label_result_parses_questions_for_practice():
    fake_response = type("R", (), {"content": '{"page_type":"practice","items":[{"card_type":"practice","lesson_id":null,"title":null,"textbook_page":"P11","intro":"解下列方程：","questions":[{"n":1,"text":"(1) $5x^{2}-1=4x$"},{"n":2,"text":"(2) $4x^{2}=81$"}]}]}'})()

    class FakeLLM:
        def complete(self, system, user):
            return fake_response

    labeler = CardLabeler(llm=FakeLLM(), prompt_template="p")
    result = labeler.label(["(1) $5x^{2}-1=4x$ ; (2) $4x^{2}=81$ ;"], "P11")
    assert result.page_type == "practice"
    assert result.labels[0].card_type == "practice"
    assert result.labels[0].intro == "解下列方程："
    assert len(result.labels[0].questions) == 2
    assert result.labels[0].questions[0].n == 1
    assert result.labels[0].questions[0].text == "(1) $5x^{2}-1=4x$"


def test_label_result_questions_none_for_non_practice():
    fake_response = type("R", (), {"content": '{"page_type":"content","items":[{"card_type":"concept","lesson_id":"26.1","title":"概念","textbook_page":"P8"}]}'})()

    class FakeLLM:
        def complete(self, system, user):
            return fake_response

    labeler = CardLabeler(llm=FakeLLM(), prompt_template="p")
    result = labeler.label(["概念文字"], "P8")
    assert result.labels[0].questions is None


def test_label_result_skips_question_with_null_text():
    """text:null 的题应跳过，不产出 'None' 字符串"""
    fake_response = type("R", (), {"content": '{"page_type":"practice","items":[{"card_type":"practice","lesson_id":null,"title":null,"textbook_page":"P11","questions":[{"n":1,"text":null},{"n":2,"text":"(2) $4x^{2}=81$"}]}]}'})()

    class FakeLLM:
        def complete(self, system, user):
            return fake_response

    labeler = CardLabeler(llm=FakeLLM(), prompt_template="p")
    result = labeler.label(["题"], "P11")
    assert result.labels[0].questions is not None
    assert len(result.labels[0].questions) == 1
    assert result.labels[0].questions[0].text == "(2) $4x^{2}=81$"


def test_label_result_handles_non_dict_question_elements():
    """非 dict 元素（如裸数字/字符串）不应导致整页崩溃"""
    fake_response = type("R", (), {"content": '{"page_type":"practice","items":[{"card_type":"practice","lesson_id":null,"title":null,"textbook_page":"P11","questions":[1, "(2)", {"n":1,"text":"(1) $5x^{2}-1=4x$"}]}]}'})()

    class FakeLLM:
        def complete(self, system, user):
            return fake_response

    labeler = CardLabeler(llm=FakeLLM(), prompt_template="p")
    result = labeler.label(["题"], "P11")
    assert result.labels[0].questions is not None
    assert len(result.labels[0].questions) == 1
    assert result.labels[0].questions[0].n == 1


def test_label_result_empty_questions_list_distinct_from_none():
    """questions: [] 得到空列表 []，区别于 None（非 practice 或无字段）"""
    fake_response = type("R", (), {"content": '{"page_type":"practice","items":[{"card_type":"practice","lesson_id":null,"title":null,"textbook_page":"P11","questions":[]}]}'})()

    class FakeLLM:
        def complete(self, system, user):
            return fake_response

    labeler = CardLabeler(llm=FakeLLM(), prompt_template="p")
    result = labeler.label(["题"], "P11")
    assert result.labels[0].questions is not None
    assert result.labels[0].questions == []


def test_label_result_skips_invalid_n():
    """n 为非整数或非正（n<1）的题应跳过"""
    fake_response = type("R", (), {"content": '{"page_type":"practice","items":[{"card_type":"practice","lesson_id":null,"title":null,"textbook_page":"P11","questions":[{"n":"abc","text":"bad"},{"n":0,"text":"zero"},{"n":-1,"text":"neg"},{"n":1,"text":"(1) $5x^{2}-1=4x$"}]}]}'})()

    class FakeLLM:
        def complete(self, system, user):
            return fake_response

    labeler = CardLabeler(llm=FakeLLM(), prompt_template="p")
    result = labeler.label(["题"], "P11")
    assert result.labels[0].questions is not None
    assert len(result.labels[0].questions) == 1
    assert result.labels[0].questions[0].n == 1


def test_label_result_ignores_questions_for_non_practice_card():
    """非 practice 卡即使 LLM 误返 questions/intro 字段也应忽略（防御纵深）"""
    fake_response = type("R", (), {"content": '{"page_type":"content","items":[{"card_type":"concept","lesson_id":"26.1","title":"概念","textbook_page":"P8","intro":"不应出现","questions":[{"n":1,"text":"不应出现"}]}]}'})()

    class FakeLLM:
        def complete(self, system, user):
            return fake_response

    labeler = CardLabeler(llm=FakeLLM(), prompt_template="p")
    result = labeler.label(["概念文字"], "P8")
    assert result.labels[0].questions is None
    assert result.labels[0].intro is None
