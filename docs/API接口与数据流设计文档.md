# K12 智学系统 — API 接口与数据流设计文档

> 版本：v1.0
> 对应文档：
> - [K12智学系统-产品需求文档.md](./K12智学系统-产品需求文档.md)（PRD）
> - [K12智学系统-架构设计文档.md](./K12智学系统-架构设计文档.md)（架构）
> - [UX-UI设计文档.md](./UX-UI设计文档.md)

---

## 1. 文档说明

### 1.1 目的

本文档是面向前后端开发的 API 契约与数据流实现基准。它承接架构设计文档 §5/§7 的高层描述，细化到每个端点的 HTTP 方法、路径、请求/响应结构、数据流调用序列，使前端 `services/` 层与后端 Controller/Service 层可同步启动。

### 1.2 范围

- 所有 REST API 端点（MVP 必做 + P1/P2 标记）
- WebSocket 通道定义
- 核心业务流程的端点级时序
- 前端页面与 API 的映射关系

### 1.3 与上游文档的关系

| 本文档章节 | 引用上游文档 |
|---|---|
| §3 服务分组 | 架构 §7.1、§4.2 |
| §5 数据流 | 架构 §5、PRD §6/§7 |
| §6 前端映射 | UX 文档、PRD §6/§7、前端路由 |
| §7 MVP 范围 | PRD §13、架构 §10.1 |

### 1.4 术语表

| 术语 | 含义 |
|---|---|
| 主线 | 课程闯关路径，错题清零是解锁前置条件 |
| 辅线 | 自由探索/答疑路径，不影响主线进度 |
| 清零 | 错题做对一次后从待清零列表移除 |
| 变式 | 基于原题知识点/题型/难度动态生成的新题 |
| 兜底 | AI 连续 3 次引导失败后的完整解析输出 |
| 温和阻断 | 非学习内容不封禁，而引导回学习场景 |

---

## 2. 设计约定

### 2.1 基础 URL 与版本

- 开发环境：`http://localhost:3000/api`
- 生产环境：`https://api.example.com/api`
- **MVP 不引入 URL 版本号**（`/api/v1` 留待 P1），统一使用 `/api/*`

### 2.2 认证

- REST：请求头携带 `Authorization: Bearer <JWT>`
- WebSocket：连接时通过 query param `?token=<JWT>` 传递
- JWT Payload 至少包含：`userId`、`role`（`parent` / `student`）、`familyId`
- 学生子账号 JWT 额外包含：`parentId`

### 2.3 通用响应体

```json
{
  "code": 0,
  "message": "success",
  "data": { ... }
}
```

- `code = 0` 表示成功；非 0 为业务错误码
- HTTP 状态码：200 成功，400 参数错误，401 未认证，403 无权限，404 资源不存在，429 限流，500 服务端错误

### 2.4 错误码

| 错误码 | 说明 |
|---|---|
| 0 | 成功 |
| 1001 | 参数校验失败 |
| 1002 | 资源不存在 |
| 1003 | 无权访问（非本人数据） |
| 1004 | 操作被拒绝（如未清零强行解锁） |
| 1005 | AI 额度不足 |
| 1007 | 优惠券无效或已过期 |
| 1008 | 订单已支付或已取消 |
| 1009 | 支付失败（第三方平台返回错误） |
| 2001 | 学习无关内容（AI 阻断） |

### 2.5 文件上传约定

- 统一走 `POST /api/files/upload`，返回 `{ fileId, url }`（PDF 上传额外返回 `taskId` 供 SSE 监听提取进度）
- 其他接口通过 `fileId` 或 `url` 引用文件
- 手写/拍照答案提交时，先上传文件，再在答案接口中传入 `attachmentFileIds`

### 2.6 幂等性

- 所有涉及资金/奖励/写入的 mutation 接口支持 `Idempotency-Key` 请求头
- 服务端以 `Idempotency-Key` + `userId` 为维度做 24h 去重

---

## 3. 服务与接口分组

| 分组 | 前缀 | 主要职责 | 对应架构 §4.2 |
|---|---|---|---|
| Auth | `/api/auth` | 登录、注册、登出 | Auth Service |
| Users | `/api/users` | 家长/学生账号、子账号管理 | Auth Service |
| Progress | `/api/progress` | 按学科记录的学生学习进度与解锁状态 | ErrorBook + Progress |
| Content | `/api/content` | 学科、版本、单元、课、卡片、知识点、题库 | Content Service |
| Knowledge Graph | `/api/knowledge-graph` | 知识点关系、薄弱点、学情 overlay | KnowledgeGraphService |
| Assessment | `/api/assessment` | 作业、单元测、期中期末、成绩报告 | Assessment Service |
| AI | `/api/ai` | 苏格拉底辅导、判题、组卷、解析、变式、报告 | AI-Agent 中枢 |
| Refinery | `/api/refinery` | 图片/PDF 题目识别与提取 | Data Refinery |
| Files | `/api/files` | 文件上传、签名 URL | 基础设施 |
| ErrorBook | `/api/error-book` | 双错题本、重做、清零、薄弱点统计 | ErrorBook Service |
| Conversations | `/api/conversations` | 会话创建、消息读写、上下文加载 | ConversationService |
| Rewards | `/api/rewards` | 奖励发放、领取、兑现记录 | Reward Service |
| Parent | `/api/parent` | 报告、对话回放、目标、管控、预警 | ParentAdmin Service |
| Quota | `/api/quota` | AI 套餐额度、消耗查询与订阅状态 | AI-Agent 中枢 |
| Billing | `/api/billing` | 订单创建、支付、优惠券、续费 | Billing Service |
| Practice | `/api/practice` | 课堂练习答题判对错（practice 卡片） | Practice Service |

---

## 4. REST 端点清单

### 4.1 Auth — `/api/auth`

| 方法 | 路径 | 说明 | 阶段 |
|---|---|---|---|
| POST | `/api/auth/register` | 家长注册（手机号 + 密码 + 监护人协议同意） | MVP |
| POST | `/api/auth/login` | 统一登录；按用户名格式分流（手机号→家长，否则→学生） | MVP |
| POST | `/api/auth/logout` | 登出，使当前 Token 失效 | MVP |
| POST | `/api/auth/password/reset-request` | 请求重置密码（MVP 阶段发送短信验证码） | MVP |
| POST | `/api/auth/password/reset` | 确认重置密码（验证码 + 新密码） | MVP |
| GET | `/api/auth/me` | 获取当前登录身份 | MVP |

### 4.2 Users — `/api/users`

| 方法 | 路径 | 说明 | 阶段 |
|---|---|---|---|
| GET | `/api/users/parents/me` | 当前家长资料 | MVP |
| PATCH | `/api/users/parents/me` | 更新家长资料 | MVP |
| GET | `/api/users/students` | 当前家长下的学生子账号列表 | MVP |
| POST | `/api/users/students` | 创建学生子账号（强制年龄/年级） | MVP |
| GET | `/api/users/students/{studentId}` | 学生资料 | MVP |
| PATCH | `/api/users/students/{studentId}` | 更新学生资料 | MVP |
| DELETE | `/api/users/students/{studentId}` | 删除学生子账号 | P1 |
| GET | `/api/users/students/{studentId}/settings` | 学生 UI 设置（主题、字号、动效） | MVP |
| PATCH | `/api/users/students/{studentId}/settings` | 更新学生 UI 设置 | MVP |

### 4.3 Progress — `/api/progress`

| 方法 | 路径 | 说明 | 阶段 |
|---|---|---|---|
| GET | `/api/progress/students/{studentId}/overview` | 各学科进度总览：每科的当前单元/课、下一解锁节点、清零状态 | MVP |
| GET | `/api/progress/students/{studentId}/subjects/{subjectId}` | 单学科完整进度与解锁链（家长关注具体科目时调用） | MVP |
| GET | `/api/progress/students/{studentId}/star-map?subjectId=` | 单学科知识星图：把学生进度 overlay 到教材结构，返回可直接渲染的章节/小节树（含解锁/锁定/进行中状态）。服务端从 JWT 取 studentId（URL 段仅作资源定位，须与登录身份一致，否则 403）；教材版本按学科 + 学生学段（grade_band）解析；学期按 `progress.current_semester_id` 选择，无进度记录时回退到该年级 `sort_order` 最小学期（上册）。P2.1 星图页调用。 | MVP |
| POST | `/api/progress/update` | 学生翻页时上报当前卡片位置，更新 `current_card_sort` 与 `next_unlock_type`；遇到 practice 卡片切换为练习阶段，到达最后一页自动推进到下一课或标记学科完成。复习（往前翻页）不会回退进度。当 `reason=not_current_lesson` 时返回 `currentLessonId`，供前端获取当前进度中的下一课 ID。P2.2 课程详情页调用。 | MVP |
| POST | `/api/progress/students/{studentId}/events` | 记录学习事件（由 Assessment/Reward 内部调用或开放） | P1 |

> **学生当前学期的确定规则**：`progress` 表（unique `(student_id, subject_id)`）的 `current_semester_id` 是唯一事实源，由家长端在配置/开通学生时写入（如九年级生选九上或九下）。星图与后续学习流程一律读此字段决定展示哪一册；系统不按日历自动推断学期。学生尚无 `progress` 记录时，star-map 回退到该学段教材版本中 `sort_order` 最小的学期（即上册）作为默认展示。

### 4.4 Content — `/api/content`

| 方法 | 路径 | 说明 | 阶段 |
|---|---|---|---|
| GET | `/api/content/subjects` | 学科列表 | MVP |
| GET | `/api/content/subjects/{subjectId}` | 学科详情 | MVP |
| GET | `/api/content/versions` | 教材版本列表（可按学科/学段过滤） | MVP |
| GET | `/api/content/versions/{versionId}` | 版本详情 | MVP |
| GET | `/api/content/versions/{versionId}/units` | 单元列表 | MVP |
| GET | `/api/content/versions/{versionId}/units/{unitId}` | 单元详情 | MVP |
| GET | `/api/content/versions/{versionId}/units/{unitId}/lessons` | 课列表 | MVP |
| GET | `/api/content/versions/{versionId}/units/{unitId}/lessons/{lessonId}` | 课详情 | MVP |
| GET | `/api/content/versions/{versionId}/units/{unitId}/lessons/{lessonId}/cards` | 教材卡片列表 | MVP |
| GET | `/api/content/cards/{cardId}` | 单张卡片内容 | MVP |
| GET | `/api/content/knowledge-points` | 知识点列表/搜索 | MVP |
| GET | `/api/content/knowledge-points/{knowledgePointId}` | 知识点详情 | MVP |
| GET | `/api/content/questions` | 题库查询（按知识点/难度/来源/题型） | MVP |
| GET | `/api/content/questions/{questionId}` | 题目详情 | MVP |

### 4.5 Knowledge Graph — `/api/knowledge-graph`

| 方法 | 路径 | 说明 | 阶段 |
|---|---|---|---|
| GET | `/api/knowledge-graph/knowledge-points/{id}/relations` | 知识点前置/包含关系 | MVP |
| GET | `/api/knowledge-graph/students/{studentId}/mastery` | 学生知识点掌握度 overlay | MVP |
| GET | `/api/knowledge-graph/students/{studentId}/weak-points` | 薄弱点 TOP N 与推荐 | MVP |
| GET | `/api/knowledge-graph/students/{studentId}/learning-path` | 基于薄弱点的建议复习路径 | P1 |

### 4.6 Assessment — `/api/assessment`

| 方法 | 路径 | 说明 | 阶段 |
|---|---|---|---|
| GET | `/api/assessment/students/{studentId}/homework` | 当前待做作业列表（默认当前学科，可传 `?subject=` 筛选） | MVP |
| GET | `/api/assessment/homework/{homeworkId}` | 作业详情（题目列表） | MVP |
| POST | `/api/assessment/homework/{homeworkId}/submissions` | 开始一次作业作答 | MVP |
| POST | `/api/assessment/homework/{homeworkId}/submissions/{submissionId}/submit` | 提交作业 | MVP |
| GET | `/api/assessment/exams` | 考试列表（单元测/期中/期末；默认当前学科，可传 `?subject=` 筛选） | MVP |
| POST | `/api/assessment/exams` | 创建考试（系统触发，如学完单元最后一课） | MVP |
| GET | `/api/assessment/exams/{examId}` | 考试详情 | MVP |
| POST | `/api/assessment/exams/{examId}/submissions` | 开始考试 | MVP |
| POST | `/api/assessment/exams/{examId}/submissions/{submissionId}/save` | 自动保存当前作答 | MVP |
| POST | `/api/assessment/exams/{examId}/submissions/{submissionId}/submit` | 提交考试 | MVP |
| GET | `/api/assessment/submissions/{submissionId}` | 提交记录与状态 | MVP |
| GET | `/api/assessment/submissions/{submissionId}/results` | 批改结果与解析 | MVP |
| POST | `/api/assessment/submissions/{submissionId}/answers/{answerId}/hint` | 请求“下一步提示” | MVP |
| POST | `/api/assessment/submissions/{submissionId}/answers/{answerId}/explain` | 请求 AI 讲解 | MVP |
| POST | `/api/assessment/submissions/{submissionId}/answers` | 提交/更新单题答案（支持附件） | MVP |

### 4.7 AI — `/api/ai`

| 方法 | 路径 | 说明 | 阶段 |
|---|---|---|---|
| POST | `/api/ai/tutor` | 苏格拉底辅导（主线/辅线） | MVP |
| POST | `/api/ai/hint` | 生成下一步提示 | MVP |
| POST | `/api/ai/explain` | 生成讲解/重讲 | MVP |
| POST | `/api/ai/grade` | 主观题按步骤给分 | MVP |
| POST | `/api/ai/variation` | 生成变式题 | MVP |
| POST | `/api/ai/report` | 生成学情报告内容 | MVP |
| POST | `/api/ai/anomaly/detect` | 内部：输入分类（学习/闲聊/异常） | P1 |
| GET | `/api/ai/quota` | 当前家庭账号 AI 额度 | MVP |

### 4.8 Refinery — `/api/refinery`

| 方法 | 路径 | 说明 | 阶段 |
|---|---|---|---|
| POST | `/api/refinery/extract` | 实时提取：图片/PDF → 结构化题目 | MVP |
| GET | `/api/refinery/tasks/{taskId}` | 查询提取任务状态与结果 | MVP |
| GET | `/api/refinery/tasks/{taskId}/stream` | SSE 提取进度推送（PDF 上传后自动连接） | MVP |
| POST | `/api/refinery/batch/jobs` | 创建批量处理任务（离线/管理后台） | P1 |
| GET | `/api/refinery/batch/jobs/{jobId}` | 批量任务状态 | P1 |

### 4.9 Files — `/api/files`

| 方法 | 路径 | 说明 | 阶段 |
|---|---|---|---|
| POST | `/api/files/upload` | 通用文件上传（图片/PDF） | MVP |
| GET | `/api/files/{fileId}` | 文件元数据 | MVP |
| GET | `/api/files/{fileId}/signed-url` | 获取临时签名访问 URL | P1 |

### 4.10 ErrorBook — `/api/error-book`

| 方法 | 路径 | 说明 | 阶段 |
|---|---|---|---|
| GET | `/api/error-book/students/{studentId}/main` | 主线错题本列表（默认当前学科，可传 `?subject=` 筛选） | MVP |
| GET | `/api/error-book/students/{studentId}/aux` | 辅线错题本列表（默认当前学科，可传 `?subject=` 筛选） | MVP |
| GET | `/api/error-book/items/{errorItemId}` | 错题详情 | MVP |
| POST | `/api/error-book/items/{errorItemId}/redo` | 提交错题重做答案 | MVP |
| POST | `/api/error-book/items/{errorItemId}/clear` | 标记错题已清零 | MVP |
| GET | `/api/error-book/items/{errorItemId}/explanation` | 获取 AI 解析 | MVP |
| GET | `/api/error-book/items/{errorItemId}/variations` | 获取变式题列表 | MVP |
| POST | `/api/error-book/items/{errorItemId}/variations/{variationId}/submit` | 提交变式题答案 | MVP |
| POST | `/api/error-book/aux` | 创建辅线错题（拍照/输入确认后录入） | MVP |
| GET | `/api/error-book/students/{studentId}/stats` | 错题统计与薄弱点（默认当前学科，可传 `?subject=` 筛选） | MVP |
| GET | `/api/error-book/students/{studentId}/clear-status` | 当前待清零状态（默认当前学科，可传 `?subject=` 筛选；用于解锁判断） | MVP |

### 4.11 Conversations — `/api/conversations`

| 方法 | 路径 | 说明 | 阶段 |
|---|---|---|---|
| GET | `/api/conversations` | 查询会话列表（按学生/时间/类型过滤） | MVP |
| POST | `/api/conversations` | 创建新会话 | MVP |
| GET | `/api/conversations/{dialogueId}` | 会话元数据 | MVP |
| PATCH | `/api/conversations/{dialogueId}` | 更新会话标题 | MVP |
| DELETE | `/api/conversations/{dialogueId}` | 软删除会话（deleted_at，列表自动排除） | MVP |
| GET | `/api/conversations/{dialogueId}/messages` | 消息历史 | MVP |
| POST | `/api/conversations/{dialogueId}/messages` | 发送用户消息（非流式兜底） | MVP |
| GET | `/api/conversations/{dialogueId}/context` | 加载截断后的上下文（供 AI-Agent 内部使用） | P1 |

### 4.12 Rewards — `/api/rewards`

| 方法 | 路径 | 说明 | 阶段 |
|---|---|---|---|
| GET | `/api/rewards/students/{studentId}` | 学生全部奖励记录 | MVP |
| GET | `/api/rewards/students/{studentId}/available` | 待领取奖励 | MVP |
| POST | `/api/rewards/students/{studentId}/claim/{rewardId}` | 领取奖励 | MVP |
| GET | `/api/rewards/students/{studentId}/history` | 奖励历史 | MVP |
| GET | `/api/rewards/parents/{parentId}/pending` | 家长端待兑现物质奖励 | MVP |
| POST | `/api/rewards/{rewardRecordId}/redeem` | 家长确认兑现 | MVP |
| POST | `/api/rewards/{rewardRecordId}/fulfill` | 标记物质奖励已履约 | MVP |

### 4.13 Parent — `/api/parent`

| 方法 | 路径 | 说明 | 阶段 |
|---|---|---|---|
| GET | `/api/parent/dashboard` | 家长仪表盘：按学科聚合的进度、正确率、薄弱点、异常预警 | MVP |
| GET | `/api/parent/students/{studentId}/reports` | 学情报告列表（可按学科筛选） | MVP |
| GET | `/api/parent/students/{studentId}/reports/{reportId}` | 单份报告详情 | MVP |
| GET | `/api/parent/students/{studentId}/errors` | 孩子错题本（只读；可传 `?subject=` 按学科筛选） | MVP |
| GET | `/api/parent/students/{studentId}/chat-logs` | AI 对话回放列表 | MVP |
| GET | `/api/parent/students/{studentId}/chat-logs/{dialogueId}` | 单条对话详情 | MVP |
| GET | `/api/parent/students/{studentId}/goals` | 学习目标列表 | MVP |
| POST | `/api/parent/students/{studentId}/goals` | 创建目标 | MVP |
| PATCH | `/api/parent/students/{studentId}/goals/{goalId}` | 更新目标 | MVP |
| DELETE | `/api/parent/students/{studentId}/goals/{goalId}` | 删除目标 | MVP |
| GET | `/api/parent/students/{studentId}/controls` | 行为管控配置 | MVP |
| PUT | `/api/parent/students/{studentId}/controls` | 更新行为管控 | MVP |
| GET | `/api/parent/students/{studentId}/rewards` | 奖励管理视图 | MVP |
| GET | `/api/parent/alerts` | 异常预警列表 | MVP |
| PATCH | `/api/parent/alerts/{alertId}/read` | 标记预警已读 | MVP |
| GET | `/api/parent/account` | 家长账号与订阅摘要 | MVP |
| PATCH | `/api/parent/account` | 更新账号信息 | P1 |

### 4.14 Quota — `/api/quota`

| 方法 | 路径 | 说明 | 阶段 |
|---|---|---|---|
| GET | `/api/quota/current` | 当前家庭套餐与额度 | MVP |
| GET | `/api/quota/usage` | 本周期 AI 消耗明细 | P1 |
| GET | `/api/quota/plans` | 可选套餐列表（含价格/折扣信息） | P1 |
| GET | `/api/quota/subscription` | 当前订阅状态（生效中/即将到期/已过期） | P2 |

### 4.15 Billing — `/api/billing`

| 方法 | 路径 | 说明 | 阶段 |
|---|---|---|---|
| GET | `/api/billing/orders` | 订单列表 | P2 |
| POST | `/api/billing/orders` | 创建订阅订单（选套餐 + 应用优惠券） | P2 |
| GET | `/api/billing/orders/{orderId}` | 订单详情 | P2 |
| POST | `/api/billing/orders/{orderId}/pay` | 发起支付（返回微信/支付宝支付参数） | P2 |
| POST | `/api/billing/callback/{channel}` | 支付回调（微信/支付宝异步通知） | P2 |
| POST | `/api/billing/orders/{orderId}/cancel` | 取消未支付订单 | P2 |
| GET | `/api/billing/coupons` | 可用优惠券列表 | P2 |
| POST | `/api/billing/coupons/{code}/apply` | 应用优惠码（下单前校验折扣） | P2 |
| POST | `/api/billing/subscription/renew` | 续费（创建续费订单） | P2 |

### 4.16 Practice - `/api/practice`

| 方法 | 路径 | 说明 | 阶段 |
|---|---|---|---|
| POST | `/api/practice/judge` | 课堂练习判对错。学生在 practice 卡片答题后调用，返回对错、判定方法与解析；答错自动入主线错题本（`main_error_books.source='practice'`）。三路由：(1) 题库命中 + 客观题（choice/true_false/fill_blank）-> exact 答案比对；(2) 题库命中主观题（short_answer/proof）或未命中 -> AI JudgmentCapability 判定；(3) 答错 -> 写入 `main_error_books`（未入库的题先经 QuestionStructuringCapability 结构化后插 `questions` 表，结构化失败则 `question_id=NULL` 仅存题面到 `wrong_answer_text`）。AI 判定失败返回 503（`code=5001`，不写错题本）。请求体：`{cardId, lessonId, subjectId, questionText, studentAnswer}`；响应：`{questionId(nullable), isCorrect, method:'exact'|'ai', analysis(nullable), errorType(nullable, enum: logic/calculation/format/missing), errorBookId(nullable)}`。题面来源：`cards.content_metadata.questions[].text`（管线抽取）。 | MVP |
| POST | `/api/practice/hint` | 课堂练习提示（AI 生成 + Card 级缓存）。学生在 practice 卡片答题前点「提示」调用。先查 `cards.hints` 缓存（JSON：`{ "<题目文本>": "<提示文本>" }`，key 即「题目标题」）命中直返（不调 AI）；未命中则调 HintCapability 生成苏格拉底式提示（只启发不给答案，遵循 Socratic 原则）并写回 `cards.hints`，供后续复用（Card 级共享，不分学生，省 AI）。AI 生成失败返回 503（`code=5001`，前端降级显示静态文案，不阻断答题）。请求体：`{cardId, lessonId, subjectId, questionText}`；响应：`{hint, cached:boolean}`。 | MVP |
| POST | `/api/practice/discuss` | 课堂练习「让 AI 讲一讲」（苏格拉底讨论）。学生在 practice 卡片答题前点「让 AI 讲一讲」调用。打开讨论即：① 记入主线错题本（find-or-create 幂等，`main_error_books.source='discuss'`，无论后续答对答错都保留）；② **对话也 find-or-create**（B方案）：错题本记录加 `dialogue_id` 字段，重开时若该对话仍可用则复用，否则新建并回写。前端据 `dialogueId` 走 `POST /api/ai/tutor/stream`（mode=mainline）做苏格拉底式多轮讨论——TutoringCapability 据 `card_id` 解析 `cardContent` 限定范围（只能讨论该卡片内容，不能聊其它），3 次失败/放弃后兜底给完整解析。`questionId` 用 `content_hash` 快查（不调 AI 结构化），未命中则 `question_id=NULL` + `wrong_answer_text` 存题面。请求体：`{cardId, lessonId, subjectId, questionText}`；响应：`{dialogueId, errorBookId, questionId(nullable)}`。 | MVP |
| POST | `/api/practice/discuss-card` | 卡片级「思辨答疑」（苏格拉底讨论）。学生在非 practice 知识卡片上点「思辨答疑」调用。与 `/practice/discuss` 区别：scope=整张卡片（非某道题），**不入错题本**（讨论知识非题目）；服务端按 `(student_id, card_id, track='mainline')` find-or-create mainline 对话，重开同一卡片自动回到同一讨论线。前端据 `dialogueId` 走 `POST /api/ai/tutor/stream`（mode=mainline）做苏格拉底讨论。请求体：`{cardId, lessonId, subjectId}`；响应：`{dialogueId}`。 | MVP |
| GET | `/api/practice/results?cardId={cardId}` | 取该练习卡持久化判题结果（对/错 + analysis 题解），驱动 ✓/✗ 跨设备/刷新回显。响应体：`[{questionN, questionText, studentAnswer, isCorrect, method, analysis, errorType}]`。 | MVP |
| DELETE | `/api/practice/results?cardId={cardId}` 或 `?lessonId={lessonId}` | 重置练习记录：`cardId` 清单卡、`lessonId` 清本课全部练习卡（二者互斥，同传/都缺 400）。只删 `practice_results`，不动 `main_error_books`。 | MVP |
| GET | `/api/practice/previous-errors?lessonId={lessonId}` | 查询当前课「上一节课」的未清零主线错题数，用于左侧阶段栏「错题清零」门禁。服务端按 `units.sort_order`/`lessons.sort_order` 推导上一课，再查 `main_error_books`（`student_id=当前学生, lesson_id=上一课, is_cleared=0`）。响应：`{lessonId(nullable): 上一课 id, count: number}`。当前课是整本教材第一课时返回 `{lessonId:null, count:0}`。 | MVP |

---

## 5. WebSocket 设计

### 5.1 通道定义

| 通道 | 路径 | 用途 |
|---|---|---|
| AI 辅导流 | `wss://host/ws/ai/{dialogueId}` | AI 辅导的 token 级流式响应 |
| 家长通知 | `wss://host/ws/notifications/{studentId}` | 异常预警、额度预警、目标提醒 |

### 5.2 连接管理

- **鉴权**：连接建立时携带 JWT（query param `?token=xxx`），服务端校验后绑定 `studentId` / `parentId`
- **心跳**：客户端 30s 发送一次 `ping`，服务端 60s 无响应断开
- **断线重连**：客户端指数退避（1s → 2s → 4s → ... 最大 30s），重连成功后携带 `lastMessageId` 请求补发离线期间消息
- **订阅模型**：家长通知通道支持按预警类型订阅/取消订阅
- **跨节点续接**：`dialogueId` 绑定到 ConversationService 持久化数据，节点切换后通过 `dialogueId` 无缝恢复上下文

### 5.3 消息格式（AI 通道示例）

```json
{
  "type": "token" | "full" | "error" | "safety_alert" | "heartbeat",
  "payload": {
    "content": "...",
    "messageId": "msg_xxx",
    "model": "kimi",
    "safety": { "isLearningRelated": true, "alertLevel": "none" }
  }
}
```

- `type=token`：逐字/token 推送（首字延迟 ≤1s）
- `type=full`：兜底或降级时的完整消息包
- `type=safety_alert`：触发安全预警时同步推送
- `type=heartbeat`：服务端心跳回应

### 5.4 降级策略

- WebSocket 不可用时，前端自动降级为 SSE（`GET /api/ai/tutor?stream=sse`）
- SSE 亦不可用时，降级为轮询（不推荐，仅作最后保底）

---

## 6. 核心数据流详细设计

以下时序描述将架构 §5 的高层流程细化到端点级别。

### 6.1 主线一课学习完整闭环

```text
学生登录
  │
  ▼
GET /api/progress/students/{id}/overview
  │  ├─ 若上一课/单元有未清零错题
  │  ▼
  │  跳转 P4.1 主线错题本
  │  POST /api/error-book/items/{id}/redo 或 /clear
  │  GET /api/error-book/students/{id}/clear-status（确认清零）
  │  ▼
  │  错题清零完成 → Reward Service 发放上一课/单元奖励
  │  GET /api/rewards/students/{id}/available
  │  POST /api/rewards/students/{id}/claim/{rewardId}
  │  ▼
  │  解锁下一节点，返回星图
  │
  ▼
GET /api/content/versions/{v}/units/{u}/lessons/{l}/cards
  │  获取本课所有卡片列表
  │  响应含 breadcrumb 字段（如"第2单元 › 第3课"），由服务端 JOIN lessons+units 一次算出，同课所有卡片共享
  ▼
学生浏览卡片（页码 X/N）
  │
  ├─ 点击「上一页」→ 回到上一张卡片（复习，不上报进度）
  ├─ 点击「下一页」→ 进入下一张卡片
  │      │
  │      ▼
  │   POST /api/progress/update（上报当前卡片位置）
  │      │  ├─ 遇到 practice 卡片 → next_unlock_type = 'practice'
  │      │  └─ 到达最后一页 → 自动推进到下一课或标记完成
  │      ▼
  │   最后一张卡片看完
  │      │
  │      ▼
  │   学生点击「开始作业」
  │
  ├─ [可选] 点击「讨论」
  │   ▼
  │   POST /api/conversations（创建主线会话，范围限定 cardId）
  │   WS /ws/ai/{dialogueId}（或 POST /api/ai/tutor）
  │   POST /api/conversations/{id}/messages（用户消息写入）
  │   AI 流式响应 → 前端展示
  │   ▼
  │   关闭讨论 → 回到当前卡片继续浏览
  │
  ▼
进入课后作业 → GET /api/assessment/students/{id}/homework
  │
  ▼
GET /api/assessment/homework/{homeworkId}
  │
  ▼
POST /api/assessment/homework/{homeworkId}/submissions（开始作答）
  │
  ▼
逐题作答 → POST /api/assessment/submissions/{sid}/answers
  │  ├─ 不会时：POST .../hint（下一步提示）
  │  └─ 需要讲解：POST .../explain（AI 讲解）
  │
  ▼
POST /api/assessment/homework/{homeworkId}/submissions/{sid}/submit
  │
  ▼
GET /api/assessment/submissions/{sid}/results
  │  ├─ 客观题：本服务按标准答案判分
  │  └─ 主观题：内部调用 AI-Agent GradingCapability，结果一并返回
  │
  ▼
错题写入主线错题本（系统内部调用 ErrorBook Service）
  │
  ▼
本课学习完成，等待下次进入新课时触发错题清零检查与奖励发放（见流程开头）
```

### 6.2 辅线自由探索与拍照录入

```text
学生进入 P3.1 辅线首页
  │
  ├─ 直接问 AI
  │  ▼
  │  POST /api/conversations（track=auxiliary）
  │  WS /ws/ai/{dialogueId}（开放范围，不限卡片）
  │  或 POST /api/ai/tutor（mode=auxiliary）
  │
  ├─ 拍照解题 / 输入答疑
  │  ▼
  │  POST /api/files/upload（上传图片/PDF）
  │  ▼
  │  POST /api/refinery/extract（实时提取题目）
  │  GET /api/refinery/tasks/{taskId}（轮询结果）
  │  ▼
  │  第三方 OCR/文档解析 → 结构化题目
  │  ▼
  │  AI-Agent 中枢拆解知识点 + 讲解
  │  ▼
  │  学生确认/编辑后 → POST /api/error-book/aux（写入辅线错题本）
  │  ▼
  │  可继续进入 P3.4 辅线对话或 P4.2 错题重做
  │
  └─ 浏览知识点
      ▼
      GET /api/content/knowledge-points
      ▼
      选择知识点 → P3.4 辅线对话

若辅线做题做错 → POST /api/error-book/aux（不影响主线）
```

### 6.2.1 PDF 上传→提取→SSE 通知时序

```text
前端 POST /api/files/upload (PDF)
  │  返回 { fileId, url, taskId }
  ▼
后端自动启动 MinerU 提取（异步）
  │
  ▼
前端连接 GET /api/refinery/tasks/{taskId}/stream (SSE)
  │  事件: data: {"type":"done"} | data: {"type":"error","message":"..."} | data: [DONE]
  │  超时: 120s
  ▼
提取完成 → 前端 POST /api/ai/tutor/stream
  │  attachments: [{ type: "file", fileId, taskId }]
  ▼
后端 AIService.resolveAttachments:
  │  TXT/MD → readFile UTF-8 string
  │  PDF → extract_tasks.result.markdown + 图片资源
  ▼
文件内容拼入 LLM user message，PDF 图片路由到多模态模型
```

### 6.3 AI 辅导请求处理流

```text
前端 WS 连接 /ws/ai/{dialogueId}（或 POST /api/ai/tutor）
  │
  ▼
API Gateway 鉴权（JWT 校验）
  │
  ▼
AI-Agent 中枢接收请求
  │
  ▼
SafetyGuard 判断：
  │  ├─ 非学习 / 异常输入
  │  │  ▼
  │  │  温和阻断话术返回前端
  │  │  SafetyGuard 写入 safety_alerts（家长端实时推送）
  │  │  WS /ws/notifications/{studentId} 推送预警
  │  │
  │  └─ 学习相关内容
  │      ▼
  │      ModelRouter 选择模型
  │      ▼
  │      PromptBuilder 组装提示词（主线限定 cardId，辅线开放）
  │      ▼
  │      ContextManager 注入历史上下文（从 ConversationService 加载）
  │      ▼
  │      调用对应大模型 API
  │      ▼
  │      ResponseParser 解析（LaTeX/JSON 结构化）
  │      ▼
  │      流式输出至前端（token 级推送）
  │      ▼
  │      ConversationService 持久化 {用户消息 + AI 回复}
  │      ▼
  │      连续失败 3 次 → FallbackHandler 输出完整解析 + 知识点总结
```

### 6.4 错题升级与变式生成

```text
学生在错题本重做 → POST /api/error-book/items/{id}/redo
  │
  ▼
再次做错
  │
  ▼
ErrorBook Service 提升错题级别（L1→L2→...→L5）
  │
  ▼
POST /api/ai/variation
  │  请求参数：原题知识点、题型、难度、当前级别
  │
  ▼
AI-Agent 提取二级知识点 + 题型 + 难度
  │
  ▼
动态生成 1-2 道变式题（换数/换场景/调整条件）
  │
  ▼
Validator 逻辑自洽校验
  │  ├─ 失败 → 重新生成，最多 N 次（如 3 次）
  │  │
  │  └─ 通过
  │      ▼
  │      变式题存入 variation_questions
  │      ▼
  │      GET /api/error-book/items/{id}/variations 下发学生
  │      ▼
  │      POST /api/error-book/items/{id}/variations/{vid}/submit（学生作答）
```

### 6.5 奖励领取与兑现

```text
学生端：P2.9 闯关奖励页
  │
  ▼
GET /api/rewards/students/{id}/available
  │
  ▼
POST /api/rewards/students/{id}/claim/{rewardId}
  │
  ├─ 小学虚拟奖励：直接入账，GET /api/rewards/students/{id} 查看
  │  │
  │  └─ 中学物质奖励：生成待兑现记录
  │      ▼
  │      家长端 P6.7 收到待兑现提醒
  │      GET /api/rewards/parents/{parentId}/pending
  │      ▼
  │      家长确认 → POST /api/rewards/{recordId}/redeem
  │      ▼
  │      线下履约后 → POST /api/rewards/{recordId}/fulfill
```

### 6.6 订阅购买与续费

```text
家长端：P6.10 账号设置 / P7.1 订阅中心（P2 新增）
  │
  ├─ 查看套餐
  │  ▼
  │  GET /api/quota/plans
  │  GET /api/quota/subscription（当前订阅状态）
  │
  ├─ 应用优惠码
  │  ▼
  │  POST /api/billing/coupons/{code}/apply
  │  │  ├─ 有效 → 返回折扣后价格
  │  │  └─ 无效/过期 → 返回错误码
  │
  ▼
POST /api/billing/orders（创建订单：套餐 + 优惠码）
  │
  ▼
POST /api/billing/orders/{orderId}/pay
  │  ├─ 微信支付 → 返回 prepay_id / 调起参数
  │  └─ 支付宝 → 返回 trade_no / 调起参数
  │
  ▼
前端调起微信支付/支付宝
  │
  ▼
支付平台回调
POST /api/billing/callback/{channel}
  │  ├─ 成功 → 更新 subscription 状态，重置额度
  │  └─ 失败/超时 → 订单保持待支付，家长端可重新发起
  │
  ▼
GET /api/quota/subscription（确认生效）
```

**续费流程**：
```text
GET /api/quota/subscription（检测到即将到期）
  │
  ▼
推送续费提醒（WebSocket / 站内信）
  │
  ▼
家长端点击续费
POST /api/billing/subscription/renew
  │
  ▼
后续同购买流程：创建订单 → 支付 → 回调 → 生效
```

### 6.7 手写/主观题提交与 AI 按步骤给分流

```text
学生在作业/考试中遇到主观题/手写题
  │
  ▼
先上传手写图片 → POST /api/files/upload → 返回 fileId
  │
  ▼
POST /api/assessment/submissions/{sid}/answers
  │  请求体包含：answerText、attachmentFileIds
  │
  ▼
Assessment Service 接收答案
  │  ├─ 客观题（有标准答案）：直接判分，不走 AI
  │  │
  │  └─ 主观题 / 无标准答案客观题
  │      ▼
  │      内部调用 AI-Agent GradingCapability
  │      POST /api/ai/grade（内部调用，不对前端暴露独立端点）
  │      ▼
  │      按步骤给分 + 总评反馈
  │      ▼
  │      结果写入 answers 表
  │      ▼
  │      前端 GET /api/assessment/submissions/{sid}/results 获取批改结果
```

### 6.8 学情报告生成与展示

```text
触发时机：单元检测/期中/期末完成后，或家长主动刷新
  │
  ▼
ParentAdmin Service 聚合数据：
  │  - GET /api/progress/students/{id}/overview（进度）
  │  - GET /api/error-book/students/{id}/stats（错题统计）
  │  - GET /api/knowledge-graph/students/{id}/weak-points（薄弱点）
  │  - 读取 ai_messages（学习行为）
  │
  ▼
POST /api/ai/report（AI-Agent AnalyticsCapability 生成报告文本）
  │
  ▼
报告内容缓存并写入 learning_reports
  │
  ▼
家长端 GET /api/parent/students/{id}/reports/{reportId} 展示
```

### 6.9 课堂练习判对错

```text
学生在主线课程浏览到 practice 卡片（card_type='practice'）
  │
  ▼
前端读取 cards.content_metadata.questions[].text 渲染题面
  │  ├─ content_metadata.needs_fallback=true -> 前端正则兜底切题（LLM 抽题校验失败）
  │  └─ content_metadata.intro -> 题前说明（可选）
  │
  ▼
学生提交答案 -> POST /api/practice/judge
  │  请求体：{cardId, lessonId, subjectId, questionText, studentAnswer}
  │
  ▼
Practice Service 计算 contentHash -> questionsRepo.findByContentHash
  │
  ├─ 路由 1：题库命中 + 客观题（choice/true_false/fill_blank）
  │  ▼
  │  exact 答案比对（options.isCorrect 优先，退化为归一化字符串相等）
  │  method='exact'，答错 analysis 返回标准答案
  │
  └─ 路由 2：题库命中主观题（short_answer/proof）或未命中
     ▼
     AI JudgmentCapability.judge（questionType: proof/calculation）
     ▼
     ├─ 成功：method='ai'，返回 {isCorrect, analysis, errorType}
     └─ 失败：HTTP 503 code=5001（不写错题本，前端可重试）
  │
  ▼
判题结果分支（isCorrect）
  │
  ├─ 答错（!isCorrect）-> 写入主线错题本（find-or-create，避免重复答错堆积）
  │  │  ├─ 题库未命中 -> QuestionStructuringCapability.structure
  │  │  │  ├─ quality != poor && content 非空 -> questionsRepo.findOrCreate（含 content_hash 去重）
  │  │  │  │  └─ question_id = 新建/已有 question.id
  │  │  │  └─ quality == poor || structure 失败 -> question_id = NULL
  │  │  ▼
  │  │  mainErrorRepo.findUnclearedByStudentQuestion(student_id, question_id, cardId, questionText)
  │  │  ├─ 命中既有未清错题 -> 复用 errorBookId（不重复 create）
  │  │  └─ 未命中 -> mainErrorRepo.create({student_id, subject_id, question_id, source:'practice',
  │  │       source_ref_id:cardId, lesson_id, wrong_answer_text: question_id===NULL ? questionText : NULL})
  │  │       （孤儿题补偿：若刚创建了 question 但 create 失败，回滚删除 question）
  │  │
  └─ 答对（isCorrect）-> mainErrorRepo.clearUnclearedByStudentQuestion(student_id, question_id, cardId, questionText)
     │  把该题所有未清错题记录 is_cleared=1（不限 source，影响跨课门禁计数；best-effort，失败不阻断）
     │
     ▼
对/错都 upsert practice_results（best-effort；UNIQUE student_id+card_id+question_n，单题重做覆盖该行）
  │  字段：student_id, subject_id, card_id, lesson_id, question_id, question_n, question_text,
  │        student_answer, is_correct, method, analysis（仅错题）, error_type
  │
  ▼
响应返回前端：{questionId, isCorrect, method, analysis, errorType, errorBookId}
  │  ├─ isCorrect=true -> 前端展示正确反馈；该题未清错题记录已清零
  │  └─ isCorrect=false -> 前端展示解析，错题进入主线错题本（下次进入新课触发清零检查）
```

### 6.10 课堂练习提示（AI 生成 + Card 级缓存）

```text
学生在 practice 卡片答题前点「提示」
  │
  ▼
前端先查 session 缓存（practiceStore.hints[q.n]）命中 -> 直接展示，不请求后端
  │  └─ 未命中 -> POST /api/practice/hint
  │     请求体：{cardId, lessonId, subjectId, questionText}
  │
  ▼
Practice Service.getHint -> cardsRepo.findHintsById(cardId)
  │  读取 cards.hints（JSON：{ "<题目文本>": "<提示文本>" }）
  │
  ├─ 命中（hints[questionText] 存在）
  │  ▼
  │  直接返回 { hint, cached: true }（不调 AI）
  │
  └─ 未命中
     ▼
     AI HintCapability.generate（scene='hint'，苏格拉底式提示，只启发不给答案）
     ▼
     ├─ 成功：cardsRepo.upsertHint(cardId, questionText, hint) 写回 cards.hints
     │        返回 { hint, cached: false }
     └─ 失败：HTTP 503 code=5001（不写缓存，前端降级显示静态文案，不阻断答题）
  │
  ▼
前端 setHint(n, hint) 写入 session 缓存，用 ReactMarkdown+KaTeX 渲染提示（含 $...$ 公式）
  │  └─ 同题再次点提示 -> 命中 session 缓存，免请求
```

> 缓存是 Card 级共享（不分学生）：同一题对所有人都用同一提示，最大化省 AI。
> key = 题目文本（即「题目标题」），与 judge 流程传的 questionText 一致，自洽。

---

### 6.11 课堂练习「让 AI 讲一讲」（苏格拉底讨论）

```text
学生在 practice 卡片答题前点「让 AI 讲一讲」
  │
  ▼
前端检查 session 缓存（practiceStore.discussDialogues[questionText]）
  │
  ├─ 命中（已缓存 dialogueId）-> 续接：GET /api/conversations/{dialogueId}/messages 拉历史
  │
  └─ 未命中 -> POST /api/practice/discuss
     请求体：{cardId, lessonId, subjectId, questionText}
     │
     ▼
     Practice Service.startDiscuss
     ├─ ① questionsRepo.findByContentHash(questionText) -> questionId（未命中 null，不调 AI）
     ├─ ② mainErrorRepo.findUnclearedByStudentQuestion(...) 幂等查
     │     ├─ 已有未清除记录 -> 复用 errorBookId，不重复插入
     │     └─ 无 -> mainErrorRepo.create(source='discuss', source_ref_id=cardId, ...)
     └─ ③ **B方案：对话也 find-or-create**
           main_error_books.dialogue_id 为空/失效 -> conversationsService.create(track='mainline', cardId) 新建并回写 dialogue_id
           main_error_books.dialogue_id 仍可用 -> 复用同一对话（跨刷新/跨设备续接）
     ▼
     返回 { dialogueId, errorBookId, questionId }
  │
  ▼
前端缓存 dialogueId（practiceStore.discussDialogues[questionText]），自动发种子消息
  │  种子：「我想请你带我思考这道题：…请用提问的方式一步步启发我找到思路。」
  │  ⚠️ 避开 giveUpKeywords（不会/不懂/不知道…），否则首轮触发兜底直接给答案
  │
  ▼
POST /api/ai/tutor/stream（mode=mainline, dialogueId, message）-> SSE 流式
  │  TutoringCapability 据 card_id 解析 cardContent 限定范围（mainline.md 苏格拉底式）
  │  3 次失败/放弃 -> 兜底给完整解析
  ▼
前端 ReactMarkdown+KaTeX 渲染（含 $...$ 公式），支持多轮追问、停止、放大/缩小抽屉
```

> 讨论范围 = 该卡片 content（card_id 解析）；种子消息携带当前题面让 AI 聚焦。
> 错题本记录无论后续答对答错都保留（清除门禁尚未实现，`markCleared` 暂无调用方）。
> 抽屉仅手动关闭（开/关/放大），不自动收起--多轮对话需稳定展示。

### 6.12 卡片级「思辨答疑」（苏格拉底讨论）

```text
学生在非 practice 知识卡片上点「思辨答疑」
  │
  ▼
前端检查 session 缓存（practiceStore.discussDialogues[`card:${cardId}`]）
  │
  ├─ 命中（已缓存 dialogueId）-> 续接：GET /api/conversations/{dialogueId}/messages 拉历史
  │
  └─ 未命中 -> POST /api/practice/discuss-card
     请求体：{cardId, lessonId, subjectId}
     │
     ▼
     Practice Service.startCardDiscuss
     └─ conversationsService.findOrCreateMainlineByCard(studentId, cardId)
        按 (student_id, card_id, track='mainline') 查最近可用对话：
        ├─ 命中 -> 复用 dialogueId（跨刷新/跨设备续接同一讨论线）
        └─ 未命中 -> conversationsService.create(track='mainline', cardId) 新建
     ▼
     返回 { dialogueId }
  │
  ▼
前端缓存 dialogueId（practiceStore.setDiscussDialogue），自动发种子消息
  │  种子：「我想和你一起讨论这张卡片里的知识。请用提问的方式带我梳理其中的关键内容。」
  │  同样避开 giveUpKeywords
  │
  ▼
POST /api/ai/tutor/stream（mode=mainline, dialogueId, message）-> SSE 流式
  │  TutoringCapability 据 card_id 解析 cardContent 限定范围（整张卡片）
  │  3 次失败/放弃 -> 兜底给完整解析
  ▼
前端 ReactMarkdown+KaTeX 渲染（含 $...$ 公式），支持多轮追问、停止、放大/缩小抽屉
  │  抽屉宽度限定在右侧主内容区：缩小约 45%，放大封顶约 70%，不覆盖左侧阶段栏
```

> 与题目级区别：scope=整张卡片（非某题）；**不入错题本**（讨论知识非题目）；
> 续接锚 = `(student_id, card_id, track='mainline')` 而非 `error_book.dialogue_id`。

---

### 6.13 上一课错题清零门禁

```text
CourseDetailPage 加载 / 切课
  │
  ▼
GET /api/practice/previous-errors?lessonId={currentLessonId}
  │  JWT -> 取 studentId
  ▼
PracticeService.countUnclearedErrorsFromPreviousLesson(studentId, currentLessonId)
  ├─ LessonsRepository.findPreviousLessonId(currentLessonId)
  │    按 units.sort_order + lessons.sort_order 推导上一节课 id
  │    （同单元前一课 / 上一单元最后一课 / 跨学期类推；教材第一课返回 null）
  └─ MainErrorBooksRepository.countUnclearedByLesson(studentId, previousLessonId)
       查 main_error_books：student_id + lesson_id + is_cleared=0
  ▼
返回 { lessonId, count }
  │
  ▼
前端阶段栏：
  count > 0 -> 显示「错题清零（前一课）」未解锁
  count = 0 -> 隐藏该项或标记已完成
```

### 6.14 课堂练习结果持久化与 reset

```text
进 practice 卡 / 刷新 / 跨设备登录
  │
  ▼
前端 GET /api/practice/results?cardId=
  │  JWT -> 取 studentId
  │  响应：[{questionN, questionText, studentAnswer, isCorrect, method, analysis, errorType}]
  ▼
PracticeService.getResults -> PracticeResultsRepository.findByStudentCard
  └─ practiceStore.loadResults 填充 answers -> 题块显示 ✓/✗（analysis 供题解展示）
  │
  ▼
单题重做 -> POST /api/practice/judge（带 questionN）
  └─ ON DUPLICATE KEY UPDATE 覆盖该题行（UNIQUE student_id+card_id+question_n）
  │
  ▼
重置本卡：DELETE /api/practice/results?cardId= -> deleteByStudentCard + 前端 reset()
清空本课：DELETE /api/practice/results?lessonId= -> deleteByStudentLesson + 前端 reset()
  └─ reset 只删 practice_results，不碰 main_error_books（与错题本解耦）
```

---

## 7. API 与前端页面对照表

| 前端页面 | 路由 | 主要调用 API |
|---|---|---|
| P1.1 统一登录 | `/login` | `POST /api/auth/login`, `GET /api/auth/me` |
| 家长注册 | `/register` | `POST /api/auth/register` |
| P1.5 学科选择 | `/student/subjects` | `GET /api/content/subjects` |
| P2.1 星图导航 | `/student/star-map` | `GET /api/progress/students/{id}/star-map?subjectId=`（星图主数据）；`GET /api/progress/.../overview`（跨学科总览，可选） |
| P2.2 课程详情 | `/student/course-detail` | `GET /api/content/lessons/{lessonId}/cards`（卡片列表）；`GET /api/practice/previous-errors?lessonId=`（上一课未清零错题数，阶段栏门禁）；`POST /api/progress/update`（翻页上报进度）；卡片级讨论抽屉调 `POST /api/practice/discuss-card`；practice 卡「让 AI 讲一讲」抽屉调 `POST /api/practice/discuss` |
| P2.3 AI 讨论 | 已合并为抽屉 | 题目级讨论在 AnswerModal 内（`POST /api/practice/discuss`）；卡片级讨论在 CourseDetailPage 内（`POST /api/practice/discuss-card`）。均走 `POST /api/ai/tutor/stream` 流式。 |
| P2.4 课后作业 | `/student/homework` | `GET /api/assessment/homework/{id}`, `POST .../answers`, `POST .../hint` |
| P2.5 作业解析 | `/student/homework-result` | `GET /api/assessment/submissions/{id}/results` |
| P2.6 单元检测 | `/student/unit-test` | `GET /api/assessment/exams/{id}`, `POST .../submissions`, `POST .../save/submit` |
| P2.7 期中期末 | `/student/exam` | 同单元检测，scope 不同 |
| P2.8 成绩报告 | `/student/scores` | `GET /api/assessment/submissions/{id}/results`, `GET /api/knowledge-graph/.../weak-points` |
| P2.9 闯关奖励 | `/student/reward-unlock` | `GET /api/rewards/.../available`, `POST /api/rewards/.../claim/{id}` |
| P3.1 辅线首页 | `/student/auxiliary` | `GET /api/conversations?track=aux`, `GET /api/error-book/.../aux` |
| P3.2 知识点选择 | `/student/auxiliary/selector` | `GET /api/content/knowledge-points` |
| P3.3 拍照/输入答疑 | `/student/auxiliary/ask` | `POST /api/files/upload`, `POST /api/refinery/extract` |
| P3.4 辅线对话 | `/student/auxiliary/chat` | `POST /api/ai/tutor` (mode=auxiliary), WS `/ws/ai/{id}` |
| P4.1 双错题本 | `/student/error-book` | `GET /api/error-book/.../main`, `GET /api/error-book/.../aux` |
| P4.2 错题重做 | `/student/error-book/redo` | `POST /api/error-book/items/{id}/redo` |
| P4.3 解析与变式 | `/student/error-book/variant` | `GET /api/error-book/items/{id}/variations`, `POST .../variations/{vid}/submit` |
| P5.1 个人中心 | `/student/profile` | `GET /api/users/students/{id}`, `GET /api/progress/.../overview` |
| P5.2 奖励册 | `/student/rewards` | `GET /api/rewards/.../history` |
| P5.3 设置 | `/student/settings` | `GET/PATCH /api/users/students/{id}/settings` |
| P6.1 家长仪表盘 | `/parent/dashboard` | `GET /api/parent/dashboard`, `GET /api/parent/alerts`, WS `/ws/notifications/{id}` |
| P6.2 学情报告 | `/parent/report` | `GET /api/parent/students/{id}/reports` |
| P6.3 错题查看 | `/parent/errors` | `GET /api/parent/students/{id}/errors` |
| P6.4 AI 对话回放 | `/parent/chat-logs` | `GET /api/parent/students/{id}/chat-logs` |
| P6.5 目标设定 | `/parent/goals` | `GET/POST/PATCH/DELETE /api/parent/students/{id}/goals` |
| P6.6 行为管控 | `/parent/controls` | `GET/PUT /api/parent/students/{id}/controls` |
| P6.7 奖励管理 | `/parent/rewards` | `GET /api/parent/students/{id}/rewards`, `POST /api/rewards/{id}/redeem` |
| P6.8 多孩切换 | `/parent/children-switch` | `GET /api/users/students` |
| P6.9 异常预警 | `/parent/alerts` | `GET /api/parent/alerts`, `PATCH /api/parent/alerts/{id}/read` |
| P6.10 账号设置 | `/parent/account` | `GET /api/parent/account`, `GET /api/quota/current`, `GET /api/quota/subscription` |
| **P7.1 订阅中心（P2）** | `/parent/subscription` | `GET /api/quota/plans`, `GET /api/quota/subscription`, `POST /api/billing/orders`, `POST /api/billing/orders/{id}/pay` |
| **P7.2 订单管理（P2）** | `/parent/orders` | `GET /api/billing/orders`, `GET /api/billing/orders/{id}`, `POST /api/billing/orders/{id}/cancel` |
| **P7.3 优惠券（P2）** | `/parent/coupons` | `GET /api/billing/coupons`, `POST /api/billing/coupons/{code}/apply` |

---

## 8. MVP 范围与延期项

### 8.1 MVP 必做（首发数学学科）

- 账号体系：注册、登录、家长/学生身份、子账号创建（强制年龄/年级）
- 内容查询：学科、版本、单元、课、卡片、知识点
- 主线学习：星图导航、卡片浏览、AI 讨论（限定范围）、课后作业、单元检测
- AI 辅导：苏格拉底式辅导、提示、讲解、主观题按步骤给分、兜底机制、温和阻断
- 双错题本：自动录入、重做、清零、级别提升
- 家长端：仪表盘、报告、错题查看、对话回放、目标、管控、预警、奖励管理
- 文件上传与实时识别（拍照解题）
- AI 额度查询与预警

### 8.2 P1 阶段

- 期中/期末考试完整闭环
- 错题变式 AI 生成 + 逻辑校验
- 批量 Refinery 任务管理
- 删除子账号
- 签名 URL 访问控制
- 学习路径推荐

### 8.3 P2 阶段

- **订阅购买与支付集成**：
  - 套餐列表展示（月卡/年卡、价格、折扣）
  - 优惠券/优惠码（支持百分比折扣和固定金额减免）
  - 订单创建与支付（微信支付、支付宝）
  - 支付回调与状态同步
  - 续费提醒与一键续费
  - 订单管理（查看历史、取消未支付）
- 手写识别专用 API
- 刷新令牌与多端设备指纹
- 语音交互
- 语文/英语学科扩展
- 爬虫系统管理接口
- 学情社群/教师答疑

---

## 9. 关键 DTO 示例

本节提供少量核心接口的请求/响应结构示例，供前后端开发参考。完整 Schema 参见 `openapi.yaml`。

### 9.1 登录

**请求**：
```json
POST /api/auth/login
{
  "username": "13800138000",
  "password": "string"
}
```

**响应**：
```json
{
  "code": 0,
  "message": "success",
  "data": {
    "token": "jwt_string",
    "user": {
      "id": "usr_xxx",
      "role": "parent",
      "name": "张三"
    }
  }
}
```

### 9.2 AI 辅导

**请求**：
```json
POST /api/ai/tutor
{
  "studentId": "stu_xxx",
  "mode": "mainline",
  "cardId": "card_xxx",
  "message": "这句话我没看懂",
  "attachments": [
    { "type": "image", "fileId": "file_xxx" },
    { "type": "file", "fileId": "file_yyy", "taskId": 42 }
  ],
  "dialogueId": "dlg_xxx"
}
```

**响应**：
```json
{
  "code": 0,
  "data": {
    "dialogueId": "dlg_xxx",
    "message": {
      "role": "assistant",
      "content": "好，我们先不急着记公式。你平时走路去学校……",
      "type": "socratic"
    },
    "safety": {
      "isLearningRelated": true,
      "alertLevel": "none"
    },
    "fallback": false
  }
}
```

### 9.3 提交作业答案

**请求**：
```json
POST /api/assessment/submissions/{submissionId}/answers
{
  "questionId": "q_xxx",
  "answerText": "x = 3",
  "attachmentFileIds": ["file_xxx"],
  "requestHint": false
}
```

### 9.4 错题重做

**请求**：
```json
POST /api/error-book/items/{errorItemId}/redo
{
  "answerText": "x = 5",
  "attachmentFileIds": []
}
```

**响应**：
```json
{
  "code": 0,
  "data": {
    "isCorrect": false,
    "levelUp": true,
    "newLevel": 2,
    "explanationId": "exp_xxx",
    "variationIds": ["var_xxx"]
  }
}
```

---

## 10. 变更日志

| 版本 | 日期 | 说明 |
|---|---|---|
| v1.0 | 2026-06-26 | 初始版本，覆盖 MVP 核心接口与数据流 |
| v1.1 | 2026-08-01 | 新增 `POST /api/progress/update` 进度更新接口；更新 P2.2 课程详情左侧栏为数据驱动的 2~3 项结构（错题+学习内容+可选练习）；修复完成课程后进入下一课的 race condition，接口返回 `currentLessonId` 供前端定位下一课 |
| v1.2 | 2026-08-06 | 新增 `POST /api/practice/judge` 课堂练习判对错接口（MVP）；新增 Practice 服务分组；新增 §6.9 课堂练习判对错数据流；`main_error_books.source` 枚举补 `practice` 值 |
| v1.3 | 2026-08-09 | 新增 `POST /api/practice/hint` 课堂练习提示接口（MVP，AI 生成 + Card 级缓存）；`cards` 表新增 `hints` 字段（JSON 提示缓存，key=题目文本）；新增 §6.10 课堂练习提示数据流；ai-core 新增 `hint` 场景（HintCapability + prompts/hint/math.md，苏格拉底式提示不给答案） |
| v1.4 | 2026-08-09 | 新增 `POST /api/practice/discuss` 课堂练习「让 AI 讲一讲」接口（MVP，苏格拉底讨论）；打开讨论即记入主线错题本（`source='discuss'`，幂等 find-or-create）+ 创建带 `card_id` 的 mainline 对话；对话流复用 `POST /ai/tutor/stream`（mode=mainline）；接线 `card_id` 存储 + `loadContext` 解析 `cardContent`（修 mainline 范围 gap，auxiliary 不受影响）；新增 §6.11 数据流；前端 AnswerModal 内右侧抽屉（手动开关 + 放大缩小） |
| v1.5 | 2026-08-10 | B方案：题目级讨论历史续接——`main_error_books` 表新增 `dialogue_id`，`POST /api/practice/discuss` 复用已绑对话、失效则重建并回写；新增 `POST /api/practice/discuss-card` 卡片级「思辨答疑」接口（MVP），find-or-create 该学生在该卡片的 mainline 对话（不入错题本，锚=(student,card)），新增 §6.12 数据流；卡片级改为 CourseDetailPage 内右侧抽屉，放大封顶不盖左侧阶段栏；`/student/ai-discuss` 独立页取消，合并到课程详情/答题弹窗抽屉。 |
| v1.6 | 2026-08-10 | `main_error_books` 表新增 `lesson_id` 字段（冗余字段，用于按课快速定位未清零错题）；新增 `GET /api/practice/previous-errors?lessonId=` 查询当前课上一节课未清零错题数；新增 `LessonsRepository.findPreviousLessonId` + `PracticeService.countUnclearedErrorsFromPreviousLesson`；新增 §6.13 数据流；P2.2 课程详情页主要调用 API 补该端点；`main_error_books.source` 枚举补 `discuss`。
| v1.7 | 2026-08-11 | 新增 `practice_results` 表（课堂练习判题结果持久化，UNIQUE(student_id,card_id,question_n) 支撑单题重做 upsert）；新增 `GET/DELETE /api/practice/results`（取持久化结果 + 单卡/课程级 reset，与错题本解耦）；`JudgeRequest` 加 `questionN`；`judge` 答错改 find-or-create 错题本、答对 `clearUnclearedByStudentQuestion` 清该题未清错题（影响跨课门禁）、对/错都落 `practice_results`；新增 §6.14 数据流；§6.9 judge 流程更新。 |
