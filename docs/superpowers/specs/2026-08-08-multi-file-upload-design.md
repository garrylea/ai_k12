# 辅学系统：多文件上传设计

> 日期：2026-08-08
> 对应设计文档：
> - [辅学系统详细设计](./2026-08-02-auxiliary-track-design.md)
> - [多题澄清（force-single）](../plans/2026-08-07-auxiliary-multi-question-disambiguation.md)

## 1. Context & Goals

### 1.1 背景

现网辅学答疑（AuxiliaryHomePage）仅支持图片上传（粘贴/拖拽），不支持 PDF、TXT、MD 等常见文件格式。学生拍的书本/试卷常为 PDF 格式，需扩展上传能力。

### 1.2 设计目标

1. 支持图片（PNG/JPEG/HEIC）、文本文件（TXT/MD）、PDF 上传
2. 提供两种上传方式：拖拽 + 点 + 按钮选文件
3. PDF 通过 MinerU 提取为 Markdown 后再发给 LLM
4. 所有文件类型走统一流程：上传 → 预览 → SSE 通知（PDF）→ 发送
5. 限制每次只能传一个文件
6. 提取出的图片自动路由到多模态模型

### 1.3 非目标

- 多文件同时上传
- 语音、视频文件
- 修改 MinerU CLI 本身
- 修改 data-refinery 离线管线

---

## 2. Overall Flow

```
选择文件（拖拽 / +按钮）
        │
        ▼
   客户端校验（类型、大小）
        │
        ▼
   POST /api/files/upload ─── 返回 { fileId, url, taskId? }
        │
        ├── 图片/TXT/MD：立即 ready → 显示预览，可发送
        │
        └── PDF：自动提交 refinery 提取
              │
              ▼
         前端连接 GET /api/refinery/tasks/:taskId/stream (SSE)
              │
              ├── event: done  → 显示 PDF 缩略图，启用发送
              ├── event: error → Toast "提取失败，请重试"
              └── timeout 120s → Toast "提取超时，请重试"
        │
        ▼
   用户点「发送」
        │
        ▼
   POST /api/ai/tutor/stream (SSE)
        │
   attachments: [{ type, fileId, taskId? }]
        │
        ▼
   服务端 resolveAttachments():
   ├── image  → 读文件 → base64 → image_url part
   ├── txt/md → 读文件 → UTF-8 文本 → 拼入 message
   └── pdf    → 读 task.result.markdown → 拼入 message
        │
        ▼
   有图片时路由到多模态模型，纯文本走常规模型
```

---

## 3. Frontend UI Changes

### 3.1 AuxInputBar 布局调整

```
┌─────────────────────────────────────────┐
│  [文件预览区]                             │
│  ┌───────────────────────────────────┐  │
│  │  textarea                         │  │
│  │                                   │  │
│  │                        ⊕    ✈     │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

- **+ 按钮**（左侧）：`w-7 h-7`，圆形，`text-[#86868B] border border-[#E5E5E5]`，hover 时 `border-[#FF6B00] text-[#FF6B00]`。点击触发隐藏的 `<input type="file">`，accept 含所有支持类型。
- **发送按钮**（右侧）：小飞机 SVG 图标，`w-9 h-9`，`bg-[#FF6B00] text-white rounded-lg`。无文件时依赖文本内容可用。
- **停止按钮**：方形停止图标，`bg-[#86868B]`，生成中时替换发送按钮。
- 两按钮间距 `gap-2`，右对齐。

### 3.2 文件预览区

替代现网仅图片的预览区，根据文件类型展示不同缩略图：

| 文件类型 | 预览方式 |
|---------|---------|
| 图片 (PNG/JPEG/HEIC) | 小缩略图 `w-12 h-12 object-cover`（现网行为） |
| TXT/MD | 文档 SVG 图标 `w-12 h-12` + 文件名 |
| PDF | PDF SVG 图标 `w-12 h-12` + 文件名 + 状态文字 |

状态文字：
- 上传中 / 提取中：显示 spinner + "提取中..." / "上传中..."
- 已就绪：显示"已就绪"
- 失败：显示错误信息

右侧统一有「移除」按钮，清空已选文件。

### 3.3 状态机

```
null ──选文件──▶ uploading ──上传完成──▶ ready（图片/TXT/MD）
                           ──上传完成──▶ extracting（PDF）
                                           │
                              SSE:done ────▶ ready
                              SSE:error ───▶ error
                              timeout ──────▶ error

ready ──点发送──▶ null（清空，发送中）
error ──点移除──▶ null
```

- 发送按钮：`ready` 或纯文本时可用；`extracting` 时显示 spinner 不可点击
- 超时：120s（与 MinerU CLI 超时一致）
- 单文件强制：选新文件自动替换旧文件

### 3.4 拖拽/粘贴扩展

现网 `handleDragEnter`、`handleDrop`、`handlePaste` 均只过滤 `image/*`，改为接受所有支持类型（`image/*` + `text/plain` + `application/pdf` + `.md`）。拖入不支持的类型时忽略。

---

## 4. Client-Side API/Hooks Changes

### 4.1 api.ts 类型扩展

```typescript
export interface AttachmentRequest {
  type: 'image' | 'file';   // 'file' for txt/md/pdf
  fileId: string;
  taskId?: number;           // PDF extraction task ID
}
```

### 4.2 新增 extraction SSE 函数

```typescript
export async function* streamExtraction(
  taskId: number,
  signal?: AbortSignal
): AsyncIterable<{ type: 'done' | 'error'; message?: string }> {
  const token = localStorage.getItem('token') ?? '';
  const res = await fetch(`/api/refinery/tasks/${taskId}/stream`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal,
  });
  // SSE data: line 解析，yield events
}
```

### 4.3 AuxInputBar 文件状态重构

用统一 `FileState` 替换现网的 `imageStatus` + `pendingAttachment`：

```typescript
interface FileState {
  status: 'converting' | 'uploading' | 'extracting' | 'ready' | 'error';
  fileId: string;
  url: string;
  fileName: string;
  fileType: 'image' | 'text' | 'pdf';
  taskId?: number;
  errorMsg?: string;
}
```

### 4.4 文件分类

```typescript
function getFileCategory(file: File): 'image' | 'text' | 'pdf' {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type === 'application/pdf') return 'pdf';
  // TXT/MD: mime may be empty on some platforms, check extension
  if (file.type === 'text/plain' || file.name.endsWith('.md') || file.name.endsWith('.txt'))
    return 'text';
  throw new Error('不支持的文件格式');
}
```

### 4.5 useAuxChat 签名适配

`send()` 函数透传 `taskId`：

```typescript
const send = useCallback(
  async (content: string, attachments?: AttachmentRequest[], images?: string[]) => {
    // ... 现有逻辑不变，attachments 中 type:'file' 项透传 taskId
  },
  [...]
);
```

---

## 5. Backend Changes

### 5.1 FilesService — PDF 自动启动提取

[files.service.ts](apps/server/src/modules/files/files.service.ts)：

- 注入 `RefineryService`
- `upload()` 在存储文件后检测 `mime_type === 'application/pdf'`
- 自动调用 `refineryService.createTask(fileId, uploaderId, source)`，返回 `taskId`
- 非 PDF 文件：`taskId` 为 undefined

FilesModule 需 import RefineryModule。

### 5.2 RefineryService — EventEmitter + SSE 端点

[refinery.service.ts](apps/server/src/modules/refinery/refinery.service.ts)：

- 新增内部 `EventEmitter`，key 为 `task:{taskId}`
- `runExtraction()` 完成时 emit `{ type: 'done' }`；失败时 emit `{ type: 'error', message }`
- 保留现有 `getTask()`（轮询/查询用）

[refinery.controller.ts](apps/server/src/modules/refinery/refinery.controller.ts)：

- 新增 `@Sse('api/refinery/tasks/:taskId/stream')` 端点
- 逻辑：
  1. 先查 DB：status 已是 `completed` → 立即 push `done` 并 complete
  2. status 已是 `failed` → 立即 push `error` 并 complete
  3. status 为 `pending/processing` → 订阅 `task:{taskId}` 事件 → push SSE → unsubscribe + complete
- 加 120s 超时保护（`req.raw.on('close', ...)`）

### 5.3 AIService.resolveAttachments — 扩展文件类型

[ai.service.ts](apps/server/src/modules/ai/ai.service.ts)：

```typescript
// 现有 image 逻辑保持不变
if (att.type === 'image') {
  // ... 读文件 → base64 data URL → imageUrl ...
}

// 新增 file 类型处理
if (att.type === 'file') {
  const fileRow = await this.filesRepo.findByIdAndOwner(fileIdNum, userId);

  if (fileRow.mime_type.startsWith('text/') || fileRow.mime_type === 'text/markdown') {
    // TXT/MD：读文件 UTF-8 内容
    const text = fs.readFileSync(filePath, 'utf-8');
    attachments.push({ type: 'file', extractedText: text, ... });
  }

  if (fileRow.mime_type === 'application/pdf') {
    // PDF：从 extract_tasks 读 MinerU 结果
    const task = await this.extractTasksRepo.findById(att.taskId);
    const result = JSON.parse(task.result); // { markdown, images }
    attachments.push({
      type: 'file',
      extractedText: result.markdown,
      extractedImages: result.images, // 用于路由决策
      ... 
    });
  }
}
```

注意事项：
- `MAX_IMAGE_BYTES = 5MB` 仅适用于图片；文本/PDF 文件使用 upload 端点的 20MB 限制
- PDF 提取出的 `extractedImages` 标记需要多模态模型，通过 `RouteRequest.hasImage` 路由
- 文本内容需要 UTF-8 编码，其他编码降级为 latin1 并 warn

### 5.4 DTO 类型

[tutor.dto.ts](apps/server/src/modules/ai/dto/tutor.dto.ts)：

```typescript
export interface TutorAttachment {
  type: 'image' | 'file';
  fileId: string;
  taskId?: number;  // PDF extraction task ID
}
```

### 5.5 ai-core 类型同步

[types.ts](apps/server/src/ai-core/types.ts)：

```typescript
export interface Attachment {
  type: 'image' | 'file';
  url: string;
  imageUrl?: string;
  extractedText?: string;
  extractedImages?: string[];  // PDF extracted image paths
  fileId?: string;
}
```

### 5.6 TutoringCapability — 文本附件拼入 message

[tutoring.capability.ts](apps/server/src/ai-core/capabilities/tutoring.capability.ts)：

- `buildPrompt()` 中，检测 `attachment.type === 'file'` 时，将 `extractedText` 拼入 user message 内容
- 示例：`"${userMessage}\n\n---\n附件内容（${fileName}）：\n${extractedText}"`
- PDF 提取含图片时，额外追加 `image_url` parts 到 ContentPart[]

---

## 6. Error Handling

| 场景 | 前端表现 | 后端行为 |
|------|---------|---------|
| 不支持的文件格式 | Toast "不支持的文件格式，请选择 PNG/JPG/HEIC/TXT/MD/PDF" | HTTP 400 |
| 图片过大（>5MB） | Toast "图片过大（最大 5MB）" | - |
| 文件过大（>20MB） | Toast "文件过大（最大 20MB）" | Multer 413 |
| 上传网络失败 | Toast "上传失败，请检查网络" | - |
| PDF 提取超时（120s） | Toast "提取超时，请重试" | SSE close |
| PDF 提取失败 | Toast "文件处理失败，请重试" | SSE error event |
| 发送时文件已被删除 | Toast "文件已过期，请重新上传" | HTTP 400 |

---

## 7. File Summary

| 文件 | 改动类型 |
|------|---------|
| `apps/web/src/components/business/AuxInputBar.tsx` | 重构 |
| `apps/web/src/services/api.ts` | 扩展 |
| `apps/web/src/hooks/useAuxChat.ts` | 适配 |
| `apps/server/src/modules/files/files.service.ts` | 扩展 |
| `apps/server/src/modules/files/files.module.ts` | 扩展 |
| `apps/server/src/modules/refinery/refinery.service.ts` | EventEmitter |
| `apps/server/src/modules/refinery/refinery.controller.ts` | SSE 端点 |
| `apps/server/src/modules/ai/ai.service.ts` | resolveAttachments 扩展 |
| `apps/server/src/modules/ai/dto/tutor.dto.ts` | 类型扩展 |
| `apps/server/src/ai-core/types.ts` | Attachment 扩展 |
| `apps/server/src/ai-core/capabilities/tutoring.capability.ts` | 文本附件拼入 |
| `docs/superpowers/specs/2026-08-02-auxiliary-track-design.md` | 同步更新 |
| `docs/api/openapi.yaml` | 同步更新 |
| `docs/API接口与数据流设计文档.md` | 同步更新 |

---

## 8. Model Support for PDF (Reference)

截至 2026-08-08 三家模型对 PDF 的支持情况：

| 模型 | 原生 PDF 支持 | 说明 |
|------|-------------|------|
| Kimi | ✅ 支持 | 有 file-extract API（`POST /v1/files`），提取后放入对话 |
| Qwen | ⚠️ 部分 | Qwen-Long/Doc-Turbo 支持 file-extract；VL 系列仅看图 |
| DeepSeek | ❌ 不支持 | 纯文本模型，必须本地提取后传入 |

**设计决策**：不依赖模型原生 PDF 能力，统一用 MinerU 本地提取 → Markdown → 文本传给 LLM，保证所有模型路由下行为一致。
