"""meaning_backfill_cli 的回归钉子。

- `slice_by_doc_boundaries` 的**字面一律取自 body**——`''.join(结果) == body`
  必须构造上成立（文档与库的半角/全角引号差异由它吸收）；
- 只写两列、只碰 `sentences IS NULL` 的行（SQL 里绝不出现人工标定列）；
- 行为（用假连接，不碰真库）：`--dry-run` 不写库不调模型；一篇要么整篇写、
  要么一行都不写（切片失败 / 不变式失败 / 译文失败三种都算）；写库带并发守卫；
  `--limit` 的清单不与全量清单同名；没有目标行时退出码 0。
"""

from types import SimpleNamespace

import pytest

import src.meaning_backfill_cli as mb
from src.interpretation_translate import TranslateResult
from src.meaning_backfill_cli import (
    _FETCH_SQL,
    _UPDATE_SENTENCES_SQL,
    _review_path,
    slice_by_doc_boundaries,
)

#: 一篇一句的最小文档；body 与之逐字相同，切片必成功
DOC_ONE = ("## 月夜忆舍弟（唐·杜甫）\n\n### 戍鼓断人行，边秋一雁声。\n"
           "#### 深层含义\n含义A。\n#### 情感\n情感A。\n")
BODY_ONE = "戍鼓断人行，边秋一雁声。"


# ==================== 假连接（只记 SQL，不连库） ====================


class _FakeCursor:
    def __init__(self, rows, rowcount=1):
        self._rows = rows
        self.rowcount = rowcount
        self.executed = []

    def execute(self, sql, args=None):
        self.executed.append((sql, args))

    def fetchall(self):
        return self._rows

    def fetchone(self):
        return (len(self._rows),)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class _FakeConn:
    """`_fetch_targets` / `_count_untouched` / `_write_items` 共用它。"""

    def __init__(self, rows, rowcount=1):
        self.cur = _FakeCursor(rows, rowcount=rowcount)
        self.committed = 0

    def cursor(self):
        return self.cur

    def commit(self):
        self.committed += 1

    def close(self):
        pass


def _args(tmp_path, *, dry_run, name="诗深层含义.md", limit=None):
    return SimpleNamespace(input=str(tmp_path / name), output_dir=str(tmp_path / "out"),
                           limit=limit, dry_run=dry_run, apply=not dry_run)


def _config(tmp_path):
    return SimpleNamespace(output_dir=tmp_path / "out")


def _updates(conn):
    return [(s, a) for s, a in conn.cur.executed if s.startswith("UPDATE")]


def _review(tmp_path, stem="诗深层含义-backfill") -> str:
    return (tmp_path / "out" / "语文" / f"{stem}-review.md").read_text(encoding="utf-8")


def _use(monkeypatch, tmp_path, doc, rows, rowcount=1):
    (tmp_path / "诗深层含义.md").write_text(doc, encoding="utf-8")
    conn = _FakeConn(rows, rowcount=rowcount)
    monkeypatch.setattr(mb, "_connect", lambda config: conn)
    return conn


def _fake_translate(monkeypatch, result):
    """把译文环节整个换掉：不建模型、不读 prompt、不碰网络。"""
    monkeypatch.setattr(mb, "_build_llms", lambda config: (object(), None))
    monkeypatch.setattr(mb, "_load_prompt", lambda name: "prompt")
    monkeypatch.setattr(mb, "translate_passage", lambda *a, **k: result)


# ==================== 切片核心 ====================


def test_按文档边界从_body_切片_拼接回原文():
    body = "云横秦岭家何在？雪拥蓝关马不前。知汝远来应有意，好收吾骨瘴江边。"
    doc = ["云横秦岭家何在？雪拥蓝关马不前。", "知汝远来应有意，好收吾骨瘴江边。"]
    got = slice_by_doc_boundaries(body, doc)
    assert got == doc
    assert "".join(got) == body


def test_正文里的引号与文档不一致时也切得对():
    # 库里是全角引号，用户文档被转成了半角——字面必须取自 body
    body = "欲说还休，却道“天凉好个秋”！"
    doc = ['欲说还休，却道"天凉好个秋"！']
    got = slice_by_doc_boundaries(body, doc)
    assert got == [body]          # 拿到的是库里的全角版本
    assert "".join(got) == body


def test_正文含换行与空白时仍能拼回():
    body = "戍鼓断人行，\n边秋一雁声。\n露从今夜白，月是故乡明。"
    doc = ["戍鼓断人行，边秋一雁声。", "露从今夜白，月是故乡明。"]
    got = slice_by_doc_boundaries(body, doc)
    assert "".join(got) == body


def test_切分对不上就抛错_绝不猜():
    body = "床前明月光，疑是地上霜。"
    doc = ["床前明月光，", "疑是地上霜。", "举头望明月。"]   # 多了一句库里没有的
    with pytest.raises(ValueError):
        slice_by_doc_boundaries(body, doc)


def test_句数相同但字面不同也要抛错_不能当成通假():
    body = "床前明月光，疑是地上霜。"
    doc = ["床前明月光，", "疑是地上雪。"]        # 一字之差，长度相同
    with pytest.raises(ValueError):
        slice_by_doc_boundaries(body, doc)


def test_空句直接抛错():
    with pytest.raises(ValueError):
        slice_by_doc_boundaries("床前明月光。", ["床前明月光。", "  "])


def test_切片比对复用_meaning_cli_的归一_两个模块判据一致():
    # 归一表只此一份（在 meaning_cli）：backfill 不自己留表，判据与含义导入完全一致
    import src.meaning_cli as cli

    assert not hasattr(mb, "_QUOTE_FOLD") and not hasattr(mb, "_sig")
    assert hasattr(cli, "_QUOTE_FOLD")
    for s in ("“甲”", "「乙」", "『丙』", "‘丁’", '"戊"', "'己'", " 庚\n辛 "):
        assert mb._norm(s) == cli._norm(s)


# ==================== 两条硬约束的钉子 ====================


def test_更新语句只写_sentences_与_full_translation_两列():
    """`key_terms` 归解释专项在用、`verified`/`is_active`/`memorize_required` 是人工标定，
    管线重跑绝不能刷掉——照 meaning_cli / interpretation_loader 的规矩。"""
    assert "sentences" in _UPDATE_SENTENCES_SQL
    assert "full_translation" in _UPDATE_SENTENCES_SQL
    for forbidden in ("key_terms", "verified", "is_active", "memorize_required"):
        assert forbidden not in _UPDATE_SENTENCES_SQL


def test_只取_sentences_为_null_的行_已有句读的一律不动():
    """已有 `sentences` 的 15 首是按别的口径切的（解释管线切的），必须完全不动。"""
    assert "sentences IS NULL" in _FETCH_SQL


def test_更新语句带_sentences_IS_NULL_并发守卫():
    """取数到写库之间隔着几分钟的译文生成，别的管线可能已改过这行——
    没有守卫就会拿旧切片盖掉新数据，正是文件开头警告的 sentenceIndex 错位。"""
    assert _UPDATE_SENTENCES_SQL.rstrip().endswith("AND sentences IS NULL")


# ==================== 行为：dry-run / 全有全无 / 并发守卫 ====================


def test_dry_run_不写库也不调模型(tmp_path, monkeypatch):
    conn = _use(monkeypatch, tmp_path, DOC_ONE, [(34, "上册", "月夜忆舍弟", BODY_ONE)])

    def boom(*a, **k):
        raise AssertionError("--dry-run 不该调模型")

    monkeypatch.setattr(mb, "_build_llms", boom)
    monkeypatch.setattr(mb, "translate_passage", boom)

    assert mb.run(_args(tmp_path, dry_run=True), _config(tmp_path)) == 0
    assert _updates(conn) == []                  # 一条 UPDATE 都没发
    review = _review(tmp_path)
    assert "月夜忆舍弟" in review and "dry-run" in review


def test_切片失败时该篇零行写入(tmp_path, monkeypatch):
    # 文档与 body 一字之差 → 切片抛错 → 整篇不写（旁边那篇照写）
    doc = ("## 月夜忆舍弟（唐·杜甫）\n\n### 床前明月光，疑是地上霜。\n"
           "#### 深层含义\n含义A。\n#### 情感\n情感A。\n\n"
           "## 长沙过贾谊宅（唐·刘长卿）\n\n### 戍鼓断人行，边秋一雁声。\n"
           "#### 深层含义\n含义B。\n#### 情感\n情感B。\n")
    conn = _use(monkeypatch, tmp_path, doc, [
        (34, "上册", "月夜忆舍弟", "床前明月光，疑是地上雪。"),   # 对不上
        (35, "上册", "长沙过贾谊宅", BODY_ONE),                 # 对得上
    ])
    _fake_translate(monkeypatch, TranslateResult(
        translations=["译"], full_translation="全", source="local:x"))

    assert mb.run(_args(tmp_path, dry_run=False), _config(tmp_path)) == 1
    updates = _updates(conn)
    assert len(updates) == 1 and updates[0][1][2] == 35      # 只有能切的那篇被写
    review = _review(tmp_path)
    assert "月夜忆舍弟" in review and "切片失败" in review


def test_不变式校验失败时该篇零行写入(tmp_path, monkeypatch):
    # 切片函数被换坏（返回拼不回 body 的句子）→ check_passage 拦下 → 一行都不写
    conn = _use(monkeypatch, tmp_path, DOC_ONE, [(34, "上册", "月夜忆舍弟", BODY_ONE)])
    monkeypatch.setattr(mb, "slice_by_doc_boundaries", lambda body, doc: ["甲。"])
    _fake_translate(monkeypatch, TranslateResult(
        translations=["译"], full_translation="全", source="local:x"))

    assert mb.run(_args(tmp_path, dry_run=False), _config(tmp_path)) == 1
    assert _updates(conn) == []
    assert "拼不回正文" in _review(tmp_path)


def test_译文失败时该篇零行写入_不是只留空串(tmp_path, monkeypatch):
    """fail-closed：空 translation 在解释专项里是**标准答案**，会让学生被误判；
    所以译文拿不到时连 sentences 都不写（该篇不进抽题池），并在清单与退出码上体现。"""
    conn = _use(monkeypatch, tmp_path, DOC_ONE, [(34, "上册", "月夜忆舍弟", BODY_ONE)])
    _fake_translate(monkeypatch, TranslateResult(
        translations=None, error="所有模型均未给出合规译文",
        attempts=["local 输出不合规：translations 条数 0 != 句数 1"]))

    assert mb.run(_args(tmp_path, dry_run=False), _config(tmp_path)) == 1
    assert _updates(conn) == []                  # sentences 一个字都没写
    review = _review(tmp_path)
    assert "译文失败" in review and "整篇未写" in review
    assert "《月夜忆舍弟》(id=34)" in review
    assert "所有模型均未给出合规译文" in review


def test_译文失败在_stdout_里点名篇名与原因(tmp_path, monkeypatch, capsys):
    _use(monkeypatch, tmp_path, DOC_ONE, [(34, "上册", "月夜忆舍弟", BODY_ONE)])
    _fake_translate(monkeypatch, TranslateResult(
        translations=None, error="所有模型均未给出合规译文", attempts=["local 超时"]))

    mb.run(_args(tmp_path, dry_run=False), _config(tmp_path))
    out = capsys.readouterr().out
    assert "译文生成失败" in out
    assert "《月夜忆舍弟》(id=34)" in out
    assert "所有模型均未给出合规译文" in out


def test_写库守卫命中时报未生效而不是声称成功(tmp_path, monkeypatch):
    """并发守卫：UPDATE 影响行数 ≠ 1（该行 sentences 已被别的管线写过）→ 报告 + 退出码 1。"""
    conn = _use(monkeypatch, tmp_path, DOC_ONE,
                [(34, "上册", "月夜忆舍弟", BODY_ONE)], rowcount=0)
    _fake_translate(monkeypatch, TranslateResult(
        translations=["译"], full_translation="全", source="local:x"))

    assert mb.run(_args(tmp_path, dry_run=False), _config(tmp_path)) == 1
    assert len(_updates(conn)) == 1              # 发了，但没生效
    review = _review(tmp_path)
    assert "写入未生效" in review and "id=34" in review


def test_没有目标行时退出码_0_不是失败(tmp_path, monkeypatch):
    """重跑一次成功的导入会取到 0 行；自动化要能区分「无事可做」与「失败」。"""
    conn = _use(monkeypatch, tmp_path, DOC_ONE, [])
    assert mb.run(_args(tmp_path, dry_run=False), _config(tmp_path)) == 0
    assert _updates(conn) == []
    assert "无事可做" in _review(tmp_path)


def test_limit_的清单不与全量清单同名(tmp_path, monkeypatch):
    """局部跑不能覆盖全量跑的清单——译文失败只记在那份清单里。"""
    _use(monkeypatch, tmp_path, DOC_ONE, [(34, "上册", "月夜忆舍弟", BODY_ONE)])
    mb.run(_args(tmp_path, dry_run=True, limit=1), _config(tmp_path))
    mb.run(_args(tmp_path, dry_run=True), _config(tmp_path))

    out = tmp_path / "out" / "语文"
    assert (out / "诗深层含义-backfill-limit1-review.md").exists()
    assert (out / "诗深层含义-backfill-review.md").exists()
    a = _args(tmp_path, dry_run=True, limit=2)
    assert _review_path(a, _config(tmp_path)).name == "诗深层含义-backfill-limit2-review.md"
    assert _review_path(_args(tmp_path, dry_run=True), _config(tmp_path)).name \
        != "诗深层含义-review.md"          # meaning_cli 的清单名，不能被撞掉

