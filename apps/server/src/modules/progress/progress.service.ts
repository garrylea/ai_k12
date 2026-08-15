import { Injectable, NotFoundException } from '@nestjs/common';
import { ProgressRepository } from '../../database/repositories/progress.repo.js';
import { StudentsRepository } from '../../database/repositories/students.repo.js';
import { LessonsRepository } from '../../database/repositories/lessons.repo.js';
import { UnitsRepository } from '../../database/repositories/units.repo.js';
import { SemestersRepository } from '../../database/repositories/semesters.repo.js';
import { ContentService } from '../content/content.service.js';
import { PracticeService } from '../practice/practice.service.js';

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
    private lessonsRepo: LessonsRepository,
    private unitsRepo: UnitsRepository,
    private semestersRepo: SemestersRepository,
    private contentService: ContentService,
    private practiceService: PracticeService,
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

    for (let unitIdx = 0; unitIdx < units.length; unitIdx++) {
      const unit = units[unitIdx];
      // Determine unit status
      let unitStatus: 'completed' | 'current' | 'locked' = 'locked';
      if (currentUnitId === null) {
        // No progress yet: first unit is current
        unitStatus = unitIdx === 0 ? 'current' : 'locked';
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
      const sections: SectionData[] = lessons.map((lesson: any, lessonIdx: number) => {
        let lessonStatus: 'completed' | 'current' | 'locked' = 'locked';
        let lessonProgress = 0;

        if (unitStatus === 'completed') {
          lessonStatus = 'completed';
          lessonProgress = 100;
        } else if (unitStatus === 'current') {
          if (currentLessonId === null) {
            // No progress yet: chapter overview (index 0) is current; sections are locked
            lessonStatus = lessonIdx === 0 ? 'current' : 'locked';
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

  async updateProgress(studentId: number, subjectId: number, lessonId: number, cardSortOrder: number) {
    let progress = await this.progressRepo.findByStudentAndSubject(studentId, subjectId);

    if (!progress) {
      // Auto-initialize progress for first-time learners
      const lesson = await this.lessonsRepo.findById(lessonId);
      if (!lesson) throw new NotFoundException({ code: 1002, message: '课程不存在' });

      const unit = await this.unitsRepo.findById(lesson.unitId);
      if (!unit) throw new NotFoundException({ code: 1002, message: '单元不存在' });

      const semester = await this.semestersRepo.findById(unit.semesterId);
      if (!semester) throw new NotFoundException({ code: 1002, message: '学期不存在' });

      await this.progressRepo.create({
        studentId,
        subjectId,
        textbookVersionId: semester.textbookVersionId,
        semesterId: semester.id,
        currentUnitId: unit.id,
        currentLessonId: lesson.id,
      });

      progress = await this.progressRepo.findByStudentAndSubject(studentId, subjectId);
      if (!progress) throw new NotFoundException({ code: 1002, message: '学习进度创建失败' });
    }

    // Only update progress for the current lesson; revisiting older lessons is a no-op
    if (progress.currentLessonId !== lessonId) {
      // When reviewing an older lesson, guide the user to the next lesson
      // of the reviewed lesson so they can continue sequentially.
      if (progress.currentLessonId != null && lessonId < progress.currentLessonId) {
        const nextLesson = await this.contentService.getNextLesson(lessonId);
        if (nextLesson) {
          return { advanced: false, reason: 'not_current_lesson', nextLessonId: nextLesson.id };
        }
      }
      return { advanced: false, reason: 'not_current_lesson', currentLessonId: progress.currentLessonId };
    }

    // Do not rewind progress when reviewing earlier cards
    if (progress.currentCardSort != null && cardSortOrder < progress.currentCardSort) {
      return { advanced: false, reason: 'reviewing' };
    }

    const lessonCards = await this.contentService.getLessonCards(lessonId);
    const cards = lessonCards.cards;
    if (cards.length === 0) {
      throw new NotFoundException({ code: 1002, message: '课程暂无内容' });
    }

    const currentCard = cards.find(c => c.sortOrder === cardSortOrder);
    if (!currentCard) {
      throw new NotFoundException({ code: 1002, message: '卡片不存在' });
    }

    const lastCard = cards[cards.length - 1];
    const isLastCard = currentCard.sortOrder === lastCard.sortOrder;

    if (isLastCard) {
      // 门禁：本课含练习卡时，须全部练习题目已作答（practice_results 覆盖）才能完成课程。
      // 防止学生跳过练习直接翻到最后一页 / 用 API 绕过前端直接完成；无练习卡则跳过（省一次查询）。
      const hasPracticeCards = cards.some(c => c.cardType === 'practice');
      if (hasPracticeCards && !(await this.practiceService.isLessonPracticeComplete(studentId, lessonId))) {
        return { advanced: false, reason: 'practice_incomplete' };
      }
      const nextLesson = await this.contentService.getNextLesson(lessonId);
      if (nextLesson) {
        const nextUnitId = nextLesson.unitId !== progress.currentUnitId ? nextLesson.unitId : null;
        await this.progressRepo.advanceLesson(progress.id, nextLesson.id, nextUnitId);
        return { advanced: true, nextLessonId: nextLesson.id };
      }
      // No more lessons: mark subject completed
      await this.progressRepo.markCompleted(progress.id);
      return { advanced: true, completed: true };
    }

    const nextUnlockType = currentCard.cardType === 'practice' ? 'practice' : 'lesson';
    await this.progressRepo.updateCardSort(progress.id, cardSortOrder, nextUnlockType);
    return { advanced: false, nextUnlockType };
  }
}
