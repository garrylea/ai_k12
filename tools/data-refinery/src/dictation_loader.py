"""语文古诗文管线：把抽取产物入库（幂等）。

## 幂等策略

以 `chinese_passages` 的业务键 `(work_title, semester)` 作为篇目身份：
**先找既有行，有则原地 UPDATE、无则 INSERT**。

**不用 `content_hash` 去重**——题面一旦调整，hash 就变，按 hash 去重会插出**新行**。
按业务键原地改，行 id 保持不变。

## 独立化（2026-09-15）

古诗文专项已是**独立子系统**：**不挂 `questions`、不进错题本、不参与主线清零门禁**
（PRD §6.3 / §7.4）。故本模块：

- **不再写 `questions` 行**（原先每篇挂一行 `poem_dictation` 题作错题本/隐藏题锚点，
  这些用途已按设计整体移除）；
- **不再查 `subjects`**（原先为取 `subject_id`；表本身就是语文，无此列）。

设计见 docs/superpowers/specs/2026-09-15-chinese-interpretation-special-design.md §6。

## 两条不要破坏的约定

- `memorize_required` 只在 INSERT 时写死 `0`，**`ON DUPLICATE KEY UPDATE` 里绝不出现它**：
  否则管线重跑会把用户已标好的「必背」刷回 0。
- **`is_active` 同理，整条语句从不提及它**：新篇目靠 schema 默认值 `1` 落库，既有篇目则
  **保持人工设定的停用状态**——重跑管线不会把被停用的篇目悄悄复活。
  （与 `memorize_required` 是同一条原则：**管线不覆盖人工标定**。旧实现曾借 questions 的
  UPDATE 顺带置 `is_active=1`，独立化后那一路径整条消失，此处行为有意保持一致。）
- `verified` 由 JSONL 决定（自检结果），不写死。

## 与 TS 种子脚本的关系

`apps/server/src/scripts/seed-dictation-fixture.ts` 是**开发假数据**（`source_ref='DEV-FIXTURE'`），
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

    # ---- 主流程 ----

    def load_passages(self, items: list[dict]) -> dict:
        upserted = 0
        for it in items:
            work_title = it["work_title"]
            semester = it["semester"]

            existing = self._query(
                "SELECT id, source_ref FROM chinese_passages "
                "WHERE work_title=%s AND semester=%s LIMIT 1",
                (work_title, semester),
            )
            if existing and existing[0][1] == "DEV-FIXTURE":
                print(f"[WARN] 《{work_title}》原为 DEV-FIXTURE（开发假数据），"
                      f"将由真实内容覆盖", flush=True)

            # memorize_required 只在这里写 0；ON DUPLICATE KEY UPDATE 里不出现它
            self._exec(
                "INSERT INTO chinese_passages (work_title, author, dynasty, body, "
                "grade_band, grade, semester, sort_order, source_ref, verified, memorize_required) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,0) "
                "ON DUPLICATE KEY UPDATE author=VALUES(author), "
                "dynasty=VALUES(dynasty), body=VALUES(body), grade_band=VALUES(grade_band), "
                "grade=VALUES(grade), sort_order=VALUES(sort_order), source_ref=VALUES(source_ref), "
                "verified=VALUES(verified)",
                (work_title, it.get("author") or "", it.get("dynasty") or "", it["body"],
                 it.get("grade_band"), it.get("grade"), semester, it.get("_sort_order", 0),
                 it.get("source_ref"), int(it.get("verified", 1))),
            )
            upserted += 1

        self._conn.commit()
        return {"passages_upserted": upserted}

    @staticmethod
    def read_jsonl(path) -> list[dict]:
        """读抽取产物的 JSONL。带下划线的内部字段（`_locate_notes` 等）原样保留，
        入库只取契约字段，互不干扰。"""
        return [json.loads(l) for l in
                Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]
