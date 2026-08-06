import type { TutoringRequest, TutoringResponse, StructuredQuestionOutput, ContentPart, ChatMessage, RouteResult, StreamEvent } from '../types.js';
import { timeoutConfig, fallbackConfig } from '../config.js';
import { ModelRouter } from '../infra/model-router.js';
import { PromptBuilder } from '../infra/prompt-builder.js';
import { ModelClient } from '../infra/model-client/index.js';
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
  explanation: z.string(),
  knowledgePoints: z.array(z.string()),
  quality: z.enum(['good', 'poor']),
});

export interface TutoringCapabilityDeps {
  modelClient?: ModelClient;
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

  constructor(conversationService: ConversationService, deps?: TutoringCapabilityDeps) {
    this.modelRouter = new ModelRouter();
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

    // Step 7: Parse + strip structured-question JSON block.
    const { content, structuredQuestion } = this.parseContent(chatResponse.content);

    // Step 8: Persist. Step 9: update fail count.
    await this.conversationService.saveMessages({
      dialogueId,
      messages: [
        { role: 'user', content: request.message, attachments: prepared.userAttachments },
        { role: 'assistant', content, reasoning: chatResponse.reasoningContent, type: 'socratic', model: prepared.routeResult.primary.modelId },
      ],
    });
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
      // Best-effort persist of partial content, then surface the error.
      await this.conversationService.saveMessages({
        dialogueId,
        messages: [
          { role: 'user', content: request.message, attachments: prepared.userAttachments },
          { role: 'assistant', content: content || '[生成中断]', reasoning, type: 'socratic', model: prepared.routeResult.primary.modelId },
        ],
      }).catch(() => {});
      yield { type: 'error', message: err instanceof Error ? err.message : '生成失败' };
      return;
    }

    // Step 7: strip structured-question JSON block from displayed content.
    const { content: finalContent, structuredQuestion } = this.parseContent(content);
    if (finalContent !== content) {
      // Replace the streamed (raw) content with the cleaned version.
      yield { type: 'content', delta: finalContent, replace: true };
    }

    // Step 8-9: persist + fail count.
    await this.conversationService.saveMessages({
      dialogueId,
      messages: [
        { role: 'user', content: request.message, attachments: prepared.userAttachments },
        { role: 'assistant', content: finalContent, reasoning, type: 'socratic', model: prepared.routeResult.primary.modelId },
      ],
    });
    const isAnswerWrong = this.detectWrongAnswer(finalContent);
    await this.conversationService.updateFailCount({ dialogueId, increment: isAnswerWrong });

    yield { type: 'done', fallback: false, structuredQuestion };
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
    const hasImage = !!(request.attachments && request.attachments.some(a => a.type === 'image' && a.imageUrl));

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

    // Step 4: Route model. Task 14a: when attachments contain images, route to
    // qwen-vl-max (multimodal) instead of the text-only model (hasImage computed above).
    const routeResult = await this.modelRouter.route({
      scene: 'tutoring',
      subject: context.subject,
      difficulty: context.currentDifficulty,
      hasImage,
    });

    // Step 5: Build prompt
    const promptResult = await this.promptBuilder.build({
      capability: 'tutoring',
      subject: context.subject,
      track: request.mode,
      context: {
        student: context.student,
        cardContent: context.cardContent,
        knowledgePoint: context.currentKnowledgePoint,
        dialogueHistory: context.messages,
        userMessage: request.message,
      },
    });

    // Task 14a: When image attachments are present, replace the last user
    // message's content with a multimodal array (text + image_url parts).
    // The prompt builder produces a text user message; we augment it with
    // image_url parts so the OpenAI-compatible API receives the image.
    if (hasImage && request.attachments) {
      const lastUserMsg = [...promptResult.messages].reverse().find(m => m.role === 'user');
      if (lastUserMsg) {
        const textContent = typeof lastUserMsg.content === 'string'
          ? lastUserMsg.content
          : lastUserMsg.content.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('\n');
        const parts: ContentPart[] = [{ type: 'text', text: textContent }];
        for (const att of request.attachments) {
          if (att.type === 'image' && att.imageUrl) {
            parts.push({ type: 'image_url', image_url: { url: att.imageUrl } });
          }
        }
        lastUserMsg.content = parts;
      }
    }

    return { kind: 'stream', promptResult, routeResult, context, userAttachments };
  }

  // Step 7 helper: parse + strip the structured-question JSON block from the
  // model reply so history doesn't contain raw JSON.
  private parseContent(rawContent: string): { content: string; structuredQuestion?: StructuredQuestionOutput } {
    const parsed = this.responseParser.parse({ rawContent, mode: 'text' });
    let content = parsed.rawText ?? rawContent;
    let structuredQuestion: StructuredQuestionOutput | undefined;
    const jsonBlock = this.responseParser.extractJsonBlock(content);
    if (jsonBlock) {
      const result = StructuredQuestionOutputSchema.safeParse(jsonBlock);
      if (result.success) {
        structuredQuestion = result.data;
        content = this.responseParser.stripJsonBlock(content);
      }
    }
    return { content, structuredQuestion };
  }

  /**
   * Generate a short conversation title (<=15 chars) from the user's question
   * + assistant reply, using a cheap model (deepseek-v4-flash). Returns null
   * if the message is just a greeting / no clear question, so the caller keeps
   * the default temp title and can retry on a later message.
   */
  async generateTitle(userMessage: string, assistantContent: string): Promise<string | null> {
    const model = this.modelRouter.getModel('deepseek-v4-flash');
    if (!model) return null;
    const prompt = `根据学生的提问，生成一个不超过15字的对话标题，概括问题主题。
- 只是打招呼、闲聊、或无法判断具体问题时，回复：NONE
- 只返回标题文字，不要引号、不要解释、不要句号
学生提问：${userMessage}
助手回复摘要：${assistantContent.slice(0, 200)}`;
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
    } catch {
      return null;
    }
  }

  private isGiveUpMessage(message: string): boolean {
    return fallbackConfig.fallback.giveUpKeywords.some(kw => message.includes(kw));
  }

  private detectWrongAnswer(response: string): boolean {
    const wrongIndicators = [/不对/, /再想想/, /不完全/, /有误/, /错了/];
    return wrongIndicators.some(p => p.test(response));
  }
}
