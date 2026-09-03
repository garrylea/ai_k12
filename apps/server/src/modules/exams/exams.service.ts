import { Injectable, NotFoundException } from '@nestjs/common';
import { ExamPapersRepository } from '../../database/repositories/exam-papers.repo.js';
import { parseOptions } from '../../common/utils/parse-options.util.js';
import type { ExamPaperDto, PaperDetailDto, PaperQueryDto } from './dto/paper-query.dto.js';

/**
 * 考试模块 service（Task 1 骨架：试卷列表 + 试卷详情）。
 *
 * 详情做白名单序列化——questions 只出 questionId/questionNo/text/type/options，
 * answer/explanation 等字段一律剥离（防答案泄露）；options 是 JSON 字符串，
 * parse 成数组返回（共享 parseOptions util）。
 */
@Injectable()
export class ExamsService {
  constructor(private readonly examPapersRepo: ExamPapersRepository) {}

  /** 试卷列表：透传筛选参数给 repo，行 -> ExamPaperDto 映射。 */
  async listPapers(query: PaperQueryDto): Promise<ExamPaperDto[]> {
    const rows = await this.examPapersRepo.findPapers(query);
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      year: row.year,
      district: row.district,
      examType: row.exam_type,
      gradeBand: row.grade_band,
      questionCount: row.question_count,
    }));
  }

  /** 试卷详情：题目元数据 + 推荐时长；试卷不存在 -> 404。 */
  async getPaperDetail(id: number): Promise<PaperDetailDto> {
    const paper = await this.examPapersRepo.findById(id);
    if (!paper) {
      throw new NotFoundException(`试卷不存在：${id}`);
    }
    const questions = await this.examPapersRepo.findQuestionsByPaperId(id);
    return {
      id: paper.id,
      title: paper.title,
      durationMinutes: computeRecommendedDuration(questions),
      questions: questions.map((q) => ({
        questionId: q.questionId,
        questionNo: q.questionNo,
        text: q.text,
        type: q.type,
        options: parseOptions(q.options),
      })),
    };
  }
}

/**
 * 推荐时长（纯函数，导出供测试/复用）：
 * choice/true_false 每题 1 分钟，其余（proof/short_answer/fill_blank...）每题 3 分钟；
 * 总和向上取整到 15 的倍数，clamp 到 [30, 180]。
 */
export function computeRecommendedDuration(questions: Array<{ type: string }>): number {
  let sum = 0;
  for (const q of questions) {
    sum += q.type === 'choice' || q.type === 'true_false' ? 1 : 3;
  }
  const rounded = Math.ceil(sum / 15) * 15;
  return Math.min(180, Math.max(30, rounded));
}
