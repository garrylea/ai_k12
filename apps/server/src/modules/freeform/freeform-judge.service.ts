import { HttpException, Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { FreeformJudgeCapability, type FreeformJudgeImage } from '../../ai-core/capabilities/freeform-judge.capability.js';
import { QuestionsRepository } from '../../database/repositories/questions.repo.js';
import { MainErrorBooksRepository } from '../../database/repositories/main-error-books.repo.js';
import { AiDialoguesRepository } from '../../database/repositories/ai-dialogues.repo.js';
import { AiMessagesRepository } from '../../database/repositories/ai-messages.repo.js';
import { UploadedFilesRepository } from '../../database/repositories/uploaded-files.repo.js';
import type { QuestionRow, UploadedFileRow } from '../../database/repositories/types.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { computeFreeformContentHash, stripMarkdownImages } from '../../common/utils/content-hash.util.js';
import { subjectCodeOf } from '../../common/subject-config.js';
import type { FreeformJudgeDto } from './dto/freeform.dto.js';

export type FreeformJudgeEvent =
  | { type: 'start'; dialogueId: string; questionId: number | null }
  | { type: 'reasoning'; delta: string }
  | { type: 'content'; delta: string; replace?: boolean }
  | { type: 'result'; questionId: number; totalScore: number; maxScore: number; verdict: 'correct' | 'partial' | 'incorrect'; errorBookId?: number }
  | { type: 'error'; code: number; message: string; retryable: boolean }
  | { type: 'done' };

const VERDICT = ['correct', 'partial', 'incorrect'] as const;
const QUESTION_TYPES = ['choice', 'multi_choice', 'fill_blank', 'true_false', 'short_answer', 'proof', 'calculation'] as const;

/**
 * 模型尾部 JSON 块的结构。`answer` 必须非空（AI 给不出标准答案就不入库），
 * 故空答案会被当作「解析失败」走二次提取 / 5502。
 */
const JsonSchema = z.object({
  verdict: z.enum(VERDICT),
  totalScore: z.number(),
  maxScore: z.number(),
  steps: z
    .array(
      z.object({
        stepNumber: z.number().int(),
        description: z.string(),
        score: z.number(),
        maxScore: z.number(),
        isCorrect: z.boolean(),
        comment: z.string(),
        errorType: z.enum(['logic', 'calculation', 'format', 'missing']).nullable().optional(),
      }),
    )
    .default([]),
  suggestions: z.array(z.string()).default([]),
  question: z.object({
    // 模型偶尔会给集合外的 type/difficulty；这里只要求形状可读，规范化在 extractResult 里做，
    // 避免一个越界的枚举值把整份报告打成 5502。
    type: z.string(),
    difficulty: z.number(),
    options: z.array(z.object({ label: z.string(), text: z.string(), isCorrect: z.boolean() })).nullable().default(null),
    answer: z.string().min(1),
    explanation: z.string().nullable().default(null),
    approach: z.string().nullable().default(null),
  }),
});

type ParsedResult = z.infer<typeof JsonSchema>;

const MAX_IMAGES = 6;
const MAX_QUESTION_COUNT = 30000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const FREEFORM_FIGURE_PREFIX = '/uploads/freeform/';
const ASSISTANT_MODEL = 'qwen3.8-max';
const UPLOADED_IMAGE_RE = /!\[[^\]]*\]\((\/uploads\/[^)\s]+)\)/g;

const DEFAULT_QUESTION_TYPE = 'short_answer';
const DEFAULT_DIFFICULTY = 2;

/** 送给模型的图片（label + dataUrl）+ 落库消息里要记的 URL。 */
type ResolvedImage = FreeformJudgeImage & { url: string };

const badRequest = (message: string) => new HttpException({ code: 1001, message }, 400);

/**
 * 做题入口判题：流式转发报告 → 解析尾部 JSON → 落库（题 / 错题本 / 对话锚 / 两条消息）。
 *
 * 三个「不做」是刻意设计：不发积分、不写 practice_results、不更新掌握度——
 * 服务因此**不注入** PointsService / MasteryService / PracticeResultsRepository，
 * freeform 题也没有知识点行（抽题池隔离见 spec §4.3）。
 *
 * 落库分两段：题目 + 错题本是**关键写**（失败发 5000，报告已流出、保留在页面）；
 * 对话锚与 ai_messages 是**尽力写**（失败只 warn，不影响 result）。
 */
@Injectable()
export class FreeformJudgeService {
  private readonly logger = new Logger(FreeformJudgeService.name);
  private readonly uploadDir = process.env.UPLOAD_DIR ?? './uploads';

  constructor(
    private readonly capability: FreeformJudgeCapability,
    private readonly questions: QuestionsRepository,
    private readonly errorBooks: MainErrorBooksRepository,
    private readonly dialogues: AiDialoguesRepository,
    private readonly messages: AiMessagesRepository,
    private readonly files: UploadedFilesRepository,
    private readonly conversations: ConversationsService,
  ) {}

  async *judgeStream(dto: FreeformJudgeDto, studentId: number, signal?: AbortSignal): AsyncIterable<FreeformJudgeEvent> {
    const subjectId = Number(dto.subjectId);
    const maxScore = Number(dto.maxScore);
    // 非字符串入参先降级为空串，交给 validate() 统一报 400，
    // 不让 `.trim()` / `.entries()` 抛 TypeError 变成 500。
    const questionContent = typeof dto.questionContent === 'string' ? dto.questionContent : '';
    const answer = typeof dto.answer === 'string' ? dto.answer.trim() : '';

    this.validate(dto, subjectId, maxScore, questionContent, answer);

    // 已存在的题（重判）——source 决定能不能覆写，见 persist()。
    const providedQuestion = dto.questionId != null ? await this.questions.findById(dto.questionId) : null;
    if (dto.questionId != null && !providedQuestion) throw badRequest('题目不存在');

    // 顺序按 spec §5.3：图片先全部解析/校验完（失败不留会话），再建会话或复用已有会话。
    const existingDialogueId = dto.dialogueId ? await this.validateDialogue(dto, studentId) : null;
    const images = await this.resolveImages(dto, studentId);
    const dialogueId = existingDialogueId ?? (await this.createDialogue(studentId, subjectId, questionContent));
    yield { type: 'start', dialogueId, questionId: dto.questionId ?? null };

    let content = '';
    let reasoning = '';
    try {
      for await (const e of this.capability.stream(
        {
          subject: subjectCodeOf(subjectId) as 'math' | 'physics' | 'chemistry',
          maxScore,
          questionContent,
          studentAnswer: answer,
          images,
        },
        signal,
      )) {
        if (e.type === 'reasoning') {
          reasoning += e.delta;
          yield e;
        } else {
          content += e.delta;
          yield e;
        }
      }
    } catch (err) {
      if (signal?.aborted) return;
      this.logger.warn(`freeform judge stream failed: ${err instanceof Error ? err.message : err}`);
      yield { type: 'error', code: 5502, message: '判题失败，请重试', retryable: true };
      return;
    }

    const parsed = await this.extractResult(content, questionContent, answer, maxScore);
    if (!parsed) {
      // 没有结构化结果 = 不写题/错题本/判题消息（会话已在前面按 spec 建好，供重试复用）。
      yield { type: 'error', code: 5502, message: '判题结果解析失败，请重试', retryable: true };
      return;
    }

    // 清洗后为空（模型把整份报告都塞进 JSON 块）→ 用原始 content，别把对话气泡清空。
    const cleaned = stripJsonBlock(content) || content;
    yield { type: 'content', delta: cleaned, replace: true };

    try {
      const { questionId, errorBookId } = await this.persist({
        studentId,
        subjectId,
        maxScore,
        questionContent,
        questionIdHint: dto.questionId ?? null,
        providedQuestion,
        parsed,
        dialogueId,
      });
      await this.persistMessages(dialogueId, questionContent, answer, cleaned, reasoning, images).catch((err) =>
        this.logger.warn(`freeform persistMessages failed: ${err instanceof Error ? err.message : err}`),
      );
      yield {
        type: 'result',
        questionId,
        totalScore: parsed.totalScore,
        maxScore,
        verdict: parsed.verdict,
        ...(errorBookId != null ? { errorBookId } : {}),
      };
      yield { type: 'done' };
    } catch (err) {
      this.logger.error(`freeform persist failed: ${err instanceof Error ? err.stack : err}`);
      yield { type: 'error', code: 5000, message: '判题完成但入库失败，请重试', retryable: true };
    }
  }

  private validate(
    dto: FreeformJudgeDto,
    subjectId: number,
    maxScore: number,
    questionContent: string,
    answer: string,
  ): void {
    if (![1, 4, 5].includes(subjectId)) throw badRequest('学科仅支持数学/物理/化学');
    if (!Number.isInteger(maxScore) || maxScore < 1 || maxScore > 100) throw badRequest('满分必须为 1–100 的整数');
    if (typeof dto.questionContent !== 'string') throw badRequest('题干必须是字符串');
    if (!questionContent.trim() || questionContent.length > MAX_QUESTION_COUNT) {
      throw badRequest('题干不能为空且不超过 30000 字');
    }
    if (typeof dto.answer !== 'string') throw badRequest('作答必须是字符串');
    if (answer.length > MAX_QUESTION_COUNT) throw badRequest('作答不超过 30000 字');
    if (!answer && !dto.draftFileId) throw badRequest('请先写答案或在草稿上作答');
    if (dto.questionImages != null && !Array.isArray(dto.questionImages)) throw badRequest('题图参数格式错误');
    if (dto.figureUrls != null && !Array.isArray(dto.figureUrls)) throw badRequest('配图参数格式错误');
    // 张数属于纯参数校验：放在建会话之前，坏入参不留下空会话。
    if ((dto.questionImages?.length ?? 0) > MAX_IMAGES) throw badRequest('最多 6 张题图');
    if ((dto.figureUrls?.length ?? 0) > MAX_IMAGES) throw badRequest('最多 6 张配图');
    if (dto.questionId != null && (!Number.isInteger(dto.questionId) || dto.questionId <= 0)) {
      throw badRequest('questionId 必须为正整数');
    }
    if (dto.dialogueId != null && !/^\d+$/.test(dto.dialogueId)) throw badRequest('dialogueId 必须为正整数');
  }

  /** 已传 dialogueId：校验归属 + 场景，**不写库**（写在图片全部校验通过之后才发生）。 */
  private async validateDialogue(dto: FreeformJudgeDto, studentId: number): Promise<string> {
    const dlg = await this.conversations.get(Number(dto.dialogueId), studentId);
    if (dlg.scene !== 'aux_freeform') throw badRequest('对话场景不匹配');
    return String(dlg.id);
  }

  /** 无 dialogueId 则新建 aux_freeform 会话（题干作 assistant 锚消息，供后续追问带上下文）。 */
  private async createDialogue(
    studentId: number,
    subjectId: number,
    questionContent: string,
  ): Promise<string> {
    const dlg = await this.conversations.create(studentId, {
      track: 'auxiliary',
      scene: 'aux_freeform',
      subjectId,
      questionText: questionContent.slice(0, 4000),
      title: `做题 · ${questionContent.slice(0, 20)}`,
    });
    if (!dlg) throw new HttpException({ code: 5000, message: '创建会话失败' }, 500);
    return String(dlg.id);
  }

  /**
   * 图片 → data URL，按固定顺序打标签：原题图 1..N / 配图 1..M / 学生草稿 / 作答图 1..K。
   *
   * - fileId（原题图、草稿）：必须存在且属于本人、MIME 为图片，否则 400/1001；
   * - figureUrls（学生勾选的识别配图）：同样必须命中本人上传记录（spec §5.3 校验链 8）；
   * - 作答 Markdown 里内嵌的图：属于正文的一部分，找不到归属就跳过（不因一条过期
   *   Markdown 引用让整次判题失败），最多取 6 张。
   */
  private async resolveImages(dto: FreeformJudgeDto, studentId: number): Promise<ResolvedImage[]> {
    const questionImages = dto.questionImages ?? [];
    const figureUrls = dto.figureUrls ?? [];

    const out: ResolvedImage[] = [];
    for (const [i, img] of questionImages.entries()) {
      const row = await this.loadOwnedFile(img.fileId, studentId, '文件不存在或无权访问');
      out.push({ label: `原题图${i + 1}`, url: row.url, dataUrl: await this.toDataUrl(row) });
    }
    for (const [i, url] of figureUrls.entries()) {
      if (typeof url !== 'string' || !url.startsWith(FREEFORM_FIGURE_PREFIX)) {
        throw badRequest('配图地址不合法');
      }
      const row = await this.files.findByUrlAndOwner(url, studentId);
      if (!row) throw badRequest('配图不存在或无权访问');
      out.push({ label: `配图${i + 1}`, url, dataUrl: await this.toDataUrl(row) });
    }
    if (dto.draftFileId) {
      const row = await this.loadOwnedFile(dto.draftFileId, studentId, '草稿不存在或无权访问');
      out.push({ label: '学生草稿', url: row.url, dataUrl: await this.toDataUrl(row) });
    }
    const embedded = [...(dto.answer ?? '').matchAll(UPLOADED_IMAGE_RE)].map((m) => m[1]).slice(0, MAX_IMAGES);
    for (const [i, url] of embedded.entries()) {
      const row = await this.files.findByUrlAndOwner(url, studentId);
      if (!row) continue;
      out.push({ label: `作答图${i + 1}`, url, dataUrl: await this.toDataUrl(row) });
    }
    return out;
  }

  private async loadOwnedFile(fileId: string, studentId: number, missingMessage: string): Promise<UploadedFileRow> {
    if (!/^\d+$/.test(String(fileId)) || Number(fileId) <= 0) throw badRequest('文件 id 必须为正整数');
    const row = await this.files.findByIdAndOwner(Number(fileId), studentId);
    if (!row) throw badRequest(missingMessage);
    return row;
  }

  /**
   * 读文件统一出口（四类图都走这里）：
   * - 非图片 → 400；
   * - 单张 >5MB → 400（上传端点允许 20MB，直接转 base64 会把 prompt 撑到 27MB）；
   * - 解析后的绝对路径必须仍在 `UPLOAD_DIR` 内（防 `../` 越界读任意文件）。
   */
  private async toDataUrl(row: UploadedFileRow): Promise<string> {
    if (!row.mime_type.startsWith('image/')) throw badRequest('附件必须是图片');
    if (row.size_bytes > MAX_IMAGE_BYTES) throw badRequest('图片过大（最大 5MB）');
    const abs = path.resolve(this.uploadDir, row.url.replace(/^\/uploads\//, ''));
    if (!abs.startsWith(path.resolve(this.uploadDir) + path.sep)) throw badRequest('图片路径非法');
    let buf: Buffer;
    try {
      buf = await fs.readFile(abs);
    } catch {
      throw badRequest('图片读取失败，请重新上传');
    }
    return `data:${row.mime_type};base64,${buf.toString('base64')}`;
  }

  /** 取**最后一个** ```json 块；坏 JSON 或结构不符 → 二次非流式提取；仍不行返回 null。 */
  private async extractResult(
    content: string,
    questionContent: string,
    answer: string,
    maxScore: number,
  ): Promise<ParsedResult | null> {
    const blocks = [...content.matchAll(/```json\s*([\s\S]*?)```/gi)];
    const raw = blocks.at(-1)?.[1] ?? '';
    let parsed = raw ? safeParseJson(raw) : null;
    let data = parsed ? JsonSchema.safeParse(parsed) : null;
    if (!data?.success) {
      const second = await this.capability
        .extractStructured({ report: content, questionContent, studentAnswer: answer, maxScore })
        .catch(() => null);
      data = second ? JsonSchema.safeParse(second) : null;
    }
    if (!data?.success) return null;

    // 分数以学生选的满分为准：模型自报的 maxScore 只当报告内容，不采信。
    const total = Math.max(0, Math.min(maxScore, data.data.totalScore));
    const verdict = total >= maxScore ? 'correct' : total <= 0 ? 'incorrect' : 'partial';
    // type/difficulty 在 schema 里已放宽为 string/number，这里收敛到库里允许的取值。
    const q = data.data.question;
    const question = {
      ...q,
      type: (QUESTION_TYPES as readonly string[]).includes(q.type) ? q.type : DEFAULT_QUESTION_TYPE,
      difficulty: [1, 2, 3].includes(q.difficulty) ? q.difficulty : DEFAULT_DIFFICULTY,
    };
    return { ...data.data, question, totalScore: total, maxScore, verdict };
  }

  /**
   * 关键写：questions + main_error_books。
   *
   * 题目归属：带 questionId 时按 source 决定是否覆写（题库真题只复用）；不带时按
   * hash → 前缀去重，命中即复用，未命中才按 freeform 口径插入（answer_verified=0、
   * full_score=maxScore、无知识点行）。
   */
  private async persist(args: {
    studentId: number;
    subjectId: number;
    maxScore: number;
    questionContent: string;
    questionIdHint: number | null;
    providedQuestion: QuestionRow | null;
    parsed: ParsedResult;
    dialogueId: string;
  }): Promise<{ questionId: number; errorBookId?: number }> {
    const { studentId, subjectId, maxScore, questionContent, questionIdHint, providedQuestion, parsed, dialogueId } = args;
    const hash = computeFreeformContentHash(questionContent);
    const row = {
      type: parsed.question.type,
      difficulty: parsed.question.difficulty,
      full_score: maxScore,
      content: questionContent,
      options: parsed.question.options ? JSON.stringify(parsed.question.options) : null,
      answer: parsed.question.answer,
      approach: parsed.question.approach,
      explanation: parsed.question.explanation,
      content_hash: hash,
    };

    let questionId: number;
    if (questionIdHint != null) {
      questionId = questionIdHint;
      if (providedQuestion?.source === 'freeform') {
        await this.updateFreeform(questionId, row, providedQuestion.content_hash);
      }
      // source 不是 freeform（首次去重命中了真实题库题）：只复用，绝不改题。
    } else {
      const textForMatch = stripMarkdownImages(questionContent) || questionContent;
      const existing =
        (await this.questions.findByContentHash(hash)) ?? (await this.questions.findByContentPrefix(textForMatch))[0] ?? null;
      questionId = existing
        ? Number(existing.id)
        : await this.questions.createFreeform({ subject_id: subjectId, source: 'freeform', ...row });
    }

    let errorBookId: number | undefined;
    if (parsed.totalScore < maxScore) {
      const uncleared = await this.errorBooks.findUnclearedByStudentQuestionId(studentId, questionId);
      if (uncleared) {
        errorBookId = Number(uncleared.id);
      } else {
        errorBookId = await this.errorBooks.create({
          student_id: studentId,
          subject_id: subjectId,
          question_id: questionId,
          source: 'freeform',
          source_ref_id: null,
          question_n: null,
          lesson_id: null,
          wrong_answer_text: null,
        });
        // 仅新建行补写对话 id（复用行的 dialogue_id 可能指向更早那轮讨论）。
        await this.errorBooks
          .updateDialogueId(errorBookId, Number(dialogueId))
          .catch((err) => this.logger.warn(`updateDialogueId failed: ${err instanceof Error ? err.message : err}`));
      }
    } else {
      // 满分：清零该题未清错题（首次就答对时 affectedRows=0，正常）。
      await this.errorBooks.clearUnclearedByStudentQuestionId(studentId, questionId);
    }

    // 题面锚回填是尽力写：失败只 warn（仓库内部只在 question_id IS NULL 时写）。
    await this.dialogues
      .updateQuestionId(Number(dialogueId), questionId)
      .catch((err) => this.logger.warn(`updateQuestionId failed: ${err instanceof Error ? err.message : err}`));
    return { questionId, errorBookId };
  }

  /**
   * 重判写回：新 hash 撞上**另一条**题（UNIQUE content_hash）时保留原 hash 再写一次，
   * 只 warn 不抛错（spec §4.1）。
   */
  private async updateFreeform(
    questionId: number,
    row: {
      type: string; difficulty: number; full_score: number; content: string;
      options: string | null; answer: string; approach: string | null;
      explanation: string | null; content_hash: string;
    },
    originalHash: string | null,
  ): Promise<void> {
    try {
      await this.questions.updateFreeform(questionId, row);
    } catch (err: any) {
      if ((err?.code === 'ER_DUP_ENTRY' || err?.errno === 1062) && originalHash !== row.content_hash) {
        this.logger.warn(`freeform content_hash conflicts with another question, keep original: ${questionId}`);
        await this.questions.updateFreeform(questionId, { ...row, content_hash: originalHash ?? row.content_hash });
        return;
      }
      throw err;
    }
  }

  /** 两条消息：学生提交（题目 + 作答 + 图 URL）与 AI 报告（清洗后的正文 + 思考过程）。 */
  private async persistMessages(
    dialogueId: string,
    questionContent: string,
    answer: string,
    report: string,
    reasoning: string,
    images: ResolvedImage[],
  ): Promise<void> {
    const base = {
      dialogue_id: Number(dialogueId),
      reasoning: null as string | null,
      attachments: null as string | null,
      model: null as string | null,
      token_input: null as number | null,
      token_output: null as number | null,
      response_time_ms: null as number | null,
      safety_flag: 0,
    };
    await this.messages.create({
      ...base,
      role: 'user',
      content: `题目：\n${questionContent}\n\n我的作答：\n${answer}`,
      type: 'freeform_submit',
      attachments: JSON.stringify(images.map((img) => ({ type: 'image', url: img.url }))),
    });
    await this.messages.create({
      ...base,
      role: 'assistant',
      content: report,
      reasoning: reasoning || null,
      type: 'freeform_judge',
      model: ASSISTANT_MODEL,
    });
  }
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 去掉最后一个 ```json 块（报告正文），保留前后文字。 */
function stripJsonBlock(content: string): string {
  const re = /```json\s*[\s\S]*?```/gi;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(content); m; m = re.exec(content)) last = m;
  if (!last) return content.trim();
  return (content.slice(0, last.index) + content.slice(last.index + last[0].length)).trim();
}
