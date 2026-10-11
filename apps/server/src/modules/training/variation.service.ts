import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { JudgeCoreService } from '../practice/judge-core.service.js';
import { QuestionsRepository } from '../../database/repositories/questions.repo.js';
import { VariationQuestionsRepository } from '../../database/repositories/variation-questions.repo.js';
import type { VariationPendingRow, VariationQuestionRow } from '../../database/repositories/variation-questions.repo.js';
import { parseOptions } from '../../common/utils/parse-options.util.js';

/** 首期恒数学（与生成器、补偿套题同口径）。 */
const MATH_SUBJECT_ID = 1;

export interface VariationItemDto {
  /** variation_questions.id —— 与 questionId 分开：落定 CAS 用它。 */
  variationId: number;
  questionId: number;
  errorBookId: number;
  text: string;
  type: string;
  options: Array<{ label: string; text: string }> | null;
  difficulty: number;
}

export interface VariationListResult {
  variations: VariationItemDto[];
}

export interface VariationAnswerResult {
  isCorrect: boolean | null;
  method: string;
  errorType: string | null;
  needsSelfAssessment: boolean;
  referenceAnswer: string | null;
  explanation: string | null;
  /** 无 points 字段：变式是纯加练、不发分（用户裁决 2026-10-11，与补偿套题返回形状的差异点）。 */
  remainingCount: number;
}

/**
 * 错题升级变式编排服务（PRD §7.10，2026-10-11）。
 *
 * 职责边界：
 * - **生成** 全在 `VariationGeneratorService`（bump-error-levels 内 fire-and-forget 触发）；
 * - **判题** 复用 `JudgeCoreService.judgeQuestion`，来源恒为 `'variation'`
 *   → 纯加练完全隔离：不入错题本、不清零原错题、不发 error_fix（用户裁决）；
 * - **主观题自评** 走本类 `selfAssess`，**刻意不经 `judgeCore`**（镜像补偿套题 Task 4 裁决：
 *   `recordSelfAssessment` 没有 variation 分支且会碰错题本；自评只落定变式行本身）。
 * - **一次作答即落定**（用户裁决 D1）：判对判错都写 is_correct + answered_at，答错不重出。
 */
@Injectable()
export class VariationService {
  private readonly logger = new Logger(VariationService.name);

  constructor(
    private readonly variationRepo: VariationQuestionsRepository,
    private readonly questionsRepo: QuestionsRepository,
    private readonly judgeCore: JudgeCoreService,
  ) {}

  /** pending 变式列表（错题本入口 + 结果页提示卡共用一个数据源）。 */
  async listPending(studentId: number, errorBookId?: number): Promise<VariationListResult> {
    let pending = await this.variationRepo.findPendingByStudent(studentId, errorBookId);
    if (pending.length === 0) return { variations: [] };

    // findByIds 只回 is_active=1 的题：变式题被下线则永远答不了——直接落定（is_correct=0），
    // 防「N 道变式待练」死计数（镜像 remediation.service:210-216 的下线题收口）。
    const rows = await this.questionsRepo.findByIds(pending.map((i) => i.question_id));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const offline: VariationPendingRow[] = [];
    const online: VariationPendingRow[] = [];
    for (const p of pending) (byId.has(p.question_id) ? online : offline).push(p);
    for (const p of offline) {
      await this.variationRepo.markAnswered(p.id, false);
      this.logger.warn(`variation question offline, auto-settled (variationId=${p.id}, questionId=${p.question_id})`);
    }
    pending = online;

    const variations = pending.map((p) => {
      const q = byId.get(p.question_id)!;
      return {
        variationId: p.id,
        questionId: q.id,
        errorBookId: p.original_error_item_id,
        text: q.content,
        type: q.type,
        // parseOptions 而非裸 JSON.parse：坏 JSON/非数组一律 null（否则作答页整页 500）
        options: parseOptions(q.options) as Array<{ label: string; text: string }> | null,
        difficulty: p.difficulty,
      };
    });
    return { variations };
  }

  /** 逐题提交：判题走 `JudgeCoreService`（`source='variation'`），一次作答落定。 */
  async submitAnswer(studentId: number, input: { questionId: number; studentAnswer: string }): Promise<VariationAnswerResult> {
    const row = await this.requirePending(studentId, input.questionId);
    const judged = await this.judgeCore.judgeQuestion({
      studentId,
      subjectId: MATH_SUBJECT_ID,
      questionId: input.questionId,
      studentAnswer: input.studentAnswer,
      source: 'variation',
    });
    // 主观题路由（judge-core 1c）早退 isCorrect=null：不落定，原样带回等自评端点落定
    if (judged.isCorrect === null) {
      return this.assemble(judged.isCorrect, judged, await this.remainingCount(studentId));
    }
    // CAS 落定：affectedRows=0 = 并发已答（双端点竞态），按「不在待练清单」拒绝
    const affected = await this.variationRepo.markAnswered(row.id, judged.isCorrect);
    if (affected === 0) throw new BadRequestException('该变式题不在待练清单或已作答');
    return this.assemble(judged.isCorrect, judged, await this.remainingCount(studentId));
  }

  /**
   * 主观题自评（变式内 `short_answer` / `proof`）。
   * **刻意不经 `judgeCore`**（镜像补偿套题裁决）：`recordSelfAssessment` 没有 variation 分支
   * 且会碰错题本；自评只做变式行落定，不入错题本/不清零/不发分。不写
   * `question_self_assessments` 留痕（镜像套题）；不校验题型（客户端驱动，镜像套题）。
   */
  async selfAssess(
    studentId: number,
    input: { questionId: number; assessment: 'correct' | 'incorrect' },
  ): Promise<VariationAnswerResult> {
    const row = await this.requirePending(studentId, input.questionId);
    const isCorrect = input.assessment === 'correct';
    const affected = await this.variationRepo.markAnswered(row.id, isCorrect);
    if (affected === 0) throw new BadRequestException('该变式题不在待练清单或已作答');
    return this.assemble(isCorrect, { method: 'self_assess' }, await this.remainingCount(studentId));
  }

  /** 取本人 pending 中该题的变式行；任一条件不满足即 400（不泄漏他人数据存在性）。 */
  private async requirePending(studentId: number, questionId: number): Promise<VariationQuestionRow> {
    const row = await this.variationRepo.findPendingByQuestion(studentId, questionId);
    if (!row) throw new BadRequestException('该变式题不在待练清单或已作答');
    return row;
  }

  private async remainingCount(studentId: number): Promise<number> {
    return (await this.variationRepo.findPendingByStudent(studentId)).length;
  }

  private assemble(
    isCorrect: boolean | null,
    judged: {
      method: string;
      errorType?: string | null;
      needsSelfAssessment?: boolean;
      referenceAnswer?: string | null;
      explanation?: string | null;
    },
    remainingCount: number,
  ): VariationAnswerResult {
    return {
      isCorrect,
      method: judged.method,
      errorType: judged.errorType ?? null,
      needsSelfAssessment: judged.needsSelfAssessment ?? false,
      referenceAnswer: judged.referenceAnswer ?? null,
      explanation: judged.explanation ?? null,
      remainingCount,
    };
  }
}
