import type { TutoringRequest, TutoringResponse, StructuredQuestionOutput, ContentPart } from '../types.js';
import { timeoutConfig, fallbackConfig } from '../config.js';
import { ModelRouter } from '../infra/model-router.js';
import { PromptBuilder } from '../infra/prompt-builder.js';
import { ModelClient } from '../infra/model-client/index.js';
import { SafetyGuard } from '../infra/safety-guard.js';
import { ResponseParser } from '../infra/response-parser.js';
import { FallbackHandler } from '../infra/fallback-handler.js';
import { ConversationService } from '../../services/conversation/index.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface TutoringCapabilityDeps {
  modelClient?: ModelClient;
}

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
    if (!request.dialogueId) {
      throw new Error('dialogueId is required - call ConversationService.createDialogue first');
    }
    const dialogueId = request.dialogueId;

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
          { role: 'user', content: request.message },
          { role: 'assistant', content: fallbackResult.content, type: 'fallback' },
        ],
      });
      await this.conversationService.updateFailCount({ dialogueId, increment: false });
      await this.conversationService.completeDialogue({ dialogueId });

      return {
        dialogueId,
        message: { role: 'assistant', content: fallbackResult.content, type: 'fallback' },
        reasoning: fallbackResult.reasoning,
        safety: { isLearningRelated: true, alertLevel: 'none' },
        isFallback: true,
        consecutiveFailCount: 0,
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
    });

    if (safetyResult.shouldBlock) {
      const blockResponse = safetyResult.blockResponse ?? '请专注于学习内容，有不懂的随时问老师。';
      await this.conversationService.saveMessages({
        dialogueId,
        messages: [
          { role: 'user', content: request.message },
          { role: 'assistant', content: blockResponse, type: 'block' },
        ],
      });
      return {
        dialogueId,
        message: { role: 'assistant', content: blockResponse, type: 'block' },
        safety: { isLearningRelated: false, alertLevel: safetyResult.alertLevel },
        isFallback: false,
        consecutiveFailCount: 0,
      };
    }

    // Step 4: Route model. Task 14a: when attachments contain images, route to
    // qwen-vl-max (multimodal) instead of the text-only model.
    const hasImage = !!(request.attachments && request.attachments.some(a => a.type === 'image' && a.imageUrl));
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

    // Step 6: Call model
    const chatResponse = await this.modelClient.chat({
      model: routeResult.primary,
      messages: promptResult.messages,
      temperature: 0.7,
      timeout: timeoutConfig.timeout.tutoring ?? timeoutConfig.timeout.default,
    });

    // Step 7: Parse response. Task 14a: extract structured question JSON block
    // from the model's reply and strip it from the displayed content.
    const parsed = this.responseParser.parse({ rawContent: chatResponse.content, mode: 'text' });
    let content = parsed.rawText ?? chatResponse.content;
    let structuredQuestion: StructuredQuestionOutput | undefined;
    const jsonBlock = this.responseParser.extractJsonBlock(content);
    if (jsonBlock && typeof jsonBlock === 'object') {
      const obj = jsonBlock as Record<string, unknown>;
      if (obj.type && obj.content && obj.answer) {
        structuredQuestion = {
          type: obj.type as StructuredQuestionOutput['type'],
          difficulty: obj.difficulty as StructuredQuestionOutput['difficulty'],
          content: String(obj.content),
          answer: String(obj.answer),
          explanation: String(obj.explanation ?? ''),
          knowledgePoints: Array.isArray(obj.knowledgePoints) ? (obj.knowledgePoints as string[]) : [],
          quality: (obj.quality as 'good' | 'poor') ?? 'good',
        };
        content = this.responseParser.stripJsonBlock(content);
      }
    }

    // Step 8: Persist messages (user + assistant). The user message is stored
    // as text only (image URLs expire). The assistant content has the JSON
    // block stripped so history doesn't contain raw JSON.
    await this.conversationService.saveMessages({
      dialogueId,
      messages: [
        { role: 'user', content: request.message },
        { role: 'assistant', content, type: 'socratic', model: routeResult.primary.modelId },
      ],
    });

    // Step 9: Update fail count
    const isAnswerWrong = this.detectWrongAnswer(content);
    await this.conversationService.updateFailCount({ dialogueId, increment: isAnswerWrong });

    return {
      dialogueId,
      message: { role: 'assistant', content, type: 'socratic' },
      reasoning: chatResponse.reasoningContent,
      safety: { isLearningRelated: true, alertLevel: 'none' },
      isFallback: false,
      consecutiveFailCount: context.consecutiveFailCount + (isAnswerWrong ? 1 : 0),
      structuredQuestion,
    };
  }

  private isGiveUpMessage(message: string): boolean {
    return fallbackConfig.fallback.giveUpKeywords.some(kw => message.includes(kw));
  }

  private detectWrongAnswer(response: string): boolean {
    const wrongIndicators = [/不对/, /再想想/, /不完全/, /有误/, /错了/];
    return wrongIndicators.some(p => p.test(response));
  }
}
