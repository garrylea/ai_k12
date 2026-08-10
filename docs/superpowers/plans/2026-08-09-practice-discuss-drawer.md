# 课堂练习「让 AI 讲一讲」-- 弹窗内抽屉式苏格拉底讨论

## 背景与决策（已与用户确认）

当前 [AnswerModal.tsx:100-103](apps/web/src/components/business/AnswerModal.tsx#L100-L103) 的 `handleDiscuss` 跳转到占位路由 `/student/ai-discuss`（[routes/index.tsx:76](apps/web/src/routes/index.tsx#L76) 是 Placeholder）。本次把它做成 AnswerModal 内的右侧抽屉式多轮苏格拉底讨论。

三个已确认决策：
1. **错题记录**：打开讨论即记入主线错题本（find-or-create，幂等），无论之后答对答错都保留。
2. **抽屉收起**：仅手动开关（开/关/放大按钮），不自动收起。
3. **兜底讲解**：保留现有 TutoringCapability 兜底（3 次失败/放弃关键词后给完整解析）。

## 关键发现（影响方案）

- **`POST /api/ai/tutor` + `/api/ai/tutor/stream` 已完整实现**（[ai.controller.ts](apps/server/src/modules/ai/ai.controller.ts)），包裹 `TutoringCapability`。对话流直接复用，**服务端对话部分零改动**。
- **`prompts/tutoring/math/mainline.md` 已是苏格拉底式 + 严格限定卡片范围 + 公式 `$...$`**，完全匹配需求。但 `fallback.yaml` 的 giveUpKeywords 含 `不会/不懂/不知道/太难/放弃/算不出来/想不出来/完全不会`——**种子消息必须避开这些词**，否则首轮即触发兜底直接给答案。
- **⚠️ cardContent 当前未接线（必须修）**：[loadContext:96-98](apps/server/src/services/conversation/index.ts#L96-L98) 注释明说 `cardContent not persisted ... mainline flow must pass it separately`，且 [ConversationsService.create:25](apps/server/src/modules/conversations/conversations.service.ts#L25) 硬编码 `card_id: null`。结果 mainline.md 的 `<card_content>{{cardContent}}</card_content>` 渲染为空——AI 没有范围边界，无法满足"只能讨论这一道题、不能聊其它"。讨论功能是 mainline 模式的首个真实用例，必须补上这条接线。
- **`markCleared` 全仓库无调用方**（仅 types.ts 定义）——错题清除门禁尚未实现。因此决策 1"答对也保留"自然成立，无需写清除逻辑。
- **错题本无 `(student_id, question_id)` 唯一约束**——幂等需在应用层 find-or-create。
- **前端已有完整流式聊天基建**可复用：[useAuxChat.ts](apps/web/src/hooks/useAuxChat.ts)（SSE 消费 `/ai/tutor/stream`）、[AuxChatPanel.tsx](apps/web/src/components/business/AuxChatPanel.tsx)（Markdown+KaTeX、ReasoningBlock、ThinkingDots）、[chatStore.ts](apps/web/src/store/chatStore.ts)。
- **`ConversationsModule` 不依赖任何领域模块**（仅提供 repos），可安全 import 进 PracticeModule，无循环依赖。
- **practice.module 已注册** QuestionsRepository / MainErrorBooksRepository / CardsRepository。

## 范围界定（scope = 卡片）

讨论范围 = 该 card 的 content（教学+题目上下文）。种子消息携带当前题目的 `questionText`，让 AI 聚焦当前题。同卡其它题目视为同范围（同一课时，可接受）；跨卡/跨主题由 mainline.md 的"范围越界处理"+ SafetyGuard 拦回。这匹配现有 prompt 设计且教学合理。

---

## 服务端改动

### S1. 接线 card_id 存储 + cardContent 解析（修 mainline 范围 gap）

1. **[conversations.service.ts](apps/server/src/modules/conversations/conversations.service.ts)** `create()`：dto 加 `cardId?: number`，`card_id: dto.cardId ?? null`（替换硬编码 null）。
2. **[cards.repo.ts](apps/server/src/database/repositories/cards.repo.ts)**：新增 `findContentById(cardId): Promise<{ content: string } | null>`（`SELECT content FROM cards WHERE id = ?`）。
3. **[services/conversation/index.ts](apps/server/src/services/conversation/index.ts)** `ConversationService`：构造函数注入 `CardsRepository`；`loadContext` 中若 `record.card_id`，调 `findContentById` 取 content 作为 `cardContent` 返回（替换 `undefined`）。auxiliary 无 card_id，行为不变（additive，安全）。
4. **[ai.service.ts](apps/server/src/modules/ai/ai.service.ts)** `resolveDialogue`：`conversationsService.create(userId, { track: dto.mode, knowledgePointId, cardId: dto.cardId })`（传入 cardId）。

> 这条修复同时让所有 mainline 辅导受益，是讨论功能正确性的前提。

### S2. 错题本幂等 find-or-create

5. **[main-error-books.repo.ts](apps/server/src/database/repositories/main-error-books.repo.ts)**：新增 `findUnclearedByStudentQuestion(studentId, questionId, cardId, questionText)`：
   ```sql
   SELECT * FROM main_error_books WHERE student_id=? AND is_cleared=0 AND (
     (? IS NOT NULL AND question_id=?) OR
     (question_id IS NULL AND source_ref_id=? AND wrong_answer_text=?)
   ) LIMIT 1
   ```

### S3. 新端点 `POST /api/practice/discuss`

6. **dto/discuss-practice.dto.ts**（新）：`{ cardId: number; lessonId?: number; subjectId: number; questionText: string }`。
7. **[practice.controller.ts](apps/server/src/modules/practice/practice.controller.ts)**：`@Post('discuss')` → `practiceService.startDiscuss(dto, user.sub)`。
8. **[practice.service.ts](apps/server/src/modules/practice/practice.service.ts)** `startDiscuss(input, userId)`：
   - a. `questionId = questionsRepo.findByContentHash(computeContentHash(input.questionText))?.id ?? null`（快速，不调 AI）。
   - b. `existing = mainErrorRepo.findUnclearedByStudentQuestion(userId, questionId, input.cardId, input.questionText)`；若无则 `create({ student_id:userId, subject_id:input.subjectId, question_id:questionId, source:'discuss', source_ref_id:input.cardId, wrong_answer_text: questionId===null ? input.questionText : null })`。`errorBookId = existing?.id ?? created`。
   - c. `dialogueId = conversationsService.create(userId, { track:'mainline', cardId: input.cardId })` → id。
   - d. 返回 `{ dialogueId: String(id), errorBookId, questionId }`。
9. **[practice.module.ts](apps/server/src/modules/practice/practice.module.ts)**：`imports: [ConversationsModule]`；PracticeService 注入 `ConversationsService`。

> 端点职责：记录错题本（幂等）+ 创建带 card_id 的 mainline 对话并返回 dialogueId。之后前端用该 dialogueId 走 `/ai/tutor/stream` 做苏格拉底对话。

---

## 前端改动

### F1. api 层

10. **[api.ts](apps/web/src/services/api.ts)**：
    - `tutor()` 的 `mode` 类型放宽为 `'mainline' | 'auxiliary'`。
    - 新增 `startDiscuss(payload): Promise<{ dialogueId; errorBookId; questionId }>` → `POST /practice/discuss`。
    - 新增 `streamTutorEvents(req, signal)` async generator（共享 SSE 消费，仿 `streamExtraction`；处理 reasoning/content(含 replace)/done/error 事件）。useAuxChat 保持原样不动（无前端测试，避免回归）。

### F2. 讨论 hook

11. **hooks/useDiscussChat.ts**（新）：`useDiscussChat(cardId, questionText, subjectId, lessonId)`：
    - 本地 state：`messages`、`isStreaming`、`isLoadingHistory`、`dialogueId`。（不用全局 chatStore，避免与辅线聊天冲突。）
    - 打开时：若 `practiceStore.discussDialogues[questionKey]` 已缓存 → 用它 + `getMessages(dialogueId)` 加载历史；否则调 `startDiscuss` → 缓存 dialogueId → 自动发种子消息。
    - `send(content)`：`streamTutorEvents({ mode:'mainline', dialogueId, message:content })`，累加 reasoning/content 增量，处理 done/error/replace。
    - `stop()`：AbortController.abort()。
    - **种子消息**：`我想请你带我思考这道题：\n\n${questionText}\n\n请用提问的方式一步步启发我找到思路。`（避开所有 giveUpKeywords。）

### F3. 抽屉组件

12. **components/business/DiscussDrawer.tsx**（新）：
    - Props: `cardId, questionText, subjectId, lessonId, onClose`。
    - 右侧抽屉叠在 AnswerModal 中部之上；**实色背景**（非半透明，保证 KaTeX 可读）。
    - 手动控制：关闭按钮、放大/缩小切换（小↔与 AnswerModal 同宽）。**不自动收起**。
    - 复用 AuxChatPanel 的 `Markdown`/`ReasoningBlock`/`ThinkingDots`（抽取为共享或复制；项目无前端测试，复制更安全）。
    - 消息列表 + 输入框 + 发送/停止按钮；自动滚动到底。
    - startDiscuss 解析中显示 loading。

### F4. 接入 AnswerModal

13. **[AnswerModal.tsx](apps/web/src/components/business/AnswerModal.tsx)**：
    - Props 加 `subjectId: number`。
    - `handleDiscuss` 改为 `setShowDiscuss(true)`（不再 navigate / 不再 handleClose——讨论时保留作答上下文）。
    - `showDiscuss` 时渲染 `<DiscussDrawer>`（覆盖中部编辑/预览区，题面栏保留可见）。

### F5. 状态与接入

14. **[practiceStore.ts](apps/web/src/store/practiceStore.ts)**：加 `discussDialogues: Record<string, string>`（key=questionText→dialogueId）+ `setDiscussDialogue(key, id)`；`setSession`/`reset` 清空。
15. **[CourseDetailPage.tsx](apps/web/src/pages/student/CourseDetailPage.tsx)**：`<AnswerModal>` 传 `subjectId={subjectId}`。

---

## 文档同步

16. **[docs/api/openapi.yaml](docs/api/openapi.yaml)**：加 `/practice/discuss` path + DiscussRequest/Result schema。
17. **[docs/API接口与数据流设计文档.md](docs/API接口与数据流设计文档.md)**：§4 加端点行、§6 加"课堂练习讨论"数据流（引用已有的 §6.1 主线讨论流）、版本日志。
18. **[CLAUDE.md](CLAUDE.md)**：追加 2026-08-09 discuss 功能实现记录（复用 /ai/tutor、cardContent 接线、错题本 discuss 源、抽屉 UX）。

---

## 测试

19. **[practice.service.test.ts](apps/server/src/modules/practice/practice.service.test.ts)**：`startDiscuss` —— 首次创建错题本+对话；二次调用幂等不重复；questionId 命中/未命中两条路径。
20. **[main-error-books.repo.test.ts](apps/server/src/database/repositories/main-error-books.repo.test.ts)**：`findUnclearedByStudentQuestion` 命中/未命中。
21. 前端无测试框架：手动验证（开抽屉→流式首条苏格拉底回复→多轮→放大/缩小→关闭→重开续接→错题本已有一条 discuss 记录）。

## 风险与备注

- **cardContent 接线（S1）改的是共享 `ConversationService.loadContext`**：仅当 `card_id` 非空时才加载（additive），auxiliary 不受影响。auxiliary 仍走 card_id=null。
- **种子消息用词**：任何包含 giveUpKeywords 的措辞会首轮触发兜底给答案，违反"不直接给答案"。已选用安全措辞，实现时复核。
- **错题本可能同题两条记录**：讨论记 `source='discuss'`，后续答错判题记 `source='practice'`（现有逻辑）。两者并存视为两种信号；若需去重可在判题流程检查既有 discuss 条目（本次不做，留备注）。
- **对话续接**：session 内（practiceStore 缓存 dialogueId）可续接；跨 session 续接需后端按 (student, card) 查既有 mainline 对话（idx_dlg_student_card 索引已存在），本次不做，留后续。
- **`npm run build` 不拷贝 prompts/yaml**：本次无新 prompt/yaml，不受影响。
