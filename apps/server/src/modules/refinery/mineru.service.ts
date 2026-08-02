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
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineru-'));
      try {
        await this.run(inputPath, outputDir);
        return await this.parseOutput(outputDir);
      } catch (err) {
        lastError = err as Error;
        this.logger.warn(`MinerU attempt ${attempt} failed: ${(err as Error).message}`);
      } finally {
        // Best-effort cleanup of temp dir
        await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
      }
    }
    throw lastError ?? new Error('MinerU extraction failed');
  }

  private run(inputPath: string, outputDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.cli, ['extract', inputPath, '-o', outputDir], {
        detached: true,
      });
      let stderr = '';
      proc.stderr.on('data', (data) => { stderr += data.toString(); });
      const timer = setTimeout(() => {
        // Kill the entire process group (negative pid) so MinerU's child processes also die
        try {
          process.kill(-proc.pid!, 'SIGTERM');
        } catch {
          proc.kill('SIGTERM');
        }
        reject(new Error(`mineru-open-api timed out after 120s`));
      }, 120_000);
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`mineru-open-api exited ${code}: ${stderr}`));
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
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
