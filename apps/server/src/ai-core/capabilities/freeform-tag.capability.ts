import { z } from 'zod';
import { timeoutConfig } from '../config.js';
import { ModelRouter } from '../infra/model-router.js';
import { getModelConfigRegistry } from '../infra/model-config-registry.js';
import { PromptBuilder } from '../infra/prompt-builder.js';
import { ModelClient } from '../infra/model-client/index.js';
import { ResponseParser } from '../infra/response-parser.js';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TYPES = ['choice', 'multi_choice', 'fill_blank', 'true_false', 'short_answer', 'proof', 'calculation'] as const;

const TagSchema = z.object({
  type: z.enum(TYPES),
  difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  answer: z.string(),
  explanation: z.string(),
  approach: z.string().nullable().optional(),
  options: z
    .array(z.object({ label: z.string(), text: z.string(), isCorrect: z.boolean() }))
    .nullable()
    .optional(),
  knowledgePointIds: z.array(z.number()).default([]),
  confidence: z.enum(['high', 'medium', 'low']).default('low'),
});

export type FreeformTagResult = z.infer<typeof TagSchema> & {
  approach: string | null;
  options: Array<{ label: string; text: string; isCorrect: boolean }> | null;
};

export interface FreeformTagRequest {
  question: string;
  subjectId: number;
  subjectName: string;
  gradeBand: 'primary' | 'junior' | 'senior';
  knowledgePointOptions: Array<{ id: number; name: string }>;
}

const EMPTY: FreeformTagResult = {
  type: 'short_answer',
  difficulty: 1,
  answer: '',
  explanation: '',
  approach: null,
  options: null,
  knowledgePointIds: [],
  confidence: 'low',
};

export interface FreeformTagCapabilityDeps {
  modelClient?: ModelClient;
}

/** 学科无关的做题题目标注器。刻意不写 @Injectable()（零参可实例化）。 */
export class FreeformTagCapability {
  private modelRouter = new ModelRouter(getModelConfigRegistry());
  private promptBuilder: PromptBuilder;
  private modelClient: ModelClient;
  private parser = new ResponseParser();

  constructor(deps?: FreeformTagCapabilityDeps) {
    this.promptBuilder = new PromptBuilder(resolve(__dirname, '../prompts'));
    this.modelClient = deps?.modelClient ?? new ModelClient();
  }

  async tag(request: FreeformTagRequest): Promise<FreeformTagResult> {
    const allowed = new Set(request.knowledgePointOptions.map((k) => k.id));
    const optionsText =
      request.knowledgePointOptions.map((k) => `${k.id}: ${k.name}`).join('\n') || '（无）';
    try {
      const prompt = await this.promptBuilder.build({
        capability: 'freeform_tag',
        subject: 'math',
        context: {
          student: { grade: '', gradeLevel: '' },
          userMessage: request.question,
          customVariables: {
            subjectName: request.subjectName,
            gradeBand: request.gradeBand,
            question: request.question,
            knowledgePointOptions: optionsText,
          },
        },
      });
      const route = this.modelRouter.route({ scene: 'structuring', subject: 'math' });
      const candidates = [route.primary, route.fallback].filter(Boolean) as typeof route.primary[];
      let lastErr: unknown = null;
      for (const model of candidates) {
        try {
          const res = await this.modelClient.chat({
            model,
            messages: prompt.messages,
            responseFormat: 'json_object',
            timeout: timeoutConfig.timeout.structuring ?? timeoutConfig.timeout.default,
          });
          // 模型常把 JSON 包进 ```json 围栏；用统一解析器（含围栏提取 + 常见修复）
          const parsedResult = this.parser.parse<unknown>({
            rawContent: res.content,
            mode: 'json',
            schema: TagSchema,
            defaultResult: EMPTY,
          });
          if (!parsedResult.success || !parsedResult.data) throw new Error('tag JSON 解析失败');
          const parsed = TagSchema.parse(parsedResult.data);
          return {
            ...parsed,
            approach: parsed.approach ?? null,
            options: parsed.options ?? null,
            // 只保留候选清单内的 id：去重 + 限 3 个
            knowledgePointIds: [...new Set(parsed.knowledgePointIds)]
              .filter((id) => allowed.has(id))
              .slice(0, 3),
          };
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr ?? new Error('no model available');
    } catch (err) {
      console.warn(`[freeform-tag] failed: ${err instanceof Error ? err.message : String(err)}`);
      return { ...EMPTY };
    }
  }
}
