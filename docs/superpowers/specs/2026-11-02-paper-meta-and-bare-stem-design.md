# 试卷元数据补全 + 裸题号识别 — 设计

**日期**：2026-11-02
**状态**：待用户审核（未实现）
**起因**：用户导入 `数学-初三(上)-202507-北京各-（上）期中-试卷-86419.pdf` 后系统里看不到这张卷；且该卷有 5 题没能自动切出来。用户提出两条改进：①文件名缺区县/学校时应从卷面内容提取；②题号丢点（`11 xxx`）时用规则+本地 LLM 判断是否为新题。

---

## 1. 现象与根因（均已实测）

### 1.1 卷子看不到

| 证据 | 结论 |
|---|---|
| `questions` 有该卷 23 题（id 6620–6642），`is_active=1`，答案已回填 | 题目入库了 |
| `exam_papers`/`paper_questions` 查不到该卷 | **试卷实体没建** |
| 前端试卷列表 `SELECT … FROM exam_papers`（`apps/server/src/database/repositories/exam-papers.repo.ts:57`） | 没这一行 → 永远不显示 |

根因链：

1. 爬虫在重名时给文件加来源 id 后缀：`tools/crawler/src/core/storage.py:38`（`…-试卷.pdf` → `…-试卷-86419.pdf`）。
2. `paper_meta._FILENAME_RE` 只认 `-试卷.jsonl` 结尾（`tools/data-refinery/src/paper_meta.py:19`），`-86419` 导致 `parse_paper_meta()` 返回 `None`（实测）。
3. `db_loader_cli` 遇 `None` 只打一行 `[WARN] …无法解析试卷元数据，题目照常入库但不归组`，然后**照常入库题目**（`db_loader_cli.py:293`），命令整体返回 0。
4. 同一批 `北京各` 卷 2024 年 56 份、2025 年 14 份，文件名几乎全带 id 后缀 —— 这些卷若按现状导入，全部只进题、不建卷。

### 1.2 少 5 题

- 抽题产物只有 23 题，缺 5/9/11/12/13；实测题 5 并进题 4（296 字）、题 9 并进题 8（316 字）、题 11/12/13 全并进题 10（388 字）。
- 原因：切题器只认 `N.` `N．` `N:` `N（1）`（`question_splitter.py:16`），OCR 丢点后 `11 在平面直角坐标系…` 整行被当正文。
- 该卷 md 在抽题（15:54）之后被改过（16:11），当前版本能切出 28/28；所以这卷重抽即可，但规则缺陷会复发。

### 1.3 卷面信息被浪费

- `北京各` 是爬虫的"北京市各区"集合名，不是区县；按现状会写进 `exam_papers.district`，前端筛选下拉会多出一个假区县（`ExamListPage.tsx:143` 用 distinct district 生成选项）。
- 卷面首屏普遍写明区县/学校，实测 14 份 2025 卷：12 份能取到区县或学校，2 份（86425、86499）什么都没有。
- 年级也会错：`…-86392` 卷面是「初二数学」，路径写「初三(上)」。

---

## 2. 设计原则

1. **路径管结构，卷面管内容**：学科/学段/学期/年份仍以路径为准；区县/学校/年级以卷面为准。
2. **不猜**：卷面没写的区县留 `NULL`，不做"学校→区县"推断，不建映射表（用户 2026-11-02 裁决）。
3. **规则优先，LLM 兜底**：LLM 只在规则拿不准时调用，一次处理整卷；返回结果必须通过服务端校验才采纳。
4. **不破坏幂等**：`exam_papers.source_key` 仍是 published 相对路径；重导同一卷只更新，不新建。
5. **不阻塞导入**：元数据/LLM 失败只告警，不中断管线。

---

## 3. 改动一：文件名容错（`paper_meta`）

`_FILENAME_RE` 允许 `-试卷|答案` 后跟可选的 `-<数字>`：

```python
r"-(?P<file_type>试卷|答案)(?:-\d+)?\.jsonl$"
```

- `title` 合成规则不变，id 不进标题。
- 平面/嵌套两种布局都受益（嵌套要求目录名 == 文件 stem，两侧都带 id，仍然相等）。
- 新增测试：`数学-初三(上)-202507-北京各-（上）期中-试卷-86419` 平面 + 嵌套各一条，断言 `title` 不含 `86419`。

---

## 4. 改动二：卷面元数据（新模块 `src/paper_head.py`）

### 4.1 输入

`md` 全文（抽题前已做全角括号归一、二维码剔除）。取**首屏**：前 15 个非空行，去掉 `#`、`<table>…</table>`、纯图片行。

### 4.2 输出

```python
@dataclass
class HeadMeta:
    district: str | None   # 海淀 / 西城 / 房山 …（不含"区"）
    school: str | None     # 北京市西城区德胜中学
    grade: str | None      # 初一/初二/初三/高一…
    evidence: str          # 命中的原句，落 sidecar 便于复核
```

### 4.3 规则

| 字段 | 规则 |
|---|---|
| district | 在北京 16 区 + 经开区名单内匹配；优先带「区」字样（`海淀区`/`北京市西城区`），其次标题行内出现区名（`2025 北京海淀初三…`）；`学校` 后缀词里的区名不算（避免把「海淀外国语学校」当区县来源） |
| school | `[\u4e00-\u9fff]{2,12}(中学|学校|附中|教育集团|小学)`，排除含「填写/准确填写/在试卷/答题卡/学校名称」的泛化片段；取最长匹配 |
| grade | `初[一二三]` / `[七八九]年级` → 初一/初二/初三；`高[一二三]` / 高中 |

### 4.4 LLM 兜底

- 触发条件：`district` 与 `school` **都**为空，或 `grade` 为空。
- 输入：首屏原文（≤ 800 字）+ 已知路径字段；提示词要求只从原文摘取，允许 `null`，**禁止推断**。
- 模型：现有 `create_llm_client(config.llm_provider, …)`；失败/超时 → 全部字段留空，打 `[meta] 跳过（LLM 不可用）`。
- 校验：`district` 必须落在 16 区名单；`grade` 必须是允许集合；否则丢弃该字段。

### 4.5 合并规则（路径 + 卷面）

```python
COLLECTIVE = {"北京各", "待确认", "未知", ""}   # 路径 district 的集合名

district = head.district if path.district in COLLECTIVE else path.district
school   = head.school
grade    = head.grade or path.grade          # 冲突时用卷面并记 mismatch
title    = f"{year} {location} {grade} {exam_type}"
# location = "区·学校" | "区" | "学校" | 原路径 location（信息全无时兜底）
```

- `mismatch`（卷面年级 ≠ 路径年级）写入导入日志：`[meta] 文件名写初三，卷面是初二（以卷面为准）`。
- sidecar 落盘：`output/meta/<published 相对目录>/<卷名>.json`，内容含字段、证据、mismatch；**可人工修改后重跑入库**。

### 4.6 管线接线

- 新增 `src/paper_meta_cli.py`（模块级 `run(cfg, scope, dry_run)`；CLI 只做参数解析），只处理「范围内已转 md 的试卷」，**不写库**，只写 sidecar。
- `import_cli` 新增第 4 步「试卷元数据（卷面 → sidecar）」，位于 publish 之后、db_loader 之前；`--skip-meta` 可跳过。
- `db_loader_cli`：建卷时读 sidecar；`db_loader._find_or_create_paper` 改为 **find-or-update**（title/district/grade/grade_band/semester/year/exam_type 有变化就 UPDATE），并打印 `[paper] 更新元数据：…`。
- 无 sidecar → 走原路径逻辑（向后兼容）。

---

## 5. 改动三：裸题号识别（`question_splitter`）

### 5.1 规则级（默认路径，不调模型）

新增候选正则：

```python
_BARE_STEM_RE = re.compile(r"^\s*#{0,6}\s*(\d{1,2})\s+(?=[^\d\s])")
```

采纳条件（全部满足）：

1. 该行前有空行（`has_blank_before`），即独立成段；
2. `N == last_stem_no + 1`（题号连续，不允许跳号）；
3. 数字后正文 ≥ 6 字，且含中文；
4. 后文 40 行内能遇到下一个合法题号 `N+1`，或先遇到大题标题 / `第一部分` / 答案关键字 / 文末。

四条都满足 → 与 `N.` 等价处理（剥离题号前缀后进题干）。

### 5.2 LLM 级（兜底）

- 规则不满足的候选 → 记为 suspect（行号、原文、前后各 2 行、期望题号）。
- 整卷**一次**调用本地 LLM（不是逐行）：提示词给全部 suspect，要求返回
  `{"stems":[{"line_no":123,"number":11,"is_stem":true}]}`；只认 `is_stem=true` 且 `number == 期望值` 的条目（防幻觉）。
- 采纳的条目作为 `forced_stem_lines` 重跑切分（同一个 `split_page`，第二遍）。
- `split_page(text, md_path, strategy, forced_stem_lines=set(), suspects_out=None)`：保持纯函数；LLM 调用在 `question_extract.extract_questions_file` 里做，测试用 fake resolver。
- 所有判定（含被否掉的）落 `output/split_suspects.jsonl`：卷名、行号、原文摘要、规则/LLM 结论。
- LLM 不可用 → 只告警，按规则级结果继续；这些题仍会被第 6 步扫描报出来，走原有人工补题通道。

### 5.3 防误判

- 行首 4 位年份（`2024 年…`）、小数（`3.5 …`）、纯数字行（`2`）、`第 N 页` 一律排除。
- 同一题号已存在（`seen_stems`）→ 不算新题。
- 选择题区里出现裸题号仍要求 ②④，避免把选项行（`A.` 之外的 `2 个` 之类）抬成题。

---

## 6. 不改的部分

- 不改爬虫命名规则、不改文件/目录名（`-86419` 保留，作为 source_key 的一部分）。
- 不动 `questions`/`paper_questions` 结构；不加 `school` 列（学校只进 `exam_papers.title`）。
- 不建学校→区县映射表、不做 LLM 外部推断。
- 不动 `in_exam`、抽题池、判题、前端；前端无需改代码（`district` 变 NULL 后自然从筛选下拉消失）。

---

## 7. 验收

1. `pytest tools/data-refinery/tests` 全绿；新增：
   - `test_paper_meta.py`：id 后缀（平面/嵌套）、`北京各` 不当 district；
   - `test_paper_head.py`：14 份真实首屏的区县/学校/年级抽取（含空信息两份）、LLM 校验拒绝非法区县；
   - `test_question_splitter.py`：裸题号 4 例（含本卷 9/11/12/13）+ 4 类误判样例（年份/小数/纯数字/选项续行）+ `forced_stem_lines` 生效。
2. 一条命令重导 2025 年 14 份「北京各」卷：
   ```bash
   cd tools/data-refinery && python3 src/import_cli.py --subject 数学 --year 2025 --file "北京各"
   ```
3. 验库：
   - `exam_papers` 出现 14 行，`district` 不再是「北京各」，title 形如 `2025 海淀 初三 （上）期中` / `2025 德胜中学 初二 （上）期中`；
   - 86419 的 `paper_questions` 为 28 行，题 5/9/11/12/13 存在且 `is_active=1`；
   - 86392 的 `grade='初二'` 且导入日志有 mismatch 提示。
4. 前端「训练 → 数学 → 真题试卷」能看到这 14 卷，区县下拉无「北京各」。

---

## 8. 风险与回退

| 风险 | 处理 |
|---|---|
| LLM 把正文行误判成题号 | 必须 `number == 期望题号`；所有判定留 `split_suspects.jsonl`；误判可 `--re-extract` 重来 |
| 卷面标题 OCR 缺失 → 元数据仍空 | 留空，不阻断；sidecar 可人工改后只重跑入库（`--skip-convert --skip-extract --skip-publish`） |
| 重导覆盖人工核验的题 | `db_loader` 已有 `answer_verified=1` 不覆盖逻辑，沿用 |
| 2024 年 56 份同批卷 | 本次不动；同一条命令换 `--year 2024` 即可，另行确认成本 |
