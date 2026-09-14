import json

from dictation_locate import LocatedPassage, LocateResult, locate_unit


class _FakeLLM:
    """模拟 LLMClient：记录调用参数并回放固定内容（沿用 tests/test_llm.py 的 mock 惯例）。"""

    def __init__(self, content: str):
        self.content = content
        self.calls = []

    def complete(self, system_prompt, user_prompt):
        self.calls.append((system_prompt, user_prompt))

        class _Resp:
            pass

        r = _Resp()
        r.content = self.content
        r.prompt_tokens = 1
        r.completion_tokens = 1
        return r


def test_locates_single_passage():
    payload = {
        "passages": [
            {
                "is_classical": True,
                "work_title": "岳阳楼记",
                "author": "范仲淹",
                "dynasty": "宋",
                "genre": "wen",
                "body_start_anchor": "庆历四年春，滕子京谪守巴陵郡。",
                "body_end_anchor": "时六年九月十五日。",
                "reason": "完整文言正文",
            }
        ]
    }
    llm = _FakeLLM(json.dumps(payload, ensure_ascii=False))
    result = locate_unit(llm, "第三单元", "（页文本）", "（系统提示）")
    assert len(result.passages) == 1
    p = result.passages[0]
    assert isinstance(p, LocatedPassage)
    assert p.work_title == "岳阳楼记" and p.genre == "wen"
    assert p.body_start_anchor.startswith("庆历四年春")
    # 单元标题与页文本都进了 user prompt
    system_prompt, user_prompt = llm.calls[0]
    assert system_prompt == "（系统提示）"
    assert "第三单元" in user_prompt and "（页文本）" in user_prompt


def test_empty_unit_returns_empty_list():
    llm = _FakeLLM('{"passages": []}')
    result = locate_unit(llm, "第一单元", "（纯现代文）", "（系统提示）")
    assert result.passages == []


def test_tolerates_json_code_fence():
    llm = _FakeLLM('```json\n{"passages": []}\n```')
    assert locate_unit(llm, "第一单元", "x", "p").passages == []


def test_defaults_when_optional_fields_missing():
    llm = _FakeLLM('{"passages": [{"is_classical": true, "work_title": "静夜思", "body_start_anchor": "床前明月光，", "body_end_anchor": "低头思故乡。"}]}')
    p = locate_unit(llm, "课外古诗词诵读", "x", "p").passages[0]
    assert p.author == "" and p.dynasty == "" and p.genre == "other"
    assert isinstance(LocateResult(passages=[p]), LocateResult)


def test_ignores_extra_body_field_from_model():
    """架构护栏：模型若违规回吐正文字符，正文也不得进入下游。

    本模块的输出契约里**没有**正文字段——正文只由 dictation_slice 按锚点从 MD
    原样切出，这样「正文错字」在构造上不可能发生。此处用模型违规输出 body 字段
    的输入，锁定该字段被 pydantic 忽略、不会出现在 LocatedPassage 上。
    """
    llm = _FakeLLM(json.dumps({
        "passages": [{
            "is_classical": True,
            "work_title": "岳阳楼记",
            "genre": "wen",
            "body_start_anchor": "庆历四年春，",
            "body_end_anchor": "时六年九月十五日。",
            "body": "庆历四年春，滕子京谪守巴陵郡。越明年，政通人和……",
        }]
    }, ensure_ascii=False))
    p = locate_unit(llm, "第三单元", "x", "p").passages[0]
    assert "body" not in p.model_dump()
    assert not hasattr(p, "body")


def test_missing_passages_key_returns_empty():
    """真实客户端内容为空时返回 "{}"（llm.py 的兜底），必须退化为空结果而非抛错。"""
    llm = _FakeLLM("{}")
    assert locate_unit(llm, "第一单元", "x", "p").passages == []
