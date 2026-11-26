import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import {
  MainErrorBooksRepository,
  QuestionSelfAssessmentsRepository,
  QuestionsRepository,
  SpecialAnswerRecordsRepository,
  SpecialPracticeSessionsRepository,
  StudentKnowledgeMasteryRepository,
} from '../../database/repositories/index.js';
import type { SpecialSessionModule } from '../../database/repositories/special-practice-sessions.repo.js';

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
  constructor(
    @Inject('DATABASE_POOL') private pool: Pool,
    private sessions: SpecialPracticeSessionsRepository,
    private answers: SpecialAnswerRecordsRepository,
    private errorBooks: MainErrorBooksRepository,
    private questions: QuestionsRepository,
    private mastery: StudentKnowledgeMasteryRepository,
    private selfAssess: QuestionSelfAssessmentsRepository,
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
        if (existing.self_assess_state === 'default_incorrect' && existing.answer_text === input.answerText) {
          // 幂等重复提交：不重复 error+1 / 错题本；errorBookId 取既有未清行（无则 0）
          const old = await this.errorBooks.findUnclearedByStudentQuestionId(
            input.studentId, input.questionId, conn,
          );
          await conn.commit();
          return { sessionId, errorBookId: old?.id ?? 0 };
        }
        throw new HttpException({ code: 1001, message: '该题已有不同作答或已确认' }, 409);
      }

      await this.answers.insertDefaultIncorrect({
        sessionId,
        questionId: input.questionId,
        questionOrder: input.questionOrder,
        answerText: input.answerText,
        method: 'self_assess',
      }, conn);

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
}
