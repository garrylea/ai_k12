import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { QuestionsRepository } from '../../database/repositories/questions.repo.js';
import { KnowledgePointsRepository } from '../../database/repositories/knowledge-points.repo.js';
import { TrainingSessionsRepository } from '../../database/repositories/training-sessions.repo.js';
import { VariationCapability } from '../../ai-core/capabilities/variation.capability.js';
import { PointRulesService } from '../points/point-rules.service.js';
import { parseOptions } from '../../common/utils/parse-options.util.js';
import { targetedTaskCode } from '../../common/subject-config.js';
import { toDifficulty } from './variation-question.util.js';

/** 历史题重做/同类型练习的运行态题目载荷：**白名单**，绝不含 answer / explanation。 */
export interface HistoryRunQuestion {
  questionId: number;
  text: string;
  type: string;
  options: unknown[] | null;
  materialText: string | null;
}

/** 同类型练习结果：`sessionId` 为 null = 本轮不参与发分（题不够 / 无可用档位 / 建会话失败）。 */
export interface SimilarPracticeResult {
  questions: HistoryRunQuestion[];
  sessionId: number | null;
  title: string;
}

/**
 * 练习记录里的「再做一次」（Task 5，2026-11-06）与「同类型练习」（Task 6）。
 *
 * 重做**不建任何会话/作答记录、不发分**：只把原题回放给学生再练一遍。
 * 同类型从题库抽同考点/同题型/同难度的题（Task 7 才接 AI 补题），按学生可用档位建
 * `training_sessions`，由答题页收尾 complete 发分。
 */
@Injectable()
export class HistoryPracticeService {
  private readonly logger = new Logger(HistoryPracticeService.name);

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
    return this.toRunQuestion(q);
  }

  /**
   * 同类型练习（题库抽题版；AI 补题在 Task 7 接入）。
   *
   * 抽题：同 subject/kp/type/difficulty 先取，缺口再用难度阶梯 [d-1,d,d+1] 补齐。
   * 题库方法本身已排除「不再展示」、下架、空答案；这里只额外排除种子题与已选。
   *
   * 发分：`tier_key` 取「可用档位 ∩ {1,2,3,5} ∩ ≤ 实际题数」里最大的一个；
   * 一题没抽到、或没有可用档位 → 不建会话（0 题会话也能 complete 拿整档分，是白送分的口子）。
   * 建会话失败只丢这一轮积分，**绝不 500 掉练习**（与 startTargetedPractice 同口径）。
   */
  async startSimilar(input: {
    studentId: number; subjectId: number; questionId: number; count: number;
  }): Promise<SimilarPracticeResult> {
    if (input.subjectId !== 1 && input.subjectId !== 4) {
      throw new BadRequestException('该学科暂不支持同类型练习');
    }
    if (![1, 2, 3, 5].includes(input.count)) {
      throw new BadRequestException('题量仅允许 1 / 2 / 3 / 5');
    }
    const taskCode = targetedTaskCode(input.subjectId);
    const allowed = await this.pointRules.listTierKeys(input.studentId, taskCode);
    if (!allowed.includes(String(input.count))) {
      throw new BadRequestException(`题量仅允许 ${allowed.join(' | ')}`);
    }

    const seed = await this.questionsRepo.findById(input.questionId);
    if (!seed || seed.is_active !== 1) throw new BadRequestException('题目已下架');
    if (seed.subject_id !== input.subjectId) throw new BadRequestException('题目不属于该学科');
    if (!seed.answer) throw new BadRequestException('题目没有标准答案');
    const kpId = (await this.questionsRepo.findKpIdsByQuestionIds([seed.id])).get(seed.id);
    if (kpId == null) throw new BadRequestException('题目没有知识点');
    const kp = await this.kpRepo.findById(kpId);
    if (!kp) throw new BadRequestException('知识点不存在');

    const picked = await this.questionsRepo.findRandomByKpTypeDifficulty(
      input.studentId, input.subjectId, kpId, seed.type,
      [toDifficulty(seed.difficulty)], input.count, [seed.id],
    );
    let selected: HistoryRunQuestion[] = picked.map((q) => this.toRunQuestion(q));

    if (selected.length < input.count) {
      const ladder = [...new Set(
        [seed.difficulty - 1, seed.difficulty, seed.difficulty + 1]
          .filter((d) => d >= 1 && d <= 3)
          .map((d) => toDifficulty(d)),
      )];
      const more = await this.questionsRepo.findRandomByKpTypeDifficulty(
        input.studentId, input.subjectId, kpId, seed.type, ladder,
        input.count - selected.length,
        [seed.id, ...picked.map((q) => q.id)],
      );
      selected = [...selected, ...more.map((q) => this.toRunQuestion(q))];
    }

    const actual = selected.length;
    if (actual === 0) {
      return { questions: [], sessionId: null, title: `同类练习：${kp.name} · 0 题` };
    }

    const allowedCounts = [1, 2, 3, 5].filter((n) => allowed.includes(String(n)));
    const tier = allowedCounts.filter((n) => n <= actual).sort((a, b) => b - a)[0];
    let sessionId: number | null = null;
    if (tier != null) {
      try {
        sessionId = await this.trainingSessionsRepo.create({
          student_id: input.studentId,
          task_code: taskCode,
          subject_id: input.subjectId,
          tier_key: String(tier),
          expected_count: actual,
          ref_type: 'question',
          ref_id: null,
        });
      } catch (err) {
        this.logger.warn(
          `training_sessions.create failed (history similar, student=${input.studentId}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return { questions: selected, sessionId, title: `同类练习：${kp.name} · ${actual} 题` };
  }

  /** DB 题行 → 运行态白名单载荷（不含 answer/explanation）。 */
  private toRunQuestion(q: {
    id: number; content: string; type: string; options: string | null; material_text: string | null;
  }): HistoryRunQuestion {
    return {
      questionId: q.id,
      text: q.content,
      type: q.type,
      options: parseOptions(q.options),
      materialText: q.material_text ?? null,
    };
  }
}
