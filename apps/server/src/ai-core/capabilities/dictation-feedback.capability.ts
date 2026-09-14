import type { DictationFeedbackRequest, DictationFeedbackResponse } from '../types.js';
import { timeoutConfig } from '../config.js';
import { ModelRouter } from '../infra/model-router.js';
import { getModelConfigRegistry } from '../infra/model-config-registry.js';
import { PromptBuilder } from '../infra/prompt-builder.js';
import { ModelClient } from '../infra/model-client/index.js';
import { ResponseParser } from '../infra/response-parser.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface DictationFeedbackCapabilityDeps {
  modelClient?: ModelClient;
}

/**
 * 语文默写「错因」能力。
 *
 * 与 JudgmentCapability 的区别：本能力**不判对错**——对错由 JudgeCoreService.judgeDictation
 * 程序化判定，这里只把程序定位出的错处翻译成学生看得懂的提醒（设计 spec §5 第 5 步）。
 * 场景 dictation_feedback：primary=local（Qwen3.8-27B），fallback=deepseek-flash；
 * 两者都失败时抛错，由调用方（TrainingService）兜底为 feedback=null，不阻断判题。
 */
export class DictationFeedbackCapability {
  private modelRouter = new ModelRouter(getModelConfigRegistry());
  private promptBuilder: PromptBuilder;
  private modelClient: ModelClient;
  private responseParser = new ResponseParser();

  constructor(deps?: DictationFeedbackCapabilityDeps) {
    this.promptBuilder = new PromptBuilder(resolve(__dirname, '../prompts'));
    this.modelClient = deps?.modelClient ?? new ModelClient();
  }

  async generate(request: DictationFeedbackRequest): Promise<DictationFeedbackResponse> {
    const routeResult = this.modelRouter.route({ scene: 'dictation_feedback', subject: 'chinese' });
    const timeout = timeoutConfig.timeout.dictation_feedback ?? timeoutConfig.timeout.default;

    const promptResult = await this.promptBuilder.build({
      capability: 'dictation_feedback',
      subject: 'chinese',
      context: {
        student: { grade: '', gradeLevel: '' },
        userMessage: '请针对以上错处写一段错因提醒。',
        customVariables: {
          workTitle: request.workTitle,
          expected: request.expected,
          student: request.student,
          fieldMatch: request.fieldMatch,
          bodyDiffText: request.bodyDiffText,
        },
      },
    });

    const callOnce = async (model: typeof routeResult.primary) => {
      const chatResponse = await this.modelClient.chat({
        model,
        messages: promptResult.messages,
        timeout,
      });
      const parsed = this.responseParser.parse({ rawContent: chatResponse.content, mode: 'text' });
      return {
        content: (parsed.rawText ?? chatResponse.content ?? '').trim(),
        reasoning: chatResponse.reasoningContent,
      };
    };

    try {
      return await callOnce(routeResult.primary);
    } catch (err) {
      if (!routeResult.fallback) throw err;
      return await callOnce(routeResult.fallback);
    }
  }
}
