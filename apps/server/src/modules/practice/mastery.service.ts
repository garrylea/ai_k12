import { Injectable, Logger } from '@nestjs/common';
import { QuestionsRepository } from '../../database/repositories/questions.repo.js';
import { StudentKnowledgeMasteryRepository } from '../../database/repositories/student-knowledge-mastery.repo.js';

/**
 * 判题 / 自评后的**知识点掌握度回写**（spec §4.8）。
 *
 * 四条规则（逐条对应 spec 原文，改动前先读）：
 *   ① 只在该题**绑了 KP** 时写——`question_knowledge_points` 实测只覆盖 203/530 题（38%），
 *      所以家长端必须**显式展示未覆盖计数**，否则家长会以为「薄弱点只有这几个」；
 *   ② `isCorrect === null`（空答案 / `self_assess` 待评）**不写**；
 *   ③ `questionId == null` **跳过**；
 *   ④ 失败只 warn，**不阻断判题**（判题是主链路，掌握度是派生数据）。
 *
 * 2026-11-07 用户裁决：**自评题也计入掌握度**（此前只有客观判题写）。
 * 自评结果 `correct|incorrect` 在调用点先映射成 boolean，再走同一个 `recordFromJudge`，
 * 因此公式、KP 关联规则、失败容错全部只有一份实现。
 *
 * 为什么单独立一个 service 而不是塞进 `JudgeCoreService`：`JudgeCoreService` 已经很大，
 * 而且回写要注入两个仓储——分开后它能被单独表驱动测试（spec §15 的必测项之一）。
 */
@Injectable()
export class MasteryService {
  private readonly logger = new Logger(MasteryService.name);

  constructor(
    private readonly questionsRepo: QuestionsRepository,
    private readonly masteryRepo: StudentKnowledgeMasteryRepository,
  ) {}

  async recordFromJudge(input: {
    studentId: number;
    questionId: number | null;
    isCorrect: boolean | null;
  }): Promise<void> {
    // 规则②③：两道闸门放在任何 IO 之前（不满足就一次查询都不发）
    if (input.questionId === null) return;
    if (input.isCorrect === null) return;
    const questionId = input.questionId;
    const isCorrect = input.isCorrect;

    try {
      const kpIds = await this.questionsRepo.findKnowledgePointIdsByQuestion(questionId);
      // 规则①：没绑 KP 就什么都不写（这是常态，不是异常）
      for (const kpId of kpIds) {
        await this.masteryRepo.upsertOnJudge(input.studentId, kpId, isCorrect);
      }
    } catch (err) {
      // 规则④
      this.logger.warn('掌握度回写失败（已忽略，不影响判题/自评）', err);
    }
  }

  /**
   * 主观题自评结果回写（2026-11-07 用户裁决）。
   *
   * **刻意复用 `recordFromJudge`**：自评的 correct/incorrect 与客观判题的对/错在掌握度上
   * 是同一种信号，没必要另写一套聚合公式；若将来要区分「自评可信度」，必须同时改仓储
   * 公式与图谱读侧，不能只在调用点做标记。
   */
  async recordFromSelfAssessment(input: {
    studentId: number;
    questionId: number | null;
    assessment: 'correct' | 'incorrect';
  }): Promise<void> {
    await this.recordFromJudge({
      studentId: input.studentId,
      questionId: input.questionId,
      isCorrect: input.assessment === 'correct',
    });
  }
}
