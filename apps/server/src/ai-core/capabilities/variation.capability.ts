import { z } from 'zod';
import type { VariationRequest, VariationResponse, VariationQuestion } from '../types.js';
import { timeoutConfig } from '../config.js';
import { ModelRouter } from '../infra/model-router.js';
import { getModelConfigRegistry } from '../infra/model-config-registry.js';
import { PromptBuilder } from '../infra/prompt-builder.js';
import { ModelClient } from '../infra/model-client/index.js';
import { ResponseParser } from '../infra/response-parser.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const VariationSchema = z.object({
  variations: z.array(z.object({
    content: z.string(),
    options: z.array(z.object({
      label: z.string(),
      text: z.string(),
      isCorrect: z.boolean(),
    })).optional(),
    answer: z.string(),
    explanation: z.string(),
    difficulty: z.number().min(1).max(3),
    variationType: z.enum(['换数', '换场景', '调整条件', '组合']),
  })),
});

export interface VariationCapabilityDeps {
  modelClient?: ModelClient;
}

export class VariationCapability {
  private modelRouter = new ModelRouter(getModelConfigRegistry());
  private promptBuilder: PromptBuilder;
  private modelClient: ModelClient;
  private responseParser = new ResponseParser();

  constructor(deps?: VariationCapabilityDeps) {
    this.promptBuilder = new PromptBuilder(resolve(__dirname, '../prompts'));
    this.modelClient = deps?.modelClient ?? new ModelClient();
  }

  async generate(request: VariationRequest): Promise<VariationResponse> {
    const routeResult = this.modelRouter.route({
      scene: 'variation',
      subject: 'math',
    });

    const promptResult = await this.promptBuilder.build({
      capability: 'variation',
      subject: 'math',
      context: {
        student: { grade: '', gradeLevel: '' },
        question: { content: request.originalQuestion.content, answer: request.originalQuestion.answer },
        knowledgePoint: request.knowledgePoint,
        userMessage: '',
        customVariables: {
          count: String(request.count),
          difficulty: String(request.targetDifficulty ?? request.originalQuestion.difficulty ?? 2),
        },
      },
    });

    const chatResponse = await this.modelClient.chat({
      model: routeResult.primary,
      messages: promptResult.messages,
      responseFormat: 'json_object',
      timeout: timeoutConfig.timeout.variation ?? timeoutConfig.timeout.default,
    });

    const parseResult = this.responseParser.parse<{ variations: VariationQuestion[] }>({
      rawContent: chatResponse.content,
      mode: 'json',
      schema: VariationSchema,
    });

    if (!parseResult.success || !parseResult.data) {
      throw new Error(`Variation parse failed: ${parseResult.errors?.join(', ')}`);
    }

    return {
      variations: parseResult.data.variations,
      generatedBy: routeResult.primary.modelId,
      reasoning: chatResponse.reasoningContent,
    };
  }
}
