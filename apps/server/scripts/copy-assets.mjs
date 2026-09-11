// 把 tsc 不会拷贝的资源（ai-core YAML 配置 + prompt 模板）复制到 dist，
// 使 `node dist/main.js` 与 `tsx src/...` 读到同一份配置。
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));   // apps/server/scripts
const root = resolve(here, '..');                       // apps/server
const srcAi = resolve(root, 'src/ai-core');
const distAi = resolve(root, 'dist/ai-core');

mkdirSync(distAi, { recursive: true });

for (const f of ['model-routes.yaml', 'retry.yaml', 'safety.yaml', 'fallback.yaml']) {
  cpSync(resolve(srcAi, f), resolve(distAi, f));
}
const promptsSrc = resolve(srcAi, 'prompts');
if (existsSync(promptsSrc)) {
  cpSync(promptsSrc, resolve(distAi, 'prompts'), { recursive: true });
}
console.log('[copy-assets] YAML + prompts 已复制到 dist/ai-core');
