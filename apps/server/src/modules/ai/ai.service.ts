import {
  Injectable,
  BadRequestException,
  HttpException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { TutoringCapability } from '../../ai-core/capabilities/tutoring.capability.js';
import { mapLLMErrorToClient } from '../../ai-core/infra/model-client/errors.js';
import { fallbackConfig } from '../../ai-core/config.js';
import type { TutoringRequest, Attachment, StreamEvent, StructuredQuestionOutput } from '../../ai-core/types.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { ConversationService } from '../../services/conversation/index.js';
import { AiDialoguesRepository, ExtractTasksRepository, MainErrorBooksRepository, QuestionsRepository } from '../../database/repositories/index.js';
import { UploadedFilesRepository } from '../../database/repositories/uploaded-files.repo.js';
import type { QuestionRow } from '../../database/repositories/types.js';
import { SubjectsRepository } from '../../database/repositories/subjects.repo.js';
import { computeContentHash } from '../../common/utils/content-hash.util.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TutorDto } from './dto/tutor.dto.js';

@Injectable()
export class AIService {
  private readonly logger = new Logger(AIService.name);
  private readonly MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB

  constructor(
    private readonly tutoring: TutoringCapability,
    private readonly conversationsService: ConversationsService,
    private readonly conversationService: ConversationService,
    private readonly dialoguesRepo: AiDialoguesRepository,
    private readonly mainErrorRepo: MainErrorBooksRepository,
    private readonly filesRepo: UploadedFilesRepository,
    private readonly subjectsRepo: SubjectsRepository,
    private readonly questionsRepo: QuestionsRepository,
    private readonly extractTasksRepo: ExtractTasksRepository,
  ) {}

  async tutor(dto: TutorDto, userId: number) {
    this.validateDto(dto);
    const dialogueId = await this.resolveDialogue(dto, userId);

    // 辅线答疑：学生已来回 ≥N 轮且明确索要详细解析时——
    //   命中题库 -> 直接输出答案+思路+解析（不调模型）；
    //   题库查不到 -> 强制走 AI 完整解析兜底（不再苏格拉底追问）。
    const resolved = await this.maybeStoredExplanation(dialogueId, userId, dto);
    if (resolved?.kind === 'stored') {
      await this.persistStoredExplanation(dialogueId, dto, resolved.content);
      this.maybeUpdateTitle(dialogueId, userId, dto.message, resolved.content).catch(() => {});
      return {
        dialogueId,
        message: { role: 'assistant' as const, content: resolved.content, type: 'fallback' },
        reasoning: undefined,
        safety: { isLearningRelated: true, alertLevel: 'none' as const },
        fallback: true,
        consecutiveFailCount: 0,
      };
    }

    // NOTE: TutoringCapability.tutor() internally persists BOTH the user message
    // and the assistant reply via ConversationService.saveMessages() in all code
    // paths (fallback / block / normal). We deliberately do NOT call
    // conversationsService.appendMessage() / appendAssistantMessage() here to
    // avoid creating duplicate rows in ai_messages.

    const attachments = await this.resolveAttachments(dto, userId);
    const request = this.buildRequest(dto, userId, dialogueId, attachments, resolved?.kind === 'forceFallback');

    try {
      const response = await this.tutoring.tutor(request);
      if (response.structuredQuestion) {
        const qid = await this.ingestStructuredQuestion(userId, dto, dialogueId, attachments, response.structuredQuestion);
        await this.linkDialogueQuestion(dialogueId, dto, qid);
      }
      // Fire-and-forget: name the conversation from the user's actual question.
      this.maybeUpdateTitle(dialogueId, userId, dto.message, response.message.content).catch(() => {});
      return {
        dialogueId,
        message: response.message,
        reasoning: response.reasoning,
        safety: response.safety,
        fallback: response.isFallback,
        consecutiveFailCount: response.consecutiveFailCount,
      };
    } catch (err) {
      throw this.mapLLMError(err, dialogueId);
    }
  }

  /**
   * Streaming tutor. `idle + image` and `idle + text` both go straight to the
   * Socratic tutoring path; images are attached to the user message as
   * `image_url` parts by the capability (no transcription stage).
   * Pre-stream errors throw HttpException; mid-stream model errors are yielded
   * as `{type:'error'}` by the capability.
   */
  async *tutorStream(dto: TutorDto, userId: number, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    this.validateDto(dto);
    const dialogueId = await this.resolveDialogue(dto, userId);

    // 辅线答疑：命中「已满 N 轮 + 明确索要详细解析」时——
    //   题库命中 -> 直接输出题库内容（单条 content + done，不调模型）；
    //   查不到   -> forceFallback 走 AI 完整解析（不再苏格拉底追问）。
    const resolved = await this.maybeStoredExplanation(dialogueId, userId, dto);
    if (resolved?.kind === 'stored') {
      await this.persistStoredExplanation(dialogueId, dto, resolved.content);
      yield { type: 'content', delta: resolved.content };
      yield { type: 'done', fallback: true };
      this.maybeUpdateTitle(dialogueId, userId, dto.message, resolved.content).catch(() => {});
      return;
    }

    const attachments = await this.resolveAttachments(dto, userId);
    const request = this.buildRequest(dto, userId, dialogueId, attachments, resolved?.kind === 'forceFallback');

    try {
      yield* this.tutorStage(dto, userId, request, signal);
    } catch (err) {
      this.logger.error('tutorStream stage failed:', err instanceof Error ? err.stack ?? err.message : err);
      throw this.mapLLMError(err, dialogueId);
    }
  }

  /** Socratic tutoring (multimodal qwen3.8-max when images are attached) - the
   *  existing streaming path. */
  private async *tutorStage(dto: TutorDto, userId: number, request: TutoringRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const dialogueId = request.dialogueId!;
    let assistantContent = '';
    for await (const event of this.tutoring.tutorStream(request, signal)) {
      if (event.type === 'content') {
        assistantContent = event.replace ? (event.delta ?? '') : assistantContent + (event.delta ?? '');
      } else if (event.type === 'done' && event.structuredQuestion) {
        const qid = await this.ingestStructuredQuestion(userId, dto, dialogueId, request.attachments ?? [], event.structuredQuestion);
        await this.linkDialogueQuestion(dialogueId, dto, qid);
      }
      yield event;
    }
    this.maybeUpdateTitle(dialogueId, userId, dto.message, assistantContent).catch(() => {});
  }

  // ---------- shared helpers ----------

  private validateDto(dto: TutorDto) {
    // 图片-only 发送允许空 message；其余必须有 message。
    const hasMessage = !!dto.message && dto.message.trim().length > 0;
    if (!hasMessage && !dto.attachments?.length) {
      throw new BadRequestException({ code: 1001, message: 'message 不能为空' });
    }
    if (dto.mode !== 'mainline' && dto.mode !== 'auxiliary') {
      throw new BadRequestException({ code: 1001, message: 'mode 必须为 mainline 或 auxiliary' });
    }
    // TODO: check controls.auxiliary_enabled via ControlsRepository (not yet created in Task 1).
    // For now, auxiliary access is not gated at the service layer.
  }

  private async resolveDialogue(dto: TutorDto, userId: number): Promise<string> {
    if (dto.dialogueId) {
      // Critical: verify the dialogue belongs to the current user before proceeding.
      // ai-core ConversationService.loadContext uses findById (no student_id filter),
      // so without this check a student could read/tamper with another's dialogue.
      await this.conversationsService.get(Number(dto.dialogueId), userId);
      return dto.dialogueId;
    }
    let knowledgePointId: number | undefined;
    if (dto.knowledgeId) {
      knowledgePointId = Number(dto.knowledgeId);
      if (!Number.isFinite(knowledgePointId)) {
        throw new BadRequestException({ code: 1001, message: 'knowledgeId 必须为数字' });
      }
    }
    let cardIdNum: number | undefined;
    if (dto.mode === 'mainline' && dto.cardId) {
      cardIdNum = Number(dto.cardId);
      if (!Number.isFinite(cardIdNum)) {
        throw new BadRequestException({ code: 1001, message: 'cardId 必须为数字' });
      }
    }
    const dialogue = await this.conversationsService.create(userId, {
      track: dto.mode,
      knowledgePointId,
      cardId: cardIdNum,
    });
    if (!dialogue) {
      throw new InternalServerErrorException({ code: 5000, message: '创建会话失败' });
    }
    return String(dialogue.id);
  }

  // Task 14a: resolve attachment fileIds to base64 data URLs for multimodal input.
  // Task 5: also resolve file attachments (txt/md → text, pdf → MinerU extraction result).
  private async resolveAttachments(dto: TutorDto, userId: number): Promise<Attachment[]> {
    const attachments: Attachment[] = [];
    if (!dto.attachments || dto.attachments.length === 0) return attachments;

    const uploadDir = process.env.UPLOAD_DIR ?? './uploads';
    for (const att of dto.attachments) {
      const fileIdNum = Number(att.fileId);
      if (!Number.isFinite(fileIdNum)) {
        throw new BadRequestException({ code: 1001, message: 'attachment.fileId 必须为数字' });
      }
      const fileRow = await this.filesRepo.findByIdAndOwner(fileIdNum, userId);
      if (!fileRow) {
        throw new BadRequestException({ code: 1001, message: '文件不存在或无权访问' });
      }

      if (att.type === 'image') {
        if (!fileRow.mime_type.startsWith('image/')) {
          throw new BadRequestException({ code: 1001, message: '附件必须是图片' });
        }
        if (fileRow.size_bytes > this.MAX_IMAGE_BYTES) {
          throw new BadRequestException({ code: 1001, message: '图片过大（最大 5MB）' });
        }
        const storageKey = fileRow.url.replace(/^\/uploads\//, '');
        const filePath = path.join(uploadDir, storageKey);
        let base64: string;
        try {
          base64 = fs.readFileSync(filePath).toString('base64');
        } catch {
          throw new BadRequestException({ code: 1001, message: `文件读取失败: ${att.fileId}` });
        }
        const dataUrl = `data:${fileRow.mime_type};base64,${base64}`;
        attachments.push({
          type: 'image',
          url: fileRow.url,
          imageUrl: dataUrl,
          fileId: att.fileId,
          fileName: path.basename(fileRow.url),
        });
        continue;
      }

      if (att.type === 'file') {
        const isText = fileRow.mime_type.startsWith('text/') || fileRow.mime_type === 'text/markdown';
        if (isText) {
          const storageKey = fileRow.url.replace(/^\/uploads\//, '');
          const filePath = path.join(uploadDir, storageKey);
          let content: string;
          try {
            content = fs.readFileSync(filePath, 'utf-8');
          } catch {
            throw new BadRequestException({ code: 1001, message: `文件读取失败: ${att.fileId}` });
          }
          attachments.push({
            type: 'file',
            url: fileRow.url,
            extractedText: content,
            fileId: att.fileId,
            fileName: path.basename(fileRow.url),
          });
          continue;
        }

        if (fileRow.mime_type === 'application/pdf') {
          if (!att.taskId) {
            throw new BadRequestException({ code: 1001, message: 'PDF 文件缺少 taskId' });
          }
          const task = await this.extractTasksRepo.findById(att.taskId);
          if (!task || task.student_id !== userId) {
            throw new BadRequestException({ code: 1001, message: 'PDF 提取任务不存在或无权访问' });
          }
          if (task.status !== 'completed') {
            throw new BadRequestException({ code: 1001, message: `PDF 提取尚未完成（当前状态: ${task.status}）` });
          }
          if (!task.result) {
            throw new BadRequestException({ code: 1001, message: 'PDF 提取结果为空' });
          }
          let parsedResult: { markdown?: string; images?: string[] };
          try {
            parsedResult = JSON.parse(task.result);
          } catch {
            throw new BadRequestException({ code: 1001, message: 'PDF 提取结果解析失败' });
          }
          if (!parsedResult.markdown) {
            throw new BadRequestException({ code: 1001, message: 'PDF 提取结果缺少 markdown 内容' });
          }
          attachments.push({
            type: 'file',
            url: fileRow.url,
            extractedText: parsedResult.markdown,
            extractedImages: parsedResult.images,
            fileId: att.fileId,
            fileName: path.basename(fileRow.url),
          });
          continue;
        }

        throw new BadRequestException({ code: 1001, message: '不支持的文件类型' });
      }

      throw new BadRequestException({ code: 1001, message: `未知的附件类型: ${(att as any).type}` });
    }
    return attachments;
  }

  private buildRequest(dto: TutorDto, userId: number, dialogueId: string, attachments: Attachment[], forceFallback = false): TutoringRequest {
    // studentId comes from the JWT (user.sub), not the dto.
    return {
      studentId: String(userId),
      mode: dto.mode,
      cardId: dto.cardId,
      knowledgeId: dto.knowledgeId,
      message: dto.message,
      dialogueId,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(dto.retry ? { retry: true } : {}),
      ...(forceFallback ? { forceFallback: true } : {}),
    };
  }

  // Task 14a / B1: ingest a structured question into the questions bank.
  // Dedup: content_hash first, then a looser "first 20 chars" prefix match (the
  // model often rephrases the same question -> different hash -> duplicate rows).
  // On a match the existing row is reused (no duplicate insert) and the student's
  // 错题本 is ensured. Quality gate: poor questions are skipped.
  private async ingestStructuredQuestion(
    userId: number,
    dto: TutorDto,
    dialogueId: string,
    _attachments: Attachment[],
    structuredQuestion: StructuredQuestionOutput,
  ): Promise<number | null> {
    // Quality gate: skip LLM-flagged poor-quality questions.
    if (structuredQuestion.quality !== 'good' || !structuredQuestion.content.trim()) {
      return null;
    }
    let subjectId = dto.subjectId;
    if (!subjectId) {
      const mathSubject = await this.subjectsRepo.findByCode('math');
      subjectId = mathSubject?.id ?? 1;  // TODO: hardcode fallback, refined when multi-subject seed data matures
    }
    const contentHash = computeContentHash(structuredQuestion.content);
    try {
      // 1) hash 命中 or 前 20 字兜底命中 -> 复用已有题，不再插入重复题。
      const existing =
        (await this.questionsRepo.findByContentHash(contentHash)) ??
        (await this.questionsRepo.findByContentPrefix(structuredQuestion.content))[0] ??
        null;
      const questionId = existing
        ? existing.id
        : (await this.questionsRepo.findOrCreate({
            subject_id: subjectId,
            type: structuredQuestion.type,
            difficulty: structuredQuestion.difficulty,
            content: structuredQuestion.content,
            options: structuredQuestion.options ? JSON.stringify(structuredQuestion.options) : null,
            answer: structuredQuestion.answer,
            approach: structuredQuestion.approach ?? null,
            explanation: structuredQuestion.explanation,
            source: 'auxiliary',
            content_hash: contentHash,
          })).id;
      // 2) 确保进错题本（幂等：该学生此题已有任何行则跳过）。
      await this.ensureErrorBook(userId, subjectId, questionId, dialogueId);
      return questionId;
    } catch (err) {
      // Ingestion failure should not block the tutoring response.
      this.logger.error('structured question ingestion failed:', err);
      return null;
    }
  }

  /** 辅线入库的题进主线错题本（`source='auxiliary'`，不参与清零门禁）；已有则跳过。 */
  private async ensureErrorBook(userId: number, subjectId: number, questionId: number, dialogueId: string): Promise<void> {
    if (await this.mainErrorRepo.existsByStudentAndQuestionId(userId, questionId)) return;
    const id = await this.mainErrorRepo.create({
      student_id: userId,
      subject_id: subjectId,
      question_id: questionId,
      source: 'auxiliary',
      source_ref_id: null,
      question_n: null,
      lesson_id: null,
      wrong_answer_text: null,
    });
    if (dialogueId) await this.mainErrorRepo.updateDialogueId(id, Number(dialogueId)).catch(() => {});
  }

  /** 辅线答疑：把首次结构化入库的题目锚到会话上（幂等，仅当前为 NULL 时写）。 */
  private async linkDialogueQuestion(dialogueId: string, dto: TutorDto, questionId: number | null): Promise<void> {
    if (!questionId || dto.mode !== 'auxiliary') return;
    await this.dialoguesRepo.updateQuestionId(Number(dialogueId), questionId).catch((err) => {
      this.logger.error('dialogue question link failed:', err);
    });
  }

  // Name the conversation from the user's actual question (replaces the static
  // "辅线答疑" temp title). Only acts when the title is still the default; a
  // greeting/ambiguous message yields no title (returns null) so the temp title
  // stays and we retry on the next message. Fire-and-forget from tutor/stream.
  private async maybeUpdateTitle(
    dialogueId: string,
    userId: number,
    userMessage: string,
    assistantContent: string,
  ): Promise<void> {
    try {
      const dialogue = await this.conversationsService.get(Number(dialogueId), userId);
      if (dialogue.title && dialogue.title !== '辅线答疑') return;  // already named
      const topic = await this.tutoring.generateTitle(userMessage, assistantContent);
      if (!topic) return;  // greeting/ambiguous - keep temp title
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const time = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      await this.conversationsService.updateTitle(Number(dialogueId), userId, `${topic} · ${time}`);
    } catch (err) {
      this.logger.error('title generation failed:', err);
    }
  }

  // ---------- stored-explanation short-circuit (aux Q&A) ----------

  /** 学生是否在明确索要完整解析（而非继续要被引导）。 */
  private isDetailedExplanationRequest(message: string): boolean {
    const text = message ?? '';
    return fallbackConfig.fallback.detailedExplanationKeywords.some((kw) => text.includes(kw));
  }

  /**
   * 辅线答疑：判定是否走「详细解析」。满足「已来回 ≥ detailedExplanationAfterRounds 轮
   * + 当前消息明确索要详细解析」后：
   *   - 命中题库（question_id，或首条题干 hash / 前 20 字匹配）且有可用内容
   *       -> { kind:'stored', content }（直接输出，不调模型）；
   *   - 查不到题或题库无内容
   *       -> { kind:'forceFallback' }（强制 AI 完整解析兜底，不再苏格拉底追问）；
   *   - 未满足触发条件 -> null（走正常流程）。
   */
  private async maybeStoredExplanation(
    dialogueId: string,
    userId: number,
    dto: TutorDto,
  ): Promise<{ kind: 'stored'; content: string } | { kind: 'forceFallback' } | null> {
    if (dto.mode !== 'auxiliary') return null;
    if (!this.isDetailedExplanationRequest(dto.message)) return null;

    const history = await this.conversationsService.getMessages(Number(dialogueId), userId);
    const assistantTurns = history.filter((m) => m.role === 'assistant').length;
    if (assistantTurns < fallbackConfig.fallback.detailedExplanationAfterRounds) return null;

    const dialogue = await this.conversationsService.get(Number(dialogueId), userId);
    let question = dialogue.question_id ? await this.questionsRepo.findById(dialogue.question_id) : null;

    // 老会话（未回填 question_id）：用首条用户消息的题干匹配，hash 优先、前 20 字兜底。
    if (!question) {
      const firstUser = history.find((m) => m.role === 'user');
      const questionText = typeof firstUser?.content === 'string' ? firstUser.content.trim() : '';
      if (questionText) {
        question =
          (await this.questionsRepo.findByContentHash(computeContentHash(questionText))) ??
          (await this.questionsRepo.findByContentPrefix(questionText))[0] ??
          null;
      }
    }

    const content = question ? this.composeStoredExplanation(question) : null;
    return content ? { kind: 'stored', content } : { kind: 'forceFallback' };
  }

  /** 组库解析文案：答案 → 解题思路 → 解析，空的部分跳过；全空返回 null。 */
  private composeStoredExplanation(question: QuestionRow): string | null {
    const parts: string[] = [];
    const answer = (question.answer ?? '').trim();
    const approach = (question.approach ?? '').trim();
    const explanation = (question.explanation ?? '').trim();
    if (answer) parts.push(`**答案**：${answer}`);
    if (approach) parts.push(`**解题思路**\n${approach}`);
    if (explanation) parts.push(`**解析**\n${explanation}`);
    if (parts.length === 0) return null;
    return `好，这道题我们完整过一遍。\n\n${parts.join('\n\n')}`;
  }

  /** 持久化短路回合：用户消息 + 完整解析（type=fallback），并结束会话。 */
  private async persistStoredExplanation(dialogueId: string, dto: TutorDto, content: string): Promise<void> {
    await this.conversationService.saveMessages({
      dialogueId,
      messages: [
        { role: 'user', content: dto.message },
        { role: 'assistant', content, type: 'fallback' },
      ],
    });
    await this.conversationService.updateFailCount({ dialogueId, increment: false });
    await this.conversationService.completeDialogue({ dialogueId });
  }

  private mapLLMError(err: unknown, dialogueId: string): HttpException {
    // Re-throw HttpExceptions (BadRequest, NotFound from ownership check) as-is
    // so they keep their original status code and payload.
    if (err instanceof HttpException) return err;

    // Map LLM errors to HTTP responses without leaking internal details.
    // Include dialogueId so the frontend can retry against the same dialogue
    // (no new orphan created on retry). `retryable` lets the frontend decide
    // whether to show a retry button (see mapLLMErrorToClient code table).
    const info = mapLLMErrorToClient(err);
    return new HttpException(
      { code: info.code, message: info.message, retryable: info.retryable, dialogueId },
      503,
    );
  }
}
