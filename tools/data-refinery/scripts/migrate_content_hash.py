"""把 questions.content_hash 迁移到「题干 + 选项」口径。

背景（2026-10-31）：原口径只哈希题干，`下列说法正确的是` 这类题（物理/化学常见）
题干相同、选项不同，会被判成同一题——而 questions.content_hash 上有唯一索引，
后一道题直接插不进去，整卷少题（北师大实验卷实测 34→33）。

本脚本：
1. 读出全部题目，按新口径 content_hash(content, options) 重算；
2. 先做冲突检测：两行算出同一哈希 => 说明是真正的重复题，打印后中止（不静默合并）；
3. 两段式更新（先写临时唯一值，再写最终值），避免中途撞唯一索引；
4. 默认只预览，`--apply` 才写库。

用法：
    python3 scripts/migrate_content_hash.py            # 预览
    python3 scripts/migrate_content_hash.py --apply    # 执行
"""

import argparse
import hashlib
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import pymysql  # noqa: E402

from config import RefineryConfig  # noqa: E402
from db_loader import content_hash  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="真正写库（默认只预览）")
    parser.add_argument("--limit", type=int, help="只处理前 N 行（调试用）")
    args = parser.parse_args()

    cfg = RefineryConfig.from_env()
    conn = pymysql.connect(host=cfg.db_host, port=cfg.db_port, user=cfg.db_user,
                           password=cfg.db_pass, database=cfg.db_name, charset="utf8mb4",
                           autocommit=False)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, content, options, content_hash FROM questions ORDER BY id")
            rows = cur.fetchall()
            if args.limit:
                rows = rows[: args.limit]

            planned: list[tuple[int, str, str]] = []
            by_new: dict[str, list[int]] = defaultdict(list)
            for qid, content, options, old in rows:
                new = content_hash(content, options)
                planned.append((int(qid), new, old))
                by_new[new].append(int(qid))

            conflicts = {h: ids for h, ids in by_new.items() if len(ids) > 1}
            changed = [p for p in planned if p[2] != p[1]]
            print(f"[scan] 题目 {len(rows)} 条；需要改哈希 {len(changed)} 条；"
                  f"冲突组 {len(conflicts)} 组")
            if conflicts:
                print("[abort] 以下题目的「题干+选项」完全相同，属真重复，需人工决定合并哪个：")
                for h, ids in list(conflicts.items())[:20]:
                    print(f"   hash={h[:12]}… question_id={ids}")
                return 1

            if not args.apply:
                for qid, new, old in changed[:5]:
                    print(f"   预览：#{qid} {str(old)[:12]}… -> {new[:12]}…")
                print("[dry-run] 确认后加 --apply")
                return 0

            # 两段式：先写成只与 id 相关的临时值，避免中途撞唯一索引
            for qid, _new, _old in changed:
                tmp = hashlib.sha256(f"tmp-migrate-{qid}".encode()).hexdigest()
                cur.execute("UPDATE questions SET content_hash=%s WHERE id=%s", (tmp, qid))
            for qid, new, _old in changed:
                cur.execute("UPDATE questions SET content_hash=%s WHERE id=%s", (new, qid))
        conn.commit()
        print(f"[ok] 已更新 {len(changed)} 条")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
