import { BadRequestException, Body, Controller, Delete, Get, Logger, NotFoundException, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { TrainingService } from './training.service.js';
import { TrainingSessionsRepository } from '../../database/repositories/training-sessions.repo.js';
import { PointsService } from '../points/points.service.js';
import type { AwardResult } from '../points/points.service.js';
import { PointRulesService } from '../points/point-rules.service.js';
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
  private readonly logger = new Logger(TrainingController.name);

  constructor(
    private readonly trainingService: TrainingService,
    private readonly trainingSessionsRepo: TrainingSessionsRepository,
    private readonly pointsService: PointsService,
    private readonly pointRulesService: PointRulesService,
  ) {}

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

  /** 训练判题（题中心变体）：source 白名单校验，非训练来源一律 400。
   *  可选 `sessionId`（乙类会话）只用于累加 `judged_count` 审计留痕，不传也能判题，
   *  且**失败静默**——审计绝不该影响判题（spec §6.4/§7.2）。 */
  @Post('judge')
  async judge(@Body() dto: JudgeTrainingDto, @CurrentUser() user: JwtUser) {
    if (dto.source !== 'targeted' && dto.source !== 'error_practice') {
      throw new BadRequestException('source 仅允许 targeted | error_practice');
    }
    const result = await this.trainingService.judgeTraining({
      studentId: user.sub,
      questionId: dto.questionId,
      subjectId: dto.subjectId,
      studentAnswer: dto.studentAnswer,
      source: dto.source,
    });
    // 判题完成后再记审计：放前面一旦抛错就会把判题结果顶掉。
    await this.recordSessionJudged(dto.sessionId, user.sub);
    return result;
  }

  /** 会话判题计数 +1（审计留痕）。非正整数 / 会话不存在 / 别人的 / 已完成的都静默跳过。 */
  private async recordSessionJudged(sessionId: number | undefined, studentId: number): Promise<void> {
    if (typeof sessionId !== 'number' || !Number.isInteger(sessionId) || sessionId < 1) return;
    try {
      await this.trainingSessionsRepo.incrementJudged(sessionId, studentId);
    } catch (err) {
      this.logger.warn(
        `training_sessions.incrementJudged failed (sessionId=${sessionId}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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

  /** 专项练习开练：count 必须是**家长已配的档位**（定案 7「档位即可选项」），再限 1-20 整数兜底；
   *  type 限白名单六值（含 null），越界/非法 400。返回体带 `sessionId`（乙类整批发分用）。
   *  studentId 从 JWT 取（用于排除该生已标记不再展示的题）。
   *
   *  白名单必须在服务层之前挡：范围校验放行 1-20 的任意整数，`count=13` 能绕过档位设计。
   *  `listTierKeys` 内部先 `ensureRules`，从未发过分的全新学生拿到默认档位而不是空数组。 */
  @Post('targeted/start')
  async startTargetedPractice(
    @Body() dto: { subjectId: number; kpId: number; type: string | null; count: number },
    @CurrentUser() user: JwtUser,
  ) {
    const { count } = dto;
    const allowed = await this.pointRulesService.listTierKeys(user.sub, 'math_targeted');
    if (!allowed.includes(String(count))) {
      throw new BadRequestException(`题量仅允许 ${allowed.join(' | ')}`);
    }
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

  // ==================== 训练会话完成发分（乙类整批发分，2026-09-17） ====================

  /**
   * 训练会话完成发分（`math_targeted` / `en_vocabulary` 专用，spec §7.2）。
   *
   * **整批发分**：分值是学生开练时选的档位的**打包价**（「3 题 8 分」不是 3×2），
   * 所以只在「这一轮结束了」时发一次。**档位取自会话记录、不取前端入参**——
   * 学生改不了自己开练时后端实际发了什么档，这是乙类唯一的防伪造点（spec §6.4）。
   *
   * **幂等**：重复调用（前端重试）返回 `already_completed` + `pointsAwarded: 0`，**不报错**。
   * `pointsAwarded` 在 `award` 带回 reason 时一律归 0：`duplicate` 时 `award` 会回首次分值，
   * 那是历史账、本次未入账，报出去前端会弹假 `+N 分`（同 Task 10/11 口径）。
   */
  @Post('sessions/:id/complete')
  async completeSession(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    const session = await this.trainingSessionsRepo.findById(id);
    if (!session || session.student_id !== user.sub) {
      throw new NotFoundException({ code: 1002, message: '训练会话不存在' });
    }

    const affected = await this.trainingSessionsRepo.completeOwned(id, user.sub);

    let points: AwardResult;
    try {
      points = await this.pointsService.award({
        studentId: user.sub,
        taskCode: session.task_code,
        tierKey: session.tier_key,
        // 幂等键前缀按任务分（spec §4.4）：背单词 vsess、其余训练会话 tsess。别写死一个。
        dedupeKey: `${session.task_code === 'en_vocabulary' ? 'vsess' : 'tsess'}:${id}`,
        refType: 'training_session',
        refId: id,
      });
    } catch (err) {
      // 积分是激励层，发分失败不能把「完成」这个动作变成 500（会话已置 completed，
      // 前端重试仍会走到 award，幂等键保证不会重复入账）。
      this.logger.warn(
        `points award failed (taskCode=${session.task_code}, sessionId=${id}, studentId=${user.sub}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return { pointsAwarded: 0, balance: 0, totalEarned: 0, levelUp: null };
    }

    return {
      pointsAwarded: points.reason ? 0 : points.pointsAwarded,
      balance: points.balance,
      totalEarned: points.totalEarned,
      // wire 形状：段位用 code 字符串（同 Task 9），不是 LevelInfo 对象
      levelUp: points.levelUp ? { from: points.levelUp.from.code, to: points.levelUp.to.code } : null,
      ...(affected === 0 || points.reason === 'duplicate'
        ? { reason: 'already_completed' as const }
        : points.reason
          ? { reason: points.reason }
          : {}),
    };
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
    @CurrentUser() user: JwtUser,
  ) {
    if (!Number.isInteger(dto.passageId) || dto.passageId < 1) {
      throw new BadRequestException('passageId 须为正整数');
    }
    return this.trainingService.judgeDictation({
      // 发分身份只认 JWT（body 无 studentId 字段；伪造值不会被读取，防替别人刷分）
      studentId: user.sub,
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
    @CurrentUser() user: JwtUser,
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
      // 发分身份只认 JWT（body 无 studentId 字段）
      studentId: user.sub,
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
