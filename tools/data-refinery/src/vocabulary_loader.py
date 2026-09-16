"""把课本抽出的词条写进 `english_words`。

配套 `vocabulary_book.py`（md → 词条）。本模块负责三件事，都是**入库前必须做对**的：

1. **分层映射**：level 由**书的目录**决定，不是猜的
   `初中/...` → `junior`；`高中/.../必修 X` → `senior_required`；`选择性必修 X` → `senior_elective`
2. **义项拆分**：课本一条词条常含多个义项（`sound /saʊnd/ v. 听起来;好像 n. 声音;响声`），
   按嵌入的词性标记切成 `meanings` 数组的多个元素 —— 这是 `meanings` 该有的形状
3. **跨书去重**：同一个词在多册都出现（教材会复现）。`word` 是唯一业务键，
   故按**先初中后高中、册次从低到高**的顺序保留**首次出现**，并记下全部来源。

⚠️ **`error_count` 绝不能出现在 `ON DUPLICATE KEY UPDATE` 子句里** —— 它是全平台累计错次，
一次全量重灌抹掉它就再也回不来了（同内容管线 loader 的规则，见 schema 注释）。
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))

import vocabulary_book as vb  # noqa: E402

_POS = r"(?:modal\s+v|n|v|vt|vi|adj|adv|prep|conj|pron|num|interj|art|aux|det)"
EMBEDDED_POS_RE = re.compile(rf"(?:^|(?<=\s))({_POS})\s*\.", re.IGNORECASE)

LEVEL_BY_DIR = (
    ("选择性必修", "senior_elective"),
    ("必修", "senior_required"),
    ("初中", "junior"),
    ("小学", "primary"),
)


def level_of(book_dir_name: str) -> str | None:
    for key, level in LEVEL_BY_DIR:
        if key in book_dir_name:
            return level
    return None


def grade_order(book_dir_name: str) -> int:
    """册次排序：初中在前（七年级→九年级），高中在后。仅用于决定去重时留哪一条。"""
    stage = 0 if "初中" in book_dir_name else 1
    grade = 0
    for i, g in enumerate(["七", "八", "九"], start=1):
        if f"{g}年级" in book_dir_name:
            grade = i
            break
    book_no = 0
    m = re.search(r"第([一二三四])册", book_dir_name)
    if m:
        book_no = "一二三四".index(m.group(1)) + 1
    term = 1 if "下册" in book_dir_name else 0
    return stage * 1000 + grade * 100 + book_no * 10 + term


def split_senses(pos: str, gloss: str) -> list[dict]:
    """把一条词条的（词性, 释义）按**嵌入的词性标记**切成多个义项。

    例：pos='v.', gloss='听起来;好像 n. 声音;响声' → [{v., 听起来;好像}, {n., 声音;响声}]
    切不出嵌入标记时就是单义项（最常见）。
    """
    parts: list[tuple[str, str]] = []
    cur_pos = pos
    last = 0
    for m in EMBEDDED_POS_RE.finditer(gloss):
        if m.start() > last:
            parts.append((cur_pos, gloss[last:m.start()].strip()))
        cur_pos = m.group(1).strip() + "."
        last = m.end()
    parts.append((cur_pos, gloss[last:].strip()))
    senses = []
    for p, g in parts:
        g = g.strip(" ;；")
        if g:
            senses.append({"pos": p, "extended": False, "gloss": g})
    return senses


def collect(md_root: pathlib.Path) -> tuple[list[dict], dict]:
    """遍历所有书的 md 目录 → 去重后的词条列表 + 统计。"""
    books = sorted(md_root.iterdir(), key=lambda p: grade_order(p.name))
    seen: dict[str, dict] = {}
    stats = {"books": 0, "raw": 0, "duplicated": 0, "unleveled": 0, "flagged": 0}
    for book in books:
        if not book.is_dir():
            continue
        level = level_of(book.name)
        if level is None:
            stats["unleveled"] += 1
            print(f"  [跳过] 认不出学段：{book.name[:60]}")
            continue
        stats["books"] += 1
        # 书名的可读部分（去掉目录拼接用的 __）
        label = book.name.replace("__", " · ")
        try:
            book_entries = list(vb.parse_entries(book, label))
        except RuntimeError as err:
            # 例如下载被打断的残本：尾部几页够不到书末单词表 → 明确跳过并报出来，
            # 不要让它把整批跑挂掉，也不要静默当成「这本书没有词表」。
            stats.setdefault("skipped_books", []).append(str(err))
            print(f"  [跳过整本] {err}")
            continue
        for e in book_entries:
            stats["raw"] += 1
            if e.flags and "bad_word_charset" in e.flags:
                stats["flagged"] += 1
                continue                       # 词形不合法（含省略号/乱码）不进库
            key = e.word.lower()
            if key in seen:
                stats["duplicated"] += 1
                seen[key]["_sources"].append(f"{label} p.{e.page}")
                continue
            seen[key] = {
                "word": e.word,
                "phonetic": f"/{e.phonetic}/" if e.phonetic else None,
                "level": level,
                "senses": split_senses(e.pos, e.gloss),
                "_page": e.page,
                "_flags": e.flags,
                "_sources": [f"{label} p.{e.page}"],
                "_order": len(seen),
            }
    return list(seen.values()), stats


def load(rows: list[dict], *, dry_run: bool = True) -> None:
    from config import RefineryConfig
    import pymysql

    cfg = RefineryConfig.from_env()
    conn = pymysql.connect(host=cfg.db_host, port=cfg.db_port, user=cfg.db_user,
                           password=cfg.db_pass, database=cfg.db_name, charset="utf8mb4")
    try:
        with conn.cursor() as cur:
            # **保留库里已有的 curated 熟词僻义**：本次入库的 meanings 来自课本，只有常见义
            # （extended=false）。若库里某词已有 extended=true 的义项（人工/开发种子标的），
            # 直接覆盖会把它毁掉——同 `error_count` 的道理：loader 不该毁掉**人工或派生的数据**。
            cur.execute("SELECT word, meanings FROM english_words WHERE has_extended_sense = 1")
            keep: dict[str, list[dict]] = {}
            for w, m in cur.fetchall():
                try:
                    senses = json.loads(m) if isinstance(m, str) else m
                except Exception:
                    continue
                ext = [s for s in (senses or []) if isinstance(s, dict) and s.get("extended")]
                if ext:
                    keep[w.lower()] = ext

            kept = 0
            for r in rows:
                senses = list(r["senses"])
                for old in keep.get(r["word"].lower(), []):
                    if not any(s.get("gloss") == old.get("gloss") for s in senses):
                        senses.append(old)
                        kept += 1
                meanings = json.dumps(senses, ensure_ascii=False)
                has_ext = 1 if any(s.get("extended") for s in senses) else 0
                if dry_run:
                    continue
                cur.execute(
                    """INSERT INTO english_words
                         (word, phonetic, level, meanings, has_extended_sense, root_key, root_affixes,
                          error_count, sort_order, source_ref, verified, is_active)
                       VALUES (%s, %s, %s, %s, %s, NULL, NULL, 0, %s, %s, 1, 1) AS new
                       ON DUPLICATE KEY UPDATE
                         phonetic = new.phonetic,
                         level = new.level,
                         meanings = new.meanings,
                         has_extended_sense = new.has_extended_sense,
                         sort_order = new.sort_order,
                         source_ref = new.source_ref,
                         verified = new.verified""",
                    # ↑ UPDATE 里**没有 error_count**，见模块 docstring
                    (r["word"], r["phonetic"], r["level"], meanings, has_ext,
                     r["_order"], "; ".join(r["_sources"][:3])[:200]),
                )
        if dry_run:
            print("（dry-run，未写库）")
        else:
            conn.commit()
            print(f"已提交 {len(rows)} 条；其中保留库里已有僻义义项 {kept} 个")
    finally:
        conn.close()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="课本词条 → english_words")
    ap.add_argument("--md-root", default=str(pathlib.Path(__file__).parent.parent / "output" / "vocabulary_md"))
    ap.add_argument("--apply", action="store_true", help="真正写库（默认 dry-run）")
    ap.add_argument("--dump", help="把去重后的词条写成 JSONL 以备复核")
    args = ap.parse_args(argv)

    rows, stats = collect(pathlib.Path(args.md_root))
    print(f"\n书 {stats['books']} 本；原始词条 {stats['raw']}；跨书重复 {stats['duplicated']}；"
          f"词形不合法丢弃 {stats['flagged']}；去重后 **{len(rows)}** 条")

    from collections import Counter
    print("分层分布: " + "  ".join(f"{k}={v}" for k, v in Counter(r["level"] for r in rows).most_common()))
    nsense = Counter(len(r["senses"]) for r in rows)
    print("义项数分布: " + "  ".join(f"{k}个义项:{v}" for k, v in sorted(nsense.items())))
    bad = [r for r in rows if r["_flags"]]
    print(f"仍带标记（需人工看）: {len(bad)}")
    for r in bad[:8]:
        print(f"    [{','.join(r['_flags'])}] {r['word'][:30]!r} {r['senses'][0]['gloss'][:26]}")

    if args.dump:
        with open(args.dump, "w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        print(f"已写 {args.dump}")

    load(rows, dry_run=not args.apply)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
