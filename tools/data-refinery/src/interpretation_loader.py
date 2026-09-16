"""语文古诗文解释专项管线：**幂等入库**（只写三列内容，不碰任何状态位）。

## 只更新，不新建

**本 loader 不 INSERT**。原因：解释专项的内容（切句）必须建立在**库里已校验的权威正文**
（`chinese_passages.body`）之上——正文不在这份输入里，凭空 INSERT 会造出没有正文的行。
所以篇名/册次在库里找不到时，是**报错并跳过**（列相近篇名，防错字），不是新建。

## 幂等

业务键 `(work_title, semester)` 先查后 UPDATE。**不用 content_hash 去重**——
正文/译文一改 hash 就变，按 hash 去重会插出重复行（同 `dictation_loader` 的理由）。

## 三条不要破坏的约定

- 语句**只 SET 三列**：`key_terms` / `sentences` / `full_translation`。
  `verified` / `memorize_required` / `is_active` **在语句里根本不出现**——
  前者由内容管线自检决定、后两者是人工标定，管线重跑绝不能刷掉它们。
  （2026-09-13 默写 loader 就因「借 questions 的 UPDATE 顺带置 is_active=1」
   而栽过一次，见 `dictation_loader.py` 的说明。）
- JSON 列写库用 `json.dumps(..., ensure_ascii=False)`：pymysql 不做序列化，
  直接传 list 会被当成非法参数。
- 目标行原为 `DEV-FIXTURE`（开发假数据）时**明确告警**再覆盖，不静默替换。
"""

from __future__ import annotations

import json
from pathlib import Path

import pymysql

from interpretation_input import norm_title
from interpretation_split import join_sentences


class InterpretationLoader:
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

    def _resolve_rows(self, work_title: str, semester: str | None) -> list[tuple]:
        """按**归一后**的篇名定位目标行 → [(id, body, source_ref)]。

        与 `interpretation_cli._find_rows` **同一套规则**（共用 `norm_title`）：
        先归一后完全相等，再退到「库中篇名 = 输入 + `(`」的前缀匹配（词牌名 vs 带题目）。
        库里的写法不统一（半角/全角括号、`·` 有无空格），精确匹配会把 extract 通过的篇目挡在门外。
        """
        rows = self._query("SELECT id, semester, body, source_ref, work_title FROM chinese_passages")
        target = norm_title(work_title)
        hits = [r for r in rows if norm_title(r[4]) == target]
        if not hits:
            hits = [r for r in rows if norm_title(r[4]).startswith(target + "(")]
        if semester:
            hits = [r for r in hits if r[1] == semester]
        return [(r[0], r[2], r[3]) for r in hits]

    def load_passages(self, items: list[dict]) -> dict:
        updated = 0
        skipped: list[str] = []
        warnings: list[str] = []

        for it in items:
            work_title = it["work_title"]
            semester = it.get("semester")
            sentences = [s["text"] for s in it.get("sentences", [])]

            # 1. 定位目标行（册次给了就精确到册；没给就按篇名匹配两册）
            rows = self._resolve_rows(work_title, semester)

            if not rows:
                near = self._query(
                    "SELECT DISTINCT work_title FROM chinese_passages "
                    "WHERE work_title LIKE %s LIMIT 5",
                    (f"%{work_title[:2]}%",),
                )
                near_names = "、".join(r[0] for r in near) or "（无相近篇名）"
                skipped.append(
                    f"《{work_title}》{semester or ''} 在库里找不到；相近篇名：{near_names}"
                    "（正文以库为准，本管线不新建篇目）"
                )
                continue

            if len(rows) > 1 and not semester:
                warnings.append(
                    f"《{work_title}》未给册次且匹配到 {len(rows)} 行（九上/九下重复收录），逐行都写"
                )

            for row_id, body, source_ref in rows:
                # 2. 切句必须能拼回该行的正文（防止「入库的句子对不上这一册的正文」）
                if join_sentences(sentences) != body:
                    skipped.append(
                        f"《{work_title}》{semester or ''} (id={row_id}) 切句拼不回该行正文，拒绝写入"
                    )
                    continue

                if source_ref == "DEV-FIXTURE":
                    warnings.append(
                        f"《{work_title}》原为 DEV-FIXTURE（开发假数据），将由真实内容覆盖"
                    )

                # 3. 只 SET 三列内容列——verified/memorize_required/is_active 一个都不出现
                self._exec(
                    "UPDATE chinese_passages "
                    "SET key_terms=%s, sentences=%s, full_translation=%s "
                    "WHERE id=%s",
                    (
                        json.dumps(it.get("key_terms") or [], ensure_ascii=False),
                        json.dumps(it.get("sentences") or [], ensure_ascii=False),
                        it.get("full_translation") or "",
                        row_id,
                    ),
                )
                updated += 1

        self._conn.commit()
        return {"updated": updated, "skipped": skipped, "warnings": warnings}

    @staticmethod
    def read_jsonl(path) -> list[dict]:
        """读抽取产物的 JSONL。带下划线的内部字段原样保留，入库只取契约字段。"""
        return [json.loads(l) for l in
                Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]
