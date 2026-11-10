'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/**
 * 看护进程（spec 2026-11-10 §4，仅 macOS，仅打包后）。
 *
 * **为什么不是把 App 交给 launchd KeepAlive**（2026-11-10 用户裁决）：那样家长点了退出
 * 也会被立刻拉回来，只能去终端摘。所以改成「launchd 托管一个极小的 sh 看护脚本」：
 * 脚本只在 `shell-state.json` 的 `studentMode === true` 时工作，家长/管理员模式直接空转。
 *
 * **判据用进程存在性（pgrep），不用网络心跳**：心跳会被拔网线 / 服务器故障误判成
 * "App 死了"，进而反复拉起一个本来正常的程序。
 *
 * ⚠️ `execFileSync` 必须带 timeout：launchctl 卡住（XPC 无响应）会把主进程一起卡死、
 * 窗口永远不出来 —— 宁可这一次没保活。
 *
 * ⚠️ 名字与产品无关（`com.local.sysmon`）只是降低被注意的概率，**不是隐藏手段**：
 * `launchctl list`、活动监视器都能看到；学生 `launchctl bootout` 仍能摘掉。
 */
const WATCHDOG_LABEL = 'com.local.sysmon';
const WATCHDOG_SCRIPT_NAME = 'sysmon.sh';
const APP_SUPPORT_DIR = 'k12-desktop';

function buildWatchdogScript() {
  return `#!/bin/sh
# sysmon —— 本地看护（spec 2026-11-10 §4）。
# 只在 studentMode=true 时工作：发现 App 不在运行就拉起；家长/管理员模式什么都不做。
APP="$1"
[ -n "$APP" ] || exit 0
STATE="$HOME/Library/Application Support/k12-desktop/shell-state.json"
while :; do
  if [ -f "$STATE" ] && grep -q '"studentMode":true' "$STATE" 2>/dev/null; then
    if ! pgrep -f "$APP/Contents/MacOS/" >/dev/null 2>&1; then
      open -a "$APP" >/dev/null 2>&1
    fi
  fi
  sleep 5
done
`;
}

function escapeXml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildWatchdogPlist({ execPath, scriptPath }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${WATCHDOG_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${escapeXml(scriptPath)}</string>
    <string>${escapeXml(execPath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
</dict>
</plist>
`;
}

function defaultRun(file, args) {
  execFileSync(file, args, { stdio: 'ignore', timeout: 3000, killSignal: 'SIGKILL' });
}

/**
 * @param {object} deps
 * @param {string} deps.platform
 * @param {string} deps.execPath App 包路径（`.app`，不是可执行文件）
 * @param {string} deps.homeDir `app.getPath('home')`
 * @param {number} [deps.uid]
 * @param {(m: string) => void} [deps.log]
 * @param {(file: string, args: string[]) => void} [deps.run]
 */
function installWatchdog({ platform, execPath, homeDir, uid, log = () => {}, run = defaultRun }) {
  if (platform !== 'darwin') return { installed: false, reason: 'platform' };
  const resolvedUid =
    typeof uid === 'number' ? uid : typeof process.getuid === 'function' ? process.getuid() : null;
  if (resolvedUid === null) return { installed: false, reason: 'uid' };

  const scriptPath = path.join(homeDir, 'Library', 'Application Support', APP_SUPPORT_DIR, WATCHDOG_SCRIPT_NAME);
  const plistPath = path.join(homeDir, 'Library', 'LaunchAgents', `${WATCHDOG_LABEL}.plist`);
  const script = buildWatchdogScript();
  const plist = buildWatchdogPlist({ execPath, scriptPath });

  let changed = false;
  try {
    const oldScript = fs.readFileSync(scriptPath, 'utf8');
    if (oldScript !== script) changed = true;
  } catch {
    changed = true;
  }
  let plistChanged = false;
  try {
    const oldPlist = fs.readFileSync(plistPath, 'utf8');
    if (oldPlist !== plist) plistChanged = true;
  } catch {
    plistChanged = true;
  }

  try {
    if (changed) {
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
      fs.writeFileSync(scriptPath, script, { mode: 0o755 });
      fs.chmodSync(scriptPath, 0o755);
    }
    if (plistChanged) {
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      fs.writeFileSync(plistPath, plist);
    }
  } catch (err) {
    log(`[guard] watchdog-write-error err=${err && err.message}`);
    return { installed: false, reason: 'write-error' };
  }

  let loaded = false;
  try {
    run('launchctl', ['print', `gui/${resolvedUid}/${WATCHDOG_LABEL}`]);
    loaded = true;
  } catch {
    loaded = false;
  }

  // 脚本内容变了也必须重载：正在运行的 /bin/sh 已把旧脚本读进内存，只重写文件它不会重读，
  // 且 plist 是 execPath 的纯函数、升级时通常不变 —— 只看 plistChanged 会漏掉这种最常见的情况。
  const dirty = changed || plistChanged;
  if (dirty && loaded) {
    try {
      run('launchctl', ['bootout', `gui/${resolvedUid}/${WATCHDOG_LABEL}`]);
    } catch {
      // 没加载过就是正常路径。
    }
    loaded = false;
  }

  if (loaded) return { installed: false, reason: 'unchanged', scriptPath, plistPath };

  try {
    run('launchctl', ['bootstrap', `gui/${resolvedUid}`, plistPath]);
    log(`[guard] watchdog-installed plist=${plistPath}`);
    return { installed: true, scriptPath, plistPath, bootstrapped: true };
  } catch (err) {
    log(`[guard] watchdog-bootstrap-error err=${err && err.message}`);
    // 文件已落地：下次登录 RunAtLoad 仍会拉起；只是本次运行期没有保活。
    // 写明这次重写过文件（或首次写入），不能复述成 'unchanged'。
    return {
      installed: true,
      reason: dirty ? 'updated' : 'bootstrap-failed',
      scriptPath,
      plistPath,
      bootstrapped: false,
    };
  }
}

module.exports = { WATCHDOG_LABEL, WATCHDOG_SCRIPT_NAME, buildWatchdogScript, buildWatchdogPlist, installWatchdog };
