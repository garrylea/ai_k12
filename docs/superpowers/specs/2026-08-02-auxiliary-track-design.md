# K12 智学系统 — 辅助系统（辅线 / 答疑轨）详细设计文档

> 版本：v1.0
> 日期：2026-08-02
> 对应文档：
> - [K12智学系统-产品需求文档.md](../../../K12智学系统-产品需求文档.md)（PRD）§6.2、§7.1、§7.4、§7.9、§7.10、§13
> - [API接口与数据流设计文档.md](../../../API接口与数据流设计文档.md) §4.7、§4.8、§4.10、§4.11、§5、§6.2、§6.3、§7
> - [UX-UI设计文档.md](../../../UX-UI设计文档.md) §1.4-1.5、§3.3、§5.1 P1.6、§5.3 P3.1、§5.4 P4.1、§5.6、§9.3
> - [K12智学系统-架构设计文档.md](../../../K12智学系统-架构设计文档.md) §4.2.1、§4.2.3、§4.2.5、§4.2.10、§5.2
> - [K12智学系统-数据库设计文档.md](../../../K12智学系统-数据库设计文档.md) §3.6-§3.8
> - [K12智学系统-AI-Agent中枢设计文档.md](../../../K12智学系统-AI-Agent中枢设计文档.md) §3.4、§4.1、§4.3、§4.4、§5.4.2、§6.1、§6.3、§7.1
> - [K12智学系统-AI辅导流程详细设计.md](../../../K12智学系统-AI辅导流程详细设计.md) §6.2、§7

---

## 1. Context & Goals

### 1.1 产品背景

K12 智学系统采用「主线 + 辅线」双轨学习模式。主线是教材章节顺序的闯关式自主学习；**辅助系统（PRD 中称「辅线：答疑轨」）是独立的、类 ChatGPT 的自由答疑应用**，学生可针对任意 K12 学科问题发起提问，AI 进行开放式苏格拉底式引导。

两轨**物理隔离**：登录后落地「入口选择页」，学生选择进入主线或辅线；主轨空间内不出现辅轨入口，辅轨空间内不出现主轨入口；任一轨道均可「退出」返回入口选择页，再选另一轨道。

### 1.2 当前状态

- PRD、架构、API、UX-UI、DB 五份文档对辅助系统已给出完整设计。
- **MVP 阶段辅轨暂不实现**，仅 P1.6 入口选择页保留「答疑」入口占位（锁定态，点击无跳转）。
- 代码侧已具备部分基础设施：
  - `ai-core` 的 `TutoringCapability` 已支持 `mode='auxiliary'`。
  - `apps/server/src/ai-core/prompts/tutoring/math/auxiliary.md` 已存在。
  - DB schema 已包含 `aux_error_books`、`ai_dialogues.track`、`ai_messages`、`extract_tasks`、`questions.content_hash` 等。
  - 前端 `apps/web/src/routes/index.tsx` 已注册 P3.1-P3.4 路由，但均为 Placeholder。
- 缺少一份统一的、面向实现的详细设计文档。

### 1.3 设计目标

1. 将分散在上游文档中的辅助系统需求整合为可直接指导开发的 spec。
2. 明确辅助系统与主线的物理隔离边界，避免影响主线解锁进度。
3. 复用现有 `ai-core` 能力，补充缺失的 HTTP 端点、持久化、前端页面。
4. 定义实时图片/PDF 题目提取、题目结构化、入库去重的实现方案。
5. 标注 MVP/P1/P2 范围，列出关键待决策问题。

### 1.4 非目标

- 不修改主线学习流程、闯关奖励、测评考试。
- 不修改 `tools/data-refinery` 离线管线（PRD §7.10 明确要求离线管线不参与辅轨答疑）。
- 不新增订阅/支付相关设计（已在 P2 规划）。

---

## 2. Scope

### 2.1 阶段划分

| 能力 | MVP（本设计） | P1 | P2 |
|---|---|---|---|
| 辅线答疑聊天 P3.1-P3.4 | 文本 + 公式 + 图片上传 + WebSocket/SSE | 语音 ASR/TTS | 手写识别专用 API |
| 实时图片/PDF 提取 | Node.js 包装 MinerU CLI + 异步任务 + 轮询 | 第三方 OCR 回退（Mathpix / 讯飞） | 本地模型 Provider |
| 题目入库去重 | `content_hash` 精确去重 + 轻量质量门控 | 文本相似度兜底 | 人工审核队列 |
| 辅线错题本 P4.1 | 列表 / 重做 / 清零 | 错题升级 + 变式生成 | — |
| 安全与预警 | SafetyGuard + `safety_alerts` | 连续异常升级分析 | — |
| 会话持久化 | DB 化 ConversationService | `lastMessageId` 跨节点续接 | 长期归档 |
| WebSocket | `/ws/ai/{dialogueId}` | SSE/polling 降级加固 | — |

### 2.2 纳入范围

- 后端 NestJS 模块：`ConversationsModule`、`AIModule` 辅线路径、`RefineryModule`、`ErrorBookModule` 辅线路径、`FilesModule`。
- 仓库层：`ai_dialogues`、`ai_messages`、`aux_error_books`、`extract_tasks`、`safety_alerts`、`uploaded_files`、`questions` 的 Repository。
- `ConversationService` 持久化改造。
- 新增 `QuestionStructuringCapability`（轻量 ai-core capability）。
- Node.js `MinerUService` 实时图片/PDF 提取包装。
- 前端页面 P3.1-P3.4 与双错题本 P4.1 的辅线 Tab。
- 与 `openapi.yaml` 已定义端点保持一致。

### 2.3 排除范围

- 离线数据管线 `tools/data-refinery` 的任何改动。
- 主线课程、作业、考试、奖励、家长订阅/支付。
- 新的大模型或模型路由表改动。

---

## 3. Architecture & Component Boundaries

### 3.1 高层组件图

```text
┌─────────────────────────────────────────────────────────────────┐
│                         apps/web                                │
│  P3.1 AuxiliaryHome ── P3.2 Selector ── P3.3 PhotoAsk ── P3.4 Chat │
│  chatStore / auxiliaryStore / themeStore                         │
└──────────────────────────┬──────────────────────────────────────┘
                           │ REST / WebSocket
┌──────────────────────────▼──────────────────────────────────────┐
│                      apps/server (NestJS)                        │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌─────────┐ │
│  │Conversations │ │  AI Module   │ │   Refinery   │ │ErrorBook│ │
│  │  Controller  │ │  Controller  │ │  Controller  │ │Controller│ │
│  │  Service     │ │  Service     │ │  Service     │ │ Service │ │
│  │  Repositories│ │  (calls ai-  │ │  Repositories│ │ Repos   │ │
│  │              │ │   core)      │ │              │ │         │ │
│  └──────────────┘ └──────────────┘ └──────────────┘ └─────────┘ │
│                              │                                    │
│  ┌───────────────────────────▼────────────────────────────────┐ │
│  │              ai-core (capabilities / infra)                 │ │
│  │  TutoringCapability  QuestionStructuringCapability          │ │
│  │  ModelRouter PromptBuilder ModelClient SafetyGuard ...      │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                              │                                    │
│  ┌───────────────────────────▼────────────────────────────────┐ │
│  │         Persistent ConversationService (DB)                  │ │
│  │  ai_dialogues + ai_messages + safety_alerts                 │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────▼──────────┐
                    │   MinerUService    │
                    │  (mineru-open-api) │
                    └────────────────────┘
```

### 3.2 模块依赖图

```text
AppModule
  ├── DatabaseModule
  ├── AuthModule
  ├── FilesModule        → DatabaseModule
  ├── ConversationsModule → DatabaseModule
  ├── AIModule           → ConversationsModule + ai-core
  ├── RefineryModule     → FilesModule + DatabaseModule
  └── ErrorBookModule    → DatabaseModule + RefineryModule + AIModule
```

### 3.3 边界规则

1. **双轨物理隔离**
   - `ai_dialogues.track`、请求参数 `mode`、错误本类型（`aux_error_books` vs `main_error_books`）是隔离的核心字段。
   - 辅线不写 `progress`、`main_error_books`，不触发奖励/解锁。
   - 主线 UI 不链接辅线；辅线 UI 通过顶部「退出答疑」返回入口选择页，不链接主线。

2. **ConversationService 是唯一写入口**
   - 只有 `ConversationsService` 写入 `ai_dialogues` / `ai_messages`。
   - `SafetyGuard` 直接写入 `safety_alerts`；`ConversationsService` 仅在 `ai_messages.safety_flag` 上标记关联。

3. **Refinery Service 拥有 `extract_tasks` 生命周期**
   - 创建、状态推进、失败记录均由 `RefineryService` / `MinerUService` 负责。

4. **ErrorBook Service 拥有 `aux_error_books` 生命周期**
   - 题目结构化、去重、入库、重做、清零均由 `ErrorBookService` 负责。

---

## 4. Data Model Recap

辅助系统复用以下现有表（详见 DB 设计文档 §3.6-§3.8）：

| 表 | 在辅助系统中的作用 |
|---|---|
| `ai_dialogues` | 会话头；`track='auxiliary'`，`card_id` 为空，`knowledge_point_id` 可选，`title`、`consecutive_fail_count`、`status`。 |
| `ai_messages` | 所有用户/助手消息；含 `attachments` JSON、token 统计、`model`、`response_time_ms`、`safety_flag`。 |
| `questions` | 题库；`content_hash` 用于去重，`source='auxiliary'` 标记辅线入库题。 |
| ~~`aux_error_books`~~ | **已移除（2026-08-07）**。辅学系统不需要专门错题本；历史对话记录（`ai_dialogues`+`ai_messages`）起"回看做过的题"的作用。主线错题本 `main_error_books` 独立保留。 |
| `question_knowledge_points` | 题目与知识点的 M:N 映射。 |
| `extract_tasks` | 实时 OCR/提取任务；`status` ∈ (`pending`, `processing`, `completed`, `failed`)，`result` JSON。 |
| `uploaded_files` | 上传文件元数据；`source` ∈ (`auxiliary`, `ocr`, `answer`, `avatar`)。 |
| `safety_alerts` | SafetyGuard 产生的预警；关联 `dialogue_id` / `message_id`。 |
| `controls` | 家长行为管控；`auxiliary_enabled`、`photo_search_enabled`。 |
| `students`, `subjects`, `knowledge_points` | 复用现有表。 |

**关键索引**：
- `ai_dialogues`: `idx_dlg_student_track`
- `questions`: `uniq_q_content_hash` (UNIQUE)
- `aux_error_books`: `idx_ae_student_subject`
- `extract_tasks`: 按 `student_id` + `status`

---

## 5. Backend Service Design (NestJS)

### 5.1 目录结构

```
apps/server/src/
├── modules/
│   ├── ai/
│   │   ├── ai.module.ts
│   │   ├── ai.controller.ts
│   │   └── ai.service.ts
│   ├── conversations/
│   │   ├── conversations.module.ts
│   │   ├── conversations.controller.ts
│   │   ├── conversations.service.ts
│   │   └── dto/
│   ├── refinery/
│   │   ├── refinery.module.ts
│   │   ├── refinery.controller.ts
│   │   ├── refinery.service.ts
│   │   └── mineru.service.ts
│   ├── error-book/
│   │   ├── error-book.module.ts
│   │   ├── error-book.controller.ts
│   │   └── error-book.service.ts
│   └── files/
│       ├── files.module.ts
│       ├── files.controller.ts
│       └── files.service.ts
├── database/repositories/
│   ├── ai-dialogues.repo.ts
│   ├── ai-messages.repo.ts
│   ├── aux-error-books.repo.ts
│   ├── extract-tasks.repo.ts
│   ├── safety-alerts.repo.ts
│   ├── uploaded-files.repo.ts
│   └── questions.repo.ts
└── services/conversation/
    └── index.ts   ← 持久化改造
```

### 5.2 Repository 设计

遵循后端 Web 服务设计文档 §6：一个表一个 Repository，注入 `@Inject('DATABASE_POOL')`，参数化 SQL，返回 camelCase 普通 TS 接口，无业务逻辑。

| Repository | 核心方法 |
|---|---|
| `AiDialoguesRepository` | `create`, `findByStudentAndTrack`, `findById`, `updateTitle`, `archive`, `updateFailCount`, `updateStatus` |
| `AiMessagesRepository` | `create`, `createMany`, `findByDialogue`, `findSinceId`, `findLastByDialogue` |
| `AuxErrorBooksRepository` | `create`, `findByStudent`, `findById`, `markCleared`, `updateLevel`, `findByQuestionId` |
| `ExtractTasksRepository` | `create`, `updateStatus`, `findById`, `findByStudent` |
| `SafetyAlertsRepository` | `create`, `findByParent`, `markRead` |
| `QuestionsRepository` | `findByContentHash`, `create`, `findById`, `bindKnowledgePoints` |
| `UploadedFilesRepository` | `create`, `findById`, `markUsed` |

### 5.3 Controllers

#### 5.3.1 `ConversationsController` — `/api/conversations`

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/conversations` | student/parent | 查询会话列表；支持 `?track=auxiliary&studentId=` |
| POST | `/api/conversations` | student | 创建会话；`track=auxiliary`，可选 `knowledgePointId` |
| GET | `/api/conversations/:dialogueId` | owner | 会话元数据 |
| PATCH | `/api/conversations/:dialogueId` | owner | 更新标题 / 归档 |
| GET | `/api/conversations/:dialogueId/messages` | owner | 分页历史消息；支持 `?lastMessageId=` |
| POST | `/api/conversations/:dialogueId/messages` | owner | 非流式兜底发送消息 |

#### 5.3.2 `AIController` — `/api/ai`

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/api/ai/tutor` | student | 苏格拉底辅导；`mode='auxiliary'`，支持 `?stream=sse` |
| POST | `/api/ai/hint` | student | 提示（主线/辅线共用） |
| POST | `/api/ai/explain` | student | 讲解（主线/辅线共用） |
| POST | `/api/ai/variation` | student | 变式生成（P1） |

流式策略：
- **主路径**：WebSocket `/ws/ai/{dialogueId}`。
- **降级 1**：SSE `GET /api/ai/tutor?stream=sse`。
- **降级 2**：非流式 `POST /api/ai/tutor`。

#### 5.3.3 `RefineryController` — `/api/refinery`

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/api/refinery/extract` | student | 创建提取任务；请求 `{ fileId, source: 'auxiliary' }` |
| GET | `/api/refinery/tasks/:taskId` | owner | 轮询任务状态与结果 |

#### 5.3.4 `ErrorBookController` — `/api/error-book`

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/error-book/students/:studentId/aux` | owner | 辅线错题本列表；默认当前学科，可 `?subject=` |
| POST | `/api/error-book/aux` | student | 创建辅线错题（确认/编辑后录入） |
| GET | `/api/error-book/items/:errorItemId` | owner | 错题详情（主线/辅线共用） |
| POST | `/api/error-book/items/:errorItemId/redo` | student | 重做错题（主线/辅线共用） |
| POST | `/api/error-book/items/:errorItemId/clear` | student | 标记清零（主线/辅线共用） |
| GET | `/api/error-book/items/:errorItemId/explanation` | owner | AI 解析 |
| GET | `/api/error-book/items/:errorItemId/variations` | student | 变式题列表（P1） |
| POST | `/api/error-book/items/:errorItemId/variations/:variationId/submit` | student | 提交变式答案（P1） |

### 5.4 Services

#### 5.4.1 `ConversationsService`

- 封装 Repository，强制所有权校验：学生只能访问自己的会话；家长可访问其孩子的会话。
- 方法：
  - `createAuxiliaryDialogue(studentId, subjectId?, knowledgePointId?)`
  - `listAuxiliaryConversations(studentId, limit, cursor?)`
  - `getMessages(dialogueId, lastMessageId?)`
  - `appendUserMessage(dialogueId, content, attachments?, safetyFlag?)`
  - `appendAssistantMessage(dialogueId, content, type, model?, metadata?)`
  - `updateFailCount(dialogueId, increment)`
  - `archive(dialogueId)`

#### 5.4.2 `AIService`

- 处理 `/api/ai/tutor` 请求。
- 校验 `controls.auxiliary_enabled`；若被家长关闭，返回业务码 1004。
- 非流式：调用 `TutoringCapability.tutor(request)`，持久化消息。
- 流式：打开 `ModelClient.streamChat()`，边聚合 chunk 边通过 SSE/WebSocket 推送，完成后持久化完整消息。
- 触发 `safety_alert` 时，向通知网关推送家长端预警。

#### 5.4.3 `RefineryService`

- 校验文件所有权与 `source`。
- 创建 `extract_tasks` 记录，状态 `pending`。
- 异步调用 `MinerUService.extract()`，推进状态为 `processing` → `completed` / `failed`。
- 完成后调用 `QuestionStructuringCapability` 生成结构化题目候选。
- 提供 `getTask(taskId)` 轮询。

#### 5.4.4 `MinerUService`

Node.js 包装 `mineru-open-api` CLI：

```typescript
class MinerUService {
  async extract(fileId: number): Promise<{ taskId: number }>
  private async runMinerU(inputPath: string, outputDir: string): Promise<string>
  private parseOutput(outputDir: string): { markdown: string; images: string[] }
}
```

实现要点：
- 使用 `os.tmpdir()` 作为工作目录。
- CLI 超时 120 秒，失败重试 2 次。
- 每名学生最多 1 个并发提取任务（DB 状态检查或内存锁）。
- 将生成的图片资源复制到与 `uploaded_files` 一致的 OSS/本地路径。

#### 5.4.5 `ErrorBookService`（辅线路径）

- `createAuxError(studentId, extractedQuestion)`: 运行去重 → 插入或复用 `questions` → 写入 `aux_error_books`。
- `listAuxErrors(studentId, subjectId?)`: 列表，支持筛选。
- `redoAuxError(errorItemId, answerText)`: 记录重做日志；MVP 阶段允许学生自确认做对即清零（P1 可接入 AI 批改）。
- `clearAuxError(errorItemId)`: 标记 `is_cleared=1`，不影响主线解锁。

---

## 6. AI-Agent Integration

### 6.1 复用 `TutoringCapability` 的辅线路径

现有 `apps/server/src/ai-core/capabilities/tutoring.capability.ts` 已支持 `mode='auxiliary'`：

- `TutoringRequest.mode: Track`
- `SafetyGuard.check()` 接收 `track` 参数。
- `PromptBuilder.build()` 接收 `track` 参数，路由到 `tutoring/{subject}/${track ?? 'auxiliary'}.md`。
- `FallbackHandler.handle()` 接收 `track` 参数。

辅线场景下：
- `cardId` 省略；`knowledgePointId` / `currentQuestion` 可选。
- PromptBuilder 加载 `tutoring/math/auxiliary.md`（已存在）。

### 6.2 新增 `QuestionStructuringCapability`

位置：`apps/server/src/ai-core/capabilities/question-structuring.capability.ts`

职责：将学生文本输入或 MinerU 输出的 Markdown 结构化为题库可用的题目。

输入：

```typescript
interface QuestionStructuringRequest {
  rawInput: string;           // 文本 或 MinerU 输出的 Markdown
  inputType: 'text' | 'image_markdown';
  studentId: string;
  subjectHint?: string;       // 如 'math'
  gradeBand?: string;
}
```

输出：

```typescript
interface StructuredQuestion {
  type: 'choice' | 'fill_blank' | 'true_false' | 'short_answer' | 'proof';
  difficulty: 1 | 2 | 3;
  content: string;            // Markdown + LaTeX
  options?: Option[];
  answer: string;
  explanation: string;
  knowledgePoints: string[];  // 知识点名称（LLM 输出，由 ErrorBookService 解析为 ID）
  quality: 'good' | 'poor';
  qualityIssues?: string[];
  // 注：subjectId / contentHash / knowledgePointIds 由消费方（ErrorBookService）解析，非 LLM 输出
}
```

Prompt：`apps/server/src/ai-core/prompts/structuring/question.md`（新建）。

模型路由：使用 cheap/reasoner 场景，如 `deepseek-v4-flash`。

### 6.3 `SafetyGuard` 在辅线下的行为

- `track='auxiliary'` 传入 `SafetyCheckRequest`。
- 分类为 `learning` / `off_topic` / `anomaly`。
- `off_topic`：温和阻断话术 + info/warning/critical 级别 `safety_alerts`。
- `anomaly`： emotional → warning；sensitive/abusive → block + critical。
- 连续偏离升级：1-2 次 info，3+ warning（家长 Banner），5+ critical（强制暂停对话）。

### 6.4 `FallbackHandler`

- 触发条件：同一核心步骤连续 3 次答错 / 说「不会/不懂/不知道/太难/放弃/算不出来/想不出来」。
- 辅线无 `cardContent`，使用 `currentQuestion` 或最近结构化题目作为上下文。
- 输出完整解析 + 知识点总结，消息类型标记为 `fallback`。

---

## 7. Real-Time Image/PDF Extraction Design

### 7.1 完整流程

支持文件类型：PNG、JPEG、HEIC 图片，TXT/MD 文本文件，PDF 文档。图片和文本文件直接作为附件传入 AI 对话；PDF 上传后自动触发 MinerU 提取。

```text
学生上传图片/文件（粘贴/拖拽/点+按钮）
  │
  ├─ 图片 (PNG/JPEG/HEIC) / 文本 (TXT/MD)
  │    ▼
  │   直接作为附件传入 POST /api/ai/tutor/stream
  │
  └─ PDF
       ▼
      POST /api/files/upload → uploaded_files 记录 + 存储
       │  响应: { fileId, url, taskId }
       ▼
      FilesService 自动创建 extract_tasks (status=pending)
       ▼
      MinerUService 启动 mineru-open-api CLI
       │
       ▼
      extract_tasks status=processing
       │
       ▼
      CLI 完成 → Markdown + 图片资源
       │
       ▼
      MinerUService 更新 extract_tasks status=completed, result={markdown}
       │
       ▼
      前端 SSE 监听 GET /api/refinery/tasks/{taskId}/stream
       │  data: {"type":"done"} 或 data: {"type":"error","message":"..."}
       ▼
      状态 completed → 前端 POST /api/ai/tutor/stream
       │  attachments: [{ type: "file", fileId, taskId }]
       │
       ▼
      AIService.resolveAttachments 读取 MinerU 结果
       │  TXT/MD → UTF-8 字符串；PDF → extract_tasks.result.markdown
       ▼
      拼入 LLM 输入，PDF 图片自动路由到多模态模型
```

### 7.2 任务队列与轮询

- MVP 不使用外部消息队列，以 `extract_tasks` 表作为状态机。
- 推荐前端轮询策略：首秒 1 次，之后指数退避至 5 秒。
- 服务端可支持最长 20 秒长轮询（hold 请求直到任务完成或超时）。
- 清理：已完成/失败任务 30 天后删除（DB 设计文档 §4）。

### 7.3 错误处理

| 场景 | 行为 |
|---|---|
| CLI 未安装 | task `failed`，返回 "图片识别服务未就绪" |
| 超时 120s | task `failed`，提示重新拍摄 |
| PDF/图片损坏 | task `failed`，提示检查文件 |
| 未识别到文字 | task `completed` 但 `result.markdown` 为空，前端引导手动输入 |

---

## 8. Question Ingestion & Deduplication Flow

### 8.1 触发条件

1. **聊天中具体题目**：辅导 LLM 在回复中内联输出结构化 JSON 块（`TutoringCapability.parseContent` 提取），由 `AIService` 直接写入 `questions` 题库（`content_hash` 去重）。**非具体题目（纯概念讨论、打招呼、多题澄清回复）不输出 JSON，不入库。**
2. **拍照/输入答疑流程**：MinerU 提取 + 学生确认后（P3.3，当前前端为 Placeholder）。此路保留但未实现 UI。

**多题澄清**（2026-08-07）：图文多题且未指明时，LLM 先编号转录各题并问"想先看哪道？一次只能选一道哟"，**强制单选**；学生说"全部"则温和拒绝。指明单题后正常辅导+入库。澄清过程不输出 JSON，不入库。

> 注：`aux_error_books` 已移除（2026-08-07）。入库仅写 `questions` 题库。对话历史即起错题本作用。

### 8.2 归一化与 content_hash

在 `QuestionsRepository` 或 `ErrorBookService` 中实现：

```typescript
function normalizeForHash(content: string): string {
  return content
    .replace(/\s+/g, '')                       // 去空白
    .replace(/[，。！？、；：""''（）【】]/g, '') // 去中文标点
    .replace(/[,!?;:"'()\[\]]/g, '')          // 去英文标点
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)) // 全角数字转半角
    // LaTeX 公式轻量归一：去除多余空格，统一变量顺序（可选、P1）
    .toLowerCase();
}

function computeContentHash(content: string): string {
  return crypto.createHash('sha256').update(normalizeForHash(content)).digest('hex');
}
```

### 8.3 去重逻辑

```text
计算 content_hash
  │
  ├─ questions 表存在精确匹配 → 复用 question_id
  │     （创建新的 aux_error_books 行，指向已有 question_id）
  │
  └─ 无精确匹配
        │
        ├─ P1: 同 subject + type 文本相似度兜底 → 命中则复用
        │
        └─ 插入新 questions 行，source='auxiliary'
```

### 8.4 质量校验门控

轻量校验规则：
- 题干非空且包含可作答的问题。
- `type` 在允许枚举内。
- `answer` 非空。
- 选择题：options 存在且仅有一个正确选项。
- LLM 自检：题干完整、题型合法、有可解答案。

失败处理：
- 仅写入 `aux_error_books`（`question_id` 为空，`raw_content` 存入 `wrong_answer_text` 或新增列）。
- **不写入 `questions`**，避免污染组卷池。

### 8.5 知识点绑定

- LLM 输出知识点名称/编码。
- 服务层解析为 `knowledge_points.id`；未解析成功则标记未绑定，待人工/P1 处理。
- 写入 `question_knowledge_points`，`role='primary'`。

### 8.6 题库写入

- 每道结构化具体题目经 `content_hash` 去重后写入 `questions`（`source='auxiliary'`）。
- 质量门控：`quality==='poor'` 时跳过，不写入 `questions`。
- ~~无 `aux_error_books` 关联~~（表已移除，2026-08-07）。

---

## 9. Frontend Page Design

### 9.1 路由更新

`apps/web/src/routes/index.tsx` 中 P3.1-P3.4 当前为 Placeholder，需替换为真实页面：

| 页面 | 路由 | 组件 |
|---|---|---|
| P3.1 辅轨答疑应用 | `/student/auxiliary` | `AuxiliaryHomePage` |
| P3.2 知识点选择 | `/student/auxiliary/selector` | `KnowledgeSelectorPage` |
| P3.3 拍照/输入答疑 | `/student/auxiliary/ask` | `PhotoAskPage` |
| P3.4 辅线对话 | `/student/auxiliary/chat` | `AuxChatPage` |

### 9.2 P3.1 辅轨答疑应用（ChatGPT-like 单页）

布局（依据 UX-UI §5.3）：
- **左侧边栏**：历史答疑会话列表（默认显示最近 10 条，超出隐藏，点击「展开」查看全部），底部「辅线错题本」入口（紫色）。
- **右侧主区**：当前聊天窗口或空状态；顶部提示带「答疑轨 · 限 K12 学科」。
- **顶部右上**：「退出答疑」（返回 `/student/entry`，当前会话自动保存为历史）、「下一个问题」（结束当前会话并新建会话）。
- **底部输入栏**（`AuxInputBar`）：文字 / 公式编辑器 / 文件上传（点「+」按钮选文件，支持 PNG/JPG/HEIC/TXT/MD/PDF）/ 手写 四种输入入口。PDF 上传后自动触发 MinerU 提取，通过 SSE（`GET /api/refinery/tasks/{taskId}/stream`）通知前端提取完成，随后以 `type: "file"` 附件传入 AI 对话。

组件拆分：
- `AuxiliaryLayout`（响应式左右分栏）
- `ConversationList`
- `AuxChatPanel`
- `AuxInputBar`
- `AuxEmptyState`

主题：使用紫色辅色 `#8B5A8E`，包裹 `.student-theme-container` 启用日夜模式。

### 9.3 P3.2 知识点选择

- 调用 `GET /api/content/knowledge-points`。
- 默认按当前学科筛选。
- 点击知识点 → 跳转 `/student/auxiliary/chat?knowledgePointId=xxx`。

### 9.4 P3.3 拍照/输入答疑

- 文件上传：`POST /api/files/upload`。
- 创建提取任务：`POST /api/refinery/extract`。
- 轮询：`GET /api/refinery/tasks/:taskId`。
- 预览 Markdown，支持编辑。
- 确认后：`POST /api/error-book/aux` → 跳转 P3.4 或 P4.2。

### 9.5 P3.4 辅线对话

- 全页聊天（区别于主线 `AIDialogue` 的右侧抽屉）。
- 接收 URL 参数 `dialogueId` / `knowledgePointId`。
- WebSocket 主路径，SSE 降级。
- KaTeX 渲染 LaTeX。
- 消息类型：
  - `socratic`：正常苏格拉底引导
  - `fallback`：兜底完整解析
  - `block`：温和阻断
  - `chat-off-topic`：闲聊提示

### 9.6 状态管理

新增/扩展 Zustand store：

- `auxiliaryStore`
  - `currentDialogueId`
  - `conversationList`
  - `auxErrorCount`
  - `loadConversations(studentId)`
  - `createDialogue(subjectId?, knowledgePointId?)`

- `chatStore`
  - `messages`
  - `isStreaming`
  - `streamingContent`
  - `failCount`
  - `sendMessage(content, attachments?)`
  - `appendToken(token)`
  - `finalizeMessage()`

- `refineryStore`
  - `taskStatus`
  - `extractedMarkdown`
  - `structuredQuestion`
  - `startExtract(fileId)`
  - `pollTask(taskId)`

### 9.7 WebSocket / SSE 处理

```typescript
function useAuxChat(dialogueId: string) {
  const ws = useRef<WebSocket | null>(null);
  // 连接 wss://host/ws/ai/{dialogueId}?token=JWT
  // 消息类型：token / full / error / safety_alert / heartbeat
  // 断线：指数退避重连，携带 lastMessageId
  // 不可用时降级到 SSE GET /api/ai/tutor?stream=sse
}
```

---

## 10. API Endpoints Summary

| 端点 | 方法 | openapi.yaml 位置 | 用途 |
|---|---|---|---|
| `/api/ai/tutor` | POST | ~1326 | 苏格拉底辅导（含辅线 mode=auxiliary） |
| `/api/conversations` | GET/POST | ~1861 | 查询/创建会话 |
| `/api/conversations/:dialogueId` | GET/PATCH | ~1912 | 元数据/更新 |
| `/api/conversations/:dialogueId/messages` | GET/POST | ~1963 | 历史/非流式发送 |
| `/api/refinery/extract` | POST | ~1485 | 创建实时提取任务 |
| `/api/refinery/tasks/:taskId` | GET | ~1508 | 轮询任务结果 |
| `/api/files/upload` | POST | ~1533 | 上传图片/PDF |
| `/api/error-book/students/:studentId/aux` | GET | ~1613 | 辅线错题本列表 |
| `/api/error-book/aux` | POST | ~1790 | 创建辅线错题 |
| `/api/error-book/items/:errorItemId/redo` | POST | ~1661 | 重做错题 |
| `/api/error-book/items/:errorItemId/clear` | POST | ~1690 | 标记清零 |

WebSocket 通道：`wss://host/ws/ai/{dialogueId}`。

> 若本设计文档对端点参数/响应的描述与 `openapi.yaml` 冲突，以 `openapi.yaml` 为准并同步更新本文档。

---

## 11. Error Handling & Edge Cases

### 11.1 后端错误码

| 场景 | HTTP | 业务码 | 说明 |
|---|---|---|---|
| 请求参数校验失败 | 400 | 1001 | Zod 校验错误 |
| 资源不存在 | 404 | 1002 | 会话/错题/任务不存在 |
| 访问他人数据 | 403 | 1003 | 非本人/非家长孩子 |
| 辅线被家长关闭 | 403 | 1004 | "辅线功能已被家长暂时关闭" |
| AI 额度不足 | 429 | 1005 | 降级为提示-only |
| 非学习内容阻断 | 200 | — | 消息类型 `block` + safety_alert |
| 提取超时/失败 | 200 | — | task `status=failed` |
| 题目质量校验失败 | 200 | — | 只进 aux_error_books |

### 11.2 边界情况

- **学生只发图片无文字**：创建提取任务 → 结构化 → 直接进入聊天或错题本。
- **提取无文字**：允许学生手动输入题目。
- **重复题目拍照**：复用 `question_id`，创建新的 `aux_error_books` 行（每次拍照都是独立复习事件）。
- **WebSocket 断线**：客户端重连并携带 `lastMessageId`；MVP 可容忍不续接，P1 实现断点续传。
- **无知识点上下文**：`FallbackHandler` 使用通用兜底话术。
- **同一学生并发消息**：按 dialogue 串行化（DB 唯一约束或乐观锁）。

---

## 12. Testing Strategy

### 12.1 单元测试

- `QuestionStructuringCapability`：结构化输出解析、hash 计算、质量判定。
- `MinerUService`：用 mocked `child_process` 测试 CLI 调用与超时重试。
- `AuxErrorBooksRepository` / `AiDialoguesRepository`：CRUD 与所有权查询。
- `ConversationService` 持久化：上下文加载、消息截断、失败计数。

### 12.2 集成测试

- 辅线聊天完整闭环：创建对话 → 发送消息 → 流式响应 → 消息持久化 → 家长预警写入。
- 图片提取闭环：上传 → 提取 → 结构化 → 去重 → 写入 `aux_error_books`。
- 去重：同一题目输入两次 → `questions` 仅 1 条，`aux_error_books` 2 条。

### 12.3 前端测试

- P3.1 渲染会话列表、输入栏、退出/下一个问题按钮。
- P3.3 轮询状态转换（pending → processing → completed/failed）。
- P3.4 WebSocket token 渲染、SSE 降级。
- 双错题本 P4.1 主线/辅线 Tab 切换与紫色主题。

### 12.4 手动 QA

- 安全分类：辅线开放域 K12 问题不被误判为 off_topic。
- 物理隔离：辅线页面无主轨入口，主线页面无辅轨入口。
- 家长端行为管控：关闭 `auxiliary_enabled` 后学生无法进入辅线。

---

## 13. Open Questions

1. **MinerU 部署**：生产环境 Node.js 运行时是否已安装 `mineru-open-api` CLI？若否，需容器镜像更新或 sidecar 方案。
2. **第三方 OCR 回退**：P1 是否必须引入 Mathpix / 讯飞作为 MinerU 失败时的回退？
3. **聊天中具体题目触发** ✅ 已结案（2026-08-07）。检测内联在辅导 LLM（不单独调 `QuestionStructuringCapability`）：辅导 prompt 末尾的"结构化题目输出"指令让 LLM 在正常辅导回复中顺带输出 JSON 块，`TutoringCapability.parseContent` 提取+剥离。多题场景触发澄清（force-single），不批量入库。与 2026-07-24 Task 14a 实现一致。
4. **辅线错题重做评分**：MVP 是否允许学生自确认「做对了」即清零，还是必须接入 AI 批改？
5. **LaTeX 公式归一**：`content_hash` 对公式的归一策略需精确到何种程度，以避免假阴性/假阳性？
6. **额度消耗**：辅线聊天是否 consume 与主线相同 family 共享 AI 额度？
7. **跨节点 WebSocket 续接**：MVP 是否必须支持 `lastMessageId` 断点续传，还是可接受重连后从最新消息继续？
8. **手写输入**：P3.1 底部输入栏保留「手写」入口，但手写识别能力延至后续迭代，前端是否先显示占位提示？

---

## 14. 关键设计决策与 rationale

| 决策 | 理由 |
|---|---|
| 复用 `TutoringCapability` 的 `mode='auxiliary'` | 现有 infra 已完整路由到 `auxiliary.md`，避免重复 prompt 逻辑。 |
| 新增 `QuestionStructuringCapability` | 将 LLM 编排集中在 ai-core；HTTP 服务层保持薄。 |
| 持久化 `ConversationService` | 当前内存实现无法跨重启/节点，DB 化是生产必需。 |
| Node.js 包装 MinerU CLI | 与 Python 离线管线解耦，实时路径需要直接 HTTP 集成。 |
| 异步提取任务 + 轮询 | MinerU CLI 可能耗时数分钟，同步 HTTP 会超时。 |
| `content_hash` 精确去重 + 轻量质量门 | 符合 PRD §7.10 与现有 DB 索引，平衡正确性与成本。 |
| 自动入 `aux_error_books` | PRD §6.2 明确要求，无需学生确认，降低摩擦。 |
| 独立 `aux_error_books` Repository | 保证双轨物理隔离，杜绝影响主线解锁。 |
| WebSocket 主路径 + SSE 降级 | 最佳流式体验，同时与 API 文档 §5.4 保持一致。 |
| 紫色辅线主题 | UX-UI 强制要求，与主线橘红清晰区隔。 |
| 多题澄清：force-single | 非逐题串行。图文多题未指明 → LLM 先问"哪道"、"全部"被拒（"一次只能选一道哟"）。逐题串行会导致 per-dialogue `consecutive_fail_count` 跨题污染（Q1 失败 3 次后 Q2 立刻误触发 fallback），且违背苏格拉底单焦点原则。force-single 零代码改动（仅 prompt），一道一道入库。 |
| 移除 aux_error_books | 辅学系统不需要专门错题本。历史对话记录（`ConversationList` + 对话详情）已起"回看做过的题"的作用。入库仅写 `questions` 题库（答案/解析充实共享题库）。redo/clear 随之去掉。"无需判错、无需确认"（PRD §6.2）从一开始就意味着错题本不是真正的"错"题本。主线错题本（`main_error_books`）独立保留，服从闯关门控。 |

---

## 15. 待后续接入的 superpowers 流程

本文档经用户 review 并批准后，下一步调用 `superpowers:writing-plans` skill，生成可执行的实施计划（任务拆分、文件级变更清单、测试与验收标准）。

---

## 16. Change Log

### 2026-08-08 多文件上传

- 文件上传通道扩展：支持 PNG/JPG/HEIC/TXT/MD/PDF
- PDF 自动提取：上传后连接 MinerU → SSE 通知 → markdown 发给 LLM
- 提取的图片自动路由到多模态模型
- AuxInputBar: 统一 FileState 状态机、+ 按钮选文件、文件预览区、发送/停止 SVG 图标
- 新增端点: `GET /api/refinery/tasks/{taskId}/stream` (SSE)
