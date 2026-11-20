import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import {
  ResearchQuestionsRepository,
  type QuestionRow,
} from '../../database/repositories/research-questions.repo.js';
import type { AuditActor, AuditEntry } from '../../database/repositories/content-audit.repo.js';
import { ResearchImagesService } from './research-images.service.js';

/** 五字段更正入参（spec §7.5 / brief Step 4）。confirmedSource 必须勾 true。 */
export const UpdateQuestionSchema = z.object({
  answer: z.string().min(1).max(20000).optional(),
  content: z.string().min(1).max(20000).optional(),
  // 未传 = 保持原值；显式 null = 清空选项（无选项题）。两端都收，避免把 null 选项重写成假数组。
  options: z.union([
    z.array(z.object({ label: z.string(), text: z.string() })).max(10),
    z.null(),
  ]).optional().transform((arr) => arr === null ? null : arr?.map(({ label, text }) => ({ label, text }))),
  explanation: z.string().max(20000).optional(),
  approach: z.string().max(20000).optional()
    .refine((s) => !/!\[[^\]]*\]\((?!\/uploads\/|https?:\/\/|data:)[^)]+\)/i.test(s ?? ''),
      { message: 'approach 不允许相对路径图片' }),
  confirmedSource: z.literal(true),
  note: z.string().max(255).optional(),
});

type UpdateQuestionDto = z.output<typeof UpdateQuestionSchema>;

/** 裸 ZodError 会被全局过滤器兜成 500/5000，客户端入参错误必须转 400/1001。 */
export function parseBody<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.output<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      .join('; ');
    throw new BadRequestException({ code: 1001, message: `入参校验失败：${detail}` });
  }
  return parsed.data;
}

const FIVE_FIELDS = ['answer', 'content', 'options', 'explanation', 'approach'] as const;
/** 只认教研上传的绝对 URL（spec §8.3/§8.5）：非 research 的 /uploads/ 图不在清理权限内。 */
const RESEARCH_URL_RE = /!\[[^\]]*\]\((\/uploads\/research\/[^)\s]+)\)/g;

function collectUrls(value: string | null | undefined): string[] {
  if (typeof value !== 'string') return [];
  return Array.from(value.matchAll(RESEARCH_URL_RE), (m) => m[1]);
}

/** DB 里 options 是 JSON 字符串或 NULL；审计快照记解析后的数组/null，和 afterJson 同形状。 */
function parseStoredOptions(raw: string | null | undefined): unknown {
  if (raw == null || raw === '') return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface UpdateQuestionResult {
  question: { id: number; answerVerified: boolean } & Record<string, unknown>;
  changedFields: string[];
  deletedImages: number;
}

/**
 * 教研题目更正：只改五字段 + 按需置 answer_verified=1，审计同事务，绝不回填历史数据。
 * 图片文件删除在 DB commit 之后，失败只记日志（spec §8.5 第 4 步）。
 */
@Injectable()
export class ResearchQuestionsService {
  private readonly logger = new Logger(ResearchQuestionsService.name);

  constructor(
    private readonly repo: ResearchQuestionsRepository,
    private readonly images: ResearchImagesService,
  ) {}

  async update(id: number, raw: unknown, user: AuditActor): Promise<UpdateQuestionResult> {
    const dto: UpdateQuestionDto = parseBody(UpdateQuestionSchema, raw);
    if (!Number.isInteger(id) || id <= 0) {
      throw new BadRequestException({ code: 1001, message: '题目 id 必须是正整数' });
    }
    const old = await this.repo.findById(id);
    if (!old) {
      throw new NotFoundException(`题目不存在：${id}`);
    }

    // 1. 仅保留与旧值不同的字段；options 序列化后比较（DB 里是 JSON 字符串，剥 isCorrect）。
    //    null 落库为 SQL NULL 而不是字符串 "null"；未传时整个字段不进 changed。
    const changed: Record<string, string | null> = {};
    for (const k of ['answer', 'content', 'explanation', 'approach'] as const) {
      const next = dto[k];
      if (next !== undefined && next !== (old[k] ?? undefined)) {
        changed[k] = next;
      }
    }
    if (dto.options !== undefined) {
      const serialized = dto.options === null ? null : JSON.stringify(dto.options);
      if (serialized !== old.options) {
        changed.options = serialized;
      }
    }
    const changedFields = Object.keys(changed);
    if (changedFields.length === 0) {
      throw new BadRequestException({ code: 1001, message: '无变更字段' });
    }

    // 2. 图片差集：旧五字段 URL − 新五字段 URL（新值取 changed，未改字段取旧值）。
    const oldUrls = new Set(FIVE_FIELDS.flatMap((k) => collectUrls(old[k])));
    const newUrls = new Set(FIVE_FIELDS.flatMap((k) => collectUrls(changed[k] ?? old[k])));
    const removedUrls = [...oldUrls].filter((url) => !newUrls.has(url));

    // 3. 审计条目（在事务内随 UPDATE 一起写）。
    const beforeJson: Record<string, unknown> = {};
    const afterJson: Record<string, unknown> = {};
    for (const k of changedFields) {
      beforeJson[k] = k === 'options'
        ? parseStoredOptions(old.options)
        : (old[k as (typeof FIVE_FIELDS)[number]] ?? null);
      afterJson[k] = k === 'options' ? dto.options : changed[k];
    }
    const markVerified = Object.prototype.hasOwnProperty.call(changed, 'answer');
    const audit: AuditEntry = {
      actorId: user.sub,
      actorRole: user.role,
      actorName: user.name ?? null,
      action: 'question.update',
      targetType: 'question',
      targetId: id,
      paperId: await this.repo.findPaperIdByQuestion(id),
      beforeJson,
      afterJson,
      note: dto.note ?? null,
    };

    // 4. 同一事务写题目 + 审计；审计失败整单回滚，题目不变。
    await this.repo.updateWithAudit(id, changed, markVerified, audit);

    // 5. commit 后清理磁盘图片（失败只记日志，不回滚 DB）。
    let deleted = 0;
    try {
      const cleanup = await this.images.cleanupUnreferenced(removedUrls, user);
      deleted = cleanup.deleted;
    } catch (err) {
      this.logger.warn(`research 图片清理失败：${String(err)}`);
    }

    // answerVerified 取实际值：本次改 answer→true；否则沿用旧题标记（不写死 true）。
    const answerVerified = markVerified ? true : Number(old.answer_verified) === 1;
    const question = { id, answerVerified } as UpdateQuestionResult['question'];
    for (const k of changedFields) {
      question[k] = k === 'options' ? dto.options : changed[k];
    }
    return { question, changedFields, deletedImages: deleted };
  }
}
