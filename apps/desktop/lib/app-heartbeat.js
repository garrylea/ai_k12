'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 存活心跳文件（spec 2026-11-10 §4.1，2026-11-10 修订）。
 *
 * **它解决的是什么**：看护脚本原来只用 `pgrep -f "<包路径>/Contents/MacOS/<name>"` 判活。
 * 只要「正在运行的那一份」和「plist 里记的那一份」不是同一个路径（从 `dist` 启动、
 * 装到 `/Applications` 之后再从旧位置启动、开发态 `npm start`），`pgrep` 就永远找不到，
 * 看护每 5 秒拉起一次 → 用户看到的是「App 被反复拉起」。
 *
 * 写 `pid` 而不是写时间戳：判活时用 `kill -0 <pid>`，进程被杀（含 SIGKILL）后必然失效，
 * 不会像时间戳心跳那样在「拔网线 / 卡死」时给出假阳性。
 * **仍然保留 `pgrep -x` 作为兜底**：进程在 `markAlive` 之前就崩溃、或心跳文件被人删掉时，
 * 靠进程名还能判出来。
 *
 * 失败一律吞掉：写不了心跳最多是「看护可能多拉起一次」，绝不能让 App 起不来。
 */
const HEARTBEAT_FILE_NAME = 'app.pid';

function heartbeatPath(userDataDir) {
  return path.join(userDataDir, HEARTBEAT_FILE_NAME);
}

function markAlive(userDataDir) {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(heartbeatPath(userDataDir), String(process.pid));
  } catch {
    // 写入永不阻断启动。
  }
}

function clearAlive(userDataDir) {
  try {
    fs.rmSync(heartbeatPath(userDataDir), { force: true });
  } catch {
    // 同上。
  }
}

module.exports = { HEARTBEAT_FILE_NAME, markAlive, clearAlive };
