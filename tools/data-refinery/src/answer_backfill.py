"""答案回填：试卷 md → 答案文档 → questions.answer（import_cli 第 5 步）。

为什么需要这一步：切题阶段（extract）虽然会做一次答案对齐，但它面向通用格式，
语文的评分说明、全角题号、作文评分细则等需要按学科策略再走一遍确定性提取；
另外已有卷子里答案缺失的题也靠它补齐。

安全口径：
- 默认 **只补空答案**（importer `--where answer_empty`），已有内容一律不动；
- `--re-answer` 才允许覆盖（人工核过的 `answer_verified=1` 也会被改，慎用）；
- 没有「参考答案」段的卷直接跳过并打印原因，不猜。
"""

from pathlib import Path

import pymysql

from answer_extract_cli import paper_title, render_answer_doc
from answer_importer_cli import main as importer_main
from db_loader_cli import _kind
from scope_filter import Scope, match_scope
from subject_codes import subject_code_for_path
from subject_strategies import UnknownStrategyError, get_strategy


def iter_paper_jsonl(published_dir: Path, scope: Scope) -> list[Path]:
    """published 下命中范围、且属于「试卷」的 jsonl（教材卡不参与答案回填）。"""
    paths: list[Path] = []
    for path in sorted(published_dir.rglob("*.jsonl")):
        rel = path.relative_to(published_dir)
        if not match_scope(rel, scope):
            continue
        if _kind(path.name) != "questions":
            continue
        paths.append(path)
    return paths


def source_key(rel_jsonl: Path) -> str:
    """与 db_loader 完全一致的幂等键：published 相对路径去掉 .jsonl。"""
    return rel_jsonl.as_posix()[: -len(".jsonl")]


def _lookup_paper_id(conn, key: str) -> int | None:
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM exam_papers WHERE source_key=%s LIMIT 1", (key,))
        row = cur.fetchone()
    return int(row[0]) if row else None


def _connect(cfg):
    return pymysql.connect(
        host=cfg.db_host, port=cfg.db_port, user=cfg.db_user,
        password=cfg.db_pass, database=cfg.db_name, charset="utf8mb4",
    )


def backfill(cfg, scope: Scope, *, dry_run: bool = False, overwrite: bool = False) -> dict:
    """逐卷提取答案并回写。返回统计，供编排层汇总。"""
    published_dir = cfg.output_dir / "published"
    md_dir = cfg.output_dir / "md"
    answers_dir = cfg.output_dir / "answers"

    papers = iter_paper_jsonl(published_dir, scope)
    stats = {
        "total": len(papers), "filled": 0, "no_answer": 0,
        "no_md": 0, "skipped": 0, "failed": 0,
    }
    if not papers:
        print("[answers] 范围内没有已发布的试卷，跳过答案回填")
        return stats

    conn = None
    try:
        if not dry_run:
            conn = _connect(cfg)

        for jsonl_path in papers:
            rel = jsonl_path.relative_to(published_dir)
            md_path = md_dir / rel.with_suffix(".md")
            if not md_path.exists():
                stats["no_md"] += 1
                continue

            rel_md = md_path.relative_to(md_dir)
            # 路径首段不是已知学科目录时 subject_code_for_path 返回 ""（不给默认
            # math）：get_strategy 随即报错跳过。答案提取错学科比失败更危险。
            try:
                strategy = get_strategy(subject_code_for_path(rel_md, default=""))
            except UnknownStrategyError as exc:
                print(f"[answers] 跳过（{exc}）：{rel}")
                stats["skipped"] += 1
                continue

            text = md_path.read_text(encoding="utf-8")
            answers = strategy.extract_answers(text, md_path)
            if not any((a.answer or "").strip() for a in answers):
                print(f"[answers] 跳过（没有参考答案段）：{rel}")
                stats["no_answer"] += 1
                continue

            if dry_run:
                print(f"[dry-run] 将回填答案：{rel}")
                stats["filled"] += 1
                continue

            paper_id = _lookup_paper_id(conn, source_key(rel))
            if paper_id is None:
                print(f"[answers] 跳过（库里找不到该卷，先确认 db_loader 已入库）：{rel}")
                stats["skipped"] += 1
                continue

            doc_path = answers_dir / f"{md_path.stem}.md"
            doc_path.parent.mkdir(parents=True, exist_ok=True)
            doc_path.write_text(
                render_answer_doc(paper_title(rel_md, text), answers), encoding="utf-8",
            )

            argv = ["--doc", str(doc_path), "--paper-id", str(paper_id)]
            if not overwrite:
                argv += ["--where", "answer_empty"]
            print(f"[answers] 回填 {rel}（paper_id={paper_id}，"
                  f"{'覆盖' if overwrite else '仅补空'}）", flush=True)
            rc = importer_main(argv + ["--apply", "--yes"])
            if rc == 0:
                stats["filled"] += 1
            else:
                stats["failed"] += 1
    except pymysql.MySQLError as exc:
        print(f"[answers] 数据库不可用，跳过答案回填：{exc}")
        stats["failed"] += 1
    finally:
        if conn is not None:
            conn.close()

    print(
        f"[answers] 共 {stats['total']} 卷：回填 {stats['filled']}，"
        f"无答案段 {stats['no_answer']}，无 md {stats['no_md']}，"
        f"跳过 {stats['skipped']}，失败 {stats['failed']}",
        flush=True,
    )
    return stats
