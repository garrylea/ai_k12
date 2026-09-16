"""把课本抽出的词条写进 `english_words`。

配套 `vocabulary_book.py`（md → 词条）。本模块负责四件事，都是**入库前必须做对**的：

1. **分层映射**：level 由**书的目录**决定，不是猜的
   `初中/...` → `junior`；`高中/.../必修 X` → `senior_required`；`选择性必修 X` → `senior_elective`
2. **义项拆分**：课本一条词条常含多个义项（`sound /saʊnd/ v. 听起来;好像 n. 声音;响声`），
   按嵌入的词性标记切成 `meanings` 数组的多个元素 —— 这是 `meanings` 该有的形状
3. **跨书去重**：同一个词在多册都出现（教材会复现）。`word` 是唯一业务键，
   故按**先初中后高中、册次从低到高**的顺序保留**首次出现**，并记下全部来源。
4. **应用人工修正表**（`vocabulary_gloss_fixes.jsonl`）：OCR/MinerU 造成的「释义挂到了别的词上」
   没有确定性判据能自动修（详见 `vocabulary_book._flag_suspect_merge`），只能人工定，
   所以把人工结论落成数据文件，由本模块在入库前应用 —— 这样**每次重灌都不会丢**，
   每条改动也都留了 `src` 可追溯。

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

CJK_RE = re.compile(r"[\u4e00-\u9fff]")

_POS = r"(?:modal\s+v|n|v|vt|vi|adj|adv|prep|conj|pron|num|interj|art|aux|det)"
EMBEDDED_POS_RE = re.compile(rf"(?:^|(?<=\s))({_POS})\s*\.", re.IGNORECASE)

# 音标（`/juːs/`）。义项里出现它多半是**解析残留**：课本用「音标 + 词性 + 释义」
# 记同一个词的另一个读音（`use /juːz/ v. 使用；利用` ⏎ `/juːs/ n. 使用;用途`）。
PHONETIC_RE = re.compile(r"/[^/]{1,60}/")


def _is_junk_atom(gloss: str) -> bool:
    """义项里既没有中文也没有拉丁字母 → 是切分残留，不是释义。

    三种来源：词性连接符 `&`（`n. & v. 运动` 切完留下的）、OCR 把 `&` 认成的 `d`/`8`、
    以及纯标点 `,`（`welcome … 受欢迎的 interj., v. & n. 欢迎`）。
    """
    return not re.search(r"[A-Za-z\u4e00-\u9fff]", gloss)


def strip_bare_phonetics(gloss: str) -> str:
    """摘掉**括号外**的音标。括号内的要留 —— `(pl. media /'miːdiə/)媒介`、
    `(=ad/æd/)广告`、`(fought /fɔːt/) 打仗` 都是词条自带的注释，删了就是丢信息。"""
    out: list[str] = []
    depth = 0
    i = 0
    while i < len(gloss):
        ch = gloss[i]
        if ch in "(（":
            depth += 1
        elif ch in ")）":
            depth = max(0, depth - 1)
        if ch == "/" and depth == 0 and not out[-1:] == ["="]:
            m = PHONETIC_RE.match(gloss, i)
            if m:
                i = m.end()
                continue
        out.append(ch)
        i += 1
    return re.sub(r"\s+", " ", "".join(out)).strip()

# ---- 小写化的**正字法例外**（用户 2026-09-16 裁决）----
# 统一小写，但「写小了在英文里就是错的」保留原形。人名地名不在内（写小了只是不规范，
# 不影响学词）。与同形小写词冲突的例外无法保留（唯一键大小写不敏感），见 migrations 注释。
CASE_EXCEPTIONS = {
    "I",
    "UK", "USA", "PRC", "PLA", "HSK", "DDT", "VR", "BCE", "CE", "UN", "PM", "PE", "OK",
    "Mr", "Ms", "Dr",
    "X-ray", "T-shirt", "Wi-Fi",
}


def normalize_case(word: str) -> str:
    """统一小写；命中正字法例外则保留原形。"""
    return word if word in CASE_EXCEPTIONS else word.lower()


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

    # **切分残留**：课本写 `n. & v. 运动;锻炼;练习`（两个词性共用同一个释义），切完会在
    # `n.` 和 `v.` 之间留下一个孤立的 `&`；`welcome … 受欢迎的 interj., v. & n. 欢迎`
    # 还会留下一个孤立的 `,`。第一版把它们当成正经义项，于是 UI 上出现
    # 「词性 n. / 释义 &」这种空壳义项（实测 71 个）。课本的意思是这些词性共用释义，
    # 所以把**后面第一个真义项的释义抄给本义项**；已经是最后一个则直接丢。
    cleaned: list[tuple[str, str]] = []
    for i, (p, g) in enumerate(parts):
        g = strip_bare_phonetics(g.strip(" ;；"))
        if _is_junk_atom(g):
            g = next((x for _, x in parts[i + 1:] if not _is_junk_atom(x)), "")
            g = strip_bare_phonetics(g.strip(" ;；"))
        cleaned.append((p, g))

    senses = []
    for p, g in cleaned:
        # **没有中文的义项不是释义**：课本的 `(= civilisation)`、`(pl. phenomena /-ɪnə/)`、
        # `(NAmE usually afterward)` 只是拼写/变形注解，学生看到「organization ＝ (= organisation)」
        # 等于没有释义。这类注解在有真释义时是冗余，单独出现时是残缺 —— 一律不留。
        if g and CJK_RE.search(g):
            senses.append({"pos": p, "extended": False, "gloss": g})
    return senses


FIXES_PATH = pathlib.Path(__file__).parent / "vocabulary_gloss_fixes.jsonl"


def load_fixes(path: pathlib.Path | None = None) -> dict[str, dict]:
    """读人工修正表（按小写词形索引）。"""
    p = path or FIXES_PATH
    if not p.exists():
        return {}
    out: dict[str, dict] = {}
    for line in p.read_text(encoding="utf-8").splitlines():
        if line.strip():
            r = json.loads(line)
            out[r["word"].lower()] = r
    return out


def apply_fix(senses: list[dict], fix: dict, stats: dict) -> list[dict]:
    """对一条词条的义项应用修正：`replace` > `drop` + `add`。

    ⚠️ `drop` **只删匹配得上的**，匹配不上不算错 —— 同一个词在多册出现，
    只有被交错的那一册的义项是脏的（`dress` 在七上 p.134 脏、在另一册干净），
    而「首次出现」留哪一册由册次顺序决定。所以这里宽松处理，
    最后再由 `collect()` 统一校验「每条 drop 至少命中过一次」，避免修正悄悄失效。
    """
    if "replace" in fix:
        stats["fix_replace"] = stats.get("fix_replace", 0) + 1
        return [{"pos": s.get("pos", ""), "gloss": s["gloss"], "extended": False}
                for s in fix["replace"]]
    out = list(senses)
    for bad in fix.get("drop", []):
        for i, s in enumerate(out):
            if bad not in s["gloss"]:
                continue
            stats.setdefault("fix_drop_hit", set()).add(f"{fix['word']}:{bad}")
            stats["fix_drop"] = stats.get("fix_drop", 0) + 1
            # **摘掉那一小段，不是整条义项删掉**：双栏交错时两段释义会被并成**一个**义项
            # （`money` → `n. 钱;财富 捕捉;接住`，中间没有词性标记，split_senses 切不开），
            # 整条删掉会把 `钱;财富` 也一起删掉（实测 money 因此变成 0 义项的词条）。
            # 摘完只剩空白（`dress` → `逛商店;在商店购物`）才整条丢。
            rest = s["gloss"].replace(bad, "").strip(" ;；")
            if rest:
                s["gloss"] = rest
            else:
                out[i] = None
        out = [s for s in out if s]
    for add in fix.get("add", []):
        if any(s["gloss"] == add["gloss"] for s in out):
            continue                        # 幂等：多册重复时同一修正会走到多次
        if not CJK_RE.search(add["gloss"]):
            raise RuntimeError(f"修正表要加的释义没有中文：{fix['word']} {add['gloss']!r}")
        out.append({"pos": add.get("pos", ""), "gloss": add["gloss"], "extended": False})
        stats["fix_add"] = stats.get("fix_add", 0) + 1
    # **摘掉多余片段后可能和另一条撞车**：同一个词在多册出现，干净的那册给
    # `喜悦;乐趣`，脏的那册给 `喜悦;乐趣 (使)远离…`，先按 gloss 去重合并、再摘片段
    # → 两条变成一模一样（实测 joy 3 条、trust/nosebleed 各 2 条）。
    # 同词性同释义的义项对用户没有任何差别，去重。顺便把形状归一（pos/gloss/extended），
    # 免得改过的义项和没改过的字段不一致。
    uniq: list[dict] = []
    seen_pairs: set[tuple[str, str]] = set()
    for s in out:
        k = (s.get("pos", ""), s["gloss"])
        if k not in seen_pairs:
            seen_pairs.add(k)
            uniq.append({"pos": s.get("pos", ""), "gloss": s["gloss"],
                         "extended": bool(s.get("extended"))})
    return uniq


def collect(md_root: pathlib.Path, fixes: dict[str, dict] | None = None) -> tuple[list[dict], dict]:
    """遍历所有书的 md 目录 → 去重后的词条列表 + 统计。"""
    fixes = fixes if fixes is not None else load_fixes()
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
        # 记录违规条目本身（不是个数）：违规的那条很可能在去重时被丢掉，
        # 只报个数的话调用方一条都查不到（见 check_monotonic 的注释）。
        for prev_word, e in vb.check_monotonic(book_entries):
            stats.setdefault("order_violation_items", []).append(
                (e.word, prev_word, f"{label} p.{e.page}", e.section))
        stats["order_violations"] = len(stats.get("order_violation_items", []))
        for e in book_entries:
            stats["raw"] += 1
            if e.flags and "bad_word_charset" in e.flags:
                stats["flagged"] += 1
                continue                       # 词形不合法（含省略号/乱码）不进库
            key = normalize_case(e.word).lower()
            fix = fixes.get(key)
            # **释义为空的词条丢掉**（书名、练习答案页的选项行、OCR 掉了释义的词）。
            # 但走这条路的不止垃圾：双栏交错时被抢走释义的真词（`catch`/`grandfather`）
            # 也是这样 —— 所以**修正表里点名的词要放行**，由 apply_fix 给它补上释义。
            if e.flags and "no_gloss" in e.flags and not fix:
                stats["no_gloss"] = stats.get("no_gloss", 0) + 1
                continue
            if key in seen:
                stats["duplicated"] += 1
                seen[key]["_sources"].append(f"{label} p.{e.page}")
                # **合并义项而不是丢弃**。原先这里直接 continue，于是「同一个词的不同义项」
                # 只留首次出现的那个 —— 而 `word` 的唯一键是**大小写不敏感**的，
                # 所以 `IT`（信息技术）与 `it`（它）、`US`/`us`、`WHO`/`who`、`Bill`/`bill`
                # 本来就是同一行，后者会把它的释义覆盖掉，**代词 it/us/who 直接消失**。
                # 现在按 gloss 去重后合并，两种意思都留下。
                if "no_gloss" in e.flags:
                    continue                   # 空借义项不参与合并
                existing_glosses = {x["gloss"] for x in seen[key]["senses"]}
                for x in split_senses(e.pos, e.gloss):
                    if x["gloss"] not in existing_glosses:
                        seen[key]["senses"].append(x)
                        existing_glosses.add(x["gloss"])
                if fix:
                    seen[key]["senses"] = apply_fix(seen[key]["senses"], fix, stats)
                    stats.setdefault("fixed_words", set()).add(key)
                    seen[key]["_flags"] = [f for f in seen[key]["_flags"]
                                           if f != "suspect_foreign_gloss"]
                continue
            senses = split_senses(e.pos, e.gloss)
            if fix:
                senses = apply_fix(senses, fix, stats)
                stats.setdefault("fixed_words", set()).add(key)
            seen[key] = {
                "word": normalize_case(e.word),
                "phonetic": f"/{e.phonetic}/" if e.phonetic else None,
                "level": level,
                "senses": senses,
                "_page": e.page,
                # `no_gloss` 是「本该丢掉」的标记、`suspect_foreign_gloss` 是「等人工判断」的标记，
                # 修正表点过名就说明这两件事都已处理完了，别再挂在复核清单里占位。
                "_flags": [f for f in e.flags
                           if f not in ("no_gloss",) and not (fix and f == "suspect_foreign_gloss")],
                "_sources": [f"{label} p.{e.page}"],
                "_order": len(seen),
            }
    # 修正表里带 `create` 的词允许**凭空建行**：OCR 把整行词头都吃掉时
    # （`/'grænfɑːðə(r)/ ) n. 爷爷;外公` —— 词形没了），解析结果里连词形都找不到，
    # 只能由修正表给出音标与学段（两项都取自课本原文与该书目录，不是编的）。
    for w, f in fixes.items():
        if w in seen or "create" not in f:
            continue
        c = f["create"]
        senses = apply_fix([], f, stats)
        if not senses:
            raise RuntimeError(f"修正表 create 了 {w} 但没同时给释义（add 为空）")
        seen[w] = {
            "word": f["word"], "phonetic": c["phonetic"], "level": c["level"],
            "senses": senses, "_page": 0, "_flags": [],
            "_sources": [c.get("src", "人工修正表 create")], "_order": len(seen),
        }
    # 修正表里点名但一条都没匹配上的词 → 报错（见 apply_fix 的同理注释）
    missed = sorted(set(fixes) - set(seen))
    if missed:
        raise RuntimeError(f"修正表里有 {len(missed)} 个词在解析结果里完全没出现：{missed[:8]}")
    # 每条 drop 至少要命中过一次，否则说明课本/解析变了而修正表没跟着更新 ——
    # 静默放过会让修正悄悄失效（比报错糟得多）
    hit = stats.get("fix_drop_hit", set())
    stale = [f"{w}:{bad}" for w, f in fixes.items() for bad in f.get("drop", [])
             if f"{w}:{bad}" not in hit]
    if stale:
        raise RuntimeError(f"修正表的 drop 有 {len(stale)} 条一次都没命中，说明数据已变：{stale[:5]}")
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


def prune(rows: list[dict], *, dry_run: bool = True) -> None:
    """删掉「库里有过、这次解析不出来的」词条。

    为什么必须有这一步：本 loader 只做 upsert，**删不掉东西**。上一版解析器因为 bug
    产出过一堆垃圾词条（`n. (pl. grandchildren /…/)`、`t-shirt t`、`useless`、`do aux`…），
    重灌只会把好词条写对，那些垃圾会**永远留在库里**（实测 17 条），学生照样能抽到它们。

    ⚠️ 两道守卫，命中就**不删**并报出来：
      · 已经被学生背过的（`student_word_progress` 有引用）—— 删了会留下悬挂的进度行
      · 带人工标注的僻义（`has_extended_sense = 1`）—— 那是人工数据
    （`english_words` 上没有任何入向外键，所以删除本身不会被外键卡住，见建表迁移的注释。）
    """
    from config import RefineryConfig
    import pymysql

    cfg = RefineryConfig.from_env()
    conn = pymysql.connect(host=cfg.db_host, port=cfg.db_port, user=cfg.db_user,
                           password=cfg.db_pass, database=cfg.db_name, charset="utf8mb4")
    keep_words = {r["word"].lower() for r in rows}
    try:
        with conn.cursor() as cur:
            cur.execute("""SELECT w.id, w.word, w.has_extended_sense,
                                  (SELECT COUNT(*) FROM student_word_progress p WHERE p.word_id = w.id)
                           FROM english_words w""")
            doomed, guarded = [], []
            for wid, word, has_ext, used in cur.fetchall():
                if word.lower() in keep_words:
                    continue
                (guarded if (has_ext or used) else doomed).append((wid, word))
            print(f"\n[prune] 库里多出来的词条 {len(doomed) + len(guarded)} 条："
                  f"可删 {len(doomed)}、有守卫跳过 {len(guarded)}")
            for _, w in doomed:
                print(f"    删 {w!r}")
            for _, w in guarded:
                print(f"    留（有僻义标注或学生已背过）{w!r}")
            if dry_run:
                return
            if doomed:
                # ⚠️ 参数必须是单元素元组：`executemany` 会把整个元组拿去 `%` 格式化，
                # 多带一个 word 就会 `TypeError: not all arguments converted`（踩过，
                # 结果是「报告里说删了、库里其实一条没删」而命令还照常退出）。
                cur.executemany("DELETE FROM english_words WHERE id = %s", [(i,) for i, _ in doomed])
        conn.commit()
    finally:
        conn.close()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="课本词条 → english_words")
    ap.add_argument("--md-root", default=str(pathlib.Path(__file__).parent.parent / "output" / "vocabulary_md"))
    ap.add_argument("--apply", action="store_true", help="真正写库（默认 dry-run）")
    ap.add_argument("--dump", help="把去重后的词条写成 JSONL 以备复核")
    ap.add_argument("--prune", action="store_true",
                    help="删掉库里这次解析不出来的词条（上一版解析器的垃圾产物）")
    ap.add_argument("--list-issues", action="store_true", help="逐条列出所有带标记的词条")
    args = ap.parse_args(argv)

    rows, stats = collect(pathlib.Path(args.md_root))
    print(f"\n书 {stats['books']} 本；原始词条 {stats['raw']}；跨书重复 {stats['duplicated']}；"
          f"词形不合法丢弃 {stats['flagged']}；去重后 **{len(rows)}** 条")

    from collections import Counter
    print("分层分布: " + "  ".join(f"{k}={v}" for k, v in Counter(r["level"] for r in rows).most_common()))
    nsense = Counter(len(r["senses"]) for r in rows)
    print("义项数分布: " + "  ".join(f"{k}个义项:{v}" for k, v in sorted(nsense.items())))
    print(f"字母序单调性违规（按书+分段比，应接近 0）: {stats.get('order_violations', 0)}")
    if args.list_issues:
        # 全量列出：字母序违规是「按 Vocabulary A-Z 段该递增却回退」，绝大多数是 OCR 认错，
        # 但也可能是词表本身把词组排在了别处；只靠计数看不出该改哪个，必须逐条看。
        for w, prev, src, sec in stats.get("order_violation_items", []):
            print(f"    [order_violation] {prev!r} → {w!r}  （{sec} 段）← {src}")
    print(f"无释义丢弃: {stats.get('no_gloss', 0)}")
    if stats.get("fix_drop") or stats.get("fix_add") or stats.get("fix_replace"):
        print(f"人工修正表（{FIXES_PATH.name}）: 摘掉多余片段 {stats.get('fix_drop', 0)} 处、"
              f"补义项 {stats.get('fix_add', 0)} 处、整体替换 {stats.get('fix_replace', 0)} 处")
    bad = [r for r in rows if r["_flags"]]
    print(f"仍带标记（需人工看）: {len(bad)}")
    # 释义留空兜底：真实数据里不该再有 0 义项的词条（有的话下面这行会 IndexError 把 dump 也带崩）
    def _first_gloss(r: dict) -> str:
        return r["senses"][0]["gloss"][:30] if r["senses"] else "(无释义)"
    if args.list_issues:
        for r in bad:
            print(f"    [{','.join(r['_flags'])}] {r['word']!r}  {_first_gloss(r)}"
                  f"  ← {r['_sources'][0]}")
    else:
        for r in bad[:8]:
            print(f"    [{','.join(r['_flags'])}] {r['word'][:30]!r} {_first_gloss(r)}")

    if args.dump:
        with open(args.dump, "w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        print(f"已写 {args.dump}")

    load(rows, dry_run=not args.apply)
    if args.prune:
        prune(rows, dry_run=not args.apply)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
