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
from question_splitter import split_page, split_options
from question_labeler import QuestionLabeler, LabeledQuestion
from qr_detect import strip_qr_images
from subject_codes import subject_code_for_parts


def _subject_code_for(rel_parts: tuple[str, ...]) -> str:
    """从文件相对路径首段（中文学科名）推导 subject code。"""
    return subject_code_for_parts(rel_parts)


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


# LLM 修复时出现过的占位/缺失说明（不是题目内容，绝不能入库）
_PLACEHOLDER_HINTS = (
    "此处应填入", "此处缺失", "需补充", "待补充", "占位", "原文缺失", "材料缺失说明",
)


def _fallback_label(q):
    """标注失败时的确定性兜底标签（不丢题）。"""
    from question_labeler import LabeledQuestion

    lab = LabeledQuestion.from_raw(q)
    _, opts = split_options(q.content)
    lab.type = "choice" if opts else "short_answer"
    lab.difficulty = 2
    lab.is_complete = True  # 不做 LLM 修复，保持切分原文
    lab.completeness_issues = ["LLM 标注失败，已用确定性兜底（题型按选项判定）"]
    return lab


def is_placeholder_text(text: str | None) -> bool:
    """是否为 LLM 修复产出的占位/缺失说明（而非真实内容）。"""
    if not text:
        return False
    return any(hint in text for hint in _PLACEHOLDER_HINTS)


def _safe_regenerated(regen: dict, q) -> tuple[str, object, str | None, str]:
    """取修复后内容，但占位文本一律回退原始切分结果。

    2026-10-28 实测：材料归属缺失时 LLM 曾把 material_text 写成
    「【注：此处应填入…】」占位说明，直接入库会污染题库。
    """
    content = regen.get("content") or q.content
    if is_placeholder_text(content):
        content = q.content
    options = regen.get("options")
    material = regen.get("material_text")
    if is_placeholder_text(material):
        material = q.material_text
    answer = regen.get("answer", q.answer) or q.answer
    return content, options, material, answer


def _write_exam_questions_jsonl(labeled: list, source, extracted_dir: Path,
                                 subject_code: str, grade_band: str,
                                 source_year: int):
    """组装 ExamQuestion JSONL（扩展字段带下划线前缀，publish 原样保留）。"""
    rel_file = source.rel_path / source.md_path.name
    out_file = extracted_dir / rel_file.with_suffix(".jsonl")
    out_file.parent.mkdir(parents=True, exist_ok=True)
    source_name = source.md_path.stem  # 文件名去扩展名
    issues_log: list[dict] = []  # 完整性缺陷日志（原始+修复后+issues），供人工复核
    with out_file.open("w", encoding="utf-8") as f:
        for q in labeled:
            if q.is_complete:
                # 正常路径：Python 确定性拆选项，content 保留所有题干配图
                stem, opts = split_options(q.content)
                item_content, item_options = stem, opts
                item_material_text = q.material_text or None
                item_answer = q.answer
            else:
                # 兜底路径：LLM 修复原题（regenerated），用修复后内容入库
                regen = q.regenerated or {}
                item_content, item_options, item_material_text, item_answer = _safe_regenerated(regen, q)
                if is_placeholder_text((regen.get("material_text") or "")) or \
                        is_placeholder_text(regen.get("content")):
                    print(f"[WARN] 题{q.group_order} 修复内容含占位文本，已回退原始切分结果",
                          flush=True)
                # 记日志：原始 content + 修复后 + issues，供人工复核
                issues_log.append({
                    "group_order": q.group_order,
                    "issues": q.completeness_issues,
                    "original_content": q.content,
                    "regenerated": regen,
                })
                print(f"[WARN] 题{q.group_order} 完整性缺陷: {q.completeness_issues}"
                      f" → 用 LLM 修复后内容入库（见 labeling_issues.jsonl）", flush=True)
            item = {
                "subject_id": subject_code,
                "group_id": q.group_id,
                "group_order": q.group_order,
                "type": q.type,
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
            }
            f.write(json.dumps(item, ensure_ascii=False) + "\n")
    # 写完整性缺陷日志（供人工复核）
    if issues_log:
        log_path = extracted_dir.parent / "labeling_issues.jsonl"
        with log_path.open("a", encoding="utf-8") as lf:
            for rec in issues_log:
                rec["source"] = source_name
                lf.write(json.dumps(rec, ensure_ascii=False) + "\n")
        print(f"[issues] {len(issues_log)} 题有完整性缺陷，已用 LLM 修复后内容入库，"
              f"原始+修复后见 {log_path}", flush=True)
    return out_file


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
    grade_band = _grade_band_for(filename)
    source_year = _source_year_for(filename)

    # 4. 题号切分 + 答案对齐（一次扫描）
    # 语文阅读材料写在题号之前（材料一/二/三），按小节归属到每道题；
    # 其他学科保持旧行为（材料不归属）。
    questions = split_page(text, md_path, attach_material=(subject_code == "chinese"))
    if not questions:
        return 0

    # 5. 查真实 KP 列表 + LLM 标注 + 双模型确认
    kps = _query_knowledge_points(config, subject_code)
    prompt = _load_prompt("question_labeler")
    fb_labeler = None
    if fb_llm is not None:
        fb_labeler = QuestionLabeler(llm=fb_llm, prompt=prompt, knowledge_points=kps)
    labeler = QuestionLabeler(llm=llm, prompt=prompt, knowledge_points=kps,
                               fallback_labeler=fb_labeler)
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
            lab if lab is not None else _fallback_label(q)
            for q, lab in zip(questions, labeled)
        ]
    labeled = labeler.confirm_new_kps(labeled)
    # 确定性题型校正：能拆出 4 个选项的一律按选择题入库（LLM 偶发把选择题标成 short_answer）
    for lab in labeled:
        _, opts = split_options(lab.content)
        if opts and len(opts) == 4 and lab.type != "choice":
            lab.type = "choice"

    # 6. 写 JSONL
    _write_exam_questions_jsonl(labeled, source, extracted_dir,
                                 subject_code, grade_band, source_year)
    return len(labeled)
