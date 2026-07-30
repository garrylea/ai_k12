# K12 智学系统 — 后端 Web 服务实现计划

> 版本：v0.1
> 基准文档：[K12智学系统-后端Web服务设计文档.md](./K12智学系统-后端Web服务设计文档.md)
> 总端点：89 个（14 个 tag 组），2 个 WebSocket 通道

## 1. 整体概览

### 1.1 当前状态（阶段 A）

| 模块 | 实现端点 | 状态 |
|------|----------|------|
| Common 层 | Filter, Interceptor, JWT/Roles Guard, Decorators | ✅ |
| Database 层 | 连接池 + 8 Repository | ✅ |
| AuthModule | `POST /api/auth/login`, `/register` | ✅ |
| ContentModule | `/subjects`, `/versions`, `/versions/:id/units`, `/lessons` | ✅ |
| ProgressModule | `GET /api/progress/students/:id/star-map` | ✅ |

### 1.2 待实现模块（按优先级分阶段）

```
阶段 B ████████████░░░░░░░░  学习核心流（卡片 + 对话 + AI）
阶段 C ████████████████░░░░  作业评测 + 错题本
阶段 D ████████████████████  家长端 + 奖励 + 剩余
```

## 2. 阶段 B：学习核心流（Cards + Conversations + AI）

**目标**：学生从星图点击小节 → 查看教材卡片 → 发起 AI 苏格拉底讨论 → 完成学习

**涉及前端页面**：P2.2 课程详情、P2.3 AI 讨论

### 2.1 Cards 读取（ContentModule 扩展）

需要新增的 Repository：`cards.repo.ts` 已有（`countKnowledgePointsByLessonId`），扩展按 lesson 分页查询。

| # | 端点 | 说明 | 优先级 |
|---|------|------|--------|
| B1 | `GET /api/content/versions/:vId/units/:uId/lessons/:lId/cards` | 课时卡片列表（分页） | P0 |
| B2 | `GET /api/content/cards/:cardId` | 卡片详情 | P1 |

**B1 响应**：
```json
{
  "cards": [
    { "id": 1, "sortOrder": 1, "cardType": "concept", "title": "...", "content": "...", "knowledgePointIds": ["kp_1","kp_2"] }
  ],
  "total": 5,
  "lessonTitle": "毫米、分米的认识"
}
```

### 2.2 Conversations（对话管理）

需要新建的 Repository：`ai-dialogues.repo.ts`、`ai-messages.repo.ts`

| # | 端点 | 说明 | 优先级 |
|---|------|------|--------|
| B3 | `GET /api/conversations?studentId=&track=` | 对话列表 | P1 |
| B4 | `POST /api/conversations` | 创建对话 | P0 |
| B5 | `GET /api/conversations/:dialogueId` | 对话详情 | P1 |
| B6 | `GET /api/conversations/:dialogueId/messages?beforeId=&limit=` | 消息历史（游标分页） | P0 |

**关键决策**：将现有 `ConversationService`（in-memory）替换为 MySQL 持久化版本，通过 Repository 注入。

**B4 请求**：
```json
{ "studentId": 1, "subjectId": 1, "track": "mainline", "cardId": 10, "title": "秒的认识讨论" }
```

### 2.3 AIModule（AI 能力封装）

**目标**：将 ai-core capabilities 通过 HTTP 暴露，供前端调用。

| # | 端点 | 说明 | 底层 Capability | 优先级 |
|---|------|------|-----------------|--------|
| B7 | `POST /api/ai/tutor` | 苏格拉底辅导（SSE 流式） | `TutoringCapability.tutor()` | P0 |
| B8 | `POST /api/ai/hint` | 提示生成 | `ExplanationCapability` (hint mode) | P1 |
| B9 | `POST /api/ai/explain` | 完整解析 | `ExplanationCapability.explain()` | P1 |
| B10 | `POST /api/ai/grade` | 主观题判分 | `GradingCapability.grade()` | P2 |
| B11 | `POST /api/ai/variation` | 变式题生成 | `VariationCapability.generate()` | P2 |
| B12 | `POST /api/ai/report` | 学情报告 | `AnalyticsCapability.analyze()` | P2 |
| B13 | `GET /api/ai/quota` | AI 额度查询 | （新 QuotaService） | P2 |

**B7 SSE 流式响应**：
```
data: {"type":"token","content":"同学"}
data: {"type":"token","content":"你好"}
data: {"type":"done","reasoning":"...","usage":{"input":120,"output":45}}
```

### 2.4 阶段 B 新增文件清单

```
apps/server/src/database/repositories/
  ai-dialogues.repo.ts      # 新建
  ai-messages.repo.ts       # 新建

apps/server/src/modules/conversations/
  conversations.module.ts   # 新建
  conversations.controller.ts
  conversations.service.ts

apps/server/src/modules/ai/
  ai.module.ts              # 新建
  ai.controller.ts
  ai.service.ts             # 封装 ai-core capabilities
```

### 2.5 阶段 B 验证

```bash
# 创建对话
curl -X POST http://localhost:3001/api/conversations \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"studentId":1,"subjectId":1,"track":"mainline","cardId":10}'

# 发起 AI 讨论（SSE 流）
curl -N -X POST http://localhost:3001/api/ai/tutor \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"dialogueId":"...","message":"什么是秒？"}'
```

---

## 3. 阶段 C：作业评测 + 错题本

**目标**：学生完成卡片学习后 → 做课后作业 → AI 判题 → 错题入库 → 清零解锁下一节

### 3.1 Assessment（测评考试）

需要新建的 Repository：`homeworks.repo.ts`、`homework-submissions.repo.ts`、`answers.repo.ts`

| # | 端点 | 说明 | 优先级 |
|---|------|------|--------|
| C1 | `GET /api/assessment/students/:sId/homework` | 课后作业列表 | P0 |
| C2 | `GET /api/assessment/homework/:hwId` | 作业详情（含题目） | P0 |
| C3 | `POST /api/assessment/homework/:hwId/submissions` | 开始答题 | P0 |
| C4 | `POST /api/assessment/homework/:hwId/submissions/:subId/submit` | 提交作业 | P0 |
| C5 | `POST /api/assessment/submissions/:subId/answers/:aId/hint` | 请求提示 | P1 |
| C6 | `POST /api/assessment/submissions/:subId/answers/:aId/explain` | 请求解析 | P1 |

### 3.2 ErrorBook（双错题本）

需要新建的 Repository：`main-error-books.repo.ts`、`aux-error-books.repo.ts`、`error-redo-logs.repo.ts`

| # | 端点 | 说明 | 优先级 |
|---|------|------|--------|
| C7 | `GET /api/error-book/students/:sId/main` | 主线错题列表 | P0 |
| C8 | `GET /api/error-book/students/:sId/aux` | 辅线错题列表 | P1 |
| C9 | `GET /api/error-book/items/:itemId` | 错题详情 | P1 |
| C10 | `POST /api/error-book/items/:itemId/redo` | 错题重做 | P0 |
| C11 | `POST /api/error-book/items/:itemId/clear` | 错题清零 | P0 |
| C12 | `GET /api/error-book/students/:sId/clear-status` | 清零状态（解锁判断） | P0 |

**关键业务规则**（PRD §6.1）：
- 主线错题必须全部清零才能解锁下一节/单元
- 清零 = 重做且正确（`is_cleared = 1`）
- 辅线错题不影响主线解锁

### 3.3 Progress（进度更新）

扩展 `ProgressModule`，新增进度更新能力。

| # | 端点 | 说明 | 优先级 |
|---|------|------|--------|
| C13 | `PATCH /api/progress/students/:sId/advance` | 推进进度（完成卡片/课时后调用） | P0 |

### 3.4 阶段 C 新增文件清单

```
apps/server/src/database/repositories/
  homeworks.repo.ts
  homework-submissions.repo.ts
  answers.repo.ts
  main-error-books.repo.ts
  aux-error-books.repo.ts
  error-redo-logs.repo.ts

apps/server/src/modules/assessment/
  assessment.module.ts
  assessment.controller.ts
  assessment.service.ts

apps/server/src/modules/error-book/
  error-book.module.ts
  error-book.controller.ts
  error-book.service.ts

apps/server/src/modules/progress/
  (扩展 progress.service.ts)
```

---

## 4. 阶段 D：家长端 + 奖励 + 剩余模块

### 4.1 Users（用户管理 + 家长注册）

| # | 端点 | 说明 |
|---|------|------|
| D1 | `GET /api/users/parents/me` | 家长资料 |
| D2 | `PATCH /api/users/parents/me` | 更新家长资料 |
| D3 | `GET /api/users/students` | 学生子账号列表 |
| D4 | `POST /api/users/students` | 创建学生子账号 |
| D5 | `GET /api/users/students/:id` | 学生资料 |
| D6 | `PATCH /api/users/students/:id` | 更新学生资料 |
| D7 | `GET /api/users/students/:id/settings` | UI 设置 |

### 4.2 Parent（家长端聚合）

| # | 端点 | 说明 |
|---|------|------|
| D8 | `GET /api/parent/dashboard` | 仪表盘数据 |
| D9 | `GET /api/parent/reports` | 学情报告 |
| D10 | `GET /api/parent/dialogues/:sId` | AI 对话回放 |
| D11 | `POST /api/parent/goals` | 创建目标 |
| D12 | `GET /api/parent/alerts` | 异常预警列表 |

### 4.3 Rewards（奖励）

| # | 端点 | 说明 |
|---|------|------|
| D13 | `GET /api/rewards/students/:sId` | 学生奖励记录 |
| D14 | `POST /api/rewards/claim` | 领取奖励 |
| D15 | `POST /api/rewards/redeem` | 家长兑现 |

### 4.4 剩余模块

| 模块 | 端点 | 说明 |
|------|------|------|
| KnowledgeGraph | 3 端点 | 知识点图谱 + 掌握度 |
| Refinery | 2 端点 | 题目 OCR 提取 |
| Files | 2 端点 | 文件上传 |
| Quota | 1 端点 | AI 额度 |

---

## 5. 支撑工作（全部阶段贯穿）

### 5.1 认证完善

| # | 工作 | 说明 |
|---|------|------|
| S1 | `JwtAuthGuard` 完善 | 接入 `@nestjs/passport` + `PassportStrategy`，替换当前简化版 |
| S2 | 家长登录 | 手机号 + 验证码 / 密码登录 |
| S3 | 家长注册 | 手机号 + 创建家庭账号 |
| S4 | 密码重置 | 验证码流程 |

### 5.2 测试

| # | 工作 | 说明 |
|---|------|------|
| S5 | Repository 单元测试 | mock mysql2 pool，验证 SQL 正确性 |
| S6 | Service 集成测试 | 真实 DB 查询，验证聚合逻辑 |
| S7 | Controller e2e 测试 | supertest 驱动，验证 HTTP 响应格式 |

### 5.3 运维

| # | 工作 | 说明 |
|---|------|------|
| S8 | 结构化日志 | 接入 ai-core 已有的 Logger + Metrics |
| S9 | 请求限流 | API 级别 rate limiting |
| S10 | WebSocket 通道 | `/ws/ai/{dialogueId}` + `/ws/notifications/{studentId}` |

---

## 6. 前端配套工作

| 阶段 | 前端工作 | 依赖后端 |
|------|----------|----------|
| B | 课程详情页（卡片翻页 + AI 讨论入口） | B1, B2, B4, B6 |
| B | AI 对话页面（SSE 流式渲染 + 公式显示） | B7, B8, B9 |
| C | 课后作业页（答题 + 提交 + 解析） | C1-C6 |
| C | 错题本页面（双轨列表 + 重做 + 清零） | C7-C12 |
| D | 家长仪表盘 + 学情报告 + 行为管控 | D1-D15 |

---

## 7. 里程碑与工时估算

| 里程碑 | 内容 | 端点 | 预估 |
|--------|------|------|------|
| M0 | 阶段 A（已完成） | 8 | - |
| M1 | 阶段 B — 学习核心流 | 7 新增（卡片 + 对话 + AI tutor） | 中等 |
| M2 | 阶段 C — 作业评测 + 错题 | 13 新增 | 较大 |
| M3 | 阶段 D — 家长 + 奖励 | 15 新增 | 较大 |
| M4 | 支撑工作 | 测试 + 日志 + 限流 + WS | 中等 |

**优先级最高的 M1 入口点**：卡片读取（B1）→ 对话管理（B4, B6）→ AI tutor 流式（B7），这三个端点打通了"看教材 → AI 讨论"的核心学习闭环。
