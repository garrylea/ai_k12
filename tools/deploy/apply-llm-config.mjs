#!/usr/bin/env node
/**
 * apply-llm-config.mjs
 *
 * 按行改写 apps/server/src/ai-core/model-routes.yaml 中各 provider 主模型的 modelId。
 * 采用按行替换而非 YAML 序列化，以保留文件中的注释与原有格式。
 *
 * provider -> modelKey 映射（主文本模型）：
 *   kimi    -> kimi
 *   qwen    -> qwen3.8-max      （qwen-vl-max / qwen3-vl-plus 等专用模型不在此列）
 *   gemini  -> gemini-3.1-pro
 *   deepseek-> deepseek-flash
 *
 * 用法：
 *   node apply-llm-config.mjs <model-routes.yaml> <provider>=<modelId> [<provider>=<modelId> ...]
 */

import fs from 'node:fs';

const MODEL_KEY = {
  kimi: 'kimi',
  qwen: 'qwen3.8-max',
  gemini: 'gemini-3.1-pro',
  deepseek: 'deepseek-flash',
};

const yamlPath = process.argv[2];
const args = process.argv.slice(3);

if (!yamlPath || args.length === 0) {
  console.error('用法: node apply-llm-config.mjs <model-routes.yaml> <provider>=<modelId> [...]');
  process.exit(2);
}

const updates = [];
for (const arg of args) {
  const eq = arg.indexOf('=');
  const provider = eq === -1 ? arg : arg.slice(0, eq);
  const modelId = eq === -1 ? '' : arg.slice(eq + 1);
  const key = MODEL_KEY[provider];
  if (!key) {
    console.error(`[apply-llm-config] 未知 provider: ${provider}（可选：${Object.keys(MODEL_KEY).join('/')}）`);
    process.exit(2);
  }
  if (!modelId) {
    console.error(`[apply-llm-config] ${provider} 缺少模型名（格式 provider=modelId）`);
    process.exit(2);
  }
  updates.push({ provider, key, modelId });
}

if (!fs.existsSync(yamlPath)) {
  console.error(`[apply-llm-config] 找不到文件: ${yamlPath}`);
  process.exit(1);
}

const lines = fs.readFileSync(yamlPath, 'utf8').split('\n');
let inModels = false;
let currentKey = null;
let currentKeyDone = false;
const changed = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  // 顶层 models: 块
  if (/^models:\s*$/.test(line)) {
    inModels = true;
    continue;
  }
  if (!inModels) continue;
  // 顶层其他键（routes:/default:）结束 models 块
  if (/^\S/.test(line)) {
    inModels = false;
    continue;
  }
  // 二级 model key：如 "  kimi:"
  const keyMatch = line.match(/^  (\S+):\s*$/);
  if (keyMatch) {
    currentKey = keyMatch[1];
    currentKeyDone = false;
    continue;
  }
  // 三级 modelId 行：如 "    modelId: kimi-latest"
  const idMatch = line.match(/^(\s{4})modelId:\s*(\S+)\s*$/);
  if (idMatch && currentKey && !currentKeyDone) {
    const target = updates.find((u) => u.key === currentKey);
    if (target) {
      lines[i] = `${idMatch[1]}modelId: ${target.modelId}`;
      changed.push(`${target.provider}(${currentKey}): ${idMatch[2]} -> ${target.modelId}`);
      currentKeyDone = true; // 每个 model 块只改一次
    }
  }
}

fs.writeFileSync(yamlPath, lines.join('\n'), 'utf8');

if (changed.length) {
  console.log(`[apply-llm-config] 已更新 ${yamlPath}:`);
  for (const c of changed) console.log(`  - ${c}`);
} else {
  console.log('[apply-llm-config] 无变化');
}
