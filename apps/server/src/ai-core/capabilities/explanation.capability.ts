import type { ExplanationRequest } from '../types.js';
import { timeoutConfig } from '../config.js';
import { ModelRouter } from '../infra/model-router.js';
import { getModelConfigRegistry } from '../infra/model-config-registry.js';
import { PromptBuilder } from '../infra/prompt-builder.js';
import { ModelClient } from '../infra/model-client/index.js';
import { ResponseParser } from '../infra/response-parser.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ExplanationResponse {
  content: string;
  mode: 'error_analysis' | 'knowledge_retry' | 'solution';
  reasoning?: string;                // thinking(reasoning_content) for frontend display
}

export interface ExplanationCapabilityDeps {
  modelClient?: ModelClient;
}

export class ExplanationCapability {
  private modelRouter = new ModelRouter(getModelConfigRegistry());
  private promptBuilder: PromptBuilder;
  private modelClient: ModelClient;
  private responseParser = new ResponseParser();

  constructor(deps?: ExplanationCapabilityDeps) {
    this.promptBuilder = new PromptBuilder(resolve(__dirname, '../prompts'));
    this.modelClient = deps?.modelClient ?? new ModelClient();
  }

  async explain(request: ExplanationRequest): Promise<ExplanationResponse> {
    const routeResult = this.modelRouter.route({
      scene: 'explanation',
      subject: request.subject,
    });

    // errorHistory is passed as a real array (not JSON.stringified) so the
    // knowledge-retry template's {{#errorHistory}}...{{/errorHistory}} section
    // iterates over each entry, resolving {{question}}/{{wrongAnswer}}/{{attempts}}
    // per item. A JSON string would render the section once with garbage.
    const customVariables: Record<string, unknown> = { wrongAnswer: request.wrongAnswer };
    if (request.errorHistory) {
      customVariables.errorHistory = request.errorHistory;
    }

    const promptResult = await this.promptBuilder.build({
      capability: 'explanation',
      subject: request.subject,
      mode: request.mode,
      context: {
        student: { grade: '', gradeLevel: '' },
        question: request.question,
        studentAnswer: request.wrongAnswer,
        knowledgePoint: request.knowledgePoint,
        userMessage: request.mode === 'error_analysis' ? '帮我分析错因' : '帮我重新讲解这个知识点',
        customVariables,
      },
    });

    const chatResponse = await this.modelClient.chat({
      model: routeResult.primary,
      messages: promptResult.messages,
      timeout: timeoutConfig.timeout.explanation ?? timeoutConfig.timeout.default,
    });

    const parsed = this.responseParser.parse({
      rawContent: chatResponse.content,
      mode: 'text',
    });

    return {
      content: parsed.rawText ?? chatResponse.content,
      reasoning: chatResponse.reasoningContent,
      mode: request.mode,
    };
  }
}
