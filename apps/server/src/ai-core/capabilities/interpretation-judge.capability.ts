import { z } from 'zod';
import type { InterpretationJudgeRequest, InterpretationJudgeResponse } from '../types.js';
import { timeoutConfig } from '../config.js';
import { ModelRouter } from '../infra/model-router.js';
import { getModelConfigRegistry } from '../infra/model-config-registry.js';
import { PromptBuilder } from '../infra/prompt-builder.js';
import { ModelClient, LLAMA_CPP_NO_THINKING_BODY } from '../infra/model-client/index.js';
import { ResponseParser } from '../infra/response-parser.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * `terms` 用 `.default([])`、`sentence` 用 `.nullable().optional()`：
 * **模型漏项不视为解析失败**——漏的那些项由调用方标 `undetermined`，
 * 已判的项照常返回（设计 spec §7 第 3 条「已判定的项不清空」）。
 * 全漏才会得到 `{terms: [], sentence: null}`，仍是解析成功。
 */
const InterpretationJudgeResultSchema = z.object({
  terms: z.array(z.object({
    term: z.string(),
    correct: z.boolean(),
    comment: z.string().nullable().optional(),
  })).default([]),
  sentence: z.object({
    correct: z.boolean(),
    comment: z.string().nullable().optional(),
  }).nullable().optional(),
});

export interface InterpretationJudgeCapabilityDeps {
  modelClient?: ModelClient;
}

/**
 * 语文古诗文「解释（翻译）」判题能力。
 *
 * 与 JudgmentCapability（数学题判题）的区别不只是学科：本能力的调用方
 * （`TrainingService.judgeInterpretation`）**已经用程序短路掉了能确定的项**
 * （空答案 → unanswered；归一化全等 → exact），送进来的只有「意思对不对」这一档
 * 非要语义判断不可的项——所以本能力的输出永远只是「补判」，不是完整判定。
 *
 * 场景 `interpretation_judge`：primary=local（Qwen3.8-27B），fallback=deepseek-flash。
 * 两个模型都失败（或 JSON 解析失败）→ **抛错**，由调用方兜底为逐项 `undetermined`，
 * 不阻断学生看到「已判的项」。这与 DictationFeedbackCapability 的约定一致。
 */
export class InterpretationJudgeCapability {
  private modelRouter = new ModelRouter(getModelConfigRegistry());
  private promptBuilder: PromptBuilder;
  private modelClient: ModelClient;
  private responseParser = new ResponseParser();

  constructor(deps?: InterpretationJudgeCapabilityDeps) {
    this.promptBuilder = new PromptBuilder(resolve(__dirname, '../prompts'));
    this.modelClient = deps?.modelClient ?? new ModelClient();
  }

  async generate(request: InterpretationJudgeRequest): Promise<InterpretationJudgeResponse> {
    const routeResult = this.modelRouter.route({ scene: 'interpretation_judge', subject: 'chinese' });
    const timeout = timeoutConfig.timeout.interpretation_judge ?? timeoutConfig.timeout.default;

    const promptResult = await this.promptBuilder.build({
      capability: 'interpretation_judge',
      subject: 'chinese',
      context: {
        student: { grade: '', gradeLevel: '' },
        userMessage: '请判定以上作答。',
        customVariables: {
          workTitle: request.workTitle,
          sentence: request.sentence,
          standardTranslation: request.standardTranslation,
          studentTranslation: request.studentTranslation,
          terms: request.terms.map((t) => ({ term: t.term, gloss: t.gloss, answer: t.answer })),
        },
      },
    });

    const callOnce = async (model: typeof routeResult.primary): Promise<InterpretationJudgeResponse> => {
      const chatResponse = await this.modelClient.chat({
        model,
        messages: promptResult.messages,
        // JSON 输出：本地 LocalClient 保留 response_format（它只删 enable_thinking）
        responseFormat: 'json_object',
        timeout,
        // 判题是短判定任务，不需要 thinking。本地端点只认 chat_template_kwargs
        // （`thinking: false` 对 llama.cpp 无效），实测关掉后 13–16s -> 1–2s。
        // 只对本地 provider 下发：fallback 是云端 deepseek，收到未知字段可能直接 400；
        // 也**不传 `thinking: false`**——云端 fallback 留着思考，判题质量更稳。
        ...(model.provider === 'local' ? { extraBody: LLAMA_CPP_NO_THINKING_BODY } : {}),
      });

      const parsed = this.responseParser.parse<InterpretationJudgeResponse>({
        rawContent: chatResponse.content,
        mode: 'json',
        schema: InterpretationJudgeResultSchema,
      });
      if (!parsed.success || !parsed.data) {
        throw new Error(`Interpretation judge parse failed: ${parsed.errors?.join(', ')}`);
      }
      return { ...parsed.data, reasoning: chatResponse.reasoningContent };
    };

    try {
      return await callOnce(routeResult.primary);
    } catch (err) {
      if (!routeResult.fallback) throw err;
      return await callOnce(routeResult.fallback);
    }
  }
}
