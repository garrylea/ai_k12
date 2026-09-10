# 题目内容更新工具（answer_importer）设计

- 日期：2026-09-10
- 归属：`tools/data-refinery/`（离线数据工具，pymysql 直连 DB）
- 前置：`docs/superpowers/plans/2026-09-09-answer-importer.md`（未实现，本设计是其扩展与取代）
- 关联：`docs/superpowers/specs/2026-09-09-judging-rework-design.md` §4（答案离线补全）

## 1. 背景与动机

`questions` 表当前只有 `answer`（标准答案）与 `explanation`（详细解析）两个内容字段。题库存量存在缺口（约 188 道空答案、451 道无解析），且题型重构（`short_answer` → `calculation`）需要回写 `type`。

同时产品侧需要「解题思路」——一个介于「标准答案」和「完整解析」之间的**方法/切入点概述**（考点判断、选什么方法、关键转化），用于帮助学生先建立解题方向，而不是直接看完整过程。

`2026-09-09-answer-importer.md` 已规划了一个按试卷导入答案的 `answer_importer`，但：

1. 仅支持 `answer/explanation/type`，不含 `approach`；
2. 输入只支持「按试卷 + 印刷题号」的 Markdown 文档，无法表达单题编辑、跨卷批量、按缺口补全等场景。

本设计在其三层架构上扩展：**新增 `approach` 列、新增 JSONL 输入、新增选择器与导出模板**。

## 2. 目标与非目标

### 目标

- 更新 `questions` 的 **answer / approach / explanation / type** 四个字段。
- 支持三种及以上粒度：单题、批量、按试卷、按缺口/属性批量。
- 输入友好：既支持人工/AI 编写的 Markdown 按卷文档，也支持可编程生成的 JSONL。
- 安全：dry-run 默认、写前确认、范围校验、幂等重跑。

### 非目标（本次不做）

- 后端 API 返回 `approach`（`GET /training/questions/explanations` 等）。
- 前端结果页/解析区展示「解题思路」。
- 复用 `question_hints`（其语义是苏格拉底式提示，故意不给解法，与本工具无关）。
- 课时（lesson）/ 知识点（knowledge_point）维度的选择器。

## 3. DB 变更

原计划 `2026-09-09-answer-importer.md` 的 `answer_verified` 迁移尚未实现，故与 `approach` 合并为同一个迁移。

### 3.1 迁移脚本

`tools/db/migrations/2026-09-10_add_questions_approach_verified.sql`：

```sql
-- 2026-09-10 题目内容更新工具：新增解题思路列 + 人工/AI 核验标记。
-- approach       解题思路：方法/切入点概述（考点判断、选什么方法、关键转化），
--                与 explanation（完整分步过程）分离。
-- answer_verified 由 answer_importer 成功写入任一字段（answer/approach/explanation/type）时置 1，
--                用于与管线提取的原始数据（0）区分。
ALTER TABLE questions
  ADD COLUMN approach TEXT DEFAULT NULL AFTER explanation,
  ADD COLUMN answer_verified TINYINT(1) NOT NULL DEFAULT 0;
```

### 3.2 schema.sql 折回

`tools/db/schema.sql` 的 questions 表（`explanation` 之后插入 `approach`；`is_active` 之前插入 `answer_verified`）：

```sql
  explanation TEXT DEFAULT NULL,
  approach TEXT DEFAULT NULL,                       -- 解题思路（方法/切入点概述）
  ...
  answer_verified TINYINT(1) NOT NULL DEFAULT 0,    -- 人工/AI 核验导入标记（answer_importer 置 1）
  is_active TINYINT(1) NOT NULL DEFAULT 1,
```

（带折回注释，先例见 schema.sql 训练模块表区块。`install_mysql.sh` 只执行 schema.sql，迁移需折回。）

### 3.3 字段语义边界

| 字段 | 语义 | 载体 |
|---|---|---|
| `answer` | 标准答案（最终结果） | `questions.answer` |
| `approach` | 解题思路：方法/切入点概述，不含逐步计算 | `questions.approach`（新增） |
| `explanation` | 详细解析：完整分步过程 | `questions.explanation` |
| `hint` | 苏格拉底式提示（故意不给解法） | `question_hints.hint`（与本次无关） |

### 3.4 实现期检查

`tools/data-refinery/src/db_loader.py` 的 `INSERT INTO questions (...)` 若为显式列清单则无需改动（新列走 DEFAULT）；若用 `SELECT *` 语义需同步补列。执行时 grep 确认。

## 4. 输入结构

### 4.1 canonical：JSONL

每行一个 JSON 对象。

```jsonl
{"question_id": 12345, "answer": "B", "approach": "先配方求顶点，再取对称轴处最值", "explanation": "完整过程…"}
{"paper_id": 3, "question_no": 17, "approach": "利用相似三角形转化", "type": "calculation"}
{"content_hash": "ab12…", "explanation": "……"}
```

**定位键（三选一，必填）**：

| 键 | 说明 |
|---|---|
| `question_id` | `questions.id` 主键，最精确，推荐 |
| `paper_id` + `question_no` | 试卷内印刷题号，经 `paper_questions` 定位 |
| `content_hash` | `questions.content_hash`，用于跨卷去重题 |

同时提供多个定位键冲突时（如既有 `question_id` 又有 `paper_id`）→ 报错跳过，不猜。

**内容字段（至少一个）**：`answer` / `approach` / `explanation` / `type`。

**可选元数据**：`note`（自由备注，仅回显到报告，不入库）。

### 4.2 兼容：Markdown 按卷文档

沿用原计划格式，扩展 `思路：` 字段：

```markdown
# 试卷：2024 海淀 初三 模拟二

## 1
答案：B
思路：由顶点式 $y=(x-2)^2+3$ 知顶点为 $(2,3)$，开口向上故在对称轴处取最小值。
解析：完整分步过程……

## 17
答案：解：设……所以 $x=2$。
思路：先设未知数，利用总价相等列一元二次方程。
题型：calculation
```

字段规则：

- `# 试卷：<标题>` 定义目标试卷（用于定位 `exam_papers`，可重名，CLI 列候选）。
- `## <印刷题号>` 对应 `paper_questions.question_no`。
- `答案` / `思路` / `解析` / `题型` 四个字段；`答案` 必填（原计划约束，空则文档校验错误），`思路`/`解析`/`题型` 可选。
- 多行内容直接换行续写，空行断开；全角/半角冒号均可。
- 公式用 `$...$` LaTeX。

Markdown 解析结果与 JSONL 统一为同一种中间结构 `AnswerRecord`（定位键为 `paper_id`（由标题定位后填充）+ `question_no`）。

**与 §5 的关系**：§5 的「缺省=不改、空串=不改」适用于 JSONL 的各个内容字段（均可选）；Markdown 适配器额外要求每题必须有非空 `答案`，属文档级校验，二者不冲突。

## 5. 更新语义（字段级，幂等）

| 情况 | 行为 |
|---|---|
| 字段**缺省**（记录里没写） | 不改 |
| 字段**非空** | 覆盖库内值 |
| 字段**空串/纯空白** | 视为未提供，不改；报告 warning |
| `type` 值不在合法枚举 | **解析阶段报错并终止整批**（该批全部不写入，退出码 2；非法 type 属文件级错误，数据工具宁可不写也不半批） |
| 任意字段实际写入 | 同一条 UPDATE 内 `answer_verified = 1` |
| diff 为空（与库内完全一致） | 不发 UPDATE（幂等重跑） |
| 有写入 | 刷新 `updated_at` |

说明：**不提供「清空字段」语义**。理由：清空是危险且罕见的操作；确需清空可直连 DB。空串=不改，避免 AI/人工漏填意外抹掉已有内容。

说明：`type` 非法采用 fail-fast——解析阶段即报错终止整批（不是跳过单条）。这与"定位失败/范围外跳过"不同：那两类是运行期逐条判定，会分条报告；`type` 非法是文件级 schema 错误。

## 6. 选择器 `--where` 与导出模板 `--export`

选择器只**圈定范围**，不承载内容。支持维度：

| 维度 | 参数 |
|---|---|
| 主键 | `--question-id 1,2,3`（支持范围 `10-20`） |
| 试卷 | `--paper-id` ／ `--paper-title`（可叠加 `--question-no`） |
| 缺口 | `--where answer_empty,approach_empty,explanation_empty`（逗号=AND） |
| 属性 | `--source`（LIKE）、`--type`、`--difficulty`、`--content-hash` |

两种用法：

### 6.1 导出待补模板

```bash
python src/answer_importer_cli.py --export --where answer_empty --out to_fill.jsonl
```

逐题导出模板，每行形如：

```json
{"question_id": 12345, "answer": "", "approach": "", "explanation": "",
 "_ref": {"content": "……", "options": "……", "type": "choice", "answer": "旧答案", "approach": null, "explanation": "旧解析", "paper_id": 3, "question_no": 1}}
```

- 顶层可填写字段 `answer`/`approach`/`explanation` 导出为空串（=导入时不改，填了才覆盖）；`type` 默认不导出（避免误改题型，需改时手动添加）。
- `_ref` 为只读参考（题干、选项、库内现值、试卷信息），导入时忽略，不产生写入。

### 6.2 导入时范围校验

```bash
python src/answer_importer_cli.py --records to_fill.jsonl --where answer_empty --apply
```

逐条解析记录定位目标题后，校验其**仍满足** `--where` 条件；不满足的记录跳过并计入报告（「范围外跳过 N 条」），防止导出与导入之间数据变动导致误改。

## 7. 组件架构

沿用原计划三层结构，纯函数全部可单测、不依赖真库：

```
src/answer_records.py      # JSONL 解析/校验 + export 序列化（纯函数，新增）
src/answer_doc.py          # Markdown 按卷文档解析（纯函数，扩展 approach）
src/answer_importer.py     # 定位匹配 + diff 构建 + 报告格式化（纯函数）
src/answer_importer_cli.py # pymysql 连库编排：--export/--records/--doc/--where/--apply
```

统一中间结构：

```python
@dataclass
class AnswerRecord:
    # 定位键（三选一）
    question_id: int | None = None
    paper_id: int | None = None
    question_no: int | None = None
    content_hash: str | None = None
    # 内容字段
    answer: str | None = None
    approach: str | None = None
    explanation: str | None = None
    type: str | None = None
    note: str | None = None
```

两个输入适配器（`answer_records` / `answer_doc`）都产出 `AnswerRecord` 列表，`answer_importer` 消费它做匹配与 diff。

## 8. CLI

```bash
# dry-run（默认）——出 diff 报告，不写库
python src/answer_importer_cli.py --records edits.jsonl
python src/answer_importer_cli.py --doc 答案.md --paper-id 3

# 确认后写入（交互输 yes）
python src/answer_importer_cli.py --records edits.jsonl --apply

# 导出待补模板
python src/answer_importer_cli.py --export --where answer_empty --out to_fill.jsonl

# 列候选试卷（标题重名时用 --paper-id 指定）
python src/answer_importer_cli.py --list-papers 海淀
```

参数一览：

| 参数 | 说明 |
|---|---|
| `--records PATH` | JSONL 输入（与 `--doc` 二选一） |
| `--doc PATH` | Markdown 按卷文档输入（与 `--records` 二选一） |
| `--export` | 导出模式，配合 `--where` / `--out` |
| `--out PATH` | 导出目标路径（`--export` 时必填） |
| `--paper-id INT` / `--paper-title STR` | 试卷定位（Markdown / 试卷维度选择器） |
| `--question-id LIST` | 主键选择器，逗号分隔，支持 `a-b` 范围 |
| `--question-no LIST` | 与 `--paper-id` 搭配限定印刷题号 |
| `--where LIST` | 缺口条件，逗号分隔（`answer_empty`/`approach_empty`/`explanation_empty`） |
| `--source STR` / `--type STR` / `--difficulty INT` / `--content-hash STR` | 属性选择器 |
| `--limit N` | 安全阀，默认 500，超过拒绝 |
| `--apply` | 实际写入（默认 dry-run） |
| `--list-papers KEYWORD` | 列候选试卷 |

## 9. 错误处理与安全

- **dry-run 默认**：无 `--apply` 只出报告，绝不写库。
- **写前确认**：`--apply` 时打印 diff 摘要，交互输入 `yes` 才执行；单事务 commit。
- **安全阀**：`--limit` 默认 500，命中题数超限直接拒绝（需显式调大），防止误操作全库。
- **分类报告**：定位失败、题号不存在、范围外跳过、字段 warning 分段列出，不静默吞掉。
- **定位歧义**：同一定位键匹配到多题（理论上 `question_id`/`content_hash` 唯一，`paper_id`+`question_no` 亦应唯一）→ 列候选报错，不猜。
- **快照提醒**：使用手册写明「全量导入前 `mysqldump -u ai_k12 -pai_k12 ai_k12 questions > questions_snapshot.sql`」。
- **退出码**：`0` 成功 / `1` 用户取消 / `2` 参数或文档错误。

## 10. 测试策略

纯函数单测（不连库）：

- `test_answer_records.py`：JSONL 解析、定位键校验（三选一、冲突报错）、缺内容字段、非法 `type`、export 序列化往返。
- `test_answer_doc.py`：Markdown 解析（`思路：` 字段、多行续写、全角冒号、缺答案/非法题型/缺标题报错、题号去重）。
- `test_answer_importer.py`：三种定位键匹配、字段级 diff、幂等（无变化不出 diff）、报告分段。
- `test_answer_importer_cli.py`：argparse、`--where` 谓词构造、UPDATE SQL 构造（含/不含 `type` 列）、范围校验跳过、`--limit` 拒绝。

真库端到端（小批先行）：`--export` 取 2-3 题 → 填写 → dry-run 核对 → `--apply` → 复查字段与 `answer_verified` → 重跑验幂等。

`tests/` import 风格以既有测试为准（`test_answer_merger.py`）。

## 11. 文档同步

- `docs/data-refinery-使用手册.md`：新增 `answer_importer` 章节——JSONL schema、Markdown 格式（含 `思路：`）、`--export`/`--where`、回写语义、安全须知（快照、先小批）。
- `docs/data-refinery-管线总结与后续.md`：记录工具建成 + 存量缺口（约 188 空答案 / 451 无解析待按卷补全）。
- `docs/K12智学系统-数据库设计文档.md`：questions 字段表补 `approach`、`answer_verified`。
- `docs/superpowers/plans/2026-09-09-answer-importer.md`：顶部标注「已由 `2026-09-10-question-content-importer-design.md` 扩展取代」，避免两份计划冲突（其三层架构与 dry-run/幂等约定被保留）。
- `CLAUDE.md` data-refinery 段：补一句 `answer_importer` 现状（可选 `approach`/`answer_verified`）。

## 12. 决策记录

| # | 决策 | 依据 |
|---|---|---|
| 1 | 扩展并取代原 `answer_importer` 计划，而非另起工具 | 用户确认「就是这个计划，只增加解题思路」 |
| 2 | 新增 `questions.approach` 列，与 `explanation` 分离 | 解题思路≠完整解析，工具需独立更新/校验 |
| 3 | 不新增 `approach_verified`，复用 `answer_verified`；任一字段写入即置 1 | 避免列膨胀；用户确认 |
| 4 | 输入 = JSONL 主 + Markdown 兼容 | 兼顾可编程批量与人工/AI 按卷编写 |
| 5 | 选择器维度 = 主键 + 试卷 + 缺口 + 来源/题型属性（不含课时/知识点） | 用户选择 |
| 6 | 选择器只圈范围，内容一律来自文件；`--export` 导出待填模板 | 内容逐题不同，无法用 `--set` 统一赋值；用户确认 |
| 7 | 字段空串=不改，不提供清空 | 清空危险且罕见，避免漏填抹数据 |
| 8 | 保留 `answer_importer` 原名与 `tools/data-refinery/` 位置 | 复用其 config/.env/pymysql 与 pytest 设施；用户选择 |
| 9 | 本次仅工具 + DB 列，不含后端/前端 | 用户选择 |
| 10 | `--limit` 默认 500 | 安全阀，用户默认接受 |
