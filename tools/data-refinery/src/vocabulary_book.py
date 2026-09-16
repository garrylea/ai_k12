"""从 MinerU 转出的课本 md 里抽单词表词条。

输入：`output/vocabulary_md/<书>/page_NNN.md`（每页一个 md，由 mineru-open-api --ocr 产出）
输出：JSONL（word / phonetic / pos / gloss + 出处与标记）

**为什么不用坐标分栏**：MinerU 的 md 里栏次与阅读顺序本来就是对的（左栏读完读右栏）、
页码规规矩矩跟在行尾、还自动用 `## Unit 2` 分了小节——所以这里只是一个**行语法**解析器。

一行的形态（实测人教版）：
    mistake /mɪˈsteɪk/ n. 错误；失误 p.21
    first name 名字 p.21
    would /wʊd; wəd/ modal v. 想 （用于礼貌地邀请或向某人提供某物）；将会 p.24
    Beijing roast /rəʊst/ duck 北京烤鸭 p.24
另有**折行**需合并：
    both /bəʊθ/ adj. & pron. 两个；   ← 上一条未完
    两个都 p.23                        ← 续行（直接以中文开头）
    information /ˌɪnfəˈmeɪʃn/          ← 词条头
    n. 信息；消息 p.25                  ← 续行（以词性开头）
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

# 单词表小节的标题。**必须据它限定范围**：书末那几十页除了词表还有语法说明、
# 用法对比表、Conversation 等正文，不加限定会把它们一起当词条吃进来
# （实测吃出过 `'could' 也可表示请求,但比 can 的语气更委婉。例如:` 这种）。
WORDLIST_HEADING_RE = re.compile(
    # ⚠️ 结尾**不能**加 `\b`：人教版的标题是英文中文黏在一起的
    # （`Words and Expressions in Each Unit各单元生词和习惯用语`），
    # 而 Python 里中文也算 \w，`Unit各` 之间没有词边界 → 加 \b 就永远匹配不上（踩过）。
    r"^(?:Vocabulary(?:\s+in\s+Each\s+Unit|\s+A-Z|\s+from\s+Primary\s+School)?"
    r"|Words\s+and\s+Expressions(?:\s+in\s+Each\s+Unit)?"
    r"|Using\s+Words\s+and\s+Expressions)",
    re.IGNORECASE,
)
ANY_HEADING_RE = re.compile(r"^#{1,6}\s")
# **噪声标题**：页眉/水印会出现在每一页开头（实测 `## 人民教育出版社` 出现 116 次）。
# 它们绝不能参与「是否在词表小节内」的状态判断 —— 否则每翻一页都会把状态关掉，
# 结果一个词条都抽不出来（踩过）。
NOISE_HEADING_RE = re.compile(r"出版社|教科书|课程标准|书名|定价")
# **词表内部的分段标题**：单词表自己就带 `## Starter Unit 1` / `## Unit 3`（按单元分组）
# 与 `## A` / `## B`（Vocabulary A-Z 按字母分组）。它们**不表示离开词表**。
# ⚠️ 判断顺序很关键：这些行以 `##` 开头，必须先于「其它标题=离开词表」判断，
# 否则一遇到 `## Unit 1` 就把状态关掉，一个词条都抽不出来（踩过）。
IN_LIST_HEADING_RE = re.compile(r"^(?:Starter\s+|Welcome\s+)?Unit\s*\d*$|^[A-Z]$")

# 行尾页码引用（`p.21` / `P.21`）
PAGE_REF_TAIL_RE = re.compile(r"\s*[pP][.．]?\s*\d{1,3}\s*$")
# 页码引用也会出现在**行首**（实测 `p.42 long-term`），不能只剥行尾
PAGE_REF_HEAD_RE = re.compile(r"^[pP][.．]?\s*\d{1,3}\s+")
# 小节标题：`## Unit 2` / `Starter Unit 1` / `## 人民教育出版社`
MD_HEADING_RE = re.compile(r"^#{1,6}\s")
UNIT_HEADER_RE = re.compile(r"^(?:Starter\s+)?Unit\s*\d+\s*$", re.IGNORECASE)
# 音标：`/.../`（内容允许空）
PHONETIC_RE = re.compile(r"/([^/]{1,60})/")
# 词性
_POS = r"(?:modal\s+v|n|v|vt|vi|adj|adv|prep|conj|pron|num|interj|art|aux|det)"
POS_TOKEN_RE = re.compile(rf"{_POS}\s*\.", re.IGNORECASE)
CJK_RE = re.compile(r"[\u4e00-\u9fff]")
# 释义的起始边界：**中文，或全角左括号 `（`**。
# ⚠️ 半角 `(` **不能**当边界：它既是 IPA 的可选音（`guitar /ɡɪ'tɑː(r)/`），
# 也是词条自带的括号（`would ('d) like to`、`centre /'sentə(r)/ (= center)`）。
# 第一版把半角括号也算边界，结果 guitar 被切成 word=`guitar /ɡɪ'tɑː` + gloss=`(r)/ n. 吉他`。
GLOSS_START_RE = re.compile(r"[\u4e00-\u9fff（]")
# 剥掉词性之后残留在词尾的词性连接符（`both /bəʊθ/ adj. & pron.` → 剥完剩 `both &`）；
# OCR 还会把 & 认成 d/8
POS_CONNECTOR_RE = re.compile(r"(?:\s+[&d8]\s*)+$")
# 词条的合法形态（与后端 english_words 的校验一致）
WORD_RE = re.compile(r"^[A-Za-z][A-Za-z'\- ]*$")
# IPA 字符集（用于形态检查：出现 A/0/ze 这类「像拉丁字母的误识」即可疑）
# IPA 字母（含元音/辅音的扩展字符）
IPA_LETTERS = set("abcdefghijklmnopqrstuvwxyzæɑɒɔəɜɛɪʊʌθðʃʒŋɹɡɐɞɘɵʉɨɾɳʈɖɟɢχʁħʕɦɬɮʔʘǀǁǂǃɓɗʄɠʛʼ")
# IPA 里合法的**非字母**符号：重音（' 和 ˌ）、长短音（ː）、连字符、分号（一音多读）、括号（可选音）、省略点
# IPA 里合法的**非字母**符号：主重音 ˈ、次重音 ˌ、长短音 ː、连字符、分号（一音多读）、
# 括号（可选音）、省略点。⚠️ 主重音 `ˈ`(U+02C8) 与次重音 `ˌ`(U+02CC) 是**两个不同字符**，
# 第一版只写了后一个，导致 mɪˈsteɪk / ˌjuːˈkeɪ 这类全被误判 suspicious_ipa。
IPA_PUNCT = set(" ,;:.'’\"()-ˈˌːˑ̟̩͡")

PAREN_GROUP_RE = re.compile(r"[（(][^）)]*[）)]")
# 未配对的残留括号：MinerU 折行时可能丢掉开括号，只剩 `intelligence )`
STRAY_PAREN_RE = re.compile(r"\s*[（()）]\s*")


@dataclass
class Entry:
    word: str
    phonetic: str
    pos: str
    gloss: str
    source: str          # 书（目录名）
    page: int            # 书内页序（来自文件名）
    raw: str
    flags: list[str] = field(default_factory=list)
    # 词表内部的分段（`Unit 3` / `Welcome Unit` / `A`）。**字母序校验必须按段比**：
    # 每段的词各自从 a 排到 z，跨段比较会误报（下一段又从 a 开始）。
    section: str = ""
    # 顶层词表段落名（`Vocabulary in Each Unit` / `Vocabulary A-Z` / `Words and Expressions…`）。
    # **只有 Vocabulary A-Z 是字母序**；`in Each Unit` 是按课文出现顺序排的，
    # 拿字母序去校验它会产生 100% 的假阳性（实测踩过：5662 条报了 3365 条「违规」）。
    group: str = ""


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s)
    return s.replace("‘", "'").replace("’", "'").strip()


def iter_lines(md_dir: Path):
    """产出 (页序, 行文本)，页序取自 page_NNN.md 的文件名。"""
    for f in sorted(md_dir.glob("page_*.md")):
        m = re.search(r"(\d+)", f.stem)
        page = int(m.group(1)) if m else 0
        for line in f.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                yield page, line


def _split_head_gloss(line: str) -> tuple[str, str] | None:
    """按「第一个中文字符」切成 (词条头, 释义)。没有中文则返回 None（标题/噪声/纯续行）。

    ⚠️ 切点落在**未闭合括号组内**时要往后推：`_norm` 做了 NFKC，会把全角 `（` 变成半角 `(`，
    所以「全角括号当边界」这条路走不通（实测踩过）。改为：若第一个中文前有 `(` 未闭合，
    说明它是**词条自带的括号注释**（`re /riː/ prep.(用于回复电子邮件)关于;事由`、
    `yours (通常写作 Yours,用于书信结尾的签名前)你的;您的`），把切点推到该括号组之后。
    """
    m = CJK_RE.search(line)
    if not m:
        return None
    idx = m.start()
    if line[:idx].count("(") > line[:idx].count(")"):
        close = line.find(")", idx)
        if close != -1:
            later = CJK_RE.search(line, close)
            if later:
                idx = later.start()
    return line[:idx].strip(), line[idx:].strip()


def parse_entries(md_dir: Path, source: str) -> list[Entry]:
    entries: list[Entry] = []
    skipped: list[str] = []
    in_wordlist = False
    saw_wordlist_heading = False
    current_section = ""
    current_group = ""

    for page, raw in iter_lines(md_dir):
        line = PAGE_REF_TAIL_RE.sub("", _norm(raw)).strip()
        line = PAGE_REF_HEAD_RE.sub("", line).strip()
        if not line:
            continue
        # ---- 小节切换：只在单词表小节内解析词条 ----
        if ANY_HEADING_RE.match(line):
            heading = ANY_HEADING_RE.sub("", line).strip()
            if WORDLIST_HEADING_RE.match(heading):
                in_wordlist = True
                saw_wordlist_heading = True
                current_group = heading
                current_section = ""
            elif NOISE_HEADING_RE.search(heading):
                pass                            # 页眉/水印：不改变状态
            elif in_wordlist and IN_LIST_HEADING_RE.match(heading):
                current_section = heading       # 词表内部的 Unit / 字母分段：仍在词表里
            else:
                in_wordlist = False
            continue
        if UNIT_HEADER_RE.match(line):          # 词表内部还要按 Unit 分段，但仍是词表
            if in_wordlist:
                continue
        if not in_wordlist:
            continue
        head_gloss = _split_head_gloss(line)

        # ---- 续行 1：直接以释义开头（中文或左括号；释义折行） ----
        if GLOSS_START_RE.match(line):
            if entries:
                gl = entries[-1].gloss
                entries[-1].gloss = gl + (line if line.startswith(("（", "(")) else (" " if gl else "") + line)
                entries[-1].raw += " ⏎ " + line
            else:
                skipped.append(raw)
            continue

        # ---- 续行 2：以词性开头（词性与释义折到下一行） ----
        pm = POS_TOKEN_RE.match(line)
        if pm and entries and not entries[-1].gloss:
            # 例：`information /ˌɪnfəˈmeɪʃn/` 下一行是 `n. 信息；消息`
            rest = line[pm.end():].strip()
            if not entries[-1].pos:
                entries[-1].pos = line[:pm.end()].strip()
            entries[-1].gloss += rest
            entries[-1].raw += " ⏎ " + line
            continue

        if head_gloss is None:
            skipped.append(raw)
            continue

        head, gloss = head_gloss

        # ---- 新词条 ----
        phonetic_m = PHONETIC_RE.search(head)
        phonetic = phonetic_m.group(1).strip() if phonetic_m else ""
        head_wo_ph = PHONETIC_RE.sub(" ", head).strip()
        # 词性可能在 head 里（`n.` 紧跟在音标后）
        pos_tokens = [m.group(0).strip() for m in POS_TOKEN_RE.finditer(head_wo_ph)]
        word = POS_TOKEN_RE.sub(" ", head_wo_ph).strip()
        # `a lot of / lots of` 这类「两个写法」取第一个；`would ('d) like to` 去掉括号注释
        if " / " in word:
            word = word.split(" / ")[0].strip()
        word = POS_CONNECTOR_RE.sub("", word)
        # 词尾单独一个**大写字母**要并给释义：课本印的是 `T-shirt T恤衫`（字母与中文黏连），
        # 切点落在 `恤` 之前，会把 `T` 留在词里。只处理大写字母，避免误伤 `as a` 这类。
        tm = re.match(r"^(.*\S)\s+([A-Z])$", word)
        if tm:
            word = tm.group(1)
            gloss = tm.group(2) + gloss
        word = PAREN_GROUP_RE.sub(" ", word)   # 成对的括号注释（`would ('d) like to`）
        word = STRAY_PAREN_RE.sub(" ", word)   # 剩下的未配对括号
        word = re.sub(r"\s+", " ", word).strip()

        flags: list[str] = []
        # 剥完音标/词性后词为空 → 这行其实是**上一条的续行**（例：`(外)孙子;(外)孙女`
        # 会被切成 head=`(`，因为半角括号不算边界），并回去而不是产出一条空词条。
        if not word:
            if entries:
                entries[-1].gloss += (" " if entries[-1].gloss else "") + line
                entries[-1].raw += " ⏎ " + line
                continue
            skipped.append(raw)
            continue
        if not WORD_RE.match(word):
            flags.append("bad_word_charset")
        if not CJK_RE.search(gloss):
            flags.append("no_cjk_gloss")
        # 词组（`listen to` / `in the future`）在课本词表里本来就没有音标与词性，
        # 那不是问题；只对**单个词**缺音标且缺词性时报警。
        if " " not in word and not phonetic and not pos_tokens:
            flags.append("no_phonetic_no_pos")
        if phonetic and set(phonetic) - IPA_LETTERS - IPA_PUNCT:
            flags.append("suspicious_ipa")
        entries.append(Entry(word, phonetic, " ".join(pos_tokens), gloss, source, page, raw,
                             flags, current_section, current_group))

    if skipped:
        (md_dir / "_skipped_lines.txt").write_text("\n".join(skipped), encoding="utf-8")
    # 一段词表标题都没找到 → 说明书的分节标题与预期不符，明确报出来（否则会静默返回空）
    if not saw_wordlist_heading:
        raise RuntimeError(
            f"{source}: 没找到单词表小节标题（Vocabulary in Each Unit / A-Z / Using Words and Expressions）"
        )
    return entries


# 排序键：去掉连字符与撇号，**但保留空格**。
# 课本的两条排序规则实测为：
#   · 连字符按「视作不存在」处理 —— `eastern` 排在 `e-book` 之前（e-book 视作 ebook，ea < eb）
#   · **空格按字符参与比较** —— `a lot of` 排在 `ability` 之前（`a␣` < `ab`）、
#     `go to bed` 在 `good at` 之前（`go␣` < `goo`）、`act out` 在 `activity` 之前
# 第一版把空格也去掉了，结果 137 条**全部**是假阳性；保留空格后即归零。
SORT_KEY_RE = re.compile(r"[-'’]")


def is_alphabetical_group(group: str) -> bool:
    """只有 `Vocabulary A-Z` 这类段落是字母序；`in Each Unit` 是按出现顺序排的。"""
    g = group.lower()
    return "a-z" in g or "a—z" in g or "a - z" in g


def check_monotonic(entries: list[Entry]) -> int:
    """字母序单调性检查：词表按字母序排，**乱码词几乎必然破坏单调性**。

    这是本管线最主要的**确定性**校验（MinerU 的 md 不带逐行置信度）。
    必须**按 (书, 分段) 分组**比：每段的词各自从 a 排到 z，跨段比会全是误报。

    返回违规条数；违规项加 `order_violation` 标记（不改变顺序、不丢弃）。
    """
    groups: dict[tuple[str, str, str], list[Entry]] = {}
    for e in entries:
        # ⚠️ **只校验字母序段落**（Vocabulary A-Z）。`in Each Unit` 是按课文出现顺序排的，
        # 拿字母序去比它会产生 100% 假阳性（实测踩过）。
        if not is_alphabetical_group(e.group):
            continue
        groups.setdefault((e.source, e.group, e.section), []).append(e)
    violations = 0
    for group in groups.values():
        prev = ""
        for e in group:
            key = SORT_KEY_RE.sub("", e.word.lower())
            if not key:
                continue
            # ⚠️ `prev` 必须**无条件**更新为当前词。第一版只在「没违规」时才更新，
            # 于是一旦某词违规，`prev` 就卡在旧值，后面所有词都比它小 → **级联误报**
            # （实测把 `alike→almost→alone→along…` 这一串本来就正确的顺序全标成了违规，
            # 83 条里绝大多数是这么来的）。与**紧邻的前一个词**比较才只标出真正的断点。
            if key < prev:
                e.flags.append("order_violation")
                violations += 1
            prev = key
    return violations


def write_jsonl(entries: list[Entry], dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    with open(dest, "w", encoding="utf-8") as f:
        for e in entries:
            f.write(json.dumps({
                "word": e.word, "phonetic": e.phonetic, "pos": e.pos, "gloss": e.gloss,
                "_source": e.source, "_page": e.page, "_raw": e.raw,
                **({"_flags": e.flags} if e.flags else {}),
            }, ensure_ascii=False) + "\n")
