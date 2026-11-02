#!/usr/bin/env python3
"""物理/化学题内材料回填（B2，2026-11-02）。

把「材料 + (1)(2)(3) 小问」混在 `content` 里的题目，按规则切出材料：

    material_text  ← 材料段（含图/表）
    content        ← 小问段
    material_method← 'rule'

## 一条命令完成：备份 → 切分 → 写库 → 复查

    python3 tools/db/material_backfill.py

`--dry-run` 只打印不写（开发用）。

## 安全边界（项目铁律）

- **只处理 `material_text IS NULL` 的题**：语文/英语已有人工/管线材料的一律不动。
- **只写三列**：`material_text` / `content` / `material_method`；其他列前后 MD5 必须一致。
- **拼接自校验**：`material + rest == 原 content`（不 rstrip，构造上恒成立），不成立整题跳过。
- **备份**：写库前把受影响行的原值导出到 `tools/db/backups/`，可直接回滚。

## 为什么不含 LLM 兜底

实测 165 道物化题：规则命中 38 道（物理 26 / 化学 12）；其余是选择题（材料+选项，无小问，
不该切）或「一句话情境 + 小问」（材料段 < 60 字，切出来是碎块，也不该切）。
真正需要 LLM 判切点的题本次为 0。`material_split.needs_llm()` 谓词与留痕列已就位，
将来出现格式异常的小问编号时再接入 LLM 兜底，不影响本脚本。
"""

import argparse
import hashlib
import re
import sys
from pathlib import Path

import pymysql

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools" / "data-refinery" / "src"))

from subject_strategies.material_split import (  # noqa: E402
    needs_pre_material,
    pre_material_for,
    split_material_rule,
)

DB = dict(host="localhost", port=3306, user="ai_k12", password="ai_k12",
          database="ai_k12", charset="utf8mb4")
SUBJECTS = ("physics", "chemistry")
BACKUP_DIR = Path(__file__).resolve().parent / "backups"
# 第二阶段按原卷 MD 回捞「题号前共享材料」——物化的卷子在这两棵目录下
MD_ROOT = Path(__file__).resolve().parents[2] / "tools" / "data-refinery" / "output" / "md"
SUBJECT_MD_DIR = {"physics": "物理", "chemistry": "化学"}
# `![alt](path)` —— 与 image_rewrite.IMAGE_REF_RE 同口径
_IMAGE_REF = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")


def md5(s: str | None) -> str:
    return hashlib.md5((s or "").encode("utf-8")).hexdigest()


_MD_CACHE: dict[str, list[tuple[Path, list[str]]]] = {}


def _load_md_index(subject: str) -> list[tuple[Path, list[str]]]:
    """读该学科所有试卷 MD（进程内缓存，二/三阶段复用）。"""
    if subject in _MD_CACHE:
        return _MD_CACHE[subject]
    root = MD_ROOT / SUBJECT_MD_DIR[subject]
    files: list[tuple[Path, list[str]]] = []
    if root.is_dir():
        for p in sorted(root.rglob("*试卷.md")):
            try:
                files.append((p, p.read_text(encoding="utf-8").split("\n")))
            except OSError:
                continue
    _MD_CACHE[subject] = files
    return files


def backfill_material_images(conn, cur, dry_run: bool) -> int:
    """第三阶段：材料里的 `![...](images/x.jpg)` 物化到资产目录并改写路径。

    `images/…` 是 MD 目录下的相对路径，前端会拼成 `/assets/images/…` → 404 且破图被
    隐藏（2026-10-31 事故同源）。publish 阶段本来会物化（`rewrite_item` 含 material_text），
    但本脚本是**publish 之后**改库，所以这里补一遍：拷贝到
    `output/assets/material/<subject>/<文件名>`，路径改写为 `material/<subject>/<文件名>`。
    文件名是内容哈希，天然不重名。
    """
    cur.execute("""
        SELECT q.id, s.code, q.material_text
          FROM questions q JOIN subjects s ON s.id = q.subject_id
         WHERE q.material_text LIKE '%](images/%'
         ORDER BY q.id
    """)
    rows = cur.fetchall()
    if not rows:
        return 0

    assets_root = MD_ROOT.parent / "assets"
    plans: list[tuple[int, str]] = []   # (id, 新 material_text)
    for qid, subj, material in rows:
        refs = [m.group(1) for m in _IMAGE_REF.finditer(material or "") if "images/" in m.group(1)]
        if not refs:
            continue
        md_dir = _find_md_dir_for_images(subj, refs)
        if md_dir is None:
            print(f"[WARN] id={qid} 找不到图片源目录，跳过：{refs[:2]}")
            continue
        new_text = material or ""
        for ref in refs:
            name = Path(ref).name
            dest_rel = f"material/{subj}/{name}"
            new_text = new_text.replace(f"]({ref})", f"]({dest_rel})")
            if not dry_run:
                src = md_dir / ref
                if not src.exists():
                    src = md_dir / "images" / name
                dest = assets_root / dest_rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(src.read_bytes())
        if new_text != material:
            plans.append((qid, new_text))

    print(f"材料图片物化：{len(rows)} 道题含 images/ 引用，可改写 {len(plans)} 题")
    if not plans:
        return 0
    if dry_run:
        for qid, text in plans[:3]:
            print(f"--- id={qid} ---")
            print("  head:", text[:70].replace("\n", " | "))
        print("(dry-run，未写库)")
        return 0

    ids = [qid for qid, _ in plans]
    guard_sql = """
        SELECT id, type, content, options, answer, explanation, approach, grade_band,
               source, source_year, content_hash, is_active, difficulty, full_score, group_id, group_order
          FROM questions WHERE id IN (%s)
    """
    cur.execute(guard_sql % ",".join(["%s"] * len(ids)), ids)
    before = {r[0]: md5("|".join("" if v is None else str(v) for v in r[1:])) for r in cur.fetchall()}

    for qid, text in plans:
        cur.execute("UPDATE questions SET material_text=%s WHERE id=%s", (text, qid))

    cur.execute(guard_sql % ",".join(["%s"] * len(ids)), ids)
    changed = [r[0] for r in cur.fetchall()
               if before.get(r[0]) != md5("|".join("" if v is None else str(v) for v in r[1:]))]
    # 用 LOCATE 而不是 LIKE：LIKE 里的 `%` 会被 pymysql 当成参数占位符
    cur.execute("""
        SELECT COUNT(*) FROM questions
         WHERE id IN (%s) AND LOCATE('](images/', material_text) = 0
    """ % ",".join(["%s"] * len(ids)), ids)
    ok = cur.fetchone()[0]
    conn.commit()
    print(f"已改写 {ok}/{len(ids)} 题；其他列变化 {len(changed)} 题 {changed[:5]}")
    return 2 if changed or ok != len(ids) else 0


def _find_md_dir_for_images(subject: str, refs: list[str]) -> Path | None:
    """找同时包含这些图片的 MD 目录（按文件名匹配，避免标题相似误配）。"""
    names = {Path(r).name for r in refs}
    for path, _lines in _load_md_index(subject):
        base = path.parent
        if all((base / r).exists() or (base / "images" / Path(r).name).exists() for r in refs):
            return base
        if all((base / "images" / n).exists() for n in names):
            return base
    return None


def _locate_stem(lines: list[str], n: int, first_line: str) -> int | None:
    """定位题号行：行首 `N.` 且包含题干的第一个非空行（防命中答案区同名题号）。"""
    pat = re.compile(rf"^\s*(?:\*\*)?{n}\s*[.．、]")
    for i, line in enumerate(lines):
        if pat.match(line) and first_line and first_line in line:
            return i
    return None


def backfill_pre_material(conn, cur, dry_run: bool) -> int:
    """第二阶段：把「请在题号前、由『请阅读《…》并回答第 N 题』引导」的材料挂到题目上。

    只写 `material_text` / `material_method`，**不动 content**（材料本来就不在 content 里，
    而是在切题时被整段丢弃）。
    """
    cur.execute("""
        SELECT q.id, s.code, q.group_order, q.content
          FROM questions q JOIN subjects s ON s.id = q.subject_id
         WHERE s.code IN (%s, %s) AND q.material_text IS NULL
         ORDER BY q.id
    """, SUBJECTS)
    rows = cur.fetchall()

    plans: list[tuple[int, str]] = []   # (id, material)
    cache: dict[str, list[tuple[Path, list[str]]]] = {}
    for qid, subj, n, content in rows:
        if not needs_pre_material(content or ""):
            continue
        first_line = next((l.strip() for l in (content or "").split("\n") if l.strip()), "")
        if not first_line:
            continue
        for _path, lines in cache.setdefault(subj, _load_md_index(subj)):
            idx = _locate_stem(lines, int(n), first_line)
            if idx is None:
                continue
            block = pre_material_for(lines, idx)
            if block:
                plans.append((qid, block))
                break

    print(f"题前共享材料：{len(rows)} 道空材料题中可回捞 {len(plans)} 题")
    if not plans:
        return 0
    if dry_run:
        for qid, block in plans[:5]:
            print(f"--- id={qid} material={len(block)}字 ---")
            print("  head:", block[:70].replace("\n", " | "))
        print("(dry-run，未写库)")
        return 0

    # ---- 备份 ----
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    backup = BACKUP_DIR / "20261102_material_pre_rollback.sql"
    with backup.open("w", encoding="utf-8") as f:
        f.write("-- 回滚：清空本阶段写入的题前材料\n")
        for qid, _block in plans:
            f.write(f"UPDATE questions SET material_text=NULL, material_method=NULL WHERE id={qid};\n")
    print(f"备份已写入 {backup}")

    ids = [qid for qid, _ in plans]
    guard_sql = """
        SELECT id, type, content, options, answer, explanation, approach, grade_band,
               source, source_year, content_hash, is_active, difficulty, full_score, group_id, group_order
          FROM questions WHERE id IN (%s)
    """
    cur.execute(guard_sql % ",".join(["%s"] * len(ids)), ids)
    before = {r[0]: md5("|".join("" if v is None else str(v) for v in r[1:])) for r in cur.fetchall()}

    for qid, block in plans:
        cur.execute(
            "UPDATE questions SET material_text=%s, material_method='rule' WHERE id=%s",
            (block, qid),
        )

    cur.execute(guard_sql % ",".join(["%s"] * len(ids)), ids)
    changed = [r[0] for r in cur.fetchall()
               if before.get(r[0]) != md5("|".join("" if v is None else str(v) for v in r[1:]))]
    cur.execute("""
        SELECT COUNT(*) FROM questions
         WHERE id IN (%s) AND material_text IS NOT NULL AND material_method='rule'
    """ % ",".join(["%s"] * len(ids)), ids)
    written = cur.fetchone()[0]
    conn.commit()
    print(f"已写 {written}/{len(ids)} 题；其他列变化 {len(changed)} 题 {changed[:5]}")
    if changed:
        print("⚠️ 其他列发生变化，请检查（回滚 SQL 见备份文件）")
        return 2
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="只打印，不写库")
    args = ap.parse_args()

    conn = pymysql.connect(**DB)
    cur = conn.cursor()
    cur.execute("""
        SELECT q.id, s.code, q.type, q.content, q.material_text
          FROM questions q JOIN subjects s ON s.id = q.subject_id
         WHERE s.code IN (%s, %s) AND q.material_text IS NULL
         ORDER BY q.id
    """, SUBJECTS)
    rows = cur.fetchall()

    plan: list[tuple[int, str, str, str]] = []   # (id, material, rest, subject)
    skipped = 0
    for qid, subj, qtype, content, _mat in rows:
        material, rest = split_material_rule(content or "")
        if not material:
            skipped += 1
            continue
        # 拼接自校验：切片按定义应等原文；不等说明中途有人改过 content，跳过
        if material + rest != content:
            skipped += 1
            continue
        plan.append((qid, material, rest, subj))

    print(f"第一阶段（题内材料）：候选 {len(rows)} 题；可切分 {len(plan)} 题；跳过 {skipped}")
    by_subj: dict[str, int] = {}
    for _, _, _, subj in plan:
        by_subj[subj] = by_subj.get(subj, 0) + 1
    print("  按学科:", by_subj)

    rc = 0
    if plan and args.dry_run:
        for qid, material, rest, subj in plan[:5]:
            print(f"--- id={qid} {subj} material={len(material)}字 rest={len(rest)}字 ---")
            print("  material.head:", material[:60].replace("\n", " | "))
            print("  rest.head   :", rest[:60].replace("\n", " | "))
        print("(dry-run，未写库)")
    elif plan:
        # ---- 备份 ----
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        backup = BACKUP_DIR / "20261102_material_backfill_rollback.sql"
        with backup.open("w", encoding="utf-8") as f:
            f.write("-- 回滚：把 content 还原、material_text/material_method 清空\n")
            for qid, _material, _rest, _subj in plan:
                cur.execute("SELECT content FROM questions WHERE id=%s", (qid,))
                orig = cur.fetchone()[0]
                f.write(
                    f"UPDATE questions SET content={conn.escape(orig)}, "
                    f"material_text=NULL, material_method=NULL WHERE id={qid};\n"
                )
        print(f"备份已写入 {backup}")

        # ---- 写库（只写三列）----
        other_cols_before: dict[int, str] = {}
        guard_sql = """
            SELECT id, type, options, answer, explanation, approach, grade_band,
                   source, source_year, content_hash, is_active, difficulty, full_score, group_id, group_order
              FROM questions WHERE id IN (%s)
        """
        ids = [p[0] for p in plan]
        cur.execute(guard_sql % ",".join(["%s"] * len(ids)), ids)
        for r in cur.fetchall():
            other_cols_before[r[0]] = md5("|".join("" if v is None else str(v) for v in r[1:]))

        for qid, material, rest, _subj in plan:
            cur.execute(
                "UPDATE questions SET material_text=%s, content=%s, material_method='rule' WHERE id=%s",
                (material, rest, qid),
            )

        # ---- 复查：其他列 MD5 不变 + 三列已写 ----
        cur.execute(guard_sql % ",".join(["%s"] * len(ids)), ids)
        changed = [r[0] for r in cur.fetchall()
                   if other_cols_before.get(r[0]) != md5("|".join("" if v is None else str(v) for v in r[1:]))]

        cur.execute("""
            SELECT COUNT(*) FROM questions
             WHERE id IN (%s) AND material_text IS NOT NULL AND material_method='rule'
        """ % ",".join(["%s"] * len(ids)), ids)
        written = cur.fetchone()[0]

        conn.commit()
        print(f"已写 {written}/{len(ids)} 题；其他列变化 {len(changed)} 题 {changed[:5]}")
        if changed:
            print("⚠️ 其他列发生变化，请检查（回滚 SQL 见备份文件）")
            rc = 2
        else:
            print("第一阶段复查通过。")

    # ---- 第二阶段：题号前共享材料（科技阅读题）----
    rc2 = backfill_pre_material(conn, cur, dry_run=args.dry_run)
    # ---- 第三阶段：材料里的图片物化（images/… → material/<subject>/…）----
    rc3 = backfill_material_images(conn, cur, dry_run=args.dry_run)
    conn.close()
    if rc2:
        return rc2
    if rc3:
        return rc3
    if rc == 0 and not args.dry_run:
        print("全部完成。")
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
