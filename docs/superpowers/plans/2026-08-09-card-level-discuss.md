# 卡片级「思辨答疑」右侧抽屉 + 讨论历史续接

## 背景与决策（已与用户确认）

[CourseDetailPage.tsx:713](apps/web/src/pages/student/CourseDetailPage.tsx#L713) 知识卡的悬浮「思辨答疑」按钮此前跳占位路由 `/student/ai-discuss`（Placeholder）。本次把它做成卡片级右侧抽屉式苏格拉底讨论，并支持历史续接。

用户确认三点：
1. **题目级历史续接（B方案）**：每道题与 AI 的讨论要保存并可续接。
2. **卡片级与题目级一致**：同样要有历史记录；卡片级限定在整张卡片范围，题目级限定在某一道题。
3. **卡片级也是抽屉**：与 AnswerModal 的题目级抽屉风格一致，但放大/缩小限定在右侧主内容区（不覆盖左侧阶段栏）。样式采用 style.md。

## 关键发现（影响方案）

- **题目级已有讨论历史缺口**：消息存了 DB（ai_messages），但 practiceStore 无 persist，且 startDiscuss 每次新建对话，导致刷新后旧讨论成孤儿。用服务端锚（error_book.dialogue_id）实现跨刷新/跨设备续接。
- **卡片级不入错题本**：不能以 error_book 为锚，改为以 `(student_id, card_id, track='mainline')` 在 ai_dialogues 上 find-or-create。
- **新增端点 `/practice/discuss-card`**：卡片级 find-or-create 逻辑放在 PracticeModule（与 `/practice/discuss` 对称），不污染 `POST /conversations` 语义。
- mainline.md 已严格限定卡片范围，卡片级 scope 自然成立。
- 前端抽离 `DiscussChat` 共享消息列表+输入+Markdown/KaTeX/ReasoningBlock；`useDiscussChat` 用 discriminated union 区分两模式。

## 范围界定

- 题目级 scope = 当前题（questionText + 同 cardId）。
- 卡片级 scope = 整张卡片（cardId）。
- 跨卡/跨主题由 mainline.md 越界处理 + SafetyGuard 拦回。

---

## 改动清单

### 1. 后端

- [tools/db/schema.sql](tools/db/schema.sql)：main_error_books 表新增 dialogue_id BIGINT DEFAULT NULL + 索引 idx_me_dialogue_id。
- [types.ts](apps/server/src/database/repositories/types.ts)：MainErrorBookRow 加 dialogue_id: number | null。
- [main-error-books.repo.ts](apps/server/src/database/repositories/main-error-books.repo.ts)：新增 updateDialogueId。
- [ai-dialogues.repo.ts](apps/server/src/database/repositories/ai-dialogues.repo.ts)：新增 findMainlineByStudentAndCard。
- [conversations.service.ts](apps/server/src/modules/conversations/conversations.service.ts)：新增 findOrCreateMainlineByCard。
- [practice.service.ts](apps/server/src/modules/practice/practice.service.ts)：startDiscuss 按 B方案复用 error_book.dialogue_id；新增 startCardDiscuss。
- [practice.controller.ts](apps/server/src/modules/practice/practice.controller.ts) + [discuss-card-practice.dto.ts](apps/server/src/modules/practice/dto/discuss-card-practice.dto.ts)：新增 POST /api/practice/discuss-card。
- 测试：[practice.service.test.ts](apps/server/src/modules/practice/practice.service.test.ts)、[main-error-books.repo.test.ts](apps/server/src/database/repositories/main-error-books.repo.test.ts)。

### 2. 前端

- [DiscussChat.tsx](apps/web/src/components/business/DiscussChat.tsx)（新）：共享消息列表+输入+Markdown/KaTeX/ReasoningBlock。
- [useDiscussChat.ts](apps/web/src/hooks/useDiscussChat.ts)：加 mode: 'question' | 'card'；卡片级调 startCardDiscuss。
- [DiscussDrawer.tsx](apps/web/src/components/business/DiscussDrawer.tsx)：支持 mode，题目级 w-[55%]/w-full，卡片级 w-[45%]/w-[70%]。
- [CourseDetailPage.tsx](apps/web/src/pages/student/CourseDetailPage.tsx)：加 showCardDiscuss state；按钮打开抽屉；main 加 relative；渲染 DiscussDrawer mode='card'。
- [AnswerModal.tsx](apps/web/src/components/business/AnswerModal.tsx)：DiscussDrawer 传 mode='question'。
- [api.ts](apps/web/src/services/api.ts)：新增 startCardDiscuss。
- 删除 [AiDiscussPage.tsx](apps/web/src/pages/student/AiDiscussPage.tsx)；[routes/index.tsx](apps/web/src/routes/index.tsx) 移除 /student/ai-discuss 路由。

### 3. 文档

- openapi.yaml：新增 /practice/discuss-card 路径 + DiscussCardRequest/DiscussCardResult schema。
- API接口与数据流设计文档.md：更新 §4、§6.11（B方案）、新增 §6.12、§7 页面对照表、版本日志 v1.5。
- CLAUDE.md：追加 2026-08-10 条目。
- 本 plan 文档同步更新。

---

## 验证

- server tsc --noEmit 通过；npm test 22 文件 147 测试绿。
- web tsc --noEmit 通过。

## 实现修正记录

- 初版误做成全屏页 AiDiscussPage + 独立路由；用户明确「卡片级也是抽屉式」后回退。
- 卡片级历史方案：从直接 createConversation 改为 /practice/discuss-card 服务端 find-or-create。
- 题目级历史方案：从纯前端 session 缓存升级为服务端 B方案（error_book.dialogue_id）。
- 抽屉宽度：用户选定「覆盖右侧·放大封顶」—— absolute 贴右，放大约 70% 封顶，不覆盖左侧阶段栏。
- schema FK 顺序：main_error_books 建表早于 ai_dialogues，无法 inline FK 引用，故 dialogue_id 按软引用处理，服务层兜底。

---

## 决策摘要

| 维度 | 题目级（AnswerModal） | 卡片级（CourseDetailPage） |
|---|---|---|
| 入口 | practice 卡题目旁「让 AI 讲一讲」 | 知识卡悬浮「思辨答疑」 |
| UI | AnswerModal 内右侧抽屉，放大铺满弹窗 | CourseDetailPage main 内右侧抽屉，放大封顶 70% |
| Scope | 当前题 + 同卡 content | 整张卡片 content |
| 错题本 | 打开即入（source='discuss'） | 不入 |
| 历史锚 | main_error_books.dialogue_id | ai_dialogues(student_id, card_id, track='mainline') |
| 端点 | POST /api/practice/discuss | POST /api/practice/discuss-card |
| 流式 | POST /api/ai/tutor/stream (mode=mainline) | 同上 |

---

*2026-08-10 更新：按用户最终确认（抽屉形态 + 历史续接 B方案）重写本文档。*
