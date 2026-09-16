import { z } from 'zod';
import type { EnglishWordJudgeRequest, EnglishWordJudgeResponse } from '../types.js';
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
 * 三档 `verdict` 全收，由能力层按模式收敛（见 `generate` 里的 common → off_target 处理）。
 * `comment` 用 `.nullable().optional()`：判对时模型不给 comment 是正常的，不算解析失败。
 */
const EnglishWordJudgeResultSchema = z.object({
  verdict: z.enum(['correct', 'off_target', 'wrong']),
  comment: z.string().nullable().optional(),
});

export interface EnglishWordJudgeCapabilityDeps {
  modelClient?: ModelClient;
}

/**
 * 英语背单词判题能力（英→中方向的语义判定）。
 *
 * 与 `InterpretationJudgeCapability` 同构，差别在于判的是「一个词的一个义项」：
 *   调用方（`VocabularyService.judge`）**已经用程序短路掉了能确定的作答**
 *   （空答案 → unanswered；与释义原子归一化全等 → exact；中→英方向则完全不进来），
 *   送进来的只有「意思对不对」这一档非语义判断不可的。
 *
 * 场景 `english_word_judge`：primary=local（Qwen3.8-27B），fallback=deepseek-flash。
 * 两者都失败（或 JSON 解析失败）→ **抛错**，由调用方兜底为 `undetermined`。
 * `undetermined` 不计对错、不写任何错题统计——判题失败不该让学生背锅。
 */
export class EnglishWordJudgeCapability {
  private modelRouter = new ModelRouter(getModelConfigRegistry());
  private promptBuilder: PromptBuilder;
  private modelClient: ModelClient;
  private responseParser = new ResponseParser();

  constructor(deps?: EnglishWordJudgeCapabilityDeps) {
    this.promptBuilder = new PromptBuilder(resolve(__dirname, '../prompts'));
    this.modelClient = deps?.modelClient ?? new ModelClient();
  }

  async generate(request: EnglishWordJudgeRequest): Promise<EnglishWordJudgeResponse> {
    const routeResult = this.modelRouter.route({ scene: 'english_word_judge', subject: 'english' });
    const timeout = timeoutConfig.timeout.english_word_judge ?? timeoutConfig.timeout.default;
    const isExtended = request.mode === 'extended';

    const promptResult = await this.promptBuilder.build({
      capability: 'english_word_judge',
      subject: 'english',
      context: {
        student: { grade: '', gradeLevel: '' },
        userMessage: '请判定以上作答。',
        customVariables: {
          word: request.word,
          phonetic: request.phonetic ?? null,
          isExtended,
          context: request.context,
          targetPos: request.target.pos,
          targetGloss: request.target.gloss,
          otherGlosses: request.otherGlosses,
          // Mustache 的 section 对数组是「迭代」而不是「判空」，所以空/非空另用布尔标志，
          // 否则「该词的其他义项」这一段的标题会被打印 N 次（每个义项一次）。
          hasOtherGlosses: request.otherGlosses.length > 0,
          studentAnswer: request.studentAnswer,
          allowedVerdicts: isExtended ? '`correct` / `off_target` / `wrong`' : '`correct` / `wrong`',
        },
      },
    });

    const callOnce = async (model: typeof routeResult.primary): Promise<EnglishWordJudgeResponse> => {
      const chatResponse = await this.modelClient.chat({
        model,
        messages: promptResult.messages,
        // JSON 输出：本地 LocalClient 保留 response_format（它只删 enable_thinking）
        responseFormat: 'json_object',
        timeout,
        // 判题是短判定任务，不需要 thinking。本地端点只认 chat_template_kwargs
        // （`thinking: false` 对 llama.cpp 是空操作），实测关掉后 13–16s → 1–2s。
        // 只对本地 provider 下发：fallback 是云端 deepseek，收到未知字段可能直接 400；
        // 也**不传 `thinking: false`**——云端 fallback 留着思考，判题质量更稳。
        ...(model.provider === 'local' ? { extraBody: LLAMA_CPP_NO_THINKING_BODY } : {}),
      });

      const parsed = this.responseParser.parse<EnglishWordJudgeResponse>({
        rawContent: chatResponse.content,
        mode: 'json',
        schema: EnglishWordJudgeResultSchema,
      });
      if (!parsed.success || !parsed.data) {
        throw new Error(`English word judge parse failed: ${parsed.errors?.join(', ')}`);
      }
      const { verdict, comment } = parsed.data;
      return {
        // common 模式下没有「考哪个义项」的问题，模型仍可能顺手输出 off_target；
        // 收敛成 wrong，免得把「答了别的义项」在普通背词里放行。
        verdict: !isExtended && verdict === 'off_target' ? 'wrong' : verdict,
        comment: comment ?? null,
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
