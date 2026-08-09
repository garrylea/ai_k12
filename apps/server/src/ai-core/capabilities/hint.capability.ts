import type { HintRequest, HintResponse } from '../types.js';
import { timeoutConfig } from '../config.js';
import { ModelRouter } from '../infra/model-router.js';
import { PromptBuilder } from '../infra/prompt-builder.js';
import { ModelClient } from '../infra/model-client/index.js';
import { ResponseParser } from '../infra/response-parser.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface HintCapabilityDeps {
  modelClient?: ModelClient;
}

/**
 * 课堂练习「提示」能力 - 苏格拉底式启发，只给方向/思路，绝不给答案。
 *
 * 与 ExplanationCapability（错题完整解析）的区别：本能力在学生作答前给轻量启发，
 * 遵循 CLAUDE.md 规则 6（hint/discuss 比 show answer 更突出）。提示生成后由
 * PracticeService.getHint 写回 cards.hints 缓存，命中即复用，省 AI。
 */
export class HintCapability {
  private modelRouter = new ModelRouter();
  private promptBuilder: PromptBuilder;
  private modelClient: ModelClient;
  private responseParser = new ResponseParser();

  constructor(deps?: HintCapabilityDeps) {
    this.promptBuilder = new PromptBuilder(resolve(__dirname, '../prompts'));
    this.modelClient = deps?.modelClient ?? new ModelClient();
  }

  async generate(request: HintRequest): Promise<HintResponse> {
    const routeResult = this.modelRouter.route({
      scene: 'hint',
      subject: request.subject,
    });

    const promptResult = await this.promptBuilder.build({
      capability: 'hint',
      subject: request.subject,
      context: {
        student: { grade: '', gradeLevel: '' },
        question: { content: request.questionContent },
        userMessage: '请给我一个提示',
      },
    });

    const chatResponse = await this.modelClient.chat({
      model: routeResult.primary,
      messages: promptResult.messages,
      timeout: timeoutConfig.timeout.hint ?? timeoutConfig.timeout.default,
    });

    const parsed = this.responseParser.parse({
      rawContent: chatResponse.content,
      mode: 'text',
    });

    return {
      content: parsed.rawText ?? chatResponse.content,
      reasoning: chatResponse.reasoningContent,
    };
  }
}
