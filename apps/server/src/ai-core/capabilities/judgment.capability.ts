import { z } from 'zod';
import type { JudgmentRequest, JudgmentResult } from '../types.js';
import { timeoutConfig } from '../config.js';
import { ModelRouter } from '../infra/model-router.js';
import { getModelConfigRegistry } from '../infra/model-config-registry.js';
import { PromptBuilder } from '../infra/prompt-builder.js';
import { ModelClient } from '../infra/model-client/index.js';
import { ResponseParser } from '../infra/response-parser.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const JudgmentResultSchema = z.object({
  isCorrect: z.boolean(),
  analysis: z.string().nullable().optional(),
  errorType: z.enum(['logic', 'calculation', 'format', 'missing']).nullable().optional(),
});

export interface JudgmentCapabilityDeps {
  modelClient?: ModelClient;
}

export class JudgmentCapability {
  private modelRouter = new ModelRouter(getModelConfigRegistry());
  private promptBuilder: PromptBuilder;
  private modelClient: ModelClient;
  private responseParser = new ResponseParser();

  constructor(deps?: JudgmentCapabilityDeps) {
    this.promptBuilder = new PromptBuilder(resolve(__dirname, '../prompts'));
    this.modelClient = deps?.modelClient ?? new ModelClient();
  }

  async judge(request: JudgmentRequest): Promise<JudgmentResult> {
    const routeResult = this.modelRouter.route({
      scene: 'judgment',
      subject: request.subject,
    });

    const promptResult = await this.promptBuilder.build({
      capability: 'judgment',
      subject: request.subject,
      questionType: request.questionType,
      context: {
        student: { grade: '', gradeLevel: '' },
        question: {
          content: request.questionContent,
          answer: request.standardAnswer,
          rubric: request.reference,
        },
        studentAnswer: request.studentAnswer,
        userMessage: '请判断对错',
      },
    });

    const chatResponse = await this.modelClient.chat({
      model: routeResult.primary,
      messages: promptResult.messages,
      responseFormat: 'json_object',
      timeout: timeoutConfig.timeout.judgment ?? timeoutConfig.timeout.default,
    });

    const parseResult = this.responseParser.parse<JudgmentResult>({
      rawContent: chatResponse.content,
      mode: 'json',
      schema: JudgmentResultSchema,
    });

    if (!parseResult.success || !parseResult.data) {
      throw new Error(`Judgment parse failed: ${parseResult.errors?.join(', ')}`);
    }

    return { ...parseResult.data, reasoning: chatResponse.reasoningContent };
  }
}
