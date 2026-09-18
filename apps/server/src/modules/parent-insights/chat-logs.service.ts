import { Injectable, NotFoundException } from '@nestjs/common';
import { ParentInsightsRepository } from '../../database/repositories/parent-insights.repo.js';
import type { ParentChatLogFilters } from '../../database/repositories/parent-insights.repo.js';
import { AiDialoguesRepository } from '../../database/repositories/ai-dialogues.repo.js';
import { AiMessagesRepository } from '../../database/repositories/ai-messages.repo.js';
import type {
  ParentChatLogDetail,
  ParentChatLogPage,
} from './dto/parent-insights.dto.js';

/** 服务端固定页大小：前端不传 `pageSize`。 */
export const PAGE_SIZE = 20;

export interface ChatLogsQuery {
  track?: 'mainline' | 'auxiliary';
  scene?: string;
  from?: string;
  to?: string;
  q?: string;
  page: number;
}

/**
 * 家长端 AI 对话回放（spec §4.2 ④⑤）：**只读**。
 *
 * 筛选只有「轨道 + 场景 + 时间 + 标题关键词」，**没有学科**——实测 76% 的
 * `ai_dialogues.subject_id` 是 NULL（写入侧硬编码），按学科筛会大面积漏（spec §2.3）。
 *
 * 消息读取**直接复用** `AiMessagesRepository.findByDialogue`（不另写 SQL），但归属校验必须
 * 自己做：底层 `findById` 不带归属，不校验就是 IDOR。
 */
@Injectable()
export class ChatLogsService {
  constructor(
    private readonly repo: ParentInsightsRepository,
    private readonly dialoguesRepo: AiDialoguesRepository,
    private readonly messagesRepo: AiMessagesRepository,
  ) {}

  async listChatLogs(studentId: number, query: ChatLogsQuery): Promise<ParentChatLogPage> {
    const filters: ParentChatLogFilters = {};
    if (query.track) filters.track = query.track;
    if (query.scene) filters.scene = query.scene;
    if (query.from) filters.from = query.from;
    if (query.to) filters.to = query.to;
    if (query.q) filters.q = query.q;

    const offset = (query.page - 1) * PAGE_SIZE;
    const { items, total } = await this.repo.listParentChatLogs(
      studentId,
      filters,
      PAGE_SIZE,
      offset,
    );

    return { items, page: query.page, pageSize: PAGE_SIZE, total };
  }

  async getChatLog(studentId: number, dialogueId: number): Promise<ParentChatLogDetail> {
    const dialogue = await this.dialoguesRepo.findById(dialogueId);
    // 存在性与归属失败都用 1002：与 `ParentService.requireOwnedStudent` 同一套语义，
    // 不泄漏「这个 id 是否存在」。
    if (!dialogue || dialogue.student_id !== studentId) {
      throw new NotFoundException({ code: 1002, message: '对话不存在' });
    }

    const messages = await this.messagesRepo.findByDialogue(dialogueId);
    // 与列表同口径：`updatedAt` 是「最后一条消息时间」，不是 `dialogue.updated_at`
    // （后者实质冻结在创建时刻——追加消息只 INSERT 消息表）。`findByDialogue` 按 id 升序返回
    // 且已过滤软删，故最后一条即最新一条。
    const lastMessageAt = messages.length > 0
      ? messages[messages.length - 1].created_at
      : dialogue.created_at;
    const listItem = {
      id: dialogue.id,
      track: dialogue.track,
      scene: dialogue.scene,
      title: dialogue.title,
      subjectId: dialogue.subject_id,
      createdAt: dialogue.created_at,
      updatedAt: lastMessageAt,
      messageCount: messages.length,
      blockCount: messages.filter((m) => m.safety_flag === 1).length,
    };

    return {
      ...listItem,
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        reasoning: m.reasoning,
        type: m.type,
        model: m.model,
        safetyFlag: m.safety_flag,
        createdAt: m.created_at,
      })),
    };
  }
}
