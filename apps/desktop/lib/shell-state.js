'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 学生模式的持久化状态文件名。放在 `app.getPath('userData')` 下。
 *
 * ⚠️ 这是**壳自己的内部状态**，不是给用户编辑的配置（那是 `config.json`）。
 * 文件名特意与 `config.json` 分开，避免有人把内部状态当配置改。
 */
const STATE_FILE_NAME = 'shell-state.json';

/**
 * 读上一次的学生模式（spec §1.4 / §4.3）。
 *
 * **为什么要持久化**：kiosk 由页面里的渲染层经 IPC 驱动，而**离线时页面根本加载不出来**
 * → 渲染层不执行 → `studentMode` 恒为 false → 窗口不是 kiosk → 学生只要
 * 「关掉 Wi-Fi + 杀进程 + 重启」就能逃逸。启动时把上次的状态读回来即可封住这条路
 * （spec §1.4）。
 *
 * **任何异常/损坏一律 `false`** —— 坏数据不该把家长锁在 kiosk 里（spec §4.3）。
 * 「偏向不锁」在这里是安全的：真实的锁定状态另有 localStorage 与家长端两条来源，
 * 这里只是决定**窗口要不要一开机就全屏**。
 *
 * @param {string} userDataDir `app.getPath('userData')`
 * @returns {boolean}
 */
function readStudentMode(userDataDir) {
  try {
    const raw = fs.readFileSync(path.join(userDataDir, STATE_FILE_NAME), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    return parsed.studentMode === true;
  } catch {
    return false;
  }
}

/**
 * 写学生模式。**失败只 warn、绝不抛**（沿用「写入永不阻断主链路」的既有纪律，spec §4.3）。
 *
 * 用同步写：调用点在 IPC 事件里，频率极低（学生登录/登出各一次），不值得为它引异步竞态。
 *
 * @param {string} userDataDir `app.getPath('userData')`
 * @param {boolean} on
 */
function writeStudentMode(userDataDir, on) {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(
      path.join(userDataDir, STATE_FILE_NAME),
      JSON.stringify({ studentMode: Boolean(on) }),
      'utf8',
    );
  } catch (err) {
    console.warn(`[shell] 写 ${STATE_FILE_NAME} 失败（已忽略）：${err && err.message}`);
  }
}

module.exports = { readStudentMode, writeStudentMode, STATE_FILE_NAME };
