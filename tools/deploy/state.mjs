#!/usr/bin/env node
/**
 * state.mjs — 极简 JSON 键值状态存储，供 deploy.sh 断点续跑使用。
 *
 * 用法:
 *   node state.mjs get  <file> <key>              # 输出值（不存在则输出空行）
 *   node state.mjs set  <file> <key> <value...>   # 写入/覆盖（值支持含空格的任意字符串）
 *   node state.mjs has  <file> <key>              # 存在退出 0，不存在退出 1
 *   node state.mjs keys <file>                    # 列出所有 key
 */

import fs from 'node:fs';
import path from 'node:path';

const [cmd, file, key, ...rest] = process.argv.slice(2);

function load() {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function save(obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  // 状态文件可能含密码/密钥，限制权限
  fs.chmodSync(file, 0o600);
}

switch (cmd) {
  case 'get': {
    const obj = load();
    process.stdout.write((obj[key] ?? '') + '\n');
    break;
  }
  case 'set': {
    const obj = load();
    obj[key] = rest.join(' ');
    save(obj);
    break;
  }
  case 'has': {
    const obj = load();
    process.exit(Object.prototype.hasOwnProperty.call(obj, key) ? 0 : 1);
    break;
  }
  case 'keys': {
    process.stdout.write(Object.keys(load()).join('\n') + '\n');
    break;
  }
  default:
    console.error('用法: node state.mjs <get|set|has|keys> <file> <key> [value...]');
    process.exit(2);
}
