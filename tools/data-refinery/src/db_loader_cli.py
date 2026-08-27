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


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="把 published JSONL 加载进 MySQL")
    parser.add_argument("--input-dir", help="published 输入目录（默认 output/published）")
    parser.add_argument("--source", choices=["all", "zgkao", "smartedu"], default="all", help="素材来源过滤")
    parser.add_argument("--load-toc", action="store_true", help="只 load_toc_structure()，不入库 card（需配合 --toc-path）")
    parser.add_argument("--load-cards", action="store_true", help="只 card/questions 入库，不建骨架")
    parser.add_argument("--toc-path", help="TOC JSON 路径（--load-toc 时必传；--load-cards 时可选）")
    parser.add_argument("--purge-business-data", action="store_true",
                        help="full-reload 前清空引用 cards/questions 的业务数据"
                             "（answers/错题本/变式题/作业提交/progress，不可恢复）；"
                             "默认遇业务数据报错退出，防止误删学生数据")
    parser.add_argument("--dry-run", action="store_true", help="只打印，不入库")
    return parser.parse_args(argv)


def _kind(name: str) -> str:
    return "questions" if ("试卷" in name or "答案" in name) else "cards"


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
        if not args.toc_path:
            print("[ERROR] --load-toc requires --toc-path", flush=True)
            return
        loader = DbLoader(cfg.db_host, cfg.db_port, cfg.db_user, cfg.db_pass, cfg.db_name)
        try:
            result = loader.load_toc_structure(args.toc_path)
            print(f"[ok] TOC loaded: {result['chapters']} chapters, {result['lessons']} lessons", flush=True)
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

        total_cards = 0
        for book_key in sorted(books):
            pages = sorted(books[book_key])
            cards = []
            for p in pages:
                for line in p.read_text(encoding="utf-8").splitlines():
                    if line.strip():
                        cards.append(json.loads(line))
            book_rel = f"{book_key}/{pages[0].name}"
            n = loader.load_book_cards(book_rel, cards, toc_path=args.toc_path)
            total_cards += n
            print(f"[ok] {book_key} -> {n} cards", flush=True)

        total_q = 0
        for p in q_files:
            qs = [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]
            n = loader.load_questions(qs)
            total_q += n
            print(f"[ok] {p.relative_to(published_dir)} -> {n} questions", flush=True)

        print(f"Loaded: {total_cards} cards, {total_q} questions", flush=True)
    finally:
        loader.close()


if __name__ == "__main__":
    main()
