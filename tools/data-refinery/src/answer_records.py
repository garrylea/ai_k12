"""answer_records：JSONL 题目内容记录的解析/校验 + export 序列化（纯函数层）。

一条记录 = JSONL 一行（`#` 开头为注释，空行忽略）：

    定位键（三选一，必填）：
        question_id                 questions.id
        paper_id + question_no      试卷内印刷题号（经 paper_questions 定位）
        content_hash                questions.content_hash
    内容字段（至少出现一个键）：
        answer / approach / explanation / type
    可选：
        note        自由备注（仅报告回显，不入库）
        _ref        export 产物中的只读参考，导入时忽略

归一化：内容字段为 null / 空串 / 纯空白 -> None（= 不修改，见 spec §5）。
"""

import json
import re
from dataclasses import dataclass

VALID_TYPES = {"choice", "fill_blank", "true_false", "short_answer", "proof", "calculation"}
CONTENT_FIELDS = ("answer", "approach", "explanation", "type")
_HASH_RE = re.compile(r"^[0-9a-f]{64}$")


class AnswerRecordError(ValueError):
    """记录格式/内容不合法（定位键缺失或冲突、非 JSON、非法题型等）。"""


@dataclass
class AnswerRecord:
    # 定位键
    question_id: int | None = None
    paper_id: int | None = None
    question_no: int | None = None
    content_hash: str | None = None
    # 内容字段（None = 不修改）
    answer: str | None = None
    approach: str | None = None
    explanation: str | None = None
    type: str | None = None
    # 元数据
    note: str | None = None
    line_no: int = 0

    def locator(self) -> str:
        """人类可读定位标签（报告用）。"""
        if self.question_id is not None:
            return f"questions#{self.question_id}"
        if self.paper_id is not None:
            return f"paper#{self.paper_id} 题{self.question_no}"
        return f"hash:{(self.content_hash or '')[:8]}"

    def has_content(self) -> bool:
        return any(getattr(self, f) is not None for f in CONTENT_FIELDS)


def _norm_text(value, line_no: int, name: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise AnswerRecordError(f"第 {line_no} 行字段 {name} 必须是字符串")
    value = value.strip()
    return value or None


def _req_int(value, line_no: int, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise AnswerRecordError(f"第 {line_no} 行字段 {name} 必须是正整数")
    return value


def _build_record(data: dict, line_no: int) -> AnswerRecord:
    has_qid = data.get("question_id") is not None
    has_paper = data.get("paper_id") is not None or data.get("question_no") is not None
    has_hash = data.get("content_hash") is not None
    kinds = [k for k, ok in (("question_id", has_qid), ("paper", has_paper),
                             ("content_hash", has_hash)) if ok]
    if len(kinds) != 1:
        raise AnswerRecordError(
            f"第 {line_no} 行必须且只能提供一种定位键"
            f"（question_id / paper_id+question_no / content_hash），当前：{kinds or '无'}"
        )

    rec = AnswerRecord(line_no=line_no)
    if has_qid:
        rec.question_id = _req_int(data["question_id"], line_no, "question_id")
    elif has_hash:
        ch = data["content_hash"]
        if not isinstance(ch, str) or not _HASH_RE.match(ch.strip().lower()):
            raise AnswerRecordError(f"第 {line_no} 行 content_hash 必须是 64 位十六进制字符串")
        rec.content_hash = ch.strip().lower()
    else:
        if data.get("paper_id") is None or data.get("question_no") is None:
            raise AnswerRecordError(f"第 {line_no} 行 paper 定位必须同时提供 paper_id 与 question_no")
        rec.paper_id = _req_int(data["paper_id"], line_no, "paper_id")
        rec.question_no = _req_int(data["question_no"], line_no, "question_no")

    if not any(k in data for k in CONTENT_FIELDS):
        raise AnswerRecordError(
            f"第 {line_no} 行缺少内容字段（至少提供一个：{'/'.join(CONTENT_FIELDS)}）"
        )
    rec.answer = _norm_text(data.get("answer"), line_no, "answer")
    rec.approach = _norm_text(data.get("approach"), line_no, "approach")
    rec.explanation = _norm_text(data.get("explanation"), line_no, "explanation")
    rec.type = _norm_text(data.get("type"), line_no, "type")
    if rec.type is not None and rec.type not in VALID_TYPES:
        raise AnswerRecordError(
            f"第 {line_no} 行题型非法：{rec.type}（允许：{' | '.join(sorted(VALID_TYPES))}）"
        )
    rec.note = _norm_text(data.get("note"), line_no, "note")
    return rec


def parse_answer_records(text: str) -> list[AnswerRecord]:
    """解析 JSONL 文本为 AnswerRecord 列表；空行与 `#` 注释行忽略。"""
    records: list[AnswerRecord] = []
    seen: dict[str, int] = {}
    for i, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError as e:
            raise AnswerRecordError(f"第 {i} 行 JSON 解析失败：{e}") from e
        if not isinstance(data, dict):
            raise AnswerRecordError(f"第 {i} 行必须是 JSON 对象")
        rec = _build_record(data, i)
        key = rec.locator()
        if key in seen:
            raise AnswerRecordError(f"第 {i} 行定位键重复：{key}（首次出现于第 {seen[key]} 行）")
        seen[key] = i
        records.append(rec)
    if not records:
        raise AnswerRecordError("文件中没有任何有效记录")
    return records


@dataclass
class ExportRow:
    question_id: int
    content: str
    type: str
    answer: str
    options: str | None = None
    approach: str | None = None
    explanation: str | None = None
    paper_id: int | None = None
    question_no: int | None = None


def build_export_jsonl(rows: list[ExportRow]) -> str:
    """把待补模板序列化成 JSONL：顶层可填写字段置空，`_ref` 为只读参考。"""
    lines: list[str] = []
    for r in rows:
        obj = {
            "question_id": r.question_id,
            "answer": "",
            "approach": "",
            "explanation": "",
            "_ref": {
                "content": r.content,
                "options": r.options,
                "type": r.type,
                "answer": r.answer,
                "approach": r.approach,
                "explanation": r.explanation,
                "paper_id": r.paper_id,
                "question_no": r.question_no,
            },
        }
        lines.append(json.dumps(obj, ensure_ascii=False))
    return "\n".join(lines) + ("\n" if lines else "")
