import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ExamsService } from './exams.service.js';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import type { SessionCreateDto, SubmitAnswerDto } from './dto/session-create.dto.js';

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

  /** 开考/续考：同卷 in_progress 会话直接续（不重置时长）；durationMinutes 10-300 整数。 */
  @Post('sessions')
  async createSession(@Body() dto: SessionCreateDto, @CurrentUser() user: JwtUser) {
    return this.examsService.createSession(user.sub, dto);
  }

  /** 会话状态：题单 + 已答 map（不回传对错）+ 剩余秒数；超时服务端自动收卷。 */
  @Get('sessions/:id')
  async getSession(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.examsService.getSession(user.sub, id);
  }

  /** 单题提交（同步判题，白名单响应 {saved:true}，不泄露对错）；超 deadline 409 + 自动收卷。 */
  @Post('sessions/:id/answers')
  async submitAnswer(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SubmitAnswerDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.examsService.submitAnswer(user.sub, id, dto);
  }

  /** 交卷（幂等）：未作答按错计入错题本，在途判题补判。 */
  @Post('sessions/:id/submit')
  async submit(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.examsService.submit(user.sub, id);
  }

  /** 结果页：仅 submitted 可查（in_progress 409）；items 带 explanation。 */
  @Get('sessions/:id/results')
  async getResults(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.examsService.getResults(user.sub, id);
  }
}
