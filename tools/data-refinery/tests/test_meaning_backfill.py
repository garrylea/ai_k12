"""meaning_backfill_cli 的回归钉子。

核心一条：``slice_by_doc_boundaries`` 的**字面一律取自 body**——
``''.join(结果) == body`` 必须构造上成立（文档与库的半角/全角引号差异由它吸收）。
"""

from types import SimpleNamespace

import pytest

from src.meaning_backfill_cli import (
    _FETCH_SQL,
    _UPDATE_SENTENCES_SQL,
    render_review,
    slice_by_doc_boundaries,
)


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


def test_译文失败不阻断切片_但在过目清单里点名():
    """译文失败只留空串，不影响 `sentences` 写入；人要在清单里一眼看见是哪一篇。"""
    args = SimpleNamespace(dry_run=False, input="/tmp/诗深层含义.md")
    items = [{
        "row_id": 50, "semester": "上册", "work_title": "丑奴儿·书博山道中壁",
        "sentences": [{"text": "少年不识愁滋味，爱上层楼。", "translation": ""}],
        "full_translation": "", "translation_source": None,
        "translation_error": "所有模型均未给出合规译文",
    }]
    md = render_review(args, items, [], [], n_doc_titles=1, n_targets=1, n_untouched=0)
    assert "《丑奴儿·书博山道中壁》" in md
    assert "id=50" in md
    assert "译文失败" in md
    assert "少年不识愁滋味，爱上层楼。" in md      # 句子照样在清单里（sentences 已写）
