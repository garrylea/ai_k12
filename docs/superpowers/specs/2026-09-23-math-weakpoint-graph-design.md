# 数学薄弱点图谱与推荐 — 设计

> **日期**：2026-09-23
> **状态**：设计已与用户逐节确认（14 条裁决见 §3），待用户审阅本文件后转 writing-plans。
> **PRD 锚点**：`docs/K12智学系统-产品需求文档.md` §7.4（错题本节，提到「推荐」）、§7.6（测评节，「测评后推荐薄弱点专项练习」）。
> **API 文档锚点**：§4.5 Knowledge Graph 组（`/api/knowledge-graph`，四端点早已规划、均未实现）。
> **上游产物**：本设计由 2026-09-23 的 brainstorming 会话产出；可视化 mockup 在 `.superpowers/brainstorm/2177-1790128982/content/`（**gitignore，换机器即失传**，故 UI 形态在 §6 用文字完整固化，不依赖那些文件）。

---

## 1. 背景与现状（2026-09-23 实测，勿凭记忆）

| 事实 | 实测值 |
|---|---|
| 知识点树 | **只有数学有**。`knowledge_points` subject_id=1：一级 **9** 个 / 二级 **70** 个 |
| 语文/英语 | `chinese_passages` / `english_words` 独立子系统，**无知识点体系** |
| 数学题 KP 覆盖 | active 题 **457**，带 KP 标注 **205**（≈45%） |
| 掌握度数据 | `student_knowledge_mastery` 全库仅 **3 行 / 1 个学生 / 3 个知识点** |
| 家长端已有 | 「薄弱点（**错题数代理**）」与「掌握度」**两卡并存、不得合并**（spec §10 明文） |
| 学生端缺口 | **没有任何基于薄弱点的推荐入口**；训练轨专项练习要学生手动两级选知识点 |
| 前端图库 | **无**。只有 `recharts`（仅家长端柱/折线用）；星图页是自算坐标的 div/SVG，不是图谱 |

**目标**：学生能一眼看出自己哪些知识点弱，并能一键开练。

---

## 2. 范围

### 本期做
- **仅数学**（subject_id=1）
- 学生端训练轨 → 新增第 4 张卡 → **独立全屏页** `/student/training/weak-points`
- **一级折叠的树状热力图** + 右侧详情栏
- **一条推荐**（「最该补：X」+「开始补这个」）
- 后端新建 `knowledge-graph` 模块，实现 API 文档 §4.5 中 **两个** MVP 端点

### 本期不做（明确）
- 语文 / 英语的「薄弱」口径（无知识点体系，硬做只会是空壳）
- **关系图 / 学习路径**：依赖 `knowledge_relations`（**表已建、零数据、零代码引用**），等于要先做一轮数据工程 → 归 P1
- **考试报告页的薄弱点诊断**（UX P2.8 的「中部环形薄弱点图」）——另一处入口，本期待定
- 家长端任何改动（两卡口径不动）
- 时间窗（见 §4.4）

---

## 3. 用户裁决记录（逐条，勿在实现时推翻）

| # | 议题 | 裁决 |
|---|---|---|
| 1 | 学科范围 | **仅数学** |
| 2 | 主入口与使用者 | **学生端训练轨**（家长端两卡不动） |
| 3 | 图谱形态 | **树状热力图**（复用现有两级树 + 按掌握度着色） |
| 4 | 着色口径 | **掌握度为主 + 样本兜底**：样本 <5 标「数据不足」不判强弱；从未作答灰显「未开始」；显式给出「另有 N 道未标注知识点的题」 |
| 5 | 入口形态 | 三卡页**第 4 张卡** → **独立全屏页** |
| 6 | 推荐程度 | **图谱 + 一条推荐**（不铺 TOP-N 列表） |
| 7 | 推荐算法 | **最弱 + 样本≥5 + 有题可抽**；无够格候选 → 不硬推，转「先做一次练习/考试生成诊断」引导 |
| 8 | 树的铺法 | **一级折叠**：9 行概览（汇总色 + 待补数），展开才看二级 |
| 9 | 点节点行为 | **右侧详情栏**（左树右详情）；窄屏降级为**底部抽屉** |
| 10 | 后端落点 | **新建 `knowledge-graph` 模块**（对齐文档）；`relations` 端点**降级为 P1** 并同步文档 |
| 11 | 练习怎么起 | 复用 `POST /api/training/targeted/start`，`type=null`（不限题型），题量取**「≥3 的最小可用档」**（默认档位下即 **3 题**） |
| 12 | 时间窗 | **全量累计**（与家长端薄弱点/掌握度同口径，不另设窗口） |
| 13 | 未标注的题 | 页脚固定一行「另有 N 道未标注知识点的题」+ 可点进错题页 |
| 14 | 窄屏 | 右栏降级为底部抽屉（iPad 横屏为主断点，用分栏） |

---

## 4. 数据模型与口径

### 4.1 知识点树
`knowledge_points`（schema.sql L169-184）：`subject_id`(FK) / `parent_kp_id`(自引用，两级) / `name` / `code` / `grade_band` / `difficulty`。
- **KP 不直接挂教材版本或课**。教材链是 `textbook_versions → semesters → units → lessons → cards`；`cards.knowledge_point_ids` 是 TEXT 存 JSON（弱关联）。
- 题与 KP 多对多：`question_knowledge_points (question_id, knowledge_point_id, role, weight)`。
- 读侧仓储：`KnowledgePointsRepository` 已有 `findBySubject()` / `findById()`，**直接复用**。

### 4.2 掌握度表语义与写入口（勿误判）
`student_knowledge_mastery`（schema.sql L475-491）：唯一键 `uniq_skm_student_kp (student_id, knowledge_point_id)`。

- **唯一写入口**：`StudentKnowledgeMasteryRepository.upsertOnJudge()`（`database/repositories/student-knowledge-mastery.repo.ts`）。
- **语义**：`mastery_score = correct_count / (correct_count + error_count)`（**累计正确率**，非 IRT、非加权衰减）；`level = FLOOR(5 * score)`（0–5 档）。首次插入：答对 → `1.0 / 5`，答错 → `0.0 / 0`。
- **调用链**：`JudgeCoreService.finishJudge()` → `void masteryService.recordFromJudge(...)`，**无 source 分支** → `practice`（卡中心）、`training`（`judgeTraining` → `judgeCore.judgeQuestion`）、`exams`、`remediation` **判题都回写**。
  - ⚠️ **勘误**：2026-09-23 brainstorming 的调研摘要曾写「只有 practice 回写、training 不回写」，**该结论错误**（`training.service.ts:173-174` 即走 `judgeQuestion`）。本设计以本条为准。
  - 闭环因此成立：推荐 → 专项练习 → 判题 → 掌握度更新。

### 4.3 两处数据缺口（设计必须处理，否则家长/学生会误读）
1. **题覆盖缺口**：数学 457 道 active 题里只有 205 道带 KP 标注 → 另 252 道**永远进不了图谱**。必须在页脚显式说明。
2. **学生作答缺口**：未作答过的 KP 在 `student_knowledge_mastery` 里**没有行**（不是 0）→ 后端必须**以全树为基准左连**，缺失标 `null`，前端渲染为「未开始」灰色，**绝不能当成「掌握度 0」**（那是「很弱」的意思，语义相反）。

### 4.4 与家长端两口径的关系
家长端「薄弱点」= **错题数代理**（`main_error_books JOIN question_knowledge_points`，按未清零数降序）；「掌握度」= 本表。两者**并存不合并**。
本设计**只取掌握度口径**（裁决 4），**不改家长端**，也不把学生端的算法回灌给家长端。

**时间窗**：全量累计。掌握度本身是累计列，加时间窗需另算派生量，本期不做（裁决 12）。

---

## 5. 后端设计

### 5.1 模块与依赖
新建 `apps/server/src/modules/knowledge-graph/`：

```
knowledge-graph.module.ts
knowledge-graph.controller.ts
knowledge-graph.service.ts
dto/knowledge-graph.dto.ts
```

- **复用既有仓储**，不新建表、不写数据：`KnowledgePointsRepository`（树）、`StudentKnowledgeMasteryRepository`（overlay）。
- 需要**新增仓储方法**（放各自既有仓储里，别为读建新仓储）：
  - `KnowledgePointsRepository`：批量取某学科 KP 的**可抽题数**（供「有题可抽」闸门与详情展示）。
  - `StudentKnowledgeMasteryRepository`：按 `(studentId, subjectId)` 取**该生在该学科的全部掌握度行**（现有 `listWeakest` 只给最弱 N 个、且无 subject 过滤，不够用）。
  - 该生**未标注知识点的未清零错题数**：家长端 `countUncoveredUnclearedErrors` 是 `parent-insights` 模块内的，**不可跨模块直接复用**；本模块自己写一条等价查询（口径照抄：`main_error_books` 左连 `question_knowledge_points`，`is_cleared=0` 且 `question_id` 不在带 KP 的题集合内）。
- **不注入 `PointsService`**：本模块只读，不发分。发分仍由 `targeted/start` → 训练模块负责。

### 5.2 端点 1：全树 + 掌握度 overlay

```
GET /api/knowledge-graph/students/{studentId}/mastery?subjectId=1
```

- 鉴权：JWT 学生角色；`studentId !== user.sub` → **403 / code 1005**（复用 `ForbiddenException({code:1005, message:'无权访问该资源'})` 既有惯例）。
- `subjectId` 本期只接受 `1`；其它值 → 400（错误码见 §5.5）。

**返回**（`data` 形状）：

```ts
{
  subjectId: 1,
  nodes: Array<{
    id: number;
    name: string;
    parentId: number | null;      // null = 一级
    masteryScore: number | null;  // null = 未作答（≠ 0）
    level: number | null;
    correctCount: number | null;
    errorCount: number | null;
    lastSeenAt: string | null;    // ISO
    sampleSize: number;           // correct+error；未作答 = 0
    confidence: 'none' | 'insufficient' | 'ok';  // none=未作答 / insufficient=样本<5 / ok=样本>=5
    availableQuestionCount: number;  // 该 KP 可抽题数（见下）
  }>,
  coverage: {
    coveredQuestions: number;      // 数学 active 题里带 KP 标注的
    totalQuestions: number;        // 数学 active 题总数
    uncoveredUnclearedErrors: number;  // 该生未标注知识点的未清零错题数（页脚用）
  }
}
```

- `confidence` 由后端算，**前端不重算阈值**（阈值只此一处，防漂移）。
- `availableQuestionCount` 谓词：`questions JOIN question_knowledge_points`，`subject_id=1 AND kp_id=? AND is_active=1 AND answer <> ''`，`LEFT JOIN student_hidden_questions` 排除该生「不再展示」（与 `questions.repo.ts` 的 `findRandomByKpAndType` 逐字对齐）。
  - **一次分组查询**取全部 KP 的计数（别 79 次单查）。

### 5.3 端点 2：推荐

```
GET /api/knowledge-graph/students/{studentId}/weak-points?subjectId=1&limit=1
```

- `limit` 默认 1、范围 1..10（本期前端只用 1）。
- 鉴权同上（403/1005）。

**返回**：

```ts
interface WeakPointCandidate {
  knowledgePointId: number;
  name: string;
  parentId: number | null;
  masteryScore: number;
  level: number;
  correctCount: number;
  errorCount: number;
  sampleSize: number;
  availableQuestionCount: number;
  lastSeenAt: string | null;
}

{
  subjectId: 1,
  candidates: WeakPointCandidate[],
  recommendation: WeakPointCandidate | null,   // = candidates[0] ?? null
  reason: 'ok' | 'no_qualified_candidate'
}
```

- `recommendation === null`（`reason='no_qualified_candidate'`）时前端转引导态（§6.4）。
- 空候选**不是错误**，返回 200。

### 5.4 推荐算法（四道闸门 + 排序）

**候选资格**（四个条件同时满足）：
1. `student_knowledge_mastery` 里**有该生的行**（做过至少一题且题带 KP 标注）
2. **样本 ≥ 5**（`correct_count + error_count >= 5`）—— 过滤「做 1 题答对 = 满分」的小样本噪声
3. **有题可抽**（`availableQuestionCount > 0`）—— 否则推了也练不了
4. **尚未掌握**（`level <= 2`，即掌握度 < 60%）—— 已掌握的不算「该补」

> **闸门 4 是 2026-09-23 真机冒烟后补的**（原为三道闸门）。只有前三道时，一个「零星几条数据」的账号会被推「最该补：你 100% 掌握的知识点」——因为全库只有 3 行掌握度时，样本不足的行被闸门 2 滤掉，只剩满分那行过闸。学生看到会直接不信这个功能。
>
> 阈值**刻意与一级行「N 个待补」共用**（同一个 `WEAK_LEVEL_MAX = 2`），否则会出现自相矛盾：一级行显示「0 个待补」，推荐条却把同一个点推成「最该补」。

**排序**：`mastery_score ASC, error_count DESC, knowledge_point_id ASC`
（前两项与 `StudentKnowledgeMasteryRepository.listWeakest` 的既有排序一致；第三项补稳定性，避免并列时结果抖动。）

**阈值常量**（导出为具名常量，供测试引用）：
```ts
export const MIN_SAMPLE_SIZE = 5;
export const WEAK_LEVEL_MAX = 2; // 闸门 4 与一级行「N 个待补」共用
```

### 5.5 错误处理

| 场景 | HTTP | code | 说明 |
|---|---|---|---|
| 非本人 `studentId` | 403 | **1005** | 复用既有 `ForbiddenException` 惯例 |
| `subjectId` 非 1 | 400 | **1001** | 请求参数不合法 |
| `limit` 越界 / 非整数 | 400 | **1001** | 同上 |
| 未登录 / token 无效 | 401 | 1003 系 | 由 `JwtAuthGuard` 兜 |

- 只读端点**无写入**，故无「失败回滚」问题。
- 查询失败按 Nest 默认 500 抛出（不加吞异常逻辑——这不是埋点路径）。

### 5.6 性能

- 两次端点各自独立查询，前端**并行发**（§6.2）。
- 三个查询都可一次完成：树（`findBySubject`）、掌握度行（一次 `WHERE student_id=? AND knowledge_point_id IN (该学科 KP)`）、可抽题数（一次 `GROUP BY kp_id`）。
- 规模：79 个 KP / 457 道题，**无需分页**。

---

## 6. 前端设计

### 6.1 路由与入口
- 新页：`/student/training/weak-points`（`routeTable.tsx` 注册，挂训练轨）
- 入口：`TrainingHomePage` 由「三卡」改「四卡」，新增第 4 张卡「薄弱点图谱」→ 点进该页。
  - ⚠️ 现有三卡网格布局需一并调整（4 卡），别让卡片被压扁。
  - 训练轨页面**全屏、硬编码 `data-theme="student-day"`、不在任何 Layout 下**（CLAUDE.md 硬约束），新页照此。
- **不做深链参数**：进页面即看全貌，无 `?kpId=` 之类。

### 6.2 页面结构与状态机
```
[顶栏：薄弱点图谱 · 数学]
[推荐条]  ── 有候选：「最该补：X」+ 掌握度/样本/可抽题数 + [开始补这个]
             无候选：引导文案 + [去练习] / [去考试]
[主体 两栏]
  ├ 左：一级折叠树（9 行；每行 = 展开箭头 + 一级名 + 汇总色块 + 右侧状态标签，见下）
  │      展开后 = 该一级下的二级 chip（按掌握度着色）
  └ 右：详情栏（未选中时 = 提示「点左侧知识点看详情」）
[页脚] 另有 N 道未标注知识点的题，不计入上图 · [去错题页看]
```

**状态机**（每栏独立，避免互相拖累）：
- `mastery` 请求：`loading` → `ok` / `error`（错误态给「重试」，不留白）
- `weak-points` 请求：`loading` → `ok` / `error`；`error` 时**推荐条降级为不显示**（图谱仍可用），不整页报错

**一级行的状态标签（三态，2026-09-23 补第三态）**：
| 标签 | 判定 | 含义 |
|---|---|---|
| 未开始 | 该一级下**无任何 `ok` 子项** | 没做过，或只做过但样本都不足 |
| N 个待补 | 有 `ok` 子项，且其中 `level <= 2` 的有 N 个（N > 0） | 有该补的 |
| 已掌握 | 有 `ok` 子项，但**一个 `level <= 2` 的都没有** | 都会了，没有待补的 |

> 第三态是 2026-09-23 真机冒烟后补的：只判「有没有 `ok` 子项」时，全是 `level > 2` 的一级行会渲染出「**0 个待补**」这种无意义噪音（真机：lc1 的「四边形」下面只有 1 个满分点）。
> 三态与 §5.4 的闸门 4 共用 `WEAK_LEVEL_MAX`，故「已掌握」的一级行下**必然没有**可推荐的点。

**着色（唯一实现，勿在多处重算）**：
| 状态 | 判定 | 表现 |
|---|---|---|
| 未开始 | `confidence === 'none'` | 灰底灰字 |
| 数据不足 | `confidence === 'insufficient'` | 灰底 + 虚线边；详情栏注明「样本不足（<5 题），暂不判定强弱」 |
| 有结论 | `confidence === 'ok'` | 按 `level` 0–5 走橙色深浅梯度（与 brand 同色系，**不引入第二套配色**） |
- 颜色梯度**只从 `style.md` §2 的 token 派生**；不得引入新色。

### 6.3 交互
- 点一级行 → 展开/收起（默认**全部收起**；9 行一屏看完，符合裁决 8 的初衷）
- 点二级 chip → 右栏显示该 KP 详情（名称 / 掌握度条+百分比 / 对 N 错 M / 最近作答 / 样本是否可信 / `availableQuestionCount`）+ 两个动作
- **[开始补这个]** → `POST /api/training/targeted/start`，入参 `{subjectId:1, kpId, type:null, count:<最小可用档>}`
  - `count` 来源：**前端从 `GET /api/points/me/rules` 取 `math_targeted` 的档位**（该端点**有意只回已启用档**，正是 `listTierKeys` 白名单认的那一组，见 `points.controller.ts:58-73` 的注释），取 **「≥3 的最小档」**（默认档位 `1/3/5/10` 下即 **3 题**）。
    - 边界：若该生可用档**全部 <3**（家长只留了 1 题档）→ 退化为其中**最大**的一档（即 1），**不报错**。
    - 边界：若一个档位都取不到 → 按钮置灰 + 提示，不硬发请求（否则会被 `targeted/start` 以 400 拒绝）。
  - 成功后跳作答页（复用现有专项作答流）
- **[看这个知识点的错题]** → 跳错题页并带 `kpId`。**已核实学生端错题页支持按知识点过滤**：`GET /api/training/error-book?subjectId=&from=&to=&type=&kpId=`（`training.controller.ts:32-46` 已收 `kpId` 参数），直接带上即可，无需降级。

### 6.4 空态与引导（**最重要的现实场景**）
当前数据几乎是空的（3 行），**绝大多数学生进页面看到的是全灰 + 无候选**。故：
- 无候选时推荐条改为：**「还没有足够的数据来判断你的薄弱点。先做一次练习或考试，我们就能给你诊断。」** + [去专项练习] / [去考试]
- 全灰的树**不是错误态**，不要显示「暂无数据」空图；页脚仍显示「另有 N 道未标注知识点的题」（若有）
- **不假装有数据**：不把「未作答」渲染成 0%、不给默认推荐

### 6.5 窄屏降级
- iPad 横屏（主断点）及以上：左树 + 右详情**分栏**
- 窄于主断点：详情改为**底部抽屉**（点 chip 滑出），树保持全宽
- 断点取 `style.md` / UX 文档既有值，**不新造断点**

### 6.6 样式硬约束（CLAUDE.md）
- 无 emoji；图标一律线性 SVG（展开箭头等）
- 配色只用 `style.md` §2 那一套；热力梯度从 brand 派生
- `data-school` 只调字号，不改色/圆角
- 训练轨页面全屏 + `data-theme="student-day"` 硬编码

---

## 7. 测试策略

**后端（Vitest，新模块）**
- Service 单测：候选资格三道闸门（缺任一即排除）、排序稳定性（并列取小 kp_id）、无候选返回 `null` 而非报错、`confidence` 三态判定、`uncoveredUnclearedErrors` 口径
- Controller 单测：路由形状（path/method）、`studentId !== user.sub` → 403/1005、`subjectId`/`limit` 非法 → 400/1001
- 仓储形状钉子：新方法的 SQL 谓词（`is_active=1`、`answer <> ''`、`student_hidden_questions` 排除、`correct+error >= 5`）用 `expect(sql).toContain(...)` 钉住——**本仓既有盲区**：mockPool 不看 SQL 文本会让别名/谓词改动全绿（见 changelog 2026-09-20 的 I2 教训）
- 边界：样本正好 = 5（含）、= 4（不含）；`availableQuestionCount = 0` 排除

**前端（Vitest + RTL）**
- 页面渲染：四卡入口、树折叠/展开、点 chip 出详情、推荐条两种形态（有候选 / 引导态）
- **归属与竞态**：无（本页只有本人数据，无切换孩子场景）
- 空态：全灰树不显示「暂无数据」；无候选时推荐条是引导文案
- `confidence` 三态渲染各异（灰 / 虚线灰 / 橙色梯度）
- 渲染测试必须真跑（本仓铁律：类型检查抓不到运行时数据形状问题）

**门禁**：`apps/server` `npm test` + `tsc --noEmit`；`apps/web` `npm test` + `tsc -b` + `lint`（0 error）。

---

## 8. 已知限制与延后项

1. **`knowledge_relations` 零数据** → 关系图 / 学习路径 / 「先补 A 再补 B」本期不做（P1）。`relations` 端点从 MVP **降级为 P1**（需同步 API 文档 §4.5，见 §9）。
2. **KP 覆盖仅 45%** → 252 道题进不了图谱；页脚显式说明，**不做兜底映射**（自动映射知识点属另一批）。
3. **掌握度是累计正确率**，不随时间衰减、不区分题目难度 → 「最近变差」这类语义本期表达不了。
4. **小样本**：`< 5` 一律不判强弱；`MIN_SAMPLE_SIZE` 是拍出来的阈值，**后续应按数据分布校准**。
5. **掌握度不区分 `role`**：**已核实** `MasteryService.recordFromJudge` 经 `QuestionsRepository.findKnowledgePointIdsByQuestion()` 取该题**全部**关联 KP 并逐个 upsert（`mastery.service.ts:39-47`），**不区分 primary / 次级** → 图谱同口径取全部关联，读侧与写侧一致。若将来要区分，必须**同时**改回写侧与读侧。
6. 考试报告页（UX P2.8）的薄弱点诊断**不在本期**，两处入口将来要共用同一后端服务。

---

## 9. 文档同步清单（实现时必须一并改）

| 文档 | 改什么 |
|---|---|
| `docs/API接口与数据流设计文档.md` §4.5 | `relations` 由 MVP → **P1**；`mastery` / `weak-points` 补上**实际契约**（入参、返回形状、错误码）；版本号 +1 |
| `docs/api/openapi.yaml` | 新增两个 GET 端点（200），补 schema；与文档逐条对齐 |
| `docs/UX-UI设计文档.md` | 训练轨页面清单新增 `/student/training/weak-points`（四卡入口 + 折叠树 + 右栏详情 + 窄屏抽屉）；P2.8 的薄弱点诊断标注「未实现」 |
| `docs/K12智学系统-产品需求文档.md` | §7.4 / §7.6 的「推荐」补落地说明（指向本 spec）；**若与 PRD 原意有出入，先与用户确认再改** |
| `docs/K12智学系统-数据库设计文档.md` | 无需改（**不新增表/列**）；如补充说明 `student_knowledge_mastery` 的读侧新用法 |
| 根 `CLAUDE.md` | 若产生新的「勿动」约束（如阈值、口径），按体量纪律加一行；日期日志进 `docs/ai-core-changelog.md` |

---

## 10. 裁决补记（本文件定稿前已全部解决，无遗留待裁决）

| 议题 | 结论 |
|---|---|
| 练习题量 | **取「≥3 的最小可用档」**（默认档位下 = 3 题）。原「最小档」= 1 题偏少，用户 2026-09-23 改定 |
| 「看这个知识点的错题」是否可达 | **可达**：学生端错题页已支持 `kpId` 过滤 → 见 §6.3 |
| 掌握度是否区分 `role` | **不区分**，读侧写侧同口径 → 见 §8 第 5 条 |
| `count` 从哪拿 | `GET /api/points/me/rules`（学生可调、只回已启用档）→ 见 §6.3 |

### 10.1 上线后真机冒烟的两条补丁（2026-09-23，均已裁决并落地）

| 议题 | 结论 |
|---|---|
| 推荐把「100% 掌握」的点当成「最该补」 | **加第 4 道闸门**：`level <= 2`（掌握度 < 60%）才算候选 → 见 §5.4。用户裁决：「加掌握度上限闸门」 |
| 一级行显示「0 个待补」 | **加第三态「已掌握」**：有 `ok` 子项但一个都不弱时 → 见 §6.2。用户裁决：「改为已掌握」 |

两者**共用同一个 `WEAK_LEVEL_MAX = 2`**，刻意不拆成两个阈值——拆开会出现「一级行说 0 个待补、推荐条却推它」的自相矛盾。
