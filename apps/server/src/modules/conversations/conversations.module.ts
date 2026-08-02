import { Module } from '@nestjs/common';
import { ConversationsController } from './conversations.controller.js';
import { ConversationsService } from './conversations.service.js';
import { AiDialoguesRepository, AiMessagesRepository } from '../../database/repositories/index.js';

@Module({
  controllers: [ConversationsController],
  providers: [ConversationsService, AiDialoguesRepository, AiMessagesRepository],
  exports: [ConversationsService],
})
export class ConversationsModule {}
