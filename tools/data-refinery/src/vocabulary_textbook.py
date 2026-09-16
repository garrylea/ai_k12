"""从 smartedu 课本里抽单词表（OCR + 分栏还原 + 解析）。

为什么不用 pdftotext：smartedu 教材是**逐页 JPG**，没有文字层。
为什么不用 MinerU：Mac 自带的 Vision 本地可跑、不占额度，实测中文释义识别可靠。
为什么必须自己还原分栏：单词表是「左词条 + 页码 | 右词条 + 页码」四列并排，
普通 OCR 会把左右两栏按行串起来。见 mac_ocr.swift 输出的归一化坐标。

⚠️ **音标不采信**。实测 Vision 把每个 IPA 符号都替换成最像的拉丁字母
（ɪ→i、ʌ→A、ɒ→o、ə→a、ʊ→c、æ→ze、θ→0），且不稳定；关掉 usesLanguageCorrection
后结果一字不差，说明是模型不认识 IPA 字符。所以这里**只解析出 word/词性/释义**，
音标（课本上有，格式是 `word /音标/ 词性. 释义`）解析出来只用于**切分定位**，不入库。
"""

from __future__ import annotations

import json
import re
import subprocess
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

# 单词表三段的标题特征（人教版初中/高中都这几段；高中是 Vocabulary / Words and Expressions）
SECTION_MARKERS = [
    ("in_each_unit", ("vocabulary in each unit", "words and expressions in each unit")),
    ("a_z", ("vocabulary a-z", "vocabulary a—z", "vocabulary a - z")),
    ("from_primary", ("vocabulary from primary school",)),
]

# 单词表里的小节标题（`Starter Unit 1` / `Unit 3`），不是词条
UNIT_HEADER_RE = re.compile(r"^(?:Starter\s+)?Unit\s*\d+\b", re.IGNORECASE)

# 页码引用：`p.21` / `P.21`（OCR 常把 p 认成 P，把数字 1 认成 I/l）
PAGE_REF_RE = re.compile(r"^[pP][.．,·]?\s*[\dIl]{1,3}$")
# 粘在词条尾部的情形（Vision 常把词条与页码识别成**同一条**观测，故不能只丢独立的页码行）
PAGE_REF_TAIL_RE = re.compile(r"\s*[pP][.．,·]?\s*-?[\dIl]{1,3}\s*$")
# 释义开头的义项序号（`1. 开始;着手`）
SENSE_NUM_RE = re.compile(r"^\s*\d{1,2}\s*[.、．]\s*")

# 词性（含 modal v. / 多个词性用 & 连）
_POS = r"(?:modal\s+v|n|v|vt|vi|adj|adv|prep|conj|pron|num|interj|art|aux|det)"
POS_RE = re.compile(rf"\s*{_POS}\s*\.", re.IGNORECASE)
# 词条的「词 + 可选音标 + 余下部分」骨架；词性与释义从余下部分里再拆。
# ⚠️ 词用**贪心**匹配，别改回惰性 `*?`：惰性只吃一个字母，会把 `full` 解析成 word=`f`+rest=`ull ...`，
# 且 `first name` 这类多词词条永远解析不出来（实测踩过）。
ENTRY_HEAD_RE = re.compile(
    r"^(?P<word>[A-Za-z][A-Za-z'’\- ]*)"
    r"\s*(?:/(?P<phonetic>[^/]*)/)?"
    r"\s*(?P<rest>.*)$"
)

# 粗体首字母被 Vision 单独切成一条观测时拼回来是 `f ull`。**排除 a/A/I/i**：
# `a lot` 是真词条，无条件合并会毁成 `alot`（这俩正是仅有的单字母真词）。
SPLIT_INITIAL_RE = re.compile(r"^([b-hj-zA-HJ-Z]) (?=[a-z])")

CJK_RE = re.compile(r"[\u4e00-\u9fff]")
# 单词/词组的合法形态（与后端 english_words.word 校验一致）
WORD_RE = re.compile(r"^[A-Za-z][A-Za-z'’\- ]*$")


@dataclass
class Obs:
    """一条 OCR 观测（归一化坐标，原点左下）。"""
    page: int
    x: float
    y: float
    w: float
    conf: float
    text: str


def _join_row(row: list[Obs], gap_tol: float = 0.010) -> str:
    """把同一行（已按 x 排序）的若干观测拼成文本。

    **必须按坐标判断相邻性**，不能一律加空格：人教版单词表把词头做成**粗体**，
    Vision 常因此把**首字母单独切出来**（`f` 与 `un /fʌn/ n. 乐趣` 是两条观测）。
    一律加空格会拼成 `f un /fʌn/ ...`，解析出来词就是 `f`——实测踩过，比例不小。
    贴紧（间隙 < gap_tol）就连，有间隔才插空格。
    """
    out = ""
    prev_end: float | None = None
    for o in sorted(row, key=lambda o: o.x):
        if prev_end is not None and o.x - prev_end > gap_tol:
            out += " "
        out += _normalize(o.text)
        prev_end = o.x + o.w
    return out.strip()


@dataclass
class Entry:
    word: str
    pos: str
    gloss: str
    page: int
    section: str
    conf: float
    raw: str
    flags: list[str] = field(default_factory=list)


def ocr_pdf(pdf: Path, first: int, last: int, scale: float = 3.0,
            langs: str = "zh-Hans,en-US", mac_ocr: str = "/tmp/mac_ocr") -> list[Obs]:
    """调用 Swift 版 Vision OCR（见 mac_ocr.swift），返回带坐标的观测列表。"""
    out = subprocess.run(
        [mac_ocr, str(pdf), str(first), str(last), str(scale), langs],
        capture_output=True, text=True, check=True,
    ).stdout
    obs: list[Obs] = []
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) != 7:
            continue
        try:
            obs.append(Obs(int(parts[0]), float(parts[1]), float(parts[2]),
                           float(parts[3]), float(parts[4]), parts[6]))
        except ValueError:
            continue
    return obs


def images_to_pdf(book_dir: Path, dest: Path, page_w: int = 1000, page_h: int = 1400) -> int:
    """把课本的逐页 JPG 合成一个 PDF（Vision 走 PDF 渲染路径，省得再写图像分支）。"""
    import fitz
    imgs = sorted(book_dir.glob("page_*.jpg"))
    doc = fitz.open()
    for p in imgs:
        page = doc.new_page(width=page_w, height=page_h)
        page.insert_image(fitz.Rect(0, 0, page_w, page_h), filename=str(p))
    doc.save(str(dest))
    doc.close()
    return len(imgs)


def _normalize(s: str) -> str:
    """NFKC 归一，并把 OCR 常见的全角/异体字符拉回半角（IPA 除外，音标不采信）。"""
    s = unicodedata.normalize("NFKC", s)
    s = s.replace("’", "'").replace("‘", "'")
    return s.strip()


def split_columns(obs: list[Obs], page: int) -> tuple[list[Obs], list[Obs]]:
    """按 x 把一页切成左右两栏。

    实测人教版的横向布局是「左词条 | 左页码 | 右词条 | 右页码」，
    分界取 0.45（左栏词条 x≈0.14、左页码 x≈0.47，右栏词条 x≈0.52、右页码 x≈0.87）。
    用固定阈值而不是自动找间隙：单词表页的版式极稳定，自动检测反而会在
    「某行没有页码」时把间隙找错。
    """
    page_obs = [o for o in obs if o.page == page]
    left = [o for o in page_obs if o.x < 0.45]
    right = [o for o in page_obs if o.x >= 0.45]
    return left, right


def _group_lines(col: list[Obs], tol: float = 0.012) -> list[list[Obs]]:
    """把同一栏里的观测按 y 归成行（Vision 原点在左下，y 大者在上）。"""
    rows: list[list[Obs]] = []
    for o in sorted(col, key=lambda o: -o.y):
        for row in rows:
            if abs(row[0].y - o.y) <= tol:
                row.append(o)
                break
        else:
            rows.append([o])
    for row in rows:
        row.sort(key=lambda o: o.x)
    return rows


def parse_column(col: list[Obs], page: int, section: str) -> list[Entry]:
    """一栏 → 若干词条。

    词条会被 OCR 拆成多行（释义太长换行、或词性另起一行），所以先做**行合并**：
      - 页码行（`p.21`）丢掉
      - 以英文单词开头且**与栏左边界齐平**的行 = 新词条起点
      - 其余都是上一条的续行（缩进更深的续行、或 `adj. ...` 这类续行）
    """
    entries: list[Entry] = []
    cur: list[Obs] | None = None

    def flush():
        nonlocal cur
        if not cur:
            return
        text = _join_row(cur)
        # 置信度取整行的**最大值**：一行的观测里可能混着被切出来的粗体首字母碎片
        # （conf 低到 0.02），取 min 或取最左边那条都会把好词条压成低置信。
        conf = max(o.conf for o in cur)
        text = PAGE_REF_TAIL_RE.sub("", text).strip()      # 页码常被并进词条尾部
        text = SPLIT_INITIAL_RE.sub(r"\1", text)           # 粗体首字母被切开：`f ull` → `full`
        m = ENTRY_HEAD_RE.match(text)
        if not m:
            entries.append(Entry("", "", "", page, section, conf, text, ["unparsed"]))
        else:
            word = m.group("word").strip()
            rest = m.group("rest").strip()
            # 粗体首字母常被单独切成一条观测，拼回来是 `k ey /ki:/...`。
            # 真正的单字母词（a / I）后面跟的是中文或音标斜杠，不会被这条规则误并。
            if len(word) == 1 and rest[:1].islower():
                m2 = ENTRY_HEAD_RE.match(word + rest)
                if m2:
                    word = m2.group("word").strip()
                    rest = m2.group("rest").strip()
            # 从余下部分里剥掉开头的词性标记（可能有多个，如 `adj. & pron.`）；
            # OCR 会把 `&` 认成 `d`/`8`，所以这里按「词性紧邻出现」逐个剥，不做严格分割。
            pos_tokens: list[str] = []
            while True:
                pm = POS_RE.match(rest)
                if not pm:
                    break
                pos_tokens.append(rest[:pm.end()].strip())
                rest = rest[pm.end():]
                rest = re.sub(r"^\s*[&d8]\s*", "", rest)    # 连接词（OCR 噪声容忍）
            pos = " ".join(pos_tokens)
            gloss = SENSE_NUM_RE.sub("", rest).strip()
            flags: list[str] = []
            if not WORD_RE.match(word):
                flags.append("bad_word_charset")
            if not CJK_RE.search(gloss):
                flags.append("no_cjk_gloss")
            # 阈值刻意压到 0.15：实测这种中英混排的单词表行**普遍**只有 0.3–0.5
            # （Vision 对中英混排 + 斜体/粗体的置信度本来就低），
            # 用 0.6 会把 97% 的条目全标成 low_conf，反而失去筛选意义。
            # 真正有效的判别是**课标白名单 + 字母序单调性**，conf 只用来捞出明显崩掉的行。
            if conf < 0.15:
                flags.append("very_low_conf")
            entries.append(Entry(word, pos, gloss, page, section, conf, text, flags))
        cur = None

    for row in _group_lines(col):
        text = _join_row(row)
        if not text:
            continue
        if PAGE_REF_RE.match(text.replace(" ", "")):
            continue                                  # 页码引用，丢弃
        if UNIT_HEADER_RE.match(text):
            continue                                  # 小节标题（Starter Unit 1 / Unit 3）
        x0 = min(o.x for o in row)
        starts_word = bool(re.match(r"^[A-Za-z]", text))
        is_new = starts_word and (cur is None or x0 <= min(o.x for o in cur) + 0.02)
        if is_new:
            flush()
            cur = list(row)
        elif cur is not None:
            cur.extend(row)
        else:
            cur = list(row)
    flush()
    return entries


def find_sections(obs: list[Obs]) -> dict[str, int]:
    """在整本书的 OCR 结果里定位单词表三段的起始页（返回段名 → 页号）。"""
    found: dict[str, int] = {}
    for o in sorted(obs, key=lambda o: o.page):
        low = o.text.lower()
        for name, markers in SECTION_MARKERS:
            if name in found:
                continue
            if any(m in low for m in markers):
                found[name] = o.page
    return found


def extract_book(book_dir: Path, work_dir: Path, scale: float = 3.0,
                 mac_ocr: str = "/tmp/mac_ocr", tail_pages: int = 60) -> list[Entry]:
    """抽一本书的全部词条。

    只在书末 `tail_pages` 页里找单词表（人教版初中/高中都把单词表放在书末附录），
    找到就只 OCR 那几页（精度优先），找不到再退化到整本扫一遍定位。
    """
    work_dir.mkdir(parents=True, exist_ok=True)
    slug = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]+", "_", book_dir.name)[:60]
    pdf = work_dir / f"{slug}.pdf"
    if not pdf.exists():
        n = images_to_pdf(book_dir, pdf)
        pdf.with_suffix(".pages").write_text(str(n), encoding="utf-8")
    total = int(pdf.with_suffix(".pages").read_text(encoding="utf-8"))

    first = max(1, total - tail_pages + 1)
    head = ocr_pdf(pdf, first, total, scale=2.0, mac_ocr=mac_ocr)
    sections = find_sections(head)
    if not sections:
        head = ocr_pdf(pdf, 1, total, scale=2.0, mac_ocr=mac_ocr)
        sections = find_sections(head)
    if not sections:
        raise RuntimeError(f"{book_dir.name}: 没找到单词表段落标题（Vocabulary in Each Unit 等）")

    lo = min(sections.values())
    entries: list[Entry] = []
    # 从最早那段开始到书末（用高倍率重扫，单词表页只占十几页，成本可控）
    fine = ocr_pdf(pdf, lo, total, scale=scale, mac_ocr=mac_ocr)
    ordered = sorted(sections.items(), key=lambda kv: kv[1])
    for i, (name, start) in enumerate(ordered):
        end = ordered[i + 1][1] - 1 if i + 1 < len(ordered) else total
        for page in range(start, end + 1):
            left, right = split_columns(fine, page)
            entries.extend(parse_column(left, page, name))
            entries.extend(parse_column(right, page, name))
    return entries


def write_jsonl(entries: list[Entry], dest: Path) -> None:
    with open(dest, "w", encoding="utf-8") as f:
        for e in entries:
            f.write(json.dumps({
                "word": e.word, "pos": e.pos, "gloss": e.gloss,
                "_page": e.page, "_section": e.section,
                "_conf": round(e.conf, 2), "_raw": e.raw,
                **({"_flags": e.flags} if e.flags else {}),
            }, ensure_ascii=False) + "\n")
