"""二维码图片判定与剔除（qr_detect）测试。

fixture ``qr_weixin.jpg`` 是从真实语料取的一张公众号二维码小图（137×137）。
"""

import json
from pathlib import Path
from types import SimpleNamespace

from PIL import Image, ImageDraw

import question_extract
from qr_detect import is_qr_code, strip_qr_images

FIXTURES = Path(__file__).parent / "fixtures"
QR_FIXTURE = FIXTURES / "qr_weixin.jpg"


def _write_real_figure(path: Path) -> None:
    """真实几何配图（圆 + 直径），不会被误判为二维码。"""
    img = Image.new("RGB", (300, 200), "white")
    draw = ImageDraw.Draw(img)
    draw.ellipse([20, 20, 180, 180], outline="black", width=3)
    draw.line([20, 100, 180, 100], fill="black", width=2)
    img.save(path)


# ---------- is_qr_code ----------


def test_is_qr_code_true_for_corpus_qr():
    assert is_qr_code(QR_FIXTURE) is True


def test_is_qr_code_false_for_qr_in_large_figure(tmp_path):
    """护栏用例：真实配图角落恰好有一个二维码 → 保留整张图，不判为二维码。"""
    canvas = Image.new("RGB", (900, 700), "white")
    qr = Image.open(QR_FIXTURE).resize((120, 120))
    canvas.paste(qr, (740, 40))
    path = tmp_path / "figure_with_corner_qr.jpg"
    canvas.save(path, quality=90)

    assert is_qr_code(path) is False


def test_is_qr_code_false_for_geometry_figure(tmp_path):
    path = tmp_path / "circle.jpg"
    _write_real_figure(path)
    assert is_qr_code(path) is False


def test_is_qr_code_false_for_missing_file(tmp_path):
    assert is_qr_code(tmp_path / "nope.jpg") is False


def test_is_qr_code_false_for_non_image_bytes(tmp_path):
    path = tmp_path / "fake.jpg"
    path.write_bytes(b"fake")
    assert is_qr_code(path) is False


# ---------- strip_qr_images ----------


def _paper_dir(tmp_path: Path) -> Path:
    images = tmp_path / "images"
    images.mkdir()
    (images / "qr.jpg").write_bytes(QR_FIXTURE.read_bytes())
    _write_real_figure(images / "real_fig.jpg")
    return tmp_path


def test_strip_qr_images_removes_standalone_line(tmp_path):
    md_dir = _paper_dir(tmp_path)
    text = "题干文字\n![](images/real_fig.jpg)\n![](images/qr.jpg)\n(A) 甲"
    out = strip_qr_images(text, md_dir)

    assert "images/qr.jpg" not in out
    assert "images/real_fig.jpg" in out  # 真实配图保留
    assert "题干文字" in out and "(A) 甲" in out
    assert "\n\n" not in out  # 空行一并清理


def test_strip_qr_images_keeps_text_on_same_line(tmp_path):
    """行内还有正文时只摘掉引用本身，不整行删（绝不丢题干文字）。"""
    md_dir = _paper_dir(tmp_path)
    out = strip_qr_images("下列抽样方式：![](images/qr.jpg) 最合适的是", md_dir)

    assert "images/qr.jpg" not in out
    assert out == "下列抽样方式： 最合适的是"


def test_strip_qr_images_removes_all_occurrences_and_alt_variants(tmp_path):
    md_dir = _paper_dir(tmp_path)
    text = "![](images/qr.jpg)\n![二维码](images/qr.jpg)\n![](images/real_fig.jpg)"
    out = strip_qr_images(text, md_dir)

    assert "qr.jpg" not in out
    assert "images/real_fig.jpg" in out


def test_strip_qr_images_keeps_missing_source(tmp_path):
    """源文件缺失的引用保留（与 image_rewrite 的语义一致）。"""
    md_dir = _paper_dir(tmp_path)
    text = "![](images/gone.jpg)"
    assert strip_qr_images(text, md_dir) == text


def test_strip_qr_images_no_hit_returns_unchanged(tmp_path):
    """无命中时原样返回（不做 strip 改写，保证幂等）。"""
    md_dir = _paper_dir(tmp_path)
    text = "  题干\n\n![](images/real_fig.jpg)\n"
    assert strip_qr_images(text, md_dir) == text


def test_strip_qr_images_is_idempotent(tmp_path):
    md_dir = _paper_dir(tmp_path)
    once = strip_qr_images("题干\n![](images/qr.jpg)", md_dir)
    assert strip_qr_images(once, md_dir) == once


def test_strip_qr_images_handles_empty_text(tmp_path):
    assert strip_qr_images("", tmp_path) == ""


# ---------- 集成：extract 切题链路 ----------

# 复刻真实语料「西城 2025 模拟二 题4」排版：题干 → 真实配图 → 四个行内选项
# → 二维码独占一行。二维码原先会被切题逻辑当成题干配图。
_PAPER_MD = """一、选择题

1. 求 $1+1$ 的值是 (A) 1 (B) 2 (C) 3 (D) 4

2. 为了解某校 1500 名学生每天在校参加体育锻炼的情况，下列抽样调查方式中最合适的是

![](images/real_fig.jpg)

(A) 随机抽取某个班的全体学生

(B) 每个年级各推荐 20 名学生

(C) 上体育课时, 在操场上随机抽取 25 名学生

(D) 将全校的学生名字输入电脑程序，在电脑中随机抽取 100 名学生

![](images/qr.jpg)
"""


def _fake_response(content: str):
    return type("R", (), {"content": content})()


def _fake_llm():
    class FakeLLM:
        def complete(self, system, user):
            return _fake_response(
                '{"type":"choice","difficulty":2,'
                '"knowledge_points":["M0101"],"suggested_new_kps":[],'
                '"completeness":{"is_complete":true,"issues":[]}}'
            )

    return FakeLLM()


def test_extract_questions_file_drops_qr_image(tmp_path, monkeypatch):
    """回归：二维码不再进入题目 content/options，真实配图保留。"""
    md_dir = _paper_dir(tmp_path)
    md_path = md_dir / "数学-初三(下)-202507-西城-模拟二-试卷.md"
    md_path.write_text(_PAPER_MD, encoding="utf-8")

    # 绕过 DB 查 KP（本用例不测知识点）
    monkeypatch.setattr(
        question_extract, "_query_knowledge_points",
        lambda config, subject_code: [{"code": "M0101", "name": "有理数的概念与分类"}],
    )

    source = SimpleNamespace(
        md_path=md_path,
        rel_path=Path("数学/初中/second/2025"),
        kind="questions",
    )
    count = question_extract.extract_questions_file(
        source, SimpleNamespace(), _fake_llm(), None, tmp_path / "extracted",
        label_batch_size=1,
    )
    assert count == 2

    items = [
        json.loads(line)
        for line in (tmp_path / "extracted" / "数学/初中/second/2025" / f"{md_path.name[:-3]}.jsonl")
        .read_text(encoding="utf-8")
        .splitlines()
        if line.strip()
    ]
    q2 = next(i for i in items if i["group_order"] == 2)

    assert "qr.jpg" not in q2["content"]
    assert "images/real_fig.jpg" in q2["content"]  # 真实配图未被误删
    assert all("qr.jpg" not in (o.get("text") or "") for o in (q2["options"] or []))
    assert [o["text"] for o in q2["options"]] == [
        "随机抽取某个班的全体学生",
        "每个年级各推荐 20 名学生",
        "上体育课时, 在操场上随机抽取 25 名学生",
        "将全校的学生名字输入电脑程序，在电脑中随机抽取 100 名学生",
    ]
