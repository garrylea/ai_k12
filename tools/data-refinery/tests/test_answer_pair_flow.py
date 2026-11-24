from answer_merger import maybe_merge_answer_md
from question_splitter import split_page
from subject_strategies import get_strategy

PAPER = """一、单项选择题（共4分，每题2分）
1. 光在真空中的传播速度约为
A. 340m/s
B. 3×10^8m/s
C. 1500m/s
D. 3×10^5m/s
2. 下列现象属于光的折射的是
A. 水中倒影
B. 小孔成像
C. 筷子在水面处弯折
D. 影子
"""

ANSWER = """
# 参考答案
1. B
2. C
"""


def _run(tmp_path, answer_text=ANSWER):
    # 兄弟目录布局：试卷与答案各自成目录，验证 _derive_answer_path 能配对到答案
    d = tmp_path / "物理" / "初中" / "second" / "2026"
    (d / "X-试卷").mkdir(parents=True)
    (d / "X-答案").mkdir(parents=True)
    paper = d / "X-试卷" / "X-试卷.md"
    paper.write_text(PAPER, encoding="utf-8")
    (d / "X-答案" / "X-答案.md").write_text(answer_text, encoding="utf-8")
    text = maybe_merge_answer_md(paper, paper.read_text(encoding="utf-8"))
    return split_page(text, paper, strategy=get_strategy("physics"))


def test_merged_answer_reaches_each_question(tmp_path):
    qs = _run(tmp_path)
    assert [q.group_order for q in qs] == [1, 2]
    assert [q.answer for q in qs] == ["B", "C"]


def test_missing_answer_number_does_not_shift(tmp_path):
    qs = _run(tmp_path, answer_text="# 参考答案\n1. B\n")
    assert len(qs) == 2, f"应切出两题，实际 {len(qs)} 题"
    assert qs[0].answer == "B"
    assert qs[1].answer == ""


def test_answer_images_copied_to_paper_dir_without_overwrite(tmp_path, capsys):
    """case 4a 合并答案文本时，答案侧 images/xxx 图片要同步到试卷 images 目录；
    目标已存在则跳过、不覆盖（西城物理模拟一 paper 899 题 23 的回归）。"""
    d = tmp_path / "物理" / "初中" / "second" / "2026"
    paper_dir = d / "X-试卷"
    answer_dir = d / "X-答案"
    paper_dir.mkdir(parents=True)
    (answer_dir / "images").mkdir(parents=True)

    img_name = "b82b5ed7.jpg"
    src_img = answer_dir / "images" / img_name
    src_img.write_bytes(b"answer-image-content")
    answer_text = ANSWER + f"\n![](images/{img_name})\n"

    paper = paper_dir / "X-试卷.md"
    paper.write_text(PAPER, encoding="utf-8")
    (answer_dir / "X-答案.md").write_text(answer_text, encoding="utf-8")

    # 预置同名文件：已存在 → 跳过，不覆盖
    dst_img = paper_dir / "images" / img_name
    dst_img.parent.mkdir()
    dst_img.write_bytes(b"already-here")

    maybe_merge_answer_md(paper, paper.read_text(encoding="utf-8"))
    assert dst_img.read_bytes() == b"already-here"

    # 删掉预置文件后再跑：复制过来且内容一致
    dst_img.unlink()
    result = maybe_merge_answer_md(paper, paper.read_text(encoding="utf-8"))
    assert dst_img.read_bytes() == b"answer-image-content"
    assert f"images/{img_name}" in result
    assert "复制答案图片 1 张" in capsys.readouterr().out
