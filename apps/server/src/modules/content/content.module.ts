import { Module } from '@nestjs/common';
import { ContentController } from './content.controller.js';
import { ContentService } from './content.service.js';
import { SubjectsRepository } from '../../database/repositories/subjects.repo.js';
import { TextbookVersionsRepository } from '../../database/repositories/textbook-versions.repo.js';
import { SemestersRepository } from '../../database/repositories/semesters.repo.js';
import { UnitsRepository } from '../../database/repositories/units.repo.js';
import { LessonsRepository } from '../../database/repositories/lessons.repo.js';
import { CardsRepository } from '../../database/repositories/cards.repo.js';

@Module({
  controllers: [ContentController],
  providers: [
    ContentService,
    SubjectsRepository,
    TextbookVersionsRepository,
    SemestersRepository,
    UnitsRepository,
    LessonsRepository,
    CardsRepository,
  ],
  exports: [ContentService],
})
export class ContentModule {}
