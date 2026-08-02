import { Body, Controller, Get, Param, Post, Query, UseGuards, ParseIntPipe } from '@nestjs/common';
import { ConversationsService } from './conversations.service.js';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import type { CreateConversationDto } from './dto/create-conversation.dto.js';
import type { AppendMessageDto } from './dto/append-message.dto.js';

@Controller('api/conversations')
@UseGuards(JwtAuthGuard)
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Post()
  async create(@Body() dto: CreateConversationDto, @CurrentUser() user: JwtUser) {
    return this.conversationsService.create(user.sub, dto);
  }

  @Get()
  async list(
    @Query('track') track: 'mainline' | 'auxiliary',
    @Query('cursor') cursor: string,
    @CurrentUser() user: JwtUser,
  ) {
    return this.conversationsService.list(user.sub, track, cursor ? Number(cursor) : undefined);
  }

  @Get(':dialogueId')
  async get(@Param('dialogueId', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.conversationsService.get(id, user.sub);
  }

  @Get(':dialogueId/messages')
  async messages(
    @Param('dialogueId', ParseIntPipe) id: number,
    @Query('lastMessageId') last: string,
    @CurrentUser() user: JwtUser,
  ) {
    return this.conversationsService.getMessages(id, user.sub, last ? Number(last) : undefined);
  }

  @Post(':dialogueId/messages')
  async append(@Param('dialogueId', ParseIntPipe) id: number, @Body() dto: AppendMessageDto, @CurrentUser() user: JwtUser) {
    await this.conversationsService.appendMessage(id, user.sub, dto.content);
  }
}
