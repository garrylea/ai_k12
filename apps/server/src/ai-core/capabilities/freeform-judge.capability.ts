import type { ChatMessage, ContentPart, Subject } from '../types.js';
import { timeoutConfig } from '../config.js';
import { ModelRouter } from '../infra/model-router.js';
import { getModelConfigRegistry } from '../infra/model-config-registry.js';
import { PromptBuilder } from '../infra/prompt-builder.js';
import { ModelClient } from '../infra/model-client/index.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface FreeformJudgeImage { label: string; dataUrl: string }
export interface FreeformJudgeRequest {
  subject: 'math' | 'physics' | 'chemistry';
  maxScore: number;
  questionContent: string;
  studentAnswer: string;
  images: FreeformJudgeImage[];
}
export type FreeformJudgeStreamEvent =
  | { type: 'reasoning'; delta: string }
  | { type: 'content'; delta: string };

/**
 * 做题入口的判题能力：千问流式输出「Markdown 报告 + 尾部一个 JSON 块」。
 *
 * 场景 `freeform_judge`：primary=qwen3.8-max，**无 fallback**（见 model-routes.yaml）——
 * 流式输出没法在两路模型之间拼接，失败就由上层（Task 9/10）报错重试。
 *
 * 图片（题目配图 / 草稿图 / 粘贴图）由调用方转成 dataUrl 传入，这里按 label
 * 逐个拼成 text + image_url 部件追加到最后一条 user 消息；**不改模板**，
 * 也不改 system 消息。
 */
export class FreeformJudgeCapability {
  private router: ModelRouter;
  private promptBuilder: PromptBuilder;
  private client: ModelClient;

  constructor(deps?: { modelClient?: ModelClient; modelRouter?: ModelRouter }) {
    this.router = deps?.modelRouter ?? new ModelRouter(getModelConfigRegistry());
    this.client = deps?.modelClient ?? new ModelClient();
    this.promptBuilder = new PromptBuilder(resolve(__dirname, '../prompts'));
  }

  async *stream(req: FreeformJudgeRequest, signal?: AbortSignal): AsyncIterable<FreeformJudgeStreamEvent> {
    const subject = req.subject as Subject;
    const prompt = await this.promptBuilder.build({
      capability: 'freeform_judge',
      subject,
      context: {
        student: { grade: '', gradeLevel: '' },
        question: { content: req.questionContent, answer: '', rubric: '', material: null },
        studentAnswer: req.studentAnswer,
        customVariables: { maxScore: String(req.maxScore) },
      },
    });
    const route = this.router.route({ scene: 'freeform_judge', subject });

    // 把图片作为 text+image_url 部件追加到最后一条 user 消息
    const messages: ChatMessage[] = prompt.messages.map((m) => ({ ...m }));
    const last = messages[messages.length - 1];
    if (req.images.length > 0) {
      const parts: ContentPart[] = [];
      if (typeof last.content === 'string' && last.content) parts.push({ type: 'text', text: last.content });
      for (const img of req.images) {
        parts.push({ type: 'text', text: `【${img.label}】` });
        parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
      }
      last.content = parts;
    }

    for await (const chunk of this.client.streamChat({
      model: route.primary,
      messages,
      timeout: timeoutConfig.timeout.judgment ?? 90000,
      signal,
    })) {
      if (chunk.reasoningContent) yield { type: 'reasoning', delta: chunk.reasoningContent };
      if (chunk.content) yield { type: 'content', delta: chunk.content };
    }
  }

  /** 流式报告里的 JSON 块坏了时，二次非流式提取（只返回 JSON 对象或 null）。 */
  async extractStructured(req: {
    report: string; questionContent: string; studentAnswer: string; maxScore: number;
  }): Promise<unknown | null> {
    const route = this.router.route({ scene: 'freeform_judge', subject: 'math' });
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `你是结构化提取器。把下面的判题报告整理成 JSON，只输出 JSON，不要代码围栏。
字段：verdict(correct|partial|incorrect)、totalScore、maxScore、steps[{stepNumber,description,score,maxScore,isCorrect,comment,errorType}]、suggestions[]、question{type,difficulty,options,answer,explanation,approach}。
满分固定为 ${req.maxScore}。`,
      },
      {
        role: 'user',
        content: `题目：\n${req.questionContent}\n\n学生作答：\n${req.studentAnswer}\n\n判题报告：\n${req.report}`,
      },
    ];
    try {
      const res = await this.client.chat({
        model: route.primary,
        messages,
        responseFormat: 'json_object',
        thinking: false,
        timeout: 45000,
      });
      // 只认 JSON 对象：字符串 / 数组 / null 都不算提取成功（调用方按 null 降级）。
      const parsed = JSON.parse(res.content) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      return parsed;
    } catch {
      return null;
    }
  }
}
