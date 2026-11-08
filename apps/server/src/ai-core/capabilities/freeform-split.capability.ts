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
 * 单题 schema。`content` 必须非空（空题无意义）；其余字段给整套默认值——
 * 切题是弱结构化任务，模型漏字段不代表切错，宁可保下来让学生自己挑。
 */
const CandidateSchema = z.object({
  no: z.string().max(20).default(''),
  content: z.string().min(1),
  figureRefs: z.array(z.string()).default([]),
  suggestedSubject: z.enum(['math', 'physics', 'chemistry']).nullable().default(null),
  confidence: z.number().min(0).max(1).default(0.8),
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
}
export interface FreeformSplitDeps {
  modelClient?: ModelClient;
  modelRouter?: ModelRouter;
}

/**
 * 自由输入做题入口的第一步：MinerU Markdown → 候选题列表。
 *
 * 场景 `freeform_split`：primary=local（Qwen3.8-27B），fallback=qwen3.8-max。
 * 本地 JSON 坏 / 抛错都回退千问；两路都失败才抛 `freeform split failed`，
 * 由调用方决定降级（不在这里静默返回空列表——空列表会被误当成「图里没有题」）。
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
    const subject: Subject = req.subjectHint ?? 'math';
    const prompt = await this.promptBuilder.build({
      capability: 'freeform_split',
      subject,
      context: {
        student: { grade: '', gradeLevel: '' },
        userMessage: req.textHint ?? '切题',
        customVariables: {
          markdown: req.markdown,
          textHint: req.textHint ?? '',
          subjectHint: subject,
        },
      },
    });
    const route = this.router.route({ scene: 'freeform_split', subject });
    const models = [route.primary, route.fallback].filter(Boolean) as typeof route.primary[];
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
