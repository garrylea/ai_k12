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
- **幂等**：`material_method='rule'` 的行（已抽过题中素材）不再参与文章分组，否则第二次运行
  会把「文章 + 题中素材」的行当成文章组，清掉它已有的 `material_url`。
- **备份**：`--apply` 前把受影响行的原值**追加**到当日回滚文件（带 `-- run <时间戳>` 段头），
  同日多次运行互不覆盖；没有计划时不碰回滚文件。
- **逐行容错**：`content_hash` 唯一键冲突时保留旧 hash，其余四列照常写入，避免半回填。
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date, datetime
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


def eligible_for_article(rows: list[dict]) -> list[dict]:
    """已抽过题中素材的行不再参与文章分组（第二次运行必须 0 行）。"""
    return [r for r in rows if r.get("material_method") != "rule"]


def build_plans(rows: list[dict], *, apply: bool) -> tuple[list[list], list[dict]]:
    """纯计划构建（可测试）。apply=False 时只算 key/url，不写文件。"""
    group_rows = eligible_for_article(rows)
    groups = build_groups(group_rows)
    plans: list[list] = []  # [qid, material_url, material_text, content, material_method, new_hash]
    for members in groups.values():
        canonical = choose_canonical([m.get("material_text") or "" for m in members])
        if is_heading_only(canonical):
            continue
        key, url = write_material_doc(
            canonical, resolver=_resolver, store=_Store(), assets_dir=ASSETS,
            dry_run=not apply,
        )
        for m in members:
            plans.append([m["id"], url, None, None, None])

    by_id = {p[0]: p for p in plans}
    review: list[dict] = []
    for row in rows:
        if row.get("material_method") == "rule":
            continue  # 已处理：保证第二次运行幂等
        mt = row.get("material_text") or ""
        if mt.strip() and is_heading_only(mt) and row["id"] not in by_id:
            # 与 publish 同口径：纯标题旧材料清掉，不建文档
            plans.append([row["id"], row.get("material_url"), None, None, None])
            by_id[row["id"]] = plans[-1]
            continue
        material, rest = split_inline_material(row.get("content") or "")
        if material:
            plan = by_id.get(row["id"])
            if plan is None:
                plan = [row["id"], None, None, None, None]
                plans.append(plan)
                by_id[row["id"]] = plan
            plan[2] = material
            plan[3] = rest
            plan[4] = "rule"
        elif needs_llm(row.get("content") or ""):
            review.append({
                "id": row["id"],
                "paper_id": row.get("paper_id"),
                "source": row.get("source"),
                "content": row.get("content"),
            })

    for plan in plans:
        qid, url, mtext, content, method = plan
        row = next(r for r in rows if r["id"] == qid)
        new_row = dict(row)
        new_row["material_url"] = url if url is not None else row.get("material_url")
        new_row["material_text"] = mtext
        if content is not None:
            new_row["content"] = content
        new_row["material_method"] = method
        plan.append(rewrite_hash_for_row(new_row))
    return plans, review


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--paper", type=int)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--limit", type=int)
    ns = parser.parse_args(argv)

    conn = pymysql.connect(**DB, autocommit=False)
    cur = conn.cursor()
    try:
        rows = _load_rows(cur, ns.paper)
        if ns.limit:
            rows = rows[: ns.limit]

        plans, review = build_plans(rows, apply=ns.apply)
        if not ns.apply:
            print(f"[dry-run] {len(plans)} rows would change; {len(review)} need review")
            return 0
        if not plans:
            print("[apply] 0 rows; nothing to do")
            return 0

        backup = BACKUP_DIR / f"{date.today():%Y%m%d}_material_doc_rollback.sql"
        backup.parent.mkdir(parents=True, exist_ok=True)
        with backup.open("a", encoding="utf-8") as f:
            f.write(f"\n-- run {datetime.now():%Y-%m-%dT%H:%M:%S} ({len(plans)} rows)\n")
            f.write("SET NAMES utf8mb4;\n")
            for qid, *_ in plans:
                r = next(r for r in rows if r["id"] == qid)
                f.write(
                    "UPDATE questions SET "
                    f"content={_sql_literal(r.get('content'))}, "
                    f"material_text={_sql_literal(r.get('material_text'))}, "
                    f"material_url={_sql_literal(r.get('material_url'))}, "
                    f"material_method={_sql_literal(r.get('material_method'))}, "
                    f"content_hash={_sql_literal(r.get('content_hash'))} WHERE id={qid};\n"
                )

        failed = 0
        for qid, url, mtext, content, method, new_hash in plans:
            try:
                cur.execute(
                    "UPDATE questions SET material_url=%s, material_text=%s, "
                    "content=COALESCE(%s, content), material_method=%s, content_hash=%s "
                    "WHERE id=%s",
                    (url, mtext, content, method, new_hash, qid),
                )
            except pymysql.err.IntegrityError:
                # 冲突时保留旧 hash，但其余列必须写入，避免半回填
                cur.execute(
                    "UPDATE questions SET material_url=%s, material_text=%s, "
                    "content=COALESCE(%s, content), material_method=%s WHERE id=%s",
                    (url, mtext, content, method, qid),
                )
                print(f"[WARN] id={qid} content_hash 冲突，保留旧 hash，其余列已更新", flush=True)
                failed += 1
        conn.commit()

        review_path = Path(ASSETS).parent / "material_inline_review.jsonl"
        review_path.write_text(
            "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in review),
            encoding="utf-8",
        )
        print(f"[apply] {len(plans)} rows updated ({failed} hash conflicts); rollback: {backup}")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
