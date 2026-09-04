# 专项训练「不再展示」功能设计

- 日期：2026-09-04
- 范围：专项训练（targeted practice）选题模块
- 关联代码：`apps/server/src/modules/training/`、`apps/server/src/database/repositories/questions.repo.ts`、`apps/web/src/pages/student/training/`、`apps/web/src/components/business/answer/QuestionRunner.tsx`
- 关联文档：`docs/api/openapi.yaml`、`docs/API接口与数据流设计文档.md`（按 CLAUDE.md 同步规则一并更新）

## 1. 背景与目标

当前专项训练选题（`findRandomByKpAndType`）是纯随机 `ORDER BY RAND() LIMIT ?`，不排除用户已做过的题。用户反馈：希望在做题过程中遇到"做过几次 / 已很熟悉"的题时，可主动勾选"不再展示"，下次专项训练抽题时将其排除。

### 1.1 核心需求

1. 做题过程中，每道题可勾选"不再展示"，后端记录到数据库
2. 下次专项训练选题时，随机抽题仍按原过滤维度（学科 + 知识点 + 题型），但**排除已标记的题**
3. 标记的"不再展示"**只在专项训练场景生效**，主线练习、错题重做、考试等其他选题路径不受影响
4. 学生可在专项训练配置页查看"我的不再展示清单"，逐条撤销或一键全部重置

### 1.2 已确认的产品决策

| 维度 | 决策 |
|---|---|
| 排除范围 | 仅专项训练场景内全局排除（按 `student_id + question_id`，不分知识点）；其他页面不排除 |
| 撤销入口 | 仅学生端（专项训练配置页加清单入口）；家长端不参与 |
| 题池耗尽 | 标记排除后题池为空时，后端返回空数组，前端提示"该专项题目已练完，可在清单页重置" |
| 标记时机 | 答题阶段（answering phase）任意时刻可标记，不要求先答完；标记后当前题不强制踢出，学生可继续作答；结果页（result phase）不支持标记（未来扩展项） |

## 2. 数据模型

### 2.1 新表 `student_hidden_questions`

```sql
CREATE TABLE IF NOT EXISTS student_hidden_questions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  subject_id BIGINT NOT NULL,
  question_id BIGINT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_shq_student_question (student_id, question_id),
  KEY idx_shq_student (student_id),
  KEY idx_shq_student_subject (student_id, subject_id),
  CONSTRAINT fk_shq_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_shq_subject_id FOREIGN KEY (subject_id) REFERENCES subjects (id) ON DELETE RESTRICT,
  CONSTRAINT fk_shq_question_id FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

设计要点：
- `UNIQUE(student_id, question_id)`：同一生对同一题只记一条，重复标记走 `INSERT IGNORE` 幂等
- `question_id ON DELETE CASCADE`：题目被 data-refinery 清理时，隐藏标记自动随行清除（无审计价值，与 `main_error_books` 的 `RESTRICT` 语义不同——错题本有学习轨迹价值需保留）
- `subject_id` 冗余：用于清单页按学科过滤，避免再 JOIN questions 取 subject_id
- 不存 `kp_id`：决策已确认"专项训练内全局排除"，不按知识点细分

### 2.2 Row 类型

`apps/server/src/database/repositories/types.ts` 新增：

```ts
export interface StudentHiddenQuestionRow extends RowDataPacket {
  id: number;
  student_id: number;
  subject_id: number;
  question_id: number;
  created_at: Date;
  updated_at: Date;
}
```

## 3. 后端实现

### 3.1 新 Repository：`StudentHiddenQuestionsRepository`

文件：`apps/server/src/database/repositories/student-hidden-questions.repo.ts`

方法：

```ts
@Injectable()
export class StudentHiddenQuestionsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /** 标记：INSERT IGNORE 幂等（重复标记不报错，UNIQUE 约束兜底）。 */
  async mark(studentId: number, subjectId: number, questionId: number): Promise<void>;

  /** 撤销单条：归属校验防 IDOR（WHERE 含 student_id）。 */
  async unmark(studentId: number, questionId: number): Promise<number>;  // 返回删除行数

  /** 全部重置：清空该生所有隐藏标记。 */
  async unmarkAll(studentId: number): Promise<number>;

  /** 清单：JOIN questions 取题面预览 + JOIN question_knowledge_points 取首个知识点名。 */
  async findAllByStudent(studentId: number, subjectId: number): Promise<Array<{
    questionId: number;
    questionText: string;     // 题面截断 80 字
    type: string;
    kpName: string | null;    // 首个 primary kp 名
    markedAt: string;         // ISO
  }>>;
}
```

`findAllByStudent` SQL（清单页展示用）：

```sql
SELECT shq.question_id AS questionId,
       SUBSTRING(q.content, 1, 80) AS questionText,
       q.type,
       (SELECT kp.name FROM question_knowledge_points qkp
        JOIN knowledge_points kp ON kp.id = qkp.knowledge_point_id
        WHERE qkp.question_id = q.id AND qkp.role = 'primary' LIMIT 1) AS kpName,
       shq.created_at AS markedAt
FROM student_hidden_questions shq
JOIN questions q ON q.id = shq.question_id
WHERE shq.student_id = ? AND shq.subject_id = ?
ORDER BY shq.created_at DESC;
```

在 `repositories/index.ts` 导出。

### 3.2 改 `QuestionsRepository.findRandomByKpAndType`

文件：`apps/server/src/database/repositories/questions.repo.ts:73-93`

签名加 `studentId`，SQL 加 `LEFT JOIN student_hidden_questions shq ... WHERE shq.id IS NULL`：

```ts
async findRandomByKpAndType(
  studentId: number,          // 新增
  subjectId: number,
  kpId: number,
  type: string | null,
  count: number,
): Promise<QuestionRow[]> {
  const typeFilter = type != null ? ' AND q.type = ?' : '';
  const sql = `SELECT q.* FROM questions q
    JOIN question_knowledge_points qkp ON qkp.question_id = q.id
    LEFT JOIN student_hidden_questions shq
      ON shq.question_id = q.id AND shq.student_id = ?
    WHERE q.subject_id = ? AND qkp.knowledge_point_id = ? AND q.is_active = 1${typeFilter}
      AND NOT (q.type IN ('choice','true_false') AND q.answer = '')
      AND shq.id IS NULL
    ORDER BY RAND() LIMIT ?`;
  const params = type != null
    ? [studentId, subjectId, kpId, type, count]
    : [studentId, subjectId, kpId, count];
  const [rows] = await this.pool.query<RowDataPacket[]>(sql, params);
  return rows as QuestionRow[];
}
```

说明：`LEFT JOIN ... IS NULL` 比 `NOT IN (subquery)` 在题池规模下更稳，且 MySQL 优化器对其处理更可预测。

### 3.3 改 `TrainingService.startTargetedPractice`

文件：`apps/server/src/modules/training/training.service.ts:123-143`

入参加 `studentId`，透传给 `findRandomByKpAndType`：

```ts
async startTargetedPractice(input: {
  studentId: number;          // 新增
  subjectId: number;
  kpId: number;
  type: string | null;
  count: number;
}): Promise<{ questions: Array<...> }> {
  const rows = await this.questionsRepo.findRandomByKpAndType(
    input.studentId, input.subjectId, input.kpId, input.type, input.count,
  );
  // 序列化逻辑不变
}
```

新增 4 个 service 方法（薄封装 + 校验）：

```ts
async markHidden(studentId: number, subjectId: number, questionId: number): Promise<void> {
  // 校验题目存在且 is_active=1（避免标记已删题）
  const q = await this.questionsRepo.findById(questionId);
  if (!q) throw new NotFoundException(`题目不存在：${questionId}`);
  await this.hiddenRepo.mark(studentId, subjectId, questionId);
}

async unmarkHidden(studentId: number, questionId: number): Promise<void> {
  await this.hiddenRepo.unmark(studentId, questionId);
}

async unmarkAllHidden(studentId: number): Promise<void> {
  await this.hiddenRepo.unmarkAll(studentId);
}

async listHidden(studentId: number, subjectId: number): Promise<HiddenQuestionDto[]> {
  return this.hiddenRepo.findAllByStudent(studentId, subjectId);
}
```

构造函数注入 `StudentHiddenQuestionsRepository`。

### 3.4 改 `TrainingController`

文件：`apps/server/src/modules/training/training.controller.ts`

`startTargetedPractice` 端点加 `@CurrentUser() user: JwtUser`，传 `user.sub`：

```ts
@Post('targeted/start')
async startTargetedPractice(
  @Body() dto: { subjectId: number; kpId: number; type: string | null; count: number },
  @CurrentUser() user: JwtUser,   // 新增
) {
  // ... count/type 校验不变
  return this.trainingService.startTargetedPractice({
    studentId: user.sub,        // 新增
    subjectId: dto.subjectId,
    kpId: dto.kpId,
    type,
    count,
  });
}
```

新增 4 个端点（全部 `@Roles('student')`，归属由 JWT `user.sub` 决定，repo 层 WHERE 含 student_id 防 IDOR）。

**响应信封**：后端 `ResponseInterceptor`（`apps/server/src/common/interceptors/response.interceptor.ts:22-28`）把所有返回包成 `{ code:0, message:'ok', data: data ?? null }`；前端 `fetchApi`（`apps/web/src/services/api.ts:32-38`）做 `await res.json()` 后只检查 `code`。因此**禁用 `@HttpCode(204)` / 空响应**——void 操作 return `undefined`，interceptor 产出 `{ code:0, data:null }`，HTTP 状态走 NestJS 默认（POST=201，GET/DELETE=200），前端 `fetchApi<void>` 收到 `data:null`。

| 方法 | 路径 | 入参 | 响应 data |
|---|---|---|---|
| POST | `/api/training/hidden/mark` | `{ questionId: number, subjectId: number }` | `null`（幂等；重复标记不报错） |
| GET | `/api/training/hidden?subjectId=1` | query `subjectId` | `HiddenQuestionDto[]` |
| DELETE | `/api/training/hidden/:questionId` | path `questionId` | `null`（幂等） |
| DELETE | `/api/training/hidden` | 无 | `null`（全部重置） |

DTO 校验：`questionId`/`subjectId` 为正整数；越界/非法 → 400。

### 3.5 Module 接线

`apps/server/src/modules/training/training.module.ts` 的 `providers` 加 `StudentHiddenQuestionsRepository`。

## 4. 前端实现

### 4.1 `QuestionRunner` 新增 ungated 插槽

文件：`apps/web/src/components/business/answer/QuestionRunner.tsx`

现状：`headerActions` 在 `requestHint=true` 时被"先看提示"门禁 gate 住（line 290）。新增 `questionMetaActions?: (q: RunnerQuestion) => ReactNode`，**始终渲染**（不 gate），放在同一右侧列、`headerActions` 之上：

```tsx
// 新增 prop
questionMetaActions?: (q: RunnerQuestion) => ReactNode;

// 渲染（line 273-292 区域）
{(requestHint || headerActions || questionMetaActions) && (
  <div className="flex flex-col gap-2 shrink-0">
    {questionMetaActions && questionMetaActions(q)}          {/* 始终可见，不 gate */}
    {requestHint && (/* 提示按钮，不变 */)}
    {headerActions && (!requestHint || hints?.[q.n]) && headerActions(q)}  {/* 保留 gate */}
  </div>
)}
```

向后兼容：prop 可选，现有调用方（CourseDetailPage / AnswerModal / 错题重做页等）不传则不渲染，行为不变。

### 4.2 `TargetedRunPage` 加"不再展示"按钮

文件：`apps/web/src/pages/student/training/TargetedRunPage.tsx`

- 新增 state：`const [markConfirm, setMarkConfirm] = useState<{ open: boolean; questionId: number | null }>(...)`
- `questionMetaActions` 回调返回一个图标按钮（线性 SVG，眼斜杠图标），点击打开确认 Modal
- 确认后调 `markTrainingHidden({ questionId, subjectId: MATH_SUBJECT_ID })`，成功 toast「已加入不再展示清单」，失败 toast 错误
- 标记后**当前题不强制跳走**，学生可继续作答当前题；排除仅在下次开练生效
- 答题阶段（`phase === 'answering'`）才渲染该按钮；结果阶段不渲染

按钮样式遵循 Socratic 原则：视觉权重**低于**"提示"和"讲一讲"按钮（用 `text-secondary` + `bg-base`，非 brand 色），尺寸 38×38 与其他按钮一致。

### 4.3 新页面 `HiddenQuestionsPage`

文件：`apps/web/src/pages/student/training/HiddenQuestionsPage.tsx`（新建）

路由：`/student/training/targeted/hidden`（在路由配置中新增）

布局：
- `PageHeader` to=`/student/training/targeted` caption="返回专项练习" title="我的不再展示清单"
- 顶部"全部重置"按钮（带 Modal 二次确认）
- 列表：每行展示题面预览（80 字截断）、题型 chip、知识点名、标记时间、"撤销"按钮
- 空状态：`kps == null` 加载中（Skeleton）；`length === 0` 提示"暂无标记的题目"
- 撤销单条：调 `unmarkTrainingHidden(questionId)`，成功后从列表移除 + toast
- 全部重置：调 `unmarkAllTrainingHidden()`，成功后清空列表 + toast

主题：`student-theme-container`（沉浸层夜间模式同配置页）。

### 4.4 `TargetedConfigPage` 加清单入口

文件：`apps/web/src/pages/student/training/TargetedConfigPage.tsx`

在 `PageHeader` 下方、配置卡片之上加一个工具条，右侧放"我的不再展示清单"次级按钮（`Button variant="secondary" size="sm"`），点击 `navigate('/student/training/targeted/hidden')`。

### 4.5 `api.ts` 新增 4 个函数

文件：`apps/web/src/services/api.ts`

```ts
export interface HiddenQuestion {
  questionId: number;
  questionText: string;
  type: string;
  kpName: string | null;
  markedAt: string;
}

/** 标记某题不再展示（幂等）。 */
export function markTrainingHidden(payload: {
  questionId: number;
  subjectId: number;
}): Promise<void> {
  return fetchApi<void>('/training/hidden/mark', {
    method: 'POST', body: JSON.stringify(payload),
  });
}

/** 拉取不再展示清单。 */
export function listTrainingHidden(subjectId: number): Promise<HiddenQuestion[]> {
  const qs = new URLSearchParams({ subjectId: String(subjectId) });
  return fetchApi<HiddenQuestion[]>(`/training/hidden?${qs.toString()}`);
}

/** 撤销单条标记。 */
export function unmarkTrainingHidden(questionId: number): Promise<void> {
  return fetchApi<void>(`/training/hidden/${questionId}`, { method: 'DELETE' });
}

/** 全部重置。 */
export function unmarkAllTrainingHidden(): Promise<void> {
  return fetchApi<void>('/training/hidden', { method: 'DELETE' });
}
```

### 4.6 路由配置

专项训练路由（在 student 路由配置中）新增子路由：

```
/student/training/targeted       -> TargetedConfigPage
/student/training/targeted/run   -> TargetedRunPage
/student/training/targeted/hidden -> HiddenQuestionsPage   (新增)
```

## 5. 边界与错误处理

| 场景 | 处理 |
|---|---|
| 重复标记同一题 | `INSERT IGNORE` 幂等，返回 `{ code:0, data:null }`，不报错 |
| 撤销不存在的标记 | `DELETE WHERE student_id=? AND question_id=?` 删 0 行也返回 `{ code:0, data:null }`（幂等） |
| 标记已删题（`question_id` 不存在） | service 层 `findById` 校验 → 404 |
| 题池排除后为空 | 后端返回 `{ questions: [] }`，前端配置页 `emptyHint` 提示"该专项题目已练完，可在清单页重置不再展示记录"（沿用现有 `emptyHint` 文案分支，文案略调） |
| IDOR 攻击（A 生撤销 B 生的标记） | repo 层 `WHERE` 含 `student_id`，从 JWT 取，不接受 body 传 studentId |
| 标记后当前会话 | 当前题单（`sessionStorage`）不变，学生可继续作答；排除仅下次开练生效 |
| `findRandomByKpAndType` 签名变更 | 全量搜索调用方，同步更新（当前仅 `TrainingService.startTargetedPractice` 一处） |

## 6. 测试

### 6.1 后端

- `student-hidden-questions.repo.spec.ts`（新建）：mock pool，覆盖 mark/unmark/unmarkAll/findAllByStudent 的 SQL 与参数
- `training.service.spec.ts`（更新）：新增 4 个方法的单测；`startTargetedPractice` 单测加 `studentId` 参数
- `questions.repo.spec.ts`（更新）：`findRandomByKpAndType` 单测加 `studentId` 参数，验证 LEFT JOIN SQL 含 `shq.id IS NULL`
- `training.controller.spec.ts`（更新，若存在）：新增 4 个端点的 e2e，覆盖鉴权、参数校验、幂等

### 6.2 前端

- 手测：配置页 → 开练 → 标记一题 → 完成会话 → 再开练验证该题不再出现 → 清单页撤销 → 再开练验证该题重新出现
- 手测：全部重置后所有题重新可抽
- 手测：题池全标记 → 开练返回空 + 提示文案

无前端单测框架（CLAUDE.md：apps/web 未配置 test framework）。

## 7. 文档同步

按 CLAUDE.md「API 文档同步规则」：
1. `docs/api/openapi.yaml`：新增 4 个端点（POST /training/hidden/mark、GET /training/hidden、DELETE /training/hidden/:questionId、DELETE /training/hidden）；更新 POST /training/targeted/start 的请求说明（虽 body 不变，但行为依赖 JWT 用户身份做排除）
2. `docs/API接口与数据流设计文档.md`：§4 端点清单加 4 项；§6 数据流补"专项训练选题排除已标记题"路径
3. `docs/K12智学系统-产品需求文档.md`：若 PRD 有专项训练章节，补"不再展示"子功能描述
4. `tools/db/schema.sql`：加 `student_hidden_questions` 建表语句
5. `docs/ai-core-changelog.md`：加 2026-09-04 条目记录本次新增

## 8. 实施清单

1. DB：`tools/db/schema.sql` 加表；本地 `install_mysql.sh` 重跑或手 ALTER
2. 后端 repo：新建 `student-hidden-questions.repo.ts` + types + index 导出
3. 后端 repo 改：`questions.repo.ts` `findRandomByKpAndType` 签名 + SQL
4. 后端 service：`training.service.ts` 改 `startTargetedPractice` + 4 新方法
5. 后端 controller：`training.controller.ts` 改 `startTargetedPractice` + 4 新端点
6. 后端 module：`training.module.ts` 注册新 repo
7. 后端测试：新增 + 更新 spec
8. 前端组件：`QuestionRunner.tsx` 加 `questionMetaActions` 插槽
9. 前端答题页：`TargetedRunPage.tsx` 加按钮 + 确认 Modal
10. 前端清单页：新建 `HiddenQuestionsPage.tsx`
11. 前端配置页：`TargetedConfigPage.tsx` 加清单入口
12. 前端 API：`api.ts` 加 4 函数
13. 前端路由：加 `/student/training/targeted/hidden`
14. 文档：openapi.yaml + API 设计文档 + schema + changelog + PRD（如适用）
15. 验证：`apps/server` 跑 `npm test`；`apps/web` 跑 `npm run lint` + `npm run build`；手测路径

## 9. 不做的事（YAGNI）

- 不做"撤销入口放家长端"——决策已确认仅学生端
- 不做"结果页补标记"——本次只覆盖答题阶段
- 不做"按知识点细分排除"——决策已确认专项训练内全局排除
- 不做"标记后强制跳题"——标记后当前题仍在当前会话，不踢出
- 不做"隐藏标记的统计/导出"——无业务需求
- 不做"主线练习 / 错题重做也支持隐藏"——本次仅专项训练；未来扩展时在对应选题 SQL 加同样 LEFT JOIN 即可
