import { z } from 'zod';
import type { ChineseMeaningJudgeRequest, ChineseMeaningJudgeResponse } from '../types.js';
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
 * `terms` 用 `.default([])`、`meaning` / `emotion` 用 `.nullable().optional()`：
 * **模型漏项不视为解析失败**——漏的那些项由调用方标 `undetermined`，
 * 已判的项照常返回。全漏也只是解析成功。
 */
const ChineseMeaningJudgeResultSchema = z.object({
  terms: z.array(z.object({
    term: z.string(),
    correct: z.boolean(),
    comment: z.string().nullable().optional(),
  })).default([]),
  meaning: z.object({
    correct: z.boolean(),
    comment: z.string().nullable().optional(),
  }).nullable().optional(),
  emotion: z.object({
    correct: z.boolean(),
    comment: z.string().nullable().optional(),
  }).nullable().optional(),
});

export interface ChineseMeaningJudgeCapabilityDeps {
  modelClient?: ModelClient;
}

/**
 * 语文古诗文「含义」判题能力。
 *
 * 与 InterpretationJudgeCapability 的差别：调用方**没有**程序短路（本专项不做
 * 归一化全等短路），所以送进来的项全部是真正需要语义判断的。
 *
 * 场景 `chinese_meaning_judge`：primary=local（Qwen3.8-27B），fallback=deepseek-flash。
 * 两个模型都失败（或 JSON 解析失败）→ **抛错**，由调用方兜底为逐项 `undetermined`，
 * 不阻断学生看到「已判的项」。
 *
 * ⚠️ 本类**故意不写 `@Injectable()`** —— 与 ai-core/capabilities/* 其它类一致
 * （零参实例化，避开 Nest 对接口类型可选参数发 design:paramtypes 的 DI 坑）。
 */
export class ChineseMeaningJudgeCapability {
  private modelRouter = new ModelRouter(getModelConfigRegistry());
  private promptBuilder: PromptBuilder;
  private modelClient: ModelClient;
  private responseParser = new ResponseParser();

  constructor(deps?: ChineseMeaningJudgeCapabilityDeps) {
    this.promptBuilder = new PromptBuilder(resolve(__dirname, '../prompts'));
    this.modelClient = deps?.modelClient ?? new ModelClient();
  }

  async generate(request: ChineseMeaningJudgeRequest): Promise<ChineseMeaningJudgeResponse> {
    const routeResult = this.modelRouter.route({ scene: 'chinese_meaning_judge', subject: 'chinese' });
    const timeout = timeoutConfig.timeout.chinese_meaning_judge ?? timeoutConfig.timeout.default;

    const promptResult = await this.promptBuilder.build({
      capability: 'chinese_meaning_judge',
      subject: 'chinese',
      context: {
        student: { grade: '', gradeLevel: '' },
        userMessage: '请判定以上作答。',
        customVariables: {
          workTitle: request.workTitle,
          sentence: request.sentence,
          standardTranslation: request.standardTranslation,
          standardMeaning: request.standardMeaning,
          standardEmotion: request.standardEmotion,
          studentMeaning: request.studentMeaning,
          studentEmotion: request.studentEmotion,
          terms: request.terms.map((t) => ({ term: t.term, gloss: t.gloss, answer: t.answer })),
        },
      },
    });

    const callOnce = async (model: typeof routeResult.primary): Promise<ChineseMeaningJudgeResponse> => {
      const chatResponse = await this.modelClient.chat({
        model,
        messages: promptResult.messages,
        responseFormat: 'json_object',
        timeout,
        // 判题是短判定任务，不需要 thinking。本地端点只认 chat_template_kwargs
        // （`thinking: false` 对 llama.cpp 无效），实测关掉后 13–16s -> 1–2s。
        // 只对本地 provider 下发：fallback 是云端 deepseek，收到未知字段可能直接 400。
        ...(model.provider === 'local' ? { extraBody: LLAMA_CPP_NO_THINKING_BODY } : {}),
      });

      const parsed = this.responseParser.parse<ChineseMeaningJudgeResponse>({
        rawContent: chatResponse.content,
        mode: 'json',
        schema: ChineseMeaningJudgeResultSchema,
      });
      if (!parsed.success || !parsed.data) {
        throw new Error(`Chinese meaning judge parse failed: ${parsed.errors?.join(', ')}`);
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
