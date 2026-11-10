import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { installLaunchAgent, buildPlist, LAUNCH_AGENT_LABEL } = require('./launch-agent.js');

let home;
let calls;
const run = (file, args) => calls.push([file, ...args]);

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'k12-launch-agent-'));
  calls = [];
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const EXEC = '/Applications/K12 智学.app/Contents/MacOS/K12 智学';

describe('launch-agent', () => {
  it('plist 含 KeepAlive / RunAtLoad / ThrottleInterval / 可执行文件路径', () => {
    const xml = buildPlist(EXEC);
    expect(xml).toContain(`<string>${LAUNCH_AGENT_LABEL}</string>`);
    expect(xml).toContain('<key>KeepAlive</key>');
    expect(xml).toContain('<key>RunAtLoad</key>');
    expect(xml).toContain('<integer>10</integer>');
    expect(xml).toContain(EXEC);
  });

  it('首次安装写入 ~/Library/LaunchAgents 并 bootstrap', () => {
    const res = installLaunchAgent({ platform: 'darwin', execPath: EXEC, homeDir: home, uid: 501, run });
    expect(res.installed).toBe(true);
    const file = path.join(home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
    expect(fs.existsSync(file)).toBe(true);
    expect(calls).toEqual([['launchctl', 'bootstrap', 'gui/501', file]]);
  });

  it('内容没变时幂等：不重写、不重复 bootstrap', () => {
    installLaunchAgent({ platform: 'darwin', execPath: EXEC, homeDir: home, uid: 501, run });
    calls = [];
    const res = installLaunchAgent({ platform: 'darwin', execPath: EXEC, homeDir: home, uid: 501, run });
    expect(res.reason).toBe('unchanged');
    expect(calls).toEqual([]);
  });

  it('可执行文件路径变了 → 重写并先 bootout 再 bootstrap', () => {
    installLaunchAgent({ platform: 'darwin', execPath: EXEC, homeDir: home, uid: 501, run });
    calls = [];
    const moved = '/Applications/K12 智学 2.app/Contents/MacOS/K12 智学';
    installLaunchAgent({ platform: 'darwin', execPath: moved, homeDir: home, uid: 501, run });
    expect(calls).toEqual([
      ['launchctl', 'bootout', `gui/501/${LAUNCH_AGENT_LABEL}`],
      ['launchctl', 'bootstrap', 'gui/501', path.join(home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`)],
    ]);
  });

  it('非 darwin 完全不碰磁盘', () => {
    const res = installLaunchAgent({ platform: 'win32', execPath: EXEC, homeDir: home, uid: 501, run });
    expect(res.reason).toBe('platform');
    expect(fs.existsSync(path.join(home, 'Library'))).toBe(false);
  });

  it('bootout/bootstrap 失败只记账，不抛', () => {
    const boom = () => { throw new Error('launchctl failed'); };
    expect(() =>
      installLaunchAgent({ platform: 'darwin', execPath: EXEC, homeDir: home, uid: 501, run: boom }),
    ).not.toThrow();
  });
});
