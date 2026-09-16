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

# **正文说明行**（不是词条、也不是释义）。课本词表里有一条编辑说明反复出现：
#   `注：依据《义务教育英语课程标准（2022年版）》，本词表中的重点词汇用粗体显示。`
# 它以中文开头，会被「以中文开头 = 上一条的释义折行」这条规则吃进去，挂到**上一行的词**上
# （实测 Clark / Jones / Philippines 的释义尾部都拖着这条说明）。
NOTE_LINE_RE = re.compile(r"^[（(]?\s*注\s*[:：]")
# 行尾页码引用（`p.21` / `P.21`）
PAGE_REF_TAIL_RE = re.compile(r"\s*[pP][.．]?\s*\d{1,3}\s*$")
# **行内**页码引用（`… 帽子 p.32have fun 玩得高兴`），见 split_glued
PAGE_REF_MID_RE = re.compile(r"[pP][.．]?\s?\d{1,3}")
# 页码引用也会出现在**行首**（实测 `p.42 long-term`），不能只剥行尾
PAGE_REF_HEAD_RE = re.compile(r"^[pP][.．]?\s*\d{1,3}\s+")
# 小节标题：`## Unit 2` / `Starter Unit 1` / `## 人民教育出版社`
MD_HEADING_RE = re.compile(r"^#{1,6}\s")
UNIT_HEADER_RE = re.compile(r"^(?:Starter\s+)?Unit\s*\d+\s*$", re.IGNORECASE)
# 音标：`/.../`（内容允许空）
PHONETIC_RE = re.compile(r"/([^/]{1,60})/")
# 出现在**行首**的音标。续行常以另一个读音的音标开头
# （`use /juːz/ v. 使用；利用` ⏎ `/juːs/ n. 使用;用途`），音标属于词条头不属于释义。
PHONETIC_HEAD_RE = re.compile(r"^\s*/[^/]{1,60}/\s*")
# 续行开头的孤立右括号（`many … 许多` ⏎ `/'grænfɑːðə(r)/ ) n. 爷爷;外公`，
# 前一条的词形被 OCR 吃掉后只剩一个 `)`）
LEADING_STRAY_PAREN_RE = re.compile(r"^\s*[)）]\s*")
# 词性。**必须覆盖课标词表实际出现的全部写法**，漏一个的后果不是「少标一个词性」，
# 而是那个词性**残留在词形里**，整条被 WORD_RE 判非法丢掉，或者变成 `do aux` 这种垃圾词条：
#   · `aux v.`（实测 2 处：`do /duː; də/ aux v. & v.…` —— 少了它 `do` 直接变成 `do aux`）
#   · `pl.`（156 处，`grandchild … n. (pl. grandchildren /…/)`）
#   · `abbr.`（26 处）· `sing.`（3 处）
# 长写法排在前面（`modal v` 必须在 `n`/`v` 之前，否则先匹配到 `v` 再要求 `.` 会失配）。
_POS = (r"(?:modal\s+v|aux\s+v|link\s+v|abbr|pl|sing"
        r"|n|v|vt|vi|adj|adv|prep|conj|pron|num|interj|art|aux|det)")
POS_TOKEN_RE = re.compile(rf"{_POS}\s*\.", re.IGNORECASE)
CJK_RE = re.compile(r"[\u4e00-\u9fff]")
# 释义的起始边界：**中文，或全角左括号 `（`**。
# ⚠️ 半角 `(` **不能**当边界：它既是 IPA 的可选音（`guitar /ɡɪ'tɑː(r)/`），
# 也是词条自带的括号（`would ('d) like to`、`centre /'sentə(r)/ (= center)`）。
# 第一版把半角括号也算边界，结果 guitar 被切成 word=`guitar /ɡɪ'tɑː` + gloss=`(r)/ n. 吉他`。
GLOSS_START_RE = re.compile(r"[\u4e00-\u9fff（]")
# 剥掉词性之后残留在词尾的词性连接符（`both /bəʊθ/ adj. & pron.` → 剥完剩 `both &`）；
# OCR 还会把 & 认成 d/8
# 词性连接符。⚠️ `&` **永远不会出现在英文词内部**，所以直接全删；
# 第一版只删「前面带空白」的 `&`，于是 `& pron. 自己的` 剥完词性后剩一个孤立的 `&`，
# 整条被当非法词形丢弃 —— 实测因此丢了 than/out/do/orange/exercise 这些常用词。
POS_CONNECTOR_RE = re.compile(r"\s*&\s*")
# MinerU 的双栏还原偶尔会把小节标题/页码并进词里（`Unit 5 p.46 club`、`Unit 7 doll`），
# 前缀里这些噪音必须剥掉，否则整条被丢（doll 就是这么丢的）
WORD_NOISE_PREFIX_RE = re.compile(r"^(?:(?:Starter\s+)?Unit\s*\d+|[pP][.．]?\s*\d{1,3})\s+")
# 词条的合法形态。两点与直觉不同，都是实测踩出来的：
#   · 允许**数字开头**：课本有 `3D`（`3D /ˌθriː ˈdiː/ adj. 三维的`），只认字母开头会
#     把它整条丢掉（或者更糟：剥前缀符号时把 `3` 一起剥掉，剩下一个单词 `d` 混进题库）
#   · 允许**斜杠**：课本用课标缩写 `sb`/`sth` 写短语（`make up ground on sb/sth`、
#     `remind sb of sb/sth`、`even if/though`），不含斜杠就会把这些短语整条丢掉，
#     而且**丢掉的那条释义还会挂到上一个词身上**（实测 magazine/smooth 因此都多了
#     一段 `逼近正在向前的人或物`）
WORD_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9'/\- ]*$")
# 行内「词条头」：ASCII 词（允许一个空格连接的第二段）+ 音标，如 `shop /ʃɒp/`。
# 见 split_glued —— 行中间出现它就说明这里其实是下一条词条的开头。
GLUED_HEAD_RE = re.compile(r"[A-Za-z][A-Za-z'’\-]*(?:\s+[A-Za-z][A-Za-z'’\-]*)?\s*/[^/]{1,60}/")
# IPA 字符集（用于形态检查：出现 A/0/ze 这类「像拉丁字母的误识」即可疑）
# IPA 字母（含元音/辅音的扩展字符）
IPA_LETTERS = set("abcdefghijklmnopqrstuvwxyzæɑɒɔəɜɛɪʊʌθðʃʒŋɹɡɐɞɘɵʉɨɾɳʈɖɟɢχʁħʕɦɬɮʔʘǀǁǂǃɓɗʄɠʛʼ")
# IPA 里合法的**非字母**符号：重音（' 和 ˌ）、长短音（ː）、连字符、分号（一音多读）、括号（可选音）、省略点
# IPA 里合法的**非字母**符号：主重音 ˈ、次重音 ˌ、长短音 ː、连字符、分号（一音多读）、
# 括号（可选音）、省略点。⚠️ 主重音 `ˈ`(U+02C8) 与次重音 `ˌ`(U+02CC) 是**两个不同字符**，
# 第一版只写了后一个，导致 mɪˈsteɪk / ˌjuːˈkeɪ 这类全被误判 suspicious_ipa。
IPA_PUNCT = set(" ,;:.'’\"()-ˈˌːˑ̟̩͡")
# 高中课本的音标带**变体标注**（`/ˈɪʃuː; BrE also 'ɪsjuː/`、`/klɑːk; NAmE klɜːrk/`），
# 里面的 `NAmE`/`BrE` 是英文词，会被字符集检查判成「像拉丁字母的误识」——
# 实测 16 条 suspicious_ipa **全是**这么来的假阳性（真的可疑音标一个都没有）。
# 检查前先把标注摘掉，别让 16 条假警报把人工复核的清单淹掉。
IPA_VARIANT_RE = re.compile(r"\b(?:NAmE|BrE)\b")

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


def normalize_head(head: str) -> tuple[str, str, list[str], str]:
    """把「词条头」（音标 + 词性 + 括号注释 + 页码的那一段）拆成
    `(词形, 音标, 词性列表, 词尾剥下的大写字母)`。

    **两条路径共用**：正常词条（`bæt n. 球棒`）与「词头与释义折成两行」的词头
    （`across /ə'krɒs/ adv. & prep.` ⏎ `在（……）对面；横过`）。第一版只在正常路径里
    做了这套剥离，词头路径只剥音标就去比 WORD_RE，于是
    `across /ə'krɒs/ adv. & prep.`（剥完还剩 `adv. & prep.`）判非法整条丢掉，
    **它的释义还挂到了上一个词身上**（实测 building/dark/ability 的释义尾部都多了别的词的释义）。

    ⚠️ 顺序是硬要求，每一步都对应实测踩过的坑：
      1. **先剥音标** —— 不剥的话 `/` 过不了 WORD_RE（orange/across/understand 都死在这）
      2. 再剥词性 —— 剥完 `&` 才是独立符号，才能安全全删（`aux v. & v.` 剩的那个 `&`）
      3. 括号注释、行内页码引用放最后
    """
    phonetic_m = PHONETIC_RE.search(head)
    phonetic = phonetic_m.group(1).strip() if phonetic_m else ""
    body = PHONETIC_RE.sub(" ", head)
    pos_tokens = [m.group(0).strip() for m in POS_TOKEN_RE.finditer(body)]
    word = POS_TOKEN_RE.sub(" ", body).strip()
    # `a lot of / lots of` 这类「两个写法」取第一个；`would ('d) like to` 去掉括号注释
    if " / " in word:
        word = word.split(" / ")[0].strip()
    word = POS_CONNECTOR_RE.sub(" ", word)
    # MinerU 的双栏还原偶尔会把小节标题/页码并进词里（`Unit 5 p.46 club`、`Unit 7 doll`）
    while WORD_NOISE_PREFIX_RE.match(word):
        word = WORD_NOISE_PREFIX_RE.sub("", word).strip()
    # 词尾单独一个**大写字母**要并给释义：课本印的是 `T-shirt T恤衫`（字母与中文黏连），
    # 切点落在 `恤` 之前，会把 `T` 留在词里。只处理大写字母，避免误伤 `as a` 这类。
    tail_letter = ""
    tm = re.match(r"^(.*\S)\s+([A-Z])$", word)
    if tm:
        word, tail_letter = tm.group(1), tm.group(2)
    word = PAREN_GROUP_RE.sub(" ", word)   # 成对的括号注释（`would ('d) like to`）
    # 课本用符号标注「不要求掌握」的词（`△ the Eiffel Tower /…/ 埃菲尔铁塔`），
    # 符号会跟着词形一起被切进来，不剥掉整条就过不了 WORD_RE 而被丢。
    # ⚠️ 必须在 PAREN_GROUP_RE 之后做：`(at) first hand` 靠它去掉 `(at)`，
    # 先剥符号会把 `(` 单独吃掉，剩下 `at) first hand` → 词形变成 `at first hand`。
    # ⚠️ 数字不算符号：`3D` 的 `3` 不能被剥掉（踩过，剥完只剩 `d`）。
    word = re.sub(r"^[^A-Za-z0-9]+", "", word)
    word = STRAY_PAREN_RE.sub(" ", word)   # 剩下的未配对括号
    word = re.sub(r"\s*[pP][.．]?\s*\d{1,3}\s*", " ", word)
    return re.sub(r"\s+", " ", word).strip(), phonetic, pos_tokens, tail_letter


def split_glued(line: str) -> list[str]:
    """一行里塞了两条（有时更多）词条时拆开。

    实测三种形态（都是 MinerU 漏断行）：
      · 靠行内页码引用粘连：`everyday /'evrideɪ/ adj. 每天的；日常的 p.64prepare /prɪˈpeə(r)/`
      · 靠空格粘连：      `half /hɑːf/ n. 一半；半 pron. 半数 p.60 shop /ʃɒp/ n. 商店`
      · 完全无分隔粘连：  `bark /bɑːk/ n. 树皮certain /'sɜːtn/ adj. 某些；确定的`
    统一判据：**行中间出现「ASCII 词 + 音标」就是下一条词条的开头** ——
    课本每条词条的词形后面必跟音标，而释义里不会凭空出现这种组合。
    三种例外不算切点：行首（那是本行自己的词形）、括号组内（`(=ad/æd/)广告`、
    `(pl. media /'miːdiə/)` 是词条自带的注释）、紧跟在 `=` 或 `/` 后面
    （`record /rɪˈkɔːd/ v. 记录 /'rekɔːd/ n. 记录` 是同一条的两个读音，不是两条）。

    ⚠️ 不拆的后果是**两条都坏**：前一条的释义被后一条的词形污染，后一条整个消失
    （实测 everyday/prepare、half/shop、bark/certain、use/record… 一口气吃掉几十个常用词）。
    """
    depth_at: list[int] = []
    depth = 0
    for ch in line:
        depth_at.append(depth)
        if ch in "(（":
            depth += 1
        elif ch in ")）":
            depth = max(0, depth - 1)

    cuts: list[int] = []
    for m in GLUED_HEAD_RE.finditer(line):
        if m.start() == 0 or depth_at[m.start()] > 0:
            continue
        if line[m.start() - 1] in "=/":
            continue
        # ⚠️ 还要确认**前面真的是上一条词条的释义**（中文/`）`/页码引用结尾），否则会
        # 把「音标夹在中间的专名」切成两半：`the Western Regions /'riːdʒəns/ 西域` 会被切在
        # `Western` 前（前一段只剩 `the`），`Guglielmo /g/ Marconi /m/ 古列尔莫·马科尼`
        # 会被切成两个名字（实测丢了 the Western Regions / Robert Louis Stevenson /
        # the Eiffel Tower / Guglielmo Marconi / Bank of Canton 这些词表里的人名地名）。
        before = line[:m.start()].rstrip()
        if not (before and (CJK_RE.search(before[-1]) or before[-1] in ")）"
                             or PAGE_REF_TAIL_RE.search(before))):
            continue
        cuts.append(m.start())
    # **词组没有音标**，上面那条规则抓不到它们（`帽子 p.32have fun 玩得高兴`、
    # `月份 p.68 Mrs`、`现在;此刻 p.34at the start 开始;起初`）。
    # 课本里页码引用永远在行尾，所以行中的页码引用后面跟着字母 ⇒ 下一条词条被并进来了。
    for m in PAGE_REF_MID_RE.finditer(line):
        rest = line[m.end():].lstrip()
        if rest and rest[0].isalpha():
            cuts.append(m.end())
    if not cuts:
        return [line]

    parts: list[str] = []
    start = 0
    for c in sorted(set(cuts)):
        parts.append(line[start:c].strip())
        start = c
    parts.append(line[start:].strip())
    return [p for p in parts if p]


def _flag_suspect_merge(entries: list[Entry], piece: str) -> None:
    """续行并入上一条**之前**，判断这行是不是别人丢掉的释义。

    两栏被 MinerU 交错输出时，右栏的一整条会插进左栏「词头行」和「释义行」之间，
    那行释义就落到了插进来的那条上 —— `money` 因此拿到 `捕捉;接住`，
    而被抢释义的 `catch` 因为始终没释义被整条丢弃。

    三条判据**全部满足**才打标记（任何一条不满足都说明是正常折行）：
      1. 上一条**只有自己那一行**（还没并过续行）—— 一旦并过，后面正常的多行释义
         都会被误判（`speed` 的 `速度` + `v. (sped…)` + `加速；促进` 就是这么误报的）
      2. 上一条那一行**以页码引用收尾** —— 课本里页码总是在整条词条的最后，
         带页码说明这条已经写完了，那它就不该再有续行
         （`admit /əd'mɪt/ vi. & vt. 承认` 没有页码，`vt. 准许进入（或加入）` 是它的
         第二个义项，正常）
      3. 续行**没有给出上一条缺的词性** —— 一词多词性折行
         （`clean /kliːn/ adj. 干净的` ⏎ `v. 使……干净；打扫`）

    只做**标记**，不改数据：这类挂错**没有确定性判据**能自动区分 ——
    同一本书里 `catch`（该给前面那个空释义的词头）和 `admit`（该给紧邻的上一条）
    结构完全一样（都是「空释义词头 + 完整词条 + 一行释义」），程序只能猜，
    猜错就是把正常词条改坏。所以标记出来交人工，见 `vocabulary_gloss_fixes.jsonl`。
    """
    if not entries:
        return
    e = entries[-1]
    if " ⏎ " in e.raw:                     # 已经并过续行 → 后面都是正常的多行释义
        return
    if not PAGE_REF_TAIL_RE.search(e.raw):  # 自己那行没页码 → 本来就没写完
        return
    piece_pos = {m.group(0).strip() for m in POS_TOKEN_RE.finditer(piece)}
    if piece_pos - set(e.pos.split()):
        return
    if "suspect_foreign_gloss" not in e.flags:
        e.flags.append("suspect_foreign_gloss")


def parse_entries(md_dir: Path, source: str) -> list[Entry]:
    entries: list[Entry] = []
    skipped: list[str] = []
    dropped: list[str] = []
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
        if NOTE_LINE_RE.match(line):            # 编辑说明，不是词条也不是释义
            skipped.append(raw)
            continue

        # 一行可能塞着两条词条（`…日常的 p.64prepare /prɪˈpeə(r)/`），先拆再逐条处理
        for piece in split_glued(line):
            # 拆出来的前半条，行尾会留下**自己的**页码引用（`…球拍 p.29`）——
            # 行首那次 PAGE_REF_TAIL_RE 只剥到了整行末尾那个，所以这里要再剥一次。
            piece = PAGE_REF_TAIL_RE.sub("", piece).strip()
            if not piece:
                continue
            head_gloss = _split_head_gloss(piece)

            # ---- 续行 1：直接以释义开头（中文或左括号；释义折行） ----
            if GLOSS_START_RE.match(piece):
                if entries:
                    _flag_suspect_merge(entries, piece)
                    gl = entries[-1].gloss
                    entries[-1].gloss = gl + (piece if piece.startswith(("（", "("))
                                             else (" " if gl else "") + piece)
                    entries[-1].raw += " ⏎ " + piece
                else:
                    skipped.append(raw)
                continue

            # ---- 续行 2：以词性开头（词性与释义折到下一行） ----
            # ⚠️ 条件是「**有上一条**」，不是「上一条的释义还空着」。课本一条词条常有多组
            # 词性各占一行（实测 `speed /spiːd/ n. 速度` ⏎ `v. (sped/sped/, sped; speeded,
            # speeded)` ⏎ `加速；促进`）。第一版要求上一条释义为空，于是 `v. …` 那行被当成
            # 新词条的**词头**，还把下一行的中文吸成自己的释义 —— 产出了
            # `'v. (sped/sped/, sped; speeded, speeded)'` 这种垃圾词条，同时 `speed`
            # 少了动词义项。反过来「行首是词性 ⇒ 一定是续行」在本词表里成立：正常词条的
            # 词形永远在行首，所以行首就是词性的只能是折行。
            pm = POS_TOKEN_RE.match(piece)
            if pm and entries:
                _flag_suspect_merge(entries, piece)
                e = entries[-1]
                if not e.pos:
                    e.pos = piece[:pm.end()].strip()
                # 整行并进去（连词性一起）：loader 的 split_senses 会按内嵌词性再切成多个义项
                e.gloss += (" " if e.gloss else "") + piece
                e.raw += " ⏎ " + piece
                continue

            if head_gloss is None:
                # **无中文的行不等于噪声 —— 它多半是「词头与释义被分到两行」的词头**。
                # MinerU 偶尔把词头与释义断成两行（`across /ə'krɒs/ adv. & prep.` ⏎ 释义、
                # `orange /'ɒrɪndʒ/` ⏎ `adj. & n. …`）。第一版把无中文的行直接丢掉，于是
                # 词头丢失、**它的释义还挂到了上一个词身上**（实测 building/dark/ability/
                # intense 的释义尾部都多出了后面那条词条的释义）。
                # 这里当作「待补释义的词头」，下一行的中文会被上面的续行规则补进来。
                word, phonetic, pos_tokens, _ = normalize_head(piece)
                if WORD_RE.match(word):
                    entries.append(Entry(
                        word=word, phonetic=phonetic, pos=" ".join(pos_tokens), gloss="",
                        source=source, page=page, raw=raw,
                        section=current_section, group=current_group,
                    ))
                else:
                    # 剥不出词形（`v. (sped/sped/, sped; speeded, speeded)` 这种纯词性行）→
                    # 丢弃。绝不能收下：它会把下一行的中文吸成自己的释义，变成有释义的垃圾词条。
                    skipped.append(raw)
                continue

            head, gloss = head_gloss

            # ---- 续行 3：以**未闭合的左括号**开头（`(application 的缩略形式)`）----
            # 这种行是上一条词条的括号注释折到了下一行，不是新词条。
            # ⚠️ 不能简单按「以 `(` 开头就是续行」判：`(at) first hand 第一手；亲自`
            # 就是一条完整词条。区别在**括号有没有闭合** —— 注释折行必然是断在括号中间的。
            # 另外 `AI /…/ (= artificial /…/`（词在前、括号未闭合）也不能算续行，
            # 它后面跟着的是 `intelligence …) 人工智能`，那是同一个括号注释的另一半。
            if head.lstrip().startswith("(") and head.count("(") > head.count(")"):
                if entries:
                    entries[-1].gloss += (" " if entries[-1].gloss else "") + piece
                    entries[-1].raw += " ⏎ " + piece
                    continue
                skipped.append(raw)
                continue

            # ---- 新词条 ----
            word, phonetic, pos_tokens, tail_letter = normalize_head(head)
            if tail_letter:
                gloss = tail_letter + gloss

            flags: list[str] = []
            # 剥完音标/词性后词为空 → 这行其实是**上一条的续行**。两种常见来源：
            #   · `(外)孙子;(外)孙女` 被切成 head=`(`（半角括号不算释义边界）
            #   · 续行以**另一个读音的音标**开头（`use /juːz/ v. 使用；利用` ⏎
            #     `/juːs/ n. 使用;用途`）—— 音标属于词条头，不属于释义
            # 所以并回去时要先把行首的音标与孤立括号摘掉，否则 UI 上会出现
            # 「释义：使用;利用 /juːs/ n. 使用;用途」这种带读音的释义（实测 71 条）。
            if not word:
                if entries:
                    _flag_suspect_merge(entries, piece)
                    rest = LEADING_STRAY_PAREN_RE.sub("", PHONETIC_HEAD_RE.sub("", piece)).strip()
                    if rest:
                        entries[-1].gloss += (" " if entries[-1].gloss else "") + rest
                    entries[-1].raw += " ⏎ " + piece
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
            # 音标形态检查：摘掉 `; NAmE` / `; BrE` 变体标注后再看字符集（见 IPA_VARIANT_RE）
            if phonetic and set(IPA_VARIANT_RE.sub("", phonetic)) - IPA_LETTERS - IPA_PUNCT:
                flags.append("suspicious_ipa")
            entries.append(Entry(word, phonetic, " ".join(pos_tokens), gloss, source, page, raw,
                                 flags, current_section, current_group))

    # **释义为空的词条打标记但不在这里丢**。走到这里还没释义的只有一类：折行的词头后面
    # 没有跟到释义（书后「阅读书目」页的书名、练习册答案页的 `a price`/`b speed`、
    # OCR 掉了释义的真词 ethnic/dominant）。留着它们等于往题库里灌「只有词、没有意思」的词条
    # —— 学生抽到只能干瞪眼，所以 loader 会把它们丢掉；
    # **但要在这里保留并打标记**：双栏交错时被抢走释义的真词（`catch`/`grandfather`）
    # 走的也是这条路，人工修正表要靠这条记录才能把它们连词形带音标一起救回来
    # （见 vocabulary_gloss_fixes.jsonl）。第一版直接在这里删掉，那些词就再也回不来了。
    for e in entries:
        if not e.gloss.strip():
            e.flags.append("no_gloss")
            dropped.append(f"{e.word}\t{e.raw}")

    if skipped:
        (md_dir / "_skipped_lines.txt").write_text("\n".join(skipped), encoding="utf-8")
    if dropped:
        (md_dir / "_dropped_no_gloss.txt").write_text("\n".join(dropped), encoding="utf-8")
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


def check_monotonic(entries: list[Entry]) -> list[tuple[str, Entry]]:
    """字母序单调性检查：词表按字母序排，**乱码词几乎必然破坏单调性**。

    这是本管线最主要的**确定性**校验（MinerU 的 md 不带逐行置信度）。
    必须**按 (书, 分段) 分组**比：每段的词各自从 a 排到 z，跨段比会全是误报。

    返回 `(紧邻的前一个词, 违规条目)` 列表；违规项加 `order_violation` 标记
    （不改变顺序、不丢弃）。返回前一个词是为了**人工复核时能一眼看到断点**
    （只知道「这一条违规」看不出该改谁）。

    ⚠️ **必须返回条目本身而不是个数**：同一个词往往在多本书里出现，去重时只留首次出现的
    那一条并连它的 flags 一起留 —— 只报个数的话，调用方拿到的是「20 条违规」却一条都找不到
    （违规的那条很可能在去重时被丢掉了，实测 20 条违规一条都没出现在最终的标记清单里）。
    """
    groups: dict[tuple[str, str, str], list[Entry]] = {}
    for e in entries:
        # ⚠️ **只校验字母序段落**（Vocabulary A-Z）。`in Each Unit` 是按课文出现顺序排的，
        # 拿字母序去比它会产生 100% 假阳性（实测踩过）。
        if not is_alphabetical_group(e.group):
            continue
        groups.setdefault((e.source, e.group, e.section), []).append(e)
    violations: list[tuple[str, Entry]] = []
    for group in groups.values():
        prev = ""
        prev_word = ""
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
                violations.append((prev_word, e))
            prev = key
            prev_word = e.word
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
