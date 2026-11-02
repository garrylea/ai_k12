# 材料题（物理/化学）统一设计 — 供审核

**日期**：2026-11-02
**状态**：**待用户审核**（未实现）
**提出人**：用户（2026-11-02）——「物理也有材料题，和语文阅读理解一样，阅读理解中的文章就是材料；不清楚化学有没有。总之这种有材料的该如何处理？语文的阅读理解是怎么处理的？」

---

## 1. 现状调研（实测，非推测）

### 1.1 数据层

`questions` 表相关列：

| 列 | 类型 | 实际使用 |
|---|---|---|
| `content` | text | 题干正文（**物理/化学的材料目前混在这里**） |
| `material_text` | text | 语文材料题的材料原文（**只有语文用**） |
| `material_url` | text | **全库 1465 题 0 行有值**（未使用的死列） |
| `group_id` | varchar(50) | 值是「一/二/三/四/五」= **试卷大题分区**，不是材料组 |
| `group_order` | smallint | 大题分区内的题序 |

各学科实际数据（2026-11-02 实测）：

| 学科 | 题数 | 有 group_id | 有 material_text |
|---|---|---|---|
| 语文 | 798 | 798 | **684** |
| 物理 | 135 | 128 | **0** |
| 化学 | 75 | 75 | **0** |
| 数学 | 457 | 437 | 0 |

**结论**：材料题的**结构字段已经有了**，但只有语文真的把材料放进了 `material_text`；物理/化学的材料**混在 `content` 里**。

### 1.2 语文材料题的隐式分组

语文没有材料表、没有 material_id，靠 **`material_text` 内容完全相同**隐式成组（实测分组规模：1 组 7 题、1 组 6 题、5 组 5 题、21 组 4 题、80 组 3 题、81 组 2 题）。

样例（`questions.id` 5163/5164 共享同一段科技节材料；5165/5166 各自另一段）。

### 1.3 代码链路（材料目前只影响"展示"，不影响判题）

| 环节 | 现状 |
|---|---|
| 考试下发题目 | `exams.service.ts:279` 返回 `materialText: row.material_text` |
| 训练下发题目 | `training.service.ts:798` 返回 `materialText: q.material_text` |
| 考试结果页 | `ExamResultPage.tsx:171` → `material: it.materialText` → `AnswerResultList` 在题面上方渲染（`max-h-[32vh]` 可滚动） |
| 训练作答页 | `TargetedRunPage.tsx:110/117` → `QuestionRunner.tsx:533` 渲染 `q.material` |
| **判题** | `judgment.capability.ts:55` 只传 `questionContent`（= `q.content`），**材料完全不参与判题** |
| **解析生成** | `explanation-cache.service.ts:154` 只传 `content` + `answer` + `options`，**不传 material** |
| **练习记录详情（2026-11-01 新功能）** | **`PracticeHistoryQuestion` 没有 material 字段** —— 语文材料题在历史回放里**看不到材料** |

### 1.4 物理材料题的实际形态（实测两条）

- `id=6015`（multi_choice）：实验描述 + HTML 表格 + 3 张图 + 「甲/乙/丙」标注，**全在 `content` 里**
- `id=6026`（short_answer）：开头「阅读以下文字，并回答问题：半导体材料的应用……」+ 三段科普正文 + 小问，**全在 `content` 里**

物理 135 题里：16 题 content > 500 字、53 题 200–500 字，说明确实存在「材料 + 小问」型题目。

**化学同样有**（实测）：
- `id=4309`：「29.（6分）阅读下面科普短文。市面上有多种多样的保暖材料…」+ 表 1 + 小问
- `id=4317`：「絮凝剂常用于污水处理…【进行实验】取 200 mL 浑浊程度相同的水样…」+ 结果表 + 小问
- 化学 75 题：4 题 > 500 字、17 题 200–500 字

---

## 2. 问题定义

1. **语义混在一起**：物理/化学的材料和问题在同一个 `content` 字段，前端无法「材料固定展示、小题滚动」；同一材料的多个小问各自重复一大段材料。
2. **无法做到「一份材料 + N 道小题」的体验**：现在每道小题都是完整独立卡片，材料重复。
3. **判题/解析看不到材料**（如果材料被抽到 material_text）：模型只看到小问，缺少上下文，判错概率上升。
4. **历史回放丢材料**：练习记录详情不返回 material，语文材料题回放只剩小问。
5. **材料组不可靠**：语文靠「文本完全相同」隐式分组，材料里改一个字就断组；物理若也要分组，需要显式标识。

---

## 3. 目标

1. 物理/化学的材料与小题**结构性分离**，且与语文口径统一（都走 `material_text`）。
2. 同一材料的多个小题能**显式归组**，展示时材料只出现一次（作答页、结果页、历史回放三处一致）。
3. 判题与解析生成**能拿到材料**（有材料才传，无材料零影响）。
4. 历史回放（练习记录详情）**返回并渲染材料**。
5. 老数据（语文 684 题）**不强制重洗**，但可平滑升级到显式分组。

---

## 4. 方案对比

### 方案 A：只补展示，不动数据（最小改动）

- 物理/化学材料仍留在 `content`，前端把 `content` 整段渲染（现状）。
- 只给练习记录详情补 `materialText`。
- **优点**：零数据迁移，1 天可完成。
- **缺点**：材料与问题仍然混杂；同一材料多小题仍重复；判题仍看不到"材料"这个概念（但对物理反而没损失，因为材料就在 content 里）。
- **适用**：只想先让历史回放能看到语文材料。

### 方案 B：统一抽到 `material_text` + 显式 `material_id`（推荐）

- **数据**：物理/化学材料题把材料从 `content` 抽到 `material_text`；小题 `content` 只留问题。
- **分组**：新增 `material_id`（varchar，同材料组共享），`group_order` 继续表示组内题序。语文老数据可**渐进补**：先按 `material_text` 内容相同回填 `material_id`（一次性脚本），之后新数据由管线写入。
- **判题**：`JudgmentRequest` 增加可选 `material`，有值时拼进 prompt。
- **解析**：`explanation.explain` 同样增加 `material`。
- **展示**：作答页/结果页/历史回放统一「材料区（可折叠/可滚动）+ 小题区」；同组只在第一题前显示材料一次。
- **优点**：语义清晰；材料只显示一次；判题有上下文；与语文口径统一。
- **缺点**：需要 data-refinery 抽取 + 人工校验（物理 135 / 化学 75 题，量不大）；老语文数据要回填 material_id；前端三处要改。

### 方案 C：不改库，运行时按 `group_id` 识别材料组

- **不可行**：`group_id` 实测是「一/二/三」大题分区（一分区几十道题），不是材料组。硬用会把整个大题的材料混成一份。

---

## 5. 推荐方案（方案 B）详细设计

### 5.1 数据模型

**新增列**（`questions` 表）：

```sql
ALTER TABLE questions
  ADD COLUMN material_id VARCHAR(64) DEFAULT NULL COMMENT '材料组标识：同材料的多个小题共享；NULL=无材料' AFTER material_url,
  ADD INDEX idx_questions_material_id (material_id);
```

**约定**：
- `material_id` 为空 ⇒ 无材料题，行为与今天完全一致。
- `material_id` 非空 ⇒ 该题属于某个材料组；同组各题 `material_text` **内容相同**（冗余保留，避免 JOIN，也兼容老逻辑），`group_order` 为组内题序（从 1 起）。
- 不新建材料表（YAGNI）：材料只有一段文本 + 可能的图片，塞在一张表里 JOIN 收益不大，且会让 `questions` 的读路径多一次关联。

**语文老数据回填**（一次性脚本，幂等）：

```sql
-- 按 material_text 内容哈希分配 material_id（同内容 = 同组）
UPDATE questions SET material_id = CONCAT('m-', SUBSTR(MD5(material_text), 1, 16))
WHERE material_text IS NOT NULL AND TRIM(material_text) <> '' AND material_id IS NULL;
```

> 同内容的材料偶有「不同试卷各自出现」的情况，会合并成一个 id。这是**可接受**的：material_id 只用于展示分组，不承载业务语义；若将来要严格按卷分组，再加 `paper_id` 维度。

### 5.2 抽取与写入（tools/data-refinery）

- 物理/化学原始题（content 里混排材料）在抽取阶段识别「材料段 + 小问」：
  - 材料段特征：`阅读以下文字` / `如图所示` + 长段落 + 表格/图；小问特征：`(1)`/`(2)`/`下列` 等。
  - **不做纯 LLM 自动切分**（不可复现，见 memory「refinery LLM 不可复现」）；用规则的候选切分 + **人工确认**落库。
- 落库时同时写 `material_text` / `material_id` / `group_order`，`content` 只留小问。
- **只填空、不覆盖**（项目铁律）：已有人工校订的 `content` 不动；抽取结果写入前逐行 MD5 比对未触碰列。

### 5.3 判题与解析

**判题**：

```ts
// judgment.capability.ts JudgmentRequest 增加可选 material
export interface JudgmentRequest {
  // ...existing
  material?: string | null;
}
// prompt context.question 增加 material 字段（仅非空时拼入）
```

`judge-core.service.ts` 两处调用补 `material: q.material_text ?? null`。

**解析**：

```ts
// explanation.capability.ts 请求体增加 material
explanation.explain({ ..., question: { content, answer, options, material } })
```

`explanation-cache.service.ts:151` 补 `material: q.material_text ?? null`。

> 兼容：`material` 均为可选，不传时 prompt 与今天逐字一致（有测试钉住）。

### 5.4 展示（三处统一）

**作答页**（`QuestionRunner`）：已有 `q.material` 渲染区，保持；只调整为「同组材料只显示一次」——需要在训练/考试作答流程里记住"本组材料已展示"。

**结果页**（`AnswerResultList`）：现在每题显示自己的 `q.material`。改为：
- 按 `materialId` 分组；组内**第一题**展示材料区，后续小题不重复（显示「见上文材料」的轻提示或直接省略）。
- 无 `materialId` 的题（老数据未回填）保持现状：每题显示自己的 material。

**历史回放**（`PracticeHistoryDetailPage`）：**新增 `materialText` 字段**（当前缺失），渲染逻辑与结果页一致。

### 5.5 接口变更

| 端点 | 变更 |
|---|---|
| `GET /api/exams/sessions/{id}/results` | `items[]` 增加 `materialId`（`materialText` 已有） |
| `GET /api/training/targeted/start` 等题目下发 | 增加 `materialId`（`materialText` 已有） |
| `GET /api/student/practice-history/{source}/{id}` | `questions[]` 增加 `materialText` + `materialId` |

> API 文档 §4.19 / §4.18 / §4.29 与 openapi 同步（项目铁律）。

### 5.6 迁移与兼容

1. 新增 `material_id` 列（幂等迁移 + schema.sql）。
2. 语文老数据回填 material_id（一次性脚本，幂等）。
3. 物理/化学抽取（data-refinery，人工确认）。
4. 所有读路径对 `material_id` 为空的情况**保持今天的行为**（无材料题零感知）。

### 5.7 测试

- 后端：`questions.material_id` 回填脚本幂等测试；判题/解析带 `material` 时 prompt 含材料、不带时逐字不变；三处接口返回 `materialId/materialText`。
- 前端：结果页同组材料只渲染一次；无 materialId 时每题渲染（回归）；历史回放渲染材料；作答页材料展示。
- 数据：抽取脚本「只填空不覆盖」断言（前后逐行 MD5）。

---

## 6. 验收标准

1. 物理/化学材料题：材料与小题分离，`material_text` 有值、`material_id` 同组一致。
2. 结果页同一材料的 3 道小题只出现一次材料。
3. 练习记录详情能看到材料（语文 + 物理 + 化学）。
4. 判题/解析的 prompt 里能看到材料（抽查日志或单测断言）。
5. 无材料的题（数学等）行为零变化。
6. 语文老数据回填后，材料题展示不回归。

---

## 7. 需要你裁决的点

| # | 决策点 | 选项 | 我的建议 |
|---|---|---|---|
| 1 | 材料存储 | A 保持 content 混排 / B 抽到 material_text | **B** |
| 2 | 材料组标识 | 新增 `material_id` / 继续靠文本相同隐式分组 | **新增 material_id**（文本相同太脆） |
| 3 | 材料展示 | 每题重复（语文现状）/ 同组只显示一次 | **只显示一次** |
| 4 | 判题是否带材料 | 带 / 不带 | **带**（否则材料题判题缺上下文） |
| 5 | 物理/化学材料抽取方式 | 规则候选 + 人工确认 / 纯 LLM 自动 | **规则 + 人工**（LLM 不可复现） |
| 6 | 本次范围 | 只做「历史回放补 material」（1 天）/ 全量方案 B | 先做 1 天的最小补丁止血，再做全量？**还是直接做 B** |

> 化学已于 2026-11-02 实测确认**有材料题**：`id=4309`「阅读下面科普短文」、`id=4317`「絮凝剂…【进行实验】」，与物理同形态（材料混在 content）。化学 4 题 >500 字、17 题 200–500 字。

---

## 8. 待办（审核通过后）

1. 迁移 + schema：`material_id` 列
2. 语文老数据回填 material_id
3. 物理/化学材料抽取（data-refinery + 人工确认）
4. 判题/解析补 material
5. 三处展示改造（作答页 / 结果页 / 历史回放）
6. 接口 + 文档同步
7. 测试与端到端验收
