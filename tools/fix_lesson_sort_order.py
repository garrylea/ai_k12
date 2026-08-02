"""
修复 lessons 表 sort_order 重复/错乱脚本。

用法:
  python fix_lesson_sort_order.py

逻辑：
  1. 对每个 unit_id，按 lesson name 中的章节编号重新排序
  2. 章综述（如 "第二十一章 ..."）排第一，sort_order=0
  3. "N.M" / "N.M.K" 按数值排序（支持只有编号没有标题，如 "24.1"）
  4. 完全无编号的 lesson（如 "阅读与思考"）按内容首次出现的页码排序；
     页码也缺失的保持原相对顺序
  5. 更新 sort_order 为 0,1,2,...（连续无重复）
"""

import re
import os
import sys
from pathlib import Path

# 优先用项目根目录的 .env
dotenv_path = Path(__file__).resolve().parent.parent / "apps" / "server" / ".env"
if dotenv_path.exists():
    with open(dotenv_path) as f:
        for line in f:
            if "=" in line and not line.startswith("#"):
                k, v = line.strip().split("=", 1)
                os.environ.setdefault(k, v)

import pymysql

# ---------- 配置 ----------
DB_HOST = os.environ.get("DB_HOST", "localhost")
DB_PORT = int(os.environ.get("DB_PORT", "3306"))
DB_USER = os.environ.get("DB_USER", "root")
DB_PASS = os.environ.get("DB_PASSWORD", "")
DB_NAME = os.environ.get("DB_NAME", "k12")

# ---------- 解析规则 ----------
_SECTION_RE = re.compile(r"^(\d+)\.(\d+)(?:\.(\d+))?\b")
_OVERVIEW_RE = re.compile(r"^第[一二三四五六七八九十百零]+章\s+")
_PAGE_NUM_RE = re.compile(r"(\d+)")


def parse_name(name: str) -> tuple:
    """返回基础排序键 (category, chapter, main_sec, sub_sec)
    category: 0=综述/有编号, 1=无编号(需页码兜底), 2=空名
    """
    if not name:
        return (2, 0, 0, 0)
    if _OVERVIEW_RE.match(name):
        return (0, 0, 0, 0)
    m = _SECTION_RE.match(name)
    if m:
        chap = int(m.group(1))
        main = int(m.group(2))
        sub = int(m.group(3)) if m.group(3) else 0
        return (0, chap, main, sub)
    return (1, 0, 0, 0)


def extract_page_num(textbook_page: str | None) -> int:
    if not textbook_page:
        return 999999
    m = _PAGE_NUM_RE.search(textbook_page)
    return int(m.group(1)) if m else 999999


def fix_sort_order(conn):
    with conn.cursor() as cur:
        # 1. 查出所有 unit_id
        cur.execute("SELECT DISTINCT unit_id FROM lessons ORDER BY unit_id")
        unit_ids = [row[0] for row in cur.fetchall()]

        total_units = len(unit_ids)
        total_lessons = 0
        fixed_units = 0

        for unit_id in unit_ids:
            cur.execute(
                "SELECT id, name, sort_order FROM lessons WHERE unit_id = %s",
                (unit_id,),
            )
            rows = cur.fetchall()
            if len(rows) <= 1:
                continue

            lesson_ids = [r[0] for r in rows]
            # 查询每个 lesson 关联 cards 的最小页码
            page_map: dict[int, int] = {}
            if lesson_ids:
                placeholders = ",".join(["%s"] * len(lesson_ids))
                cur.execute(
                    f"SELECT lesson_id, MIN(textbook_page) FROM cards WHERE lesson_id IN ({placeholders}) GROUP BY lesson_id",
                    tuple(lesson_ids),
                )
                for lid, tp in cur.fetchall():
                    page_map[lid] = extract_page_num(tp)

            # 组装排序键：(category, chap, main, sub, page, old_so)
            rows_with_key = []
            for rid, name, old_so in rows:
                cat, chap, main, sub = parse_name(name)
                page = page_map.get(rid, 999999)
                if cat == 0:
                    sort_key = (0, chap, main, sub, 0, old_so)
                else:
                    sort_key = (1, 0, 0, 0, page, old_so)
                rows_with_key.append((rid, name, old_so, sort_key))

            rows_with_key.sort(key=lambda x: x[3])

            # 检查是否真的需要修复
            current_orders = [r[2] for r in rows_with_key]
            expected_orders = list(range(len(rows_with_key)))
            if current_orders == expected_orders:
                continue

            # 更新
            for new_order, (rid, name, so, key) in enumerate(rows_with_key):
                if so != new_order:
                    cur.execute(
                        "UPDATE lessons SET sort_order = %s WHERE id = %s",
                        (new_order, rid),
                    )
                    total_lessons += 1

            fixed_units += 1

        conn.commit()

        print(f"共检查 {total_units} 个 unit")
        print(f"修复了 {fixed_units} 个 unit 的 sort_order")
        print(f"涉及 {total_lessons} 条 lessons 记录")


def preview_unit(conn, unit_id: int):
    """预览某个 unit 修复前后的顺序对比"""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, name, sort_order FROM lessons WHERE unit_id = %s ORDER BY sort_order, id",
            (unit_id,),
        )
        before = cur.fetchall()

        lesson_ids = [r[0] for r in before]
        page_map: dict[int, int] = {}
        if lesson_ids:
            placeholders = ",".join(["%s"] * len(lesson_ids))
            cur.execute(
                f"SELECT lesson_id, MIN(textbook_page) FROM cards WHERE lesson_id IN ({placeholders}) GROUP BY lesson_id",
                tuple(lesson_ids),
            )
            for lid, tp in cur.fetchall():
                page_map[lid] = extract_page_num(tp)

        rows_with_key = []
        for rid, name, old_so in before:
            cat, chap, main, sub = parse_name(name)
            page = page_map.get(rid, 999999)
            if cat == 0:
                sort_key = (0, chap, main, sub, 0, old_so)
            else:
                sort_key = (1, 0, 0, 0, page, old_so)
            rows_with_key.append((rid, name, old_so, sort_key))

        rows_with_key.sort(key=lambda x: x[3])

        print(f"\n--- unit_id={unit_id} 预览 ---")
        print(f"{'id':>5} | {'当前 so':>7} | {'修复后 so':>9} | {'页码':>6} | name")
        print("-" * 70)
        for new_order, (rid, name, so, key) in enumerate(rows_with_key):
            page_disp = str(key[4]) if key[0] == 1 else "-"
            mark = " *" if so != new_order else ""
            print(f"{rid:>5} | {so:>7} | {new_order:>9} | {page_disp:>6} | {name}{mark}")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="修复 lessons sort_order")
    parser.add_argument("--preview", type=int, help="仅预览指定 unit_id 的修复效果，不写入 DB")
    parser.add_argument("--commit", action="store_true", help="确认写入数据库（默认只读模式）")
    args = parser.parse_args()

    conn = pymysql.connect(
        host=DB_HOST, port=DB_PORT, user=DB_USER,
        password=DB_PASS, database=DB_NAME, charset="utf8mb4",
    )

    try:
        if args.preview:
            preview_unit(conn, args.preview)
        else:
            if not args.commit:
                print("⚠️  这是只读预览模式。若确认修复，请加上 --commit 参数。\n")
                # 只预览前 3 个需要修复的 unit
                with conn.cursor() as cur:
                    cur.execute("SELECT DISTINCT unit_id FROM lessons ORDER BY unit_id")
                    previewed = 0
                    for (uid,) in cur.fetchall():
                        cur.execute(
                            "SELECT id, name, sort_order FROM lessons WHERE unit_id = %s",
                            (uid,),
                        )
                        rows = cur.fetchall()
                        if len(rows) > 1:
                            preview_unit(conn, uid)
                            previewed += 1
                            if previewed >= 3:
                                break
                print("\n使用 --commit 参数执行实际修复。")
            else:
                fix_sort_order(conn)
    finally:
        conn.close()
