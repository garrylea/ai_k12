'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 退出审计（spec 2026-11-10 §3.1）。
 *
 * 目的只有一个：**区分「正常退出」与「被强杀/崩溃」**。做法是启动写标记、正常退出删标记，
 * 下次启动如果标记还在 → 上次没走完退出流程。
 *
 * ⚠️ 不要在这里做「异常退出就结束学习会话/通知家长」：2026-09-23 裁决 10 明确不区分异常退出。
 * 这里只写日志，给下次复现 Siri 关掉 App 时留证据。
 */
const FLAG_NAME = 'running.flag';

function flagPath(userDataDir) {
  return path.join(userDataDir, FLAG_NAME);
}

function markRunning(userDataDir) {
  try {
    fs.writeFileSync(flagPath(userDataDir), String(process.pid));
  } catch {
    // 写不了就不写：审计信息缺失好过启动失败。
  }
}

function wasAbnormalExit(userDataDir) {
  try {
    return fs.existsSync(flagPath(userDataDir));
  } catch {
    return false;
  }
}

function markCleanExit(userDataDir) {
  try {
    fs.rmSync(flagPath(userDataDir), { force: true });
  } catch {
    // 同上，绝不抛。
  }
}

module.exports = { markRunning, wasAbnormalExit, markCleanExit, FLAG_NAME };
