import {
  Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query, UseGuards,
} from '@nestjs/common';
import { FeaturedReviewService } from './featured-review.service.js';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';

/** 教研审核：角色校验全在 guard，service 只认 JWT sub 作为 reviewerId。 */
@Controller('api/research/featured-sets')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('researcher')
export class ResearchFeaturedSetsController {
  constructor(private readonly service: FeaturedReviewService) {}

  @Get()
  list(@Query('status') status: string | undefined, @Query('page') page: string | undefined) {
    return this.service.list(status, page);
  }

  // 必须先于 @Get(':id') 声明，否则 pending-count 会被当成 :id。
  @Get('pending-count')
  pendingCount() {
    return this.service.pendingCount();
  }

  @Get(':id')
  detail(@Param('id', ParseIntPipe) id: number) {
    return this.service.detail(id);
  }

  @Post(':id/publish')
  @HttpCode(200)
  publish(@Param('id', ParseIntPipe) id: number, @Body() body: unknown, @CurrentUser() user: JwtUser) {
    return this.service.publish(id, body, user);
  }

  @Post(':id/reject')
  @HttpCode(200)
  reject(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.service.reject(id, user);
  }

  @Post(':id/reopen')
  @HttpCode(200)
  reopen(@Param('id', ParseIntPipe) id: number) {
    return this.service.reopen(id);
  }

  @Post('publications/:id/withdraw')
  @HttpCode(200)
  withdraw(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.service.withdraw(id, user);
  }
}
