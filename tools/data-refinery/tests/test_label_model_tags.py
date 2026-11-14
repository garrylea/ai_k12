# -*- coding: utf-8 -*-
"""label_model_tags 纯函数测试（不连 LLM/DB）。"""

from label_model_tags import parse_tags_response
from model_tags import normalize_base_url


def test_parse_tags_response_valid():
    raw = '{"tags":[{"category":"geometry_synthesis","model":"median_doubling"}]}'
    assert parse_tags_response(raw) == [
        {"category": "geometry_synthesis", "model": "median_doubling"}
    ]


def test_parse_tags_response_empty_and_invalid():
    assert parse_tags_response('{"tags":[]}') == []
    assert parse_tags_response("不是 JSON") is None
    assert parse_tags_response('{"foo":1}') is None
    assert parse_tags_response('{"tags":"bad"}') is None


def test_parse_tags_response_strips_fence_and_think():
    raw = '<think>先想</think>\n```json\n{"tags":[{"category":"extremum"}]}\n```'
    assert parse_tags_response(raw) == [{"category": "extremum"}]
