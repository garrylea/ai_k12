# 家长端「看得见」批（仪表盘 / 学情报告 / 错题查看 / AI 对话回放）· 设计

日期：2026-09-18
状态：**待实施**
相关：`docs/K12智学系统-产品需求文档.md` §7.7、`docs/UX-UI设计文档.md` §5.6（P6.1–P6.4）、`docs/API接口与数据流设计文档.md` §4.13 / §6.8、`docs/api/openapi.yaml`、`apps/server/src/modules/parent-insights/`（新建）、`apps/web/src/pages/parent/`

---

## 1. 定位与边界

家长控制台的第一批：把「家长能否看见孩子学了什么」这条链打通。四个页面从 `Placeholder` 变成真实页：

**仪表盘 P6.1（一屏看所有孩子）→ 学情报告 P6.2（单孩时间趋势）→ 错题查看 P6.3（只读错题本）→ AI 对话回放 P6.4（逐句回放）**

**边界**：

- **纯只读**。本批不产生任何业务写入，不改学生端行为，不动任何既有门禁。
- **不做埋点**。学习时长、知识点掌握度在底层无数据（见 §2），本批不补埋点，改用**等价的可得指标**（活跃天数 / 最近活跃 / 错题数代理），并把文档里的相关承诺改掉。
- **不做 AI 生成报告**。`AnalyticsCapability` 与 `analysis` 场景虽已存在，但本批报告页是**实时聚合**，不调 LLM、不落 `learning_reports`。
- **不碰 `safety_alerts`**。异常预警闭环（检测侧落库 + Banner 接真数据）属于「管得住」批，本批只做**会话内的闲聊标记**（`ai_messages.safety_flag`，已有真实数据）。
- 管理员端完全不动。

### 1.1 本批明确不做（后续批次）

| 项 | 归属 |
|---|---|
| 学习时长埋点（`study_sessions` 表 + 前端心跳） | 独立 spec |
| 知识点掌握度写入（`student_knowledge_mastery`） | 独立 spec |
| AI 生成学情报告 + 落 `learning_reports` | 独立 spec（可复用本批的聚合 service） |
| `safety_alerts` 落库 + 家长 Banner 接真数据 + 预警中心 P6.9 | 「管得住」批 |
| 目标设定 P6.5 / 行为管控 P6.6 / 账号设置 P6.10 | 「管得住」批 / 收尾批 |
| 订阅、支付、优惠券、订单 | 独立 spec（连表都没有） |

---

## 2. 调研结论（决定了口径与可得性）

### 2.1 代码现状

1. 四个页面在 `apps/web/src/routes/routeTable.tsx:322-325` 全是 `<Placeholder>`；后端 `parent.controller.ts` 无这四个域的任何端点。
2. 六个端点**早已写在文档里并标为 MVP**（`docs/API接口与数据流设计文档.md` §4.13、`openapi.yaml:2286/2303/2328/2356/2381/2406`），但一行实现都没有 → 文档与实现漂移，本批必须一并修正。
3. **可复用但要包一层**：`ParentService.requireOwnedStudent`（`parent.service.ts:196`，归属校验唯一入口）、`ProgressService.getStarMap`（进度到第几单元第几课）、`AiDialoguesRepository.findByStudentAndTrack` + `AiMessagesRepository.findByDialogue`（会话与消息，底层不带归属）。
4. **必须新写的**：`practice_results` / `exam_answers` 的按学科与按时间聚合、`exam_sessions` 按学生列表、错题列表与统计、会话消息数聚合。这些全部进**新 repo** `parent-insights.repo.ts`。
5. **既有 repo 一律不动**：共享方法（如 `MainErrorBooksRepository.findErrorBookEntries`）正被训练轨调用，改它会连带改训练轨行为。需要类似查询就在新 repo 里照抄写法自建。
5. `main_error_books.source` 实际有 5 个值（`practice` / `discuss` / `exam` / `targeted` / `error_practice`），**比 openapi 的 enum 多 3 个**（enum 只有 `homework/unit_test/midterm/final/auxiliary/practice/discuss`）。实现与文档都按实际 5 值处理。

### 2.2 底层无数据的字段（本批必须换口径）

| 文档承诺 | 实测 | 本批替代 |
|---|---|---|
| 学习时长（`Dashboard.todayStudyMinutes`、UX「学习时长曲线」） | 全库无任何 duration / 心跳 / 学习会话字段。`ai_messages.response_time_ms` 恒 NULL（`conversations.service.ts:91,176,198` 写 null）；`progress.last_active_at` 只在首次领课时写一次且 repo 不读 | `activeDays7`（近 7 天有记录的天数）+ `lastActiveAt`（多表时间并集 MAX） |
| 薄弱点掌握度（UX「薄弱点雷达图」） | `student_knowledge_mastery` / `knowledge_relations` 全仓零写入（`apps/server/src` 下 0 命中） | 错题数代理：按知识点聚合**未清零错题数**排序，并显式给出「未标注知识点」计数 |
| 学情报告正文 | `learning_reports` 空表、零代码引用；`AnalyticsCapability` 未接端点 | 实时聚合图表，不落库 |

### 2.3 实测数据（2026-09-18，dev 库）

```
questions 529      question_knowledge_points 覆盖 203 题（38%）   knowledge_points 79
main_error_books 139（全部有 question_id；其中 55 条能映射 KP = 40%）
  source 分布：exam 134 / targeted 5（practice/discuss/auxiliary 当前为 0）
practice_results 1        exam_sessions 27        exam_answers 564
ai_dialogues 80（subject_id NULL 61 条 = 76%）
  track/scene：auxiliary/aux_qna 46、mainline/mainline_card 29、auxiliary/aux_training 5
ai_messages 198（safety_flag=1 共 22 条）        point_ledger 1        students 5
```

**三条直接结论**：

1. **正确率的主要数据源是考试**（564 行 `exam_answers` vs 1 行 `practice_results`），口径必须把两者合并，不能只算练习。
2. **知识点映射只有 40%**（55/139）→ `weakPoints` 必须额外返回未覆盖计数并在 UI 说明，否则家长会以为「只有这些问题」。
3. **76% 的会话没有 `subject_id`** → 坐实「按学科筛对话不可用」，「按轨道 + 场景 + 时间 + 关键词」是唯一可靠维度。

---

## 3. 定案清单

用户逐条裁决过。改这里之前先确认不是把某个刻意的决定「统一」掉了。

| # | 议题 | 结论 |
|---|---|---|
| 1 | 学习时长 / 掌握度 | 不补埋点，用可得指标替代，并同步改 PRD/UX/API 文档 |
| 2 | 学情报告形态 | **纯实时聚合图表**，不调 LLM、不落 `learning_reports` |
| 3 | 仪表盘形状 | **多孩聚合一个端点**（照 openapi 骨架，扩出 `subjects[]`），前端孩子 Tab 本地切换 |
| 4 | 图表实现 | 引入 **recharts**；配色走 `style.md` 的 CSS 变量，不用默认色板 |
| 5 | 对话回放筛选 | **轨道 + 场景 + 时间 + 关键词**；不做学科筛选（`subject_id` 不可靠） |
| 6 | 关键词搜索范围 | **只搜会话标题** `ai_dialogues.title`，不搜消息正文 |
| 7 | `/reports/{reportId}` | **本期不实现，降级出 MVP**（不再有落库报告 ID） |
| 8 | 正确率口径 | 排除 `unanswered` 与 `self_assess`；自评单独出数 |
| 9 | 仪表盘 `unreadAlerts` | 保留字段，本期恒 0（等预警闭环后填） |
| 10 | `/parent/children-switch` | 冗余占位（顶栏已有 `StudentSwitcher`）→ **删除路由** |
| 11 | 模块落点 | 新建 `modules/parent-insights/`，与 `modules/points/` 同范式；聚合 SQL 进新 repo |
| 12 | 聚合实现方式 | 服务层分次查、JS 合成，**不写巨型 UNION SQL** |

---

## 4. 后端设计

### 4.1 模块结构

```
apps/server/src/modules/parent-insights/
  parent-insights.module.ts        imports:[ParentModule（requireOwnedStudent）, ProgressModule（getStarMap，
                                   已 exports: [ProgressService]）, ContentModule]
                                   providers（照构造函数逐个列出，不漏则 Nest 启动报「can't resolve dependencies」）：
                                     ParentInsightsController
                                     DashboardService / ReportService / ErrorsService / ChatLogsService
                                     ParentInsightsRepository
                                     + 各 service 注入的全部**本模块自用**既有仓储（StudentsRepository、
                                       SubjectsRepository、PracticeResultsRepository、ExamSessionsRepository、
                                       MainErrorBooksRepository、AiDialoguesRepository、AiMessagesRepository、
                                       QuestionSelfAssessmentsRepository 等）
  parent-insights.controller.ts    @Controller('api/parent') + @Roles('parent')
  dashboard.service.ts
  report.service.ts
  errors.service.ts
  chat-logs.service.ts
  parent-insights.repo.ts          本批新增的全部聚合 SQL
  *.test.ts
```

`ParentModule` 已 `exports: [ParentService]`（`parent.module.ts:23`），无需改动。`ParentInsightsModule` 在 `AppModule` 注册。

**归属校验铁律**：除 `dashboard`（按 `parentId` 查全部孩子）外，**每个 handler 第一行** `await this.parentService.requireOwnedStudent(parentId, studentId)`（复用 1002 不存在 / 1005 无权）。`chat-logs/:dialogueId` 还要二次校验 `dialogue.student_id === studentId`（底层 `AiDialoguesRepository.findById` 不带归属，不校验会 IDOR）。

### 4.2 端点契约（6 个）

所有响应按 `CommonResponse` 包装（`{ code, message, data }`）。以下只写 `data`。

---

**① `GET /api/parent/dashboard`** — 多孩聚合，一次给完

无 query 参数。

```jsonc
{
  "students": [
    {
      "studentId": 1,
      "name": "小明",
      "grade": "初一",
      "schoolLevel": "junior",
      "lastActiveAt": "2026-09-18T20:11:00.000Z",   // 多表时间并集 MAX，无记录为 null
      "activeDays7": 3,                              // 近 7 天有记录的天数
      "unreadAlerts": 0,                             // 本期恒 0，保留占位
      "subjects": [
        {
          "subjectId": 1,
          "subjectName": "数学",
          "progress": {
            "completedUnits": 2, "totalUnits": 8,
            "currentUnitName": "第二章 整式的加减",
            "currentLessonName": "2.1 整式",
            "percent": 25
          },
          "accuracy": { "answered": 42, "correct": 31, "rate": 73.8 },
          "selfAssessed": { "count": 5, "correctCount": 3 },
          "errorBook": { "uncleared": 12, "total": 20 },
          "examCount": 4
        }
      ]
    }
  ],
  "unreadAlerts": 0
}
```

- `subjects[]` 只包含**该学生已开始的学科**（未开始的学科不出现，避免一排空卡片）。
  **判定是 `progress.status <> 'not_started'`，不是「有 progress 行」**——家长在「学习配置」里配教材时就会为该学科建一行 `status='not_started'` 的 `progress`（`progress.repo.ts` 的 `createConfig`，注释即「首次为该学科创建配置行（未开始学习）」），`applyConfig(reset=true)` 也会把行重置回该状态。只看行存在会让仪表盘为「只配过教材」的学科渲染空卡片。
  另注：**不能改用 `started_at IS NOT NULL`** —— 真正开始学习的那条路径（`progress.repo.ts` 的 `create`）只写 `status='in_progress'`、不写 `started_at`，用它会把刚自动初始化的学科漏掉。
- `progress.percent` = `completedUnits / totalUnits * 100` 取整；`totalUnits` 为 0 时 `percent = 0`。
- 进度数据复用 `ProgressService.getStarMap`（`ProgressModule` 已 `exports: [ProgressService]`），**不改它的返回结构**——服务层从它现有的 `StarMapData` 里取：
  - `completedUnits` / `totalUnits` 直接用（顶层字段）
  - `currentUnitName` = `chapters.find(c => c.status === 'current')?.title`
  - `currentLessonName` = 同一个 chapter 里 `sections.find(s => s.status === 'current')?.title`
  - `percent` = `totalUnits > 0 ? Math.round(completedUnits / totalUnits * 100) : 0`（**不是** `StarMapData` 里的 `progress`，那个是「本章已完成的节占比」，语义不同，别拿错）
  - 注意 `ChapterData.id` / `SectionData.id` 是 **string**（`String(unit.id)`），本批对外字段里不暴露它们
- **性能提示**：`getStarMap` 内部对每个 unit 调一次 `contentService.getLessons()`（N+1）。实测 5 名学生 × 每人 1–2 个学科 × 每学科 8 个单元 ≈ 几十次查询，家庭级规模可接受；**不做批量优化**（要改 `ProgressService` 的签名，越界）。
- `accuracy` / `selfAssessed` / `errorBook` / `examCount` 均为**累计值，不限时间窗**（与报告页的窗口口径区分开）。
- `lastActiveAt` **只在孩子层级出现，学科卡片里没有**：按学科算「最近活跃」要再对四张表各查一次并加学科条件（成本 ×学科数），而家长真正关心的是「这个孩子最近在不在学」+「这门课学到哪了」——后者由 `progress` 已经表达。
- `lastActiveAt` = **不限时间窗**的 MAX；`activeDays7` = **近 7 天**内有记录的天数。两者窗口不同，必须分两次查，不能共用一个带时间条件的 SQL：

```sql
-- (a) lastActiveAt：不带时间条件
SELECT MAX(ts) AS last_active_at FROM (
  SELECT judged_at   AS ts FROM practice_results WHERE student_id = ?
  UNION ALL SELECT created_at  FROM point_ledger    WHERE student_id = ?
  UNION ALL SELECT submitted_at FROM exam_sessions  WHERE student_id = ? AND submitted_at IS NOT NULL
  UNION ALL SELECT m.created_at FROM ai_messages m
            JOIN ai_dialogues d ON d.id = m.dialogue_id
            WHERE d.student_id = ? AND m.deleted_at IS NULL
) t;

-- (b) activeDays7：带 7 天下界
SELECT COUNT(DISTINCT DATE(ts)) AS active_days FROM (
  SELECT judged_at   AS ts FROM practice_results WHERE student_id = ? AND judged_at >= ?
  UNION ALL SELECT created_at  FROM point_ledger    WHERE student_id = ? AND created_at >= ?
  UNION ALL SELECT submitted_at FROM exam_sessions  WHERE student_id = ? AND submitted_at IS NOT NULL AND submitted_at >= ?
  UNION ALL SELECT m.created_at FROM ai_messages m
            JOIN ai_dialogues d ON d.id = m.dialogue_id
            WHERE d.student_id = ? AND m.deleted_at IS NULL AND m.created_at >= ?
) t;
```

四条并集路径的理由：`point_ledger` 是唯一在**所有**轨道任务完成时都写一行的表（含语文/英语专项），光靠它 + `practice_results` + `exam_sessions` 会漏掉纯答疑活跃，故补 `ai_messages`。

---

**② `GET /api/parent/students/:studentId/reports`** — 实时聚合，不落库

| query | 取值 | 默认 |
|---|---|---|
| `period` | `weekly` \| `monthly` | `weekly` |

`weekly` → 时间窗 = 今天往前 7 天（含今天）；`monthly` → 30 天。返回 `windowStart` / `windowEnd` 让前端显示区间。

```jsonc
{
  "studentId": 1,
  "period": "weekly",
  "windowStart": "2026-09-12",
  "windowEnd": "2026-09-18",
  "stats": {
    "activeDays": 3, "answered": 42, "correct": 31, "rate": 73.8,
    "selfAssessCount": 5, "errorsAdded": 6, "errorsCleared": 4, "examCount": 2
  },
  "trend": [ { "date": "2026-09-15", "answered": 10, "correct": 7, "rate": 70.0 } ],
  "subjects": [ { "subjectId": 1, "subjectName": "数学", "answered": 42, "correct": 31, "rate": 73.8 } ],
  "weakPoints": [ { "knowledgePointId": 42, "name": "分数加减", "unclearedCount": 3, "totalWrongCount": 5 } ],
  "weakPointsUncoveredCount": 8,
  "exams": [ { "sessionId": 7, "paperTitle": "2025 学年七年级上期中", "subjectName": "数学",
               "submittedAt": "2026-09-16T19:20:00.000Z", "correctCount": 18, "objectiveCount": 22, "rate": 81.8 } ]
}
```

- `trend` 只含**有记录的天**，不做补零；前端折线自己按 `windowStart..windowEnd` 铺 X 轴。每条 `trend[i]` 内部也是 `practice_results` + `exam_answers` 两源合并（口径同 §4.3），按 `DATE(judged_at)` 分组。
- `stats` 各字段的窗口口径（`windowStart` 与 `windowEnd` 都是**日期**，SQL 上用 `>= windowStart 00:00` 与 `< windowEnd + 1 天 00:00` 表达闭区间）：
  - `activeDays` / `answered` / `correct` / `rate` / `selfAssessCount`：judged 时间落窗
  - `errorsAdded`：`main_error_books.created_at` 落窗
  - `errorsCleared`：`main_error_books.cleared_at` 落窗（`is_cleared = 1`）
  - `examCount`：`exam_sessions.submitted_at` 落窗且 `status='submitted'`
- `weakPoints` Top 10，按 `unclearedCount` 降序、`totalWrongCount` 次之。统计的是**全部未清零错题**（不限于窗口），因为「现在还剩哪些没清」才是家长关心的；`weakPointsUncoveredCount` = 同样范围内**映射不到任何知识点**的未清零错题数（实测整体占 60%），前端必须显式提示口径。
- `exams` 只含 `status='submitted'` 的场次，按 `submitted_at` 降序，最多 20 场（不限窗口，让家长看到全部考试史）。

**契约变更**：openapi 的 `LearningReport` / `ReportContent`（`summary/strengths/weaknesses/suggestions` 的 AI 文本形状）**作废**，替换为上述结构；`GET /parent/students/{studentId}/reports/{reportId}` **从 openapi 与 API 文档中删除**（不再有落库报告 ID）。

---

**③ `GET /api/parent/students/:studentId/errors`**

| query | 取值 | 默认 |
|---|---|---|
| `subject` | subjectId | 全部 |
| `source` | `practice`\|`discuss`\|`exam`\|`targeted`\|`error_practice`\|`auxiliary` | 全部 |
| `track` | `main` \| `aux` | 全部 |
| `cleared` | `uncleared` \| `cleared` \| `all` | `all` |
| `from` / `to` | `YYYY-MM-DD`（按 `created_at`） | 不限 |
| `page` | ≥1 | 1 |

> **`pageSize` 由服务端固定为 20，前端不传**（沿用家长端既有约定，见 `RedemptionHistoryPanel.tsx:19-22`）。响应里回显 `pageSize`，前端用 `page` 对不上就不渲染（防页码与新内容错配）。
>
> `page` **复用 `modules/points/pagination.util.ts` 的 `parsePositiveInt`**：非法（`abc` / `1.5` / `-1` / 空）一律 **400 / 1001**，**不静默回落**——与 `points` 的流水分页同一口径。

```jsonc
{
  "items": [
    {
      "id": 91, "questionId": 330, "track": "main", "source": "exam",
      "level": 2, "isCleared": false,
      "wrongAnswerText": "x=3",
      "createdAt": "2026-09-16T19:21:00.000Z",
      "clearedAt": null,
      "question": {
        "content": "…", "type": "calculation", "difficulty": 3,
        "knowledgePoints": [ { "id": 42, "name": "分数加减" } ]   // 可为空数组
      }
    }
  ],
  "page": 1, "pageSize": 20, "total": 139
}
```

- `track` 映射（服务层计算，不落库）：`source = 'auxiliary'` → `'aux'`，其余四个值 → `'main'`。
- `track` 筛选在**服务层映射后过滤**（先按 `source` 限定：`aux` → `source='auxiliary'`；`main` → `source <> 'auxiliary'`），下推到 SQL，避免全量取出再过滤。
- **复用但不改** `MainErrorBooksRepository.findErrorBookEntries`（已支持 `from/to/type/kpId`）：家长侧需要 `source` / `cleared` / `track` / 分页 / `total`，且这个共享方法正被训练轨的错题练习调用——**改它会动训练轨行为**。因此家长侧查询在 `parent-insights.repo.ts` 里自建（JOIN 与筛选写法照它抄），既有 repo 一行不动。
- `question_id IS NULL` 的错题（仅存题面）也返回，`question` 字段为 `null`，前端显示 `wrongAnswerText`。
- 排序：`created_at DESC, id DESC`。

---

**④ `GET /api/parent/students/:studentId/chat-logs`**

| query | 取值 | 默认 |
|---|---|---|
| `track` | `mainline` \| `auxiliary` | 全部 |
| `scene` | `aux_qna`\|`aux_training`\|`mainline_question`\|`mainline_card` | 全部 |
| `from` / `to` | `YYYY-MM-DD`（按 `updated_at`） | 不限 |
| `q` | 关键词，**只匹配 `title`**，`LIKE %q%` | 不限 |
| `page` | ≥1 | 1 |

> `pageSize` 同上，服务端固定 20。

```jsonc
{
  "items": [
    { "id": 55, "track": "auxiliary", "scene": "aux_qna", "title": "二次函数求最值",
      "subjectId": null, "createdAt": "…", "updatedAt": "…",
      "messageCount": 8, "blockCount": 2 }
  ],
  "page": 1, "pageSize": 20, "total": 80
}
```

- `messageCount` / `blockCount`（`safety_flag=1` 的消息数）由一条 JOIN 聚合子查询带出，避免 N+1。
- 只查 `deleted_at IS NULL` 的会话与消息。
- 排序：`updated_at DESC, id DESC`。

---

**⑤ `GET /api/parent/students/:studentId/chat-logs/:dialogueId`**

```jsonc
{
  "id": 55, "track": "auxiliary", "scene": "aux_qna", "title": "二次函数求最值",
  "subjectId": null, "createdAt": "…", "updatedAt": "…",
  "messages": [
    { "id": 201, "role": "user",      "content": "…", "reasoning": null,
      "type": null, "model": null, "safetyFlag": 0, "createdAt": "…" },
    { "id": 202, "role": "assistant", "content": "…", "reasoning": "先判断开口方向…",
      "type": "socratic", "model": "qwen3.8-max", "safetyFlag": 0, "createdAt": "…" },
    { "id": 203, "role": "assistant", "content": "我是你的学习助手，这个话题课后…",
      "reasoning": null, "type": "block", "model": "qwen3.8-max", "safetyFlag": 1, "createdAt": "…" }
  ]
}
```

- 返回 `reasoning`（AI 思考链，字段已有但不回传给家长端历史前——本批明确返回，供「看 AI 怎么想的」）。前端默认折叠。
- 不返回 `token_input` / `token_output` / `response_time_ms`（恒 NULL，返回只会误导）。
- 二次归属校验：`dialogue.student_id !== studentId` → 404/1002。

---

**⑥ 不新增单孩 dashboard 端点**（定案 #3）。

### 4.3 正确率口径（唯一实现，勿分散）

`ParentInsightsRepository.getAccuracyBySubject(studentId, from?, to?)` 合并两个来源：

```sql
SELECT subject_id, SUM(correct) AS correct, SUM(total) AS answered FROM (
  SELECT subject_id, SUM(is_correct = 1) AS correct, COUNT(*) AS total
  FROM practice_results
  WHERE student_id = ? AND method IN ('exact','ai')      -- 排除 unanswered / self_assess
    AND judged_at >= ? AND judged_at < ?
  GROUP BY subject_id
  UNION ALL
  SELECT es.subject_id, SUM(ea.is_correct = 1), COUNT(*)
  FROM exam_sessions es JOIN exam_answers ea ON ea.session_id = es.id
  WHERE es.student_id = ? AND es.status = 'submitted' AND ea.is_correct IS NOT NULL
    AND ea.judged_at >= ? AND ea.judged_at < ?
  GROUP BY es.subject_id
) t GROUP BY subject_id
```

`rate` = `correct / answered * 100` 保留一位小数；`answered = 0` 时 `rate = null`（不是 0，避免「0% 正确率」的误读）。

**窗口可选**：仪表盘走「累计」（`from`/`to` 均不传时，两个源都**去掉** `judged_at` 条件）；报告页走窗口（传 `from`/`to`）。同一方法一套 SQL，按参数拼接条件——**不要写两份**，否则口径必然分叉。

自评数据（`question_self_assessments`）单独查 `count` / `correctCount`，**不进 rate**。

---

## 5. 前端设计

### 5.1 页面

| 路由 | 文件 | 内容 |
|---|---|---|
| `/parent/dashboard` | `pages/parent/ParentDashboardPage.tsx` | 孩子 Tab（多孩时才显示）+ 每个孩子一张「概览条」（近 7 天活跃 N 天 / 最近活跃 / 未清零错题）+ 学科卡片网格 + 快捷入口（跳报告/错题/回放，带上当前孩子锚点） |
| `/parent/report` | `pages/parent/ParentReportPage.tsx` | 顶部孩子锚点提示 + 周/月切换 + stats 数字卡 + `trend` 折线 + `subjects` 柱状 + `weakPoints` 列表（含「另有 N 道错题未标注知识点」提示）+ `exams` 表格 |
| `/parent/errors` | `pages/parent/ParentErrorsPage.tsx` | 主线/辅线 Tab + 学科/来源/清零状态/时间筛选 + 分页表格 + 行展开看题干与知识点 + `question === null` 时只显示 `wrongAnswerText` |
| `/parent/chat-logs` | `pages/parent/ParentChatLogsPage.tsx` | 左会话列表（轨道/场景/时间/关键词筛选 + 分页）+ 右详情（逐句、`reasoning` 折叠、`safetyFlag=1` 红色标记「闲聊/偏离学习」） |

### 5.2 复用与新增

- 新增 `services/api.ts` 6 个方法 + 对应类型定义（与 openapi 同步）。
- **复用基座组件**（`apps/web/src/components/base/`，实有：`BackButton` / `Banner` / `Button` / `Card` / `ConfirmDialog` / `Input` / `LevelIcon` / `LogoutButton` / `Modal` / `PageHeader` / `Progress` / `Skeleton` / `Tag` / `Toast`）：四页统一用 `Card` + `PageHeader` + `Skeleton`（加载态）+ `Tag`（轨道/来源标签）+ `Banner`（报告页的「未标注知识点」口径提示）。
- **新增 `components/base/Pagination.tsx`**：「上一页 / 第 N / M 页 / 下一页」三件套。现在家长端已有 3 处需要分页（兑换记录 + 错题 + 回放），抽出来值当。
  - **`RedemptionHistoryPanel.tsx` 本批不动** —— 它已被测试覆盖，改它属于无关重构，风险大于收益；它的「自报家门」守卫逻辑在本批两个新页面里照搬。
- 家长端配色走 `data-theme="parent"`（`ParentLayout` 已写死，无日夜切换）。
- 空态：四页各自给空态文案（如报告页「本期还没有学习记录」），不用装饰元素、不加 emoji。

### 5.3 图表（recharts）

- 新增依赖 `recharts`（`apps/web/package.json`）。
- **必须覆盖的默认样式**：坐标轴线/刻度颜色、`tooltip` 容器、字体族、折线/柱状配色 —— 全部取自 CSS 变量（家长主题值见 `apps/web/src/styles/global.css` 的 `[data-theme='parent']` 段），**不使用 recharts 默认色板**。
- **取色坑**：CSS 变量不能直接当数值传给图表库，必须在挂载后经 `getComputedStyle` 读；而**家长页的变量定义在 `[data-theme="parent"]` 容器上、不在 `:root`**——从 `document.documentElement` 读到的是学生端日间值（brand = `#ff6b35` 橙色），会画错色。必须从 `document.querySelector('[data-theme="parent"]')`（或元素的 `closest('[data-theme]')`）读。
- **禁止装饰元素**：不加渐变填充、不加雷达图的网格装饰、不用饼图。只做折线（trend）+ 柱状（subjects）+ 数字卡。
- 响应式：容器 `ResponsiveContainer`，主断点 1024px / 1280px（照 `style.md` §7）。
- 组件要包一层薄封装：新建 `components/business/parent/`（与既有的 `answer/` `dictation/` `interpretation/` `meaning/` `vocabulary/` 同约定）放 `ChartLine.tsx` / `ChartBar.tsx`，让页面不直接依赖 recharts API —— 也便于补渲染测试。

---

## 6. 错误处理

| 场景 | 行为 |
|---|---|
| 非 parent 角色 | 403 / 1005（`RolesGuard`，既有） |
| `studentId` 不存在（或已软删） | 404 / 1002（`requireOwnedStudent` 的第一段，既有） |
| `studentId` 存在但属于**别的家长** | **403 / 1005**（`requireOwnedStudent` 的第二段，既有）。⚠️ **不是 404** —— 别照抄「不泄漏存在性」那句，本仓 `requireOwnedStudent` 对这两种情况给的是**不同**的码 |
| `dialogueId` 不是该学生的会话 | 404 / 1002（`ChatLogsService` 的二次校验）。这里用 1002 是刻意的：学生归属已由 `requireOwnedStudent` 验过，此处等价于「资源不存在」 |
| 无数据 | **200 + 空数组 / `rate: null`**，不是 404 |
| `page` 合法但超出末页 | **200 + 空 `items` + 正确 `total`**（不报 404，前端按空列表处理） |
| `period` 非法值 | 归一化为 `weekly` |
| `page` 非法（`abc` / `1.5` / `-1` / 空串以外空格） | **400 / 1001**，复用 `parsePositiveInt`（`modules/points/pagination.util.ts`），**不静默回落** |
| `from` / `to` 非法日期 | 忽略该筛选（不报错），并在响应中不体现 |
| 学生已停用（`is_active=0`） | **仍可查**（家长看历史数据是正当需求） |

---

## 7. 文档同步（硬规则，与本批同一次提交完成）

| 文档 | 改什么 |
|---|---|
| `docs/api/openapi.yaml` | ① `Dashboard` 扩出 `students[].subjects[]` 与 `activeDays7` / `lastActiveAt`，去掉 `todayStudyMinutes`；② `LearningReport`/`ReportContent` 替换为新结构，删除 `/parent/students/{studentId}/reports/{reportId}`；③ `errors` 加 7 个 query（subject/source/track/cleared/from/to/page）+ 分页壳；④ `chat-logs` 加 5 个 query（track/scene/from/to/q/page）+ 分页壳；⑤ `ErrorItem.track` 与 `source` enum 按实际 5 值修正；⑥ 补 `ChatLogItem` / `ChatLogDetail` 与分页壳 schema |
| `docs/API接口与数据流设计文档.md` | §4.13 端点表更新（删 `{reportId}`、改阶段列、改语义）；§6.8 数据流**重写**（不再是「`/api/ai/report` → 落 `learning_reports` → 展示」，改为「请求 → 服务层聚合 → 直接返回」） |
| `docs/UX-UI设计文档.md` | P6.1「今日学习时长」→「近 7 天活跃天数 + 最近活跃」；P6.2「学习时长曲线 / 薄弱点雷达图」→「答题量趋势 / 错题知识点 Top」并注明代理口径；P6.4 筛选改「轨道/场景/时间/关键词」并注明学科不可用 |
| `docs/K12智学系统-产品需求文档.md` | §7.7 首条「学习时长」标注为后续迭代（与本次口径一致）；其余不动 |
| `docs/ai-core-changelog.md` | 追加本批条目（含 §2.3 实测数据与「40% 知识点覆盖率」这一遗留风险） |
| `CLAUDE.md` | 若本批引入新的硬约束（如「报告为实时聚合，勿落 learning_reports」），追加一句 |

**检查清单**：提交前核对 openapi 与 API 文档的端点路径列表一致（父路径 + 方法逐一比对）。

---

## 8. 测试

**后端**（`apps/server/src/modules/parent-insights/*.test.ts`）：

1. `dashboard.service`：多孩 × 多学科编排；无 `progress` 行的学科不出卡片；`percent` 边界（`totalUnits = 0`）。
2. `report.service`：`period` 归一化；`trend` 不补零；`weakPoints` Top 10 排序与 `uncoveredCount` 计算；`rate = null`（`answered = 0`）。
3. `errors.service`：`track` 映射（`auxiliary → aux`，其余 → `main`）；`track` 筛选下推到 `source` 条件；`page` 非法 → 400/1001、`page` 超末页 → 空 `items` + 正确 `total`；`question_id IS NULL` 的行不炸。
4. `chat-logs.service`：`messageCount` / `blockCount` 聚合正确；`q` 只匹配 title；`dialogueId` 跨学生 → 1002。
5. `parent-insights.repo`：正确率合并口径（排除 `unanswered`/`self_assess`；`exam_answers` 排除 `is_correct IS NULL`）—— 这是本批最容易被「统一」掉的口径，用测试钉死。
6. 归属校验：四个域各一条「别人的孩子 → 404/1002」。

**前端**（硬规则「组件改动必须补渲染测试」，且 admin 前端零测试是反面教材）：

7. 四个页面各一条渲染测试（mock api）：正常数据 / 空数据 / `rate: null` 三种。
8. `ChartLine` / `ChartBar` 薄封装各一条。
9. 回放页：`safetyFlag=1` 渲染出红色标记。
10. 错题页：`question === null` 分支不崩。

**契约**：

11. `services/api.test.ts` 补 6 个方法的存在性与路径断言（与 openapi 对齐）。

---

## 9. 已知限制（本期留下、需在 changelog 记明）

1. **知识点覆盖率只有 40%**（实测 55/139）→ 薄弱点列表会漏 60% 的错题，靠 `weakPointsUncoveredCount` + UI 提示兜住。根治要等题库补绑 KP。
2. **`activeDays7` 是活跃度代理，不是时长**。孩子挂机不答题 = 不活跃，与「学习时长」语义有偏差。
3. **`practice_results` 是 upsert 覆盖式最新态，不是 attempt 历史** → 「进步曲线」实际是「按判题时间分布的当前态」，随时间推移早期数据点会被覆盖而减少。
4. **`ai_dialogues.subject_id` 76% 为 NULL** → 回放页不提供学科筛选；若将来补写 `subject_id`，可再加。
5. **`unreadAlerts` 恒 0**（`safety_alerts` 无写入）。
6. **关键词只搜会话标题**，搜不到消息正文里的关键词。
7. `weakPoints` 依赖 `question_knowledge_points`，其绑定目前完全靠 DB migration 灌入（`QuestionsRepository.bindKnowledgePoint` 无调用方）。
8. 列表分页为**页码式**（非游标）、`pageSize` 固定 20，数据量大时深分页会慢；本期家庭级数据量下无影响。
9. **日期分桶依赖服务器时区**：`DATE(judged_at)` 的分桶（`trend`）与时间窗边界（`window.util`）都按**服务器本地时区**算——`database/connection.ts` 既没设 `dateStrings` 也没设 `timezone`。部署到 UTC 容器时，UTC+8 用户晚间 20:00 之后的作答会被分到「前一天」。本期**不做**用户级时区处理；投产前必须确认服务器时区 = 用户时区（Asia/Shanghai）。同类坑：mysql2 把 `DATE(...)` 返回为**本地零点**的 `Date`，把它 `toISOString()` 会跨时区差一天——仓储侧已改用本地字段拼 `YYYY-MM-DD`。
10. **「新进错题本」≠「本周答错的题」**：`errorsAdded` 数的是窗口内 `main_error_books.created_at`，而错题重做再次做错只走 `bumpLevels` 更新原行、不新增行。文案已按此改为「新进错题本」。
11. **薄弱点数不可当覆盖率**：一个题可绑多个知识点（`question_knowledge_points` 的 UNIQUE 是「题×KP」），所以 `sum(unclearedCount)` 会大于「未清零错题总数」，**不能**用它与 `weakPointsUncoveredCount` 推覆盖率或「已覆盖」数。
12. **趋势折线的 X 轴只含有记录的天，没有按窗口补零**：`trend` 与 `ChartLine` 都是「有几个点画几个点」，所以相隔 5 天的两次记录在图上会**相邻**显示，`MM-DD` 标签之间看不出间隔。spec §4.2 ② 原意是「前端按 `windowStart..windowEnd` 铺 X 轴」，实际未做——要做得先让 `ChartPoint.value` 允许 `null` 并把 recharts 的 `connectNulls` 关掉（否则会画出「当天 0 分」的假数据）。本期接受这个观感折中。
13. **柱状图的 X 轴标签把正确率写进了刻度文字**（形如「数学 73.8%」）：学科多于 4~5 个时刻度可能挤。本期接受；要改就把正确率挪到图表下方的文字行。
14. **`attachments` 不回传 → 拍照解题的图片在家长回放里不可见**：`ParentChatLogMessage` 是白名单映射，刻意不返回消息的 `attachments`（拍照解题留下的图片 JSON）。这与 PRD §7.7「全透明回放…全面掌握孩子的思考路径」存在张力；本期按**明确不做**处理（要做需前端一并处理图片 URL 与过期），需产品裁决是否后续补。
