import { z } from 'zod';
import type { GradingRequest, GradingResult } from '../types.js';
import { ModelRouter } from '../infra/model-router.js';
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
  private modelRouter = new ModelRouter();
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
    });

    const parseResult = this.responseParser.parse<GradingResult>({
      rawContent: chatResponse.content,
      mode: 'json',
      schema: GradingResultSchema,
    });

    if (!parseResult.success || !parseResult.data) {
      throw new Error(`Grading parse failed: ${parseResult.errors?.join(', ')}`);
    }

    // Validate total score: step sum should be within 20% of totalScore, else retry on fallback model
    if (this.needsRetry(parseResult.data) && routeResult.fallback) {
      const retryResponse = await this.modelClient.chat({
        model: routeResult.fallback,
        messages: promptResult.messages,
        responseFormat: 'json_object',
      });
      const retryResult = this.responseParser.parse<GradingResult>({
        rawContent: retryResponse.content,
        mode: 'json',
        schema: GradingResultSchema,
      });
      if (retryResult.success && retryResult.data) {
        return retryResult.data;
      }
    }

    return parseResult.data;
  }

  needsRetry(result: GradingResult): boolean {
    const stepSum = result.steps.reduce((sum, s) => sum + s.score, 0);
    if (stepSum === 0) return false;
    const deviation = Math.abs(stepSum - result.totalScore) / stepSum;
    return deviation > 0.2;
  }
}
