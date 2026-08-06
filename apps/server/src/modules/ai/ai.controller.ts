import { Body, Controller, Post, UseGuards, HttpException, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AIService } from './ai.service.js';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import type { TutorDto } from './dto/tutor.dto.js';

@Controller('api/ai')
@UseGuards(JwtAuthGuard)
export class AIController {
  constructor(private readonly aiService: AIService) {}

  @Post('tutor')
  async tutor(@Body() dto: TutorDto, @CurrentUser() user: JwtUser) {
    return this.aiService.tutor(dto, user.sub);
  }

  // Streaming tutor over SSE. Uses @Res() (manual response) so the global
  // ResponseInterceptor does not wrap the stream. POST (not EventSource/GET)
  // because the body carries message + dialogueId + attachments.
  @Post('tutor/stream')
  async tutorStream(
    @Body() dto: TutorDto,
    @CurrentUser() user: JwtUser,
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering (nginx)
    res.flushHeaders?.();

    // Abort the upstream LLM fetch when the client disconnects (stop button /
    // navigation away). The capability's catch block then best-effort persists
    // the partial user+assistant messages so the next question keeps context.
    const abort = new AbortController();
    let finished = false;
    res.on('close', () => { if (!finished) abort.abort(); });

    try {
      for await (const event of this.aiService.tutorStream(dto, user.sub, abort.signal)) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (err) {
      // Pre-stream HttpException (validation / ownership / attachment) - surface
      // as an error SSE event so the frontend can react (it has no JSON body).
      const payload = err instanceof HttpException
        ? (err.getResponse() as Record<string, unknown>)
        : { code: 5000, message: 'AI 服务异常' };
      res.write(`data: ${JSON.stringify({ type: 'error', message: (payload?.message as string) ?? 'AI 服务异常' })}\n\n`);
    } finally {
      finished = true;
      res.end();
    }
  }
}
