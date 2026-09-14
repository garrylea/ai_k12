import json

import pytest
from pydantic import ValidationError

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


# --- 逐条容错（Task 4 评审 Important）---------------------------------------
#
# 原实现是 LocateResult.model_validate 整体校验：模型一条畸形数据就让**整个单元**
# 抛 ValidationError，被 Task 7 的 except 丢掉（本册一次可损失 10 篇）。以下用例锁定
# 「逐条独立校验」：好的留下（兄弟条目不连坐）、坏的进 rejected（不静默丢）。


def _passage(**overrides):
    """一条形状完整的条目，用例只覆盖需要变化的字段。"""
    raw = {
        "is_classical": True,
        "work_title": "岳阳楼记",
        "author": "范仲淹",
        "dynasty": "宋",
        "genre": "wen",
        "body_start_anchor": "庆历四年春，",
        "body_end_anchor": "时六年九月十五日。",
        "reason": "完整文言正文",
    }
    raw.update(overrides)
    return raw


def _locate(entries):
    return locate_unit(
        _FakeLLM(json.dumps(entries, ensure_ascii=False)), "第三单元", "x", "p"
    )


def test_valid_entry_survives_genre_typo_sibling():
    """头条用例 1：兄弟条目 genre 非白名单（"诗"）不得连坐有效条目。

    genre 白名单外按计划归一到 `other`（该字段本就以此为默认语义），于是这条也
    留下、`rejected` 为空——pydantic 整体校验时它是会抛 ValidationError 的。
    注意：`rejected` 只收「留不下来」的条目（见缺 is_classical 的用例），
    归一后的条目不算失败，故此处断言为空。
    """
    result = _locate({"passages": [_passage(), _passage(work_title="静夜思", genre="诗")]})
    assert [p.work_title for p in result.passages] == ["岳阳楼记", "静夜思"]
    assert result.passages[0].genre == "wen"  # 有效条目的 genre 未被牵连
    assert result.passages[1].genre == "other"
    assert result.rejected == []


def test_out_of_whitelist_genre_coerced_to_other():
    """白名单外/为 null 的 genre 归一为 other，整条保住（对齐 card_labeler 先例）。"""
    result = _locate({"passages": [_passage(genre="古文"), _passage(work_title="沁园春·雪", genre=None)]})
    assert [p.genre for p in result.passages] == ["other", "other"]
    assert result.rejected == []


def test_valid_entry_survives_missing_is_classical_sibling():
    """头条用例 2：is_classical 缺失只丢该条，且**不得默认 True**（会静默放宽收录范围）。"""
    bad = _passage(work_title="静夜思")
    del bad["is_classical"]
    result = _locate({"passages": [_passage(), bad]})
    assert [p.work_title for p in result.passages] == ["岳阳楼记"]
    assert len(result.rejected) == 1
    assert "静夜思" in result.rejected[0] and "is_classical" in result.rejected[0]


def test_null_is_classical_rejects_only_that_entry():
    result = _locate({"passages": [_passage(is_classical=None), _passage(work_title="岳阳楼记")]})
    assert len(result.passages) == 1 and len(result.rejected) == 1


def test_bare_top_level_array_is_treated_as_passages():
    """模型偶尔直接回吐 passages 数组本身（_parse_json_object 允许返回 list）。"""
    result = locate_unit(
        _FakeLLM(json.dumps([_passage()], ensure_ascii=False)), "第三单元", "x", "p"
    )
    assert [p.work_title for p in result.passages] == ["岳阳楼记"]
    assert result.rejected == []


def test_non_list_passages_does_not_crash():
    """`passages` 容器类型错（{}）不崩：按空处理并记一条 rejected。"""
    result = locate_unit(_FakeLLM('{"passages": {}}'), "第三单元", "x", "p")
    assert result.passages == []
    assert len(result.rejected) == 1


def test_non_dict_entry_is_rejected_without_killing_siblings():
    result = _locate({"passages": [_passage(), "岳阳楼记"]})
    assert [p.work_title for p in result.passages] == ["岳阳楼记"]
    assert len(result.rejected) == 1 and "第2条" in result.rejected[0]


def test_rejected_note_never_carries_body_text():
    """架构护栏延伸到新增的 rejected 字段。

    模型若把正文塞进畸形条目（未声明的 `body` 键、或干脆把正文当条目倒出来），
    正文文本不得借道 `rejected` 流向 Task 7 的人工处理报告——正文只能来自 MD 切片。
    """
    body = "庆历四年春，滕子京谪守巴陵郡。越明年，政通人和。"
    result = _locate({"passages": [_passage(), {"body": body}]})  # 缺 is_classical + 违规回吐正文
    assert len(result.passages) == 1 and len(result.rejected) == 1
    assert "滕子京" not in result.rejected[0]

    result = _locate({"passages": [_passage(), body]})  # 条目本身就是一个正文字符串
    assert len(result.passages) == 1 and len(result.rejected) == 1
    assert "滕子京" not in result.rejected[0]


def test_rejection_note_is_short_and_does_not_throw():
    """rejected 说明要短、可读、绝不抛错（超长字段必须截断）。"""
    bad = {"work_title": "长" * 500, "genre": "wen"}  # 缺 is_classical + 超长篇名
    result = _locate({"passages": [_passage(), bad]})
    assert len(result.passages) == 1
    assert len(result.rejected) == 1
    note = result.rejected[0]
    assert "is_classical" in note
    assert "长" * 100 not in note  # 已截断
    assert len(note) <= 200


def test_is_classical_is_still_required():
    """护栏：is_classical 不得被加上默认值——那会静默放宽 24 篇收录范围。"""
    assert LocatedPassage.model_fields["is_classical"].is_required()
    with pytest.raises(ValidationError):
        LocatedPassage(work_title="静夜思")
