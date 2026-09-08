import { Injectable, Logger } from '@nestjs/common';
import { QuestionsRepository } from '../../database/repositories/questions.repo.js';
import { ExplanationCapability } from '../../ai-core/capabilities/explanation.capability.js';
import type { QuestionRow } from '../../database/repositories/types.js';

/** 解析缓存生成并发上限：防判错风暴打爆强模型。 */
const QUEUE_CONCURRENCY = 2;
/** answer 达到该长度视为「过程性题解」，直接直写不入库 LLM（PRD/试卷参考答案常为完整过程）。 */
const ANSWER_AS_SOLUTION_MIN_LEN = 100;

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then((v) => { clearTimeout(t); resolve(v); })
      .catch(() => { clearTimeout(t); resolve(fallback); });
  });
}

/**
 * 判题解析缓存：判错后后台生成解析入库（一次性生成、全生命周期复用）。
 * 进程内队列（并发 ≤2）+ in-flight 去重；explanation 空才生成 -> 失败自然下次重试。
 * 局限：进程内，重启丢在途；多实例会重复生成（当前单实例，见 spec §4.1）。
 */
@Injectable()
export class ExplanationCacheService {
  private readonly logger = new Logger(ExplanationCacheService.name);
  private readonly queue: number[] = [];
  private running = 0;
  /** questionId -> 在途生成 promise（enqueue 时立即注册；waitFor/waitExplanation await 它） */
  private readonly inFlight = new Map<number, Promise<string | null>>();
  /** questionId -> 启动器：drain 拿到并发名额时才真正执行 generate */
  private readonly starters = new Map<number, () => void>();

  constructor(
    private readonly questionsRepo: QuestionsRepository,
    private readonly explanation: ExplanationCapability,
  ) {}

  /** 判错分支调用：fire-and-forget。q 只用 id/answer/explanation 三个字段。 */
  ensureExplanation(q: Pick<QuestionRow, 'id' | 'answer' | 'explanation'>): void {
    if (q.explanation?.trim()) return;
    if (q.answer && q.answer.length >= ANSWER_AS_SOLUTION_MIN_LEN) {
      void this.questionsRepo.updateExplanation(q.id, q.answer).catch((err) => {
        this.logger.error(`explanation persist failed (questionId=${q.id}): ${err}`);
      });
      return;
    }
    this.enqueue(q.id);
  }

  /** 批量等待（结果页首次拉取）：DB 有直返；in-flight 等（总超时 60s）；无在途且无解析 -> null（不触发新生成）。 */
  async waitForExplanations(ids: number[], timeoutMs = 60_000): Promise<Record<number, string | null>> {
    const out: Record<number, string | null> = {};
    const pending: number[] = [];
    for (const id of ids) {
      const q = await this.questionsRepo.findById(id);
      const text = q?.explanation?.trim();
      if (text) out[id] = text;
      else if (this.inFlight.has(id)) pending.push(id);
      else out[id] = null;
    }
    if (pending.length > 0) {
      const deadline = Date.now() + timeoutMs;
      const settled = await Promise.all(pending.map(async (id) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        // 顺序 await 期间该题生成可能已完成并从 map 删除 -> 先取再判空，避免 `!` 解引用抛 TypeError
        const p = this.inFlight.get(id);
        return p ? withTimeout(p, remaining, null) : null;
      }));
      // settled 里的 null（超时/生成失败）也要写回 out，避免遗留 undefined
      pending.forEach((id, i) => { out[id] = settled[i] ?? null; });
    }
    return out;
  }

  /** 单题刷新等待（explanation-wait）：DB 有直返；in-flight 等；无在途且无解析 -> 重新触发生成再等（120s）。 */
  async waitExplanation(id: number, timeoutMs = 120_000): Promise<string | null> {
    const q = await this.questionsRepo.findById(id);
    if (q?.explanation?.trim()) return q.explanation;
    // enqueue 急切注册并返回 promise：队列饱和时也拿得到在途 promise，不会误判 null
    const p = this.inFlight.get(id) ?? this.enqueue(id);
    return withTimeout(p, timeoutMs, null);
  }

  private enqueue(id: number): Promise<string | null> {
    const existing = this.inFlight.get(id);
    if (existing) return existing;
    let start!: () => void;
    const p = new Promise<string | null>((resolve) => {
      start = () => { this.starters.delete(id); void this.generate(id).then(resolve); };
    });
    this.inFlight.set(id, p);
    this.starters.set(id, start);
    this.queue.push(id);
    void this.drain();
    return p;
  }

  private async drain(): Promise<void> {
    while (this.running < QUEUE_CONCURRENCY && this.queue.length > 0) {
      const id = this.queue.shift()!;
      const start = this.starters.get(id);
      if (!start) continue;
      this.running++;
      start();
      void this.inFlight.get(id)!.finally(() => {
        this.inFlight.delete(id);
        this.running--;
        void this.drain();
      });
    }
  }

  private async generate(id: number): Promise<string | null> {
    try {
      const q = await this.questionsRepo.findById(id);
      if (!q) return null;
      if (q.explanation?.trim()) return q.explanation;
      if (q.answer && q.answer.length >= ANSWER_AS_SOLUTION_MIN_LEN) {
        await this.questionsRepo.updateExplanation(id, q.answer);
        return q.answer;
      }
      const result = await this.explanation.explain({
        mode: 'solution',
        studentId: '',
        subject: 'math',
        question: { content: q.content, answer: q.answer ?? undefined },
        wrongAnswer: '',
        knowledgePoint: { id: '', name: '' },
      });
      const text = result.content?.trim();
      if (!text) return null;
      await this.questionsRepo.updateExplanation(id, text);
      return text;
    } catch (err) {
      this.logger.error(`explanation generate failed (questionId=${id}): ${err}`);
      return null;
    }
  }
}
