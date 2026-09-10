# 题目内容更新工具（answer_importer 扩展）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `tools/data-refinery` 扩展 `answer_importer`——把 JSONL/Markdown 里的题目内容（answer/approach/explanation/type）按单题/批量/按卷/按缺口多种粒度回写 `questions`，dry-run 出 diff、`--apply` 确认写入、幂等可重跑。

**Architecture:** 四层纯函数 + 一层编排——`answer_records.py`（JSONL 解析/校验 + export 序列化）、`answer_doc.py`（Markdown 按卷文档解析）、`answer_importer.py`（范围 SQL、记录分类、diff、报告）、`answer_importer_cli.py`（pymysql 连库 + 定位 + 编排）。前三层不依赖 DB，全部可单测。

**Tech Stack:** Python 3 + pymysql + pytest（沿用 `tools/data-refinery` 既有栈；模板：`src/backfill_question_kps.py` 的连库/argparse 模式）。

**设计文档:** `docs/superpowers/specs/2026-09-10-question-content-importer-design.md`

## Global Constraints

- 工作目录 `tools/data-refinery/`；测试命令 `pytest tests/test_xxx.py -q`（根 `conftest.py` 已把 `src/` 加入 `sys.path`，测试用扁平 import，如 `from answer_records import ...`）。
- DB：`ai_k12/ai_k12@localhost/ai_k12`（`.env` 的 `DB_*`，经 `config.RefineryConfig.from_env()`）。
- 回写语义（spec §5）：字段**缺省=不改**；**非空=覆盖**；**空串/纯空白=视为未提供（不改）**；`type` 非法=该条报错跳过；任一字段实际写入=同条 UPDATE 内置 `answer_verified = 1`；diff 为空=不发 UPDATE（幂等）。
- 不提供「清空字段」语义；`question_no` 只能与 `paper_id` 搭配。
- 安全：默认 dry-run，`--apply` 才写；写入前交互输 `yes`；`--limit` 默认 `500`，超出拒绝。
- 退出码：`0` 成功 / `1` 用户取消 / `2` 参数或文档错误。
- 提交信息用 Conventional Commits，scope 用 `data-refinery` / `db`。
- 所有新文件 UTF-8；代码注释用中文（与既有模块一致）。

---

### Task 1: DB 迁移——questions.approach + answer_verified

**Files:**
- Create: `tools/db/migrations/2026-09-10_add_questions_approach_verified.sql`
- Modify: `tools/db/schema.sql:220`（`explanation` 后插 `approach`）、`tools/db/schema.sql:227`（`is_active` 前插 `answer_verified`）
- Modify: `docs/K12智学系统-数据库设计文档.md`（questions 字段表，约 :476 与 :488）

**Interfaces:**
- Produces: 列 `questions.approach TEXT NULL`、`questions.answer_verified TINYINT(1) NOT NULL DEFAULT 0`（后续所有任务依赖）。

- [ ] **Step 1: 写迁移脚本**

`tools/db/migrations/2026-09-10_add_questions_approach_verified.sql`：

```sql
-- 2026-09-10 题目内容更新工具：新增解题思路列 + 人工/AI 核验标记。
-- approach        解题思路：方法/切入点概述（考点判断、选什么方法、关键转化），
--                 与 explanation（完整分步过程）分离。
-- answer_verified 由 answer_importer 成功写入任一字段（answer/approach/explanation/type）
--                 时置 1，用于与管线提取的原始数据（0）区分。
ALTER TABLE questions
  ADD COLUMN approach TEXT DEFAULT NULL AFTER explanation,
  ADD COLUMN answer_verified TINYINT(1) NOT NULL DEFAULT 0;
```

- [ ] **Step 2: 折回 schema.sql**

在 `tools/db/schema.sql:220` 的 `explanation TEXT DEFAULT NULL,` 之后插入一行：

```sql
  approach TEXT DEFAULT NULL,                       -- 解题思路（方法/切入点概述；折回自 migrations/2026-09-10_add_questions_approach_verified.sql）
```

在 `tools/db/schema.sql` 的 questions 表内 `is_active TINYINT(1) NOT NULL DEFAULT 1,` 之前插入一行（**注意**：该行文本在 schema.sql 多处出现，必须限定在 questions 表区段，见 :227）：

```sql
  answer_verified TINYINT(1) NOT NULL DEFAULT 0,    -- 人工/AI 核验导入标记（answer_importer 置 1）
```

结果（questions 表局部）应为：

```sql
  answer TEXT NOT NULL,
  explanation TEXT DEFAULT NULL,
  approach TEXT DEFAULT NULL,                       -- 解题思路（方法/切入点概述；折回自 migrations/2026-09-10_add_questions_approach_verified.sql）
  material_text TEXT DEFAULT NULL,
  ...
  content_hash CHAR(64) DEFAULT NULL,
  answer_verified TINYINT(1) NOT NULL DEFAULT 0,    -- 人工/AI 核验导入标记（answer_importer 置 1）
  is_active TINYINT(1) NOT NULL DEFAULT 1,
```

- [ ] **Step 3: 确认 db_loader 无需改动**

Run: `grep -n "INSERT INTO questions" tools/data-refinery/src/db_loader.py`
Expected: 命中一行，形如 `INSERT INTO questions (subject_id, group_id, ... content_hash) VALUES (...)`——**显式列清单**，新列走 DEFAULT，无需改动。若为 `SELECT *` 语义才需补列（本仓库当前为显式清单）。

- [ ] **Step 4: 应用迁移并验证列**

```bash
mysql -u ai_k12 -pai_k12 ai_k12 < tools/db/migrations/2026-09-10_add_questions_approach_verified.sql
mysql -u ai_k12 -pai_k12 ai_k12 -e "SHOW COLUMNS FROM questions LIKE 'approach'; SHOW COLUMNS FROM questions LIKE 'answer_verified';"
```

Expected: 两行；`approach` Default NULL、`answer_verified` Default `0`。

- [ ] **Step 5: 更新 DB 设计文档**

`docs/K12智学系统-数据库设计文档.md` 的 questions 字段表，在 `| explanation | ... |` 行后加：

```markdown
| approach | TEXT | YES | NULL | 解题思路（方法/切入点概述：考点判断、选什么方法、关键转化；与 explanation 完整过程分离） |
```

在 questions 表 `| content_hash | CHAR(64) | ... |` 行后、`| is_active | ... |` 行前加：

```markdown
| answer_verified | TINYINT(1) | NO | 0 | 人工/AI 核验导入标记（answer_importer 成功写入任一字段时置 1） |
```

- [ ] **Step 6: Commit**

```bash
git add tools/db/migrations/2026-09-10_add_questions_approach_verified.sql tools/db/schema.sql docs/K12智学系统-数据库设计文档.md
git commit -m "feat(db): questions 新增 approach 解题思路列 + answer_verified 核验标记"
```

---

### Task 2: answer_records.py——JSONL 解析/校验 + export 序列化

**Files:**
- Create: `tools/data-refinery/src/answer_records.py`
- Test: `tools/data-refinery/tests/test_answer_records.py`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `AnswerRecord`（dataclass：`question_id` / `paper_id` / `question_no` / `content_hash` / `answer` / `approach` / `explanation` / `type` / `note` / `line_no`；方法 `locator() -> str`、`has_content() -> bool`）
  - `AnswerRecordError(ValueError)`
  - `parse_answer_records(text: str) -> list[AnswerRecord]`
  - `ExportRow`（dataclass）与 `build_export_jsonl(rows: list[ExportRow]) -> str`
  - `VALID_TYPES: set[str]`、`CONTENT_FIELDS: tuple[str, ...]`
  - Task 3/4/5 均 import 这些符号。

- [ ] **Step 1: 写失败测试**

`tools/data-refinery/tests/test_answer_records.py`：

```python
"""answer_records：JSONL 记录解析/校验 + export 序列化。"""

import json

import pytest

from answer_records import (
    AnswerRecordError,
    ExportRow,
    build_export_jsonl,
    parse_answer_records,
)


class TestParseLocators:
    def test_question_id(self):
        recs = parse_answer_records('{"question_id": 7, "answer": "B"}')
        assert len(recs) == 1
        assert recs[0].question_id == 7
        assert recs[0].answer == "B"
        assert recs[0].locator() == "questions#7"

    def test_paper_no(self):
        recs = parse_answer_records('{"paper_id": 3, "question_no": 17, "approach": "设未知数"}')
        assert (recs[0].paper_id, recs[0].question_no) == (3, 17)
        assert recs[0].locator() == "paper#3 题17"

    def test_content_hash(self):
        h = "a" * 64
        recs = parse_answer_records(json.dumps({"content_hash": h, "explanation": "过程"}))
        assert recs[0].content_hash == h
        assert recs[0].locator() == "hash:aaaaaaaa"

    def test_comment_and_blank_lines_ignored(self):
        text = "# 注释\n\n" + '{"question_id": 1, "answer": "A"}' + "\n"
        assert len(parse_answer_records(text)) == 1


class TestParseErrors:
    def test_missing_locator(self):
        with pytest.raises(AnswerRecordError, match="定位键"):
            parse_answer_records('{"answer": "B"}')

    def test_two_locators(self):
        with pytest.raises(AnswerRecordError, match="定位键"):
            parse_answer_records('{"question_id": 1, "paper_id": 2, "question_no": 3, "answer": "A"}')

    def test_paper_partial(self):
        with pytest.raises(AnswerRecordError, match="paper_id 与 question_no"):
            parse_answer_records('{"paper_id": 2, "answer": "A"}')

    def test_no_content_field(self):
        with pytest.raises(AnswerRecordError, match="内容字段"):
            parse_answer_records('{"question_id": 1}')

    def test_invalid_type(self):
        with pytest.raises(AnswerRecordError, match="题型非法"):
            parse_answer_records('{"question_id": 1, "type": "single_choice"}')

    def test_bad_json(self):
        with pytest.raises(AnswerRecordError, match="JSON"):
            parse_answer_records("{not json}")

    def test_non_object(self):
        with pytest.raises(AnswerRecordError, match="JSON 对象"):
            parse_answer_records("[1, 2]")

    def test_bad_hash(self):
        with pytest.raises(AnswerRecordError, match="content_hash"):
            parse_answer_records('{"content_hash": "xyz", "answer": "A"}')

    def test_non_positive_question_id(self):
        with pytest.raises(AnswerRecordError, match="question_id"):
            parse_answer_records('{"question_id": 0, "answer": "A"}')

    def test_non_string_value(self):
        with pytest.raises(AnswerRecordError, match="answer"):
            parse_answer_records('{"question_id": 1, "answer": 123}')

    def test_duplicate_locator(self):
        text = '{"question_id": 1, "answer": "A"}\n{"question_id": 1, "answer": "B"}\n'
        with pytest.raises(AnswerRecordError, match="重复"):
            parse_answer_records(text)

    def test_empty_file(self):
        with pytest.raises(AnswerRecordError, match="没有任何有效记录"):
            parse_answer_records("\n# only comment\n")


class TestNormalization:
    def test_empty_strings_become_none(self):
        recs = parse_answer_records('{"question_id": 1, "answer": "", "approach": "  ", "explanation": "x"}')
        assert recs[0].answer is None
        assert recs[0].approach is None
        assert recs[0].explanation == "x"

    def test_has_content_false_when_all_empty(self):
        recs = parse_answer_records('{"question_id": 1, "answer": "", "approach": ""}')
        assert recs[0].has_content() is False

    def test_has_content_true(self):
        recs = parse_answer_records('{"question_id": 1, "approach": "配方"}')
        assert recs[0].has_content() is True

    def test_note_preserved(self):
        recs = parse_answer_records('{"question_id": 1, "answer": "A", "note": "核对过"}')
        assert recs[0].note == "核对过"


class TestExport:
    def test_round_trip_ignores_ref(self):
        rows = [ExportRow(question_id=9, content="题干", type="choice", answer="A",
                          options="[]", approach=None, explanation="旧解析",
                          paper_id=3, question_no=1)]
        recs = parse_answer_records(build_export_jsonl(rows))
        assert len(recs) == 1
        r = recs[0]
        assert r.question_id == 9
        assert r.answer is None and r.approach is None and r.explanation is None
        assert r.has_content() is False

    def test_ref_contains_old_values(self):
        rows = [ExportRow(question_id=9, content="题干", type="choice", answer="A",
                          explanation="旧解析")]
        obj = json.loads(build_export_jsonl(rows).strip())
        assert obj["_ref"]["answer"] == "A"
        assert obj["_ref"]["explanation"] == "旧解析"
        assert obj["answer"] == ""

    def test_empty_rows(self):
        assert build_export_jsonl([]) == ""
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd tools/data-refinery && pytest tests/test_answer_records.py -q`
Expected: FAIL（`ModuleNotFoundError: No module named 'answer_records'`）。

- [ ] **Step 3: 实现 answer_records.py**

`tools/data-refinery/src/answer_records.py`：

```python
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd tools/data-refinery && pytest tests/test_answer_records.py -q`
Expected: PASS（全部用例）。

- [ ] **Step 5: Commit**

```bash
git add tools/data-refinery/src/answer_records.py tools/data-refinery/tests/test_answer_records.py
git commit -m "feat(data-refinery): answer_records JSONL 解析/校验 + export 序列化"
```

---

### Task 3: answer_doc.py——Markdown 按卷文档解析

**Files:**
- Create: `tools/data-refinery/src/answer_doc.py`
- Test: `tools/data-refinery/tests/test_answer_doc.py`

**Interfaces:**
- Consumes: Task 2 的 `AnswerRecord`。
- Produces:
  - `AnswerDocError(ValueError)`
  - `AnswerDocItem`（`no` / `answer` / `approach` / `explanation` / `type_override`）、`AnswerDoc`（`title` / `items`）
  - `parse_answer_doc(text: str) -> AnswerDoc`
  - `doc_to_records(doc: AnswerDoc, paper_id: int) -> list[AnswerRecord]`
  - Task 5 的 CLI import 这些符号。

- [ ] **Step 1: 写失败测试**

`tools/data-refinery/tests/test_answer_doc.py`：

```python
"""answer_doc：Markdown 按卷答案文档解析。"""

import pytest

from answer_doc import AnswerDocError, doc_to_records, parse_answer_doc


class TestParseBasic:
    def test_标题与单题(self):
        doc = parse_answer_doc(
            "# 试卷：2024 海淀 初三 模拟二\n"
            "\n"
            "## 1\n"
            "答案：B\n"
            "思路：由顶点式可知顶点为 $(2,3)$。\n"
            "解析：完整过程。\n"
        )
        assert doc.title == "2024 海淀 初三 模拟二"
        assert len(doc.items) == 1
        it = doc.items[0]
        assert it.no == 1
        assert it.answer == "B"
        assert it.approach.startswith("由顶点式")
        assert it.explanation == "完整过程。"
        assert it.type_override is None

    def test_可选字段缺省(self):
        doc = parse_answer_doc("# 试卷：X\n## 2\n答案：$x=3$\n")
        assert doc.items[0].answer == "$x=3$"
        assert doc.items[0].approach == ""
        assert doc.items[0].explanation == ""

    def test_多题与题型标注(self):
        doc = parse_answer_doc(
            "# 试卷：X\n"
            "## 2\n答案：A\n"
            "## 17\n答案：解：所以 x=2。\n思路：设未知数。\n题型：calculation\n"
        )
        assert [i.no for i in doc.items] == [2, 17]
        assert doc.items[1].type_override == "calculation"

    def test_多行续写(self):
        doc = parse_answer_doc(
            "# 试卷：X\n"
            "## 25\n"
            "答案：（1）挥发性\n"
            "（2）$2H_2+O_2=2H_2O$\n"
            "思路：\n"
            "先判断物理性质，\n"
            "再写化学方程式。\n"
        )
        it = doc.items[0]
        assert it.answer == "（1）挥发性\n（2）$2H_2+O_2=2H_2O$"
        assert it.approach.startswith("先判断物理性质")
        assert it.approach.count("\n") == 1

    def test_全角冒号(self):
        doc = parse_answer_doc("# 试卷：X\n## 3\n答案：对\n思路：直接判断\n")
        assert doc.items[0].answer == "对"
        assert doc.items[0].approach == "直接判断"

    def test_空行断开续写(self):
        doc = parse_answer_doc("# 试卷：X\n## 3\n答案：第一行\n\n答案：第二行\n")
        assert doc.items[0].answer == "第二行"


class TestValidation:
    def test_缺答案报错(self):
        with pytest.raises(AnswerDocError, match="第 4 题.*答案"):
            parse_answer_doc("# 试卷：X\n## 4\n思路：只有思路\n")

    def test_非法题型报错(self):
        with pytest.raises(AnswerDocError, match="第 5 题.*题型"):
            parse_answer_doc("# 试卷：X\n## 5\n答案：B\n题型：单选题\n")

    def test_无标题报错(self):
        with pytest.raises(AnswerDocError, match="试卷标题"):
            parse_answer_doc("## 1\n答案：B\n")

    def test_无题目报错(self):
        with pytest.raises(AnswerDocError, match="没有任何题目"):
            parse_answer_doc("# 试卷：X\n")

    def test_题号去重后写覆盖(self):
        doc = parse_answer_doc("# 试卷：X\n## 1\n答案：A\n## 1\n答案：B\n")
        assert len(doc.items) == 1
        assert doc.items[0].answer == "B"


class TestToRecords:
    def test_映射为记录(self):
        doc = parse_answer_doc("# 试卷：X\n## 1\n答案：B\n思路：配方\n解析：过程\n题型：choice\n")
        recs = doc_to_records(doc, paper_id=3)
        assert len(recs) == 1
        assert recs[0].paper_id == 3
        assert recs[0].question_no == 1
        assert recs[0].answer == "B"
        assert recs[0].approach == "配方"
        assert recs[0].explanation == "过程"
        assert recs[0].type == "choice"

    def test_空可选字段为None(self):
        doc = parse_answer_doc("# 试卷：X\n## 1\n答案：B\n")
        rec = doc_to_records(doc, paper_id=3)[0]
        assert rec.approach is None
        assert rec.explanation is None
        assert rec.type is None
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd tools/data-refinery && pytest tests/test_answer_doc.py -q`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 answer_doc.py**

`tools/data-refinery/src/answer_doc.py`：

```python
"""answer_doc：Markdown 按卷答案文档解析（纯函数层）。

文档格式（spec 2026-09-10 §4.2）：

    # 试卷：<试卷标题>          —— 用于定位 exam_papers（可重名，CLI 列候选）
    ## <印刷题号>               —— 对应 paper_questions.question_no
    答案：<内容，可多行>         —— 必填；公式用 $...$ LaTeX
    思路：<内容，可多行>         —— 可选；写入 questions.approach
    解析：<内容，可多行>         —— 可选；写入 questions.explanation
    题型：calculation           —— 可选；仅需改标时写

多行续接：字段行之后的非空行接续到该字段（换行拼接），空行断开。
"""

import re
from dataclasses import dataclass, field

from answer_records import AnswerRecord, VALID_TYPES

HEADING_PAPER_RE = re.compile(r"^#\s*试卷[:：]\s*(.+?)\s*$")
HEADING_ITEM_RE = re.compile(r"^##\s*(\d+)\s*$")
FIELD_RE = re.compile(r"^(答案|思路|解析|题型)[:：]\s*(.*)$")
_FIELD_ATTR = {"答案": "answer", "思路": "approach", "解析": "explanation"}
_MULTILINE_FIELDS = ("答案", "思路", "解析")


class AnswerDocError(ValueError):
    """文档格式/内容不合法（缺答案、非法题型标注、缺标题等）。"""


@dataclass
class AnswerDocItem:
    no: int
    answer: str = ""
    approach: str = ""
    explanation: str = ""
    type_override: str | None = None


@dataclass
class AnswerDoc:
    title: str = ""
    items: list[AnswerDocItem] = field(default_factory=list)


def parse_answer_doc(text: str) -> AnswerDoc:
    doc = AnswerDoc()
    by_no: dict[int, AnswerDocItem] = {}
    current: AnswerDocItem | None = None
    field_name: str | None = None

    for raw in text.splitlines():
        line = raw.rstrip()

        m = HEADING_PAPER_RE.match(line)
        if m:
            doc.title = m.group(1)
            current, field_name = None, None
            continue

        m = HEADING_ITEM_RE.match(line)
        if m:
            no = int(m.group(1))
            current = by_no.get(no)
            if current is None:
                current = AnswerDocItem(no=no)
                by_no[no] = current
                doc.items.append(current)
            field_name = None
            continue

        if current is None:
            continue  # 标题前的杂项行忽略

        m = FIELD_RE.match(line)
        if m:
            field_name = m.group(1)
            value = m.group(2).strip()
            if field_name == "题型":
                current.type_override = value or None
            elif value:
                setattr(current, _FIELD_ATTR[field_name], value)
            continue

        if line.strip():
            if field_name in _MULTILINE_FIELDS:
                attr = _FIELD_ATTR[field_name]
                old = getattr(current, attr)
                setattr(current, attr, f"{old}\n{line.strip()}" if old else line.strip())
        else:
            field_name = None  # 空行断开续接

    _validate(doc)
    return doc


def _validate(doc: AnswerDoc) -> None:
    if not doc.title:
        raise AnswerDocError("缺少试卷标题（首行应为「# 试卷：<标题>」）")
    if not doc.items:
        raise AnswerDocError("文档中没有任何题目（需要「## <题号>」标记）")
    for it in doc.items:
        if not it.answer.strip():
            raise AnswerDocError(f"第 {it.no} 题缺少「答案：」字段（每题必写答案）")
        if it.type_override is not None and it.type_override not in VALID_TYPES:
            raise AnswerDocError(
                f"第 {it.no} 题题型标注非法：{it.type_override}"
                f"（仅允许 {' | '.join(sorted(VALID_TYPES))}）"
            )


def doc_to_records(doc: AnswerDoc, paper_id: int) -> list[AnswerRecord]:
    """把文档条目转成统一的 AnswerRecord（paper_id + question_no 定位）。"""
    records: list[AnswerRecord] = []
    for it in doc.items:
        records.append(AnswerRecord(
            paper_id=paper_id,
            question_no=it.no,
            answer=it.answer.strip() or None,
            approach=it.approach.strip() or None,
            explanation=it.explanation.strip() or None,
            type=it.type_override,
        ))
    return records
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd tools/data-refinery && pytest tests/test_answer_doc.py -q`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add tools/data-refinery/src/answer_doc.py tools/data-refinery/tests/test_answer_doc.py
git commit -m "feat(data-refinery): answer_doc Markdown 按卷文档解析（含 approach）"
```

---

### Task 4: answer_importer.py——范围 SQL / 分类 / diff / 报告

**Files:**
- Create: `tools/data-refinery/src/answer_importer.py`
- Test: `tools/data-refinery/tests/test_answer_importer.py`

**Interfaces:**
- Consumes: Task 2 的 `AnswerRecord`。
- Produces（Task 5 消费）：
  - `ScopeFilter`（dataclass，字段 `question_ids: set[int] | None` / `paper_ids: list[int] | None` / `question_nos: set[int] | None` / `gaps: set[str]` / `sources: list[str] | None` / `types: list[str] | None` / `difficulty: int | None` / `content_hash: str | None`；方法 `is_empty() -> bool`）
  - `QuestionRow`（`question_id` / `type` / `answer` / `approach` / `explanation`）
  - `MatchResult`（`paired` / `unresolved` / `out_of_scope`）
  - `DiffEntry`
  - `build_scope_sql(scope: ScopeFilter) -> tuple[str, list]`
  - `classify(records, resolved, in_scope_ids=None) -> MatchResult`
  - `build_diff(paired) -> list[DiffEntry]`
  - `locate_paper(title, papers) -> tuple[int | None, list]`
  - `format_report(*, target, diff, unmatched, out_of_scope, warnings, apply) -> str`

- [ ] **Step 1: 写失败测试**

`tools/data-refinery/tests/test_answer_importer.py`：

```python
"""answer_importer：范围 SQL + 分类 + diff + 报告（纯函数，不连库）。"""

import pytest

from answer_importer import (
    QuestionRow,
    ScopeFilter,
    build_diff,
    build_scope_sql,
    classify,
    format_report,
    locate_paper,
)
from answer_records import AnswerRecord


def _row(qid, type_="short_answer", answer="", approach=None, explanation=None):
    return QuestionRow(question_id=qid, type=type_, answer=answer,
                       approach=approach, explanation=explanation)


class TestScopeSql:
    def test_empty(self):
        assert build_scope_sql(ScopeFilter()) == ("1=1", [])

    def test_question_ids_sorted(self):
        where, params = build_scope_sql(ScopeFilter(question_ids={3, 1}))
        assert where == "q.id IN (%s,%s)"
        assert params == [1, 3]

    def test_paper_and_no(self):
        where, params = build_scope_sql(ScopeFilter(paper_ids=[3], question_nos={17, 2}))
        assert where == ("q.id IN (SELECT question_id FROM paper_questions "
                         "WHERE paper_id IN (%s) AND question_no IN (%s,%s))")
        assert params == [3, 2, 17]

    def test_gaps(self):
        where, _ = build_scope_sql(ScopeFilter(gaps={"answer_empty", "explanation_empty"}))
        assert where == ("(q.answer IS NULL OR q.answer = '') AND "
                         "(q.explanation IS NULL OR q.explanation = '')")

    def test_attributes(self):
        where, params = build_scope_sql(ScopeFilter(
            sources=["海淀"], types=["choice"], difficulty=2, content_hash="hhhh"))
        assert "q.source LIKE %s" in where
        assert "q.type IN (%s)" in where
        assert "q.difficulty = %s" in where
        assert "q.content_hash = %s" in where
        assert params == ["%海淀%", "choice", 2, "hhhh"]

    def test_question_no_without_paper_raises(self):
        with pytest.raises(ValueError, match="question_no"):
            build_scope_sql(ScopeFilter(question_nos={1}))

    def test_unknown_gap_raises(self):
        with pytest.raises(ValueError, match="未知缺口条件"):
            build_scope_sql(ScopeFilter(gaps={"bogus"}))


class TestClassify:
    def test_paired_unresolved_out_of_scope(self):
        records = [
            AnswerRecord(question_id=1, answer="A", line_no=1),
            AnswerRecord(question_id=2, answer="B", line_no=2),
            AnswerRecord(question_id=3, answer="C", line_no=3),
        ]
        m = classify(records, [_row(1), None, _row(3)], in_scope_ids={1})
        assert [r.question_id for _, r in m.paired] == [1]
        assert [x.question_id for x in m.unresolved] == [2]
        assert [r.question_id for _, r in m.out_of_scope] == [3]

    def test_no_scope_means_all_paired(self):
        m = classify([AnswerRecord(question_id=1, answer="A")], [_row(1)], None)
        assert len(m.paired) == 1 and not m.out_of_scope

    def test_length_mismatch(self):
        with pytest.raises(ValueError, match="长度"):
            classify([AnswerRecord(question_id=1)], [])


class TestDiff:
    def test_answer_change_and_approach_new(self):
        rec = AnswerRecord(question_id=1, answer="B", approach="配方", line_no=1)
        diff = build_diff([(rec, _row(1, "choice", answer="A"))])
        assert len(diff) == 1
        d = diff[0]
        assert (d.old_answer, d.new_answer) == ("A", "B")
        assert d.old_approach is None and d.new_approach == "配方"
        assert d.type_change is None

    def test_explanation_provided_overrides(self):
        rec = AnswerRecord(question_id=1, explanation="新解析")
        d = build_diff([(rec, _row(1, answer="A", explanation="旧解析"))])[0]
        assert (d.old_explanation, d.new_explanation) == ("旧解析", "新解析")

    def test_type_change(self):
        rec = AnswerRecord(question_id=1, type="calculation")
        d = build_diff([(rec, _row(1, "short_answer", answer="A"))])[0]
        assert d.type_change == ("short_answer", "calculation")
        assert d.type == "calculation"

    def test_unchanged_is_idempotent(self):
        rec = AnswerRecord(question_id=1, answer="A", approach="配方", explanation="过程")
        assert build_diff([(rec, _row(1, answer="A", approach="配方", explanation="过程"))]) == []

    def test_none_fields_not_changed(self):
        rec = AnswerRecord(question_id=1, note="只备注")
        assert build_diff([(rec, _row(1, answer="A", explanation="旧"))]) == []


class TestLocatePaper:
    def test_unique_exact(self):
        assert locate_paper("X 卷", [("X 卷", 3, 30)]) == (3, [])

    def test_duplicate_lists_candidates(self):
        papers = [("X 卷", 2, 37), ("X 卷", 6, 28), ("Y 卷", 9, 28)]
        pid, candidates = locate_paper("X 卷", papers)
        assert pid is None
        assert [c[1] for c in candidates] == [2, 6]

    def test_substring_fallback(self):
        assert locate_paper("海淀", [("2024 海淀 初三 模拟二", 2, 37)]) == (2, [])


class TestReport:
    def test_sections(self):
        m = classify(
            [AnswerRecord(question_id=1, answer="B", line_no=1),
             AnswerRecord(question_id=99, answer="X", line_no=2)],
            [_row(1, "choice", answer="A"), None],
        )
        out = format_report(target="测试", diff=build_diff(m.paired),
                            unmatched=m.unresolved, out_of_scope=m.out_of_scope,
                            warnings=["示例警告"], apply=False)
        assert "目标：测试" in out
        assert "将更新 1 题" in out
        assert "更新明细" in out
        assert "定位失败 1 条" in out
        assert "示例警告" in out
        assert "dry-run" in out

    def test_out_of_scope_section(self):
        m = classify([AnswerRecord(question_id=3, answer="C", line_no=1)], [_row(3)], in_scope_ids=set())
        out = format_report(target="T", diff=[], unmatched=m.unresolved,
                            out_of_scope=m.out_of_scope, warnings=[], apply=False)
        assert "范围外跳过 1 条" in out

    def test_no_change_idempotent(self):
        out = format_report(target="T", diff=[], unmatched=[], out_of_scope=[],
                            warnings=[], apply=False)
        assert "幂等重跑" in out
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd tools/data-refinery && pytest tests/test_answer_importer.py -q`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 answer_importer.py**

`tools/data-refinery/src/answer_importer.py`：

```python
"""answer_importer：范围 SQL 构造 + 记录分类 + diff + 报告（纯函数层）。

DB 编排（定位/读题/UPDATE）在 answer_importer_cli.py。
回写语义见 spec 2026-09-10 §5；幂等：无变化记录不进 diff、不发 UPDATE。
"""

from dataclasses import dataclass, field

from answer_records import AnswerRecord

_GAP_PREDICATES = {
    "answer_empty": "(q.answer IS NULL OR q.answer = '')",
    "approach_empty": "(q.approach IS NULL OR q.approach = '')",
    "explanation_empty": "(q.explanation IS NULL OR q.explanation = '')",
}


@dataclass
class ScopeFilter:
    question_ids: set[int] | None = None
    paper_ids: list[int] | None = None
    question_nos: set[int] | None = None
    gaps: set[str] = field(default_factory=set)
    sources: list[str] | None = None
    types: list[str] | None = None
    difficulty: int | None = None
    content_hash: str | None = None

    def is_empty(self) -> bool:
        return not any([
            self.question_ids, self.paper_ids, self.question_nos, self.gaps,
            self.sources, self.types, self.difficulty, self.content_hash,
        ])


def _placeholders(n: int) -> str:
    return ",".join(["%s"] * n)


def build_scope_sql(scope: ScopeFilter) -> tuple[str, list]:
    """构造 questions（别名 q）上的 WHERE 片段与参数；无约束返回 ('1=1', [])。"""
    if scope.question_nos and not scope.paper_ids:
        raise ValueError("question_no 必须与 paper_id 搭配")
    conds: list[str] = []
    params: list = []

    if scope.question_ids:
        ids = sorted(scope.question_ids)
        conds.append(f"q.id IN ({_placeholders(len(ids))})")
        params.extend(ids)
    if scope.paper_ids:
        pids = list(scope.paper_ids)
        sub = (f"SELECT question_id FROM paper_questions "
               f"WHERE paper_id IN ({_placeholders(len(pids))})")
        sub_params: list = list(pids)
        if scope.question_nos:
            nos = sorted(scope.question_nos)
            sub += f" AND question_no IN ({_placeholders(len(nos))})"
            sub_params.extend(nos)
        conds.append(f"q.id IN ({sub})")
        params.extend(sub_params)
    for gap in sorted(scope.gaps):
        if gap not in _GAP_PREDICATES:
            raise ValueError(
                f"未知缺口条件：{gap}（允许：{' | '.join(sorted(_GAP_PREDICATES))}）")
        conds.append(_GAP_PREDICATES[gap])
    if scope.sources:
        conds.append("(" + " OR ".join(["q.source LIKE %s"] * len(scope.sources)) + ")")
        params.extend(f"%{s}%" for s in scope.sources)
    if scope.types:
        conds.append(f"q.type IN ({_placeholders(len(scope.types))})")
        params.extend(scope.types)
    if scope.difficulty is not None:
        conds.append("q.difficulty = %s")
        params.append(scope.difficulty)
    if scope.content_hash:
        conds.append("q.content_hash = %s")
        params.append(scope.content_hash)
    return (" AND ".join(conds) if conds else "1=1"), params


@dataclass
class QuestionRow:
    question_id: int
    type: str
    answer: str = ""
    approach: str | None = None
    explanation: str | None = None


@dataclass
class MatchResult:
    paired: list[tuple[AnswerRecord, QuestionRow]]
    unresolved: list[AnswerRecord]
    out_of_scope: list[tuple[AnswerRecord, QuestionRow]]


def classify(
    records: list[AnswerRecord],
    resolved: list[QuestionRow | None],
    in_scope_ids: set[int] | None = None,
) -> MatchResult:
    """resolved 与 records 等长；None=定位失败。in_scope_ids=None 表示不限范围。"""
    if len(records) != len(resolved):
        raise ValueError("records 与 resolved 长度必须一致")
    paired: list[tuple[AnswerRecord, QuestionRow]] = []
    unresolved: list[AnswerRecord] = []
    out_of_scope: list[tuple[AnswerRecord, QuestionRow]] = []
    for rec, row in zip(records, resolved):
        if row is None:
            unresolved.append(rec)
        elif in_scope_ids is not None and row.question_id not in in_scope_ids:
            out_of_scope.append((rec, row))
        else:
            paired.append((rec, row))
    return MatchResult(paired=paired, unresolved=unresolved, out_of_scope=out_of_scope)


@dataclass
class DiffEntry:
    question_id: int
    label: str
    type: str
    old_answer: str
    new_answer: str | None
    old_approach: str | None
    new_approach: str | None
    old_explanation: str | None
    new_explanation: str | None
    type_change: tuple[str, str] | None


def build_diff(paired: list[tuple[AnswerRecord, QuestionRow]]) -> list[DiffEntry]:
    diff: list[DiffEntry] = []
    for rec, row in paired:
        type_change = (row.type, rec.type) if rec.type and rec.type != row.type else None
        answer_changed = rec.answer is not None and rec.answer != (row.answer or "")
        approach_changed = rec.approach is not None and rec.approach != (row.approach or "")
        expl_changed = rec.explanation is not None and rec.explanation != (row.explanation or "")
        if not (answer_changed or approach_changed or expl_changed or type_change):
            continue  # 幂等：无变化不出 diff
        diff.append(DiffEntry(
            question_id=row.question_id,
            label=rec.locator(),
            type=rec.type or row.type,
            old_answer=row.answer or "",
            new_answer=rec.answer,
            old_approach=row.approach,
            new_approach=rec.approach,
            old_explanation=row.explanation,
            new_explanation=rec.explanation,
            type_change=type_change,
        ))
    return diff


def locate_paper(title: str, papers: list[tuple[str, int, int]]) -> tuple[int | None, list[tuple[str, int, int]]]:
    """在 (title, id, question_count) 列表中定位试卷：唯一精确命中返回 id；
    重名/多条候选返回 (None, 候选)；无精确命中时子串匹配兜底（仍多条则列候选）。"""
    exact = [p for p in papers if p[0] == title]
    if len(exact) == 1:
        return exact[0][1], []
    hits = exact or [p for p in papers if title in p[0]]
    if len(hits) == 1:
        return hits[0][1], []
    return None, hits


def _trunc(s: str | None, n: int = 40) -> str:
    s = (s or "").replace("\n", " ")
    return s if len(s) <= n else s[:n] + "…"


def _field_line(name: str, old: str | None, new: str | None) -> str | None:
    if new is None:
        return None
    if not (old or "").strip():
        return f"    {name}: (无 -> 新增) {_trunc(new)}"
    return f"    {name}: {_trunc(old)} -> {_trunc(new)}"


def format_report(
    *,
    target: str,
    diff: list[DiffEntry],
    unmatched: list[AnswerRecord],
    out_of_scope: list[tuple[AnswerRecord, QuestionRow]],
    warnings: list[str],
    apply: bool,
) -> str:
    suffix = "（已写入）" if apply else "（dry-run 预览，--apply 才写入）"
    lines = [f"=== 目标：{target} ===", f"将更新 {len(diff)} 题{suffix}", ""]
    if diff:
        lines.append("—— 更新明细 ——")
        for d in diff:
            lines.append(f"  {d.label} (questions#{d.question_id}, {d.type})")
            if d.new_answer is not None:
                lines.append(f"    答案: {_trunc(d.old_answer)} -> {_trunc(d.new_answer)}")
            for name, old, new in (("思路", d.old_approach, d.new_approach),
                                   ("解析", d.old_explanation, d.new_explanation)):
                line = _field_line(name, old, new)
                if line:
                    lines.append(line)
            if d.type_change:
                lines.append(f"    题型: {d.type_change[0]} -> {d.type_change[1]}")
        lines.append("")
    if unmatched:
        lines.append(f"—— 定位失败 {len(unmatched)} 条（不写入）——")
        for rec in unmatched:
            note = f"（{rec.note}）" if rec.note else ""
            lines.append(f"  第 {rec.line_no} 行 {rec.locator()}{note}")
        lines.append("")
    if out_of_scope:
        lines.append(f"—— 范围外跳过 {len(out_of_scope)} 条（不满足 --where，不写入）——")
        for rec, row in out_of_scope:
            lines.append(f"  第 {rec.line_no} 行 {rec.locator()} -> questions#{row.question_id}")
        lines.append("")
    if warnings:
        lines.append(f"—— 警告 {len(warnings)} 条 ——")
        for w in warnings:
            lines.append(f"  {w}")
        lines.append("")
    if not diff and not unmatched and not out_of_scope:
        lines.append("（无变化——与库内数据一致，幂等重跑）")
    return "\n".join(lines)
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd tools/data-refinery && pytest tests/test_answer_importer.py -q`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add tools/data-refinery/src/answer_importer.py tools/data-refinery/tests/test_answer_importer.py
git commit -m "feat(data-refinery): answer_importer 范围SQL/分类/diff/报告纯函数层"
```

---

### Task 5: answer_importer_cli.py——连库编排 + export/apply

**Files:**
- Create: `tools/data-refinery/src/answer_importer_cli.py`
- Test: `tools/data-refinery/tests/test_answer_importer_cli.py`

**Interfaces:**
- Consumes: Task 2 的 `AnswerRecord`/`AnswerRecordError`/`ExportRow`/`build_export_jsonl`/`parse_answer_records`；Task 3 的 `AnswerDocError`/`doc_to_records`/`parse_answer_doc`；Task 4 的 `ScopeFilter`/`QuestionRow`/`build_diff`/`build_scope_sql`/`classify`/`format_report`/`locate_paper`。
- Produces（供测试与执行）：`parse_args`、`parse_int_set`、`build_scope`、`build_update_sql`、`build_export_sql`、`connect`、`main`。

- [ ] **Step 1: 写失败测试**

`tools/data-refinery/tests/test_answer_importer_cli.py`：

```python
"""answer_importer_cli：argparse + SQL 构造（纯函数，不连库）。"""

import pytest

from answer_importer import QuestionRow, ScopeFilter
from answer_importer_cli import (
    build_export_sql,
    build_scope,
    build_update_sql,
    parse_args,
    parse_int_set,
)
from answer_records import AnswerRecord


class TestArgs:
    def test_defaults(self):
        args = parse_args(["--records", "a.jsonl"])
        assert args.apply is False
        assert args.paper_id is None
        assert args.limit == 500

    def test_apply_and_paper(self):
        args = parse_args(["--doc", "a.md", "--paper-id", "3", "--apply"])
        assert args.paper_id == 3 and args.apply is True

    def test_records_doc_mutually_exclusive(self):
        with pytest.raises(SystemExit):
            parse_args(["--records", "a.jsonl", "--doc", "b.md"])


class TestParseIntSet:
    def test_list_and_range(self):
        assert parse_int_set("1,2,10-12") == {1, 2, 10, 11, 12}

    def test_single(self):
        assert parse_int_set("7") == {7}

    def test_bad_range(self):
        with pytest.raises(ValueError, match="区间非法"):
            parse_int_set("10-1")


class TestBuildScope:
    def test_full(self):
        args = parse_args([
            "--records", "a.jsonl", "--paper-id", "3", "--question-no", "1,17",
            "--where", "answer_empty,approach_empty", "--source", "海淀",
            "--type", "choice,calculation", "--difficulty", "2", "--content-hash", "a" * 64,
        ])
        scope = build_scope(args)
        assert scope.paper_ids == [3]
        assert scope.question_nos == {1, 17}
        assert scope.gaps == {"answer_empty", "approach_empty"}
        assert scope.sources == ["海淀"]
        assert scope.types == ["choice", "calculation"]
        assert scope.difficulty == 2
        assert scope.content_hash == "a" * 64

    def test_empty(self):
        assert build_scope(parse_args(["--records", "a.jsonl"])).is_empty()


class TestUpdateSql:
    def test_no_type_change(self):
        rec = AnswerRecord(question_id=101, answer="B", approach="配方")
        row = QuestionRow(question_id=101, type="choice", answer="A")
        sql, params = build_update_sql(rec, row)
        assert "type =" not in sql
        assert "answer_verified = 1" in sql
        assert params == ["B", "配方", 101]

    def test_with_type_change(self):
        rec = AnswerRecord(question_id=117, type="calculation", answer="x=2")
        row = QuestionRow(question_id=117, type="short_answer", answer="")
        sql, params = build_update_sql(rec, row)
        assert "type = %s" in sql
        assert params == ["x=2", "calculation", 117]

    def test_only_changed_fields_included(self):
        rec = AnswerRecord(question_id=5, explanation="新")
        row = QuestionRow(question_id=5, type="choice", answer="A")
        sql, params = build_update_sql(rec, row)
        assert "answer =" not in sql
        assert "approach =" not in sql
        assert params == ["新", 5]


class TestExportSql:
    def test_single_paper_joins_for_question_no(self):
        sql, params = build_export_sql(ScopeFilter(paper_ids=[3]), limit=10)
        assert "LEFT JOIN paper_questions" in sql
        assert "pq.question_no" in sql
        # 第一个参数是 JOIN 的 paper_id，第二个是 WHERE 子查询的 paper_id
        assert params == [3, 3, 10]

    def test_no_paper_plain(self):
        sql, params = build_export_sql(ScopeFilter(gaps={"answer_empty"}), limit=10)
        assert "LEFT JOIN" not in sql
        assert params == [10]

    def test_paper_plus_gap(self):
        sql, params = build_export_sql(
            ScopeFilter(paper_ids=[3], gaps={"answer_empty"}), limit=5)
        assert "LEFT JOIN paper_questions" in sql
        assert params == [3, 3, 5]
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd tools/data-refinery && pytest tests/test_answer_importer_cli.py -q`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 answer_importer_cli.py**

`tools/data-refinery/src/answer_importer_cli.py`：

```python
"""answer_importer_cli：题目内容回写题库（answer/approach/explanation/type）。

用法（cd tools/data-refinery）：
    python src/answer_importer_cli.py --records edits.jsonl                 # dry-run
    python src/answer_importer_cli.py --records edits.jsonl --apply         # 写入（输 yes）
    python src/answer_importer_cli.py --doc 答案.md --paper-id 3
    python src/answer_importer_cli.py --export --where answer_empty --out to_fill.jsonl
    python src/answer_importer_cli.py --list-papers 海淀

语义（spec 2026-09-10 §5）：缺省=不改、非空=覆盖、空串=不改；type 仅标注时改；
任一写入 answer_verified=1；幂等重跑无 diff 不写。
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # 直接执行时能 import 同目录模块

from answer_doc import AnswerDocError, doc_to_records, parse_answer_doc  # noqa: E402
from answer_importer import (  # noqa: E402
    QuestionRow,
    ScopeFilter,
    build_diff,
    build_scope_sql,
    classify,
    format_report,
    locate_paper,
)
from answer_records import (  # noqa: E402
    AnswerRecord,
    AnswerRecordError,
    ExportRow,
    build_export_jsonl,
    parse_answer_records,
)

DEFAULT_LIMIT = 500
GAP_CHOICES = ["answer_empty", "approach_empty", "explanation_empty"]


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="题目内容回写题库（answer/approach/explanation/type）")
    src = p.add_mutually_exclusive_group()
    src.add_argument("--records", help="JSONL 输入路径")
    src.add_argument("--doc", help="Markdown 按卷答案文档路径")
    p.add_argument("--export", action="store_true", help="导出待补模板（配合 --where/--out）")
    p.add_argument("--out", help="导出目标路径（--export 必填）")
    p.add_argument("--paper-id", type=int, default=None, help="试卷 id（重名时直接指定）")
    p.add_argument("--paper-title", default=None, help="试卷标题（--doc 未带 --paper-id 时定位用）")
    p.add_argument("--question-id", default=None, help="主键选择器，如 1,2,10-20")
    p.add_argument("--question-no", default=None, help="印刷题号（须配合 --paper-id）")
    p.add_argument("--where", dest="where", default=None,
                   help="缺口条件，逗号分隔：" + "/".join(GAP_CHOICES))
    p.add_argument("--source", default=None, help="来源关键词（LIKE）")
    p.add_argument("--type", dest="type", default=None, help="题型（逗号分隔）")
    p.add_argument("--difficulty", type=int, default=None, help="难度 1/2/3")
    p.add_argument("--content-hash", dest="content_hash", default=None, help="题干哈希")
    p.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help=f"安全阀（默认 {DEFAULT_LIMIT}）")
    p.add_argument("--apply", action="store_true", help="实际写入（默认 dry-run）")
    p.add_argument("--list-papers", metavar="KEYWORD", default=None, help="按关键词列候选试卷")
    return p.parse_args(argv)


def parse_int_set(spec: str) -> set[int]:
    """解析 '1,2,10-20' -> {1,2,10..20}。"""
    result: set[int] = set()
    for part in (spec or "").split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            lo_s, hi_s = part.split("-", 1)
            lo, hi = int(lo_s), int(hi_s)
            if lo > hi:
                raise ValueError(f"区间非法：{part}")
            result.update(range(lo, hi + 1))
        else:
            result.add(int(part))
    return result


def build_scope(args) -> ScopeFilter:
    scope = ScopeFilter()
    if args.question_id:
        scope.question_ids = parse_int_set(args.question_id)
    if args.paper_id:
        scope.paper_ids = [args.paper_id]
    if args.question_no:
        scope.question_nos = parse_int_set(args.question_no)
    if args.where:
        scope.gaps = {g.strip() for g in args.where.split(",") if g.strip()}
    if args.source:
        scope.sources = [args.source]
    if args.type:
        scope.types = [t.strip() for t in args.type.split(",") if t.strip()]
    scope.difficulty = args.difficulty
    scope.content_hash = args.content_hash
    return scope


def build_update_sql(rec: AnswerRecord, row: QuestionRow) -> tuple[str, list]:
    """构造单题 UPDATE：只含记录提供的字段 + answer_verified/updated_at，WHERE id。"""
    sets: list[str] = []
    params: list = []
    if rec.answer is not None:
        sets.append("answer = %s")
        params.append(rec.answer)
    if rec.approach is not None:
        sets.append("approach = %s")
        params.append(rec.approach)
    if rec.explanation is not None:
        sets.append("explanation = %s")
        params.append(rec.explanation)
    if rec.type is not None and rec.type != row.type:
        sets.append("type = %s")
        params.append(rec.type)
    sets.append("answer_verified = 1")
    sets.append("updated_at = CURRENT_TIMESTAMP(3)")
    params.append(row.question_id)
    return f"UPDATE questions SET {', '.join(sets)} WHERE id = %s", params


def build_export_sql(scope: ScopeFilter, limit: int) -> tuple[str, list]:
    """导出查询：单一 --paper-id 时 LEFT JOIN 取印刷题号供 _ref 参考。"""
    where, params = build_scope_sql(scope)
    if scope.paper_ids and len(set(scope.paper_ids)) == 1:
        pid = scope.paper_ids[0]
        sql = (
            "SELECT q.id, q.content, q.options, q.type, q.answer, q.approach, q.explanation, "
            "pq.question_no "
            "FROM questions q "
            "LEFT JOIN paper_questions pq ON pq.question_id = q.id AND pq.paper_id = %s "
            f"WHERE {where} ORDER BY q.id LIMIT %s"
        )
        return sql, [pid] + params + [limit]
    sql = (
        "SELECT q.id, q.content, q.options, q.type, q.answer, q.approach, q.explanation "
        f"FROM questions q WHERE {where} ORDER BY q.id LIMIT %s"
    )
    return sql, params + [limit]


def connect():
    import pymysql
    from config import RefineryConfig

    cfg = RefineryConfig.from_env()
    return pymysql.connect(host=cfg.db_host, port=cfg.db_port, user=cfg.db_user,
                           password=cfg.db_pass, database=cfg.db_name, charset="utf8mb4")


def _row(raw) -> QuestionRow:
    return QuestionRow(question_id=raw[0], type=raw[1], answer=raw[2] or "",
                       approach=raw[3], explanation=raw[4])


def load_questions_by_ids(conn, ids: set[int]) -> dict[int, QuestionRow]:
    if not ids:
        return {}
    ph = ",".join(["%s"] * len(ids))
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT id, type, answer, approach, explanation FROM questions WHERE id IN ({ph})",
            sorted(ids),
        )
        return {r[0]: _row(r) for r in cur.fetchall()}


def load_questions_by_hash(conn, hashes: set[str]) -> dict[str, QuestionRow]:
    if not hashes:
        return {}
    ph = ",".join(["%s"] * len(hashes))
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT content_hash, id, type, answer, approach, explanation FROM questions "
            f"WHERE content_hash IN ({ph})",
            sorted(hashes),
        )
        return {r[0]: _row((r[1], r[2], r[3], r[4], r[5])) for r in cur.fetchall()}


def load_questions_by_paper_no(conn, pairs: set[tuple[int, int]]) -> dict[tuple[int, int], QuestionRow]:
    if not pairs:
        return {}
    ph = ",".join(["(%s,%s)"] * len(pairs))
    flat = [x for p in sorted(pairs) for x in p]
    with conn.cursor() as cur:
        cur.execute(
            "SELECT pq.paper_id, pq.question_no, q.id, q.type, q.answer, q.approach, q.explanation "
            "FROM paper_questions pq JOIN questions q ON q.id = pq.question_id "
            f"WHERE (pq.paper_id, pq.question_no) IN ({ph})",
            flat,
        )
        return {(r[0], r[1]): _row((r[2], r[3], r[4], r[5], r[6])) for r in cur.fetchall()}


def resolve_records(conn, records: list[AnswerRecord]) -> list[QuestionRow | None]:
    by_qid = load_questions_by_ids(conn, {x.question_id for x in records if x.question_id is not None})
    by_hash = load_questions_by_hash(conn, {x.content_hash for x in records if x.content_hash is not None})
    by_paper = load_questions_by_paper_no(
        conn, {(x.paper_id, x.question_no) for x in records if x.paper_id is not None})
    resolved: list[QuestionRow | None] = []
    for rec in records:
        if rec.question_id is not None:
            resolved.append(by_qid.get(rec.question_id))
        elif rec.content_hash is not None:
            resolved.append(by_hash.get(rec.content_hash))
        else:
            resolved.append(by_paper.get((rec.paper_id, rec.question_no)))
    return resolved


def load_scope_ids(conn, scope: ScopeFilter) -> set[int] | None:
    if scope.is_empty():
        return None
    where, params = build_scope_sql(scope)
    with conn.cursor() as cur:
        cur.execute(f"SELECT q.id FROM questions q WHERE {where}", params)
        return {r[0] for r in cur.fetchall()}


def load_papers(conn, keyword: str):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT title, id, question_count FROM exam_papers WHERE title LIKE %s ORDER BY id",
            (f"%{keyword}%",),
        )
        return cur.fetchall()


def load_export_rows(conn, scope: ScopeFilter, limit: int) -> list[ExportRow]:
    sql, params = build_export_sql(scope, limit)
    rows: list[ExportRow] = []
    with conn.cursor() as cur:
        cur.execute(sql, params)
        for r in cur.fetchall():
            if len(r) == 8:
                rows.append(ExportRow(question_id=r[0], content=r[1] or "", type=r[3],
                                      answer=r[4] or "", options=r[2], approach=r[5],
                                      explanation=r[6], paper_id=scope.paper_ids[0], question_no=r[7]))
            else:
                rows.append(ExportRow(question_id=r[0], content=r[1] or "", type=r[3],
                                      answer=r[4] or "", options=r[2], approach=r[5],
                                      explanation=r[6]))
    return rows


def _records_from_doc(conn, args):
    """解析 Markdown 并定位试卷。返回 (records, target_label) 或 (None, None)。"""
    doc = parse_answer_doc(open(args.doc, encoding="utf-8").read())
    paper_id = args.paper_id
    if paper_id is None:
        keyword = args.paper_title or doc.title
        papers = list(load_papers(conn, keyword))
        paper_id, candidates = locate_paper(keyword, papers)
        if paper_id is None:
            print(f"试卷「{keyword}」无法唯一定位，候选如下（用 --paper-id 指定）：")
            for title, pid, count in (candidates or papers):
                print(f"  #{pid}\t{count} 题\t{title}")
            return None, None
    return doc_to_records(doc, paper_id), f"试卷 #{paper_id} {doc.title}"


def _run(conn, args) -> int:
    if args.list_papers:
        for title, pid, count in load_papers(conn, args.list_papers):
            print(f"  #{pid}\t{count} 题\t{title}")
        return 0

    scope = build_scope(args)

    if args.export:
        if not args.out:
            print("错误：--export 需要 --out 指定输出路径", file=sys.stderr)
            return 2
        rows = load_export_rows(conn, scope, args.limit)
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(build_export_jsonl(rows))
        print(f"已导出 {len(rows)} 题 -> {args.out}")
        return 0

    if args.records:
        records = parse_answer_records(open(args.records, encoding="utf-8").read())
        target = args.records
    elif args.doc:
        records, target = _records_from_doc(conn, args)
        if records is None:
            return 2
    else:
        print("错误：需要 --records / --doc / --export / --list-papers 之一", file=sys.stderr)
        return 2

    if len(records) > args.limit:
        print(f"错误：本次将处理 {len(records)} 条，超过 --limit {args.limit}；"
              f"确认无误请显式调大 --limit", file=sys.stderr)
        return 2

    resolved = resolve_records(conn, records)
    in_scope_ids = load_scope_ids(conn, scope)
    match = classify(records, resolved, in_scope_ids)
    diff = build_diff(match.paired)
    warnings = [f"第 {rec.line_no} 行 {rec.locator()} 内容字段全为空，未产生更新"
                for rec, _row in match.paired if not rec.has_content()]

    print(format_report(target=target, diff=diff, unmatched=match.unresolved,
                        out_of_scope=match.out_of_scope, warnings=warnings, apply=args.apply))

    if not args.apply:
        print("\n（dry-run，未写入。确认无误后加 --apply 执行。）")
        return 0
    if not diff:
        print("（无变化，未写入——幂等重跑。）")
        return 0

    answer = input(f"确认写入 {len(diff)} 题？输入 yes 执行：").strip()
    if answer != "yes":
        print("已取消。")
        return 1

    diff_qids = {d.question_id for d in diff}
    written = 0
    with conn.cursor() as cur:
        for rec, row in match.paired:
            if row.question_id not in diff_qids:
                continue
            sql, params = build_update_sql(rec, row)
            cur.execute(sql, params)
            written += 1
    conn.commit()
    print(f"已写入 {written} 题（answer_verified=1）。")
    return 0


def main(argv=None) -> int:
    args = parse_args(argv)
    if args.limit <= 0:
        print("错误：--limit 必须为正整数", file=sys.stderr)
        return 2
    conn = connect()
    try:
        try:
            return _run(conn, args)
        except (AnswerRecordError, AnswerDocError, ValueError) as e:
            print(f"错误：{e}", file=sys.stderr)
            return 2
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd tools/data-refinery && pytest tests/test_answer_importer_cli.py -q`
Expected: PASS。

- [ ] **Step 5: 全量回归**

Run: `cd tools/data-refinery && pytest -q`
Expected: 全绿（既有用例不回归）。

- [ ] **Step 6: Commit**

```bash
git add tools/data-refinery/src/answer_importer_cli.py tools/data-refinery/tests/test_answer_importer_cli.py
git commit -m "feat(data-refinery): answer_importer_cli 连库编排（export/dry-run/--apply）"
```

---

### Task 6: 文档同步

**Files:**
- Modify: `docs/data-refinery-使用手册.md`（在 `## 5. 推荐工作流` 之前插入 `### 4.8`，即 `### 4.7 pipeline_cli` 区块末尾 `---` 之后）
- Modify: `docs/data-refinery-管线总结与后续.md`（§6 已知遗留 追加一条）
- Modify: `docs/superpowers/plans/2026-09-09-answer-importer.md`（顶部加取代说明）
- Modify: `CLAUDE.md`（data-refinery「现状」段补一句）

- [ ] **Step 1: 使用手册加 §4.8**

在 `docs/data-refinery-使用手册.md` 中 `### 4.7 pipeline_cli` 章节结束、`## 5. 推荐工作流` 之前插入：

```markdown
### 4.8 answer_importer — 题目内容回写（答案/解题思路/解析/题型）

把人工或 AI 产出的题目内容回写 `questions` 表：`answer`（答案）、`approach`（解题思路）、`explanation`（详细解析）、`type`（题型）。默认 dry-run 只出 diff 报告，`--apply` 才写入；幂等可重跑。

**输入一：JSONL（推荐，可编程批量）** 每行一条记录：

```jsonl
{"question_id": 12345, "answer": "B", "approach": "先配方求顶点，再取对称轴处最值", "explanation": "完整过程…"}
{"paper_id": 3, "question_no": 17, "approach": "利用相似三角形转化", "type": "calculation"}
{"content_hash": "ab12…（64 位十六进制）", "explanation": "……"}
```

- 定位键三选一：`question_id` ｜ `paper_id` + `question_no` ｜ `content_hash`。
- 内容字段至少一个：`answer` / `approach` / `explanation` / `type`；`note` 可选（只回显报告）。
- `null`/空串=不改（不提供「清空字段」）。

**输入二：Markdown 按卷文档**

```markdown
# 试卷：2024 海淀 初三 模拟二

## 1
答案：B
思路：由顶点式 $y=(x-2)^2+3$ 知顶点为 $(2,3)$，开口向上故在对称轴处取最小值。
解析：完整分步过程……

## 17
答案：解：设……所以 $x=2$。
题型：calculation
```

每题必写「答案」；「思路」「解析」「题型」可选；多行直接换行续写（空行断开）；公式用 `$...$`。

**常用命令**：

```bash
python src/answer_importer_cli.py --records edits.jsonl                 # dry-run：diff 报告，不写库
python src/answer_importer_cli.py --records edits.jsonl --apply         # 确认后写入（输 yes）
python src/answer_importer_cli.py --doc 答案.md --paper-id 3
python src/answer_importer_cli.py --export --where answer_empty --out to_fill.jsonl
python src/answer_importer_cli.py --list-papers 海淀                    # 标题重名时列候选
```

**选择器 `--where`（只圈范围，不承载内容）**：`--question-id 1,2,10-20`、`--paper-id` / `--paper-title`（+`--question-no`）、`--where answer_empty,approach_empty,explanation_empty`、`--source`（LIKE）/`--type`/`--difficulty`/`--content-hash`。

**导出待补模板 → 填写 → 回导**（批量补缺口的两步法）：

```bash
python src/answer_importer_cli.py --export --where answer_empty --out to_fill.jsonl
# 填写 to_fill.jsonl 顶层的 answer/approach/explanation（_ref 是只读参考，不要改）
python src/answer_importer_cli.py --records to_fill.jsonl --where answer_empty --apply
```

导入时 `--where` 会校验每条记录的目标题仍满足条件，不满足的跳过并报告。

**回写语义**：`answer`/`approach`/`explanation` 提供了非空值即覆盖；`type` 仅在标注且与原值不同时改；任一字段实际写入 → `answer_verified=1`（人工/AI 核验标记）；无变化的记录不发 UPDATE（幂等）。

**安全须知**：默认 dry-run；`--apply` 需交互输 `yes`；`--limit` 默认 500（超出拒绝）；**全量导入前先做快照**——`mysqldump -u ai_k12 -pai_k12 ai_k12 questions > questions_snapshot.sql`；首次请先小批（2-3 题）验证匹配无误再放量。
```

- [ ] **Step 2: 管线总结加记录**

`docs/data-refinery-管线总结与后续.md` §6 已知遗留列表末尾追加第 8 条：

```markdown
8. **题目内容缺口**：`answer_importer`（2026-09-10）已建成，可按单题/批量/按卷/按缺口回写 `answer`/`approach`（新增解题思路列）/`explanation`/`type`。存量约 188 道空答案、451 道无解析待按卷（或按 `--where ..._empty` 导出模板）补全；用法见 `docs/data-refinery-使用手册.md` §4.8，设计见 `docs/superpowers/specs/2026-09-10-question-content-importer-design.md`。
```

- [ ] **Step 3: 标注旧计划已被取代**

在 `docs/superpowers/plans/2026-09-09-answer-importer.md` 标题行之后插入：

```markdown
> **已扩展取代**：本计划的三层架构、dry-run/幂等约定已并入 `docs/superpowers/specs/2026-09-10-question-content-importer-design.md`（新增 `questions.approach` 解题思路列、JSONL 主输入、`--where` 选择器与 `--export` 模板）。实现以新 spec 对应的计划为准。
```

- [ ] **Step 4: CLAUDE.md data-refinery 现状补一句**

在 `CLAUDE.md` 的 data-refinery「**现状**」段（`管线已端到端跑通…` 那句所在段落）末尾追加一句：

```markdown
题目内容回写工具 `answer_importer`（2026-09-10）在 `tools/data-refinery/src/`：JSONL/Markdown 输入，按单题/批量/按卷/按缺口回写 questions 的 answer/approach/explanation/type（`--export` 导出待补模板，`--apply` 幂等写入）。
```

- [ ] **Step 5: Commit**

```bash
git add docs/data-refinery-使用手册.md docs/data-refinery-管线总结与后续.md docs/superpowers/plans/2026-09-09-answer-importer.md CLAUDE.md
git commit -m "docs(data-refinery): answer_importer 使用手册 §4.8 + 管线总结 + 旧计划取代标注"
```

---

### Task 7: 真库端到端验证（小批先行）

**Files:** 无（仅运行与核对；如发现 bug 回到对应 Task 修复并补测）

**Interfaces:**
- Consumes: Task 1–6 全部产物。

- [ ] **Step 1: 列候选试卷**

```bash
cd tools/data-refinery && python src/answer_importer_cli.py --list-papers 模拟
```

Expected: 输出 `#id  题数  标题` 列表（至少一行）。

- [ ] **Step 2: 选一题导出模板并检查形态**

```bash
python src/answer_importer_cli.py --export --question-id <上一步某卷首题 id> --out /tmp/fill.jsonl
cat /tmp/fill.jsonl
```

Expected: 一行 JSON，含 `question_id`、空的 `answer`/`approach`/`explanation`，`_ref` 内含题干与库内现值。

- [ ] **Step 3: 填 2-3 题并 dry-run**

按上一步导出（可再用 `--paper-id` 多导几题）手工填 `answer`/`approach`/`explanation`（其中一条故意留着空串验证「空串=不改」，另加一条不存在的题号验证「定位失败」），跑：

```bash
python src/answer_importer_cli.py --records /tmp/fill.jsonl
```

Expected: 「将更新 N 题」+ 旧→新 diff + 「定位失败 1 条」；**未写入**（无 `--apply`）。

- [ ] **Step 4: --apply 写入并复查**

```bash
python src/answer_importer_cli.py --records /tmp/fill.jsonl --apply   # 输 yes
mysql -u ai_k12 -pai_k12 ai_k12 -e "SELECT id, type, answer_verified, approach, answer, explanation FROM questions WHERE id IN (<查到的题id>);"
```

Expected: `answer`/`approach`/`explanation` 按填写更新，未填字段保持原值，`answer_verified=1`。

- [ ] **Step 5: 幂等重跑**

```bash
python src/answer_importer_cli.py --records /tmp/fill.jsonl
```

Expected: 「（无变化——与库内数据一致，幂等重跑）」，不发 UPDATE。（若仍显示更新，检查 `build_diff` 的比较是否忽略了空白差异。）

- [ ] **Step 6: 按试卷 Markdown 路径验证**

取某卷 3 个题号写 `/tmp/doc.md`（含一题只写答案、一题带思路、一题带 `题型：calculation`），跑：

```bash
python src/answer_importer_cli.py --doc /tmp/doc.md --paper-id <卷id>
```

Expected: 正确匹配印刷题号并出 diff；`题型` 变化显示在报告中。

- [ ] **Step 7: 如有修正则提交**

```bash
git add -A tools/data-refinery && git commit -m "fix(data-refinery): answer_importer 真库联调修正"
```

---

## Self-Review 记录

- **Spec 覆盖**：
  - §3 DB 变更（approach + answer_verified）→ Task 1；§3.4 db_loader 检查 → Task 1 Step 3。
  - §4.1 JSONL → Task 2；§4.2 Markdown（含 `思路：`）→ Task 3。
  - §5 更新语义（缺省/非空/空串/type/verified/幂等）→ Task 4 `build_diff` + Task 5 `build_update_sql`。
  - §6 `--where` 选择器 + `--export` 模板（`_ref` 只读）→ Task 4 `build_scope_sql` + Task 5 `build_export_sql`/`load_export_rows`。
  - §7 架构四模块 → Task 2/3/4/5；§8 CLI 参数 → Task 5 `parse_args`。
  - §9 错误处理与安全（dry-run 默认/确认/`--limit`/分类报告/歧义/退出码）→ Task 5 `_run`/`main`。
  - §10 测试策略 → 各 Task 测试文件；真库端到端 → Task 7。
  - §11 文档同步 → Task 6（使用手册 §4.8 / 管线总结 / 旧计划标注 / CLAUDE.md / DB 设计文档在 Task 1）。
- **占位符扫描**：无 TBD/TODO；所有步骤含完整代码与命令。Task 7 中 `<id>` 为运行时查得的真实题号，属执行期取值，非计划占位。
- **类型一致性**：`AnswerRecord`（Task 2 定义，Task 3/4/5 消费）、`QuestionRow`/`ScopeFilter`/`MatchResult`/`DiffEntry`（Task 4 定义，Task 5 消费）、`ExportRow`/`build_export_jsonl`（Task 2 定义，Task 5 消费）签名与字段名在各 Task 间一致；`build_update_sql(rec, row)`、`build_export_sql(scope, limit)`、`classify(records, resolved, in_scope_ids)` 参数序与测试断言一致。
- **已知风险**：① `build_export_sql` 单卷时 `params` 会重复 paper_id（JOIN 与 WHERE 子查询各一），测试已按 `[3, 3, 10]` 固化；② `--export` 的默认 `--limit 500` 可能截断全量缺口（当前存量 <500，够用；超出时显式调大）；③ Markdown 模式定位重名试卷需人工 `--paper-id`，`--list-papers` 提供通道。
