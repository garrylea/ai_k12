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
- **review 清单只追加**：`output/material_inline_review.jsonl` 与 publish 共用，`--apply` 追加、
  不截断；无待复核行时不碰该文件。
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import date, datetime
from pathlib import Path

import pymysql
from pymysql.converters import escape_string

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "data-refinery" / "src"))

from chinese_material_doc import (  # noqa: E402
    append_skipped_report,
    build_groups,
    choose_canonical,
    is_heading_only,
    material_group_reason,
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


def build_plans(rows: list[dict], *, apply: bool,
                skipped_out: list[dict] | None = None) -> tuple[list[list], list[dict]]:
    """纯计划构建（可测试）。apply=False 时只算 key/url，不写文件。

    ``skipped_out`` 非 None 时，把「不像文章」的组写进去（保留 material_text
    原样、不改库），供 main() 落 ``material_group_skipped.jsonl``。
    """
    group_rows = eligible_for_article(rows)
    groups = build_groups(group_rows)
    plans: list[list] = []  # [qid, material_url, material_text, content, material_method, new_hash]
    skipped_ids: set[int] = set()
    for members in groups.values():
        canonical = choose_canonical([m.get("material_text") or "" for m in members])
        if is_heading_only(canonical):
            continue
        reason = material_group_reason(canonical)
        if reason:
            skipped_ids.update(m["id"] for m in members)
            if skipped_out is not None:
                skipped_out.append({
                    "paper_id": members[0].get("paper_id"),
                    "source": members[0].get("source"),
                    "ids": [m["id"] for m in members],
                    "reason": reason,
                    "excerpt": canonical[:200],
                })
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
        if row["id"] in skipped_ids:
            # 材料不像文章、要原样保留；再切题中素材会覆盖它且没留 URL（数据丢失）
            continue
        mt = row.get("material_text") or ""
        if mt.strip() and is_heading_only(mt) and row["id"] not in by_id:
            # 与 publish 同口径：纯标题旧材料清掉，不建文档；但仍要继续抽题中素材
            plans.append([row["id"], row.get("material_url"), None, None, None])
            by_id[row["id"]] = plans[-1]
        material, rest = split_inline_material(row.get("content") or "")
        if material:
            plan = by_id.get(row["id"])
            if plan is None:
                # 保留已有 material_url（共享文章）：这题可能既有文章又有题中素材
                # （如「根据《曹刿论战》及下面的材料」），只补 material_text，
                # 不能把文章 URL 写成 NULL（2026-11-21 修：否则 Q15 文章链接被抹掉）。
                plan = [row["id"], row.get("material_url"), None, None, None]
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


def rollback_sql(plans: list[list], rows: list[dict]) -> str:
    """生成一段可回滚 SQL（append 到当天文件，不覆盖之前 run）。"""
    by_id = {r["id"]: r for r in rows}
    lines = [
        "SET NAMES utf8mb4;",
        f"-- run {datetime.now():%Y-%m-%dT%H:%M:%S} ({len(plans)} rows)",
    ]
    for qid, *_ in plans:
        r = by_id[qid]
        lines.append(
            "UPDATE questions SET "
            f"content={_sql_literal(r.get('content'))}, "
            f"material_text={_sql_literal(r.get('material_text'))}, "
            f"material_url={_sql_literal(r.get('material_url'))}, "
            f"material_method={_sql_literal(r.get('material_method'))}, "
            f"content_hash={_sql_literal(r.get('content_hash'))} WHERE id={qid};"
        )
    return "\n".join(lines) + "\n"


def apply_plan(cur, plan: list) -> bool:
    """执行一条计划；content_hash 冲突时保留旧 hash，其余列仍写入。返回是否冲突。"""
    qid, url, mtext, content, method, new_hash = plan
    try:
        cur.execute(
            "UPDATE questions SET material_url=%s, material_text=%s, "
            "content=COALESCE(%s, content), material_method=%s, content_hash=%s "
            "WHERE id=%s",
            (url, mtext, content, method, new_hash, qid),
        )
        return False
    except pymysql.err.IntegrityError:
        cur.execute(
            "UPDATE questions SET material_url=%s, material_text=%s, "
            "content=COALESCE(%s, content), material_method=%s WHERE id=%s",
            (url, mtext, content, method, qid),
        )
        return True


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

        skipped: list[dict] = []
        plans, review = build_plans(rows, apply=ns.apply, skipped_out=skipped)
        reasons = dict(Counter(s["reason"] for s in skipped))
        if not ns.apply:
            print(f"[dry-run] {len(plans)} rows would change; {len(review)} need review; "
                  f"{len(skipped)} groups kept as material_text {reasons}")
            return 0
        if not plans:
            print(f"[apply] 0 rows; nothing to do"
                  f"{f'（{len(skipped)} 组不像文章，保持原样）' if skipped else ''}")
            return 0

        backup = BACKUP_DIR / f"{date.today():%Y%m%d}_material_doc_rollback.sql"
        backup.parent.mkdir(parents=True, exist_ok=True)
        with backup.open("a", encoding="utf-8") as f:
            f.write(rollback_sql(plans, rows))

        failed = sum(1 for plan in plans if apply_plan(cur, plan))
        conn.commit()

        # 只追加，不清空：publish 也往同一文件写，截断会抹掉它的清单
        if review:
            review_path = Path(ASSETS).parent / "material_inline_review.jsonl"
            with review_path.open("a", encoding="utf-8") as f:
                for rec in review:
                    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        append_skipped_report(
            Path(ASSETS).parent / "material_group_skipped.jsonl", skipped)
        print(f"[apply] {len(plans)} rows updated ({failed} hash conflicts); "
              f"{len(skipped)} groups kept as material_text {reasons}; rollback: {backup}")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
