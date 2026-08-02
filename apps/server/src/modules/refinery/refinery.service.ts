import { Injectable, NotFoundException } from '@nestjs/common';
import * as path from 'node:path';
import { ExtractTasksRepository } from '../../database/repositories/extract-tasks.repo.js';
import { UploadedFilesRepository } from '../../database/repositories/uploaded-files.repo.js';
import type { UploadedFileRow } from '../../database/repositories/types.js';
import { MinerUService } from './mineru.service.js';
import { QuestionStructuringCapability } from '../../ai-core/capabilities/question-structuring.capability.js';

@Injectable()
export class RefineryService {
  constructor(
    private readonly tasksRepo: ExtractTasksRepository,
    private readonly filesRepo: UploadedFilesRepository,
    private readonly mineru: MinerUService,
    private readonly structuring: QuestionStructuringCapability,
  ) {}

  async createTask(fileId: number, studentId: number, source: string): Promise<number> {
    const file = await this.filesRepo.findById(fileId);
    if (!file) throw new NotFoundException('file not found');
    if (file.uploader_id !== studentId) throw new NotFoundException('file not owned');

    const taskId = await this.tasksRepo.create({
      file_id: fileId,
      student_id: studentId,
      provider: 'mineru',
      status: 'pending',
    });

    // Async execution - do not block the HTTP response
    this.runExtraction(taskId, file).catch((err) => {
      // runExtraction already updates status to failed on error; this catches unexpected throws
      console.error(`[RefineryService] runExtraction failed for task ${taskId}:`, err);
    });
    return taskId;
  }

  private async runExtraction(taskId: number, file: UploadedFileRow): Promise<void> {
    await this.tasksRepo.updateStatus(taskId, 'processing');
    try {
      // file.url is '/uploads/<key>'; resolve to filesystem path for MinerU CLI
      const filePath = path.join(
        process.env.UPLOAD_DIR ?? './uploads',
        file.url.replace(/^\/uploads\//, ''),
      );
      const result = await this.mineru.extract(filePath);
      const structured = await this.structuring.structure({
        rawInput: result.markdown,
        inputType: 'image_markdown',
        studentId: file.uploader_id.toString(),
        subjectHint: 'math',
      });
      await this.tasksRepo.updateStatus(
        taskId,
        'completed',
        JSON.stringify({ markdown: result.markdown, structured }),
      );
    } catch (err: any) {
      await this.tasksRepo.updateStatus(taskId, 'failed', undefined, err.message);
    }
  }

  async getTask(taskId: number, studentId: number) {
    const task = await this.tasksRepo.findById(taskId);
    if (!task || task.student_id !== studentId) throw new NotFoundException('task not found');
    return {
      id: task.id,
      status: task.status,
      result: task.result ? JSON.parse(task.result) : null,
      errorMessage: task.error_message,
    };
  }
}
