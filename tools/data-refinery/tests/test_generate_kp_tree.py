"""generate_kp_tree 测试：只测纯函数与解析/校验逻辑，LLM 全程 mock。"""

import json

import pytest

from generate_kp_tree import (
    build_kp_seed_sql,
    fetch_kp_tree,
    filter_existing,
    parse_kp_tree,
    validate_kp_tree,
)


def _valid_tree() -> list[dict]:
    """最小合法两级树：6 个一级领域，每个 5 个二级知识点。"""
    domains = ["数与式", "方程与不等式", "函数", "三角形", "四边形", "圆"]
    return [
        {
            "name": d,
            "children": [
                {"name": f"{d}-知识点{i:02d}"} for i in range(1, 6)
            ],
        }
        for d in domains
    ]


# ---------------------------------------------------------------------------
# validate_kp_tree
# ---------------------------------------------------------------------------

def test_validate_accepts_valid_tree():
    validate_kp_tree(_valid_tree())  # 不抛即通过


@pytest.mark.parametrize("count", [5, 13])
def test_validate_rejects_bad_first_level_count(count):
    tree = _valid_tree()[:count] if count <= 6 else _valid_tree() + [
        {"name": f"额外领域{i}", "children": [{"name": f"额外领域{i}-知识点{j}"} for j in range(1, 6)]}
        for i in range(count - 6)
    ]
    with pytest.raises(ValueError, match="一级"):
        validate_kp_tree(tree)


@pytest.mark.parametrize("n_children", [4, 21])
def test_validate_rejects_bad_children_count(n_children):
    tree = _valid_tree()
    tree[0]["children"] = [
        {"name": f"数与式-知识点{i:02d}"} for i in range(1, n_children + 1)
    ]
    with pytest.raises(ValueError, match="二级"):
        validate_kp_tree(tree)


def test_validate_rejects_empty_name():
    tree = _valid_tree()
    tree[0]["name"] = "  "
    with pytest.raises(ValueError, match="名称"):
        validate_kp_tree(tree)


def test_validate_rejects_duplicate_name_across_tree():
    tree = _valid_tree()
    tree[1]["children"][0]["name"] = tree[0]["name"]  # 二级重一级的名
    with pytest.raises(ValueError, match="重复"):
        validate_kp_tree(tree)


def test_validate_rejects_non_list_input():
    with pytest.raises(ValueError):
        validate_kp_tree({"name": "数与式"})


def test_validate_rejects_overlong_name():
    tree = _valid_tree()
    tree[0]["children"][0]["name"] = "长" * 201
    with pytest.raises(ValueError, match="长度"):
        validate_kp_tree(tree)


# ---------------------------------------------------------------------------
# build_kp_seed_sql
# ---------------------------------------------------------------------------

def test_build_sql_contains_inserts_names_and_codes():
    sql = build_kp_seed_sql(_valid_tree(), subject_id=1)
    assert "INSERT INTO knowledge_points" in sql
    # 一级名称与 code
    assert "'数与式'" in sql
    assert "'M01'" in sql
    assert "'M06'" in sql
    # 二级名称与 code（第一个一级的第 1/5 个二级）
    assert "'数与式-知识点01'" in sql
    assert "'M0101'" in sql
    assert "'M0105'" in sql
    # 第六个一级的第一个二级
    assert "'M0601'" in sql


def test_build_sql_idempotent_not_exists():
    sql = build_kp_seed_sql(_valid_tree(), subject_id=1)
    # 行级防重：每条 INSERT 都带 NOT EXISTS
    assert sql.count("WHERE NOT EXISTS") == 6 + 30
    # 一级防重条件：parent IS NULL + 名称
    assert "parent_kp_id IS NULL" in sql
    # 二级挂到同名一级父节点（按名回查父 id）
    assert sql.count("LIMIT 1) p") == 30


def test_build_sql_subject_id_and_grade_band():
    sql = build_kp_seed_sql(_valid_tree(), subject_id=7)
    assert "subject_id" in sql
    assert "7" in sql
    assert "'junior'" in sql


def test_build_sql_escapes_single_quote():
    tree = _valid_tree()
    tree[0]["children"][0]["name"] = "圆的对称性（' O'中心）"
    sql = build_kp_seed_sql(tree)
    assert "'' O''" in sql  # ' 转义为 ''


def test_build_sql_validates_input():
    tree = _valid_tree()
    tree[0]["name"] = ""
    with pytest.raises(ValueError):
        build_kp_seed_sql(tree)


# ---------------------------------------------------------------------------
# filter_existing（SELECT-then-INSERT 脚本内过滤）
# ---------------------------------------------------------------------------

def test_filter_existing_drops_known_names():
    tree = _valid_tree()
    kept = filter_existing(tree, {"数与式", "方程与不等式-知识点03"})
    # 一级整体已存在 -> 连同子节点一起剔除
    assert [n["name"] for n in kept] == ["方程与不等式", "函数", "三角形", "四边形", "圆"]
    # 已存在的二级被剔除，其余保留
    eq = kept[0]
    assert "方程与不等式-知识点03" not in [c["name"] for c in eq["children"]]
    assert len(eq["children"]) == 4


def test_filter_existing_noop_when_db_empty():
    tree = _valid_tree()
    kept = filter_existing(tree, set())
    assert kept == tree


# ---------------------------------------------------------------------------
# parse_kp_tree（LLM 输出 -> 两级树 list）
# ---------------------------------------------------------------------------

def test_parse_plain_json_array():
    raw = json.dumps(_valid_tree(), ensure_ascii=False)
    assert parse_kp_tree(raw) == _valid_tree()


def test_parse_fenced_json_array_with_think_block():
    raw = (
        "<think>先梳理课标领域...</think>\n"
        "```json\n" + json.dumps(_valid_tree(), ensure_ascii=False) + "\n```"
    )
    assert parse_kp_tree(raw) == _valid_tree()


def test_parse_rejects_garbage():
    with pytest.raises(ValueError):
        parse_kp_tree("这不是 JSON")


def test_parse_rejects_object_not_array():
    with pytest.raises(ValueError, match="数组"):
        parse_kp_tree(json.dumps({"name": "数与式"}))


# ---------------------------------------------------------------------------
# fetch_kp_tree（mock LLM）
# ---------------------------------------------------------------------------

class _StubLLM:
    def __init__(self, content: str):
        self._content = content
        self.calls: list[tuple[str, str]] = []

    def complete(self, system_prompt: str, user_prompt: str):
        self.calls.append((system_prompt, user_prompt))
        return type("R", (), {"content": self._content})()


def test_fetch_kp_tree_parses_and_validates():
    raw = "```json\n" + json.dumps(_valid_tree(), ensure_ascii=False) + "\n```"
    llm = _StubLLM(raw)
    tree = fetch_kp_tree(llm, prompt_template="PROMPT", user_message="USER")
    assert [n["name"] for n in tree] == [n["name"] for n in _valid_tree()]
    assert llm.calls == [("PROMPT", "USER")]


def test_fetch_kp_tree_raises_on_invalid_tree():
    bad = _valid_tree()[:3]  # 一级只有 3 个
    llm = _StubLLM(json.dumps(bad, ensure_ascii=False))
    with pytest.raises(ValueError, match="一级"):
        fetch_kp_tree(llm, prompt_template="PROMPT", user_message="USER")
