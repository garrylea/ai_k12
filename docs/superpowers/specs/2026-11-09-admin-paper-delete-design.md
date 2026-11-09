# 管理员端「试卷管理」— 删除套卷 设计 spec

**日期**：2026-11-09
**状态**：待实施
**关联**：API 文档 §4.17 Admin；`tools/db/schema.sql` 的 `exam_papers` / `paper_questions` / `questions` / `exam_sessions` / `exam_answers`

---

## 1. 背景

管理员需要清理导错的套卷。此前只能手工写 SQL：先删 `exam_sessions`（级联 `exam_answers`），再删 `questions`（级联 `paper_questions`、`question_knowledge_points`），最后删 `exam_papers`。2026-11-09 已用这套手工流程清掉「2026 北京汇文中学教育集团 初三 期中」（paper 446，14 题）。

后台目前没有试卷/题库管理页；学生端 `GET /api/exams/papers` 必须带 `subjectId`，且不返回年份/来源/作答统计，不适合直接复用。

## 2. 目标

1. 后台新增「试卷管理」页，可按学科/年级/年份/标题筛选，看到题数和考试人次。
2. 点删除 → 先展示**影响面预览**（题数、共享题、被引用保留题、考试场次、作答条数）→ 确认后一次性删除。
3. 删除在**单事务**内完成，任何失败整单回滚，不留半删状态。

## 3. 非目标（本期不做）

- 不提供题库单题删除/编辑页面。
- 不做软删除、不做回收站、不做自动备份。
- 不支持「强制删除被学生数据引用的题」（这类题一律保留）。
- 不修改学生端 `/api/exams` 接口。
- 无表结构变更、无数据迁移。

## 4. 关键决策

| # | 决策 | 理由 |
|---|---|---|
| 1 | 只删除**该卷独占题**（`paper_questions` 中不属于其它卷的题） | 线上有 18 道跨卷共享题；按题物理删会连带毁掉别的卷 |
| 2 | 独占题若被学生数据引用则**保留该题**，只解除卷关联 | 错题本/变式/专项作答是学生学习痕迹，删卷不应抹掉；接口返回 `retainedQuestions` 让管理员知情。**例外**：随题 CASCADE 的自评记录（`question_self_assessments`）、隐藏标记（`student_hidden_questions`）、提示缓存（`question_hints`）会随被删题一起消失，见 §10 |
| 3 | 该卷的 `exam_sessions` 连同 `exam_answers` 一并删除 | 用户 2026-11-09 裁决；`exam_answers.question_id` 是 `ON DELETE RESTRICT`，不先清会话就删不了题 |
| 4 | 删除走独立 `AdminPapersController`，不塞进 `AdminController` | `AdminController` 已 207 行、7 个 service；独立文件边界更清晰 |
| 5 | 列表分页 SQL 用 `pool.query` 而非 `pool.execute` | `LIMIT ?` 在 execute 预编译下会被 MySQL 拒绝（仓内已有护栏测试） |
| 6 | 删除前必须调预览接口，确认框展示真实数字 | 删除不可恢复；只写「确定删除吗」不足以让管理员判断 |

## 5. 数据模型与删除规则

### 5.1 相关外键

| 表 | 外键行为 | 删除题时 |
|---|---|---|
| `paper_questions` | `question_id` ON DELETE CASCADE | 自动删关联 |
| `question_knowledge_points` | ON DELETE CASCADE | 自动删 |
| `question_hints` | ON DELETE CASCADE | 自动删 |
| `question_self_assessments` | ON DELETE CASCADE | 自动删 |
| `practice_results` | ON DELETE SET NULL | 置空 |
| `main_error_books` | ON DELETE RESTRICT | **阻断** |
| `aux_error_books` | ON DELETE RESTRICT | **阻断** |
| `answers` | ON DELETE RESTRICT | **阻断** |
| `exam_answers` | ON DELETE RESTRICT | **阻断**（本卷会话先删，其它会话仍可能引用） |
| `variation_questions` | ON DELETE RESTRICT | **阻断** |
| `special_answer_records` | ON DELETE RESTRICT | **阻断** |
| `remediation_set_items` | ON DELETE RESTRICT | **阻断** |
| `student_hidden_questions` | ON DELETE CASCADE | 自动删（学生的「不再练」标记） |
| `ai_dialogues.question_id` | ON DELETE SET NULL | 对话保留、题目引用置空 |
| `exam_sessions.paper_id` | RESTRICT（默认） | 删卷前先删该卷会话 |
| `paper_questions.paper_id` | ON DELETE CASCADE | 删卷自动清 |

> 注：`questions` 表没有外键指向它的表还有 `admin_notifications.question_id`、`assessments.question_ids`、`homeworks.question_ids`（均为普通列/JSON），删除后会留下悬空 id，见 §10。原 spec 误列过 `reward_items`（不存在该表），已删。

### 5.2 概念定义

- **卷内题**：`paper_questions WHERE paper_id = ?`（含 `in_exam=0` 的行，后台按真实关联统计）。
- **共享题**：`question_id` 还被 `paper_id <> ?` 的 `paper_questions` 引用。
- **独占题**：卷内题中非共享的。
- **可删题**：独占题中**没有**被 5.1 任一 RESTRICT 表引用的。
- **保留题**：独占题中被引用的（`= 独占题 - 可删题`）。

## 6. 后端设计

### 6.1 文件

```
apps/server/src/database/repositories/admin-papers.repo.ts   新增（列表/预览/事务删除）
apps/server/src/modules/admin/admin-papers.service.ts        新增
apps/server/src/modules/admin/admin-papers.controller.ts     新增
apps/server/src/modules/admin/admin.module.ts                注册 provider/controller
```

### 6.2 `GET /api/admin/papers`

**权限**：`admin`（`JwtAuthGuard` + `RolesGuard` + `@Roles('admin')`）。

**Query**（全部可选，由 zod 校验）：

| 参数 | 类型 | 规则 |
|---|---|---|
| `subjectId` | int | 缺省=全部学科；非正整数 → 400/1001 |
| `year` | int | 缺省=全部；非法 → 400/1001 |
| `gradeBand` | string | `primary\|junior\|senior`，其它值 → 400/1001 |
| `keyword` | string | 最长 50，`LIKE` 匹配标题；`%`/`_` 转义；空串视为不筛选 |
| `page` | int | 缺省 1，最小 1 |
| `pageSize` | int | 缺省 20，范围 1–100 |

**SQL**（分页查询用 `pool.query`）：

```sql
SELECT p.id, p.subject_id, s.name AS subject_name, p.title, p.grade, p.grade_band,
       p.semester, p.year, p.district, p.exam_type, p.source_key, p.created_at,
       (SELECT COUNT(*) FROM paper_questions pq WHERE pq.paper_id = p.id) AS linked_question_count,
       (SELECT COUNT(*) FROM exam_sessions es WHERE es.paper_id = p.id) AS session_count
FROM exam_papers p JOIN subjects s ON s.id = p.subject_id
WHERE <filters>
ORDER BY p.id DESC
LIMIT ? OFFSET ?
```

总数：同 WHERE 的 `SELECT COUNT(*)`。

**响应 200**：

```json
{
  "items": [
    {
      "id": 446,
      "subjectId": 9,
      "subjectName": "道德与法治",
      "title": "2026 北京汇文中学教育集团 初三 期中",
      "grade": "初三",
      "gradeBand": "junior",
      "semester": "first",
      "year": 2026,
      "district": "",
      "examType": "期中",
      "sourceKey": "道法/初中/first/2026/汇文初三道法期中真题/汇文初三道法期中真题",
      "questionCount": 14,
      "sessionCount": 1,
      "createdAt": "2026-11-07T09:15:00.029Z"
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 20
}
```

`questionCount` 取 `linked_question_count`（真实关联行数），不用表上的冗余列 `exam_papers.question_count`。

### 6.3 `GET /api/admin/papers/:id/delete-preview`

**校验**：`:id` 非正整数 → 400/1001；卷不存在 → 404/1002。

**响应 200**：

```json
{
  "paperId": 446,
  "title": "2026 北京汇文中学教育集团 初三 期中",
  "subjectName": "道德与法治",
  "questionCount": 14,
  "sharedCount": 0,
  "exclusiveCount": 14,
  "deletableCount": 14,
  "retainedCount": 0,
  "sessionCount": 1,
  "answerCount": 5
}
```

口径：

- `questionCount` = 卷内题总数；
- `sharedCount` = 共享题数；
- `exclusiveCount` = 独占题数；
- `deletableCount` = 独占且无 RESTRICT 引用；
- `retainedCount` = `exclusiveCount - deletableCount`；
- **`exam_answers` 引用口径**：只统计「非本卷会话」的作答（`session_id NOT IN (SELECT id FROM exam_sessions WHERE paper_id = ?)`）。本卷会话在删除时先被清掉，若预览把它们算作阻断，预览的「保留 N 道」会与执行结果矛盾；
- `sessionCount` = `exam_sessions WHERE paper_id = ?`；
- `answerCount` = 这些会话的 `exam_answers` 总数。

预览**只读**，不加锁、不写库。

### 6.4 `DELETE /api/admin/papers/:id`

用 `@Delete`（默认 200）。

**单事务流程**（`pool.getConnection()` + `beginTransaction`）：

1. `SELECT id, title FROM exam_papers WHERE id = ? FOR UPDATE`。无行 → 回滚 + 404/1002。
2. 统计 `sessionCount`、`answerCount`（删除前计数，用于响应）。
3. `DELETE FROM exam_sessions WHERE paper_id = ?`（级联删 `exam_answers`）。
4. 查独占题 id：
   ```sql
   SELECT pq.question_id FROM paper_questions pq
   WHERE pq.paper_id = ?
     AND NOT EXISTS (
       SELECT 1 FROM paper_questions x
       WHERE x.question_id = pq.question_id AND x.paper_id <> ?
     )
   ```
5. 在被引用检测里排除掉本卷会话已删的 `exam_answers` 噪声；检测 5.1 中所有 RESTRICT 表：
   ```sql
   SELECT DISTINCT qid FROM (
     SELECT question_id AS qid FROM main_error_books WHERE question_id IN (...)
     UNION ALL SELECT question_id FROM aux_error_books WHERE question_id IN (...)
     UNION ALL SELECT question_id FROM answers WHERE question_id IN (...)
     UNION ALL SELECT question_id FROM exam_answers WHERE question_id IN (...)
     UNION ALL SELECT question_id FROM variation_questions WHERE question_id IN (...)
     UNION ALL SELECT question_id FROM special_answer_records WHERE question_id IN (...)
     UNION ALL SELECT question_id FROM remediation_set_items WHERE question_id IN (...)
   ) t
   ```
   **顺序不可换**：本卷会话必须在第 3 步删完，这里查到的 `exam_answers` 才是「其它来源」的引用。**预览口径与执行一致**：预览的 `exam_answers` 分支必须排除本卷会话（§6.3），否则 `retainedCount` 虚高。
6. `DELETE FROM questions WHERE id IN (可删题 id 列表)`（空列表则跳过；SQL 用动态占位符拼接，禁止字符串拼值）。
7. `DELETE FROM exam_papers WHERE id = ?`（级联清剩余 `paper_questions`；保留题变成孤儿题，仍可被错题练习使用）。
8. `commit()`。

异常一律 `rollback()` 后抛出；连接在 `finally` 中 `release()`。

**响应 200**：

```json
{
  "paperId": 446,
  "deletedQuestions": 14,
  "retainedQuestions": 0,
  "deletedSessions": 1,
  "deletedAnswers": 5
}
```

**边界与错误**：

| 场景 | 结果 |
|---|---|
| 卷不存在 | 404 / `1002` |
| 并发新增考试会话导致删卷外键失败（`ER_ROW_IS_REFERENCED_2`） | 回滚 → 409 / `4201`，message「该试卷正在被使用，请刷新后重试」 |
| 删除过程中其它 RESTRICT 引用新增导致删题失败 | 回滚 → 409 / `4201`，同上 |
| 空卷（0 题） | 正常删，`deletedQuestions=0` |
| 全部题被引用 | 正常删卷，`deletedQuestions=0`，`retainedQuestions=N` |

### 6.5 服务层职责

- `AdminPapersService`：参数校验后的业务编排、DTO 映射、异常转换；
- `AdminPapersRepository`：SQL 与事务，不抛 HTTP 异常（返回 `null` / 抛普通 Error，由 service 转）；
- 事务内不做任何网络/LLM 调用，避免长事务；
- 列表 `createdAt` 由 `Date` 转 ISO 字符串（`toISOString()`），不要裸传 mysql2 的 `Date`。

### 6.6 入参校验（重要）

**裸 `ZodError` 会被全局 `HttpExceptionFilter` 兜成 500/5000**，不是 400。新 controller 必须用 `safeParse` + 转换（同 `auth.controller.ts` 的 `parseInput`）：

```ts
function parseQuery<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || 'query'}: ${i.message}`).join('; ');
    throw new BadRequestException({ code: 1001, message: `入参校验失败：${detail}` });
  }
  return parsed.data;
}
```

Query 是字符串，用 `z.coerce.number().int()`；`keyword` 同时校验 `max(50)` 与 `LIKE` 通配符转义（`\` `%` `_`）。删除/预览的 `:id` 走 `ParseIntPipe` + service 内 `> 0` 校验（非正数 → 400/1001）。

## 7. 前端设计

### 7.1 入口

- 路由：`/admin/papers` → `AdminPapersPage`，挂在 `AdminLayout` 子路由；
- `AdminNav` 增加「试卷管理」，位置在「订阅裁决」之后、「预警数据」之前。

### 7.2 页面结构

```
标题：试卷管理 / 副标题：删除导错的套卷；删除不可恢复
筛选行：[学科 ▾] [年级 ▾] [年份 输入] [标题关键词 输入] [查询]
表格列：标题 | 学科 | 年份 | 年级 | 题数 | 考试人次 | 操作(删除)
分页：共 N 条 · 上一页 / 下一页
```

- 学科下拉复用 `apps/web/src/subjectConfig.ts` 的 `TRAINING_SUBJECTS`（6 科，与训练轨一致）；选到没有卷的学科时列表为空，不新增学科接口；
- 删除按钮在 `sessionCount = 0` 时仍可点（有会话也能删，预览会展示数量）；
- **筛选/关键词改变时回到第 1 页**（否则带着旧页码请求新条件可能停在空态）。

### 7.3 状态机

```
idle
  └─ 点「删除」→ previewLoading（拉 delete-preview）
       ├─ 成功 → confirmOpen（ConfirmDialog 展示影响面）
       │    ├─ 取消 → idle
       │    └─ 确认 → deleting（防连点 ref 闸门）→ 成功：toast + 关框 + 重新拉列表 → idle
       │                                    └─ 失败：toast 错误 + 保持 confirmOpen
       └─ 失败 → toast 错误 → idle
```

确认框文案（数字来自预览）：

> 确认删除试卷《{title}》？
> 将删除题目 {deletableCount} 道（共享题 {sharedCount} 道仅解除关联、被学生数据引用 {retainedCount} 道保留）、考试会话 {sessionCount} 场、作答 {answerCount} 条。此操作不可恢复。

成功后 toast：`已删除《{title}》：题目 {deletedQuestions} 道、会话 {deletedSessions} 场`。

### 7.4 复用

- `ConfirmDialog`、`toast`、`Skeleton` 取自 `@/components/base`；
- 防连点用 `useRef`（同 `AdminAlertsPage` 的 `purgingRef`：`ConfirmDialog` 确认按钮无 disabled，state 来不及）。

## 8. 测试计划

### 后端

`admin-papers.service.test.ts`（mock repo）：

1. 列表映射：repo 行 → DTO，`questionCount` 用 `linked_question_count`，`sessionCount` 透传；
2. 预览：`deletableCount = exclusiveCount - retainedCount`；
3. 删除成功：透传四个计数；
4. 卷不存在：404；
5. repo 抛 `ER_ROW_IS_REFERENCED_2`：转 409/4201；
6. 非法参数：`gradeBand=foo`、`pageSize=0`、`pageSize=101`、`subjectId=abc` → 400/1001。

`admin-papers.repo.test.ts`（fake Pool 断言 SQL 片段与参数）：

7. 列表 SQL 用 `query` 且 `LIMIT ? OFFSET ?`；
8. 事务失败时调用 `rollback`，成功后 `commit`，最后 `release`；
9. 共享题排除条件 `x.paper_id <> ?` 存在。

### 前端

`AdminPapersPage.test.tsx`：

10. 首屏渲染行数据与「共 N 条」；
11. 点删除 → 预览数字出现在确认框；
12. 确认 → 调 delete → 重新拉列表；
13. 预览失败 → toast 且不开框。

`AdminNav.test.tsx`：断言「试卷管理」入口存在。

## 9. 文档同步

- `docs/API接口与数据流设计文档.md` §4.17 Admin 表新增 3 行；
- `docs/api/openapi.yaml` 新增 `/api/admin/papers`、`/api/admin/papers/{id}/delete-preview`、`/api/admin/papers/{id}`（DELETE）；
- `docs/ai-core-changelog.md` 追加 2026-11-09 条目。

## 10. 风险与已知限制

1. **删除不可恢复**：没有软删/备份。误删只能从数据库备份恢复。
2. **保留题会变成孤儿题**：不在任何卷中，但仍可被错题练习/变式使用。这是「不抹学生数据」的代价。
3. **预览与执行之间有时间差**：预览后到确认前若有新的考试会话/错题本写入，实际结果可能与预览数字不同；响应返回真实数字，UI 以响应为准。
4. **删除会连带清掉该卷所有学生的考试成绩**（用户裁决）。管理员操作前应从预览里看到会话数。
5. **进行中的考试会被强制中断**：`sessionCount` 含 `in_progress` 会话，删除后学生端请求该会话会 404。预览不区分状态，管理员需自行判断。
6. **随题 CASCADE 的学生痕迹**：被删题的自评记录、隐藏标记、提示缓存一并消失；这几类不会阻断删除，也不出现在 `retainedCount` 里。
7. **悬空 id**：`admin_notifications.question_id`、`assessments.question_ids`、`homeworks.question_ids` 无外键，删除后会指向不存在的题；这几处只在历史记录里出现，本期不清理。
8. **并发窗口**：事务持 `exam_papers` 行锁，期间新建考试会话会等待，随后因父行不存在而失败 → 前端收到 409/4201，重试即可。
