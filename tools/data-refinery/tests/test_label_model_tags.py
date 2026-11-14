# -*- coding: utf-8 -*-
"""label_model_tags 纯函数测试（不连 LLM/DB）。"""

from types import SimpleNamespace

import pytest

from label_model_tags import (
    ModelConfig, label_one, parse_tags_response, write_tags,
)
from model_tags import Tag, normalize_base_url


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


def test_parse_tags_response_rejects_non_object_json():
    # 合法 JSON 但不是对象：必须返回 None，不能抛 TypeError
    assert parse_tags_response("5") is None
    assert parse_tags_response('"tags"') is None
    assert parse_tags_response("true") is None
    assert parse_tags_response("[]") is None
    assert parse_tags_response('{"tags":[]}') == []


def test_parse_tags_response_all_invalid_entries_is_failure():
    # 非空 tags 但全不是对象 = 模型没按格式输出，不能当「无标签」清库
    assert parse_tags_response('{"tags":[1,2]}') is None
    assert parse_tags_response('{"tags":[null]}') is None


# ---- label_one ----

class _FakeLLM:
    """只回固定 content；compose 走 complete 即可（with_images=False）。"""

    def __init__(self, content: str):
        self.content = content
        self.calls = 0

    def complete(self, system_prompt: str, user_prompt: str) -> SimpleNamespace:
        self.calls += 1
        return SimpleNamespace(content=self.content)

    def complete_with_images(self, system_prompt: str, user_prompt: str,
                             image_data_urls: list[str]) -> SimpleNamespace:
        self.calls += 1
        return SimpleNamespace(content=self.content)


def test_label_one_returns_validate_failed_instead_of_empty_tags(tmp_path):
    llm = _FakeLLM('{"tags":[{"category":"不存在的类"}]}')
    question = {
        "id": 7, "type": "解答题", "difficulty": 3,
        "content": "如图，AB=AC。", "options": None,
        "explanation": "连接 AD。", "approach": None,
    }
    outcome = label_one(question, llm, "system", tmp_path, with_images=False)

    assert outcome.error == "validate_failed"
    assert outcome.tags == []
    assert outcome.dropped == 1
    assert "不存在的类" in outcome.raw
    assert llm.calls == 1  # 解析成功（只是校验全丢），不该再重试


# ---- write_tags ----

class _FakeCursor:
    def __init__(self, conn: "_FakeConn"):
        self._conn = conn

    def __enter__(self) -> "_FakeCursor":
        return self

    def __exit__(self, *exc_info) -> bool:
        return False

    def execute(self, sql: str, params=None) -> None:
        self._conn.log.append(("execute", sql, params))

    def executemany(self, sql: str, rows) -> None:
        if self._conn.fail_insert:
            raise RuntimeError("insert boom")
        self._conn.log.append(("executemany", sql, list(rows)))


class _FakeConn:
    def __init__(self, fail_insert: bool = False):
        self.log: list[tuple] = []
        self.fail_insert = fail_insert

    def cursor(self) -> _FakeCursor:
        return _FakeCursor(self)

    def begin(self) -> None:
        self.log.append(("begin",))

    def commit(self) -> None:
        self.log.append(("commit",))

    def rollback(self) -> None:
        self.log.append(("rollback",))


def test_write_tags_deletes_llm_rows_then_inserts_and_commits():
    conn = _FakeConn()
    write_tags(conn, 42, [Tag("geometry_synthesis", "median_doubling", 0.9, "倍长构造")])

    assert [entry[0] for entry in conn.log] == [
        "begin", "execute", "executemany", "commit"]

    _, delete_sql, delete_params = conn.log[1]
    assert "DELETE FROM question_model_tags" in delete_sql
    assert "source='llm'" in delete_sql
    assert delete_params == (42,)

    _, insert_sql, insert_rows = conn.log[2]
    assert "INSERT IGNORE INTO question_model_tags" in insert_sql
    assert insert_rows == [
        (42, "geometry_synthesis", "几何综合",
         "median_doubling", "倍长中线", 0.9, "倍长构造"),
    ]


def test_write_tags_skips_insert_for_empty_tags():
    conn = _FakeConn()
    write_tags(conn, 43, [])

    assert [entry[0] for entry in conn.log] == ["begin", "execute", "commit"]
    assert conn.log[2] == ("commit",)


def test_write_tags_rolls_back_when_insert_fails():
    conn = _FakeConn(fail_insert=True)
    with pytest.raises(RuntimeError):
        write_tags(conn, 7, [Tag("extremum", "hu_bu_gui", 0.8, "胡不归")])

    ops = [entry[0] for entry in conn.log]
    assert "rollback" in ops
    assert "commit" not in ops


def test_model_config_repr_hides_api_key():
    cfg = ModelConfig("qwen", "qwen-max", "https://x/v1", "sk-secret")
    assert "sk-secret" not in repr(cfg)
