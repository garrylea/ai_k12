# 学科策略包重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把切题（题号识别）、选项拆分、材料归属、答案提取四件事改成「每学科一份显式实现」，未登记学科直接报错，同时保证 87 例切分测试与黄金快照零差异。

**Architecture:** `question_splitter.py` 保留与学科无关的扫描内核；新增 `subject_strategies/` 包，每个学科一个文件实现 `is_stem / split_options / material_policy / extract_answers`；注册表 `get_strategy(code)` 无静默回退。`subject_cases/` 整体并入后删除。

**Tech Stack:** Python 3.10+、pytest、现有 data-refinery 工具链（无新增第三方依赖）。

## Global Constraints

- 工作目录：`tools/data-refinery/`；测试命令 `python3 -m pytest tests -q`。
- 现有基线：`1299 passed, 10 skipped`（2026-10-30 实测）。每个任务结束都不得低于该数。
- `tests/test_question_splitter.py` 的 **87 个用例断言一行都不许改**；只允许改调用签名（`attach_material=True` → `strategy=get_strategy("chinese")`、`split_options(x, subject="chinese")` → `get_strategy("chinese").split_options(x)`）。
- `question_splitter.py` 迁移完成后不得残留学科名常量：`grep -n "chinese\|语文" src/question_splitter.py` 只允许出现在注释里解释策略机制，不允许出现在可执行代码中。
- 未登记学科必须抛 `UnknownStrategyError`，禁止回退 generic。
- 提示词文件（`prompts/question_labeler/`、`prompts/question_kps/`）本次不改。
- 每个任务结束提交一次 commit，提交信息用 `refactor(splitter): …` / `feat(splitter): …`。

---

### Task 0: 黄金快照（动代码之前先拍基线）

**Files:**
- Create: `tools/data-refinery/scripts/split_snapshot.py`
- Create: `tools/data-refinery/tests/fixtures/split_snapshot.json`（脚本生成）
- Test: `tools/data-refinery/tests/test_split_snapshot.py`

**Interfaces:**
- Consumes: `question_splitter.split_page(text, md_path, attach_material=bool)`（重构前签名）、`subject_codes.subject_code_for_path(rel, default="math")`
- Produces: `split_snapshot.snapshot(md_root: Path) -> dict`、`split_snapshot.compare(current: dict, baseline: dict) -> list[str]`（返回差异描述列表，空列表=一致）

- [ ] **Step 1: 写快照脚本**

```python
"""切题行为黄金快照：重构前拍基线，重构后逐份比对题数与题干哈希。

用法（在 tools/data-refinery/ 下）：
    python3 scripts/split_snapshot.py --write     # 写 tests/fixtures/split_snapshot.json
    python3 scripts/split_snapshot.py --check     # 比对当前代码与基线，有差异退出码 1
"""

import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from question_splitter import split_page  # noqa: E402
from subject_codes import subject_code_for_path  # noqa: E402

SAMPLE_PER_SUBJECT = 8
BASELINE = ROOT / "tests" / "fixtures" / "split_snapshot.json"


def sample_files(md_root: Path) -> list[Path]:
    """每个学科等距抽 SAMPLE_PER_SUBJECT 份，顺序稳定（按路径排序后取步长）。"""
    by_subject: dict[str, list[Path]] = {}
    for path in sorted(md_root.rglob("*.md")):
        code = subject_code_for_path(path.relative_to(md_root), default="math")
        by_subject.setdefault(code, []).append(path)
    picked: list[Path] = []
    for code in sorted(by_subject):
        paths = by_subject[code]
        step = max(1, len(paths) // SAMPLE_PER_SUBJECT)
        picked.extend(paths[::step][:SAMPLE_PER_SUBJECT])
    return picked


def snapshot(md_root: Path) -> dict:
    snap: dict = {}
    for path in sample_files(md_root):
        rel = str(path.relative_to(md_root))
        code = subject_code_for_path(path.relative_to(md_root), default="math")
        questions = split_page(
            path.read_text(encoding="utf-8"), path,
            attach_material=(code == "chinese"),
        )
        snap[rel] = {
            "count": len(questions),
            "items": [
                # 五个维度都要钉：题干哈希之外，材料哈希（语文材料归属）、
                # 大题分组、分值一并有值，否则 attach_material / 分组标题解析
                # 坏掉时快照不会报差异。
                {"no": q.group_order,
                 "hash": hashlib.sha1(q.content.encode("utf-8")).hexdigest()[:12],
                 "mat": hashlib.sha1((q.material_text or "").encode("utf-8")).hexdigest()[:12],
                 "gid": q.group_id,
                 "score": q.score}
                for q in questions
            ],
        }
    return snap


def compare(current: dict, baseline: dict) -> list[str]:
    """逐份比对，返回人类可读的差异行（空列表 = 完全一致）。"""
    diffs: list[str] = []
    for rel in sorted(set(current) | set(baseline)):
        if rel not in current:
            diffs.append(f"{rel}: 基线有、当前缺失")
            continue
        if rel not in baseline:
            diffs.append(f"{rel}: 基线没有、当前多出")
            continue
        cur, base = current[rel], baseline[rel]
        if cur["count"] != base["count"]:
            diffs.append(f"{rel}: 题数 {base['count']} -> {cur['count']}")
            continue
        for i, (c, b) in enumerate(zip(cur["items"], base["items"])):
            if c != b:
                diffs.append(f"{rel}: 第 {i + 1} 项 {b} -> {c}")
    return diffs


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--md-root", default=str(ROOT / "output" / "md"))
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    md_root = Path(args.md_root)
    current = snapshot(md_root)
    if args.write:
        BASELINE.parent.mkdir(parents=True, exist_ok=True)
        BASELINE.write_text(json.dumps(current, ensure_ascii=False, indent=1, sort_keys=True),
                            encoding="utf-8")
        print(f"[ok] 基线已写入 {BASELINE}（{len(current)} 份）")
        return 0

    baseline = json.loads(BASELINE.read_text(encoding="utf-8"))
    diffs = compare(current, baseline)
    if diffs:
        print(f"[FAIL] {len(diffs)} 处差异：")
        for line in diffs[:50]:
            print("  " + line)
        return 1
    print(f"[ok] {len(baseline)} 份快照零差异")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 2: 写比对函数的单测（不依赖 md 文件）**

```python
"""黄金快照比对逻辑单测。"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from split_snapshot import compare  # noqa: E402


def test_compare_identical_returns_empty():
    snap = {"a.md": {"count": 2, "items": [{"no": 1, "hash": "x"}, {"no": 2, "hash": "y"}]}}
    assert compare(snap, snap) == []


def test_compare_reports_count_change():
    base = {"a.md": {"count": 2, "items": []}}
    cur = {"a.md": {"count": 3, "items": []}}
    assert compare(cur, base) == ["a.md: 题数 2 -> 3"]


def test_compare_reports_content_change_and_missing_file():
    base = {"a.md": {"count": 1, "items": [{"no": 1, "hash": "x"}]},
            "b.md": {"count": 1, "items": [{"no": 1, "hash": "z"}]}}
    cur = {"a.md": {"count": 1, "items": [{"no": 1, "hash": "y"}]}}
    diffs = compare(cur, base)
    assert diffs[0].startswith("a.md: 第 1 项")
    assert diffs[1] == "b.md: 基线有、当前缺失"
```

- [ ] **Step 3: 跑单测**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_split_snapshot.py -q`
Expected: `5 passed`（上述 3 个 compare 用例 + 抽样只收试卷 + 只改 `mat` 必须报差异）

- [ ] **Step 4: 生成基线（用重构前的代码）**

Run: `cd tools/data-refinery && python3 scripts/split_snapshot.py --write`
Expected: `[ok] 基线已写入 …/tests/fixtures/split_snapshot.json（N 份）`，N = 26（语数物各 8 份试卷，化学试卷仅 2 份；只抽文件名含「试卷」的 md）

- [ ] **Step 5: 验证基线可复现**

Run: `cd tools/data-refinery && python3 scripts/split_snapshot.py --check`
Expected: `[ok] N 份快照零差异`

- [ ] **Step 6: Commit**

```bash
git add tools/data-refinery/scripts/split_snapshot.py tools/data-refinery/tests/test_split_snapshot.py tools/data-refinery/tests/fixtures/split_snapshot.json
git commit -m "test(splitter): 切题黄金快照基线（题数/题干/材料/分组/分值，26 份试卷抽样）"
```

> **落地实况（与本节快照的差异）**：交付版本比上面两段代码更严——① 抽样只收文件名含「试卷」的 md（教科书单页切出 0 题，纳入只会得到空断言）；② `compare()` 的差异行改为只列出变动的字段（`第 1 项 mat '…' -> '…'`），不再是整份 dict 对打；③ 单测共 5 个：上述 3 个 compare 用例之外，另有「抽样只收试卷」和「只改 `mat` 也必须报差异」两条。

---

### Task 1: 策略类型、注册表与 generic 实现

**Files:**
- Create: `tools/data-refinery/src/subject_strategies/types.py`
- Create: `tools/data-refinery/src/subject_strategies/__init__.py`
- Create: `tools/data-refinery/src/subject_strategies/generic.py`
- Test: `tools/data-refinery/tests/subject_strategies/test_registry.py`
- Test: `tools/data-refinery/tests/subject_strategies/__init__.py`（空文件）

**Interfaces:**
- Consumes: `question_splitter.split_options(content)`（现有 A–D 实现，Task 1 不动它）
- Produces:
  - `types.ExtractedAnswer(no:int, answer:str="", approach:str="", explanation:str="", issues:list[str]=[])`
  - `types.MaterialPolicy(attach:bool=False)`，含 `is_material_title(lines, index, line) -> bool` 与 `looks_like_between_material(current_content, line) -> bool`，默认都返回 `False`
  - `types.NO_MATERIAL`（`MaterialPolicy(attach=False)` 单例）
  - `types.UnknownStrategyError(ValueError)`
  - `types.QuestionStrategy`（Protocol：`code`、`is_stem`、`split_options`、`material_policy`、`extract_answers`）
  - `get_strategy(code: str | None) -> QuestionStrategy`
  - `register(strategy: QuestionStrategy) -> None`

- [ ] **Step 1: 写失败的注册表测试**

```python
"""注册表与策略契约测试。"""

import pytest

from subject_strategies import get_strategy, register
from subject_strategies.types import (
    NO_MATERIAL, MaterialPolicy, UnknownStrategyError,
)


def test_get_strategy_returns_generic_instance():
    s = get_strategy("generic")
    assert s.code == "generic"
    assert s.material_policy() == NO_MATERIAL


def test_get_strategy_unknown_subject_raises():
    with pytest.raises(UnknownStrategyError) as exc:
        get_strategy("biology")
    assert "biology" in str(exc.value)


def test_get_strategy_none_raises():
    with pytest.raises(UnknownStrategyError):
        get_strategy(None)


def test_material_policy_defaults_do_not_attach():
    policy = MaterialPolicy()
    assert policy.attach is False
    assert policy.is_material_title(["a"], 0, "a") is False
    assert policy.looks_like_between_material("x", "y") is False


def test_register_does_not_allow_silent_override():
    class Fake:
        code = "faketest"
        def is_stem(self, line): return False, None
        def split_options(self, content): return content, None
        def material_policy(self): return NO_MATERIAL
        def extract_answers(self, text, md_path): return []

    register(Fake())
    assert get_strategy("faketest").code == "faketest"
    with pytest.raises(ValueError):
        register(Fake())  # 重复注册直接报错，避免顺序依赖
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd tools/data-refinery && python3 -m pytest tests/subject_strategies/test_registry.py -q`
Expected: FAIL，`ModuleNotFoundError: No module named 'subject_strategies'`

- [ ] **Step 3: 写 types.py**

```python
"""学科策略的公共类型。

零依赖：不 import question_splitter，避免与内核循环引用。
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol


@dataclass
class ExtractedAnswer:
    """一题的答案提取结果（no 为印刷题号）。"""
    no: int
    answer: str = ""
    approach: str = ""
    explanation: str = ""
    issues: list[str] = field(default_factory=list)


class UnknownStrategyError(ValueError):
    """学科未登记切题策略（明确报错，不猜测、不回退 generic）。"""


@dataclass(frozen=True)
class MaterialPolicy:
    """题号前 / 两题之间的短文是否归到题目上。

    attach=False 时两个谓词不会被调用；attach=True 时由各学科实现判定规则。
    """

    attach: bool = False

    def is_material_title(self, lines: list[str], index: int, line: str) -> bool:
        return False

    def looks_like_between_material(self, current_content: str, line: str) -> bool:
        return False


NO_MATERIAL = MaterialPolicy()


class QuestionStrategy(Protocol):
    """一个学科的切题策略：四件事各科自己实现。"""

    code: str

    def is_stem(self, line: str) -> tuple[bool, int | None]:
        """该行是否是主题号，返回 (是, 题号)。"""
        ...

    def split_options(self, content: str) -> tuple[str, list[dict] | None]:
        """题干/选项拆分；拆不出返回 (原 content, None)。"""
        ...

    def material_policy(self) -> MaterialPolicy:
        ...

    def extract_answers(self, text: str, md_path: Path) -> list[ExtractedAnswer]:
        """答案段 → 逐题答案；没有答案段返回空列表。"""
        ...
```

- [ ] **Step 4: 写 generic.py**

```python
"""通用策略：A–D 四项、无材料归属，仅供显式登记与显式继承。

禁止把它当「未登记学科的兜底」——get_strategy 不认未登记 code。
"""

from pathlib import Path

from question_splitter import is_main_stem, split_options
from subject_strategies.types import ExtractedAnswer, MaterialPolicy, NO_MATERIAL


class GenericStrategy:
    code = "generic"

    def is_stem(self, line: str) -> tuple[bool, int | None]:
        return is_main_stem(line)

    def split_options(self, content: str) -> tuple[str, list[dict] | None]:
        return split_options(content)

    def material_policy(self) -> MaterialPolicy:
        return NO_MATERIAL

    def extract_answers(self, text: str, md_path: Path) -> list[ExtractedAnswer]:
        # Task 6 之前先委托 subject_cases，避免一次性动两处
        from subject_cases.generic import extract_answers as generic_answers
        return generic_answers(text, md_path)
```

（注：`subject_cases` 到 Task 6 才删除；Task 1 先委托，避免一次性动两处。）

- [ ] **Step 5: 写 __init__.py（注册表）**

```python
"""学科策略注册表。

未登记学科抛 UnknownStrategyError —— 不允许静默回退到 generic。
各学科模块在 import 时调用 register()。
"""

from subject_strategies.types import QuestionStrategy, UnknownStrategyError

_STRATEGIES: dict[str, QuestionStrategy] = {}


def register(strategy: QuestionStrategy) -> None:
    """登记一个学科策略；重复登记同名 code 直接报错（避免 import 顺序决定行为）。"""
    if strategy.code in _STRATEGIES:
        raise ValueError(f"学科策略重复登记：{strategy.code}")
    _STRATEGIES[strategy.code] = strategy


def get_strategy(code: str | None) -> QuestionStrategy:
    """按学科 code 取策略；code 为空或未登记则抛 UnknownStrategyError。"""
    if not code:
        raise UnknownStrategyError("学科 code 为空，无法选择切题策略")
    strategy = _STRATEGIES.get(code)
    if strategy is None:
        raise UnknownStrategyError(
            f"学科 {code} 未实现切题策略；请在 src/subject_strategies/ 下实现并 register()"
        )
    return strategy


from subject_strategies.generic import GenericStrategy  # noqa: E402

register(GenericStrategy())
```

- [ ] **Step 6: 跑测试**

Run: `cd tools/data-refinery && python3 -m pytest tests/subject_strategies/test_registry.py -q`
Expected: `5 passed`

- [ ] **Step 7: 跑全量，确认没影响现有行为**

Run: `cd tools/data-refinery && python3 -m pytest tests -q`
Expected: `1304 passed, 10 skipped`（1299 + 5 新增）

- [ ] **Step 8: Commit**

```bash
git add tools/data-refinery/src/subject_strategies tools/data-refinery/tests/subject_strategies
git commit -m "feat(splitter): 学科策略注册表 + generic 策略（未登记学科报错）"
```

---

### Task 2: 内核接受策略对象（材料归属从布尔改成策略）

**Files:**
- Modify: `tools/data-refinery/src/question_splitter.py`（`split_page` 签名与 10 处 `attach_material`）
- Modify: `tools/data-refinery/src/question_extract.py:381-384`
- Modify: `tools/data-refinery/src/question_labeler.py`（`_render_content` 走策略）
- Modify: `tools/data-refinery/tests/test_question_splitter.py`（13 处调用签名）
- Modify: `tools/data-refinery/scripts/split_snapshot.py`（改用 strategy）

**Interfaces:**
- Consumes: `get_strategy(code)`（Task 1）
- Produces: `split_page(text: str, md_path: Path, strategy: QuestionStrategy | None = None) -> list[RawQuestion]`；`strategy=None` 等价于 `get_strategy("generic")`（仅作直接调用/测试的便利，入口层仍强制按学科取策略）

- [ ] **Step 1: 改 split_page 签名与材料分支**

`question_splitter.py:605` 起：

```python
def split_page(text: str, md_path: Path,
               strategy=None) -> list[RawQuestion]:
    """按题号切分试卷 MD 并对齐答案，返回 RawQuestion 列表。

    Args:
        strategy: 学科策略；None 时用 generic（A–D / 无材料归属）。
            入口 `extract_questions_file` 一定显式传 `get_strategy(subject_code)`，
            不会落到这个默认值上。
    """
    if strategy is None:
        from subject_strategies import get_strategy
        strategy = get_strategy("generic")
    policy = strategy.material_policy()
```

随后把函数体内 10 处 `attach_material` 全部换成 `policy.attach`：

| 行 | 原 | 改 |
|---|---|---|
| 704 | `if attach_material and part_kind is None:` | `if policy.attach and part_kind is None:` |
| 737 | `material_text=_material_for_new_stem() if attach_material else None,` | `material_text=_material_for_new_stem() if policy.attach else None,` |
| 749 | `if attach_material:` | `if policy.attach:` |
| 833 | `if attach_material and not in_answer_section:` | `if policy.attach and not in_answer_section:` |
| 835 | `... and _is_material_title(lines, i, line):` | `... and policy.is_material_title(lines, i, line):` |
| 912 | `material = _material_for_new_stem() if attach_material else None` | `material = _material_for_new_stem() if policy.attach else None` |
| 913 | `if attach_material and between_material:` | `if policy.attach and between_material:` |
| 934 | `if attach_material:` | `if policy.attach:` |
| 945 | `if (attach_material and current is not None and has_blank_before` | `if (policy.attach and current is not None and has_blank_before` |
| 946 | `and _looks_like_between_material(current.content, line)):` | `and policy.looks_like_between_material(current.content, line)):` |
| 958 | `if attach_material:` | `if policy.attach:` |
| 963 | `if attach_material and not scope_has_stem:` | `if policy.attach and not scope_has_stem:` |

本步**不删除** `_is_material_title` / `_looks_like_between_material` 两个函数（Task 3 搬走），只把调用点换成 policy。

- [ ] **Step 2: 给 generic 策略补上等价谓词（保证 Task 2 行为与现状一致）**

`generic.py` 的 `material_policy()` 仍返回 `NO_MATERIAL`（attach=False，谓词不会被调用）。
**注意**：本步语文行为的等价性来自"尚未有人在 attach=True 时调用 generic"，因此 Step 3 必须同时把 chinese 策略接上（见 Task 3）。

- [ ] **Step 3: 改 extract 调用点**

`question_extract.py:377-384`：

```python
    subject_code = _subject_code_for(rel_parts)
    strategy = get_strategy(subject_code)
    grade_band = _grade_band_for(filename)
    source_year = _source_year_for(filename)

    # 4. 题号切分 + 答案对齐（一次扫描）
    questions = split_page(text, md_path, strategy=strategy)
```

文件头加：`from subject_strategies import UnknownStrategyError, get_strategy  # noqa: F401`（`UnknownStrategyError` 供 Task 5 使用；本步只 import `get_strategy`）。

- [ ] **Step 4: 改 labeler 的选项渲染**

`question_labeler.py` 的 `_render_content(content, subject)`：把 `split_options(content, subject=subject or None)` 改成

```python
def _render_content(content: str, subject: str = "") -> str:
    from subject_strategies import get_strategy
    strategy = get_strategy(subject) if subject else None
    stem, opts = (strategy.split_options(content) if strategy
                  else split_options(content))
```

- [ ] **Step 5: 改 13 处测试调用**

```bash
cd tools/data-refinery
# 语文选项拆分（7 处）
grep -n 'subject="chinese"' tests/test_question_splitter.py
# 每处 split_options(x, subject="chinese")  ->  get_strategy("chinese").split_options(x)

# 语文材料归属（6 处）
grep -n "attach_material=True" tests/test_question_splitter.py
# 每处 split_page(t, p, attach_material=True)  ->  split_page(t, p, strategy=get_strategy("chinese"))
```

测试文件头加 `from subject_strategies import get_strategy`。

- [ ] **Step 6: 改快照脚本**

`scripts/split_snapshot.py` 的 `snapshot()` 里：

```python
        questions = split_page(
            path.read_text(encoding="utf-8"), path,
            strategy=get_strategy(code),
        )
```

并在 import 区加 `from subject_strategies import get_strategy`。

- [ ] **Step 7: 此时应立刻失败——chinese 还没登记**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_question_splitter.py -q`
Expected: FAIL，`UnknownStrategyError: 学科 chinese 未实现切题策略`
这是**预期的红灯**，Task 3 处理。

- [ ] **Step 8: 临时登记 chinese（直接复用现有实现，Task 3 再拆文件）**

新建 `src/subject_strategies/chinese.py`（本步最小实现，Task 3 替换）：

```python
"""语文策略（Task 2 临时版：直接复用内核现有语文分支）。"""

from pathlib import Path

from question_splitter import is_main_stem, split_options
from subject_cases.chinese import extract_answers as chinese_answers
from subject_strategies.types import ExtractedAnswer, MaterialPolicy


class ChineseMaterialPolicy(MaterialPolicy):
    # 不写 `attach = True` 类属性：MaterialPolicy 是 frozen dataclass，
    # attach 由构造参数决定，实例化时显式传 True。
    def is_material_title(self, lines, index, line):
        from question_splitter import _is_material_title
        return _is_material_title(lines, index, line)

    def looks_like_between_material(self, current_content, line):
        from question_splitter import _looks_like_between_material
        return _looks_like_between_material(current_content, line)


class ChineseStrategy:
    code = "chinese"

    def is_stem(self, line: str) -> tuple[bool, int | None]:
        return is_main_stem(line)

    def split_options(self, content: str) -> tuple[str, list[dict] | None]:
        return split_options(content, subject="chinese")

    def material_policy(self) -> MaterialPolicy:
        return ChineseMaterialPolicy(attach=True)

    def extract_answers(self, text: str, md_path: Path) -> list[ExtractedAnswer]:
        return chinese_answers(text, md_path)
```

`class ChineseMaterialPolicy(MaterialPolicy):` 里**不要**写 `attach = True` 类属性——`MaterialPolicy` 是 frozen dataclass，`attach` 由构造参数决定；实例化时显式传 `attach=True`。

`__init__.py` 末尾补：

```python
from subject_strategies.chinese import ChineseStrategy  # noqa: E402

register(ChineseStrategy())
```

- [ ] **Step 9: 跑切分测试与快照**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_question_splitter.py -q`
Expected: `87 passed`

Run: `cd tools/data-refinery && python3 scripts/split_snapshot.py --check`
Expected: `[ok] N 份快照零差异`

- [ ] **Step 10: 跑全量**

Run: `cd tools/data-refinery && python3 -m pytest tests -q`
Expected: 全绿（≥1304 passed）

- [ ] **Step 11: Commit**

```bash
git add -A tools/data-refinery
git commit -m "refactor(splitter): split_page 接策略对象，材料归属从布尔改为 policy"
```

---

### Task 3: 语文逻辑搬出内核，内核去学科化

**Files:**
- Modify: `tools/data-refinery/src/subject_strategies/chinese.py`（搬入语文选项/材料规则）
- Modify: `tools/data-refinery/src/question_splitter.py`（删语文分支，`split_options` 变纯 A–D）
- Test: `tools/data-refinery/tests/subject_strategies/test_chinese.py`
- Test: `tools/data-refinery/tests/test_no_subject_conditionals.py`

**Interfaces:**
- Consumes: Task 2 的 `split_page(text, md_path, strategy)`
- Produces: `ChineseStrategy.split_options(content)`（支持甲乙丙丁/①②③/3–6 项，label 归一 A–C，原标签存 `original_label`）；`ChineseMaterialPolicy`（真实实现，不再是转发）

- [ ] **Step 1: 写语文策略单测（先红）**

```python
"""语文策略：选项体系与材料归属。"""

from subject_strategies import get_strategy

S = get_strategy("chinese")


def test_split_options_cn_labels_three_items():
    content = "下列对文中语句理解最恰当的一项是\n甲. 春和景明\n乙. 波澜不惊\n丙. 上下天光"
    stem, opts = S.split_options(content)
    assert [o["label"] for o in opts] == ["A", "B", "C"]
    assert [o["original_label"] for o in opts] == ["甲", "乙", "丙"]
    assert "春和景明" in opts[0]["text"]


def test_split_options_circled_labels():
    content = "选出正确的一项\n① 甲句\n② 乙句\n③ 丙句"
    _, opts = S.split_options(content)
    assert [o["label"] for o in opts] == ["A", "B", "C"]


def test_split_options_gives_up_when_first_label_missing():
    """OCR 丢掉 A 的点号时不许重编号（会把 A/B 内容并进题干）。"""
    content = "题干\nA ①\nB. ②\nC. ③"
    stem, opts = S.split_options(content)
    assert opts is None
    assert stem == content


def test_material_policy_attaches():
    assert S.material_policy().attach is True
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd tools/data-refinery && python3 -m pytest tests/subject_strategies/test_chinese.py -q`
Expected: FAIL（`ChineseStrategy.split_options` 目前转发内核，甲乙丙丁用例不通过）

- [ ] **Step 3: 把语文选项实现搬进 chinese.py**

把 `question_splitter.py` 的以下块（约 236–340 行）整体剪切到 `subject_strategies/chinese.py`：
`_CN_OPTION_RES`、`_CIRCLED_OPTION_RE`、`_LATIN_FLEX_RE`、`_consecutive_run`、`_find_option_marks_cn`、`_split_by_marks`。

chinese.py 新实现：

```python
class ChineseStrategy:
    code = "chinese"

    def is_stem(self, line: str) -> tuple[bool, int | None]:
        return is_main_stem(line)

    def split_options(self, content: str) -> tuple[str, list[dict] | None]:
        """语文：甲乙丙丁 / ①②③④ / A–F，允许 2–6 项，label 归一为 A/B/C…。"""
        marks = _find_option_marks_cn(content)
        if marks and marks[0][2] in "甲乙丙丁①②③④":
            if not _CHOICE_STEM_RE.search(content[: marks[0][0]]):
                marks = None
        if marks:
            result = _split_by_marks(content, marks)
            if result is not None:
                return result
        return split_options_abcd(content)
```

`_CHOICE_STEM_RE` 一并从内核搬到 chinese.py。

- [ ] **Step 4: 把材料归属实现搬进 chinese.py**

把 `_is_material_title`（约 579–602 行）与 `_looks_like_between_material`（约 564–577 行）整体搬进 `ChineseMaterialPolicy`，方法体里的 `split_options(current_content, subject="chinese")` 改成 `self._split_options(current_content)`——即调用 `ChineseStrategy().split_options`。为避免每次新建策略，模块级放一个 `_STRATEGY = ChineseStrategy()`，policy 持有它。

- [ ] **Step 5: 内核去掉语文分支**

`question_splitter.py`：

1. 删除 `_CN_OPTION_RES`、`_CIRCLED_OPTION_RE`、`_LATIN_FLEX_RE`、`_consecutive_run`、`_find_option_marks_cn`、`_split_by_marks`、`_is_material_title`、`_looks_like_between_material`、`_CHOICE_STEM_RE`。
2. 函数签名去掉 `subject` 参数，并删掉函数体开头那一段 `if subject == "chinese":`（从该行起、到 `marks = _find_option_marks(content)` 之前的所有行）：

```python
def split_options(content: str) -> tuple[str, list[dict] | None]:
    """通用 A–D 拆分（所有走 generic 的学科共用；语文走 ChineseStrategy）。

    必须找到连续 A,B,C,D 四个标记；找不到返回 (原 content, None)。
    原 docstring 里关于「语文 3-6 项」的段落一并删掉。
    """
    marks = _find_option_marks(content)
    # ... 以下函数体原样保留，不再包含任何 chinese 分支
```

3. `chinese.py` 从内核 import：`from question_splitter import is_main_stem, split_options as split_options_abcd`。

- [ ] **Step 6: 加去学科化守卫测试**

```python
"""内核不得残留学科判断（学科差异必须在 subject_strategies/ 里）。"""

import re
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src" / "question_splitter.py"


def test_core_has_no_subject_conditionals():
    code = SRC.read_text(encoding="utf-8")
    # 去掉行注释后再找，允许注释里解释策略机制
    executable = "\n".join(
        line for line in code.splitlines() if not line.lstrip().startswith("#")
    )
    assert 'subject ==' not in executable
    assert '"chinese"' not in executable
```

- [ ] **Step 7: 跑切分测试 + 快照 + 全量**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_question_splitter.py tests/subject_strategies tests/test_no_subject_conditionals.py -q`
Expected: 全绿（87 + 新增）

Run: `cd tools/data-refinery && python3 scripts/split_snapshot.py --check`
Expected: `[ok] N 份快照零差异` —— **任何差异都必须解释清楚才能继续**

- [ ] **Step 8: Commit**

```bash
git add -A tools/data-refinery
git commit -m "refactor(splitter): 语文选项/材料逻辑搬入 ChineseStrategy，内核去学科化"
```

---

### Task 4: 数学 / 物理 / 化学显式登记

**Files:**
- Create: `tools/data-refinery/src/subject_strategies/math.py`
- Create: `tools/data-refinery/src/subject_strategies/physics.py`
- Create: `tools/data-refinery/src/subject_strategies/chemistry.py`
- Modify: `tools/data-refinery/src/subject_strategies/__init__.py`
- Test: `tools/data-refinery/tests/subject_strategies/test_natural_sciences.py`

**Interfaces:**
- Consumes: `GenericStrategy` 的行为（A–D、无材料）
- Produces: `MathStrategy` / `PhysicsStrategy` / `ChemistryStrategy`，各自 `code` 为 `"math"` / `"physics"` / `"chemistry"`，`material_policy()` 返回 `NO_MATERIAL`

- [ ] **Step 1: 写测试（先红）**

```python
"""数学/物理/化学：显式登记，行为与 generic 一致（图选项走 A–D 同一套规则）。"""

import pytest

from subject_strategies import get_strategy
from subject_strategies.types import NO_MATERIAL


@pytest.mark.parametrize("code", ["math", "physics", "chemistry"])
def test_registered_with_own_code(code):
    s = get_strategy(code)
    assert s.code == code
    assert s.material_policy() == NO_MATERIAL


@pytest.mark.parametrize("code", ["math", "physics", "chemistry"])
def test_split_options_abcd(code):
    content = "下列说法正确的是\nA. 甲\nB. 乙\nC. 丙\nD. 丁"
    stem, opts = get_strategy(code).split_options(content)
    assert [o["label"] for o in opts] == ["A", "B", "C", "D"]
    assert "下列说法正确的是" in stem


def test_physics_sub_question_is_not_a_stem():
    """物理实验题 '21.（1）…' 里的小问号不算主题号。"""
    assert get_strategy("physics").is_stem("21.（1）如图甲所示")[0] is True
    assert get_strategy("physics").is_stem("（1）如图甲所示")[0] is False
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd tools/data-refinery && python3 -m pytest tests/subject_strategies/test_natural_sciences.py -q`
Expected: FAIL，`UnknownStrategyError: 学科 math 未实现切题策略`

- [ ] **Step 3: 给 generic.py 加一个可复用的默认基类**

```python
class NaturalScienceStrategy:
    """数学/物理/化学的默认行为：A–D 四项、无材料归属。

    各科文件继承本类并指定 `code` 与 `answers` —— 学科差异写在子类里，
    没有差异就只声明归属，不复制逻辑。
    """

    code: str = ""
    answers = staticmethod(lambda text, md_path: [])

    def is_stem(self, line: str) -> tuple[bool, int | None]:
        return is_main_stem(line)

    def split_options(self, content: str) -> tuple[str, list[dict] | None]:
        return split_options(content)

    def material_policy(self) -> MaterialPolicy:
        return NO_MATERIAL

    def extract_answers(self, text: str, md_path: Path) -> list[ExtractedAnswer]:
        return self.answers(text, md_path)
```

- [ ] **Step 4: 写三个学科文件（完整代码，勿用「同上」省略）**

`src/subject_strategies/math.py`：

```python
"""数学策略：A–D 四项、无材料归属。"""

from subject_cases.generic import math_answers
from subject_strategies.generic import NaturalScienceStrategy


class MathStrategy(NaturalScienceStrategy):
    code = "math"
    answers = staticmethod(math_answers)
```

`src/subject_strategies/physics.py`：

```python
"""物理策略：A–D 四项、图选项与数学共用规则、无材料归属。

图选项（字母标在图下方，MinerU 线性化为「图\\nA\\n图\\nB」）由 split_options 的
「标记在内容上方」分支处理 —— 规则共用，但归属在本文件：物理图选项出问题只改这里。
物理卷目前没有参考答案段（39 张上学期卷实测 0 命中），走 generic 的「无答案」路径。
"""

from subject_cases.generic import physics_answers
from subject_strategies.generic import NaturalScienceStrategy


class PhysicsStrategy(NaturalScienceStrategy):
    code = "physics"
    answers = staticmethod(physics_answers)
```

`src/subject_strategies/chemistry.py`：

```python
"""化学策略：A–D 四项、无材料归属；答案段走 generic（表格/逐题）。"""

from subject_cases.generic import chemistry_answers
from subject_strategies.generic import NaturalScienceStrategy


class ChemistryStrategy(NaturalScienceStrategy):
    code = "chemistry"
    answers = staticmethod(chemistry_answers)
```

- [ ] **Step 5: 注册**

`__init__.py` 末尾追加：

```python
from subject_strategies.math import MathStrategy  # noqa: E402
from subject_strategies.physics import PhysicsStrategy  # noqa: E402
from subject_strategies.chemistry import ChemistryStrategy  # noqa: E402

register(MathStrategy())
register(PhysicsStrategy())
register(ChemistryStrategy())
```

- [ ] **Step 6: 跑测试 + 快照 + 全量**

Run: `cd tools/data-refinery && python3 -m pytest tests/subject_strategies -q && python3 scripts/split_snapshot.py --check`
Expected: 全绿 + 零差异

- [ ] **Step 7: Commit**

```bash
git add -A tools/data-refinery
git commit -m "feat(splitter): 数学/物理/化学显式登记切题策略"
```

---

### Task 5: 英语策略（补上材料归属缺口）+ 未登记学科硬报错

**Files:**
- Create: `tools/data-refinery/src/subject_strategies/english.py`
- Modify: `tools/data-refinery/src/subject_strategies/__init__.py`
- Modify: `tools/data-refinery/src/question_extract.py:25-27`（`_subject_code_for` 改成 default=None）
- Test: `tools/data-refinery/tests/subject_strategies/test_english.py`
- Test: `tools/data-refinery/tests/subject_strategies/fixtures/english_paper.md`

**Interfaces:**
- Consumes: `MaterialPolicy` 的两个谓词（内核在 `attach=True` 时调用）
- Produces: `EnglishStrategy`（`code="english"`、`material_policy().attach is True`）；`_subject_code_for` 返回 `str | None`

**为什么英语要单独实现材料归属**（2026-10-30 实测）：同一大题内出现第二篇短文时，语文规则会把第一篇反复挂给后续题 —— 下面这份 fixture 用现状代码跑出来，题 2 拿到的 `material_text` 是 **A 篇**（不是 B 篇）。原因是篇章标签 `A` / `B` 是单个字母，被语文的 `_is_material_title` 判成"不像标题"（含字母直接排除）。把 `is_material_title` 换成下面 Step 4 的实现后，实测题 1 拿到 A 篇、题 2 拿到 B 篇。

- [ ] **Step 1: 写英语样例 md（测试 fixture）**

`tests/subject_strategies/fixtures/english_paper.md`：

```markdown
# 英语试卷

## 一、阅读理解

A

Many students find it hard to keep a reading habit. Here are three tips for you.

1. What is the passage mainly about?
A. How to choose books
B. How to keep a reading habit
C. Why reading is boring
D. When to read

B

A healthy diet matters more than you think, and doctors keep saying so.

2. What does the writer suggest?
A. Eating less
B. Sleeping more
C. A balanced diet
D. Doing exercise
```

- [ ] **Step 2: 写测试（先红）**

```python
"""英语策略：A–D 四项 + 阅读理解短文按篇挂到题上。"""

from pathlib import Path

from subject_strategies import get_strategy

FIXTURE = Path(__file__).parent / "fixtures" / "english_paper.md"


def test_english_registered_with_material_attach():
    s = get_strategy("english")
    assert s.code == "english"
    assert s.material_policy().attach is True


def test_split_options_abcd():
    stem, opts = get_strategy("english").split_options(
        "1. What is it?\nA. a\nB. b\nC. c\nD. d")
    assert [o["label"] for o in opts] == ["A", "B", "C", "D"]


def test_each_reading_passage_attached_to_its_own_question():
    """同一大题内两篇短文必须各归各的题，不能把 A 篇反复挂给题 2。"""
    from question_splitter import split_page

    questions = split_page(
        FIXTURE.read_text(encoding="utf-8"), FIXTURE,
        strategy=get_strategy("english"),
    )

    assert [q.group_order for q in questions] == [1, 2]
    assert "three tips" in (questions[0].material_text or "")
    assert "healthy diet" in (questions[1].material_text or "")
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd tools/data-refinery && python3 -m pytest tests/subject_strategies/test_english.py -q`
Expected: FAIL，`UnknownStrategyError: 学科 english 未实现切题策略`

- [ ] **Step 4: 写 english.py**

```python
"""英语策略：A–D 四项；阅读理解短文/完形语篇在题号之前，必须挂到题上。

2026-10-30 之前 `attach_material` 只对语文打开，英语阅读理解的短文
根本不会进入 material_text —— 题只剩「What is the passage mainly about?」。
打开后又发现语文的篇章标题判定不认 `A` / `B` 这种单字母标签，
同一大题的第二篇短文会被漏掉、学生拿到的仍是上一篇。
"""

from pathlib import Path

from question_splitter import is_main_stem, split_options
from subject_cases.generic import english_answers
from subject_strategies.types import ExtractedAnswer, MaterialPolicy

_PASSAGE_LABELS = {"A", "B", "C", "D", "E"}


class EnglishMaterialPolicy(MaterialPolicy):
    def is_material_title(self, lines, index, line):
        """篇章标签（单独一行的 A/B/C/D 或「第一篇」）后紧跟长段落 → 换材料。"""
        text = line.strip()
        if not text:
            return False
        is_label = text in _PASSAGE_LABELS or (
            2 <= len(text) <= 8 and text.startswith("第") and text.endswith("篇"))
        if not is_label:
            return False
        for j in range(index + 1, min(index + 4, len(lines))):
            nxt = lines[j].strip()
            if not nxt:
                continue
            return len(nxt) >= 30 and not is_main_stem(nxt)[0]
        return False

    def looks_like_between_material(self, current_content, line):
        """上一题 A–D 选项已完整时的长段落，归下一题。"""
        text = line.strip()
        if len(text) < 40 or text.startswith(("#", "![", "<table")):
            return False
        _, opts = split_options(current_content)
        return bool(opts) and len(opts) >= 3


class EnglishStrategy:
    code = "english"

    def is_stem(self, line: str) -> tuple[bool, int | None]:
        return is_main_stem(line)

    def split_options(self, content: str) -> tuple[str, list[dict] | None]:
        return split_options(content)

    def material_policy(self) -> MaterialPolicy:
        return EnglishMaterialPolicy(attach=True)

    def extract_answers(self, text: str, md_path: Path) -> list[ExtractedAnswer]:
        return english_answers(text, md_path)
```

- [ ] **Step 5: 注册英语**

`__init__.py` 末尾追加：

```python
from subject_strategies.english import EnglishStrategy  # noqa: E402

register(EnglishStrategy())
```

- [ ] **Step 6: 跑英语测试**

Run: `cd tools/data-refinery && python3 -m pytest tests/subject_strategies/test_english.py -q`
Expected: `3 passed`

> 若 `test_each_reading_passage_attached_to_its_own_question` 仍失败，说明内核 `has_blank_before` 条件没被满足（fixture 里标签前必须有空行），先确认 fixture 与内核对齐，再改 policy —— 不要在 policy 里加 `print` 糊过去。

- [ ] **Step 7: 把「未知学科」从静默默认改成报错**

`question_extract.py:25-27`：

```python
def _subject_code_for(rel_parts: tuple[str, ...]) -> str | None:
    """从文件相对路径首段（中文学科名）推导 subject code。

    识别不出时返回 None（而不是默认数学）——`get_strategy(None)` 会抛
    UnknownStrategyError，让「目录名写错/新学科没登记」立刻暴露，
    而不是被静默当成数学题处理。
    """
    return subject_code_for_parts(rel_parts, default=None)
```

`subject_codes.subject_code_for_parts` 的参数标注改成 `default: str | None = DEFAULT_SUBJECT_CODE`（函数体不变）。

- [ ] **Step 8: 补一条未登记学科的端到端测试**

`tests/subject_strategies/test_registry.py` 追加：

```python
def test_unknown_subject_dir_is_not_silently_math():
    from question_extract import _subject_code_for

    assert _subject_code_for(("科学", "初中", "first")) is None
    assert _subject_code_for(("物理", "初中", "first")) == "physics"
```

- [ ] **Step 9: 跑全量 + 快照**

Run: `cd tools/data-refinery && python3 -m pytest tests -q && python3 scripts/split_snapshot.py --check`
Expected: 全绿 + 零差异（快照脚本显式传 `default="math"`，不受 Step 7 影响）

- [ ] **Step 10: Commit**

```bash
git add -A tools/data-refinery
git commit -m "feat(splitter): 英语策略（按篇归属材料）+ 未登记学科改为报错"
```

---

### Task 6: 合并 subject_cases（答案提取走同一入口）

**Files:**
- Modify: `tools/data-refinery/src/subject_strategies/chinese.py`（搬入 `subject_cases/chinese.py` 的算法）
- Modify: `tools/data-refinery/src/subject_strategies/generic.py`（搬入 `subject_cases/generic.py` 的算法）
- Modify: `tools/data-refinery/src/answer_backfill.py:21`
- Modify: `tools/data-refinery/src/answer_extract_cli.py:24`
- Delete: `tools/data-refinery/src/subject_cases/`（`__init__.py` / `chinese.py` / `generic.py` / `__pycache__`）
- Modify: `tools/data-refinery/tests/test_answer_backfill.py:8`、`tests/test_answer_extract_cli.py:7`、`tests/test_subject_cases_chinese.py`（改 import 或删除后并入 `test_chinese.py`）

**Interfaces:**
- Consumes: `get_strategy(code).extract_answers(text, md_path)`（Task 2–5 已就位，目前委托给 subject_cases）
- Produces: 同样的 `extract_answers` 签名，但实现落在策略文件内；`UnknownSubjectError` 统一改名 `UnknownStrategyError`；`detect_subject` 由 `subject_codes.subject_code_for_path` 取代

- [ ] **Step 1: 把两份答案实现搬进策略文件**

- `subject_cases/chinese.py` 的全部函数（`extract_answers` 及其私有依赖）原样移动到 `subject_strategies/chinese.py`，`ChineseStrategy.extract_answers` 直接调用它。
- `subject_cases/generic.py` 同理移到 `subject_strategies/generic.py`。
- `ExtractedAnswer` 从 `subject_cases` 改为 import 自 `subject_strategies.types`。

- [ ] **Step 2: 改两个调用方**

`answer_backfill.py`：

```python
from subject_strategies import UnknownStrategyError, get_strategy
from subject_codes import subject_code_for_path
```

原来 `get_case(subject)` → `get_strategy(subject).extract_answers`；`detect_subject(rel_path)` → `subject_code_for_path(rel_path)`。

`answer_extract_cli.py` 同样替换。

- [ ] **Step 3: 删包并改测试 import**

```bash
cd tools/data-refinery
git rm -r src/subject_cases
# tests 里 subject_cases 的 import 全部换成 subject_strategies / subject_strategies.types
grep -rn "subject_cases" src tests
```

`tests/test_subject_cases_chinese.py` 更名为 `tests/subject_strategies/test_chinese_answers.py`，import 改成：

```python
from subject_strategies import UnknownStrategyError, get_strategy
from subject_strategies.types import ExtractedAnswer
```

断言里的 `chinese.extract_answers(...)` → `get_strategy("chinese").extract_answers(...)`；`get_case("chinese")` 的断言删掉（注册表测试已覆盖）。

- [ ] **Step 4: 跑答案相关测试**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_answer_backfill.py tests/test_answer_extract_cli.py tests/subject_strategies -q`
Expected: 全绿

- [ ] **Step 5: 跑全量 + 快照**

Run: `cd tools/data-refinery && python3 -m pytest tests -q && python3 scripts/split_snapshot.py --check`
Expected: 全绿 + 零差异

- [ ] **Step 6: Commit**

```bash
git add -A tools/data-refinery
git commit -m "refactor(splitter): subject_cases 并入 subject_strategies，答案提取走同一入口"
```

---

### Task 7: 物理端到端回归 + 文档

**Files:**
- Modify: `docs/data-refinery-管线总结与后续.md`（新增「学科策略」小节）
- Modify: `docs/ai-core-changelog.md`（顶部加 2026-10-30 条目）
- Modify: `tools/data-refinery/README.md`（若存在切题章节则补一句入口变化）

**Interfaces:**
- Consumes: 全部前置任务
- Produces: 无代码接口；产出「重构前后物理卷抽取结果一致」的证据

- [ ] **Step 1: 用重构后的代码重跑四中卷（不改 checkpoint 之外的产物）**

```bash
cd tools/data-refinery
rm -f output/extracted/物理/初中/first/2024/物理-初三(上)-202407-西城·北京四中-（上）期中-试卷/*.jsonl
python3 src/extract_cli.py --subject 物理 --file "西城·北京四中" --reconvert 2>&1 | tail -5
```

Expected: `-> 35 items (questions)`，题号 1–35 连续

- [ ] **Step 2: 逐题比对题干哈希与重构前基线**

```bash
cd tools/data-refinery && python3 - <<'PY'
import hashlib, json
p = "output/extracted/物理/初中/first/2024/物理-初三(上)-202407-西城·北京四中-（上）期中-试卷/物理-初三(上)-202407-西城·北京四中-（上）期中-试卷.jsonl"
rows = [json.loads(l) for l in open(p)]
nums = [r["group_order"] for r in rows]
print("题数", len(rows), "题号连续", nums == list(range(1, 36)))
snap = json.load(open("tests/fixtures/split_snapshot.json"))
rel = "物理/初中/first/2024/物理-初三(上)-202407-西城·北京四中-（上）期中-试卷/物理-初三(上)-202407-西城·北京四中-（上）期中-试卷.md"
entry = snap.get(rel)
if entry is None:
    print(f"该卷不在抽样快照里，需手工前后比对：{rel}")
else:
    # 物理卷没有材料归属，只比对题号与题干哈希（基线条目另有 mat/gid/score）
    base = [{k: it[k] for k in ("no", "hash")} for it in entry["items"]]
    now = [{"no": r["group_order"],
            "hash": hashlib.sha1(r["content"].encode()).hexdigest()[:12]} for r in rows]
    diff = [i for i, (a, b) in enumerate(zip(now, base)) if a != b]
    print("与基线不同的题:", diff or "无")
PY
```

Expected: `题数 35 题号连续 True`、`与基线不同的题: 无`

> 若该卷不在抽样快照里，先手工跑 `--file` 前后两次并保存 JSONL 做 diff，结论相同才算通过。

- [ ] **Step 3: 写管线文档小节**

在 `docs/data-refinery-管线总结与后续.md` 的「知识点（KP）标定」节后插入：

```markdown
### 学科策略（切题 / 选项 / 材料 / 答案，2026-10-30）

四件事各科一份实现，位于 `tools/data-refinery/src/subject_strategies/`：

| 钩子 | 说明 |
|---|---|
| `is_stem(line)` | 该行是否主题号（语文全角句点、英语篇章标签、数学小问号等差异都写在这里） |
| `split_options(content)` | 题干/选项拆分（语文 3–6 项甲乙丙丁；其余 A–D 四项） |
| `material_policy()` | 题号前的短文是否挂到题上（语文/英语 true，其余 false） |
| `extract_answers(text, md_path)` | 答案段提取（原 `subject_cases`，已并入） |

- `get_strategy(code)` 未登记学科**直接抛 `UnknownStrategyError`**，不回退 generic；
  `_subject_code_for` 识别不出学科目录时返回 `None`，同样报错。
- 内核 `question_splitter.py` 只保留与学科无关的扫描（行内粘连、日期陷阱、OCR 错认纠正），
  回归判据：`grep -n '"chinese"' src/question_splitter.py` 无命中。
- 行为回归靠 `scripts/split_snapshot.py --check`（`tests/fixtures/split_snapshot.json`，
  每科至多 8 份试卷抽样，逐题记录题号 / 题干哈希 / 材料哈希 / 大题分组 / 分值），
  重构任何一步都必须零差异。
```

- [ ] **Step 4: 写 changelog**

`docs/ai-core-changelog.md` 顶部加：

```markdown
## 2026-10-30 · 切题/选项/答案改为按学科显式实现

**动因**：用户指出各学科差异大、提示词也不同，不该把学科逻辑埋在 972 行的公共切分器里。核查后确认：提示词与答案提取**已经**分科，缺口在题号切分与选项拆分（4 处 `if subject == "chinese"`），且英语材料归属从未打开。

**改动**：新增 `src/subject_strategies/`（每科一份 `is_stem / split_options / material_policy / extract_answers`），`get_strategy` 未登记即报错；`subject_cases/` 并入后删除；`split_page` 由 `attach_material: bool` 改为接收策略对象。

**回归**：87 例切分测试断言未改（仅改签名）+ 每科 8 份抽样的黄金快照零差异；四中物理卷重跑 35 题、题干哈希与重构前一致。英语阅读理解短文开始进入 `material_text`（此前为空）。
```

- [ ] **Step 5: 最终全量回归**

Run: `cd tools/data-refinery && python3 -m pytest tests -q && python3 scripts/split_snapshot.py --check`
Expected: 全绿 + 零差异

- [ ] **Step 6: Commit**

```bash
git add -A docs tools/data-refinery
git commit -m "docs: 学科策略机制说明 + 2026-10-30 变更记录"
```

---

## 附：与本次重构无关、但阻塞物理入库的两件事（不在本计划范围）

1. 物理 39 张上学期卷无参考答案 → 35 题 `answer=''`，进池后无法判分。
2. 知识点树缺「导体与绝缘体」，题 2 被勉强挂到 P1003。
