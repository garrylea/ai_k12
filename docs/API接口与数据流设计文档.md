# K12 智学系统 — API 接口与数据流设计文档

> 版本：v2.8
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

> **2026-09-16 实现注（POST 的成功码是 201，不是 200）**：NestJS 的 `@Post` 默认返回 **201**，
> 本仓没有端点用 `@HttpCode(200)` 覆盖，所以**所有 POST 成功时实际是 201**（实测
> `/api/training/vocabulary/*` 的三个 POST 均返回 201）。§4 端点清单里历史行写「200 成功」属笔误。
> `openapi.yaml` 中 2026-09-16 之后新增的 POST 端点按实际行为记 `'201'`；历史端点未逐个回改
> （改动面大、且不影响调用方——前端一律只看 `code` 字段）。以 `2xx` 判断成功即可。

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
| 3001 | 积分余额不足（兑换被拒） |
| 3002 | 未达该奖励的段位门槛 |
| 3003 | 奖励已下架 |
| 3004 | 兑换已关闭（`controls.reward_redemption_enabled = 0`） |
| 3005 | 档位不存在（家长批量保存分值时某个 `(taskCode, tierKey)` 查不到） |

> **2026-09-17 实现注（积分错误码语义）**：`3001`–`3005` 由 `points` 模块抛出（§4.20 / §4.21）。凡「不满足条件」的拒绝都发生在事务之前，失败时**零写入**（不会留下半张兑换单/半批规则）；入参格式错误仍沿用 `1001`、资源不存在沿用 `1002`。

> **2026-08-14 实现注（auth/parent 端点现行语义，与上表历史规划并存）**：1003 = 未登录/token 失效/用户名或密码错误/账号已停用（auth 与角色守卫）；1004 = 该手机号已注册/用户名已存在；1005 = 无权访问该资源（角色守卫）/无权操作该学生（归属校验）；1008 = 请求过于频繁（登录限流 10 次/分/IP）。

> **2026-08-18 实现注（admin 端点现行语义）**：1009 = 连通性测试失败（`POST /api/admin/routes/validate-connection` 返回，message 含 provider 原始错误，HTTP 502）；上表 1009=支付失败 为 P2 Billing 设计占位（Billing 未实现），两者不冲突。

> **2026-09-18 实现注（家长端学情端点归属校验）**：`/api/parent/students/{studentId}/*`（仪表盘除外的 reports / errors / chat-logs）第一行都过 `requireOwnedStudent`，沿用**两个不同的码**：`studentId` 不存在（或已软删）→ **404 / 1002**；`studentId` 存在但属于**别的家长** → **403 / 1005**（**不是 404**，别照抄「不泄漏存在性」）。`chat-logs/{dialogueId}` 另有二次校验：会话不属于该学生 → **404 / 1002**。非 parent 角色 → 403 / 1005（`RolesGuard`）。

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
| ErrorBook | `/api/error-book` | 主线错题本（全系统唯一，PRD §7.4）、重做、清零、薄弱点统计 | ErrorBook Service |
| Conversations | `/api/conversations` | 会话创建、消息读写、上下文加载 | ConversationService |
| Rewards | `/api/rewards` | 奖励发放、领取、兑现记录 | Reward Service |
| Parent | `/api/parent` | 报告、对话回放、目标、管控、预警 | ParentAdmin Service |
| Quota | `/api/quota` | AI 套餐额度、消耗查询与订阅状态 | AI-Agent 中枢 |
| Billing | `/api/billing` | 订单创建、支付、优惠券、续费 | Billing Service |
| Practice | `/api/practice` | 课堂练习答题判对错（practice 卡片） | Practice Service |
| Training | `/api/training` | 错题练习与专项训练（辅线学习闭环：错题筛选/重做判题/提示/专项抽题） | Training Service |
| Exams | `/api/exams` | 真题试卷考试（选卷/开考/逐题作答/交卷/结果，过期自动收卷） | Exams Service |
| Points | `/api/points` | 闯关积分：学生端查询（概览/流水/档位/奖励）+ 全量段位表，只读 | Points Service |
| ParentPoints | `/api/parent/students/{studentId}/points*` | 家长端积分：分值规则、兑换、奖励清单、汇率设置 | Points Service |

---

## 4. REST 端点清单

### 4.1 Auth — `/api/auth`

| 方法 | 路径 | 说明 | 阶段 |
|---|---|---|---|
| POST | `/api/auth/register` | 家长注册（手机号 + 密码 + 可选姓名；**注册即登录**，直接返回 parent token） | MVP |
| POST | `/api/auth/login` | **三角色统一登录**：按 admins(username) -> parents(手机号) -> students(username) 顺序查询命中，签发带 `role` 的 JWT；限流 10 次/分/IP（超限 1008） | MVP |
| POST | `/api/auth/logout` | 登出，使当前 Token 失效 | MVP |
| POST | `/api/auth/password/reset-request` | 请求重置密码（MVP 阶段发送短信验证码） | MVP |
| POST | `/api/auth/password/reset` | 确认重置密码（验证码 + 新密码） | MVP |
| GET | `/api/auth/me` | 获取当前登录身份 | MVP |

### 4.2 Users — `/api/users`

| 方法 | 路径 | 说明 | 阶段 |
|---|---|---|---|
| GET | `/api/users/parents/me` | 当前家长资料 | MVP |
| PATCH | `/api/users/parents/me` | 更新家长资料 | MVP |
| GET | `/api/users/students` | 当前家长下的学生子账号列表（**已实现，路径为 `/api/parent/students`，见 §4.13**） | MVP |
| POST | `/api/users/students` | 创建学生子账号（强制年龄/年级）（**已实现，路径为 `/api/parent/students`，见 §4.13**） | MVP |
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
| POST | `/api/progress/update` | 学生翻页时上报当前卡片位置，更新 `current_card_sort` 与 `next_unlock_type`；遇到 practice 卡片切换为练习阶段，到达最后一页自动推进到下一课或标记学科完成。复习（往前翻页）不会回退进度。当 `reason=not_current_lesson` 时返回 `currentLessonId`，供前端获取当前进度中的下一课 ID。响应：`{advanced, nextLessonId, completed, nextUnlockType, reason?, currentLessonId?, points?}`；`points` = `{awarded, balance, levelUp: {from, to}\|null}`（`from`/`to` 是**段位 code 字符串**，如 `pichai`/`zhutie`），为学完一课的发分结果（丙类 `mainline_lesson`，2026-09-17）。**`points` 仅在 `advanced=true`（推进到下一课 / 完成学科）时存在**——`advanced=false` 的分支（复习回翻、`practice_incomplete`、`not_current_lesson` 等）不发分，该键整体缺省（JSON 里没有，不是 0）；发分故障时同样缺省。P2.2 课程详情页调用。 | MVP |
| POST | `/api/progress/students/{studentId}/events` | 记录学习事件（由 Assessment/Reward 内部调用或开放） | P1 |

> **学生当前学期的确定规则**：`progress` 表（unique `(student_id, subject_id)`）的 `current_semester_id` 是唯一事实源，由家长端在配置/开通学生时写入（如九年级生选九上或九下）。星图与后续学习流程一律读此字段决定展示哪一册；系统不按日历自动推断学期。学生尚无 `progress` 记录时，star-map 回退到该学段教材版本中 `sort_order` 最小的学期（即上册）作为默认展示。

### 4.4 Content — `/api/content`

| 方法 | 路径 | 说明 | 阶段 |
|---|---|---|---|
| GET | `/api/content/subjects` | 学科列表 | MVP |
| GET | `/api/content/subjects/{subjectId}` | 学科详情 | MVP |
| GET | `/api/content/versions` | 教材版本列表（可按学科/学段过滤；响应含 `edition` 版次标记，空=2012 课标旧版） | MVP |
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
| POST | `/api/ai/report` | 生成学情报告内容 | MVP（本期未实现） |
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
| GET | `/api/error-book/items/{errorItemId}` | 错题详情 | MVP |
| POST | `/api/error-book/items/{errorItemId}/redo` | 提交错题重做答案 | MVP |
| POST | `/api/error-book/items/{errorItemId}/clear` | 标记错题已清零 | MVP |
| GET | `/api/error-book/items/{errorItemId}/explanation` | 获取 AI 解析 | MVP |
| GET | `/api/error-book/items/{errorItemId}/variations` | 获取变式题列表 | MVP |
| POST | `/api/error-book/items/{errorItemId}/variations/{variationId}/submit` | 提交变式题答案 | MVP |
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
| GET | `/api/parent/students` | 当前家长名下学生子账号列表（脱敏无密码哈希） | MVP |
| POST | `/api/parent/students` | 创建学生子账号（姓名/用户名/初始密码/年龄/年级；`school_level` 后端按年级推导；连带建 `student_settings`） | MVP |
| PATCH | `/api/parent/students/{studentId}/reset-password` | 重置该学生登录密码（6-32 位） | MVP |
| PATCH | `/api/parent/students/{studentId}/status` | 停用/启用该学生（`isActive`；停用后登录被拒，数据保留，不提供删除） | MVP |
| GET | `/api/parent/students/{studentId}/subject-configs` | 按学科教材配置视图：每学科当前配置（`configured`/`started`/`gradeCode`/`term`/`textbookVersionId`/`publisher`/`edition`，未配置学科为按学生年级推导的默认值，不落库）+ 可选项（有数据的年级 → 每年级可用版本含册别，版本按默认规则排序） | MVP |
| PUT | `/api/parent/students/{studentId}/subject-configs/{subjectId}` | 写入/切换该学科教材配置：`{ gradeCode, term, textbookVersionId? }`；versionId 缺省按默认规则选（同学段 edition 非空优先、id 大者优先）；已开始学习且版本/册别变化时**重置该学科学习状态**并返回 `reset: true`（错题/作业记录保留在库，不再展示/不阻塞门禁） | MVP |
| GET | `/api/parent/dashboard` | 家长仪表盘：一次返回名下所有孩子的概览（`lastActiveAt` / `activeDays7` / `unreadAlerts`）+ 各自的按学科卡片（进度 / 正确率累计 / 自评 / 错题待清零 / 考试数）；实时聚合，不落库 | MVP |
| GET | `/api/parent/students/{studentId}/reports` | **实时聚合学情报告（不落库、不调 LLM）**：`?period=weekly\|monthly`（默认 `weekly`，非法值归一化为 `weekly`）。返回 `stats` / `trend` / `subjects` / `weakPoints` / `weakPointsUncoveredCount` / `exams` | MVP |
| GET | `/api/parent/students/{studentId}/errors` | 孩子错题本（只读；分页壳 `{items,page,pageSize,total}`，`pageSize` 服务端固定 20）。query：`subject` / `source`(practice\|discuss\|exam\|targeted\|error_practice\|auxiliary) / `track`(main\|training) / `cleared`(uncleared\|cleared\|all) / `from` / `to` / `page`；`page` 非法 → 400/1001。**轨道分档**（`source` → 档位，唯一真源 = `parent-insights.repo.ts` 的 `TRACK_SOURCES`）：`main` = `practice\|discuss\|exam`；`training` = `targeted\|error_practice\|auxiliary`。孩子**在辅线答疑里问过**的题（`auxiliary`）归 `training`——它进训练轨「错题练习」池、可被做对清零，故不再单列「辅线」档 | MVP |
| GET | `/api/parent/students/{studentId}/chat-logs` | AI 对话回放列表（分页壳同 `errors`）。query：`track` / `scene` / `from` / `to` / `q`（**只搜会话标题**）/ `page`。**不提供学科筛选**（`ai_dialogues.subject_id` 约 76% 为 NULL） | MVP |
| GET | `/api/parent/students/{studentId}/chat-logs/{dialogueId}` | 单条对话详情：逐句回放，含 `reasoning`（AI 思考链，默认折叠）、`safetyFlag`（闲聊/偏离学习标记）与 `images[]`（孩子随消息发的图片 URL，服务端从 `attachments` 解析、只留 `type=='image'`，无附件时空数组）；不回传 `token_*` / `response_time_ms` | MVP |
| GET | `/api/parent/students/{studentId}/study-time` | **学习时长（会话口径）**。query `from` / `to`（`YYYY-MM-DD`，缺省近 7 天；值非法**宽容回落**默认窗口、不 400；`from > to` 自动交换）。响应 `{totalSeconds, activeDays, byDay:[{date,seconds}], byModule:[{module,seconds}], bySubject:[{subjectId,seconds}], source:'sessions'}`。**口径标注**：这是**显式会话**口径，与 `dashboard.activeDays7` 的**四路时间戳代理并存、不替换**（spec §10，详见 §6.25）——UI 必须并列展示 + 区分文案（如「学习时长（会话）」vs「活跃天数」），**不得悄悄换掉** | MVP |
| GET | `/api/parent/students/{studentId}/today-usage` | **今日已用时长**（用于与 `controls.daily_time_limit_minutes` 比较）。响应 `{date, activeSeconds, limitMinutes\|null, exceeded, byModule:[{module,seconds}]}`。`limitMinutes` 取自 `controls.daily_time_limit_minutes`，**为 NULL = 家长未设限 → `exceeded=false`**（不是「超了」，也不是「用了 0 分钟」）；`exceeded` 用 `>=`（用满即算超出，管控语义是「该停了」）。「今日」由**应用层**算好本地日传入，不用 `CURDATE()`。读前会惰性收尾该学生的孤儿会话（失败只 warn、不 500） | MVP |
| GET | `/api/parent/students/{studentId}/specials` | **专项学情（埋点 Phase 1B）**。query `from` / `to`（`YYYY-MM-DD`，缺省近 7 天；非法**宽容回落**、不 400）。响应四模块 `{dictation,interpretation,meaning,vocabulary}`，每模块 `{units,correct,rate\|null,byDay:[{date,count}]}`，`vocabulary` 多一个 `newWords`。**四个键后端保证都在**（没数据给 `0` / `rate:null` / `byDay:[]`），前端不必判空；`rate` 沿用 `answered=0 → null`（**不许写 0**）。`units` = 作答单位数（默写=篇、解释/含义=句、背单词=题）。口径见 §6.27 | MVP |
| GET | `/api/parent/students/{studentId}/mastery` | **真掌握度（埋点 Phase 1B）**。query `limit`（缺省 10、上限 50；**越界/非法 400/1001，不静默钳制**）。按 `mastery_score ASC, error_count DESC` 取最弱 N 个知识点，响应 `{items:[{knowledgePointId,name,masteryScore(0..1),level,correctCount,errorCount,lastSeenAt\|null}],coveredQuestions,totalQuestions,uncovered}`。**覆盖率三项必须展示**——题库仅 203/530 ≈ 38% 的题绑了知识点，不展示会让家长以为「孩子的问题只有这几个」。**与 §6.8 的 `weakPoints`（错题数代理）是两套口径、并存不替换**（spec §10） | MVP |
| GET | `/api/parent/students/{studentId}/goals/attainment` | **目标达成（埋点 Phase 1B；2026-09-20 P6.5 起按学科）**。无 query。读 `goals WHERE is_active=1`；**无目标时懒初始化**（`INSERT IGNORE` 只补缺失、**不覆盖**家长已改的值）。**所有目标都是 `(学科, 指标)` 二元组**：在学学科 = `progress` 行的学科 ∪ 固定兜底 {语文,英语} ∩ MVP 白名单 {数学,语文,英语}，按 `subjects.sort_order` 排序；**没有在学学科 → `items: []`**（去配置教材），**绝不编造默认目标**。默认规模 = 数学 3 + 语文 4 + 英语 4 = 11 行；默认值 30 分钟/学科·天、2 课/周、5 道/周、8 篇/周（仅语文）、20 词/天（仅英语）。达成值按 `metric` 分派：`daily_study_minutes` ← `study_sessions` **按学科**（秒→分钟**向下取整**）；`weekly_lessons` ← `lesson_completions` **按学科**（**历史完课补不回来**，从 2026-09-20 起算）；`weekly_clear_errors` ← `main_error_books` **按学科**；`daily_words` / `weekly_passages` ← `special_practice_logs`（该表 `subject_id` 恒 NULL，按 `module` 筛；这两个指标只挂在英语/语文学科上）。响应 `{items:[{metric,subjectId,subjectName,period,title,target,achieved,rate\|null}]}`，`rate = toRate(target, achieved)`（**分母是 target**，为 0 → null；**允许 > 100 = 超额**，前端不截断）。窗口：daily = 今天、weekly = 近 7 天（含今天），由**应用层**算好传参（不用 `CURDATE()`）。返回顺序固定为「学科 sort_order → 指标模板顺序」 | MVP |
| PUT | `/api/parent/students/{studentId}/goals/{metric}` | **改目标值（本模块唯一的写端点）**。路径 `metric ∈ daily_study_minutes \| weekly_lessons \| daily_words \| weekly_passages \| weekly_clear_errors`（**白名单外 400/1001**，白名单**从后端 `GOAL_TEMPLATES` 派生**、不手抄）；body **`{ target: int, subjectId: int }`** —— `subjectId` **必填**（所有目标按学科，路径参数不够定位资源；走 body 以避免再加同深度模板路径），`period`/`title` 由服务端按 `metric` 派生，家长无从自定义。**校验链路 6 步**：归属校验 → `metric` 白名单 → body Zod（`target` 1–9999、`subjectId` 正整数）→ **指标×学科匹配**（如 `daily_words` 只适用英语）→ **该学科是该生的在学学科** → upsert。按唯一键 `(student_id, scope_subject_id, metric)` upsert 并把 `is_active` 置回 1（复活曾被停用的目标）。`reminder_enabled` 恒 0（**提醒本期不做**）。响应 = **该 `(学科, 指标)` 的最新达成情况**（形状同 attainment 的一行），调用方原地替换即可、**不必再 GET**。归属校验同其它家长端点（403/1005、404/1002） | MVP |
| ~~GET~~ | ~~`/api/parent/students/{studentId}/goals`~~ | **已废弃（2026-09-22 用户裁决，详见 §4.24）**：旧目标 CRUD **从未实现**（文档先于代码写下，代码里没有对应 handler）；且**没有 `metric` 维度**，表达不了四类目标。已被上方的 `/goals/attainment` 取代 | ~~MVP~~ |
| ~~POST~~ | ~~`/api/parent/students/{studentId}/goals`~~ | **已废弃（2026-09-22 用户裁决，详见 §4.24）**：同上，从未实现、无 `metric`；创建目标改由 `PUT /goals/{metric}`（服务端幂等 upsert，首次即创建） | ~~MVP~~ |
| ~~PATCH~~ | ~~`/api/parent/students/{studentId}/goals/{goalId}`~~ | **已废弃（2026-09-22 用户裁决，详见 §4.24）**：同上，从未实现；改目标值改由 `PUT /goals/{metric}` | ~~MVP~~ |
| ~~DELETE~~ | ~~`/api/parent/students/{studentId}/goals/{goalId}`~~ | **已废弃（2026-09-22 用户裁决，详见 §4.24）**：同上，从未实现；本期不做「删除目标」，停用走 `goals.is_active`（家长可重新启用，`PUT` 会置回 1） | ~~MVP~~ |
| GET | `/api/parent/students/{studentId}/controls` | 行为管控配置 | MVP |
| PUT | `/api/parent/students/{studentId}/controls` | 更新行为管控 | MVP |
| GET | `/api/parent/students/{studentId}/rewards` | 奖励管理视图 | MVP |
| GET | `/api/parent/alerts` | 异常预警列表 | MVP |
| PATCH | `/api/parent/alerts/{alertId}/read` | 标记预警已读 | MVP |
| GET | `/api/parent/account` | 家长账号与订阅摘要 | MVP |
| PATCH | `/api/parent/account` | 更新账号信息 | P1 |
| GET | `/api/parent/messages` | 我的消息（定向 + 全员广播合并，倒序；广播已读回传） | MVP |
| GET | `/api/parent/messages/unread-count` | 未读消息数（顶部铃铛徽章） | MVP |
| PATCH | `/api/parent/messages/{id}/read` | 标记某条消息已读 | MVP |

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
| POST | `/api/practice/judge` | 课堂练习判对错。学生在 practice 卡片答题后调用，返回对错、判定方法与解析；答错自动入主线错题本（`main_error_books.source='practice'`）。三路由：(1) 题库命中 + 客观题（choice/true_false/fill_blank）-> exact 答案比对；(2) 题库命中主观题（short_answer/proof）或未命中 -> AI JudgmentCapability 判定；(3) 答错 -> 写入 `main_error_books`（未入库的题先经 QuestionStructuringCapability 结构化后插 `questions` 表，结构化失败则 `question_id=NULL` 仅存题面到 `wrong_answer_text`）。AI 判定失败返回 503（`code=5001`，不写错题本）。请求体：`{cardId, lessonId, subjectId, questionText, studentAnswer}`；响应：`{questionId(nullable), isCorrect, method:'exact'|'ai', errorType(nullable, enum: logic/calculation/format/missing), errorBookId(nullable), pointsAwarded: number, awardReason?(enum: daily_limit\|no_rule\|tier_inactive\|genre_unset\|not_cleared)}`（判题只判对错，2026-09-08 去 `analysis`——判错解析改由后台异步生成入 `questions.explanation`，结果页经 `/api/training/questions/explanations` 拉取）。**积分字段（2026-09-17）**：`pointsAwarded` 是本次调用**实际入账**的积分（甲类 `error_fix`），`0` = 本次未加分——答错 / 未清掉任何错题 / 幂等命中 / 发分失败 / 任何 `awardReason`；`awardReason` 是未发分原因，**幂等命中（`duplicate`）刻意静默**——回 `pointsAwarded: 0` 但不带原因（`duplicate` 会带回历史分值，报出去会让前端弹假 `+N 分`）。题面来源：`cards.content_metadata.questions[].text`（管线抽取）。 | MVP |
| POST | `/api/practice/hint` | 课堂练习提示（AI 生成 + Card 级缓存）。学生在 practice 卡片答题前点「提示」调用。先查 `cards.hints` 缓存（JSON：`{ "<题目文本>": "<提示文本>" }`，key 即「题目标题」）命中直返（不调 AI）；未命中则调 HintCapability 生成苏格拉底式提示（只启发不给答案，遵循 Socratic 原则）并写回 `cards.hints`，供后续复用（Card 级共享，不分学生，省 AI）。AI 生成失败返回 503（`code=5001`，前端降级显示静态文案，不阻断答题）。请求体：`{cardId, lessonId, subjectId, questionText}`；响应：`{hint, cached:boolean}`。 | MVP |
| POST | `/api/practice/discuss` | 课堂练习「让 AI 讲一讲」（苏格拉底讨论）。学生在 practice 卡片答题前点「让 AI 讲一讲」调用。打开讨论即：① 记入主线错题本（find-or-create 幂等，`main_error_books.source='discuss'`，无论后续答对答错都保留）；② **对话也 find-or-create**（B方案）：错题本记录加 `dialogue_id` 字段，重开时若该对话仍可用则复用，否则新建并回写。前端据 `dialogueId` 走 `POST /api/ai/tutor/stream`（mode=mainline）做苏格拉底式多轮讨论——TutoringCapability 据 `card_id` 解析 `cardContent` 限定范围（只能讨论该卡片内容，不能聊其它），3 次失败/放弃后兜底给完整解析。`questionId` 用 `content_hash` 快查（不调 AI 结构化），未命中则 `question_id=NULL` + `wrong_answer_text` 存题面。请求体：`{cardId, lessonId, subjectId, questionText}`；响应：`{dialogueId, errorBookId, questionId(nullable)}`。 | MVP |
| POST | `/api/practice/discuss-card` | 卡片级「思辨答疑」（苏格拉底讨论）。学生在非 practice 知识卡片上点「思辨答疑」调用。与 `/practice/discuss` 区别：scope=整张卡片（非某道题），**不入错题本**（讨论知识非题目）；服务端按 `(student_id, card_id, track='mainline')` find-or-create mainline 对话，重开同一卡片自动回到同一讨论线。前端据 `dialogueId` 走 `POST /api/ai/tutor/stream`（mode=mainline）做苏格拉底讨论。请求体：`{cardId, lessonId, subjectId}`；响应：`{dialogueId}`。 | MVP |
| GET | `/api/practice/results?cardId={cardId}` | 取该练习卡持久化判题结果（对/错 + analysis 题解），驱动 ✓/✗ 跨设备/刷新回显。响应体：`[{questionN, questionText, studentAnswer, isCorrect, method, analysis, errorType}]`。 | MVP |
| DELETE | `/api/practice/results?cardId={cardId}` 或 `?lessonId={lessonId}` | 重置练习记录：`cardId` 清单卡、`lessonId` 清本课全部练习卡（二者互斥，同传/都缺 400）。只删 `practice_results`，不动 `main_error_books`。 | MVP |
| GET | `/api/practice/uncleared-errors?subjectId={subjectId}&lessonId={lessonId}` | 查询学生某学科未清零课堂练习错题（`main_error_books` source='practice' + is_cleared=0），用于「错题清零」门禁。以 `main_error_books` 为唯一真相源，LEFT JOIN `questions` 补全题面，**不再依赖 `practice_results`**（避免两表数据不一致漏检）。进每节课前清空错题本里的 practice 未清题（兜住历史/跳过/写入失败的错题）。同一 `(cardId, questionN)` 重复记录去重保留最早一条。**按当前教材版本过滤**（`progress.textbook_version_id`，经 cards→lessons→units→semesters 链路；家长切换教材后旧版错题不计入门禁）。**课时范围（2026-09-01）**：`lessonId` 可选——传入时只返回「当前课之前」的错题（`lesson_id < lessonId`，星图同款 id 数值序），**本课练习刚产生的错题不触发清零门禁**（刷新本课不弹出「错题清零」阶段，留待进入下一课时再清）；省略时不限课时。`lesson_id` 为 null 的孤儿历史行保守保留。响应：`{errors: [{errorBookId, cardId, questionN, questionText, questionId, lessonId}]}`，计数 = `errors.length`。 | MVP |
| POST | `/api/practice/bump-error-levels` | 错题清零后仍有错误的题，`main_error_books.level` +1 标记未掌握。请求体：`{errorBookIds: number[]}`。 | MVP |
| POST | `/api/practice/self-assess` | 课堂练习主观题自评（`JUDGE_SUBJECTIVE_MODE=self_assess` 模式，卡中心变体）。请求体：`{cardId, lessonId, subjectId, questionN, questionText, questionId?, studentAnswer?, assessment}`；`assessment` 枚举 `correct\|incorrect`（学生自评对错）。补写 `practice_results`（判题时主观题因 `is_correct NOT NULL` 推迟落行，此处 `method='self_assess'`）+ 自评留痕（`question_self_assessments`，`source='practice'`）+ 错题本写入/清零。`questionId` 可为 null（孤儿题：题库未命中仅存题面——留痕跳过、错题本按 card+题面变体匹配）；`incorrect` 写入/复用 `main_error_books`（`source='practice'`）并触发解析缓存兜底生成，`correct` 清零该题所有未清记录。`cardId/lessonId/subjectId` 非正整数、`questionN/questionText` 缺失或 `assessment` 非法 400。响应：`{code:0, data:null}`。 | MVP |

### 4.17 Admin — `/api/admin`

管理员中枢，全部端点 `@Roles('admin')`（家长/学生 token 调用返回 403/1005）。**约定**：封家长=连带封其名下所有学生（`BanRegistry` 进程内即时生效，重启从 DB `is_active=0` 重建）；家长/学生列表 `passwordHash` 已脱敏；模型 `apiKey` AES-256-GCM 加密落库，接口只返回打码值。

| 方法 | 路径 | 说明 | 阶段 |
|---|---|---|---|
| GET | `/api/admin/dashboard` | 总览统计：学生/家长/模型/今日对话四计数 + 最近注册家长 | MVP |
| PATCH | `/api/admin/password` | 管理员改自己密码（`{oldPassword, newPassword}`，6-32 位） | MVP |
| GET | `/api/admin/alerts/expired` | **预警数据保留期预览**：无入参，阈值固定 30 天（后端常量）。返回 `{retentionDays: 30, cutoff: "<ISO>", total, unread}`；`cutoff` = 服务器当前时间 - 30 天，`created_at < cutoff` 的行会被清理，`unread` 是其中未读条数（**未读也会被删**，让管理员心里有数）。**只读，不删任何行** | MVP |
| DELETE | `/api/admin/alerts/expired` | **清理 30 天前的预警**：无入参，物理删除 `created_at < cutoff` 的行（**含未读**，不可恢复）。返回 `{retentionDays: 30, cutoff: "<ISO>", deleted}`。无过期行时 `deleted = 0`（不是 404）。**用 `DELETE` 而非 `POST`**：`@Post` 默认 201，对「清理」语义不对。**无自动保留期、无 scheduler** —— 只有管理员手动触发（spec §9 已知限制） | MVP |
| GET | `/api/admin/models` | 模型池列表（`apiKeyMasked` 打码返回） | MVP |
| POST | `/api/admin/models` | 新增模型（`providerType` 枚举 `kimi/qwen/deepseek/gemini/openai_compatible`，`apiKey` 加密落库） | MVP |
| PATCH | `/api/admin/models/{modelKey}` | 编辑模型（`apiKey` 留空=不修改；保存即 reload `ModelConfigRegistry` 生效，无需重启） | MVP |
| PATCH | `/api/admin/models/{modelKey}/status` | 启用/停用模型（`{isEnabled}`） | MVP |
| GET | `/api/admin/routes` | 场景路由表列表（含 `scenes`/`providerTypes` 枚举） | MVP |
| PUT | `/api/admin/routes` | 全量保存路由表（事务替换，保存即生效） | MVP |
| POST | `/api/admin/routes/validate-connection` | 模型连通性测试（探活，10s 超时，不落库；失败返回 `1009` 含 provider 原始错误） | MVP |
| GET | `/api/admin/parents?search=` | 家长列表（搜索用户名/手机号，`passwordHash` 已脱敏） | MVP |
| PATCH | `/api/admin/parents/{id}/status` | 封禁/解封家长（`{isActive}`；封=连带其名下所有学生即时被拒） | MVP |
| GET | `/api/admin/students?search=` | 学生列表（搜索用户名，`passwordHash` 已脱敏） | MVP |
| PATCH | `/api/admin/students/{id}/status` | 封禁/解封单个学生（`{isActive}`） | MVP |
| GET | `/api/admin/messages` | 已发消息列表（含触达数/已读数） | MVP |
| POST | `/api/admin/messages` | 发送消息（`{type: promo/learning/system, title, content, parentId?}`；`parentId` 缺省=全员广播） | MVP |
| DELETE | `/api/admin/messages/{id}` | 撤回消息（连同已读记录一并删除） | MVP |
| GET | `/api/admin/notifications` | 系统通知列表（判错解析缓存失败等异步告警，`admin_notifications` 表，含 `isRead`，按时间倒序最多 200 条） | MVP |
| GET | `/api/admin/notifications/unread-count` | 未读通知数（顶部铃铛徽章） | MVP |
| POST | `/api/admin/notifications/{id}/read` | 标记通知已读（不存在返回 `1002`） | MVP |
| GET | `/api/admin/chat/dialogues` | 管理员会话列表（仅自己的） | MVP |
| POST | `/api/admin/chat/dialogues` | 新建会话（指定 `{modelKey}`） | MVP |
| DELETE | `/api/admin/chat/dialogues/{id}` | 删除会话（连带其消息） | MVP |
| GET | `/api/admin/chat/messages?dialogueId=` | 会话历史消息 | MVP |
| POST | `/api/admin/chat/stream` | SSE 流式对话（`{dialogueId, message}`；独立 `admin_dialogues`/`admin_messages` 表，**无 K12 学习边界**） | MVP |

### 4.18 Training — `/api/training`

错题练习与专项训练（辅线学习闭环）。全部端点 student JWT（`@Roles('student')`，家长/管理员 token 调用返回 403/1005）。判题复用 Practice 的 JudgeCore（题中心变体：训练题必来自题库，无「未命中 AI + 结构化入库」分支）。

> **语文古诗文专项（`/dictation/*` 四个 + `/interpretation/*` 三个 + `/meaning/*` 三个端点）独立于上述体系**：它不进错题本、不参与清零门禁、不挂 `questions`（PRD §6.3 / §7.4 例外；架构文档 §4.2.13）。**独立化改造已于 2026-09-15 实施**：篇目身份是 `chinese_passages.id`（对外 `passageId`），判题不写任何学生状态。**解释（翻译）专项于 2026-09-16 新增**：三行对译（原文 → 该句关键字词 → 整句翻译）、**逐句判题**（答完一句立即出对错），抽题池比默写多一道「内容就绪」闸门、少一道「必背」闸门（见下表）。**含义专项于 2026-09-17 新增**：答「深层含义 + 作者情感」，同样逐句判，抽题池在解释专项之上再加一道「有 `sentence_meanings`」闸门；**判题纯 LLM、无归一化短路**（`method` 只有 `ai|unanswered|undetermined`，**没有 `exact`**）。

| 方法 | 路径 | 说明 | 阶段 |
|---|---|---|---|
| GET | `/api/training/error-book?subjectId={subjectId}&from={from}&to={to}&type={type}&kpId={kpId}` | 错题练习筛选列表。`subjectId` 必填 integer；`from`/`to` 可选 string（按 `created_at` 过滤，`to` 含当天即 `< to+1day`）；`type` 可选题型（JOIN `questions.type`）；`kpId` 可选 integer（EXISTS `question_knowledge_points`，非数字 400）。只返回**未清零**（`is_cleared=0`）记录；同一错题挂多 KP 时按 `errorBookId` 聚合 `kpIds` 数组。响应：`[{errorBookId, questionId(nullable), questionText, type(nullable), level, createdAt, kpIds: number[]}]`。 | MVP |
| POST | `/api/training/judge` | 训练判题（题中心变体，JudgeCore 复用）。请求体：`{questionId, subjectId, studentAnswer, source, sessionId?}`；`source` 枚举 `targeted\|error_practice`（错题练习/专项练习来源，非法值 400，不透传客户端任意值）；可选 `sessionId`（乙类会话页专用）只用于累加 `training_sessions.judged_count` 审计留痕——不传也能判题，会话不存在/非本人/已完成都静默跳过、不报错。三路由镜像 practice judge：(1) choice/true_false + fill_blank 归一化相等 -> exact 比对；(2) fill_blank 不等 / short_answer / proof -> AI JudgmentCapability 判定；(3) 答错 -> find-or-create 写入 `main_error_books`（`source` 落库为训练来源）；答对 -> 清零该题所有未清记录（不限 source）。题目不存在 400（`code=4004`）；AI 判定失败 503（`code=5001`，不写错题本）。判错同时后台异步生成解析入 `questions.explanation`（ExplanationCacheService，不阻塞判题响应；`answer>=100` 字符直接当题解直写，否则强模型 qwen3.8-max 生成，一次入库全生命周期复用）。响应：`{questionId, isCorrect, method:'exact'\|'ai', errorType(nullable, enum: logic/calculation/format/missing), errorBookId(nullable), pointsAwarded: number, awardReason?(enum: daily_limit\|no_rule\|tier_inactive\|genre_unset\|not_cleared)}`（判题只判对错，2026-09-08 去 `analysis`）。**积分字段（2026-09-17）**：`pointsAwarded` 是本次调用**实际入账**的积分（甲类 `error_fix`），`0` = 本次未加分——答对但未清掉任何错题 / 答错 / 幂等命中 / 发分失败 / 任何 `awardReason`；`awardReason` 是未发分原因，**幂等命中（`duplicate`）刻意静默**——回 `pointsAwarded: 0` 但不带原因（`duplicate` 会带回历史分值，报出去会让前端弹假 `+N 分`）。 | MVP |
| POST | `/api/training/self-assess` | 主观题学生自评（`JUDGE_SUBJECTIVE_MODE=self_assess` 模式）。请求体：`{questionId, subjectId, assessment, source, sourceRefId?}`；`assessment` 枚举 `correct\|incorrect`（学生自评对错）；`source` 枚举 `targeted\|error_practice\|exam`（专项练习/错题练习/考试结果页自评）；`sourceRefId` 仅 `source='exam'` 时传 `sessionId`，其余来源不传。校验题目存在后委托 JudgeCore.recordSelfAssessment：每次自评写入 `question_self_assessments` 留痕；`incorrect` 写入/复用 `main_error_books`（source 落库为训练/考试来源）并 fire-and-forget 触发解析缓存兜底生成；`correct` 清零该题所有未清记录。题目不存在 404；参数非法 400。响应：自评 `incorrect` 时返回 `errorBookId`（写入/复用的错题本 id）；`correct` 时省略该键（缺键按 null 理解）。 | MVP |
| POST | `/api/training/bump-error-levels` | 错题重做仍答错时递增严重程度（镜像 practice 的 bump-error-levels）。请求体：`{errorBookIds: number[]}`。 | MVP |
| POST | `/api/training/hint` | 训练「提示」（AI 生成 + **题级** `question_hints` 缓存，区别于 practice 的 Card 级 `cards.hints` 缓存）。请求体：`{questionId}`；题目不存在 404。先查 `question_hints` 缓存命中直返（不调 AI）；未命中调 HintCapability 生成苏格拉底式提示（只启发不给答案）并写回缓存（题级共享，不分学生；写回失败不阻断返回）。AI 生成失败 503（`code=5001`）。响应：`{hint, cached:boolean}`。 | MVP |
| GET | `/api/training/questions/explanations?ids={ids}` | 批量拉取题目解析（结果页末题后）。`ids` 为逗号分隔 questionId 列表；DB 已有直返；解析仍在后台生成中（判错触发的 in-flight）等待其完成（总超时 60s 兜底）；既无解析也无在途生成返回 null（**不触发**新生成）。解析为题级公开数据（不分学生）。响应：`{explanations: {[questionId]: string\|null}}`。 | MVP |
| GET | `/api/training/questions/{questionId}/explanation-wait` | 单题刷新等待解析（结果页「解析生成中」的刷新入口，前端 120s 倒计时）。DB 已有直返；在途生成等待；无在途且无解析（曾失败）**重新触发**生成再等待（上限 120s）。题目不存在/停用返回 null（不触发生成）；超时/失败返回 null 并写 `admin_notifications`（type=explanation_failed，同题未读去重）通知管理员人工补题解。响应：`{explanation: string\|null}`。 | MVP |
| GET | `/api/training/knowledge-points?subjectId={subjectId}` | 专项练习知识点平铺列表（`subjectId` 必填 integer；树形组装放前端，按 `parentKpId` 自行组树）。响应：`[{id, name, parentKpId(nullable), gradeBand}]`。 | MVP |
| POST | `/api/training/targeted/start` | 专项练习开练（按学科 + 知识点随机抽题）。请求体：`{subjectId, kpId, type, count}`；`count` 限 1-20 整数（越界/非整数 400）；`type` 白名单 `choice\|fill_blank\|true_false\|short_answer\|proof` 或 `null`（不限题型，非法 400）。响应：`{questions: [{questionId, text, type, options}]}`——**白名单序列化**，`answer`/`explanation` 等字段一律剥离（防答案泄露）；`options` 为 JSON 字符串 parse 后的数组（无/坏 JSON 为 null）；抽不到题返回空数组（空集合非错误，前端判空显示提示）。**选题基于 JWT user.sub（studentId）排除该生已标记的「不再展示」题**（LEFT JOIN `student_hidden_questions` ... IS NULL，请求体不变）；题池排除后为空时返回 `{ questions: [] }`。 | MVP |
| POST | `/api/training/sessions/{id}/complete` | 训练会话完成发分（乙类整批发分，只 `math_targeted` / `en_vocabulary` 用，2026-09-17 新增）。**201**。分值取**会话里记录的档位**（不取前端入参——这是乙类唯一的防伪造点），所以整轮结束才发一次。**幂等**：重复调用（前端重试）回 `reason='already_completed'` + `pointsAwarded: 0`，不报错。**发分失败可恢复**：award 抛错（DB 故障）时**不把会话置 completed**，回 `balance: null` / `totalEarned: null` + `reason='award_failed'`（真实余额不是 0，回 0 会污染前端快照），会话留在 `in_progress`，下次 `complete` 用同一幂等键 `tsess/vsess:<sessionId>` 补发且只补发一次。会话不存在/非本人 404（`code=1002`）。响应：`{pointsAwarded, balance, totalEarned, levelUp: {from, to}\|null, reason?}`；`reason` ∈ `daily_limit \| already_completed \| no_rule \| tier_inactive \| award_failed`。 | MVP |
| GET | `/api/training/dictation/passages` | 语文默写篇目清单（配置页用）。仅返回 `chinese_passages` 中 `verified=1` **且 `memorize_required=1`** 且 `is_active=1` 的篇目（三道闸门：`verified` 是内容已校验、`memorize_required` 是教学上要求背诵、`is_active` 是停用开关），按 `sort_order, id` 排序。**只出篇名 + 册次**——作者/朝代/正文是学生要作答的三个判题字段，一律不下发（防答案泄露）。响应：`{passages: [{passageId, workTitle, semester}]}`。 | MVP |
| POST | `/api/training/dictation/start` | 语文默写开练。请求体：`{semester, passageIds, count}`；`count` 限 1-20 整数（越界/非整数 400）；`semester` 限 `上册\|下册\|null`（`null`=全部册次，非法 400）；`passageIds` 为正整数数组或 `null`——非空时按指定篇目出题（**忽略 `semester`**，仅保留抽题池内篇目），否则按册次随机抽题。**两条路径都只从抽题池取题**（`verified=1` 且 `memorize_required=1` 且 `is_active=1`，三道闸门）；「全部册次」随机抽时按篇名去重（九上/九下有 9 篇重复收录，跨册取 `MIN(id)`）。**题面由篇名服务端生成**（`请默写《X》`，不落库）。响应：`{questions: [{passageId, prompt, workTitle, semester}]}`——**白名单序列化**，`author`/`dynasty`/正文一律剥离（防答案泄露，与 `targeted/start` 同规矩）。题池为空返回 `{questions: []}`。 | MVP |
| POST | `/api/training/dictation/judge` | 语文默写判题（**纯程序化判对错，不调用 LLM，不写任何学生状态**）。请求体：`{passageId, author, dynasty, body}`；`passageId` 须正整数（非法 400），篇目不存在 404。判对错口径：三字段各自 `normalizeChineseAnswer`（NFKC 全半角归一 → 去空白 → 去中英文标点 → 小写）后全等，**三项全对才 `isCorrect=true`**（故学生正文带不带标点、全半角、空格不影响判定）；正文不等时由 `diffChineseInOriginalText`（LCS 逐字差异 + 原文标点回投）定位错处，相邻「漏写+多写」合并为一个 `wrong`（写错字）、连续同类项合并成段——**判对错仍忽略标点，但 `bodyDiff` 各段文本回投原文标点**（学生要能读成整句，见 §6.20）。**不入错题本、不清零**（古诗文专项是独立子系统，PRD §6.3 / §7.4 例外；`reference` 判题响应即下发）。**错因与判题解耦**：本端点不等 LLM（实测 ~25ms），答错时回 `feedbackPending=true`，错因由 `POST /training/dictation/feedback` 另取。响应：`{passageId, isCorrect, fields: {author: {match}, dynasty: {match}, body: {match}}, bodyDiff: [{type:'equal'\|'wrong'\|'missing'\|'extra', ...}], reference: {author, dynasty, body}, feedback(恒 null), feedbackPending(bool), pointsAwarded: number, awardReason?(enum: daily_limit\|no_rule\|tier_inactive\|genre_unset\|not_cleared)}`。**积分字段（2026-09-17）**：`pointsAwarded` 是本次调用**实际入账**的积分（甲类 `cn_dictation`，完成即给、不看对错），`0` = 本次未加分——篇目未标定体裁（`genre_unset`）/ 档位未启用 / 已达每日上限 / 无规则 / 幂等命中 / 发分失败；`awardReason` 是未发分原因，**幂等命中（`duplicate`）刻意静默**——回 `pointsAwarded: 0` 但不带原因（`duplicate` 会带回历史分值，报出去会让前端弹假 `+N 分`）。 | MVP |
| POST | `/api/training/dictation/feedback` | 语文默写错因文案（LLM 可选，**与判题解耦**，2026-09-14 新增）。请求体同 `judge`：`{passageId, author, dynasty, body}`；`passageId` 须正整数（非法 400），篇目不存在 404。服务端按入参用纯函数 `evaluateDictation` 重算三字段匹配与差异（**只读篇目、只算差异，不写任何学生状态**），再喂 `dictation_feedback` 场景（primary=`local` 本地 llama.cpp，fallback=`deepseek-flash`）。本地端点靠 `chat_template_kwargs:{enable_thinking:false}` 关 thinking（**`thinking:false` 对 llama.cpp 无效**，它不认 DashScope 的 `enable_thinking`），实测错因耗时 13–16s → 2s 量级。模型不可达/超时/两个模型都失败一律 **HTTP 200 + `feedback=null`**（不报错），前端显示兜底文案。响应：`{feedback: string\|null}`。 | MVP |
| GET | `/api/training/interpretation/passages` | 语文古诗文**解释（翻译）**专项篇目清单（配置页「指定篇目」用，2026-09-16 新增）。抽题池 = `chinese_passages` 中 `verified=1 AND is_active=1 AND JSON_LENGTH(sentences) > 0`——**不设 `memorize_required`**（「要背诵」不是「要理解翻译」的必要条件），但多一道**「内容就绪」**闸门（没切过句的篇目点进去没题目）。按 `sort_order, id` 排序。**只出篇名 + 册次**——标准释义/标准译文是判题答案，一律不下发。响应：`{passages: [{passageId, workTitle, semester}]}`。 | MVP |
| POST | `/api/training/interpretation/start` | 语文解释开练（2026-09-16 新增）。请求体：`{semester, passageIds, count}`；`count` 限 **1-3** 整数（每篇逐句判，3 篇已是长会话；越界/非整数 400）；`semester` 限 `上册\|下册\|null`（非法 400）；`passageIds` 为正整数数组或 `null`——非空时按指定篇目出题（**忽略 `semester`**，仅保留抽题池内篇目），否则按册次随机抽题。**「全部册次」随机抽时按篇名去重**（九上/九下有 9 篇重复收录，跨册取 `MIN(id)`）。**一次下发整篇所有句子**——前端才能把整篇铺出来、让学生看见上下文（三行对译不换页）。响应：`{passages: [{passageId, workTitle, semester, sentences: [{index, text, terms: [词名]}]}]}`——**白名单序列化**，`gloss`（释义）/`translation`（译文）/`full_translation` 与 `author`/`dynasty`/`body` 一律剥离（防答案泄露）；`terms` 只出**词名**，是该句需要学生作答的关键字词。题池为空返回 `{passages: []}`。 | MVP |
| POST | `/api/training/interpretation/judge` | 语文解释判题——**逐句**判（2026-09-16 新增；设计原为「整篇一次批量」，经用户 2026-09-16 裁决改为逐句：学生答完一句立即知道对错，好及时纠正）。请求体：`{passageId, sentenceIndex, terms: [{term, answer}], translation}`；`passageId` 须正整数（非法 400）、篇目不存在 404，`sentenceIndex` 须非负整数（非法 400）、越界 400；`translation` 非字符串降级 `''`；`terms` 非数组视作 `[]`，元素 `term` 非字符串丢弃该条、`answer` 非字符串降级 `''`（防 number 混进去触发 TypeError 变 500）。**流程**：① **程序短路**（不进 LLM）——学生答案空白 → `correct:false, method:'unanswered'`；`normalizeChineseAnswer` 后与标准答案全等 → `correct:true, method:'exact'`；② 剩余待判项**打包一次**喂 `interpretation_judge` 场景（primary=`local`，fallback=`deepseek-flash`，本地端点下发 `chat_template_kwargs:{enable_thinking:false}` 关 thinking，实测整个判题 ~1.3s）；③ 模型漏项 / 整次调用失败 → 那些项 `correct:null, method:'undetermined'`（**不抛错、已判项不清空**）。**不写任何学生状态**（不入错题本、不清零、无隐藏题/提示缓存/自评——独立子系统，PRD §6.3 / §7.4 例外）。响应：`{passageId, sentenceIndex, allCorrect, terms: [{term, correct(bool\|null), method, standard, comment}], sentence: {correct, method, standard, comment}, fullTranslation, pointsAwarded: number, awardReason?(enum: daily_limit\|no_rule\|tier_inactive\|genre_unset\|not_cleared)}`；`method` 四值 `exact\|ai\|unanswered\|undetermined`；`standard`（标准释义/译文）**只在判题响应里下发**（`start` 不出——那是答案）；`fullTranslation` **仅当被判的是最后一句时非 null**（提前下发整篇译文等于泄题）。**积分字段（2026-09-17）**：`pointsAwarded` 是本次调用**实际入账**的积分（甲类 `cn_interpretation`，整篇最后一句判完发一次），`0` = 本次未加分——篇目未标定体裁（`genre_unset`）/ 档位未启用 / 已达每日上限 / 无规则 / 幂等命中 / 发分失败；`awardReason` 是未发分原因，**幂等命中（`duplicate`）刻意静默**——回 `pointsAwarded: 0` 但不带原因（`duplicate` 会带回历史分值，报出去会让前端弹假 `+N 分`）。 | MVP |
| GET | `/api/training/meaning/passages` | 语文古诗文**含义**专项篇目清单（配置页「指定篇目」用，2026-09-17 新增）。抽题池 = `chinese_passages` 中 `verified=1 AND is_active=1 AND JSON_LENGTH(sentences) > 0 AND sentence_meanings IS NOT NULL`——在解释专项那三道闸门之上多一道**「有含义数据」**（只给诗词篇目灌 `sentence_meanings`，「只做诗词」由数据有无天然实现，**不设体裁标记列**）。按 `sort_order, id` 排序。**只出篇名 + 册次**——深层含义与作者情感是判题答案，一律不下发。响应：`{passages: [{passageId, workTitle, semester}]}`。 | MVP |
| POST | `/api/training/meaning/start` | 语文含义开练（2026-09-17 新增）。**返回 201**（Nest `@Post` 默认）。请求体 `{semester, passageIds, count}`，形状与解释专项 `start` 完全一致：`count` 限 **1-3** 整数（越界/非整数 400）；`semester` 限 `上册\|下册\|null`；`passageIds` 为正整数数组或 `null`——非空时按指定篇目出题（**忽略 `semester`**，仅保留抽题池内篇目），否则按册次随机抽题；「全部册次」随机抽时**按篇名去重**（跨册取 `MIN(id)`），指定篇目多于 `count` 时截断。**整篇句子的 `text` 一次给全**（顶部原文条要渲染完整一首诗），**`answerable` 区分「显示」与「出题」**：该句没有标准含义时 `answerable:false`，前端仍显示在顶部原文条里、但**永不进作答队列**（`judge` 该句会 400）。响应：`{passages: [{passageId, workTitle, semester, sentences: [{index, text, terms: [{term, plain}], answerable}]}]}`——**白名单序列化**，`meaning`（深层含义）/`emotion`（作者情感）/`translation`/`full_translation` 与 `author`/`dynasty`/`body` 一律剥离；`terms` 每项两式：`term` 原样**带注音**（`谪（zhé）守`，展示用）、`plain` 去注音（`谪守`，前端在原文里高亮用）。整篇一个 `answerable` 句子都没有的篇目**不下发**（避免空白卡）；题池为空返回 `{passages: []}`。 | MVP |
| POST | `/api/training/meaning/judge` | 语文含义判题——**逐句**判（2026-09-17 新增）。**返回 201**。请求体：`{passageId, sentenceIndex, terms: [{term, answer}], meaning, emotion}`；`passageId` 须正整数（非法 400）、篇目不存在 404；`sentenceIndex` 须非负整数（非法 400）、越界 400、**该句无标准含义 400**（`answerable:false` 的句子本就不该被提交）；`meaning`/`emotion` 非字符串降级 `''`；`terms` 非数组视作 `[]`，元素 `term` 非字符串丢弃该条、`answer` 非字符串降级 `''`。**流程是两段 + 失败兜底**（照解释专项的三段式但**去掉归一化短路**）：① **空答案短路**（本专项唯一的程序判断）→ `correct:false, method:'unanswered'`；② 剩余待判项**打包一次**喂 `chinese_meaning_judge` 场景（primary=`local`，fallback=`deepseek-flash`，本地端点下发 `chat_template_kwargs:{enable_thinking:false}` 关 thinking）。模型漏项 / 整次调用失败 → 那些项 `correct:null, method:'undetermined'`（**不抛错、已判项不清空**）。**`method` 只有 `ai\|unanswered\|undetermined` 三值，刻意没有 `exact`**——含义与情感是理解性作答，学生答得跟标准答案逐字相同也不能靠字符串相等判「对」，一律过 LLM（有用例钉着，勿「顺手补上」）。**不写任何学生状态**（不入错题本、不清零、无隐藏题/提示缓存/自评）。响应：`{passageId, sentenceIndex, allCorrect, terms: [{term, correct(bool\|null), method, standard, comment}], meaning: {correct, method, standard, comment}, emotion: {correct, method, standard, comment}, pointsAwarded: number, awardReason?(enum: daily_limit\|no_rule\|tier_inactive\|genre_unset\|not_cleared)}`；`standard`（标准含义/标准情感）**只在判题响应里下发**；`terms` 顺序与「该句应有的字词」一致，学生多传的 `term` 忽略、同名取最后一条。**积分字段（2026-09-17）**：`pointsAwarded` 是本次调用**实际入账**的积分（甲类 `cn_meaning`，整篇最后一句判完发一次），`0` = 本次未加分——篇目未标定体裁（`genre_unset`）/ 档位未启用 / 已达每日上限 / 无规则 / 幂等命中 / 发分失败；`awardReason` 是未发分原因，**幂等命中（`duplicate`）刻意静默**——回 `pointsAwarded: 0` 但不带原因（`duplicate` 会带回历史分值，报出去会让前端弹假 `+N 分`）。 | MVP |
| POST | `/api/training/hidden/mark` | 标记某题不再展示（幂等：重复标记不报错）。请求体：`{questionId, subjectId}`（均 integer≥1）。**全局排除**——`student_id + question_id` 维度，不分知识点；标记后该题在 `targeted/start` 选题时被 LEFT JOIN ... IS NULL 排除。响应：`{code:0,message:'ok',data:null}`（void op 包装）。 | MVP |
| GET | `/api/training/hidden?subjectId={subjectId}` | 不再展示清单（按标记时间倒序）。`subjectId` 必填 integer≥1。响应：`[{questionId, questionText(80字截断), type, kpName(nullable,首个 primary kp 名), markedAt}]`。 | MVP |
| DELETE | `/api/training/hidden/{questionId}` | 撤销单条标记（幂等：不存在/未标记不报错）。路径参数 `questionId` integer≥1。响应：`{code:0,message:'ok',data:null}`。 | MVP |
| DELETE | `/api/training/hidden` | 全部重置（清空该生所有不再展示标记）。无请求体/参数（studentId 取自 JWT）。响应：`{code:0,message:'ok',data:null}`。 | MVP |
| GET | `/api/training/vocabulary/options` | 英语**背单词**配置页数据（2026-09-16 新增）。`pools` 是三档词库范围及词数：`junior`=「仅初中」（含小学二级词，即义务教育课标 2022 版 1600 词口径）、`senior`=「仅高中」（= 高中课标 3000 词表中不在 1600 词表里的部分）、`all`=两者之和；存储层其实是四层 `primary`/`junior`/`senior_required`/`senior_elective`，页面只暴露这三档。`counts` 是四个筛选项各自可用的词数（`notLearned`=总数-已背过、含从无进度行的词；`myWrong`=该学生错过的词；`commonWrong`=全平台答错过即 `error_count>0` 的词；`extended`=有熟词僻义的词）。`todayAnswered` 按**服务器本地时区**当日 00:00 起算，「见过就算」（答对/答错/不认识/判题失败都计入）。响应：`{pools: [{key, label, count}], todayAnswered, counts: {notLearned, myWrong, commonWrong, extended}}`。 | MVP |
| POST | `/api/training/vocabulary/start` | 背单词开练（2026-09-16 新增）。请求体：`{levelPool, count, order, letter, direction, onlyNotLearned, onlyMyWrong, onlyCommonWrong, onlyExtendedSense}`；`count` 限 **10-20** 整数（非法 400）；`levelPool` ∈ `junior\|senior\|all`；`order` ∈ `random\|alpha\|alpha_desc\|letter`；`direction` ∈ `en2cn\|cn2en\|ph2en\|random`；**`order=letter` 时必须给单个 a-z 字母的 `letter`，非 letter 模式给了 `letter` 则 400**（静默忽略会让学生以为筛选生效了）。`ph2en` = **看音标写单词**（题面是音标、答案是英文单词）；词没有可用音标时**退化成英→中而不是把这个词丢掉**（静默丢词会让学生以为筛选坏了），`/`、`//` 这类空音标算作没有。服务端把 `direction` 落定成实际方向（`random` 逐题在**本词出得了的方向**里等概率掷，否则会出现「选了随机却总出英→中」）；**勾 `onlyExtendedSense` 时方向强制 `en2cn`**——三档判题口径（含「答成常见义」那一档）建立在「题面给单词 + 语境、学生答中文」之上，中→英下这一档失去意义；**熟词僻义题恒为 `en2cn`**（`ph2en` 只有音标，学生既看不到单词也看不到搭配，而「在搭配里认出那个不常见的意思」正是考点）。**普通模式下也会抽到熟词僻义题**（在该词候选里等概率抽），勾选的作用是「只留」僻义；一个词只出一道题，会话长度 == `count`。**防泄漏**：凡是**答案等于英文单词**的题（`cn2en` 与 `ph2en`）响应里**不含** `word`/`phonetic`/`context`/`hasFamily`——词根族树里必然含单词本身；`ph2en` 的音标只出现在 `prompt` 一处（`phonetic` 为 null）。响应：`{questions: [{wordId, senseIndex, promptKind, prompt, phonetic, context, isExtendedSense, hasFamily}], poolSize}`；题池为空返回 `{questions: [], poolSize: 0}`。 | MVP |
| POST | `/api/training/vocabulary/judge` | 背单词判题（2026-09-16 新增）。请求体：`{wordId, senseIndex, promptKind, answer}`；`wordId` 须正整数（非法 400）、不存在 404；`senseIndex` 须非负整数（非法 400）；`promptKind` ∈ `en2cn\|cn2en\|ph2en`；`answer` 非字符串降级空串（防 number 混进去变 500）。**三条路由**：① **答案是英文单词的两条**（中→英 `cn2en`、看音标写单词 `ph2en`）——纯程序比对（归一化后相等，或命中人工整理的拼写变体组，或正确答案含连字符/空格时忽略其差异），**不调 LLM**，答错时给 `spellingDiff` 逐字符差异；② **英→中·常见义**——先把该词全部常见义的 gloss 按 `；,、/` 拆成原子做归一化比对（命中即 `exact`、不调模型），未命中才调 `english_word_judge` 场景（primary=`local`、fallback=`deepseek-flash`，本地端点下发 `chat_template_kwargs:{enable_thinking:false}` 关 thinking），二档 `correct\|wrong`；③ **英→中·熟词僻义**——同上但只认目标僻义义项，且调模型时**必须带上锁定僻义的语境搭配**（「在搭配里认那个僻义」正是考点），模型判**三档** `correct\|off_target\|wrong`；`common` 模式下模型若输出 `off_target` 会收敛成 `wrong`。`senseIndex` 越界（内容重灌后下标漂移）时按「全义项都接受」判——宁放过不错杀。判题失败 → `verdict='undetermined'`，**不抛错**。**记账**：`correct` 置 `learned`、`wrong` 同时给学生 `wrong_count` 与全局 `error_count` 各加一；**`off_target` / `unanswered`（空作答）/ `undetermined` 三者都不计错**（「不会」不等于「易错」，判题失败更不该让学生背锅）。响应：`{wordId, senseIndex, verdict, method, standard: {word, phonetic, meanings, target}, spellingDiff, comment, familyAvailable, progress: {learned, wrongCount}}`；`verdict` 五值 `correct\|off_target\|wrong\|unanswered\|undetermined`，`method` 二值 `exact\|ai`。 | MVP |
| POST | `/api/training/vocabulary/progress/clear` | 「移除易错标记」（2026-09-16 新增）。请求体：`{wordId}`（整数 ≥1，非法 400）。只把 `student_word_progress.wrong_count` 清零——**不动 `learned`**（背过就是背过），也**不动 `english_words.error_count`**（那是全平台的统计，不该被单个学生抹掉）。该学生没有这条进度行时是正常的空操作。响应：`{ok: true}`。 | MVP |
| GET | `/api/training/vocabulary/words/{wordId}/family` | 词根族（2026-09-16 新增，点「+」号懒加载）。族的定义是「`root_key` 指向同一个中心词」，**不建新表**——`WHERE root_key = ?` 一句取全族，中心词自己也带 `root_key`=自己的 `word`（该不变式由内容管线的 check 保证）。返回 `root`（中心词）+ `members`（中心词排最前，其余按课标原序），每个成员带相对中心词的**词缀注记**（如 `-less 无…的 → 形容词`）与第一顺位中文释义，供前端渲染缩进树。**本端点不按题面类型设限**（成绩单复盘时也要能看），但**前端必须只在英→中题上渲染「+」号入口**——族树里必然包含单词本身，中→英题点开等于直接看答案。路径参数 `wordId`（ParseIntPipe）；单词不存在 404，该词没有族（族内不足 2 行）亦 404。响应：`{root: {word, phonetic, gloss}, members: [{word, phonetic, gloss, pos, affixes: [{type, code, gloss, posHint}], isHead, level}]}`。 | MVP |

### 4.19 Exams — `/api/exams`

真题试卷考试（试卷库来自 data-refinery 抽取的真题卷，`exam_papers`/`paper_questions`）。全部端点 student JWT（`@Roles('student')`，家长/管理员 token 调用返回 403/1005）。判题复用 Practice 的 JudgeCore（`source='exam'`，`sourceRefId=sessionId`，答错入错题本与练习同语义）。**考试防作弊设计**：考试结束前的一切响应（试卷详情/会话状态/单题提交）均为白名单序列化——`answer`/`explanation` 与对错信息一律剥离，对错只在交卷后的 results 出现。

| 方法 | 路径 | 说明 | 阶段 |
|---|---|---|---|
| GET | `/api/exams/papers?subjectId={subjectId}&year={year}&district={district}&examType={examType}&gradeBand={gradeBand}` | 试卷列表。`subjectId` 必填 integer；`year`（integer）/`district`/`examType`/`gradeBand`（string）可选叠加筛选；按 `year DESC, id DESC` 排序。响应：`[{id, title, year(nullable), district(nullable), examType(nullable), gradeBand(nullable), questionCount}]`。 | MVP |
| GET | `/api/exams/papers/{id}` | 试卷详情：题目元数据 + 推荐时长。`durationMinutes` 按题型估算（choice/true_false 每题 1 分钟、其余每题 3 分钟），总和向上取整到 15 的倍数，clamp 到 [30, 180]。**白名单**：questions 只含 `questionId/questionNo/text/type/options`（`options` 为 JSON 字符串 parse 后的数组，无/坏 JSON 为 null），无 `answer`/`explanation`。试卷不存在 404。响应：`{id, title, durationMinutes, questions}`。 | MVP |
| POST | `/api/exams/sessions` | 开考/续考。请求体：`{paperId, durationMinutes}`；`durationMinutes` 限 10-300 整数（越界/非整数 400）；试卷不存在 404。**续考语义**：同学生同卷已有 `in_progress` 会话直接返回既有会话（`deadlineAt` 不变、**不重置时长**），否则新建（deadline = now + duration）；命中的续考会话**已超时**则先自动收卷（与 GET 会话同语义）再返回 `status='submitted'`（不新建，前端据此直接踢结果页）。响应（新建/续考同构）：`{sessionId, status?('submitted' 仅命中超时会话时返回，缺省视为 in_progress), deadlineAt, remainingSeconds, questions}`。 | MVP |
| GET | `/api/exams/sessions/{id}` | 会话状态（断线恢复）。会话不存在 404；非本人 403。响应：`{sessionId, status: 'in_progress'\|'submitted', remainingSeconds, questions, answered}`；`answered` 为 `questionId -> {answerText}` map（**只含作答文本，判题字段一律剥离**）。发现已超 deadline 的 `in_progress` 会话时服务端**自动收卷**（与手动交卷同一 finalize 逻辑）后返回 `status='submitted'`、`remainingSeconds=0`。 | MVP |
| POST | `/api/exams/sessions/{id}/answers` | 单题提交（同步判题）。请求体：`{questionId, answerText}`；题目不在该卷题单 400；已交卷再提交 409（`code=4101`）；超 deadline **先自动收卷再 409**（`code=4102`，未作答按错计一并落库）。判题走 JudgeCore（客观题 exact 即返，AI 判定最长 90s per-scene timeout）；**先落「在途行」再判题**（`answerText` + `is_correct` NULL）——判题在途窗口内倒计时归零触发自动收卷时按「在途补判」而非「未作答」处理，判题失败时在途行已落库（交卷时统一补判）、错误透传前端重试。响应（**白名单，不回传对错——考试防作弊设计**）：`{saved: true}`。 | MVP |
| POST | `/api/exams/sessions/{id}/submit` | 交卷（**幂等**：已 submitted 直接重算汇总返回）。收卷三分支：未作答 -> 直接判错入错题本（`method='unanswered'`，无答案可判不走判题）；在途（有作答、无判题结果）-> JudgeCore 补判，失败按错计（`method='failed'`）仍入错题本；已判题 -> 跳过。响应：`{correctCount, totalCount, accuracy, subjectiveCount, points?}`（`accuracy` 为百分比一位小数，如 33.3；`subjectiveCount` 为主观题数，`self_assess` 模式下不计对错）。`points` = `{awarded, balance, levelUp: {from, to}\|null}`（`from`/`to` 是**段位 code 字符串**），为交卷发分结果（丙类 `math_paper`，2026-09-17）。**仅 submit 响应带 `points`**——结果页 `GET /api/exams/sessions/{id}/results` 只读已交卷汇总、不补发分，其内嵌汇总里该键缺省；交卷未发分（如超时自动收卷的补判路径）或发分故障时同样缺省（JSON 里没有，不是 0）。 | MVP |
| GET | `/api/exams/sessions/{id}/results` | 结果页：仅 `submitted` 会话可查（`in_progress` 409，`code=4103`）。响应：`{correctCount, totalCount, accuracy, subjectiveCount, items: [{questionId, questionNo, text, type, options, answerText(nullable), isCorrect(0\|1\|null), answer(nullable, 参考答案——自评对照展示), needsSelfAssessment(boolean, 主观题待自评), selfAssessment(correct\|incorrect\|null, 该生最近一次自评留痕), analysis(nullable), explanation(nullable)}]}`（items JOIN questions 带解析）。**主观题口径（self_assess 模式）**：主观题 `is_correct=NULL` 不计对错——`correctCount`/`accuracy` 只算客观题（accuracy 分母为客观题数），`subjectiveCount` 单列（结果页展示「客观题 X/Y · 主观题 N 题」）；`selfAssessment` 从 `question_self_assessments` 恢复该生最近一次自评（刷新/重进不丢自评态）。跨模式口径：`subjectiveCount` 按 `is_correct NULL` 推断，遗留 `ai` 模式已判主观行（`is_correct` 非 NULL）计为客观错题。 | MVP |

### 4.20 Points — `/api/points`（学生端积分，只读）

闯关积分的**学生端查询**（2026-09-17 新增）。全部端点 student JWT（`@Roles('student')`，家长/管理员 token 调用返回 403/1005）。四个端点**全部只读**：学生不能给自己发分、也不能兑换（兑换是家长端操作，§4.21）。`studentId` 一律取自 JWT，端点**不接受任何「查哪个学生」的入参**（防 IDOR）。分页 `page` 默认 1、`pageSize` 默认 20 且上限 100，越界/非正整数 **400**（不静默钳制）。

> **段位的单一真源**：段位阈值常量在 `modules/points/levels.ts`，**不落库、前端不重复定义**——学生端与家长端都从这些接口拿。详见 PRD §7.13。

| 方法 | 路径 | 说明 | 阶段 |
|---|---|---|---|
| GET | `/api/points/me` | 积分概览。新学生**没有 `student_points` 行也返回全 0 + 劈柴，不 404**。响应：`{balance, totalEarned, todayEarned, level: {code, name, index, threshold}, nextLevel: {…}\|null, pointsToNextLevel: number\|null, progressPercent}`。`totalEarned` 是累计**获得**（段位依据，兑换只扣 `balance`、不影响它）；`todayEarned` 是今日 `kind='earn'` 的 SUM（不含兑换负流水）。已满级（王者）时 `nextLevel` / `pointsToNextLevel` 为 `null`，`progressPercent` 为 100。 | MVP |
| GET | `/api/points/me/ledger?page&pageSize` | 流水分页，按 id 倒序（最新在前）。响应：`{items: [{id, kind, title, points, createdAt, refType}], total, page, pageSize}`。`kind` ∈ `earn\|redeem`；`points` earn 正 / redeem 负；`title` 是**展示文案快照**（家长之后改分值/档位名，历史流水不变）；`refType` 是来源类型（`lesson` / `exam_session` / `training_session` / `passage` / `question`）。 | MVP |
| GET | `/api/points/me/rules` | 各任务的档位与分值——**「档位即可选项」的数据源**（前端因此不再硬编码题量常量，PRD §7.13）。**只回已启用档位**（下架档恰好也是开练端点不认的值，选了会被 400；家长端才看得到全部档）。响应：`{tasks: [{taskCode, taskName, tiers: [{tierKey, tierLabel, points, dailyLimit, completedToday, remainingToday, isActive}]}]}`；`dailyLimit == null` 表示不限，此时 `remainingToday` 也为 `null`；`isActive` 恒为 `true`（便于与家长端响应对照调试）。 | MVP |
| GET | `/api/points/me/rewards` | 奖励清单（**只含已上架**），逐项标注 `affordable`（余额够不够）/ `levelOk`（段位够不够）/ `gap`（还差多少分）。学生**只能看**，兑换在家长端。响应：`{balance, level, items: [{id, name, description, pointsCost, minLevelCode, minLevelName, affordable, levelOk, gap}]}`；`minLevelName` 是 `minLevelCode` 对应的段位名（无门槛或脏 code 时为 `null`）——段位表单一真源在服务端，学生端文案「段位不够（需达到 XX）」直接用这个名字，不在前端维护段位表。 | MVP |

> **`dedupe_key` 不下发**：`dedupe_key` / `task_code` / `student_id` 等内部字段一律不出现在流水响应里（`PointLedgerEntry` 是显式挑字段的视图，不是仓储行透传）。

### 4.21 ParentPoints — `/api/parent/students/{studentId}/points*`（家长端积分，11 个端点）

家长端分值配置与兑换（2026-09-17 新增）。全部端点 parent JWT（`@Roles('parent')`；与 `ParentController` **同前缀** `api/parent`，Nest 允许同前缀多 controller）。**每个 handler 第一件事**是归属校验 `requireOwnedStudent(parentId, studentId)`——这是唯一防线，不做「先查数据再判归属」（那样会泄漏「这个 id 存在」）。controller 只做「校验 + 转发」：段位、余额、汇率、档位合法性全在学生端同款的三个 service 里，**不在这里重算**。

> ⚠️ 路径里的 `{studentId}` 是**学生 id**（`/api/parent/redemptions/{id}` 那条没有学生 id，见下）。`points/settings` 与 `points/rules` **刻意分开**：汇率和分值是两个关注点（spec §7.3）。`POST` 按 Nest 默认返回 **201**。

| 方法 | 路径 | 说明 | 阶段 |
|---|---|---|---|
| GET | `/api/parent/students/{studentId}/points` | 概览，复用学生端同款 `getOverview`（段位/进度单一真源），响应同 §4.20 第一行。 | MVP |
| GET | `/api/parent/students/{studentId}/points/rules` | 按任务分组的**全部**规则（含下架档位——家长要能看到并重新启用）。响应同 §4.20 的 `me/rules`，但**不滤掉 `isActive=false` 的档**。 | MVP |
| PUT | `/api/parent/students/{studentId}/points/rules` | 批量保存分值与上限：`{rules: [{taskCode, tierKey, points, dailyLimit, isActive}]}`，**一个事务**要么全成要么全不成。三个可改字段**全必填**；`points` 须 `0-9999` 整数、`dailyLimit` 须 `null` 或 `1-99`（`0` 会让该档位永久不发分，拒绝；「不限」只能用 `null` 表达）。某条 `(taskCode, tierKey)` 查不到 → `3005` **并回滚整批**。响应 `null`。 | MVP |
| GET | `/api/parent/students/{studentId}/points/ledger?page&pageSize` | 流水分页，与学生端同口径（默认/上限/越界 400 共用一份 `pagination.util.ts`）。 | MVP |
| GET | `/api/parent/students/{studentId}/reward-catalog` | 奖励清单，**含已下架行**（返回软删行是为了让前端整表 PUT 时原样带回 `isActive`——否则「没带这个字段」会把已下架奖励静默重新上架）。响应：`[{id, name, description, pointsCost, minLevelCode, isActive, sortOrder}]`。 | MVP |
| PUT | `/api/parent/students/{studentId}/reward-catalog` | 整表批量保存：无 `id` 新增、有 `id` 整行覆盖、payload 里消失的 id **软删**（`is_active=0`），一个事务；空数组是合法语义（整表清空）。响应：保存后的完整清单 `[{id, name, description, pointsCost, minLevelCode, isActive, sortOrder}]`。 | MVP |
| POST | `/api/parent/students/{studentId}/points/redeem` | **201**。兑换（换钱 / 换指定奖励）：body `{type:'cash', points}` 或 `{type:'reward', catalogId}`。**方向是「积分 → 钱」**：家长输入要花掉的积分数，金额由服务端按 `cashAmount = round(points / pointsPerYuan, 2)` 推导（`pointsPerYuan` 默认 20，即 20 积分 = 1 元、家长可配）。同事务写兑换单 + 负流水 + 条件扣余额。响应：`{redemption, balance, totalEarned, level}`（`totalEarned` 必须与兑换前一致——段位不降）。拒绝码：`3001` 余额不足（含事务内条件扣减的权威判定）/ `3002` 未达段位门槛 / `3003` 奖励已下架 / `3004` 兑换已关闭；奖励不存在 `1002`。 | MVP |
| GET | `/api/parent/students/{studentId}/redemptions?page` | 兑换记录分页（`page` 从 1 起，越界/非正整数 **400**（`code=1001`，不静默钳制）；该端点**不接收** `pageSize`，响应里的 `pageSize` 恒为服务端默认 20）。响应：`{items: [{id, type, pointsSpent, cashAmount, rewardCatalogId, rewardName, status, note, ledgerId, createdAt, fulfilledAt}], total, page, pageSize}`。 | MVP |
| PATCH | `/api/parent/redemptions/{id}` | 只改兑换单状态（`pending` ⇄ `fulfilled`），**不动积分**——本期兑换**不可撤销**。**路径里没有 `studentId`**：先按 `id` 反查出该单的 `student_id` 再做归属校验；不存在 → 404 `1002`。响应 `null`。 | MVP |
| GET | `/api/parent/students/{studentId}/points/settings` | 兑换设置（读 `controls`，缺行先懒初始化补默认行）。响应：`{pointsPerYuan, rewardRedemptionEnabled}`。 | MVP |
| PUT | `/api/parent/students/{studentId}/points/settings` | 部分更新兑换设置，**至少给一个字段**（空 patch 是「什么都没改」的假成功，400）。`pointsPerYuan` 须 `1-9999` 整数。返回更新后的全量。 | MVP |

> **错误码**：`3001` 余额不足 / `3002` 未达段位门槛 / `3003` 奖励已下架 / `3004` 兑换已关闭 / `3005` 档位不存在。§2.4 已收录。
>
> **已知限制（本期不做）**：兑换**不可撤销**。家长点错只能再兑一次或线下补偿；`point_redemptions.status` 已为将来「撤销」预留状态位，但当前没有任何回补流水的路径。

### 4.22 PointsLevels — `/api/points/levels`（全量段位表，学生 + 家长）

段位表查询（2026-09-18 新增）。家长端配奖励门槛（`minLevelCode` 九选一）需要完整 9 档清单，而 §4.20 的概览只回 `level` + `nextLevel`、`me/rewards` 的 `minLevelName` 只是**逐项的名字**——都给不出「白银及以上」这种可选项。段位是 `modules/points/levels.ts` 的静态常量（单一真源），本端点**不查库、不做归属校验、无入参**，因此没有业务错误码。

> ⚠️ 路径与 §4.20 **同前缀** `api/points`，但角色是 `@Roles('student','parent')`（学生端将来也可能用），所以**不是** `PointsController`（那个类标了 `@Roles('student')`，家长 token 会被 403/1005），而是独立的 `LevelsController`——与 `ParentPointsController` 同前缀多 controller 是同一既有做法。`GET` → **200**（非 `@Post`）。

| 方法 | 路径 | 说明 | 阶段 |
|---|---|---|---|
| GET | `/api/points/levels` | **200**。全量 9 档，按 `threshold` 升序。响应：`{levels: [{code, name, index, threshold}]}`；`index` 从 0 起、与数组下标一致。前端**不得**自行维护段位表。 | MVP |

### 4.23 StudySessions — `/api/study-sessions`（学习会话采集，student）

学习时长的**采集端**（2026-09-21 埋点 Phase 1A）。全部端点 student JWT（`@Roles('student')`）；`studentId` 一律取自 JWT，端点**不接受任何「查哪个学生」的入参**。`session_uid` 由前端生成、是**幂等键**。`POST` 按 Nest 默认返回 **201**（本仓无 `@HttpCode` 覆盖，见 CLAUDE.md 同步规则 §5）。

> **`POST /api/track/events` 不在本批**：`behavior_events` 表属 Phase 2（spec §12）。在表不存在的情况下提前开端点只会得到一个 500，故本批只做**会话生命周期**（start / heartbeat / end）。

| 方法 | 路径 | 入参 | 校验与逻辑 | 返回 |
|---|---|---|---|---|
| POST | `/api/study-sessions` | `{sessionUid, module, scene, subjectId?, refType?, refId?, screenClass?, inputType?, appShell?}` | `sessionUid` 必填且必须是 **UUID 形状**（`8-4-4-4-12` 十六进制）→ 否则 1001。`module` / `scene` 必须在**封闭字典**内（后端 `STUDY_MODULES` / `STUDY_SCENES` 是唯一真源，前端 `sceneMap.ts` 只能取这里的值）→ 否则 1001。`subjectId` 若给，需是**在售学科**（本期**有意不校验**「学生是否有权学该学科」）→ 否则 1001。设备三项 `screenClass` / `inputType` / `appShell` **不做枚举校验**：命中白名单取原值，否则**落 NULL 且不报错**（设备信息是尽力而为）。`platformClass` / `browser` 由服务端从请求头 `User-Agent` 解析后落库，**不接受客户端上报**（伪造 UA 是弱信号，但至少比自报强）。**幂等**：同 `sessionUid` 重复 POST **返回既有会话**（不新建、不报错）；但该 uid 已被**别的学生**占用 → 1001「会话标识冲突」（静默返回别人的 `startedAt` 会让前端以为自己的会话在跑，后续心跳全会落空） | `{sessionUid, startedAt}` **201** |
| PATCH | `/api/study-sessions/{uid}/heartbeat` | `{state:'visible'\|'hidden'}` | `state` 必填枚举 → 否则 1001。会话不存在 / 非本人 / 非 `active` → **静默 200 返回 `{activeSeconds: null}`**（不报错：心跳是尽力而为，报错只会污染前端日志）。服务端按 `last_heartbeat_at → NOW(3)` 差值累加 `active_seconds`，**只在上一状态为 visible 时计**（hidden 暂停计时），**单次封顶 45s**（理由见 §6.25） | `{activeSeconds: number\|null}` |
| PATCH | `/api/study-sessions/{uid}/end` | `{reason}` | `reason` 必填枚举：`route_change` / `pagehide` / `idle_timeout` / `closed` / `hidden_timeout` → 否则 1001。先补计最后一段（**同心跳的封顶规则**，但不改 `client_state`），再落 `status='ended'` / `end_reason` / `ended_at=NOW(3)`。会话不存在 / 已结束 → **幂等返回现有值**（不报错、不重复计） | `{activeSeconds, endedAt}` |

> **乐观锁**：心跳 / 结束两条 UPDATE 都带 `status = 'active'` 条件——会话一旦 `ended`，迟到的请求只影响 0 行，不会把已结算的秒数再动一遍。
>
> **埋点写入的例外**：这三个采集端点是**唯一**允许 DB 失败直接 500 的埋点路径（前端传输层会吞掉，见 §6.25）；而**嵌在别的业务流里**的埋点写入（如家长端 GET 里的 `closeStale`）必须 catch、失败只 warn、绝不 500。静默隐藏故障会让生产问题只能从日志排障。

---

### 4.24 ParentInsights — 专项学情 / 真掌握度 / 目标达成（埋点 Phase 1B）

家长端「看见孩子的专项练习与真实掌握程度」这一批的 4 个端点（都挂在 `/api/parent`，parent 角色，`JwtAuthGuard + RolesGuard`）。端点定义见 §4.13 的 4 行，本节写**跨端点的口径与边界**。

| 方法 | 路径 | 入参 | 校验与逻辑 | 返回 |
|---|---|---|---|---|
| GET | `/api/parent/students/{studentId}/specials` | `from?` `to?` | `from`/`to` 交给 `resolveRange` **宽容回落**（形状非法 / `2026-02-30` 这类不存在的日期 → 近 7 天；`from > to` 自动交换）；**绝不 400**。「窗口」由应用层算好传参，**不用 `CURDATE()`**（DB 会话时区与 Node 可能不一致，会算错一天）。四个模块**后端保证都在**，不因缺数据而少键 | `{dictation, interpretation, meaning, vocabulary}` |
| GET | `/api/parent/students/{studentId}/mastery` | `limit?` | `parsePositiveInt(limit, 'limit', 10, 50)`：非法 / 越界 **400/1001**，**不静默钳制**（本仓全局纪律：静默改档会让家长以为「就这些」）。`limit` 由 controller 校验，service/repo 不再夹 | `{items, coveredQuestions, totalQuestions, uncovered}` |
| GET | `/api/parent/students/{studentId}/goals/attainment` | — | 先 `ensureDefaults`（`INSERT IGNORE`，**只补缺失**，绝不覆盖家长已改的值），再读 `is_active=1` 的行；`metric` 或 `subject_id` 为 NULL 的历史停用行、以及不在「在学学科」里的行**都不入响应**。五个达成值并行实时算（不缓存——低频只读页不值得引入失效问题） | `{items:[{metric,subjectId,subjectName,period,title,target,achieved,rate}]}` |
| PUT | `/api/parent/students/{studentId}/goals/{metric}` | `{target, subjectId}` | 顺序：归属校验 → `metric` 白名单 → body 校验 → **指标×学科匹配** → **在学学科** → upsert。`subjectId` 必填；`period`/`title` 服务端按 `metric` 派生 | 该 `(学科, 指标)` 的最新达成情况 |

**四条口径（勿「统一」掉）**

1. **`units` = 一个作答单位，不是一道题**：默写一篇一行、解释/含义**一句一行**、背单词一题一行。所以四个模块的 `units` 相加**没有业务含义**，单位词也各不相同（篇/句/句/题），UI 必须分行显示各自的单位。
2. **`rate` 分母为 0 时恒为 `null`，不是 0**：三处都用 `rate.util.ts` 的 `toRate`（唯一实现）。`specials` 的分母是「本期有明确对错的作答数」，`goals` 的分母是 `target`。**`goals.rate` 允许 > 100**（超额完成），前端不截断。
3. **掌握度与「薄弱知识点」是两套口径，并存不替换**（spec §10 硬约束）：`/mastery` 读 `student_knowledge_mastery`（**真掌握度**）；§6.8 的 `weakPoints` 是**错题数代理**（未清零错题按知识点聚合）。报告页**两张卡并存、标题不同、不得合并**。`/mastery` **必须**同时回 `coveredQuestions`/`totalQuestions`/`uncovered` —— 题库只有约 38% 的题绑了知识点。
4. **`weekly_passages` 是「去重篇目数」**：`COUNT(DISTINCT ref_id)` 跨三个语文专项（`chinese_dictation`/`chinese_interpretation`/`chinese_meaning`）。**不能用行数**——解释/含义是一句一行，数行数会把「8 句」当成「8 篇」汇报给家长（2026-09-22 用户裁决）。

**隐私分层（三道锁之一）**

本批 3 个读端点**不含任何 `tier='ops'` 派生字段**：看答案/提示依赖、连续失败、放弃点、「我不会」自评这类行为信号只进运营端，**永不进家长端**。「建议」类文案若要有，必须由后端生成**中性结论**、**不暴露任何次数**。

**归属校验**：四个 handler 的**第一条语句**都是 `await this.parentService.requireOwnedStudent(user.sub, studentId)`——不是自己孩子 → 403/1005，孩子不存在 → 404/1002。校验失败时**不取数、不写库**（403 不泄漏子账号是否存在）。

**旧 `goals` CRUD（§4.13 的四条删除线行）**：`GET/POST /goals`、`PATCH/DELETE /goals/{goalId}` **从未实现**（文档先于代码），且无 `metric` 维度，2026-09-22 起标废弃。本节的 `PUT /goals/{metric}` 与它们**没有路径冲突**（那边没有路由）；即便将来补实现，两边的 HTTP 方法也不同（PUT vs PATCH/DELETE）。

**数据流**见 §6.27；设计见 `docs/superpowers/specs/2026-09-19-analytics-instrumentation-design.md` §4.4/§4.7/§4.8/§8.2/§10。

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
  │  学生确认/编辑后 → 写入主线错题本（source=auxiliary，不参与清零门禁，PRD §7.4）
  │  ▼
  │  可继续进入 P3.4 辅线对话或 P4.2 错题重做
  │
  └─ 浏览知识点
      ▼
      GET /api/content/knowledge-points
      ▼
      选择知识点 → P3.4 辅线对话

若辅线做题做错 → 写入主线错题本（source 不参与门禁计数，不影响主线）
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

### 6.8 学情报告生成与展示（实时聚合，不落库）

```text
触发时机：家长打开学情报告页，或切换周报/月报
  │
  ▼
GET /api/parent/students/{studentId}/reports?period=weekly|monthly
  │
  ▼
ReportService 实时聚合（不落库、不调 LLM）：
  │  - ParentInsightsRepository：活跃度 / 正确率 / 自评 / 错题统计 / 趋势 / 考试
  │  - ProgressService.getStarMap（仅仪表盘用）
  │  - 窗口口径 = 近 7 天（weekly）/ 近 30 天（monthly）
  │
  ▼
直接返回结构化报告，家长端渲染图表
```

> **口径注**：正确率合并 `practice_results`（`method IN ('exact','ai')`，排除 `unanswered` / `self_assess`）与 `exam_answers`（`is_correct IS NOT NULL`）两源；`weakPoints` 是**错题数代理**（按未清零错题数排序，`student_knowledge_mastery` 全仓零写入），映射不到知识点的错题由 `weakPointsUncoveredCount` 兜住。无数据返回 200 + 空数组 / `rate: null`，不是 404。
>
> **后续迭代**：`learning_reports` 表本期**未使用**；AI 生成报告文本（`POST /api/ai/report` + `AnalyticsCapability` 的 `analysis` 场景，形状见 `ReportContent`）留作后续迭代，届时可复用本批的聚合 service。该端点的阶段标记（§4.14 仍记 MVP）将另行调整。

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

### 6.13 错题清零门禁（进每节课前清空错题本所有未清题）

```text
CourseDetailPage 加载（fetchData，带 subjectId）
  │
  ▼
GET /api/practice/uncleared-errors?subjectId={subjectId}&lessonId={lessonId}
  │  JWT -> 取 studentId；lessonId 可选（课程详情页传入当前课 id）
  ▼
PracticeService.getUnclearedErrorDetails(studentId, subjectId, currentLessonId?)
  └─ MainErrorBooksRepository.findUnclearedPracticeByStudentSubject(studentId, subjectId)
       查 main_error_books：student_id + subject_id + source='practice' + is_cleared=0
       LEFT JOIN questions 补全题面（COALESCE(q.content, wrong_answer_text)）
       按 (cardId, questionN) 去重保留最早一条（并发判题/题面变体产生的重复行）
       service 层课时过滤：currentLessonId 非空时只保留 lesson_id < currentLessonId
       （星图同款 id 数值序）——本课练习刚产生的错题不触发清零门禁，
       留待进入下一课时再清；lesson_id null 的孤儿历史行保守保留
  ▼
返回 { errors: [...] }（计数 = errors.length）
  │
  ▼
前端阶段栏 + 主内容区：
  errors.length > 0 -> 阶段栏显示「错题清零 / 有 N 道错题未清」；主内容区渲染 CleanupPhase
  errors.length = 0 -> 走正常卡片学习
  │
  ▼
CleanupPhase 逐题作答 -> 复用 POST /api/practice/judge 判题
  ├─ 答对 -> judge 内 clearUnclearedByStudentQuestion 清掉该题未清记录
  └─ 答错 -> find-or-create 保留错题本记录
  全部判完 -> 仍错的调 POST /api/practice/bump-error-levels 递增 level -> 庆祝/对错表 -> 开始学习
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

### 6.15 错题练习（训练模块）

```text
训练入口（TrainingSubjectPage）-> 错题练习
  │
  ▼
ErrorPracticePage 加载 -> GET /api/training/error-book?subjectId={subjectId}
  │  JWT -> 取 studentId；可选筛选 from/to（时间范围）/ type（题型）/ kpId（知识点）
  ▼
TrainingService.getErrorBookEntries
  └─ MainErrorBooksRepository.findErrorBookEntries(studentId, subjectId, filters)
       查 main_error_books：student_id + subject_id + is_cleared=0
       LEFT JOIN questions 补题面（COALESCE(q.content, wrong_answer_text)）+ 题型过滤
       kpId 过滤走 EXISTS question_knowledge_points
       同一错题挂多 KP 出多行 -> service 层按 errorBookId 聚合 kpIds
  ▼
返回 [{errorBookId, questionId, questionText, type, level, createdAt, kpIds}]
  │
  ▼
ErrorPracticeRunPage 逐题作答 -> POST /api/training/judge（source='error_practice'）
  ├─ 客观题 -> exact 比对；主观题（fill_blank 不等/short_answer/proof）-> AI 判定
  ├─ 答错 -> find-or-create 写 main_error_books（source='error_practice'）
  └─ 答对 -> clearUnclearedByStudentQuestionId 清该题所有未清记录（不限 source）
  答题前点「提示」-> POST /api/training/hint {questionId}
  └─ question_hints 题级缓存命中直返；未命中 AI 生成苏格拉底式提示 + 写回
  全部判完 -> 仍错的调 POST /api/training/bump-error-levels 递增 level
```

### 6.16 专项练习（训练模块）

```text
训练入口（TrainingSubjectPage）-> 专项练习
  │
  ▼
TargetedConfigPage 加载 -> GET /api/training/knowledge-points?subjectId={subjectId}
  └─ KnowledgePointsRepository.findBySubject 平铺列表，前端按 parentKpId 组树
  ▼
选知识点 + 题型（可选）+ 题数 -> POST /api/training/targeted/start
  │  请求体 {subjectId, kpId, type, count}；count 1-20，type 白名单或 null
  ▼
TrainingService.startTargetedPractice
  └─ QuestionsRepository.findRandomByKpAndType(subjectId, kpId, type?, count)
       按 question_knowledge_points 关联 + 可选题型随机抽题（is_active=1；
       choice/true_false 且 answer 为空的坏数据不进题单）
  ▼
返回 {questions: [{questionId, text, type, options}]}（白名单序列化，answer/explanation 剥离）
  └─ 抽不到题返回空数组（前端判空显示提示）
  │
  ▼
TargetedRunPage 逐题作答 -> POST /api/training/judge（source='targeted'）
  ├─ 答错 -> find-or-create 写 main_error_books（source='targeted'）
  └─ 答对 -> 清该题所有未清记录（与错题本清零语义一致）
  答题前点「提示」-> POST /api/training/hint（题级缓存同 6.15）
  （专项练习无 bump-error-levels：新错题首轮作答，无「重做仍错」语义）
```

#### 6.16.1 专项训练选题排除已标记题

```text
学生开专项练习 -> POST /api/training/targeted/start（JWT studentId 透传）
  -> QuestionsRepository.findRandomByKpAndType(studentId, ...)
  -> LEFT JOIN student_hidden_questions shq ON shq.student_id=? WHERE shq.id IS NULL
  -> 排除该生已标记不再展示的题，ORDER BY RAND() LIMIT count
题池排除后为空 -> 返回 { questions: [] }，前端 emptyHint 提示「可在清单页重置」
```

**约束**：仅 `targeted/start` 选题路径受影响；**主线练习/错题重做/考试不动**（不复用此排除逻辑）。标记维度是 `student_id + question_id` 全局排除，不分知识点——同题挂多 KP 时，标记一次即对所有 KP 的专项抽题都排除。

### 6.17 真题考试（考试模块）

```text
考试入口（试卷列表页）-> GET /api/exams/papers?subjectId={subjectId}
  └─ 可选筛选 year/district/examType/gradeBand；列表仅试卷元数据（不含题目）
  ▼
选卷 -> GET /api/exams/papers/{id}
  └─ 题目元数据 + 推荐时长 durationMinutes（白名单：无 answer/explanation）
  ▼
选时长开考 -> POST /api/exams/sessions {paperId, durationMinutes}
  ├─ durationMinutes 10-300 整数（非法 400）；试卷不存在 404
  ├─ 同卷已有 in_progress 会话 -> 续考（deadline 不变，不重置时长）
  └─ 否则新建（deadline = now + duration）
  返回 {sessionId, deadlineAt, remainingSeconds, questions}
  │
  ▼
考试进行页逐题作答 -> POST /api/exams/sessions/{id}/answers {questionId, answerText}
  ├─ JudgeCore 同步判题（source='exam', sourceRefId=sessionId）
  │    客观题 exact 即返；主观题 AI 判定（judgment per-scene 90s）
  ├─ 判题结果全量落 exam_answers（is_correct 0|1 / method / analysis / errorType）
  ├─ 答错 -> JudgeCore 写 main_error_books（source='exam'，与练习同语义）
  ├─ 判题失败 -> 先落 answerText（在途，is_correct NULL），错误透传；交卷时补判
  └─ 响应 {saved:true}——白名单不回传对错（考试防作弊：对错只在 results 出现）
     超时点提交 -> 服务端先自动收卷再 409（code=4102）
     已交卷再提交 -> 409（code=4101）
  │
  ▼
断线刷新 -> GET /api/exams/sessions/{id} 恢复
  └─ answered 只含 answerText（判题字段剥离）；超时的 in_progress 会话
     被自动收卷后返回 status='submitted'、remainingSeconds=0
  │
  ▼
交卷 -> POST /api/exams/sessions/{id}/submit（幂等：已交卷直接重算汇总返回）
  └─ finalize 三分支（手动交卷与超时自动收卷共用）：
       未作答 -> 直接判错（method='unanswered'）+ 写 main_error_books
       在途（有作答、is_correct NULL）-> JudgeCore 补判；
         失败按错计（method='failed'）仍入错题本
       已判题 -> 跳过
     markSubmitted + 汇总 {correctCount, totalCount, accuracy}
  │
  ▼
结果页 -> GET /api/exams/sessions/{id}/results（in_progress 409/code=4103）
  └─ 逐题对错（isCorrect 0|1）+ answerText/analysis/explanation
```

---

### 6.18 会话场景分型（scene）与训练「讲一讲」按题续接（2026-09-07）

> 各系统（辅线答疑 / 课堂练习讲一讲 / 卡片思辨答疑 / 训练讲一讲）共用 `ai_dialogues` + `ai_messages`
> 同一套后端链路，但**按 `scene` 分型隔离历史列表**；对话不再混在辅线答疑列表里。

`ai_dialogues.scene` 取值：

| scene | track | 入口 | 建会话方式 |
|---|---|---|---|
| `aux_qna` | auxiliary | /student/auxiliary 自由问答（默认） | `POST /api/conversations`（每次新建） |
| `aux_training` | auxiliary | 专项/错题 run 的「讲一讲」 | `POST /api/conversations` scene=aux_training（带 questionId 按题 find-or-create，不带则每次新建） |
| `mainline_question` | mainline | 课堂练习 AnswerModal 题目级讲一讲 | `POST /api/practice/discuss`（error_book 锚定，默认值见旧库回填） |
| `mainline_card` | mainline | CourseDetailPage 卡片思辨答疑 | `POST /api/practice/discuss-card`（student+card 锚定） |

辅线答疑历史列表（`GET /api/conversations?track=auxiliary&scene=aux_qna`）只返回辅线自由问答；
`GET /api/conversations` 可选 `scene` 过滤，缺省返回该 track 全部。

**训练「讲一讲」数据流（复用辅线链路 + 题目锚，气泡不再前缀题面）**：

```text
专项/错题 run 点「让 AI 讲一讲」（DiscussDrawer mode=training）
  ▼
前端（useDiscussChat）首次打开或刷新后重开：
  POST /api/conversations
  { track:'auxiliary', scene:'aux_training', questionId, questionText }
  ▼
ConversationsService.create（scene=aux_training + questionId）
  ├─ 命中该生该题既有 aux_training 会话（(student, track, scene, question_id) 索引）
  │    └─ 直接返回（跨刷新/跨设备续接同一讨论线），不重复写题面锚
  └─ 未命中 -> 新建会话 scene=aux_training + question_id
      并写一条 assistant 题面锚消息（type='transcription'，content=题面）进历史
  ▼
学生逐条追问 -> POST /api/ai/tutor/stream（mode=auxiliary, dialogueId, message=学生原话）
  │  TutoringCapability 每轮把整段对话历史（含题面锚）带进 prompt -> AI 始终知道题目
  └─ 学生消息/气泡/持久化都只存原话，不再前缀「这道题目是：…」
```

- 展示归一：抽屉顶部「当前题目」栏展示题面；历史加载时隐藏题面锚 assistant 消息，并对修复前旧会话
  里 `role=user` 带「`这道题目是：…我的问题：`」前缀的消息做剥离显示。
- 存量迁移：旧 auxiliary 会话中带该前缀的归 `aux_training`；mainline 中能被 `main_error_books.dialogue_id`
  锚定的归 `mainline_question`，其余归 `mainline_card`。详见
  `tools/db/migrations/2026-09-07_add_ai_dialogues_scene.sql`。

### 6.19 主观题自评（self_assess 模式，2026-09-09）

`JUDGE_SUBJECTIVE_MODE=self_assess`（默认）下，short_answer/proof/calculation 等主观题不判对错，学生对照参考答案自评。时序：

1. **提交**：学生提交主观题答案——训练当场（`POST /api/training/judge`）、考试单题（`POST /api/exams/sessions/{id}/answers`）或课堂练习（`POST /api/practice/judge`）。
2. **judge 返回 needsSelfAssessment + 参考答案**：JudgeCore 对主观题不调用 AI 判定——训练/考试响应带 `needsSelfAssessment=true` 与参考答案 `referenceAnswer`（考试仅在交卷后 results 透出，字段名 `answer`，防作弊）；课堂练习不落 `practice_results` 行（`is_correct NOT NULL`，推迟到自评端点补写）。
3. **前端展开自评**：训练当场在答题位展开「我做对了 / 做错了」自评（对照参考答案）；考试结果页对 `needsSelfAssessment` 的题展示参考答案与自评入口。
4. **self-assess 端点落库**：训练/考试来源走 `POST /api/training/self-assess`（`source=targeted|error_practice|exam`，考试带 `sourceRefId=sessionId`）；课堂练习走 `POST /api/practice/self-assess`（卡中心变体，补写 `practice_results` method='self_assess'）。两路共同动作：`question_self_assessments` 留痕；`incorrect` 写入/复用 `main_error_books`（触发解析缓存兜底生成），`correct` 清零该题所有未清记录（错题本写入/清零参与主线清零门禁）。
5. **考试成绩只算客观题**：主观题 `exam_answers.is_correct=NULL`、`method='self_assess'`，交卷/结果汇总 `correctCount`/`accuracy` 只算客观题，`subjectiveCount` 单列；结果页 `selfAssessment` 从留痕表恢复最近一次自评（刷新不丢）。

`ai` 模式（`JUDGE_SUBJECTIVE_MODE=ai`）保留原 JudgmentCapability AI 判定路径可切回；遗留 `ai` 模式已判的主观行（`is_correct` 非 NULL）在结果页计为客观错题。

### 6.20 语文古诗文默写（训练模块，2026-09-13）

```text
训练入口（TrainingSubjectPage）-> 语文 -> 语文专项页（ChineseSpecialPage，两卡：古诗文默写可点 / 古诗文解释灰化）
  │
  ▼
DictationConfigPage 加载 -> GET /api/training/dictation/passages
  └─ DictationPassagesRepository.findVerifiedBySubject(2=语文)
       JOIN questions q ON q.id = dp.question_id
       WHERE q.subject_id=2 AND q.is_active=1 AND dp.verified=1 AND dp.memorize_required=1
       ORDER BY dp.sort_order, dp.id
     只返回篇名元数据（questionId/workTitle/semester），不含作者/朝代/正文
  ▼
选范围（上册/下册/全部）+ 题量（1-20）-> POST /api/training/dictation/start
  │  请求体 {semester: '上册'|'下册'|null, questionIds: number[]|null, count}
  ▼
TrainingService.startDictation
  ├─ passageIds 非空 -> findVerifiedByIds（按指定篇目，忽略 semester）
  └─ 否则 -> findRandomVerified(semester, count)
       ORDER BY RAND() LIMIT count（「全部册次」时按篇名去重，跨册取 MIN(id)）
  ▼
返回 {questions: [{passageId, prompt, workTitle, semester}]}
  └─ 白名单序列化：author/dynasty/正文 剥离（防答案泄露）；prompt 由篇名服务端生成
  │
  ▼
DictationRunPage 逐篇三字段作答（作者/朝代/正文）-> POST /api/training/dictation/judge
  ├─ JudgeCoreService.judgeDictation（**纯程序化，不调用任何 LLM**）
  │    ├─ evaluateDictation(expected, student)：三字段各自 normalizeChineseAnswer 后全等
  │    │     （NFKC 全半角归一 -> 去空白 -> 去中英文标点 -> 小写）
  │    │     —— 学生正文带不带标点/空格/全半角均不影响判对错
  │    ├─ 正文不等 -> diffChineseInOriginalText(expected, student) LCS 逐字差异
  │    │     相邻「漏写+多写」合并为 wrong（写错字）；连续同类项合并成段
  │    │     差异在归一文上算，再**把标点回投到原文**（标点归其后那个字，串尾标点归末字）：
  │    │     equal 段带前后标点、wrong 段保持单字、整段漏写保留段内段尾标点
  │    │     —— 判对错口径不变，学生看到的对比是带标点的整句
  │    └─ isCorrect = author.match && dynasty.match && body.match（三项全对才算对）
  ├─ **不写任何学生状态**（独立子系统：不入错题本、不清零，2026-09-15 起；
  │     也不触发 ExplanationCacheService——避免长文言文 answer>=100 字被直写成「解析=正文」）
  └─ 立即返回（实测 ~25ms，**不等错因**）
  ▼
返回 {passageId, isCorrect, fields, bodyDiff, reference, feedback(恒 null), feedbackPending}
  ├─ 前端立刻渲染对错 + 正文对比（带标点）
  └─ feedbackPending=true（答错）-> 前端另调 POST /api/training/dictation/feedback
       ├─ 服务端纯函数重算差异（**只读篇目、只算差异，不写任何学生状态**）
       ├─ DictationFeedbackCapability.generate（scene=dictation_feedback）
       │    primary=local（本地 llama.cpp Qwen3.8-27B，靠 chat_template_kwargs 关 thinking）
       │    -> fallback=deepseek-flash
       └─ 成功 -> feedback=错因 prose（实测 ~2s）；失败/不可达 -> feedback=null（不报错）
  └─ 错因区在等待期间显示转圈 +「AI 正在生成错因提醒…」，到位后替换为文案
     （为 null 时显示兜底文案）；全部答完点「完成」回语文专项页
```

**跨学科隔离**：古诗文专项是**独立子系统**——默写不写错题本、解释也不写（2026-09-15 独立化后判题完全不碰学生状态），篇目不挂知识点、不在 `targeted/start` 的 `TARGETED_TYPES` 白名单内，故数学/语文专项练习与错题练习都抽不到它们。抽题只按 `chinese_passages` 自己的闸门（默写 `verified + memorize_required + is_active`；解释 `verified + is_active + 内容就绪`）。

**判题与错因解耦**：对错完全由程序决定，`dictation_feedback` 场景只负责生成可选的错因话术——LLM 超时、无 key、本地模型不可达都只让 `feedback=null`，不影响判题响应。

**2026-09-14 解耦动因**：解耦前错因 LLM 调用挂在 `judge` 的关键路径上，而本地 `Qwen3.8-27B` 是**思考模型**（先出 `reasoning_content` 再出正文），一次错答要等 13–16 秒才看到对错，且前端全程只有一个变灰的「正在判题…」按钮——学生以为卡死。现在判题 25ms 出结果、错因异步补取、等待期间有转圈动画；同时错因调用关掉 thinking（2s 量级）。

### 6.21 语文古诗文解释（翻译）：三行对译 + 逐句判题（2026-09-16）

```
InterpretationConfigPage 加载 -> GET /api/training/interpretation/passages
  └─ 抽题池：verified=1 AND is_active=1 AND JSON_LENGTH(sentences) > 0
     （比默写多「内容就绪」、少「必背」；只出篇名 + 册次）

选范围（全部/上册/下册）+ 篇数（1/2/3）+ 可选指定篇目 -> POST /api/training/interpretation/start
  └─ 服务端查 chinese_passages，**一次返回整篇所有句子**
       {passages: [{passageId, workTitle, semester,
                    sentences: [{index, text, terms: ["依","尽"]}]}]}
       ↑ terms 只有词名；gloss（释义）/ translation（译文）/ full_translation 一律剥离
  └─ 存 sessionStorage('training:interpretation') -> InterpretationRunPage 一次性读入
  └─ 前端把整篇句子渲染成「逐句卡片」列表（所有句子从第一秒起就在 DOM 里）

InterpretationRunPage 逐句作答（三行对译）：
  行1 原文（句中关键字词下划线高亮）
  行2 该句的关键字词 → 每词一个释义输入框（该句无字词则整行不渲染）
  行3 整句翻译 textarea
  └─ 点「下一句」-> POST /api/training/interpretation/judge（**异步，不等它回来**就展开下一句）
       ├─ ① 程序短路（不进 LLM）：空白 -> unanswered；normalizeChineseAnswer 全等 -> exact
       ├─ ② 剩余待判项打包**一次**调用
       │     scene=interpretation_judge
       │     primary=local（Qwen3.8-27B，靠 chat_template_kwargs 关 thinking）-> fallback=deepseek-flash
       │     实测整个判题 ~1.3s
       └─ ③ 模型漏项 / 整次失败 -> 那些项 correct=null, method='undetermined'
             （不抛错；**已判项不清空**——重判时前端保留旧值）
  └─ 结果**就地回填到该卡片**：字词结果贴在该字词输入框下、整句结果贴在 textarea 下
       正确 / 错误（附标准答案 + 点评）/ 未判定
  └─ 学生答案留在 disabled 的输入框里，与标准答案上下并排（不换页的主要收益）
  └─ 有 undetermined 项时给「重新判题」（重发同一 payload；前端合并保留已判项）
  └─ 最后一句判完 -> 本篇完成区：全文对照（学生逐句译文拼接 vs fullTranslation）+ 统计
       ↑ fullTranslation 只在最后一句的响应里下发（提前给等于泄题）
  └─ 「下一篇」（还有篇目时）/「完成」（清 sessionStorage 回语文专项页）
     一篇判完才能进下一篇（用户 2026-09-16 要求）

判题**不写任何学生状态**（无错题本 / 隐藏题 / 提示缓存 / 自评）——独立子系统，PRD §6.3 / §7.4 例外。
```

**内容从哪来**：`start` 一次给全「原文 + 该句有哪些关键字词」；**标准释义与标准译文只在该句判题返回时逐句下发**——这是本设计与默写最大的口径差别，防的是「还没答就看见答案」。字词由用户整理后交 `tools/data-refinery/src/interpretation_cli.py` 入库（`key_terms` 每项带 `sentenceIndex` 指出该词属于哪一句）；译文为**混合模式**——输入给了就用输入的，没给由管线调本地 LLM 生成。

### 6.22 英语背单词（训练模块，2026-09-16）

```text
VocabularyConfigPage 加载 -> GET /api/training/vocabulary/options
     └─ 三档词库范围（仅初中 / 仅高中 / 全部，各带词数）+ 今日已背 + 四个筛选的池子大小
选范围 + 背几个（10/15/20）+ 顺序（随机/字母序/倒序/指定字母开头）+ 方向 + 四个筛选
     -> POST /api/training/vocabulary/start
        ├─ 服务端把 direction 落定（random 在本词出得了的方向里等概率掷）；勾 onlyExtendedSense 时强制 en2cn
        ├─ 四个方向：en2cn 给单词 / cn2en 给中文 / ph2en 给音标（看音标写单词）/ random 逐题掷
        │     · ph2en 要求词有可用音标（`/`、`//` 算没有）→ 没有就退化成 en2cn，不丢词
        │     · 熟词僻义题恒为 en2cn（ph2en 只有音标，说不出搭配，而搭配正是考点）
        ├─ 仓储先取候选池（只取 id 等索引列，**不取 meanings**），服务层洗牌/排序切 N
        │     —— 绕开 ORDER BY RAND() + LIMIT ? 的坑，四种顺序模式共用一条 SQL
        ├─ 再按 id 取完整词条，逐词造一道题（会话长度 == count）
        └─ **防泄漏**：promptKind=cn2en 的题不下发 word/phonetic/context/hasFamily
              （题面是中文释义、答案是英文单词；且词根族树里必然含单词本身）
  └─ 题单写 sessionStorage('training:vocabulary') -> 跳答题页
  └─ 题池为空 -> 就地提示「换个范围或取消几个筛选」，不跳转

VocabularyRunPage：题面 -> 作答 -> **提交即翻下一个词，不等判定回来**
     -> POST /api/training/vocabulary/judge（fire-and-forget）
        ├─ 路由① 中→英：纯程序比对（拼写变体表），答错给 spellingDiff  ——**不调 LLM**
        ├─ 路由② 英→中·常见义：gloss 拆原子归一化比对命中即 exact
        │     未命中 -> scene=english_word_judge（primary=local，靠 chat_template_kwargs 关 thinking）
        │                  -> fallback=deepseek-flash，二档 correct|wrong
        ├─ 路由③ 英→中·熟词僻义：只认目标僻义义项（**带锁定僻义的语境搭配**喂模型）
        │     未命中 -> 同一场景，三档 correct|off_target|wrong
        │                 （common 模式下模型若输出 off_target 会收敛成 wrong）
        ├─ senseIndex 越界（内容重灌后下标漂移）-> 按「全义项都接受」判，宁放过不错杀
        ├─ 判题失败 -> verdict='undetermined'（不抛错）
        └─ 记账：correct 置 learned；wrong 给学生 wrong_count 与全局 error_count 各 +1
              **off_target / unanswered / failed 三者都不计错**
  └─ 判定回来 -> 回填底部累积清单（✓ 答对了 / △ 未答到考点 / ✗ 答错了 + 标准释义）
  └─ 点「+」号 -> GET /api/training/vocabulary/words/{wordId}/family
       ↑ **只在英→中题上渲染入口**——族树里必然包含单词本身，中→英题点开等于看答案
  └─ 答错的词可点「移除易错标记」-> POST /api/training/vocabulary/progress/clear
       （只清该学生自己的 wrong_count，不动 learned、不动全局 error_count）
  └─ 答完最后一个词 -> 本轮成绩（对 / 未答到考点 / 错）+ 完整清单，清 sessionStorage 回配置页

判题**不写错题本、不清零、不写隐藏题/提示缓存/自评**——独立子系统，PRD §6.3 / §7.4 例外。
只写两张自己的表：`english_words.error_count`（全平台累计错次，只增）与
`student_word_progress`（学生自己的 learned / wrong_count / last_seen_at）。
```

**异步判定落在前端，不在后端**：后端 `judge` 是单题同步（服务端照常等 LLM），前端提交后立刻翻词、结果回来再回填。这样不需要 job 队列或任务表，刷新即丢也可接受——进度已落库，「今日已背」不会丢。

**词根族的数据形态**：`english_words.root_key` 指向族中心词（中心词自己也填自己的 `word`，该不变式由内容管线 check 保证），`root_affixes` JSON 存成员相对中心词的词缀注记。**不建新表**——`WHERE root_key = ?` 一句取全族。不规则派生（`decide → decision`）以「成员 + 词缀注记」表达，族中心必须是词表内已核对的词，这样不会出现 LLM 编造的词根。

**内容从哪来**：词库为课标官方 PDF 附录词汇表（义务教育 2022 版 1600 词 + 高中 2017 版 2020 修订 3000 词），熟词僻义与词根族由「我出草稿 + 程序硬校验 + 人工审」产出，走 data-refinery 旁路管线（见 `docs/data-refinery-使用手册.md`）；**本期以 DEV-FIXTURE 假数据打通链路，真实词库待内容管线导入**（`npx tsx src/scripts/seed-vocabulary-fixture.ts`）。

### 6.23 语文古诗含义（深层含义 + 作者情感，2026-09-17）

```text
MeaningConfigPage 加载 -> GET /api/training/meaning/passages
     └─ 抽题池：verified=1 AND is_active=1 AND JSON_LENGTH(sentences) > 0
                AND sentence_meanings IS NOT NULL
        （比解释专项多「有含义数据」；只出篇名 + 册次）
选范围（全部/上册/下册）+ 篇数（1/2/3）+ 可选指定篇目 -> POST /api/training/meaning/start
     └─ 服务端查 chinese_passages，**一次返回整篇所有句子**
          {passages: [{passageId, workTitle, semester,
                       sentences: [{index, text,
                                    terms: [{term:"谪（zhé）守", plain:"谪守"}],
                                    answerable: true}]}]}
          ↑ meaning（深层含义）/ emotion（作者情感）/ translation /
            full_translation / author / dynasty / body 一律剥离
     └─ 存 sessionStorage('training:meaning') -> MeaningRunPage 一次性读入
     └─ 顶部原文条渲染**整首诗**（含 answerable:false 的句子），当前句高亮、已答置灰
        ↑ answerable:false = 该句没填标准含义：**只显示、不进作答队列**

MeaningRunPage 逐句作答（一字词 / 二含义 / 三情感）：
  行1 该句关键字词 → 每词一个释义输入框（该句无字词则整行不渲染）
  行2 本句深层含义 textarea
  行3 作者情感 textarea
  └─ 点「提交」-> 立即在结果栈顶插「判定中…」占位 -> 作答区推进下一句（**异步，不等回来**）
       POST /api/training/meaning/judge
        ├─ ① 空答案短路（唯一的程序判断）-> correct=false, method='unanswered'
        ├─ ② 剩余待判项（该句字词 + 含义 + 情感）打包**一次**调用
        │     scene=chinese_meaning_judge
        │     primary=local（Qwen3.8-27B，靠 chat_template_kwargs 关 thinking）-> fallback=deepseek-flash
        └─ ③ 模型漏项 / 整次失败 -> 那些项 correct=null, method='undetermined'
              （不抛错；**已判项不清空**）
  └─ LLM 回来 -> 原地替换占位：字词 / 含义 / 情感 各自 ✓✗，判错的并列「你的」与「标准」+ comment
        `undetermined` 显示「未判定」+ 「重新判题」
  └─ 一首答完 -> 该首小结卡（字词 x/y · 含义 x/y · 情感 x/y）->「下一首」（结果栈每首清空）
     全部答完 -> 总结，清 sessionStorage 回语文专项页

判题**不写任何学生状态**（无错题本 / 隐藏题 / 提示缓存 / 自评）——独立子系统，PRD §6.3 / §7.4 例外。
```

**与解释专项最关键的差别：判题没有程序短路**。`method` 只有 `ai|unanswered|undetermined`，**刻意没有 `exact`**——含义与情感是理解性作答，拿 `normalizeChineseAnswer` 全等去判「对」不成立（学生逐字抄对也不代表理解了），一律过 LLM；唯一的程序判断是「空答案 → `unanswered`」。有用例钉住 `method` 不会出现 `exact`，勿「顺手补上」。

**`answerable` 是「显示」与「出题」的分界**：`start` 把整篇句子的 `text` 全给（诗要完整显示），但 `sentence_meanings` 对应下标为空的句子标 `answerable:false`——前端只把它显示在顶部原文条里、不进作答队列，`judge` 提交这样的句子返回 400。此外 `sentence_meanings` 与 `sentences` **长度不一致时整个按无含义数据处理**（`toSentences` 丢项、`toSentenceMeanings` 保位置，两者不等时 `meanings[i]` 描述的是另一句，静默串句比少判一句糟）。

**内容从哪来**：`sentence_meanings`（每句的含义 + 情感）由**人工填写**——`tools/data-refinery` 的 `meaning_cli.py`（**已实现**，含 15 用例）复用 `answer_importer` 的 `--export` / `--apply` 两步：导出带原文的模板（人工只填「含义」「情感」两个空；**库里已填过的句子连同含义/情感一起回填**，故「导出 → 改一句 → 回写」这条修订路径不会把该篇其余句子抹成 `null`），再**按原文在 `sentences` 里定位下标**幂等写回（不按行号、不做整体长度断言；定位不到的句子写进 `-review.md` 并跳过；只 `UPDATE` `sentence_meanings` 一列，绝不刷掉 `verified`/`is_active`/`memorize_required` 的人工标定）。**整篇一句都没填的篇目拒绝写库**——既避免只剩原文的模板把库里已填含义整列抹掉，也避免 all-`null` 数组混进抽题池（抽题池只查 `sentence_meanings IS NOT NULL`，挡不住全 `null`）。本管线**不调 LLM**。

### 6.24 闯关积分：发分 → 流水 → 快照 → 段位，与积分兑换（2026-09-17）

积分是**平台级**的激励层（不分学科、不分轨道，段位全局唯一），加在既有流程**旁边**而不是里面：**不影响任何门禁**（不清零错题、不替代错题本、不参与主线解锁判定）。只有「完成任务」产生积分，辅线答疑不产生。

```text
8 类任务的完成事件（粒度分三类，spec §6.1）
  ├─ 甲类 · 逐目标发分（每完成一个「目标物」发一次，不新增端点）
  │    cn_dictation / cn_interpretation → 篇目判题端点里发（按该篇 genre 取档：诗 2 / 文言文 5）
  │    cn_meaning → 该篇**最后一个可作答句**判完时发（整篇答完一次，见下）
  │    error_fix  → 错题被清零（clearUnclearedByStudentQuestionId 的 affectedRows > 0）时发
  │    判题响应内联 pointsAwarded / awardReason（§4.18 语文三专项 + practice/training judge）
  ├─ 乙类 · 整批发分（分值由学生开练时选的**档位**决定，必须整轮发）
  │    math_targeted / en_vocabulary → POST /api/training/sessions/:id/complete
  │    分值取**会话记录里的档位**、不取前端入参；start 时把题单规模写进 expected_count
  └─ 丙类 · 既有完整事件点直接埋
       mainline_lesson → POST /api/progress/update 推进到下一课/完成时（响应带 points）
       math_paper      → POST /api/exams/sessions/:id/submit 交卷后（响应带 points）
  ▼
PointsService.award —— 8 条路径的**唯一**发分入口，顺序固定（每步都有理由）
  0 确保规则存在（INSERT IGNORE 补默认档位：INSERT 撞键即跳过，家长改过的值永不回溯）
  1 查规则 → 2 档位 → 3 停用 → 4 每日上限 → 5 发分前累计 → 6 事务[写流水 + 快照增量] → 7 跨档
  · 每日上限必须早于 INSERT：先写再判会让「到上限的那一条」已经落库
  · 发分前累计必须早于事务：detectLevelUp(old, new) 要的是事务前的旧值
  · 停用早于上限：停用档位连计数都不该查
  ▼
point_ledger（**唯一真源**）—— 一条 earn 正流水
  · 幂等靠 uniq_point_ledger_dedupe：INSERT IGNORE 撞键 = 「已发过」，不报错、不重复加分
  · 幂等键由**服务端从已知 id 拼**（如 paper:<sessionId> / tsess:<sessionId> / err:<sid>:<qid>:<日期>），
    绝不接受请求体里的字符串——key 嵌了自增 id，可被枚举/构造
  · title 存**快照**：家长之后改分值/档位名，历史流水不变
  │  同事务
  ▼
student_points（**读优化快照，可重建**）
  · total_earned = SUM(points) WHERE kind='earn'（单调递增）
  · balance      = SUM(points) 全部 kind
  │  **段位不落库**：由 total_earned 对照 levels.ts 常量实时算（9 档，见 PRD §7.13）
  │  total_earned 单调递增 → 段位只升不降，没有也不该有降级逻辑
  ▼
GET /api/points/me（学生，§4.20） / GET /api/parent/students/:id/points（家长，§4.21）
GET /api/points/levels（学生+家长，§4.22）—— 段位表静态常量，家长端配奖励门槛（9 选 1）的唯一数据源
```

**每类埋点都 try/catch 吞异常**：积分是激励层，发分失败绝不能阻塞主线推进 / 判题 / 交卷。发分失败时「本次加了 0 分」与「真的 0 分」必须可区分——所以失败路径的 `balance` / `totalEarned` 回 `null`（`award_failed`），**绝不伪造 0**（那会污染前端本地快照）。

**兑换：积分 → 钱 / 奖励（家长端操作，本期不可撤销）**

```text
POST /api/parent/students/:id/points/redeem
  0 type 白名单（非法立刻 1001，不碰任何 DB）
  1 兑换总开关（关了立刻 3004，连快照都不读）
  2 解析兑换内容：现金验 points（1-999999）；奖励验存在（1002）/ 已上架（3003）
  3 读快照：段位门槛与余额**共用这一次读**（奖励的 min_level_code 非空时校验段位，未达 3002）
  4 余额**预检**（3001，advisory 快失败，非权威）
  5 事务：兑换单（pending）→ 负流水 → **条件扣余额** → 回写 ledger_id
       · 顺序不能变：先插兑换单拿自增 id，才能拼 dedupe_key='redeem:<id>'
       · 权威余额闸门是条件 UPDATE（WHERE balance >= ?）：并发两次兑换由 InnoDB 行锁串行化，
         只有一方 affectedRows=1；为 0 → 3001 回滚。先读后写会把 balance 扣成负数
  6 事务后重读快照返回
  ▼
point_ledger 多一条**负数** kind='redeem' 行（task_code 固定 'redeem'）
student_points **只减 balance**（earnedDelta 恒为 0）——SQL 里根本不出现 total_earned
  ⇨ 这就是「段位只升不降」的实现点：任何改动若让它写 total_earned，段位就会被扣低
```

**快照漂移的修复**：`student_points` 只是快照，与流水不一致时**从流水重算**，不手改行——
`cd apps/server && npx tsx src/scripts/rebuild-student-points.ts`。它**只读流水、绝不写流水**，
对每个 `point_ledger` 里出现过的学生算 `SUM(kind='earn')` 与 `SUM(所有)` 后整行覆盖快照。

**为什么每日上限不用 SQL 的 `CURDATE()`**：DB 会话时区与 Node 应用时区可能不一致，`CURDATE()` 会算错一天。两个日界（当日 00:00 / 次日 00:00）由**应用层**按服务器本地时区算好、作为绑定参数传进 SQL（半开区间 `>= start && < end`，跨月跨年无需拼接）。同一口径在 `student-word-progress.repo.ts` / `vocabulary.service.ts` 已有先例。**也不去改 `connection.ts` 的会话时区**——那会改变全应用 `NOW(3)` 的取值。一次调用里 `now()` 只取一次、两个边界由同一个 `now` 派生：各自取钟若跨过午夜会撑出 48 小时窗口，把两天的发分都算进今天。

**`error_fix` 为什么排除考试来源**：`error_fix` 的发放条件是「`clearUnclearedByStudentQuestionId` 的 `affectedRows > 0`」，它只覆盖**做题时清零**的路径。考试交卷的补判路径（`finalizeSession` 补判在途/未作答题目）**不参与发分**——否则「交卷」会顺带冒出大量错题订正分，与 `math_paper` 的交卷分重复，学生什么额外的事都没做。所以补判路径不调 award。

**`cn_meaning` 为什么用「最后一个可作答句」而不是 `sentences.length - 1`**：末句可能没有标准含义（`sentence_meanings[i] == null`、`answerable:false`、根本不出题），按下标 `length - 1` 判定会让这类篇目**永远拿不到分**。正确口径是「最大的 `i` 使 `meanings[i] != null`」，实现在 `meaning.service.ts`。**解释专项**同理：它没有「整篇答完」的概念，但 `fullTranslation` 只在被判的是**最后一句**时下发（提前下发整篇译文等于泄题）。

**`math_targeted` 为什么也要每日上限（默认 5 次）**：四档是**打包价**（「3 题 8 分」不是 3×2），档位由**学生自选**、幂等键按 `sessionId`（每次开练都是新 key）。若不限次，把题池缩到 1 题就能用 `10` 档（35 分）反复 complete 无限刷。每日上限按 `task_code` 计数、四档**共用 5 次**（与 `en_vocabulary` 三档共用 2 次同口径）。每日上限是主要（也是唯一）防刷手段。

**兑换为什么写 `earnedDelta: 0`**：`student_points.total_earned` 是段位唯一依据，语义上不可回退。兑换扣的是「可用余额」`balance`，若同事务里把 `total_earned` 也减掉，段位立刻会降，破坏 spec §3 定案 #2。所以兑换的扣减 SQL **只 `SET balance`**、结构性保证不触碰 `total_earned`（见 `student-points.repo.ts` 的 `deductBalanceIfEnough`）。

### 6.25 会话心跳 → 学习时长聚合（埋点 Phase 1A，2026-09-21）

学习时长的端到端链路（采集在 §4.23、读侧在 §4.13）。**设计见 `docs/superpowers/specs/2026-09-19-analytics-instrumentation-design.md` §4.2 / §7.4 / §8 / §10。**

```text
前端 AnalyticsShell（useLocation 副作用驱动，唯一开会话入口）
  · tracker.onRouteChange(sceneInfo) 经状态机 runTransition('ROUTE_ENTER') → beginSession()
  · 只在「学习页」开会话（sceneKey !== null）；配置页 / 入口页只管看、不算时长
  · subjectId 从 useLearnContextStore 取（不是路由 state——深链 / 直接刷新走不到那次写入）
  · 设备三项（screen_class / input_type / app_shell）只在 start 时采一次，中途转屏不改
  ▼
POST /api/study-sessions（@Post 默认 201；幂等键 = 前端生成的 UUID）
  · 服务端解析 UA → platform_class / browser；非法设备值落 NULL、不报错
  · iPad 校正：platform_class=='mac' 且 input_type=='touch' → 'ipad'
    （iPadOS 13+ 的 Safari UA 写 Macintosh，只看 UA 必然把 iPad 判成 Mac，而 iPad 横屏是主断点）
  ▼
PATCH /api/study-sessions/:uid/heartbeat  {state:'visible'|'hidden'}    每 30s
  · 服务端按 last_heartbeat_at → NOW(3) 差值累加 active_seconds
  · 只在「上一状态为 visible」时计（hidden 暂停计时）
  · 单次增量 LEAST(..., 45)；GREATEST(0, ...) 兜住客户端 / DB 时钟回拨
  · ⚠️ UPDATE 的 SET 列表列顺序是 load-bearing 的：IF(client_state='visible', ...) 必须排在
    client_state=? 之前——MySQL 单表 SET 从左到右求值，后出现的表达式引用前面已赋值的列时读到的是
    **新值**；顺序反了语句照样编译运行，但会静默算错时长（有顺序钉子用例守着，别调换）
  · 未命中（不存在 / 非本人 / 非 active）→ 静默 200 {activeSeconds: null}
  ▼
PATCH /api/study-sessions/:uid/end  {reason}    路由离开 / pagehide / 挂机
  · 先补计最后一段（同心跳的封顶规则，但不改 client_state），再落 status='ended'
  · ended_at = NOW(3)（**不是** last_heartbeat_at）：用户按「离开」时已过一段时间，秒数已按差值补进来
  · 幂等：已 ended 时 UPDATE 影响 0 行 → 回读现有值返回，不重复计
  ▼
study_sessions（学习时长唯一真源，迁移 2026-09-21_study_sessions.sql）
  │  孤儿会话：用户直接关标签 / 断网 → 没有 end 请求，会话会永远停在 active
  ▼
closeStale（惰性收尾；家长端读前传 studentId = 顺带修正那个人。**预留**全库收尾入口
  ——不传 studentId 的调用形态当前**无调用方**、夜间定时任务**未实现**，参数留着给后续阶段用）
  · status='active' 且 last_heartbeat_at < NOW(3) - INTERVAL 5 MINUTE
    → status='ended', end_reason='closed'
  · ended_at = last_heartbeat_at（**不是 NOW**）：最后 5 分钟的实际状态未知，不能白送时长
  · 家长端调用处**吞异常**（closeStaleQuietly 失败只 warn）——收尾失败绝不该把家长页打成 500
  ▼
家长端读侧 parent-analytics.repo.ts（只读、唯一入口）
  · 有效会话谓词 EFFECTIVE_SESSION（五处聚合共用：total / byDay / byModule / bySubject / activeDays，唯一口径）：
      status IN ('ended','abandoned')
        OR (status = 'active' AND last_heartbeat_at < NOW(3) - INTERVAL 5 MINUTE)
    ——已变成孤儿但还没被 closeStale 收尾的 active 会话也要算进来，
      否则「今日已用」会永远不更新（散点 SQL 漏掉这个分支会让各卡片互相打架）
  · 窗口由**应用层**算好传参（from 含 / toExclusive 不含），**不用 CURDATE()**
    （DB 会话时区与 Node 可能不一致，会算错一天——沿用 point_ledger 的既有约定）
  ▼
GET /api/parent/students/:id/study-time（§4.13）/ today-usage（§4.13）
```

**为什么单次封顶 45s**：心跳间隔 30s，45s 给一次网络抖动留余量。**不封顶**时，用户关掉标签页 2 小时后若再有一次迟到心跳（或紧接着的惰性收尾 / end），差值会把整段 2 小时算成学习时长；封顶后最坏只多算 45s。客户端上报的秒数**一律不采信**——`active_seconds` 只由服务端按 `last_heartbeat_at` 差值累加。

**与前端口径的关系（spec §10 硬约束，一行都不能改）**：家长端的「学习时长（会话）」是**新增口径**，不是对既有「近 7 天活跃天数」的修正——两者**并存、不替换**。旧「活跃」是 `practice_results ∪ point_ledger ∪ exam_sessions ∪ ai_messages` 的**四路时间戳代理**，新「时长」只来自**显式会话**，两者数字会明显不同（孩子挂机不答题：旧口径不活跃、但页面开着则新口径有；反之只看一页不操作可能两边都不算）。UI 必须**并列展示 + 区分文案**（如「学习时长（会话）」vs「活跃天数」），**不得合并、不得相互替换**——否则家长会看到数字莫名下降。响应里的 `source: 'sessions'` 就是口径标记。

**前端传输层刻意吞错**：`apps/web/src/analytics/tracker.ts` 的 `start` / `heartbeat` / `end` 全部 `.catch(() => {})`——埋点失败**绝不打断学习**。所以服务端的三个采集端点允许 DB 失败直接 500（前端无感，且静默隐藏故障会让生产问题只能从日志排障）；而嵌在别的业务流里的埋点写入必须 catch（失败只 warn，见 §4.23 注）。

**本批范围**：前端 `analytics/` 只做**会话生命周期**（start / heartbeat / end + 设备分档 + 状态机）。`behavior_events` 与 `POST /api/track/events` **有意留到 Phase 2**（表尚不存在，提前开端点只会得到 500）；家长端 / 管理端**不启动会话追踪**（`tracker.setEnabled` 按角色关闭）。

### 6.26 LLM 调用 → 账本 → token 计量（2026-09-20）

任何 capability 最终都经 `ModelClient.chat()`（`ai-core/infra/model-client/index.ts`）。在那里：

1. **归因**：`ModelRouter.route()` 给 primary/fallback 条目打 `scene`/`subject`/`modelKey`/`isFallbackEntry`；
   HTTP 路径的 `student_id`/`request_id` 由 `AsyncLocalStorage`（`ai-core/infra/request-context.ts`）带出，
   后台路径（判错解析、会话标题）由调用方显式传 `ChatRequest.meta`。
2. **usage**：流式默认拿不到，故请求体下发 `stream_options.include_usage`（本地 llama.cpp 例外，它不认）；
   仍拿不到则**输入/输出分别估算**（输入估自 `request.messages`、输出估自响应正文）并把 `usage_source`
   标为 `estimated`；两者都无则 `unavailable` 且两个 token 列写 **NULL**（**绝不写 0** —— 0 会让
   「用量缺失」在报表上隐身）。
3. **落库**：每次逻辑调用 + 每次重试尝试各一行，`attempt` 递增；失败/超时也记（`success=0`、`error_type`）。
   写入走 `TelemetryBuffer`（2s 或 200 条 flush，满 5000 丢最旧，失败整批丢弃不重试）。
4. **本期只记 token，不记价格与成本**（用户 2026-09-19 裁决）：账本只有 `input_tokens` / `output_tokens` /
   `usage_source`，**没有** `cost` 与价格快照列；`llm_models` 也不加价格列。以后按 token 计价，
   钱由 token 换算，平台不必自己算。

---

### 6.27 判题出口 → 专项流水 / 掌握度 / 完课 → 家长端聚合（埋点 Phase 1B + P6.5，2026-09-22）

专项学情、真掌握度、**按学科目标**的端到端链路（读侧在 §4.13 / §4.24，写入嵌在既有判题出口与学习进度推进）。**设计见 `docs/superpowers/specs/2026-09-19-analytics-instrumentation-design.md` §4.4 / §4.7 / §4.8 / §8.2 / §10。**

```text
判题出口（四个专项写入点 + 一个掌握度回写）
  · training.service.judgeDictation      ┐
  · training.service.judgeInterpretation ├─► special_practice_logs（一行 = 一个作答单位）
  · meaning.service.judgeMeaning         │     · 语文：句级 verdict 由 collapseUnitVerdict 塌缩
  · vocabulary.service.judge             ┘     · 英语：wrong→incorrect，error_counted 取 progressDelta
  · JudgeCoreService.finishJudge（出口收尾）─► student_knowledge_mastery
                                                （UPSERT 累加计数 + 用累计值现算 score/level）
  · ProgressService.updateProgress（学完一课）─► lesson_completions（INSERT IGNORE，一课一次）
  · PATCH /api/study-sessions/:uid/heartbeat  ─► study_sessions.subject_id
                                                （COALESCE 只补不覆盖：会话开头没带学科时补上）

读侧（家长端，全部只读实时聚合）
  GET /api/parent/students/:id/specials        ─► aggregateByModule / countByDayByModule / countDistinctCorrectWords
  GET /api/parent/students/:id/mastery         ─► listWeakest + countQuestionCoverage
  GET /api/parent/students/:id/goals/attainment─► goals（无则懒初始化）→ 按学科分派的五路达成值
  PUT /api/parent/students/:id/goals/:metric   ─► upsertTarget(学科, 指标) → 回该行最新达成
```

**四条口径（会被反复问，记死）**

1. **一行 = 一个作答单位**：默写一篇、解释/含义一句、背单词一题。故 `units = COUNT(*)`，四个模块的 `units` 相加没有业务含义。
2. **`answered = SUM(is_correct IS NOT NULL)`**：排除 `unanswered` / `undetermined`（「没有明确对错」）的行；`rate` 一律用 `rate.util.ts` 的 `toRate(answered, correct)`（**唯一实现**），分母为 0 → `null` 而不是 0。
3. **掌握度与 `weakPoints` 并存不替换**：前者读 `student_knowledge_mastery`（真掌握度，判题时回写），后者是错题数代理（§6.8）。报告页两张卡、两个标题，不得合并；`/mastery` 必须回覆盖率三项（题库仅约 38% 的题绑了知识点）。
4. **埋点写入永不阻断主链路**：四个专项写入点、掌握度回写、**完课事件**都在 `try/catch` 里，**失败只 warn**；掌握度回写走 `void`（不 `await`）——判题/推进是主链路，派生数据不该拖长学生等待。
5. **目标 = `(学科, 指标)`二元组（P6.5，2026-09-20）**：不存在全局目标。同一個 metric 会在多个学科各有一行，所以「metric」不再是唯一键、前端渲染 key 必须用 `subjectId:metric`。在学学科 = `progress` 行的学科 ∪ 兜底 {语文,英语} ∩ MVP 白名单；没有在学学科就**不建默认目标**。
6. **`weekly_lessons` 的数据源是 `lesson_completions`，且历史补不回来**：`progress` 表只有游标（覆盖式更新、无历史），回答不了「本周完成了几课」；本表从 2026-09-20 起记。同理 `study_sessions.subject_id` **心跳补写**只对之后的会话生效，旧会话（NULL）不追溯。

**两条容易踩的实现坑（2026-09-22 实测）**

- **`ON DUPLICATE KEY UPDATE` 的 SET 从左到右求值，后面的表达式读到的是前面刚写入的值**（不是本行旧值）。`student_knowledge_mastery` 的 `mastery_score` 因此必须写成「计数列先更新、score/level 只引用更新后的列」；若在 score 里再写一次 `+ new.correct_count`，本次增量会被算两遍（1 对 1 错实测 `0.333`，应为 `0.500`），而掌握度是长期累计列，**错了不会自愈**。
- **仓储的占位符顺序必须与列清单逐位对应**：`goals` 的列是 `(student_id, subject_id, metric, title, period, target_value, …)`，参数按语义直觉排成 `[studentId, metric, period, title, target]` 会让 `title` 与 `period` 对调落库。**只断言「自己传了什么 payload」的单测拦不住这类错**——要么按列名配对断言，要么用真库（事务 + ROLLBACK）跑一次。
- **`goals` 的唯一键靠 VIRTUAL 生成列，不能改 STORED（2026-09-20 实测）**：MySQL 的唯一索引把 NULL 视为互不相等，所以 `(student_id, subject_id, metric)` 在 `subject_id IS NULL` 时**允许重复行**、`ON DUPLICATE KEY` 静默失效。修法是生成列 `scope_subject_id = IF(metric IS NULL, NULL, COALESCE(subject_id, 0))`（VIRTUAL）＋唯一键 `(student_id, scope_subject_id, metric)`。**必须是 VIRTUAL**：STORED 要重建整表，而 `goals` 上有两个外键 → `ERROR 1215 Cannot add foreign key constraint`。⚠️ **别用临时表验证这类事**——临时表没有外键，STORED 在临时表上能建成功（本项目真踩过）。

---

## 7. API 与前端页面对照表

| 前端页面 | 路由 | 主要调用 API |
|---|---|---|
| P1.1 统一登录 | `/login` | `POST /api/auth/login`, `GET /api/auth/me` |
| 家长注册 | `/register` | `POST /api/auth/register` |
| P1.5 学科选择 | `/student/subjects` | `GET /api/content/subjects` |
| P2.1 星图导航 | `/student/star-map` | `GET /api/progress/students/{id}/star-map?subjectId=`（星图主数据）；`GET /api/progress/.../overview`（跨学科总览，可选） |
| P2.2 课程详情 | `/student/course-detail` | `GET /api/content/lessons/{lessonId}/cards`（卡片列表）；`GET /api/practice/uncleared-errors?subjectId=&lessonId=`（错题清零门禁，只看当前课之前的未清题；本课刚产生的错题不触发）；`POST /api/practice/bump-error-levels`（清零后仍错递增 level）；`POST /api/progress/update`（翻页上报进度）；卡片级讨论抽屉调 `POST /api/practice/discuss-card`；practice 卡「让 AI 讲一讲」抽屉调 `POST /api/practice/discuss` |
| P2.3 AI 讨论 | 已合并为抽屉 | 题目级讨论在 AnswerModal 内（`POST /api/practice/discuss`）；卡片级讨论在 CourseDetailPage 内（`POST /api/practice/discuss-card`）。均走 `POST /api/ai/tutor/stream` 流式。 |
| P2.4 课后作业 | `/student/homework` | `GET /api/assessment/homework/{id}`, `POST .../answers`, `POST .../hint` |
| P2.5 作业解析 | `/student/homework-result` | `GET /api/assessment/submissions/{id}/results` |
| P2.6 单元检测 | `/student/unit-test` | `GET /api/assessment/exams/{id}`, `POST .../submissions`, `POST .../save/submit` |
| P2.7 期中期末 | `/student/exam` | 同单元检测，scope 不同 |
| P2.8 成绩报告 | `/student/scores` | `GET /api/assessment/submissions/{id}/results`, `GET /api/knowledge-graph/.../weak-points` |
| P2.9 闯关奖励 | `/student/reward-unlock` | `GET /api/rewards/.../available`, `POST /api/rewards/.../claim/{id}` |
| P3.1 辅线首页 | `/student/auxiliary` | `GET /api/conversations?track=aux` |
| P3.2 知识点选择 | `/student/auxiliary/selector` | `GET /api/content/knowledge-points` |
| P3.3 拍照/输入答疑 | `/student/auxiliary/ask` | `POST /api/files/upload`, `POST /api/refinery/extract` |
| P3.4 辅线对话 | `/student/auxiliary/chat` | `POST /api/ai/tutor` (mode=auxiliary), WS `/ws/ai/{id}` |
| P4.1 错题本 | `/student/error-book` | `GET /api/error-book/.../main` |
| P4.2 错题重做 | `/student/error-book/redo` | `POST /api/error-book/items/{id}/redo` |
| P4.3 解析与变式 | `/student/error-book/variant` | `GET /api/error-book/items/{id}/variations`, `POST .../variations/{vid}/submit` |
| P5.1 个人中心 | `/student/profile` | `GET /api/points/me`、`GET /api/points/me/ledger` |
| P5.2 奖励册 | `/student/rewards` | `GET /api/points/me/rewards` |
| ~~P5.3 设置~~ | ~~`/student/settings`~~ | **已废止（2026-09-18 用户裁决）**：学生端不设独立设置页；手动护眼切换在学习沉浸页内，字号由学段（家长配的年级）决定 |
| P6.1 家长仪表盘 | `/parent/dashboard` | `GET /api/parent/dashboard`, `GET /api/parent/alerts`, WS `/ws/notifications/{id}` |
| P6.2 学情报告 | `/parent/report` | `GET /api/parent/students/{studentId}/reports` |
| P6.3 错题查看 | `/parent/errors` | `GET /api/parent/students/{studentId}/errors` |
| P6.4 AI 对话回放 | `/parent/chat-logs` | `GET /api/parent/students/{studentId}/chat-logs` |
| P6.5 目标设定 | `/parent/goals` | `GET /api/parent/students/{studentId}/goals/attainment` + `PUT .../goals/{metric}`（§4.24）。~~旧 `GET/POST/PATCH/DELETE .../goals`~~ **已废弃（2026-09-22 用户裁决）**：那四条**从未实现**且无 `metric` 维度 |
| P6.6 行为管控 | `/parent/controls` | `GET/PUT /api/parent/students/{studentId}/controls` |
| P6.7 奖励管理 | `/parent/rewards` | `GET /api/parent/students/{studentId}/points`, `GET/PUT .../points/rules`, `GET .../points/ledger`, `GET/PUT .../reward-catalog`, `POST .../points/redeem`, `GET .../redemptions`, `PATCH /api/parent/redemptions/{id}`, `GET/PUT .../points/settings`, `GET /api/points/levels`（`...` = `/api/parent/students/{studentId}`；见 §4.21 / §4.22） |
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
- 错题本（主线错题本，全系统唯一）：自动录入、重做、清零、级别提升
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
| v4.5 | 2026-09-20 | **管理员手动清理 30 天前的预警 + `safety_alerts` 补两个索引**（同属 `feat/parent-controls-and-alerts` 分支，不改判题/预警判定口径）。契约变更：§4.17 Admin 分组新增两条**同资源**端点——`GET /api/admin/alerts/expired`（预览：`{retentionDays: 30, cutoff, total, unread}`，只读不删）与 `DELETE /api/admin/alerts/expired`（清理：`{retentionDays: 30, cutoff, deleted}`，物理删除 `created_at < cutoff` 的行，**含未读**）。`openapi.yaml` 同步（1 路径 / 2 operation / 2 schema，都记 `'200'`）。**阈值固定 30 天、接口不带参数**（杜绝「填 0 就删库」）、**用 `DELETE` 而非 `POST`**（`@Post` 默认 201，对「清理」语义不对）。数据面：`safety_alerts` 补 `idx_sa_parent_created (parent_id, created_at)`（家长端列表 + 顶栏 Banner 免 filesort）与 `idx_sa_created_at (created_at)`（保留期清理由全表扫变区间扫描），迁移 `2026-09-20_safety_alerts_retention_indexes.sql`（`information_schema.STATISTICS` 幂等守卫，条件 `> 0`——多列索引在 STATISTICS 里有多行）。**明确不做**：不加自动保留期、不引 `@nestjs/schedule`、不做清理前导出/审计日志/按类型筛选/数量上限保护。spec §9 补记「预警无自动保留期」。 | 
| v4.4 | 2026-09-20 | **P6.5 目标设定补齐：按学科 + 每周完课 + 采集修正**。契约变更：`GET /goals/attainment` 的 `items[]` 新增 **`subjectId` / `subjectName`**（目标改为 `(学科, 指标)` 二元组，同 metric 不再全局唯一，排序固定为「学科 sort_order → 指标模板顺序」）；`PUT /goals/:metric` 的 body 由 `{target}` 改为 **`{target, subjectId}`**（`subjectId` 必填，校验链路 6 步，新增「指标×学科匹配」与「在学学科」两道）。`metric` 枚举新增 **`weekly_lessons`**（每周完课）。数据面：新建 `lesson_completions`（每课完成事件；**历史完课补不回来**，从 2026-09-20 起算），`goals` 唯一键改为 `(student_id, scope_subject_id, metric)`（生成列 `scope_subject_id`，**必须 VIRTUAL**——STORED 会被外键挡住）。采集修正：会话心跳可带 `subjectId` 并**只补不覆盖**地写回 `study_sessions.subject_id`（此前该列近乎全 NULL，按学科的学习时长恒为 0；旧会话不追溯）。口径裁决（2026-09-20 用户确认）：**提醒本期不做**（PRD/UX 已加批注，`reminder_enabled` 恒 0；短信单独立项）、每周完课用新建事件表而非积分账本代理、按学科学习时长靠心跳补写。默认目标：数学 3 + 语文 4 + 英语 4 = 11 行（30 分钟/学科·天、2 课/周、5 道/周、8 篇/周、20 词/天）。**没有在学学科时不建默认目标**。 |
| v4.3 | 2026-09-22 | **埋点 Phase 1B：专项学情 / 真掌握度 / 目标达成**。契约变更：新增 `GET /api/parent/students/{studentId}/specials`、`/mastery`、`/goals/attainment` 与 `PUT /api/parent/students/{studentId}/goals/{metric}`（§4.13 四行 + §4.24 总览，`openapi.yaml` 同步）；旧 `goals` CRUD 四条**从未实现**（文档先于代码写下、无 handler）且无 `metric` 维度，**标废弃**（§4.13 删除线 + §7 P6.5）。数据面：`special_practice_logs` 新表（DB 设计文档 §3.17）、`goals` 加 `metric` 列与唯一键 `(student_id, metric)`（迁移 `2026-09-22_special_practice_logs_and_goals.sql`）。两条口径裁决（2026-09-22 用户确认）：① `weekly_passages` 的达成值 = 三个语文专项**去重篇目数**（不能用行数——解释/含义一句一行，会把「8 句」当「8 篇」）；② 默认目标 60 分钟 / 20 词 / 8 篇 / 10 道。四处新增口径：`units` 一行 = 一个作答单位、`rate` 分母为 0 恒 `null`、掌握度**与 `weakPoints` 并存不替换**、埋点写入**永不阻断判题**（§6.27）。顺带修 spec §4.8 的 UPSERT 算式 bug：`ON DUPLICATE KEY UPDATE` 的 SET 从左到右读到的已是更新后的列，原式把本次增量算了两遍（1 对 1 错实测 0.333，应为 0.500） | 
| v4.2 | 2026-09-19 | **家长端 AI 对话回放补齐孩子的图片**。契约变更：`GET /api/parent/students/:id/chat-logs/{dialogueId}` 的消息对象新增 **`images: string[]`**（`openapi.yaml` 的 `ChatLogMessage` 同步）。服务端从 `ai_messages.attachments` 的 JSON 串解析、**只留 `type == 'image'`**（`file` 类型本期下发），无附件时是**空数组而非 null**；不回传原始 `attachments` 串（家长端不该自己 parse JSON）。动机：数据在库里、学生端能看（`useAuxChat` 解析 → `AuxChatPanel` 渲染 `<img>`），而家长端原先的字段白名单漏了它 → PRD §7.7「全透明回放」缺一块。顺带把学生端的图片大图预览抽成共享 `components/base/ImageLightbox`（原先私有在 `AuxChatPanel` 里），两端共用一份（避免 Esc 监听与 `body.overflow` 复位抄漏）。 | 
| v4.1 | 2026-09-19 | **家长端错题轨道改 主线/训练 + 两页富文本渲染修正**。契约变更：`GET /api/parent/students/:id/errors` 的 `track` 由 `main\|aux` 改为 `main\|training`（§4.13 与 `openapi.yaml` 的路径参数、`ParentErrorItem.track` 已同步）。分档表 = `parent-insights.repo.ts` 的 `TRACK_SOURCES`（唯一真源）：`main` = `practice\|discuss\|exam`；`training` = `targeted\|error_practice\|auxiliary`——孩子**在辅线答疑里问过**的题（`auxiliary`）进训练轨「错题练习」池、可被做对清零，故归训练、不再单列「辅线」档；筛选由反向排除改为 `source IN (...)` 白名单（未登记 source 不入任何档，由分区测试兜底：新增来源不入册即红）。`ParentErrorItem.wrongAnswerText` 补注：字段名历史误导，它装的是「题库未命中时保存的题面原文」而**非**学生作答（`questionId` 非空时恒为 null），家长端页面据此不再渲染「学生作答」行。前端两处富文本改走共享渲染配置（AI 对话回放的 AI 回复与思路、错题页题面）。**未涉及**：`/error-book/students/{studentId}/main` 的旧 `ErrorItem` schema 仍写 `track: [main, aux]`（遗留端点，属存量偏差，另行处理）。 | 
| v4.0 | 2026-09-18 | **家长端「看得见」批**（四页 + 5 个只读端点 + 新模块 `apps/server/src/modules/parent-insights/`，与既有 `ParentController` 同前缀 `api/parent`）。契约变更：① `GET /api/parent/dashboard` 返回形状重写——孩子层级 `lastActiveAt`（多表时间并集 MAX，不限窗口）/ `activeDays7`（近 7 天）/ `unreadAlerts`（本期恒 0），并扩出 `subjects[]`（进度 / 正确率累计 / 自评 / 错题待清零 / 考试数）；去掉 `todayStudyMinutes` / `pendingAlerts` 旧占位。② `GET .../reports` 语义改为**实时聚合学情报告（不落 `learning_reports`、不调 LLM）**、加 `?period=weekly\|monthly`，响应改为 `stats`/`trend`/`subjects`/`weakPoints`/`weakPointsUncoveredCount`/`exams`；**删除 `GET .../reports/{reportId}`**（不再是落库报告 ID）、连同原 AI 文本形状 `ReportContent` 不再被本组引用（`POST /ai/report` 本期未实现，留后续迭代）。③ `GET .../errors` 加 `subject`/`source`/`track`/`cleared`/`from`/`to`/`page`，响应改分页壳（`pageSize` 服务端固定 20）；`source` enum 按实际值补 `exam`/`targeted`/`error_practice`、去掉无写入点的 `homework`/`unit_test`/`midterm`/`final`。④ `GET .../chat-logs` 加 `track`/`scene`/`from`/`to`/`q`/`page` + 分页壳；`chat-logs/{dialogueId}` 改返回 `ChatLogDetail`（逐句含 `reasoning` 与 `safetyFlag`，不回传 `token_*`/`response_time_ms`）。错误码口径见 §2.4 新增实现注（1002 不存在 / 1005 别的家长的孩子）。§6.8 数据流整节重写。openapi.yaml 同步（**26 路径**中本组 5 路径重写 / 1 路径删除、新增 20 schema）。 |
| v3.9 | 2026-09-18 | 补记 §4.22 `GET /api/points/levels`（`@Roles('student','parent')`，静态 9 档、不查库不校验归属；openapi `/points/levels` 已同步）+ 家长端「积分与奖励」页（UX P6.7）接线完成：§7「页面 ↔ 端点」对照表 P6.7 行原写的 `GET .../rewards` + `POST /api/rewards/{id}/redeem` **两条都不是本体系端点**（后者在 openapi 与代码里都不存在），本次更正为 §4.21 / §4.22 的 12 个真实端点。openapi.yaml 同步（顺带补齐存量偏差：`SaveRewardCatalogItem.required` 加 `description`/`minLevelCode`/`sortOrder`，与 controller Zod 必填对齐）。 |
| v3.8 | 2026-09-18 | 文档补记（**接口无变更**）：`POST /api/training/judge` 请求体补上 `sessionId?`——计划一（v3.7）已让后端接受该可选字段（仅累加 `training_sessions.judged_count` 审计留痕，不传也能判题，会话不存在/非本人/已完成静默跳过），但两份文档一直漏记；学生端会话页（数学专项 / 背单词）本次开始实际携带它，故补齐 §4.18 与 openapi `TrainingJudgeRequest`。**背单词判题端点 `POST /api/training/vocabulary/judge` 不接受该字段**（有意不发分审计）。 | 
| v3.7 | 2026-09-17 | **闯关积分与段位体系**（平台级激励层，不影响任何门禁；PRD 新增 §7.13）。新增 Points 分组 §4.20（学生端 4 端点，只读：概览/流水/档位/奖励，`studentId` 取自 JWT 防 IDOR）+ ParentPoints 分组 §4.21（家长端 **11** 个端点：概览、`points/rules` GET+PUT、`points/ledger`、`reward-catalog` GET+PUT、`points/redeem` POST(201)、`redemptions` GET、`redemptions/{id}` PATCH、`points/settings` GET+PUT）；Training 分组 §4.18 增 `POST /api/training/sessions/:id/complete`（乙类整批发分，分值取会话档位、不取前端入参，幂等回 `already_completed`）。新增 §6.24 数据流。错误码 `3001` 余额不足 / `3002` 未达段位 / `3003` 奖励已下架 / `3004` 兑换已关闭 / **`3005` 档位不存在**。甲类埋点（语文三专项 + `error_fix`）在既有判题响应内联 `pointsAwarded` / `awardReason`（枚举 `daily_limit\|no_rule\|tier_inactive\|genre_unset\|not_cleared`，`duplicate` 刻意不在枚举内：幂等命中本次未入账，报出去会弹假 `+N 分`）；丙类（`mainline_lesson` / `math_paper`）在既有响应加 `points`。DB 迁移 `2026-09-17_gamification_points.sql`（6 张表 `point_rules`/`point_ledger`/`student_points`/`reward_catalog`/`point_redemptions`/`training_sessions` + `controls.points_per_yuan` + `chinese_passages.genre`）。快照重建脚本 `rebuild-student-points.ts`（只读流水重算，快照与流水不一致时手工修复）；体裁标定工具 `dictation_cli.py --export-genre / --set-genre`（**不用 LLM 猜体裁**，人工标定）。openapi.yaml 同步（**13 路径 + 25 schema** + 各判题响应补两字段）。 |
| v3.6 | 2026-09-17 | 语文古诗文**含义专项**（Training 分组 §4.18 增 3 端点，均为 student JWT、POST 按 Nest 默认返回 **201**）：`GET /api/training/meaning/passages`（抽题池 = `verified=1 AND is_active=1 AND JSON_LENGTH(sentences) > 0 AND sentence_meanings IS NOT NULL`——比解释专项多「有含义数据」，只出篇名 + 册次）、`POST /api/training/meaning/start`（`count` **1-3**；一次下发整篇所有句子，含 `index`/`text`/`terms[{term,plain}]`/`answerable`，剥离 `meaning`/`emotion`/`translation`/`full_translation`；**`answerable:false` = 无标准含义，只显示在顶部原文条、不出题**）、`POST /api/training/meaning/judge`（**逐句**判该句字词 + 深层含义 + 作者情感，**纯 LLM、无归一化短路**，故 `method` 只有 `ai\|unanswered\|undetermined` 三值、**刻意没有 `exact`**，有用例钉住；漏项/失败逐项 `undetermined`；该句无标准含义 400）。新增 §6.23 数据流。DB 迁移 `2026-09-17_chinese_sentence_meanings.sql`（`chinese_passages` 加 `sentence_meanings` 列）。ai-core 新增 `chinese_meaning_judge` 场景（primary=`local`、fallback=`deepseek-flash`）。内容管线 `meaning_cli.py` **已实现**（15 用例）：`--export` 出带原文的模板并**回填库中已填的含义**（修订路径不会抹掉该篇其余句子），`--apply` 按原文定位下标幂等写回、**整篇全空时拒绝写库**。openapi.yaml 同步（3 端点 + 12 schema）。 |
| v3.5 | 2026-09-16 | 英语**背单词**子系统（Training 分组 §4.18 增 5 端点，**独立子系统**：不挂 `questions`、不进错题本、不参与主线清零门禁，同语文古诗文专项的独立化论证——作答单位是「词 / 义项」、标准答案是词条自带属性、不接主线无「重做—清零」对象）。① `GET /api/training/vocabulary/options`（三档词库范围 + 今日已背 + 四个筛选的池子大小）；② `POST /api/training/vocabulary/start`（`count` 10-20；`order` 随机/字母序/倒序/指定字母开头；`direction` 英→中/中→英/随机；四个筛选；**`promptKind=cn2en` 的题不下发 `word`/`phonetic`/`context`/`hasFamily`**）；③ `POST /api/training/vocabulary/judge`（**三条路由**：中→英纯程序比对不调 LLM；英→中常见义程序短路 + LLM 二档；英→中熟词僻义程序短路 + LLM **三档**含 `off_target`；`off_target`/`unanswered`/`undetermined` **都不计错**）；④ `POST /api/training/vocabulary/progress/clear`（只清学生自己的 `wrong_count`，不动 `learned`、不动全局 `error_count`）；⑤ `GET /api/training/vocabulary/words/{wordId}/family`（词根族，`root_key` 自关联、**不建新表**）。新增 §6.22 数据流。DB 新增 `english_words`（**无外键**，表即完整边界；`meanings` JSON 承载义项与熟词僻义 `extended`+`context`；`root_key` 自关联表达词根族；`error_count` 为全平台累计错次**只增**）与 `student_word_progress`（本子系统唯一外键 `student_id→students(id)`，`word_id` 故意不设外键以免内容表重灌被入向外键卡死），迁移 `2026-09-16_english_vocabulary.sql`（纯 CREATE TABLE，重跑天然幂等；`schema.sql` 同步收录、两处 DDL 逐字节一致）。ai-core 新增 `english_word_judge` 场景（primary=`local`、fallback=`deepseek-flash`；本地端点靠 `chat_template_kwargs` 关 thinking）；顺带修正管理员 `SCENES` 白名单漂移（漏 `interpretation_judge`/`analysis`/`safety`，并加漂移守卫用例）。前端新增 `VocabularyConfigPage`/`VocabularyRunPage` 与 `WordPromptCard`/`WordFamilyTree`/`AnswerFeedList`/`SpellingDiffView` 组件，训练入口英语由「敬请期待」改为可点。**词库内容（课标官方 PDF：义务教育 2022 版 1600 词 + 高中 2017 版 2020 修订 3000 词）与熟词僻义、词根族数据由后续内容管线导入，本期以 DEV-FIXTURE 假数据打通链路**。openapi.yaml 同步（5 端点 + 12 schema）。 |
| v3.4 | 2026-09-16 | 语文古诗文**解释（翻译）专项**（Training 分组 §4.18 增 3 端点）：`GET /api/training/interpretation/passages`（抽题池 = `verified=1 AND is_active=1 AND JSON_LENGTH(sentences) > 0`，只出篇名 + 册次）、`POST /api/training/interpretation/start`（`count` **1-3**；一次下发整篇所有句子，含 `index`/`text`/`terms` 词名，剥离 `gloss`/`translation`/`full_translation`）、`POST /api/training/interpretation/judge`（**逐句**判：程序短路 → 剩余项一次 LLM 调用 → 漏项/失败逐项 `undetermined`；`method` 四值 `exact\|ai\|unanswered\|undetermined`；`fullTranslation` 仅最后一句下发）。新增 §6.21 数据流。**判题粒度经用户 2026-09-16 裁决由「整篇一次批量」改为「逐句」**（学生答完一句立即知道对错）；**答题形态定为「三行对译」**（原文 → 该句关键字词 → 整句翻译），故 `chinese_passages.key_terms` 每项新增 `sentenceIndex` 指向 `sentences` 下标。解释抽题池与默写**口径有意不同**（不设 `memorize_required`、加「内容就绪」）。DB 迁移 `2026-09-16_chinese_interpretation_columns.sql`（纯 ADD COLUMN）。ai-core 新增 `interpretation_judge` 场景（primary=local、fallback=deepseek-flash，实测整个判题 ~1.3s）。前端新增 `InterpretationConfigPage` / `InterpretationRunPage` 与 `SentenceBlock` / `ItemResultLine` 组件，语文专项页第二张卡由「敬请期待」改为可点。openapi.yaml 同步。 |
| v3.3 | 2026-09-15 | 古诗文专项**独立子系统**改造（`questions` 体系摘除）：① 四个 `/training/dictation/*` 端点字段 `questionId`→`passageId`（`questionIds`→`passageIds`）、`judge`/`start` 不再需要 JWT `studentId` 参与抽题；② **判题不写任何学生状态**——`judge` 响应删 `errorBookId`，不再 find-or-create 写 `main_error_books`（`source='dictation'`）、答对不再清零（PRD §6.3 / §7.4 例外）；③ 篇目清单/抽题改查 `chinese_passages`（三道闸门 `verified=1 AND memorize_required=1 AND is_active=1`），题面由篇名服务端生成（`请默写《X》`，不落库）；④「不再展示」排除（`LEFT JOIN student_hidden_questions`）随独立化移除，「全部册次」随机抽按篇名去重（跨册 `MIN(id)`）；⑤ DB：`dictation_passages` 改名 `chinese_passages`、摘 `question_id` 列及其 FK/唯一键、新增 `is_active`，删 `questions` 的 50 行 `poem_dictation` 与 7 行 `main_error_books(source='dictation')`（迁移 `2026-09-15_chinese_passages.sql`；**迁移首跑因 CASCADE 外键静默清空篇目、已从备份恢复**，脚本补步骤 1.5 先摘外键再删题，事故记录见计划文档 Task 9）。前端 `api.ts`/`DictationConfigPage`/`DictationRunPage` 字段同步。openapi.yaml 同步。 |
| v3.2 | 2026-09-14 | 默写判题与错因解耦 + 差异视图回投标点：① 新增 `POST /api/training/dictation/feedback`（错因文案单独取，服务端纯函数重算差异——**不写错题本、不重复判题**；模型失败 HTTP 200 + `feedback=null`）；② `POST /api/training/dictation/judge` 不再等 LLM（实测 12.6s → 25ms），响应新增 `feedbackPending`，`feedback` 恒 null；③ 正文差异由 `diffChinese` 换 `diffChineseInOriginalText`——判对错口径仍忽略标点，但 `bodyDiff` 各段文本**回投原文标点**（标点归其后那个字、串尾标点归末字；equal 段带前后标点、wrong 段保持单字、整段漏写保留段内段尾标点），学生能看到带标点的整句；④ 错因调用对本地 llama.cpp 下发 `chat_template_kwargs:{enable_thinking:false}` 关 thinking（`thinking:false` 对本地端点无效），错因耗时 13–16s → 2s 量级。前端 `DictationRunPage` 提交后立即出对错，错因区转圈 +「AI 正在生成错因提醒…」等待文案。新增 `ChatRequest.extraBody`（provider 专有参数逃生舱）。openapi.yaml 同步（新增 1 端点、DictationJudgeResult 加 `feedbackPending`、新增 DictationFeedbackResult schema）。 |
| v3.1 | 2026-09-13 | 新增语文古诗文默写专项（Training 分组 §4.18 增 3 端点）：`GET /api/training/dictation/passages`（已校验篇目清单，只出篇名 + 册次——作者/朝代/正文为判题字段不下发）、`POST /api/training/dictation/start`（`semester` 上册/下册/null + `questionIds` + `count` 1-20，题项白名单剥离作者/朝代/正文）、`POST /api/training/dictation/judge`（三字段作答，`JudgeCoreService.judgeDictation` **纯程序化**判对错 + `diffChinese` LCS 差异定位，答错写 `main_error_books.source='dictation'`、答对清零；错因文案 `dictation_feedback` 场景 local 优先/deepseek 兜底，失败降级 `feedback=null` 不阻断）。新增 §6.20 数据流。DB 新增 `poem_dictation` 题型与 `dictation_passages` 表（业务键 `uniq_dp_work (work_title, semester)`），迁移 `2026-09-13_ensure_uniq_q_content_hash.sql` 修 `questions.content_hash` 唯一索引漂移。openapi.yaml 同步收录 3 端点。 |
| v3.0 | 2026-09-10 | 判题体系重构（文档同步批）：① 新增 `POST /api/practice/self-assess` 课堂练习主观题自评端点（卡中心变体：补写 `practice_results` method='self_assess' + 留痕 + 错题本写入/清零，`questionId` 可 null 走 card+题面匹配）；② `GET /api/exams/sessions/{id}/results` 响应新字段——items 加 `answer`（参考答案）/`needsSelfAssessment`/`selfAssessment`、`isCorrect` 增 null（主观题待自评），summary 加 `subjectiveCount`（主观题不计对错，`correctCount`/`accuracy` 只算客观题；跨模式口径按 `is_correct NULL` 推断，遗留 ai 模式已判主观行计为客观错题）；③ 新增 §6.19 主观题自评数据流（judge 返回 needsSelfAssessment+参考答案 → 前端展开自评 → self-assess 端点落库 → 考试成绩只算客观题）；④ 训练 self-assess 响应契约修正——`correct` 时省略 `errorBookId` 键（缺键按 null 理解）。openapi.yaml 同步（`/practice/self-assess` 端点、ExamResultItem/ExamSummary schema、training self-assess 响应去 required）。 |
| v2.9 | 2026-09-10 | 判题体系重构（5/14）：新增 `POST /api/training/self-assess` 主观题学生自评端点（`assessment` 枚举 correct/incorrect，`source` 枚举 targeted/error_practice/exam，考试来源带 `sourceRefId=sessionId`）；自评 incorrect 入错题本/留痕并触发解析缓存兜底生成，correct 清零该题未清错题。DB `practice_results.method` 与 `exam_answers.method` 由 `VARCHAR(10)` 加宽至 `VARCHAR(20)`（容纳 `self_assess` 11 字符），迁移文件 `migrations/2026-09-09_widen_method_columns.sql`。openapi.yaml 同步（新增 `/training/self-assess` 端点与 `TrainingSelfAssessRequest` schema）。 |
| v2.8 | 2026-09-08 | 判题解析缓存化：(1) 判题响应去 `analysis`——`POST /api/practice/judge` 与 `POST /api/training/judge` 只判对错（主观题 AI 判定 prompt 简化为 isCorrect/errorType）；判错后台异步生成解析入 `questions.explanation`（`answer>=100` 字符直写，否则 explanation 场景强模型生成，一次入库复用）；(2) 新增 `GET /api/training/questions/explanations`（批量拉解析，等 in-flight 60s）与 `GET /api/training/questions/{questionId}/explanation-wait`（单题刷新等待 120s，失败写 admin_notifications）；(3) 前端结果页（专项/错题/考试/错题巩固）末题后批量拉解析，「生成中」可刷新倒计时。openapi.yaml 同步（JudgeResult schema 去 analysis、新增 2 端点）。 |
| v2.7 | 2026-09-08 | Admin 通知中心：新增 `GET /api/admin/notifications`（系统通知列表——判题解析缓存失败等异步告警，`admin_notifications` 表，含 `isRead`，按时间倒序最多 200 条）、`GET /api/admin/notifications/unread-count`（未读数）、`POST /api/admin/notifications/{id}/read`（标记已读，不存在 `1002`）。openapi.yaml 同步收录 3 端点（/admin/notifications*，admin JWT）。 |
| v2.6 | 2026-09-07 | 会话场景分型 + 训练「讲一讲」重构：`ai_dialogues` 新增 `scene`（aux_qna/aux_training/mainline_question/mainline_card）与 `question_id` 列（迁移 `2026-09-07_add_ai_dialogues_scene.sql`，含存量回填）；`POST /api/conversations` 支持 `scene/questionId/questionText`，`scene=aux_training` 时按题 find-or-create 续接、仅新建时把题面写成一条 assistant 题面锚消息；`GET /api/conversations` 支持 `scene` 过滤——辅线答疑列表只显示 `aux_qna`，训练讲一讲不再混入辅线历史；训练讲一讲学生消息不再前缀题面（气泡只显示原话）。`startDiscuss`/`startCardDiscuss` 分别标记 `mainline_question`/`mainline_card`。新增 §6.18 数据流。openapi.yaml 同步（Conversation/CreateConversationRequest/list query）。 |
| v2.5 | 2026-09-04 | 联调修正（§4.19 三处，openapi.yaml 同步）：① `POST /api/exams/sessions` 命中的续考会话已超时 -> 先自动收卷再返回 `status='submitted'`（不新建，前端直接踢结果页）；② `POST /api/exams/sessions/{id}/answers` 改为**先落在途行再判题**（判题在途窗口内倒计时归零自动收卷时走「在途补判」而非「未作答」）；③ 考试来源错题写入改 find-or-create（镜像 JudgeCore：该生该题已有未清错题时复用既有行，不重复建行）。 |
| v2.4 | 2026-09-03 | 新增 Exams 服务分组（§4.19，MVP，真题试卷考试）：`GET /api/exams/papers`（试卷列表，year/district/examType/gradeBand 可选叠加筛选）、`GET /api/exams/papers/{id}`（试卷详情 + 按题型估算推荐时长 durationMinutes，clamp [30,180]）、`POST /api/exams/sessions`（开考/续考——同卷 in_progress 会话直接复用、不重置时长）、`GET /api/exams/sessions/{id}`（断线恢复，超时会话自动收卷）、`POST /api/exams/sessions/{id}/answers`（单题同步判题，考试结束前响应白名单剥离 answer/explanation 与对错——防作弊）、`POST /api/exams/sessions/{id}/submit`（交卷幂等，finalize 三分支：未作答判错/在途补判/已判跳过）、`GET /api/exams/sessions/{id}/results`（结果页，逐题对错 + 解析）。判题复用 JudgeCore（`source='exam'`、`sourceRefId=sessionId`，答错写 main_error_books 与练习同语义）；新增 §6.17 真题考试数据流。openapi.yaml 同步收录 7 端点（/exams/*，student JWT）。 |
| v2.3 | 2026-09-03 | 新增 Training 服务分组（§4.18，MVP）：`GET /api/training/error-book`（错题练习筛选列表，未清零记录 + 多 KP 聚合）、`POST /api/training/judge`（训练判题，JudgeCore 题中心变体，source 枚举 targeted/error_practice）、`POST /api/training/bump-error-levels`（重做仍错 bump level，镜像 practice）、`POST /api/training/hint`（题级 question_hints 缓存）、`GET /api/training/knowledge-points`（专项练习 KP 平铺列表）、`POST /api/training/targeted/start`（专项随机抽题，白名单序列化防答案泄露）；`main_error_books.source` 枚举补 `targeted`/`error_practice` 训练来源；新增 §6.15 错题练习 / §6.16 专项练习数据流。openapi.yaml 同步收录 6 端点（/training/*，student JWT）。 |
| v2.2 | 2026-09-01 | 错题清零门禁加课时范围：`GET /api/practice/uncleared-errors` 新增可选 `lessonId` 参数——传入时只返回「当前课之前」的错题（`lesson_id < lessonId`，星图同款 id 数值序），修复「学生在本课练习中答错 → 刷新本课弹出错题清零阶段」的问题（本课刚产生的错题不触发清零，留待进入下一课时再清）；`lesson_id` null 的孤儿历史行保守保留；省略参数行为不变。前端 `getUnclearedErrors(subjectId, lessonId)`、CourseDetailPage 拉取时带当前 lessonId。 |
| v2.1 | 2026-09-01 | 家长端按学科教材配置：新增 `GET/PUT /api/parent/students/{studentId}/subject-configs(/{subjectId})`（每学科 年级/册别/版本 配置，`progress.textbook_version_id + current_semester_id` 为事实源；已开始学习且切换 → 重置该学科学习状态并返回 `reset: true`）；`GET /api/content/versions` 响应补 `edition` 字段；`GET /api/practice/uncleared-errors` 按当前教材版本过滤（家长切换教材后旧版错题不计入清零门禁）；星链图版本回退规则改为「同学段 edition 非空优先、id 降序」、册别回退按学生年级匹配 `semesters.grade`。前端新增 `/parent/students/:id/config` 配置页 + 学生卡片「学习配置」入口；StudentLayout 顶栏硬编码「三年级·数学 人教版」改为星图真实数据。 |
| v2.0 | 2026-08-18 | 管理员中枢：新增 Admin 分组（§4.17）——模型池 CRUD + 启停（`llm_models`/`llm_routes` 落库为运行时真源，`ModelConfigRegistry` 保存即 reload 生效，支持 `openai_compatible` 自定义 OpenAI 兼容模型，apiKey AES-256-GCM 加密落库 + 打码返回）；场景路由表 GET/PUT（事务替换）+ `validate-connection` 探活；家长/学生列表搜索 + 封禁/解封（`BanRegistry` 进程内即时生效，重启从 DB 重建，封家长连带封其名下学生）；站内消息中心（`parent_messages` 广播 + `message_reads` 已读，admin 发送/撤回 + 家长侧列表/未读/标已读）；管理员 AI 聊天（独立 `admin_dialogues`/`admin_messages` 表，无 K12 学习边界，SSE 流式 `POST /api/admin/chat/stream`）；总览 dashboard；管理员改自己密码。错误码实现注补 1009=连通性测试失败（§2.4）。 |
| v1.9 | 2026-08-14 | 三角色账号体系：`POST /api/auth/login` 改为三角色统一登录（admins->parents->students 顺序查询，JWT 加 `role: admin\|parent\|student`）；`POST /api/auth/register` 家长注册（注册即登录），学生自主注册下线；新增 `GET/POST /api/parent/students` + `PATCH .../reset-password` + `PATCH .../status`（家长管理学生子账号：建/列表/重置密码/停用启用，归属校验 1005）；practice/ai/conversations/progress 学生接口全部套 `RolesGuard('student')` 防越权；登录限流 10 次/分/IP（1008）；DB 新增 `admins` 表 + `parents`/`students` `is_active` 字段（v1.7）；seed 脚本 `seed-admin.ts`。 |
| v1.0 | 2026-06-26 | 初始版本，覆盖 MVP 核心接口与数据流 |
| v1.1 | 2026-08-01 | 新增 `POST /api/progress/update` 进度更新接口；更新 P2.2 课程详情左侧栏为数据驱动的 2~3 项结构（错题+学习内容+可选练习）；修复完成课程后进入下一课的 race condition，接口返回 `currentLessonId` 供前端定位下一课 |
| v1.2 | 2026-08-06 | 新增 `POST /api/practice/judge` 课堂练习判对错接口（MVP）；新增 Practice 服务分组；新增 §6.9 课堂练习判对错数据流；`main_error_books.source` 枚举补 `practice` 值 |
| v1.3 | 2026-08-09 | 新增 `POST /api/practice/hint` 课堂练习提示接口（MVP，AI 生成 + Card 级缓存）；`cards` 表新增 `hints` 字段（JSON 提示缓存，key=题目文本）；新增 §6.10 课堂练习提示数据流；ai-core 新增 `hint` 场景（HintCapability + prompts/hint/math.md，苏格拉底式提示不给答案） |
| v1.4 | 2026-08-09 | 新增 `POST /api/practice/discuss` 课堂练习「让 AI 讲一讲」接口（MVP，苏格拉底讨论）；打开讨论即记入主线错题本（`source='discuss'`，幂等 find-or-create）+ 创建带 `card_id` 的 mainline 对话；对话流复用 `POST /ai/tutor/stream`（mode=mainline）；接线 `card_id` 存储 + `loadContext` 解析 `cardContent`（修 mainline 范围 gap，auxiliary 不受影响）；新增 §6.11 数据流；前端 AnswerModal 内右侧抽屉（手动开关 + 放大缩小） |
| v1.5 | 2026-08-10 | B方案：题目级讨论历史续接——`main_error_books` 表新增 `dialogue_id`，`POST /api/practice/discuss` 复用已绑对话、失效则重建并回写；新增 `POST /api/practice/discuss-card` 卡片级「思辨答疑」接口（MVP），find-or-create 该学生在该卡片的 mainline 对话（不入错题本，锚=(student,card)），新增 §6.12 数据流；卡片级改为 CourseDetailPage 内右侧抽屉，放大封顶不盖左侧阶段栏；`/student/ai-discuss` 独立页取消，合并到课程详情/答题弹窗抽屉。 |
| v1.6 | 2026-08-10 | `main_error_books` 表新增 `lesson_id` 字段（冗余字段，用于按课快速定位未清零错题）；新增 `GET /api/practice/previous-errors?lessonId=` 查询当前课上一节课未清零错题数；新增 `LessonsRepository.findPreviousLessonId` + `PracticeService.countUnclearedErrorsFromPreviousLesson`；新增 §6.13 数据流；P2.2 课程详情页主要调用 API 补该端点；`main_error_books.source` 枚举补 `discuss`。
| v1.7 | 2026-08-11 | 新增 `practice_results` 表（课堂练习判题结果持久化，UNIQUE(student_id,card_id,question_n) 支撑单题重做 upsert）；新增 `GET/DELETE /api/practice/results`（取持久化结果 + 单卡/课程级 reset，与错题本解耦）；`JudgeRequest` 加 `questionN`；`judge` 答错改 find-or-create 错题本、答对 `clearUnclearedByStudentQuestion` 清该题未清错题（影响跨课门禁）、对/错都落 `practice_results`；新增 §6.14 数据流；§6.9 judge 流程更新。 |
| v1.8 | 2026-08-12 | 错题清零门禁重构为「进每节课前清空错题本所有 practice 未清题」。根因：原 `GET /api/practice/previous-errors`（计数读 `main_error_books`）与 `GET /api/practice/previous-error-details`（详情以 `practice_results` 驱动匹配 `main_error_books`）数据源不同，`practice_results` 缺失（历史数据/reset 清空/upsert 失败）时计数>0 但详情为空，清零界面不渲染。改为单一端点 `GET /api/practice/uncleared-errors?subjectId=`（计数与详情同源于 `main_error_books`，LEFT JOIN `questions` 补题面，不依赖 `practice_results`）；`main_error_books` 新增 `question_n` 列（迁移 + `backfill-error-question-n.ts` 按 card 元数据回填历史行）；新增 `POST /api/practice/bump-error-levels`；移除 `previous-errors`/`previous-error-details` 端点、`LessonsRepository.findPreviousLessonId` 依赖、`countUnclearedByLesson`/`findUnclearedByStudentLesson`/`findWrongByStudentLesson`；§6.13 重写、P2.2 调用更新。 |
