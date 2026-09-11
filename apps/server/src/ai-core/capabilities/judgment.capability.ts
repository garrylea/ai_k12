import { z } from 'zod';
import type { JudgmentRequest, JudgmentResult, RoutedModel, PromptBuildResult } from '../types.js';
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
  /** 可测性：测试注入 mock router，避免依赖全局 ModelConfigRegistry / YAML。 */
  modelRouter?: ModelRouter;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class JudgmentCapability {
  private modelRouter: ModelRouter;
  private promptBuilder: PromptBuilder;
  private modelClient: ModelClient;
  private responseParser = new ResponseParser();

  constructor(deps?: JudgmentCapabilityDeps) {
    this.modelRouter = deps?.modelRouter ?? new ModelRouter(getModelConfigRegistry());
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

    // primary（本地模型）任何失败 -> 回退 fallback（qwen3.8-max）一次。
    try {
      return await this.callModel(routeResult.primary, promptResult);
    } catch (primaryErr) {
      if (!routeResult.fallback) throw primaryErr;
      try {
        return await this.callModel(routeResult.fallback, promptResult);
      } catch (fallbackErr) {
        throw new Error(
          `Judgment failed: primary(${routeResult.primary.modelId})=${errorMessage(primaryErr)}; ` +
          `fallback(${routeResult.fallback.modelId})=${errorMessage(fallbackErr)}`,
        );
      }
    }
  }

  private async callModel(model: RoutedModel, promptResult: PromptBuildResult): Promise<JudgmentResult> {
    const chatResponse = await this.modelClient.chat({
      model,
      messages: promptResult.messages,
      responseFormat: 'json_object',
      thinking: false,
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
