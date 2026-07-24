import type { TutoringRequest, TutoringResponse } from '../types.js';
import { fallbackConfig } from '../config.js';
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
    const dialogueId = request.dialogueId ?? `dialogue_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Step 1: Safety check
    const recentHistory = this.conversationService.loadContext(dialogueId, 2000)?.messages ?? [];
    const safetyResult = await this.safetyGuard.check({
      studentId: request.studentId,
      message: request.message,
      dialogueHistory: recentHistory,
      track: request.mode,
    });

    if (safetyResult.shouldBlock) {
      this.conversationService.saveMessages({
        dialogueId,
        messages: [{ role: 'assistant', content: safetyResult.blockResponse!, type: 'block' }],
      });
      return {
        dialogueId,
        message: { role: 'assistant', content: safetyResult.blockResponse!, type: 'block' },
        safety: { isLearningRelated: false, alertLevel: safetyResult.alertLevel },
        isFallback: false,
        consecutiveFailCount: 0,
      };
    }

    // Step 2: Load context
    const context = this.conversationService.loadContext(dialogueId, 3000);
    if (!context) {
      throw new Error(`Dialogue not found: ${dialogueId}`);
    }

    // Step 3: Check fallback conditions
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

      this.conversationService.saveMessages({
        dialogueId,
        messages: [{ role: 'assistant', content: fallbackResult.content, type: 'fallback' }],
      });
      this.conversationService.updateFailCount({ dialogueId, increment: false });
      this.conversationService.completeDialogue({ dialogueId, reason: 'fallback_triggered' });

      return {
        dialogueId,
        message: { role: 'assistant', content: fallbackResult.content, type: 'fallback' },
        safety: { isLearningRelated: true, alertLevel: 'none' },
        isFallback: true,
        consecutiveFailCount: 0,
      };
    }

    // Step 4: Route model
    const routeResult = await this.modelRouter.route({
      scene: 'tutoring',
      subject: context.subject,
      difficulty: context.currentDifficulty,
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

    // Step 6: Call model
    const chatResponse = await this.modelClient.chat({
      model: routeResult.primary,
      messages: promptResult.messages,
      temperature: 0.7,
    });

    // Step 7: Parse response
    const parsed = this.responseParser.parse({ rawContent: chatResponse.content, mode: 'text' });

    // Step 8: Persist messages
    this.conversationService.saveMessages({
      dialogueId,
      messages: [
        { role: 'user', content: request.message },
        { role: 'assistant', content: parsed.rawText!, type: 'socratic', model: routeResult.primary.modelId },
      ],
    });

    // Step 9: Update fail count
    const isAnswerWrong = this.detectWrongAnswer(parsed.rawText!);
    this.conversationService.updateFailCount({ dialogueId, increment: isAnswerWrong });

    return {
      dialogueId,
      message: { role: 'assistant', content: parsed.rawText!, type: 'socratic' },
      safety: { isLearningRelated: true, alertLevel: 'none' },
      isFallback: false,
      consecutiveFailCount: context.consecutiveFailCount + (isAnswerWrong ? 1 : 0),
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
