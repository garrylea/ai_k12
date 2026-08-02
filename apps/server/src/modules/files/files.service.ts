import { Injectable } from '@nestjs/common';
import { UploadedFilesRepository } from '../../database/repositories/uploaded-files.repo.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface UploadedFileResult {
  fileId: number;
  url: string;
}

@Injectable()
export class FilesService {
  private readonly storageDir = process.env.UPLOAD_DIR ?? './uploads';

  constructor(private readonly filesRepo: UploadedFilesRepository) {}

  async upload(file: Express.Multer.File, uploaderId: number, source: string): Promise<UploadedFileResult> {
    const key = `${source}/${randomUUID()}-${file.originalname}`;
    const dest = path.join(this.storageDir, key);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, file.buffer);

    const fileId = await this.filesRepo.create({
      uploader_id: uploaderId,
      uploader_type: 'student',
      url: `/uploads/${key}`,
      mime_type: file.mimetype,
      size_bytes: file.size,
      source,
    });

    return { fileId, url: `/uploads/${key}` };
  }
}
