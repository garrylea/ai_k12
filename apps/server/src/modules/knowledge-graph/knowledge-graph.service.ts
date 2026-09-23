import { Injectable } from '@nestjs/common';
import { KnowledgePointsRepository } from '../../database/repositories/knowledge-points.repo.js';
import { StudentKnowledgeMasteryRepository } from '../../database/repositories/student-knowledge-mastery.repo.js';
import { MainErrorBooksRepository } from '../../database/repositories/main-error-books.repo.js';
import {
  MIN_SAMPLE_SIZE,
  type KnowledgeGraphMastery,
  type KnowledgeGraphNode,
  type MasteryConfidence,
} from './dto/knowledge-graph.dto.js';

/**
 * 阈值只在 DTO 里定义（唯一真源），这里**透传**一次——测试从本模块导入它，
 * 且后续 Task 3 的 `getWeakPoints` 也复用同一个常量，不另立一份。
 */
export { MIN_SAMPLE_SIZE };

/**
 * 数学薄弱点图谱（只读）：把知识点全树与该生掌握度 overlay 组装成可直渲的形状。
 *
 * **本服务零写入**：掌握度由判题出口（`MasteryService.recordFromJudge`）回写，
 * 这里只读。发分也不在这里（开练走 `POST /api/training/targeted/start`，由训练模块负责）。
 */
@Injectable()
export class KnowledgeGraphService {
  constructor(
    private readonly kpRepo: KnowledgePointsRepository,
    private readonly masteryRepo: StudentKnowledgeMasteryRepository,
    private readonly errorsRepo: MainErrorBooksRepository,
  ) {}

  /**
   * 全树 + 掌握度 overlay（spec §5.2）。
   *
   * **以全树为基准左连掌握度行**：未作答的 KP 在 `student_knowledge_mastery` 里**没有行**
   * （不是 0）——缺失一律给 `null` + `confidence: 'none'`，前端渲染为「未开始」灰显。
   * 把缺失当 0 会让「没做过」被读成「很弱」，语义相反（spec §4.3 第 2 条）。
   */
  async getMastery(studentId: number, subjectId: number): Promise<KnowledgeGraphMastery> {
    const [kps, masteryRows, availableMap, coverage, uncoveredUnclearedErrors] = await Promise.all([
      this.kpRepo.findBySubject(subjectId),
      this.masteryRepo.listBySubject(studentId, subjectId),
      this.kpRepo.countAvailableQuestionsByKp(studentId, subjectId),
      this.masteryRepo.countQuestionCoverageBySubject(subjectId),
      this.errorsRepo.countUncoveredUncleared(studentId, subjectId),
    ]);

    const masteryByKp = new Map(masteryRows.map((r) => [r.knowledgePointId, r]));

    const nodes: KnowledgeGraphNode[] = kps.map((kp) => {
      const row = masteryByKp.get(kp.id);
      if (!row) {
        return {
          id: kp.id,
          name: kp.name,
          parentId: kp.parentKpId,
          masteryScore: null,
          level: null,
          correctCount: null,
          errorCount: null,
          lastSeenAt: null,
          sampleSize: 0,
          confidence: 'none' as MasteryConfidence,
          availableQuestionCount: availableMap.get(kp.id) ?? 0,
        };
      }
      const sampleSize = row.correctCount + row.errorCount;
      return {
        id: kp.id,
        name: kp.name,
        parentId: kp.parentKpId,
        masteryScore: row.masteryScore,
        level: row.level,
        correctCount: row.correctCount,
        errorCount: row.errorCount,
        lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
        sampleSize,
        confidence: this.confidenceFor(sampleSize),
        availableQuestionCount: availableMap.get(kp.id) ?? 0,
      };
    });

    return {
      subjectId,
      nodes,
      coverage: {
        coveredQuestions: coverage.coveredQuestions,
        totalQuestions: coverage.totalQuestions,
        uncoveredUnclearedErrors,
      },
    };
  }

  /**
   * 样本量 → 可信度三态。**唯一实现**：前端拿后端算好的值，不重算阈值。
   *
   * `0` 与 `1..4` 要分开：前者是「从未作答」（灰显「未开始」），后者是
   * 「做过但样本不足」（灰显 + 虚线边 + 注明「暂不判定强弱」）。
   */
  private confidenceFor(sampleSize: number): MasteryConfidence {
    if (sampleSize <= 0) return 'none';
    if (sampleSize < MIN_SAMPLE_SIZE) return 'insufficient';
    return 'ok';
  }
}
