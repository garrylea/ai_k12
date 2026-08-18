import { Body, Controller, Delete, Get, HttpException, Param, ParseIntPipe, Patch, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AdminModelsService } from './admin-models.service.js';
import { AdminAccountsService } from './admin-accounts.service.js';
import { AdminMessagesService } from './admin-messages.service.js';
import { AdminChatService } from './admin-chat.service.js';
import { AdminDashboardService } from './admin-dashboard.service.js';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';

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
// 更新时 apiKey 可传空串=不修改（service 层据此剔除该字段）
const ModelUpdateSchema = ModelSchema.partial().omit({ modelKey: true }).extend({ apiKey: z.string().max(400) });
const RoutesSchema = z.object({
  routes: z.array(z.object({
    scene: z.string().min(1).max(30),
    subject: z.string().min(1).max(20),
    primaryModelKey: z.string().min(1).max(50),
    fallbackModelKey: z.string().max(50).nullable(),
  })),
});

const MessageSchema = z.object({
  type: z.string().min(1).max(20),
  title: z.string().min(1).max(100),
  content: z.string().min(1).max(5000),
  parentId: z.number().int().positive().optional(),
});

@Controller('api/admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class AdminController {
  constructor(
    private modelsService: AdminModelsService,
    private accountsService: AdminAccountsService,
    private messagesService: AdminMessagesService,
    private chatService: AdminChatService,
    private dashboardService: AdminDashboardService,
  ) {}

  @Get('dashboard') dashboard() { return this.dashboardService.get(); }

  @Patch('password')
  async changePassword(@CurrentUser() user: JwtUser, @Body() b: unknown) {
    const { oldPassword, newPassword } = z.object({
      oldPassword: z.string().min(1).max(100),
      newPassword: z.string().min(6).max(32),
    }).parse(b);
    await this.dashboardService.changePassword(user.sub, oldPassword, newPassword);
    return null;
  }

  @Get('models') listModels() { return this.modelsService.list(); }

  @Post('models') async createModel(@Body() b: unknown) {
    await this.modelsService.create(ModelSchema.parse(b));
    return null;
  }

  @Patch('models/:modelKey') async updateModel(@Param('modelKey') k: string, @Body() b: unknown) {
    await this.modelsService.update(k, ModelUpdateSchema.parse(b));
    return null;
  }

  @Patch('models/:modelKey/status') async setModelStatus(@Param('modelKey') k: string, @Body() b: unknown) {
    const { isEnabled } = z.object({ isEnabled: z.boolean() }).parse(b);
    await this.modelsService.setEnabled(k, isEnabled);
    return null;
  }

  @Get('routes') listRoutes() { return this.modelsService.listRoutes(); }

  @Put('routes') async saveRoutes(@Body() b: unknown) {
    const { routes } = RoutesSchema.parse(b);
    await this.modelsService.saveRoutes(routes);
    return null;
  }

  /** 连通性测试：用该模型发"1+1=?"探活，10s 超时，不落库。 */
  @Post('routes/validate-connection')
  async validateConnection(@Body() b: unknown) {
    const { modelKey } = z.object({ modelKey: z.string().min(1) }).parse(b);
    const t0 = Date.now();
    try {
      const { ModelClient } = await import('../../ai-core/infra/model-client/index.js');
      const { getModelConfigRegistry } = await import('../../ai-core/infra/model-config-registry.js');
      const model = getModelConfigRegistry()?.getSnapshot().models[modelKey];
      if (!model) throw new HttpException({ code: 1002, message: '模型不存在或未启用' }, 404);
      const client = new ModelClient();
      const res = await Promise.race([
        client.chat({ model, messages: [{ role: 'user', content: '1+1=? 只回答数字' }], stream: false }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('探活超时')), 10_000)),
      ]) as { content: string };
      return { ok: true, latencyMs: Date.now() - t0, sample: res.content?.slice(0, 50) ?? '' };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      throw new HttpException({ code: 1009, message: `连通失败: ${err instanceof Error ? err.message : String(err)}` }, 502);
    }
  }

  @Get('parents') async parents(@Query('search') search?: string) {
    return this.accountsService.searchParents((search ?? '').trim().slice(0, 50));
  }

  @Patch('parents/:id/status') async parentStatus(@Param('id', ParseIntPipe) id: number, @Body() b: unknown) {
    const { isActive } = z.object({ isActive: z.boolean() }).parse(b);
    await this.accountsService.setParentStatus(id, isActive);
    return null;
  }

  @Get('students') async students(@Query('search') search?: string) {
    return this.accountsService.searchStudents((search ?? '').trim().slice(0, 50));
  }

  @Patch('students/:id/status') async studentStatus(@Param('id', ParseIntPipe) id: number, @Body() b: unknown) {
    const { isActive } = z.object({ isActive: z.boolean() }).parse(b);
    await this.accountsService.setStudentStatus(id, isActive);
    return null;
  }

  @Get('messages') listMessages() { return this.messagesService.listForAdmin(); }

  @Post('messages') async sendMessage(@Body() b: unknown) {
    return this.messagesService.send(MessageSchema.parse(b));
  }

  @Delete('messages/:id') async deleteMessage(@Param('id', ParseIntPipe) id: number) {
    await this.messagesService.remove(id);
    return null;
  }

  @Post('chat/dialogues') async createDialogue(@CurrentUser() user: JwtUser, @Body() b: unknown) {
    const { modelKey } = z.object({ modelKey: z.string().min(1) }).parse(b);
    return this.chatService.createDialogue(user.sub, modelKey);
  }

  @Get('chat/dialogues') listDialogues(@CurrentUser() user: JwtUser) { return this.chatService.listDialogues(user.sub); }

  @Delete('chat/dialogues/:id') async deleteDialogue(@CurrentUser() user: JwtUser, @Param('id', ParseIntPipe) id: number) {
    await this.chatService.deleteDialogue(user.sub, id);
    return null;
  }

  @Get('chat/messages') async listChatMessages(@CurrentUser() user: JwtUser, @Query('dialogueId', ParseIntPipe) dialogueId: number) {
    return this.chatService.listMessages(user.sub, dialogueId);
  }

  @Post('chat/stream')
  async chatStream(@CurrentUser() user: JwtUser, @Body() body: unknown, @Res() res: Response) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const { dialogueId, message } = z.object({ dialogueId: z.number().int(), message: z.string().min(1).max(4000) }).parse(body);
    const abort = new AbortController();
    let finished = false;
    res.on('close', () => { if (!finished) abort.abort(); });
    try {
      for await (const event of this.chatService.chatStream({ dialogueId, message }, user.sub)) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (err) {
      const payload = (err as any)?.getResponse?.() ?? { code: 5001, message: 'AI 服务异常' };
      res.write(`data: ${JSON.stringify({ type: 'error', code: payload.code ?? 5001, message: payload.message ?? 'AI 服务异常' })}\n\n`);
    } finally {
      finished = true;
      res.end();
    }
  }
}
