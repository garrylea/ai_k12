# 试卷 + 配套答案自动转换与合并（--file / --files）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当同一目录下同时存在 `X-试卷.pdf` 与 `X-答案.pdf` 时，`import_cli --file/--files` 自动把答案一并转成 md，切题前合并进试卷文本，实现题目与答案一次入库。

**Architecture:** 入口解析阶段（`_resolve_file`）在候选素材里找出配对的答案并记到 `args._paired_answer_rel`；只有 `convert_argv` 把它追加进 `--materials`（逗号 OR）；`extract` 原有的 `maybe_merge_answer_md` 会在兄弟目录找到答案 md 并合并，其余阶段仍只处理试卷。

**Tech Stack:** Python 3.10、pytest、既有 CLI（convert_cli / question_extract / answer_merger），无新依赖。

## Global Constraints

- 只改 `tools/data-refinery`，不动 `apps/`、不动数据库结构。
- 答案路径**只**进 convert 的素材清单；extract/publish/meta/load 的过滤词仍是试卷。
- 不改 `--answers` 路径的任何语义（它仍是「只补答案、不重抽」）。
- 不改 `maybe_merge_answer_md` 的四种 case 判定，只加日志。
- 中文注释与日志风格与现有文件一致；不新增依赖。
- 单测命令：`cd tools/data-refinery && python3 -m pytest tests/test_import_cli.py tests/test_answer_merger.py -q`。

---

### Task 1: 入口解析配对答案（含答案名反向收敛）

**Files:**
- Modify: `tools/data-refinery/src/import_cli.py`（`_pick_paired_paper` 之后新增两个小助手；`_resolve_file` 尾部，约 420-428 行）
- Test: `tools/data-refinery/tests/test_import_cli.py`

**Interfaces:**
- Consumes: `answer_merger.is_answer_pair(paper_md: Path, answer_md: Path) -> bool`；`import_cli._strip_answer_suffix(name: str) -> str`；`_collect_candidates(cfg) -> (list[Path], list[str])`
- Produces: `_answer_sibling(paper: Path, candidates: list[Path]) -> Path | None`；`_paper_for_answer(answer: Path, candidates: list[Path]) -> Path | None`；`args._paired_answer_rel: str | None`（rel_path 字符串，无值时为 `None`）

- [ ] **Step 1: 写失败测试**

在 `tools/data-refinery/tests/test_import_cli.py` 末尾追加：

```python
def test_file_resolves_paper_and_records_answer_sibling(monkeypatch):
    """命中只有试卷时，也要主动找到同目录答案，不能等关键词同时命中两份。"""
    monkeypatch.setattr(import_cli, "_collect_candidates", lambda cfg: ([
        Path("物理/初中/second/2026/X-试卷"),
        Path("物理/初中/second/2026/X-答案"),
    ], []))
    args = parse_args(["--subject", "物理", "--file", "X-试卷"])
    assert import_cli._resolve_file(args, object()) is None
    assert args.file == "X-试卷"
    assert args._resolved_rel == "物理/初中/second/2026/X-试卷"
    assert args._paired_answer_rel == "物理/初中/second/2026/X-答案"


def test_file_without_answer_leaves_pair_empty(monkeypatch):
    monkeypatch.setattr(import_cli, "_collect_candidates", lambda cfg: ([
        Path("物理/初中/second/2026/Y-试卷"),
    ], []))
    args = parse_args(["--subject", "物理", "--file", "Y"])
    assert import_cli._resolve_file(args, object()) is None
    assert args._paired_answer_rel is None


def test_file_answer_keyword_redirects_to_paper(monkeypatch, capsys):
    """直接输入答案名时改选它的试卷；否则只转答案、extract 跳过，0 题入库。"""
    monkeypatch.setattr(import_cli, "_collect_candidates", lambda cfg: ([
        Path("物理/初中/second/2026/X-试卷"),
        Path("物理/初中/second/2026/X-答案"),
    ], []))
    args = parse_args(["--subject", "物理", "--file", "X-答案"])
    assert import_cli._resolve_file(args, object()) is None
    assert args.file == "X-试卷"
    assert args._paired_answer_rel == "物理/初中/second/2026/X-答案"
    assert "命中的是答案" in capsys.readouterr().out


def test_two_papers_are_not_auto_paired():
    """两份试卷（不是试卷+答案）不能被当成一对。"""
    hits = [Path("物理/初中/second/2026/A-试卷"), Path("物理/初中/second/2026/B-试卷")]
    assert import_cli._pick_paired_paper(hits) is None
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_import_cli.py -q -k "answer_sibling or pair_empty or redirects or auto_paired"`
Expected: FAIL（`_resolve_file` 没有 `_paired_answer_rel`，两个助手不存在）

- [ ] **Step 3: 实现助手与解析逻辑**

在 `import_cli.py` 的 `_pick_paired_paper` 之后新增：

```python
def _answer_sibling(paper: Path, candidates: list[Path]) -> Path | None:
    """同一目录下与 paper 配对的答案素材（只看文件名变体，不读内容）。"""
    for cand in candidates:
        if cand != paper and is_answer_pair(paper, cand):
            return cand
    return None


def _paper_for_answer(answer: Path, candidates: list[Path]) -> Path | None:
    """答案素材对应的试卷素材（is_answer_pair 反向）。"""
    for cand in candidates:
        if cand != answer and is_answer_pair(cand, answer):
            return cand
    return None
```

把 `_resolve_file` 尾部（`args.file = chosen.name` 之前）改为：

```python
    answer_rel: Path | None = None
    if _strip_answer_suffix(chosen.name) != chosen.name:
        # 关键词命中的是答案：改选它的试卷，否则只转答案、extract 会跳过 → 0 题
        paper = _paper_for_answer(chosen, candidates)
        if paper is not None:
            answer_rel, chosen = chosen, paper
            paired_note = "（关键词命中的是答案，已改为导入其试卷）"

    if answer_rel is None:
        answer_rel = _answer_sibling(chosen, candidates)
        if answer_rel is not None and not paired_note:
            paired_note = "（含配对答案，切题时自动并入）"

    args.file = chosen.name                     # 卷名/书名：第 7/8/9 步与 paper_id 反查用
    args._resolved_rel = chosen.as_posix()      # 精确相对路径：五个路径阶段用
    args._resolved_subject = chosen.parts[0] if chosen.parts else None
    args._paired_answer_rel = answer_rel.as_posix() if answer_rel else None
    print(f"[解析] {raw} → {args._resolved_rel}{paired_note}", flush=True)
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_import_cli.py -q`
Expected: PASS（含既有 `test_file_matching_paper_and_answer_pair_resolves_to_paper`）

- [ ] **Step 5: 提交**

```bash
git add tools/data-refinery/src/import_cli.py tools/data-refinery/tests/test_import_cli.py
git commit -m "feat(refinery): 入口解析记录配对答案，答案名自动收敛到试卷"
```

---

### Task 2: convert 阶段同时转换试卷与答案

**Files:**
- Modify: `tools/data-refinery/src/import_cli.py`（`convert_argv`，约 191-200 行）
- Test: `tools/data-refinery/tests/test_import_cli.py`

**Interfaces:**
- Consumes: `args._paired_answer_rel`（Task 1 产出）、`_stage_file(args) -> str | None`
- Produces: convert 阶段 argv 的 `--materials` 值为「试卷rel,答案rel」

- [ ] **Step 1: 写失败测试**

追加：

```python
def test_convert_includes_paired_answer():
    a = parse_args(["--subject", "物理", "--file", "X-试卷"])
    a._resolved_rel = "物理/初中/second/2026/X-试卷"
    a._paired_answer_rel = "物理/初中/second/2026/X-答案"
    argv = convert_argv(a)
    value = argv[argv.index("--materials") + 1]
    assert value == "物理/初中/second/2026/X-试卷,物理/初中/second/2026/X-答案"


def test_convert_without_pair_keeps_single_material():
    a = parse_args(["--subject", "物理", "--file", "X-试卷"])
    a._resolved_rel = "物理/初中/second/2026/X-试卷"
    a._paired_answer_rel = None
    argv = convert_argv(a)
    assert argv[argv.index("--materials") + 1] == "物理/初中/second/2026/X-试卷"
```

- [ ] **Step 2: 运行确认失败**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_import_cli.py -q -k "convert_includes or keeps_single"`
Expected: 第一条 FAIL（值只有试卷）

- [ ] **Step 3: 改 `convert_argv`**

```python
def convert_argv(args) -> list[str]:
    """convert：--file 映射为 --materials（试卷 + 配对答案，逗号 OR）。"""
    argv = _common(args)
    entries = [
        e for e in (_stage_file(args), getattr(args, "_paired_answer_rel", None)) if e
    ]
    if entries:
        argv += ["--materials", ",".join(entries)]
    if args.dry_run:
        argv.append("--dry-run")
    if args.reconvert or args.redo:
        argv.append("--reconvert")
    return argv
```

- [ ] **Step 4: 更新既有断言、补 --files 批量用例并全量跑**

`test_file_matching_paper_and_answer_pair_resolves_to_paper` 里 convert 的断言改为：

```python
    for name, argv in seen:
        if name == "convert_main":
            value = argv[argv.index("--materials") + 1]
            assert value == ("语文/初中/second/2026/海淀九年级语文（上）期中语文试题,"
                             "语文/初中/second/2026/海淀九年级语文（上）期中语文试题_答案")
        else:
            flag = "--book" if name == "publish_main" else "--file"
            assert argv[argv.index(flag) + 1] == "语文/初中/second/2026/海淀九年级语文（上）期中语文试题"
```

新增 `--files` 批量配对用例（顺带验证两份之间不串答案）：

```python
def test_files_batch_pairs_each_keyword(monkeypatch):
    seen = []
    for name in ("convert_main", "extract_main", "publish_main", "db_loader_main"):
        monkeypatch.setattr(import_cli, name, lambda argv, n=name: seen.append((n, argv)))
    monkeypatch.setattr(import_cli, "answers_backfill", lambda *a, **k: None)
    monkeypatch.setattr(import_cli, "_collect_candidates", lambda cfg: ([
        Path("物理/初中/second/2026/A-试卷"),
        Path("物理/初中/second/2026/A-答案"),
        Path("物理/初中/second/2026/B-试卷"),
    ], []))

    import_cli.main(["--subject", "物理", "--files", "A-试卷,B-试卷", "--skip-review"])
    materials = [argv[argv.index("--materials") + 1]
                 for name, argv in seen if name == "convert_main"]
    assert materials[0].endswith("A-试卷,A-答案")
    assert materials[1].endswith("B-试卷")
    assert "A-答案" not in materials[1]          # 第二轮不能继承上一轮的答案
```

Run: `cd tools/data-refinery && python3 -m pytest tests/test_import_cli.py -q`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add tools/data-refinery/src/import_cli.py tools/data-refinery/tests/test_import_cli.py
git commit -m "feat(refinery): convert 阶段同时转换配对答案"
```

---

### Task 3: 合并日志（case 4a / 4b）

**Files:**
- Modify: `tools/data-refinery/src/answer_merger.py`（`maybe_merge_answer_md` 的 case 4 分支，约 160-182 行）
- Test: `tools/data-refinery/tests/test_answer_merger.py`

**Interfaces:**
- Produces: stdout 行 `[merge] <试卷 md 名> ← <答案 md 名>（case 4a … / case 4b …）`；返回值不变

- [ ] **Step 1: 写失败测试**

```python
def test_case4a_logs_merge(tmp_path, capsys):
    paper = tmp_path / "X-试卷.md"
    answer = tmp_path / "X-答案.md"
    paper.write_text("1. 题干\nA. 甲\nB. 乙\nC. 丙\nD. 丁\n", encoding="utf-8")
    answer.write_text("# 参考答案\n1. B\n", encoding="utf-8")
    out = maybe_merge_answer_md(paper, paper.read_text(encoding="utf-8"))
    assert "参考答案" in out
    log = capsys.readouterr().out
    assert "[merge]" in log and "case 4a" in log


def test_case4b_logs_paper_replaced(tmp_path, capsys):
    paper = tmp_path / "Y-试卷.md"
    answer = tmp_path / "Y-答案.md"
    paper.write_text("1. 只有题干\n", encoding="utf-8")
    answer.write_text("1. 题干\nA. 甲\nB. 乙\nC. 丙\nD. 丁\n参考答案\n1. B\n", encoding="utf-8")
    out = maybe_merge_answer_md(paper, paper.read_text(encoding="utf-8"))
    assert "只有题干" not in out
    log = capsys.readouterr().out
    assert "case 4b" in log and "试卷 md 不参与切题" in log
```

- [ ] **Step 2: 运行确认失败**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_answer_merger.py -q -k "logs_merge or logs_paper_replaced"`
Expected: FAIL（无 `[merge]` 日志）

- [ ] **Step 3: 加日志**

case 4a 的 `return text + "\n\n" + answer_text` 之前加：

```python
            print(f"[merge] {md_path.name} ← {answer_path.name}"
                  f"（case 4a 纯答案拼接，{len(answer_text.strip())} 字）", flush=True)
```

case 4b 的 `return answer_text` 之前加：

```python
        print(f"[merge] {md_path.name} ← {answer_path.name}"
              f"（case 4b 用答案文件全文，试卷 md 不参与切题）", flush=True)
```


- [ ] **Step 4: 运行确认通过**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_answer_merger.py -q`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add tools/data-refinery/src/answer_merger.py tools/data-refinery/tests/test_answer_merger.py
git commit -m "feat(refinery): 答案合并打印 case 4a/4b 日志"
```

---

### Task 4: 端到端离线回归（合并 → 切题 → 答案对齐）

**Files:**
- Create: `tools/data-refinery/tests/test_answer_pair_flow.py`
- Test: 同上

**Interfaces:**
- Consumes: `maybe_merge_answer_md(md_path, text) -> str`；`split_page(text, md_path, strategy=...)`；`subject_strategies.get_strategy("physics")`

- [ ] **Step 1: 写端到端测试（先跑通再固化）**

```python
from pathlib import Path

from answer_merger import maybe_merge_answer_md
from question_splitter import split_page
from subject_strategies import get_strategy

PAPER = """一、单项选择题（共4分，每题2分）
1. 光在真空中的传播速度约为
A. 340m/s
B. 3×10^8m/s
C. 1500m/s
D. 3×10^5m/s
2. 下列现象属于光的折射的是
A. 水中倒影
B. 小孔成像
C. 筷子在水面处弯折
D. 影子
"""

ANSWER = """
# 参考答案
1. B
2. C
"""


def _run(tmp_path, answer_text=ANSWER):
    d = tmp_path / "物理" / "初中" / "second" / "2026"
    (d / "X-试卷").mkdir(parents=True)
    (d / "X-答案").mkdir(parents=True)
    paper = d / "X-试卷" / "X-试卷.md"
    paper.write_text(PAPER, encoding="utf-8")
    (d / "X-答案" / "X-答案.md").write_text(answer_text, encoding="utf-8")
    text = maybe_merge_answer_md(paper, paper.read_text(encoding="utf-8"))
    return split_page(text, paper, strategy=get_strategy("physics"))


def test_merged_answer_reaches_each_question(tmp_path):
    qs = _run(tmp_path)
    assert [q.group_order for q in qs] == [1, 2]
    assert [q.answer for q in qs] == ["B", "C"]


def test_missing_answer_number_does_not_shift(tmp_path):
    qs = _run(tmp_path, answer_text="# 参考答案\n1. B\n")
    assert qs[0].answer == "B"
    assert qs[1].answer == ""
```

- [ ] **Step 2: 运行确认通过（这是既有能力的固化）**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_answer_pair_flow.py -q`
Expected: PASS。若 `test_missing_answer_number_does_not_shift` 暴露错位，先修对齐逻辑再继续，不允许改断言迁就。

- [ ] **Step 3: 提交**

```bash
git add tools/data-refinery/tests/test_answer_pair_flow.py
git commit -m "test(refinery): 答案配对合并到切题的端到端回归"
```

---

### Task 5: 文档与 changelog

**Files:**
- Modify: `docs/constraints/数据管线.md`（「答案/解析导入」段，第 55 行附近）
- Modify: `docs/data-refinery-使用手册.md`（§4.11 答案导入，或 `--file` 单卷导入段）
- Modify: `docs/ai-core-changelog.md`（顶部新增条目）

- [ ] **Step 1: 约束文档补口径**

在「答案/解析导入」段追加：

```
**试卷+答案成对导入（2026-11-24）**：同一素材目录下同时有 `X-试卷.pdf` 与 `X-答案.pdf` 时，
`--file/--files` 解析出试卷后会主动找同目录的答案兄弟，只把答案追加进 convert 的
`--materials`（逗号 OR）；切题时由 `maybe_merge_answer_md` 合并，extract/publish/load
仍只处理试卷。答案名直接当关键词时会反向收敛到试卷。只支持同目录 + `-答案/_答案/
（答案）/(答案)/答案` 命名；跨目录或命名不规整用 `--answers` / `--paper-id`。
`--preview` 也会转换答案（有一次 MinerU 成本）。
```

- [ ] **Step 2: 使用手册补用法**

在单卷导入（`--file`）与批量导入（`--files`）两节各补一段：

```
同一目录下的 X-试卷.pdf 与 X-答案.pdf 会被视为一份卷：--file "X-试卷"（或 --files 里写
"X-试卷"）会自动把 X-答案 一并转换，切题时合并答案。输出里看两行确认：
  [解析] X-试卷 → …/X-试卷（含配对答案，切题时自动并入）
  [merge] X-试卷.md ← X-答案.md（case 4a 纯答案拼接 / case 4b 用答案文件全文）
答案名本身当关键词也支持（--file "X-答案" 会改为导入 X-试卷）。答案不在同一目录、
或命名不是 -答案/_答案/（答案）/(答案)/答案 时不配对，请用 --answers 或 --paper-id。
--preview 也会转换答案文件（一次 MinerU 成本），只想看切题又不想转答案时不要用 --preview。
```

- [ ] **Step 3: changelog 记一条**

在 `docs/ai-core-changelog.md` 顶部按现有格式插入：

```markdown
## 2026-11-24 试卷+配套答案成对导入：答案自动转换并合并

**问题**：`--file` 解析出精确试卷名后，`convert --materials` 按这个名字过滤素材，同目录的
`X-答案.pdf` 不匹配 → 答案从未转 md；extract 的 `maybe_merge_answer_md` 找不到配对方，
题目答案全空。实测 2026 西城物理模拟一（paper 899）28 题 0 答案；全库 68 份答案 PDF 有
62 份没有对应 md。

**改法**：`_resolve_file` 解析出试卷后主动找同目录答案（`is_answer_pair` + 文件名变体），
记到 `args._paired_answer_rel`；`convert_argv` 把答案追加进 `--materials`（逗号 OR）；
extract/publish/meta/load 仍只拿试卷路径。关键词直接命中答案名时反向收敛到试卷。
`maybe_merge_answer_md` 在 case 4a/4b 打 `[merge]` 日志；case 4b（教师版）保持用答案全文。

**范围**：只支持同目录 + `-答案/_答案/（答案）/(答案)/答案` 命名；`--answers` 路径不变。

**验证**：新增入口配对/convert 参数/批量不串答案/合并日志/端到端切题对齐共 8 例；
真卷 paper 899 重抽后 28 题、答案非空 ≥20，重跑幂等。
```


- [ ] **Step 4: 提交**

```bash
git add docs/constraints/数据管线.md docs/data-refinery-使用手册.md docs/ai-core-changelog.md
git commit -m "docs(refinery): 补充试卷与答案成对导入的口径"
```

---

### Task 6: 真卷验收（人工，不进 CI）

**Files:** 无代码改动；先备份该卷数据。

- [ ] **Step 1: 备份该卷**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
ids=$(mysql -h localhost -u ai_k12 -pai_k12 ai_k12 -N \
  -e "SELECT question_id FROM paper_questions WHERE paper_id=899" | paste -sd, -)
mysqldump -h localhost -u ai_k12 -pai_k12 ai_k12 questions \
  --no-create-info --where="id IN ($ids)" \
  > tools/db/backups/20261124_paper899_questions.sql
mysqldump -h localhost -u ai_k12 -pai_k12 ai_k12 paper_questions \
  --no-create-info --where="paper_id=899" \
  > tools/db/backups/20261124_paper899_pq.sql
```

（`ids` 为空说明该卷题行已不存在，先停下核对再用 `--reload-paper` 重导，不要直接跑正式导入。）

- [ ] **Step 2: 预览**

```bash
cd tools/data-refinery
python3 src/import_cli.py --subject 物理 --file "物理-初三(下)-202607-西城-模拟一-试卷" --preview
```

Expected：`[解析] …（含配对答案，切题时自动并入）`；convert 打印两份素材；切题预览里题目数与答案非空数明显增加。

- [ ] **Step 3: 正式导入**

```bash
python3 src/import_cli.py --subject 物理 --file "物理-初三(下)-202607-西城-模拟一-试卷" --re-extract --re-publish
```

- [ ] **Step 4: 库内校验**

```sql
SELECT COUNT(*) AS total,
       SUM(q.answer IS NOT NULL AND TRIM(q.answer)<>'') AS answered
  FROM questions q JOIN paper_questions pq ON pq.question_id=q.id
 WHERE pq.paper_id=899;

SELECT COUNT(*) FROM paper_questions WHERE paper_id=899;  -- 仍为 28
```

Expected：total=28、answered ≥ 20（作图/实验题可能仍空）、题号无重复。

- [ ] **Step 5: 幂等**

再跑一次 Step 3，`answered` 不增加、题数仍 28。

- [ ] **Step 6: 回归无答案卷**

任选一份没有答案文件的物理卷（如 paper 375），跑 `--preview`，确认 convert 仍只计划 1 份、切题结果不变。

---

## 风险与回滚

| 风险 | 影响 | 处理 |
|---|---|---|
| 答案 md 质量差（教师版 case 4b） | 整卷题干改用答案文件 | 保留现状 + `[merge] case 4b` 日志；不满意改用 `--answers` 只补答案 |
| 答案 PDF 命名不规整/跨目录 | 不配对，答案仍空 | 文档提示用 `--answers` / `--paper-id` |
| 答案转换失败 | 整条命令停 | 符合预期（不静默丢答案）；修好 PDF 后重跑 |
| `--preview` 产生 MinerU 成本 | 多转答案一份 | 文档注明 |
| 重复导入产生新行 | 题库重复 | 已确认 content_hash 不含 answer，且 db_loader 按 (paper, group_order, sub_no) 原址更新；Step 5 幂等验收兜底 |

回滚：`git revert` 对应提交；数据库无结构变更；899 卷可用 Task 6 Step 1 的备份恢复。
