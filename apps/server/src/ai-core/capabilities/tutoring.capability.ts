import type { TutoringRequest, TutoringResponse, StructuredQuestionOutput, ContentPart, ChatMessage, RouteResult, StreamEvent, TextPart, Attachment } from '../types.js';
import { timeoutConfig, fallbackConfig } from '../config.js';
import { ModelRouter } from '../infra/model-router.js';
import { getModelConfigRegistry } from '../infra/model-config-registry.js';
import { PromptBuilder } from '../infra/prompt-builder.js';
import { ModelClient } from '../infra/model-client/index.js';
import { mapLLMErrorToClient } from '../infra/model-client/errors.js';
import { SafetyGuard } from '../infra/safety-guard.js';
import { ResponseParser } from '../infra/response-parser.js';
import { FallbackHandler } from '../infra/fallback-handler.js';
import { ConversationService } from '../../services/conversation/index.js';
import { z } from 'zod';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Review #4: Zod schema for validating model-output structured question JSON.
const StructuredQuestionOutputSchema = z.object({
  type: z.enum(['choice', 'fill_blank', 'true_false', 'short_answer', 'proof']),
  difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  content: z.string().min(1),
  options: z.array(z.object({
    label: z.string(),
    text: z.string(),
    isCorrect: z.boolean(),
  })).optional(),
  answer: z.string(),
  approach: z.string().optional(),
  explanation: z.string(),
  knowledgePoints: z.array(z.string()),
  quality: z.enum(['good', 'poor']),
});

/**
 * 预警类型（写入 `safety_alerts.type`）。比 spec §3.1 的三类多一个 `abusive`：
 * `SafetyGuard.detectAnomalyType` 的返回类型是 `AnomalyType`（含 `abusive`），
 * anomaly 分支把 `alertPayload.type` 原样透传到这里，不收窄就无法通过 `tsc`；
 * `SafetyAlertsService.messageFor('abusive')` 也已覆盖（→ 敏感文案），与
 * `pickGentleBlockMessage` 的 abusive→sensitive 约定同源。运行时不可达（检测器不发它）。
 */
export type SafetyAlertSignalType = 'off_topic' | 'emotional' | 'sensitive' | 'abusive';

/**
 * 预警写入的抽象（spec §3.1）。实现在 `modules/safety/SafetyAlertsService`，
 * 由 `ai.module.ts` 的 factory 注入 —— ai-core 不依赖 Nest/DB。
 * **约定：`record` 同步返回且永不抛**（实现方负责吞错）。
 */
export interface SafetyAlertSink {
  record(input: {
    studentId: number;
    dialogueId: number | null;
    type: SafetyAlertSignalType;
    level: 'info' | 'warning' | 'critical';
    message: string;
    context: string | null;
  }): void;
}

export interface TutoringCapabilityDeps {
  modelClient?: ModelClient;
  safetyAlerts?: SafetyAlertSink;
}

/**
 * 面向家长的文案表（spec §3.4）。⚠️ 与 `modules/safety/safety-alerts.service.ts` 的
 * `SafetyAlertsService.messageFor` **逐字一致** —— 两份文案在两个文件里，将来一定会漂，
 * 所以 `tutoring.capability.test.ts` 有一条「真实调用 `messageFor` 逐字比对」的钉子。
 */
const PARENT_MESSAGE: Record<SafetyAlertSignalType, string> = {
  off_topic: '检测到孩子在学习中发起了与学习无关的闲聊',
  emotional: '检测到孩子出现情绪发泄类输入',
  sensitive: '检测到敏感内容输入，建议尽快关注',
  // abusive 与 messageFor 同源：复用敏感文案
  abusive: '检测到敏感内容输入，建议尽快关注',
};

/**
 * 模型自报的闲聊标记（spec §3.2）：HTML 注释形式（学生端渲染不可见）。
 * - **检测**只认「最后一个非空行、且该行只有标记」（`OFF_TOPIC_MARKER_LINE`，不带
 *   `m`/`g`，逐行做全等判断）—— 中段独占一行、或夹在句子中间的标记都**不**判闲聊。
 * - **剥离**则删掉所有**独占一行**的标记（不管它在第几行），保证标记永不进学生可见
 *   内容与历史。夹在句子中间的（非独占一行）不匹配、保持原样。
 */
const OFF_TOPIC_MARKER_LINE = /^[ \t]*<!--\s*topic:off\s*-->[ \t]*$/;
/**
 * 全局剥离：只删**独占一行**的标记，连同其**前导**换行；后随换行由 `(?=\n|$)` 保留，
 * 以维持正文行结构（`第一段\n<!--M-->\n第二段` → `第一段\n第二段`）。
 */
const OFF_TOPIC_MARKER_STRIP = /(?:^|\n)[ \t]*<!--\s*topic:off\s*-->[ \t]*(?=\n|$)/g;

/** 标记是否落在「最后一个非空行」且独占该行（spec §3.2）。 */
function isOffTopicMarkerOnLastLine(content: string): boolean {
  const trimmed = content.trimEnd();
  return OFF_TOPIC_MARKER_LINE.test(trimmed.slice(trimmed.lastIndexOf('\n') + 1));
}

// Result of the shared pre-model prepare() step. shortCircuit = fallback/block
// (persistence already done, ready to return/yield). stream = ready to call the
// model (non-stream or streaming).
type PreparedResult =
  | { kind: 'shortCircuit'; content: string; response: TutoringResponse }
  | {
      kind: 'stream';
      promptResult: { messages: ChatMessage[]; estimatedTokens: number; templateVersion: string };
      routeResult: RouteResult;
      context: { consecutiveFailCount: number };
      userAttachments: { type: 'image'; url: string }[] | undefined;
    };

export class TutoringCapability {
  private modelRouter: ModelRouter;
  private promptBuilder: PromptBuilder;
  private modelClient: ModelClient;
  private safetyGuard: SafetyGuard;
  private responseParser: ResponseParser;
  private fallbackHandler: FallbackHandler;
  private conversationService: ConversationService;
  /** 预警 sink；未接线（脚本/测试）时为 undefined，`recordSafetySignals` 静默跳过。 */
  private safetyAlerts?: SafetyAlertSink;

  constructor(conversationService: ConversationService, deps?: TutoringCapabilityDeps) {
    this.modelRouter = new ModelRouter(getModelConfigRegistry());
    this.promptBuilder = new PromptBuilder(resolve(__dirname, '../prompts'));
    this.modelClient = deps?.modelClient ?? new ModelClient();
    this.safetyGuard = new SafetyGuard();
    this.responseParser = new ResponseParser();
    this.fallbackHandler = new FallbackHandler({
      promptBuilder: this.promptBuilder,
      modelClient: this.modelClient,
      modelRouter: this.modelRouter,
    });
    this.conversationService = conversationService;
    this.safetyAlerts = deps?.safetyAlerts;
  }

  async tutor(request: TutoringRequest): Promise<TutoringResponse> {
    const prepared = await this.prepare(request);
    if (prepared.kind === 'shortCircuit') {
      return prepared.response;
    }
    const dialogueId = request.dialogueId!;  // prepare() threw if missing

    // Step 6: Call model (non-streaming; ModelClient.chat aggregates internally).
    const chatResponse = await this.modelClient.chat({
      model: prepared.routeResult.primary,
      messages: prepared.promptResult.messages,
      temperature: 0.7,
      timeout: timeoutConfig.timeout.tutoring ?? timeoutConfig.timeout.default,
    });

    // Step 7: Parse + strip structured-question JSON block + 闲聊标记。
    const { content, structuredQuestion, offTopic } = this.parseContent(chatResponse.content);

    // Step 8: Persist. Step 9: update fail count.
    await this.conversationService.saveMessages({
      dialogueId,
      messages: [
        { role: 'user', content: request.message, attachments: prepared.userAttachments },
        { role: 'assistant', content, reasoning: chatResponse.reasoningContent, type: 'socratic', model: prepared.routeResult.primary.modelId, safetyFlag: offTopic },
      ],
    });
    // 模型自报闲聊 → 写预警（不阻断）。与 `tutorStream` 共用同一入口。
    if (offTopic) {
      this.recordSafetySignals({
        studentId: request.studentId,
        dialogueId,
        type: 'off_topic',
        level: 'warning',
        studentMessage: request.message,
      });
    }
    const isAnswerWrong = this.detectWrongAnswer(content);
    await this.conversationService.updateFailCount({ dialogueId, increment: isAnswerWrong });

    return {
      dialogueId,
      message: { role: 'assistant', content, type: 'socratic' },
      reasoning: chatResponse.reasoningContent,
      safety: { isLearningRelated: true, alertLevel: 'none' },
      isFallback: false,
      consecutiveFailCount: prepared.context.consecutiveFailCount + (isAnswerWrong ? 1 : 0),
      structuredQuestion,
    };
  }

  /**
   * Streaming tutor: yields reasoning + content deltas as the model generates
   * them, then a `done` event. Fallback/block short-circuits emit a single
   * content chunk + done. The structured-question JSON block is stripped via a
   * final `replace` content event so the UI never keeps the raw JSON.
   */
  async *tutorStream(request: TutoringRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const prepared = await this.prepare(request);
    if (prepared.kind === 'shortCircuit') {
      yield { type: 'content', delta: prepared.content };
      yield { type: 'done', fallback: prepared.response.isFallback };
      return;
    }
    const dialogueId = request.dialogueId!;  // prepare() threw if missing

    // P2: on retry the user message is already persisted (from the failed
    // attempt) - skip re-persisting it; only the assistant reply is stored.
    const userMessage = request.retry
      ? null
      : { role: 'user' as const, content: request.message, attachments: prepared.userAttachments };

    // streamChat is NOT wrapped in callWithRetry (mid-stream retry would
    // duplicate tokens) - errors are handled here. `signal` lets the HTTP layer
    // abort the upstream LLM fetch when the client disconnects (stop button).
    let content = '';
    let reasoning = '';
    try {
      for await (const chunk of this.modelClient.streamChat({
        model: prepared.routeResult.primary,
        messages: prepared.promptResult.messages,
        temperature: 0.7,
        timeout: timeoutConfig.timeout.tutoring ?? timeoutConfig.timeout.default,
        signal,
      })) {
        if (chunk.reasoningContent) {
          reasoning += chunk.reasoningContent;
          yield { type: 'reasoning', delta: chunk.reasoningContent };
        }
        if (chunk.content) {
          content += chunk.content;
          yield { type: 'content', delta: chunk.content };
        }
      }
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      if (isAbort) {
        // User clicked stop - persist partial content for context continuity,
        // but do NOT surface an error (the user initiated the stop). On retry,
        // the user message is already stored, so persist the assistant partial only.
        const abortAssistant = { role: 'assistant' as const, content: content || '[生成中断]', reasoning, type: 'socratic' as const, model: prepared.routeResult.primary.modelId };
        await this.conversationService.saveMessages({
          dialogueId,
          messages: userMessage ? [userMessage, abortAssistant] : [abortAssistant],
        }).catch(() => {});
        return;
      }
      // Model error - on reload the last user message shows as awaiting retry
      // (decision 11: error replies are not persisted as a final answer). BUT if
      // the model already streamed reasoning/partial content before failing
      // (e.g. an idle timeout mid-thinking), keep that partial assistant turn so
      // the student can still read it and the next question retains context.
      // On retry the user message is already stored, so persist nothing extra.
      const partialAssistant = reasoning || content
        ? { role: 'assistant' as const, content: content || '[生成中断]', reasoning, type: 'socratic' as const, model: prepared.routeResult.primary.modelId }
        : null;
      if (partialAssistant) {
        await this.conversationService.saveMessages({
          dialogueId,
          messages: userMessage ? [userMessage, partialAssistant] : [partialAssistant],
        }).catch(() => {});
      } else if (userMessage) {
        await this.conversationService.saveMessages({
          dialogueId,
          messages: [userMessage],
        }).catch(() => {});
      }
      const info = mapLLMErrorToClient(err);
      yield { type: 'error', code: info.code, message: info.message, retryable: info.retryable };
      return;
    }

    // Step 7: strip structured-question JSON block + 闲聊标记 from displayed content.
    const { content: finalContent, structuredQuestion, offTopic } = this.parseContent(content);
    if (finalContent !== content) {
      // Replace the streamed (raw) content with the cleaned version.
      yield { type: 'content', delta: finalContent, replace: true };
    }

    // Step 8-9: persist + fail count. On retry, the user message is already
    // stored, so persist the assistant reply only.
    const finalAssistant = { role: 'assistant' as const, content: finalContent, reasoning, type: 'socratic' as const, model: prepared.routeResult.primary.modelId, safetyFlag: offTopic };
    await this.conversationService.saveMessages({
      dialogueId,
      messages: userMessage ? [userMessage, finalAssistant] : [finalAssistant],
    });
    const isAnswerWrong = this.detectWrongAnswer(finalContent);
    await this.conversationService.updateFailCount({ dialogueId, increment: isAnswerWrong });

    // 模型自报闲聊 → 写预警（不阻断）。放在 `done` 之前，与 `tutor` 共用同一入口。
    if (offTopic) {
      this.recordSafetySignals({
        studentId: request.studentId,
        dialogueId,
        type: 'off_topic',
        level: 'warning',
        studentMessage: request.message,
      });
    }

    yield { type: 'done', fallback: false, structuredQuestion };
  }

  /** Replace the last user message's content with a multimodal array (text +
   *  image_url parts) so the tutoring model receives images directly. */
  private augmentWithImages(messages: ChatMessage[], attachments: Attachment[]): void {
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    if (!lastUserMsg) return;
    const textContent = typeof lastUserMsg.content === 'string'
      ? lastUserMsg.content
      : lastUserMsg.content.filter(p => p.type === 'text').map(p => (p as TextPart).text).join('\n');
    const parts: ContentPart[] = [{ type: 'text', text: textContent }];
    for (const att of attachments) {
      if (att.type === 'image' && att.imageUrl) {
        parts.push({ type: 'image_url', image_url: { url: att.imageUrl } });
      }
      if (att.type === 'file' && att.extractedImages) {
        for (const img of att.extractedImages) {
          parts.push({ type: 'image_url', image_url: { url: img } });
        }
      }
    }
    lastUserMsg.content = parts;
  }

  // Shared pre-model steps (loadContext / fallback / safety / route / build
  // prompt / multimodal augment). Returns a short-circuit result (fallback or
  // block, persistence already done) or a "ready to call/stream" state.
  private async prepare(request: TutoringRequest): Promise<PreparedResult> {
    if (!request.dialogueId) {
      throw new Error('dialogueId is required - call ConversationService.createDialogue first');
    }
    const dialogueId = request.dialogueId;

    // Durable image URLs to persist with the user message (for history replay).
    // Only the server URL is kept - base64 imageUrl is too large to store.
    const userAttachments = request.attachments
      ?.filter((a) => a.type === 'image' && !!a.url)
      .map((a) => ({ type: 'image' as const, url: a.url }));

    // True when an image attachment (with a resolved base64 data URL) is present.
    // Used for multimodal routing and to relax the off-topic safety check.
    const hasImage = !!(request.attachments && request.attachments.some(a =>
      (a.type === 'image' && a.imageUrl) ||
      (a.type === 'file' && a.extractedImages && a.extractedImages.length > 0)
    ));

    // Step 1: Load context (used for safety history, fallback, and the prompt).
    const context = await this.conversationService.loadContext(dialogueId, 3000);
    if (!context) {
      throw new Error(`Dialogue not found: ${dialogueId}`);
    }

    // Step 2: Check fallback conditions BEFORE the safety block. A stuck student
    // asking for help (give-up keywords like "太难了", "不知道") must reach the
    // fallback full-explanation, not be blocked as off_topic by the keyword
    // classifier (those keywords don't match any learning pattern).
    if (
      request.forceFallback ||
      context.consecutiveFailCount >= fallbackConfig.fallback.consecutiveFailThreshold ||
      this.isGiveUpMessage(request.message)
    ) {
      const knowledgePoint = context.currentKnowledgePoint
        ? { id: context.currentKnowledgePoint.id, name: context.currentKnowledgePoint.name, subject: context.subject }
        : { id: 'unknown', name: '当前知识点', subject: context.subject };

      const fallbackResult = await this.fallbackHandler.handle({
        studentId: request.studentId,
        dialogueId,
        knowledgePoint,
        question: context.currentQuestion,
        dialogueHistory: context.messages,
        track: request.mode,
      });

      await this.conversationService.saveMessages({
        dialogueId,
        messages: [
          { role: 'user', content: request.message, attachments: userAttachments },
          { role: 'assistant', content: fallbackResult.content, reasoning: fallbackResult.reasoning, type: 'fallback' },
        ],
      });
      await this.conversationService.updateFailCount({ dialogueId, increment: false });
      await this.conversationService.completeDialogue({ dialogueId });

      return {
        kind: 'shortCircuit',
        content: fallbackResult.content,
        response: {
          dialogueId,
          message: { role: 'assistant', content: fallbackResult.content, type: 'fallback' },
          reasoning: fallbackResult.reasoning,
          safety: { isLearningRelated: true, alertLevel: 'none' },
          isFallback: true,
          consecutiveFailCount: 0,
        },
      };
    }

    // Step 3: Safety check (for non-give-up messages). Persist the user's
    // off-topic message too, so countConsecutiveOffTopic can escalate over
    // repeated blocks (otherwise the count stays 0 and alerts never fire).
    const safetyResult = await this.safetyGuard.check({
      studentId: request.studentId,
      message: request.message,
      dialogueHistory: context.messages,
      track: request.mode,
      hasImage,
    });

    if (safetyResult.shouldBlock) {
      const blockResponse = safetyResult.blockResponse ?? '请专注于学习内容，有不懂的随时问老师。';
      await this.conversationService.saveMessages({
        dialogueId,
        messages: [
          { role: 'user', content: request.message, attachments: userAttachments },
          { role: 'assistant', content: blockResponse, type: 'block' },
        ],
      });
      // 硬阻断后只剩 anomaly（情绪 / 敏感 / 辱骂）会走到这里 —— `alertPayload` 是
      // safety-guard 专门构造的预警数据，本批是它**第一次**被真正消费（spec §2.2）。
      // 写预警在 `saveMessages` 之后、且不阻断返回（整段在 recordSafetySignals 里吞错）。
      if (safetyResult.alertPayload) {
        const alert = safetyResult.alertPayload;
        this.recordSafetySignals({
          studentId: alert.studentId,
          dialogueId,
          type: alert.type,
          // anomaly 分支的 level 恒为 'warning' | 'critical'（safety-guard.ts），
          // 但 `SafetyAlert.level` 的类型是更宽的 `AlertLevel`（含 'none'）——
          // 显式收窄到 sink 接受的集合（'none' 不是 safety_alerts.level 的合法值）。
          level: alert.level === 'critical' ? 'critical' : 'warning',
          studentMessage: alert.message,
        });
      }
      return {
        kind: 'shortCircuit',
        content: blockResponse,
        response: {
          dialogueId,
          message: { role: 'assistant', content: blockResponse, type: 'block' },
          safety: { isLearningRelated: false, alertLevel: safetyResult.alertLevel },
          isFallback: false,
          consecutiveFailCount: 0,
        },
      };
    }

    // Step 4: Route model. The tutoring route is multimodal (qwen3.8-max), so
    // hasImage no longer switches models; it is only forwarded for uniformity.
    const routeResult = await this.modelRouter.route({
      scene: 'tutoring',
      subject: context.subject,
      difficulty: context.currentDifficulty,
      hasImage,
    });

    // Step 5: Build prompt. Augment user message with extracted text from
    // file attachments so the LLM sees the attachment content inline.
    let userMessage = request.message;
    const fileAttachments = request.attachments?.filter(a => a.type === 'file' && a.extractedText) ?? [];
    for (const fa of fileAttachments) {
      userMessage += fa.fileName
        ? `\n\n---\n附件内容（${fa.fileName}）：\n${fa.extractedText}`
        : `\n\n---\n附件内容：\n${fa.extractedText}`;
    }
    const promptResult = await this.promptBuilder.build({
      capability: 'tutoring',
      subject: context.subject,
      track: request.mode,
      context: {
        student: context.student,
        cardContent: context.cardContent,
        knowledgePoint: context.currentKnowledgePoint,
        dialogueHistory: context.messages,
        userMessage,
      },
    });

    // Task 14a: When image attachments are present, replace the last user
    // message's content with a multimodal array (text + image_url parts) so the
    // OpenAI-compatible API receives the image and the multimodal tutoring model
    // (qwen3.8-max) handles it directly.
    if (hasImage && request.attachments) {
      this.augmentWithImages(promptResult.messages, request.attachments);
    }

    return { kind: 'stream', promptResult, routeResult, context, userAttachments };
  }

  // Step 7 helper: parse + strip the structured-question JSON block and the
  // model's self-reported off-topic marker from the reply, so neither the
  // displayed content nor the persisted history contains them.
  private parseContent(rawContent: string): {
    content: string;
    structuredQuestion?: StructuredQuestionOutput;
    offTopic: boolean;
  } {
    const parsed = this.responseParser.parse({ rawContent, mode: 'text' });
    let content = parsed.rawText ?? rawContent;

    // 先剥标记（它比 JSON 块更靠后，且闲聊轮次不会有 JSON 块）。
    // 检测：只认「最后一个非空行独占」（spec §3.2）—— 位置不合法（中段/内联）不判闲聊。
    // 剥离：凡是**独占一行**的标记都删掉（不管在第几行），标记永不进学生可见内容与历史。
    const offTopic = isOffTopicMarkerOnLastLine(content);
    const stripped = content.replace(OFF_TOPIC_MARKER_STRIP, '');
    if (stripped !== content) {
      content = stripped.replace(/\n{3,}/g, '\n\n').trim();
    }

    let structuredQuestion: StructuredQuestionOutput | undefined;
    const jsonBlock = this.responseParser.extractJsonBlock(content);
    if (jsonBlock) {
      const result = StructuredQuestionOutputSchema.safeParse(jsonBlock);
      if (result.success) {
        structuredQuestion = result.data;
        content = this.responseParser.stripJsonBlock(content);
      }
    }
    return { content, structuredQuestion, offTopic };
  }

  /**
   * 写一条预警。**整段 try/catch + 同步调用**（spec §6 不变量：预警写入永不阻断主链路）。
   * `tutor` / `tutorStream` / `prepare` 三处共用这**唯一**入口，别各写一份。
   */
  private recordSafetySignals(input: {
    studentId: string;
    dialogueId: string;
    type: SafetyAlertSignalType;
    level: 'info' | 'warning' | 'critical';
    studentMessage: string;
  }): void {
    const sink = this.safetyAlerts;
    if (!sink) return;                       // 未接线（测试/脚本）→ 静默跳过
    try {
      const studentId = Number(input.studentId);
      if (!Number.isFinite(studentId)) return;
      const dialogueId = Number(input.dialogueId);
      sink.record({
        studentId,
        dialogueId: Number.isFinite(dialogueId) ? dialogueId : null,
        type: input.type,
        level: input.level,
        message: PARENT_MESSAGE[input.type],
        context: input.studentMessage.slice(0, 200),
      });
    } catch (err) {
      // sink 本身永不抛；这里是双保险
      console.warn('[tutoring] 预警写入失败（已忽略）:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Generate a short conversation title (<=15 chars) from the user's question
   * + assistant reply. Routed via the `title` scene: local model first (no
   * external dependency), falling back to deepseek-flash. If BOTH fail the
   * title is left unchanged (the student renames it manually) - deliberately
   * no text-derived fallback. Returns null for a greeting / no clear question
   * so a later turn can retry.
   */
  async generateTitle(userMessage: string, assistantContent: string): Promise<string | null> {
    const route = this.modelRouter.route({ scene: 'title', subject: 'math' });
    const candidates = [route.primary, route.fallback].filter(
      (m): m is NonNullable<typeof route.primary> => !!m,
    );
    if (candidates.length === 0) return null;
    const prompt = `根据学生的提问，生成一个不超过15字的对话标题，概括问题主题。
- 只是打招呼、闲聊、或无法判断具体问题时，回复：NONE
- 只返回标题文字，不要引号、不要解释、不要句号
学生提问：${userMessage}
助手回复摘要：${assistantContent.slice(0, 200)}`;
    let lastErr: unknown;
    for (const model of candidates) {
      try {
        const res = await this.modelClient.chat({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          maxTokens: 256,
          timeout: 15000,
        });
      const title = (res.content || '').trim().replace(/^[\s"'""']+|[\s"'""']+$/g, '');
      if (!title || title.toUpperCase() === 'NONE') return null;
      return title.slice(0, 20);
      } catch (err) {
        lastErr = err;
      }
    }
    // Both title-route models failed: leave the title unchanged (caller keeps
    // the default; the student can rename it manually). No text fallback.
    console.warn(
      '[tutoring] title generation failed on all title-route models:',
      lastErr instanceof Error ? lastErr.message : lastErr,
    );
    return null;
  }

  private isGiveUpMessage(message: string): boolean {
    return fallbackConfig.fallback.giveUpKeywords.some(kw => message.includes(kw));
  }

  private detectWrongAnswer(response: string): boolean {
    const wrongIndicators = [/不对/, /再想想/, /不完全/, /有误/, /错了/];
    return wrongIndicators.some(p => p.test(response));
  }
}
