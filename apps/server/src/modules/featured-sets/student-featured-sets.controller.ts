import {
  Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query, UseGuards,
} from '@nestjs/common';
import { FeaturedRecommendationService } from './featured-recommendation.service.js';
import { FeaturedDeliveryService } from './featured-delivery.service.js';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';

/** 学生精选推荐：studentId 只取 JWT sub，不接收 body 传入的身份字段。 */
@Controller('api/student/featured-sets')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class StudentFeaturedSetsController {
  constructor(
    private readonly recommendation: FeaturedRecommendationService,
    private readonly delivery: FeaturedDeliveryService,
  ) {}

  @Get()
  list(@Query('page') page: string | undefined, @CurrentUser() user: JwtUser) {
    return this.delivery.list(user.sub, page);
  }

  // 必须先于 publications/:id/open 等带参路由声明，避免被当成 :id。
  @Get('unread-count')
  unreadCount(@CurrentUser() user: JwtUser) {
    return this.delivery.unreadSummary(user.sub);
  }

  // 成功 201（Nest 默认），幂等重复推荐返回 alreadyRecommended=true。
  @Post('recommend')
  recommend(@Body() body: { questionIds: number[] }, @CurrentUser() user: JwtUser) {
    return this.recommendation.recommend(user.sub, body.questionIds);
  }

  @Post('publications/:id/open')
  @HttpCode(200)
  open(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.delivery.open(user.sub, id);
  }
}
