"""统一的素材范围过滤（convert / extract / publish / db_loader / 编排 CLI 共用）。

素材相对路径的维度约定（爬虫目录）：

    试卷: {学科}/{学段}/{first|second}/{年份}/{试卷名}
    教材: {学科}/{学段}/{出版社}/{年级}/{上册|下册}/{书名}

统一参数（所有阶段同名同义，逗号分隔可多值，参数之间取交集）：

    --subject  学科（中文目录名或 code：语文 / chinese）
    --stage    学段（初中 / junior）
    --term     学期（上 / 下 / first / second / 上册 / 下册）
    --year     年份（4 位，仅试卷有该维度）
    --file     关键词（空格等分隔符分词，所有词都命中相对路径；单卷 / 单书）

`--file` 不是「一段连续子串」：`--file "2026 海淀"` 会把关键词拆成 `2026` 与 `海淀`，
两者都出现在相对路径里才算命中（顺序无关、不分大小写）。这样用户按「年份 + 区县」
的自然写法就能定位到卷子，不必记住爬虫的文件名格式。

`--pages`（页码）与 `--questions-only` / `--cards-only`（题/卡类型）属于阶段专属，
不放进本模块，但语义同样在各 CLI 保持一致。
"""

import argparse
import re
from dataclasses import dataclass
from pathlib import Path

from subject_codes import SUBJECT_NAME_TO_CODE

# 学期别名：目录段值 -> 规范键（first=上学期/上册，second=下学期/下册）
TERM_ALIASES = {
    "first": "first", "上": "first", "上册": "first", "上学期": "first",
    "second": "second", "下": "second", "下册": "second", "下学期": "second",
}

# 学段别名：爬虫目录用中文，PaperMeta/DB 用英文
STAGE_ALIASES = {
    "primary": "primary", "小学": "primary",
    "junior": "junior", "初中": "junior",
    "senior": "senior", "高中": "senior",
}

# subject code -> 中文目录名（--subject 同时接受两种写法）
_CODE_TO_NAME = {code: name for name, code in SUBJECT_NAME_TO_CODE.items()}


def _split(raw: str | None) -> list[str]:
    """逗号分隔的多值参数 -> 去空白列表。"""
    if not raw:
        return []
    return [v.strip() for v in raw.split(",") if v.strip()]


# 关键词分隔符：空白（含全角空格）、中英文横线/下划线、路径斜杠、中点、顿号。
# 逗号不在此列 —— `--materials "A,B"` 的逗号是「多份取 OR」，切开就变成 AND 了。
_KEYWORD_SPLIT_RE = re.compile(r"[\s\u3000\-_/／·•・、]+")

# 相对路径上可能带的产物后缀。只剥这些，不能无脑 Path.with_suffix()：
# 卷名里本来就可能有 `2025.1` 这类点号，剥掉会改坏匹配。
_KNOWN_SUFFIXES = frozenset({".md", ".jsonl", ".pdf", ".doc", ".docx", ".ppt", ".pptx"})


def split_keyword(raw: str | None) -> tuple[str, ...]:
    """关键词 -> token 元组（保序去重，空 token 丢弃）。"""
    if not raw:
        return ()
    tokens: list[str] = []
    seen: set[str] = set()
    for token in _KEYWORD_SPLIT_RE.split(str(raw).casefold()):
        if token and token not in seen:
            seen.add(token)
            tokens.append(token)
    return tuple(tokens)


def normalize_path(path: Path | str) -> str:
    """相对路径 -> 可比较的规范串（剥已知产物后缀 + 统一小写 + posix 分隔符）。"""
    p = Path(path)
    text = p.as_posix()
    if p.suffix.lower() in _KNOWN_SUFFIXES:
        text = text[: -len(p.suffix)]
    return text.casefold()


def match_keyword(path: Path | str, keyword: str | None) -> bool:
    """关键词是否命中路径：所有 token 都出现即命中（顺序无关）。空关键词不过滤。"""
    tokens = split_keyword(keyword)
    if not tokens:
        return True
    haystack = normalize_path(path)
    return all(token in haystack for token in tokens)


def scope_prefix(subject: str | None = None, stage: str | None = None,
                 term: str | None = None, year: str | None = None) -> str:
    """把维度参数拼成 `道法/初中/first/2026` 形式的范围说明（0 命中文案用）。"""
    segments: list[str] = []
    subjects = _split(subject)
    if subjects:
        segments.append(_CODE_TO_NAME.get(subjects[0], subjects[0]))
    stages = _split(stage)
    if stages:
        segments.append(STAGE_ALIASES.get(stages[0], stages[0]))
    terms = _split(term)
    if terms:
        segments.append(TERM_ALIASES.get(terms[0], terms[0]))
    years = _split(year)
    if years:
        segments.append(years[0])
    return "/".join(segments)


def parse_dimensions(rel_path: Path | str) -> dict[str, str | None]:
    """按目录约定拆出 rel_path 的维度段，缺的维度为 None。"""
    parts = Path(rel_path).as_posix().split("/")
    if len(parts) < 5:
        return {"subject": None, "stage": None, "term": None, "year": None}

    dims: dict[str, str | None] = {
        "subject": parts[0],
        "stage": STAGE_ALIASES.get(parts[1]),
        "term": None,
        "year": None,
    }
    if parts[2] in ("first", "second") and len(parts[3]) == 4 and parts[3].isdigit():
        dims["term"] = TERM_ALIASES[parts[2]]
        dims["year"] = parts[3]
    else:
        dims["term"] = TERM_ALIASES.get(parts[4])
    return dims


@dataclass(frozen=True)
class Scope:
    """已归一的范围条件；None/空集合 = 该维度不限。"""
    subjects: frozenset[str] | None = None  # 中文目录名
    stages: frozenset[str] | None = None    # primary/junior/senior
    terms: frozenset[str] | None = None     # first/second
    years: frozenset[str] | None = None     # '2025'
    file: str | None = None                 # 关键词原文（describe 用）
    # 关键词分词结果（缓存；构造时派生，hasattr 判定避免 dataclass 默认值问题）
    _file_tokens: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not self._file_tokens:
            object.__setattr__(self, "_file_tokens", split_keyword(self.file))

    @property
    def file_tokens(self) -> tuple[str, ...]:
        return self._file_tokens

    @property
    def active(self) -> bool:
        return any((self.subjects, self.stages, self.terms, self.years, self._file_tokens))


def build_scope(subject: str | None = None, stage: str | None = None,
                term: str | None = None, year: str | None = None,
                file: str | None = None) -> Scope:
    """把原始参数归一成 Scope（中文名/code、上/下/上册 等别名统一）。"""
    subjects = {_CODE_TO_NAME.get(s, s) for s in _split(subject)}
    stages = {STAGE_ALIASES.get(s, s) for s in _split(stage)}
    terms = {TERM_ALIASES.get(t, t) for t in _split(term)}
    years = set(_split(year))
    return Scope(
        subjects=frozenset(subjects) or None,
        stages=frozenset(stages) or None,
        terms=frozenset(terms) or None,
        years=frozenset(years) or None,
        file=file or None,
    )


def match_scope(rel_path: Path | str, scope: Scope) -> bool:
    """素材相对路径是否在范围内（参数之间取交集）。"""
    if not scope.active:
        return True
    rel = Path(rel_path)
    if scope.file_tokens and not match_keyword(rel, scope.file):
        return False
    dims = parse_dimensions(rel)
    if scope.subjects and dims["subject"] not in scope.subjects:
        return False
    if scope.stages and dims["stage"] not in scope.stages:
        return False
    if scope.terms and dims["term"] not in scope.terms:
        return False
    if scope.years and dims["year"] not in scope.years:
        return False
    return True


def add_scope_args(parser: argparse.ArgumentParser) -> None:
    """给 CLI 注册统一的范围参数（help 文案也保持一致）。"""
    parser.add_argument("--subject", help="学科过滤（中文名或 code，如 语文 / chinese），逗号分隔多个")
    parser.add_argument("--stage", help="学段过滤（初中/小学/高中 或 junior/primary/senior），逗号分隔多个")
    parser.add_argument("--term", help="学期过滤（上/下 或 first/second；教材也可写 上册/下册），逗号分隔多个")
    parser.add_argument("--year", help="年份过滤（4 位，仅试卷素材，如 2025），逗号分隔多个")
    parser.add_argument("--file", help="关键词（空格等分隔符分词，所有词都命中相对路径，顺序无关）")


def scope_from_args(args) -> Scope:
    """从 argparse 结果构造 Scope（CLI 主流程用）。"""
    return build_scope(
        subject=getattr(args, "subject", None),
        stage=getattr(args, "stage", None),
        term=getattr(args, "term", None),
        year=getattr(args, "year", None),
        file=getattr(args, "file", None),
    )


def scope_argv(args, include_file: bool = True) -> list[str]:
    """把 CLI 上的范围参数原样转成 argv 片段，供编排 CLI 透传给子阶段。

    include_file=False 用于不支持 --file 的阶段（如 convert_cli 用 --materials）。
    """
    out: list[str] = []
    flags = ("subject", "stage", "term", "year", "file") if include_file \
        else ("subject", "stage", "term", "year")
    for flag in flags:
        value = getattr(args, flag, None)
        if value:
            out.extend([f"--{flag}", str(value)])
    return out


def describe(scope: Scope) -> str:
    """一行可读描述（日志/干跑用）。"""
    parts = []
    if scope.subjects:
        parts.append(f"subject={'/'.join(sorted(scope.subjects))}")
    if scope.stages:
        parts.append(f"stage={'/'.join(sorted(scope.stages))}")
    if scope.terms:
        parts.append(f"term={'/'.join(sorted(scope.terms))}")
    if scope.years:
        parts.append(f"year={'/'.join(sorted(scope.years))}")
    if scope.file:
        parts.append(f"file~{scope.file}")
    return " ".join(parts) if parts else "all"
