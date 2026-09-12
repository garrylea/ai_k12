# 爬虫入口合并 + 学期判定修正 + 年级过滤 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `tools/crawler` 的两个 CLI 入口（`src/main.py` + `src/cli.py`）合并为唯一的 `src/crawler_cli.py`，并在其上修正学期判定（不再靠考试类型硬猜）、修正区县解析、新增 zgkao 年级过滤。

**Architecture:** 学期判定收敛为 `classifier.py` 的纯函数 `resolve_semester()`（无副作用，易测）+ `SemesterResolver`（缓存 + 询问回调，可注入 stub）。`ZgkaoAdapter` 注入 resolver，在落盘前解析学期；判不出时交互模式询问用户、非交互模式跳过并警告。区县解析在 `parser.py` 内修正。CLI 合并后 zgkao 与 smartedu 共用 `--site` 分发，两站各自声明支持的过滤维度。

**Tech Stack:** Python 3.10+（PEP 604 联合类型）、argparse、BeautifulSoup、pytest（~200 个测试）、requests、pypdf。

**Spec:** `docs/superpowers/specs/2026-09-12-crawler-entry-merge-and-semester-classification-design.md`

## Global Constraints

- 唯一入口：`python src/crawler_cli.py --site <zgkao|smartedu> [options]`；删除 `src/main.py`、`src/cli.py`
- **不新增 `--semester` 参数**（学期由程序识别，判不出才询问）
- 学期判定优先级：① 表头 `exam_type` 的（上）/（下）标记 → ② PDF 文件名/标题的标记 → ③ 一模/二模/三模 → `second` → ④ 文件名月份 → ⑤ 无法判定返回 `None`
- 标记只接受 `（上）` / `(上)` / `上学期` / `第一学期`（「下」同理）；**不匹配裸「上/下」字**（避免「上海」误伤）
- 月份映射：`9、10、11、12、1` 月 → `first`；`3、4、5、6、7` 月 → `second`；`2、8` 月不判（继续走 ⑤）
- **两层学期缓存**：文件级 `key`（试卷详情页 URL）只复用**自动推断**结果——保证同一份试卷的「试卷/答案」同学期，但不跨试卷传播推断值；组级 `group` = `(年级, 考试类型, 年份)` 只在**用户亲自回答后**写入并整组复用，同组只询问一次
- `--dry-run` 不询问、不报错；非交互（stdin 非 TTY）判不出 → 跳过该文件 + 逐条警告 + 运行结束非零退出
- 区县解析：中间片段含「学年」→ 取「学年」之后；为空则回退到年份之前的前缀；**最后去掉末尾的「区」**（统一 `海淀区` / `海淀` 两种站点写法，否则精确匹配的 `--district 海淀` 会漏掉带「学年」的那批）
- zgkao `--grade` 取值用站点原生写法：`初一` / `初二` / `初三` / `高一` / `高二` / `高三`（smartedu 仍为 `九年级` 等）
- 所有命令在 `tools/crawler/` 下执行；测试命令 `pytest`
- 提交信息用 Conventional Commits，scope 用 `crawler`

---

### Task 1: 修正区县解析（parser）

**Files:**
- Modify: `tools/crawler/src/parser.py:112-121`（`_parse_header`）
- Test: `tools/crawler/tests/adapters/test_zgkao_parser.py`（在 `TestIndexParser` 后新增类）

**Interfaces:**
- Consumes: 现有 `_GRADE_PATTERN`（`tools/crawler/src/parser.py:15`）
- Produces: `IndexParser._extract_district(text: str, match: re.Match) -> str`；`PaperItem.district` 取值修正

- [ ] **Step 1: 写失败测试**

在 `tools/crawler/tests/adapters/test_zgkao_parser.py` 末尾追加：

```python
class TestParseHeaderDistrict:
    def test_district_before_academic_year_range(self):
        # 海淀区2024-2025学年初三（上）期末考试卷和答案汇总
        header = "海淀区2024-2025学年初三（上）期末考试卷和答案汇总"
        info = IndexParser._parse_header(header)
        assert info["district"] == "海淀"
        assert info["grade"] == "初三"
        assert info["exam_type"] == "（上）期末考"

    def test_district_after_academic_year_range(self):
        header = "2025-2026学年海淀区初二期末试卷&答案汇总"
        info = IndexParser._parse_header(header)
        assert info["district"] == "海淀"
        assert info["grade"] == "初二"
        assert info["exam_type"] == "期末"

    def test_district_after_academic_year_range_with_city_prefix(self):
        header = "2025-2026学年北京海淀区初一期末试卷&答案汇总"
        info = IndexParser._parse_header(header)
        assert info["district"] == "北京海淀"

    def test_district_without_academic_year_range_unchanged(self):
        header = "2026海淀初三二模试卷&答案"
        info = IndexParser._parse_header(header)
        assert info["district"] == "海淀"

    def test_district_strips_semester_marker_after_academic_year(self):
        header = "2025-2026学年（上）海淀区初二期末试卷&答案汇总"
        info = IndexParser._parse_header(header)
        assert info["district"] == "海淀"

    def test_district_trailing_qu_stripped_for_both_spellings(self):
        """带「区」与不带「区」的表头必须落到同一个区县值（精确匹配的 --district 才能命中）。"""
        with_qu = IndexParser._parse_header("海淀区2024-2025学年初三（上）期末考试卷和答案汇总")
        without_qu = IndexParser._parse_header("2026海淀初三二模试卷&答案")
        assert with_qu["district"] == without_qu["district"] == "海淀"
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd tools/crawler && pytest tests/adapters/test_zgkao_parser.py::TestParseHeaderDistrict -v`
Expected: 前两个用例 FAIL（实际得到 `-2025学年` / `-2026学年海淀区`）；`test_district_without_academic_year_range_unchanged` PASS

- [ ] **Step 3: 实现**

把 `tools/crawler/src/parser.py` 的 `_parse_header` 替换为：

```python
    @staticmethod
    def _parse_header(text: str) -> dict | None:
        match = _GRADE_PATTERN.search(text)
        if not match:
            return None
        return {
            "district": IndexParser._extract_district(text, match),
            "grade": match.group(3),
            "exam_type": match.group(4),
        }

    @staticmethod
    def _extract_district(text: str, match) -> str:
        """从表头取区县。

        表头有两种形态：
        - 区县在前：`海淀区2024-2025学年初三（上）期末...` → 学年之后为空，回退到年份前缀
        - 学年在前：`2025-2026学年海淀区初二期末...` → 区县在「学年」之后
        最后统一去掉末尾「区」，让 `海淀区` 与 `海淀` 两种站点写法落到同一个值
        （`--district` 与文件名都是精确匹配，不统一会漏匹配）。
        """
        mid = match.group(2).strip()
        if "学年" not in mid:
            return IndexParser._strip_trailing_qu(mid)
        district = mid.split("学年", 1)[1].strip()
        if not district:
            district = text[: match.start(1)].strip()
        district = re.sub(r"^[（(][^）)]*[）)]", "", district).strip()
        return IndexParser._strip_trailing_qu(district)

    @staticmethod
    def _strip_trailing_qu(district: str) -> str:
        return district[:-1] if district.endswith("区") else district
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd tools/crawler && pytest tests/adapters/test_zgkao_parser.py -v`
Expected: 全部 PASS（含原有 `test_extracts_district_from_header` 等）

- [ ] **Step 5: 提交**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
git add tools/crawler/src/parser.py tools/crawler/tests/adapters/test_zgkao_parser.py
git commit -m "fix(crawler): 修正 zgkao 索引页区县解析，学年不再被当区县"
```

---

### Task 2: 学期判定纯函数 `resolve_semester`

**Files:**
- Modify: `tools/crawler/src/classifier.py`（顶部 import 区 + 文件末尾新增函数）
- Test: `tools/crawler/tests/adapters/test_zgkao_classifier.py`（末尾新增类）

**Interfaces:**
- Consumes: `Classifier.normalize_exam_type()`（`tools/crawler/src/classifier.py:57-59`）
- Produces:
  - `_SIMULATION_EXAM_TYPES: set[str]` = `{"模拟一", "模拟二", "模拟三"}`（规范化后的写法；判定时对入参调用 `normalize_exam_type`，因此原始写法 `二模` 与规范化写法 `模拟二` 都能命中）
  - `_FIRST_SEMESTER_MONTHS: set[int]`、`_SECOND_SEMESTER_MONTHS: set[int]`
  - `resolve_semester(exam_type: str, title: str = "", filename: str = "") -> str | None`（返回 `"first"` / `"second"` / `None`）

- [ ] **Step 1: 写失败测试**

在 `tools/crawler/tests/adapters/test_zgkao_classifier.py` 末尾追加（并把首行 import 改为 `from classifier import Classification, Classifier, resolve_semester`）：

```python
class TestResolveSemester:
    @pytest.mark.parametrize("exam_type,filename,expected", [
        # ① 表头标记优先
        ("（上）期末考", "", "first"),
        ("（下）期末考", "", "second"),
        ("上学期期末", "", "first"),
        ("第二学期期末", "", "second"),
        # ② 文件名标记
        ("期末", "2025北京海淀初二（上）期末数学.pdf", "first"),
        ("期末", "2026北京海淀初一(下)期末数学.pdf", "second"),
        # ③ 模拟考约定
        ("二模", "2026北京海淀初三二模数学 无答案.pdf", "second"),
        ("一模", "", "second"),
        ("三模", "", "second"),
        ("模拟二", "2026北京海淀初三二模数学.pdf", "second"),      # 规范化写法也要认
        ("二模", "2026.09海淀初三二模数学.pdf", "second"),         # ③ 优先于 ④ 月份
        # ④ 文件名月份
        ("期末", "2026.01海淀区初三期末数学.pdf", "first"),
        ("期末", "202507海淀初三期末数学.pdf", "second"),
        # ⑤ 判不出
        ("月考", "", None),
        ("期中", "", None),
        ("期末", "", None),
        ("期末", "2026.02海淀初三期末数学.pdf", None),   # 2 月跨学期
        ("期末", "2026.08海淀初三期末数学.pdf", None),   # 8 月跨学期
        ("期末", "2025北京海淀初三期末数学.pdf", None),  # 年份不能被当成月份
    ])
    def test_resolve_semester(self, exam_type, filename, expected):
        assert resolve_semester(exam_type, filename=filename) == expected

    def test_exam_type_marker_beats_filename_month(self):
        assert resolve_semester("（上）期末考", filename="202506海淀初三期末.pdf") == "first"

    def test_title_marker_used_when_header_and_filename_have_none(self):
        assert resolve_semester("月考", title="2025海淀初三（下）月考数学.pdf") == "second"

    def test_bare_up_char_is_not_a_marker(self):
        # 「上海」不应被当成「上」学期
        assert resolve_semester("期末", filename="2025上海初三期末数学.pdf") is None
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd tools/crawler && pytest tests/adapters/test_zgkao_classifier.py::TestResolveSemester -v`
Expected: FAIL，`ImportError: cannot import name 'resolve_semester'`

- [ ] **Step 3: 实现**

在 `tools/crawler/src/classifier.py` 顶部把 `import` 区改为：

```python
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional
```

在文件末尾追加：

```python
_SIMULATION_EXAM_TYPES = {"模拟一", "模拟二", "模拟三"}

_FIRST_SEMESTER_MONTHS = {9, 10, 11, 12, 1}
_SECOND_SEMESTER_MONTHS = {3, 4, 5, 6, 7}

_UP_MARKERS = ("（上）", "(上)", "上学期", "第一学期")
_DOWN_MARKERS = ("（下）", "(下)", "下学期", "第二学期")

_MONTH_PATTERNS = (
    re.compile(r"(20\d{2})[.\-/年](\d{1,2})"),
    re.compile(r"(20\d{2})(0[1-9]|1[0-2])"),
)


def _semester_from_markers(text: str) -> Optional[str]:
    if not text:
        return None
    if any(marker in text for marker in _UP_MARKERS):
        return "first"
    if any(marker in text for marker in _DOWN_MARKERS):
        return "second"
    return None


def _semester_from_month(text: str) -> Optional[str]:
    if not text:
        return None
    for pattern in _MONTH_PATTERNS:
        match = pattern.search(text)
        if not match:
            continue
        month = int(match.group(2))
        if month in _FIRST_SEMESTER_MONTHS:
            return "first"
        if month in _SECOND_SEMESTER_MONTHS:
            return "second"
    return None


def resolve_semester(exam_type: str, title: str = "", filename: str = "") -> Optional[str]:
    """推断学期：返回 "first" / "second"，无法判定返回 None。

    月考/期中/期末在上下两个学期都有，不能靠考试类型推断，只认显式标记或月份；
    一模/二模/三模是约定性的下学期考试，可直接判定。

    exam_type 既接受站点原始写法（`二模`），也接受规范化后的写法（`模拟二`）——
    调用方可能来自 parser（原始），也可能来自 Classification（规范化），两者都不能漏判。
    """
    for source in (exam_type, title, filename):
        marked = _semester_from_markers(source)
        if marked is not None:
            return marked
    if Classifier.normalize_exam_type(exam_type) in _SIMULATION_EXAM_TYPES:
        return "second"
    return _semester_from_month(filename) or _semester_from_month(title)
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd tools/crawler && pytest tests/adapters/test_zgkao_classifier.py -v`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
git add tools/crawler/src/classifier.py tools/crawler/tests/adapters/test_zgkao_classifier.py
git commit -m "feat(crawler): 新增学期判定纯函数 resolve_semester"
```

---

### Task 3: `SemesterResolver`（缓存 + 询问）

**Files:**
- Modify: `tools/crawler/src/classifier.py`（文件末尾继续追加）
- Test: `tools/crawler/tests/adapters/test_zgkao_classifier.py`（末尾新增类，import 追加 `SemesterResolver`）

**Interfaces:**
- Consumes: `resolve_semester()`（Task 2）
- Produces:
  - `SemesterResolver(prompt_fn: Optional[Callable[[str], str]] = None)`
  - `SemesterResolver.resolve(*, exam_type: str, filename: str = "", title: str = "", key: object = None, group: object = None, label: str = "") -> Optional[str]`
    （`key` = 单份试卷标识，`group` = 组标识；两者都可为 None）
  - `SemesterResolver.unresolved: list[str]`（判不出且未询问时的条目；追加 label）

- [ ] **Step 1: 写失败测试**

在 `tools/crawler/tests/adapters/test_zgkao_classifier.py` 末尾追加（import 改为 `from classifier import Classification, Classifier, SemesterResolver, resolve_semester`）：

```python
class TestSemesterResolver:
    def test_returns_auto_detected_semester_without_prompting(self):
        prompts = []
        resolver = SemesterResolver(prompt_fn=lambda label: prompts.append(label) or "下")
        assert resolver.resolve(exam_type="（上）期末考") == "first"
        assert prompts == []

    def test_prompts_when_unresolved(self):
        resolver = SemesterResolver(prompt_fn=lambda label: "上")
        assert resolver.resolve(exam_type="月考", key=("初三", "月考", "2024"), label="初三-月考-2024") == "first"
        assert resolver.unresolved == []

    def test_accepts_first_and_second_words(self):
        assert SemesterResolver(prompt_fn=lambda label: "second").resolve(exam_type="月考") == "second"

    def test_caches_prompted_answer_for_same_group(self):
        prompts = []
        resolver = SemesterResolver(prompt_fn=lambda label: prompts.append(label) or "下")
        group = ("初三", "月考", "2024")
        assert resolver.resolve(exam_type="月考", key="paper-a", group=group, label="初三-月考-2024") == "second"
        assert resolver.resolve(exam_type="月考", key="paper-b", group=group, label="初三-月考-2024") == "second"
        assert prompts == ["初三-月考-2024"]

    def test_auto_detected_value_does_not_leak_across_papers(self):
        """自动推断值只按同一份试卷复用：A 卷的推断结果不能静默套到 B 卷。"""
        resolver = SemesterResolver(prompt_fn=lambda label: "下")
        group = ("初三", "月考", "2024")
        # A 卷有月份证据 → 推断 first，写入文件缓存
        assert resolver.resolve(
            exam_type="月考", filename="2026.10海淀初三月考数学.pdf", key="paper-a", group=group,
        ) == "first"
        # B 卷无任何证据 → 不能继承 A 的 first，必须去问用户（stub 答「下」）
        assert resolver.resolve(
            exam_type="月考", filename="2026西城初三月考数学.pdf", key="paper-b", group=group,
        ) == "second"

    def test_caches_auto_detected_answer_so_sibling_file_reuses_it(self):
        """同一份试卷的「试卷」文件判出学期后，「答案」文件没标记也应复用，不能落到别的学期。"""
        resolver = SemesterResolver(prompt_fn=lambda label: "下")
        key = "https://www.zgkao.com/shitiku/87761.html"
        assert resolver.resolve(exam_type="期末", filename="2024海淀初三（上）期末数学.pdf", key=key) == "first"
        assert resolver.resolve(exam_type="期末", filename="2024海淀初三期末数学答案.pdf", key=key) == "first"

    def test_invalid_answer_falls_back_to_unresolved(self):
        resolver = SemesterResolver(prompt_fn=lambda label: "不知道")
        assert resolver.resolve(exam_type="月考", label="初三-月考-2024") is None
        assert resolver.unresolved == ["初三-月考-2024"]

    def test_non_interactive_records_unresolved(self):
        resolver = SemesterResolver()
        assert resolver.resolve(exam_type="月考", filename="x.pdf", label="初三-月考-2024") is None
        assert resolver.unresolved == ["初三-月考-2024"]
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd tools/crawler && pytest tests/adapters/test_zgkao_classifier.py::TestSemesterResolver -v`
Expected: FAIL，`ImportError: cannot import name 'SemesterResolver'`

- [ ] **Step 3: 实现**

在 `tools/crawler/src/classifier.py` import 区补 `Callable`：

```python
from typing import Callable, Optional
```

在文件末尾追加：

```python
def _parse_prompt_answer(answer: str) -> Optional[str]:
    text = (answer or "").strip().lower()
    if not text:
        return None
    if text.startswith("上") or text in {"first", "1"}:
        return "first"
    if text.startswith("下") or text in {"second", "2"}:
        return "second"
    return None


class SemesterResolver:
    """学期解析：先自动推断，判不出时询问用户。

    两层缓存，缺一不可：
    - 文件级 `key`（同一份试卷）：自动推断成功的值只在这一层复用，保证「试卷/答案」同学期；
    - 组级 `group`（(年级,考试类型,年份)）：只有用户亲自回答过才写入，同组只问一次。

    不能把自动推断值写进组缓存——那会让无证据的 B 卷静默继承 A 卷的推断（月考上下学期都有）。
    prompt_fn 为 None 表示非交互场景：判不出就记入 unresolved，由调用方跳过该文件。
    """

    def __init__(self, prompt_fn: Optional[Callable[[str], str]] = None) -> None:
        self._prompt_fn = prompt_fn
        self._file_cache: dict = {}
        self._group_cache: dict = {}
        self.unresolved: list[str] = []

    def resolve(
        self,
        *,
        exam_type: str,
        filename: str = "",
        title: str = "",
        key: object = None,
        group: object = None,
        label: str = "",
    ) -> Optional[str]:
        identity = label or filename or exam_type

        semester = resolve_semester(exam_type, title=title, filename=filename)
        if semester is not None:
            self._remember_file(key, semester)
            return semester

        if group is not None and group in self._group_cache:
            semester = self._group_cache[group]
            self._remember_file(key, semester)
            return semester

        if key is not None and key in self._file_cache:
            return self._file_cache[key]

        if self._prompt_fn is None:
            self.unresolved.append(identity)
            return None

        semester = _parse_prompt_answer(self._prompt_fn(identity))
        if semester is None:
            self.unresolved.append(identity)
            return None
        if group is not None:
            self._group_cache[group] = semester
        self._remember_file(key, semester)
        return semester

    def _remember_file(self, key: object, semester: str) -> None:
        if key is not None:
            self._file_cache[key] = semester
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd tools/crawler && pytest tests/adapters/test_zgkao_classifier.py -v`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
git add tools/crawler/src/classifier.py tools/crawler/tests/adapters/test_zgkao_classifier.py
git commit -m "feat(crawler): 新增 SemesterResolver，判不出时询问并缓存"
```

---

### Task 4: `ZgkaoAdapter` 接入学期判定 + 年级过滤

**Files:**
- Modify: `tools/crawler/src/adapters/zgkao.py`（删 `_EXAM_TYPE_SEMESTER`、改 `__init__`/`supported_filters`/`_download_pdf`/`_build_classification`/`_passes_filter`）
- Test: `tools/crawler/tests/adapters/test_zgkao_adapter.py`

**Interfaces:**
- Consumes: `SemesterResolver`（Task 3）
- Produces:
  - `ZgkaoAdapter(fetcher, entry_url, filters, semester_resolver=None)`
  - `ZgkaoAdapter.supported_filters()` 返回 `{"years", "subjects", "districts", "grades"}`
  - `ZgkaoAdapter._build_classification(item, link, is_split, semester)`

- [ ] **Step 1: 写失败测试**

在 `tools/crawler/tests/adapters/test_zgkao_adapter.py` 文件末尾追加：

```python
class StubResolver:
    """记录调用参数的学期解析桩，替代真实询问。"""

    def __init__(self, semester):
        self._semester = semester
        self.last_kwargs = {}
        self.unresolved = []

    def resolve(self, **kwargs):
        self.last_kwargs = kwargs
        if self._semester is None:
            self.unresolved.append(kwargs.get("label", ""))
        return self._semester


def _make_ctx(tmp_path, fetcher, dry_run=False):
    store = PdfStore(
        base_dir=str(tmp_path),
        entry_url="https://www.zgkao.com/shitiku/89047.html",
        crawl_time=datetime(2026, 7, 4, 10, 0, 0, tzinfo=timezone.utc),
    )
    return DownloadContext(
        fetcher=fetcher, store=store, checkpoint=None, validator=PdfValidator(), dry_run=dry_run,
    )


class TestZgkaoGradeFilter:
    def test_supported_filters_includes_grades(self):
        adapter = ZgkaoAdapter(MockFetcher(), "https://www.zgkao.com/shitiku/89047.html", {})
        assert "grades" in adapter.supported_filters()

    def test_excludes_non_matching_grade(self):
        fetcher = MockFetcher()
        adapter = ZgkaoAdapter(fetcher, "https://www.zgkao.com/shitiku/89047.html", {"grades": {"初二"}})
        items = list(adapter.list_items({}))
        ctx = DownloadContext(fetcher=fetcher, store=MagicMock(), checkpoint=None, validator=None)
        assert adapter.download_item(items[0], ctx).files_downloaded == 0

    def test_passes_matching_grade(self, tmp_path):
        fetcher = MockFetcher()
        adapter = ZgkaoAdapter(fetcher, "https://www.zgkao.com/shitiku/89047.html", {"grades": {"初三"}})
        items = list(adapter.list_items({}))
        assert adapter.download_item(items[0], _make_ctx(tmp_path, fetcher)).files_downloaded == 1


class TestZgkaoSemesterWiring:
    def test_passes_exam_type_and_filename_to_resolver(self, tmp_path):
        fetcher = MockFetcher()
        stub = StubResolver("second")
        adapter = ZgkaoAdapter(fetcher, "https://www.zgkao.com/shitiku/89047.html", {}, semester_resolver=stub)
        items = list(adapter.list_items({}))
        adapter.download_item(items[0], _make_ctx(tmp_path, fetcher))
        assert stub.last_kwargs["exam_type"] == "二模"
        assert stub.last_kwargs["filename"] == "2026北京西城初三二模数学 有答案.pdf"
        assert stub.last_kwargs["key"] == "https://www.zgkao.com/shitiku/90304.html"
        assert stub.last_kwargs["group"] == ("初三", "二模", "2026")
        assert stub.last_kwargs["label"] == "初三-二模-2026"

    def test_uses_resolved_semester_for_directory(self, tmp_path):
        fetcher = MockFetcher()
        adapter = ZgkaoAdapter(
            fetcher, "https://www.zgkao.com/shitiku/89047.html", {}, semester_resolver=StubResolver("first"),
        )
        items = list(adapter.list_items({}))
        adapter.download_item(items[0], _make_ctx(tmp_path, fetcher))
        assert (tmp_path / "数学" / "初中" / "first" / "2026").is_dir()

    def test_skips_file_when_semester_unresolved(self, tmp_path):
        fetcher = MockFetcher()
        adapter = ZgkaoAdapter(
            fetcher, "https://www.zgkao.com/shitiku/89047.html", {}, semester_resolver=StubResolver(None),
        )
        items = list(adapter.list_items({}))
        result = adapter.download_item(items[0], _make_ctx(tmp_path, fetcher))
        assert result.files_downloaded == 0
        assert not (tmp_path / "数学").exists()

    def test_dry_run_does_not_ask_resolver(self, tmp_path):
        fetcher = MockFetcher()
        stub = StubResolver(None)
        adapter = ZgkaoAdapter(fetcher, "https://www.zgkao.com/shitiku/89047.html", {}, semester_resolver=stub)
        items = list(adapter.list_items({}))
        result = adapter.download_item(items[0], _make_ctx(tmp_path, fetcher, dry_run=True))
        assert result.files_downloaded == 1
        assert stub.last_kwargs == {}


class TestZgkaoSecondaryIndex:
    """迁移自 tests/adapters/test_zgkao.py 的二级索引递归用例。"""

    def _fetcher(self):
        fetcher = MockFetcher()
        fetcher._routes.update({
            "https://www.zgkao.com/shitiku/89047.html": ("text", SECONDARY_A_INDEX_HTML),
            "https://www.zgkao.com/zk/202304/60347.html": ("text", SECONDARY_B_INDEX_HTML),
            "https://www.zgkao.com/zk/202305/61551.html": ("text", DOWNLOAD_PAGE_HTML),
            "https://cdn.zgkao.com/zixunzhan/202401/abc.pdf": ("bytes", make_pdf_bytes()),
            "https://cdn.zgkao.com/zixunzhan/202401/def.pdf": ("bytes", make_pdf_bytes()),
        })
        return fetcher

    def test_recurses_into_secondary_index_page(self, tmp_path):
        fetcher = self._fetcher()
        adapter = ZgkaoAdapter(fetcher, "https://www.zgkao.com/shitiku/89047.html", {})
        items = list(adapter.list_items({}))
        result = adapter.download_item(items[0], _make_ctx(tmp_path, fetcher))
        assert result.files_downloaded == 2

    def test_downloads_both_paper_and_answer(self, tmp_path):
        fetcher = self._fetcher()
        adapter = ZgkaoAdapter(fetcher, "https://www.zgkao.com/shitiku/89047.html", {})
        items = list(adapter.list_items({}))
        adapter.download_item(items[0], _make_ctx(tmp_path, fetcher))
        pdf_dir = tmp_path / "数学" / "初中" / "second" / "2023"
        names = {p.name for p in pdf_dir.glob("*.pdf")}
        assert "数学-初三(下)-202307-海淀-模拟二-试卷.pdf" in names
        assert "数学-初三(下)-202307-海淀-模拟二-答案.pdf" in names
```

并在该测试文件顶部 HTML 常量区追加：

```python
SECONDARY_A_INDEX_HTML = """
<html><body>
<table>
  <tr><td colspan="2"><strong>2023海淀初三二模试卷&答案</strong></td></tr>
  <tr><td>科目</td><td>2023年</td></tr>
  <tr>
    <td>数学</td>
    <td><a href="https://www.zgkao.com/zk/202304/60347.html">试卷 | 答案</a></td>
  </tr>
</table>
</body></html>
"""

SECONDARY_B_INDEX_HTML = """
<html><body>
<table>
  <tr><td colspan="3"><strong>2023海淀初三二模试卷&答案汇总</strong></td></tr>
  <tr><td>区</td><td>科目</td><td>2023年</td></tr>
  <tr>
    <td>海淀区</td>
    <td>数学</td>
    <td><a href="https://www.zgkao.com/zk/202305/61551.html">试卷</a></td>
  </tr>
</table>
</body></html>
"""

DOWNLOAD_PAGE_HTML = """
<html><body>
<a class="download" href="https://cdn.zgkao.com/zixunzhan/202401/abc.pdf">立即下载：2023海淀初三二模数学试卷</a>
<a class="download" href="https://cdn.zgkao.com/zixunzhan/202401/def.pdf">立即下载：2023海淀初三二模数学试卷答案</a>
</body></html>
"""
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd tools/crawler && pytest tests/adapters/test_zgkao_adapter.py -v`
Expected: 新增用例 FAIL（`TypeError: __init__() got an unexpected keyword argument 'semester_resolver'`、`TypeError: _download_pdf() got an unexpected keyword argument`、`ImportError`）

- [ ] **Step 3: 实现**

把 `tools/crawler/src/adapters/zgkao.py` 改造成下面内容（删掉文件顶部的 `_EXAM_TYPE_SEMESTER` 整块）：

```python
"""zgkao.com 试卷站点适配器。"""

from pathlib import Path
from typing import Iterator
from urllib.parse import urlsplit

from adapters.base import DownloadContext, DownloadResult, Item, SiteAdapter
from classifier import Classification, Classifier, SemesterResolver
from parser import DetailParser, IndexParser


_FILE_TYPE_MAP = {"试卷": "paper", "答案": "answer"}


class ZgkaoAdapter(SiteAdapter):
    name = "zgkao"

    def __init__(self, fetcher, entry_url: str, filters: dict, semester_resolver: SemesterResolver = None):
        self._fetcher = fetcher
        self._entry_url = entry_url
        self._filters = filters
        self._semester_resolver = semester_resolver or SemesterResolver()
        self._visited: set[str] = set()

    @property
    def entry_url(self) -> str:
        return self._entry_url

    def robots_urls(self) -> list[str]:
        parts = urlsplit(self._entry_url)
        return [f"{parts.scheme}://{parts.netloc}/robots.txt"]

    def supported_filters(self) -> set[str]:
        return {"years", "subjects", "districts", "grades"}

    def required_args(self) -> set[str]:
        return {"url"}

    def list_items(self, filters: dict) -> Iterator[Item]:
        html = self._fetcher.fetch_text(self._entry_url)
        for paper in IndexParser.parse(html):
            yield Item(
                id=paper.detail_url,
                title=f"{paper.subject}-{paper.grade}-{paper.exam_type}-{paper.year}",
                tags={"subject": paper.subject, "district": paper.district, "year": paper.year},
                raw={"paper": paper},
            )

    def download_item(self, item: Item, ctx: DownloadContext) -> DownloadResult:
        result = DownloadResult()
        paper = item.raw["paper"]

        if item.id in self._visited:
            return result
        self._visited.add(item.id)

        if not self._passes_filter(paper):
            return result

        detail_html = ctx.fetcher.fetch_text(item.id)
        pdf_links = DetailParser.parse(detail_html)

        if pdf_links:
            is_split = (
                len(pdf_links) == 2
                and any(l.has_answer for l in pdf_links)
                and any(not l.has_answer for l in pdf_links)
            )
            for link in pdf_links:
                self._download_pdf(ctx, paper, link, is_split, result)
            # dry-run 不落盘也不标 PDF URL，同样不能标 detail URL——否则后续真实爬取会把
            # 整个 item 判成已下载而跳过（PDF URL 未标记，参见 _download_pdf 的 dry-run 分支）
            if ctx.checkpoint and not ctx.dry_run and result.files_failed == 0 and result.files_downloaded > 0:
                ctx.checkpoint.mark_downloaded(item.id)
            return result

        sub_items = IndexParser.parse(detail_html)
        for sub in sub_items:
            sub_result = self.download_item(
                Item(
                    id=sub.detail_url,
                    title=sub.subject,
                    tags={},
                    raw={"paper": sub},
                ),
                ctx,
            )
            result += sub_result
        return result

    def _download_pdf(self, ctx, paper, link, is_split: bool, result: DownloadResult) -> None:
        if not ctx.force and ctx.checkpoint and ctx.checkpoint.is_downloaded(link.url):
            result.files_skipped += 1
            return

        if ctx.dry_run:
            result.files_downloaded += 1
            return

        semester = self._semester_resolver.resolve(
            exam_type=paper.exam_type,
            filename=link.filename,
            key=paper.detail_url,
            group=(paper.grade, paper.exam_type, paper.year),
            label=f"{paper.grade}-{paper.exam_type}-{paper.year}",
        )
        if semester is None:
            print(f"警告：无法判断学期，已跳过 {paper.grade}-{paper.exam_type}-{paper.year}（{link.filename}）")
            return

        content = ctx.fetcher.fetch_bytes(link.url)
        classification = self._build_classification(paper, link, is_split, semester)
        dir_relpath = Classifier.storage_dir(classification, base_dir="")
        filename = Classifier.filename(classification)

        path = ctx.store.save(
            dir_relpath=dir_relpath,
            filename=filename,
            content=content,
            source_url=link.url,
            file_type=_FILE_TYPE_MAP.get(classification.file_type, "paper"),
            classification={
                "subject": classification.subject,
                "level": classification.level,
                "semester": classification.semester,
                "year": classification.year,
            },
        )

        if ctx.validator:
            validation = ctx.validator.validate(str(path))
            if not validation.is_valid:
                path.unlink(missing_ok=True)
                result.files_failed += 1
                return

        if ctx.checkpoint:
            ctx.checkpoint.mark_downloaded(link.url)
        result.files_downloaded += 1

    @staticmethod
    def _build_classification(item, link, is_split: bool, semester: str) -> Classification:
        if is_split:
            file_type = "答案" if link.has_answer else "试卷"
        else:
            file_type = "试卷"
        return Classification(
            subject=item.subject,
            semester=semester,
            grade=item.grade,
            year=item.year,
            year_code=item.year + "07",
            district=item.district,
            exam_type=item.exam_type,
            file_type=file_type,
        )

    def _passes_filter(self, item) -> bool:
        if "years" in self._filters and item.year not in self._filters["years"]:
            return False
        if "subjects" in self._filters and item.subject not in self._filters["subjects"]:
            return False
        if "districts" in self._filters and item.district not in self._filters["districts"]:
            return False
        if "grades" in self._filters and item.grade not in self._filters["grades"]:
            return False
        return True
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd tools/crawler && pytest tests/adapters/test_zgkao_adapter.py -v`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
git add tools/crawler/src/adapters/zgkao.py tools/crawler/tests/adapters/test_zgkao_adapter.py
git commit -m "feat(crawler): zgkao 适配器接入学期判定与年级过滤"
```

---

### Task 5: 合并入口为 `src/crawler_cli.py`

**Files:**
- Create: `tools/crawler/src/crawler_cli.py`
- Delete: `tools/crawler/src/main.py`、`tools/crawler/src/cli.py`
- Create: `tools/crawler/tests/test_crawler_cli.py`
- Delete: `tools/crawler/tests/test_cli.py`、`tools/crawler/tests/adapters/test_zgkao.py`

**Interfaces:**
- Consumes: `ZgkaoAdapter(..., semester_resolver=)`（Task 4）、`SemesterResolver`（Task 3）、`core.crawler.Crawler`、`PdfStore`/`ImageStore`
- Produces: `crawler_cli.parse_args(argv=None)`、`crawler_cli.main(argv=None) -> int`（`0` 正常，`2` 有未决学期）

- [ ] **Step 1: 写失败测试**

创建 `tools/crawler/tests/test_crawler_cli.py`：

```python
"""crawler_cli.py 参数解析、学期未决退出码与 TTY 接线测试。"""

import pytest

import crawler_cli
from crawler_cli import _unique_keep_order, parse_args


class TestUniqueKeepOrder:
    def test_dedups_and_preserves_order(self):
        assert _unique_keep_order(["b", "a", "b", "c", "a"]) == ["b", "a", "c"]

    def test_empty(self):
        assert _unique_keep_order([]) == []


class TestCrawlerCliParseArgs:
    def test_site_required(self):
        with pytest.raises(SystemExit):
            parse_args([])

    def test_site_zgkao_requires_url(self):
        with pytest.raises(SystemExit):
            parse_args(["--site", "zgkao"])

    def test_site_zgkao_with_url(self):
        args = parse_args(["--site", "zgkao", "--url", "https://example.com"])
        assert args.site == "zgkao"
        assert args.url == "https://example.com"

    def test_site_smartedu_accepts_subject(self):
        args = parse_args(["--site", "smartedu", "--subject", "数学"])
        assert args.site == "smartedu"
        assert args.subject == "数学"

    def test_zgkao_accepts_grade_filter(self):
        args = parse_args(["--site", "zgkao", "--url", "https://example.com", "--grade", "初三"])
        assert args.grade == "初三"

    def test_zgkao_rejects_level_filter(self):
        with pytest.raises(SystemExit):
            parse_args(["--site", "zgkao", "--url", "https://example.com", "--level", "初中"])

    def test_smartedu_rejects_district_filter(self):
        with pytest.raises(SystemExit):
            parse_args(["--site", "smartedu", "--district", "海淀"])

    def test_output_default(self):
        args = parse_args(["--site", "smartedu"])
        assert args.output == "./data"

    def test_force_flag(self):
        assert parse_args(["--site", "smartedu", "--force"]).force is True

    def test_dry_run_flag(self):
        assert parse_args(["--site", "smartedu", "--dry-run"]).dry_run is True

    def test_crawl_delay_default_is_none(self):
        # 具体默认值（zgkao 0 / smartedu 0.5）在 main() 里按站点解析，parse_args 只保留 None
        assert parse_args(["--site", "zgkao", "--url", "https://e.com"]).crawl_delay is None


class TestBuildFilters:
    def test_maps_grade_and_subject_to_plural_keys(self):
        args = parse_args([
            "--site", "zgkao", "--url", "https://e.com", "--grade", "初三", "--subject", "数学",
        ])
        assert crawler_cli._build_filters(args) == {"grades": {"初三"}, "subjects": {"数学"}}

    def test_empty_when_no_filters(self):
        args = parse_args(["--site", "zgkao", "--url", "https://e.com"])
        assert crawler_cli._build_filters(args) == {}


class _FakeResult:
    items_total = 1
    items_downloaded = 1
    items_skipped = 0
    items_failed = 0


class _FakeCrawler:
    def __init__(self, **kwargs):
        self.kwargs = kwargs

    def run(self, filters):
        return _FakeResult()


class _FakeCheckpoint:
    def __init__(self, path):
        self.path = path

    def load(self):
        pass


class _FakeStdin:
    def __init__(self, tty: bool):
        self._tty = tty

    def isatty(self) -> bool:
        return self._tty


def _stub_main_collaborators(monkeypatch, resolver_cls):
    monkeypatch.setattr(crawler_cli, "Checkpoint", _FakeCheckpoint)
    monkeypatch.setattr(crawler_cli, "Fetcher", lambda **kwargs: object())
    monkeypatch.setattr(crawler_cli, "PdfStore", lambda **kwargs: object())
    monkeypatch.setattr(crawler_cli, "PdfValidator", lambda: object())
    monkeypatch.setattr(crawler_cli, "ZgkaoAdapter", lambda **kwargs: object())
    monkeypatch.setattr(crawler_cli, "Crawler", _FakeCrawler)
    monkeypatch.setattr(crawler_cli, "SemesterResolver", resolver_cls)


class TestMainSemesterContract:
    """spec 验收标准：非交互判不出 → 跳过 + 警告 + 退出码 2；TTY 才接线 stdin 询问。"""

    def test_returns_exit_code_2_and_dedups_unresolved(self, monkeypatch, capsys):
        class StubResolver:
            def __init__(self, prompt_fn=None):
                self.prompt_fn = prompt_fn
                # 同一份试卷的「试卷/答案」都判不出 → identity 重复
                self.unresolved = ["初三-月考-2024", "初三-月考-2024"]

        _stub_main_collaborators(monkeypatch, StubResolver)
        monkeypatch.setattr(crawler_cli.sys, "stdin", _FakeStdin(tty=False))

        code = crawler_cli.main(["--site", "zgkao", "--url", "https://e.com"])

        assert code == 2
        out = capsys.readouterr().out
        assert "Unresolved: 1" in out
        assert out.count("初三-月考-2024") == 1

    def test_returns_zero_when_nothing_unresolved(self, monkeypatch):
        class StubResolver:
            def __init__(self, prompt_fn=None):
                self.prompt_fn = prompt_fn
                self.unresolved = []

        _stub_main_collaborators(monkeypatch, StubResolver)
        monkeypatch.setattr(crawler_cli.sys, "stdin", _FakeStdin(tty=False))

        assert crawler_cli.main(["--site", "zgkao", "--url", "https://e.com"]) == 0

    def test_wires_stdin_prompt_only_for_tty(self, monkeypatch):
        seen = {}

        class StubResolver:
            def __init__(self, prompt_fn=None):
                self.prompt_fn = prompt_fn
                self.unresolved = []
                seen["prompt_fn"] = prompt_fn

        _stub_main_collaborators(monkeypatch, StubResolver)

        monkeypatch.setattr(crawler_cli.sys, "stdin", _FakeStdin(tty=False))
        crawler_cli.main(["--site", "zgkao", "--url", "https://e.com"])
        assert seen["prompt_fn"] is None

        monkeypatch.setattr(crawler_cli.sys, "stdin", _FakeStdin(tty=True))
        crawler_cli.main(["--site", "zgkao", "--url", "https://e.com"])
        assert seen["prompt_fn"] is crawler_cli._stdin_prompt

    def test_smartedu_never_builds_a_resolver(self, monkeypatch):
        seen = {}

        class StubResolver:
            def __init__(self, prompt_fn=None):
                seen["built"] = True

        monkeypatch.setattr(crawler_cli, "Checkpoint", _FakeCheckpoint)
        monkeypatch.setattr(crawler_cli, "Fetcher", lambda **kwargs: object())
        monkeypatch.setattr(crawler_cli, "ImageStore", lambda **kwargs: object())
        monkeypatch.setattr(crawler_cli, "ImageValidator", lambda: object())
        monkeypatch.setattr(crawler_cli, "SmartEduAdapter", lambda **kwargs: object())
        monkeypatch.setattr(crawler_cli, "Crawler", _FakeCrawler)
        monkeypatch.setattr(crawler_cli, "SemesterResolver", StubResolver)

        assert crawler_cli.main(["--site", "smartedu", "--subject", "数学"]) == 0
        assert seen == {}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd tools/crawler && pytest tests/test_crawler_cli.py -v`
Expected: FAIL，`ModuleNotFoundError: No module named 'crawler_cli'`

- [ ] **Step 3: 实现 `crawler_cli.py`**

创建 `tools/crawler/src/crawler_cli.py`：

```python
"""CLI 入口：按 --site 选择 adapter 并运行通用 Crawler。

zgkao 线在下载前解析学期：优先从页面/文件名识别，判不出时交互询问；
非交互场景判不出则跳过该文件并在结束时以退出码 2 报告。
"""

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

from adapters.smartedu import SmartEduAdapter
from adapters.zgkao import ZgkaoAdapter
from classifier import SemesterResolver
from core.checkpoint import Checkpoint
from core.crawler import Crawler
from core.fetcher import Fetcher
from core.storage import ImageStore, PdfStore
from core.validator import ImageValidator, PdfValidator


_ADAPTERS = {
    "zgkao": ZgkaoAdapter,
    "smartedu": SmartEduAdapter,
}

_ADAPTER_REQUIRED = {"zgkao": {"url"}, "smartedu": set()}
_ADAPTER_FILTERS = {
    "zgkao": {"years", "subjects", "districts", "grades"},
    "smartedu": {"subject", "level", "grade", "semester", "publisher"},
}

_UNRESOLVED_EXIT_CODE = 2


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="K12 试卷/教材爬虫")
    parser.add_argument("--site", required=True, choices=list(_ADAPTERS.keys()), help="站点适配器")
    parser.add_argument("--url", help="入口页 URL（zgkao 必填）")
    parser.add_argument("--output", default="./data", help="输出目录")
    parser.add_argument("--subject", help="学科过滤")
    parser.add_argument("--year", help="年份过滤（zgkao）")
    parser.add_argument("--district", help="区县过滤（zgkao）")
    parser.add_argument("--level", help="学段过滤（smartedu）")
    parser.add_argument("--grade", help="年级过滤（zgkao: 初一/初二/初三/高一/高二/高三；smartedu: 九年级）")
    parser.add_argument("--semester", help="册次过滤（smartedu）")
    parser.add_argument("--publisher", help="版本过滤（smartedu）")
    parser.add_argument("--latest-only", action="store_true", default=True, help="smartedu 同书只取最新")
    parser.add_argument("--no-latest-only", dest="latest_only", action="store_false")
    parser.add_argument("--force", action="store_true", help="强制重新下载")
    parser.add_argument("--dry-run", action="store_true", help="只检查不下载")
    parser.add_argument("--crawl-delay", type=float, default=None, help="礼貌延时（秒）")
    args = parser.parse_args(argv)
    _validate_args(parser, args)
    return args


def _validate_args(parser, args):
    required = _ADAPTER_REQUIRED[args.site]
    if "url" in required and not args.url:
        parser.error(f"--site {args.site} requires --url")

    supported = _ADAPTER_FILTERS[args.site]
    filter_map = {
        "year": args.year,
        "subject": args.subject,
        "district": args.district,
        "level": args.level,
        "grade": args.grade,
        "semester": args.semester,
        "publisher": args.publisher,
    }
    for key, value in filter_map.items():
        if value is not None and key not in supported and key + "s" not in supported:
            parser.error(f"--{key.replace('_', '-')} is not supported for site {args.site}")


def _build_filters(args):
    filters = {}
    for key in ["year", "subject", "district", "level", "grade", "semester", "publisher"]:
        value = getattr(args, key, None)
        if value:
            filters[key + "s"] = set(value.split(","))
    return filters


def _stdin_prompt(label: str) -> str:
    return input(f"无法从页面判断学期：{label}，请填写学期 [上/下]：")


def _unique_keep_order(items):
    """去重但保持原顺序（同一份试卷的「试卷/答案」都判不出时 identity 会重复）。"""
    return list(dict.fromkeys(items))


def main(argv=None) -> int:
    args = parse_args(argv)

    crawl_time = datetime.now(timezone.utc)
    output_path = Path(args.output)
    checkpoint = Checkpoint(output_path / ".checkpoint.json")
    checkpoint.load()

    crawl_delay = args.crawl_delay
    if crawl_delay is None:
        crawl_delay = 0.0 if args.site == "zgkao" else 0.5

    fetcher = Fetcher(crawl_delay=crawl_delay)
    filters = _build_filters(args)

    resolver = None
    if args.site == "zgkao":
        # 非 TTY（管道/CI）不询问：判不出就跳过，结束时报未决并以非零码退出
        prompt_fn = _stdin_prompt if sys.stdin.isatty() else None
        resolver = SemesterResolver(prompt_fn=prompt_fn)
        store = PdfStore(
            base_dir=str(output_path),
            entry_url=args.url,
            crawl_time=crawl_time,
            site_adapter="zgkao",
        )
        validator = PdfValidator()
        adapter = ZgkaoAdapter(
            fetcher=fetcher,
            entry_url=args.url,
            filters=filters,
            semester_resolver=resolver,
        )
    else:
        store = ImageStore(
            base_dir=str(output_path),
            entry_url="https://basic.smartedu.cn/tchMaterial",
            crawl_time=crawl_time,
            site_adapter="smartedu",
        )
        validator = ImageValidator()
        adapter = SmartEduAdapter(
            fetcher=fetcher,
            base_dir=str(output_path),
            latest_only=args.latest_only,
        )

    crawler = Crawler(
        adapter=adapter,
        fetcher=fetcher,
        store=store,
        checkpoint=checkpoint,
        validator=validator,
        force=args.force,
        dry_run=args.dry_run,
    )

    result = crawler.run(filters)
    print(
        f"Total: {result.items_total}, Downloaded: {result.items_downloaded}, "
        f"Skipped: {result.items_skipped}, Failed: {result.items_failed}"
    )

    if resolver and resolver.unresolved:
        unresolved = _unique_keep_order(resolver.unresolved)
        print(f"Unresolved: {len(unresolved)}（无法判断学期，已跳过）")
        for identity in unresolved:
            print(f"  - {identity}")
        return _UNRESOLVED_EXIT_CODE
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: 删除旧入口与旧测试**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
git rm tools/crawler/src/main.py tools/crawler/src/cli.py
git rm tools/crawler/tests/test_cli.py tools/crawler/tests/adapters/test_zgkao.py
```

（`tests/adapters/test_zgkao.py` 的唯一独有覆盖——二级索引递归——已在 Task 4 迁移到 `test_zgkao_adapter.py`；
其 `TestParseArgs`/`TestCrawlerFilter` 覆盖由 `tests/test_crawler_cli.py` 与适配器过滤用例替代。）

- [ ] **Step 5: 运行全部测试确认通过**

Run: `cd tools/crawler && pytest -q`
Expected: 全部 PASS，无 `main` / `cli` 相关 collection 错误

- [ ] **Step 6: 提交**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
git add tools/crawler/src/crawler_cli.py tools/crawler/tests/test_crawler_cli.py
git commit -m "refactor(crawler): 合并 main.py 与 cli.py 为唯一入口 crawler_cli.py"
```

---

### Task 6: 删除 `Storage` 兼容壳并迁移其测试

**Files:**
- Modify: `tools/crawler/src/core/storage.py`（删除 `Storage` 类，约 204-241 行）
- Modify: `tools/crawler/tests/core/test_storage.py`

**Interfaces:**
- Consumes: `PdfStore.save(dir_relpath, filename, content, source_url, file_type, classification)`（`tools/crawler/src/core/storage.py:119-138`）
- Produces: `core.storage` 只导出 `BaseStore` / `PdfStore` / `ImageStore` / `ResourceStore`（`Storage` 不再存在）

- [ ] **Step 1: 改造测试（先让它在 `Storage` 仍存在时也能过）**

把 `tools/crawler/tests/core/test_storage.py` 的 import 改为：

```python
from classifier import Classification, Classifier
from core.storage import ImageStore, PdfStore
```

把 `storage` fixture 改为：

```python
@pytest.fixture
def storage(tmp_path, crawl_time):
    return PdfStore(
        base_dir=str(tmp_path),
        entry_url="https://www.zgkao.com/shitiku/89047.html",
        crawl_time=crawl_time,
    )


_FILE_TYPE_MAP = {"试卷": "paper", "答案": "answer"}


def save_pdf(store, cls, content=b"fake-pdf-content", source_url="https://cdn.zgkao.com/x.pdf"):
    """等价于被删除的 Storage.save_pdf：按分类推导目录/文件名/类型。"""
    return store.save(
        dir_relpath=Classifier.storage_dir(cls, ""),
        filename=Classifier.filename(cls),
        content=content,
        source_url=source_url,
        file_type=_FILE_TYPE_MAP[cls.file_type],
        classification={
            "subject": cls.subject,
            "level": cls.level,
            "semester": cls.semester,
            "year": cls.year,
        },
    )
```

把该文件里所有 `storage.save_pdf(<cls>, <content>, <url>)` 调用改为 `save_pdf(storage, <cls>, <content>, <url>)`；
把直接 `Storage(...)` 的两处（`test_record_has_type_answer_for_答案`、`TestRobotsCheckedFlag`）改为 `PdfStore(...)` 并改用 `save_pdf(...)`；
把 `test_meta_has_config_section` 的断言从 `== "1.0.0"` 改为 `== "2.0.0"`（`PdfStore` 默认 `crawler_version`）。

- [ ] **Step 2: 运行测试确认通过（此时 PdfStore 路径生效）**

Run: `cd tools/crawler && pytest tests/core/test_storage.py -v`
Expected: 全部 PASS（已不再依赖 `Storage.save_pdf`）

- [ ] **Step 3: 删除 `Storage` 类**

从 `tools/crawler/src/core/storage.py` 删除文件末尾的整段：

```python
class Storage:
    """向后兼容的旧 Storage 包装，实际委托给 PdfStore。"""
    ...
```

（从 `class Storage:` 到文件末尾，含其 `__init__` 与 `save_pdf`。）
同时删除该文件顶部第 11 行的 import：

```python
from classifier import Classification, Classifier
```

（`Classification` 与 `Classifier` 在 `storage.py` 里只被 `Storage.save_pdf` 使用，删除后整行都成了未使用 import。）

- [ ] **Step 4: 运行全部测试确认通过**

Run: `cd tools/crawler && pytest -q`
Expected: 全部 PASS；`grep -rn "import Storage\|Storage(" tools/crawler` 无结果

- [ ] **Step 5: 提交**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
git add tools/crawler/src/core/storage.py tools/crawler/tests/core/test_storage.py
git commit -m "refactor(crawler): 删除仅旧入口使用的 Storage 兼容壳"
```

---

### Task 7: 更新 `tools/crawler/README.md`

**Files:**
- Modify: `tools/crawler/README.md`

**Interfaces:**
- Consumes: Task 5 的最终 CLI 参数表
- Produces: 与代码一致的 README

- [ ] **Step 1: 改「用法」章节**

把「多站点 CLI（推荐）」小节标题改为「CLI」，并把所有 `python src/cli.py` 替换为 `python src/crawler_cli.py`（第 28、37、43、49、52、69、77、80、83、86 行）。

删除整个「旧版 CLI（仅 zgkao，向后兼容）」小节（原第 103-120 行），并在 CLI 小节开头加一句：

```markdown
> 2026-09-12 起 `src/main.py` 与 `src/cli.py` 已合并为 `src/crawler_cli.py`，
> 旧命令 `python src/main.py --url ...` 不再可用。
```

- [ ] **Step 2: zgkao 参数表补 `--grade`**

在 zgkao 参数表（原第 55-64 行）的 `--district` 行之后插入：

```markdown
| `--grade` | 年级过滤，逗号分隔多值。取值用站点原生写法：`初一`/`初二`/`初三`/`高一`/`高二`/`高三` | 不限 |
```

并在 zgkao 示例后追加一段：

````markdown
```bash
# 只下载初三的试卷
python src/crawler_cli.py --site zgkao \
  --url https://www.zgkao.com/shitiku/87761.html \
  --subject 数学 --grade 初三
```
````

- [ ] **Step 3: 新增「学期判定」小节**

在「输出结构」之前插入：

```markdown
### 学期判定（first / second，仅 zgkao）

学期由程序从页面自动识别，**无需命令行指定**（smartedu 教材线仍用 `--semester` 指定上册/下册），优先级：

1. 索引页表头的（上）/（下）标记，如 `海淀区2024-2025学年初三（上）期末考试卷和答案汇总`
2. PDF 文件名 / 试卷标题里的标记，如 `2025北京海淀初三（上）期末数学.pdf`
3. 一模 / 二模 / 三模 —— 约定属下学期
4. 文件名里的月份：9-12、1 月 → 上学期；3-7 月 → 下学期（2、8 月跨学期，不判）
5. 以上都判不出 → 交互式终端会提示 `请填写学期 [上/下]`（同一「年级-考试类型-年份」只问一次）；
   非交互环境（管道 / CI）则跳过该文件并逐条警告，结束时以退出码 2 报告

`--dry-run` 不询问、不因判不出报错。
```

- [ ] **Step 4: 更新架构与输出结构**

把「架构」小节里 `main.py # 旧版 zgkao CLI（向后兼容）` 与 `cli.py # 新版多站点 CLI 入口` 两行合并为：

```
└── crawler_cli.py      # 唯一 CLI 入口（zgkao 试卷 / smartedu 教材）
```

把输出结构示例的 `second` 目录改为体现真实判定结果：

```
data/
└── 数学/
    └── 初中/
        └── first/
            └── 2026/
                ├── meta.json
                ├── 数学-初三(上)-202607-海淀-期末-试卷.pdf
                └── 数学-初三(上)-202607-海淀-期末-答案.pdf
```

（区县写成 `海淀` 而非 `海淀区`：解析时已统一去掉末尾「区」，与 README 参数表里的 `--district 海淀,西城` 一致。）

- [ ] **Step 5: 更新「测试」小节**

把 README「测试」小节里的 `- tests/test_cli.py - CLI 参数解析测试` 改为：

```markdown
- `tests/test_crawler_cli.py` - CLI 参数解析测试
```

- [ ] **Step 6: 校验无残留用法引用**

注意：Step 1 要求的变更说明里会**故意**写出旧命令 `python src/main.py ...`，所以校验时要排除引用块（`>` 开头）的那一行。

Run: `cd /Users/lichao/Downloads/claude/imooc/ai_k12 && grep -n "python src/main\.py\|python src/cli\.py\|python -m pytest tests/test_cli\.py" tools/crawler/README.md | grep -v '^[0-9]*:>'`
Expected: 无输出

- [ ] **Step 7: 提交**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
git add tools/crawler/README.md
git commit -m "docs(crawler): README 同步新入口、年级过滤与学期判定说明"
```

---

### Task 8: 同步用户手册与设计文档

**Files:**
- Modify: `docs/data-refinery-使用手册.md`
- Modify: `docs/superpowers/specs/2026-07-04-smartedu-textbook-crawler-design.md`
- Modify: `docs/superpowers/specs/2026-09-12-crawler-entry-merge-and-semester-classification-design.md`

**Interfaces:**
- Consumes: Task 7 的最终 README 文案
- Produces: 全仓库不再出现指向 `src/cli.py` / `src/main.py` 的用法说明

- [ ] **Step 1: 更新用户手册 §3**

在 `docs/data-refinery-使用手册.md` 中把 §3「爬虫（Crawler）」的入口行改为：

```markdown
**入口**：`python src/crawler_cli.py --site <zgkao|smartedu> [options]`
```

把该节所有 `python src/cli.py` 替换为 `python src/crawler_cli.py`（约第 135、143、161、170、627 行）。
在 zgkao 参数表（约第 147-152 行）的 `--district` 行后插入：

```markdown
| `--grade` | 年级过滤，逗号分隔（zgkao 用 初一/初二/初三/高一/高二/高三） |
```

把「输出结构」行改为体现自动学期判定：

```markdown
**输出结构**：`data/{学科}/初中/{first|second}/{年份}/{试卷名}.pdf`（学期由页面自动识别，判不出时交互询问）
```

- [ ] **Step 2: 给历史设计文档加变更说明**

在 `docs/superpowers/specs/2026-07-04-smartedu-textbook-crawler-design.md` 标题下方插入一行：

```markdown
> **变更说明（2026-09-12）**：入口已合并为 `src/crawler_cli.py`（原 `main.py` / `cli.py` 已删除），
> 详见 `docs/superpowers/specs/2026-09-12-crawler-entry-merge-and-semester-classification-design.md`。
> 本文正文保留为当时的设计记录。
```

对该文档中出现的 `python src/main.py --site ...` 示例（约第 297、303 行）就地替换为 `python src/crawler_cli.py --site ...`。

- [ ] **Step 3: 设计文档补实现结果**

在 `docs/superpowers/specs/2026-09-12-crawler-entry-merge-and-semester-classification-design.md` 末尾追加：

```markdown
## 实现结果

（实现完成后填写：各 Task 提交号、`pytest` 通过数、87761 与 89047 两个入口页的真实落盘路径抽查结果。）
```

- [ ] **Step 4: 校验无残留用法引用**

注意：README 的变更说明里会**故意**写出旧命令 `python src/main.py ...`，所以要排除引用块（`>` 开头）的那一行；不排除的话这条校验永远不可能为空。

Run: `cd /Users/lichao/Downloads/claude/imooc/ai_k12 && grep -n "python src/cli\.py\|python src/main\.py" tools/crawler/README.md docs/data-refinery-使用手册.md | grep -v '^[0-9]*:>'`
Expected: 无输出

- [ ] **Step 5: 提交**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
git add docs/data-refinery-使用手册.md \
  docs/superpowers/specs/2026-07-04-smartedu-textbook-crawler-design.md \
  docs/superpowers/specs/2026-09-12-crawler-entry-merge-and-semester-classification-design.md
git commit -m "docs(crawler): 同步用户手册与设计文档的新入口和学期判定"
```

---

### Task 9: 真实网络端到端验收

**Files:**
- Modify: `docs/superpowers/specs/2026-09-12-crawler-entry-merge-and-semester-classification-design.md`（回填「实现结果」）

**Interfaces:**
- Consumes: Task 1-8 的全部成果
- Produces: 验收证据（落盘路径抽查）

- [ ] **Step 1: 跑全量测试**

Run: `cd tools/crawler && pytest -q`
Expected: 全部 PASS，且无 `network` 用例被误跑（`pytest.ini` 已 `-m "not network"`）

- [ ] **Step 2: dry-run 检查 87761，确认只列初三**

Run:
```bash
cd tools/crawler && python src/crawler_cli.py --site zgkao \
  --url https://www.zgkao.com/shitiku/87761.html \
  --subject 数学 --grade 初三 --dry-run --crawl-delay 1
```
Expected: `Downloaded` 计数 > 0，无 `Unresolved` 输出，退出码 0

- [ ] **Step 3: 真实下载 87761 的初三，检查落盘路径**

Run:
```bash
cd tools/crawler && rm -rf /tmp/crawler-acceptance && python src/crawler_cli.py --site zgkao \
  --url https://www.zgkao.com/shitiku/87761.html \
  --subject 数学 --grade 初三 --output /tmp/crawler-acceptance --crawl-delay 1
ls /tmp/crawler-acceptance/数学/初中/first/*/
```
Expected: 目录为 `first`（不是 `second`）；文件名形如 `数学-初三(上)-202607-海淀-期末-试卷.pdf`
（学期 `(上)`、区县 `海淀`，不再出现 `--2025学年`）

- [ ] **Step 4: 检查初一/初二也正确落在 first**

Run:
```bash
cd tools/crawler && rm -rf /tmp/crawler-acceptance2 && python src/crawler_cli.py --site zgkao \
  --url https://www.zgkao.com/shitiku/87761.html \
  --subject 数学 --output /tmp/crawler-acceptance2 --crawl-delay 1
ls /tmp/crawler-acceptance2/数学/初中/first
```
Expected: 无 `second` 目录；`first` 下同时存在初一的 `数学-初一(上)-...` 与初三的 `数学-初三(上)-...`

- [ ] **Step 5: 回归 89047（二模），确认行为不变且不触发询问**

Run:
```bash
cd tools/crawler && rm -rf /tmp/crawler-acceptance3 && python src/crawler_cli.py --site zgkao \
  --url https://www.zgkao.com/shitiku/89047.html \
  --subject 数学 --grade 初三 --output /tmp/crawler-acceptance3 --crawl-delay 1
ls /tmp/crawler-acceptance3/数学/初中/second/2026 | head
```
Expected: 落在 `second`，文件名形如 `数学-初三(下)-202607-海淀-模拟二-试卷.pdf`；无交互提示、无 `Unresolved`、退出码 0

- [ ] **Step 6: 回填实现结果并提交**

把 Step 1-5 的实测结果与各 Task 提交号写入设计文档「实现结果」小节。

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
git add docs/superpowers/specs/2026-09-12-crawler-entry-merge-and-semester-classification-design.md
git commit -m "docs(crawler): 回填入口合并与学期判定的端到端验收结果"
```

---

## 迁移提示（执行者注意）

- Task 5 会删掉 `python src/main.py`——用户原来的命令需改为
  `python src/crawler_cli.py --site zgkao --url ... --subject ... --year ...`。README 已在 Task 7 说明。
- 重新爬取 87761 前，需清理 `tools/crawler/data/` 下旧的 `second` 目录与 `data/.checkpoint.json` 中对应条目，
  否则 checkpoint 会跳过已下载 URL、旧错名文件也不会被自动删除。
