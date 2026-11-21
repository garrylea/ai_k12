"""AI 修复题必须打 needs_review 标记（入库 is_active=0，不进抽题池）。"""

import json
from pathlib import Path
from types import SimpleNamespace

from llm import LLMResponse
from question_extract import _write_exam_questions_jsonl
from question_labeler import LabeledQuestion


def _source():
    return SimpleNamespace(rel_path=Path("语文/初中/first/2024/试卷"), md_path=Path("试卷.md"))


def test_repaired_question_gets_review_flag(tmp_path):
    normal = LabeledQuestion(
        group_order=1, group_id=None, content="题干\nA. 1\nB. 2\nC. 3\nD. 4",
        answer="A", explanation=None, type="choice",
    )
    repaired = LabeledQuestion(
        group_order=2, group_id=None, content="题干", answer="A", explanation=None, type="choice",
        is_complete=False,
        completeness_issues=["选项D缺失"],
        regenerated={"content": "题干", "options": [
            {"label": "A", "text": "1"}, {"label": "B", "text": "2"},
            {"label": "C", "text": "3"}, {"label": "D", "text": "编造"},
        ]},
    )
    _write_exam_questions_jsonl(
        [normal, repaired], _source(), tmp_path, "chinese", "junior", 2024,
    )
    out = tmp_path / "语文/初中/first/2024/试卷/试卷.jsonl"
    rows = [json.loads(line) for line in out.read_text(encoding="utf-8").splitlines()]
    assert rows[0]["needs_review"] is False
    assert rows[1]["needs_review"] is True


def test_normalize_choice_answer_maps_original_labels():
    from question_extract import _normalize_choice_answer

    opts = [
        {"label": "A", "text": "x", "original_label": "甲"},
        {"label": "B", "text": "y", "original_label": "乙"},
        {"label": "C", "text": "z", "original_label": "丙"},
    ]
    assert _normalize_choice_answer("乙", opts) == "B"
    assert _normalize_choice_answer("【丙】", opts) == "C"
    assert _normalize_choice_answer("B", opts) == "B"
    assert _normalize_choice_answer("", opts) == ""


def test_unrepaired_defect_keeps_python_options(tmp_path):
    """只报告不修复的题：内容与选项仍取自 Python 切分，不能被清空。"""
    from question_labeler import LabeledQuestion
    from question_splitter import RawQuestion

    raw = RawQuestion(group_order=3, group_id=None,
                      content="下列正确的一项是\nA.甲\nB.乙\nC.丙", answer="B")
    lab = LabeledQuestion.from_raw(raw)
    lab.type = "choice"
    lab.is_complete = False
    lab.completeness_issues = ["画线句无法定位"]
    lab.regenerated = None

    _write_exam_questions_jsonl([lab], _source(), tmp_path, "chinese", "junior", 2024)
    out = tmp_path / "语文/初中/first/2024/试卷/试卷.jsonl"
    row = json.loads(out.read_text(encoding="utf-8").splitlines()[0])

    assert [o["label"] for o in row["options"]] == ["A", "B", "C"]
    assert "下列正确的一项是" in row["content"]
    assert row["needs_review"] is True


def test_choice_without_options_is_flagged_for_review(tmp_path):
    """选择题但选项标记残缺（Python 拆不出选项）必须标待复核，
    否则没选项的选择题会进抽题池（东直门题5：`A. ① B ② C...` 缺 B 的点号）。"""
    from question_labeler import LabeledQuestion
    from question_splitter import RawQuestion

    raw = RawQuestion(group_order=5, group_id=None,
                      content="未使用修辞方法的一句是(2分)\nA. ① B ② C. ③ D. ④", answer="D")
    lab = LabeledQuestion.from_raw(raw)
    lab.type = "choice"
    lab.is_complete = True
    lab.knowledge_points = ["C0107"]

    _write_exam_questions_jsonl([lab], _source(), tmp_path, "chinese", "junior", 2024)
    out = tmp_path / "语文/初中/first/2024/试卷/试卷.jsonl"
    row = json.loads(out.read_text(encoding="utf-8").splitlines()[0])

    assert row["type"] == "choice"
    assert row["options"] is None
    assert row["needs_review"] is True
    assert row["knowledge_points"] == ["C0107"]   # 知识点不因选项残缺而丢


# --- 题后材料的 LLM 兜底：只在规则判不出归属时才调，且绝不写坏数据 ---

BASE_MATERIAL = "## （二）阅读《游山西村》\n陆游\n莫笑农家腊酒浑。"
POST_BLOCK = "## 行香子\n\n秦观\n树绕村庄，水满陂塘。\n注：①陂塘，池塘。"


class FakePostLLM:
    def __init__(self, content=None, error=None):
        self.content = content
        self.error = error
        self.calls = 0

    def complete(self, system, user):
        self.calls += 1
        if self.error:
            raise self.error
        return LLMResponse(self.content, 0, 0)


def _pending_questions():
    from question_extract import _resolve_post_material_llm  # noqa: F401
    q11 = SimpleNamespace(
        group_order=11, content="结合上述材料填写。", material_text=BASE_MATERIAL,
        post_material_base=BASE_MATERIAL, post_material_appended=None,
        post_material_pending=[],
    )
    q12 = SimpleNamespace(
        group_order=12, content="结合上述材料说说情感。", material_text=BASE_MATERIAL,
        post_material_base=BASE_MATERIAL, post_material_appended=None,
        post_material_pending=[{
            "block_id": 0, "block_text": POST_BLOCK, "block_line": 70,
            "candidate_orders": [11, 12], "section_key": "（二）阅读",
            "stems": {"11": "结合上述材料填写。", "12": "结合上述材料说说情感。"},
            "block_excerpt": POST_BLOCK[:200],
        }],
    )
    return [q11, q12]


def test_post_material_llm_decision_attaches_to_chosen_question_only(tmp_path):
    from question_extract import _resolve_post_material_llm

    llm = FakePostLLM('{"decisions":[{"block_id":0,"group_order":12}]}')
    questions = _pending_questions()
    assert _resolve_post_material_llm(llm, questions, "模拟二", tmp_path) == 1
    assert llm.calls == 1
    assert "行香子" in questions[1].material_text
    assert "行香子" not in questions[0].material_text
    assert "行香子" not in questions[1].post_material_base
    assert questions[1].post_material_pending == []
    assert not (tmp_path / "post_material_review.jsonl").exists()


def test_post_material_out_of_section_decision_rejected_and_logged(tmp_path):
    from question_extract import _resolve_post_material_llm

    llm = FakePostLLM('{"decisions":[{"block_id":0,"group_order":99}]}')
    questions = _pending_questions()
    assert _resolve_post_material_llm(llm, questions, "模拟二", tmp_path) == 0
    assert "行香子" not in questions[1].material_text
    rec = json.loads((tmp_path / "post_material_review.jsonl").read_text(encoding="utf-8").strip())
    assert rec["paper"] == "模拟二" and rec["reason"] == "invalid_decision"


def test_post_material_llm_failure_keeps_data_untouched(tmp_path):
    from question_extract import _resolve_post_material_llm

    llm = FakePostLLM(error=RuntimeError("no network"))
    questions = _pending_questions()
    assert _resolve_post_material_llm(llm, questions, "模拟二", tmp_path) == 0
    assert "行香子" not in questions[1].material_text
    assert "llm_error" in (tmp_path / "post_material_review.jsonl").read_text(encoding="utf-8")


def test_post_material_no_pending_never_calls_llm(tmp_path):
    from question_extract import _resolve_post_material_llm

    llm = FakePostLLM("{}")
    questions = _pending_questions()
    for q in questions:
        q.post_material_pending = []
    assert _resolve_post_material_llm(llm, questions, "模拟二", tmp_path) == 0
    assert llm.calls == 0


def test_extracted_jsonl_splits_article_and_post_material(tmp_path):
    """extracted 里共享文章仍写 material_text，题后材料另存 _post_material_text。"""
    from question_labeler import LabeledQuestion
    from question_splitter import RawQuestion

    raw = RawQuestion(
        group_order=12, group_id=None, content="结合本诗画线句与《行香子》下片的相关句子作答",
        answer="示例", material_text=BASE_MATERIAL + "\n\n" + POST_BLOCK,
        post_material_base=BASE_MATERIAL, post_material_appended=POST_BLOCK,
    )
    lab = LabeledQuestion.from_raw(raw)
    lab.post_material_base = BASE_MATERIAL
    lab.post_material_appended = POST_BLOCK
    _write_exam_questions_jsonl([lab], _source(), tmp_path, "chinese", "junior", 2025)
    out = tmp_path / "语文/初中/first/2024/试卷/试卷.jsonl"
    row = json.loads(out.read_text(encoding="utf-8").splitlines()[0])
    assert row["material_text"] == BASE_MATERIAL
    assert row["_post_material_text"] == POST_BLOCK
