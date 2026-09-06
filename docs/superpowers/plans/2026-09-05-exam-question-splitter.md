# 试卷题切分与标注 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为试卷题建独立切分路径（Python 按题号切 + LLM 标注），区别于教材卡（card_splitter 按 400 字切），修复试卷题被切碎、图片丢失、字段不匹配 ExamQuestion 的问题。

**Architecture:** 在 `extract_cli.py` 加 `kind` 分支——试卷（文件名含"试卷"/"答案"）走新路径 `question_splitter`（题号正则切分 + 答案对齐）+ `question_labeler`（LLM 标 type/difficulty/知识点 + 双模型确认新增 KP）；教材卡路径不动。输出 ExamQuestion JSONL，`publish_cli` 已支持。

**Tech Stack:** Python 3.10+、pytest、pydantic、pymysql、复用现有 `llm.py`/`create_llm_client`/`LLMResponse`。

**Spec:** `docs/superpowers/specs/2026-09-05-exam-question-splitter-design.md`

## Global Constraints

- 遵循 `CLAUDE.md`：Python PEP 8 snake_case；Conventional Commits（`feat(data-refinery): ...`）
- 测试在 `tools/data-refinery/tests/test_*.py`，`conftest.py` 已把 `src/` 加入 `sys.path`，可直接 `from question_splitter import ...`
- mock LLM 风格：`FakeLLM.complete(system, user)` 返回带 `.content` 属性的对象（参考 `test_card_labeler.py`）
- 试卷路径**不跑 image_scan**（保留所有图），**不跑 card_splitter**（不按字数切）
- 知识点列表**动态从 DB `knowledge_points` 表读取**，不写死在 prompt 文件
- prompt 必须包含约束："除非确实是新知识点，禁止无合理理由增加新知识点"
- 新增 KP 判定：双模型 AND 逻辑（两个都认为新增才新增），无人审核
- 端到端验证时**不 publish 不入库**（用户明确要求）

## File Structure

**新增**：
- `tools/data-refinery/src/question_splitter.py` — 题号切分 + 答案对齐（统一扫描算法）
- `tools/data-refinery/src/question_labeler.py` — LLM 标注 + 双模型确认新增 KP
- `tools/data-refinery/src/prompts/question_labeler.txt` — 标注 prompt（含难度定义 + KP 约束 + `{{knowledge_points}}` 占位符）
- `tools/data-refinery/tests/test_question_splitter.py` — splitter 单元测试
- `tools/data-refinery/tests/test_question_labeler.py` — labeler 单元测试

**修改**：
- `tools/data-refinery/src/extract_cli.py` — 加 `kind` 分支 + `--subject` + `--label-batch-size` 参数 + 答案合并检测

**不动**：
- `publish_cli.py`（已支持 `kind=questions`）
- `db_loader_cli.py`（处理 `_confirmed_new_kps` 入库是后续任务）
- 遗留 `extract.py` 的 `Extractor` 类 + `prompts/exam_questions.txt`（保留作参考）

---

## Task 1: 题号识别工具函数

**Files:**
- Create: `tools/data-refinery/src/question_splitter.py`
- Test: `tools/data-refinery/tests/test_question_splitter.py`

**Interfaces:**
- Produces: `is_date_trap(line) -> bool`、`is_group_header(line) -> tuple[bool, str|None]`、`is_main_stem(line) -> tuple[bool, int|None]`、`is_sub_stem(line) -> bool`、`is_answer_keyword(line) -> bool`、`split_inline_stems(line) -> list[tuple[int, str]]`

- [ ] **Step 1: 写失败测试（题号识别各场景）**

Create `tools/data-refinery/tests/test_question_splitter.py`:

```python
from question_splitter import (
    is_date_trap, is_group_header, is_main_stem,
    is_sub_stem, is_answer_keyword, split_inline_stems,
)


def test_is_date_trap_matches_year_dot_month():
    assert is_date_trap("2026.5")
    assert is_date_trap("  2026.7")


def test_is_date_trap_rejects_question_number():
    assert not is_date_trap("9. 若代数式")
    assert not is_date_trap("9.5 之类的纯数字小数在题号行首也不会出现，但保险")


def test_is_main_stem_with_space():
    ok, n = is_main_stem("9. 若代数式 ...")
    assert ok and n == 9


def test_is_main_stem_without_space():
    ok, n = is_main_stem("9.若代数式 ...")
    assert ok and n == 9


def test_is_main_stem_with_formula_after_dot():
    ok, n = is_main_stem(r"9. $\frac{1}{x-3}$ 有意义")
    assert ok and n == 9


def test_is_main_stem_rejects_4digit_year():
    ok, _ = is_main_stem("2026.5")
    assert not ok  # 4 位数不在 1-2 位范围


def test_is_main_stem_rejects_decimal():
    ok, _ = is_main_stem("9.5")
    assert not ok  # . 后是数字，不是 \D


def test_is_sub_stem_half_and_full_width():
    assert is_sub_stem("(1) 求证")
    assert is_sub_stem("（2）解：")
    assert not is_sub_stem("9. 若代数式")


def test_is_group_header():
    ok, gid = is_group_header("三、解答题（共68分，第17-19题每题5分）")
    assert ok and gid == "三"
    ok, _ = is_group_header("9. 若代数式")
    assert not ok


def test_is_answer_keyword():
    assert is_answer_keyword("参考答案")
    assert is_answer_keyword("数学答案及评分参考")
    assert is_answer_keyword("二、答案")
    assert not is_answer_keyword("9. 若代数式")


def test_split_inline_stems_one_line_multiple():
    line = r"9. $x \neq 3$ 10. $3a(x-1)^2$ 11. $x = \frac{2}{3}$"
    result = split_inline_stems(line)
    assert len(result) == 3
    assert result[0][0] == 9
    assert r"x \neq 3" in result[0][1]
    assert result[1][0] == 10
    assert r"3a(x-1)^2" in result[1][1]
    assert result[2][0] == 11
    assert r"\frac{2}{3}" in result[2][1]


def test_split_inline_stems_no_match():
    assert split_inline_stems("无题号的纯文字") == []
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd tools/data-refinery && pytest tests/test_question_splitter.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'question_splitter'`

- [ ] **Step 3: 实现题号识别工具函数**

Create `tools/data-refinery/src/question_splitter.py`:

```python
"""试卷题切分器：按题号切分 + 答案对齐（统一扫描算法）。

与教材卡的 card_splitter（按 400 字贪心合并）不同，试卷题按题号切分，
题干原文原封不动，保留所有图片引用。详见
docs/superpowers/specs/2026-09-05-exam-question-splitter-design.md。
"""

import re
from pathlib import Path

# 主题号（行首）：1-2 位数字 + . + 非数字字符（不要求空格，兼容 9.xxx / 9. xxx / 9.$...$）
_MAIN_STEM_RE = re.compile(r'^\s*(\d{1,2})\.\D')
# 紧凑格式（行内，答案区一行多题号）：(?<!\d) 防止把 19.5 的小数点误切
_INLINE_STEM_RE = re.compile(r'(?<!\d)(\d{1,2})\.\D')
# 小问号：行首 (N) 或（N）
_SUB_STEM_RE = re.compile(r'^\s*[\(（](\d{1,2})[\)）]')
# 大题分组标题：行首 中文序号 + 、
_GROUP_HEADER_RE = re.compile(r'^\s*([一二三四五六七八九十]+)、')
# 日期/页码陷阱：行首 4 位数字 + . + 数字（如 2026.5）
_DATE_TRAP_RE = re.compile(r'^\s*\d{4}\.\d')
# 答案关键字（行内搜索）
_ANSWER_KEYWORD_RE = re.compile(r'参考答案|答案|评分参考')


def is_date_trap(line: str) -> bool:
    """行首是否为日期/页码格式（如 2026.5），不当题号。"""
    return bool(_DATE_TRAP_RE.match(line))


def is_group_header(line: str) -> tuple[bool, str | None]:
    """行首是否为大题分组标题（如 '三、解答题'）。返回 (是否, 组号)。"""
    m = _GROUP_HEADER_RE.match(line)
    if m:
        return True, m.group(1)
    return False, None


def is_main_stem(line: str) -> tuple[bool, int | None]:
    """行首是否为主题号（如 '9.' '9. ' '9.$...$'）。返回 (是否, 题号 N)。

    排除 4 位年份（2026.5）和小数（9.5）—— . 后必须是非数字字符。
    """
    m = _MAIN_STEM_RE.match(line)
    if m:
        return True, int(m.group(1))
    return False, None


def is_sub_stem(line: str) -> bool:
    """行首是否为小问号（如 '(1)' '（2）'）。"""
    return bool(_SUB_STEM_RE.match(line))


def is_answer_keyword(line: str) -> bool:
    """行内是否含答案关键字（参考答案/答案/评分参考）。"""
    return bool(_ANSWER_KEYWORD_RE.search(line))


def split_inline_stems(line: str) -> list[tuple[int, str]]:
    """紧凑格式：一行多题号（答案区 '9. xxx 10. yyy 11. zzz'）。

    返回 [(题号 N, 答案文本), ...]。无匹配返回空列表。
    """
    matches = list(_INLINE_STEM_RE.finditer(line))
    if not matches:
        return []
    results: list[tuple[int, str]] = []
    for i, m in enumerate(matches):
        n = int(m.group(1))
        # 答案文本从 . 后的 \D 字符开始（包含该字符），到下一题号起点前
        start = m.end() - 1  # 回退到 \D 字符位置
        end = matches[i + 1].start() if i + 1 < len(matches) else len(line)
        text = line[start:end].strip()
        results.append((n, text))
    return results
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd tools/data-refinery && pytest tests/test_question_splitter.py -v`
Expected: PASS — 全部 11 个测试通过

- [ ] **Step 5: 提交**

```bash
git add tools/data-refinery/src/question_splitter.py tools/data-refinery/tests/test_question_splitter.py
git commit -m "feat(data-refinery): 试卷题号识别工具函数 + 测试

question_splitter.py 的题号识别正则工具：主题号(行首 N.\\D)、小问号、
大题分组标题、日期陷阱、答案关键字、紧凑格式行内切分。"
```

---

## Task 2: split_page 题干切分（不含答案对齐）

**Files:**
- Modify: `tools/data-refinery/src/question_splitter.py`
- Test: `tools/data-refinery/tests/test_question_splitter.py`

**Interfaces:**
- Produces: `RawQuestion` dataclass、`split_page(text, md_path) -> list[RawQuestion]`（本任务只实现题干切分，答案字段留空）
- 主题号"N."剥离存 `group_order`，content 不含"9."字符；小问号"(3)"保留在 content

- [ ] **Step 1: 写失败测试（题干切分场景）**

Append to `tools/data-refinery/tests/test_question_splitter.py`:

```python
from question_splitter import split_page, RawQuestion


def test_split_page_single_question():
    text = "9. 若代数式 $\\frac{1}{x-3}$ 有意义, 则实数 $x$ 的取值范围是 ____."
    result = split_page(text, Path("test.md"))
    assert len(result) == 1
    assert result[0].group_order == 9
    assert result[0].content.startswith("若代数式")  # 主题号"9."剥离
    assert "9." not in result[0].content[:5]


def test_split_page_two_questions():
    text = (
        "9. 若代数式 $\\frac{1}{x-3}$ 有意义, 则实数 $x$ 的取值范围是 ____.\n"
        "10. 分解因式: $3ax^{2} - 6ax + 3a = $ ____."
    )
    result = split_page(text, Path("test.md"))
    assert len(result) == 2
    assert result[0].group_order == 9
    assert result[1].group_order == 10
    assert result[0].content.startswith("若代数式")
    assert result[1].content.startswith("分解因式")


def test_split_page_sub_questions_merged_into_parent():
    """小问号 (1)(2) 合并到上一个主题号 content。"""
    text = (
        "16. 某商店共有 $a$ 种不同型号的口罩...\n"
        "(1) 若 m=69, n=71，则 a 的值为 ____\n"
        "(2) 若丙购买的口罩包含三种颜色, 则丙用于购买白色和蓝色的口罩最多一共花费 ____ 元."
    )
    result = split_page(text, Path("test.md"))
    assert len(result) == 1  # 小问没切分，合并到第 16 题
    assert result[0].group_order == 16
    assert "(1) 若 m=69" in result[0].content
    assert "(2) 若丙购买" in result[0].content


def test_split_page_group_header_assigns_group_id():
    """大题分组标题行关闭当前题，记 group_id，标题行丢弃。"""
    text = (
        "8. 最后一道选择题 ...\n"
        "二、填空题（本题共 8 小题）\n"
        "9. 若代数式 ... 有意义 ..."
    )
    result = split_page(text, Path("test.md"))
    assert len(result) == 2
    assert result[0].group_order == 8
    assert result[0].group_id is None  # 第一题前面没分组标题
    assert result[1].group_order == 9
    assert result[1].group_id == "二"  # 第二题归属"二"组
    assert "填空题" not in result[0].content  # 标题行没混进第 8 题
    assert "填空题" not in result[1].content  # 也没混进第 9 题


def test_split_page_date_trap_filtered():
    """日期行 2026.5 不当作题号。"""
    text = (
        "2026.5\n"
        "9. 若代数式 ..."
    )
    result = split_page(text, Path("test.md"))
    assert len(result) == 1
    assert result[0].group_order == 9


def test_split_page_empty_text():
    assert split_page("", Path("test.md")) == []


def test_split_page_preserves_image_refs():
    """图片引用 ![](path) 原样保留在 content。"""
    text = "3. 如图 ![图形](images/abc.jpg) 所示, 直线 $AB$ 与 $CD$ 相交于点 $O$."
    result = split_page(text, Path("test.md"))
    assert len(result) == 1
    assert "![图形](images/abc.jpg)" in result[0].content
```

记得在文件顶部加 `from pathlib import Path`。

- [ ] **Step 2: 运行测试验证失败**

Run: `cd tools/data-refinery && pytest tests/test_question_splitter.py -v`
Expected: FAIL — `ImportError: cannot import name 'RawQuestion' from 'question_splitter'` 或 `split_page` 返回空

- [ ] **Step 3: 实现 RawQuestion + split_page（题干切分部分）**

Append to `tools/data-refinery/src/question_splitter.py`:

```python
from dataclasses import dataclass, field


@dataclass
class RawQuestion:
    """切分后的原始题（answer/explanation 由答案对齐阶段填入）。"""
    group_order: int                # 题号 N（主题号）
    group_id: str | None            # 大题分组（"一"/"二"/"三"...），无分组为 None
    content: str                    # 题干原文（主题号"N."已剥离，小问号"(N)"保留）
    answer: str = ""                # 答案（答案对齐阶段填入）
    explanation: str | None = None  # 解析（答案对齐阶段填入）


def _strip_main_stem_prefix(line: str) -> str:
    """剥离行首主题号 'N.' 前缀，保留剩余内容。

    '9. 若代数式' -> '若代数式'
    '9.若代数式' -> '若代数式'
    '9. $\\frac{1}{x-3}$' -> '$\\frac{1}{x-3}$'
    """
    return _MAIN_STEM_RE.sub('', line, count=1).strip()


def split_page(text: str, md_path: Path) -> list[RawQuestion]:
    """按题号切分试卷 MD，返回 RawQuestion 列表。

    本函数只完成题干切分；答案对齐由 align_answers 在调用方后续处理
    （本任务先返回 answer="" 的题列表，Task 3 在此函数内补答案对齐）。

    Args:
        text: 试卷 MD 全文（已 strip_chrome + normalize_fullwidth_parens）
        md_path: MD 文件路径（用于诊断日志，本函数不读）

    Returns:
        RawQuestion 列表，按题号顺序
    """
    questions: list[RawQuestion] = []
    current: RawQuestion | None = None
    current_group_id: str | None = None
    in_answer_section = False  # 本任务不处理答案区，标志位先占位

    for line in text.split('\n'):
        if not line.strip():
            continue  # 空行跳过（不进 content，保持题干干净）

        if is_date_trap(line):
            continue

        ok, gid = is_group_header(line)
        if ok:
            if current is not None:
                questions.append(current)
                current = None
            current_group_id = gid
            continue

        # 本任务不处理答案区，但保留检测逻辑占位（Task 3 启用）
        if not in_answer_section and is_answer_keyword(line):
            if current is not None:
                questions.append(current)
                current = None
            in_answer_section = True
            continue

        ok, n = is_main_stem(line)
        if ok:
            if current is not None:
                questions.append(current)
            current = RawQuestion(
                group_order=n,
                group_id=current_group_id,
                content=_strip_main_stem_prefix(line),
            )
            continue

        if is_sub_stem(line):
            if current is not None:
                current.content += "\n" + line
            continue

        # 其他行（含图片引用行、说明文字）
        if current is not None:
            current.content += "\n" + line
        # current 为 None 时丢弃（说明文字、孤立行）

    if current is not None:
        questions.append(current)

    return questions
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd tools/data-refinery && pytest tests/test_question_splitter.py -v`
Expected: PASS — 全部测试通过（Task 1 的 11 个 + Task 2 新增 7 个）

- [ ] **Step 5: 提交**

```bash
git add tools/data-refinery/src/question_splitter.py tools/data-refinery/tests/test_question_splitter.py
git commit -m "feat(data-refinery): split_page 题干切分（主题号剥离+小问号合并+分组标题）

RawQuestion dataclass + split_page 函数：按行扫描，主题号开新题、小问号
合并到当前题、大题分组标题关闭当前题并记 group_id、日期陷阱过滤、图片
引用原样保留在 content。"
```

---

## Task 3: 答案对齐（紧凑格式 + 展开格式 + 一题多小问）

**Files:**
- Modify: `tools/data-refinery/src/question_splitter.py`
- Test: `tools/data-refinery/tests/test_question_splitter.py`

**Interfaces:**
- Extends: `split_page` 在切分时同步对齐答案（`in_answer_section` 标志切换题干/答案）
- Produces: `RawQuestion.answer` / `RawQuestion.explanation` 填好

- [ ] **Step 1: 写失败测试（答案对齐场景）**

Append to `tools/data-refinery/tests/test_question_splitter.py`:

```python
def test_answer_alignment_compact_format():
    """紧凑格式：选择题/填空题答案一行多题号。"""
    text = (
        "9. 若代数式 $\\frac{1}{x-3}$ 有意义, 则实数 $x$ 的取值范围是 ____.\n"
        "10. 分解因式: $3ax^{2} - 6ax + 3a = $ ____.\n"
        "参考答案\n"
        "9. $x \\neq 3$ 10. $3a(x - 1)^2$"
    )
    result = split_page(text, Path("test.md"))
    assert len(result) == 2
    assert result[0].answer == r"$x \neq 3$"
    assert result[1].answer == r"$3a(x - 1)^2$"


def test_answer_alignment_expanded_format():
    """展开格式：解答题答案一题一段，含'解：'前缀，剥离前缀只留内容。"""
    text = (
        "17. 计算: $(\\frac{1}{3})^{-1} + 4\\sin 45^{\\circ} - \\sqrt{18} - (\\pi - 2026)^{0}$.\n"
        "参考答案\n"
        "17. 解: $3 + 4 \\times \\frac{\\sqrt{2}}{2} - 3\\sqrt{2} - 1 = 2$."
    )
    result = split_page(text, Path("test.md"))
    assert len(result) == 1
    assert result[0].answer == r"$3 + 4 \times \frac{\sqrt{2}}{2} - 3\sqrt{2} - 1 = 2$."
    assert "解:" not in result[0].answer  # "解："前缀剥离


def test_answer_alignment_multiline_answer():
    """答案跨多行，按下一题号起点切，自然包含多行。"""
    text = (
        "18. 解不等式组: $\\left\\{ ... \\right.$\n"
        "参考答案\n"
        "18. 解: 原不等式组为 $\\left\\{ ... \\right.$\n"
        由不等式①得 $x > -3$\n
        由不等式②得 $x \\leq 2$\n"
        所以原不等式组的解集为 $-3 < x \\leq 2$."
    )
    result = split_page(text, Path("test.md"))
    assert len(result) == 1
    assert "原不等式组为" in result[0].answer
    assert "解集为" in result[0].answer


def test_answer_alignment_sub_questions_merged():
    """一题多小问的答案（20题 (1)(2)(3)）合并到该题 answer。"""
    text = (
        "20. 如图, 在 Rt△ABC 中...\n"
        "(1) 求证: 四边形 AEBD 是平行四边形\n"
        "(2) 若 BE=2, 求 AB 的长\n"
        "参考答案\n"
        "20. (1) 证明: ∵ AE⊥AC, ...\n"
        "(2) 解: ∵ 在 Rt△ABC 中, ..."
    )
    result = split_page(text, Path("test.md"))
    assert len(result) == 1
    assert "证明: ∵ AE⊥AC" in result[0].answer
    assert "解: ∵ 在 Rt△ABC" in result[0].answer


def test_answer_alignment_missing_answer_stays_empty():
    """答案区没出现的题，answer 留空。"""
    text = (
        "9. 第一题\n"
        "10. 第二题\n"
        "参考答案\n"
        "9. 第一题答案"
        # 10 题没给答案
    )
    result = split_page(text, Path("test.md"))
    assert len(result) == 2
    assert result[0].answer == "第一题答案"
    assert result[1].answer == ""


def test_answer_keyword_only_section_header():
    """'参考答案' 关键字行本身丢弃，不进任何题 content。"""
    text = (
        "9. 题干\n"
        "参考答案\n"
        "9. 答案"
    )
    result = split_page(text, Path("test.md"))
    assert len(result) == 1
    assert "参考答案" not in result[0].content
    assert "参考答案" not in result[0].answer
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd tools/data-refinery && pytest tests/test_question_splitter.py -v`
Expected: Task 3 新增的 6 个测试 FAIL（answer 字段为空）

- [ ] **Step 3: 在 split_page 里实现答案对齐**

Modify `split_page` in `tools/data-refinery/src/question_splitter.py`，把 `in_answer_section` 标志用起来，并在主题号分支处理答案：

```python
def _strip_answer_prefix(text: str) -> str:
    """剥离答案文本开头的'解：'/'证明：'等前缀，只留内容。"""
    return re.sub(r'^\s*(解|证明|原式|原不等式组)[：:]\s*', '', text.strip())


def split_page(text: str, md_path: Path) -> list[RawQuestion]:
    """按题号切分试卷 MD 并对齐答案，返回 RawQuestion 列表。"""
    questions: list[RawQuestion] = []
    current: RawQuestion | None = None
    current_group_id: str | None = None
    in_answer_section = False
    current_answer_lines: list[str] = []  # 当前累积的答案文本（多行）
    current_answer_n: int | None = None  # 当前答案属于哪个题号

    def _flush_answer():
        """把累积的答案塞入对应题。"""
        nonlocal current_answer_lines, current_answer_n
        if current_answer_n is None or not current_answer_lines:
            current_answer_lines = []
            current_answer_n = None
            return
        answer_text = _strip_answer_prefix("\n".join(current_answer_lines))
        for q in questions:
            if q.group_order == current_answer_n:
                if q.answer:
                    q.answer += "\n" + answer_text  # 多段答案合并
                else:
                    q.answer = answer_text
                break
        current_answer_lines = []
        current_answer_n = None

    for line in text.split('\n'):
        if not line.strip():
            continue

        if is_date_trap(line):
            continue

        ok, gid = is_group_header(line)
        if ok:
            if in_answer_section:
                _flush_answer()
            else:
                if current is not None:
                    questions.append(current)
                    current = None
            current_group_id = gid
            continue

        if not in_answer_section and is_answer_keyword(line):
            if current is not None:
                questions.append(current)
                current = None
            in_answer_section = True
            continue

        # 主题号处理（含紧凑格式一行多题号）
        inline_stems = split_inline_stems(line) if in_answer_section else []
        ok, n = is_main_stem(line)

        if in_answer_section:
            if inline_stems:
                # 紧凑格式：一行多题号答案
                _flush_answer()  # 先把上一段答案塞入
                if len(inline_stems) == 1:
                    current_answer_n = inline_stems[0][0]
                    current_answer_lines = [inline_stems[0][1]]
                else:
                    # 多个题号一行：每个题号独立成段，立即 flush
                    for stem_n, stem_text in inline_stems:
                        current_answer_n = stem_n
                        current_answer_lines = [stem_text]
                        _flush_answer()
                    current_answer_n = None
            elif ok:
                # 展开格式：行首单题号，开始新答案段
                _flush_answer()
                rest = _strip_main_stem_prefix(line)
                current_answer_n = n
                current_answer_lines = [rest] if rest else []
            else:
                # 答案段的续行（含小问号行 (1)(2)）
                if current_answer_n is not None:
                    current_answer_lines.append(line)
            continue

        # 题干区
        if ok:
            if current is not None:
                questions.append(current)
            current = RawQuestion(
                group_order=n,
                group_id=current_group_id,
                content=_strip_main_stem_prefix(line),
            )
            continue

        if is_sub_stem(line):
            if current is not None:
                current.content += "\n" + line
            continue

        if current is not None:
            current.content += "\n" + line

    # 末尾 flush 残留答案 + 残留题
    if in_answer_section:
        _flush_answer()
    if current is not None:
        questions.append(current)

    return questions
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd tools/data-refinery && pytest tests/test_question_splitter.py -v`
Expected: PASS — 全部测试通过（Task 1+2+3 共 24 个）

- [ ] **Step 5: 提交**

```bash
git add tools/data-refinery/src/question_splitter.py tools/data-refinery/tests/test_question_splitter.py
git commit -m "feat(data-refinery): 答案对齐（紧凑格式+展开格式+一题多小问）

split_page 内 in_answer_section 标志切换题干/答案，紧凑格式行内切分、
展开格式按行首题号、多行答案合并、'解：'前缀剥离、答案按题号对齐到题。"
```

---

## Task 4: 答案合并检测（_maybe_merge_answer_md）

**Files:**
- Create: `tools/data-refinery/src/answer_merger.py`（独立小模块，便于单测）
- Test: `tools/data-refinery/tests/test_answer_merger.py`

**Interfaces:**
- Produces: `maybe_merge_answer_md(md_path: Path, text: str) -> str`——检测 text 末尾是否含答案关键字；若无，找同名"-答案.md"（文件名里"-试卷"替换为"-答案"），存在则把内容追加到 text 末尾返回

- [ ] **Step 1: 写失败测试**

Create `tools/data-refinery/tests/test_answer_merger.py`:

```python
from pathlib import Path
from answer_merger import maybe_merge_answer_md


def test_text_has_answer_keyword_no_merge(tmp_path):
    """text 末尾含'参考答案'关键字，不合并，原样返回。"""
    text = "9. 题干\n参考答案\n9. 答案"
    result = maybe_merge_answer_md(tmp_path / "试卷.md", text)
    assert result == text


def test_no_answer_md_file_returns_original(tmp_path):
    """text 无答案关键字，且找不到答案 MD，原样返回。"""
    paper = tmp_path / "数学-初三(下)-202607-西城-模拟二-试卷.md"
    paper.write_text("9. 题干", encoding="utf-8")
    result = maybe_merge_answer_md(paper, "9. 题干")
    assert result == "9. 题干"


def test_answer_md_merged_when_no_answer_in_paper(tmp_path):
    """text 无答案关键字，找到同名答案 MD，内容合并到末尾。"""
    paper = tmp_path / "数学-初三(下)-202607-西城-模拟二-试卷.md"
    answer = tmp_path / "数学-初三(下)-202607-西城-模拟二-答案.md"
    paper.write_text("9. 题干", encoding="utf-8")
    answer.write_text("参考答案\n9. 答案", encoding="utf-8")
    result = maybe_merge_answer_md(paper, "9. 题干")
    assert "9. 题干" in result
    assert "参考答案" in result
    assert "9. 答案" in result
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd tools/data-refinery && pytest tests/test_answer_merger.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'answer_merger'`

- [ ] **Step 3: 实现 maybe_merge_answer_md**

Create `tools/data-refinery/src/answer_merger.py`:

```python
"""答案合并检测：试卷 MD 末尾无答案时，找同名"-答案.md"合并到末尾。

用户方案：试卷末尾自带答案就用；没有就找同名答案 MD 合并到末尾统一处理；
都没有则所有题答案留空（做题时大模型补）。
"""

from pathlib import Path
from question_splitter import is_answer_keyword


def maybe_merge_answer_md(md_path: Path, text: str) -> str:
    """若 text 末尾无答案关键字，找同名"-答案.md"合并到末尾。

    Args:
        md_path: 试卷 MD 路径，用于推导答案 MD 路径（文件名"-试卷"替换为"-答案"）
        text: 试卷 MD 全文

    Returns:
        text 本身（若已有答案 or 找不到答案 MD），或合并答案后的全文
    """
    # 若 text 末尾（最后 200 字符）已含答案关键字，无需合并
    tail = text[-200:] if len(text) > 200 else text
    if any(is_answer_keyword(line) for line in tail.split('\n')):
        return text

    # 推导答案 MD 路径：文件名里 "-试卷" 替换为 "-答案"
    answer_path = md_path.with_name(md_path.name.replace("-试卷", "-答案"))
    if not answer_path.exists():
        return text

    answer_text = answer_path.read_text(encoding="utf-8")
    return text + "\n\n" + answer_text
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd tools/data-refinery && pytest tests/test_answer_merger.py -v`
Expected: PASS — 3 个测试全过

- [ ] **Step 5: 提交**

```bash
git add tools/data-refinery/src/answer_merger.py tools/data-refinery/tests/test_answer_merger.py
git commit -m "feat(data-refinery): 答案合并检测 maybe_merge_answer_md

试卷 MD 末尾无答案关键字时，找同名'-答案.md'合并到末尾，统一处理；
找不到答案 MD 则原样返回（answer 留空）。"
```

---

## Task 5: question_labeler.py LLM 标注 + prompt

**Files:**
- Create: `tools/data-refinery/src/question_labeler.py`
- Create: `tools/data-refinery/src/prompts/question_labeler.txt`
- Test: `tools/data-refinery/tests/test_question_labeler.py`

**Interfaces:**
- Produces: `LabeledQuestion` dataclass（RawQuestion + type/difficulty/knowledge_points/suggested_new_kps）、`QuestionLabeler` 类（`__init__(llm, prompt, knowledge_points, fallback_labeler=None)`、`label(questions, batch_size=1) -> list[LabeledQuestion]`、`confirm_new_kps(labeled) -> list[LabeledQuestion]`——confirm_new_kps 在 Task 6 实现）
- 知识点列表由调用方（extract_cli）从 DB 查询后注入，question_labeler 不直接查 DB（便于单测 mock）

- [ ] **Step 1: 写 prompt 模板**

Create `tools/data-refinery/src/prompts/question_labeler.txt`:

```text
你是 K12 数学教育内容标注专家。对下面这道初中数学题进行分类标注。

【输出格式 -- 必须严格遵守】
1. 只输出一个 JSON 对象，形如 {"items": [{...}]}（批量模式多题）或单题直接 {...}，不要输出任何其它内容。
2. 不要使用 ```json``` 等 markdown 代码块；输出的第一个字符必须是 {，最后一个字符必须是 }。
3. 字符串值必须是合法 JSON：换行用 \n 表示。

【每道题字段】
- type: 只能是 "choice"（选择）、"fill_blank"（填空）、"true_false"（判断）、"short_answer"（简答）、"proof"（证明）
- difficulty: 难度 1-3
    1 简单：基础概念/直接套公式/一步计算
    2 中等：综合应用/多步推理
    3 困难：复杂证明/多知识点综合/开放探究
- knowledge_points: 知识点 code 列表（从下列已有知识点中选，0..N 个）
- suggested_new_kps: 建议新增的知识点名称列表（仅当题目涉及下列列表中不存在的知识点时才填，否则空数组 []）

【知识点标注约束 -- 必须遵守】
除非确实是题目涉及的、下列列表中不存在的新知识点，禁止在没有合理理由的情况下增加新知识点。优先从已有列表中选；只有当题目确实涉及列表中不存在的知识点时，才在 suggested_new_kps 输出名称。

【已有知识点列表（code + name）】
{{knowledge_points}}

【输入题】
{{question}}
```

- [ ] **Step 2: 写失败测试（mock LLM 标注）**

Create `tools/data-refinery/tests/test_question_labeler.py`:

```python
from question_labeler import QuestionLabeler, LabeledQuestion
from question_splitter import RawQuestion


def _fake_response(content: str):
    return type("R", (), {"content": content})()


def _fake_llm_single_question():
    """mock LLM：对单题返回 type/difficulty/kp。"""
    class FakeLLM:
        def complete(self, system, user):
            return _fake_response(
                '{"type":"fill_blank","difficulty":2,'
                '"knowledge_points":["M0101"],"suggested_new_kps":[]}'
            )
    return FakeLLM()


def _fake_llm_with_suggested_new_kp():
    """mock LLM：输出一个 suggested_new_kp。"""
    class FakeLLM:
        def complete(self, system, user):
            return _fake_response(
                '{"type":"short_answer","difficulty":3,'
                '"knowledge_points":["M0302"],"suggested_new_kps":["新知识点X"]}'
            )
    return FakeLLM()


KPS = [
    {"code": "M0101", "name": "有理数的概念与分类"},
    {"code": "M0302", "name": "分式及其性质"},
]


def test_label_single_question_no_new_kp():
    labeler = QuestionLabeler(
        llm=_fake_llm_single_question(),
        prompt="type/difficulty/kp:\n{{question}}\nKP列表:\n{{knowledge_points}}",
        knowledge_points=KPS,
    )
    q = RawQuestion(group_order=9, group_id=None, content="若代数式 ...")
    labeled = labeler.label([q], batch_size=1)
    assert len(labeled) == 1
    assert labeled[0].type == "fill_blank"
    assert labeled[0].difficulty == 2
    assert labeled[0].knowledge_points == ["M0101"]
    assert labeled[0].suggested_new_kps == []


def test_label_single_question_with_suggested_new_kp():
    labeler = QuestionLabeler(
        llm=_fake_llm_with_suggested_new_kp(),
        prompt="{{question}}\n{{knowledge_points}}",
        knowledge_points=KPS,
    )
    q = RawQuestion(group_order=17, group_id="三", content="某新颖题...")
    labeled = labeler.label([q], batch_size=1)
    assert labeled[0].suggested_new_kps == ["新知识点X"]


def test_label_prompt_injects_kp_list():
    """prompt 的 {{knowledge_points}} 占位符被替换为已有 KP 列表。"""
    captured = {}

    class CaptureLLM:
        def complete(self, system, user):
            captured["user"] = user
            return _fake_response(
                '{"type":"fill_blank","difficulty":1,'
                '"knowledge_points":[],"suggested_new_kps":[]}'
            )
    labeler = QuestionLabeler(
        llm=CaptureLLM(),
        prompt="KP:\n{{knowledge_points}}\nQ:\n{{question}}",
        knowledge_points=KPS,
    )
    q = RawQuestion(group_order=1, group_id=None, content="题干")
    labeler.label([q], batch_size=1)
    assert "M0101" in captured["user"]
    assert "有理数的概念与分类" in captured["user"]


def test_label_llm_failure_returns_empty_fields():
    """LLM 抛异常时该题 type=""、knowledge_points=[]，不影响其他题。"""
    class FailingLLM:
        def complete(self, system, user):
            raise RuntimeError("network error")
    labeler = QuestionLabeler(
        llm=FailingLLM(),
        prompt="{{question}}",
        knowledge_points=KPS,
    )
    q = RawQuestion(group_order=1, group_id=None, content="题干")
    labeled = labeler.label([q], batch_size=1)
    assert labeled[0].type == ""
    assert labeled[0].knowledge_points == []
```

- [ ] **Step 3: 运行测试验证失败**

Run: `cd tools/data-refinery && pytest tests/test_question_labeler.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'question_labeler'`

- [ ] **Step 4: 实现 QuestionLabeler（不含 confirm_new_kps，Task 6 再加）**

Create `tools/data-refinery/src/question_labeler.py`:

```python
"""试卷题 LLM 标注器：标 type/difficulty/知识点 + 双模型确认新增 KP。

LLM 只标注元数据，不改 content、不给答案（answer 由 question_splitter 按题号对齐）。
知识点列表由调用方从 DB 查询后注入（动态读取，不写死在 prompt 文件）。
"""

import json
from dataclasses import dataclass
from typing import Callable

from extract import _parse_json_object  # 复用 JSON 解析逻辑
from question_splitter import RawQuestion


@dataclass
class LabeledQuestion:
    """标注后的题（RawQuestion 字段 + LLM 标注）。"""
    group_order: int
    group_id: str | None
    content: str
    answer: str
    explanation: str | None
    type: str = ""                       # choice/fill_blank/true_false/short_answer/proof
    difficulty: int = 2                  # 1-3，默认 2
    knowledge_points: list[str] = None   # 已有 KP code 列表
    suggested_new_kps: list[str] = None  # 建议新增的 KP 名称
    _confirmed_new_kps: list[dict] = None  # 双模型确认的新增 KP（Task 6 填）
    _suggested_new_kps: list[dict] = None  # 未通过双模型确认的（Task 6 填）

    @classmethod
    def from_raw(cls, q: RawQuestion) -> "LabeledQuestion":
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

    def label(self, questions: list[RawQuestion], batch_size: int = 1) -> list[LabeledQuestion]:
        """标注题列表。batch_size=1 每题单独调，0 全部一次，N 每 N 题一批。"""
        if batch_size == 0:
            return self._label_batch(questions)
        result: list[LabeledQuestion] = []
        for i in range(0, len(questions), batch_size):
            batch = questions[i:i + batch_size]
            result.extend(self._label_batch(batch))
        return result

    def _label_batch(self, batch: list[RawQuestion]) -> list[LabeledQuestion]:
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

    def _label_one(self, q: RawQuestion) -> LabeledQuestion:
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

    def _build_multi_prompt(self, batch: list[RawQuestion]) -> str:
        q_text = "\n\n".join(f"## 题 {q.group_order}\n{q.content}" for q in batch)
        return self._build_single_prompt(q_text)

    def _fill_from_item(self, labeled: LabeledQuestion, item: dict):
        """从 LLM 输出 item 填充 labeled 字段。"""
        labeled.type = str(item.get("type", "") or "")
        try:
            labeled.difficulty = int(item.get("difficulty", 2) or 2)
            if not 1 <= labeled.difficulty <= 3:
                labeled.difficulty = 2
        except (TypeError, ValueError):
            labeled.difficulty = 2
        labeled.knowledge_points = list(item.get("knowledge_points", []) or [])
        labeled.suggested_new_kps = list(item.get("suggested_new_kps", []) or [])
```

- [ ] **Step 5: 运行测试验证通过**

Run: `cd tools/data-refinery && pytest tests/test_question_labeler.py -v`
Expected: PASS — 4 个测试全过

- [ ] **Step 6: 提交**

```bash
git add tools/data-refinery/src/question_labeler.py tools/data-refinery/src/prompts/question_labeler.txt tools/data-refinery/tests/test_question_labeler.py
git commit -m "feat(data-refinery): question_labeler LLM 标注 + prompt 模板

QuestionLabeler 类：LLM 标 type/difficulty/knowledge_points/suggested_new_kps，
知识点列表从外部注入（调用方从 DB 查），prompt 含约束'禁止无合理理由增加
新知识点'，batch_size 支持每题单独/全部一次/分批。"
```

---

## Task 6: 双模型确认新增知识点

**Files:**
- Modify: `tools/data-refinery/src/question_labeler.py`
- Test: `tools/data-refinery/tests/test_question_labeler.py`

**Interfaces:**
- Produces: `QuestionLabeler.confirm_new_kps(labeled: list[LabeledQuestion]) -> list[LabeledQuestion]`——AND 逻辑：两个模型都认为新增才填入 `_confirmed_new_kps`，任一不认同就不新增

- [ ] **Step 1: 写失败测试（双模型确认场景）**

Append to `tools/data-refinery/tests/test_question_labeler.py`:

```python
def test_confirm_new_kps_both_agree_new():
    """两个模型都认为是新增 → 填入 _confirmed_new_kps。"""
    # 主模型已标 suggested_new_kps=["新KP_X"]（label 阶段）
    main_labeler = QuestionLabeler(
        llm=_fake_llm_with_suggested_new_kp(),
        prompt="{{question}}\n{{knowledge_points}}",
        knowledge_points=KPS,
    )
    q = RawQuestion(group_order=1, group_id=None, content="题")
    labeled = main_labeler.label([q], batch_size=1)
    assert labeled[0].suggested_new_kps == ["新知识点X"]

    # 兜底模型确认 is_new=true
    class ConfirmLLM:
        def complete(self, system, user):
            return _fake_response('{"is_new":true,"matched_existing_code":null}')
    fallback = QuestionLabeler(
        llm=ConfirmLLM(),
        prompt="{{question}}\n{{knowledge_points}}",
        knowledge_points=KPS,
    )
    main_labeler._fallback = fallback
    confirmed = main_labeler.confirm_new_kps(labeled)
    assert len(confirmed[0]._confirmed_new_kps) == 1
    assert confirmed[0]._confirmed_new_kps[0]["name"] == "新知识点X"


def test_confirm_new_kps_fallback_says_not_new():
    """兜底模型认为不新增 → _confirmed_new_kps 为空。"""
    main_labeler = QuestionLabeler(
        llm=_fake_llm_with_suggested_new_kp(),
        prompt="{{question}}\n{{knowledge_points}}",
        knowledge_points=KPS,
    )
    q = RawQuestion(group_order=1, group_id=None, content="题")
    labeled = main_labeler.label([q], batch_size=1)

    class ConfirmLLM:
        def complete(self, system, user):
            return _fake_response('{"is_new":false,"matched_existing_code":"M0101"}')
    main_labeler._fallback = QuestionLabeler(
        llm=ConfirmLLM(),
        prompt="{{question}}\n{{knowledge_points}}",
        knowledge_points=KPS,
    )
    confirmed = main_labeler.confirm_new_kps(labeled)
    assert confirmed[0]._confirmed_new_kps == []
    # matched_existing_code 替换：knowledge_points 加入 M0101（如尚未存在）
    assert "M0101" in confirmed[0].knowledge_points


def test_confirm_new_kps_no_suggested():
    """没有 suggested_new_kps 时，confirm_new_kps 不做任何事。"""
    main_labeler = QuestionLabeler(
        llm=_fake_llm_single_question(),
        prompt="{{question}}\n{{knowledge_points}}",
        knowledge_points=KPS,
    )
    q = RawQuestion(group_order=1, group_id=None, content="题")
    labeled = main_labeler.label([q], batch_size=1)
    assert labeled[0].suggested_new_kps == []
    confirmed = main_labeler.confirm_new_kps(labeled)
    assert confirmed[0]._confirmed_new_kps == []


def test_confirm_new_kps_no_fallback_labeler_skipped():
    """无 fallback_labeler 时，跳过确认（_confirmed_new_kps 为空）。"""
    main_labeler = QuestionLabeler(
        llm=_fake_llm_with_suggested_new_kp(),
        prompt="{{question}}\n{{knowledge_points}}",
        knowledge_points=KPS,
    )
    q = RawQuestion(group_order=1, group_id=None, content="题")
    labeled = main_labeler.label([q], batch_size=1)
    # _fallback 为 None
    confirmed = main_labeler.confirm_new_kps(labeled)
    assert confirmed[0]._confirmed_new_kps == []
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd tools/data-refinery && pytest tests/test_question_labeler.py -v`
Expected: Task 6 新增 4 个测试 FAIL — `AttributeError: 'QuestionLabeler' object has no attribute 'confirm_new_kps'`

- [ ] **Step 3: 实现 confirm_new_kps**

Append to `tools/data-refinery/src/question_labeler.py`:

```python
    def confirm_new_kps(self, labeled: list[LabeledQuestion]) -> list[LabeledQuestion]:
        """双模型确认新增 KP（AND 逻辑）。

        - 主模型已标 suggested_new_kps（label 阶段）
        - 对每个建议新增的 KP，调 fallback_labeler 确认
        - 两个模型都认为 is_new=true → 填入 _confirmed_new_kps
        - 兜底模型找到已有匹配 → 用 matched_existing_code 替换
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
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd tools/data-refinery && pytest tests/test_question_labeler.py -v`
Expected: PASS — 8 个测试全过（Task 5 的 4 个 + Task 6 的 4 个）

- [ ] **Step 5: 提交**

```bash
git add tools/data-refinery/src/question_labeler.py tools/data-refinery/tests/test_question_labeler.py
git commit -m "feat(data-refinery): 双模型确认新增知识点（AND 逻辑，无人审核）

confirm_new_kps：收集主模型 suggested_new_kps，调 fallback 模型确认，
两个都认为 is_new=true 才填入 _confirmed_new_kps；兜底找到已有匹配则
加入 knowledge_points；任一不认同则不新增。无 fallback 时跳过。"
```

---

## Task 7: extract_cli.py 集成（kind 分支 + 参数）

**Files:**
- Modify: `tools/data-refinery/src/extract_cli.py`
- Test: `tools/data-refinery/tests/test_extract_cli.py`（追加）

**Interfaces:**
- Consumes: `question_splitter.split_page`、`question_labeler.QuestionLabeler`、`answer_merger.maybe_merge_answer_md`、`publish_cli._kind_for`（或 extract_cli 内复刻同款）
- Produces: extract_cli.py main() 内 kind 分支，输出 ExamQuestion JSONL

- [ ] **Step 1: 写失败测试（kind 判定 + 参数解析）**

Append to `tools/data-refinery/tests/test_extract_cli.py`（若已存在）或创建新文件：

```python
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

# conftest 已把 src/ 加 sys.path
from extract_cli import _kind_for, parse_args


def test_kind_for_paper_file():
    assert _kind_for(Path("数学-初三(下)-202607-西城-模拟二-试卷")) == "questions"
    assert _kind_for(Path("数学-初三(下)-202607-西城-模拟二-答案")) == "questions"


def test_kind_for_textbook_file():
    assert _kind_for(Path("page_008")) == "cards"


def test_parse_args_label_batch_size_default():
    args = parse_args([])
    assert args.label_batch_size == 1
    assert args.subject == "数学"


def test_parse_args_label_batch_size_custom():
    args = parse_args(["--label-batch-size", "0"])
    assert args.label_batch_size == 0
    args = parse_args(["--label-batch-size", "10"])
    assert args.label_batch_size == 10
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd tools/data-refinery && pytest tests/test_extract_cli.py -v`
Expected: FAIL — `_kind_for` 不存在 或 `--label-batch-size` 未识别

- [ ] **Step 3: 修改 extract_cli.py**

修改点：
1. 加 `--subject`（默认"数学"）和 `--label-batch-size`（默认 1）参数
2. 加 `_kind_for(rel_file)` 函数（复刻 publish_cli 同款）
3. 在 main() 主循环加 kind 分支：questions 走新路径，cards 走原路径
4. 加 `_write_exam_questions_jsonl` 写 ExamQuestion JSONL

在 `extract_cli.py` 适当位置加：

```python
def _kind_for(rel_file: Path) -> str:
    """按文件名判 questions vs cards（与 publish_cli._kind_for 一致）。"""
    name = rel_file.name
    if "试卷" in name or "答案" in name:
        return "questions"
    return "cards"


def _write_exam_questions_jsonl(labeled: list, source, extracted_dir: Path,
                                 source_year: int, subject_code: str,
                                 grade_band: str):
    """写 ExamQuestion JSONL（扩展字段带下划线前缀）。"""
    rel_file = source.rel_path / source.md_path.name
    out_file = extracted_dir / rel_file.with_suffix(".jsonl")
    out_file.parent.mkdir(parents=True, exist_ok=True)
    source_name = source.md_path.stem  # 文件名去扩展名
    with out_file.open("w", encoding="utf-8") as f:
        for q in labeled:
            item = {
                "subject_id": subject_code,
                "group_id": q.group_id,
                "group_order": q.group_order,
                "type": q.type,
                "difficulty": q.difficulty,
                "content": q.content,
                "options": None,  # 本任务不切选项（留给后续）
                "answer": q.answer,
                "explanation": q.explanation,
                "material_text": None,  # 数学不抽取
                "grade_band": grade_band,
                "source": source_name,
                "source_year": source_year,
                "knowledge_points": q.knowledge_points,
                "_confirmed_new_kps": q._confirmed_new_kps,
                "_suggested_new_kps": q._suggested_new_kps,
            }
            f.write(json.dumps(item, ensure_ascii=False) + "\n")
```

在 `parse_args` 加：

```python
parser.add_argument("--subject", default="数学", help="学科过滤（当前实现数学）")
parser.add_argument("--label-batch-size", type=int, default=1,
                    help="仅 questions：每 N 题一批调 LLM。0=全部一次，1=每题一次（默认）")
```

在 `main()` 主循环 `for idx, source in enumerate(sources, 1):` 里加 kind 分支：

```python
kind = _kind_for(source.rel_path / source.md_path.name)
if kind == "questions":
    # 试卷题路径
    text = strip_chrome(source.md_path.read_text(encoding="utf-8"), chrome)
    text = normalize_fullwidth_parens(text)
    # 答案合并
    from answer_merger import maybe_merge_answer_md
    text = maybe_merge_answer_md(source.md_path, text)
    # 切分 + 答案对齐
    from question_splitter import split_page
    raw_questions = split_page(text, source.md_path)
    if not raw_questions:
        checkpoint.mark_extracted(file_key)
        print(f"[ok] ({idx}/{total}) {file_key} -> 0 items (empty)", flush=True)
        extracted += 1
        continue
    # LLM 标注
    from question_labeler import QuestionLabeler
    from db_loader import query_knowledge_points  # 见 Step 4
    kps = query_knowledge_points(config, subject_code="math")
    labeler = QuestionLabeler(
        llm=llm, prompt=prompt_questions, knowledge_points=kps,
        fallback_labeler=fallback_labeler,
    )
    labeled = labeler.label(raw_questions, batch_size=args.label_batch_size)
    labeled = labeler.confirm_new_kps(labeled)
    # 元数据
    import re as _re
    year_match = _re.search(r'-(\d{6})-', source.md_path.stem)
    source_year = int(year_match.group(1)[:4]) if year_match else 0
    grade_band = "junior" if "初三" in source.md_path.stem else "senior"
    _write_exam_questions_jsonl(labeled, source, extracted_dir,
                                  source_year, "math", grade_band)
    checkpoint.mark_extracted(file_key)
    print(f"[ok] ({idx}/{total}) {file_key} -> {len(labeled)} items (questions)", flush=True)
    extracted += 1
    continue
# else: 教材卡路径（原逻辑不动）
```

prompt 加载（main() 开头）：

```python
prompt_questions = _load_prompt("question_labeler")  # 新 prompt
```

- [ ] **Step 4: 在 db_loader.py 加 query_knowledge_points 辅助函数**

Modify `tools/data-refinery/src/db_loader.py`（或独立模块 `kp_loader.py`），加：

```python
def query_knowledge_points(config, subject_code: str) -> list[dict]:
    """从 DB 查全量知识点列表（动态注入 prompt）。"""
    import pymysql
    conn = pymysql.connect(
        host=config.db_host, port=config.db_port,
        user=config.db_user, password=config.db_pass,
        database=config.db_name, charset="utf8mb4",
    )
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT code, name FROM knowledge_points "
                "WHERE subject_id=(SELECT id FROM subjects WHERE code=%s)",
                (subject_code,)
            )
            return [{"code": r[0], "name": r[1]} for r in cur.fetchall()]
    finally:
        conn.close()
```

- [ ] **Step 5: 运行测试验证通过**

Run: `cd tools/data-refinery && pytest tests/test_extract_cli.py -v`
Expected: PASS — 新增 4 个测试 + 原有测试全过

- [ ] **Step 6: 提交**

```bash
git add tools/data-refinery/src/extract_cli.py tools/data-refinery/src/db_loader.py tools/data-refinery/tests/test_extract_cli.py
git commit -m "feat(data-refinery): extract_cli 加 kind 分支（试卷走新路径）

_kind_for 按文件名判 questions/cards；questions 路径调 question_splitter
+ question_labeler + answer_merger，输出 ExamQuestion JSONL；加 --subject
和 --label-batch-size 参数；db_loader 加 query_knowledge_points 从 DB
动态查 KP 列表注入 prompt。教材卡路径不动。"
```

---

## Task 8: 端到端验证（西城模拟二）

**Files:**
- 无新文件，跑命令验证

- [ ] **Step 1: 跑 extract_cli 切西城模拟二（只切题 + 标注，不 publish 不入库）**

Run:
```bash
cd tools/data-refinery
python src/extract_cli.py --source zgkao \
  --file "数学-初三(下)-202607-西城-模拟二-试卷" \
  --reconvert
```
Expected: `[ok] (1/1) ... -> N items (questions)`，N ≈ 28 道

- [ ] **Step 2: 检查 JSONL 内容**

Run:
```bash
python3 -c "
import json
p = 'output/extracted/数学/初中/second/2026/数学-初三(下)-202607-西城-模拟二-试卷/数学-初三(下)-202607-西城-模拟二-试卷.jsonl'
lines = [l for l in open(p) if l.strip()]
print(f'题数: {len(lines)}')
for i, l in enumerate(lines, 1):
    o = json.loads(l)
    print(f'题{i}: group_order={o[\"group_order\"]} type={o[\"type\"]} diff={o[\"difficulty\"]}')
    print(f'  content(前80): {o[\"content\"][:80]}')
    print(f'  answer(前40): {(o[\"answer\"] or \"\")[:40]}')
    print(f'  kp: {o[\"knowledge_points\"]}')
"
```
Expected:
- 题数 ≈ 28（西城模拟二共 28 道题）
- 每题 group_order 1-28
- type 有值（choice/fill_blank/short_answer/proof）
- 第 9 题 answer = "$x \neq 3$"（验证答案对齐）
- 第 17 题 answer 含"3 + 4 × ..."（验证解答题答案对齐）
- content 含图片引用 `![](images/xxx.jpg)`（验证图保留）

- [ ] **Step 3: 跑回归测试（教材卡路径不破坏）**

Run: `cd tools/data-refinery && pytest -v`
Expected: PASS — 全部测试通过（含原教材卡测试 + 新增 question_splitter/labeler/answer_merger/extract_cli 测试）

- [ ] **Step 4: 提交验证记录（可选）**

```bash
git add --all
git commit -m "test(data-refinery): 端到端验证西城模拟二切题正确

切出 28 道 ExamQuestion，答案按题号对齐，图片引用保留，type/difficulty/
知识点有值。教材卡回归测试全过。"
```

---

## Self-Review 检查

**1. Spec 覆盖**：
- §1 背景问题：Task 1-7 建独立路径 ✓
- §2 数据流：Task 1-3 切分+对齐、Task 4 答案合并、Task 5-6 标注、Task 7 集成、Task 8 端到端 ✓
- §3 切分逻辑：Task 1 正则、Task 2 题干切分、Task 3 答案对齐 ✓
- §4 LLM 标注：Task 5 标注+prompt、Task 6 双模型确认 ✓
- §4.4 KP 动态读 DB：Task 7 Step 4 query_knowledge_points ✓
- §4.6 prompt 约束：Task 5 Step 1 prompt 含约束语句 ✓
- §5 元数据：Task 7 _write_exam_questions_jsonl 取 source=文件名、source_year 从文件名解析 ✓
- §6 JSONL 结构：Task 7 _write_exam_questions_jsonl ✓
- §7 代码集成：Task 7 ✓
- §8 测试：Task 1-7 单元测试 + Task 8 端到端 + 回归 ✓
- §9 边界 case：紧凑格式（Task 3）、空题（Task 7）、答案区无对应题（Task 3）✓
- §10 未决（material_text/其他学科/db_loader 入库新 KP）：明确为后续任务 ✓

**2. 占位扫描**：无 TBD/TODO，每步有实际代码 ✓

**3. 类型一致性**：
- `RawQuestion` 在 Task 2 定义，Task 3/5/7 使用 ✓
- `LabeledQuestion` 在 Task 5 定义，Task 6/7 使用 ✓
- `QuestionLabeler.label` / `confirm_new_kps` 在 Task 5/6 定义，Task 7 调用 ✓
- `split_page` 在 Task 2/3 扩展，Task 7 调用 ✓
- `maybe_merge_answer_md` 在 Task 4 定义，Task 7 调用 ✓

