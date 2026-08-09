# 课堂练习「提示」AI 生成 + Card 级缓存

## 背景与需求
`AnswerModal` 的「提示」按钮当前只显示一段**静态占位文本**（`AnswerModal.tsx:191-197`），不调 AI、不复用。

需求：
1. 点提示时，先查 **Card 是否已存过该题的提示** → 有则直接用（不调 AI）
2. 没有则**调 AI 生成**苏格拉底式提示（只启发、不给答案，遵循 CLAUDE.md 规则 6 Socratic 原则）
3. 把生成的提示**写回 Card 的提示记录**，供后续复用（跨学生 / 跨会话共享——同一题对所有人都用同一提示，省 AI）

## 存储（DB）
- 实际库 `cards` 表结构已确认：只有 `content_metadata`，无任何提示字段、无 hint 表。
- **`cards` 表新增 `hints` 字段**（`TEXT`，nullable，存 JSON 字符串——与同表 `content_metadata` 一致，JS 读改写）。
  - 结构：`{ "<题目文本>": "<提示文本>", ... }`
  - **key = 题目文本**（即「题目标题」，与 judge 流程传的 `questionText` 一致，自洽；JSON 长 key 可行，同一题文本始终命中）
  - value = AI 提示
- 迁移 SQL：`ALTER TABLE cards ADD COLUMN hints TEXT NULL DEFAULT NULL AFTER content_metadata;`（cards 表已有 `updated_at` 触发器，写回时自动更新，无需新增触发器）
- 同步更新 `tools/db/schema.sql` 的 cards 建表语句（加 `hints` 列）

## 后端（apps/server）

### ai-core 新增 hint capability（镜像 ExplanationCapability，最简：route→build→chat→parse text）
1. `types.ts`：`Scene` 联合加 `'hint'`；`CapabilityType` 加 `'hint'`；新增 `HintRequest { questionContent: string; subject: Subject }` / `HintResponse { content: string; reasoning?: string }`
2. 新建 `capabilities/hint.capability.ts`：构造 `PromptBuilder` + `ModelClient`（DI 可选，测试注入 mock）；`generate()` → `modelRouter.route({scene:'hint',subject})` → `promptBuilder.build({capability:'hint',subject,context:{question,userMessage:'请给我一个提示'}})` → `modelClient.chat(timeout: timeoutConfig.timeout.hint)` → `responseParser.parse({mode:'text'})` → 返回
3. 新建 `prompts/hint/math.md`：苏格拉底提示——只给方向/启发，**绝不给答案**；公式用 `$...$`（2026-08-09 约定）；K12 温和语气；简短（≤150 字）。`## System Prompt` / `## User Message` 分段
4. `infra/prompt-builder.ts` `resolveTemplatePath`：加 `if (capability==='hint') return hint/${subject}.md;`
5. `model-routes.yaml`：加 `hint` 场景（math: primary `deepseek-v4-flash`，fallback `qwen3.7-max`——提示是轻量任务，用快模型，同 judgment/grading）
6. `retry.yaml`：加 `hint: 45000` timeout

### practice 模块新增 hint 端点
7. `database/repositories/cards.repo.ts`：新增
   - `findHintsById(cardId): Promise<string | null>`（`SELECT hints FROM cards WHERE id=?`）
   - `upsertHint(cardId, key, value)`：读 `hints` 文本 → `JSON.parse`（null→`{}`）→ `obj[key]=value` → `JSON.stringify` → `UPDATE cards SET hints=? WHERE id=?`（读改写；并发偶发覆盖可接受，结果幂等，MVP 不加行锁）
8. `modules/practice/practice.service.ts`：新增 `getHint(input)`：
   - 读 `card.hints` → 命中 `questionText` key → `return { hint, cached: true }`
   - 未命中 → `hint.generate({questionContent, subject})` → `upsertHint` 写回 → `return { hint, cached: false }`
   - AI 失败 → 抛 `HttpException({code:5001,message:'提示生成失败，请重试'},503)`（同 judge 风格，前端降级）
   - 构造函数新增注入 `CardsRepository` + `HintCapability`
9. `modules/practice/practice.controller.ts`：新增 `@Post('hint')` → `practiceService.getHint({studentId, ...dto})`
10. `modules/practice/dto/hint-practice.dto.ts`：`{ cardId, lessonId, subjectId, questionText }`（同 judge DTO 风格）
11. `modules/practice/practice.module.ts`：providers 加 `HintCapability`、`CardsRepository`（同 `QuestionsRepository` 模式，`@Inject('DATABASE_POOL')` 由全局 DatabaseModule 提供）

### 测试
12. `capabilities/hint.capability.test.ts`：mock modelClient，仿 `explanation.capability.test.ts`
13. `modules/practice/practice.service.test.ts`：
    - 更新 `mk` helper 加 `cardsRepo` + `hint` 默认 mock，所有 `new PracticeService(...)` 调用补参数
    - 加 `getHint` 用例：命中缓存不调 AI / 未命中调 AI 并写回 / AI 失败抛 503

## 前端（apps/web）
1. `services/api.ts`：加 `getPracticeHint(payload: {cardId,lessonId,subjectId,questionText}): Promise<{hint:string;cached:boolean}>`（`POST /api/practice/hint`）
2. `store/practiceStore.ts`：加 `hints: Record<string,string>`（key=前端复合题号 `q.n` 如 `"0-1"`，session 内缓存避免重复请求）+ `setHint(n,hint)`；`reset` 时清空
3. `components/business/AnswerModal.tsx`：
   - 点提示 → 查 `practiceStore.hints[q.n]`：命中直接显示；未命中抽屉显示「正在生成提示…」+ spinner → 调 `getPracticeHint` → `setHint` + 显示
   - 提示内容用 `ReactMarkdown + remarkMath + rehypeKatex` 渲染（提示可能含公式，复用文件顶部已 import 的依赖）
   - 失败态：温和降级文案兜底（不阻断答题，可用当前静态文案）
   - 切题/提交时保留已缓存提示（store 持到 session 结束）

## 文档同步（CLAUDE.md 铁律：变更代码/主文档时同步所有引用文档）
- `docs/api/openapi.yaml`：加 `/practice/hint` 端点 + `HintRequest`/`HintResult` schema
- `docs/API接口与数据流设计文档.md`：§4.16 Practice 表加 `/api/practice/hint` 行；§6 加数据流小节（点提示→查缓存→命中直返/未命中 AI 生成并写回 cards.hints）；版本日志加条目
- `tools/db/schema.sql`：cards 建表加 `hints` 列
- `CLAUDE.md`：记录本次改动（cards.hints 字段、key=题目文本、共享缓存、Socratic 提示不给答案、新 hint 场景路由）
- 本 plan 文件作为实现记录留存

## 关键决策
- **key = 题目文本**（`questionText`），非复合题号——符合「题目标题作 key」，且与 judge 流程自洽（judge 也传 questionText）
- **缓存是 Card 级共享**（不分学生）：同一题对所有人都用同一提示，最大化省 AI
- **提示遵循 Socratic 原则**（CLAUDE.md 规则 6）：只启发不给答案
- **字段类型 TEXT**（存 JSON 字符串），与同表 `content_metadata` 一致，JS 读改写，最低风险
- **失败不阻断**：AI 提示生成失败时前端降级显示静态文案，学生仍可答题

## 风险/已知限制
- upsertHint 读改写有并发窗口（两学生同时首次点同一题提示 → 都调 AI，后者覆盖前者），结果幂等仅浪费一次 AI 调用，MVP 可接受
- hints 长度无上限，理论上一卡多题提示较长，但 TEXT 足够；后续若需可加清理策略
