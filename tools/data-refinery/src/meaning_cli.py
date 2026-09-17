"""meaning_cli：语文古诗文「含义」专项内容管线（深层含义 + 作者情感）。

## 内容全部人工手写，本管线不调 LLM

含义与情感是理解层的东西（「这一句到底在说什么、作者借此表达什么情感」），
模型写不出教材口径，**由用户手写**。所以只有两步，没有抽取、没有自检、没有模型：

    # 1) 出带原文的模板（每句原文已预填，人工只填「含义」「情感」两个空）
    python src/meaning_cli.py --export --input inputs/meaning/诗词含义.md

    # 2) 填完回写（幂等）
    python src/meaning_cli.py --apply  --input inputs/meaning/诗词含义.md

## `--input` 认两种格式（`--apply` 自动识别）

1. **上面 `--export` 出的模板**（`# 篇名` / `## 第N句` / `> 原文` / `含义：` / `情感：`）；
2. **用户手写文档**（判据：`### 句子` 且 `#### 深层含义` 同时出现）：

```md
## 水调歌头(明月几时有)（宋·苏轼）

### 明月几时有？
#### 关键字词
几时：什么时候；
#### 深层含义
劈头一问，问的是月，实际问的是时间与存在的本源。
#### 情感
豪放不羁的浪漫情思，带着微醺的迷惘与好奇。
```

- 篇名尾部的 `（唐·刘禹锡）` 只在括号内**含间隔号**时剥掉；`水调歌头(明月几时有)`
  这种没间隔号的括号**原样保留**（剥了就认不出库里的行）。
- 文首 `#` 大标题与文末附录表格不含 `###` 句子，天然不会成为篇目。
- ⚠️ **`#### 关键字词` 整段读入即丢、永不进库**：它是 `key_terms` 列的内容，
  解释专项正在用，导入覆盖会改到线上题面（用户明确要求跳过；`parse_uidoc` 的
  `_UIDOC_FIELD_MAP` 里没有这个名字，该节正文全部忽略）。

## 唯一的硬要求：`sentence_meanings` 与 `sentences` **下标对齐**

`meaning.service.ts` 的 `meaningsOf()` 在两者长度不等时**整篇按无含义处理**；
长度相等而**位置错了**的话，没有异常、没有日志——学生会拿**另一句**的标准含义被判分。

所以定位**只按每句原文**（`_norm` 去空白后全等），**不看行号、不看数组下标、不做长度断言**：
人工删行 / 漏填 / 调序、或者管线把诗重新切过句，都不会串句。
推不出下标的条目（原文在 `sentences` 里找不到）写进 `<stem>-review.md` 并跳过，
**不猜、不静默丢**。

产出数组**与 `sentences` 等长**，没填的位置是 `null`（**不压缩**——压缩会让后面整体错位）。

## `--export` 会把库里已有的含义回填

首次导出时 `sentence_meanings` 全是 `NULL`，出的就是标准的「只有原文、两个空」的模板。
但**库里已填过的句子会连同含义/情感一起回填**——否则「导出→改一句→回写」这条修订路径
会把其余句子的含义一并抹成 `null`（模板里它们是空的）。回填让修订路径无损；
不要的句子把那一行的值清空即可（那是显式表达，照写 `null`）。

## 同篇名多行（九上/九下重复收录）合并出一段

库里同一首诗常有两行（`chinese_passages` 按册收，实测 34 行只对应 25 首）。
导出时按篇名归一**合并成一段**（正文相同的兄弟行不重复列），
合并时**兄弟行已填好的值会补上基准行的空**（两行状态可能不同步，不能丢），
`--apply` 则按 `work_title` 找到**全部**同名行、**逐行都写**——
条目按各行的 `sentences` 原文分配，兄弟行独有的原文（两行切句不同）归它自己。

## 只写一列

    UPDATE chinese_passages SET sentence_meanings = %s WHERE id = %s

`key_terms` / `verified` / `is_active` / `memorize_required` 在语句里**根本不出现**——
后三个是人工标定，`key_terms` 归解释专项，管线重跑绝不能刷掉
（照 `interpretation_loader.py` 的规矩）。用户手写文档里的「关键字词」是**只读输入**：
解析阶段就丢掉，`--apply` 的 SQL 里也没有它的位置。

## 两个不出声的坑，已经堵掉

- **空/半填的格子不写库**：`{"meaning":"","emotion":""}` 这种对象会让该句变成
  「有标准含义但标准答案是空串」，`partOf` 会拿空串去比学生答案；只填一半同理。
  两者都按「没填」处理并记进 review（半填会点名）。
- **整篇一句都没填时不写库**：否则拿一份只剩原文的模板跑一次 `--apply`，
  就会把库里已填的含义整列抹成 `null`。要清空某句，把该句的含义/情感行清空即可
  （那时整篇仍不全空，照写 `null`）。
"""

from __future__ import annotations

import argparse
import json
import re
from collections import deque
from pathlib import Path

import pymysql

from config import RefineryConfig
from interpretation_input import norm_title

SUBJECT_DIR = "语文"

#: 模板里一行一句原文；`#` 分篇、`##` 分句、`>` 是原文、其余两行是人填的答案
_TITLE_RE = re.compile(r"^#\s+(.+?)\s*$")
_SENTENCE_HEAD_RE = re.compile(r"^##\s+")
_QUOTE_RE = re.compile(r"^>\s?(.*)$")
_MEANING_RE = re.compile(r"^含义\s*[:：]\s*(.*)$")
_EMOTION_RE = re.compile(r"^情感\s*[:：]\s*(.*)$")

#: 用户手写文档的层级：`##` 篇名（文首 `#` 是文档标题，不算篇目）/ `###` 原文 / `####` 字段
_UIDOC_POEM_RE = re.compile(r"^##\s+(.+?)\s*$")
_UIDOC_SENT_RE = re.compile(r"^###\s+(.+?)\s*$")
_UIDOC_FIELD_RE = re.compile(r"^####\s+(关键字词|深层含义|情感)\s*$")
#: 用户文档里「含义」叫「深层含义」——映射到内部字段名。
#: `关键字词` **故意不在此表**：`.get()` 返回 None → 该字段正文读入即丢（见 `parse_uidoc`）。
_UIDOC_FIELD_MAP = {"深层含义": "含义", "情感": "情感"}
#: 篇名尾部的（唐·刘禹锡）之类：只在**尾部**且括号内含间隔号时剥掉
_UIDOC_AUTHOR_PAREN_RE = re.compile(r"[（(][^（）()]*[·・][^（）()]*[）)]\s*$")
#: 自动识别用户文档的判据：`### 句子` **且** `#### 深层含义`，缺一不可
_UIDOC_SENT_PROBE_RE = re.compile(r"^###\s", re.MULTILINE)
_UIDOC_FIELD_PROBE_RE = re.compile(r"^####\s+深层含义", re.MULTILINE)
#: Markdown 水平线（`---` / `***` / `___`）：整行跳过。
#: 用户文档用 `---` 分篇，**不跳过就会被当成字段正文的续行**，
#: 粘到上一句「情感」的尾巴上（实测粘出过 `……余韵悠长。---`）。
_HR_RE = re.compile(r"^\s*([-*_])\1{2,}\s*$")


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="语文古诗文含义（深层含义 + 作者情感）内容管线",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python src/meaning_cli.py --export --input inputs/meaning/诗词含义.md
  python src/meaning_cli.py --apply  --input inputs/meaning/诗词含义.md
        """,
    )
    parser.add_argument("--input", required=True,
                        help="模板文件路径（--export 写到它，--apply 读它）")
    parser.add_argument("--output-dir", help="产物根目录（默认 output/meaning）")
    parser.add_argument("--limit", type=int, help="--export 只出前 N 篇（打样用）")
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--export", action="store_true", help="出带原文的模板（不写库）")
    action.add_argument("--apply", action="store_true", help="把填好的模板写库（只写 sentence_meanings 一列）")
    args = parser.parse_args(argv)
    if args.limit is not None and args.limit <= 0:
        parser.error("--limit 必须为正整数")
    return args


# ==================== 产物路径 ====================


def _out_root(args, config) -> Path:
    return Path(args.output_dir) if args.output_dir else config.output_dir / "meaning"


def _stem(args) -> str:
    return Path(args.input).stem


def _review_path(args, config) -> Path:
    return _out_root(args, config) / SUBJECT_DIR / f"{_stem(args)}-review.md"


def _write_review(path: Path, text: str) -> None:
    """写 `<stem>-review.md`（产物目录可能还不存在，先建）。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


# ==================== 数据库 ====================


def _connect(config: RefineryConfig):
    return pymysql.connect(host=config.db_host, port=config.db_port, user=config.db_user,
                           password=config.db_pass, database=config.db_name, charset="utf8mb4")


#: 出模板的范围 = 抽题池（`chinese-passages.repo.ts` 的 MEANING_GATE）**去掉**「已有含义」这一条。
#: 于是模板恰好覆盖「把这些空填完就能进含义专项」的篇目，不埋没任何一篇可填的。
_EXPORT_SQL = (
    "SELECT id, work_title, sentences, sentence_meanings FROM chinese_passages "
    "WHERE verified = 1 AND is_active = 1 AND JSON_LENGTH(sentences) > 0 "
    "ORDER BY semester, sort_order, id"
)

_FETCH_ALL_SQL = (
    "SELECT id, work_title, sentences, sentence_meanings FROM chinese_passages "
    "ORDER BY semester, sort_order, id"
)


def _fetch_passages(conn, *, export_pool: bool = False, limit: int | None = None) -> list[tuple]:
    """→ [(id, work_title, sentences JSON, sentence_meanings JSON)]。

    `--apply` 取**全表**：模板里的篇目可能已被人为停用/去校验，
    但含义是内容，不该因为状态位而写不进去（状态位也不归本管线管）。
    """
    sql = _EXPORT_SQL if export_pool else _FETCH_ALL_SQL
    if limit:
        sql += f" LIMIT {int(limit)}"
    with conn.cursor() as cur:
        cur.execute(sql)
        return list(cur.fetchall())


def _load_json_list(raw) -> list:
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return []
    return value if isinstance(value, list) else []


def _near_titles(rows: list[tuple], target: str, limit: int = 5) -> list[str]:
    """报错时给相近篇名，防错字（照 interpretation_cli._near_titles）。"""
    head = target[:2]
    same = [r[1] for r in rows if norm_title(r[1])[:2] == head]
    other = [r[1] for r in rows if norm_title(r[1])[:2] != head and head[:1] and head[:1] in r[1]]
    return list(dict.fromkeys(same + other))[:limit]


# ==================== 模板解析（纯函数） ====================


def _norm(s: str) -> str:
    """原文归一：去所有空白（全角/半角），用于按原文定位下标。"""
    return "".join((s or "").split())


def parse_template(text: str) -> dict[str, list[tuple[str, str, str]]]:
    """解析人工填写的模板 → {篇名归一: [(原文, 含义, 情感), …]}。

    篇名归一用 `interpretation_input.norm_title`——**与解释管线同一套**
    （库里的篇名写法不统一：半角/全角括号、`·` 两侧空格有无），
    否则用户在模板里写的篇名会认不出库里的行。

    没填的格子是空串（不在这里判「算不算填」，那是 `build_meanings_array` 的事）。
    因此对一份刚 `--export` 出来、还没填的模板，本函数会把每句都解析出来——
    这是对的：**句数的真相在库里**，模板只是人工意见的载体。
    """
    out: dict[str, list[tuple[str, str, str]]] = {}
    title: str | None = None
    src: str | None = None
    meaning = ""
    emotion = ""

    def flush() -> None:
        nonlocal src, meaning, emotion
        if title is not None and src is not None:
            out[title].append((src, meaning, emotion))
        src, meaning, emotion = None, "", ""

    for line in text.splitlines():
        line = line.rstrip()
        m_title = _TITLE_RE.match(line)
        if m_title:
            flush()
            key = norm_title(m_title.group(1))
            title = key or None
            if title is not None:
                out.setdefault(title, [])
            continue

        if _SENTENCE_HEAD_RE.match(line):
            flush()          # `## 第N句` 只是给人看的编号，定位不靠它
            continue

        m_quote = _QUOTE_RE.match(line)
        if m_quote:
            flush()          # 上一句的答案到此为止，新的一句开始
            src = m_quote.group(1).strip()
            continue

        m_meaning = _MEANING_RE.match(line)
        if m_meaning:
            meaning = m_meaning.group(1).strip()
            continue

        m_emotion = _EMOTION_RE.match(line)
        if m_emotion:
            emotion = m_emotion.group(1).strip()
            continue

    flush()
    return {k: v for k, v in out.items() if v}


# ==================== 用户手写文档解析（纯函数） ====================


def _uidoc_strip_author(title: str) -> str:
    """『酬乐天扬州初逢席上见赠（唐·刘禹锡）』→『酬乐天扬州初逢席上见赠』。

    只剥**尾部**且括号内含间隔号（作者·朝代）的；『水调歌头(明月几时有)』这种
    括号里没有间隔号，必须原样保留，否则对不上库里的篇名。
    整条标题就是那个括号（剥完为空）时也原样保留，不返回空篇名。
    """
    stripped = _UIDOC_AUTHOR_PAREN_RE.sub("", title).strip()
    return stripped or title


def parse_uidoc(text: str) -> dict[str, list[tuple[str, str, str]]]:
    """解析**用户手写文档** → {篇名归一: [(原文, 含义, 情感), …]}。

    层级：`##` 起篇、`###` 起句、`####` 起字段（`深层含义` 映射到内部的「含义」），
    字段正文按行累加到下一个 `####`/`###`/`##` 为止。

    **「关键字词」整段跳过、永不进库**：它是 `key_terms` 列的内容，解释专项正在用，
    导入覆盖会改到线上题面。用户文档里有这一节，所以这里**读入即丢**
    （`_UIDOC_FIELD_MAP` 里没有它 → `field=None` → 正文全部忽略）。

    文首用 `#` 的说明段（大标题 / 引用行）与文末附录表格都不含 `###` 句子，
    天然不会成为篇目（篇目只在拿到 `###` 句子后才留下）。
    """
    out: dict[str, list[tuple[str, str, str]]] = {}
    title: str | None = None
    src: str | None = None
    field: str | None = None          # 当前字段；None = 不在字段正文里（含「关键字词」）
    meaning = ""
    emotion = ""

    def flush() -> None:
        nonlocal src, field, meaning, emotion
        if title is not None and src is not None:
            out[title].append((src, meaning, emotion))
        src, field, meaning, emotion = None, None, "", ""

    for line in text.splitlines():
        line = line.rstrip()

        m_poem = _UIDOC_POEM_RE.match(line)
        if m_poem:
            flush()
            key = norm_title(_uidoc_strip_author(m_poem.group(1)))
            title = key or None
            if title is not None:
                out.setdefault(title, [])
            continue

        m_sent = _UIDOC_SENT_RE.match(line)
        if m_sent:
            flush()
            src = m_sent.group(1).strip()
            continue

        m_field = _UIDOC_FIELD_RE.match(line)
        if m_field:
            field = _UIDOC_FIELD_MAP.get(m_field.group(1))   # 关键字词 → None → 丢
            continue

        if _HR_RE.match(line):
            continue                      # `---` 是分篇线，不是字段正文

        if field is None or title is None or src is None or not line.strip():
            continue

        if field == "含义":
            meaning += line.strip()
        else:
            emotion += line.strip()

    flush()
    return {k: v for k, v in out.items() if v}


def looks_like_uidoc(text: str) -> bool:
    """→ 这份文本是不是**用户手写文档**（判据：`### 句子` 且 `#### 深层含义`，缺一不可）。

    两条都要：`###` 单独出现可能是有人在模板里手写了小标题，
    `#### 深层含义` 单独出现可能只是正文里引用了格式说明。
    """
    return bool(_UIDOC_SENT_PROBE_RE.search(text) and _UIDOC_FIELD_PROBE_RE.search(text))


def parse_input(text: str) -> dict[str, list[tuple[str, str, str]]]:
    """`--input` 两种格式的统一入口：用户手写文档 / `--export` 出的模板。

    识别不出是手写文档就回退模板解析（而不是静默返回空）——`run_apply`
    拿不到篇目时会报「没解析出任何篇目」，比猜错格式好定位。
    """
    return parse_uidoc(text) if looks_like_uidoc(text) else parse_template(text)


# ==================== 按原文定位（纯函数） ====================


def build_meanings_array(
    sentences: list[dict], entries: list[tuple[str, str, str]]
) -> tuple[list[dict | None], list[str]]:
    """按**原文**定位下标，产出与 `sentences` 等长的数组；对不上的原文进 `skipped`。

    规则：
    - 只用「归一后的原文全等」定位，**不看行号、不看数组下标**；
    - 一段原文在 `sentences` 里出现多次（诗经那种重章叠句）时，按**出现次序**一一对应，
      不把后一个覆盖到第一个上；
    - **没填的条目不占出现次序**：否则同一段原文里的空条目会把后面填好的那条挤成
      「定位不到」，白丢数据；
    - 含义与情感**都非空**才写；只填一半或无填 → 该位置留 `None`（半填会进 `skipped` 点名）；
    - `sentences` 里定位不到的条目**一个都不丢**，原文原样进 `skipped`。
    """
    slots: dict[str, deque[int]] = {}
    for i, s in enumerate(sentences):
        if not isinstance(s, dict):
            continue
        key = _norm(str(s.get("text") or ""))
        if key:
            slots.setdefault(key, deque()).append(i)

    arr: list[dict | None] = [None] * len(sentences)
    skipped: list[str] = []

    for src, meaning, emotion in entries:
        m = (meaning or "").strip()
        e = (emotion or "").strip()
        key = _norm(src)
        idx = slots[key][0] if key in slots and slots[key] else None   # 只探不取：认下才占位

        if not m and not e:
            continue                                  # 人工没填 → 留 null
        if idx is None:
            skipped.append(f"原文在 sentences 里定位不到，跳过：{src}")
            continue
        if not m or not e:
            missing = "情感" if m else "含义"
            skipped.append(
                f"第{idx + 1}句「{src}」只填了含义/情感之一（缺{missing}），整句不写"
                "——半填会让另一项拿空串当标准答案"
            )
            continue

        slots[key].popleft()
        arr[idx] = {"meaning": m, "emotion": e}

    return arr, skipped


# ==================== 出模板 ====================


def _sentence_pairs(row: tuple) -> list[tuple[str, str, str]]:
    """一行 → [(原文, 已填含义, 已填情感)]。库里没有含义的句子后两项是空串。"""
    sentences = _load_json_list(row[2])
    meanings = _load_json_list(row[3])
    if len(meanings) != len(sentences):
        meanings = []          # 长度不等 → 按无含义处理（与 meaning.service 的口径一致）

    pairs: list[tuple[str, str, str]] = []
    for i, s in enumerate(sentences):
        text = s.get("text", "") if isinstance(s, dict) else ""
        cur = meanings[i] if i < len(meanings) else None
        cur = cur if isinstance(cur, dict) else {}
        pairs.append((text, cur.get("meaning") or "", cur.get("emotion") or ""))
    return pairs


def _merge_group(rows: list[tuple]) -> list[tuple[str, str, str]]:
    """同篇名的多行（九上/九下重复收录）合并成**一份**句子清单，不重复出模板。

    以第一行为基准（**保留篇内重复原文**——诗经那种重章叠句不能被合并掉），
    再按「多重集差」补上兄弟行独有的原文：两行切句方式不同时（《出师表》一类的文言文，
    一行把「臣不胜受恩感激，今当远离……」切成两句、另一行切成一句），
    两边原文都要在模板里出现，人工各填一次，`--apply` 再按原文各回各行。
    """
    base = _sentence_pairs(rows[0])
    remaining: dict[str, int] = {}
    slots: dict[str, deque[int]] = {}
    for i, (text, _m, _e) in enumerate(base):
        key = _norm(text)
        remaining[key] = remaining.get(key, 0) + 1
        slots.setdefault(key, deque()).append(i)

    merged = list(base)
    for row in rows[1:]:
        for text, meaning, emotion in _sentence_pairs(row):
            key = _norm(text)
            if remaining.get(key, 0) > 0:
                remaining[key] -= 1        # 基准行里已有这一处，不重复列
                # 但值要**按字段补齐**：两行状态可能不同步（上一次 `--apply` 只写成了
                # 一行、或长度不等把基准行整行降级成空），基准行这句是空而兄弟行有值时，
                # 丢掉兄弟行的值会出「模板显示空 → --apply 把两行一起写成 null」的静默毁数据。
                # 基准行已有的值**不覆盖**（它才是上次人工确认过的版本）。
                idx = slots[key].popleft()
                t, m, e = merged[idx]
                merged[idx] = (t, m or meaning, e or emotion)
            else:
                merged.append((text, meaning, emotion))
    return merged


def _group_by_title(rows: list[tuple]) -> list[list[tuple]]:
    """按篇名归一聚类，保持库里的顺序（`sort_order`），同篇的挨在一起。"""
    groups: dict[str, list[tuple]] = {}
    for row in rows:
        groups.setdefault(norm_title(row[1]), []).append(row)
    return list(groups.values())


def render_template(rows: list[tuple]) -> str:
    """→ 模板 Markdown。原文预填；库里已有含义的句子**回填**，便于二次修订不丢数据。"""
    lines: list[str] = []
    for group in _group_by_title(rows):
        merged = _merge_group(group)
        if not merged:
            continue
        lines.append(f"# {group[0][1]}")
        lines.append("")
        for i, (text, meaning, emotion) in enumerate(merged):
            lines.append(f"## 第{i + 1}句")
            lines.append(f"> {text}")
            lines.append(f"含义：{meaning}")
            lines.append(f"情感：{emotion}")
            lines.append("")
    return "\n".join(lines)


def run_export(args, config) -> int:
    conn = _connect(config)
    try:
        rows = _fetch_passages(conn, export_pool=True, limit=args.limit)
    finally:
        conn.close()

    if not rows:
        print("[WARN] 库里没有可出模板的篇目（抽题池为空：verified/is_active/sentences 三条件）", flush=True)
        return 1

    path = Path(args.input)
    if path.exists():
        existing = path.read_text(encoding="utf-8")
        if existing.strip():
            if looks_like_uidoc(existing):
                print(f"[ERROR] --input 指的是一份**手写文档**（含 `### 句子` / `#### 深层含义`）：{path}"
                      f"——那种格式是喂给 --apply 的；--export 只写「只有原文、两个空」的空白模板，"
                      f"且**不会覆盖已有文件**。请换一个路径。", flush=True)
            else:
                print(f"[ERROR] 模板已存在且非空：{path}"
                      f"——里面可能有你填过的内容。先把它移走（或改名），再重新导出。", flush=True)
            return 1

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render_template(rows), encoding="utf-8")
    n_titles = len(_group_by_title(rows))
    n_sentences = sum(len(_load_json_list(r[2])) for r in rows)
    print(f"[ok] 模板已写出：{path}（库中 {len(rows)} 行 → 合并为 {n_titles} 篇 / {n_sentences} 句）",
          flush=True)
    print("[..] 填好每句的「含义」「情感」后跑 --apply（没填的句子留空，会自动留 null）", flush=True)
    return 0


# ==================== 入库 ====================

_UPDATE_SQL = "UPDATE chinese_passages SET sentence_meanings = %s WHERE id = %s"


def run_apply(args, config) -> int:
    path = Path(args.input)
    if not path.exists():
        print(f"[ERROR] 模板不存在：{path}（先跑 --export）", flush=True)
        return 1

    by_title = parse_input(path.read_text(encoding="utf-8"))
    if not by_title:
        print(f"[ERROR] 没解析出任何篇目：{path}"
              f"（认两种格式：--export 出的模板，或含 `### 句子` + `#### 深层含义` 的手写文档）", flush=True)
        return 1

    conn = _connect(config)
    written: list[dict] = []
    skipped: list[str] = []
    untouched: list[str] = []
    missing: list[str] = []
    try:
        rows = _fetch_passages(conn)
        groups: dict[str, list[tuple]] = {}
        for row in rows:
            groups.setdefault(norm_title(row[1]), []).append(row)

        for title, entries in by_title.items():
            hits = groups.get(title) or []
            if not hits:
                near = "、".join(_near_titles(rows, title)) or "（无相近篇名）"
                missing.append(f"《{title}》在库里找不到；相近篇名：{near}")
                continue

            # 整篇留空 = 这次不填它（只做诗词，文言文那一堆本来就该留空），不是异常
            filled_entries = [e for e in entries
                              if (e[1] or "").strip() or (e[2] or "").strip()]
            if not filled_entries:
                untouched.append(f"《{title}》")
                continue

            # 同篇名可能有多行（九上/九下重复收录）：一批条目对所有行都试。
            # 「对不上」要**按整组判一次**——按行判的话，兄弟行会把对方能对上的原文
            # 全部报成「定位不到」，过目清单就被假警报淹了。
            keys_per_row = [{_norm(str(s.get("text") or ""))
                             for s in _load_json_list(row[2]) if isinstance(s, dict)}
                            for row in hits]
            for src, _m, _e in filled_entries:
                if not any(_norm(src) in keys for keys in keys_per_row):
                    skipped.append(f"《{title}》模板里的原文在库里哪一行都定位不到：{src}")

            for row, keys in zip(hits, keys_per_row):
                row_id, work_title = row[0], row[1]
                prefix = f"《{work_title}》(id={row_id})"
                sentences = _load_json_list(row[2])
                if not sentences:
                    skipped.append(f"{prefix} 库里这行 sentences 为空，无从对齐，跳过")
                    continue

                # 只把它自己 sentences 里有的原文交给定位函数（兄弟行独有的原文归兄弟行）
                arr, sk = build_meanings_array(
                    sentences, [e for e in filled_entries if _norm(e[0]) in keys]
                )
                skipped.extend(f"{prefix} {s}" for s in sk)

                filled = [i for i, v in enumerate(arr) if v]
                if not filled:
                    skipped.append(
                        f"{prefix} 一行都没写成（模板里没有它能对上的原文），不写库"
                        "——避免把库里已填的含义抹成 null"
                    )
                    continue

                with conn.cursor() as cur:
                    cur.execute(_UPDATE_SQL, (json.dumps(arr, ensure_ascii=False), row_id))
                written.append({
                    "row_id": row_id,
                    "work_title": work_title,
                    "total": len(arr),
                    "filled": len(filled),
                    "unfilled": [i for i, v in enumerate(arr) if not v],
                })
        conn.commit()
    finally:
        conn.close()

    review_path = _review_path(args, config)
    _write_review(review_path, render_review(path, written, skipped, missing, untouched))

    for s in skipped:
        print(f"[SKIP] {s}", flush=True)
    for m in missing:
        print(f"[ERROR] {m}", flush=True)
    print(f"[ok] 入库完成：写 {len(written)} 行（只 UPDATE sentence_meanings）", flush=True)
    if untouched:
        print(f"[..] 没填、不入库：{len(untouched)} 篇（{', '.join(untouched[:5])}"
              f"{' 等' if len(untouched) > 5 else ''}）", flush=True)
    print(f"[ok] 过目清单：{review_path}", flush=True)
    return 0 if written else 1


def render_review(input_path: Path, written: list[dict], skipped: list[str],
                  missing: list[str], untouched: list[str]) -> str:
    """过目清单：每篇句数、填了几句、跳过了哪几句（第 7 步）。"""
    lines = ["# 古诗含义专项 · 过目清单", ""]
    lines.append(f"- 模板：`{input_path}`")
    lines.append(f"- 写入：**{len(written)}** 行")
    lines.append(f"- 跳过：**{len(skipped)}** 条")
    lines.append(f"- 没填、不入库：**{len(untouched)}** 篇")
    lines.append("")

    lines.append("## 写入（只更新 sentence_meanings）")
    lines.append("")
    for w in written:
        lines.append(f"### 《{w['work_title']}》（id={w['row_id']}）")
        lines.append("")
        lines.append(f"- 句数：{w['total']}｜已填：{w['filled']}｜留空（null）：{w['total'] - w['filled']}")
        if w["unfilled"]:
            idx = "、".join(f"第{i + 1}句" for i in w["unfilled"])
            lines.append(f"- 留空的句子：{idx}（学生答到这些句会被拒：「该句无标准含义」）")
        lines.append("")

    if skipped:
        lines.append("## 跳过（未写入，请人工看一眼）")
        lines.append("")
        for s in skipped:
            lines.append(f"- {s}")
        lines.append("")

    if missing:
        lines.append("## 模板里有、库里找不到的篇目")
        lines.append("")
        for m in missing:
            lines.append(f"- {m}")
        lines.append("")

    if untouched:
        lines.append("## 没填、不入库（只做诗词，文言文留空即属于此类）")
        lines.append("")
        lines.append("- " + "、".join(untouched))
        lines.append("")

    return "\n".join(lines)


def main(argv=None) -> int:
    args = parse_args(argv)
    config = RefineryConfig.from_env()
    return run_export(args, config) if args.export else run_apply(args, config)


if __name__ == "__main__":
    raise SystemExit(main())
