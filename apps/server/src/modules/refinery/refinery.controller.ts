import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
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
}
