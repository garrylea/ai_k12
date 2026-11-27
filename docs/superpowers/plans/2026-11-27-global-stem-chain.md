# 题号全局链 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用“锚点 + 区间候选 + top-2 全局链 + 本地 LLM 闭集仲裁”替换数学题干题号的局部贪心识别，并保证 gap、forced 结果和答案区既有修复都可追踪、可回滚。

**Architecture:** 新增纯函数模块 `stem_chain.py` 负责探针、锚点、候选、top-2 链和 gap；新增 `stem_chain_arbiter.py` 负责本地 LLM 的闭集分配与校验。`question_extract.py` 只负责卷级编排，`question_splitter.py` 只执行最终 forced map 和 gap suppression，`recognition_scan.py` 汇总链问题。

**Tech Stack:** Python 3.10+、pytest、现有 `LLMClient`、现有 `QuestionStrategy`、JSONL。

## Global Constraints

- 强负证据必须硬否决，不能靠正分抵消。
- 同一题号、同一行可以保留多个 `StemOption`；进入链选择前不得只留局部最高分。
- 全局链保留前两条合法路径；打平或分差不足时进入本地 LLM，绝不能按行号先到先得。
- 本地 LLM 只能从请求中的 `candidate_id` 做闭集选择，不允许生成题号、行号或新候选。
- 本地 LLM 不可用时不回退远程模型；当前区间保留 gap，不影响其它区间。
- `dropped_tens`（`2→12`）必须由本地 LLM 确认后才能采纳。
- `forced_stem_map` 优先于卷末 `N<=5` 合并、十位纠错和裸题号局部推断；冲突必须显式报 issue。
- `answer_blocks.py` 的行首题号、单调递增、公式内数字过滤是答案区独立修复，**本计划禁止删除**。
- 首个锚点之前默认不从题号 1 强行补链。
- 不为 gap 创建“未知题号”的 `RawQuestion`；不伪造新题。
- 新链默认关闭；首批只给数学策略启用 `supports_global_stem_chain=True`。
- 所有新增逻辑必须离线可测，测试不得访问真实 LLM、数据库或网络。
- 实施顺序必须遵守 TDD：先写失败测试，确认失败，再写最小实现，再跑测试。

## File Structure

**Create**

- `tools/data-refinery/src/stem_chain.py`：纯数据模型、探针、锚点、候选展开、top-2 链、gap/issue。
- `tools/data-refinery/src/stem_chain_arbiter.py`：本地 LLM 输入输出、闭集仲裁和结果校验。
- `tools/data-refinery/src/prompts/stem_chain_arbiter.txt`：区间级闭集仲裁 prompt。
- `tools/data-refinery/src/stem_chain_benchmark.py`：30 卷 holdout 指标计算入口。
- `tools/data-refinery/tests/test_stem_chain.py`：纯函数与真实字符串回归。
- `tools/data-refinery/tests/test_stem_chain_arbiter.py`：LLM 仲裁和幻觉校验。
- `tools/data-refinery/tests/test_stem_chain_extract.py`：extract 编排、issue 落盘、能力开关。
- `tools/data-refinery/tests/test_stem_chain_benchmark.py`：指标公式与 golden 格式。

**Modify**

- `tools/data-refinery/src/question_splitter.py`：公开谓词、forced map、consumed/suppressed 行、`SplitPageResult.stem_chain_result`。
- `tools/data-refinery/src/question_extract.py`：卷级链编排、issue 清理/写入、本地模型门槛。
- `tools/data-refinery/src/recognition_scan.py`：读取 stem issue 并进入人工复核清单。
- `tools/data-refinery/src/subject_strategies/types.py`：新增能力字段。
- `tools/data-refinery/src/subject_strategies/math.py`：启用全局链。
- `tools/data-refinery/src/subject_strategies/generic.py`、`chinese.py`、`english.py`：显式关闭/继承默认关闭。
- `tools/data-refinery/src/split_snapshot.py`：增加 `--stem-chain` 快照模式。
- `tools/data-refinery/tests/test_question_splitter.py`：forced 优先级、gap suppression、85434 回归。
- `tools/data-refinery/tests/test_answer_blocks.py`：答案区守卫回归标签。
- `tools/data-refinery/tests/test_recognition_scan.py`：stem issue 转换和去重。
- `docs/constraints/数据管线.md`、`docs/ai-core-changelog.md`：实现完成后同步硬约束和结果。

---

### Task 1: 数据模型、硬过滤与可解释排序

**Files:**
- Create: `tools/data-refinery/src/stem_chain.py`
- Create: `tools/data-refinery/tests/test_stem_chain.py`

**Interfaces:**
- Consumes: Python dataclasses only.
- Produces: `StemEvidence`, `StemOption`, `StemCandidate`, `StemPath`, `StemAmbiguity`, `StemGapSegment`, `StemIssue`, `StemCollectionResult`, `StemChainResult`; `recovery_cost(option) -> int`; `has_hard_veto(option) -> bool`; `option_rank_key(option) -> tuple`; `path_rank_key(path) -> tuple`.

- [ ] **Step 1: Write the failing model and hard-filter tests**

```python
# tools/data-refinery/tests/test_stem_chain.py
from stem_chain import (
    StemCandidate, StemEvidence, StemOption, StemPath,
    has_hard_veto, option_rank_key, path_rank_key, recovery_cost,
)


def ev(tag: str, polarity: str = "positive") -> StemEvidence:
    return StemEvidence(tag=tag, polarity=polarity)


def opt(
    number: int = 12,
    *,
    candidate_id: str = "L10-O1",
    raw_number: int | None = None,
    form: str = "main",
    recovery: str = "exact",
    evidence: tuple[StemEvidence, ...] = (),
) -> StemOption:
    return StemOption(
        candidate_id=candidate_id,
        raw_number=number if raw_number is None else raw_number,
        number=number,
        form=form,
        recovery=recovery,
        evidence=evidence,
        content_rest="求二次函数的解析式",
    )


def test_recovery_cost_is_ordered_from_exact_to_dropped_tens():
    assert recovery_cost(opt(recovery="exact")) == 0
    assert recovery_cost(opt(recovery="glued_suffix")) == 1
    assert recovery_cost(opt(recovery="missing_dot")) == 1
    assert recovery_cost(opt(recovery="dropped_tens", raw_number=2)) == 3


def test_hard_veto_cannot_be_offset_by_positive_evidence():
    option = opt(evidence=(
        ev("line_start"), ev("blank_before"), ev("chinese_after"),
        ev("inside_math", "veto"),
    ))
    assert has_hard_veto(option)


def test_rank_prefers_exact_form_then_paragraph_and_stem_evidence():
    exact = opt(evidence=(ev("blank_before"), ev("stem_keyword")))
    glued = opt(
        candidate_id="L20-O1",
        form="glued_number",
        recovery="glued_suffix",
        evidence=(ev("blank_before"), ev("blank_before"), ev("blank_before")),
    )
    assert option_rank_key(exact) < option_rank_key(glued)


def test_path_rank_sums_recovery_before_positive_structure():
    cheap = StemPath(
        assignments=((10, 12, "A"),),
        rank_key=(),
        selected_options=(opt(candidate_id="A"),),
    )
    repaired = StemPath(
        assignments=((20, 12, "B"),),
        rank_key=(),
        selected_options=(opt(
            candidate_id="B",
            raw_number=2,
            recovery="dropped_tens",
            evidence=(ev("blank_before"), ev("stem_keyword")),
        ),),
    )
    assert path_rank_key(cheap) < path_rank_key(repaired)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd tools/data-refinery
pytest tests/test_stem_chain.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'stem_chain'`.

- [ ] **Step 3: Implement the frozen data model and pure ranking helpers**

```python
# tools/data-refinery/src/stem_chain.py
from dataclasses import dataclass


@dataclass(frozen=True)
class StemEvidence:
    tag: str
    polarity: str
    detail: str = ""


@dataclass(frozen=True)
class StemOption:
    candidate_id: str
    raw_number: int | None
    number: int
    form: str
    recovery: str
    evidence: tuple[StemEvidence, ...]
    content_rest: str


@dataclass(frozen=True)
class StemCandidate:
    line_no: int
    text: str
    options: tuple[StemOption, ...]
    context_before: str
    context_after: str
    anchor: bool = False


@dataclass(frozen=True)
class StemPath:
    assignments: tuple[tuple[int, int, str], ...]
    rank_key: tuple
    selected_options: tuple[StemOption, ...]


@dataclass(frozen=True)
class StemAmbiguity:
    reason: str
    left_anchor: int
    right_anchor: int
    expected_numbers: tuple[int, ...]
    candidates: tuple[StemCandidate, ...]
    top_paths: tuple[StemPath, ...]


@dataclass(frozen=True)
class StemGapSegment:
    left_question_no: int
    right_question_no: int
    missing_numbers: tuple[int, ...]
    line_start: int | None
    line_end: int
    excerpt: str
    boundary_known: bool


@dataclass(frozen=True)
class StemIssue:
    code: str
    severity: str
    message: str
    line_no: int
    excerpt: str
    question_no: int | None = None
    interval_id: str | None = None
    candidate_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class StemCollectionResult:
    anchors: tuple[StemCandidate, ...]
    candidates: tuple[StemCandidate, ...]
    consumed_lines: frozenset[int]


@dataclass(frozen=True)
class StemChainResult:
    accepted: dict[int, tuple[int, str, str]]
    gaps: list[tuple[int, int, int]]
    gap_segments: list[StemGapSegment]
    ambiguities: list[StemAmbiguity]
    safe_prefix: dict[int, tuple[int, str, str]]
    issues: list[StemIssue]


_RECOVERY_COST = {
    "exact": 0,
    "glued_suffix": 1,
    "missing_dot": 1,
    "dropped_tens": 3,
}


def recovery_cost(option: StemOption) -> int:
    return _RECOVERY_COST[option.recovery]


def has_hard_veto(option: StemOption) -> bool:
    return any(e.polarity == "veto" for e in option.evidence)


def _positive_count(option: StemOption, tags: set[str]) -> int:
    return sum(
        e.polarity == "positive" and e.tag in tags
        for e in option.evidence
    )


def option_rank_key(option: StemOption) -> tuple:
    return (
        recovery_cost(option),
        -_positive_count(option, {"blank_before", "paragraph_break", "prev_sentence_end"}),
        -_positive_count(option, {"chinese_after", "long_stem", "stem_keyword", "math_after"}),
        -_positive_count(option, {"near_right_anchor", "answer_slot_hint", "continuous_context"}),
    )


def path_rank_key(path: StemPath) -> tuple:
    total_recovery = sum(recovery_cost(o) for o in path.selected_options)
    paragraph = sum(
        _positive_count(o, {"blank_before", "paragraph_break", "prev_sentence_end"})
        for o in path.selected_options
    )
    stem = sum(
        _positive_count(o, {"chinese_after", "long_stem", "stem_keyword", "math_after"})
        for o in path.selected_options
    )
    context = sum(
        _positive_count(o, {"near_right_anchor", "answer_slot_hint", "continuous_context"})
        for o in path.selected_options
    )
    return total_recovery, -paragraph, -stem, -context
```

- [ ] **Step 4: Run the model tests to verify they pass**

Run:

```bash
cd tools/data-refinery
pytest tests/test_stem_chain.py -v
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add tools/data-refinery/src/stem_chain.py tools/data-refinery/tests/test_stem_chain.py
git commit -m "feat(refinery): add stem chain models and evidence ranking"
```

---

### Task 2: 公开切题谓词、主形态探针与锚点选择

**Files:**
- Modify: `tools/data-refinery/src/question_splitter.py:193-235`
- Modify: `tools/data-refinery/src/question_splitter.py:1019-1048`
- Modify: `tools/data-refinery/src/stem_chain.py`
- Modify: `tools/data-refinery/tests/test_stem_chain.py`

**Interfaces:**
- Consumes: `is_main_stem`, existing private regexes/helpers in `question_splitter.py`.
- Produces: public `ambiguous_stem_candidate(line) -> tuple[int, str] | None`, `bare_stem_candidate(line) -> tuple[int, str] | None`, `orphan_stem_candidate(line) -> tuple[int, str] | None`, `split_glued_next_stem(line, expected_no) -> tuple[str, int, str] | None`, `is_junk_stem_line(line) -> bool`, `is_notice_stem_line(line) -> bool`; `collect_main_stem_probes(text, strategy) -> list[StemCandidate]`; `select_stem_anchors(probes) -> list[StemCandidate]`.

- [ ] **Step 1: Add failing public-predicate and anchor tests**

```python
# append to tools/data-refinery/tests/test_stem_chain.py
from question_splitter import (
    ambiguous_stem_candidate, bare_stem_candidate, split_glued_next_stem,
)
from stem_chain import collect_main_stem_probes, select_stem_anchors
from subject_strategies import get_strategy


def test_public_splitter_predicates_reuse_existing_runtime_rules():
    assert ambiguous_stem_candidate("25.16 世纪中叶，我国发明火箭") == (
        25, "16 世纪中叶，我国发明火箭",
    )
    assert bare_stem_candidate("11 在平面直角坐标系中求点坐标") == (
        11, "在平面直角坐标系中求点坐标",
    )
    assert split_glued_next_stem("前文。16.根据材料三回答", 16) == (
        "前文。", 16, "根据材料三回答",
    )


def test_main_probes_then_anchors_are_two_phase_and_ordered():
    md = """# 卷

1. 第一题求一次函数解析式

1. 第一题重复且正文更长一些

3. 第三题证明三角形全等
"""
    probes = collect_main_stem_probes(md, get_strategy("math"))
    anchors = select_stem_anchors(probes)
    assert [candidate.options[0].number for candidate in anchors] == [1, 3]
    assert [candidate.line_no for candidate in anchors] == [2, 6]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd tools/data-refinery
pytest tests/test_stem_chain.py -v
```

Expected: FAIL with missing public predicate imports and missing probe functions.

- [ ] **Step 3: Add public wrappers in `question_splitter.py`**

```python
# after the private regex definitions / existing candidate helpers
def ambiguous_stem_candidate(line: str) -> tuple[int, str] | None:
    m = _AMBIGUOUS_NUM_RE.match(line)
    if not m:
        return None
    number = int(m.group(1))
    return number, _strip_main_stem_prefix(line)


def bare_stem_candidate(line: str) -> tuple[int, str] | None:
    return _bare_stem_candidate(line)


def orphan_stem_candidate(line: str) -> tuple[int, str] | None:
    m = _ORPHAN_STEM_DOT_RE.match(line)
    if not m:
        return None
    rest = line[m.end():].strip()
    return (rest,) if rest else None


def split_glued_next_stem(line: str, expected_no: int):
    return _split_glued_next_stem(line, expected_no)


def is_junk_stem_line(line: str) -> bool:
    return len(line.strip()) <= 40 and bool(_JUNK_QUESTION_RE.search(line))


def is_notice_stem_line(line: str) -> bool:
    return bool(_NOTICE_RE.search(line))
```

Note: `orphan_stem_candidate()` cannot know the recovered number before an anchor interval exists; its return is only the remaining text. `collect_interval_candidates()` adds the numeric interpretation.

- [ ] **Step 4: Implement main probes and anchor selection**

```python
# append to tools/data-refinery/src/stem_chain.py
from question_splitter import (
    is_answer_keyword, is_junk_stem_line, is_main_stem, is_notice_stem_line,
)


def _body_evidence(rest: str, blank_before: bool) -> tuple[StemEvidence, ...]:
    evidence = [StemEvidence("line_start", "positive")]
    if blank_before:
        evidence.append(StemEvidence("blank_before", "positive"))
    if len(rest) >= 6 and any("\u4e00" <= ch <= "\u9fff" for ch in rest):
        evidence.append(StemEvidence("chinese_after", "positive"))
    if len(rest) >= 30:
        evidence.append(StemEvidence("long_stem", "positive"))
    if any(word in rest for word in ("求", "证明", "如图", "已知", "解方程")):
        evidence.append(StemEvidence("stem_keyword", "positive"))
    return tuple(evidence)


def collect_main_stem_probes(text: str, strategy) -> list[StemCandidate]:
    lines = text.split("\n")
    probes: list[StemCandidate] = []
    blank_before = False
    for i, line in enumerate(lines):
        if not line.strip():
            blank_before = True
            continue
        if is_answer_keyword(line):
            break
        ok, number = strategy.is_stem(line)
        if not ok or number is None:
            blank_before = False
            continue
        rest = line.lstrip()
        rest = rest.split(".", 1)[1].strip() if "." in rest else rest
        evidence = _body_evidence(rest, blank_before)
        if is_junk_stem_line(line):
            evidence += (StemEvidence("notice_junk", "veto"),)
        elif is_notice_stem_line(line) and not probes:
            evidence += (StemEvidence("notice_junk", "veto"),)
        option = StemOption(
            candidate_id=f"L{i}-Main",
            raw_number=number,
            number=number,
            form="main",
            recovery="exact",
            evidence=evidence,
            content_rest=rest,
        )
        probes.append(StemCandidate(
            line_no=i,
            text=line.strip()[:160],
            options=(option,),
            context_before="\n".join(lines[max(0, i - 2):i]),
            context_after="\n".join(lines[i + 1:i + 3]),
        ))
        blank_before = False
    return probes


def select_stem_anchors(probes: list[StemCandidate]) -> list[StemCandidate]:
    best_by_number: dict[int, StemCandidate] = {}
    for candidate in probes:
        option = candidate.options[0]
        if has_hard_veto(option):
            continue
        current = best_by_number.get(option.number)
        if current is None:
            best_by_number[option.number] = candidate
            continue
        current_option = current.options[0]
        if option_rank_key(option) < option_rank_key(current_option):
            best_by_number[option.number] = candidate

    anchors: list[StemCandidate] = []
    last_no = 0
    for number in sorted(best_by_number):
        candidate = best_by_number[number]
        option = candidate.options[0]
        if option.number <= last_no:
            continue
        anchors.append(StemCandidate(
            line_no=candidate.line_no,
            text=candidate.text,
            options=candidate.options,
            context_before=candidate.context_before,
            context_after=candidate.context_after,
            anchor=True,
        ))
        last_no = option.number
    return anchors
```

- [ ] **Step 5: Run the focused tests**

Run:

```bash
cd tools/data-refinery
pytest tests/test_stem_chain.py -v
pytest tests/test_question_splitter.py -q
```

Expected: PASS. Existing splitter tests remain green because wrappers delegate to existing private rules.

- [ ] **Step 6: Commit**

```bash
git add tools/data-refinery/src/question_splitter.py tools/data-refinery/src/stem_chain.py tools/data-refinery/tests/test_stem_chain.py
git commit -m "feat(refinery): expose stem predicates and select anchors"
```

---

### Task 3: 学科能力开关与区间候选展开

**Files:**
- Modify: `tools/data-refinery/src/subject_strategies/types.py:48-99`
- Modify: `tools/data-refinery/src/subject_strategies/math.py`
- Modify: `tools/data-refinery/src/subject_strategies/generic.py:91-110`
- Modify: `tools/data-refinery/src/subject_strategies/chinese.py:128-132`
- Modify: `tools/data-refinery/src/subject_strategies/english.py:199-204`
- Modify: `tools/data-refinery/src/stem_chain.py`
- Modify: `tools/data-refinery/tests/test_stem_chain.py`

**Interfaces:**
- Consumes: anchors and public candidate predicates from Task 2.
- Produces: `supports_global_stem_chain(strategy) -> bool`; `collect_interval_candidates(text, strategy, anchors) -> StemCollectionResult`.

- [ ] **Step 1: Write failing capability and candidate-expansion tests**

```python
# append to tools/data-refinery/tests/test_stem_chain.py
from stem_chain import collect_interval_candidates, supports_global_stem_chain


def test_only_math_enables_global_chain_initially():
    assert supports_global_stem_chain(get_strategy("math"))
    assert not supports_global_stem_chain(get_strategy("chinese"))
    assert not supports_global_stem_chain(get_strategy("english"))


def test_interval_candidates_keep_12_8_and_12_16_as_same_number_options():
    md = """11. 第十一题已知函数

10.5 米处的测量数据

12.8 米处是正文数字

12.16 世纪中叶的新式火箭

13. 第十三题求坐标
"""
    probes = collect_main_stem_probes(md, get_strategy("math"))
    anchors = select_stem_anchors(probes)
    result = collect_interval_candidates(md, get_strategy("math"), anchors)
    by_line = {
        candidate.line_no: [option.number for option in candidate.options]
        for candidate in result.candidates
    }
    assert 12 in by_line[4] and 12 in by_line[6]
    assert 10 not in by_line.get(2, [])


def test_interval_candidates_generate_dropped_tens_only_inside_gap():
    md = """11. 第十一题

2. 第二组数据的第一段题目正文

3. 第二组数据的第二段题目正文

4. 第二组数据的第三段题目正文

15. 第十五题
"""
    probes = collect_main_stem_probes(md, get_strategy("math"))
    anchors = select_stem_anchors(probes)
    result = collect_interval_candidates(md, get_strategy("math"), anchors)
    recovered = {
        option.number
        for candidate in result.candidates
        for option in candidate.options
        if option.recovery == "dropped_tens"
    }
    assert recovered == {12, 13, 14}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd tools/data-refinery
pytest tests/test_stem_chain.py -v
```

Expected: FAIL because `supports_global_stem_chain` and `collect_interval_candidates` are missing.

- [ ] **Step 3: Add the strategy capability**

```python
# subject_strategies/types.py, inside QuestionStrategy
supports_global_stem_chain: bool
```

```python
# subject_strategies/generic.py
class GenericStrategy(BlockAnswerMixin):
    code = "generic"
    supports_global_stem_chain = False


class NaturalScienceStrategy(BlockAnswerMixin):
    supports_global_stem_chain = False
```

```python
# subject_strategies/math.py
class MathStrategy(NaturalScienceStrategy):
    supports_global_stem_chain = True
```

Add `supports_global_stem_chain = False` to `ChineseStrategy` and `EnglishStrategy`.

- [ ] **Step 4: Implement interval candidate expansion**

```python
# append to stem_chain.py
from question_splitter import (
    ambiguous_stem_candidate, bare_stem_candidate, orphan_stem_candidate,
    split_glued_next_stem,
)


def supports_global_stem_chain(strategy) -> bool:
    return bool(getattr(strategy, "supports_global_stem_chain", False))


def _expected_between(left: int, right: int) -> tuple[int, ...]:
    return tuple(range(left + 1, right))


def _option(
    line_no: int,
    number: int,
    form: str,
    recovery: str,
    rest: str,
    raw_number: int,
    context: tuple[StemEvidence, ...],
) -> StemOption:
    return StemOption(
        candidate_id=f"L{line_no}-{form}-{number}",
        raw_number=raw_number,
        number=number,
        form=form,
        recovery=recovery,
        evidence=context,
        content_rest=rest,
    )


def _display_math_open(lines: list[str], line_no: int) -> bool:
    opens = sum(line.count("$$") for line in lines[:line_no]) % 2
    return bool(opens)


def _hard_veto_evidence(lines: list[str], line_no: int) -> tuple[StemEvidence, ...]:
    line = lines[line_no]
    veto: list[StemEvidence] = []
    if _display_math_open(lines, line_no):
        veto.append(StemEvidence("inside_math", "veto"))
    stripped = line.lstrip()
    if stripped.startswith(("=", "+", "-", "×", "÷")):
        veto.append(StemEvidence("after_operator", "veto"))
    return tuple(veto)


def collect_interval_candidates(text: str, strategy, anchors: list[StemCandidate]):
    if not supports_global_stem_chain(strategy):
        return StemCollectionResult(tuple(anchors), (), frozenset())
    lines = text.split("\n")
    candidates: list[StemCandidate] = []
    consumed: set[int] = set()
    anchor_by_line = {anchor.line_no for anchor in anchors}

    for left, right in zip(anchors, anchors[1:]):
        left_no = left.options[0].number
        right_no = right.options[0].number
        expected = set(_expected_between(left_no, right_no))
        if not expected:
            continue
        for i in range(left.line_no + 1, right.line_no):
            line = lines[i]
            blank_before = i > 0 and not lines[i - 1].strip()
            context = _body_evidence(line.strip(), blank_before) + _hard_veto_evidence(lines, i)
            options: list[StemOption] = []

            ok, number = strategy.is_stem(line)
            if ok and i not in anchor_by_line:
                rest = line.lstrip().split(".", 1)[-1].strip()
                if number in expected:
                    options.append(_option(
                        i, number, "main", "exact", rest, number, context,
                    ))
                for wanted in expected:
                    if wanted >= 10 and wanted % 10 == number:
                        options.append(_option(
                            i, wanted, "main", "dropped_tens",
                            rest, number, context,
                        ))

            ambiguous = ambiguous_stem_candidate(line)
            if ambiguous:
                number, rest = ambiguous
                glued_number = next(
                    (n for n in expected if n == number), None
                )
                if glued_number is not None:
                    options.append(_option(
                        i, glued_number, "glued_number", "glued_suffix",
                        rest, number, context,
                    ))

            bare = bare_stem_candidate(line)
            if bare:
                number, rest = bare
                if number in expected:
                    options.append(_option(
                        i, number, "bare", "missing_dot", rest, number, context,
                    ))
                for wanted in expected:
                    if wanted >= 10 and wanted % 10 == number:
                        options.append(_option(
                            i, wanted, "bare", "dropped_tens",
                            rest, number, context,
                        ))

            orphan = orphan_stem_candidate(line)
            if orphan:
                rest = orphan[0]
                number = left_no + 1
                if number in expected and blank_before:
                    options.append(_option(
                        i, number, "orphan_dot", "missing_dot",
                        rest, number, context,
                    ))

            glued = split_glued_next_stem(line, left_no + 1)
            if glued:
                _head, number, rest = glued
                if number in expected:
                    options.append(_option(
                        i, number, "inline_glued", "exact", rest, number,
                        context + (StemEvidence("continuous_context", "positive"),),
                    ))
                    consumed.add(i)

            kept = tuple(o for o in options if not has_hard_veto(o))
            if kept:
                candidates.append(StemCandidate(
                    line_no=i,
                    text=line.strip()[:160],
                    options=kept,
                    context_before="\n".join(lines[max(0, i - 2):i]),
                    context_after="\n".join(lines[i + 1:i + 3]),
                ))

    return StemCollectionResult(
        anchors=tuple(anchors),
        candidates=tuple(candidates),
        consumed_lines=frozenset(consumed),
    )
```

- [ ] **Step 5: Run candidate tests and strategy tests**

Run:

```bash
cd tools/data-refinery
pytest tests/test_stem_chain.py -v
pytest tests/subject_strategies/test_registry.py -q
```

Expected: PASS. `MathStrategy` exposes `True`; Chinese/English stay on existing paths.

- [ ] **Step 6: Commit**

```bash
git add tools/data-refinery/src/stem_chain.py \
  tools/data-refinery/src/subject_strategies/types.py \
  tools/data-refinery/src/subject_strategies/math.py \
  tools/data-refinery/src/subject_strategies/generic.py \
  tools/data-refinery/src/subject_strategies/chinese.py \
  tools/data-refinery/src/subject_strategies/english.py \
  tools/data-refinery/tests/test_stem_chain.py
git commit -m "feat(refinery): expand anchored stem candidates"
```

---

### Task 4: top-2 链、歧义、gap segment 与安全前缀

**Files:**
- Modify: `tools/data-refinery/src/stem_chain.py`
- Modify: `tools/data-refinery/tests/test_stem_chain.py`

**Interfaces:**
- Consumes: `StemCollectionResult`.
- Produces: `select_stem_chains(collection, *, source_lines=None, margin=2) -> StemChainResult`; `validate_forced_assignments(result) -> list[StemIssue]`.

- [ ] **Step 1: Write failing chain selection tests**

```python
# append to tools/data-refinery/tests/test_stem_chain.py
from stem_chain import select_stem_chains, validate_forced_assignments


def candidate(line_no: int, options: tuple[StemOption, ...]) -> StemCandidate:
    return StemCandidate(
        line_no=line_no,
        text=f"line {line_no}",
        options=options,
        context_before="",
        context_after="",
    )


def anchor(line_no: int, number: int) -> StemCandidate:
    return StemCandidate(
        line_no=line_no,
        text=f"{number}. anchor",
        options=(opt(number=number, candidate_id=f"L{line_no}-Main"),),
        context_before="",
        context_after="",
        anchor=True,
    )


def test_top_two_keeps_lower_scored_option_when_high_option_breaks_order():
    anchors = (anchor(0, 11), anchor(6, 14))
    high_late = opt(
        number=12, candidate_id="late",
        evidence=(ev("blank_before"), ev("blank_before"), ev("blank_before")),
    )
    low_early = opt(
        number=12, candidate_id="early",
        evidence=(ev("blank_before"),),
    )
    no_13 = opt(number=13, candidate_id="q13")
    collection = StemCollectionResult(
        anchors=anchors,
        candidates=(
            candidate(1, (low_early,)),
            candidate(3, (no_13,)),
            candidate(4, (high_late,)),
        ),
        consumed_lines=frozenset(),
    )
    result = select_stem_chains(collection)
    assert result.accepted[1] == (12, "main", "exact")
    assert result.accepted[3] == (13, "main", "exact")
    assert 4 not in result.accepted


def test_equal_paths_are_ambiguous_not_line_order_wins():
    anchors = (anchor(0, 11), anchor(4, 13))
    left = opt(number=12, candidate_id="left")
    right = opt(number=12, candidate_id="right")
    collection = StemCollectionResult(
        anchors=anchors,
        candidates=(candidate(1, (left,)), candidate(2, (right,))),
        consumed_lines=frozenset(),
    )
    result = select_stem_chains(collection)
    assert result.accepted == {}
    assert result.ambiguities[0].reason == "ambiguous"
    assert [p.selected_options[0].candidate_id for p in result.ambiguities[0].top_paths] == [
        "left", "right",
    ]


def test_missing_26_keeps_25_prefix_and_creates_gap_segment():
    anchors = (anchor(0, 24), anchor(5, 27))
    q25 = opt(number=25, candidate_id="q25", evidence=(ev("blank_before"), ev("stem_keyword")))
    weak26 = opt(
        number=26, candidate_id="q26",
        evidence=(ev("inside_math", "veto"),),
    )
    collection = StemCollectionResult(
        anchors=anchors,
        candidates=(candidate(1, (q25,)), candidate(2, (weak26,))),
        consumed_lines=frozenset(),
    )
    result = select_stem_chains(collection)
    assert 1 in result.accepted
    assert any(g.missing_numbers == (26,) for g in result.gap_segments)
    assert any(i.code == "stem_chain_gap" for i in result.issues)


def test_forced_assignment_duplicate_is_an_error():
    result = StemChainResult(
        accepted={1: (12, "main", "exact"), 2: (12, "main", "exact")},
        gaps=[], gap_segments=[], ambiguities=[], safe_prefix={}, issues=[],
    )
    issues = validate_forced_assignments(result)
    assert [issue.code for issue in issues] == ["stem_chain_forced_duplicate"]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd tools/data-refinery
pytest tests/test_stem_chain.py -v
```

Expected: FAIL because `select_stem_chains` and `validate_forced_assignments` are missing.

- [ ] **Step 3: Implement top-2 path construction**

```python
# append to stem_chain.py
def _options_by_number(collection: StemCollectionResult) -> dict[int, list[tuple[int, StemOption]]]:
    out: dict[int, list[tuple[int, StemOption]]] = {}
    for candidate in collection.candidates:
        for option in candidate.options:
            if not has_hard_veto(option):
                out.setdefault(option.number, []).append((candidate.line_no, option))
    return out


def _top_two(paths: list[StemPath]) -> list[StemPath]:
    ranked = sorted(paths, key=lambda p: p.rank_key)
    unique: list[StemPath] = []
    seen: set[tuple] = set()
    for path in ranked:
        key = tuple((line, number, cid) for line, number, cid in path.assignments)
        if key in seen:
            continue
        seen.add(key)
        unique.append(path)
        if len(unique) == 2:
            break
    return unique


def _complete_paths(
    collection: StemCollectionResult,
) -> list[tuple[int, int, list[StemPath], dict[int, list[StemPath]]]]:
    options = _options_by_number(collection)
    completed = []
    for left, right in zip(collection.anchors, collection.anchors[1:]):
        left_no = left.options[0].number
        right_no = right.options[0].number
        expected = tuple(range(left_no + 1, right_no))
        paths_by_no: dict[int, list[StemPath]] = {
            left_no: [StemPath(
                assignments=((left.line_no, left_no, left.options[0].candidate_id),),
                rank_key=(0, 0, 0, 0),
                selected_options=(),
            )]
        }
        for number in expected:
            expanded: list[StemPath] = []
            for prev in paths_by_no.get(number - 1, []):
                prev_line = prev.assignments[-1][0]
                for line_no, option in options.get(number, []):
                    if line_no <= prev_line or line_no >= right.line_no:
                        continue
                    selected = prev.selected_options + (option,)
                    assignments = prev.assignments + ((line_no, number, option.candidate_id),)
                    draft = StemPath(
                        assignments=assignments,
                        rank_key=(),
                        selected_options=selected,
                    )
                    expanded.append(StemPath(
                        assignments=assignments,
                        rank_key=path_rank_key(draft),
                        selected_options=selected,
                    ))
            paths_by_no[number] = _top_two(expanded)
        completed.append((left_no, right_no, paths_by_no.get(right_no - 1, []), paths_by_no))
    return completed


def select_stem_chains(
    collection: StemCollectionResult,
    *,
    source_lines: list[str] | None = None,
    margin: int = 2,
) -> StemChainResult:
    accepted: dict[int, tuple[int, str, str]] = {}
    safe_prefix: dict[int, tuple[int, str, str]] = {}
    gaps: list[tuple[int, int, int]] = []
    gap_segments: list[StemGapSegment] = []
    ambiguities: list[StemAmbiguity] = []
    issues: list[StemIssue] = []

    for left, right in zip(collection.anchors, collection.anchors[1:]):
        left_no = left.options[0].number
        right_no = right.options[0].number
        matching = next(
            (entry for entry in _complete_paths(collection)
             if entry[0] == left_no and entry[1] == right_no),
            None,
        )
        paths = matching[2] if matching else []
        if paths:
            first = paths[0]
            needs_confirmation = any(
                option.recovery == "dropped_tens" for option in first.selected_options
            )
            clear_winner = (
                len(paths) == 1
                or first.rank_key[0] < paths[1].rank_key[0]
                or sum(first.rank_key[1:]) + margin <= sum(paths[1].rank_key[1:])
            )
            if clear_winner and not needs_confirmation:
                for line_no, number, cid in first.assignments[1:]:
                    option = next(o for o in first.selected_options if o.candidate_id == cid)
                    accepted[line_no] = (number, option.form, option.recovery)
                continue
            ambiguities.append(StemAmbiguity(
                reason="high_risk_recovery" if needs_confirmation else "ambiguous",
                left_anchor=left_no,
                right_anchor=right_no,
                expected_numbers=tuple(range(left_no + 1, right_no)),
                candidates=tuple(
                    candidate for candidate in collection.candidates
                    if left.line_no < candidate.line_no < right.line_no
                ),
                top_paths=tuple(paths),
            ))
            issues.append(StemIssue(
                code="stem_chain_high_risk_recovery" if needs_confirmation else "stem_chain_ambiguous",
                severity="warning",
                message=f"题 {left_no}→{right_no} 需要本地 LLM 仲裁",
                line_no=left.line_no + 1,
                excerpt=left.text,
                question_no=left_no + 1,
                interval_id=f"C{left_no}-{right_no}",
            ))
            continue

        # No complete path: accept only the left-connected safe prefix.
        expected = tuple(range(left_no + 1, right_no))
        options = _options_by_number(collection)
        last_line = left.line_no
        stopped_at = None
        for number in expected:
            choices = [
                (line_no, option)
                for line_no, option in options.get(number, [])
                if line_no > last_line
            ]
            if len(choices) != 1:
                stopped_at = number
                break
            line_no, option = choices[0]
            tags = {e.tag for e in option.evidence if e.polarity == "positive"}
            paragraph_ok = bool(tags & {
                "blank_before", "paragraph_break", "prev_sentence_end",
            })
            stem_ok = bool(tags & {
                "chinese_after", "long_stem", "stem_keyword", "math_after",
            })
            if option.recovery == "dropped_tens" or not paragraph_ok or not stem_ok:
                stopped_at = number
                break
            safe_prefix[line_no] = (number, option.form, option.recovery)
            accepted[line_no] = (number, option.form, option.recovery)
            last_line = line_no
        if stopped_at is not None:
            gaps.append((stopped_at - 1, stopped_at, left.line_no + 1))
            weak = [
                candidate.line_no
                for candidate in collection.candidates
                if any(option.number == stopped_at for option in candidate.options)
            ]
            start = min(weak) if weak else None
            end = right.line_no - 1
            if source_lines is not None and start is not None:
                text = "\n".join(source_lines[start:end + 1])
            else:
                text = "\n".join(
                    candidate.text for candidate in collection.candidates
                    if start is not None and start <= candidate.line_no <= end
                )
            gap_segments.append(StemGapSegment(
                left_question_no=stopped_at - 1,
                right_question_no=right_no,
                missing_numbers=tuple(range(stopped_at, right_no)),
                line_start=start,
                line_end=end,
                excerpt=text[:600],
                boundary_known=start is not None,
            ))
            issues.append(StemIssue(
                code="stem_chain_gap",
                severity="error",
                message=f"题号链在 {stopped_at - 1}→{stopped_at} 断开",
                line_no=left.line_no + 1,
                excerpt=text[:600],
                question_no=stopped_at,
                interval_id=f"C{left_no}-{right_no}",
            ))
            if start is None:
                issues.append(StemIssue(
                    code="stem_chain_boundary_uncertain",
                    severity="warning",
                    message="gap 起始行不确定，尾部内容需人工复核",
                    line_no=left.line_no + 1,
                    excerpt=text[:600],
                    question_no=stopped_at,
                    interval_id=f"C{left_no}-{right_no}",
                ))

    result = StemChainResult(
        accepted=accepted,
        gaps=gaps,
        gap_segments=gap_segments,
        ambiguities=ambiguities,
        safe_prefix=safe_prefix,
        issues=issues,
    )
    return StemChainResult(
        accepted=result.accepted,
        gaps=result.gaps,
        gap_segments=result.gap_segments,
        ambiguities=result.ambiguities,
        safe_prefix=result.safe_prefix,
        issues=result.issues + validate_forced_assignments(result),
    )


def validate_forced_assignments(result: StemChainResult) -> list[StemIssue]:
    seen: dict[int, int] = {}
    issues: list[StemIssue] = []
    for line_no, (number, _form, _recovery) in sorted(result.accepted.items()):
        if number in seen:
            issues.append(StemIssue(
                code="stem_chain_forced_duplicate",
                severity="error",
                message=f"题 {number} 同时命中行 {seen[number] + 1} 和 {line_no + 1}",
                line_no=line_no + 1,
                excerpt="",
                question_no=number,
            ))
        else:
            seen[number] = line_no
    return issues
```

Implementation note: if performance becomes a problem, compute `_complete_paths()` once per collection instead of once per interval; the interval count is small, so the first implementation remains readable and testable.

- [ ] **Step 4: Run the chain tests**

Run:

```bash
cd tools/data-refinery
pytest tests/test_stem_chain.py -v
```

Expected: PASS. Equal paths produce ambiguity; safe prefix is retained; duplicate forced assignments fail explicitly.

- [ ] **Step 5: Commit**

```bash
git add tools/data-refinery/src/stem_chain.py tools/data-refinery/tests/test_stem_chain.py
git commit -m "feat(refinery): choose top-two stem chains"
```

---

### Task 5: 本地 LLM 区间仲裁与闭集校验

**Files:**
- Create: `tools/data-refinery/src/prompts/stem_chain_arbiter.txt`
- Create: `tools/data-refinery/src/stem_chain_arbiter.py`
- Create: `tools/data-refinery/tests/test_stem_chain_arbiter.py`

**Interfaces:**
- Consumes: `StemAmbiguity`, `StemIssue`, `LLMClient.complete(system, user)`.
- Produces: `StemArbitrationResult(accepted, issues)`; `arbitrate_stem_ambiguities(llm, ambiguities, paper_stem="") -> StemArbitrationResult`; `validate_arbiter_payload(payload, ambiguities) -> StemArbitrationResult`.

- [ ] **Step 1: Write failing arbiter tests**

```python
# tools/data-refinery/tests/test_stem_chain_arbiter.py
import json
from types import SimpleNamespace

from stem_chain import (
    StemAmbiguity, StemCandidate, StemEvidence, StemOption, StemPath,
)
from stem_chain_arbiter import arbitrate_stem_ambiguities, validate_arbiter_payload


def _option(number: int, cid: str) -> StemOption:
    return StemOption(
        candidate_id=cid,
        raw_number=number,
        number=number,
        form="glued_number",
        recovery="glued_suffix",
        evidence=(StemEvidence("blank_before", "positive"),),
        content_rest=f"{number}. 正文",
    )


def _ambiguity() -> StemAmbiguity:
    left = _option(12, "left")
    right = _option(12, "right")
    candidates = (
        StemCandidate(1, "12.8 米", (left,), "", ""),
        StemCandidate(2, "12.16 世纪", (right,), "", ""),
    )
    return StemAmbiguity(
        reason="ambiguous",
        left_anchor=11,
        right_anchor=13,
        expected_numbers=(12,),
        candidates=candidates,
        top_paths=(
            StemPath(((1, 12, "left"),), (1, -1, -1, 0), (left,)),
            StemPath(((2, 12, "right"),), (1, -1, -1, 0), (right,)),
        ),
    )


def test_arbiter_payload_accepts_one_closed_candidate_per_number():
    payload = {"intervals": [{
        "interval_id": "C11-13",
        "result": "resolved",
        "assignments": [{"number": 12, "candidate_id": "right"}],
    }]}
    result = validate_arbiter_payload(payload, [_ambiguity()])
    assert result.accepted[2] == (12, "glued_number", "glued_suffix")
    assert result.issues == []


def test_arbiter_rejects_candidate_outside_interval():
    payload = {"intervals": [{
        "interval_id": "C11-13",
        "result": "resolved",
        "assignments": [{"number": 12, "candidate_id": "DOES-NOT-EXIST"}],
    }]}
    result = validate_arbiter_payload(payload, [_ambiguity()])
    assert result.accepted == {}
    assert result.issues[0].code == "stem_chain_llm_invalid"


def test_arbiter_unavailable_is_unresolved_not_remote_fallback():
    class BrokenLLM:
        def complete(self, system, user):
            raise RuntimeError("local offline")

    result = arbitrate_stem_ambiguities(BrokenLLM(), [_ambiguity()], "卷A")
    assert result.accepted == {}
    assert result.issues[0].code == "stem_chain_llm_unresolved"


def test_arbiter_sends_one_batch_for_multiple_intervals():
    class RecordingLLM:
        def __init__(self):
            self.user = ""

        def complete(self, system, user):
            self.user = user
            return SimpleNamespace(content=json.dumps({"intervals": []}))

    llm = RecordingLLM()
    arbitrate_stem_ambiguities(llm, [_ambiguity(), _ambiguity()], "卷A")
    assert llm.user.count('"interval_id": "C11-13"') == 2
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd tools/data-refinery
pytest tests/test_stem_chain_arbiter.py -v
```

Expected: FAIL with `ModuleNotFoundError: stem_chain_arbiter`.

- [ ] **Step 3: Add the closed-set prompt**

```text
你是试卷题号链的歧义仲裁器。输入包含若干独立区间：
- interval_id
- 左右锚点题号
- 待填题号
- 候选列表：candidate_id、原文数字、解释后题号、恢复方式、证据、上下文

你的任务是：为每个 interval 中的每个待填题号，在给定候选里做一一分配。

硬约束：
1. 只能使用请求中已有的 candidate_id，不能创建候选、题号或行号。
2. 候选不能重用，一个题号只能选一个候选。
3. 分配后的行号必须严格递增，并位于左右锚点之间。
4. 优先选择题干结构完整、段落边界清楚、与前后文连续的候选。
5. 如果无法形成唯一合法分配，该 interval 返回 unresolved，不要猜。

只输出 JSON：
{
  "intervals": [
    {
      "interval_id": "C11-13",
      "result": "resolved",
      "assignments": [{"number": 12, "candidate_id": "L100-O1"}]
    }
  ]
}
```

- [ ] **Step 4: Implement arbiter construction and validation**

```python
# tools/data-refinery/src/stem_chain_arbiter.py
import json
from dataclasses import dataclass
from pathlib import Path

from extract import _parse_json_object
from stem_chain import StemAmbiguity, StemIssue


@dataclass(frozen=True)
class StemArbitrationResult:
    accepted: dict[int, tuple[int, str, str]]
    issues: list[StemIssue]


def _interval_id(ambiguity: StemAmbiguity) -> str:
    return f"C{ambiguity.left_anchor}-{ambiguity.right_anchor}"


def _request_payload(ambiguities: list[StemAmbiguity]) -> dict:
    intervals = []
    for ambiguity in ambiguities:
        intervals.append({
            "interval_id": _interval_id(ambiguity),
            "left_anchor": ambiguity.left_anchor,
            "right_anchor": ambiguity.right_anchor,
            "expected_numbers": list(ambiguity.expected_numbers),
            "candidates": [
                {
                    "candidate_id": option.candidate_id,
                    "line_no": candidate.line_no,
                    "raw_number": option.raw_number,
                    "number": option.number,
                    "form": option.form,
                    "recovery": option.recovery,
                    "evidence": [e.tag for e in option.evidence],
                    "content": option.content_rest,
                    "before": candidate.context_before,
                    "after": candidate.context_after,
                }
                for candidate in ambiguity.candidates
                for option in candidate.options
            ],
        })
    return {"intervals": intervals}


def validate_arbiter_payload(
    payload: dict, ambiguities: list[StemAmbiguity],
) -> StemArbitrationResult:
    by_interval = {_interval_id(a): a for a in ambiguities}
    accepted: dict[int, tuple[int, str, str]] = {}
    issues: list[StemIssue] = []
    for item in payload.get("intervals", []):
        interval_id = item.get("interval_id")
        ambiguity = by_interval.get(interval_id)
        if ambiguity is None:
            continue
        if item.get("result") != "resolved":
            first_line = min(
                (candidate.line_no for candidate in ambiguity.candidates),
                default=0,
            )
            issues.append(StemIssue(
                code="stem_chain_llm_unresolved",
                severity="warning",
                message=f"{interval_id} 本地 LLM 未能唯一分配",
                line_no=first_line + 1,
                excerpt="",
                question_no=ambiguity.expected_numbers[0],
                interval_id=interval_id,
            ))
            continue
        options = {
            option.candidate_id: (candidate.line_no, option)
            for candidate in ambiguity.candidates
            for option in candidate.options
        }
        seen_ids: set[str] = set()
        seen_numbers: set[int] = set()
        rows: list[tuple[int, int, str, str]] = []
        valid = True
        for assignment in item.get("assignments", []):
            try:
                number = int(assignment["number"])
                cid = str(assignment["candidate_id"])
            except (KeyError, TypeError, ValueError):
                valid = False
                break
            if number not in ambiguity.expected_numbers or cid not in options:
                valid = False
                break
            if cid in seen_ids or number in seen_numbers:
                valid = False
                break
            line_no, option = options[cid]
            seen_ids.add(cid)
            seen_numbers.add(number)
            rows.append((line_no, number, option.form, option.recovery))
        if valid:
            rows.sort()
            valid = (
                seen_numbers == set(ambiguity.expected_numbers)
                and all(rows[i][0] < rows[i + 1][0] for i in range(len(rows) - 1))
            )
        if not valid:
            first_line = min(
                (candidate.line_no for candidate in ambiguity.candidates),
                default=0,
            )
            issues.append(StemIssue(
                code="stem_chain_llm_invalid",
                severity="warning",
                message=f"{interval_id} 返回越界、重复、漏填或乱序分配",
                line_no=first_line + 1,
                excerpt=json.dumps(item, ensure_ascii=False)[:600],
                question_no=ambiguity.expected_numbers[0],
                interval_id=interval_id,
            ))
            continue
        for line_no, number, form, recovery in rows:
            accepted[line_no] = (number, form, recovery)
        issues.append(StemIssue(
            code="stem_chain_llm_resolved",
            severity="info",
            message=f"{interval_id} 本地 LLM 完成闭集分配",
            line_no=rows[0][0] + 1,
            excerpt="",
            question_no=rows[0][1],
            interval_id=interval_id,
        ))
    return StemArbitrationResult(accepted=accepted, issues=issues)


def arbitrate_stem_ambiguities(
    llm, ambiguities: list[StemAmbiguity], paper_stem: str = "",
) -> StemArbitrationResult:
    if not ambiguities:
        return StemArbitrationResult({}, [])
    try:
        system = (Path(__file__).parent / "prompts" / "stem_chain_arbiter.txt").read_text(
            encoding="utf-8"
        )
        user = json.dumps(_request_payload(ambiguities), ensure_ascii=False, indent=2)
        response = llm.complete(system, user)
        payload = _parse_json_object(response.content or "")
        return validate_arbiter_payload(payload, ambiguities)
    except Exception as exc:
        return StemArbitrationResult({}, [
            StemIssue(
                code="stem_chain_llm_unresolved",
                severity="warning",
                message=f"{paper_stem}: 本地 LLM 仲裁不可用：{exc}",
                line_no=1,
                excerpt="",
            )
        ])
```

- [ ] **Step 5: Run arbiter tests**

Run:

```bash
cd tools/data-refinery
pytest tests/test_stem_chain_arbiter.py -v
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add tools/data-refinery/src/prompts/stem_chain_arbiter.txt \
  tools/data-refinery/src/stem_chain_arbiter.py \
  tools/data-refinery/tests/test_stem_chain_arbiter.py
git commit -m "feat(refinery): arbitrate ambiguous stem intervals locally"
```

---

### Task 6: 第二遍切题支持 forced 优先级和 gap suppression

**Files:**
- Modify: `tools/data-refinery/src/question_splitter.py:904-925`
- Modify: `tools/data-refinery/src/question_splitter.py:1019-1050`
- Modify: `tools/data-refinery/src/question_splitter.py:1082-1235`
- Modify: `tools/data-refinery/src/question_splitter.py:1303-1403`
- Modify: `tools/data-refinery/tests/test_question_splitter.py`

**Interfaces:**
- Consumes: `forced_stem_map: dict[int, tuple[int, str, str]] | None`, `consumed_lines: set[int] | None`, `suppressed_ranges: list[tuple[int, int]] | None`, `stem_chain_result: object | None`.
- Produces: `split_page_result(..., forced_stem_map=, consumed_lines=, suppressed_ranges=, stem_chain_result=) -> SplitPageResult`; `SplitPageResult.stem_chain_result`.

- [ ] **Step 1: Write failing splitter integration tests**

```python
# append to tools/data-refinery/tests/test_question_splitter.py

def test_forced_map_bypasses_end_of_paper_small_number_merge():
    md = """20. 第二十题

2. 该行最终题号是第二十一题

22. 第二十二题
"""
    lines = md.split("\n")
    forced_line = lines.index("2. 该行最终题号是第二十一题")
    qs = split_page(
        md,
        Path("x.md"),
        strategy=_math_strategy(),
        forced_stem_map={forced_line: (21, "main", "dropped_tens")},
    )
    assert [q.group_order for q in qs] == [20, 21, 22]
    assert qs[1].content.startswith("该行最终题号")


def test_suppressed_gap_range_is_not_appended_to_previous_question():
    md = """1. 第一题正文

26. 属于未确认 gap 的正文

27. 第二十七题
"""
    lines = md.split("\n")
    gap_line = lines.index("26. 属于未确认 gap 的正文")
    qs = split_page(
        md,
        Path("x.md"),
        strategy=_math_strategy(),
        suppressed_ranges=[(gap_line, gap_line)],
    )
    assert [q.group_order for q in qs] == [1, 27]
    assert "属于未确认 gap" not in qs[0].content


def test_split_page_result_carries_stem_chain_result():
    from question_splitter import split_page_result

    marker = object()
    result = split_page_result(
        "1. 第一题正文",
        Path("x.md"),
        strategy=_math_strategy(),
        stem_chain_result=marker,
    )
    assert result.stem_chain_result is marker


def test_inline_glued_is_controlled_by_forced_map_when_map_is_supplied():
    md = """1. 第一题正文。2. 第二题正文

3. 第三题正文
"""
    line_no = 0
    qs = split_page(
        md,
        Path("x.md"),
        strategy=_math_strategy(),
        forced_stem_map={line_no: (1, "main", "exact")},
    )
    assert [q.group_order for q in qs] == [1, 3]
    assert "2. 第二题正文" in qs[0].content
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd tools/data-refinery
pytest tests/test_question_splitter.py -v -k "forced_map_bypasses or suppressed_gap or carries_stem_chain or inline_glued_is_controlled"
```

Expected: FAIL because the new keywords are not accepted.

- [ ] **Step 3: Extend signatures and `SplitPageResult`**

```python
@dataclass
class SplitPageResult:
    questions: list[RawQuestion]
    answer_result: AnswerParseResult | None
    stem_chain_result: object | None = None
```

```python
def _split_questions_only(
    text: str,
    md_path: Path,
    strategy=None,
    *,
    forced_stem_lines: set[int] | None = None,
    forced_stem_map: dict[int, tuple[int, str, str]] | None = None,
    consumed_lines: set[int] | None = None,
    suppressed_ranges: list[tuple[int, int]] | None = None,
    suspects_out: list | None = None,
) -> list[RawQuestion]:
```

```python
def split_page_result(
    text: str,
    md_path: Path,
    strategy=None,
    *,
    forced_stem_lines: set[int] | None = None,
    forced_stem_map: dict[int, tuple[int, str, str]] | None = None,
    consumed_lines: set[int] | None = None,
    suppressed_ranges: list[tuple[int, int]] | None = None,
    suspects_out: list | None = None,
    stem_chain_result: object | None = None,
) -> SplitPageResult:
```

`split_page()` receives and forwards the same optional keywords, still returning only `.questions`.

- [ ] **Step 4: Implement suppression, forced precedence, and form-specific stripping**

```python
# _split_questions_only setup
suppressed = {
    i
    for start, end in (suppressed_ranges or [])
    for i in range(start, end + 1)
}
consumed = set(consumed_lines or ())

# top of per-line loop, after blank/date handling
if i in suppressed:
    continue

# after is_answer_keyword(line) handling and before strategy.is_stem:
forced = (forced_stem_map or {}).get(i)

# replace the existing inline glued branch guard:
if not ok and current is not None and (
    (forced is not None and forced[1] == "inline_glued")
    or (forced_stem_map is None and i not in consumed)
):
    expected = forced[0] if forced is not None else current.group_order + 1
    glued = _split_glued_next_stem(line, expected)
    ...

# immediately before strategy.is_stem:
form = None
if forced is not None and forced[1] != "inline_glued":
    ok, n = True, forced[0]
    form = forced[1]
else:
    ok, n = strategy.is_stem(line)

# When stripping forced content:
if forced is not None and form == "bare":
    content = _strip_bare_prefix(line)
elif forced is not None:
    content = _strip_main_stem_prefix(line)
elif accepted_bare:
    content = _strip_bare_prefix(line)
else:
    content = _strip_main_stem_prefix(line)

# Inside `if ok:` guard local corrections:
if not forced:
    if len(line.strip()) <= 40 and _JUNK_QUESTION_RE.search(line):
        continue
    if last_stem_no >= 20 and n <= 5:
        ...
    if n in seen_stems:
        ...
    if last_stem_no and n > last_stem_no + 1:
        ...
else:
    if n in seen_stems:
        raise ValueError(f"forced stem duplicate at line {i + 1}: {n}")
```

The forced branch must still remain after `is_answer_keyword`, part headers, group headers, and section/material boundaries.

- [ ] **Step 5: Run splitter tests**

Run:

```bash
cd tools/data-refinery
pytest tests/test_question_splitter.py -v -k "forced_map_bypasses or suppressed_gap or carries_stem_chain or inline_glued_is_controlled"
pytest tests/test_question_splitter.py -q
```

Expected: PASS. Existing `forced_stem_lines={2}` compatibility test remains green.

- [ ] **Step 6: Commit**

```bash
git add tools/data-refinery/src/question_splitter.py tools/data-refinery/tests/test_question_splitter.py
git commit -m "feat(refinery): prioritize forced stems and suppress gap ranges"
```

---

### Task 7: `question_extract` 编排、本地模型门槛与 issue 落盘

**Files:**
- Modify: `tools/data-refinery/src/question_extract.py:18-30`
- Modify: `tools/data-refinery/src/question_extract.py:110-134`
- Modify: `tools/data-refinery/src/question_extract.py:709-760`
- Create: `tools/data-refinery/tests/test_stem_chain_extract.py`

**Interfaces:**
- Consumes: Task 2-6 APIs.
- Produces: `_split_paper_questions(text, md_path, strategy, llm, allow_local_llm) -> tuple[SplitPageResult, list[StemIssue]]`; `_purge_stem_chain_issues_for_source(log_path, source_name) -> None`; `_write_stem_chain_issues(log_path, source_name, issues) -> int`.

- [ ] **Step 1: Write failing issue-log and orchestration tests**

```python
# tools/data-refinery/tests/test_stem_chain_extract.py
import json
from pathlib import Path

from question_extract import (
    _purge_stem_chain_issues_for_source, _write_stem_chain_issues,
)
from stem_chain import StemIssue


def test_stem_chain_issue_log_replaces_same_source_only(tmp_path):
    log = tmp_path / "stem_chain_issues.jsonl"
    log.write_text(
        '{"source":"卷A","code":"old"}\n'
        '{"source":"卷B","code":"keep"}\n',
        encoding="utf-8",
    )
    _purge_stem_chain_issues_for_source(log, "卷A")
    rows = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
    assert rows == [{"source": "卷B", "code": "keep"}]


def test_write_stem_chain_issues_serializes_stable_fields(tmp_path):
    log = tmp_path / "stem_chain_issues.jsonl"
    count = _write_stem_chain_issues(log, "卷A", [
        StemIssue(
            code="stem_chain_gap",
            severity="error",
            message="缺 26",
            line_no=12,
            excerpt="26. 弱候选",
            question_no=26,
            interval_id="C25-27",
            candidate_ids=("L12-Main-26",),
        )
    ])
    row = json.loads(log.read_text(encoding="utf-8").splitlines()[0])
    assert count == 1
    assert row["source"] == "卷A"
    assert row["question_no"] == 26
    assert row["candidate_ids"] == ["L12-Main-26"]


def test_capability_disabled_never_enters_global_chain(monkeypatch):
    import question_extract as qe
    from subject_strategies import get_strategy

    def boom(*args, **kwargs):
        raise AssertionError("global chain must not run")

    monkeypatch.setattr(qe, "collect_main_stem_probes", boom)
    result, issues = qe._split_paper_questions(
        "1. 第一题正文",
        Path("english.md"),
        get_strategy("english"),
        None,
        False,
    )
    assert [q.group_order for q in result.questions] == [1]
    assert issues == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd tools/data-refinery
pytest tests/test_stem_chain_extract.py -v
```

Expected: FAIL with missing imports.

- [ ] **Step 3: Add issue purge/write helpers**

```python
def _purge_stem_chain_issues_for_source(log_path: Path, source_name: str) -> None:
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


def _write_stem_chain_issues(
    log_path: Path, source_name: str, issues: list[StemIssue],
) -> int:
    if not issues:
        return 0
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("a", encoding="utf-8") as handle:
        for issue in issues:
            handle.write(json.dumps({
                "source": source_name,
                "code": issue.code,
                "severity": issue.severity,
                "message": issue.message,
                "line_no": issue.line_no,
                "excerpt": issue.excerpt,
                "question_no": issue.question_no,
                "interval_id": issue.interval_id,
                "candidate_ids": list(issue.candidate_ids),
            }, ensure_ascii=False) + "\n")
    return len(issues)
```

- [ ] **Step 4: Add the chain orchestration helper**

```python
from dataclasses import replace
from question_splitter import SplitPageResult, split_page_result
from stem_chain import (
    StemIssue, collect_interval_candidates, collect_main_stem_probes,
    select_stem_anchors, select_stem_chains, supports_global_stem_chain,
)
from stem_chain_arbiter import arbitrate_stem_ambiguities


def _split_paper_questions(text, md_path, strategy, llm, allow_local_llm):
    if not supports_global_stem_chain(strategy):
        suspects: list[dict] = []
        questions = split_page(text, md_path, strategy=strategy, suspects_out=suspects)
        if suspects and llm is not None:
            accepted = _judge_suspects(llm, suspects, md_path.stem)
            if accepted:
                questions = split_page(
                    text, md_path, strategy=strategy, forced_stem_lines=accepted,
                )
        return SplitPageResult(questions=questions, answer_result=None), []

    probes = collect_main_stem_probes(text, strategy)
    anchors = select_stem_anchors(probes)
    collection = collect_interval_candidates(text, strategy, anchors)
    chain = select_stem_chains(collection, source_lines=text.split("\n"))
    issues = list(chain.issues)
    accepted = dict(chain.accepted)
    resolved_intervals: set[str] = set()
    if chain.ambiguities:
        if allow_local_llm and llm is not None:
            arbitration = arbitrate_stem_ambiguities(
                llm, chain.ambiguities, md_path.stem,
            )
            accepted.update(arbitration.accepted)
            issues.extend(arbitration.issues)
            resolved_intervals = {
                issue.interval_id
                for issue in arbitration.issues
                if issue.code == "stem_chain_llm_resolved" and issue.interval_id
            }
        else:
            issues.extend(
                StemIssue(
                    code="stem_chain_llm_unresolved",
                    severity="warning",
                    message="存在歧义区间，但本地 LLM 未启用或不可用",
                    line_no=min(
                        (candidate.line_no for candidate in ambiguity.candidates),
                        default=0,
                    ) + 1,
                    excerpt="",
                    question_no=ambiguity.expected_numbers[0],
                    interval_id=f"C{ambiguity.left_anchor}-{ambiguity.right_anchor}",
                )
                for ambiguity in chain.ambiguities
            )

    accepted_numbers = {number for number, _form, _recovery in accepted.values()}
    issues = [
        issue for issue in issues
        if not (
            issue.interval_id in resolved_intervals
            and issue.code in (
                "stem_chain_ambiguous",
                "stem_chain_high_risk_recovery",
                "stem_chain_gap",
            )
        )
    ]
    remaining_gaps = [
        gap for gap in chain.gaps
        if gap[1] not in accepted_numbers
    ]
    remaining_segments = [
        segment for segment in chain.gap_segments
        if any(number not in accepted_numbers for number in segment.missing_numbers)
    ]
    suppressed = [
        (segment.line_start, segment.line_end)
        for segment in remaining_segments
        if segment.line_start is not None
    ]
    final_chain = replace(
        chain,
        accepted=accepted,
        gaps=remaining_gaps,
        gap_segments=remaining_segments,
        issues=issues,
    )
    result = split_page_result(
        text,
        md_path,
        strategy=strategy,
        forced_stem_map=accepted,
        consumed_lines=set(collection.consumed_lines),
        suppressed_ranges=suppressed,
        stem_chain_result=final_chain,
    )
    return result, issues
```

`allow_local_llm` must be `config.llm_provider == "local"`; do not inspect `fb_llm` and do not pass the fallback model.

- [ ] **Step 5: Wire the helper into `extract_questions_file`**

```python
stem_issues_log = extracted_dir.parent / "stem_chain_issues.jsonl"
_purge_stem_chain_issues_for_source(stem_issues_log, md_path.stem)

split_result, stem_issues = _split_paper_questions(
    text,
    md_path,
    strategy,
    llm,
    allow_local_llm=(config.llm_provider == "local"),
)
questions = split_result.questions
_write_stem_chain_issues(stem_issues_log, md_path.stem, stem_issues)
```

Replace the current direct `split_page(..., suspects_out=...)` block. The capability-disabled path inside `_split_paper_questions()` preserves the old suspect flow exactly.

- [ ] **Step 6: Run extract-level tests**

Run:

```bash
cd tools/data-refinery
pytest tests/test_stem_chain_extract.py -v
pytest tests/test_question_extract_review.py -q
pytest tests/test_page_marker_integration.py -q
```

Expected: PASS. No DB or network calls occur in these tests.

- [ ] **Step 7: Commit**

```bash
git add tools/data-refinery/src/question_extract.py tools/data-refinery/tests/test_stem_chain_extract.py
git commit -m "feat(refinery): wire stem chain into paper extraction"
```

---

### Task 8: 识别问题扫描消费 stem issue

**Files:**
- Modify: `tools/data-refinery/src/recognition_scan.py:34-45`
- Modify: `tools/data-refinery/src/recognition_scan.py:679-780`
- Modify: `tools/data-refinery/tests/test_recognition_scan.py`

**Interfaces:**
- Consumes: `output/stem_chain_issues.jsonl`.
- Produces: `stem_issue_to_recognition(row, md_path, pdf_path) -> dict | None`; `load_stem_issues_for_source(source) -> list[dict]`.

- [ ] **Step 1: Write failing conversion and dedupe tests**

```python
# append to tools/data-refinery/tests/test_recognition_scan.py

def test_stem_chain_issue_becomes_traceable_recognition_issue(tmp_path):
    md = _md(tmp_path, "26. 弱候选\n")
    row = {
        "source": "卷A",
        "code": "stem_chain_gap",
        "severity": "error",
        "message": "题号链在 25→26 断开",
        "line_no": 1,
        "excerpt": "26. 弱候选",
        "question_no": 26,
        "candidate_ids": ["L0-Main-26"],
    }
    issue = R.stem_issue_to_recognition(row, md, None)
    assert issue["source"] == "卷A"
    assert issue["group_order"] == 26
    assert issue["kind"] == "stem_chain_gap"
    assert issue["line_no"] == 1
    assert issue["candidate_ids"] == ["L0-Main-26"]
    assert issue["md"] == str(md)
    assert issue["status"] == "pending"


def test_stem_chain_info_resolved_is_not_sent_to_manual_queue(tmp_path):
    md = _md(tmp_path, "1. 甲\n")
    row = {
        "source": "卷A",
        "code": "stem_chain_llm_resolved",
        "severity": "info",
        "line_no": 1,
        "question_no": 1,
    }
    assert R.stem_issue_to_recognition(row, md, None) is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd tools/data-refinery
pytest tests/test_recognition_scan.py -v -k stem_chain
```

Expected: FAIL because `stem_issue_to_recognition` is missing.

- [ ] **Step 3: Implement conversion**

```python
STEM_ISSUES_FILE = ROOT / "output" / "stem_chain_issues.jsonl"


def stem_issue_to_recognition(
    row: dict, md_path: Path, pdf_path: Path | None,
) -> dict | None:
    if row.get("severity") == "info":
        return None
    question_no = row.get("question_no")
    if not isinstance(question_no, int):
        return None
    code = str(row.get("code") or "")
    return {
        "source": row.get("source"),
        "group_order": question_no,
        "kind": code,
        "reasons": [code, "stem_chain"],
        "excerpt": _excerpt(row.get("excerpt") or ""),
        "line_no": row.get("line_no"),
        "candidate_ids": row.get("candidate_ids") or [],
        "pdf": str(pdf_path) if pdf_path else None,
        "md": str(md_path),
        "status": "pending",
    }


def load_stem_issues_for_source(
    source: str, md_path: Path, pdf_path: Path | None,
) -> list[dict]:
    return [
        converted
        for row in _read_jsonl(STEM_ISSUES_FILE)
        if row.get("source") == source
        for converted in [stem_issue_to_recognition(row, md_path, pdf_path)]
        if converted is not None
    ]
```

- [ ] **Step 4: Extend `run()` and dedupe keys**

```python
found.extend(load_stem_issues_for_source(
    source,
    md_path,
    pdf_path if pdf_path.exists() else None,
))
```

Replace the three 3-tuple issue keys with one helper:

```python
def _issue_key(i: dict) -> tuple:
    base = (i["source"], i["group_order"], i["kind"])
    return base if i.get("line_no") is None else base + (i["line_no"],)
```

Use `_issue_key()` in `current`, `by_key`, `known`, and `reopen_changed()` so two chain issues on different lines cannot collapse into one.

- [ ] **Step 5: Run recognition tests**

Run:

```bash
cd tools/data-refinery
pytest tests/test_recognition_scan.py -v
```

Expected: PASS. Existing manual-review behavior remains unchanged.

- [ ] **Step 6: Commit**

```bash
git add tools/data-refinery/src/recognition_scan.py tools/data-refinery/tests/test_recognition_scan.py
git commit -m "feat(refinery): surface stem chain issues in review queue"
```

---

### Task 9: Holdout 指标工具

**Files:**
- Create: `tools/data-refinery/src/stem_chain_benchmark.py`
- Create: `tools/data-refinery/tests/test_stem_chain_benchmark.py`

**Interfaces:**
- Consumes: golden JSONL rows `{source, question_numbers, boundaries}` and `StemChainResult`.
- Produces: `evaluate_source(golden, result) -> dict`; `summarize(rows) -> dict`; CLI `python3 src/stem_chain_benchmark.py --golden <path> --json-out <path>`.

- [ ] **Step 1: Write failing metric tests**

```python
# tools/data-refinery/tests/test_stem_chain_benchmark.py
from stem_chain import StemChainResult
from stem_chain_benchmark import evaluate_source, summarize


def _result(lines: dict[int, int], issues: list | None = None) -> StemChainResult:
    return StemChainResult(
        accepted={line: (number, "main", "exact") for line, number in lines.items()},
        gaps=[],
        gap_segments=[],
        ambiguities=[],
        safe_prefix={},
        issues=issues or [],
    )


def test_evaluate_source_reports_number_and_boundary_accuracy():
    golden = {
        "source": "卷A",
        "question_numbers": [1, 2, 3],
        "boundaries": {0: 1, 2: 2, 4: 3},
    }
    result = _result({0: 1, 2: 2, 4: 4})
    metrics = evaluate_source(golden, result)
    assert metrics["numbers_exact"] is False
    assert metrics["number_precision"] == 2 / 3
    assert metrics["number_recall"] == 2 / 3
    assert metrics["boundary_precision"] == 2 / 3
    assert metrics["boundary_recall"] == 2 / 3


def test_summarize_counts_llm_and_gap_rates():
    rows = [
        {"llm_calls": 0, "gap_count": 0, "ambiguous_count": 0},
        {"llm_calls": 1, "gap_count": 1, "ambiguous_count": 1},
    ]
    summary = summarize(rows)
    assert summary["sources"] == 2
    assert summary["llm_call_rate"] == 0.5
    assert summary["gap_source_rate"] == 0.5
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd tools/data-refinery
pytest tests/test_stem_chain_benchmark.py -v
```

Expected: FAIL with missing module.

- [ ] **Step 3: Implement metrics and CLI**

```python
# tools/data-refinery/src/stem_chain_benchmark.py
import argparse
import json
from pathlib import Path

from question_extract import _load_prepared_text
from stem_chain import (
    collect_interval_candidates, collect_main_stem_probes,
    select_stem_anchors, select_stem_chains,
)
from subject_strategies import get_strategy


def _ratio(hit: int, total: int) -> float:
    return 0.0 if total == 0 else hit / total


def evaluate_source(golden: dict, result, anchors=()) -> dict:
    expected_numbers = set(golden["question_numbers"])
    actual_numbers = {
        number for number, _form, _recovery in result.accepted.values()
    } | {anchor.options[0].number for anchor in anchors}
    expected_boundaries = {int(k): int(v) for k, v in golden["boundaries"].items()}
    actual_boundaries = {
        line: number for line, (number, _form, _recovery) in result.accepted.items()
    }
    actual_boundaries.update({
        anchor.line_no: anchor.options[0].number for anchor in anchors
    })
    return {
        "source": golden["source"],
        "numbers_exact": actual_numbers == expected_numbers,
        "number_precision": _ratio(len(actual_numbers & expected_numbers), len(actual_numbers)),
        "number_recall": _ratio(len(actual_numbers & expected_numbers), len(expected_numbers)),
        "boundary_precision": _ratio(
            len(set(actual_boundaries.items()) & set(expected_boundaries.items())),
            len(actual_boundaries),
        ),
        "boundary_recall": _ratio(
            len(set(actual_boundaries.items()) & set(expected_boundaries.items())),
            len(expected_boundaries),
        ),
        "gap_count": len(result.gaps),
        "ambiguous_count": len(result.ambiguities),
        "llm_calls": len(result.ambiguities),
    }


def summarize(rows: list[dict]) -> dict:
    count = len(rows)
    return {
        "sources": count,
        "exact_number_rate": _ratio(sum(r["numbers_exact"] for r in rows), count),
        "mean_number_precision": _ratio(sum(r["number_precision"] for r in rows), count),
        "mean_number_recall": _ratio(sum(r["number_recall"] for r in rows), count),
        "mean_boundary_precision": _ratio(sum(r["boundary_precision"] for r in rows), count),
        "mean_boundary_recall": _ratio(sum(r["boundary_recall"] for r in rows), count),
        "llm_call_rate": _ratio(sum(r["llm_calls"] > 0 for r in rows), count),
        "gap_source_rate": _ratio(sum(r["gap_count"] > 0 for r in rows), count),
    }


def run_golden(golden_rows: list[dict], md_root: Path) -> list[dict]:
    strategy = get_strategy("math")
    rows: list[dict] = []
    for golden in golden_rows:
        matches = sorted(md_root.rglob(f"{golden['source']}.md"))
        if len(matches) != 1:
            raise RuntimeError(
                f"golden source must resolve to one md: {golden['source']} -> {len(matches)}"
            )
        md_path = matches[0]
        text = _load_prepared_text(md_path)
        probes = collect_main_stem_probes(text, strategy)
        anchors = select_stem_anchors(probes)
        collection = collect_interval_candidates(text, strategy, anchors)
        result = select_stem_chains(
            collection, source_lines=text.split("\n"),
        )
        rows.append(evaluate_source(golden, result, anchors=collection.anchors))
    return rows


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--golden", required=True)
    parser.add_argument("--md-root", default="output/md")
    parser.add_argument("--json-out", required=True)
    args = parser.parse_args(argv)
    golden_rows = [
        json.loads(line)
        for line in Path(args.golden).read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    rows = run_golden(golden_rows, Path(args.md_root))
    payload = {
        "golden_sources": len(golden_rows),
        "summary": summarize(rows),
        "per_source": rows,
    }
    Path(args.json_out).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
```

The CLI runs the deterministic chain only. It intentionally does not call the local LLM,
so `ambiguous_count` and `llm_calls` measure how much ambiguity still needs arbitration.
Production extraction remains the only path that invokes the local model.

- [ ] **Step 4: Run metric tests**

Run:

```bash
cd tools/data-refinery
pytest tests/test_stem_chain_benchmark.py -v
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add tools/data-refinery/src/stem_chain_benchmark.py tools/data-refinery/tests/test_stem_chain_benchmark.py
git commit -m "test(refinery): add stem chain holdout metrics"
```

---

### Task 10: 真实卷回归、清理局部补丁、文档同步

**Files:**
- Modify: `tools/data-refinery/src/question_splitter.py:1093-1101`
- Modify: `tools/data-refinery/src/split_snapshot.py:15-20`
- Modify: `tools/data-refinery/src/split_snapshot.py:43-123`
- Modify: `tools/data-refinery/tests/test_question_splitter.py`
- Modify: `tools/data-refinery/tests/test_answer_blocks.py`
- Create: `tools/data-refinery/tests/fixtures/split_snapshot_stem_chain.json`
- Modify: `docs/constraints/数据管线.md`
- Modify: `docs/ai-core-changelog.md`

**Interfaces:**
- Consumes: all previous tasks.
- Produces: final regression suite and updated operational constraints.

- [ ] **Step 1: Add the 85434 two-fault regression before deleting the local patch**

```python
# append to tools/data-refinery/tests/test_question_splitter.py
def test_85434_25_16_requires_chain_while_11_4_answer_guard_remains():
    stem_md = """24. 第二十四题题干

25.16 世纪中叶，我国发明了一种新式火箭。

(1) 若火箭第二级的引发点高度为 3.6km，求 a, b 的值。

26. 第二十六题题干

# 参考答案

24. 第二十四题答案

25.【答案】(1) ① a = -1/15 ; ② 8.4 km

【解答】解得 $x = 11.4$

11.4 - 3 = 8.4 (km)

∴这两个位置之间的距离 8.4km.

26. 第二十六题答案
"""
    from question_extract import _split_paper_questions

    split_result, _issues = _split_paper_questions(
        stem_md,
        Path("85434.md"),
        _math_strategy(),
        None,
        False,
    )
    qs = {q.group_order: q for q in split_result.questions}
    assert sorted(qs) == [24, 25, 26]
    assert "16 世纪中叶" not in qs[24].content
    assert qs[25].content.startswith("16 世纪中叶")
    assert "11.4 - 3 = 8.4" in qs[25].answer
    assert "11.4 - 3 = 8.4" not in qs[24].answer
```

```python
# append to tools/data-refinery/tests/test_answer_blocks.py
def test_answer_guard_stays_after_stem_chain_landing():
    """题干链修好 Q25 槽位后，答案正文 11.4 仍不能开题 11。"""
    lines = [
        AnswerLine(1, "25.【答案】(1) ① a = -1/15 ; ② 8.4 km"),
        AnswerLine(2, "【解答】解得 $x = 11.4$"),
        AnswerLine(3, "11.4 - 3 = 8.4 (km)"),
        AnswerLine(4, "26.【答案】1"),
    ]
    result = parse_answer_region(
        lines,
        [AnswerQuestion(no=25, group_id=None), AnswerQuestion(no=26, group_id=None)],
        first_line_no=1,
    )
    got = {fragment.question_no: fragment.text for fragment in result.fragments}
    assert "11.4 - 3 = 8.4" in got[25]
    assert 11 not in got
```

- [ ] **Step 2: Run regression tests while old local patch still exists**

Run:

```bash
cd tools/data-refinery
pytest tests/test_question_splitter.py::test_85434_25_16_requires_chain_while_11_4_answer_guard_remains -v
pytest tests/test_answer_blocks.py::test_answer_guard_stays_after_stem_chain_landing -v
```

Expected: PASS. This proves the new tests pin the required behavior before cleanup.

- [ ] **Step 3: Delete only the old `25.16` stem patch**

Remove the block in `_split_questions_only()` bounded by the comments:

```python
# 解答题里 OCR 常把「25.」和正文「16 世纪…」粘成 `25.16 世纪…`
# ...
# 才按新题号处理（85434 第 25 题）——避免把正文里的 `9.5 米` 当题号。
```

Do not remove any branch in `answer_blocks.py`.

- [ ] **Step 4: Run targeted and fully offline tests**

Run:

```bash
cd tools/data-refinery
pytest tests/test_stem_chain.py -v
pytest tests/test_stem_chain_arbiter.py -v
pytest tests/test_stem_chain_extract.py -v
pytest tests/test_question_splitter.py -q
pytest tests/test_answer_blocks.py -q
pytest tests/test_recognition_scan.py -q
pytest tests/test_question_extract_review.py -q
```

Expected: PASS across all targeted suites.

- [ ] **Step 5: Run the 30-volume holdout protocol**

Create a golden JSONL under the local output directory with exactly 30 manually reviewed rows. Required schema per line:

```json
{"source":"数学-初三(上)-202407-北京各-（上）期中-试卷-85434","question_numbers":[1,2,3,24,25,26,27,28],"boundaries":{"0":1,"20":24,"196":25,"212":26,"300":27}}
```

Then run:

```bash
cd tools/data-refinery
python3 src/stem_chain_benchmark.py \
  --golden output/stem_chain_golden_30.jsonl \
  --json-out output/stem_chain_benchmark.json
```

Expected:

- `golden_sources == 30`
- report includes number/boundary precision/recall, exact rate, LLM rate and gap rate
- no golden source is used by production extraction

Do not tune thresholds against the 594-volume corpus after looking at these 30 results. If metrics are insufficient, select a new holdout before further tuning.

- [ ] **Step 6: Run the full corpus comparison**

Add a separate snapshot path so the old baseline remains available:

```python
from question_extract import _split_paper_questions

STEM_CHAIN_BASELINE = ROOT / "tests" / "fixtures" / "split_snapshot_stem_chain.json"


def snapshot(md_root: Path, use_stem_chain: bool = False) -> dict:
    snap: dict = {}
    for path in sample_files(md_root):
        strategy = get_strategy(subject_code_for_path(
            path.relative_to(md_root), default="math",
        ))
        if use_stem_chain:
            split_result, _issues = _split_paper_questions(
                path.read_text(encoding="utf-8"), path, strategy, None, False,
            )
            questions = split_result.questions
        else:
            questions = split_page(
                path.read_text(encoding="utf-8"), path, strategy=strategy,
            )
        rel = str(path.relative_to(md_root))
        snap[rel] = {
            "count": len(questions),
            "items": [
                {
                    "no": q.group_order,
                    "sub": q.sub_no,
                    "hash": hashlib.sha1(q.content.encode("utf-8")).hexdigest()[:12],
                    "mat": hashlib.sha1(
                        (q.material_text or "").encode("utf-8")
                    ).hexdigest()[:12],
                    "gid": q.group_id,
                    "score": q.score,
                }
                for q in questions
            ],
        }
    return snap
```

Add CLI flag `--stem-chain` and choose `STEM_CHAIN_BASELINE` when it is set.

Run:

```bash
cd tools/data-refinery
python3 src/split_snapshot.py --check
python3 src/split_snapshot.py --stem-chain --write
python3 src/split_snapshot.py --stem-chain --check
git diff -- tests/fixtures/split_snapshot_stem_chain.json
pytest tests -q
```

Expected:

- old-path snapshot remains zero-diff
- new chain snapshot is committed only after every changed count/hash is reviewed
- pytest exits 0
- snapshot differences are reviewed one by one
- no new content bleed
- every newly missing question has a `stem_chain_gap` or an explicit manual decision
- 85487 answers remain aligned
- 85434 Q25 answer remains intact after the answer-side guard

- [ ] **Step 7: Update constraints and changelog**

Add to `docs/constraints/数据管线.md`:

```markdown
**题号全局链（2026-11-27）**：数学题干切题先收集全卷 `main` 探针并选锚点，再在锚点区间生成候选；
硬负证据直接淘汰，top-2 链并列才交给本地 LLM 做闭集仲裁。`dropped_tens`（如 `2→12`）
必须经本地 LLM 确认；首个锚点前默认不补号；gap 不得并入上一题或伪造新题。
`forced_stem_map` 优先于卷末 `N<=5` 合并、十位纠错和裸题号推断。
**勿动**：`answer_blocks.py` 的 `11.4`/公式数字守卫是答案区独立修复，
删除范围只允许旧题干侧 `25.16` 局部补丁。
```

Add to `docs/ai-core-changelog.md`:

```markdown
## 2026-11-27 数学切题：全局题号链与本地 LLM 歧义仲裁

**问题**：`25.16` 类粘题号依赖单行补丁；`12.8/12.16` 同题号候选没有全局比较；
答案区 `11.4` 误判与题干槽位缺失被混为一类。

**修复**：新增 main 探针、锚点、区间候选、top-2 链、gap segment 和本地闭集仲裁；
forced 结果不被局部规则覆盖；答案区既有守卫保留。首批只给数学策略开启。

**验证**：85434、85487、合成 `11→13` 与 `11→15` 场景、top-2 并列、gap、30 卷 holdout、
refinery 全量测试与 `split_snapshot --check`。
```

- [ ] **Step 8: Commit final integration**

```bash
git add tools/data-refinery/src/question_splitter.py \
  tools/data-refinery/src/split_snapshot.py \
  tools/data-refinery/tests/test_question_splitter.py \
  tools/data-refinery/tests/test_answer_blocks.py \
  tools/data-refinery/tests/fixtures/split_snapshot_stem_chain.json \
  docs/constraints/数据管线.md \
  docs/ai-core-changelog.md
git commit -m "fix(refinery): replace local stem patch with global chain"
```

## Final Verification Checklist

- [ ] `answer_blocks.py` contains no changes from this plan except test-only coverage.
- [ ] `25.16` stem patch is removed only after its global-chain regression passes.
- [ ] `2/3/4 → 12/13/14` is not accepted without local LLM confirmation.
- [ ] Equal candidate paths produce `stem_chain_ambiguous`; no line-order fallback exists.
- [ ] `forced_stem_map` survives `N<=5`, ten-digit correction, junk and duplicate guards.
- [ ] Gap content is never silently appended to the previous question when a boundary is known.
- [ ] Capability-disabled Chinese/English output is byte-for-byte unchanged on the existing suite.
- [ ] `stem_chain_issues.jsonl` is purged per source and deduped into recognition issues.
- [ ] 30-volume holdout metrics are recorded.
- [ ] 594-volume corpus comparison and `split_snapshot --check` are reviewed.
