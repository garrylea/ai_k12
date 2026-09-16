"""语文古诗文解释专项管线：**输入解析**（纯函数，不碰网络与数据库）。

## 输入由人整理，管线只解析

字词内容是用户手工整理的，本模块负责把它读成结构化数据。两种格式任选，字段名中英文都认：

    # JSON / JSONL（一行一篇，或一个文件一个数组）
    {"work_title":"岳阳楼记","semester":"上册",
     "key_terms":[{"term":"谪守","gloss":"因罪贬谪流放，出任外官"}]}

    # Markdown（手写友好；`#` 标题分篇，一个文件可放多篇）
    # 岳阳楼记

    册次：上册

    1. 谪守：因罪贬谪流放，出任外官
    2. 越明年：到了第二年

行写法全部容错：行首编号可有可无（`1.` / `1、` / `1` / `①` / `-` / `*` / `（1）`），
词可带括号（`〔谪守〕` / `[谪守]`），分隔符 `：`/`:`/`＝`/`=` 或首个空白都认
—— 连 `1 则:那么` 也认（term=则，gloss=那么）。

## 正文不在这里

**正文不由输入提供**：库里 `chinese_passages.body` 是权威正文，切句由
`interpretation_split` 对它做。输入只给「篇名 + 册次 + 字词」。

## 译文是**可选**的（混合模式）

输入可以额外给 `sentences`（逐句原文 + 译文）：
- **给了** → 以输入的为准，管线不调模型；
- **没给** → 由 `interpretation_translate` 调模型生成。

Markdown 里用 `>` 两行一组表示（第一行原文，第二行译文）：

    > 庆历四年春，滕子京谪守巴陵郡。
    > 庆历四年的春天，滕子京被贬到巴陵郡做太守。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

# ---- 字段别名：中英文都认，可混用 ----
_TITLE_KEYS = ("work_title", "篇名", "诗文名", "题目", "诗名", "文名")
_SEMESTER_KEYS = ("semester", "册次", "册")
_TERMS_KEYS = ("key_terms", "字词", "重点字词", "词语", "重点词")
_TERM_KEYS = ("term", "词", "字词", "重点词", "词语")
_GLOSS_KEYS = ("gloss", "解释", "释义", "意思", "含义")
_SENTENCES_KEYS = ("sentences", "逐句", "句子")
_SENT_TEXT_KEYS = ("text", "原文", "句", "句子")
_SENT_TRANS_KEYS = ("translation", "译文", "翻译")

#: 圈号（教材注释编号体例）。用于剥 Markdown 行首编号。
_CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚㉛㉜㉝㉞㉟"

#: 行首编号：`（1）` / `1.` / `1、` / `1)` / `1` / `①` / `-` / `*` / `•`
_ENUM_RE = re.compile(
    r"^\s*(?:"
    r"[（(]\s*\d+\s*[）)]"
    r"|\d+\s*[.、)）]?"
    r"|[" + _CIRCLED + r"]"
    r"|[-*•·]"
    r")\s*"
)

#: 词与解释的分隔：中文冒号 / 英文冒号 / 全角等号 / 半角等号
_SEP_RE = re.compile(r"[:：=＝]")

#: 包裹 term 的括号（写成 〔谪守〕 也对）
_WRAP_CHARS = "〔〕[]（）()【】"

_SEMESTER_VALUES = ("上册", "下册")

_BLOCKQUOTE_RE = re.compile(r"^\s*>\s?(.*)$")
_HEADING_RE = re.compile(r"^\s*#{1,6}\s+(.*)$")
_SEMESTER_LINE_RE = re.compile(r"^\s*(?:semester|册次|册)\s*[:：=＝]?\s*(.+?)\s*$")


@dataclass
class InputKeyTerm:
    term: str
    gloss: str


@dataclass
class InputSentence:
    text: str
    translation: str


@dataclass
class PassageInput:
    work_title: str
    semester: str | None
    key_terms: list[InputKeyTerm] = field(default_factory=list)
    #: `None` = 输入没给译文（由管线生成）；`[]` 不该出现（给了就得有内容）
    sentences: list[InputSentence] | None = None
    warnings: list[str] = field(default_factory=list)


@dataclass
class ParseResult:
    passages: list[PassageInput] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def _pick(d: dict, keys: tuple[str, ...]):
    """取第一个存在的别名字段。返回 (found, value)。"""
    for k in keys:
        if k in d and d[k] is not None:
            return True, d[k]
    return False, None


def _strip_wrap(s: str) -> str:
    """剥掉包裹 term 的括号：〔谪守〕 → 谪守。"""
    s = s.strip()
    while len(s) >= 2 and s[0] in _WRAP_CHARS and s[-1] in _WRAP_CHARS:
        s = s[1:-1].strip()
    return s


def _split_term_line(line: str) -> tuple[str, str] | None:
    """把一行拆成 (term, gloss)。拆不出返回 None。"""
    body = _ENUM_RE.sub("", line, count=1).strip()
    if not body:
        return None
    m = _SEP_RE.search(body)
    if m:
        return body[: m.start()], body[m.end():]
    # 退而求其次：首个空白当分隔（`则 那么`）
    parts = re.split(r"\s+", body, maxsplit=1)
    if len(parts) == 2:
        return parts[0], parts[1]
    return None


def _clean_terms(raw_terms: list[InputKeyTerm], work_title: str, warnings: list[str]) -> list[InputKeyTerm]:
    """清洗 + 去重：空 term/gloss **丢弃并告警**（不静默吞），同 term 保留首次。"""
    out: list[InputKeyTerm] = []
    seen: set[str] = set()
    for t in raw_terms:
        term = _strip_wrap(t.term)
        gloss = t.gloss.strip()
        if not term or not gloss:
            warnings.append(f"《{work_title}》丢弃字词「{t.term}」：{'词为空' if not term else '解释为空'}")
            continue
        if term in seen:
            warnings.append(f"《{work_title}》字词「{term}」重复，保留首次出现")
            continue
        seen.add(term)
        out.append(InputKeyTerm(term=term, gloss=gloss))
    return out


def _normalize_semester(raw, work_title: str, warnings: list[str]) -> str | None:
    if raw is None:
        return None
    val = str(raw).strip()
    if val in _SEMESTER_VALUES:
        return val
    warnings.append(f"《{work_title}》册次「{val}」不是 上册/下册，按未提供处理（将按篇名匹配）")
    return None


# ==================== JSON / JSONL ====================


def _passage_from_dict(d: dict, warnings: list[str]) -> PassageInput | None:
    found_title, raw_title = _pick(d, _TITLE_KEYS)
    if not found_title or not str(raw_title).strip():
        warnings.append(f"跳过一条记录：缺少篇名字段（认 {'/'.join(_TITLE_KEYS)}）")
        return None
    work_title = str(raw_title).strip()

    found_sem, raw_sem = _pick(d, _SEMESTER_KEYS)
    semester = _normalize_semester(raw_sem if found_sem else None, work_title, warnings)

    raw_terms: list[InputKeyTerm] = []
    found_terms, terms_val = _pick(d, _TERMS_KEYS)
    if found_terms:
        if not isinstance(terms_val, list):
            warnings.append(f"《{work_title}》字词字段不是数组，按空处理")
        else:
            for item in terms_val:
                if not isinstance(item, dict):
                    warnings.append(f"《{work_title}》丢弃一条字词：不是对象")
                    continue
                f_term, term_val = _pick(item, _TERM_KEYS)
                f_gloss, gloss_val = _pick(item, _GLOSS_KEYS)
                if not f_term:
                    warnings.append(f"《{work_title}》丢弃一条字词：缺词字段（认 {'/'.join(_TERM_KEYS)}）")
                    continue
                raw_terms.append(InputKeyTerm(
                    term=str(term_val),
                    gloss=str(gloss_val) if f_gloss else "",
                ))

    sentences: list[InputSentence] | None = None
    found_sents, sents_val = _pick(d, _SENTENCES_KEYS)
    if found_sents:
        sentences = []
        if not isinstance(sents_val, list):
            warnings.append(f"《{work_title}》译文 sentences 不是数组，按未提供处理")
            sentences = None
        else:
            for item in sents_val:
                if not isinstance(item, dict):
                    warnings.append(f"《{work_title}》丢弃一条译文：不是对象")
                    continue
                _, text_val = _pick(item, _SENT_TEXT_KEYS)
                _, trans_val = _pick(item, _SENT_TRANS_KEYS)
                sentences.append(InputSentence(
                    text=str(text_val) if text_val is not None else "",
                    translation=str(trans_val) if trans_val is not None else "",
                ))
            if not sentences:
                sentences = None

    return PassageInput(
        work_title=work_title,
        semester=semester,
        key_terms=_clean_terms(raw_terms, work_title, warnings),
        sentences=sentences,
    )


def parse_json(text: str) -> ParseResult:
    """一个 JSON 数组，或 JSONL 若干行。"""
    res = ParseResult()
    stripped = text.strip()
    if not stripped:
        return res

    records: list = []
    if stripped.startswith("["):
        try:
            data = json.loads(stripped)
        except json.JSONDecodeError as e:
            res.warnings.append(f"JSON 解析失败：{e}")
            return res
        if not isinstance(data, list):
            res.warnings.append("JSON 顶层不是数组")
            return res
        records = data
    else:
        for lineno, line in enumerate(text.splitlines(), start=1):
            if not line.strip():
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError as e:
                res.warnings.append(f"第 {lineno} 行 JSON 解析失败：{e}")

    for d in records:
        if not isinstance(d, dict):
            res.warnings.append("丢弃一条记录：不是对象")
            continue
        p = _passage_from_dict(d, res.warnings)
        if p is not None:
            res.passages.append(p)
    return res


# ==================== Markdown ====================


def parse_markdown(text: str) -> ParseResult:
    """`#` 标题分篇；`册次：上册` 定册；`>` 两行一组表逐句；其余非空行表字词。"""
    res = ParseResult()
    current: PassageInput | None = None
    pending_quote: str | None = None

    def flush_quote() -> None:
        """落单的 `>` 行（奇数个）——没有配对译文，按「无译文」丢弃并告警。"""
        nonlocal pending_quote
        if pending_quote is not None and current is not None:
            res.warnings.append(
                f"《{current.work_title}》有一行 `>` 译文没有配对（`>` 需两行一组：先原文后译文），已丢弃"
            )
        pending_quote = None

    for lineno, raw_line in enumerate(text.splitlines(), start=1):
        line = raw_line.rstrip()
        if not line.strip():
            continue

        heading = _HEADING_RE.match(line)
        if heading:
            flush_quote()
            title = heading.group(1).strip()
            current = PassageInput(work_title=title, semester=None)
            res.passages.append(current)
            continue

        if current is None:
            res.warnings.append(f"第 {lineno} 行在第一个 `#` 篇名之前，已忽略：{line.strip()[:30]}")
            continue

        sem = _SEMESTER_LINE_RE.match(line)
        if sem:
            current.semester = _normalize_semester(sem.group(1), current.work_title, res.warnings)
            continue

        quote = _BLOCKQUOTE_RE.match(line)
        if quote:
            content = quote.group(1).strip()
            if pending_quote is None:
                pending_quote = content
            else:
                if current.sentences is None:
                    current.sentences = []
                current.sentences.append(InputSentence(text=pending_quote, translation=content))
                pending_quote = None
            continue

        flush_quote()
        split = _split_term_line(line)
        if split is None:
            res.warnings.append(f"《{current.work_title}》第 {lineno} 行认不出「词：解释」，已忽略：{line.strip()[:30]}")
            continue
        current.key_terms.append(InputKeyTerm(term=split[0], gloss=split[1]))

    flush_quote()

    for p in res.passages:
        p.key_terms = _clean_terms(p.key_terms, p.work_title, res.warnings)
    return res


# ==================== 入口 ====================


def load_input(path: str | Path) -> ParseResult:
    """按扩展名选解析器（.md/.markdown → Markdown，其余 → JSON/JSONL）。"""
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    if p.suffix.lower() in (".md", ".markdown"):
        return parse_markdown(text)
    return parse_json(text)


def dedupe_passages(res: ParseResult) -> ParseResult:
    """同一文件里同一 (篇名, 册次) 出现多次 → 后者并进前者（字词相加再清洗）。"""
    merged: dict[tuple[str, str | None], PassageInput] = {}
    out = ParseResult(warnings=list(res.warnings))
    for p in res.passages:
        key = (p.work_title, p.semester)
        if key not in merged:
            merged[key] = p
            out.passages.append(p)
            continue
        target = merged[key]
        out.warnings.append(f"《{p.work_title}》在输入里出现多次，已合并")
        target.key_terms = _clean_terms(
            target.key_terms + p.key_terms, target.work_title, out.warnings
        )
        if p.sentences is not None:
            if target.sentences is not None:
                out.warnings.append(f"《{p.work_title}》译文出现多次，以首次为准")
            else:
                target.sentences = p.sentences
    return out
