from card_labeler import CardLabeler, LabelResult, _split_groups_if_needed


def test_label_result_parses_groups_for_practice():
    fake_response = type("R", (), {"content": '{"page_type":"practice","items":[{"card_type":"practice","lesson_id":null,"title":null,"textbook_page":"P11","groups":[{"intro":"解下列方程：","questions":[{"n":1,"text":"(1) $5x^{2}-1=4x$"},{"n":2,"text":"(2) $4x^{2}=81$"}]}]}]}'})()

    class FakeLLM:
        def complete(self, system, user):
            return fake_response

    labeler = CardLabeler(llm=FakeLLM(), prompt_template="p")
    result = labeler.label(["(1) $5x^{2}-1=4x$ ; (2) $4x^{2}=81$ ;"], "P11")
    assert result.page_type == "practice"
    assert result.labels[0].card_type == "practice"
    assert result.labels[0].groups is not None
    assert len(result.labels[0].groups) == 1
    assert result.labels[0].groups[0]["intro"] == "解下列方程："
    assert len(result.labels[0].groups[0]["questions"]) == 2
    assert result.labels[0].groups[0]["questions"][0]["n"] == 1
    assert result.labels[0].groups[0]["questions"][0]["text"] == "(1) $5x^{2}-1=4x$"


def test_multi_group_practice():
    """多 group（多题干各自带题）：两组各自有 intro 和 questions"""
    fake_response = type("R", (), {"content": '{"page_type":"practice","items":[{"card_type":"practice","lesson_id":null,"title":null,"textbook_page":"P11","groups":[{"intro":"1. 解方程：","questions":[{"n":1,"text":"(1) $5x^{2}-1=4x$"},{"n":2,"text":"(2) $y^{2}=16$"}]},{"intro":"2. 列方程：","questions":[{"n":1,"text":"(1) 4个正方形面积之和是25"},{"n":2,"text":"(2) 矩形长比宽多2"}]}]}]}'})()

    class FakeLLM:
        def complete(self, system, user):
            return fake_response

    labeler = CardLabeler(llm=FakeLLM(), prompt_template="p")
    result = labeler.label(["题"], "P11")
    groups = result.labels[0].groups
    assert groups is not None
    assert len(groups) == 2
    # 第一组
    assert groups[0]["intro"] == "1. 解方程："
    assert len(groups[0]["questions"]) == 2
    assert groups[0]["questions"][0]["n"] == 1
    assert groups[0]["questions"][0]["text"] == "(1) $5x^{2}-1=4x$"
    assert groups[0]["questions"][1]["n"] == 2
    # 第二组（n 从 1 重新开始，组内独立编号）
    assert groups[1]["intro"] == "2. 列方程："
    assert len(groups[1]["questions"]) == 2
    assert groups[1]["questions"][0]["n"] == 1
    assert groups[1]["questions"][0]["text"] == "(1) 4个正方形面积之和是25"
    assert groups[1]["questions"][1]["n"] == 2


def test_group_with_no_intro():
    """group 缺少 intro 或 intro 为 null 时，intro 归一为 None"""
    fake_response = type("R", (), {"content": '{"page_type":"practice","items":[{"card_type":"practice","lesson_id":null,"title":null,"textbook_page":"P11","groups":[{"questions":[{"n":1,"text":"(1) $x^{2}=4$"}]},{"intro":null,"questions":[{"n":1,"text":"(1) $y^{2}=9$"}]}]}]}'})()

    class FakeLLM:
        def complete(self, system, user):
            return fake_response

    labeler = CardLabeler(llm=FakeLLM(), prompt_template="p")
    result = labeler.label(["题"], "P11")
    groups = result.labels[0].groups
    assert groups is not None
    assert len(groups) == 2
    # 第一组：intro 字段缺失
    assert groups[0]["intro"] is None
    assert len(groups[0]["questions"]) == 1
    # 第二组：intro 显式为 null
    assert groups[1]["intro"] is None
    assert len(groups[1]["questions"]) == 1


def test_label_result_groups_none_for_non_practice():
    fake_response = type("R", (), {"content": '{"page_type":"content","items":[{"card_type":"concept","lesson_id":"26.1","title":"概念","textbook_page":"P8"}]}'})()

    class FakeLLM:
        def complete(self, system, user):
            return fake_response

    labeler = CardLabeler(llm=FakeLLM(), prompt_template="p")
    result = labeler.label(["概念文字"], "P8")
    assert result.labels[0].groups is None


class TestTocLabelsInjection:
    """toc_labels 注入：合法 lesson_id 列表拼进 user_message，LLM 优先逐字复制。"""

    @staticmethod
    def _make_labeler(captured):
        fake_response = type("R", (), {"content": '{"page_type":"content","items":[{"card_type":"concept","lesson_id":"26.1 反比例函数","title":null,"textbook_page":"P8"}]}'})()

        class FakeLLM:
            def complete(self, system, user):
                captured.append((system, user))
                return fake_response

        return CardLabeler(llm=FakeLLM(), prompt_template="p")

    def test_toc_labels_appended_to_user_message(self):
        captured = []
        labeler = self._make_labeler(captured)
        labeler.label(["概念文字"], "P8", toc_labels=["26.1 反比例函数", "26.1.1 反比例函数"])
        assert len(captured) == 1
        user = captured[0][1]
        assert "Legal lesson_id list" in user
        assert "- 26.1 反比例函数" in user
        assert "- 26.1.1 反比例函数" in user

    def test_no_toc_labels_no_list(self):
        captured = []
        labeler = self._make_labeler(captured)
        labeler.label(["概念文字"], "P8")
        user = captured[0][1]
        assert "Legal lesson_id list" not in user

    def test_empty_toc_labels_no_list(self):
        captured = []
        labeler = self._make_labeler(captured)
        labeler.label(["概念文字"], "P8", toc_labels=[])
        assert "Legal lesson_id list" not in captured[0][1]

    def test_long_list_truncated(self):
        captured = []
        labeler = self._make_labeler(captured)
        labels = [f"26.{i} 第{i}节" for i in range(1, 305)]
        labeler.label(["概念文字"], "P8", toc_labels=labels)
        user = captured[0][1]
        assert "- 26.300 第300节" in user
        assert "- 26.304 第304节" not in user
        assert "已截断" in user


def test_label_result_skips_question_with_null_text():
    """text:null 的题应跳过，不产出 'None' 字符串"""
    fake_response = type("R", (), {"content": '{"page_type":"practice","items":[{"card_type":"practice","lesson_id":null,"title":null,"textbook_page":"P11","groups":[{"intro":null,"questions":[{"n":1,"text":null},{"n":2,"text":"(2) $4x^{2}=81$"}]}]}]}'})()

    class FakeLLM:
        def complete(self, system, user):
            return fake_response

    labeler = CardLabeler(llm=FakeLLM(), prompt_template="p")
    result = labeler.label(["题"], "P11")
    groups = result.labels[0].groups
    assert groups is not None
    assert len(groups) == 1
    assert len(groups[0]["questions"]) == 1
    assert groups[0]["questions"][0]["text"] == "(2) $4x^{2}=81$"


def test_label_result_handles_non_dict_question_elements():
    """非 dict 元素（如裸数字/字符串）不应导致整页崩溃"""
    fake_response = type("R", (), {"content": '{"page_type":"practice","items":[{"card_type":"practice","lesson_id":null,"title":null,"textbook_page":"P11","groups":[{"intro":null,"questions":[1, "(2)", {"n":1,"text":"(1) $5x^{2}-1=4x$"}]}]}]}'})()

    class FakeLLM:
        def complete(self, system, user):
            return fake_response

    labeler = CardLabeler(llm=FakeLLM(), prompt_template="p")
    result = labeler.label(["题"], "P11")
    groups = result.labels[0].groups
    assert groups is not None
    assert len(groups) == 1
    assert len(groups[0]["questions"]) == 1
    assert groups[0]["questions"][0]["n"] == 1


def test_label_result_empty_groups_list_distinct_from_none():
    """groups: []（所有组无有效题）得到 None，区别于非 practice 卡的 None"""
    fake_response = type("R", (), {"content": '{"page_type":"practice","items":[{"card_type":"practice","lesson_id":null,"title":null,"textbook_page":"P11","groups":[{"intro":null,"questions":[]}]}]}'})()

    class FakeLLM:
        def complete(self, system, user):
            return fake_response

    labeler = CardLabeler(llm=FakeLLM(), prompt_template="p")
    result = labeler.label(["题"], "P11")
    # 组内无有效题 -> 组被跳过 -> groups 为 None
    assert result.labels[0].groups is None


def test_label_result_skips_invalid_n():
    """n 为非整数或非正（n<1）的题应跳过"""
    fake_response = type("R", (), {"content": '{"page_type":"practice","items":[{"card_type":"practice","lesson_id":null,"title":null,"textbook_page":"P11","groups":[{"intro":null,"questions":[{"n":"abc","text":"bad"},{"n":0,"text":"zero"},{"n":-1,"text":"neg"},{"n":1,"text":"(1) $5x^{2}-1=4x$"}]}]}]}'})()

    class FakeLLM:
        def complete(self, system, user):
            return fake_response

    labeler = CardLabeler(llm=FakeLLM(), prompt_template="p")
    result = labeler.label(["题"], "P11")
    groups = result.labels[0].groups
    assert groups is not None
    assert len(groups) == 1
    assert len(groups[0]["questions"]) == 1
    assert groups[0]["questions"][0]["n"] == 1


def test_label_result_ignores_groups_for_non_practice_card():
    """非 practice 卡即使 LLM 误返 groups 字段也应忽略（防御纵深）"""
    fake_response = type("R", (), {"content": '{"page_type":"content","items":[{"card_type":"concept","lesson_id":"26.1","title":"概念","textbook_page":"P8","groups":[{"intro":"不应出现","questions":[{"n":1,"text":"不应出现"}]}]}]}'})()

    class FakeLLM:
        def complete(self, system, user):
            return fake_response

    labeler = CardLabeler(llm=FakeLLM(), prompt_template="p")
    result = labeler.label(["概念文字"], "P8")
    assert result.labels[0].groups is None


def test_label_result_handles_non_dict_group_elements():
    """groups 数组中的非 dict 元素（如裸数字/字符串）应跳过不崩溃"""
    fake_response = type("R", (), {"content": '{"page_type":"practice","items":[{"card_type":"practice","lesson_id":null,"title":null,"textbook_page":"P11","groups":[1, "str", {"intro":"有效","questions":[{"n":1,"text":"(1) $x=1$"}]}]}]}'})()

    class FakeLLM:
        def complete(self, system, user):
            return fake_response

    labeler = CardLabeler(llm=FakeLLM(), prompt_template="p")
    result = labeler.label(["题"], "P11")
    groups = result.labels[0].groups
    assert groups is not None
    assert len(groups) == 1
    assert groups[0]["intro"] == "有效"
    assert len(groups[0]["questions"]) == 1


# ===== _split_groups_if_needed 程序化兜底测试 =====

def test_split_groups_multiple_stems_in_intro():
    """Case 1: intro 含两个编号大题 -> 按大题位置拆分（ID=442 模式）"""
    content = (
        "1. 将下列方程化成一元二次方程的一般形式：\n"
        "(1) $3x^{2}+1=6x$ ; (2) $4x^{2}+5x=81$ ;\n"
        "(3) $x(x+5)=0;$ (4) $(2x-2)(x-1)=0;$ (5) $x(x+5)=5x-10;$ (6) $(3x-2)(x+1)=x(2x-1).$\n\n"
        "2. 根据下列问题列方程：\n\n"
        "(1) 一个圆的面积是 $2\\pi \\, m^{2}$"
    )
    # LLM 把两组塞进一个 group
    single_group = [{
        "intro": "1. 将下列方程化成一元二次方程的一般形式：\n2. 根据下列问题列方程：",
        "questions": [
            {"n": 1, "text": "(1) $3x^{2}+1=6x$"},
            {"n": 2, "text": "(2) $4x^{2}+5x=81$"},
            {"n": 3, "text": "(3) $x(x+5)=0;$"},
            {"n": 4, "text": "(4) $(2x-2)(x-1)=0;$"},
            {"n": 5, "text": "(5) $x(x+5)=5x-10;$"},
            {"n": 6, "text": "(6) $(3x-2)(x+1)=x(2x-1).$"},
            {"n": 1, "text": "(1) 一个圆的面积是 $2\\pi \\, m^{2}$"},
        ],
    }]
    result = _split_groups_if_needed(single_group, content)
    assert len(result) == 2
    assert "1. 将下列方程" in result[0]["intro"]
    assert len(result[0]["questions"]) == 6
    assert "2. 根据下列问题" in result[1]["intro"]
    assert len(result[1]["questions"]) == 1


def test_split_groups_questions_before_intro():
    """Case 2: 部分 question 在原文中出现在 intro 之前 -> 拆为前组+后组（ID=443 模式）"""
    content = (
        "（2）一个直角三角形求较长的直角边的长.3.下列哪些数是方程 $x^{2} + x - 12 = 0$ 的根？\n\n"
        "## 综合运用\n\n"
        "根据下列问题列方程（第4～6题）：\n\n"
        "4. 一个矩形的长比宽多 $1\\mathrm{cm}$\n\n"
        "5. 有一根铁丝围成矩形\n\n"
        "6. 参加聚会握手10次"
    )
    # LLM 把所有题塞进一个 group，intro 是第 4-6 题的说明
    single_group = [{
        "intro": "根据下列问题列方程（第4～6题）：",
        "questions": [
            {"n": 2, "text": "（2）一个直角三角形求较长的直角边的长."},
            {"n": 3, "text": "3.下列哪些数是方程 $x^{2} + x - 12 = 0$ 的根？"},
            {"n": 4, "text": "4. 一个矩形的长比宽多 $1\\mathrm{cm}$"},
            {"n": 5, "text": "5. 有一根铁丝围成矩形"},
            {"n": 6, "text": "6. 参加聚会握手10次"},
        ],
    }]
    result = _split_groups_if_needed(single_group, content)
    assert len(result) == 2
    # 前组：无 intro，含 (2) 和 3
    assert result[0]["intro"] is None
    assert len(result[0]["questions"]) == 2
    # 后组：有 intro，含 4, 5, 6
    assert "根据下列问题" in result[1]["intro"]
    assert len(result[1]["questions"]) == 3


def test_split_groups_no_split_when_single_stem():
    """单个大题不需要拆分"""
    content = "解下列方程：\n(1) $x^{2}=4$\n(2) $y^{2}=9$"
    single_group = [{
        "intro": "解下列方程：",
        "questions": [
            {"n": 1, "text": "(1) $x^{2}=4$"},
            {"n": 2, "text": "(2) $y^{2}=9$"},
        ],
    }]
    result = _split_groups_if_needed(single_group, content)
    assert len(result) == 1  # 原样返回


def test_split_groups_no_split_when_already_multiple():
    """已有多个 group 时不触发拆分"""
    groups = [
        {"intro": "1. 解方程：", "questions": [{"n": 1, "text": "(1) x=1"}]},
        {"intro": "2. 列方程：", "questions": [{"n": 1, "text": "(1) y=2"}]},
    ]
    result = _split_groups_if_needed(groups, "some content")
    assert result is groups  # 原样返回


def test_split_groups_none_or_empty():
    """None 或空 groups 原样返回"""
    assert _split_groups_if_needed(None, "content") is None
    assert _split_groups_if_needed([], "content") == []
