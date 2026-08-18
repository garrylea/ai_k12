# 管理员中枢（子项目 2）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 管理台（模型池/路由表动态配置即保存即生效、封禁连封、站内消息、管理员 AI 聊天、dashboard、改密）+ 家长台消息中心。

**Architecture:** 方案 A--`llm_models`/`llm_routes` 落库为运行时真源，新 `ModelConfigRegistry` 单例内存快照承接（DB 空/失败回落 YAML）；apiKey 改为随模型条目流经 `ModelConfig`（AES-256-GCM 加密落库）；封禁走 `BanRegistry` 内存 Set + AuthMiddleware 即时拦截。规格：`docs/superpowers/specs/2026-08-18-admin-console-design.md`。

**Tech Stack:** NestJS 10 + mysql2 + Zod + Vitest；AES-256-GCM（node:crypto）；React Router 6 + Vite + TS + Tailwind + SSE。

**重要背景（工程师必读）：**
- server 命令在 `apps/server/`：`npm test`（vitest）、`npm run build`（tsc）、`npx tsx src/scripts/<x>.ts`（脚本）。web 命令在 `apps/web/`：`npm run build`、`npm run lint`。
- 响应约定：成功 `{code:0,data}`（ResponseInterceptor），异常 `{code,message,data:null}`（HttpExceptionFilter 透传 `...rest`）。controller return 数据、throw `new HttpException({code,message}, status)`。
- 已有可复用：`RolesGuard`+`@Roles()`（`common/guards|decorators`）、`AdminsRepository`、`ParentsRepository`、`StudentsRepository`（含 setActive/findByParentId）、`AuthMiddleware`（`common/middleware/auth.middleware.ts`）、SSE 模式（`ai.controller.ts` tutorStream）、前端 `RequireRole`/base 组件/`streamTutorEvents`。
- DB：`ai_k12/ai_k12@localhost/ai_k12`（`.env` 的 `DB_*`）。迁移放 `tools/db/migrations/`。
- ai-core 关键事实：`config.ts` 的 `routeConfig`（YAML 一次性加载）；各 capability `new ModelRouter()`；`ModelClient.getProvider(provider)` 按 provider 名缓存 adapter，apiKey 来自 `getApiKeyByProvider`（env）；KimiClient 就是标准 `/v1/chat/completions` OpenAI 风格且用 `request.model.baseUrl`。
- 工作分支：`feat/parent-admin-account-system`（子项目 1 未合 master，本子项目叠加其上）。提交只 add 本 task 文件，禁 `git add -A`。

---

### Task 1: DB 迁移（5 张表）+ schema + DB 设计文档

**Files:**
- Create: `tools/db/migrations/2026-08-18_add_admin_console.sql`
- Modify: `tools/db/schema.sql`、`docs/K12智学系统-数据库设计文档.md`

- [ ] **Step 1: 写迁移并执行**

```sql
-- 2026-08-18 管理员中枢：模型池/路由/站内消息/管理员聊天五张表。一次性运行。

CREATE TABLE IF NOT EXISTS llm_models (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  model_key VARCHAR(50) NOT NULL,
  name VARCHAR(100) NOT NULL,
  provider_type VARCHAR(20) NOT NULL,
  model_id VARCHAR(100) NOT NULL,
  base_url VARCHAR(255) NOT NULL,
  api_key VARCHAR(500) NOT NULL,
  context_window INT NOT NULL DEFAULT 131072,
  max_output_tokens INT NOT NULL DEFAULT 16384,
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_llm_models_key (model_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS llm_routes (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  scene VARCHAR(30) NOT NULL,
  subject VARCHAR(20) NOT NULL,
  primary_model_key VARCHAR(50) NOT NULL,
  fallback_model_key VARCHAR(50) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_llm_routes (scene, subject),
  CONSTRAINT fk_llm_routes_primary FOREIGN KEY (primary_model_key) REFERENCES llm_models (model_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS parent_messages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  parent_id BIGINT DEFAULT NULL,
  type VARCHAR(20) NOT NULL,
  title VARCHAR(100) NOT NULL,
  content TEXT NOT NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  read_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_parent_messages_parent (parent_id, is_read)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS message_reads (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  parent_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  read_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_message_reads (parent_id, message_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_dialogues (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  admin_id BIGINT NOT NULL,
  model_key VARCHAR(50) NOT NULL,
  title VARCHAR(200) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_admin_dialogues_admin (admin_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_messages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  dialogue_id BIGINT NOT NULL,
  role VARCHAR(10) NOT NULL,
  content TEXT NOT NULL,
  reasoning TEXT DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_admin_messages_dialogue (dialogue_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Run: `mysql -u ai_k12 -pai_k12 ai_k12 < tools/db/migrations/2026-08-18_add_admin_console.sql && mysql -u ai_k12 -pai_k12 ai_k12 -e "SHOW TABLES LIKE 'llm%'; SHOW TABLES LIKE '%messages'; SHOW TABLES LIKE 'admin%';"`
Expected: 6 张新表列出（llm_models/llm_routes/parent_messages/message_reads/admin_dialogues/admin_messages）。

- [ ] **Step 2: schema.sql 同步**（§合适位置追加上述全部建表块，头部版本 v1.7->v1.8）
- [ ] **Step 3: DB 设计文档**（版本日志 v1.8 + 五表字段表，格式对齐 parents 节）
- [ ] **Step 4: Commit**

```bash
git add tools/db/migrations/2026-08-18_add_admin_console.sql tools/db/schema.sql docs/K12智学系统-数据库设计文档.md
git commit -m "feat(db): 管理员中枢五张表迁移（模型池/路由/消息/管理员聊天）"
```

---

### Task 2: AES-256-GCM 加解密工具（TDD）

**Files:**
- Create: `apps/server/src/common/utils/api-key-crypto.ts`
- Test: `apps/server/src/common/utils/api-key-crypto.test.ts`

- [ ] **Step 1: 失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { encryptApiKey, decryptApiKey } from './api-key-crypto';

describe('api-key-crypto', () => {
  it('加解密往返一致，密文不含明文', () => {
    const plain = 'sk-test-1234567890';
    const enc = encryptApiKey(plain);
    expect(enc).not.toContain(plain);
    expect(decryptApiKey(enc)).toBe(plain);
  });

  it('相同明文两次加密产生不同密文（随机 IV）', () => {
    expect(encryptApiKey('sk-x')).not.toBe(encryptApiKey('sk-x'));
  });

  it('篡改密文解密失败抛错', () => {
    const enc = encryptApiKey('sk-x');
    expect(() => decryptApiKey(enc.slice(0, -4) + 'AAAA')).toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**（模块不存在）
- [ ] **Step 3: 实现**

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * llm_models.api_key 的 AES-256-GCM 加解密。密钥来自 .env 的 LLM_CONFIG_ENC_KEY
 * （32 字节 hex，64 个 hex 字符）；未设置时用确定性 dev key（仅本机开发，生产必须设置）。
 * 密文格式：base64(iv[12] + authTag[16] + ciphertext)。
 */
const DEV_KEY_HEX = '6b31326465766b657930303130323033303430353036303730383039306162'; // 'k12devkey' pad, dev only
const KEY = Buffer.from(process.env.LLM_CONFIG_ENC_KEY || DEV_KEY_HEX, 'hex');

if (KEY.length !== 32) {
  throw new Error('LLM_CONFIG_ENC_KEY 必须是 64 个 hex 字符（32 字节）');
}

export function encryptApiKey(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptApiKey(cipherText: string): string {
  const raw = Buffer.from(cipherText, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const enc = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
```

`.env.example` 追加：`LLM_CONFIG_ENC_KEY=`（注释：64 hex 字符，可用 `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` 生成）。

- [ ] **Step 4: 测试过 + Commit**（`git add apps/server/src/common/utils/ .env.example`，`feat(server): apiKey AES-256-GCM 加解密工具`）

---

### Task 3: LlmModels/LlmRoutes/AdminMessages Repository

**Files:**
- Create: `apps/server/src/database/repositories/llm-models.repo.ts`、`llm-routes.repo.ts`、`parent-messages.repo.ts`、`admin-chat.repo.ts`
- Modify: `apps/server/src/database/repositories/index.ts`

- [ ] **Step 1: `llm-models.repo.ts`**

```ts
import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { encryptApiKey, decryptApiKey } from '../../common/utils/api-key-crypto.js';

export interface LlmModelRow extends RowDataPacket {
  id: number; model_key: string; name: string; provider_type: string;
  model_id: string; base_url: string; api_key: string;
  context_window: number; max_output_tokens: number; is_enabled: number;
}

export interface LlmModel {
  modelKey: string; name: string; providerType: string; modelId: string;
  baseUrl: string; apiKey: string; contextWindow: number; maxOutputTokens: number; isEnabled: boolean;
}

@Injectable()
export class LlmModelsRepository {
  constructor(@Inject('DATABASE_POOL') private pool: Pool) {}

  async listAll(): Promise<LlmModel[]> {
    const [rows] = await this.pool.execute<LlmModelRow[]>('SELECT * FROM llm_models ORDER BY id');
    return rows.map((r) => this.mapRow(r));
  }

  async listEnabled(): Promise<LlmModel[]> {
    const [rows] = await this.pool.execute<LlmModelRow[]>(
      'SELECT * FROM llm_models WHERE is_enabled = 1 ORDER BY id');
    return rows.map((r) => this.mapRow(r));
  }

  async findByKey(modelKey: string): Promise<LlmModel | null> {
    const [rows] = await this.pool.execute<LlmModelRow[]>(
      'SELECT * FROM llm_models WHERE model_key = ?', [modelKey]);
    return rows.length > 0 ? this.mapRow(rows[0]) : null;
  }

  async create(data: Omit<LlmModel, 'isEnabled'> & { isEnabled?: boolean }): Promise<void> {
    await this.pool.execute(
      `INSERT INTO llm_models (model_key, name, provider_type, model_id, base_url, api_key, context_window, max_output_tokens, is_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [data.modelKey, data.name, data.providerType, data.modelId, data.baseUrl,
       encryptApiKey(data.apiKey), data.contextWindow, data.maxOutputTokens, data.isEnabled === false ? 0 : 1]);
  }

  async update(modelKey: string, data: Partial<Omit<LlmModel, 'isEnabled'>>): Promise<void> {
    const sets: string[] = []; const args: unknown[] = [];
    if (data.name !== undefined) { sets.push('name = ?'); args.push(data.name); }
    if (data.providerType !== undefined) { sets.push('provider_type = ?'); args.push(data.providerType); }
    if (data.modelId !== undefined) { sets.push('model_id = ?'); args.push(data.modelId); }
    if (data.baseUrl !== undefined) { sets.push('base_url = ?'); args.push(data.baseUrl); }
    if (data.apiKey !== undefined && data.apiKey !== '') { sets.push('api_key = ?'); args.push(encryptApiKey(data.apiKey)); }
    if (data.contextWindow !== undefined) { sets.push('context_window = ?'); args.push(data.contextWindow); }
    if (data.maxOutputTokens !== undefined) { sets.push('max_output_tokens = ?'); args.push(data.maxOutputTokens); }
    if (sets.length === 0) return;
    args.push(modelKey);
    await this.pool.execute(`UPDATE llm_models SET ${sets.join(', ')} WHERE model_key = ?`, args);
  }

  async setEnabled(modelKey: string, enabled: boolean): Promise<void> {
    await this.pool.execute('UPDATE llm_models SET is_enabled = ? WHERE model_key = ?', [enabled ? 1 : 0, modelKey]);
  }

  private mapRow(r: LlmModelRow): LlmModel {
    return {
      modelKey: r.model_key, name: r.name, providerType: r.provider_type,
      modelId: r.model_id, baseUrl: r.base_url, apiKey: decryptApiKey(r.api_key),
      contextWindow: r.context_window, maxOutputTokens: r.max_output_tokens, isEnabled: r.is_enabled === 1,
    };
  }
}
```

- [ ] **Step 2: `llm-routes.repo.ts`**

```ts
import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface LlmRouteRow extends RowDataPacket {
  id: number; scene: string; subject: string;
  primary_model_key: string; fallback_model_key: string | null;
}

export interface LlmRoute {
  scene: string; subject: string; primaryModelKey: string; fallbackModelKey: string | null;
}

@Injectable()
export class LlmRoutesRepository {
  constructor(@Inject('DATABASE_POOL') private pool: Pool) {}

  async listAll(): Promise<LlmRoute[]> {
    const [rows] = await this.pool.execute<LlmRouteRow[]>('SELECT * FROM llm_routes ORDER BY scene, subject');
    return rows.map((r) => ({ scene: r.scene, subject: r.subject, primaryModelKey: r.primary_model_key, fallbackModelKey: r.fallback_model_key }));
  }

  /** 全量替换（事务）。调用方负责先校验 modelKey 全部存在且启用。 */
  async replaceAll(routes: LlmRoute[]): Promise<void> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute('DELETE FROM llm_routes');
      for (const r of routes) {
        await conn.execute(
          'INSERT INTO llm_routes (scene, subject, primary_model_key, fallback_model_key) VALUES (?, ?, ?, ?)',
          [r.scene, r.subject, r.primaryModelKey, r.fallbackModelKey ?? null]);
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  async existsReferenceTo(modelKey: string): Promise<boolean> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT 1 AS x FROM llm_routes WHERE primary_model_key = ? OR fallback_model_key = ? LIMIT 1',
      [modelKey, modelKey]);
    return rows.length > 0;
  }
}
```

- [ ] **Step 3: `parent-messages.repo.ts`**

```ts
import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface ParentMessage {
  id: number; parentId: number | null; type: string; title: string; content: string;
  isRead: boolean; isBroadcast: boolean; createdAt: Date;
}

@Injectable()
export class ParentMessagesRepository {
  constructor(@Inject('DATABASE_POOL') private pool: Pool) {}

  async create(data: { parentId: number | null; type: string; title: string; content: string }): Promise<number> {
    const [r] = await this.pool.execute(
      'INSERT INTO parent_messages (parent_id, type, title, content) VALUES (?, ?, ?, ?)',
      [data.parentId, data.type, data.title, data.content]);
    return (r as any).insertId;
  }

  async findById(id: number) {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT id, parent_id AS parentId, type, title, content, is_read AS isRead, created_at AS createdAt FROM parent_messages WHERE id = ?', [id]);
    return rows.length > 0 ? rows[0] : null;
  }

  async delete(id: number): Promise<void> {
    await this.pool.execute('DELETE FROM message_reads WHERE message_id = ?', [id]);
    await this.pool.execute('DELETE FROM parent_messages WHERE id = ?', [id]);
  }

  /** 家长视角：定向（自己）+广播（NULL），合并已读状态。 */
  async listForParent(parentId: number): Promise<ParentMessage[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT m.id, m.parent_id AS parentId, m.type, m.title, m.content, m.created_at AS createdAt,
              CASE WHEN m.parent_id IS NULL THEN (mr.id IS NOT NULL) ELSE (m.is_read = 1) END AS isRead,
              (m.parent_id IS NULL) AS isBroadcast
       FROM parent_messages m
       LEFT JOIN message_reads mr ON mr.message_id = m.id AND mr.parent_id = ?
       WHERE m.parent_id = ? OR m.parent_id IS NULL
       ORDER BY m.created_at DESC LIMIT 100`, [parentId, parentId]);
    return rows.map((r: any) => ({ ...r, isRead: r.isRead === 1, isBroadcast: r.isBroadcast === 1 }));
  }

  async unreadCount(parentId: number): Promise<number> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS c FROM parent_messages m
       LEFT JOIN message_reads mr ON mr.message_id = m.id AND mr.parent_id = ?
       WHERE (m.parent_id = ? AND m.is_read = 0) OR (m.parent_id IS NULL AND mr.id IS NULL)`,
      [parentId, parentId]);
    return Number(rows[0].c);
  }

  /** 标已读：广播 upsert message_reads；定向改行。返回消息是否属于该家长（或广播）。 */
  async markRead(parentId: number, messageId: number): Promise<boolean> {
    const msg = await this.findById(messageId);
    if (!msg || (msg.parentId !== null && Number(msg.parentId) !== parentId)) return false;
    if (msg.parentId === null) {
      await this.pool.execute(
        'INSERT INTO message_reads (parent_id, message_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE read_at = CURRENT_TIMESTAMP(3)',
        [parentId, messageId]);
    } else {
      await this.pool.execute(
        'UPDATE parent_messages SET is_read = 1, read_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [messageId]);
    }
    return true;
  }

  /** 管理台列表：触达数（广播=活跃家长数，定向=1）与已读数。 */
  async listForAdmin(): Promise<Array<{ id: number; type: string; title: string; isBroadcast: boolean; reachCount: number; readCount: number; createdAt: Date }>> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT m.id, m.type, m.title, (m.parent_id IS NULL) AS isBroadcast, m.created_at AS createdAt,
              CASE WHEN m.parent_id IS NULL THEN (SELECT COUNT(*) FROM parents p WHERE p.deleted_at IS NULL) ELSE 1 END AS reachCount,
              CASE WHEN m.parent_id IS NULL THEN (SELECT COUNT(*) FROM message_reads mr WHERE mr.message_id = m.id) ELSE m.is_read END AS readCount
       FROM parent_messages m ORDER BY m.created_at DESC LIMIT 200`);
    return rows.map((r: any) => ({ ...r, isBroadcast: r.isBroadcast === 1, reachCount: Number(r.reachCount), readCount: Number(r.readCount) }));
  }
}
```

- [ ] **Step 4: `admin-chat.repo.ts`**

```ts
import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface AdminDialogue { id: number; adminId: number; modelKey: string; title: string | null; updatedAt: Date; }
export interface AdminMessage { id: number; dialogueId: number; role: 'user' | 'assistant'; content: string; reasoning: string | null; createdAt: Date; }

@Injectable()
export class AdminChatRepository {
  constructor(@Inject('DATABASE_POOL') private pool: Pool) {}

  async createDialogue(adminId: number, modelKey: string): Promise<number> {
    const [r] = await this.pool.execute(
      'INSERT INTO admin_dialogues (admin_id, model_key) VALUES (?, ?)', [adminId, modelKey]);
    return (r as any).insertId;
  }

  async findDialogue(id: number): Promise<AdminDialogue | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT id, admin_id AS adminId, model_key AS modelKey, title, updated_at AS updatedAt FROM admin_dialogues WHERE id = ?', [id]);
    return (rows[0] as any) ?? null;
  }

  async listDialogues(adminId: number): Promise<AdminDialogue[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT id, admin_id AS adminId, model_key AS modelKey, title, updated_at AS updatedAt FROM admin_dialogues WHERE admin_id = ? ORDER BY updated_at DESC', [adminId]);
    return rows as any;
  }

  async deleteDialogue(id: number): Promise<void> {
    await this.pool.execute('DELETE FROM admin_messages WHERE dialogue_id = ?', [id]);
    await this.pool.execute('DELETE FROM admin_dialogues WHERE id = ?', [id]);
  }

  async addMessage(dialogueId: number, role: 'user' | 'assistant', content: string, reasoning?: string | null): Promise<number> {
    const [r] = await this.pool.execute(
      'INSERT INTO admin_messages (dialogue_id, role, content, reasoning) VALUES (?, ?, ?, ?)',
      [dialogueId, role, content, reasoning ?? null]);
    await this.pool.execute('UPDATE admin_dialogues SET updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [dialogueId]);
    return (r as any).insertId;
  }

  async listMessages(dialogueId: number): Promise<AdminMessage[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT id, dialogue_id AS dialogueId, role, content, reasoning, created_at AS createdAt FROM admin_messages WHERE dialogue_id = ? ORDER BY id', [dialogueId]);
    return rows as any;
  }
}
```

- [ ] **Step 5: index.ts 追加四个导出 + `npm run build` 过 + Commit**（`feat(server): 管理员中枢四 Repository`）

---

### Task 4: ModelConfigRegistry（TDD）

**Files:**
- Create: `apps/server/src/ai-core/infra/model-config-registry.ts`
- Test: `apps/server/src/ai-core/infra/model-config-registry.test.ts`

- [ ] **Step 1: 失败测试**

```ts
import { describe, it, expect, vi } from 'vitest';
import { ModelConfigRegistry } from './model-config-registry';
import { routeConfig } from '../config.js';

const mkDb = (models: any[], routes: any[]) => ({
  llmModelsRepo: { listEnabled: vi.fn().mockResolvedValue(models) },
  llmRoutesRepo: { listAll: vi.fn().mockResolvedValue(routes) },
});

const model = (key: string, apiKey = 'sk-x') => ({
  modelKey: key, name: key, providerType: 'openai_compatible', modelId: key,
  baseUrl: 'https://x.example', apiKey, contextWindow: 8192, maxOutputTokens: 4096, isEnabled: true,
});

describe('ModelConfigRegistry', () => {
  it('DB 空表 -> 回落 YAML 快照', async () => {
    const reg = new ModelConfigRegistry(mkDb([], []) as any);
    await reg.reload();
    expect(reg.getSnapshot().models).toEqual(routeConfig.models);
    expect(reg.getSnapshot().routes).toEqual(routeConfig.routes);
  });

  it('DB 查询抛错 -> 回落 YAML', async () => {
    const db = mkDb([], []);
    db.llmModelsRepo.listEnabled.mockRejectedValue(new Error('db down'));
    const reg = new ModelConfigRegistry(db as any);
    await reg.reload();
    expect(reg.getSnapshot().models).toEqual(routeConfig.models);
  });

  it('DB 有数据 -> 快照来自 DB 且带 apiKey', async () => {
    const reg = new ModelConfigRegistry(mkDb([model('m1', 'sk-secret')], [
      { scene: 'tutoring', subject: 'math', primaryModelKey: 'm1', fallbackModelKey: null },
    ]) as any);
    await reg.reload();
    const snap = reg.getSnapshot();
    expect(snap.models['m1'].apiKey).toBe('sk-secret');
    expect(snap.routes['tutoring'][0].primary).toBe('m1');
  });

  it('reload 失败后旧快照保留（不清空）', async () => {
    const db = mkDb([model('m1')], []);
    const reg = new ModelConfigRegistry(db as any);
    await reg.reload();
    db.llmModelsRepo.listEnabled.mockRejectedValue(new Error('down'));
    await reg.reload();
    expect(reg.getSnapshot().models['m1']).toBeDefined();
  });
});
```

- [ ] **Step 2: 确认失败（模块不存在）**

- [ ] **Step 3: 实现**

```ts
import { routeConfig } from '../config.js';
import type { ModelConfig } from '../types.js';
import type { LlmModelsRepository } from '../../database/repositories/llm-models.repo.js';
import type { LlmRoutesRepository } from '../../database/repositories/llm-routes.repo.js';

interface RouteRule { subject: string; difficulty?: number[]; primary: string; fallback?: string | null; }

export interface RegistrySnapshot {
  models: Record<string, ModelConfig & { apiKey: string }>;
  routes: Record<string, RouteRule[]>;
  default: { primary: string; fallback: string };
}

const yamlSnapshot = (): RegistrySnapshot => ({
  models: routeConfig.models as Record<string, ModelConfig & { apiKey: string }>,
  routes: routeConfig.routes as Record<string, RouteRule[]>,
  default: routeConfig.default,
});

/**
 * 模型配置运行时真源：内存快照 + 按需 reload。DB 空/失败回落 YAML（seed 前系统照常跑）。
 * reload 失败时保留旧快照（不清空），管理员保存后调用方 reload 即生效。
 */
export class ModelConfigRegistry {
  private snapshot: RegistrySnapshot = yamlSnapshot();

  constructor(
    private llmModelsRepo?: Pick<LlmModelsRepository, 'listEnabled'>,
    private llmRoutesRepo?: Pick<LlmRoutesRepository, 'listAll'>,
  ) {}

  getSnapshot(): RegistrySnapshot {
    return this.snapshot;
  }

  async reload(): Promise<void> {
    if (!this.llmModelsRepo || !this.llmRoutesRepo) return;
    try {
      const [models, routes] = await Promise.all([
        this.llmModelsRepo.listEnabled(),
        this.llmRoutesRepo.listAll(),
      ]);
      if (models.length === 0) return; // 空=未 seed，回落 YAML
      const next: RegistrySnapshot = {
        models: {},
        routes: {},
        default: this.snapshot.default,
      };
      for (const m of models) {
        next.models[m.modelKey] = {
          provider: m.providerType === 'openai_compatible' ? 'kimi' : m.providerType,
          modelId: m.modelId,
          baseUrl: m.baseUrl,
          apiKey: m.apiKey,
          contextWindow: m.contextWindow,
          maxOutputTokens: m.maxOutputTokens,
          costPer1K: { input: 0, output: 0 },
          supportsStreaming: true,
        };
      }
      for (const r of routes) {
        (next.routes[r.scene] ??= []).push({
          subject: r.subject, primary: r.primaryModelKey, fallback: r.fallbackModelKey,
        });
      }
      this.snapshot = next;
    } catch {
      // DB 不可用：保留当前快照（初始为 YAML）
    }
  }
}
```

注意：`ModelConfig.provider` 把 `openai_compatible` 映射为 `'kimi'`（复用 OpenAI 风格适配器）；若 `ModelConfig` 类型缺 `costPer1K` 等字段以实际 types.ts 为准补齐。

- [ ] **Step 4: 测试过 + Commit**（`feat(ai-core): ModelConfigRegistry 内存快照 + YAML 兜底`）

---

### Task 5: ModelRouter 动态化 + capability 接线（TDD）

**Files:**
- Modify: `apps/server/src/ai-core/infra/model-router.ts`
- Modify: `apps/server/src/ai-core/infra/model-config-registry.ts`（追加模块级单例 getter）
- Modify: 8 个 capability 文件（`new ModelRouter()` -> `new ModelRouter(getModelConfigRegistry())`）
- Test: `apps/server/src/ai-core/infra/model-router-dynamic.test.ts`

- [ ] **Step 1: registry 追加单例 getter**（文件末尾）

```ts
/** 模块级单例：capability 无 DI 场景取用（Nest 启动时由 AppModule 注入 repo 并 reload）。 */
let globalRegistry: ModelConfigRegistry | null = null;

export function getModelConfigRegistry(): ModelConfigRegistry | undefined {
  return globalRegistry ?? undefined;
}

export function setModelConfigRegistry(reg: ModelConfigRegistry): void {
  globalRegistry = reg;
}
```

（`ModelConfigRegistry` 构造已接受可选 repo，单例在 AppModule 初始化时用真 repo 创建并 `setModelConfigRegistry`。）

- [ ] **Step 2: 失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { ModelRouter } from './model-router';
import { ModelConfigRegistry } from './model-config-registry';

describe('ModelRouter + registry', () => {
  it('无参构造走 YAML（既有行为不变）', () => {
    const r = new ModelRouter().route({ scene: 'tutoring', subject: 'math', difficulty: 1 });
    expect(r.primary.modelId).toBe('qwen3.7-max');
  });

  it('传 registry 走快照且返回带 apiKey', () => {
    const reg = new ModelConfigRegistry(); // 无 repo -> YAML 快照
    const r = new ModelRouter(reg).route({ scene: 'tutoring', subject: 'math', difficulty: 1 });
    expect(r.primary.apiKey).toBeDefined();
    expect(r.primary.modelId).toBe('qwen3.7-max');
  });

  it('快照无匹配场景时走 default', () => {
    const reg = new ModelConfigRegistry();
    const r = new ModelRouter(reg).route({ scene: 'nonexistent' as any, subject: 'math' as any });
    expect(r.primary).toBeDefined();
  });
});
```

- [ ] **Step 3: 改 ModelRouter**（保持无参路径逐字节兼容）

```ts
import { routeConfig } from '../config.js';
import type { RouteRequest, RouteResult, ModelConfig, Scene, Subject } from '../types.js';
import type { ModelConfigRegistry } from './model-config-registry.js';

interface RouteRule {
  subject: string;
  difficulty?: number[];
  primary: string;
  fallback?: string | null;
}

export class ModelRouter {
  private models: Record<string, ModelConfig & { apiKey?: string }>;
  private routes: Record<string, RouteRule[]>;
  private defaultRule: { primary: string; fallback: string };
  private registry?: ModelConfigRegistry;

  constructor(registry?: ModelConfigRegistry) {
    // 无 registry：直接读 YAML（既有行为，测试与兜底路径零变化）
    this.registry = registry;
    if (registry) {
      const snap = registry.getSnapshot();
      this.models = snap.models;
      this.routes = snap.routes;
      this.defaultRule = snap.default;
    } else {
      this.models = routeConfig.models as Record<string, ModelConfig & { apiKey?: string }>;
      this.routes = routeConfig.routes as Record<string, RouteRule[]>;
      this.defaultRule = routeConfig.default;
    }
  }

  getModel(id: string): ModelConfig | undefined {
    return this.models[id];
  }

  route(request: RouteRequest): RouteResult {
    // registry 模式下每次 route 前刷新本地引用（快照对象由 registry.reload 整体替换）
    if (this.registry) {
      const snap = this.registry.getSnapshot();
      this.models = snap.models;
      this.routes = snap.routes;
      this.defaultRule = snap.default;
    }
    const rule = this.matchRule(request.scene, request.subject, request.difficulty);
    const reason = `scene=${request.scene} subject=${request.subject} difficulty=${request.difficulty ?? 'any'}`;
    return {
      primary: this.models[rule.primary],
      fallback: rule.fallback ? this.models[rule.fallback] : undefined,
      reason,
    };
  }

  // matchRule 原样保留（scene 精确->subject->通配->default）
  private matchRule(scene: Scene, subject: Subject, difficulty?: number): RouteRule {
    const sceneRules = this.routes[scene] ?? [];
    if (difficulty !== undefined) {
      const exact = sceneRules.find(
        (r) => (r.subject === subject || r.subject === '*') && r.difficulty?.includes(difficulty),
      );
      if (exact) return exact;
    }
    const bySubject = sceneRules.find((r) => r.subject === subject);
    if (bySubject) return bySubject;
    const wildcard = sceneRules.find((r) => r.subject === '*');
    if (wildcard) return wildcard;
    return { subject: '*', primary: this.defaultRule.primary, fallback: this.defaultRule.fallback };
  }
}
```

注意：YAML 路径下 `routeConfig.models` 本就含明文 apiKey（env 插值后），原来构造时剥离、`ModelClient` 再从 env 取；现在**不再剥离**（`getModel` 对外暴露 apiKey 可接受--服务端内部），简化数据流。若既有测试断言 `getModel()` 结果不含 apiKey，改测试（内部一致性让位于新设计）。

- [ ] **Step 4: capability 接线**（8 个文件同改）

`apps/server/src/ai-core/capabilities/{tutoring,grading,judgment,explanation,hint,variation,analytics,question-structuring}.capability.ts` 中 `new ModelRouter()` 改为：

```ts
import { getModelConfigRegistry } from '../infra/model-config-registry.js';
// ...
this.modelRouter = new ModelRouter(getModelConfigRegistry());
```

（类字段初始化或构造函数内两处形式按各文件现状改，保持 DI mock 注入路径不变。）

- [ ] **Step 5: 全量测试过（`npm test`，既有 202+ 全绿）+ Commit**（`feat(ai-core): ModelRouter 支持 registry 快照路由，capability 接线`）

---

### Task 6: ModelClient apiKey 优先级 + providers 缓存 key（TDD）

**Files:**
- Modify: `apps/server/src/ai-core/infra/model-client/index.ts`
- Test: `apps/server/src/ai-core/infra/model-client/model-client.test.ts`

- [ ] **Step 1: 失败测试**

```ts
import { describe, it, expect, vi } from 'vitest';
import { ModelClient } from './index';

describe('ModelClient apiKey 优先级', () => {
  it('request.model.apiKey 优先于 env；同 provider 不同 key 各自建 adapter', async () => {
    const calls: string[] = [];
    const mkAdapter = () => ({
      chat: vi.fn().mockResolvedValue({ content: 'ok', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 } }),
      streamChat: async function* () {},
    });
    const providers = new Map([
      ['kimi', mkAdapter()],
      ['qwen', mkAdapter()],
    ]);
    // 用 providers 覆盖无法观察 key 传递，改为测缓存行为：两个不同 apiKey 的请求各自成功
    const mc = new ModelClient({ providers });
    const req = (apiKey: string) => ({
      model: { provider: 'kimi', modelId: 'x', baseUrl: 'https://x', apiKey, contextWindow: 8, maxOutputTokens: 8, supportsStreaming: true },
      messages: [{ role: 'user' as const, content: 'hi' }],
      stream: false,
    });
    const r1 = await mc.chat(req('sk-a') as any);
    const r2 = await mc.chat(req('sk-b') as any);
    expect(r1.content).toBe('ok');
    expect(r2.content).toBe('ok');
    expect(calls.length).toBe(0);
  });
});
```

（观察点：不抛错即缓存 key 按 apiKey 区分成功；若沿用旧实现同 provider 只有一个缓存且 key 无关，此测试也会过--真正断言靠 Step 3 实现里 `getProvider(provider, apiKey)` 签名变化 + 无 env 的自定义 key 模型可调用。补充一条关键测试：）

```ts
  it('openai_compatible 模型（provider 映射 kimi 适配器）无 env key 也可调用', async () => {
    const mc = new ModelClient({ providers: new Map([['kimi', { chat: vi.fn().mockResolvedValue({ content: 'ok', finishReason: 'stop' }), streamChat: async function* () {} }]]) });
    const r = await mc.chat({
      model: { provider: 'kimi', modelId: 'glm-4.7', baseUrl: 'https://open.bigmodel.cn', apiKey: 'sk-custom', contextWindow: 8, maxOutputTokens: 8, supportsStreaming: true },
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    } as any);
    expect(r.content).toBe('ok');
  });
```

- [ ] **Step 2: 确认失败（getProvider 签名不匹配/编译错）**

- [ ] **Step 3: 改 `index.ts`**

```ts
  private getProvider(provider: string, apiKey?: string): ProviderAdapter {
    // 缓存 key：provider + apiKey 指纹（同 provider 不同 key 共存；无 apiKey 走 env）
    const cacheKey = apiKey ? `${provider}:${apiKey}` : provider;
    if (this.providers.has(cacheKey)) return this.providers.get(cacheKey)!;

    let client: ProviderAdapter;
    if (this.providerOverrides?.has(provider)) {
      client = this.providerOverrides.get(provider)!;
    } else {
      const key = apiKey || getApiKeyByProvider(provider);
      switch (provider) {
        case 'kimi': client = new KimiClient(key, 'OpenAI-Compatible'); break;
        case 'qwen': client = new QwenClient(key); break;
        case 'deepseek': client = new DeepSeekClient(key); break;
        case 'gemini': client = new GeminiClient(key); break;
        default: throw new Error(`Unknown provider: ${provider}`);
      }
    }
    this.providers.set(cacheKey, client);
    return client;
  }
```

`chat`/`chatStream` 内的 `this.getProvider(request.model.provider)` 全部改传 `request.model.apiKey`。（`KimiClient` 构造第二参 providerName 已存在，传 'OpenAI-Compatible' 只影响错误文案；`openai_compatible` 在 registry 里已映射为 provider='kimi'，故无需新 case。）

- [ ] **Step 4: 全量测试过 + Commit**（`feat(ai-core): ModelClient apiKey 随模型条目，支持自定义 OpenAI 兼容模型`）

---

### Task 7: AppModule 装配 registry + seed-llm-config

**Files:**
- Modify: `apps/server/src/app.module.ts`
- Create: `apps/server/src/scripts/seed-llm-config.ts`
- Modify: `apps/server/.env.example`

- [ ] **Step 1: 新 `ConfigModule`（`apps/server/src/modules/config/config.module.ts`）**

```ts
import { Module, OnModuleInit } from '@nestjs/common';
import { LlmModelsRepository } from '../../database/repositories/llm-models.repo.js';
import { LlmRoutesRepository } from '../../database/repositories/llm-routes.repo.js';
import { ModelConfigRegistry, setModelConfigRegistry } from '../../ai-core/infra/model-config-registry.js';

/** 启动时创建全局 ModelConfigRegistry 单例并首次 reload（失败回落 YAML，不阻塞启动）。 */
@Module({
  providers: [LlmModelsRepository, LlmRoutesRepository],
})
export class ConfigModule implements OnModuleInit {
  constructor(
    private llmModelsRepo: LlmModelsRepository,
    private llmRoutesRepo: LlmRoutesRepository,
  ) {}

  async onModuleInit() {
    const reg = new ModelConfigRegistry(this.llmModelsRepo, this.llmRoutesRepo);
    setModelConfigRegistry(reg);
    await reg.reload().catch(() => undefined);
  }
}
```

AppModule imports 加 `ConfigModule`。

- [ ] **Step 2: seed 脚本**

```ts
/**
 * 把 model-routes.yaml 的 models/routes 幂等导入 llm_models/llm_routes（apiKey 经 env 插值后加密落库）。
 * 运行：cd apps/server && npx tsx src/scripts/seed-llm-config.ts
 */
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import mysql from 'mysql2/promise';
import { routeConfig } from '../ai-core/config.js';
import { encryptApiKey } from '../common/utils/api-key-crypto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../../../.env') });

async function main() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST ?? 'localhost', port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'ai_k12', password: process.env.DB_PASS ?? 'ai_k12',
    database: process.env.DB_NAME ?? 'ai_k12',
  });
  for (const [key, m] of Object.entries(routeConfig.models)) {
    const [exists] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT id FROM llm_models WHERE model_key = ?', [key]);
    if (exists.length > 0) { console.log(`[seed] 模型 ${key} 已存在，跳过`); continue; }
    await pool.execute(
      `INSERT INTO llm_models (model_key, name, provider_type, model_id, base_url, api_key, context_window, max_output_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [key, key, m.provider, m.modelId, m.baseUrl, encryptApiKey(m.apiKey ?? ''),
       (m as any).contextWindow ?? 131072, (m as any).maxOutputTokens ?? 16384]);
    console.log(`[seed] 模型 ${key} 已导入`);
  }
  const enabledKeys = new Set(Object.keys(routeConfig.models));
  for (const [scene, rules] of Object.entries(routeConfig.routes as Record<string, any[]>)) {
    for (const r of rules) {
      // YAML 的 difficulty 细分规则合并为一条（DB 不存难度；同 scene+subject 保留第一条）
      const [exists] = await pool.execute<mysql.RowDataPacket[]>(
        'SELECT id FROM llm_routes WHERE scene = ? AND subject = ?', [scene, r.subject]);
      if (exists.length > 0) continue;
      if (!enabledKeys.has(r.primary) || (r.fallback && !enabledKeys.has(r.fallback))) continue;
      await pool.execute(
        'INSERT INTO llm_routes (scene, subject, primary_model_key, fallback_model_key) VALUES (?, ?, ?, ?)',
        [scene, r.subject, r.primary, r.fallback ?? null]);
      console.log(`[seed] 路由 ${scene}/${r.subject} -> ${r.primary} 已导入`);
    }
  }
  await pool.end();
}

main().catch((e) => { console.error('[seed] 失败:', e); process.exit(1); });
```

Run: `npx tsx src/scripts/seed-llm-config.ts`，再跑一遍验证幂等（全部“已存在，跳过”）。

- [ ] **Step 3: build+test 过 + Commit**（`feat(server): ConfigModule 装配 registry + LLM 配置 seed`）

---

### Task 8: BanRegistry + AuthMiddleware 即时封禁（TDD）

**Files:**
- Create: `apps/server/src/common/guards/ban-registry.ts`
- Modify: `apps/server/src/common/middleware/auth.middleware.ts`
- Test: `apps/server/src/common/guards/ban-registry.test.ts`

- [ ] **Step 1: 失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { BanRegistry } from './ban-registry';

describe('BanRegistry', () => {
  it('封禁/解封 parent 与 student 独立记账', () => {
    const r = new BanRegistry();
    r.banParent(2); r.banStudent(5);
    expect(r.isBanned('parent', 2)).toBe(true);
    expect(r.isBanned('student', 5)).toBe(true);
    expect(r.isBanned('parent', 3)).toBe(false);
    r.unbanParent(2);
    expect(r.isBanned('parent', 2)).toBe(false);
  });
});
```

- [ ] **Step 2: 实现**

```ts
import { Injectable } from '@nestjs/common';

/** 进程内封禁名单：管理员封/解封时同步，AuthMiddleware O(1) 查验（重启从 DB is_active=0 重建）。 */
@Injectable()
export class BanRegistry {
  private parents = new Set<number>();
  private students = new Set<number>();

  banParent(id: number) { this.parents.add(id); }
  unbanParent(id: number) { this.parents.delete(id); }
  banStudent(id: number) { this.students.add(id); }
  unbanStudent(id: number) { this.students.delete(id); }

  isBanned(role: string, id: number): boolean {
    if (role === 'parent') return this.parents.has(id);
    if (role === 'student') return this.students.has(id);
    return false;
  }

  /** 启动时从 DB is_active=0 重建。 */
  load(parentIds: number[], studentIds: number[]) {
    this.parents = new Set(parentIds);
    this.students = new Set(studentIds);
  }
}
```

AuthMiddleware：`request.user` 赋值后追加（middleware 构造注入 `BanRegistry`，AppModule `apply(AuthMiddleware).forRoutes` 前在 providers 注册 BanRegistry 并 export）：

```ts
      if (payload.role === 'parent' && this.banRegistry.isBanned('parent', payload.sub)) {
        throw new UnauthorizedException({ code: 1003, message: '账号已停用' });
      }
      if (payload.role === 'student' && this.banRegistry.isBanned('student', payload.sub)) {
        throw new UnauthorizedException({ code: 1003, message: '账号已停用' });
      }
```

（`middleware` 抛 401 会被全局 HttpExceptionFilter 捕获返回统一 JSON。）

- [ ] **Step 3: 测试过 + 全量绿 + Commit**（`feat(server): BanRegistry 进程内封禁即时生效`）

---

### Task 9: Admin 模型池/路由 service + controller（TDD）

**Files:**
- Create: `apps/server/src/modules/admin/admin.module.ts`、`admin.controller.ts`、`admin-models.service.ts`（+ `admin-models.service.test.ts`）

- [ ] **Step 1: 失败测试**（mock repo，验证：列表打码、新增重复 1004、编辑空 key 不改、停用被引用 1004、路由全量保存坏 key 拒整批）

```ts
import { describe, it, expect, vi } from 'vitest';
import { AdminModelsService } from './admin-models.service';

const mk = (o: any = {}) => ({
  llmModelsRepo: {
    listAll: vi.fn().mockResolvedValue([]), listEnabled: vi.fn().mockResolvedValue([]),
    findByKey: vi.fn().mockResolvedValue(null), create: vi.fn(), update: vi.fn(), setEnabled: vi.fn(),
  },
  llmRoutesRepo: { listAll: vi.fn().mockResolvedValue([]), replaceAll: vi.fn(), existsReferenceTo: vi.fn().mockResolvedValue(false) },
  registry: { reload: vi.fn().mockResolvedValue(undefined) },
  ...o,
});
const svc = (d: any) => new AdminModelsService(d.llmModelsRepo, d.llmRoutesRepo, d.registry);

const dbModel = (key: string) => ({ modelKey: key, name: key, providerType: 'kimi', modelId: key, baseUrl: 'https://x', apiKey: 'sk-secret123', contextWindow: 8, maxOutputTokens: 8, isEnabled: true });

describe('AdminModelsService', () => {
  it('列表 apiKey 打码', async () => {
    const d = mk({ llmModelsRepo: { ...mk().llmModelsRepo, listAll: vi.fn().mockResolvedValue([dbModel('m1')]) } });
    const list = await svc(d).list();
    expect(list[0].apiKeyMasked).toBe('sk-***123');
    expect(JSON.stringify(list)).not.toContain('sk-secret123');
  });

  it('新增重复 modelKey -> 1004', async () => {
    const d = mk({ llmModelsRepo: { ...mk().llmModelsRepo, findByKey: vi.fn().mockResolvedValue(dbModel('m1')) } });
    await expect(svc(d).create({ modelKey: 'm1', name: 'x', providerType: 'kimi', modelId: 'm', baseUrl: 'https://x', apiKey: 'sk-1' }))
      .rejects.toMatchObject({ response: { code: 1004 } });
  });

  it('停用被路由引用的模型 -> 1004', async () => {
    const d = mk({
      llmModelsRepo: { ...mk().llmModelsRepo, findByKey: vi.fn().mockResolvedValue(dbModel('m1')) },
      llmRoutesRepo: { ...mk().llmRoutesRepo, existsReferenceTo: vi.fn().mockResolvedValue(true) },
    });
    await expect(svc(d).setEnabled('m1', false)).rejects.toMatchObject({ response: { code: 1004 } });
  });

  it('保存路由引用不存在/停用的模型 -> 1004 拒整批且不写库', async () => {
    const d = mk({
      llmModelsRepo: { ...mk().llmModelsRepo, listEnabled: vi.fn().mockResolvedValue([dbModel('m1')]) },
    });
    await expect(svc(d).saveRoutes([{ scene: 'tutoring', subject: 'math', primaryModelKey: 'ghost', fallbackModelKey: null }]))
      .rejects.toMatchObject({ response: { code: 1004 } });
    expect(d.llmRoutesRepo.replaceAll).not.toHaveBeenCalled();
  });

  it('合法保存 -> 事务替换 + registry.reload', async () => {
    const d = mk({ llmModelsRepo: { ...mk().llmModelsRepo, listEnabled: vi.fn().mockResolvedValue([dbModel('m1'), dbModel('m2')]) } });
    await svc(d).saveRoutes([{ scene: 'tutoring', subject: 'math', primaryModelKey: 'm1', fallbackModelKey: 'm2' }]);
    expect(d.llmRoutesRepo.replaceAll).toHaveBeenCalled();
    expect(d.registry.reload).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 实现 service**（打码逻辑：`apiKey.length > 8 ? apiKey.slice(0,2)+'***'+apiKey.slice(-3) : '***'`；create/update/setEnabled/saveRoutes 成功后均 `registry.reload()`）

```ts
import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import type { LlmModelsRepository, LlmModel } from '../../database/repositories/llm-models.repo.js';
import type { LlmRoutesRepository, LlmRoute } from '../../database/repositories/llm-routes.repo.js';
import type { ModelConfigRegistry } from '../../ai-core/infra/model-config-registry.js';

export const PROVIDER_TYPES = ['kimi', 'qwen', 'deepseek', 'gemini', 'openai_compatible'] as const;
export const SCENES = ['tutoring', 'grading', 'judgment', 'hint', 'explanation', 'variation', 'structuring', 'transcribe'] as const;

@Injectable()
export class AdminModelsService {
  constructor(
    private llmModelsRepo: LlmModelsRepository,
    private llmRoutesRepo: LlmRoutesRepository,
    private registry: ModelConfigRegistry,
  ) {}

  async list() {
    const models = await this.llmModelsRepo.listAll();
    return models.map((m) => ({ ...m, apiKey: undefined, apiKeyMasked: m.apiKey.length > 8 ? `${m.apiKey.slice(0, 2)}***${m.apiKey.slice(-3)}` : '***' }));
  }

  async create(dto: { modelKey: string; name: string; providerType: string; modelId: string; baseUrl: string; apiKey: string; contextWindow?: number; maxOutputTokens?: number }) {
    if (!(PROVIDER_TYPES as readonly string[]).includes(dto.providerType)) {
      throw new ConflictException({ code: 1001, message: '供应商类型不合法' });
    }
    if (await this.llmModelsRepo.findByKey(dto.modelKey)) {
      throw new ConflictException({ code: 1004, message: 'model_key 已存在' });
    }
    await this.llmModelsRepo.create({
      modelKey: dto.modelKey, name: dto.name, providerType: dto.providerType, modelId: dto.modelId,
      baseUrl: dto.baseUrl, apiKey: dto.apiKey,
      contextWindow: dto.contextWindow ?? 131072, maxOutputTokens: dto.maxOutputTokens ?? 16384,
    });
    await this.registry.reload();
  }

  async update(modelKey: string, dto: Partial<{ name: string; providerType: string; modelId: string; baseUrl: string; apiKey: string; contextWindow: number; maxOutputTokens: number }>) {
    if (!(await this.llmModelsRepo.findByKey(modelKey))) {
      throw new NotFoundException({ code: 1002, message: '模型不存在' });
    }
    await this.llmModelsRepo.update(modelKey, dto);
    await this.registry.reload();
  }

  async setEnabled(modelKey: string, enabled: boolean) {
    if (!(await this.llmModelsRepo.findByKey(modelKey))) {
      throw new NotFoundException({ code: 1002, message: '模型不存在' });
    }
    if (!enabled && (await this.llmRoutesRepo.existsReferenceTo(modelKey))) {
      throw new ConflictException({ code: 1004, message: '该模型被路由表引用，先改路由再停用' });
    }
    await this.llmModelsRepo.setEnabled(modelKey, enabled);
    await this.registry.reload();
  }

  async listRoutes() {
    return { routes: await this.llmRoutesRepo.listAll(), scenes: SCENES, providerTypes: PROVIDER_TYPES };
  }

  async saveRoutes(routes: LlmRoute[]) {
    const enabled = await this.llmModelsRepo.listEnabled();
    const ok = new Set(enabled.map((m) => m.modelKey));
    for (const r of routes) {
      if (!ok.has(r.primaryModelKey) || (r.fallbackModelKey && !ok.has(r.fallbackModelKey))) {
        throw new ConflictException({ code: 1004, message: `路由引用了不存在或停用的模型: ${r.primaryModelKey}/${r.fallbackModelKey ?? '-'}` });
      }
    }
    await this.llmRoutesRepo.replaceAll(routes);
    await this.registry.reload();
  }
}
```

- [ ] **Step 3: controller（模型池+路由+validate-connection）**

```ts
import { Body, Controller, Get, HttpException, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminModelsService } from './admin-models.service.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';

const ModelSchema = z.object({
  modelKey: z.string().min(2).max(50).regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().min(1).max(100),
  providerType: z.enum(['kimi', 'qwen', 'deepseek', 'gemini', 'openai_compatible']),
  modelId: z.string().min(1).max(100),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1).max(400),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
});
const ModelUpdateSchema = ModelSchema.partial().omit({ modelKey: true });
const RoutesSchema = z.object({
  routes: z.array(z.object({
    scene: z.string().min(1).max(30),
    subject: z.string().min(1).max(20),
    primaryModelKey: z.string().min(1).max(50),
    fallbackModelKey: z.string().max(50).nullable(),
  })),
});
const ValidateSchema = z.object({ modelKey: z.string().min(1) });

@Controller('api/admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class AdminModelsController {
  constructor(private svc: AdminModelsService) {}

  @Get('models') list() { return this.svc.list(); }
  @Post('models') async create(@Body() b: unknown) { await this.svc.create(ModelSchema.parse(b)); return null; }
  @Patch('models/:modelKey') async update(@Param('modelKey') k: string, @Body() b: unknown) { await this.svc.update(k, ModelUpdateSchema.parse(b)); return null; }
  @Patch('models/:modelKey/status') async status(@Param('modelKey') k: string, @Body() b: unknown) {
    const { isEnabled } = z.object({ isEnabled: z.boolean() }).parse(b);
    await this.svc.setEnabled(k, isEnabled);
    return null;
  }

  @Get('routes') listRoutes() { return this.svc.listRoutes(); }
  @Put('routes') async saveRoutes(@Body() b: unknown) {
    const { routes } = RoutesSchema.parse(b);
    await this.svc.saveRoutes(routes);
    return null;
  }

  /** 连通性测试：用该模型发“1+1=?”探活，10s 超时，不落库。 */
  @Post('routes/validate-connection')
  async validate(@Body() b: unknown) {
    const { modelKey } = ValidateSchema.parse(b);
    const t0 = Date.now();
    try {
      const { ModelClient } = await import('../../ai-core/infra/model-client/index.js');
      const { getModelConfigRegistry } = await import('../../ai-core/infra/model-config-registry.js');
      const model = getModelConfigRegistry()?.getSnapshot().models[modelKey];
      if (!model) throw new HttpException({ code: 1002, message: '模型不存在或未启用' }, 404);
      const client = new ModelClient();
      const res = await Promise.race([
        client.chat({ model, messages: [{ role: 'user', content: '1+1=? 只回答数字' }], stream: false }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10_000)),
      ]);
      return { ok: true, latencyMs: Date.now() - t0, sample: (res as any).content?.slice(0, 50) ?? '' };
    } catch (err) {
      throw new HttpException({ code: 1009, message: `连通失败: ${err instanceof Error ? err.message : String(err)}` }, 502);
    }
  }
}
```

admin.module.ts（本 task 先挂模型部分，后续 task 逐个并入）：

```ts
import { Module } from '@nestjs/common';
import { LlmModelsRepository } from '../../database/repositories/llm-models.repo.js';
import { LlmRoutesRepository } from '../../database/repositories/llm-routes.repo.js';
import { ModelConfigRegistry, setModelConfigRegistry } from '../../ai-core/infra/model-config-registry.js';
import { AdminModelsController } from './admin.controller.js';
import { AdminModelsService } from './admin-models.service.js';

@Module({
  controllers: [AdminModelsController],
  providers: [
    LlmModelsRepository, LlmRoutesRepository,
    { provide: ModelConfigRegistry, useFactory: () => { const r = new ModelConfigRegistry(); setModelConfigRegistry(r); return r; } },
    AdminModelsService,
  ],
})
export class AdminModule {}
```

⚠️ 注意：registry 单例必须全局唯一--Task 7 的 ConfigModule 已 `setModelConfigRegistry`（带 repo 的实例）；AdminModule 这里不能覆盖它。改为：AdminModule 直接 `useExisting`/注入已 set 的全局单例。**实现取：`getModelConfigRegistry()`（Task 5 加的 getter）作为 provider token：**

```ts
{ provide: ModelConfigRegistry, useFactory: () => getModelConfigRegistry() ?? new ModelConfigRegistry() },
```

（ConfigModule onModuleInit 先于 AdminModule 的请求期执行，全局单例已带 repo；若时序异常，service 里 `reload()` 也是无害空操作。）AppModule imports 加 `AdminModule`。

- [ ] **Step 4: 测试过 + 全量绿 + Commit**（`feat(server): 管理台模型池/路由接口（保存即生效）`）

---

### Task 10: Admin 账号管理（封禁连封）（TDD）

**Files:**
- Create: `apps/server/src/modules/admin/admin-accounts.service.ts`（+ test）
- Modify: `apps/server/src/modules/admin/admin.controller.ts`、`admin.module.ts`

- [ ] **Step 1: 失败测试**

```ts
import { describe, it, expect, vi } from 'vitest';
import { AdminAccountsService } from './admin-accounts.service';

const mk = (o: any = {}) => ({
  parentsRepo: { search: vi.fn().mockResolvedValue([]), findById: vi.fn().mockResolvedValue(null), setActive: vi.fn() },
  studentsRepo: { search: vi.fn().mockResolvedValue([]), findByParentId: vi.fn().mockResolvedValue([]), setActive: vi.fn() },
  banRegistry: { banParent: vi.fn(), unbanParent: vi.fn(), banStudent: vi.fn(), unbanStudent: vi.fn() },
  ...o,
});
const svc = (d: any) => new AdminAccountsService(d.parentsRepo, d.studentsRepo, d.banRegistry);

describe('AdminAccountsService', () => {
  it('封家长连封其名下学生 + BanRegistry 同步', async () => {
    const d = mk({
      parentsRepo: { ...mk().parentsRepo, findById: vi.fn().mockResolvedValue({ id: 2, isActive: true }) },
      studentsRepo: { ...mk().studentsRepo, findByParentId: vi.fn().mockResolvedValue([{ id: 5, isActive: true }, { id: 6, isActive: true }]) },
    });
    await svc(d).setParentStatus(2, false);
    expect(d.parentsRepo.setActive).toHaveBeenCalledWith(2, false);
    expect(d.studentsRepo.setActive).toHaveBeenCalledWith(5, false);
    expect(d.studentsRepo.setActive).toHaveBeenCalledWith(6, false);
    expect(d.banRegistry.banParent).toHaveBeenCalledWith(2);
    expect(d.banRegistry.banStudent).toHaveBeenCalledWith(5);
  });

  it('解封家长反向全部解封', async () => {
    const d = mk({
      parentsRepo: { ...mk().parentsRepo, findById: vi.fn().mockResolvedValue({ id: 2, isActive: false }) },
      studentsRepo: { ...mk().studentsRepo, findByParentId: vi.fn().mockResolvedValue([{ id: 5 }]) },
    });
    await svc(d).setParentStatus(2, true);
    expect(d.parentsRepo.setActive).toHaveBeenCalledWith(2, true);
    expect(d.studentsRepo.setActive).toHaveBeenCalledWith(5, true);
    expect(d.banRegistry.unbanParent).toHaveBeenCalledWith(2);
  });

  it('家长不存在 -> 1002', async () => {
    await expect(svc(mk()).setParentStatus(99, false)).rejects.toMatchObject({ response: { code: 1002 } });
  });
});
```

- [ ] **Step 2: 实现 service + repo 增量**

`ParentsRepository` 加 `search(q)`（`WHERE phone LIKE ? OR name LIKE ? AND deleted_at IS NULL`，附名下学生数子查询）与 `setActive`、`findById`；`StudentsRepository` 加 `search(q)`。

```ts
// admin-accounts.service.ts 关键方法
async setParentStatus(parentId: number, active: boolean) {
  const p = await this.parentsRepo.findById(parentId);
  if (!p) throw new NotFoundException({ code: 1002, message: '家长不存在' });
  await this.parentsRepo.setActive(parentId, active);
  active ? this.banRegistry.unbanParent(parentId) : this.banRegistry.banParent(parentId);
  // 连封/连解其名下学生
  const children = await this.studentsRepo.findByParentId(parentId);
  for (const c of children) {
    await this.studentsRepo.setActive(c.id, active);
    active ? this.banRegistry.unbanStudent(c.id) : this.banRegistry.banStudent(c.id);
  }
}

async setStudentStatus(studentId: number, active: boolean) {
  // findById 校验 + setActive + banRegistry 学生记账（不影响家长和兄弟姐妹）
}
```

controller 加：`GET parents?search=`、`PATCH parents/:id/status`、`GET students?search=`、`PATCH students/:id/status`（Zod 校验 search 长度<=50）。admin.module providers 加 AdminAccountsService/BanRegistry/ParentsRepository/StudentsRepository。

- [ ] **Step 3: 测试过 + Commit**（`feat(server): 管理台账号管理（封家长连封学生+即时生效）`）

---

### Task 11: 站内消息（admin 发 + parent 读）（TDD）

**Files:**
- Create: `apps/server/src/modules/admin/admin-messages.service.ts`（+ test）
- Modify: `admin.controller.ts`、`admin.module.ts`、`apps/server/src/modules/parent/parent.controller.ts`、`parent.module.ts`

- [ ] **Step 1: 失败测试**（mock ParentMessagesRepository：发送定向/广播、家长列表合并广播、unread 计数、markRead 定向/广播分路、非本人定向返回 false）

```ts
import { describe, it, expect, vi } from 'vitest';
import { AdminMessagesService } from './admin-messages.service';

const mk = (o: any = {}) => ({
  messagesRepo: {
    create: vi.fn().mockResolvedValue(1), listForAdmin: vi.fn().mockResolvedValue([]),
    listForParent: vi.fn().mockResolvedValue([]), unreadCount: vi.fn().mockResolvedValue(0),
    markRead: vi.fn().mockResolvedValue(true), delete: vi.fn(), findById: vi.fn().mockResolvedValue(null),
  },
  parentsRepo: { findById: vi.fn().mockResolvedValue(null) },
  ...o,
});
const svc = (d: any) => new AdminMessagesService(d.messagesRepo, d.parentsRepo);

describe('AdminMessagesService', () => {
  it('广播发送 parentId=null；指定家长先校验存在（1002）', async () => {
    const d = mk();
    await svc(d).send({ type: 'promo', title: 't', content: 'c', parentId: undefined });
    expect(d.messagesRepo.create).toHaveBeenCalledWith(expect.objectContaining({ parentId: null }));
    const d2 = mk();
    await expect(svc(d2).send({ type: 'promo', title: 't', content: 'c', parentId: 99 }))
      .rejects.toMatchObject({ response: { code: 1002 } });
  });

  it('家长列表/未读/已读透传', async () => {
    const d = mk();
    await svc(d).listForParent(3);
    await svc(d).unreadCount(3);
    await svc(d).markRead(3, 7);
    expect(d.messagesRepo.listForParent).toHaveBeenCalledWith(3);
    expect(d.messagesRepo.markRead).toHaveBeenCalledWith(3, 7);
  });

  it('markRead 非本人定向消息 -> 1002', async () => {
    const d = mk({ messagesRepo: { ...mk().messagesRepo, markRead: vi.fn().mockResolvedValue(false) } });
    await expect(svc(d).markRead(3, 7)).rejects.toMatchObject({ response: { code: 1002 } });
  });
});
```

- [ ] **Step 2: 实现 + 接线**

service（发送/管理列表/撤回 delete/家长侧三读法直透 repo，type 校验 `promo|learning|system`）。controller 加 `GET/POST/DELETE api/admin/messages`；`ParentController` 加 `GET api/parent/messages`、`GET api/parent/messages/unread-count`、`PATCH api/parent/messages/:id/read`（service 复用 AdminMessagesService 或直接注入 repo，择简：ParentModule import AdminModule 的 providers 不可跨模块--改为 ParentModule 自 providers `[AdminMessagesService, ParentMessagesRepository, ParentsRepository]`，AdminModule export AdminMessagesService 且 ParentModule import AdminModule 更干净。**实现取后者**。）

- [ ] **Step 3: 测试过 + Commit**（`feat(server): 站内消息中心（admin 发送/家长已读）`）

---

### Task 12: 管理员 AI 聊天（会话 + SSE 流式）

**Files:**
- Create: `apps/server/src/modules/admin/admin-chat.service.ts`（+ test）
- Modify: `admin.controller.ts`、`admin.module.ts`
- Create: `apps/server/src/ai-core/prompts/admin-chat.md`（简单通用助手 system prompt，无学习边界）

- [ ] **Step 1: 失败测试**（mock ModelClient + AdminChatRepository：新建会话校验模型启用、流式事件序列 content/done、落库 user+assistant、会话归属校验 1005）

```ts
import { describe, it, expect, vi } from 'vitest';
import { AdminChatService } from './admin-chat.service';

const mk = (o: any = {}) => ({
  chatRepo: {
    createDialogue: vi.fn().mockResolvedValue(1), findDialogue: vi.fn().mockResolvedValue({ id: 1, adminId: 1, modelKey: 'm1' }),
    listDialogues: vi.fn().mockResolvedValue([]), deleteDialogue: vi.fn(),
    addMessage: vi.fn(), listMessages: vi.fn().mockResolvedValue([]),
  },
  modelsRepo: { listEnabled: vi.fn().mockResolvedValue([{ modelKey: 'm1' }]) },
  modelClient: {
    streamChat: async function* (_req: any) {
      yield { delta: '你' }; yield { delta: '好' };
    },
  },
  ...o,
});
const svc = (d: any) => new AdminChatService(d.chatRepo, d.modelsRepo, d.modelClient);

describe('AdminChatService', () => {
  it('新建会话校验模型启用中（1004）', async () => {
    await expect(svc(mk()).createDialogue(1, 'ghost')).rejects.toMatchObject({ response: { code: 1004 } });
  });

  it('流式对话：事件序列 + 落库 user/assistant', async () => {
    const d = mk();
    const events: any[] = [];
    for await (const e of svc(d).chatStream({ dialogueId: 1, message: 'hi' }, 1)) events.push(e);
    expect(events.map((e) => e.type)).toEqual(['message', 'done']);
    expect(events[0].delta).toBe('你');
    expect(d.chatRepo.addMessage).toHaveBeenCalledWith(1, 'user', 'hi');
    expect(d.chatRepo.addMessage).toHaveBeenCalledWith(1, 'assistant', '你好', undefined);
  });

  it('非本人会话 -> 1005', async () => {
    const d = mk({ chatRepo: { ...mk().chatRepo, findDialogue: vi.fn().mockResolvedValue({ id: 1, adminId: 999, modelKey: 'm1' }) } });
    await expect(async () => { for await (const _ of svc(d).chatStream({ dialogueId: 1, message: 'x' }, 1)) {} })
      .rejects.toMatchObject({ response: { code: 1005 } });
  });
});
```

- [ ] **Step 2: 实现 service**

```ts
// 关键：chatStream 生成器（仿 tutoring.capability 流式聚合，但无 SafetyGuard/无苏格拉底约束）
async *chatStream(dto: { dialogueId: number; message: string }, adminId: number) {
  const dlg = await this.chatRepo.findDialogue(dto.dialogueId);
  if (!dlg) throw new NotFoundException({ code: 1002, message: '会话不存在' });
  if (dlg.adminId !== adminId) throw new ForbiddenException({ code: 1005, message: '无权访问该会话' });

  const snap = await this.getSnapshotWithFallback(dlg.modelKey); // modelsRepo.listEnabled 查该 key，未启用 1004
  const history = await this.chatRepo.listMessages(dto.dialogueId);
  await this.chatRepo.addMessage(dto.dialogueId, 'user', dto.message);

  const messages = [
    ...history.slice(-20).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: dto.message },
  ];
  let full = ''; let reasoning: string | undefined;
  try {
    for await (const chunk of this.modelClient.streamChat({
      model: snap, // ModelConfig（registry 快照或 listEnabled 映射）
      messages: [{ role: 'system', content: ADMIN_CHAT_SYSTEM_PROMPT }, ...messages],
    })) {
      if (chunk.delta) { full += chunk.delta; yield { type: 'message', delta: chunk.delta }; }
      if (chunk.reasoningDelta) { reasoning = (reasoning ?? '') + chunk.reasoningDelta; }
    }
    await this.chatRepo.addMessage(dto.dialogueId, 'assistant', full, reasoning);
    yield { type: 'done', dialogueId: dto.dialogueId };
  } catch (err) {
    yield { type: 'error', code: 5001, message: 'AI 服务异常', retryable: true };
  }
}
```

（`ADMIN_CHAT_SYSTEM_PROMPT` 读 `prompts/admin-chat.md`：内容为“你是管理员的工作助手，回答专业、简洁、不限主题”；`streamChat` 的 chunk 字段名以 `ProviderAdapter` 实际签名为准对齐。）

controller 加 4 个端点；`POST chat/stream` 完全仿 `ai.controller.ts` 的 SSE 模式（`@Res()` 手写响应 + `data: JSON\n\n`）。admin.module providers 加 AdminChatService/AdminChatRepository。

- [ ] **Step 3: 测试过 + Commit**（`feat(server): 管理员 AI 聊天（独立会话+SSE 流式）`）

---

### Task 13: Dashboard + 管理员改密

**Files:**
- Create: `apps/server/src/modules/admin/admin-dashboard.service.ts`（+ test）
- Modify: `admin.controller.ts`、`admin.module.ts`

- [ ] **Step 1: 失败测试**

```ts
// dashboard：四个计数 SQL 透传（mock pool 不必，直接 mock repos/countQueries）
// 改密：旧密码错 1003；成功 updatePassword
```

（test 细节：dashboard service 注入 `Pool` mock `SELECT COUNT(*)` 系列查询；改密 mock AdminsRepository.findById/updatePassword + bcrypt hashSync 比对。）

- [ ] **Step 2: 实现**（dashboard：`SELECT COUNT(*) FROM parents WHERE deleted_at IS NULL` / `students WHERE deleted_at IS NULL` / `ai_dialogues WHERE created_at >= CURDATE()` / `llm_models WHERE is_enabled=1` + recentParents 前 10；改密：bcrypt.compare 旧密码，错则 `401 1003 旧密码错误`，对则 hash 新密码 update。controller 加 `GET dashboard`、`PATCH password`。`AdminsRepository` 补 `updatePassword`。）

- [ ] **Step 3: 测试过 + 全量绿 + 手测：** admin token 调 dashboard 返回四计数；改密后新密码可登录。**Commit**（`feat(server): 管理台 dashboard + 管理员改密`）

---

### Task 14: 前端 API 层 + AdminLayout/Nav + 路由

**Files:**
- Modify: `apps/web/src/services/api.ts`
- Modify: `apps/web/src/components/layout/AdminLayout.tsx`
- Create: `apps/web/src/components/layout/AdminNav.tsx`
- Modify: `apps/web/src/routes/index.tsx`

- [ ] **Step 1: api.ts 追加**

```ts
// --- Admin: models & routes ---
export interface AdminModelItem {
  modelKey: string; name: string; providerType: string; modelId: string;
  baseUrl: string; apiKeyMasked: string; contextWindow: number; maxOutputTokens: number; isEnabled: boolean;
}
export function listAdminModels(): Promise<AdminModelItem[]> { return fetchApi('/admin/models'); }
export function createAdminModel(req: { modelKey: string; name: string; providerType: string; modelId: string; baseUrl: string; apiKey: string; contextWindow?: number; maxOutputTokens?: number }): Promise<null> {
  return fetchApi('/admin/models', { method: 'POST', body: JSON.stringify(req) });
}
export function updateAdminModel(modelKey: string, req: Partial<{ name: string; providerType: string; modelId: string; baseUrl: string; apiKey: string }>): Promise<null> {
  return fetchApi(`/admin/models/${modelKey}`, { method: 'PATCH', body: JSON.stringify(req) });
}
export function setAdminModelStatus(modelKey: string, isEnabled: boolean): Promise<null> {
  return fetchApi(`/admin/models/${modelKey}/status`, { method: 'PATCH', body: JSON.stringify({ isEnabled }) });
}
export interface AdminRouteItem { scene: string; subject: string; primaryModelKey: string; fallbackModelKey: string | null; }
export function listAdminRoutes(): Promise<{ routes: AdminRouteItem[]; scenes: string[]; providerTypes: string[] }> { return fetchApi('/admin/routes'); }
export function saveAdminRoutes(routes: AdminRouteItem[]): Promise<null> {
  return fetchApi('/admin/routes', { method: 'PUT', body: JSON.stringify({ routes }) });
}
export function validateModelConnection(modelKey: string): Promise<{ ok: boolean; latencyMs: number; sample: string }> {
  return fetchApi('/admin/routes/validate-connection', { method: 'POST', body: JSON.stringify({ modelKey }) });
}

// --- Admin: accounts ---
export interface AdminParentItem { id: number; phone: string; name: string | null; isActive: boolean; studentCount: number; createdAt: string; }
export function searchParents(search: string): Promise<AdminParentItem[]> { return fetchApi(`/admin/parents?search=${encodeURIComponent(search)}`); }
export function setParentStatus(id: number, isActive: boolean): Promise<null> {
  return fetchApi(`/admin/parents/${id}/status`, { method: 'PATCH', body: JSON.stringify({ isActive }) });
}
export interface AdminStudentItem { id: number; username: string; name: string; grade: string | null; isActive: boolean; parentId: number; }
export function searchStudents(search: string): Promise<AdminStudentItem[]> { return fetchApi(`/admin/students?search=${encodeURIComponent(search)}`); }
export function setStudentStatusAdmin(id: number, isActive: boolean): Promise<null> {
  return fetchApi(`/admin/students/${id}/status`, { method: 'PATCH', body: JSON.stringify({ isActive }) });
}

// --- Admin: messages ---
export function sendAdminMessage(req: { type: string; title: string; content: string; parentId?: number }): Promise<null> {
  return fetchApi('/admin/messages', { method: 'POST', body: JSON.stringify(req) });
}
export function listAdminMessages(): Promise<Array<{ id: number; type: string; title: string; isBroadcast: boolean; reachCount: number; readCount: number; createdAt: string }>> { return fetchApi('/admin/messages'); }
export function deleteAdminMessage(id: number): Promise<null> { return fetchApi(`/admin/messages/${id}`, { method: 'DELETE' }); }

// --- Admin: chat ---
export function createAdminDialogue(modelKey: string): Promise<{ id: number }> {
  return fetchApi('/admin/chat/dialogues', { method: 'POST', body: JSON.stringify({ modelKey }) });
}
export function listAdminDialogues(): Promise<Array<{ id: number; modelKey: string; title: string | null; updatedAt: string }>> { return fetchApi('/admin/chat/dialogues'); }
export function deleteAdminDialogue(id: number): Promise<null> { return fetchApi(`/admin/chat/dialogues/${id}`, { method: 'DELETE' }); }
export function listAdminMessages(dialogueId: number): Promise<Array<{ id: number; role: 'user' | 'assistant'; content: string; reasoning: string | null }>> {
  return fetchApi(`/admin/chat/messages?dialogueId=${dialogueId}`);
}
export async function* streamAdminChat(dialogueId: number, message: string): AsyncGenerator<{ type: string; delta?: string; code?: number; message?: string }> {
  const token = localStorage.getItem('token');
  const res = await fetch('/api/admin/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ dialogueId, message }),
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    for (const p of parts) {
      if (p.startsWith('data: ')) yield JSON.parse(p.slice(6));
    }
  }
}

// --- Admin: dashboard & password ---
export interface AdminDashboard { parentCount: number; studentCount: number; todayAiCalls: number; enabledModelCount: number; recentParents: AdminParentItem[]; }
export function fetchAdminDashboard(): Promise<AdminDashboard> { return fetchApi('/admin/dashboard'); }
export function changeAdminPassword(oldPassword: string, newPassword: string): Promise<null> {
  return fetchApi('/admin/password', { method: 'PATCH', body: JSON.stringify({ oldPassword, newPassword }) });
}

// --- Parent: messages ---
export interface ParentMessageItem { id: number; type: string; title: string; content: string; isRead: boolean; isBroadcast: boolean; createdAt: string; }
export function listMyMessages(): Promise<ParentMessageItem[]> { return fetchApi('/parent/messages'); }
export function getUnreadMessageCount(): Promise<number> { return fetchApi('/parent/messages/unread-count'); }
export function markMessageRead(id: number): Promise<null> { return fetchApi(`/parent/messages/${id}/read`, { method: 'PATCH' }); }
```

- [ ] **Step 2: AdminNav（仿 ParentNav：导航 + 底部用户卡）**

```tsx
import { NavLink } from 'react-router-dom';
import { LogoutButton } from '@/components/base';

const navItems = [
  { to: '/admin', label: '总览', end: true },
  { to: '/admin/models', label: '模型配置' },
  { to: '/admin/accounts', label: '账号管理' },
  { to: '/admin/messages', label: '消息推送' },
  { to: '/admin/chat', label: 'AI 助手' },
  { to: '/admin/security', label: '账号安全' },
];

export function AdminNav() {
  return (
    <aside className="w-16 lg:w-56 shrink-0 bg-white border-r border-gray-200 flex flex-col transition-all">
      <div className="flex items-center gap-3 px-4 h-16 border-b border-gray-200">
        <div className="w-9 h-9 rounded-lg bg-slate-800 flex items-center justify-center text-white font-bold">K</div>
        <span className="hidden lg:inline text-lg font-bold text-slate-900">管理员中枢</span>
      </div>
      <nav className="flex-1 py-4 space-y-1 px-2">
        {navItems.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end}
            className={({ isActive }) => `flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all text-sm ${isActive ? 'bg-blue-50 text-blue-600 font-semibold' : 'text-slate-600 hover:bg-gray-50'}`}>
            <span className="hidden lg:inline">{item.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="p-3">
        <div className="flex items-center justify-between p-2.5 rounded-xl bg-blue-50/60 border border-blue-100">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-full bg-slate-800 flex items-center justify-center text-white font-bold shrink-0">管</div>
            <div className="min-w-0">
              <div className="text-sm font-medium text-slate-900 truncate">管理员</div>
              <div className="text-xs text-slate-500">管理台</div>
            </div>
          </div>
          <LogoutButton className="!p-2 border-blue-100 hover:bg-blue-100/60" />
        </div>
      </div>
    </aside>
  );
}
```

AdminLayout 改为 `<AdminNav/> + <main><Outlet/></main>` 结构（data-theme="parent"）。routes：`/admin` 改为带 children 的布局路由（dashboard=AdminDashboardPage 等 6 个子路由，全部在 `/admin` 布局层包一次 `RequireRole role="admin"`）。

- [ ] **Step 3: tsc/lint 过 + Commit**（`feat(web): 管理台 API 层 + AdminNav 布局`）

---

### Task 15-19: 管理台五页 + 家长消息页

每页均：新建 `apps/web/src/pages/admin/<Page>.tsx`（家长消息页 `apps/web/src/pages/parent/ParentMessagesPage.tsx`），base 组件 + parent 主题变量，无 emoji/线性图标，tsc+lint 绿后独立 commit。

- [ ] **Task 15 AdminDashboardPage**：`useEffect` 拉 `fetchAdminDashboard`；四张统计卡（grid-cols-2 lg:grid-cols-4，数值大字+小标签）+ 最近注册家长表格（手机号打码 `${p.slice(0,3)}****${p.slice(7)}`/姓名/日期）。Commit: `feat(web): 管理台总览页`。

- [ ] **Task 16 AdminModelsPage**：上半模型池表格（key/名称/modelId/baseUrl/key打码/类型/状态徽章/操作：编辑-停用-测试连接）；Modal 新增/编辑表单（providerType 下拉 5 项；编辑时 apiKey 输入框 placeholder“留空则不修改”，提交时空则不传 apiKey 字段）；测试连接按钮调 `validateModelConnection` toast 显示 `连通成功 · 832ms` 或错误。下半路由表：`routes` state 渲染行（scene 文本/subject 文本/主模型 select/备选 select，options=`models.filter(m=>m.isEnabled)`，备选含“无”），行尾删除按钮 + 「新增规则」行（scene/subject 文本输入 + 两个 select）+ 顶部「保存路由表」调 `saveAdminRoutes` 成功 toast“路由已生效”。Commit: `feat(web): 模型配置页（模型池+路由表）`。

- [ ] **Task 17 AdminAccountsPage**：Tab 家长/学生；搜索框 debounce 300ms 调 searchParents/searchStudents；家长行：打码手机/姓名/学生数/状态徽章/封禁-解封按钮（封禁前 `ConfirmDialog`：“将连带停用其名下 {studentCount} 个学生账号，确认封禁？”调 `setParentStatus(id,false)`）；学生行：用户名/姓名/年级/状态/单独封禁解封（无确认弹窗，直接执行）。Commit: `feat(web): 管理台账号管理页`。

- [ ] **Task 18 AdminMessagesPage + ParentMessagesPage + 铃铛**：
  - Admin 发送表单（type select 优惠/学情/系统公告、标题 Input、正文 textarea、范围 radio 广播/指定家长（广播默认；指定家长时显示搜索框选一个家长））+「发送」；下方已发列表（类型 Tag/标题/触达/已读/撤回按钮 ConfirmDialog 后 delete）。
  - ParentMessagesPage：列表（未读加粗+小圆点/类型 Tag/标题/时间），点击展开正文并 `markMessageRead` 后刷新未读。
  - ParentLayout 头部右侧加铃铛按钮（svg 图标+未读数徽章，`useEffect` 拉 `getUnreadMessageCount`，点击跳 `/parent/messages`）；ParentNav navItems 头部加 `{ to: '/parent/messages', label: '消息' }`。
  Commit: `feat(web): 消息推送页 + 家长消息中心 + 未读铃铛`。

- [ ] **Task 19 AdminChatPage + AdminSecurityPage**：
  - Chat：三栏中的两栏（左会话列表：新建按钮（Modal 选模型=启用中模型 select）、切换、删除；右聊天窗：消息气泡（assistant 用 ReactMarkdown+KaTeX 渲染，参照 DiscussChat 原语直接 import 复用）、底部输入框+发送、流式期间禁用发送）。本地 state（不建全局 store，页面级 useState 足够）：dialogues/currentId/messages/streaming；发送时 `for await (const e of streamAdminChat(id, text))` 追加 delta。顶部小字提示“此聊天不受 K12 学习边界限制”。
  - Security：旧密码/新密码/确认新密码三个 Input + 提交（校验两次一致、6-32 位）调 `changeAdminPassword`，成功 toast 并清空。
  Commit: `feat(web): 管理员 AI 聊天页 + 账号安全页`。

（各页 JSX 完整代码在执行时按上述要点 + Task 14 的 API + base 组件实际签名落笔，样式对齐 ParentStudentsPage 既有范式；此处的页面规格即验收标准。）

---

### Task 20: 端到端手动验收

前置：`mysql` 迁移已跑、`seed-admin`/`seed-llm-config` 已跑、server `npm run start:dev`、web `npm run dev`。

- [ ] ① admin 登录 -> /admin 总览四计数正确（家长1/学生3/模型6/今日调用>=0）。
- [ ] ② 模型配置页：模型池 6 条 seed 数据 key 打码；编辑 qwen3.7-max 的 baseUrl 加错前缀保存 -> 「测试连接」报 1009；改回正确值 -> 连通成功显示延迟。
- [ ] ③ 新增自定义模型（openai_compatible，用任一真实 OpenAI 兼容 endpoint）-> 测试连接成功。
- [ ] ④ 路由表把 math/tutoring 主模型改为自定义模型 -> 保存“已生效” -> 学生端发起辅导 -> 服务端日志显示走新模型（或改 judgment 后判题走新模型）。
- [ ] ⑤ 停用被路由引用的模型 -> 1004 拒绝；先改路由再停用 -> 成功。
- [ ] ⑥ 注册两个测试家长 -> 广播一条优惠消息 -> 两家长铃铛均+1 -> 各自点击阅读 -> 管理台已发列表已读数 2/2；定向消息只目标家长可见；撤回后家长列表消失。
- [ ] ⑦ 封禁测试家长 A（连带其学生）-> A 学生已登录的旧 token 立即 401；A 家长登录被拒；解封 -> 全恢复。封禁另一家长 B 的单个学生 -> B 家长不受影响。
- [ ] ⑧ 管理员 AI 聊天：新建会话选自定义模型 -> 问“今天天气怎么样”正常回答（不受学习边界阻断）-> 刷新页面历史还在；删除会话。
- [ ] ⑨ 改密：错旧密码 1003；正确改密 -> 旧密码失效新密码可登录（改回原密码保持环境干净）。
- [ ] ⑩ 全量回归：server `npm run build && npm test`、web `npm run build && npm run lint` 全绿。
- [ ] 清理测试数据（测试家长/学生/消息），Commit 修复（如有）：`fix: 管理员中枢端到端验收修复`。

---

### Task 21: 文档同步

- openapi.yaml：新增 `/admin/models*`、`/admin/routes*`、`/admin/parents*`、`/admin/students*`、`/admin/messages*`、`/admin/chat/*`、`/admin/dashboard`、`/admin/password`、`/parent/messages*` paths + 相关 schema（AdminModelItem/AdminRouteItem/ParentMessageItem 等）。
- API 设计文档：§4 新增 §4.17 Admin 分组 + §4.13 补 messages 三行；§2.4 补 1009；版本日志 v2.0。
- CLAUDE.md 追加「2026-08-18 新增（管理员中枢）」note（模型池/路由动态化、BanRegistry、消息中心、admin chat、dashboard、改密、局限：广播触达数为活跃家长近似、单进程 BanRegistry、api_key 加密 dev key 警示）。
- `python3 -c "import yaml; yaml.safe_load(open('docs/api/openapi.yaml'))"` 校验 + 端点 grep 对照两文档。
- Commit: `docs: 管理员中枢 API/openapi/CLAUDE.md 同步`。

---

## Self-Review 记录

- **Spec 覆盖**：spec §3（5 表）-> Task 1/3；§4（registry/router/client）-> Task 4/5/6/7；§5（admin+parent 接口）-> Task 9-13；§5.3 BanRegistry -> Task 8；§6（前端）-> Task 14-19；§7（安全：加密 Task 2、越权各 task @Roles、改密 Task 13）；§9（测试）-> 各 TDD task + Task 20；§10（文档）-> Task 21。无缺口。
- **占位符**：Task 15-19 以“页面规格+API 已定义”方式描述（页面代码执行时按规格落笔）--这是有意的前端规格化写法，验收标准明确；后端全部含完整代码。
- **类型一致性**：`AdminModelItem.apiKeyMasked`（Task 9 service 输出 = Task 14 前端类型）；`LlmRoute{scene,subject,primaryModelKey,fallbackModelKey}`（Task 3/9/14 一致）；`streamAdminChat` 事件 `{type,delta}`（Task 12/19 一致）；`ParentMessageItem.isBroadcast`（Task 3 repo / Task 14 / Task 18 一致）。
- **执行顺序**：Task 2 -> 3 -> 4 -> 5 -> 6 -> 7 强顺序（registry 依赖）；Task 9-13 依赖 7/8；Task 15-19 依赖 14。
