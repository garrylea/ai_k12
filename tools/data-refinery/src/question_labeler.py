"""试卷题 LLM 标注器：标 type/difficulty/知识点 + 双模型确认新增 KP。

LLM 只标注元数据，不改 content、不给答案（answer 由 question_splitter 按题号对齐）。
知识点列表由调用方从 DB 查询后注入（动态读取，不写死在 prompt 文件）。
"""

from extract import _parse_json_object  # 复用 JSON 解析逻辑
from question_splitter import RawQuestion
from dataclasses import dataclass


@dataclass
class LabeledQuestion:
    """标注后的题（RawQuestion 字段 + LLM 标注）。"""
    group_order: int
    group_id: str | None
    content: str
    answer: str
    explanation: str | None
    type: str = ""                       # choice/fill_blank/true_false/short_answer/proof
    difficulty: int = 2                  # 1-5，默认 2
    knowledge_points: list = None       # 已有 KP code 列表
    suggested_new_kps: list = None      # 建议新增的 KP 名称
    _confirmed_new_kps: list = None     # 双模型确认的新增 KP（Task 6 填）
    _suggested_new_kps: list = None     # 未通过双模型确认的（Task 6 填）

    @classmethod
    def from_raw(cls, q: "RawQuestion") -> "LabeledQuestion":
        return cls(
            group_order=q.group_order,
            group_id=q.group_id,
            content=q.content,
            answer=q.answer,
            explanation=q.explanation,
            knowledge_points=[],
            suggested_new_kps=[],
            _confirmed_new_kps=[],
            _suggested_new_kps=[],
        )


def _format_kp_list(kps: list[dict]) -> str:
    """格式化 KP 列表为 prompt 文本（每行 code + name）。"""
    return "\n".join(f"- {kp['code']} {kp['name']}" for kp in kps)


class QuestionLabeler:
    """LLM 标注器。

    Args:
        llm: LLMClient（complete(system, user) -> response.content）
        prompt: prompt 模板（含 {{knowledge_points}} / {{question}} 占位符）
        knowledge_points: 已有 KP 列表（[{"code","name"}, ...]），由调用方从 DB 查
        fallback_labeler: 兜底模型（用于双模型确认新增 KP，Task 6）
    """

    def __init__(self, llm, prompt: str, knowledge_points: list[dict],
                 fallback_labeler: "QuestionLabeler | None" = None):
        self._llm = llm
        self._prompt = prompt
        self._kps = knowledge_points
        self._kps_text = _format_kp_list(knowledge_points)
        self._fallback = fallback_labeler

    def label(self, questions: list, batch_size: int = 1) -> list:
        """标注题列表。batch_size=1 每题单独调，0 全部一次，N 每 N 题一批。"""
        if batch_size == 0:
            return self._label_batch(questions)
        result: list = []
        for i in range(0, len(questions), batch_size):
            batch = questions[i:i + batch_size]
            result.extend(self._label_batch(batch))
        return result

    def _label_batch(self, batch: list) -> list:
        """标注一批题（单题或多题）。"""
        if len(batch) == 1:
            return [self._label_one(batch[0])]
        # 多题一次：prompt 里列多题，LLM 返回 {"items": [...]}
        multi_prompt = self._build_multi_prompt(batch)
        try:
            resp = self._llm.complete(self._prompt, multi_prompt)
            data = _parse_json_object(resp.content)
            items = data.get("items", [])
        except Exception:
            items = []
        result = []
        for i, q in enumerate(batch):
            labeled = LabeledQuestion.from_raw(q)
            if i < len(items):
                self._fill_from_item(labeled, items[i])
            result.append(labeled)
        return result

    def _label_one(self, q) -> "LabeledQuestion":
        labeled = LabeledQuestion.from_raw(q)
        user = self._build_single_prompt(q.content)
        try:
            resp = self._llm.complete(self._prompt, user)
            data = _parse_json_object(resp.content)
            # 单题 LLM 可能直接返回 {...} 或 {"items":[{...}]}
            item = data.get("items", [{}])[0] if "items" in data else data
            self._fill_from_item(labeled, item)
        except Exception:
            pass  # type=""、knowledge_points=[]，由 from_raw 默认值兜底
        return labeled

    def _build_single_prompt(self, question_content: str) -> str:
        return self._prompt.replace("{{knowledge_points}}", self._kps_text) \
                            .replace("{{question}}", question_content)

    def _build_multi_prompt(self, batch: list) -> str:
        q_text = "\n\n".join(f"## 题 {q.group_order}\n{q.content}" for q in batch)
        return self._build_single_prompt(q_text)

    def _fill_from_item(self, labeled, item: dict):
        """从 LLM 输出 item 填充 labeled 字段。"""
        labeled.type = str(item.get("type", "") or "")
        try:
            labeled.difficulty = int(item.get("difficulty", 2) or 2)
            if not 1 <= labeled.difficulty <= 5:
                labeled.difficulty = 2
        except (TypeError, ValueError):
            labeled.difficulty = 2
        labeled.knowledge_points = list(item.get("knowledge_points", []) or [])
        labeled.suggested_new_kps = list(item.get("suggested_new_kps", []) or [])

    def confirm_new_kps(self, labeled: list) -> list:
        """双模型确认新增 KP（Task 6 实现，本任务 stub 返回原样）。"""
        return labeled
