# 会话管理页（全量列表 + 搜索 + 改名 + 删除 + 相对时间）

## 背景
辅线侧栏「展开全部」当前只是内联展开前 10 条之外的会话标题（且上一轮才修好分页拉全量）。用户要求：点「展开全部」后进入一个**独立全页面**的会话管理视图，含全量列表、对话名称、距今天数、改名、删除，顶部有搜索框。已与用户确认放置方式 = 独立全页面（无侧栏），「返回答疑」回答疑页。

## 现状
- 布局 `AuxiliaryLayout`：左侧栏 `ConversationList`（前 10 条 + 「展开全部」内联 toggle）+ 右侧聊天。
- 后端 `ConversationsService`：`updateTitle` 已有 service/repo 但**未接 controller**；`archive` 只改 status 不设 `deleted_at`（列表仍显示）；**无删除端点**。schema 有 `deleted_at` 软删列，repo 查询已 `deleted_at IS NULL` 过滤。
- `ResponseInterceptor` 全局包 `{code:0,message:'ok',data}`；`fetchApi` 读 `data`。CORS 允许 5173/5174/3000；vite proxy `/api -> http://localhost:3001`。
- `AiDialogueRow` 有 `created_at: Date`、`deleted_at: Date | null`；前端 `ConversationItem.created_at: string`。
- 路由：`/student/auxiliary*` 为扁平全屏路由（不在 StudentLayout 内）。
- DTO 是简单 `interface` + `@Body()`（非 class-validator）。

## 方案

### 后端
1. **Repo `ai-dialogues.repo.ts`：加 `softDelete(id)`**
   ```ts
   async softDelete(id: number): Promise<void> {
     await this.pool.execute(
       `UPDATE ai_dialogues SET deleted_at = NOW() WHERE id = ?`,
       [id],
     );
   }
   ```
   软删，复用现有 `deleted_at IS NULL` 过滤（列表/`findById` 自动排除）。
2. **Service `conversations.service.ts`：加 `delete(id, studentId)`** + `updateTitle` 加非空校验
   - `delete`：`await this.get(id, studentId)`（ownership）+ `this.dialoguesRepo.softDelete(id)`。
   - `updateTitle`：title 空/trim 后空 -> 抛 `BadRequestException({code:1001, message:'title 不能为空'})`；超长（>100）同理。
3. **DTO `dto/update-title.dto.ts`（新）**：`export interface UpdateTitleDto { title: string }`。
4. **Controller `conversations.controller.ts`：加两个端点**
   - imports 补 `Patch, Delete`。
   - `@Patch(':dialogueId')` -> `updateTitle(id, user.sub, dto.title)`，返回 `{ ok: true }`。
   - `@Delete(':dialogueId')` -> `delete(id, user.sub)`，返回 `{ ok: true }`。
   - 复用 `ParseIntPipe` / `JwtAuthGuard` / `CurrentUser`。

### 前端
5. **`services/api.ts`：加两个函数**
   ```ts
   export function renameConversation(id: number, title: string): Promise<void> {
     return fetchApi<void>(`/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) });
   }
   export function deleteConversation(id: number): Promise<void> {
     return fetchApi<void>(`/conversations/${id}`, { method: 'DELETE' });
   }
   ```
6. **`store/auxiliaryStore.ts`：加 `updateConversationTitle(id, title)`、`removeConversation(id)`**（原地改 store，侧栏与管理页同步，免重拉）。
7. **新页面 `pages/student/ConversationManagePage.tsx`**
   - 全屏，`data-theme="student-day" data-school="junior"`，`Bg-Page #F5F0E8` 暖米白，居中大圆角白卡（类 `AuxiliaryLayout` 风格、柔和阴影）。
   - 头部：「← 返回答疑」(`navigate('/student/auxiliary')`) + 标题「会话管理」。
   - 搜索框：`base/Input`（leading 放大镜 SVG），按标题子串客户端过滤。
   - 列表：mount 时若 store 空则 `listAllConversations('auxiliary')` 拉全量并 `setConversations`；否则直接用 store。每行 = 标题（可内联编辑）+ 相对时间 + 改名按钮 + 删除按钮。线性 SVG 图标，**无 emoji**。
   - 改名：点「改」-> 行内 input + 保存/取消；保存调 `renameConversation` + `updateConversationTitle`；失败 toast/内联提示。
   - 删除：`window.confirm` 二次确认 -> `deleteConversation` + `removeConversation`；若删的是 `currentDialogueId`，清空 `setCurrentDialogueId(null)` + `useChatStore.reset()`（返回答疑即新会话态）。
   - 加载/错误/空态。
8. **路由 `routes/index.tsx`**：加 `{ path: '/student/auxiliary/conversations', element: <ConversationManagePage /> }`（扁平全屏，与其它 auxiliary 路由一致）。
9. **`components/business/ConversationList.tsx`：改造「展开全部」**
   - 去掉 `expanded` 内联 toggle 与 `slice(0,10)` 切换；侧栏固定前 10 条快切。
   - 按钮改为 `navigate('/student/auxiliary/conversations')`。
   - 显示条件 `conversations.length > 0`（始终可进管理页做搜索/改名/删除，不限于 >10）。
   - 文案改为「会话管理」（点进去是管理页，比「展开全部」准确）；如你坚持可保留「展开全部」。
10. **相对时间工具 `utils/time.ts`（新）**：`relativeTime(iso: string): string` —— `<60s 刚刚` / `<60min X分钟前` / `<24h X小时前` / `<30d X天前` / else `YYYY-MM-DD`。注：脚本侧不能用 `Date.now()`，但这是前端运行时代码，正常用 `Date`。

### 文档同步（CLAUDE.md API 同步规则）
11. `docs/API接口与数据流设计文档.md` §4 端点清单 + §6 数据流：补 `PATCH /api/conversations/{dialogueId}`（改名）、`DELETE /api/conversations/{dialogueId}`（软删）。
12. `docs/api/openapi.yaml`：补这两个端点的 path/parameters/requestBody/responses（MVP 阶段）。
13. `docs/UX-UI设计文档.md` §辅轨：补「会话管理页」描述（独立全页面、搜索、列表字段、改名/删除、返回答疑）。

## 不做 / 取舍
- 硬删（物理 DELETE）不做，用软删 `deleted_at`（可恢复，契合现有过滤）。
- 搜索仅标题子串 + 客户端过滤（全量已在前端，无需后端搜索端点）。
- 改名用行内编辑，不弹窗。
- 删除二次确认用 `window.confirm`（MVP；后续可换 base `Modal`）。
- 不动 `archive` 既有逻辑（与软删语义不同）。
- 「展开全部」内联展开能力移除（被管理页取代）；侧栏回归「前 10 条快切 + 管理入口」。

## 文件清单
- 后端：`ai-dialogues.repo.ts`(+softDelete)、`conversations.service.ts`(+delete, updateTitle 校验)、`conversations.controller.ts`(+Patch/Delete)、`dto/update-title.dto.ts`(新)。
- 前端：`services/api.ts`(+rename/delete)、`store/auxiliaryStore.ts`(+updateTitle/remove)、`pages/student/ConversationManagePage.tsx`(新)、`routes/index.tsx`(+路由)、`components/business/ConversationList.tsx`(改造按钮)、`utils/time.ts`(新)。
- 文档：`docs/API接口与数据流设计文档.md`、`docs/api/openapi.yaml`、`docs/UX-UI设计文档.md` 同步。

## 验证
- 后端 `npm run build`(tsc) + `npm test`(vitest) 不回归。
- 前端 `npx tsc --noEmit` 通过。
- 实测：侧栏点「会话管理」-> 进全页面，看到全量列表 + 相对时间；搜索过滤；行内改名生效且侧栏同步；删除二次确认后列表消失，删当前会话后返回答疑为新会话态；返回答疑后侧栏列表与改名/删除一致。
