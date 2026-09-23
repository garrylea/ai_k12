import { Injectable } from '@nestjs/common';
import { KnowledgePointsRepository } from '../../database/repositories/knowledge-points.repo.js';
import { StudentKnowledgeMasteryRepository } from '../../database/repositories/student-knowledge-mastery.repo.js';
import { MainErrorBooksRepository } from '../../database/repositories/main-error-books.repo.js';
import {
  MIN_SAMPLE_SIZE,
  type KnowledgeGraphMastery,
  type KnowledgeGraphNode,
  type MasteryConfidence,
  type WeakPointCandidate,
  type WeakPointRecommendation,
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
   * 薄弱点推荐（spec §5.4）：三道闸门筛候选 + 稳定排序，取前 `limit` 个。
   *
   * **候选资格（三条同时满足）**：
   * 1. 有该生的掌握度行（做过至少一题且题带 KP 标注）
   * 2. `sampleSize >= MIN_SAMPLE_SIZE` —— 滤掉「做 1 题答对 = 满分」的小样本噪声
   * 3. `availableQuestionCount > 0` —— 否则推了也练不了
   *
   * **排序**：`mastery_score ASC, error_count DESC, knowledge_point_id ASC`。
   * 前两项与 `StudentKnowledgeMasteryRepository.listWeakest` 既有排序一致；
   * 第三项补稳定性，避免并列时每次请求结果抖动。
   *
   * **无候选不是错误**：返回 200 + `recommendation: null`，
   * 让前端转「先做一次练习/考试生成诊断」的引导态（spec §5.3/§6.4）。
   */
  async getWeakPoints(
    studentId: number,
    subjectId: number,
    limit: number,
  ): Promise<WeakPointRecommendation> {
    const [kps, masteryRows, availableMap] = await Promise.all([
      this.kpRepo.findBySubject(subjectId),
      this.masteryRepo.listBySubject(studentId, subjectId),
      this.kpRepo.countAvailableQuestionsByKp(studentId, subjectId),
    ]);

    const kpById = new Map(kps.map((kp) => [kp.id, kp]));

    const candidates: WeakPointCandidate[] = masteryRows
      .filter((row) => {
        const sampleSize = row.correctCount + row.errorCount;
        if (sampleSize < MIN_SAMPLE_SIZE) return false;
        return (availableMap.get(row.knowledgePointId) ?? 0) > 0;
      })
      .map((row) => {
        const kp = kpById.get(row.knowledgePointId);
        return {
          knowledgePointId: row.knowledgePointId,
          // 掌握度行理论上必挂在 KP 上（JOIN 保证），`?? ''` 只防御脏数据
          name: kp?.name ?? '',
          parentId: kp?.parentKpId ?? null,
          masteryScore: row.masteryScore,
          level: row.level,
          correctCount: row.correctCount,
          errorCount: row.errorCount,
          sampleSize: row.correctCount + row.errorCount,
          availableQuestionCount: availableMap.get(row.knowledgePointId) ?? 0,
          lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
        };
      })
      .sort(
        (a, b) =>
          a.masteryScore - b.masteryScore ||
          b.errorCount - a.errorCount ||
          a.knowledgePointId - b.knowledgePointId,
      )
      .slice(0, limit);

    return {
      subjectId,
      candidates,
      recommendation: candidates[0] ?? null,
      reason: candidates.length > 0 ? 'ok' : 'no_qualified_candidate',
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
