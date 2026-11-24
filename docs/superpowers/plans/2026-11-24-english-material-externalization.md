# 英语试卷材料化解析实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让新导入的英语卷按五大题把材料归位——完形/阅读/阅读表达的文章外置成 md 并填 `material_url`，作文的题目①②进 `material_text`，单选题的卷面说明清掉，且完形题不再被误判为缺题干。

**Architecture:** 三个主改动点：① 在 `EnglishStrategy` 上实现切题器已有的 `attach_post_material` 钩子，按 `group_id` 就地规整题干/材料；② 在 `chinese_material_doc.py` 加英语外置函数复用语文已验证的 `write_material_doc`/图片物化，在 `publish_cli.py` 的语文分支旁加 `elif` 接入；③ 在 `question_labeler.py` 加一条英语完形豁免。验收时另补两个窄修复：完形题号被 OCR 砍掉十位（`15 → 5`）时按文章空格标记恢复；题目恢复后自动收口旧的 `missing` 扫描记录。不新建模块、不新增 CLI 开关、不 bump `PUBLISH_VERSION`。

**Tech Stack:** Python 3 / pytest / pydantic（`ExamQuestion`、`RawQuestion`、`LabeledQuestion`）/ 现有 data-refinery 管线（convert → extract → publish → db_loader）。

## Global Constraints

- 范围只限**新导入的英语卷**；不回填已入库英语题，不清理试点卷 paper=975。
- 阅读理解 A 篇匹配题 21–23 不在范围，继续人工补题。
- 所有共享文章的落盘/URL 复用语文既有链路：`materials/english/{doc_key}/content.md`，`doc_key` 含卷维度 `paper_scope`。
- 卷面指令不进材料 md；完形题干保持为空；作文第一段指令句当题干、其余进 `material_text`。
- 不动 convert、db_loader、服务端、前端、语文及其它学科策略；不新建测试文件（就近加用例）。
- **不 bump `PUBLISH_VERSION`**（`publish_cli.py:34` 当前为 3；bump 会强制全库旧卷重发，等同全量迁移，与「只对新导入生效」冲突）。
- 任何交付给用户的验收流程必须收敛成**一条**命令（见 Task 4）。

---

### Task 1: 英语切题材料规整钩子

**Files:**
- Modify: `tools/data-refinery/src/subject_strategies/english.py`（加 2 个小函数 + `EnglishStrategy.attach_post_material`）
- Modify: `tools/data-refinery/src/question_splitter.py:1369-1372`（只改注释，不改逻辑）
- Test: `tools/data-refinery/tests/subject_strategies/test_english.py`

**Interfaces:**
- Consumes: `RawQuestion`（`group_order/group_id/content/material_text`，`question_splitter.py:812-827`）；切题器在 `split_page` 末尾调用 `attach_post_material(questions, lines, md_path.stem)`（`question_splitter.py:1370-1372`）。
- Produces: 规整后的 `RawQuestion` 列表——组一 `material_text=None`；组二/三/四 `material_text` 仅含文章本体；组五 `content`=第一段、`material_text`=其余。后续 publish 外置函数按 `group_id ∈ {二,三,四}` 读这些 `material_text`。

- [x] **Step 1: 写失败测试**（加到 `tests/subject_strategies/test_english.py` 末尾）

```python
_FIVE_PARTS_MD = """# 英语试卷

## 一、单项填空
从下面各题所给的 A、B、C、D 四个选项中，选择可以填入空白处的最佳选项。
1. We visit \\_\\_\\_\\_ grandparents.
A. we B. us C. our D. ours

## 二、完形填空
阅读下面的短文，掌握其大意，然后从短文后各题所给的 A、B、C、D 四个选项中，选择最佳选项。
The Unexpected Detour
Last summer, our bus broke down. Mr. Evans, \\_13\\_ said "Let's explore."

13. A. simply B. hopelessly C. mainly D. properly

## 三、阅读理解
## B
Jameson stood outside the kitchen. He felt bored.

24. How did Jameson feel?
A. Hopeful. B. Happy. C. Worried. D. Bored.

## 四、阅读表达
## 第二部分
## 本部分共 5 题，共 20 分。根据题目要求，完成相应任务。 四、阅读表达(34-36题，共10分)
阅读短文，根据短文内容回答问题。
## Be Smart About Your Smartphone
Losing your phone is a bad thing.

34. How did the author feel?

## 五、文段表达
38.从下面两个题目中任选一题，完成一篇不少于50词的英语文段写作。请不要写出你的校名和姓名。

题目①
假设你是李华。

提示词语: reuse, donate

题目②
在生活中，你一定拍摄过很多美好的画面。

提示词: beautiful, friend
"""


def test_five_parts_material_assignment():
    from pathlib import Path
    from question_splitter import split_page
    from subject_strategies import get_strategy

    qs = split_page(_FIVE_PARTS_MD, Path("x.md"), strategy=get_strategy("english"))
    by = {q.group_order: q for q in qs}

    assert by[1].material_text is None                       # 一：单选说明清掉
    assert "simply" in (by[13].content or "")                 # 二：题干原文（选项）留给 extract 再拆
    assert "\\_13\\_" in (by[13].material_text or "")        # 空格标记保留
    assert "阅读下面的短文" not in (by[13].material_text or "")
    assert (by[24].material_text or "").startswith("## B")   # 三：篇章标题保留
    assert (by[34].material_text or "").startswith(
        "## Be Smart About Your Smartphone")                 # 四：文章标题保留
    assert "本部分共" not in (by[34].material_text or "")
    assert (by[38].content or "").startswith("从下面两个题目中任选一题")
    assert "题目①" in (by[38].material_text or "")
    assert "题目②" in (by[38].material_text or "")
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd tools/data-refinery && pytest tests/subject_strategies/test_english.py::test_five_parts_material_assignment -v`
Expected: FAIL，断言 `by[1].material_text is None` 处失败（当前是卷面说明）。

- [x] **Step 3: 实现（贴进 `english.py` 的 import 区与 `EnglishStrategy` 类末尾）**

```python
# 英语卷面指令：开头整行删，不按字数猜；`## B` / 文章标题不会命中
_ENGLISH_INSTRUCTION_RE = re.compile(
    r"^#{0,6}\s*(?:"
    r"本部分共|第[一二三四五六七八九十]+部分\s*$|"
    r"从下面各题所给|阅读下面的短文|阅读下列短文|阅读短文，根据|"
    r"[一二三四五六七八九十]、)"
)


def _strip_english_instructions(text: str) -> str:
    lines = (text or "").splitlines()
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and _ENGLISH_INSTRUCTION_RE.match(lines[0].strip()):
        lines.pop(0)
        while lines and not lines[0].strip():
            lines.pop(0)
    return "\n".join(lines).strip()


def _split_writing(content: str) -> tuple[str, str]:
    """第一行留给题干，其余整体作为作文材料。"""
    lines = (content or "").strip().split("\n")
    return lines[0].strip(), "\n".join(lines[1:]).strip()
```

```python
    # EnglishStrategy 内新增（与 is_stem/split_options 同级）
    def attach_post_material(self, questions, lines, md_path_stem):
        """按大题号规整英语材料：一清空、二/三/四去卷面指令、五切题干与材料。"""
        for q in questions:
            gid = (q.group_id or "").strip()
            if gid == "一":
                q.material_text = None
            elif gid in ("二", "三", "四"):
                cleaned = _strip_english_instructions(q.material_text or "")
                q.material_text = cleaned or None
            elif gid == "五":
                stem, material = _split_writing(q.content)
                q.content = stem
                q.material_text = material or None
                if not material:
                    print(f"[WARN] {md_path_stem}: 题{q.group_order} 作文只有一段，"
                          "material_text 留空", flush=True)
```

并把 `question_splitter.py:1369` 的注释改为：

```python
    # 题后材料/材料规整（语文、英语）：与 attach_pre_material 对称的可选钩子，
    # 其它学科没有此方法，行为不变。
```

- [x] **Step 4: 跑测试确认通过，并跑英语策略全量**

Run: `cd tools/data-refinery && pytest tests/subject_strategies/test_english.py -q`
Expected: PASS，且原有竖排选项/篇章归属用例不受影响。

- [x] **Step 5: 提交**

```bash
git add tools/data-refinery/src/subject_strategies/english.py tools/data-refinery/src/question_splitter.py tools/data-refinery/tests/subject_strategies/test_english.py
git commit -m "feat(refinery): 英语切题按五大题规整材料归属"
```

---

### Task 2: 英语文章外置函数 + publish 接入

**Files:**
- Modify: `tools/data-refinery/src/chinese_material_doc.py`（新增 `externalize_english_materials`，复用同文件已有函数）
- Modify: `tools/data-refinery/src/publish_cli.py:19`（import）与 `:346`（加 `elif` 分支）
- Test: `tools/data-refinery/tests/test_chinese_material_doc.py`

**Interfaces:**
- Consumes: Task 1 产出的 `ExamQuestion` 列表（`group_id ∈ {二,三,四}` 的 `material_text` 已是文章本体）；`_resolver_for`、`choose_canonical`、`write_material_doc`、`is_heading_only`、`normalize_for_group` 均来自 `chinese_material_doc.py`。
- Produces: `externalize_english_materials(items, *, md_images_dir: Path, assets_dir: Path, store, subject_code: str = "english", paper_scope: str | None = None) -> None`——就地改写 `items`：组二/三/四同卷同文共用一个 `material_url`、`material_text=None`；组一/五不写文档。签名与语文版对齐，调用方在 publish 里传 `paper_scope=rel_file.as_posix()`。

- [x] **Step 1: 写失败测试**（加到 `tests/test_chinese_material_doc.py`，复用文件里已有的 `_Store`）

```python
def test_externalize_english_materials(tmp_path):
    from chinese_material_doc import externalize_english_materials
    from models import ExamQuestion

    assets = tmp_path / "assets"
    md_dir = tmp_path / "md"
    md_dir.mkdir()

    def q(no, gid, material):
        return ExamQuestion(
            subject_id="english", group_id=gid, group_order=no,
            type="choice", content=f"q{no}", answer="A",
            material_text=material,
            options=[{"label": "A", "text": "a"}] * 4,
        )

    items = [
        q(1, "一", "从下面各题所给的 A、B、C、D 四个选项中…"),
        q(13, "二", "## Passage\nText"),
        q(14, "二", "## Passage\nText"),
        q(24, "三", "## B\nText B"),
        q(38, "五", None),
    ]
    items[4].material_text = "题目①\n…\n题目②\n…"

    externalize_english_materials(
        items, md_images_dir=md_dir, assets_dir=assets,
        store=_Store(assets), paper_scope="英语/初中/first/2026/paper",
    )

    assert items[0].material_text is None and items[0].material_url is None
    assert items[1].material_text is None and items[1].material_url
    assert items[1].material_url == items[2].material_url       # 同文共用 URL
    assert items[3].material_url != items[1].material_url       # 不同篇不同 URL
    assert items[4].material_url is None and "题目①" in items[4].material_text
    assert items[1].material_url.startswith("materials/english/")
    body = (assets / items[1].material_url).read_text(encoding="utf-8")
    assert body.startswith("## Passage")
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd tools/data-refinery && pytest tests/test_chinese_material_doc.py::test_externalize_english_materials -v`
Expected: FAIL with `ImportError: cannot import name 'externalize_english_materials'`.

- [x] **Step 3: 实现外置函数**（贴到 `chinese_material_doc.py` 的 `externalize_chinese_materials` 之后）

```python
def externalize_english_materials(
    items,
    *,
    md_images_dir: Path,
    assets_dir: Path,
    store,
    subject_code: str = "english",
    paper_scope: str | None = None,
) -> None:
    """publish 阶段（仅英语）：组二/三/四的共享文章 → md + material_url。

    复用语文的 doc_key / 写文档 / 图片物化；英语特有的只有「哪些组算文章」。
    组五的作文材料留在 material_text（显示在题干下方），不外置。
    """
    groups: dict[str, list] = {}
    for item in items:
        if (item.group_id or "").strip() not in ("二", "三", "四"):
            continue
        text = item.material_text or ""
        if not text.strip() or is_heading_only(text):
            continue
        groups.setdefault(normalize_for_group(text), []).append(item)

    resolver = _resolver_for(Path(md_images_dir))
    for members in groups.values():
        canonical = choose_canonical([m.material_text or "" for m in members])
        _, url = write_material_doc(
            canonical, resolver=resolver, store=store,
            assets_dir=Path(assets_dir), subject_code=subject_code,
            paper_scope=paper_scope,
        )
        for m in members:
            m.material_url = url
            m.material_text = None

    # 只剩标题的材料：文章不存在，清掉（组一/五的普通文本不受影响）
    for item in items:
        if item.material_text and is_heading_only(item.material_text):
            item.material_text = None
```

- [x] **Step 4: 接入 publish 分支**

`publish_cli.py:19` 改为：

```python
from chinese_material_doc import (
    externalize_chinese_materials, externalize_english_materials, same_article,
)
```

`publish_cli.py:346`（`out_items = []` 之前，与 `if subject_code == "chinese":` 同级）插入：

```python
                elif subject_code == "english":
                    externalize_english_materials(
                        items,
                        md_images_dir=md_images_dir,
                        assets_dir=assets_dir,
                        store=store,
                        subject_code=subject_code,
                        paper_scope=rel_file.as_posix(),
                    )
```

- [x] **Step 5: 跑测试确认通过，并跑 publish 相关全量**

Run: `cd tools/data-refinery && pytest tests/test_chinese_material_doc.py tests/test_publish_cli.py -q`
Expected: PASS，语文外置与 publish 既有用例不受影响。

- [x] **Step 6: 提交**

```bash
git add tools/data-refinery/src/chinese_material_doc.py tools/data-refinery/src/publish_cli.py tools/data-refinery/tests/test_chinese_material_doc.py
git commit -m "feat(refinery): 英语共享文章外置为 material_url"
```

---

### Task 3: 完形题完整性误判豁免

**Files:**
- Modify: `tools/data-refinery/src/question_labeler.py`（新增函数 + `_fill_from_item` 内一行调用）
- Test: `tools/data-refinery/tests/test_question_labeler.py`

**Interfaces:**
- Consumes: `LabeledQuestion`（`group_order/group_id/content/material_text/is_complete/completeness_issues`，`question_labeler.py:397-427`）；`get_strategy("english").split_options(content)` 用于核对选项数。
- Produces: `apply_english_cloze_exemption(labeled, subject: str) -> int`——清掉英语组二「题干为空/缺失」类误判并计入清掉条数；返回整数供调用方按需打印。只在 `question_labeler._fill_from_item` 调用一次（按大题定型前 `group_id`/选项/材料已确定，无需像判断题那样在定型后再清一次）。

- [x] **Step 1: 写失败测试**（加到 `tests/test_question_labeler.py`）

```python
def _cloze_labeled(content, *, material="## Passage\nText", issues=None):
    return LabeledQuestion(
        group_order=13, group_id="二", content=content,
        answer="A", explanation=None, material_text=material,
        is_complete=False,
        completeness_issues=issues or ["题干为空，仅显示为'题干：'"],
    )


_OPTIONS_4 = "A. simply\nB. hopelessly\nC. mainly\nD. properly"


def test_english_cloze_empty_stem_exemption():
    from question_labeler import apply_english_cloze_exemption

    lab = _cloze_labeled(_OPTIONS_4)
    assert apply_english_cloze_exemption([lab], "english") == 1
    assert lab.is_complete is True and lab.completeness_issues == []


def test_english_cloze_exemption_requires_options_and_stem_claim():
    from question_labeler import apply_english_cloze_exemption

    few = _cloze_labeled("A. simply\nB. hopelessly")
    assert apply_english_cloze_exemption([few], "english") == 0
    assert few.is_complete is False

    other = _cloze_labeled(_OPTIONS_4, issues=["缺图"])
    assert apply_english_cloze_exemption([other], "english") == 0
    assert other.is_complete is False

    no_material = _cloze_labeled(_OPTIONS_4, material=None)
    assert apply_english_cloze_exemption([no_material], "english") == 0
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd tools/data-refinery && pytest tests/test_question_labeler.py -k english_cloze -v`
Expected: FAIL with `ImportError: cannot import name 'apply_english_cloze_exemption'`.

- [x] **Step 3: 实现豁免**（贴到 `question_labeler.py` 的 `apply_material_sections_exemption` 之后）

```python
# 完形题题干为空是正常形态：空格所在句在共享文章里，选项自带作答信息。
_CLOZE_STEM_CLAIM_RE = re.compile(r"题干(?:为空|缺失)|仅显示为?[‘'“]?题干")


def apply_english_cloze_exemption(labeled, subject: str = "english") -> int:
    if subject != "english":
        return 0
    from subject_strategies import get_strategy
    strategy = get_strategy("english")
    cleared = 0
    for lab in labeled:
        if (lab.is_complete or (lab.group_id or "").strip() != "二"
                or not (lab.material_text or "").strip()):
            continue
        issues = " ".join(str(i) for i in (lab.completeness_issues or []))
        if not _CLOZE_STEM_CLAIM_RE.search(issues):
            continue
        _, opts = strategy.split_options(lab.content or "")
        if len(opts) != 4 or not all((o.get("text") or "").strip() for o in opts):
            continue
        lab.is_complete = True
        lab.completeness_issues = []
        cleared += 1
    return cleared
```

在 `_fill_from_item` 的 `apply_true_false_exemption([labeled])`（`question_labeler.py:655`）下面插入一行：

```python
        apply_english_cloze_exemption([labeled], self._subject)
```

- [x] **Step 4: 跑测试确认通过，并跑标注全量**

Run: `cd tools/data-refinery && pytest tests/test_question_labeler.py -q`
Expected: PASS，原有判断题/知识点/材料题豁免用例不受影响。

- [x] **Step 5: 提交**

```bash
git add tools/data-refinery/src/question_labeler.py tools/data-refinery/tests/test_question_labeler.py
git commit -m "fix(refinery): 英语完形空题干不再被误判缺题干"
```

---

### Task 3b: 验收补修——OCR 题号恢复与扫描收口

**Files:**
- Modify: `tools/data-refinery/src/subject_strategies/english.py`
- Modify: `tools/data-refinery/src/question_splitter.py`
- Modify: `tools/data-refinery/src/recognition_scan.py`
- Test: `tools/data-refinery/tests/subject_strategies/test_english.py`
- Test: `tools/data-refinery/tests/test_recognition_scan.py`

- [x] 三帆卷 md 的完形第 15 题被 OCR 写成 `5.`，且前文已有第 5 题；通用重复题号保护仍保留，只有
  `EnglishStrategy.repair_duplicate_stem()` 在“组二 + 当前材料含 `_15_` + 本行可拆 4 项”时恢复为 15。
- [x] 已跑 RED：修复前切题结果为 `[5,13,14,16]`；修复后为 `[5,13,14,15,16]`。
- [x] 扫描器新增 `present` 收口：`missing/punct_stem` 对应题号已在本次 extracted 中出现时，旧 pending
  记录自动 resolved，避免 Q15 已恢复但人工队列继续报缺题。

---

### Task 4: 全量回归 + 端到端验收（不写库）

**Files:** 无代码改动；只跑验证。

**Interfaces:** Consumes Task 1–3 的全部产出。Produces: 验收记录（贴进 commit message 或交付说明），不写 MySQL。

- [x] **Step 1: 跑 refinery 全量回归**

Run: `cd tools/data-refinery && pytest -q`
Expected: 全 PASS。最终实测 `2255 passed / 10 skipped`。

- [x] **Step 2: 一条命令跑端到端验收**

Run:

```bash
cd tools/data-refinery && python src/import_cli.py --subject 英语 --year 2026 --file "西城·三帆中学" --re-extract --re-publish --skip-load --skip-answers --skip-review
```

Expected: 9 步中 convert/extract/publish/meta 正常结束；`--re-extract --re-publish` 清掉该卷提取/发布 checkpoint（否则会跳过，新规则不生效），`--skip-load` 保证不写 MySQL；该命令会覆盖 output 下该卷的派生 jsonl 与 assets（属可再生的派生数据）。

- [x] **Step 3: 核对验收点**

检查 `output/published/英语/初中/first/2026/英语-初三(上)-202607-西城·三帆中学-期末-试卷/英语-初三(上)-202607-西城·三帆中学-期末-试卷.jsonl` 与 `output/assets/materials/english/`：

- 13 / 24 / 27 / 30 / 34 号题有 `material_url`、`material_text` 为空；
- 24–26、27–29、30–33、34–37 各共用一个 URL，四组互不相同；
- 文章 md 开头不含「阅读短文 / 本部分共 / 四、阅读表达 / 阅读下面的短文」；
- 38 号 `content` 只剩第一段指令句，`material_text` 含「题目①」「题目②」；
- 1–12 号两列都空；21–23 仍缺（已知不在范围）；
- `output/labeling_issues.jsonl` 不再出现 Q15「题干为空」与 Q38「缺两个题目选项」。

- [x] **Step 4: 记录验收结果**

把 Step 1 与 Step 3 的结论追加到 `docs/ai-core-changelog.md` 一条日期记录（只记本次范围与结果，不写老日志），然后提交：

```bash
git add docs/ai-core-changelog.md
git commit -m "docs: 记录英语材料化解析验收结果"
```

---

## Self-Review（写完后自检，已在本文件内完成）

- **Spec 覆盖**：裁决表 7 项 → Task 1/2/3/4 全覆盖；非目标 6 项 → Global Constraints 与「不改」清单逐条约束；测试 4 项 → Task 1/2/3 的失败测试 + Task 4 全量与验收。
- **占位符**：无 TBD/TODO；每个代码步骤都给出完整代码块。
- **类型一致**：`attach_post_material(questions, lines, md_path_stem)`、`externalize_english_materials(items, *, md_images_dir, assets_dir, store, subject_code, paper_scope)`、`apply_english_cloze_exemption(labeled, subject)` 三处签名在定义、调用、测试里完全一致；`group_id` 用中文数字 `"一"/"二"/"三"/"四"/"五"`，与现有 jsonl 实测一致。
