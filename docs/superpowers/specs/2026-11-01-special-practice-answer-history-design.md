# 专项练习作答历史 — 设计 spec

**日期**：2026-11-01
**主题**：记录学生每次专项练习/考试的逐题作答，学生端可查看历史；家长端薄弱点分析留二期
**状态**：设计已与用户确认，待写实施计划

---

## 1. 背景与目标

### 1.1 用户需求
孩子做过的每套卷子（含考试与专项练习）的逐题作答都要有记录：
- 孩子能自己查看曾做过的题（每道题这次选了什么、对不对、正确答案、解析）
- 家长能了解孩子哪些知识点掌握不够好（**二期**，本期只做学生端 + 数据落库）

### 1.2 现状（已实测，2026-11-01）
| 场景 | 作答落库现状 | 学生端查看入口 |
|---|---|---|
| 考试（exam_sessions） | `exam_answers` 完整存每题答案+判题快照（upsert by session+question） | **无列表入口**，只有交卷后 `ExamResultPage` 直链，刷新即丢 |
| 语文默写/解释/含义专项 | `special_practice_logs` 有 `session_uid`(UUID) + 对错 verdict，**不存答案原文** | 无 |
| 英语背词专项 | 同上（`special_practice_logs`） | 无 |
| 数学薄弱点训练 | `practice_results` upsert 覆盖（只留最新），`training_sessions` 只服务发分 | 无 |
| 物理/化学训练 | `practice_results` upsert 覆盖 | 无 |
| 错题本（main_error_books） | `wrong_answer_text` 恒为 null（`judge-core.service.ts:732`），**不存学生作答** | 家长端有，学生端无 |

**结论**：只有考试模块完整落库学生作答原文；专项练习作答基本不留痕。学生端无任何"我的作答/历史"页面入口。

### 1.3 一期目标
1. **数据落库**：六学科（数学/语文/英语/物理/化学/道法）的专项练习逐题作答完整存档（含答案原文）
2. **学生端查看入口**：个人中心顶栏加"练习记录"胶囊，列表页 + 详情页
3. **考试历史也补列表入口**：现有 `exam_answers` 数据自动出现在列表里（UNION 查询）

### 1.4 二期范围（边界，本期不做）
- 家长端逐卷作答查看（`GET /api/parent/students/:id/practice-history` + 详情）
- 家长端薄弱点汇总：
  - 数学/语文/物理：KP 维度，口径从"未清零错题数"升级为"作答正确率"
  - 化学/道法：卷子维度（不补 KP 树）
  - 英语：除外（词汇子系统另有掌握度机制）

---

## 2. 关键设计决策（已与用户确认）

| # | 决策 | 理由 |
|---|---|---|
| 1 | 覆盖范围 = 考试 + 专项练习（六学科） | 用户选；主线闯关不含（散题、与错题本重叠） |
| 2 | 作答粒度 = session 粒度（session 内每题留最新，重做不同 session 都显示） | 与 `exam_answers` 一致；同一套卷子做两次 = 两个 session = 两条记录 |
| 3 | 表方案 = 方案 C：考试继续用 `exam_answers`（不动），专项新建 `special_practice_sessions` + `special_answer_records`（与 exam 对称），查询层 UNION ALL | 不动稳定运行的表，风险最低 |
| 4 | 语文专项 `question_id` 可空 + `ref_type`/`ref_id`/`sentence_index` 三列辅助定位 | 与 `special_practice_logs` 口径一致，最小改动 |
| 5 | 学生端入口 = 个人中心顶栏第三胶囊（与奖励册/个人中心并列） | 浅停留页，写死 `data-theme="student-day"` |
| 6 | 详情页不加"再做一遍"按钮 | 一期纯只读历史，避免与错题本/训练轨入口混淆 |
| 7 | `sessionUid` 可选 + 惰性建会话 | 向后兼容，不带也能判题（现有测试不破坏） |
| 8 | 写入失败不阻断判题 | 与 `special_practice_logs` 现口径一致 |

---

## 3. 数据模型

### 3.1 新建表：`special_practice_sessions`（专项练习会话，对应 `exam_sessions`）

```sql
-- 专项练习会话（与 exam_sessions 对称，但无 paper_id/deadline_at —— 专项不限时、临时抽题）
CREATE TABLE IF NOT EXISTS special_practice_sessions (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_uid    CHAR(36)     NOT NULL,              -- 与 special_practice_logs.session_uid 对齐，便于关联现有流水
  student_id     BIGINT       NOT NULL,
  subject_id     BIGINT       NOT NULL,
  module         VARCHAR(32)  NOT NULL,              -- chinese_dictation|chinese_interpretation|chinese_meaning|en_vocabulary|math_targeted|physics_targeted|chemistry_targeted
  title          VARCHAR(120) DEFAULT NULL,           -- 展示用标题（如"默写专项·静夜思"或"数学薄弱点训练"）
  question_count SMALLINT     NOT NULL DEFAULT 0,    -- 本次题数（开练时写入，用于列表"对x/y"的分母）
  started_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at   DATETIME(3)  DEFAULT NULL,           -- NULL=进行中；非空=已完成（前端可在离开时调端点标记）
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_sps_uid (session_uid),
  KEY idx_sps_student_time (student_id, started_at),
  CONSTRAINT fk_sps_student FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### 3.2 新建表：`special_answer_records`（专项练习逐题作答，对应 `exam_answers`）

```sql
-- 专项练习逐题作答（与 exam_answers 同构，但 question_id 可空 —— 语文专项的"题"是 passage+sentence）
CREATE TABLE IF NOT EXISTS special_answer_records (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id      BIGINT      NOT NULL,              -- 关联 special_practice_sessions.id（不是 session_uid）
  question_id     BIGINT      DEFAULT NULL,           -- 数学/物理/化学训练非空；语文三专项/英语背词为 NULL
  ref_type        VARCHAR(24) DEFAULT NULL,           -- question|passage|word（question_id 非空时本列冗余可空；为空时本列必填）
  ref_id          BIGINT      DEFAULT NULL,           -- passage_id / word_id；question_id 非空时本列可空
  sentence_index  SMALLINT    DEFAULT NULL,           -- 解释/含义专项逐句；默写/背词/数学为 NULL
  question_order  SMALLINT    NOT NULL,              -- 本次第几题（从 1 起）
  answer_text     TEXT,                               -- 学生答案原文（关键！现在没存）
  is_correct      TINYINT(1)  DEFAULT NULL,           -- NULL=在途/未判；1=对 0=错
  score           DECIMAL(3,2) DEFAULT NULL,           -- 客观题得分比例（1/0.5/0）；主观题 NULL
  method          VARCHAR(20) DEFAULT NULL,           -- exact|ai|self_assess|unanswered|failed
  analysis        TEXT,                               -- 解析（与 exam_answers.analysis 同口径）
  judged_at       DATETIME(3) DEFAULT NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_sar_session_q (session_id, question_id),   -- 同 session 同题 upsert（与 exam_answers 一致）
  KEY idx_sar_session (session_id),
  KEY idx_sar_student_question (question_id),
  CONSTRAINT fk_sar_session FOREIGN KEY (session_id) REFERENCES special_practice_sessions (id) ON DELETE CASCADE,
  CONSTRAINT fk_sar_question FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**注意**：`uniq_sar_session_q` 唯键在 `question_id` 为 NULL 时**不生效**（MySQL 唯一键对 NULL 不去重）。语文专项同一 session 同一句若重判多次会产生多行 —— 这是可接受的（查询时取最新一行，按 `judged_at DESC` 取）。若要严格 upsert，语文专项写入时先 `DELETE WHERE session_id=? AND ref_type=? AND ref_id=? AND sentence_index=?` 再 INSERT。

### 3.3 与 `exam_answers` 的关系
- **不动 `exam_answers`**：考试模块继续用它，稳定运行的表不碰
- **查询层 UNION ALL**：学生端列表查询把 `exam_sessions` 与 `special_practice_sessions` 合并返回
- **schema 对称**：`special_practice_sessions` ↔ `exam_sessions`，`special_answer_records` ↔ `exam_answers`，前端/后端逻辑可复用

### 3.4 schema 同步
- 两张新表进 `tools/db/schema.sql`
- 幂等迁移：`tools/db/migrations/2026-11-01_special_practice_sessions_and_answers.sql`（`CREATE TABLE IF NOT EXISTS`）
- 收尾跑 `python3 tools/db/schema_reconcile.py` 对账（CLAUDE.md 铁律）

---

## 4. 后端设计

### 4.1 写入路径：5 个判题端点补写 `special_answer_records`

#### 4.1.1 通用机制：`sessionUid` 可选 + 惰性建会话

**DTO 变更**：5 个判题端点的 DTO 增加可选字段 `sessionUid?: string`（UUID v4）+ 可选 `title?: string` + 可选 `questionCount?: number` + 可选 `questionOrder?: number`。

**惰性建会话**：后端收到判题请求时，若 `sessionUid` 非空：
1. `INSERT IGNORE INTO special_practice_sessions (session_uid, student_id, subject_id, module, title, question_count, started_at) VALUES (...)` —— 首次判题时建会话行，后续判题命中已存在行（`uniq_sps_uid` 去重）
2. `INSERT INTO special_answer_records (...) ON DUPLICATE KEY UPDATE answer_text=..., is_correct=..., score=..., method=..., analysis=..., judged_at=...` —— upsert 作答行

**`sessionUid` 缺失**：不带也能判题，**不写作答记录**，但不报错（向后兼容，现有测试不破坏）。

**写入失败**：`try/catch` 吞异常只 `logger.warn`，判题结果照常返回（与 `special_practice_logs` 现口径一致，见 `training.service.ts:283`）。

#### 4.1.2 各端点改造明细

| 端点 | service 方法 | 写入字段（special_answer_records） |
|---|---|---|
| `POST /api/training/judge`（数学/物理/化学 targeted） | `training.service.judgeTraining` | `question_id=dto.questionId`, `ref_type='question'`, `answer_text=dto.studentAnswer`, `is_correct`/`method` 取判题结果 |
| `POST /api/training/dictation/judge`（语文默写） | `training.service.judgeDictation` | `question_id=NULL`, `ref_type='passage'`, `ref_id=dto.passageId`, `answer_text=JSON({author,dynasty,body})`, `is_correct` 取判题结果 |
| `POST /api/training/interpretation/judge`（语文解释） | `training.service.judgeInterpretation` | `question_id=NULL`, `ref_type='passage'`, `ref_id=dto.passageId`, `sentence_index=dto.sentenceIndex`, `answer_text=JSON({terms,translation})`, `is_correct` 取判题结果 |
| 含义专项判题 | `meaning.service` | 同解释专项（`ref_type='passage'`, `ref_id`, `sentence_index`） |
| 英语背词判题 | `vocabulary.service` | `question_id=NULL`, `ref_type='word'`, `ref_id=dto.wordId`, `answer_text=dto.studentAnswer`, `is_correct` 取判题结果 |

**`answer_text` 格式约定**：
- 数学/物理/化学：原样存字符串（`"B"` / `"42"` / 解题步骤文本）
- 语文默写：JSON 序列化 `{author, dynasty, body}`
- 语文解释/含义：JSON 序列化 `{terms:[{term,answer}], translation}` 或含义专项的字段
- 英语背词：原样存字符串

**`module` 字段值**（与 `special_practice_logs.module` 列注释逐字一致 + 扩展）：
`chinese_dictation | chinese_interpretation | chinese_meaning | en_vocabulary | math_targeted | physics_targeted | chemistry_targeted`

**`module` 与判题端点的映射**（`training.service.judgeTraining` 按 `subjectId` 决定 module）：
| subjectId | module |
|---|---|
| 1（数学） | `math_targeted` |
| 4（物理） | `physics_targeted` |
| 5（化学） | `chemistry_targeted` |

其余四个判题方法（dictation/interpretation/meaning/vocabulary）的 module 固定，不依赖 subjectId。

#### 4.1.3 写入实现位置
- **不改 controller 结构**（DTO 加字段，service 内补写）
- 新建 `apps/server/src/database/repositories/special-practice-sessions.repo.ts`（`upsertSession(uid, studentId, subjectId, module, title, questionCount)`）
- 新建 `apps/server/src/database/repositories/special-answer-records.repo.ts`（`upsertAnswer(sessionId, fields...)` + `upsertSpecialAnswer` 处理语文 question_id 为空的先 DELETE 后 INSERT）
- **4 个 service 文件**（含 5 个判题方法）各注入这两个 repo（`@Optional()` 防 DI 坑，见 CLAUDE.md）：
  - `training.service.ts`（judgeTraining / judgeDictation / judgeInterpretation 三个方法）
  - `meaning.service.ts`（含义专项）
  - `vocabulary.service.ts`（英语背词）

### 4.2 查询端点：新建 `practice-history` 模块

#### 4.2.1 `GET /api/student/practice-history`（列表）

**Query 参数**：
| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `page` | number | 否 | 默认 1 |
| `pageSize` | number | 否 | 默认 20，上限 50 |
| `subjectId` | number | 否 | 学科筛选，不传=全部 |

**逻辑**：
1. `page`/`pageSize` 兜底校验（非整数给默认值，超限给上限）
2. UNION ALL 查询：
   ```sql
   SELECT 'exam' AS source, es.id AS session_id, es.student_id, es.subject_id,
          ep.title AS title, es.started_at, es.submitted_at AS completed_at,
          NULL AS module
     FROM exam_sessions es JOIN exam_papers ep ON es.paper_id = ep.id
    WHERE es.student_id = ? AND es.status = 'submitted'
   UNION ALL
   SELECT 'special' AS source, sps.id AS session_id, sps.student_id, sps.subject_id,
          sps.title, sps.started_at, sps.completed_at, sps.module
     FROM special_practice_sessions sps
    WHERE sps.student_id = ?
   ORDER BY started_at DESC
   LIMIT ? OFFSET ?;
   ```
   （`subjectId` 非空时两段都加 `AND subject_id = ?`）
3. 对每个 session 聚合对错数（子查询或二次查询）：
   - exam: `SELECT COUNT(*) total, SUM(is_correct=1) correct FROM exam_answers WHERE session_id=?`
   - special: `SELECT COUNT(*) total, SUM(is_correct=1) correct FROM special_answer_records WHERE session_id=?`
4. 总数查询（用于分页）：`SELECT SUM(cnt) FROM (SELECT COUNT(*) cnt FROM exam_sessions WHERE student_id=? [AND subject_id=?] UNION ALL SELECT COUNT(*) FROM special_practice_sessions WHERE student_id=? [AND subject_id=?]) t`

**返回形状**：
```json
{
  "code": 0,
  "data": {
    "items": [
      {
        "source": "exam",
        "sessionId": 101,
        "subjectId": 4,
        "title": "北师大物理实验卷",
        "module": null,
        "startedAt": "2026-11-01T14:00:00.000Z",
        "completedAt": "2026-11-01T14:40:00.000Z",
        "totalCount": 10,
        "correctCount": 7
      }
    ],
    "total": 42,
    "page": 1,
    "pageSize": 20
  }
}
```

**错误码**：
- 401：未登录（JWT 中间件）
- 无 400（参数全兜底）

#### 4.2.2 `GET /api/student/practice-history/:source/:sessionId`（详情）

**Path 参数**：
| 参数 | 类型 | 说明 |
|---|---|---|
| `source` | string | `exam` 或 `special` |
| `sessionId` | number | session id |

**逻辑**：
1. `source` 校验：只允许 `exam`/`special`，否则 400
2. `sessionId` 正整数校验，否则 400
3. 按 `source` 路由：
   - `exam`：`SELECT * FROM exam_sessions WHERE id=? AND student_id=?`（归属校验，找不到返 404）
     然后 `SELECT ea.*, q.content, q.answer, q.analysis AS question_analysis FROM exam_answers ea JOIN questions q ON ea.question_id=q.id WHERE ea.session_id=? ORDER BY ea.question_order`
   - `special`：`SELECT * FROM special_practice_sessions WHERE id=? AND student_id=?`（归属校验，找不到返 404）
     然后 `SELECT sar.*, q.content, q.answer, q.analysis AS question_analysis FROM special_answer_records sar LEFT JOIN questions q ON sar.question_id=q.id WHERE sar.session_id=? ORDER BY sar.question_order`
     （语文专项 question_id 为空时 LEFT JOIN 返回 null question 字段，前端按 ref_type 渲染篇目）
4. 语文专项额外 JOIN `chinese_passages`（`ref_type='passage'` 时）返回篇名+句内容

**返回形状**：
```json
{
  "code": 0,
  "data": {
    "session": {
      "source": "exam",
      "sessionId": 101,
      "subjectId": 4,
      "title": "北师大物理实验卷",
      "module": null,
      "startedAt": "...",
      "completedAt": "...",
      "totalCount": 10,
      "correctCount": 7
    },
    "questions": [
      {
        "questionId": 1234,
        "questionOrder": 1,
        "answerText": "B",
        "isCorrect": false,
        "score": 0.0,
        "method": "exact",
        "analysis": "...",
        "judgedAt": "...",
        "questionContent": "<题面 markdown>",
        "questionAnswer": "<正确答案>",
        "questionAnalysis": "<题库自带解析>",
        "refType": "question",
        "refId": null,
        "sentenceIndex": null,
        "passageTitle": null
      }
    ]
  }
}
```

**错误码**：
- 400 `{code:400, message:"source 仅允许 exam | special"}` —— source 非法
- 400 `{code:400, message:"sessionId 须为正整数"}` —— sessionId 非法
- 404 `{code:1002, message:"会话不存在"}` —— 找不到或非本人

### 4.3 模块组织
```
apps/server/src/
├── modules/practice-history/
│   ├── practice-history.controller.ts    # GET /api/student/practice-history + /:source/:sessionId
│   ├── practice-history.service.ts       # 列表 UNION + 详情路由
│   └── practice-history.dto.ts           # Query DTO
├── database/repositories/
│   ├── special-practice-sessions.repo.ts # upsertSession + listByStudent
│   └── special-answer-records.repo.ts    # upsertAnswer + listBySession
```

**DI 注意**（CLAUDE.md 铁律）：
- `practice-history.service` 注入 `SpecialPracticeSessionsRepository` + `ExamSessionsRepository` + `QuestionsRepository`
- 5 个判题 service 注入两个新 repo 时用 `@Optional()`（接口类型参数运行时 token 是 Object）

---

## 5. 前端设计

### 5.1 入口：`StudentStayLayout` 顶栏第三胶囊

```ts
// apps/web/src/components/layout/StudentStayLayout.tsx
const stayItems = [
  { to: '/student/rewards', label: '奖励册' },
  { to: '/student/profile', label: '个人中心' },
  { to: '/student/practice-history', label: '练习记录' },  // 新增
];
```

- 写死 `data-theme="student-day"`、无日夜切换（UX §1.5 第 59 行，浅停留页）
- 三胶囊并列，当前页高亮（brand-500 背景）
- `routeTable.test.tsx` 现有"奖励册/个人中心"两项断言要扩成三项

### 5.2 列表页 `PracticeHistoryPage`（`/student/practice-history`）

**状态机**：
```
[加载中] → [有数据] / [空态] / [错误]
  │
  ├─ 切学科筛选 → [加载中] → [有数据/空态]
  ├─ 翻页 → [加载中] → [有数据]
  └─ 点列表项 → 跳详情页
```

**UI 结构**：
- 顶部筛选条：学科下拉（全部/数学/语文/英语/物理/化学）+ 来源下拉（全部/考试/专项）
- 列表（卡片式，按 `startedAt` 倒序）：
  ```
  [学科标签] 北师大物理实验卷                    2026-11-01 14:00
  10题 · 对7题 · 错3题              [考试] →
  ```
  ```
  [学科标签] 默写专项·静夜思                       2026-10-31 19:30
  1篇 · 对2字 · 错1字               [专项] →
  ```
- 分页：底部页码（默认 20 条/页）
- 空态：引导"去训练轨开始第一次练习"（带跳转链接 `/student/training/...`）
- 进行中（`completedAt` 为空）：灰显 + "进行中"标签，仍可点进去

**派生状态防坑**（CLAUDE.md 铁律）：列表数据用 `useState` 存，切换筛选时 `useEffect` 重取，`page` 与筛选一起存避免跨筛选串扰。

### 5.3 详情页 `PracticeHistoryDetailPage`（`/student/practice-history/:source/:sessionId`）

**状态机**：
```
[加载中] → [有数据] / [404] / [错误]
```

**UI 结构**：
- 顶部：返回 + 卷名 + 日期 + 整体对错比（"对 7/10"）
- 逐题列表（复用 `ExamResultPage` 的题面渲染逻辑）：
  - 题面（Markdown 渲染，含图片/表格，复用共享 `MarkdownRenderer` 配置）
  - "我的答案"（学生当时选的/填的，对绿错红）
  - "正确答案"
  - "解析"（`method=ai` 且 `analysis` 为空时标"未生成"）
  - 对错图标（线性 SVG，不用 emoji）
- 语文专项特殊渲染（`questionId` 为空，`refType='passage'`）：
  - 展示篇名 + 句内容
  - 默写：展示学生填的 author/dynasty/body（从 `answerText` JSON 解析）
  - 解释/含义：展示学生填的 terms/translation
- **不加"再做一遍"按钮**（一期纯只读）

### 5.4 路由
```ts
// apps/web/src/routes/routeTable.tsx 新增（挂在 StudentStayLayout 下）
{ path: '/student/practice-history', element: <PracticeHistoryPage /> },
{ path: '/student/practice-history/:source/:sessionId', element: <PracticeHistoryDetailPage /> },
```

### 5.5 API 层（`services/api.ts` 新增）
```ts
export interface PracticeHistoryItem {
  source: 'exam' | 'special';
  sessionId: number;
  subjectId: number;
  title: string;
  module: string | null;
  startedAt: string;
  completedAt: string | null;
  totalCount: number;
  correctCount: number;
}

export interface PracticeHistoryQuestion {
  questionId: number | null;
  questionOrder: number;
  answerText: string;
  isCorrect: boolean | null;
  score: number | null;
  method: string | null;
  analysis: string | null;
  judgedAt: string | null;
  questionContent: string | null;
  questionAnswer: string | null;
  questionAnalysis: string | null;
  refType: string | null;
  refId: number | null;
  sentenceIndex: number | null;
  passageTitle: string | null;
}

export interface PracticeHistoryDetail {
  session: PracticeHistoryItem;
  questions: PracticeHistoryQuestion[];
}

export async function getPracticeHistory(params: { page?: number; pageSize?: number; subjectId?: number }): Promise<Paginated<PracticeHistoryItem>>;
export async function getPracticeHistoryDetail(source: 'exam' | 'special', sessionId: number): Promise<PracticeHistoryDetail>;
```

### 5.6 配色与样式
- 全 token，禁止 `text-black/60` 等灰阶快捷写法（CLAUDE.md 铁律，移动端配色 feedback）
- 对错标记：对用 `--success-500`，错用 `--danger-500`，未判用 `--text-tertiary`
- 卡片用 `--bg-card` 背景 + `--bg-subtle` 边框 + `--radius-md` 圆角

---

## 6. 错误处理与边界（汇总）

| 场景 | 处理 |
|---|---|
| 写入 `special_answer_records` 失败 | `try/catch` 吞异常只 warn，判题结果照常返回（与 `special_practice_logs` 一致） |
| `sessionUid` 缺失 | 不写作答记录但不报错（向后兼容） |
| 语文专项 `question_id` 为 NULL | 唯键不生效，先 DELETE 后 INSERT 保证同句重判不留多行 |
| 进行中 session（`completedAt` 为空） | 列表灰显 + "进行中"标签，详情可看已答部分 |
| 历史数据 | `exam_answers` 现有数据自动出现在列表（UNION 覆盖）；专项历史从上线后累积 |
| 权限（IDOR） | 两个查询端点按 `JWT.sub` 过滤；详情端点 `WHERE student_id=?` 归属校验 |
| 分页 | UNION ALL 后 `ORDER BY started_at DESC LIMIT ? OFFSET ?` |
| `updated_at` | 两张新表列级 `ON UPDATE CURRENT_TIMESTAMP(3)`，不建触发器 |
| schema 同步 | 两表进 `schema.sql` + 幂等迁移；收尾跑 `schema_reconcile.py` |

---

## 7. 测试策略

### 7.1 后端测试
- `special-practice-sessions.repo.test.ts`：upsertSession 幂等（同 uid 两次只建一行）
- `special-answer-records.repo.test.ts`：upsertAnswer（question_id 非空 upsert / 为空先 DELETE 后 INSERT）
- `practice-history.service.test.ts`：列表 UNION + 分页 + 学科筛选 + 归属校验 + 详情路由（exam/special）
- `practice-history.controller.test.ts`：参数校验（source 白名单 / sessionId 正整数 / 404）
- 5 个判题方法所在的 4 个 service 现有测试补断言：判题后 `special_answer_records` 有行（`sessionUid` 带时）/ 无行（不带时）
- **`globals: false`**：多用例文件自己 `afterEach(() => cleanup())`

### 7.2 前端测试
- `PracticeHistoryPage.test.tsx`：列表渲染 + 筛选切换 + 空态 + 分页 + 进行中灰显
- `PracticeHistoryDetailPage.test.tsx`：逐题作答渲染 + 对错标记 + 语文专项特殊渲染（questionId 为空）+ 解析缺失标"未生成"
- `routeTable.test.tsx`：新增两条路由 + `stayItems` 三项断言（扩展现有"奖励册/个人中心"两项）
- `StudentStayLayout.test.tsx`：三胶囊渲染 + 当前页高亮
- `api.test.ts`：`getPracticeHistory` / `getPracticeHistoryDetail` 请求与响应形状
- **组件渲染测试**（CLAUDE.md 铁律）：不只靠 `tsc + lint + build`，用 `@testing-library/react` 验数据形状

### 7.3 集成验证
- 起真后端 `node dist/main.js`（不用 tsx，CLAUDE.md DI 坑）
- 学生账号做一次数学训练 + 一次语文默写 + 一次考试
- 验证"练习记录"列表三条都在 + 点进详情逐题作答可见

---

## 8. 验收标准

### 8.1 一期验收（本期）
1. 六学科专项练习判题后，`special_answer_records` 有对应作答行（含答案原文）
2. 学生端"练习记录"列表显示所有做过的卷子（考试 + 专项），按时间倒序，同卷多次不合并
3. 点开详情页能看到每道题的：题面 + 我的答案 + 正确答案 + 解析 + 对错
4. 语文专项详情页正确渲染篇目 + author/dynasty/body 或 terms/translation
5. 进行中的 session 灰显 + "进行中"标签
6. 归属校验：看别人的 session 返 404
7. 写入失败不阻断判题（专项判题照常返回）
8. 后端全量测试绿 + 前端全量测试绿
9. `schema_reconcile.py` 对账一致

### 8.2 二期验收（不在本期）
- 家长端逐卷作答查看
- 家长端薄弱点汇总（数学/语文/物理 KP 维度 + 化学/道法卷子维度）

---

## 9. 不做的事（明确边界）

1. **主线闯关（learning_cards 的 practice/discuss）作答不纳入** —— 散题、与错题本重叠，列表会很碎
2. **不改 `exam_answers` 表结构与考试模块判题逻辑** —— 稳定运行的表不碰
3. **不补化学/道法的知识点树** —— 二期薄弱点用卷子维度，KP 树标定作为独立后续任务
4. **不做"再做一遍"按钮** —— 一期纯只读历史
5. **不做家长端任何页面** —— 二期
6. **不替换 `practice_results` / `special_practice_logs`** —— 现有表继续用，新表只补充作答原文
7. **不改积分/错题/判题逻辑** —— 作答记录是只读旁路写入

---

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 4 个 service 文件（含 5 个判题方法）都要改，改动面大 | DTO 字段全可选 + 写入失败不阻断，现有测试不破坏；逐个 service 改造可分任务 |
| 语文专项 `question_id` 为 NULL 导致唯键失效 | 先 DELETE 后 INSERT，保证同句重判不留多行 |
| UNION 查询性能（学生作答量大时） | `idx_sps_student_time` + `idx_es_student_status` 索引覆盖；分页 LIMIT OFFSET；本期学生作答量不大，暂不需缓存 |
| `sessionUid` 前端生成丢失（刷新页面） | 前端启动专项时生成 UUID 存 sessionStorage，刷新可恢复；丢失则该次判题不写作答记录（向后兼容） |
| DI 坑（接口类型 token 是 Object） | 新 repo 注入用 `@Optional()`（CLAUDE.md 铁律） |

---

## 附录 A：相关文件清单（动手时参考）

**新建**：
- `tools/db/migrations/2026-11-01_special_practice_sessions_and_answers.sql`
- `apps/server/src/modules/practice-history/`（controller + service + dto）
- `apps/server/src/database/repositories/special-practice-sessions.repo.ts`
- `apps/server/src/database/repositories/special-answer-records.repo.ts`
- `apps/web/src/pages/student/PracticeHistoryPage.tsx`
- `apps/web/src/pages/student/PracticeHistoryDetailPage.tsx`

**修改**：
- `tools/db/schema.sql`（加两表）
- `apps/server/src/modules/training/training.service.ts`（judgeTraining / judgeDictation / judgeInterpretation 补写）
- `apps/server/src/modules/training/meaning.service.ts`（补写）
- `apps/server/src/modules/training/vocabulary.service.ts`（补写）
- 5 个判题 DTO（加 sessionUid 等可选字段）
- `apps/web/src/components/layout/StudentStayLayout.tsx`（stayItems 加第三项）
- `apps/web/src/routes/routeTable.tsx`（加两条路由）
- `apps/web/src/services/api.ts`（加两个 API 函数 + 类型）

**文档同步**：
- `docs/API接口与数据流设计文档.md`（§4 加两条端点）
- `docs/api/openapi.yaml`（同步两条端点）
- `docs/UX-UI设计文档.md`（§1.5 浅停留页清单加"练习记录"）
- `docs/家长端学情批-完成情况与待办清单.md`（注明一期已落库 + 二期家长端待做）
