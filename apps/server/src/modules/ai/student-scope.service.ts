import { Injectable } from '@nestjs/common';
import { StudentsRepository } from '../../database/repositories/students.repo.js';
import { ProgressRepository } from '../../database/repositories/progress.repo.js';
import { TextbookVersionsRepository } from '../../database/repositories/textbook-versions.repo.js';
import { SemestersRepository } from '../../database/repositories/semesters.repo.js';
import { UnitsRepository } from '../../database/repositories/units.repo.js';
import { resolveGradeInfo } from '../../common/utils/grade.js';

export interface StudentLearningScope {
  /** 学生年级（students.grade 原样；可能为空串） */
  gradeLabel: string;
  /** '人教版' / '北师大版' …；家长没配「学习配置」时为空串 */
  textbookLabel: string;
  /** '第一章 有理数、第二章 整式' …；没配进度时为空串 */
  learnedContent: string;
}

/**
 * 从库里推导「这个学生在这个学科上学到哪了」，替代原来让学生自己填的问卷。
 *
 * 取值链（全部只读）：
 * - 年级：students.grade
 * - 教材：progress.textbook_version_id → textbook_versions.publisher + edition
 * - 已学内容：progress.current_semester_id（缺省按年级找同学期）→ units 里
 *   sort_order ≤ 当前单元的单元名；没有当前单元就取该学期全部单元
 *
 * 没有任何 progress 行（家长没配「学习配置」）→ 教材/已学内容都返回空串，
 * 由提示词的空态分支兜底（按该年级常规进度讲，不编造版本）。
 */
@Injectable()
export class StudentScopeService {
  constructor(
    private readonly studentsRepo: StudentsRepository,
    private readonly progressRepo: ProgressRepository,
    private readonly versionsRepo: TextbookVersionsRepository,
    private readonly semestersRepo: SemestersRepository,
    private readonly unitsRepo: UnitsRepository,
  ) {}

  async resolve(studentId: number, subjectId: number): Promise<StudentLearningScope> {
    const student = await this.studentsRepo.findById(studentId);
    // students.grade 历史上有三种写法（初一 / grade_7 / 七年级）；统一成标准标签再进提示词
    const rawGrade = student?.grade ?? '';
    const gradeLabel = resolveGradeInfo(rawGrade)?.label ?? rawGrade;

    const progress = await this.progressRepo.findByStudentAndSubject(studentId, subjectId);
    if (!progress) return { gradeLabel, textbookLabel: '', learnedContent: '' };

    const version = await this.versionsRepo.findById(progress.textbookVersionId);
    // publisher 已经是「人教版」这种可直接进提示词的写法；edition 只是修订年份等补充，
    // 拼上去反而会变成「人教版根据2022年版课程标准修订」，故只取 publisher，缺省退回 name。
    const textbookLabel = version ? (version.publisher?.trim() || version.name?.trim() || '') : '';

    const semesters = await this.semestersRepo.findByTextbookVersionId(progress.textbookVersionId);
    const gradeCode = resolveGradeInfo(rawGrade)?.code;
    const semester =
      (progress.currentSemesterId != null
        ? semesters.find((s) => s.id === progress.currentSemesterId)
        : undefined) ?? (gradeCode ? semesters.find((s) => s.grade === gradeCode) : undefined);
    if (!semester) return { gradeLabel, textbookLabel, learnedContent: '' };

    const units = await this.unitsRepo.findBySemesterId(semester.id);
    const currentUnit =
      progress.currentUnitId != null ? units.find((u) => u.id === progress.currentUnitId) : undefined;
    // 没设当前单元时视为「整册都学过」，否则只算到当前单元（含）
    const learnedUnits = currentUnit
      ? units.filter((u) => u.sortOrder <= currentUnit.sortOrder)
      : units;

    return {
      gradeLabel,
      textbookLabel,
      learnedContent: learnedUnits.map((u) => u.name).join('、'),
    };
  }
}
