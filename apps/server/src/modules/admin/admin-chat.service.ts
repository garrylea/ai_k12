import { Injectable, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AdminChatRepository } from '../../database/repositories/admin-chat.repo.js';
import { LlmModelsRepository } from '../../database/repositories/llm-models.repo.js';
import type { LlmModel } from '../../database/repositories/llm-models.repo.js';
import { ModelClient } from '../../ai-core/infra/model-client/index.js';
import type { ModelConfig, Provider, ChatMessage } from '../../ai-core/types.js';

@Injectable()
export class AdminChatService {
  constructor(
    private chatRepo: AdminChatRepository,
    private modelsRepo: LlmModelsRepository,
    private modelClient: ModelClient,
  ) {}

  async createDialogue(adminId: number, modelKey: string) {
    await this.requireEnabledModel(modelKey);
    return { id: await this.chatRepo.createDialogue(adminId, modelKey) };
  }

  async listDialogues(adminId: number) { return this.chatRepo.listDialogues(adminId); }

  async deleteDialogue(adminId: number, id: number) {
    const dlg = await this.chatRepo.findDialogue(id);
    if (!dlg) throw new NotFoundException({ code: 1002, message: '会话不存在' });
    if (dlg.adminId !== adminId) throw new ForbiddenException({ code: 1005, message: '无权访问该会话' });
    await this.chatRepo.deleteDialogue(id);
  }

  async listMessages(adminId: number, dialogueId: number) {
    const dlg = await this.chatRepo.findDialogue(dialogueId);
    if (!dlg) throw new NotFoundException({ code: 1002, message: '会话不存在' });
    if (dlg.adminId !== adminId) throw new ForbiddenException({ code: 1005, message: '无权访问该会话' });
    return this.chatRepo.listMessages(dialogueId);
  }

  async *chatStream(dto: { dialogueId: number; message: string }, adminId: number) {
    const dlg = await this.chatRepo.findDialogue(dto.dialogueId);
    if (!dlg) throw new NotFoundException({ code: 1002, message: '会话不存在' });
    if (dlg.adminId !== adminId) throw new ForbiddenException({ code: 1005, message: '无权访问该会话' });

    const model = await this.requireEnabledModel(dlg.modelKey);
    const modelConfig = this.toModelConfig(model);
    const history = await this.chatRepo.listMessages(dto.dialogueId);
    await this.chatRepo.addMessage(dto.dialogueId, 'user', dto.message);

    const messages: ChatMessage[] = [
      { role: 'system', content: '你是管理员的工作助手，回答专业、简洁、直接，不限主题。' },
      ...history.slice(-20).map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: dto.message },
    ];

    let full = '';
    let reasoning: string | undefined;
    try {
      for await (const chunk of this.modelClient.streamChat({ model: modelConfig, messages })) {
        const delta = chunk.content;
        const rdelta = chunk.reasoningContent;
        if (delta) { full += delta; yield { type: 'message', delta }; }
        if (rdelta) { reasoning = (reasoning ?? '') + rdelta; }
      }
      await this.chatRepo.addMessage(dto.dialogueId, 'assistant', full, reasoning);
      yield { type: 'done', dialogueId: dto.dialogueId };
    } catch (err) {
      yield { type: 'error', code: 5001, message: 'AI 服务异常', retryable: true };
    }
  }

  private async requireEnabledModel(modelKey: string): Promise<LlmModel> {
    const models = await this.modelsRepo.listEnabled();
    const m = models.find((x) => x.modelKey === modelKey);
    if (!m) throw new ConflictException({ code: 1004, message: '模型不存在或未启用' });
    return m;
  }

  /** LlmModel (DB 行) -> ai-core ModelConfig 形状（与 ModelConfigRegistry.reload 的映射一致）。 */
  private toModelConfig(m: LlmModel): ModelConfig & { apiKey?: string } {
    return {
      modelId: m.modelId,
      provider: (m.providerType === 'openai_compatible' ? 'kimi' : m.providerType) as Provider,
      baseUrl: m.baseUrl,
      contextWindow: m.contextWindow,
      maxOutputTokens: m.maxOutputTokens,
      costPer1K: { input: 0, output: 0 },
      supportsStreaming: true,
      apiKey: m.apiKey,
    };
  }
}
