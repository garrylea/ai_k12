# 辅学系统：多题澄清（force-single）+ 移除 aux_error_books

> 日期：2026-08-07
> 对应设计文档：`docs/superpowers/specs/2026-08-02-auxiliary-track-design.md`

## 决策摘要

### A. 多题处理：force-single（已与用户确认）
图文多题且未指明时，AI 先问"想问哪道"；学生说"全部/都要"时，AI 回"一次只能选一道哟"**强制单选**（不逐题串行）。指明单题后走现有逻辑（苏格拉底辅导 + 内联 JSON 入库）。理由：契合苏格拉底单焦点；规避 per-dialogue `consecutive_fail_count` 跨题污染（Q1 失败 3 次后 Q2 立刻误触发 fallback）；无状态机、无需改 fallback、无需"解出"判定；仍满足"一道一道、不批量"。

### B. 移除 aux_error_books（已与用户确认）
辅学系统不需要专门错题本--历史对话记录（`ai_dialogues`+`ai_messages`，前端 `ConversationList`+对话详情）即承担"回看做过的题"的职责。PRD 本就"无需判错、无需确认"，错题本实为"遇到过的题"记录，与对话历史重复。**题库 `questions` 的入库保留**（答案/解析被剥离出展示内容，是充实共享题库的价值所在，历史里没有）。redo/clear 随之去掉（可接受；主线错题本 `main_error_books` 独立保留，服从闯关解锁门控）。

入库时机维持现状：辅导该题的首条回复内联 JSON，`parseContent` 剥离后入库。

---

## Part A — 多题澄清（仅 prompt + 文档，无代码改动）

### A1. `apps/server/src/ai-core/prompts/tutoring/math/auxiliary.md`
- 新增"多题处理"小节（"图片输入处理"之后、"辅导策略"之前）：
  - 文字/图片含多道题 + 未指明：先用**编号列表**转录各题题干（纯文本，**禁用 ` ```json ` 块**），再问"你想先看哪道题？一次只能选一道哟"，**停住**--不辅导、不出 JSON。
  - 学生回"全部/都要/都看看"等：温和拒绝，"一次只能选一道题哟，你想先看哪道？"，强制单选。
  - 学生指明某道（或首条已指明）：正常苏格拉底辅导**那一道**，按现规则输出该题结构化 JSON。
  - 解完一道后：可一句话问"还要看看其他题吗？"，但不自动进入下一道。
- 调整"结构化题目输出"措辞：仅当**开始辅导某一道具体题目**时输出；多题澄清阶段、纯概念讨论**都不输出**；同一道题只在**首条辅导回复**输出一次，后续追问轮次不重复（避免重复写 `aux_error_books`——本计划 Part B 会移除该表，此条仍有利于避免重复入库 `questions` 之外的副作用，保留指引）。
- 调整"图片输入处理"：多题用编号列表转录便于指认；单题维持原文转录；转录一律纯文本。

### A2. 文档同步
- `docs/superpowers/specs/2026-08-02-auxiliary-track-design.md`：§8.1 触发条件改为 force-single 澄清；§13 Open Question #3 结案（检测内联在辅导 LLM，多题触发澄清而非批量入库）；§14 增 force-single 决策 rationale。

---

## Part B — 移除 aux_error_books（DB + 后端 + 前端 + 文档）

### B1. 入库路径改造（核心代码改动）
`apps/server/src/modules/ai/ai.service.ts`：
- `ingestStructuredQuestion` 不再调 `errorBookService.createAuxFromStructured`；改为注入 `QuestionsRepository`，直接 `questionsRepo.findOrCreate(...)`。
- 保留：`quality !== 'poor'` 质量门控、`computeContentHash` 去重、`source='auxiliary'`。
- 去掉：`hasImage ? 'photo' : 'auxiliary'` 的 source 区分（`questions.source` 统一 `'auxiliary'`，photo/auxiliary 区分只对 aux_error_books 有意义，表已删）。
- 移除 `ErrorBookService` 注入；`AIModule` 不再 import `ErrorBookModule`，改 provision `QuestionsRepository`。

### B2. 删除 aux 错题本代码
- 删 `apps/server/src/modules/error-book/error-book.controller.ts`、`error-book.service.ts`、`error-book.module.ts`、`dto/create-aux-error.dto.ts`（整个 error-book 模块当前全是 aux，无 mainline 方法）。
- 删 `apps/server/src/database/repositories/aux-error-books.repo.ts`，并从 `repositories/index.ts` 移除导出。
- 保留：`main-error-books.repo.ts`（+test）、`error-redo-logs.repo.ts`、`variation_questions` 相关（共享表，留作 mainline）、`QuestionsRepository`、`QuestionStructuringCapability`（practice 仍用）。
- 注：mainline 错题本服务层待后续实现时基于 `MainErrorBooksRepository` 重建 `ErrorBookModule`。

### B3. DB schema
`tools/db/schema.sql`：
- 删 `CREATE TABLE aux_error_books`（~414 行）+ 触发器 `trg_aux_error_books_updated_at`（~752 行）。
- 保留 `main_error_books`、`error_redo_logs`、`variation_questions`。
- 注：无 migration 框架，开发库需手动 `DROP TABLE aux_error_books;`（在计划验收步骤注明）。

### B4. openapi + 前端
- `docs/api/openapi.yaml`：删 `/error-book/students/{studentId}/aux`(GET)、`/error-book/aux`(POST)。共享端点 `/error-book/items/{id}/redo|clear|explanation|variations` 保留（mainline 用）。
- `apps/web/src/services/api.ts`：删 `listAuxErrors`、`createAuxError` 及其类型（`AuxErrorItem` 等）。
- 前端 P4.1 `error-book` 占位 + `StudentNav` "错题本"：保留（属 mainline，未实现）。

### B5. 文档同步
- `docs/superpowers/specs/2026-08-02-auxiliary-track-design.md`：§4 数据模型删 `aux_error_books` 行；§5 删 `AuxErrorBooksRepository`/`ErrorBookService` aux 方法/`ErrorBookController` aux 端点；§8 入库流程改为"仅写 `questions`"；§9 前端删辅线错题本 Tab；§11/§14 同步。
- `docs/K12智学系统-数据库设计文档.md`：删 `aux_error_books` 表设计（§3.6-3.8 相关）。
- `docs/API接口与数据流设计文档.md`：删 aux 错题本端点（与 openapi 一致）。
- `CLAUDE.md`：更新对 `aux_error_books` / 辅线错题本的提及。

---

## 验证
- `cd apps/server && npm run build && npm test`：确认删除模块后无残留引用、编译通过、测试绿。
- `grep -rn "aux_error_books\|AuxErrorBooks\|createAuxFromStructured\|listAuxErrors" apps/ tools/ docs/`：确认仅余文档历史/无关引用。
- 开发库：`DROP TABLE aux_error_books;` 后重启服务正常。
- 手动/LLM eval（需 API Key，可选）：多题图片->问"想先看哪道"；"都要"->被拒；指明第 2 题->仅辅导并入库一道到 `questions`，无 aux_error_books 写入。

## 非目标
- 逐题串行模式（已选 force-single 替代）。
- fallback 路径输出结构化 JSON（入库在辅导首条回复，无需）。
- mainline 错题本服务层实现（保留 DB/repo，后续单独做）。
- P3.3（MinerU）移除（用户决定保留）。
