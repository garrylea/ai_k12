import { z } from 'zod';
import type { QuestionStructuringRequest, StructuredQuestion, Subject } from '../types.js';
import { timeoutConfig } from '../config.js';
import { ModelRouter } from '../infra/model-router.js';
import { getModelConfigRegistry } from '../infra/model-config-registry.js';
import { PromptBuilder } from '../infra/prompt-builder.js';
import { ModelClient } from '../infra/model-client/index.js';
import { ResponseParser } from '../infra/response-parser.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const StructuredQuestionSchema = z.object({
  type: z.enum(['choice', 'fill_blank', 'true_false', 'short_answer', 'proof']),
  difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  content: z.string(),
  options: z.array(z.object({
    label: z.string(),
    text: z.string(),
    isCorrect: z.boolean(),
  })).optional(),
  answer: z.string(),
  explanation: z.string(),
  knowledgePoints: z.array(z.string()),
  quality: z.enum(['good', 'poor']),
  qualityIssues: z.array(z.string()).optional(),
});

function createDefaultResult(): StructuredQuestion {
  return {
    type: 'short_answer',
    difficulty: 1,
    content: '',
    answer: '',
    explanation: '',
    knowledgePoints: [],
    quality: 'poor',
    qualityIssues: ['JSON 解析失败'],
  };
}

export interface QuestionStructuringCapabilityDeps {
  modelClient?: ModelClient;
}

export class QuestionStructuringCapability {
  private modelRouter = new ModelRouter(getModelConfigRegistry());
  private promptBuilder: PromptBuilder;
  private modelClient: ModelClient;
  private responseParser = new ResponseParser();

  constructor(deps?: QuestionStructuringCapabilityDeps) {
    this.promptBuilder = new PromptBuilder(resolve(__dirname, '../prompts'));
    this.modelClient = deps?.modelClient ?? new ModelClient();
  }

  async structure(request: QuestionStructuringRequest): Promise<StructuredQuestion> {
    const subjectHint = request.subjectHint ?? 'math';
    const subject: Subject = subjectHint === 'chinese' || subjectHint === 'english' ? subjectHint : 'math';
    const gradeBand = request.gradeBand ?? 'junior';

    const promptResult = await this.promptBuilder.build({
      capability: 'structuring',
      subject,
      context: {
        student: { grade: '', gradeLevel: '' },
        userMessage: request.rawInput,
        customVariables: {
          rawInput: request.rawInput,
          inputType: request.inputType,
          subjectHint,
          gradeBand,
        },
      },
    });

    const routeResult = this.modelRouter.route({ scene: 'structuring', subject });
    const chatResponse = await this.modelClient.chat({
      model: routeResult.primary,
      messages: promptResult.messages,
      responseFormat: 'json_object',
      timeout: timeoutConfig.timeout.structuring ?? timeoutConfig.timeout.default,
    });

    const parsed = this.responseParser.parse<StructuredQuestion>({
      rawContent: chatResponse.content,
      mode: 'json',
      schema: StructuredQuestionSchema,
      defaultResult: createDefaultResult(),
    });

    if (!parsed.success || !parsed.data) {
      const result = createDefaultResult();
      if (parsed.errors && parsed.errors.length > 0) {
        result.qualityIssues = ['JSON 解析失败', ...parsed.errors];
      }
      return result;
    }
    return parsed.data;
  }
}
