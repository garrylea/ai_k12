import { Module } from '@nestjs/common';
import { FeaturedQuestionSetsRepository, QuestionsRepository } from '../../database/repositories/index.js';
import { StudentsRepository } from '../../database/repositories/students.repo.js';
import { FeaturedRecommendationService } from './featured-recommendation.service.js';
import { FeaturedReviewService } from './featured-review.service.js';
import { StudentFeaturedSetsController } from './student-featured-sets.controller.js';
import { ResearchFeaturedSetsController } from './research-featured-sets.controller.js';

@Module({
  controllers: [StudentFeaturedSetsController, ResearchFeaturedSetsController],
  providers: [
    FeaturedRecommendationService,
    FeaturedReviewService,
    FeaturedQuestionSetsRepository,
    QuestionsRepository,
    StudentsRepository,
  ],
})
export class FeaturedSetsModule {}
