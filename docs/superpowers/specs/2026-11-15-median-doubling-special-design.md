# 数学中考模型专项（首批：倍长中线 / 手拉手 / 几何新定义）— 设计

> **日期**：2026-11-15
> **状态**：题池 / 入口 / 题量三条已与用户确认（§3），待用户审阅本文件后转 writing-plans。
> **2026-11-15 扩展**：白名单从倍长中线 1 个扩到 **30 个有题模型**；模型模式题量不再固定 1/2，改为「家长已开启档位且 ≤ 该模型可练数」；页面从单卡片改为按大类分组的模型下拉。倍长中线仍按 2 题固定顺序（1 题=7093，2 题=7093→7094），其他模型随机。
> **PRD 锚点**：`docs/K12智学系统-产品需求文档.md` §6.3「训练轨：自主训练」第 2 条（专项练习按知识点 + 题型）。本设计新增**模型维度**，属于对 §6.3 的扩展，用户已确认；落地后建议在 PRD §6.3 第 2 条补一句「可按中考模型开微专题」。
> **API 锚点**：§4.18 Training 组、§5.16 专项练习数据流；`openapi.yaml` 的 `/training/targeted/start`。
> **数据前置**：`question_model_tags`（2026-11-14 已落地）；本设计只读取标签，不改标签表。

---

## 1. 背景与现状（2026-11-15 实测）

| 事实 | 实测值 |
|---|---|
| 倍长中线标签 | `category='geometry_synthesis' AND model='median_doubling'` 共 **3** 行，confidence 0.90–0.95 |
| 可练题池 | `answer<>''` 且 active 的只有 **2** 条：`7093`、`7094` |
| 不可用 | `4524` 是 2025 海淀二模的答案/解析残片，`answer` 为空，被抽题谓词排除 |
| 7093 / 7094 关系 | **同一题干**：7093 是完整两问（proof）；7094 只保留第 (2) 问（short_answer），答案 `BF=√2·BH` |
| 现有专项入口 | 训练首页四卡 → 专项练习 `/student/training/targeted?subjectId=1`，按知识点两级 + 题型 + 题量开练 |
| 现有开练接口 | `POST /api/training/targeted/start`，请求体 `{subjectId, kpId, type, count}`；`kpId` 必填 |
| 现有档位 | `math_targeted` 的 1/2/3/5/10 档；**2 题档 = 5 分**，1 题档 = 2 分；档位按学生配置，部分学生没有 2 题档 |
| 会话/积分 | 会话落 `training_sessions`，`task_code='math_targeted'`；完成发分走现有 `complete` 链路 |

**结论**：倍长中线不扩题，保留现有 2 条做「完整题 + 第二问巩固」；本次只额外开放手拉手（5 题）与几何新定义（11 题）两个已有题池，不做通用模型管理框架。

---

## 2. 目标与非目标

### 2.1 目标

- 学生能在现有专项页切到「中考模型」，看到 **30 个有题模型**并按大类分组选择，开始练习。
- 题量按家长已开启档位，且不超过该模型可练数：
  - 倍长中线题池 2：只出 1/2 题；1 题=7093，2 题=7093→7094。
  - 手拉手题池 5、几何新定义题池 11：默认 3 题（`pickPracticeCount`），可出 1/2/3/5/10 中家长已开启的档位。
- 复用现有 `math_targeted` 的判题、错题本、完成发分、练习记录、`TargetedRunPage`，不新增任务码。
- 题池不足、家长没开可用档位、隐藏题等边界都有明确状态，不出现空页或 500。

### 2.2 非目标

- 不补题、不生成变式题；本次只开放手拉手 / 几何新定义，其他模型（旋转相似/中点模型等）不开放。
- 不新增 `task_code`、不改积分规则、不改家长端积分配置页。
- **不改练习记录表结构**；记录标题通过现有 handoff `title` 传递为「倍长中线」（复用 `special_practice_sessions.title`，不加列）。
- 不做模型专项的独立首页第 5 张卡（保持训练首页四卡 2×2）。
- 不做模型维度的推荐/薄弱点联动。

---

## 3. 用户裁决记录（实现时勿推翻）

| # | 议题 | 裁决 |
|---|---|---|
| 1 | 题池 | **不扩题，接受现有 2 条同题干记录**；做成 2 题微专题 |
| 2 | 入口 | **现有「专项练习」页内加「知识点 / 中考模型」切换**；首页四卡不变 |
| 3 | 题量 | 倍长中线只允许家长已开启的 1/2 题档；扩展模型按家长已开启档位且 ≤ 题池（默认 3 题）；一个可用档都没有时禁用并提示家长开启 |

---

## 4. 题池与选择口径

### 4.1 白名单

服务端 `apps/server/src/modules/training/model-specials.ts` 的 `MODEL_SPECIALS` 是唯一真源；当前开放 **30 个有题模型**，按大类分组：

| 大类 | 模型（可练题数） |
|---|---|
| 几何综合 | 倍长中线 2、手拉手 5、旋转相似 11、中点模型 7、轴对称构造 4、一线三等角 2、角平分线模型 1、面积法 1、平移构造 1 |
| 圆综 | 切线判定与性质 10、圆周角与圆内接四边形 6、垂径定理 4、相似与三角函数 2 |
| 最值问题 | 隐圆 2、点圆最值 2、胡不归 1 |
| 代数综合 | 二次函数与方程 14、含参讨论 15、根与系数关系 3 |
| 函数与图象 | 一次/反比例/二次图象 32、图象变换 6、图象与不等式 5 |
| 统计与概率 | 概率计算 10、数据代表数 9、统计图表 7、方差 6 |
| 实际应用 | 方程建模 15、函数建模 3 |
| 新定义 | 坐标新定义 10、代数新定义 2 |

> 为什么用白名单：只放**有答案、已审核**的模型；当前 30 个有题模型全部开放，题池 1-2 题的模型只会有 1/2 题档。名单/显示名以 `model-specials.ts` 为准。

### 4.2 抽题谓词（与 `question_model_tags` 对齐）

可练题必须同时满足：

```sql
q.subject_id = 1
AND q.is_active = 1
AND q.answer <> ''
AND qmt.category = 'geometry_synthesis'
AND qmt.model = 'median_doubling'
AND qmt.confidence >= 0.70
AND shq.id IS NULL          -- 该生「不再展示」排除
```

- `confidence >= 0.70`：沿用模型标签 spec §10 的后续专项口径；当前两条都是 0.95。
- `source` 不筛：`llm` / `manual` 都算（人工修正也应有资格）。
- `type` 不筛：模型模式下强制 `type=null`，两条题一条 proof、一条 short_answer，都要出。

### 4.3 顺序与题量

- **倍长中线固定 `q.id ASC`**：本期只有 2 条，排序后第一条是 `7093`；1 题档出排序后的第一条（当前为 `7093`），2 题档出前两条（当前 `7093 → 7094`）。不随机。PRD 的「随机抽题」在本模型是**有意例外**：题池只有 2 条，随机只会让 1 题档随机到「第二问」而缺完整题。
- **其他模型随机**：除倍长中线外的所有模型都用 `ORDER BY RAND()`；题池 > count 时随机抽 count 条，题池 ≤ count 时全部返回。题池足够时不会每次都是同几条。
- 未来题池 > 5 条时是否改成随机，只影响 repo 的排序；API/UI 不变。

### 4.4 已知限制（spec 明写，不在实现时再争）

- 7093 已包含第 (2) 问，7094 是同一第 (2) 问的单独练习；学生可能觉得重复。页面文案会明确「先完整题，再第二问巩固」。
- 7093/7094 来自 `source='auxiliary'`（做题答疑入库），不是正式试卷题；有答案与解析，可用于练习。
- 若学生把 7093 标记「不再展示」，1 题档会只剩 7094（第二问单独题）；这是可接受的降级。
- 若两条都被隐藏或标签被重跑改掉，`questionCount=0`，页面显示「暂无可练题目」。

---

## 5. API 契约

### 5.1 `GET /api/training/model-specials?subjectId=1`

**用途**：专项页「中考模型」模式的数据源；返回白名单模型 + 该生可练题数。

- **鉴权**：student JWT。
- **Query**：`subjectId` 必填 integer；`ParseIntPipe` 非法 → 400。
- **非数学**：`subjectId !== 1` → 200 `{ specials: [] }`（不报错，页面不渲染该模式）。
- **响应 data**：

```json
{
  "specials": [
    {
      "category": "geometry_synthesis",
      "categoryName": "几何综合",
      "model": "median_doubling",
      "modelName": "倍长中线",
      "questionCount": 2
    }
  ]
}
```

- `questionCount` 是**该生**口径：用 §4.2 谓词 + `student_hidden_questions` 排除；不是全局 2。
- 白名单里 `questionCount=0` 的模型也返回（值为 0），前端显示「暂无可练题目」并禁用；不静默隐藏，避免家长/学生以为功能消失。
- 现在只有 1 个模型，响应数组长度为 1；以后加模型不改结构。

### 5.2 `POST /api/training/targeted/start` 扩展

**请求体**（`kpId` 与 `category+model` 二选一）：

```json
{
  "subjectId": 1,
  "category": "geometry_synthesis",
  "model": "median_doubling",
  "type": null,
  "count": 2
}
```

```json
{
  "subjectId": 1,
  "kpId": 12,
  "type": "proof",
  "count": 3
}
```

**字段与校验**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `subjectId` | integer | 是 | 模型模式必须为 `1` |
| `kpId` | integer | 二选一 | 正整数；与 `category+model` 互斥 |
| `category` | string | 二选一 | 必须与 `model` 同时出现；白名单精确匹配 |
| `model` | string | 二选一 | 同上 |
| `type` | string \| null | 是 | 模型模式必须 `null`；KP 模式沿用原白名单 |
| `count` | integer | 是 | 必须是该生 `math_targeted` 已开启档位，且 ≤ 该模型可练数 |

**校验顺序（模型模式）**

1. `kpId` 与 `category+model` 必须**恰好一个**；两个都给或都不给 → 400 `kpId 与 category+model 必须二选一`。
2. 只给了 `category` 或只给了 `model` → 400 `category 与 model 必须同时出现`。
3. `subjectId !== 1` → 400 `模型专项仅支持数学`。
4. 白名单没有该 `(category, model)` → 400 `不支持的模型专项`。
5. `type !== null` → 400 `模型专项不支持题型筛选`。
6. 该生 `math_targeted` 一个可用档位都没有 → 400 `家长未开启数学专项档位`。
7. `count` 不在该生 `math_targeted` 已开启档位 → 400，沿用现有文案 `题量仅允许 1 | 2 | 3 | 5 | 10`。
8. 查可练行；`rows.length < count` → 400 `题量超过可练题数（当前 N 题）`（N=0 时同一条）。
9. 通过 → 返回题单 + 建会话。

> KP 模式保持现有行为：`count` 是家长档位、`type` 白名单、抽不到题返回 `{questions: [], sessionId: null}`，不因本次改动改变。

**服务端步骤（模型模式）**

```text
1. controller：模式互斥 + 白名单 + type=null + count∈家长档位
2. service：questionsRepo.findModelSpecialQuestions(studentId, 1, category, model, count)
   - SQL：JOIN question_model_tags，confidence>=0.70，active，answer<>''，
           LEFT JOIN student_hidden_questions IS NULL，
           倍长中线 ORDER BY q.id ASC；其他模型 ORDER BY RAND()；LIMIT ?
   - 用 pool.query 而非 pool.execute（LIMIT ? 的 mysql2 限制，仓库既有约定）
3. 若 rows.length < count → BadRequestException('题量超过可练题数（当前 N 题）')
4. 映射题单（剥离 answer/explanation，options parse，materialText）
5. 建 training_sessions：
   student_id / task_code='math_targeted' / subject_id=1 /
   tier_key=String(count) / expected_count=rows.length /
   ref_type='model' / ref_id=NULL
   - 建会话失败只 warn，sessionId 返回 null（沿用现有“积分不挡学习”）
6. 返回 { questions, sessionId }
```

**响应**（与现有专项同形）：

```json
{
  "questions": [
    { "questionId": 7093, "text": "题干 Markdown", "type": "proof", "options": null, "materialText": null },
    { "questionId": 7094, "text": "题干 Markdown", "type": "short_answer", "options": null, "materialText": null }
  ],
  "sessionId": 123
}
```

- 倍长中线题单固定 `q.id ASC`：当前 1 题为 `7093`、2 题为 `7093 → 7094`（标签变化时以实际排序为准）；其他模型随机。
- 题单仍是白名单序列化：不含 `answer` / `explanation` / `approach`。
- `sessionId` 可能为 null（会话 INSERT 失败），前端照常出题、不发分。

### 5.3 错误码汇总

| 场景 | HTTP | message |
|---|---|---|
| 模式互斥 | 400 | `kpId 与 category+model 必须二选一` |
| category/model 只给一个 | 400 | `category 与 model 必须同时出现` |
| 非数学模型 | 400 | `模型专项仅支持数学` |
| 白名单外模型 | 400 | `不支持的模型专项` |
| 模型模式带 type | 400 | `模型专项不支持题型筛选` |
| 家长没有任何可用档位 | 400 | `家长未开启数学专项档位` |
| count 不是家长档位 | 400 | `题量仅允许 1 | 2 | ...` |
| count 超过可练数 | 400 | `题量超过可练题数（当前 N 题）` |
| subjectId 非整数（GET） | 400 | Nest `ParseIntPipe` 默认 |

> 不新增自定义业务错误码；沿用 `BadRequestException` 的 400 语义。

---

## 6. 前端设计

### 6.1 入口与布局

- 路由不变：`/student/training/targeted?subjectId=1`。
- 在 `PageHeader` 下方、知识点选择上方加**模式切换**（仅数学显示）：
  - 两个按钮：`知识点` / `中考模型`，`aria-pressed` 单选，样式复用现有 `KpChip`（选中 brand 底、未选中 card 边框）。
  - 默认 `知识点`，保持现有行为不变。
- 非数学（物理/化学等）不渲染该切换，原页面完全不变。

### 6.2 模型模式 UI

```
[专项练习                        退出本页]
[知识点] [中考模型]

┌────────────────────────────────────┐
│ 模型 [倍长中线 v]                    │
│                                    │
│ 题量                                │
│ [1 题 +2 分] [2 题 +5 分] [3 题 +8 分]│
│                                    │
│ [开始练习]                          │
└────────────────────────────────────┘
```

- 模型用**下拉**，按大类 `optgroup` 分组，只显示模型名；**不显示分类、不显示「微专题」、不显示说明性文案、不显示「可练 N 题」**（2026-11-15 用户裁决：给用户带不来实际作用的文字不上页面）。
- 题量 chips 复用现有 `TierChip`：显示档位名、分值、剩余次数；`remainingToday===0` 仍只置灰、不禁用（现有口径，不发分也让孩子练）。
- 模型模式**隐藏题型选择器**（`type` 永远 null）。
- 开始按钮 `开始练习`；loading 时 `开练中…` 并禁用（沿用现有 `starting`）。

### 6.3 状态机

| 状态 | 触发 | UI |
|---|---|---|
| `kp` | 默认 / 点「知识点」 | 原知识点两级 + 题型 + 题量 + 开始，完全不变 |
| `model-loading` | 首次点「中考模型」/ 重试 | 模型卡片骨架（`Skeleton`），不阻塞知识点模式 |
| `model-error` | `GET model-specials` 失败 | 卡片内 `模型专项加载失败` + `重试` 按钮；不整页报错 |
| `model-empty-list` | `specials=[]` | `暂无可用模型。`；开始按钮禁用 |
| `model-empty` | 该模型 `questionCount=0` | 卡片照常渲染，题量区 `暂无可练题目。`；开始按钮禁用 |
| `model-ok` | 有模型且 count>0 | 模型下拉 + 题量 chips + 开始 |
| `tiers-error` | `GET /points/me/rules` 失败 | 题量区显示 `档位加载失败，请重试` + `重试` 按钮；不整页报错，模型卡片仍可见 |
| `no-tier` | 家长未开启可用档位 | 卡片照常显示，题量区按题池显示：题池 ≥3 题 → `家长未开启可用题量档位，暂不能开练。`；题池 2 题 → `家长未开启 1 或 2 题档位，暂不能开练。`；题池 1 题 → `家长未开启 1 题档位，暂不能开练。`；开始禁用 |
| `starting` | 点开始 | 按钮 `开练中…`，禁用；失败在按钮上方显示 `startError`（沿用现有 ErrorBanner 风格） |
| `empty-questions` | 接口返回空题单 | 留在配置页，提示 `这个模型暂时没有可练的题。`（防御，正常情况下 count 已校验） |

> **判定顺序**：先判 `questionCount===0`（`model-empty`），再判 eligible 档位是否为空（`no-tier`）。
>
> `specials=[]`（白名单为空/非数学）显示整块空面板，文案 `暂无可用模型。`（与「模型存在但没题」区分）；`specials` 有元素但该模型 `questionCount=0` 时**仍渲染卡片**，只把题量和按钮置为不可用——避免家长/学生以为功能消失。

### 6.4 题量档筛选算法

```ts
const eligible = (tiers ?? [])
  .map((t) => ({ ...t, n: Number(t.tierKey) }))
  .filter((t) => Number.isInteger(t.n) && t.n >= 1 && t.n <= special.questionCount);

// 默认：≥3 的最小档（3），否则现有最大档（2/1）；复用 point-tiers.pickPracticeCount
const defaultKey = pickPracticeCount(eligible);
```

- 倍长中线题池 2：只显示家长已开的 1/2 档，默认 2。
- 手拉手 5 / 坐标新定义 10 / 一次函数图象 32 等：显示家长已开的 1/2/3/5/10 中不超过题池的档，默认 3；题池不够的档不出现。
- 一个 eligible 档都没有 → `no-tier` 状态；题池 2 题提示开启 1 或 2 题档，题池 1 题提示开启 1 题档，题池 ≥3 提示开启可用题量档。
- 档位重新加载（`usePointTiers` 的 retry）后重算；当前选中档不在新 eligible 中则回默认。

### 6.5 开练与跳转

```ts
const res = await startTargetedPractice({
  subjectId,
  category: special.category,
  model: special.model,
  type: null,
  count: Number(modelTierKey),
});
const handoff: TargetedRunHandoff = {
  sessionId: res.sessionId,
  questions: res.questions,
  title: '倍长中线',   // 练习记录/结果页标题；复用现有 handoff title
};
sessionStorage.setItem('training:targeted', JSON.stringify(handoff));
navigate('/student/training/targeted/run');
```

- 复用现有 `TargetedRunPage`、判题、完成发分。
- 空题单：`emptyHint=true`，留在配置页（与 KP 模式同口径）。
- 模型模式与 KP 模式各自保留选择状态；切换只改显示，不清空对方。

### 6.6 组件拆分

- 新建 `apps/web/src/pages/student/training/ModelSpecialPanel.tsx`：
  - props：`specials`, `status`, `error`, `tiers`, `tierKey`, `onSelect`, `onRetry`, `onStart`, `starting`, `startError`。
  - 只负责模型下拉 + 题量 chips + 按钮，不自己发请求。
- `TargetedConfigPage` 负责：
  - 模式状态、首次加载模型数据、tier 筛选、开练。
  - 知识点模式原逻辑不动。
- 单文件职责清晰，避免把已有 400 行页面继续膨胀。

---

## 7. 积分、会话与练习记录

- **任务码复用**：`math_targeted`；模型模式不新增 `task_code`。
- **档位/积分**：按家长在 `math_targeted` 配置的 1/2/3/5/10 档发分（来自 `point_rules`）；发分仍由 `POST /api/training/sessions/{id}/complete` 按会话 `tier_key` 取，不在开练时发。
- **会话**：`training_sessions` 行 `task_code='math_targeted'`、`tier_key=count`、`expected_count=rows.length`、`ref_type='model'`、`ref_id=NULL`。`ref_type` 当前无消费方，只为后续统计留标记。
- **练习记录标题**：模型模式 handoff 写 `title=selectedModel.modelName`（如「倍长中线」）；`TargetedRunPage` 判题时把它传给 `judgeTraining`，`special_practice_sessions.title` 落该值。**不需要给会话表加列**。
- **模型维度统计**：标题已带模型名；若要按 `(category, model)` 聚合，按作答题目回查 `question_model_tags` 即可，不在会话表冗余模型。
- **错题本**：判错走现有 `source='targeted'`，照常入本、参与清零门禁；模型模式不特殊。

---

## 8. 测试计划

### 8.1 服务端

- `GET /api/training/model-specials`：
  - 数学返回 1 个白名单模型，`questionCount=2`；
  - 隐藏 7093 后返回 1；隐藏两条返回 0；
  - 非数学返回 `{specials: []}`；
  - 白名单外模型不出现；
  - `subjectId` 非整数 400。
- `POST /api/training/targeted/start` 模型模式：
  - 只给 kpId / 只给 category / 两个都给 / 都不给 → 400；
  - 非数学 → 400；白名单外 → 400；`type` 非 null → 400；
  - count=3 → 400；count 不在家长档位 → 400；count=2 但只可练 1 → 400；
  - count=1 → 题单只有 7093；count=2 → `[7093, 7094]` 顺序固定；
  - 会话行 `task_code='math_targeted'`、`tier_key='2'`、`ref_type='model'`、`expected_count=2`；
  - 会话创建失败 → `sessionId=null`，题单照常返回。
- KP 模式回归：现有 `startTargetedPractice` 测试全绿，抽不到题仍返回空数组。
- Repo：SQL 含 `confidence >= 0.70`、`answer <> ''`、`is_active=1`、`student_hidden_questions` 排除、`ORDER BY q.id ASC`、`LIMIT ?` 走 `pool.query`。

### 8.2 前端

- 数学页显示「知识点 / 中考模型」；物理/化学不显示。
- 默认知识点模式；切到模型：
  - 首次请求 loading → 卡片；
  - 请求失败显示重试，知识点模式仍可用；
  - `specials=[]` / count=0 → 空态；
  - 题量只显示 eligible 1/2；默认 2；只有 1 时默认 1；只有 3/5/10 时 no-tier 文案 + 禁用；
  - 点开始 payload 精确为 `{subjectId, category, model, type:null, count}`；
  - 空题单留在配置页提示；
  - 开练失败显示 `startError`；
  - 知识点模式原测试不回归。
- 组件测试：`ModelSpecialPanel.test.tsx` + `TargetedConfigPage.test.tsx` 补模型模式用例。

### 8.3 文档

- `docs/API接口与数据流设计文档.md` §4.18 新增 `GET /api/training/model-specials`，扩展 `POST /targeted/start` 请求体与 400 口径；§5.16 补模型微专题数据流。
- `docs/api/openapi.yaml` 同步路径、schema、错误描述。
- PRD §6.3 第 2 条补一句（落地后由用户确认措辞）。

---

## 9. 影响面

| 层 | 文件 | 改动 |
|---|---|---|
| 服务端 | `apps/server/src/modules/training/model-specials.ts` | 新建白名单常量与类型 |
| 服务端 | `training.controller.ts` | 新增 GET；`targeted/start` 模式校验 |
| 服务端 | `training.service.ts` | 新增 `listModelSpecials` / 模型抽题分支 / 会话 `ref_type` |
| 服务端 | `database/repositories/questions.repo.ts` | 新增 count / find 两个模型抽题方法 |
| 服务端 | `training.service.test.ts`、`questions.repo` 相关测试 | 新用例 + KP 回归 |
| 前端 | `services/api.ts` | `getModelSpecials`；`startTargetedPractice` 联合类型 |
| 前端 | `TargetedConfigPage.tsx` | 模式切换 + 模型数据/档位/开练 |
| 前端 | `ModelSpecialPanel.tsx`（新建） | 模型下拉/题量/状态 |
| 前端 | `TargetedConfigPage.test.tsx`、`ModelSpecialPanel.test.tsx` | 模型模式用例 |
| 文档 | API 文档 / openapi / PRD §6.3 | 同步 |
| 数据库 | — | **无迁移**；只读 `question_model_tags` |

---

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| 7093/7094 同题干，学生觉得重复 | 第二题是第二问巩固；页面不写解释，接受重复感（2026-11-15 用户裁决：无实际作用的说明文案不上页面） |
| 倍长中线家长没开 1/2 档 | 页面提示「家长未开启 1 或 2 题档位」；不偷偷用 3/5/10 档少出题。其他模型按家长已开档位且 ≤ 题池 |
| 隐藏 7093 后只剩第二问 | 允许降级；count API 返回 1，UI 只显示 1 题档 |
| 标签被重跑改掉/置信度下降 | count API 实时查标签；0 时显示「暂无可练题目」，不报错 |
| 模型标签误标，池里混入非倍长题 | 当前两条有解析可核对（都用了倍长 BH 构造）；白名单先只放这一对，后续扩模型前先抽检 |
| 直接调 API 绕过 UI 档位 | 服务端校验 count∈{1,2}、家长档位、可练数，三层都在服务端 |
| 会话/积分与普通专项混淆 | 复用 `math_targeted` 是刻意选择；`ref_type='model'` 留标记，记录标题用 handoff `title` 区分模型，不加表列 |

---

## 11. 后续（不在本期）

- 题池扩到 ≥5 条后：抽题改随机（首题固定），2 题档不再固定 7093/7094。
- 加新模型：只扩 `MODEL_SPECIALS` + 前端下拉，不改 API 形状。
- 练习历史/家长报告按 `(category, model)` 聚合：按作答题目 join `question_model_tags`，或在会话表加 `model_tag` 列（需迁移）。
- 模型微专题的方法讲解卡/例题：另立 spec，不与本期练习流程耦合。
