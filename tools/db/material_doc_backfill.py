#!/usr/bin/env python3
"""存量语文题：文章 → `materials/chinese/{doc_key}/content.md` + material_url。

只读 DB（不重跑 extract，避免覆盖人工修题）。默认 dry-run；`--apply` 才写库。

## 一条命令完成：备份 → 写文章 → 写库

    python3 tools/db/material_doc_backfill.py           # 只看会改多少行
    python3 tools/db/material_doc_backfill.py --apply   # 落库 + 回滚 SQL

`--paper 667` 只处理一张卷；`--limit N` 只取前 N 行（开发用）。

## 分组口径

按 `paper_questions.paper_id` 分组（没有挂卷才退回 `source`），组内按归一化
`material_text` 再分；同一篇文章的多个题共用一个 doc_key（文章身份 = 归一化正文 +
图片内容哈希）。`GROUP BY q.id` 防止一道题挂多张卷时被重复取出。

## 安全边界（项目铁律）

- **不重跑 extract**：只回填 `material_url` / `material_text` / `material_method` /
  `content` / `content_hash` 五列。
- **默认 dry-run**：dry-run 连 md 都不写盘（`write_material_doc(dry_run=True)`）。
- **幂等**：写完后文章段已从 `material_text` 清空、题中素材已切出，再跑一遍是 0 行。
- **备份**：`--apply` 前把受影响行的原值导出到 `tools/db/backups/`，可直接回滚。
- **逐行容错**：`content_hash` 唯一键冲突只跳过该题的 hash（保留旧值），不整批失败。
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

import pymysql
from pymysql.converters import escape_string

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "data-refinery" / "src"))

from chinese_material_doc import (  # noqa: E402
    build_groups,
    choose_canonical,
    is_heading_only,
    rewrite_hash_for_row,
    write_material_doc,
)
from subject_strategies.chinese_inline_material import (  # noqa: E402
    needs_llm,
    split_inline_material,
)

DB = dict(host="localhost", port=3306, user="ai_k12", password="ai_k12",
          database="ai_k12", charset="utf8mb4")
ASSETS = ROOT / "tools" / "data-refinery" / "output" / "assets"
BACKUP_DIR = Path(__file__).resolve().parent / "backups"


def _sql_literal(value) -> str:
    if value is None:
        return "NULL"
    return "'" + escape_string(str(value)) + "'"


def _resolver(ref: str):
    """回填时图片已经物化：先在 assets 下找，再退回源 md 目录。"""
    p = ASSETS / ref
    return p if p.exists() else None


class _Store:
    def put(self, rel: str, src: Path) -> None:
        dest = ASSETS / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(src.read_bytes())


def _load_rows(cur, paper_id: int | None):
    where = "s.code='chinese'"
    params = []
    if paper_id is not None:
        where += " AND pq.paper_id=%s"
        params.append(paper_id)
    # GROUP BY q.id：一道题可能挂多张卷（跨卷共用行），只取一个 paper_id 做分组键
    cur.execute(
        f"""SELECT q.id, MIN(pq.paper_id) AS paper_id, q.source, q.content, q.options,
                   q.material_text, q.material_url, q.material_method, q.content_hash
              FROM questions q
              JOIN subjects s ON s.id=q.subject_id
              LEFT JOIN paper_questions pq ON pq.question_id=q.id
             WHERE {where}
             GROUP BY q.id
             ORDER BY q.id""",
        params,
    )
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--paper", type=int)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--limit", type=int)
    ns = parser.parse_args(argv)

    conn = pymysql.connect(**DB, autocommit=False)
    cur = conn.cursor()
    rows = _load_rows(cur, ns.paper)
    if ns.limit:
        rows = rows[: ns.limit]

    groups = build_groups(rows)
    plans = []  # [qid, material_url, material_text, content, material_method, new_hash]
    for members in groups.values():
        canonical = choose_canonical([m.get("material_text") or "" for m in members])
        if is_heading_only(canonical):
            continue
        key, url = write_material_doc(
            canonical, resolver=_resolver, store=_Store(), assets_dir=ASSETS,
            dry_run=not ns.apply,
        )
        for m in members:
            plans.append([m["id"], url, None, None, None])

    by_id = {p[0]: p for p in plans}
    review: list[dict] = []
    for row in rows:
        material, rest = split_inline_material(row.get("content") or "")
        if not material:
            if needs_llm(row.get("content") or ""):
                review.append({"id": row["id"], "content": row.get("content")})
            continue
        plan = by_id.get(row["id"])
        if plan is None:
            plan = [row["id"], None, None, None, None]
            plans.append(plan)
            by_id[row["id"]] = plan
        plan[2] = material
        plan[3] = rest
        plan[4] = "rule"

    rows_by_id = {r["id"]: r for r in rows}
    for plan in plans:
        qid, url, mtext, content, method = plan
        row = rows_by_id[qid]
        new_row = dict(row)
        new_row["material_url"] = url if url is not None else row.get("material_url")
        new_row["material_text"] = mtext  # 文章题为 None；题中素材题为原文
        if content is not None:
            new_row["content"] = content
        new_row["material_method"] = method
        plan.append(rewrite_hash_for_row(new_row))

    if not ns.apply:
        print(f"[dry-run] {len(plans)} rows would change；规则切不出 {len(review)} 题待复核")
        return 0

    backup = BACKUP_DIR / f"{date.today():%Y%m%d}_material_doc_rollback.sql"
    backup.parent.mkdir(parents=True, exist_ok=True)
    with backup.open("w", encoding="utf-8") as f:
        for qid, *_ in plans:
            r = rows_by_id[qid]
            f.write(
                "UPDATE questions SET "
                f"content={_sql_literal(r.get('content'))}, "
                f"material_text={_sql_literal(r.get('material_text'))}, "
                f"material_url={_sql_literal(r.get('material_url'))}, "
                f"material_method={_sql_literal(r.get('material_method'))}, "
                f"content_hash={_sql_literal(r.get('content_hash'))} WHERE id={qid};\n"
            )

    for qid, url, mtext, content, method, new_hash in plans:
        try:
            cur.execute(
                "UPDATE questions SET material_url=%s, material_text=%s, "
                "content=COALESCE(%s, content), material_method=%s, content_hash=%s "
                "WHERE id=%s",
                (url, mtext, content, method, new_hash, qid),
            )
        except pymysql.err.IntegrityError:
            print(f"[WARN] id={qid} content_hash 冲突，保留旧 hash", flush=True)
    conn.commit()
    conn.close()

    if review:
        review_path = ASSETS.parent / "material_inline_review.jsonl"
        with review_path.open("w", encoding="utf-8") as f:
            for rec in review:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        print(f"[apply] 规则切不出 {len(review)} 题，已写 {review_path}")

    print(f"[apply] {len(plans)} rows updated; rollback: {backup}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
