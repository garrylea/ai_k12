import { Injectable } from '@nestjs/common';
import { JudgeCoreService } from '../practice/judge-core.service.js';
import { MainErrorBooksRepository } from '../../database/repositories/main-error-books.repo.js';
import { QuestionsRepository } from '../../database/repositories/questions.repo.js';
import type { ErrorBookEntryDto, ErrorBookQueryDto } from './dto/error-book-query.dto.js';

/**
 * 错题训练模块 service。
 *
 * 错题练习筛选列表（Task 1）+ 判题/仍错 bump（Task 2）；
 * questionsRepo 供 Task 3（变式题生成）使用，先占位保证构造签名稳定。
 */
@Injectable()
export class TrainingService {
  constructor(
    private readonly mainErrorRepo: MainErrorBooksRepository,
    private readonly judgeCore: JudgeCoreService,
    private readonly questionsRepo: QuestionsRepository,
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
      });
    }
    return [...byId.values()];
  }

  /** 训练判题：JudgeCore 题中心变体的薄封装（source 由端点语义决定，不透传客户端任意值）。 */
  async judgeTraining(input: { studentId: number; questionId: number; subjectId: number; studentAnswer: string; source: 'targeted' | 'error_practice' }) {
    return this.judgeCore.judgeQuestion({ ...input, sourceRefId: null });
  }

  /** 仍错 bump：错题重做仍答错时提升 level（镜像 PracticeService.bumpErrorLevels）。 */
  async bumpErrorLevels(errorBookIds: number[]): Promise<void> {
    await this.mainErrorRepo.bumpLevels(errorBookIds);
  }
}
