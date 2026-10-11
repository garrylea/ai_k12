import { Injectable, Logger } from '@nestjs/common';
import { QuestionsRepository } from '../../database/repositories/questions.repo.js';
import { KnowledgePointsRepository } from '../../database/repositories/knowledge-points.repo.js';
import { MainErrorBooksRepository } from '../../database/repositories/main-error-books.repo.js';
import { VariationQuestionsRepository } from '../../database/repositories/variation-questions.repo.js';
import { VariationCapability } from '../../ai-core/capabilities/variation.capability.js';
import { computeContentHash } from '../../common/utils/content-hash.util.js';
import { toDifficulty, toStoredAnswer, variationRejectionReason } from './variation-question.util.js';

const MATH_SUBJECT_ID = 1;
const VARIATION_COUNT = 2;

/**
 * 错题升级 → 变式生成（PRD §7.10，2026-10-11）。
 *
 * 触发：仅训练轨错题重做收尾的 `POST /api/training/bump-error-levels`
 * （TrainingService.bumpErrorLevels 内逐 id fire-and-forget；主线 CleanupPhase 的
 * practice 版 bump 不经此处，天然不触发）。
 *
 * 口径（用户裁决 2026-10-11）：
 * - 同一道错题**再次做错升级**时为该原题生成 2 道变式（PRD 1-2 道取上限）；
 * - **已有 pending（未作答）变式的条目不再重复生成**（DB 层 + 进程内双重去重）；
 * - 生成产物与补偿套题同口径入库 questions（source='variation'），但套题三表不混用，
 *   记录落在 variation_questions（validator_passed=1 = 轻校验通过）。
 */
@Injectable()
export class VariationGeneratorService {
  private readonly logger = new Logger(VariationGeneratorService.name);
  /** errorItemId -> 生成 promise（进程内去重；失败不留行，下次升级自然重试） */
  private readonly inFlight = new Map<number, Promise<void>>();

  constructor(
    private readonly mainErrorRepo: MainErrorBooksRepository,
    private readonly questionsRepo: QuestionsRepository,
    private readonly knowledgePointsRepo: KnowledgePointsRepository,
    private readonly variationRepo: VariationQuestionsRepository,
    private readonly variation: VariationCapability,
  ) {}

  /**
   * 为一条错题条目生成变式（fire-and-forget）：调用方一律写 `void ...generateForErrorItem(...)`
   * 保留不 await 语义（LLM 无墙钟上限，镜像 fillWithAi 的返回 promise + 钉子模式）。
   * 任何一步不满足条件都只留日志，**绝不抛出**到 bump 链路。
   */
  generateForErrorItem(errorItemId: number, studentId: number): Promise<void> {
    const existing = this.inFlight.get(errorItemId);
    if (existing) return existing;
    const promise = this.run(errorItemId, studentId)
      .catch((err) => {
        this.logger.warn(
          `variation generate failed (errorItem=${errorItemId}, student=${studentId}): ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        this.inFlight.delete(errorItemId);
      });
    this.inFlight.set(errorItemId, promise);
    return promise;
  }

  private async run(errorItemId: number, studentId: number): Promise<void> {
    // 1. 错题条目：归属校验（errorBookId 来自客户端，不可信）+ 清零/孤儿过滤
    const meb = await this.mainErrorRepo.findById(errorItemId);
    if (!meb || meb.student_id !== studentId) return; // 不存在 / 非本人：静默
    if (meb.is_cleared === 1) return; // 已清零不生成
    if (meb.question_id == null) {
      this.logger.warn(`variation generate skipped (errorItem=${errorItemId}): 无关联题目（孤儿条目）`);
      return;
    }

    // 2. pending 去重（DB 层兜底：inFlight 只盖进程内并发）
    if (await this.variationRepo.hasPendingByErrorItem(errorItemId)) return;

    // 3. 原题：下线 / 空答案 / true_false（答案归一未实现，见 variation-question.util 注释）
    const q = await this.questionsRepo.findById(meb.question_id);
    if (!q) return;
    if (!q.answer?.trim()) {
      this.logger.warn(`variation generate skipped (errorItem=${errorItemId}): 原题无标准答案`);
      return;
    }
    if (q.type === 'true_false') {
      this.logger.warn(`variation generate skipped (errorItem=${errorItemId}): true_false 答案归一未实现`);
      return;
    }

    // 4. primary 考点锚定变式方向
    const kpId = (await this.questionsRepo.findPrimaryKpIds([q.id])).get(q.id);
    if (!kpId) {
      this.logger.warn(`variation generate skipped (errorItem=${errorItemId}, question=${q.id}): 无 primary 考点`);
      return;
    }
    const kp = await this.knowledgePointsRepo.findById(kpId);
    if (!kp) return;

    // 5. LLM 生成（同难度或略降由 capability 内部处理）
    const res = await this.variation.generate({
      originalQuestion: {
        content: q.content,
        answer: q.answer,
        difficulty: toDifficulty(q.difficulty),
      },
      knowledgePoint: { id: String(kpId), name: kp.name },
      count: VARIATION_COUNT,
      targetDifficulty: toDifficulty(q.difficulty),
    });

    // 6-9. 逐条轻校验 + 入库（口径与补偿套题一致：剥 isCorrect / choice answer 归一 / created 才挂 KP）
    let inserted = 0;
    for (const v of res.variations) {
      const reason = variationRejectionReason(v, q.type);
      // 防呆：AI 把原题原样吐回来（同 content_hash）视为无效变式
      const sameAsOriginal = computeContentHash(v.content) === q.content_hash;
      if (reason || sameAsOriginal) {
        this.logger.warn(
          `variation rejected (errorItem=${errorItemId}, kp=${kpId}, type=${q.type}${sameAsOriginal ? ', 与原题同文' : ''}): ${reason ?? '原题回显'}`,
        );
        continue;
      }
      const { id, created } = await this.questionsRepo.findOrCreate({
        subject_id: MATH_SUBJECT_ID,
        type: q.type,
        difficulty: q.difficulty,
        content: v.content,
        // 选项只存 label/text，绝不存 isCorrect（防答案泄漏；与套题同铁律）
        options: v.options ? JSON.stringify(v.options.map(({ label, text }) => ({ label, text }))) : null,
        answer: toStoredAnswer(v, q.type),
        explanation: v.explanation,
        source: 'variation',
        content_hash: computeContentHash(v.content),
      });
      if (created) await this.questionsRepo.bindKnowledgePoint(id, kpId, 'primary');
      await this.variationRepo.insert({
        original_error_item_id: errorItemId,
        error_book_type: 'main',
        student_id: studentId,
        question_id: id,
        difficulty: q.difficulty,
        validator_passed: 1,
      });
      inserted++;
    }
    this.logger.log(`variation generated (errorItem=${errorItemId}, student=${studentId}): 请求 ${VARIATION_COUNT} → 入库 ${inserted}`);
  }
}
