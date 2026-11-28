import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { FeaturedRecommendationService } from './featured-recommendation.service.js';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';

/** 学生精选推荐：studentId 只取 JWT sub，不接收 body 传入的身份字段。 */
@Controller('api/student/featured-sets')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class StudentFeaturedSetsController {
  constructor(private readonly recommendation: FeaturedRecommendationService) {}

  // 成功 201（Nest 默认），幂等重复推荐返回 alreadyRecommended=true。
  @Post('recommend')
  recommend(@Body() body: { questionIds: number[] }, @CurrentUser() user: JwtUser) {
    return this.recommendation.recommend(user.sub, body.questionIds);
  }
}
