"""语文默写管线：把抽取产物入库（幂等）。

## 幂等策略

以 `dictation_passages` 的业务键 `(work_title, semester)` 作为篇目身份：
**先找既有 question_id，有则原地 UPDATE、无则 INSERT**。

**不用 `content_hash` 去重**——题面一旦调整（如上一阶段删掉「并写出作者与朝代」那段噪音），
hash 就变，按 hash 去重会插出**新行**并把旧行变孤儿；而且 `main_error_books.question_id`
外键是 `RESTRICT`，删旧行还可能被拦住。按业务键原地改，`question_id` 保持不变，
挂在它上面的错题本/隐藏题等数据都不受影响。

## 两条不要破坏的约定

- `memorize_required` 只在 INSERT 时写死 `0`，**`ON DUPLICATE KEY UPDATE` 里绝不出现它**：
  否则管线重跑会把用户已标好的「必背」刷回 0。
- `answer_verified` 写 `0`：管线提取的是原始数据，与人工/模型回写的答案区分开
  （沿用既有约定）。

## 与 TS 种子脚本的关系

`apps/server/src/scripts/seed-dictation-fixture.ts` 是**开发假数据**（`source='DEV-FIXTURE'`），
与本模块同构。真实内容覆盖到假数据行时**明确告警**，不静默盖掉。
"""

from __future__ import annotations

import json
from pathlib import Path

import pymysql


class DictationLoader:
    def __init__(self, host: str, port: int, user: str, password: str, db: str):
        self._conn = pymysql.connect(host=host, port=port, user=user,
                                     password=password, database=db, charset="utf8mb4")

    def close(self):
        self._conn.close()

    # ---- 低层 ----

    def _query(self, sql, args=None):
        with self._conn.cursor() as cur:
            cur.execute(sql, args)
            return cur.fetchall()

    def _exec(self, sql, args=None):
        with self._conn.cursor() as cur:
            cur.execute(sql, args)

    def _subject_id(self, code: str) -> int:
        rows = self._query("SELECT id FROM subjects WHERE code=%s LIMIT 1", (code,))
        if not rows:
            raise ValueError(f"subjects 表没有 code={code}")
        return int(rows[0][0])

    # ---- 主流程 ----

    def load_passages(self, items: list[dict]) -> dict:
        inserted = updated = upserted = 0
        for it in items:
            sid = self._subject_id(it["subject_id"])
            work_title = it["work_title"]
            semester = it["semester"]
            # 题面只放篇名：作者/朝代/正文都是要学生默写的**答案**，
            # 写进题面等于泄题，也违反上一阶段定的约定。
            content = f"请默写《{work_title}》"
            answer = (f"作者：{it.get('author') or ''}\n"
                      f"朝代：{it.get('dynasty') or ''}\n"
                      f"正文：{it['body']}")

            existing = self._query(
                "SELECT dp.question_id, q.source FROM dictation_passages dp "
                "JOIN questions q ON q.id = dp.question_id "
                "WHERE dp.work_title=%s AND dp.semester=%s LIMIT 1",
                (work_title, semester),
            )
            if existing:
                question_id = int(existing[0][0])
                if existing[0][1] == "DEV-FIXTURE":
                    print(f"[WARN] 《{work_title}》原为 DEV-FIXTURE（开发假数据），"
                          f"将由真实内容覆盖", flush=True)
                # 原地改：question_id 不变，错题本/隐藏题等挂在它上面的数据不受影响
                self._exec(
                    "UPDATE questions SET subject_id=%s, type='poem_dictation', difficulty=2, "
                    "content=%s, answer=%s, grade_band=%s, source=%s, is_active=1 WHERE id=%s",
                    (sid, content, answer, it.get("grade_band"), it.get("source_ref"), question_id),
                )
                updated += 1
            else:
                self._exec(
                    "INSERT INTO questions (subject_id, type, difficulty, content, answer, "
                    "grade_band, source, answer_verified, is_active) "
                    "VALUES (%s,'poem_dictation',2,%s,%s,%s,%s,0,1)",
                    (sid, content, answer, it.get("grade_band"), it.get("source_ref")),
                )
                question_id = int(self._query("SELECT LAST_INSERT_ID()")[0][0])
                inserted += 1

            # memorize_required 只在这里写 0；ON DUPLICATE KEY UPDATE 里不出现它
            self._exec(
                "INSERT INTO dictation_passages (question_id, work_title, author, dynasty, body, "
                "grade_band, grade, semester, sort_order, source_ref, verified, memorize_required) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,0) "
                "ON DUPLICATE KEY UPDATE question_id=VALUES(question_id), author=VALUES(author), "
                "dynasty=VALUES(dynasty), body=VALUES(body), grade_band=VALUES(grade_band), "
                "grade=VALUES(grade), sort_order=VALUES(sort_order), source_ref=VALUES(source_ref), "
                "verified=VALUES(verified)",
                (question_id, work_title, it.get("author") or "", it.get("dynasty") or "", it["body"],
                 it.get("grade_band"), it.get("grade"), semester, it.get("_sort_order", 0),
                 it.get("source_ref"), int(it.get("verified", 1))),
            )
            upserted += 1

        self._conn.commit()
        return {"inserted": inserted, "updated": updated, "passages_upserted": upserted}

    @staticmethod
    def read_jsonl(path) -> list[dict]:
        """读抽取产物的 JSONL。带下划线的内部字段（`_locate_notes` 等）原样保留，
        入库只取契约字段，互不干扰。"""
        return [json.loads(l) for l in
                Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]
