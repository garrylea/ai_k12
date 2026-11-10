import { z } from 'zod';
import type { Subject } from '../types.js';
import { timeoutConfig } from '../config.js';
import { ModelRouter } from '../infra/model-router.js';
import { getModelConfigRegistry } from '../infra/model-config-registry.js';
import { PromptBuilder } from '../infra/prompt-builder.js';
import { ModelClient } from '../infra/model-client/index.js';
import { ResponseParser } from '../infra/response-parser.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 候选题上限（提示词之外的硬护栏：模型多切/重复切时按顺序截断，不报错）。 */
const MAX_CANDIDATES = 20;

/**
 * 单题 schema。`content` 必须非空（空题无意义）；其余字段一律 `catch` 兜底——
 * 切题是弱结构化任务，模型写错一个字段（`no` 给数字、`confidence` 越界、把提示词里的
 * 联合类型原样抄成字符串）不代表切错，不能让整批候选题因一处瑕疵全部作废。
 */
const CandidateSchema = z.object({
  // 模型可能把题号写成数字 5，统一转字符串并截断。
  no: z.union([z.string(), z.number()]).transform(v => String(v).slice(0, 20)).catch(''),
  content: z.string().min(1),
  figureRefs: z.array(z.string()).catch([]),
  // 枚举外的值（含模型照抄的 `"math" | "physics" | "chemistry" | null"`）落 null。
  suggestedSubject: z.enum(['math', 'physics', 'chemistry']).nullable().catch(null),
  // 越界不算错，夹到 [0, 1]；非数字/缺失落默认 0.8。
  confidence: z.number().transform(v => Math.min(1, Math.max(0, v))).catch(0.8),
  selectedHint: z.boolean().default(false),
});
const ResultSchema = z.object({ questions: z.array(CandidateSchema).min(1) });

export interface FreeformSplitCandidate {
  no: string;
  content: string;
  figureRefs: string[];
  suggestedSubject: 'math' | 'physics' | 'chemistry' | null;
  confidence: number;
  selectedHint: boolean;
}
export interface FreeformSplitRequest {
  markdown: string;
  textHint?: string;
  subjectHint?: 'math' | 'physics' | 'chemistry';
  /**
   * 跳过 primary（本地小模型），直接走 fallback（千问）。
   * 供超长 Markdown 使用：本地模型上下文不够，截断又会丢掉尾部题目。
   */
  preferFallback?: boolean;
}
export interface FreeformSplitDeps {
  modelClient?: ModelClient;
  modelRouter?: ModelRouter;
}

/**
 * 自由输入做题入口的第一步：MinerU Markdown → 候选题列表。
 *
 * 场景 `freeform_split`：primary=local（Qwen3.8-27B），fallback=qwen3.8-max。
 * 本地 JSON 坏 / 抛错都回退千问；`preferFallback` 时跳过本地、只用千问（超长 Markdown）。
 * 两路都失败才抛 `freeform split failed`，由调用方决定降级（不在这里静默返回空列表——
 * 空列表会被误当成「图里没有题」）。
 *
 * 切题**不是解题**：提示词明确禁止给答案，能力层也不做任何判题/补全。
 */
export class FreeformSplitCapability {
  private router: ModelRouter;
  private promptBuilder: PromptBuilder;
  private client: ModelClient;
  private parser = new ResponseParser();

  constructor(deps?: FreeformSplitDeps) {
    this.router = deps?.modelRouter ?? new ModelRouter(getModelConfigRegistry());
    this.client = deps?.modelClient ?? new ModelClient();
    this.promptBuilder = new PromptBuilder(resolve(__dirname, '../prompts'));
  }

  async split(req: FreeformSplitRequest): Promise<FreeformSplitCandidate[]> {
    // `math` 只用于路由（场景需要一个 subject 才能选模板/模型）；
    // 提示词里不能跟着声称数学，否则会把 suggestedSubject 锚定成 math。
    const subject: Subject = req.subjectHint ?? 'math';
    const prompt = await this.promptBuilder.build({
      capability: 'freeform_split',
      subject,
      context: {
        student: { grade: '', gradeLevel: '' },
        customVariables: {
          markdown: req.markdown,
          textHint: req.textHint ?? '',
          subjectHint: req.subjectHint ?? '',
        },
      },
    });
    const route = this.router.route({ scene: 'freeform_split', subject });
    const models = (
      req.preferFallback ? [route.fallback] : [route.primary, route.fallback]
    ).filter(Boolean) as typeof route.primary[];
    if (models.length === 0) {
      // 只有 preferFallback 且场景没配 fallback 时才会走到这里。
      throw new Error('freeform split failed: 没有可用的切题模型');
    }
    let lastErr: unknown;
    for (const model of models) {
      try {
        const res = await this.client.chat({
          model,
          messages: prompt.messages,
          responseFormat: 'json_object',
          thinking: false,
          timeout: timeoutConfig.timeout.structuring ?? 45000,
        });
        const parsed = this.parser.parse<{ questions: FreeformSplitCandidate[] }>({
          rawContent: res.content,
          mode: 'json',
          schema: ResultSchema,
        });
        if (parsed.success && parsed.data) return parsed.data.questions.slice(0, MAX_CANDIDATES);
        lastErr = new Error(parsed.errors?.join(', ') ?? 'empty questions');
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(`freeform split failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
  }
}
