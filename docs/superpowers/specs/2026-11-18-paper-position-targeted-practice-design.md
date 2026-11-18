# 按试卷题号出专项练习 — 设计

> **日期**：2026-11-18
> **状态**：需求与 4 个口径已与用户确认（§3），本文待用户审阅后转 writing-plans。
> **范围锚点**：训练轨数学专项（`math_targeted`）新增第三种选题方式「试卷题号」。
> **上游**：2026-11-18 brainstorming 会话；本文是题位、可练数、抽题顺序的唯一真源。

---

## 1. 背景与现状（2026-11-18 实测，勿凭记忆）

| 事实 | 实测值 |
|---|---|
| 试卷表 | `exam_papers` 只有 `grade='初三'`，`semester` 取值 `first` / `second` |
| 数学卷 | 初三上 7 张、初三下 12 张；卷面题数 21–29，**28 题最常见**（上 5/7、下 10/12） |
| 数学卷一题位可练量 | 第 1–21 题各 7 道、第 22–27 题各 6 道、第 28 题 6 道、第 29 题仅 1 道（初三上） |
| 题号来源 | `paper_questions.question_no`（卷面题号；`questions.group_order` 是抽取兜底，不用于本功能筛选） |
| 现有专项选题 | 知识点（`kpId`）/ 中考模型（`category+model`）；本功能是第三种 |
| 错题本 | `main_error_books`，`is_cleared=0` = 还在错题本；`level` = 错题级别 L1–L5 |
| 「做过」记录 | 专项/错题练习 → `special_answer_records`；真题考试 → `exam_answers`；主线练习 → `practice_results` |
| 现有缺口 | 学生只能按知识点或模型选，无法表达「我要练第 24 题这种题」 |

**关键限制（已告知用户并确认）**：`level` 不是真实错题次数——普通重复答错不累加，只有清零后重做再错才 +1。本期按级别排序，不新增真实计数。

---

## 2. 范围

### 2.1 本期做

- 学生端「专项练习」配置页新增第三种类型「试卷题号」（仅数学显示）
- 年级 / 学期 / 题号 / 题量 四段选择
- 新增题号清单接口（选项 + 每题的错题数/未做数/可练数）
- 扩展开练接口，按题位抽题：**错题本优先（level 高→低）→ 从未做过**
- 复用现有专项作答页、判题、积分、错题本、练习记录

### 2.2 本期不做（明确）

- 只做数学（`subjectId=1`）；语文/物理/化学/道法不开入口、不做验证
- 不支持一次选多个题号（已裁决单选）
- 不新增真实错题次数（不建列、不改 5 处判题写入）
- 不新增表、不改 `questions` / `exam_papers` / `paper_questions` 结构
- 不改作答页、判题、积分档位、错题清零、掌握度的既有逻辑
- 不做「按题号生成同类新题」（LLM 变式），只从题库现有题里抽

---

## 3. 用户裁决记录（实现时勿推翻）

| # | 议题 | 裁决 |
|---|---|---|
| 1 | 练什么 | **同类题**：题号只作为「题型样本」，从题库同题号的题里抽，不练原卷那一道 |
| 2 | 参考卷 | **不选具体卷**；按学科 + 年级 + 学期 + 题号，从该范围全部试卷中取同题号的题 |
| 3 | 题号数量 | **单选一个题号** |
| 4 | 练习数量 | **沿用家长已开启档位**（1/2/3/5/10），不新增自由输入 |
| 5 | 优先级 | **还在错题本里的题优先**，按错题级别从高到低；不足再用**从未做过**的同题号题补 |
| 6 | 错题次数口径 | **用现有 L1–L5 级别**，不新增真实累加计数 |
| 7 | 适用范围 | **只做数学** |

---

## 4. 术语与口径

| 术语 | 定义 |
|---|---|
| 题位（题号 N） | `paper_questions.question_no = N`；同一道题出现在多张卷里只算一次 |
| 可判题 | `questions.is_active=1` 且 `answer <> ''`（空答案无法判题，与现有专项抽题池同口径） |
| `total` | 该题号下、**已排除该生「不再展示」之后**的可判题数（接口直接给这个数，前端不二次过滤） |
| 在错题本中 | 该生 + 该学科存在 `main_error_books.is_cleared=0 AND question_id=该题` |
| 从未做过 | 该生对该题没有**已判**记录：`special_answer_records.is_correct IS NOT NULL`、`exam_answers.is_correct IS NOT NULL`、`practice_results` 三处均无（主线跳过未答 `practice_results.method='unanswered'` 的占位行不算做过） |
| 可练数 `availableCount` | `在错题本中 + 从未做过`，且不在该生「不再展示」清单；**这才是本次能被抽到的题数** |
| 共 N 题 | 该「年级+学期」下 `exam_papers.question_count` 的众数（并列取较大值）；题号列表为 `1..N` |

**选题顺序（唯一顺序，不再另立规则）**：

1. 错题优先池：`is_cleared=0` 的题，按 `MAX(level) DESC`，同级别按**最近进入错题本**的时间 `DESC`，再按 `q.id ASC`。（错题本没有「最近答错时间」列：重复答错复用原行、只 bump level，`created_at` 是首次入本时间。2026-11-18 用户裁决：同级别按最近入本排，不改表。）
2. 补足池：从未做过的题，按 `q.id ASC`（确定性，便于测试与复现）。
3. 两池按上序拼接后取前 `count` 道；不足 `count` 直接 400，不静默少给。

**排除项（两个池都适用）**：`is_active=0`、`answer=''`、该生 `student_hidden_questions` 中已标记的题。

---

## 5. 数据与查询

**无 schema 变更。** 只读以下表：

- `exam_papers`（subject_id / grade / semester / question_count）
- `paper_questions`（paper_id / question_id / question_no）
- `questions`（is_active / answer / type / content / options / material_text / source）
- `main_error_books`（student_id / subject_id / question_id / is_cleared / level / created_at）
- `student_hidden_questions`（student_id / subject_id / question_id）
- `special_answer_records` + `special_practice_sessions`（student_id）
- `exam_answers` + `exam_sessions`（student_id）
- `practice_results`（student_id / question_id）

### 5.1 选项与常见卷长

```
options = SELECT grade, semester,
                 COUNT(DISTINCT p.id) AS paper_count,
                 question_count 众数 AS typical_question_count
          FROM exam_papers p
          JOIN paper_questions pq ON pq.paper_id = p.id
          JOIN questions q ON q.id = pq.question_id
          WHERE p.subject_id = 1 AND q.is_active = 1 AND q.answer <> ''
          GROUP BY p.grade, p.semester
```

`typical_question_count` 在应用层算众数（并列取较大）；不写复杂的窗口 SQL。

### 5.2 题号清单（每个题号三个数）

```
SELECT pq.question_no,
       COUNT(DISTINCT q.id) AS total,
       COUNT(DISTINCT CASE WHEN 在错题本中 THEN q.id END) AS wrong_count,
       COUNT(DISTINCT CASE WHEN NOT 在错题本中 AND 从未做过 THEN q.id END) AS untried_count
FROM paper_questions pq
JOIN exam_papers p ON p.id = pq.paper_id
JOIN questions q ON q.id = pq.question_id
WHERE p.subject_id = ? AND p.grade = ? AND p.semester = ?
  AND q.is_active = 1 AND q.answer <> ''
  AND NOT EXISTS (该生 student_hidden_questions 命中)
GROUP BY pq.question_no
```

- 「在错题本中」「从未做过」用相关 `EXISTS` 子查询表达，候选池每题位只有 5–7 行，性能足够。
- 返回 `positions` 只填 `1..typical_question_count`；某题号无题时补 `{total:0, wrongCount:0, untriedCount:0}`，前端置灰。
- `availableCount = wrongCount + untriedCount` **由前端相加**（接口不再冗余返回，避免两处口径漂移）；若后续需要筛选排序再加。

### 5.3 开练抽题（两段查询，服务层拼接）

错题优先：

```
SELECT q.id, q.content, q.type, q.options, q.material_text, q.source,
       MIN(pq.question_no) AS question_no,
       MAX(meb.level) AS wrong_level, MAX(meb.created_at) AS last_wrong_at
FROM paper_questions pq
JOIN exam_papers p ON p.id = pq.paper_id
JOIN questions q ON q.id = pq.question_id
JOIN main_error_books meb ON meb.question_id = q.id
  AND meb.student_id = ? AND meb.subject_id = ? AND meb.is_cleared = 0
WHERE p.subject_id = ? AND p.grade = ? AND p.semester = ? AND pq.question_no = ?
  AND q.is_active = 1 AND q.answer <> ''
  AND NOT EXISTS (该生 student_hidden_questions 命中)
GROUP BY q.id
ORDER BY wrong_level DESC, last_wrong_at DESC, q.id ASC
LIMIT ?
```

**`GROUP BY q.id` 时 `pq.question_no` 必须包 `MIN()`**：`question_no` 不函数依赖于主键，MySQL `ONLY_FULL_GROUP_BY` 会拒绝裸选；筛选已锁单值，`MIN()` 不改变语义。

从未做过（补足）：

```
SELECT q.id, ... , MIN(pq.question_no) AS question_no
FROM paper_questions pq
JOIN exam_papers p ON p.id = pq.paper_id
JOIN questions q ON q.id = pq.question_id
WHERE 同上的学科/年级/学期/题号/is_active/answer/hidden 条件
  AND NOT EXISTS (main_error_books 未清行)
  AND NOT EXISTS (special_answer_records 已判行, 该生)
  AND NOT EXISTS (exam_answers 已判行, 该生)
  AND NOT EXISTS (practice_results, 该生)
GROUP BY q.id
ORDER BY q.id ASC
LIMIT ?
```

实现约束：

- `LIMIT ?` 必须走 `pool.query`（仓库既有约定：`execute` 的 server-side prepare 对 `LIMIT ?` 会报错）。
- 第二段 `LIMIT` 传 `count - 第一段行数`；为 0 时不发 SQL。
- 两段结果按 `第一段在前、第二段在后` 拼接，不再二次排序。
- 两段都用 `GROUP BY q.id` 去重（同一题在多卷同题号只出一次）。

---

## 6. API 设计

### 6.1 `GET /api/training/paper-positions`（student JWT）

**用途**：一次返回年级/学期选项；带上 grade+semester 时同时返回题号清单。

**Query**：

| 参数 | 必填 | 校验 |
|---|---|---|
| `subjectId` | 是 | 整数；**非 1 直接 400「试卷题号仅支持数学」** |
| `grade` | 否 | 与 `semester` 同时出现或同时缺省；不在选项内 → 400 |
| `semester` | 否 | `first` / `second`；与 `grade` 同时出现或同时缺省；不在选项内 → 400 |

**响应 200**：

```json
{
  "options": [
    { "grade": "初三", "semester": "first", "paperCount": 7, "typicalQuestionCount": 28 },
    { "grade": "初三", "semester": "second", "paperCount": 12, "typicalQuestionCount": 28 }
  ],
  "grade": "初三",
  "semester": "first",
  "typicalQuestionCount": 28,
  "positions": [
    { "questionNo": 1, "total": 5, "wrongCount": 2, "untriedCount": 3 },
    { "questionNo": 2, "total": 7, "wrongCount": 0, "untriedCount": 5 }
  ]
}
```

- 未传 grade/semester：`grade`、`semester`、`typicalQuestionCount` 为 `null`，`positions` 为空数组。
- 选项为空（无卷）：`options: []` + 上述 null/空。
- 响应外层是全局 `CommonResponse` 包装（与其它接口一致）。

**错误**：400（非数学 / grade 与 semester 只给一个 / 组合不存在）。

### 6.2 `POST /api/training/targeted/start`（扩展）

**新增请求字段**：`grade`、`semester`、`paperQuestionNo`。

| 字段 | 类型 | 说明 |
|---|---|---|
| `subjectId` | number | 必填；paper 模式必须 1 |
| `paperQuestionNo` | number | 1..typicalQuestionCount 的整数 |
| `grade` | string | 必须与 `semester` 同时出现 |
| `semester` | `first`\|`second` | 同上 |
| `type` | null | paper 模式**必须 null**（不支持题型叠加筛选） |
| `count` | number | 必须是该生 `math_targeted` 已开启档位（既有逻辑） |

**互斥校验（三选一，顺序固定）**：

1. `kpId` / `category+model` / `paperQuestionNo+grade+semester` 任两组同时出现 → 400。
2. paper 模式字段不全（缺 grade/semester/paperQuestionNo）→ 400。
3. `subjectId !== 1` → 400「试卷题号仅支持数学」。
4. `type !== null/undefined` → 400「试卷题号不支持题型筛选」。
5. `grade`/`semester` 组合不存在，或 `paperQuestionNo` 不在 1..typicalQuestionCount → 400。
6. `count` 不在已开启档位 → 400（沿用现有文案）。

**抽题不足**：`rows.length < count` → 400 `该题号可练题数不足（当前 N 题）`，不建会话。

**会话**：`training_sessions` 落 `task_code='math_targeted'`、`tier_key=String(count)`、`expected_count=rows.length`、`ref_type='paper_position'`、`ref_id=paperQuestionNo`。

**响应**：与现有一致（`{questions, sessionId}`）；`questionNo` 恒为 `paper_questions.question_no`（本功能筛选题号必存在，不用 `group_order` 兜底）。

**不变量**：题单仍走白名单序列化（无 `answer` / `explanation`），答案不泄露。

---

## 7. 前端设计

### 7.1 入口与配置区

`TargetedConfigPage` 的「专项类型」组（仅 `subjectId===1`）：

- 现有两个 Chip 不变：`知识点` / `中考模型`
- 新增第三个 Chip：**`试卷题号`**

选中后渲染独立面板 `PaperPositionPanel`（对标 `ModelSpecialPanel`，便于单测）：

| 区块 | 控件 | 规则 |
|---|---|---|
| 年级 | 下拉 | 选项来自接口；默认第一项 |
| 学期 | 下拉 | 文案映射 `first → 上学期`、`second → 下学期`；默认第一项 |
| 题号 | 数字按钮网格 | 标题旁显示「共 N 题」；每个按钮下方显示「可练 X 题」；`可练=0` 置灰不可选 |
| 题量 | 档位 Chip | 只展示 `tierKey <= 可练数` 的档位；切换题号后若当前档位超限，自动重选（`pickPracticeCount`） |

- 切换年级/学期：清空已选题号、重拉题号清单；请求未回来前显示 Skeleton。
- 切学科或切回其它模式：清空面板状态（沿用现有 `subjectId` 重置 effect 的写法）。
- 年级/学期选项为空：显示「暂无可用试卷」，不给开始按钮。
- 题号清单为空或全部可练 0：显示「该年级学期暂无可练题目」，开始按钮禁用。

### 7.2 状态机

```
idle → loading(options) → ok(options)
                         ↘ error(重试)
ok → 选年级/学期 → loading(positions) → ok(positions) | error(重试)
ok(positions) → 选题号 → 选档位 → starting → 跳转 /student/training/targeted/run
```

- 并发保护：沿用 `subjectIdRef`，响应回来时学科/组合已变则丢弃。
- 错误文案固定学生向：「试卷题号加载失败」；服务端 400 文案原样展示（如题量不足）。

### 7.3 开练与交接

- 请求体：`{subjectId:1, grade, semester, paperQuestionNo, type:null, count:Number(tierKey)}`
- handoff `title`：`${grade}${学期文案} · 第${N}题`（如「初三上学期 · 第24题」），练习记录与作答页标题复用。
- `sessionId` 缺失时与现有行为一致：照常作答、不发分。
- 作答页不加新组件：现有 `formatPaperQuestionNo` 已展示「· 试卷第 N 题」，`source` 展示来源。

### 7.4 样式

- 全部使用现有 token（`--learn-card-bg` / `--learn-card-border` / `--brand-500` / `--learn-text-*`），不引入新色值。
- 题号按钮沿用 `KpChip` 的 `aria-pressed` + 选中态；不得用纯数字裸文本当按钮。
- 不加解释性副标题，不显示内部术语（「题位」「题池」）。

---

## 8. 判题 / 积分 / 错题本 / 练习记录

全部复用现有链路，**零改动**：

- 判题：`POST /api/training/judge`，`source='targeted'`
- 积分：完成会话走 `training_sessions` 整批发分（`math_targeted` 档位）
- 错题本：答错仍写 `main_error_books(source='targeted')`，仍参与主线清零门禁（题库类训练既有规则）
- 练习记录：`special_answer_records` + `module='math_targeted'`
- 「不再展示」：作答页标记后，下次题目清单的可练数自动下降

---

## 9. 边界与已知限制

1. **题量天花板**：数学初三上每个题号只有 5–7 道；`count=10` 档位在题号模式下几乎永远不可选（按 `可练数` 过滤档位）。这是数据量限制，不是缺陷。
2. **题号只近似同题型**：北京卷 24 题多为圆综，但 361/362/356 三张卷的 24 题分别是实际应用/二次函数。本功能按「卷面题位」抽题，不承诺题型严格一致；入口文案用「试卷题号」，不用「题型」。
3. **错题级别 ≠ 错题次数**：`level` 只在清零后重做再错时 +1；同级别按最近进入错题本时间排序（`created_at`，不是最近答错时间——库里没有这个字段）。
4. **常见卷长是启发式**：取众数并封顶题号列表；29 题卷独有的第 29 题不会出现在列表里（初三上仅 1 道，可接受）。
5. **错题本里的非试卷题不参与**：无 `paper_questions` 关联的主线错题不进本功能的题池。
6. **跨学期不混**：严格按 grade+semester 过滤，不做「上/下互通」。
7. **只做数学**：接口对非数学 400，前端不渲染入口。

---

## 10. 测试清单

### 10.1 后端（vitest）

1. `paper-positions` 选项：数学返回 grade/semester 组合；众数计算（28 优先于 29）；非数学 400；无卷返回空。
2. 题号清单：`total` 排除 inactive/空答案；`wrongCount` 只算未清错题；`untriedCount` 三张作答表均无已判记录；隐藏题不进任何计数；无题题号补 0。
3. 开练校验：三选一互斥；缺字段；非数学；`type` 非 null；grade/semester 组合不存在；题号越界；`count` 非档位。
4. 抽题顺序：错题按 level 降序、同级按最近时间；不足时补从未做过；已做对且不在错题本的不补；多卷同题号去重。
5. 题量不足：返回 400 且**不建** `training_sessions`。
6. 会话字段：`ref_type='paper_position'`、`ref_id=题号`、`tier_key=count`、`expected_count=实抽数`。
7. 回归：KP 模式与模型模式行为不变（现有测试全绿）。

### 10.2 前端（vitest + Testing Library）

1. 仅数学显示「试卷题号」Chip；其它学科不渲染。
2. 选项加载成功 → 默认选中第一组 → 拉题号清单 → 渲染「可练 X 题」。
3. 可练 0 的题号禁用；档位按可练数过滤；切换题号后档位自动收敛。
4. 未选题号时开始按钮禁用；选完可点。
5. `start` 请求体字段完整且 `type:null`；成功后写 handoff 并跳转。
6. 选项/清单加载失败显示固定文案与重试。
7. 空态：无试卷、无可练题。
8. 多学科切换不残留上个学科的题号数据（`subjectIdRef` 守卫）。

### 10.3 冒烟

- 用测试学生：错题本先造 2 道 24 题的错题（不同 level），开 3 题档位 → 前两道必须是错题（level 高的在前），第三道为未做过的 24 题。
- 作答页显示「来源 + 试卷第 24 题」；完成会话后积分按档位发放；答错进错题本。

---

## 11. 文档同步（实现时一次做完）

- `docs/API接口与数据流设计文档.md`
  - §4.18 Training 端点表：新增 `GET /api/training/paper-positions` 行；更新 `POST /api/training/targeted/start` 行的请求/互斥/会话字段说明。
  - §5 专项数据流：在「模型专项」段后补「试卷题号」流程（选项 → 题号清单 → 开练 → 作答页）。
- `docs/api/openapi.yaml`
  - 新增 `/training/paper-positions` 路径与响应 schema。
  - 扩展 `TargetedStartRequest`：`grade` / `semester` / `paperQuestionNo`。
- `docs/ai-core-changelog.md`：实现落地后补一条带日期记录（本 spec 不预先写结论）。
