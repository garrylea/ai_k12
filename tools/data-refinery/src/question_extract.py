"""试卷题提取：试卷 MD → 切题 + 标注 + 写 ExamQuestion JSONL。

extract_cli 的 kind=questions 分支调用本模块，与教材卡（cards）路径分离。
链路：maybe_merge_answer_md（4 case 答案合并/选择）→ split_page（切题+答案对齐）
→ question_labeler（LLM 标 type/difficulty/KP + 双模型确认新增 KP）→ ExamQuestion JSONL。

不跑 image_scan（保留所有图，额外按 qr_detect 剔除二维码图）、不跑 card_splitter（不按字数切）。
知识点列表动态从 DB 查（不写死 prompt）。详见
docs/superpowers/specs/2026-09-05-exam-question-splitter-design.md。
"""

import json
import re
from pathlib import Path

import pymysql

from answer_merger import maybe_merge_answer_md
from extract import _parse_json_object
from question_splitter import is_junk_question, split_page, split_options
from question_labeler import (
    QuestionLabeler, LabeledQuestion, apply_material_sections_exemption,
    apply_material_subq_exemption, apply_true_false_exemption,
)
from section_analyzer import analyze_sections
from qr_detect import strip_qr_images
from subject_codes import subject_code_for_parts
from subject_strategies import get_strategy


def _subject_code_for(rel_parts: tuple[str, ...]) -> str | None:
    """从文件相对路径首段（中文学科名）推导 subject code。

    识别不出时返回 None（而不是默认数学）——`get_strategy(None)` 会抛
    UnknownStrategyError，让「目录名写错/新学科没登记」立刻暴露，
    而不是被静默当成数学题处理。
    """
    return subject_code_for_parts(rel_parts, default=None)


def _grade_band_for(filename: str) -> str:
    """从文件名解析学段：初三→junior，高三→senior，小三→primary。"""
    if "初三" in filename:
        return "junior"
    if "高三" in filename:
        return "senior"
    if "小三" in filename:
        return "primary"
    return "junior"


def _source_year_for(filename: str) -> int:
    """从文件名 -(\d{6})- 取前 4 位年份（202607 → 2026）。"""
    m = re.search(r"-(\d{6})-", filename)
    return int(m.group(1)[:4]) if m else 0


def normalize_fullwidth_parens(text: str) -> str:
    """全角括号统一为半角（与 extract_cli 同款）。"""
    return text.replace("（", "(").replace("）", ")")


def _query_knowledge_points(config, subject_code: str) -> list[dict]:
    """从 DB 查当前全量 KP 列表（动态注入 prompt，不写死）。"""
    conn = pymysql.connect(
        host=config.db_host, port=config.db_port,
        user=config.db_user, password=config.db_pass,
        database=config.db_name, charset="utf8mb4",
    )
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT code, name FROM knowledge_points "
                "WHERE subject_id=(SELECT id FROM subjects WHERE code=%s) "
                "ORDER BY code",
                (subject_code,),
            )
            return [{"code": r[0], "name": r[1]} for r in cur.fetchall()]
    finally:
        conn.close()


def _load_prompt(name: str) -> str:
    prompt_path = Path(__file__).parent / "prompts" / f"{name}.txt"
    return prompt_path.read_text(encoding="utf-8")


def _load_labeler_prompt(subject: str) -> str:
    """标注提示词 = 公共契约 + 学科规则。

    各学科对「什么叫完整」「哪些缺陷允许修复」的判定完全不同：语文 3 个选项合法、
    画线句在 PDF 转文字时必丢；英语完形填空一空四选项共用选项池；数学纯图选项
    不该被当成缺文字。此前九科共用一份提示词，模型只能按数学的标准去补语文，
    补出来的就是原文没有的内容（实测大兴题5 编出两句【甲】【乙】、房山题25 补出
    原文没有的 D）。

    公共部分（JSON 契约/字段/知识点约束）只维护一份，避免改格式时六份漂移；
    学科差异集中在 `prompts/question_labeler/<subject>.txt`，缺配置时回退 `_generic.txt`。
    """
    base = Path(__file__).parent / "prompts" / "question_labeler"
    common = (base / "_common.txt").read_text(encoding="utf-8")
    subject_file = base / f"{subject}.txt" if subject else None
    if subject_file is None or not subject_file.exists():
        subject_file = base / "_generic.txt"
    return common.replace("{{subject_rules}}", subject_file.read_text(encoding="utf-8").strip())


def _purge_labeling_issues_for_source(log_path: Path, source_name: str) -> None:
    """清掉该卷上一轮的 completeness / label_failed 记录（保留其它卷）。

    labeling_issues.jsonl 是追加日志：不清会让已修复的旧记录（缺图误判、标注失败
    兜底）一直留在识别问题扫描里，让人反复确认已完整的题（2026-11-03 题18/21）。
    坏行原样保留，避免把手改坏的文件整段删掉。
    """
    try:
        if not log_path.exists():
            return
        keep: list[str] = []
        for line in log_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                keep.append(line)
                continue
            if rec.get("source") != source_name:
                keep.append(line)
        log_path.write_text("\n".join(keep) + ("\n" if keep else ""), encoding="utf-8")
    except OSError as e:
        print(f"[WARN] 清理 labeling_issues 失败（{e}），旧记录可能残留", flush=True)


# LLM 修复时出现过的占位/缺失说明（不是题目内容，绝不能入库）
_PLACEHOLDER_HINTS = (
    "此处应填入", "此处缺失", "需补充", "待补充", "占位", "原文缺失", "材料缺失说明",
)


def _fallback_label(q, subject: str = ""):
    """标注失败时的确定性兜底标签（不丢题）。"""
    from question_labeler import LabeledQuestion

    lab = LabeledQuestion.from_raw(q)
    strategy = get_strategy(subject) if subject else None
    _, opts = (strategy.split_options(q.content) if strategy
               else split_options(q.content))
    lab.type = "choice" if opts else "short_answer"
    lab.difficulty = 2
    lab.is_complete = True  # 不做 LLM 修复，保持切分原文
    lab.completeness_issues = ["LLM 标注失败，已用确定性兜底（题型按选项判定）"]
    return lab


def _normalize_choice_answer(answer: str, options: list[dict]) -> str:
    """把「乙 / 【乙】 / 甲.」这类原标签答案映射成归一后的 A/B/C。

    语文选项常用甲乙丙，存储层 label 统一为 A/B/C；参考答案若写「乙」，
    不映射的话判题 `label === answer` 永远不相等。
    """
    if not answer or not options:
        return answer
    mapping = {
        o.get("original_label"): o["label"]
        for o in options if o.get("original_label")
    }
    if not mapping:
        return answer
    text = answer.strip()
    if text in mapping:
        return mapping[text]
    core = text.strip("【】[]（）() \t.．、:：")
    return mapping.get(core, answer)


def is_placeholder_text(text: str | None) -> bool:
    """是否为 LLM 修复产出的占位/缺失说明（而非真实内容）。"""
    if not text:
        return False
    return any(hint in text for hint in _PLACEHOLDER_HINTS)


_IMAGE_REF_RE = re.compile(r"!\[[^\]]*\]\(\s*([^)\s]+)\s*\)")


def strip_broken_images(text: str | None, md_dir) -> tuple[str, list[str]]:
    """丢掉文本里「磁盘上不存在」和「重复出现」的图片引用，返回 (新文本, 被丢的引用)。

    只用于 LLM 修复文本：Python 切分出的原文引用来自 Markdown 本身，不必校验。
    2026-10-30 实测：修复时模型抄 64 位哈希文件名会漏字符（`…cf4041aa4…` 抄成
    `…cf041aa4…`），产物里留一个永远打不开的图；同一次修复还会把整块图片复制两遍。
    http(s) 外链不校验（不在本地磁盘上）。
    """
    if not text:
        return text or "", []

    dropped: list[str] = []
    seen: set[str] = set()

    def _sub(match: re.Match) -> str:
        target = match.group(1)
        if target.startswith(("http://", "https://")):
            return match.group(0)
        if target in seen:
            dropped.append(target)
            return ""
        seen.add(target)
        if not (Path(md_dir) / target).exists():
            dropped.append(target)
            return ""
        return match.group(0)

    return _IMAGE_REF_RE.sub(_sub, text), dropped


def _safe_regenerated(regen: dict, q, md_dir=None) -> tuple[str, object, str | None, str]:
    """取修复后内容，但占位文本一律回退原始切分结果。

    2026-10-28 实测：材料归属缺失时 LLM 曾把 material_text 写成
    「【注：此处应填入…】」占位说明，直接入库会污染题库。
    md_dir 给出时再校验图片引用（见 strip_broken_images）。
    """
    content = regen.get("content") or q.content
    if is_placeholder_text(content):
        content = q.content
    options = regen.get("options")
    material = regen.get("material_text")
    if is_placeholder_text(material):
        material = q.material_text
    answer = regen.get("answer", q.answer) or q.answer

    if md_dir is not None:
        content, dropped = strip_broken_images(content, md_dir)
        if dropped:
            print(f"[WARN] 题{q.group_order} 修复内容含无效/重复图片引用，已剔除：{dropped}", flush=True)
        if material:
            material, dropped_m = strip_broken_images(material, md_dir)
            if dropped_m:
                print(f"[WARN] 题{q.group_order} 修复材料含无效/重复图片引用，已剔除：{dropped_m}",
                      flush=True)
        if isinstance(options, list):
            fixed = []
            for opt in options:
                if isinstance(opt, dict) and isinstance(opt.get("text"), str):
                    opt = {**opt, "text": strip_broken_images(opt["text"], md_dir)[0]}
                fixed.append(opt)
            options = fixed
    return content, options, material, answer


def _pdf_decorations(source, config) -> list:
    """定位试卷 PDF 并检测下划线/着重号；扫描件或找不到返回 []。

    只读 PDF 的字体坐标与图形层，不跑 OCR：扫描件（无文字层）必然为空。
    """
    from pdf_emphasis import detect_decorations

    pdf = Path(config.input_dir) / f"{source.rel_path}.pdf"
    if not pdf.exists():
        return []
    try:
        return detect_decorations(pdf)
    except Exception as e:  # 检测失败不能阻断主流程
        print(f"[WARN] 着重号检测失败（{pdf.name}）：{type(e).__name__}: {e}", flush=True)
        return []


def _apply_emphasis(questions: list, decorations: list) -> int:
    """把 PDF 的下划线/着重号注入题干与材料（幂等，返回注入处数）。

    必须在标注之前：MinerU 的 Markdown 不表达下划线、着重号、波浪线，模型看不到
    标记，就会把「赏析画线句」「加点词语」判成原文缺失（东直门 2024 题2/4/7/11/20/24）。
    文字版 PDF 能从字体坐标 + 图形层还原（大兴 36 处、五中 14 处）；扫描件没有
    文字层，检测为空，这部分缺口只能留待复核。
    """
    if not decorations:
        return 0
    from pdf_emphasis import decorate_text, is_option_line

    prose = [d for d in decorations if not is_option_line(d.line)]
    applied = 0
    for q in questions:
        if q.material_text:
            new, log = decorate_text(q.material_text, prose)
            if new != q.material_text:
                q.material_text = new
                applied += sum(1 for _, s in log if s == "applied")
        new, log = decorate_text(q.content, decorations)
        if new != q.content:
            q.content = new
            applied += sum(1 for _, s in log if s == "applied")
    return applied


def _split_inline_material(strategy, questions) -> None:
    """题内材料切分（2026-11-02）：材料与小问同属一个题号时切出 material_text。

    语文/英语没有 split_material（它们走跨题 material_policy），必须 getattr 判空，
    否则重抽语文/英语卷直接 AttributeError。
    """
    splitter = getattr(strategy, "split_material", None)
    if splitter is None:
        return
    for q in questions:
        if q.material_text and q.material_text.strip():
            continue
        material, rest = splitter(q.content)
        if material:
            q.material_text = material
            q.content = rest


def _write_exam_questions_jsonl(labeled: list, source, extracted_dir: Path,
                                 subject_code: str, grade_band: str,
                                 source_year: int):
    """组装 ExamQuestion JSONL（扩展字段带下划线前缀，publish 原样保留）。"""
    strategy = get_strategy(subject_code)
    rel_file = source.rel_path / source.md_path.name
    out_file = extracted_dir / rel_file.with_suffix(".jsonl")
    out_file.parent.mkdir(parents=True, exist_ok=True)
    source_name = source.md_path.stem  # 文件名去扩展名
    issues_log: list[dict] = []  # 完整性缺陷日志（原始+修复后+issues），供人工复核
    with out_file.open("w", encoding="utf-8") as f:
        for q in labeled:
            if q.is_complete:
                # 正常路径：Python 确定性拆选项，content 保留所有题干配图
                stem, opts = strategy.split_options(q.content)
                item_content, item_options = stem, opts
                item_material_text = q.material_text or None
                item_answer = q.answer
                if q.type == "choice" and not opts:
                    print(f"[WARN] 题{q.group_order} 判为选择题但选项标记残缺"
                          f"（Python 拆不出选项）→ 标待复核，人工补选项", flush=True)
            else:
                regen = q.regenerated or {}
                if regen:
                    # 修复路径：LLM 补全了原文残片，用修复后内容入库
                    item_content, item_options, item_material_text, item_answer = _safe_regenerated(
                        regen, q, md_dir=source.md_path.parent)
                    if is_placeholder_text((regen.get("material_text") or "")) or \
                            is_placeholder_text(regen.get("content")):
                        print(f"[WARN] 题{q.group_order} 修复内容含占位文本，已回退原始切分结果",
                              flush=True)
                    note = "已用 LLM 修复后入库"
                else:
                    # 只报告路径：原文缺失型缺陷（画线句/图片内文字/外部材料）不可修复，
                    # 内容仍用 Python 确定性切分结果，不拿模型编的内容顶替。
                    stem, opts = strategy.split_options(q.content)
                    item_content, item_options = stem, opts
                    item_material_text = q.material_text or None
                    item_answer = q.answer
                    note = "不可修复，按 Python 原文入库并标待复核（is_active=0）"
                # 记日志：原始 content + 修复后 + issues，供人工复核
                issues_log.append({
                    "group_order": q.group_order,
                    "issues": q.completeness_issues,
                    "original_content": q.content,
                    "regenerated": regen,
                })
                print(f"[WARN] 题{q.group_order} 完整性缺陷: {q.completeness_issues}"
                      f" → {note}（见 labeling_issues.jsonl）", flush=True)
            if q.type == "choice" and item_options:
                item_answer = _normalize_choice_answer(item_answer, item_options)
            item = {
                "subject_id": subject_code,
                "group_id": q.group_id,
                "group_order": q.group_order,
                # 大题标题写明「多项选择题」时以卷面为准（labeler 只会给 choice）
                "type": "multi_choice" if getattr(q, "multi_choice", False) else q.type,
                "difficulty": q.difficulty,
                "full_score": q.score,
                "content": item_content,
                "options": item_options,
                "answer": item_answer,
                "explanation": q.explanation,
                "material_text": item_material_text,
                "grade_band": grade_band,
                "source": source_name,
                "source_year": source_year,
                "knowledge_points": q.knowledge_points,
                "_confirmed_new_kps": q._confirmed_new_kps,
                "_suggested_new_kps": q._suggested_new_kps,
                # 内容由 LLM 补全/修复过，或选择题却没有选项 → 入库置 is_active=0，
                # 人工复核后再放行（选项残缺的选择题进池就是废题）
                "needs_review": bool(
                    (not q.is_complete) or (q.type == "choice" and not item_options)
                ),
            }
            f.write(json.dumps(item, ensure_ascii=False) + "\n")
    # 写完整性缺陷日志（供人工复核）
    if issues_log:
        log_path = extracted_dir.parent / "labeling_issues.jsonl"
        with log_path.open("a", encoding="utf-8") as lf:
            for rec in issues_log:
                rec["source"] = source_name
                lf.write(json.dumps(rec, ensure_ascii=False) + "\n")
        repaired = sum(1 for r in issues_log if r.get("regenerated"))
        print(f"[issues] {len(issues_log)} 题有完整性缺陷（LLM 修复 {repaired}，"
              f"仅报告 {len(issues_log) - repaired}），全部按 needs_review 入库"
              f"（is_active=0，不进抽题池）；原始内容见 {log_path}", flush=True)
    return out_file


def _judge_suspects(llm, suspects: list[dict], paper_stem: str) -> set[int]:
    """把裸题号候选行批量交 LLM 复核，返回可采纳的行索引集合。

    只采纳 `is_stem=true` 且 `number == expected` 的条目（防幻觉/防把数据行当题号）。
    LLM 不可用或返回异常 → 返回空集，这些题仍由第 6 步扫描报出来走人工补题。
    """
    if not suspects:
        return set()
    try:
        prompt_path = Path(__file__).parent / "prompts" / "stem_judge.txt"
        system = prompt_path.read_text(encoding="utf-8")
    except OSError:
        system = (
            "判断每行是不是试卷新题的开头，只输出 JSON："
            '{"stems":[{"line_no":123,"number":11,"is_stem":true}]}'
        )
    lines_block = []
    for i, s in enumerate(suspects):
        lines_block.append(
            f"--- 候选{ i + 1} 行号={s['line_no']} 期望题号={s['expected']} ---\n"
            f"前文：{s.get('before','')}\n"
            f"本行：{s['text']}\n"
            f"后文：{s.get('after','')}"
        )
    user = "\n\n".join(lines_block)
    try:
        resp = llm.complete(system, user)
        data = _parse_json_object(resp.content or "")
    except Exception as exc:
        print(f"[stem-judge] {paper_stem}: LLM 复核失败（{exc}），按规则结果继续",
              flush=True)
        return set()

    accepted: set[int] = set()
    by_line = {s["line_no"]: s for s in suspects}
    for item in data.get("stems", []):
        try:
            line_no = int(item.get("line_no"))
            number = int(item.get("number"))
        except (TypeError, ValueError):
            continue
        if not item.get("is_stem"):
            continue
        s = by_line.get(line_no)
        if s and number == s["expected"]:
            accepted.add(line_no)
    if accepted:
        print(f"[stem-judge] {paper_stem}: LLM 采纳 {len(accepted)} 行裸题号"
              f"（题号 {[by_line[i]['number'] for i in sorted(by_line) if i in accepted]}）",
              flush=True)
    # 留痕：所有候选与结论都落 split_suspects.jsonl，便于复盘
    try:
        log_path = Path(__file__).resolve().parents[1] / "output" / "split_suspects.jsonl"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("a", encoding="utf-8") as fh:
            for s in suspects:
                fh.write(json.dumps({
                    "paper": paper_stem,
                    "line_no": s["line_no"],
                    "expected": s["expected"],
                    "number": s["number"],
                    "text": s["text"],
                    "accepted": s["line_no"] in accepted,
                }, ensure_ascii=False) + "\n")
    except OSError:
        pass
    return accepted


def extract_questions_file(source, config, llm, fb_llm,
                            extracted_dir: Path, label_batch_size: int = 1) -> int:
    """处理单个试卷 MD：切题 + 标注 + 写 JSONL。返回切出的题数。

    Args:
        source: MarkdownSource（有 md_path / rel_path / kind）
        config: RefineryConfig
        llm: 主模型 LLMClient
        fb_llm: 兜底模型 LLMClient（双模型确认新增 KP）
        extracted_dir: output/extracted
        label_batch_size: 每 N 题一批调 LLM。1=每题单独，0=全部一次

    Returns:
        切出的题数（0 = 空试卷）
    """
    md_path = source.md_path
    filename = md_path.name
    rel_parts = Path(str(source.rel_path)).parts

    # 0. 清掉本卷上一轮的 completeness / label_failed 记录：labeling_issues.jsonl
    #    是追加日志，不清会让已修复的旧记录（缺图误判、标注失败兜底）一直留在
    #    识别问题扫描里，让人反复确认已完整的题（2026-11-03 题18/21）。
    _purge_labeling_issues_for_source(
        extracted_dir.parent / "labeling_issues.jsonl", md_path.stem)

    # 1. 读 MD + 全角括号归一
    text = md_path.read_text(encoding="utf-8")
    text = normalize_fullwidth_parens(text)

    # 2. 答案合并检测（4 case）
    text = maybe_merge_answer_md(md_path, text)

    # 2.5 二维码过滤（切题前，页级）：试卷页脚的公众号二维码会被当作题干/选项配图，
    # 在切题前删掉，避免被 split_options 的"上方最近图片"规则误挂到选项上。
    # 放在答案合并之后，使题干/选项/解析（来自答案 md）三条链路一次性清掉。
    text = strip_qr_images(text, md_path.parent)

    # 3. 元数据（学科决定切分策略，需在切分前）
    subject_code = _subject_code_for(rel_parts)
    strategy = get_strategy(subject_code)
    grade_band = _grade_band_for(filename)
    source_year = _source_year_for(filename)

    # 4. 题号切分 + 答案对齐（一次扫描）
    # 材料归属（语文阅读材料写在题号之前、按小节归属到每道题）由学科策略决定，
    # 其它学科的策略 attach=False，行为不变。
    suspects: list[dict] = []
    questions = split_page(text, md_path, strategy=strategy, suspects_out=suspects)
    # 裸题号兜底：规则没认、又没满足 4 条采纳条件的候选行，整卷一次交 LLM 复核；
    # 模型说"是题"且题号 == 期望值的才采纳，重跑一遍切分把这几行强制当题号。
    if suspects and llm is not None:
        accepted = _judge_suspects(llm, suspects, md_path.stem)
        if accepted:
            questions = split_page(text, md_path, strategy=strategy,
                                   forced_stem_lines=accepted)
    # 卷首页脚/署名会被切题器当成一道题，占掉真实题号（北师大实验 2024：题4）
    kept = [q for q in questions if not is_junk_question(q)]
    if len(kept) != len(questions):
        dropped = [q.group_order for q in questions if is_junk_question(q)]
        print(f"[WARN] {md_path.stem}: 丢弃 {len(questions) - len(kept)} 条非题目行"
              f"（命题人/页脚等），原题号 {dropped}", flush=True)
    questions = kept
    if not questions:
        return 0

    # 题内材料切分（2026-11-02，物理/化学/道法）：材料与小问在同一题号内
    # （`31. 阅读以下文字…` + 材料 + `(1)(2)(3)`），切成 material_text + content。
    # 已有跨题材料（语文/英语的 material_policy）不动；其他学科默认不切。
    _split_inline_material(strategy, questions)

    # 题号缺号告警：MinerU 偶尔整题没转出来（大兴 2024 题18 只剩答案、正文缺失），
    # 切分器无法凭空补，只能显式告警让人核对 PDF。
    nums = {q.group_order for q in questions}
    missing = [n for n in range(min(nums), max(nums) + 1) if n not in nums]
    if missing:
        print(f"[WARN] {md_path.stem}: 题号不连续，缺 {missing}"
              f"（原文可能未转换出这些题，请核对 PDF）", flush=True)

    # 切题后、标注前：把文字版 PDF 的下划线/着重号注入题干与材料。
    # 顺序不能反 —— 标注时看不到标记，模型会把「画线句」判成原文缺失。
    if subject_code == "chinese":
        decorations = _pdf_decorations(source, config)
        injected = _apply_emphasis(questions, decorations)
        if decorations:
            print(f"[emphasis] {source.md_path.stem}: {len(decorations)} 处标记，"
                  f"注入 {injected} 处", flush=True)
        else:
            print(f"[emphasis] {source.md_path.stem}: 无文字层或未检出标记（扫描件），跳过",
                  flush=True)

    # 5. 查真实 KP 列表 + LLM 标注 + 双模型确认
    kps = _query_knowledge_points(config, subject_code)
    prompt = _load_labeler_prompt(subject_code)
    fb_labeler = None
    if fb_llm is not None:
        fb_labeler = QuestionLabeler(llm=fb_llm, prompt=prompt, knowledge_points=kps,
                                     subject=subject_code)
    labeler = QuestionLabeler(llm=llm, prompt=prompt, knowledge_points=kps,
                               fallback_labeler=fb_labeler, subject=subject_code)
    # 进度预声明：让用户选完试卷类型后立刻看到"正在处理"，而不是 1-2 分钟静默
    # （26 题 × 每题几秒 = 1-2 分钟无输出，2026-11-03 用户反馈）
    print(f"[label] {len(questions)} 题待标注（batch_size={label_batch_size}），"
          f"逐题调 LLM…", flush=True)
    labeled = labeler.label(questions, batch_size=label_batch_size)
    # 标注失败（校验+重试+备选均败）：**不丢题**，用确定性兜底（2026-10-28）
    # LLM 网关抖动时每轮会随机挂 1 题，若直接跳过会导致试卷缺题、重载后题库少题。
    # 兜底：题型按「能否拆出 4 个选项」判，难度默认 2，知识点留空（后续标定），
    # 完整性标 True（不做 LLM 修复），并在日志里标明来源。
    failed = [q for q, lab in zip(questions, labeled) if lab is None]
    if failed:
        log_path = extracted_dir.parent / "labeling_issues.jsonl"
        with log_path.open("a", encoding="utf-8") as lf:
            for q in failed:
                lf.write(json.dumps({
                    "source": md_path.stem,
                    "group_order": q.group_order,
                    "type": "label_failed_fallback",
                    "issues": ["LLM 标注失败，已用确定性兜底（题型按选项判定、难度 2）"],
                }, ensure_ascii=False) + "\n")
        print(f"[WARN] {len(failed)} 题标注失败，已用确定性兜底保留（题号 "
              f"{[q.group_order for q in failed]}），详见 {log_path}", flush=True)
        labeled = [
            lab if lab is not None else _fallback_label(q, subject_code)
            for q, lab in zip(questions, labeled)
        ]
    labeled = labeler.confirm_new_kps(labeled)
    # 确定性题型校正：能拆出完整选项的一律按选择题入库（LLM 偶发把选择题标成 short_answer）。
    # 「完整」的项数区间由策略 `choice_bounds()` 决定（语文 3–6，其余 4–4）。
    choice_low, choice_high = strategy.choice_bounds()
    for lab in labeled:
        _, opts = strategy.split_options(lab.content)
        if not opts:
            continue
        enough = choice_low <= len(opts) <= choice_high
        if enough and lab.type != "choice":
            lab.type = "choice"

    # 5.5 题型以「大题」为准：先划出每个大题覆盖的题号区间及题型，再整段覆盖。
    #     单题特征（能不能拆出 A–D）只在没有大题信息时兜底——物理实验题常用 A/B/C/D
    #     标四个实验图，按特征判会把整节实验题改成选择题（人大附第 22 题，2026-11-01）。
    section_types, sections = analyze_sections(text, subject_code)
    if sections:
        overridden = 0
        for lab in labeled:
            t = section_types.get(lab.group_order)
            if t and lab.type != t:
                lab.type = t
                overridden += 1
        detail = "，".join(f"{s.gid}:{s.start_no}-{s.end_no}={s.type}"
                          f"{'(推断)' if s.inferred else ''}" for s in sections)
        print(f"[sections] 按大题定型 {detail}；纠正 {overridden} 题", flush=True)

    # 判断题的题干本来就是陈述句：定型之后 type 才是准的，这时再清一次「缺设问」误判
    # （LLM 常把判断题标成 short_answer，labeler 阶段判据还不成立）。
    exemption = apply_true_false_exemption(labeled)
    if exemption:
        print(f"[true_false] {exemption} 道判断题按陈述句放行（无设问不算缺陷）", flush=True)
    subq = apply_material_subq_exemption(labeled)
    if subq:
        print(f"[material] {subq} 道材料题的「仅切到第(1)问」是误判（content 里有 (2)）",
              flush=True)
    sections_fp = apply_material_sections_exemption(labeled)
    if sections_fp:
        print(f"[material] {sections_fp} 道材料题的「缺素材①②③」是误判"
              f"（材料已分 ≥3 段）", flush=True)

    # 6. 写 JSONL
    _write_exam_questions_jsonl(labeled, source, extracted_dir,
                                 subject_code, grade_band, source_year)
    return len(labeled)
