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
        """双模型确认新增 KP（AND 逻辑，无人审核）。

        - 主模型已标 suggested_new_kps（label 阶段）
        - 对每个建议新增的 KP，调 fallback_labeler 确认
        - 两个模型都认为 is_new=true → 填入 _confirmed_new_kps
        - 兜底模型找到已有匹配 → 用 matched_existing_code 替换，加入 knowledge_points
        - 任一认为不新增 → 不新增

        无 fallback_labeler 时跳过（_confirmed_new_kps 保持空）。
        """
        if not self._fallback:
            return labeled

        # 收集所有 suggested_new_kps（去重）
        all_suggested: list[str] = []
        for q in labeled:
            all_suggested.extend(q.suggested_new_kps or [])
        all_suggested = list(set(all_suggested))
        if not all_suggested:
            return labeled

        # 对每个调 fallback 确认
        confirm_results: dict[str, dict] = {}
        for kp_name in all_suggested:
            confirm_results[kp_name] = self._ask_fallback_is_new(kp_name)

        # 回填到每题
        for q in labeled:
            for kp_name in (q.suggested_new_kps or []):
                result = confirm_results.get(kp_name, {})
                if result.get("is_new"):
                    q._confirmed_new_kps.append({"name": kp_name, "code": None})
                else:
                    # 不新增：若 fallback 找到已有匹配，加入 knowledge_points
                    matched = result.get("matched_existing_code")
                    if matched and matched not in (q.knowledge_points or []):
                        q.knowledge_points.append(matched)
                    q._suggested_new_kps.append({"name": kp_name, "status": "rejected"})
        return labeled

    def _ask_fallback_is_new(self, kp_name: str) -> dict:
        """调 fallback 模型确认一个 KP 是否为新增。"""
        prompt = (
            f"判断以下知识点是否在已有列表中。知识点名称：{kp_name}\n"
            f"已有知识点列表：\n{self._kps_text}\n\n"
            f"输出 JSON：{{\"is_new\": bool, \"matched_existing_code\": \"M01xx\" 或 null}}"
        )
        try:
            resp = self._fallback._llm.complete(self._prompt, prompt)
            data = _parse_json_object(resp.content)
            return {
                "is_new": bool(data.get("is_new", False)),
                "matched_existing_code": data.get("matched_existing_code"),
            }
        except Exception:
            return {"is_new": False, "matched_existing_code": None}
