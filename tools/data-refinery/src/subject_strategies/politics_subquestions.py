"""道法小问拆分：材料→(1)→材料→(2) 切成多条 RawQuestion。

规则见 docs/superpowers/specs/2026-11-23-politics-subquestion-split-design.md。
分值只展示，不参与能否拆的判定。
"""

import re
from dataclasses import replace

MARK_RE = re.compile(r"^[（(]\s*(\d{1,2})\s*[）)]")
SCORE_LINE_RE = re.compile(r"[（(]\s*(\d{1,3})\s*分\s*[）)]\s*$")
MATERIAL_HEAD_RE = re.compile(r"^(#{1,6}\s|【|☆|<table|!\[)")
ASK_RE = re.compile(r"[？?]|请|结合|谈谈|说明|分析|写|补全|推荐|认识")
REFER_RE = re.compile(r"结合材料|根据材料|上述材料|结合两个活动|依据材料")
ARTIFACT_LINES = {"+学科观点"}

# 末句设问规则（从 material_split.py 搬来，只服务道法）
MIN_CONTENT_LEN = 100
MIN_MATERIAL_LEN = 60
_TAIL_LEAD = ("结合", "根据", "运用", "请", "谈谈", "说说", "简述",
              "分析", "评析", "说明", "为")
_TAIL_HINTS = ("结合材料", "运用所学", "谈谈你的", "说说你的")
_MIN_TAIL_LEN, _MAX_TAIL_LEN = 8, 120
_SUBQ1 = re.compile(r"^[ \t]*[（(]?1[）)][ \t]*\S", re.MULTILINE)
_OPTION_LINE = re.compile(r"(?m)^[ \t]*[（(]?[A-D][)）]?[ \t]*[.．、][ \t]*\S")


def _drop_artifacts(text: str) -> str:
    kept = [line for line in text.split("\n") if line.strip() not in ARTIFACT_LINES]
    return "\n".join(kept).strip()


def _score_of(body: str) -> int | None:
    for line in body.split("\n"):
        m = SCORE_LINE_RE.search(line)
        if m:
            return int(m.group(1))
    return None


def _body_end(lines: list[str], start: int, end: int) -> int:
    """正文最后一行：优先分值行，其次下一个材料头的前一行，最后到段尾。"""
    for j in range(start, end):
        if SCORE_LINE_RE.search(lines[j]):
            return j
    for j in range(start + 1, end):
        if MATERIAL_HEAD_RE.match(lines[j].strip()):
            return j - 1
    return max(start, end - 1)


def _marks(lines: list[str]) -> list[tuple[int, int]]:
    return [(i, int(m.group(1))) for i in range(len(lines))
            if (m := MARK_RE.match(lines[i].strip()))]


def _split_answer(answer: str, n: int) -> list[str]:
    if not answer or not answer.strip():
        return []
    lines = answer.split("\n")
    marks = _marks(lines)
    nums = [x for _, x in marks]
    if len(marks) != n or nums != list(range(1, n + 1)):
        print(f"[politics] 答案无法按小问拆分（{nums}），已清空待回填", flush=True)
        return []
    out = []
    for k, (i, _n) in enumerate(marks):
        end = marks[k + 1][0] if k + 1 < len(marks) else len(lines)
        seg = "\n".join(lines[i:end]).strip()
        out.append(MARK_RE.sub("", seg, count=1).strip())
    return out


def _split_one(q):
    lines = q.content.split("\n")
    marks = _marks(lines)
    nums = [n for _, n in marks]
    if len(marks) < 2 or nums != list(range(1, len(nums) + 1)):
        return [q]

    bodies = []
    for k, (i, _n) in enumerate(marks):
        end = marks[k + 1][0] if k + 1 < len(marks) else len(lines)
        j = _body_end(lines, i, end)
        body = _drop_artifacts("\n".join(lines[i:j + 1]))
        if not body or not ASK_RE.search(body):
            return [q]
        bodies.append((i, j, body))

    out, accumulated = [], []
    for k, (i, j, body) in enumerate(bodies):
        start = bodies[k - 1][1] + 1 if k > 0 else 0
        material = _drop_artifacts("\n".join(lines[start:i]))
        if not material and REFER_RE.search(body) and accumulated:
            material = "\n\n".join(accumulated)
        if material:
            accumulated.append(material)
        out.append(replace(
            q, content=body, material_text=material or None,
            material_position="before" if material else None,
            score=_score_of(body), sub_no=k + 1, answer="", explanation=None,
            post_material_base=None, post_material_appended=None,
            post_material_pending=None,
        ))

    answers = _split_answer(q.answer, len(out))
    if answers:
        for k, item in enumerate(out):
            item.answer = answers[k]
    return out


def split_tail_question_rule(content: str) -> tuple[str | None, str]:
    """「材料 + 末句设问」→ (material, 设问)；切不动返回 (None, content)。"""
    if not content or len(content) < MIN_CONTENT_LEN:
        return (None, content)
    if _SUBQ1.search(content):
        return (None, content)
    body = content.rstrip()
    cut = body.rfind("\n")
    if cut <= 0:
        return (None, content)
    tail = body[cut + 1:].strip()
    material = content[:cut + 1]
    rest = content[cut + 1:]
    if not (_MIN_TAIL_LEN <= len(tail) <= _MAX_TAIL_LEN):
        return (None, content)
    if not (tail.startswith(_TAIL_LEAD) or any(h in tail for h in _TAIL_HINTS)):
        return (None, content)
    if len(material.strip()) < MIN_MATERIAL_LEN:
        return (None, content)
    if len(_OPTION_LINE.findall(material)) >= 2:
        return (None, content)
    return (material, rest)


def expand(questions):
    """入口：逐题拆小问；单小问材料题补 material_text 与 before 位置。"""
    out = []
    for q in questions:
        parts = _split_one(q)
        if len(parts) == 1 and parts[0] is q:
            material, rest = split_tail_question_rule(q.content)
            if material:
                out.append(replace(q, content=rest.strip(),
                                   material_text=material.strip(),
                                   material_position="before"))
            elif (q.material_text or "").strip():
                out.append(replace(q, material_position="before"))
            else:
                out.append(q)
            continue
        out.extend(parts)
    return out
