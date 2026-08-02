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

  /** Ordered cards of a lesson for the P2.2 reading page. */
  async getLessonCards(lessonId: number) {
    const lesson = await this.lessonsRepo.findById(lessonId);
    if (!lesson) throw new NotFoundException({ code: 1002, message: '课程不存在' });

    const cards = await this.cardsRepo.findByLessonId(lessonId);
    return {
      lessonId,
      lessonName: lesson.name,
      totalCards: cards.length,
      cards: cards.map(c => ({
        id: c.id,
        sortOrder: c.sort_order,
        cardType: c.card_type,
        title: c.title,
        content: c.content,
        metadata: c.content_metadata ? safeParse(c.content_metadata) : null,
        textbookPage: c.textbook_page,
      })),
    };
  }

  /** Find the next lesson after the given one (same unit or next unit). */
  async getNextLesson(lessonId: number): Promise<{ id: number; unitId: number } | null> {
    const current = await this.lessonsRepo.findById(lessonId);
    if (!current) return null;

    const unitLessons = await this.lessonsRepo.findByUnitId(current.unitId);
    const currentIndex = unitLessons.findIndex(l => l.id === lessonId);

    if (currentIndex >= 0 && currentIndex < unitLessons.length - 1) {
      return { id: unitLessons[currentIndex + 1].id, unitId: current.unitId };
    }

    // Current unit's last lesson: find next unit's first lesson
    const currentUnit = await this.unitsRepo.findById(current.unitId);
    if (!currentUnit) return null;

    const units = await this.unitsRepo.findBySemesterId(currentUnit.semesterId);
    const unitIndex = units.findIndex(u => u.id === current.unitId);

    if (unitIndex >= 0 && unitIndex < units.length - 1) {
      const nextUnit = units[unitIndex + 1];
      const nextUnitLessons = await this.lessonsRepo.findByUnitId(nextUnit.id);
      if (nextUnitLessons.length > 0) {
        return { id: nextUnitLessons[0].id, unitId: nextUnit.id };
      }
    }

    return null;
  }
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
