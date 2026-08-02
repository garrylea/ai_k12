import { Body, Controller, Get, Param, Post, Query, UseGuards, ParseIntPipe, ForbiddenException, BadRequestException } from '@nestjs/common';
import { ErrorBookService } from './error-book.service.js';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import type { CreateAuxErrorDto } from './dto/create-aux-error.dto.js';

@Controller('api/error-book')
@UseGuards(JwtAuthGuard)
export class ErrorBookController {
  constructor(private readonly errorBookService: ErrorBookService) {}

  @Get('students/:studentId/aux')
  async listAux(
    @Param('studentId', ParseIntPipe) studentId: number,
    @Query('subject') subject: string,
    @Query('includeCleared') includeCleared: string,
    @CurrentUser() user: JwtUser,
  ) {
    // MVP: student can only query own aux errors. Parent access is a future concern.
    if (user.sub !== studentId) {
      throw new ForbiddenException({ code: 1003, message: '无权访问他人数据' });
    }
    let subjectId: number | undefined;
    if (subject) {
      subjectId = Number(subject);
      if (!Number.isFinite(subjectId)) {
        throw new BadRequestException({ code: 1001, message: 'subject 必须为数字' });
      }
    }
    return this.errorBookService.listAux(studentId, subjectId, includeCleared === 'true');
  }

  @Post('aux')
  async createAux(@Body() dto: CreateAuxErrorDto, @CurrentUser() user: JwtUser) {
    return this.errorBookService.createAux(user.sub, dto);
  }

  @Post('items/:errorItemId/redo')
  async redo(
    @Param('errorItemId', ParseIntPipe) id: number,
    @Body() body: { answerText: string },
    @CurrentUser() user: JwtUser,
  ) {
    return this.errorBookService.redo(id, user.sub, body.answerText);
  }

  @Post('items/:errorItemId/clear')
  async clear(@Param('errorItemId', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    await this.errorBookService.clear(id, user.sub);
  }
}
