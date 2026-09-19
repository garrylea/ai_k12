import { Injectable } from '@nestjs/common';
import { StudentKnowledgeMasteryRepository } from '../../database/repositories/student-knowledge-mastery.repo.js';
import type { MasterySummary } from './dto/parent-insights.dto.js';

/**
 * 家长端真掌握度（spec §8.2 `/mastery`）：**只读** `student_knowledge_mastery` + `knowledge_points`。
 *
 * 与既有的 `weakPoints`（**错题数代理**）是两套口径：spec §10 明确要求两张卡**并存、标题区分、不得合并**，
 * 所以本 service 不碰 `parent-insights.repo.ts` 的 weakPoints 查询。
 *
 * `coveredQuestions` / `totalQuestions` / `uncovered` **必须回**：题库的 KP 覆盖率只有 38%，
 * 不展示会让家长把「只有这几个薄弱点」当成事实（spec §4.8 规则①）。
 *
 * 调用方（controller）负责把 `limit` 校验为 1..50 的整数。
 */
@Injectable()
export class ParentMasteryService {
  constructor(private readonly masteryRepo: StudentKnowledgeMasteryRepository) {}

  async getMastery(studentId: number, limit: number): Promise<MasterySummary> {
    const [items, coverage] = await Promise.all([
      this.masteryRepo.listWeakest(studentId, limit),
      this.masteryRepo.countQuestionCoverage(),
    ]);

    return {
      items,
      coveredQuestions: coverage.coveredQuestions,
      totalQuestions: coverage.totalQuestions,
      uncovered: Math.max(0, coverage.totalQuestions - coverage.coveredQuestions),
    };
  }
}
