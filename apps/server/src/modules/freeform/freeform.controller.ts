import {
  BadRequestException,
  Body,
  Controller,
  HttpException,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import { FreeformRecognizeService } from './freeform-recognize.service.js';
import { FreeformJudgeService } from './freeform-judge.service.js';
import type { FreeformJudgeDto, FreeformRecognizeDto } from './dto/freeform.dto.js';

/**
 * 自由输入做题。
 *
 * 两步：题图/文字 → 候选题（`recognize`）→ 判题（`judge/stream`，SSE）。
 * 归属一律取 JWT 的 `sub`，不接受 body 里的 studentId。
 */
@Controller('api/freeform')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class FreeformController {
  constructor(
    private readonly recognizeService: FreeformRecognizeService,
    private readonly judgeService: FreeformJudgeService,
  ) {}

  /** 题图/文字 → 候选题。参数形状与张数在此拦，图片归属/格式/大小与文字长度由 service 校验。 */
  @Post('recognize')
  async recognize(@Body() dto: FreeformRecognizeDto, @CurrentUser() user: JwtUser) {
    // `text` 非字符串必须在这里拦：service 会直接 `.trim()`，放过去就是 500 而不是 400。
    if (dto?.text !== undefined && typeof dto.text !== 'string') {
      throw new BadRequestException({ code: 1001, message: 'text 必须是字符串' });
    }
    const fileIds = dto?.fileIds ?? [];
    if (!Array.isArray(fileIds)) {
      throw new BadRequestException({ code: 1001, message: 'fileIds 必须是数组' });
    }
    if (fileIds.length > 6) {
      throw new BadRequestException({ code: 1001, message: '最多 6 张题图' });
    }
    if (!fileIds.every((x) => typeof x === 'string' && /^\d+$/.test(x) && Number(x) > 0)) {
      throw new BadRequestException({ code: 1001, message: 'fileIds 必须是正整数数组' });
    }
    return this.recognizeService.recognize({ text: dto?.text, fileIds }, user.sub);
  }

  /**
   * 判题（SSE）。手写响应绕开全局响应包装：错误也以 `{type:'error'}` 事件 + HTTP 200 发出，
   * 前端只在流内区分成功/失败；`res.close`（客户端断开）时 abort，上游模型调用随之停止。
   */
  @Post('judge/stream')
  async judgeStream(@Body() dto: FreeformJudgeDto, @CurrentUser() user: JwtUser, @Res() res: Response) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const abort = new AbortController();
    let finished = false;
    res.on('close', () => {
      if (!finished) abort.abort();
    });
    try {
      for await (const event of this.judgeService.judgeStream(dto, user.sub, abort.signal)) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (err) {
      const payload = err instanceof HttpException ? (err.getResponse() as any) : { code: 5000, message: 'AI 服务异常', retryable: true };
      res.write(
        `data: ${JSON.stringify({
          type: 'error',
          code: payload?.code ?? 5000,
          message: payload?.message ?? 'AI 服务异常',
          retryable: payload?.retryable === true,
        })}\n\n`,
      );
    } finally {
      finished = true;
      res.end();
    }
  }
}
