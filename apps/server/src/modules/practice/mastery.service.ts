import { Injectable, Logger } from '@nestjs/common';
import { QuestionsRepository } from '../../database/repositories/questions.repo.js';
import { StudentKnowledgeMasteryRepository } from '../../database/repositories/student-knowledge-mastery.repo.js';

/**
 * 判题后的**知识点掌握度回写**（spec §4.8）。
 *
 * 四条规则（逐条对应 spec 原文，改动前先读）：
 *   ① 只在该题**绑了 KP** 时写——`question_knowledge_points` 实测只覆盖 203/530 题（38%），
 *      所以家长端必须**显式展示未覆盖计数**，否则家长会以为「薄弱点只有这几个」；
 *   ② `isCorrect === null`（空答案 / `self_assess` 待评）**不写**；
 *   ③ `questionId == null` **跳过**；
 *   ④ 失败只 warn，**不阻断判题**（判题是主链路，掌握度是派生数据）。
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
      this.logger.warn('掌握度回写失败（已忽略，不影响判题）', err);
    }
  }
}
