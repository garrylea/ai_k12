import { Injectable } from '@nestjs/common';
import { QuestionsRepository } from '../../database/repositories/questions.repo.js';
import { KnowledgePointsRepository } from '../../database/repositories/knowledge-points.repo.js';
import { TrainingSessionsRepository } from '../../database/repositories/training-sessions.repo.js';
import { VariationCapability } from '../../ai-core/capabilities/variation.capability.js';
import { PointRulesService } from '../points/point-rules.service.js';
import { parseOptions } from '../../common/utils/parse-options.util.js';

/** 历史题重做/同类型练习的运行态题目载荷：**白名单**，绝不含 answer / explanation。 */
export interface HistoryRunQuestion {
  questionId: number;
  text: string;
  type: string;
  options: unknown[] | null;
  materialText: string | null;
}

/**
 * 练习记录里的「再做一次」（Task 5，2026-11-06）。
 *
 * 与错题训练不同，这里**不建任何会话/作答记录、不发分**：只把原题回放给学生再练一遍。
 * `startSimilar`（同类型练习）在 Task 6 加入，故构造函数的多余依赖先备好。
 */
@Injectable()
export class HistoryPracticeService {
  constructor(
    private readonly questionsRepo: QuestionsRepository,
    private readonly kpRepo: KnowledgePointsRepository,
    private readonly variation: VariationCapability,
    private readonly trainingSessionsRepo: TrainingSessionsRepository,
    private readonly pointRules: PointRulesService,
  ) {}

  /** 回放原题（下架或不存在 → null，由调用方转 404/400）。 */
  async loadRedoQuestion(questionId: number): Promise<HistoryRunQuestion | null> {
    const q = await this.questionsRepo.findById(questionId);
    if (!q || q.is_active !== 1) return null;
    return {
      questionId: q.id,
      text: q.content,
      type: q.type,
      options: parseOptions(q.options),
      materialText: q.material_text ?? null,
    };
  }

  // startSimilar 在 Task 6 加入
}
