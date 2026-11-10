import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  WATCHDOG_LABEL,
  WATCHDOG_SCRIPT_NAME,
  buildWatchdogScript,
  buildWatchdogPlist,
  installWatchdog,
} = require('./watchdog.js');

let home;
let calls;
let logLines;
const runOk = (file, args) => calls.push([file, ...args]);

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'k12-watchdog-'));
  calls = [];
  logLines = [];
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const EXEC = '/Applications/K12 智学.app';
const log = (line) => logLines.push(line);

function install(overrides = {}) {
  return installWatchdog({
    platform: 'darwin',
    execPath: EXEC,
    homeDir: home,
    uid: 501,
    log,
    run: runOk,
    ...overrides,
  });
}

describe('watchdog', () => {
  it('脚本只在 studentMode=true 时工作，靠进程存在性判断、5 秒一轮', () => {
    const script = buildWatchdogScript();
    expect(script).toContain('"studentMode":true');
    expect(script).toContain('pgrep -f "$APP/Contents/MacOS/"');
    expect(script).toContain('open -a "$APP"');
    expect(script).toContain('sleep 5');
    // 靠网络心跳判断会被拔网线误伤，脚本里不该出现 curl / 后端地址
    expect(script).not.toContain('curl');
  });

  it('plist 带 KeepAlive / RunAtLoad / ThrottleInterval / 脚本与 App 两个参数', () => {
    const xml = buildWatchdogPlist({
      execPath: EXEC,
      scriptPath: '/Users/x/Library/Application Support/k12-desktop/sysmon.sh',
    });
    expect(xml).toContain(`<string>${WATCHDOG_LABEL}</string>`);
    expect(xml).toContain('<key>KeepAlive</key>');
    expect(xml).toContain('<key>RunAtLoad</key>');
    expect(xml).toContain('<integer>10</integer>');
    expect(xml).toContain('<string>/bin/sh</string>');
    expect(xml).toContain('/Users/x/Library/Application Support/k12-desktop/sysmon.sh');
    expect(xml).toContain(EXEC);
  });

  it('首次安装写脚本(0755)+plist，并 bootstrap', () => {
    const res = install({ run: (file, args) => { calls.push([file, ...args]); throw new Error('not loaded'); } });
    const scriptPath = path.join(home, 'Library', 'Application Support', 'k12-desktop', WATCHDOG_SCRIPT_NAME);
    const plistPath = path.join(home, 'Library', 'LaunchAgents', `${WATCHDOG_LABEL}.plist`);
    expect(res.installed).toBe(true);
    expect(fs.existsSync(scriptPath)).toBe(true);
    expect(fs.statSync(scriptPath).mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(scriptPath, 'utf8')).toContain('pgrep');
    expect(fs.existsSync(plistPath)).toBe(true);
    expect(calls).toEqual([
      ['launchctl', 'print', `gui/501/${WATCHDOG_LABEL}`],
      ['launchctl', 'bootstrap', 'gui/501', plistPath],
    ]);
  });

  it('内容没变且已加载 → 幂等，不重写不 bootstrap', () => {
    install({ run: (file, args) => { calls.push([file, ...args]); throw new Error('not loaded'); } });
    calls = [];
    const before = fs.statSync(path.join(home, 'Library', 'LaunchAgents', `${WATCHDOG_LABEL}.plist`)).mtimeMs;
    const res = install(); // print 成功 = 已加载
    expect(res.reason).toBe('unchanged');
    expect(calls).toEqual([['launchctl', 'print', `gui/501/${WATCHDOG_LABEL}`]]);
    const after = fs.statSync(path.join(home, 'Library', 'LaunchAgents', `${WATCHDOG_LABEL}.plist`)).mtimeMs;
    expect(after).toBe(before);
  });

  it('只有脚本内容变了（plist 不变）→ 重写脚本并 bootout+bootstrap 让新内容生效', () => {
    const scriptPath = path.join(home, 'Library', 'Application Support', 'k12-desktop', WATCHDOG_SCRIPT_NAME);
    const plistPath = path.join(home, 'Library', 'LaunchAgents', `${WATCHDOG_LABEL}.plist`);
    // 第一次安装：print 报错 = 未加载 → bootstrap。
    install({ run: (file, args) => { calls.push([file, ...args]); throw new Error('not loaded'); } });
    // 模拟升级前的旧脚本仍在磁盘上：plist 是 execPath 的纯函数，内容没变。
    fs.writeFileSync(scriptPath, '#!/bin/sh\n# old\n');

    calls = [];
    const res = install(); // runOk：print 成功 = 已加载

    expect(res.installed).toBe(true);
    expect(res.bootstrapped).toBe(true);
    // 运行中的 /bin/sh 仍执行旧内容，必须 bootout 让 launchd 用新脚本重启。
    expect(calls).toEqual([
      ['launchctl', 'print', `gui/501/${WATCHDOG_LABEL}`],
      ['launchctl', 'bootout', `gui/501/${WATCHDOG_LABEL}`],
      ['launchctl', 'bootstrap', 'gui/501', plistPath],
    ]);
    expect(fs.readFileSync(scriptPath, 'utf8')).toBe(buildWatchdogScript());
  });

  it('App 路径变了 → 重写 plist，先 bootout 再 bootstrap', () => {
    install({ run: (file, args) => { calls.push([file, ...args]); throw new Error('not loaded'); } });
    calls = [];
    const res = install({ execPath: '/Applications/K12 智学 2.app' });
    const plistPath = path.join(home, 'Library', 'LaunchAgents', `${WATCHDOG_LABEL}.plist`);
    expect(res.installed).toBe(true);
    expect(fs.readFileSync(plistPath, 'utf8')).toContain('/Applications/K12 智学 2.app');
    expect(calls).toEqual([
      ['launchctl', 'print', `gui/501/${WATCHDOG_LABEL}`],
      ['launchctl', 'bootout', `gui/501/${WATCHDOG_LABEL}`],
      ['launchctl', 'bootstrap', 'gui/501', plistPath],
    ]);
  });

  it('非 darwin 完全不碰磁盘', () => {
    const res = install({ platform: 'win32' });
    expect(res.reason).toBe('platform');
    expect(fs.existsSync(path.join(home, 'Library'))).toBe(false);
  });

  it('launchctl 失败只记账，不抛（也带超时参数）', () => {
    const boom = (file, args) => {
      calls.push([file, ...args]);
      throw new Error('launchctl failed');
    };
    expect(() => install({ run: boom })).not.toThrow();
    expect(logLines.some((line) => line.includes('watchdog-bootstrap-error'))).toBe(true);
  });
});
