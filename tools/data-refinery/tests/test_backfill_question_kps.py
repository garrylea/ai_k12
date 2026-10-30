# -*- coding: utf-8 -*-
"""backfill_question_kps 纯函数测试（LLM 不参与，mock 输出字符串）。

核心被测：parse_kp_response / parse_batch_response / build_user_message。
主流程幂等（LEFT JOIN qkp IS NULL + INSERT IGNORE）见脚本 main，不在此测。
"""

from backfill_question_kps import (
    build_user_message,
    parse_batch_response,
    parse_kp_response,
)

WHITELIST = {1: "有理数的运算", 2: "一元二次方程的解法", 3: "全等三角形的判定",
             4: "圆周角定理", 17: "一次函数的图象与性质"}


# ===== parse_kp_response：单题输出 =====

def test_parse_valid_kps_dedup_and_truncate():
    """合法 id 保留、去重（保序）、超过 3 个截前 3"""
    raw = '{"kps": [17, 1, 17, 2, 3, 4]}'
    assert parse_kp_response(raw, WHITELIST) == [17, 1, 2]


def test_parse_invalid_ids_dropped():
    """白名单外 id / 非整数（含 bool、字符串、null）丢弃，不致整体失败"""
    raw = '{"kps": [1, 99, "2", null, true, 2]}'
    assert parse_kp_response(raw, WHITELIST) == [1, 2]


def test_parse_non_json_returns_empty():
    assert parse_kp_response("这不是 JSON", WHITELIST) == []
    assert parse_kp_response("", WHITELIST) == []


def test_parse_bare_array_tolerated():
    """裸数组 [1,17] 容错（与 {"kps": [...]} 等价）"""
    assert parse_kp_response("[1, 17]", WHITELIST) == [1, 17]


def test_parse_dict_without_kps_returns_empty():
    assert parse_kp_response('{"foo": 1}', WHITELIST) == []


def test_parse_empty_kps():
    assert parse_kp_response('{"kps": []}', WHITELIST) == []
    assert parse_kp_response("[]", WHITELIST) == []


def test_parse_code_fence():
    """markdown 代码围栏容错"""
    raw = "```json\n{\"kps\": [1, 2]}\n```"
    assert parse_kp_response(raw, WHITELIST) == [1, 2]


def test_parse_think_block_stripped():
    """本地推理模型可能先输出 <think> 推理再输出 JSON"""
    raw = "<think>这道题考查一次函数图象，先平移后……</think>\n{\"kps\": [17]}"
    assert parse_kp_response(raw, WHITELIST) == [17]


# ===== parse_batch_response：批量输出 {"items": [...]} =====

def test_parse_batch_items():
    raw = ('{"items": [{"qid": 101, "kps": [1, 2]},'
           ' {"qid": 102, "kps": [99]},'
           ' {"qid": 103, "kps": []},'
           ' {"bad": 1},'
           ' {"qid": "x", "kps": [1]}]}')
    result = parse_batch_response(raw, WHITELIST)
    # 101 正常；102 kps 全非法（空列表，调用方按失败处理）；103/其余无效不出现
    assert result == {101: [1, 2]}


def test_parse_batch_dedup_qid_first_wins():
    raw = '{"items": [{"qid": 1, "kps": [1]}, {"qid": 1, "kps": [2]}]}'
    assert parse_batch_response(raw, WHITELIST) == {1: [1]}


def test_parse_batch_non_json_returns_empty():
    assert parse_batch_response("垃圾输出", WHITELIST) == {}
    assert parse_batch_response("", WHITELIST) == {}


def test_parse_batch_truncates_per_question():
    """批量内单题 kps 同样受白名单过滤 + 截 3 约束"""
    raw = '{"items": [{"qid": 1, "kps": [1, 2, 3, 4, 4]}]}'
    assert parse_batch_response(raw, WHITELIST) == {1: [1, 2, 3]}


# ===== build_user_message =====

def test_build_user_message_contains_whitelist_and_questions():
    questions = [(101, "解方程 $x^2=4$", None), (102, "证明三角形全等", None)]
    msg = build_user_message(WHITELIST, questions)
    # 白名单 id+name 清单
    assert "1: 有理数的运算" in msg
    assert "17: 一次函数的图象与性质" in msg
    # 每题 qid + 题面
    assert "[qid 101]" in msg
    assert "解方程 $x^2=4$" in msg
    assert "[qid 102]" in msg


def test_build_user_message_includes_options():
    """题干只有「下列说法正确的是」时，选项才是真正的题面。

    物理/化学的客观题普遍靠选项承载考点；只喂题干会让模型瞎标
    （2026-10-30 实测：题12 火箭热值被标成「力与运动的关系」、
    题16 能源分类被标成「电流的磁效应」）。
    """
    options = ('[{"label": "A", "text": "太阳能电池可将太阳能转化为电能"},'
               ' {"label": "B", "text": "核能是可再生能源"}]')
    msg = build_user_message(WHITELIST, [(101, "下列说法正确的是", options)])

    assert "太阳能电池可将太阳能转化为电能" in msg
    assert "核能是可再生能源" in msg


def test_build_user_message_tolerates_bad_options():
    msg = build_user_message(WHITELIST, [(101, "下列说法正确的是", "not-json")])
    assert "[qid 101]" in msg
    assert "下列说法正确的是" in msg


def test_build_user_message_truncates_content_to_500():
    long_content = "字" * 600
    msg = build_user_message(WHITELIST, [(1, long_content, None)])
    assert "字" * 500 in msg
    assert "字" * 501 not in msg
