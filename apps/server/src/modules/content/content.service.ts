import { Injectable, NotFoundException } from '@nestjs/common';
import { SubjectsRepository } from '../../database/repositories/subjects.repo.js';
import { TextbookVersionsRepository } from '../../database/repositories/textbook-versions.repo.js';
import { SemestersRepository } from '../../database/repositories/semesters.repo.js';
import { UnitsRepository } from '../../database/repositories/units.repo.js';
import { LessonsRepository } from '../../database/repositories/lessons.repo.js';
import { CardsRepository } from '../../database/repositories/cards.repo.js';

@Injectable()
export class ContentService {
  constructor(
    private subjectsRepo: SubjectsRepository,
    private versionsRepo: TextbookVersionsRepository,
    private semestersRepo: SemestersRepository,
    private unitsRepo: UnitsRepository,
    private lessonsRepo: LessonsRepository,
    private cardsRepo: CardsRepository,
  ) {}

  async getSubjects() {
    return this.subjectsRepo.findAll();
  }

  async getVersions(subjectId: number) {
    const subject = await this.subjectsRepo.findById(subjectId);
    if (!subject) throw new NotFoundException({ code: 1002, message: '学科不存在' });
    return this.versionsRepo.findBySubjectId(subjectId);
  }

  async getUnits(versionId: number) {
    const version = await this.versionsRepo.findById(versionId);
    if (!version) throw new NotFoundException({ code: 1002, message: '教材版本不存在' });

    const semesters = await this.semestersRepo.findByTextbookVersionId(versionId);
    // For MVP, return the semester info alongside units from the first semester
    const result: any[] = [];
    for (const sem of semesters) {
      const units = await this.unitsRepo.findBySemesterId(sem.id);
      result.push({
        semester: { id: sem.id, name: sem.name, grade: sem.grade, term: sem.term },
        units: units.map(u => ({ id: u.id, name: u.name, order: u.sortOrder, isMidtermBoundary: u.isMidtermBoundary })),
      });
    }
    return result;
  }

  async getLessons(unitId: number) {
    const unit = await this.unitsRepo.findById(unitId);
    if (!unit) throw new NotFoundException({ code: 1002, message: '单元不存在' });

    const lessons = await this.lessonsRepo.findByUnitId(unitId);
    const result = [];
    for (const lesson of lessons) {
      const kpCount = await this.cardsRepo.countKnowledgePointsByLessonId(lesson.id);
      result.push({
        id: lesson.id,
        name: lesson.name,
        order: lesson.sortOrder,
        isUnitLast: lesson.isUnitLast,
        knowledgePointCount: kpCount,
      });
    }
    return result;
  }
}
