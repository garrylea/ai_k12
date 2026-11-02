# 材料题（物理/化学）统一设计 — 供审核

**日期**：2026-11-02
**状态**：**待用户审核**（未实现）
**提出人**：用户（2026-11-02）——「物理也有材料题，和语文阅读理解一样，阅读理解中的文章就是材料；不清楚化学有没有。总之这种有材料的该如何处理？语文的阅读理解是怎么处理的？」

> **修订记录（2026-11-02，同日内）**：初稿误判「物理材料与语文一样是跨题共享」。实测原始试卷 MD 后发现**两者结构不同**（见 §2），本版已按实测重写，**不再需要 `material_id`**。

---

## 1. 结论先行：两种形态，不是同一种

| | 语文 / 英语（形态 A：跨题共享材料） | 物理 / 化学（形态 B：题内材料） |
|---|---|---|
| 原文结构 | 「阅读下面文章，完成 5–8 题」→ 材料 → 5./6./7./8. 各自小题 | 「31. 阅读以下文字，并回答问题：」→ 材料 → `(1)(2)(3)` 小问 |
| 小问是不是主题号 | **是**（5./6./7./8. 各成一个 question） | **不是**（`(1)(2)(3)` 按切分规则合并进同一题） |
| 一道题里有几份材料 | 通常一份（多个小题共享） | 一份（就在这一题内部） |
| 材料与问题的关系 | **跨题共享** | **题内混排** |
| 现有处理 | `questions.material_text` 每题挂一份（靠内容相同隐式分组） | **无**——材料与问题全在 `questions.content` |

**实测证据（物理，海淀·一零一 202407 期中卷第 31 题）**：

```
## 四、科普阅读题（共3分）

31. 阅读以下文字，并回答问题：

半导体材料的应用
自然界的物质和材料千千万万，……（6 段科普正文 + 1 张图）

(1) 根据应用的半导体材料的不同, 太阳能电池分为……
(2) 判断太阳能电池优劣的主要标准是
(3) 太阳能电池运行的基本原理是

## 五、计算题（共8分……）
```

**实测证据（化学）**：
- `id=4309`：「29.（6分）阅读下面科普短文。」→ 表 1 → 小问
- `id=4317`：「37. (6分)絮凝剂常用于污水处理。…【进行实验】取 200 mL…」→ 结果表 → 小问

**⚠️ 本条已被 2026-11-02 下午的实测推翻（保留原判断以便对照）**：最初 grep「(回答|完成) N–M 题」零命中，据此认为物化没有跨题共享材料。**错的** —— 物化还有一种写法是「请阅读《航天动力电池》并回答第 32 题」，只回答**单题**、不写区间，因此没被那个正则命中。实际存在，见 §11。

实际有**三种**形态：

| 形态 | 原文 | 处理 |
|---|---|---|
| A 跨题共享（语文/英语） | 「阅读下面文章，完成 5–8 题」→ 材料 → 5./6./7./8. 各成一题 | `material_text` 每题挂一份（已实现） |
| B1 题内材料（物化） | 「31. 阅读以下文字…」→ 材料 → `(1)(2)(3)`（小问合并到本主题号） | `split_material()` 从 content 切出（已实现） |
| B2 题前共享（物化科技阅读题） | 「请阅读《航天动力电池》并回答第 32 题。」→ 材料 → 「32. 请根据上述材料…」 | `attach_pre_material()` 按引导语锚点归属（2026-11-02 补实现） |

---

## 2. 数据现状（实测，2026-11-02）

`questions` 表相关列：

| 列 | 类型 | 实际使用 |
|---|---|---|
| `content` | text | 题干正文（**物理/化学的材料混在这里**） |
| `material_text` | text | 语文材料题的材料原文（**只有语文用：684 题**） |
| `material_url` | text | 全库 1465 题 **0 行有值**（死列） |
| `group_id` | varchar(50) | 值是「一/二/三/四/五」= **试卷大题分区**，不是材料组 |
| `group_order` | smallint | 大题分区内题序 |

| 学科 | 题数 | 有 material_text |
|---|---|---|
| 语文 | 798 | 684 |
| 物理 | 135 | **0** |
| 化学 | 75 | **0** |
| 数学 | 457 | 0 |

长题分布（>500 字）：物理 16 题、化学 4 题；200–500 字：物理 53、化学 17。这些就是材料题。

---

## 3. 代码链路（材料目前只影响"展示"，不参与判题）

| 环节 | 现状 |
|---|---|
| 考试下发 | `exams.service.ts:279` → `materialText: row.material_text` |
| 训练下发 | `training.service.ts:798` → `materialText: q.material_text` |
| 考试结果页 | `ExamResultPage.tsx:171` → `material: it.materialText` → `AnswerResultList` 在题面上方渲染（`max-h-[32vh]` 可滚动） |
| 训练作答页 | `TargetedRunPage.tsx:110/117` → `QuestionRunner.tsx:533` 渲染 `q.material` |
| **判题** | `judgment.capability.ts:55` 只传 `questionContent`（= `q.content`），**材料不参与** |
| **解析** | `explanation-cache.service.ts:154` 只传 `content`+`answer`+`options`，**不传材料** |
| **练习记录详情** | `PracticeHistoryQuestion` **没有 material 字段** —— 语文材料题历史回放看不到材料 |

**既有抽取架构**（`tools/data-refinery/src/subject_strategies/`）：
- 每学科一个 strategy（`chinese.py` / `english.py` / `physics.py` / `chemistry.py` / `politics.py` …）
- `MaterialPolicy(attach: bool)` + `is_material_title()` + `looks_like_between_material()` —— **只处理形态 A（题号前/两题之间）**
- 现状：`chinese` / `english` 的 `attach=True`；**物理/化学/道法没有实现 material_policy → 默认 `attach=False`**
- `2026-09-05` splitter spec §10 已记录：「`material_text` 抽取：数学不抽；道法/物理需要单独拆出共享材料，后续做」——本需求就是这条遗留

---

## 4. 问题定义

1. **物理/化学的材料与问题混在 `content`**：一道 1400 字的实验题，学生看到的是"一大坨"，无法像语文那样"材料区可滚动、问题区固定"。
2. **判题/解析看不到材料**（若把材料抽到 material_text）：模型只看到小问，缺上下文，判错率上升。**现状因为是混在 content 里反而能看全**——这是抽取后必须补的洞。
3. **历史回放丢材料**：练习记录详情不返回 material，语文材料题回放只剩小问（现存缺口）。
4. **形态 A 的材料分组靠文本相同**：语文材料改一个字就断组（可接受，因为 material_text 是冗余存储、不承载业务语义）。

---

## 5. 方案

### 方案 A：只补展示（最小止血，1 天）

- 给练习记录详情补 `materialText`（语文材料题历史回放立刻可用）。
- 物理/化学**不动**（材料仍在 content，整段渲染）。
- **优点**：零数据迁移、零判题风险。
- **缺点**：物理/化学仍有"一大坨"体验。

### 方案 B：补齐形态 B 的抽取（推荐，分两步）

**B1（先做，止血）**：
- 练习记录详情补 `materialText` + 前端渲染（三处统一）。
- 判题/解析补可选 `material`（为 B2 铺路，当前 material 为空时行为逐字不变）。

**B2（再做，数据管线）**：
- 在 `physics.py` / `chemistry.py` 新增 **题内材料切分**（新钩子，不复用 `MaterialPolicy`）：
  ```python
  class QuestionStrategy(Protocol):
      def split_material(self, content: str) -> tuple[str | None, str]:
          """题内材料切分：返回 (material_text, 剩下的小问 content)；无材料返回 (None, content)。"""
  ```
  默认实现 `return (None, content)`（generic）——不影响数学/语文/英语。
- **三级流水（用户 2026-11-02 裁决：规则优先，LLM 兜底，人工只做前两者都失败的）**：

  | 档 | 触发 | 做法 | 落库留痕 |
  |---|---|---|---|
  | 1. 规则 | 命中材料标志 + 行首小问标记 | 纯 Python 切分 | `material_method='rule'` |
  | 2. LLM 兜底 | 规则**判定不适用或不自信**（见下） | 让模型只回答"材料结束在第几行 / 无材料"，**不让它改写内容** | `material_method='llm'` |
  | 3. 人工 | 规则与 LLM 结果冲突、或 LLM 输出不可解析/拼接校验失败 | 输出到待审清单 | `material_method='manual'` |

  **规则"不自信"的判据**（任一命中即降级到 LLM）：
  - content 长度 ≥ 150 且含材料标志词，但**找不到任何行首小问标记**（说不清切在哪）
  - 找到多个候选小问起点（如 `(1)` 与「第 1 问」并存），切分点不唯一
  - 拼接自校验失败（材料 + 小问 ≠ 原文）

  **LLM 兜底的硬约束**：
  - 只让模型输出**切分位置（行号）或"无材料"**，返回内容仍取原文切片 → 构造上保证不改写、可拼接校验
  - **不设 temperature 也可以**：因为输出只是行号，同样输入两次结果不同也只会导致"落人工"，不会污染内容
  - 结果仍要过拼接自校验；失败即降人工

  **人工只兜最后一种**：规则与 LLM 都说不清（预计极少数）。**不作为默认环节**——人工成本高于 LLM（用户明确要求）。

- **落库**：只写 `material_text` / `content` / `material_method` 三列，其他列不动（项目铁律：只填空不覆盖；前后逐行 MD5 比对）。

**为什么不复用 `MaterialPolicy`**：它的语义是"题号前/两题之间的短文挂到该题"（跨题共享），而形态 B 的材料在**题号之后、同一题内部**，两个谓词都命中不了。

**为什么不新增 `material_id`**：物化是题内材料（一题一份），不需要分组；语文靠 `material_text` 内容相同已够用。

### 方案 C：把物理/化学的小问也拆成多条 questions（像语文阅读那样）

- 让 `(1)(2)(3)` 各自成为一条 questions，共享 material。
- **不推荐**：与 splitter spec §3.1「小问号不切，合并到上一个主题号」直接冲突；会改变现有题量/题号/作答粒度；历史数据全部要重切；而且物理小问常常依赖上面的图/表编号（`如图甲`），拆开反而丢上下文。

---

## 6. 推荐：B1 → B2

### 6.1 数据层（B2）

复用 `material_text`（存材料）+ `content`（存小问）；**新增一列留痕**：

```sql
ALTER TABLE questions
  ADD COLUMN material_method VARCHAR(8) DEFAULT NULL
    COMMENT '材料抽取方式：rule|llm|manual；NULL=未做材料抽取（无材料题或未处理）';
```

约定：
- `material_text` 为空 ⇒ 行为与今天完全一致。
- 物理/化学的题内材料：`material_text` = 材料段，`content` = 小问段；两者拼接 = 原文。
- `material_method` 只用于排查"这条材料是规则切的还是 LLM 切的"，不参与业务。
- **不新增 `material_id`**：物化是题内材料，无跨题分组需求。

### 6.2 抽取层（B2，`tools/data-refinery`）

- `subject_strategies/types.py`：`QuestionStrategy` 协议加 `split_material()`，默认 `(None, content)`。
- `physics.py` / `chemistry.py`：实现规则切分（见 §5 B2）+ `attach_pre_material()`（形态 B2，见 §11）。
- `question_extract.py`：切完题后调用 `strategy.split_material(q.content)`，写入 `material_text` / `content`。
- `question_splitter.split_page()`：末尾调用策略的可选钩子 `attach_pre_material(questions, lines)`（generic/语文/英语没有此方法，行为不变）。
- 产出候选清单 + 人工确认（脚本：`--material-candidates` 输出待审清单）。
- 测试：切分前后拼接等原文、误切标志（小问里出现"阅读"不触发）、无材料题零变化。

### 6.3 判题与解析（B1 先铺）

```ts
// judgment.capability.ts
export interface JudgmentRequest { /* … */ material?: string | null }
// prompt context.question 增加 material（仅非空时拼入）

// explanation.capability.ts
explanation.explain({ ..., question: { content, answer, options, material } })
```

`judge-core.service.ts`（两处）与 `explanation-cache.service.ts:151` 补 `material: q.material_text ?? null`。

> 兼容：不传 / 为空时 prompt 与今天逐字一致（加测试钉住）。

### 6.4 展示（三处统一，B1 就做）

- **作答页**（`QuestionRunner`）：已有 `q.material` 区，无需改结构。
- **结果页**（`AnswerResultList`）：已有 `q.material`（`max-h-[32vh]` 可滚动），无需改结构。
- **历史回放**（`PracticeHistoryDetailPage`）：**新增 material 渲染**（当前缺字段，见 §3）。
- 视觉规范：材料区在题面上方、浅底、可滚动（复用现有 `data-testid="question-material"` 样式），问题区紧随其后。**不折叠**（学生需要边看材料边答题，折叠会多一次点击）。

### 6.5 接口变更

| 端点 | 变更 |
|---|---|
| `GET /api/student/practice-history/{source}/{id}` | `questions[]` 增加 `materialText` |
| `GET /api/exams/sessions/{id}/results` | 无变更（`materialText` 已有） |
| 训练题目下发 | 无变更（`materialText` 已有） |

> API 文档 §4.29 与 openapi 同步。

---

## 7. 验收标准

1. 练习记录详情：语文材料题的**材料可见**（B1）。
2. 物理/化学材料题：`material_text` 有值、`content` 只剩小问，**两者拼接逐字等于原文**（B2）。
3. 结果页/作答页/历史回放三处渲染一致（材料区 + 问题区）。
4. 判题/解析的 prompt 里含材料（单测断言）；无材料时逐字不变（回归）。
5. 无材料的题（数学等）行为零变化。
6. 人工确认清单 100% 过目（B2）。

---

## 8. 风险

| 风险 | 缓解 |
|---|---|
| 题内材料规则误切（把问题当材料 / 把材料截断） | 拼接等原文的自校验 + 人工确认清单；不纯 LLM（不可复现） |
| 抽离后判题缺材料导致判错率上升 | B2 必须与判题补 material 同批上线（B1 先铺） |
| 老数据（语文）受影响 | 不动语文数据；`material_text` 为空时行为不变 |
| 学生边看材料边答题的体验 | 材料区可滚动但不折叠，问题区紧随 |

---

## 9. 用户裁决记录（2026-11-02）

| # | 决策点 | 裁决 |
|---|---|---|
| 1 | 物化材料抽到 `material_text` | ✅ **要抽** |
| 2 | 抽取方式 | ✅ **规则优先；规则处理不了的用 LLM；人工只在规则+LLM 都失败时兜底**（用户明确：人工成本高于 LLM） |
| 3 | 小问是否拆成独立题 | ✅ **不拆**（保持 splitter spec §3.1「小问不切」） |
| 4 | 范围 | ✅ **B1 + B2 全做** |

---

## 10. 建议实施顺序

1. **B1**：练习记录详情补 materialText（前后端 + 测试）——1 天
2. **B1**：判题/解析补可选 material（零行为变化）——半天
3. **B2**：`split_material()` 钩子 + 物化规则 + 候选清单——2–3 天
4. **B2**：人工确认 + 落库（只写两列、拼接自校验）
5. 文档同步（API §4.29 / openapi / constraints）

---

## 11. 实施补充（2026-11-02 追加：形态 B2 + 图片物化）

### 11.1 形态 B2 是什么

用户报告练习记录第 32 题「有材料但看不到」。实测原卷（2024 西城·北师大实验 物理期中）：

```
## 四、科技阅读题（共3分，每空1分。）

请阅读《航天动力电池》并回答第 32 题。

## 航天动力电池

近期，我国载人航天飞船神舟十八号迎来重大升级……（4 段 + 图23）

32. 请根据上述材料，回答下列问题:

(1) …… (2) …… (3) ……
```

材料在**题号之前**、被题目用「请根据上述材料」引用 —— 与语文形态 A 同类，但物理的
`material_policy` 一直是 `attach=False`，切题时这段文本**被整段丢弃**：题目说
「请根据上述材料」而材料根本不存在（不是渲染问题，是数据缺失）。

同类问题还有 1 道：`id=5994`（2024 西城·北京四中《超导现象》并回答 33 题）。

### 11.2 实现

- `material_split.attach_pre_material(questions, lines)`：
  1. 只处理 `content` 以「（请）根据/结合/阅读 上述（的）材料|短文|文字|内容」开头的题
  2. 向上找最近的引导语锚点（`请阅读《…》并回答…` / `阅读下面的材料` / `阅读材料，回答`）
  3. 材料 = 锚点行 → 其后**第一个题号行**之前（含文章标题、正文、图）
  4. 同一材料被多题引用时每道题挂同一份
- 调用点：`question_splitter.split_page()` 末尾，用 `getattr(strategy, 'attach_pre_material', None)`
  —— generic / 语文 / 英语没有这个方法，**行为零变化**。
- 回填：`tools/db/material_backfill.py` 第二阶段（按题号 + 题干首行定位原卷行号，读 MD 回捞）。

### 11.3 材料里的图片会 404（顺带修掉）

材料是从原卷 MD 原文切的，图片仍是 `![图](images/xxx.jpg)` 这种 MD 相对路径 →
前端拼成 `/assets/images/…` → 404 且破图被 `onError` 隐藏（与 2026-10-31 同源）。
publish 阶段本来会物化（`rewrite_item` 覆盖 `material_text`），但本次是**publish 之后**
改库，所以回填脚本补了第三阶段：

- 拷贝到 `output/assets/material/<subject>/<文件名>`（文件名是内容哈希，天然不重名）
- `material_text` 里的路径改写为 `material/<subject>/<文件名>`
- 实测 3 道题（5994 / 6023 / 6087），图片 `naturalWidth>0` 正常显示

> `output/` 是 gitignore 的派生产物；换机器/重跑管线时，图片由 publish 或本脚本重新物化。

### 11.4 验收（实测通过）

- DB：`material_method='rule'`，6087 材料 624 字、5994 800 字
- 接口：`GET /api/student/practice-history/exam/44` 带材料题 7 道（24/25/27/30/32/33/34）
- 浏览器（headless Chromium 实测）：第 32 题材料区 532 字 + 标题「航天动力电池」+ 图 901px 正常
- 回归：refinery `1563 passed`；回填脚本二次运行 0 可改项（幂等）
