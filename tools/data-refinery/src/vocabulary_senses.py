"""把人工整理的「熟词僻义」合并进 `english_words.meanings`。

数据源：`src/vocabulary_extended_senses.jsonl`（我按网上三份资料整理，见每条的 `src` 字段）。
**这不是官方数据** —— 熟词僻义没有课标那样的权威表，网上全是教辅汇编。所以全部靠：
  1. **多来源交叉**（同一个词的僻义在多份资料里一致才收）
  2. **必须是我们已入库的词**（`word` 是唯一键，库里没有就挂不上僻义）
  3. **下面四条程序硬校验**
  4. 落库后仍留 `src` 供人工复核

四条硬校验：
  A. 词必须在库里
  B. **所谓「僻义」不能已经被该词的常见义覆盖** —— 否则它根本不是僻义（最要紧的一条）
  C. 同一个词的义项不重复（幂等：重跑不会叠加）
  D. 语境里应当出现该词（软检查，只告警不拦，因为有 lay/laid 这类不规则变化）

落库方式：读出该词现有 `meanings`，追加 `{"extended":true,...}` 义项并回写，
同时把 `has_extended_sense` 置 1。**不新建行、不动其它列**（尤其不碰 error_count）。
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))

DEFAULT_SENSES = pathlib.Path(__file__).parent / "vocabulary_extended_senses.jsonl"

# 与后端 normalize-english.util.ts 的 splitGlossAtoms 同一套拆分符
GLOSS_SPLIT_RE = re.compile(r"[;；,，、/|｜]+")
CJK_RE = re.compile(r"[\u4e00-\u9fff]")
POS_PREFIX_RE = re.compile(
    r"^(?:n|v|vt|vi|adj|adv|prep|conj|pron|num|art|int|aux|det|pl|abbr)(?:\.|\s)+",
    re.IGNORECASE,
)


def gloss_atoms(gloss: str) -> set[str]:
    """拆释义为原子（与后端同规则），用于 B 条校验。"""
    out: set[str] = set()
    for piece in GLOSS_SPLIT_RE.split(gloss or ""):
        piece = re.sub(r"[（(][^）)]*[）)]", "", piece)
        atom = POS_PREFIX_RE.sub("", piece).strip()
        if atom:
            out.add(atom)
    return out


def context_has_word(context: str, word: str) -> bool:
    c, w = context.lower(), word.lower()
    cands = {w, w + "s", w + "es", w + "ed", w + "d", w + "ing", w + "n"}
    if w.endswith("e"):
        cands |= {w[:-1] + "ing", w[:-1] + "ed"}
    return any(x in c for x in cands)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="合并熟词僻义到 english_words")
    ap.add_argument("--senses", default=str(DEFAULT_SENSES))
    ap.add_argument("--apply", action="store_true", help="真正写库（默认 dry-run）")
    ap.add_argument("--reset", action="store_true",
                    help="先撤掉本脚本此前加过的僻义（按 note 前缀识别）再重跑")
    args = ap.parse_args(argv)

    rows = [json.loads(l) for l in pathlib.Path(args.senses).read_text(encoding="utf-8").splitlines() if l.strip()]

    from config import RefineryConfig
    import pymysql
    cfg = RefineryConfig.from_env()
    conn = pymysql.connect(host=cfg.db_host, port=cfg.db_port, user=cfg.db_user,
                           password=cfg.db_pass, database=cfg.db_name, charset="utf8mb4")

    if args.reset:
        with conn.cursor() as cur:
            cur.execute("SELECT id, meanings FROM english_words WHERE has_extended_sense = 1")
            n = 0
            for rid, m in cur.fetchall():
                try:
                    ss = json.loads(m) if isinstance(m, str) else (m or [])
                except Exception:
                    continue
                keep = [x for x in ss if not str(x.get("note", "")).startswith("熟词僻义·")]
                if len(keep) == len(ss):
                    continue
                has = 1 if any(x.get("extended") for x in keep) else 0
                if args.apply:
                    cur.execute("UPDATE english_words SET meanings = %s, has_extended_sense = %s WHERE id = %s",
                                (json.dumps(keep, ensure_ascii=False), has, rid))
                n += 1
        if args.apply:
            conn.commit()
        print(f"[reset] 撤掉 {n} 行的脚本所加僻义\n")

    kept, dropped, warned = [], [], []
    with conn.cursor() as cur:
        cur.execute("SELECT word, meanings, has_extended_sense FROM english_words")
        db = {}
        for w, m, has in cur.fetchall():
            try:
                senses = json.loads(m) if isinstance(m, str) else m
            except Exception:
                senses = []
            # ⚠️ **按大小写精确索引**。原先用 w.lower() 做键，结果 `bill`（账单）
            # 匹配到了库里的人名 `Bill`，把「钞票」这个僻义挂到了专名上。
            # 本数据集全是小写常用词，精确匹配即可；专名（Bill/Rose/May…）自然被排除。
            db[w] = {"word": w, "senses": senses or [], "has_ext": has}

        seen_pairs: set[tuple[str, str]] = set()
        for r in rows:
            key = r["word"]
            if key not in db:
                dropped.append((r, "词不在库里（或只有大小写不同的专名）"))
                continue
            if (key, r["gloss"]) in seen_pairs:
                dropped.append((r, "文件内重复"))
                continue
            entry = db[key]
            common = [s for s in entry["senses"] if not s.get("extended")]
            # B：僻义不能已经被常见义覆盖
            common_atoms: set[str] = set()
            for s in common:
                common_atoms |= gloss_atoms(s.get("gloss", ""))
            ext_atoms = gloss_atoms(r["gloss"])
            if ext_atoms & common_atoms:
                dropped.append((r, f"与常见义重叠：{sorted(ext_atoms & common_atoms)}"))
                continue
            # C：幂等 —— 已有同 gloss 的僻义就不再加
            if any(s.get("extended") and s.get("gloss") == r["gloss"] for s in entry["senses"]):
                seen_pairs.add((key, r["gloss"]))
                continue
            if not CJK_RE.search(r["gloss"]):
                dropped.append((r, "释义无中文"))
                continue
            if not context_has_word(r["context"], r["word"]):
                warned.append(r)
            seen_pairs.add((key, r["gloss"]))
            kept.append(r)

            if args.apply:
                new_senses = list(entry["senses"]) + [{
                    "pos": r["pos"], "gloss": r["gloss"], "extended": True,
                    "context": r["context"], "note": f"熟词僻义·{r['src']}",
                }]
                cur.execute(
                    "UPDATE english_words SET meanings = %s, has_extended_sense = 1 WHERE word = %s",
                    (json.dumps(new_senses, ensure_ascii=False), entry["word"]),
                )
                entry["senses"] = new_senses
    if args.apply:
        conn.commit()
    conn.close()

    print(f"数据源 {len(rows)} 条 → 采纳 {len(kept)} 条；丢弃 {len(dropped)} 条；语境告警 {len(warned)} 条\n")
    if dropped:
        print("丢弃明细（前 25）:")
        for r, why in dropped[:25]:
            print(f"  ✗ {r['word']:<14} {r['gloss'][:18]:<20} ← {why}")
    if warned:
        print("\n语境里没看出该词（软告警，可能是 lay/laid 这类不规则变化）:")
        for r in warned[:12]:
            print(f"  ⚠ {r['word']:<14} context={r['context'][:40]}")
    print(f"\n{'已写库' if args.apply else '（dry-run，未写库）'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
