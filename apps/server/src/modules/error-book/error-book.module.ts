import { Module } from '@nestjs/common';
import { ErrorBookController } from './error-book.controller.js';
import { ErrorBookService } from './error-book.service.js';
import { AuxErrorBooksRepository, QuestionsRepository, ExtractTasksRepository } from '../../database/repositories/index.js';
import { QuestionStructuringCapability } from '../../ai-core/capabilities/question-structuring.capability.js';

@Module({
  controllers: [ErrorBookController],
  providers: [ErrorBookService, AuxErrorBooksRepository, QuestionsRepository, ExtractTasksRepository, QuestionStructuringCapability],
  exports: [ErrorBookService],
})
export class ErrorBookModule {}
