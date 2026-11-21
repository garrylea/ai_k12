# 语文材料文档化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把语文阅读理解的文章从 `questions.material_text` 迁到 `materials/chinese/{doc_key}/content.md`（`material_url` 指向它），`material_text` 只保留题中素材；前端按 URL 取文渲染，判题/解析读同一份文件。

**Architecture:** 文章外置在 publish 阶段完成（整卷可见、可物化图片）；存量用只读 DB 的回填脚本迁移。publish/回填只跑确定性规则，LLM 兜底单独 CLI。服务端接口新增 `materialUrl`，前端用共享 hook 取文并缓存，PDF 打印前预加载。

**Tech Stack:** Python 3.10 + pytest（tools/data-refinery、tools/db）、NestJS + vitest（apps/server）、React + vitest + testing-library（apps/web）、MySQL（pymysql / mysql2）。

## Global Constraints

- 只做语文（chinese）；物理/化学/道法的 `material_text` 不动。
- 不新增数据库表/列；`material_url` 复用现有列。`material_method` 复用现有列。
- 不新增 `materialDoc` 接口字段；文章入口只有 `materialUrl`。
- publish / 回填不调 LLM；LLM 只在 `chinese_inline_material_cli.py` 里跑。**本期不实现该 CLI**：规则切不动的题只落 `output/material_inline_review.jsonl`，人工补切；LLM CLI 列为后续。
- `docs/API接口与数据流设计文档.md` 与 `docs/api/openapi.yaml` 必须同步；`docs/K12智学系统-数据库设计文档.md` 的材料字段说明同步。
- 页面文案/组件不使用 emoji；图标用线性 SVG（本计划不新增图标）。
- 组件改动必须补渲染测试；`globals: false`，多用例测试文件自己写 `afterEach(() => cleanup())`。
- 任何回填脚本必须可 dry-run、可幂等、写 rollback SQL。
- 提交信息用 `feat:` / `fix:` / `docs:` 前缀；每个 Task 单独提交。

---

### Task 1: 文章归一化与 doc_key

**Files:**
- Create: `tools/data-refinery/src/chinese_material_doc.py`
- Test: `tools/data-refinery/tests/test_chinese_material_doc.py`

**Interfaces:**
- Produces:
  - `strip_emphasis(text: str) -> str`
  - `normalize_for_group(text: str) -> str`
  - `strip_section_instruction(text: str) -> str`
  - `is_heading_only(text: str) -> bool`
  - `annotation_score(text: str) -> int`
  - `choose_canonical(variants: list[str]) -> str`
  - `doc_key(body: str, image_hashes: list[str]) -> str`

- [ ] **Step 1: Write the failing tests**

Create `tools/data-refinery/tests/test_chinese_material_doc.py`:

```python
from chinese_material_doc import (
    annotation_score,
    choose_canonical,
    doc_key,
    is_heading_only,
    normalize_for_group,
    strip_section_instruction,
)


def test_strip_section_instruction_drops_paper_specific_line():
    text = "## (三)阅读下面《醉翁亭记》，完成 12-14题。(共 7分)\n\n## 醉翁亭记\n\n欧阳修"
    out = strip_section_instruction(text)
    assert out.startswith("## 醉翁亭记")
    assert "完成 12-14题" not in out


def test_strip_section_instruction_keeps_article_heading():
    text = "## 前言\n\n“典则”取自唐代窦蒙……"
    assert strip_section_instruction(text) == text


def test_heading_only_true_for_mo_xie_heading():
    assert is_heading_only("## (一)默写。(共4分)") is True


def test_heading_only_false_when_body_exists():
    assert is_heading_only("## 前言\n\n正文一段。") is False


def test_normalize_ignores_emphasis_tags_and_images():
    a = '初夏<span class="cn-emphasis-dot">高</span><u>涨</u> ![x](images/a.jpg)'
    b = "初夏高涨"
    assert normalize_for_group(a) == normalize_for_group(b)


def test_normalize_drops_sub_dot_content():
    a = "我静静<sub>．．</sub>地<sub>．</sub>听着"
    b = "我静静地听着"
    assert normalize_for_group(a) == normalize_for_group(b)


def test_choose_canonical_prefers_more_annotations():
    plain = "热啊，热啊。父亲说，还好。"
    annotated = "热啊，热<u>啊。</u>父亲说，<u>还好</u>。"
    assert choose_canonical([plain, annotated]) == annotated


def test_doc_key_stable_when_only_annotation_changes():
    a = "他<span class=\"cn-emphasis-dot\">静</span>静地听着。"
    b = "他静静地听着。"
    assert doc_key(a, []) == doc_key(b, [])


def test_doc_key_changes_when_image_changes():
    body = "同一段文字"
    assert doc_key(body, ["a"]) != doc_key(body, ["b"])
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_chinese_material_doc.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'chinese_material_doc'`.

- [ ] **Step 3: Implement the module**

Create `tools/data-refinery/src/chinese_material_doc.py`:

```python
"""语文共享文章：归一化、分组、canonical 选择、doc_key。

文章 = 题号之前、本节共享的阅读对象。它只存一份 markdown，`questions.material_url`
指向它；`material_text` 只放题号之内的补充材料。
"""

from __future__ import annotations

import hashlib
import re

_SUB_DOT_RE = re.compile(r"<sub\b[^>]*>.*?</sub>", re.I | re.S)
_EMPHASIS_TAG_RE = re.compile(r"</?(?:u|span)\b[^>]*>", re.I)
_IMAGE_REF_RE = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")
# 卷面小节指令：含「阅读…完成…题」，带题号/分值，不属于文章
_SECTION_INSTRUCTION_RE = re.compile(
    r"^#{1,6}\s*.*(?:阅读下面|阅读下文|阅读下面材料|阅读).{0,24}完成.{0,12}题"
)
_PAGE_MARKER_RE = re.compile(
    r"^(?:第\s*\d+\s*页.*|.*BEIJING\s*ZHONGKAO.*)$", re.I
)


def strip_emphasis(text: str) -> str:
    """去标注：<u>/<span> 只去标签；<sub> 是加点符号（．．），连内容一起去。"""
    s = _SUB_DOT_RE.sub("", text or "")
    return _EMPHASIS_TAG_RE.sub("", s)


def normalize_for_group(text: str) -> str:
    """分组/命名的归一化文本：去标注标签、去图片引用、去所有空白。"""
    s = strip_emphasis(text or "")
    s = _IMAGE_REF_RE.sub("", s)
    return re.sub(r"\s+", "", s)


def strip_section_instruction(text: str) -> str:
    """删掉首行的卷面小节指令（只删第一段的第一行）。"""
    lines = (text or "").splitlines()
    while lines and not lines[0].strip():
        lines.pop(0)
    if lines and _SECTION_INSTRUCTION_RE.match(lines[0].strip()):
        lines.pop(0)
    while lines and not lines[0].strip():
        lines.pop(0)
    return "\n".join(lines).strip()


def is_heading_only(text: str) -> bool:
    """去标题/图片/页码后没有正文 → 纯小节标题（如「## (一)默写。(共4分)」）。"""
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#"):
            continue
        if _IMAGE_REF_RE.fullmatch(line):
            continue
        if _PAGE_MARKER_RE.match(line):
            continue
        return False
    return True


def annotation_score(text: str) -> int:
    """真实标注（<u> + 加点 span）优先；<sub> 是退化的点号，扣分。"""
    spans = len(re.findall(r"<span\s+class=\"cn-emphasis-dot\"", text or ""))
    unders = len(re.findall(r"<u\b", text or ""))
    subs = len(re.findall(r"<sub\b", text or ""))
    return (spans + unders) * 2 - subs


def choose_canonical(variants: list[str]) -> str:
    """标注最全的版本；持平取最长。"""
    if not variants:
        raise ValueError("variants is empty")
    return max(variants, key=lambda t: (annotation_score(t), len(t)))


def doc_key(body: str, image_hashes: list[str]) -> str:
    """文章身份：归一化正文 + 图片内容哈希。只改标注不换 key。"""
    payload = normalize_for_group(strip_section_instruction(body))
    payload += "\n" + "\n".join(sorted(image_hashes))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_chinese_material_doc.py -q`
Expected: `9 passed`.

- [ ] **Step 5: Commit**

```bash
git add tools/data-refinery/src/chinese_material_doc.py tools/data-refinery/tests/test_chinese_material_doc.py
git commit -m "feat(refinery): add chinese material doc normalization helpers"
```

---

### Task 2: 题中素材切分（八中 14 题形态）

**Files:**
- Create: `tools/data-refinery/src/subject_strategies/chinese_inline_material.py`
- Test: `tools/data-refinery/tests/test_chinese_inline_material.py`

**Interfaces:**
- Produces: `split_inline_material(content: str) -> tuple[str | None, str]`
  - 返回 `(material_text, rest)`；不切返回 `(None, content)`。
  - 自校验：`normalize(material + rest) == normalize(content)`。

- [ ] **Step 1: Write the failing tests**

Create `tools/data-refinery/tests/test_chinese_inline_material.py`:

```python
import re

from subject_strategies.chinese_inline_material import split_inline_material


def _norm(s: str) -> str:
    return re.sub(r"\s+", "", s or "")


Q14 = (
    "联系《醉翁亭记》及下面材料，在后面语段的横线上填写恰当的内容。(3分)\n"
    "予以罪废①，无所归，扁舟吴中。一日过郡学，东顾草树郁然，崇阜②广水，不类乎城中。"
    "予爱而徘徊，遂以钱四万得之，构亭北辟③，号“沧浪”焉。予时榜④小舟，幅巾⑤以往，"
    "至则洒然忘其归。觞而浩歌，踞而仰啸，野老不至，鱼鸟共乐。形骸既适则神不烦，"
    "观听无邪则道以明。返思向之汩汩荣辱之场，日与锱铢利害相磨戛⑥，隔此真趣，不亦鄙哉！\n"
    "（取材于苏舜钦《沧浪亭记》）\n"
    "注：①罪废：因获罪被罢官 ②崇阜：高山 ③琦（qí）：曲折的堤岸 ④榜（bàng）：划船 "
    "⑤幅巾：以丝巾裹头，指着便装 ⑥磨戛（jiá）：摩擦碰撞欧阳修与苏舜钦同处贬谪之境，"
    "都借山水安顿身心，但“乐”的内涵不同。"
    "苏舜钦在沧浪亭中时而放声高歌，时而蹲坐长啸，没有村野老人来访，唯有“ ①”，"
    "这种远离官场的生活令他形骸安适、心神清宁，所见所闻皆“ ② ”，"
    "对道义的体悟也愈发清明通透。而欧阳修的太守之“乐”，不止于山间朝暮四时的景致之美，"
    "更深一层在于 ③"
)


def test_q14_splits_note_and_answer_paragraph():
    material, rest = split_inline_material(Q14)
    assert material is not None
    assert material.startswith("联系《醉翁亭记》")
    assert "注：①罪废" in material
    assert material.rstrip().endswith("但“乐”的内涵不同。")
    assert rest.startswith("苏舜钦在沧浪亭中")
    assert _norm(material + rest) == _norm(Q14)


def test_note_is_on_its_own_line():
    material, _ = split_inline_material(Q14)
    assert "\n注：①罪废" in material


def test_no_lead_no_split():
    content = "下列加点字意思都相同的一项是(2分)\n" + "A.甲 B.乙 C.丙 D.丁。" * 12
    material, rest = split_inline_material(content)
    assert material is None
    assert rest == content


def test_bare_material_marker_without_lead_no_split():
    content = "材料：这是一段说明文字，讲的是城市与河流的关系。" + "请简要概括本文的中心论点。" * 8
    material, rest = split_inline_material(content)
    assert material is None
    assert rest == content


def test_short_content_no_split():
    content = "请联系下面材料作答。"
    material, rest = split_inline_material(content)
    assert material is None
    assert rest == content


def test_link_material_marker_splits():
    content = (
        "请结合下面的链接材料，说说你对文章第④段画线句的理解。(3分)\n\n"
        "【链接材料】：上世纪初，青年毛泽东在刻苦读书的岁月中，一直坚持“自讨苦吃”。"
        "烈日炎炎的盛夏，别人待在寝室摇扇避暑，他却赤背顶着骄阳暴晒。\n\n"
        "结合材料，谈谈你的理解。"
    )
    material, rest = split_inline_material(content)
    assert material is not None
    assert "【链接材料】" in material
    assert rest.startswith("结合材料")
    assert _norm(material + rest) == _norm(content)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_chinese_inline_material.py -q`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement the splitter**

Create `tools/data-refinery/src/subject_strategies/chinese_inline_material.py`:

```python
"""语文题中素材切分：题号之内、这道题自己带的补充材料。

与 `material_split`（物理/化学题内材料）的区别：语文的题中材料通常由
「联系/阅读/结合…下面材料」引导，且常带 `注：①…` 注释块；没有 (1)(2) 小问。

只做确定性规则，不调 LLM。规则切不动的题由 publish/回填写 review 清单，
交给 `chinese_inline_material_cli.py` 用 LLM 判切点后回写。
"""

from __future__ import annotations

import re

LEAD_RE = re.compile(
    r"(?:联系|结合|阅读|参考|请阅读|请结合)[^\n。]{0,30}?"
    r"(?:下面|上述|以上|以下)[^\n。]{0,10}?"
    r"(?:材料|语段|文字|短文|诗句|文章)"
)
NOTE_RE = re.compile(r"(?m)^\s*注\s*[:：]")
# 只认「①词条：释义」形态，避免把题干里的「“ ①”」「“ ② ”」占位符当成注条目。
NOTE_ITEM_RE = re.compile(r"[①-⑳][^①-⑳\s]{0,12}[：:]")
LINK_MARK_RE = re.compile(r"【链接材料】|材料\s*[:：]")
QUESTION_LEAD_RE = re.compile(r"^(?:结合|根据|请|谈谈|说说|分析|概括|说明|简要)")
MIN_CONTENT_LEN = 80
MIN_MATERIAL_LEN = 60


def _norm(s: str) -> str:
    return re.sub(r"\s+", "", s or "")


def _cut_after_note(content: str) -> int | None:
    """注块切点：最后一个 ①–⑳ 条目之后的第一个「。」。"""
    m = NOTE_RE.search(content)
    if not m:
        return None
    tail = content[m.end():]
    items = list(NOTE_ITEM_RE.finditer(tail))
    if not items:
        return None
    end = tail.find("。", items[-1].end())
    if end < 0:
        return None
    return m.end() + end + 1


def _split_by_note(content: str) -> tuple[str, str] | None:
    cut = _cut_after_note(content)
    if cut is None:
        return None
    material = content[:cut].rstrip()
    rest = content[cut:].lstrip("\n ")
    # 注独占一行（只影响展示；自校验按空白归一）
    material = NOTE_RE.sub(lambda m: "\n" + m.group(0).lstrip(), material, count=1)
    if len(_norm(material)) < MIN_MATERIAL_LEN or not rest.strip():
        return None
    return material.strip(), rest


def _split_by_link_marker(content: str) -> tuple[str, str] | None:
    """【链接材料】/材料:：取到最后一个以设问开头的段落之前。

    裸 `材料：` 只有在同时命中引导语（联系/阅读/结合…下面材料）时才切；
    否则任何提到「材料：」的题干都会被误切成材料。`【链接材料】` 可独立命中。
    """
    if not LINK_MARK_RE.search(content):
        return None
    if "【链接材料】" not in content and not LEAD_RE.search(content):
        return None
    paras = content.split("\n\n")
    if len(paras) < 2:
        return None
    last = paras[-1].strip()
    if not last or not QUESTION_LEAD_RE.match(last):
        return None
    cut = content.rfind(last)
    material = content[:cut].rstrip()
    rest = content[cut:]
    if len(_norm(material)) < MIN_MATERIAL_LEN:
        return None
    return material, rest


def split_inline_material(content: str) -> tuple[str | None, str]:
    """返回 (material_text, rest)；不切返回 (None, content)。"""
    if not content or len(content) < MIN_CONTENT_LEN:
        return None, content

    by_note = _split_by_note(content)
    if by_note:
        material, rest = by_note
        if _norm(material) + _norm(rest) == _norm(content):
            return material, rest
        return None, content

    by_link = _split_by_link_marker(content)
    if by_link:
        material, rest = by_link
        if _norm(material) + _norm(rest) == _norm(content):
            return material, rest
    return None, content


def needs_llm(content: str) -> bool:
    """规则没切、但看起来像题中材料题 → 值得进 LLM 复核清单。"""
    return bool(content and len(content) >= 200 and LEAD_RE.search(content))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_chinese_inline_material.py -q`
Expected: `5 passed`.

- [ ] **Step 5: Commit**

```bash
git add tools/data-refinery/src/subject_strategies/chinese_inline_material.py tools/data-refinery/tests/test_chinese_inline_material.py
git commit -m "feat(refinery): split chinese in-question material by note/link markers"
```

---

### Task 3: 写文章 md + 图片物化

**Files:**
- Modify: `tools/data-refinery/src/image_rewrite.py`
- Modify: `tools/data-refinery/src/chinese_material_doc.py`
- Modify: `tools/data-refinery/src/db_loader.py`（只加 `content_hash` 的第 4 个可选参数，供 `rewrite_hash_for_row` 使用）
- Test: `tools/data-refinery/tests/test_chinese_material_doc.py`

**Interfaces:**
- Produces:
  - `image_rewrite.image_hashes_for(text, resolver) -> list[str]`
  - `image_rewrite.rewrite_material_doc(text, resolver, asset_store, asset_prefix) -> tuple[str, list[str]]`
  - `chinese_material_doc.write_material_doc(body, *, resolver, store, assets_dir, subject_code) -> tuple[str, str]`（返回 `doc_key`, `material_url`）
- Consumes/extends: `db_loader.content_hash(content, options=None, material=None, material_url=None)` — 第 4 参在本 Task 提前加入（`rewrite_hash_for_row` 依赖它）；Task 5 只负责 loader 调用点与白名单。

- [ ] **Step 1: Add failing tests**

Append to `test_chinese_material_doc.py`:

```python
from pathlib import Path

from chinese_material_doc import build_groups, rewrite_hash_for_row, write_material_doc


class _Store:
    def __init__(self, root: Path):
        self.root = root

    def put(self, rel: str, src: Path) -> None:
        dest = self.root / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(src.read_bytes())


def test_write_material_doc_writes_md_and_images(tmp_path):
    assets = tmp_path / "assets"
    src_dir = tmp_path / "src"
    src_dir.mkdir()
    (src_dir / "a.jpg").write_bytes(b"img-a")
    body = "## 醉翁亭记\n\n环滁皆山也。\n\n![](images/a.jpg)"

    def resolver(ref: str):
        for c in (src_dir / ref, src_dir / "images" / Path(ref).name, src_dir / Path(ref).name):
            if c.exists():
                return c
        return None

    key, url = write_material_doc(
        body,
        resolver=resolver,
        store=_Store(assets),
        assets_dir=assets,
        subject_code="chinese",
    )

    assert url == f"materials/chinese/{key}/content.md"
    md = (assets / url).read_text(encoding="utf-8")
    assert "## 醉翁亭记" in md
    assert f"materials/chinese/{key}/fig_01.jpg" in md
    assert (assets / f"materials/chinese/{key}/fig_01.jpg").exists()


def test_build_groups_by_paper_and_normalized_text():
    rows = [
        {"id": 1, "paper_id": 667, "source": "八中", "material_text": "## 醉翁亭记\n\n甲"},
        {"id": 2, "paper_id": 667, "source": "八中", "material_text": "## 醉翁亭记\n\n甲"},
        {"id": 3, "paper_id": 667, "source": "八中", "material_text": "## 前言\n\n乙"},
    ]
    groups = build_groups(rows)
    assert len(groups) == 2
    assert sorted(len(v) for v in groups.values()) == [1, 2]


def test_rewrite_hash_for_row_uses_material_url():
    row = {"content": "题干", "options": None, "material_text": None,
           "material_url": "materials/chinese/aaa/content.md"}
    h = rewrite_hash_for_row(row)
    assert len(h) == 64
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_chinese_material_doc.py -q`
Expected: FAIL with `ImportError: cannot import name 'write_material_doc'`（以及 `build_groups` / `rewrite_hash_for_row`）。

- [ ] **Step 3: Add public image helpers**

Modify `tools/data-refinery/src/image_rewrite.py`:

```python
def image_hashes_for(text: str | None, resolver: Callable[[str], Path | None]) -> list[str]:
    """按出现顺序返回图片内容的 sha256（读不到源图则跳过）。"""
    import hashlib

    out: list[str] = []
    for m in IMAGE_REF_RE.finditer(text or ""):
        src = resolver(m.group(1))
        if src is not None and src.exists():
            out.append(hashlib.sha256(src.read_bytes()).hexdigest())
    return out


def rewrite_material_doc(
    text: str,
    resolver: Callable[[str], Path | None],
    asset_store: AssetStore,
    asset_prefix: str,
) -> tuple[str, list[str]]:
    """把文章正文里的图片按 fig_NN 物化到 asset_prefix，返回 (新正文, 物化路径)。"""
    materialized: list[str] = []
    index = 0

    def replace(m: re.Match) -> str:
        nonlocal index
        alt, ref = m.group(1), m.group(2)
        src = resolver(ref)
        if src is None or not src.exists():
            # 已是规范路径但本环境解析不到（http/data/未物化）→ 原样保留
            print(f"[WARN] 文章图片源缺失，保留原引用：{ref}", flush=True)
            return m.group(0)
        index += 1
        rel = f"{asset_prefix}/fig_{index:02d}{_ext_of(ref)}"
        asset_store.put(rel, src)
        materialized.append(rel)
        return f"![{alt}]({rel})"

    return IMAGE_REF_RE.sub(replace, text or ""), materialized
```

Add `materials/` and `material/` to `_CANONICAL_PREFIXES`:

```python
_CANONICAL_PREFIXES = (
    "questions/", "textbooks/", "materials/", "material/",
    "/assets/", "http://", "https://", "data:",
)
```

再给 `db_loader.content_hash` 加第 4 个可选参数（`rewrite_hash_for_row` 依赖它；Task 5 不再重复改签名）：

```python
def content_hash(content: str | None, options=None, material: str | None = None,
                 material_url: str | None = None) -> str:
    ...
    mat = material_fingerprint(f"{material_url or ''}\n{material or ''}")
    ...
```

- [ ] **Step 4: Implement `write_material_doc`**

Append to `tools/data-refinery/src/chinese_material_doc.py`:

```python
from pathlib import Path
from typing import Callable

from image_rewrite import image_hashes_for, rewrite_material_doc


def write_material_doc(
    body: str,
    *,
    resolver: Callable[[str], Path | None],
    store,
    assets_dir: Path,
    subject_code: str = "chinese",
) -> tuple[str, str]:
    """写 `materials/{subject}/{doc_key}/content.md`，返回 (doc_key, material_url)。"""
    from page_markers import strip_page_markers

    clean, _ = strip_page_markers(strip_section_instruction(body))
    hashes = image_hashes_for(clean, resolver)
    key = doc_key(clean, hashes)
    prefix = f"materials/{subject_code}/{key}"
    new_body, _ = rewrite_material_doc(clean, resolver, store, prefix)
    out = Path(assets_dir) / prefix / "content.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(new_body.strip() + "\n", encoding="utf-8")
    return key, f"{prefix}/content.md"


def build_groups(rows: list[dict]) -> dict[str, list[dict]]:
    """按 (paper_id 或 source) + 归一化 material_text 分组。纯标题组不返回。"""
    groups: dict[str, list[dict]] = {}
    for row in rows:
        text = row.get("material_text") or ""
        if not text.strip() or is_heading_only(text):
            continue
        key = f"{row.get('paper_id') or row.get('source')}\x1f{normalize_for_group(text)}"
        groups.setdefault(key, []).append(row)
    return groups


def rewrite_hash_for_row(row: dict) -> str:
    """回填后用新的 material_url 重算 content_hash（与 db_loader 同口径）。"""
    import json

    from db_loader import content_hash

    opts = row.get("options")
    if isinstance(opts, str):
        opts = json.loads(opts) if opts.strip() else None
    return content_hash(
        row.get("content"), opts,
        row.get("material_text"), row.get("material_url"),
    )
```

- [ ] **Step 5: Run the full module tests**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_chinese_material_doc.py -q`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add tools/data-refinery/src/image_rewrite.py tools/data-refinery/src/chinese_material_doc.py tools/data-refinery/tests/test_chinese_material_doc.py
git commit -m "feat(refinery): write chinese material markdown docs with fig_NN images"
```

---

### Task 4: publish 集成文章外置

**Files:**
- Modify: `tools/data-refinery/src/models.py`
- Modify: `tools/data-refinery/src/chinese_material_doc.py`
- Modify: `tools/data-refinery/src/publish_cli.py`
- Test: `tools/data-refinery/tests/test_publish_cli.py`

**Interfaces:**
- Produces: `externalize_chinese_materials(items, *, md_images_dir, assets_dir, store, subject_code) -> None`
  - 就地改 `ExamQuestion`：设 `material_url`、`material_text`、`material_method`，并可能改 `content`。

- [ ] **Step 1: Add `material_method` to the model**

In `tools/data-refinery/src/models.py`, add after `material_url`:

```python
    material_method: str | None = None  # rule|llm|manual；题中素材抽取方式
```

- [ ] **Step 2: Write the failing publish test**

Append to `tools/data-refinery/tests/test_publish_cli.py`:

```python
def test_chinese_publish_writes_material_doc_and_clears_text(tmp_path):
    out = tmp_path / "out"
    ext = out / "extracted" / "语文" / "试卷"
    ext.mkdir(parents=True)
    article = "## 醉翁亭记\n\n环滁皆山也。其西南诸峰，林壑尤美。"
    rows = [
        {"subject_id": "chinese", "type": "choice", "difficulty": 2,
         "content": "下列加点字意思都相同的一项是", "answer": "A", "material_text": article},
        {"subject_id": "chinese", "type": "choice", "difficulty": 2,
         "content": "下列翻译正确的是", "answer": "B", "material_text": article},
    ]
    (ext / "试卷.jsonl").write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n",
        encoding="utf-8",
    )
    (out / "md" / "语文" / "试卷").mkdir(parents=True)

    with patch("publish_cli.RefineryConfig") as mock_config:
        mock_config.from_env.return_value = MagicMock(output_dir=out)
        main(["--input-dir", str(out / "extracted"), "--output-dir", str(out / "published")])

    published = [
        json.loads(l) for l in
        (out / "published" / "语文" / "试卷" / "试卷.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    assert published[0]["material_url"] == published[1]["material_url"]
    assert published[0]["material_url"].startswith("materials/chinese/")
    assert published[0]["material_text"] is None
    assert published[1]["material_text"] is None
    md = out / "assets" / published[0]["material_url"]
    assert md.exists()
    assert "## 醉翁亭记" in md.read_text(encoding="utf-8")
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_publish_cli.py::test_chinese_publish_writes_material_doc_and_clears_text -q`
Expected: FAIL because `material_url` is null.

- [ ] **Step 4: Implement `externalize_chinese_materials`**

Append to `chinese_material_doc.py`:

```python
from subject_strategies.chinese_inline_material import needs_llm, split_inline_material


def _resolver_for(md_images_dir: Path):
    from image_rewrite import _resolve_src

    return lambda ref: _resolve_src(ref, md_images_dir)


def externalize_chinese_materials(
    items,
    *,
    md_images_dir: Path,
    assets_dir: Path,
    store,
    subject_code: str = "chinese",
) -> None:
    """publish 阶段：文章 → md + material_url；题中素材 → material_text。"""
    groups: dict[str, list] = {}
    for item in items:
        text = item.material_text or ""
        if not text.strip() or is_heading_only(text):
            continue
        groups.setdefault(normalize_for_group(text), []).append(item)

    resolver = _resolver_for(Path(md_images_dir))
    for members in groups.values():
        canonical = choose_canonical([m.material_text or "" for m in members])
        key, url = write_material_doc(
            canonical, resolver=resolver, store=store,
            assets_dir=Path(assets_dir), subject_code=subject_code,
        )
        for m in members:
            m.material_url = url
            m.material_text = None
            m.material_method = None

    # 纯标题的分组：文章不存在，material_text 清掉
    for item in items:
        if item.material_text and is_heading_only(item.material_text):
            item.material_text = None

    # 题中素材（必须在文章分组之后，否则会覆盖 material_text）
    review: list[dict] = []
    for item in items:
        material, rest = split_inline_material(item.content)
        if material:
            item.content = rest
            item.material_text = material
            item.material_method = "rule"
        elif needs_llm(item.content):
            review.append({"group_order": item.group_order, "content": item.content})
    if review:
        review_path = Path(assets_dir).parent / "material_inline_review.jsonl"
        with review_path.open("a", encoding="utf-8") as f:
            for rec in review:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
```

Add `import json` at the top.

- [ ] **Step 5: Wire into publish**

In `tools/data-refinery/src/publish_cli.py`:

1. Bump version: `PUBLISH_VERSION = 3`.
2. Import: `from chinese_material_doc import externalize_chinese_materials`.
3. Replace the per-item construction/rewrite loop with:

```python
            if kind == "questions":
                items = [ExamQuestion(**raw) for raw in raw_items]
                if subject_code == "chinese":
                    externalize_chinese_materials(
                        items,
                        md_images_dir=md_images_dir,
                        assets_dir=assets_dir,
                        store=store,
                        subject_code=subject_code,
                    )
                out_items = []
                for idx, item in enumerate(items, start=1):
                    asset_prefix = f"questions/{subject_code}/{source_key}/{idx}"
                    _strip_page_markers_from_question(item, rel)
                    rewrite_item(item, kind, md_images_dir, store, asset_prefix)
                    out_items.append(item.model_dump(mode="json"))
            else:
                out_items = []
                for idx, raw in enumerate(raw_items, start=1):
                    item = TextbookCard(**raw)
                    asset_prefix = f"textbooks/{subject_code}/{source_key}/{item.sort_order}"
                    rewrite_item(item, kind, md_images_dir, store, asset_prefix)
                    out_items.append(item.model_dump(mode="json"))
```

- [ ] **Step 6: Run publish tests**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_publish_cli.py -q`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add tools/data-refinery/src/models.py tools/data-refinery/src/chinese_material_doc.py tools/data-refinery/src/publish_cli.py tools/data-refinery/tests/test_publish_cli.py
git commit -m "feat(refinery): externalize chinese articles to markdown in publish"
```

---

### Task 5: db_loader 写 material_url、hash 与白名单

**Files:**
- Modify: `tools/data-refinery/src/db_loader.py`
- Test: `tools/data-refinery/tests/test_db_loader.py`

**Interfaces:**
- Produces: `content_hash(content, options=None, material=None, material_url=None) -> str`
- Consumes: `material_url` from published JSONL.

- [ ] **Step 1: Write failing tests**

Append to `tests/test_db_loader.py`:

```python
from db_loader import content_hash


def test_hash_includes_material_url():
    a = content_hash("同一题干", None, None, "materials/chinese/aaa/content.md")
    b = content_hash("同一题干", None, None, "materials/chinese/bbb/content.md")
    assert a != b


def test_hash_unchanged_without_material():
    assert content_hash("同一题干", None, None, None) == content_hash("同一题干", None, None)


def test_materials_prefix_is_materialized():
    from db_loader import assert_materialized_images

    assert_materialized_images(
        material_text="![](materials/chinese/aaa/fig_01.jpg)",
        context="test",
    )
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_db_loader.py -q -k "material_url or materials_prefix"`
Expected: `test_hash_*` 已由 Task 3 的签名改动通过；`test_materials_prefix_is_materialized` 仍 FAIL（白名单还没改）。

- [ ] **Step 3: Whitelist `materials/` and `material/`**

`content_hash` 的第 4 参与指纹口径在 Task 3 已加，本 Task 不重复改。只改白名单：

```python
_CANONICAL_IMG_PREFIXES = (
    "questions/", "textbooks/", "materials/", "material/",
    "/assets/", "http://", "https://", "data:",
)
```

- [ ] **Step 4: Pass `material_url` at both call sites**

At `load_questions`:

```python
            chash = content_hash(content, opts, q.get("material_text"), q.get("material_url"))
```

Also update the `old_hash == chash` metadata branch to write `material_url` and `material_method`:

```python
                        self._exec(
                            "UPDATE questions SET type=%s, difficulty=%s, is_active=%s, "
                            "material_text=%s, material_url=%s, material_method=%s WHERE id=%s",
                            (q.get("type"), q.get("difficulty"), new_active,
                             q.get("material_text"), q.get("material_url"),
                             q.get("material_method"), qid))
```

并在两处落库 SQL 补 `material_method`：

- `_update_question_row` 的 UPDATE 列表加 `material_method=%s`，参数加 `q.get("material_method")`；
- INSERT 的列清单加 `material_method`，`VALUES` 加一个 `%s`，参数加 `q.get("material_method")`。

- [ ] **Step 5: Run db_loader tests**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_db_loader.py -q`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add tools/data-refinery/src/db_loader.py tools/data-refinery/tests/test_db_loader.py
git commit -m "feat(refinery): persist material_url and hash article identity"
```

---

### Task 6: 存量回填脚本（只语文）

**Files:**
- Create: `tools/db/material_doc_backfill.py`
- Test: `tools/data-refinery/tests/test_material_doc_backfill.py`

**Interfaces:**
- CLI: `python3 tools/db/material_doc_backfill.py [--paper 667] [--apply] [--limit N]`
- 默认 dry-run；`--apply` 落库。
- 产出：`tools/db/backups/YYYYMMDD_material_doc_rollback.sql`、`output/material_inline_review.jsonl`。

- [ ] **Step 1: Write failing tests**

Create `tests/test_material_doc_backfill.py`（纯函数在 `chinese_material_doc`，脚本只做 DB 编排，故测试不 import 脚本）:

```python
from chinese_material_doc import build_groups, rewrite_hash_for_row


def test_build_groups_by_paper_and_normalized_text():
    rows = [
        {"id": 1, "paper_id": 667, "source": "八中", "material_text": "## 醉翁亭记\n\n甲"},
        {"id": 2, "paper_id": 667, "source": "八中", "material_text": "## 醉翁亭记\n\n甲"},
        {"id": 3, "paper_id": 667, "source": "八中", "material_text": "## 前言\n\n乙"},
    ]
    groups = build_groups(rows)
    assert len(groups) == 2
    assert sorted(len(v) for v in groups.values()) == [1, 2]


def test_heading_only_group_is_dropped():
    rows = [{"id": 1, "paper_id": 667, "material_text": "## (一)默写。(共4分)"}]
    assert build_groups(rows) == {}


def test_rewrite_hash_for_row_handles_json_options():
    row = {"content": "题干", "options": "[]", "material_text": None,
           "material_url": "materials/chinese/aaa/content.md"}
    assert len(rewrite_hash_for_row(row)) == 64


def test_rewrite_hash_for_row_uses_material_url():
    a = rewrite_hash_for_row({"content": "题干", "options": None, "material_text": None,
                              "material_url": "materials/chinese/aaa/content.md"})
    b = rewrite_hash_for_row({"content": "题干", "options": None, "material_text": None,
                              "material_url": "materials/chinese/bbb/content.md"})
    assert a != b
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_material_doc_backfill.py -q`
Expected: `4 passed`（纯函数已在 Task 3 实现；若 import 失败说明 Task 3 没做完）。

- [ ] **Step 3: Implement the script**

Create `tools/db/material_doc_backfill.py` following `material_backfill.py` conventions:

```python
"""存量语文题：文章 → materials/chinese/{doc_key}/content.md + material_url。

只读 DB（不重跑 extract，避免覆盖人工修题）。默认 dry-run；--apply 才写库。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import date
from pathlib import Path

import pymysql
from pymysql.converters import escape_string

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "data-refinery" / "src"))

from chinese_material_doc import (  # noqa: E402
    build_groups,
    choose_canonical,
    is_heading_only,
    rewrite_hash_for_row,
    write_material_doc,
)
from subject_strategies.chinese_inline_material import split_inline_material  # noqa: E402

DB = dict(host="localhost", port=3306, user="ai_k12", password="ai_k12",
          database="ai_k12", charset="utf8mb4")
ASSETS = ROOT / "tools" / "data-refinery" / "output" / "assets"
BACKUP_DIR = Path(__file__).resolve().parent / "backups"


def _sql_literal(value) -> str:
    if value is None:
        return "NULL"
    return "'" + escape_string(str(value)) + "'"
```

Then add `_resolver(ref)`:

```python
def _resolver(ref: str):
    """回填时图片已经物化：先在 assets 下找，再退回源 md 目录。"""
    p = ASSETS / ref
    return p if p.exists() else None
```

Add `_store` (a tiny `AssetStore` writing into ASSETS) and the main loop:

```python
class _Store:
    def put(self, rel: str, src: Path) -> None:
        dest = ASSETS / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(src.read_bytes())


def _load_rows(cur, paper_id: int | None):
    where = "s.code='chinese'"
    params = []
    if paper_id is not None:
        where += " AND pq.paper_id=%s"
        params.append(paper_id)
    # GROUP BY q.id：一道题可能挂多张卷（跨卷共用行），只取一个 paper_id 做分组键
    cur.execute(
        f"""SELECT q.id, MIN(pq.paper_id) AS paper_id, q.source, q.content, q.options,
                   q.material_text, q.material_url, q.material_method, q.content_hash
              FROM questions q
              JOIN subjects s ON s.id=q.subject_id
              LEFT JOIN paper_questions pq ON pq.question_id=q.id
             WHERE {where}
             GROUP BY q.id
             ORDER BY q.id""",
        params,
    )
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]
```

Main:

```python
def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--paper", type=int)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--limit", type=int)
    ns = parser.parse_args(argv)

    conn = pymysql.connect(**DB, autocommit=False)
    cur = conn.cursor()
    rows = _load_rows(cur, ns.paper)
    if ns.limit:
        rows = rows[: ns.limit]

    groups = build_groups(rows)
    plans = []  # [qid, material_url, material_text, content, material_method, new_hash]
    for members in groups.values():
        canonical = choose_canonical([m.get("material_text") or "" for m in members])
        if is_heading_only(canonical):
            continue
        key, url = write_material_doc(
            canonical, resolver=_resolver, store=_Store(), assets_dir=ASSETS,
        )
        for m in members:
            plans.append([m["id"], url, None, None, None])

    by_id = {p[0]: p for p in plans}
    for row in rows:
        material, rest = split_inline_material(row.get("content") or "")
        if not material:
            continue
        plan = by_id.get(row["id"])
        if plan is None:
            plan = [row["id"], None, None, None, None]
            plans.append(plan)
            by_id[row["id"]] = plan
        plan[2] = material
        plan[3] = rest
        plan[4] = "rule"

    for plan in plans:
        qid, url, mtext, content, method = plan
        row = next(r for r in rows if r["id"] == qid)
        new_row = dict(row)
        new_row["material_url"] = url if url is not None else row.get("material_url")
        new_row["material_text"] = mtext  # 文章题为 None；题中素材题为原文
        if content is not None:
            new_row["content"] = content
        new_row["material_method"] = method
        plan.append(rewrite_hash_for_row(new_row))

    if not ns.apply:
        print(f"[dry-run] {len(plans)} rows would change")
        return 0

    backup = BACKUP_DIR / f"{date.today():%Y%m%d}_material_doc_rollback.sql"
    backup.parent.mkdir(parents=True, exist_ok=True)
    with backup.open("w", encoding="utf-8") as f:
        for qid, *_ in plans:
            r = next(r for r in rows if r["id"] == qid)
            f.write(
                "UPDATE questions SET "
                f"content={_sql_literal(r.get('content'))}, "
                f"material_text={_sql_literal(r.get('material_text'))}, "
                f"material_url={_sql_literal(r.get('material_url'))}, "
                f"material_method={_sql_literal(r.get('material_method'))}, "
                f"content_hash={_sql_literal(r.get('content_hash'))} WHERE id={qid};\n"
            )

    for qid, url, mtext, content, method, new_hash in plans:
        try:
            cur.execute(
                "UPDATE questions SET material_url=%s, material_text=%s, "
                "content=COALESCE(%s, content), material_method=%s, content_hash=%s "
                "WHERE id=%s",
                (url, mtext, content, method, new_hash, qid),
            )
        except pymysql.err.IntegrityError:
            print(f"[WARN] id={qid} content_hash 冲突，保留旧 hash", flush=True)
    conn.commit()
    print(f"[apply] {len(plans)} rows updated; rollback: {backup}")
    return 0
```

- [ ] **Step 4: Run tests**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_material_doc_backfill.py -q`
Expected: `2 passed`.

- [ ] **Step 5: Commit**

```bash
git add tools/db/material_doc_backfill.py tools/data-refinery/tests/test_material_doc_backfill.py
git commit -m "feat(db): add chinese material doc backfill with rollback"
```

---

### Task 7: 八中卷试点（人工验收，不写代码）

**Files:** 无代码；使用 Task 6 的脚本。

- [ ] **Step 1: Dry-run**

Run: `cd /Users/lichao/Downloads/claude/imooc/ai_k12 && python3 tools/db/material_doc_backfill.py --paper 667`
Expected: 打印 `[dry-run] N rows would change`，N ≥ 20。

- [ ] **Step 2: Apply**

Run: `python3 tools/db/material_doc_backfill.py --paper 667 --apply`
Expected: `[apply] N rows updated; rollback: .../backups/YYYYMMDD_material_doc_rollback.sql`。

- [ ] **Step 3: Verify DB**

Run:

```bash
mysql -h localhost -u ai_k12 -pai_k12 ai_k12 -e "
SELECT pq.question_no, q.material_url, CHAR_LENGTH(q.material_text) mtext_len,
       LEFT(REPLACE(q.content,'\n',' | '),40) content_head
  FROM paper_questions pq JOIN questions q ON q.id=pq.question_id
 WHERE pq.paper_id=667 ORDER BY pq.question_no;"
```

Expected:
- 1–8：`material_url` 非空（1 题单独一份；2/3、5/6、7/8 分别相同），`mtext_len` 为 NULL。
- 9：两列 NULL。
- 12/13/14：`material_url` 相同；14 的 `mtext_len > 0`，`content` 以「苏舜钦在沧浪亭中」开头。
- 16–18、19–22、23–25：各一组相同 URL。

- [ ] **Step 4: Verify files**

Run:

```bash
find tools/data-refinery/output/assets/materials/chinese -name content.md | head
```

Expected: 至少 9 份，`12–14` 那份首行是 `## 醉翁亭记`，不含「完成 12-14题」。

- [ ] **Step 5: 界面验收延后到 Task 11**

本 Task 只验数据（DB + 文件）。作答页/结果页/PDF 需要 Task 8–11 把 `materialUrl` 下发并渲染，界面验收放在 Task 11 最后一步，复用本次回填的 paper 667。

- [ ] **Step 6: 记录数据验收结果**

把 Step 3–4 的实际输出贴进本 Task 的完成说明；不通过则回到 Task 1–6 修，不要继续全量。

---

### Task 8: 服务端下发 materialUrl

**Files:**
- Modify: `apps/server/src/database/repositories/exam-papers.repo.ts`
- Modify: `apps/server/src/database/repositories/exam-sessions.repo.ts`
- Modify: `apps/server/src/modules/exams/exams.service.ts`
- Modify: `apps/server/src/modules/training/training.service.ts`
- Modify: `apps/server/src/modules/training/history-practice.service.ts`
- Modify: `apps/server/src/modules/practice-history/practice-history.service.ts`
- Modify: `apps/server/src/modules/exams/dto/session-create.dto.ts`
- Modify: `apps/server/src/modules/exams/dto/paper-query.dto.ts`
- Modify: `apps/server/src/modules/practice-history/practice-history.dto.ts`
- Test: 对应 `*.test.ts`

**Interfaces:**
- Produces: 所有题目载荷增加 `materialUrl: string | null`；`materialText` 语义改为题中素材。

- [ ] **Step 1: Write failing tests**

In `exam-papers.repo.test.ts` add:

```ts
it('题目元数据带 materialUrl', async () => {
  const pool = mockPool([]);
  const repo = new ExamPapersRepository(pool as any);
  await repo.findQuestionsByPaperId(17);
  const [sql] = pool.execute.mock.calls[0];
  expect(sql).toContain('q.material_text AS materialText');
  expect(sql).toContain('q.material_url AS materialUrl');
});
```

In `training.service.test.ts` change the exact-key assertion to:

```ts
expect(Object.keys(q).sort()).toEqual(
  ['materialText', 'materialUrl', 'options', 'questionId', 'questionNo', 'source', 'text', 'type'],
);
```

In `exams.service.test.ts` add to the result mapping test:

```ts
expect(r.items[0].materialUrl).toBe('materials/chinese/abc/content.md');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/server && npx vitest run src/database/repositories/exam-papers.repo.test.ts src/modules/training/training.service.test.ts src/modules/exams/exams.service.test.ts`
Expected: FAIL on missing `materialUrl`.

- [ ] **Step 3: Add the field to SQL and mappings**

`exam-papers.repo.ts`:

```ts
export interface PaperQuestionRow {
  ...
  materialText: string | null;
  materialUrl: string | null;
}
```

SQL:

```sql
q.material_text AS materialText, q.material_url AS materialUrl,
```

`training.service.ts`:

```ts
materialText: q.material_text ?? null,
materialUrl: q.material_url ?? null,
```

`history-practice.service.ts`:

```ts
materialText: q.material_text ?? null,
materialUrl: q.material_url ?? null,
```

`exams.service.ts` result mapping:

```ts
materialText: row.material_text ?? null,
materialUrl: row.material_url ?? null,
```

并在 `exam-sessions.repo.ts` 的 `findAnswersWithQuestions` SELECT 里补：

```sql
q.material_url,
```

and session question mapping:

```ts
materialText: q.materialText ?? null,
materialUrl: q.materialUrl ?? null,
```

`practice-history.service.ts`:

```ts
materialText: a.material_text,
materialUrl: a.material_url ?? null,
```

> 以上三处如果 SQL 是显式列清单（不是 `q.*`），把 `q.material_url` 补进 SELECT；否则 `q.material_url` 取不到。

- [ ] **Step 4: Update DTOs**

Add `materialUrl: string | null;` next to every `materialText` in:
`session-create.dto.ts`、`paper-query.dto.ts`、`practice-history.dto.ts`。

- [ ] **Step 5: Run tests**

Run: `cd apps/server && npx vitest run src/database/repositories/exam-papers.repo.test.ts src/modules/training/training.service.test.ts src/modules/exams/exams.service.test.ts src/modules/training/history-practice.service.test.ts src/modules/practice-history/practice-history.service.test.ts`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/database/repositories apps/server/src/modules
git commit -m "feat(server): expose materialUrl on question payloads"
```

---

### Task 9: 判题/解析读取文章

**Files:**
- Create: `apps/server/src/modules/practice/material-doc.service.ts`
- Modify: `apps/server/src/modules/practice/practice.module.ts`
- Modify: `apps/server/src/modules/practice/judge-core.service.ts`
- Modify: `apps/server/src/modules/practice/explanation-cache.service.ts`
- Test: `apps/server/src/modules/practice/material-doc.service.test.ts`

**Interfaces:**
- Produces: `MaterialDocService.getText(url: string | null | undefined): Promise<string | null>`
- 只读相对路径，路径必须在 assetsDir 内；失败返回 null。

- [ ] **Step 1: Write failing tests**

Create `material-doc.service.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MaterialDocService } from './material-doc.service';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mds-')); process.env.ASSETS_DIR = dir; });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); delete process.env.ASSETS_DIR; });

describe('MaterialDocService', () => {
  it('reads a relative doc under assetsDir', async () => {
    fs.mkdirSync(path.join(dir, 'materials/chinese/a'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'materials/chinese/a/content.md'), '## 醉翁亭记');
    const svc = new MaterialDocService();
    await expect(svc.getText('materials/chinese/a/content.md')).resolves.toBe('## 醉翁亭记');
  });

  it('rejects path traversal', async () => {
    const svc = new MaterialDocService();
    await expect(svc.getText('../../etc/passwd')).resolves.toBeNull();
  });

  it('does not fetch absolute urls', async () => {
    const svc = new MaterialDocService();
    await expect(svc.getText('https://example.com/a.md')).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run src/modules/practice/material-doc.service.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement the service**

Create `material-doc.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class MaterialDocService {
  private readonly logger = new Logger(MaterialDocService.name);
  private readonly assetsDir: string;
  private readonly cache = new Map<string, { text: string; mtimeMs: number }>();

  private readonly assetsDir: string;
  // 刻意不写构造函数参数：带 @Injectable() 的类有接口/union 参数时，
  // design:paramtypes 会写成 Object/String，Nest 找不到 token 会启动失败。
  constructor() {
    this.assetsDir = path.resolve(
      process.env.ASSETS_DIR
        ?? path.resolve(process.cwd(), '../../tools/data-refinery/output/assets'),
    );
  }

  async getText(url: string | null | undefined): Promise<string | null> {
    if (!url || /^(?:https?:)?\/\//.test(url) || url.startsWith('data:')) return null;
    const abs = path.resolve(this.assetsDir, url);
    if (!abs.startsWith(this.assetsDir + path.sep)) {
      this.logger.warn(`material_url 越界，忽略：${url}`);
      return null;
    }
    try {
      const stat = fs.statSync(abs);
      const hit = this.cache.get(abs);
      if (hit && hit.mtimeMs === stat.mtimeMs) return hit.text;
      const text = fs.readFileSync(abs, 'utf-8');
      this.cache.set(abs, { text, mtimeMs: stat.mtimeMs });
      return text;
    } catch (err) {
      this.logger.warn(`material doc 读取失败：${url} (${String(err)})`);
      return null;
    }
  }
}
```

- [ ] **Step 4: Wire into practice module + row type**

`apps/server/src/modules/practice/practice.module.ts`:

```ts
import { MaterialDocService } from './material-doc.service.js';
// providers 数组追加
MaterialDocService,
// exports 数组追加
MaterialDocService,
```

`apps/server/src/database/repositories/types.ts` 的 `QuestionRow` 增加：

```ts
  material_url: string | null;
```

- [ ] **Step 5: Use in judge-core and explanation-cache（可选注入，别破坏现有测试）**

`judge-core.service.ts` 构造参数末尾追加（`@Optional()` 防止旧测试/未提供时启动失败）：

```ts
import { Optional } from '@nestjs/common';
import { MaterialDocService } from './material-doc.service.js';

constructor(
  ...
  private readonly events?: EventsService,
  @Optional() private readonly materialDoc?: MaterialDocService,
) {}
```

两处判题：

```ts
const docText = await this.materialDoc?.getText(q.material_url ?? null);
const material = [docText, q.material_text].filter(Boolean).join('\n\n') || null;
// ...
material,
```

`explanation-cache.service.ts` 构造参数末尾追加同样的 `@Optional() materialDoc?`，`generate()` 里：

```ts
const docText = await this.materialDoc?.getText(q.material_url ?? null);
const material = [docText, q.material_text].filter(Boolean).join('\n\n') || null;
```

- [ ] **Step 6: Add regression tests**

In `judge-core.service.test.ts`：

1. `mk()` 的默认返回值加 `materialDoc: { getText: vi.fn().mockResolvedValue(null) }`；
2. `mkSvc` 末尾传 `undefined, deps.materialDoc as any`（第 9 个是 events，第 10 个是 materialDoc）；
3. 新增：

```ts
it('material_url 存在时把文章拼进 judgment.material', async () => {
  const deps = mk({
    materialDoc: { getText: vi.fn().mockResolvedValue('## 醉翁亭记') },
    questionsRepo: {
      findById: vi.fn().mockResolvedValue({
        id: 1, type: 'short_answer', content: '题', answer: 'A',
        material_text: '题中素材', material_url: 'materials/chinese/a/content.md',
        subject_id: 2,
      }),
      findSubjectCode: vi.fn().mockResolvedValue('chinese'),
    },
  });
  const svc = mkSvc(deps);
  await svc.judgeQuestion({
    studentId: 1, subjectId: 2, questionId: 1,
    studentAnswer: '作答', source: 'targeted',
  });
  expect(deps.judgment.judge.mock.calls[0][0].material).toContain('## 醉翁亭记');
  expect(deps.judgment.judge.mock.calls[0][0].material).toContain('题中素材');
});
```

- [ ] **Step 7: Run tests**

Run: `cd apps/server && npx vitest run src/modules/practice`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/modules/practice
git commit -m "feat(server): read material docs for judging and explanations"
```

---

### Task 10: 前端取文 hook + MaterialBlock + 类型

**Files:**
- Create: `apps/web/src/hooks/useMaterialDoc.ts`
- Create: `apps/web/src/components/business/answer/MaterialBlock.tsx`
- Modify: `apps/web/src/components/business/answer/types.ts`
- Modify: `apps/web/src/components/business/AnswerModal.tsx`
- Modify: `apps/web/src/services/api.ts`
- Test: `apps/web/src/hooks/useMaterialDoc.test.tsx`
- Test: `apps/web/src/components/business/answer/MaterialBlock.test.tsx`

**Interfaces:**
- Produces:
  - `preloadMaterialDoc(url: string): Promise<string>`
  - `getCachedMaterialDoc(url: string): string | null`
  - `useMaterialDoc(url: string | null | undefined)`
  - `<MaterialBlock url text variant draggable testId className />`

- [ ] **Step 1: Write failing hook tests**

Create `useMaterialDoc.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { useMaterialDoc, preloadMaterialDoc } from './useMaterialDoc';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function Probe({ url }: { url: string }) {
  const { text, status } = useMaterialDoc(url);
  return <span data-testid="probe">{status}:{text}</span>;
}

describe('useMaterialDoc', () => {
  it('loads and caches a doc', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '## 醉翁亭记' });
    vi.stubGlobal('fetch', fetchMock);
    render(<Probe url="materials/chinese/a/content.md" />);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('ready:## 醉翁亭记'));
    await preloadMaterialDoc('materials/chinese/a/content.md');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('exposes error status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    render(<Probe url="materials/chinese/missing/content.md" />);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('error:'));
  });
});
```

- [ ] **Step 2: Run hook test to verify it fails**

Run: `cd apps/web && npx vitest run src/hooks/useMaterialDoc.test.tsx`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement the hook**

Create `useMaterialDoc.ts`:

```ts
import { useEffect, useState } from 'react';
import { resolveAsset } from '@/components/markdown';

const pending = new Map<string, Promise<string>>();
const resolved = new Map<string, string>();

export function getCachedMaterialDoc(url: string | null | undefined): string | null {
  if (!url) return null;
  return resolved.get(resolveAsset(url)) ?? null;
}

export function preloadMaterialDoc(url: string): Promise<string> {
  const key = resolveAsset(url);
  const hit = resolved.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  const existing = pending.get(key);
  if (existing) return existing;
  const p = fetch(key)
    .then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.text();
    })
    .then((text) => {
      resolved.set(key, text);
      pending.delete(key);
      return text;
    })
    .catch((err) => {
      pending.delete(key);
      throw err;
    });
  pending.set(key, p);
  return p;
}

export type MaterialDocState = {
  text: string | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  retry: () => void;
};

export function useMaterialDoc(url: string | null | undefined): MaterialDocState {
  const initial = getCachedMaterialDoc(url);
  const [text, setText] = useState<string | null>(initial);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    !url ? 'idle' : initial !== null ? 'ready' : 'loading',
  );
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!url) { setText(null); setStatus('idle'); return; }
    const cached = getCachedMaterialDoc(url);
    if (cached !== null) { setText(cached); setStatus('ready'); return; }
    let alive = true;
    setStatus('loading');
    preloadMaterialDoc(url)
      .then((t) => { if (alive) { setText(t); setStatus('ready'); } })
      .catch(() => { if (alive) { setText(null); setStatus('error'); } });
    return () => { alive = false; };
  }, [url, nonce]);

  return { text, status, retry: () => setNonce((n) => n + 1) };
}
```

- [ ] **Step 4: Implement MaterialBlock**

Create `MaterialBlock.tsx`:

```tsx
import ReactMarkdown from 'react-markdown';
import {
  draggableQuestionMarkdownComponents,
  markdownComponents,
  markdownRehypePlugins,
  markdownRemarkPlugins,
  preprocessMaterialMarkdown,
} from '@/components/markdown';
import { useMaterialDoc } from '@/hooks/useMaterialDoc';

interface MaterialBlockProps {
  url?: string | null;
  text?: string | null;
  variant?: 'answer' | 'result' | 'history' | 'print';
  /** 作答页：材料图可拖进草稿（沿用 QuestionRunner 旧行为） */
  draggable?: boolean;
  testId?: string;
  className?: string;
}

const SIZE: Record<NonNullable<MaterialBlockProps['variant']>, string> = {
  answer: 'mb-3 rounded-lg border px-3 py-2.5 text-sm',
  result: 'mb-2 max-h-[32vh] overflow-y-auto rounded-lg border px-3 py-2 text-[13px]',
  history: 'mb-3 max-h-[32vh] overflow-y-auto rounded-lg border px-3 py-2 text-[13px]',
  print: '',
};

export function MaterialBlock({
  url, text, variant = 'answer', draggable = false, testId, className = '',
}: MaterialBlockProps) {
  const { text: doc, status, retry } = useMaterialDoc(url);
  const body = [doc, text].filter((s): s is string => Boolean(s && s.trim())).join('\n\n');
  const components = draggable ? draggableQuestionMarkdownComponents : markdownComponents;
  if (!body) {
    if (status === 'loading') return <div data-testid={testId} className="text-xs text-[var(--text-tertiary)]">材料加载中…</div>;
    if (status === 'error') return (
      <button type="button" data-testid={testId} onClick={retry} className="text-xs text-[var(--brand-500)] underline">
        材料加载失败，点击重试
      </button>
    );
    return null;
  }
  return (
    <div
      data-testid={testId}
      data-material-url={url ?? undefined}
      className={`md-prose border-[var(--learn-card-border)] bg-[var(--bg-base)] text-[var(--text-primary)] leading-[1.7] ${SIZE[variant]} ${className}`}
    >
      <ReactMarkdown
        remarkPlugins={markdownRemarkPlugins}
        rehypePlugins={markdownRehypePlugins}
        components={components}
      >
        {preprocessMaterialMarkdown(body)}
      </ReactMarkdown>
    </div>
  );
}
```

- [ ] **Step 5: Add types**

`RunnerQuestion` add:

```ts
  /** 文章文档（Markdown）地址；由前端按 URL 取文 */
  materialUrl?: string | null;
```

`PracticeQuestion` in `AnswerModal.tsx` add `materialUrl?: string | null;`.

In `api.ts`, add `materialUrl: string | null;` next to each of the four `materialText` lines.

- [ ] **Step 6: Write MaterialBlock test**

Create `MaterialBlock.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MaterialBlock } from './MaterialBlock';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('MaterialBlock', () => {
  it('renders doc then in-question material', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '## 醉翁亭记' }));
    render(<MaterialBlock url="materials/chinese/a/content.md" text="注：①罪废" testId="m" />);
    await waitFor(() => expect(screen.getByTestId('m').textContent).toContain('醉翁亭记'));
    expect(screen.getByTestId('m').textContent).toContain('注：①罪废');
  });

  it('renders only text when url is absent', () => {
    render(<MaterialBlock text="题中素材" testId="m" />);
    expect(screen.getByTestId('m').textContent).toContain('题中素材');
  });
});
```

- [ ] **Step 7: Run tests**

Run: `cd apps/web && npx vitest run src/hooks/useMaterialDoc.test.tsx src/components/business/answer/MaterialBlock.test.tsx`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/hooks apps/web/src/components/business/answer apps/web/src/services/api.ts
git commit -m "feat(web): add material doc hook and MaterialBlock"
```

---

### Task 11: 四处渲染点接入 + 注释样式 + 打印

**Files:**
- Modify: `apps/web/src/components/business/answer/QuestionRunner.tsx`
- Modify: `apps/web/src/components/business/AnswerResultList.tsx`
- Modify: `apps/web/src/pages/student/PracticeHistoryDetailPage.tsx`
- Modify: `apps/web/src/components/business/print/PrintPaper.tsx`
- Modify: `apps/web/src/components/business/print/PrintPreview.tsx`
- Modify: `apps/web/src/components/business/print/usePrint.ts`
- Modify: `apps/web/src/components/markdown.tsx`
- Modify: `apps/web/src/styles/global.css`
- Modify: `apps/web/src/pages/student/training/ExamRunPage.tsx`
- Modify: `apps/web/src/pages/student/training/TargetedRunPage.tsx`
- Modify: `apps/web/src/pages/student/training/ExamResultPage.tsx`
- Test: 对应 `*.test.tsx`

- [ ] **Step 1: Write failing render tests**

In `QuestionRunner.test.tsx` change the material case to:

```tsx
it('文章 + 题中素材 + 题干按顺序渲染', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '## 醉翁亭记' }));
  render(
    <QuestionRunner
      questions={[{
        n: '14',
        text: '苏舜钦在沧浪亭中……',
        type: 'short_answer',
        materialUrl: 'materials/chinese/a/content.md',
        material: '联系《醉翁亭记》及下面材料……\n\n注：①罪废：因获罪被罢官',
      }]}
      subjectId={2}
      draftKeyPrefix="material-doc"
      variant="embedded"
      onSubmit={async (): Promise<RunnerJudgeOutcome> => ({ isCorrect: true, method: 'exact' })}
      onFinish={async () => {}}
    />,
  );
  const block = await screen.findByTestId('question-material');
  await waitFor(() => expect(block.textContent).toContain('醉翁亭记'));
  const text = block.textContent ?? '';
  expect(text.indexOf('醉翁亭记')).toBeLessThan(text.indexOf('注：①罪废'));
});
```

In `markdown.test.tsx` add（沿用文件里的 `render(src)` helper）:

```tsx
it('注：行输出 cn-material-note', () => {
  const html = render(
    preprocessMaterialMarkdown('正文。\n注：①罪废：因获罪被罢官'),
  );
  expect(html).toContain('cn-material-note');
});
```

In `PrintPaper.test.tsx` add:

```tsx
it('同 materialUrl 的连续题只印一次', () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '## 文章' }));
  render(<PrintPaper questions={[
    { n: '1', text: '题1', materialUrl: 'materials/chinese/a/content.md' },
    { n: '2', text: '题2', materialUrl: 'materials/chinese/a/content.md' },
  ]} />);
  expect(screen.getAllByTestId('print-material')).toHaveLength(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run src/components/business/answer/QuestionRunner.test.tsx src/components/markdown.test.tsx src/components/business/print/PrintPaper.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Replace the material blocks**

`QuestionRunner.tsx` — replace the `{q.material && (...)}` block with:

```tsx
          <MaterialBlock
            url={q.materialUrl}
            text={q.material}
            variant="answer"
            draggable
            testId="question-material"
            className={nonScienceSubject ? '' : 'max-h-[38vh] overflow-y-auto'}
          />
```

Import `MaterialBlock`.

`AnswerResultList.tsx` — replace `{q.material && (...)}` with:

```tsx
                      <MaterialBlock
                        url={q.materialUrl}
                        text={q.material}
                        variant="result"
                        testId="result-material"
                      />
```

`PracticeHistoryDetailPage.tsx` — replace the `{q.materialText && (...)}` block with:

```tsx
      <MaterialBlock
        url={q.materialUrl}
        text={q.materialText}
        variant="history"
        testId="history-material"
      />
```

`PrintPaper.tsx` — replace `material !== lastMaterial` with:

```tsx
        const materialKey = q.materialUrl ?? q.material ?? null;
        const showMaterial = materialKey !== null && materialKey !== lastMaterial;
        lastMaterial = materialKey;
```

and the material JSX with:

```tsx
            {showMaterial && (
              <div className="print-material md-prose" data-testid="print-material">
                <MaterialBlock
                  url={q.materialUrl}
                  text={q.material}
                  variant="print"
                />
              </div>
            )}
```

- [ ] **Step 4: Map materialUrl in pages**

`ExamRunPage.tsx`:

```tsx
        material: q.materialText,
        materialUrl: q.materialUrl,
```

`TargetedRunPage.tsx` (two mappings):

```tsx
        material: e.materialText,
        materialUrl: e.materialUrl,
```

```tsx
    () => (entries ?? []).map((e) => ({
      n: String(e.questionId), text: e.text,
      material: e.materialText, materialUrl: e.materialUrl,
    })),
```

`ExamResultPage.tsx`:

```tsx
    () => (items ?? []).map((it) => ({
      n: String(it.questionNo), text: it.text,
      material: it.materialText, materialUrl: it.materialUrl,
    })),
```

- [ ] **Step 5: Note styling**

In `preprocessMaterialMarkdown`, before the paragraph-splitting loop, wrap note lines:

```ts
  const withNotes = prepared
    .split('\n')
    .map((line) =>
      /^\s*(?:注|注释)\s*[:：]|^\s*【注】/.test(line)
        ? `\n<p class="cn-material-note">${line.trim()}</p>\n`
        : line,
    )
    .join('\n');
```

Use `withNotes` in place of `prepared` in the loop.

In `global.css` next to `.cn-emphasis-dot`:

```css
.cn-material-note {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-tertiary);
}
```

- [ ] **Step 6: Print preload**

In `PrintPreview.tsx`，先补 import：

```tsx
import { useEffect, useRef, useState } from 'react';
import { preloadMaterialDoc } from '@/hooks/useMaterialDoc';
```

再 gate 渲染：

```tsx
  const [docsReady, setDocsReady] = useState(false);
  useEffect(() => {
    if (!open) { setDocsReady(false); return; }
    let alive = true;
    const urls = Array.from(new Set(questions.map((q) => q.materialUrl).filter(Boolean))) as string[];
    const timeout = new Promise<void>((r) => setTimeout(r, 3000));
    Promise.race([
      Promise.all(urls.map((u) => preloadMaterialDoc(u))).then(() => undefined),
      timeout,
    ]).finally(() => { if (alive) setDocsReady(true); });
    return () => { alive = false; };
  }, [open, questions]);
```

Render `<PrintPaper>` only when `docsReady`; otherwise show `<p className="print-toolbar-hint">材料加载中…</p>`.

In `usePrint.ts`, keep the existing image wait; no change needed if preview preloads.

- [ ] **Step 7: Run web tests**

Run: `cd apps/web && npx vitest run src/components/business/answer/QuestionRunner.test.tsx src/components/business/AnswerResultList.test.tsx src/components/business/print src/components/markdown.test.tsx src/pages/student/PracticeHistoryDetailPage.test.tsx`
Expected: all pass.

- [ ] **Step 8: Build**

Run: `cd apps/web && npm run build`
Expected: `tsc -b` 与 vite 均成功。

- [ ] **Step 9: 八中卷界面验收（复用 Task 7 的回填数据）**

启动后端（`cd apps/server && npm run build && node dist/main.js`）与前端（`cd apps/web && npm run dev`），打开 paper 667：

- 12 题：先看到《醉翁亭记》，再看到题干。
- 14 题：依次看到《醉翁亭记》→《沧浪亭记》→ `注：…`（灰色小字）→ 题干。
- 结果页 / 历史回放 / PDF：文章都在，14 题两块材料都在；PDF 里同一篇文章不重复。
- 断网/把某个 md 改名：材料区显示「材料加载失败，点击重试」，页面不白屏。

不通过则回 Task 10–11 修，不要进入全量。

- [ ] **Step 10: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): render material docs in answer, result, history and print"
```

---

### Task 12: 周边脚本兼容（护栏 + 全量 rehash）

**Files:**
- Modify: `tools/data-refinery/src/apply_fixes.py`
- Modify: `tools/data-refinery/src/fix_page_markers_cli.py`
- Modify: `tools/data-refinery/src/emphasis_cli.py`
- Modify: `tools/data-refinery/src/migrate_content_hash.py`
- Test: `tools/data-refinery/tests/test_apply_fixes.py`
- Test: `tools/data-refinery/tests/test_fix_page_markers_cli.py`

**Interfaces:**
- 文章行（`material_url` 非空）在人工补题 / 页码清洗 / 标注回填里**必须跳过并打印原因**，不能静默改 `material_text` 或算错 hash。
- `migrate_content_hash.py` 的全量重算必须把 `material_url` 传进 `content_hash`。

- [ ] **Step 1: Write failing test**

Append to `tests/test_fix_page_markers_cli.py`:

```python
def test_plan_fixes_skips_article_row():
    rows = [_row(
        id=1,
        content="题干\n\n第5页（共8页）\n",
        material_url="materials/chinese/a/content.md",
        content_hash="a" * 64,
    )]
    fixes, manual, conflicts = plan_fixes(rows, {1: (2, 3)})
    assert fixes == [] and manual == [] and conflicts == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_fix_page_markers_cli.py::test_plan_fixes_skips_article_row -q`
Expected: FAIL（当前会生成 RowFix）。

- [ ] **Step 3: Add guards**

`fix_page_markers_cli.py` 的 `plan_fixes` 行循环开头（`qid = int(row["id"])` 之后）：

```python
        if row.get("material_url"):
            print(f"[skip] id={qid} material_url={row['material_url']}（文章在 md 里，按文档清洗）", flush=True)
            continue
```

`apply_fixes.py`：在拿到目标行后（`qid` 已知）加：

```python
    if qid:
        cur.execute("SELECT material_url FROM questions WHERE id=%s", (qid,))
        row = cur.fetchone()
        if row and row[0]:
            return "跳过：文章已外置为 md（material_url 非空），请在材料文档里修改"
```

`emphasis_cli.py`：行循环里同样 `if row.get("material_url"): print(...); continue`；它的 `content_hash` 调用改为：

```python
                         content_hash(new["content"], new["options"], new["material_text"],
                                      row.get("material_url")),
```

- [ ] **Step 4: Update full rehash**

`migrate_content_hash.py:49`：

```python
                new = content_hash(content, options, material, row.get("material_url"))
```

- [ ] **Step 5: Run tests**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_fix_page_markers_cli.py tests/test_apply_fixes.py -q`
Expected: all pass。再手工确认：对八中卷任一道文章题跑 `apply_fixes` 的 dry-run，输出必须是「跳过：文章已外置」。`emphasis_cli.py` / `apply_fixes.py` 没有覆盖文章行的历史测试，本期用这条手工验证兜底。

- [ ] **Step 6: Commit**

```bash
git add tools/data-refinery/src tools/data-refinery/tests
git commit -m "fix(refinery): guard article rows in manual/emphasis/page-marker tools"
```

---

### Task 13: 文档同步与全量回归

**Files:**
- Modify: `docs/API接口与数据流设计文档.md`
- Modify: `docs/api/openapi.yaml`
- Modify: `docs/K12智学系统-数据库设计文档.md`
- Modify: `docs/constraints/数据管线.md`（材料段落）
- Modify: `docs/constraints/专项子系统.md`（若涉及导出 PDF 的材料说明）

- [ ] **Step 1: Update API doc**

In every question payload table where `materialText` appears, add:

```
materialUrl | string | 文章 Markdown 相对地址（materials/chinese/{doc_key}/content.md）；无文章为 null
```

Update the data-flow prose for the four endpoints (training/exams results/practice-history).

- [ ] **Step 2: Update openapi.yaml**

Add to each corresponding schema:

```yaml
materialUrl:
  type: string
  nullable: true
  description: 文章 Markdown 相对地址；materialText 只放题中素材
```

- [ ] **Step 3: Update DB design doc**

Replace the §「材料字段使用说明」 bullet:

```
- 短材料（几百字）：直接存 material_text
- 长材料/音频/视频：存 material_url
- 同一篇材料的多道子题：共享相同 group_id，第一题存材料，后续留空
```

with:

```
- 文章（阅读/古诗/文言文/非连续文本）：发布为 materials/chinese/{doc_key}/content.md，material_url 指向它；同节每题存同一个 URL
- 题中素材（题号之内、这道题自带）：存 material_text，文章题为 NULL
- 训练轨试卷不再把文章复制到每题 material_text（2026-11-20 起）
```

Update §9 目录结构：`materials/{subject_code}/{doc_key}/content.md` + `fig_NN.ext`（`group_id` 是「一/二/三」大题，不是文章 key；不要照抄旧示例）。

- [ ] **Step 4: Update constraints**

`docs/constraints/数据管线.md`：在材料段落补「语文文章 → md + material_url；material_text 只放题中素材；publish 不调 LLM；`materials/` 与 `material/` 都在图片白名单」。

- [ ] **Step 5: Full regression**

Run:

```bash
cd tools/data-refinery && python3 -m pytest -q
cd ../../apps/server && npm test
cd ../web && npm test
cd ../web && npm run build
```

Expected: 全部通过。

- [ ] **Step 6: Commit**

```bash
git add docs
git commit -m "docs: sync materialUrl contract and material doc layout"
```

---

## Self-Review

**Spec coverage:**
- 判定规则（§2）→ Task 1（is_heading_only / strip_section_instruction）、Task 4（分组与回填）。
- 文档形态（§3）→ Task 1（doc_key）、Task 3（写 md + 图片）。
- 管线（§4）→ Task 2（题中素材）、Task 4（publish）、Task 5（db_loader）、Task 6（回填）。
- 服务端（§5）→ Task 8（materialUrl）、Task 9（MaterialDocService）。
- 前端（§6）→ Task 10（hook/组件/类型）、Task 11（四处渲染 + 注释 + 打印）。
- 试点（§7）→ Task 7。
- 测试（§8）→ 每个 Task 的测试步骤 + Task 13 全量回归。
- 风险（§9）→ Task 6 rollback / ER_DUP_ENTRY；Task 9 路径校验；Task 11 打印预加载。
- 明确不做（§10）→ Global Constraints 已列。

**Placeholder scan:** 无 TBD/TODO；每个代码步骤都有可执行代码或精确 SQL/JSX。

**Type consistency:**
- `split_inline_material` 在 Task 2 定义、Task 4/6 调用，签名一致。
- `write_material_doc` 在 Task 3 定义、Task 4/6 调用，参数一致。
- `content_hash` 在 Task 5 扩参，Task 6 调用一致。
- `MaterialDocService.getText` 在 Task 9 定义，judge/explanation 调用一致。
- `MaterialBlock` 在 Task 10 定义，Task 11 四处调用一致。
- `RunnerQuestion.materialUrl` 在 Task 10 定义，Task 11 页面映射使用。
