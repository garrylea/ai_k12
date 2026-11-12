'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 「首屏连不上、本次运行已放开锁定」的标记文件（2026-11-12）。
 *
 * **这是主进程与看护脚本之间的契约，不是 App 内部状态**：
 *  - 主进程：首屏从未加载成功时不进 kiosk、允许关闭（`main.js` 的 `releaseLockdownForOffline`）；
 *  - 看护脚本（`lib/watchdog.js`）：只要看到 `studentMode=true` 就会在 App 退出后 5 秒拉起。
 *    放行后如果还拉起，用户就是「关掉 → 5 秒后又被弹出来」，等于没放行 —— 标记就是给它看的。
 *
 * **为什么不直接改 `shell-state.json`**：那是「学生模式的意图」，离线时清掉的话，
 * 下次连得上也不会预先锁定。标记只表达「这次运行放行」，学生模式保留。
 *
 * 页面真正加载成功后由主进程删除，看护随之恢复。
 * 任何读写异常都**不抛** —— 标记坏掉最多是少一次放行，不能阻断启动。
 */
const OFFLINE_RELEASE_FILE_NAME = 'offline-release.json';

function releaseFilePath(userDataDir) {
  return path.join(userDataDir, OFFLINE_RELEASE_FILE_NAME);
}

/**
 * 落下放行标记。
 * @param {string} userDataDir `app.getPath('userData')`
 * @param {Date} [now] 便于测试注入
 * @returns {boolean} 是否写入成功
 */
function markOfflineRelease(userDataDir, now = new Date()) {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(
      releaseFilePath(userDataDir),
      JSON.stringify({ releasedAt: now.toISOString() }),
      'utf8',
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 清掉放行标记（页面加载成功 / 学生模式重新锁定后调用）。
 * 文件不存在是正常路径，静默返回 `false`。
 * @param {string} userDataDir
 * @returns {boolean} 是否真的删掉了
 */
function clearOfflineRelease(userDataDir) {
  try {
    fs.unlinkSync(releaseFilePath(userDataDir));
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  OFFLINE_RELEASE_FILE_NAME,
  markOfflineRelease,
  clearOfflineRelease,
};
