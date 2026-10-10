#!/usr/bin/env python3
"""schema.sql ↔ 线上库 全表结构对账（无需建库权限）。

原理：在 ai_k12 库内为 schema.sql 每张表建 __schema_check_<name> 影子表
（用户对本库有 CREATE/DROP 权限），由 MySQL 自身规范化 DDL，
然后用 information_schema 逐表比对 列/索引/外键，最后删影子表。
只读真实表；影子表建后即删。
"""
import re
import subprocess
import sys
from pathlib import Path

REPO = Path("/Users/lichao/Downloads/claude/imooc/ai_k12")
env_file = REPO / "apps/server/.env"
ENV = dict(
    line.strip().split("=", 1)
    for line in env_file.read_text().splitlines()
    if line.strip() and not line.startswith("#") and "=" in line
)
DB, USER, PW = ENV["DB_NAME"], ENV["DB_USER"], ENV["DB_PASS"]
PREFIX = "__schema_check_"


def sql(query, db=DB):
    """mysql -N -B 执行，返回行列表（tab 分列，\\N→None）。"""
    r = subprocess.run(
        ["mysql", f"-u{USER}", f"-p{PW}", "-N", "-B", db, "-e", query],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        err = r.stderr.strip().splitlines()
        raise RuntimeError(f"SQL 失败: {query[:120]}... → {err[-1] if err else r.stderr}")
    rows = []
    for line in r.stdout.splitlines():
        rows.append([None if f == "\\N" else f for f in line.split("\t")])
    return rows


def run(stmt, db=DB):
    r = subprocess.run(
        ["mysql", f"-u{USER}", f"-p{PW}", db, "-e", stmt],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        raise RuntimeError(f"DDL 失败: {stmt[:120]}... → {r.stderr.strip()[-300:]}")


# ---------- 1. 解析 schema.sql 的 CREATE TABLE ----------
text = (REPO / "tools/db/schema.sql").read_text()
stmts = re.findall(
    r"CREATE TABLE IF NOT EXISTS `?(\w+)`?\s*\((.*?)\)\s*ENGINE=(\w+)([^;]*);",
    text, re.S,
)
tables_in_schema = {name: body for name, body, _, _ in stmts}
tails_in_schema = {name: f"ENGINE={eng}{tail}".strip() for name, _, eng, tail in stmts}
print(f"schema.sql 解析到 {len(tables_in_schema)} 张表")

# ---------- 2. 建影子表 ----------
created = []
skipped = []
try:
    for name, body in tables_in_schema.items():
        tmp = PREFIX + name
        # FK 约束名是库级唯一的，影子表必须改名，否则与真实表撞名（ERROR 1826）
        body = re.sub(r"CONSTRAINT\s+`?(\w+)`?", r"CONSTRAINT `__chk_\1`", body)
        try:
            run(f"DROP TABLE IF EXISTS `{tmp}`")
            run(f"CREATE TABLE `{tmp}` (\n{body}\n) {tails_in_schema[name]}")
            created.append(name)
        except RuntimeError as e:
            skipped.append((name, str(e)[:200]))
    print(f"影子表建成 {len(created)} 张；建失败 {len(skipped)} 张")
    for n, msg in skipped:
        print(f"  [BUILD-FAIL] {n}: {msg}")

    # ---------- 3. 逐表比对 ----------
    COLS = """
      SELECT table_name, column_name, column_type, is_nullable,
             column_default, extra, character_set_name, collation_name
        FROM information_schema.columns
       WHERE table_schema = '{db}' AND table_name IN ('{a}', '{b}')
       ORDER BY ordinal_position"""
    IDX = """
      SELECT table_name, index_name, non_unique, seq_in_index, column_name
        FROM information_schema.statistics
       WHERE table_schema = '{db}' AND table_name IN ('{a}', '{b}')
         AND index_name != 'PRIMARY'
       ORDER BY index_name, seq_in_index"""
    PK = """
      SELECT table_name, column_name, seq_in_index
        FROM information_schema.statistics
       WHERE table_schema = '{db}' AND table_name IN ('{a}', '{b}')
         AND index_name = 'PRIMARY'
       ORDER BY seq_in_index"""
    FK = """
      SELECT table_name, constraint_name, column_name,
             referenced_table_name, referenced_column_name
        FROM information_schema.key_column_usage
       WHERE table_schema = '{db}' AND table_name IN ('{a}', '{b}')
         AND referenced_table_name IS NOT NULL
       ORDER BY constraint_name, ordinal_position"""

    diffs = []
    only_in_live = []
    for name in created:
        a, b = name, PREFIX + name
        tbl_diff = []

        live_exists = sql(
            f"SELECT COUNT(*) FROM information_schema.tables "
            f"WHERE table_schema='{DB}' AND table_name='{name}'"
        )[0][0]
        if live_exists == "0":
            only_in_live.append(name)  # schema 有、线上无
            continue

        for label, q in (("列", COLS), ("索引", IDX), ("主键", PK), ("外键", FK)):
            qf = q.format(db=DB, a=a, b=b)
            rows = sql(qf)
            real = [tuple(r) for r in rows if r[0] == name]
            shadow = [tuple(r) for r in rows if r[0] == b]
            # 归一化：表名字段统一；影子表的约束/索引名剥 __chk_ 前缀（建表时为避开库级唯一 FK 名而加）
            def norm(r):
                vals = list(r[1:])
                if label in ("索引", "外键") and vals[0] and vals[0].startswith("__chk_"):
                    vals[0] = vals[0][len("__chk_"):]
                return (name,) + tuple(vals)
            real_n = [norm(r) for r in real]
            shadow_n = [norm(r) for r in shadow]
            if real_n != shadow_n:
                only_real = set(real_n) - set(shadow_n)
                only_shadow = set(shadow_n) - set(real_n)
                order_diff = real_n != shadow_n and not only_real and not only_shadow
                tbl_diff.append(
                    f"[{label}差异] 线上有/影子无: {sorted(only_real) or '∅'} | "
                    f"影子有/线上无: {sorted(only_shadow) or '∅'}"
                    + ("（内容相同仅顺序不同）" if order_diff else "")
                )

        if tbl_diff:
            diffs.append((name, tbl_diff))

    # 线上有、schema.sql 没有（schema.sql 全表清单 vs 线上全表清单）
    live_tables = {
        r[0] for r in sql(
            f"SELECT table_name FROM information_schema.tables WHERE table_schema='{DB}'"
        )
    }
    missing_in_schema = sorted(
        t for t in live_tables if not t.startswith(PREFIX) and t not in tables_in_schema
    )

    # ---------- 4. 报告 ----------
    print("\n========== 对账结果 =========")
    print(f"比对表数: {len(created)}（+ 建失败 {len(skipped)}）")
    if only_in_live:
        print(f"[缺表] schema.sql 有、线上没有: {sorted(only_in_live)}")
    if missing_in_schema:
        print(f"[缺表] 线上有、schema.sql 没有: {missing_in_schema}")
    else:
        print("[缺表] 无 —— 线上所有表都在 schema.sql 里")
    if diffs:
        print(f"\n结构差异 {len(diffs)} 张：")
        for name, ds in diffs:
            print(f"  {name}:")
            for d in ds:
                print(f"    {d}")
    else:
        print("结构差异: 无 —— 全部表 列/索引/主键/外键 与 schema.sql 一致")
finally:
    # ---------- 5. 清理影子表 ----------
    dropped = 0
    for name in created:
        try:
            run(f"DROP TABLE IF EXISTS `{PREFIX}{name}`")
            dropped += 1
        except RuntimeError as e:
            print(f"[清理失败] {PREFIX}{name}: {e}")
    # 兜底：扫一遍残留
    leftover = sql(
        f"SELECT table_name FROM information_schema.tables "
        f"WHERE table_schema='{DB}' AND table_name LIKE '{PREFIX}%'"
    )
    print(f"\n影子表已清理 {dropped} 张；残留 {len(leftover)} 张")
