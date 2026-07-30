import { Injectable, NotFoundException } from '@nestjs/common';
import { ProgressRepository } from '../../database/repositories/progress.repo.js';
import { StudentsRepository } from '../../database/repositories/students.repo.js';
import { ContentService } from '../content/content.service.js';

export interface SectionData {
  id: string;
  title: string;
  order: number;
  knowledgePointCount: number;
  status: 'completed' | 'current' | 'locked';
  progress: number;
}

export interface ChapterData {
  id: string;
  title: string;
  order: number;
  importance: 'large' | 'medium' | 'small';
  status: 'completed' | 'current' | 'locked';
  progress: number;
  sections: SectionData[];
}

export interface StarMapData {
  subjectName: string;
  gradeName: string;
  publisher: string;
  totalUnits: number;
  completedUnits: number;
  chapters: ChapterData[];
}

@Injectable()
export class ProgressService {
  constructor(
    private progressRepo: ProgressRepository,
    private studentsRepo: StudentsRepository,
    private contentService: ContentService,
  ) {}

  async getStarMap(studentId: number, subjectId: number): Promise<StarMapData> {
    // Get progress record
    const progress = await this.progressRepo.findByStudentAndSubject(studentId, subjectId);

    // Get subject info
    const subjects = await this.contentService.getSubjects();
    const subject = subjects.find(s => s.id === subjectId);
    if (!subject) throw new NotFoundException({ code: 1002, message: '学科不存在' });

    // Resolve textbook version. Prefer the one recorded in progress; otherwise
    // pick a version matching the student's grade band (primary/junior/senior),
    // so a grade-9 student gets the junior textbook — not versions[0] (primary).
    const versions = await this.contentService.getVersions(subjectId);
    if (versions.length === 0) {
      throw new NotFoundException({ code: 1002, message: '该学科暂无教材版本' });
    }
    let versionId = progress?.textbookVersionId;
    if (!versionId) {
      const student = await this.studentsRepo.findById(studentId);
      const gradeBand = student?.schoolLevel ?? null;
      const matched = gradeBand ? versions.find(v => v.gradeBand === gradeBand) : undefined;
      versionId = (matched ?? versions[0]).id;
    }

    const version = versions.find(v => v.id === versionId);
    const publisher = version?.publisher || '';

    // Get semester + units
    const semesterData = await this.contentService.getUnits(versionId);
    if (semesterData.length === 0) {
      return {
        subjectName: subject.name,
        gradeName: '',
        publisher,
        totalUnits: 0,
        completedUnits: 0,
        chapters: [],
      };
    }

    // Select the semester. Honor progress.current_semester_id (set by the
    // parent when configuring the student) so 上册/下册 is chosen correctly.
    // Without a progress row, fall back to the lowest sort_order (上册) — the
    // semester list is already ordered by sort_order (SemestersRepository).
    const selectedSemester =
      (progress?.currentSemesterId != null
        ? semesterData.find(s => s.semester.id === progress.currentSemesterId)
        : undefined) ?? semesterData[0];
    const semesterName = selectedSemester.semester.name;
    const units = selectedSemester.units;

    const currentUnitId = progress?.currentUnitId ?? null;
    const currentLessonId = progress?.currentLessonId ?? null;

    const chapters: ChapterData[] = [];
    let completedCount = 0;

    for (const unit of units) {
      // Determine unit status
      let unitStatus: 'completed' | 'current' | 'locked' = 'locked';
      if (currentUnitId === null) {
        // No progress yet: first unit is current
        unitStatus = unit.order === 1 ? 'current' : 'locked';
      } else if (unit.id < (currentUnitId ?? 0)) {
        unitStatus = 'completed';
      } else if (unit.id === currentUnitId) {
        unitStatus = 'current';
      }

      if (unitStatus === 'completed') completedCount++;

      // Get lessons and compute their statuses. sort_order=0 is the 章综述
      // (chapter-intro lesson); it stays as a section, but the frontend renders
      // its badge as "章综述" instead of repeating the chapter title.
      const lessons = await this.contentService.getLessons(unit.id);
      const sections: SectionData[] = lessons.map((lesson: any) => {
        let lessonStatus: 'completed' | 'current' | 'locked' = 'locked';
        let lessonProgress = 0;

        if (unitStatus === 'completed') {
          lessonStatus = 'completed';
          lessonProgress = 100;
        } else if (unitStatus === 'current') {
          if (currentLessonId === null) {
            lessonStatus = lesson.order === 1 ? 'current' : 'locked';
          } else if (lesson.id < (currentLessonId ?? 0)) {
            lessonStatus = 'completed';
            lessonProgress = 100;
          } else if (lesson.id === currentLessonId) {
            lessonStatus = 'current';
            lessonProgress = progress?.currentCardSort ? Math.round((progress.currentCardSort / 10) * 100) : 30;
          }
        }

        return {
          id: String(lesson.id),
          title: lesson.name,
          order: lesson.order,
          knowledgePointCount: lesson.knowledgePointCount || 0,
          status: lessonStatus,
          progress: lessonProgress,
        };
      });

      // Compute importance based on lesson count
      let importance: 'large' | 'medium' | 'small' = 'medium';
      if (lessons.length >= 5) importance = 'large';
      else if (lessons.length <= 2) importance = 'small';

      // Compute unit progress from sections
      const completedSections = sections.filter(s => s.status === 'completed').length;
      const unitProgress = sections.length > 0
        ? Math.round((completedSections / sections.length) * 100)
        : 0;

      chapters.push({
        id: String(unit.id),
        title: unit.name,
        order: unit.order,
        importance,
        status: unitStatus,
        progress: unitProgress,
        sections,
      });
    }

    return {
      subjectName: subject.name,
      gradeName: semesterName,
      publisher,
      totalUnits: units.length,
      completedUnits: completedCount,
      chapters,
    };
  }
}
