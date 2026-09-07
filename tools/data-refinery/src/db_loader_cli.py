"""db_loader 子命令：把 published JSONL 加载进 MySQL（cards + questions）。

- 输入默认 `output/published/`（publish 产物，资产路径已改写）。
- kind 检测：文件名含 试卷/答案 -> questions；否则 -> cards。
- cards：按书目录分组、按页顺序收集，renumber sort_order 后入库；派生 textbook_versions/semesters/units/lessons。
- questions：按文件入库，subject_id 别名归一。
- 幂等：full-reload（按 source 先 DELETE cards/questions 再重插；结构 find-or-create）。
"""

import argparse
import json
from pathlib import Path

from config import RefineryConfig
from db_loader import DbLoader
from paper_meta import parse_paper_meta


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="把 published JSONL 加载进 MySQL")
    parser.add_argument("--input-dir", help="published 输入目录（默认 output/published）")
    parser.add_argument("--source", choices=["all", "zgkao", "smartedu"], default="all", help="素材来源过滤")
    parser.add_argument("--load-toc", action="store_true", help="只 load_toc_structure()，不入库 card（需配合 --toc-path）")
    parser.add_argument("--load-cards", action="store_true", help="只 card/questions 入库，不建骨架")
    parser.add_argument("--toc-path", help="TOC JSON 路径（--load-toc 时必传；--load-cards 时可选）")
    parser.add_argument("--toc-dir", help="TOC 目录（如 output/toc）：--load-toc 遍历目录建骨架；"
                        "--load-cards 时按书自动匹配 merged TOC（先建骨架再挂卡）；优先于 --toc-path")
    parser.add_argument("--purge-business-data", action="store_true",
                        help="full-reload 前清空引用 cards/questions 的业务数据"
                             "（answers/错题本/变式题/作业提交/progress，不可恢复）；"
                             "默认遇业务数据报错退出，防止误删学生数据")
    parser.add_argument("--reload-source", help="只重载指定 source 的试卷题（文件名去扩展名）："
                        "删该卷旧题（含 paper_questions/QKP 关联）后从 published 重插")
    parser.add_argument("--purge-paper-data", action="store_true",
                        help="配合 --reload-source：该卷题被 answers/错题本/变式题等业务表引用时，"
                             "显式删这些业务记录后重载（学生数据不可恢复）")
    parser.add_argument("--dry-run", action="store_true", help="只打印，不入库")
    return parser.parse_args(argv)


def _kind(name: str) -> str:
    return "questions" if ("试卷" in name or "答案" in name) else "cards"


def _resolve_book_toc(toc_dir: Path, book_key: str) -> Path | None:
    """按书匹配 TOC：优先 toc_merge 的 merged sidecar，fallback 初始 toc。"""
    for suffix in (".merged.json", ".json"):
        p = toc_dir / f"{book_key}{suffix}"
        if p.exists():
            return p
    return None


def _collect_toc_files(toc_dir: Path) -> list[Path]:
    """收集目录下的 TOC 文件：merged 优先；同名初始 toc 在 merged 存在时跳过。

    排除 merge_report（非 TOC 结构）。
    """
    files: list[Path] = []
    for p in sorted(toc_dir.rglob("*.json")):
        if p.name.endswith(".merge_report.json"):
            continue
        if p.name.endswith(".merged.json"):
            files.append(p)
        elif not p.with_suffix(".merged.json").exists():
            files.append(p)
    return files


def _match_source(name: str, source: str) -> bool:
    if source == "all":
        return True
    if source == "zgkao":
        return "试卷" in name or "答案" in name
    if source == "smartedu":
        return "试卷" not in name and "答案" not in name
    return False


def main(argv=None):
    args = parse_args(argv)
    cfg = RefineryConfig.from_env()

    # === TOC mode: build skeleton only (needs DB) ===
    if args.load_toc:
        if not args.toc_path and not args.toc_dir:
            print("[ERROR] --load-toc requires --toc-path or --toc-dir", flush=True)
            return
        if args.toc_dir and not Path(args.toc_dir).exists():
            print(f"[ERROR] TOC 目录不存在: {args.toc_dir}", flush=True)
            return
        toc_files = _collect_toc_files(Path(args.toc_dir)) if args.toc_dir \
            else [Path(args.toc_path)]
        if args.dry_run:
            for p in toc_files:
                print(f"[dry-run] {p}", flush=True)
            print(f"共 {len(toc_files)} 个 TOC 文件", flush=True)
            return
        loader = DbLoader(cfg.db_host, cfg.db_port, cfg.db_user, cfg.db_pass, cfg.db_name)
        try:
            total_ch = total_ls = 0
            for p in toc_files:
                result = loader.load_toc_structure(str(p))
                total_ch += result["chapters"]
                total_ls += result["lessons"]
                print(f"[ok] {p}: {result['chapters']} chapters, {result['lessons']} lessons", flush=True)
            print(f"TOC loaded: {total_ch} chapters, {total_ls} lessons", flush=True)
        finally:
            loader.close()
        return

    # === Reload-source mode: 只重载某张试卷的题 ===
    if args.reload_source:
        cfg = RefineryConfig.from_env()
        published_dir = Path(args.input_dir) if args.input_dir else cfg.output_dir / "published"
        source = args.reload_source
        # 从 published 找该 source 的 jsonl（stem = source）
        match = [p for p in sorted(published_dir.rglob("*.jsonl")) if p.stem == source]
        if not match:
            print(f"[ERROR] published 下找不到 source='{source}' 的 jsonl（文件名去扩展名）", flush=True)
            return
        qs = [json.loads(l) for l in match[0].read_text(encoding="utf-8").splitlines() if l.strip()]
        print(f"[reload] {match[0].relative_to(published_dir)}: {len(qs)} 题", flush=True)
        if args.dry_run:
            return
        loader = DbLoader(cfg.db_host, cfg.db_port, cfg.db_user, cfg.db_pass, cfg.db_name)
        try:
            result = loader.delete_questions_by_source(source, purge_paper_data=args.purge_paper_data)
            if result["blocked"]:
                print("[ERROR] 该卷题被业务表引用，先处理或用 --purge-paper-data：", flush=True)
                for t, n in result["blocked"].items():
                    print(f"  - {t}: {n} 行", flush=True)
                return
            if result["deleted"]:
                print(f"[reload] 删除旧题 {result['deleted']} 道", flush=True)
            # 重插（含 paper 归组）
            rel = match[0].relative_to(published_dir).as_posix()
            meta = parse_paper_meta(rel)
            paper_ctx = None
            if meta is not None and meta.file_type == "试卷":
                source_key = rel[: -len(".jsonl")]
                paper_id = loader.find_or_create_paper_from_meta(meta, source_key)
                paper_ctx = (meta, paper_id)
            n = loader.load_questions(qs, paper=paper_ctx)
            print(f"[ok] {source} 重载完成：入库 {n} 题"
                  + (f"（paper={paper_ctx[1]}）" if paper_ctx else ""), flush=True)
        finally:
            loader.close()
        return

    # === Normal mode: card/question loading ===
    published_dir = Path(args.input_dir) if args.input_dir else cfg.output_dir / "published"
    files = [p for p in sorted(published_dir.rglob("*.jsonl")) if _match_source(p.name, args.source)]

    if args.dry_run:
        for p in files:
            print(f"{p.relative_to(published_dir)} ({_kind(p.name)})", flush=True)
        print(f"共 {len(files)} 个文件", flush=True)
        return

    loader = DbLoader(cfg.db_host, cfg.db_port, cfg.db_user, cfg.db_pass, cfg.db_name)
    try:
        # When --load-cards is NOT specified, do full-reload (backward compatible default)
        if not args.load_cards:
            reset_cards = args.source in ("all", "smartedu")
            reset_questions = args.source in ("all", "zgkao")

            # full-reload 守卫：业务表 FK（RESTRICT）会挡住 DELETE，先预检再行动
            blocking = {t: n for t, n in loader.business_data_summary(
                reset_cards, reset_questions).items() if n > 0}
            if blocking and not args.purge_business_data:
                print("[ERROR] 检测到业务数据引用，full-reload 会被外键挡住：", flush=True)
                for t, n in blocking.items():
                    print(f"  - {t}: {n} 行", flush=True)
                print("两种选择：", flush=True)
                print("  1) 加 --purge-business-data 显式清空上述业务数据后继续（学生侧数据不可恢复）", flush=True)
                print("  2) 改用 --load-cards 增量入库（不 reset，不动业务数据）", flush=True)
                return
            if blocking:
                purged = loader.purge_business_data(reset_cards, reset_questions)
                for t, n in purged.items():
                    print(f"[purge] DELETE {t}: {n} 行", flush=True)

            if reset_cards:
                loader.reset_cards()
                print("[reset] DELETE cards", flush=True)
            if reset_questions:
                loader.reset_questions()
                print("[reset] DELETE questions", flush=True)

        card_files = [p for p in files if _kind(p.name) == "cards"]
        q_files = [p for p in files if _kind(p.name) == "questions"]

        # cards 按书目录分组、按页顺序收集
        books: dict[str, list[Path]] = {}
        for p in card_files:
            book_key = "/".join(p.relative_to(published_dir).parts[:-1])
            books.setdefault(book_key, []).append(p)

        # --toc-dir：按书匹配 TOC（优先 merged sidecar）；命中则先建骨架（幂等
        # find-or-create，把 merge 补出的节建成 lesson 行）再挂卡；未命中退回 --toc-path
        toc_dir = Path(args.toc_dir) if args.toc_dir else None

        total_cards = 0
        failed_books = 0
        for book_key in sorted(books):
            pages = sorted(books[book_key])
            cards = []
            for p in pages:
                for line in p.read_text(encoding="utf-8").splitlines():
                    if line.strip():
                        cards.append(json.loads(line))
            book_rel = f"{book_key}/{pages[0].name}"
            book_toc = args.toc_path
            if toc_dir is not None:
                matched = _resolve_book_toc(toc_dir, book_key)
                if matched is not None:
                    result = loader.load_toc_structure(str(matched))
                    print(f"[toc] {book_key}: skeleton {result['chapters']} chapters, "
                          f"{result['lessons']} lessons", flush=True)
                    book_toc = str(matched)
                else:
                    book_toc = None
                    print(f"[WARN] {book_key}: TOC 目录下未找到该书目录，走动态建结构", flush=True)
            try:
                n = loader.load_book_cards(book_rel, cards, toc_path=book_toc)
            except RuntimeError as e:
                # 业务数据守卫（如该书有学生 progress 引用旧卡）：报错跳过该书，不影响其他书
                print(f"[ERROR] {e}", flush=True)
                failed_books += 1
                continue
            total_cards += n
            print(f"[ok] {book_key} -> {n} cards", flush=True)

        total_q = 0
        for p in q_files:
            qs = [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]
            rel = p.relative_to(published_dir).as_posix()
            meta = parse_paper_meta(rel)
            paper_ctx = None
            if meta is not None and meta.file_type == "试卷":
                source_key = rel[: -len(".jsonl")]
                paper_id = loader.find_or_create_paper_from_meta(meta, source_key)
                paper_ctx = (meta, paper_id)
            elif meta is None:
                print(f"[WARN] {rel}: 无法解析试卷元数据，题目照常入库但不归组", flush=True)
            n = loader.load_questions(qs, paper=paper_ctx)
            total_q += n
            print(f"[ok] {rel} -> {n} questions"
                  + (f"（paper={paper_ctx[1]}）" if paper_ctx else ""), flush=True)

        print(f"Loaded: {total_cards} cards, {total_q} questions"
              + (f"（{failed_books} 本书因业务数据守卫被跳过）" if failed_books else ""),
              flush=True)
    finally:
        loader.close()


if __name__ == "__main__":
    main()
