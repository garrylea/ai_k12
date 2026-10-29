"""把 labeling_issues.jsonl 里记录过的「LLM 修复题」置为待复核（is_active=0）。

背景：`is_complete=false` 的题会用 LLM 补全缺失的选项/材料，但实测会编造原文没有的
内容（大兴题12 补出「D.三人都正确」、房山题25 补出「D.…放弃奋斗」）。这类题保留在库里
留档，但默认不进练习抽题池（抽题 SQL 过滤 `is_active=1`），人工复核后再手动置 1。

用法（cd tools/data-refinery）：
    python mark_needs_review.py                     # dry-run，只统计
    python mark_needs_review.py --apply             # 写库
    python mark_needs_review.py --issues output/labeling_issues.jsonl --apply
"""

import argparse
import json
import os
import sys
from pathlib import Path

import pymysql

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

from config import RefineryConfig  # noqa: E402

DEFAULT_ISSUES = "output/labeling_issues.jsonl"


def load_pairs(path: Path) -> list[tuple[str, int]]:
    """从 issues 里取出去重的 (source, group_order)。"""
    pairs: list[tuple[str, int]] = []
    seen: set[tuple[str, int]] = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
            source = str(row.get("source") or "").strip()
            order = int(row.get("group_order"))
        except (ValueError, TypeError, json.JSONDecodeError):
            continue
        if not source:
            continue
        key = (source, order)
        if key not in seen:
            seen.add(key)
            pairs.append(key)
    return pairs


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="把 AI 修复题置为待复核（is_active=0）")
    parser.add_argument("--issues", default=DEFAULT_ISSUES, help=f"默认 {DEFAULT_ISSUES}")
    parser.add_argument("--apply", action="store_true", help="实际写库（默认 dry-run）")
    args = parser.parse_args(argv)

    issues_path = Path(args.issues)
    if not issues_path.exists():
        print(f"[ERROR] 找不到 {issues_path}")
        return 2
    pairs = load_pairs(issues_path)
    print(f"issues: {issues_path} → {len(pairs)} 个 (source, 题号) 组合")

    cfg = RefineryConfig.from_env()
    conn = pymysql.connect(
        host=cfg.db_host, port=cfg.db_port, user=cfg.db_user,
        password=cfg.db_pass, database=cfg.db_name, charset="utf8mb4",
    )
    try:
        matched: list[int] = []
        already_off = 0
        with conn.cursor() as cur:
            for source, order in pairs:
                cur.execute(
                    "SELECT id, is_active FROM questions WHERE source=%s AND group_order=%s",
                    (source, order),
                )
                for qid, active in cur.fetchall():
                    if int(active) == 0:
                        already_off += 1
                    else:
                        matched.append(int(qid))
        unique_ids = sorted(set(matched))
        print(f"命中待处理 {len(unique_ids)} 题（已 inactive {already_off} 题）")
        if unique_ids:
            print("示例 qid:", unique_ids[:10])

        if not args.apply:
            print("（dry-run，未写库；确认后加 --apply）")
            return 0
        if not unique_ids:
            print("没有需要修改的题")
            return 0

        with conn.cursor() as cur:
            for i in range(0, len(unique_ids), 500):
                chunk = unique_ids[i:i + 500]
                placeholders = ",".join(["%s"] * len(chunk))
                cur.execute(
                    f"UPDATE questions SET is_active=0 WHERE id IN ({placeholders})", chunk,
                )
        conn.commit()
        print(f"已置 is_active=0：{len(unique_ids)} 题")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
