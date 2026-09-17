import { Injectable, ConflictException, NotFoundException, ForbiddenException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { StudentsRepository } from '../../database/repositories/students.repo.js';
import { ProgressRepository } from '../../database/repositories/progress.repo.js';
import { TextbookVersionsRepository } from '../../database/repositories/textbook-versions.repo.js';
import { SemestersRepository } from '../../database/repositories/semesters.repo.js';
import { ContentService, type SubjectConfigOption } from '../content/content.service.js';
import { bandFromGradeCode, gradeCodeFromLabel } from '../../common/utils/grade.js';

/** grade -> school_level（data-school 字体档位）。 */
export function deriveSchoolLevel(grade: string): 'primary' | 'junior' | 'senior' {
  if (grade.startsWith('小学')) return 'primary';
  if (['初一', '初二', '初三'].includes(grade)) return 'junior';
  if (['高一', '高二', '高三'].includes(grade)) return 'senior';
  throw new ConflictException({ code: 1001, message: '年级不合法' });
}

/** 每学科教材配置状态（configured=false 时字段为按学生年级推导的默认值，供前端预选）。 */
export interface SubjectConfigState {
  subjectId: number;
  subjectName: string;
  configured: boolean;
  started: boolean;
  gradeCode: string | null;
  term: string | null;
  textbookVersionId: number | null;
  publisher: string | null;
  edition: string;
}

export interface SubjectConfigsResponse {
  studentId: number;
  studentName: string | null;
  subjects: SubjectConfigState[];
  options: SubjectConfigOption[];
}

@Injectable()
export class ParentService {
  constructor(
    private studentsRepo: StudentsRepository,
    private progressRepo: ProgressRepository,
    private versionsRepo: TextbookVersionsRepository,
    private semestersRepo: SemestersRepository,
    private contentService: ContentService,
  ) {}

  async createStudent(
    parentId: number,
    dto: { name: string; username: string; password: string; age: number; grade: string },
  ) {
    const existing = await this.studentsRepo.findByUsername(dto.username);
    if (existing) {
      throw new ConflictException({ code: 1004, message: '用户名已存在' });
    }
    const schoolLevel = deriveSchoolLevel(dto.grade);
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const studentId = await this.studentsRepo.create({
      parentId,
      username: dto.username,
      passwordHash,
      name: dto.name,
      age: dto.age,
      grade: dto.grade,
      schoolLevel,
    });
    await this.studentsRepo.createDefaultSettings(studentId, schoolLevel);
    return { id: studentId };
  }

  async listStudents(parentId: number) {
    const students = await this.studentsRepo.findByParentId(parentId);
    return students.map(({ passwordHash: _ph, ...rest }) => rest);
  }

  async resetPassword(parentId: number, studentId: number, newPassword: string) {
    const student = await this.requireOwnedStudent(parentId, studentId);
    if (newPassword.length < 6 || newPassword.length > 32) {
      throw new ConflictException({ code: 1001, message: '密码长度需为 6-32 位' });
    }
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await this.studentsRepo.updatePassword(student.id, passwordHash);
  }

  async setStatus(parentId: number, studentId: number, isActive: boolean) {
    const student = await this.requireOwnedStudent(parentId, studentId);
    await this.studentsRepo.setActive(student.id, isActive);
  }

  /** 每学科教材配置状态 + 可选项。已配置学科读 progress（textbook_version_id + current_semester_id
   *  为事实源）；未配置学科按学生年级推导默认（全科同年级），不落库。 */
  async getSubjectConfigs(parentId: number, studentId: number): Promise<SubjectConfigsResponse> {
    const student = await this.requireOwnedStudent(parentId, studentId);
    const options = await this.contentService.getSubjectConfigOptions();
    const studentGradeCode = student.grade ? gradeCodeFromLabel(student.grade) ?? null : null;

    const subjects: SubjectConfigState[] = [];
    for (const opt of options) {
      const progress = await this.progressRepo.findByStudentAndSubject(student.id, opt.subjectId);
      if (progress) {
        const semester = progress.currentSemesterId != null
          ? await this.semestersRepo.findById(progress.currentSemesterId)
          : null;
        const version = await this.versionsRepo.findById(progress.textbookVersionId);
        subjects.push({
          subjectId: opt.subjectId,
          subjectName: opt.subjectName,
          configured: true,
          started: progress.status !== 'not_started' || progress.currentLessonId != null,
          gradeCode: semester?.grade ?? null,
          term: semester?.term ?? null,
          textbookVersionId: progress.textbookVersionId,
          publisher: version?.publisher ?? null,
          edition: version?.edition ?? '',
        });
        continue;
      }
      // 未配置：按学生年级推导默认（全科同年级），不落库
      const gradeOpt = opt.grades.find(g => g.code === studentGradeCode) ?? opt.grades[0];
      const versionOpt = gradeOpt.versions[0];
      const term = gradeOpt && versionOpt
        ? (versionOpt.terms.includes('first') ? 'first' : versionOpt.terms[0] ?? null)
        : null;
      subjects.push({
        subjectId: opt.subjectId,
        subjectName: opt.subjectName,
        configured: false,
        started: false,
        gradeCode: gradeOpt?.code ?? null,
        term,
        textbookVersionId: versionOpt?.id ?? null,
        publisher: versionOpt?.publisher ?? null,
        edition: versionOpt?.edition ?? '',
      });
    }
    return { studentId: student.id, studentName: student.name, subjects, options };
  }

  /** 写入/切换某学科教材配置。已有学习进度且版本或册别变化时重置该学科学习状态
   *  （错题本/作业记录保留在库，不再展示）。 */
  async updateSubjectConfig(
    parentId: number,
    studentId: number,
    subjectId: number,
    dto: { gradeCode: string; term: 'first' | 'second'; textbookVersionId?: number },
  ): Promise<{ subjectId: number; textbookVersionId: number; semesterId: number; reset: boolean }> {
    const student = await this.requireOwnedStudent(parentId, studentId);

    // 解析教材版本：显式指定则校验归属；缺省按默认规则（同学段最新版次）
    let version;
    if (dto.textbookVersionId != null) {
      version = await this.versionsRepo.findById(dto.textbookVersionId);
      if (!version || version.subjectId !== subjectId) {
        throw new ConflictException({ code: 1001, message: '教材版本不存在或不属于该学科' });
      }
    } else {
      const versions = await this.versionsRepo.findBySubjectId(subjectId);
      if (versions.length === 0) {
        throw new NotFoundException({ code: 1002, message: '该学科暂无教材版本' });
      }
      version = this.contentService.pickDefaultVersion(versions, bandFromGradeCode(dto.gradeCode) ?? null)!;
    }

    // 解析册别：版本下 (gradeCode, term) 必须存在
    const semesters = await this.semestersRepo.findByTextbookVersionId(version.id);
    const semester = semesters.find(s => s.grade === dto.gradeCode && s.term === dto.term);
    if (!semester) {
      throw new ConflictException({ code: 1001, message: '该教材版本不含此年级/册别' });
    }

    const progress = await this.progressRepo.findByStudentAndSubject(student.id, subjectId);
    const started = progress != null && (progress.status !== 'not_started' || progress.currentLessonId != null);
    const changed = progress != null
      && (progress.textbookVersionId !== version.id || progress.currentSemesterId !== semester.id);
    const reset = started && changed;

    if (!progress) {
      await this.progressRepo.createConfig({
        studentId: student.id,
        subjectId,
        textbookVersionId: version.id,
        semesterId: semester.id,
      });
    } else {
      await this.progressRepo.applyConfig(progress.id, {
        textbookVersionId: version.id,
        semesterId: semester.id,
        reset,
      });
    }
    return { subjectId, textbookVersionId: version.id, semesterId: semester.id, reset };
  }

  /** 归属校验：先查存在（1002），再比对 parent_id（1005，不泄漏存在性）。
   *  **public**：`PointsModule` 的家长端 controller（Task 8）跨模块复用这一份判定，勿另写一套。 */
  async requireOwnedStudent(parentId: number, studentId: number) {
    const student = await this.studentsRepo.findById(studentId);
    if (!student) {
      throw new NotFoundException({ code: 1002, message: '学生不存在' });
    }
    if (student.parentId !== parentId) {
      throw new ForbiddenException({ code: 1005, message: '无权操作该学生' });
    }
    return student;
  }
}
