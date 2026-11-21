import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MaterialDocService } from './material-doc.service.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mds-'));
  process.env.ASSETS_DIR = dir;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.ASSETS_DIR;
});

describe('MaterialDocService', () => {
  it('reads a relative doc under assetsDir', async () => {
    fs.mkdirSync(path.join(dir, 'materials/chinese/a'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'materials/chinese/a/content.md'), '## 醉翁亭记');
    const svc = new MaterialDocService();
    await expect(svc.getText('materials/chinese/a/content.md')).resolves.toBe('## 醉翁亭记');
  });

  it('rejects path traversal', async () => {
    const svc = new MaterialDocService();
    await expect(svc.getText('../../etc/passwd')).resolves.toBeNull();
  });

  it('does not fetch absolute urls', async () => {
    const svc = new MaterialDocService();
    await expect(svc.getText('https://example.com/a.md')).resolves.toBeNull();
  });
});
