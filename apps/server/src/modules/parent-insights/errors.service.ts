import { Injectable } from '@nestjs/common';
import { ParentInsightsRepository } from '../../database/repositories/parent-insights.repo.js';
import type { ParentErrorFilters } from '../../database/repositories/parent-insights.repo.js';
import type { ParentErrorPage } from './dto/parent-insights.dto.js';

/** 服务端固定页大小：前端不传 `pageSize`（沿用家长端既有约定）。 */
export const PAGE_SIZE = 20;

export interface ErrorsQuery {
  subject?: number;
  source?: string;
  track?: 'main' | 'aux';
  cleared?: 'uncleared' | 'cleared' | 'all';
  from?: string;
  to?: string;
  page: number;
}

/**
 * 家长端错题查看（spec §4.2 ③）：**只读**，复用主线错题本 `main_error_books`。
 *
 * `track` 只在**响应里现算**、不落库，也**不参与筛选**——筛选走仓储的 `track` 反向排除
 * （`main` → `source <> 'auxiliary'`），由仓储负责 SQL 语义。
 */
@Injectable()
export class ErrorsService {
  constructor(private readonly repo: ParentInsightsRepository) {}

  async listErrors(studentId: number, query: ErrorsQuery): Promise<ParentErrorPage> {
    const filters: ParentErrorFilters = {};
    if (query.subject !== undefined) filters.subjectId = query.subject;
    if (query.source) filters.source = query.source;
    if (query.track) filters.track = query.track;
    // `cleared=all` 与不传等价：都不过滤清零态
    if (query.cleared === 'uncleared' || query.cleared === 'cleared') {
      filters.cleared = query.cleared;
    }
    if (query.from) filters.from = query.from;
    if (query.to) filters.to = query.to;

    const offset = (query.page - 1) * PAGE_SIZE;
    const { items, total } = await this.repo.listParentErrors(
      studentId,
      filters,
      PAGE_SIZE,
      offset,
    );

    // 知识点单独批量取：分页查询刻意不 JOIN KP（一题多 KP 会让行翻倍、把分页算错）。
    // 先去重（同一道题可能在同一页出现多次…不会，但去重能避免 IN 列表白长）；
    // 本页没有可查的 questionId 时跳过 —— 仓储对空数组也早返回，少一次调用更省。
    const questionIds = [
      ...new Set(items.map((r) => r.questionId).filter((id): id is number => id !== null)),
    ];
    const kpRows =
      questionIds.length > 0 ? await this.repo.listErrorKnowledgePoints(questionIds) : [];
    const kpByQuestion = new Map<number, Array<{ id: number; name: string }>>();
    for (const kp of kpRows) {
      const list = kpByQuestion.get(kp.questionId) ?? [];
      list.push({ id: kp.knowledgePointId, name: kp.knowledgePointName });
      kpByQuestion.set(kp.questionId, list);
    }

    return {
      items: items.map((r) => ({
        id: r.id,
        questionId: r.questionId,
        track: r.source === 'auxiliary' ? 'aux' : 'main',
        source: r.source,
        level: r.level,
        isCleared: r.isCleared,
        wrongAnswerText: r.wrongAnswerText,
        createdAt: r.createdAt,
        clearedAt: r.clearedAt,
        question:
          r.questionContent === null
            ? null
            : {
                content: r.questionContent,
                type: r.questionType ?? '',
                difficulty: r.questionDifficulty,
                knowledgePoints:
                  r.questionId === null ? [] : (kpByQuestion.get(r.questionId) ?? []),
              },
      })),
      page: query.page,
      pageSize: PAGE_SIZE,
      total,
    };
  }
}
