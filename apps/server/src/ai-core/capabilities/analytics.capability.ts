import { z } from 'zod';
import type { AnalyticsRequest, AnalyticsResponse } from '../types.js';
import { timeoutConfig } from '../config.js';
import { ModelRouter } from '../infra/model-router.js';
import { PromptBuilder } from '../infra/prompt-builder.js';
import { ModelClient } from '../infra/model-client/index.js';
import { ResponseParser } from '../infra/response-parser.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const AnalyticsResponseSchema = z.object({
  reportTitle: z.string(),
  summary: z.string(),
  highlights: z.array(z.object({
    icon: z.string(),
    title: z.string(),
    description: z.string(),
  })),
  weakPointAnalysis: z.string(),
  suggestions: z.array(z.string()),
  encouragement: z.string(),
});

export interface AnalyticsCapabilityDeps {
  modelClient?: ModelClient;
}

export class AnalyticsCapability {
  private modelRouter = new ModelRouter();
  private promptBuilder: PromptBuilder;
  private modelClient: ModelClient;
  private responseParser = new ResponseParser();

  constructor(deps?: AnalyticsCapabilityDeps) {
    this.promptBuilder = new PromptBuilder(resolve(__dirname, '../prompts'));
    this.modelClient = deps?.modelClient ?? new ModelClient();
  }

  async generateReport(request: AnalyticsRequest): Promise<AnalyticsResponse> {
    const routeResult = this.modelRouter.route({
      scene: 'analysis',
      subject: request.subject,
    });

    // Pass `stats` as a real object (not dotted-string keys) so the template's
    // {{stats.totalStudyMinutes}} nested lookups and {{#stats.topWeakPoints}} section
    // resolve correctly via Mustache.
    const promptResult = await this.promptBuilder.build({
      capability: 'analysis',
      subject: request.subject,
      context: {
        student: { grade: '', gradeLevel: '' },
        userMessage: '',
        customVariables: {
          studentId: request.studentId,
          subject: request.subject,
          period: request.period,
          stats: request.stats,
        },
      },
    });

    const chatResponse = await this.modelClient.chat({
      model: routeResult.primary,
      messages: promptResult.messages,
      responseFormat: 'json_object',
      timeout: timeoutConfig.timeout.analysis ?? timeoutConfig.timeout.default,
    });

    const parseResult = this.responseParser.parse<AnalyticsResponse>({
      rawContent: chatResponse.content,
      mode: 'json',
      schema: AnalyticsResponseSchema,
    });

    if (!parseResult.success || !parseResult.data) {
      throw new Error(`Analytics parse failed: ${parseResult.errors?.join(', ')}`);
    }

    return parseResult.data;
  }
}
