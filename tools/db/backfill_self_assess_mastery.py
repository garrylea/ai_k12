#!/usr/bin/env python3
"""历史主观题自评 → 掌握度一次性回填（2026-11-07）。

## 为什么需要

2026-11-07 用户裁决：**自评题也要进入薄弱点图谱**。正向链路已改为
`recordSelfAssessment` → `MasteryService.recordFromSelfAssessment`，但历史自评只落在
`question_self_assessments` 留痕表里，掌握度从未回写，图谱读不到。

本脚本把历史自评补进 `student_knowledge_mastery`，口径与线上完全一致：
  - **每条自评留痕算一次**（correct → 正确 +1，incorrect → 错误 +1）；
  - 只算题目**现在**有 `question_knowledge_points` 关联的（没关联的进不了图谱）；
  - `mastery_score = 正确 / (正确 + 错误)`，`level = FLOOR(5 * score)`。

## 一条命令

    python3 tools/db/backfill_self_assess_mastery.py

默认 **先备份、再写入、最后复查**；`--dry-run` 只预览不写。
幂等状态文件 `tools/db/backups/self_assess_mastery_backfill_state.json`
按 `question_self_assessments.id` 去重，同一行不会重复回填；`--force` 强制重跑。

## 安全边界

- **全学科**（自评留痕里数学/语文/物理都有；掌握度表本身不分学科）。
- 只做**加法**：已有行在旧计数上累加，不覆盖、不删除。
- 写库前把受影响学生的**全部掌握度行**（不限学科）导出到 `tools/db/backups/`。
- 变式/补偿套题的自评**不写** `question_self_assessments`，因此历史无法回填；
  它们从今往后的新自评会由正向链路写入。
"""

import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

import pymysql

REPO = Path(__file__).resolve().parents[2]
BACKUP_DIR = Path(__file__).resolve().parent / "backups"
STATE_FILE = BACKUP_DIR / "self_assess_mastery_backfill_state.json"
MIN_SAMPLE_SIZE = 5

DB = {
    "host": "localhost",
    "port": 3306,
    "user": "ai_k12",
    "password": "ai_k12",
    "database": "ai_k12",
    "charset": "utf8mb4",
}


def load_db_config() -> dict:
    env_file = REPO / "apps" / "server" / ".env"
    if env_file.is_file():
        env = {}
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            env[key] = value
        DB.update(
            host=env.get("DB_HOST", DB["host"]),
            port=int(env.get("DB_PORT", DB["port"])),
            user=env.get("DB_USER", DB["user"]),
            password=env.get("DB_PASS", DB["password"]),
            database=env.get("DB_NAME", DB["database"]),
        )
    return DB


def load_state() -> dict:
    if not STATE_FILE.is_file():
        return {"applied_assessment_ids": [], "runs": []}
    try:
        return json.loads(STATE_FILE.read_text())
    except (OSError, json.JSONDecodeError):
        return {"applied_assessment_ids": [], "runs": []}


def save_state(state: dict) -> None:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n")


def fetch_eligible(conn, student_ids: set[int] | None) -> list[dict]:
    where = ["1 = 1"]
    params: list = []
    if student_ids:
        where.append(f"qsa.student_id IN ({','.join(['%s'] * len(student_ids))})")
        params.extend(sorted(student_ids))

    sql = f"""
        SELECT qsa.id AS assessment_id,
               qsa.student_id,
               qsa.question_id,
               qkp.knowledge_point_id,
               qsa.assessment,
               qsa.created_at AS judged_at
          FROM question_self_assessments qsa
          JOIN question_knowledge_points qkp ON qkp.question_id = qsa.question_id
         WHERE {' AND '.join(where)}
         ORDER BY qsa.student_id, qsa.id, qkp.knowledge_point_id
    """
    with conn.cursor(pymysql.cursors.DictCursor) as cur:
        cur.execute(sql, params)
        return list(cur.fetchall())


def aggregate(rows: list[dict]) -> dict[int, dict[int, dict]]:
    out: dict[int, dict[int, dict]] = defaultdict(lambda: defaultdict(
        lambda: {"correct": 0, "error": 0, "last_seen": None}
    ))
    for row in rows:
        cell = out[int(row["student_id"])][int(row["knowledge_point_id"])]
        if row["assessment"] == "correct":
            cell["correct"] += 1
        else:
            cell["error"] += 1
        seen = row["judged_at"]
        if seen and (cell["last_seen"] is None or seen > cell["last_seen"]):
            cell["last_seen"] = seen
    return out


def fetch_existing(conn, student_ids: set[int]) -> dict[int, dict[int, dict]]:
    if not student_ids:
        return {}
    sql = f"""
        SELECT student_id, knowledge_point_id, correct_count, error_count,
               mastery_score, level, last_seen_at
          FROM student_knowledge_mastery
         WHERE student_id IN ({','.join(['%s'] * len(student_ids))})
    """
    with conn.cursor(pymysql.cursors.DictCursor) as cur:
        cur.execute(sql, sorted(student_ids))
        out: dict[int, dict[int, dict]] = defaultdict(dict)
        for row in cur.fetchall():
            out[int(row["student_id"])][int(row["knowledge_point_id"])] = row
        return out


def projected(existing: dict, delta: dict) -> dict:
    correct = int(existing.get("correct_count") or 0) + delta["correct"]
    error = int(existing.get("error_count") or 0) + delta["error"]
    total = correct + error
    return {
        "correct": correct,
        "error": error,
        "samples": total,
        "score": correct / total if total else 0.0,
        "level": int(5 * correct / total) if total else 0,
    }


def backup(conn, student_ids: set[int]) -> Path:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    path = BACKUP_DIR / f"{stamp}_mastery_before_self_assess.json"
    sql = f"""
        SELECT skm.*
          FROM student_knowledge_mastery skm
         WHERE skm.student_id IN ({','.join(['%s'] * len(student_ids))})
         ORDER BY skm.student_id, skm.knowledge_point_id
    """
    with conn.cursor(pymysql.cursors.DictCursor) as cur:
        cur.execute(sql, sorted(student_ids))
        rows = list(cur.fetchall())
    payload = {
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "student_ids": sorted(student_ids),
        "rows": rows,
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, default=str) + "\n")
    return path


UPSERT_SQL = """
INSERT INTO student_knowledge_mastery
  (student_id, knowledge_point_id, correct_count, error_count, mastery_score, level, last_seen_at)
VALUES (%s, %s, %s, %s, %s, %s, %s) AS new
ON DUPLICATE KEY UPDATE
  correct_count = student_knowledge_mastery.correct_count + new.correct_count,
  error_count   = student_knowledge_mastery.error_count   + new.error_count,
  mastery_score = student_knowledge_mastery.correct_count
                / NULLIF(student_knowledge_mastery.correct_count + student_knowledge_mastery.error_count, 0),
  level         = FLOOR(5 * (student_knowledge_mastery.correct_count
                / NULLIF(student_knowledge_mastery.correct_count + student_knowledge_mastery.error_count, 0))),
  last_seen_at  = GREATEST(COALESCE(student_knowledge_mastery.last_seen_at, '1970-01-01'),
                           new.last_seen_at)
"""


def apply(conn, agg: dict[int, dict[int, dict]]) -> None:
    with conn.cursor() as cur:
        for student_id, per_kp in agg.items():
            for kp_id, delta in per_kp.items():
                total = delta["correct"] + delta["error"]
                score = delta["correct"] / total if total else 0
                level = int(5 * score) if total else 0
                cur.execute(
                    UPSERT_SQL,
                    (
                        student_id,
                        kp_id,
                        delta["correct"],
                        delta["error"],
                        round(score, 3),
                        level,
                        delta["last_seen"],
                    ),
                )


def fetch_kp_names(conn, kp_ids: set[int]) -> dict[int, str]:
    if not kp_ids:
        return {}
    sql = f"SELECT id, name FROM knowledge_points WHERE id IN ({','.join(['%s'] * len(kp_ids))})"
    with conn.cursor(pymysql.cursors.DictCursor) as cur:
        cur.execute(sql, sorted(kp_ids))
        return {int(r["id"]): r["name"] for r in cur.fetchall()}


def print_preview(conn, agg, existing, student_ids) -> None:
    names = fetch_kp_names(conn, {kp for per_kp in agg.values() for kp in per_kp})
    for student_id in sorted(student_ids):
        per_kp = agg.get(student_id, {})
        pairs = sum(v["correct"] + v["error"] for v in per_kp.values())
        qualified = []
        for kp_id, delta in per_kp.items():
            merged = projected(existing.get(student_id, {}).get(kp_id, {}), delta)
            if merged["samples"] >= MIN_SAMPLE_SIZE:
                qualified.append((kp_id, merged))
        print(
            f"学生 {student_id}: 回填 {pairs} 个知识点样本 / {len(per_kp)} 个知识点；"
            f"回填后达到 {MIN_SAMPLE_SIZE} 题门槛的有 {len(qualified)} 个"
        )
        for kp_id, merged in sorted(qualified, key=lambda x: (x[1]["score"], -x[1]["samples"]))[:5]:
            print(
                f"  - {names.get(kp_id, kp_id)}: "
                f"{merged['correct']} 对 / {merged['error']} 错 = {merged['score']:.1%} "
                f"({merged['samples']} 题)"
            )


def verify(conn, student_ids: set[int]) -> None:
    sql = f"""
        SELECT skm.student_id, kp.subject_id, COUNT(*) rows_cnt,
               SUM(skm.correct_count + skm.error_count) samples,
               SUM(skm.correct_count + skm.error_count >= %s) qualified
          FROM student_knowledge_mastery skm
          JOIN knowledge_points kp ON kp.id = skm.knowledge_point_id
         WHERE skm.student_id IN ({','.join(['%s'] * len(student_ids))})
         GROUP BY skm.student_id, kp.subject_id
         ORDER BY skm.student_id, kp.subject_id
    """
    with conn.cursor(pymysql.cursors.DictCursor) as cur:
        cur.execute(sql, [MIN_SAMPLE_SIZE, *sorted(student_ids)])
        rows = list(cur.fetchall())
    print("写入后复查（掌握度）:")
    for row in rows:
        print(
            f"  学生 {row['student_id']} / 学科 {row['subject_id']}: "
            f"{row['rows_cnt']} 个知识点 / {row['samples']} 个样本 / "
            f"其中 {row['qualified']} 个达到 {MIN_SAMPLE_SIZE} 题门槛"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description="历史自评 → 掌握度一次性回填")
    parser.add_argument("--dry-run", action="store_true", help="只预览，不写库")
    parser.add_argument("--student", type=int, action="append", help="只处理指定学生（可重复）")
    parser.add_argument("--force", action="store_true", help="忽略幂等状态，强制重跑")
    args = parser.parse_args()

    conn = pymysql.connect(**load_db_config())
    try:
        state = load_state()
        applied = set() if args.force else {int(x) for x in state.get("applied_assessment_ids", [])}
        rows = fetch_eligible(conn, set(args.student) if args.student else None)
        all_ids = {int(r["assessment_id"]) for r in rows}
        fresh = [r for r in rows if int(r["assessment_id"]) not in applied]
        skipped = len(all_ids & applied)
        if skipped:
            print(f"幂等状态：跳过已回填的 {skipped} 条自评（同一条留痕只算一次）")
        if not fresh:
            print("没有需要回填的自评留痕。")
            return 0

        agg = aggregate(fresh)
        student_ids = set(agg)
        existing = fetch_existing(conn, student_ids)

        print(
            f"待回填：{len({int(r['assessment_id']) for r in fresh})} 条自评 / "
            f"{len(student_ids)} 个学生 / {sum(len(v) for v in agg.values())} 个知识点"
        )
        print_preview(conn, agg, existing, student_ids)

        if args.dry_run:
            print("dry-run：未写库。")
            return 0

        backup_path = backup(conn, student_ids)
        print(f"已备份原掌握度：{backup_path}")

        conn.begin()
        try:
            apply(conn, agg)
            conn.commit()
        except Exception:
            conn.rollback()
            raise

        state.setdefault("applied_assessment_ids", []).extend(int(r["assessment_id"]) for r in fresh)
        state["applied_assessment_ids"] = list(dict.fromkeys(state["applied_assessment_ids"]))
        state.setdefault("runs", []).append({
            "at": datetime.now().isoformat(timespec="seconds"),
            "assessments": len({int(r["assessment_id"]) for r in fresh}),
            "students": sorted(student_ids),
            "backup": backup_path.name,
        })
        save_state(state)
        print(f"幂等状态已更新：{STATE_FILE}")
        verify(conn, student_ids)
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
