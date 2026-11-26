import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { EventsService } from '../analytics/events.service.js';
import { PointsService } from '../points/points.service.js';
import {
  MainErrorBooksRepository,
  QuestionSelfAssessmentsRepository,
  QuestionsRepository,
  SpecialAnswerRecordsRepository,
  SpecialPracticeSessionsRepository,
  StudentKnowledgeMasteryRepository,
} from '../../database/repositories/index.js';
import type { SpecialSessionModule } from '../../database/repositories/special-practice-sessions.repo.js';

/**
 * 未作答占位行判据（spec §4.1）：ensurePlannedQuestions 为整轮题单写的空行，
 * answer_text/is_correct/method/self_assess_state 四列全 NULL，绝不能当作「已提交」。
 */
function isPlaceholderRow(row: {
  self_assess_state: string | null;
  answer_text: string | null;
  is_correct: number | null;
  method: string | null;
}): boolean {
  return row.self_assess_state == null && row.answer_text == null
    && row.is_correct == null && row.method == null;
}

/** 主观题首次提交：判题路由先按「默认错」回包，由本服务在一个事务里落库。 */
export interface SubmitDefaultIncorrectInput {
  studentId: number;
  subjectId: number;
  questionId: number;
  answerText: string;
  source: 'targeted' | 'error_practice';
  sessionUid: string;
  session: { module: SpecialSessionModule; title: string | null; questionCount: number };
  questionOrder: number;
}

/**
 * 自评结算服务（2026-11-26 默认错 + 事务结算）。
 *
 * 首次提交：单连接事务内写会话 → 作答行 is_correct=0 / self_assess_state=default_incorrect
 * → 错题本 find-or-create → 每个 KP 掌握度 error+1。**不写自评留痕**（qsa），
 * 留痕是旧「看答案后自评」语义，本案已取消。
 *
 * 幂等与并发：findForUpdate 在事务内锁作答行；同答案重复提交直接提交返回（不重复写），
 * 并从既有未清错题取 errorBookId；不同答案/已确认状态一律 409（P1 回退改答案不可静默跳题）。
 *
 * ⚠️ 事务内任何 SQL 异常必须 rollback 并原样冒泡（catch 里不吞、不 warn），
 * 由 Nest 统一映射 5xx；不要调用吞异常的 MasteryService.revertErrorToCorrect。
 */
@Injectable()
export class SelfAssessmentSettlementService {
  private readonly logger = new Logger(SelfAssessmentSettlementService.name);

  constructor(
    @Inject('DATABASE_POOL') private pool: Pool,
    private sessions: SpecialPracticeSessionsRepository,
    private answers: SpecialAnswerRecordsRepository,
    private errorBooks: MainErrorBooksRepository,
    private questions: QuestionsRepository,
    private mastery: StudentKnowledgeMasteryRepository,
    private selfAssess: QuestionSelfAssessmentsRepository,
    private readonly events?: EventsService,
    // 本服务刻意不发 error_fix 积分；保留注入供测试守卫“任何分支都不会误调 award”。
    private readonly points?: PointsService,
  ) {}

  async submitDefaultIncorrect(input: SubmitDefaultIncorrectInput): Promise<{ sessionId: number; errorBookId: number }> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const sessionId = await this.sessions.upsertSession({
        sessionUid: input.sessionUid,
        studentId: input.studentId,
        subjectId: input.subjectId,
        module: input.session.module,
        title: input.session.title,
        questionCount: input.session.questionCount,
      }, conn);

      const existing = await this.answers.findForUpdate(sessionId, input.questionId, conn);
      if (existing) {
        if (isPlaceholderRow(existing)) {
          // 同会话先客观题（plannedQuestionIds）写过占位行：占位=未作答，不是已提交。
          // 在锁住的行上认领为默认错，再照常走错题本 + 掌握度 error+1，不抛 409。
          await this.answers.claimPlaceholderAsDefaultIncorrect(
            sessionId, input.questionId, input.answerText, conn,
          );
        } else if (existing.self_assess_state === 'default_incorrect' && existing.answer_text === input.answerText) {
          // 幂等重复提交：不重复 error+1 / 错题本；errorBookId 取既有未清行（无则 0）
          const old = await this.errorBooks.findUnclearedByStudentQuestionId(
            input.studentId, input.questionId, conn,
          );
          await conn.commit();
          return { sessionId, errorBookId: old?.id ?? 0 };
        } else {
          throw new HttpException({ code: 1001, message: '该题已有不同作答或已确认' }, 409);
        }
      } else {
        await this.answers.insertDefaultIncorrect({
          sessionId,
          questionId: input.questionId,
          questionOrder: input.questionOrder,
          answerText: input.answerText,
          method: 'self_assess',
        }, conn);
      }

      const errorBookId = await this.errorBooks.findOrCreateUncleared({
        studentId: input.studentId,
        subjectId: input.subjectId,
        questionId: input.questionId,
        source: input.source,
        sourceRefId: null,
      }, conn);

      // 掌握度按题挂载的每个 KP 各 error+1（读 KP 无事务 executor，读操作不写库）
      const kpIds = await this.questions.findKnowledgePointIdsByQuestion(input.questionId);
      for (const kpId of kpIds) {
        await this.mastery.upsertOnJudge(input.studentId, kpId, false, conn);
      }

      await conn.commit();
      return { sessionId, errorBookId };
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  /**
   * 自评结算：点「我做对了」（correct）时在同一连接事务内留痕 → 清错题 →
   * 逐 KP 回退掌握度 → 作答行迁移到 confirmed_correct；不发 error_fix 积分。
   *
   * 幂等/冲突：confirmed_correct 直接提交返回幂等成功；confirmed_incorrect 409。
   * ⚠️ 掌握度回退必须直接调 masteryRepo.revertOneError(..., conn) 并让异常冒泡 rollback，
   * 0 行只 warn；绝不能调吞异常的 MasteryService.revertErrorToCorrect。
   */
  async confirmSelfAssessment(input: {
    studentId: number; subjectId: number; questionId: number;
    assessment: 'correct' | 'incorrect';
    source: string; sessionUid: string;
  }): Promise<{ errorBookId?: number; idempotent?: boolean }> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const sessionId = await this.sessions.findIdByUid(input.sessionUid, input.studentId, conn);
      const row = await this.answers.findForUpdate(sessionId, input.questionId, conn);
      if (!row) throw new HttpException({ code: 1002, message: '作答记录不存在或已失效，请重新提交' }, 409);
      const state = row.self_assess_state;
      // 迁移前旧行（spec §4.5）：没有 self_assess_state 的专项作答行，首次收到带 uid 的
      // 自评时按旧语义补做副作用，成功后补写终态；不做批量历史回填。
      if (state === null || state === undefined) {
        return await this.confirmLegacyRow(input, sessionId, conn, row);
      }
      if (input.assessment === 'correct') {
        if (state === 'confirmed_correct') {
          await conn.commit();
          return { idempotent: true };
        }
        if (state === 'confirmed_incorrect') {
          throw new HttpException({ code: 1001, message: '该题自评结果已确认' }, 409);
        }
        if (state === 'default_incorrect') {
          await this.selfAssess.create({
            studentId: input.studentId, questionId: input.questionId,
            assessment: 'correct', source: input.source,
          }, conn);
          const cleared = await this.errorBooks.clearUnclearedByStudentQuestionId(
            input.studentId, input.questionId, conn,
          );
          const kpIds = await this.questions.findKnowledgePointIdsByQuestion(input.questionId);
          for (const kpId of kpIds) {
            const n = await this.mastery.revertOneError(input.studentId, kpId, conn);
            if (n === 0) this.logger.warn(`revertOneError 0 行（student=${input.studentId}, kp=${kpId}）`);
          }
          await this.answers.transitionState({
            sessionId, questionId: input.questionId, state: 'confirmed_correct',
            isCorrect: 1, judgedAt: new Date(),
          }, conn);
          await conn.commit();
          if (cleared > 0) {
            this.events?.track({
              event: 'error_book_cleared', source: 'server', studentId: input.studentId,
              refType: 'question', refId: input.questionId,
            });
          }
          return { errorBookId: undefined };
        }
        // NULL 旧行已在上方兼容；此处只兜未知脏状态。
        throw new HttpException({ code: 1002, message: '作答记录状态异常，请重新提交' }, 409);
      }
      if (input.assessment === 'incorrect') {
        if (state === 'confirmed_incorrect') {
          await conn.commit();
          return { idempotent: true };
        }
        if (state === 'confirmed_correct') {
          throw new HttpException({ code: 1001, message: '该题自评结果已确认' }, 409);
        }
        if (state === 'default_incorrect') {
          await this.selfAssess.create({
            studentId: input.studentId, questionId: input.questionId,
            assessment: 'incorrect', source: input.source,
          }, conn);
          await this.answers.transitionState({
            sessionId, questionId: input.questionId, state: 'confirmed_incorrect',
            isCorrect: 0, judgedAt: new Date(),
          }, conn);
          await conn.commit();
          return {};
        }
        // NULL 旧行已在上方兼容；此处只兜未知脏状态。
        throw new HttpException({ code: 1002, message: '作答记录状态异常，请重新提交' }, 409);
      }
      throw new HttpException({ code: 1002, message: '暂不支持的自评结果' }, 409);
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  /**
   * 迁移前旧作答行（self_assess_state=NULL）的兼容路径（spec §4.5）：
   * 按旧 `judgeCore.recordSelfAssessment` 语义补做副作用——留痕 + 错题本写入/清零 +
   * 掌握度按 assessment 记一次，再由调用方 transitionState 补写 confirmed_*。
   *
   * ⚠️ 掌握度必须直接逐 KP 调 `masteryRepo.upsertOnJudge(..., conn)`，异常冒泡由外层 rollback；
   * 绝不能调吞异常的 `MasteryService.recordFromSelfAssessment` / `revertErrorToCorrect`。
   * 仅首次自评走此路径（作答行已 FOR UPDATE 锁定），不做批量历史回填。
   *
   * ⚠️ state=NULL 也涵盖「从未作答」的占位行（四列全 NULL）：它不能按旧语义伪造自评，
   * 入口直接抛 409/1002，不写留痕/错题本/掌握度。
   */
  private async confirmLegacyRow(
    input: {
      studentId: number; subjectId: number; questionId: number;
      assessment: 'correct' | 'incorrect'; source: string;
    },
    sessionId: number,
    conn: PoolConnection,
    row: Parameters<typeof isPlaceholderRow>[0],
  ): Promise<{ errorBookId?: number }> {
    if (isPlaceholderRow(row)) {
      throw new HttpException({ code: 1002, message: '作答记录不存在或已失效，请重新提交' }, 409);
    }
    await this.selfAssess.create({
      studentId: input.studentId, questionId: input.questionId,
      assessment: input.assessment, source: input.source,
    }, conn);

    let cleared = 0;
    let errorBookId: number | undefined;
    if (input.assessment === 'correct') {
      cleared = await this.errorBooks.clearUnclearedByStudentQuestionId(
        input.studentId, input.questionId, conn,
      );
    } else {
      errorBookId = await this.errorBooks.findOrCreateUncleared({
        studentId: input.studentId,
        subjectId: input.subjectId,
        questionId: input.questionId,
        source: input.source,
        sourceRefId: null,
      }, conn);
    }

    const kpIds = await this.questions.findKnowledgePointIdsByQuestion(input.questionId);
    for (const kpId of kpIds) {
      await this.mastery.upsertOnJudge(input.studentId, kpId, input.assessment === 'correct', conn);
    }

    await this.answers.transitionState({
      sessionId, questionId: input.questionId,
      state: input.assessment === 'correct' ? 'confirmed_correct' : 'confirmed_incorrect',
      isCorrect: input.assessment === 'correct' ? 1 : 0,
      judgedAt: new Date(),
    }, conn);
    await conn.commit();

    if (cleared > 0) {
      this.events?.track({
        event: 'error_book_cleared', source: 'server', studentId: input.studentId,
        refType: 'question', refId: input.questionId,
      });
    }
    return { errorBookId };
  }
}
