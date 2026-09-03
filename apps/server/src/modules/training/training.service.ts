import { Injectable, Logger, HttpException, NotFoundException } from '@nestjs/common';
import { JudgeCoreService } from '../practice/judge-core.service.js';
import { MainErrorBooksRepository } from '../../database/repositories/main-error-books.repo.js';
import { QuestionsRepository } from '../../database/repositories/questions.repo.js';
import { KnowledgePointsRepository } from '../../database/repositories/knowledge-points.repo.js';
import { QuestionHintsRepository } from '../../database/repositories/question-hints.repo.js';
import { HintCapability } from '../../ai-core/capabilities/hint.capability.js';
import type { ErrorBookEntryDto, ErrorBookQueryDto } from './dto/error-book-query.dto.js';

/**
 * 错题训练模块 service。
 *
 * 错题练习筛选列表（Task 1）+ 判题/仍错 bump（Task 2）+ 提示缓存（Task 3）
 * + 专项练习 KP 树 / 随机抽题（Task 8）。
 */
@Injectable()
export class TrainingService {
  private readonly logger = new Logger(TrainingService.name);

  constructor(
    private readonly mainErrorRepo: MainErrorBooksRepository,
    private readonly judgeCore: JudgeCoreService,
    private readonly questionsRepo: QuestionsRepository,
    private readonly knowledgePointsRepo: KnowledgePointsRepository,
    private readonly questionHintsRepo: QuestionHintsRepository,
    private readonly hint: HintCapability,
  ) {}

  /** 错题练习筛选列表：调 repo 后按 errorBookId 聚合 kpIds，映射 DTO。 */
  async getErrorBookEntries(
    studentId: number,
    subjectId: number,
    filters: ErrorBookQueryDto,
  ): Promise<ErrorBookEntryDto[]> {
    const rows = await this.mainErrorRepo.findErrorBookEntries(studentId, subjectId, filters);
    // 同一错题多 KP 时 repo 返回多行（仅 kp_id 不同），按 id 聚合。
    const byId = new Map<number, ErrorBookEntryDto>();
    for (const row of rows) {
      const existing = byId.get(row.id);
      if (existing) {
        if (row.kp_id != null) existing.kpIds.push(row.kp_id);
        continue;
      }
      byId.set(row.id, {
        errorBookId: row.id,
        questionId: row.question_id,
        questionText: row.questionText ?? '',
        type: row.type,
        level: row.level,
        createdAt: new Date(row.created_at).toISOString(),
        kpIds: row.kp_id != null ? [row.kp_id] : [],
        options: parseOptions(row.options),
      });
    }
    return [...byId.values()];
  }

  /** 训练判题：JudgeCore 题中心变体的薄封装（source 由端点语义决定，不透传客户端任意值）。 */
  async judgeTraining(input: { studentId: number; questionId: number; subjectId: number; studentAnswer: string; source: 'targeted' | 'error_practice' }) {
    return this.judgeCore.judgeQuestion({ ...input, sourceRefId: null });
  }

  /** 仍错 bump：错题重做仍答错时提升 level（镜像 PracticeService.bumpErrorLevels）。studentId 为归属校验（防 IDOR）。 */
  async bumpErrorLevels(errorBookIds: number[], studentId?: number): Promise<void> {
    await this.mainErrorRepo.bumpLevels(errorBookIds, studentId);
  }

  /**
   * 训练「提示」：题级缓存三段式（镜像 PracticeService.getHint 语义）：
   * 查 question_hints 缓存（命中直返，省 AI）→ 未命中调 HintCapability 生成
   * 苏格拉底式提示 → 写回缓存（best-effort，失败不阻断返回）。
   * 缓存是题级共享（不分学生）；题目不存在 -> 404；AI 失败 -> 503（code 5001）。
   */
  async getHint(input: { questionId: number }): Promise<{ hint: string; cached: boolean }> {
    // 0. 拿题面（训练题必来自题库，无题 404）
    const q = await this.questionsRepo.findById(input.questionId);
    if (!q) {
      throw new NotFoundException(`题目不存在：${input.questionId}`);
    }

    // 1. 查缓存
    const cachedRow = await this.questionHintsRepo.findByQuestionId(input.questionId);
    if (cachedRow) {
      return { hint: cachedRow.hint, cached: true };
    }

    // 2. 未命中 -> AI 生成
    try {
      const result = await this.hint.generate({
        questionContent: q.content,
        subject: 'math',
      });
      // 3. 写回缓存（失败不阻断返回，仅记日志）
      try {
        await this.questionHintsRepo.upsert(input.questionId, result.content);
      } catch (err) {
        this.logger.error(`questionHintsRepo.upsert failed (questionId=${input.questionId}): ${err}`);
      }
      return { hint: result.content, cached: false };
    } catch (err) {
      this.logger.error(`hint.generate failed: ${err}`);
      throw new HttpException(
        { code: 5001, message: '提示生成失败，请重试' },
        503,
      );
    }
  }

  /** 专项练习 KP 树：平铺列表透传（树形组装放前端）。 */
  async getKnowledgePoints(
    subjectId: number,
  ): Promise<Array<{ id: number; name: string; parentKpId: number | null; gradeBand: string }>> {
    return this.knowledgePointsRepo.findBySubject(subjectId);
  }

  /**
   * 专项练习开练：按学科 + 知识点（可选题型）随机抽题。
   * 题单做白名单序列化——只出 questionId/text/type/options，answer/explanation
   * 等字段一律剥离（防答案泄露）；options 是 JSON 字符串，parse 成数组返回。
   * 抽不到题返回空数组（空集合非错误，前端判空显示提示）。
   */
  async startTargetedPractice(input: {
    subjectId: number;
    kpId: number;
    type: string | null;
    count: number;
  }): Promise<{ questions: Array<{ questionId: number; text: string; type: string; options: unknown[] | null }> }> {
    const rows = await this.questionsRepo.findRandomByKpAndType(
      input.subjectId,
      input.kpId,
      input.type,
      input.count,
    );
    return {
      questions: rows.map((q) => ({
        questionId: q.id,
        text: q.content,
        type: q.type,
        options: parseOptions(q.options),
      })),
    };
  }
}

/** options JSON 字符串安全解析：null/空串/非数组/坏 JSON 一律返回 null。 */
function parseOptions(raw: string | null): unknown[] | null {
  if (raw == null || raw === '') return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
