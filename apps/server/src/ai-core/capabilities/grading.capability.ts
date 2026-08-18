import { z } from 'zod';
import type { GradingRequest, GradingResult } from '../types.js';
import { timeoutConfig } from '../config.js';
import { ModelRouter } from '../infra/model-router.js';
import { getModelConfigRegistry } from '../infra/model-config-registry.js';
import { PromptBuilder } from '../infra/prompt-builder.js';
import { ModelClient } from '../infra/model-client/index.js';
import { ResponseParser } from '../infra/response-parser.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const GradingResultSchema = z.object({
  totalScore: z.number(),
  maxScore: z.number(),
  steps: z.array(z.object({
    stepNumber: z.number(),
    description: z.string(),
    score: z.number(),
    maxScore: z.number(),
    isCorrect: z.boolean(),
    comment: z.string(),
    errorType: z.enum(['logic', 'calculation', 'format', 'missing']).nullable().optional(),
  })),
  feedback: z.string(),
  suggestions: z.array(z.string()),
});

export interface GradingCapabilityDeps {
  modelClient?: ModelClient;
}

export class GradingCapability {
  private modelRouter = new ModelRouter(getModelConfigRegistry());
  private promptBuilder: PromptBuilder;
  private modelClient: ModelClient;
  private responseParser = new ResponseParser();

  constructor(deps?: GradingCapabilityDeps) {
    this.promptBuilder = new PromptBuilder(resolve(__dirname, '../prompts'));
    this.modelClient = deps?.modelClient ?? new ModelClient();
  }

  async grade(request: GradingRequest): Promise<GradingResult> {
    const routeResult = this.modelRouter.route({
      scene: 'grading',
      subject: request.subject,
    });

    const promptResult = await this.promptBuilder.build({
      capability: 'grading',
      subject: request.subject,
      questionType: request.questionType,
      context: {
        student: { grade: '', gradeLevel: '' },
        question: {
          content: request.questionContent,
          answer: request.standardAnswer,
          rubric: request.rubric,
        },
        studentAnswer: request.studentAnswer,
        userMessage: '请批改',
        customVariables: { maxScore: String(request.maxScore) },
      },
    });

    // First attempt
    const chatResponse = await this.modelClient.chat({
      model: routeResult.primary,
      messages: promptResult.messages,
      responseFormat: 'json_object',
      timeout: timeoutConfig.timeout.grading ?? timeoutConfig.timeout.default,
    });

    const parseResult = this.responseParser.parse<GradingResult>({
      rawContent: chatResponse.content,
      mode: 'json',
      schema: GradingResultSchema,
    });

    if (!parseResult.success || !parseResult.data) {
      throw new Error(`Grading parse failed: ${parseResult.errors?.join(', ')}`);
    }

    // Validate total score: step sum should be within 20% of totalScore, else retry on fallback model.
    // If the retry call or its parse fails, fall through and return the original
    // (suspicious but usable) result rather than throwing away a parseable answer.
    if (this.needsRetry(parseResult.data) && routeResult.fallback) {
      try {
        const retryResponse = await this.modelClient.chat({
          model: routeResult.fallback,
          messages: promptResult.messages,
          responseFormat: 'json_object',
          timeout: timeoutConfig.timeout.grading ?? timeoutConfig.timeout.default,
        });
        const retryResult = this.responseParser.parse<GradingResult>({
          rawContent: retryResponse.content,
          mode: 'json',
          schema: GradingResultSchema,
        });
        if (retryResult.success && retryResult.data) {
          return { ...retryResult.data, reasoning: retryResponse.reasoningContent };
        }
      } catch {
        // Retry failed (network error or non-retryable upstream) - return original below.
      }
    }

    return { ...parseResult.data, reasoning: chatResponse.reasoningContent };
  }

  needsRetry(result: GradingResult): boolean {
    const stepSum = result.steps.reduce((sum, s) => sum + s.score, 0);
    // Use totalScore as the denominator when stepSum is 0: all steps wrong but
    // a non-zero totalScore is itself a contradiction worth retrying. (Avoids
    // 0/0 NaN and the previous false-negative that suppressed retry.)
    const denominator = stepSum === 0 ? result.totalScore : stepSum;
    if (denominator === 0) return false;
    const deviation = Math.abs(stepSum - result.totalScore) / denominator;
    return deviation > 0.2;
  }
}
