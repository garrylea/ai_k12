import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { AuxErrorBooksRepository, QuestionsRepository, ExtractTasksRepository, ErrorRedoLogsRepository } from '../../database/repositories/index.js';
import { QuestionStructuringCapability } from '../../ai-core/capabilities/question-structuring.capability.js';
import { computeContentHash } from './content-hash.util.js';
import type { CreateAuxErrorDto } from './dto/create-aux-error.dto.js';

@Injectable()
export class ErrorBookService {
  constructor(
    private readonly auxRepo: AuxErrorBooksRepository,
    private readonly questionsRepo: QuestionsRepository,
    private readonly structuring: QuestionStructuringCapability,
    private readonly tasksRepo: ExtractTasksRepository,
    private readonly redoLogsRepo: ErrorRedoLogsRepository,
  ) {}

  async listAux(studentId: number, subjectId?: number, includeCleared = false) {
    return this.auxRepo.findByStudent(studentId, subjectId, includeCleared);
  }

  async createAux(studentId: number, dto: CreateAuxErrorDto) {
    if (!dto.rawContent && !dto.extractTaskId) {
      throw new BadRequestException({ code: 1001, message: '需要提供 rawContent 或 extractTaskId' });
    }

    let rawInput = dto.rawContent ?? '';
    if (dto.extractTaskId) {
      const task = await this.tasksRepo.findById(dto.extractTaskId);
      if (!task || task.student_id !== studentId) throw new NotFoundException('task not found');
      if (task.status !== 'completed') {
        throw new BadRequestException({ code: 1001, message: '提取任务尚未完成' });
      }
      let result: any = null;
      try {
        result = task.result ? JSON.parse(task.result) : null;
      } catch {
        result = null;
      }
      rawInput = result?.markdown ?? rawInput;
    }

    const structured = await this.structuring.structure({
      rawInput,
      inputType: dto.source === 'photo' ? 'image_markdown' : 'text',
      studentId: studentId.toString(),
      subjectHint: 'math', // TODO: derive from dto.subjectId via SubjectsRepository
    });

    let questionId: number | null = null;
    let questionCreated = false;
    if (structured.quality !== 'poor' && structured.content.trim().length > 0) {
      const contentHash = computeContentHash(structured.content);
      const result = await this.questionsRepo.findOrCreate({
        subject_id: dto.subjectId,
        type: structured.type,
        difficulty: structured.difficulty,
        content: structured.content,
        options: structured.options ? JSON.stringify(structured.options) : null,
        answer: structured.answer,
        explanation: structured.explanation,
        source: 'auxiliary',
        content_hash: contentHash,
      });
      questionId = result.id;
      questionCreated = result.created;
      // TODO: bind knowledge points when KnowledgePointsRepository exists
    }

    try {
      const errorId = await this.auxRepo.create({
        student_id: studentId,
        subject_id: dto.subjectId,
        question_id: questionId,
        level: 1,
        is_cleared: 0,
        source: dto.source,
        wrong_answer_text: questionId === null ? rawInput : null,
      });
      return { errorId, questionId, structured };
    } catch (err) {
      // Compensation: if we just created the question but the aux_error_books insert failed,
      // delete the orphan question (only if we created it, not if it was reused).
      if (questionCreated && questionId !== null) {
        await this.questionsRepo.deleteById(questionId).catch(() => {});
      }
      throw err;
    }
  }

  async redo(errorItemId: number, studentId: number, answerText: string) {
    const item = await this.auxRepo.findById(errorItemId);
    if (!item || item.student_id !== studentId) throw new NotFoundException('error item not found');
    // MVP: student self-confirms correct -> clear. P1: AI grading.
    await this.auxRepo.markCleared(errorItemId);
    await this.redoLogsRepo.create({
      error_book_type: 'aux',
      error_item_id: errorItemId,
      student_id: studentId,
      answer_text: answerText,
      attachments: null,
      is_correct: 1,
      error_level_before: item.level,
      error_level_after: item.level,
    });
    return { isCorrect: true, cleared: true };
  }

  async clear(errorItemId: number, studentId: number) {
    const item = await this.auxRepo.findById(errorItemId);
    if (!item || item.student_id !== studentId) throw new NotFoundException('error item not found');
    await this.auxRepo.markCleared(errorItemId);
  }
}
