"""interpretation_translate 单测：译文生成（假模型，不调真 LLM）。

关键约定：
- **模型只填 translation，不产出 text** —— 回来按编号取译文，多给的原文一概忽略；
- **不做部分采用** —— 条数不符/有空译文/整篇为空都整体弃用换下一个模型；
- 两个模型都不合规 → 返回 `translations=None`，由调用方 fail-closed。
"""

import json

from interpretation_translate import build_user_prompt, translate_passage

SENTENCES = ["庆历四年春，滕子京谪守巴陵郡。", "越明年，政通人和。"]
TERMS = [{"term": "谪守", "gloss": "因罪贬谪流放", "sentenceIndex": 0}]


class _FakeLLM:
    def __init__(self, content=None, raises=None, model="fake"):
        self._content = content
        self._raises = raises
        self.model = model
        self.calls = 0

    def complete(self, system_prompt, user_prompt):
        self.calls += 1
        if self._raises:
            raise self._raises

        class R:
            pass

        r = R()
        r.content = self._content
        return r


def _payload(translations=None, full="整篇译文"):
    return json.dumps({
        "translations": translations if translations is not None else ["T1", "T2"],
        "full": full,
    }, ensure_ascii=False)


def _run(primary, fallback=None):
    return translate_passage(
        primary, fallback, work_title="岳阳楼记",
        sentences=SENTENCES, key_terms=TERMS, prompt="P",
    )


class TestHappyPath:
    def test_primary_success(self):
        r = _run(_FakeLLM(_payload()))
        assert r.translations == ["T1", "T2"]
        assert r.full_translation == "整篇译文"
        assert r.source.startswith("local:")

    def test_accepts_json_in_markdown_fence(self):
        r = _run(_FakeLLM("```json\n" + _payload() + "\n```"))
        assert r.translations == ["T1", "T2"]

    def test_translations_trimmed(self):
        r = _run(_FakeLLM(_payload(translations=["  T1  ", " T2 "], full=" F ")))
        assert r.translations == ["T1", "T2"]
        assert r.full_translation == "F"


class TestRejectsIncompleteOutput:
    def test_count_mismatch_rejected_then_fallback(self):
        primary = _FakeLLM(_payload(translations=["只有一句"]))
        fallback = _FakeLLM(_payload(), model="fb")
        r = _run(primary, fallback)
        assert r.translations == ["T1", "T2"]
        assert r.source.startswith("fallback:")
        assert any("条数" in a for a in r.attempts)

    def test_blank_translation_rejected(self):
        r = _run(_FakeLLM(_payload(translations=["T1", "   "])))
        assert r.translations is None
        assert any("第 1 句译文为空" in a for a in r.attempts)

    def test_blank_full_rejected(self):
        r = _run(_FakeLLM(_payload(full="  ")))
        assert r.translations is None
        assert any("整篇译文为空" in a for a in r.attempts)

    def test_non_json_rejected(self):
        r = _run(_FakeLLM("抱歉，我无法翻译。"))
        assert r.translations is None
        assert any("不是合法 JSON" in a for a in r.attempts)

    def test_missing_translations_key_rejected(self):
        r = _run(_FakeLLM(json.dumps({"full": "x"}, ensure_ascii=False)))
        assert r.translations is None
        assert any("缺少 translations" in a for a in r.attempts)

    def test_never_partially_adopts(self):
        # 第二句为空时，第一句的好译文也不能采用——半截译文比整篇不入库更糟
        r = _run(_FakeLLM(_payload(translations=["好译文", ""])))
        assert r.translations is None


class TestFailurePaths:
    def test_primary_raises_falls_back(self):
        r = _run(_FakeLLM(raises=RuntimeError("local down")), _FakeLLM(_payload(), model="fb"))
        assert r.translations == ["T1", "T2"]
        assert any("调用失败" in a for a in r.attempts)

    def test_both_fail_returns_none_with_error(self):
        r = _run(_FakeLLM(raises=RuntimeError("local down")), _FakeLLM(raises=RuntimeError("cloud down")))
        assert r.translations is None
        assert r.full_translation is None
        assert r.error and "fail-closed" in r.error

    def test_no_fallback_configured(self):
        r = _run(_FakeLLM(raises=RuntimeError("down")))
        assert r.translations is None


class TestUserPrompt:
    def test_numbers_sentences_from_zero(self):
        prompt = build_user_prompt("岳阳楼记", SENTENCES, TERMS)
        assert "0. 庆历四年春，滕子京谪守巴陵郡。" in prompt
        assert "1. 越明年，政通人和。" in prompt
        assert "长度必须正好是 2" in prompt

    def test_includes_terms_as_reference(self):
        prompt = build_user_prompt("岳阳楼记", SENTENCES, TERMS)
        assert "谪守" in prompt and "因罪贬谪流放" in prompt
        assert "第 0 句" in prompt

    def test_no_terms_block_when_empty(self):
        prompt = build_user_prompt("岳阳楼记", SENTENCES, [])
        assert "重点字词" not in prompt
