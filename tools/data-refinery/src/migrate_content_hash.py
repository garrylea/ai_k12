"""把 questions.content_hash 迁移到「题干 + 选项 + 材料」口径。

背景（2026-10-31）：原口径只哈希题干，`下列说法正确的是` 这类题（物理/化学常见）
题干相同、选项不同，会被判成同一题——而 questions.content_hash 上有唯一索引，
后一道题直接插不进去，整卷少题（北师大实验卷实测 34→33）。

本脚本：
1. 读出全部题目，按新口径重算；
2. 冲突处理（2026-11-21 改）：**跨卷同题是正常业务**（同一道题挂两张卷），
   不再整体中止。每个「新哈希相同」的组只让一行拿到该哈希：
   - 组内已有行等于目标哈希（上次迁移留下的）→ 保留它，其余保持旧值；
   - 否则 id 最小的一行更新，其余保持旧值；
   被保留旧值的行写进 `output/content_hash_conflicts.jsonl` 供人工核对。
3. 两段式更新（先写临时唯一值，再写最终值），避免中途撞唯一索引；
4. 默认只预览，`--apply` 才写库。

用法：
    python3 src/migrate_content_hash.py            # 预览
    python3 src/migrate_content_hash.py --apply    # 执行
"""

import argparse
import hashlib
import json
from collections import defaultdict
from datetime import datetime
from pathlib import Path

import pymysql

from config import RefineryConfig
from db_loader import content_hash

ROOT = Path(__file__).resolve().parents[1]
CONFLICT_FILE = ROOT / "output" / "content_hash_conflicts.jsonl"


def plan_updates(rows) -> tuple[list[tuple[int, str, str]], list[dict]]:
    """纯计划：返回 (需要写库的行, 冲突组)。

    ``rows``: ``[(id, content, options, old_hash, material_text, material_url)]``。
    ``updates``: ``[(id, new_hash, old_hash)]``。
    冲突组里除 winner 外的行保持旧哈希、不写库。
    """
    planned: list[tuple[int, str, str]] = []
    by_new: dict[str, list[int]] = defaultdict(list)
    for qid, content, options, old, material, material_url in rows:
        qid = int(qid)
        new = content_hash(content, options, material, material_url)
        planned.append((qid, new, old))
        by_new[new].append(qid)

    old_by_id = {qid: old for qid, _new, old in planned}
    conflicts: list[dict] = []
    kept: set[int] = set()
    for h, ids in by_new.items():
        if len(ids) < 2:
            continue
        already = [i for i in ids if old_by_id.get(i) == h]
        winner = min(already) if already else min(ids)
        keep = [i for i in ids if i != winner]
        kept.update(keep)
        conflicts.append({"hash": h, "ids": ids, "winner": winner, "kept_old": keep})

    updates = [(qid, new, old) for qid, new, old in planned
               if new != old and qid not in kept]
    return updates, conflicts


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
            cur.execute("SELECT id, content, options, content_hash, material_text, material_url "
                        "FROM questions ORDER BY id")
            rows = cur.fetchall()
            if args.limit:
                rows = rows[: args.limit]

            updates, conflicts = plan_updates(rows)
            kept_n = sum(len(c["kept_old"]) for c in conflicts)
            print(f"[scan] 题目 {len(rows)} 条；需要改哈希 {len(updates)} 条；"
                  f"冲突组 {len(conflicts)} 组（保留旧哈希 {kept_n} 条）")
            for c in conflicts[:10]:
                print(f"   冲突 hash={c['hash'][:12]}… ids={c['ids']} "
                      f"保留 winner={c['winner']}，其余保持旧值")

            if not args.apply:
                for qid, new, old in updates[:5]:
                    print(f"   预览：#{qid} {str(old)[:12]}… -> {new[:12]}…")
                print("[dry-run] 确认后加 --apply")
                return 0

            # 两段式：先写成只与 id 相关的临时值，避免中途撞唯一索引
            for qid, _new, _old in updates:
                tmp = hashlib.sha256(f"tmp-migrate-{qid}".encode()).hexdigest()
                cur.execute("UPDATE questions SET content_hash=%s WHERE id=%s", (tmp, qid))
            for qid, new, _old in updates:
                cur.execute("UPDATE questions SET content_hash=%s WHERE id=%s", (new, qid))
        conn.commit()

        if conflicts:
            stamp = datetime.now().isoformat(timespec="seconds")
            CONFLICT_FILE.parent.mkdir(parents=True, exist_ok=True)
            with CONFLICT_FILE.open("w", encoding="utf-8") as f:
                for c in conflicts:
                    f.write(json.dumps({"run_at": stamp, **c}, ensure_ascii=False) + "\n")
            print(f"[warn] {len(conflicts)} 组冲突未合并（{kept_n} 条保持旧哈希），"
                  f"清单：{CONFLICT_FILE}")
        print(f"[ok] 已更新 {len(updates)} 条")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

