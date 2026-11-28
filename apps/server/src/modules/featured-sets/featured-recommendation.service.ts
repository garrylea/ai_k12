import {
  BadRequestException, HttpException, HttpStatus, Injectable, NotFoundException,
} from '@nestjs/common';
import {
  FeaturedQuestionSetsRepository,
  type CreateRecommendationResult,
} from '../../database/repositories/featured-question-sets.repo.js';
import { QuestionsRepository } from '../../database/repositories/questions.repo.js';
import { StudentsRepository } from '../../database/repositories/students.repo.js';
import { resolveGradeInfo } from '../../common/utils/grade.js';
import { createFeaturedContentKey } from './content-key.js';

/** 每名学生每天最多新建 10 个精选题集（额度按题集创建数，不按推荐票数）。 */
const DAILY_SET_LIMIT = 10;

@Injectable()
export class FeaturedRecommendationService {
  constructor(
    private readonly featuredRepo: FeaturedQuestionSetsRepository,
    private readonly questionsRepo: QuestionsRepository,
    private readonly studentsRepo: StudentsRepository,
  ) {}

  /**
   * 学生推荐精选题：校验顺序固定，错误码与精选题设计文档 §10 对齐。
   * 只收自己做过的、在架的、有标准答案的同学科非 freeform 题。
   */
  async recommend(studentId: number, questionIds: number[]): Promise<CreateRecommendationResult> {
    // 1~2. 题目 id 去重后限制 1~20，非法 id 同样 1001。
    const ids = [...new Set(questionIds)];
    if (ids.length < 1 || ids.length > 20 || ids.some((id) => !Number.isInteger(id) || id <= 0)) {
      throw new BadRequestException({ code: 1001, message: '题数必须为 1~20 且题目 id 合法' });
    }

    // 3. 年级统一用 grade_N code，不把 students.grade 原始标签透传给下游。
    const student = await this.studentsRepo.findById(studentId);
    if (!student) throw new BadRequestException({ code: 1001, message: '学生不存在' });
    const grade = resolveGradeInfo(student.grade ?? '');
    if (!grade) throw new BadRequestException({ code: 1001, message: '无法解析学生年级' });

    // 4. 缺题 / 下架题：findByIds 只取在用题。
    const questions = await this.questionsRepo.findByIds(ids);
    const byId = new Map(questions.map((q) => [Number(q.id), q]));
    if (ids.some((id) => !byId.has(id))) {
      throw new NotFoundException({ code: 1002, message: '题目不存在或已下架' });
    }

    // 5~6. 只推有标准答案的题库题；freeform 不进精选题。
    if (questions.some((q) => q.source === 'freeform')) {
      throw new BadRequestException({ code: 1004, message: 'freeform 题不能推荐' });
    }
    if (questions.some((q) => (q.answer ?? '').trim() === '')) {
      throw new BadRequestException({ code: 1004, message: '无标准答案的题不能推荐' });
    }

    // 7. 一个题集只属于一个学科。
    const subjectIds = new Set(questions.map((q) => Number(q.subject_id)));
    if (subjectIds.size !== 1) {
      throw new BadRequestException({ code: 1001, message: '只能推荐同一学科的题' });
    }

    // 8. 作答事实门禁：与抽题的「从未做过」判定同源，绝不全集放行。
    const answered = await this.questionsRepo.findAnsweredQuestionIds(studentId, ids);
    if (ids.some((id) => !answered.has(id))) {
      throw new BadRequestException({ code: 1004, message: '只能推荐自己做过的题' });
    }

    // 9. 每日额度在真正建集之前校验，超限直接 429/1008。
    if (await this.featuredRepo.countSetsCreatedToday(studentId) >= DAILY_SET_LIMIT) {
      throw new HttpException(
        { code: 1008, message: '今日推荐已达上限，请明天再试' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // 10~11. content key 由排序后的题集计算，顺序不同仍归同一题集；建集/投票交给仓储事务。
    const subjectId = [...subjectIds][0];
    return this.featuredRepo.createRecommendation({
      subjectId,
      questionIds: ids,
      contentKey: createFeaturedContentKey(subjectId, ids),
      studentId,
      gradeCode: grade.code,
    });
  }
}
