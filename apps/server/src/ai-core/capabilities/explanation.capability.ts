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
        userMessage: request.mode === 'error_analysis' ? '帮我分析错因' : request.mode === 'knowledge_retry' ? '帮我重新讲解这个知识点' : '生成标准题解',
        customVariables,
      },
    });

    const chatResponse = await this.modelClient.chat({
      model: routeResult.primary,
      messages: promptResult.messages,
      timeout: timeoutConfig.timeout.explanation ?? timeoutConfig.timeout.default,
      // 题目级缓存：生成一次、全生命周期复用、所有学生共享，**不属任何学生**。
      // 显式传 null 压掉 ALS 兜底——该调用来自进程内队列，drain 时可能继承到
      // 别的学生的请求上下文，那样会把这次调用错记到那个学生头上。
      // （scene 由 router 打标为 'explanation'，不必在这里重复。）
      meta: { studentId: null, capability: 'explanation' },
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
