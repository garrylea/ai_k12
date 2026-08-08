import { Body, Controller, Get, Param, Post, Res, Req, UseGuards } from '@nestjs/common';
import type { Response, Request } from 'express';
import { RefineryService } from './refinery.service.js';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.js';

class ExtractDto {
  fileId!: number;
  source: string = 'auxiliary';
}

@Controller('api/refinery')
@UseGuards(JwtAuthGuard)
export class RefineryController {
  constructor(private readonly refineryService: RefineryService) {}

  @Post('extract')
  async extract(@Body() dto: ExtractDto, @CurrentUser() user: JwtUser) {
    const taskId = await this.refineryService.createTask(dto.fileId, user.sub, dto.source);
    return { taskId };
  }

  @Get('tasks/:taskId')
  async getTask(@Param('taskId') taskId: string, @CurrentUser() user: JwtUser) {
    return this.refineryService.getTask(Number(taskId), user.sub);
  }

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
}
