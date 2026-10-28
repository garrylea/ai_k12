"""语文试卷标注回填：把 PDF 里的着重号 / 下划线注入已入库题目的展示字段。

用法（默认 dry-run，不改库）：

    python emphasis_cli.py --paper-id 17
    python emphasis_cli.py --paper-id 17 --apply
    python emphasis_cli.py --all-chinese            # 只预演全部语文卷
    python emphasis_cli.py --all-chinese --apply --yes

只写 ``questions.content`` / ``material_text`` / ``options`` / ``content_hash`` 四列；
写入前备份原始行到 ``tools/db/backups/``，写入后校验其它列逐字未变。
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path

import pymysql

from config import RefineryConfig
from db_loader import content_hash
from pdf_emphasis import Decoration, decorate_text, detect_decorations, is_option_line, normalize_subscript_dots

TOOLS_DB_DIR = Path(__file__).resolve().parents[2] / "db"


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="把语文试卷的着重号/下划线注入题目展示字段")
    p.add_argument("--paper-id", type=int, help="只处理指定 exam_papers.id")
    p.add_argument("--all-chinese", action="store_true", help="处理全部语文试卷（默认 dry-run）")
    p.add_argument("--pdf", help="覆盖 PDF 路径（调试用）")
    p.add_argument("--apply", action="store_true", help="真正写库（缺省只预演）")
    p.add_argument("--yes", action="store_true", help="--all-chinese --apply 的二次确认")
    p.add_argument("--verbose", action="store_true", help="逐条打印 decoration 命中情况")
    return p.parse_args(argv)


def resolve_pdf(config: RefineryConfig, source_key: str, override: str | None = None) -> Path | None:
    """source_key 形如 ``语文/.../xxx-试卷/xxx-试卷``；真实 PDF 是目录名 + .pdf。"""
    if override:
        path = Path(override)
        return path if path.exists() else None
    base = Path(config.input_dir)
    stem = Path(source_key).parent.name or Path(source_key).name
    candidates = [
        base / f"{str(Path(source_key).parent)}.pdf",
        base / f"{source_key}.pdf",
        base / f"{stem}.pdf",
    ]
    for c in candidates:
        if c.exists():
            return c
    matches = list(base.rglob(f"{stem}.pdf"))
    return matches[0] if matches else None


def _load_papers(conn, args) -> list[dict]:
    with conn.cursor(pymysql.cursors.DictCursor) as cur:
        sql = (
            "SELECT p.id, p.source_key, p.title, s.code AS subject_code "
            "FROM exam_papers p JOIN subjects s ON s.id=p.subject_id "
        )
        if args.paper_id:
            cur.execute(sql + "WHERE p.id=%s", (args.paper_id,))
        elif args.all_chinese:
            cur.execute(sql + "WHERE s.code='chinese' ORDER BY p.id")
        else:
            raise SystemExit("请给 --paper-id 或 --all-chinese")
        return list(cur.fetchall())


def _load_questions(conn, paper_id: int) -> list[dict]:
    with conn.cursor(pymysql.cursors.DictCursor) as cur:
        cur.execute(
            "SELECT q.id, pq.question_no, q.content, q.material_text, q.options, q.content_hash "
            "FROM paper_questions pq JOIN questions q ON q.id=pq.question_id "
            "WHERE pq.paper_id=%s ORDER BY pq.question_no",
            (paper_id,),
        )
        return list(cur.fetchall())


def _decorate_row(
    row: dict, decorations: list[Decoration], verbose: bool,
) -> tuple[dict, dict[str, list[tuple[Decoration, str]]], int]:
    """返回 (新字段, 日志, 应用处数)。只改 content/material_text/options。"""
    new: dict = {}
    logs: dict[str, list[tuple[Decoration, str]]] = {}
    applied = 0

    # 题干只做 <sub> 归一化，不套 PDF 标注：题干里的「画横线的“X”」是引用，原卷并未画线
    new["content"], logs["content"] = normalize_subscript_dots(row.get("content")), []

    prose_decs = [d for d in decorations if not is_option_line(d.line)]
    material, log = decorate_text(row.get("material_text"), prose_decs)
    new["material_text"], logs["material_text"] = material, log
    applied += sum(1 for _, s in log if s == "applied")

    options_raw = row.get("options")
    if options_raw:
        try:
            options = json.loads(options_raw)
        except (TypeError, ValueError):
            options = None
        if isinstance(options, list):
            option_decs = [d for d in decorations if is_option_line(d.line)]
            opt_log: list[tuple[Decoration, str]] = []
            changed = False
            for opt in options:
                if not isinstance(opt, dict) or not isinstance(opt.get("text"), str):
                    continue
                text, log = decorate_text(opt["text"], option_decs, radii=(4, 3, 2, 1), cjk_context_only=True)
                if text != opt["text"]:
                    opt["text"] = text
                    changed = True
                opt_log.extend(log)
                applied += sum(1 for _, s in log if s == "applied")
            new["options"] = json.dumps(options, ensure_ascii=False) if changed else options_raw
            logs["options"] = opt_log
        else:
            new["options"] = options_raw
    else:
        new["options"] = options_raw

    if verbose:
        for field, lg in logs.items():
            for dec, status in lg:
                if status == "applied":
                    print(f"    [{field}] {dec.kind} {dec.text!r} <- p{dec.page}", flush=True)
    return new, logs, applied


def _snippet(s: str | None, n: int = 120) -> str:
    if not s:
        return ""
    s = s.replace("\n", " ")
    return s[:n] + ("…" if len(s) > n else "")


def main(argv=None):
    args = parse_args(argv)
    if args.apply and args.all_chinese and not args.yes:
        raise SystemExit("--all-chinese --apply 需要 --yes 二次确认")
    config = RefineryConfig.from_env()
    conn = pymysql.connect(
        host=config.db_host, port=config.db_port, user=config.db_user,
        password=config.db_pass, database=config.db_name,
        charset="utf8mb4", autocommit=False,
    )
    try:
        papers = _load_papers(conn, args)
        if not papers:
            raise SystemExit("没有匹配的语文试卷")
        total_changed = 0
        for paper in papers:
            if paper["subject_code"] != "chinese":
                print(f"[skip] paper {paper['id']} 不是语文卷（{paper['subject_code']}）", flush=True)
                continue
            pdf = resolve_pdf(config, paper["source_key"], args.pdf)
            if pdf is None:
                print(f"[warn] paper {paper['id']} 找不到 PDF（source_key={paper['source_key']}）", flush=True)
                continue
            decorations = detect_decorations(pdf)
            dots = sum(1 for d in decorations if d.kind == "dots")
            uls = sum(1 for d in decorations if d.kind == "underline")
            print(
                f"paper {paper['id']}《{paper['title']}》 {pdf.name}: "
                f"检测到着重号 {dots} 处 / 下划线 {uls} 处",
                flush=True,
            )

            rows = _load_questions(conn, paper["id"])
            changes = []
            for row in rows:
                new, _, applied = _decorate_row(row, decorations, args.verbose)
                if any(new[k] != (row.get(k) or "") for k in ("content", "material_text")):
                    changed = True
                else:
                    changed = new["options"] != row.get("options")
                if not changed:
                    continue
                changes.append((row, new, applied))

            print(f"  题数 {len(rows)}；需要更新 {len(changes)} 题", flush=True)
            for row, new, applied in changes[:8]:
                print(f"  - 题{row['question_no']} (id={row['id']}, {applied} 处)", flush=True)
                if new["material_text"] != (row.get("material_text") or ""):
                    print(f"      material: {_snippet(new['material_text'])}", flush=True)
                if new["content"] != (row.get("content") or ""):
                    print(f"      content : {_snippet(new['content'])}", flush=True)
                if new["options"] != row.get("options"):
                    print(f"      options : {_snippet(new['options'])}", flush=True)

            if not changes:
                continue
            total_changed += len(changes)

            if not args.apply:
                continue

            # 备份原始行（持久目录，勿用 /tmp）
            backup_dir = TOOLS_DB_DIR / "backups"
            backup_dir.mkdir(parents=True, exist_ok=True)
            backup = backup_dir / f"{datetime.now():%Y%m%d_%H%M%S}_emphasis_paper{paper['id']}.jsonl"
            with backup.open("w", encoding="utf-8") as f, conn.cursor(pymysql.cursors.DictCursor) as cur:
                for row, _, _ in changes:
                    # 备份完整行（含 answer/explanation 等），便于整行回滚
                    f.write(json.dumps(_fetch_row(cur, row["id"]), ensure_ascii=False, default=str) + "\n")
            print(f"  backup -> {backup}", flush=True)

            with conn.cursor(pymysql.cursors.DictCursor) as cur:
                for row, new, _ in changes:
                    before = _fetch_row(cur, row["id"])
                    cur.execute(
                        "UPDATE questions SET content=%s, material_text=%s, options=%s, content_hash=%s "
                        "WHERE id=%s",
                        (new["content"], new["material_text"] or None, new["options"],
                         content_hash(new["content"]), row["id"]),
                    )
                    after = _fetch_row(cur, row["id"])
                    _assert_other_columns_unchanged(before, after)
            conn.commit()
            print(f"  已写库 {len(changes)} 题", flush=True)

        print(f"完成：需要更新 {total_changed} 题；{'已写库' if args.apply else 'dry-run 未写库'}", flush=True)
    finally:
        conn.close()


_UPDATED_COLUMNS = {"content", "material_text", "options", "content_hash", "updated_at"}


def _fetch_row(cur, qid: int) -> dict:
    cur.execute("SELECT * FROM questions WHERE id=%s", (qid,))
    return cur.fetchone()


def _assert_other_columns_unchanged(before: dict, after: dict) -> None:
    keys = (set(before) | set(after)) - _UPDATED_COLUMNS
    diff = [k for k in sorted(keys) if before.get(k) != after.get(k)]
    if diff:
        raise RuntimeError(f"非目标列被意外修改: {diff}（question id={before.get('id')}）")


if __name__ == "__main__":
    main()
