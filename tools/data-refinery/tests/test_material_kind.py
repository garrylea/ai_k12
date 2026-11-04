"""素材类型判定：名称 → 卷面 → 结构 → 问用户（2026-11-03）。

事故背景：手工丢进 crawler/data 的卷子名字不带「试卷」，被静默当教材卡，
最后在 db_loader 崩掉、题库 0 条。这里钉住三层兜底与「判不出要问、不许猜也没
不许直接拒绝」的行为。
"""

import json

import pytest

from material_kind import (ANSWER, PAPER, TEXTBOOK, KindCache, MaterialKindUnknown,
                           classify_name, classify_path, classify_text, kind_of_jsonl,
                           looks_like_book, resolve)

PAPER_HEAD = """# 初三年级数学学科试卷

满分 100 分 考试时间 120 分钟

学校：____ 班级：____ 姓名：____
"""

ANSWER_HEAD = """# 初三年级数学学科参考答案

## 一、选择题
1. A  2. B
"""


# === 名称 ===

def test_classify_name():
    assert classify_name("数学-初三(上)-202507-海淀-（上）期中-试卷.pdf") == PAPER
    assert classify_name("数学-初三(上)-202507-海淀-（上）期中-答案.pdf") == ANSWER
    assert classify_name("2026北京北京中学初三（上）期中数学.pdf") is None


# === 内容 ===

def test_classify_text_paper_by_full_score_header():
    """卷首「满分 + 考试时间」是强特征：教材单页不会有。"""
    assert classify_text(PAPER_HEAD) == PAPER


def test_classify_text_paper_by_title_word():
    assert classify_text("# 昌平一中教育集团 2026-2027 学年期中联合质量检测\n\n# 初三 数学试卷\n") == PAPER


def test_classify_text_answer():
    assert classify_text(ANSWER_HEAD) == ANSWER


def test_classify_text_refuses_to_guess():
    """没有强特征就返回 None——判成教材会把卷子写进教材表。"""
    assert classify_text("一般地，如果三条线段中任意两条的和大于第三条线段…") is None


def test_classify_text_ignores_body_answer_section():
    """卷子里自带「参考答案」段（在后半），不能把整卷判成答案。"""
    text = PAPER_HEAD + "\n\n## 三、解答题\n\n1. 解：…\n\n# 初三年级数学学科参考答案\n\n1. A\n"
    assert classify_text(text) == PAPER


# === 结构 ===

def test_looks_like_book(tmp_path):
    book = tmp_path / "数学" / "初中" / "first" / "2026" / "某教材"
    book.mkdir(parents=True)
    page = book / "page_001.md"
    page.write_text("第一章", encoding="utf-8")
    assert looks_like_book(page)

    single = tmp_path / "数学" / "初中" / "first" / "2026" / "某卷"
    single.mkdir(parents=True)
    whole = single / "某卷.md"
    whole.write_text(PAPER_HEAD, encoding="utf-8")
    assert not looks_like_book(whole)


# === 目录段判据（2026-11-03）===
# 现有 534 试卷 + 824 教材页全部符合：试卷在 first/second 下，教材在 上册/下册 下，零交叉。
# looks_like_book 只对「同目录有 page_*.md 兄弟」有效，整卷 PDF 转出的单 md 没有兄弟，
# 靠目录段才能判出来（事故：汇文物理卷名字不带「试卷」、卷面没强特征，被问用户）。

def test_classify_path_paper_by_first_segment():
    """路径含 first/second 段 → 试卷（学期目录）。"""
    assert classify_path("物理/初中/first/2026/汇文卷/汇文卷.md") == PAPER
    assert classify_path("物理/初中/second/2025/期末卷.md") == PAPER


def test_classify_path_textbook_by_volume_segment():
    """路径含 上册/下册 段 → 教材（出版社目录）。"""
    assert classify_path("数学/初中/人教版/九年级/上册/page_018.md") == TEXTBOOK
    assert classify_path("语文/初中/统编版/七年级/下册/page_003.md") == TEXTBOOK


def test_classify_path_returns_none_when_no_signal():
    assert classify_path("随手一丢.md") is None
    assert classify_path("物理/初中/2026/卷.md") is None


def test_resolve_uses_path_segment_for_paper_without_strong_content(tmp_path):
    """事故复现：文件名不带「试卷」、卷面首屏没强特征词，但路径含 first → 直接判 PAPER，
    不再问用户。2026-11-03 汇文物理卷的精确场景。"""
    # 卷面是「单项选择题」起头，没有 满分/考试时间/本试卷共/试卷 等强特征
    weak_text = "2025 北京汇文中学初三（上）期中 | 物 理\n\n一、单项选择题\n1. 题干\n"
    md = tmp_path / "汇文卷.md"
    md.write_text(weak_text, encoding="utf-8")
    key = "物理/初中/first/2026/汇文卷/汇文卷.md"
    assert resolve(key, md.name, md) == PAPER


# === 三层兜底 ===

def test_resolve_prefers_name_without_touching_disk(tmp_path):
    missing = tmp_path / "不存在.md"
    assert resolve("k", "数学-初三(上)-202507-海淀-（上）期中-试卷.pdf", missing) == PAPER


def test_resolve_falls_back_to_content(tmp_path):
    """名字不规范（本次事故的原始文件名）→ 靠卷面认出来。"""
    md = tmp_path / "2026北京北京中学初三（上）期中数学.md"
    md.write_text(PAPER_HEAD, encoding="utf-8")
    assert resolve("k", md.name, md) == PAPER


def test_resolve_falls_back_to_structure(tmp_path):
    book = tmp_path / "数学" / "初中" / "first" / "2026" / "某教材"
    book.mkdir(parents=True)
    page = book / "page_018.md"
    page.write_text("归纳：由上可知…", encoding="utf-8")
    assert resolve("k", page.name, page) == TEXTBOOK


def test_resolve_raises_when_nothing_known_and_not_tty(tmp_path, monkeypatch):
    """判不出且不能问 → 明确报错，不静默当教材。"""
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)
    md = tmp_path / "随手一丢.pdf.md"
    md.write_text("看不懂的一段话", encoding="utf-8")
    with pytest.raises(MaterialKindUnknown):
        resolve("k", md.name, md)


def test_resolve_asks_and_remembers(tmp_path, monkeypatch):
    """交互选择要落盘：同一条命令的 9 个阶段只问一次。"""
    md = tmp_path / "随手一丢.pdf.md"
    md.write_text("看不懂的一段话", encoding="utf-8")
    cache = KindCache(tmp_path / ".material_kinds.json")

    import material_kind
    monkeypatch.setattr(material_kind, "_ask_user", lambda name, evidence="": PAPER)
    assert resolve("k", md.name, md, cache) == PAPER
    assert json.loads((tmp_path / ".material_kinds.json").read_text("utf-8"))["k"] == PAPER

    # 第二次不再问：把 _ask_user 换成会炸的，仍应返回缓存值
    monkeypatch.setattr(material_kind, "_ask_user",
                        lambda *a, **k: pytest.fail("不该再问一次"))
    assert resolve("k", md.name, md, cache) == PAPER


def test_cache_ignores_corrupt_file(tmp_path):
    path = tmp_path / ".material_kinds.json"
    path.write_text("{不是 json", encoding="utf-8")
    cache = KindCache(path)
    assert cache.get("k") is None
    cache.set("k", TEXTBOOK)
    assert cache.get("k") == TEXTBOOK


# === 发布/入库侧的形状判定 ===

def test_kind_of_jsonl_by_shape(tmp_path):
    card = tmp_path / "a.jsonl"
    card.write_text(json.dumps({"card_type": "practice", "content": "x"}, ensure_ascii=False) + "\n",
                    encoding="utf-8")
    assert kind_of_jsonl(card) == TEXTBOOK

    q = tmp_path / "b.jsonl"
    q.write_text(json.dumps({"group_order": 1, "content": "x"}, ensure_ascii=False) + "\n",
                 encoding="utf-8")
    assert kind_of_jsonl(q) == PAPER


def test_kind_of_jsonl_unknown_and_broken(tmp_path):
    weird = tmp_path / "c.jsonl"
    weird.write_text(json.dumps({"foo": 1}) + "\n", encoding="utf-8")
    assert kind_of_jsonl(weird) is None

    broken = tmp_path / "d.jsonl"
    broken.write_text("{坏行\n", encoding="utf-8")
    assert kind_of_jsonl(broken) is None
