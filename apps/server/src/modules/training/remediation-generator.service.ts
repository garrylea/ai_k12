import { Injectable, Logger } from '@nestjs/common';
import { QuestionsRepository } from '../../database/repositories/questions.repo.js';
import { KnowledgePointsRepository } from '../../database/repositories/knowledge-points.repo.js';
import { RemediationRepository } from '../../database/repositories/remediation.repo.js';
import { VariationCapability } from '../../ai-core/capabilities/variation.capability.js';
import { compareAnswer } from '../practice/judge-core.service.js';
import { computeContentHash } from '../../common/utils/content-hash.util.js';
import type { QuestionRow } from '../../database/repositories/types.js';
import type { Difficulty, VariationQuestion } from '../../ai-core/types.js';

export interface BuildGroupsResult {
  groupsCreated: number;
  itemsCreated: number;
  skippedNoKp: number;
  aiPendingCount: number;
}

const GROUP_SIZE = 3;
const MATH_SUBJECT_ID = 1;

/** DB 的 difficulty 是 SMALLINT（number），ai-core 的 Difficulty 是 1|2|3 字面量联合；
 *  套题难度来自原错题行，题库口径恒为 1–3，此处按边界收敛（不做静默放大）。 */
function toDifficulty(value: number): Difficulty {
  if (value <= 1) return 1;
  if (value >= 3) return 3;
  return 2;
}

@Injectable()
export class RemediationGeneratorService {
  private readonly logger = new Logger(RemediationGeneratorService.name);
  /** groupId -> 补题 promise（进程内去重；重启丢失由 retryPending 惰性重试兜底，spec §5.1） */
  private readonly inFlight = new Map<number, Promise<void>>();

  constructor(
    private readonly questionsRepo: QuestionsRepository,
    private readonly knowledgePointsRepo: KnowledgePointsRepository,
    private readonly remediationRepo: RemediationRepository,
    private readonly variation: VariationCapability,
  ) {}

  /** 同步建组：三元组去重 -> 题库抽题（放宽阶梯）-> 记录 AI 缺口。不调用 LLM，可安全 await。 */
  async buildGroups(studentId: number, setId: number, wrongs: QuestionRow[]): Promise<BuildGroupsResult> {
    const kpMap = await this.questionsRepo.findPrimaryKpIds(wrongs.map((q) => q.id));
    const seenTriples = new Set<string>();
    const existingItems = (await this.remediationRepo.findItemsBySet(setId)).map((i) => i.question_id);
    const result: BuildGroupsResult = { groupsCreated: 0, itemsCreated: 0, skippedNoKp: 0, aiPendingCount: 0 };

    for (const q of wrongs) {
      const kpId = kpMap.get(q.id);
      if (!kpId) {
        result.skippedNoKp++;
        continue; // 无 primary 考点标注，无法成组（spec §5.2）
      }
      const tripleKey = `${kpId}|${q.type}|${q.difficulty}`;
      if (seenTriples.has(tripleKey)) continue;
      const existingGroup = await this.remediationRepo.findGroupByTriple(setId, kpId, q.type, q.difficulty);
      if (existingGroup) {
        seenTriples.add(tripleKey);
        continue; // 追加合并去重（spec §2 决策 5）
      }
      seenTriples.add(tripleKey);

      const groupId = await this.createGroupOrSkip(setId, kpId, q);
      if (groupId === null) continue; // 撞唯一键 = 该三元组已有组（spec §2 决策 5）
      result.groupsCreated++;

      // 放宽阶梯：先同档，再 ±1 档（spec §5.2）
      const picked: number[] = [];
      for (const difficulties of [[q.difficulty], [q.difficulty - 1, q.difficulty + 1]] as number[][]) {
        if (picked.length >= GROUP_SIZE) break;
        const rows = await this.questionsRepo.findRandomByKpTypeDifficulty(
          studentId,
          MATH_SUBJECT_ID,
          kpId,
          q.type,
          difficulties,
          GROUP_SIZE - picked.length,
          [...existingItems, q.id, ...picked],
        );
        picked.push(...rows.map((r) => r.id));
      }

      const inserted = await this.remediationRepo.insertItems(groupId, picked);
      result.itemsCreated += inserted;
      existingItems.push(...picked);

      const shortfall = GROUP_SIZE - inserted;
      if (shortfall > 0) {
        await this.remediationRepo.updateGroupAiPending(groupId, shortfall);
        result.aiPendingCount += shortfall;
        this.fillWithAi(groupId, [...existingItems]);
      }
    }
    return result;
  }

  /**
   * 建组，撞唯一键 `uniq_rgroups_triple` 时按「已有组」处理（返回 null = 跳过该三元组）。
   *
   * 并发（双开 tab / 交卷与专项完成同时触发）下 findGroupByTriple 可能双双落空、双双 INSERT，
   * 后到者撞键。spec §2 决策 5：INSERT 撞键 = 该三元组已有组，跳过（不重复抽题、不重复计数）。
   */
  private async createGroupOrSkip(
    setId: number,
    kpId: number,
    q: QuestionRow,
  ): Promise<number | null> {
    try {
      return await this.remediationRepo.createGroup(setId, kpId, q.type, q.difficulty, q.id);
    } catch (err) {
      if ((err as { code?: string })?.code === 'ER_DUP_ENTRY') {
        this.logger.warn(
          `remediation group already exists (set=${setId}, kp=${kpId}, type=${q.type}, difficulty=${q.difficulty}): skip`,
        );
        return null;
      }
      throw err;
    }
  }

  /** AI 补题入口（fire-and-forget）：调用方绝不 await（LLM 无墙钟上限，spec §5.1）。 */
  fillWithAi(groupId: number, excludeQuestionIds: number[]): void {
    if (this.inFlight.has(groupId)) return;
    const promise = this.runAiFill(groupId, excludeQuestionIds)
      .catch((err) => {
        this.logger.warn(`remediation AI fill failed (group=${groupId}): ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        this.inFlight.delete(groupId);
      });
    this.inFlight.set(groupId, promise);
  }

  /** 惰性重试：active 套题里 ai_pending > 0 且无 in-flight 的组 = 进程重启悬挂（spec §5.1）。 */
  retryPending(setId: number): void {
    void this.remediationRepo
      .findGroupsBySet(setId)
      .then((groups) => {
        for (const g of groups) {
          if (g.ai_pending_count > 0 && !this.inFlight.has(g.id)) {
            this.fillWithAi(g.id, []);
          }
        }
      })
      .catch((err) => this.logger.warn(`retryPending failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  private async runAiFill(groupId: number, excludeQuestionIds: number[]): Promise<void> {
    const group = await this.remediationRepo.findGroupById(groupId);
    if (!group || group.ai_pending_count <= 0) return;

    const origin = await this.questionsRepo.findById(group.origin_question_id);
    const kp = await this.knowledgePointsRepo.findById(group.kp_id);
    if (!origin || !kp) {
      // 原题/考点已下线：维持题库抽到的题，清缺口
      await this.remediationRepo.updateGroupAiPending(groupId, 0);
      return;
    }

    const shortfall = group.ai_pending_count;
    let filled = 0;
    let rejected = 0;
    try {
      const res = await this.variation.generate({
        originalQuestion: {
          content: origin.content,
          answer: origin.answer,
          difficulty: toDifficulty(origin.difficulty),
        },
        knowledgePoint: { id: String(group.kp_id), name: kp.name },
        count: group.ai_pending_count,
        targetDifficulty: toDifficulty(group.difficulty),
      });

      // 当前套题已占用的题（防止生成题与在套题重复）
      const setItems = await this.remediationRepo.findItemsBySet(group.set_id);
      const existing = new Set([...excludeQuestionIds, ...setItems.map((i) => i.question_id)]);

      for (const v of res.variations) {
        const reason = this.variationRejectionReason(v, group.type);
        if (reason) {
          rejected++;
          // 校验不通过：不入库、不入套题（spec §5.3），留日志便于事后定位被丢弃的题
          this.logger.warn(
            `remediation variation rejected (group=${group.id}, kp=${group.kp_id}, type=${group.type}, variationType=${v.variationType}): ${reason}`,
          );
          continue;
        }
        const { id, created } = await this.questionsRepo.findOrCreate({
          subject_id: MATH_SUBJECT_ID,
          type: group.type,
          difficulty: group.difficulty,
          content: v.content,
          // 选项只存 label/text，**绝不存 isCorrect**（防答案泄漏；spec 关键铁律）
          options: v.options ? JSON.stringify(v.options.map(({ label, text }) => ({ label, text }))) : null,
          answer: v.answer,
          explanation: v.explanation,
          source: 'remediation',
          content_hash: computeContentHash(v.content),
        });
        if (existing.has(id)) continue;
        await this.remediationRepo.insertItems(group.id, [id]);
        // 撞 hash 复用已有题时不再挂 primary：同题可挂多个 primary 会让 findPrimaryKpIds
        // 的取值随行序漂移（分组不确定）。只有新入库的题才需要补挂考点。
        if (created) await this.questionsRepo.bindKnowledgePoint(id, group.kp_id, 'primary');
        existing.add(id);
        filled++;
      }
    } finally {
      // 缺口清零处留一条「缺口 X → 实补 Y」日志（spec §5.3）
      this.logger.log(
        `remediation AI fill (group=${groupId}): 缺口 ${shortfall} → 实补 ${filled}（校验拒绝 ${rejected}）`,
      );
      // 无论成败都清缺口（spec §5.3）：失败则维持题库抽到的题；悬挂重试只管进程重启场景
      await this.remediationRepo.updateGroupAiPending(groupId, 0);
    }
  }

  /** 轻校验（spec §5.3）：返回拒绝原因，null = 通过。 */
  private variationRejectionReason(v: VariationQuestion, type: string): string | null {
    if (!v.content.trim()) return '题干为空';
    if (!v.answer.trim()) return '无可解答案';
    if (type === 'choice') {
      if (!Array.isArray(v.options) || v.options.length < 2) {
        return `choice 选项不足 2 个（实际 ${v.options?.length ?? 0}）`;
      }
      // 有且仅有一个正确选项：多个/零个都会让判题（choice 走程序比对）行为不确定
      const correct = v.options.filter((o) => o.isCorrect === true);
      if (correct.length !== 1) {
        return `choice 正确选项应恰有 1 个（实际 ${correct.length}）`;
      }
      // 答案与正确选项一致：与 judge-core.compareAnswer 同口径（归一化后比对）——
      // 命中正确选项的 label，或命中其 text（题库 choice 题答案常直接写选项文本）。
      const optsJson = JSON.stringify(v.options);
      if (
        !compareAnswer(v.answer, correct[0].label, optsJson) &&
        !compareAnswer(v.answer, correct[0].text, optsJson)
      ) {
        return `choice 答案与正确选项不一致（answer=${v.answer}，正确项 ${correct[0].label}）`;
      }
    }
    return null;
  }
}
