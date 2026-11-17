# 试卷/答案跨页页码标记清洗 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Spec 真源**：`docs/superpowers/specs/2026-11-17-data-refinery-page-marker-cleanup-design.md`。本计划只拆任务与验收；口径冲突时以 spec 为准。

**Goal:** 在 data-refinery 的试卷/答案链路里，确定性地删除 MinerU 输出 md 中的页码标记（页脚/页眉碎片），修掉答案/题干/共享材料的内容污染；同时清洗库里 6 条已知污染行。

**Architecture:** 新增纯函数模块 `page_markers.py`，在 4 个入口（主提取、独立答案提取、答案回填、语文加点）调用；答案区补结构行过滤；题目区只加告警不做阅读顺序重排；新增一次性的 `fix_page_markers_cli.py` 清洗存量库。

**Tech Stack:** Python 3 / pytest / pymysql / MySQL 8。只动 `tools/data-refinery`；不改 HTTP API、前端、数据库 schema。

## Global Constraints

- **5 条已确认裁决（spec §13）**：不重置 `answer_verified`；`content_hash` 冲突整行跳过；不清洗 `questions.options`；P1 阅读顺序重排本批不做；不支持中文数字页码。
- **不删裸数字行**：一零一物理的 `1/2/3/4` 是图片标号，不是页码。
- **不删正文引用**：`请阅读第 2 页的问题 1`、`本试卷共 8 页` 必须原样保留。
- **不改教材路径**：`extract_cli.py` / `page_chrome.py` 的教材页眉页脚逻辑不动。
- **不改 schema、不建触发器**；本批无 DDL。
- **DB 写入必须显式 `--apply --yes`**；默认只预览，写入前备份。
- **给用户的命令只有一条**：`python3 src/fix_page_markers_cli.py --apply --yes`（预览/备份/写入/复查都在内部）。
- **测试与文档同步**：测试断言与 spec 冲突时改测试；实现后同步 README / 使用手册 / 约束 / changelog。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `tools/data-refinery/src/page_markers.py` | 新建 | 页码标记正则、`PageMarkerHit`、`strip_page_markers`、`is_page_marker_line` |
| `tools/data-refinery/tests/test_page_markers.py` | 新建 | 正/负例、护栏、幂等、行尾合并 |
| `tools/data-refinery/tests/test_page_marker_integration.py` | 新建 | 主提取/答案提取/回填/加点的集成回归 |
| `tools/data-refinery/src/question_extract.py` | 修改 | 主提取第 5 步接入清洗 |
| `tools/data-refinery/src/answer_extract_cli.py` | 修改 | 独立答案提取前清洗 |
| `tools/data-refinery/src/answer_backfill.py` | 修改 | 答案回填前清洗 |
| `tools/data-refinery/src/scanned_emphasis.py` | 修改 | 语文加点 md 侧切题前清洗 |
| `tools/data-refinery/src/question_splitter.py` | 修改 | 答案区结构行过滤 + 题目区告警 |
| `tools/data-refinery/src/subject_strategies/chinese.py` | 修改 | `_align_by_number` 跳过页码标记 |
| `tools/data-refinery/src/fix_page_markers_cli.py` | 新建 | 存量库清洗：预览/备份/写入/复查 |
| `tools/data-refinery/tests/test_fix_page_markers_cli.py` | 新建 | 纯函数 + 假连接 + 冲突/幂等/备份 |
| `tools/data-refinery/tests/test_page_marker_corpus.py` | 新建 | 全量语料 auto/negative/manual 分类 |
| `tools/data-refinery/tests/fixtures/page_marker_cases.jsonl` | 新建 | 6 个真实片段的最小回归样本 |
| `tools/data-refinery/tests/fixtures/page_marker_manual.txt` | 新建 | 表格/标签/围栏内手动清单快照 |
| `tools/data-refinery/README.md` | 修改 | 试卷/答案章节加清洗说明 |
| `docs/data-refinery-使用手册.md` | 修改 | 存量清洗一条命令 + 备份/回滚 |
| `docs/constraints/数据管线.md` | 修改 | 硬约束：试卷/答案单 MD 必须走清洗；禁止删裸数字 |
| `docs/ai-core-changelog.md` | 修改 | 2026-11-17 事故与修复记录 |

---

## Task 1: 页码清洗纯函数 + 单测

**Status:** 2026-11-17 模块与单测已完成（`pytest tests/test_page_markers.py` 52 passed）；提交待用户确认。

**Files:**
- Create: `tools/data-refinery/src/page_markers.py`
- Create: `tools/data-refinery/tests/test_page_markers.py`

**Interfaces:**

```python
@dataclass(frozen=True)
class PageMarkerHit:
    line_no: int       # 原始文本 1 基行号
    raw: str           # 整行删除=整行原文；行内删除=被删片段原文；manual=整行
    whole_line: bool
    removed: bool = True  # False=表格/标签/围栏内命中，不删、留人工复核

def strip_page_markers(text: str) -> tuple[str, list[PageMarkerHit]]: ...
def is_page_marker_line(line: str) -> bool: ...
```

导出常量：`PAGE_MARKER_RE`、`BARE_PAGE_RE`、`BARE_TOTAL_RE`。

- [x] **Step 1: 写失败测试**

`tests/test_page_markers.py` 至少覆盖 spec §8.1 的 1–11c：

- 强锚点：`第5页（共8页）`、`第 1 页 共 5 页`、`第2页/共6页`、`第2页／6页`、`第2页，共6页`、`第 1页（共 5页）`、全角数字 `第５页（共８页）`、括号内空格 `第 5 页 （ 共 8 页 ）`；
- 弱锚点：独占行 `共6页`、`第5页`；
- 页眉：`语文试卷答案及评分参考 第 1页（共 5页）`、`北京市西城区九年级模拟测试试卷 数学答案及评分参考 2026.5 第2页（共6页）`、`北京市西城区九年级模拟测试试卷 第2页（共6页）`、`语文 第5页（共8页）`、`九年级物理试卷答案及评分标准 第2页（共2页）`；
- 行内：评分说明 + 页脚只删页脚；八一学校 `…一桥一水一九年级（语文）第8页（共11页）\n人家之间了` 删页脚并合并为 `…一桥一水一人家之间了`；
- 多标记：`…一第5页（共8页）中第6页（共8页）后` → `…一中后`；
- 负例：`本试卷共8页，共两部分…`、`本试卷共６页，满分100分。`、`请阅读第 2 页的问题 1`、裸数字 `1/2/3/4`、`Page 1 of 8`、`第一页（共八页）`、`请参考试卷 第5页（共8页）` → `请参考试卷`；
- 护栏：围栏内、HTML 标签内、`<table>` 内不删；
- 行尾合并：下一行是 `（二）下一节` / `25. 下一题` / `![img](x)` 时不合并；空行后是普通续行则跨空行合并，空行后是结构行则保留空行、不合并；
- 幂等：`strip(strip(x)) == strip(x)`；
- 行号：`hits[0].line_no` 为原始 1 基行号；
- 空文本/无命中：原文、空列表。

- [x] **Step 2: 实现正则与判定**

按 spec §4.1、§4.1.1、§4.3 实现：

- `PAGE_MARKER_RE`：`第N页 + 共M页/斜杠`；
- `BARE_PAGE_RE` / `BARE_TOTAL_RE`：独占行；
- 整行判定：长度 ≤50、无句末标点、不是题号/小节编号、不含分值括号、residual 空/命中 `_RUNNING_HEAD_RE`/`_PAPER_HEAD_RE`/`_SUBJECT_GRADE_RE`/纯日期；
- 行内判定：`_INLINE_HEAD_RE` 向左匹配 + 标点 trim + 行尾续行合并；
- 护栏：围栏状态机、HTML 标签、跨行表格、图片语法。

- [x] **Step 3: 跑测试**

```bash
cd tools/data-refinery && pytest tests/test_page_markers.py -q
```

Expected: 全过。实测：52 passed。

- [ ] **Step 4: 提交**

```bash
git add tools/data-refinery/src/page_markers.py tools/data-refinery/tests/test_page_markers.py
git commit -m "feat(refinery): 页码标记清洗纯函数与回归"
```

---

## Task 2: 主提取接入

**Status:** 2026-11-17 接入完成（集成测试 1 passed；相关子集 199 passed）；提交待用户确认。

**Files:**
- Modify: `tools/data-refinery/src/question_extract.py`（`extract_questions_file`）
- Test: `tools/data-refinery/tests/test_page_marker_integration.py`（新建）

**Interfaces:**
- Consumes: `from page_markers import strip_page_markers`
- Produces: `text, hits = strip_page_markers(text)`，在 `split_page` 前执行。

- [x] **Step 1: 写失败测试**

构造最小试卷 md：

```
24. 题干…
![img](x)
第5页（共8页）

25. 下一题…
共6页

26. 再下一题…
```

断言：

- Q24 `content` 不含 `第5页`；
- Q25 `content` 不含 `共6页`；
- Q26 完整；
- stdout 出现 `[page-marker]` 汇总。

- [x] **Step 2: 接入**

在 `extract_questions_file` 的 `strip_qr_images` 之后、`split_page` 之前：

```python
text, marker_hits = strip_page_markers(text)
removed = [h for h in marker_hits if h.removed]
manual = [h for h in marker_hits if not h.removed]
if removed:
    print(f"[page-marker] {md_path.stem}: 删除 {len(removed)} 处页码标记"
          f"（行 {', '.join(str(h.line_no) for h in removed[:10])}）", flush=True)
if manual:
    print(f"[WARN] [page-marker] {md_path.stem}: 未处理 {len(manual)} 处"
          f"（表格/标签/围栏内，行 {', '.join(str(h.line_no) for h in manual[:10])}）", flush=True)
```

- [x] **Step 3: 跑测试**

```bash
cd tools/data-refinery && pytest tests/test_page_marker_integration.py tests/test_page_markers.py -q
```

实测：全过；相关子集 199 passed。

- [ ] **Step 4: 提交**

```bash
git add tools/data-refinery/src/question_extract.py tools/data-refinery/tests/test_page_marker_integration.py
git commit -m "feat(refinery): 主提取接入页码清洗"
```

---

## Task 3: 独立答案提取接入

**Status:** 2026-11-17 接入完成（真实海淀答案 Q10 已无页脚；答案链路 106 passed）；提交待用户确认。

**Files:**
- Modify: `tools/data-refinery/src/answer_extract_cli.py`
- Test: `tools/data-refinery/tests/test_answer_extract_cli.py`

**Interfaces:**
- Consumes: `strip_page_markers`
- Produces: 清洗后的 `text` 传给 `strategy.extract_answers`。

- [x] **Step 1: 写失败测试**

构造答案 md，Q10 答案跨页：

```
## 10
先天下之忧而忧 后天下之乐而乐
答案示例 2：
安得广厦千万间 大庇天下寒士俱欢颜
语文试卷答案及评分参考 第 1页（共 5页）

## 11
①美酒佳肴
```

断言 `render_answer_doc` 的 Q10 答案不含 `语文试卷答案及评分参考`。

- [x] **Step 2: 接入**

```python
text, marker_hits = strip_page_markers(text)
removed = [h for h in marker_hits if h.removed]
manual = [h for h in marker_hits if not h.removed]
if removed:
    print(f"[page-marker] {rel_md}: 删除 {len(removed)} 处页码标记", flush=True)
if manual:
    print(f"[WARN] [page-marker] {rel_md}: 未处理 {len(manual)} 处（表格/标签/围栏内）", flush=True)
```

放在 `text = md_path.read_text(...)` 之后、`strategy.extract_answers` 之前。

- [x] **Step 3: 跑测试**

```bash
cd tools/data-refinery && pytest tests/test_answer_extract_cli.py -q
```

实测：全过；相关子集 58 passed。

- [ ] **Step 4: 提交**

```bash
git add tools/data-refinery/src/answer_extract_cli.py tools/data-refinery/tests/test_answer_extract_cli.py
git commit -m "feat(refinery): 独立答案提取接入页码清洗"
```

---

## Task 4: 答案回填接入

**Status:** 2026-11-17 接入完成（回填相关 65 passed）；提交待用户确认。

**Files:**
- Modify: `tools/data-refinery/src/answer_backfill.py`
- Test: `tools/data-refinery/tests/test_answer_backfill.py`

**Interfaces:**
- Consumes: `strip_page_markers`
- Produces: `backfill()` 的 `text` 在 `strategy.extract_answers` 前已清洗。

- [x] **Step 1: 写失败测试**

用临时 md（含 Q10 页脚）跑 `backfill(..., dry_run=True)`，断言 dry-run 统计与不清洗时有差异（不再把页脚当答案）。

- [x] **Step 2: 接入**

在 `text = md_path.read_text(encoding="utf-8")` 之后：

```python
text, marker_hits = strip_page_markers(text)
removed = [h for h in marker_hits if h.removed]
manual = [h for h in marker_hits if not h.removed]
if removed:
    print(f"[page-marker] {rel}: 删除 {len(removed)} 处页码标记", flush=True)
if manual:
    print(f"[WARN] [page-marker] {rel}: 未处理 {len(manual)} 处（表格/标签/围栏内）", flush=True)
```

- [x] **Step 3: 跑测试**

```bash
cd tools/data-refinery && pytest tests/test_answer_backfill.py -q
```

实测：全过；相关子集 65 passed。

- [ ] **Step 4: 提交**

```bash
git add tools/data-refinery/src/answer_backfill.py tools/data-refinery/tests/test_answer_backfill.py
git commit -m "feat(refinery): 答案回填接入页码清洗"
```

---

## Task 5: 语文加点 md 侧接入

**Status:** 2026-11-17 接入完成（真实八一 Q19-21 材料已清洗并合并；相关 64 passed）；提交待用户确认。

**Files:**
- Modify: `tools/data-refinery/src/scanned_emphasis.py`（抽 `_questions_from_md`，`_scan_pdf` 调用）
- Test: `tools/data-refinery/tests/test_scanned_emphasis.py`

**Interfaces:**
- Consumes: `strip_page_markers`（函数内 import，避免模块级耦合）
- Produces: `split_page` 前文本已清洗，`material_text` 与切题一致。

- [x] **Step 1: 写失败测试**

构造八一学校材料片段 + Q19-21，断言 `material_text` 不含 `第8页` 且包含 `一桥一水一人家之间了`；`match_material` 不直接构造 JSON sidecar，留 Task 9/真实 md 手工验证。

- [x] **Step 2: 接入**

抽出 `_questions_from_md(md_path)`（`_scan_pdf` 调用它），在内部：

```python
from page_markers import strip_page_markers
text = normalize_fullwidth_parens(md_path.read_text(encoding="utf-8"))
text, _ = strip_page_markers(text)
return [(q.group_order, f"{q.material_text or ''}\n{q.content}")
        for q in split_page(text, md_path, strategy=get_strategy("chinese"))]
```

- [x] **Step 3: 跑测试**

```bash
cd tools/data-refinery && pytest tests/test_scanned_emphasis.py -q
```

实测：全过；相关子集 64 passed。

- [ ] **Step 4: 提交**

```bash
git add tools/data-refinery/src/scanned_emphasis.py tools/data-refinery/tests/test_scanned_emphasis.py
git commit -m "feat(refinery): 语文加点切题接入页码清洗"
```

---

## Task 6: 答案区结构行过滤

**Status:** 2026-11-17 接入完成（切题 110 passed；全链路相关 187 passed；真实海淀 Q10 解析保留）；提交待用户确认。

**Files:**
- Modify: `tools/data-refinery/src/question_splitter.py`
- Modify: `tools/data-refinery/src/subject_strategies/chinese.py`
- Test: `tools/data-refinery/tests/test_question_splitter.py`

**Interfaces:**

```python
def is_answer_structure_line(line: str) -> bool:
    """页码标记 / 小节标题（（一）（二）…）。"""
```

- [x] **Step 1: 写失败测试**

答案区：

```
## 10
…答案…
（二）（共 5 分）

## 11
…答案…
```

断言 Q10 `answer` 不含 `（二）`；再构造带 `第5页（共8页）` 的答案，断言不在 answer 里。

- [x] **Step 2: 实现**

`question_splitter.py`：

```python
from page_markers import is_page_marker_line

def is_answer_structure_line(line: str) -> bool:
    # is_page_marker_line 已含表格行护栏
    return is_page_marker_line(line) or bool(_SECTION_HEADER_RE.match(line))
```

在 `split_page` 的 `if in_answer_section:` 分支最前面：

```python
if is_answer_structure_line(line):
    continue
```

`chinese.py` 的 `_align_by_number`：

```python
from page_markers import is_page_marker_line
...
if is_page_marker_line(norm):
    continue
```

- [x] **Step 3: 跑测试**

```bash
cd tools/data-refinery && pytest tests/test_question_splitter.py tests/test_answer_doc.py -q
```

实测：全过；切题 110 passed，全链路相关 187 passed。

- [ ] **Step 4: 提交**

```bash
git add tools/data-refinery/src/question_splitter.py tools/data-refinery/src/subject_strategies/chinese.py tools/data-refinery/tests/test_question_splitter.py
git commit -m "fix(refinery): 答案区跳过节标题与页码标记"
```

---

## Task 7: 题目区结构告警（P1-lite）

**Status:** 2026-11-17 完成（切题 114 passed；全链路相关 191 passed）；全量扫描：3 个文件有重复标题、35 个文件有题号跳跃（每文件一行汇总）；提交待用户确认。

**Files:**
- Modify: `tools/data-refinery/src/question_splitter.py`
- Test: `tools/data-refinery/tests/test_question_splitter.py`

- [x] **Step 1: 写失败测试**

- 同一大题标题出现两次且第二次落在题干中：断言 stdout 有 `[WARN] …重复大题标题`；
- 题号 9 直接跳到 12：断言 stdout 有 `[WARN] …题号跳跃 1 处（9→12@…）`；
- 断言切分结果与未加告警时一致（告警不改行为）。

- [x] **Step 2: 实现**

维护 `seen_group_headers` / `seen_part_headers`；仅在 `not in_answer_section` 时判断。题号跳跃用现有 `last_stem_no` 与十位纠正条件；收集 `(from,to,line)`，在 `split_page` 末尾打一行汇总（最多前 8 处）。只 `print(..., flush=True)`，不改变 `questions`。

- [x] **Step 3: 跑测试**

```bash
cd tools/data-refinery && pytest tests/test_question_splitter.py -q
```

实测：全过；切题 114 passed，全链路相关 191 passed。

- [ ] **Step 4: 提交**

```bash
git add tools/data-refinery/src/question_splitter.py tools/data-refinery/tests/test_question_splitter.py
git commit -m "chore(refinery): 跨页重复标题/题号跳跃告警"
```

---

## Task 8: 存量库清洗 CLI

**Status:** 2026-11-17 完成（CLI 测试 9 passed；真实库 dry-run 命中 6 行、无 conflict；未写库）；提交待用户确认。

**Files:**
- Create: `tools/data-refinery/src/fix_page_markers_cli.py`
- Create: `tools/data-refinery/tests/test_fix_page_markers_cli.py`

**Interfaces:**

```python
@dataclass(frozen=True)
class FieldFix:
    question_id: int
    field: str
    old: str
    new: str
    hits: tuple[PageMarkerHit, ...]

@dataclass(frozen=True)
class RowFix:
    question_id: int
    fields: dict[str, str]          # field -> new value
    new_content_hash: str | None

def plan_fixes(rows: list[dict], paper_map: dict[int, tuple[int, int]]) -> tuple[list[RowFix], list[str]]: ...
def apply_fixes(conn, row_fixes: list[RowFix], *, backup_path: Path) -> int: ...
def verify(conn) -> tuple[int, list[str]]: ...
def main(argv=None) -> int: ...
```

`rows` 元素：`{"id": int, "content": str|None, "material_text": str|None, "answer": str|None, "explanation": str|None, "approach": str|None, "options": str|None}`；`paper_map` 来自 `paper_questions`，仅用于预览展示。

CLI：

```bash
python3 src/fix_page_markers_cli.py --apply --yes
python3 src/fix_page_markers_cli.py --dry-run      # 开发可选
```

参数：`--apply`、`--yes`、`--paper-id`、`--subject`、`--limit`。DB 配置复用 `RefineryConfig`。

- [x] **Step 1: 写失败测试**

假连接测试：

- `--apply` 不带 `--yes` → 退出码 2；
- 预览不写库；
- 写入前生成备份 JSONL，条数 = 变更字段数；
- `content` 变化时重算 `content_hash`；与其它行冲突 → 整行跳过、打印 `[conflict]`；
- 第二次运行 0 变更（幂等）；
- 表格/标签/围栏内标记只进 `[manual]`，不计入硬 0。

- [x] **Step 2: 实现查询与预览**

按 spec §7.3：

```sql
SELECT q.id, q.content, q.material_text, q.answer, q.explanation, q.approach, q.options
FROM questions q
WHERE 1=1
  [AND EXISTS (SELECT 1 FROM paper_questions pq WHERE pq.question_id=q.id AND pq.paper_id=%s)]
  [AND q.subject_id=(SELECT id FROM subjects WHERE code=%s)]
[LIMIT %s]
```

另查 `paper_questions` 建 `id -> (paper_id, question_no)` 映射。

- [x] **Step 3: 实现 plan/apply/verify**

- `plan_fixes` 对 5 个字段跑 `strip_page_markers`；
- `content` 变化时用 `db_loader.content_hash(new_content, options)` 重算；旧 hash 为 NULL 保持 NULL；冲突整行跳过；
- `apply_fixes` 按 `question_id` 聚合，一条 UPDATE 写该行所有变化列；
- 备份 JSONL：`id/paper_id/question_no/field/old/new/hits`；
- `verify` 重新扫描，返回 `(auto_count, manual_lines)`。

- [x] **Step 4: 跑测试**

```bash
cd tools/data-refinery && pytest tests/test_fix_page_markers_cli.py tests/test_page_markers.py -q
```

实测：CLI 9 passed；真实库 `--dry-run` 命中 6 行 / 6 字段，无 conflict。

- [ ] **Step 5: 提交**

```bash
git add tools/data-refinery/src/fix_page_markers_cli.py tools/data-refinery/tests/test_fix_page_markers_cli.py
git commit -m "feat(refinery): 存量库页码标记清洗 CLI"
```

---

## Task 9: 全量语料清单与回归

**Status:** 2026-11-17 完成（6 个 fixture + 全量语料分类 2 passed；manual 0）；提交待用户确认。

**Files:**
- Create: `tools/data-refinery/tests/test_page_marker_corpus.py`
- Create: `tools/data-refinery/tests/fixtures/page_marker_cases.jsonl`
- Create: `tools/data-refinery/tests/fixtures/page_marker_manual.txt`

- [x] **Step 1: 落 6 个真实片段**

`page_marker_cases.jsonl` 每行：

```json
{"name":"haidian_answer_q10","input":"…","expect":"…"}
```

覆盖：海淀语文答案 Q10、北京中学 Q24、八一学校 Q19 材料、昌平一中 Q25 `共6页`、西城数学 Q22、朝阳物理 Q26。

- [x] **Step 2: 写语料分类测试**

`test_page_marker_corpus.py`：

- 若 `output/md` 不存在 → `pytest.skip`（CI 可能没有生成物）；
- 否则遍历非教材 md，按 spec §8.3 把命中行分为 `auto / negative / manual`；
- `auto` 清洗后必须 0；`negative` 逐字不变；`manual` 与 `page_marker_manual.txt` 快照一致；
- 未分类的新行 → 失败并打印文件:行号。

- [x] **Step 3: 跑测试**

```bash
cd tools/data-refinery && pytest tests/test_page_marker_corpus.py tests/test_page_markers.py -q
```

实测：全过；语料分类 auto/negative/manual 正常，manual 0。

- [ ] **Step 4: 提交**

```bash
git add tools/data-refinery/tests/test_page_marker_corpus.py tools/data-refinery/tests/fixtures/page_marker_cases.jsonl tools/data-refinery/tests/fixtures/page_marker_manual.txt
git commit -m "test(refinery): 页码清洗全量语料清单回归"
```

---

## Task 10: 真实库清洗（人工执行）

**Status:** 2026-11-17 已执行：6 行更新；verify 可清理 0；备份 6 条；content_hash 匹配无冲突；`updated_at` 只变 6 行。

**Files:** 无代码改动；使用 Task 8 的 CLI。

- [x] **Step 1: dry-run 核对 6 行**

```bash
cd tools/data-refinery && python3 src/fix_page_markers_cli.py --dry-run
```

Expected：`6959 / 6685 / 6713 / 5532 / 5533 / 5534` 共 6 行；无 `[conflict]`。

- [x] **Step 2: apply**

```bash
cd tools/data-refinery && python3 src/fix_page_markers_cli.py --apply --yes
```

Expected：`[verify] 可自动清理的标记：0`；`[manual] ...：0`；备份 JSONL 已生成。

- [x] **Step 3: 抽查**

```sql
SELECT id, RIGHT(answer, 80) FROM questions WHERE id=6959;
SELECT id, RIGHT(content, 80) FROM questions WHERE id IN (6685, 6713);
SELECT id, SUBSTRING(material_text, LOCATE('一桥一水一', material_text)-20, 80)
FROM questions WHERE id IN (5532,5533,5534);
```

Expected：无 `语文试卷答案及评分参考` / `第5页` / `共6页` / `第8页`；材料含 `一桥一水一人家之间了`。

- [x] **Step 4: 幂等复查**

再次运行 `--dry-run`，Expected：0 行命中。

- [x] **Step 5: 记录**

把实际清理结果补进 spec §1.2 与 `docs/ai-core-changelog.md`。

---

## Task 11: 文档同步

**Status:** 2026-11-17 完成（README §2.5 / 使用手册 §4.13 / 数据管线约束 / changelog / 旧设计假设已同步）；提交待用户确认。

**Files:** README / 使用手册 / 约束 / changelog / 旧设计假设。

- [x] **Step 1: `tools/data-refinery/README.md`**

在试卷/答案处理章节加「页码/页脚清洗」：4 个调用点、`page_markers.py`、不删裸数字的硬约束。

- [x] **Step 2: `docs/data-refinery-使用手册.md`**

加「存量数据页码清洗」：

```bash
cd tools/data-refinery && python3 src/fix_page_markers_cli.py --apply --yes
```

说明备份路径、`[conflict]` 含义、手工回滚 SQL。

- [x] **Step 3: `docs/constraints/数据管线.md`**

加硬约束：

- 试卷/答案单 MD 必须在 `split_page` 前走 `strip_page_markers`；
- 禁止用「删除纯数字行」清洗页码；
- 表格/标签/围栏内标记只记 manual，不自动改。

- [x] **Step 4: `docs/ai-core-changelog.md`**

记录 2026-11-17：6 个实测案例、DB id、根因（单 MD 不走 page_chrome）、修复范围、已知缺口（英文/中文数字/无页码页眉）。

- [ ] **Step 5: 提交**

```bash
git add tools/data-refinery/README.md docs/data-refinery-使用手册.md docs/constraints/数据管线.md docs/ai-core-changelog.md
git commit -m "docs(refinery): 页码清洗口径与存量清洗说明"
```

---

## Task 12: 最终验证

**Status:** 2026-11-17 完成：全量 1865 passed / 10 skipped（仅排除交互式 `test_import_cli.py`）；6 个真实文件 + 负例 PASS；无 DDL。

- [x] **Step 1: 全量测试**

```bash
cd tools/data-refinery && pytest -q
```

Expected：全过；新增测试全绿。

- [x] **Step 2: 6 个真实文件回归**

按 spec §9 的清单，确认：

- Q24 不含 `第5页`；
- Q25 不含 `共6页`；
- Q19/20/21 材料不含 `第8页` 且含 `一桥一水一人家之间了`；
- Q10 答案不含 `语文试卷答案及评分参考`；
- Q22/Q26 答案不含页码；
- Q10 答案不含 `（二）`。

- [x] **Step 3: 负例回归**

确认 `本试卷共8页`、`请阅读第 2 页的问题`、图片标号 `1/2/3/4`、`Page 1 of 8`、`第一页（共八页）` 均原样保留（英文/中文数字只记 issue）。

- [x] **Step 4: 无 DDL 确认**

本批无 `tools/db/schema.sql` / `tools/db/migrations/` 改动（`git diff --name-only` 已确认）；未跑 `schema_reconcile`（本批无 DDL，非必需）。

- [x] **Step 5: 收尾**

更新 spec 状态为「已实现」，在 §1.2 表补充实际清理结果；如有未覆盖的新页脚形态，记入 §11 待补。

---

## 未覆盖与后续（不在本计划）

- P1：MinerU JSON `page_idx`/`bbox` 的阅读顺序重排、裸页码/重复运行页眉识别；
- 英文 `Page N of M`（当前 0 样本）；
- 中文数字页码（`第一页`）；
- 水印识别（当前试卷语料无样本）；
- `questions.options` 内的页码标记（只记 manual）。
