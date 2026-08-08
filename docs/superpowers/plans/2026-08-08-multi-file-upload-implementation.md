# 多文件上传实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为辅学答疑扩展多文件上传能力——支持图片（PNG/JPEG/HEIC）、文本文件（TXT/MD）、PDF，通过拖拽或 + 按钮上传，PDF 经 MinerU 提取后通过 SSE 通知前端。

**Architecture:** 前端 AuxInputBar 重构文件状态机为统一 `FileState`，新增 + 按钮和小飞机/停止图标。后端 FilesService 对 PDF 自动启动 Refinery 提取，RefineryService 新增 EventEmitter + SSE 端点（复用 ai.controller.ts 的 `@Res()` 手动 SSE 模式）。AIService.resolveAttachments 扩展处理 text/pdf 类型，TutoringCapability 将提取文本拼入 prompt。

**Tech Stack:** React + TypeScript (前端)，NestJS + EventEmitter + `@Res()` SSE (后端)，MinerU CLI (PDF 提取)，遵循现网代码模式。

**Design Spec:** `docs/superpowers/specs/2026-08-08-multi-file-upload-design.md`

---

### Task 1: ai-core + DTO 类型扩展

**Files:**
- Modify: `apps/server/src/ai-core/types.ts:383-389`
- Modify: `apps/server/src/modules/ai/dto/tutor.dto.ts:1-4`

- [ ] **Step 1: 扩展 ai-core Attachment 类型**

在 `types.ts` 中修改 `Attachment` 接口，新增 `extractedText`、`extractedImages` 字段，`type` 新增 `'file'`：

```typescript
export interface Attachment {
  type: 'image' | 'file';
  url: string;
  imageUrl?: string;          // base64 data URL for multimodal LLM input (image only)
  extractedText?: string;     // text content for txt/md/pdf attachments
  extractedImages?: string[]; // PDF extracted image paths (for routing to multimodal model)
  fileId?: string;
}
```

- [ ] **Step 2: 扩展 TutorAttachment DTO**

在 `tutor.dto.ts` 中修改 `TutorAttachment` 接口，新增 `taskId`：

```typescript
export interface TutorAttachment {
  type: 'image' | 'file';
  fileId: string;
  taskId?: number;  // PDF extraction task ID (from RefineryService.createTask)
}
```

- [ ] **Step 3: 构建验证**

```bash
cd apps/server && npx tsc --noEmit
```

Expected: 编译通过（新增字段为可选，不破坏现有代码）。

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/ai-core/types.ts apps/server/src/modules/ai/dto/tutor.dto.ts
git commit -m "feat: extend Attachment and TutorAttachment types for multi-file support

- Attachment.type now includes 'file' for txt/md/pdf
- Added extractedText and extractedImages fields for file content
- TutorAttachment now includes optional taskId for PDF extraction

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: 前端 api.ts 类型扩展 + streamExtraction SSE 函数

**Files:**
- Modify: `apps/web/src/services/api.ts:258-286`

- [ ] **Step 1: 扩展 AttachmentRequest 类型**

找到 `AttachmentRequest` 接口（约第 260 行），改为：

```typescript
export interface AttachmentRequest {
  type: 'image' | 'file';
  fileId: string;
  taskId?: number;  // PDF extraction task ID
}
```

- [ ] **Step 2: 新增 streamExtraction SSE 函数**

在 `api.ts` 中 `extract()` 函数附近（约第 290 行之后），新增：

```typescript
// SSE 监听 MinerU 提取结果（替代轮询 GET /api/refinery/tasks/:taskId）
export async function* streamExtraction(
  taskId: number,
  signal?: AbortSignal,
): AsyncIterable<{ type: 'done' | 'error'; message?: string }> {
  const token = localStorage.getItem('token') ?? '';
  const res = await fetch(`${API_BASE}/refinery/tasks/${taskId}/stream`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal,
  });
  if (!res.ok || !res.body) throw new Error('extraction stream unavailable');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ') || trimmed === 'data: [DONE]') continue;
      try {
        yield JSON.parse(trimmed.slice(6));
      } catch {
        // skip non-JSON lines
      }
    }
  }
}
```

- [ ] **Step 3: 前端构建验证**

```bash
cd apps/web && npx tsc --noEmit
```

Expected: 编译通过。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/services/api.ts
git commit -m "feat: extend AttachmentRequest type and add streamExtraction SSE function

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: RefineryService EventEmitter + SSE 端点

**Files:**
- Modify: `apps/server/src/modules/refinery/refinery.service.ts:1-10,80-90`
- Modify: `apps/server/src/modules/refinery/refinery.controller.ts:1-26`

- [ ] **Step 1: RefineryService 添加 EventEmitter**

在 `refinery.service.ts` 顶部添加 import：

```typescript
import { EventEmitter } from 'node:events';
```

在 `RefineryService` 类中添加公开 `events` 属性（放在 `private readonly logger` 之后）：

```typescript
/** Events emitted: task:{taskId} -> { type: 'done' | 'error', message?: string } */
readonly events = new EventEmitter();
```

- [ ] **Step 2: runExtraction 中 emit 事件**

找到 `runExtraction` 方法中 `await this.tasksRepo.updateStatus(taskId, 'completed', ...)` 那行（约第 79 行），在更新成功后添加 emit：

```typescript
await this.tasksRepo.updateStatus(
  taskId,
  'completed',
  JSON.stringify({ markdown: result.markdown, structured }),
);
// Notify any waiting SSE subscribers
this.events.emit(`task:${taskId}`, { type: 'done' });
```

找到 `runExtraction` 的 catch 块（约第 84 行），在 `updateStatus(taskId, 'failed', ...)` 后添加 emit：

```typescript
await this.tasksRepo.updateStatus(taskId, 'failed', undefined, err.message);
// Notify any waiting SSE subscribers
this.events.emit(`task:${taskId}`, { type: 'error', message: (err as Error).message });
```

- [ ] **Step 3: RefineryController 新增 SSE 端点**

在 `refinery.controller.ts` 中添加 import：

```typescript
import { Res, Req } from '@nestjs/common';
import type { Response, Request } from 'express';
```

在 `RefineryController` 类中新增方法（放在 `getTask` 方法之后）：

```typescript
/**
 * SSE stream for extraction task progress.
 * Clients connect after PDF upload; the server pushes { type: 'done' }
 * when extraction completes, or { type: 'error', message } on failure.
 * Falls back to immediate response if task is already completed/failed.
 */
@Get('tasks/:taskId/stream')
async streamTask(
  @Param('taskId') taskId: string,
  @CurrentUser() user: JwtUser,
  @Req() req: Request,
  @Res() res: Response,
) {
  const taskIdNum = Number(taskId);

  // Set SSE headers (same pattern as AIController.tutorStream)
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  // Check current status (also verifies task exists and belongs to user)
  const task = await this.refineryService.getTask(taskIdNum, user.sub);
  if (task.status === 'completed') {
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  if (task.status === 'failed') {
    res.write(`data: ${JSON.stringify({ type: 'error', message: task.errorMessage ?? '提取失败' })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  // Subscribe to EventEmitter for pending/processing tasks
  const eventKey = `task:${taskIdNum}`;
  const handler = (event: { type: string; message?: string }) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  };
  this.refineryService.events.once(eventKey, handler);

  // Timeout after 120s (matches MinerU CLI timeout)
  const timeout = setTimeout(() => {
    res.write(`data: ${JSON.stringify({ type: 'error', message: '提取超时' })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    this.refineryService.events.off(eventKey, handler);
  }, 120_000);

  // Client disconnect cleanup
  res.on('close', () => {
    clearTimeout(timeout);
    this.refineryService.events.off(eventKey, handler);
  });
}
```

- [ ] **Step 4: 构建验证**

```bash
cd apps/server && npx tsc --noEmit
```

Expected: 编译通过。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/refinery/refinery.service.ts apps/server/src/modules/refinery/refinery.controller.ts
git commit -m "feat: add EventEmitter to RefineryService and SSE extraction endpoint

- RefineryService now emits task:{id} events on extraction complete/fail
- New GET /api/refinery/tasks/:taskId/stream SSE endpoint
- Follows same @Res() manual SSE pattern as AIController.tutorStream
- Respects task ownership via JWT + student ID check

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: FilesService PDF 自动提取

**Files:**
- Modify: `apps/server/src/modules/files/files.service.ts:1-41`
- Modify: `apps/server/src/modules/files/files.module.ts:1-11`

- [ ] **Step 1: FilesService 注入 RefineryService**

在 `files.service.ts` 中：

```typescript
import { Injectable } from '@nestjs/common';
import { UploadedFilesRepository } from '../../database/repositories/uploaded-files.repo.js';
import { RefineryService } from '../refinery/refinery.service.js';  // 新增
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface UploadedFileResult {
  fileId: number;
  url: string;
  taskId?: number;  // 新增：PDF extraction task ID
}

@Injectable()
export class FilesService {
  private readonly storageDir = process.env.UPLOAD_DIR ?? './uploads';

  constructor(
    private readonly filesRepo: UploadedFilesRepository,
    private readonly refineryService: RefineryService,  // 新增
  ) {}
```

- [ ] **Step 2: upload 方法中检测 PDF 并启动提取**

修改 `upload` 方法的返回逻辑（DB insert 之后），添加 PDF 检测：

```typescript
async upload(file: Express.Multer.File, uploaderId: number, source: string): Promise<UploadedFileResult> {
  const ext = path.extname(file.originalname);
  const key = `${source}/${randomUUID()}${ext}`;
  const dest = path.join(this.storageDir, key);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, file.buffer);

  try {
    const fileId = await this.filesRepo.create({
      uploader_id: uploaderId,
      uploader_type: 'student',
      url: `/uploads/${key}`,
      mime_type: file.mimetype,
      size_bytes: file.size,
      source,
    });

    // Auto-start PDF extraction via Refinery
    let taskId: number | undefined;
    if (file.mimetype === 'application/pdf') {
      taskId = await this.refineryService.createTask(fileId, uploaderId, source);
    }

    return { fileId, url: `/uploads/${key}`, taskId };
  } catch (err) {
    await fs.unlink(dest).catch(() => {});
    throw err;
  }
}
```

- [ ] **Step 3: FilesModule 导入 RefineryModule**

在 `files.module.ts` 中：

```typescript
import { Module } from '@nestjs/common';
import { FilesController } from './files.controller.js';
import { FilesService } from './files.service.js';
import { UploadedFilesRepository } from '../../database/repositories/uploaded-files.repo.js';
import { RefineryModule } from '../refinery/refinery.module.js';  // 新增

@Module({
  imports: [RefineryModule],  // 新增
  controllers: [FilesController],
  providers: [FilesService, UploadedFilesRepository],
  exports: [FilesService],
})
export class FilesModule {}
```

- [ ] **Step 4: 更新 FilesController 响应类型**

`files.controller.ts` 中 `upload` 方法的返回类型自动推断，无需改动。`UploadedFileResult` 接口已扩展 `taskId?`，TypeScript 自动兼容。

- [ ] **Step 5: 构建验证**

```bash
cd apps/server && npx tsc --noEmit
```

Expected: 编译通过。注意循环依赖问题——RefineryModule 和 FilesModule 都是独立模块，RefineryModule 不 import FilesModule，所以不会循环。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/files/files.service.ts apps/server/src/modules/files/files.module.ts
git commit -m "feat: auto-start PDF extraction on file upload

- FilesService.upload now detects PDF mime type and auto-creates Refinery task
- Returns taskId in upload response for SSE subscription
- FilesModule imports RefineryModule (no circular dep - RefineryModule doesn't import FilesModule)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: AIService.resolveAttachments 扩展 + TutoringCapability 文本注入

**Files:**
- Modify: `apps/server/src/modules/ai/ai.service.ts:136-177,179-190`
- Modify: `apps/server/src/modules/ai/ai.module.ts:1-37`
- Maybe modify: `apps/server/src/ai-core/capabilities/tutoring.capability.ts`

- [ ] **Step 1: 注入 ExtractTasksRepository**

在 `ai.module.ts` 中添加 `ExtractTasksRepository` provider。

先确认 export 路径——检查 `database/repositories/index.ts` 是否 export 了 `ExtractTasksRepository`：

```bash
grep -n "ExtractTasksRepository" apps/server/src/database/repositories/index.ts
```

如果已 export，在 `ai.module.ts` providers 数组中添加 `ExtractTasksRepository`：

```typescript
import { ExtractTasksRepository } from '../../database/repositories/index.js';  // 或 extras/extract-tasks.repo
// ...
providers: [
  // ... existing providers ...
  ExtractTasksRepository,  // 新增：PDF extraction result lookup
  // ...
],
```

- [ ] **Step 2: AIService 注入 ExtractTasksRepository**

在 `ai.service.ts` 构造函数参数中添加：

```typescript
import { ExtractTasksRepository } from '../../database/repositories/index.js';  // 顶部 import

constructor(
  private readonly tutoring: TutoringCapability,
  private readonly conversationsService: ConversationsService,
  private readonly filesRepo: UploadedFilesRepository,
  private readonly subjectsRepo: SubjectsRepository,
  private readonly questionsRepo: QuestionsRepository,
  private readonly extractTasksRepo: ExtractTasksRepository,  // 新增
) {}
```

- [ ] **Step 3: 修改 resolveAttachments 方法**

找到 `resolveAttachments` 方法（约第 136 行），将整个方法替换为：

```typescript
private async resolveAttachments(dto: TutorDto, userId: number): Promise<Attachment[]> {
  const attachments: Attachment[] = [];
  if (!dto.attachments || dto.attachments.length === 0) return attachments;

  const uploadDir = process.env.UPLOAD_DIR ?? './uploads';
  for (const att of dto.attachments) {
    const fileIdNum = Number(att.fileId);
    if (!Number.isFinite(fileIdNum)) {
      throw new BadRequestException({ code: 1001, message: 'attachment.fileId 必须为数字' });
    }
    const fileRow = await this.filesRepo.findByIdAndOwner(fileIdNum, userId);
    if (!fileRow) {
      throw new BadRequestException({ code: 1001, message: '文件不存在或无权访问' });
    }

    // --- image type: existing behavior (base64 data URL) ---
    if (att.type === 'image') {
      if (!fileRow.mime_type.startsWith('image/')) {
        throw new BadRequestException({ code: 1001, message: '附件必须是图片' });
      }
      if (fileRow.size_bytes > this.MAX_IMAGE_BYTES) {
        throw new BadRequestException({ code: 1001, message: '图片过大（最大 5MB）' });
      }
      const storageKey = fileRow.url.replace(/^\/uploads\//, '');
      const filePath = path.join(uploadDir, storageKey);
      let base64: string;
      try {
        base64 = fs.readFileSync(filePath).toString('base64');
      } catch {
        throw new BadRequestException({ code: 1001, message: `文件读取失败: ${att.fileId}` });
      }
      const dataUrl = `data:${fileRow.mime_type};base64,${base64}`;
      attachments.push({
        type: 'image',
        url: fileRow.url,
        imageUrl: dataUrl,
        fileId: att.fileId,
      });
      continue;
    }

    // --- file type: txt/md/pdf ---
    if (att.type === 'file') {
      if (fileRow.mime_type.startsWith('text/') || fileRow.mime_type === 'text/markdown') {
        // TXT/MD: read file content as UTF-8 text
        const storageKey = fileRow.url.replace(/^\/uploads\//, '');
        const filePath = path.join(uploadDir, storageKey);
        let text: string;
        try {
          text = fs.readFileSync(filePath, 'utf-8');
        } catch {
          throw new BadRequestException({ code: 1001, message: `文件读取失败: ${att.fileId}` });
        }
        attachments.push({
          type: 'file',
          url: fileRow.url,
          extractedText: text,
          fileId: att.fileId,
        });
        continue;
      }

      if (fileRow.mime_type === 'application/pdf') {
        // PDF: read MinerU extraction result from extract_tasks
        if (!att.taskId) {
          throw new BadRequestException({ code: 1001, message: 'PDF 附件缺少 taskId' });
        }
        const task = await this.extractTasksRepo.findById(att.taskId);
        if (!task || task.student_id !== userId) {
          throw new BadRequestException({ code: 1001, message: '提取任务不存在或无权访问' });
        }
        if (task.status !== 'completed' || !task.result) {
          throw new BadRequestException({ code: 1001, message: 'PDF 尚未提取完成，请稍后再试' });
        }
        const result = JSON.parse(task.result) as { markdown: string; structured: unknown };
        attachments.push({
          type: 'file',
          url: fileRow.url,
          extractedText: result.markdown,
          fileId: att.fileId,
        });
        continue;
      }

      throw new BadRequestException({ code: 1001, message: '不支持的文件类型' });
    }

    throw new BadRequestException({ code: 1001, message: `未知附件类型: ${(att as any).type}` });
  }
  return attachments;
}
```

- [ ] **Step 4: 修改 TutoringCapability 以支持文本附件**

读取 `tutoring.capability.ts` 中找到 `buildPrompt` 或构建 user message 的位置。在构建 `TutoringRequest` 的 user message 时，检测 `attachments` 中的 `type === 'file'` 项，将 `extractedText` 拼入消息内容。

先确认 tutoring.capability.ts 的关键方法签名：

```bash
grep -n "buildPrompt\|userMessage\|message" apps/server/src/ai-core/capabilities/tutoring.capability.ts | head -20
```

Expected output 会显示构建 user message 的位置。在此处添加附件文本拼接逻辑（示例）：

```typescript
// 在构建 user message 的位置，拼接文本附件内容
let userMessage = request.message;
const fileAttachments = request.attachments?.filter(a => a.type === 'file' && a.extractedText) ?? [];
for (const fa of fileAttachments) {
  userMessage += `\n\n---\n附件内容：\n${fa.extractedText}`;
}
```

注意：需要读实际的 `tutoring.capability.ts` 文件以确定精确的插入位置和变量名。

- [ ] **Step 5: 构建验证**

```bash
cd apps/server && npx tsc --noEmit
```

Expected: 编译通过。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/ai/ai.service.ts apps/server/src/modules/ai/ai.module.ts apps/server/src/ai-core/capabilities/tutoring.capability.ts
git commit -m "feat: handle file attachments in AIService and TutoringCapability

- resolveAttachments now handles type:'file' for txt/md/pdf
- TXT/MD: reads file as UTF-8 and includes as extractedText
- PDF: reads MinerU result from extract_tasks by taskId
- TutoringCapability appends extractedText to user message
- AIModule now provides ExtractTasksRepository

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: 前端 AuxInputBar 重构

**Files:**
- Modify: `apps/web/src/components/business/AuxInputBar.tsx` (完全重构)

这是本计划最大的改动。需要先完整读取现网文件以确保不丢失现有功能。

- [ ] **Step 1: 读取现网文件**

```bash
wc -l apps/web/src/components/business/AuxInputBar.tsx
```

- [ ] **Step 2: 重写 AuxInputBar**

现网文件 272 行，重构要点：

1. **状态统一**：用单一 `FileState | null` 替代 `imageStatus` + `pendingAttachment`
2. **文件分类函数**：`getFileCategory(file: File): 'image' | 'text' | 'pdf'`
3. **+ 按钮**：添加隐藏 `<input type="file">`，点击时触发
4. **文件预览区**：根据 `fileType` 显示缩略图/文档图标/PDF 图标
5. **发送/停止图标**：小飞机 SVG + 停止 SVG 替代文字按钮
6. **拖拽/粘贴**：扩展 `accept` 范围
7. **PDF SSE**：上传后连接 `streamExtraction`，超时 120s

完整的重构代码涉及~300+ 行，为确保正确性，采用以下步骤：

先写新文件（保留所有现有功能 + 新增功能），再替换。

关键代码片段——**+ 按钮 + 隐藏 file input**：

```tsx
// Hidden file input ref
const fileInputRef = useRef<HTMLInputElement>(null);

// In JSX, near the send button:
<input
  ref={fileInputRef}
  type="file"
  className="hidden"
  accept="image/png,image/jpeg,image/heic,.txt,.md,.pdf"
  onChange={(e) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    e.target.value = ''; // allow re-selecting same file
  }}
/>

<button
  type="button"
  onClick={() => fileInputRef.current?.click()}
  aria-label="添加文件"
  className="w-7 h-7 rounded-full border border-[#E5E5E5] text-[#86868B] flex items-center justify-center hover:border-[#FF6B00] hover:text-[#FF6B00] transition"
>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3.5 h-3.5">
    <path d="M12 5v14M5 12h14" />
  </svg>
</button>
```

关键代码片段——**发送小飞机图标**：

```tsx
{isStreaming ? (
  <button
    type="button"
    onClick={onStop}
    aria-label="停止生成"
    className="w-9 h-9 rounded-lg bg-[#86868B] text-white flex items-center justify-center hover:opacity-90 transition"
  >
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
      <rect x="6" y="6" width="12" height="12" rx="1" />
    </svg>
  </button>
) : (
  <button
    type="button"
    disabled={!canSend}
    onClick={doSend}
    aria-label="发送"
    className="w-9 h-9 rounded-lg bg-[#FF6B00] text-white flex items-center justify-center disabled:opacity-50 hover:opacity-90 transition"
  >
    {fileState?.status === 'extracting' ? (
      <svg viewBox="0 0 24 24" fill="none" className="w-4 h-4 animate-spin">
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
        <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
    ) : (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
        <path d="M22 2L11 13" />
        <path d="M22 2L15 22L11 13L2 9L22 2Z" />
      </svg>
    )}
  </button>
)}
```

关键代码片段——**文件预览区**：

```tsx
{fileState && (
  <div className="flex items-center gap-3 p-2 border-b border-[#E5E5E5]">
    {/* Thumbnail / icon */}
    {fileState.fileType === 'image' ? (
      <img src={fileState.url} alt="预览" className="w-12 h-12 object-cover rounded-lg flex-shrink-0" />
    ) : fileState.fileType === 'pdf' ? (
      <div className="w-12 h-12 rounded-lg bg-[#F5F0E8] flex items-center justify-center flex-shrink-0">
        <svg viewBox="0 0 24 24" fill="none" stroke="#FF6B00" strokeWidth="1.5" className="w-6 h-6">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
          <path d="M8 13h8M8 17h8" />
        </svg>
      </div>
    ) : (
      <div className="w-12 h-12 rounded-lg bg-[#F5F0E8] flex items-center justify-center flex-shrink-0">
        <svg viewBox="0 0 24 24" fill="none" stroke="#86868B" strokeWidth="1.5" className="w-6 h-6">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6M16 13H8M16 17H8" />
        </svg>
      </div>
    )}
    {/* File name + status */}
    <div className="flex-1 min-w-0">
      <p className="text-sm text-[#1D1D1F] truncate">{fileState.fileName}</p>
      <p className="text-xs text-[#86868B]">
        {fileState.status === 'converting' && '转换中...'}
        {fileState.status === 'uploading' && '上传中...'}
        {fileState.status === 'extracting' && '提取中...'}
        {fileState.status === 'ready' && '已就绪'}
        {fileState.status === 'error' && (fileState.errorMsg || '失败')}
      </p>
    </div>
    {/* Remove button */}
    <button
      onClick={() => setFileState(null)}
      aria-label="移除文件"
      className="px-2 py-1 rounded-lg text-sm text-[#86868B] hover:text-[#1D1D1F] transition"
    >
      移除
    </button>
  </div>
)}
```

关键代码片段——**doSend 适配 file 类型**：

```tsx
const doSend = useCallback(() => {
  const trimmed = text.trim();
  const ready = fileState?.status === 'ready';
  if (!trimmed && !ready) return;
  if (isStreaming) return;

  let attachments: AttachmentRequest[] | undefined;
  let images: string[] | undefined;

  if (ready && fileState) {
    const req: AttachmentRequest = {
      type: fileState.fileType === 'image' ? 'image' : 'file',
      fileId: fileState.fileId,
    };
    if (fileState.taskId) req.taskId = fileState.taskId;
    attachments = [req];
    if (fileState.fileType === 'image') {
      images = [fileState.url];
    }
  }

  onSend(trimmed, attachments, images);

  // Clear
  setText('');
  setFileState(null);
}, [text, fileState, isStreaming, onSend]);
```

- [ ] **Step 3: 前端构建验证**

```bash
cd apps/web && npx tsc --noEmit
```

Expected: 编译通过。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/business/AuxInputBar.tsx
git commit -m "feat: refactor AuxInputBar for multi-file upload support

- Unified file state machine replaces imageStatus + pendingAttachment
- + button with hidden file input for selecting any supported type
- Send button now uses airplane SVG icon; stop uses square icon
- File preview adapts to type: image thumbnail / document icon / PDF icon
- Drag-drop and paste extended to accept txt/md/pdf
- PDF extraction: SSE streamExtraction with 120s timeout and spinner
- Single file enforced: new file replaces previous

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: 前端 useAuxChat 适配

**Files:**
- Modify: `apps/web/src/hooks/useAuxChat.ts:185-228`

- [ ] **Step 1: send() 透传 taskId**

`useAuxChat` 的 `send` 函数已经接收 `attachments?: AttachmentRequest[]`，而 `AttachmentRequest` 已在 Task 2 扩展了 `taskId` 字段。`send` 函数直接将 `attachments` 传给 `streamTutor`/`fallbackToRest`，它们将其序列化为 JSON body 发给 `/api/ai/tutor/stream`。

关键检查：`streamTutor` 中 `body: JSON.stringify({ ..., attachments })` 是否将 `taskId` 正确序列化——`JSON.stringify` 会跳过 `undefined` 值，所以非 PDF 文件的 `taskId: undefined` 不会被发送。这是正确的行为。

**验证**：`useAuxChat.ts` 本身无需修改（已有正确的透传逻辑）。但需要检查确认 Signature：

```typescript
// AuxInputBar onSend callback signature (from useAuxChat):
const send = useCallback(
  async (content: string, attachments?: AttachmentRequest[], images?: string[]) => {
    // ... existing logic forwards attachments to streamTutor/fetch ...
  },
  [...],
);
```

AuxInputBar 的 `onSend` props 类型也需要更新（Task 6 中已通过 `AttachmentRequest` 类型完成）。

- [ ] **Step 2: 确认无改动后的构建验证**

```bash
cd apps/web && npx tsc --noEmit
```

Expected: 编译通过（类型自动兼容）。

- [ ] **Step 3: Commit**

```bash
# useAuxChat.ts 无改动，但 AuxInputBar.tsx 的 onSend props 在 Task 6 已更新
# 如果 useAuxChat 确实无改动，标记为已完成：
git commit --allow-empty -m "chore: verify useAuxChat compatibility with new AttachmentRequest

No changes needed - send() already transparently forwards attachments including taskId.
Verified types are compatible after Task 2 AttachmentRequest extension.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: 构建验证与功能测试

**Files:**
- 所有已修改文件

- [ ] **Step 1: 后端编译 + 测试**

```bash
cd apps/server && npx tsc --noEmit && npm test
```

Expected: tsc 通过，所有现有测试绿（72 tests）。EventEmitter 改动不影响现有测试（无新方法调用签名变更）。

- [ ] **Step 2: 前端编译**

```bash
cd apps/web && npx tsc --noEmit
```

Expected: 编译通过。

- [ ] **Step 3: 手动功能验证清单**

启动服务后验证：

- [ ] 图片上传：拖拽/粘贴/点+选图片 → 缩略图预览 → 发送 → LLM 正常回复
- [ ] TXT 上传：点+选 .txt → 文档图标预览 → 发送 → 内容拼接正确
- [ ] MD 上传：点+选 .md → 文档图标预览 → 发送 → 内容拼接正确
- [ ] PDF 上传：点+选 .pdf → PDF 图标 + "提取中..." → spinner → "已就绪" → 发送
- [ ] PDF 超时（如果可能）：模拟 MinerU 挂起 → 120s 后 toast "提取超时"
- [ ] 不支持格式：选不支持的文件 → toast "不支持的文件格式"
- [ ] 单文件替换：已有文件时再选新文件 → 旧文件被替换
- [ ] 移除文件：点「移除」→ 文件预览消失
- [ ] HEIC 图片：拖入 HEIC → 转换 → 上传 → 发送正常
- [ ] 纯文本发送：不选文件，输入文字 → 发送正常（不退化）

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: verify build and tests pass after multi-file upload changes

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: 文档同步

**Files:**
- Modify: `docs/superpowers/specs/2026-08-02-auxiliary-track-design.md`
- Modify: `docs/api/openapi.yaml`
- Modify: `docs/API接口与数据流设计文档.md`

- [ ] **Step 1: 同步辅助系统设计文档**

在 `2026-08-02-auxiliary-track-design.md` 中：
- §3.1 高层组件图：更新文件上传通道描述（图片 → 图片+文本+PDF）
- §8 输入交互：更新支持的文件类型列表
- §14 Change Log 或末尾：添加本次变更记录

具体修改内容需读取目标文档后精确定位。

- [ ] **Step 2: 同步 openapi.yaml**

在 `openapi.yaml` 中：

1. 更新 `POST /api/files/upload` 的响应 schema，添加 `taskId` 可选字段
2. 新增 `GET /api/refinery/tasks/{taskId}/stream` SSE 端点定义
3. 更新 `POST /api/ai/tutor` 和 `POST /api/ai/tutor/stream` 的 `TutorAttachment` schema，`type` 枚举加 `'file'`，加 `taskId` 可选字段

- [ ] **Step 3: 同步 API 设计文档**

在 `API接口与数据流设计文档.md` 中：
- §4 端点清单：添加新端点 `GET /api/refinery/tasks/{taskId}/stream`
- §6 数据流：添加 PDF 上传→提取→SSE 通知时序
- 更新附件类型定义

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-08-02-auxiliary-track-design.md docs/api/openapi.yaml docs/API接口与数据流设计文档.md
git commit -m "docs: sync auxiliary design, openapi, and API docs with multi-file upload

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Dependency Order

```
Task 1 (types) ──┬── Task 3 (SSE) ── Task 4 (files) ── Task 5 (ai service)
                 │
                 └── Task 2 (frontend types) ── Task 6 (AuxInputBar) ── Task 7 (useAuxChat)
                                                                              │
                 Task 8 (build/test) ◄────────────────────────────────────────┘
                 Task 9 (docs)
```

可以并行的两组：
- **Backend track**: Task 1 → Task 3 → Task 4 → Task 5
- **Frontend track**: Task 2 → Task 6 → Task 7

Task 6 在实现时需要 Task 1 的 `AttachmentRequest` 类型（已通过 Task 2 的 api.ts 扩展覆盖）。
