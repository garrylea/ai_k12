import { Controller, Get, Param, Query, ParseIntPipe, UseGuards, ForbiddenException } from '@nestjs/common';
import { ProgressService } from './progress.service.js';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.js';

@Controller('api/progress')
@UseGuards(JwtAuthGuard)
export class ProgressController {
  constructor(private progressService: ProgressService) {}

  @Get('students/:studentId/star-map')
  getStarMap(
    @Param('studentId', ParseIntPipe) studentId: number,
    @Query('subjectId', ParseIntPipe) subjectId: number,
    @CurrentUser() user: JwtUser,
  ) {
    // Identity comes from the JWT, not the URL. The path segment is only a
    // resource locator; a student may only read their own star map.
    if (user.sub !== studentId) {
      throw new ForbiddenException({ code: 1003, message: '无权访问他人数据' });
    }
    return this.progressService.getStarMap(user.sub, subjectId);
  }
}
