'use strict';

/**
 * 校验 Windows 安装包里的键盘钩子（2026-11-09）。
 *
 * 只在 Windows runner 上真正断言；其它平台直接跳过（本机 mac 不出 win 包）。
 *
 * 断言三件事：
 *   1. `.node` 真的被解包到了 `app.asar.unpacked/native/keyhook.node`（asar 内无法 dlopen）；
 *   2. PE 头是 x64（0x8664），与 NSIS target 一致；
 *   3. 能在当前 Node 里 `require` 并 `ping()` —— N-API 是 ABI 稳定的，这同时说明 Electron 里也能加载。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const UNPACKED = path.join(ROOT, 'dist', 'win-unpacked');
const MODULE = path.join(UNPACKED, 'resources', 'app.asar.unpacked', 'native', 'keyhook.node');

const log = (message) => console.log(`[verify-keyhook] ${message}`);

function fail(message) {
  console.error(`[verify-keyhook] 失败：${message}`);
  process.exit(1);
}

function readPeMachine(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const dos = Buffer.alloc(0x40);
    fs.readSync(fd, dos, 0, dos.length, 0);
    if (dos[0] !== 0x4d || dos[1] !== 0x5a) return null;
    const peOffset = dos.readUInt32LE(0x3c);
    const head = Buffer.alloc(6);
    fs.readSync(fd, head, 0, head.length, peOffset);
    if (head.readUInt32LE(0) !== 0x00004550) return null;
    return head.readUInt16LE(4);
  } finally {
    fs.closeSync(fd);
  }
}

if (process.platform !== 'win32') {
  log(`跳过：当前平台是 ${process.platform}，Windows 产物只能在 windows runner 上校验`);
  process.exit(0);
}

if (!fs.existsSync(UNPACKED)) {
  fail(`找不到 ${UNPACKED} —— 先出 win 包（electron-builder --win）`);
}
if (!fs.existsSync(MODULE)) {
  fail(`安装包里没有 ${MODULE} —— 检查 electron-builder.yml 的 files / asarUnpack`);
}

const machine = readPeMachine(MODULE);
if (machine !== 0x8664) {
  fail(`.node 不是 x64（machine=0x${(machine || 0).toString(16)}）`);
}

let mod;
try {
  mod = require(MODULE);
} catch (err) {
  fail(`require 失败：${err && err.message}`);
}
const ping = typeof mod.ping === 'function' ? mod.ping() : null;
if (!ping || ping.ok !== true) {
  fail(`ping() 返回异常：${JSON.stringify(ping)}`);
}

log(`通过：x64，${fs.statSync(MODULE).size} bytes，napi=${ping.napi}，active=${ping.active}`);
