"""LLM 生成初中数学两级知识点树 -> 种子 SQL（tools/db/migrations/）。

流程（main）：
1. LLM（prompts/kp_tree.txt）输出两级树 JSON -> 解析 + 校验（validate_kp_tree）。
2. SELECT-then-INSERT：从 DB 拉取 subject_id 对应 grade_band 已有知识点名称集合，
   脚本内过滤掉已存在的节点（filter_existing），只生成缺失部分的 INSERT。
3. 生成的 SQL 本身仍带行级 WHERE NOT EXISTS 防重（knowledge_points 无唯一约束），
   重复执行不会插重。
4. 写入 tools/db/migrations/{今天}_add_math_knowledge_points.sql（只产出文件，
   入库由人工过目后执行 mysql < 文件）。

纯函数（可测，LLM 不参与）：validate_kp_tree / build_kp_seed_sql / filter_existing /
parse_kp_tree。LLM 调用只出现在 fetch_kp_tree 与 main。

用法：cd tools/data-refinery && python src/generate_kp_tree.py
"""

import json
import re
import sys
import os
from datetime import date
from pathlib import Path

# 确保能 import 同目录模块（src/）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from extract import _repair_json_escapes, _strip_code_fence  # noqa: E402

# 校验边界（brief 约定）
MIN_L1, MAX_L1 = 6, 12
MIN_L2, MAX_L2 = 5, 20
MAX_NAME_LEN = 200  # schema.sql: knowledge_points.name VARCHAR(200)

DEFAULT_SUBJECT_ID = 1  # subjects 种子：math
DEFAULT_GRADE_BAND = "junior"


# ---------------------------------------------------------------------------
# 校验（纯函数）
# ---------------------------------------------------------------------------

def _check_name(name: object, where: str, seen: set[str]) -> str:
    """校验单个名称：非空字符串、长度、全树去重。返回原名称。"""
    if not isinstance(name, str) or not name.strip():
        raise ValueError(f"{where}名称为空或不是字符串：{name!r}")
    if len(name) > MAX_NAME_LEN:
        raise ValueError(f"{where}名称长度超 {MAX_NAME_LEN} 字符：{name[:20]}...")
    if name in seen:
        raise ValueError(f"全树名称重复：{name!r}")
    seen.add(name)
    return name


def validate_kp_tree(tree: object) -> list[dict]:
    """校验 LLM 产出的两级树：[{name, children: [{name}]}]。

    规则：一级 6-12 个；每个一级的二级 5-20 个；名称非空、全树去重、
    长度 <= 200（schema name 列宽）。违规抛 ValueError。
    """
    if not isinstance(tree, list) or not tree:
        raise ValueError("知识点树必须是非空 JSON 数组")
    if not (MIN_L1 <= len(tree) <= MAX_L1):
        raise ValueError(f"一级领域数量 {len(tree)} 超出 [{MIN_L1}, {MAX_L1}]")

    seen: set[str] = set()
    for i, node in enumerate(tree):
        if not isinstance(node, dict):
            raise ValueError(f"第 {i + 1} 个一级节点不是对象：{node!r}")
        _check_name(node.get("name"), f"第 {i + 1} 个一级", seen)
        children = node.get("children")
        if not isinstance(children, list) or not (MIN_L2 <= len(children) <= MAX_L2):
            raise ValueError(
                f"一级「{node.get('name')}」二级数量 "
                f"{len(children) if isinstance(children, list) else 0} 超出 [{MIN_L2}, {MAX_L2}]"
            )
        for j, child in enumerate(children):
            if not isinstance(child, dict):
                raise ValueError(f"「{node.get('name')}」第 {j + 1} 个二级不是对象：{child!r}")
            _check_name(child.get("name"), f"「{node.get('name')}」第 {j + 1} 个二级", seen)
    return tree


# ---------------------------------------------------------------------------
# SQL 生成（纯函数）
# ---------------------------------------------------------------------------

def _sql_str(value: str) -> str:
    """SQL 字符串字面量：单引号转义为两个单引号。"""
    return "'" + value.replace("'", "''") + "'"


def build_kp_seed_sql(tree: list[dict], subject_id: int = DEFAULT_SUBJECT_ID,
                      grade_band: str = DEFAULT_GRADE_BAND) -> str:
    """两级树 -> 幂等种子 SQL 文本（纯函数，不碰 DB/LLM）。

    code 生成规则：一级 M{n:02d}（M01..M10），二级 M{n:02d}{m:02d}（每父内自增）。
    幂等实现：knowledge_points 无唯一约束，每行用
    INSERT ... SELECT ... WHERE NOT EXISTS 防重——
    - 一级按 (subject_id, grade_band, parent IS NULL, name) 防重；
    - 二级先按 (subject_id, grade_band, parent IS NULL, 一级同名) 回查父 id
      （FROM 子查询，父不存在则整行不插入），再按 (parent, name) 防重。
    父 id 回查用名称而非 code：历史/人工行的 code 不可控，名称才是稳定键。
    """
    validate_kp_tree(tree)

    lines: list[str] = [
        "-- 初中数学知识点两级树种子（subject_id="
        f"{subject_id}, grade_band='{grade_band}'）。",
        "-- 由 tools/data-refinery/src/generate_kp_tree.py 生成，产出需人工过目后执行。",
        "-- 幂等：knowledge_points 无唯一约束，逐行 NOT EXISTS 防重，可重复执行。",
        "",
    ]

    def _lvl1(node: dict, n: int) -> str:
        name = _sql_str(node["name"])
        code = _sql_str(f"M{n:02d}")
        return (
            f"INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)\n"
            f"SELECT {subject_id}, NULL, {name}, {code}, {_sql_str(grade_band)} FROM DUAL\n"
            f"WHERE NOT EXISTS (\n"
            f"  SELECT 1 FROM knowledge_points\n"
            f"  WHERE subject_id = {subject_id} AND grade_band = {_sql_str(grade_band)}\n"
            f"    AND parent_kp_id IS NULL AND name = {name}\n"
            f");"
        )

    def _lvl2(parent: dict, child: dict, n: int, m: int) -> str:
        pname = _sql_str(parent["name"])
        cname = _sql_str(child["name"])
        code = _sql_str(f"M{n:02d}{m:02d}")
        return (
            f"INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)\n"
            f"SELECT {subject_id}, p.id, {cname}, {code}, {_sql_str(grade_band)}\n"
            f"FROM (SELECT id FROM knowledge_points\n"
            f"      WHERE subject_id = {subject_id} AND grade_band = {_sql_str(grade_band)}\n"
            f"        AND parent_kp_id IS NULL AND name = {pname}\n"
            f"      LIMIT 1) p\n"
            f"WHERE NOT EXISTS (\n"
            f"  SELECT 1 FROM knowledge_points c\n"
            f"  WHERE c.subject_id = {subject_id} AND c.grade_band = {_sql_str(grade_band)}\n"
            f"    AND c.parent_kp_id = p.id AND c.name = {cname}\n"
            f");"
        )

    for n, node in enumerate(tree, start=1):
        lines.append(f"-- {node['name']}")
        lines.append(_lvl1(node, n))
        lines.append("")
        for m, child in enumerate(node["children"], start=1):
            lines.append(_lvl2(node, child, n, m))
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


# ---------------------------------------------------------------------------
# 已有节点过滤（SELECT-then-INSERT 的脚本侧纯函数）
# ---------------------------------------------------------------------------

def filter_existing(tree: list[dict], existing_names: set[str]) -> list[dict]:
    """剔除 DB 中已存在的节点（按名称匹配；全树名称唯一由 validate 保证）。

    一级已存在则连同其子节点整体剔除；一级保留时仅剔除已存在的二级。
    """
    kept: list[dict] = []
    for node in tree:
        if node["name"] in existing_names:
            continue
        children = [c for c in node["children"] if c["name"] not in existing_names]
        kept.append({"name": node["name"], "children": children})
    return kept


# ---------------------------------------------------------------------------
# LLM 输出解析（纯函数）
# ---------------------------------------------------------------------------

def parse_kp_tree(content: str) -> list[dict]:
    """从 LLM 输出中解析 JSON 数组（两级树）。

    依次尝试：原样解析 -> 去 <think> 与代码围栏 -> 截取最外层 [...]。
    输出不是数组（如对象）则抛 ValueError。
    """
    text = (content or "").strip()
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
    if not text:
        raise ValueError("LLM 输出为空")

    candidates = [text]
    fenced = _strip_code_fence(text)
    if fenced != text:
        candidates.append(fenced)
    start, end = fenced.find("["), fenced.rfind("]")
    if start != -1 and end > start:
        candidates.append(fenced[start:end + 1])

    last_err: Exception | None = None
    for cand in candidates:
        for attempt in (cand, _repair_json_escapes(cand)):
            try:
                data = json.loads(attempt)
            except (json.JSONDecodeError, ValueError) as e:
                last_err = e
                continue
            if not isinstance(data, list):
                raise ValueError(f"LLM 输出不是 JSON 数组：{type(data).__name__}")
            return data
    raise ValueError(f"无法从 LLM 输出中定位 JSON 数组：{last_err}")


# ---------------------------------------------------------------------------
# LLM 调用（mock 点）
# ---------------------------------------------------------------------------

DEFAULT_USER_MESSAGE = "请输出初中数学知识点两级树 JSON 数组。"


def fetch_kp_tree(llm, prompt_template: str,
                  user_message: str = DEFAULT_USER_MESSAGE) -> list[dict]:
    """调 LLM -> 解析 -> 校验。llm 只需提供 complete(system, user) -> .content。"""
    response = llm.complete(prompt_template, user_message)
    tree = parse_kp_tree(response.content)
    return validate_kp_tree(tree)


# ---------------------------------------------------------------------------
# main（LLM + DB + 写文件）
# ---------------------------------------------------------------------------

def _load_prompt(name: str) -> str:
    """加载 prompts/{name}.txt（与 backfill_practice_questions 同款）。"""
    return (Path(__file__).parent / "prompts" / f"{name}.txt").read_text(encoding="utf-8")


def _fetch_existing_names(conn, subject_id: int, grade_band: str) -> set[str]:
    """SELECT-then-INSERT：拉取该 subject/grade_band 下已有知识点名称集合。"""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT name FROM knowledge_points "
            "WHERE subject_id = %s AND grade_band = %s",
            (subject_id, grade_band),
        )
        return {row[0] for row in cur.fetchall()}


def main() -> None:
    import pymysql

    from config import RefineryConfig
    from llm import create_llm_client

    cfg = RefineryConfig.from_env()
    llm = create_llm_client(
        provider=cfg.llm_provider,
        api_key=cfg.llm_api_key or "",
        auth_token=cfg.llm_auth_token,
        model=cfg.llm_model,
        base_url=cfg.llm_base_url,
        timeout=cfg.llm_timeout,
        max_tokens=cfg.llm_max_tokens,
        max_retries=cfg.llm_max_retries,
        thinking=cfg.llm_thinking,
        enable_cache=cfg.llm_enable_cache,
    )

    # 1. LLM 生成 + 解析 + 校验
    tree = fetch_kp_tree(llm, _load_prompt("kp_tree"))
    n_l1 = len(tree)
    n_l2 = sum(len(n["children"]) for n in tree)
    print(f"[ok] LLM 生成两级树：{n_l1} 个一级 / {n_l2} 个二级", flush=True)

    # 2. SELECT-then-INSERT：DB 已有名称过滤
    conn = pymysql.connect(
        host=cfg.db_host,
        port=cfg.db_port,
        user=cfg.db_user,
        password=cfg.db_pass,
        database=cfg.db_name,
        charset="utf8mb4",
    )
    try:
        existing = _fetch_existing_names(conn, DEFAULT_SUBJECT_ID, DEFAULT_GRADE_BAND)
    finally:
        conn.close()
    kept = filter_existing(tree, existing)
    if existing:
        print(f"[ok] DB 已有 {len(existing)} 个知识点，过滤后剩 "
              f"{len(kept)} 个一级 / {sum(len(n['children']) for n in kept)} 个二级", flush=True)
    if not kept:
        print("[done] 树已全部存在，无需生成 SQL", flush=True)
        return

    # 3. 生成 SQL 写迁移文件（日期用执行日）
    repo_root = Path(__file__).resolve().parents[2]
    out_path = (repo_root / "tools" / "db" / "migrations"
                / f"{date.today().isoformat()}_add_math_knowledge_points.sql")
    header = (
        f"-- 生成于 {date.today().isoformat()}，模型：{cfg.llm_model}，"
        f"一级 {len(kept)} 个 / 二级 {sum(len(n['children']) for n in kept)} 个。\n"
    )
    out_path.write_text(header + build_kp_seed_sql(kept), encoding="utf-8")
    print(f"[done] 已写入 {out_path}（人工过目后执行：mysql ... < {out_path.name}）", flush=True)


if __name__ == "__main__":
    main()
