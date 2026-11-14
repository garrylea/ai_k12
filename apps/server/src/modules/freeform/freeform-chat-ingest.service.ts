import { Injectable, Logger } from '@nestjs/common';
import { AiDialoguesRepository } from '../../database/repositories/ai-dialogues.repo.js';
import { AiMessagesRepository } from '../../database/repositories/ai-messages.repo.js';
import { QuestionsRepository } from '../../database/repositories/questions.repo.js';
import { MainErrorBooksRepository } from '../../database/repositories/main-error-books.repo.js';
import { KnowledgePointsRepository } from '../../database/repositories/knowledge-points.repo.js';
import { SubjectsRepository } from '../../database/repositories/subjects.repo.js';
import { StudentsRepository } from '../../database/repositories/students.repo.js';
import { FreeformTagCapability } from '../../ai-core/capabilities/freeform-tag.capability.js';
import { computeFreeformContentHash, stripMarkdownImages } from '../../common/utils/content-hash.util.js';

const DEFAULT_FULL_SCORE = 10;

/**
 * 做题答疑的「聊过即入库」：只答疑、没提交的题也要进错题本。
 *
 * 约束：
 * - 全部 fire-and-forget，调用方一律 `void`；本服务**永不 reject**。
 * - 幂等：会话已有 question_id / 已有判题报告 / 已有该题错题行（含已清零）→ 跳过。
 * - 判题满分后再答疑：同一会话 question_id 已存在，天然跳过。
 */
@Injectable()
export class FreeformChatIngestService {
  private readonly logger = new Logger(FreeformChatIngestService.name);
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly dialogues: AiDialoguesRepository,
    private readonly messages: AiMessagesRepository,
    private readonly questions: QuestionsRepository,
    private readonly errorBooks: MainErrorBooksRepository,
    private readonly kps: KnowledgePointsRepository,
    private readonly subjects: SubjectsRepository,
    private readonly students: StudentsRepository,
    private readonly tagger: FreeformTagCapability,
  ) {}

  maybeIngest(dialogueId: string, studentId: number): Promise<void> {
    const key = `d:${dialogueId}`;
    const running = this.inFlight.get(key);
    if (running) return running;
    const p = this.ingest(dialogueId, studentId)
      .catch((err) =>
        this.logger.warn(
          `freeform ingest failed (dialogue=${dialogueId}): ${err instanceof Error ? err.message : err}`,
        ),
      )
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }

  tagExistingQuestion(
    questionId: number,
    content: string,
    subjectId: number,
    studentId: number,
  ): Promise<void> {
    const key = `q:${questionId}`;
    const running = this.inFlight.get(key);
    if (running) return running;
    const p = this.tag(questionId, content, subjectId, studentId)
      .catch((err) =>
        this.logger.warn(
          `freeform tag failed (question=${questionId}): ${err instanceof Error ? err.message : err}`,
        ),
      )
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }

  private async ingest(dialogueId: string, studentId: number): Promise<void> {
    const dlg = await this.dialogues.findById(Number(dialogueId));
    if (!dlg || dlg.student_id !== studentId || dlg.scene !== 'aux_freeform') return;
    if (dlg.question_id != null) return;

    const msgs = await this.messages.findByDialogue(Number(dialogueId));
    // 判题已发生就不再补题（兜底 question_id 回填失败；也避免满分题被误收）
    if (msgs.some((m) => m.type === 'freeform_judge')) return;
    // 只有题干锚 / 被安全阻断（block）不算「聊过」
    const hasRealAnswer = msgs.some(
      (m) => m.role === 'assistant' && m.type !== 'transcription' && m.type !== 'block',
    );
    if (!hasRealAnswer) return;
    const anchor = msgs.find((m) => m.role === 'assistant' && m.type === 'transcription');
    if (!anchor?.content?.trim()) return;

    // 会话没有学科就不猜（默认数学会让物理题进数学专项）
    const subjectId = dlg.subject_id;
    if (subjectId == null) return;

    const content = anchor.content.trim();
    // 纯图片题：模型看不到图，标注没有依据 → 建空答案题，不挂 KP（answerable=false）
    const text = stripMarkdownImages(content).trim();
    const hash = computeFreeformContentHash(content);

    let questionId: number | null =
      (await this.questions.findByContentHash(hash))?.id ??
      (await this.questions.findByContentPrefix(text || content, { subjectId }))[0]?.id ??
      null;

    if (questionId == null) {
      const subject = await this.subjects.findById(subjectId).catch(() => null);
      const result = text
        ? await this.tagger.tag({
            question: text,
            subjectId,
            subjectName: subject?.name ?? '数学',
            gradeBand: await this.gradeBandOf(studentId),
            knowledgePointOptions: (await this.kps.findBySubject(subjectId)).map((k) => ({
              id: k.id,
              name: k.name,
            })),
          })
        : null;
      questionId = await this.questions.createFreeform({
        subject_id: subjectId,
        type: result?.type ?? 'short_answer',
        difficulty: result?.difficulty ?? 1,
        full_score: DEFAULT_FULL_SCORE,
        content,
        // 只存 label/text，绝不存 isCorrect（解禁后接口会下发 options）
        options: stripOptionAnswers(result?.options),
        answer: result?.answer ?? '',
        approach: result?.approach ?? null,
        explanation: result?.explanation ?? '',
        source: 'freeform',
        content_hash: hash,
      });
      for (const [i, kpId] of (result?.knowledgePointIds ?? []).entries()) {
        await this.questions.bindKnowledgePoint(questionId, kpId, i === 0 ? 'primary' : 'secondary');
      }
    }

    await this.dialogues.updateQuestionId(Number(dialogueId), questionId).catch(() => {});
    if (await this.errorBooks.existsByStudentAndQuestionId(studentId, questionId)) return;

    const errorBookId = await this.errorBooks.create({
      student_id: studentId,
      subject_id: subjectId,
      question_id: questionId,
      source: 'freeform',
      source_ref_id: null,
      question_n: null,
      lesson_id: null,
      wrong_answer_text: null,
    });
    await this.errorBooks.updateDialogueId(errorBookId, Number(dialogueId)).catch(() => {});
  }

  private async tag(
    questionId: number,
    content: string,
    subjectId: number,
    studentId: number,
  ): Promise<void> {
    const existing = await this.questions.findKnowledgePointIdsByQuestion(questionId);
    if (existing.length > 0) return;

    const text = stripMarkdownImages(content).trim();
    if (!text) return; // 纯图片题没有可标注的文本

    const subject = await this.subjects.findById(subjectId).catch(() => null);
    const result = await this.tagger.tag({
      question: text,
      subjectId,
      subjectName: subject?.name ?? '数学',
      gradeBand: await this.gradeBandOf(studentId),
      knowledgePointOptions: (await this.kps.findBySubject(subjectId)).map((k) => ({
        id: k.id,
        name: k.name,
      })),
    });
    for (const [i, kpId] of result.knowledgePointIds.entries()) {
      await this.questions.bindKnowledgePoint(questionId, kpId, i === 0 ? 'primary' : 'secondary');
    }
  }

  /** 学段从学生档案取，不要写死 junior（小学/高中生会选到错误的 KP）。 */
  private async gradeBandOf(studentId: number): Promise<'primary' | 'junior' | 'senior'> {
    const s = await this.students.findById(studentId).catch(() => null);
    return s?.schoolLevel === 'primary' || s?.schoolLevel === 'senior' ? s.schoolLevel : 'junior';
  }
}

/** options 只存 label/text，绝不把 isCorrect 发给学生（变式题同铁律）。 */
function stripOptionAnswers(
  options: Array<{ label: string; text: string; isCorrect: boolean }> | null | undefined,
): string | null {
  if (!options?.length) return null;
  return JSON.stringify(options.map(({ label, text }) => ({ label, text })));
}
