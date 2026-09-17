import { BadRequestException, Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { MeaningService } from './meaning.service.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import type { MeaningJudgeResult, MeaningPassageItem, MeaningPassageListItem } from './dto/meaning.dto.js';

/**
 * 语文古诗文「含义」专项（2026-09-17）。
 *
 * 独立 controller，不塞进已被撑大的 TrainingController（与英语背单词同分法）。
 * 端点前缀 `/api/training/meaning`，仍属训练模块。
 *
 * 入参一律手工校验 + 静默规范化：客户端可能混进 number/null，
 * 不规范化会让它们在归一化函数里 TypeError 变 500（见 training.controller.ts 的 dictation/judge）。
 */
@Controller('api/training/meaning')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class MeaningController {
  constructor(private readonly meaningService: MeaningService) {}

  /** 篇目清单（配置页「指定篇目」用；只出篇名 + 册次，没有内容）。 */
  @Get('passages')
  async listPassages(): Promise<{ passages: MeaningPassageListItem[] }> {
    return this.meaningService.listMeaningPassages();
  }

  /**
   * 开练：count 限 1-3（每篇逐句判，3 篇已是长会话）；
   * semester 限 上册|下册|null；passageIds 非空时按指定篇目出题（忽略 semester）。
   */
  @Post('start')
  async startMeaning(
    @Body() dto: { semester: string | null; passageIds: number[] | null; count: number },
  ): Promise<{ passages: MeaningPassageItem[] }> {
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
    return this.meaningService.startMeaning({ semester, passageIds, count });
  }

  /**
   * 判题：**逐句**判（该句的字词 + 深层含义 + 作者情感），**不写任何学生状态**。
   * 模型漏项/不可用时那些项回 `correct: null` + `method: 'undetermined'`（不报错）。
   */
  @Post('judge')
  async judgeMeaning(
    @Body() dto: {
      passageId: number;
      sentenceIndex: number;
      terms?: Array<{ term: string; answer: string }>;
      meaning?: string;
      emotion?: string;
    },
  ): Promise<MeaningJudgeResult> {
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
      if (typeof term !== 'string') continue;
      terms.push({ term, answer: typeof answer === 'string' ? answer : '' });
    }
    return this.meaningService.judgeMeaning({
      passageId: dto.passageId,
      sentenceIndex: dto.sentenceIndex,
      terms,
      meaning: typeof dto.meaning === 'string' ? dto.meaning : '',
      emotion: typeof dto.emotion === 'string' ? dto.emotion : '',
    });
  }
}
