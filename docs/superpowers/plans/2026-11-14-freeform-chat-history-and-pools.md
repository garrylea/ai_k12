# 做题答疑进历史 + 做题题进错题/专项 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「做题 → 答疑」的会话进入【辅助答疑】历史并可续聊，同时把做题题（含只答疑未提交的）补进错题本、错题练习、知识点专项、同类型与变式。

**Architecture:** 会话列表接口支持多 `scene` + `hasChat` 过滤；答疑流结束后异步用新标注能力补题、补知识点、写错题本；判题落库后异步补知识点；解除 freeform 在训练判题的隔离，让现有抽题/判题/积分/掌握度链路自然接住。

**Tech Stack:** NestJS + MySQL（mysql2）、React 18 + Vite + Zustand、Vitest、SSE。

**Spec:** `docs/superpowers/specs/2026-11-14-freeform-chat-history-and-pools-design.md`

## Global Constraints

- 仓库里有其他人未提交的改动（截至写计划时：`SolveSourceInput.tsx/.test.tsx`）。**每次 commit 只 `git add` 本任务列出的文件**，不要 `git add -A`、不要动无关文件。
- 给用户的命令只能有一条：回填脚本默认直接执行，不要求先 dry-run 再 apply。
- 测试与文档冲突时以设计文档为准；改接口必须同步 `docs/API接口与数据流设计文档.md` 与 `docs/api/openapi.yaml`。
- 埋点/异步任务永不阻断主链路：补题、补知识点全部 fire-and-forget，失败只 `warn`。
- `mysql2` 的 `LIMIT ?` 必须走 `pool.query`，不要改成 `pool.execute`。
- 新增/修改组件必须补渲染测试；`globals: false`，多用例文件自己写 `afterEach(cleanup)`。
- 不用 WebSocket，不引入新依赖。
- 中文文案，不用 emoji，图标用线性 SVG。

---

### Task 1: 会话列表支持多 scene + hasChat（后端）

**Files:**
- Modify: `apps/server/src/database/repositories/ai-dialogues.repo.ts:42-69`
- Modify: `apps/server/src/modules/conversations/conversations.service.ts:115-122`
- Modify: `apps/server/src/modules/conversations/conversations.controller.ts:22-35`
- Test: `apps/server/src/database/repositories/ai-dialogues.repo.test.ts`（新建）
- Test: `apps/server/src/modules/conversations/conversations.service.test.ts:27-34`（Fake repo 签名）

**Interfaces:**
- Produces:
  - `findByStudentAndTrack(studentId: number, track: 'mainline'|'auxiliary', limit: number, cursor?: number, scene?: AiDialogueScene | AiDialogueScene[], hasChat?: boolean)`
  - `ConversationsService.list(studentId: number, track, cursor?: number, scenes?: AiDialogueScene[], hasChat?: boolean)`
  - `GET /api/conversations?track=auxiliary&scene=aux_qna,aux_freeform&hasChat=1`

- [ ] **Step 1: 写仓库测试（先红）**

新建 `apps/server/src/database/repositories/ai-dialogues.repo.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { AiDialoguesRepository } from './ai-dialogues.repo';

const mockPool = () => ({
  query: vi.fn().mockResolvedValue([[], []]),
  execute: vi.fn().mockResolvedValue([[], []]),
});

describe('AiDialoguesRepository.findByStudentAndTrack', () => {
  it('多 scene 用 IN，hasChat 只约束 aux_freeform', async () => {
    const pool = mockPool();
    const repo = new AiDialoguesRepository(pool as any);
    await repo.findByStudentAndTrack(9, 'auxiliary', 10, undefined, ['aux_qna', 'aux_freeform'], true);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('scene IN (?,?)');
    expect(sql).toContain("scene <> 'aux_freeform'");
    expect(sql).toContain('EXISTS');
    expect(sql).toContain("NOT IN ('transcription','freeform_submit','freeform_judge')");
    expect(sql).toContain('m.deleted_at IS NULL');
    expect(params).toEqual([9, 'auxiliary', 'aux_qna', 'aux_freeform', 10]);
  });

  it('不传 hasChat 时不加 EXISTS（兼容旧调用）', async () => {
    const pool = mockPool();
    const repo = new AiDialoguesRepository(pool as any);
    await repo.findByStudentAndTrack(9, 'auxiliary', 10, 5, 'aux_qna');

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).not.toContain('EXISTS');
    expect(sql).toContain('scene = ?');
    expect(sql).toContain('id < ?');
    expect(params).toEqual([9, 'auxiliary', 5, 'aux_qna', 10]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/database/repositories/ai-dialogues.repo.test.ts`
Expected: FAIL（`findByStudentAndTrack` 还不接受数组，SQL 不含 `EXISTS`）

- [ ] **Step 3: 改仓库**

`ai-dialogues.repo.ts:42-69` 整段替换：

```ts
  async findByStudentAndTrack(
    studentId: number,
    track: AiDialogueRow['track'],
    limit: number,
    cursor?: number,
    scene?: AiDialogueRow['scene'] | AiDialogueRow['scene'][],
    hasChat = false,
  ): Promise<AiDialogueRow[]> {
    // 用池 query（客户端转义）而非 execute（服务端预处理）：MySQL 对预处理语句的
    // `LIMIT ?` 报 "Incorrect arguments to mysqld_stmt_execute"。
    const conditions = ['student_id = ?', 'track = ?', 'deleted_at IS NULL'];
    const params: Array<number | string> = [studentId, track];
    if (cursor) {
      conditions.push('id < ?');
      params.push(cursor);
    }
    const scenes = Array.isArray(scene) ? scene : scene ? [scene] : [];
    if (scenes.length > 0) {
      conditions.push(`scene IN (${scenes.map(() => '?').join(',')})`);
      params.push(...scenes);
    }
    // 做题入口的会话按「是否真的聊过天」过滤：题干锚 / 判题提交 / 判题报告都不算聊天。
    // 只约束 aux_freeform，避免把尚未发第一条消息的 aux_qna 会话也隐藏掉。
    if (hasChat) {
      conditions.push(`(
        scene <> 'aux_freeform'
        OR EXISTS (
          SELECT 1 FROM ai_messages m
          WHERE m.dialogue_id = ai_dialogues.id
            AND m.deleted_at IS NULL
            AND (m.type IS NULL OR m.type NOT IN ('transcription','freeform_submit','freeform_judge'))
        )
      )`);
    }
    params.push(limit);
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM ai_dialogues
       WHERE ${conditions.join(' AND ')}
       ORDER BY id DESC LIMIT ?`,
      params,
    );
    return rows as AiDialogueRow[];
  }
```

- [ ] **Step 4: 跑仓库测试确认通过**

Run: `cd apps/server && npx vitest run src/database/repositories/ai-dialogues.repo.test.ts`
Expected: PASS（2 passed）

- [ ] **Step 5: 写服务测试（先红）**

在 `conversations.service.test.ts` 的 Fake repo 里替换 `findByStudentAndTrack`（第 27-34 行）：

```ts
  lastFindArgs: { scenes?: string[]; hasChat?: boolean } = {};
  async findByStudentAndTrack(
    studentId: number,
    track: string,
    limit: number,
    _cursor?: number,
    scene?: AiDialogueScene | AiDialogueScene[],
    hasChat = false,
  ) {
    this.lastFindArgs = { scenes: scene == null ? undefined : (Array.isArray(scene) ? scene : [scene]), hasChat };
    const scenes = Array.isArray(scene) ? scene : scene ? [scene] : [];
    return this.rows
      .filter((r) => r.student_id === studentId && r.track === track && !r.deleted_at)
      .filter((r) => scenes.length === 0 || scenes.includes(r.scene))
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
  }
```

在 describe 里追加：

```ts
  it('list 支持多 scene', async () => {
    await svc.create(1, { track: 'auxiliary' });
    await svc.create(1, { track: 'auxiliary', scene: 'aux_freeform', subjectId: 1 });
    const rows = await svc.list(1, 'auxiliary', undefined, ['aux_qna', 'aux_freeform']);
    expect(rows.map((r) => r.scene).sort()).toEqual(['aux_freeform', 'aux_qna']);
  });

  it('list 透传 hasChat', async () => {
    await svc.list(1, 'auxiliary', undefined, ['aux_qna', 'aux_freeform'], true);
    expect(dialogues.lastFindArgs.hasChat).toBe(true);
  });

  it('非法 scene -> 400/1001', async () => {
    await expect(svc.list(1, 'auxiliary', undefined, ['nope' as any]))
      .rejects.toMatchObject({ response: { code: 1001 } });
  });

  it('hasChat 非 0/1 -> 400/1001', async () => {
    await expect(svc.list(1, 'auxiliary', undefined, undefined, 'yes' as any))
      .rejects.toMatchObject({ response: { code: 1001 } });
  });
```

- [ ] **Step 6: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/conversations/conversations.service.test.ts`
Expected: FAIL（多 scene 未实现 / 未校验）

- [ ] **Step 7: 改 service + controller**

`conversations.service.ts` 在类里加常量并替换 `list`：

```ts
  private static readonly VALID_SCENES = new Set<AiDialogueScene>([
    'aux_qna', 'aux_training', 'aux_freeform', 'mainline_question', 'mainline_card',
  ]);

  async list(
    studentId: number,
    track: 'mainline' | 'auxiliary',
    cursor?: number,
    scenes?: AiDialogueScene[],
    hasChat?: boolean | string,
  ) {
    if (scenes?.length) {
      const invalid = scenes.find((s) => !ConversationsService.VALID_SCENES.has(s));
      if (invalid) {
        throw new BadRequestException({ code: 1001, message: `scene 非法：${invalid}` });
      }
    }
    if (hasChat != null && hasChat !== '' && hasChat !== true && hasChat !== false && hasChat !== '0' && hasChat !== '1') {
      throw new BadRequestException({ code: 1001, message: 'hasChat 只能为 0 或 1' });
    }
    return this.dialoguesRepo.findByStudentAndTrack(
      studentId,
      track,
      this.PAGE_SIZE,
      cursor,
      scenes,
      hasChat === true || hasChat === '1',
    );
  }
```

`conversations.controller.ts:22-35` 替换：

```ts
  @Get()
  async list(
    @Query('track') track: 'mainline' | 'auxiliary',
    @Query('cursor') cursor: string,
    @Query('scene') scene: string,
    @Query('hasChat') hasChat: string,
    @CurrentUser() user: JwtUser,
  ) {
    const scenes = scene
      ? ([...new Set(scene.split(',').map((s) => s.trim()).filter(Boolean))] as AiDialogueScene[])
      : undefined;
    return this.conversationsService.list(
      user.sub,
      track,
      cursor ? Number(cursor) : undefined,
      scenes,
      hasChat,
    );
  }
```

（在 controller 顶部补 `import type { AiDialogueScene } from '../../database/repositories/types.js';`，或从 service 导出类型。保持 `import type` 以免运行时依赖。）

- [ ] **Step 8: 跑服务测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/conversations/conversations.service.test.ts`
Expected: PASS（含原有 aux_freeform 用例）

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/database/repositories/ai-dialogues.repo.ts \
        apps/server/src/database/repositories/ai-dialogues.repo.test.ts \
        apps/server/src/modules/conversations/conversations.service.ts \
        apps/server/src/modules/conversations/conversations.controller.ts \
        apps/server/src/modules/conversations/conversations.service.test.ts
git commit -m "feat(conversations): 列表支持多 scene 与 hasChat 过滤"
```

---

### Task 2: 前端会话列表接入 freeform 聊天会话

**Files:**
- Modify: `apps/web/src/services/api.ts:473-498`
- Modify: `apps/web/src/store/auxiliaryStore.ts:30-37`
- Modify: `apps/web/src/components/business/ConversationList.tsx:13-18`
- Modify: `apps/web/src/pages/student/ConversationManagePage.tsx:72-80`
- Test: `apps/web/src/components/business/ConversationList.test.tsx`（新建）
- Test: `apps/web/src/services/api.conversations.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `scene=aux_qna,aux_freeform&hasChat=1`
- Produces:
  - `listConversations(track: 'auxiliary', scenes: AiConversationScene[], cursor?: number, opts?: { hasChat?: boolean }): Promise<ConversationItem[]>`
  - `listAllConversations(track: 'auxiliary', scenes: AiConversationScene[], opts?: { hasChat?: boolean }): Promise<ConversationItem[]>`

- [ ] **Step 1: 写 API 测试（先红）**

新建 `apps/web/src/services/api.conversations.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listConversations } from './api';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(data: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    json: () => Promise.resolve({ code: 0, message: 'ok', data }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('listConversations query', () => {
  it('多 scene 逗号拼接 + hasChat=1（钉全串，含 /api 前缀）', async () => {
    const fetchMock = stubFetch([]);

    await listConversations('auxiliary', ['aux_qna', 'aux_freeform'], undefined, { hasChat: true });

    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/conversations?track=auxiliary&scene=aux_qna%2Caux_freeform&hasChat=1',
    );
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/services/api.conversations.test.ts`
Expected: FAIL（签名不匹配 / URL 无 hasChat）

- [ ] **Step 3: 改 api.ts**

替换 473-498：

```ts
export function listConversations(
  track: 'auxiliary',
  scenes: AiConversationScene[],
  cursor?: number,
  opts?: { hasChat?: boolean },
): Promise<ConversationItem[]> {
  const params = new URLSearchParams({ track, scene: scenes.join(',') });
  if (cursor) params.set('cursor', String(cursor));
  if (opts?.hasChat) params.set('hasChat', '1');
  return fetchApi<ConversationItem[]>(`/conversations?${params.toString()}`);
}

// Fetch ALL conversations by walking the cursor-paginated list endpoint.
// 仍按 10 条/页、最多 50 页兜底。
export async function listAllConversations(
  track: 'auxiliary',
  scenes: AiConversationScene[],
  opts?: { hasChat?: boolean },
): Promise<ConversationItem[]> {
  const PAGE = 10;
  const all: ConversationItem[] = [];
  let cursor: number | undefined;
  for (let i = 0; i < 50; i++) {
    const page = await listConversations(track, scenes, cursor, opts);
    all.push(...page);
    if (page.length < PAGE) break;
    cursor = page[page.length - 1].id;
  }
  return all;
}
```

- [ ] **Step 4: 改三个调用点**

`auxiliaryStore.ts:32`：

```ts
const items = await listAllConversations('auxiliary', ['aux_qna', 'aux_freeform'], { hasChat: true });
```

`ConversationList.tsx:16`：

```ts
listAllConversations('auxiliary', ['aux_qna', 'aux_freeform'], { hasChat: true })
```

`ConversationManagePage.tsx:76`：

```ts
listAllConversations('auxiliary', ['aux_qna', 'aux_freeform'], { hasChat: true })
```

- [ ] **Step 5: 补列表渲染测试**

新建 `apps/web/src/components/business/ConversationList.test.tsx`：

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ConversationList from './ConversationList';
import { listAllConversations } from '@/services/api';
import { useAuxiliaryStore } from '@/store/auxiliaryStore';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, listAllConversations: vi.fn() };
});

const listMock = vi.mocked(listAllConversations);

beforeEach(() => {
  listMock.mockReset();
  useAuxiliaryStore.setState({ conversations: [], currentDialogueId: null });
});

afterEach(() => cleanup());

describe('ConversationList：做题答疑会话', () => {
  it('同时查答疑与做题会话，并要求只返回聊过天的做题会话', async () => {
    listMock.mockResolvedValue([]);
    render(<MemoryRouter><ConversationList /></MemoryRouter>);
    await screen.findByText('暂无历史会话');
    expect(listMock).toHaveBeenCalledWith('auxiliary', ['aux_qna', 'aux_freeform'], { hasChat: true });
  });
});
```

- [ ] **Step 6: 跑前端测试**

Run: `cd apps/web && npx vitest run src/services/api.conversations.test.ts src/components/business/ConversationList.test.tsx`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/services/api.ts \
        apps/web/src/services/api.conversations.test.ts \
        apps/web/src/store/auxiliaryStore.ts \
        apps/web/src/components/business/ConversationList.tsx \
        apps/web/src/components/business/ConversationList.test.tsx \
        apps/web/src/pages/student/ConversationManagePage.tsx
git commit -m "feat(web): 辅助答疑列表接入做题聊天会话"
```

---

### Task 3: 历史回放 Markdown + 去信封

**Files:**
- Modify: `apps/web/src/hooks/useAuxChat.ts:191-219`
- Test: `apps/web/src/hooks/useAuxChat.test.ts`（新建）

**Interfaces:**
- Produces:
  - `stripFreeformSubmitEnvelope(content: string): string`
  - `mapHistoryMessage(m: MessageItem): ChatMessage`

- [ ] **Step 1: 写纯函数测试（先红）**

新建 `apps/web/src/hooks/useAuxChat.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { mapHistoryMessage, stripFreeformSubmitEnvelope } from './useAuxChat';
import type { MessageItem } from '@/services/api';

const base: MessageItem = {
  id: 1, dialogue_id: 7, role: 'user', content: '', reasoning: null,
  type: null, attachments: null, created_at: '', safety_flag: 0,
} as MessageItem;

describe('stripFreeformSubmitEnvelope', () => {
  it('去掉「题目/我的作答」信封，只留作答', () => {
    expect(stripFreeformSubmitEnvelope('题目：\n求 $x$\n\n我的作答：\n$x=1$')).toBe('$x=1$');
  });

  it('没有信封时原样返回', () => {
    expect(stripFreeformSubmitEnvelope('普通消息')).toBe('普通消息');
  });

  it('只提交草稿（正文为空）给占位，不留空白气泡', () => {
    expect(stripFreeformSubmitEnvelope('题目：\n题\n\n我的作答：\n')).toBe('（本次仅提交了草稿）');
  });
});

describe('mapHistoryMessage', () => {
  it('freeform_submit 标成 markdown 并去信封', () => {
    const m = mapHistoryMessage({
      ...base,
      type: 'freeform_submit',
      content: '题目：\n题\n\n我的作答：\n**答案**',
    });
    expect(m.markdown).toBe(true);
    expect(m.content).toBe('**答案**');
  });

  it('普通答疑消息仍是纯文本', () => {
    const m = mapHistoryMessage({ ...base, content: '$x=1$' });
    expect(m.markdown).toBeUndefined();
    expect(m.content).toBe('$x=1$');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/hooks/useAuxChat.test.ts`
Expected: FAIL（导出不存在）

- [ ] **Step 3: 实现纯函数并接入历史映射**

在 `useAuxChat.ts` 顶部（组件外）加：

```ts
/** 做题判题落库的 user 消息形如「题目：… 我的作答：…」；回放只显示作答，题干由锚消息展示。 */
export function stripFreeformSubmitEnvelope(content: string): string {
  const marker = '\n\n我的作答：\n';
  const i = content.lastIndexOf(marker);
  if (i < 0) return content;
  const body = content.slice(i + marker.length);
  // 只提交草稿时正文为空：给一句占位，避免空白气泡
  return body.trim() ? body : '（本次仅提交了草稿）';
}

/** 历史消息 → 气泡模型（导出供单测；做题作答按 Markdown 渲染）。 */
export function mapHistoryMessage(m: MessageItem): ChatMessage {
  let images: string[] | undefined;
  if (m.attachments) {
    try {
      const parsed = JSON.parse(m.attachments) as Array<{ type: string; url: string }>;
      const urls = parsed.filter((a) => a.type === 'image' && !!a.url).map((a) => a.url);
      if (urls.length) images = urls;
    } catch {
      // 坏 JSON 忽略
    }
  }
  const isFreeformSubmit = m.type === 'freeform_submit';
  return {
    id: m.id,
    role: m.role as 'user' | 'assistant',
    content: isFreeformSubmit ? stripFreeformSubmitEnvelope(m.content) : m.content,
    reasoning: m.reasoning ?? undefined,
    type: m.type ?? undefined,
    images,
    ...(isFreeformSubmit ? { markdown: true } : {}),
  };
}
```

把 effect 里的 `.map((m) => { ... })` 整段替换成：

```ts
          setMessages(
            items
              .filter((m) => m.role === 'user' || m.role === 'assistant')
              .map(mapHistoryMessage),
          );
```

补 import `type ChatMessage`（`useChatStore` 已导出）。

- [ ] **Step 4: 跑测试确认通过 + 面板回归**

Run: `cd apps/web && npx vitest run src/hooks/useAuxChat.test.ts src/components/business/AuxChatPanel.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/hooks/useAuxChat.ts apps/web/src/hooks/useAuxChat.test.ts
git commit -m "fix(web): 做题历史回放按 Markdown 渲染并去掉题干信封"
```

---

### Task 4: 知识点标注能力（freeform_tag）

**Files:**
- Modify: `apps/server/src/ai-core/types.ts`（`CapabilityType` 联合类型）
- Modify: `apps/server/src/ai-core/infra/prompt-builder.ts:113-120`（新分支）
- Create: `apps/server/src/ai-core/prompts/freeform/tag.md`
- Create: `apps/server/src/ai-core/capabilities/freeform-tag.capability.ts`
- Test: `apps/server/src/ai-core/capabilities/freeform-tag.capability.test.ts`（新建）

**Interfaces:**
- Produces:

```ts
export interface FreeformTagRequest {
  question: string;
  subjectId: number;
  subjectName: string;
  gradeBand: 'primary' | 'junior' | 'senior';
  knowledgePointOptions: Array<{ id: number; name: string }>;
}

export interface FreeformTagResult {
  type: 'choice' | 'multi_choice' | 'fill_blank' | 'true_false' | 'short_answer' | 'proof' | 'calculation';
  difficulty: 1 | 2 | 3;
  answer: string;
  explanation: string;
  approach: string | null;
  options: Array<{ label: string; text: string; isCorrect: boolean }> | null;
  knowledgePointIds: number[];
  confidence: 'high' | 'medium' | 'low';
}
```

- `FreeformTagCapability.tag(request: FreeformTagRequest): Promise<FreeformTagResult>`

- [ ] **Step 1: 写能力测试（先红）**

新建 `apps/server/src/ai-core/capabilities/freeform-tag.capability.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { FreeformTagCapability } from './freeform-tag.capability';

const chat = vi.fn();

describe('FreeformTagCapability', () => {
  it('只保留候选清单内的知识点 id，最多 3 个', async () => {
    chat.mockResolvedValue({
      content: JSON.stringify({
        type: 'short_answer', difficulty: 2, answer: 'x=1', explanation: '移项',
        approach: '移项求解', options: null,
        knowledgePointIds: [11, 99, 12, 13, 11], confidence: 'high',
      }),
    });
    const cap = new FreeformTagCapability({ modelClient: { chat } as any });
    const r = await cap.tag({
      question: '解方程 x+1=2', subjectId: 1, subjectName: '数学', gradeBand: 'junior',
      knowledgePointOptions: [{ id: 11, name: '一元一次方程' }, { id: 12, name: '移项' }, { id: 13, name: '解方程' }],
    });
    expect(r.knowledgePointIds).toEqual([11, 12, 13]);
    expect(r.answer).toBe('x=1');
  });

  it('模型返回坏 JSON 时降级为低置信度空结果', async () => {
    chat.mockResolvedValue({ content: 'not json' });
    const cap = new FreeformTagCapability({ modelClient: { chat } as any });
    const r = await cap.tag({
      question: '题', subjectId: 1, subjectName: '数学', gradeBand: 'junior',
      knowledgePointOptions: [],
    });
    expect(r.knowledgePointIds).toEqual([]);
    expect(r.answer).toBe('');
    expect(r.confidence).toBe('low');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/ai-core/capabilities/freeform-tag.capability.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写提示词**

新建 `apps/server/src/ai-core/prompts/freeform/tag.md`：

```markdown
---
version: "1.0"
description: "做题题目的结构化标注：答案、解析、题型、难度、知识点（只能从给定清单选 id）"
---

## System Prompt

你是 K12 题目结构化标注器。给定一道题和该学科的知识点清单，输出严格 JSON，用于入库与练习抽题。

要求：
1. 解题并给出标准答案 `answer` 与解析 `explanation`；答案必须可判（选择题给选项 label，填空给最终值，解答题给完整结论）。
2. `type` 只能是 choice / multi_choice / fill_blank / true_false / short_answer / proof / calculation。
3. `difficulty` 只能是 1（易）/ 2（中）/ 3（难）。
4. `knowledgePointIds` **只能**从清单里选，1～3 个，按主次排序；清单里没有合适的就返回空数组，不要编造 id。
5. 选择题必须给 `options`（label/text/isCorrect）；其它题型 `options` 为 null。
6. 数学公式用 LaTeX：行内 `$...$`，独立 `$$...$$`。
7. 看不清 / 信息不足时，`confidence` 给 "low"，不要瞎猜答案。
8. 只输出 JSON，不要 Markdown 代码块，不要解释。

输出：
{
  "type": "short_answer",
  "difficulty": 2,
  "answer": "x=1",
  "explanation": "移项得 x=2-1=1",
  "approach": "先移项再合并",
  "options": null,
  "knowledgePointIds": [11, 12],
  "confidence": "high"
}

## User Message

学科：{{subjectName}}
学段：{{gradeBand}}

题目：
{{question}}

可选知识点（id: 名称）：
{{knowledgePointOptions}}

请输出 JSON。
```

- [ ] **Step 4: 注册能力类型与模板路径**

`apps/server/src/ai-core/types.ts` 的 `CapabilityType` 联合里加 `'freeform_tag'`。

`prompt-builder.ts` 在 `freeform_tutor` 分支后加：

```ts
    if (capability === 'freeform_tag') return 'freeform/tag.md';
```

- [ ] **Step 5: 写能力实现**

新建 `apps/server/src/ai-core/capabilities/freeform-tag.capability.ts`：

```ts
import { z } from 'zod';
import { timeoutConfig } from '../config.js';
import { ModelRouter } from '../infra/model-router.js';
import { getModelConfigRegistry } from '../infra/model-config-registry.js';
import { PromptBuilder } from '../infra/prompt-builder.js';
import { ModelClient } from '../infra/model-client/index.js';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TYPES = ['choice', 'multi_choice', 'fill_blank', 'true_false', 'short_answer', 'proof', 'calculation'] as const;

const TagSchema = z.object({
  type: z.enum(TYPES),
  difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  answer: z.string(),
  explanation: z.string(),
  approach: z.string().nullable().optional(),
  options: z.array(z.object({ label: z.string(), text: z.string(), isCorrect: z.boolean() })).nullable().optional(),
  knowledgePointIds: z.array(z.number()).default([]),
  confidence: z.enum(['high', 'medium', 'low']).default('low'),
});

export type FreeformTagResult = z.infer<typeof TagSchema> & { approach: string | null; options: Array<{ label: string; text: string; isCorrect: boolean }> | null };

export interface FreeformTagRequest {
  question: string;
  subjectId: number;
  subjectName: string;
  gradeBand: 'primary' | 'junior' | 'senior';
  knowledgePointOptions: Array<{ id: number; name: string }>;
}

const EMPTY: FreeformTagResult = {
  type: 'short_answer', difficulty: 1, answer: '', explanation: '',
  approach: null, options: null, knowledgePointIds: [], confidence: 'low',
};

export interface FreeformTagCapabilityDeps {
  modelClient?: ModelClient;
}

/** 学科无关的做题题目标注器。刻意不写 @Injectable()（零参可实例化）。 */
export class FreeformTagCapability {
  private modelRouter = new ModelRouter(getModelConfigRegistry());
  private promptBuilder: PromptBuilder;
  private modelClient: ModelClient;

  constructor(deps?: FreeformTagCapabilityDeps) {
    this.promptBuilder = new PromptBuilder(resolve(__dirname, '../prompts'));
    this.modelClient = deps?.modelClient ?? new ModelClient();
  }

  async tag(request: FreeformTagRequest): Promise<FreeformTagResult> {
    const allowed = new Set(request.knowledgePointOptions.map((k) => k.id));
    const optionsText = request.knowledgePointOptions.map((k) => `${k.id}: ${k.name}`).join('\n') || '（无）';
    try {
      const prompt = await this.promptBuilder.build({
        capability: 'freeform_tag',
        subject: 'math',
        context: {
          student: { grade: '', gradeLevel: '' },
          userMessage: request.question,
          customVariables: {
            subjectName: request.subjectName,
            gradeBand: request.gradeBand,
            question: request.question,
            knowledgePointOptions: optionsText,
          },
        },
      });
      const route = this.modelRouter.route({ scene: 'structuring', subject: 'math' });
      const res = await this.modelClient.chat({
        model: route.primary,
        messages: prompt.messages,
        responseFormat: 'json_object',
        timeout: timeoutConfig.timeout.structuring ?? timeoutConfig.timeout.default,
      });
      const parsed = TagSchema.parse(JSON.parse(res.content));
      return {
        ...parsed,
        approach: parsed.approach ?? null,
        options: parsed.options ?? null,
        // 只保留候选清单内的 id：去重 + 限 3 个
        knowledgePointIds: [...new Set(parsed.knowledgePointIds)]
          .filter((id) => allowed.has(id))
          .slice(0, 3),
      };
    } catch {
      return { ...EMPTY };
    }
  }
}
```

> 说明：`promptBuilder.build` 的 `subject` 只影响模板解析；`freeform_tag` 走单个通用模板，传 `'math'` 不影响结果。模型路由复用 `structuring` 场景（所有学科都有配置）。

- [ ] **Step 6: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/ai-core/capabilities/freeform-tag.capability.test.ts`
Expected: PASS（2 passed）

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/ai-core/capabilities/freeform-tag.capability.ts \
        apps/server/src/ai-core/capabilities/freeform-tag.capability.test.ts \
        apps/server/src/ai-core/prompts/freeform/tag.md \
        apps/server/src/ai-core/infra/prompt-builder.ts \
        apps/server/src/ai-core/types.ts
git commit -m "feat(ai-core): 新增做题题目知识点标注能力"
```

---

### Task 5: 答疑即入库（补题 + 错题本）

**Files:**
- Create: `apps/server/src/modules/freeform/freeform-chat-ingest.service.ts`
- Create: `apps/server/src/modules/freeform/freeform-chat-ingest.service.test.ts`
- Modify: `apps/server/src/database/repositories/questions.repo.ts:26-34`（`findByContentPrefix` 加学科限定）
- Modify: `apps/server/src/modules/freeform/freeform.module.ts`
- Modify: `apps/server/src/modules/ai/ai.module.ts`（import FreeformModule）
- Modify: `apps/server/src/modules/ai/ai.service.ts:34-49, 94-101, 155-181`
- Modify: `apps/server/src/modules/ai/ai.service.test.ts:58-62`（mkService 补第 11 个依赖）

**Interfaces:**
- Consumes:
  - `FreeformTagCapability.tag()`（Task 4）
  - `QuestionsRepository.findByContentPrefix(content: string, opts?: { subjectId?: number; limit?: number })`
  - `QuestionsRepository` / `MainErrorBooksRepository` / `AiDialoguesRepository` / `AiMessagesRepository` / `KnowledgePointsRepository` / `SubjectsRepository` / `StudentsRepository`
- Produces:

```ts
class FreeformChatIngestService {
  /** 答疑流结束后调用；幂等、永不 reject。 */
  maybeIngest(dialogueId: string, studentId: number): Promise<void>;
  /** 判题落库后补知识点；幂等、永不 reject。 */
  tagExistingQuestion(questionId: number, content: string, subjectId: number, studentId: number): Promise<void>;
}
```

- [ ] **Step 1: 写服务测试（先红）**

新建 `apps/server/src/modules/freeform/freeform-chat-ingest.service.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { FreeformChatIngestService } from './freeform-chat-ingest.service';

const mk = (over: any = {}) => ({
  dialogues: {
    findById: vi.fn().mockResolvedValue({ id: 7, student_id: 9, scene: 'aux_freeform', subject_id: 1, question_id: null }),
    updateQuestionId: vi.fn().mockResolvedValue(undefined),
  },
  messages: {
    findByDialogue: vi.fn().mockResolvedValue([
      { role: 'assistant', type: 'transcription', content: '解方程 $x+1=2$' },
      { role: 'user', type: 'socratic', content: '怎么移项？' },
      { role: 'assistant', type: 'socratic', content: '两边同时减 1。' },
    ]),
  },
  questions: {
    findByContentHash: vi.fn().mockResolvedValue(null),
    findByContentPrefix: vi.fn().mockResolvedValue([]),
    createFreeform: vi.fn().mockResolvedValue(11),
    bindKnowledgePoint: vi.fn().mockResolvedValue(undefined),
    findKnowledgePointIdsByQuestion: vi.fn().mockResolvedValue([]),
  },
  errorBooks: {
    existsByStudentAndQuestionId: vi.fn().mockResolvedValue(false),
    create: vi.fn().mockResolvedValue(22),
    updateDialogueId: vi.fn().mockResolvedValue(undefined),
  },
  kps: { findBySubject: vi.fn().mockResolvedValue([{ id: 11, name: '一元一次方程' }]) },
  subjects: { findById: vi.fn().mockResolvedValue({ id: 1, name: '数学' }) },
  students: { findById: vi.fn().mockResolvedValue({ id: 9, schoolLevel: 'junior' }) },
  tagger: {
    tag: vi.fn().mockResolvedValue({
      type: 'short_answer', difficulty: 2, answer: 'x=1', explanation: '移项',
      approach: '移项求解', options: null, knowledgePointIds: [11], confidence: 'high',
    }),
  },
  ...over,
});

const svc = (d: ReturnType<typeof mk>) =>
  new FreeformChatIngestService(
    d.dialogues as any, d.messages as any, d.questions as any, d.errorBooks as any,
    d.kps as any, d.subjects as any, d.students as any, d.tagger as any,
  );

describe('FreeformChatIngestService.maybeIngest', () => {
  it('有聊天、无题：建题 + 绑 KP + 写错题本 + 回填会话', async () => {
    const d = mk();
    await svc(d).maybeIngest('7', 9);
    expect(d.questions.createFreeform).toHaveBeenCalledWith(expect.objectContaining({
      subject_id: 1, answer: 'x=1', source: 'freeform', full_score: 10,
    }));
    expect(d.questions.bindKnowledgePoint).toHaveBeenCalledWith(11, 11, 'primary');
    expect(d.errorBooks.create).toHaveBeenCalledWith(expect.objectContaining({
      student_id: 9, question_id: 11, source: 'freeform',
    }));
    expect(d.dialogues.updateQuestionId).toHaveBeenCalledWith(7, 11);
  });

  it('会话已有 question_id：直接跳过', async () => {
    const d = mk();
    d.dialogues.findById.mockResolvedValue({ id: 7, student_id: 9, scene: 'aux_freeform', subject_id: 1, question_id: 11 });
    await svc(d).maybeIngest('7', 9);
    expect(d.tagger.tag).not.toHaveBeenCalled();
    expect(d.questions.createFreeform).not.toHaveBeenCalled();
  });

  it('已有该题错题行（含已清零）：不重建（满分后答疑不进）', async () => {
    const d = mk();
    d.questions.findByContentHash.mockResolvedValue({ id: 11 });
    d.errorBooks.existsByStudentAndQuestionId.mockResolvedValue(true);
    await svc(d).maybeIngest('7', 9);
    expect(d.questions.createFreeform).not.toHaveBeenCalled();
    expect(d.errorBooks.create).not.toHaveBeenCalled();
    expect(d.dialogues.updateQuestionId).toHaveBeenCalledWith(7, 11);
  });

  it('标注失败：仍建空答案题 + 错题本（不可练，但可见）', async () => {
    const d = mk();
    d.tagger.tag.mockResolvedValue({
      type: 'short_answer', difficulty: 1, answer: '', explanation: '',
      approach: null, options: null, knowledgePointIds: [], confidence: 'low',
    });
    await svc(d).maybeIngest('7', 9);
    expect(d.questions.createFreeform).toHaveBeenCalledWith(expect.objectContaining({ answer: '' }));
    expect(d.questions.bindKnowledgePoint).not.toHaveBeenCalled();
    expect(d.errorBooks.create).toHaveBeenCalled();
  });

  it('题目不存在 / 非本人：静默返回', async () => {
    const d = mk();
    d.dialogues.findById.mockResolvedValue({ id: 7, student_id: 999, scene: 'aux_freeform', subject_id: 1, question_id: null });
    await expect(svc(d).maybeIngest('7', 9)).resolves.toBeUndefined();
    expect(d.questions.createFreeform).not.toHaveBeenCalled();
  });

  it('会话没有 subject_id：跳过（不默认数学）', async () => {
    const d = mk();
    d.dialogues.findById.mockResolvedValue({ id: 7, student_id: 9, scene: 'aux_freeform', subject_id: null, question_id: null });
    await svc(d).maybeIngest('7', 9);
    expect(d.tagger.tag).not.toHaveBeenCalled();
    expect(d.questions.createFreeform).not.toHaveBeenCalled();
  });

  it('会话已有判题报告消息：跳过（兜底 question_id 回填失败）', async () => {
    const d = mk();
    d.messages.findByDialogue.mockResolvedValue([
      { role: 'assistant', type: 'transcription', content: '题' },
      { role: 'assistant', type: 'freeform_judge', content: '判题报告' },
    ]);
    await svc(d).maybeIngest('7', 9);
    expect(d.questions.createFreeform).not.toHaveBeenCalled();
    expect(d.errorBooks.create).not.toHaveBeenCalled();
  });

  it('只有题干锚 + block 回复：跳过（安全阻断不算聊过）', async () => {
    const d = mk();
    d.messages.findByDialogue.mockResolvedValue([
      { role: 'assistant', type: 'transcription', content: '题' },
      { role: 'assistant', type: 'block', content: '先专心学习吧' },
    ]);
    await svc(d).maybeIngest('7', 9);
    expect(d.questions.createFreeform).not.toHaveBeenCalled();
  });

  it('前缀去重带学科 + 选项剥 isCorrect', async () => {
    const d = mk();
    d.tagger.tag.mockResolvedValue({
      type: 'choice', difficulty: 2, answer: 'A', explanation: '',
      approach: null, options: [{ label: 'A', text: '1', isCorrect: true }],
      knowledgePointIds: [11], confidence: 'high',
    });
    await svc(d).maybeIngest('7', 9);
    expect(d.questions.findByContentPrefix).toHaveBeenCalledWith('解方程 $x+1=2$', { subjectId: 1 });
    expect(d.questions.createFreeform).toHaveBeenCalledWith(expect.objectContaining({
      options: JSON.stringify([{ label: 'A', text: '1' }]),
    }));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/freeform/freeform-chat-ingest.service.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写服务实现**

**3a. 先给前缀去重加学科限定**（否则不同学科同开头会误合并）。

`questions.repo.ts:24-34` 改为：

```ts
  async findByContentPrefix(
    content: string,
    opts?: { subjectId?: number; limit?: number },
  ): Promise<QuestionRow[]> {
    const prefix = contentPrefix(content);
    if (prefix.length < 4) return [];
    const needle = prefix.slice(0, Math.min(6, prefix.length));
    const conditions = ['is_active = 1', "content LIKE CONCAT('%', ?, '%')"];
    const params: Array<number | string> = [needle];
    if (opts?.subjectId != null) {
      conditions.push('subject_id = ?');
      params.push(opts.subjectId);
    }
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM questions WHERE ${conditions.join(' AND ')} ORDER BY id DESC LIMIT 50`,
      params,
    );
    return (rows as QuestionRow[]).filter((r) => contentPrefix(r.content) === prefix).slice(0, opts?.limit ?? 20);
  }
```

新建 `apps/server/src/database/repositories/questions.prefix.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { QuestionsRepository } from './questions.repo';

describe('QuestionsRepository.findByContentPrefix', () => {
  it('传 subjectId 时 SQL 带 subject_id 条件', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([[], []]), query: vi.fn() };
    const repo = new QuestionsRepository(pool as any);
    await repo.findByContentPrefix('阅读下面的文字，完成题目', { subjectId: 2 });

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('subject_id = ?');
    expect(params).toEqual(['阅读下面的文字', 2]);
  });
});
```

Run: `cd apps/server && npx vitest run src/database/repositories/questions.prefix.test.ts`
Expected: FAIL（参数还不支持）

**3b. 再写服务实现。**

新建 `apps/server/src/modules/freeform/freeform-chat-ingest.service.ts`：

```ts
import { Injectable, Logger } from '@nestjs/common';
import { AiDialoguesRepository } from '../../database/repositories/ai-dialogues.repo.js';
import { AiMessagesRepository } from '../../database/repositories/ai-messages.repo.js';
import { QuestionsRepository } from '../../database/repositories/questions.repo.js';
import { MainErrorBooksRepository } from '../../database/repositories/main-error-books.repo.js';
import { KnowledgePointsRepository } from '../../database/repositories/knowledge-points.repo.js';
import { SubjectsRepository } from '../../database/repositories/subjects.repo.js';
import { StudentsRepository } from '../../database/repositories/students.repo.js';
import { FreeformTagCapability } from '../../ai-core/capabilities/freeform-tag.capability.js';
import { computeFreeformContentHash, stripMarkdownImages } from '../../common/utils/content-hash.util.js';

const DEFAULT_FULL_SCORE = 10;

/**
 * 做题答疑的「聊过即入库」：只答疑、没提交的题也要进错题本。
 *
 * 约束：
 * - 全部 fire-and-forget，调用方一律 `void`；本服务**永不 reject**。
 * - 幂等：会话已有 question_id / 该生已有该题错题行（含已清零）→ 跳过。
 * - 判题满分后再答疑：同一会话 question_id 已存在，天然跳过。
 */
@Injectable()
export class FreeformChatIngestService {
  private readonly logger = new Logger(FreeformChatIngestService.name);
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly dialogues: AiDialoguesRepository,
    private readonly messages: AiMessagesRepository,
    private readonly questions: QuestionsRepository,
    private readonly errorBooks: MainErrorBooksRepository,
    private readonly kps: KnowledgePointsRepository,
    private readonly subjects: SubjectsRepository,
    private readonly students: StudentsRepository,
    private readonly tagger: FreeformTagCapability,
  ) {}

  maybeIngest(dialogueId: string, studentId: number): Promise<void> {
    const key = `d:${dialogueId}`;
    const running = this.inFlight.get(key);
    if (running) return running;
    const p = this.ingest(dialogueId, studentId)
      .catch((err) => this.logger.warn(`freeform ingest failed (dialogue=${dialogueId}): ${err instanceof Error ? err.message : err}`))
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }

  tagExistingQuestion(questionId: number, content: string, subjectId: number, studentId: number): Promise<void> {
    const key = `q:${questionId}`;
    const running = this.inFlight.get(key);
    if (running) return running;
    const p = this.tag(questionId, content, subjectId, studentId)
      .catch((err) => this.logger.warn(`freeform tag failed (question=${questionId}): ${err instanceof Error ? err.message : err}`))
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }

  private async ingest(dialogueId: string, studentId: number): Promise<void> {
    const dlg = await this.dialogues.findById(Number(dialogueId));
    if (!dlg || dlg.student_id !== studentId || dlg.scene !== 'aux_freeform') return;
    if (dlg.question_id != null) return;

    const msgs = await this.messages.findByDialogue(Number(dialogueId));
    // 判题已发生就不再补题（兜底 question_id 回填失败；也避免满分题被误收）
    if (msgs.some((m) => m.type === 'freeform_judge')) return;
    // 只有题干锚 / 被安全阻断（block）不算「聊过」
    const hasRealAnswer = msgs.some(
      (m) => m.role === 'assistant' && m.type !== 'transcription' && m.type !== 'block',
    );
    if (!hasRealAnswer) return;
    const anchor = msgs.find((m) => m.role === 'assistant' && m.type === 'transcription');
    if (!anchor?.content?.trim()) return;

    // 会话没有学科就不猜（默认数学会让物理题进数学专项）
    const subjectId = dlg.subject_id;
    if (subjectId == null) return;

    const content = anchor.content.trim();
    // 纯图片题：模型看不到图，标注没有依据 → 建空答案题，不挂 KP（answerable=false）
    const text = stripMarkdownImages(content).trim();
    const hash = computeFreeformContentHash(content);

    let questionId: number | null =
      (await this.questions.findByContentHash(hash))?.id ??
      (await this.questions.findByContentPrefix(text || content, { subjectId }))[0]?.id ??
      null;

    if (questionId == null) {
      const subject = await this.subjects.findById(subjectId).catch(() => null);
      const result = text
        ? await this.tagger.tag({
            question: text,
            subjectId,
            subjectName: subject?.name ?? '数学',
            gradeBand: await this.gradeBandOf(studentId),
            knowledgePointOptions: (await this.kps.findBySubject(subjectId)).map((k) => ({ id: k.id, name: k.name })),
          })
        : null;
      questionId = await this.questions.createFreeform({
        subject_id: subjectId,
        type: result?.type ?? 'short_answer',
        difficulty: result?.difficulty ?? 1,
        full_score: DEFAULT_FULL_SCORE,
        content,
        // 只存 label/text，绝不存 isCorrect（解禁后接口会下发 options）
        options: stripOptionAnswers(result?.options),
        answer: result?.answer ?? '',
        approach: result?.approach ?? null,
        explanation: result?.explanation ?? '',
        source: 'freeform',
        content_hash: hash,
      });
      for (const [i, kpId] of (result?.knowledgePointIds ?? []).entries()) {
        await this.questions.bindKnowledgePoint(questionId, kpId, i === 0 ? 'primary' : 'secondary');
      }
    }

    await this.dialogues.updateQuestionId(Number(dialogueId), questionId).catch(() => {});
    if (await this.errorBooks.existsByStudentAndQuestionId(studentId, questionId)) return;

    const errorBookId = await this.errorBooks.create({
      student_id: studentId,
      subject_id: subjectId,
      question_id: questionId,
      source: 'freeform',
      source_ref_id: null,
      question_n: null,
      lesson_id: null,
      wrong_answer_text: null,
    });
    await this.errorBooks.updateDialogueId(errorBookId, Number(dialogueId)).catch(() => {});
  }

  private async tag(questionId: number, content: string, subjectId: number, studentId: number): Promise<void> {
    const existing = await this.questions.findKnowledgePointIdsByQuestion(questionId);
    if (existing.length > 0) return;

    const text = stripMarkdownImages(content).trim();
    if (!text) return; // 纯图片题没有可标注的文本

    const subject = await this.subjects.findById(subjectId).catch(() => null);
    const result = await this.tagger.tag({
      question: text,
      subjectId,
      subjectName: subject?.name ?? '数学',
      gradeBand: await this.gradeBandOf(studentId),
      knowledgePointOptions: (await this.kps.findBySubject(subjectId)).map((k) => ({ id: k.id, name: k.name })),
    });
    for (const [i, kpId] of result.knowledgePointIds.entries()) {
      await this.questions.bindKnowledgePoint(questionId, kpId, i === 0 ? 'primary' : 'secondary');
    }
  }

  /** 学段从学生档案取，不要写死 junior（小学/高中生会选到错误的 KP）。 */
  private async gradeBandOf(studentId: number): Promise<'primary' | 'junior' | 'senior'> {
    const s = await this.students.findById(studentId).catch(() => null);
    return s?.schoolLevel === 'primary' || s?.schoolLevel === 'senior' ? s.schoolLevel : 'junior';
  }
}

/** options 只存 label/text，绝不把 isCorrect 发给学生（变式题同铁律）。 */
function stripOptionAnswers(
  options: Array<{ label: string; text: string; isCorrect: boolean }> | null | undefined,
): string | null {
  if (!options?.length) return null;
  return JSON.stringify(options.map(({ label, text }) => ({ label, text })));
}
```

> `SubjectsRepository.findById` 若不存在，改用 `findByCode`/`findAll` 中已有的按 id 查询方法；实现时以仓库现有方法为准，保持构造参数是**具体类**（不要接口类型）。

- [ ] **Step 4: 注册模块**

`freeform.module.ts`：
- imports 增加 `KnowledgePointsRepository, SubjectsRepository, StudentsRepository`（从 repositories index 导出则加进去）。
- providers 增加 `FreeformTagCapability`、`FreeformChatIngestService`、`KnowledgePointsRepository`、`SubjectsRepository`、`StudentsRepository`。
- exports 增加 `FreeformChatIngestService`。

```ts
import { FreeformTagCapability } from '../../ai-core/capabilities/freeform-tag.capability.js';
import { FreeformChatIngestService } from './freeform-chat-ingest.service.js';
import { KnowledgePointsRepository } from '../../database/repositories/knowledge-points.repo.js';
import { SubjectsRepository } from '../../database/repositories/subjects.repo.js';
import { StudentsRepository } from '../../database/repositories/students.repo.js';
```

`ai.module.ts`：在 `imports` 里加 `FreeformModule`（若 `FreeformModule` 已通过 AppModule 注册，重复 import 不会重复建实例）。不要造成循环：`FreeformModule` 目前不 import `AiModule`。

- [ ] **Step 5: 在答疑链路挂 hook**

`ai.service.ts` 构造参数末尾加：

```ts
    private readonly freeformChatIngest: FreeformChatIngestService,
```

import：

```ts
import { FreeformChatIngestService } from '../freeform/freeform-chat-ingest.service.js';
```

`tutor()` 在 `maybeUpdateTitle(...)` 之后、`return` 之前加：

```ts
      if (isFreeform) void this.freeformChatIngest.maybeIngest(dialogueId, userId);
```

`tutorStage()` 在循环结束后、`maybeUpdateTitle` 之后加：

```ts
    if (isFreeform) void this.freeformChatIngest.maybeIngest(dialogueId, userId);
```

- [ ] **Step 6: 更新 AI 测试桩并跑测试**

`apps/server/src/modules/ai/ai.service.test.ts` 的 `mkService` 补第 11 个参数：

```ts
    d.studentScope, d.freeformChatIngest,
```

`mkDeps` 的 base 里加：

```ts
    freeformChatIngest: { maybeIngest: vi.fn().mockResolvedValue(undefined) },
```

Run: `cd apps/server && npx vitest run src/modules/freeform/freeform-chat-ingest.service.test.ts src/modules/ai/ai.service.test.ts`
Expected: PASS（新增 9 条；ai.service 原用例不回归）

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/modules/freeform/freeform-chat-ingest.service.ts \
        apps/server/src/modules/freeform/freeform-chat-ingest.service.test.ts \
        apps/server/src/database/repositories/questions.repo.ts \
        apps/server/src/database/repositories/questions.prefix.test.ts \
        apps/server/src/modules/freeform/freeform.module.ts \
        apps/server/src/modules/ai/ai.module.ts \
        apps/server/src/modules/ai/ai.service.ts \
        apps/server/src/modules/ai/ai.service.test.ts
git commit -m "feat(freeform): 答疑聊过即补题并进错题本"
```

---

### Task 6: 判题落库后补知识点 + 命中已有题时更新

**Files:**
- Modify: `apps/server/src/modules/freeform/freeform-judge.service.ts:104-113`（构造参数）、`:186-200`（persist 后）、`:420-434`（去重分支）、`:410-418`（options）
- Modify: `apps/server/src/common/utils/parse-options.util.ts`（读取时剥 `isCorrect`）
- Test: `apps/server/src/modules/freeform/freeform-judge.service.test.ts:48-108`（mkDeps/mkService）+ 新增用例
- Test: `apps/server/src/common/utils/parse-options.util.test.ts`（新建）

**Interfaces:**
- Consumes: `FreeformChatIngestService.tagExistingQuestion(questionId, content, subjectId, studentId)`

- [ ] **Step 1: 更新测试桩（先红）**

`mkDeps` 增加：

```ts
  ingest: { tagExistingQuestion: vi.fn().mockResolvedValue(undefined) },
```

`mkService` 增加第 8 个参数。

新增用例（该文件已有 `mkDeps` / `mkService` / `baseDto` / `collect` helper）：

```ts
  it('判题落库后异步补知识点（不 await、失败不影响 result）', async () => {
    const deps = mkDeps({ capability: { stream: streamOnce(REPORT_WITH_JSON(8, 10)), extractStructured: vi.fn() } });
    const events = await collect(mkService(deps).judgeStream(baseDto(), 9));

    expect(events.some((e) => e.type === 'result')).toBe(true);
    expect(deps.ingest.tagExistingQuestion).toHaveBeenCalledWith(
      11,
      expect.stringContaining('已知 x+1=2'),
      1,
      9,
    );
  });

  it('先答疑建过题、后提交判题：用判题结果覆盖该 freeform 题', async () => {
    const deps = mkDeps({
      capability: { stream: streamOnce(REPORT_WITH_JSON(8, 10)), extractStructured: vi.fn() },
      questions: {
        findById: vi.fn().mockResolvedValue({ id: 1, source: 'freeform' }),
        findByContentHash: vi.fn().mockResolvedValue({ id: 11, source: 'freeform', content_hash: 'old' }),
        findByContentPrefix: vi.fn().mockResolvedValue([]),
        createFreeform: vi.fn(),
        updateFreeform: vi.fn().mockResolvedValue(undefined),
      },
    });
    await collect(mkService(deps).judgeStream(baseDto(), 9));

    expect(deps.questions.createFreeform).not.toHaveBeenCalled();
    expect(deps.questions.updateFreeform).toHaveBeenCalledWith(
      11,
      expect.objectContaining({ answer: 'x=1', full_score: 10 }),
      'old',
    );
  });

  it('选择题 options 落库前剥掉 isCorrect', async () => {
    const report = REPORT_WITH_JSON(8, 10, {
      type: 'choice',
      options: [
        { label: 'A', text: '1', isCorrect: true },
        { label: 'B', text: '2', isCorrect: false },
      ],
    });
    const deps = mkDeps({ capability: { stream: streamOnce(report), extractStructured: vi.fn() } });
    await collect(mkService(deps).judgeStream(baseDto(), 9));

    expect(deps.questions.createFreeform).toHaveBeenCalledWith(expect.objectContaining({
      options: '[{"label":"A","text":"1"},{"label":"B","text":"2"}]',
    }));
  });
```

新建 `parse-options.util.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { parseOptions } from './parse-options.util';

describe('parseOptions', () => {
  it('读取时剥掉历史数据里的 isCorrect', () => {
    expect(parseOptions('[{"label":"A","text":"1","isCorrect":true}]')).toEqual([
      { label: 'A', text: '1' },
    ]);
  });

  it('坏 JSON / 非数组仍返回 null', () => {
    expect(parseOptions('{bad')).toBeNull();
    expect(parseOptions('{"a":1}')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/freeform/freeform-judge.service.test.ts src/common/utils/parse-options.util.test.ts`
Expected: FAIL（构造参数数量 / 未调用 / 未剥 isCorrect）

- [ ] **Step 3: 实现**

`freeform-judge.service.ts` 构造参数末尾加：

```ts
    private readonly ingest: FreeformChatIngestService,
```

import：

```ts
import { FreeformChatIngestService } from './freeform-chat-ingest.service.js';
```

`persist` 的 `row.options` 改为（剥答案）：

```ts
      options: stripOptionAnswers(parsed.question.options),
```

在文件底部加 helper：

```ts
function stripOptionAnswers(
  options: Array<{ label: string; text: string; isCorrect: boolean }> | null | undefined,
): string | null {
  if (!options?.length) return null;
  return JSON.stringify(options.map(({ label, text }) => ({ label, text })));
}
```

`persist` 的去重分支改为（命中 freeform 题时用判题结果覆盖；题库真题仍只复用）：

```ts
    } else {
      const textForMatch = stripMarkdownImages(questionContent) || questionContent;
      const existing =
        (await this.questions.findByContentHash(hash)) ??
        (await this.questions.findByContentPrefix(textForMatch, { subjectId }))[0] ??
        null;
      if (!existing) {
        questionId = await this.questions.createFreeform({ subject_id: subjectId, source: 'freeform', ...row });
      } else {
        questionId = Number(existing.id);
        // 先答疑后提交：标注模型生成的答案要让位给判题结果
        if (existing.source === 'freeform') {
          await this.updateFreeform(questionId, row, existing.content_hash);
        }
      }
    }
```

在 `persist` 与 `persistMessages` 之后、`yield result` 之前加：

```ts
      void this.ingest.tagExistingQuestion(questionId, questionContent, subjectId, studentId);
```

`parse-options.util.ts` 改为：

```ts
export function parseOptions(raw: string | null): unknown[] | null {
  if (raw == null || raw === '') return null;
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return null;
    // 做题题历史 options 可能带 isCorrect；解禁后这些题会下发给学生，读取时兜底剥离
    return v.map((o) => {
      if (o && typeof o === 'object' && 'isCorrect' in o) {
        const { isCorrect: _ignored, ...rest } = o as Record<string, unknown>;
        return rest;
      }
      return o;
    });
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 跑测试**

Run: `cd apps/server && npx vitest run src/modules/freeform/freeform-judge.service.test.ts src/common/utils/parse-options.util.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/freeform/freeform-judge.service.ts \
        apps/server/src/modules/freeform/freeform-judge.service.test.ts \
        apps/server/src/common/utils/parse-options.util.ts \
        apps/server/src/common/utils/parse-options.util.test.ts
git commit -m "fix(freeform): 判题覆盖标注答案、剥选项答案、补知识点"
```

---

### Task 7: 错题列表 answerable + 前端可勾选

**Files:**
- Modify: `apps/server/src/database/repositories/main-error-books.repo.ts:283-304`
- Modify: `apps/server/src/modules/training/training.service.ts:160-196`（DTO 映射）
- Modify: `apps/web/src/services/api.ts:1150-1167`
- Modify: `apps/web/src/pages/student/training/ErrorPracticePage.tsx:77-79, 195-235, 340-395, 415-490`
- Test: `apps/server/src/database/repositories/main-error-books.repo.test.ts`
- Test: `apps/server/src/modules/training/training.service.test.ts:130-150`
- Test: `apps/web/src/pages/student/training/ErrorPracticePage.test.tsx:90-165`
- Test: `apps/web/src/pages/student/training/TrainingHomePage.test.tsx`（fixture 补 `answerable`）
- Test: `apps/web/src/pages/student/training/ErrorPracticeRunPage.test.tsx`（fixture 补 `answerable`）

**Interfaces:**
- Produces: `GET /api/training/error-book` 每条新增 `answerable: boolean`

- [ ] **Step 1: 写服务端测试（先红）**

`main-error-books.repo.test.ts` 追加：

```ts
  it('findErrorBookEntries 返回 answerable（空答案/孤儿题 false）', async () => {
    const pool = mockPool([
      { id: 1, question_id: 10, questionText: '题', type: 'choice', full_score: 10, level: 1, created_at: new Date(), kp_id: null, options: null, source: 'freeform', answerable: 1 },
    ]);
    const repo = new MainErrorBooksRepository(pool as any);
    const rows = await repo.findErrorBookEntries(1, 1, {});
    expect(rows[0].answerable).toBe(1);
    const [sql] = pool.execute.mock.calls[0];
    expect(sql).toContain("q.answer <> ''");
  });
```

`training.service.test.ts` 追加：

```ts
  it('answerable 映射为 boolean', async () => {
    const svc = mkSvc({
      mainErrorRepo: {
        findErrorBookEntries: vi.fn().mockResolvedValue([
          { id: 1, question_id: 2, questionText: '题', type: 'choice', full_score: 10, level: 1, created_at: new Date(), kp_id: null, options: null, source: 'freeform', answerable: 1 },
          { id: 2, question_id: 3, questionText: '空答案', type: 'choice', full_score: 10, level: 1, created_at: new Date(), kp_id: null, options: null, source: 'freeform', answerable: 0 },
        ]),
      },
    });
    const rows = await svc.getErrorBookEntries(1, 1, {} as any);
    expect(rows.map((r) => r.answerable)).toEqual([true, false]);
  });
```

> `mkSvc` 的构造写法以该测试文件现有 helper 为准。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/database/repositories/main-error-books.repo.test.ts src/modules/training/training.service.test.ts`
Expected: FAIL

- [ ] **Step 3: 改仓库/服务**

`main-error-books.repo.ts` 的 SELECT 加：

```sql
              (q.id IS NOT NULL AND q.answer IS NOT NULL AND q.answer <> '') AS answerable,
```

返回类型加 `answerable: number`。

`training.service.ts` 的 `getErrorBookEntries` 映射加：

```ts
        answerable: Number(row.answerable) === 1,
```

DTO 类型加 `answerable: boolean`。

- [ ] **Step 4: 跑服务端测试确认通过**

Run: `cd apps/server && npx vitest run src/database/repositories/main-error-books.repo.test.ts src/modules/training/training.service.test.ts`
Expected: PASS

- [ ] **Step 5: 改前端类型与可选逻辑（先改测试）**

`api.ts` 的 `TrainingErrorBookEntry` 加：

```ts
  /** 是否有标准答案（false = 图片题/结构化失败，不可进错题练习）。2026-11-14 */
  answerable: boolean;
```

`ErrorPracticePage.test.tsx`：
- 所有 fixture 补 `answerable: true`（做题条目按需设 false）。
- 原「freeform 显示但不可勾选」用例改为两条：
  1. `answerable: true` 的 freeform：复选框可用、计入分母；点它可勾选。
  2. `answerable: false` 的 freeform：复选框禁用，显示「该题暂无标准答案，暂不支持练习」。

`TrainingHomePage.test.tsx` / `ErrorPracticeRunPage.test.tsx` 里所有 `getTrainingErrorBook` 的 fixture 补 `answerable: true`（类型新增必填字段，漏了 `tsc` 会红）。

- [ ] **Step 6: 改页面逻辑**

`ErrorPracticePage.tsx`：

```ts
/** 有标准答案才能进错题练习（2026-11-14：freeform 解禁，改为按答案可用性判断）。 */
function isSelectable(entry: TrainingErrorBookEntry): boolean {
  return entry.answerable;
}
```

渲染循环里：

```tsx
const isFreeform = entry.source === 'freeform';
const notSelectable = !isSelectable(entry);
const isOrphan = entry.questionId == null;
```

卡片 class / onClick / checkbox disabled 全部把 `isFreeform` 换成 `notSelectable`；aria-label：

```tsx
isOrphan
  ? '该题未入库，不可选择'
  : notSelectable
    ? '该题暂无标准答案，暂不支持练习'
    : `选择错题 ${entry.errorBookId}`
```

行内提示：

```tsx
{notSelectable && !isOrphan && (
  <p className="text-xs text-[var(--learn-text-tertiary)]">
    该题暂无标准答案，暂不支持练习
  </p>
)}
```

`isFreeform` 只保留用于：`做题` 标签、`重练` 按钮。

底部栏 `allFreeform` 改为（只在「全是做题错题且都不能练」时替换计数句，孤儿题维持原样）：

```ts
  const allFreeformNotSelectable =
    entries.length > 0 && freeformCount === entries.length && selectableCount === 0;
```

```tsx
{allFreeformNotSelectable ? '当前筛选下没有可练习的错题' : `已选 ${selectedCount} / ${selectableCount} 题`}
```

- [ ] **Step 7: 跑前端测试**

Run: `cd apps/web && npx vitest run src/pages/student/training/ErrorPracticePage.test.tsx`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/database/repositories/main-error-books.repo.ts \
        apps/server/src/database/repositories/main-error-books.repo.test.ts \
        apps/server/src/modules/training/training.service.ts \
        apps/server/src/modules/training/training.service.test.ts \
        apps/web/src/services/api.ts \
        apps/web/src/pages/student/training/ErrorPracticePage.tsx \
        apps/web/src/pages/student/training/ErrorPracticePage.test.tsx \
        apps/web/src/pages/student/training/TrainingHomePage.test.tsx \
        apps/web/src/pages/student/training/ErrorPracticeRunPage.test.tsx
git commit -m "feat(training): 错题条目暴露 answerable，做题错题可进错题练习"
```

---

### Task 8: 解除训练判题的 freeform 隔离

**Files:**
- Modify: `apps/server/src/modules/practice/judge-core.service.ts:274-279`
- Test: `apps/server/src/modules/practice/judge-core.service.test.ts:86-105`

- [ ] **Step 1: 改测试（先红）**

把「freeform 题 -> 400/1001」用例替换为：

```ts
  it('freeform 题照常判题（2026-11-14 隔离解除）', async () => {
    const deps = mk({
      questionsRepo: {
        findById: vi.fn().mockResolvedValue({ id: 30, source: 'freeform', type: 'choice', answer: 'A', options: null }),
        findByContentHash: vi.fn(),
        findOrCreate: vi.fn(),
        deleteById: vi.fn(),
      },
    });
    const r = await mkSvc(deps).judgeQuestion({
      studentId: 1, subjectId: 1, questionId: 30, studentAnswer: 'A', source: 'error_practice',
    });
    expect(r.isCorrect).toBe(true);
  });

  it('freeform 空答案题仍走 unanswered 守卫（不判错、不发分）', async () => {
    const deps = mk({
      questionsRepo: {
        findById: vi.fn().mockResolvedValue({ id: 32, source: 'freeform', type: 'short_answer', answer: '', options: null }),
        findByContentHash: vi.fn(),
        findOrCreate: vi.fn(),
        deleteById: vi.fn(),
      },
    });
    const r = await mkSvc(deps).judgeQuestion({
      studentId: 1, subjectId: 1, questionId: 32, studentAnswer: 'x', source: 'error_practice',
    });
    expect(r.isCorrect).toBeNull();
    expect(r.method).toBe('unanswered');
    expect(r.pointsAwarded).toBe(0);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/practice/judge-core.service.test.ts`
Expected: FAIL（仍 400）

- [ ] **Step 3: 删除拦截**

`judge-core.service.ts:274-279` 删除：

```ts
    if (q.source === 'freeform') {
      throw new HttpException({ code: 1001, message: '做题记录的题目暂不支持错题练习' }, 400);
    }
```

保留上面的空答案守卫。

**3b. 变式生成加学科守卫**（变式写库写死数学；不解禁前物理题进不来，解禁后必须先挡）。

`variation-generator.service.ts` 在加载原题 `q` 之后、查 primary KP 之前加：

```ts
    // 变式生成目前只支持数学（写库 subject_id 固定 MATH_SUBJECT_ID）；
    // 物理/化学做题错题不能被生成成数学题。
    if (q.subject_id !== MATH_SUBJECT_ID) {
      this.logger.warn(`variation generate skipped (errorItem=${errorItemId}): 暂只支持数学`);
      return;
    }
```

在 `variation-generator.service.test.ts` 加一条：物理题（subject_id=4）→ 不调用 variation capability、不写题库。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/practice/judge-core.service.test.ts src/modules/training/variation-generator.service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/practice/judge-core.service.ts \
        apps/server/src/modules/practice/judge-core.service.test.ts \
        apps/server/src/modules/training/variation-generator.service.ts \
        apps/server/src/modules/training/variation-generator.service.test.ts
git commit -m "feat(training): 做题错题解禁进入错题练习与专项"
```

---

### Task 9: 存量做题题补知识点脚本

**Files:**
- Create: `apps/server/scripts/backfill-freeform-kp.ts`

**Interfaces:**
- Consumes: `FreeformTagCapability`（Task 4）
- 一条命令执行：`cd apps/server && npx tsx scripts/backfill-freeform-kp.ts`

- [ ] **Step 1: 写脚本**

```ts
/**
 * 一次性补标：给已入库但没有知识点的 freeform 题补 KP。
 *
 * 运行：cd apps/server && npx tsx scripts/backfill-freeform-kp.ts
 * 约束：一条命令跑完（无 dry-run 前置）；已挂 KP 的题跳过；单题失败只记日志。
 */
import * as dotenv from 'dotenv';
import { createPool } from 'mysql2/promise';
import { FreeformTagCapability } from '../src/ai-core/capabilities/freeform-tag.capability.js';

dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

const pool = createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  connectionLimit: 2,
});

const tagger = new FreeformTagCapability();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [rows] = await pool.query<any[]>(
    `SELECT q.id, q.subject_id, q.content, s.name AS subject_name
       FROM questions q
       JOIN subjects s ON s.id = q.subject_id
      WHERE q.source = 'freeform' AND q.is_active = 1 AND q.answer <> ''
        AND NOT EXISTS (SELECT 1 FROM question_knowledge_points qkp WHERE qkp.question_id = q.id)
      ORDER BY q.id`,
  );
  const [kps] = await pool.query<any[]>('SELECT id, subject_id, name FROM knowledge_points');
  const kpBySubject = new Map<number, Array<{ id: number; name: string }>>();
  for (const k of kps) {
    const list = kpBySubject.get(Number(k.subject_id)) ?? [];
    list.push({ id: Number(k.id), name: k.name });
    kpBySubject.set(Number(k.subject_id), list);
  }

  let tagged = 0;
  let failed = 0;
  for (const q of rows) {
    const subjectId = Number(q.subject_id);
    const options = kpBySubject.get(subjectId) ?? [];
    if (options.length === 0) continue;

    const run = async () => tagger.tag({
      question: q.content,
      subjectId,
      subjectName: q.subject_name ?? '数学',
      gradeBand: 'junior',
      knowledgePointOptions: options,
    });
    let result = await run().catch(() => null);
    if (!result) result = await run().catch(() => null); // 重试 1 次
    if (!result || result.knowledgePointIds.length === 0) {
      failed += 1;
      console.warn(`[backfill] question=${q.id} 未标注出知识点`);
      continue;
    }
    for (const [i, kpId] of result.knowledgePointIds.entries()) {
      await pool.execute(
        `INSERT IGNORE INTO question_knowledge_points (question_id, knowledge_point_id, role) VALUES (?, ?, ?)`,
        [q.id, kpId, i === 0 ? 'primary' : 'secondary'],
      );
    }
    tagged += 1;
    await sleep(300);
  }

  console.log(`[backfill] scanned=${rows.length} tagged=${tagged} failed=${failed}`);
  await pool.end();
}

main().catch((err) => {
  console.error('[backfill] failed:', err);
  process.exitCode = 1;
  pool.end().catch(() => {});
});
```

- [ ] **Step 2: 执行回填（直接写库，一条命令）**

Run: `cd apps/server && npx tsx scripts/backfill-freeform-kp.ts`
Expected: 打印 `scanned/tagged/failed`；有 freeform 题时 tagged > 0；重复执行时 `tagged` 应变 0（已挂 KP 的题被 `NOT EXISTS` 排除）

- [ ] **Step 3: 抽查**

```sql
SELECT COUNT(*) FROM questions q
WHERE q.source='freeform' AND q.is_active=1 AND q.answer <> ''
  AND NOT EXISTS (SELECT 1 FROM question_knowledge_points qkp WHERE qkp.question_id=q.id);
```

期望：数量下降（纯图片/标注失败的题可能仍为 0 KP）。

- [ ] **Step 4: Commit**

```bash
git add apps/server/scripts/backfill-freeform-kp.ts
git commit -m "chore(freeform): 存量做题题补知识点脚本"
```

---

### Task 10: 文档同步 + 全量回归

**Files:**
- Modify: `docs/API接口与数据流设计文档.md`（§4.30 / §5.33 相关行：331、341、370-372、786-892、1617）
- Modify: `docs/api/openapi.yaml`（`/conversations` query、`/training/error-book` 响应）
- Modify: `docs/K12智学系统-产品需求文档.md:456-467`（§7.15 口径）
- Modify: `docs/constraints/做题入口.md`
- Modify: `docs/ai-core-changelog.md`（顶部加 2026-11-14 条目）

- [ ] **Step 1: 改 API 文档**

把以下旧表述逐条改掉：
- 「`aux_freeform` 不出现在答疑历史列表」→ 改为「只显示有聊天消息的 `aux_freeform`；`hasChat=1` 过滤，纯判题会话不显示」。
- 「freeform 题不进任何自动池 / 页面不可勾选 / 训练判题拒绝」→ 改为「2026-11-14 解禁；`answerable=false` 的题仍不可练」。
- 「不写知识点关联」→ 改为「判题后异步补知识点；只答疑的题由标注能力生成答案与知识点」。
- 补 `GET /api/conversations` 的 `scene` 多值 + `hasChat` 参数说明。
- 补 `GET /api/training/error-book` 的 `answerable` 字段。
- 判题落库段落补：命中已有 freeform 题时用判题结果覆盖；`options` 剥 `isCorrect`；
  只答疑题由标注能力生成答案与知识点；前缀去重带学科。

- [ ] **Step 2: 改 openapi.yaml**

- `/api/conversations` GET 的 `scene` 描述改为「逗号分隔多值」；新增 `hasChat`（enum ['0','1']）。
- `/api/training/error-book` 的 item schema 加 `answerable: { type: boolean }`，并加进 required。
- 不新增路径。

- [ ] **Step 3: 改 PRD 与约束文档**

PRD §7.15：
- 判题题库段落：补「判题后异步补知识点」。
- 错题本口径：补「只答疑未提交也进错题本；满分后答疑不进」。
- 隔离段落：整段改写为解禁口径 + `answerable` 限制。
- 答疑会话段落：改写为「有聊天消息才出现在答疑历史，可续聊」。

`docs/constraints/做题入口.md`：在「隔离」相关段落加 2026-11-14 新口径，并保留旧事故背景（不要只加顶部注记）。

- [ ] **Step 4: 写 changelog**

在 `docs/ai-core-changelog.md` 顶部加：

```markdown
## 2026-11-14 做题答疑进历史 + 做题题进错题/专项

**用户反馈**：做题页答疑后刷新就找不到聊天记录；做题错题被隔离在所有练习池外，
而只答疑没提交的题完全不落库。

**改动**：
- `GET /api/conversations` 支持多 `scene` + `hasChat`；答疑列表只收有聊天消息的 `aux_freeform`。
- 回放把 `freeform_submit` 按 Markdown 渲染并去掉题干信封。
- 新增 `FreeformChatIngestService`：答疑结束异步补题 + 标注知识点 + 进错题本；
  判题落库后异步补知识点。满分后答疑不重建错题。
- 命中已有 freeform 题时用判题结果覆盖标注答案；options 写库/读取都剥 `isCorrect`；
  前缀去重带学科，避免跨学科误合并。
- 解除 `source='freeform'` 的错题练习/演练隔离；`answerable=false` 仍不可练；
  变式生成加学科守卫（目前只支持数学）。
- 新增 `FreeformTagCapability`（`freeform/tag.md`）+ 存量补标脚本。

**验证**：（执行后补实测数字）
```

- [ ] **Step 5: 全量测试 + 构建**

```bash
cd apps/server && npm test
cd ../web && npx vitest run && npm run build
cd ../server && npm run build
```

Expected：全绿。`npm run build` 后确认 `apps/server/dist/ai-core/prompts/freeform/tag.md` 存在。

- [ ] **Step 6: 冒烟（无 VPN/代理干扰）**

1. 做题页只提交 → 刷新后【辅助答疑】无新会话；
2. 做题页答疑两句 → 列表出现；回放公式正常、无重复题干；继续追问成功；
3. 只答疑不提交 → 错题本出现；错题练习可勾选、可判分；
4. 未满分做题错题 → 错题练习可勾选；数学答错后变式可生成；
5. 数学/物理题在专项可抽到；化学预期不可（0 知识点）；
6. 纯图片题进错题本但置灰；
7. 家长端对话回放仍看不到做题会话；
8. 先答疑后提交：判题答案覆盖标注答案，`full_score` 变学生选的满分；
9. 选择题接口返回的 options 不含 `isCorrect`。

- [ ] **Step 7: Commit**

```bash
git add docs/API接口与数据流设计文档.md docs/api/openapi.yaml \
        docs/K12智学系统-产品需求文档.md docs/constraints/做题入口.md \
        docs/ai-core-changelog.md
git commit -m "docs: 同步做题答疑历史与练习池解禁口径"
```

---

## 执行顺序与依赖

- Task 1 → Task 2 → Task 3（列表与回放可独立交付）
- Task 4 → Task 5 / Task 6（标注能力是入库前置）
- Task 7 → Task 8（先有 `answerable`，再解禁判题，避免空答案题被误判）
- Task 9 依赖 Task 4；Task 10 最后做。

## 风险提示（执行时注意）

- `FreeformChatIngestService` 的构造参数必须是**具体类**；接口类型会触发 Nest DI 的 `Object` token 坑。
- `FreeformTagCapability` **不要**加 `@Injectable()`（零参实例化），在 module providers 里直接列类。
- `ai.module.ts` 引入 `FreeformModule` 后跑 `npm run build` 并实际 `node dist/main.js` 起一次，确认无循环依赖 / 启动失败。
- 任何新查询带 `LIMIT ?` 时必须 `pool.query`。
- **选项泄题是红线**：写库剥 `isCorrect` + `parseOptions` 读取兜底，两层都要做；不要只改一边。
- 前缀去重必须带 `subjectId`；不传的旧调用保持原行为，新调用（做题入库/判题）必须传。
- 先答疑后提交的场景必须用判题结果覆盖已有 freeform 题，不能只复用；否则练习判分会用标注模型的答案。
- 会话没有 `subject_id` 时宁可跳过入库，也不要默认数学。
