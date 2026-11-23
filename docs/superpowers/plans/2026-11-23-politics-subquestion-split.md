# 道法大题按小问拆题 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让道法大题按小问拆成独立题（26(1)/26(2)），每小问带自己的 `material_text` 并在题干上方展示，且不影响其它学科。

**Architecture:** 切题规则放在新的 `subject_strategies/politics_subquestions.py`，由 `PoliticsStrategy.expand_subquestions` 在 `split_page` 末尾以可选钩子执行；数据上用 `questions.sub_no` 区分同号小问、`questions.material_position='before'` 控制材料位置；入库与前端按这两个字段分流，默认值保持现有行为。

**Tech Stack:** Python 3.10（pytest / pymysql）、MySQL、NestJS + TypeScript（vitest）、React + Vite（vitest）。

## Global Constraints

- `question_splitter.py` 内核不得出现学科条件判断（`subject ==` / `subject_code ==` / `"chinese"` 字面量），由 `tests/test_no_subject_conditionals.py` 把关。
- 只改道法；语文 / 数学 / 物理 / 化学的切题结果、材料位置、题号显示必须零变化（`split_snapshot --check` 验证）。
- 新增字段默认值即旧行为：`sub_no=0`、`material_position=NULL`。
- `ExamQuestion` 新增字段必须显式声明，否则 `publish_cli.ExamQuestion(**raw)` 会静默丢弃（知识点事故同款）。
- 分值只展示，不参与能否拆的判定（用户 2026-11-23 裁决）。
- 迁移必须幂等（`information_schema` 查存在性），并同步 `tools/db/schema.sql`。
- 交付给用户的收尾命令只能有一条（CLAUDE.md 工程约定）。

---

### Task 1: 数据库列与迁移

**Files:**
- Create: `tools/db/migrations/2026-11-23_politics_subquestion.sql`
- Modify: `tools/db/schema.sql:220-249`（`questions` 建表段）

**Interfaces:**
- Produces: `questions.sub_no TINYINT UNSIGNED NOT NULL DEFAULT 0`
- Produces: `questions.material_position VARCHAR(8) DEFAULT NULL`

- [ ] **Step 1: 写迁移文件**

```sql
-- 道法小问拆题 —— 数据库迁移（2026-11-23）
-- 用途：questions 增加 sub_no（小问序号，0=非小问）与 material_position（材料显示位置）。
-- 幂等：列存在则 SELECT 1 跳过，可重复执行。

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'questions' AND COLUMN_NAME = 'sub_no');
SET @ddl := IF(@col = 0,
  'ALTER TABLE questions ADD COLUMN sub_no TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER group_order',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'questions' AND COLUMN_NAME = 'material_position');
SET @ddl := IF(@col = 0,
  'ALTER TABLE questions ADD COLUMN material_position VARCHAR(8) DEFAULT NULL AFTER material_method',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
```

- [ ] **Step 2: 同步 schema.sql**

在 `questions` 建表段里 `group_order SMALLINT DEFAULT NULL,` 下一行加：

```sql
  sub_no TINYINT UNSIGNED NOT NULL DEFAULT 0,        -- 小问序号（0=非小问；2026-11-23）
```

在 `material_method VARCHAR(8) DEFAULT NULL,` 下一行加：

```sql
  material_position VARCHAR(8) DEFAULT NULL,        -- 材料显示位置：before=题干上方；NULL=题干下方（2026-11-23）
```

- [ ] **Step 3: 应用迁移**

```bash
mysql -h 127.0.0.1 -P 3306 -u ai_k12 -pai_k12 ai_k12 \
  < tools/db/migrations/2026-11-23_politics_subquestion.sql
```

- [ ] **Step 4: 对账**

Run: `python3 tools/db/schema_reconcile.py`
Expected: 所有表一致，无 `questions` 差异。

- [ ] **Step 5: Commit**

```bash
git add tools/db/migrations/2026-11-23_politics_subquestion.sql tools/db/schema.sql
git commit -m "feat(db): questions 增加 sub_no / material_position"
```

---

### Task 2: Python 模型字段贯通

**Files:**
- Modify: `tools/data-refinery/src/models.py:8-31`
- Modify: `tools/data-refinery/src/question_splitter.py:799-813`
- Modify: `tools/data-refinery/src/question_labeler.py:398-446`
- Modify: `tools/data-refinery/src/question_extract.py:456-482`
- Test: `tools/data-refinery/tests/test_politics_subno_model.py`

**Interfaces:**
- Produces: `ExamQuestion.sub_no: int`、`ExamQuestion.material_position: Literal["before","after"] | None`
- Produces: `RawQuestion.sub_no: int`、`RawQuestion.material_position: str | None`
- Produces: `LabeledQuestion.sub_no`、`LabeledQuestion.material_position`

- [ ] **Step 1: 写失败测试**

```python
"""新字段必须能穿过 ExamQuestion / LabeledQuestion，不能被 Pydantic 丢掉。"""

from question_labeler import LabeledQuestion
from models import ExamQuestion
from question_splitter import RawQuestion


def test_exam_question_keeps_sub_fields():
    q = ExamQuestion(
        subject_id="politics", type="short_answer", difficulty=2,
        content="(1) 结合材料", answer="", sub_no=1,
        material_position="before",
    )
    dumped = q.model_dump(mode="json")
    assert dumped["sub_no"] == 1
    assert dumped["material_position"] == "before"


def test_labeled_from_raw_copies_sub_fields():
    raw = RawQuestion(group_order=26, group_id="二", content="(1) x",
                      sub_no=2, material_position="before")
    lab = LabeledQuestion.from_raw(raw)
    assert lab.sub_no == 2
    assert lab.material_position == "before"


def test_defaults_stay_backwards_compatible():
    q = ExamQuestion(subject_id="math", type="choice", difficulty=1,
                     content="1+1", answer="A")
    assert q.model_dump()["sub_no"] == 0
    assert q.model_dump()["material_position"] is None
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_politics_subno_model.py -q`
Expected: FAIL（`RawQuestion` 不接受 `sub_no`，`ExamQuestion` 没字段）。

- [ ] **Step 3: 改模型**

`models.py` 的 `ExamQuestion`，在 `group_order` 下加：

```python
    sub_no: int = 0                    # 小问序号（0=非小问）
```

在 `material_method` 下加：

```python
    material_position: Literal["before", "after"] | None = None  # before=题干上方
```

`question_splitter.RawQuestion` 加：

```python
    sub_no: int = 0
    material_position: str | None = None
```

`question_labeler.LabeledQuestion` 加：

```python
    sub_no: int = 0
    material_position: str | None = None
```

`LabeledQuestion.from_raw` 里加：

```python
            sub_no=q.sub_no,
            material_position=q.material_position,
```

`question_extract._write_exam_questions_jsonl` 的 `item` dict 里加：

```python
                "sub_no": q.sub_no,
                "material_position": q.material_position,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_politics_subno_model.py -q`
Expected: 3 passed。

- [ ] **Step 5: 跑全量回归**

Run: `cd tools/data-refinery && python3 -m pytest -q`
Expected: 全部通过（新字段有默认值，旧断言不受影响）。

- [ ] **Step 6: Commit**

```bash
git add tools/data-refinery/src/models.py tools/data-refinery/src/question_splitter.py \
  tools/data-refinery/src/question_labeler.py tools/data-refinery/src/question_extract.py \
  tools/data-refinery/tests/test_politics_subno_model.py
git commit -m "feat(refinery): ExamQuestion/RawQuestion 增加 sub_no 与 material_position"
```

---

### Task 3: 道法小问拆分核心规则

**Files:**
- Create: `tools/data-refinery/src/subject_strategies/politics_subquestions.py`
- Test: `tools/data-refinery/tests/subject_strategies/test_politics_subquestions.py`

**Interfaces:**
- Produces: `expand(questions: list[RawQuestion]) -> list[RawQuestion]`
- Produces: `split_tail_question_rule(content: str) -> tuple[str | None, str]`

**规则来源：** spec 第 4 节。分值只用于展示，缺失/不一致都照常拆。

- [ ] **Step 1: 写失败测试**

```python
"""道法小问拆分：26/27/28 的结构、材料归属、分值缺失仍拆。"""

from pathlib import Path

from question_splitter import RawQuestion
from subject_strategies.politics_subquestions import expand


def _q(content: str, group_order: int = 26, answer: str = "") -> RawQuestion:
    return RawQuestion(group_order=group_order, group_id="二",
                       content=content, answer=answer)


Q26 = """（12分）承先之志，启时代新程。
【活动一】长征铸魂，薪火承志
2026年9月1日，以“我们的长征路”为主题的《开学第一课》正式开讲，同学们参与观看。
片一：长征途中，红军将粮食与财物分发给劳苦大众，真心实意把百姓当亲人。
(1) 结合材料, 运用所学, 以 “承先辈之志, 启时代新程” 为主题写一篇国旗下演讲稿。(8 分)
## 【活动二】文物载史，回望峥嵘
为纪念红军长征胜利90周年，国家推出很多关于长征文物的节目。
文物1：半截皮带，现收藏于中国国家博物馆
(2) 请你在以上文物中任意推荐一个文物并阐述推荐理由。(4分)
+学科观点"""

Q27 = """（19 分）2026 年是中国共产党成立 105 周年。某校九年级开展研学活动。
【活动一】十八洞村践初心，精准扶贫促共富
湖南湘西“十八洞村”在精准扶贫理念指导下脱贫摘帽。
(1) 运用所学, 仿照示例, 补全表格。(6分)
【活动二】平陆运河映初心，党的领导惠民生
平陆运河是西部陆海新通道骨干工程，于2026年9月16日正式建成通航。
(2) 结合材料, 运用所学, 谈谈平陆运河工程顺利建成的密码。(9分)
☆ 行动倡议 ☆
结合本次探究活动，班级拟向全校同学发出行动倡议。
(3) 请你完成倡议书。要求: 倡议内容需贴合青少年身份, 具体可行。(4分)"""

Q28 = """（19分）某校开展了“奋进新时代”系列活动。
【活动一】数据里的新时代
同学们调查了有关新时代的两组数据。
(1) 结合材料, 运用 “社会主要矛盾的变化” 相关知识, 谈谈你对我国当前发展状况的认识。(6分)
做法
【活动二】镜头里的新时代
同学们用自己的镜头，记录了新时代的中国故事。
(2) 你拍摄的新时代镜头是什么? 运用所学, 结合生活实际, 补全镜头四的标题和内容。(3分)
(3) 结合两个活动内容, 运用所学, 以 “奋进新时代” 为主题写一篇活动感受。(10 分)"""


def test_26_splits_two_with_own_materials():
    out = expand([_q(Q26)])
    assert [q.sub_no for q in out] == [1, 2]
    assert [q.score for q in out] == [8, 4]
    assert out[0].content.startswith("(1)")
    assert out[0].material_text.startswith("（12分）承先之志")
    assert "【活动二】" not in out[0].material_text
    assert out[1].material_text.startswith("## 【活动二】文物载史")
    assert out[1].content.startswith("(2)")
    assert "+学科观点" not in out[1].content
    assert all(q.material_position == "before" for q in out)
    assert all(q.group_order == 26 for q in out)


def test_27_splits_three():
    out = expand([_q(Q27, group_order=27)])
    assert [q.sub_no for q in out] == [1, 2, 3]
    assert [q.score for q in out] == [6, 9, 4]
    assert out[1].material_text.startswith("【活动二】平陆运河")
    assert out[2].material_text.startswith("☆ 行动倡议")


def test_28_third_inherits_previous_materials():
    out = expand([_q(Q28, group_order=28)])
    assert [q.sub_no for q in out] == [1, 2, 3]
    assert "【活动一】数据里的新时代" in out[0].material_text
    assert "【活动二】镜头里的新时代" in out[1].material_text
    # 28(3) 无自有材料，且正文指代「两个活动」→ 继承前两问材料
    assert "【活动一】数据里的新时代" in out[2].material_text
    assert "【活动二】镜头里的新时代" in out[2].material_text


def test_missing_scores_still_splits():
    content = Q26.replace("(8 分)", "").replace("(4分)", "")
    out = expand([_q(content)])
    assert len(out) == 2
    assert [q.score for q in out] == [None, None]


def test_score_mismatch_still_splits():
    content = Q26.replace("(8 分)", "(5 分)")
    out = expand([_q(content)])
    assert len(out) == 2
    assert [q.score for q in out] == [5, 4]


def test_non_contiguous_numbers_do_not_split():
    content = Q26.replace("(2) 请你", "(3) 请你")
    out = expand([_q(content)])
    assert len(out) == 1
    assert out[0].sub_no == 0


def test_stem_without_question_cue_does_not_split():
    content = """材料一
（1）这是正文里的枚举
材料二
（2）这也是正文
"""
    out = expand([_q(content)])
    assert len(out) == 1


def test_existing_material_position_is_set_for_single_question():
    q = _q(
        "（10分）阅读材料，回答问题。\n"
        "材料正文不少于六十个字：黄河是中华民族的母亲河，黄河治理事关中华民族伟大复兴，"
        "要坚持生态优先、绿色发展，让黄河成为造福人民的幸福河。\n"
        "结合材料，运用所学，谈谈你对黄河治理的认识。"
    )
    out = expand([q])
    assert len(out) == 1
    assert out[0].material_text.startswith("（10分）阅读材料")
    assert out[0].material_position == "before"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd tools/data-refinery && python3 -m pytest tests/subject_strategies/test_politics_subquestions.py -q`
Expected: FAIL（`ModuleNotFoundError: politics_subquestions`）。

- [ ] **Step 3: 实现模块**

```python
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


def _split_one(q):
    lines = q.content.split("\n")
    marks = [(i, int(m.group(1))) for i in range(len(lines))
             if (m := MARK_RE.match(lines[i].strip()))]
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


def _split_answer(answer: str, n: int) -> list[str]:
    if not answer or not answer.strip():
        return []
    lines = answer.split("\n")
    marks = [(i, int(m.group(1))) for i in range(len(lines))
             if (m := MARK_RE.match(lines[i].strip()))]
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd tools/data-refinery && python3 -m pytest tests/subject_strategies/test_politics_subquestions.py -q`
Expected: 8 passed。

- [ ] **Step 5: Commit**

```bash
git add tools/data-refinery/src/subject_strategies/politics_subquestions.py \
  tools/data-refinery/tests/subject_strategies/test_politics_subquestions.py
git commit -m "feat(refinery): 道法小问拆分规则（材料/正文/分值缺失仍拆）"
```

---

### Task 4: 接入策略、split_page 钩子与预览

**Files:**
- Modify: `tools/data-refinery/src/subject_strategies/politics.py`（整文件重写）
- Modify: `tools/data-refinery/src/subject_strategies/material_split.py:115-160`（删 `split_tail_question_rule`）
- Modify: `tools/data-refinery/src/question_splitter.py:1340-1360`
- Modify: `tools/data-refinery/src/question_extract.py:186-226`（预览题号+分值）
- Test: `tools/data-refinery/tests/subject_strategies/test_politics_subquestions.py`（补 split_page 用例）
- Test: `tools/data-refinery/tests/test_politics_material.py`（import 改路径）

**Interfaces:**
- Consumes: `politics_subquestions.expand(questions)`
- Produces: `PoliticsStrategy.expand_subquestions(questions)`
- Produces: `split_page` 末尾调用 `strategy.expand_subquestions`（若存在）

- [ ] **Step 1: 写失败测试**

追加到 `test_politics_subquestions.py`：

```python
from question_splitter import split_page
from subject_strategies import get_strategy


def test_split_page_applies_politics_expansion():
    from pathlib import Path
    qs = split_page("26. " + Q26, Path("35中.md"), strategy=get_strategy("politics"))
    assert [(q.group_order, q.sub_no) for q in qs] == [(26, 1), (26, 2)]


def test_generic_strategy_has_no_subquestion_hook():
    assert not hasattr(get_strategy("math"), "expand_subquestions")
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd tools/data-refinery && python3 -m pytest tests/subject_strategies/test_politics_subquestions.py -q`
Expected: FAIL（`split_page` 不展开，返回一条 26）。

- [ ] **Step 3: 改 politics.py**

```python
"""道法策略：A–D 四项、无跨题材料；大题按小问拆分（2026-11-23）。

材料与题目结构由 `politics_subquestions` 负责：材料→(1)→材料→(2)。
不再复用 `material_split.py`（那是物理/化学的「一段材料 + 小问」规则）。
"""

from subject_strategies.generic import NaturalScienceStrategy


class PoliticsStrategy(NaturalScienceStrategy):
    code = "politics"

    def expand_subquestions(self, questions):
        from subject_strategies.politics_subquestions import expand
        return expand(questions)
```

- [ ] **Step 4: 改 split_page 钩子**

在 `attach_post` 调用之后、`return questions` 之前加：

```python
    expand = getattr(strategy, "expand_subquestions", None)
    if callable(expand):
        questions = expand(questions)
```

- [ ] **Step 5: 从 material_split.py 删除 `split_tail_question_rule`**

删除该函数及其私有常量（`_TAIL_LEAD`、`_TAIL_HINTS`、`_MIN_TAIL_LEN`、`_MAX_TAIL_LEN`、`_OPTION_LINE`），模块 docstring 首行改为「题内材料切分（物理/化学共用规则）」。

- [ ] **Step 6: 预览显示小问号与分值**

`_print_split_preview` 里题号行改为：

```python
        no = (f"{q.group_order}({q.sub_no})" if q.sub_no
              else (f"{q.group_order:>3}" if q.group_order is not None else "  ?"))
        score = f"{q.score}分" if q.score else ""
        print(f"    {no}  {score:<4}选{len(opts)}  答：{answer or '—'}  "
              f"{material_mark}  │ {body}", flush=True)
```

- [ ] **Step 7: 更新 test_politics_material.py 的 import**

```python
from subject_strategies.politics_subquestions import split_tail_question_rule
```

（文件里原来的 `split_tail_question_rule` 调用不改名。）

- [ ] **Step 8: 跑测试**

Run: `cd tools/data-refinery && python3 -m pytest tests/subject_strategies tests/test_politics_material.py tests/test_material_split.py tests/test_no_subject_conditionals.py -q`
Expected: 全部通过。

- [ ] **Step 9: Commit**

```bash
git add tools/data-refinery/src/subject_strategies/politics.py \
  tools/data-refinery/src/subject_strategies/material_split.py \
  tools/data-refinery/src/question_splitter.py \
  tools/data-refinery/src/question_extract.py \
  tools/data-refinery/tests/subject_strategies/test_politics_subquestions.py \
  tools/data-refinery/tests/test_politics_material.py
git commit -m "feat(refinery): 道法策略接入小问拆分钩子"
```

---

### Task 5: 入库 sub_no / material_position

**Files:**
- Modify: `tools/data-refinery/src/db_loader.py:1298-1319`（`_update_question_row`）
- Modify: `tools/data-refinery/src/db_loader.py:1360-1435`（同卷匹配 + 原址更新）
- Modify: `tools/data-refinery/src/db_loader.py:1490-1575`（INSERT/重排/查重）
- Modify: `tools/data-refinery/src/db_loader.py:1640+`（`delete_paper` 清空会话）
- Test: `tools/data-refinery/tests/test_db_loader.py`

**Interfaces:**
- Consumes: 入库记录里的 `sub_no`、`material_position`
- Produces: `paper_questions.question_no` 仍为 26（不重排）；`questions.sub_no` 区分小问

- [ ] **Step 1: 写失败测试**

```python
def test_update_question_row_writes_sub_fields():
    from db_loader import DbLoader
    loader, queries = _make_loader({})
    loader._exec = lambda sql, args=None: queries.append((sql, args))
    loader._update_question_row(7, 3, {
        "group_order": 26, "type": "short_answer", "difficulty": 2,
        "content": "(1) x", "answer": "a", "sub_no": 1,
        "material_position": "before",
    }, "(1) x", None, "hash")
    sql, args = queries[-1]
    assert "sub_no=%s" in sql
    assert "material_position=%s" in sql
    assert 1 in args and "before" in args


def test_duplicate_check_groups_by_sub_no():
    from db_loader import DbLoader
    loader, queries = _make_loader({"GROUP BY pq.question_no": []})
    loader._check_duplicate_numbers(12)
    sql, _ = queries[-1]
    assert "q.sub_no" in sql
```

（`_make_loader` 与 `_check_duplicate_numbers` 见 Step 3；把查重逻辑抽成私有方法便于测试。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_db_loader.py -q`
Expected: FAIL（`sub_no=%s` 不存在 / `_check_duplicate_numbers` 未定义）。

- [ ] **Step 3: 改 SQL**

`_update_question_row` 的 SET：

```python
            "UPDATE questions SET subject_id=%s, group_id=%s, group_order=%s, sub_no=%s, type=%s, "
            "difficulty=%s, full_score=%s, content=%s, options=%s, "
            "answer=COALESCE(NULLIF(%s,''), answer), explanation=%s, approach=%s, "
            "material_text=%s, material_url=%s, material_method=%s, material_position=%s, "
            "grade_band=%s, source=%s, source_year=%s, content_hash=%s, is_active=%s WHERE id=%s",
```

参数顺序对应插入 `q.get("sub_no") or 0`、`q.get("material_position")`。

同卷原址更新查询（group_order 分支）：

```python
                    exist = self._query(
                        "SELECT q.id, q.content_hash, q.answer_verified, q.type, "
                        "q.difficulty, q.is_active, q.material_text, q.source FROM paper_questions pq "
                        "JOIN questions q ON q.id = pq.question_id "
                        "WHERE pq.paper_id=%s AND pq.group_order=%s AND q.sub_no=%s",
                        (paper[1], go, q.get("sub_no") or 0),
                    )
```

`group_order` 缺失的兜底分支同样加 `AND q.sub_no=%s`，值为 `q.get("sub_no") or 0`。

原址更新语句与 INSERT 列表加 `sub_no`、`material_position`（与 Step 1 的 SET 同序）。

重排 SQL：

```sql
UPDATE paper_questions pq
JOIN questions q ON q.id = pq.question_id
JOIN (
  SELECT pq2.paper_id, pq2.question_id,
         ROW_NUMBER() OVER (ORDER BY q2.group_order, q2.sub_no, pq2.question_no) rn
  FROM paper_questions pq2 JOIN questions q2 ON q2.id = pq2.question_id
  WHERE pq2.paper_id=%s
) t ON t.question_id = pq.question_id AND t.paper_id = pq.paper_id
SET pq.question_no = COALESCE(q.group_order, t.rn)
WHERE pq.paper_id=%s
```

把查重抽成方法：

```python
    def _check_duplicate_numbers(self, paper_id: int) -> list[int]:
        dup = self._query(
            "SELECT pq.question_no FROM paper_questions pq "
            "JOIN questions q ON q.id = pq.question_id "
            "WHERE pq.paper_id=%s GROUP BY pq.question_no, q.sub_no "
            "HAVING COUNT(*) > 1", (paper_id,))
        return [int(r[0]) for r in dup]
```

`delete_paper` 的 purge 分支末尾加：

```python
            if purge_paper_data:
                self._exec(
                    "DELETE FROM exam_sessions WHERE paper_id=%s AND id NOT IN "
                    "(SELECT DISTINCT session_id FROM exam_answers)", (paper_id,))
```

- [ ] **Step 4: 跑测试**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_db_loader.py tests/test_db_loader_cli.py -q`
Expected: 全部通过。

- [ ] **Step 5: Commit**

```bash
git add tools/data-refinery/src/db_loader.py tools/data-refinery/tests/test_db_loader.py
git commit -m "feat(refinery): 入库写入 sub_no/material_position 并按小问匹配"
```

---

### Task 6: import_cli 一条命令重导（`--reload-paper`）

**Files:**
- Modify: `tools/data-refinery/src/import_cli.py:58-168`（参数与冲突）、`232-244`（load_argv）、`642-680`（确认）
- Test: `tools/data-refinery/tests/test_import_cli.py`

**Interfaces:**
- Produces: `--reload-paper` → db_loader argv 含 `--reload-source <卷名> --purge-paper-data`

- [ ] **Step 1: 写失败测试**

```python
def test_reload_paper_uses_reload_source_and_purge():
    a = parse_args(["--subject", "道法", "--file", "35中", "--reload-paper"])
    argv = load_argv(a)
    assert "--reload-source" in argv and "35中" in argv
    assert "--purge-paper-data" in argv
    assert "--load-cards" not in argv


def test_reload_paper_conflicts_with_cards_only():
    with pytest.raises(SystemExit):
        parse_args(["--file", "35中", "--reload-paper", "--cards-only"])


def test_reload_paper_aborts_without_tty(monkeypatch):
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)
    a = parse_args(["--file", "35中", "--reload-paper"])
    assert import_cli._confirm_reload(a) == 2


def test_reload_paper_conflicts_with_skip_load():
    with pytest.raises(SystemExit):
        parse_args(["--file", "35中", "--reload-paper", "--skip-load"])
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_import_cli.py -q`
Expected: FAIL（参数不存在）。

- [ ] **Step 3: 实现**

参数：

```python
    parser.add_argument("--reload-paper", action="store_true",
                        help="重导本卷：删该卷旧题与关联业务数据后从 published 重插"
                             "（题数会变的场景；会删除该卷考试作答，不可恢复）")
```

校验（在 `parse_args` 末尾）：

```python
    if args.reload_paper:
        if not (args.file or args.files):
            parser.error("--reload-paper 需要 --file/--files 指定唯一一份卷")
        for given, flag in ((args.cards_only, "--cards-only"),
                            (args.skip_load, "--skip-load")):
            if given:
                parser.error(f"--reload-paper 不能与 {flag} 同用")
```

`load_argv` 分支：

```python
def load_argv(args) -> list[str]:
    argv = _common(args)
    if args.reload_paper:
        argv += ["--reload-source", Path(args.file or "").stem, "--purge-paper-data"]
        if args.dry_run:
            argv.append("--dry-run")
        return argv
    if _stage_file(args):
        argv += ["--file", _stage_file(args)]
    argv.append("--load-cards")
    if args.questions_only:
        argv.append("--questions-only")
    if args.cards_only:
        argv.append("--cards-only")
    if args.dry_run:
        argv.append("--dry-run")
    return argv
```

确认函数：

```python
def _confirm_reload(args) -> int | None:
    """返回 2 = 中止；None = 继续。非交互终端直接拒绝。"""
    if not args.reload_paper or args.dry_run:
        return None
    if not sys.stdin.isatty():
        print("[ERROR] --reload-paper 会删除该卷旧题与考试作答，非交互终端不允许执行",
              flush=True)
        return 2
    print(f"\n[重导] 将删除「{args.file}」的全部旧题与考试作答（不可恢复）。")
    print("是否继续？ y=继续 / 直接回车=取消 › ", end="", flush=True)
    ans = (sys.stdin.readline() or "").strip().lower()
    if ans not in ("y", "yes"):
        print("[取消] 未做任何改动", flush=True)
        return 2
    return None
```

在 `_execute` 的 `_resolve_file` 之后调用：

```python
    reload_rc = _confirm_reload(args)
    if reload_rc is not None:
        return reload_rc
```

- [ ] **Step 4: 跑测试**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_import_cli.py tests/test_import_cli_preview.py -q`
Expected: 全部通过。

- [ ] **Step 5: Commit**

```bash
git add tools/data-refinery/src/import_cli.py tools/data-refinery/tests/test_import_cli.py
git commit -m "feat(refinery): import_cli 支持 --reload-paper 单命令重导"
```

---

### Task 7: 补题链路阶段 A（防写错小问）

**Files:**
- Modify: `tools/data-refinery/src/recognition_scan.py:95-115`（issue 带 sub_no）
- Modify: `tools/data-refinery/src/manual_fix.py`（记录带 sub_no、显示 26(1)）
- Modify: `tools/data-refinery/src/apply_fixes.py:253-305, 640-665, 940-1000`（定位加 sub_no、歧义守卫、查重/重排）
- Test: `tools/data-refinery/tests/test_apply_fixes.py`（FakeCursor 片段同步）
- Test: `tools/data-refinery/tests/test_recognition_scan.py`

**Interfaces:**
- Consumes: 题目的 `sub_no`
- Produces: 人工补题记录 `{"source", "group_order", "sub_no", ...}`；无 `sub_no` 且同号多行时拒绝写入

- [ ] **Step 1: 写失败测试**

追加到 `tests/test_apply_fixes.py`：

```python
def test_apply_refuses_ambiguous_group_order_without_sub_no():
    """同号多小问、记录没有 sub_no → 不写库，返回跳过原因。"""
    cur = FakeCursor(paper=(862, 3), existing=None, orphan_id=None,
                     group_order_count=2)
    rec = {"source": "35中", "rel_path": "道法/初中/first/2026/35中",
           "group_order": 26, "content": "补的题干", "answer": ""}
    msg = _impl.apply_record(cur, rec, apply=True)
    assert "多个小问" in msg
    assert not any(sql.startswith("INSERT INTO questions") for sql, _ in cur.sql)
```

`FakeCursor.__init__` 增加 `group_order_count=1`，并在 `execute` 里匹配：

```python
        elif "SELECT COUNT(*) FROM paper_questions pq" in sql:
            self._rows = [(self.group_order_count,)]
```

同时把原来的 `elif "SELECT question_id FROM paper_questions" in sql:` 改成：

```python
        elif "SELECT pq.question_id FROM paper_questions pq" in sql:
```

（定位 SQL 改成 JOIN questions 后，旧片段匹配不到会让所有补题测试误走「新增」分支。）

实现里守卫查询：

```python
    cur.execute(
        "SELECT COUNT(*) FROM paper_questions pq JOIN questions q ON q.id=pq.question_id "
        "WHERE pq.paper_id=%s AND pq.group_order=%s", (paper_id, go))
    if int(cur.fetchone()[0]) > 1 and not rec.get("sub_no"):
        return f"跳过：第{go}题有多个小问，记录缺少 sub_no，无法确定写哪一条"
```

追加到 `tests/test_recognition_scan.py`：

```python
def test_issue_carries_sub_no(tmp_path):
    md = _md(tmp_path, "26. 甲\n")
    rows = [
        {"group_order": 26, "sub_no": 1, "content": "命题人：张三", "type": "short_answer"},
        {"group_order": 26, "sub_no": 2, "content": "命题人：李四", "type": "short_answer"},
    ]
    issues = R.scan_paper("卷A", Path("道法/x/卷A"), md, rows, None, [])
    assert {i["sub_no"] for i in issues if i["kind"] == "junk_question"} == {1, 2}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_apply_fixes.py tests/test_recognition_scan.py -q`
Expected: FAIL（无守卫、issue 无 sub_no）。

- [ ] **Step 3: 实现**

`recognition_scan.add()` 增加 `sub_no` 输出（同号多行时不能靠 `by_no` 猜）：

```python
    def add(no: int | None, kind: str, reasons: list[str], excerpt: str = "", **extra):
        sub_no = extra.pop("sub_no", by_no.get(no, {}).get("sub_no", 0))
        issues.append({
            "source": source,
            "rel_path": str(rel_path),
            "group_order": no,
            "sub_no": sub_no,
            "kind": kind,
            "reasons": reasons,
            "excerpt": _excerpt(excerpt),
            "pdf": str(pdf_path) if pdf_path else None,
            "md": str(md_path),
            "status": "pending",
            **extra,
        })
```

逐行检查的调用点显式传 `sub_no`，例如噪声题：

```python
            add(r.get("group_order"), "junk_question",
                ["content_looks_like_page_chrome"], body, sub_no=r.get("sub_no", 0))
```

（`by_no` 已在 `add()` 之前定义；同号两行时它只留最后一行，所以逐行检查必须显式传。）

`apply_fixes._existing_question`：

```python
def _existing_question(cur, paper_id: int, group_order: int, sub_no: int = 0) -> int | None:
    cur.execute(
        "SELECT pq.question_id FROM paper_questions pq "
        "JOIN questions q ON q.id = pq.question_id "
        "WHERE pq.paper_id=%s AND pq.group_order=%s AND q.sub_no=%s",
        (paper_id, group_order, sub_no))
```

`_orphan_question` 同样加 `sub_no` 条件。

`apply_record` 里：

```python
    sub_no = int(rec.get("sub_no") or 0)
    qid = _existing_question(cur, paper_id, go, sub_no)
    if qid is None:
        qid = _orphan_question(cur, paper_id, rec.get("source", ""), go, sub_no)
```

守卫（在两个查找都失败、准备 INSERT 之前）：

```python
    if qid is None:
        cur.execute(
            "SELECT COUNT(*) FROM paper_questions pq "
            "JOIN questions q ON q.id = pq.question_id "
            "WHERE pq.paper_id=%s AND pq.group_order=%s", (paper_id, go))
        if int(cur.fetchone()[0]) > 1:
            return f"跳过：第{go}题有多个小问，记录缺少 sub_no，无法确定写哪一条"
```

INSERT 增加 `sub_no` 列；`_duplicate_numbers` 与 `_renumber` 改成按 `(question_no, q.sub_no)` / `ORDER BY q.group_order, q.sub_no, q.question_no`（与 Task 5 同口径）。

`manual_fix` 的记录构造处加 `"sub_no": issue.get("sub_no", 0)`，并在提示里用：

```python
def _display_no(issue: dict) -> str:
    return f"{issue['group_order']}({issue['sub_no']})" if issue.get("sub_no") else str(issue["group_order"])
```

- [ ] **Step 4: 跑测试**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_apply_fixes.py tests/test_recognition_scan.py tests/test_manual_fix.py -q`
Expected: 全部通过（FakeCursor 片段已同步为 `SELECT pq.question_id FROM paper_questions pq`）。

- [ ] **Step 5: Commit**

```bash
git add tools/data-refinery/src/recognition_scan.py tools/data-refinery/src/manual_fix.py \
  tools/data-refinery/src/apply_fixes.py tools/data-refinery/tests/test_apply_fixes.py \
  tools/data-refinery/tests/test_recognition_scan.py
git commit -m "fix(refinery): 补题链路按 sub_no 定位，同号多小问拒绝盲写"
```

---

### Task 8: 服务端读取与 DTO

**Files:**
- Modify: `apps/server/src/database/repositories/exam-papers.repo.ts:21-27, 92-103`
- Modify: `apps/server/src/database/repositories/exam-sessions.repo.ts:53-71, 158-170`
- Modify: `apps/server/src/modules/exams/exams.service.ts:270-285, 498-511`
- Modify: `apps/server/src/modules/practice-history/practice-history.dto.ts:35-45`、`practice-history.service.ts:170-190`
- Modify: `apps/server/src/database/repositories/special-answer-records.repo.ts:115-140`
- Modify: `apps/server/src/modules/training/training.service.ts:1035-1055`（白名单透传）
- Test: `apps/server/src/database/repositories/exam-papers.repo.test.ts`
- Test: `apps/server/src/modules/exams/exams.service.test.ts`
- Test: `apps/server/src/modules/training/training.service.test.ts`

**Interfaces:**
- Produces: `SessionQuestionDto.subNo: number`、`SessionQuestionDto.materialPosition: string | null`
- Produces: 结果 item `{ questionNo, subNo, materialPosition, ... }`

- [ ] **Step 1: 写失败测试**

`exam-papers.repo.test.ts` 断言：

```ts
expect(sql).toContain('q.sub_no AS subNo');
expect(sql).toContain('q.material_position AS materialPosition');
expect(sql).toContain('ORDER BY pq.question_no, q.sub_no');
```

`exams.service.test.ts` 的 `toSessionQuestion` 用例：

```ts
expect(Object.keys(q).sort()).toEqual([
  'materialPosition', 'materialText', 'materialUrl', 'options',
  'questionId', 'questionNo', 'subNo', 'text', 'type',
]);
```

`training.service.test.ts` 白名单断言补 `subNo`、`materialPosition`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/database/repositories/exam-papers.repo.test.ts src/modules/exams/exams.service.test.ts src/modules/training/training.service.test.ts`
Expected: FAIL（缺字段）。

- [ ] **Step 3: 实现**

`exam-papers.repo.ts` SELECT：

```ts
              q.options, q.material_text AS materialText, q.material_url AS materialUrl,
              q.sub_no AS subNo, q.material_position AS materialPosition,
```

排序：`ORDER BY pq.question_no, q.sub_no`。

`exam-sessions.repo.ts` 结果查询 SELECT 加 `q.sub_no, q.material_position`，排序 `ORDER BY ea.question_order, q.sub_no, ea.question_id`；`ExamResultRow` 加 `sub_no: number; material_position: string | null;`。

`exams.service.ts`：

```ts
  private toSessionQuestion(q: {
    questionId: number; questionNo: number; subNo: number; text: string; type: string;
    options: string | null; materialText: string | null; materialUrl: string | null;
    materialPosition: string | null;
  }): SessionQuestionDto {
    return {
      questionId: q.questionId,
      questionNo: q.questionNo,
      subNo: q.subNo ?? 0,
      text: q.text,
      type: q.type,
      options: parseOptions(q.options),
      materialText: q.materialText ?? null,
      materialUrl: q.materialUrl ?? null,
      materialPosition: q.materialPosition ?? null,
    };
  }
```

结果映射（约 275 行）：

```ts
        questionNo: row.question_order,
        subNo: Number(row.sub_no ?? 0),
        materialPosition: row.material_position ?? null,
```

`practice-history.dto.ts`：

```ts
  /** 材料显示位置：'before'=题干上方；null=题干下方。 */
  materialPosition: string | null;
```

service 映射加 `materialPosition: a.material_position ?? null`。

`special-answer-records.repo.ts` SELECT 加 `q.sub_no, q.material_position`。

`training.service.ts` 题目白名单对象加：

```ts
      subNo: Number(q.sub_no ?? 0),
      materialPosition: q.material_position ?? null,
```

- [ ] **Step 4: 跑测试**

Run: `cd apps/server && npx vitest run src/database/repositories/exam-papers.repo.test.ts src/modules/exams/exams.service.test.ts src/modules/training/training.service.test.ts`
Expected: 全部通过。

- [ ] **Step 5: 全量服务端测试**

Run: `cd apps/server && npm test`
Expected: 全部通过。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/database/repositories/exam-papers.repo.ts \
  apps/server/src/database/repositories/exam-sessions.repo.ts \
  apps/server/src/database/repositories/special-answer-records.repo.ts \
  apps/server/src/modules/exams/exams.service.ts \
  apps/server/src/modules/practice-history/practice-history.dto.ts \
  apps/server/src/modules/practice-history/practice-history.service.ts \
  apps/server/src/modules/training/training.service.ts \
  apps/server/src/database/repositories/exam-papers.repo.test.ts \
  apps/server/src/modules/exams/exams.service.test.ts \
  apps/server/src/modules/training/training.service.test.ts
git commit -m "feat(server): 题目返回 subNo/materialPosition"
```

---

### Task 9: 前端类型、身份键、材料位置与题号格式

**Files:**
- Modify: `apps/web/src/components/business/answer/types.ts:4-22`
- Modify: `apps/web/src/services/api.ts`（`materialUrl` 所在的 4 个题目/结果接口类型）
- Create: `apps/web/src/components/business/answer/materialPlacement.ts`
- Modify: `apps/web/src/utils/questionSource.ts:22-25`
- Test: `apps/web/src/utils/questionSource.test.ts`（新建）
- Test: `apps/web/src/components/business/answer/materialPlacement.test.ts`（新建）

**Interfaces:**
- Produces: `RunnerQuestion.subNo?: number | null`、`RunnerQuestion.materialPosition?: 'before' | 'after' | null`
- Produces: `materialSlots(q) -> { above: string | null; below: string | null }`
- Produces: `formatPaperQuestionNo(no, subNo?)`

- [ ] **Step 1: 写失败测试**

`questionSource.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { formatPaperQuestionNo } from './questionSource';

describe('formatPaperQuestionNo', () => {
  it('无小问', () => expect(formatPaperQuestionNo(26)).toBe('试卷第 26 题'));
  it('有小问', () => expect(formatPaperQuestionNo(26, 1)).toBe('试卷第 26 题(1)'));
  it('subNo=0 当没有', () => expect(formatPaperQuestionNo(26, 0)).toBe('试卷第 26 题'));
  it('空值', () => expect(formatPaperQuestionNo(null)).toBeNull());
});
```

`materialPlacement.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { materialSlots } from './materialPlacement';

describe('materialSlots', () => {
  it('before 放题干上方', () => {
    expect(materialSlots({ material: '材料', materialPosition: 'before' }))
      .toEqual({ above: '材料', below: null });
  });
  it('默认放题干下方', () => {
    expect(materialSlots({ material: '材料' }))
      .toEqual({ above: null, below: '材料' });
  });
  it('空白材料视为无', () => {
    expect(materialSlots({ material: '  ', materialPosition: 'before' }))
      .toEqual({ above: null, below: null });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/utils/questionSource.test.ts src/components/business/answer/materialPlacement.test.ts`
Expected: FAIL（函数/参数不存在）。

- [ ] **Step 3: 实现**

`types.ts` 的 `RunnerQuestion` 加：

```ts
  /** 小问序号（0/空 = 无小问）；与 questionNo 组成唯一标识 */
  subNo?: number | null;
  /** 材料位置：'before'=题干上方；空=题干下方 */
  materialPosition?: 'before' | 'after' | null;
```

`api.ts` 里 4 处带 `materialUrl` 的接口类型（考试题目 / 考试结果 item / 专项题单条目 / 练习历史题）各加（**可选**，避免几十处测试 fixture 全部要补字段）：

```ts
  subNo?: number;
  materialPosition?: string | null;
```

（服务端 Task 8 已返回；前端类型漏了会在页面映射处报 `Property 'subNo' does not exist`。）

`materialPlacement.ts`：

```ts
export function materialSlots(q: {
  material?: string | null;
  materialPosition?: string | null;
}): { above: string | null; below: string | null } {
  const text = q.material?.trim() ? q.material : null;
  return q.materialPosition === 'before'
    ? { above: text, below: null }
    : { above: null, below: text };
}
```

`questionSource.ts`：

```ts
export function formatPaperQuestionNo(
  questionNo: number | null | undefined,
  subNo?: number | null,
): string | null {
  if (questionNo == null) return null;
  return subNo ? `试卷第 ${questionNo} 题(${subNo})` : `试卷第 ${questionNo} 题`;
}
```

- [ ] **Step 4: 跑测试**

Run: `cd apps/web && npx vitest run src/utils/questionSource.test.ts src/components/business/answer/materialPlacement.test.ts`
Expected: 7 passed。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/business/answer/types.ts \
  apps/web/src/components/business/answer/materialPlacement.ts \
  apps/web/src/utils/questionSource.ts \
  apps/web/src/utils/questionSource.test.ts \
  apps/web/src/components/business/answer/materialPlacement.test.ts
git commit -m "feat(web): RunnerQuestion 支持 subNo/materialPosition 与题号格式化"
```

---

### Task 10: 前端四处渲染点与教研页

**Files:**
- Modify: `apps/web/src/components/business/answer/QuestionRunner.tsx:585-646`
- Modify: `apps/web/src/components/business/AnswerResultList.tsx:224-241`
- Modify: `apps/web/src/components/business/print/PrintPaper.tsx:62-128`
- Modify: `apps/web/src/pages/student/PracticeHistoryDetailPage.tsx:226-248`
- Modify: `apps/web/src/pages/student/training/ExamRunPage.tsx:167-185`
- Modify: `apps/web/src/pages/student/training/ExamResultPage.tsx:170-182`
- Modify: `apps/web/src/pages/student/training/TargetedRunPage.tsx:134-156`
- Modify: `apps/web/src/pages/research/ResearchPaperDetailPage.tsx:262`、`ResearchQuestionEditDrawer.tsx:596-626`
- Test: `QuestionRunner.test.tsx`、`AnswerResultList.test.tsx`、`PrintPaper.test.tsx`、`ExamRunPage.test.tsx`
- Test: `ResearchPaperDetailPage.test.tsx`

**Interfaces:**
- Consumes: `materialSlots`、`formatPaperQuestionNo(no, subNo)`
- Produces: 作答/结果/历史/打印材料位置一致；26(1)/26(2) 不撞 key

- [ ] **Step 1: 写失败测试**

`QuestionRunner.test.tsx`：

```tsx
it('materialPosition=before 时材料渲染在题干上方', () => {
  const q: RunnerQuestion[] = [{
    n: '26(1)', text: '(1) 结合材料', type: 'short_answer',
    material: '活动一材料', materialPosition: 'before',
  }];
  render(<QuestionRunner questions={q} subjectId={5} draftKeyPrefix="before"
    variant="embedded" onSubmit={async () => ({ isCorrect: null, method: 'self_assess' })}
    onFinish={async () => {}} />);
  const material = screen.getByTestId('question-material-text');
  const stem = screen.getByTestId('question-stem');
  expect(material.compareDocumentPosition(stem) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
```

`ExamRunPage.test.tsx`：

```tsx
it('同题号两条小问的 n 不冲突', async () => {
  mockSession({ questions: [
    { questionId: 1, questionNo: 26, subNo: 1, text: '(1) x', type: 'short_answer', options: null, materialText: 'm1', materialUrl: null, materialPosition: 'before' },
    { questionId: 2, questionNo: 26, subNo: 2, text: '(2) y', type: 'short_answer', options: null, materialText: 'm2', materialUrl: null, materialPosition: 'before' },
  ]});
  await screen.findByText('第 1/2 题');
  // 答第一题，确认第二题不带上第一题的答案
});
```

（按该文件现有 mock 工具补全；核心断言：`n` 为 `26(1)`/`26(2)`。）

`PrintPaper.test.tsx`：`before` 的材料块出现在 `print-q-body` 之前；`after` 在之后。

`ResearchPaperDetailPage.test.tsx`：两条同号题渲染 `26(1)`、`26(2)`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/components/business/answer/QuestionRunner.test.tsx src/pages/student/training/ExamRunPage.test.tsx`
Expected: FAIL（材料仍在下方 / n 相同）。

- [ ] **Step 3: 改渲染**

`QuestionRunner` 两处 `MaterialBlock` 改为：

```tsx
const slots = materialSlots(q);
// 文档恒在上；material_text 按位置放上/下

<MaterialBlock
  url={q.materialUrl}
  text={slots.above}
  variant="answer"
  draggable
  testId="question-material"
  className={nonScienceSubject ? '' : 'max-h-[38vh] overflow-y-auto'}
/>

<MaterialBlock
  url={null}
  text={slots.below}
  variant="answer"
  draggable
  testId="question-material-text"
  className={`mt-3 ${nonScienceSubject ? '' : 'max-h-[38vh] overflow-y-auto'}`}
/>
```

`AnswerResultList`、`PrintPaper`、`PracticeHistoryDetailPage` 同样用 `materialSlots(q)`。

`PrintPaper` 的 `showText` 去重逻辑保留：

```tsx
const slots = materialSlots(q);
const showAbove = slots.above !== null && slots.above !== lastText;
const showBelow = slots.below !== null && slots.below !== lastText;
lastText = slots.above ?? slots.below ?? lastText;
```

`ExamRunPage` / `ExamResultPage`：

```tsx
n: q.subNo ? `${q.questionNo}(${q.subNo})` : String(q.questionNo),
material: q.materialText,
materialUrl: q.materialUrl,
materialPosition: q.materialPosition ?? null,
subNo: q.subNo ?? null,
```

`ExamResultPage` 的 `questionIdByN` 同样使用复合 `n`。

`TargetedRunPage` 的两处映射补：

```tsx
subNo: e.subNo ?? null,
materialPosition: e.materialPosition ?? null,
```

来源行：

```tsx
{formatPaperQuestionNo(q.questionNo, q.subNo) ? ` · ${formatPaperQuestionNo(q.questionNo, q.subNo)}` : ''}
```

`ResearchPaperDetailPage`：

```tsx
<td>{q.questionNo}{q.subNo ? `(${q.subNo})` : ''}</td>
```

`ResearchQuestionEditDrawer` 标题：

```tsx
{`编辑题目 #${question.questionNo}${question.subNo ? `(${question.subNo})` : ''}`}
```

- [ ] **Step 4: 跑测试**

Run: `cd apps/web && npx vitest run src/components/business/answer src/components/business/AnswerResultList.test.tsx src/components/business/print/PrintPaper.test.tsx src/pages/student/training/ExamRunPage.test.tsx src/pages/research/__tests__/ResearchPaperDetailPage.test.tsx`
Expected: 全部通过。

- [ ] **Step 5: 全量前端测试与构建**

Run: `cd apps/web && npm test && npm run build`
Expected: 全部通过、构建成功。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/business/answer/QuestionRunner.tsx \
  apps/web/src/components/business/AnswerResultList.tsx \
  apps/web/src/components/business/print/PrintPaper.tsx \
  apps/web/src/pages/student/PracticeHistoryDetailPage.tsx \
  apps/web/src/pages/student/training/ExamRunPage.tsx \
  apps/web/src/pages/student/training/ExamResultPage.tsx \
  apps/web/src/pages/student/training/TargetedRunPage.tsx \
  apps/web/src/pages/research/ResearchPaperDetailPage.tsx \
  apps/web/src/pages/research/ResearchQuestionEditDrawer.tsx \
  apps/web/src/components/business/answer/QuestionRunner.test.tsx \
  apps/web/src/components/business/AnswerResultList.test.tsx \
  apps/web/src/components/business/print/PrintPaper.test.tsx \
  apps/web/src/pages/student/training/ExamRunPage.test.tsx \
  apps/web/src/pages/research/__tests__/ResearchPaperDetailPage.test.tsx
git commit -m "feat(web): 材料按 materialPosition 渲染，题号显示 26(1)"
```

---

### Task 11: 快照基线、35 中重导与端到端验证

**Files:**
- Modify: `tools/data-refinery/src/split_snapshot.py:47-60`（item 加 `sub`）
- Update: `tools/data-refinery/tests/fixtures/split_snapshot.json`（`--write`）

**Interfaces:**
- Produces: 快照差异行能区分 26(1)/26(2)

- [ ] **Step 1: 快照 item 加 sub**

```python
                {"no": q.group_order,
                 "sub": q.sub_no,
                 "hash": ...,
                 "mat": ...,
                 "gid": q.group_id,
                 "score": q.score}
```

`_ITEM_FIELDS = ("no", "sub", "gid", "score", "hash", "mat")`。

- [ ] **Step 2: 先拍差分**

Run: `cd tools/data-refinery && python3 src/split_snapshot.py --check`
Expected: 只有**道法样本卷**报差异（题数变多、出现 `sub 1/2/3`），语文/数学/物理/化学零差异。若有其它学科差异 → 停下修。

- [ ] **Step 3: 重写基线**

Run: `cd tools/data-refinery && python3 src/split_snapshot.py --write && python3 src/split_snapshot.py --check`
Expected: 第二次 check 零差异。

- [ ] **Step 4: 预览 35 中**

Run: `cd tools/data-refinery && python3 src/import_cli.py --subject 道法 --file "35中" --preview`
Expected: 输出 26(1) 8分、26(2) 4分、27(1) 6分、27(2) 9分、27(3) 4分、28(1) 6分、28(2) 3分、28(3) 10分；26(1) 材料含活动一、不含活动二。

- [ ] **Step 5: 真正重导（一条命令）**

Run: `cd tools/data-refinery && python3 src/import_cli.py --subject 道法 --file "35中" --re-extract --re-publish --reload-paper`
Expected: 提示重导 → 输入 `y`；结束入库 33 题。

- [ ] **Step 6: 库校验**

```bash
mysql -h 127.0.0.1 -P 3306 -u ai_k12 -pai_k12 ai_k12 --table -e "
SELECT q.group_order, q.sub_no, q.full_score, q.material_position
FROM questions q JOIN subjects s ON s.id=q.subject_id
WHERE s.code='politics' AND q.source='35中初三上道法期中试卷'
ORDER BY q.group_order, q.sub_no"
```

Expected：26 两行 8/4、27 三行 6/9/4、28 三行 6/3/10，`material_position` 全部 `before`；海淀卷（另一 source）保持 `sub_no=0`。

- [ ] **Step 7: 全量测试**

```bash
cd tools/data-refinery && python3 -m pytest -q
cd ../../apps/server && npm test
cd ../web && npm test
```

Expected: 全部通过。

- [ ] **Step 8: Commit**

```bash
git add tools/data-refinery/src/split_snapshot.py \
  tools/data-refinery/tests/fixtures/split_snapshot.json
git commit -m "test(refinery): 切题快照覆盖小问序号并更新基线"
```

---

### Task 12: 文档与 API 契约同步

**Files:**
- Modify: `docs/API接口与数据流设计文档.md`（题目返回字段说明）
- Modify: `docs/api/openapi.yaml`（对应 schema）
- Modify: `docs/constraints/数据管线.md`（道法切题策略）
- Modify: `docs/ai-core-changelog.md`（本次改动与实测数字）
- Modify: `docs/superpowers/specs/2026-11-23-politics-subquestion-split-design.md:4`（状态改为「已批准 / 已实施」）

- [ ] **Step 1: 补 API 文档**

在返回题目对象的字段说明里加：

```
subNo            number   小问序号；0=非小问（如道法 26 题的 26(1)/26(2)）
materialPosition string   材料位置；'before'=题干上方；null=题干下方
```

`openapi.yaml` 对应 schema 同步加 `subNo`（integer, default 0）与 `materialPosition`（string, nullable）。

- [ ] **Step 2: 更新约束文档**

`docs/constraints/数据管线.md` 的切题策略段落加一条：道法大题由 `politics_subquestions.py` 按 `(1)(2)` 拆小问，`material_split.py` 只服务物理/化学；`sub_no` 语义与「分值不参与拆题判定」。

- [ ] **Step 3: changelog**

`docs/ai-core-changelog.md` 追加本次记录：35 中 28→33 题、26/27/28 的小问与分值、海淀未动、`--reload-paper` 用法。

- [ ] **Step 4: 改 spec 状态**

第 4 行改为：

```markdown
**状态**：已批准（2026-11-23）；实施计划见 `docs/superpowers/plans/2026-11-23-politics-subquestion-split.md`
```

- [ ] **Step 5: Commit**

```bash
git add docs/API接口与数据流设计文档.md docs/api/openapi.yaml \
  docs/constraints/数据管线.md docs/ai-core-changelog.md \
  docs/superpowers/specs/2026-11-23-politics-subquestion-split-design.md
git commit -m "docs: 道法小问拆题上线记录与契约同步"
```

---

## 延后（不在本计划）

- spec 7.7 **阶段 B**：`recognition_scan` / `apply_fixes` / `manual_fix` 身份键全面升级为 `(source, group_order, sub_no)`。本计划只做阶段 A（防写错）；阶段 B 完成前，道法小问的人工补题只能改 md 重切，另立计划。
- 物理/化学实验探究题拆小问。
- 语文作文二选一/文言文多问拆分。

## 验收清单（对应 spec 第 11 节）

- [ ] `--preview` 输出小问号与分值
- [ ] 35 中入库 33 题，`sub_no`/`material_position` 正确
- [ ] 作答/结果/历史/打印四处材料在题干上方、题号 26(1)
- [ ] 海淀旧题 `sub_no=0`、材料仍在下方
- [ ] `pytest` / `npm test`（server+web）/ `split_snapshot --check` 全绿
