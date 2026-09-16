"""词根族：在**已核对的词表内**按词缀找同族词，产出待审草稿。

设计约束（见 spec §3.3 / 决策 10-11）：
  · **不建新表**：族 = `root_key` 相同的行，中心词自己 `root_key = word`；成员的词缀注记放 `root_affixes`
  · **族中心必须在词表内**（P0 硬规则）→ 所以族只在**我们已入库的词**之间连边，不引外部词根
  · **释义不新造**：每个成员的释义就是它自己那行的 gloss，族树渲染时现取——本脚本只产出**边与词缀注记**
  · 纯前缀匹配会产生假阳性（`car → card` 毫无关系），所以**要求差异部分必须是已知词缀**

**草稿是离线审查产物，不进仓库**（默认写到 `output/`，已被 .gitignore）：
  · 真正的源数据是下面 `AFFIXES`（词缀表）与 `EXCLUDE_EDGES`（人工审核排除的假阳性）这两段代码；
  · 审查时跑 `python3 -m src.vocabulary_roots`（不传 `--apply`），打开草稿看；
  · 审完跑 `--apply`，`load()` 会先**清空全表 root_key/root_affixes 再重写**，所以草稿不会留成脏数据。
  之前默认写到 `src/` 里、还被 git 跟踪，结果审查完它就成了「既非源数据、又非当前数据」的死文件，
  把人带偏过两次（看它以为内容是当前提案，其实是上一轮已入库的）。
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))

# 词缀表（人工整理，逐条可核对）。`gloss` 是给学生看的含义，`posHint` 是构词提示。
# 只收**能改变词性/词义**的派生词缀；屈折变化（-s/-ed/-ing 的纯语法形）单独一组，
# 它们不构成「新词」，但作为族成员仍有教学价值（学生能一眼看到词形变化）。
AFFIXES = [
    # ---- 后缀 ----
    ("suffix", "ful", "充满…的；有…性质的", "→ 形容词"),
    ("suffix", "fully", "充满…地（-ful + -ly）", "→ 副词"),
    ("suffix", "less", "无…的；没有…的", "→ 形容词"),
    ("suffix", "lessly", "无…地（-less + -ly）", "→ 副词"),
    ("suffix", "ness", "性质；状态", "→ 名词"),
    ("suffix", "ly", "以…方式", "→ 副词"),
    ("suffix", "ment", "行为；结果", "→ 名词"),
    ("suffix", "ion", "行为；结果", "→ 名词"),
    ("suffix", "tion", "行为；结果", "→ 名词"),
    ("suffix", "sion", "行为；结果", "→ 名词"),
    ("suffix", "ation", "行为；结果", "→ 名词"),
    ("suffix", "er", "做…的人或物", "→ 名词"),
    ("suffix", "or", "做…的人或物", "→ 名词"),
    ("suffix", "ist", "…的人；…主义者", "→ 名词"),
    ("suffix", "ian", "…的人；…家", "→ 名词"),
    ("suffix", "ance", "性质；状态", "→ 名词"),
    ("suffix", "ence", "性质；状态", "→ 名词"),
    ("suffix", "ity", "性质；状态", "→ 名词"),
    ("suffix", "able", "能…的；可…的", "→ 形容词"),
    ("suffix", "ible", "能…的；可…的", "→ 形容词"),
    ("suffix", "ive", "有…性质的", "→ 形容词"),
    ("suffix", "ous", "有…性质的", "→ 形容词"),
    ("suffix", "al", "…的", "→ 形容词"),
    ("suffix", "ic", "…的", "→ 形容词"),
    ("suffix", "en", "使…；变得…", "→ 动词"),
    ("suffix", "ize", "使…化", "→ 动词"),
    ("suffix", "ise", "使…化", "→ 动词"),
    ("suffix", "y", "有…的；多…的", "→ 形容词"),
    ("suffix", "ing", "动作；进行中", "→ 动名词/现在分词"),
    ("suffix", "ed", "已…的；过去", "→ 过去式/过去分词"),
    ("suffix", "s", "复数；第三人称单数", "→ 屈折变化"),
    ("suffix", "es", "复数；第三人称单数", "→ 屈折变化"),
    # ---- 前缀 ----
    ("prefix", "un", "不；相反", "→ 否定"),
    ("prefix", "re", "再；重新", "→ 重复"),
    ("prefix", "dis", "不；相反；除去", "→ 否定"),
    ("prefix", "in", "不；相反", "→ 否定"),
    ("prefix", "im", "不；相反", "→ 否定"),
    ("prefix", "non", "非；不", "→ 否定"),
    ("prefix", "mis", "错误地", "→ 错误"),
    ("prefix", "over", "过度；在上", "→ 程度"),
    ("prefix", "under", "不足；在下", "→ 程度"),
    ("prefix", "pre", "预先；在…之前", "→ 时间"),
    ("prefix", "post", "在…之后", "→ 时间"),
    ("prefix", "inter", "在…之间；相互", "→ 关系"),
    ("prefix", "super", "超；上", "→ 程度"),
    ("prefix", "sub", "在下；次", "→ 关系"),
    ("prefix", "en", "使…", "→ 使动"),
    ("prefix", "tele", "远距离", "→ 方式"),
    ("prefix", "bio", "生命", "→ 领域"),
    ("prefix", "micro", "微小", "→ 程度"),
]

# ---- 人工审核决定：这些边「字符串像、词源无关」，逐条排除 ----
# 审核方法与理由：`-er/-or` 与前缀派生两类最容易假阳性，脚本已全部标 `_review`，
# 我逐条看过。判据是**语义上学生能不能由此受益**——像 factor/tailor 这种词源上确实
# 沾边、但对 K12 学生完全看不出关系的，也一并排除（留在树里只会误导）。
EXCLUDE_EDGES = {
    ("care", "career"): "career 与 care 无关（字符串巧合）",
    ("both", "bother"): "bother 与 both 无关",
    ("corn", "corner"): "corner 与 corn 无关",
    ("play", "display"): "display 不是 dis- + play",
    ("flow", "flower"): "flower 与 flow 无关",
    ("off", "offer"): "offer 与 off 无关",
    ("age", "image"): "image 不是 im- + age",
    ("prove", "improve"): "improve 不是 im- + prove",
    ("should", "shoulder"): "shoulder 与 should 无关",
    ("show", "shower"): "shower 与 show 无关",
    ("sweat", "sweater"): "sweater 与 sweat 无关",
    ("tail", "tailor"): "tailor 与 tail 无关",
    ("fact", "factor"): "词源沾边但学生看不出关系",
    ("less", "unless"): "unless 不是 un- + less",
    ("try", "entry"): "entry 不是 en- + try",
    ("tend", "pretend"): "pretend 不是 pre- + tend",
    ("member", "remember"): "remember 不是 re- + member",
    ("public", "republic"): "republic 不是 re- + public",
    ("late", "relate"): "relate 不是 re- + late",
    ("serve", "preserve"): "preserve 不是 pre- + serve",
    ("present", "represent"): "词源沾边但学生看不出关系",
    ("engine", "engineer"): "词源沾边但学生看不出关系",
    ("draw", "drawer"): "drawer 现在主要指抽屉，关系已不明显",
    ("miss", "mission"): "mission 与 miss 无关（同形巧合）",
    ("port", "importance"): "importance 与 port 的语义链对 K12 学生太隐晦",
}

MIN_BASE_LEN = 3     # 词干太短容易误连（car/card）
MIN_PREFIX_BASE_LEN = 3


def candidates(words: dict[str, str]) -> list[dict]:
    """在词表内找同族边。

    `words` 是 {小写词: 原始词}。返回**待审草稿**：每条给出中心词、成员、词缀。
    中心词取「在词表内、且是成员前缀」的**最短**那个（真正的词根），
    这样 care/careful/careless/carefully 落在同一族，而不是拆成两族。
    """
    # **排除专名**：大写开头的词（Badal/Bill/Rose/China）是专有名词，
    # 不参与构词分析 —— 否则会出现 `bad → Badal` 这种把词根挂到人名上的荒谬边。
    lower = {w.lower(): w for w in words if w[:1].islower()}
    affix_index: dict[str, tuple[str, str, str]] = {}
    for typ, code, gloss, hint in AFFIXES:
        affix_index[code] = (typ, gloss, hint)

    draft: list[dict] = []
    for lw in sorted(lower):
        if " " in lw or "'" in lw or "-" in lw:
            continue                                  # 词组/连字符词不参与构词分析
        best = None
        # 后缀：词 = 词干 + 后缀（词干必须在词表内）
        for code, (typ, gloss, hint) in affix_index.items():
            if typ != "suffix" or not lw.endswith(code):
                continue
            base = lw[: -len(code)]
            if len(base) < MIN_BASE_LEN or base not in lower or base == lw:
                continue
            if best is None or len(base) < len(best[0]):
                best = (base, code, gloss, hint)
        # 前缀：词 = 前缀 + 词干
        for code, (typ, gloss, hint) in affix_index.items():
            if typ != "prefix" or not lw.startswith(code):
                continue
            base = lw[len(code):]
            if len(base) < MIN_PREFIX_BASE_LEN or base not in lower or base == lw:
                continue
            if best is None or len(base) < len(best[0]):
                best = (base, code, gloss, hint)
        if best is None:
            continue
        base, code, gloss, hint = best
        typ = "prefix" if lw.startswith(code) else "suffix"
        if (base, lw) in EXCLUDE_EDGES:
            continue                              # 人工审核排除的假阳性
        risky = typ == "prefix" or code in ("er", "or")
        affix = {"type": typ, "code": f"{code}-" if typ == "prefix" else f"-{code}",
                 "gloss": gloss, "posHint": hint}
        draft.append({
            "root": lower[base],
            "member": lower[lw],
            "affixes": [affix],
            **({"_review": "prefix-or-er"} if risky else {}),
        })

    # ---- 上溯到真正的族根 ----
    # 只取「一级父节点」会让 `interaction → action → act` 形成链，于是 `action`
    # **既是成员又是族中心** —— 而 `root_key` 只能有一个值，族中心就会从自己的族里消失
    # （前端族树要求中心词本身在族人里）。所以每个词都要沿父指针走到顶，
    # 并把沿途的词缀累积起来（`interaction` → 根 `act`，词缀 `inter-` + `-ion`）。
    parent: dict[str, str] = {}
    for d in draft:
        parent[d["member"].lower()] = d["root"].lower()
    by_member = {d["member"].lower(): d for d in draft}

    flat: list[dict] = []
    for d in draft:
        cur = d["member"].lower()
        affixes: list[dict] = []
        guard = 0
        while cur in parent and guard < 10:
            step = by_member[cur]
            affixes.append(step["affixes"][0])
            cur = parent[cur]
            guard += 1
        # 词缀按「先前缀（外→内）后后缀（内→外）」读起来才顺
        # 读序要与构词一致：前缀由外向内、后缀由内向外。
        # 上溯时收集到的顺序是「由内向外」的（actively 先收 -ly 再收 -ive），
        # 所以两边都要 reversed，否则会显示成 act + ly + ive。
        pre = [a for a in reversed(affixes) if a["type"] == "prefix"]
        suf = [a for a in reversed(affixes) if a["type"] == "suffix"]
        flat.append({
            "root": lower.get(cur, cur),
            "member": d["member"],
            "affixes": pre + suf,
            **({"_review": d["_review"]} if "_review" in d else {}),
        })
    return flat


def load(fam: dict[str, list[dict]], apply: bool) -> None:
    """把族写进库：**中心词 root_key = 自己**（族查询 `WHERE root_key = ?` 依赖这条不变式），
    成员 root_key = 中心词、root_affixes = 词缀数组。

    幂等做法：先把全表 root_key / root_affixes 清空再写入 —— 只更新「当前草稿里的词」
    会把上一轮生成、这一轮被排除的边留成脏数据。
    """
    from config import RefineryConfig
    import pymysql
    cfg = RefineryConfig.from_env()
    conn = pymysql.connect(host=cfg.db_host, port=cfg.db_port, user=cfg.db_user,
                           password=cfg.db_pass, database=cfg.db_name, charset="utf8mb4")
    n_head = n_member = 0
    with conn.cursor() as cur:
        if apply:
            cur.execute("UPDATE english_words SET root_key = NULL, root_affixes = NULL WHERE root_key IS NOT NULL OR root_affixes IS NOT NULL")
        for root, members in fam.items():
            if apply:
                cur.execute("UPDATE english_words SET root_key = %s, root_affixes = NULL WHERE word = %s", (root, root))
            n_head += 1
            for m in members:
                if apply:
                    cur.execute("UPDATE english_words SET root_key = %s, root_affixes = %s WHERE word = %s",
                                (root, json.dumps(m["affixes"], ensure_ascii=False), m["member"]))
                n_member += 1
    if apply:
        conn.commit()
    conn.close()
    print(f"{'已写库' if apply else '（dry-run，未写库）'}：{n_head} 个族中心、{n_member} 个成员")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="生成词根族待审草稿")
    ap.add_argument("--apply", action="store_true", help="写库（默认只出草稿）")
    ap.add_argument("--out", default=str(pathlib.Path(__file__).parent.parent / "output" / "vocabulary_roots_draft.jsonl"),
                    help="草稿输出路径（默认写到 output/，被 .gitignore；不要写进 src/ 当源数据）")
    args = ap.parse_args(argv)

    from config import RefineryConfig
    import pymysql
    cfg = RefineryConfig.from_env()
    conn = pymysql.connect(host=cfg.db_host, port=cfg.db_port, user=cfg.db_user,
                           password=cfg.db_pass, database=cfg.db_name, charset="utf8mb4")
    with conn.cursor() as cur:
        cur.execute("SELECT word FROM english_words WHERE verified = 1 AND is_active = 1")
        words = {w: w for (w,) in cur.fetchall()}
    conn.close()

    draft = candidates(words)
    fam: dict[str, list[dict]] = {}
    for d in draft:
        fam.setdefault(d["root"], []).append(d)  # 上溯后 root 已是真正的族根

    # 单成员族也算族（中心词 + 1 个派生词就是一族，前端树能画）
    pathlib.Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        for d in draft:
            f.write(json.dumps(d, ensure_ascii=False) + "\n")

    sizes = sorted((len(v) for v in fam.values()), reverse=True)
    print(f"词表 {len(words)} 词 → 找到 {len(fam)} 个族、{len(draft)} 条边")
    print(f"族规模分布: " + "  ".join(f"{n}个成员×{sizes.count(n)}" for n in sorted(set(sizes), reverse=True)[:8]))
    print(f"\n成员最多的 12 个族：")
    for root, members in sorted(fam.items(), key=lambda kv: -len(kv[1]))[:12]:
        ms = "、".join(m["member"] for m in members)
        print(f"  {root:<12} ({len(members)}) {ms[:78]}")
    print(f"\n草稿已写 {args.out}（**待人工审**，不是最终数据）")
    load(fam, args.apply)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
