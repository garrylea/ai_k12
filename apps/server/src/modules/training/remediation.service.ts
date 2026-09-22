import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { AwardResult } from '../points/points.service.js';
import { PointsService } from '../points/points.service.js';
import { JudgeCoreService } from '../practice/judge-core.service.js';
import { RemediationRepository } from '../../database/repositories/remediation.repo.js';
import { QuestionsRepository } from '../../database/repositories/questions.repo.js';
import { MainErrorBooksRepository } from '../../database/repositories/main-error-books.repo.js';
import { ExamSessionsRepository } from '../../database/repositories/exam-sessions.repo.js';
import { TrainingSessionsRepository } from '../../database/repositories/training-sessions.repo.js';
import { RemediationGeneratorService } from './remediation-generator.service.js';
import type { QuestionRow } from '../../database/repositories/types.js';
import type { RemediationItemRow, RemediationSetRow } from '../../database/repositories/remediation.repo.js';

/** 首期恒数学（与生成器、专项抽题同口径）。 */
const MATH_SUBJECT_ID = 1;

export interface GenerateRemediationInput {
  source: 'exam' | 'targeted';
  sessionId: number;
  wrongQuestionIds?: number[];
}

export interface GenerateRemediationResult {
  /** 0 = 本次没有可生成的错题（未建套题）；其余为 active 套题 id。 */
  setId: number;
  groupsCreated: number;
  itemsCreated: number;
  skippedNoKp: number;
  aiPendingCount: number;
}

export interface RemediationOverviewDto {
  active: boolean;
  setId: number | null;
  groupCount: number;
  itemCount: number;
  correctCount: number;
}

export interface RemediationQuestionDto {
  questionId: number;
  text: string;
  type: string;
  options: Array<{ label: string; text: string }> | null;
}

export interface RemediationQuestionsDto {
  questions: RemediationQuestionDto[];
  itemCount: number;
  correctCount: number;
}

export interface SubmitRemediationAnswerInput {
  questionId: number;
  studentAnswer: string;
}

export interface RemediationAnswerResult {
  isCorrect: boolean | null;
  method: string;
  errorType: string | null;
  needsSelfAssessment: boolean;
  referenceAnswer: string | null;
  explanation: string | null;
  points: AwardResult | null;
  setCompleted: boolean;
  remainingCount: number;
}

/**
 * 错题补偿套题编排服务（spec §5–§7）。
 *
 * 职责边界：
 * - **建组/抽题/AI 补题** 全在 `RemediationGeneratorService`（本类只负责取错题 + 套题生命周期）；
 * - **判题** 复用 `JudgeCoreService.judgeQuestion`，来源恒为 `'remediation'`
 *   → 套题自清零：不入错题本、不清零原错题、不发 `error_fix`（spec §6/§8）；
 * - **主观题自评** 走本类 `selfAssess`，**刻意不经 `judgeCore`**（Task 4 复核遗留裁决）：
 *   直接 `requireItem` + `applyOutcome`，因此套题内自评同样不入错题本/不清零/不发 error_fix。
 *
 * 铁律：积分与掌握度都是派生数据，**写入失败只 warn，绝不阻断判题主链路**。
 */
@Injectable()
export class RemediationService {
  private readonly logger = new Logger(RemediationService.name);

  constructor(
    private readonly remediationRepo: RemediationRepository,
    private readonly questionsRepo: QuestionsRepository,
    private readonly mainErrorRepo: MainErrorBooksRepository,
    private readonly examSessionsRepo: ExamSessionsRepository,
    private readonly trainingSessionsRepo: TrainingSessionsRepository,
    private readonly generator: RemediationGeneratorService,
    private readonly judgeCore: JudgeCoreService,
    private readonly pointsService: PointsService,
  ) {}

  /** 题型 -> 积分档位（spec §7）：choice/true_false -> choice；fill_blank -> fill_blank；其余 -> major。 */
  private static tierKeyOf(type: string): 'choice' | 'fill_blank' | 'major' {
    if (type === 'choice' || type === 'true_false') return 'choice';
    if (type === 'fill_blank') return 'fill_blank';
    return 'major';
  }

  /**
   * 学生同意后生成套题：**同步**建组 + 题库抽题，AI 补题在生成器内 fire-and-forget（spec §5.1）。
   *
   * 无错题 → 返回全 0 概要且**不建套题**（避免留下 0 题的 active 空套题）。
   * 已有 active 套题 → 复用其 id 追加合并（`remediation_groups` 唯一键负责三元组去重）。
   */
  async generate(studentId: number, input: GenerateRemediationInput): Promise<GenerateRemediationResult> {
    const wrongIds = input.source === 'exam'
      ? await this.examWrongIds(studentId, input.sessionId)
      : await this.targetedWrongIds(studentId, input.sessionId, input.wrongQuestionIds ?? []);

    if (wrongIds.length === 0) {
      return { setId: 0, groupsCreated: 0, itemsCreated: 0, skippedNoKp: 0, aiPendingCount: 0 };
    }

    // findByIds 只回 is_active=1 的题：已下线错题不进套题（否则套题内永远答不了 → 死锁）
    const wrongs = await this.questionsRepo.findByIds(wrongIds);
    let setId = (await this.remediationRepo.findActiveByStudent(studentId, MATH_SUBJECT_ID))?.id ?? null;
    if (setId === null) {
      setId = await this.remediationRepo.createSet(studentId, MATH_SUBJECT_ID);
    }
    const summary = await this.generator.buildGroups(studentId, setId, wrongs);
    return { setId, ...summary };
  }

  /** 真题考试错题：会话必须属于本人且已交卷（`is_correct === 0`；null = 在途未判，不算）。 */
  private async examWrongIds(studentId: number, sessionId: number): Promise<number[]> {
    const session = await this.examSessionsRepo.findById(sessionId);
    if (!session || session.student_id !== studentId) throw new NotFoundException('考试会话不存在');
    if (session.status !== 'submitted') throw new BadRequestException('考试尚未交卷');
    const answers = await this.examSessionsRepo.findAnswersBySession(sessionId);
    return answers.filter((a) => a.is_correct === 0).map((a) => a.question_id);
  }

  /**
   * 数学专项错题：前端提交题号**不可信**，逐个回查错题本，只认 `source === 'targeted'`
   * 的未清错题（防伪造题号刷分；spec §5.1）。
   */
  private async targetedWrongIds(studentId: number, sessionId: number, wrongQuestionIds: number[]): Promise<number[]> {
    const session = await this.trainingSessionsRepo.findById(sessionId);
    if (!session || session.student_id !== studentId || session.task_code !== 'math_targeted') {
      throw new NotFoundException('专项练习会话不存在');
    }
    const ids: number[] = [];
    for (const qid of new Set(wrongQuestionIds)) {
      const entry = await this.mainErrorRepo.findUnclearedByStudentQuestionId(studentId, qid);
      if (entry && entry.source === 'targeted') ids.push(qid);
    }
    return ids;
  }

  /** active 套题概要（三卡页提示条用）；顺带做 AI 补题悬挂的惰性重试（spec §5.1）。 */
  async getOverview(studentId: number): Promise<RemediationOverviewDto> {
    const set = await this.remediationRepo.findActiveByStudent(studentId, MATH_SUBJECT_ID);
    if (!set) return { active: false, setId: null, groupCount: 0, itemCount: 0, correctCount: 0 };
    const [groups, items] = await Promise.all([
      this.remediationRepo.findGroupsBySet(set.id),
      this.remediationRepo.findItemsBySet(set.id),
    ]);
    // 惰性重试：ai_pending_count > 0 且无 in-flight = 进程重启悬挂（fire-and-forget，不 await）
    this.generator.retryPending(set.id);
    return {
      active: true,
      setId: set.id,
      groupCount: groups.length,
      itemCount: items.length,
      correctCount: items.filter((i) => i.is_correct === 1).length,
    };
  }

  /** 作答页拉取：只给未答对的题（含渲染数据）。 */
  async listQuestions(studentId: number): Promise<RemediationQuestionsDto> {
    const set = await this.remediationRepo.findActiveByStudent(studentId, MATH_SUBJECT_ID);
    if (!set) return { questions: [], itemCount: 0, correctCount: 0 };

    const items = await this.remediationRepo.findItemsBySet(set.id);
    let pending = items.filter((i) => i.is_correct === 0);

    if (pending.length === 0) {
      // 全对兜底清套：正常情况下由 submitAnswer / selfAssess 清，但存在并发与外键窗口
      // （例如题目被下线后由本次调用批量标对）——学生一访问作答页即收口，不留死套题。
      await this.remediationRepo.deleteSet(set.id);
      return { questions: [], itemCount: items.length, correctCount: items.length };
    }

    const rows = await this.questionsRepo.findByIds(pending.map((i) => i.question_id));
    const byId = new Map(rows.map((r) => [r.id, r]));

    // 题目被下线（is_active=0）则永远答不了——直接标对，防套题死锁
    for (const item of pending) {
      if (!byId.has(item.question_id)) {
        await this.remediationRepo.markItemCorrect(item.id);
      }
    }
    pending = pending.filter((i) => byId.has(i.question_id));
    const correctCount = items.length - pending.length;

    const questions = pending.map((i) => {
      const q = byId.get(i.question_id)!;
      return {
        questionId: q.id,
        text: q.content,
        type: q.type,
        options: q.options ? (JSON.parse(q.options) as Array<{ label: string; text: string }>) : null,
      };
    });

    return { questions, itemCount: items.length, correctCount };
  }

  /** 逐题提交：判题走 `JudgeCoreService`（`source='remediation'`），出口统一走 `applyOutcome`。 */
  async submitAnswer(studentId: number, input: SubmitRemediationAnswerInput): Promise<RemediationAnswerResult> {
    const ctx = await this.requireItem(studentId, input.questionId);
    const judged = await this.judgeCore.judgeQuestion({
      studentId,
      subjectId: MATH_SUBJECT_ID,
      questionId: input.questionId,
      studentAnswer: input.studentAnswer,
      source: 'remediation',
    });
    return this.applyOutcome(ctx, judged.isCorrect, judged);
  }

  /**
   * 主观题自评（套题内 `short_answer` / `proof`）。
   *
   * **刻意不经 `judgeCore`**（Task 4 复核遗留裁决）：`recordSelfAssessment` 没有 remediation
   * 分支，但本路径不需要它 —— 自评只做「套题自清零」（置 `is_correct` / 发分 / 全对清套），
   * 不入错题本、不清零原错题、不发 `error_fix`。有回归钉子用例钉着「不调 judgeQuestion」。
   */
  async selfAssess(
    studentId: number,
    input: { questionId: number; assessment: 'correct' | 'incorrect' },
  ): Promise<RemediationAnswerResult> {
    const ctx = await this.requireItem(studentId, input.questionId);
    return this.applyOutcome(ctx, input.assessment === 'correct', { method: 'self_assess' });
  }

  /** 取「本人在 active 套题里且尚未答对」的条目；任一条件不满足即 400（不泄漏他人套题存在性）。 */
  private async requireItem(
    studentId: number,
    questionId: number,
  ): Promise<{ set: RemediationSetRow; item: RemediationItemRow }> {
    const set = await this.remediationRepo.findActiveByStudent(studentId, MATH_SUBJECT_ID);
    if (!set) throw new BadRequestException('当前没有进行中的相似题专项练习');
    const item = await this.remediationRepo.findItemBySetQuestion(set.id, questionId);
    if (!item) throw new BadRequestException('该题不在当前套题中');
    if (item.is_correct === 1) throw new BadRequestException('该题已答对，无需重复作答');
    return { set, item };
  }

  /**
   * 作答出口：记尝试 → 置对错 → 首答发分 → 全对清套 → 算剩余。
   *
   * **发分顺序（用户裁决）**：`award` 成功之后才置 `points_awarded=1`，两步都在 try 内。
   * 反过来（先置标记再发分）时，award 一旦抖动标记已置 1 → 该题**永久拿不到分**；
   * 且 DB 失败会让 `submitAnswer` 在判题之后抛错（积分写入不得阻断主链路）。
   * 这里 award 失败则跳过置标记，下次作答仍会尝试，由 `dedupeKey` 幂等兜底
   *（`PointsService` 命中重复时返回 `reason: 'duplicate'`，不会重复入账）。
   */
  private async applyOutcome(
    ctx: { set: RemediationSetRow; item: RemediationItemRow },
    isCorrect: boolean | null,
    judged: {
      method: string;
      errorType?: string | null;
      needsSelfAssessment?: boolean;
      referenceAnswer?: string | null;
      explanation?: string | null;
    },
  ): Promise<RemediationAnswerResult> {
    const { set, item } = ctx;
    await this.remediationRepo.recordAttempt(item.id);
    if (isCorrect === true) await this.remediationRepo.markItemCorrect(item.id);

    // 首答即发分（不看对错，每题一次；spec §7）——积分失败绝不影响判题结果
    let points: AwardResult | null = null;
    if (item.points_awarded === 0) {
      const q = await this.questionsRepo.findById(item.question_id);
      if (q) {
        try {
          points = await this.pointsService.award({
            studentId: set.student_id,
            taskCode: 'remediation_question',
            tierKey: RemediationService.tierKeyOf(q.type),
            dedupeKey: `rem:${item.id}`, // 不带日期：每题全程只发一次（spec §7）
            refType: 'question',
            refId: item.question_id,
          });
          // 发分成功后才置标记；若这一步失败，下次仍会尝试 award，
          // 由 dedupeKey 幂等兜底（PointsService 返回 duplicate、不会重复入账）。
          await this.remediationRepo.markPointsAwarded(item.id);
        } catch (err) {
          this.logger.warn(`remediation award failed (item=${item.id}): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    let setCompleted = false;
    if (isCorrect === true) {
      const items = await this.remediationRepo.findItemsBySet(set.id);
      if (items.every((i) => i.is_correct === 1)) {
        await this.remediationRepo.deleteSet(set.id);
        setCompleted = true;
      }
    }

    const remainingCount = setCompleted
      ? 0
      : (await this.remediationRepo.findItemsBySet(set.id)).filter((i) => i.is_correct === 0).length;

    return {
      isCorrect,
      method: judged.method,
      errorType: judged.errorType ?? null,
      needsSelfAssessment: judged.needsSelfAssessment ?? false,
      referenceAnswer: judged.referenceAnswer ?? null,
      explanation: judged.explanation ?? null,
      points,
      setCompleted,
      remainingCount,
    };
  }
}
