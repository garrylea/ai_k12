"""试卷题 LLM 标注器：标 type/difficulty/知识点 + 双模型确认新增 KP。

LLM 只标注元数据，不改 content、不给答案（answer 由 question_splitter 按题号对齐）。
知识点列表由调用方从 DB 查询后注入（动态读取，不写死在 prompt 文件）。
"""

import html
import re

from extract import _parse_json_object  # 复用 JSON 解析逻辑
from question_splitter import RawQuestion, split_options
from dataclasses import dataclass

# 合法题型枚举（prompt 与 ExamQuestion 契约）
_VALID_TYPES = {"choice", "multi_choice", "fill_blank", "true_false", "short_answer", "proof", "calculation"}

# 判断题被截断的结尾：停在逗号/分号/左括号上，说明后面还有话被切走了
_CUT_TAIL = ("，", ",", "、", "；", ";", "：", ":", "（", "(", "“", "「")
_IMAGE_RE = re.compile(r"!\[[^\]]*\]\(|<img\b", re.IGNORECASE)


def _true_false_stem_is_self_contained(content: str) -> bool:
    """判断题的题干就是一句陈述，没有「请判断正误」的设问是正常的。

    LLM 的完整性检查是按「有没有设问」判的，会把道法/历史判断题全判成
    「题干缺失设问」→ needs_review → is_active=0 → 学生端整卷题目消失
    （2026-11-06 海淀道法：10 道判断题里 8 道被误判）。
    这里只认两种真缺陷：题干为空/几乎为空、以及明显截断（结尾停在逗号/括号）。
    带图的判断题一律算完整（图本身就是题干的一部分）。
    """
    raw = content or ""
    if _IMAGE_RE.search(raw):
        return True
    text = re.sub(r"<[^>]+>", " ", raw)
    text = re.sub(r"\s+", "", html.unescape(text))
    if len(text) < 6:
        return False
    return not text.endswith(_CUT_TAIL)


def apply_true_false_exemption(labeled) -> int:
    """把判断题「缺设问」的误判清掉（题干是陈述句不算缺陷）；返回清掉的题数。

    两处调用：labeler 出结果时（LLM 已判 true_false），以及按大题定型之后
    （LLM 可能把判断题标成 short_answer，定型才改成 true_false）——后者不补，
    海淀道法仍会剩 5 道判断题被挂着 is_active=0。
    """
    cleared = 0
    for lab in labeled:
        if (getattr(lab, "type", "") == "true_false" and not lab.is_complete
                and _true_false_stem_is_self_contained(lab.content)):
            lab.is_complete = True
            lab.completeness_issues = []
            cleared += 1
    return cleared


# 「仅包含第(1)问」这类断言可以直接用 Python 核对：content 里若有 (2)(3) 就是误判。
_SUBQ_NUM_RE = re.compile(r"(?m)^[ \t]*[（(](\d+)[）)]")
_ONLY_SUBQ_CLAIM_RE = re.compile(r"仅.{0,8}第?\s*[（(]?\s*(\d+)\s*[）)]?\s*问")
_KP_CLAIM_RE = re.compile(r"知识点|knowledge[_ ]?point|\bKP\b", re.IGNORECASE)


def apply_kp_issue_exemption(labeled) -> int:
    """「知识点列表为空、无法匹配 code」不是题目缺陷，是我们的配置状态。

    学科还没有 KP 树时，标注模型会把「匹配不到知识点」写进 completeness.issues
    → is_active=0，整题消失（2026-11-06 道法题 26 实测）。等 KP 建好这种误判自然消失，
    但不能让它成为隐藏题目的理由：只清**全部 issue 都在讲知识点**的情况。
    """
    cleared = 0
    for lab in labeled:
        issues = lab.completeness_issues or []
        if (not lab.is_complete and issues
                and all(_KP_CLAIM_RE.search(str(i)) for i in issues)):
            lab.is_complete = True
            lab.completeness_issues = []
            cleared += 1
    return cleared


# 「缺视频素材①②③」这类断言：材料是否真的分段，Python 可直接核对
_SECTION_HEAD_RE = re.compile(r"(?m)^#{2,6}[ \t]*\S")
_MISSING_SOURCE_CLAIM_RE = re.compile(
    r"缺(?:少|失)?[^。；\n]{0,12}(?:素材|序号|视频|①②③)|"
    r"未(?:明确)?标(?:出)?[^。；\n]{0,30}(?:序号|①②③)")


def apply_material_sections_exemption(labeled) -> int:
    """材料题「缺三段素材/缺①②③序号」的误判：材料里已有 ≥3 个分段标题就是完整。

    2026-11-06 海淀道法题 28：材料是「今日答卷/昔日之问/思想领航」三段文字（视频脚本），
    学生按这三段排序即可作答；LLM 却要求材料里出现 ①②③ 编号，判「缺视频素材」。
    判据是结构（`## ` 分段数），不是 LLM 措辞。
    """
    cleared = 0
    for lab in labeled:
        material = getattr(lab, "material_text", None) or ""
        if lab.is_complete or not material.strip():
            continue
        issues = " ".join(lab.completeness_issues or [])
        if (_MISSING_SOURCE_CLAIM_RE.search(issues)
                and len(_SECTION_HEAD_RE.findall(material)) >= 3):
            lab.is_complete = True
            lab.completeness_issues = []
            cleared += 1
    return cleared


def apply_material_subq_exemption(labeled) -> int:
    """材料题「只切到第(1)问」的误判：LLM 说只有第 1 问，但 content 里确有 (2)。

    2026-11-06 海淀道法题 26：材料+两小问都在，LLM 却判「仅包含第(1)问、缺失第(2)问」
    → is_active=0，14 分大题消失。这里只认**可核对的断言**（说了「仅…第N问」），
    并且只在 content 里确实找到更多小问时放行；「缺素材/缺图」型缺陷不受影响
    （题 28 缺三段视频素材，仍保持待复核）。
    """
    cleared = 0
    for lab in labeled:
        if lab.is_complete or not (getattr(lab, "material_text", None) or "").strip():
            continue
        issues = " ".join(lab.completeness_issues or [])
        claims = {int(n) for n in _ONLY_SUBQ_CLAIM_RE.findall(issues)}
        found = {int(n) for n in _SUBQ_NUM_RE.findall(lab.content or "")}
        if claims and max(claims) < max(found or {0}):
            lab.is_complete = True
            lab.completeness_issues = []
            cleared += 1
    return cleared
# 语文「加点字 / 画线句」在 PDF 转文字时会丢标记。选择题只要选项自己点名了
# 考点（引号里的词、原文片段、第①②句），缺视觉标记不影响作答；简答题没有
# 选项可自证，仍保持待复核。
_LOST_MARK_RE = re.compile(r"加点|画线|画波浪线|波浪线|下划线|着重号")
_LOST_MARK_BLOCKER_RE = re.compile(r"截断|缺图|缺表格|缺少选项|选项不足|选项残缺|材料缺失")
_CIRCLED_OPTION_ONLY_RE = re.compile(r"^第?([①②③④⑤⑥])[句项]?$")


def _options_identify_mark_target(lab, strategy) -> bool:
    """选择题的选项是否自己点名了「加点/画线」的考点。

    两种确定性形态：
    - 选项引用原文/题干里的字词（引号内短语，或 ≥4 字连续片段能在原文找到）；
    - 选项是「第①句/第②项」，且题干或材料里确有对应圈号。
    """
    stem, opts = strategy.split_options(lab.content or "")
    if not opts:
        return False
    low, _ = strategy.choice_bounds()
    texts = [o["text"].strip() for o in opts]
    if len(texts) < low or not all(texts):
        return False
    source = f"{lab.material_text or ''}\n{stem}"
    if not source.strip():
        return False

    circled = [_CIRCLED_OPTION_ONLY_RE.match(t) for t in texts]
    if all(circled):
        return all(m.group(1) in source for m in circled)

    for text in texts:
        for quoted in re.findall(r'[“"]([^”"]{2,})[”"]', text):
            if quoted in source:
                return True
        for run in re.findall(r"[\u4e00-\u9fff]{4,}", text):
            if run in source:
                return True
    return False


def apply_lost_mark_choice_exemption(labeled, subject: str = "") -> int:
    """选择题的「加点/画线标记丢失」不是缺陷：选项已点名考点，照常进池。

    海淀 2026 语文题2/题4/题13：材料与选项都在，只是 PDF 没转出加点/下划线，
    LLM 判「无法确定考点」→ is_active=0。这里只放行**可核对**的情况：题型是
    选择题、所有 issue 都在说加点/画线、且选项能自证考点。简答题（题6/12/21）
    没有选项可自证，继续拦。
    """
    if not subject:
        return 0
    from subject_strategies import get_strategy

    strategy = get_strategy(subject)
    cleared = 0
    for lab in labeled:
        if lab.is_complete or lab.type != "choice":
            continue
        issues = [str(i) for i in (lab.completeness_issues or [])]
        if not issues or not all(_LOST_MARK_RE.search(i) for i in issues):
            continue
        if any(_LOST_MARK_BLOCKER_RE.search(i) for i in issues):
            continue
        if _options_identify_mark_target(lab, strategy):
            lab.is_complete = True
            lab.completeness_issues = []
            cleared += 1
    return cleared


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
    """Python 是否已从原题拆出完整的选项。

    项数区间由策略 `split_bounds()` 决定（语文 2–6，其余 4–4）——这是「拆出几项
    算拆成功」，与 `choice_bounds()`（算不算完整选择题）是两件事，不要合并。
    """
    from subject_strategies import get_strategy

    strategy = get_strategy(subject) if subject else None
    _, opts = (strategy.split_options(q.content) if strategy
               else split_options(q.content))
    if not opts:
        return False
    low, high = strategy.split_bounds() if strategy else (4, 4)
    return low <= len(opts) <= high and all(o["text"].strip() for o in opts)


# LLM 报告的缺陷归类：决定「Python 已完整拆出选项、LLM 却判不完整」时该信谁。
# - content：材料/题干/画线/图片 等原文缺失 → LLM 可能判对了，接受 false（标待复核）
# - option ：只有选项问题 → Python 已拆出非空选项，说明是 LLM 误判，以 Python 为准
# - unknown：说不出具体缺陷 → 同 option 处理（保守，避免误标待复核）
_OPTION_DEFECT_HINTS = ("选项", "A/B/C/D", "4 个选项", "4个选项", "四项")
_CONTENT_DEFECT_HINTS = (
    "材料", "画线", "画波浪线", "波浪线", "加点", "下划线", "语段", "原文",
    "上下文", "链接材料", "资料卡", "题干截断", "材料截断", "内容截断", "语料",
    "表格", "图片", "音频", "缺图", "段落",
    # 缺图型（2026-11-03 汇文题20：「未包含实物元件图」）：跟画线句缺失同类，
    # 原文没给就补不出来，允许只报告不修复。
    "实物图", "元件图",
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


_PURE_IMAGE_RE = re.compile(r'^!\[[^\]]*\]\([^)]*\)$')

# 文本结构缺陷关键词：截断、选项冲突、缺号等是**真问题**，不能被图误判吞掉。
# 其余只要缺陷提到「图」、而 content/material 里确实有图，就视为 LLM 看不到图的误判。
_STRUCTURAL_DEFECT_HINTS = ("截断", "选项", "缺号", "重复", "错位", "题干为空", "空题干")


def _figure_missing_but_images_present(content: str, issues: list) -> bool:
    """缺陷提到图、但题干/材料里其实有图片引用 → LLM 看不到图的误判。

    MinerU 已经把图抽出来了（`![…](…)` 就在 content/material_text 里），LLM 是
    纯文本模型看不到图，于是用各种措辞说「缺图 / 图不可用 / 无法校验 / 图注缺失」
    ——措辞每轮都变，穷举关键词追不上（2026-11-03 汇文实测：每次重跑挑不同的题，
    题8/18/20/21/25 → 题4/15/24）。所以改成宽判据：**提到「图」+ 确实有图**即判完整。

    唯一例外是文本结构缺陷（截断/选项冲突/缺号），那是真问题，不能被这张网吞掉。

    保守边界：content+material 一张图都没有时返回 False（真缺图，保持不完整）。
    """
    if '![' not in (content or ''):
        return False
    text = " ".join(str(x) for x in (issues or []))
    if any(h in text for h in _STRUCTURAL_DEFECT_HINTS):
        return False
    return "图" in text


def _options_are_all_images(content: str, subject: str = "") -> bool:
    """Python 拆出的选项是否每个都是纯图片（图选项题）。

    这类题选项本身就是图（合法完整），LLM 常因「无法从文本校验图片内容」误判
    不完整；结构证据（每个选项只有一条 ![](…)）比 LLM 措辞可靠。
    2026-11-03 汇文题8 实测：三轮不同措辞都误判，结构判据一次命中。
    """
    from subject_strategies import get_strategy

    strategy = get_strategy(subject) if subject else None
    _, opts = (strategy.split_options(content) if strategy else split_options(content))
    if not opts:
        return False
    return all(_PURE_IMAGE_RE.match((o.get("text") or "").strip()) for o in opts)


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
                # 外部材料、缺图）无法从上下文还原，强行修复就是编造。这类题以原文
                # 入库并打 needs_review（is_active=0，不进抽题池），不至于整题降级丢
                # 知识点。数学/物理/化学的缺选项通常有残片可依，仍要求修复后才算通过。
                #
                # 2026-11-03：物理实验题缺图（图未随卷给出）跟语文画线句缺失同类——
                # 模型返回 regenerated=null 明确表示无法修复，应接受。判据用
                # _defect_kind：缺陷归为 content（缺图/表格/材料/原文缺失）就接受，
                # 归为 option（缺选项）仍要求修复。Qwen3.8-27B 对汇文题21 正确返回了
                # type/difficulty/KP + is_complete=false + regenerated=null + issues
                # 含"缺图缺陷，无法修复"，却被旧规则判失败→重试→兜底→402→完全丢失。
                defect = _defect_kind(comp)
                if subject not in _UNREPAIRED_OK and defect != "content":
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
        n = len(questions)
        for i in range(0, n, batch_size):
            batch = questions[i:i + batch_size]
            result.extend(self._label_batch(batch))
            # 进度：每 5 题或最后一批打一次，让用户看到在推进（2026-11-03 用户反馈
            # 选完试卷类型后 1-2 分钟无输出）。每题都打会刷屏，5 题一行折中。
            done = min(i + batch_size, n)
            if done == n or done % 5 == 0:
                print(f"[label] {done}/{n} done", flush=True)
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
        # 「选项是图片 / 图看不到」是误判：图已在题干或材料里（MinerU 抽出），
        # LLM 纯文本看不到图才判不完整。不标 needs_review，否则 is_active=0
        # 会被考试题单过滤，页面题号整体前移（汇文题8/18/20/21/25 事故）。
        # 图片可能被 split_material 移到 material_text，判据要两处都看。
        if not labeled.is_complete and (
            _options_are_all_images(labeled.content, self._subject)
            or _figure_missing_but_images_present(
                (labeled.content or "") + "\n" + (labeled.material_text or ""),
                labeled.completeness_issues)
        ):
            labeled.is_complete = True
            labeled.completeness_issues = []
        # 判断题同理：陈述句没有「设问」是题型本身决定的，不是缺陷。
        # 只有题干为空或明显截断才保留缺陷（2026-11-06 海淀道法 8/10 误判）。
        apply_true_false_exemption([labeled])
        # 材料题「只切到第(1)问」的断言可用 Python 直接核对（题 26 误判）
        apply_material_subq_exemption([labeled])
        # 「匹配不到知识点」是我们没建 KP，不是题目缺陷
        apply_kp_issue_exemption([labeled])
        # 「缺三段视频素材①②③」：材料里已有 3 个分段标题，是 LLM 要求编号的误判
        apply_material_sections_exemption([labeled])
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
