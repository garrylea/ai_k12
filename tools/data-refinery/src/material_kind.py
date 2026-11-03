"""素材类型判定：文件名 → 卷面首屏 → 目录结构 → 问用户。

为什么需要这一层（2026-11-03）：整条管线原先只认文件名里的「试卷/答案」，
手工丢进 `crawler/data` 的卷子（`2026北京北京中学初三（上）期中数学.pdf`）
名字不带这两个字，被当成教材卡，一路静默降级，最后在 db_loader 抛
「无法解析教材 rel_path」——题库里 0 条，用户不知道为什么。

判定原则（用户裁决）：**判不出来不许替用户猜，也不许直接拒绝**。
- 名称 → 内容 → 结构，任一环节有确定证据就用，不打扰用户；
- 都没有时，交互终端下让用户选一次，选择落盘（`output/.material_kinds.json`），
  下次同一条命令不再问；
- 非交互终端才报错，并把「该往缓存里写什么」告诉用户。

顺序为什么不倒过来（先内容后名称）：教材是**逐页** md（`page_018.md`），
单页里既没有卷首也没有章节号，靠内容判教材几乎判不出来；而「同目录有没有
`page_*.md` 兄弟」是 824/825 教材都成立的强结构特征，95/95 试卷都不成立。
名称仍然排第一，因为它零 I/O，且爬虫的 534 份素材命名是可靠的。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

PAPER = "paper"
ANSWER = "answer"
TEXTBOOK = "textbook"
KINDS = (PAPER, ANSWER, TEXTBOOK)

# 入库/发布侧的 kind 取值（历史命名，别改：checkpoint、--questions-only 都用它）
SCOPE_KIND = {PAPER: "questions", ANSWER: "questions", TEXTBOOK: "cards"}

KIND_LABELS = {PAPER: "试卷", ANSWER: "答案", TEXTBOOK: "教材"}

_HEAD_LINES = 15
_ANSWER_MARKERS = ("参考答案", "答案及评分", "评分标准")
_PAPER_MARKERS = ("试卷", "答题卡")


class MaterialKindUnknown(RuntimeError):
    """名称、内容、结构都判不出，且当前不是交互终端（不能问用户）。"""


def classify_name(name: str) -> str | None:
    """按文件名判：仍是零 I/O 的第一道闸，保持与旧行为一致（先「试卷」后「答案」）。"""
    if "试卷" in name:
        return PAPER
    if "答案" in name:
        return ANSWER
    return None


def _head(text: str, max_lines: int = _HEAD_LINES) -> str:
    """取 md 首屏：前 N 个非空行，去掉标题符号 / 表格 / 纯图片行。"""
    out: list[str] = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("<table") or line.startswith("|"):
            continue
        if line.startswith("![](") or line.startswith("!["):
            continue
        line = line.lstrip("#").strip()
        if not line:
            continue
        out.append(line)
        if len(out) >= max_lines:
            break
    return "\n".join(out)


def classify_text(text: str) -> str | None:
    """按卷面首屏判。只看强特征，宁可不判也不猜（判错会把卷子写进教材表）。"""
    head = _head(text)
    if not head:
        return None
    # 卷首「答题卡/试卷」、或「满分…＋考试时间/分钟」——教材单页不会出现
    if any(m in head for m in _PAPER_MARKERS):
        return PAPER
    if "满分" in head and ("考试时间" in head or "分钟" in head):
        return PAPER
    if "本试卷共" in head:
        return PAPER
    if any(m in head for m in _ANSWER_MARKERS):
        return ANSWER
    return None


def looks_like_book(md_path: Path) -> bool:
    """同目录有 page_*.md 兄弟 → 这是一本书的某一页（教材），不是整卷。"""
    try:
        parent = Path(md_path).parent
        return any(parent.glob("page_*.md"))
    except OSError:
        return False


class KindCache:
    """判定结果落盘：同一条命令里 extract/publish/db_loader 共用，重跑不再问。"""

    def __init__(self, path: Path):
        self.path = Path(path)
        self._data: dict[str, str] | None = None

    def _load(self) -> dict[str, str]:
        if self._data is not None:
            return self._data
        try:
            self._data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            self._data = {}
        return self._data

    def get(self, key: str) -> str | None:
        value = self._load().get(key)
        return value if value in KINDS else None

    def set(self, key: str, kind: str) -> None:
        if kind not in KINDS:
            raise ValueError(f"非法素材类型：{kind!r}")
        data = self._load()
        if data.get(key) == kind:
            return
        data[key] = kind
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )


def _ask_user(name: str, evidence: str = "") -> str:
    """交互选择。只接受 1/2/3，回车也重问——类型判错会把数据写进错的表。"""
    if not sys.stdin.isatty():
        raise MaterialKindUnknown(name)
    print(f"\n[?] 无法自动判断这份素材是什么：{name}", flush=True)
    if evidence:
        print(f"    卷面首屏：{evidence}", flush=True)
    print("    1 = 试卷（切题入库）  2 = 答案（并入配对试卷）  3 = 教材（按页挂章节）",
          flush=True)
    while True:
        print("    请输入 1/2/3 › ", end="", flush=True)
        ans = (sys.stdin.readline() or "").strip()
        if ans in ("1", PAPER):
            return PAPER
        if ans in ("2", ANSWER):
            return ANSWER
        if ans in ("3", TEXTBOOK):
            return TEXTBOOK
        print("    只能输 1、2、3", flush=True)


def resolve(key: str, name: str, md_path: Path | None = None,
            cache: KindCache | None = None, allow_ask: bool = True) -> str:
    """返回 paper / answer / textbook；判不出且不能问时抛 MaterialKindUnknown。

    `key` 是缓存键（用 md 相对路径，稳定且可读），`name` 是文件名（判名称）。
    """
    kind = classify_name(name)
    if kind:
        return kind

    if cache is not None:
        cached = cache.get(key)
        if cached:
            return cached

    text = ""
    if md_path is not None:
        try:
            text = Path(md_path).read_text(encoding="utf-8")
        except OSError:
            text = ""
    kind = classify_text(text)
    if kind:
        if cache is not None:
            cache.set(key, kind)
        return kind

    if md_path is not None and looks_like_book(md_path):
        if cache is not None:
            cache.set(key, TEXTBOOK)
        return TEXTBOOK

    if not allow_ask:
        raise MaterialKindUnknown(name)
    kind = _ask_user(name, _head(text, 6).replace("\n", " | "))
    if cache is not None:
        cache.set(key, kind)
    return kind


def kind_of_jsonl(path: Path) -> str | None:
    """按 JSONL 里第一条记录的**形状**判类型（发布/入库用）。

    到这里数据已经被切好了，形状比文件名可信：`card_type` 是教材卡，
    `group_order`/`options` 是试卷题。文件名只作兜底。
    """
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                if "card_type" in row:
                    return TEXTBOOK
                if any(k in row for k in ("group_order", "options", "material_text")):
                    return PAPER
                return None
    except (OSError, json.JSONDecodeError):
        return None
    return None


def scope_kind(path_or_name, md_path: Path | None = None, cache: KindCache | None = None,
               allow_ask: bool = False) -> str:
    """-> "questions" / "cards"。形状优先，再名称/内容/结构。"""
    path = Path(path_or_name)
    kind = kind_of_jsonl(path)
    if kind is None:
        kind = resolve(str(path), path.name, md_path=md_path, cache=cache, allow_ask=allow_ask)
    return SCOPE_KIND[kind]
