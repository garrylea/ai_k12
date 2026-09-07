"""试卷题 LLM 标注器：标 type/difficulty/知识点 + 双模型确认新增 KP。

LLM 只标注元数据，不改 content、不给答案（answer 由 question_splitter 按题号对齐）。
知识点列表由调用方从 DB 查询后注入（动态读取，不写死在 prompt 文件）。
"""

from extract import _parse_json_object  # 复用 JSON 解析逻辑
from question_splitter import RawQuestion, split_options
from dataclasses import dataclass

# 合法题型枚举（prompt 与 ExamQuestion 契约）
_VALID_TYPES = {"choice", "fill_blank", "true_false", "short_answer", "proof"}
# 选择题选项标签
_VALID_LABELS = {"A", "B", "C", "D"}


def _validate_item(item: dict, q: RawQuestion) -> list[str]:
    """校验 LLM 返回标注 item 的必填字段，返回缺陷列表（空 = 通过）。

    校验项（任一缺陷触发重试/换备选模型）：
    - type：合法枚举（缺失/非法 = 缺陷，不兜底）
    - difficulty：1-5 整数（缺失/非法 = 缺陷，不 clamp 掩盖）
    - knowledge_points / suggested_new_kps：必须是列表（可空）
    - completeness：必须存在；is_complete=false 时必须有 regenerated
    - regenerated（存在时）：content 非空；choice 必须 4 项 options 且
      label=={A,B,C,D}、text 非空；非 choice 不应有 options
    - 一致性：Python 已确定性拆出完整 4 选项时，LLM 判 is_complete=false 或
      重写 options 与 Python 拆分不一致 → 缺陷（防 LLM 重写丢内容）
    """
    issues: list[str] = []
    t = item.get("type")
    if t not in _VALID_TYPES:
        issues.append(f"type 缺失或非法: {t!r}")
    diff = item.get("difficulty")
    if not isinstance(diff, int) or isinstance(diff, bool) or not 1 <= diff <= 5:
        issues.append(f"difficulty 缺失或非法: {diff!r}")
    if not isinstance(item.get("knowledge_points"), list):
        issues.append("knowledge_points 缺失或非列表")
    if not isinstance(item.get("suggested_new_kps"), list):
        issues.append("suggested_new_kps 缺失或非列表")
    comp = item.get("completeness")
    regen = item.get("regenerated")
    if not isinstance(comp, dict):
        issues.append("completeness 缺失或非对象")
    else:
        is_complete = bool(comp.get("is_complete", True))
        if not is_complete:
            if not isinstance(regen, dict):
                issues.append("is_complete=false 但缺 regenerated")
            else:
                if not (regen.get("content") or "").strip():
                    issues.append("regenerated.content 为空")
                r_opts = regen.get("options")
                if t == "choice":
                    if not isinstance(r_opts, list) or len(r_opts) != 4:
                        issues.append(f"choice regenerated.options 非 4 项: {r_opts!r}")
                    else:
                        labels = [o.get("label") for o in r_opts]
                        if set(labels) != _VALID_LABELS:
                            issues.append(f"regenerated.options label 非法: {labels}")
                        if any(not str(o.get("text") or "").strip() for o in r_opts):
                            issues.append("regenerated.options 存在空 text")
                elif r_opts is not None:
                    issues.append("非 choice 题不应有 regenerated.options")
    # 一致性：Python 拆出完整 4 选项时，完整性应依赖 Python 拆分结果
    _, py_opts = split_options(q.content)
    py_complete = py_opts is not None and all(o["text"].strip() for o in py_opts)
    if py_complete and isinstance(comp, dict) and not bool(comp.get("is_complete", True)):
        if isinstance(regen, dict):
            r_opts = regen.get("options")
            if not isinstance(r_opts, list) or len(r_opts) != 4:
                issues.append("Python 已拆出完整选项，LLM 重写 options 非 4 项")
            else:
                py_map = {o["label"]: o["text"].strip() for o in py_opts}
                r_map = {o.get("label"): str(o.get("text") or "").strip() for o in r_opts}
                if py_map != r_map:
                    issues.append("Python 已拆出完整选项，LLM 重写 options 与拆分不一致")
        else:
            issues.append("Python 已拆出完整选项，LLM 却判 is_complete=false")
    return issues


@dataclass
class LabeledQuestion:
    """标注后的题（RawQuestion 字段 + LLM 标注 + 完整性检测/修复）。

    Python 切的（保留）：group_order/group_id/score/answer/explanation
    LLM 标注：type/difficulty/knowledge_points/suggested_new_kps
    完整性兜底：is_complete/completeness_issues/regenerated（有缺陷时 LLM 修复原题）
    content/options/material_text：由 question_extract 组装时 split_options 或 regenerated 填
    """
    group_order: int
    group_id: str | None
    content: str                        # RawQuestion 原文（完整，含选项/材料）
    answer: str                         # Python 对齐的答案
    explanation: str | None             # Python 对齐的解析
    score: int | None = None            # 每题满分
    type: str = ""
    difficulty: int = 2
    knowledge_points: list = None
    suggested_new_kps: list = None
    _confirmed_new_kps: list = None
    _suggested_new_kps: list = None
    # 完整性兜底（LLM 检测+修复）
    is_complete: bool = True
    completeness_issues: list = None    # ["选项不足4个", "题干截断", ...]
    regenerated: dict = None            # {content, options, material_text, answer} 修复后

    @classmethod
    def from_raw(cls, q: "RawQuestion") -> "LabeledQuestion":
        return cls(
            group_order=q.group_order,
            group_id=q.group_id,
            content=q.content,
            answer=q.answer,
            explanation=q.explanation,
            score=q.score,
            knowledge_points=[],
            suggested_new_kps=[],
            _confirmed_new_kps=[],
            _suggested_new_kps=[],
            completeness_issues=[],
        )


def _format_kp_list(kps: list[dict]) -> str:
    """格式化 KP 列表为 prompt 文本（每行 code + name）。"""
    return "\n".join(f"- {kp['code']} {kp['name']}" for kp in kps)


def _render_content(content: str) -> str:
    """呈现给 LLM 的题目文本：split_options 拆分成功时用拆分形式
    （题干：/选项A：.../选项D：...），完整性检测基于确定性拆分结果判，
    避免对 content-above 等排版误判缺陷后用 regenerated 覆盖正确拆分；
    拆分失败（非选择题/格式不符）时用原文。"""
    stem, opts = split_options(content)
    if not opts:
        return content
    parts = [f"题干：{stem}"]
    for o in opts:
        parts.append(f"选项{o['label']}：{o['text']}")
    return "\n".join(parts)


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
        """标注一批题（单题或多题）。失败的题返回 None（跳过）。"""
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
            item = items[i] if i < len(items) else None
            if item is not None and not _validate_item(item, q):
                labeled = LabeledQuestion.from_raw(q)
                self._fill_from_item(labeled, item)
                result.append(labeled)
            else:
                # 批内该题 item 缺失/校验失败 → 降级单题走 重试+备选+跳过 流程
                result.append(self._label_one(q))
        return result

    def _label_one(self, q) -> "LabeledQuestion | None":
        """标注单题：必填字段校验，失败同模型重试一次、再换备选模型试一次，
        全部失败返回 None（调用方跳过不写 JSONL）并打印日志。

        尝试顺序：主模型 → 主模型重试 → 备选模型（fallback_labeler 存在时）。
        """
        user = self._build_single_prompt(q)
        attempts: list[tuple[str, object]] = [("main", self._llm), ("main-retry", self._llm)]
        if self._fallback is not None:
            attempts.append(("fallback", self._fallback._llm))
        last_reason: list[str] = []
        for tag, llm in attempts:
            try:
                resp = llm.complete(self._prompt, user)
                data = _parse_json_object(resp.content)
                # 单题 LLM 可能直接返回 {...} 或 {"items":[{...}]}
                item = data.get("items", [{}])[0] if "items" in data else data
            except Exception as e:
                last_reason = [f"LLM 调用/解析失败: {e.__class__.__name__}"]
                print(f"[WARN] 题{q.group_order} 标注失败({tag}): {last_reason[0]}，继续尝试",
                      flush=True)
                continue
            issues = _validate_item(item, q)
            if not issues:
                labeled = LabeledQuestion.from_raw(q)
                self._fill_from_item(labeled, item)
                return labeled
            last_reason = issues
            if tag != "fallback":
                print(f"[WARN] 题{q.group_order} 标注校验失败({tag}): {issues}，重试/换备选",
                      flush=True)
        print(f"[WARN] 题{q.group_order} 标注失败已跳过（尝试 {len(attempts)} 次）：{last_reason}",
              flush=True)
        return None

    def _build_single_prompt(self, q) -> str:
        """填 prompt 占位符：题号/分组/满分/题目原文/答案/KP 列表。"""
        return (self._prompt
                .replace("{{group_order}}", str(q.group_order))
                .replace("{{group_id}}", q.group_id or "(无)")
                .replace("{{score}}", str(q.score) if q.score is not None else "(未给)")
                .replace("{{content}}", _render_content(q.content))
                .replace("{{answer}}", q.answer or "(无)")
                .replace("{{knowledge_points}}", self._kps_text))

    def _build_multi_prompt(self, batch: list) -> str:
        """多题一批：把每题拼成带元数据的段落。"""
        parts = []
        for q in batch:
            parts.append(
                f"## 题 {q.group_order}（分组 {q.group_id or '无'}，满分 {q.score or '未给'}）\n"
                f"题目：{_render_content(q.content)}\n已对齐答案：{q.answer or '无'}"
            )
        joined = "\n\n".join(parts)
        return (self._prompt.replace("{{knowledge_points}}", self._kps_text)
                .replace("{{group_order}}", "见上方")
                .replace("{{group_id}}", "见上方")
                .replace("{{score}}", "见上方")
                .replace("{{content}}", joined)
                .replace("{{answer}}", "见上方"))

    def _fill_from_item(self, labeled, item: dict):
        """从 LLM 输出 item 填充 labeled 字段。

        LLM 标 type/difficulty/kp/suggested_new_kps + 完整性检测 + 修复（regenerated）。
        content/answer/explanation 保留 Python 切的；options/material_text 由
        question_extract 组装时 split_options 或 regenerated 填。
        """
        labeled.type = str(item.get("type", "") or "")
        try:
            labeled.difficulty = int(item.get("difficulty", 2) or 2)
            if not 1 <= labeled.difficulty <= 5:
                labeled.difficulty = 2
        except (TypeError, ValueError):
            labeled.difficulty = 2
        labeled.knowledge_points = list(item.get("knowledge_points", []) or [])
        labeled.suggested_new_kps = list(item.get("suggested_new_kps", []) or [])
        # 完整性检测 + 修复
        comp = item.get("completeness") or {}
        labeled.is_complete = bool(comp.get("is_complete", True))
        labeled.completeness_issues = list(comp.get("issues", []) or [])
        regen = item.get("regenerated")
        if isinstance(regen, dict):
            # 原文无答案（Python 对齐 answer 为空）时清空 LLM 返回的答案：
            # 无答案的题 answer 一律留空（设计约定，做题时大模型补），
            # LLM 返回答案不影响其他字段，直接丢弃即可
            if not (labeled.answer or "").strip():
                regen["answer"] = ""
            labeled.regenerated = regen

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

        # 收集所有 suggested_new_kps（去重）；跳过标注失败的 None
        all_suggested: list[str] = []
        for q in labeled:
            if q is None:
                continue
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
            if q is None:
                continue
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
