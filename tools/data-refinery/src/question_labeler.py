"""试卷题 LLM 标注器：标 type/difficulty/知识点 + 双模型确认新增 KP。

LLM 只标注元数据，不改 content、不给答案（answer 由 question_splitter 按题号对齐）。
知识点列表由调用方从 DB 查询后注入（动态读取，不写死在 prompt 文件）。
"""

from extract import _parse_json_object  # 复用 JSON 解析逻辑
from question_splitter import RawQuestion, split_options
from dataclasses import dataclass

# 合法题型枚举（prompt 与 ExamQuestion 契约）
_VALID_TYPES = {"choice", "fill_blank", "true_false", "short_answer", "proof", "calculation"}
# 选择题选项标签（语文可能 3 项；label 已归一为 A-F）
_VALID_LABELS = {"A", "B", "C", "D", "E", "F"}

# Python 已拆出完整 4 选项时的「只标注」追加指令：LLM 反复重写选项会被一致性校验拒绝，
# 这一步只取题型/难度/知识点，完整性以 Python 拆分为准（2026-10-28 语文卷实测）。
_LABELS_ONLY_SUFFIX = (
    "\n\n【重要】Python 已经从原题确定性拆出完整的选项，选项内容不需要你修复。"
    "本次只输出 type / difficulty / knowledge_points / suggested_new_kps；"
    "不要重写 options，completeness.is_complete 必须为 true，不要返回 regenerated。"
)


def _python_options_complete(q: RawQuestion, subject: str = "") -> bool:
    """Python 是否已从原题拆出完整的选项（语文允许 3 项，数学要求 4 项）。"""
    from subject_strategies import get_strategy

    strategy = get_strategy(subject) if subject else None
    _, opts = (strategy.split_options(q.content) if strategy
               else split_options(q.content))
    if not opts:
        return False
    if subject == "chinese":
        return 2 <= len(opts) <= 6 and all(o["text"].strip() for o in opts)
    return len(opts) == 4 and all(o["text"].strip() for o in opts)


# LLM 报告的缺陷归类：决定「Python 已完整拆出选项、LLM 却判不完整」时该信谁。
# - content：材料/题干/画线/图片 等原文缺失 → LLM 可能判对了，接受 false（标待复核）
# - option ：只有选项问题 → Python 已拆出非空选项，说明是 LLM 误判，以 Python 为准
# - unknown：说不出具体缺陷 → 同 option 处理（保守，避免误标待复核）
_OPTION_DEFECT_HINTS = ("选项", "A/B/C/D", "4 个选项", "4个选项", "四项")
_CONTENT_DEFECT_HINTS = (
    "材料", "画线", "画波浪线", "波浪线", "加点", "下划线", "语段", "原文",
    "上下文", "链接材料", "资料卡", "题干截断", "材料截断", "内容截断", "语料",
    "表格", "图片", "音频", "缺图", "段落",
)

# 允许「只报告缺陷、不修复」的学科。
# 这些学科的典型缺陷（画线句指向、图片内文字、外部时政/名著材料）在 PDF 转文字时
# 就丢了，模型只能凭空补——实测大兴题5 编出两句【甲】【乙】、房山题25 补出原文没有
# 的 D。因此宁可留缺陷 + needs_review（不入抽题池），也不接受编造。
# 数学/物理/化学的缺选项、缺单位通常有上下文残片可依，仍要求修复后才算通过。
_UNREPAIRED_OK = frozenset({"chinese", "politics", "history", "geography", "biology"})


def _defect_kind(comp: dict) -> str:
    """把 completeness.issues 归为 content / option / unknown。"""
    text = " ".join(str(x) for x in (comp.get("issues") or []))
    if any(k in text for k in _CONTENT_DEFECT_HINTS):
        return "content"
    if any(k in text for k in _OPTION_DEFECT_HINTS):
        return "option"
    return "unknown"


def _validate_item(item: dict, q: RawQuestion, subject: str = "") -> list[str]:
    """校验 LLM 返回标注 item 的必填字段，返回缺陷列表（空 = 通过）。

    校验项（任一缺陷触发重试/换备选模型）：
    - type：合法枚举（缺失/非法 = 缺陷，不兜底）
    - difficulty：1-5 整数（缺失/非法 = 缺陷，不 clamp 掩盖）
    - knowledge_points / suggested_new_kps：必须是列表（可空）
    - completeness：必须存在；is_complete=false 且缺陷可修复时必须有 regenerated
      （语文/道法等「原文缺失型」缺陷允许只报告不修复，见 _UNREPAIRED_OK）
    - regenerated（存在时）：content 非空；choice 的 options 项数与 label 合法、
      text 非空；非 choice 不应有 options
    - 一致性：Python 已拆出完整选项时，重写 options 与拆分不一致 → 缺陷（防丢内容/编造）；
      只判 false 不重写时，缺陷在材料/题干则接受，只提选项或说不出缺陷则视为误判
    """
    from subject_strategies import get_strategy

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
                # 「只报告、不修复」是合法结果：原文缺失型缺陷（画线句、图片内文字、
                # 外部材料）无法从上下文还原，强行修复就是编造。这类题以原文入库并
                # 打 needs_review（is_active=0，不进抽题池），不至于整题降级丢知识点。
                # 数学/物理/化学的缺选项通常有残片可依，仍要求修复。
                if subject not in _UNREPAIRED_OK:
                    issues.append("is_complete=false 但缺 regenerated")
            else:
                if not (regen.get("content") or "").strip():
                    issues.append("regenerated.content 为空")
                r_opts = regen.get("options")
                if t == "choice":
                    if not isinstance(r_opts, list) or not (2 <= len(r_opts) <= 6):
                        issues.append(f"choice regenerated.options 项数非法（2-6）: {r_opts!r}")
                    else:
                        labels = [o.get("label") for o in r_opts]
                        if not set(labels) <= _VALID_LABELS or len(set(labels)) != len(labels):
                            issues.append(f"regenerated.options label 非法: {labels}")
                        if any(not str(o.get("text") or "").strip() for o in r_opts):
                            issues.append("regenerated.options 存在空 text")
                elif r_opts is not None:
                    issues.append("非 choice 题不应有 regenerated.options")
    # 一致性：Python 已拆出完整选项时的冲突处理
    # - LLM 要重写 options：必须与 Python 拆分逐项一致，否则拒绝（防丢内容/编造）
    # - LLM 只判 false、不重写：若缺陷在材料/题干，接受（真缺陷，标待复核）；
    #   若只提选项或说不出缺陷，说明是误判，以 Python 为准
    _, py_opts = (get_strategy(subject).split_options(q.content) if subject
                  else split_options(q.content))
    py_complete = _python_options_complete(q, subject)
    if py_complete and isinstance(comp, dict) and not bool(comp.get("is_complete", True)):
        if isinstance(regen, dict):
            r_opts = regen.get("options")
            if not isinstance(r_opts, list) or len(r_opts) != len(py_opts):
                issues.append("Python 已拆出完整选项，LLM 重写 options 项数不一致")
            else:
                py_map = {o["label"]: o["text"].strip() for o in py_opts}
                # 语文原标签可能是「甲乙丙」，LLM 可能照抄原标签，先归一到 A/B/C 再比
                orig_to_norm = {
                    o.get("original_label"): o["label"]
                    for o in py_opts if o.get("original_label")
                }
                r_map = {
                    orig_to_norm.get(o.get("label"), o.get("label")): str(o.get("text") or "").strip()
                    for o in r_opts
                }
                if py_map != r_map:
                    issues.append("Python 已拆出完整选项，LLM 重写 options 与拆分不一致")
        elif _defect_kind(comp) != "content":
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
    material_text: str | None = None    # 同节共享材料（切分器按小节归属，语文阅读用）

    @classmethod
    def from_raw(cls, q: "RawQuestion") -> "LabeledQuestion":
        return cls(
            group_order=q.group_order,
            group_id=q.group_id,
            content=q.content,
            answer=q.answer,
            explanation=q.explanation,
            score=q.score,
            material_text=q.material_text,
            knowledge_points=[],
            suggested_new_kps=[],
            _confirmed_new_kps=[],
            _suggested_new_kps=[],
            completeness_issues=[],
        )


def _format_kp_list(kps: list[dict]) -> str:
    """格式化 KP 列表为 prompt 文本（每行 code + name）。"""
    return "\n".join(f"- {kp['code']} {kp['name']}" for kp in kps)


def _render_with_material(q, subject: str = "") -> str:
    """把同节共享材料一并呈现给 LLM（语文阅读题的材料在题号之前，单看题干会误判截断）。"""
    text = _render_content(q.content, subject)
    material = (getattr(q, "material_text", None) or "").strip()
    if material:
        return f"[同题材料，供判断完整性，不要复述]\n{material}\n\n[本题]\n{text}"
    return text


def _render_content(content: str, subject: str = "") -> str:
    """呈现给 LLM 的题目文本：split_options 拆分成功时用拆分形式
    （题干：/选项A：.../选项D：...），完整性检测基于确定性拆分结果判，
    避免对 content-above 等排版误判缺陷后用 regenerated 覆盖正确拆分；
    拆分失败（非选择题/格式不符）时用原文。"""
    from subject_strategies import get_strategy

    strategy = get_strategy(subject) if subject else None
    stem, opts = (strategy.split_options(content) if strategy
                  else split_options(content))
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
                 fallback_labeler: "QuestionLabeler | None" = None,
                 subject: str = ""):
        self._llm = llm
        self._prompt = prompt
        self._kps = knowledge_points
        self._kps_text = _format_kp_list(knowledge_points)
        self._fallback = fallback_labeler
        # 语文选项允许 3 项/甲乙丙，拆选项与校验都要按学科走
        self._subject = subject

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
            if item is not None and not _validate_item(item, q, self._subject):
                labeled = LabeledQuestion.from_raw(q)
                self._fill_from_item(labeled, item)
                result.append(labeled)
            else:
                # 批内该题 item 缺失/校验失败 → 降级单题走 重试+备选+跳过 流程
                result.append(self._label_one(q))
        return result

    def _label_one(self, q) -> "LabeledQuestion | None":
        """标注单题：必填字段校验，失败同模型重试一次、再走「只标注」兜底、最后换备选模型。

        尝试顺序：主模型 → 主模型重试 → 主模型只标注（Python 已拆出完整选项时）
        → 备选模型（fallback_labeler 存在时）。
        「只标注」这一步专门处理「Python 已拆出完整 4 选项、LLM 却反复要重写选项」：
        此时不再让 LLM 碰 options，只取 type/difficulty/知识点，避免整题降级。
        """
        user = self._build_single_prompt(q)
        attempts: list[tuple[str, object, str]] = [
            ("main", self._llm, self._prompt),
            ("main-retry", self._llm, self._prompt),
        ]
        if _python_options_complete(q, self._subject):
            attempts.append(("main-labels-only", self._llm, self._prompt + _LABELS_ONLY_SUFFIX))
        if self._fallback is not None:
            attempts.append(("fallback", self._fallback._llm, self._prompt))

        last_reason: list[str] = []
        for tag, llm, system in attempts:
            try:
                resp = llm.complete(system, user)
                data = _parse_json_object(resp.content)
                # 单题 LLM 可能直接返回 {...} 或 {"items":[{...}]}
                item = data.get("items", [{}])[0] if "items" in data else data
            except Exception as e:
                detail = str(e).strip().replace("\n", " ")[:300]
                last_reason = [f"LLM 调用/解析失败: {e.__class__.__name__}: {detail}"]
                print(f"[WARN] 题{q.group_order} 标注失败({tag}): {last_reason[0]}，继续尝试",
                      flush=True)
                continue

            if tag == "main-labels-only":
                # 完整性以 Python 拆分为准：强制 complete、丢弃 LLM 的 regenerated
                item = dict(item)
                item["completeness"] = {"is_complete": True, "issues": []}
                item.pop("regenerated", None)

            issues = _validate_item(item, q, self._subject)
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
                .replace("{{content}}", _render_with_material(q, self._subject))
                .replace("{{answer}}", q.answer or "(无)")
                .replace("{{knowledge_points}}", self._kps_text))

    def _build_multi_prompt(self, batch: list) -> str:
        """多题一批：把每题拼成带元数据的段落。"""
        parts = []
        for q in batch:
            parts.append(
                f"## 题 {q.group_order}（分组 {q.group_id or '无'}，满分 {q.score or '未给'}）\n"
                f"题目：{_render_with_material(q, self._subject)}\n已对齐答案：{q.answer or '无'}"
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
