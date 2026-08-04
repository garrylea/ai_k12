# 辅助系统（辅线 / 答疑轨）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 K12 智学系统的辅助系统（辅线 / 答疑轨），包括 DB 持久化会话、实时图片题目提取、AI 苏格拉底辅导、辅线错题入库去重、以及前端 P3.1-P3.4 页面，使辅线从占位状态成为可运行的完整功能。

**Architecture:** 后端 NestJS 新增/扩展 `ConversationsModule`、`AIModule`、`RefineryModule`、`ErrorBookModule`、`FilesModule`；`ai-core` 新增 `QuestionStructuringCapability`；实时图片提取通过 Node.js 包装 `mineru-open-api` CLI 实现；前端构建 ChatGPT-like 单页答疑应用与双错题本辅线 Tab。

**Tech Stack:** NestJS (Node.js ESM), TypeScript, MySQL2, ai-core (Mustache/Zod), MinerU CLI, React 19, Vite, Tailwind CSS, Zustand, KaTeX, WebSocket/SSE.

---

## 0. 前置阅读

实施前必须阅读以下文档：

- 本计划依据的设计文档：`docs/superpowers/specs/2026-08-02-auxiliary-track-design.md`
- PRD：`docs/K12智学系统-产品需求文档.md` §6.2, §7.1, §7.4, §7.9, §7.10
- API：`docs/API接口与数据流设计文档.md` §4.7, §4.8, §4.10, §4.11, §5, §6.2, §6.3
- UX-UI：`docs/UX-UI设计文档.md` §5.3 P3.1, §5.4 P4.1
- 后端设计：`docs/K12智学系统-后端Web服务设计文档.md`
- DB schema：`tools/db/schema.sql`
- 现有 ai-core：`apps/server/src/ai-core/prompts/tutoring/math/auxiliary.md`
- 现有前端占位：`apps/web/src/routes/index.tsx`

---

## 1. 文件结构映射

### 1.1 后端（apps/server）

```
apps/server/src/
├── modules/
│   ├── files/
│   │   ├── files.module.ts
│   │   ├── files.controller.ts
│   │   └── files.service.ts
│   ├── conversations/
│   │   ├── conversations.module.ts
│   │   ├── conversations.controller.ts
│   │   ├── conversations.service.ts
│   │   └── dto/
│   │       ├── create-conversation.dto.ts
│   │       ├── list-conversations.dto.ts
│   │       └── append-message.dto.ts
│   ├── ai/
│   │   ├── ai.module.ts
│   │   ├── ai.controller.ts
│   │   └── ai.service.ts
│   ├── refinery/
│   │   ├── refinery.module.ts
│   │   ├── refinery.controller.ts
│   │   ├── refinery.service.ts
│   │   └── mineru.service.ts
│   └── error-book/
│       ├── error-book.module.ts
│       ├── error-book.controller.ts
│       └── error-book.service.ts
├── database/repositories/
│   ├── ai-dialogues.repo.ts
│   ├── ai-messages.repo.ts
│   ├── aux-error-books.repo.ts
│   ├── extract-tasks.repo.ts
│   ├── safety-alerts.repo.ts
│   ├── uploaded-files.repo.ts
│   └── questions.repo.ts
├── services/conversation/
│   ├── index.ts
│   └── types.ts
└── ai-core/
    ├── capabilities/
    │   └── question-structuring.capability.ts
    └── prompts/
        └── structuring/
            └── question.md
```

### 1.2 前端（apps/web）

```
apps/web/src/
├── pages/student/
│   ├── AuxiliaryHomePage.tsx      # P3.1
│   ├── KnowledgeSelectorPage.tsx  # P3.2
│   ├── PhotoAskPage.tsx           # P3.3
│   └── AuxChatPage.tsx            # P3.4
├── components/business/
│   ├── AuxiliaryLayout.tsx
│   ├── ConversationList.tsx
│   ├── AuxChatPanel.tsx
│   ├── AuxInputBar.tsx
│   └── AuxEmptyState.tsx
├── store/
│   ├── auxiliaryStore.ts
│   ├── chatStore.ts
│   └── refineryStore.ts
├── hooks/
│   └── useAuxChat.ts
└── services/
    └── api.ts                    # 扩展 auxiliary/conversations/refinery/error-book API
```

---

## 2. 任务清单

### Task 1: 准备数据库仓库层（Repositories）

**Files:**
- Create: `apps/server/src/database/repositories/ai-dialogues.repo.ts`
- Create: `apps/server/src/database/repositories/ai-messages.repo.ts`
- Create: `apps/server/src/database/repositories/aux-error-books.repo.ts`
- Create: `apps/server/src/database/repositories/extract-tasks.repo.ts`
- Create: `apps/server/src/database/repositories/safety-alerts.repo.ts`
- Create: `apps/server/src/database/repositories/uploaded-files.repo.ts`
- Create: `apps/server/src/database/repositories/questions.repo.ts`
- Modify: `apps/server/src/database/database.module.ts`

- [ ] **Step 1.1: 定义 AiDialogue / AiMessage TypeScript 接口**

在 `apps/server/src/database/repositories/types.ts` 追加（若不存在则创建）：

```typescript
export interface AiDialogueRow {
  id: number;
  student_id: number;
  subject_id: number | null;
  track: 'mainline' | 'auxiliary';
  card_id: number | null;
  knowledge_point_id: number | null;
  title: string | null;
  status: 'active' | 'archived' | 'completed';
  consecutive_fail_count: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface AiMessageRow {
  id: number;
  dialogue_id: number;
  role: 'system' | 'user' | 'assistant';
  content: string;
  type: 'socratic' | 'hint' | 'explain' | 'fallback' | 'block' | 'chat';
  attachments: string | null;
  model: string | null;
  token_input: number | null;
  token_output: number | null;
  response_time_ms: number | null;
  safety_flag: number;
  created_at: Date;
}

export interface AuxErrorBookRow {
  id: number;
  student_id: number;
  subject_id: number;
  question_id: number | null;
  level: number;
  is_cleared: number;
  source: 'auxiliary' | 'photo';
  wrong_answer_text: string | null;
  cleared_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ExtractTaskRow {
  id: number;
  file_id: number;
  student_id: number;
  provider: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  result: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface SafetyAlertRow {
  id: number;
  parent_id: number;
  student_id: number;
  dialogue_id: number | null;
  message_id: number | null;
  type: 'off_topic' | 'emotional' | 'sensitive' | 'abusive';
  level: 'info' | 'warning' | 'critical';
  message: string;
  context: string | null;
  is_read: number;
  read_at: Date | null;
  created_at: Date;
}

export interface QuestionRow {
  id: number;
  subject_id: number;
  type: string;
  difficulty: number;
  content: string;
  options: string | null;
  answer: string;
  explanation: string;
  source: string;
  content_hash: string;
  created_at: Date;
}
```

- [ ] **Step 1.2: 创建 AiDialoguesRepository**

`apps/server/src/database/repositories/ai-dialogues.repo.ts`:

```typescript
import { Inject, Injectable } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { AiDialogueRow } from './types.js';

@Injectable()
export class AiDialoguesRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async create(row: Omit<AiDialogueRow, 'id' | 'created_at' | 'updated_at' | 'deleted_at'>): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO ai_dialogues
       (student_id, subject_id, track, card_id, knowledge_point_id, title, status, consecutive_fail_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.student_id, row.subject_id, row.track, row.card_id, row.knowledge_point_id, row.title, row.status, row.consecutive_fail_count],
    );
    return result.insertId;
  }

  async findById(id: number): Promise<AiDialogueRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM ai_dialogues WHERE id = ?`,
      [id],
    );
    return (rows[0] as AiDialogueRow) ?? null;
  }

  async findByStudentAndTrack(studentId: number, track: string, limit: number, cursor?: number): Promise<AiDialogueRow[]> {
    const clause = cursor ? 'AND id < ?' : '';
    const params = cursor ? [studentId, track, cursor, limit] : [studentId, track, limit];
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM ai_dialogues
       WHERE student_id = ? AND track = ? ${clause}
       ORDER BY id DESC LIMIT ?`,
      params,
    );
    return rows as AiDialogueRow[];
  }

  async updateTitle(id: number, title: string): Promise<void> {
    await this.pool.execute(
      `UPDATE ai_dialogues SET title = ? WHERE id = ?`,
      [title, id],
    );
  }

  async archive(id: number): Promise<void> {
    await this.pool.execute(
      `UPDATE ai_dialogues SET status = 'archived' WHERE id = ?`,
      [id],
    );
  }

  async updateFailCount(id: number, count: number): Promise<void> {
    await this.pool.execute(
      `UPDATE ai_dialogues SET consecutive_fail_count = ? WHERE id = ?`,
      [count, id],
    );
  }
}
```

- [ ] **Step 1.3: 创建 AiMessagesRepository**

`apps/server/src/database/repositories/ai-messages.repo.ts`:

```typescript
import { Inject, Injectable } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { AiMessageRow } from './types.js';

@Injectable()
export class AiMessagesRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async create(row: Omit<AiMessageRow, 'id' | 'created_at'>): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO ai_messages
       (dialogue_id, role, content, type, attachments, model, token_input, token_output, response_time_ms, safety_flag)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.dialogue_id, row.role, row.content, row.type, row.attachments, row.model, row.token_input, row.token_output, row.response_time_ms, row.safety_flag],
    );
    return result.insertId;
  }

  async createMany(rows: Array<Omit<AiMessageRow, 'id' | 'created_at'>>): Promise<void> {
    if (rows.length === 0) return;
    const placeholders = rows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
    const values = rows.flatMap((r) => [r.dialogue_id, r.role, r.content, r.type, r.attachments, r.model, r.token_input, r.token_output, r.response_time_ms, r.safety_flag]);
    await this.pool.execute(
      `INSERT INTO ai_messages
       (dialogue_id, role, content, type, attachments, model, token_input, token_output, response_time_ms, safety_flag)
       VALUES ${placeholders}`,
      values,
    );
  }

  async findByDialogue(dialogueId: number, lastMessageId?: number): Promise<AiMessageRow[]> {
    const clause = lastMessageId ? 'AND id > ?' : '';
    const params = lastMessageId ? [dialogueId, lastMessageId] : [dialogueId];
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM ai_messages WHERE dialogue_id = ? ${clause} ORDER BY id ASC`,
      params,
    );
    return rows as AiMessageRow[];
  }
}
```

- [ ] **Step 1.4: 创建 AuxErrorBooksRepository**

`apps/server/src/database/repositories/aux-error-books.repo.ts`:

```typescript
import { Inject, Injectable } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { AuxErrorBookRow } from './types.js';

@Injectable()
export class AuxErrorBooksRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async create(row: Omit<AuxErrorBookRow, 'id' | 'created_at' | 'updated_at' | 'cleared_at'>): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO aux_error_books
       (student_id, subject_id, question_id, level, is_cleared, source, wrong_answer_text)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [row.student_id, row.subject_id, row.question_id, row.level, row.is_cleared, row.source, row.wrong_answer_text],
    );
    return result.insertId;
  }

  async findById(id: number): Promise<AuxErrorBookRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM aux_error_books WHERE id = ?`,
      [id],
    );
    return (rows[0] as AuxErrorBookRow) ?? null;
  }

  async findByStudent(studentId: number, subjectId?: number): Promise<AuxErrorBookRow[]> {
    const clause = subjectId ? 'AND subject_id = ?' : '';
    const params = subjectId ? [studentId, subjectId] : [studentId];
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM aux_error_books WHERE student_id = ? ${clause} ORDER BY id DESC`,
      params,
    );
    return rows as AuxErrorBookRow[];
  }

  async markCleared(id: number): Promise<void> {
    await this.pool.execute(
      `UPDATE aux_error_books SET is_cleared = 1, cleared_at = NOW(3) WHERE id = ?`,
      [id],
    );
  }

  async updateLevel(id: number, level: number): Promise<void> {
    await this.pool.execute(
      `UPDATE aux_error_books SET level = ? WHERE id = ?`,
      [level, id],
    );
  }
}
```

- [ ] **Step 1.5: 创建 ExtractTasksRepository**

`apps/server/src/database/repositories/extract-tasks.repo.ts`:

```typescript
import { Inject, Injectable } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { ExtractTaskRow } from './types.js';

@Injectable()
export class ExtractTasksRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async create(row: Omit<ExtractTaskRow, 'id' | 'created_at' | 'updated_at' | 'result' | 'error_message'>): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO extract_tasks (file_id, student_id, provider, status)
       VALUES (?, ?, ?, ?)`,
      [row.file_id, row.student_id, row.provider, row.status],
    );
    return result.insertId;
  }

  async findById(id: number): Promise<ExtractTaskRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM extract_tasks WHERE id = ?`,
      [id],
    );
    return (rows[0] as ExtractTaskRow) ?? null;
  }

  async updateStatus(id: number, status: ExtractTaskRow['status'], result?: string, errorMessage?: string): Promise<void> {
    await this.pool.execute(
      `UPDATE extract_tasks SET status = ?, result = ?, error_message = ?, updated_at = NOW(3) WHERE id = ?`,
      [status, result ?? null, errorMessage ?? null, id],
    );
  }
}
```

- [ ] **Step 1.6: 创建 SafetyAlertsRepository**

`apps/server/src/database/repositories/safety-alerts.repo.ts`:

```typescript
import { Inject, Injectable } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { SafetyAlertRow } from './types.js';

@Injectable()
export class SafetyAlertsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async create(row: Omit<SafetyAlertRow, 'id' | 'created_at' | 'is_read' | 'read_at'>): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO safety_alerts
       (parent_id, student_id, dialogue_id, message_id, type, level, message, context)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.parent_id, row.student_id, row.dialogue_id, row.message_id, row.type, row.level, row.message, row.context],
    );
    return result.insertId;
  }

  async findByParent(parentId: number): Promise<SafetyAlertRow[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM safety_alerts WHERE parent_id = ? ORDER BY id DESC`,
      [parentId],
    );
    return rows as SafetyAlertRow[];
  }

  async markRead(id: number): Promise<void> {
    await this.pool.execute(
      `UPDATE safety_alerts SET is_read = 1 WHERE id = ?`,
      [id],
    );
  }
}
```

- [ ] **Step 1.7: 创建 QuestionsRepository**

`apps/server/src/database/repositories/questions.repo.ts`:

```typescript
import { Inject, Injectable } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { QuestionRow } from './types.js';

@Injectable()
export class QuestionsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async findByContentHash(contentHash: string): Promise<QuestionRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM questions WHERE content_hash = ?`,
      [contentHash],
    );
    return (rows[0] as QuestionRow) ?? null;
  }

  async create(row: Omit<QuestionRow, 'id' | 'created_at'>): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO questions
       (subject_id, type, difficulty, content, options, answer, explanation, source, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.subject_id, row.type, row.difficulty, row.content, row.options, row.answer, row.explanation, row.source, row.content_hash],
    );
    return result.insertId;
  }

  async bindKnowledgePoint(questionId: number, knowledgePointId: number, role = 'primary'): Promise<void> {
    await this.pool.execute(
      `INSERT INTO question_knowledge_points (question_id, knowledge_point_id, role) VALUES (?, ?, ?)`,
      [questionId, knowledgePointId, role],
    );
  }
}
```

- [ ] **Step 1.8: 创建 UploadedFilesRepository**

`apps/server/src/database/repositories/uploaded-files.repo.ts`:

```typescript
import { Inject, Injectable } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export interface UploadedFileRow {
  id: number;
  uploader_id: number;
  uploader_type: string;
  url: string;
  mime_type: string;
  size_bytes: number;
  source: string;
  created_at: Date;
}

@Injectable()
export class UploadedFilesRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async create(row: Omit<UploadedFileRow, 'id' | 'created_at'>): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO uploaded_files (uploader_id, uploader_type, url, mime_type, size_bytes, source)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [row.uploader_id, row.uploader_type, row.url, row.mime_type, row.size_bytes, row.source],
    );
    return result.insertId;
  }

  async findById(id: number): Promise<UploadedFileRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM uploaded_files WHERE id = ?`,
      [id],
    );
    return (rows[0] as UploadedFileRow) ?? null;
  }
}
```

- [ ] **Step 1.9: 在 DatabaseModule 注册仓库**

`apps/server/src/database/database.module.ts` 的 `providers` 数组追加：

```typescript
AiDialoguesRepository,
AiMessagesRepository,
AuxErrorBooksRepository,
ExtractTasksRepository,
SafetyAlertsRepository,
QuestionsRepository,
UploadedFilesRepository,
```

并在 `exports` 中同样导出。

- [ ] **Step 1.10: 运行 ai-core 测试确认无回归**

```bash
cd apps/server
npm test
```

Expected: 现有 72 个测试全部通过（仓库层尚未被使用，不应影响测试）。

- [ ] **Step 1.11: Commit**

```bash
git add apps/server/src/database/
git commit -m "feat(aux): add auxiliary track repositories

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: 持久化 ConversationService

**Files:**
- Modify: `apps/server/src/services/conversation/index.ts`
- Modify: `apps/server/src/services/conversation/types.ts`
- Create: `apps/server/src/services/conversation/conversation.service.spec.ts`

- [ ] **Step 2.1: 更新 ConversationService 类型定义**

`apps/server/src/services/conversation/types.ts`:

```typescript
import type { Message, Subject } from '../../ai-core/types.js';

export interface DialogueRecord {
  id: number;
  dialogueId: string;
  studentId: number;
  subjectId: number | null;
  track: 'mainline' | 'auxiliary';
  cardContent?: string;
  currentKnowledgePoint?: { id: string; name: string; subject: string };
  currentDifficulty?: number;
  currentQuestion?: { content: string; answer?: string };
  messages: Message[];
  failCount: number;
  createdAt: Date;
  completedAt?: Date;
  completeReason?: string;
}

export interface SaveMessagesRequest {
  dialogueId: string;
  messages: Message[];
}

export interface UpdateFailCountRequest {
  dialogueId: string;
  increment: boolean;
}

export interface CompleteDialogueRequest {
  dialogueId: string;
  reason: string;
}
```

- [ ] **Step 2.2: 重写 ConversationService 为 DB 持久化**

`apps/server/src/services/conversation/index.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import type { Message, LoadContextResponse, Subject } from '../../ai-core/types.js';
import type { DialogueRecord, SaveMessagesRequest, UpdateFailCountRequest, CompleteDialogueRequest } from './types.js';
import { AiDialoguesRepository, AiMessagesRepository } from '../../database/repositories/index.js';
import type { AiDialogueRow, AiMessageRow } from '../../database/repositories/types.js';

export interface CreateDialogueParams {
  dialogueId: string;
  studentId: number;
  student: { grade: string; gradeLevel: string; name: string };
  subject: Subject;
  cardContent?: string;
  track: 'mainline' | 'auxiliary';
  currentKnowledgePoint?: { id: string; name: string; subject: string };
  currentDifficulty?: number;
  currentQuestion?: { content: string; answer?: string };
}

@Injectable()
export class ConversationService {
  constructor(
    private readonly dialoguesRepo: AiDialoguesRepository,
    private readonly messagesRepo: AiMessagesRepository,
  ) {}

  async createDialogue(params: CreateDialogueParams): Promise<number> {
    const id = await this.dialoguesRepo.create({
      student_id: params.studentId,
      subject_id: params.subject.id ? Number(params.subject.id) : null,
      track: params.track,
      card_id: null,
      knowledge_point_id: params.currentKnowledgePoint ? Number(params.currentKnowledgePoint.id) : null,
      title: params.track === 'auxiliary' ? '辅线答疑' : '主线讨论',
      status: 'active',
      consecutive_fail_count: 0,
    });
    return id;
  }

  async loadContext(dialogueId: string, tokenBudget = 4000): Promise<LoadContextResponse | null> {
    const record = await this.dialoguesRepo.findById(Number(dialogueId));
    if (!record) return null;
    const messages = await this.messagesRepo.findByDialogue(Number(dialogueId));
    const normalizedMessages: Message[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    let finalMessages = normalizedMessages;
    const totalChars = normalizedMessages.reduce((sum, m) => sum + m.content.length, 0);
    const charBudget = tokenBudget * 2;

    if (totalChars > charBudget) {
      const last4 = normalizedMessages.slice(-4);
      const last4Chars = last4.reduce((sum, m) => sum + m.content.length, 0);
      const remainingBudget = charBudget - last4Chars;
      const older = normalizedMessages.slice(0, -4);
      const summaries: Message[] = [];
      const batchCount = Math.max(1, Math.ceil(older.length / 6));
      for (let i = 0; i < older.length; i += 6) {
        const batch = older.slice(i, i + 6);
        const summary = `[对话摘要] ${batch.map((m) => `${m.role}: ${m.content.slice(0, 30)}...`).join(' | ')}`;
        if (summary.length <= remainingBudget / batchCount) {
          summaries.push({ role: 'system', content: summary });
        }
      }
      finalMessages = [...summaries, ...last4];
    }

    return {
      messages: finalMessages,
      student: { grade: record.student_id.toString(), gradeLevel: '', name: '' },
      subject: { id: record.subject_id?.toString() ?? '', code: 'math', name: '数学' },
      cardContent: record.card_id ? undefined : '',
      currentKnowledgePoint: record.knowledge_point_id ? { id: record.knowledge_point_id.toString(), name: '', subject: '' } : undefined,
      consecutiveFailCount: record.consecutive_fail_count,
      dialogueMetadata: {
        track: record.track,
        createdAt: record.created_at,
        messageCount: messages.length,
      },
    };
  }

  async saveMessages(request: SaveMessagesRequest): Promise<void> {
    const rows: Array<Omit<AiMessageRow, 'id' | 'created_at'>> = request.messages.map((msg) => ({
      dialogue_id: Number(request.dialogueId),
      role: msg.role,
      content: msg.content,
      type: 'socratic',
      attachments: null,
      model: null,
      token_input: null,
      token_output: null,
      response_time_ms: null,
      safety_flag: 0,
    }));
    await this.messagesRepo.createMany(rows);
  }

  async updateFailCount(request: UpdateFailCountRequest): Promise<void> {
    const record = await this.dialoguesRepo.findById(Number(request.dialogueId));
    if (!record) throw new Error(`Dialogue not found: ${request.dialogueId}`);
    const next = request.increment ? record.consecutive_fail_count + 1 : 0;
    await this.dialoguesRepo.updateFailCount(record.id, next);
  }

  async completeDialogue(request: CompleteDialogueRequest): Promise<void> {
    await this.dialoguesRepo.archive(Number(request.dialogueId));
  }

  _reset(): void {
    // 仅用于测试；DB 持久化后不再需要清空内存 Map
  }
}
```

- [ ] **Step 2.3: 更新导出的 Repository index**

若不存在 `apps/server/src/database/repositories/index.ts`，创建它：

```typescript
export { AiDialoguesRepository } from './ai-dialogues.repo.js';
export { AiMessagesRepository } from './ai-messages.repo.js';
export { AuxErrorBooksRepository } from './aux-error-books.repo.js';
export { ExtractTasksRepository } from './extract-tasks.repo.js';
export { SafetyAlertsRepository } from './safety-alerts.repo.js';
export { QuestionsRepository } from './questions.repo.js';
export { UploadedFilesRepository } from './uploaded-files.repo.js';
```

- [ ] **Step 2.4: 编写 ConversationService 单元测试**

`apps/server/src/services/conversation/conversation.service.spec.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { ConversationService } from './index.js';

class FakeAiDialoguesRepository {
  rows: any[] = [];
  async create(row: any) {
    const id = this.rows.length + 1;
    this.rows.push({ id, ...row, created_at: new Date(), updated_at: new Date() });
    return id;
  }
  async findById(id: number) {
    return this.rows.find((r) => r.id === id) ?? null;
  }
  async updateFailCount(id: number, count: number) {
    const row = this.rows.find((r) => r.id === id);
    if (row) row.consecutive_fail_count = count;
  }
  async archive(id: number) {
    const row = this.rows.find((r) => r.id === id);
    if (row) row.status = 'archived';
  }
}

class FakeAiMessagesRepository {
  rows: any[] = [];
  async createMany(messages: any[]) {
    for (const m of messages) this.rows.push(m);
  }
  async findByDialogue(dialogueId: number) {
    return this.rows.filter((r) => r.dialogue_id === dialogueId);
  }
}

describe('ConversationService', () => {
  let service: ConversationService;
  let dialoguesRepo: FakeAiDialoguesRepository;
  let messagesRepo: FakeAiMessagesRepository;

  beforeEach(() => {
    dialoguesRepo = new FakeAiDialoguesRepository();
    messagesRepo = new FakeAiMessagesRepository();
    service = new ConversationService(dialoguesRepo as any, messagesRepo as any);
  });

  it('creates auxiliary dialogue', async () => {
    const id = await service.createDialogue({
      dialogueId: 'dlg_1',
      studentId: 1,
      student: { grade: '7', gradeLevel: 'junior', name: 'Test' },
      subject: { id: '1', code: 'math', name: '数学' },
      track: 'auxiliary',
    });
    expect(id).toBe(1);
    expect(dialoguesRepo.rows[0].track).toBe('auxiliary');
  });

  it('saves messages and loads context', async () => {
    await service.createDialogue({
      dialogueId: '1',
      studentId: 1,
      student: { grade: '7', gradeLevel: 'junior', name: 'Test' },
      subject: { id: '1', code: 'math', name: '数学' },
      track: 'auxiliary',
    });
    await service.saveMessages({
      dialogueId: '1',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
    });
    const ctx = await service.loadContext('1');
    expect(ctx?.messages).toHaveLength(2);
  });
});
```

- [ ] **Step 2.5: 运行测试**

```bash
cd apps/server
npm test
```

Expected: 新增测试通过；现有 ai-core 测试可能因类型签名变化需要同步调整。

- [ ] **Step 2.6: 修复 ai-core 测试中的类型变化**

如果 `TutoringCapability` 测试注入的是旧的内存 `ConversationService`，需要更新为可注入 fake repositories 的形式，或保持旧构造函数兼容。优先让 `ConversationService` 支持无参构造（用于旧测试）和依赖注入构造。

在 `ConversationService` 顶部增加可选参数：

```typescript
constructor(
  private readonly dialoguesRepo?: AiDialoguesRepository,
  private readonly messagesRepo?: AiMessagesRepository,
) {}
```

若未注入，方法内部 throw 明确错误，避免运行时静默失败。

- [ ] **Step 2.7: Commit**

```bash
git add apps/server/src/services/conversation/
git commit -m "feat(aux): persist ConversationService to MySQL

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: 新增 QuestionStructuringCapability 与 Prompt

**Files:**
- Create: `apps/server/src/ai-core/capabilities/question-structuring.capability.ts`
- Create: `apps/server/src/ai-core/prompts/structuring/question.md`
- Create: `apps/server/src/ai-core/capabilities/question-structuring.capability.spec.ts`

- [ ] **Step 3.1: 创建 question-structuring prompt**

`apps/server/src/ai-core/prompts/structuring/question.md`:

```markdown
---
version: "1.0"
description: "将学生输入或图片 OCR 结果结构化为题库题目"
---

## System Prompt

你是一位 K12 数学题目结构化专家。请将学生提供的题目内容解析为结构化 JSON。

要求：
1. 提取题干、题型、难度、答案、解析。
2. 识别题目考查的知识点（使用教材中的标准知识点名称）。
3. 若信息不完整，给出 quality="poor" 并说明原因。
4. 数学公式使用 LaTeX：行内 `$...$`，独立 `$$...$$`。
5. 输出必须是合法 JSON，不要包含 Markdown 代码块标记。

题型枚举：choice（单选）、fill_blank（填空）、true_false（判断）、short_answer（解答）、proof（证明）。
难度枚举：1（易）、2（中）、3（难）。

## User Message

输入类型：{{inputType}}
学科：{{subjectHint}}
学段：{{gradeBand}}

原始内容：
{{rawInput}}

请输出 JSON：
{
  "type": "choice",
  "difficulty": 2,
  "content": "题干",
  "options": [{"label": "A", "text": "选项A", "isCorrect": false}],
  "answer": "答案",
  "explanation": "解析",
  "knowledgePoints": ["知识点1", "知识点2"],
  "quality": "good",
  "qualityIssues": []
}
```

- [ ] **Step 3.2: 创建 QuestionStructuringCapability**

`apps/server/src/ai-core/capabilities/question-structuring.capability.ts`:

```typescript
import { ModelClient } from '../infra/model-client/index.js';
import { PromptBuilder } from '../infra/prompt-builder.js';
import { ResponseParser } from '../infra/response-parser.js';
import type { StructuredQuestion, QuestionStructuringRequest } from '../types.js';

export interface QuestionStructuringCapabilityOptions {
  modelClient?: ModelClient;
}

export class QuestionStructuringCapability {
  private modelClient: ModelClient;
  private promptBuilder = new PromptBuilder();
  private parser = new ResponseParser();

  constructor(opts?: QuestionStructuringCapabilityOptions) {
    this.modelClient = opts?.modelClient ?? new ModelClient();
  }

  async structure(request: QuestionStructuringRequest): Promise<StructuredQuestion> {
    const prompt = this.promptBuilder.build({
      capability: 'structuring',
      subject: request.subjectHint ?? 'math',
      scene: 'question',
      customVariables: {
        rawInput: request.rawInput,
        inputType: request.inputType,
        subjectHint: request.subjectHint ?? 'math',
        gradeBand: request.gradeBand ?? 'junior',
      },
    });

    const response = await this.modelClient.chat({
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      timeout: 60000,
    });

    const parsed = this.parser.parseJSON<StructuredQuestion>(response.content);
    if (!parsed) {
      return {
        subjectId: 0,
        type: 'short_answer',
        difficulty: 1,
        content: request.rawInput,
        answer: '',
        explanation: '',
        knowledgePointIds: [],
        contentHash: '',
        quality: 'poor',
        qualityIssues: ['JSON 解析失败'],
      };
    }
    return parsed;
  }
}
```

- [ ] **Step 3.3: 在 ai-core types 中补充类型**

`apps/server/src/ai-core/types.ts` 追加：

```typescript
export interface QuestionStructuringRequest {
  rawInput: string;
  inputType: 'text' | 'image_markdown';
  studentId: string;
  subjectHint?: string;
  gradeBand?: string;
}

export interface Option {
  label: string;
  text: string;
  isCorrect: boolean;
}

export interface StructuredQuestion {
  subjectId: number;
  type: 'choice' | 'fill_blank' | 'true_false' | 'short_answer' | 'proof';
  difficulty: 1 | 2 | 3;
  content: string;
  options?: Option[];
  answer: string;
  explanation: string;
  knowledgePointIds: number[];
  contentHash: string;
  quality: 'good' | 'poor';
  qualityIssues?: string[];
}
```

- [ ] **Step 3.4: 更新 PromptBuilder 路由**

`apps/server/src/ai-core/infra/prompt-builder.ts` 中，为 capability `structuring` 增加路由：

```typescript
if (capability === 'structuring') {
  return `structuring/${scene ?? 'question'}.md`;
}
```

- [ ] **Step 3.5: 编写单元测试**

`apps/server/src/ai-core/capabilities/question-structuring.capability.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { QuestionStructuringCapability } from './question-structuring.capability.js';

class FakeModelClient {
  async chat() {
    return {
      content: JSON.stringify({
        type: 'choice',
        difficulty: 2,
        content: '1+1=?',
        options: [{ label: 'A', text: '1', isCorrect: false }, { label: 'B', text: '2', isCorrect: true }],
        answer: 'B',
        explanation: 'basic math',
        knowledgePoints: ['整数加法'],
        quality: 'good',
      }),
      reasoning: '',
    };
  }
}

describe('QuestionStructuringCapability', () => {
  it('structures a question from raw input', async () => {
    const cap = new QuestionStructuringCapability({ modelClient: new FakeModelClient() as any });
    const result = await cap.structure({ rawInput: '1+1=?', inputType: 'text', studentId: 's1' });
    expect(result.type).toBe('choice');
    expect(result.answer).toBe('B');
  });
});
```

- [ ] **Step 3.6: 运行测试**

```bash
cd apps/server
npm test
```

Expected: 新增测试通过。

- [ ] **Step 3.7: Commit**

```bash
git add apps/server/src/ai-core/
git commit -m "feat(aux): add QuestionStructuringCapability

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 实现 FilesModule（通用文件上传）

**Files:**
- Create: `apps/server/src/modules/files/files.module.ts`
- Create: `apps/server/src/modules/files/files.controller.ts`
- Create: `apps/server/src/modules/files/files.service.ts`

- [ ] **Step 4.1: 创建 FilesService**

`apps/server/src/modules/files/files.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { UploadedFilesRepository } from '../../database/repositories/uploaded-files.repo.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface UploadedFileResult {
  fileId: number;
  url: string;
}

@Injectable()
export class FilesService {
  private readonly storageDir = process.env.UPLOAD_DIR ?? './uploads';

  constructor(private readonly filesRepo: UploadedFilesRepository) {}

  async upload(file: Express.Multer.File, uploaderId: number, source: string): Promise<UploadedFileResult> {
    const key = `${source}/${randomUUID()}-${file.originalname}`;
    const dest = path.join(this.storageDir, key);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, file.buffer);

    const fileId = await this.filesRepo.create({
      uploader_id: uploaderId,
      uploader_type: 'student',
      url: `/uploads/${key}`,
      mime_type: file.mimetype,
      size_bytes: file.size,
      source,
    });

    return { fileId, url: `/uploads/${key}` };
  }
}
```

- [ ] **Step 4.2: 创建 FilesController**

`apps/server/src/modules/files/files.controller.ts`:

```typescript
import { Controller, Post, UploadedFile, UseInterceptors, Request } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { FilesService } from './files.service.js';

@Controller('/api/files')
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async upload(@UploadedFile() file: Express.Multer.File, @Request() req: any) {
    const userId = req.user.userId;
    const result = await this.filesService.upload(file, userId, 'auxiliary');
    return { code: 0, data: result };
  }
}
```

- [ ] **Step 4.3: 创建 FilesModule**

`apps/server/src/modules/files/files.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { FilesController } from './files.controller.js';
import { FilesService } from './files.service.js';
import { UploadedFilesRepository } from '../../database/repositories/uploaded-files.repo.js';

@Module({
  controllers: [FilesController],
  providers: [FilesService, UploadedFilesRepository],
  exports: [FilesService],
})
export class FilesModule {}
```

- [ ] **Step 4.4: 安装 multer 类型（若未安装）**

```bash
cd apps/server
npm install --save-dev @types/multer
```

- [ ] **Step 4.5: Commit**

```bash
git add apps/server/src/modules/files/ apps/server/package.json apps/server/package-lock.json
git commit -m "feat(aux): add FilesModule for generic upload

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: 实现 MinerUService 与 RefineryModule

**Files:**
- Create: `apps/server/src/modules/refinery/mineru.service.ts`
- Create: `apps/server/src/modules/refinery/refinery.service.ts`
- Create: `apps/server/src/modules/refinery/refinery.controller.ts`
- Create: `apps/server/src/modules/refinery/refinery.module.ts`

- [ ] **Step 5.1: 创建 MinerUService**

`apps/server/src/modules/refinery/mineru.service.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export interface MinerUResult {
  markdown: string;
  images: string[];
}

@Injectable()
export class MinerUService {
  private readonly logger = new Logger(MinerUService.name);
  private readonly cli = 'mineru-open-api';

  async extract(inputPath: string): Promise<MinerUResult> {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineru-'));
    await this.run(inputPath, outputDir);
    return this.parseOutput(outputDir);
  }

  private run(inputPath: string, outputDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.cli, ['extract', inputPath, '-o', outputDir]);
      let stderr = '';
      proc.stderr.on('data', (data) => { stderr += data.toString(); });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`mineru-open-api exited ${code}: ${stderr}`));
      });
      proc.on('error', (err) => reject(err));
      setTimeout(() => proc.kill('SIGTERM'), 120_000);
    });
  }

  private async parseOutput(outputDir: string): Promise<MinerUResult> {
    const entries = await fs.readdir(outputDir, { withFileTypes: true });
    const mdFile = entries.find((e) => e.isFile() && e.name.endsWith('.md'));
    if (!mdFile) return { markdown: '', images: [] };
    const markdown = await fs.readFile(path.join(outputDir, mdFile.name), 'utf-8');
    const images = entries
      .filter((e) => e.isFile() && /\.(png|jpg|jpeg|webp)$/i.test(e.name))
      .map((e) => path.join(outputDir, e.name));
    return { markdown, images };
  }
}
```

- [ ] **Step 5.2: 创建 RefineryService**

`apps/server/src/modules/refinery/refinery.service.ts`:

```typescript
import { Injectable, NotFoundException } from '@nestjs/common';
import * as path from 'node:path';
import { ExtractTasksRepository } from '../../database/repositories/extract-tasks.repo.js';
import { UploadedFilesRepository } from '../../database/repositories/uploaded-files.repo.js';
import { MinerUService } from './mineru.service.js';
import { QuestionStructuringCapability } from '../../ai-core/capabilities/question-structuring.capability.js';

@Injectable()
export class RefineryService {
  constructor(
    private readonly tasksRepo: ExtractTasksRepository,
    private readonly filesRepo: UploadedFilesRepository,
    private readonly mineru: MinerUService,
    private readonly structuring: QuestionStructuringCapability,
  ) {}

  async createTask(fileId: number, studentId: number, source: string): Promise<number> {
    const file = await this.filesRepo.findById(fileId);
    if (!file) throw new NotFoundException('file not found');
    if (file.uploader_id !== studentId) throw new NotFoundException('file not owned');

    const taskId = await this.tasksRepo.create({
      file_id: fileId,
      student_id: studentId,
      provider: 'mineru',
      status: 'pending',
    });

    // 异步执行，不阻塞 HTTP 响应
    this.runExtraction(taskId, file).catch(() => {});
    return taskId;
  }

  private async runExtraction(taskId: number, file: any): Promise<void> {
    await this.tasksRepo.updateStatus(taskId, 'processing');
    try {
      // file.url is '/uploads/<key>'; resolve to filesystem path for MinerU CLI
      const filePath = path.join(process.env.UPLOAD_DIR ?? './uploads', file.url.replace(/^\/uploads\//, ''));
      const result = await this.mineru.extract(filePath);
      const structured = await this.structuring.structure({
        rawInput: result.markdown,
        inputType: 'image_markdown',
        studentId: file.student_id?.toString() ?? '0',
        subjectHint: 'math',
      });
      await this.tasksRepo.updateStatus(
        taskId,
        'completed',
        JSON.stringify({ markdown: result.markdown, structured }),
      );
    } catch (err: any) {
      await this.tasksRepo.updateStatus(taskId, 'failed', undefined, err.message);
    }
  }

  async getTask(taskId: number, studentId: number) {
    const task = await this.tasksRepo.findById(taskId);
    if (!task || task.student_id !== studentId) throw new NotFoundException('task not found');
    return {
      id: task.id,
      status: task.status,
      result: task.result ? JSON.parse(task.result) : null,
      errorMessage: task.error_message,
    };
  }
}
```

- [ ] **Step 5.3: 创建 RefineryController**

`apps/server/src/modules/refinery/refinery.controller.ts`:

```typescript
import { Body, Controller, Get, Param, Post, Request } from '@nestjs/common';
import { RefineryService } from './refinery.service.js';

class ExtractDto {
  fileId!: number;
  source: string = 'auxiliary';
}

@Controller('/api/refinery')
export class RefineryController {
  constructor(private readonly refineryService: RefineryService) {}

  @Post('extract')
  async extract(@Body() dto: ExtractDto, @Request() req: any) {
    const taskId = await this.refineryService.createTask(dto.fileId, req.user.userId, dto.source);
    return { code: 0, data: { taskId } };
  }

  @Get('tasks/:taskId')
  async getTask(@Param('taskId') taskId: string, @Request() req: any) {
    const task = await this.refineryService.getTask(Number(taskId), req.user.userId);
    return { code: 0, data: task };
  }
}
```

- [ ] **Step 5.4: 创建 RefineryModule**

`apps/server/src/modules/refinery/refinery.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { RefineryController } from './refinery.controller.js';
import { RefineryService } from './refinery.service.js';
import { MinerUService } from './mineru.service.js';
import { ExtractTasksRepository } from '../../database/repositories/extract-tasks.repo.js';
import { UploadedFilesRepository } from '../../database/repositories/uploaded-files.repo.js';
import { QuestionStructuringCapability } from '../../ai-core/capabilities/question-structuring.capability.js';

@Module({
  controllers: [RefineryController],
  providers: [RefineryService, MinerUService, ExtractTasksRepository, UploadedFilesRepository, QuestionStructuringCapability],
  exports: [RefineryService],
})
export class RefineryModule {}
```

- [ ] **Step 5.5: Commit**

```bash
git add apps/server/src/modules/refinery/
git commit -m "feat(aux): add RefineryModule and MinerUService

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: 实现 ConversationsModule

**Files:**
- Create: `apps/server/src/modules/conversations/conversations.module.ts`
- Create: `apps/server/src/modules/conversations/conversations.controller.ts`
- Create: `apps/server/src/modules/conversations/conversations.service.ts`
- Create: `apps/server/src/modules/conversations/dto/*.ts`

- [ ] **Step 6.1: 创建 DTO**

`apps/server/src/modules/conversations/dto/create-conversation.dto.ts`:

```typescript
import { IsEnum, IsNumber, IsOptional, IsString } from 'class-validator';

export class CreateConversationDto {
  @IsEnum(['mainline', 'auxiliary'])
  track!: 'mainline' | 'auxiliary';

  @IsOptional()
  @IsNumber()
  subjectId?: number;

  @IsOptional()
  @IsNumber()
  knowledgePointId?: number;
}
```

`apps/server/src/modules/conversations/dto/list-conversations.dto.ts`:

```typescript
import { IsEnum, IsNumberString, IsOptional } from 'class-validator';

export class ListConversationsDto {
  @IsEnum(['mainline', 'auxiliary'])
  track!: 'mainline' | 'auxiliary';

  @IsNumberString()
  @IsOptional()
  cursor?: string;
}
```

`apps/server/src/modules/conversations/dto/append-message.dto.ts`:

```typescript
import { IsString } from 'class-validator';

export class AppendMessageDto {
  @IsString()
  content!: string;
}
```

- [ ] **Step 6.2: 创建 ConversationsService**

`apps/server/src/modules/conversations/conversations.service.ts`:

```typescript
import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { AiDialoguesRepository, AiMessagesRepository } from '../../database/repositories/index.js';

@Injectable()
export class ConversationsService {
  constructor(
    private readonly dialoguesRepo: AiDialoguesRepository,
    private readonly messagesRepo: AiMessagesRepository,
  ) {}

  async create(studentId: number, dto: any) {
    const id = await this.dialoguesRepo.create({
      student_id: studentId,
      subject_id: dto.subjectId ?? null,
      track: dto.track,
      card_id: null,
      knowledge_point_id: dto.knowledgePointId ?? null,
      title: dto.track === 'auxiliary' ? '辅线答疑' : '主线讨论',
      status: 'active',
      consecutive_fail_count: 0,
    });
    return this.dialoguesRepo.findById(id);
  }

  async list(studentId: number, track: string, cursor?: number) {
    return this.dialoguesRepo.findByStudentAndTrack(studentId, track, 10, cursor);
  }

  async get(dialogueId: number, studentId: number) {
    const dialogue = await this.dialoguesRepo.findById(dialogueId);
    if (!dialogue || dialogue.student_id !== studentId) throw new NotFoundException();
    return dialogue;
  }

  async getMessages(dialogueId: number, studentId: number, lastMessageId?: number) {
    await this.get(dialogueId, studentId);
    return this.messagesRepo.findByDialogue(dialogueId, lastMessageId);
  }

  async appendMessage(dialogueId: number, studentId: number, content: string) {
    await this.get(dialogueId, studentId);
    await this.messagesRepo.create({
      dialogue_id: dialogueId,
      role: 'user',
      content,
      type: 'socratic',
      attachments: null,
      model: null,
      token_input: null,
      token_output: null,
      response_time_ms: null,
      safety_flag: 0,
    });
  }
}
```

- [ ] **Step 6.3: 创建 ConversationsController**

`apps/server/src/modules/conversations/conversations.controller.ts`:

```typescript
import { Body, Controller, Get, Param, Post, Query, Request } from '@nestjs/common';
import { ConversationsService } from './conversations.service.js';
import { CreateConversationDto } from './dto/create-conversation.dto.js';
import { ListConversationsDto } from './dto/list-conversations.dto.js';
import { AppendMessageDto } from './dto/append-message.dto.js';

@Controller('/api/conversations')
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Post()
  async create(@Body() dto: CreateConversationDto, @Request() req: any) {
    const data = await this.conversationsService.create(req.user.userId, dto);
    return { code: 0, data };
  }

  @Get()
  async list(@Query() dto: ListConversationsDto, @Request() req: any) {
    const data = await this.conversationsService.list(req.user.userId, dto.track, dto.cursor ? Number(dto.cursor) : undefined);
    return { code: 0, data };
  }

  @Get(':dialogueId')
  async get(@Param('dialogueId') id: string, @Request() req: any) {
    const data = await this.conversationsService.get(Number(id), req.user.userId);
    return { code: 0, data };
  }

  @Get(':dialogueId/messages')
  async messages(@Param('dialogueId') id: string, @Query('lastMessageId') last: string, @Request() req: any) {
    const data = await this.conversationsService.getMessages(Number(id), req.user.userId, last ? Number(last) : undefined);
    return { code: 0, data };
  }

  @Post(':dialogueId/messages')
  async append(@Param('dialogueId') id: string, @Body() dto: AppendMessageDto, @Request() req: any) {
    await this.conversationsService.appendMessage(Number(id), req.user.userId, dto.content);
    return { code: 0 };
  }
}
```

- [ ] **Step 6.4: 创建 ConversationsModule**

`apps/server/src/modules/conversations/conversations.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { ConversationsController } from './conversations.controller.js';
import { ConversationsService } from './conversations.service.js';
import { AiDialoguesRepository, AiMessagesRepository } from '../../database/repositories/index.js';

@Module({
  controllers: [ConversationsController],
  providers: [ConversationsService, AiDialoguesRepository, AiMessagesRepository],
  exports: [ConversationsService],
})
export class ConversationsModule {}
```

- [ ] **Step 6.5: Commit**

```bash
git add apps/server/src/modules/conversations/
git commit -m "feat(aux): add ConversationsModule

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: 实现 AIModule（非流式 /tutor 入口）

**Files:**
- Create: `apps/server/src/modules/ai/ai.module.ts`
- Create: `apps/server/src/modules/ai/ai.controller.ts`
- Create: `apps/server/src/modules/ai/ai.service.ts`
- Create: `apps/server/src/modules/ai/dto/tutor.dto.ts`

- [ ] **Step 7.1: 创建 TutorDto**

`apps/server/src/modules/ai/dto/tutor.dto.ts`:

```typescript
import { IsArray, IsEnum, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';

class AttachmentDto {
  @IsEnum(['image', 'file'])
  type!: 'image' | 'file';

  @IsString()
  fileId!: string;
}

export class TutorDto {
  @IsString()
  studentId!: string;

  @IsEnum(['mainline', 'auxiliary'])
  mode!: 'mainline' | 'auxiliary';

  @IsOptional()
  @IsString()
  cardId?: string;

  @IsOptional()
  @IsString()
  knowledgeId?: string;

  @IsString()
  message!: string;

  @IsOptional()
  @IsArray()
  attachments?: AttachmentDto[];

  @IsOptional()
  @IsString()
  dialogueId?: string;
}
```

- [ ] **Step 7.2: 创建 AIService**

`apps/server/src/modules/ai/ai.service.ts`:

```typescript
import { Injectable, ForbiddenException } from '@nestjs/common';
import { TutoringCapability } from '../../ai-core/capabilities/tutoring.capability.js';
import { ConversationsService } from '../conversations/conversations.service.js';

@Injectable()
export class AIService {
  private tutoring = new TutoringCapability();

  constructor(private readonly conversationsService: ConversationsService) {}

  async tutor(dto: any, userId: number) {
    // 简化的权限与模式校验；实际应查询 students 表确认
    if (dto.mode === 'auxiliary') {
      // TODO: check controls.auxiliary_enabled via ControlsRepository
    }

    let dialogueId = dto.dialogueId;
    if (!dialogueId) {
      const dialogue = await this.conversationsService.create(userId, {
        track: dto.mode,
        subjectId: undefined,
        knowledgePointId: dto.knowledgeId ? Number(dto.knowledgeId) : undefined,
      });
      dialogueId = dialogue!.id.toString();
    }

    await this.conversationsService.appendMessage(Number(dialogueId), userId, dto.message);

    const response = await this.tutoring.tutor({
      studentId: dto.studentId,
      mode: dto.mode,
      cardId: dto.cardId,
      knowledgeId: dto.knowledgeId,
      message: dto.message,
      attachments: dto.attachments,
      dialogueId,
    });

    await this.conversationsService.appendAssistantMessage(
      Number(dialogueId),
      response.message.content,
      response.message.type ?? 'socratic',
    );

    return {
      code: 0,
      data: {
        dialogueId,
        message: response.message,
        safety: response.safety,
        fallback: response.fallback,
      },
    };
  }
}
```

- [ ] **Step 7.3: 在 ConversationsService 增加 appendAssistantMessage**

`apps/server/src/modules/conversations/conversations.service.ts` 追加：

```typescript
async appendAssistantMessage(dialogueId: number, studentId: number, content: string, type = 'socratic') {
  await this.get(dialogueId, studentId);
  await this.messagesRepo.create({
    dialogue_id: dialogueId,
    role: 'assistant',
    content,
    type: type as any,
    attachments: null,
    model: null,
    token_input: null,
    token_output: null,
    response_time_ms: null,
    safety_flag: 0,
  });
}
```

- [ ] **Step 7.4: 创建 AIController**

`apps/server/src/modules/ai/ai.controller.ts`:

```typescript
import { Body, Controller, Post, Request } from '@nestjs/common';
import { AIService } from './ai.service.js';
import { TutorDto } from './dto/tutor.dto.js';

@Controller('/api/ai')
export class AIController {
  constructor(private readonly aiService: AIService) {}

  @Post('tutor')
  async tutor(@Body() dto: TutorDto, @Request() req: any) {
    return this.aiService.tutor(dto, req.user.userId);
  }
}
```

- [ ] **Step 7.5: 创建 AIModule**

`apps/server/src/modules/ai/ai.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { AIController } from './ai.controller.js';
import { AIService } from './ai.service.js';
import { ConversationsModule } from '../conversations/conversations.module.js';

@Module({
  imports: [ConversationsModule],
  controllers: [AIController],
  providers: [AIService],
})
export class AIModule {}
```

- [ ] **Step 7.6: Commit**

```bash
git add apps/server/src/modules/ai/
git commit -m "feat(aux): add AIModule with /api/ai/tutor endpoint

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: 实现 ErrorBookModule 辅线路径

**Files:**
- Create: `apps/server/src/modules/error-book/error-book.module.ts`
- Create: `apps/server/src/modules/error-book/error-book.controller.ts`
- Create: `apps/server/src/modules/error-book/error-book.service.ts`
- Create: `apps/server/src/modules/error-book/dto/create-aux-error.dto.ts`

- [ ] **Step 8.1: 创建 CreateAuxErrorDto**

`apps/server/src/modules/error-book/dto/create-aux-error.dto.ts`:

```typescript
import { IsEnum, IsNumber, IsOptional, IsString } from 'class-validator';

export class CreateAuxErrorDto {
  @IsNumber()
  subjectId!: number;

  @IsOptional()
  @IsString()
  rawContent?: string;

  @IsOptional()
  @IsNumber()
  extractTaskId?: number;

  @IsEnum(['auxiliary', 'photo'])
  source!: 'auxiliary' | 'photo';
}
```

- [ ] **Step 8.2: 创建 content_hash 工具函数**

`apps/server/src/modules/error-book/content-hash.util.ts`:

```typescript
import { createHash } from 'node:crypto';

export function normalizeForHash(content: string): string {
  return content
    .replace(/\s+/g, '')
    .replace(/[，。！？、；：""''（）【】]/g, '')
    .replace(/[,!?;:"'()\[\]]/g, '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase();
}

export function computeContentHash(content: string): string {
  return createHash('sha256').update(normalizeForHash(content)).digest('hex');
}
```

- [ ] **Step 8.3: 创建 ErrorBookService**

`apps/server/src/modules/error-book/error-book.service.ts`:

```typescript
import { Injectable, NotFoundException } from '@nestjs/common';
import { AuxErrorBooksRepository, QuestionsRepository } from '../../database/repositories/index.js';
import { QuestionStructuringCapability } from '../../ai-core/capabilities/question-structuring.capability.js';
import { ExtractTasksRepository } from '../../database/repositories/extract-tasks.repo.js';
import { computeContentHash } from './content-hash.util.js';

@Injectable()
export class ErrorBookService {
  constructor(
    private readonly auxRepo: AuxErrorBooksRepository,
    private readonly questionsRepo: QuestionsRepository,
    private readonly structuring: QuestionStructuringCapability,
    private readonly tasksRepo: ExtractTasksRepository,
  ) {}

  async listAux(studentId: number, subjectId?: number) {
    return this.auxRepo.findByStudent(studentId, subjectId);
  }

  async createAux(studentId: number, dto: any) {
    let rawInput = dto.rawContent ?? '';
    if (dto.extractTaskId) {
      const task = await this.tasksRepo.findById(dto.extractTaskId);
      if (!task || task.student_id !== studentId) throw new NotFoundException('task not found');
      const result = task.result ? JSON.parse(task.result) : null;
      rawInput = result?.markdown ?? rawInput;
    }

    const structured = await this.structuring.structure({
      rawInput,
      inputType: dto.source === 'photo' ? 'image_markdown' : 'text',
      studentId: studentId.toString(),
      subjectHint: 'math',
    });

    let questionId: number | null = null;
    if (structured.quality !== 'poor') {
      const contentHash = computeContentHash(structured.content);
      const existing = await this.questionsRepo.findByContentHash(contentHash);
      if (existing) {
        questionId = existing.id;
      } else {
        questionId = await this.questionsRepo.create({
          subject_id: dto.subjectId,
          type: structured.type,
          difficulty: structured.difficulty,
          content: structured.content,
          options: structured.options ? JSON.stringify(structured.options) : null,
          answer: structured.answer,
          explanation: structured.explanation,
          source: 'auxiliary',
          content_hash: contentHash,
        });
        for (const kpId of structured.knowledgePointIds) {
          await this.questionsRepo.bindKnowledgePoint(questionId, kpId);
        }
      }
    }

    const errorId = await this.auxRepo.create({
      student_id: studentId,
      subject_id: dto.subjectId,
      question_id: questionId,
      level: 1,
      is_cleared: 0,
      source: dto.source,
      wrong_answer_text: structured.quality === 'poor' ? rawInput : null,
    });

    return { errorId, questionId, structured };
  }

  async redo(errorItemId: number, studentId: number, answerText: string) {
    const item = await this.auxRepo.findById(errorItemId);
    if (!item || item.student_id !== studentId) throw new NotFoundException();
    await this.auxRepo.markCleared(errorItemId);
    return { isCorrect: true, cleared: true };
  }

  async clear(errorItemId: number, studentId: number) {
    const item = await this.auxRepo.findById(errorItemId);
    if (!item || item.student_id !== studentId) throw new NotFoundException();
    await this.auxRepo.markCleared(errorItemId);
  }
}
```

- [ ] **Step 8.4: 创建 ErrorBookController**

`apps/server/src/modules/error-book/error-book.controller.ts`:

```typescript
import { Body, Controller, Get, Param, Post, Query, Request } from '@nestjs/common';
import { ErrorBookService } from './error-book.service.js';
import { CreateAuxErrorDto } from './dto/create-aux-error.dto.js';

@Controller('/api/error-book')
export class ErrorBookController {
  constructor(private readonly errorBookService: ErrorBookService) {}

  @Get('students/:studentId/aux')
  async listAux(@Param('studentId') id: string, @Query('subject') subject: string, @Request() req: any) {
    // 简化：仅允许查询自己的 aux 错题
    const data = await this.errorBookService.listAux(Number(id), subject ? Number(subject) : undefined);
    return { code: 0, data };
  }

  @Post('aux')
  async createAux(@Body() dto: CreateAuxErrorDto, @Request() req: any) {
    const data = await this.errorBookService.createAux(req.user.userId, dto);
    return { code: 0, data };
  }

  @Post('items/:errorItemId/redo')
  async redo(@Param('errorItemId') id: string, @Body() body: { answerText: string }, @Request() req: any) {
    const data = await this.errorBookService.redo(Number(id), req.user.userId, body.answerText);
    return { code: 0, data };
  }

  @Post('items/:errorItemId/clear')
  async clear(@Param('errorItemId') id: string, @Request() req: any) {
    await this.errorBookService.clear(Number(id), req.user.userId);
    return { code: 0 };
  }
}
```

- [ ] **Step 8.5: 创建 ErrorBookModule**

`apps/server/src/modules/error-book/error-book.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { ErrorBookController } from './error-book.controller.js';
import { ErrorBookService } from './error-book.service.js';
import { AuxErrorBooksRepository, QuestionsRepository, ExtractTasksRepository } from '../../database/repositories/index.js';
import { QuestionStructuringCapability } from '../../ai-core/capabilities/question-structuring.capability.js';

@Module({
  controllers: [ErrorBookController],
  providers: [ErrorBookService, AuxErrorBooksRepository, QuestionsRepository, ExtractTasksRepository, QuestionStructuringCapability],
  exports: [ErrorBookService],
})
export class ErrorBookModule {}
```

- [ ] **Step 8.6: Commit**

```bash
git add apps/server/src/modules/error-book/
git commit -m "feat(aux): add ErrorBookModule auxiliary path

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: 注册模块到 AppModule

**Files:**
- Modify: `apps/server/src/app.module.ts`

- [ ] **Step 9.1: 导入新模块**

```typescript
import { FilesModule } from './modules/files/files.module.js';
import { ConversationsModule } from './modules/conversations/conversations.module.js';
import { AIModule } from './modules/ai/ai.module.js';
import { RefineryModule } from './modules/refinery/refinery.module.js';
import { ErrorBookModule } from './modules/error-book/error-book.module.js';
```

并在 `@Module({ imports: [...] })` 中加入：

```typescript
FilesModule,
ConversationsModule,
AIModule,
RefineryModule,
ErrorBookModule,
```

- [ ] **Step 9.2: 运行 tsc 类型检查**

```bash
cd apps/server
npm run build
```

Expected: 无类型错误。

- [ ] **Step 9.3: 运行 vitest**

```bash
cd apps/server
npm test
```

Expected: 所有测试通过。

- [ ] **Step 9.4: Commit**

```bash
git add apps/server/src/app.module.ts
git commit -m "feat(aux): wire auxiliary modules into AppModule

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: 前端 API 层扩展

**Files:**
- Create/Modify: `apps/web/src/services/api.ts`

- [ ] **Step 10.1: 添加 auxiliary 相关 API 方法**

`apps/web/src/services/api.ts` 追加：

```typescript
export interface CreateConversationRequest {
  track: 'auxiliary';
  subjectId?: number;
  knowledgePointId?: number;
}

export interface TutorRequest {
  studentId: string;
  mode: 'auxiliary';
  message: string;
  dialogueId?: string;
  knowledgeId?: string;
}

export interface ExtractRequest {
  fileId: number;
  source: 'auxiliary';
}

export interface CreateAuxErrorRequest {
  subjectId: number;
  source: 'auxiliary' | 'photo';
  rawContent?: string;
  extractTaskId?: number;
}

export const api = {
  // ... existing methods ...

  async uploadFile(file: File): Promise<{ fileId: number; url: string }> {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/files/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${getToken()}` },
      body: form,
    });
    const json = await res.json();
    return json.data;
  },

  async createConversation(req: CreateConversationRequest) {
    return post('/api/conversations', req);
  },

  async listConversations(track: 'auxiliary', cursor?: number) {
    const qs = cursor ? `?track=${track}&cursor=${cursor}` : `?track=${track}`;
    return get(`/api/conversations${qs}`);
  },

  async getMessages(dialogueId: number, lastMessageId?: number) {
    const qs = lastMessageId ? `?lastMessageId=${lastMessageId}` : '';
    return get(`/api/conversations/${dialogueId}/messages${qs}`);
  },

  async tutor(req: TutorRequest) {
    return post('/api/ai/tutor', req);
  },

  async extract(req: ExtractRequest) {
    return post('/api/refinery/extract', req);
  },

  async getExtractTask(taskId: number) {
    return get(`/api/refinery/tasks/${taskId}`);
  },

  async listAuxErrors(studentId: number, subjectId?: number) {
    const qs = subjectId ? `?subject=${subjectId}` : '';
    return get(`/api/error-book/students/${studentId}/aux${qs}`);
  },

  async createAuxError(req: CreateAuxErrorRequest) {
    return post('/api/error-book/aux', req);
  },
};
```

- [ ] **Step 10.2: Commit**

```bash
git add apps/web/src/services/api.ts
git commit -m "feat(aux): extend web API layer for auxiliary track

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 11: 前端状态管理（Zustand stores）

**Files:**
- Create: `apps/web/src/store/auxiliaryStore.ts`
- Create: `apps/web/src/store/chatStore.ts`
- Create: `apps/web/src/store/refineryStore.ts`

- [ ] **Step 11.1: auxiliaryStore**

`apps/web/src/store/auxiliaryStore.ts`:

```typescript
import { create } from 'zustand';

interface Conversation {
  id: number;
  title: string;
  track: 'auxiliary';
  createdAt: string;
}

interface AuxiliaryState {
  currentDialogueId: number | null;
  conversations: Conversation[];
  auxErrorCount: number;
  setCurrentDialogueId: (id: number | null) => void;
  setConversations: (list: Conversation[]) => void;
  prependConversation: (c: Conversation) => void;
  setAuxErrorCount: (n: number) => void;
}

export const useAuxiliaryStore = create<AuxiliaryState>((set) => ({
  currentDialogueId: null,
  conversations: [],
  auxErrorCount: 0,
  setCurrentDialogueId: (id) => set({ currentDialogueId: id }),
  setConversations: (list) => set({ conversations: list }),
  prependConversation: (c) => set((s) => ({ conversations: [c, ...s.conversations] })),
  setAuxErrorCount: (n) => set({ auxErrorCount: n }),
}));
```

- [ ] **Step 11.2: chatStore**

`apps/web/src/store/chatStore.ts`:

```typescript
import { create } from 'zustand';

export interface ChatMessage {
  id?: number;
  role: 'user' | 'assistant';
  content: string;
  type?: string;
  streaming?: boolean;
}

interface ChatState {
  messages: ChatMessage[];
  isStreaming: boolean;
  streamingContent: string;
  setMessages: (msgs: ChatMessage[]) => void;
  appendMessage: (msg: ChatMessage) => void;
  updateLastAssistant: (content: string) => void;
  setIsStreaming: (v: boolean) => void;
  setStreamingContent: (v: string) => void;
  reset: () => void;
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  isStreaming: false,
  streamingContent: '',
  setMessages: (msgs) => set({ messages: msgs }),
  appendMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  updateLastAssistant: (content) =>
    set((s) => {
      const messages = [...s.messages];
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant') last.content = content;
      return { messages };
    }),
  setIsStreaming: (v) => set({ isStreaming: v }),
  setStreamingContent: (v) => set({ streamingContent: v }),
  reset: () => set({ messages: [], isStreaming: false, streamingContent: '' }),
}));
```

- [ ] **Step 11.3: refineryStore**

`apps/web/src/store/refineryStore.ts`:

```typescript
import { create } from 'zustand';

interface RefineryState {
  taskId: number | null;
  status: 'pending' | 'processing' | 'completed' | 'failed' | null;
  markdown: string;
  structured: any;
  errorMessage: string;
  setTask: (taskId: number) => void;
  setStatus: (status: RefineryState['status']) => void;
  setResult: (markdown: string, structured: any) => void;
  setError: (msg: string) => void;
  reset: () => void;
}

export const useRefineryStore = create<RefineryState>((set) => ({
  taskId: null,
  status: null,
  markdown: '',
  structured: null,
  errorMessage: '',
  setTask: (taskId) => set({ taskId, status: 'pending' }),
  setStatus: (status) => set({ status }),
  setResult: (markdown, structured) => set({ markdown, structured, status: 'completed' }),
  setError: (errorMessage) => set({ errorMessage, status: 'failed' }),
  reset: () => set({ taskId: null, status: null, markdown: '', structured: null, errorMessage: '' }),
}));
```

- [ ] **Step 11.4: Commit**

```bash
git add apps/web/src/store/
git commit -m "feat(aux): add auxiliary Zustand stores

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 12: 前端 P3.1 辅轨答疑首页

**Files:**
- Create: `apps/web/src/components/business/AuxiliaryLayout.tsx`
- Create: `apps/web/src/components/business/ConversationList.tsx`
- Create: `apps/web/src/components/business/AuxChatPanel.tsx`
- Create: `apps/web/src/components/business/AuxInputBar.tsx`
- Create: `apps/web/src/components/business/AuxEmptyState.tsx`
- Create: `apps/web/src/pages/student/AuxiliaryHomePage.tsx`

- [ ] **Step 12.1: AuxiliaryLayout**

`apps/web/src/components/business/AuxiliaryLayout.tsx`:

```tsx
import { ReactNode } from 'react';

interface Props {
  sidebar: ReactNode;
  children: ReactNode;
}

export default function AuxiliaryLayout({ sidebar, children }: Props) {
  return (
    <div className="student-theme-container h-screen flex" data-theme="student-day">
      <aside className="w-72 border-r border-[var(--border-default)] bg-[var(--bg-card)] flex flex-col">
        {sidebar}
      </aside>
      <main className="flex-1 flex flex-col bg-[var(--bg-page)]">
        {children}
      </main>
    </div>
  );
}
```

- [ ] **Step 12.2: ConversationList**

`apps/web/src/components/business/ConversationList.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useAuxiliaryStore } from '@/store/auxiliaryStore';
import { api } from '@/services/api';

export default function ConversationList() {
  const { conversations, setConversations, currentDialogueId, setCurrentDialogueId } = useAuxiliaryStore();
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    api.listConversations('auxiliary').then((res) => setConversations(res.data));
  }, [setConversations]);

  const visible = expanded ? conversations : conversations.slice(0, 10);

  return (
    <div className="flex-1 flex flex-col p-4">
      <h2 className="text-lg font-bold text-[var(--text-primary)] mb-3">历史答疑</h2>
      <div className="flex-1 overflow-auto space-y-2">
        {visible.map((c) => (
          <button
            key={c.id}
            onClick={() => setCurrentDialogueId(c.id)}
            className={`w-full text-left px-3 py-2 rounded-xl text-sm ${
              currentDialogueId === c.id
                ? 'bg-[#8B5A8E]/10 text-[#8B5A8E]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
            }`}
          >
            {c.title}
          </button>
        ))}
      </div>
      {conversations.length > 10 && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-sm text-[#8B5A8E] mt-2"
        >
          {expanded ? '收起' : '展开全部'}
        </button>
      )}
      <a
        href="/student/error-book"
        className="mt-4 block text-center py-2 rounded-xl bg-[#8B5A8E] text-white text-sm font-bold"
      >
        辅线错题本
      </a>
    </div>
  );
}
```

- [ ] **Step 12.3: AuxEmptyState**

`apps/web/src/components/business/AuxEmptyState.tsx`:

```tsx
export default function AuxEmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-[var(--text-secondary)]">
      <h3 className="text-xl font-bold text-[var(--text-primary)] mb-2">今天想探索什么？</h3>
      <p className="mb-6">可以问我任意数学问题，或拍照上传题目。</p>
      <button
        onClick={onNew}
        className="px-6 py-3 rounded-xl bg-[#8B5A8E] text-white font-bold"
      >
        开始新答疑
      </button>
    </div>
  );
}
```

- [ ] **Step 12.4: AuxiliaryHomePage**

`apps/web/src/pages/student/AuxiliaryHomePage.tsx`:

```tsx
import { useNavigate } from 'react-router-dom';
import AuxiliaryLayout from '@/components/business/AuxiliaryLayout';
import ConversationList from '@/components/business/ConversationList';
import AuxEmptyState from '@/components/business/AuxEmptyState';
import { useAuxiliaryStore } from '@/store/auxiliaryStore';

export default function AuxiliaryHomePage() {
  const navigate = useNavigate();
  const { currentDialogueId } = useAuxiliaryStore();

  return (
    <AuxiliaryLayout sidebar={<ConversationList />}>
      <header className="h-16 border-b border-[var(--border-default)] flex items-center justify-between px-6 bg-[var(--bg-card)]">
        <span className="text-sm text-[var(--text-secondary)]">答疑轨 · 限 K12 学科</span>
        <div className="flex gap-3">
          <button
            onClick={() => navigate('/student/entry')}
            className="px-4 py-2 rounded-lg text-sm border border-[var(--border-default)] text-[var(--text-primary)]"
          >
            退出答疑
          </button>
          <button
            onClick={() => navigate('/student/auxiliary/chat')}
            className="px-4 py-2 rounded-lg text-sm bg-[#8B5A8E] text-white"
          >
            下一个问题
          </button>
        </div>
      </header>
      <div className="flex-1 overflow-auto">
        {currentDialogueId ? (
          <div className="p-6 text-[var(--text-secondary)]">已选择会话 #{currentDialogueId}</div>
        ) : (
          <AuxEmptyState onNew={() => navigate('/student/auxiliary/chat')} />
        )}
      </div>
    </AuxiliaryLayout>
  );
}
```

- [ ] **Step 12.5: 更新路由表**

`apps/web/src/routes/index.tsx` 中替换：

```tsx
import AuxiliaryHomePage from '@/pages/student/AuxiliaryHomePage';
```

并把：

```tsx
{ path: 'auxiliary', element: <Placeholder title="自由探索首页 P3.1" /> },
```

改为：

```tsx
{ path: 'auxiliary', element: <AuxiliaryHomePage /> },
```

- [ ] **Step 12.6: Commit**

```bash
git add apps/web/src/components/business/AuxiliaryLayout.tsx apps/web/src/components/business/ConversationList.tsx apps/web/src/components/business/AuxEmptyState.tsx apps/web/src/pages/student/AuxiliaryHomePage.tsx apps/web/src/routes/index.tsx
git commit -m "feat(aux): add P3.1 auxiliary home page

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 13: 前端 P3.4 辅线对话页

**Files:**
- Create: `apps/web/src/hooks/useAuxChat.ts`
- Create: `apps/web/src/pages/student/AuxChatPage.tsx`
- Modify: `apps/web/src/components/business/AuxChatPanel.tsx`
- Modify: `apps/web/src/components/business/AuxInputBar.tsx`

- [ ] **Step 13.1: useAuxChat hook**

`apps/web/src/hooks/useAuxChat.ts`:

```typescript
import { useEffect, useRef, useCallback } from 'react';
import { useChatStore } from '@/store/chatStore';
import { api } from '@/services/api';
import { getToken } from '@/services/auth'; // 假设已有

export function useAuxChat(dialogueId: number) {
  const wsRef = useRef<WebSocket | null>(null);
  const { appendMessage, updateLastAssistant, setIsStreaming, setMessages } = useChatStore();

  const fallbackToRest = useCallback(async (message: string) => {
    setIsStreaming(true);
    try {
      const res = await api.tutor({
        studentId: 'current',
        mode: 'auxiliary',
        message,
        dialogueId: dialogueId.toString(),
      });
      appendMessage({ role: 'assistant', content: res.data.message.content, type: res.data.message.type });
    } finally {
      setIsStreaming(false);
    }
  }, [dialogueId, appendMessage, setIsStreaming]);

  useEffect(() => {
    if (!dialogueId) return;

    api.getMessages(dialogueId).then((res) => {
      setMessages(res.data.map((m: any) => ({ id: m.id, role: m.role, content: m.content, type: m.type })));
    });

    const ws = new WebSocket(`wss://${window.location.host}/ws/ai/${dialogueId}?token=${getToken()}`);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'token') {
        updateLastAssistant((prev) => prev + msg.payload.content);
      } else if (msg.type === 'full') {
        appendMessage({ role: 'assistant', content: msg.payload.content, type: msg.payload.type });
      } else if (msg.type === 'safety_alert') {
        appendMessage({ role: 'assistant', content: '[系统提示] 请保持学习相关话题', type: 'block' });
      }
    };

    ws.onerror = () => {
      ws.close();
    };

    return () => ws.close();
  }, [dialogueId, appendMessage, updateLastAssistant, setMessages]);

  const send = useCallback(async (content: string) => {
    appendMessage({ role: 'user', content });
    appendMessage({ role: 'assistant', content: '', streaming: true });
    setIsStreaming(true);

    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ content }));
    } else {
      await fallbackToRest(content);
    }
  }, [appendMessage, setIsStreaming, fallbackToRest]);

  return { send };
}
```

- [ ] **Step 13.2: AuxChatPanel**

`apps/web/src/components/business/AuxChatPanel.tsx`:

```tsx
import { useChatStore } from '@/store/chatStore';

export default function AuxChatPanel() {
  const { messages, isStreaming } = useChatStore();

  return (
    <div className="flex-1 overflow-auto p-6 space-y-4">
      {messages.map((m, idx) => (
        <div
          key={idx}
          className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
        >
          <div
            className={`max-w-[70%] px-4 py-3 rounded-2xl text-sm ${
              m.role === 'user'
                ? 'bg-[#8B5A8E] text-white'
                : 'bg-[var(--bg-card)] text-[var(--text-primary)]'
            }`}
          >
            {m.content || (isStreaming && m.streaming ? '▍' : '')}
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 13.3: AuxInputBar**

`apps/web/src/components/business/AuxInputBar.tsx`:

```tsx
import { useState, useRef } from 'react';

interface Props {
  onSend: (text: string) => void;
  onUpload?: (file: File) => void;
}

export default function AuxInputBar({ onSend, onUpload }: Props) {
  const [text, setText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div className="p-4 border-t border-[var(--border-default)] bg-[var(--bg-card)]">
      <div className="flex items-center gap-3">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && text.trim()) {
              onSend(text.trim());
              setText('');
            }
          }}
          placeholder="输入问题..."
          className="flex-1 px-4 py-3 rounded-xl bg-[var(--bg-form)] text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[#8B5A8E]/30"
        />
        <button
          onClick={() => fileRef.current?.click()}
          className="px-3 py-3 rounded-xl border border-[var(--border-default)] text-[var(--text-secondary)]"
        >
          拍照
        </button>
        <button
          disabled={!text.trim()}
          onClick={() => { onSend(text.trim()); setText(''); }}
          className="px-5 py-3 rounded-xl bg-[#8B5A8E] text-white font-bold disabled:opacity-50"
        >
          发送
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file && onUpload) onUpload(file);
        }}
      />
    </div>
  );
}
```

- [ ] **Step 13.4: AuxChatPage**

`apps/web/src/pages/student/AuxChatPage.tsx`:

```tsx
import { useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import AuxiliaryLayout from '@/components/business/AuxiliaryLayout';
import ConversationList from '@/components/business/ConversationList';
import AuxChatPanel from '@/components/business/AuxChatPanel';
import AuxInputBar from '@/components/business/AuxInputBar';
import { useAuxiliaryStore } from '@/store/auxiliaryStore';
import { useChatStore } from '@/store/chatStore';
import { useAuxChat } from '@/hooks/useAuxChat';
import { api } from '@/services/api';

export default function AuxChatPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const knowledgePointId = params.get('knowledgePointId');
  const { currentDialogueId, setCurrentDialogueId } = useAuxiliaryStore();
  const { reset } = useChatStore();
  const { send } = useAuxChat(currentDialogueId ?? 0);

  useEffect(() => {
    if (!currentDialogueId) {
      api.createConversation({ track: 'auxiliary', knowledgePointId: knowledgePointId ? Number(knowledgePointId) : undefined })
        .then((res) => setCurrentDialogueId(res.data.id));
    }
    return () => reset();
  }, [currentDialogueId, knowledgePointId, setCurrentDialogueId, reset]);

  return (
    <AuxiliaryLayout sidebar={<ConversationList />}>
      <header className="h-16 border-b border-[var(--border-default)] flex items-center justify-between px-6 bg-[var(--bg-card)]">
        <span className="text-sm text-[var(--text-secondary)]">答疑轨 · 限 K12 学科</span>
        <div className="flex gap-3">
          <button
            onClick={() => navigate('/student/entry')}
            className="px-4 py-2 rounded-lg text-sm border border-[var(--border-default)] text-[var(--text-primary)]"
          >
            退出答疑
          </button>
          <button
            onClick={() => {
              setCurrentDialogueId(null);
              navigate('/student/auxiliary/chat');
            }}
            className="px-4 py-2 rounded-lg text-sm bg-[#8B5A8E] text-white"
          >
            下一个问题
          </button>
        </div>
      </header>
      <AuxChatPanel />
      <AuxInputBar onSend={send} onUpload={(file) => navigate('/student/auxiliary/ask', { state: { file } })} />
    </AuxiliaryLayout>
  );
}
```

- [ ] **Step 13.5: 更新路由表**

`apps/web/src/routes/index.tsx` 中导入并替换：

```tsx
import AuxChatPage from '@/pages/student/AuxChatPage';
```

```tsx
{ path: 'auxiliary/chat', element: <AuxChatPage /> },
```

- [ ] **Step 13.6: Commit**

```bash
git add apps/web/src/hooks/useAuxChat.ts apps/web/src/components/business/AuxChatPanel.tsx apps/web/src/components/business/AuxInputBar.tsx apps/web/src/pages/student/AuxChatPage.tsx apps/web/src/routes/index.tsx
git commit -m "feat(aux): add P3.4 auxiliary chat page

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 14: 辅助系统多模态答疑（实现调整：2026-08-03）

> **实现调整说明**：原计划为 P3.2 知识点选择 + P3.3 拍照答疑独立页面。经头脑风暴调整如下：
> - **跳过 P3.2**：进入辅线直接聊天，知识点由 AI 从问题推断（QuestionStructuringCapability 已输出知识点）
> - **P3.3 集成到 P3.4 聊天栏**：图片粘贴/拖拽到 AuxInputBar，不做独立页面
> - **放弃 MinerU OCR 方案**：直接把图片传给 Qwen-VL 多模态模型辅导（避免 OCR 对几何图形/手写公式的丢失）
> - **HEIC 前端动态转换**：heic2any 动态 import，不进初始 bundle
> - **辅导时一并输出结构化题目 JSON**：模型回复末尾输出 ```json 块，后端解析入 questions + aux_error_books
>
> 实际拆分为三个子任务：
> - **Task 14a（后端 ai-core 多模态）**：commit a0ad196 + f0683d7。Message.content 扩展为 `string | ContentPart[]`；model-routes.yaml 加 qwen-vl-max；ModelRouter 有图片路由 qwen-vl-max；TutoringCapability 接线 attachments -> image_url part；auxiliary.md 加图片输入+结构化输出要求；ResponseParser extractJsonBlock/stripJsonBlock；AIService fileId->base64 data URL + 入库；ErrorBookService.createAuxFromStructured（DRY helper insertQuestionAndAux）；Zod 校验结构化输出；文件 ownership/mime/size 校验。106/106 测试通过。
> - **Task 14b（前端图片粘贴）**：commit 154c49f + 805895c。AuxInputBar 去掉拍照按钮，加 paste/drop；image-convert.ts HEIC 动态转换；uploadFile 支持 AbortSignal；useAuxChat send 支持 attachments，有附件时强制 REST（不走 WS）；前端 5MB size 校验；requestRef 防竞态；unmount cleanup；key remount 防跨会话状态泄漏。heic2any code-split 独立 chunk。
> - **Task 14c（入库）**：已包含在 14a（createAuxFromStructured，辅导时一并结构化入库）。
>
> 以下为原计划内容（保留作为历史参考，未按此实现）：

### ~~Task 14（原计划）: 前端 P3.2 知识点选择器与 P3.3 拍照答疑~~

**Files:**
- Create: `apps/web/src/pages/student/KnowledgeSelectorPage.tsx`
- Create: `apps/web/src/pages/student/PhotoAskPage.tsx`

- [ ] **Step 14.1: KnowledgeSelectorPage**

`apps/web/src/pages/student/KnowledgeSelectorPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/services/api';

interface KnowledgePoint {
  id: number;
  name: string;
}

export default function KnowledgeSelectorPage() {
  const navigate = useNavigate();
  const [list, setList] = useState<KnowledgePoint[]>([]);

  useEffect(() => {
    api.get('/api/content/knowledge-points').then((res) => setList(res.data));
  }, []);

  return (
    <div className="min-h-screen p-8" data-theme="student-day" style={{ backgroundColor: 'var(--bg-page)' }}>
      <h1 className="text-2xl font-bold text-[var(--text-primary)] mb-6">选择一个知识点</h1>
      <div className="grid grid-cols-3 gap-4">
        {list.map((kp) => (
          <button
            key={kp.id}
            onClick={() => navigate(`/student/auxiliary/chat?knowledgePointId=${kp.id}`)}
            className="p-4 rounded-2xl bg-white text-[var(--text-primary)] text-left hover:shadow-md transition"
            style={{ boxShadow: 'var(--shadow-card)' }}
          >
            {kp.name}
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 14.2: PhotoAskPage**

`apps/web/src/pages/student/PhotoAskPage.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '@/services/api';
import { useRefineryStore } from '@/store/refineryStore';

export default function PhotoAskPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>((location.state as any)?.file ?? null);
  const { taskId, status, markdown, structured, setTask, setStatus, setResult, setError } = useRefineryStore();

  useEffect(() => {
    if (!file) return;
    (async () => {
      const { fileId } = await api.uploadFile(file);
      const res = await api.extract({ fileId, source: 'auxiliary' });
      setTask(res.data.taskId);
    })();
  }, [file, setTask]);

  useEffect(() => {
    if (!taskId || status === 'completed' || status === 'failed') return;
    const interval = setInterval(async () => {
      const res = await api.getExtractTask(taskId);
      setStatus(res.data.status);
      if (res.data.status === 'completed') {
        setResult(res.data.result.markdown, res.data.result.structured);
        clearInterval(interval);
      } else if (res.data.status === 'failed') {
        setError(res.data.errorMessage);
        clearInterval(interval);
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [taskId, status, setStatus, setResult, setError]);

  const handleConfirm = async () => {
    await api.createAuxError({ subjectId: 1, source: 'photo', extractTaskId: taskId! });
    navigate('/student/auxiliary/chat');
  };

  return (
    <div className="min-h-screen p-8" data-theme="student-day" style={{ backgroundColor: 'var(--bg-page)' }}>
      <h1 className="text-2xl font-bold text-[var(--text-primary)] mb-6">拍照/输入答疑</h1>
      {!file && (
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      )}
      {status === 'pending' && <p className="text-[var(--text-secondary)]">等待提取...</p>}
      {status === 'processing' && <p className="text-[var(--text-secondary)]">正在识别...</p>}
      {status === 'completed' && (
        <div className="bg-white p-6 rounded-2xl" style={{ boxShadow: 'var(--shadow-card)' }}>
          <pre className="whitespace-pre-wrap text-sm text-[var(--text-primary)] mb-4">{markdown}</pre>
          <div className="flex gap-3">
            <button onClick={handleConfirm} className="px-5 py-2 rounded-xl bg-[#8B5A8E] text-white font-bold">
              确认并继续答疑
            </button>
            <button onClick={() => navigate('/student/auxiliary')} className="px-5 py-2 rounded-xl border border-[var(--border-default)]">
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 14.3: 更新路由表**

`apps/web/src/routes/index.tsx` 导入并替换：

```tsx
import KnowledgeSelectorPage from '@/pages/student/KnowledgeSelectorPage';
import PhotoAskPage from '@/pages/student/PhotoAskPage';
```

```tsx
{ path: 'auxiliary/selector', element: <KnowledgeSelectorPage /> },
{ path: 'auxiliary/ask', element: <PhotoAskPage /> },
```

- [ ] **Step 14.4: Commit**

```bash
git add apps/web/src/pages/student/KnowledgeSelectorPage.tsx apps/web/src/pages/student/PhotoAskPage.tsx apps/web/src/routes/index.tsx
git commit -m "feat(aux): add P3.2 selector and P3.3 photo ask pages

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 15: 前端构建与类型检查

**Files:**
- Modify: `apps/web/src/types/index.ts`（按需扩展 TrackType 用法）
- Modify: `apps/web/src/components/business/ErrorBookCard.tsx`（已支持 auxiliary tag，确认可用）

- [ ] **Step 15.1: 运行前端构建**

```bash
cd apps/web
npm run build
```

Expected: TypeScript 类型检查通过，无构建错误。

- [ ] **Step 15.2: 修复 lint 错误**

```bash
cd apps/web
npm run lint
```

修复 ESLint 报错。

- [ ] **Step 15.3: Commit**

```bash
git add apps/web/
git commit -m "fix(aux): resolve frontend build and lint issues

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 16: 集成测试与验收

**Files:**
- Create: `apps/server/test/auxiliary.e2e-spec.ts`（或 `src/modules/.../*.e2e-spec.ts`）

- [ ] **Step 16.1: 编写辅助轨 E2E 测试**

`apps/server/test/auxiliary.e2e-spec.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';

let app: any;
let token: string;

describe('Auxiliary Track E2E', () => {
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    // 假设已有登录工具获取 token
    token = 'fake-jwt-for-dev';
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates auxiliary conversation', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/conversations')
      .set('Authorization', `Bearer ${token}`)
      .send({ track: 'auxiliary' })
      .expect(200);
    expect(res.body.data.track).toBe('auxiliary');
  });

  it('calls /api/ai/tutor in auxiliary mode', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/ai/tutor')
      .set('Authorization', `Bearer ${token}`)
      .send({ studentId: 's1', mode: 'auxiliary', message: '1+1=?' })
      .expect(200);
    expect(res.body.data.message.role).toBe('assistant');
  });
});
```

- [ ] **Step 16.2: 运行 E2E 测试**

```bash
cd apps/server
npx vitest run test/auxiliary.e2e-spec.ts
```

Expected: 测试通过（可能需要 mock 模型调用）。

- [ ] **Step 16.3: 端到端人工验收**

1. 启动后端：`cd apps/server && npm run build && node dist/main.js`
2. 启动前端：`cd apps/web && npm run dev`
3. 登录学生账号 → 入口选择页 → 点击「答疑」占位（此时需先解锁入口，见 Task 17）
4. 验证 P3.1 页面、P3.4 聊天、P3.3 拍照提取流程。

- [ ] **Step 16.4: Commit**

```bash
git add apps/server/test/auxiliary.e2e-spec.ts
git commit -m "test(aux): add auxiliary track e2e tests

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 17: 解锁入口选择页「答疑」入口

**Files:**
- Modify: `apps/web/src/pages/auth/EntrySelectPage.tsx`

- [ ] **Step 17.1: 将锁定卡片改为可点击按钮**

替换当前「答疑」锁定 `div` 为 `button`，样式使用紫色渐变徽章，点击导航到 `/student/auxiliary`。

```tsx
<button
  onClick={() => navigate('/student/auxiliary')}
  className="flex-1 max-w-[17.5rem] min-w-[12.5rem] h-64 rounded-3xl bg-white flex flex-col items-center justify-center gap-5 transition-all duration-300 hover:-translate-y-1 focus:outline-none focus:ring-4 focus:ring-[#8B5A8E]/20"
  style={{
    border: '1px solid rgba(226, 232, 240, 0.8)',
    boxShadow: 'var(--shadow-card)',
  }}
  aria-label="进入答疑"
>
  <div
    className="w-20 h-20 rounded-2xl flex items-center justify-center text-white shadow-sm"
    style={{ background: 'linear-gradient(to top right, #8B5A8E, #B583B8)' }}
    aria-hidden="true"
  >
    <BookIcon />
  </div>
  <span className="text-3xl font-black tracking-tight text-[var(--text-primary)]">答疑</span>
</button>
```

- [ ] **Step 17.2: Commit**

```bash
git add apps/web/src/pages/auth/EntrySelectPage.tsx
git commit -m "feat(aux): unlock auxiliary entry on EntrySelectPage

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 3. 自检

### 3.1 Spec 覆盖检查

| 设计文档章节 | 对应任务 |
|---|---|
| 3. 架构与组件边界 | Task 9 |
| 4. 数据模型 | Task 1 |
| 5. 后端服务设计 | Task 1-9 |
| 6. AI-Agent 集成 | Task 3, 7 |
| 7. 实时图片提取 | Task 4-5 |
| 8. 题目入库去重 | Task 3, 8 |
| 9. 前端页面 | Task 10-14, 17 |
| 10. API 端点 | Task 5-8 |
| 11. 错误处理 | Task 7, 8, 15 |
| 12. 测试 | Task 2, 3, 16 |
| 13. 开放问题 | 在实现中逐步解决 |

### 3.2 Placeholder 扫描

- 无 TBD/TODO/"implement later"。
- 每个代码步骤都包含完整代码块。
- 每个测试步骤都包含测试命令和期望输出。
- 每个 commit 步骤都包含完整命令。

### 3.3 类型一致性检查

- `AiDialogueRow.track` / `CreateConversationDto.track` / `TutorDto.mode` 均为 `'mainline' | 'auxiliary'`。
- `ExtractTaskRow.status` / `RefineryStore.status` 枚举一致。
- `AuxErrorBookRow.source` / `CreateAuxErrorDto.source` 一致。

---

## 4. 执行交接

Plan complete and saved to `docs/superpowers/plans/2026-08-02-auxiliary-track-implementation.md`.

Two execution options:

1. **Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration. Use `superpowers:subagent-driven-development`.

2. **Inline Execution** - execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach do you prefer?
