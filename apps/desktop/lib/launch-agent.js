'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/**
 * 用户级 LaunchAgent 保活（spec 2026-11-10 §4，仅 macOS）。
 *
 * **为什么必须是 launchd**：自己写的看护进程一样会被杀，而且被杀后没人拉起它；
 * launchd 是系统守护，`KeepAlive` 能在进程被 SIGKILL 后约 1 秒重启它。
 *
 * ⚠️ 这是**用户级** agent：学生 `launchctl bootout` 或删 plist 仍然能摘掉。
 * 它挡的是「Siri / 活动监视器顺手关掉」，不是「绝对关不掉」（后者要 root 级，另立 spec）。
 *
 * ⚠️ 只在打包后调用（`app.isPackaged`）：开发态 `npm start` 装上去会把开发机锁住。
 */
const LAUNCH_AGENT_LABEL = 'com.k12zhixue.desktop';

function escapeXml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildPlist(execPath) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
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
  execFileSync(file, args, { stdio: 'ignore' });
}

/**
 * @param {object} deps
 * @param {string} deps.platform
 * @param {string} deps.execPath `process.execPath`（App 内可执行文件）
 * @param {string} deps.homeDir `app.getPath('home')`
 * @param {number} [deps.uid] 默认 `process.getuid()`
 * @param {(m: string) => void} [deps.log]
 * @param {(file: string, args: string[]) => void} [deps.run] 测试注入
 */
function installLaunchAgent({ platform, execPath, homeDir, uid, log = () => {}, run = defaultRun }) {
  if (platform !== 'darwin') return { installed: false, reason: 'platform' };
  const resolvedUid = typeof uid === 'number' ? uid : typeof process.getuid === 'function' ? process.getuid() : null;
  if (resolvedUid === null) return { installed: false, reason: 'uid' };

  const dir = path.join(homeDir, 'Library', 'LaunchAgents');
  const file = path.join(dir, `${LAUNCH_AGENT_LABEL}.plist`);
  const xml = buildPlist(execPath);

  let existing = null;
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch {
    // 不存在是正常路径（首次安装）。
  }
  if (existing === xml) return { installed: false, reason: 'unchanged' };

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, xml);
  } catch (err) {
    log(`[guard] launch-agent-write-error err=${err && err.message}`);
    return { installed: false, reason: 'write-error' };
  }

  // 换过路径/内容时旧 job 还指着旧二进制，必须先摘掉。
  if (existing !== null) {
    try {
      run('launchctl', ['bootout', `gui/${resolvedUid}/${LAUNCH_AGENT_LABEL}`]);
    } catch {
      // 没加载过就是正常路径。
    }
  }

  try {
    run('launchctl', ['bootstrap', `gui/${resolvedUid}`, file]);
    log(`[guard] launch-agent-installed file=${file}`);
    return { installed: true, file, bootstrapped: true };
  } catch (err) {
    log(`[guard] launch-agent-bootstrap-error err=${err && err.message}`);
    // 文件已落地：下次登录仍会按 RunAtLoad 拉起，只是本次运行期没有保活。
    return { installed: true, file, bootstrapped: false };
  }
}

module.exports = { LAUNCH_AGENT_LABEL, buildPlist, installLaunchAgent };
