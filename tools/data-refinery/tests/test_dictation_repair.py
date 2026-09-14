"""dictation_repair 单测：全部用假 LLM，不碰网络。

本模块按用户 2026-09-14 裁决**故意不设采纳闸门**（模型输出即采用），所以测试钉的是：
模型选择顺序（本地优先 → ds flash 兜底）、输出清理（围栏/角标）、
「两者皆无数值输出才 fail-closed」，以及 residual 只提示不阻断。
"""

from dictation_repair import _strip_fence, build_user_prompt, repair_body
from llm import LLMResponse

# 一段能通过 check_body(genre="wen") 的正文（无注释标记/无 $/无竖线/括号配平/够长）
GOOD = (
    "庆历四年春，滕子京谪守巴陵郡。越明年，政通人和，百废具兴。"
    "乃重修岳阳楼，增其旧制，刻唐贤今人诗赋于其上。属予作文以记之。"
    "时六年九月十五日。"
)

# 自检会报错的原始正文（含未删净的角标 $）
BROKEN = GOOD.replace("时六年九月十五日。", "时六年 $^{①}$ 九月十五日。")
BROKEN_ERRORS = ["正文含 $（行内注释角标未删净）"]


class FakeLLM:
    """最小 LLM 替身：记下调用、按脚本返回内容或抛错。"""

    def __init__(self, model, content=None, error=None):
        self.model = model
        self._content = content
        self._error = error
        self.calls = []

    def complete(self, system_prompt, user_prompt):
        self.calls.append((system_prompt, user_prompt))
        if self._error is not None:
            raise self._error
        return LLMResponse(content=self._content, prompt_tokens=0, completion_tokens=0)


def _repair(primary, fallback=None, body=BROKEN, errors=None, title="岳阳楼记", genre="wen"):
    return repair_body(
        primary, fallback,
        body=body, work_title=title, author="范仲淹", dynasty="北宋",
        genre=genre, errors=errors or BROKEN_ERRORS, chrome=set(), prompt="SYS",
    )


class TestStripFence:
    def test_strips_plain_fence(self):
        assert _strip_fence("```\n正文\n```") == "正文"

    def test_strips_fence_with_language(self):
        assert _strip_fence("```text\n正文\n```") == "正文"

    def test_leaves_unfenced_text_alone(self):
        assert _strip_fence("正文") == "正文"

    def test_keeps_inner_backticks(self):
        # 只在最外层是一对围栏时才剥；正文里出现反引号不当作围栏
        assert _strip_fence("正文 `x` 结束") == "正文 `x` 结束"


class TestBuildUserPrompt:
    def test_carries_title_author_errors_and_body(self):
        prompt = build_user_prompt(BROKEN, "岳阳楼记", "范仲淹", "北宋", "wen", BROKEN_ERRORS)
        assert "岳阳楼记" in prompt
        assert "范仲淹" in prompt
        assert "北宋" in prompt
        assert BROKEN_ERRORS[0] in prompt
        assert BROKEN in prompt

    def test_tolerates_missing_metadata(self):
        prompt = build_user_prompt(BROKEN, "", "", "", "wen", BROKEN_ERRORS)
        assert "（未知）" in prompt


class TestRepairBody:
    def test_primary_output_is_adopted(self):
        primary = FakeLLM("fake-local", content=GOOD)
        r = _repair(primary)
        assert r.body == GOOD
        assert r.source == "local:fake-local"
        assert r.residual == []

    def test_fence_wrapped_output_is_accepted(self):
        primary = FakeLLM("fake-local", content=f"```\n{GOOD}\n```")
        assert _repair(primary).body == GOOD

    def test_inline_markers_are_stripped_from_model_output(self):
        # 模型抄回角标 → 必须被 normalize_body 清掉，否则学生答题永远判不等
        primary = FakeLLM("fake-local", content=GOOD.replace("九月十五日。", "$^{②}$九月十五日。"))
        r = _repair(primary)
        assert "$" not in r.body
        assert "$^{" not in r.body

    def test_whitespace_collapsed_like_sliced_body(self):
        primary = FakeLLM("fake-local", content=GOOD.replace("越明年，", "越明年，\n\n"))
        assert "\n" not in _repair(primary).body

    def test_primary_raises_falls_back(self):
        primary = FakeLLM("fake-local", error=RuntimeError("connection refused"))
        fallback = FakeLLM("deepseek-flash", content=GOOD)
        r = _repair(primary, fallback)
        assert r.body == GOOD
        assert r.source == "fallback:deepseek-flash"
        assert "调用失败" in r.attempts[0]

    def test_primary_empty_falls_back(self):
        primary = FakeLLM("fake-local", content="   ")
        fallback = FakeLLM("deepseek-flash", content=GOOD)
        r = _repair(primary, fallback)
        assert r.source == "fallback:deepseek-flash"
        assert "输出为空" in r.attempts[0]

    def test_both_fail_returns_none_fail_closed(self):
        primary = FakeLLM("fake-local", error=RuntimeError("boom"))
        fallback = FakeLLM("deepseek-flash", error=RuntimeError("also boom"))
        r = _repair(primary, fallback)
        assert r.body is None
        assert r.source is None
        assert len(r.attempts) == 2
        assert "fail-closed" in r.note

    def test_no_fallback_configured_only_primary_tried(self):
        primary = FakeLLM("fake-local", error=RuntimeError("boom"))
        r = _repair(primary, None)
        assert r.body is None
        assert len(r.attempts) == 1

    def test_primary_untouched_when_it_succeeds(self):
        # 本地成功时不应白白调用兜底模型（用户要求：本地优先）
        primary = FakeLLM("fake-local", content=GOOD)
        fallback = FakeLLM("deepseek-flash", content=GOOD)
        _repair(primary, fallback)
        assert len(primary.calls) == 1
        assert fallback.calls == []

    def test_short_repair_is_adopted_not_blocked(self):
        # 用户明确要求去掉长度护栏：本篇自检报「过短」，模型补长后必须被采用
        short = "庆历四年春，滕子京谪守巴陵郡。"
        primary = FakeLLM("fake-local", content=GOOD)
        r = _repair(primary, body=short, errors=["正文过短（14 字，低于 wen 的下限）"])
        assert r.body == GOOD

    def test_residual_reported_but_does_not_block(self):
        # 纠正稿仍带落单括号（自检报错）→ 照样采用，只把问题记进 residual 供人工看
        primary = FakeLLM("fake-local", content=GOOD + "（")
        r = _repair(primary)
        assert r.body == GOOD + "（"
        assert any("不配平" in reason for reason in r.residual)
        assert "纠正后自检仍报" in r.attempts[-1]

    def test_note_carries_model_and_lengths(self):
        primary = FakeLLM("fake-local", content=GOOD)
        note = _repair(primary).note
        assert "local:fake-local" in note
        assert str(len(BROKEN)) in note and str(len(GOOD)) in note
