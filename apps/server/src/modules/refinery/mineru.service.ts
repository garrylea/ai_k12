import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export interface MinerUResult {
  markdown: string;
  images: string[];
}

@Injectable()
export class MinerUService {
  private readonly logger = new Logger(MinerUService.name);
  private readonly cli = 'mineru-open-api';

  async extract(inputPath: string): Promise<MinerUResult> {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineru-'));
    try {
      await this.run(inputPath, outputDir);
      return await this.parseOutput(outputDir);
    } finally {
      // Best-effort cleanup of temp dir
      await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private run(inputPath: string, outputDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.cli, ['extract', inputPath, '-o', outputDir]);
      let stderr = '';
      proc.stderr.on('data', (data) => { stderr += data.toString(); });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`mineru-open-api exited ${code}: ${stderr}`));
      });
      proc.on('error', (err) => reject(err));
      // 120s timeout
      setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`mineru-open-api timed out after 120s`));
      }, 120_000);
    });
  }

  private async parseOutput(outputDir: string): Promise<MinerUResult> {
    const entries = await fs.readdir(outputDir, { withFileTypes: true });
    const mdFile = entries.find((e) => e.isFile() && e.name.endsWith('.md'));
    if (!mdFile) return { markdown: '', images: [] };
    const markdown = await fs.readFile(path.join(outputDir, mdFile.name), 'utf-8');
    const images = entries
      .filter((e) => e.isFile() && /\.(png|jpg|jpeg|webp)$/i.test(e.name))
      .map((e) => path.join(outputDir, e.name));
    return { markdown, images };
  }
}
