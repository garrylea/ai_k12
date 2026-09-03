import { Controller, Get, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { ExamsService } from './exams.service.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';

@Controller('api/exams')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class ExamsController {
  constructor(private readonly examsService: ExamsService) {}

  /** 试卷列表：subjectId 必填；year/district/examType/gradeBand 可选筛选。 */
  @Get('papers')
  async listPapers(
    @Query('subjectId', ParseIntPipe) subjectId: number,
    @Query('year') yearStr?: string,
    @Query('district') district?: string,
    @Query('examType') examType?: string,
    @Query('gradeBand') gradeBand?: string,
  ) {
    let year: number | undefined;
    if (yearStr !== undefined && yearStr !== '') {
      year = parseInt(yearStr, 10);
      if (Number.isNaN(year)) year = undefined;
    }
    return this.examsService.listPapers({ subjectId, year, district, examType, gradeBand });
  }

  /** 试卷详情：题目元数据 + 推荐时长（不含 answer/explanation）。 */
  @Get('papers/:id')
  async getPaperDetail(@Param('id', ParseIntPipe) id: number) {
    return this.examsService.getPaperDetail(id);
  }
}
