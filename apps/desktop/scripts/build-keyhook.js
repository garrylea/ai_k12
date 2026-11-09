'use strict';

/**
 * 构建 Windows 键盘钩子原生模块（2026-11-09）。
 *
 * 产物：`apps/desktop/native/keyhook.node`（**不入库**，见 apps/desktop/.gitignore）。
 * 打包时由 electron-builder 的 `files` + `asarUnpack` 带进 win 包（asar 内无法 dlopen .node）。
 *
 * **只在 Windows 上编译**：源码 include 了 <windows.h>，mac/linux 上跑会直接编译失败。
 * 所以非 win32 一律跳过并 exit 0 —— 本机的 npm test / app-build.sh --check 必须不受影响。
 *
 * 为什么不在 npm install 里自动编：mac/linux 的 `npm ci` 会因此变慢/变脆，
 * 而 win 产物本来就只有 CI 的 windows runner 能出。CI 里有显式一步调本脚本。
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'native', 'keyhook');
const BUILT = path.join(SRC_DIR, 'build', 'Release', 'keyhook.node');
const OUT = path.join(ROOT, 'native', 'keyhook.node');

const log = (message) => console.log(`[build-keyhook] ${message}`);

/** 读 PE 头的 Machine 字段：0x8664 = x64，0xaa64 = arm64。 */
function readPeMachine(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const dos = Buffer.alloc(0x40);
    fs.readSync(fd, dos, 0, dos.length, 0);
    if (dos[0] !== 0x4d || dos[1] !== 0x5a) return null;
    const peOffset = dos.readUInt32LE(0x3c);
    const head = Buffer.alloc(6);
    fs.readSync(fd, head, 0, head.length, peOffset);
    if (head.readUInt32LE(0) !== 0x00004550) return null; // "PE\0\0"
    return head.readUInt16LE(4);
  } finally {
    fs.closeSync(fd);
  }
}

function main() {
  if (process.platform !== 'win32') {
    log(`跳过：当前平台是 ${process.platform}，键盘钩子只在 Windows 上编译（CI 的 windows runner）`);
    return;
  }
  if (process.arch !== 'x64') {
    throw new Error(`只支持 win x64（当前 ${process.arch}），与 electron-builder 的 win.target 保持一致`);
  }

  const nodeGyp = path.join(ROOT, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
  if (!fs.existsSync(nodeGyp)) {
    throw new Error(`找不到 node-gyp（${nodeGyp}）—— 先在 apps/desktop 跑 npm ci`);
  }

  // 先删旧产物：编译失败时绝不能留下上一版 .node 被打进包（那会静默发布错误行为）。
  fs.rmSync(OUT, { force: true });

  log('编译 native/keyhook …');
  execFileSync(process.execPath, [nodeGyp, 'rebuild'], { cwd: SRC_DIR, stdio: 'inherit' });

  if (!fs.existsSync(BUILT)) {
    throw new Error(`node-gyp 没有产出 ${BUILT}`);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.copyFileSync(BUILT, OUT);

  const machine = readPeMachine(OUT);
  const name = machine === 0x8664 ? 'x64' : machine === 0xaa64 ? 'arm64' : `unknown(0x${(machine || 0).toString(16)})`;
  if (machine !== 0x8664) {
    throw new Error(`产物架构不是 x64：${name}`);
  }
  log(`完成：${path.relative(ROOT, OUT)}（${name}，${fs.statSync(OUT).size} bytes）`);
}

try {
  main();
} catch (err) {
  console.error(`[build-keyhook] 失败：${err && err.message}`);
  process.exit(1);
}
