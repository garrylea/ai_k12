import { BadRequestException, Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { TrainingService } from './training.service.js';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import type { ErrorBookQueryDto } from './dto/error-book-query.dto.js';
import type { JudgeTrainingDto } from './dto/judge-training.dto.js';
import type { SelfAssessTrainingDto } from './dto/self-assess.dto.js';

@Controller('api/training')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class TrainingController {
  constructor(private readonly trainingService: TrainingService) {}

  /** 专项练习允许的题型白名单（null = 不过滤题型）。 */
  private static readonly TARGETED_TYPES = ['choice', 'fill_blank', 'true_false', 'short_answer', 'proof', 'calculation'] as const;

  /** 错题练习筛选列表：subjectId 必填；from/to/type 可选 string，kpId 可选 number。 */
  @Get('error-book')
  async getErrorBookEntries(
    @Query('subjectId', ParseIntPipe) subjectId: number,
    @CurrentUser() user: JwtUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('type') type?: string,
    @Query('kpId') kpIdStr?: string,
  ) {
    let kpId: number | undefined;
    if (kpIdStr !== undefined && kpIdStr !== '') {
      kpId = parseInt(kpIdStr, 10);
      if (Number.isNaN(kpId)) throw new BadRequestException('kpId 非法');
    }
    const filters: ErrorBookQueryDto = { from, to, type, kpId };
    return this.trainingService.getErrorBookEntries(user.sub, subjectId, filters);
  }

  /** 训练判题（题中心变体）：source 白名单校验，非训练来源一律 400。 */
  @Post('judge')
  async judge(@Body() dto: JudgeTrainingDto, @CurrentUser() user: JwtUser) {
    if (dto.source !== 'targeted' && dto.source !== 'error_practice') {
      throw new BadRequestException('source 仅允许 targeted | error_practice');
    }
    return this.trainingService.judgeTraining({
      studentId: user.sub,
      questionId: dto.questionId,
      subjectId: dto.subjectId,
      studentAnswer: dto.studentAnswer,
      source: dto.source,
    });
  }

  /** 主观题学生自评（self_assess 模式）：incorrect 入错题本 / correct 清零；每次自评留痕。
   *  考试结果页自评 source='exam' + sourceRefId=sessionId。 */
  @Post('self-assess')
  async selfAssess(@Body() dto: SelfAssessTrainingDto, @CurrentUser() user: JwtUser) {
    if (dto.source !== 'targeted' && dto.source !== 'error_practice' && dto.source !== 'exam') {
      throw new BadRequestException('source 仅允许 targeted | error_practice | exam');
    }
    if (dto.assessment !== 'correct' && dto.assessment !== 'incorrect') {
      throw new BadRequestException('assessment 仅允许 correct | incorrect');
    }
    if (!Number.isInteger(dto.questionId) || dto.questionId < 1 || !Number.isInteger(dto.subjectId) || dto.subjectId < 1) {
      throw new BadRequestException('questionId 与 subjectId 须为正整数');
    }
    return this.trainingService.selfAssess({
      studentId: user.sub,
      questionId: dto.questionId,
      subjectId: dto.subjectId,
      assessment: dto.assessment,
      source: dto.source,
      sourceRefId: dto.sourceRefId ?? null,
    });
  }

  /** 仍错 bump：错题重做仍答错时提升 level（镜像 practice 的 bump-error-levels）。传 user.sub 做归属校验（防 IDOR）。 */
  @Post('bump-error-levels')
  async bumpErrorLevels(
    @Body() dto: { errorBookIds: number[] },
    @CurrentUser() user: JwtUser,
  ) {
    return this.trainingService.bumpErrorLevels(dto.errorBookIds, user.sub);
  }

  /** 训练「提示」：题级 question_hints 缓存（命中直返，未命中 AI 生成 + 写回）。 */
  @Post('hint')
  async hint(@Body() dto: { questionId: number }, @CurrentUser() user: JwtUser) {
    return this.trainingService.getHint({ questionId: dto.questionId });
  }

  /** 专项练习 KP 树：平铺列表（树形组装放前端）。 */
  @Get('knowledge-points')
  async getKnowledgePoints(@Query('subjectId', ParseIntPipe) subjectId: number) {
    return this.trainingService.getKnowledgePoints(subjectId);
  }

  // ==================== 解析拉取（2026-09-08，判题解析缓存化） ====================

  /** 批量拉解析（末题后结果页）：ids 逗号分隔；后端等 in-flight（60s 兜底）。
   *  注意：须声明在 questions/:questionId/explanation-wait 之前（Nest 按声明顺序匹配，防 'explanations' 被 ':questionId' 吞掉）。 */
  @Get('questions/explanations')
  async getExplanations(@Query('ids') idsStr: string) {
    const ids = (idsStr ?? '').split(',').map((s) => parseInt(s, 10)).filter((n) => !Number.isNaN(n));
    return this.trainingService.getExplanations(ids);
  }

  /** 单题刷新等待（120s 倒计时）：超时返回 null + 写管理员通知。 */
  @Get('questions/:questionId/explanation-wait')
  async waitForExplanation(@Param('questionId', ParseIntPipe) questionId: number) {
    return this.trainingService.waitForExplanation(questionId);
  }

  /** 专项练习开练：count 限 1-20 整数，type 限白名单六值（含 null），越界/非法 400。
   *  studentId 从 JWT 取（用于排除该生已标记不再展示的题）。 */
  @Post('targeted/start')
  async startTargetedPractice(
    @Body() dto: { subjectId: number; kpId: number; type: string | null; count: number },
    @CurrentUser() user: JwtUser,
  ) {
    const { count } = dto;
    if (!Number.isInteger(count) || count < 1 || count > 20) {
      throw new BadRequestException('count 仅允许 1-20 的整数');
    }
    const type = dto.type ?? null;
    if (type !== null && !(TrainingController.TARGETED_TYPES as readonly string[]).includes(type)) {
      throw new BadRequestException(
        'type 仅允许 choice | fill_blank | true_false | short_answer | proof | calculation 或 null',
      );
    }
    return this.trainingService.startTargetedPractice({
      studentId: user.sub,
      subjectId: dto.subjectId,
      kpId: dto.kpId,
      type,
      count,
    });
  }

  // ==================== 语文古诗文专项：默写（2026-09-13） ====================

  /** 语文默写篇目清单（配置页用；只出已校验篇目，作者/朝代/正文均不下发）。 */
  @Get('dictation/passages')
  async listDictationPassages() {
    return this.trainingService.listDictationPassages();
  }

  /** 语文默写开练：count 限 1-20；semester 限 上册|下册|null；
   *  passageIds 非空时按指定篇目出题（忽略 semester）。 */
  @Post('dictation/start')
  async startDictation(
    @Body() dto: { semester: string | null; passageIds: number[] | null; count: number },
  ) {
    const { count } = dto;
    if (!Number.isInteger(count) || count < 1 || count > 20) {
      throw new BadRequestException('count 仅允许 1-20 的整数');
    }
    const semester = dto.semester ?? null;
    if (semester !== null && semester !== '上册' && semester !== '下册') {
      throw new BadRequestException('semester 仅允许 上册 | 下册 | null');
    }
    const passageIds = dto.passageIds ?? null;
    if (passageIds !== null &&
        (!Array.isArray(passageIds) || passageIds.some((id) => !Number.isInteger(id) || id < 1))) {
      throw new BadRequestException('passageIds 须为正整数数组或 null');
    }
    return this.trainingService.startDictation({ semester, passageIds, count });
  }

  /** 语文默写判题：三字段作答；**纯程序判对错、不等 LLM**（~25ms），
   *  答错时返回 `feedbackPending=true`，错因另调 dictation/feedback。
   *  **不写任何学生状态**（独立化后不入错题本）。
   *  非字符串字段（如 {"author":123}）降级为空串——否则会带着 number 进
   *  normalizeChineseAnswer 触发 TypeError 变 500。 */
  @Post('dictation/judge')
  async judgeDictation(
    @Body() dto: { passageId: number; author: string; dynasty: string; body: string },
  ) {
    if (!Number.isInteger(dto.passageId) || dto.passageId < 1) {
      throw new BadRequestException('passageId 须为正整数');
    }
    return this.trainingService.judgeDictation({
      passageId: dto.passageId,
      author: typeof dto.author === 'string' ? dto.author : '',
      dynasty: typeof dto.dynasty === 'string' ? dto.dynasty : '',
      body: typeof dto.body === 'string' ? dto.body : '',
    });
  }

  /** 语文默写错因文案（LLM，可选）：判题后单独取，失败回 feedback=null 不报错。
   *  入参与 judge 相同——服务端据此重算差异喂给模型，但**不写任何学生状态**。 */
  @Post('dictation/feedback')
  async generateDictationFeedback(
    @Body() dto: { passageId: number; author: string; dynasty: string; body: string },
  ) {
    if (!Number.isInteger(dto.passageId) || dto.passageId < 1) {
      throw new BadRequestException('passageId 须为正整数');
    }
    return this.trainingService.generateDictationFeedback({
      passageId: dto.passageId,
      author: typeof dto.author === 'string' ? dto.author : '',
      dynasty: typeof dto.dynasty === 'string' ? dto.dynasty : '',
      body: typeof dto.body === 'string' ? dto.body : '',
    });
  }

  // ==================== 语文古诗文专项：解释（翻译）（2026-09-16） ====================

  /** 解释专项篇目清单（配置页「指定篇目」用；只出篇名 + 册次）。 */
  @Get('interpretation/passages')
  async listInterpretationPassages() {
    return this.trainingService.listInterpretationPassages();
  }

  /** 解释专项开练：count 限 1-3（每篇逐句判，3 篇已是长会话）；
   *  semester 限 上册|下册|null；passageIds 非空时按指定篇目出题（忽略 semester）。 */
  @Post('interpretation/start')
  async startInterpretation(
    @Body() dto: { semester: string | null; passageIds: number[] | null; count: number },
  ) {
    const { count } = dto;
    if (!Number.isInteger(count) || count < 1 || count > 3) {
      throw new BadRequestException('count 仅允许 1-3 的整数');
    }
    const semester = dto.semester ?? null;
    if (semester !== null && semester !== '上册' && semester !== '下册') {
      throw new BadRequestException('semester 仅允许 上册 | 下册 | null');
    }
    const passageIds = dto.passageIds ?? null;
    if (passageIds !== null &&
        (!Array.isArray(passageIds) || passageIds.some((id) => !Number.isInteger(id) || id < 1))) {
      throw new BadRequestException('passageIds 须为正整数数组或 null');
    }
    return this.trainingService.startInterpretation({ semester, passageIds, count });
  }

  /** 解释专项判题：**逐句**判（该句的字词 + 整句翻译），**不写任何学生状态**。
   *  模型漏项/不可用时那些项回 `correct: null` + `method: 'undetermined'`（不报错）。
   *  非字符串字段静默规范化（镜像 dictation/judge）——否则 number 混进去会变 500。 */
  @Post('interpretation/judge')
  async judgeInterpretation(
    @Body() dto: {
      passageId: number;
      sentenceIndex: number;
      terms?: Array<{ term: string; answer: string }>;
      translation?: string;
    },
  ) {
    if (!Number.isInteger(dto.passageId) || dto.passageId < 1) {
      throw new BadRequestException('passageId 须为正整数');
    }
    if (!Number.isInteger(dto.sentenceIndex) || dto.sentenceIndex < 0) {
      throw new BadRequestException('sentenceIndex 须为非负整数');
    }
    const terms: Array<{ term: string; answer: string }> = [];
    for (const raw of Array.isArray(dto.terms) ? dto.terms : []) {
      if (raw == null || typeof raw !== 'object') continue;
      const { term, answer } = raw as { term?: unknown; answer?: unknown };
      if (typeof term !== 'string') continue; // term 不是字符串 → 丢弃该条（answer 非字符串降级空串）
      terms.push({ term, answer: typeof answer === 'string' ? answer : '' });
    }
    return this.trainingService.judgeInterpretation({
      passageId: dto.passageId,
      sentenceIndex: dto.sentenceIndex,
      terms,
      translation: typeof dto.translation === 'string' ? dto.translation : '',
    });
  }

  // ==================== 「不再展示」清单（2026-09-04） ====================

  /** 标记某题不再展示（幂等）。questionId/subjectId 非正整数 -> 400。 */
  @Post('hidden/mark')
  async markHidden(
    @Body() dto: { questionId: number; subjectId: number },
    @CurrentUser() user: JwtUser,
  ) {
    if (!Number.isInteger(dto.questionId) || dto.questionId < 1 ||
        !Number.isInteger(dto.subjectId) || dto.subjectId < 1) {
      throw new BadRequestException('questionId 与 subjectId 须为正整数');
    }
    await this.trainingService.markHidden(user.sub, dto.subjectId, dto.questionId);
    // ResponseInterceptor 包成 { code:0, data:null }（void 返回 -> data:null）
  }

  /** 不再展示清单。 */
  @Get('hidden')
  async listHidden(
    @Query('subjectId', ParseIntPipe) subjectId: number,
    @CurrentUser() user: JwtUser,
  ) {
    return this.trainingService.listHidden(user.sub, subjectId);
  }

  /** 撤销单条标记（归属由 repo WHERE student_id 兜底防 IDOR）。 */
  @Delete('hidden/:questionId')
  async unmarkHidden(
    @Param('questionId', ParseIntPipe) questionId: number,
    @CurrentUser() user: JwtUser,
  ) {
    await this.trainingService.unmarkHidden(user.sub, questionId);
  }

  /** 全部重置：清空该生所有不再展示标记。 */
  @Delete('hidden')
  async unmarkAllHidden(@CurrentUser() user: JwtUser) {
    await this.trainingService.unmarkAllHidden(user.sub);
  }
}
