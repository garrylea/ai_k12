import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { VocabularyService, VOCABULARY_MAX_COUNT, VOCABULARY_MIN_COUNT } from './vocabulary.service.js';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import type {
  VocabularyDirection,
  VocabularyOrder,
  VocabularyPromptKind,
  VocabularyStartInput,
  LevelPool,
} from './dto/vocabulary.dto.js';

/**
 * 英语背单词（2026-09-16）。
 *
 * 独立子系统：不挂 `questions`、不进错题本、不参与主线清零门禁、不用「不再展示」/自评。
 * 端点前缀挂在 `/api/training/vocabulary`（与数学练习、语文专项同属训练模块），
 * 但代码分成独立的 controller/service，不塞进已被撑大的 TrainingController/TrainingService。
 *
 * 入参校验沿用本仓既有做法：**控制器内联校验 + 非字符串字段静默降级**
 * （见 training.controller.ts 的 dictation/judge）——后者是必需的，
 * 否则 `{"answer":123}` 会带着 number 走进归一化函数触发 TypeError 变 500。
 */
@Controller('api/training/vocabulary')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class VocabularyController {
  private static readonly LEVEL_POOLS: readonly LevelPool[] = ['junior', 'senior', 'all'];
  private static readonly ORDERS: readonly VocabularyOrder[] = ['random', 'alpha', 'alpha_desc', 'letter'];
  private static readonly DIRECTIONS: readonly VocabularyDirection[] = ['en2cn', 'cn2en', 'random'];
  private static readonly PROMPT_KINDS: readonly VocabularyPromptKind[] = ['en2cn', 'cn2en'];

  constructor(private readonly vocabularyService: VocabularyService) {}

  /** 配置页：可选词库范围与规模、今日已背、四个筛选各自的池子大小。 */
  @Get('options')
  async getOptions(@CurrentUser() user: JwtUser) {
    return this.vocabularyService.getOptions(this.studentIdOf(user));
  }

  /**
   * 开练（抽题）。count 限 10-20；三个枚举走白名单；letter 只在 order='letter' 时允许，
   * 且必须是单个 a-z 字母（仓储还会再校验一次，杜绝把通配符带进 LIKE）。
   */
  @Post('start')
  async start(
    @Body() dto: {
      levelPool?: string;
      count?: number;
      order?: string;
      letter?: string | null;
      direction?: string;
      onlyNotLearned?: boolean;
      onlyMyWrong?: boolean;
      onlyCommonWrong?: boolean;
      onlyExtendedSense?: boolean;
    },
    @CurrentUser() user: JwtUser,
  ) {
    const { count } = dto;
    if (!Number.isInteger(count) || (count as number) < VOCABULARY_MIN_COUNT || (count as number) > VOCABULARY_MAX_COUNT) {
      throw new BadRequestException(`count 仅允许 ${VOCABULARY_MIN_COUNT}-${VOCABULARY_MAX_COUNT} 的整数`);
    }
    if (!VocabularyController.LEVEL_POOLS.includes(dto.levelPool as LevelPool)) {
      throw new BadRequestException(`levelPool 仅允许 ${VocabularyController.LEVEL_POOLS.join(' | ')}`);
    }
    if (!VocabularyController.ORDERS.includes(dto.order as VocabularyOrder)) {
      throw new BadRequestException(`order 仅允许 ${VocabularyController.ORDERS.join(' | ')}`);
    }
    if (!VocabularyController.DIRECTIONS.includes(dto.direction as VocabularyDirection)) {
      throw new BadRequestException(`direction 仅允许 ${VocabularyController.DIRECTIONS.join(' | ')}`);
    }

    const order = dto.order as VocabularyOrder;
    const letter = dto.letter ?? null;
    if (order === 'letter') {
      if (typeof letter !== 'string' || !/^[a-zA-Z]$/.test(letter)) {
        throw new BadRequestException('order=letter 时 letter 须为单个字母');
      }
    } else if (letter !== null) {
      // 非 letter 模式下传了字母属于调用方 bug：静默忽略会让学生以为筛选生效了
      throw new BadRequestException('letter 仅在 order=letter 时可用');
    }

    const input: VocabularyStartInput = {
      levelPool: dto.levelPool as LevelPool,
      count: count as number,
      order,
      letter: order === 'letter' ? (letter as string) : null,
      direction: dto.direction as VocabularyDirection,
      onlyNotLearned: dto.onlyNotLearned === true,
      onlyMyWrong: dto.onlyMyWrong === true,
      onlyCommonWrong: dto.onlyCommonWrong === true,
      onlyExtendedSense: dto.onlyExtendedSense === true,
    };
    return this.vocabularyService.start(input, this.studentIdOf(user));
  }

  /**
   * 判题。中→英纯程序比对（不调 LLM）；英→中先程序短路、未命中才调模型。
   * 判题失败回 `verdict='undetermined'`（不计对错、不写错题统计），不抛错。
   */
  @Post('judge')
  async judge(
    @Body() dto: {
      wordId?: number;
      senseIndex?: number;
      promptKind?: string;
      answer?: string;
    },
    @CurrentUser() user: JwtUser,
  ) {
    if (!Number.isInteger(dto.wordId) || (dto.wordId as number) < 1) {
      throw new BadRequestException('wordId 须为正整数');
    }
    if (!Number.isInteger(dto.senseIndex) || (dto.senseIndex as number) < 0) {
      throw new BadRequestException('senseIndex 须为非负整数');
    }
    if (!VocabularyController.PROMPT_KINDS.includes(dto.promptKind as VocabularyPromptKind)) {
      throw new BadRequestException(`promptKind 仅允许 ${VocabularyController.PROMPT_KINDS.join(' | ')}`);
    }
    return this.vocabularyService.judge(
      {
        wordId: dto.wordId as number,
        senseIndex: dto.senseIndex as number,
        promptKind: dto.promptKind as VocabularyPromptKind,
        // 非字符串降级为空串 → 走「未作答」分支，而不是带着 number 进归一化函数变 500
        answer: typeof dto.answer === 'string' ? dto.answer : '',
      },
      this.studentIdOf(user),
    );
  }

  /**
   * 「移除易错标记」：只清该学生自己的 wrong_count。
   * 不动 learned、不动全局 error_count（那是全平台统计，不该被单个学生抹掉）。
   */
  @Post('progress/clear')
  async clearProgress(@Body() dto: { wordId?: number }, @CurrentUser() user: JwtUser) {
    if (!Number.isInteger(dto.wordId) || (dto.wordId as number) < 1) {
      throw new BadRequestException('wordId 须为正整数');
    }
    return this.vocabularyService.clearWrongMark(dto.wordId as number, this.studentIdOf(user));
  }

  /**
   * 词根族（点「+」号懒加载）。
   *
   * 这里**不按题面类型设限**（成绩单复盘时也要能看），但前端必须只在英→中题上渲染入口——
   * 族树里必然包含单词本身，中→英题点开就等于直接看答案。
   */
  @Get('words/:wordId/family')
  async getFamily(@Param('wordId', ParseIntPipe) wordId: number) {
    return this.vocabularyService.getFamily(wordId);
  }

  /** JwtUser.sub 即学生 id（本控制器整体限定 @Roles('student')，同 training.controller 的 user.sub 用法）。 */
  private studentIdOf(user: JwtUser): number {
    return user.sub;
  }
}
